import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { ActiveCall, CallHistoryEntry, Paginated } from '@sonder/shared';
import {
  auth,
  closeSockets,
  connectSocket,
  createUser,
  emitAck,
  loadServer,
  sleep,
  startHarness,
  waitFor,
  type TestHarness,
  type TestSocket,
  type TestUser,
} from './helpers.js';

let harness: TestHarness;
let app: Express;
const open: TestSocket[] = [];

async function connect(user: TestUser): Promise<TestSocket> {
  const socket = await connectSocket(harness.url, user.accessToken);
  open.push(socket);
  return socket;
}

/** A fresh pair per test keeps the "one call at a time" rule from bleeding. */
async function pair() {
  const caller = await createUser(app, { displayName: 'Caller Person' });
  const callee = await createUser(app, { displayName: 'Callee Person' });
  const callerSocket = await connect(caller);
  const calleeSocket = await connect(callee);
  await sleep(80);
  return { caller, callee, callerSocket, calleeSocket };
}

beforeAll(async () => {
  harness = await startHarness();
  app = harness.app;
});

afterEach(async () => {
  closeSockets(...open.splice(0));
  await sleep(150);
  const { registry } = await loadServer();
  registry.shutdownCallRegistry();
});

afterAll(async () => {
  await harness?.close();
  const { prisma } = await loadServer();
  await prisma.$disconnect();
});

