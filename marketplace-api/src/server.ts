import { errorFields, logger, setServiceName } from './lib/log';
setServiceName('marketplace-api');
import app from './app';
import { config } from './config';
import { seedDrivers } from './store';

const server = app.listen(config.port, config.host, () => {
  logger.info('listening', { url: `http://${config.host}:${config.port}`, table: config.tableName });
  // Seeding is idempotent (insert-missing only); the bootstrap also runs it.
  seedDrivers()
    .then((r) => logger.info('driver seed checked', r))
    .catch((err) => logger.warn('driver seed skipped', errorFields(err)));
});

server.on('error', (err) => {
  logger.error('failed to start server', { errorMessage: err.message });
  process.exit(1);
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
