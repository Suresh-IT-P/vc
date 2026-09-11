import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type {
  ActiveCall,
  CallHistoryEntry,
  Conversation,
  Message,
  Paginated,
  PublicUser,
} from '@sonder/shared';
import {
  auth,
  closeSockets,
  connectSocket,
  emitAck,
  loadServer,
  sleep,
  startHarness,
  waitFor,
  type TestHarness,
  type TestSocket,
} from './helpers.js';

/**
 * THE ACCEPTANCE SCENARIO, executed end to end.
 *
 * This is the flow from the product spec, run as one continuous test against a
 * real HTTP server, a real Socket.IO server and a real database:
 *
 *   User A signs up and connects.   User B signs up and connects.
 *   A searches for B -> opens their profile -> Message -> "Hello!"
 *   B receives it instantly. A sees delivered, then read.
 *   A calls B. B gets an incoming call. B accepts.
 *   SDP offer/answer and ICE candidates are relayed between exactly the two of
 *   them. Both report a live peer connection; the call becomes CONNECTED.
 *   A reports the voice changer on with a preset. A hangs up.
 *   Both users' call history shows the call, with duration and preset.
 *
 * WHAT THIS TEST CANNOT DO, and why that is stated rather than faked:
 * Node has no WebRTC stack, so `call:connected` here is reported by the test in
 * the same way a browser's RTCPeerConnection would report it. The transport
 * itself (ICE, DTLS-SRTP, Opus) is the browser's, and is exercised by running
 * the app in two browsers — see docs/testing.md "Manual WebRTC verification".
 * The audio half of the feature — that the voice is genuinely converted — is
 * verified numerically and independently in apps/web/src/voice/dsp-core.test.ts.
 */

let harness: TestHarness;
let app: Express;
const open: TestSocket[] = [];

beforeAll(async () => {
  harness = await startHarness();
  app = harness.app;
});

afterAll(async () => {
  closeSockets(...open.splice(0));
  await sleep(150);
  await harness?.close();
  const { prisma } = await loadServer();
  await prisma.$disconnect();
});

