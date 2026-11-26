# Performance benchmarks

How long things take in the built app, how much work they do and how much memory each of its processes holds,
measured the same way every time, so a change can show a number before and a number after. Nothing here runs in pull request CI and no number fails a build: the results
are evidence for a pull request. The `optimize` skill (`.claude/skills/optimize/SKILL.md`) is built on these commands.

```sh
npm run build                                   # every measured tree is built first
npm run perf:run                                # launch, open and edit on both fixtures, 5 iterations
npm run perf:run -- --scenario edit --fixture large --iterations 7 --out .tmp/perf/results/edit.json
npm run perf:run -- --scenario memory           # memory of every process at named points, on both fixtures
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
2. **Warm-up.** For each fixture the project is copied into the run's folder and opened in a fresh profile, untimed,
   then opened again. That trusts it, lists it in Recent projects, and has run the editor's scripts twice: Chromium
   notes a script the first time it runs and keeps its compiled code the second, so every launch and open after that
   reuses it, as a person's do (the preview's server takes a new port each launch, so its scripts are not cached by
   address). What the warm-up leaves (the project, the preview tools' caches in its
   `node_modules`, and the profile) is put back before every iteration, so each iteration starts from the same files.
   A fixture whose preparation or warm-up fails has its cases reported as failed, and the other fixtures are still
   measured. Each launch ends with a sweep of every process it started, checked against the identity read at launch.
   A launch that will not start, or a process that will not end, stops the run: the result is still written, with
   what was not measured reported as failed.
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

`launch` here is a fresh process on a profile that has opened the project twice before, so Chromium's code cache is warm: the
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
for commands), `recentsShown`. The editor's page and script: `pageStart` (its navigation), `pageParsed` (its HTML
parsed), `scriptStart` (the first line of its script running), `scriptEvaluated` (every module the script imports up
front evaluated), `catalogueReceived` (the theme catalogue registered); `scriptCompile` (`pageParsed` to `scriptStart`: the
script's load and compile) and `scriptEvaluate` (`scriptStart` to `scriptEvaluated`). From the window being created:
`windowToFirstRender` and `windowToWelcome` (to an interactive Welcome that lists its recent projects, the later of
`firstInteractive` and `recentsShown`). Run it warm and `--cold` for a second and a first launch's compile. Counts:
files read and hashed before the window was created, React commits until recents show; the longest main-process stall.

**`open`**: open the fixture from its card on Welcome, to the canvas bridge reporting the home page ready to edit.
Checks: the project opened writable, from the fixture's folder, with its pages, posts, images, project components and
home page, and the home hero's heading in the preview. Times from `open.requested` (the click): `controller` (the open
call), `session` and its phases `session.formatCheck` (the scan for a newer format), `.lock`, `.recover`, `.read`,
`.localState`, `.validate`, `.sweep`, `publish` (generated files checked and written), `generate` (its two generator
runs), `attach`, `assetCheck`, `startRuntime` (spans); `firstSnapshotSent`, `editorShown`, `runtimeForked`,
`runtimeReady` and `canvasReady` (the headline). The preview's start, from the marks of the preview process that served
the page the canvas reported ready: `runtimeStarted` (the worker given its start), `runtimeViteLoaded`,
`runtimeServerCreated`, `runtimeReady` (listening), `runtimeFirstRequest` and `runtimeFirstResponse` (the first page a
browser asked for that was answered, when it was asked for and when the answer had gone), with the stretches
`forkToListen`, `listenToFirstResponse`, `firstResponseToCanvasReady`, and `editorToCanvasReady` (what the author
watches as "Starting preview"). Counts: files read and hashed, document files read, durable
writes and fsyncs (session open, attach and preview start), the publication's files read, hashed and written, its
synchronous filesystem calls, path stats and bytes hashed, `project:changed` sends and their bytes until the canvas is ready, `reloadFromDisk` calls, React commits; the longest
main-process stall.

**`edit`**: change the home hero's Heading in the Inspector, to the preview showing it. Checks: the project moved exactly
one revision, the page's document on disk holds the new heading, the preview shows it. Times from `edit.requested` (the
editor sending the edit): `apply` (the whole edit in the main process, queue included), `sessionApply`,
`validateOperations`, `applyOperations`, `validate` (the saving checks), `generate` (both variants), `persist`,
`publish` (spans); `hmrRelease`, `changed`, `snapshotSent`, `snapshotReceived`, `rendererCommit`, `previewPublished`
and `previewApplied` (the headline). Counts: durable writes, fsyncs, file writes, synchronous filesystem calls, path
stats and bytes hashed in the edit; the publication's files read, hashed and written, its bytes hashed, durable writes,
fsyncs, synchronous filesystem calls and path stats (`publish…`); `project:changed` sends and bytes, `reloadFromDisk`
calls and React commits until the scenario ends; the sweeps of history blobs and unused assets (`session.sweep`) the
edit waited on before `changed` (`sweepsAwaited`, their time `sweepAwaited`) and all of them until the scenario ends
(`sweeps`), so a sweep moved later is still seen; the longest main-process stall.

**`editFullHistory`**: as `edit`, once History holds its limit of 100 steps, so the edit lets the oldest go. Before the
scenario starts (untimed), 100 edits of the hero's Heading are made through the editor's API, each a step of its own.
Checks: History held 100 applied steps before the edit, and after it still holds 100, the edit's step is the last
applied one and the oldest is gone; then the same as `edit`. The same metrics as `edit`, named `editFullHistory.*`.

**`edits`** (after `open`): change the home hero's Heading in the Inspector 20 times, each edit sent once the one
before it is saved and the file watch has gone off for that save (`controller.watchFired`, when the reload a save sets
off starts), or 5 s after the save when the system never tells of it (on a busy Mac it tells of a save a moment to
seconds late, or not at all, so a fixed delay would miss it); then change the home page's file outside the app as an
editor saves it (written beside it and renamed over it), saving it again every 15 s, up to 6 times, until the app takes
it. Checks: the edits moved the project exactly
20 revisions, the project and the page's document on disk hold the last heading, the preview shows it; then the outside
change moved it one more, the project holds the outside heading, the preview shows it, and it is the step Undo takes
back (`External change`). Over the edits, up to the outside change, which comes `--settle` ms after the last edit is
shown: `queueWait` (the median of the 19 edits sent after another, each its `controller.apply` less its
`session.apply`, matched by the revision it made: its wait for its turn), `queueWaitTotal` (all 20), `apply` and
`sessionApply` (medians), `sendGap` (the median time between two edits being sent), `watchFired` (times the watch went
off), `reloadFromDisk` (the calls) and `reloadUnchanged` (the reloads that read the project and found nothing changed,
`session.reloadUnchanged`), files read, documents read, files hashed, durable writes and fsyncs, `project:changed`
sends and bytes, React commits and the longest main-process stall. Then, from the watch going off for the outside
change (when the system tells of it is not the app's doing): `outsideSent` (its snapshot sent to the editor) and
`outsideApplied` (the canvas showing it), and `outsideReloads` (reloads until the scenario ends).

**`switch`** (after `open`, and after every other scenario that follows it): with the fixture open, choose File > Open
Project… and answer its folder chooser (through the app's chooser fixtures) with a second copy of the fixture, trusted and
in Recent projects behind the first; to the canvas bridge reporting the second copy's home page ready to edit. The
runner prepares that copy only when `switch` is asked for: the warm-up opens it before the fixture's own copy, and both
are put back for every iteration. Checks: the first copy was locked before, the second copy opened writable with its
pages, posts, images, project components and home page, the home hero's heading is in the preview, the first copy's
preview process exited and its lock went (within 15 s), and the second copy is locked. Times from `open.requested`
(the editor asking to open): `controller`, `session` (the second copy's), `close` (the first copy's), `attach`,
`startRuntime` (spans); the preview's start as in `open` (`runtimeForked` … `runtimeFirstResponse` and the three
stretches), by the second copy's own preview process; `canvasReady` (the headline); `oldServerExited` (the first copy's
preview process gone, which the second's start need not wait for but which must always happen); the longest
main-process stall.

**`panels`** (after `open`): with the sidebar closed and the dock on its Project view, so every other panel is hidden,
click the home hero on the canvas; then show the Inspector and change the hero's Heading there. Checks: every sidebar
view and dock panel is in the page before, and the same elements after (hidden, not unmounted or replaced), the canvas's selection toolbar names
the hero after the click, the Inspector names it the moment it is shown again, the edit moved exactly one revision with
the new heading in the project, on disk and in the preview, and Layers, shown again afterwards, has the hero selected at
once. Times: `click.commit` (the canvas reporting the click to the commit that shows the selection) and `edit.commit`
(the editor receiving the edited project to the commit that shows it), with `edit.rendererCommit` from the edit being
sent. Per panel, in the click's window and in the edit's: `renders.<panel>` (its components React rendered) and
`renderMs.<panel>` (React's time rendering it, in the updates its probes render in: every store update and every
render of what holds it; a render of the panel's own state alone is counted but not timed), with `hiddenRenders` and `hiddenRenderMs`, their sums over the panels not
shown in that window (all but Project for the click, all but the Inspector for the edit), `renders` (every component
rendered) and React commits. The panels are the sidebar's six views, the post writer and SEO view over the canvas, and
the dock's four. Showing the Inspector between the two windows is in neither.

**`chat`**: in the AI panel, in a conversation of 6 messages and then in one of 100, type a 66-character question one
key at a time and stream a long Markdown answer to it (about 2,200 characters, 4 at a time every 8 ms, from the scripted
model server in native tool mode: no live provider). The conversations' earlier turns are seeded into the project's
chat folder before the timed part, which the app does not watch, and opened from Earlier conversations. Checks: the
composer holds what was typed, the answer's first sentence, one from its middle and one near its end are each on screen
while the run is still going and before its last sentence, its last is there once it ends, the log shows both new
messages, the composer is empty, and the conversation saved to disk holds its earlier messages, the request as typed and
the answer whole, the same two messages the log shows. Every key typed has its span, and the editor handled every event
main sent, or the iteration fails. Per conversation (`chat.at6.*`, `chat.at100.*`): `keyMs` (median `chat.keystroke` span:
one keystroke's update with the React render and commit it sets off), `keystrokes`, and the React commits, message
renders and text parses while typing (`keyCommits`, `keyMessageRenders`, `keyTextParses`); for the reply, the
`ai:event` sends and their bytes (`events`, `eventBytes`), `eventsHandled`, `eventMs` (median `chat.aiEvent` span, the
same for one event) and `eventMsTotal`, `replyMs` (until the editor handled the reply's last event), the commits,
message renders and text parses while it streamed (`streamCommits`, `streamMessageRenders`, `streamTextParses`), and
the longest main-process stall.

**`aiEdit`**: in the AI panel, with the home hero selected in Layers and the composer in Edit mode, ask twice for its
Heading to change (`first`, after the project opened, and `second`, with nothing changed since the first ended), the
scripted model (constrained JSON, no live provider) changing it with one tool call and finishing each time. Checks: each
request took the scripted model's two turns and named the hero to it, ended completed with the build's check passed and
none failed, and left the new heading in the project, on disk and in the preview; every build check in the request
looked at every Svelte file the website has (`compile.files`), whether it compiled it again or not, and the checks after
the change compiled every Svelte file it changed both ways at least (`compile.svelte`), so none passed on an outcome
from before it. Per request
(`aiEdit.first.*`, `aiEdit.second.*`), from main receiving it (`ai.send`): `toModel` (to the first model turn,
`ai.modelRequest`), in its phases `toAdapter` (the model's adapter prepared), `toCompile` (the run set up: the project
taken), `startCompile` (the starting build, an `ai.compile` span) and `compileToModel` (the request put together); the
starting build's Svelte files and compiles (`startFiles`, `startCompiled`), the build checks after the first model turn
(`checkCompile`, `checkCompiled`), the build checks in all (`compiles`), the model turns, `runMs` (to the run ending,
`ai.runEnd`) and the longest main-process stall in the run.

**`export`**: export the website as a folder from the Export dialog: open it, choose Website files, pick a folder (the
chooser answered through the driver), until the dialog says what it exported. **`exportAgain`** follows it and does the
same once more with nothing changed, into a second folder. Checks: the dialog says it exported the fixture's pages and
entries, the export is listed as a new website folder in the chosen place, made from the revision it started on, and
the folder holds a page for every page and entry, the home hero's heading, and nothing of the editor's (no editor
markup in its HTML or scripts, no `node_modules`, `.siteorigin` or `.svelte-kit`). Times: `total` (the main process's
whole export, `controller.exportStatic`), `stage` (the site's icons and the snapshot), `lockHeld` (the snapshot taken
under the writer lock, while no edit can land), `assets` (the checks and asset passes on the staged copy, from the
snapshot to copying the tools), `copyTools`, `build` (the production build), `verify` (the built site's pages, scripts
and images checked again), `publish` (the folder put in place), `finish` (the export recorded and its preview started)
and `cleanup` (the staging folder removed). Counts: files and bytes the export read in the main process (`filesRead`,
`bytesRead`; copies are not reads), the same under the lock (`lockFilesRead`, `lockBytesRead`), file writes, the
library's files and bytes beside them, and the files and bytes of the exported folder; the longest main-process stall.
The fixture has no drafts, and only the folder format is measured.

**`import`** (after `open`): in Assets, Add images, with the chooser answered (through the driver) by 20 photographs of
12 megapixels drawn by `photos.ts` (4032 × 3024 JPEGs of about 3.2 MB with a Display P3 profile, every fourth turned by
its EXIF orientation, every fifth carrying an author and copyright; made once per machine under `.tmp/perf/photos/`), and
the import review confirmed as it opens, which adds each as a web-sized copy; until every photo is in the library with
all its copies. Checks: the review offers all 20 a web-sized copy, 20 images arrive, each a 2560-pixel JPEG turned
upright, with JPEG copies at each smaller width, WebP at those and its full width and AVIF the same or none, every file
on disk the size and format its record says, the credited photos' WebP and AVIF copies carrying their credits, each
original and its smallest copy loading from the preview, and Assets saying it added 20 images. Times from
`import.requested` (the editor sending the confirmed import): `total` (to the commit showing every photo), `firstShown`
(to the first commit showing any), `main` (`controller.importAssets`), `apply` (the one change that adds them), `review`
(`controller.reviewImport`, before the request); per photo (medians): `image.ms` (its time in the main process),
`image.webMs`, `image.webDecodeMs`, `image.webCopyMs` (its web-sized copy in the media worker: the whole request, its
decodes, its resize and encode) and `image.copiesMs`, `image.copiesDecodeMs`, `image.jpegMs`, `image.webpMs`,
`image.avifMs` (its responsive copies: the whole request, its decodes, and each format's pipelines added up). The worker
reports each request it answers (`media.request`, with `stats` asked for only when marks are on): `workerRequests`,
`decodes` (pixel decodes of an encoded picture), `encodes`, `workerCpuMs` (CPU each worker used, every thread, from the first
request it was given to the last it answered, added up over the workers: divided by
`total`, the cores the import kept busy), `workers` and `workerPeakRss` (each worker's peak resident memory, added up).
Counts: file writes, durable writes and fsyncs in the import, `images` and `variants` added; the longest main-process
stall.

**`memory`** (after `launch`, and only on its own: see Memory below): the memory of every process of the app at rest on
a fresh Welcome (`welcome`); the fixture opened from its card as `open` opens it, untimed, sampled throughout for its
peak (`open.peak`); at rest on the canvas (`canvas`); after one change of the home hero's Heading in the Inspector
(`edit1`) and after 49 more (`edit50`), each applied and left 600 ms before the next, past the file watcher's look at
its save; and back on Welcome, starting 20 s after the project closed (`closed`). Checks: everything
`open` checks, the canvas reporting the home page ready before the peak ends, each edit shown in the preview and
reported applied by the canvas, the project 50 revisions on with the last heading in the project and on disk, the
project closed and Welcome shown. For each reading: `memory.<reading>.total` (the memory all the app's processes hold), `.processes` (how many), `.mem.<role>` and `.processes.<role>` (each role's), and, at rest,
`.heap.main` and `.heap.editor` (the JavaScript heap in use); the peak's are `memory.open.peak.*`. Growth, the
difference of two readings in the same launch: `memory.edits.growth.*` (`edit50` − `edit1`: what 49 edits left behind)
and `memory.close.growth.*` (`closed` − `welcome`: what a project left behind once closed).

**`canvas`** (after `open`): with the home hero selected by a click on it, scroll the home page with the wheel, 30 notches
of 60 px down and as many back up, each 16 ms after the one before was taken (about 30 a second on an M4 Max, so the
outlines move every other frame); then sweep the pointer across the page, corner to corner along both diagonals in 60
moves each, paced the same way. Each window starts from the page's top. The pointer scrolls a third of the way across the page, clear of the
selection's spacing handles and Add buttons, which take the wheel when they pass under it. Checks: the page scrolled
as far as the notches went and back to its top, the hero is still selected, at least one hover was outlined in the
sweep, and, scrolled part of the way down from the top with the pointer on an element of another of the page's sections
(none pinned to the view), the selection's outline
sits on the hero (half out of view) and the hover's on an element under the pointer, each within 1.5 px (and the 6 px of
room a part gets). Per window (`canvas.scroll.*`, `canvas.sweep.*`): `ms` (its length), `canvasRenders` (the canvas
component rendered), `rectReports` (the page's reports of where its outlines are), `rectReportsSame` (those identical
to the report before), `hoverReports` (the page saying the pointer reached another element), `rendererCommits`,
`renders` (every component React rendered), `reportMs` and `reportMsTotal` (median and sum of the `canvas.rects` and
`canvas.hover` spans: one report handled with the React render and commit it set off), and from a watch the scenario
runs in the editor's page for the window, `frames` (animation frames), `droppedFrames` (a frame a period or more late
counts the frames it missed; a watch that saw fewer than half the frames the window should have had fails the
iteration), `longestFrameMs`, `longTasks` and `longTaskMs` (tasks of 50 ms or more); the frame
period, `canvas.framePeriodMs`, is the median between frames over a second at rest before the windows. For the sweep,
`hoversOutlined` and `hoverOutlineMs`: the median time from the pointer moving onto an element in the page (the event's
time, which the page sends with its report) to the animation frame after the commit that first draws that element's
outline where the page measured it (`canvas.hoverOutlined`); a hover overtaken before it was outlined is not counted. Each input
has 5 s to be taken. A machine busy with other work can tell the app late that the project's files changed on disk (they
are put back before every launch): the app reads the project again or the preview reloads its page, and a window that
happens in measures a page loading. So the scenario starts once nothing has reloaded for 3 s, and a window, the
hero's selection or the outlines' check, during which the preview loaded a page or the project was read from disk is done again after another
3 s of quiet, up to five times; the window measured is its last attempt, and five disturbed attempts fail the
iteration. Both arms are held to the same rule.

**`create`** (after `launch`): on Welcome, New project, a name, the Business starter with its sample images in the app's
default projects folder, Create; to the canvas bridge reporting the new project's home page ready to edit.
**`createAgain`** follows it: the project `create` made is closed (untimed) and a second one made the same way, in the
same launch, which is what a second project made with this app costs. The runner copies the fixtures' npm cache into the
profile when `create` is asked for, so setup installs every package offline, as a packaged app does from the cache it
ships; what either leaves in the profile is put back with it before every iteration, so each iteration's `create` is
the first project this profile has made. Checks: the dialog says the website tools are on this computer, the Business
starter and sample images are chosen, the new project opened writable from its folder with the starter's pages, one
library image per sample photo (each file in the project) and the starter's hero heading, which the preview shows; its
`node_modules` holds every package `npm ci` installs here from its lock (followed from the project's own dependencies,
leaving out other computers' optional ones), with npm's own lock of it, made for this package, and its tools are marked
set up. Times from `newProject.requested` (New project pressed): `dialogShown` (the form on screen), `dialogReady` (the
check of the website tools settled, which Create waits for), `websiteTools` (that check in the main process, span),
`dialogStallMax` (the longest main-process stall until then); from `create.requested` (Create pressed): `controller` (the
whole creation in the main process) and its phases `files` (the template copied), `images` (the sample photos
imported), `session` (the documents written, `session.writeDocs`, and the first publication, `publish`, with its
`publish.icons` and `publish.write`, and `generate`, its two generator runs; `session.localState`), `lock`, `trust`,
`dependencies` (`tools.seedCache`, `tools.check`, every check of what the tools need, `tools.npm`, every npm run, and
`tools.marker`), `makeWay` (the open project closing, if any), `attach` and `startRuntime` (spans); `editorShown`, the
preview's start as in `open`, and `canvasReady` (the headline), with `fromDialog` (New project pressed to the same).
Counts, over the whole creation: file writes (all, the images', the publication's), durable writes and fsyncs, files
read and hashed, sample images imported, npm runs, the npm dependency trees worked out (`idealTrees`, and in the
dialog's check `dialogIdealTrees`) and checks of the tools; the longest main-process stall. Run them on `small` alone:
the project made is the same whatever the fixture.

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

## Memory

The harness reads memory; the app never does. Only a chain with a memory scenario makes a memory probe
(`scripts/perf/memory.ts`), so a timing run takes no reading and collects no garbage, and a memory scenario is never
run beside a timing one: `perf:run` refuses `--scenario memory,edit`. The timing scenarios a memory scenario follows
(`launch`) still run before it, unreported.

**What a reading holds.** Every process the app owns (its main process and everything below it, and on macOS and Linux
its process group, as the teardown sweep finds them), each with the memory the OS says it holds: on macOS its physical
footprint (`top`'s MEM, what Activity Monitor shows: what it holds in RAM and compressed, without pages it has handed
back), with `ps` giving who is whose at the same moment; on Linux `ps` RSS; on Windows the working set. macOS reads the
footprint because RSS there follows the machine's memory pressure: it keeps counting pages a process has freed until
the system takes them back, and stops counting pages it compresses. Two runs of one build on a busy machine, the main
process's JavaScript heap identical in every launch, had its RSS 40 to 70 MiB apart, and the editor's a third. Each
process is named by its role, never by its pid:

- `main`, `editor` (the editor window's renderer), `preview` (the renderer of the canvas's preview frame, found by the
  frame's name; one that shares the editor's process is counted once, as the editor), `thumbnails` (the hidden window
  that photographs project components), `gpu`, and Chromium's services by name (`network`, `storage`, …).
- The app's helpers by what they are: `devServer` (the preview's dev server, "SiteOrigin project runtime"),
  `projectBuild`, `media`, `importReader`, `sourceSync`; a new helper by its service name.
- A process Electron does not list, by its parent's role and its executable: `devServer.esbuild`, and `main.unlisted`
  for one the app's own executable runs (npm while it installs a project's tools, or on Windows, where every Chromium
  helper runs that executable, a helper Electron has not reported yet). Arguments are never read.
- A renderer keeps the role it was last seen in: Chromium keeps the preview's renderer some 10 s after its frame goes,
  and it is still the preview then.

Two processes of one role are summed (`.mem.<role>`) and counted (`.processes.<role>`); the result keeps each process
of every reading with its role. Where the figure is RSS (Linux), pages two processes share count in both. Read figures
on one machine, never across machines: compare refuses results read from another source or protocol.

**At rest.** A reading at rest (`ctx.memory.rest(label)`) leaves the app alone for 3 s (work the last step set off: a
workspace save, a thumbnail), waits until two process tables 500 ms apart list the same processes, then collects
garbage twice in the main process (an inspector session inside it), the editor and the preview's frame (CDP sessions on
each), waits 1 s, reads the two heaps, and takes one sample: the process table and what the app says each process is.
If the processes changed meanwhile (or a collection failed because one went, or on macOS `top` had not listed one yet)
it starts again, up to three times; a set that does not hold still for one gap within 15 s fails the reading. A reading is taken at a fixed point, never "once
things look done": `closed` starts 20 s after the close (its sample comes some 4.5 s later, after the settle and the
collection), so a build that lets go of the preview's renderer later than another shows it. Helpers are never collected (the dev server's own garbage is its business), so their figures move
more between launches than the main process's or the editor's. Each reading says how it was taken (`how`: the source,
the protocol, the waits, what was collected, the retries), and the result records `memoryProtocol`
(`MEMORY_PROTOCOL` in memory.ts), raised whenever any of this changes, and `memorySource`: results read differently,
from another source, or by a protocol this harness no longer reads are never compared.

**Peaks.** `ctx.memory.peak(label, work)` samples the process table every 200 ms from before `work` starts until after
it ends, never waiting on the app (a busy main process cannot hide its own spike): the app is asked what a process is
only when one appears. The peak is the highest total over the samples, and for each role its highest sum and count:
they need not come at once, so the roles' peaks can add up to more than the total's. A process that lives less than a
period can go unseen; `how` gives the samples taken, the longest gap between two, and how many were left out because a
process in them had no figure yet (macOS: `top` had not listed it).

**Comparing.** Memory figures (unit `memory`, shown in MiB) have their own noise band: **three times the larger MAD of
the two runs, and never under 10% of the before median or 8 MiB**. Process counts have none: any difference is
`changed`. A role one launch had and another did not (a helper that ends a while after its last job, caught by one
launch and not another) counts as none in the launch
without it, within a run and between two runs; a reading that was not taken fails its case. `--markdown` prints a table
per reading in the order they were taken, then each growth: a row per role with its process count, before, after, the
change in MiB and Improvement, then all processes and the two heaps. Growth can be below zero; its change is read in
MiB, never as a percentage of it, in both formats.

How the band was arrived at: on an M4 Max (36 GB, macOS, shared with other work), two runs of one build, 5 iterations
each on both fixtures, were compared (the second run's large case failed one launch, below, and was run again), and a
third with 40 MiB held in the main process (a filled `Buffer`, made at startup on a throwaway build). Between the two runs every process count was identical; on the small fixture every
memory figure stayed inside the band (the largest move 9 MiB on a 548 MiB total, 6 MiB on the main process); on the
large one all but four did: at `canvas` the GPU process still held its open-time memory (about 430 MiB) in 4 of one
run's 5 launches and in none of the other's, which moved its figure and the total, and the preview's renderer moved by
24 and 10 MiB. Read `canvas`'s GPU figure as a state the app is in or not, not a level. With 5% and 4 MiB, the main
process at Welcome (5 MiB) fell outside too. The 40 MiB came out as +39 to +44 MiB in the main process, outside the
band, at every reading of the small fixture and at Welcome, the open's peak, `canvas` and `edit1` of the large one,
with its heap unchanged and no other process's figure moved but the dev server's growth over the edits (its garbage is
never collected). After 50 edits and after the close the large fixture's main process varies by up to 60 MiB from one
launch to the next (the band there is ±51 to 57 MiB), so a change it must show belongs in an earlier reading. One
launch in the 35 of these runs failed: after a reload from disk the preview never showed an edit its bridge reported
applied, an app race the 50 quick edits find, not the reading's.

**Adding a reading.** A memory scenario is a `Scenario` with `memory: true` (its `deadlineMs` may be longer than the
usual five minutes), after `launch` for something done from Welcome. In `run`, take readings with
`ctx.memory.rest(label)` once the app is where the reading belongs (after the step's own check) and wrap work whose
cost is a spike in `ctx.memory.peak(label, () => work)`; never inside a timed window, and never in a timing scenario.
In `measure(trace, fixture, readings)`, `readingMetrics(m, label, reading)` for each and `growthMetrics(m, name, from,
to)` for each difference; a reading the run did not take is reported missing. Labels are lowercase-first words
(`canvas`, `edit50`). A role one side of a comparison has in a reading and the other does not counts as none on the
other side, so a helper that appears or goes is `changed` (its count exactly, its memory against the band); a metric
of a reading only one side took is `new` or `gone`.

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
(project, generated and theme pack files) and `files.hashedBytes` (the bytes those hashes ran over), `files.stats` (a
project file looked at by its path without being read: a stat, an lstat, or a handle opened for its stat alone;
`src/main/project/stable-read.ts` and the session's publication), `fs.syncCalls` (synchronous filesystem calls on the
main process's event loop by path containment, `safeJoin`, the server-hook check and the publication), `docs.read` (canonical document files read from the project folder, also
counted in `files.read`; `src/main/project/documents.ts`), `export.filesRead`, `export.bytesRead` (what an export reads
in the main process, `src/main/export.ts`), `ipc.projectChanged.sends`, `ipc.projectChanged.bytes` (as
IPC serializes the snapshot), `ipc.aiEvent.sends`, `ipc.aiEvent.bytes` and `ipc.aiEvent.unsized` (the assistant's
events, sized the same way), `compile.files` and `compile.svelte` (Svelte files a build check looked at, and the
compiler runs it made for them: `src/main/compile.ts`), `session.reloadFromDisk`, `session.reloadUnchanged` (a reload that read the project and
found nothing changed), `tools.npmRuns` (npm runs that set up a project's website tools), `tools.idealTrees` (the npm
dependency trees worked out to check what they need, `src/main/runtime/manager.ts`), `main.stalls` (main), and
`react.commits`, `react.renders`
(components rendered, counted from each commit's fibers), per panel marked with `timedPanel`
(`src/renderer/src/lib/perf-panels.tsx`) `panel.<id>.renders` and `panel.<id>.renderMs` (the time between two probes
React renders before and after the panel), `chat.messageRenders` (a Chat message rendered) and `chat.textParses` (model
text read into blocks), `canvas.renders`, `canvas.rectReports`, `canvas.rectReportsSame` and `canvas.hoverReports` (the
`canvas` scenario's) (renderer). The main process also
watches its event loop every 20 ms and records each time the watch ran 50 ms or more late as a `main.stall` span of that
lateness (a block shorter than about 70 ms can go unseen).

A span's `dc` is everything the process counted while it ran, its own work and anything else running at the same time
(a lock heartbeat every 30 s, a workspace save 300 ms after a panel changes). A scenario keeps that out of its window:
the `edit` scenario waits for the workspace save its own panel choice set off before it starts.

## Adding a mark or a counter

- **Main process**: `import { perf, timed } from './perf'` (`src/main/perf.ts`). `perf.mark(name, attrs?)` for a point,
  `const end = perf.span(name, attrs?)` … `end(more?)` for a stretch, `perf.count(name, by?)` for a counter, and
  `timed(name, fn, attrs?)` to wrap an async function, which returns `fn` itself when marks are off.
- **Editor**: `perfMark(name, attrs?)` or `perfMarkOnce(...)` from `src/renderer/src/lib/perf.ts`; `perfCount(name, by?)`
  for a counter, which every later mark carries; `perfWork(name, fn, attrs?)` to time an update the editor makes with
  the React render and commit it sets off (a span ending in a microtask queued after `fn`, with the `commits` it took).
- **Workers** report to the main process by message, which marks on receipt (as `runtime.ready` and `runtime.published`
  are).
- **No cost when off.** A hook is an empty function then; anything costly to work out for one (serializing, walking
  state) goes behind `if (perf.on)` / `if (perfOn)`. Names are lowercase-first, dotted (`session.publish`). A mark that
  belongs to a revision carries `revision`, so a scenario can match it across processes.
- Never put paths, page text or snapshots in `attrs`, and never change what the app does because marks are on.
- A new counter, or a new mark, needs nothing more. Making an existing counter count something else (another read
  site, another kind of write) raises `PERF_COUNTERS_VERSION` in `src/shared/perf.ts`: results whose counters mean
  different things are then never compared.

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
