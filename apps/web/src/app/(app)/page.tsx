'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { Post } from '@sonder/shared';
import { ImageOff, Phone, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { PostCard } from '@/features/social/PostCard';
import { StoriesRow } from '@/features/social/StoriesRow';
import { SuggestedUsers } from '@/features/social/SuggestedUsers';
import { useAuthStore } from '@/store/auth';

export default function HomePage() {
  const currentUser = useAuthStore((state) => state.user);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['feed'],
    queryFn: () => api.get<{ posts: Post[] }>('/api/social/feed'),
  });

  const posts = data?.posts ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-8 px-0 py-0 sm:px-6 sm:py-6">
      {/* Feed */}
      <div className="min-w-0 flex-1 space-y-4 sm:max-w-[38rem]">
        <StoriesRow />

        {/* A short, honest orientation card rather than a fake onboarding flow. */}
        <section className="mx-3 rounded-2xl bg-brand-gradient-soft p-4 sm:mx-0">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white">
              <Sparkles className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">
                The feed is a demo. Messaging and calling are real.
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Search for someone, open their profile and hit Call to start a real
                WebRTC audio call with live voice conversion.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="brand" size="sm" asChild>
                  <Link href="/messages">Open messages</Link>
                </Button>
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/calls">
                    <Phone aria-hidden />
                    Call history
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        {isLoading ? (
          <div className="space-y-4">
            {[0, 1].map((index) => (
              <FeedSkeleton key={index} />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            message="The feed could not be loaded."
            onRetry={() => void refetch()}
          />
        ) : posts.length === 0 ? (
          <EmptyState
            icon={ImageOff}
            title="Nothing here yet"
            description="Run `npm run db:seed` to populate the demo feed."
          />
        ) : (
          <div className="space-y-4">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}

        {/* Suggestions inline on mobile, where the sidebar is not shown. */}
        <div className="px-4 pb-6 lg:hidden">
          <SuggestedUsers compact />
        </div>
      </div>

      {/* Desktop sidebar */}
      <aside className="sticky top-6 hidden h-fit w-72 shrink-0 space-y-6 lg:block">
        {currentUser ? (
          <Link
            href={`/profile/${currentUser.username}`}
            className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-secondary/60"
          >
            <span className="shrink-0">
              <img
                src={currentUser.avatarUrl ?? '/media/avatars/placeholder.svg'}
                alt=""
                className="size-12 rounded-full object-cover"
              />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">
                {currentUser.username}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {currentUser.displayName}
              </span>
            </span>
          </Link>
        ) : null}

        <SuggestedUsers />

        <p className="text-xs leading-relaxed text-muted-foreground">
          Sonder — an original demo application. Posts, stories and reels are
          seeded sample content; authentication, messaging, presence, calling and
          voice conversion are fully implemented.
        </p>
      </aside>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-3 border-b border-border pb-4 sm:rounded-2xl sm:border sm:p-4">
      <div className="flex items-center gap-3 px-3 sm:px-0">
        <Skeleton className="size-9 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      </div>
      <Skeleton className="aspect-square w-full rounded-none sm:aspect-[4/5] sm:rounded-xl" />
      <div className="space-y-2 px-3 sm:px-0">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
