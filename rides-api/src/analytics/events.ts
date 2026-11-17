import { isPlainObject, isValidId } from '../lib/validate';

/**
 * Archived domain events. One immutable S3 object per event; the object key is
 * derived from the event's subject so a publisher retry rewrites identical bytes.
 * No rider details, payment methods or coordinates are ever included.
 */
export const EVENT_PREFIXES = {
  RideCompleted: 'ride-completed/',
  RideCancelled: 'ride-cancelled/',
  PaymentSettled: 'payment-settled/',
} as const;
export const ALL_EVENT_PREFIXES = Object.values(EVENT_PREFIXES);
/** Kept for callers that only deal with completions. */
export const EVENT_PREFIX = EVENT_PREFIXES.RideCompleted;

export interface RideCompletedEvent {
  schemaVersion: 1 | 2;
  eventType: 'RideCompleted';
  eventId: string;
  rideId: string;
  occurredAt: string;
  /** v2 only */
  fareAmountMinor?: number;
  currency?: string;
  distanceMeters?: number;
  durationSeconds?: number | null;
}

export interface RideCancelledEvent {
  schemaVersion: 1;
  eventType: 'RideCancelled';
  eventId: string;
  rideId: string;
  occurredAt: string;
}

export interface PaymentSettledEvent {
  schemaVersion: 1;
  eventType: 'PaymentSettled';
  eventId: string;
  attemptId: string;
  rideId: string;
  status: 'PAID' | 'DECLINED';
  amountMinor: number;
  currency: string;
  declineCode: string | null;
  occurredAt: string;
}

export type TripEvent = RideCompletedEvent | RideCancelledEvent | PaymentSettledEvent;

/** Thrown for input that will never become valid; the message goes to the DLQ. */
export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

const KEY_PATTERN = /^(ride-completed|ride-cancelled|payment-settled)\/([A-Za-z0-9_.:-]{1,80})\.json$/;

export function subjectFromKey(key: string): { prefix: string; subjectId: string } | null {
  const m = KEY_PATTERN.exec(key);
  return m ? { prefix: `${m[1]}/`, subjectId: m[2] } : null;
}

/** Back-compat helper: ride ID of a ride-completed key. */
export function rideIdFromKey(key: string): string | null {
  const s = subjectFromKey(key);
  return s && s.prefix === EVENT_PREFIX ? s.subjectId : null;
}

export const eventKey = (rideId: string) => `${EVENT_PREFIX}${rideId}.json`;

export function keyForEvent(event: TripEvent): string {
  switch (event.eventType) {
    case 'RideCompleted':
      return `${EVENT_PREFIXES.RideCompleted}${event.rideId}.json`;
    case 'RideCancelled':
      return `${EVENT_PREFIXES.RideCancelled}${event.rideId}.json`;
    case 'PaymentSettled':
      return `${EVENT_PREFIXES.PaymentSettled}${event.attemptId}.json`;
  }
}

/** Deterministic payloads with a fixed field order. */
export function buildCompleted(input: {
  rideId: string;
  occurredAt: string;
  fareAmountMinor?: number;
  currency?: string;
  distanceMeters?: number;
  durationSeconds?: number | null;
}): RideCompletedEvent {
  const base = { eventType: 'RideCompleted' as const, eventId: `ride-completed:${input.rideId}`, rideId: input.rideId, occurredAt: input.occurredAt };
  if (input.fareAmountMinor === undefined) return { schemaVersion: 1, ...base };
  return {
    schemaVersion: 2,
    ...base,
    fareAmountMinor: input.fareAmountMinor,
    currency: input.currency ?? 'USD',
    distanceMeters: input.distanceMeters ?? 0,
    durationSeconds: input.durationSeconds ?? null,
  };
}

/** v1 helper kept for compatibility. */
export const buildEvent = (rideId: string, occurredAt: string) => buildCompleted({ rideId, occurredAt });

export function buildCancelled(rideId: string, occurredAt: string): RideCancelledEvent {
  return { schemaVersion: 1, eventType: 'RideCancelled', eventId: `ride-cancelled:${rideId}`, rideId, occurredAt };
}

