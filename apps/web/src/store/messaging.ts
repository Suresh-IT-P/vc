'use client';

import { create } from 'zustand';
import type {
  Conversation,
  Message,
  Paginated,
  PresenceUpdate,
} from '@sonder/shared';
import { MESSAGES_PAGE_SIZE, TYPING_THROTTLE_MS } from '@sonder/shared';
import { api } from '@/lib/api';
import { emitWithAck, getSocket } from '@/lib/socket';
import { newClientId } from '@/lib/utils';

/** A message that exists only locally until the server acknowledges it. */
export interface PendingMessage extends Message {
  status: 'sending' | 'failed';
  clientId: string;
}

type AnyMessage = Message | PendingMessage;

interface ThreadState {
  messages: AnyMessage[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** True once history has been fetched at least once. */
  hydrated: boolean;
}

interface MessagingState {
  conversations: Conversation[];
  conversationsLoading: boolean;
  conversationsError: string | null;

  threads: Record<string, ThreadState>;
  /** conversationId -> userIds currently typing. */
  typing: Record<string, string[]>;
  /** Live presence overrides keyed by userId. */
  presence: Record<string, { isOnline: boolean; lastSeenAt: string | null }>;

  activeConversationId: string | null;

  loadConversations(): Promise<void>;
  openConversation(conversationId: string): Promise<void>;
  closeConversation(conversationId: string): void;
  /** Resolves (or creates) the thread with a user and returns its id. */
  startConversationWith(userId: string): Promise<string>;
  loadMore(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, body: string): Promise<void>;
  retryMessage(conversationId: string, clientId: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  notifyTyping(conversationId: string): void;
  stopTyping(conversationId: string): void;

  /* socket ingress */
  applyIncoming(message: Message): void;
  applyDelivered(payload: { conversationId: string; messageIds: string[]; deliveredAt: string }): void;
  applyRead(payload: { conversationId: string; messageIds: string[]; readAt: string }): void;
  applyTyping(payload: { conversationId: string; userId: string; isTyping: boolean }): void;
  applyPresence(payload: PresenceUpdate): void;
  applyConversation(conversation: Conversation): void;

  reset(): void;
}

const emptyThread = (): ThreadState => ({
  messages: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  hydrated: false,
});

/** Last time typing:start was emitted per conversation, for throttling. */
const lastTypingEmit = new Map<string, number>();

export const useMessagingStore = create<MessagingState>((set, get) => ({
  conversations: [],
  conversationsLoading: false,
  conversationsError: null,
  threads: {},
  typing: {},
  presence: {},
  activeConversationId: null,

  async loadConversations() {
    set({ conversationsLoading: true, conversationsError: null });
    try {
      const { conversations } = await api.get<{ conversations: Conversation[] }>(
        '/api/conversations',
      );
      set({ conversations, conversationsLoading: false });
    } catch (error) {
      set({
        conversationsLoading: false,
        conversationsError:
          error instanceof Error ? error.message : 'Could not load your messages.',
      });
    }
  },

  async openConversation(conversationId) {
    set({ activeConversationId: conversationId });

    const existing = get().threads[conversationId];
    if (!existing?.hydrated) {
      set((state) => ({
        threads: {
          ...state.threads,
          [conversationId]: { ...(existing ?? emptyThread()), loading: true, error: null },
        },
      }));
    }

    // Joining the room is what authorises this socket to receive the thread's
    // events, and it flips inbound messages to "delivered" server-side.
    try {
      await emitWithAck('conversation:join', { conversationId });
    } catch {
      // Non-fatal: HTTP history still loads and the socket will retry on reconnect.
    }

    try {
      const page = await api.get<Paginated<Message>>(
        `/api/conversations/${conversationId}/messages`,
        { query: { limit: MESSAGES_PAGE_SIZE } },
      );
      set((state) => ({
        threads: {
          ...state.threads,
          [conversationId]: {
            messages: page.items,
            nextCursor: page.nextCursor,
            loading: false,
            loadingMore: false,
            error: null,
            hydrated: true,
          },
        },
      }));
      await get().markRead(conversationId);
    } catch (error) {
      set((state) => ({
        threads: {
          ...state.threads,
          [conversationId]: {
            ...(state.threads[conversationId] ?? emptyThread()),
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : 'Could not load this conversation.',
          },
        },
      }));
    }
  },

  closeConversation(conversationId) {
    getSocket().emit('conversation:leave', { conversationId });
    if (get().activeConversationId === conversationId) {
      set({ activeConversationId: null });
    }
  },

  async startConversationWith(userId) {
    const { conversation } = await api.post<{ conversation: Conversation }>(
      '/api/conversations',
      { userId },
    );
    set((state) => ({
      conversations: upsertConversation(state.conversations, conversation),
    }));
    return conversation.id;
  },

  async loadMore(conversationId) {
    const thread = get().threads[conversationId];
    if (!thread?.nextCursor || thread.loadingMore) return;

    set((state) => ({
      threads: {
        ...state.threads,
        [conversationId]: { ...thread, loadingMore: true },
      },
    }));

    try {
      const page = await api.get<Paginated<Message>>(
        `/api/conversations/${conversationId}/messages`,
        { query: { cursor: thread.nextCursor, limit: MESSAGES_PAGE_SIZE } },
      );
      set((state) => {
        const current = state.threads[conversationId] ?? emptyThread();
        return {
          threads: {
            ...state.threads,
            [conversationId]: {
              ...current,
              // Older page goes in front.
              messages: [...page.items, ...current.messages],
              nextCursor: page.nextCursor,
              loadingMore: false,
            },
          },
        };
      });
    } catch {
      set((state) => ({
        threads: {
          ...state.threads,
          [conversationId]: {
            ...(state.threads[conversationId] ?? emptyThread()),
            loadingMore: false,
          },
        },
      }));
    }
  },

  /**
   * Optimistic send. The bubble appears immediately with a "sending" clock, then
   * the server's row replaces it — matched on clientId, which is also the
   * server-side idempotency key, so a retry can never duplicate the message.
   */
  async sendMessage(conversationId, body) {
    const trimmed = body.trim();
    if (!trimmed) return;

    const clientId = newClientId();
    const optimistic: PendingMessage = {
      id: `pending:${clientId}`,
      conversationId,
      senderId: 'me',
      body: trimmed,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      status: 'sending',
      deliveredAt: null,
      readAt: null,
      clientId,
    };

    appendMessage(set, get, conversationId, optimistic);
    get().stopTyping(conversationId);

    try {
      const saved = await emitWithAck<Message>('message:send', {
        conversationId,
        body: trimmed,
        clientId,
      });
      replaceByClientId(set, get, conversationId, clientId, saved);
      touchConversation(set, get, conversationId, saved);
    } catch (error) {
      markFailed(set, get, conversationId, clientId);
      throw error;
    }
  },

  async retryMessage(conversationId, clientId) {
    const thread = get().threads[conversationId];
    const failed = thread?.messages.find(
      (message) => 'clientId' in message && message.clientId === clientId,
    );
    if (!failed) return;

    set((state) => ({
      threads: {
        ...state.threads,
        [conversationId]: {
          ...(state.threads[conversationId] ?? emptyThread()),
          messages: (state.threads[conversationId]?.messages ?? []).map((message) =>
            'clientId' in message && message.clientId === clientId
              ? { ...message, status: 'sending' as const }
              : message,
          ),
        },
      },
    }));

    try {
      // Same clientId: the server recognises the retry and returns the original
      // row rather than storing a second copy.
      const saved = await emitWithAck<Message>('message:send', {
        conversationId,
        body: failed.body,
        clientId,
      });
      replaceByClientId(set, get, conversationId, clientId, saved);
    } catch {
      markFailed(set, get, conversationId, clientId);
    }
  },

  async markRead(conversationId) {
    try {
      await emitWithAck('message:read', { conversationId });
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, unreadCount: 0 }
            : conversation,
        ),
      }));
    } catch {
      // Read receipts are best-effort.
    }
  },

  notifyTyping(conversationId) {
    const now = Date.now();
    const last = lastTypingEmit.get(conversationId) ?? 0;
    // Throttled: one frame per 1.5 s is plenty to keep the indicator alive.
    if (now - last < TYPING_THROTTLE_MS) return;
    lastTypingEmit.set(conversationId, now);
    getSocket().emit('typing:start', { conversationId });
  },

  stopTyping(conversationId) {
    lastTypingEmit.delete(conversationId);
    getSocket().emit('typing:stop', { conversationId });
  },

  /* ------------------------------ socket ingress ------------------------- */

  applyIncoming(message) {
    const state = get();
    const thread = state.threads[message.conversationId];

    if (thread) {
      const alreadyPresent = thread.messages.some(
        (existing) =>
          existing.id === message.id ||
          ('clientId' in existing &&
            message.clientId &&
            existing.clientId === message.clientId),
      );
      if (!alreadyPresent) {
        appendMessage(set, get, message.conversationId, message);
      }
    }

    touchConversation(set, get, message.conversationId, message, {
      incrementUnread: state.activeConversationId !== message.conversationId,
    });

    // Reading it immediately if the thread is on screen.
    if (state.activeConversationId === message.conversationId) {
      void get().markRead(message.conversationId);
    }
  },

  applyDelivered({ conversationId, messageIds, deliveredAt }) {
    const ids = new Set(messageIds);
    updateMessages(set, get, conversationId, (message) =>
      ids.has(message.id) && message.status !== 'read'
        ? { ...message, status: 'delivered', deliveredAt }
        : message,
    );
  },

  applyRead({ conversationId, messageIds, readAt }) {
    const ids = new Set(messageIds);
    updateMessages(set, get, conversationId, (message) =>
      ids.has(message.id)
        ? { ...message, status: 'read', readAt, deliveredAt: message.deliveredAt ?? readAt }
        : message,
    );
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId && conversation.lastMessage
          ? {
              ...conversation,
              lastMessage: ids.has(conversation.lastMessage.id)
                ? { ...conversation.lastMessage, status: 'read', readAt }
                : conversation.lastMessage,
            }
          : conversation,
      ),
    }));
  },

  applyTyping({ conversationId, userId, isTyping }) {
    set((state) => {
      const current = state.typing[conversationId] ?? [];
      const next = isTyping
        ? current.includes(userId)
          ? current
          : [...current, userId]
        : current.filter((id) => id !== userId);
      return { typing: { ...state.typing, [conversationId]: next } };
    });
  },

  applyPresence({ userId, state: presenceState, lastSeenAt }) {
    const isOnline = presenceState === 'online';
    set((state) => ({
      presence: { ...state.presence, [userId]: { isOnline, lastSeenAt } },
      conversations: state.conversations.map((conversation) =>
        conversation.peer.userId === userId
          ? { ...conversation, peer: { ...conversation.peer, isOnline, lastSeenAt } }
          : conversation,
      ),
    }));
  },

  applyConversation(conversation) {
    set((state) => ({
      conversations: upsertConversation(state.conversations, conversation),
    }));
  },

  reset() {
    set({
      conversations: [],
      threads: {},
      typing: {},
      presence: {},
      activeConversationId: null,
      conversationsError: null,
    });
  },
}));

