import {
  callConnectedSchema,
  callIdSchema,
  endCallSchema,
  iceCandidateSchema,
  rejectCallSchema,
  sdpSchema,
  startCallSchema,
  voicePresetIdSchema,
} from '@sonder/shared';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parseOrThrow } from '../../middleware/validate.js';
import { prisma } from '../../db.js';
import { toCallPeer } from '../../lib/serialize.js';
import * as registry from '../../modules/calls/registry.js';
import * as messaging from '../../modules/messaging/service.js';
import { assertNotBlocked } from '../../modules/users/service.js';
import { safely, withAck } from '../ack.js';
import { bucketsFor, userRoom, type SonderServer, type SonderSocket } from '../index.js';

const log = logger.child('calling');

const PEER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  isOnline: true,
  lastSeenAt: true,
} as const;

export function registerCallHandlers(io: SonderServer, socket: SonderSocket) {
  const { userId } = socket.data;

  socket.on(
    'call:start',
    withAck('call:start', async (payload) => {
      bucketsFor(socket).calls.take();
      const input = parseOrThrow(startCallSchema, payload);

      if (input.calleeId === userId) {
        throw new AppError(400, 'VALIDATION', 'You cannot call yourself.');
      }

      const [caller, callee] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: PEER_SELECT }),
        prisma.user.findUnique({ where: { id: input.calleeId }, select: PEER_SELECT }),
      ]);
      if (!caller) throw new AppError(401, 'UNAUTHENTICATED', 'Your account no longer exists.');
      if (!callee) throw new AppError(404, 'NOT_FOUND', 'That account does not exist.');

      await assertNotBlocked(userId, callee.id);

      // A conversation id, if supplied, must be one the caller actually belongs
      // to — otherwise a call could be filed against a stranger's thread.
      let conversationId: string | null = null;
      if (input.conversationId) {
        await messaging.assertMembership(userId, input.conversationId);
        const peerId = await messaging.getPeerId(input.conversationId, userId);
        if (peerId !== callee.id) {
          throw new AppError(400, 'VALIDATION', 'That conversation is with someone else.');
        }
        conversationId = input.conversationId;
      }

      const call = await registry.startCall({
        callerId: userId,
        calleeId: callee.id,
        conversationId,
        callerPeer: toCallPeer(caller),
        calleePeer: toCallPeer(callee),
      });

      return registry.toActiveCall(call, userId);
    }),
  );

  socket.on(
    'call:accept',
    withAck('call:accept', async (payload) => {
      const input = parseOrThrow(callIdSchema, payload);
      const call = await registry.acceptCall(input.callId, userId);
      return registry.toActiveCall(call, userId);
    }),
  );

  socket.on(
    'call:reject',
    withAck('call:reject', async (payload) => {
      const input = parseOrThrow(rejectCallSchema, payload);
      const call = registry.requireParticipation(input.callId, userId);
      const callerId = call.callerId;
      const calleeName = call.calleePeer.displayName;

      await registry.rejectCall(input.callId, userId, input.reason);

      // A declined call is a real missed call for the caller's notification list.
      await recordMissedCall(callerId, userId, calleeName, input.reason);
    }),
  );

  socket.on(
    'call:end',
    withAck('call:end', async (payload) => {
      const input = parseOrThrow(endCallSchema, payload);
      await registry.requestEnd(input.callId, userId, input.reason);
    }),
  );

  /**
   * The client reporting that its RTCPeerConnection genuinely reached the
   * `connected` state. Nothing else promotes a call to CONNECTED, which is what
   * makes the "Connected" label in the UI mean something.
   */
  socket.on(
    'call:connected',
    withAck('call:connected', async (payload) => {
      const input = parseOrThrow(callConnectedSchema, payload);
      await registry.markConnected(input.callId, userId, {
        enabled: input.voiceChangerEnabled,
        preset: input.voicePreset,
      });
    }),
  );

  socket.on(
    'call:reconnecting',
    safely('call:reconnecting', (payload) => {
      const input = parseOrThrow(callIdSchema, payload);
      registry.markReconnecting(input.callId, userId);
    }),
  );

  socket.on(
    'call:voice-state',
    safely('call:voice-state', (payload) => {
      const input = parseOrThrow(
        z.object({
          callId: z.string().min(1).max(64),
          enabled: z.boolean(),
          preset: voicePresetIdSchema.nullable(),
        }),
        payload,
      );
      registry.reportVoiceState(input.callId, userId, input.enabled, input.preset);
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* WebRTC relay                                                           */
  /*                                                                        */
  /* The server never parses, rewrites or stores SDP or candidates. It only  */
  /* checks that the sender is a participant of a live call and forwards to  */
  /* exactly one recipient: the other participant. Media itself never        */
  /* touches this process.                                                   */
  /* ---------------------------------------------------------------------- */

  socket.on(
    'webrtc:offer',
    withAck('webrtc:offer', (payload) => {
      bucketsFor(socket).signalling.take();
      const input = parseOrThrow(sdpSchema, payload);
      const call = registry.requireParticipation(input.callId, userId);

      // An offer before the callee accepted would let a caller push media at
      // someone who has not agreed to talk to them.
      if (call.state !== 'ACCEPTED' && call.state !== 'CONNECTED') {
        throw new AppError(
          409,
          'INVALID_STATE',
          'That call is not ready for media negotiation yet.',
        );
      }

      io.to(userRoom(registry.peerIdOf(call, userId))).emit('webrtc:offer', {
        callId: call.id,
        from: userId,
        description: input.description as { type: 'offer'; sdp: string },
      });
    }),
  );

  socket.on(
    'webrtc:answer',
    withAck('webrtc:answer', (payload) => {
      bucketsFor(socket).signalling.take();
      const input = parseOrThrow(sdpSchema, payload);
      const call = registry.requireParticipation(input.callId, userId);
      if (call.state !== 'ACCEPTED' && call.state !== 'CONNECTED') {
        throw new AppError(409, 'INVALID_STATE', 'That call is not negotiating.');
      }

      io.to(userRoom(registry.peerIdOf(call, userId))).emit('webrtc:answer', {
        callId: call.id,
        from: userId,
        description: input.description as { type: 'answer'; sdp: string },
      });
    }),
  );

  socket.on(
    'webrtc:ice-candidate',
    safely('webrtc:ice-candidate', (payload) => {
      // Candidates arrive in bursts; drop silently past the budget rather than
      // erroring, since a lost candidate degrades to relay rather than failing.
      if (!bucketsFor(socket).signalling.tryTake()) return;
      const input = parseOrThrow(iceCandidateSchema, payload);
      const call = registry.requireParticipation(input.callId, userId);

      io.to(userRoom(registry.peerIdOf(call, userId))).emit('webrtc:ice-candidate', {
        callId: call.id,
        from: userId,
        candidate: input.candidate,
      });
    }),
  );
}

async function recordMissedCall(
  callerId: string,
  calleeId: string,
  calleeName: string,
  reason: 'REJECTED' | 'BUSY',
) {
  try {
    const { createNotification } = await import('../../modules/social/service.js');
    await createNotification({
      userId: callerId,
      actorId: calleeId,
      kind: 'CALL',
      text:
        reason === 'BUSY'
          ? `${calleeName} was on another call.`
          : `${calleeName} declined your call.`,
      href: '/calls',
    });
  } catch (error) {
    log.warn('could not record missed call notification', error);
  }
}
