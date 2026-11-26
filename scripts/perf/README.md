# Performance benchmarks

How long things take in the built app, and how much work they do, measured the same way every time, so a change can
show a number before and a number after. Nothing here runs in pull request CI and no number fails a build: the results
are evidence for a pull request. The `optimize` skill (`.claude/skills/optimize/SKILL.md`) is built on these commands.

```sh
npm run build                                   # every measured tree is built first
npm run perf:run                                # launch, open and edit on both fixtures, 5 iterations
npm run perf:run -- --scenario edit --fixture large --iterations 7 --out .tmp/perf/results/edit.json
npm run perf:compare -- before.json after.json  # before, after, change and verdict per metric
npm run perf:compare -- before.json after.json --markdown   # the tables a pull request carries
npm run perf:static                             # built output sizes and the main entry's packages, beside the baseline
```

`perf:run` takes `--scenario` (comma-separated; default `launch,open,edit`), `--fixture` (`small`, `large` or both;
default both), `--iterations` (default 5), `--out` (default `.tmp/perf/results/<time>.json`), `--app <checkout>` (the
checkout whose `out/` is measured, default this one: build a second worktree to measure another tree with this
harness), `--settle <ms>` (default 1500, below) and `--cold` (below). It exits 0 when every case passed, 1 when any failed and 2 when the
run itself could not go on.

## What a run does

1. **Fixtures.** `small` is a new project from the Business starter; `large` is that starter grown to 50 pages, 500
   published posts, 300 library images and 30 project components (`fixtures.ts`). Both are built deterministically (seeded
   IDs, constant dates, images drawn uncompressed), so a fixture's hash only changes when the fixture or the document
   format does. Each is written once per fixture hash, starter template and platform under `.tmp/perf/fixtures/`, then
   opened once in the app, which installs its website tools as for a new project (the first time needs the network).
2. **Warm-up.** For each fixture the project is copied into the run's folder and opened once in a fresh profile, untimed.
   That trusts it and lists it in Recent projects. What the warm-up leaves (the project, the preview tools' caches in its
   `node_modules`, and the profile) is put back before every iteration, so each iteration starts from the same files.
   A fixture whose preparation or warm-up fails has its cases reported as failed, and the other fixtures are still
   measured. Each launch ends with a sweep of every process it started; one that will not end stops the run.
3. **Iterations.** Each is a fresh launch of the built app, headless (no window shown, no focus taken), with
   `SITEORIGIN_PERF_FILE` naming the iteration's trace file. The scenarios asked for run in one launch, in order, each
   after the one it follows (`launch` → `open` → `edit`), so `--scenario edit` costs the same as all three and reports
   only `edit`. A scenario whose actions or check fail stops the chain (the ones after it say why); one whose trace only
   lacks a mark fails on its own. Scenarios that follow the same one run one after the other, so the later one starts
   from what the earlier left. Opening waits until the project's files are 3.5 s old: freshly copied files are read in
   full, a person's are not (`ProjectSession.settleMs`). After a scenario's job is done the runner waits `--settle` ms
   before ending it, so work it set off (a reload the file watcher starts 400 ms after a save) is counted. Each scenario
   has five minutes, and the warm-up fifteen.
4. **Result.** One JSON file: the build (the commit the app stamped into itself, the checkout's HEAD and whether it was
   dirty, a fingerprint of `out/`), the machine, the config, and per case (scenario × fixture) every iteration's metrics
   with its trace file, and, when every iteration passed, the median, min, max and MAD of each metric. The run prints the
   same as a table per case and warns when the build is not of the checkout's HEAD.

`launch` here is a fresh process on a profile that has been launched before, so Chromium's code cache is warm: the
everyday launch. `--cold` removes Chromium's caches from the profile before every iteration, so the editor's script is
compiled afresh, as on the first launch after an update (the OS file cache stays warm either way). Cold and warm are
different metrics: never compare one with the other; the result records which it is.

## Scenarios and their metrics

Every scenario checks on every iteration that the feature did its job; a check that fails, or a mark the metrics need
that is missing from the trace, fails the iteration with its stage and reason, and a case with any failed iteration is
reported as **FAILED**, with no timings at all. A run cannot get faster by doing less.

