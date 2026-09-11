#!/usr/bin/env node
/**
 * Serves the whole app on ONE port.
 *
 * WHY THIS EXISTS
 * Sonder is two processes — the Express/Socket.IO API and the Next web app — and
 * `npm start` binds them to two ports. That is fine behind Nginx (see
 * docker/nginx/sonder.conf) but not on a platform that routes exactly one port
 * per service, like Railway, Render or Fly. There, whichever process claimed
 * $PORT won and the other was simply unreachable: the public URL answered with
 * API JSON instead of the app.
 *
 * So this binds $PORT itself, keeps both children on loopback, and routes:
 *
 *      Railway $PORT
 *            │
 *      ┌─────▼───────────┐
 *      │   this script   │
 *      └──┬───────────┬──┘
 *   /api  │           │  everything else
 *  /socket.io         │  (pages, /_next, /media)
 *  /health            │
 *         ▼           ▼
 *     API :4000   Next :3000        ← 127.0.0.1 only, never exposed
 *
 * It is the same split Nginx does, so there is one routing rule to reason about
 * rather than two that can drift.
 *
 * A side benefit that matters: everything is same-origin, so there is no CORS
 * preflight and the refresh cookie can stay SameSite=Lax.
 *
 * THE PART THAT IS EASY TO GET WRONG
 * Socket.IO upgrades to a WebSocket, and an HTTP-only proxy drops that silently
 * — messaging and every call would fail while pages loaded fine. The 'upgrade'
 * handler below replays the handshake over a raw socket and pipes both
 * directions, which is what makes signalling work.
 *
 *   node scripts/serve.mjs [--skip-preflight]
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const PUBLIC_PORT = Number(process.env.PORT ?? 8080);
/** Loopback ports for the children. Overridable in case something else is there. */
const API_PORT = Number(process.env.API_INTERNAL_PORT ?? 4000);
const WEB_PORT = Number(process.env.WEB_INTERNAL_PORT ?? 3000);
const HOST = '127.0.0.1';

/** Prefixes that belong to the API. Everything else is the web app's. */
const API_PREFIXES = ['/api', '/socket.io', '/health'];

const log = (message) => console.log(`[serve] ${message}`);
const fail = (message) => console.error(`[serve] ${message}`);

const children = [];
let shuttingDown = false;

function spawnChild(name, argv, env) {
  const child = spawn(process.execPath, argv, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push({ name, child });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // One half of the app dying means the app is down. Exit so the platform
    // restarts the container rather than leaving half of it serving errors.
    fail(`${name} exited (${signal ?? `code ${code}`}); shutting down`);
    shutdown(code ?? 1);
  });
  child.on('error', (error) => {
    fail(`${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 400);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received`);
    shutdown(0);
  });
}

/* -- 1. Bring the checkout up to date ------------------------------------- */
/* Self-sufficient on purpose: `node scripts/serve.mjs` is a complete start
 * command, so a platform's start hook does not also have to remember preflight. */

if (!process.argv.includes('--skip-preflight')) {
  await new Promise((resolvePreflight) => {
    const child = spawn(process.execPath, [resolve(here, 'preflight.mjs'), '--quiet'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        fail('preflight failed; not starting');
        process.exit(code ?? 1);
      }
      resolvePreflight();
    });
  });
}

/* -- 2. Start both children on loopback ----------------------------------- */

/**
 * Teach the API which public origin it is behind.
 *
 * Same-origin is not a free pass: browsers still send `Origin` on same-origin
 * POSTs, so the API's allow-list has to contain the public URL or every login
 * is rejected as a CORS failure — and the dev-only loopback exemption is off in
 * production, which is correct and means this cannot be papered over.
 *
 * Rather than making that one more variable to get right, derive it from what
 * the platform already provides and log the result. Explicit beats magic, so an
 * origin only ever gets *added*; anything set in CORS_ORIGINS is kept.
 */
