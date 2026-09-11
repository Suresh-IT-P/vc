import type {
  ActiveCall,
  CallEndReason,
  CallPeer,
  ServerCallState,
  VoicePresetId,
} from '@sonder/shared';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import * as callService from './service.js';

const log = logger.child('calls');

/**
 * The authoritative call state machine.
 *
 *   RINGING --accept--> ACCEPTED --connected--> CONNECTED
 *      |                    |                       |
 *      +--reject/timeout----+-----------------------+--> ENDED
 *
 * Everything the clients report (SDP, ICE, "I am connected") is checked against
 * this before it is relayed. There is no path by which a client can put a call
 * into a state the server did not authorise, and no path by which a third party
 * can address a call they are not a participant of.
 *
 * SCALING NOTE: process-local, like presence. Multi-instance deployments need
 * this in Redis. See docs/deployment.md.
 */
export interface LiveCall {
  id: string;
  callerId: string;
  calleeId: string;
  conversationId: string | null;
  callerPeer: CallPeer;
  calleePeer: CallPeer;
  state: ServerCallState;
  createdAt: Date;
  answeredAt: Date | null;
  connectedAt: Date | null;
  reconnectCount: number;
  /** Set of userIds currently reporting an ICE restart. */
  reconnecting: Set<string>;
  ringTimer?: NodeJS.Timeout;
  reconnectTimers: Map<string, NodeJS.Timeout>;
}

export interface CallTransport {
  /** Deliver an event to every live socket of a user. */
  toUser(userId: string, event: string, payload: unknown): void;
  /** True when the user has at least one live socket. */
  isOnline(userId: string): boolean;
}

const calls = new Map<string, LiveCall>();
/** userId -> callId. Enforces one concurrent call per user. */
const activeByUser = new Map<string, string>();

let transport: CallTransport | null = null;

export function initCallRegistry(t: CallTransport) {
  transport = t;
}

function emit(userId: string, event: string, payload: unknown) {
  transport?.toUser(userId, event, payload);
}

function online(userId: string): boolean {
  return transport?.isOnline(userId) ?? false;
}

export function getCall(callId: string): LiveCall | undefined {
  return calls.get(callId);
}

export function getActiveCallIdFor(userId: string): string | undefined {
  return activeByUser.get(userId);
}

export function isParticipant(call: LiveCall, userId: string): boolean {
  return call.callerId === userId || call.calleeId === userId;
}

export function peerIdOf(call: LiveCall, userId: string): string {
  return call.callerId === userId ? call.calleeId : call.callerId;
}

/**
 * Resolves a call the caller is allowed to act on, or throws. Every socket
 * handler funnels through this — it is the single authorisation choke point for
 * signalling.
 */
export function requireParticipation(callId: string, userId: string): LiveCall {
  const call = calls.get(callId);
  if (!call) throw new AppError(404, 'NOT_FOUND', 'That call is no longer active.');
  if (!isParticipant(call, userId)) {
    throw new AppError(403, 'FORBIDDEN', 'You are not part of that call.');
  }
  return call;
}

