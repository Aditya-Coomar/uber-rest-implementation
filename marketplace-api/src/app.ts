import express from 'express';
import { errorHandler, notFound, requestContext, requireJsonBody } from './lib/http';
import HealthRoutes from './routes/health';
import FleetRoutes from './routes/fleet';
import ReservationRoutes from './routes/reservations';

const app = express();

app.disable('x-powered-by');
app.use(requestContext());
app.use(requireJsonBody);
app.use(express.json({ limit: '16kb' }));

app.get('/', (_req, res) => {
  res.json({ service: 'marketplace-api', description: 'Driver supply and exclusive reservations (internal).' });
});
app.use('/api/health', HealthRoutes);
app.use('/internal/reservations', ReservationRoutes);
app.use('/internal', FleetRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
