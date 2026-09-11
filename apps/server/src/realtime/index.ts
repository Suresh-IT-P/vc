import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@sonder/shared';
import { env, isAllowedOrigin } from '../env.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { prisma } from '../db.js';
import * as presence from './presence.js';
import { initCallRegistry } from '../modules/calls/registry.js';
import { createBuckets, type SocketBuckets } from './throttle.js';
import { registerMessagingHandlers } from './handlers/messaging.js';
import { registerCallHandlers } from './handlers/calling.js';

const log = logger.child('socket');

export type SonderServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export type SonderSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** Per-socket state that must not live on the (typed) SocketData payload. */
export const socketBuckets = new WeakMap<SonderSocket, SocketBuckets>();

export function bucketsFor(socket: SonderSocket): SocketBuckets {
  let buckets = socketBuckets.get(socket);
  if (!buckets) {
    buckets = createBuckets();
    socketBuckets.set(socket, buckets);
  }
  return buckets;
}

/** Every socket of a user joins this room, so we can address a person not a tab. */
export const userRoom = (userId: string) => `user:${userId}`;
export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;

let ioRef: SonderServer | null = null;

export function getIo(): SonderServer {
  if (!ioRef) throw new Error('Socket.IO server has not been created yet');
  return ioRef;
}

/** Addresses a person across all their devices. Used by the call registry. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  ioRef?.to(userRoom(userId)).emit(event as keyof ServerToClientEvents, payload as never);
}

function readHandshakeToken(socket: SonderSocket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token) return auth.token;

  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }

  // Cookie fallback for same-origin deployments behind Nginx.
  const cookie = socket.handshake.headers.cookie;
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'sonder_at') return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export function createSocketServer(httpServer: HttpServer): SonderServer {
  const io: SonderServer = new Server(httpServer, {
    cors: {
      // Same allow-list as the HTTP API, including the dev-only loopback
      // exemption, so a non-default web port does not break sockets while
      // leaving HTTP working (which would look like a messaging bug).
      origin(origin, callback) {
        if (!origin || isAllowedOrigin(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    },
    // Calls need signalling to survive a brief network blip; these are tighter
    // than the defaults so a dead peer is noticed within a few seconds.
    pingInterval: 20_000,
    pingTimeout: 20_000,
    // SDP offers can be large; the default 1 MB is plenty but be explicit.
    maxHttpBufferSize: 1_000_000,
    transports: ['websocket', 'polling'],
  });

  ioRef = io;

  /**
   * Authentication happens once, at handshake time. An unauthenticated socket is
   * never allowed to connect at all, so no handler has to re-check identity —
   * only authorisation.
   */
  io.use(async (socket, next) => {
    try {
      const token = readHandshakeToken(socket as SonderSocket);
      if (!token) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }
      const payload = verifyAccessToken(token);

      // Confirm the account still exists; a deleted user must not keep a live
      // socket just because their JWT has not expired yet.
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, username: true },
      });
      if (!user) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }

      socket.data.userId = user.id;
      socket.data.username = user.username;
      socket.data.sessionId = payload.sid ?? null;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    void onConnection(io, socket as SonderSocket);
  });

  // Let the call state machine reach clients without importing Socket.IO.
  initCallRegistry({
    toUser: emitToUser,
    isOnline: presence.isOnline,
  });

  log.info('socket server ready');
  return io;
}

async function onConnection(io: SonderServer, socket: SonderSocket) {
  const { userId, username } = socket.data;
  socket.join(userRoom(userId));
  socketBuckets.set(socket, createBuckets());

  log.debug(`connected ${username} (${socket.id})`);

  registerMessagingHandlers(io, socket);
  registerCallHandlers(io, socket);

  socket.on('disconnect', (reason) => {
    void onDisconnect(io, socket, reason);
  });

  try {
    const transition = await presence.markOnline(userId, socket.id);
    if (transition.changed) {
      await broadcastPresence(io, userId, 'online', transition.lastSeenAt);
    }
    // Anything sent while this user was away is now delivered.
    await deliverPendingFor(io, userId);
  } catch (error) {
    log.error('connection setup failed', error);
  }
}

async function onDisconnect(io: SonderServer, socket: SonderSocket, reason: string) {
  const { userId, username } = socket.data;
  log.debug(`disconnected ${username} (${reason})`);

  try {
    const transition = await presence.markOffline(socket.id);
    if (transition?.changed) {
      // Losing the socket destroys the RTCPeerConnection, so any live call this
      // user was on is over. Handled before presence so the peer sees the call
      // end rather than a silent freeze.
      const { handleUserDisconnected } = await import('../modules/calls/registry.js');
      await handleUserDisconnected(userId);
      await broadcastPresence(io, userId, 'offline', transition.lastSeenAt);
    }
  } catch (error) {
    log.error('disconnect cleanup failed', error);
  }
}

/**
 * Presence is broadcast to the people who can actually see it: anyone sharing a
 * conversation with this user. Broadcasting globally would leak the whole user
 * list to every connected client.
 */
async function broadcastPresence(
  io: SonderServer,
  userId: string,
  state: 'online' | 'offline',
  lastSeenAt: Date,
) {
  const peers = await prisma.conversationParticipant.findMany({
    where: {
      userId: { not: userId },
      conversation: { participants: { some: { userId } } },
    },
    select: { userId: true },
  });

  const payload = {
    userId,
    state,
    lastSeenAt: lastSeenAt.toISOString(),
  };
  const event = state === 'online' ? 'user:online' : 'user:offline';

  const seen = new Set<string>();
  for (const peer of peers) {
    if (seen.has(peer.userId)) continue;
    seen.add(peer.userId);
    io.to(userRoom(peer.userId)).emit(event, payload);
  }
  // Echo to the user's own other tabs so their UI agrees with itself.
  io.to(userRoom(userId)).emit(event, payload);
}

/**
 * Flips every message sent to this user while they were away to "delivered",
 * and tells the senders. This is what turns a single tick into a double tick
 * when the recipient comes back online.
 */
async function deliverPendingFor(io: SonderServer, userId: string) {
  const pending = await prisma.message.findMany({
    where: { senderId: { not: userId }, deliveredAt: null, deletedAt: null,
      conversation: { participants: { some: { userId } } } },
    select: { id: true, conversationId: true, senderId: true },
    take: 500,
  });
  if (pending.length === 0) return;

  const deliveredAt = new Date();
  await prisma.message.updateMany({
    where: { id: { in: pending.map((m) => m.id) } },
    data: { deliveredAt },
  });

  const byConversation = new Map<string, { ids: string[]; senders: Set<string> }>();
  for (const message of pending) {
    let entry = byConversation.get(message.conversationId);
    if (!entry) {
      entry = { ids: [], senders: new Set() };
      byConversation.set(message.conversationId, entry);
    }
    entry.ids.push(message.id);
    entry.senders.add(message.senderId);
  }

  for (const [conversationId, entry] of byConversation) {
    const payload = {
      conversationId,
      messageIds: entry.ids,
      deliveredAt: deliveredAt.toISOString(),
      userId,
    };
    for (const senderId of entry.senders) {
      io.to(userRoom(senderId)).emit('message:delivered', payload);
    }
  }
}

export async function shutdownSocketServer(): Promise<void> {
  if (!ioRef) return;
  await new Promise<void>((resolve) => ioRef?.close(() => resolve()));
  ioRef = null;
}
