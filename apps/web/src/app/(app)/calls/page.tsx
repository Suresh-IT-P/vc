'use client';

import * as React from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { CallHistoryEntry, Paginated } from '@sonder/shared';
import {
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Wand2,
  Phone,
} from 'lucide-react';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { cn, formatClockTime, formatDuration, groupByDay } from '@/lib/utils';
import { useUserActions } from '@/features/users/useUserActions';
import { VOICE_PRESETS } from '@sonder/shared';

const STATUS_META: Record<
  CallHistoryEntry['status'],
  { icon: typeof Phone; label: string; className: string }
> = {
  completed: { icon: PhoneIncoming, label: 'Completed', className: 'text-signal-excellent' },
  missed: { icon: PhoneMissed, label: 'Missed', className: 'text-destructive' },
  rejected: { icon: PhoneOff, label: 'Declined', className: 'text-muted-foreground' },
  cancelled: { icon: PhoneOff, label: 'Cancelled', className: 'text-muted-foreground' },
  failed: { icon: PhoneOff, label: 'Failed', className: 'text-signal-poor' },
};

export default function CallsPage() {
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['call-history'],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        api.get<Paginated<CallHistoryEntry>>('/api/calls/history', {
          query: { limit: 30, cursor: pageParam },
        }),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  const entries = React.useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data],
  );
  const groups = React.useMemo(
    () => groupByDay(entries, (entry) => entry.startedAt),
    [entries],
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold">Calls</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every call is recorded here from the database, including the voice preset
          you used.
        </p>
      </header>

      {isLoading ? (
        <ul className="space-y-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <li key={index} className="flex items-center gap-3 rounded-xl p-3">
              <Skeleton className="size-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-44" />
              </div>
            </li>
          ))}
        </ul>
      ) : isError ? (
        <ErrorState
          message="Your call history could not be loaded."
          onRetry={() => void refetch()}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Phone}
          title="No calls yet"
          description="Call someone from their profile or a conversation, and it will show up here."
          action={
            <Button variant="brand" size="sm" asChild>
              <Link href="/messages">Open messages</Link>
            </Button>
          }
        />
      ) : (
        <>
          {groups.map((group) => (
            <section key={group.label} className="mb-6">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </h2>
              <ul className="space-y-1">
                {group.items.map((entry) => (
                  <li key={entry.id}>
                    <CallRow entry={entry} />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {hasNextPage ? (
            <div className="flex justify-center pb-4">
              <Button
                variant="secondary"
                size="sm"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function CallRow({ entry }: { entry: CallHistoryEntry }) {
  const meta = STATUS_META[entry.status];
  const DirectionIcon = entry.direction === 'outgoing' ? PhoneOutgoing : PhoneIncoming;
  const Icon = entry.status === 'completed' ? DirectionIcon : meta.icon;
  const { call, busy, callInProgress } = useUserActions();

  const presetLabel = entry.voicePreset
    ? (VOICE_PRESETS[entry.voicePreset as keyof typeof VOICE_PRESETS]?.label ??
      entry.voicePreset)
    : null;

  return (
    <div className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-secondary/60">
      <Link href={`/profile/${entry.peer.username}`} className="shrink-0">
        <UserAvatar
          displayName={entry.peer.displayName}
          username={entry.peer.username}
          avatarUrl={entry.peer.avatarUrl}
          size="lg"
        />
      </Link>

      <div className="min-w-0 flex-1">
        <Link
          href={`/profile/${entry.peer.username}`}
          className="block truncate text-sm font-semibold hover:underline"
        >
          {entry.peer.displayName}
        </Link>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={cn('inline-flex items-center gap-1', meta.className)}>
            <Icon className="size-3.5" aria-hidden />
            {entry.status === 'completed'
              ? entry.direction === 'outgoing'
                ? 'Outgoing'
                : 'Incoming'
              : meta.label}
          </span>
          <span aria-hidden>·</span>
          <time dateTime={entry.startedAt}>{formatClockTime(entry.startedAt)}</time>
          {entry.durationSec > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="tabular">{formatDuration(entry.durationSec)}</span>
            </>
          ) : null}
        </div>

        {/* Only shown when this viewer actually had the changer on. */}
        {entry.voiceChangerUsed ? (
          <Badge variant="default" className="mt-1.5">
            <Wand2 className="size-3" aria-hidden />
            {presetLabel ?? 'Voice changer'}
          </Badge>
        ) : null}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Call ${entry.peer.displayName} back`}
        loading={busy === 'call'}
        disabled={callInProgress}
        onClick={() => void call(entry.peer)}
      >
        <Phone aria-hidden />
      </Button>
    </div>
  );
}
