import type {
  Comment,
  DemoAuthor,
  NotificationItem,
  Post,
  Reel,
  Story,
} from '@sonder/shared';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';

/**
 * DEMO TIER.
 *
 * These endpoints exist so the social shell is not made of hard-coded arrays in
 * the frontend, and so the like / save / comment buttons actually do something.
 * They are intentionally not a full social backend: there is no media upload,
 * no ranking, no fan-out. Anything that matters — auth, messaging, calling — is
 * in the modules above. See docs/architecture.md "Real vs Demo".
 */

const AUTHOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  isSeeded: true,
} as const;

type AuthorRow = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isSeeded: boolean;
};

function toAuthor(row: AuthorRow): DemoAuthor {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    isRealUser: !row.isSeeded,
  };
}

export async function listFeed(viewerId: string, limit = 20): Promise<Post[]> {
  const rows = await prisma.post.findMany({
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: viewerId }, select: { id: true } },
      saves: { where: { userId: viewerId }, select: { id: true } },
      comments: {
        include: { author: { select: AUTHOR_SELECT } },
        orderBy: { createdAt: 'asc' },
        take: 2,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    author: toAuthor(row.author),
    mediaUrl: row.mediaUrl,
    mediaKind: row.mediaKind === 'video' ? 'video' : 'image',
    caption: row.caption,
    location: row.location,
    likeCount: row._count.likes,
    commentCount: row._count.comments,
    createdAt: row.createdAt.toISOString(),
    likedByMe: row.likes.length > 0,
    savedByMe: row.saves.length > 0,
    comments: row.comments.map(toComment),
  }));
}

function toComment(row: {
  id: string;
  body: string;
  createdAt: Date;
  author: AuthorRow;
}): Comment {
  return {
    id: row.id,
    author: toAuthor(row.author),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    likeCount: 0,
  };
}

export async function listExplore(viewerId: string, limit = 30): Promise<Post[]> {
  const rows = await prisma.post.findMany({
    where: { authorId: { not: viewerId } },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: viewerId }, select: { id: true } },
      saves: { where: { userId: viewerId }, select: { id: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    author: toAuthor(row.author),
    mediaUrl: row.mediaUrl,
    mediaKind: row.mediaKind === 'video' ? 'video' : 'image',
    caption: row.caption,
    location: row.location,
    likeCount: row._count.likes,
    commentCount: row._count.comments,
    createdAt: row.createdAt.toISOString(),
    likedByMe: row.likes.length > 0,
    savedByMe: row.saves.length > 0,
    comments: [],
  }));
}

export async function listUserPosts(username: string, viewerId: string): Promise<Post[]> {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { id: true },
  });
  if (!user) throw notFound('That account does not exist.');

  const rows = await prisma.post.findMany({
    where: { authorId: user.id },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: viewerId }, select: { id: true } },
      saves: { where: { userId: viewerId }, select: { id: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    author: toAuthor(row.author),
    mediaUrl: row.mediaUrl,
    mediaKind: row.mediaKind === 'video' ? 'video' : 'image',
    caption: row.caption,
    location: row.location,
    likeCount: row._count.likes,
    commentCount: row._count.comments,
    createdAt: row.createdAt.toISOString(),
    likedByMe: row.likes.length > 0,
    savedByMe: row.saves.length > 0,
    comments: [],
  }));
}

export async function listSaved(viewerId: string): Promise<Post[]> {
  const rows = await prisma.savedPost.findMany({
    where: { userId: viewerId },
    include: {
      post: {
        include: {
          author: { select: AUTHOR_SELECT },
          _count: { select: { likes: true, comments: true } },
          likes: { where: { userId: viewerId }, select: { id: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(({ post }) => ({
    id: post.id,
    author: toAuthor(post.author),
    mediaUrl: post.mediaUrl,
    mediaKind: post.mediaKind === 'video' ? 'video' : 'image',
    caption: post.caption,
    location: post.location,
    likeCount: post._count.likes,
    commentCount: post._count.comments,
    createdAt: post.createdAt.toISOString(),
    likedByMe: post.likes.length > 0,
    savedByMe: true,
    comments: [],
  }));
}

export async function listReels(limit = 20): Promise<Reel[]> {
  const rows = await prisma.reel.findMany({
    include: { author: { select: AUTHOR_SELECT } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    author: toAuthor(row.author),
    videoUrl: row.videoUrl,
    posterUrl: row.posterUrl,
    caption: row.caption,
    audioLabel: row.audioLabel,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    shareCount: row.shareCount,
    likedByMe: false,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listStories(): Promise<Story[]> {
  const rows = await prisma.story.findMany({
    where: { expiresAt: { gt: new Date() } },
    include: { author: { select: AUTHOR_SELECT } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return rows.map((row) => ({
    id: row.id,
    author: toAuthor(row.author),
    mediaUrl: row.mediaUrl,
    seen: false,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function setLike(
  viewerId: string,
  postId: string,
  liked: boolean,
): Promise<{ liked: boolean; likeCount: number }> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw notFound('That post does not exist.');

  if (liked) {
    await prisma.postLike.upsert({
      where: { postId_userId: { postId, userId: viewerId } },
      create: { postId, userId: viewerId },
      update: {},
    });
  } else {
    await prisma.postLike.deleteMany({ where: { postId, userId: viewerId } });
  }
  return { liked, likeCount: await prisma.postLike.count({ where: { postId } }) };
}

export async function setSaved(
  viewerId: string,
  postId: string,
  saved: boolean,
): Promise<{ saved: boolean }> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw notFound('That post does not exist.');

  if (saved) {
    await prisma.savedPost.upsert({
      where: { postId_userId: { postId, userId: viewerId } },
      create: { postId, userId: viewerId },
      update: {},
    });
  } else {
    await prisma.savedPost.deleteMany({ where: { postId, userId: viewerId } });
  }
  return { saved };
}

export async function addComment(
  viewerId: string,
  postId: string,
  body: string,
): Promise<Comment> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw notFound('That post does not exist.');

  const row = await prisma.comment.create({
    data: { postId, authorId: viewerId, body: body.trim() },
    include: { author: { select: AUTHOR_SELECT } },
  });
  return toComment(row);
}

export async function listComments(postId: string): Promise<Comment[]> {
  const rows = await prisma.comment.findMany({
    where: { postId },
    include: { author: { select: AUTHOR_SELECT } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  return rows.map(toComment);
}

/**
 * Notifications mix seeded social noise with genuinely real rows written by the
 * messaging and calling code. `isReal` tells the UI which is which, and only
 * real ones get a working deep link.
 */
export async function listNotifications(viewerId: string): Promise<NotificationItem[]> {
  const rows = await prisma.notification.findMany({
    where: { userId: viewerId },
    include: { actor: { select: AUTHOR_SELECT } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind.toLowerCase() as NotificationItem['kind'],
    actor: row.actor
      ? toAuthor(row.actor)
      : {
          id: 'system',
          username: 'sonder',
          displayName: 'Sonder',
          avatarUrl: null,
          isRealUser: false,
        },
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    read: row.readAt !== null,
    href: row.href,
    isReal: row.kind === 'CALL' || row.kind === 'MESSAGE',
  }));
}

export async function markNotificationsRead(viewerId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId: viewerId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

/** Used by the calling code to log genuinely real missed-call notifications. */
export async function createNotification(input: {
  userId: string;
  actorId: string | null;
  kind: 'CALL' | 'MESSAGE';
  text: string;
  href: string | null;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      actorId: input.actorId,
      kind: input.kind,
      text: input.text.slice(0, 300),
      href: input.href?.slice(0, 300) ?? null,
    },
  });
}
