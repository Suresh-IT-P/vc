import type { PublicUser } from '@sonder/shared';
import { prisma } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { toPublicUser } from '../../lib/serialize.js';

const PUBLIC_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  isOnline: true,
  lastSeenAt: true,
} as const;

/**
 * No `mode: 'insensitive'` — Prisma rejects it on SQLite. SQLite's own `LIKE` is
 * case-insensitive for ASCII, which covers usernames (validated to `[a-z0-9._]`)
 * and nearly all display names; a non-ASCII display name matches
 * case-sensitively. See the note in src/db.ts and docs/database.md.
 */
export async function searchUsers(
  viewerId: string,
  query: string,
  limit: number,
): Promise<PublicUser[]> {
  const q = query.trim();
  if (!q) return [];

  // Users who blocked the viewer, or whom the viewer blocked, are invisible in
  // search — otherwise blocking would only hide the conversation, not the person.
  const blocks = await prisma.blockedUser.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
  });
  const hidden = new Set<string>([viewerId]);
  for (const b of blocks) {
    hidden.add(b.blockerId === viewerId ? b.blockedId : b.blockerId);
  }

  const rows = await prisma.user.findMany({
    where: {
      id: { notIn: [...hidden] },
      OR: [
        { username: { contains: q } },
        { displayName: { contains: q } },
      ],
    },
    select: PUBLIC_SELECT,
    // Exact-ish username matches should float to the top; a secondary sort on
    // username keeps results stable between identical-relevance rows.
    orderBy: [{ isOnline: 'desc' }, { username: 'asc' }],
    take: Math.min(limit, 50),
  });

  const lower = q.toLowerCase();
  return rows
    .map(toPublicUser)
    .sort((a, b) => relevance(b, lower) - relevance(a, lower));
}

function relevance(user: PublicUser, q: string): number {
  const username = user.username.toLowerCase();
  const name = user.displayName.toLowerCase();
  let score = 0;
  if (username === q) score += 100;
  else if (username.startsWith(q)) score += 60;
  else if (username.includes(q)) score += 30;
  if (name === q) score += 50;
  else if (name.startsWith(q)) score += 25;
  else if (name.includes(q)) score += 10;
  if (user.isOnline) score += 5;
  return score;
}

export async function getProfileByUsername(
  viewerId: string | null,
  username: string,
): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: {
      ...PUBLIC_SELECT,
      _count: { select: { posts: true, followers: true, following: true } },
    },
  });
  if (!user) throw notFound('That account does not exist.');

  const base = toPublicUser(user);
  base.counts = {
    posts: user._count.posts,
    followers: user._count.followers,
    following: user._count.following,
  };

  if (!viewerId) return base;

  const [following, followedBy, blocked, blockedMe] = await Promise.all([
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
      select: { id: true },
    }),
    prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: user.id, followingId: viewerId } },
      select: { id: true },
    }),
    prisma.blockedUser.findUnique({
      where: { blockerId_blockedId: { blockerId: viewerId, blockedId: user.id } },
      select: { id: true },
    }),
    prisma.blockedUser.findUnique({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: viewerId } },
      select: { id: true },
    }),
  ]);

  base.viewer = {
    isSelf: viewerId === user.id,
    isFollowing: Boolean(following),
    isFollowedBy: Boolean(followedBy),
    isBlocked: Boolean(blocked),
    hasBlockedMe: Boolean(blockedMe),
  };

  // Someone who blocked you should not be able to learn anything from your
  // profile beyond that it exists.
  if (base.viewer.hasBlockedMe) {
    base.isOnline = false;
    base.lastSeenAt = null;
  }
  return base;
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id }, select: PUBLIC_SELECT });
  if (!user) throw notFound('That account does not exist.');
  return toPublicUser(user);
}

