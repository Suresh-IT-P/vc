import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { unauthorized } from './errors.js';

export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  username: string;
  /** The UserSession row this access token was minted from, if any. */
  sid?: string;
}

/** Seconds, derived from JWT_ACCESS_TTL, used for the client-side refresh timer. */
export const ACCESS_TTL_SECONDS = parseDuration(env.JWT_ACCESS_TTL);

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'sonder',
    audience: 'sonder-client',
  });
}

/**
 * Verifies an access token. Throws an AppError (401) rather than a jwt error so
 * both the HTTP and the socket layer can handle it uniformly.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sonder',
      audience: 'sonder-client',
    });
    if (typeof decoded === 'string' || !decoded.sub) {
      throw unauthorized('Malformed session token.');
    }
    return {
      sub: String(decoded.sub),
      username: String((decoded as jwt.JwtPayload).username ?? ''),
      sid: (decoded as jwt.JwtPayload).sid as string | undefined,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthorized('Your session expired. Please sign in again.');
    }
    throw unauthorized('Invalid session token.');
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they must be revocable,
 * and revocation needs a database row anyway. Only the hash is stored.
 */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshExpiryDate(from = new Date()): Date {
  return new Date(from.getTime() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);
}

/** Parses "15m" / "2h" / "7d" / "900" into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) return 900;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit] ?? 1;
  return amount * multiplier;
}
