'use client';

import { useQuery } from '@tanstack/react-query';
import type { Post } from '@sonder/shared';
import { Compass } from 'lucide-react';
import { api } from '@/lib/api';
import { DemoBadge, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { ExploreGrid } from '@/features/social/ExploreGrid';

export default function ExplorePage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['explore'],
    queryFn: () => api.get<{ posts: Post[] }>('/api/social/explore'),
  });

  const posts = data?.posts ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-1 py-4 sm:px-6 sm:py-6">
      <header className="mb-4 flex items-center justify-between px-3 sm:px-0">
        <h1 className="font-display text-2xl font-bold">Explore</h1>
        <DemoBadge />
      </header>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-0.5 sm:gap-1">
          {Array.from({ length: 12 }, (_, index) => (
            <Skeleton key={index} className="aspect-square rounded-none" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState message="Explore could not be loaded." onRetry={() => void refetch()} />
      ) : posts.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="Nothing to explore yet"
          description="Seed the database to populate this grid."
        />
      ) : (
        <ExploreGrid posts={posts} />
      )}
    </div>
  );
}
