import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

export const ACCESS_COOKIE = 'sonder_at';
export const REFRESH_COOKIE = 'sonder_rt';

export interface AuthContext {
  userId: string;
  username: string;
  sessionId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Pulls the access token from `Authorization: Bearer` first, then the cookie.
 *
 * Both exist on purpose: the cookie makes same-origin page loads work without
 * JavaScript bootstrapping, while the header is what the Socket.IO handshake and
 * cross-origin dev setup use. Neither is trusted beyond its signature.
 */
function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const cookie = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  return cookie ?? null;
}

/** Hard requirement: 401 when there is no valid token. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) {
    next(unauthorized('You need to sign in to do that.'));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      username: payload.username,
      sessionId: payload.sid,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/** Populates req.auth when a token is present, but never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      req.auth = {
        userId: payload.sub,
        username: payload.username,
        sessionId: payload.sid,
      };
    } catch {
      // Ignore: the route works fine anonymously.
    }
  }
  next();
}

/** Narrowing helper for handlers mounted behind requireAuth. */
export function authOf(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