export function toActiveCall(call: LiveCall, viewerId: string): ActiveCall {
  const isCaller = call.callerId === viewerId;
  return {
    id: call.id,
    conversationId: call.conversationId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    peer: isCaller ? call.calleePeer : call.callerPeer,
    direction: isCaller ? 'outgoing' : 'incoming',
    state: call.state,
    createdAt: call.createdAt.toISOString(),
    connectedAt: call.connectedAt?.toISOString() ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

export interface StartCallOptions {
  callerId: string;
  calleeId: string;
  conversationId: string | null;
  callerPeer: CallPeer;
  calleePeer: CallPeer;
}

export async function startCall(options: StartCallOptions): Promise<LiveCall> {
  const { callerId, calleeId } = options;

  if (activeByUser.has(callerId)) {
    throw new AppError(409, 'ALREADY_IN_CALL', 'You are already on a call.');
  }

  // The callee's availability is decided here, on the server, from live socket
  // state — never from anything the caller sent.
  const calleeBusy = activeByUser.has(calleeId);
  const calleeOffline = !online(calleeId);

  if (calleeBusy || calleeOffline) {
    // Still recorded, so both sides get an honest history entry.
    const row = await callService.createCallRow({
      callerId,
      calleeId,
      conversationId: options.conversationId,
    });
    const reason: CallEndReason = calleeBusy ? 'BUSY' : 'UNAVAILABLE';
    await callService.finaliseCall({
      callId: row.id,
      reason,
      endedById: null,
      answeredAt: null,
    });
    throw new AppError(
      409,
      calleeBusy ? 'USER_BUSY' : 'USER_OFFLINE',
      calleeBusy
        ? `${options.calleePeer.displayName} is on another call.`
        : `${options.calleePeer.displayName} is offline right now.`,
    );
  }

  const row = await callService.createCallRow({
    callerId,
    calleeId,
    conversationId: options.conversationId,
  });

  const call: LiveCall = {
    id: row.id,
    callerId,
    calleeId,
    conversationId: options.conversationId,
    callerPeer: options.callerPeer,
    calleePeer: options.calleePeer,
    state: 'RINGING',
    createdAt: row.startedAt,
    answeredAt: null,
    connectedAt: null,
    reconnectCount: 0,
    reconnecting: new Set(),
    reconnectTimers: new Map(),
  };

  calls.set(call.id, call);
  activeByUser.set(callerId, call.id);
  activeByUser.set(calleeId, call.id);

  call.ringTimer = setTimeout(() => {
    void endCall(call.id, 'TIMEOUT', null).catch((error) =>
      log.error('ring timeout failed', error),
    );
  }, env.CALL_RING_TIMEOUT_MS);

  log.info(`call ${call.id} ringing ${callerId} -> ${calleeId}`);

  emit(calleeId, 'call:incoming', toActiveCall(call, calleeId));
  emit(callerId, 'call:ringing', { callId: call.id, at: new Date().toISOString() });

  return call;
}

export async function acceptCall(callId: string, userId: string): Promise<LiveCall> {
  const call = requireParticipation(callId, userId);

  if (call.calleeId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the person being called can accept.');
  }
  if (call.state !== 'RINGING') {
    throw new AppError(409, 'INVALID_STATE', `This call is already ${call.state.toLowerCase()}.`);
  }

  clearRingTimer(call);
  call.state = 'ACCEPTED';
  call.answeredAt = new Date();
  await callService.setCallState(call.id, 'ACCEPTED', call.answeredAt);

  log.info(`call ${call.id} accepted`);
  const at = call.answeredAt.toISOString();
  emit(call.callerId, 'call:accepted', { callId: call.id, at });
  emit(call.calleeId, 'call:accepted', { callId: call.id, at });
  broadcastState(call);

  return call;
}

export async function rejectCall(
  callId: string,
  userId: string,
  reason: 'REJECTED' | 'BUSY',
): Promise<void> {
  const call = requireParticipation(callId, userId);
  if (call.calleeId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the person being called can decline.');
  }
  if (call.state !== 'RINGING') {
    throw new AppError(409, 'INVALID_STATE', 'This call can no longer be declined.');
  }
  emit(call.callerId, 'call:rejected', { callId: call.id, reason });
  await endCall(callId, reason, userId);
}

/**
 * A client reporting that its RTCPeerConnection actually reached `connected`.
 * This is the only thing that promotes a call to CONNECTED — the UI never shows
 * "Connected" on a timer.
 */
export async function markConnected(
  callId: string,
  userId: string,
  voice: { enabled: boolean; preset: VoicePresetId | null },
): Promise<LiveCall> {
  const call = requireParticipation(callId, userId);
  if (call.state === 'ENDED') {
    throw new AppError(409, 'INVALID_STATE', 'That call has already ended.');
  }
  if (call.state === 'RINGING') {
    throw new AppError(409, 'INVALID_STATE', 'That call has not been accepted yet.');
  }

  clearReconnectTimer(call, userId);
  call.reconnecting.delete(userId);

  await callService.recordVoiceUsage(call.id, userId, voice.enabled, voice.preset);

  if (call.state !== 'CONNECTED') {
    call.state = 'CONNECTED';
    call.connectedAt = new Date();
    await callService.setCallState(call.id, 'CONNECTED');
    log.info(`call ${call.id} connected`);
    const at = call.connectedAt.toISOString();
    emit(call.callerId, 'call:connected', { callId: call.id, at });
    emit(call.calleeId, 'call:connected', { callId: call.id, at });
    broadcastState(call);
  } else if (call.reconnecting.size === 0) {
    // Recovered from an ICE restart.
    const at = new Date().toISOString();
    emit(peerIdOf(call, userId), 'call:connected', { callId: call.id, at });
  }

  return call;
}

/** A peer lost its media path and is attempting an ICE restart. */
export function markReconnecting(callId: string, userId: string): void {
  const call = requireParticipation(callId, userId);
  if (call.state !== 'CONNECTED' && call.state !== 'ACCEPTED') return;

  if (!call.reconnecting.has(userId)) {
    call.reconnecting.add(userId);
    call.reconnectCount += 1;
    log.warn(`call ${call.id} reconnecting (${userId})`);
  }
  emit(peerIdOf(call, userId), 'call:reconnecting', { callId: call.id, by: userId });
  emit(userId, 'call:reconnecting', { callId: call.id, by: userId });

  clearReconnectTimer(call, userId);
  call.reconnectTimers.set(
    userId,
    setTimeout(() => {
      void endCall(call.id, 'FAILED', null).catch((error) =>
        log.error('reconnect grace expiry failed', error),
      );
    }, env.CALL_RECONNECT_GRACE_MS),
  );
}

export function reportVoiceState(
  callId: string,
  userId: string,
  enabled: boolean,
  preset: VoicePresetId | null,
): void {
  const call = requireParticipation(callId, userId);
  void callService
    .recordVoiceUsage(call.id, userId, enabled, preset)
    .catch((error) => log.warn('could not record voice usage', error));
  // The peer is told so the UI can surface "their voice is being processed" —
  // this is a transparency feature, not a control.
  emit(peerIdOf(call, userId), 'call:peer-voice', { callId: call.id, enabled, preset });
}

export function reportQuality(callId: string, userId: string, level: string): void {
  const call = calls.get(callId);
  if (!call || !isParticipant(call, userId)) return;
  void callService
    .recordQuality(call.id, userId, level)
    .catch(() => undefined);
}

/** Idempotent. Safe to call from timers, socket handlers and disconnects. */
export async function endCall(
  callId: string,
  reason: CallEndReason,
  endedById: string | null,
): Promise<void> {
  const call = calls.get(callId);
  if (!call) return;
  if (call.state === 'ENDED') return;

  call.state = 'ENDED';
  clearRingTimer(call);
  for (const timer of call.reconnectTimers.values()) clearTimeout(timer);
  call.reconnectTimers.clear();

  calls.delete(callId);
  if (activeByUser.get(call.callerId) === callId) activeByUser.delete(call.callerId);
  if (activeByUser.get(call.calleeId) === callId) activeByUser.delete(call.calleeId);

  const { durationSec } = await callService.finaliseCall({
    callId,
    reason,
    endedById,
    answeredAt: call.answeredAt,
    reconnectCount: call.reconnectCount,
  });

  log.info(`call ${callId} ended (${reason}, ${durationSec}s)`);

  const payload = { callId, reason, endedBy: endedById, durationSec };
  emit(call.callerId, 'call:ended', payload);
  emit(call.calleeId, 'call:ended', payload);
}

export async function requestEnd(
  callId: string,
  userId: string,
  reason: CallEndReason,
): Promise<void> {
  const call = requireParticipation(callId, userId);
  // A caller hanging up before the callee picked up is a cancel, not a
  // completed call — the history wording depends on getting this right.
  const resolved: CallEndReason =
    call.state === 'RINGING' && call.callerId === userId ? 'CANCELLED' : reason;
  await endCall(callId, resolved, userId);
}

/**
 * Called when a user's *last* socket goes away. A page reload destroys the
 * RTCPeerConnection, so there is nothing to reconnect to — we end the call
 * rather than pretending it might come back.
 */
export async function handleUserDisconnected(userId: string): Promise<void> {
  const callId = activeByUser.get(userId);
  if (!callId) return;
  const call = calls.get(callId);
  if (!call) {
    activeByUser.delete(userId);
    return;
  }

  let reason: CallEndReason;
  if (call.state === 'RINGING') {
    reason = call.callerId === userId ? 'CANCELLED' : 'UNAVAILABLE';
  } else {
    reason = 'FAILED';
  }
  log.warn(`call ${callId} ended by disconnect of ${userId} (${reason})`);
  await endCall(callId, reason, null);
}

function broadcastState(call: LiveCall) {
  emit(call.callerId, 'call:state', { callId: call.id, state: call.state });
  emit(call.calleeId, 'call:state', { callId: call.id, state: call.state });
}

function clearRingTimer(call: LiveCall) {
  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = undefined;
  }
}

function clearReconnectTimer(call: LiveCall, userId: string) {
  const timer = call.reconnectTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    call.reconnectTimers.delete(userId);
  }
}

/** Test/shutdown helper: drops every timer so the process can exit cleanly. */
export function shutdownCallRegistry(): void {
  for (const call of calls.values()) {
    clearRingTimer(call);
    for (const timer of call.reconnectTimers.values()) clearTimeout(timer);
    call.reconnectTimers.clear();
  }
  calls.clear();
  activeByUser.clear();
}

export function activeCallCount(): number {
  return calls.size;
}
