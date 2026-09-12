/**
 * The same-origin production build is the default deploy topology, and it was
 * entirely broken: API_URL is "" there, one-argument `new URL()` rejects a
 * relative path, and so every call threw "Invalid URL" before a request was ever
 * made. Nothing caught it, because the server smoke tests speak to the API
 * directly and never through this module. These tests are that missing coverage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_URL, buildUrl } from './api';

const ORIGIN = 'https://vc-production.up.railway.app';

function pretendBrowser(origin: string) {
  (globalThis as { window?: unknown }).window = { location: { origin } };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('buildUrl', () => {
  it('treats an unset NEXT_PUBLIC_API_URL as same-origin', () => {
    // Not incidental: "" is the production default, and it is what broke.
    expect(API_URL).toBe('');
  });

  it('resolves a relative path against the page origin', () => {
    pretendBrowser(ORIGIN);
    expect(buildUrl('/api/auth/login')).toBe(`${ORIGIN}/api/auth/login`);
  });

  it('gives a bare path a leading slash', () => {
    pretendBrowser(ORIGIN);
    expect(buildUrl('api/users/me')).toBe(`${ORIGIN}/api/users/me`);
  });

  it('leaves an absolute URL untouched, so a separate API origin still works', () => {
    pretendBrowser(ORIGIN);
    expect(buildUrl('http://localhost:4000/api/health')).toBe('http://localhost:4000/api/health');
  });

  it('appends query parameters and drops empty ones', () => {
    pretendBrowser(ORIGIN);
    expect(buildUrl('/api/users/search', { q: 'ada', cursor: undefined, after: '' })).toBe(
      `${ORIGIN}/api/users/search?q=ada`,
    );
  });

  it('parses during prerender, when there is no window', () => {
    expect(() => buildUrl('/api/auth/login')).not.toThrow();
  });
});
