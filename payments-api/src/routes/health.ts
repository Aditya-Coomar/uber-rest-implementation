import { Router } from 'express';
import { errorFields, logger } from '../lib/log';
import { config } from '../config';
import { probeTable } from '../store';

const router = Router();

/** 200 when this service's own table answers a read, 503 otherwise. */
router.get('/', async (_req, res) => {
  try {
    await probeTable();
    res.status(200).json({ status: 'ok', service: 'payments-api', table: config.tableName, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.warn('health check failed', errorFields(err));
    res.locals.outcome = 'UNHEALTHY';
    res.status(503).json({ status: 'unavailable', service: 'payments-api', table: config.tableName, timestamp: new Date().toISOString() });
  }
});

export default router;
