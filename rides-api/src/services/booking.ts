import { randomUUID } from 'node:crypto';
import { ApiError, isDependencyFailure, storageUnavailable } from '../lib/errors';
import { errorFields, logger } from '../lib/log';
import { Location, fingerprint, sha256 } from '../lib/validate';
import { quoteFare } from '../domain/fare';
import type { PaymentMethodId, RideRecord } from '../domain/types';
import { config } from '../config';
import { keys } from '../store/db';
import { IdempotencyRecord, createBookingIntent, getIdempotencyRecord, getRide } from '../store/rides-repo';
import { attemptMatch } from './matching';

export interface BookingRequest {
  idempotencyKey: string;
  riderId: string;
  pickup: Location;
  destination: Location;
  paymentMethodId: PaymentMethodId;
  requestId: string;
}

export interface BookingResult {
  ride: RideRecord;
  /** True when this request created the ride (vs. replaying an earlier one). */
  created: boolean;
}

/** The worker only picks up the MATCH job if the inline attempt leaves it pending. */
const MATCH_JOB_DELAY_MS = 4_000;

export async function bookRide(req: BookingRequest): Promise<BookingResult> {
  const scopeHash = sha256(`BOOK\n${req.riderId}\n${req.idempotencyKey}`);
  const idemPk = keys.bookingKey(scopeHash);
  const requestFingerprint = fingerprint({
    riderId: req.riderId,
    pickup: req.pickup,
    destination: req.destination,
    paymentMethodId: req.paymentMethodId,
  });

  const existing = await getIdempotencyRecord(idemPk);
  if (existing) return replay(existing, requestFingerprint, req.requestId);

  const now = new Date().toISOString();
  const ride: RideRecord = {
    rideId: `ride_${randomUUID()}`,
    riderId: req.riderId,
    pickup: req.pickup,
    destination: req.destination,
    status: 'PENDING_MATCH',
    driver: null,
    fare: quoteFare(req.pickup, req.destination),
    payment: { status: 'NOT_STARTED', attemptId: null, declineCode: null, paymentMethodId: req.paymentMethodId },
    createdAt: now,
    updatedAt: now,
  };
  const idem: IdempotencyRecord = { fingerprint: requestFingerprint, rideId: ride.rideId, createdAt: now };

  try {
    const outcome = await createBookingIntent(ride, idemPk, idem, MATCH_JOB_DELAY_MS);
    if (outcome === 'KEY_EXISTS') {
      // A concurrent request with the same key won the race.
      const winner = await getIdempotencyRecord(idemPk);
      if (!winner) throw storageUnavailable();
      return replay(winner, requestFingerprint, req.requestId);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Ambiguous: the intent may or may not have been written. Re-read the key.
    logger.warn('booking intent write ambiguous', { rideId: ride.rideId, requestId: req.requestId, ...errorFields(err) });
    let record: IdempotencyRecord | null;
    try {
      record = await getIdempotencyRecord(idemPk);
    } catch {
      throw storageUnavailable();
    }
    if (!record) throw storageUnavailable();
    if (record.rideId !== ride.rideId) return replay(record, requestFingerprint, req.requestId);
    // Our intent landed; continue with the match.
  }

  logger.info('booking intent created', { rideId: ride.rideId, requestId: req.requestId, amountMinor: ride.fare.amountMinor });
  return { ride: await matchInline(ride, req.requestId), created: true };
}

async function replay(record: IdempotencyRecord, requestFingerprint: string, requestId: string): Promise<BookingResult> {
  if (record.fingerprint !== requestFingerprint) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different booking request.');
  }
  const ride = await getRide(record.rideId);
  if (!ride) throw storageUnavailable({ rideId: record.rideId });
  if (ride.status !== 'PENDING_MATCH') return { ride, created: false };
  return { ride: await matchInline(ride, requestId), created: false };
}

/** Try Marketplace within the request deadline; leave the ride pending on failure. */
async function matchInline(ride: RideRecord, requestId: string): Promise<RideRecord> {
  try {
    const result = await attemptMatch(ride, config.inlineMatchDeadlineMs, requestId);
    return 'ride' in result ? result.ride : ride;
  } catch (err) {
    if (!isDependencyFailure(err)) throw err;
    logger.warn('match settlement failed; worker will retry', { rideId: ride.rideId, requestId, ...errorFields(err) });
    throw storageUnavailable({ rideId: ride.rideId }, { Location: `/rides/${ride.rideId}` });
  }
}
