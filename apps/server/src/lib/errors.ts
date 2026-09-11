/**
 * A single error type that carries everything both transports (HTTP and
 * Socket.IO) need: a stable machine code, an HTTP status, and a message that is
 * safe to show a user.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** False for unexpected failures, whose message must not reach the client. */
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? status < 500;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, message, { details });

export const unauthorized = (message = 'You need to sign in to do that.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have access to that.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found.') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, code = 'CONFLICT') =>
  new AppError(409, code, message);

export const tooManyRequests = (message = 'Too many requests. Slow down a moment.') =>
  new AppError(429, 'RATE_LIMITED', message);

export const internal = (message = 'Something went wrong on our end.', cause?: unknown) =>
  new AppError(500, 'INTERNAL', message, { expose: false, cause });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
