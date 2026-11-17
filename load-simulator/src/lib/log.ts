/**
 * Minimal structured logger. One JSON object per line keeps logs greppable and
 * avoids a logging dependency. Never pass raw idempotency keys or payment data.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

let serviceName = process.env.SERVICE_NAME ?? 'service';
let allToStderr = false;

/** Scripts that print machine-readable output on stdout send all logs to stderr. */
export function logToStderr(): void {
  allToStderr = true;
}

export function setServiceName(name: string): void {
  serviceName = name;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (level === 'debug' && process.env.LOG_LEVEL !== 'debug') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: serviceName, msg, ...fields });
  (allToStderr || level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

/** Reduce an unknown error to loggable fields without dumping SDK internals. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: unknown; $metadata?: { httpStatusCode?: number } };
    return {
      errorName: err.name,
      errorMessage: err.message,
      ...(anyErr.code !== undefined && { errorCode: anyErr.code }),
      ...(anyErr.$metadata?.httpStatusCode !== undefined && { httpStatus: anyErr.$metadata.httpStatusCode }),
    };
  }
  return { errorMessage: String(err) };
}
