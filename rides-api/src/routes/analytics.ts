import { Router } from 'express';
import { getSummary } from '../analytics/projection';

const router = Router();

/** Completed-trip count from the active projection generation. */
router.get('/summary', async (_req, res) => {
  res.status(200).json(await getSummary());
});

export default router;
