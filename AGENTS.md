# SiteOrigin Builder

Electron + React desktop editor that builds portable SvelteKit 3 / Svelte 5 brochure sites. Canonical JSON documents under `siteorigin/` are the source of truth; the generator turns them into plain Svelte and CSS with no Builder runtime in the exported site. Manual edits and the AI assistant both go through the same validated `EditOperation` pipeline. The spec is `docs/specification-v0.1.md`.

## Where the project is

The 0.1 release is being polished, and changes reach `develop` through pull requests: branch from `develop` and open the pull request against it. In a `/work-batch` run in Daintree (`.daintree/`), each issue that needs a change gets a `/work` PR, its agent sees the PR's CI through, and `/merge-prs` lands them. The one exception is the `stabilize` skill (below), which pushes its fixes to `develop` itself.

**Pre-release: no backwards compatibility.** Nothing has shipped, and every existing project is throwaway development data. Never spend effort keeping old projects, old document formats or old component definitions working: no migrations, schema-version bumps, compatibility shims, fallbacks for old shapes, or deprecation paths. Change the format or the contract directly and update the starters, fixtures and tests to match. An old project that breaks gets deleted and recreated. Compatibility work starts at the first public release.

**CI runs on pull requests only: the unit tests, on Linux.** The repository is public, and `.github/workflows/ci.yml` runs `npm ci` and the unit tests the pull request can affect (`vitest run --changed` against its base, following the import graph; the whole suite when `package.json`, the lockfile, the Vitest config, `tests/unit/setup.ts` or the workflow changes) on `ubuntu-latest`, with Chromium installed for the browser tests, for every push to a pull request, as one check, `Unit tests`. A test that reads its input through `fs` rather than importing it is not reached; the stabilize pass catches those. Nothing runs on a push to `develop`, and CI has no typecheck, e2e, build, packaged smoke, WebKit or other OS: keep it to that, and add no other workflow, unless asked. The other workflows are the release ones, `.github/workflows/release-macos.yml`, `release-linux.yml` and `release-windows.yml`: on a version tag (or a dry run by hand) each runs the whole unit suite, builds its OS's installers (signed and notarized on macOS) and publishes them to R2. Releases are shipped with the `release` skill (`docs/releasing.md`). An agent that opens a PR can watch its CI to a verdict (`gh pr checks <n> --watch`) and fix what its change broke: fetch before pushing, never force-push, and rerun only a clear flake. The rest of the test surface is owned by the local stabilize workflow (below).

## Testing

- `npm run typecheck` — the app's two tsconfigs and the relay's (`relay/tsconfig.json`).
- `npm test` — Vitest unit tests in `tests/unit/` (engine, generator, agent harness, sessions, codecheck, SVG, and the live session relay in Cloudflare's local simulator, offline).
- `npm run relay:dev` — the live session relay (`relay/`) on port 8787; copy `relay/.dev.vars.example` to `relay/.dev.vars` first. Point the app at `http://relay.localhost:8787` (not `127.0.0.1` or bare `localhost`): each room's preview is its own origin, `http://p-<label>.relay.localhost:8787`, and must be the same site as the viewer.
- `npm run test:e2e` — Playwright scripts in `tests/e2e/` that drive the built Electron app (`npm run build` first). `tests/e2e/ai.mjs` calls a live provider and costs money: run it only when asked.

**E2E runs headless, always.** The main process detects a Playwright launch (or `SITEORIGIN_HEADLESS=1`) and never shows the window, never takes focus, and keeps the app out of the Dock (`src/main/index.ts`). Nothing may pop up on the user's screen during tests: don't call `show()`/`focus()` on test paths. An automated launch answers every native chooser from the test and records the links and reveals it hands to the desktop instead of acting on them (`src/main/headless-desktop.ts`): set answers with the harness's `answerChoosers` or the driver's `desktop.setAnswers` rather than patching Electron's `dialog` or `shell`. `SITEORIGIN_HEADED=1` shows the window only when a human is debugging a script.

Definition of done for a change: typecheck green, unit tests covering the change added and green, and the one e2e script that covers the change run when there is one. Don't chase e2e failures outside your change. Bug fixes get a regression test that fails without the fix. Never weaken an assertion to make a change pass.

**Stabilization.** The whole tree — unit, e2e, build, packaged smoke — is driven to green by the `stabilize` skill (`.agents/skills/stabilize/`), run with Codex (`$stabilize`) or Claude Code (`/stabilize`), and only when a human invokes it. For now it is **local only, on macOS**; PR CI's unit tests are the only Linux run, and Windows has none yet. Failures in the full suites are fixed there, not by every change.

## Rules

- No AI attribution anywhere: no `Co-Authored-By` trailers, no "generated with" lines in commits or docs.
- Never use the OS keychain or Electron `safeStorage`. API keys live in `userData/api-keys.json` with mode 0600.
- Live AI provider calls are expensive. Default model is OpenAI `gpt-6.2-sol`; prefer the fake-adapter tests in `tests/unit/agent.test.ts` and keep live runs to a handful.
- Exported sites must stay free of Builder lock-in: editor instrumentation lives only in `.siteorigin/cache/dev`, never in `src/`.
- Temporary output goes in `.tmp/` (gitignored), never the repo root.
