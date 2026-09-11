import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';

const log = logger.child('presence');

/**
 * Authoritative online state for this process.
 *
 * A user is online when they hold at least one live socket, so we count sockets
 * rather than storing a boolean: opening a second tab must not be able to mark
 * someone offline when it closes. `User.isOnline` in the database is a
 * denormalised cache of this map, kept up to date so that a cold page load can
 * render presence before any socket connects.
 *
 * SCALING NOTE: this is process-local. Running more than one Node instance
 * requires moving the map to Redis (and using the Socket.IO Redis adapter) or
 * users on different instances will see each other as permanently offline.
 * See docs/deployment.md.
 */
const socketsByUser = new Map<string, Set<string>>();
const userBySocket = new Map<string, string>();

export interface PresenceTransition {
  userId: string;
  /** True only for the first socket a user opens / the last one they close. */
  changed: boolean;
  lastSeenAt: Date;
}

export async function markOnline(
  userId: string,
  socketId: string,
): Promise<PresenceTransition> {
  let set = socketsByUser.get(userId);
  const changed = !set || set.size === 0;
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  set.add(socketId);
  userBySocket.set(socketId, userId);

  const lastSeenAt = new Date();
  if (changed) {
    await touch(userId, true, lastSeenAt);
    log.debug(`online ${userId}`);
  }
  return { userId, changed, lastSeenAt };
}

export async function markOffline(socketId: string): Promise<PresenceTransition | null> {
  const userId = userBySocket.get(socketId);
  if (!userId) return null;
  userBySocket.delete(socketId);

  const set = socketsByUser.get(userId);
  set?.delete(socketId);
  const changed = !set || set.size === 0;
  if (changed) socketsByUser.delete(userId);

  const lastSeenAt = new Date();
  if (changed) {
    await touch(userId, false, lastSeenAt);
    log.debug(`offline ${userId}`);
  }
  return { userId, changed, lastSeenAt };
}

async function touch(userId: string, isOnline: boolean, lastSeenAt: Date) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { isOnline, lastSeenAt },
    });
  } catch (error) {
    // A deleted account disconnecting is not worth failing the socket teardown.
    log.warn(`could not persist presence for ${userId}`, error);
  }
}

export function isOnline(userId: string): boolean {
  return (socketsByUser.get(userId)?.size ?? 0) > 0;
}

export function socketIdsFor(userId: string): string[] {
  return [...(socketsByUser.get(userId) ?? [])];
}

export function onlineUserIds(): string[] {
  return [...socketsByUser.keys()];
}

export function connectionCount(userId: string): number {
  return socketsByUser.get(userId)?.size ?? 0;
}

/**
 * Clears every in-memory entry and resets the database cache. Called on boot
 * (a fresh process cannot have live sockets, so any `isOnline: true` row is a
 * leftover from an unclean shutdown) and by the test harness.
 */
export async function resetPresence(): Promise<void> {
  socketsByUser.clear();
  userBySocket.clear();
  try {
    await prisma.user.updateMany({
      where: { isOnline: true },
      data: { isOnline: false },
    });
  } catch (error) {
    log.warn('could not reset stale presence flags', error);
  }
}
