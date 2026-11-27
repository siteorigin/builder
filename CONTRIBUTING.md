# Contributing to SiteOrigin Builder

Thanks for helping. This guide covers setting up the app, the checks every change needs, and the few rules that keep projects safe and portable. The product and technical decisions live in the [v0.1 specification](docs/specification-v0.1.md); the [README](README.md) has an architecture overview.

## Setup

You need Node and npm: Node 24.15 or newer in the 24 line is recommended, and the pinned tooling also supports 22.22.2+ and 26+. The websites the app creates need nothing more: it bundles its own runtime for them.

```sh
npm ci
npx playwright install chromium   # on Linux add --with-deps, as CI does
npm run dev        # the app with hot reload, in a visible window
```

Playwright's Chromium is for the browser tests in `npm test`, which skip themselves without it, and for drawing the theme thumbnails when the committed theme releases are refreshed (below). The WebKit cases skip themselves too unless you also install WebKit (`npx playwright install webkit`, with `--with-deps` on Linux); CI does not run them.

`SITEORIGIN_USER_DATA=/some/folder` gives the app a separate settings and cache folder, which is useful for keeping test runs apart from your own projects. In development builds, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment are used when no key is saved in Settings.

## Theme releases

Foundation, the built-in theme, and its development fixture `foundation-alt` are authored in the private [`siteorigin/builder-components`](https://github.com/siteorigin/builder-components) repository and committed here as built releases: `resources/packs/foundation/` and `resources/packs-dev/foundation-alt/`, pinned by version and digest in `resources/packs.lock.json`, which also names the builder-components commit they were built from. You don't need that repository: `npm run dev`, `build`, `pack` and `dist` check the committed releases against the lock and use them as they are, and a release that has changed without its lock fails that check. The unit tests, the agent evaluation and the other scripts load the same committed releases the app loads; `src/catalogue/` holds the authoring DSL, the pack format and the starters, but no theme.

Refreshing them is for people with access to builder-components. With a checkout beside this one (a `builder-components` folder next to this checkout, or next to the main checkout when you work in a worktree), or named by `SITEORIGIN_BUILDER_COMPONENTS=/path/to/builder-components`, and its dependencies installed (`npm ci` there), `npm run build:packs` builds both from that checkout against this checkout's code, draws their thumbnails (Playwright's Chromium), loads them back through the app's loader, and replaces the committed releases and the lock in one step. The checkout must have no uncommitted changes, since the lock records its commit. Commit both releases and the lock together. A change here that stops the committed releases loading fails `tests/unit/committed-packs.test.ts`, and a change to them or to the lock reruns the whole unit suite on PR CI.

## Checks

Every change needs:

```sh
npm run typecheck
npm test                  # unit and integration tests (vitest, tests/unit)
npm run build             # the end-to-end scripts drive the built app in out/
node tests/e2e/<script>.mjs   # the end-to-end script that covers your change, when there is one
```

Add unit tests that cover the change, and give every bug fix a regression test that fails without the fix. Never weaken an assertion to make a change pass. `npm run test:e2e` runs the chain of end-to-end scripts listed in `package.json` (not every script in `tests/e2e/` is in it); pull-request CI runs only the unit tests the change can affect, on Linux, and the full suites are driven to green by a separate local stabilization pass rather than by every change.

The end-to-end scripts in `tests/e2e/` drive the real Electron app with Playwright and fail on the first broken step. A check for a tracked app bug can be wrapped in `knownFailure()`: it prints `!! KNOWN FAILURE` without failing the run, and prints a reminder to remove the wrapper once it passes. Each run of a script that uses the harness's `scratch()` creates a fresh scratch folder inside `WORK` (default: the OS temp folder) and deletes it when the script passes; a failed run keeps it and prints its path. Screenshots go to `SHOTS` (default: `so-e2e-shots` in the OS temp folder). Run one Electron script at a time.

