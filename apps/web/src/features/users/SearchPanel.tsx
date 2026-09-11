'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { PublicUser } from '@sonder/shared';
import { MessageCircle, Phone, Search, SearchX, UserRound } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/overlay';
import { Input } from '@/components/ui/form-controls';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { formatPresence } from '@/lib/utils';
import { useUserActions, toActionTarget } from './useUserActions';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

/**
 * Real user search against the database. Every result offers the two real
 * actions — Message and Call — so the search screen is a working entry point
 * into both core features rather than a directory.
 */
export function SearchPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = React.useState('');
  // 250 ms: long enough to avoid a request per keystroke, short enough to feel live.
  const debounced = useDebouncedValue(query.trim(), 250);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['user-search', debounced],
    queryFn: () =>
      api.get<{ results: PublicUser[] }>('/api/users/search', {
        query: { q: debounced, limit: 20 },
      }),
    enabled: open && debounced.length > 0,
  });

  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const results = data?.results ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0 sm:max-h-[80vh]">
        <div className="border-b border-border p-4">
          <DialogTitle className="sr-only">Search people</DialogTitle>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or username"
              className="pl-10"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search people"
            />
          </div>
        </div>

        <div className="max-h-[60vh] min-h-[16rem] overflow-y-auto scroll-area">
          {debounced.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title="Find someone to talk to"
              description="Search for a person by their name or @username, then message or call them."
            />
          ) : isLoading ? (
            <div className="space-y-1 p-3">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex items-center gap-3 p-2">
                  <Skeleton className="size-11 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : isError ? (
            <ErrorState
              message="Could not search right now."
              onRetry={() => void refetch()}
            />
          ) : results.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={`No results for "${debounced}"`}
              description="Check the spelling, or try their @username."
            />
          ) : (
            <ul className="p-2">
              {results.map((user) => (
                <li key={user.id}>
                  <SearchResultRow user={user} onNavigate={() => onOpenChange(false)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchResultRow({
  user,
  onNavigate,
}: {
  user: PublicUser;
  onNavigate: () => void;
}) {
  const { openChat, call, busy, callInProgress } = useUserActions();

  return (
    <div className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-secondary/60">
      <Link
        href={`/profile/${user.username}`}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <UserAvatar
          displayName={user.displayName}
          username={user.username}
          avatarUrl={user.avatarUrl}
          isOnline={user.isOnline}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{user.username}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {user.displayName} · {formatPresence(user.isOnline, user.lastSeenAt)}
          </span>
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Message ${user.displayName}`}
          loading={busy === 'message'}
          onClick={async () => {
            const id = await openChat(toActionTarget(user));
            if (id) onNavigate();
          }}
        >
          <MessageCircle aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Call ${user.displayName}`}
          loading={busy === 'call'}
          disabled={callInProgress}
          onClick={async () => {
            onNavigate();
            await call(toActionTarget(user));
          }}
        >
          <Phone aria-hidden />
        </Button>
      </div>
    </div>
  );
}
