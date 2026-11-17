import { bindHost, portFromEnv } from './lib/env';

function url(name: string, fallback: string): string {
  const raw = process.env[name] || fallback;
  try {
    new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  return raw.replace(/\/+$/, '');
}

export const config = {
  host: bindHost(),
  port: portFromEnv('PORT', 4103),
  ridesBaseUrl: url('RIDES_API_BASE_URL', 'http://127.0.0.1:4100'),
  marketplaceBaseUrl: url('MARKETPLACE_API_BASE_URL', 'http://127.0.0.1:4101'),
};
