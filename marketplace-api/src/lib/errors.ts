/** An error that maps directly onto the public error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const invalidRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'INVALID_REQUEST', message, details);

export const storageUnavailable = (details?: Record<string, unknown>, headers?: Record<string, string>) =>
  new ApiError(503, 'STORAGE_UNAVAILABLE', 'The data store is temporarily unavailable. Retry the request.', details, headers);

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH']);
const TRANSIENT_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'ResourceNotFoundException',
  'TransactionInProgressException',
]);

/**
 * True for failures of a downstream dependency (network, timeouts, throttling,
 * missing table). These become 503 responses instead of 500.
 */
export function isDependencyFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string; $metadata?: unknown; $fault?: string };
  if (e.code && NETWORK_CODES.has(e.code)) return true;
  if (TRANSIENT_NAMES.has(e.name)) return true;
  if (e.$fault === 'server') return true;
  const cause = (e as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err && isDependencyFailure(cause);
}
