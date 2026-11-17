import { Router } from 'express';
import { ApiError, invalidRequest } from '../lib/errors';
import { annotate } from '../lib/http';
import { isValidId, parseId, parseIdempotencyKey, parseLocation, requireObject } from '../lib/validate';
import { PaymentMethodId, isPaymentMethodId, presentRide } from '../domain/types';
import { bookRide } from '../services/booking';
import { cancel, complete, loadRide, retryPayment } from '../services/lifecycle';

const router = Router();

function parsePaymentMethod(value: unknown): PaymentMethodId {
  if (typeof value !== 'string') throw invalidRequest('paymentMethodId is required.', { field: 'paymentMethodId' });
  if (!isPaymentMethodId(value)) {
    throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'paymentMethodId must be a card token (card_<brand>_<last4>).', {
      field: 'paymentMethodId',
    });
  }
  return value;
}

function rideIdParam(raw: string): string {
  if (!isValidId(raw, 80)) throw new ApiError(404, 'RIDE_NOT_FOUND', 'No ride has this ID.');
  return raw;
}

const rideLocation = (rideId: string) => `/rides/${rideId}`;

router.post('/', async (req, res) => {
  const idempotencyKey = parseIdempotencyKey(req.get('idempotency-key'));
  const body = requireObject(req.body, 'body');
  const riderId = parseId(body.riderId, 'riderId');
  const pickup = parseLocation(body.pickup, 'pickup');
  const destination = parseLocation(body.destination, 'destination');
  const paymentMethodId = parsePaymentMethod(body.paymentMethodId);

  const { ride, created } = await bookRide({
    idempotencyKey, riderId, pickup, destination, paymentMethodId, requestId: res.locals.requestId as string,
  });
  annotate(res, { rideId: ride.rideId, replay: !created });

  if (ride.status === 'PENDING_MATCH') {
    throw new ApiError(
      503,
      'MARKETPLACE_UNAVAILABLE',
      'Driver matching is temporarily unavailable. The booking may still complete; check the ride or retry with the same Idempotency-Key.',
      { rideId: ride.rideId },
      { Location: rideLocation(ride.rideId), 'Retry-After': '3' },
    );
  }
  if (ride.status === 'NO_DRIVER') {
    throw new ApiError(409, 'NO_DRIVERS_AVAILABLE', 'No drivers are available for this pickup right now.', { rideId: ride.rideId });
  }
  if (created && ride.status === 'ASSIGNED') {
    res.status(201).location(rideLocation(ride.rideId)).json(presentRide(ride));
    return;
  }
  res.status(200).json(presentRide(ride));
});

router.get('/:rideId', async (req, res) => {
  const rideId = rideIdParam(req.params.rideId);
  annotate(res, { rideId });
  res.status(200).json(presentRide(await loadRide(rideId)));
});

router.post('/:rideId/complete', async (req, res) => {
  const rideId = rideIdParam(req.params.rideId);
  annotate(res, { rideId });
  const ride = await complete(rideId);
  annotate(res, { attemptId: ride.payment.attemptId });
  res.status(200).json(presentRide(ride));
});

router.post('/:rideId/cancel', async (req, res) => {
  const rideId = rideIdParam(req.params.rideId);
  annotate(res, { rideId });
  res.status(200).json(presentRide(await cancel(rideId)));
});

router.post('/:rideId/payment/retry', async (req, res) => {
  const rideId = rideIdParam(req.params.rideId);
  annotate(res, { rideId });
  const idempotencyKey = parseIdempotencyKey(req.get('idempotency-key'));
  const body = requireObject(req.body, 'body');
  const paymentMethodId = parsePaymentMethod(body.paymentMethodId);
  const { ride, scheduled } = await retryPayment(rideId, idempotencyKey, paymentMethodId);
  annotate(res, { attemptId: ride.payment.attemptId, replay: !scheduled });
  res.status(scheduled ? 202 : 200).json(presentRide(ride));
});

export { parsePaymentMethod };
export default router;
