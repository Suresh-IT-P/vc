import type { Ack } from '@sonder/shared';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child('socket');

type AnyAck = ((response: Ack<never>) => void) | undefined;

/**
 * Wraps a socket handler so that:
 *   - every thrown AppError becomes a structured `{ ok: false }` ack instead of
 *     an unhandled rejection that silently hangs the caller's promise;
 *   - unexpected errors are logged server-side but never leak their message.
 *
 * Clients that forget to pass an ack still get the side effects; they just do
 * not learn the outcome.
 */
export function withAck<TPayload, TResult>(
  event: string,
  handler: (payload: TPayload) => Promise<TResult> | TResult,
) {
  return async (payload: TPayload, ack?: AnyAck): Promise<void> => {
    try {
      const data = await handler(payload);
      (ack as ((r: Ack<TResult>) => void) | undefined)?.({ ok: true, data });
    } catch (error) {
      const normalised: AppError = isAppError(error)
        ? error
        : new AppError(500, 'INTERNAL', 'Something went wrong.', {
            expose: false,
            cause: error,
          });

      if (normalised.status >= 500) log.error(`${event} failed`, error);
      else log.debug(`${event} rejected: ${normalised.code} ${normalised.message}`);

      (ack as ((r: Ack<TResult>) => void) | undefined)?.({
        ok: false,
        error: {
          code: normalised.code,
          message: normalised.expose
            ? normalised.message
            : 'Something went wrong on our end.',
        },
      });
    }
  };
}

/** Fire-and-forget handler (no ack) that must not crash the process. */
export function safely<TPayload>(
  event: string,
  handler: (payload: TPayload) => Promise<void> | void,
) {
  return async (payload: TPayload): Promise<void> => {
    try {
      await handler(payload);
    } catch (error) {
      if (isAppError(error) && error.status < 500) {
        log.debug(`${event} rejected: ${error.code}`);
        return;
      }
      log.error(`${event} failed`, error);
    }
  };
}
