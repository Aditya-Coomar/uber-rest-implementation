import { randomBytes } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationCodes, isConditionalCheckFailed, isTransactionCanceled } from '../lib/dynamo';
import { db, keys, table } from '../store/db';
import type { TripEvent } from './events';

export const INITIAL_GENERATION = 'g0';

export async function getActiveGeneration(): Promise<string | null> {
  const out = await db.send(new GetCommand({ TableName: table(), Key: { pk: keys.analyticsActive() }, ConsistentRead: true }));
  return (out.Item?.generation as string | undefined) ?? null;
}

/** The active generation, creating the initial pointer on first use. */
export async function ensureActiveGeneration(): Promise<string> {
  const current = await getActiveGeneration();
  if (current) return current;
  try {
    await db.send(
      new PutCommand({
        TableName: table(),
        Item: { pk: keys.analyticsActive(), generation: INITIAL_GENERATION, activatedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return INITIAL_GENERATION;
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    const winner = await getActiveGeneration();
    if (!winner) throw new Error('Active analytics generation vanished.');
    return winner;
  }
}

export function newGenerationId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `g${stamp}${randomBytes(3).toString('hex')}`;
}

/** Counter increments contributed by one event. */
function increments(event: TripEvent): Record<string, number> {
  switch (event.eventType) {
    case 'RideCompleted':
      return {
        completedTrips: 1,
        ...(event.fareAmountMinor !== undefined && { grossBookingsMinor: event.fareAmountMinor, fareSamples: 1 }),
        ...(event.distanceMeters !== undefined && { totalDistanceMeters: event.distanceMeters }),
        ...(typeof event.durationSeconds === 'number' && { totalDurationSeconds: event.durationSeconds, durationSamples: 1 }),
      };
    case 'RideCancelled':
      return { cancelledTrips: 1 };
    case 'PaymentSettled':
      return event.status === 'PAID'
        ? { paymentsApproved: 1, collectedMinor: event.amountMinor }
        : { paymentsDeclined: 1, declinedMinor: event.amountMinor };
  }
}

/**
 * Apply an event exactly once per generation: insert its deduplication marker
 * and add its increments to the summary in one transaction.
 */
export async function applyEvent(generation: string, event: TripEvent): Promise<'APPLIED' | 'DUPLICATE'> {
  const markerKey = keys.analyticsEvent(generation, event.eventId);
  const now = new Date().toISOString();
  const inc = increments(event);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':now': now, ':gen': generation };
  const adds = Object.entries(inc).map(([field, amount], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = amount;
    return `#f${i} :v${i}`;
  });
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: { pk: markerKey, eventId: event.eventId, eventType: event.eventType, rideId: event.rideId, occurredAt: event.occurredAt, appliedAt: now },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: table(),
              Key: { pk: keys.analyticsSummary(generation) },
              UpdateExpression: `ADD ${adds.join(', ')} SET updatedAt = :now, generation = :gen`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
        ],
      }),
    );
    return 'APPLIED';
  } catch (err) {
    if (isTransactionCanceled(err) && cancellationCodes(err)[0] === 'ConditionalCheckFailed') return 'DUPLICATE';
    // Ambiguous outcome: if the marker exists, the transaction committed.
    const marker = await db
      .send(new GetCommand({ TableName: table(), Key: { pk: markerKey }, ConsistentRead: true }))
      .catch(() => null);
    if (marker?.Item) return 'DUPLICATE';
    throw err;
  }
}

/** Start a fresh generation's summary at zero. */
export async function initGeneration(generation: string): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { pk: keys.analyticsSummary(generation), generation, completedTrips: 0, updatedAt: null },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

/** Point the projection at `next`, only if it still points at `previous`. */
export async function swapActiveGeneration(previous: string | null, next: string): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: keys.analyticsActive() },
      UpdateExpression: 'SET generation = :next, activatedAt = :now, previousGeneration = :prev',
      ConditionExpression: previous ? 'generation = :prev' : 'attribute_not_exists(generation)',
      ExpressionAttributeValues: { ':next': next, ':now': new Date().toISOString(), ':prev': previous },
    }),
  );
}

export interface AnalyticsSummary {
  completedTrips: number;
  updatedAt: string | null;
  generation: string | null;
  cancelledTrips: number;
  completionRate: number | null;
  currency: string;
  grossBookingsMinor: number;
  collectedMinor: number;
  declinedMinor: number;
  averageFareMinor: number | null;
  averageDistanceMeters: number | null;
  averageDurationSeconds: number | null;
  totalDistanceMeters: number;
  paymentsApproved: number;
  paymentsDeclined: number;
  approvalRate: number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/** Every metric is derived from archived events, so a replay rebuilds all of them. */
export async function getSummary(): Promise<AnalyticsSummary> {
  const generation = await getActiveGeneration();
  const item = generation
    ? (
        await db.send(new GetCommand({ TableName: table(), Key: { pk: keys.analyticsSummary(generation) }, ConsistentRead: true }))
      ).Item ?? {}
    : {};
  const n = (field: string) => Number(item[field] ?? 0);
  const completed = n('completedTrips');
  const cancelled = n('cancelledTrips');
  const approved = n('paymentsApproved');
  const declined = n('paymentsDeclined');
  return {
    completedTrips: completed,
    updatedAt: (item.updatedAt as string | null | undefined) ?? null,
    generation,
    cancelledTrips: cancelled,
    completionRate: ratio(completed, completed + cancelled),
    currency: 'USD',
    grossBookingsMinor: n('grossBookingsMinor'),
    collectedMinor: n('collectedMinor'),
    declinedMinor: n('declinedMinor'),
    averageFareMinor: n('fareSamples') > 0 ? Math.round(n('grossBookingsMinor') / n('fareSamples')) : null,
    averageDistanceMeters: n('fareSamples') > 0 ? Math.round(n('totalDistanceMeters') / n('fareSamples')) : null,
    averageDurationSeconds: n('durationSamples') > 0 ? Math.round(n('totalDurationSeconds') / n('durationSamples')) : null,
    totalDistanceMeters: n('totalDistanceMeters'),
    paymentsApproved: approved,
    paymentsDeclined: declined,
    approvalRate: ratio(approved, approved + declined),
  };
}
