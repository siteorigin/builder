# SiteOrigin Builder

Electron + React desktop editor that builds portable SvelteKit 3 / Svelte 5 brochure sites. Canonical JSON documents under `siteorigin/` are the source of truth; the generator turns them into plain Svelte and CSS with no Builder runtime in the exported site. Manual edits and the AI assistant both go through the same validated `EditOperation` pipeline. The spec is `docs/specification-v0.1.md`.

## Where the project is

This is a prototype. The goal right now is a good, usable builder that can make a real multi-page site, not release polish. Work lands straight on `develop`; there is no PR gate yet. The exception is a `/work-batch` run in Daintree (`.daintree/`), where each issue gets a `/work` PR and `/merge-prs` lands them on local checks.

**Pre-release: no backwards compatibility.** Nothing has shipped, and every existing project is throwaway development data. Never spend effort keeping old projects, old document formats or old component definitions working: no migrations, schema-version bumps, compatibility shims, fallbacks for old shapes, or deprecation paths. Change the format or the contract directly and update the starters, fixtures and tests to match. An old project that breaks gets deleted and recreated. Compatibility work starts at the first public release.

**CI is deliberately deferred.** There is no GitHub Actions CI and none should be added: no `.github/workflows`, no pushes that trigger runs. CI comes back when the project is open-sourced. Until then, the full test surface is owned by the local stabilize workflow (below).

## Testing

- `npm run typecheck` — both tsconfigs.
- `npm test` — Vitest unit tests in `tests/unit/` (engine, generator, agent harness, sessions, codecheck, SVG).
- `npm run test:e2e` — Playwright scripts in `tests/e2e/` that drive the built Electron app (`npm run build` first). `tests/e2e/ai.mjs` calls a live provider and costs money: run it only when asked.

**E2E runs headless, always.** The main process detects a Playwright launch (or `SITEORIGIN_HEADLESS=1`) and never shows the window, never takes focus, and keeps the app out of the Dock (`src/main/index.ts`). Nothing may pop up on the user's screen during tests: don't call `show()`/`focus()` on test paths. An automated launch answers every native chooser from the test and records the links and reveals it hands to the desktop instead of acting on them (`src/main/headless-desktop.ts`): set answers with the harness's `answerChoosers` or the driver's `desktop.setAnswers` rather than patching Electron's `dialog` or `shell`. `SITEORIGIN_HEADED=1` shows the window only when a human is debugging a script.

Definition of done for a change: typecheck green, unit tests covering the change added and green, and the one e2e script that covers the change run when there is one. Don't chase e2e failures outside your change. Bug fixes get a regression test that fails without the fix. Never weaken an assertion to make a change pass.

**Stabilization.** The whole tree — unit, e2e, build, packaged smoke — is driven to green by the `stabilize` skill (`.agents/skills/stabilize/`), run with Codex (`$stabilize`) or Claude Code (`/stabilize`), and only when a human invokes it. For now it is **local only, on macOS**; Linux and Windows stages are added later, together with CI. Failures in the full suites are fixed there, not by every change.

## Rules

- No AI attribution anywhere: no `Co-Authored-By` trailers, no "generated with" lines in commits or docs.
- Never use the OS keychain or Electron `safeStorage`. API keys live in `userData/api-keys.json` with mode 0600.
- Live AI provider calls are expensive. Default model is OpenAI `gpt-6.2-sol`; prefer the fake-adapter tests in `tests/unit/agent.test.ts` and keep live runs to a handful.
- Exported sites must stay free of Builder lock-in: editor instrumentation lives only in `.siteorigin/cache/dev`, never in `src/`.
- Temporary output goes in `.tmp/` (gitignored), never the repo root.
