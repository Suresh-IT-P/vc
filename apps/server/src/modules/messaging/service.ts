import type { Conversation, ConversationParticipant, Message, Paginated } from '@sonder/shared';
import { prisma, isPrismaError, UNIQUE_VIOLATION } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { toMessage } from '../../lib/serialize.js';
import { isOnline } from '../../realtime/presence.js';
import { assertNotBlocked } from '../users/service.js';

const PARTICIPANT_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  lastSeenAt: true,
} as const;

/** Deterministic key so two users can only ever have one 1:1 thread. */
export function pairKeyFor(a: string, b: string): string {
  return [a, b].sort().join(':');
}

function toParticipant(
  row: {
    lastReadAt: Date | null;
    user: {
      id: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
      lastSeenAt: Date | null;
    };
  },
): ConversationParticipant {
  return {
    userId: row.user.id,
    username: row.user.username,
    displayName: row.user.displayName,
    avatarUrl: row.user.avatarUrl,
    isOnline: isOnline(row.user.id),
    lastSeenAt: row.user.lastSeenAt?.toISOString() ?? null,
    lastReadAt: row.lastReadAt?.toISOString() ?? null,
  };
}

/**
 * Membership check used by *every* messaging operation. Nothing downstream
 * trusts a conversationId that has not passed through here.
 */
export async function assertMembership(userId: string, conversationId: string) {
  const membership = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true, lastReadAt: true },
  });
  if (!membership) {
    // 404 rather than 403: a non-member should not be able to confirm that a
    // conversation id exists at all.
    throw notFound('That conversation does not exist.');
  }
  return membership;
}

export async function getPeerId(conversationId: string, userId: string): Promise<string> {
  const other = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: userId } },
    select: { userId: true },
  });
  if (!other) throw notFound('That conversation has no other participant.');
  return other.userId;
}

export async function getParticipantIds(conversationId: string): Promise<string[]> {
  const rows = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Idempotent: concurrent "open a chat" taps from both users resolve to the same
 * row because `pairKey` is unique and we recover from the race explicitly.
 */
export async function getOrCreateConversation(
  userId: string,
  peerId: string,
): Promise<{ conversation: Conversation; created: boolean }> {
  if (userId === peerId) {
    throw badRequest('You cannot start a conversation with yourself.');
  }

  const peer = await prisma.user.findUnique({
    where: { id: peerId },
    select: { id: true },
  });
  if (!peer) throw notFound('That account does not exist.');

  await assertNotBlocked(userId, peerId);

  const pairKey = pairKeyFor(userId, peerId);
  const existing = await prisma.conversation.findUnique({
    where: { pairKey },
    select: { id: true },
  });
  if (existing) {
    return { conversation: await loadConversation(existing.id, userId), created: false };
  }

  try {
    const created = await prisma.conversation.create({
      data: {
        pairKey,
        participants: {
          create: [{ userId }, { userId: peerId }],
        },
      },
      select: { id: true },
    });
    return { conversation: await loadConversation(created.id, userId), created: true };
  } catch (error) {
    if (isPrismaError(error, UNIQUE_VIOLATION)) {
      // Lost the race; the other side created it a moment ago.
      const row = await prisma.conversation.findUnique({
        where: { pairKey },
        select: { id: true },
      });
      if (row) return { conversation: await loadConversation(row.id, userId), created: false };
    }
    throw error;
  }
}

export async function loadConversation(
  conversationId: string,
  viewerId: string,
): Promise<Conversation> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
      messages: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
  });
  if (!row) throw notFound('That conversation does not exist.');

  const me = row.participants.find((p) => p.userId === viewerId);
  if (!me) throw notFound('That conversation does not exist.');

  const peerRow = row.participants.find((p) => p.userId !== viewerId);
  if (!peerRow) throw notFound('That conversation has no other participant.');

  const unreadCount = await countUnread(conversationId, viewerId, me.lastReadAt);

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    peer: toParticipant(peerRow),
    lastMessage: row.messages[0] ? toMessage(row.messages[0]) : null,
    unreadCount,
  };
}

function countUnread(conversationId: string, viewerId: string, lastReadAt: Date | null) {
  return prisma.message.count({
    where: {
      conversationId,
      senderId: { not: viewerId },
      deletedAt: null,
      ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
    },
  });
}