/* ---------------------------------------------------------------------------
 * Helpers. Kept outside the store so each action stays readable.
 * ------------------------------------------------------------------------- */

type Setter = (
  partial:
    | Partial<MessagingState>
    | ((state: MessagingState) => Partial<MessagingState>),
) => void;
type Getter = () => MessagingState;

function appendMessage(
  set: Setter,
  get: Getter,
  conversationId: string,
  message: AnyMessage,
) {
  const thread = get().threads[conversationId] ?? emptyThread();
  set({
    threads: {
      ...get().threads,
      [conversationId]: {
        ...thread,
        messages: [...thread.messages, message],
        hydrated: true,
      },
    },
  });
}

function updateMessages(
  set: Setter,
  get: Getter,
  conversationId: string,
  mapper: (message: AnyMessage) => AnyMessage,
) {
  const thread = get().threads[conversationId];
  if (!thread) return;
  set({
    threads: {
      ...get().threads,
      [conversationId]: { ...thread, messages: thread.messages.map(mapper) },
    },
  });
}

function replaceByClientId(
  set: Setter,
  get: Getter,
  conversationId: string,
  clientId: string,
  saved: Message,
) {
  const thread = get().threads[conversationId];
  if (!thread) return;
  set({
    threads: {
      ...get().threads,
      [conversationId]: {
        ...thread,
        messages: thread.messages.map((message) =>
          'clientId' in message && message.clientId === clientId
            ? { ...saved, clientId }
            : message,
        ),
      },
    },
  });
}

