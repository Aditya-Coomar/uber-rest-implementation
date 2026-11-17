import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { db, keys, table } from '../store/db';

/**
 * Pause protocol used by the analytics replay. The replay writes a pause
 * request; the worker stops starting new work, waits for in-flight work, and
 * acknowledges in its heartbeat. A stale heartbeat means no worker is running.
 */
export interface WorkerControl {
  paused: boolean;
  requestId: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
}

export interface WorkerHeartbeat {
  workerId: string;
  state: 'RUNNING' | 'PAUSED' | 'STOPPED';
  pausedRequestId: string | null;
  heartbeatAt: string;
}

export const HEARTBEAT_INTERVAL_MS = 2_000;
export const HEARTBEAT_STALE_MS = 10_000;

export async function readControl(): Promise<WorkerControl> {
  const out = await db.send(new GetCommand({ TableName: table(), Key: { pk: keys.workerControl() }, ConsistentRead: true }));
  return {
    paused: out.Item?.paused === true,
    requestId: (out.Item?.requestId as string | undefined) ?? null,
    requestedBy: (out.Item?.requestedBy as string | undefined) ?? null,
    requestedAt: (out.Item?.requestedAt as string | undefined) ?? null,
  };
}

export async function writeControl(control: WorkerControl): Promise<void> {
  await db.send(new PutCommand({ TableName: table(), Item: { pk: keys.workerControl(), ...control } }));
}

export async function readHeartbeat(): Promise<WorkerHeartbeat | null> {
  const out = await db.send(new GetCommand({ TableName: table(), Key: { pk: keys.workerHeartbeat() }, ConsistentRead: true }));
  if (!out.Item) return null;
  const { pk: _pk, ...rest } = out.Item;
  return rest as WorkerHeartbeat;
}

export async function writeHeartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
  await db.send(new PutCommand({ TableName: table(), Item: { pk: keys.workerHeartbeat(), ...heartbeat } }));
}
