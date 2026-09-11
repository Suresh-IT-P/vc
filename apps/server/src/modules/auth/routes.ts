import { Router, type CookieOptions, type Response } from 'express';
import {
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '@sonder/shared';
import { prisma } from '../../db.js';
import { env, isProd } from '../../env.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { toSelfUser } from '../../lib/serialize.js';
import { ACCESS_TTL_SECONDS } from '../../lib/tokens.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  authOf,
  requireAuth,
} from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { validateBody } from '../../middleware/validate.js';
import * as authService from './service.js';
import type { IssuedSession } from './service.js';

export const authRouter = Router();

function cookieBase(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // `none` is required when the API is on a different site than the web app
    // (and browsers only accept it with Secure). Same-origin deployments behind
    // Nginx get the stricter `lax`.
    sameSite: env.COOKIE_SECURE && isProd ? 'none' : 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
  };
}

function setSessionCookies(res: Response, session: IssuedSession) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...cookieBase(),
    maxAge: session.refreshExpiresAt.getTime() - Date.now(),
  });
  res.cookie(ACCESS_COOKIE, session.accessToken, {
    ...cookieBase(),
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
}

function clearSessionCookies(res: Response) {
  const base = cookieBase();
  res.clearCookie(REFRESH_COOKIE, base);
  res.clearCookie(ACCESS_COOKIE, base);
}

/** Strips the refresh token from the JSON body: it lives in the cookie only. */
function publicSession(session: IssuedSession) {
  return {
    user: session.user,
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
  };
}

const meta = (req: { headers: Record<string, unknown>; ip?: string }) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  ip: req.ip,
});

authRouter.post(
  '/register',
  authLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.register(req.body, meta(req));
    setSessionCookies(res, session);
    res.status(201).json(publicSession(session));
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.login(req.body, meta(req));
    setSessionCookies(res, session);
    res.json(publicSession(session));
  }),
);

/**
 * Exchanges the refresh cookie for a fresh access token. The web client calls
 * this on boot and whenever a request comes back 401, which is what keeps the
 * 15-minute access token invisible to the user.
 */
authRouter.post(
  '/refresh',
  authLimiter,
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No session to refresh.');
    try {
      const session = await authService.refresh(token, meta(req));
      setSessionCookies(res, session);
      res.json(publicSession(session));
    } catch (error) {
      clearSessionCookies(res);
      throw error;
    }
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await authService.logout(token);
    clearSessionCookies(res);
    res.status(204).end();
  }),
);

authRouter.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const count = await authService.logoutAll(userId);
    clearSessionCookies(res);
    res.json({ revoked: count });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        isOnline: true,
        lastSeenAt: true,
        createdAt: true,
        _count: { select: { posts: true, followers: true, following: true } },
      },
    });
    if (!user) throw notFound('Your account no longer exists.');
    res.json({
      user: toSelfUser(user, {
        posts: user._count.posts,
        followers: user._count.followers,
        following: user._count.following,
      }),
    });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const user = await prisma.user.update({
      where: { id: userId },
      data: req.body,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        isOnline: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
    res.json({ user: toSelfUser(user) });
  }),
);