function markFailed(
  set: Setter,
  get: Getter,
  conversationId: string,
  clientId: string,
) {
  updateMessages(set, get, conversationId, (message) =>
    'clientId' in message && message.clientId === clientId
      ? { ...message, status: 'failed' as const }
      : message,
  );
}

function touchConversation(
  set: Setter,
  get: Getter,
  conversationId: string,
  lastMessage: Message,
  options: { incrementUnread?: boolean } = {},
) {
  const state = get();
  const index = state.conversations.findIndex(
    (conversation) => conversation.id === conversationId,
  );
  if (index === -1) {
    // A message arrived for a thread we have not loaded yet.
    void state.loadConversations();
    return;
  }
  const existing = state.conversations[index];
  const updated: Conversation = {
    ...existing,
    lastMessage,
    updatedAt: lastMessage.createdAt,
    unreadCount: options.incrementUnread
      ? existing.unreadCount + 1
      : existing.unreadCount,
  };
  // Move to the top: the inbox is ordered by recency.
  const rest = state.conversations.filter(
    (conversation) => conversation.id !== conversationId,
  );
  set({ conversations: [updated, ...rest] });
}

function upsertConversation(
  conversations: Conversation[],
  conversation: Conversation,
): Conversation[] {
  const rest = conversations.filter((item) => item.id !== conversation.id);
  return [conversation, ...rest];
}

/** Total unread across all threads, for the nav badge. */
export const selectTotalUnread = (state: MessagingState): number =>
  state.conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);
