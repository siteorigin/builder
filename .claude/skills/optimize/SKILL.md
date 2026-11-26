---
name: optimize
argument-hint: "<issue number or URL | a surface in words, e.g. 'application boot time'> [--budget Nh] [--no-pr] [--dry-run]"
description: "Takes one performance-optimization issue (or a surface named in words) to a pull request whose body carries a table of before, after and percent improvement, unattended: find or write the benchmark for the surface, write the target down before measuring, measure the baseline on the built app, plan hypotheses with Codex, try them one per round and keep or revert each on the numbers, re-measure the final tree against the branch point, have Codex review the change, prove it with the tests, then open the PR against develop. When nothing moves the number it ends with an honest report on the issue and no pull request. Use when the user wants a performance issue or a slow surface optimized with measured proof."
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - Skill
  - mcp__ask-google__ask_google
hooks:
  PostToolUse:
    - matcher: "Skill"
      hooks:
        - type: command
          command: "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"OPTIMIZE CONTINUATION: a Skill just returned. If it was optimize, its runbook is loaded, not executed: state the goal and start the run now. If it was codex, its runbook is loaded, not executed: launch its calls in the background, sleep and check on them in the foreground, then come back to the optimize phase you were in. Re-read the ledger under .tmp/optimize/ if you have lost your place. Never end a turn without text, never end a turn to wait, never ask the user anything. The run ends only with OPTIMIZE_COMPLETE or OPTIMIZE_BLOCKED on the last line.\"}}'"
          timeout: 5
  Stop:
    - blocking: true
      hooks:
        - type: prompt
          prompt: |
            You decide whether Claude may stop. Answer with JSON only: {"ok": true} to allow the stop, or {"ok": false, "reason": "..."} to keep Claude working, where the reason names what is still missing and the next step.

            This hook belongs to the /optimize skill. A run takes one performance issue or surface to its goal, which Claude states near the start in a line beginning "Goal:". Allow the stop ({"ok": true}) when any of these holds:
            - No /optimize run is in progress: the conversation is about something else, or the latest run already ended and the conversation has moved on.
            - Claude's last message ends with OPTIMIZE_COMPLETE and the conversation shows one of: (a) a pull request URL in tool output from this run, a table of before, after and percent change measured by the benchmark harness on the final tree against the branch point, and a Codex review of the change; (b) the null result: every hypothesis reverted, the report posted on the issue (or printed, for a freeform surface), and no pull request; (c) a --dry-run plan, or a --no-pr branch name with the same table as (a).
            - Claude's last message ends with OPTIMIZE_BLOCKED and names an unrecoverable cause: authentication, repository corruption, the built app cannot launch at all, Codex unavailable after three tries, or the issue has an open blocker.

            Otherwise keep Claude working. A noisy measurement, a failed hypothesis, a failing test, review findings and a hard problem are normal work, never reasons to stop. Waiting is never a reason to stop: tell Claude to sleep and check again in the foreground. A table whose numbers were measured before the last code change does not count: tell Claude to re-measure the final tree.

            Hook input: $ARGUMENTS
          timeout: 30
---

# optimize

Take one performance surface of SiteOrigin Builder to a pull request that proves, with a benchmark, that it got faster. Or prove it cannot be moved, and say so.

`$ARGUMENTS` is the whole input.

## Contract

**Run unattended.** You are pre-authorized for the branch, every hypothesis, every revert, every measurement, the push and the pull request. You are not authorized to merge, to push to `develop`, or to weaken a guarantee listed in §Boundaries. Resolve uncertainty through the code, the benchmark, Codex and Ask Google, never the user.

As soon as the input is read, state the goal in one line:

```
Goal: a PR for #N with a before/after/% table for {surface}, reviewed by Codex and proven by its tests, or #N answered with the evidence that nothing here could be moved.
```

**The deliverable is the table.** A change with no measured before and after is not an optimization, however sound the reasoning. A run that tries six hypotheses, disproves all six and writes down why is a complete, correct run. Never manufacture an improvement, and never open a pull request to show your working.

**One run, one subject, one pull request.** The issues under the programme tracker (label `performance-optimization`) each name a surface and list its suspected causes. The list is where to start measuring, not a checklist: the benchmark decides which causes matter. Work them in order of measured cost. Causes left unworked are named in the pull request and stay on the issue.

