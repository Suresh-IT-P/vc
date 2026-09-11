import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import type {
  Ack,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@sonder/shared';

/* The env module reads process.env at import time, so global-setup must have
 * run first. These dynamic imports guarantee that ordering. */
export async function loadServer() {
  const [{ createApp }, { prisma }, realtime, presence, registry] = await Promise.all([
    import('../src/app.js'),
    import('../src/db.js'),
    import('../src/realtime/index.js'),
    import('../src/realtime/presence.js'),
    import('../src/modules/calls/registry.js'),
  ]);
  return { createApp, prisma, realtime, presence, registry };
}

export interface TestHarness {
  app: Express;
  httpServer: HttpServer;
  url: string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<TestHarness> {
  const { createApp, realtime } = await loadServer();
  const app = createApp();
  const httpServer = createServer(app);
  realtime.createSocketServer(httpServer);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    app,
    httpServer,
    url: `http://127.0.0.1:${port}`,
    async close() {
      const { registry } = await loadServer();
      registry.shutdownCallRegistry();
      await realtime.shutdownSocketServer();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export interface TestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  accessToken: string;
  cookie: string[];
}

let counter = 0;

export async function createUser(
  app: Express,
  overrides: Partial<{ username: string; email: string; displayName: string; password: string }> = {},
): Promise<TestUser> {
  counter += 1;
  const username = overrides.username ?? `tester${counter}${Date.now() % 100000}`;
  const email = overrides.email ?? `${username}@example.com`;
  const password = overrides.password ?? 'Password123';

  const response = await request(app)
    .post('/api/auth/register')
    .send({
      email,
      username,
      displayName: overrides.displayName ?? `Tester ${counter}`,
      password,
    })
    .expect(201);

  const setCookie = response.headers['set-cookie'];
  return {
    id: response.body.user.id,
    username,
    email,
    password,
    accessToken: response.body.accessToken,
    cookie: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
  };
}

export function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

/* -------------------------------------------------------------------------- */
/* Socket helpers                                                             */
/* -------------------------------------------------------------------------- */

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function connectSocket(url: string, token: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket: TestSocket = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 5000,
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('socket connect timed out'));
    }, 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

/** Promisified emit-with-ack that rejects on `{ ok: false }`. */
export function emitAck<TResult>(
  socket: TestSocket,
  event: string,
  payload: unknown,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 8000);
    (socket.emit as (e: string, p: unknown, cb: (r: Ack<TResult>) => void) => void)(
      event,
      payload,
      (response) => {
        clearTimeout(timer);
        if (response.ok) resolve(response.data);
        else reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
      },
    );
  });
}

/** Resolves with the first payload of `event`, or rejects after `timeout` ms. */
export function waitFor<T = unknown>(
  socket: TestSocket,
  event: string,
  timeout = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeout,
    );
    (socket as unknown as { once(e: string, cb: (payload: T) => void): void }).once(
      event,
      (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      },
    );
  });
}

/**
 * Like `waitFor`, but skips payloads that do not match. Needed because several
 * events legitimately fan out more than once — a user's own presence is echoed
 * to their other tabs, so a listener sees their own transition as well as their
 * peer's.
 */
export function waitForMatching<T = unknown>(
  socket: TestSocket,
  event: string,
  predicate: (payload: T) => boolean,
  timeout = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const typed = socket as unknown as {
      on(e: string, cb: (payload: T) => void): void;
      off(e: string, cb: (payload: T) => void): void;
    };
    const timer = setTimeout(() => {
      typed.off(event, listener);
      reject(new Error(`timed out waiting for a matching "${event}"`));
    }, timeout);

    function listener(payload: T) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      typed.off(event, listener);
      resolve(payload);
    }
    typed.on(event, listener);
  });
}

export function closeSockets(...sockets: (TestSocket | undefined)[]) {
  for (const socket of sockets) socket?.close();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
