import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Conversation, Message, PresenceUpdate, TypingState } from '@sonder/shared';
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
  waitForMatching,
  type TestHarness,
  type TestSocket,
  type TestUser,
} from './helpers.js';

let harness: TestHarness;
let app: Express;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
const open: TestSocket[] = [];

async function connect(user: TestUser): Promise<TestSocket> {
  const socket = await connectSocket(harness.url, user.accessToken);
  open.push(socket);
  return socket;
}

beforeAll(async () => {
  harness = await startHarness();
  app = harness.app;
  alice = await createUser(app, { displayName: 'Alice Realtime' });
  bob = await createUser(app, { displayName: 'Bob Realtime' });
  carol = await createUser(app, { displayName: 'Carol Realtime' });
});

afterEach(async () => {
  closeSockets(...open.splice(0));
  // Let disconnect handlers finish before the next test asserts on presence.
  await sleep(120);
});

afterAll(async () => {
  await harness?.close();
  const { prisma } = await loadServer();
  await prisma.$disconnect();
});

async function conversationFor(a: TestUser, b: TestUser): Promise<string> {
  const response = await request(app)
    .post('/api/conversations')
    .set(auth(a))
    .send({ userId: b.id });
  return response.body.conversation.id;
}

describe('socket authentication', () => {
  it('refuses a connection with no token', async () => {
    await expect(connectSocket(harness.url, '')).rejects.toThrow();
  });

  it('refuses a connection with a garbage token', async () => {
    await expect(connectSocket(harness.url, 'nonsense.token.here')).rejects.toThrow();
  });

  it('accepts a valid token', async () => {
    const socket = await connect(alice);
    expect(socket.connected).toBe(true);
  });
});

describe('presence', () => {
  it('tells a conversation partner when someone comes online and goes offline', async () => {
    await conversationFor(alice, bob);

    const bobSocket = await connect(bob);
    // Bob also receives his own presence echo, so filter for Alice's.
    const onlinePromise = waitForMatching<PresenceUpdate>(
      bobSocket,
      'user:online',
      (p) => p.userId === alice.id,
    );

    const aliceSocket = await connect(alice);
    const online = await onlinePromise;
    expect(online.userId).toBe(alice.id);
    expect(online.state).toBe('online');

    const offlinePromise = waitForMatching<PresenceUpdate>(
      bobSocket,
      'user:offline',
      (p) => p.userId === alice.id,
    );
    aliceSocket.close();
    const offline = await offlinePromise;
    expect(offline.userId).toBe(alice.id);
    expect(offline.state).toBe('offline');
  });

  it('does not broadcast presence to unrelated users', async () => {
    // Carol shares no conversation with the new user, so must hear nothing.
    const stranger = await createUser(app);
    const carolSocket = await connect(carol);

    let heard = false;
    carolSocket.on('user:online', (payload: PresenceUpdate) => {
      if (payload.userId === stranger.id) heard = true;
    });

    await connect(stranger);
    await sleep(300);
    expect(heard).toBe(false);
  });

  it('answers presence:subscribe with live state', async () => {
    const aliceSocket = await connect(alice);
    await connect(bob);
    await sleep(100);

    const states = await emitAck<PresenceUpdate[]>(aliceSocket, 'presence:subscribe', {
      userIds: [bob.id, carol.id],
    });
    const byId = new Map(states.map((s) => [s.userId, s.state]));
    expect(byId.get(bob.id)).toBe('online');
    expect(byId.get(carol.id)).toBe('offline');
  });

  it('stays online while a second tab is still connected', async () => {
    await conversationFor(alice, bob);
    const bobSocket = await connect(bob);

    const tabOne = await connect(alice);
    await connect(alice); // second tab
    await sleep(150);

    let wentOffline = false;
    bobSocket.on('user:offline', (payload: PresenceUpdate) => {
      if (payload.userId === alice.id) wentOffline = true;
    });

    tabOne.close();
    await sleep(300);
    // One tab closing must not mark the person offline.
    expect(wentOffline).toBe(false);
  });
});

