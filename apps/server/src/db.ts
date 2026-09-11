import { PrismaClient } from '@prisma/client';
import { env, isTest } from './env.js';
import { logger } from './lib/logger.js';

const log = logger.child('db');

declare global {
  // Reused across tsx watch reloads so we do not leak connection pools.
  // eslint-disable-next-line no-var
  var __sonderPrisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  return new PrismaClient({
    log: isTest
      ? ['error']
      : env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });
}

export const prisma = globalThis.__sonderPrisma ?? create();

if (env.NODE_ENV !== 'production') globalThis.__sonderPrisma = prisma;

/**
 * SQLite defaults are tuned for a single-process CLI tool, not a server. Three
 * pragmas are what make it behave as an application database:
 *
 *   journal_mode=WAL   Readers no longer block on the writer, and the writer no
 *                      longer blocks readers. Without it, one in-flight message
 *                      insert stalls every concurrent request. WAL is persistent
 *                      — it is a property of the file, so setting it once would
 *                      do — but it is cheap and self-documenting to assert here.
 *   busy_timeout       Wait for a contended write lock instead of failing
 *                      immediately with SQLITE_BUSY. 5s is far longer than any
 *                      write here takes, so this converts a spurious error into
 *                      a brief wait.
 *   synchronous=NORMAL Safe with WAL: survives process crashes, and can only
 *                      lose the most recent commits on an OS/power failure.
 *                      FULL costs an fsync per transaction for a durability
 *                      guarantee a chat app does not need.
 *
 * foreign_keys is left alone — Prisma enables it per connection itself, and the
 * schema's onDelete: Cascade rules depend on it.
 */
async function applySqlitePragmas(): Promise<{ journalMode: string; busyTimeoutMs: number }> {
  /*
   * All three go through $queryRaw, not $executeRaw. A setting PRAGMA in SQLite
   * echoes its result — `journal_mode = WAL` returns the mode and
   * `busy_timeout = 5000` returns the timeout — and Prisma rejects a result set
   * from $executeRaw with "Execute returned results, which is not allowed in
   * SQLite". Using $queryRaw throughout is uniform and lets us assert the values
   * actually took effect instead of assuming they did.
   */
  const journal =
    await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode = WAL;');
  const busy =
    await prisma.$queryRawUnsafe<Array<{ timeout: number | bigint }>>('PRAGMA busy_timeout = 5000;');
  await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');

  return {
    journalMode: journal[0]?.journal_mode ?? 'unknown',
    busyTimeoutMs: Number(busy[0]?.timeout ?? 0),
  };
}

export async function connectDb(): Promise<void> {
  try {
    await prisma.$connect();
    const { journalMode, busyTimeoutMs } = await applySqlitePragmas();
    log.info(`connected (sqlite, journal_mode=${journalMode}, busy_timeout=${busyTimeoutMs}ms)`);
    if (journalMode.toLowerCase() !== 'wal') {
      // Worth shouting about: without WAL, one write blocks every reader. The
      // usual cause is a database on a filesystem that cannot do shared memory
      // (some network mounts), where SQLite silently falls back.
      log.warn(`expected journal_mode=wal but the database reports "${journalMode}"`);
    }
  } catch (error) {
    log.error(
      'Could not open the database. Check DATABASE_URL points at a writable ' +
        'file path, then run: npm run db:migrate',
      error,
    );
    throw error;
  }
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

/* --------------------------------------------------------------------------
 * A note on case-insensitive search
 *
 * `searchUsers` uses plain `contains` with no `mode` option. On SQLite `LIKE`
 * is case-insensitive for ASCII, which covers usernames — they are validated to
 * `[a-z0-9._]` — and the overwhelming majority of display names.
 *
 * The honest limitation: a display name with non-ASCII characters matches
 * case-sensitively, so searching "zoe" will not find "Zoë". `mode:
 * 'insensitive'` is not an option (Prisma rejects it on SQLite); fixing it
 * properly means storing a normalised lowercase column to search against.
 * See docs/database.md.
 * ------------------------------------------------------------------------- */

/** Prisma error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = 'P2002';
/** Prisma error code for "record not found" on update/delete. */
export const RECORD_NOT_FOUND = 'P2025';

export function isPrismaError(
  error: unknown,
  code: string,
): error is { code: string; meta?: { target?: string[] } } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}
