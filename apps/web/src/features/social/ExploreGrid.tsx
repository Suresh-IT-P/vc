'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Post } from '@sonder/shared';
import { Heart, MessageCircle, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { cn, formatCount, formatRelative } from '@/lib/utils';
import { useUserActions } from '@/features/users/useUserActions';
import { MessageCircle as MessageIcon, Phone } from 'lucide-react';

/**
 * DEMO tier. A masonry-ish grid where every third tile is tall, which is what
 * gives the familiar explore rhythm without needing real aspect-ratio metadata.
 */
export function ExploreGrid({ posts }: { posts: Post[] }) {
  const [active, setActive] = React.useState<Post | null>(null);

  return (
    <>
      <ul className="grid auto-rows-[minmax(0,1fr)] grid-cols-3 gap-0.5 sm:gap-1">
        {posts.map((post, index) => {
          // Every 7th tile spans two rows, breaking up the uniform grid.
          const tall = index % 7 === 3;
          return (
            <li
              key={post.id}
              className={cn('relative overflow-hidden', tall ? 'row-span-2' : 'aspect-square')}
            >
              <button
                type="button"
                onClick={() => setActive(post)}
                className="group relative block size-full"
                aria-label={`Open post by ${post.author.username}`}
              >
                <img
                  src={post.mediaUrl}
                  alt={post.caption}
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <span className="absolute inset-0 hidden items-center justify-center gap-5 bg-black/45 text-sm font-semibold text-white group-hover:flex">
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="size-4 fill-current" aria-hidden />
                    {formatCount(post.likeCount)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <MessageCircle className="size-4 fill-current" aria-hidden />
                    {formatCount(post.commentCount)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <PostPreview post={active} onClose={() => setActive(null)} />
    </>
  );
}

function PostPreview({ post, onClose }: { post: Post | null; onClose: () => void }) {
  const { openChat, call, callInProgress } = useUserActions();

  return (
    <Dialog open={post !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent hideClose className="max-w-3xl gap-0 overflow-hidden p-0">
        {post ? (
          <div className="grid sm:grid-cols-[1.2fr_1fr]">
            <div className="relative aspect-square bg-muted sm:aspect-auto">
              <img
                src={post.mediaUrl}
                alt={post.caption}
                className="size-full object-cover"
              />
            </div>

            <div className="flex min-h-0 flex-col">
              <div className="flex items-center gap-3 border-b border-border p-4">
                <Link href={`/profile/${post.author.username}`} onClick={onClose}>
                  <UserAvatar
                    displayName={post.author.displayName}
                    username={post.author.username}
                    avatarUrl={post.author.avatarUrl}
                    size="sm"
                  />
                </Link>
                <div className="min-w-0 flex-1">
                  <DialogTitle asChild>
                    <Link
                      href={`/profile/${post.author.username}`}
                      onClick={onClose}
                      className="block truncate text-sm font-semibold hover:underline"
                    >
                      {post.author.username}
                    </Link>
                  </DialogTitle>
                  {post.location ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {post.location}
                    </span>
                  ) : null}
                </div>
                <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
                  <X aria-hidden />
                </Button>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto scroll-area p-4">
                <p className="text-sm leading-relaxed">
                  <span className="font-semibold">{post.author.username}</span>{' '}
                  {post.caption}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCount(post.likeCount)} likes ·{' '}
                  {formatRelative(post.createdAt)} ago
                </p>
              </div>

              {/* The real actions, reachable from anywhere a person appears. */}
              <div className="flex gap-2 border-t border-border p-4">
                <Button
                  variant="brand"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    onClose();
                    void openChat({
                      id: post.author.id,
                      username: post.author.username,
                      displayName: post.author.displayName,
                      avatarUrl: post.author.avatarUrl,
                    });
                  }}
                >
                  <MessageIcon aria-hidden />
                  Message
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  disabled={callInProgress}
                  onClick={() => {
                    onClose();
                    void call({
                      id: post.author.id,
                      username: post.author.username,
                      displayName: post.author.displayName,
                      avatarUrl: post.author.avatarUrl,
                    });
                  }}
                >
                  <Phone aria-hidden />
                  Call
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
