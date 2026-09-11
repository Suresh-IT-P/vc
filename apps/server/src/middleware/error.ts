import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isPrismaError, UNIQUE_VIOLATION, RECORD_NOT_FOUND } from '../db.js';
import { zodToFieldErrors } from './validate.js';

const log = logger.child('http');

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let normalised: AppError;

  if (isAppError(error)) {
    normalised = error;
  } else if (error instanceof ZodError) {
    normalised = new AppError(400, 'VALIDATION', error.issues[0]?.message ?? 'Invalid input.', {
      details: { fields: zodToFieldErrors(error) },
    });
  } else if (isPrismaError(error, UNIQUE_VIOLATION)) {
    const target = error.meta?.target?.join(', ') ?? 'value';
    normalised = new AppError(409, 'CONFLICT', `That ${target} is already taken.`);
  } else if (isPrismaError(error, RECORD_NOT_FOUND)) {
    normalised = new AppError(404, 'NOT_FOUND', 'That record no longer exists.');
  } else if (
    error instanceof SyntaxError &&
    'body' in error &&
    'status' in error
  ) {
    // express.json() rejecting a malformed payload.
    normalised = new AppError(400, 'MALFORMED_JSON', 'The request body was not valid JSON.');
  } else {
    normalised = new AppError(500, 'INTERNAL', 'Something went wrong on our end.', {
      expose: false,
      cause: error,
    });
  }

  if (normalised.status >= 500) {
    log.error(`${req.method} ${req.path} -> ${normalised.status}`, error);
  } else {
    log.debug(`${req.method} ${req.path} -> ${normalised.status} ${normalised.code}`);
  }

  res.status(normalised.status).json({
    error: {
      code: normalised.code,
      message: normalised.expose
        ? normalised.message
        : 'Something went wrong on our end.',
      ...(normalised.details ? { details: normalised.details } : {}),
    },
  });
};

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 4 does not do this itself.
 */
export function asyncHandler(
  handler: (
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
    next: Parameters<RequestHandler>[2],
  ) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
