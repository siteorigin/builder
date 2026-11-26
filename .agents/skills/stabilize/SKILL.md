---
name: stabilize
disable-model-invocation: true
description: "USE ONLY WHEN EXPLICITLY INVOKED — by a human with /stabilize (Claude Code) or $stabilize (Codex). Never auto-select or run this proactively: not after adding a feature, fixing a bug, or finishing a task, not as an ad-hoc health check, and not as a step inside another workflow. This is a deliberate, expensive workflow, and it is the only place the merged develop tree is fully tested: CI runs only the unit tests, on Linux, for pull requests, and individual changes run only the tests that cover them. Once started, it drives SiteOrigin Builder to a fully green, stable state across every check we can run on this Mac: typecheck, the Vitest unit suite, the production build, every Playwright/Electron e2e script except the paid live-AI one, and the packaged-app smoke. Local only, macOS only, for now: it drives no GitHub Actions, and its own Linux and Windows stages come later. It attributes every failure to the commit on develop that caused it, fixes real failures in batches, re-validates each fix with the narrowest run that proves it, and lands the fixes as one squashed commit on develop."
---

# Stabilize

> **Run this ONLY when explicitly invoked** by a human with `/stabilize` (Claude Code) or `$stabilize` (Codex). Stabilize is a deliberate, expensive workflow, not an ad-hoc health check and not a finishing step. Do NOT trigger it proactively: not after adding a feature, not after fixing a bug, not on completing a task, and not as a stage folded into another workflow. The frontmatter sets `disable-model-invocation: true`, so the model cannot auto-select it. If you are here because you just finished some other work, that is not a reason to stabilize — stop.

Drive the SiteOrigin Builder tree to green and keep it there. Work lands on `develop` directly or through pull requests, often from several agents in parallel, and each change runs only typecheck plus the tests that cover it (see `CLAUDE.md`); a pull request's CI adds the unit suite on Linux, and nothing runs on `develop` itself. So this run is the first time the merged tree meets the whole surface, and a failure here is usually a commit that was green on its own: part of the job is finding which commit and why its own checks missed it (see **Find the commit that broke it**).

An agent runs the whole surface, reads the results, tells flakes apart from real regressions, re-runs intelligently, fixes the real failures, and reports only when the work is actually done. All the work happens on a dedicated stabilize branch off `origin/develop`. The job is complete only when the full local gate is green AND, if any fixes were made, they have been squashed into a single commit, fast-forwarded into `develop`, and pushed to origin, with the working tree left back on `develop`. A run that needed no fixes commits nothing and simply deletes its branch.

**Scope today: local, macOS only.** Pull-request CI (`.github/workflows/ci.yml`, the unit tests on Linux) is not this skill's; its own Linux and Windows stages come later. Do not create or change `.github/workflows`, dispatch runs, or drive the Windows test laptop or a Linux container from this skill.

**A clean run lands nothing.** Stabilization commits exist to carry real fixes. If the whole surface passes without you changing a file, there is nothing to commit and nothing to merge. Never manufacture an empty or marker commit; `git commit --allow-empty` is banned in this skill.

## What "stabilize" covers

Every check this Mac can run:

- `npm run typecheck`
- `npm test` — the whole Vitest unit suite (`tests/unit/`)
- `npm run build` — electron-vite production build (e2e launches the BUILT app from `out/`, so this also refreshes what e2e tests)
- `npm run test:e2e`, plus every other e2e script wired into `package.json` (`test:e2e*`) and every functional script in `tests/e2e/` (for example `tour.mjs`, export/portability tests). Read `package.json` and `tests/e2e/` at the start of the run; the list grows.
- `npm run pack` then `npm run test:packaged` — the packaged app creates and previews a project with no system Node on PATH.

Not covered unless the human asks:

- `tests/e2e/ai.mjs` and anything else that calls a live AI provider. It costs real money; the fake-adapter unit tests cover the harness.
- `tests/e2e/linux-container.mjs` (a Linux stage, deferred).
- Screenshot-only design captures (`tests/e2e/design/`, `design-capture.mjs`) that assert nothing. Run them only if they are broken scripts someone relies on, and fix crashes, not pixels.

## Core rules

- Always work on a separate branch based on `origin/develop`; never stabilize directly on `develop`.
- Keep the branch focused on stabilization. No unrelated cleanup, dependency upgrades or feature work.
- **No empty or marker commits, ever.**
- Prefer fixing the app over relaxing tests. Update a test only when it is stale, over-specific, or asserts behaviour the product no longer promises (say so in the report). A flaky test is still a real signal: stabilize it with state-based waits and scoped locators, don't delete it.
- **Every re-run has a price; pay the smallest one that proves the fix.** The full local gate is the one discovery run. After it, re-run only what failed (see **Run budget**).
- **Batch fixes.** Harvest every failure from the discovery run, fix all of them, prove each narrowly, then move on.
- **Triage before you re-run.** Never re-run a failing script hoping for green. Either you fixed something and are re-validating, or you classified the failure as a flake and are confirming it once.
- Before touching production code, read `CLAUDE.md` and preserve its invariants: no keychain, no Builder runtime in exported sites, no AI attribution in commits.
- Do not modify user-owned agent config (`~/.claude`, `~/.codex`, shell hooks).

