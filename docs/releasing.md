# Releasing

Before a public release (spec §24 and §25.2):

- [ ] Bump `version` in `package.json` and write release notes.
- [ ] On macOS, Windows and Linux: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` and `npm run test:export-build`. On Linux without a display, run these two and `npm run test:packaged` (below) under `xvfb-run -a`.
- [ ] `npm run pack` and `npm run test:packaged` on each platform (the script launches the packaged app with no system Node on its `PATH`).
- [ ] Smoke-test every advertised provider live (cloud runs cost money): `npm run test:ai` for OpenAI, reading the logged replies as well as the exit code; for Anthropic, which has no live smoke script of its own, `npm run eval:agent -- --live --provider anthropic --model claude-sonnet-5-5` with `ANTHROPIC_API_KEY` set (it only prints the estimated cost until you add `--yes`). For a local model, start its server and run `npm run eval:agent -- --live --provider local`.
- [ ] Run the agent benchmark (`npm run eval:agent`, spec §24.3; free with its scripted adapter, live as above). The wire-level adapter tests run as part of `npm test`.
- [ ] Root `LICENSE` (Apache-2.0) and `CONTRIBUTING.md` present. Exports that redistribute the starter images include `resources/starter-assets/NOTICE.md`: the source export does, the static export doesn't yet.
- [ ] Push the tag (`vX.Y.Z`, matching `package.json`). `.github/workflows/release.yml` runs the whole unit test suite (not e2e), then builds a signed, notarized and stapled DMG for each Mac architecture (on Apple silicon and Intel runners), an NSIS installer for Windows and an AppImage for Linux, and attaches them to a **draft** GitHub release (a re-run fills in the same draft, and never touches a published release). Running the workflow by hand builds the same installers as workflow artifacts, with no release.
- [ ] On a second Mac, run `scripts/release/verify-macos.sh D9674SJ8J4 <dmg>` on each downloaded DMG (it mounts the DMG itself, and needs internet access to validate the tickets). The workflow runs the same checks.
- [ ] Install the DMG and NSIS installer (and launch the AppImage) from the draft release on a clean machine, create a project offline (on macOS the first project needs a network for the build tools' native parts), export it and build the export. Then publish the release.
- [ ] **CI.** Pull requests run one check, `Unit tests` (`npm ci` and the unit tests the pull request can affect, on Linux, `.github/workflows/ci.yml`). Typecheck, e2e, build and packaged smoke on other platforms run in the local macOS stabilization pass and by hand, as above. Version tags also run the release workflow above.

## Signing

Only macOS is signed. Windows has no Authenticode certificate yet, so SmartScreen warns on the installer; AppImages are not signed.

The release workflow signs with the "Developer ID Application: Greg Priday (D9674SJ8J4)" certificate and notarizes with an App Store Connect **Team** API key (an individual key can't authenticate `notarytool`). The macOS jobs fail before building if any of these repository secrets is missing; Windows and Linux need none:

| Secret | Value |
| --- | --- |
| `MAC_CERTS` | The Developer ID Application `.p12`, base64-encoded |
| `MAC_CERTS_PASSWORD` | The `.p12` password |
| `APPLE_API_KEY` | The contents of the App Store Connect API key's `AuthKey_<id>.p8` |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the key list in App Store Connect, Users and Access, Integrations |
| `APPLE_TEAM_ID` | `D9674SJ8J4` |

Locally, `npm run dist` signs with the Developer ID identity when it is in the keychain, or with `CSC_LINK` (the `.p12` path) and `CSC_KEY_PASSWORD`, and notarizes and staples the **app** when `APPLE_API_KEY` (the `.p8` path), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set. The DMG around it gets its own ticket only in the workflow; to do it locally, run the workflow's `xcrun notarytool submit <dmg> --wait --key <p8> --key-id <id> --issuer <issuer>` and `xcrun stapler staple <dmg>`. Without a certificate a macOS build is only ad-hoc signed. `scripts/release/verify-macos.sh --signed-only <team-id> dist/*.dmg` checks a build signed without notarization.