**Never end a turn to wait.** Codex calls and long measurements run in the background or the foreground with a sleep-and-check loop (the global "Calling Codex" convention). The last line of the run is `OPTIMIZE_COMPLETE` or `OPTIMIZE_BLOCKED`, and nothing else ends it.

## Input

| What was typed | What it means |
| --- | --- |
| `957`, `#957`, an issue URL | That issue. Read it whole with its comments: `gh issue view N --comments`. Its Acceptance section names the metrics to report and the behaviour that must not change; its Boundaries are binding. |
| `application boot time`, `saving an edit`, `layers with 1,000 rows` | A surface. Find the open `performance-optimization` issue that covers it (`gh issue list --label performance-optimization --state open --search ...`) and work that issue. If none does, work the surface as described and file nothing. |
| instructions for a benchmark ("time opening a project with 500 posts and get it down") | The scenario to build or find, and the number to move. Treat the description as the scenario's definition. |

Flags: `--budget <Nh>` wall-clock ceiling (default 4h); `--no-pr` commit on the branch and report its name; `--dry-run` stop after §3 with the scenario, the precommit record and the Codex plan, measuring only the baseline.

**Blockers.** If the issue has an open blocked-by edge (`gh issue view N --json` or the body's `Blocked by #M`), the thing it needs does not exist yet. End with `OPTIMIZE_BLOCKED` naming the blocker. The one exception is the harness issue itself, which is built by this skill (§The harness).

## The harness

Measurement lives in `scripts/perf/` and is documented in `scripts/perf/README.md`. Read that file first, every run: it is the authority on commands and file formats, and where it differs from this document, it wins.

What the harness provides, and what this skill relies on:

- **Timing marks in the app.** With an environment variable naming a file, the main process and the renderer append marks as NDJSON: launch, project open and edit phases. Off by default.
- **Counters beside durations.** Durable writes per edit, bytes on `project:changed`, files read and hashed per publish, `reloadFromDisk` calls, renderer commits. Counts compare across machines and need no statistics; durations do not.
- **A scenario runner** that drives the built app headless through `tests/driver`, repeats a scenario, and writes one JSON result with the median and spread per metric and the commit it measured.
- **A correctness predicate per scenario**, checked on every iteration.
- **Fixture projects**, built deterministically: the small starter and a large one (about 50 pages, 500 collection entries, 300 assets, 30 project components).
- **A compare command** that prints before, after and percent change for two result files.
- **A static report** of built output sizes and what the main process loads before the window exists.

**If `scripts/perf/` does not exist,** the run's issue must be the harness issue: build it to that issue's acceptance, with unit tests for the compare and aggregation logic, and open the pull request. Its table is the first baseline: the launch, open and edit scenarios on both fixtures, with no "after" column. For any other issue, a missing harness is `OPTIMIZE_BLOCKED`.

**Rules the harness and every scenario must keep** (they come from `CLAUDE.md`):

- It drives the **built** app in `out/`. Every tree that is measured is built first with `npm run build`, and the result file records the commit that build came from. A measurement of a stale build is a measurement of some other tree.
- Headless, always. No window shown, no focus taken. A headless launch never shows its window, so launch is timed to the window being ready to show and the renderer being interactive.
- Native choosers are answered through the driver (`answerChoosers`, `desktop.setAnswers`), never by patching `dialog` or `shell`.
- No live AI provider calls. AI scenarios use the fake adapter. A claim that needs a live provider (prompt cache hits) gets at most a handful of calls, named in the report.
- Scratch output goes in `.tmp/`, never the repo root. Nothing here runs in pull request CI.

## Phases

Open every transition with a position line, `Phase N/9 {name} done. Next: {next}.`, and start the next phase in the same turn. The ledger at `.tmp/optimize/<issue-or-slug>/ledger.md` is the durable state: the input, branch, branch-point sha, champion sha, the precommit record, every measurement file with the sha it measured, and the hypothesis log. Update it at each transition and re-read it after any loss of place. `.tmp` is gitignored; never commit it.

### 1. Intake

1. Read `CLAUDE.md`, the issue and `scripts/perf/README.md`.
2. `git fetch origin`, confirm a clean tree, and branch from `origin/develop`: `perf/issue-<N>-<slug>`. In a batch run, work in the worktree you were given.
3. Record the machine (model, OS, power state) in the ledger. Plug in, turn low-power mode off, and make sure nothing else is building or running: no dev server, no other agent's test run, no `npm install`.

### 2. Scenario

Find the scenario that measures this surface, or write it.

- **A scenario exists:** read its definition, its fixture and its predicate. Do not edit it.
- **None exists:** write it before anything else, as its own commit, from the issue's Acceptance section: the actions a person takes, the marks and counters to report, the fixture, and the predicate. Add any timing mark or counter it needs to the app in the same commit. A new mark must cost nothing when marks are off. Then freeze it.

**The predicate is mandatory.** A count goes to zero when the feature is broken: a save that writes nothing is very fast, a panel that renders nothing commits instantly. The predicate asserts on every iteration that the surface still did its job: the preview shows the edit, the project opened with the right documents, the exported site contains the pages. Prove it can fail once: break the subject on a throwaway commit, run three iterations, confirm the scenario reports failure, and reset. A scenario whose predicate cannot fail measures nothing.

**The scenario is frozen once the baseline is taken.** After that, a change to the scenario, its fixture or the harness invalidates every number: fix it on the base, re-take the baseline, and say so in the report. The final diff's changes under `scripts/perf/` are only the scenario commit from this phase.

**Do not make the inputs easy.** The scenario runs on both fixtures when the cost can grow with project size. Most of the issues exist because cost follows the whole project instead of the edit, and only the large fixture shows that.

### 3. Precommit, baseline, plan

**Write the decision down before the number that judges it.** In the ledger, before the baseline:

- **The target:** one metric that should fall. Prefer a count or a size (durable writes per edit, bytes sent, files hashed, renders per second) over a duration, and a median over any tail. Never a p95 or a max from a handful of iterations.
- **The predicate** and the other acceptance behaviours that must hold.
- **The guards:** every other metric the scenario reports. A win on the target that doubles a guard is not a win. Declare any guard you expect to trade, now.
- **The threshold:** the smallest improvement you will call real. For a count, any reproducible change. For a duration, the larger of 5% and twice the noise floor.
- **The protocol:** fixture, iterations and warm-ups, identical for every arm.

Then measure:

1. Build the branch point and run the scenario. That is `before`, and the first champion.
2. Run it a second time on the same build. The difference between the two is the **noise floor**. A duration that moves less than that has not been shown to move.
3. Take a profile where the harness offers one (a CPU profile of the main process, a React commit trace). The baseline says how much; the profile says where.

Then plan with Codex. Invoke the `codex` skill in `plan` mode with a self-contained brief: the issue's text, the scenario, the baseline numbers per phase, the profile's hot spots, and the suspected causes. Ask for hypotheses ranked by expected effect on the target, each naming the mechanism and where it lives, what would disprove it, and what it risks from §Boundaries. Codex's plan is a set of leads: read the two or three files it leans on hardest and drop what the baseline already contradicts. A suspected cause that measures as a small share of the total is left alone, and the report says so with its number.

`--dry-run` ends here.

### 4. Hypothesis loop

One hypothesis per round, until the budget is spent or the credible ones run out.

1. **Name the mechanism.** "This looks inefficient" is not a hypothesis. "`reloadFromDisk` runs after every save because the watcher cannot tell the app's own rename from an outside one" is.
2. **Make the smallest change that tests it, and commit it.** Every measurement is of a committed, built tree.
3. **Build, then measure with the identical protocol.** Compare with the current champion, not the original baseline: judging against the baseline keeps a change that made the best result worse.
4. **Check the predicate and the guards** before reading the target.
5. **Decide on the evidence:**
   - Target improved past the threshold, predicate healthy, guards within tolerance: confirm it reproduces with one more run for a count, or an interleaved pair (§Durations) for a duration. Then keep: the commit is the new champion.
   - No movement, inside the noise, or a regression: `git reset --hard <champion>`, and record the disproof. It has value.
   - Improved only by weakening something in §Boundaries: revert anyway and record the price beside the number.
6. **Run the unit tests that cover what the round touched** before the next round. A kept change that alters behaviour gets its test now: a regression test that fails without it, per `CLAUDE.md`.
7. Update the ledger.

When stuck, ask Codex again (`codex` skill, `ask` mode) with the rounds so far and the current profile. Fresh hypotheses are cheaper than a seventh variation on a disproved one.

Reserve the last third of the budget for phases 5 to 8. A run that spends everything on hypotheses has nothing it can ship.

### 5. Headline

After the last code change, squash the kept commits into one focused commit, `perf(<scope>): <what>` (the scenario commit from phase 2 stays separate). Then measure the numbers the pull request will quote: the **branch point** against the **final tree**, on the scenario's full protocol, on every fixture.

Every number taken earlier belongs to a tree that no longer exists, and a run that tried many hypotheses will have kept one or two on luck. The table never comes from the round that selected a hypothesis. It comes from this one measurement, taken once, after selection is over.

If the headline does not clear the threshold, the improvement was not real. Reset, report the headline numbers, and finish as §Nothing improved. A plausible mechanism is what made the change worth testing; it is not evidence that it worked.

### 6. Codex review

Invoke the `codex` skill in `review` mode on the branch's diff against `origin/develop`. Give it the issue, the table and §Boundaries, and ask it to attack three things in particular: a guarantee the change weakens (crash safety, the lock, containment, outside-edit detection, a cache with no sound invalidation), a way the benchmark now measures less than it did, and a case a real project hits that the fixture does not.

Evaluate each finding against the code. Fix the real ones; skip the rest with a one-line reason. **If a fix changes production code, redo phase 5**: the table must describe the tree that ships.

### 7. Prove the tree

Per `CLAUDE.md`'s definition of done:

1. `npm run typecheck`.
2. The unit tests covering the change, and any added, green. Run the whole `npm test` when the change crosses the engine, the session or the generator.
3. The e2e script that covers the surface, when there is one (`npm run build` first; it runs headless). Not `tests/e2e/ai.mjs`.
4. `git diff --stat origin/develop`: only the scenario commit touches `scripts/perf/`, and nothing unrelated came along.

Run verbose checks through a subagent that returns only failures. Never run measurements through one, and never alongside anything else: a measurement competing with a test run is the contamination the protocol exists to prevent.

A failure the change caused is fixed, then phase 5 is redone if production code moved. A failure already red on `origin/develop` is proven there, named in the pull request, and left alone. Never weaken an assertion to pass.

### 8. Pull request

`git fetch origin`, rebase or merge if `develop` moved under files the change touches (then redo phase 5), push the branch, and `gh pr create --base develop`. Never force-push.

The body, written plainly (use the `greg-priday-writing` skill), carries:

- One paragraph: what was slow, why, and what changed.
- **The table** (§The table), one per fixture.
- The hypothesis ledger, one line each, including every rejection and its measured reason.
- What was not measured, and the suspected causes from the issue that were left, with the numbers that justified leaving them.
- `Resolves #N` when the issue's acceptance is met; `Part of #N` when causes remain, with a comment on the issue listing them.

No AI attribution anywhere: no trailers, no generated-by line. Then watch the pull request's one check to a verdict (`gh pr checks <n> --watch`) and fix what the change broke; rerun only a clear flake. Do not merge.

### 9. Report

Print the table, the ledger summary and the pull request link, and end with `OPTIMIZE_COMPLETE`.

## The table

One per fixture, from phase 5 only.

```
### {scenario} · {fixture}

| Metric | Before | After | Improvement |
| --- | ---: | ---: | ---: |
| **{target metric}** | 1,480 ms | 610 ms | **58.8%** |
| {other reported metric} | 14 | 3 | 78.6% |
| {guard} | 212 ms | 215 ms | −1.4% (noise) |
| Predicate: {what it asserts} | pass | pass | ok |

Machine: {model, OS} · {N} iterations, {W} warm-ups · median · noise floor {x}%
Trees: {branch point sha} → {final sha}, both built with `npm run build`
```

- Improvement is `(before − after) / before`, positive when the number fell. A metric that got worse shows as negative, in the table, not in a footnote.
- The predicate is always a row. A reader must see that the feature still works.
- Every guard is a row, including the ones that moved the wrong way.
- A percentage appears only where it can be defended: any count, and a duration whose change exceeds the noise floor. Otherwise print the two numbers and `(noise)`.
- Counts are stated as counts ("16 → 2 durable writes per edit"); they are the most portable evidence in the table.

## Durations

A duration is the weakest thing the harness measures and the easiest to fool yourself with.

- **Both arms now, alternating.** A result file from an hour ago is not an opponent: the machine has heated and its background load has shifted. For a headline on a duration, measure base and candidate in the order base, candidate, candidate, base, base, candidate, uninterrupted, and require the candidate to win all three pairs by more than the noise floor.
- **Keep both builds.** Build the branch point once into a second worktree under `.tmp/optimize/<N>/base` so arms alternate without rebuilding between them.
- **Median, not tail.** At 10 or 20 iterations a p95 is one of the two largest samples.
- **Cold and warm are different metrics.** State which was measured. A first launch after a build and a second launch are both worth reporting for boot; never mix them in one median.
- **Never delete an inconvenient sample after seeing it.** If something else ran during an arm, redo the whole interleave.
- fsync cost differs widely between macOS, Windows and Linux. Claim durations for this machine only. Counts travel. When a change is about disk syncs, say that the Windows figure is unmeasured, or measure it on the Windows test laptop (`~/.claude/windows-test-node.md`) and give it its own table.

## Boundaries

A win bought by weakening one of these is not a win. Revert it and record the price.

- **Crash safety.** A save is atomic and recoverable: after a crash at any point the project is the state before the edit or the state after it. The number and overlap of durable writes may change; that may not. Any write whose ordering changes gets a test for an interruption at that point.
- **The project lock and the write fence.**
- **Pack verification.** A damaged or altered theme pack is never used unverified. When it is verified may change.
- **Path containment** (`safeJoin`) and **detection of files edited outside the app.** They may be made cheaper, never dropped.
- **The HMR publication gate**: one batched update per save.
- **The main process is the source of truth.** The renderer never holds a state the main process cannot reproduce.
- **`applyOperations` is pure.** The previous state is never mutated.
- **No Builder lock-in.** Editor instrumentation lives only in `.siteorigin/cache/dev`, never in an exported site's `src/`, and nothing editor-only goes in the export template.
- **Byte-identical output.** Generated files and exports for the same project do not change unless the issue says they may.
- **Pre-release rules.** No migrations, shims or compatibility paths. Never the OS keychain or `safeStorage`.
- A cache needs a sound invalidation rule you can state in one sentence and test. A stale result presented as fresh (a compile error missed, a measurement of a page that has not received the edit) is a bug, not a speed-up.

## What has worked before

Patterns from a long optimization programme on another Electron and React app, in rough order of how often they paid off. They are prompts for hypotheses, not instructions.

- **Do less before the first paint.** Static imports evaluated before the window exists, verification and housekeeping run ahead of the first frame, closed dialogs and panels in the boot script, requests awaited one after another that do not depend on each other. Lazy-load what is closed; split what a command does from what it is called.
- **Reveal on a signal, not on completion.** Show the frame or the skeleton when it is ready and let the rest arrive; do not gate a view on a later paint or a timeout.
- **Stop doing nothing, expensively.** No-op durable writes, re-reads of files just written, checks that conclude nothing changed. Write only on change. These show up as counts, and counts make the cleanest tables.
- **Make cost follow the change, not the project.** Keep identity for what did not change so everything downstream can skip by reference. Whole-state clones, whole-project re-serialisation and whole-snapshot IPC are the usual sources.
- **Overlap independent waits.** Serial awaits over files, pages or measurements that do not depend on each other.
- **Narrow what re-renders.** Selectors instead of whole-object subscriptions, stable references, per-frame state kept out of the global store, lists that mount only what is visible.
- **Stop hidden things working.** Panels, timers and observers that are not on screen.
- **Move CPU work off the event loop** that also serves IPC and input: compiles, hashing, encoding.
- **Delete fixed sleeps and debounces that outlived their reason**, and replace a wait-for-time with a wait-for-signal.
- **Watch for moved work.** Ten calls becoming one resident worker is a win on the count and may be worse overall. That is what the guards are for.
- **A benchmark that got faster by doing less is a broken benchmark.** Missing predicates, fixture setup inside the timed bracket, a path the fixture never exercises.

## Nothing improved

No hypothesis moved the number, or the only ones that did cost something in §Boundaries. Both are complete runs.

1. `git reset --hard` to the branch point. If phase 2 added a scenario that did not exist, that commit alone is still worth a pull request: open it as the benchmark for the surface, with the baseline table and no "after".
2. Otherwise delete the branch. No pull request, no draft, no marker commit.
3. Comment on the issue with the report: the baseline table, each hypothesis and the measured reason it was rejected, and either what to try next or why the number looks to be at its floor. Leave the issue open unless the baseline shows there was no cost to remove; then close it as not planned, with that evidence.

## Blocked

Only for the unrecoverable: authentication, repository corruption, the built app will not launch at all, Codex unavailable after three tries with the reason from its log, or an open blocker on the issue. Commit what exists, leave the branch, say exactly which step could not run, and end with `OPTIMIZE_BLOCKED`. A noisy machine, a failing test and a hard problem are not blockers.
