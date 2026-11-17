import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationCodes, createDocumentClient, isConditionalCheckFailed, isTransactionCanceled } from './lib/dynamo';
import { config } from './config';

export type AttemptStatus = 'APPROVED' | 'DECLINED';

export interface AttemptRecord {
  attemptId: string;
  rideId: string;
  amountMinor: number;
  currency: string;
  paymentMethodId: string;
  status: AttemptStatus;
  declineCode: string | null;
  fingerprint: string;
  createdAt: string;
}

export type CreateResult =
  | { kind: 'CREATED'; attempt: AttemptRecord }
  | { kind: 'EXISTS'; attempt: AttemptRecord }
  | { kind: 'RIDE_ALREADY_PAID'; approvedAttemptId: string };

const db = createDocumentClient();
const attemptKey = (attemptId: string) => `ATTEMPT#${attemptId}`;
const paidKey = (rideId: string) => `PAID#${rideId}`;

function toAttempt(item: Record<string, unknown>): AttemptRecord {
  const { pk: _pk, ...rest } = item;
  return rest as unknown as AttemptRecord;
}

export async function getAttempt(attemptId: string): Promise<AttemptRecord | null> {
  const out = await db.send(
    new GetCommand({ TableName: config.tableName, Key: { pk: attemptKey(attemptId) }, ConsistentRead: true }),
  );
  return out.Item ? toAttempt(out.Item) : null;
}

export async function getApprovedAttemptId(rideId: string): Promise<string | null> {
  const out = await db.send(
    new GetCommand({ TableName: config.tableName, Key: { pk: paidKey(rideId) }, ConsistentRead: true }),
  );
  return (out.Item?.approvedAttemptId as string | undefined) ?? null;
}

/**
 * Durably record an attempt. A decline is a single conditional insert. An
 * approval also claims the ride's PAID marker in the same transaction, so at
 * most one attempt per ride is ever approved.
 */
export async function createAttempt(attempt: AttemptRecord): Promise<CreateResult> {
  const attemptPut = {
    TableName: config.tableName,
    Item: { pk: attemptKey(attempt.attemptId), ...attempt },
    ConditionExpression: 'attribute_not_exists(pk)',
  };
  try {
    if (attempt.status === 'DECLINED') {
      await db.send(new PutCommand(attemptPut));
    } else {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: attemptPut },
            {
              Put: {
                TableName: config.tableName,
                Item: {
                  pk: paidKey(attempt.rideId),
                  rideId: attempt.rideId,
                  approvedAttemptId: attempt.attemptId,
                  createdAt: attempt.createdAt,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    }
    return { kind: 'CREATED', attempt };
  } catch (err) {
    if (isConditionalCheckFailed(err)) return resolveExisting(attempt);
    if (isTransactionCanceled(err)) {
      const [attemptCode, paidCode] = cancellationCodes(err);
      if (attemptCode === 'ConditionalCheckFailed' || paidCode === 'ConditionalCheckFailed') {
        return resolveExisting(attempt);
      }
    }
    // Ambiguous or transient: the write may or may not have landed. Look before giving up.
    const existing = await getAttempt(attempt.attemptId).catch(() => null);
    if (existing) return { kind: 'EXISTS', attempt: existing };
    throw err;
  }
}

async function resolveExisting(attempt: AttemptRecord): Promise<CreateResult> {
  const existing = await getAttempt(attempt.attemptId);
  if (existing) return { kind: 'EXISTS', attempt: existing };
  const approvedAttemptId = await getApprovedAttemptId(attempt.rideId);
  if (approvedAttemptId) return { kind: 'RIDE_ALREADY_PAID', approvedAttemptId };
  throw new Error('Conditional write failed but neither the attempt nor the paid marker exists.');
}

export async function probeTable(): Promise<void> {
  await db.send(new GetCommand({ TableName: config.tableName, Key: { pk: 'HEALTH#probe' } }));
}
