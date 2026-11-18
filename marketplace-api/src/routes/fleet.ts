import { Router } from 'express';
import { ApiError, invalidRequest } from '../lib/errors';
import { parseCoordinates, requireObject } from '../lib/validate';
import { MAX_SIM_DRIVERS, haversineMeters } from '../drivers';
import { ensureSimulatedFleet, fleetStats, listDemoDrivers, removeSimulatedFleet } from '../store';

const router = Router();

/** Available drivers near a point, for map display. Positions only; no names. */
router.get('/drivers/available', async (req, res) => {
  const point = parseCoordinates({ lat: Number(req.query.lat), lng: Number(req.query.lng) }, 'point');
  const radius = Math.min(Number(req.query.radiusMeters ?? 5_000) || 5_000, 20_000);
  const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
  const drivers = (await listDemoDrivers())
    .filter((d) => !d.currentRideId)
    .map((d) => ({ driverId: d.driverId, location: d.location, distanceMeters: Math.round(haversineMeters(point, d.location)) }))
    .filter((d) => d.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.driverId.localeCompare(b.driverId))
    .slice(0, limit);
  res.status(200).json({ drivers });
});

router.get('/fleet/stats', async (req, res) => {
  res.status(200).json(await fleetStats(req.query.pool === 'simulation'));
});

/** Ensure N simulated drivers exist (used by the load simulator). */
router.put('/fleet/simulated', async (req, res) => {
  const body = requireObject(req.body, 'body');
  const count = body.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_SIM_DRIVERS) {
    throw invalidRequest(`count must be an integer between 0 and ${MAX_SIM_DRIVERS}.`, { field: 'count' });
  }
  res.status(200).json(await ensureSimulatedFleet(count));
});

router.delete('/fleet/simulated', async (_req, res) => {
  res.status(200).json(await removeSimulatedFleet());
});

router.all('/fleet', () => {
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
});

export default router;
