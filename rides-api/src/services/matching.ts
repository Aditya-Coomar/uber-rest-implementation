import { errorFields, logger } from '../lib/log';
import type { RideRecord } from '../domain/types';
import { reserveDriver } from '../clients/marketplace';
import { getRide, settleMatch } from '../store/rides-repo';

/**
 * Ask Marketplace for a decision on a PENDING_MATCH ride and settle it. Used by
 * both the booking request (short deadline) and the worker's MATCH job, always
 * with the same ride ID and the validated pickup.
 *
 * Returns the ride after settlement, or null when the match is unresolved.
 */
export async function attemptMatch(
  ride: RideRecord,
  deadlineMs: number,
  requestId?: string,
): Promise<{ ride: RideRecord } | { unresolved: string }> {
  const pickup = { lat: ride.pickup.lat, lng: ride.pickup.lng };
  const result = await reserveDriver(ride.rideId, pickup, deadlineMs, requestId);
  if (result.kind === 'UNAVAILABLE') {
    logger.warn('match unresolved', { rideId: ride.rideId, requestId, reason: result.reason });
    return { unresolved: result.reason };
  }
  const transitioned = await settleMatch(
    ride.rideId,
    result.kind === 'RESERVED'
      ? { kind: 'ASSIGNED', driver: result.driver, pickupDistanceMeters: result.pickupDistanceMeters }
      : { kind: 'NO_DRIVER' },
  );
  logger.info('match settled', {
    rideId: ride.rideId,
    requestId,
    outcome: result.kind,
    driverId: result.kind === 'RESERVED' ? result.driver.driverId : undefined,
    transitioned,
  });
  try {
    const current = await getRide(ride.rideId);
    if (current) return { ride: current };
  } catch (err) {
    logger.warn('re-read after match failed', { rideId: ride.rideId, ...errorFields(err) });
  }
  // The settlement committed; reconstruct rather than fail the caller.
  return {
    ride: {
      ...ride,
      status: result.kind === 'RESERVED' ? 'ASSIGNED' : 'NO_DRIVER',
      driver: result.kind === 'RESERVED' ? result.driver : null,
    },
  };
}
