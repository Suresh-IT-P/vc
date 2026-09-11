'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationItem } from '@sonder/shared';
import { Bell, Heart, MessageCircle, Phone, UserPlus, AtSign } from 'lucide-react';
import { api } from '@/lib/api';
import { UserAvatar } from '@/components/ui/avatar';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { cn, formatRelative } from '@/lib/utils';

const KIND_ICON = {
  like: Heart,
  comment: MessageCircle,
  follow: UserPlus,
  mention: AtSign,
  call: Phone,
  message: MessageCircle,
} as const;

export default function NotificationsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: NotificationItem[] }>('/api/social/notifications'),
  });

  const markRead = useMutation({
    mutationFn: () => api.post('/api/social/notifications/read'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const items = data?.notifications ?? [];
  const unread = items.filter((item) => !item.read).length;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Call and message alerts are real. Likes, comments and follows are seeded.
          </p>
        </div>
        {unread > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            loading={markRead.isPending}
            onClick={() => markRead.mutate()}
          >
            Mark all read
          </Button>
        ) : null}
      </header>

      {isLoading ? (
        <ul className="space-y-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <li key={index} className="flex items-center gap-3 p-3">
              <Skeleton className="size-11 rounded-full" />
              <Skeleton className="h-3.5 flex-1" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <ErrorState message="Notifications could not be loaded." onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="Nothing new"
          description="Missed calls and messages received while you are away will show up here."
        />
      ) : (
        <ul className="space-y-1">
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind] ?? Bell;
            const body = (
              <div
                className={cn(
                  'flex items-center gap-3 rounded-xl p-3 transition-colors',
                  item.read ? 'hover:bg-secondary/60' : 'bg-primary/[0.06] hover:bg-primary/10',
                )}
              >
                <span className="relative shrink-0">
                  <UserAvatar
                    displayName={item.actor.displayName}
                    username={item.actor.username}
                    avatarUrl={item.actor.avatarUrl}
                  />
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground">
                    <Icon className="size-2.5" aria-hidden />
                  </span>
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed">{item.text}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatRelative(item.createdAt)} ago
                  </p>
                </div>

                {item.isReal ? <Badge variant="success">Real</Badge> : <Badge variant="demo">Demo</Badge>}
              </div>
            );

            return (
              <li key={item.id}>
                {item.href ? <Link href={item.href}>{body}</Link> : body}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
