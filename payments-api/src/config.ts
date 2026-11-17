import { resourcePrefix } from './lib/aws-config';
import { bindHost, portFromEnv } from './lib/env';

export const config = {
  host: bindHost(),
  port: portFromEnv('PORT', 4002),
  tableName: `${resourcePrefix()}-payments`,
};
