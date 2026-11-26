# Live session relay

The Cloudflare Worker that SiteOrigin Builder's live sessions go through. A host's Builder opens a room here; guests
join it from an invite link; the relay passes their frames between them and tunnels the host's preview to admitted
guests. It is this one Worker and one Durable Object class, kept in this repository so anyone can read exactly what
the relay does.

It stores no project files, accounts or personal data. Each room lives in its `SessionRoom` object's memory and, so it
survives the object hibernating, as a copy in the attachments of the room's own WebSockets. Durable Object storage
holds only the room's alarm. When the session ends, expires, or its host stays away past the reconnect grace, every
socket is closed and nothing of the room is kept.

The wire protocol, its limits and its Ed25519 helpers are shared with the app in `src/shared/live/`.

## Routes

| Route | What it does |
| --- | --- |
| `GET /ws/host` (WebSocket) | Opens a new room. The first frame is `room:create` with the host's public key; the relay answers `room:ready` with the room ID. Limited per client IP. |
| `GET /s/:roomId/ws` (WebSocket) | A host taking its room back (`host:reconnect`, then signing the relay's single-use nonce), or a guest asking to join (`guest:join`). |
| `POST /s/:roomId/admission` | An admitted guest redeems its single-use preview ticket (`{"ticket": "…"}`) for the room's preview cookie. |
| `GET`/`HEAD /s/:roomId/preview/*` | The host's preview, for admitted guests holding the cookie, tunnelled over the host's socket and streamed back. |
| `GET /s/:roomId` | The invite link. A placeholder until the guest viewer lands. |

## Access

- **Host.** The room is bound to the Ed25519 public key it was created with. Only the socket that created the room, or
  one that has since signed a fresh challenge with the matching private key, may admit, decline, kick, change roles or
  access, lock, or end. A newly proven host connection replaces the old one.
- **Guests** wait as `pending` until the host admits them as a `viewer` or `collaborator`. Pending guests see nothing of
  the room and cannot call anything. A guest keeps its place for a short grace after its socket drops and takes it back
  with its resume token.
- **Preview cookie.** On admission, and whenever the guest's role or end of access changes, the guest is sent a
  single-use ticket valid for a minute. Redeeming it sets `so_preview`, an HMAC-SHA256-signed (`SESSION_SIGNING_KEY`)
  cookie naming the room, the guest, its role, when its access ends and its grant version: `HttpOnly`,
  `SameSite=Lax`, `Secure` over HTTPS, scoped to `/s/:roomId/preview`, and expiring with the guest's access. Each
  preview request is checked against the guest's grant as it is now: a missing, tampered, expired or other room's
  cookie gets `401`; a guest that was removed, or whose grant has changed since, gets `403`.
- **Time.** The alarm ends the session at its `expiresAt` (never more than 24 hours after it started), removes guests
  whose own access ends, gives up the places of guests that did not come back, and closes the room when the host has
  been away for longer than its reconnect grace.
- **Limits.** At most 8 guests, waiting or admitted; frames up to the protocol's size limit; at most 16 preview requests
  in flight per guest; a bounded amount of unread preview body per response and per room; room creation limited per IP.

## Running it locally

```sh
cp relay/.dev.vars.example relay/.dev.vars   # a local SESSION_SIGNING_KEY
npm run relay:dev                            # http://127.0.0.1:8787
```

Point the app at it with `SITEORIGIN_LIVE_RELAY_URL=http://127.0.0.1:8787`.

## Tests

`tests/unit/relay-*.test.ts` run the relay in Cloudflare's local simulator (workerd, through wrangler) as part of
`npm test`. They need no Cloudflare account and no network. `relay/tsconfig.json` type-checks the Worker with the
Workers types, as part of `npm run typecheck`.

## Configuration

`wrangler.toml` holds the bindings and the tunables (reconnect graces, handshake and preview timeouts). The only
secret is `SESSION_SIGNING_KEY`, at least 32 characters; without it the relay refuses to open rooms or serve previews.
For a deployment, set it with `wrangler secret put SESSION_SIGNING_KEY --config relay/wrangler.toml`.
