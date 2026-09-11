'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Story } from '@sonder/shared';
import { X } from 'lucide-react';
import { UserAvatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/feedback';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { cn, formatRelative } from '@/lib/utils';

/**
 * DEMO tier. Seeded stories with a working viewer (tap to open, tap to advance,
 * timed progress bars). There is no story upload, and "seen" state is per session
 * only — nothing about it is persisted.
 */
export function StoriesRow() {
  const currentUser = useAuthStore((state) => state.user);
  const [seen, setSeen] = React.useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['stories'],
    queryFn: () => api.get<{ stories: Story[] }>('/api/social/stories'),
  });

  const stories = data?.stories ?? [];

  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-x-auto no-scrollbar px-4 py-4">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex w-16 shrink-0 flex-col items-center gap-1.5">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-2.5 w-12" />
          </div>
        ))}
      </div>
    );
  }

  if (stories.length === 0) return null;

  return (
    <>
      <div
        className="flex gap-4 overflow-x-auto no-scrollbar border-b border-border px-4 py-4 sm:rounded-2xl sm:border sm:shadow-card"
        role="list"
        aria-label="Stories"
      >
        {currentUser ? (
          <div role="listitem" className="flex w-16 shrink-0 flex-col items-center gap-1.5">
            <span className="relative">
              <UserAvatar
                displayName={currentUser.displayName}
                username={currentUser.username}
                avatarUrl={currentUser.avatarUrl}
                size="lg"
              />
              <span
                className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground"
                aria-hidden
              >
                <span className="text-xs leading-none">+</span>
              </span>
            </span>
            <span className="w-full truncate text-center text-[0.7rem] text-muted-foreground">
              Your story
            </span>
          </div>
        ) : null}

        {stories.map((story, index) => (
          <button
            key={story.id}
            type="button"
            role="listitem"
            onClick={() => {
              setActiveIndex(index);
              setSeen((current) => new Set(current).add(story.id));
            }}
            className="flex w-16 shrink-0 flex-col items-center gap-1.5 focus-visible:outline-none"
          >
            <UserAvatar
              displayName={story.author.displayName}
              username={story.author.username}
              avatarUrl={story.author.avatarUrl}
              size="lg"
              hasStory
              storySeen={seen.has(story.id)}
            />
            <span className="w-full truncate text-center text-[0.7rem]">
              {story.author.username}
            </span>
          </button>
        ))}
      </div>

      <StoryViewer
        stories={stories}
        index={activeIndex}
        onClose={() => setActiveIndex(null)}
        onAdvance={(next) => {
          const story = stories[next];
          if (!story) {
            setActiveIndex(null);
            return;
          }
          setSeen((current) => new Set(current).add(story.id));
          setActiveIndex(next);
        }}
      />
    </>
  );
}

const STORY_DURATION_MS = 5000;

function StoryViewer({
  stories,
  index,
  onClose,
  onAdvance,
}: {
  stories: Story[];
  index: number | null;
  onClose: () => void;
  onAdvance: (next: number) => void;
}) {
  const open = index !== null;
  const story = index !== null ? stories[index] : undefined;
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    if (!open || index === null) return;
    setProgress(0);
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      const ratio = Math.min(1, elapsed / STORY_DURATION_MS);
      setProgress(ratio);
      if (ratio >= 1) onAdvance(index + 1);
    }, 50);
    return () => clearInterval(timer);
  }, [open, index, onAdvance]);

  if (!story || index === null) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        hideClose
        className="max-w-md gap-0 border-0 bg-black p-0 max-sm:inset-0 max-sm:h-full max-sm:rounded-none sm:rounded-2xl"
      >
        <DialogTitle className="sr-only">
          Story from {story.author.displayName}
        </DialogTitle>

        {/* Progress bars, one per story. */}
        <div className="absolute left-0 right-0 top-0 z-10 flex gap-1 p-2">
          {stories.map((item, itemIndex) => (
            <span key={item.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
              <span
                className="block h-full bg-white transition-[width] duration-75"
                style={{
                  width:
                    itemIndex < index
                      ? '100%'
                      : itemIndex === index
                        ? `${progress * 100}%`
                        : '0%',
                }}
              />
            </span>
          ))}
        </div>

        <div className="absolute left-0 right-0 top-4 z-10 flex items-center gap-2.5 px-3 pt-2">
          <UserAvatar
            displayName={story.author.displayName}
            username={story.author.username}
            avatarUrl={story.author.avatarUrl}
            size="sm"
          />
          <span className="text-sm font-semibold text-white">
            {story.author.username}
          </span>
          <span className="text-xs text-white/70">
            {formatRelative(story.createdAt)}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-white hover:bg-white/20"
            onClick={onClose}
            aria-label="Close story"
          >
            <X aria-hidden />
          </Button>
        </div>

        <button
          type="button"
          onClick={() => onAdvance(index + 1)}
          className="relative aspect-[9/16] w-full max-sm:h-full max-sm:aspect-auto"
          aria-label="Next story"
        >
          <img
            src={story.mediaUrl}
            alt=""
            className={cn('size-full object-cover')}
            draggable={false}
          />
        </button>
      </DialogContent>
    </Dialog>
  );
}
