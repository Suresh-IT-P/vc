# Deployment

## HTTPS is a functional requirement

`getUserMedia()` only works in a secure context. Over plain HTTP — anything other
than `http://localhost`, which browsers exempt — the microphone request is
rejected outright and **no call can be placed**. TLS here is not hardening; the
product does not work without it.

---

## Environment

`.env` is generated on the first `npm run` with a random `JWT_SECRET` and a local
SQLite path. For production set at minimum:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | A `file:` path on persistent storage, e.g. `file:/var/lib/sonder/sonder.db`. **Not** the default `file:./dev.db`, which lives inside the checkout. |
| `JWT_SECRET` | ≥32 chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CORS_ORIGINS` | Comma-separated. Exact origins — no wildcard. |
| `COOKIE_SECURE` | `true` in production |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SOCKET_URL` | Baked in at build time |
| `TURN_SERVER`, `TURN_SECRET`, `TURN_REALM` | See below |

`env.ts` validates everything with Zod at boot and **refuses to start** on a bad
config, listing exactly which variables are wrong. In production it also warns if
`COOKIE_SECURE` is false or TURN is unconfigured.

`scripts/ensure-env.mjs` never overwrites a value that is present and valid, so a
production `.env` is safe from it. It does replace a `JWT_SECRET` that is missing,
under 32 characters, or one of the placeholders that appear in this repository —
a secret published in source control is worse than no secret at all.

The CORS loopback exemption does **not** relax in production — it is
development-only (`isAllowedOrigin` in `apps/server/src/env.ts`).

`DATABASE_URL` must be a `file:` URL; anything else is rejected at boot with that
reason, so a leftover `mysql://…` fails in one clear line rather than deep inside
a Prisma engine error. A relative path is resolved by Prisma against
`apps/server/prisma/`, so **use an absolute path in production** — and make sure
the process user can write both the file and its directory, since WAL mode creates
`-wal` and `-shm` files alongside it.

Migrations are applied automatically: preflight (and the server container's
entrypoint) runs `prisma migrate deploy`, which only ever applies migrations
already committed to the repo. It never resets or drops anything.

`NEXT_PUBLIC_*` values are inlined at build time. Changing the API URL means
rebuilding the web image, not restarting it. `next.config.mjs` reads the
repo-root `.env` explicitly, because Next only auto-loads `.env` from its own
directory — without that, `NEXT_PUBLIC_API_URL` set at the root would be ignored
and the app would fall back to `localhost`, which looks correct in development
and breaks on deploy.

---

## Docker

There is no database service — SQLite means the database is a file on the
`sonder-data` volume, so `npm run dev` needs none of this.

```bash
# coturn only
docker compose -f docker/docker-compose.yml --profile turn up -d

# Everything behind Nginx
docker compose -f docker/docker-compose.yml --profile full up -d --build
```

Put certificates in `certs/fullchain.pem` and `certs/privkey.pem`; the Nginx
container mounts that directory read-only.

`Dockerfile.web` sets `BUILD_STANDALONE=true`, which is what makes `next build`
emit `.next/standalone` for the runtime stage to copy. It is opt-in because Next
refuses to serve a standalone build through `next start`, so leaving it on
unconditionally made a plain local `npm run build && npm start` print a warning
claiming the app was broken when it was not.

For a real certificate:

```bash
certbot certonly --webroot -w ./certbot -d sonder.example.com
cp /etc/letsencrypt/live/sonder.example.com/{fullchain,privkey}.pem certs/
```

