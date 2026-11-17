import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { ApiError, isDependencyFailure } from './errors';
import { errorFields, logger } from './log';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Per-request context: propagate or generate X-Request-Id and emit one log line
 * per request with route, outcome, elapsed time and any ride/attempt IDs that
 * handlers attached to `res.locals.logFields`.
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.locals.logFields = {};
    res.setHeader('X-Request-Id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
      logger.info('request', {
        requestId,
        method: req.method,
        route: routeOf(req),
        status: res.statusCode,
        outcome: res.locals.outcome ?? (res.statusCode < 400 ? 'OK' : 'ERROR'),
        elapsedMs,
        ...res.locals.logFields,
      });
    });
    next();
  };
}

function routeOf(req: Request): string {
  const routePath = (req.route as { path?: string } | undefined)?.path;
  return routePath ? `${req.baseUrl}${routePath}` : req.path;
}

/** Attach identifiers to the request's log line. */
export function annotate(res: { locals: Record<string, unknown> }, fields: Record<string, unknown>): void {
  Object.assign(res.locals.logFields as Record<string, unknown>, fields);
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', 'No route matches this method and path.'));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  let apiError: ApiError;
  const typed = err as { type?: string };
  if (err instanceof ApiError) {
    apiError = err;
  } else if (typed?.type === 'entity.parse.failed') {
    apiError = new ApiError(400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
  } else if (typed?.type === 'entity.too.large') {
    apiError = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  } else if (typed?.type === 'charset.unsupported' || typed?.type === 'encoding.unsupported') {
    apiError = new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send UTF-8 encoded JSON.');
  } else if (isDependencyFailure(err)) {
    logger.warn('dependency failure', { requestId: res.locals.requestId, path: req.path, ...errorFields(err) });
    apiError = new ApiError(503, 'STORAGE_UNAVAILABLE', 'The data store is temporarily unavailable. Retry the request.');
  } else {
    logger.error('unexpected error', {
      requestId: res.locals.requestId,
      path: req.path,
      ...errorFields(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    apiError = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }
  res.locals.outcome = apiError.code;
  for (const [name, value] of Object.entries(apiError.headers ?? {})) res.setHeader(name, value);
  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId: res.locals.requestId,
      ...(apiError.details && Object.keys(apiError.details).length > 0 && { details: apiError.details }),
    },
  });
};

/** Only accept JSON bodies (or none) on mutating requests. */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (hasBody && !req.is('application/json')) {
    return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.'));
  }
  next();
};
