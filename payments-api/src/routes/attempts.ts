import { Router } from 'express';
import { ApiError, invalidRequest } from '../lib/errors';
import { annotate } from '../lib/http';
import { fingerprint, isValidId, parseId, requireObject } from '../lib/validate';
import { AttemptRecord, createAttempt, getAttempt } from '../store';

const router = Router();

type Outcome = { status: 'APPROVED' | 'DECLINED'; declineCode: string | null };

/**
 * Synthetic payment methods. Card numbers never reach this service: the
 * browser sends only a token like `card_visa_4242`. Deterministic demo methods
 * remain for automated tests.
 */
const FIXED: Record<string, Outcome> = {
  demo_approve: { status: 'APPROVED', declineCode: null },
  demo_decline: { status: 'DECLINED', declineCode: 'DEMO_DECLINED' },
};
const CARD_TOKEN = /^card_(visa|mastercard|amex|discover|diners|jcb|rupay|unionpay|card)_\d{4}$/;
const DECLINE_CODES = ['INSUFFICIENT_FUNDS', 'DO_NOT_HONOR', 'CARD_DECLINED', 'LIMIT_EXCEEDED'];

function approvalRate(): number {
  const raw = Number(process.env.PAYMENT_APPROVAL_RATE ?? 0.75);
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.75;
}

export function isSupportedMethod(id: unknown): id is string {
  return typeof id === 'string' && (Object.hasOwn(FIXED, id) || CARD_TOKEN.test(id));
}

/** The issuer's decision. Random for card tokens; made once and stored with the attempt. */
function decide(paymentMethodId: string): Outcome {
  if (Object.hasOwn(FIXED, paymentMethodId)) return FIXED[paymentMethodId];
  if (Math.random() < approvalRate()) return { status: 'APPROVED', declineCode: null };
  return { status: 'DECLINED', declineCode: DECLINE_CODES[Math.floor(Math.random() * DECLINE_CODES.length)] };
}

function present(a: AttemptRecord) {
  return {
    attemptId: a.attemptId,
    rideId: a.rideId,
    status: a.status,
    amountMinor: a.amountMinor,
    currency: a.currency,
    declineCode: a.declineCode,
  };
}

function attemptIdParam(raw: string): string {
  if (!isValidId(raw, 80)) throw new ApiError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'No payment attempt has this ID.');
  return raw;
}

router.put('/:attemptId', async (req, res) => {
  const attemptId = attemptIdParam(req.params.attemptId);
  annotate(res, { attemptId });
  const body = requireObject(req.body, 'body');
  const rideId = parseId(body.rideId, 'rideId', 80);
  const { amountMinor, currency, paymentMethodId } = body;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw invalidRequest('amountMinor must be a positive integer amount in minor units.', { field: 'amountMinor' });
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw invalidRequest('currency must be a three-letter ISO 4217 code.', { field: 'currency' });
  }
  if (!isSupportedMethod(paymentMethodId)) {
    throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'paymentMethodId must be a card token (card_<brand>_<last4>) or a demo method.', {
      field: 'paymentMethodId',
    });
  }
  annotate(res, { rideId });

  const requestFingerprint = fingerprint({ attemptId, rideId, amountMinor, currency, paymentMethodId });
  const outcome = decide(paymentMethodId);
  const result = await createAttempt({
    attemptId,
    rideId,
    amountMinor,
    currency,
    paymentMethodId,
    status: outcome.status,
    declineCode: outcome.declineCode,
    fingerprint: requestFingerprint,
    createdAt: new Date().toISOString(),
  });

  if (result.kind === 'RIDE_ALREADY_PAID') {
    throw new ApiError(409, 'RIDE_ALREADY_PAID', 'Another payment attempt has already been approved for this ride.', {
      approvedAttemptId: result.approvedAttemptId,
    });
  }
  if (result.kind === 'EXISTS' && result.attempt.fingerprint !== requestFingerprint) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This attempt ID was already used with a different payload.');
  }
  res.locals.outcome = result.attempt.status;
  res.status(200).json(present(result.attempt));
});

router.get('/:attemptId', async (req, res) => {
  const attemptId = attemptIdParam(req.params.attemptId);
  annotate(res, { attemptId });
  const attempt = await getAttempt(attemptId);
  if (!attempt) throw new ApiError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'No payment attempt has this ID.');
  res.status(200).json(present(attempt));
});

export default router;
