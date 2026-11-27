---
name: release-relay
disable-model-invocation: true
argument-hint: "[--rotate-key] [--domain <domain>]"
description: "Deploy the live session relay (relay/: one Cloudflare Worker, siteorigin-builder-relay, and its SessionRoom Durable Object) to Cloudflare: prove it locally against the simulator and the smoke test, deploy the production environment with wrangler, set or rotate SESSION_SIGNING_KEY, and smoke-test the deployed relay. Use when the user wants to deploy, release, ship or update the relay."
---

# Release the relay

Deploy `relay/` to Cloudflare as the Worker **`siteorigin-builder-relay`**, the `[env.production]` environment in
`relay/wrangler.toml`. This is separate from the app release: the relay never ships in the app (`electron-builder.yml`
packages only `out/**`), and the `release` skill does not touch it.

**Argument (may be empty):** `$ARGUMENTS`. `--rotate-key` sets a new `SESSION_SIGNING_KEY` after the deploy.
`--domain <domain>` moves the relay onto its own domain first (below).

Invoking this skill approves the deploy. Don't stop to ask for anything except a `wrangler login` the user has to do.

**Deploy only what is on `develop`.** Run from a clean checkout of `develop` at `origin/develop`, so the live relay is
always a commit anyone can read. A deploy from a branch or an uncommitted edit is undone, silently, by the next
deploy from `develop`.

## Where the relay is served

- **Now: workers.dev only**, `https://siteorigin-builder-relay.siteorigin.workers.dev`. There, rooms, the guest's
  viewer, joining, admitting, roles, host reconnects and ending all work, but **previews do not**. A room's preview
  is `p-<label>.<relay host>`, and workers.dev has no names or certificates below a Worker's own. The guest gets in and
  sees "The preview didn't open". The smoke test skips its preview steps on workers.dev.
- **Later: its own domain.** The relay needs a registrable domain used for nothing else, never `siteorigin.com` or one
  of its subdomains, because a preview runs the host's site code, and that code can set cookies for the parent domain
  (`relay/README.md`, "Why every room has its own preview origin"). The viewer sits at the apex and previews one level
  under it (`p-<label>.<domain>`), so Cloudflare's free Universal SSL covers them.
- **The app's default relay** is `DEFAULT_RELAY_URL` in `src/shared/live/relay-url.ts`. This skill never changes it.
  Point an app at the deployed relay with `SITEORIGIN_LIVE_RELAY_URL=<relay URL>` or the relay field in the app's
  advanced settings.

## 1. Preflight

1. `npx wrangler whoami`. If it reports no login, ask the user to run `! npx wrangler login` and stop. The account must
   be the SiteOrigin one whose workers.dev subdomain is `siteorigin`; if `CLOUDFLARE_ACCOUNT_ID` is set in the
   environment, it must be that account's ID. While the relay is on workers.dev, the deploy in section 3 prints
   `https://siteorigin-builder-relay.siteorigin.workers.dev`, and once it has its domain, that domain's two routes.
   If it prints anything else, the Worker went to another account: say so and stop.
2. `git status --short` is empty, the branch is `develop`, and `git rev-parse HEAD` equals `git rev-parse origin/develop`
   after a `git fetch`. Otherwise stop and say why.
3. Note the version serving now, the rollback target: `npx wrangler deployments status --config relay/wrangler.toml
   --env production` (its `Version(s)` ID). On the first deploy there is none.
4. With `--domain <domain>`, move the relay onto it, unless `[env.production]` already names that domain (the PR
   below has merged), in which case carry on to section 2:
   - The domain must be a zone in the logged-in account, with **proxied** DNS records for `@` and `*`. Workers routes
     only fire on proxied hostnames; with nothing else on the domain, an `AAAA` record to `100::` for each is enough.
     If they are missing, tell the user exactly which records to add, and stop.
   - The domain's first label must not start with `p-` (`p-example.live`): the relay refuses to treat a host under such
     a parent as a room's preview, so previews would never open (`previewHost` in `relay/src/index.ts`).
   - In `[env.production]`, set `workers_dev = false`, and uncomment `routes` and `RELAY_ORIGIN` with the domain in
     place of `example.live`. That edit reaches `develop` through a PR like any other change. Open the PR, stop here,
     and run the skill again once it is merged. Invite links from sessions open at the switch stop working, since
     they name the workers.dev host.