export async function listConversations(viewerId: string): Promise<Conversation[]> {
  const rows = await prisma.conversation.findMany({
    where: { participants: { some: { userId: viewerId } } },
    include: {
      participants: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
      messages: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });

  const result: Conversation[] = [];
  for (const row of rows) {
    const me = row.participants.find((p) => p.userId === viewerId);
    const peerRow = row.participants.find((p) => p.userId !== viewerId);
    if (!me || !peerRow) continue;
    result.push({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      peer: toParticipant(peerRow),
      lastMessage: row.messages[0] ? toMessage(row.messages[0]) : null,
      unreadCount: await countUnread(row.id, viewerId, me.lastReadAt),
    });
  }
  return result;
}

/**
 * Newest-first page. `nextCursor` is the id of the oldest message returned;
 * pass it back to walk further into history.
 */
export async function listMessages(
  viewerId: string,
  conversationId: string,
  options: { cursor?: string; limit: number },
): Promise<Paginated<Message>> {
  await assertMembership(viewerId, conversationId);

  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    // Return oldest-first so the client can append without reversing.
    items: page.map((row) => toMessage(row, { includeClientId: true })).reverse(),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export interface SendResult {
  message: Message;
  /** False when an identical clientId was already stored (a retried send). */
  created: boolean;
  peerId: string;
}

export async function sendMessage(
  senderId: string,
  input: { conversationId: string; body: string; clientId: string },
): Promise<SendResult> {
  await assertMembership(senderId, input.conversationId);
  const peerId = await getPeerId(input.conversationId, senderId);

  // Blocking is re-checked at send time, not just at conversation creation:
  // the block may have happened after the thread existed.
  await assertNotBlocked(senderId, peerId);

  const body = input.body.trim();
  if (!body) throw badRequest('Message cannot be empty.');

  // Idempotency: a client that retries after a socket drop must not double-post.
  const duplicate = await prisma.message.findUnique({
    where: {
      conversationId_clientId: {
        conversationId: input.conversationId,
        clientId: input.clientId,
      },
    },
  });
  if (duplicate) {
    return {
      message: toMessage(duplicate, { includeClientId: true }),
      created: false,
      peerId,
    };
  }

  try {
    const [row] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: input.conversationId,
          senderId,
          body,
          clientId: input.clientId,
          // If the recipient has a live socket the server hands it over
          // immediately, so it is delivered the moment it is stored.
          deliveredAt: isOnline(peerId) ? new Date() : null,
        },
      }),
      prisma.conversation.update({
        where: { id: input.conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);
    return {
      message: toMessage(row, { includeClientId: true }),
      created: true,
      peerId,
    };
  } catch (error) {
    if (isPrismaError(error, UNIQUE_VIOLATION)) {
      const row = await prisma.message.findUnique({
        where: {
          conversationId_clientId: {
            conversationId: input.conversationId,
            clientId: input.clientId,
          },
        },
      });
      if (row) {
        return {
          message: toMessage(row, { includeClientId: true }),
          created: false,
          peerId,
        };
      }
    }
    throw error;
  }
}

/**
 * Marks every inbound message in a conversation as delivered. Called when a
 * recipient's socket connects or joins, which is what makes the single tick
 * become a double tick after the recipient comes back online.
 */
export async function markDelivered(
  userId: string,
  conversationId: string,
): Promise<{ messageIds: string[]; deliveredAt: string }> {
  await assertMembership(userId, conversationId);
  const pending = await prisma.message.findMany({
    where: {
      conversationId,
      senderId: { not: userId },
      deliveredAt: null,
      deletedAt: null,
    },
    select: { id: true },
    take: 500,
  });
  if (pending.length === 0) {
    return { messageIds: [], deliveredAt: new Date().toISOString() };
  }
  const deliveredAt = new Date();
  await prisma.message.updateMany({
    where: { id: { in: pending.map((m) => m.id) } },
    data: { deliveredAt },
  });
  return {
    messageIds: pending.map((m) => m.id),
    deliveredAt: deliveredAt.toISOString(),
  };
}

/**
 * Marks inbound messages read up to and including `messageId` (or all of them).
 * Also advances the participant's `lastReadAt`, which is what the unread badge
 * is computed from.
 */
export async function markRead(
  userId: string,
  conversationId: string,
  messageId?: string,
): Promise<{ messageIds: string[]; readAt: string }> {
  await assertMembership(userId, conversationId);

  let boundary: Date | undefined;
  if (messageId) {
    const target = await prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { createdAt: true },
    });
    if (!target) throw notFound('That message is not in this conversation.');
    boundary = target.createdAt;
  }

  const unread = await prisma.message.findMany({
    where: {
      conversationId,
      senderId: { not: userId },
      readAt: null,
      deletedAt: null,
      ...(boundary ? { createdAt: { lte: boundary } } : {}),
    },
    select: { id: true },
    take: 1000,
  });

  const readAt = new Date();
  await prisma.$transaction([
    ...(unread.length
      ? [
          prisma.message.updateMany({
            where: { id: { in: unread.map((m) => m.id) } },
            // Reading implies delivery; a message can be read without the
            // delivered event ever having landed (offline -> open app).
            data: { readAt, deliveredAt: readAt },
          }),
        ]
      : []),
    prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: boundary ?? readAt },
    }),
  ]);

  return { messageIds: unread.map((m) => m.id), readAt: readAt.toISOString() };
}

export async function searchMessages(
  viewerId: string,
  query: string,
  options: { conversationId?: string; limit: number },
): Promise<Message[]> {
  const q = query.trim();
  if (!q) return [];

  if (options.conversationId) {
    await assertMembership(viewerId, options.conversationId);
  }

  const rows = await prisma.message.findMany({
    where: {
      deletedAt: null,
      body: { contains: q },
      conversation: options.conversationId
        ? { id: options.conversationId }
        : { participants: { some: { userId: viewerId } } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit,
  });
  return rows.map((row) => toMessage(row));
}

export async function deleteMessage(userId: string, messageId: string): Promise<Message> {
  const row = await prisma.message.findUnique({ where: { id: messageId } });
  if (!row) throw notFound('That message does not exist.');
  if (row.senderId !== userId) throw forbidden('You can only delete your own messages.');

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), body: '' },
  });
  return toMessage(updated);
}

/** Total unread across every conversation, for the nav badge. */
export async function totalUnread(viewerId: string): Promise<number> {
  const memberships = await prisma.conversationParticipant.findMany({
    where: { userId: viewerId },
    select: { conversationId: true, lastReadAt: true },
  });
  let total = 0;
  for (const m of memberships) {
    total += await countUnread(m.conversationId, viewerId, m.lastReadAt);
  }
  return total;
}
