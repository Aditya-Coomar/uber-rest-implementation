import cors from 'cors';
import express from 'express';
import { errorHandler, notFound, requestContext, requireJsonBody } from './lib/http';
import { config } from './config';
import AnalyticsRoutes from './routes/analytics';
import HealthRoutes from './routes/health';
import ExtraRoutes from './routes/public-extras';
import RideRoutes from './routes/rides';

const app = express();
const allowedOrigins = new Set(config.corsOrigins);

app.disable('x-powered-by');
app.use(requestContext());
app.use(
  cors({
    // Explicit browser origins only; non-browser clients send no Origin.
    origin: (origin, callback) => callback(null, origin === undefined || allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['Location', 'X-Request-Id', 'Retry-After'],
    maxAge: 600,
  }),
);
app.use(requireJsonBody);
app.use(express.json({ limit: '16kb' }));

app.get('/', (_req, res) => {
  res.json({ service: 'rides-api', description: 'Public ride-booking REST API.' });
});
app.use('/api/health', HealthRoutes);
app.use('/rides', RideRoutes);
app.use('/analytics', AnalyticsRoutes);
app.use('/', ExtraRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
