import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, Ack } from '@sonder/shared';
import { api, getAccessToken } from './api';

export type SonderSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL?.replace(/\/$/, '') ??
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ??
  'http://localhost:4000';

let socket: SonderSocket | null = null;
let connectionListeners = new Set<(connected: boolean) => void>();

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

let state: ConnectionState = 'disconnected';

export function getConnectionState(): ConnectionState {
  return state;
}

function setState(next: ConnectionState) {
  if (state === next) return;
  state = next;
  for (const listener of connectionListeners) listener(next === 'connected');
}

export function onConnectionChange(listener: (connected: boolean) => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/**
 * One socket per browser tab, reused across pages.
 *
 * A page navigation must not drop the connection: doing so would end an active
 * call and lose presence, so the socket lives outside React's lifecycle and is
 * only torn down on sign-out.
 */
export function getSocket(): SonderSocket {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    auth: { token: getAccessToken() ?? '' },
    transports: ['websocket', 'polling'],
    autoConnect: false,
    // Reconnect aggressively but with backoff: signalling being down means no
    // messages and no calls, so it is worth retrying hard.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
    withCredentials: true,
  }) as SonderSocket;

  socket.on('connect', () => setState('connected'));
  socket.on('disconnect', () => setState('disconnected'));

  socket.io.on('reconnect_attempt', () => setState('connecting'));

  socket.on('connect_error', (error: Error) => {
    setState('disconnected');
    // The handshake rejects with UNAUTHENTICATED when the access token has
    // expired. Refresh it and let socket.io's own retry pick up the new one.
    if (error.message === 'UNAUTHENTICATED') {
      void api.refresh().then((ok) => {
        if (ok && socket) {
          socket.auth = { token: getAccessToken() ?? '' };
        }
      });
    }
  });

  return socket;
}

export function connectSocket(): SonderSocket {
  const instance = getSocket();
  instance.auth = { token: getAccessToken() ?? '' };
  if (!instance.connected) {
    setState('connecting');
    instance.connect();
  }
  return instance;
}

export function disconnectSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  setState('disconnected');
}

/**
 * Promise wrapper around emit-with-ack. Rejects with a real Error carrying the
 * server's code, so callers can branch on USER_OFFLINE / USER_BUSY etc.
 */
export function emitWithAck<TResult>(
  event: keyof ClientToServerEvents,
  payload: unknown,
  timeoutMs = 10_000,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const instance = getSocket();
    if (!instance.connected) {
      reject(new SocketError('DISCONNECTED', 'You are offline. Reconnecting…'));
      return;
    }

    const timer = setTimeout(() => {
      reject(new SocketError('TIMEOUT', 'The server did not respond. Try again.'));
    }, timeoutMs);

    (
      instance.emit as unknown as (
        event: string,
        payload: unknown,
        ack: (response: Ack<TResult>) => void,
      ) => void
    )(event as string, payload, (response) => {
      clearTimeout(timer);
      if (response?.ok) resolve(response.data);
      else {
        reject(
          new SocketError(
            response?.error?.code ?? 'UNKNOWN',
            response?.error?.message ?? 'Something went wrong.',
          ),
        );
      }
    });
  });
}

export class SocketError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SocketError';
    this.code = code;
  }
}