export function buildPaymentSettled(input: Omit<PaymentSettledEvent, 'schemaVersion' | 'eventType' | 'eventId'>): PaymentSettledEvent {
  return {
    schemaVersion: 1,
    eventType: 'PaymentSettled',
    eventId: `payment-settled:${input.attemptId}`,
    attemptId: input.attemptId,
    rideId: input.rideId,
    status: input.status,
    amountMinor: input.amountMinor,
    currency: input.currency,
    declineCode: input.declineCode,
    occurredAt: input.occurredAt,
  };
}

export function serializeEvent(event: TripEvent): string {
  switch (event.eventType) {
    case 'RideCompleted':
      return JSON.stringify(buildCompleted(event));
    case 'RideCancelled':
      return JSON.stringify(buildCancelled(event.rideId, event.occurredAt));
    case 'PaymentSettled':
      return JSON.stringify(buildPaymentSettled(event));
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isTimestamp = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isCurrency = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v);

/** Validate an archived event body against the object key it was read from. */
export function parseEvent(text: string, key: string): TripEvent {
  const subject = subjectFromKey(key);
  if (!subject) throw new PermanentEventError(`unexpected object key ${key}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PermanentEventError(`object ${key} is not JSON`);
  }
  if (!isPlainObject(value)) throw new PermanentEventError(`object ${key} is not a JSON object`);
  const v = value;
  const fail = (what: string) => {
    throw new PermanentEventError(`${what} in ${key}`);
  };
  if (!isTimestamp(v.occurredAt)) fail('occurredAt is not a UTC ISO timestamp');
  if (!isValidId(v.rideId, 80)) fail('invalid rideId');

  if (subject.prefix === EVENT_PREFIXES.RideCompleted) {
    if (v.eventType !== 'RideCompleted') fail('unexpected eventType');
    if (v.rideId !== subject.subjectId || v.eventId !== `ride-completed:${v.rideId}`) fail('event identity does not match key');
    if (v.schemaVersion === 1) return buildCompleted({ rideId: v.rideId as string, occurredAt: v.occurredAt as string });
    if (v.schemaVersion !== 2) fail('unsupported schemaVersion');
    if (!isMoney(v.fareAmountMinor) || !isCurrency(v.currency) || !isMoney(v.distanceMeters)) fail('invalid fare fields');
    if (v.durationSeconds !== null && !isMoney(v.durationSeconds)) fail('invalid durationSeconds');
    return buildCompleted({
      rideId: v.rideId as string,
      occurredAt: v.occurredAt as string,
      fareAmountMinor: v.fareAmountMinor as number,
      currency: v.currency as string,
      distanceMeters: v.distanceMeters as number,
      durationSeconds: v.durationSeconds as number | null,
    });
  }
  if (subject.prefix === EVENT_PREFIXES.RideCancelled) {
    if (v.schemaVersion !== 1 || v.eventType !== 'RideCancelled') fail('unexpected eventType or schemaVersion');
    if (v.rideId !== subject.subjectId || v.eventId !== `ride-cancelled:${v.rideId}`) fail('event identity does not match key');
    return buildCancelled(v.rideId as string, v.occurredAt as string);
  }
  if (v.schemaVersion !== 1 || v.eventType !== 'PaymentSettled') fail('unexpected eventType or schemaVersion');
  if (!isValidId(v.attemptId, 80) || v.attemptId !== subject.subjectId || v.eventId !== `payment-settled:${v.attemptId}`) {
    fail('event identity does not match key');
  }
  if (v.status !== 'PAID' && v.status !== 'DECLINED') fail('invalid status');
  if (!isMoney(v.amountMinor) || !isCurrency(v.currency)) fail('invalid amount');
  if (v.declineCode !== null && typeof v.declineCode !== 'string') fail('invalid declineCode');
  return buildPaymentSettled({
    attemptId: v.attemptId as string,
    rideId: v.rideId as string,
    status: v.status as 'PAID' | 'DECLINED',
    amountMinor: v.amountMinor as number,
    currency: v.currency as string,
    declineCode: v.declineCode as string | null,
    occurredAt: v.occurredAt as string,
  });
}
