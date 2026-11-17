import { randomUUID } from 'node:crypto';
import { ApiError, isDependencyFailure, storageUnavailable } from '../lib/errors';
import { fingerprint, sha256 } from '../lib/validate';
import type { PaymentMethodId, RideRecord } from '../domain/types';
import { keys } from '../store/db';
import { cancelRide, completeRide, getIdempotencyRecord, getRide, schedulePaymentRetry } from '../store/rides-repo';

export const newAttemptId = () => `pay_${randomUUID()}`;

export async function loadRide(rideId: string): Promise<RideRecord> {
  const ride = await getRide(rideId);
  if (!ride) throw new ApiError(404, 'RIDE_NOT_FOUND', 'No ride has this ID.');
  return ride;
}

const invalidState = (ride: RideRecord, action: string) =>
  new ApiError(409, 'INVALID_RIDE_STATE', `A ride in status ${ride.status} cannot be ${action}.`, { status: ride.status });

/** Re-read after an ambiguous write; return the ride if it reached `target`. */
async function rereadFor(rideId: string, target: RideRecord['status']): Promise<RideRecord | null> {
  try {
    const ride = await getRide(rideId);
    return ride?.status === target ? ride : null;
  } catch {
    return null;
  }
}

export async function complete(rideId: string): Promise<RideRecord> {
  const ride = await loadRide(rideId);
  if (ride.status === 'COMPLETED') return ride;
  if (ride.status !== 'ASSIGNED') throw invalidState(ride, 'completed');
  let updated: RideRecord | null;
  try {
    updated = await completeRide(ride, newAttemptId(), new Date().toISOString());
  } catch (err) {
    if (!isDependencyFailure(err)) throw err;
    const landed = await rereadFor(rideId, 'COMPLETED');
    if (landed) return landed;
    throw storageUnavailable({ rideId });
  }
  if (updated) return updated;
  const current = await loadRide(rideId);
  if (current.status === 'COMPLETED') return current;
  throw invalidState(current, 'completed');
}

export async function cancel(rideId: string): Promise<RideRecord> {
  const ride = await loadRide(rideId);
  if (ride.status === 'CANCELLED') return ride;
  if (ride.status !== 'ASSIGNED') throw invalidState(ride, 'cancelled');
  let updated: RideRecord | null;
  try {
    updated = await cancelRide(ride, new Date().toISOString());
  } catch (err) {
    if (!isDependencyFailure(err)) throw err;
    const landed = await rereadFor(rideId, 'CANCELLED');
    if (landed) return landed;
    throw storageUnavailable({ rideId });
  }
  if (updated) return updated;
  const current = await loadRide(rideId);
  if (current.status === 'CANCELLED') return current;
  throw invalidState(current, 'cancelled');
}

function assertRetryable(ride: RideRecord): void {
  if (ride.status !== 'COMPLETED') throw invalidState(ride, 'charged again');
  if (ride.payment.status === 'PENDING') {
    throw new ApiError(409, 'PAYMENT_PENDING', 'A payment attempt for this ride is still pending.', {
      attemptId: ride.payment.attemptId,
    });
  }
  if (ride.payment.status === 'PAID') {
    throw new ApiError(409, 'PAYMENT_ALREADY_PAID', 'This ride has already been paid.', { attemptId: ride.payment.attemptId });
  }
  if (ride.payment.status !== 'DECLINED') {
    throw new ApiError(409, 'INVALID_RIDE_STATE', 'This ride has no declined payment to retry.', {
      status: ride.status,
      paymentStatus: ride.payment.status,
    });
  }
}

export async function retryPayment(
  rideId: string,
  idempotencyKey: string,
  paymentMethodId: PaymentMethodId,
): Promise<{ ride: RideRecord; scheduled: boolean }> {
  const idemPk = keys.retryKey(sha256(`PAYMENT_RETRY\n${rideId}\n${idempotencyKey}`));
  const requestFingerprint = fingerprint({ rideId, paymentMethodId });

  const replay = async (fp: string) => {
    if (fp !== requestFingerprint) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different payment retry.');
    }
    return { ride: await loadRide(rideId), scheduled: false };
  };

  // Key first, so a replay still succeeds after the original retry changed the ride.
  const existing = await getIdempotencyRecord(idemPk);
  if (existing) return replay(existing.fingerprint);

  const ride = await loadRide(rideId);
  assertRetryable(ride);

  const now = new Date().toISOString();
  const attemptId = newAttemptId();
  try {
    const result = await schedulePaymentRetry(
      ride, attemptId, paymentMethodId, idemPk,
      { fingerprint: requestFingerprint, rideId, attemptId, createdAt: now },
      now,
    );
    if (result.kind === 'SCHEDULED') return { ride: result.ride, scheduled: true };
    if (result.kind === 'KEY_EXISTS') {
      const winner = await getIdempotencyRecord(idemPk);
      if (!winner) throw storageUnavailable({ rideId });
      return replay(winner.fingerprint);
    }
    // The ride changed between our read and the write; classify its new state.
    const current = await loadRide(rideId);
    assertRetryable(current);
    throw storageUnavailable({ rideId }); // still DECLINED: a concurrent transaction conflict; safe to retry
  } catch (err) {
    if (err instanceof ApiError || !isDependencyFailure(err)) throw err;
    let record;
    try {
      record = await getIdempotencyRecord(idemPk);
    } catch {
      throw storageUnavailable({ rideId });
    }
    if (record?.attemptId === attemptId) return { ride: await loadRide(rideId), scheduled: true };
    if (record) return replay(record.fingerprint);
    throw storageUnavailable({ rideId });
  }
}
