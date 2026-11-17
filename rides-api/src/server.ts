import { logger, setServiceName } from './lib/log';
setServiceName('rides-api');
import { config } from './config';
import app from './app';

// Fail fast on configuration before accepting traffic.
try {
  void config.marketplaceBaseUrl;
  void config.tableName;
} catch (err) {
  logger.error('invalid configuration', { errorMessage: (err as Error).message });
  process.exit(1);
}

const server = app.listen(config.port, config.host, () => {
  logger.info('listening', {
    url: `http://${config.host}:${config.port}`,
    table: config.tableName,
    corsOrigins: config.corsOrigins,
  });
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
