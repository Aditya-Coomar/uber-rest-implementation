import { isValidId } from '../lib/validate';
import type { ChargeJobInput } from '../domain/types';
import { config } from '../config';
import { callJson, errorCodeOf, errorDetailsOf } from './internal-http';

export interface AttemptResult {
  attemptId: string;
  rideId: string;
  status: 'APPROVED' | 'DECLINED';
  amountMinor: number;
  currency: string;
  declineCode: string | null;
}

export type ChargeResult =
  | { kind: 'RESULT'; attempt: AttemptResult }
  | { kind: 'ALREADY_PAID'; approvedAttemptId: string }
  | { kind: 'REJECTED'; code: string }
  | { kind: 'UNAVAILABLE'; reason: string };

function parseAttempt(body: unknown): AttemptResult | null {
  const b = body as Record<string, unknown> | null;
  if (typeof b !== 'object' || b === null) return null;
  const { attemptId, rideId, status, amountMinor, currency, declineCode } = b;
  if (!isValidId(attemptId, 80) || !isValidId(rideId, 80)) return null;
  if (status !== 'APPROVED' && status !== 'DECLINED') return null;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  if (declineCode !== null && typeof declineCode !== 'string') return null;
  if (status === 'DECLINED' && !declineCode) return null;
  return { attemptId, rideId, status, amountMinor, currency, declineCode: declineCode ?? null };
}

/** PUT /internal/payment-attempts/{attemptId} with the stable attempt payload. */
export async function charge(input: ChargeJobInput, deadlineMs: number): Promise<ChargeResult> {
  const url = `${config.paymentsBaseUrl}/internal/payment-attempts/${encodeURIComponent(input.attemptId)}`;
  const res = await callJson('PUT', url, {
    body: {
      rideId: input.rideId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paymentMethodId: input.paymentMethodId,
    },
    deadlineMs,
  });
  if (!res.ok) return { kind: 'UNAVAILABLE', reason: res.reason };
  if (res.status === 200) {
    const attempt = parseAttempt(res.body);
    return attempt && attempt.attemptId === input.attemptId
      ? { kind: 'RESULT', attempt }
      : { kind: 'UNAVAILABLE', reason: 'invalid payment payload' };
  }
  const code = errorCodeOf(res.body);
  if (res.status === 409 && code === 'RIDE_ALREADY_PAID') {
    const approvedAttemptId = errorDetailsOf(res.body).approvedAttemptId;
    if (isValidId(approvedAttemptId, 80)) return { kind: 'ALREADY_PAID', approvedAttemptId };
    return { kind: 'UNAVAILABLE', reason: 'RIDE_ALREADY_PAID without approvedAttemptId' };
  }
  if ((res.status === 400 || res.status === 409) && code) return { kind: 'REJECTED', code };
  return { kind: 'UNAVAILABLE', reason: `HTTP ${res.status}${code ? ` ${code}` : ''}` };
}

/** GET /internal/payment-attempts/{attemptId}. */
export async function getAttempt(
  attemptId: string,
  deadlineMs: number,
): Promise<{ kind: 'FOUND'; attempt: AttemptResult } | { kind: 'NOT_FOUND' } | { kind: 'UNAVAILABLE'; reason: string }> {
  const url = `${config.paymentsBaseUrl}/internal/payment-attempts/${encodeURIComponent(attemptId)}`;
  const res = await callJson('GET', url, { deadlineMs });
  if (!res.ok) return { kind: 'UNAVAILABLE', reason: res.reason };
  if (res.status === 404) return { kind: 'NOT_FOUND' };
  const attempt = res.status === 200 ? parseAttempt(res.body) : null;
  if (attempt && attempt.attemptId === attemptId) return { kind: 'FOUND', attempt };
  return { kind: 'UNAVAILABLE', reason: `HTTP ${res.status}` };
}
