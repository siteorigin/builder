# CI and recovery

How the release workflows fit together, how to wait on them, how to get from a red job to a proven fix quickly, and how to restart once.

## The three workflows

`release-macos.yml`, `release-linux.yml` and `release-windows.yml` each run a full vertical slice for one OS, triggered by a `v*` tag push or by `workflow_dispatch` with `dry_run=true`. They are independent: each publishes the moment its own run is green.

| OS | Job chain (timeout) | Notes |
| --- | --- | --- |
| macOS | `unit-tests` (45m, ubuntu) → `build` arm64 on `macos-15` and x64 on `macos-15-intel` (90m each: package, sign, notarize and staple the app; notarize and staple the DMG; verify the DMG and the update zip) → `assemble` (15m, ubuntu: both architectures' files and `latest-mac.yml`) → `publish` (20m) | Each architecture builds natively so `npm ci` installs that architecture's native image library. Two Apple round trips per architecture make macOS the long pole |
| Linux | `unit-tests` → `build` (60m, ubuntu: the x64 AppImage and `latest-linux.yml`) → `publish` | The AppImage carries its blockmap inside it |
| Windows | `unit-tests` → `build` (60m, windows-latest: the x64 NSIS installer and `latest.yml`) → `publish` | Not Authenticode-signed yet: SmartScreen warns |

The unit job is the whole suite, not the slice of it PR CI runs, without a browser (the tests that need Chromium skip themselves), with `--retry=3`: the suite has timing-sensitive tests that fail now and then on a busy runner. A clean run takes about 40 minutes on Linux and Windows and about an hour on macOS; a dry run takes the same minus publishing.

What publishing does (`.github/actions/publish-release`): checks the four R2 secrets are set, checks the version is strictly greater than the live feed (`scripts/release/check-version-monotonic.ts`), uploads the installers to R2 first with immutable caching, checks each is served at its full size (`verify-r2-uploads.ts`), uploads the feed's metadata last with no-cache headers, checks the download domain serves exactly that file (`verify-r2-metadata.ts`), then notifies the website. Two consequences that shape every recovery decision:

- **An OS that already published a version never republishes it.** The version gate treats an equal live version as "already published" and skips the upload (the website notify still runs, harmlessly). Re-tagging can't replace an OS's published build.
- **Dry runs publish nothing.** `publish` requires a tag ref and `dry_run != true`. Signing and notarization do run in a dry run, on purpose.

Concurrency: each workflow's group is `release-<os>-<ref>-release` for tag runs (`cancel-in-progress: false`), so a second run on the same tag queues behind the first. Dry runs get a unique group per run.

## Waiting

Stay in the turn; never end it to wait. Wait in the foreground (Bash timeout 600000), repeated until it exits 0:

```bash
node .agents/skills/release/scripts/watch-runs.mjs --runs <id>,<id>,<id> --minutes 9 --version X.Y.Z
```

It polls every 45 seconds, bounds every request, retries API and network errors instead of reporting them as failures, and prints each run's job progress, its failed or cancelled jobs and the three feeds. Exit 0: every run is terminal. Exit 4: a job failed or was cancelled since the call started; triage it now while the runs carry on, then keep watching. Exit 3: the window ended; call it again. If it reports the API unreachable for half an hour straight, stop and report where things stand rather than waiting blind.

Track publication per feed: `latest-mac.yml`, `latest-linux.yml` and `latest.yml` (Windows). Read all three before every recovery decision; the choice depends on them.

## Triage

The moment `watch-runs.mjs` shows a failed job:

```bash
node .agents/skills/release/scripts/run-failures.mjs --run <id> --out "${W}/failures"
```

It works while the run is still going. For each job of the latest attempt that failed, hit its timeout or never got a runner, it says why it ended (a job that hits `timeout-minutes` reports `cancelled`, as does one GitHub never assigned a runner; the script tells them apart from the annotations) and then:

- **Unit jobs:** the vitest failure blocks and summary, and the slowest test files. A summary showing every test passed in a job that hit its timeout means the job ran out of time, not that a test failed.
- **Anything else** (a build, signing, notarization, verification or publish step): the 40 log lines before the error. For a notarization rejection, the log holds Apple's JSON report with every rejected file's path and reason.

`--job <id>` analyses one job whatever its outcome, for the slowest files of a green unit job.

Jobs cancelled because a dependency failed, or by a person, are listed together at the end and need nothing.

Then sort each failure into one of the kinds below.

### Infrastructure: rerun

The failure isn't about the code. Wait for the run to finish (a job can't be rerun while its run is in progress), then `gh run rerun <id> --failed` and watch again. Never re-tag for one of these.

