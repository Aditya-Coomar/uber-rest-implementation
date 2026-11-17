import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { awsClientConfig } from './aws-config';

/**
 * Document client with short timeouts so a stalled LocalStack surfaces as a
 * 503 instead of a hung request.
 */
export function createDocumentClient(): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    ...awsClientConfig(),
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000 },
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return errorName(err) === 'ConditionalCheckFailedException';
}

export function isTransactionCanceled(err: unknown): boolean {
  return errorName(err) === 'TransactionCanceledException';
}

/** Per-action cancellation codes ('None', 'ConditionalCheckFailed', 'TransactionConflict', ...). */
export function cancellationCodes(err: unknown): string[] {
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  if (Array.isArray(reasons)) return reasons.map((r) => r.Code ?? 'None');
  // Some emulators only describe the reasons in the message: "[None, ConditionalCheckFailed]".
  const match = /\[([^\]]*)\]/.exec(err instanceof Error ? err.message : '');
  return match ? match[1].split(',').map((s) => s.trim() || 'None') : [];
}
