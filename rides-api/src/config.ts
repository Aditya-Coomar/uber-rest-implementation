import { resourcePrefix } from './lib/aws-config';
import { bindHost, portFromEnv } from './lib/env';

function requiredUrl(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must use http or https.`);
  return raw.replace(/\/+$/, '');
}

export function resourceNames(prefix = resourcePrefix()) {
  return {
    ridesTable: `${prefix}-rides`,
    marketplaceTable: `${prefix}-marketplace`,
    paymentsTable: `${prefix}-payments`,
    bucket: `${prefix}-trip-events`,
    queue: `${prefix}-trip-events`,
    deadLetterQueue: `${prefix}-trip-events-dlq`,
    notifyCheckQueue: `${prefix}-notify-check`,
  };
}

export const config = {
  host: bindHost(),
  port: portFromEnv('PORT', 4000),
  get tableName() {
    return resourceNames().ridesTable;
  },
  get marketplaceBaseUrl() {
    return requiredUrl('MARKETPLACE_API_BASE_URL');
  },
  get paymentsBaseUrl() {
    return requiredUrl('PAYMENTS_API_BASE_URL');
  },
  get corsOrigins(): string[] {
    const raw = process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000';
    return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  },
  /** Budget for the synchronous Marketplace call inside POST /rides. */
  inlineMatchDeadlineMs: 2_500,
  /** Budget for each worker-side HTTP or S3 operation. */
  workerOperationDeadlineMs: 5_000,
};
