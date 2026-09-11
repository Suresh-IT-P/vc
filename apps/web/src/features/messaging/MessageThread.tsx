'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ChevronUp,
  Info,
  Phone,
  RotateCcw,
  SendHorizontal,
} from 'lucide-react';
import { MESSAGE_MAX_LENGTH } from '@sonder/shared';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ErrorState, Skeleton, Spinner } from '@/components/ui/feedback';
import { Textarea } from '@/components/ui/form-controls';
import { useMessagingStore, type PendingMessage } from '@/store/messaging';
import { useAuthStore } from '@/store/auth';
import { useUiStore } from '@/store/ui';
import { useUserActions } from '@/features/users/useUserActions';
import { cn, formatClockTime, formatPresence, groupByDay } from '@/lib/utils';
import { MessageStatusIcon } from './MessageStatusIcon';

export function MessageThread({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const currentUserId = useAuthStore((state) => state.user?.id);

  const conversation = useMessagingStore((state) =>
    state.conversations.find((item) => item.id === conversationId),
  );
  const thread = useMessagingStore((state) => state.threads[conversationId]);
  const typingUsers = useMessagingStore((state) => state.typing[conversationId] ?? []);
  const openConversation = useMessagingStore((state) => state.openConversation);
  const closeConversation = useMessagingStore((state) => state.closeConversation);
  const loadMore = useMessagingStore((state) => state.loadMore);
  const sendMessage = useMessagingStore((state) => state.sendMessage);
  const retryMessage = useMessagingStore((state) => state.retryMessage);
  const notifyTyping = useMessagingStore((state) => state.notifyTyping);
  const stopTyping = useMessagingStore((state) => state.stopTyping);
  const socketConnected = useUiStore((state) => state.socketConnected);

  const { call, busy, callInProgress } = useUserActions();

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const stickToBottom = React.useRef(true);

  React.useEffect(() => {
    void openConversation(conversationId);
    return () => closeConversation(conversationId);
  }, [conversationId, openConversation, closeConversation]);

  const messages = thread?.messages ?? [];
  const messageCount = messages.length;

  // Auto-scroll only when the user is already at the bottom, so reading history
  // is not yanked away by an incoming message.
  React.useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messageCount, typingUsers.length]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = distanceFromBottom < 80;
  };

  const peer = conversation?.peer;

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft('');
    stickToBottom.current = true;
    try {
      await sendMessage(conversationId, body);
    } catch (error) {
      // The bubble stays visible with a retry affordance, so nothing is lost.
      toast.error(
        error instanceof Error ? error.message : 'Message could not be sent.',
      );
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline. On touch keyboards Enter inserts a
    // newline instead, because there is no Shift and no send key.
    if (event.key === 'Enter' && !event.shiftKey && !isTouchDevice()) {
      event.preventDefault();
      void handleSend();
    }
  }

  if (!thread?.hydrated && thread?.loading) {
    return <ThreadSkeleton />;
  }

  if (thread?.error && messages.length === 0) {
    return (
      <ErrorState
        title="Could not open this conversation"
        message={thread.error}
        onRetry={() => void openConversation(conversationId)}
      />
    );
  }

  const groups = groupByDay(messages, (message) => message.createdAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b border-border glass px-2 py-2.5 pt-safe md:px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          onClick={() => router.push('/messages')}
          aria-label="Back to conversations"
        >
          <ArrowLeft aria-hidden />
        </Button>

        {peer ? (
          <Link
            href={`/profile/${peer.username}`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1 py-1 transition-colors hover:bg-secondary/60"
          >
            <UserAvatar
              displayName={peer.displayName}
              username={peer.username}
              avatarUrl={peer.avatarUrl}
              isOnline={peer.isOnline}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">
                {peer.displayName}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {typingUsers.length > 0
                  ? 'typing…'
                  : formatPresence(peer.isOnline, peer.lastSeenAt)}
              </span>
            </span>
          </Link>
        ) : (
          <div className="flex-1" />
        )}

        {/* The real call button. Same code path as the profile page's. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={peer ? `Call ${peer.displayName}` : 'Call'}
          disabled={!peer || callInProgress}
          loading={busy === 'call'}
          onClick={() => {
            if (!peer) return;
            void call(
              {
                id: peer.userId,
                username: peer.username,
                displayName: peer.displayName,
                avatarUrl: peer.avatarUrl,
              },
              { conversationId },
            );
          }}
        >
          <Phone aria-hidden />
        </Button>
      </header>

      {!socketConnected ? (
        <div
          role="status"
          className="flex items-center gap-2 bg-signal-poor/10 px-4 py-2 text-xs font-medium text-signal-poor"
        >
          <Info className="size-3.5 shrink-0" aria-hidden />
          Reconnecting — messages will send once you are back online.
        </div>
      ) : null}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto scroll-area px-3 py-4 md:px-6"
      >
        {thread?.nextCursor ? (
          <div className="mb-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              loading={thread.loadingMore}
              onClick={() => void loadMore(conversationId)}
            >
              <ChevronUp aria-hidden />
              Load earlier messages
            </Button>
          </div>
        ) : messages.length > 0 ? (
          <p className="mb-6 text-center text-xs text-muted-foreground">
            This is the beginning of your conversation.
          </p>
        ) : null}

        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            {peer ? (
              <UserAvatar
                displayName={peer.displayName}
                username={peer.username}
                avatarUrl={peer.avatarUrl}
                size="xl"
              />
            ) : null}
            <div>
              <p className="font-semibold">{peer?.displayName}</p>
              <p className="text-sm text-muted-foreground">
                Say hello — messages are delivered instantly.
              </p>
            </div>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="my-4 flex items-center justify-center">
                <span className="rounded-full bg-secondary px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </span>
              </div>
              <div className="space-y-1">
                {group.items.map((message, index) => {
                  const outgoing = isOutgoing(message, currentUserId);
                  const previous = group.items[index - 1];
                  const grouped =
                    previous !== undefined &&
                    isOutgoing(previous, currentUserId) === outgoing &&
                    new Date(message.createdAt).getTime() -
                      new Date(previous.createdAt).getTime() <
                      120_000;

                  return (
                    <MessageBubble
                      key={message.id}
                      body={message.body}
                      deleted={Boolean(message.deletedAt)}
                      createdAt={message.createdAt}
                      status={message.status}
                      outgoing={outgoing}
                      grouped={grouped}
                      onRetry={
                        message.status === 'failed' && 'clientId' in message
                          ? () =>
                              void retryMessage(
                                conversationId,
                                (message as PendingMessage).clientId,
                              )
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))
        )}

        {typingUsers.length > 0 ? <TypingBubble /> : null}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-border glass px-3 py-3 pb-safe md:px-4">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value.slice(0, MESSAGE_MAX_LENGTH));
              if (event.target.value.trim()) notifyTyping(conversationId);
              else stopTyping(conversationId);
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => stopTyping(conversationId)}
            placeholder="Message…"
            rows={1}
            aria-label="Message"
            className="max-h-32 min-h-[44px] flex-1 rounded-2xl py-3"
            style={{ height: 'auto' }}
          />
          <Button
            variant="brand"
            size="icon"
            className="mb-0.5 shrink-0"
            onClick={() => void handleSend()}
            disabled={!draft.trim()}
            loading={sending}
            aria-label="Send message"
          >
            <SendHorizontal aria-hidden />
          </Button>
        </div>
        {draft.length > MESSAGE_MAX_LENGTH - 200 ? (
          <p className="mt-1.5 text-right text-xs text-muted-foreground">
            {MESSAGE_MAX_LENGTH - draft.length} characters left
          </p>
        ) : null}
      </div>
    </div>
  );
}

function isOutgoing(
  message: { senderId: string },
  currentUserId: string | undefined,
): boolean {
  // Optimistic messages use the sentinel 'me' until the server row arrives.
  return message.senderId === 'me' || message.senderId === currentUserId;
}

function MessageBubble({
  body,
  deleted,
  createdAt,
  status,
  outgoing,
  grouped,
  onRetry,
}: {
  body: string;
  deleted: boolean;
  createdAt: string;
  status: PendingMessage['status'] | 'sent' | 'delivered' | 'read';
  outgoing: boolean;
  grouped: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      className={cn(
        'flex w-full',
        outgoing ? 'justify-end' : 'justify-start',
        grouped ? 'mt-0.5' : 'mt-2',
      )}
    >
      <div className={cn('flex max-w-[85%] flex-col gap-1 sm:max-w-[70%]')}>
        <div
          className={cn(
            'px-3.5 py-2.5 text-sm leading-relaxed',
            outgoing
              ? 'bubble-out bg-brand-gradient text-white'
              : 'bubble-in bg-secondary text-secondary-foreground',
            status === 'failed' && 'opacity-70 ring-1 ring-destructive',
            deleted && 'italic opacity-70',
          )}
        >
          <p className="whitespace-pre-wrap break-words">
            {deleted ? 'This message was deleted' : body}
          </p>
        </div>

        <div
          className={cn(
            'flex items-center gap-1.5 px-1 text-[0.68rem] text-muted-foreground',
            outgoing ? 'justify-end' : 'justify-start',
          )}
        >
          <time dateTime={createdAt}>{formatClockTime(createdAt)}</time>
          {outgoing ? <MessageStatusIcon status={status} /> : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 font-semibold text-destructive hover:underline"
            >
              <RotateCcw className="size-3" aria-hidden />
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="mt-2 flex justify-start" aria-live="polite" aria-label="Typing">
      <div className="bubble-in flex items-center gap-1 bg-secondary px-4 py-3">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-1.5 rounded-full bg-muted-foreground animate-typing-bounce"
            style={{ animationDelay: `${index * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="flex-1 space-y-3 p-6">
        {[0, 1, 2, 3, 4].map((index) => (
          <div
            key={index}
            className={cn('flex', index % 2 === 0 ? 'justify-start' : 'justify-end')}
          >
            <Skeleton
              className={cn('h-11 rounded-2xl', index % 3 === 0 ? 'w-52' : 'w-36')}
            />
          </div>
        ))}
      </div>
      <div className="border-t border-border p-4">
        <Spinner label="Loading conversation" />
      </div>
    </div>
  );
}

function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}
