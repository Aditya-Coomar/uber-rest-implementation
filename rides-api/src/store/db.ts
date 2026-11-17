import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from '../lib/dynamo';
import { config } from '../config';

let client: DynamoDBDocumentClient | null = null;

/** Created on first use, so importing this module never requires an endpoint. */
function getClient(): DynamoDBDocumentClient {
  return (client ??= createDocumentClient());
}

export const db = {
  send: ((...args: unknown[]) =>
    (getClient().send as (...a: unknown[]) => unknown).apply(getClient(), args)) as DynamoDBDocumentClient['send'],
};
export const table = () => config.tableName;

/**
 * Sparse index over pending jobs: partition = shard, sort = "<nextRunAt>#<pk>".
 * The worker queries due jobs instead of scanning the whole table.
 */
export const JOBS_INDEX = 'jobs-due';
export const JOB_SHARDS = 4;

export function jobShard(pk: string): string {
  let h = 0;
  for (let i = 0; i < pk.length; i += 1) h = (h * 31 + pk.charCodeAt(i)) >>> 0;
  return `JOBS#${h % JOB_SHARDS}`;
}

export const jobSortKey = (nextRunAt: string, pk: string) => `${nextRunAt}#${pk}`;

export const keys = {
  ride: (rideId: string) => `RIDE#${rideId}`,
  bookingKey: (scopeHash: string) => `IDEM#BOOK#${scopeHash}`,
  retryKey: (scopeHash: string) => `IDEM#PAYMENT_RETRY#${scopeHash}`,
  job: (kind: string, subjectId: string) => `JOB#${kind}#${subjectId}`,
  analyticsActive: () => 'ANALYTICS#ACTIVE',
  analyticsSummary: (generation: string) => `ANALYTICS#${generation}#SUMMARY`,
  analyticsEvent: (generation: string, eventId: string) => `ANALYTICS#${generation}#EVENT#${eventId}`,
  workerControl: () => 'WORKER#CONTROL',
  workerHeartbeat: () => 'WORKER#HEARTBEAT',
};
