'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicUser } from '@sonder/shared';
import { MessageCircle, Phone } from 'lucide-react';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { formatPresence } from '@/lib/utils';
import { useUserActions, toActionTarget } from '@/features/users/useUserActions';

/**
 * Suggestions come from the real user table — these are people you can actually
 * message and call, which is why the row carries both real actions.
 */
export function SuggestedUsers({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => api.get<{ results: PublicUser[] }>('/api/users/suggestions'),
  });

  const follow = useMutation({
    mutationFn: ({ username, next }: { username: string; next: boolean }) =>
      api.post(`/api/users/${username}/follow`, { follow: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['suggestions'] });
    },
  });

  const suggestions = data?.results ?? [];

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-32" />
            </div>
            <Skeleton className="h-7 w-16 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (suggestions.length === 0) return null;

  return (
    <section aria-labelledby="suggestions-heading" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2
          id="suggestions-heading"
          className="text-sm font-semibold text-muted-foreground"
        >
          Suggested for you
        </h2>
      </div>

      <ul className="space-y-3">
        {suggestions.slice(0, compact ? 4 : 6).map((user) => (
          <li key={user.id}>
            <SuggestionRow
              user={user}
              onFollow={() => follow.mutate({ username: user.username, next: true })}
              following={follow.isPending}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SuggestionRow({
  user,
  onFollow,
  following,
}: {
  user: PublicUser;
  onFollow: () => void;
  following: boolean;
}) {
  const { openChat, call, busy, callInProgress } = useUserActions();

  return (
    <div className="flex items-center gap-3">
      <Link href={`/profile/${user.username}`} className="shrink-0">
        <UserAvatar
          displayName={user.displayName}
          username={user.username}
          avatarUrl={user.avatarUrl}
          size="sm"
          isOnline={user.isOnline}
        />
      </Link>

      <div className="min-w-0 flex-1 leading-tight">
        <Link
          href={`/profile/${user.username}`}
          className="block truncate text-sm font-semibold hover:underline"
        >
          {user.username}
        </Link>
        <span className="block truncate text-xs text-muted-foreground">
          {formatPresence(user.isOnline, user.lastSeenAt)}
        </span>
      </div>

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
        <Button variant="link" size="sm" onClick={onFollow} loading={following}>
          Follow
        </Button>
      </div>
    </div>
  );
}
