#!/usr/bin/env node
/**
 * Runs a command with the repo-root .env loaded.
 *
 * The Prisma CLI only auto-loads `.env` from its own cwd (apps/server), but we
 * keep a single .env at the repo root so the web app and the server cannot
 * drift apart. This shim bridges the two without adding a dependency.
 *
 *   node scripts/with-env.mjs prisma migrate dev
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Minimal dotenv parser: KEY=VALUE, optional quotes, `#` comments. */
function loadEnvFile(file) {
  if (!existsSync(file)) return 0;
  let loaded = 0;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment always wins over the file.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}

// Nearest-first: a package-local .env can override the shared root one.
loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(repoRoot, '.env'));

if (!existsSync(resolve(repoRoot, '.env'))) {
  console.warn(
    '[with-env] No .env at repo root. Copy .env.example to .env first:\n' +
      '           cp .env.example .env',
  );
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('[with-env] usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(1);
}

// On Windows the targets are .cmd shims, which need a shell. Passing a single
// command string rather than (command, args[]) avoids Node's DEP0190 warning
// about unescaped arguments; anything containing whitespace is quoted here.
const needsShell = process.platform === 'win32';
const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

const child = needsShell
  ? spawn([command, ...args].map(quote).join(' '), {
      stdio: 'inherit',
      shell: true,
      env: process.env,
    })
  : spawn(command, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error(`[with-env] failed to start "${command}":`, err.message);
  process.exit(1);
});