Playwright launches are headless: the app never shows a window, takes focus or appears in the Dock, so tests never interrupt whoever is at the computer. `SITEORIGIN_HEADLESS=1` does the same for other drivers. When you are debugging a script yourself and want to watch it, set `SITEORIGIN_HEADED=1`, which takes precedence; never set it in a script. Test paths must not call `show()` or `focus()`. An automated launch answers every native chooser from the test, and records the links and reveals it would hand to the desktop instead of acting on them (`src/main/headless-desktop.ts`). Set chooser answers with the harness's `answerChoosers` (as `export.mjs` does) or the test driver's `desktop.setAnswers`; never patch Electron's `dialog` or `shell`. On Linux, run the scripts under `xvfb-run -a`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run test:export-build` | The export integrity test, plus a standalone `npm ci && npm run build` of the exported source (spec I07). Slower, and needs the npm registry. |
| `npm run test:ai` | The real-provider agent test (OpenAI). It needs `OPENAI_API_KEY` and costs money: run it only when asked. |
| `npm run pack && npm run test:packaged` | Launches the packaged app with a minimal `PATH` (so it relies on its bundled Node) and creates and previews a project. On a Mac it expects the arm64 build; set `APP_BIN` to the executable for any other layout. Unlike the scripts above, it uses `WORK` itself (default `so-packaged` in the OS temp folder), clears it at the start and leaves its screenshot there, so point `WORK` only at a disposable folder. |
| `npm run test:model-smoke` | An external model (Codex) takes the principal journey with only the test driver's MCP tools. It costs Codex usage: run it on purpose, after `npm run build` (see "Interaction coverage"). |
| `DESIGN_CAPTURE=1 node tests/e2e/design-capture.mjs` | After `npm run build`: screenshots of selected editor states, most in light and dark, written under the OS temp folder or to `DESIGN_CAPTURE_DIR`; `tests/e2e/design/` has more capture scripts, each for one surface. |

Write end-to-end steps with `node:assert/strict` and the helpers in `tests/e2e/harness.mjs` (`eventually` instead of fixed sleeps, `MOD` for Cmd/Ctrl shortcuts), so a broken flow exits non-zero.

## Driving the app from Codex or another MCP client

The test driver the end-to-end scripts use (`tests/driver/`) is also a local MCP server, so Codex or any other MCP client can launch a disposable copy of the built app, look at it and use it as a person would, with no Playwright script. The server is `tests/driver/mcp.ts`: the client starts it and talks to it over stdio, and it is test tooling only, never part of the app or an exported site.

**Prerequisites**, from a fresh checkout:

```sh
git clone <this repository> builder && cd builder
npm ci
npm run build             # the server drives the built app in out/: build again after changing the app
```

Node 24.15 or newer runs the server's TypeScript directly. On Linux, start the client under `xvfb-run -a`, as for the end-to-end scripts, and let `DISPLAY` and `XAUTHORITY` through to the server: clients that pass on only a few variables, as Codex and the MCP SDK do, need them named (`--print-config` does this for Codex on Linux).

**Codex.** Print the server's entry for this checkout, with the full paths of your Node and the checkout filled in, and add it to `~/.codex/config.toml`:

```sh
node tests/driver/mcp.ts --print-config >> ~/.codex/config.toml
codex mcp list            # siteorigin_builder is listed
```

The entry looks like this:

```toml
[mcp_servers.siteorigin_builder]
command = "/usr/local/bin/node"
args = ["/path/to/builder/tests/driver/mcp.ts"]
cwd = "/path/to/builder"
startup_timeout_sec = 30
tool_timeout_sec = 300
# Codex asks before each tool that is not read-only, and `codex exec` refuses them. Uncomment to run them unasked:
# the app is a disposable copy, but in Developer mode it runs code a person writes, with your permissions.
# default_tools_approval_mode = "approve"
```

Keep `tool_timeout_sec` at 300 or more: starting a session can take up to three minutes on a cold machine. As printed, and unless your own Codex settings already approve them, Codex asks before each tool that isn't read-only, which is the safe default for an interactive session. `codex exec` can't ask, so it refuses those tools; uncomment `default_tools_approval_mode = "approve"` to let them run unasked. Only do that knowingly. The session is a disposable copy of the app in a temporary profile of its own, and its choosers only reach the session's own folders. But the tools can do anything a person can do in the app, and that includes turning on Developer mode and writing code that the project's preview runs with your user's permissions. Then start Codex anywhere and ask it to use the tools, for example:

> Use the SiteOrigin Builder MCP tools. Start a session at Welcome and tell me what the screen shows. Open New project, fill Project name with "MCP smoke", read the value back, and show me a screenshot of the dialog. Cancel with Escape. Use the old Project name ref again and report the error, then open the dialog again and fill the new field. Try a snapshot with maxNodes 0 and report the error. Then close the session.

