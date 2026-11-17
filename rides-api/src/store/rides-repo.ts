import { DeleteCommand, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationCodes, isConditionalCheckFailed, isTransactionCanceled } from '../lib/dynamo';
import type {
  ChargeJobInput, DriverSnapshot, JobInput, JobKind, JobRecord, PaymentAttemptRecord, PaymentMethodId, PaymentState,
  PublishCompletedInput, PublishPaymentInput, RideRecord,
} from '../domain/types';
import { JOBS_INDEX, JOB_SHARDS, db, jobShard, jobSortKey, keys, table } from './db';

export interface IdempotencyRecord {
  fingerprint: string;
  rideId: string;
  attemptId?: string;
  createdAt: string;
}

function strip<T>(item: Record<string, unknown>): T {
  const { pk: _pk, entity: _entity, ...rest } = item;
  return rest as T;
}

export async function getRide(rideId: string): Promise<RideRecord | null> {
  const out = await db.send(new GetCommand({ TableName: table(), Key: { pk: keys.ride(rideId) }, ConsistentRead: true }));
  return out.Item ? strip<RideRecord>(out.Item) : null;
}

export async function getIdempotencyRecord(pk: string): Promise<IdempotencyRecord | null> {
  const out = await db.send(new GetCommand({ TableName: table(), Key: { pk }, ConsistentRead: true }));
  return out.Item ? strip<IdempotencyRecord>(out.Item) : null;
}

function jobPut(kind: JobKind, subjectId: string, input: JobInput, now: string, delayMs = 0) {
  const job: JobRecord = {
    pk: keys.job(kind, subjectId),
    kind,
    subjectId,
    input,
    attempts: 0,
    nextRunAt: new Date(Date.parse(now) + delayMs).toISOString(),
    createdAt: now,
  };
  return {
    Put: {
      TableName: table(),
      Item: { ...job, entity: 'JOB', gsiJobPk: jobShard(job.pk), gsiJobSk: jobSortKey(job.nextRunAt, job.pk) },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

/**
 * Create the PENDING_MATCH ride, its idempotency record and a MATCH job in one
 * transaction. The job is delayed so the worker only picks it up if the
 * synchronous attempt in the request does not resolve the match.
 */
export async function createBookingIntent(
  ride: RideRecord,
  idemPk: string,
  idem: IdempotencyRecord,
  matchRetryDelayMs: number,
): Promise<'CREATED' | 'KEY_EXISTS'> {
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: { pk: idemPk, entity: 'IDEMPOTENCY', ...idem },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: table(),
              Item: { pk: keys.ride(ride.rideId), entity: 'RIDE', ...ride },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          jobPut('MATCH', ride.rideId, { rideId: ride.rideId, pickup: { lat: ride.pickup.lat, lng: ride.pickup.lng } }, ride.createdAt, matchRetryDelayMs),
        ],
      }),
    );
    return 'CREATED';
  } catch (err) {
    if (isTransactionCanceled(err) && cancellationCodes(err)[0] === 'ConditionalCheckFailed') return 'KEY_EXISTS';
    throw err;
  }
}

export type MatchOutcome =
  | { kind: 'ASSIGNED'; driver: DriverSnapshot; pickupDistanceMeters: number | null }
  | { kind: 'NO_DRIVER' };

/**
 * Settle a pending match and retire its job atomically. Returns false when the
 * ride was already settled (by the worker or a concurrent request).
 */
export async function settleMatch(rideId: string, outcome: MatchOutcome): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table(),
              Key: { pk: keys.ride(rideId) },
              UpdateExpression:
                outcome.kind === 'ASSIGNED'
                  ? 'SET #status = :status, driver = :driver, updatedAt = :now, assignedAt = :now, pickupDistanceMeters = :dist'
                  : 'SET #status = :status, driver = :driver, updatedAt = :now',
              ConditionExpression: '#status = :pending',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':status': outcome.kind,
                ':driver': outcome.kind === 'ASSIGNED' ? outcome.driver : null,
                ':pending': 'PENDING_MATCH',
                ':now': now,
                ...(outcome.kind === 'ASSIGNED' && { ':dist': outcome.pickupDistanceMeters }),
              },
            },
          },
          { Delete: { TableName: table(), Key: { pk: keys.job('MATCH', rideId) } } },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isTransactionCanceled(err) && cancellationCodes(err)[0] === 'ConditionalCheckFailed') {
      await deleteJob(keys.job('MATCH', rideId));
      return false;
    }
    throw err;
  }
}

