'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Post, PublicUser } from '@sonder/shared';
import {
  Bookmark,
  Grid3x3,
  MessageCircle,
  Phone,
  Play,
  Settings,
  UserRoundX,
  Tag,
} from 'lucide-react';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Badge,
  DemoBadge,
  EmptyState,
  ErrorState,
  Skeleton,
} from '@/components/ui/feedback';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { cn, formatCount, formatPresence } from '@/lib/utils';
import { useUserActions, toActionTarget } from '@/features/users/useUserActions';
import { EditProfileDialog } from '@/features/users/EditProfileDialog';

export default function ProfilePage() {
  const params = useParams<{ username: string }>();
  const username = params?.username ?? '';
  const currentUser = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['profile', username],
    queryFn: () => api.get<{ user: PublicUser }>(`/api/users/${username}`),
    enabled: username.length > 0,
  });

  const postsQuery = useQuery({
    queryKey: ['profile-posts', username],
    queryFn: () => api.get<{ posts: Post[] }>(`/api/social/users/${username}/posts`),
    enabled: username.length > 0,
  });

  const follow = useMutation({
    mutationFn: (next: boolean) =>
      api.post<{ isFollowing: boolean; followers: number }>(
        `/api/users/${username}/follow`,
        { follow: next },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profile', username] });
    },
  });

  const { openChat, call, busy, callInProgress } = useUserActions();

  if (isLoading) return <ProfileSkeleton />;
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <ErrorState
          title="Profile not found"
          message="That account does not exist, or it is no longer available."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const user = data.user;
  const isSelf = user.viewer?.isSelf ?? currentUser?.id === user.id;
  const blockedByThem = user.viewer?.hasBlockedMe ?? false;
  const posts = postsQuery.data?.posts ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-10 pt-6 md:px-6">
      {/* Header */}
      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-10">
        <div className="flex justify-center sm:justify-start">
          <UserAvatar
            displayName={user.displayName}
            username={user.username}
            avatarUrl={user.avatarUrl}
            size="3xl"
            isOnline={isSelf ? undefined : user.isOnline}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-xl font-bold">{user.username}</h1>
            {user.isOnline && !isSelf ? (
              <Badge variant="success">Online</Badge>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {isSelf ? (
                <>
                  <EditProfileDialog />
                  <Button variant="secondary" size="sm" asChild>
                    <Link href="/settings">
                      <Settings aria-hidden />
                      Settings
                    </Link>
                  </Button>
                </>
              ) : blockedByThem ? (
                <Badge variant="destructive">Unavailable</Badge>
              ) : (
                <>
                  {/* REAL messaging. Opens the actual conversation. */}
                  <Button
                    variant="brand"
                    size="sm"
                    loading={busy === 'message'}
                    onClick={() => void openChat(toActionTarget(user))}
                  >
                    <MessageCircle aria-hidden />
                    Message
                  </Button>

                  {/* REAL calling. Starts WebRTC signalling. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === 'call'}
                    disabled={callInProgress}
                    onClick={() => void call(toActionTarget(user))}
                  >
                    <Phone aria-hidden />
                    Call
                  </Button>

                  <Button
                    variant={user.viewer?.isFollowing ? 'outline' : 'secondary'}
                    size="sm"
                    loading={follow.isPending}
                    onClick={() => follow.mutate(!user.viewer?.isFollowing)}
                  >
                    {user.viewer?.isFollowing ? 'Following' : 'Follow'}
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Counts. Posts/followers/following are seeded demo data. */}
          <dl className="flex gap-8 text-sm">
            <Stat label="posts" value={user.counts?.posts ?? 0} />
            <Stat
              label="followers"
              value={user.counts?.followers ?? 0}
              href={`/profile/${user.username}/followers`}
            />
            <Stat
              label="following"
              value={user.counts?.following ?? 0}
              href={`/profile/${user.username}/following`}
            />
          </dl>

          <div className="space-y-1">
            <p className="font-semibold">{user.displayName}</p>
            {user.bio ? (
              <p className="whitespace-pre-line text-sm leading-relaxed">{user.bio}</p>
            ) : null}
            {!isSelf ? (
              <p className="text-xs text-muted-foreground">
                {formatPresence(user.isOnline, user.lastSeenAt)}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      {/* Content tabs */}
      <Tabs defaultValue="posts" className="mt-10">
        <div className="flex items-center justify-between border-t border-border">
          <TabsList className="w-full justify-center gap-8 sm:justify-start">
            <TabsTrigger value="posts">
              <Grid3x3 className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Posts</span>
            </TabsTrigger>
            <TabsTrigger value="reels">
              <Play className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Reels</span>
            </TabsTrigger>
            <TabsTrigger value="tagged">
              <Tag className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Tagged</span>
            </TabsTrigger>
            {isSelf ? (
              <TabsTrigger value="saved">
                <Bookmark className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">Saved</span>
              </TabsTrigger>
            ) : null}
          </TabsList>
          <DemoBadge className="ml-4 hidden shrink-0 sm:inline-flex" />
        </div>

        <TabsContent value="posts" className="mt-4 focus-visible:outline-none">
          {postsQuery.isLoading ? (
            <PostGridSkeleton />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={Grid3x3}
              title="No posts yet"
              description={
                isSelf
                  ? 'Posts are seeded demo content in this build — see the docs for what is real.'
                  : 'This account has not posted anything.'
              }
            />
          ) : (
            <PostGrid posts={posts} />
          )}
        </TabsContent>

        <TabsContent value="reels" className="mt-4 focus-visible:outline-none">
          <EmptyState
            icon={Play}
            title="Reels live in the Reels tab"
            description="Per-profile reels are not part of the demo social layer."
            action={
              <Button variant="secondary" size="sm" asChild>
                <Link href="/reels">Open Reels</Link>
              </Button>
            }
          />
        </TabsContent>

        <TabsContent value="tagged" className="mt-4 focus-visible:outline-none">
          <EmptyState
            icon={Tag}
            title="Nothing tagged"
            description="Tagging is not implemented — this tab exists to complete the familiar profile layout."
          />
        </TabsContent>

        {isSelf ? (
          <TabsContent value="saved" className="mt-4 focus-visible:outline-none">
            <EmptyState
              icon={Bookmark}
              title="Your saved posts"
              description="Saving works and is stored in the database."
              action={
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/saved">Open saved</Link>
                </Button>
              }
            />
          </TabsContent>
        ) : null}
      </Tabs>

      {user.viewer?.isBlocked ? (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <UserRoundX className="size-5 shrink-0 text-destructive" aria-hidden />
          <span className="flex-1">You have blocked this account.</span>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href?: string;
}) {
  const content = (
    <>
      <dd className="tabular font-bold">{formatCount(value)}</dd>
      <dt className="text-muted-foreground">{label}</dt>
    </>
  );
  return href ? (
    <Link href={href} className="flex gap-1.5 hover:underline">
      {content}
    </Link>
  ) : (
    <div className="flex gap-1.5">{content}</div>
  );
}

function PostGrid({ posts }: { posts: Post[] }) {
  return (
    <ul className="grid grid-cols-3 gap-0.5 sm:gap-1">
      {posts.map((post) => (
        <li key={post.id} className="relative aspect-square overflow-hidden">
          <img
            src={post.mediaUrl}
            alt={post.caption}
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 hover:scale-105"
          />
        </li>
      ))}
    </ul>
  );
}

function PostGridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-0.5 sm:gap-1">
      {Array.from({ length: 9 }, (_, index) => (
        <Skeleton key={index} className="aspect-square rounded-none" />
      ))}
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-6 md:px-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
        <Skeleton className="mx-auto size-32 rounded-full sm:mx-0" />
        <div className="flex-1 space-y-4">
          <Skeleton className="h-6 w-40" />
          <div className="flex gap-8">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
      </div>
      <div className={cn('mt-10 grid grid-cols-3 gap-1 border-t border-border pt-4')}>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="aspect-square rounded-none" />
        ))}
      </div>
    </div>
  );
}
