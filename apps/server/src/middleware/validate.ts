import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError } from '../lib/errors.js';

export interface ValidationFieldError {
  path: string;
  message: string;
}

export function zodToFieldErrors(error: ZodError): ValidationFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function validationError(error: ZodError): AppError {
  const fields = zodToFieldErrors(error);
  return new AppError(
    400,
    'VALIDATION',
    fields[0]?.message ?? 'Some of the information you sent was not valid.',
    { details: { fields } },
  );
}

/**
 * Replaces the request part with the *parsed* value, so handlers only ever see
 * data that survived Zod. Unknown keys are stripped by Zod objects, which is
 * what stops a client from smuggling e.g. `senderId` into a message payload.
 */
function make(part: 'body' | 'query' | 'params') {
  return <S extends ZodTypeAny>(schema: S): RequestHandler =>
    (req: Request, _res: Response, next: NextFunction) => {
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        next(validationError(result.error));
        return;
      }
      // Express 4 defines `query` as a getter on some versions; assign safely.
      Object.defineProperty(req, part, {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      next();
    };
}

export const validateBody = make('body');
export const validateQuery = make('query');
export const validateParams = make('params');

/** Validate an arbitrary value outside the middleware chain (socket handlers). */
export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
