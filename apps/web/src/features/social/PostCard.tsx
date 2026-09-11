'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Comment, Post } from '@sonder/shared';
import {
  Bookmark,
  Heart,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Send,
} from 'lucide-react';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form-controls';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/controls';
import { api } from '@/lib/api';
import { cn, formatCount, formatRelative } from '@/lib/utils';
import { useUserActions } from '@/features/users/useUserActions';
import { useAuthStore } from '@/store/auth';

/**
 * DEMO tier — but not fake.
 *
 * Likes, saves and comments are real database writes against the seeded content,
 * so no button here does nothing. What is *not* implemented is the rest of a
 * social backend: no uploads, no ranking, no notifications fan-out. The post
 * menu's Message and Call entries jump into the real features.
 */
export function PostCard({ post }: { post: Post }) {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((state) => state.user);
  const { openChat, call, callInProgress } = useUserActions();

  const [liked, setLiked] = React.useState(post.likedByMe);
  const [likeCount, setLikeCount] = React.useState(post.likeCount);
  const [saved, setSaved] = React.useState(post.savedByMe);
  const [comments, setComments] = React.useState<Comment[]>(post.comments);
  const [commentDraft, setCommentDraft] = React.useState('');
  const [showAllComments, setShowAllComments] = React.useState(false);

  const isOwnPost = currentUser?.id === post.author.id;

  const likeMutation = useMutation({
    mutationFn: (next: boolean) =>
      api.post<{ liked: boolean; likeCount: number }>(`/api/social/posts/${post.id}/like`, {
        liked: next,
      }),
    onSuccess: (result) => setLikeCount(result.likeCount),
    onError: () => {
      // Roll the optimistic update back rather than leaving a wrong count.
      setLiked((value) => !value);
      setLikeCount(post.likeCount);
      toast.error('Could not update your like.');
    },
  });

  const saveMutation = useMutation({
    mutationFn: (next: boolean) =>
      api.post<{ saved: boolean }>(`/api/social/posts/${post.id}/save`, { saved: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-posts'] });
    },
    onError: () => {
      setSaved((value) => !value);
      toast.error('Could not update saved posts.');
    },
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) =>
      api.post<{ comment: Comment }>(`/api/social/posts/${post.id}/comments`, { body }),
    onSuccess: (result) => {
      setComments((current) => [...current, result.comment]);
      setCommentDraft('');
    },
    onError: () => toast.error('Could not post your comment.'),
  });

  const toggleLike = () => {
    const next = !liked;
    setLiked(next);
    setLikeCount((count) => count + (next ? 1 : -1));
    likeMutation.mutate(next);
  };

  const toggleSave = () => {
    const next = !saved;
    setSaved(next);
    saveMutation.mutate(next);
  };

  const visibleComments = showAllComments ? comments : comments.slice(0, 2);

  return (
    <article className="border-b border-border pb-4 sm:rounded-2xl sm:border sm:shadow-card">
      {/* Header */}
      <header className="flex items-center gap-3 px-3 py-3 sm:px-4">
        <Link href={`/profile/${post.author.username}`} className="shrink-0">
          <UserAvatar
            displayName={post.author.displayName}
            username={post.author.username}
            avatarUrl={post.author.avatarUrl}
            size="sm"
            hasStory
          />
        </Link>
        <div className="min-w-0 flex-1 leading-tight">
          <Link
            href={`/profile/${post.author.username}`}
            className="block truncate text-sm font-semibold hover:underline"
          >
            {post.author.username}
          </Link>
          {post.location ? (
            <span className="block truncate text-xs text-muted-foreground">
              {post.location}
            </span>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Post options">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!isOwnPost ? (
              <>
                {/* These two jump straight into the real features. */}
                <DropdownMenuItem
                  onSelect={() =>
                    void openChat({
                      id: post.author.id,
                      username: post.author.username,
                      displayName: post.author.displayName,
                      avatarUrl: post.author.avatarUrl,
                    })
                  }
                >
                  <MessageCircle className="size-4" aria-hidden />
                  Message {post.author.displayName}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={callInProgress}
                  onSelect={() =>
                    void call({
                      id: post.author.id,
                      username: post.author.username,
                      displayName: post.author.displayName,
                      avatarUrl: post.author.avatarUrl,
                    })
                  }
                >
                  <Phone className="size-4" aria-hidden />
                  Call {post.author.displayName}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => toggleSave()}>
              <Bookmark className="size-4" aria-hidden />
              {saved ? 'Remove from saved' : 'Save post'}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/profile/${post.author.username}`}>
                View profile
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Media. Double-tap/click to like, as expected. */}
      <div
        className="relative aspect-square w-full select-none overflow-hidden bg-muted sm:aspect-[4/5]"
        onDoubleClick={() => {
          if (!liked) toggleLike();
        }}
      >
        <img
          src={post.mediaUrl}
          alt={post.caption}
          loading="lazy"
          className="size-full object-cover"
          draggable={false}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 px-2 pt-2 sm:px-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleLike}
          aria-label={liked ? 'Unlike' : 'Like'}
          aria-pressed={liked}
        >
          <Heart
            className={cn('transition-all', liked && 'fill-destructive text-destructive scale-110')}
            aria-hidden
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Comment"
          onClick={() => {
            setShowAllComments(true);
            document.getElementById(`comment-${post.id}`)?.focus();
          }}
        >
          <MessageCircle aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Share via message"
          onClick={() =>
            void openChat({
              id: post.author.id,
              username: post.author.username,
              displayName: post.author.displayName,
              avatarUrl: post.author.avatarUrl,
            })
          }
        >
          <Send aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={toggleSave}
          aria-label={saved ? 'Remove from saved' : 'Save'}
          aria-pressed={saved}
        >
          <Bookmark className={cn(saved && 'fill-current')} aria-hidden />
        </Button>
      </div>

      {/* Meta */}
      <div className="space-y-1.5 px-3 pt-1 sm:px-4">
        <p className="text-sm font-semibold">
          {formatCount(likeCount)} {likeCount === 1 ? 'like' : 'likes'}
        </p>

        {post.caption ? (
          <p className="text-sm leading-relaxed">
            <Link
              href={`/profile/${post.author.username}`}
              className="font-semibold hover:underline"
            >
              {post.author.username}
            </Link>{' '}
            {post.caption}
          </p>
        ) : null}

        {comments.length > 2 && !showAllComments ? (
          <button
            type="button"
            onClick={() => setShowAllComments(true)}
            className="text-sm text-muted-foreground hover:underline"
          >
            View all {comments.length} comments
          </button>
        ) : null}

        <ul className="space-y-1">
          {visibleComments.map((comment) => (
            <li key={comment.id} className="text-sm leading-relaxed">
              <Link
                href={`/profile/${comment.author.username}`}
                className="font-semibold hover:underline"
              >
                {comment.author.username}
              </Link>{' '}
              {comment.body}
            </li>
          ))}
        </ul>

        <time
          dateTime={post.createdAt}
          className="block text-[0.7rem] uppercase tracking-wide text-muted-foreground"
        >
          {formatRelative(post.createdAt)} ago
        </time>
      </div>

      {/* Comment composer — a real write. */}
      <form
        className="mt-3 flex items-center gap-2 border-t border-border px-3 pt-3 sm:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = commentDraft.trim();
          if (body) commentMutation.mutate(body);
        }}
      >
        <Input
          id={`comment-${post.id}`}
          value={commentDraft}
          onChange={(event) => setCommentDraft(event.target.value)}
          placeholder="Add a comment…"
          className="h-9 border-0 bg-transparent px-0 focus-visible:ring-0"
          maxLength={600}
          aria-label={`Comment on ${post.author.username}'s post`}
        />
        <Button
          type="submit"
          variant="link"
          size="sm"
          disabled={!commentDraft.trim()}
          loading={commentMutation.isPending}
        >
          Post
        </Button>
      </form>
    </article>
  );
}