**`launch`**: start the app to an interactive Welcome screen. Checks: Welcome shows the fixture among its recent projects,
New project is enabled, no project is open, no window was shown. Times from `launch.processStart` (when the OS created
the process): `mainLoaded` (every static import of the main entry evaluated), `appReady`, `loadPacks` (span),
`windowCreated`, `readyToShow`, `firstRender` (the editor's first React commit), `firstInteractive` (Welcome listening
for commands), `recentsShown`. Counts: files read and hashed before the window was created, React commits until recents
show; the longest main-process stall.

**`open`**: open the fixture from its card on Welcome, to the canvas bridge reporting the home page ready to edit.
Checks: the project opened writable, from the fixture's folder, with its pages, posts, images, project components and
home page, and the home hero's heading in the preview. Times from `open.requested` (the click): `controller` (the open
call), `session` and its phases `session.lock`, `.recover`, `.read`, `.localState`, `.validate`, `.sweep`, `publish`
(generated files checked and written), `attach`, `assetCheck`, `startRuntime` (spans); `firstSnapshotSent`,
`editorShown`, `runtimeForked`, `runtimeReady` and `canvasReady` (the headline). Counts: files read and hashed, durable
writes and fsyncs (session open, attach and preview start), the publication's files read, hashed and written,
`project:changed` sends and their bytes until the canvas is ready, `reloadFromDisk` calls, React commits; the longest
main-process stall.

**`edit`**: change the home hero's Heading in the Inspector, to the preview showing it. Checks: the project moved exactly
one revision, the page's document on disk holds the new heading, the preview shows it. Times from `edit.requested` (the
editor sending the edit): `apply` (the whole edit in the main process, queue included), `sessionApply`,
`validateOperations`, `applyOperations`, `validate` (the saving checks), `generate` (both variants), `persist`,
`publish` (spans); `hmrRelease`, `changed`, `snapshotSent`, `snapshotReceived`, `rendererCommit`, `previewPublished`
and `previewApplied` (the headline). Counts: durable writes, fsyncs and file writes in the edit, the publication's files
read, hashed and written, `project:changed` sends and bytes, `reloadFromDisk` calls and React commits until the scenario
ends; the longest main-process stall.

## Reading and comparing results

Counts and sizes are the portable evidence: they do not depend on the machine, and two runs of the same build give the
same median. Durations are for this machine only, and move between runs; the median is what is compared, never a max or
a tail from a handful of iterations.

`perf:compare` matches cases by scenario and fixture, refuses fixtures whose hash differs and results measured
differently (`--cold` against warm, or another `--settle`), notes results from different machines (their durations do
not compare; their counts do) or website tools installed from a different template, and prints, per metric,
before and after medians, the difference, the change in percent and a verdict: `same`, `changed`, or `noise` for a
duration whose difference is within the **noise band**: three times the larger MAD of the two runs, and never under 10%
of the before median or 1 ms. Two full runs of the same build on a quiet M4 Max kept every duration inside it (with
3 × MAD alone, 4 of 86 fell outside, by 5–8%), and every count identical. Counts and sizes have no band: any difference
is `changed`. A duration that moves by less than the band is not shown to have moved; one that moves by more still
needs the `optimize` skill's interleaved arms before it is a headline. A result compared with itself is exactly zero everywhere.
`--markdown` prints one table per case with Improvement as (before − after) / before, positive when the number fell, the
form the `optimize` skill's pull requests carry. A case that failed on either side is shown as not compared, and the
command exits 1.

## The static report

`perf:static` reads `out/` only. Rows: `renderer.script` and `renderer.style` (what the editor page loads before it can
render: its entry, everything that imports statically, its stylesheet), `renderer.later` (its other files, loaded on
demand), `main`, `preload` and each `worker.*`, each in raw and gzip bytes (level 9, file by file). Below them, the
**main entry's static dependency closure**: the installed packages the main entry's static imports reach, followed through
their own static imports and `require()` calls with one string, resolved from the importing file as Node resolves them,
with their files and bytes. Imports are read from each file's syntax tree, so one written inside a string (the
generator's templates of website code) does not count. That is what the main process evaluates before its first line
runs, so before the window can be created. It is not a runtime trace: an `await import()` made before the window is not
in it, and a `require()` in a function that never runs is counted. A load that cannot be followed (a package's own
`#imports`, a missing file) is listed, so the closure is never taken as whole when it is not.

