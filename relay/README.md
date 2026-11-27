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
selection, in its copy of the room and sends it to each guest it lets in or back. On `preview:reload` the viewer asks the
reload bridge in its frame to reload the page the guest is on and put its scroll back: the viewer cannot read or
reload a frame on another origin itself. The relay adds the bridge (a same-origin `<script src>`) only to UTF-8 HTML
pages, error pages included, requested as the viewer's frame (`Sec-Fetch-Dest: iframe`); it asks the host for those
pages whole and drops their validators and length, which describe the host's bytes. A collaborator is shown the invite link to open in SiteOrigin Builder.

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
- **Guests** wait as `pending` until the host admits them as a `viewer`, `copy-editor` or `collaborator`. Pending guests
  see nothing of the room and cannot call anything. A guest keeps its place for a short grace after its socket drops and
  takes it back with its resume token.
- **Preview cookie.** On admission, on resuming its place, and whenever its role or end of access changes, an admitted
  guest is sent a single-use ticket valid for at most a minute. The viewer redeems it on the room's preview origin, which sets
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

`wrangler.toml` holds the bindings and the tunables (reconnect graces, handshake and preview timeouts). Its default
environment is the local one. The only secret is `SESSION_SIGNING_KEY`, at least 32 characters; without it the relay
refuses to open rooms or serve previews. A deployment adds a `production` environment, below.

## Deploying and operating

`example.live` stands for your domain throughout. You need a checkout of this repository, Node (24.15 or newer in the
24 line, as [CONTRIBUTING.md](../CONTRIBUTING.md) recommends) with npm, and OpenSSL. With those ready, dependencies
installed, and the domain already **active** on Cloudflare with its Universal SSL certificate issued, the steps below
take under five minutes. Registering a domain, moving its nameservers and waiting for the first certificate take
longer, so do those beforehand.

### Before you start: the domain

