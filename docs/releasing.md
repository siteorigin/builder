# Releasing

A release is shipped by the `release` skill (`.agents/skills/release/`): run `/release` in Claude Code, optionally with the version (`/release 0.2.0`). After one question about the version it runs unattended:

1. **Pin and cut.** It pins `origin/develop` and cuts `release/vX.Y.Z` in its own worktree.
2. **Prove before tagging.** It dry-runs every OS whose packaging, signing, release scripts or dependencies changed since the last tag without a green dry run that built them (every OS for the first release, unless one already has), while analyst agents write the changelog from the PRs since the last tag (the first release's notes come from the README instead).
3. **Merge, tag, push.** It writes the `CHANGELOG.md` section, merges into `main` and back into `develop`, tags `vX.Y.Z`, and pushes all three together.
4. **Watch and recover.** It watches the three release workflows until every update feed carries the new version, recovering from failures with one restart as the plan (a second only for a failure the first couldn't have carried).
5. **Publish the notes.** It creates the GitHub Release with the changelog section.

The skill's `SKILL.md` and `references/ci-and-recovery.md` are the detailed runbook.

## Before a release, by hand

The skill proves the release pipeline; these need a person:

- [ ] The local stabilize pass (`/stabilize`) is green on the commit being released: typecheck, the whole unit suite with the browser tests, e2e, the build and the packaged smoke, on macOS.
- [ ] Smoke-test every advertised provider live (cloud runs cost money): `npm run test:ai` for OpenAI, reading the logged replies as well as the exit code; for Anthropic, which has no live smoke script of its own, `npm run eval:agent -- --live --provider anthropic --model claude-sonnet-5-5` with `ANTHROPIC_API_KEY` set (it only prints the estimated cost until you add `--yes`). For a local model, start its server and run `npm run eval:agent -- --live --provider local`.
- [ ] Run the agent benchmark (`npm run eval:agent`, spec §24.3; free with its scripted adapter, live as above).
- [ ] Root `LICENSE` (Apache-2.0) and `CONTRIBUTING.md` present. Exports that redistribute the starter images include `resources/starter-assets/NOTICE.md`: the source export does, the static export doesn't yet.

And after it:

- [ ] Download each installer from `https://downloads.siteorigin.com/releases/` on a clean machine, install it, create a project (on macOS the first project downloads the build tools' native parts), export it and build the export. On a second Mac, `scripts/release/verify-macos.sh D9674SJ8J4 <dmg>` checks a downloaded DMG the way the workflow did.

## The release workflows

A `vX.Y.Z` tag starts three independent workflows. Each runs the whole unit suite (no browser, `--retry=3`; e2e stays in the stabilize pass), builds its OS's installers, and publishes them the moment its own run is green:

| Workflow | Builds | Feed |
| --- | --- | --- |
| `release-macos.yml` | For arm64 (`macos-15`) and x64 (`macos-15-intel`): a Developer ID signed, notarized and stapled DMG, and an update zip holding the same signed, notarized and stapled app, each verified | `latest-mac.yml`, listing both zips |
| `release-linux.yml` | An x64 AppImage | `latest-linux.yml` |
| `release-windows.yml` | An x64 NSIS installer, not Authenticode-signed yet | `latest.yml` |

A manual run with `dry_run` does everything but publish: `gh workflow run release-macos.yml --ref <branch> -f dry_run=true`.

Publishing (`.github/actions/publish-release`) uploads to the R2 bucket `siteorigin-builder-updates`, served at `https://downloads.siteorigin.com/`, in an order that never advertises a missing file:

1. **Version gate.** It refuses a version that isn't newer than the live feed's. An equal version means the OS already published it, and nothing is uploaded again.
2. **Installers first.** It uploads the installers under `releases/`, cached for good, and checks each is served at its full size.
3. **Feed last.** It uploads the feed's metadata, never cached, and checks the domain serves exactly that file.
4. **Website.** It tells the website to read the new feed, when that's set up.

A `vX.Y.Z-rc.N` or `-beta.N` tag publishes to `rc-*.yml` or `beta-*.yml` instead of `latest-*`. The feed files follow electron-updater's format and naming, and every build bundles the feed's address (`resources/app-update.yml`), ready for an in-app updater.

## One-time setup

Repository secrets (Settings, Secrets and variables, Actions):

| Secret | Value |
| --- | --- |
| `MAC_CERTS` | The Developer ID Application `.p12`, base64-encoded |
| `MAC_CERTS_PASSWORD` | The `.p12` password |
| `APPLE_API_KEY` | The contents of the App Store Connect API key's `AuthKey_<id>.p8` |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the key list in App Store Connect, Users and Access, Integrations |
| `APPLE_TEAM_ID` | `D9674SJ8J4` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | An R2 API token with Object Read & Write on `siteorigin-builder-updates` only (Cloudflare, R2, Manage R2 API Tokens) |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | `siteorigin-builder-updates` |
| `WEBSITE_WEBHOOK_SECRET` | Optional: the bearer token the website's refresh-releases endpoint checks |

And one repository variable, optional: `WEBSITE_REFRESH_URL`, the website endpoint each publish POSTs to so it reads the new feed. Without it and the secret, the step skips with a notice.

The bucket is set up like Daintree's: location ENAM, Standard storage, the default rule that aborts incomplete multipart uploads after 7 days, the `r2.dev` URL off, and the custom domain `downloads.siteorigin.com` on the `siteorigin.com` zone.

## Signing

Only macOS is signed. Windows has no Authenticode certificate yet, so SmartScreen warns on the installer; AppImages are not signed.

The macOS workflow signs with the "Developer ID Application: Greg Priday (D9674SJ8J4)" certificate and notarizes with an App Store Connect **Team** API key (an individual key can't authenticate `notarytool`). Its build jobs fail before building if any of the six signing secrets is missing.

Locally, `npm run dist` signs with the Developer ID identity when it is in the keychain, or with `CSC_LINK` (the `.p12` path) and `CSC_KEY_PASSWORD`, and notarizes and staples the **app** when `APPLE_API_KEY` (the `.p8` path), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set. The DMG around it gets its own ticket only in the workflow; to do it locally, run the workflow's `xcrun notarytool submit <dmg> --wait --key <p8> --key-id <id> --issuer <issuer>` and `xcrun stapler staple <dmg>`. Without a certificate a macOS build is only ad-hoc signed. `scripts/release/verify-macos.sh --signed-only <team-id> dist/*.dmg dist/*.zip` checks a build signed without notarization.