## Run budget

**One full local gate per run.** That discovery run shows you every failure at once. Everything after it is a scoped re-run.

The re-run ladder — climb only as high as the fix requires:

| Rung | What | Use when |
| --- | --- | --- |
| 1 | one unit file (`npx vitest run tests/unit/<file>`) or one e2e script (`node tests/e2e/<script>.mjs`) | always first |
| 2 | the owning surface: `npm test`, or the `npm run test:e2e` chain | a production-code fix plausibly reaches the rest of that surface |
| 3 | the full local gate again | rare: a production fix with a blast radius you cannot name |

Before you reach for rung 3, name what it could find that rung 2 cannot; if you can't, don't.

**E2E runs against the built app.** After any fix that touches `src/`, run `npm run build` once per batch before re-running e2e scripts, or the "proof" passes against the old bundle. A packaged-smoke failure needs `npm run pack` again after the fix.

**Flakes are cheap to confirm and expensive to chase.** A failure with a timing shape (locator timeout, element detached, slow preview start, port contention) that passes one clean isolated re-run is a flake: note it and move on. Credible product evidence — a crash, an unhandled rejection, an IPC error, a generator/compile error — is never a flake, even if a later run passes. Harden a script only if it flaked in two separate runs.

## Long-running loop discipline

Keep the working log in conversation context. If a durable handoff is needed, write `.tmp/stabilize-<branch>.md` (`.tmp/` is gitignored); never commit it.

Track:

- The branch, its base (`origin/develop` SHA you branched from) and the pushed SHA if any.
- The green ledger: each piece (`typecheck`, `unit`, `build`, each e2e script, `packaged`) and whether it has passed, in the discovery run or a later scoped re-run.
- The attribution window: `last_green_sha` and the branch point, and the commits between them.
- The failure queue: piece, script/test, the commit that caused it (or flake / pre-existing / unattributed), the mechanism in one line, why that commit's own checks missed it, status.
- Narrow validation commands already run.

## The loop

1. **Branch.**

   ```bash
   git fetch origin --prune
   git switch develop && git pull --ff-only origin develop
   git switch -c stabilize/$(date +%Y%m%d) origin/develop   # check the name is unused locally and on origin first
   ```

   If the worktree is dirty before starting, inspect it. Don't overwrite unrelated user changes; stop and ask if they're in the way.

2. **Baseline.** Run the full local gate once and collect every failure before fixing anything. Give e2e scripts unique scratch dirs (`WORK`/`SHOTS` under `.tmp/` or `$TMPDIR`) and don't run two Electron scripts at once.

   ```bash
   npm ci                      # only if package-lock.json changed since node_modules was installed
   npm run typecheck
   npm test
   npm run build
   npm run test:e2e
   # + every other functional e2e script (see "What stabilize covers")
   npm run pack && npm run test:packaged
   ```

3. **Attribute** every failure (see **Find the commit that broke it**). The culprit commit's diff usually names the fix.

4. **Fix the batch.** For each failure, reproduce the narrowest surface, classify it (real or flake), fix the app or the test, and re-run that narrow surface until it is consistently green. One `npm run build` per batch before the e2e re-runs.

5. **Re-validate** only what failed, plus an owning surface when a production fix reaches it. Do not re-run the full gate. Suites that passed in the baseline stay passed unless a production fix reaches them.

6. The run is green when every piece has passed, in the baseline or a scoped re-run. Then go to **Finalization**.

If you report status mid-run, give the branch, the ledger, the failure queue with classifications, and the next action. Never present the work as complete while any piece is red or running.

## Find the commit that broke it