/**
 * ASSIGNED -> COMPLETED together with the release, initial charge and event
 * publication jobs. Returns false if the ride was no longer ASSIGNED.
 */
export async function completeRide(ride: RideRecord, attemptId: string, now: string): Promise<RideRecord | null> {
  const payment: PaymentState = {
    status: 'PENDING',
    attemptId,
    declineCode: null,
    paymentMethodId: ride.payment.paymentMethodId,
  };
  const charge: ChargeJobInput = {
    attemptId,
    rideId: ride.rideId,
    amountMinor: ride.fare.amountMinor,
    currency: ride.fare.currency,
    paymentMethodId: ride.payment.paymentMethodId,
  };
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table(),
              Key: { pk: keys.ride(ride.rideId) },
              UpdateExpression: 'SET #status = :completed, completedAt = :now, updatedAt = :now, payment = :payment',
              ConditionExpression: '#status = :assigned',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':completed': 'COMPLETED', ':assigned': 'ASSIGNED', ':now': now, ':payment': payment },
            },
          },
          jobPut('RELEASE_DRIVER', ride.rideId, { rideId: ride.rideId }, now),
          jobPut('CHARGE', attemptId, charge, now),
          jobPut('PUBLISH_RIDE_COMPLETED', ride.rideId, completedEventInput(ride, now), now),
        ],
      }),
    );
    return { ...ride, status: 'COMPLETED', completedAt: now, updatedAt: now, payment };
  } catch (err) {
    if (isTransactionCanceled(err) && cancellationCodes(err)[0] === 'ConditionalCheckFailed') return null;
    throw err;
  }
}

function completedEventInput(ride: RideRecord, completedAt: string): PublishCompletedInput {
  return {
    rideId: ride.rideId,
    occurredAt: completedAt,
    fareAmountMinor: ride.fare.amountMinor,
    currency: ride.fare.currency,
    distanceMeters: ride.fare.distanceMeters,
    durationSeconds: ride.assignedAt ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(ride.assignedAt)) / 1000)) : null,
  };
}

/** ASSIGNED -> CANCELLED together with the driver release and event publication jobs. */
export async function cancelRide(ride: RideRecord, now: string): Promise<RideRecord | null> {
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table(),
              Key: { pk: keys.ride(ride.rideId) },
              UpdateExpression: 'SET #status = :cancelled, cancelledAt = :now, updatedAt = :now',
              ConditionExpression: '#status = :assigned',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':cancelled': 'CANCELLED', ':assigned': 'ASSIGNED', ':now': now },
            },
          },
          jobPut('RELEASE_DRIVER', ride.rideId, { rideId: ride.rideId }, now),
          jobPut('PUBLISH_RIDE_CANCELLED', ride.rideId, { rideId: ride.rideId, occurredAt: now }, now),
        ],
      }),
    );
    return { ...ride, status: 'CANCELLED', cancelledAt: now, updatedAt: now };
  } catch (err) {
    if (isTransactionCanceled(err) && cancellationCodes(err)[0] === 'ConditionalCheckFailed') return null;
    throw err;
  }
}

/**
 * Replace a DECLINED attempt with a new PENDING one: conditional ride update,
 * retry idempotency record and charge job in one transaction.
 */
