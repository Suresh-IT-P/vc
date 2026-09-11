# Sonder

A social app whose familiar surface is a shell. The real product underneath is
**one-to-one messaging and peer-to-peer voice calling with live male-to-female
voice conversion** that runs entirely in the browser.

```
REAL AUTH → REAL USERS → REAL CHAT → REAL-TIME SOCKETS
        → REAL WEBRTC CALL → REAL AUDIO PIPELINE
                → REAL-TIME MALE → FEMALE VOICE CONVERSION
```

Sonder is an original product: its own name, mark, palette, icons and layout. It
borrows well-established social-UI conventions the way every app in the category
does, and copies no brand's assets.

---

## What is real, and what is a demo

This distinction is enforced in the code, surfaced in the UI, and worth reading
before anything else.

| Real — fully implemented, database-backed | Demo — seeded content |
| --- | --- |
| Registration, login, rotating refresh sessions | Home feed posts |
| User search (username + display name) | Stories |
| Conversations and message persistence | Reels |
| Real-time delivery, delivered/read receipts | Explore grid |
| Typing indicators, online/offline presence | Followers / following counts |
| Blocking (search, messaging and calls) | Like / comment / follow *content* |
| WebRTC audio calling, full state machine | Notifications (except call/message) |
| STUN/TURN with ephemeral credentials | |
| ICE restart and reconnection | |
| **Real-time DSP voice conversion** | |
| Call history with duration and preset | |

Demo screens are labelled **Demo** in the interface. They are not hard-coded
arrays — they read from seeded database rows, and likes, saves and comments are
genuine writes, so no button is dead. What they lack is the rest of a social
backend: no uploads, no ranking, no fan-out.

Nothing in the demo tier can interfere with messaging or calling. The **Message**
and **Call** buttons — on profiles, search results, post menus, suggestions and
call history — all route through one code path
([`useUserActions.ts`](apps/web/src/features/users/useUserActions.ts)) into the
real features.

---

## The voice conversion, in one paragraph

Naive pitch shifting drags the spectral envelope up with the harmonics, which is
why it sounds like a sped-up tape. A voice is an excitation source (vocal folds →
pitch) filtered by a resonator (vocal tract → formants), and those move
independently between speakers. So each STFT frame is decomposed with cepstral
liftering into a smooth envelope and a whitened residual; the **residual** is
pitch-shifted by a phase vocoder while the **envelope** is warped separately;
then they are recombined. Pitch and formants become independent controls, which
is what makes this a conversion rather than an effect.

Full detail, including why the FFT size is 2048 and not 1024:
**[docs/voice-engine.md](docs/voice-engine.md)**.

The engine is DSP. It is not machine learning, and the UI never claims it is. An
[`AIVoiceConverter`](apps/web/src/voice/AIVoiceConverter.ts) placeholder documents
the upgrade path and **fails loudly** rather than silently falling back, so the
interface can never say "AI" while plain DSP runs.

---

## Quick start

**Requirements:** Node 20.11+. Nothing else — no database server, no config file.

```bash
git clone <your-repo> sonder && cd sonder
npm install
npm run dev
```

That is the whole setup. `npm run dev` — and `build`, `start`, `test`,
`typecheck` — runs [`scripts/preflight.mjs`](scripts/preflight.mjs) first, which
is idempotent and does only what is missing:

1. writes `.env` from `.env.example` with a **generated** 64-char `JWT_SECRET`,
2. compiles `packages/shared` (the server imports it from `dist/`),
3. builds the AudioWorklet bundle the voice changer loads,
4. generates the Prisma client if the schema changed,
5. applies the committed migrations, creating and seeding the database on a first
   run,
6. opens a real connection to prove it, and fails with the exact command to run
   if it cannot.

It adds about two seconds once everything is in place. To run it on its own:
`npm run preflight`.

