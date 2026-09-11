import rateLimit, { type Options } from 'express-rate-limit';
import { env, isTest } from '../env.js';

/**
 * Rate limits are per-IP and in-process. That is correct for a single Node
 * instance behind Nginx; if you scale horizontally, swap in a shared store
 * (`rate-limit-redis`) so the budget is global. See docs/deployment.md.
 */
function limiter(overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Tests hammer the same endpoints deliberately.
    skip: () => isTest,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please wait a moment and try again.',
        },
      });
    },
    ...overrides,
  });
}

/** Broad limit applied to the whole API surface. */
export const generalLimiter = limiter();

/**
 * Login / register / refresh get a much tighter budget: these are the endpoints
 * worth brute-forcing. Successful requests are not counted so a legitimate user
 * signing in repeatedly on a shared IP is not punished.
 */
export const authLimiter = limiter({
  max: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
});

/** Search is cheap but easy to abuse for enumeration. */
export const searchLimiter = limiter({
  windowMs: 60_000,
  max: 60,
});