describe('real-time messaging', () => {
  it('delivers a message to the recipient instantly', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    await emitAck(bobSocket, 'conversation:join', { conversationId });
    const incoming = waitFor<Message>(bobSocket, 'message:new');

    const sent = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId,
      body: 'Hello!',
      clientId: 'live-1',
    });

    const received = await incoming;
    expect(received.id).toBe(sent.id);
    expect(received.body).toBe('Hello!');
    expect(received.senderId).toBe(alice.id);
  });

  it('marks a message delivered immediately when the recipient is online', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    await connect(bob);
    await sleep(120);

    const sent = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId,
      body: 'Are you there?',
      clientId: 'delivered-1',
    });
    expect(sent.status).toBe('delivered');
    expect(sent.deliveredAt).not.toBeNull();
  });

  it('leaves a message merely sent when the recipient is offline, then delivers on reconnect', async () => {
    const offlineUser = await createUser(app);
    const conversationId = await conversationFor(alice, offlineUser);
    const aliceSocket = await connect(alice);

    const sent = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId,
      body: 'Catch up later',
      clientId: 'offline-1',
    });
    expect(sent.status).toBe('sent');

    const deliveredPromise = waitFor<{ messageIds: string[] }>(
      aliceSocket,
      'message:delivered',
    );
    await connect(offlineUser);
    const delivered = await deliveredPromise;
    expect(delivered.messageIds).toContain(sent.id);
  });

  it('notifies the sender when the recipient reads', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);
    await sleep(120);

    const sent = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId,
      body: 'Please read this',
      clientId: 'read-1',
    });

    const readPromise = waitFor<{ messageIds: string[]; userId: string }>(
      aliceSocket,
      'message:read',
    );
    await emitAck(bobSocket, 'message:read', { conversationId });
    const read = await readPromise;
    expect(read.messageIds).toContain(sent.id);
    expect(read.userId).toBe(bob.id);
  });

  it('mirrors sent messages to the sender other tabs', async () => {
    const conversationId = await conversationFor(alice, bob);
    const tabOne = await connect(alice);
    const tabTwo = await connect(alice);

    const mirrored = waitFor<Message>(tabTwo, 'message:new');
    await emitAck(tabOne, 'message:send', {
      conversationId,
      body: 'Typed on my laptop',
      clientId: 'mirror-1',
    });
    expect((await mirrored).body).toBe('Typed on my laptop');
  });

  it('refuses to join a conversation you are not part of', async () => {
    const conversationId = await conversationFor(alice, bob);
    const carolSocket = await connect(carol);

    await expect(
      emitAck(carolSocket, 'conversation:join', { conversationId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to send into a conversation you are not part of', async () => {
    const conversationId = await conversationFor(alice, bob);
    const carolSocket = await connect(carol);

    await expect(
      emitAck(carolSocket, 'message:send', {
        conversationId,
        body: 'let me in',
        clientId: 'intrude-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an empty message body', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    await expect(
      emitAck(aliceSocket, 'message:send', {
        conversationId,
        body: '   ',
        clientId: 'empty-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('does not duplicate a message when the same clientId is retried', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);

    const first = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId,
      body: 'exactly once',
      clientId: 'dedupe-socket-1',
    });
    const second = await emitAck<Message>(aliceSocket, 'message:send', {
      conversationId,
      body: 'exactly once',
      clientId: 'dedupe-socket-1',
    });
    expect(second.id).toBe(first.id);
  });

  it('pushes a new conversation to the other participant', async () => {
    const newcomer = await createUser(app);
    const newcomerSocket = await connect(newcomer);
    const aliceSocket = await connect(alice);

    const created = waitFor<Conversation>(newcomerSocket, 'conversation:created');
    await emitAck(aliceSocket, 'conversation:create', { userId: newcomer.id });

    const conversation = await created;
    // Rendered from the recipient's perspective: their peer is Alice.
    expect(conversation.peer.userId).toBe(alice.id);
  });
});

describe('typing indicator', () => {
  it('relays start and stop to the peer only', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);
    const carolSocket = await connect(carol);

    let carolHeard = false;
    carolSocket.on('typing:start', () => {
      carolHeard = true;
    });

    const started = waitFor<TypingState>(bobSocket, 'typing:start');
    aliceSocket.emit('typing:start', { conversationId });
    const startPayload = await started;
    expect(startPayload.userId).toBe(alice.id);
    expect(startPayload.isTyping).toBe(true);

    const stopped = waitFor<TypingState>(bobSocket, 'typing:stop');
    aliceSocket.emit('typing:stop', { conversationId });
    expect((await stopped).isTyping).toBe(false);

    expect(carolHeard).toBe(false);
  });

  it('stops typing automatically when the message is sent', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    aliceSocket.emit('typing:start', { conversationId });
    await waitFor(bobSocket, 'typing:start');

    const stopped = waitFor<TypingState>(bobSocket, 'typing:stop');
    await emitAck(aliceSocket, 'message:send', {
      conversationId,
      body: 'done typing',
      clientId: 'typing-send-1',
    });
    expect((await stopped).userId).toBe(alice.id);
  });

  it('expires on its own if the typist goes quiet', async () => {
    const conversationId = await conversationFor(alice, bob);
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    aliceSocket.emit('typing:start', { conversationId });
    await waitFor(bobSocket, 'typing:start');

    // TYPING_TIMEOUT_MS is 4 s; the server must clear it without being told.
    const stopped = await waitFor<TypingState>(bobSocket, 'typing:stop', 8000);
    expect(stopped.conversationId).toBe(conversationId);
  });
});