export async function schedulePaymentRetry(
  ride: RideRecord,
  newAttemptId: string,
  paymentMethodId: PaymentMethodId,
  idemPk: string,
  idem: IdempotencyRecord,
  now: string,
): Promise<{ kind: 'SCHEDULED'; ride: RideRecord } | { kind: 'KEY_EXISTS' } | { kind: 'RIDE_CHANGED' }> {
  // Keep the payment history: only the current-attempt fields change.
  const payment: PaymentState = { ...ride.payment, status: 'PENDING', attemptId: newAttemptId, declineCode: null, paymentMethodId };
  const charge: ChargeJobInput = {
    attemptId: newAttemptId,
    rideId: ride.rideId,
    amountMinor: ride.fare.amountMinor,
    currency: ride.fare.currency,
    paymentMethodId,
  };
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: { pk: idemPk, entity: 'IDEMPOTENCY', ...idem },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: table(),
              Key: { pk: keys.ride(ride.rideId) },
              UpdateExpression:
                'SET payment.#pstatus = :pending, payment.attemptId = :attempt, payment.declineCode = :null, payment.paymentMethodId = :method, updatedAt = :now',
              ConditionExpression:
                '#status = :completed AND payment.#pstatus = :declined AND payment.attemptId = :previous',
              ExpressionAttributeNames: { '#status': 'status', '#pstatus': 'status' },
              ExpressionAttributeValues: {
                ':pending': 'PENDING',
                ':attempt': newAttemptId,
                ':null': null,
                ':method': paymentMethodId,
                ':now': now,
                ':completed': 'COMPLETED',
                ':declined': 'DECLINED',
                ':previous': ride.payment.attemptId,
              },
            },
          },
          jobPut('CHARGE', newAttemptId, charge, now),
        ],
      }),
    );
    return { kind: 'SCHEDULED', ride: { ...ride, payment, updatedAt: now } };
  } catch (err) {
    if (isTransactionCanceled(err)) {
      const [idemCode, rideCode] = cancellationCodes(err);
      if (idemCode === 'ConditionalCheckFailed') return { kind: 'KEY_EXISTS' };
      if (rideCode === 'ConditionalCheckFailed') return { kind: 'RIDE_CHANGED' };
    }
    throw err;
  }
}

/**
 * Record a durable payment outcome, append it to the ride's payment history,
 * retire the charge job and schedule the PaymentSettled event, all in one
 * transaction. Conditioned on the attempt still being the active PENDING one.
 */
export async function settleCharge(
  ride: RideRecord,
  expectedAttemptId: string,
  result: { status: 'PAID' | 'DECLINED'; declineCode: string | null; settledAttemptId: string },
): Promise<boolean> {
  const jobKey = keys.job('CHARGE', expectedAttemptId);
  const now = new Date().toISOString();
  const entry: PaymentAttemptRecord = {
    attemptId: result.settledAttemptId,
    status: result.status,
    declineCode: result.declineCode,
    paymentMethodId: ride.payment.paymentMethodId,
    settledAt: now,
  };
  const event: PublishPaymentInput = {
    attemptId: result.settledAttemptId,
    rideId: ride.rideId,
    status: result.status,
    amountMinor: ride.fare.amountMinor,
    currency: ride.fare.currency,
    declineCode: result.declineCode,
    occurredAt: now,
  };
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table(),
              Key: { pk: keys.ride(ride.rideId) },
              UpdateExpression:
                'SET payment.#pstatus = :status, payment.declineCode = :decline, payment.attemptId = :settled, updatedAt = :now, ' +
                'payment.history = list_append(if_not_exists(payment.history, :empty), :entry)' +
                (result.status === 'PAID' ? ', payment.paidAt = :now' : ''),
              ConditionExpression: 'payment.attemptId = :expected AND payment.#pstatus = :pending',
              ExpressionAttributeNames: { '#pstatus': 'status' },
              ExpressionAttributeValues: {
                ':status': result.status,
                ':decline': result.declineCode,
                ':settled': result.settledAttemptId,
                ':expected': expectedAttemptId,
                ':pending': 'PENDING',
                ':now': now,
                ':empty': [],
                ':entry': [entry],
              },
            },
          },
          { Delete: { TableName: table(), Key: { pk: jobKey } } },
          jobPut('PUBLISH_PAYMENT_SETTLED', result.settledAttemptId, event, now),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isTransactionCanceled(err) && cancellationCodes(err)[0] === 'ConditionalCheckFailed') {
      await deleteJob(jobKey);
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- jobs

export async function deleteJob(pk: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: table(), Key: { pk } }));
}