- **Use a registrable domain for the relay and nothing else.** Never `siteorigin.com` or any subdomain of it, or any
  domain that serves another site. A preview runs its host's site code, and that code can set cookies for the parent
  domain. The only cookies that belong there are the relay's. (Do not add the domain to the Public Suffix List: the
  viewer and its previews must stay [the same site](#why-every-room-has-its-own-preview-origin).)
- **Put the viewer at the apex**, `https://example.live`. Each room's preview is then one level below it,
  `https://p-<label>.example.live`. Cloudflare's free Universal SSL covers a zone's apex and one wildcard level
  (`*.example.live`). A viewer on `live.example.live` would put previews two levels down, which needs a paid or custom
  certificate.

In the zone's DNS settings, add two **proxied** records. `100::` is a placeholder address for a name that only a Worker
answers:

| Type | Name | Content | Proxy status |
| --- | --- | --- | --- |
| `AAAA` | `@` | `100::` | Proxied |
| `AAAA` | `*` | `100::` | Proxied |

### 1. Add the production environment

Append this to `relay/wrangler.toml` in the checkout you deploy from, with your domain in place of every
`example.live`:

```toml
[env.production]
workers_dev = false   # no *.workers.dev address: the relay answers on its own domain only
preview_urls = false
routes = [
  { pattern = "example.live/*", zone_name = "example.live" },
  { pattern = "*.example.live/*", zone_name = "example.live" },
]

# Wrangler does not pass bindings or vars down to a named environment, so they are repeated here. The assets, the
# Durable Object migration, the entry point and the compatibility date are inherited from the top of the file.
[[env.production.durable_objects.bindings]]
name = "ROOMS"
class_name = "SessionRoom"

[[env.production.ratelimits]]
name = "ROOM_CREATION_LIMITER"
namespace_id = "7610"
simple = { limit = 6, period = 60 }

[[env.production.ratelimits]]
name = "ROOM_CONNECT_LIMITER"
namespace_id = "7611"
simple = { limit = 30, period = 60 }

# Off on purpose: stored request logs would hold request addresses, and an invite link's address holds its room ID.
[env.production.observability]
enabled = false

[env.production.vars]
RELAY_ORIGIN = "https://example.live"
HOST_RECONNECT_GRACE_MS = "120000"
GUEST_RECONNECT_GRACE_MS = "120000"
HANDSHAKE_TIMEOUT_MS = "30000"
PREVIEW_HEAD_TIMEOUT_MS = "30000"
PREVIEW_IDLE_TIMEOUT_MS = "30000"
```

- **`RELAY_ORIGIN`** is the viewer's origin: scheme and host, no path. The viewer's routes are then served only there,
  and preview origins only directly under it. Unset, as locally, any host serves them. Set to something that is not an
  origin, the relay answers everything with `503`.
- **Both routes are needed**: `*.example.live/*` does not match the apex. They are Workers Routes, which work with the
  two DNS records above.
- **`routes` stays out of the default environment** (the top of the file). With routes set there, `wrangler dev`
  rewrites each request's host to the route's, and the relay finds a preview's room by its host, so local previews
  stop working.

### 2. Deploy the Worker

From the repository root:

```sh
npm ci
npx wrangler login
npx wrangler deploy --config relay/wrangler.toml --env production
```

This provisions everything: one Worker, `siteorigin-live-relay-production`, with the viewer's files as its assets, its
two rate limiters, and one SQLite-backed Durable Object class, `SessionRoom`, created by the `v1` migration. Each live
session gets its own object of that class. There is no database, bucket or queue to create. WebSocket Hibernation needs
no setting: the object accepts its sockets with `ctx.acceptWebSocket()`, so it can sleep between frames and restore the
room from its sockets' attachments when it wakes.

### 3. Set the signing key

```sh
openssl rand -base64 32 | npx wrangler secret put SESSION_SIGNING_KEY --config relay/wrangler.toml --env production
```

This sends 32 random bytes straight to Cloudflare, so the key is never written to a file. Give each relay you set up its
own key, never the one in `.dev.vars.example`. Later deploys keep the secret, so run this again only to rotate it. Pass `--env production`: without it the secret goes to a different
Worker, and the deployed relay still refuses to open rooms.

### 4. Check it

```sh
curl -i https://example.live/_viewer/viewer.js                      # 200: the apex route and the viewer's files
curl -i https://p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.live/    # 401: the wildcard route and certificate
```

Neither needs a live session, and neither checks the key. For that, [point Builder at the
relay](#pointing-the-app-at-a-deployed-relay), start a live session, open its invite link in a browser, admit the guest
and see that the preview appears. This covers both kinds of host, the WebSockets and the preview cookie.

### Rotating the signing key

Run the command in step 3 again. The relay holds one key, so there is no period in which the old and new keys both
work. **Rotate when no sessions are running if you can.**

`wrangler secret put` deploys a new version of the Worker at once, and running rooms then change over as on any other
deployment. By default Cloudflare [defers a Durable Object's code
update](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) for up to five
minutes, on a best-effort basis, so there is no single moment of cutover: each room can go on using the old key for a
while. What happens next differs from room to room:

- **The room hibernates first and then picks up the new version.** Its sockets stay open and the room is restored. The
  signing key signs only preview cookies, so the host's connection, waiting guests, guests' places and resume tokens
  carry on, and an unused, unexpired ticket is redeemed with the new key. An admitted guest's old cookie stops
  verifying, so its next preview request gets `401`. In a browser, **Try again**, where the viewer shows it, takes the
  guest's place back and gets a new cookie. If part of the preview just stops loading and there is no button, reload the
  invite page in the same tab. A guest in Builder leaves the session, joins again and is admitted again.
- **The room is reset before it hibernates.** Its sockets are disconnected, and the room, which lived only in memory and
  on those sockets, is gone for good. The host must stop the session, start a new one and send the new link, and guests
  must be admitted again. Left alone, the host's Builder keeps trying to reconnect for up to 15 minutes, because it
  cannot tell a room that is gone from a network that is down. Guests also retry for a few minutes before saying the
  connection was lost; reconnecting or reloading the old invite cannot bring the room back.

Any `wrangler deploy` can reset rooms in the same way, so deploy between sessions too.

**If the key may have leaked**, rotate it without waiting for sessions to finish. Until a room picks up the new key,
someone holding the old one who also knows an admitted guest's current grant (the room and guest IDs, role, end of
access and grant version) can sign a cookie and fetch the preview as that guest while the host is connected, even if the
guest's own connection has dropped. To ask Cloudflare to apply the new key without the deferral, upload it as a version
and deploy that version in immediate mode, in place of `secret put`:

```sh
openssl rand -base64 32 | npx wrangler versions secret put SESSION_SIGNING_KEY --config relay/wrangler.toml --env production
npx wrangler versions deploy --config relay/wrangler.toml --env production --durable-objects-code-update-mode immediate
```

The second command asks which version to deploy: choose the one just uploaded, at 100%. Do not treat this as proof that
every room has ended or changed over. Where that matters, have the hosts end their sessions; no session lasts more than
24 hours.

### Pointing the app at a deployed relay

Only the **host's** Builder needs configuring. Guests use the relay named in the invite link, in a browser or in
Builder. The app takes the first of these that is set:

1. The `SITEORIGIN_LIVE_RELAY_URL` environment variable. From a source checkout:
   `SITEORIGIN_LIVE_RELAY_URL=https://example.live npm run dev`.
2. `settings.liveRelayUrl` in `settings.json` in the app's user data folder (on macOS,
   `~/Library/Application Support/SiteOrigin Builder/settings.json` by default; `SITEORIGIN_USER_DATA` moves the
   folder). Settings has no field for it yet, so quit Builder, set `"liveRelayUrl": "https://example.live"` inside the
   `settings` object (replacing any value there), and open Builder again. If the file does not exist yet, create it
   containing `{"settings":{"liveRelayUrl":"https://example.live"}}`.
