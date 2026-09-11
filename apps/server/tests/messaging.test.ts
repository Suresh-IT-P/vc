import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { auth, createUser, loadServer, startHarness, type TestHarness, type TestUser } from './helpers.js';

let harness: TestHarness;
let app: Express;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

beforeAll(async () => {
  harness = await startHarness();
  app = harness.app;
  [alice, bob, carol] = await Promise.all([
    createUser(app, { displayName: 'Alice Anders' }),
    createUser(app, { displayName: 'Bob Barnes' }),
    createUser(app, { displayName: 'Carol Chen' }),
  ]);
});

afterAll(async () => {
  await harness?.close();
  const { prisma } = await loadServer();
  await prisma.$disconnect();
});

async function openConversation(from: TestUser, to: TestUser): Promise<string> {
  const response = await request(app)
    .post('/api/conversations')
    .set(auth(from))
    .send({ userId: to.id });
  expect([200, 201]).toContain(response.status);
  return response.body.conversation.id;
}

describe('user search', () => {
  it('finds users by username and display name', async () => {
    const byUsername = await request(app)
      .get(`/api/users/search?q=${bob.username}`)
      .set(auth(alice))
      .expect(200);
    expect(byUsername.body.results.map((u: { id: string }) => u.id)).toContain(bob.id);

    const byName = await request(app)
      .get('/api/users/search?q=Barnes')
      .set(auth(alice))
      .expect(200);
    expect(byName.body.results.map((u: { id: string }) => u.id)).toContain(bob.id);
  });

  it('is case insensitive', async () => {
    const response = await request(app)
      .get('/api/users/search?q=BARNES')
      .set(auth(alice))
      .expect(200);
    expect(response.body.results.map((u: { id: string }) => u.id)).toContain(bob.id);
  });

  it('never includes the searcher themselves', async () => {
    const response = await request(app)
      .get(`/api/users/search?q=${alice.username}`)
      .set(auth(alice))
      .expect(200);
    expect(response.body.results.map((u: { id: string }) => u.id)).not.toContain(alice.id);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/users/search?q=anything').expect(401);
  });

  it('rejects an empty query', async () => {
    await request(app).get('/api/users/search?q=').set(auth(alice)).expect(400);
  });

  it('never leaks email addresses or password hashes', async () => {
    const response = await request(app)
      .get(`/api/users/search?q=${bob.username}`)
      .set(auth(alice))
      .expect(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(bob.email);
    expect(body).not.toContain('passwordHash');
  });
});

describe('conversations', () => {
  it('creates a conversation and is idempotent from both sides', async () => {
    const first = await request(app)
      .post('/api/conversations')
      .set(auth(alice))
      .send({ userId: bob.id })
      .expect(201);

    const again = await request(app)
      .post('/api/conversations')
      .set(auth(alice))
      .send({ userId: bob.id })
      .expect(200);
    expect(again.body.conversation.id).toBe(first.body.conversation.id);

    // Bob opening the chat from his side must resolve to the same thread.
    const fromBob = await request(app)
      .post('/api/conversations')
      .set(auth(bob))
      .send({ userId: alice.id })
      .expect(200);
    expect(fromBob.body.conversation.id).toBe(first.body.conversation.id);
    // Each side sees the *other* person as the peer.
    expect(first.body.conversation.peer.userId).toBe(bob.id);
    expect(fromBob.body.conversation.peer.userId).toBe(alice.id);
  });

  it('refuses a conversation with yourself', async () => {
    await request(app)
      .post('/api/conversations')
      .set(auth(alice))
      .send({ userId: alice.id })
      .expect(400);
  });

  it('404s for a non-existent user', async () => {
    await request(app)
      .post('/api/conversations')
      .set(auth(alice))
      .send({ userId: 'does-not-exist' })
      .expect(404);
  });

  it('hides a conversation from a non-participant', async () => {
    const conversationId = await openConversation(alice, bob);
    // Carol is not a member, so the thread must not even be confirmed to exist.
    await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set(auth(carol))
      .expect(404);
    await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set(auth(carol))
      .expect(404);
  });

  it('lists only the caller own conversations', async () => {
    await openConversation(alice, bob);
    const response = await request(app)
      .get('/api/conversations')
      .set(auth(carol))
      .expect(200);
    expect(response.body.conversations).toEqual([]);
  });
});

describe('blocking', () => {
  it('prevents conversation creation in both directions', async () => {
    const blocker = await createUser(app);
    const blocked = await createUser(app);

    await request(app)
      .post(`/api/users/${blocked.username}/block`)
      .set(auth(blocker))
      .send({ block: true })
      .expect(200);

    await request(app)
      .post('/api/conversations')
      .set(auth(blocker))
      .send({ userId: blocked.id })
      .expect(403);

    // And the blocked user cannot reach the blocker either.
    await request(app)
      .post('/api/conversations')
      .set(auth(blocked))
      .send({ userId: blocker.id })
      .expect(403);
  });

  it('removes blocked users from search results', async () => {
    const blocker = await createUser(app, { displayName: 'Zeta Unique' });
    const blocked = await createUser(app, { displayName: 'Zeta Unique' });

    await request(app)
      .post(`/api/users/${blocked.username}/block`)
      .set(auth(blocker))
      .send({ block: true })
      .expect(200);

    const response = await request(app)
      .get('/api/users/search?q=Zeta Unique')
      .set(auth(blocker))
      .expect(200);
    expect(response.body.results.map((u: { id: string }) => u.id)).not.toContain(blocked.id);
  });

  it('can be undone', async () => {
    const blocker = await createUser(app);
    const blocked = await createUser(app);
    await request(app)
      .post(`/api/users/${blocked.username}/block`)
      .set(auth(blocker))
      .send({ block: true })
      .expect(200);
    await request(app)
      .post(`/api/users/${blocked.username}/block`)
      .set(auth(blocker))
      .send({ block: false })
      .expect(200);
    await request(app)
      .post('/api/conversations')
      .set(auth(blocker))
      .send({ userId: blocked.id })
      .expect(201);
  });
});

describe('message persistence and authorisation', () => {
  it('stores messages in the database, not just in socket memory', async () => {
    const conversationId = await openConversation(alice, bob);
    const { prisma } = await loadServer();
    const messaging = await import('../src/modules/messaging/service.js');

    await messaging.sendMessage(alice.id, {
      conversationId,
      body: 'Persisted?',
      clientId: 'persist-1',
    });

    // Read it back straight from the database, bypassing every service layer.
    const row = await prisma.message.findFirst({
      where: { conversationId, body: 'Persisted?' },
    });
    expect(row).not.toBeNull();
    expect(row?.senderId).toBe(alice.id);

    const listed = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set(auth(bob))
      .expect(200);
    expect(listed.body.items.map((m: { body: string }) => m.body)).toContain('Persisted?');
  });

  it('is idempotent for a retried clientId', async () => {
    const conversationId = await openConversation(alice, bob);
    const messaging = await import('../src/modules/messaging/service.js');

    const first = await messaging.sendMessage(alice.id, {
      conversationId,
      body: 'Only once',
      clientId: 'retry-me',
    });
    const second = await messaging.sendMessage(alice.id, {
      conversationId,
      body: 'Only once',
      clientId: 'retry-me',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);

    const { prisma } = await loadServer();
    const count = await prisma.message.count({
      where: { conversationId, clientId: 'retry-me' },
    });
    expect(count).toBe(1);
  });

  it('refuses to send into a conversation you are not in', async () => {
    const conversationId = await openConversation(alice, bob);
    const messaging = await import('../src/modules/messaging/service.js');

    await expect(
      messaging.sendMessage(carol.id, {
        conversationId,
        body: 'I should not be here',
        clientId: 'intruder-1',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an empty or oversized body', async () => {
    const conversationId = await openConversation(alice, bob);
    const { sendMessageSchema } = await import('@sonder/shared');

    expect(
      sendMessageSchema.safeParse({ conversationId, body: '   ', clientId: 'x' }).success,
    ).toBe(false);
    expect(
      sendMessageSchema.safeParse({
        conversationId,
        body: 'a'.repeat(4001),
        clientId: 'x',
      }).success,
    ).toBe(false);
  });

  it('paginates history newest-page-first, oldest-within-page-first', async () => {
    const fresh = await createUser(app);
    const conversationId = await openConversation(alice, fresh);
    const messaging = await import('../src/modules/messaging/service.js');

    for (let i = 0; i < 10; i += 1) {
      await messaging.sendMessage(alice.id, {
        conversationId,
        body: `msg-${i}`,
        clientId: `page-${i}`,
      });
    }

    const first = await messaging.listMessages(alice.id, conversationId, { limit: 4 });
    expect(first.items).toHaveLength(4);
    // The newest four, in ascending order so the UI can append directly.
    expect(first.items.map((m) => m.body)).toEqual(['msg-6', 'msg-7', 'msg-8', 'msg-9']);
    expect(first.nextCursor).toBeTypeOf('string');

    const second = await messaging.listMessages(alice.id, conversationId, {
      limit: 4,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((m) => m.body)).toEqual(['msg-2', 'msg-3', 'msg-4', 'msg-5']);

    const third = await messaging.listMessages(alice.id, conversationId, {
      limit: 4,
      cursor: second.nextCursor!,
    });
    expect(third.items.map((m) => m.body)).toEqual(['msg-0', 'msg-1']);
    expect(third.nextCursor).toBeNull();
  });

  it('tracks unread counts and clears them on read', async () => {
    const reader = await createUser(app);
    const conversationId = await openConversation(alice, reader);
    const messaging = await import('../src/modules/messaging/service.js');

    for (let i = 0; i < 3; i += 1) {
      await messaging.sendMessage(alice.id, {
        conversationId,
        body: `unread-${i}`,
        clientId: `unread-${i}`,
      });
    }

    let conversation = await messaging.loadConversation(conversationId, reader.id);
    expect(conversation.unreadCount).toBe(3);
    // The sender has nothing unread in their own thread.
    expect((await messaging.loadConversation(conversationId, alice.id)).unreadCount).toBe(0);

    const result = await messaging.markRead(reader.id, conversationId);
    expect(result.messageIds).toHaveLength(3);

    conversation = await messaging.loadConversation(conversationId, reader.id);
    expect(conversation.unreadCount).toBe(0);
    expect(conversation.lastMessage?.status).toBe('read');
  });

  it('marks messages delivered without marking them read', async () => {
    const recipient = await createUser(app);
    const conversationId = await openConversation(alice, recipient);
    const messaging = await import('../src/modules/messaging/service.js');

    await messaging.sendMessage(alice.id, {
      conversationId,
      body: 'tick',
      clientId: 'tick-1',
    });

    const delivered = await messaging.markDelivered(recipient.id, conversationId);
    expect(delivered.messageIds).toHaveLength(1);

    const conversation = await messaging.loadConversation(conversationId, alice.id);
    expect(conversation.lastMessage?.status).toBe('delivered');
    expect(conversation.lastMessage?.readAt).toBeNull();
  });

  it('only lets the sender delete their own message', async () => {
    const conversationId = await openConversation(alice, bob);
    const messaging = await import('../src/modules/messaging/service.js');
    const { message } = await messaging.sendMessage(alice.id, {
      conversationId,
      body: 'mine to delete',
      clientId: 'del-1',
    });

    await expect(messaging.deleteMessage(bob.id, message.id)).rejects.toMatchObject({
      status: 403,
    });
    const deleted = await messaging.deleteMessage(alice.id, message.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.body).toBe('');
  });

  it('searches only within conversations you belong to', async () => {
    const conversationId = await openConversation(alice, bob);
    const messaging = await import('../src/modules/messaging/service.js');
    await messaging.sendMessage(alice.id, {
      conversationId,
      body: 'pomegranate marmalade',
      clientId: 'search-1',
    });

    const mine = await messaging.searchMessages(alice.id, 'pomegranate', { limit: 10 });
    expect(mine).toHaveLength(1);

    const theirs = await messaging.searchMessages(carol.id, 'pomegranate', { limit: 10 });
    expect(theirs).toHaveLength(0);
  });
});
