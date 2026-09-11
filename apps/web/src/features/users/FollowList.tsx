'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { PublicUser } from '@sonder/shared';
import { ArrowLeft, MessageCircle, Phone, Users } from 'lucide-react';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { formatPresence } from '@/lib/utils';
import { useUserActions, toActionTarget } from './useUserActions';

export function FollowList({
  username,
  kind,
}: {
  username: string;
  kind: 'followers' | 'following';
}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['follows', username, kind],
    queryFn: () =>
      api.get<{ results: PublicUser[] }>(`/api/users/${username}/${kind}`),
    enabled: username.length > 0,
  });

  const users = data?.results ?? [];
  const title = kind === 'followers' ? 'Followers' : 'Following';

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
      <header className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href={`/profile/${username}`} aria-label="Back to profile">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <div>
          <h1 className="font-display text-xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">@{username}</p>
        </div>
      </header>

      {isLoading ? (
        <ul className="space-y-2">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="flex items-center gap-3 p-2">
              <Skeleton className="size-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            </li>
          ))}
        </ul>
      ) : isError ? (
        <ErrorState message={`${title} could not be loaded.`} onRetry={() => void refetch()} />
      ) : users.length === 0 ? (
        <EmptyState
          icon={Users}
          title={kind === 'followers' ? 'No followers yet' : 'Not following anyone yet'}
        />
      ) : (
        <ul className="space-y-1">
          {users.map((user) => (
            <li key={user.id}>
              <FollowRow user={user} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FollowRow({ user }: { user: PublicUser }) {
  const { openChat, call, busy, callInProgress } = useUserActions();

  return (
    <div className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-secondary/60">
      <Link href={`/profile/${user.username}`} className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar
          displayName={user.displayName}
          username={user.username}
          avatarUrl={user.avatarUrl}
          isOnline={user.isOnline}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{user.username}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {user.displayName} · {formatPresence(user.isOnline, user.lastSeenAt)}
          </span>
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Message ${user.displayName}`}
          loading={busy === 'message'}
          onClick={() => void openChat(toActionTarget(user))}
        >
          <MessageCircle aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Call ${user.displayName}`}
          loading={busy === 'call'}
          disabled={callInProgress}
          onClick={() => void call(toActionTarget(user))}
        >
          <Phone aria-hidden />
        </Button>
      </div>
    </div>
  );
}
