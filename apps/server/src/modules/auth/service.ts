import type { AuthResult, LoginInput, RegisterInput } from '@sonder/shared';
import { prisma, isPrismaError, UNIQUE_VIOLATION } from '../../db.js';
import { env } from '../../env.js';
import { conflict, unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { burnPasswordTime, hashPassword, verifyPassword } from '../../lib/password.js';
import { toSelfUser } from '../../lib/serialize.js';
import {
  ACCESS_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryDate,
  signAccessToken,
} from '../../lib/tokens.js';

const log = logger.child('auth');

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedSession extends AuthResult {
  refreshToken: string;
  refreshExpiresAt: Date;
}

const USER_SELECT = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  isOnline: true,
  lastSeenAt: true,
  createdAt: true,
} as const;

/** Usernames that would collide with app routes or impersonate the product. */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'sonder', 'support', 'help', 'api',
  'about', 'settings', 'login', 'logout', 'register', 'signup', 'signin',
  'explore', 'reels', 'messages', 'calls', 'notifications', 'profile',
  'saved', 'search', 'me', 'you', 'null', 'undefined', 'system', 'moderator',
]);

export async function register(
  input: RegisterInput,
  meta: SessionMeta,
): Promise<IssuedSession> {
  if (RESERVED_USERNAMES.has(input.username)) {
    throw conflict('That username is reserved. Please pick another.', 'USERNAME_TAKEN');
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        lastSeenAt: new Date(),
      },
      select: USER_SELECT,
    });
    log.info(`registered ${user.username}`);
    return issueSession(user, meta);
  } catch (error) {
    if (isPrismaError(error, UNIQUE_VIOLATION)) {
      const target = error.meta?.target?.join(',') ?? '';
      if (target.includes('email')) {
        throw conflict('An account with that email already exists.', 'EMAIL_TAKEN');
      }
      throw conflict('That username is already taken.', 'USERNAME_TAKEN');
    }
    throw error;
  }
}

export async function login(
  input: LoginInput,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const identifier = input.identifier.trim();
  const user = await prisma.user.findFirst({
    where: identifier.includes('@')
      ? { email: identifier.toLowerCase() }
      : { username: identifier.toLowerCase() },
    select: { ...USER_SELECT, passwordHash: true },
  });

  if (!user) {
    // Spend comparable time so this endpoint is not a username oracle.
    await burnPasswordTime();
    throw unauthorized('Those credentials do not match an account.');
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw unauthorized('Those credentials do not match an account.');

  const { passwordHash: _ignored, ...safe } = user;
  return issueSession(safe, meta);
}

/**
 * Rotating refresh flow. The presented token is revoked and replaced on every
 * use, so a stolen token is good for at most one refresh — and presenting an
 * already-rotated token is treated as theft, which revokes the whole family.
 */
export async function refresh(
  presentedToken: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const tokenHash = hashRefreshToken(presentedToken);
  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: { user: { select: USER_SELECT } },
  });

  if (!session) throw unauthorized('Your session is no longer valid. Please sign in again.');

  if (session.revokedAt) {
    // Replay of a rotated token: assume compromise and drop every session.
    log.warn(`refresh replay detected for user ${session.userId}; revoking all sessions`);
    await prisma.userSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Your session was ended for security reasons. Please sign in again.');
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Your session expired. Please sign in again.');
  }

  const next = generateRefreshToken();
  const expiresAt = refreshExpiryDate();
  const created = await prisma.$transaction(async (tx) => {
    const replacement = await tx.userSession.create({
      data: {
        userId: session.userId,
        tokenHash: next.tokenHash,
        userAgent: meta.userAgent?.slice(0, 400),
        ip: meta.ip?.slice(0, 64),
        expiresAt,
      },
    });
    await tx.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), replacedById: replacement.id },
    });
    return replacement;
  });

  return {
    user: toSelfUser(session.user),
    accessToken: signAccessToken({
      sub: session.userId,
      username: session.user.username,
      sid: created.id,
    }),
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken: next.token,
    refreshExpiresAt: expiresAt,
  };
}

export async function logout(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;
  const tokenHash = hashRefreshToken(presentedToken);
  await prisma.userSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Signs the user out of every device. */
export async function logoutAll(userId: string): Promise<number> {
  const result = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

async function issueSession(
  user: {
    id: string;
    email: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
    isOnline: boolean;
    lastSeenAt: Date | null;
    createdAt: Date;
  },
  meta: SessionMeta,
): Promise<IssuedSession> {
  const { token, tokenHash } = generateRefreshToken();
  const expiresAt = refreshExpiryDate();

  const session = await prisma.userSession.create({
    data: {
      userId: user.id,
      tokenHash,
      userAgent: meta.userAgent?.slice(0, 400),
      ip: meta.ip?.slice(0, 64),
      expiresAt,
    },
  });

  return {
    user: toSelfUser(user),
    accessToken: signAccessToken({
      sub: user.id,
      username: user.username,
      sid: session.id,
    }),
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken: token,
    refreshExpiresAt: expiresAt,
  };
}

/**
 * Removes expired and long-revoked rows. Called on an interval from index.ts;
 * without it the session table grows without bound.
 */
export async function pruneSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const result = await prisma.userSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }],
    },
  });
  if (result.count > 0) log.debug(`pruned ${result.count} expired session(s)`);
  return result.count;
}

export const REFRESH_TTL_MS = env.JWT_REFRESH_TTL_DAYS * 86_400_000;