3. The built-in default, `DEFAULT_RELAY_URL` in `src/shared/live/relay-url.ts`.

Give the origin only, with no path. A value that is set but unusable stops a session from starting, with a message
saying where it was set. Builder never falls back to the next one.

### Self-hosting on another domain

Anyone can run their own relay on their own Cloudflare account. Follow the steps above with your own dedicated domain
in the DNS records, both route patterns, their `zone_name` and `RELAY_ORIGIN`, generate your own signing key, and point
the hosting Builder at your origin. No source change is needed. If your account already uses the rate limiter
`namespace_id`s `7610` or `7611`, choose others: limiters with the same ID share their counts.

### Security and privacy

- **No accounts.** A host is the holder of the room's Ed25519 key, made for that session. A guest gives a name and
  waits for the host to let them in.
- **The relay keeps no record of a session.** It writes no project content, guest records or names to Durable Object
  storage, which holds only the room's alarm; ending a session clears it. A room lives in its object's memory and, to
  survive hibernation, in its open sockets' attachments. Other things can outlast a session outside the relay: the host's
  Builder saves guests' notes, with their names, alongside the project; a guest's tab can hold the name and resume token
  in `sessionStorage` (for instance after a lost connection); and a guest's browser can hold the preview cookie, which
  no longer opens an ended room, until its original expiry.
- **Not end-to-end encrypted.** TLS protects traffic to and from the relay, but the Worker handles frames and preview
  responses in readable form while it passes them on. Whoever operates a relay is trusted with them, and Cloudflare
  carries them. The rate limiters count by client IP address.
- **Capabilities are enforced by the host.** The host decides who gets in, with which role and for how long, and the
  relay applies that decision: it refuses calls a role does not allow. For editor calls (reading the project, editing,
  notes, AI requests), the host's Builder checks the guest's grant again before acting, so the relay's check is not the
  only one. Preview requests are different: the relay alone checks the guest's grant for them, and the host answers what
  it forwards, within limits on what a preview can reach.
- **Previews are isolated by origin**, one per room, on a domain with nothing else on it. See
  [why](#why-every-room-has-its-own-preview-origin), and [Access](#access) for the cookie and request rules.