Work lands on `develop` as direct commits and merged pull requests (often several agents' batches), and nothing runs CI on `develop` itself. Every commit in the window was checked only against its own tests, so find the culprit before you fix anything.

**The window.** Keep `.tmp/stabilize-state.json` in the checkout this skill runs from (gitignored): `{"last_green_sha": "<sha>", "at": "<ISO time>"}`. It is the `develop` commit the last fully green run branched from, and it moves only when a run ends green, so a red run's window carries into the next one. With no state file, write one first with the cursor at the commit `develop` was at 24 hours before the branch point:

```bash
cursor=$(git rev-list -1 --first-parent --before="$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" <branch-point>)
```

List the window: `git log --first-parent --format='%h %cI %s' <last_green_sha>..<branch-point>`.

**Attribute each failure:**

1. Name what the failing test exercises: the test file or e2e script, its imports, the selectors it uses, and the source files in the stack trace or error.
2. Find commits in the window that touched those: `git log --format='%h %s' <last_green_sha>..<branch-point> -- <paths>`. Widen to the owning directory (a panel, `src/engine`, the generator, the bridge) when nothing touches the exact files. Renderer label or ARIA changes are the usual cause of e2e selector breaks.
3. Read each candidate: `git show --stat <sha>`, `git show <sha> -- <path>`.
4. Name the cause:
   - **Regression, not covered**: the commit broke it and the change's own checks never ran this test (an e2e script, or a unit test that reaches the code through the filesystem or the generator rather than an import).
   - **Interaction**: two commits each fine alone, broken together (one changed a contract, another added a caller of the old one). Name both.
   - **Flake**: shown by the flake triage.
   - **Pre-existing**: fails the same way at `last_green_sha` (run the narrow repro there in a scratch worktree).
   - **Unattributed**: nothing in the window touches it, it isn't a flake, and it doesn't reproduce at `last_green_sha` (often the environment: Node, a dependency resolved at install, the date). Say so.
5. When it's ambiguous and the repro takes a few minutes, bisect in a scratch worktree instead of guessing: prove the repro fails at the branch point and passes at the good end, then `git bisect start <branch-point> <good>` and `git bisect run <narrow repro>`.

The fix always lands in the stabilize branch; never revert the culprit commit on `develop`. When the same escape repeats across runs (say, renderer copy changes that break e2e selectors), say so in the final report: that's the signal to change how those tests select elements.

## Fixing guidelines

- Stale e2e selectors: prefer roles and accessible names that describe intent, with prefix/regex matching for dynamic labels (`/^Undo\b/`), over brittle exact text or CSS classes.
- Timing flakes: replace fixed `waitForTimeout` sleeps with state-based waits (a selector, a file on disk, a snapshot value from `window.builder`).
- Assertions: every e2e step that matters must assert (`node:assert/strict`) so a failure exits non-zero. A script that only logs is a bug in the script.
- If a script passes alone but fails in the chain, suspect shared scratch dirs, a leaked Electron or Vite process, port reuse, or leftover project locks.
- Unit tests: test behaviour and computed output, not literals copied from the source.

## Finalization

Decide from the diff, not from memory:

```bash
git fetch origin develop
git diff --quiet origin/develop...HEAD && echo "NO CHANGES — Case 1" || echo "FIXES PRESENT — Case 2"
```

In both cases, once every piece is green, record where the next window starts, using the SHA you branched from (not a later rebase tip):

```bash
mkdir -p .tmp && printf '{"last_green_sha":"%s","at":"%s"}\n' "<branch-point-sha>" "$(git show -s --format=%cI <branch-point-sha>)" > .tmp/stabilize-state.json
```

A run that ends with something still red leaves the old state file, so the next window still includes the culprit.

### Case 1 — nothing needed fixing

Nothing to commit, nothing to merge. Don't fabricate a commit.

```bash
git switch develop
git branch -D <branch>
git push origin --delete <branch>   # only if you pushed it
```

**Done means:** you are on `develop`, `develop` has no new commit, and the branch is gone.

### Case 2 — fixes were made

1. Run `npm run typecheck && npm test` once. That's the whole final check.
2. Squash the branch to ONE commit, non-interactively (never `--allow-empty`; if there is nothing to commit, you're in Case 1):

   ```bash
   git reset --soft "$(git merge-base origin/develop HEAD)"
   git commit -m "fix(e2e): stabilize <area>" -m "- <fix 1>" -m "- <flake hardened>"
   ```

   Subject `<type>(<scope>): <description>`, imperative, under 72 characters (`fix`, `test`, `chore`…); 2–5 bullet lines in the body. **No AI attribution**: no `Co-Authored-By`, no mention of Claude, Codex or AI.

3. Fast-forward `develop` and push:

   ```bash
   git switch develop
   git pull --ff-only origin develop
   git merge --ff-only <branch>
   git push origin develop
   git branch -d <branch>
   git push origin --delete <branch>   # only if you pushed it
   ```

   If `develop` moved and the fast-forward or push is rejected, never force-push `develop`. Rebase the branch onto `origin/develop`, run `npm run typecheck && npm test`, and repeat step 3. `develop` moves constantly while agents are landing work, so this is the normal path, and it does **not** restart validation: what you validated was your fixes. The only exception is a real interaction — the rebase conflicted in a file your fixes touched, or upstream changed the same code. Then re-run the narrow tests covering that code (rung 1) and nothing more.

**Done means (Case 2):** you are on `develop`; the stabilization is exactly one new commit on `develop` that changes files; `develop` is pushed; the branch is deleted.

## Final report

Include: the attribution for every failure (commit SHA and subject, what in it broke what, and why its own checks missed it — or flake / pre-existing / unattributed), the branch name (now deleted), the final commit SHA on `develop` (or "no commit — develop was already green"), the green ledger, the flakes hardened, any test changed because it was stale (and why), and confirmation that `develop` was pushed (Case 2) or untouched (Case 1).
