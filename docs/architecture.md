# Architecture

## Shape

```
┌────────────────── apps/web ──────────────────┐
│  Next.js 15 · React 19 · Tailwind            │
│  Zustand (auth · messaging · call · ui)      │
│  TanStack Query (demo social reads)          │
│  voice/  ── AudioPipeline, converters        │
│  features/calling/ ── CallSession (WebRTC)   │
└───────┬───────────────────┬──────────────────┘
        │ REST              │ Socket.IO
        ▼                   ▼
┌────────────── apps/server ───────────────────┐
│  Express · Zod · Socket.IO                   │
│  modules/  auth users messaging calls social │
│  realtime/ presence · handlers · throttle    │
└───────┬──────────────────────────────────────┘
        │ Prisma
        ▼
     SQLite (WAL)

  packages/shared ── types · Zod schemas · socket contract · voice presets
```

The browser talks to the *other browser* directly for media. The server is
signalling and storage only.

---

## Packages

### `packages/shared`

The single source of truth for anything both sides must agree on: DTOs, Zod
schemas, the typed socket event map, and the voice presets. The server validates
with the same schema the client validates with, so a form and its endpoint cannot
disagree about what is valid.

### `apps/server`

```
src/
  env.ts              Zod-validated environment; refuses to boot on a bad config
  app.ts              Express wiring: helmet, CORS, rate limits, routers
  db.ts               Prisma client
  lib/                errors · logger · tokens · password · serialize
  middleware/         auth · validate · error · rate-limit
  modules/
    auth/             register, login, rotating refresh sessions
    users/            search, profiles, follow, block
    messaging/        conversations, messages, receipts
    calls/            registry (state machine) · service (persistence) · turn
    social/           DEMO tier
  realtime/
    index.ts          Socket.IO server + handshake authentication
    presence.ts       socket-counted online state
    throttle.ts       per-socket token buckets
    handlers/         messaging · calling
```

Boundaries worth knowing:

- **`registry.ts` owns live call state; `service.ts` owns the database.** The
  registry never writes SQL directly and the service holds no in-memory state.
- **The registry does not import Socket.IO.** It is handed a `CallTransport`
  (`toUser`, `isOnline`) at init, which keeps the state machine testable in
  isolation and prevents the transport leaking into domain logic.
- **`serialize.ts` reads presence from the live registry**, not the `isOnline`
  column, because the column is a cache that can be stale after a crash.

### `apps/web`

```
src/
  app/(auth)/         login, register
  app/(app)/          authenticated shell: feed, explore, reels, messages,
                      calls, notifications, saved, settings, profile
  components/ui/      button, avatar, controls, overlay, feedback, form-controls
  components/layout/  Sidebar (desktop rail) · MobileNav (bottom tabs)
  features/
    realtime/         RealtimeBridge — the only place socket events reach stores
    calling/          CallSession · CallLayer · VoiceChangerPanel · quality
    messaging/        ConversationList · MessageThread
    users/            SearchPanel · FollowList · useUserActions
    social/           PostCard · StoriesRow · ExploreGrid · SuggestedUsers
  store/              auth · messaging · call · ui   (Zustand)
  voice/              the engine (see docs/voice-engine.md)
  lib/                api (fetch + refresh) · socket · utils
```

---

## Cross-cutting decisions

### Sockets live outside React

One socket per tab, created outside the component tree and torn down only on
sign-out. A page navigation must not drop the connection — doing so would end an
active call and lose presence. `RealtimeBridge` is mounted once, high in the
tree, and is the only place socket events are translated into store updates.

`CallLayer` is likewise mounted at the root, so an incoming call reaches the user
mid-scroll through the feed.

### Auth: short access token, rotating refresh cookie

- **Access token** — JWT, 15 minutes, kept in memory and mirrored to
  `localStorage` so a reload does not flash the login screen. Sent as a Bearer
  header, and used for the Socket.IO handshake.
- **Refresh token** — opaque random string, `httpOnly` cookie, 30 days, stored
  only as a SHA-256 hash. Rotated on every use.

An XSS bug can therefore steal at most a 15-minute token, not a month-long
session. Presenting an already-rotated refresh token is treated as theft and
revokes the entire session family — verified by test.

`apiFetch` refreshes once on a 401 and retries, with a single in-flight refresh
shared by concurrent callers, so ten parallel 401s cause one refresh.

### Errors

One `AppError` type carries a machine code, an HTTP status, a user-safe message,
and an `expose` flag. Both transports use it: HTTP renders it as
`{ error: { code, message, details } }`, sockets as a `{ ok: false }` ack. 5xx
messages are never sent to the client.

### Real vs demo, enforced

The demo tier reads from seeded rows and supports real like / save / comment
writes, so no button is dead. It has no upload, ranking or fan-out. `NAV_ITEMS`
carries a `tier` field, demo screens show a **Demo** badge, and notifications are
tagged `Real` or `Demo` individually.

The rule that matters: **Message and Call are never fake.** Everywhere a person
appears — search, profile, post menu, suggestions, follow lists, call history —
those two actions route through `useUserActions`, which is the same code path in
every case.

---

## Scaling limits

Presence (`realtime/presence.ts`) and the call registry
(`modules/calls/registry.ts`) are **process-local maps**. With two instances,
users on different workers see each other as permanently offline and can never
connect a call.

`ecosystem.config.cjs` therefore pins the API to a single `fork` process, with the
reason written in the file. Going wider means:

1. Move presence to Redis (a per-user socket-count set).
2. Move the call registry to Redis, including its timers.
3. Add the Socket.IO Redis adapter so `io.to(room)` crosses instances.
4. Swap `express-rate-limit`'s memory store for `rate-limit-redis`.

The Next.js app holds no such state and clusters freely today.
