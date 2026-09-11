#!/usr/bin/env node
/**
 * End-to-end check against a *running* stack.
 *
 * WHY THIS EXISTS
 * The unit and integration suites build their own throwaway server in-process.
 * That is the right shape for testing authorisation and state machines, but it
 * never proves the thing you actually deploy works: the compiled `dist/`, the
 * real `.env`, a real HTTP listener, real Socket.IO transport, and the web app
 * serving the AudioWorklet bundle the voice changer depends on.
 *
 * This walks the product's own acceptance scenario over the network — two
 * accounts, search, message, delivery, call, accept, SDP relay, connect,
 * voice-changer notice, hang-up, history — then cleans up after itself.
 *
 *   npm run smoke                 # against localhost
 *   SMOKE_API_URL=https://... npm run smoke
 *   npm run smoke -- --api-only   # skip the web-app checks
 */
import { io } from 'socket.io-client';
import { loadEnvIntoProcess } from './ensure-env.mjs';

loadEnvIntoProcess();

const args = new Set(process.argv.slice(2));
const apiOnly = args.has('--api-only');

const API =
  process.env.SMOKE_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const WEB =
  process.env.SMOKE_WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? '3000'}`;

const stamp = Date.now().toString(36);
const TIMEOUT = 10_000;

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = '') {
  const suffix = detail ? `  — ${detail}` : '';
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${suffix}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${suffix}`);
  }
  return ok;
}

const section = (title) => console.log(`\n${title}`);

/* -- HTTP helpers ---------------------------------------------------------- */

async function request(method, path, { body, token, base = API } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

const get = (path, token) => request('GET', path, { token });
const post = (path, body, token) => request('POST', path, { body, token });

/* -- Socket helpers -------------------------------------------------------- */

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('socket connect timed out')), TIMEOUT);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Emit and await the server's acknowledgement, failing on its error contract. */
const ack = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} was never acknowledged`)), TIMEOUT);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      if (response?.ok) resolve(response.data);
      else reject(new Error(`${event}: ${response?.error?.message ?? 'rejected'}`));
    });
  });

const once = (socket, event, ms = TIMEOUT) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${event}" received`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ========================================================================== */

console.log(`Sonder smoke test\n  API ${API}${apiOnly ? '' : `\n  web ${WEB}`}`);

const sockets = [];
let created = null;

