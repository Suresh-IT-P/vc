# Database

**SQLite with Prisma**, in development and in production — one schema, one engine,
no second variant to keep in sync.
Schema: [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma).

## Why SQLite

Not a shortcut — it matches a constraint the architecture already has. The API
runs as a **single process** because presence and the call registry are in-process
maps (see [deployment.md](deployment.md#scaling-past-one-api-instance)), so there
is no second writer for a network database to coordinate between. Given one
writer, a separate database server buys nothing and costs a tier: a daemon to run,
credentials to rotate, a connection pool to size, a network hop on every query.

The workload suits it. Messages and call records are small, indexed, append-mostly
rows; reads are by indexed key. There is no analytics, no fan-out, no large
uploads — media in the demo tier is static SVG on disk.

What you get concretely: `git clone && npm install && npm run dev` needs no
database at all, the test suite spins up a real database per run for the price of
a file, and a backup is a file copy.

### When to move off it

Honestly stated, since the answer is "eventually, if you grow":

| Signal | Why SQLite stops fitting |
| --- | --- |
| You need **more than one API instance** | The four Redis items in [deployment.md](deployment.md#scaling-past-one-api-instance) come first, but a shared database is on that list too. SQLite cannot serve two hosts. |
| **Sustained concurrent writes** | One writer at a time. WAL means readers never block, but a long write serialises other writes. |
| **Managed backups / replicas / PITR** | These are features of a database service. [Litestream](https://litestream.io) covers streaming replication for SQLite and is the cheapest next step. |
| Database on a **network filesystem** | SQLite's locking is unreliable over NFS/SMB, and WAL needs shared memory the mount may not provide. Keep it on local disk. |

The migration path is real, not theoretical: switch `provider` in the schema, run
`prisma migrate dev` to generate the dialect's SQL, and re-add native types. The
application code does not change — it already avoids Prisma enum types and
provider-specific query options.

---

## Models

### Real tier

| Model | Purpose | Notable constraints |
| --- | --- | --- |
| `User` | Accounts | unique `email`, unique `username`, indexed `displayName`, `isSeeded` flag |
| `UserSession` | Rotating refresh tokens | unique `tokenHash` (SHA-256 only), `replacedById` for replay detection |
| `Conversation` | 1:1 thread | **unique `pairKey`** — sorted user ids, one thread per pair |
| `ConversationParticipant` | Membership + read state | unique `(conversationId, userId)`, `lastReadAt` watermark |
| `Message` | Persisted messages | **unique `(conversationId, clientId)`** for idempotency; index `(conversationId, createdAt)` |
| `Call` | Call records | indexes on `(callerId, startedAt)` and `(calleeId, startedAt)` |
| `CallParticipant` | Per-user call view | unique `(callId, userId)`; records that user's own voice settings |
| `BlockedUser` | Blocks | unique `(blockerId, blockedId)` |
| `Notification` | Alerts | index `(userId, createdAt)`; `CALL`/`MESSAGE` are real |

### Demo tier

`Follow`, `Post`, `PostLike`, `SavedPost`, `Comment`, `Reel`, `Story`.
Deliberately lightweight — these exist so the social shell reads from a database
rather than a hard-coded array, and so likes, saves and comments are real writes.

---

## Design notes

**`pairKey`** makes a one-to-one conversation a database invariant rather than
application logic. Both users tapping "Message" simultaneously produces one
thread: the loser catches `P2002` and re-reads the winner's row.

**`Message.clientId`** turns send-retry into an upsert. The unique index is on
`(conversationId, clientId)` so keys only need to be unique per thread. SQLite
treats `NULL`s as distinct in a unique index, so server-originated rows without a
client key are fine.

**`CallParticipant.voiceChangerUsed`** is per participant, not per call. Each side
reports only its own audio, so history shows *you* used Female Bright without
claiming anything about the other person. It is sticky: once the changer was on
during a call, history says so even if it was switched off before hanging up.

**Presence is a cache.** `User.isOnline` is written from the socket registry and
reset at boot; the live registry is authoritative.

---

## Connection pragmas

[`db.ts`](../apps/server/src/db.ts) sets three pragmas on connect. They are what
make SQLite behave as a server database rather than a CLI tool's store:

| Pragma | Effect |
| --- | --- |
| `journal_mode = WAL` | Readers do not block the writer and the writer does not block readers. Without it, one in-flight message insert stalls every concurrent request. |
| `busy_timeout = 5000` | Wait for a contended write lock instead of failing instantly with `SQLITE_BUSY`. Far longer than any write here takes, so it turns a spurious error into a brief wait. |
| `synchronous = NORMAL` | Safe with WAL: survives process crashes, and can lose only the most recent commits on an OS or power failure. `FULL` costs an fsync per transaction for a guarantee a chat app does not need. |

The boot log prints the values the database actually reports
(`journal_mode=wal, busy_timeout=5000ms`) and warns if WAL did not take — the
usual cause being a database file on a filesystem without shared memory, where
SQLite silently falls back.

A detail worth knowing if you add a pragma: a *setting* pragma echoes its result,
and Prisma rejects a result set from `$executeRaw`
("Execute returned results, which is not allowed in SQLite"). Use `$queryRaw`.

`foreign_keys` is deliberately not set here — Prisma enables it per connection
itself, and the schema's `onDelete: Cascade` rules depend on it.

---

## Case-insensitive search

User search uses plain `contains` with **no `mode: 'insensitive'`** — Prisma
rejects that option on SQLite. SQLite's `LIKE` is case-insensitive for ASCII,
which covers usernames (validated to `[a-z0-9._]`) and almost all display names.

**The limitation, stated plainly:** a display name containing non-ASCII letters
matches case-sensitively, so searching `zoe` will not find `Zoë`. Fixing it
properly means storing a normalised lowercase column and searching that; it is not
implemented.

---

## Migrations

Migrations are committed under
[`apps/server/prisma/migrations/`](../apps/server/prisma/migrations) and are the
same SQL applied everywhere.

```bash
npm run db:migrate            # create + apply a migration in development
npm run db:migrate:deploy     # apply pending migrations (production / CI)
npm run db:reset              # drop, re-migrate, re-seed (destroys data)
npm run db:studio             # browse the data
npm run db:seed               # demo content (safe to re-run)
```

You rarely run these by hand: `npm run dev`, `npm start`, `npm run build` and the
test suites all run `migrate deploy` through
[preflight](../scripts/preflight.mjs) first. `deploy` is used rather than `push`
everywhere because it only ever applies migrations already in the repo — it never
invents or resets one, so it is as safe on a production file as on a dev one.

`docker/Dockerfile.server` also runs `prisma migrate deploy` on container start,
so a rolling deploy cannot serve against an old schema.

The seed is idempotent: users are upserted by username, and demo content is only
regenerated when missing.

---

## Two SQLite consequences in the schema

Both are visible in the schema header, and neither loses any type safety:

**1. No enums.** Prisma does not support them on SQLite, so `Call.type`,
`Call.status`, `Call.endReason`, `CallParticipant.role` and `Notification.kind`
are `String` columns with their legal values in a trailing comment. The values
themselves live in `@sonder/shared` as string unions — the same source the client
types against — and Zod validates every write. Application code never imported
Prisma's generated enum types, so nothing changed there.

**2. No native type attributes.** `@db.VarChar(500)` and `@db.Text` are gone;
SQLite stores `TEXT` without a declared length. Lengths are enforced by Zod at the
request boundary, which is where the error message belongs anyway.

---

## Backups

The database is one file, so a backup is a copy — but **not a plain `cp` of a live
database**, which can capture a torn write. Use SQLite's own online backup:

```bash
# Consistent backup while the server is running
sqlite3 apps/server/prisma/dev.db ".backup 'sonder-$(date +%F).db'"

# From the Docker volume
docker compose -f docker/docker-compose.yml exec server \
  sh -c "sqlite3 /data/sonder.db \".backup '/data/backup.db'\"" \
  && docker compose -f docker/docker-compose.yml cp server:/data/backup.db .

# Restore: stop the server, replace the file, start it again
```

`.backup` takes a read lock per page rather than for the whole operation, so it
does not block live traffic for long. Copy the `-wal` file too if you use `cp`
anyway, or run `PRAGMA wal_checkpoint(TRUNCATE);` first.

For continuous off-host backup, [Litestream](https://litestream.io) streams the
WAL to object storage and is the standard answer for SQLite in production.

## Retention

Expired and long-revoked `UserSession` rows are pruned every six hours by a timer
in `index.ts`; without it that table grows without bound. Messages and calls are
kept indefinitely — add a retention job if your jurisdiction requires one.
