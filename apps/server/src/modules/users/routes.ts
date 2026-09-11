import { Router } from 'express';
import { z } from 'zod';
import { searchUsersSchema } from '@sonder/shared';
import { authOf, optionalAuth, requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { searchLimiter } from '../../middleware/rate-limit.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as users from './service.js';

export const usersRouter = Router();

const usernameParam = z.object({
  username: z.string().trim().min(1).max(40),
});

usersRouter.get(
  '/search',
  requireAuth,
  searchLimiter,
  validateQuery(searchUsersSchema),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { q, limit } = req.query as unknown as { q: string; limit: number };
    const results = await users.searchUsers(userId, q, limit);
    res.json({ results });
  }),
);

usersRouter.get(
  '/suggestions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const results = await users.getSuggestions(userId);
    res.json({ results });
  }),
);

usersRouter.get(
  '/:username',
  optionalAuth,
  validateParams(usernameParam),
  asyncHandler(async (req, res) => {
    const user = await users.getProfileByUsername(
      req.auth?.userId ?? null,
      req.params.username,
    );
    res.json({ user });
  }),
);

usersRouter.get(
  '/:username/followers',
  requireAuth,
  validateParams(usernameParam),
  asyncHandler(async (req, res) => {
    res.json({ results: await users.listFollows(req.params.username, 'followers') });
  }),
);

usersRouter.get(
  '/:username/following',
  requireAuth,
  validateParams(usernameParam),
  asyncHandler(async (req, res) => {
    res.json({ results: await users.listFollows(req.params.username, 'following') });
  }),
);

usersRouter.post(
  '/:username/follow',
  requireAuth,
  validateParams(usernameParam),
  validateBody(z.object({ follow: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const result = await users.setFollow(userId, req.params.username, req.body.follow);
    res.json(result);
  }),
);

usersRouter.post(
  '/:username/block',
  requireAuth,
  validateParams(usernameParam),
  validateBody(z.object({ block: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const result = await users.setBlock(userId, req.params.username, req.body.block);
    res.json(result);
  }),
);
