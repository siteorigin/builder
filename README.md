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
- **Components.** The Foundation theme provides 18 section families plus basics.
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

Requires Node 22.22+ (only for developing the app; the packaged app bundles everything it needs).

```sh
npm install
npm run dev          # start the app with hot reload
npm test             # unit and integration tests (engine, generator, themes, agent harness, sessions)
npm run test:e2e     # drive the real app with Playwright (set SHOTS and WORK to scratch folders)
npm run test:packaged # after `npm run pack`: create and preview a project with no system Node on PATH
npm run pack         # build an unpacked app into dist/
npm run dist         # build installers
```

In development builds, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment are used when no key is saved in Settings. Packaged builds only use keys stored with the operating system keychain. `SITEORIGIN_USER_DATA` points the app at a separate settings and cache folder, which the tests use.

macOS builds are signed and notarized automatically when a "Developer ID Application" certificate (or `CSC_LINK`) and Apple notarization credentials are available; otherwise they are unsigned.

## Architecture

| Folder | Responsibility |
| --- | --- |
| `src/shared` | Document types, the style property registry, routes, the typed operation union (zod) and the IPC contract. |
| `src/engine` | Applies operations to the canonical documents, validates references, handles component forks and theme switching. |
| `src/generator` | Deterministic generation of Svelte routes, components and CSS from the documents. The instrumented variants used for editor selection are never written into the project source. |
| `src/catalogue` | The Foundation theme as static data: tokens, base CSS and component definitions. It is kept separate so it can move to the `siteorigin-builder-components` repository. |
| `src/runtime` | The utility-process worker that runs the project's Vite (dev server and builds), and the preview bridge injected in memory. |
| `src/agent` | Provider adapters (OpenAI Responses, Anthropic Messages), tools, context assembly and the run orchestrator. |
| `src/main` | Electron main process: windows, IPC authorisation, project sessions (journal, history, locks), credentials, export. |
| `src/renderer` | The React editor. |
| `templates/sveltekit-brochure` | The pinned SvelteKit 3 / Svelte 5 / Vite 8 starter with its lock file. |

Editor components (React) and website components (Svelte, generated from Foundation definitions) never mix. The editor talks to the website only through the bounded preview bridge, and all writes, manual or AI, go through the same validated operations.

## Licence

GPL-3.0-or-later. Icons are from Lucide (ISC). The Inter and Fraunces fonts are under the SIL Open Font License. The starter sample images are original and free to reuse (see `resources/starter-assets/NOTICE.md`).
