import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as social from './service.js';

export const socialRouter = Router();

socialRouter.use(requireAuth);

const idParam = z.object({ id: z.string().trim().min(1).max(64) });
const usernameParam = z.object({ username: z.string().trim().min(1).max(40) });

socialRouter.get(
  '/feed',
  asyncHandler(async (req, res) => {
    res.json({ posts: await social.listFeed(authOf(req).userId) });
  }),
);

socialRouter.get(
  '/explore',
  asyncHandler(async (req, res) => {
    res.json({ posts: await social.listExplore(authOf(req).userId) });
  }),
);

socialRouter.get(
  '/reels',
  asyncHandler(async (_req, res) => {
    res.json({ reels: await social.listReels() });
  }),
);

socialRouter.get(
  '/stories',
  asyncHandler(async (_req, res) => {
    res.json({ stories: await social.listStories() });
  }),
);

socialRouter.get(
  '/saved',
  asyncHandler(async (req, res) => {
    res.json({ posts: await social.listSaved(authOf(req).userId) });
  }),
);

socialRouter.get(
  '/users/:username/posts',
  validateParams(usernameParam),
  asyncHandler(async (req, res) => {
    res.json({
      posts: await social.listUserPosts(req.params.username, authOf(req).userId),
    });
  }),
);

socialRouter.post(
  '/posts/:id/like',
  validateParams(idParam),
  validateBody(z.object({ liked: z.boolean() })),
  asyncHandler(async (req, res) => {
    res.json(await social.setLike(authOf(req).userId, req.params.id, req.body.liked));
  }),
);

socialRouter.post(
  '/posts/:id/save',
  validateParams(idParam),
  validateBody(z.object({ saved: z.boolean() })),
  asyncHandler(async (req, res) => {
    res.json(await social.setSaved(authOf(req).userId, req.params.id, req.body.saved));
  }),
);

socialRouter.get(
  '/posts/:id/comments',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    res.json({ comments: await social.listComments(req.params.id) });
  }),
);

socialRouter.post(
  '/posts/:id/comments',
  validateParams(idParam),
  validateBody(z.object({ body: z.string().trim().min(1).max(600) })),
  asyncHandler(async (req, res) => {
    const comment = await social.addComment(
      authOf(req).userId,
      req.params.id,
      req.body.body,
    );
    res.status(201).json({ comment });
  }),
);

socialRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    res.json({ notifications: await social.listNotifications(authOf(req).userId) });
  }),
);

socialRouter.post(
  '/notifications/read',
  asyncHandler(async (req, res) => {
    res.json({ updated: await social.markNotificationsRead(authOf(req).userId) });
  }),
);
