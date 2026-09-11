# Messaging, presence and typing

Every message is a row in the database before it is an event on a socket. Socket.IO is
the delivery mechanism, never the store.

---

## Model

One-to-one only. A `Conversation` carries a **`pairKey`** — the two user ids
sorted and joined — with a unique index. Two people can therefore only ever have
one thread, even if both tap "Message" at the same instant: one insert wins, the
loser catches the unique-constraint violation and re-reads the winner's row.

```
Conversation ──< ConversationParticipant >── User
      │
      └──< Message
```

`ConversationParticipant.lastReadAt` is the read watermark; unread counts are
derived from it rather than stored, so they cannot drift out of sync.

---

## Sending a message

```
type → typing:start (throttled to 1 per 1.5 s)
send → optimistic bubble appears with a clock icon
     → message:send  { conversationId, body, clientId }
          server: assert membership
                  assert neither party has blocked the other
                  insert row (deliveredAt set if recipient is online)
                  bump conversation.updatedAt
          → ack: the persisted Message
     → optimistic bubble is replaced, matched on clientId
     → message:new pushed to the recipient and to the sender's other tabs
```

### Idempotency

`clientId` is a client-generated key with a unique index on
`(conversationId, clientId)`. A retry after a socket drop resolves to the
existing row instead of posting twice — verified by both an HTTP-level and a
socket-level test.

This is also what makes the **Retry** affordance on a failed bubble safe: it
re-sends with the *same* `clientId`.

---

## Delivery states

| State | Icon | Meaning |
| --- | --- | --- |
| `sending` | clock | Client-side only; not yet acknowledged |
| `sent` | one tick | Stored in the database; recipient offline |
| `delivered` | two ticks | Handed to the recipient's device |
| `read` | two ticks, tinted | Recipient opened the conversation |
| `failed` | alert | Send failed; retry offered |

`sending` and `failed` exist only in optimistic client state — the server never
produces them.

Delivery is marked in three places, all of which converge on the same result:

1. **At send time**, if the recipient has a live socket.
2. **On `conversation:join`**, when the recipient opens the thread.
3. **On socket connect**, sweeping everything that arrived while they were away —
   this is what turns a single tick into a double tick when someone comes back
   online, and the senders are notified.

Marking a message read implies delivered, because a user can go from offline
straight to reading without the delivered event ever having landed.

---

## Presence

`isOnline` on the `User` row is a **cache**. The authoritative source is an
in-process registry that counts sockets per user, so opening a second tab and
closing it cannot mark someone offline.

Presence is broadcast only to people who share a conversation with the user, plus
their own other tabs. Broadcasting globally would leak the entire user list to
every connected client.

At boot, any `isOnline: true` row is reset — a fresh process cannot own live
sockets, so those are debris from an unclean shutdown.

`presence:subscribe` lets a client ask about specific users (search results,
a profile) without waiting for an event.

---

## Typing indicators

Purely ephemeral: never persisted, and expired **server-side** 4 seconds after
the last keystroke. A client that crashes mid-typing cannot leave a permanent
"Alex is typing…" on someone's screen. The indicator is also cleared when the
message is sent, when the user leaves the conversation, and when their socket
disconnects.

The client throttles `typing:start` to one frame per 1.5 s, and the server has a
per-socket token bucket that *drops* excess typing frames rather than erroring —
a lost typing frame is invisible to users.

---

## Authorisation

Every messaging operation funnels through `assertMembership()`. A non-member gets
**404, not 403**, so a conversation id cannot be confirmed to exist by probing.

Blocking is checked at conversation creation **and again at send time**, because
the block may have happened after the thread existed. The error message is
identical in both directions, so a blocked user cannot detect that they were
specifically blocked.

---

## Rate limiting

WebSocket frames are not covered by HTTP rate limiting, and an authenticated
socket is where abuse is cheapest. Each socket gets its own token buckets,
discarded with the socket:

| Bucket | Capacity | Refill | On exhaustion |
| --- | --- | --- | --- |
| Messages | 20 | 5/s | Error ack |
| Typing | 10 | 4/s | Silently dropped |
| Call setup | 5 | 0.2/s | Error ack |
| Signalling | 120 | 40/s | Candidates dropped, SDP errors |

---

## Reconnection

Socket.IO reconnects with backoff, indefinitely. On reconnect the client
re-fetches the conversation list, and the server sweeps pending deliveries. If
the access token expired while offline, the handshake fails with
`UNAUTHENTICATED`; the client refreshes it and Socket.IO's own retry picks up the
new token.

A visible banner appears in the chat header while the socket is down, because a
composer that silently fails to send is worse than one that warns.

---

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/conversations` | Inbox, newest first |
| `GET` | `/api/conversations/unread-count` | Nav badge |
| `POST` | `/api/conversations` | Open or create (idempotent) |
| `GET` | `/api/conversations/:id` | One conversation |
| `GET` | `/api/conversations/:id/messages` | History, cursor-paginated |
| `GET` | `/api/messages/search` | Search your own messages |
| `DELETE` | `/api/messages/:id` | Soft-delete your own message |

Pagination returns the newest page first, ordered oldest-first *within* the page,
so the client can append without reversing. `nextCursor` walks backwards through
history.
