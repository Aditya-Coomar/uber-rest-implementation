import { Router } from 'express';
import { errorFields, logger } from '../lib/log';
import { config } from '../config';
import { probeTable } from '../store/rides-repo';

const router = Router();

/** Depends only on the Rides table: Marketplace, Payments, S3 and SQS are not consulted. */
router.get('/', async (_req, res) => {
  try {
    await probeTable();
    res.status(200).json({ status: 'ok', service: 'rides-api', table: config.tableName, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.warn('health check failed', errorFields(err));
    res.locals.outcome = 'UNHEALTHY';
    res.status(503).json({ status: 'unavailable', service: 'rides-api', table: config.tableName, timestamp: new Date().toISOString() });
  }
});

export default router;
