import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/sp/",
// which is not a valid filesystem path and silently breaks output tracing.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Next.js only auto-loads `.env` from its own project directory, but this repo
 * keeps one `.env` at the root so the server and the web app cannot drift.
 * Without this, NEXT_PUBLIC_API_URL set there is silently ignored and the app
 * falls back to localhost — which looks fine in dev and breaks in production.
 * Read before the config object is built, since NEXT_PUBLIC_* is inlined then.
 */
const rootEnv = resolve(repoRoot, '.env');
if (existsSync(rootEnv)) {
  for (const rawLine of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
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
    // The real environment, and apps/web/.env.local, still win.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * `standalone` emits .next/standalone — a self-contained server with only the
   * files it needs — which is what docker/Dockerfile.web copies into its runtime
   * image. It is opt-in because Next refuses to run `next start` against a
   * standalone build, so leaving it on unconditionally made the ordinary
   * `npm run build && npm start` path print a warning that the app was broken
   * when it was not. Docker sets BUILD_STANDALONE=true; nothing else needs it.
   */
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,
  // The Next root is apps/web but the lockfile is at the monorepo root; without
  // this, tracing picks the wrong root and omits workspace dependencies.
  outputFileTracingRoot: repoRoot,
  // The shared package ships TypeScript-compiled ESM; transpiling it here keeps
  // a single source of truth for types and Zod schemas across server and web.
  transpilePackages: ['@sonder/shared'],
  poweredByHeader: false,
  eslint: {
    // Lint is a separate step (npm run lint) so a style nit cannot block a build.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // getUserMedia is used by this origin only; deny everything else.
          {
            key: 'Permissions-Policy',
            value: 'microphone=(self), camera=(), geolocation=()',
          },
        ],
      },
      {
        // The worklet is generated at build time and fingerprint-free, so it
        // must not be cached across deploys or a stale DSP build would linger.
        source: '/worklets/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
