# Testing

```bash
npm test              # everything: 121 tests
npm run test:server   # 97 — auth, messaging, realtime, calling, acceptance
npm run test:voice    # 24 — the DSP engine, verified numerically

npm run dev           # then, in another shell:
npm run smoke         # 39 checks against the running stack, over the network
npm run load-check    # concurrent writes, to test the SQLite choice
```

Current state: **121 passing, plus 39 live checks.**

Nothing needs configuring first. Every one of these commands runs
[`scripts/preflight.mjs`](../scripts/preflight.mjs) beforehand, which generates
`.env`, compiles `packages/shared`, builds the worklet, and — for `npm run dev`
and `npm start` — creates and seeds the database. The test suites pass
`--skip-db` because they build their own.

---

## Server suites

Run against a **real** HTTP server, a real Socket.IO server and a real database.
Authorisation rules, unique constraints and transaction behaviour are exactly the
things worth testing, and a mocked Prisma client would assert nothing about them.

Because the app is SQLite, "a real database" costs a file. `tests/global-setup.ts`
deletes `prisma/test.db` (and its `-wal`/`-shm` sidecars), runs
`prisma migrate deploy` against a fresh one, and removes it afterwards. So the
suites exercise **the same migrations production applies**, not a schema Prisma
inferred from the models — and there is no separate engine to install or keep in
sync with the dev one.

`TEST_DATABASE_URL` overrides the path if you want to keep the file and inspect it:

```bash
TEST_DATABASE_URL="file:./inspect-me.db" npm run test:server
```

### A note on regenerating the Prisma client

`global-setup.ts` and [preflight](../scripts/preflight.mjs) both generate the
client only when it is **stale** — the generated copy's mtime older than
`schema.prisma`. That is not just a speed optimisation. On Windows a running dev
server holds `query_engine-windows.dll.node` open and `prisma generate` replaces
it by rename, so generating unconditionally made `npm test` die with `EPERM`
whenever `npm run dev` was up in another terminal.

The comparison is on mtime rather than content deliberately: Prisma re-formats the
schema when it copies it into the client, so the two files are never
byte-identical and a content check would regenerate every single run.

### `auth.test.ts` — 21

Registration, duplicate email/username, every validation rule, reserved
usernames, login by email or username. Notably:

- Login gives an **identical** response for a missing account and a wrong
  password, so it cannot be used to enumerate usernames.
- A forged token, and a token signed with the wrong secret, are both rejected.
- Refresh rotation works, and **replaying a rotated token revokes the whole
  session family** — including the honest client's freshly issued token.
- The password hash never appears in any response body.

### `messaging.test.ts` — 23

Search by username and display name, case-insensitivity, self-exclusion, no email
leakage. Conversation idempotency from both sides. Blocking in both directions,
including removal from search. Then the parts that matter most:

- Messages are read back **straight from the database**, bypassing every service
  layer, to prove persistence is real.
- A retried `clientId` produces exactly one row.
- A non-member sending into a conversation gets 404 — never 403, which would
  confirm the conversation exists.
- Pagination returns newest-page-first, oldest-first within the page.
- Unread counts, delivered-without-read, sender-only deletion, and search scoped
  to your own conversations.

### `realtime.test.ts` — 20

Real socket clients. Handshake rejection without a token. Presence broadcast to
conversation partners and **not** to unrelated users. A second tab closing does
not mark you offline. Instant delivery; delivered-on-reconnect; read receipts;
mirroring to the sender's other tabs. Room-join authorisation. Typing relayed to
the peer only, stopped by sending, and **expiring on its own** after 4 seconds.

### `calling.test.ts` — 32

The state machine and the signalling relay:

- Ringing, accepting, declining, cancelling, and the 45 s timeout.
- Offline and busy callees still produce honest history rows.
- Only the callee can accept; a third party can neither accept, reject, end, nor
  inject SDP into a call they are not on.
