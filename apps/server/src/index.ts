import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';
import { env, hasTurn, isProd } from './env.js';
import { logger } from './lib/logger.js';
import { pruneSessions } from './modules/auth/service.js';
import { reapOrphanedCalls } from './modules/calls/service.js';
import { shutdownCallRegistry } from './modules/calls/registry.js';
import { createSocketServer, shutdownSocketServer } from './realtime/index.js';
import { resetPresence } from './realtime/presence.js';

const log = logger.child('boot');

async function main() {
  await connectDb();

  // A fresh process cannot own live sockets or calls, so anything the database
  // still thinks is live is debris from an unclean shutdown.
  await resetPresence();
  const reaped = await reapOrphanedCalls();
  if (reaped > 0) log.warn(`marked ${reaped} orphaned call(s) as failed`);

  const app = createApp();
  const httpServer = createServer(app);
  createSocketServer(httpServer);

  const sessionSweeper = setInterval(
    () => {
      void pruneSessions().catch((error) => log.warn('session prune failed', error));
    },
    6 * 60 * 60 * 1000,
  );
  sessionSweeper.unref();

  await new Promise<void>((resolve) => {
    httpServer.listen(env.PORT, env.HOST, resolve);
  });

  log.info(`listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  log.info(
    `CORS origins: ${env.CORS_ORIGINS.join(', ')}` +
      // Say so explicitly: a log listing one origin while the server accepts
      // any loopback port would be actively misleading during debugging.
      (isProd ? '' : ' (plus any localhost port, development only)'),
  );
  log.info(
    hasTurn
      ? 'TURN relay configured'
      : 'No TURN relay configured — calls will fail for peers behind symmetric NAT',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);

    clearInterval(sessionSweeper);
    shutdownCallRegistry();
    await shutdownSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await resetPresence();
    await disconnectDb();

    log.info('bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', error);
    // An unknown-state process serving calls is worse than a restarted one.
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  log.error('failed to start', error);
  process.exit(1);
});