The database is **SQLite** — in development and in production. That is a fit
rather than a shortcut: the API already runs as a single process because presence
and the call registry are in-process maps, so there is no second writer for a
network database to coordinate. `db.ts` sets WAL and a busy timeout on connect,
which is what makes it behave under concurrent requests. The trade-offs and the
point at which you would outgrow it are in
[docs/database.md](docs/database.md#why-sqlite).

> **Port 3000 busy?** `WEB_PORT=3100 npm run dev`. In development the API
> accepts any localhost origin, so nothing else needs changing.

Open **http://localhost:3000**. Sign up, or sign in as a seeded account:

| Username | Password |
| --- | --- |
| `aria.reed` | `Password123` |
| `milo.kade` | `Password123` |
| `june.diaz` | `Password123` |

…and nine more, listed in [`prisma/seed.ts`](apps/server/prisma/seed.ts).

### Try the whole thing

1. Open two browsers (or one normal + one private window) at `localhost:3000`.
2. Sign in as two different accounts.
3. From A: search for B → open their profile → **Message** → send "Hello!"
   B receives it immediately.
4. From A: **Call**. B sees the incoming-call screen and accepts.
5. Once it says **Connected**, open the wand icon → turn on **Voice changer**,
   pick **Female Natural**, and speak. Move the intensity slider while talking.
6. Hang up. Both users see the call in **Calls**, with duration and the preset.

> Use headphones. Two browsers on one machine with speakers will feed back.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + web with hot reload (runs preflight first) |
| `npm run build` | Build shared, server and web for production |
| `npm start` | Run the production builds on ONE port (proxies /api + /socket.io) |
| `npm run start:split` | Same, but on two ports — for running behind your own Nginx |
| `npm test` | All 121 tests (server integration + DSP) |
| `npm run test:server` | Server: auth, messaging, realtime, calling, acceptance |
| `npm run test:voice` | The DSP engine, numerically verified |
| `npm run smoke` | 39 checks against a **running** stack, over the network |
| `npm run load-check` | 192 concurrent writes against a running stack |
| `npm run preflight` | Bring the checkout to a runnable state; safe to re-run |
| `npm run typecheck` | Typecheck all three packages |
| `npm run db:migrate` | Create/apply a Prisma migration |
| `npm run db:seed` | Seed demo content |
| `npm run db:studio` | Prisma Studio |
| `npm run build:worklet` | Rebuild the AudioWorklet bundle |
| `npm run db:reset` | Drop, re-migrate and re-seed the database (destroys data) |

`WEB_PORT` moves the web app off 3000; `PORT` moves the API off 4000.

---

## Architecture at a glance

```
apps/web  ── Next.js 15 · React 19 · Tailwind · Zustand · TanStack Query
   │
   ├── HTTP  ─────────────►  apps/server ── Express · Zod · Prisma ──► SQLite
   ├── Socket.IO  ────────►  presence · messaging · call signalling
   │
   └── WebRTC ═══════════════════════════════════════════► the other browser
                       (media never touches the server)
```

The server relays SDP and ICE candidates between two authorised participants and
never sees, parses or stores media. Audio flows peer-to-peer, encrypted with
DTLS-SRTP; a TURN relay only forwards those encrypted packets when a direct path
is impossible.

```
apps/
  web/     src/{app,components,features,hooks,lib,store,voice}
  server/  src/{modules,realtime,middleware,lib}  prisma/{schema,migrations,seed}
packages/
  shared/  types · Zod schemas · socket event contract · voice presets
docker/    compose · Dockerfiles · Nginx
scripts/   preflight · env bootstrap · worklet bundler · media
           generator · live smoke test
docs/
```

Detailed docs:

- **[architecture.md](docs/architecture.md)** — layout, boundaries, real-vs-demo
- **[messaging.md](docs/messaging.md)** — delivery, receipts, idempotency, presence
- **[webrtc.md](docs/webrtc.md)** — signalling, state machine, ICE, reconnection
- **[voice-engine.md](docs/voice-engine.md)** — the DSP, in full
- **[database.md](docs/database.md)** — schema, indexes, migrations
- **[deployment.md](docs/deployment.md)** — HTTPS, coturn, scaling limits
- **[testing.md](docs/testing.md)** — what is covered and how to verify by hand

---

## Privacy

- The microphone is opened only when you start or answer a call, and released
  the moment it ends.
- Voice conversion runs on your device. **No audio is uploaded for processing.**
- Calls are not recorded. There is no recording feature.
- When you enable the voice changer, the other person is told. This is
  deliberate and cannot be turned off.

---

## Known limitations

These are stated rather than hidden. See
[docs/testing.md](docs/testing.md#known-limitations) for the full list.

- **Single server instance.** Presence and the call registry are in-process, so
  horizontal scaling needs Redis first. `ecosystem.config.cjs` pins the API to
  one process for this reason. SQLite follows from the same constraint rather than
  causing it — a file cannot be shared between hosts, so moving to more than one
  instance means moving the database too
  ([the ordered list](docs/deployment.md#scaling-past-one-api-instance)).
- **Non-ASCII search is case-sensitive.** SQLite's `LIKE` folds case for ASCII
  only, so `zoe` will not find `Zoë`. Usernames are unaffected.
- **No TURN by default.** Without `TURN_SERVER`, calls fail for peers behind
  symmetric NAT — most mobile networks. The call UI warns when TURN is absent.
- **HTTPS is required** for anything other than `localhost`; browsers block
  `getUserMedia` otherwise.
- **Seeded reels have no video files.** There is no upload or transcoding
  pipeline, so the Reels screen shows the poster and says so, rather than
  pretending to play.
- **No AI voice model.** V1 is DSP. The architecture is ready for a model; the
  model is not included.
- **Safari** supports the pipeline but is more sensitive to AudioContext
  autoplay policy; the call UI surfaces a tap-to-enable prompt when playback is
  blocked.
