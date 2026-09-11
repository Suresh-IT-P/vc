/**
 * Seeds the demo social layer.
 *
 * Seeded accounts are real database rows and you can sign into them, but they
 * are flagged `isSeeded: true` so the UI can label them and so they can be
 * distinguished from accounts created through the real signup flow.
 *
 *   Every seeded account uses the password:  Password123
 *
 * Running this repeatedly is safe: users are upserted by username and demo
 * content is regenerated only when it is missing.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'Password123';

interface SeedUser {
  username: string;
  displayName: string;
  bio: string;
  avatar: string;
}

const USERS: SeedUser[] = [
  { username: 'aria.reed', displayName: 'Aria Reed', bio: 'Sound designer. Field recordings and long walks.', avatar: '01' },
  { username: 'milo.kade', displayName: 'Milo Kade', bio: 'Building small things on the internet.', avatar: '02' },
  { username: 'june.diaz', displayName: 'June Diaz', bio: 'Ceramics, coffee, and questionable playlists.', avatar: '03' },
  { username: 'sam.pryor', displayName: 'Sam Pryor', bio: 'Cyclist. Sometimes photographer.', avatar: '04' },
  { username: 'lena.novak', displayName: 'Lena Novak', bio: 'Architect by day. Baker on weekends.', avatar: '05' },
  { username: 'theo.quinn', displayName: 'Theo Quinn', bio: 'Writes about cities and the people in them.', avatar: '06' },
  { username: 'bea.wilder', displayName: 'Bea Wilder', bio: 'Marine biologist. Ask me about octopuses.', avatar: '07' },
  { username: 'cass.eze', displayName: 'Cass Eze', bio: 'Illustrator. Mostly plants and machines.', avatar: '08' },
  { username: 'dev.varma', displayName: 'Dev Varma', bio: 'Runs a very small record label.', avatar: '09' },
  { username: 'faye.holt', displayName: 'Faye Holt', bio: 'Climbing, coffee, and cold water.', avatar: '10' },
  { username: 'gil.arroyo', displayName: 'Gil Arroyo', bio: 'Chef. Feeding people is the whole point.', avatar: '11' },
  { username: 'rae.mendes', displayName: 'Rae Mendes', bio: 'Documentary editor. Long takes.', avatar: '12' },
];

const CAPTIONS = [
  'Golden hour did most of the work here.',
  'Three months of weekends finally paid off.',
  'Found this place by getting completely lost.',
  'Same walk, different light. Never gets old.',
  'The prototype works. Barely. But it works.',
  'Sunday reset. Nothing on the calendar.',
  'Second attempt was much better than the first.',
  'Borrowed a lens for the afternoon and got carried away.',
  'This took four tries and a lot of patience.',
  'Small thing, but I am oddly proud of it.',
  'Everyone said it would rain. It did not.',
  'New neighbourhood, first proper explore.',
  'Late night in the workshop again.',
  'Cannot stop thinking about this colour.',
  'A very good day, start to finish.',
  'Testing something new. More soon.',
  'Quiet morning before everything started.',
  'Turns out the long way round was the better way.',
];

const LOCATIONS = [
  'Lisbon, Portugal', 'Kyoto, Japan', 'Mexico City', null, 'Reykjavik, Iceland',
  'Cape Town', null, 'Copenhagen', 'Bengaluru, India', null, 'Montreal', 'Seoul',
];

const AUDIO_LABELS = [
  'original audio · aria.reed',
  'Slow Motion — Halfsound',
  'original audio · dev.varma',
  'Nightbus (edit) — Kestrel',
  'original audio · rae.mendes',
  'Paper Planes — Low Ceiling',
  'original audio · milo.kade',
  'Warm Static — Ferris Wheel',
];

const REEL_CAPTIONS = [
  'One take, no edits. Almost.',
  'How it started vs how it is going.',
  'Turn the sound on for this one.',
  'Three minutes of work, thirty seconds of payoff.',
  'The part nobody sees.',
  'Trying this again but slower.',
  'Small workshop, big mess.',
  'Ninety seconds of my favourite place.',
];

const COMMENTS = [
  'This is genuinely lovely.',
  'Okay the colours here are unreal.',
  'How did you get this shot?',
  'Saving this one.',
  'Been waiting for you to post this.',
  'Second one is my favourite.',
  'Where is this?!',
  'Fantastic work as always.',
];

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

async function main() {
  console.log('Seeding Sonder demo data...');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  /* ---- users ----------------------------------------------------------- */
  const users = [];
  for (const [index, seed] of USERS.entries()) {
    const user = await prisma.user.upsert({
      where: { username: seed.username },
      update: {
        displayName: seed.displayName,
        bio: seed.bio,
        avatarUrl: `/media/avatars/${seed.avatar}.svg`,
        isSeeded: true,
      },
      create: {
        username: seed.username,
        email: `${seed.username}@sonder.example`,
        displayName: seed.displayName,
        bio: seed.bio,
        avatarUrl: `/media/avatars/${seed.avatar}.svg`,
        passwordHash,
        isSeeded: true,
        lastSeenAt: hoursAgo(index % 12),
      },
    });
    users.push(user);
  }
  console.log(`  ${users.length} demo users`);

  /* ---- follow graph ---------------------------------------------------- */
  let follows = 0;
  for (const [i, follower] of users.entries()) {
    // A deterministic ring plus a few cross links: dense enough to look real.
    const targets = [
      users[(i + 1) % users.length],
      users[(i + 2) % users.length],
      users[(i + 5) % users.length],
      users[(i + 7) % users.length],
    ];
    for (const target of targets) {
      if (!target || target.id === follower.id) continue;
      await prisma.follow.upsert({
        where: {
          followerId_followingId: { followerId: follower.id, followingId: target.id },
        },
        update: {},
        create: { followerId: follower.id, followingId: target.id },
      });
      follows += 1;
    }
  }
  console.log(`  ${follows} follow edges`);

  /* ---- posts ----------------------------------------------------------- */
  const existingPosts = await prisma.post.count();
  if (existingPosts === 0) {
    for (let i = 0; i < 18; i += 1) {
      const author = users[i % users.length];
      if (!author) continue;
      const post = await prisma.post.create({
        data: {
          authorId: author.id,
          mediaUrl: `/media/posts/${String(i + 1).padStart(2, '0')}.svg`,
          mediaKind: 'image',
          caption: CAPTIONS[i % CAPTIONS.length] ?? '',
          location: LOCATIONS[i % LOCATIONS.length] ?? null,
          createdAt: hoursAgo(i * 5 + 1),
        },
      });

      // A couple of likes and comments each, from other seeded users.
      for (let j = 1; j <= 3 + (i % 5); j += 1) {
        const liker = users[(i + j * 3) % users.length];
        if (!liker || liker.id === author.id) continue;
        await prisma.postLike.upsert({
          where: { postId_userId: { postId: post.id, userId: liker.id } },
          update: {},
          create: { postId: post.id, userId: liker.id },
        });
      }
      for (let j = 0; j < 2; j += 1) {
        const commenter = users[(i + j * 5 + 2) % users.length];
        if (!commenter || commenter.id === author.id) continue;
        await prisma.comment.create({
          data: {
            postId: post.id,
            authorId: commenter.id,
            body: COMMENTS[(i + j) % COMMENTS.length] ?? 'Nice.',
            createdAt: hoursAgo(i * 5),
          },
        });
      }
    }
    console.log('  18 posts with likes and comments');
  } else {
    console.log(`  posts already present (${existingPosts}), skipped`);
  }

  /* ---- reels ------------------------------------------------------------ */
  const existingReels = await prisma.reel.count();
  if (existingReels === 0) {
    for (let i = 0; i < 8; i += 1) {
      const author = users[(i * 3) % users.length];
      if (!author) continue;
      await prisma.reel.create({
        data: {
          authorId: author.id,
          // Empty until you drop real MP4s into apps/web/public/media/reels.
          // The Reels UI renders the poster with an explicit "no media file"
          // state rather than pretending to play something. See docs/architecture.md.
          videoUrl: '',
          posterUrl: `/media/reels/${String(i + 1).padStart(2, '0')}.svg`,
          caption: REEL_CAPTIONS[i % REEL_CAPTIONS.length] ?? '',
          audioLabel: AUDIO_LABELS[i % AUDIO_LABELS.length] ?? 'original audio',
          likeCount: 120 + i * 317,
          commentCount: 8 + i * 13,
          shareCount: 3 + i * 7,
          createdAt: hoursAgo(i * 9 + 2),
        },
      });
    }
    console.log('  8 reels');
  } else {
    console.log(`  reels already present (${existingReels}), skipped`);
  }

  /* ---- stories ---------------------------------------------------------- */
  await prisma.story.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const liveStories = await prisma.story.count();
  if (liveStories === 0) {
    for (let i = 0; i < 8; i += 1) {
      const author = users[(i * 2) % users.length];
      if (!author) continue;
      await prisma.story.create({
        data: {
          authorId: author.id,
          mediaUrl: `/media/stories/${String(i + 1).padStart(2, '0')}.svg`,
          createdAt: hoursAgo(i + 1),
          expiresAt: new Date(NOW + (24 - i) * 3_600_000),
        },
      });
    }
    console.log('  8 stories');
  } else {
    console.log(`  stories already present (${liveStories}), skipped`);
  }

  /* ---- notifications ---------------------------------------------------- */
  const existingNotifications = await prisma.notification.count();
  if (existingNotifications === 0) {
    const primary = users[0];
    if (primary) {
      const kinds = ['LIKE', 'COMMENT', 'FOLLOW', 'MENTION'] as const;
      for (let i = 0; i < 10; i += 1) {
        const actor = users[(i + 1) % users.length];
        if (!actor) continue;
        const kind = kinds[i % kinds.length] ?? 'LIKE';
        await prisma.notification.create({
          data: {
            userId: primary.id,
            actorId: actor.id,
            kind,
            text:
              kind === 'LIKE'
                ? `${actor.displayName} liked your post.`
                : kind === 'COMMENT'
                  ? `${actor.displayName} commented: "${COMMENTS[i % COMMENTS.length]}"`
                  : kind === 'FOLLOW'
                    ? `${actor.displayName} started following you.`
                    : `${actor.displayName} mentioned you in a comment.`,
            href: null,
            readAt: i > 4 ? hoursAgo(i) : null,
            createdAt: hoursAgo(i * 3 + 1),
          },
        });
      }
      console.log('  10 demo notifications');
    }
  }

  console.log('\nDone. Sign in with any of:');
  for (const user of USERS.slice(0, 3)) {
    console.log(`  ${user.username}  /  ${SEED_PASSWORD}`);
  }
  console.log(`  ...and ${USERS.length - 3} more (see prisma/seed.ts)\n`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
