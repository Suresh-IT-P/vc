# Calling and WebRTC

Media flows browser-to-browser. The server relays signalling between two
authorised participants and never sees, parses, stores or forwards audio.

```
   Caller browser                                    Callee browser
        │                                                  │
        │ ── call:start ──►  Socket.IO server ── call:incoming ──►
        │ ◄── call:ringing ──      │        ◄── call:accept ──
        │                          │
        │ ══════════ SDP + ICE relayed by the server ══════════
        │                                                  │
        └══════════════ DTLS-SRTP media, peer-to-peer ══════┘
                    (or via a TURN relay, still encrypted)
```

---

## Signalling events

Defined once in
[`socket-events.ts`](../packages/shared/src/socket-events.ts) and shared by both
sides, so the contract cannot drift.

### Client → server

| Event | Purpose |
| --- | --- |
| `call:start` | Place a call. Ack returns the `ActiveCall`. |
| `call:accept` | Callee answers. |
| `call:reject` | Callee declines (`REJECTED` or `BUSY`). |
| `call:end` | Either side hangs up. |
| `call:connected` | **This client's `RTCPeerConnection` reached `connected`.** |
| `call:reconnecting` | This client is attempting an ICE restart. |
| `call:voice-state` | Voice changer toggled — relayed for transparency. |
| `webrtc:offer` / `webrtc:answer` | Opaque SDP, relayed to the peer. |
| `webrtc:ice-candidate` | Opaque candidate, relayed to the peer. |

### Server → client

| Event | Meaning |
| --- | --- |
| `call:incoming` | Your device should ring. |
| `call:ringing` | The other device is alerting. |
| `call:accepted` | Answered — begin media negotiation. |
| `call:rejected` | Declined, with reason. |
| `call:connected` | Both ends have a live transport. |
| `call:reconnecting` | The peer lost its media path. |
| `call:ended` | Terminal, with reason and duration. |
| `call:failed` | Setup failed, with a user-facing message. |
| `call:peer-voice` | The peer turned their voice changer on or off. |
| `webrtc:offer` / `answer` / `ice-candidate` | Relayed from the peer. |

---

## The server-side state machine

[`registry.ts`](../apps/server/src/modules/calls/registry.ts) is authoritative.

```
                 accept                connected
   RINGING ─────────────► ACCEPTED ───────────────► CONNECTED
      │                      │                          │
      │ reject               │ end / fail               │ end / fail / disconnect
      │ timeout (45 s)       │                          │ ICE restart ─┐
      │ caller cancels       │                          │◄─────────────┘
      ▼                      ▼                          ▼
                          E N D E D
```

End reasons persisted on the `Call` row: `COMPLETED`, `REJECTED`, `CANCELLED`,
`BUSY`, `TIMEOUT`, `FAILED`, `UNAVAILABLE`.

Rules the server enforces — none of them are trusted to the client:

- **Only the callee** may accept or reject.
- **Only a participant** may end, signal, or report connection state.
- **One call per user at a time.** A second inbound call gets `USER_BUSY`.
- **An offer before acceptance is rejected** with `INVALID_STATE`. Otherwise a
  caller could push media at someone who never agreed to talk to them.
- **A caller hanging up while ringing is `CANCELLED`, not `COMPLETED`** — even
  when the client asks for `COMPLETED`. The history wording depends on it.
- **Calling an offline or busy user still writes a `Call` row** (`UNAVAILABLE` /
  `BUSY`), so both people get an honest history entry.
- **Orphaned calls are reaped at boot.** A process restart cannot leave a row
  marked live that no client can ever end.

### "Connected" means connected

`CONNECTED` is reached only when a client emits `call:connected`, and clients
emit it only from `RTCPeerConnection.onconnectionstatechange` with state
`connected`. There is no timer anywhere in the call path. When the UI says
Connected, a real transport exists and media is flowing.

---

## Client negotiation

[`CallSession.ts`](../apps/web/src/features/calling/CallSession.ts) implements
the W3C **perfect negotiation** pattern.

