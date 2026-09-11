'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { MessageCirclePlus, MessagesSquare, Search } from 'lucide-react';
import type { Conversation } from '@sonder/shared';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form-controls';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { useMessagingStore } from '@/store/messaging';
import { useAuthStore } from '@/store/auth';
import { cn, formatRelative } from '@/lib/utils';
import { SearchPanel } from '@/features/users/SearchPanel';
import { MessageStatusIcon } from './MessageStatusIcon';

export function ConversationList() {
  const conversations = useMessagingStore((state) => state.conversations);
  const loading = useMessagingStore((state) => state.conversationsLoading);
  const error = useMessagingStore((state) => state.conversationsError);
  const load = useMessagingStore((state) => state.loadConversations);
  const typing = useMessagingStore((state) => state.typing);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const params = useParams<{ conversationId?: string }>();

  const [filter, setFilter] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.peer.displayName.toLowerCase().includes(needle) ||
        conversation.peer.username.toLowerCase().includes(needle),
    );
  }, [conversations, filter]);

  return (
    <>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 pt-safe">
        <h1 className="font-display text-lg font-bold">Messages</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSearchOpen(true)}
          aria-label="Start a new conversation"
        >
          <MessageCirclePlus aria-hidden />
        </Button>
      </header>

      <div className="border-b border-border p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter conversations"
            className="h-10 pl-9"
            aria-label="Filter conversations"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-area">
        {loading && conversations.length === 0 ? (
          <ul className="space-y-1 p-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <li key={index} className="flex items-center gap-3 p-2">
                <Skeleton className="size-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </li>
            ))}
          </ul>
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No conversations yet"
            description="Search for someone and send the first message."
            action={
              <Button variant="brand" size="sm" onClick={() => setSearchOpen(true)}>
                Find someone
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matches" description={`Nothing matching "${filter}".`} />
        ) : (
          <ul className="p-2">
            {filtered.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow
                  conversation={conversation}
                  active={params?.conversationId === conversation.id}
                  isTyping={(typing[conversation.id] ?? []).length > 0}
                  currentUserId={currentUserId}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <SearchPanel open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

function ConversationRow({
  conversation,
  active,
  isTyping,
  currentUserId,
}: {
  conversation: Conversation;
  active: boolean;
  isTyping: boolean;
  currentUserId?: string;
}) {
  const { peer, lastMessage, unreadCount } = conversation;
  const outgoing = lastMessage?.senderId === currentUserId;
  const unread = unreadCount > 0;

  return (
    <Link
      href={`/messages/${conversation.id}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-xl p-2.5 transition-colors',
        active ? 'bg-secondary' : 'hover:bg-secondary/60',
      )}
    >
      <UserAvatar
        displayName={peer.displayName}
        username={peer.username}
        avatarUrl={peer.avatarUrl}
        size="lg"
        isOnline={peer.isOnline}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('truncate text-sm', unread ? 'font-bold' : 'font-semibold')}>
            {peer.displayName}
          </span>
          {lastMessage ? (
            <span className="ml-auto shrink-0 text-[0.7rem] text-muted-foreground">
              {formatRelative(lastMessage.createdAt)}
            </span>
          ) : null}
        </div>

        <div className="mt-0.5 flex items-center gap-1.5">
          {isTyping ? (
            <span className="truncate text-xs font-medium text-primary">typing…</span>
          ) : lastMessage ? (
            <>
              {outgoing ? (
                <MessageStatusIcon status={lastMessage.status} className="shrink-0" />
              ) : null}
              <span
                className={cn(
                  'truncate text-xs',
                  unread ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {lastMessage.deletedAt
                  ? 'Message deleted'
                  : `${outgoing ? 'You: ' : ''}${lastMessage.body}`}
              </span>
            </>
          ) : (
            <span className="truncate text-xs text-muted-foreground">
              No messages yet
            </span>
          )}

          {unread ? (
            <span
              className="ml-auto flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[0.68rem] font-bold text-primary-foreground"
              aria-label={`${unreadCount} unread`}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