| Signature | Where |
| --- | --- |
| `stapler staple` or `stapler validate` fails with -1005 / "network connection lost" / exit 68, or `notarytool` network errors after the submission was Accepted | macOS `build` (the DMG staple already retries three times; a failure that survives that is still Apple's side) |
| Runner lost communication, provisioning failed, "The job was not acquired by Runner of type hosted even after multiple attempts" (macOS capacity), "The operation was canceled" with no failing step, `npm ci`, Playwright or artifact download network errors, GitHub API 5xx | any |
| A unit test that failed all four of its tries on one OS's run with a timing error, and passed in the other OSes' runs on the same commit | `unit-tests` |
| The R2 upload or a download-domain check failing with a 5xx or a timeout, with the R2 secrets set | `publish` (the checks retry; rerunning `publish` alone is safe, since the version gate skips what already went up only when the metadata is live) |

Rerun the same job at most twice. A third failure with the same signature is real. A unit job that hit its timeout is not a flake when its summary shows the suite simply ran long: the suite has outgrown the job (see Known traps).

### Stop: needs a person

Some failures no rerun or code change can fix. Stop and report (SKILL.md "When you stop early"):

- Notarization rejected with **403 "required agreement missing or expired"**: someone has to accept the updated Apple Developer agreement. Once they say it's signed, `gh run rerun <id> --failed` picks up where it stopped.
- Signing certificate or API key expired or revoked (`errSecInternalComponent` that persists across a rerun, "certificate has expired", `notarytool` 401).
- An R2 secret missing ("The R2_… secret is not set") or rejected (`aws s3 sync` with AccessDenied or InvalidAccessKeyId).

### Real: fix it

A deterministic test failure, a notarization rejection that names files, a build or packaging error the code caused, a verification step that rejects what was built, a job that outgrew its timeout, a workflow config error (`startup_failure`). Check Known traps first.

## Reproduce locally

A fix pushed blind costs an hour per guess. Before pushing one, make the failure happen where you can iterate, and make it pass there. `FIX_REF` below is the branch holding the fix: `release/vX.Y.Z` before the tag, `release-fix/vX.Y.Z` after it.

- **Unit tests:** `npx vitest run <the failing files>` in `WT`, on the fix branch.
- **A packaging or signing failure:** build the failing OS's installer locally where you can. On a Mac, `npm run dist -- --mac --arm64 --publish never`, with `CSC_LINK` and `CSC_KEY_PASSWORD` set for a signed build, then `scripts/release/verify-macos.sh --signed-only <team-id> dist/*.dmg dist/*.zip`. Notarization needs the App Store Connect key (`docs/releasing.md`), so prove a notarization fix with a dry run instead: `gh workflow run release-macos.yml --ref "${FIX_REF}" -f dry_run=true`, watched to green after checking the run's `headSha` is the fix commit.
- **Windows and Linux build failures:** a dry run of that OS on `FIX_REF`.
- **Workflow changes:** check they lint (`uvx --from actionlint-py actionlint .github/workflows/release-*.yml`), then a dry run of every OS the change reaches.

## Restart: one restart, carrying every fix

1. **Let every run of the release finish.** Keep triaging and fixing while they run, but don't restart anything until every run on the tag is terminal. A failed run can't publish, but its remaining jobs keep finding failures, and the restart has to carry all of them. Never move the tag while any run on it is still going, even a passing one that has nearly published: its later jobs check out the tag by ref and refuse the moved commit.
2. **Put every fix on one branch.** Before the tag (a dry run failed), that's `release/vX.Y.Z` itself. After the tag, cut one from it: `git checkout -b release-fix/vX.Y.Z vX.Y.Z`. Each fix is committed through the `commit` skill (it pushes the branch). One branch means `main` receives the fixes and nothing else from `develop`.
3. **Prove every fix** as "Reproduce locally" says, before restarting.
4. **Read all three feeds**, then pick the restart:

| Situation | Do |
| --- | --- |
| Dry run failed | Re-dispatch on the release branch's new head every OS the fix can reach: just the failing OS for a fix only it builds; every OS for a change to shared tests, workflows, dependencies or packaging. |
| Tag run failed, **no feed has published** `vX.Y.Z` | Re-tag. |
| Tag run failed, some feeds published, and the fix touches only tests, CI, or code that runs only on the unpublished feeds' platforms | Re-tag. Each OS whose feed is published gets its new run cancelled: it would rebuild and then skip the upload. |
| Tag run failed, some feeds published, and the fix changes code the published feeds' users run | Patch release. Their `vX.Y.Z` is final. |

### Re-tag

In `WT`, with every fix proven on `release-fix/vX.Y.Z` and every old run terminal:

```bash
set -euo pipefail
git fetch origin
git checkout --detach origin/main
git merge --no-ff release-fix/vX.Y.Z -m "chore(release): merge release fix into main for vX.Y.Z"
test "$(node -p "require('./package.json').version")" = "X.Y.Z"
git tag -f -a vX.Y.Z -m "Release vX.Y.Z"
MAIN=$(git rev-parse HEAD)
git checkout --detach origin/develop
git merge --no-ff "${MAIN}" -m "chore(release): merge release fix for vX.Y.Z into develop"
DEV=$(git rev-parse HEAD)
git push --atomic origin "${MAIN}:refs/heads/main" "${DEV}:refs/heads/develop" "+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z" > "${W}/push.log" 2>&1 || { cat "${W}/push.log"; exit 1; }
test "$(git ls-remote origin "refs/tags/vX.Y.Z^{}" | cut -f1)" = "${MAIN}"
git push origin --delete release-fix/vX.Y.Z
```

The `+` forces only the named tag; `main` and `develop` stay fast-forward-only, and `--atomic` moves all three or none. Never `--tags --force`. A rejected push means `main` or `develop` moved: run the block again from the top.

The tag push starts three fresh runs on the new commit. Resolve their IDs (`gh run list --workflow=<wf> --event push --limit 3`, matching `headBranch == vX.Y.Z` and `headSha == ${MAIN}`), cancel the run of any OS whose feed is published, and watch the rest. Never rerun an old run after a re-tag: a rerun keeps its original commit, which the tag no longer points at. Post what failed, the fix commits, and what restarted.

### Patch release

A gitflow hotfix: `X.Y.(Z+1)` is `X.Y.Z` plus the fix and nothing else from `develop`. No question to the user; the version is determined.

1. With every `vX.Y.Z` run terminal and `vX.Y.Z` left where it is, on `release-fix/vX.Y.Z` in `WT`: `npm version X.Y.(Z+1) --no-git-tag-version`, and add a short `CHANGELOG.md` section above `## [X.Y.Z]`: an intro saying what was wrong with `X.Y.Z` and on which platforms, and the fix under Bug Fixes. Commit `chore(release): release vX.Y.(Z+1)`.
2. Run the Phase 4 step 4 block from SKILL.md with `release-fix/vX.Y.Z` in place of `release/vX.Y.Z` and `X.Y.(Z+1)` as the version. The develop merge resolves `CHANGELOG.md` the same way: `develop`'s Unreleased entries first, then `X.Y.(Z+1)`, then `X.Y.Z` and the rest in order. Then delete the fix branch on origin.
3. Watch all three runs as in Phase 5. Every feed takes the patch, including those already on `X.Y.Z`, since it's a greater version; a feed that never got `X.Y.Z` goes straight to `X.Y.(Z+1)`, which the version gate allows.
4. Create GitHub Releases for both versions; the `X.Y.Z` notes stay as written.

## Retry budget

One restart is the plan. A second is allowed only for a failure the first could not have carried (it lives in a job the failed runs never reached); three is the hard limit, counting re-tags, patch releases and dry-run fix cycles together. Reruns of infrastructure failures don't count, but any one job gets two at most. Every restart past the first is reported with the failure and why the earlier one couldn't have caught it. When the budget runs out, or a fix needs a product decision you can't make from the code (reverting a feature, changing what ships), stop and report per SKILL.md "When you stop early".

## Known traps

These came out of real runs. Check them before investigating from scratch.

- **Apple's notary opens archives inside the app.** It unpacked the npm cache bundled in `Resources/npm-cache` and rejected the app over the website starter's native packages, signed only by their publishers. The Mac app now leaves the starter's macOS-only packages out of that cache (`build/strip-mac-cache.cjs`), and the build fails if any Mach-O is left in it. A new starter dependency that ships Mac code without an `os` field fails there, before Apple: strip it the same way.
- **A symlink in the bundle fails `codesign --strict`** with "invalid destination for symbolic link in bundle". Node 24's `cpSync` kept npm's `.bin` links, rewritten to point into the build checkout; `build/copy-npm.cjs` copies npm without links. Anything else that copies into the app must do the same.
- **The x64 build runs on `macos-15-intel`.** GitHub plans to retire its Intel macOS images; when that one goes, the x64 build needs a new home (cross-building on Apple silicon needs the x64 native image library installed alongside).
- **The unit suite outgrows its job.** It runs whole on one Linux runner in about 20 of its 45 minutes. Readiness checks the headroom from the last run; the fix is a split or a faster slow file, never a higher timeout.
- **Runner image changes break toolchains.** When a build or install step fails on something the code didn't change, compare the runner image version in the job's "Set up job" log with the last green release run before blaming the code; the fix goes in the workflow.
- **A moved tag breaks runs still in flight.** Jobs that check out the tag later in a run (`assemble`, `publish`) refuse it once a re-tag has moved it. Re-tag only when every run on the tag is terminal.
- **zsh modifiers in refspecs.** `"$MAIN:refs/heads/main"` is `$MAIN` with the `:r` modifier in zsh. Always brace: `"${MAIN}:refs/heads/main"`.
- **A pipe hides a failed push.** `git push … | tail` exits 0 when the push fails, and the next line (deleting a branch) runs anyway. Push to a log file and check the exit code, then confirm with `ls-remote`.
- **`gh run watch` exits on a dropped connection** with a non-zero code that reads as a failed run. Use `watch-runs.mjs`.
- **A job that hits its timeout reports `cancelled`, not `failure`**, so a filter on `conclusion == "failure"` misses it. `run-failures.mjs` reads the annotation.