- The **callee is polite**: on an offer collision it rolls back and yields.
- The **caller is impolite**: it ignores a colliding offer and keeps its own.
- The callee suppresses its own first `negotiationneeded`, because the caller
  always makes the opening offer — otherwise every call would start with an
  avoidable collision.

Without this, two simultaneous ICE restarts leave both peers stuck in
`have-local-offer` forever.

ICE candidates that arrive before their description are queued and flushed once
`setRemoteDescription` succeeds. Signalling that arrives before the peer
connection exists at all (the callee can receive the offer in the same tick it
accepts) is queued in the call store and replayed after `connect()`.

### Ordering, and why the microphone comes first

```
User taps Call
   └─► getUserMedia + build AudioPipeline   ← permission resolved HERE
         └─► call:start
               └─► callee rings
                     └─► callee accepts (their own getUserMedia first)
                           └─► call:accepted
                                 └─► caller: new RTCPeerConnection, addTrack
                                       └─► negotiationneeded → offer
```

Microphone permission is resolved **before** anyone's phone rings. Failing at
that point is a dialog the caller can act on; failing after the callee has picked
up is a dropped call.

---

## Reconnection

| Situation | Behaviour |
| --- | --- |
| `iceConnectionState: 'failed'` | Immediate ICE restart (impolite peer initiates). |
| `connectionState: 'disconnected'` | 3-second grace — often a transient Wi-Fi handover — then restart. |
| ICE restart in flight | Both sides show *Reconnecting…*; server starts a 30 s grace timer. |
| Grace expires | Call ends as `FAILED`. |
| Socket disconnects entirely | Call ends immediately. |

That last row is a deliberate design decision. Losing the socket means the page
was closed or reloaded, which destroys the `RTCPeerConnection` — there is nothing
left to reconnect to. Keeping the call "alive" would be pretending.

---

## STUN and TURN

`GET /api/calls/ice-config` (authenticated) returns the ICE server list.

With `TURN_SECRET` set, the server mints **ephemeral coturn REST credentials**:

```
username   = <unix-expiry>:<userId>
credential = base64( HMAC-SHA1( secret, username ) )
```

The shared secret never leaves the server, credentials are per-user and expire,
and the response is `Cache-Control: no-store`. Handing out a long-lived static
TURN password is the usual way people end up paying for someone else's relayed
traffic.

**Without TURN, calls fail for peers behind symmetric NAT** — a large share of
mobile networks. `hasTurn: false` is reported to the client and the call UI shows
a warning during connection rather than letting the call mysteriously fail.
`iceTransportPolicy` is `'all'`, so a direct path is tried first and TURN is only
used when the network forces it.

---

## Quality measurement

Sampled every 2 s from `RTCStatsReport`:

| Metric | Source |
| --- | --- |
| Round-trip time | `candidate-pair.currentRoundTripTime` |
| Jitter | `inbound-rtp.jitter` |
| Packet loss | `inbound-rtp.packetsLost` **as a delta**, not cumulative |

Loss is computed per interval on purpose: a cumulative figure makes a call that
recovered look permanently bad.

Buckets (`gradeQuality`): `excellent` → `good` (>1 % loss, >150 ms RTT, >30 ms
jitter) → `poor` (>3 %, >300 ms, >60 ms) → `critical` (>8 %, >600 ms).

---

## Error handling

| Failure | What the user sees |
| --- | --- |
| Microphone denied | "Microphone access was blocked. Allow it in your browser's address bar…" |
| No microphone | "No microphone was found." |
| Microphone busy | "Your microphone is in use by another app." |
| Callee offline | "*Name* is offline right now." |
| Callee busy | "*Name* is on another call." |
| Blocked | "You cannot interact with this account." (same both directions, so blocking is not detectable) |
| ICE failure | "A direct audio connection could not be established. This usually means a TURN relay is needed." |
| Autoplay blocked | Inline **Enable sound** button. |
| Worklet failure | Falls back to the dry path **and says so** — never silently sends raw voice while claiming otherwise. |
