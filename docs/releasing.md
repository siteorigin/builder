# Releasing

Before a public release (spec §24 and §25.2):

- [ ] Bump `version` in `package.json` and write release notes.
- [ ] On macOS, Windows and Linux: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` and `npm run test:export-build`. On Linux without a display, run these two and `npm run test:packaged` (below) under `xvfb-run -a`.
- [ ] `npm run pack` and `npm run test:packaged` on each platform (the script launches the packaged app with no system Node on its `PATH`).
- [ ] Smoke-test every advertised provider live (cloud runs cost money): `npm run test:ai` for OpenAI, reading the logged replies as well as the exit code; for Anthropic, which has no live smoke script of its own, `npm run eval:agent -- --live --provider anthropic --model claude-sonnet-5-5` with `ANTHROPIC_API_KEY` set (it only prints the estimated cost until you add `--yes`). For a local model, start its server and run `npm run eval:agent -- --live --provider local`.
- [ ] Run the agent benchmark (`npm run eval:agent`, spec §24.3; free with its scripted adapter, live as above). The wire-level adapter tests run as part of `npm test`.
- [ ] Root `LICENSE` (Apache-2.0) and `CONTRIBUTING.md` present. Exports that redistribute the starter images include `resources/starter-assets/NOTICE.md`: the source export does, the static export doesn't yet.
- [ ] **TODO: signing and notarization.** macOS: a Developer ID Application certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) and notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), then mount the DMG on a second Mac and check the bundled `.app` with `spctl -a -vv` and `xcrun stapler validate`. Windows: an Authenticode certificate for the NSIS installer. Until then builds are ad-hoc signed or unsigned, and Gatekeeper and SmartScreen warn.
- [ ] `npm run dist` on each platform; install the DMG and NSIS installer (and launch the AppImage) on a clean machine, create a project offline, export it and build the export.
- [ ] Tag the release (`vX.Y.Z`) on `main`.
- [ ] **CI.** Pull requests run one check, `Unit tests` (`npm ci` and the unit tests the pull request can affect, on Linux, `.github/workflows/ci.yml`). Typecheck, e2e, build and packaged smoke on other platforms run in the local macOS stabilization pass and by hand, as above. There is no tag-triggered release workflow yet.

macOS builds are signed with a "Developer ID Application" certificate (or `CSC_LINK`) when one is available, and notarized when Apple notarization credentials are also set. Without a certificate they are only ad-hoc signed; notarization also needs the credentials.
