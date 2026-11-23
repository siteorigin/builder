# Contributing to SiteOrigin Builder

Thanks for helping. This guide covers setting up the app, the checks every change needs, and the few rules that keep projects safe and portable. The product and technical decisions live in the [v0.1 specification](docs/specification-v0.1.md); the [README](README.md) has an architecture overview.

## Setup

You need Node and npm: Node 24.15 or newer in the 24 line is recommended, and the pinned tooling also supports 22.22.2+ and 26+. Nothing else: the app bundles its own runtime for the websites it creates.

```sh
npm install
npm run dev        # the app with hot reload, in a visible window
```

`SITEORIGIN_USER_DATA=/some/folder` gives the app a separate settings and cache folder, which is useful for keeping test runs apart from your own projects. In development builds, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment are used when no key is saved in Settings.

## Checks

Every change needs:

```sh
npm run typecheck
npm test                  # unit and integration tests (vitest, tests/unit)
npm run build             # the end-to-end scripts drive the built app in out/
node tests/e2e/<script>.mjs   # the end-to-end script that covers your change, when there is one
```

Add unit tests that cover the change, and give every bug fix a regression test that fails without the fix. Never weaken an assertion to make a change pass. `npm run test:e2e` runs the whole end-to-end chain (smoke, editing flows, code components, visual tour, export integrity); while the repository is private, the full suites are driven to green by a separate local stabilization pass rather than by every change.

The end-to-end scripts in `tests/e2e/` drive the real Electron app with Playwright and fail on the first broken step. A few checks for tracked app bugs are wrapped in `knownFailure()`: they print `!! KNOWN FAILURE` without failing the run, and print a reminder to remove the wrapper once they pass. Each run creates a fresh scratch folder inside `WORK` (default: the OS temp folder) and deletes it when the script passes; a failed run keeps it and prints its path. Screenshots go to `SHOTS` (default: `so-e2e-shots` in the OS temp folder). Run one Electron script at a time.

Playwright launches are headless: the app never shows a window, takes focus or appears in the Dock, so tests never interrupt whoever is at the computer. `SITEORIGIN_HEADLESS=1` does the same for other drivers. When you are debugging a script yourself and want to watch it, set `SITEORIGIN_HEADED=1`, which takes precedence; never set it in a script. Test paths must not call `show()` or `focus()`, open external links or Finder, or use native dialogs (use the `window.builderTest` hooks or stub the dialog in the main process, as `export.mjs` does). On Linux, run the scripts under `xvfb-run -a`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run test:export-build` | The export integrity test, plus a standalone `npm ci && npm run build` of the exported source (spec I07). Slower, and needs the npm registry. |
| `npm run test:ai` | The real-provider agent test (OpenAI). It needs `OPENAI_API_KEY` and costs money: run it only when asked. |
| `npm run pack && npm run test:packaged` | Launches the packaged app with a minimal `PATH` (no system Node) and creates and previews a project. Unlike the scripts above, it uses `WORK` itself (default `so-packaged` in the OS temp folder), clears it at the start and leaves its screenshot there, so point `WORK` only at a disposable folder. |
| `DESIGN_CAPTURE=1 node tests/e2e/design-capture.mjs` | Screenshots of selected editor states, most in light and dark; `tests/e2e/design/` has one capture script per surface. |

Write end-to-end steps with `node:assert/strict` and the helpers in `tests/e2e/harness.mjs` (`eventually` instead of fixed sleeps, `MOD` for Cmd/Ctrl shortcuts), so a broken flow exits non-zero.

## Worktrees

Parallel work uses git worktrees that share the main checkout's install through a `node_modules` link. In Daintree, `.daintree/config.json` runs `scripts/link-shared-node-modules.mjs` as each worktree's setup: it makes the link, checks each locked package is installed at its version, and refreshes the shared install with `npm ci` in the main checkout when that install is only behind. A refresh removes `node_modules` while it runs, so it interrupts anything else using the shared install. Never run `npm ci` or `npm install` through a linked `node_modules`: it rebuilds the install every other worktree is using. A worktree made outside Daintree needs the link by hand: `DAINTREE_PROJECT_ROOT=<main checkout> node scripts/link-shared-node-modules.mjs` from the worktree.

Daintree runs a repository's setup commands only after they are approved on that machine. Before the first batch, open this project in Daintree, choose **Review commands** on any worktree card, read what will run, and approve it. Until then, every new worktree stops at `needs-approval`.

The Daintree assistant's `/work-batch` skill (`.daintree/assistant/.claude/skills/work-batch/`) works the issue backlog this way: `/next-batch` picks, one `/work` agent per issue opens a PR, and `/merge-prs` lands them on local checks, since the repository has no CI yet.

## Rules that matter

- **Every edit is an operation.** Manual and AI changes alike go through the typed operations in `src/shared/ops.ts` and the engine in `src/engine`. Don't write project files from the UI or the agent directly.
- **Generated output is deterministic and portable.** The same documents must generate the same bytes. Editor instrumentation never reaches project source or exports, and an exported project must build with plain `npm ci && npm run build`.
- **API keys stay in `api-keys.json`.** Keys are kept in the app's data folder, written with mode `0600` (user-only) on macOS and Linux; on Windows the data folder's permissions apply. Don't add OS keychain or `safeStorage` use, and never put a key in a project, a log, a tool result or an export.
- **The AI gets typed tools only.** No shell, filesystem or network access, and no image bytes are sent to a model.
- **Plain language in the UI.** The editor is for people who make brochure websites, not developers. Code features stay behind Developer mode.
- **Accessibility.** Every control is reachable and operable by keyboard, has an accessible name, and meets WCAG 2.2 AA contrast in light and dark themes.
- **No AI attribution** in commits, pull requests or docs.

## Commits

Keep each commit to one coherent change, with the checks above passing. Commit messages follow the existing style: a type, an optional scope and a plain summary, such as `feat(renderer): make the media gallery findable` or `fix(agent): retry a rate-limited stream once`, with a few bullets on what changed and why.

While the repository is private, work lands directly on `develop`. Once it is open-sourced, branch from `develop` and open pull requests against it, describing what changed for users and how you tested it, with screenshots for visible changes.

## Licence

SiteOrigin Builder is licensed under GPL-3.0-or-later. By contributing, you agree that your contributions are licensed under the same terms. Don't add assets or dependencies whose licences are incompatible, and keep the notices of anything redistributed (see `resources/starter-assets/NOTICE.md`).