try {
  /* -- 1. The API is up and its dependencies answer ------------------------ */
  section('Service health');

  let health;
  try {
    health = await get('/health');
  } catch (error) {
    console.error(
      `\nCannot reach the API at ${API}.\n` +
        `Start it first:  npm run dev   (or npm start)\n\n${error.message}\n`,
    );
    process.exit(1);
  }
  check(health.status === 200, 'GET /health', `status ${health.status}`);

  const ready = await get('/health/ready');
  check(ready.status === 200, 'GET /health/ready reports the database reachable', ready.body?.database);
  check(
    typeof ready.body?.turn === 'string' || typeof ready.body?.turn === 'boolean',
    'readiness reports TURN status honestly',
    `turn=${JSON.stringify(ready.body?.turn)}`,
  );

  /* -- 2. The web app serves, including the worklet the DSP needs ---------- */
  if (!apiOnly) {
    section('Web app');
    let page;
    try {
      page = await request('GET', '/login', { base: WEB });
    } catch (error) {
      check(false, `web app reachable at ${WEB}`, error.message);
    }
    if (page) {
      check(page.status === 200, 'GET /login renders', `status ${page.status}`);

      const worklet = await request('GET', '/worklets/voice-processor.js', { base: WEB });
      check(worklet.status === 200, 'GET /worklets/voice-processor.js', `status ${worklet.status}`);
      // A 200 that is not the bundle is the dangerous case: addModule() would
      // reject at call time and the voice changer would be unavailable.
      check(
        worklet.text.includes("registerProcessor('sonder-voice-processor'"),
        'worklet bundle registers the processor',
        `${Math.round(worklet.text.length / 1024)} kB`,
      );
      // Anchored to line starts: the bundle's own comments discuss imports at
      // length, and a loose match would flag prose as module syntax.
      check(
        !/^[ \t]*(?:import|export)[ \t]/m.test(worklet.text),
        'worklet bundle is a classic script (no ESM syntax)',
      );
      check(
        /no-cache/.test(worklet.headers.get('cache-control') ?? ''),
        'worklet is served no-cache so a deploy cannot leave a stale DSP',
        worklet.headers.get('cache-control') ?? '(none)',
      );
    }
  }

  /* -- 3. Auth ------------------------------------------------------------- */
  section('Accounts and authentication');

  const makeUser = (tag, displayName) =>
    post('/api/auth/register', {
      email: `smoke.${tag}.${stamp}@example.invalid`,
      username: `smoke.${tag}.${stamp}`,
      displayName,
      password: 'Password123',
    });

  const a = await makeUser('a', `Smoke Alpha ${stamp}`);
  const b = await makeUser('b', `Smoke Bravo ${stamp}`);
  check(a.status === 201 && b.status === 201, 'two accounts registered', `${a.status}/${b.status}`);
  if (a.status !== 201 || b.status !== 201) throw new Error('registration failed; cannot continue');
  created = { a: a.body.user.id, b: b.body.user.id };

  check(
    !a.text.includes('passwordHash'),
    'the password hash is not in the registration response',
  );

  const login = await post('/api/auth/login', {
    identifier: `smoke.a.${stamp}`,
    password: 'Password123',
  });
  check(login.status === 200 && Boolean(login.body?.accessToken), 'login by username returns a token');

  const wrong = await post('/api/auth/login', {
    identifier: `smoke.a.${stamp}`,
    password: 'WrongPassword1',
  });
  check(wrong.status === 401, 'a wrong password is rejected', `status ${wrong.status}`);

  const unauthed = await get('/api/auth/me');
  check(unauthed.status === 401, 'a protected route requires a token', `status ${unauthed.status}`);

  /* -- 4. Sockets and presence -------------------------------------------- */
  section('Real-time transport');

  let rejected = false;
  try {
    const bad = await connect('not-a-real-token');
    sockets.push(bad);
  } catch {
    rejected = true;
  }
  check(rejected, 'the socket handshake rejects an invalid token');

  const sa = await connect(a.body.accessToken);
  const sb = await connect(b.body.accessToken);
  sockets.push(sa, sb);
  check(sa.connected && sb.connected, 'both users hold an authenticated socket');

  await wait(250);

  /* -- 5. Search and messaging -------------------------------------------- */
  section('Search and messaging');

  const search = await get(
    `/api/users/search?q=${encodeURIComponent(`Smoke Bravo ${stamp}`)}`,
    a.body.accessToken,
  );
  const found = search.body?.results?.find((u) => u.id === created.b);
  check(Boolean(found), 'A finds B by display name');
  check(found?.isOnline === true, 'B is reported online (live presence, not a stored flag)');
  check(
    found !== undefined && !('email' in found),
    'search results do not leak email addresses',
  );

  const conversation = await post('/api/conversations', { userId: created.b }, a.body.accessToken);
  check(conversation.status === 201, 'conversation created', `status ${conversation.status}`);
  const conversationId = conversation.body.conversation.id;

  const again = await post('/api/conversations', { userId: created.b }, a.body.accessToken);
  check(
    again.body?.conversation?.id === conversationId,
    'opening the same conversation twice returns one row (idempotent)',
  );

  await ack(sb, 'conversation:join', { conversationId });
  const inbound = once(sb, 'message:new');
  const sent = await ack(sa, 'message:send', {
    conversationId,
    body: 'Hello!',
    clientId: `smoke-${stamp}`,
  });
  const delivered = await inbound;
  check(delivered.body === 'Hello!' && delivered.id === sent.id, 'the message arrives in real time');
  check(sent.status === 'delivered', 'it is marked delivered because B is online', sent.status);

  const retry = await ack(sa, 'message:send', {
    conversationId,
    body: 'Hello!',
    clientId: `smoke-${stamp}`,
  });
  check(retry.id === sent.id, 'a retried clientId does not create a duplicate');

  const persisted = await get(
    `/api/conversations/${conversationId}/messages`,
    b.body.accessToken,
  );
  check(
    persisted.body?.items?.some((m) => m.id === sent.id),
    'the message is persisted and readable by the recipient',
  );

  const receipt = once(sa, 'message:read');
  await ack(sb, 'message:read', { conversationId, messageId: sent.id });
  const read = await receipt;
  check(Boolean(read), 'the read receipt reaches the sender');

  const typing = once(sb, 'typing:start');
  sa.emit('typing:start', { conversationId });
  const typingPayload = await typing.catch(() => null);
  check(
    typingPayload?.conversationId === conversationId,
    'typing indicators are relayed to the peer',
  );

  /* -- 6. Calling ---------------------------------------------------------- */
  section('Call signalling');

  const ringing = once(sb, 'call:incoming');
  const call = await ack(sa, 'call:start', { calleeId: created.b, conversationId });
  const incoming = await ringing;
  check(
    incoming.id === call.id && incoming.direction === 'incoming',
    "B's device rings for the call A placed",
  );

  const acceptedAtA = once(sa, 'call:accepted');
  await ack(sb, 'call:accept', { callId: call.id });
  await acceptedAtA;
  check(true, 'B accepts and A is notified');

  const offerAtB = once(sb, 'webrtc:offer');
  const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  await ack(sa, 'webrtc:offer', { callId: call.id, description: { type: 'offer', sdp } });
  const relayed = await offerAtB;
  check(relayed.description.sdp === sdp, 'SDP is relayed byte-for-byte; the server does not rewrite it');

  const answerAtA = once(sa, 'webrtc:answer');
  await ack(sb, 'webrtc:answer', {
    callId: call.id,
    description: { type: 'answer', sdp: sdp.replace('m=audio 9', 'm=audio 10') },
  });
  check(Boolean(await answerAtA), 'the answer is relayed back to the caller');

  // ICE candidates are deliberately unacknowledged: they arrive in bursts and a
  // per-candidate round trip would cost latency for nothing.
  const candidateAtB = once(sb, 'webrtc:ice-candidate');
  sa.emit('webrtc:ice-candidate', {
    callId: call.id,
    candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 51234 typ host', sdpMid: '0' },
  });
  const candidate = await candidateAtB.catch(() => null);
  check(
    Boolean(candidate?.candidate?.candidate?.includes('typ host')),
    'ICE candidates are relayed (fire-and-forget by design)',
  );

  const connectedAtB = once(sb, 'call:connected');
  await ack(sa, 'call:connected', {
    callId: call.id,
    voiceChangerEnabled: true,
    voicePreset: 'female-natural',
  });
  await ack(sb, 'call:connected', { callId: call.id });
  await connectedAtB;
  check(true, 'CONNECTED is reached only because a client reported its peer connection');

  const notice = once(sb, 'call:peer-voice');
  sa.emit('call:voice-state', { callId: call.id, enabled: true, preset: 'female-natural' });
  const voice = await notice;
  check(voice.enabled === true, 'the peer is told the voice changer is on (disclosure is not optional)');

  const ice = await get('/api/calls/ice-config', a.body.accessToken);
  check(
    Array.isArray(ice.body?.iceServers) && ice.body.iceServers.length > 0,
    'ICE configuration is served',
    `hasTurn=${ice.body?.hasTurn}`,
  );

  await wait(1100);
  const endedAtB = once(sb, 'call:ended');
  await ack(sa, 'call:end', { callId: call.id, reason: 'COMPLETED' });
  const ended = await endedAtB;
  check(
    ended.reason === 'COMPLETED' && ended.durationSec >= 1,
    'the call ends with a real measured duration',
    `${ended.durationSec}s`,
  );

  await wait(300);
  const historyA = await get('/api/calls/history', a.body.accessToken);
  const historyB = await get('/api/calls/history', b.body.accessToken);
  const rowA = historyA.body?.items?.find((item) => item.id === call.id);
  const rowB = historyB.body?.items?.find((item) => item.id === call.id);
  check(Boolean(rowA && rowB), 'both participants see the call in their history');
  check(rowA?.voiceChangerUsed === true, "A's row records the preset A used", rowA?.voicePreset);
  check(
    rowB?.voiceChangerUsed === false,
    "B's row does not claim B used a voice changer (per-participant, not per-call)",
  );

  const second = await ack(sa, 'call:start', { calleeId: created.b, conversationId });
  check(Boolean(second?.id), 'the line is free again afterwards');
  await ack(sa, 'call:end', { callId: second.id, reason: 'CANCELLED' });
} catch (error) {
  failed += 1;
  failures.push(error.message);
  console.log(`  FAIL  ${error.message}`);
} finally {
  for (const socket of sockets) socket.close();

  /* Leave the database as we found it. */
  if (created) {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      await prisma.conversation.deleteMany({
        where: { participants: { some: { userId: { in: [created.a, created.b] } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: [created.a, created.b] } } });
      await prisma.$disconnect();
      console.log('\n  (cleaned up the two smoke accounts)');
    } catch (error) {
      console.log(`\n  note: could not clean up smoke accounts — ${error.message.split('\n')[0]}`);
    }
  }
}

console.log(`\n${'-'.repeat(60)}`);
if (failed === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`);
} else {
  console.log(`${passed} passed, ${failed} FAILED:`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed === 0 ? 0 : 1);
