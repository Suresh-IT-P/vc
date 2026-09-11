import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/* Load .env before anything reads process.env. Package-local first so a
 * developer can shadow a single value, then the shared repo-root file. */
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');

for (const file of [resolve(serverRoot, '.env'), resolve(repoRoot, '.env')]) {
  if (existsSync(file)) dotenv.config({ path: file });
}

const csv = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : fallback,
    );

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),

  /**
   * A SQLite connection string: `file:` plus a path, resolved by Prisma relative
   * to prisma/schema.prisma. Rejecting other schemes here turns a leftover
   * `mysql://…` URL into one clear line at boot rather than a Prisma engine
   * error later, which is the kind of thing people lose an evening to.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => value.startsWith('file:'), {
      message:
        'DATABASE_URL must be a SQLite path, e.g. file:./dev.db — Sonder uses ' +
        'SQLite (see docs/database.md)',
    }),

  CORS_ORIGINS: csv(['http://localhost:3000']),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),
  COOKIE_SECURE: bool(false),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),

  STUN_SERVERS: csv([
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ]),
  TURN_SERVER: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_USERNAME: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_PASSWORD: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_SECRET: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_CREDENTIAL_TTL: z.coerce.number().int().min(60).default(86_400),
  TURN_REALM: z.string().default('sonder.local'),

  // Floors are deliberately low: the schema's job is to catch typos, not to
  // enforce product policy, and the test suite runs with sub-second timeouts.
  CALL_RING_TIMEOUT_MS: z.coerce.number().int().min(500).default(45_000),
  CALL_RECONNECT_GRACE_MS: z.coerce.number().int().min(500).default(30_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(
    `\nInvalid environment configuration:\n${issues}\n\n` +
      `Copy .env.example to .env at the repo root and fill in the required values.\n`,
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Origin allow-list, with a development-only loopback exemption.
 *
 * In development the web app can legitimately land on a port other than 3000 —
 * `WEB_PORT` is set, or Next picks the next free port because something else
 * holds 3000 — and making that require a CORS_ORIGINS edit is friction with no
 * security value: an attacker cannot serve from the victim's own loopback.
 *
 * In production the exemption is off and only the configured origins pass. No
 * wildcards, and nothing is inferred from the request's own headers.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export function isAllowedOrigin(origin: string): boolean {
  if (env.CORS_ORIGINS.includes(origin)) return true;
  return !isProd && LOOPBACK_ORIGIN.test(origin);
}

/** A TURN relay is what makes calls work on symmetric NAT and mobile data. */
export const hasTurn = Boolean(
  env.TURN_SERVER && (env.TURN_SECRET || (env.TURN_USERNAME && env.TURN_PASSWORD)),
);

if (isProd) {
  if (!env.COOKIE_SECURE) {
    console.warn(
      '[env] COOKIE_SECURE=false in production. Refresh cookies will be sent over plain HTTP.',
    );
  }
  if (!hasTurn) {
    console.warn(
      '[env] No TURN server configured. Calls will fail for peers behind ' +
        'symmetric NAT (a large share of mobile networks). Set TURN_SERVER + TURN_SECRET.',
    );
  }
}
