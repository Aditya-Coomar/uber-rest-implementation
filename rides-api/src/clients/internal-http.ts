import { errorFields, logger } from '../lib/log';

export type HttpOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: string };

/**
 * JSON over native fetch with a hard deadline. Network errors and timeouts
 * become `{ ok: false }`; any HTTP status is returned for the caller to classify.
 */
export async function callJson(
  method: 'GET' | 'PUT' | 'DELETE',
  url: string,
  options: { body?: unknown; deadlineMs: number; requestId?: string },
): Promise<HttpOutcome> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.requestId) headers['X-Request-Id'] = options.requestId;
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.deadlineMs),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, reason: `non-JSON response (HTTP ${response.status})` };
      }
    }
    return { ok: true, status: response.status, body };
  } catch (err) {
    const fields = errorFields(err);
    logger.debug('internal call failed', { method, url, ...fields });
    const name = err instanceof Error ? err.name : '';
    return { ok: false, reason: name === 'TimeoutError' ? 'timeout' : String(fields.errorMessage ?? 'network error') };
  }
}

export function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

export function errorDetailsOf(body: unknown): Record<string, unknown> {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
}
