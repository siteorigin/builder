# SiteOrigin Builder

A free, open-source desktop editor for brochure websites. You edit visually, optionally with an AI assistant, and every project is a normal SvelteKit site on your own computer that you can export, version and deploy anywhere.

This is version 0.1: a working foundation to improve on, built to the [v0.1 specification](docs/specification-v0.1.md) decisions.

## What works

- **Nothing to install.** The app bundles its own Node runtime (Electron's), npm, and an offline copy of the website starter's locked packages for each platform. Creating a project sets up its "website tools" from that bundle in a second or two, with no network needed. Settings → Diagnostics can reinstall them, and setup errors are explained in plain language.
- **Yours to keep.** Every website is a normal project folder the user owns. They can host it anywhere or hand it to a developer. SiteOrigin Hosting is mentioned as coming soon; it isn't a working option yet.
- **Projects are folders.** Each one is a complete SvelteKit 3 site, marked by `siteorigin.project.json`, with editable documents in `siteorigin/` and private editor state (history, chat, caches) in `.siteorigin/`.
- **Create, open, reopen and duplicate.** Starters are Business (Home, About and Contact, with sample images) and Blank. Unfamiliar projects need a trust decision before their build tools run.
- **Live preview.** The project's own Vite/SvelteKit dev server runs in an isolated utility process on loopback, and the site appears in a sandboxed iframe. Viewport presets, continuous resize and zoom are supported.
- **Visual editing.**
  - Selection is shared across the canvas, layers, breadcrumb and inspector.
  - Text can be edited inline.
  - Typed content controls cover text, rich text, links, images, icons and lists with stable item IDs.
  - Variants, plus layout, spacing, size, typography and appearance controls, with an All sizes / Phone / Tablet / Desktop style scope.
- **Pages.** Add, rename, duplicate, reorder, set Home and delete with link replacement. Routes and SEO fields are editable; internal links use page IDs.
- **Components.** Two built-in themes, Foundation (classic serif and sans) and Signal (geometric sans with mono accents), implement the same 18 section families plus basics, so a site can switch between them and keep its content.
  - Insert, move, duplicate and delete.
  - Edit a shared definition (theme components are forked first).
  - Make unique, create a component from a selection, and convert a copy to code.
  - Code features are hidden behind **Developer mode** (off by default), because most users never need code. With it on, you can create project code components in Svelte, in a CodeMirror editor with live compiler diagnostics.
  - Every code save is checked: it must compile for browser and server, import only allowed modules, use no raw HTML and no eval. When checks fail and an AI provider is set up, a small code-fixing agent repairs the code, and the repair is checked again before saving. Broken code is never saved.
  - Reorder by dragging on the canvas (with an insertion indicator) or in Layers, where elements can also move between containers and slots. Move up and down actions are the keyboard alternative.
- **Site styles.** Colour, font, text-style, spacing, container, radius, shadow and border tokens. Theme defaults and project overrides are kept separately, and switching to a compatible theme preserves content and forks.
- **Assets.** Import images (SVGs are checked for scripts), with responsive 480/960/1440px copies served through `srcset`. Track usage, replace everywhere and remove unused images.
- **History.** Persistent grouped undo and redo (including hand-written code component source), a publication journal with crash recovery, external-edit detection for generated files, and conflict reporting.
- **AI assistant.** OpenAI (default model GPT-6.2 Sol) and Anthropic adapters sit behind one provider contract.
  - Streaming chat with selection context that is frozen when you send.
  - Typed tools only: no shell, filesystem or web access.
  - Multi-step runs with live activity, validation and repair, then one undoable group per turn.
  - Stop and revert at any point.
  - A request sent with an element selected may only change that element. Wider changes need the user's explicit approval, which the AI asks for.
  - Without Developer mode, the AI cannot write code either; it builds with theme components and styles.
  - No images are ever sent to the model.
- **Export.**
  - A static site, built from an isolated snapshot. Every page is prerendered, and the output is checked for editor-only markup.
  - The complete source project, which builds with plain `npm ci && npm run build`.

## Development

Requires Node 24.15+ (22.22.2+ and 26+ also work), only for developing the app; the packaged app bundles everything it needs.

```sh
npm install
npm run dev               # start the app with hot reload
npm run typecheck
npm test                  # unit and integration tests (engine, generator, themes, agent harness, sessions)
npm run build && npm run test:e2e   # drive the built app with Playwright; any failed step exits non-zero
npm run test:export-build # export integrity plus a standalone `npm ci && npm run build` of the exported source
npm run test:ai           # real-provider agent test; needs OPENAI_API_KEY and costs money
npm run test:packaged     # after `npm run pack`: launch the packaged app with a minimal PATH (no system Node)
npm run pack              # build an unpacked app into dist/
npm run dist              # build installers (DMG, NSIS installer, AppImage)
```

The end-to-end scripts run the app headless, each in a fresh scratch folder under the OS temp folder (or under `WORK`, if set) that is deleted when the script passes; screenshots go to `SHOTS`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full test guide.

In development builds, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment are used when no key is saved in Settings. Packaged builds use keys saved in Settings, which are kept in `api-keys.json` in the app's data folder, readable only by your user account. The app never uses the operating system keychain, so it never asks for keychain access. `SITEORIGIN_USER_DATA` points the app at a separate settings and cache folder, which the tests use.

macOS builds are signed and notarized automatically when a "Developer ID Application" certificate (or `CSC_LINK`) and Apple notarization credentials are available; otherwise they are unsigned.

## Releasing

Before a public release (spec §24 and §25.2):

- [ ] Bump `version` in `package.json` and write release notes.
- [ ] On macOS, Windows and Linux: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` (Linux under `xvfb-run -a`) and `npm run test:export-build`.
- [ ] `npm run pack` and `npm run test:packaged` on each platform (the script launches the packaged app with no system Node on its `PATH`).
- [ ] Smoke-test every advertised provider live (it costs money): `npm run test:ai` for OpenAI, reading the logged replies as well as the exit code; Anthropic has no live smoke script yet and needs one.
- [ ] Wire-level adapter tests for the OpenAI Responses and Anthropic Messages streams: multi-turn tool loops, each provider's truncation signal (`incomplete`, `max_tokens`), OpenAI's `parallel_tool_calls: false`, rate-limit retries in the orchestrator and the fixer's `tools: []` request.
- [ ] An agent benchmark: a fixed set of graded prompts (targeted copy edit, retheme, add a page with a nav link, a five-page site, fixing a broken code component, a phone-only spacing change) scored on completion, turns, invalid operations, scope violations and a clean project afterwards (spec §24.3).
- [ ] Root `LICENSE` (Apache-2.0) and `CONTRIBUTING.md` present. Exports that redistribute the starter images include `resources/starter-assets/NOTICE.md` (they don't yet); check both the source and static exports.
- [ ] **TODO: signing and notarization.** macOS: a Developer ID Application certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) and notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), then mount the DMG on a second Mac and check the bundled `.app` with `spctl -a -vv` and `xcrun stapler validate`. Windows: an Authenticode certificate for the NSIS installer. Until then builds are ad-hoc signed or unsigned, and Gatekeeper and SmartScreen warn.
- [ ] `npm run dist` on each platform; install the DMG and NSIS installer (and launch the AppImage) on a clean machine, create a project offline, export it and build the export.
- [ ] Tag the release (`vX.Y.Z`) on `main`.
- [ ] **The rest of CI.** Pull requests run the unit tests on Linux (`.github/workflows/ci.yml`), and nothing runs on a push to `develop`. `2aa4206` removed the earlier CI (typecheck, unit tests, packaged smoke on macOS, Windows and Linux) and the tag-triggered release workflow while the repository was private; the release workflow, the other platforms and full `test:e2e` jobs for macOS and for Linux under `xvfb-run` are still to come. Until then, the full suites run in the local macOS stabilization pass, and the checks above run by hand.

## Architecture

| Folder | Responsibility |
| --- | --- |
| `src/shared` | Document types, the style property registry, routes, the typed operation union (zod) and the IPC contract. |
| `src/engine` | Applies operations to the canonical documents, validates references, handles component forks and theme switching. |
| `src/generator` | Deterministic generation of Svelte routes, components and CSS from the documents. The instrumented variants used for editor selection are never written into the project source. |
| `src/catalogue` | The built-in themes (Foundation, and Signal over Foundation's contracts) as static data: tokens, base CSS and component definitions. It is kept separate so it can move to the `siteorigin-builder-components` repository. |
| `src/runtime` | The utility-process worker that runs the project's Vite (dev server and builds), and the preview bridge injected in memory. |
| `src/agent` | Provider adapters (OpenAI Responses, Anthropic Messages), tools, context assembly and the run orchestrator. |
| `src/main` | Electron main process: windows, IPC authorisation, project sessions (journal, history, locks), credentials, export. |
| `src/renderer` | The React editor. |
| `templates/sveltekit-brochure` | The pinned SvelteKit 3 / Svelte 5 / Vite 8 starter with its lock file. |

Editor components (React) and website components (Svelte, generated from the theme's definitions) never mix. The editor talks to the website only through the bounded preview bridge, and all writes, manual or AI, go through the same validated operations.

## Licence

SiteOrigin Builder is licensed under Apache-2.0. The Foundation, Editorial and Signal themes, whose components are copied into every exported website, are licensed under MIT-0, so a site owner needs no attribution or licence file for the theme code. Icons are from Lucide (ISC). The Inter and Fraunces fonts are under the SIL Open Font License. The starter sample images are original and free to reuse (see `resources/starter-assets/NOTICE.md`).
