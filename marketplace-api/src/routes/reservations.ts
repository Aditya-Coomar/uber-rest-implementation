import { Router } from 'express';
import { ApiError, invalidRequest } from '../lib/errors';
import { annotate } from '../lib/http';
import { logger } from '../lib/log';
import { Coordinates, fingerprint, isValidId, parseCoordinates, requireObject } from '../lib/validate';
import { haversineMeters } from '../drivers';
import { Reservation, claimDriver, getReservation, listDemoDrivers, listDrivers, rankAvailable, recordNoDriver, releaseReservation, snapshotOf } from '../store';

const router = Router();

function rideIdParam(raw: string): string {
  if (!isValidId(raw, 80)) throw new ApiError(400, 'INVALID_REQUEST', 'rideId has an invalid format.', { field: 'rideId' });
  return raw;
}

const noDrivers = () => new ApiError(409, 'NO_DRIVERS_AVAILABLE', 'No drivers are available for this pickup.');

/** Reply with a stored decision, or reject a request that changed the pickup. */
function replyWithDecision(reservation: Reservation, pickupFingerprint: string, res: import('express').Response) {
  if (reservation.status === 'RELEASED') {
    throw new ApiError(409, 'RESERVATION_CLOSED', 'This ride reservation has already been released.');
  }
  if (reservation.pickupFingerprint !== pickupFingerprint) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This ride was already matched with a different pickup.');
  }
  if (reservation.status === 'NO_DRIVER') throw noDrivers();
  annotate(res, { driverId: reservation.driver!.driverId });
  res.locals.outcome = 'RESERVED';
  res.status(200).json({
    rideId: reservation.rideId,
    status: 'RESERVED',
    driver: reservation.driver,
    ...(reservation.pickupDistanceMeters !== undefined && { pickupDistanceMeters: reservation.pickupDistanceMeters }),
  });
}

router.put('/:rideId', async (req, res) => {
  const rideId = rideIdParam(req.params.rideId);
  annotate(res, { rideId });
  const body = requireObject(req.body, 'body');
  const pickup: Coordinates = parseCoordinates(body.pickup, 'pickup');
  if (body.pool !== undefined && body.pool !== 'demo' && body.pool !== 'simulation') {
    throw invalidRequest('pool must be demo or simulation.', { field: 'pool' });
  }
  const pickupFingerprint = fingerprint(pickup);

  const existing = await getReservation(rideId);
  if (existing) { replyWithDecision(existing, pickupFingerprint, res); return; }

  const now = new Date().toISOString();
  const base = { rideId, pickup, pickupFingerprint, createdAt: now, updatedAt: now };
  const fleet = body.pool === 'simulation'
    ? (await listDrivers()).filter((driver) => driver.simulated === true)
    : await listDemoDrivers();
  const candidates = rankAvailable(fleet, pickup);

  for (const driver of candidates) {
    const snapshot = snapshotOf(driver);
    const pickupDistanceMeters = Math.round(haversineMeters(pickup, driver.location));
    for (let tries = 0; tries < 3; tries += 1) {
      const outcome = await claimDriver(driver, { ...base, status: 'RESERVED', driver: snapshot, pickupDistanceMeters });
      if (outcome === 'CLAIMED') {
        annotate(res, { driverId: driver.driverId });
        res.locals.outcome = 'RESERVED';
        res.status(200).json({ rideId, status: 'RESERVED', driver: snapshot, pickupDistanceMeters });
        return;
      }
      if (outcome === 'RESERVATION_EXISTS') {
        // A concurrent request for the same ride won; return its decision.
        const winner = await getReservation(rideId);
        if (winner) { replyWithDecision(winner, pickupFingerprint, res); return; }
      }
      if (outcome === 'DRIVER_TAKEN') break;
      // CONFLICT: transient transaction conflict on this candidate; retry it.
      await new Promise((r) => setTimeout(r, 25 * (tries + 1)));
    }
  }

  if (await recordNoDriver({ ...base, status: 'NO_DRIVER', driver: null })) {
    logger.info('no driver available', { rideId, candidates: candidates.length });
    res.locals.outcome = 'NO_DRIVERS_AVAILABLE';
    throw noDrivers();
  }
  // Lost the race to another decision for this ride: return the stored winner.
  const winner = await getReservation(rideId);
  if (!winner) throw new Error('Reservation decision vanished after a conditional insert failed.');
  { replyWithDecision(winner, pickupFingerprint, res); return; }
});

router.delete('/:rideId', async (req, res) => {
  const rideId = rideIdParam(req.params.rideId);
  annotate(res, { rideId });
  await releaseReservation(rideId);
  res.locals.outcome = 'RELEASED';
  res.status(204).end();
});

export default router;