**Other clients** launch it the same way: command `node` (or its full path), arguments `["/path/to/builder/tests/driver/mcp.ts"]`, stdio transport, and a per-call timeout of at least five minutes. As JSON, for clients that read an `mcpServers` object:

```json
{ "mcpServers": { "siteorigin_builder": { "command": "node", "args": ["/path/to/builder/tests/driver/mcp.ts"] } } }
```

**What the tools do.** There is one tool per driver operation, named with `_` for `.` (`ui.click` is `ui_click`), and each tool's description says its kind: `observe` looks at the app or session (a screenshot or `evidence_save` also writes a file), `act` does what a person could with real input, `fixture` prepares state no person made through the UI (chooser answers, sample files), and `session` manages the run. A call answers with the driver's own reply, both as structured content and as the same JSON in text. A failure is that reply marked as an error: `{ code, message, retryable, details }`, the same codes the Node tests see (`details.hint` often says what to do next, such as observing again after `STALE_REF`). `ui_snapshot` with `screenshot: true` saves screenshots, and `evidence_read` returns one by its id as an image. `ui_waitFor` waits for an element to appear or go. `wait_for` waits for a named condition (a save settled, the preview ready, an export finished), `project_summary` and `exports_inspect` check outcomes without the UI, and `evidence_log` and `evidence_save` return the run's record and write a replayable `replay.json`. `assistant_script` and `assistant_release` set what the scripted model answers (fixtures), and `assistant_observe` and `assistant_wait` read the assistant's runs by their IDs.

Each session runs headless in its own profile and workspace, by default with a scripted AI provider that costs nothing. Over MCP the window can't be shown and the artifacts stay inside the session's run folder (`keepArtifacts: "always"` keeps them after it closes; `session_close` says where). After `session_close`, the next `session_start` starts a fresh session. If the client disconnects, the app and every process it started are ended, and the run's folder is removed, except for the artifacts the session was asked to keep. Lifecycle messages go to the server's stderr. `HOST_LOST` means the session's host process ended: whatever that call did may or may not have happened, and `session_start` starts again.

`node tests/e2e/mcp.mjs` drives the same journey with the official MCP SDK client, as a regression test.

## Interaction coverage

`tests/coverage/interactions.ts` lists what a person can do in Builder, one row per user intent: where it starts, the discoverable actions that do it (Welcome, the menus, the toolbar and command menu, panels, context menus, shortcuts, the preview, the chat), what proves it happened, the scenario it is proven in, the platforms and builds it applies to, the tests that prove it, and what is still missing with its owner. `node tests/coverage/interactions.ts --markdown` prints it as tables.

