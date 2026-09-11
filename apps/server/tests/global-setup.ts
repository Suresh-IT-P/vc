import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');

/**
 * The suites run against a real database, not mocks: authorisation rules,
 * unique constraints and transaction behaviour are exactly the things worth
 * testing, and a mocked Prisma client would assert nothing about them.
 *
 * Since the app itself is SQLite, "a real database" costs a file. A dedicated
 * one is created per run and deleted afterwards, so tests never touch dev data
 * and there is no separate engine to install, configure, or keep in sync.
 * Override the path with TEST_DATABASE_URL if you need to inspect it.
 */
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'file:./test.db';
const SCHEMA = 'prisma/schema.prisma';

/** Files SQLite may leave beside the database (WAL mode adds -wal and -shm). */
const SIDECARS = ['', '-journal', '-wal', '-shm'];

function testDbPath(): string | null {
  if (!TEST_DB_URL.startsWith('file:')) return null;
  return resolve(serverRoot, 'prisma', TEST_DB_URL.slice('file:'.length));
}

function removeDatabase(): void {
  const base = testDbPath();
  if (!base) return;
  for (const suffix of SIDECARS) {
    const file = `${base}${suffix}`;
    if (!existsSync(file)) continue;
    try {
      rmSync(file);
    } catch {
      // Windows sometimes still holds the handle; the next run recreates it.
    }
  }
}

/**
 * True when the generated client already matches this schema.
 *
 * Skipping a redundant generate is not only about speed: on Windows a running
 * dev server holds `query_engine-windows.dll.node` open, and `prisma generate`
 * replaces it by rename — so generating unconditionally made `npm test` fail
 * with EPERM whenever `npm run dev` was up in another terminal.
 */
function clientIsCurrent(): boolean {
  const generated = resolve(repoRoot, 'node_modules/.prisma/client/schema.prisma');
  if (!existsSync(generated)) return false;
  // mtime, not content: Prisma re-formats the schema when copying it into the
  // client, so the files are never byte-identical.
  return statSync(generated).mtimeMs >= statSync(resolve(serverRoot, SCHEMA)).mtimeMs;
}

export default async function setup() {
  removeDatabase();

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? 'test-secret-that-is-definitely-long-enough-for-zod-32';
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  // Keep the ring timeout short so the timeout test does not sit for 45 s.
  process.env.CALL_RING_TIMEOUT_MS = process.env.CALL_RING_TIMEOUT_MS ?? '2000';
  process.env.CALL_RECONNECT_GRACE_MS = process.env.CALL_RECONNECT_GRACE_MS ?? '2000';

  const prismaCli = resolve(repoRoot, 'node_modules/prisma/build/index.js');
  const prismaEnv = { ...process.env, DATABASE_URL: TEST_DB_URL };

  if (!clientIsCurrent()) {
    execFileSync(process.execPath, [prismaCli, 'generate', `--schema=${SCHEMA}`], {
      cwd: serverRoot,
      stdio: 'pipe',
      env: prismaEnv,
    });
  }

  /*
   * `migrate deploy`, not `db push`: it applies the same committed migrations
   * production runs, so the suites exercise the real schema rather than one
   * Prisma inferred. It also only ever moves forward — it never resets or drops
   * anything, which matters if TEST_DATABASE_URL points somewhere you care about.
   */
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', `--schema=${SCHEMA}`], {
    cwd: serverRoot,
    stdio: 'pipe',
    env: prismaEnv,
  });

  return async () => {
    removeDatabase();
  };
}
