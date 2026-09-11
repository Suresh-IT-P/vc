import type { Message as MessageRow, User as UserRow } from '@prisma/client';
import type {
  Message,
  MessageStatus,
  PublicUser,
  SelfUser,
  CallPeer,
} from '@sonder/shared';
import { isOnline } from '../realtime/presence.js';

type UserLike = Pick<
  UserRow,
  'id' | 'username' | 'displayName' | 'avatarUrl' | 'bio' | 'isOnline' | 'lastSeenAt'
>;

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * Presence comes from the live socket registry, not the `isOnline` column: the
 * column is a cache that can be stale after an unclean shutdown, and the
 * registry is what actually decides whether a call can be placed.
 */
export function toPublicUser(user: UserLike): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    isOnline: isOnline(user.id),
    lastSeenAt: iso(user.lastSeenAt),
  };
}

export function toSelfUser(
  user: UserLike & { email: string; createdAt: Date },
  counts?: { posts: number; followers: number; following: number },
): SelfUser {
  return {
    ...toPublicUser(user),
    email: user.email,
    createdAt: user.createdAt.toISOString(),
    ...(counts ? { counts } : {}),
  };
}

export function toCallPeer(user: UserLike): CallPeer {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * Derives the delivery status a client should render.
 *
 * `read` implies `delivered`, and a persisted row is always at least `sent` —
 * `sending` and `failed` exist only in optimistic client state and are never
 * produced here.
 */
export function messageStatus(row: Pick<MessageRow, 'deliveredAt' | 'readAt'>): MessageStatus {
  if (row.readAt) return 'read';
  if (row.deliveredAt) return 'delivered';
  return 'sent';
}

export function toMessage(
  row: MessageRow,
  options: { includeClientId?: boolean } = {},
): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    body: row.deletedAt ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: iso(row.editedAt),
    deletedAt: iso(row.deletedAt),
    status: messageStatus(row),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(row.readAt),
    ...(options.includeClientId && row.clientId ? { clientId: row.clientId } : {}),
  };
}