**A change that adds, removes or renames a way to do something updates its row**: the route, a proof (a test that takes that route and checks the outcome), or a gap with its owner. `npm test` holds the list to the app (`tests/unit/interaction-coverage.test.ts`): every action it can read from the source (the application menu on each platform, the writing menu, the command menu, the sidebar's views, the keys the editor's shortcut handler acts on, and the items of every menu the editor draws, one key standing for each file's items labelled wholly from data) must be a route of some row, and every such route must still exist. Every script in `tests/e2e/` must be linked from a row as a test that drives the app, and a proof's kind must fit where it lives. A proof in a script that declares steps names the one that proves the row, as all or a unique part of a declared `step()` (or `it()`) title; a unit test may be linked as a whole. A row that only screen captures prove needs a gap. The readers read the shapes the app uses today; an action written another way (a command built by a helper in another file, a key compared outside `handleShortcut`, preview keys such as a visitor's Back and Forward), and Welcome, toolbar and panel buttons, canvas gestures and the preview, which are listed by name, are not found from the source, so for those the rule is yours to keep.

`node tests/e2e/journeys.mjs` takes the principal journey through the test driver: from a fresh Welcome, a site created, edited, discussed with the assistant (a question, then an edit it may only make once allowed, declined and then allowed), undone and redone, exported, closed and opened again, with a cancelled chooser on the way. The session's record must prove the journey with its expected text and site names (`tests/coverage/journey-proof.ts`), and it is replayed in a fresh session, which must end with the same project and export.

`npm run test:model-smoke` gives the same journey, in words, to an external model: Codex, run in an empty folder in the OS temporary folder (outside any repository) with a read-only sandbox, no user configuration, rules or project documents, its own shell, browser, image, app, plugin and sub-agent tools turned off, and the driver's MCP server, whose tools are approved. Codex cannot list what it was given, so its transcript is the check: any tool other than the Builder's, even an attempt, fails the run, as does a transcript that cannot be read whole. The Builder tools can do whatever a person can in the app; Developer mode, where the app runs code a person writes with your permissions, is locked off in the sessions this test starts (`SITEORIGIN_DEVELOPER_MODE=locked-off`, which the driver passes to the app), the model is told to leave it alone, and a record that shows it reached for it fails the run and is not replayed. The session's own record must prove the journey by the same check as `journeys.mjs`, with this run's text and names, and it is replayed from Node in a fresh session, which must end with the edit saved and the site renamed. A replay that stops at a step the record marks as not replayable (the model clicked screenshot pixels, which it is asked not to) is reported as partial rather than failed. The assistant inside the app stays scripted, so only Codex usage is spent. `npm run test:model-smoke -- --probe` checks the setup with one tool call first, and `--no-replay` skips the replay (the verdict says so). Each run keeps its evidence in `.tmp/model-smoke/<run>/`: `transcript.jsonl` (every event, with host paths, the user's name, credentials and image data taken out), `report.md` (the model's own account, redacted the same way), `evidence/` (the session's `replay.json` and `app.log`, redacted the same way), `proof.txt` and `summary.json`. No screenshot is kept unless asked for with `--keep-screens`: pixels are not redacted, and a dialog can show a folder path. `MODEL` and `EFFORT` choose the Codex model and reasoning effort. How well a model builds sites is measured separately, by `npm run eval:agent`.

**Platforms.** Local runs, including stabilization, are macOS only for now. Rows for what only Windows and Linux have (Open Project Folder… and Quit in the File menu, and Ctrl+Y as the Edit menu's Redo key on Windows) are listed, but no local run exercises them; the packaged smoke test (`tests/e2e/packaged.mjs`) is the subset proven on a packaged build.

## Worktrees

Parallel work uses git worktrees, each with its own install. A new worktree starts without `node_modules`, and nothing installs it for you (the repository has no Daintree setup command): run `npm ci` in it before building or testing.

The Daintree assistant's `/work-batch` skill (`.daintree/assistant/.claude/skills/work-batch/`) works the issue backlog this way: `/next-batch` picks, one `/work` agent per issue opens a PR and sees its CI through, and `/merge-prs` lands them.

## Rules that matter

- **Every edit is an operation.** Manual and AI changes alike go through the typed operations in `src/shared/ops.ts` and the engine in `src/engine`. Don't write project files from the UI or the agent directly.
- **Generated output is deterministic and portable.** The same documents must generate the same bytes. Editor instrumentation never reaches project source or exports, and an exported project must build with plain `npm ci && npm run build`.
- **API keys stay in `api-keys.json`.** Keys are kept in the app's data folder, written with mode `0600` (user-only) on macOS and Linux; on Windows the data folder's permissions apply. Don't add OS keychain or `safeStorage` use, and never put a key in a project, a log, a tool result or an export.
- **The AI gets typed tools only.** No shell, filesystem or network access, and no image bytes are sent to a model.
- **Plain language in the UI.** The editor is for people who make websites (business sites, portfolios, blogs), not developers. Code features stay behind Developer mode.
- **Accessibility.** Every control is reachable and operable by keyboard, has an accessible name, and meets WCAG 2.2 AA contrast in light and dark themes.
- **No AI attribution** in commits, pull requests or docs.

## Commits

Keep each commit to one coherent change, with the checks above passing. Commit messages follow the existing style: a type, an optional scope and a plain summary, such as `feat(renderer): make the media gallery findable` or `fix(agent): retry a rate-limited stream once`, with a few bullets on what changed and why.

Branch from `develop` and open pull requests against it, describing what changed for users and how you tested it, with screenshots for visible changes. For every pull request, CI runs the unit tests the change can affect, on Linux (`.github/workflows/ci.yml` says when that is the whole suite); it runs no type check or e2e, so run `npm run typecheck` and the e2e script that covers your change yourself.

## Licence

SiteOrigin Builder is licensed under Apache-2.0, and the Foundation theme (`resources/packs/foundation/`) under MIT-0, because their components are copied into exported websites. By contributing, you agree that your contributions are licensed under the same terms as the code they change. Don't add assets or dependencies whose licences are incompatible, and keep the notices of anything redistributed (see `resources/starter-assets/NOTICE.md`).