/** Reschedule a job; a no-op if the job has meanwhile been retired. */
export async function backoffJob(job: JobRecord, delayMs: number, lastError: string): Promise<void> {
  const next = new Date(Date.now() + delayMs).toISOString();
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { pk: job.pk },
        UpdateExpression:
          'SET attempts = if_not_exists(attempts, :zero) + :one, nextRunAt = :next, lastError = :err, gsiJobPk = :shard, gsiJobSk = :sk',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':next': next,
          ':err': lastError.slice(0, 500),
          ':shard': jobShard(job.pk),
          ':sk': jobSortKey(next, job.pk),
        },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

/**
 * One bounded page of due jobs. The caller keeps the cursor across ticks so
 * every page is eventually visited.
 */
export async function scanDueJobs(
  cursor: Record<string, unknown> | undefined,
  nowIso: string,
  pageSize: number,
): Promise<{ jobs: JobRecord[]; cursor: Record<string, unknown> | undefined }> {
  const page = await db.send(
    new ScanCommand({
      TableName: table(),
      ConsistentRead: true,
      Limit: pageSize,
      ExclusiveStartKey: cursor,
      // Legacy sweep: only jobs written before the index existed (indexed jobs are queried).
      FilterExpression: 'begins_with(pk, :job) AND nextRunAt <= :now AND attribute_not_exists(gsiJobPk)',
      ExpressionAttributeValues: { ':job': 'JOB#', ':now': nowIso },
    }),
  );
  const jobs = (page.Items ?? []).map(toJob);
  return { jobs, cursor: page.LastEvaluatedKey };
}

function toJob(item: Record<string, unknown>): JobRecord {
  const { entity: _e, gsiJobPk: _p, gsiJobSk: _s, ...job } = item;
  return job as unknown as JobRecord;
}

/** Due jobs from the sparse index, oldest first, across all shards. */
export async function queryDueJobs(nowIso: string, limitPerShard: number): Promise<JobRecord[]> {
  const shards = Array.from({ length: JOB_SHARDS }, (_, i) => `JOBS#${i}`);
  const pages = await Promise.all(
    shards.map((shard) =>
      db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: JOBS_INDEX,
          KeyConditionExpression: 'gsiJobPk = :shard AND gsiJobSk <= :now',
          ExpressionAttributeValues: { ':shard': shard, ':now': `${nowIso}~` },
          Limit: limitPerShard,
        }),
      ),
    ),
  );
  return pages.flatMap((p) => (p.Items ?? []).map(toJob)).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
}

/** Count pending jobs by kind (bounded), plus how many are due now. */
export async function jobBacklog(maxItems = 5_000): Promise<{ total: number; due: number; byKind: Record<string, number>; truncated: boolean }> {
  const byKind: Record<string, number> = {};
  let total = 0;
  let due = 0;
  let truncated = false;
  const now = new Date().toISOString();
  for (let i = 0; i < JOB_SHARDS; i += 1) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: JOBS_INDEX,
          KeyConditionExpression: 'gsiJobPk = :shard',
          ExpressionAttributeValues: { ':shard': `JOBS#${i}` },
          ProjectionExpression: 'kind, nextRunAt',
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        total += 1;
        byKind[item.kind as string] = (byKind[item.kind as string] ?? 0) + 1;
        if ((item.nextRunAt as string) <= now) due += 1;
      }
      startKey = page.LastEvaluatedKey;
      if (total >= maxItems) {
        truncated = Boolean(startKey);
        startKey = undefined;
      }
    } while (startKey);
  }
  return { total, due, byKind, truncated };
}

export async function probeTable(): Promise<void> {
  await db.send(new GetCommand({ TableName: table(), Key: { pk: 'HEALTH#probe' } }));
}
