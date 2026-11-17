import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { Router } from 'express';
import { ApiError, invalidRequest } from '../lib/errors';
import { errorFields, logger } from '../lib/log';
import { parseCoordinates, parseLocation, requireObject } from '../lib/validate';
import { estimateDurationSeconds, etaSeconds, quoteFare } from '../domain/fare';
import { presentFare } from '../domain/types';
import { config, resourceNames } from '../config';
import { nearbyDrivers } from '../clients/marketplace';
import { createSqsClient } from '../aws/clients';
import { jobBacklog } from '../store/rides-repo';
import { readHeartbeat } from '../worker/control';

const router = Router();

/** Upfront fare quote. Stateless: uses the same formula that is frozen at booking. */
router.post('/fare-quotes', (req, res) => {
  const body = requireObject(req.body, 'body');
  const pickup = parseLocation(body.pickup, 'pickup');
  const destination = parseLocation(body.destination, 'destination');
  const fare = quoteFare(pickup, destination);
  res.status(200).json({ fare: presentFare(fare), estimatedDurationSeconds: estimateDurationSeconds(fare.distanceMeters) });
});

/** Available cars near a point for the map, with the nearest pickup ETA. Positions only. */
router.get('/drivers/nearby', async (req, res) => {
  const point = parseCoordinates({ lat: Number(req.query.lat), lng: Number(req.query.lng) }, 'point');
  const result = await nearbyDrivers(point, 1_500);
  if (!result.ok) {
    throw new ApiError(503, 'MARKETPLACE_UNAVAILABLE', 'Nearby drivers are temporarily unavailable.');
  }
  const nearest = result.drivers[0];
  res.status(200).json({
    drivers: result.drivers.map((d) => ({ lat: d.lat, lng: d.lng, distanceMeters: d.distanceMeters, etaSeconds: etaSeconds(d.distanceMeters) })),
    nearestEtaSeconds: nearest ? etaSeconds(nearest.distanceMeters) : null,
  });
});

let sqs: ReturnType<typeof createSqsClient> | null = null;
const queueUrls: Record<string, string> = {};

async function queueDepth(name: string): Promise<{ visible: number; inFlight: number } | null> {
  try {
    sqs ??= createSqsClient();
    queueUrls[name] ??= (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    const out = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrls[name],
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      { abortSignal: AbortSignal.timeout(1_500) },
    );
    return {
      visible: Number(out.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  } catch (err) {
    logger.debug('queue depth unavailable', { queue: name, ...errorFields(err) });
    return null;
  }
}

/**
 * Operational view of the asynchronous pipeline: pending durable jobs by kind,
 * event-queue and DLQ depth, and worker state. Read-only.
 */
router.get('/ops/pipeline', async (_req, res) => {
  const names = resourceNames();
  const [jobs, queue, dlq, heartbeat] = await Promise.all([
    jobBacklog(),
    queueDepth(names.queue),
    queueDepth(names.deadLetterQueue),
    readHeartbeat().catch(() => null),
  ]);
  const heartbeatAge = heartbeat ? Date.now() - Date.parse(heartbeat.heartbeatAt) : null;
  res.status(200).json({
    jobs,
    eventQueue: queue,
    deadLetterQueue: dlq,
    worker: heartbeat
      ? { state: heartbeatAge !== null && heartbeatAge > 10_000 ? 'STOPPED' : heartbeat.state, heartbeatAgeMs: heartbeatAge }
      : { state: 'UNKNOWN', heartbeatAgeMs: null },
    table: config.tableName,
    timestamp: new Date().toISOString(),
  });
});

router.all('/fare-quotes', () => {
  throw invalidRequest('Use POST /fare-quotes.');
});

export default router;
