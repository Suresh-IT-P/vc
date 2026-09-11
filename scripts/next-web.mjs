#!/usr/bin/env node
/**
 * Starts Next.js on WEB_PORT (default 3000).
 *
 * WHY THIS EXISTS
 * Two problems, both of which showed up in practice:
 *
 *   1. `next dev -p 3000` hard-codes the port, so a machine already running
 *      something on 3000 needs a source edit to get the app up.
 *   2. Next honours the `PORT` environment variable when `-p` is omitted — but
 *      the repo-root `.env` sets `PORT=4000` for the *API*. Inheriting that
 *      would silently start the web app on the API's port and collide. So PORT
 *      is deleted from the child environment and set from WEB_PORT alone.
 *
 * `npm:$-` style variable interpolation is not portable to Windows `cmd`, which
 * is why this is a script rather than a clever package.json line.
 *
 *   node scripts/next-web.mjs dev|start [extra next args...]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = resolve(repoRoot, 'apps/web');
const nextCli = resolve(repoRoot, 'node_modules/next/dist/bin/next');

const [command = 'dev', ...rest] = process.argv.slice(2);
if (!['dev', 'start'].includes(command)) {
  console.error(`[next-web] expected "dev" or "start", got "${command}"`);
  process.exit(1);
}

const port = process.env.WEB_PORT ?? '3000';
const env = { ...process.env, PORT: port };

const child = spawn(process.execPath, [nextCli, command, '-p', port, ...rest], {
  cwd: webRoot,
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (error) => {
  console.error(`[next-web] failed to start next: ${error.message}`);
  process.exit(1);
});