- **An offer before acceptance is refused** with `INVALID_STATE`.
- SDP arrives byte-for-byte — the server does not rewrite it — and an
  eavesdropping third socket hears nothing.
- `ACCEPTED` is not `CONNECTED`: only a client's `call:connected` promotes it.
- A dropped socket ends the call as `FAILED`; the line is released afterwards.
- History records duration and preset per participant, and is invisible to
  anyone who was not on the call.
- coturn REST credentials are per-user, expiring, and match an independently
  recomputed HMAC.

### `acceptance.test.ts` — 1

The product spec's scenario, start to finish, as one test: two users sign up and
connect → A searches for B → opens their profile → Message → "Hello!" → B
receives it instantly → read receipt → A calls → B's device rings → B accepts →
offer/answer/ICE relayed → both report connected → A enables the voice changer
and B is told → A hangs up → both histories show the call with duration and
preset → the line is free.

---

## Voice suite — 24

`apps/web/src/voice/dsp-core.test.ts` imports the **same file the AudioWorklet
runs**, so the tested code and the shipped code cannot diverge.

These verify the mathematics, not merely that the code executes:

| Property | How |
| --- | --- |
| FFT correctness | Round-trip, single-bin tone, and bin-for-bin comparison with a naive DFT |
| Overlap-add | Hann normalisation is exactly 1.5 at 75 % overlap |
| Envelope | >3× smoother than the raw spectrum, still peaking near F1; never zero, even on silence |
| **Pitch accuracy** | Within **4 %** of target at +5, +7, +12 st, measured by autocorrelation on the output |
| **Formants move, pitch does not** | Centroid rises >5 % with `F0` unchanged |
| **Pitch moves, formants do not** | An octave up moves the centroid far less than 2× — the anti-chipmunk property |
| Full preset | A 115 Hz synthetic male vowel lands at 150–185 Hz with a raised centroid |
| Robustness | Loudness within 0.5–2×; no NaN/Infinity/clipping; silence in → silence out; no steady-state underruns; parameters clamped; smoothing glides rather than steps |

The test input is a synthetic vowel — a harmonic series shaped by three formant
resonances — because that is the source-filter model the engine decomposes. A
plain sine wave would not exercise the envelope path at all.

---

## Live smoke test — 39

```bash
npm run dev                        # or npm start
npm run smoke                      # in another shell
WEB_PORT=3100 npm run smoke        # if the web app is not on 3000
SMOKE_API_URL=https://api.example.com npm run smoke
npm run smoke -- --api-only        # skip the web-app checks
```

The suites above build their server in-process, which is right for testing
authorisation and state machines but never exercises what you actually deploy.
[`scripts/smoke.mjs`](../scripts/smoke.mjs) walks the acceptance scenario over
the network against a running stack: the compiled `dist/`, the real `.env`, a real
HTTP listener, real Socket.IO transport, and the web app serving the worklet.

It covers, in order:

| Group | Checks |
| --- | --- |
| Health | `/health`, `/health/ready` reporting the database, TURN status reported honestly |
| Web app | a page renders; the worklet is served, registers its processor, contains no ESM syntax, and is `no-cache` |
| Auth | registration, no password hash in the response, login, wrong password rejected, protected route requires a token |
| Transport | a bad token is refused at the handshake; two authenticated sockets |
| Messaging | search by display name, live presence, no email leakage, conversation idempotency, real-time delivery, delivered status, duplicate `clientId` rejected, persistence read back, read receipt, typing relay |
| Calling | ringing, accept, SDP relayed byte-for-byte, answer, ICE relay, `CONNECTED` only on a reported peer connection, voice-changer disclosure, ICE config, measured duration, per-participant history, line released |

Two of these are worth calling out because they guard against the failure modes
this product must not have:

- **The worklet is fetched and inspected, not assumed.** A 200 that is not the
  bundle would mean `addModule()` rejects at call time and the voice changer is
  silently unavailable.
