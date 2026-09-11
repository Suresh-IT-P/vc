/**
 * PM2 process definitions for a bare-metal (non-Docker) deployment.
 *
 *   npm run build
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup
 *
 * IMPORTANT — the API is deliberately `fork` mode with a single instance, not
 * `cluster`. Presence and the call registry are in-process maps (see
 * src/realtime/presence.ts and src/modules/calls/registry.ts), so a second
 * instance would have its own copy: users on different workers would see each
 * other as permanently offline and could never connect a call. Scaling out
 * requires moving both to Redis plus the Socket.IO Redis adapter first — see
 * docs/deployment.md.
 *
 * The Next.js app has no such state and can be clustered freely.
 */
module.exports = {
  apps: [
    {
      name: 'sonder-server',
      cwd: './apps/server',
      script: 'dist/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      // Long-lived WebSockets need time to drain on redeploy.
      kill_timeout: 10_000,
      wait_ready: false,
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
      error_file: './logs/server-error.log',
      out_file: './logs/server-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'sonder-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      exec_mode: 'cluster',
      instances: 2,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
      error_file: './logs/web-error.log',
      out_file: './logs/web-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
