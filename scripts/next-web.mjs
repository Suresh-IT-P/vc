#!/usr/bin/env node
/**
 * Runs a Next.js command with an environment Next can actually work with.
 *
 * It fixes two problems, both of which showed up in practice.
 *
 * 1. NODE_ENV LEAKING IN FROM THE HOST
 *    Each Next command has exactly one valid NODE_ENV, and Next sets it itself
 *    when nothing else has — but an ambient value wins, and a wrong one is
 *    lethal in a way that does not look related. `NODE_ENV=development` during
 *    `next build` aborts static generation with:
 *
 *        Error: <Html> should not be imported outside of pages/_document.
 *        Export encountered an error on /_error: /404, exiting the build.
 *
 *    ...which points at the Pages Router in an App Router project and sends you
 *    looking for an import that does not exist. This happened on a Railway
 *    deploy, from NODE_ENV=development being pasted into the host's variables
 *    panel along with the rest of .env.example. So the value is forced here per
 *    command rather than inherited.
 *
 * 2. PORT COLLISION WITH THE API
 *    `next dev -p 3000` hard-codes the port, so a machine already using 3000
 *    needs a source edit. Next honours `PORT` when `-p` is omitted — but the
 *    repo-root .env sets `PORT=4000` for the *API*, and inheriting that would
 *    silently start the web app on the API's port. PORT is therefore replaced
 *    with WEB_PORT (default 3000) rather than passed through.
 *
 * `npm:$VAR` interpolation is not portable to Windows `cmd`, which is why this
 * is a script and not a clever package.json line.
 *
 *   node scripts/next-web.mjs dev|build|start [extra next args...]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = resolve(repoRoot, 'apps/web');
const nextCli = resolve(repoRoot, 'node_modules/next/dist/bin/next');

/** The only NODE_ENV each command is valid under. */
const NODE_ENV_FOR = {
  dev: 'development',
  build: 'production',
  start: 'production',
};

const [command, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(NODE_ENV_FOR, command ?? '')) {
  console.error(
    `[next-web] expected one of ${Object.keys(NODE_ENV_FOR).join(', ')}, got "${command ?? ''}"`,
  );
  process.exit(1);
}

const env = { ...process.env, NODE_ENV: NODE_ENV_FOR[command] };
if (process.env.NODE_ENV && process.env.NODE_ENV !== NODE_ENV_FOR[command]) {
  console.warn(
    `[next-web] overriding inherited NODE_ENV="${process.env.NODE_ENV}" with ` +
      `"${NODE_ENV_FOR[command]}" for \`next ${command}\``,
  );
}

const argv = [nextCli, command, ...rest];

// Only the long-running commands bind a port; `next build` takes none.
if (command !== 'build') {
  const port = process.env.WEB_PORT ?? '3000';
  env.PORT = port;
  argv.push('-p', port);
}

const child = spawn(process.execPath, argv, { cwd: webRoot, stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (error) => {
  console.error(`[next-web] failed to start next: ${error.message}`);
  process.exit(1);
});