- **`voiceChangerUsed` is asserted per participant** — true for the caller who
  enabled it, false for the peer — so history cannot drift into claiming someone
  used a voice changer they never turned on.

It creates two throwaway accounts and deletes them afterwards, so it is safe to
run repeatedly against a dev database.

What it still cannot cover is the media path itself; that needs a browser.

---

## Concurrent-write check

```bash
npm run load-check
```

SQLite serialises writers, so the fair question about the database choice is not
throughput but whether that serialisation shows up as *errors*.
[`scripts/load-check.mjs`](../scripts/load-check.mjs) fires 192 message sends at
once across 16 sockets, through the real path — socket → Zod → Prisma → SQLite →
broadcast — then reads every row back and counts `SQLITE_BUSY`.

Measured here (one laptop, loopback, dev build):

```
sent          : 192 across 16 sockets
acknowledged  : 192
failed        : 0
SQLITE_BUSY   : 0
persisted     : 192
elapsed       : 1351 ms  (142 writes/sec)
```

That is the WAL + `busy_timeout` configuration doing its job: contending writers
wait a few milliseconds instead of failing.

An earlier run with 8 sockets showed 40 failures — all
`You are doing that too quickly`, the **app's own** per-socket token bucket
(`TokenBucket(20, 5)` in `realtime/throttle.ts`), not the database. The socket
count is now chosen to stay inside that burst so a failure means what it says.

It is not a benchmark: no think time, no network, no other load. Treat the
writes/sec figure as a floor.

---

## Manual WebRTC verification

Node has no WebRTC stack, so the transport itself (ICE, DTLS-SRTP, Opus) can only
be verified in browsers. The signalling around it is covered above.

1. `npm run dev`, open two browsers at `localhost:3000`, sign in as two accounts.
   (Run `npm run smoke` first — if that fails, the problem is not WebRTC.)
2. **Use headphones**, or two machines.
3. Call, accept, confirm the header reads **Connected** and the timer runs.
4. Open `chrome://webrtc-internals` (Chrome) or `about:webrtc` (Firefox) and
   confirm: `connectionState: connected`, an active candidate pair, and non-zero
   `packetsSent` / `packetsReceived`.

| Check | Expected |
| --- | --- |
| Voice changer off → on | Voice changes within ~100 ms, no click or time-skip |
| Preset switch mid-call | Character changes immediately |
| Intensity 0 → 1 | Smooth glide from your own voice to the full preset |
| Mute | Peer hears silence; browser recording indicator reflects it |
| Decline | Caller sees "declined", both get a history row |
| No answer | Auto-ends after 45 s as `TIMEOUT` |
| Network drop (disable Wi-Fi ~5 s) | *Reconnecting…*, then recovery via ICE restart |
| Close the tab mid-call | Peer sees the call end, not a silent freeze |
| Deny microphone | Clear message; no call is placed |
| Call an offline user | "*Name* is offline right now" |
| Call yourself from two tabs | Refused |
| Verify latency | `getMetrics().latencyMs` ≈ 42.7 ms at 48 kHz, shown in the voice panel |

To confirm the far end really hears the transformed voice rather than a local
effect, have the receiving browser record or monitor its inbound audio.

---

## Known limitations

- **No browser-automation suite.** Driving two real WebRTC peers needs Playwright
  with fake media devices (`--use-fake-device-for-media-capture`); it is not set
  up here, so the browser half of calling is manually verified.
- **No load testing.** The single-instance limits in
  [deployment.md](deployment.md) are architectural facts, not measured ceilings.
- **Demo social endpoints have no dedicated tests.** They are seeded reads plus
  simple writes; the real tiers are where the tests are.
- **Seeded reels have no video files.** The Reels screen renders the poster and
  says so rather than pretending to play.
- **The DSP is verified against synthetic vowels**, which is the right signal for
  testing a source-filter decomposition but is not a substitute for listening to
  real speech.
