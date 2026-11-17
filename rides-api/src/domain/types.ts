import type { Location } from '../lib/validate';
import { BASE_FARE_MINOR, PER_KM_MINOR, estimateDurationSeconds, etaSeconds } from './fare';

export type RideStatus = 'PENDING_MATCH' | 'ASSIGNED' | 'NO_DRIVER' | 'COMPLETED' | 'CANCELLED';
export type PaymentStatus = 'NOT_STARTED' | 'PENDING' | 'PAID' | 'DECLINED';

/**
 * Payment methods are synthetic. A card is represented only by a token the
 * browser derives from the card's brand and last four digits; card numbers
 * never reach the backend. `demo_*` methods give deterministic outcomes for tests.
 */
export type PaymentMethodId = string;
const DEMO_METHODS = ['demo_approve', 'demo_decline'];
const CARD_TOKEN = /^card_(visa|mastercard|amex|discover|diners|jcb|rupay|unionpay|card)_(\d{4})$/;

export function isPaymentMethodId(value: unknown): value is PaymentMethodId {
  return typeof value === 'string' && (DEMO_METHODS.includes(value) || CARD_TOKEN.test(value));
}

export function describePaymentMethod(id: PaymentMethodId): { brand: string; last4: string | null } {
  const m = CARD_TOKEN.exec(id);
  return m ? { brand: m[1], last4: m[2] } : { brand: 'demo', last4: null };
}

export interface DriverSnapshot {
  driverId: string;
  name: string;
  vehicle: string;
  plate?: string;
  rating?: number;
}

export interface Fare {
  distanceMeters: number;
  amountMinor: number;
  currency: string;
}

export interface PaymentAttemptRecord {
  attemptId: string;
  status: 'PAID' | 'DECLINED';
  declineCode: string | null;
  paymentMethodId: PaymentMethodId;
  settledAt: string;
}

export interface PaymentState {
  status: PaymentStatus;
  attemptId: string | null;
  declineCode: string | null;
  /** Method for the current (or next) attempt. Exposed only as brand + last4. */
  paymentMethodId: PaymentMethodId;
  paidAt?: string;
  history?: PaymentAttemptRecord[];
}

/** The stored ride aggregate (minus the table key). */
export interface RideRecord {
  rideId: string;
  riderId: string;
  pickup: Location;
  destination: Location;
  status: RideStatus;
  driver: DriverSnapshot | null;
  fare: Fare;
  payment: PaymentState;
  createdAt: string;
  updatedAt: string;
  assignedAt?: string;
  pickupDistanceMeters?: number;
  completedAt?: string;
  cancelledAt?: string;
}

const presentLocation = (l: Location): Location => ({ lat: l.lat, lng: l.lng, ...(l.label !== undefined && { label: l.label }) });

export function presentFare(fare: Fare) {
  return {
    distanceMeters: fare.distanceMeters,
    amountMinor: fare.amountMinor,
    currency: fare.currency,
    baseMinor: BASE_FARE_MINOR,
    distanceMinor: fare.amountMinor - BASE_FARE_MINOR,
    perKmMinor: PER_KM_MINOR,
  };
}

/** Public representation; never leaks keys, jobs or raw payment method IDs. Field order is fixed. */
export function presentRide(ride: RideRecord) {
  const tripSeconds =
    ride.completedAt && ride.assignedAt ? Math.max(0, Math.round((Date.parse(ride.completedAt) - Date.parse(ride.assignedAt)) / 1000)) : null;
  return {
    rideId: ride.rideId,
    riderId: ride.riderId,
    pickup: presentLocation(ride.pickup),
    destination: presentLocation(ride.destination),
    status: ride.status,
    driver: ride.driver && {
      driverId: ride.driver.driverId,
      name: ride.driver.name,
      vehicle: ride.driver.vehicle,
      ...(ride.driver.plate !== undefined && { plate: ride.driver.plate }),
      ...(ride.driver.rating !== undefined && { rating: ride.driver.rating }),
    },
    fare: presentFare(ride.fare),
    estimatedDurationSeconds: estimateDurationSeconds(ride.fare.distanceMeters),
    pickupDistanceMeters: ride.pickupDistanceMeters ?? null,
    pickupEtaSeconds: ride.pickupDistanceMeters !== undefined ? etaSeconds(ride.pickupDistanceMeters) : null,
    tripDurationSeconds: tripSeconds,
    payment: {
      status: ride.payment.status,
      attemptId: ride.payment.attemptId,
      declineCode: ride.payment.declineCode,
      method: describePaymentMethod(ride.payment.paymentMethodId),
      ...(ride.payment.paidAt && { paidAt: ride.payment.paidAt }),
      attempts: (ride.payment.history ?? []).map((a) => ({
        attemptId: a.attemptId,
        status: a.status,
        declineCode: a.declineCode,
        method: describePaymentMethod(a.paymentMethodId),
        settledAt: a.settledAt,
      })),
    },
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    ...(ride.assignedAt && { assignedAt: ride.assignedAt }),
    ...(ride.completedAt && { completedAt: ride.completedAt }),
    ...(ride.cancelledAt && { cancelledAt: ride.cancelledAt }),
  };
}

export type JobKind =
  | 'MATCH'
  | 'RELEASE_DRIVER'
  | 'CHARGE'
  | 'PUBLISH_RIDE_COMPLETED'
  | 'PUBLISH_RIDE_CANCELLED'
  | 'PUBLISH_PAYMENT_SETTLED';

export const JOB_KINDS: JobKind[] = ['MATCH', 'RELEASE_DRIVER', 'CHARGE', 'PUBLISH_RIDE_COMPLETED', 'PUBLISH_RIDE_CANCELLED', 'PUBLISH_PAYMENT_SETTLED'];

export interface MatchJobInput {
  rideId: string;
  pickup: { lat: number; lng: number };
}
export interface ReleaseJobInput {
  rideId: string;
}
export interface ChargeJobInput {
  attemptId: string;
  rideId: string;
  amountMinor: number;
  currency: string;
  paymentMethodId: PaymentMethodId;
}
export interface PublishCompletedInput {
  rideId: string;
  occurredAt: string;
  /** Frozen at completion so every retry writes identical bytes. Absent on legacy jobs. */
  fareAmountMinor?: number;
  currency?: string;
  distanceMeters?: number;
  durationSeconds?: number | null;
}
export interface PublishCancelledInput {
  rideId: string;
  occurredAt: string;
}
export interface PublishPaymentInput {
  attemptId: string;
  rideId: string;
  status: 'PAID' | 'DECLINED';
  amountMinor: number;
  currency: string;
  declineCode: string | null;
  occurredAt: string;
}

export type JobInput =
  | MatchJobInput
  | ReleaseJobInput
  | ChargeJobInput
  | PublishCompletedInput
  | PublishCancelledInput
  | PublishPaymentInput;

export interface JobRecord {
  pk: string;
  kind: JobKind;
  subjectId: string;
  input: JobInput;
  attempts: number;
  nextRunAt: string;
  createdAt: string;
  lastError?: string;
}
