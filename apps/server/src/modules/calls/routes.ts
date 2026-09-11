import { Router } from 'express';
import { z } from 'zod';
import { listCallsSchema } from '@sonder/shared';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { validateParams, validateQuery } from '../../middleware/validate.js';
import * as calls from './service.js';
import { getActiveCallIdFor, getCall, toActiveCall } from './registry.js';
import { buildIceConfig } from './turn.js';

export const callsRouter = Router();

callsRouter.use(requireAuth);

/**
 * ICE configuration, fetched by the client immediately before it builds an
 * RTCPeerConnection. It is authenticated so that TURN credentials are only ever
 * minted for a signed-in user.
 */
callsRouter.get(
  '/ice-config',
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    // Ephemeral credentials must not be cached by an intermediary.
    res.set('Cache-Control', 'no-store');
    res.json(buildIceConfig(userId));
  }),
);

callsRouter.get(
  '/history',
  validateQuery(listCallsSchema),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const { cursor, limit } = req.query as unknown as { cursor?: string; limit: number };
    res.json(await calls.listCallHistory(userId, { cursor, limit }));
  }),
);

/**
 * Lets a client that just reloaded discover it is still mid-call, so the call
 * UI can be restored rather than silently dropped.
 */
callsRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const callId = getActiveCallIdFor(userId);
    const call = callId ? getCall(callId) : undefined;
    res.json({ call: call ? toActiveCall(call, userId) : null });
  }),
);

callsRouter.get(
  '/:id',
  validateParams(z.object({ id: z.string().trim().min(1).max(64) })),
  asyncHandler(async (req, res) => {
    const { userId } = authOf(req);
    const row = await calls.getCallForUser(req.params.id, userId);
    res.json({
      call: {
        id: row.id,
        status: row.status,
        endReason: row.endReason,
        startedAt: row.startedAt.toISOString(),
        answeredAt: row.answeredAt?.toISOString() ?? null,
        endedAt: row.endedAt?.toISOString() ?? null,
        durationSec: row.durationSec,
        reconnectCount: row.reconnectCount,
      },
    });
  }),
);