## 2. Prove it locally

From the repository root. If any step fails, stop and report it; don't deploy.

```sh
npx tsc --noEmit -p relay/tsconfig.json
npx vitest run tests/unit/relay- tests/unit/live-relay-url.test.ts tests/unit/live-host-relay.test.ts
[ -f relay/.dev.vars ] || cp relay/.dev.vars.example relay/.dev.vars
npm run relay:dev        # in the background; wait for "Ready on http://127.0.0.1:8787"
npm run relay:smoke      # against http://relay.localhost:8787, previews included
```

Stop the local relay afterwards.

## 3. Deploy

First the dry run, which uploads nothing:

```sh
npx wrangler deploy --config relay/wrangler.toml --env production --dry-run --outdir .tmp/relay-dry
```

It must succeed and list `ROOMS` (Durable Object), `ROOM_CREATION_LIMITER`, `ROOM_CONNECT_LIMITER` and `ASSETS`, plus
`RELAY_ORIGIN` once the relay has its domain. Only then deploy:

```sh
npm run relay:deploy
```

Keep the version ID it prints, and check the URL it prints (item 1 of the preflight). Then
`npx wrangler secret list --config relay/wrangler.toml --env production`: if `SESSION_SIGNING_KEY` is not there (a new
Worker, or a first run that stopped early), set it now (section 5), before the smoke test.

**Live sessions and deploys.** Cloudflare moves each Durable Object onto the new version when the object next
hibernates, or after at most 300 seconds (the default deferred code update). A room lives in its object's memory and in
the attachments of its WebSockets, so a session can come through a deploy, but deploy when few sessions are open, and
say in the report that any that were open saw a deploy.

## 4. Smoke-test the new code

```sh
npm run relay:smoke -- https://siteorigin-builder-relay.siteorigin.workers.dev   # or https://<domain>
```

It opens one real room, admits a guest, tunnels one preview request (on a real domain only), drops and re-proves the
host, and ends the room, also when a step fails. Each run opens a room, which counts against the per-IP room creation
limit. Without the key, step 1 fails with `Could not open wss://…/ws/host`.

If it fails, rerun it while you read `npx wrangler tail --config relay/wrangler.toml --env production`. If the new code
caused the failure, roll back to the version noted in the preflight, by its ID:

```sh
npx wrangler rollback <version-id> --config relay/wrangler.toml --env production
```

On a first deploy there is no earlier version: fix forward instead. Always give the ID: setting a secret also makes a version, and a bare `rollback` goes back one version, which may be
the same code with a different key, or no key at all. Then smoke-test again. If DNS, routes or the key caused the
failure, fix that instead of rolling back.

## 5. The signing key

Set a fresh key when section 3 found none (before the smoke test), or for `--rotate-key` (only after the new code has
passed section 4):

```sh
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_SIGNING_KEY --config relay/wrangler.toml --env production
```

Never print the key, write it to a file, or put it in the repository. Setting it makes a new version, so run the smoke
test again afterwards and note that version as the one now serving. Rotating the key voids every preview cookie
already issued. Guests are not removed: a guest's viewer shows "The preview didn't open", and its **Try again** takes
its place back with a fresh ticket under the new key. Nobody needs re-admitting.

## Report

Report what was deployed (the version ID now serving and the `develop` commit it came from), whether the key was set or rotated, the smoke
test's result, any `wrangler.toml` or DNS change that still needs a PR, and whether sessions were open during the deploy.
