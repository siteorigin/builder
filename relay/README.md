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

The relay answers on two kinds of host, and each serves only its own routes.

On the relay's own host, where the guest's viewer lives:

| Route | What it does |
| --- | --- |
| `GET /ws/host` (WebSocket) | Opens a new room. The first frame is `room:create` with the host's public key; the relay answers `room:ready` with the room ID. Limited per client IP. |
| `GET /s/:roomId/ws` (WebSocket) | A host taking its room back (`host:reconnect`, then signing the relay's single-use nonce), or a guest asking to join (`guest:join`). |
| `GET /s/:roomId` | The invite link: the guest's viewer (see below). The same page for every well-formed room ID, open or not. |
| `GET /_viewer/*` | The viewer's script and styles, from the Worker's static assets (`relay/viewer/`). |

On each room's own preview origin, `p-<label>.<relay host>` (`roomPreviewOrigin` in `src/shared/live/relay-url.ts`), where
the host's site sits at the root:

| Route | What it does |
| --- | --- |
| `POST /__siteorigin/admission` | An admitted guest's viewer redeems its single-use preview ticket (`{"ticket": "…"}`) for the preview cookie. CORS, credentialed, for the viewer's origin only. |
| `GET /__siteorigin/live.js` | The reload bridge the relay adds to the preview's HTML pages in the viewer's frame. |
| `GET`/`HEAD /*` | The host's preview, for admitted guests holding the cookie, tunnelled over the host's socket and streamed back. |

### The guest's viewer

Opening an invite link needs no account and no install: the Worker serves a small static page (`relay/viewer/`,
plain JavaScript and CSS, no build) that asks for a name, sends `guest:join` on the room's socket and shows each
state the relay reports: waiting, the host reconnecting (`host:availability`), locked, declined, removed, expired and
ended. Its Content Security Policy allows exactly its room's socket and preview origin. Once the host admits the
guest, the page redeems the preview ticket on the preview origin and only then makes the preview frame; when the
guest's access ends for any reason the frame is removed at once. The page keeps no cookies; the guest's place (its
name and resume token) is in the tab's `sessionStorage`, so a reload or a dropped connection takes it back.

The viewer follows the host's page and width from the host's presence (`previewPath`, `viewportWidth`), or lets the
guest browse on their own at Desktop, Tablet or Mobile width. The relay keeps the host's latest page, without its
selection, on the host's socket and sends it to each guest it lets in or back. On `preview:reload` the viewer asks the
reload bridge in its frame to reload the page the guest is on and put its scroll back: the viewer cannot read or
reload a frame on another origin itself. The relay adds the bridge (a same-origin `<script src>`) only to whole,
successful HTML pages requested as the viewer's frame (`Sec-Fetch-Dest: iframe`), and drops their validators and
length, which describe the host's bytes. A collaborator is shown the invite link to open in SiteOrigin Builder.

### Why every room has its own preview origin

The preview runs the host's site code. If every room's preview shared one origin, a page in one room could read
another room's preview (for a guest admitted to both) and script the viewer's own pages. A path-scoped cookie does
not stop that: the same-origin policy is the only browser boundary. So each room's preview is its own origin, and
the viewer is another, all on one registrable domain used for nothing else:

- The label is `p-` and 32 letters of a SHA-256 digest of the room ID, never the room ID itself. A host name is not
  private (DNS, TLS SNI, and the `Origin` header on every font and CDN request the site makes), and the room ID is the
  invite. Each room's Durable Object is named by its label, so a preview request finds its room by host alone.
- The viewer and the previews are the same site, so the `SameSite=Lax` cookie goes with the viewer's iframe in every
  browser, Safari included, with no third-party cookies involved.
- That registrable domain must not be the company's main site: a preview may set cookies for the parent domain, and
  only relay cookies may live there. It is not on the Public Suffix List, and must not be: that would make the
  viewer and its previews cross-site.
- The site is served at its origin's root, so Vite's and SvelteKit's root-absolute URLs (`/@vite/client`, `/_app/…`)
  and the host's redirects work as they are.

An opaque-origin sandbox was the alternative and was rejected: module scripts from an opaque origin need CORS, Lax
cookies are not sent on its subresources, and storage and `history.pushState` throw, so a SvelteKit site cannot run.

## Access

- **Host.** The room is bound to the Ed25519 public key it was created with. Only the socket that created the room, or
  one that has since signed a fresh challenge with the matching private key, may admit, decline, kick, change roles or
  access, lock, or end. A newly proven host connection replaces the old one.
- **Guests** wait as `pending` until the host admits them as a `viewer` or `collaborator`. Pending guests see nothing of
  the room and cannot call anything. A guest keeps its place for a short grace after its socket drops and takes it back
  with its resume token.
- **Preview cookie.** On admission, and whenever the guest's role or end of access changes, the guest is sent a
  single-use ticket valid for a minute. The viewer redeems it on the room's preview origin, which sets
  `__Host-so_preview` (plain `so_preview` over local HTTP), an HMAC-SHA256-signed (`SESSION_SIGNING_KEY`) cookie
  naming the room, the guest, its role, when its access ends and its grant version: host-only, `Path=/`, `HttpOnly`,
  `SameSite=Lax`, `Secure` over HTTPS, and expiring with the guest's access. Over HTTPS only the `__Host-` name is read,
  so copies another host set for the parent domain are ignored. Each preview request is checked against the guest's
  grant as it is now: a missing, tampered, expired or other room's cookie gets `401`; a guest that was removed, or
  whose grant has changed since, gets `403`.
- **Fetch Metadata.** A browser request for the preview that is not from its own pages (`Sec-Fetch-Site` other than
  `same-origin`) is refused unless it is a navigation, so another room's preview cannot load this one's files as
  scripts, images or fetches. Service worker registrations are refused: one would keep answering after access ends.
- **Time.** The alarm ends the session at its `expiresAt` (never more than 24 hours after it started), removes guests
  whose own access ends, gives up the places of guests that did not come back, and closes the room when the host has
  been away for longer than its reconnect grace.
- **Limits.** At most 8 guests, waiting or admitted; frames up to the protocol's size limit; at most 16 preview requests
  in flight per guest; a bounded amount of unread preview body per response and per room; room creation limited per IP.

## Running it locally

```sh
cp relay/.dev.vars.example relay/.dev.vars   # a local SESSION_SIGNING_KEY
npm run relay:dev                            # listens on 127.0.0.1:8787
```

Point the app at it with `SITEORIGIN_LIVE_RELAY_URL=http://relay.localhost:8787`. Not `127.0.0.1`, which has no
subdomains, and not bare `localhost`: previews are served on `http://p-<label>.relay.localhost:8787`, and only under a
host with a dot are the viewer and its previews the same site, which the preview cookie needs. Chrome, Firefox and
Electron resolve `*.localhost` to loopback themselves; Safari on macOS does not, so test Safari against a deployed
relay.

## Tests

`tests/unit/relay-*.test.ts` run the relay in Cloudflare's local simulator (workerd, through wrangler) as part of
`npm test`. They need no Cloudflare account and no network. `relay/tsconfig.json` type-checks the Worker with the
Workers types, as part of `npm run typecheck`.

## Configuration

`wrangler.toml` holds the bindings and the tunables (reconnect graces, handshake and preview timeouts). The only
secret is `SESSION_SIGNING_KEY`, at least 32 characters; without it the relay refuses to open rooms or serve previews.
For a deployment, set it with `wrangler secret put SESSION_SIGNING_KEY --config relay/wrangler.toml`.

A deployment also needs:

- **A registrable domain of its own**, used for nothing but the relay (see above), with the viewer at its apex or one
  subdomain and previews one level under that. Keep the previews at one level below a zone apex
  (`p-….example.live`) and Cloudflare's free Universal SSL covers them; a deeper wildcard needs Advanced Certificate
  Manager.
- **`RELAY_ORIGIN`** set to the viewer's origin (for example `https://example.live`). The viewer's routes are then
  served only there, and preview origins only directly under it. Unset, as locally, any host serves them.
- **Routes for both**, `example.live/*` and `*.example.live/*`, with proxied DNS records for the apex and the
  wildcard. Keep `routes` out of the default (local) configuration: with routes set, `wrangler dev` rewrites the
  request's host to the route's, and previews are found by host.