/** People to follow: real accounts the viewer does not already follow. */
export async function getSuggestions(viewerId: string, limit = 8): Promise<PublicUser[]> {
  const [following, blocks] = await Promise.all([
    prisma.follow.findMany({ where: { followerId: viewerId }, select: { followingId: true } }),
    prisma.blockedUser.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
    }),
  ]);
  const exclude = new Set<string>([viewerId, ...following.map((f) => f.followingId)]);
  for (const b of blocks) exclude.add(b.blockerId === viewerId ? b.blockedId : b.blockerId);

  const rows = await prisma.user.findMany({
    where: { id: { notIn: [...exclude] } },
    select: PUBLIC_SELECT,
    orderBy: [{ isOnline: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
  return rows.map(toPublicUser);
}

export async function setFollow(
  followerId: string,
  targetUsername: string,
  follow: boolean,
): Promise<{ isFollowing: boolean; followers: number }> {
  const target = await prisma.user.findUnique({
    where: { username: targetUsername.toLowerCase() },
    select: { id: true },
  });
  if (!target) throw notFound('That account does not exist.');
  if (target.id === followerId) throw badRequest('You cannot follow yourself.');

  await assertNotBlocked(followerId, target.id);

  if (follow) {
    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId, followingId: target.id } },
      create: { followerId, followingId: target.id },
      update: {},
    });
  } else {
    await prisma.follow.deleteMany({
      where: { followerId, followingId: target.id },
    });
  }

  const followers = await prisma.follow.count({ where: { followingId: target.id } });
  return { isFollowing: follow, followers };
}

export async function listFollows(
  username: string,
  kind: 'followers' | 'following',
): Promise<PublicUser[]> {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { id: true },
  });
  if (!user) throw notFound('That account does not exist.');

  const rows =
    kind === 'followers'
      ? await prisma.follow.findMany({
          where: { followingId: user.id },
          select: { follower: { select: PUBLIC_SELECT } },
          take: 100,
          orderBy: { createdAt: 'desc' },
        })
      : await prisma.follow.findMany({
          where: { followerId: user.id },
          select: { following: { select: PUBLIC_SELECT } },
          take: 100,
          orderBy: { createdAt: 'desc' },
        });

  return rows.map((row) =>
    toPublicUser('follower' in row ? row.follower : row.following),
  );
}

export async function setBlock(
  blockerId: string,
  targetUsername: string,
  blocked: boolean,
): Promise<{ isBlocked: boolean }> {
  const target = await prisma.user.findUnique({
    where: { username: targetUsername.toLowerCase() },
    select: { id: true },
  });
  if (!target) throw notFound('That account does not exist.');
  if (target.id === blockerId) throw badRequest('You cannot block yourself.');

  if (blocked) {
    await prisma.$transaction([
      prisma.blockedUser.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId: target.id } },
        create: { blockerId, blockedId: target.id },
        update: {},
      }),
      // Blocking severs the follow graph in both directions, as users expect.
      prisma.follow.deleteMany({
        where: {
          OR: [
            { followerId: blockerId, followingId: target.id },
            { followerId: target.id, followingId: blockerId },
          ],
        },
      }),
    ]);
  } else {
    await prisma.blockedUser.deleteMany({
      where: { blockerId, blockedId: target.id },
    });
  }
  return { isBlocked: blocked };
}

export interface BlockState {
  iBlockedThem: boolean;
  theyBlockedMe: boolean;
}

export async function getBlockState(a: string, b: string): Promise<BlockState> {
  const rows = await prisma.blockedUser.findMany({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { blockerId: true },
  });
  return {
    iBlockedThem: rows.some((r) => r.blockerId === a),
    theyBlockedMe: rows.some((r) => r.blockerId === b),
  };
}

/**
 * Central guard used before creating conversations, sending messages and
 * placing calls. Deliberately gives the *same* message in both directions so a
 * blocked user cannot detect that they were specifically blocked.
 */
export async function assertNotBlocked(a: string, b: string): Promise<void> {
  const state = await getBlockState(a, b);
  if (state.iBlockedThem || state.theyBlockedMe) {
    throw forbidden('You cannot interact with this account.');
  }
}
