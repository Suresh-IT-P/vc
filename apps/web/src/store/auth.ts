'use client';

import { create } from 'zustand';
import type { AuthResult, SelfUser } from '@sonder/shared';
import { api, setAccessToken, ApiError } from '@/lib/api';
import { connectSocket, disconnectSocket } from '@/lib/socket';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: SelfUser | null;
  error: string | null;

  /** Restores a session from the refresh cookie on first load. */
  bootstrap(): Promise<void>;
  login(identifier: string, password: string): Promise<void>;
  register(input: {
    email: string;
    username: string;
    displayName: string;
    password: string;
  }): Promise<void>;
  logout(): Promise<void>;
  updateProfile(input: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string | null;
  }): Promise<void>;
  setUser(user: SelfUser): void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  error: null,

  async bootstrap() {
    // /me first: if a valid access token survived in localStorage this is one
    // round trip. Only fall back to the refresh cookie when it has expired.
    try {
      const { user } = await api.get<{ user: SelfUser }>('/api/auth/me');
      set({ status: 'authenticated', user, error: null });
      connectSocket();
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        set({ status: 'anonymous', user: null });
        return;
      }
    }

    const refreshed = await api.refresh();
    if (!refreshed) {
      set({ status: 'anonymous', user: null });
      return;
    }
    try {
      const { user } = await api.get<{ user: SelfUser }>('/api/auth/me');
      set({ status: 'authenticated', user, error: null });
      connectSocket();
    } catch {
      set({ status: 'anonymous', user: null });
    }
  },

  async login(identifier, password) {
    set({ error: null });
    const result = await api.post<AuthResult>('/api/auth/login', {
      identifier,
      password,
    });
    setAccessToken(result.accessToken);
    set({ status: 'authenticated', user: result.user });
    connectSocket();
  },

  async register(input) {
    set({ error: null });
    const result = await api.post<AuthResult>('/api/auth/register', input);
    setAccessToken(result.accessToken);
    set({ status: 'authenticated', user: result.user });
    connectSocket();
  },

  async logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Sign out locally regardless: a failed request must not trap the user.
    }
    setAccessToken(null);
    disconnectSocket();
    set({ status: 'anonymous', user: null, error: null });
  },

  async updateProfile(input) {
    const { user } = await api.patch<{ user: SelfUser }>('/api/auth/me', input);
    const previous = get().user;
    // Preserve counts, which the PATCH response does not include.
    set({ user: previous ? { ...previous, ...user } : user });
  },

  setUser(user) {
    set({ user, status: 'authenticated' });
  },
}));

export const useCurrentUser = () => useAuthStore((state) => state.user);
export const useAuthStatus = () => useAuthStore((state) => state.status);
