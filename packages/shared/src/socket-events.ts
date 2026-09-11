import type { Message, TypingState, Conversation } from './types/messaging.js';
import type { PresenceUpdate } from './types/user.js';
import type {
  ActiveCall,
  CallEndReason,
  CallPeer,
  ServerCallState,
} from './types/call.js';
import type { VoicePresetId } from './types/voice.js';

/** Standard ack envelope. Every client->server event that mutates uses one. */
export type Ack<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type AckFn<T = void> = (response: Ack<T>) => void;

/* ------------------------------------------------------------------------- */
/* Server -> Client                                                          */
/* ------------------------------------------------------------------------- */
export interface ServerToClientEvents {
  /* presence */
  'user:online': (payload: PresenceUpdate) => void;
  'user:offline': (payload: PresenceUpdate) => void;

  /* messaging */
  'conversation:created': (payload: Conversation) => void;
  'message:new': (payload: Message) => void;
  'message:delivered': (payload: {
    conversationId: string;
    messageIds: string[];
    deliveredAt: string;
    /** The user who received them. */
    userId: string;
  }) => void;
  'message:read': (payload: {
    conversationId: string;
    messageIds: string[];
    readAt: string;
    userId: string;
  }) => void;
  'typing:start': (payload: TypingState) => void;
  'typing:stop': (payload: TypingState) => void;

  /* calling — signalling */
  'call:incoming': (payload: ActiveCall) => void;
  'call:ringing': (payload: { callId: string; at: string }) => void;
  'call:accepted': (payload: { callId: string; at: string }) => void;
  'call:rejected': (payload: {
    callId: string;
    reason: Extract<CallEndReason, 'REJECTED' | 'BUSY'>;
  }) => void;
  'call:ended': (payload: {
    callId: string;
    reason: CallEndReason;
    endedBy: string | null;
    durationSec: number;
  }) => void;
  'call:failed': (payload: {
    callId: string;
    code: string;
    message: string;
  }) => void;
  'call:state': (payload: { callId: string; state: ServerCallState }) => void;
  /** Peer lost its connection and is attempting an ICE restart. */
  'call:reconnecting': (payload: { callId: string; by: string }) => void;
  'call:connected': (payload: { callId: string; at: string }) => void;
  /** Purely informational: peer toggled their voice changer. */
  'call:peer-voice': (payload: {
    callId: string;
    enabled: boolean;
    preset: VoicePresetId | null;
  }) => void;

  /* calling — WebRTC relay */
  'webrtc:offer': (payload: {
    callId: string;
    from: string;
    description: { type: 'offer'; sdp: string };
  }) => void;
  'webrtc:answer': (payload: {
    callId: string;
    from: string;
    description: { type: 'answer'; sdp: string };
  }) => void;
  'webrtc:ice-candidate': (payload: {
    callId: string;
    from: string;
    candidate: RTCIceCandidateLike;
  }) => void;

  /* lifecycle */
  'session:revoked': (payload: { reason: string }) => void;
  error: (payload: { code: string; message: string }) => void;
}

export interface RTCIceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/* ------------------------------------------------------------------------- */
/* Client -> Server                                                          */
/* ------------------------------------------------------------------------- */
export interface ClientToServerEvents {
  /* presence */
  'presence:subscribe': (
    payload: { userIds: string[] },
    ack: AckFn<PresenceUpdate[]>,
  ) => void;

  /* messaging */
  'conversation:create': (
    payload: { userId: string },
    ack: AckFn<Conversation>,
  ) => void;
  'conversation:join': (
    payload: { conversationId: string },
    ack: AckFn<{ conversationId: string }>,
  ) => void;
  'conversation:leave': (payload: { conversationId: string }) => void;
  'message:send': (
    payload: { conversationId: string; body: string; clientId: string },
    ack: AckFn<Message>,
  ) => void;
  'message:read': (
    payload: { conversationId: string; messageId?: string },
    ack: AckFn<{ messageIds: string[]; readAt: string }>,
  ) => void;
  'typing:start': (payload: { conversationId: string }) => void;
  'typing:stop': (payload: { conversationId: string }) => void;

  /* calling */
  'call:start': (
    payload: { calleeId: string; conversationId?: string },
    ack: AckFn<ActiveCall>,
  ) => void;
  'call:accept': (payload: { callId: string }, ack: AckFn<ActiveCall>) => void;
  'call:reject': (
    payload: { callId: string; reason?: 'REJECTED' | 'BUSY' },
    ack: AckFn<void>,
  ) => void;
  'call:end': (
    payload: {
      callId: string;
      reason?: 'COMPLETED' | 'CANCELLED' | 'FAILED' | 'TIMEOUT';
    },
    ack: AckFn<void>,
  ) => void;
  'call:connected': (
    payload: {
      callId: string;
      voiceChangerEnabled?: boolean;
      voicePreset?: VoicePresetId | null;
    },
    ack: AckFn<void>,
  ) => void;
  'call:reconnecting': (payload: { callId: string }) => void;
  'call:voice-state': (payload: {
    callId: string;
    enabled: boolean;
    preset: VoicePresetId | null;
  }) => void;

  /* WebRTC relay */
  'webrtc:offer': (
    payload: { callId: string; description: { type: 'offer'; sdp: string } },
    ack: AckFn<void>,
  ) => void;
  'webrtc:answer': (
    payload: { callId: string; description: { type: 'answer'; sdp: string } },
    ack: AckFn<void>,
  ) => void;
  'webrtc:ice-candidate': (payload: {
    callId: string;
    candidate: RTCIceCandidateLike;
  }) => void;
}

/** Data attached to an authenticated socket, server-side only. */
export interface SocketData {
  userId: string;
  username: string;
  sessionId: string | null;
}

export const SOCKET_ERROR = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  BLOCKED: 'BLOCKED',
  USER_OFFLINE: 'USER_OFFLINE',
  USER_BUSY: 'USER_BUSY',
  ALREADY_IN_CALL: 'ALREADY_IN_CALL',
  INVALID_STATE: 'INVALID_STATE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type SocketErrorCode =
  (typeof SOCKET_ERROR)[keyof typeof SOCKET_ERROR];
