# Releasing

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
- [ ] **Deferred until the project is open-sourced:** restore CI. `2aa4206` removed the GitHub Actions CI (typecheck, unit tests, packaged smoke on macOS, Windows and Linux) and the tag-triggered release workflow while the repository is private. When it opens, restore both and add full `test:e2e` jobs for macOS and for Linux under `xvfb-run`. Until then, the full suites run in the local macOS stabilization pass, and the checks above run by hand.

macOS builds are signed and notarized automatically when a "Developer ID Application" certificate (or `CSC_LINK`) and Apple notarization credentials are available; otherwise they are unsigned.
