import express from 'express';
import { ApiError, invalidRequest } from './lib/errors';
import { errorHandler, notFound, requestContext, requireJsonBody } from './lib/http';
import { requireObject } from './lib/validate';
import { LIMITS, Simulation, SimulationConfig } from './simulation';

const app = express();
let current: Simulation | null = null;

app.disable('x-powered-by');
app.use(requestContext());
app.use(requireJsonBody);
app.use(express.json({ limit: '16kb' }));

function numberIn(body: Record<string, unknown>, field: keyof typeof LIMITS, fallback: number, integer = true): number {
  const raw = body[field] ?? fallback;
  const [min, max] = LIMITS[field];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max || (integer && !Number.isInteger(raw))) {
    throw invalidRequest(`${field} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`, { field });
  }
  return raw;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'load-simulator', running: current?.active ?? false });
});

/** Start a run. Only one run at a time; every input is bounded. */
app.post('/simulations', (req, res) => {
  if (current?.active) {
    throw new ApiError(409, 'SIMULATION_RUNNING', 'A simulation is already running. Stop it first.', { id: current.id });
  }
  const body = requireObject(req.body ?? {}, 'body');
  const cfg: SimulationConfig = {
    ratePerSecond: numberIn(body, 'ratePerSecond', 10, false),
    durationSeconds: numberIn(body, 'durationSeconds', 30),
    fleetSize: numberIn(body, 'fleetSize', 60),
    cancelRate: numberIn(body, 'cancelRate', 0.1, false),
    tripSeconds: numberIn(body, 'tripSeconds', 4, false),
    retryDeclined: body.retryDeclined === undefined ? true : body.retryDeclined === true,
  };
  current = new Simulation(cfg);
  void current.run();
  res.locals.logFields.simulationId = current.id;
  res.status(202).location('/simulations/current').json(current.snapshot());
});

app.get('/simulations/current', (_req, res) => {
  if (!current) throw new ApiError(404, 'NO_SIMULATION', 'No simulation has been run yet.');
  res.json(current.snapshot());
});

app.post('/simulations/current/stop', (_req, res) => {
  if (!current) throw new ApiError(404, 'NO_SIMULATION', 'No simulation has been run yet.');
  current.stop();
  res.status(202).json(current.snapshot());
});

app.use(notFound);
app.use(errorHandler);

export default app;