For local HTTPS testing, [`mkcert`](https://github.com/FiloSottile/mkcert) is the
least painful option.

---

## Nginx

[`docker/nginx/sonder.conf`](../docker/nginx/sonder.conf) terminates TLS and puts
the web app and API on **one origin**, which also removes the cross-site cookie
problem — the refresh cookie can stay `SameSite=Lax`.

Three details there are load-bearing:

- **`/socket.io/` gets a 3600 s read timeout.** A quiet WebSocket on a silent
  call must not be reaped mid-conversation.
- **`X-Forwarded-For` is set by the proxy**, and the server sets
  `trust proxy` in production. Without both, every client looks like `127.0.0.1`
  and rate limiting becomes global.
- **`/worklets/` is `no-cache, must-revalidate`.** The AudioWorklet bundle is not
  content-hashed, so a stale DSP build would otherwise keep running after a
  deploy. `/_next/static/` is hashed and cached immutably.

---

## coturn

Without TURN, calls fail for peers behind symmetric NAT — a large share of mobile
networks.

The compose service uses **REST-API credentials** (`--use-auth-secret`): the
server mints short-lived HMAC usernames per user rather than handing out a static
password. `TURN_SECRET` must match on both sides.

Two things people get wrong:

1. **`--external-ip` must be the address peers can actually reach.** On a cloud
   host behind NAT, set `EXTERNAL_IP` to the public address or relaying silently
   fails.
2. **Open the ports.** 3478 TCP+UDP, 5349 TCP (TLS), and the UDP relay range
   (49160–49200 as configured). The service uses host networking because
   publishing thousands of UDP ports through the Docker proxy is slow and
   unreliable.

The config denies relaying to loopback, multicast and RFC1918 ranges. An open
relay is found and abused quickly.

Verify with the [Trickle ICE tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
paste your TURN URL and a credential pair, and confirm a `relay` candidate
appears. If only `host` and `srflx` appear, TURN is not working.

---

## Without Docker

```bash
npm ci
# set DATABASE_URL, JWT_SECRET, CORS_ORIGINS, COOKIE_SECURE, TURN_* in .env first
npm run build
npm run db:migrate:deploy
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

`npm run build` runs preflight with `--no-seed`, so it will compile the shared
package and the worklet and check the database is reachable, but never insert
demo content into a production database.

**The API runs as a single `fork` process, and that is deliberate.** Presence and
the call registry are in-process maps, so a second instance would have its own
copy: users on different workers would see each other as permanently offline and
could never connect a call. The reasoning is written into
`ecosystem.config.cjs` so nobody "optimises" it later by switching to cluster
mode.

The Next.js app has no such state and runs clustered.

### Scaling past one API instance

In order:

1. Presence → Redis (per-user socket-count set).
2. Call registry → Redis, including its ring/reconnect timers.
3. Socket.IO Redis adapter, so `io.to(room)` crosses instances.
4. `rate-limit-redis` instead of the in-memory store.
5. **The database off SQLite**, since a file cannot be shared between hosts.
   Switch `provider` in the schema, regenerate the migration for that dialect,
   and re-add native types. Application code is unaffected — it avoids Prisma
   enum types and provider-specific query options for exactly this reason.
   See [database.md](database.md#when-to-move-off-it).

Until all five are done, keep one instance and scale vertically. Note the order:
items 1–4 bite long before the database does.

---

## Health checks

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Process is up. |
| `GET /health/ready` | Readiness. Runs `SELECT 1`; reports database and TURN status. 503 when the database is unreachable. |

Point your load balancer at `/health/ready`, not `/health` — a process that is up
but cannot open its database should not receive traffic.

---

## Production checklist

- [ ] `DATABASE_URL` is an **absolute** `file:` path on persistent storage, not `file:./dev.db`
- [ ] `JWT_SECRET` is random and ≥32 chars, and not the example value
- [ ] `COOKIE_SECURE=true`, real TLS certificate installed
- [ ] `CORS_ORIGINS` lists exact origins, no wildcards
- [ ] The database file and its directory are writable by the service user, and not inside the deployed checkout
- [ ] `TURN_SERVER` + `TURN_SECRET` set and verified with Trickle ICE
- [ ] `EXTERNAL_IP` on coturn is the public address
- [ ] Firewall opens 80/443 plus the TURN ports
- [ ] `prisma migrate deploy` runs before traffic is served
- [ ] Backups scheduled with `sqlite3 .backup` (or Litestream) and a restore tested
- [ ] Logs shipped somewhere (production output is single-line JSON)
- [ ] `/health/ready` wired to the load balancer
- [ ] `SMOKE_API_URL=https://… npm run smoke -- --api-only` passes against it
