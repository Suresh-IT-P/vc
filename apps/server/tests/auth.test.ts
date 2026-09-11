import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createUser, auth, loadServer, startHarness, type TestHarness } from './helpers.js';

let harness: TestHarness;
let app: Express;

beforeAll(async () => {
  harness = await startHarness();
  app = harness.app;
});

afterAll(async () => {
  await harness?.close();
  const { prisma } = await loadServer();
  await prisma.$disconnect();
});

/** Pulls the sonder_rt value out of a response's Set-Cookie header. */
function refreshCookieOf(response: request.Response): string | undefined {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = cookies.find((c) => c.startsWith('sonder_rt='));
  return match ? match.slice('sonder_rt='.length).split(';')[0] : undefined;
}

describe('registration', () => {
  it('creates an account and returns a session', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'newperson@example.com',
        username: 'newperson',
        displayName: 'New Person',
        password: 'Password123',
      })
      .expect(201);

    expect(response.body.user.username).toBe('newperson');
    expect(response.body.accessToken).toBeTypeOf('string');
    // The password hash must never cross the wire.
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    // Refresh token lives in an httpOnly cookie, not the JSON body.
    expect(response.body.refreshToken).toBeUndefined();
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('sonder_rt=') && c.includes('HttpOnly'))).toBe(true);
  });

  it('rejects a duplicate username', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        email: 'other@example.com',
        username: 'newperson',
        displayName: 'Impostor',
        password: 'Password123',
      })
      .expect(409);
  });

  it('rejects a duplicate email', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'newperson@example.com',
        username: 'differentname',
        displayName: 'Other',
        password: 'Password123',
      })
      .expect(409);
    expect(response.body.error.code).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['short password', { password: 'abc1' }],
    ['password with no digit', { password: 'onlyletters' }],
    ['uppercase username', { username: 'NotAllowed' }],
    ['username with spaces', { username: 'has spaces' }],
    ['invalid email', { email: 'not-an-email' }],
  ])('rejects %s', async (_label, override) => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'valid@example.com',
        username: 'validname',
        displayName: 'Valid',
        password: 'Password123',
        ...override,
      })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.details.fields.length).toBeGreaterThan(0);
  });

  it('rejects reserved usernames', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        email: 'admin@example.com',
        username: 'admin',
        displayName: 'Admin',
        password: 'Password123',
      })
      .expect(409);
  });
});

describe('login', () => {
  it('accepts either username or email', async () => {
    const user = await createUser(app);

    const byUsername = await request(app)
      .post('/api/auth/login')
      .send({ identifier: user.username, password: user.password })
      .expect(200);
    expect(byUsername.body.user.id).toBe(user.id);

    const byEmail = await request(app)
      .post('/api/auth/login')
      .send({ identifier: user.email, password: user.password })
      .expect(200);
    expect(byEmail.body.user.id).toBe(user.id);
  });

  it('rejects a wrong password', async () => {
    const user = await createUser(app);
    await request(app)
      .post('/api/auth/login')
      .send({ identifier: user.username, password: 'WrongPassword1' })
      .expect(401);
  });

  it('gives the same error for a missing account as for a wrong password', async () => {
    const user = await createUser(app);
    const missing = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'nobody-here-at-all', password: 'Password123' })
      .expect(401);
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ identifier: user.username, password: 'WrongPassword1' })
      .expect(401);
    // Identical responses, so login cannot be used to enumerate usernames.
    expect(missing.body.error.message).toBe(wrong.body.error.message);
  });
});

describe('protected routes', () => {
  it('rejects a request with no token', async () => {
    const response = await request(app).get('/api/auth/me').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    await request(app)
      .get('/api/auth/me')
      .set({ Authorization: 'Bearer not.a.real.token' })
      .expect(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign({ sub: 'someone', username: 'x' }, 'the-wrong-secret-entirely', {
      issuer: 'sonder',
      audience: 'sonder-client',
    });
    await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${forged}` })
      .expect(401);
  });

  it('returns the current user with counts', async () => {
    const user = await createUser(app);
    const response = await request(app).get('/api/auth/me').set(auth(user)).expect(200);
    expect(response.body.user.id).toBe(user.id);
    expect(response.body.user.counts).toEqual({ posts: 0, followers: 0, following: 0 });
  });

  it('updates the profile', async () => {
    const user = await createUser(app);
    const response = await request(app)
      .patch('/api/auth/me')
      .set(auth(user))
      .send({ displayName: 'Renamed', bio: 'Now with a bio.' })
      .expect(200);
    expect(response.body.user.displayName).toBe('Renamed');
    expect(response.body.user.bio).toBe('Now with a bio.');
  });
});

describe('refresh token rotation', () => {
  it('rotates the refresh token and keeps the session alive', async () => {
    const agent = request.agent(app);
    await agent
      .post('/api/auth/register')
      .send({
        email: 'rotator@example.com',
        username: 'rotator',
        displayName: 'Rotator',
        password: 'Password123',
      })
      .expect(201);

    const first = await agent.post('/api/auth/refresh').expect(200);
    expect(first.body.accessToken).toBeTypeOf('string');

    // The agent now holds the rotated cookie; refreshing again must still work.
    const second = await agent.post('/api/auth/refresh').expect(200);
    expect(second.body.user.username).toBe('rotator');
  });

  it('revokes every session when a rotated token is replayed', async () => {
    const registered = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'replay@example.com',
        username: 'replayer',
        displayName: 'Replayer',
        password: 'Password123',
      })
      .expect(201);

    const first = refreshCookieOf(registered);
    expect(first).toBeTypeOf('string');

    // Legitimate rotation: token 1 is spent and token 2 is issued.
    const rotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`sonder_rt=${first}`])
      .expect(200);
    const second = refreshCookieOf(rotated);
    expect(second).toBeTypeOf('string');
    expect(second).not.toBe(first);

    // Attacker replays token 1, which was already rotated away.
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`sonder_rt=${first}`])
      .expect(401);

    // Detecting the replay revokes the whole family, so even the honest
    // client's freshly-issued token 2 is now dead.
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`sonder_rt=${second}`])
      .expect(401);
  });

  it('rejects refresh with no cookie', async () => {
    await request(app).post('/api/auth/refresh').expect(401);
  });

  it('invalidates the refresh token on logout', async () => {
    const agent = request.agent(app);
    await agent
      .post('/api/auth/register')
      .send({
        email: 'byebye@example.com',
        username: 'byebye',
        displayName: 'Bye',
        password: 'Password123',
      })
      .expect(201);
    await agent.post('/api/auth/logout').expect(204);
    await agent.post('/api/auth/refresh').expect(401);
  });
});