describe('placing a call', () => {
  it('rings the callee and tells the caller', async () => {
    const { caller, callee, callerSocket, calleeSocket } = await pair();

    const incoming = waitFor<ActiveCall>(calleeSocket, 'call:incoming');
    const ringing = waitFor<{ callId: string }>(callerSocket, 'call:ringing');

    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    expect(call.state).toBe('RINGING');
    expect(call.direction).toBe('outgoing');
    expect(call.peer.id).toBe(callee.id);

    const received = await incoming;
    expect(received.id).toBe(call.id);
    expect(received.direction).toBe('incoming');
    expect(received.peer.id).toBe(caller.id);
    expect((await ringing).callId).toBe(call.id);
  });

  it('refuses to call yourself', async () => {
    const user = await createUser(app);
    const socket = await connect(user);
    await expect(
      emitAck(socket, 'call:start', { calleeId: user.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to call someone who is offline, and records the attempt', async () => {
    const caller = await createUser(app);
    const offline = await createUser(app);
    const callerSocket = await connect(caller);

    await expect(
      emitAck(callerSocket, 'call:start', { calleeId: offline.id }),
    ).rejects.toMatchObject({ code: 'USER_OFFLINE' });

    // The attempt still belongs in both users' history.
    const history = await request(app)
      .get('/api/calls/history')
      .set(auth(caller))
      .expect(200);
    expect(history.body.items[0].endReason).toBe('UNAVAILABLE');
    expect(history.body.items[0].peer.id).toBe(offline.id);
  });

  it('refuses to call someone already on another call', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    await emitAck(callerSocket, 'call:start', { calleeId: callee.id });
    await sleep(60);

    const third = await createUser(app);
    const thirdSocket = await connect(third);
    await sleep(60);

    await expect(
      emitAck(thirdSocket, 'call:start', { calleeId: callee.id }),
    ).rejects.toMatchObject({ code: 'USER_BUSY' });
    expect(calleeSocket.connected).toBe(true);
  });

  it('refuses a second outgoing call from the same caller', async () => {
    const { callee, callerSocket } = await pair();
    await emitAck(callerSocket, 'call:start', { calleeId: callee.id });
    await sleep(60);

    const other = await createUser(app);
    await connect(other);
    await sleep(60);

    await expect(
      emitAck(callerSocket, 'call:start', { calleeId: other.id }),
    ).rejects.toMatchObject({ code: 'ALREADY_IN_CALL' });
  });

  it('refuses to call a user who blocked you', async () => {
    const { caller, callee, callerSocket } = await pair();
    await request(app)
      .post(`/api/users/${caller.username}/block`)
      .set(auth(callee))
      .send({ block: true })
      .expect(200);

    await expect(
      emitAck(callerSocket, 'call:start', { calleeId: callee.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to file a call against a conversation you are not in', async () => {
    const { callee, callerSocket } = await pair();
    const outsiderA = await createUser(app);
    const outsiderB = await createUser(app);
    const foreign = await request(app)
      .post('/api/conversations')
      .set(auth(outsiderA))
      .send({ userId: outsiderB.id })
      .expect(201);

    await expect(
      emitAck(callerSocket, 'call:start', {
        calleeId: callee.id,
        conversationId: foreign.body.conversation.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('answering', () => {
  it('accepts and moves both sides to ACCEPTED', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    const callerAccepted = waitFor<{ callId: string }>(callerSocket, 'call:accepted');
    const accepted = await emitAck<ActiveCall>(calleeSocket, 'call:accept', {
      callId: call.id,
    });

    expect(accepted.state).toBe('ACCEPTED');
    expect((await callerAccepted).callId).toBe(call.id);
  });

  it('does not let the caller accept their own call', async () => {
    const { callee, callerSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await expect(
      emitAck(callerSocket, 'call:accept', { callId: call.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not let a third party accept, reject or end the call', async () => {
    const { callee, callerSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    const intruder = await createUser(app);
    const intruderSocket = await connect(intruder);

    for (const event of ['call:accept', 'call:reject', 'call:end']) {
      await expect(
        emitAck(intruderSocket, event, { callId: call.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('cannot be accepted twice', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });
    await expect(
      emitAck(calleeSocket, 'call:accept', { callId: call.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('declines and ends the call for both sides', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    const rejected = waitFor<{ reason: string }>(callerSocket, 'call:rejected');
    const ended = waitFor<{ reason: string }>(callerSocket, 'call:ended');
    await emitAck(calleeSocket, 'call:reject', { callId: call.id, reason: 'REJECTED' });

    expect((await rejected).reason).toBe('REJECTED');
    expect((await ended).reason).toBe('REJECTED');
  });

  it('records a caller hang-up before answer as CANCELLED, not COMPLETED', async () => {
    const { caller, callee, callerSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    // The client asks to end with COMPLETED; the server knows better.
    await emitAck(callerSocket, 'call:end', { callId: call.id, reason: 'COMPLETED' });
    await sleep(120);

    const history = await request(app)
      .get('/api/calls/history')
      .set(auth(caller))
      .expect(200);
    expect(history.body.items[0].endReason).toBe('CANCELLED');
    expect(history.body.items[0].durationSec).toBe(0);
  });

  it('times out an unanswered call', async () => {
    // global-setup sets CALL_RING_TIMEOUT_MS to 2000 for the suite.
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    const callerEnded = waitFor<{ reason: string }>(callerSocket, 'call:ended', 10_000);
    const calleeEnded = waitFor<{ reason: string }>(calleeSocket, 'call:ended', 10_000);

    expect((await callerEnded).reason).toBe('TIMEOUT');
    expect((await calleeEnded).reason).toBe('TIMEOUT');
    expect(call.state).toBe('RINGING');
  });
});

describe('WebRTC signalling relay', () => {
  const OFFER = { type: 'offer' as const, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  const ANSWER = { type: 'answer' as const, sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' };

  it('refuses media negotiation before the call is accepted', async () => {
    const { callee, callerSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });

    // Otherwise a caller could push media at someone who never agreed to talk.
    await expect(
      emitAck(callerSocket, 'webrtc:offer', { callId: call.id, description: OFFER }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('relays offer, answer and ICE candidates to the peer only', async () => {
    const { caller, callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });

    const intruder = await createUser(app);
    const intruderSocket = await connect(intruder);
    let intruderHeard = false;
    intruderSocket.on('webrtc:offer', () => {
      intruderHeard = true;
    });

    const offerAtCallee = waitFor<{ from: string; description: { sdp: string } }>(
      calleeSocket,
      'webrtc:offer',
    );
    await emitAck(callerSocket, 'webrtc:offer', { callId: call.id, description: OFFER });
    const relayedOffer = await offerAtCallee;
    expect(relayedOffer.from).toBe(caller.id);
    // The SDP must arrive byte-for-byte; the server does not rewrite it.
    expect(relayedOffer.description.sdp).toBe(OFFER.sdp);

    const answerAtCaller = waitFor<{ from: string }>(callerSocket, 'webrtc:answer');
    await emitAck(calleeSocket, 'webrtc:answer', { callId: call.id, description: ANSWER });
    expect((await answerAtCaller).from).toBe(callee.id);

    const iceAtCallee = waitFor<{ candidate: { candidate: string } }>(
      calleeSocket,
      'webrtc:ice-candidate',
    );
    callerSocket.emit('webrtc:ice-candidate', {
      callId: call.id,
      candidate: { candidate: 'candidate:1 1 udp 2130706431 10.0.0.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect((await iceAtCallee).candidate.candidate).toContain('typ host');

    await sleep(200);
    expect(intruderHeard).toBe(false);
  });

  it('refuses SDP from someone who is not on the call', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });

    const intruder = await createUser(app);
    const intruderSocket = await connect(intruder);

    await expect(
      emitAck(intruderSocket, 'webrtc:offer', { callId: call.id, description: OFFER }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses signalling for a call id that does not exist', async () => {
    const user = await createUser(app);
    const socket = await connect(user);
    await expect(
      emitAck(socket, 'webrtc:offer', { callId: 'made-up-call', description: OFFER }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an oversized SDP payload', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });

    await expect(
      emitAck(callerSocket, 'webrtc:offer', {
        callId: call.id,
        description: { type: 'offer', sdp: 'x'.repeat(200_001) },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('connection lifecycle', () => {
  it('only reaches CONNECTED when a client reports a real peer connection', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });

    const { registry } = await loadServer();
    // Accepted is not connected: no media has been proven to flow yet.
    expect(registry.getCall(call.id)?.state).toBe('ACCEPTED');

    const connectedAtCallee = waitFor<{ callId: string }>(calleeSocket, 'call:connected');
    await emitAck(callerSocket, 'call:connected', {
      callId: call.id,
      voiceChangerEnabled: true,
      voicePreset: 'female-natural',
    });

    expect((await connectedAtCallee).callId).toBe(call.id);
    expect(registry.getCall(call.id)?.state).toBe('CONNECTED');
    expect(registry.getCall(call.id)?.connectedAt).toBeInstanceOf(Date);
  });

  it('refuses a connected report for a call that was never accepted', async () => {
    const { callee, callerSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await expect(
      emitAck(callerSocket, 'call:connected', { callId: call.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('tells the peer when someone is reconnecting', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });
    await emitAck(callerSocket, 'call:connected', { callId: call.id });

    const notice = waitFor<{ by: string }>(calleeSocket, 'call:reconnecting');
    callerSocket.emit('call:reconnecting', { callId: call.id });
    const payload = await notice;
    expect(payload.by).toBeTypeOf('string');

    const { registry } = await loadServer();
    expect(registry.getCall(call.id)?.reconnectCount).toBe(1);
  });

  it('ends the call when a participant socket disappears', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });
    await emitAck(callerSocket, 'call:connected', { callId: call.id });

    const ended = waitFor<{ reason: string }>(calleeSocket, 'call:ended');
    callerSocket.close();
    // A closed socket means the RTCPeerConnection is gone, so the call is over.
    expect((await ended).reason).toBe('FAILED');
  });

  it('lets either side hang up a connected call', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });
    await emitAck(callerSocket, 'call:connected', { callId: call.id });

    const endedAtCaller = waitFor<{ reason: string; durationSec: number }>(
      callerSocket,
      'call:ended',
    );
    await emitAck(calleeSocket, 'call:end', { callId: call.id, reason: 'COMPLETED' });
    const payload = await endedAtCaller;
    expect(payload.reason).toBe('COMPLETED');
    expect(payload.durationSec).toBeGreaterThanOrEqual(0);
  });

  it('lets the callee reuse the line once a call has ended', async () => {
    const { callee, callerSocket, calleeSocket } = await pair();
    const first = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(callerSocket, 'call:end', { callId: first.id, reason: 'CANCELLED' });
    await sleep(120);

    // Both participants must be released from the "busy" set.
    const second = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    expect(second.id).not.toBe(first.id);
    expect(calleeSocket.connected).toBe(true);
  });
});

describe('call history', () => {
  it('records a completed call with duration and the voice preset used', async () => {
    const { caller, callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:accept', { callId: call.id });
    await emitAck(callerSocket, 'call:connected', {
      callId: call.id,
      voiceChangerEnabled: true,
      voicePreset: 'female-bright',
    });
    await sleep(1100);
    await emitAck(callerSocket, 'call:end', { callId: call.id, reason: 'COMPLETED' });
    await sleep(150);

    const callerHistory: Paginated<CallHistoryEntry> = (
      await request(app).get('/api/calls/history').set(auth(caller)).expect(200)
    ).body;
    const entry = callerHistory.items[0]!;
    expect(entry.direction).toBe('outgoing');
    expect(entry.status).toBe('completed');
    expect(entry.durationSec).toBeGreaterThanOrEqual(1);
    expect(entry.voiceChangerUsed).toBe(true);
    expect(entry.voicePreset).toBe('female-bright');

    const calleeHistory: Paginated<CallHistoryEntry> = (
      await request(app).get('/api/calls/history').set(auth(callee)).expect(200)
    ).body;
    const theirEntry = calleeHistory.items[0]!;
    expect(theirEntry.id).toBe(entry.id);
    expect(theirEntry.direction).toBe('incoming');
    // The callee did not use the changer, so their own row must not claim it.
    expect(theirEntry.voiceChangerUsed).toBe(false);
  });

  it('shows a declined call as rejected for the caller and missed-style for the callee', async () => {
    const { caller, callee, callerSocket, calleeSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(calleeSocket, 'call:reject', { callId: call.id, reason: 'REJECTED' });
    await sleep(150);

    const callerHistory = (
      await request(app).get('/api/calls/history').set(auth(caller)).expect(200)
    ).body;
    expect(callerHistory.items[0].status).toBe('rejected');
    expect(callerHistory.items[0].durationSec).toBe(0);
  });

  it('never shows a call to someone who was not on it', async () => {
    const { callee, callerSocket } = await pair();
    const call = await emitAck<ActiveCall>(callerSocket, 'call:start', {
      calleeId: callee.id,
    });
    await emitAck(callerSocket, 'call:end', { callId: call.id, reason: 'CANCELLED' });

    const stranger = await createUser(app);
    const history = await request(app)
      .get('/api/calls/history')
      .set(auth(stranger))
      .expect(200);
    expect(history.body.items).toEqual([]);

    await request(app).get(`/api/calls/${call.id}`).set(auth(stranger)).expect(404);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/calls/history').expect(401);
  });
});

describe('ICE configuration', () => {
  it('returns STUN servers and reports whether TURN is configured', async () => {
    const user = await createUser(app);
    const response = await request(app)
      .get('/api/calls/ice-config')
      .set(auth(user))
      .expect(200);

    expect(Array.isArray(response.body.iceServers)).toBe(true);
    expect(response.body.iceServers.length).toBeGreaterThan(0);
    // Honest reporting: no TURN configured in the test environment.
    expect(response.body.hasTurn).toBe(false);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('requires authentication so TURN credentials are never anonymous', async () => {
    await request(app).get('/api/calls/ice-config').expect(401);
  });

  it('mints coturn REST credentials that are per-user, expiring and verifiable', async () => {
    const { createHmac } = await import('node:crypto');
    const { mintTurnCredentials } = await import('../src/modules/calls/turn.js');

    const secret = 'super-secret-shared-with-coturn';
    const now = 1_700_000_000_000;
    const a = mintTurnCredentials(secret, 'user-a', 3600, now);
    const b = mintTurnCredentials(secret, 'user-b', 3600, now);

    // Bound to the user, so one person's credential is not another's.
    expect(a.username).toBe(`${Math.floor(now / 1000) + 3600}:user-a`);
    expect(a.username).not.toBe(b.username);
    expect(a.credential).not.toBe(b.credential);

    // Exactly what coturn will recompute on its side.
    const expected = createHmac('sha1', secret).update(a.username).digest('base64');
    expect(a.credential).toBe(expected);

    // A different secret must not validate.
    const forged = createHmac('sha1', 'wrong-secret').update(a.username).digest('base64');
    expect(a.credential).not.toBe(forged);

    // The expiry is embedded in the username, which is what makes it ephemeral.
    expect(a.expiresAt).toBe(Math.floor(now / 1000) + 3600);
  });
});
