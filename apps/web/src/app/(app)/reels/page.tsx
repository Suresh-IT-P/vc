'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Reel } from '@sonder/shared';
import {
  ArrowLeft,
  Bookmark,
  FileVideo,
  Heart,
  MessageCircle,
  Music2,
  Pause,
  Play,
  Send,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { api } from '@/lib/api';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Spinner } from '@/components/ui/feedback';
import { cn, formatCount } from '@/lib/utils';
import { useUserActions } from '@/features/users/useUserActions';

/**
 * DEMO tier — full-screen vertical reels with snap scrolling and an
 * IntersectionObserver driving playback of whichever card is on screen.
 *
 * HONESTY NOTE: the seeded reels have no video files (there is no upload or
 * transcoding pipeline in this build), so a card without a `videoUrl` renders its
 * poster and says so plainly, and hides the mute control because there is no
 * audio to mute. Drop MP4s into apps/web/public/media/reels and set `videoUrl` in
 * prisma/seed.ts to get real playback with working controls.
 */
export default function ReelsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['reels'],
    queryFn: () => api.get<{ reels: Reel[] }>('/api/social/reels'),
  });

  const [muted, setMuted] = React.useState(true);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const reels = data?.reels ?? [];

  // Whichever card is at least 60% visible becomes the active one.
  React.useEffect(() => {
    const root = containerRef.current;
    if (!root || reels.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            setActiveId((entry.target as HTMLElement).dataset.reelId ?? null);
          }
        }
      },
      { root, threshold: [0.6] },
    );

    for (const node of root.querySelectorAll('[data-reel-id]')) {
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, [reels]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-black">
        <Spinner label="Loading reels" />
      </div>
    );
  }

  if (reels.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-black text-white">
        <EmptyState
          icon={FileVideo}
          title="No reels yet"
          description="Seed the database to populate this feed."
        />
      </div>
    );
  }

  return (
    <div className="relative h-full bg-black" style={{ height: 'var(--app-height)' }}>
      <header className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-3 py-3 pt-safe">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-white hover:bg-white/20 md:hidden"
          asChild
        >
          <Link href="/" aria-label="Back">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <h1 className="font-display text-lg font-bold text-white">Reels</h1>
        <Badge variant="secondary" className="bg-white/15 text-white">
          Demo
        </Badge>
      </header>

      <div
        ref={containerRef}
        className="h-full snap-y snap-mandatory overflow-y-auto overscroll-y-contain scroll-area"
      >
        {reels.map((reel) => (
          <ReelCard
            key={reel.id}
            reel={reel}
            active={activeId === reel.id}
            muted={muted}
            onToggleMuted={() => setMuted((value) => !value)}
          />
        ))}
      </div>
    </div>
  );
}

