import { z } from 'zod';
import { cuidLike } from './messaging.js';

export const voicePresetIdSchema = z.enum([
  'female-natural',
  'female-soft',
  'female-bright',
  'female-deep',
  'female-clear',
]);

export const startCallSchema = z.object({
  calleeId: cuidLike,
  /** Optional: links the call to a conversation thread. */
  conversationId: cuidLike.optional(),
});

export const callIdSchema = z.object({ callId: cuidLike });

export const rejectCallSchema = z.object({
  callId: cuidLike,
  reason: z.enum(['REJECTED', 'BUSY']).default('REJECTED'),
});

export const endCallSchema = z.object({
  callId: cuidLike,
  reason: z
    .enum(['COMPLETED', 'CANCELLED', 'FAILED', 'TIMEOUT'])
    .default('COMPLETED'),
});

/**
 * WebRTC SDP relay. We do not parse or rewrite SDP server-side; it is opaque
 * and simply forwarded to the authorised peer of an authorised call.
 */
export const sdpSchema = z.object({
  callId: cuidLike,
  description: z.object({
    type: z.enum(['offer', 'answer']),
    sdp: z.string().min(1).max(200_000),
  }),
});

export const iceCandidateSchema = z.object({
  callId: cuidLike,
  candidate: z.object({
    candidate: z.string().max(2000),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }),
});

/** Client tells the server its RTCPeerConnection actually reached connected. */
export const callConnectedSchema = z.object({
  callId: cuidLike,
  /** Reported for history/metrics only; never trusted for authorisation. */
  voiceChangerEnabled: z.boolean().default(false),
  voicePreset: voicePresetIdSchema.nullable().default(null),
});

export const callStatsSchema = z.object({
  callId: cuidLike,
  voiceChangerEnabled: z.boolean(),
  voicePreset: voicePresetIdSchema.nullable(),
});

export const listCallsSchema = z.object({
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export type StartCallInput = z.infer<typeof startCallSchema>;
export type SdpInput = z.infer<typeof sdpSchema>;
export type IceCandidateInput = z.infer<typeof iceCandidateSchema>;
