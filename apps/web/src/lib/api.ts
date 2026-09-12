/**
 * Where the API lives, from the browser's point of view.
 *
 * `NEXT_PUBLIC_API_URL` wins when set (it is inlined at build time). Otherwise
 * the fallback depends on the build:
 *
 *   development — http://localhost:4000, because `npm run dev` puts the web app
 *                 on 3000 and the API on 4000: genuinely different origins.
 *   production  — "" , i.e. same-origin relative URLs. Every production topology
 *                 here serves both behind one origin (Nginx, or scripts/serve.mjs
 *                 on a single-port host), so same-origin is the correct default.
 *                 It used to fall back to localhost:4000 in production too, which
 *                 meant a deploy with the variable unset sent every visitor's
 *                 browser to its *own* machine — a failure that looks like the
 *                 server being down.
 */
const FALLBACK_API_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:4000' : '';

export const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? FALLBACK_API_URL;

const TOKEN_STORAGE_KEY = 'sonder.accessToken';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Array<{ path: string; message: string }>;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  /** Per-field messages keyed by field name, for form rendering. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const field of this.fields) {
      if (field.path && !result[field.path]) result[field.path] = field.message;
    }
    return result;
  }
}

/**
 * Access token lives in memory, mirrored to localStorage so a reload does not
 * flash the login screen.
 *
 * The *refresh* token is an httpOnly cookie the JavaScript here cannot read,
 * which is the part that matters: an XSS bug can steal at most a 15-minute
 * access token, not a 30-day session.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window === 'undefined') return null;
  try {
    accessToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: memory-only is fine.
  }
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
  for (const listener of tokenListeners) listener(token);
}

const tokenListeners = new Set<(token: string | null) => void>();

export function onAccessTokenChange(
  listener: (token: string | null) => void,
): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set false to skip the automatic refresh-and-retry (used by refresh itself). */
  retryOnUnauthorized?: boolean;
  query?: Record<string, string | number | boolean | undefined | null>;
}

/** Single in-flight refresh, so ten parallel 401s cause one refresh call. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          setAccessToken(null);
          return false;
        }
        const data = (await response.json()) as { accessToken?: string };
        if (data.accessToken) {
          setAccessToken(data.accessToken);
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        // Cleared on the next tick so concurrent callers all see this result.
        setTimeout(() => {
          refreshInFlight = null;
        }, 0);
      }
    })();
  }
  return refreshInFlight;
}

/**
 * Resolve a request path, which is usually relative.
 *
 * The second argument to `new URL()` is the entire point of this function.
 * One-argument `new URL()` demands an absolute URL, and API_URL is "" for the
 * same-origin production build — so every call through here threw
 * "TypeError: Invalid URL" before the request was ever made. It went unnoticed
 * because the only call that does not use this helper, the token refresh above,
 * passes its relative path straight to fetch(), which resolves it happily.
 *
 * An absolute first argument ignores the base, so this is safe for both shapes.
 */
export function buildUrl(path: string, query?: RequestOptions['query']): string {
  // window is absent during prerender; nothing fetches then, but the URL still
  // has to parse.
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(
    path.startsWith('http') ? path : `${API_URL}${path.startsWith('/') ? path : `/${path}`}`,
    origin,
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, retryOnUnauthorized = true, query, headers, ...rest } = options;
  const token = getAccessToken();

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (body !== undefined && !(body instanceof FormData)) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      ...rest,
      headers: requestHeaders,
      credentials: 'include',
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch (error) {
    // fetch only rejects on a network-level failure.
    throw new ApiError(
      0,
      'NETWORK',
      'Could not reach the server. Check your connection and try again.',
      [],
    );
  }

  if (response.status === 401 && retryOnUnauthorized) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, retryOnUnauthorized: false });
    }
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: { fields?: Array<{ path: string; message: string }> } } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details?.fields ?? [],
    );
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
  refresh: refreshSession,
};