function ReelCard({
  reel,
  active,
  muted,
  onToggleMuted,
}: {
  reel: Reel;
  active: boolean;
  muted: boolean;
  onToggleMuted: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const hasVideo = reel.videoUrl.trim().length > 0;

  const [playing, setPlaying] = React.useState(false);
  const [liked, setLiked] = React.useState(reel.likedByMe);
  const [likeCount, setLikeCount] = React.useState(reel.likeCount);
  const [saved, setSaved] = React.useState(false);
  const { openChat } = useUserActions();

  // Only the on-screen card plays; everything else is paused to save battery.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!hasVideo || !video) {
      setPlaying(active);
      return;
    }
    if (active) {
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      video.pause();
      video.currentTime = 0;
      setPlaying(false);
    }
  }, [active, hasVideo]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!hasVideo || !video) {
      // Nothing to play; the control pauses the poster's ambient animation.
      setPlaying((value) => !value);
      return;
    }
    if (video.paused) void video.play().then(() => setPlaying(true));
    else {
      video.pause();
      setPlaying(false);
    }
  };

  const toggleLike = () => {
    const next = !liked;
    setLiked(next);
    setLikeCount((count) => count + (next ? 1 : -1));
  };

  return (
    <section
      data-reel-id={reel.id}
      className="relative flex h-full snap-start snap-always items-center justify-center overflow-hidden"
      style={{ height: 'var(--app-height)' }}
    >
      {/* Media */}
      <button
        type="button"
        onClick={togglePlay}
        className="absolute inset-0"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {hasVideo ? (
          <video
            ref={videoRef}
            src={reel.videoUrl}
            poster={reel.posterUrl}
            muted={muted}
            loop
            playsInline
            preload="metadata"
            className="size-full object-cover"
          />
        ) : (
          <>
            <img
              src={reel.posterUrl}
              alt=""
              className={cn(
                'size-full object-cover transition-transform ease-linear [transition-duration:8000ms]',
                playing ? 'scale-110' : 'scale-100',
              )}
            />
            <span className="absolute left-1/2 top-[38%] -translate-x-1/2 rounded-full bg-black/55 px-3 py-1.5 text-[0.7rem] font-medium text-white/90 backdrop-blur">
              Preview image — no video file in this build
            </span>
          </>
        )}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 to-transparent"
        />
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/60 to-transparent"
        />

        {!playing ? (
          <span className="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur">
            <Play className="size-7 translate-x-0.5 fill-current" aria-hidden />
          </span>
        ) : null}
      </button>

      {/* Right rail */}
      <div className="absolute bottom-24 right-2 z-10 flex flex-col items-center gap-4 sm:right-4">
        <ReelAction
          icon={Heart}
          label={formatCount(likeCount)}
          active={liked}
          onClick={toggleLike}
          ariaLabel={liked ? 'Unlike' : 'Like'}
        />
        <ReelAction
          icon={MessageCircle}
          label={formatCount(reel.commentCount)}
          ariaLabel="Comments"
          onClick={() => undefined}
        />
        <ReelAction
          icon={Send}
          label={formatCount(reel.shareCount)}
          ariaLabel={`Share to a conversation with ${reel.author.displayName}`}
          onClick={() =>
            void openChat({
              id: reel.author.id,
              username: reel.author.username,
              displayName: reel.author.displayName,
              avatarUrl: reel.author.avatarUrl,
            })
          }
        />
        <ReelAction
          icon={Bookmark}
          active={saved}
          ariaLabel={saved ? 'Remove from saved' : 'Save'}
          onClick={() => setSaved((value) => !value)}
        />
        {/* Only shown when there is audio to mute. */}
        {hasVideo ? (
          <ReelAction
            icon={muted ? VolumeX : Volume2}
            ariaLabel={muted ? 'Unmute' : 'Mute'}
            onClick={onToggleMuted}
          />
        ) : null}
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex size-11 items-center justify-center rounded-full text-white transition-transform active:scale-90"
        >
          {playing ? (
            <Pause className="size-6" aria-hidden />
          ) : (
            <Play className="size-6" aria-hidden />
          )}
        </button>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-6 left-0 right-16 z-10 space-y-2.5 px-4 pb-safe text-white">
        <Link
          href={`/profile/${reel.author.username}`}
          className="flex items-center gap-2.5"
        >
          <UserAvatar
            displayName={reel.author.displayName}
            username={reel.author.username}
            avatarUrl={reel.author.avatarUrl}
            size="sm"
            className="ring-2 ring-white/60"
          />
          <span className="text-sm font-semibold">{reel.author.username}</span>
        </Link>

        <p className="line-clamp-2 text-sm leading-relaxed text-white/95">
          {reel.caption}
        </p>

        <div className="flex items-center gap-2 text-xs text-white/80">
          <Music2 className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{reel.audioLabel}</span>
        </div>
      </div>
    </section>
  );
}

function ReelAction({
  icon: Icon,
  label,
  active,
  onClick,
  ariaLabel,
}: {
  icon: typeof Heart;
  label?: string;
  active?: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      className="flex flex-col items-center gap-1 text-white transition-transform active:scale-90"
    >
      <Icon
        className={cn('size-7 drop-shadow', active && 'fill-destructive text-destructive')}
        aria-hidden
      />
      {label ? <span className="text-[0.7rem] font-semibold">{label}</span> : null}
    </button>
  );
}
