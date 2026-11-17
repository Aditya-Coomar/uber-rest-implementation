import { BatchGetCommand, BatchGetCommandOutput, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationCodes, createDocumentClient, isConditionalCheckFailed, isTransactionCanceled } from './lib/dynamo';
import { errorFields, logger } from './lib/log';
import type { Coordinates } from './lib/validate';
import { config } from './config';
import { DriverSnapshot, MAX_SIM_DRIVERS, SEED_DRIVERS, SIM_DRIVER_PREFIX, SeedDriver, haversineMeters, simulatedDriver } from './drivers';

export type ReservationStatus = 'RESERVED' | 'NO_DRIVER' | 'RELEASED';

export interface Reservation {
  rideId: string;
  status: ReservationStatus;
  pickup: Coordinates | null;
  pickupFingerprint: string | null;
  driver: DriverSnapshot | null;
  /** Driver's distance to the pickup when claimed. */
  pickupDistanceMeters?: number;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
}

export interface DriverItem extends DriverSnapshot {
  location: Coordinates;
  currentRideId?: string | null;
  simulated?: boolean;
}

export function snapshotOf(d: DriverItem): DriverSnapshot {
  return {
    driverId: d.driverId,
    name: d.name,
    vehicle: d.vehicle,
    ...(d.plate !== undefined && { plate: d.plate }),
    ...(d.rating !== undefined && { rating: d.rating }),
  };
}

const db = createDocumentClient();
const TABLE = config.tableName;
const driverKey = (id: string) => `DRIVER#${id}`;
const reservationKey = (rideId: string) => `RESERVATION#${rideId}`;

export async function getReservation(rideId: string): Promise<Reservation | null> {
  const out = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: reservationKey(rideId) }, ConsistentRead: true }));
  if (!out.Item) return null;
  const { pk: _pk, ...rest } = out.Item;
  return rest as Reservation;
}

/** Sparse index containing only driver items (keys only). */
export const DRIVERS_INDEX = 'drivers';
const DRIVER_GSI_PK = 'DRIVERS';

/**
 * All drivers, read consistently. Driver keys come from the sparse index so
 * reservations never have to be scanned; the items themselves are fetched with
 * a consistent batch read, so availability is never decided from a stale index.
 * Falls back to a filtered scan if the index does not exist yet.
 */
export async function listDrivers(): Promise<DriverItem[]> {
  let keys: Array<{ pk: string }> = [];
  try {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: DRIVERS_INDEX,
          KeyConditionExpression: 'gsiDriverPk = :p',
          ExpressionAttributeValues: { ':p': DRIVER_GSI_PK },
          ExclusiveStartKey: startKey,
        }),
      );
      keys = keys.concat((page.Items ?? []).map((i) => ({ pk: i.pk as string })));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
  } catch (err) {
    if ((err as Error).name !== 'ValidationException' && (err as Error).name !== 'ResourceNotFoundException') throw err;
    return scanDrivers();
  }
  const drivers: DriverItem[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let request: Record<string, { Keys: Array<{ pk: string }>; ConsistentRead: boolean }> | undefined = {
      [TABLE]: { Keys: keys.slice(i, i + 100), ConsistentRead: true },
    };
    for (let attempt = 0; request && attempt < 5; attempt += 1) {
      const out: BatchGetCommandOutput = await db.send(new BatchGetCommand({ RequestItems: request }));
      drivers.push(...((out.Responses?.[TABLE] ?? []) as DriverItem[]));
      const unprocessed: { Keys?: Array<Record<string, unknown>> } | undefined = out.UnprocessedKeys?.[TABLE];
      request = unprocessed?.Keys?.length ? { [TABLE]: { Keys: unprocessed.Keys as Array<{ pk: string }>, ConsistentRead: true } } : undefined;
    }
  }
  return drivers;
}

async function scanDrivers(): Promise<DriverItem[]> {
  const drivers: DriverItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: TABLE,
        ConsistentRead: true,
        FilterExpression: 'begins_with(pk, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'DRIVER#' },
        ExclusiveStartKey: startKey,
        Limit: 1000,
      }),
    );
    for (const item of page.Items ?? []) drivers.push(item as DriverItem);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return drivers;
}

export function rankAvailable(drivers: DriverItem[], pickup: Coordinates): DriverItem[] {
  return drivers
    .filter((d) => !d.currentRideId)
    .map((d) => ({ d, distance: haversineMeters(pickup, d.location) }))
    .sort((a, b) => a.distance - b.distance || a.d.driverId.localeCompare(b.d.driverId))
    .map(({ d }) => d);
}

export type ClaimResult = 'CLAIMED' | 'DRIVER_TAKEN' | 'RESERVATION_EXISTS' | 'CONFLICT';

/** Atomically point the driver at this ride and record the ride-keyed reservation. */
export async function claimDriver(driver: DriverItem, reservation: Reservation): Promise<ClaimResult> {
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { pk: driverKey(driver.driverId) },
              UpdateExpression: 'SET currentRideId = :ride, updatedAt = :now',
              ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(currentRideId) OR currentRideId = :null)',
              ExpressionAttributeValues: { ':ride': reservation.rideId, ':now': reservation.createdAt, ':null': null },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: { pk: reservationKey(reservation.rideId), ...reservation },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    );
    return 'CLAIMED';
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    const [driverCode, reservationCode] = cancellationCodes(err);
    if (reservationCode === 'ConditionalCheckFailed') return 'RESERVATION_EXISTS';
    if (driverCode === 'ConditionalCheckFailed') return 'DRIVER_TAKEN';
    return 'CONFLICT';
  }
}

