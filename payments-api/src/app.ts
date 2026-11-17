import express from 'express';
import { errorHandler, notFound, requestContext, requireJsonBody } from './lib/http';
import AttemptRoutes from './routes/attempts';
import HealthRoutes from './routes/health';

const app = express();

app.disable('x-powered-by');
app.use(requestContext());
app.use(requireJsonBody);
app.use(express.json({ limit: '16kb' }));

app.get('/', (_req, res) => {
  res.json({ service: 'payments-api', description: 'Simulated payment attempts (internal).' });
});
app.use('/api/health', HealthRoutes);
app.use('/internal/payment-attempts', AttemptRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
