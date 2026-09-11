import { Router } from 'express';
import { z } from 'zod';
import {
  createConversationSchema,
  listMessagesSchema,
  searchMessagesSchema,
} from '@sonder/shared';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as messaging from './service.js';

export const messagingRouter = Router();

messagingRouter.use(requireAuth);

const idParam = z.object({ id: z.string().trim().min(1).max(64) });

messagingRouter.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    res.json({ conversations: await messaging.listConversations(userId) });
  }),
);

messagingRouter.get(
  '/conversations/unread-count',
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    res.json({ count: await messaging.totalUnread(userId) });
  }),
);

/**
 * Opening a chat is idempotent — the "Message" button on a profile just POSTs
 * here and navigates to whatever conversation comes back.
 */
messagingRouter.post(
  '/conversations',
  validateBody(createConversationSchema),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { conversation, created } = await messaging.getOrCreateConversation(
      userId,
      req.body.userId,
    );
    res.status(created ? 201 : 200).json({ conversation });
  }),
);

messagingRouter.get(
  '/conversations/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    await messaging.assertMembership(userId, req.params.id);
    res.json({ conversation: await messaging.loadConversation(req.params.id, userId) });
  }),
);

messagingRouter.get(
  '/conversations/:id/messages',
  validateParams(idParam),
  validateQuery(listMessagesSchema.omit({ conversationId: true })),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { cursor, limit } = req.query as unknown as { cursor?: string; limit: number };
    const page = await messaging.listMessages(userId, req.params.id, { cursor, limit });
    res.json(page);
  }),
);

messagingRouter.get(
  '/messages/search',
  validateQuery(searchMessagesSchema),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { q, conversationId, limit } = req.query as unknown as {
      q: string;
      conversationId?: string;
      limit: number;
    };
    const results = await messaging.searchMessages(userId, q, { conversationId, limit });
    res.json({ results });
  }),
);

messagingRouter.delete(
  '/messages/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    res.json({ message: await messaging.deleteMessage(userId, req.params.id) });
  }),
);