/** Persist a confirmed no-driver decision. Returns false if a decision already exists. */
export async function recordNoDriver(reservation: Reservation): Promise<boolean> {
  try {
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: reservationKey(reservation.rideId), ...reservation },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * Release a ride's driver. Clears the driver only if it still points at this
 * ride and closes the reservation in the same transaction. An unknown ride gets
 * a RELEASED tombstone so a delayed match can never acquire a driver later.
 */
export async function releaseReservation(rideId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reservation = await getReservation(rideId);
    const now = new Date().toISOString();
    if (!reservation) {
      const tombstone: Reservation = {
        rideId, status: 'RELEASED', pickup: null, pickupFingerprint: null, driver: null,
        createdAt: now, updatedAt: now, releasedAt: now,
      };
      if (await recordNoDriver(tombstone)) return;
      continue;
    }
    if (reservation.status !== 'RESERVED' || !reservation.driver) return;

    const closeReservation = {
      TableName: TABLE,
      Key: { pk: reservationKey(rideId) },
      UpdateExpression: 'SET #status = :released, releasedAt = :now, updatedAt = :now',
      ConditionExpression: '#status = :reserved',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':released': 'RELEASED', ':reserved': 'RESERVED', ':now': now },
    };
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE,
                Key: { pk: driverKey(reservation.driver.driverId) },
                UpdateExpression: 'REMOVE currentRideId SET updatedAt = :now',
                ConditionExpression: 'currentRideId = :ride',
                ExpressionAttributeValues: { ':ride': rideId, ':now': now },
              },
            },
            { Update: closeReservation },
          ],
        }),
      );
      return;
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      const [driverCode, reservationCode] = cancellationCodes(err);
      if (reservationCode === 'ConditionalCheckFailed') return; // already released
      if (driverCode === 'ConditionalCheckFailed') {
        // The driver no longer points at this ride; only the reservation needs closing.
        logger.warn('driver did not point at released ride', { rideId, driverId: reservation.driver.driverId });
        try {
          await db.send(new UpdateCommand(closeReservation));
        } catch (inner) {
          if (!isConditionalCheckFailed(inner)) throw inner;
        }
        return;
      }
      // TransactionConflict: re-read and retry.
    }
  }
  throw new Error(`Could not release reservation for ${rideId} after repeated conflicts.`);
}

/**
 * Insert missing drivers and reconcile their profile fields (name, vehicle,
 * plate, rating). Location and current reservation are never overwritten.
 */
async function upsertDriver(driver: SeedDriver): Promise<'inserted' | 'existing'> {
  const out = await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: driverKey(driver.driverId) },
      UpdateExpression:
        'SET driverId = :id, #name = :name, vehicle = :vehicle, plate = :plate, rating = :rating, simulated = :sim, gsiDriverPk = :gsi, #loc = if_not_exists(#loc, :loc), createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeNames: { '#name': 'name', '#loc': 'location' },
      ExpressionAttributeValues: {
        ':id': driver.driverId,
        ':name': driver.name,
        ':vehicle': driver.vehicle,
        ':plate': driver.plate,
        ':rating': driver.rating,
        ':sim': driver.simulated === true,
        ':gsi': DRIVER_GSI_PK,
        ':loc': driver.location,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'UPDATED_OLD',
    }),
  );
  return out.Attributes?.createdAt ? 'existing' : 'inserted';
}

export async function seedDrivers(): Promise<{ inserted: string[]; existing: string[] }> {
  const inserted: string[] = [];
  const existing: string[] = [];
  for (const driver of SEED_DRIVERS) {
    try {
      (await upsertDriver(driver)) === 'inserted' ? inserted.push(driver.driverId) : existing.push(driver.driverId);
    } catch (err) {
      logger.error('seed failed', { driverId: driver.driverId, ...errorFields(err) });
      throw err;
    }
  }
  return { inserted, existing };
}

/** Ensure simulated drivers 1..count exist (load simulation). */
export async function ensureSimulatedFleet(count: number): Promise<{ inserted: number; total: number }> {
  const target = Math.min(Math.max(0, Math.floor(count)), MAX_SIM_DRIVERS);
  const existing = new Set((await listDrivers()).filter((d) => d.simulated).map((d) => d.driverId));
  const missing: SeedDriver[] = [];
  for (let n = 1; n <= target; n += 1) {
    const d = simulatedDriver(n);
    if (!existing.has(d.driverId)) missing.push(d);
  }
  for (let i = 0; i < missing.length; i += 10) {
    await Promise.all(missing.slice(i, i + 10).map((d) => upsertDriver(d)));
  }
  return { inserted: missing.length, total: existing.size + missing.length };
}

/** Remove idle simulated drivers. Busy ones stay until their ride releases them. */
export async function removeSimulatedFleet(): Promise<{ removed: number; busy: number }> {
  let removed = 0;
  let busy = 0;
  for (const d of (await listDrivers()).filter((x) => x.driverId.startsWith(SIM_DRIVER_PREFIX))) {
    try {
      await db.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { pk: driverKey(d.driverId) },
          ConditionExpression: 'attribute_not_exists(currentRideId) OR currentRideId = :null',
          ExpressionAttributeValues: { ':null': null },
        }),
      );
      removed += 1;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      busy += 1;
    }
  }
  return { removed, busy };
}

export async function fleetStats(): Promise<{ total: number; available: number; busy: number; simulated: number }> {
  const drivers = await listDrivers();
  const busy = drivers.filter((d) => d.currentRideId).length;
  return { total: drivers.length, available: drivers.length - busy, busy, simulated: drivers.filter((d) => d.simulated).length };
}

export async function probeTable(): Promise<void> {
  await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'HEALTH#probe' } }));
}
