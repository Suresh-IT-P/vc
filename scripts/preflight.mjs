#!/usr/bin/env node
/**
 * Brings a checkout to a runnable state, then gets out of the way.
 *
 * WHY THIS EXISTS
 * `npm run dev` used to require four things to have happened first, in order:
 * a hand-written `.env`, a build of `packages/shared` (the server imports it
 * from `dist/`), a built AudioWorklet bundle, and a migrated database with a
 * generated Prisma client. Miss any one and the failure arrived later as
 * something unrelated-looking — ERR_MODULE_NOT_FOUND, a Zod error, a silent
 * worklet, or `no such table: users`.
 *
 * Every one of those steps is mechanical and checkable, so they are done here.
 * Each is skipped when it is already up to date, which makes this cheap enough
 * to hang off `predev` / `prebuild` / `pretest` and forget about.
 *
 * It ends with a live query through the real Prisma client, so "preflight
 * passed" means the database genuinely answered — not that a file exists.
 *
 *   node scripts/preflight.mjs [--quiet] [--no-seed] [--skip-db]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEnv, loadEnvIntoProcess } from './ensure-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverRoot = resolve(repoRoot, 'apps/server');
const webRoot = resolve(repoRoot, 'apps/web');
const sharedRoot = resolve(repoRoot, 'packages/shared');

const args = new Set(process.argv.slice(2));
const quiet = args.has('--quiet');
const skipSeed = args.has('--no-seed');
/** The test suites build their own throwaway database, so they skip step 4. */
const skipDb = args.has('--skip-db');

const say = (message) => {
  if (!quiet) console.log(`[preflight] ${message}`);
};
const warn = (message) => console.warn(`[preflight] ${message}`);

const NODE = process.execPath;
const PRISMA_CLI = resolve(repoRoot, 'node_modules/prisma/build/index.js');
const TSC = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
const TSX = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');

/**
 * Always spawn the tool's JS entry point through this Node binary rather than
 * its `.bin` shim: the shims are `.cmd` files on Windows and need a shell,
 * which reintroduces quoting bugs for no benefit.
 */