Each row and package is shown beside `baseline/static.json`, with what changed. After a change that moves them on
purpose, rebuild and refresh it with `npm run perf:static -- --update-baseline`, in the same pull request.
`--json <file>` writes the full report.

## The trace format

With `SITEORIGIN_PERF_FILE` set, the main process appends one JSON record per line, its own and the editor's (which sends
them over IPC). Unset, no file is opened, no IPC channel is registered and every hook returns at once. The format is in
`src/shared/perf.ts`:

- `t`: when it happened (a span's end), epoch ms with sub-millisecond precision, on one clock for both processes.
- `kind`: `meta` (once, about the process), `mark` (a point) or `span` (a stretch of work, `ms` long).
- `name`, `proc` (`main` or `renderer`), `pid`, `seq` (the order records reached the file), `attrs` (small values: a
  revision, a count, a mode).
- `c` on a mark: every counter of its process, cumulative. `dc` on a span: what each counter gained while it ran.

Counters: `fs.writes`, `fs.durableWrites`, `fs.fsyncs` (`src/main/project/fsutil.ts`), `files.read`, `files.hashed`
(project, generated and theme pack files), `ipc.projectChanged.sends`, `ipc.projectChanged.bytes` (as IPC serializes
the snapshot), `session.reloadFromDisk`, `main.stalls` (main), and `react.commits` (renderer). The main process also
watches its event loop every 20 ms and records each time the watch ran 50 ms or more late as a `main.stall` span of that
lateness (a block shorter than about 70 ms can go unseen).

A span's `dc` is everything the process counted while it ran, its own work and anything else running at the same time
(a lock heartbeat every 30 s, a workspace save 300 ms after a panel changes). A scenario keeps that out of its window:
the `edit` scenario waits for the workspace save its own panel choice set off before it starts.

## Adding a mark or a counter

- **Main process**: `import { perf, timed } from './perf'` (`src/main/perf.ts`). `perf.mark(name, attrs?)` for a point,
  `const end = perf.span(name, attrs?)` … `end(more?)` for a stretch, `perf.count(name, by?)` for a counter, and
  `timed(name, fn, attrs?)` to wrap an async function, which returns `fn` itself when marks are off.
- **Editor**: `perfMark(name, attrs?)` or `perfMarkOnce(...)` from `src/renderer/src/lib/perf.ts`.
- **Workers** report to the main process by message, which marks on receipt (as `runtime.ready` and `runtime.published`
  are).
- **No cost when off.** A hook is an empty function then; anything costly to work out for one (serializing, walking
  state) goes behind `if (perf.on)` / `if (perfOn)`. Names are lowercase-first, dotted (`session.publish`). A mark that
  belongs to a revision carries `revision`, so a scenario can match it across processes.
- Never put paths, page text or snapshots in `attrs`, and never change what the app does because marks are on.

## Adding a scenario

In `scenarios.ts`, add a `Scenario` and list it in `SCENARIOS` after the one it follows:

- `after`: `launch` for something done from Welcome, `open` for something done in the editor.
- `run(ctx)`: do what a person does through `ctx.win` (Playwright, real input; answer native choosers through the
  driver's desktop fixtures, never by patching `dialog`), bracketed by `ctx.mark('scenario.start' | 'scenario.end',
  { scenario })`, then check with `expect(...)` that the feature did its job, on what the person would see and on disk.
- `measure(trace)`: a `Collector`: `need()` each record the metrics depend on (a missing one fails the iteration),
  `since()` for times from the scenario's start, `span()` for spans, `count()` for counters from `dc` or the difference
  of two marks' `c`. Match records by revision or by the scenario's own boundary marks, never by "the next one".
- Prove the check can fail: break the feature on a throwaway commit, run three iterations, see the case reported as
  FAILED, then reset.
- Add a unit test of `measure` on a small trace (`tests/unit/perf-results.test.ts` has the pattern).

AI scenarios never call a live provider: start the scripted model server the driver uses (`MockOpenAIServer` in
`tests/unit/mock-openai-server.ts`) and point the app at it as `useScriptedProvider` in `tests/driver/session.ts` does,
in the scenario's `run` before its `scenario.start` mark (settings live in the profile, which is put back before every
iteration).
