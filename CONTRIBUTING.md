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

Keep `tool_timeout_sec` at 300 or more: starting a session can take up to three minutes on a cold machine. As printed, Codex asks before each tool that isn't read-only, which is the safe default for an interactive session. `codex exec` can't ask, so it refuses those tools; uncomment `default_tools_approval_mode = "approve"` to let them run unasked. Only do that knowingly. The session is a disposable copy of the app in a temporary profile of its own, and its choosers only reach the session's own folders. But the tools can do anything a person can do in the app, and that includes turning on Developer mode and writing code that the project's preview runs with your user's permissions. Then start Codex anywhere and ask it to use the tools, for example:

> Use the SiteOrigin Builder MCP tools. Start a session at Welcome and tell me what the screen shows. Open New project, fill Project name with "MCP smoke", read the value back, and show me a screenshot of the dialog. Cancel with Escape. Use the old Project name ref again and report the error, then open the dialog again and fill the new field. Try a snapshot with maxNodes 0 and report the error. Then close the session.

**Other clients** launch it the same way: command `node` (or its full path), arguments `["/path/to/builder/tests/driver/mcp.ts"]`, stdio transport, and a per-call timeout of at least five minutes. As JSON, for clients that read an `mcpServers` object:

```json
{ "mcpServers": { "siteorigin_builder": { "command": "node", "args": ["/path/to/builder/tests/driver/mcp.ts"] } } }
```

**What the tools do.** There is one tool per driver operation, named with `_` for `.` (`ui.click` is `ui_click`), and each tool's description says its kind: `observe` only reads, `act` does what a person could with real input, `fixture` prepares state no person made through the UI (chooser answers, sample files), and `session` manages the run. A call answers with the driver's own reply, both as structured content and as the same JSON in text. A failure is that reply marked as an error: `{ code, message, retryable, details }`, the same codes the Node tests see (`details.hint` often says what to do next, such as observing again after `STALE_REF`). `ui_snapshot` with `screenshot: true` saves screenshots, and `evidence_read` returns one by its id as an image. `ui_waitFor` waits for an element to appear or go. `wait_for` waits for a named condition (a save settled, the preview ready, an export finished), `project_summary` and `exports_inspect` check outcomes without the UI, and `evidence_log` and `evidence_save` return the run's record and write a replayable `replay.json`. `assistant_script` and `assistant_release` set what the scripted model answers (fixtures), and `assistant_observe` and `assistant_wait` read the assistant's runs by their IDs.

Each session runs headless in its own profile and workspace, with a scripted AI provider that costs nothing. Over MCP the window can't be shown and the artifacts stay inside the session's run folder (`keepArtifacts: "always"` keeps them after it closes; `session_close` says where). After `session_close`, the next `session_start` starts a fresh session. If the client disconnects, the app and every process it started are ended, and the run's folder is removed, except for the artifacts the session was asked to keep. Lifecycle messages go to the server's stderr. `HOST_LOST` means the session's host process ended: whatever that call did may or may not have happened, and `session_start` starts again.

`node tests/e2e/mcp.mjs` drives the same journey with the official MCP SDK client, as a regression test.

## Worktrees

Parallel work uses git worktrees, each with its own install. A new worktree starts without `node_modules`: run `npm ci` in it before building or testing. The repository has no Daintree setup command, so new worktrees are ready as soon as they are created.

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

SiteOrigin Builder is licensed under Apache-2.0, and the Foundation and Editorial themes (`src/catalogue/`) under MIT-0, because their components are copied into exported websites. By contributing, you agree that your contributions are licensed under the same terms as the code they change. Don't add assets or dependencies whose licences are incompatible, and keep the notices of anything redistributed (see `resources/starter-assets/NOTICE.md`).