function run(file, argv, { cwd = repoRoot, capture = false } = {}) {
  return execFileSync(NODE, [file, ...argv], {
    cwd,
    env: process.env,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
}

const mtimeOf = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);

/** Newest mtime under `dir`, so a build can be compared against its sources. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    const value = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (value > newest) newest = value;
  }
  return newest;
}

const steps = [];
const record = (name, detail) => {
  steps.push({ name, detail });
  say(`${name}: ${detail}`);
};

/* -- 1. Configuration ------------------------------------------------------ */

const envResult = ensureEnv({ quiet });
loadEnvIntoProcess();
record(
  'env',
  envResult.created
    ? '.env created with generated secrets'
    : envResult.changes.length > 0
      ? `.env repaired (${envResult.changes.length} change(s))`
      : '.env already valid',
);

/* -- 2. Shared package ----------------------------------------------------- */
/* The server and web app both import @sonder/shared from its compiled dist/,
 * so an unbuilt or stale dist is an immediate module-resolution failure. */

const sharedEntry = resolve(sharedRoot, 'dist/index.js');
if (mtimeOf(sharedEntry) < newestMtime(resolve(sharedRoot, 'src'))) {
  run(TSC, ['-p', 'tsconfig.json'], { cwd: sharedRoot });
  record('shared', 'compiled packages/shared');
} else {
  record('shared', 'dist up to date');
}

/* -- 3. AudioWorklet bundle ------------------------------------------------ */
/* A missing bundle is the worst failure in the product: addModule() rejects and
 * the call would fall back to untransformed audio. Never let it be absent. */

const workletOut = resolve(webRoot, 'public/worklets/voice-processor.js');
const workletSources = Math.max(
  mtimeOf(resolve(webRoot, 'src/voice/dsp-core.js')),
  mtimeOf(resolve(webRoot, 'src/voice/worklet-processor.js')),
);
if (mtimeOf(workletOut) < workletSources) {
  run(resolve(repoRoot, 'scripts/build-worklet.mjs'), []);
  record('worklet', 'rebuilt voice-processor.js');
} else {
  record('worklet', 'bundle up to date');
}

/* -- 4. Database ----------------------------------------------------------- */

if (skipDb) {
  say('ready — skipped database checks (--skip-db)');
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL ?? '';
const SCHEMA = 'prisma/schema.prisma';

if (!databaseUrl.startsWith('file:')) {
  warn(`DATABASE_URL is "${databaseUrl}" but Sonder uses SQLite.`);
  warn('Set DATABASE_URL="file:./dev.db" in .env (see docs/database.md).');
  process.exit(1);
}

/**
 * Generate the client only when it is missing or stale.
 *
 * Skipping the no-op case is not just about speed: on Windows a running server
 * holds `query_engine-windows.dll.node` open, and `prisma generate` replaces it
 * by rename, so an unconditional generate fails with EPERM whenever the dev
 * server is up in another terminal.
 */
function clientIsCurrent() {
  const generated = resolve(repoRoot, 'node_modules/.prisma/client/schema.prisma');
  if (!existsSync(generated)) return false;
  // Compare mtimes, not content: Prisma re-formats the schema when it copies it
  // into the client, so the two files are never byte-identical and a content
  // check would regenerate on every single run — reintroducing the EPERM above.
  return mtimeOf(generated) >= mtimeOf(resolve(serverRoot, SCHEMA));
}

if (!clientIsCurrent()) {
  run(PRISMA_CLI, ['generate', `--schema=${SCHEMA}`], { cwd: serverRoot, capture: true });
  record('prisma client', 'generated');
} else {
  record('prisma client', 'up to date');
}

const dbFile = resolve(serverRoot, 'prisma', databaseUrl.slice('file:'.length));
const createdDatabase = !existsSync(dbFile);

/** Opens the real client, runs `fn`, and always disconnects. */
async function withPrisma(fn) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/*
 * Apply committed migrations — but only when some are actually pending.
 *
 * `migrate deploy` is the right verb (it only applies migrations already in the
 * repo; it never invents or resets one), yet it takes a write lock even when
 * there is nothing to do. Running it unconditionally therefore failed with
 * "SQLite database error: database is locked" in the most ordinary situation
 * there is: `npm run dev` in one terminal and `npm run build` in another.
 *
 * Reading which migrations are already applied is a plain SELECT, and WAL lets
 * that run alongside a live server. So the lock is only ever taken when the
 * schema genuinely has to change.
 */
const migrationsDir = resolve(serverRoot, 'prisma/migrations');
const migrationsOnDisk = existsSync(migrationsDir)
  ? readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

let applied = [];
if (!createdDatabase) {
  try {
    applied = await withPrisma(async (prisma) => {
      const rows = await prisma.$queryRawUnsafe(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      );
      return rows.map((row) => row.migration_name);
    });
  } catch {
    // No _prisma_migrations table yet (or the file is unreadable). Either way,
    // treat everything as pending and let `migrate deploy` give the real error.
    applied = [];
  }
}

const pending = migrationsOnDisk.filter((name) => !applied.includes(name));

if (pending.length === 0) {
  record('database', `${databaseUrl} up to date (${applied.length} migration(s))`);
} else {
  try {
    run(PRISMA_CLI, ['migrate', 'deploy', `--schema=${SCHEMA}`], {
      cwd: serverRoot,
      capture: true,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error);
    if (/database is locked/i.test(detail)) {
      warn(`${pending.length} migration(s) to apply, but the database is locked.`);
      warn('Stop anything already using it (npm run dev / npm start) and re-run.');
    } else {
      warn(`migrate deploy failed: ${detail.split('\n').find(Boolean) ?? detail}`);
    }
    process.exit(1);
  }
  record(
    'database',
    createdDatabase
      ? `created ${databaseUrl} (${pending.length} migration(s))`
      : `applied ${pending.length} migration(s)`,
  );
}

/* -- 5. Prove it, and seed if empty ---------------------------------------- */
/* Importing the real client is the only check that means anything: it exercises
 * the generated engine, the URL, and the schema in one go. */

let userCount = null;
try {
  userCount = await withPrisma((prisma) => prisma.user.count());
} catch (error) {
  const message = String(error?.message ?? error);
  const code = error?.code;

  if (code === 'P2021' || /no such table/i.test(message)) {
    warn(`${dbFile} exists but has no schema.`);
    warn('run:  npm run db:migrate');
    process.exit(1);
  }
  if (/unable to open the database file|SQLITE_CANTOPEN|EACCES|EPERM/i.test(message)) {
    warn(`cannot open ${dbFile}`);
    warn('check the directory exists and is writable by this user.');
    process.exit(1);
  }
  warn(`database check failed: ${message.split('\n')[0]}`);
  process.exit(1);
}

let seeded = false;
if (userCount === 0 && !skipSeed) {
  run(TSX, ['prisma/seed.ts'], { cwd: serverRoot, capture: quiet });
  seeded = true;
  record('seed', 'seeded demo accounts and content');
} else if (userCount === 0) {
  record('seed', 'skipped (--no-seed); the database is empty');
} else {
  record('seed', `${userCount} user(s) already present`);
}

say(
  `ready — sqlite${createdDatabase ? ' (database created)' : ''}` +
    `${seeded ? ', seeded' : `, ${userCount} user(s)`}`,
);
