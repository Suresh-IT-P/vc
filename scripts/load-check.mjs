#!/usr/bin/env node
/**
 * Concurrent-write check against a running stack.
 *
 * WHY THIS EXISTS
 * "Can SQLite handle it?" is the first question the database choice invites, and
 * an architecture document asserting yes is not evidence. This fires every write
 * at once through the real path — socket → Zod → Prisma → SQLite → broadcast —
 * and reports what actually happened, including any `SQLITE_BUSY`.
 *
 * SQLite serialises writers, so the number to watch is not throughput but
 * whether serialisation surfaces as *errors*. With `journal_mode=WAL` and
 * `busy_timeout=5000` (set in apps/server/src/db.ts) contending writers wait
 * rather than fail, and that is what this asserts.
 *
 * It is not a benchmark: one machine, loopback, no think time. Treat the
 * writes/sec figure as a floor, and re-run it on hardware you care about.
 *
 *   npm run dev          # then, in another shell:
 *   npm run load-check
 */
import { io } from 'socket.io-client';
import { loadEnvIntoProcess } from './ensure-env.mjs';

loadEnvIntoProcess();

const API = 'http://localhost:4000';
const stamp = Date.now().toString(36);
// The per-socket message bucket is TokenBucket(20, 5): 20 burst, 5/sec refill.
// 16 sockets x 12 keeps every send inside the burst, so anything that fails is
// the database's fault rather than the app's own rate limiting.
const SOCKETS = 16;
const PER_SOCKET = 12;
const TOTAL = SOCKETS * PER_SOCKET;

const post = async (path, body, token) => {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (path, token) => {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const connect = (token) =>
  new Promise((res, rej) => {
    const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });

const ack = (socket, event, payload) =>
  new Promise((res) => {
    const timer = setTimeout(() => res({ ok: false, error: { message: 'timeout' } }), 30_000);
    socket.emit(event, payload, (r) => {
      clearTimeout(timer);
      res(r);
    });
  });

const a = await post('/api/auth/register', {
  email: `load.a.${stamp}@example.invalid`, username: `load.a.${stamp}`,
  displayName: `Load A ${stamp}`, password: 'Password123',
});
const b = await post('/api/auth/register', {
  email: `load.b.${stamp}@example.invalid`, username: `load.b.${stamp}`,
  displayName: `Load B ${stamp}`, password: 'Password123',
});

const convo = await post('/api/conversations', { userId: b.body.user.id }, a.body.accessToken);
const conversationId = convo.body.conversation.id;

// Several sockets for the same user, so writes genuinely interleave server-side.
const senders = await Promise.all(
  Array.from({ length: SOCKETS }, () => connect(a.body.accessToken)),
);

const started = Date.now();
const results = await Promise.all(
  Array.from({ length: TOTAL }, (_, i) =>
    ack(senders[i % SOCKETS], 'message:send', {
      conversationId,
      body: `concurrent ${i}`,
      clientId: `load-${stamp}-${i}`,
    }),
  ),
);
const elapsed = Date.now() - started;

const ok = results.filter((r) => r?.ok).length;
const failed = results.filter((r) => !r?.ok);
const busy = failed.filter((r) => /busy|locked|SQLITE/i.test(r?.error?.message ?? ''));

let persisted = 0;
let cursor = null;
for (let page = 0; page < 20; page += 1) {
  const url = `/api/conversations/${conversationId}/messages?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
  const res = await get(url, a.body.accessToken);
  const items = res.body?.items ?? [];
  persisted += items.filter((m) => m.body?.startsWith('concurrent ')).length;
  cursor = res.body?.nextCursor ?? null;
  if (!cursor || items.length === 0) break;
}

console.log(`sent          : ${TOTAL} across ${SOCKETS} sockets`);
console.log(`acknowledged  : ${ok}`);
console.log(`failed        : ${failed.length}${failed.length ? '  e.g. ' + failed[0]?.error?.message : ''}`);
console.log(`SQLITE_BUSY   : ${busy.length}`);
console.log(`persisted     : ${persisted}`);
console.log(`elapsed       : ${elapsed} ms  (${Math.round((TOTAL / elapsed) * 1000)} writes/sec)`);

for (const s of senders) s.close();

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
await prisma.conversation.deleteMany({
  where: { participants: { some: { userId: { in: [a.body.user.id, b.body.user.id] } } } },
});
await prisma.user.deleteMany({ where: { id: { in: [a.body.user.id, b.body.user.id] } } });
await prisma.$disconnect();

const pass = ok === TOTAL && busy.length === 0 && persisted === TOTAL;
console.log(`\n${pass ? 'PASS' : 'FAIL'} — ${TOTAL} concurrent writes, no lock contention errors`);
process.exit(pass ? 0 : 1);