function publicOrigins() {
  const found = [];
  if (process.env.PUBLIC_URL) found.push(process.env.PUBLIC_URL);
  // Set automatically by Railway; the equivalents elsewhere can go in PUBLIC_URL.
  if (process.env.RAILWAY_PUBLIC_DOMAIN) found.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  return found.map((value) => value.replace(/\/$/, ''));
}

const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const discovered = publicOrigins().filter((origin) => !configuredOrigins.includes(origin));
const corsOrigins = [...configuredOrigins, ...discovered];

if (discovered.length > 0) {
  log(`added public origin(s) to CORS_ORIGINS: ${discovered.join(', ')}`);
} else if (configuredOrigins.length > 0) {
  log(`CORS_ORIGINS: ${configuredOrigins.join(', ')}`);
} else {
  fail('CORS_ORIGINS is empty and no public origin was discovered.');
  fail('Set CORS_ORIGINS (or PUBLIC_URL) to the address browsers use, or logins will fail.');
}

/*
 * NODE_ENV=production is forced here rather than asked of the host, because
 * setting it as a platform variable breaks the build instead: `npm install` then
 * omits devDependencies, and tsc, next and the Prisma CLI all live there. This
 * script *is* the production entry point, so it can simply assert it — the API
 * gets secure cookies and `trust proxy` (needed for per-client rate limiting
 * behind the platform's edge) without anyone configuring NODE_ENV anywhere.
 */
spawnChild('api', [resolve(repoRoot, 'apps/server/dist/index.js')], {
  NODE_ENV: 'production',
  PORT: String(API_PORT),
  HOST,
  ...(corsOrigins.length > 0 ? { CORS_ORIGINS: corsOrigins.join(',') } : {}),
});

// next-web.mjs forces NODE_ENV=production for `start` itself.
spawnChild('web', [resolve(here, 'next-web.mjs'), 'start', '-H', HOST], {
  WEB_PORT: String(WEB_PORT),
});

/* -- 3. Proxy ------------------------------------------------------------- */

const targetFor = (url) =>
  API_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))
    ? { port: API_PORT, name: 'api' }
    : { port: WEB_PORT, name: 'web' };

/**
 * Standard proxy hygiene. `x-forwarded-for` must be *appended* to, not replaced:
 * the server runs with Express `trust proxy: 1`, which walks the list from the
 * right and skips one hop — so appending the address we received from is what
 * makes `req.ip` the real client, and rate limiting per-client instead of global.
 */
function forwardedHeaders(req) {
  const existing = req.headers['x-forwarded-for'];
  const hop = req.socket.remoteAddress ?? '';
  return {
    ...req.headers,
    'x-forwarded-for': [existing, hop].filter(Boolean).join(', '),
    'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
    'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host ?? '',
  };
}

const server = createServer((req, res) => {
  const target = targetFor(req.url ?? '/');
  const upstream = httpRequest(
    { host: HOST, port: target.port, method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    // ECONNREFUSED here almost always means a child is still booting. Say which
    // one, because "502" alone sends people looking in the wrong process.
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' });
    }
    res.end(`${target.name} is not ready yet (${error.code ?? error.message})\n`);
  });

  req.pipe(upstream);
});

/* WebSocket upgrades — Socket.IO, and therefore all messaging and call
 * signalling, depend entirely on this path. */
server.on('upgrade', (req, clientSocket, head) => {
  const target = targetFor(req.url ?? '/');
  const upstream = connect(target.port, HOST, () => {
    const headers = forwardedHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined) lines.push(`${key}: ${one}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const drop = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${PUBLIC_PORT}`);
  log(`  ${API_PREFIXES.join(', ')} -> api  ${HOST}:${API_PORT}`);
  log(`  everything else          -> web  ${HOST}:${WEB_PORT}`);
});

server.on('error', (error) => {
  fail(`cannot bind ${PUBLIC_PORT}: ${error.message}`);
  shutdown(1);
});