describe('acceptance: message, call, convert, hang up', () => {
  it('completes the full scenario', async () => {
    /* ---- 1. Both users sign up ---------------------------------------- */
    const alice = (
      await request(app)
        .post('/api/auth/register')
        .send({
          email: 'acceptance.alice@example.com',
          username: 'acceptance.alice',
          displayName: 'Alice Acceptance',
          password: 'Password123',
        })
        .expect(201)
    ).body as { user: PublicUser; accessToken: string };

    const bob = (
      await request(app)
        .post('/api/auth/register')
        .send({
          email: 'acceptance.bob@example.com',
          username: 'acceptance.bob',
          displayName: 'Bob Acceptance',
          password: 'Password123',
        })
        .expect(201)
    ).body as { user: PublicUser; accessToken: string };

    /* ---- 2. Both connect (two "browsers") ------------------------------ */
    const aliceSocket = await connectSocket(harness.url, alice.accessToken);
    const bobSocket = await connectSocket(harness.url, bob.accessToken);
    open.push(aliceSocket, bobSocket);
    await sleep(120);

    /* ---- 3. A searches for B ------------------------------------------ */
    const search = await request(app)
      .get('/api/users/search?q=Bob Acceptance')
      .set({ Authorization: `Bearer ${alice.accessToken}` })
      .expect(200);

    const found = (search.body.results as PublicUser[]).find(
      (user) => user.id === bob.user.id,
    );
    expect(found, 'B must be findable by display name').toBeDefined();
    expect(found?.isOnline, 'B must show as online').toBe(true);

    /* ---- 4. A opens B's profile --------------------------------------- */
    const profile = await request(app)
      .get(`/api/users/${bob.user.username}`)
      .set({ Authorization: `Bearer ${alice.accessToken}` })
      .expect(200);
    expect(profile.body.user.id).toBe(bob.user.id);
    expect(profile.body.user.viewer.isSelf).toBe(false);

    /* ---- 5. A taps Message: the real conversation opens ---------------- */
    const created = await request(app)
      .post('/api/conversations')
      .set({ Authorization: `Bearer ${alice.accessToken}` })
      .send({ userId: bob.user.id })
      .expect(201);
    const conversation = created.body.conversation as Conversation;
    expect(conversation.peer.userId).toBe(bob.user.id);

    await emitAck(bobSocket, 'conversation:join', { conversationId: conversation.id });

    /* ---- 6. A sends "Hello!" and B receives it instantly --------------- */
    const inbound = waitFor<Message>(bobSocket, 'message:new');
    const sent = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId: conversation.id,
      body: 'Hello!',
      clientId: 'acceptance-hello',
    });

    const received = await inbound;
    expect(received.body).toBe('Hello!');
    expect(received.id).toBe(sent.id);
    // B was online, so it is delivered the moment it is stored.
    expect(sent.status).toBe('delivered');

    // ...and it is genuinely in the database, not just in socket memory.
    const { prisma } = await loadServer();
    const persisted = await prisma.message.findUnique({ where: { id: sent.id } });
    expect(persisted?.body).toBe('Hello!');

    /* ---- 7. B reads it; A sees the read receipt ------------------------ */
    const readReceipt = waitFor<{ messageIds: string[] }>(aliceSocket, 'message:read');
    await emitAck(bobSocket, 'message:read', { conversationId: conversation.id });
    expect((await readReceipt).messageIds).toContain(sent.id);

    /* ---- 8. A taps Call ------------------------------------------------ */
    const incoming = waitFor<ActiveCall>(bobSocket, 'call:incoming');
    const call = await emitAck<ActiveCall>(aliceSocket, 'call:start', {
      calleeId: bob.user.id,
      conversationId: conversation.id,
    });
    expect(call.state).toBe('RINGING');

    /* ---- 9. B sees the incoming call ---------------------------------- */
    const ring = await incoming;
    expect(ring.id).toBe(call.id);
    expect(ring.direction).toBe('incoming');
    expect(ring.peer.displayName).toBe('Alice Acceptance');

    /* ---- 10. B accepts ------------------------------------------------- */
    const acceptedAtCaller = waitFor<{ callId: string }>(aliceSocket, 'call:accepted');
    await emitAck(bobSocket, 'call:accept', { callId: call.id });
    expect((await acceptedAtCaller).callId).toBe(call.id);

    /* ---- 11. WebRTC negotiation is relayed between exactly these two --- */
    const offerAtBob = waitFor<{ from: string; description: { sdp: string } }>(
      bobSocket,
      'webrtc:offer',
    );
    await emitAck(aliceSocket, 'webrtc:offer', {
      callId: call.id,
      description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    });
    const relayedOffer = await offerAtBob;
    expect(relayedOffer.from).toBe(alice.user.id);
    expect(relayedOffer.description.sdp).toContain('m=audio');

    const answerAtAlice = waitFor<{ from: string }>(aliceSocket, 'webrtc:answer');
    await emitAck(bobSocket, 'webrtc:answer', {
      callId: call.id,
      description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    });
    expect((await answerAtAlice).from).toBe(bob.user.id);

    const candidateAtBob = waitFor<{ candidate: { candidate: string } }>(
      bobSocket,
      'webrtc:ice-candidate',
    );
    aliceSocket.emit('webrtc:ice-candidate', {
      callId: call.id,
      candidate: {
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.10 51820 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    expect((await candidateAtBob).candidate.candidate).toContain('typ host');

    /* ---- 12. Both peers report a live connection ----------------------- */
    // In a browser this fires from RTCPeerConnection.connectionState ===
    // 'connected'. Nothing else can promote the call, so "Connected" in the UI
    // always means a real transport exists.
    const connectedAtBob = waitFor<{ callId: string }>(bobSocket, 'call:connected');
    await emitAck(aliceSocket, 'call:connected', {
      callId: call.id,
      // 13. A turns the voice changer on: Female Natural.
      voiceChangerEnabled: true,
      voicePreset: 'female-natural',
    });
    await emitAck(bobSocket, 'call:connected', {
      callId: call.id,
      voiceChangerEnabled: false,
      voicePreset: null,
    });
    expect((await connectedAtBob).callId).toBe(call.id);

    const { registry } = await loadServer();
    expect(registry.getCall(call.id)?.state).toBe('CONNECTED');

    /* ---- 14. B is told that A is transforming their voice -------------- */
    const voiceNotice = waitFor<{ enabled: boolean; preset: string | null }>(
      bobSocket,
      'call:peer-voice',
    );
    aliceSocket.emit('call:voice-state', {
      callId: call.id,
      enabled: true,
      preset: 'female-bright',
    });
    const notice = await voiceNotice;
    expect(notice.enabled).toBe(true);
    expect(notice.preset).toBe('female-bright');

    /* ---- 15. A hangs up ------------------------------------------------ */
    await sleep(1100); // so the recorded duration is non-zero
    const endedAtBob = waitFor<{ reason: string; durationSec: number }>(
      bobSocket,
      'call:ended',
    );
    await emitAck(aliceSocket, 'call:end', { callId: call.id, reason: 'COMPLETED' });

    const ended = await endedAtBob;
    expect(ended.reason).toBe('COMPLETED');
    expect(ended.durationSec).toBeGreaterThanOrEqual(1);
    await sleep(150);

    /* ---- 16. Both see the call in history ------------------------------ */
    const aliceHistory: Paginated<CallHistoryEntry> = (
      await request(app)
        .get('/api/calls/history')
        .set({ Authorization: `Bearer ${alice.accessToken}` })
        .expect(200)
    ).body;
    const aliceEntry = aliceHistory.items[0]!;
    expect(aliceEntry.peer.id).toBe(bob.user.id);
    expect(aliceEntry.direction).toBe('outgoing');
    expect(aliceEntry.status).toBe('completed');
    expect(aliceEntry.durationSec).toBeGreaterThanOrEqual(1);
    // A's own row records the changer; B's does not.
    expect(aliceEntry.voiceChangerUsed).toBe(true);
    expect(aliceEntry.voicePreset).toBe('female-bright');

    const bobHistory: Paginated<CallHistoryEntry> = (
      await request(app)
        .get('/api/calls/history')
        .set({ Authorization: `Bearer ${bob.accessToken}` })
        .expect(200)
    ).body;
    const bobEntry = bobHistory.items[0]!;
    expect(bobEntry.id).toBe(aliceEntry.id);
    expect(bobEntry.direction).toBe('incoming');
    expect(bobEntry.status).toBe('completed');
    expect(bobEntry.voiceChangerUsed).toBe(false);

    /* ---- 17. The line is free again ------------------------------------ */
    expect(registry.getActiveCallIdFor(alice.user.id)).toBeUndefined();
    expect(registry.getActiveCallIdFor(bob.user.id)).toBeUndefined();
  }, 45_000);
});
