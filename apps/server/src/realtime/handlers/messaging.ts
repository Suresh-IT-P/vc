import {
  createConversationSchema,
  markReadSchema,
  sendMessageSchema,
  typingSchema,
  TYPING_TIMEOUT_MS,
} from '@sonder/shared';
import { z } from 'zod';
import { parseOrThrow } from '../../middleware/validate.js';
import * as messaging from '../../modules/messaging/service.js';
import * as presence from '../presence.js';
import { prisma } from '../../db.js';
import { safely, withAck } from '../ack.js';
import {
  bucketsFor,
  conversationRoom,
  userRoom,
  type SonderServer,
  type SonderSocket,
} from '../index.js';

/**
 * Typing indicators are pure ephemeral state: never persisted, and auto-expired
 * server-side so a client that crashes mid-typing does not leave a permanent
 * "Alex is typing…" on someone's screen.
 */
const typingTimers = new Map<string, NodeJS.Timeout>();

function typingKey(conversationId: string, userId: string) {
  return `${conversationId}:${userId}`;
}

export function registerMessagingHandlers(io: SonderServer, socket: SonderSocket) {
  const { userId } = socket.data;

  socket.on(
    'conversation:create',
    withAck('conversation:create', async (payload) => {
      const input = parseOrThrow(createConversationSchema, payload);
      const { conversation, created } = await messaging.getOrCreateConversation(
        userId,
        input.userId,
      );
      await socket.join(conversationRoom(conversation.id));

      if (created) {
        // Tell the other participant so their inbox updates live, rendered from
        // *their* perspective (peer = us).
        const theirView = await messaging.loadConversation(conversation.id, input.userId);
        io.to(userRoom(input.userId)).emit('conversation:created', theirView);
      }
      return conversation;
    }),
  );

  socket.on(
    'conversation:join',
    withAck('conversation:join', async (payload) => {
      const input = parseOrThrow(typingSchema, payload);
      // Membership is verified before the socket is allowed into the room, so a
      // client cannot subscribe to a stranger's messages by guessing an id.
      await messaging.assertMembership(userId, input.conversationId);
      await socket.join(conversationRoom(input.conversationId));

      const delivered = await messaging.markDelivered(userId, input.conversationId);
      if (delivered.messageIds.length > 0) {
        const peerId = await messaging.getPeerId(input.conversationId, userId);
        io.to(userRoom(peerId)).emit('message:delivered', {
          conversationId: input.conversationId,
          messageIds: delivered.messageIds,
          deliveredAt: delivered.deliveredAt,
          userId,
        });
      }
      return { conversationId: input.conversationId };
    }),
  );

  socket.on(
    'conversation:leave',
    safely('conversation:leave', async (payload) => {
      const input = parseOrThrow(typingSchema, payload);
      await socket.leave(conversationRoom(input.conversationId));
      stopTyping(io, input.conversationId, userId);
    }),
  );

  socket.on(
    'message:send',
    withAck('message:send', async (payload) => {
      bucketsFor(socket).messages.take();
      const input = parseOrThrow(sendMessageSchema, payload);

      const { message, created, peerId } = await messaging.sendMessage(userId, input);

      // Sending implicitly stops the typing indicator.
      stopTyping(io, input.conversationId, userId);

      if (created) {
        // The recipient's other devices and any open conversation view.
        io.to(userRoom(peerId)).emit('message:new', message);
        // The sender's *other* tabs, so a message typed on desktop shows on mobile.
        socket.to(userRoom(userId)).emit('message:new', message);

        if (!presence.isOnline(peerId)) {
          await notifyMissedMessage(peerId, userId, input.conversationId, message.body);
        }
      }
      return message;
    }),
  );

  socket.on(
    'message:read',
    withAck('message:read', async (payload) => {
      const input = parseOrThrow(markReadSchema, payload);
      const result = await messaging.markRead(userId, input.conversationId, input.messageId);

      if (result.messageIds.length > 0) {
        const peerId = await messaging.getPeerId(input.conversationId, userId);
        io.to(userRoom(peerId)).emit('message:read', {
          conversationId: input.conversationId,
          messageIds: result.messageIds,
          readAt: result.readAt,
          userId,
        });
      }
      // Own tabs, so the unread badge clears everywhere.
      socket.to(userRoom(userId)).emit('message:read', {
        conversationId: input.conversationId,
        messageIds: result.messageIds,
        readAt: result.readAt,
        userId,
      });
      return result;
    }),
  );

  socket.on(
    'typing:start',
    safely('typing:start', async (payload) => {
      // Dropped rather than errored: a lost typing frame is invisible to users.
      if (!bucketsFor(socket).typing.tryTake()) return;
      const input = parseOrThrow(typingSchema, payload);
      await messaging.assertMembership(userId, input.conversationId);

      const peerId = await messaging.getPeerId(input.conversationId, userId);
      io.to(userRoom(peerId)).emit('typing:start', {
        conversationId: input.conversationId,
        userId,
        isTyping: true,
      });

      const key = typingKey(input.conversationId, userId);
      clearTimeout(typingTimers.get(key));
      typingTimers.set(
        key,
        setTimeout(() => stopTyping(io, input.conversationId, userId), TYPING_TIMEOUT_MS),
      );
    }),
  );

  socket.on(
    'typing:stop',
    safely('typing:stop', async (payload) => {
      const input = parseOrThrow(typingSchema, payload);
      await messaging.assertMembership(userId, input.conversationId);
      stopTyping(io, input.conversationId, userId);
    }),
  );

  socket.on(
    'presence:subscribe',
    withAck('presence:subscribe', async (payload) => {
      const input = parseOrThrow(
        z.object({ userIds: z.array(z.string().min(1).max(64)).max(100) }),
        payload,
      );
      const rows = await prisma.user.findMany({
        where: { id: { in: input.userIds } },
        select: { id: true, lastSeenAt: true },
      });
      return rows.map((row) => ({
        userId: row.id,
        state: presence.isOnline(row.id) ? ('online' as const) : ('offline' as const),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      }));
    }),
  );

  socket.on('disconnect', () => {
    // Clear any typing state this socket's user left behind.
    for (const [key, timer] of typingTimers) {
      if (key.endsWith(`:${userId}`)) {
        clearTimeout(timer);
        typingTimers.delete(key);
        const conversationId = key.slice(0, key.length - userId.length - 1);
        void emitTypingStop(io, conversationId, userId);
      }
    }
  });
}

function stopTyping(io: SonderServer, conversationId: string, userId: string) {
  const key = typingKey(conversationId, userId);
  const timer = typingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    typingTimers.delete(key);
  }
  void emitTypingStop(io, conversationId, userId);
}

async function emitTypingStop(io: SonderServer, conversationId: string, userId: string) {
  try {
    const peerId = await messaging.getPeerId(conversationId, userId);
    io.to(userRoom(peerId)).emit('typing:stop', {
      conversationId,
      userId,
      isTyping: false,
    });
  } catch {
    // Conversation gone; nothing to clear.
  }
}

async function notifyMissedMessage(
  recipientId: string,
  senderId: string,
  conversationId: string,
  body: string,
) {
  const { createNotification } = await import('../../modules/social/service.js');
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { displayName: true },
  });
  await createNotification({
    userId: recipientId,
    actorId: senderId,
    kind: 'MESSAGE',
    text: `${sender?.displayName ?? 'Someone'} sent you a message: ${body.slice(0, 80)}`,
    href: `/messages/${conversationId}`,
  });
}
