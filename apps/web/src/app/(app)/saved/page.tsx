'use client';

import { useQuery } from '@tanstack/react-query';
import type { Post } from '@sonder/shared';
import { Bookmark } from 'lucide-react';
import { api } from '@/lib/api';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { ExploreGrid } from '@/features/social/ExploreGrid';

export default function SavedPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['saved-posts'],
    queryFn: () => api.get<{ posts: Post[] }>('/api/social/saved'),
  });

  const posts = data?.posts ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-1 py-4 sm:px-6 sm:py-6">
      <header className="mb-4 px-3 sm:px-0">
        <h1 className="font-display text-2xl font-bold">Saved</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saving is a real database write, so these persist across sessions.
        </p>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-0.5 sm:gap-1">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="aspect-square rounded-none" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState message="Saved posts could not be loaded." onRetry={() => void refetch()} />
      ) : posts.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="Nothing saved yet"
          description="Tap the bookmark on any post and it will appear here."
        />
      ) : (
        <ExploreGrid posts={posts} />
      )}
    </div>
  );
}
