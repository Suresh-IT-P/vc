/**
 * Client-side call lifecycle. The server keeps its own (smaller) authoritative
 * state machine in `ServerCallState`; this one additionally models the local
 * WebRTC negotiation phases which the server neither sees nor trusts.
 */
export type CallState =
  | 'IDLE'
  | 'CALLING'      // we dialled, waiting for the server to say it is ringing
  | 'RINGING'      // callee's device is alerting (both sides see this)
  | 'ACCEPTED'     // accept received, media negotiation about to start
  | 'CONNECTING'   // ICE/DTLS in progress
  | 'CONNECTED'    // RTCPeerConnection is actually connected, media flowing
  | 'RECONNECTING' // ICE restart in flight
  | 'ENDED';

/** Why a call left the active set. Persisted on the Call row. */
export type CallEndReason =
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'BUSY'
  | 'TIMEOUT'
  | 'FAILED'
  | 'UNAVAILABLE';

export type ServerCallState =
  | 'RINGING'
  | 'ACCEPTED'
  | 'CONNECTED'
  | 'ENDED';

export type CallDirection = 'incoming' | 'outgoing';

export interface CallPeer {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Live call as broadcast over the socket. */
export interface ActiveCall {
  id: string;
  conversationId: string | null;
  callerId: string;
  calleeId: string;
  peer: CallPeer;
  direction: CallDirection;
  state: ServerCallState;
  createdAt: string;
  /** Set once both sides report a live peer connection. */
  connectedAt: string | null;
}

/** A row in the call history list. */
export interface CallHistoryEntry {
  id: string;
  peer: CallPeer;
  direction: CallDirection;
  type: 'audio';
  status: 'completed' | 'missed' | 'rejected' | 'cancelled' | 'failed';
  endReason: CallEndReason | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** Seconds of connected talk time; 0 for unanswered calls. */
  durationSec: number;
  /** Whether *this* viewer had the voice changer on for this call. */
  voiceChangerUsed: boolean;
  voicePreset: string | null;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigResponse {
  iceServers: IceServerConfig[];
  /** Seconds until the (ephemeral) TURN credentials expire. */
  ttl: number;
  /** True when a TURN relay is configured; STUN-only deployments will fail
   *  for peers behind symmetric NAT and we surface that honestly in the UI. */
  hasTurn: boolean;
}

/** Live quality sample derived from RTCStatsReport. */
export interface CallQuality {
  rttMs: number | null;
  jitterMs: number | null;
  packetsLostPct: number | null;
  /** Derived bucket used for the signal-bars indicator. */
  level: 'excellent' | 'good' | 'poor' | 'critical' | 'unknown';
}
