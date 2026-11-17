import { errorFields, logger, setServiceName } from '../lib/log';
setServiceName('marketplace-seed');
import { config } from '../config';
import { seedDrivers } from '../store';

/** Insert missing seed drivers. Safe to run repeatedly; never resets reservations. */
seedDrivers()
  .then((result) => {
    logger.info('seed complete', { table: config.tableName, ...result });
  })
  .catch((err) => {
    logger.error('seed failed', errorFields(err));
    process.exitCode = 1;
  });
