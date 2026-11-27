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
npm run perf:prompt                             # what each turn of an AI run sends, and what a provider's cache serves
npm run perf:git                                # a version saved in the bundled Git's repository: time, memory, growth
```

`perf:run` takes `--scenario` (comma-separated; default `launch,open,edit`), `--fixture` (`small`, `large` or both;
default both), `--iterations` (default 5), `--out` (default `.tmp/perf/results/<time>.json`), `--app <checkout>` (the
checkout whose `out/` is measured, default this one: build a second worktree to measure another tree with this
harness), `--settle <ms>` (default 1500, below), `--cold` and `--second` (below). It exits 0 when every case passed, 1 when any failed and 2 when the
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
compiled afresh, as on the first launch after an update (the OS file cache stays warm either way). `--second` removes
them too, then launches the app once and opens the fixture, untimed, and puts the project back: the iteration is the
second launch after an update that changed the editor's scripts, the first having opened a project (one that only showed
Welcome would leave the editor's own chunk never run), and finds only what Chromium kept of the code that launch ran. Cold, second and warm
are different metrics: never compare one with another; the result records which it is.

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
`firstInteractive` and `recentsShown`). Run it warm, `--second` and `--cold` for an everyday, a second and a first
launch's compile. Counts:
files read and hashed before the window was created, React commits until recents show; the longest main-process stall.

**`open`**: open the fixture from its card on Welcome, to the canvas bridge reporting the home page ready to edit.
Checks: the project opened writable, from the fixture's folder, with its pages, posts, images, project components and
home page, and the home hero's heading in the preview. Times from `open.requested` (the click): `controller` (the open
call), `session` and its phases `session.formatCheck` (the scan for a newer format), `.lock`, `.prepare` (the fence's
claim, the ownership check and the local folders made and flushed), `.recover`, `.read`, `.localState`, `.validate`;
`publish` (the open's publication, generated files checked and written, inside `session` or after it, before the canvas
is ready), `generate` (its two generator runs), `sweep` (the open's sweep of history blobs and unused assets, wherever
it runs until the scenario ends), `attach`, `assetCheck`, `startRuntime` (spans); `firstSnapshotSent`, `editorShown`, `runtimeForked`,
`runtimeReady` and `canvasReady` (the headline). The preview's start, from the marks of the preview process that served
the page the canvas reported ready: `runtimeStarted` (the worker given its start), `runtimeViteLoaded`,
`runtimeServerCreated`, `runtimeReady` (listening), `runtimeFirstRequest` and `runtimeFirstResponse` (the first page a
browser asked for that was answered, when it was asked for and when the answer had gone), with the stretches
`forkToListen`, `listenToFirstResponse`, `firstResponseToCanvasReady`, and `editorToCanvasReady` (what the author
watches as the page outlined on the canvas, from the editor showing to the page ready; the outline itself shows from
`open.requested`). Counts: what the editor's first snapshot waited for (`generationsBeforeSnapshot`,
`sweepsBeforeSnapshot`, `assetChecksBeforeSnapshot`: those that ended before it was sent); files read and hashed,
document files read, durable writes and fsyncs (everything the main process counted from the scenario's start to its
end, so work moved later is still counted), the publication's files read, hashed and written, its
synchronous filesystem calls, path stats and bytes hashed, `project:changed` sends and their bytes until the canvas is ready, `reloadFromDisk` calls, React commits; the longest
main-process stall.

**`edit`**: change the home hero's Heading in the Inspector, to the preview showing it. Checks: the project moved exactly
one revision, the page's document on disk holds the new heading, the preview shows it. Times from `edit.requested` (the
editor sending the edit): `apply` (the whole edit in the main process, queue included), `sessionApply`,
`validateOperations`, `applyOperations`, `validate` (the saving checks), `generate` (both variants), `generateCheck`
(the part of both generations the generation cache spent finding which files' inputs are unchanged,
`session.generateCheck`, with two counts: `generateLooked`, the things files read that it looked up in the new state,
each once a state, and `generateDerived`, the derived values among them it worked out), `changedDocs` (every document serialized and compared with its last text to find what the
edit changed, `session.changedDocs`), `persist`, `publish` (spans); `hmrRelease`, `changed`, `snapshotSent`, `snapshotReceived`, `rendererCommit`, `previewPublished`
and `previewApplied` (the headline); the change reaching the editor in its stretches, `changedToSent` (`session.changed` to
`controller.snapshotSent`: the main process putting the editor's copy together and sending it), `sentToReceived` (IPC
carrying it to the editor's handler) and `receivedToCommit` (the editor taking it in, to React's commit showing it).
Counts: `docsCopied` (the
canonical documents of the new state that are not the very objects of the one before, `apply.docsCopied`),
`docsSerialized` (`docs.serialized`), durable writes, fsyncs, file writes, synchronous filesystem calls, path
stats and bytes hashed in the edit; the publication's files read, hashed and written, its bytes hashed, durable writes,
fsyncs, synchronous filesystem calls and path stats (`publish…`); `project:changed` sends and bytes, `reloadFromDisk`
calls and React commits until the scenario ends, and the editor's walks of every collection entry for the site's addresses
(`siteEntryWalks`, shared/collections.ts `siteEntries`: work that follows the project's size) from the edit being sent to the
scenario's end; the sweeps of history blobs and unused assets (`session.sweep`) the
edit waited on before `changed` (`sweepsAwaited`, their time `sweepAwaited`) and all of them until the scenario ends
(`sweeps`), so a sweep moved later is still seen; the longest main-process stall. What the edit spends checking and
deriving from the whole project: the batch's checks once it is applied (`batchChecks`, a span, and its parts
`batchSyncedEntries`, `batchItemStates`, `batchCollectionSources`, `batchDependencies`), and, each as a time and how many
times it was worked out (`…Runs`), the sweep of departed item styles after every operation (`itemStyles`), the save
gate's check of the new state (`saveCheck`), the snapshot's problems for Project Health (`diagnostics`), asset usage
(`assetUsages`), theme updates (`themeUpdates`) and saved versions' sizes (`versionsInfo`), from the edit to the
scenario's end (a check no longer worked out is 0 of both); `checks`, all of these added up; and the snapshots built
(`snapshotBuilds`, their time `snapshotBuild`).

**`editFullHistory`**: as `edit`, once History holds its limit of 100 steps, so the edit lets the oldest go. Before the
scenario starts (untimed), 100 edits of the hero's Heading are made through the editor's API, each a step of its own.
Checks: History held 100 applied steps before the edit, and after it still holds 100, the edit's step is the last
applied one and the oldest is gone; then the same as `edit`. The same metrics as `edit`, named `editFullHistory.*`.

**`editBranded`** (after `open`, and after every other scenario that edits the fixture's own copy): as `edit`, on a site
with a favicon of its own, in the save right after one that copied a theme font into the project. Before the scenario
starts (untimed), a 256-pixel PNG is written into `static/assets/`, added to the library and chosen as the favicon in one
change, until the home-screen icon drawn from it is on disk; then, once the picture's file is 3.5 s old (as a person's
favicon is, `ProjectSession.settleMs`), the heading font (`font.display`) is set to the theme's Lora, which the Business
starter does not use, so that save copies Lora's files in. Checks: all four icons (the three PNGs and `favicon.ico`)
were drawn from the favicon, the canvas showed the font change, and every Lora face the website's styles name was copied
in as the theme pack's own file; after the edit the site still has its favicon and none of those faces or icons
changed; then the same as `edit`. The same metrics as `edit`, named `editBranded.*`, and the favicon's reads and the
bytes of it hashed by the edit's publication (`publishFaviconReads`, `publishFaviconBytesHashed`), only from a build
that counted the favicon's reads before the edit (one that never counts them fails rather than reporting none).

**`history`** (after `open`, and after every other scenario that follows it but `editBranded` and `switch`, which inherit
the two saved versions and the History steps it leaves): take a step back and forward, and put a saved version back,
each to the preview showing it. Before the timed part: a version saved of the project as it is, the home hero's Heading changed through the editor's
API (one step of History), and the hero selected in Layers with the Inspector showing it. Then three windows, each from
its own phase mark to the next: `undo` (the toolbar's Undo), `redo` (its Redo), and `restore` (Restore in History's
Saved versions, opened and the version reviewed untimed). Checks: each moved the project exactly one revision, and the
project, the home page's document on disk and the preview hold the heading it should (the original after Undo and the
restore, the changed one after Redo), and so does the Inspector's Heading, which shows the editor's own copy; the restore kept
the work it replaced as a version of its own. Per window, named
`history.<window>.*`, by the revision it made: `changed`, `rendererCommit` and `previewApplied` from the window's start;
`changedToSent`, `sentToReceived` and `receivedToCommit` as in `edit`; `project:changed` sends and bytes over the window
(`snapshotsSent`, `snapshotBytes`, the version list's own updates included), React commits, `siteEntryWalks` and the
longest main-process stall.

**`batch`** (after `open`): in the AI panel, in Edit mode limited to the home page (This page), ask for a change that the
scripted model (no live provider) makes as one `apply_operations` call of 30 operations, the most one call may carry:
`instance.setProp` on the home page's text properties in turn (each placement's string properties; one set twice keeps
its later text); then the model answers. Until the preview shows the hero's new heading and the request has ended.
Checks: the request was limited to the home page, the project moved exactly one revision and holds every text the batch
wrote, so does the home page's document on disk, the answer is in the log, and the canvas reported the revision
applied. Times from the request being sent: `beginRun` (the run's start, `session.beginRun`), `checks` (what the run
checks before handing the batch to the project: Developer mode's copies and the request's reach,
`agent.devModeCheck` and `agent.authorityCheck`), and in the batch's own `session.apply` (`sessionApply`):
`applyOperations`, `validate`, `generate`, `generateCheck` (with `generateLooked` and `generateDerived`, as in `edit`),
`changedDocs`, `persist`, `publish`; `runMarker` (the run's
recovery marker built at its start and with the batch, `session.runMarker`, its write left out) and `previewApplied`.
Counts: `runMarkers`, `runDocsHashed` (documents the markers hashed, `run.docsHashed`), `docsCopied`,
`docsSerialized`, durable writes and fsyncs in the apply; `project:changed` sends and their bytes over the whole run
(`snapshotsSent`, `snapshotBytes`: the run going busy and idle, and its change); the longest main-process stall until the preview shows it
(the run's compile before its first model call is in it).

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

**`panelsInUse`** (after `open`): as `panels`, with the panels it leaves out of use each holding work. Before the timed
part: the scripted model connected as a local provider (no live provider; nothing is sent to it) and the window reloaded
to take it, the AI panel in Edit mode offering its starters, a post (the fixture's first, or one made for it when the
fixture has none) opened in the writer from Posts and chosen in the SEO view, then every sidebar view hidden (the SEO
view's rail button pressed again), so the writer and the SEO view are put away holding the post, and the dock on its
Project view, so the AI panel is hidden too. Then the same click and edit as `panels`. Checks: as `panels` (Layers
aside), and the writer's title field and the SEO view's document stay the same elements; afterwards the AI panel, shown
again, offers starters about the hero the click selected, and with the post renamed while both are hidden, the SEO view
and then the writer, each shown again, have the new title at once. The same metrics as `panels`, named
`panelsInUse.*`, and per window the work over the whole site that panels did as they rendered: `seoOverviews` (the
SEO overview worked out, `seo.overviews`), `seoRoutes` (the website read for an entry's address, `seo.routes`) and
`chatStarters` (the AI panel's starters worked out, `chat.starters`).

**`layers`** (after `open`): two pages made for it in one change each before the timed part, of 300 and 1,000 layers:
sections of 25 (a container holding a container with a heading, a paragraph and a row of four cards, each card a heading,
a paragraph and a button in a stack of its own, six deep), the second section's inner container hidden at every size and
the fourth's first card on phones. Each page is opened from Pages, with Layers shown and every branch in it opened; then
7 rows across the page, at every depth, are clicked in turn (each scrolled into view and pointed at first, untimed),
the arrow keys step 7 rows down from the last, and the eye of a section's row hides it at every size and then shows
it again. Each of those is a sample with a window of its own, which stays open 300 ms after the change is shown; a window
a reload from disk or another snapshot lands in is done again from where it started (up to five times), and the last
attempt is measured. Checks, after every sample: Layers lists every layer of the page in order with no branch closed,
the row clicked or stepped to is the one selection, exactly its containers are marked as holding it, exactly the hidden
section's rows (and the section the eye hid) are dimmed as hidden in the desktop preview, those a layer above hides
saying so, keyboard focus is on the selected row before each step, and the project hides the section after the first
edit and not after the second. Per page (`layers.at300.*`, `layers.at1000.*`) and kind (`click`, `key`, `edit`), medians of
the samples: `commitMs` (for a click or key, from the event, as the page timed it, to the commit that shows the
selection; for an edit, from the editor receiving the edited project to the commit that shows it), `paintMs` (clicks and
keys: from the event to the end of the first frame painted after it), `layersMs` (React's time in Layers), and the
counts `rowRenders` (Layers rows rendered), `layersRenders` (every component rendered in Layers), `renders`, `commits`,
`findParent` and `subtreeIds` (the editor's calls of each tree scan), over the window; and `rows`, the rows Layers listed
(the shared header's and footer's too). A listener the scenario puts in the editor's page, ahead of the editor's own,
marks each click and arrow key in Layers when it happened (`layers.input`, from the event's time) and the end of the
first frame after it (`layers.painted`). The fixture's own pages are not what is measured, so `--fixture small` is
enough: Layers lists one page.

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
the longest main-process stall. For both windows, typing (`key…`) and the reply's (`stream…`, to the scenario's settle
after it), every component React rendered (`keyRenders`, `streamRenders`) and the editor page's own work as Chromium
counts it (CDP `Performance.getMetrics`, in thread time): `…Layouts` and `…LayoutMs`, `…Styles` and `…StyleMs` (style
recalculations), `…ScriptMs` and `…TaskMs` (every task on its main thread), so work moved out of the spans, a layout
left to the next frame, is still counted. They include the scenario's own checks of the page while it streams.

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

**`ai`** (after `open`): in the AI panel, in Edit mode with Whole site chosen, ask the scripted model server (native tool
mode: no live provider) for a site-wide change. Its first response asks for `read_page` and `inspect_layout` (desktop)
of each page it edits at once; its second is one `apply_operations` batch: the brand colour (`token.set`, which every
page shows) and, on each of the first three pages with a Heading, its first section repeated and that Heading changed;
its third is the answer. The request names up to four more pages, which the preview check samples for the colour: on
`small` the three starter pages are all edited and none named, on `large` three are edited and four named. Checks: the
run completed, its result names no check that could not run, the model was asked exactly three times, the project
moved one revision, holds the colour and each new heading, and so does each document on disk, the canvas preview shows
the home page's new heading, every measurement the run made answered, each phase made the measurements it should (the
reads' turn each edited page at desktop width, the baselines each edited page at phone width and each named page at
both, the finish every page edited or named), and none made after the change answered before the preview published it
(`runtime.published`). A page loaded before the change is missing the repeated section, which the editor's own check
of a measured page catches. Times from the run's span (`ai.run`): `runMs`, `replyMs` (from the request). Per measurement (main's
`ai.inspect` span, matched to the editor's loads by request): `measurements`, split by where they were made
(`toolMeasurements`, `baselineMeasurements` before the batch landed, `finalMeasurements` in the finish), `retries`
(a second load of a page that looked behind); `settleMs` (to the first load: the request reaching the editor and any wait
for the preview), `loadMs` (the frame set going to the page saying it is ready), `measureMs` (ready to answered), and in
that the page's waits for its images, fonts and a frame (`waitImagesMs`, `waitFontsMs`, `waitFrameMs`), each a median,
and their totals; `measureMsSum` (the measurements added up), `measureWallMs` (the time at least one was under way) and
`measureShare` (that, as a share of `runMs`); `baselinesMs` and `finalCheckMs` (spans); and the turn of reads:
`readTurnMs` (its span), `readTurnCalls` and `readTurnCallMsSum` (its calls added up); the longest main-process stall.

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
files and links it copied (`filesCopied`) and of those the website tools' (`toolsCopied`, during `copyTools`), the
library's files and bytes beside them, and the files and bytes of the exported folder; the longest main-process stall.
The fixture has no drafts, and only the folder format is measured.

**`import`** (after `open`): in Assets, Add images, with the chooser answered (through the driver) by 20 photographs of
12 megapixels drawn by `photos.ts` (4032 × 3024 JPEGs of about 3.2 MB with a Display P3 profile, every fourth turned by
its EXIF orientation, every fifth carrying an author and copyright; made once per machine under `.tmp/perf/photos/`), and
the import review confirmed as it opens, which adds each as a web-sized copy; until every photo is in the library with
all its copies. Checks: the review offers all 20 a web-sized copy, 20 images arrive, each a 2560-pixel JPEG turned
upright, with JPEG copies at each smaller width, WebP at those and its full width and AVIF the same or none, every file
on disk the size and format its record says, the credited photos' WebP and AVIF copies carrying their credits, each
original and its smallest copy loading from the preview, and Assets saying it added 20 images (watched for from the
confirmation on, as it says so for a few seconds, which can be before the copies are made). Times from
`import.requested` (the editor sending the confirmed import): `total` (to the commit showing every photo with all its
copies), `firstShown` (to the first commit showing any), `main` (`controller.importAssets`), `apply` (the import's first
change, the one that adds them) and `applies` (every change in `controller.importAssets`), `review`
(`controller.reviewImport`, before the request); per photo (medians): `image.ms` (its time in the main process),
`image.webMs`, `image.webDecodeMs`, `image.webCopyMs` (its web-sized copy in the media worker: the whole request, its
decodes, its resize and encode) and `image.copiesMs`, `image.copiesDecodeMs`, `image.jpegMs`, `image.webpMs`,
`image.avifMs` (its responsive copies: the whole request, its decodes, and each format's pipelines added up). The worker
reports each request it answers (`media.request`, with `stats` asked for only when marks are on): `workerRequests`,
`decodes` (pixel decodes of an encoded picture), `encodes`, `workerCpuMs` (CPU each worker used, every thread, from the first
request it was given to the last it answered, added up over the workers: divided by
`total`, the cores the import kept busy), `workers` and `workerPeakRss` (each worker's peak resident memory, added up).
Counts: file writes, durable writes and fsyncs in the import, the snapshots sent to the editor and their bytes
(`snapshotsSent`, `snapshotBytes`), `images` and `variants` added; the longest main-process stall.

**`importOriginals`** and **`importHeic`** (after `open`) add the same 20 photos another way, each with the same
checks and metrics named after it (`importOriginals.total`, …). `importOriginals` unticks every web-sized copy in the
review, one by one, before confirming it, so each 12-megapixel original is kept as it is and its copies are made from
it: each image is the very file chosen, 4032 × 3024 (3024 × 4032 turned upright), with JPEG copies at each smaller
width and WebP and AVIF at those and its full width; the worker makes no web-sized copies, so there are no `image.web…`
metrics. `importHeic` imports the photos as HEIC files, converted from the JPEGs once per machine by macOS's own
encoder (`sips`, which turns their pixels upright and keeps their credits; `photos.ts` `scenarioHeicPhotos`): the review
lists all 20 to be converted, and each arrives as a 2560-pixel JPEG web-sized copy, as `import`'s do, by way of the
system's decoder (`sips`, into a TIFF the worker reads). It runs only on macOS.

**`cmdk`** (after `open`): with nothing else open, press the command menu's shortcut and type "contact" one key every
100 ms, until the menu lists the results for the whole search. Checks: the search has the focus and holds what was
typed, the results list a page, a section placed on the site and some of the site's words, and the same search entered
at once (untimed, afterwards) lists the same rows in the same order. Times from `cmdk.requested` (the shortcut taken):
`openMs` (to the menu's first commit, `cmdk.shown`) and `openPaintMs` (to the frame after it, `cmdk.painted`); per key,
`keyMs` (median `cmdk.keystroke` span: the key's update with the React render and commit it sets off) and `keyMsTotal`,
`resultsMs` (median, from a key to the commit listing its search's results, `cmdk.results`, which may come after the
key's own) and `lastResultsMs` (the same for the last key). Counts: `keystrokes`, the rows and content rows the whole
search lists (`rows`, `contentRows`), the React commits and component renders while typing (`typeCommits`,
`typeRenders`), and from the frame watch over the typing `type.frames`, `type.droppedFrames`, `type.longestFrameMs`,
`type.longTasks` and `type.longTaskMs`.

**`assets`** (after `open`, on `large` alone): in Assets, with the library at the fixture's 300 images (`at300`) and
then at 1,000 (`at1000`: 700 more drawn as the fixture's are, written into the project and added as one change through
the editor's API, untimed, then left until nothing reloads for 3 s): show the grid by its rail button from Pages; make
an edit elsewhere (the home hero's Heading, through the editor's API) with it shown; scroll it with the wheel from its
top to its end, 400 px a notch, one every 16 ms. Checks: the library holds that many images with no files missing, the
grid starts with the first image in its order and its end shows the last, the edit is in the project, and the keyboard
walks the whole grid as before (End focuses the last image, Home the first, ArrowRight the next, ArrowDown the one a row
down, Enter opens that image and Back returns the focus to it); walked from its top to its end half a view at a time
(untimed), the tiles in the page at every stop are in the library's order, none twice, those in view one unbroken run
of it (and some), and between them every image in view, so a grid that puts only the rows in view in the page passes and
one that skips, reorders or shows no image fails. Then,
with Assets still shown, the Inspector's two pickers of library images, each opened from a section of the home page
chosen on the canvas: the image picker (`imagePicker`, the hero's Image, Choose image…) and the gallery picker (`galleryPicker`, the gallery's Choose images…). Each opens at its top with the library's
first image first in view and, scrolled (untimed) to its end, shows the last there; it is closed and the selection and the right
panel's view put back. Per library (`assets.<at>.*`): `showMs` (the rail
button's click to the first frame with the grid's tiles in view) and `picturesMs` (to the first with every tile in view
showing its picture), from a watch the scenario runs in the editor's page that reads only the tiles down to the view's
bottom; `tiles` (tiles in the page once shown) and `tilesInView`; per window (`show`, `edit`, `scroll`) `renders` (every
component React rendered), `assetsRenders` and `assetsRenderMs` (the Assets panel's, `panel.assets.*`) and
`rendererCommits`; for the edit `commitMs` (the snapshot received to the commit showing it); for the show and the scroll
the frame watch's `frames`, `droppedFrames`, `longestFrameMs`, `longTasks` and `longTaskMs`; for the scroll `ms` and
`notches` (the grid's height in notches); and at the grid's end `picturesHeld` (pictures in the grid's page loaded) and
`pictureBytes` (their decoded size, width × height × 4 bytes each); and per picker (`<picker>.*`), from the press to it open
with every option in its view showing its picture, `renders`, `rendererCommits` and `tiles` (its options in the page),
and at its end `picturesHeld` and `pictureBytes`.

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

**`noWindow`** (after `launch`, a memory scenario, macOS only: elsewhere the last window closing quits): the app with a
project open and no window, as it is after its window is closed and the app is left in the Dock. Readings at rest: a
fresh Welcome (`welcome`); the fixture opened from its card, untimed, then a page other than home chosen in Pages (the
first by address: the Business starter's About), its first section chosen in Layers and the Inspector showing it
(`canvas`); 20 s after the editor's window was closed as Close Window closes it, through the editor's leave check
(`noWindow`); and in the window the app brings up when it is activated, as a click on its Dock icon does, once it is back
where it was left (`reopened`). Then the window is closed again, that page's file changed outside the app (its first
heading, renamed over it as in `edits`), and the window brought back. Checks: everything `open` checks; the project's
lock in place and this app's while it has no window; the window brought up again on the same opening of the project at
the same revision, its canvas reporting the page it was left on ready at that revision, with the same selection on it
(the canvas's own record of it) and the Inspector naming it; the change made outside the app taken once the window is
back, one revision on, as the step Undo takes back. A busy machine's file watch can lose the system's word of a save:
the change is then saved again with the window still closed, as a person would, but never when the app's watch went
off for the save and the change was still not taken, which fails the iteration; no save is made once the window is
back. With no window the reading has no editor and no editor heap.
Growth: `memory.project.growth.*` (`canvas` − `welcome`), `memory.windowClosed.growth.*` (`noWindow` − `canvas`: what
closing the window let go of), `memory.restWithoutWindow.growth.*` (`noWindow` − `welcome`: what the open project holds
with no window, over Welcome) and `memory.windowBack.growth.*` (`reopened` − `canvas`). Times from `noWindow.reopen`
(the activation): `noWindow.reopen.windowCreated`, `.editorShown` (the new editor's first commit of the project),
`.canvasReady` (the headline: the canvas reporting the page it was left on ready at the project's revision) and, when
the preview had to start, `.runtimeReady` (its server listening); `noWindow.reopen.previewStarts` counts the preview
servers forked meanwhile; `noWindow.outside.saves` the saves the change made outside the app took (1 unless the system
lost word of one) and `noWindow.outside.takenWithoutWindow` whether it was taken before the window came back (1) or
only on its return (0). The runner's marks and readings follow the window the scenario brings up
(`ctx.win`); while there is none, marks go to the main process alone. Memory scenarios run one per `perf:run`: each
starts from a fresh Welcome on the fixture as it was put back.

**`memoryBrowse`** (after `launch`, a memory scenario like `memory`, on the large fixture only): what a session of looking
around leaves the processes holding, the preview's dev server above all. The fixture opened from its card as `open`
opens it, untimed, and read at rest on the canvas (`canvas`); then its first 20 pages of its own (`/fixture-001/` on),
each chosen in the Pages panel until the canvas shows it, ready to edit, with the card the fixture placed on it,
and read again (`pages20`); then Insert opened with all of Your components shown until the tiles in view are photographed and
quiet, and the pointer rested on 6 of the tiles in turn until the live preview beside the panel has the component
mounted and showing its heading (the editor's sizing of it afterwards is not waited for), the pointer moved away until
the last preview closes, Insert closed once its thumbnails are quiet, and read again (`previews`). Checks: everything
`open` checks, each page and each preview shown, the project unchanged. Each
reading's metrics as `memory`'s, and growth: `memory.visits.growth.*` (`pages20` − `canvas`), `memory.peeks.growth.*`
(`previews` − `pages20`) and `memory.browse.growth.*` (`previews` − `canvas`).

**`previewImages`** (after `open`, a memory scenario, on its own; `--fixture small` is enough: the page it measures is
its own): the memory of the app's processes while frames other than the canvas show a page of photographs (#1037).
Before the readings (untimed): 20 photographs written into `static/assets/` as an import stores them, each a web-sized
copy of a 12-megapixel photo (2560 × 1920) with the copies the media worker makes of it (JPEG at 160, 480, 960 and 1440,
WebP and AVIF at those and 2560; `photos.ts` `galleryPhotos`, made once per machine under `.tmp/perf/photos/`), added to
the library, each shown by a project component of its own (a heading, a line and the photo), placed one to a section
on a new Gallery page; the scripted model connected in native tool mode (no live provider) and the window reloaded; the
gallery on the canvas and the AI panel in Edit mode with Whole site chosen. Readings: at rest (`gallery`); the peak of
a turn of the scripted model that only answers in words (`chat`, the checks' control); at rest (`chatted`); the peak
while the assistant checks the gallery's layout at desktop width (`layout`: `inspect_layout`, then an answer); at rest
(`laidOut`); the peak while it checks the first photo's component (`component`: `inspect_component`, then an answer); at
rest (`inspected`); at rest with Insert open on Your components, all shown and every thumbnail drawn (each tile scrolled
into view in turn, the pointer kept off the panel) (`insertShown`); the peak while the pointer rests on the theme's first 10 section tiles in
turn, 600 ms each, each opening its larger preview, a sketch with no live frame (`hover`, the walk's control); at rest
(`hovered`); the peak while the pointer goes down Your components, each tile until the larger preview beside the panel
shows its component rendered live (`insert`: each tile scrolled into view and the pointer brought onto it once the scroll
holds still; a preview a late scroll of the panel closes, or one whose page has not said it is ready after 25 s, is
shown again by the pointer leaving and coming back once, the latter counted as `insert.retried`); and at rest once the pointer has left and the previews are gone
(`peeked`). Checks: the canvas shows the gallery with all 20 photos, the control turn took one model turn, each check
took the scripted model's two turns and
ended with nothing changed, the layout check measured the gallery with all 20 images loaded and none failed, the
component check measured the first photo's component whole (every case, none failed or left for later), no larger
preview was open before the walk, the section tiles opened their sketches with no live frame, every live preview became
ready showing its own photo loaded, the walk drew no thumbnail, no preview frame is left once they close, and the project did not move. Metrics: each reading's (`memory.<reading>…`, as `memory`'s), with growth over the checks
(`memory.inspect.growth.*`, `inspected` − `gallery`) and over the previews (`memory.previews.growth.*`, `peeked` −
`hovered`) and each window over its control's peak, what its frames cost (`memory.layoutOverChat.growth.*`,
`memory.componentOverChat.growth.*`, `memory.insertOverHover.growth.*`: the GPU process grows by some 450 MiB on a Mac
whenever the editor draws after a rest, frames or none); per window (`layout`, `component`, `insert`), the pictures its frames held when they were measured, from
the page's own report when the editor's marks are on (`pictures.<window>.measured`, `.pictures` and `.bytes`: the pixels
of the files the browser had chosen when each was measured, four bytes each, a picture offered at several widths counted
at the width of the copy it chose and in the shape its width and height give it; a live preview counted as its last
measurement found it, and all 20 of them needed; a component check's two widths both needed; a copy loaded earlier and
then replaced is not counted, so these say which copy a frame settled on, not every copy it decoded) and how far the canvas's page was scrolled when
it ended (`canvas.<window>.scrollY`); and what the two checks reported, `checks.layout.digest` and
`checks.component.digest` (a number standing for the report the model was given) and `checks.layout.documentHeight`:
the same page measured the same way gives the same, so any change there is a change in what the checks measure. On a
Mac the frames' cost lands in the GPU process (`.mem.gpu`), which draws them, more than in the preview's renderer.
Limits: a page check's frame lives for some 0.2 s, about one period of the peak's sampling (200 ms, with gaps up to 0.5 s
on a busy machine), so `layout`'s peak can miss the frame itself and is mostly the editor's own drawing (compare it with
`chat`); the controls do less than the windows they stand for (one model request against two, no tool card; 10 sketches
at a fixed pace against 20 live previews at their own); and `.mem.preview` follows the canvas frame's renderer, which
the other frames share only while Chromium puts them in the same process (their memory is in `total` and `gpu` either
way).

**`memoryPanels`** (after `launch`, on its own like `memory`): what hidden panels keep as edits and panel switches
interleave (#1041). The fixture opened from its card, untimed; every dock view (AI, Site styles, Project) and sidebar
view shown once, the two that cover the canvas (Posts' writer, the SEO view) put away again by their own buttons and
hidden from then on (a change of what covers the canvas draws every hidden panel afresh); the hero chosen in Layers and
the Inspector shown: at rest (`edit0`). Then 30 changes of the hero's Heading in the Inspector, before each another dock
view and another of Pages, Layers, Insert and Assets shown, so each hidden panel holds the revision it was last shown
at, each change applied and left 600 ms; at rest (`edit30`). Checks: everything `open` checks, the Inspector shown again
before each change naming the hero and holding the heading before it, each change shown in the preview and reported
applied by the canvas, the project 30 revisions on with the last heading in the project and on disk, and every panel
the same elements throughout; after the readings, panels shown again catching up at once with what changed while they
were hidden: the Inspector with the last change undone, Layers with the selection cleared. Metrics: each reading's, as
`memory`'s, the growth between them (`memory.panelEdits.growth.*`), and at each reading how many of the snapshots of
the project the editor's transport made (this computer's project, as the main process sends it) are still reachable
(`held.<reading>.snapshots`) and how many distinct states of the project they hold (`held.<reading>.states`, one shared
by snapshots that changed no document). The editor follows them with weak references from when the driver asks
(`__siteoriginPerf.trackHeld`, before the open; nothing is kept in any other run) and counts them on the driver's
`editor.held` mark, made straight after a garbage collection of its own and made again when a snapshot arrived in
between. Memory scenarios run one per launch: each opens the fixture as the warm-up left it.

**`reopen`** (after `launch`, a memory scenario like `memory`, on its own): the fixture opened from its card on Welcome
and closed again (Close Project), five times in one launch, each open checked as `open` checks it and waited for to the
canvas reporting that open's home page ready to edit. Readings at rest: a fresh Welcome (`welcome`), the canvas of the
first open (`canvas`), and Welcome 20 s after the first close (`closed1`) and after the fifth (`closed5`), as `memory`'s
`closed` is read. Checks: every open opened the fixture whole and writable, every close left no project open and
Welcome shown. Metrics: each reading's, as `memory`'s; and growth: `memory.close.growth.*` (`closed1` − `welcome`: what
the closed project left behind), `memory.cycles.growth.*` (`closed5` − `closed1`: what four more opens and closes added
to it) and `memory.reopen.growth.*` (`closed5` − `welcome`).

**`aiMemory`** (after `launch`, and only on its own, as `memory`): the fixture opened from its card as `open` opens it,
untimed and not read; the scripted model server connected as a local provider in native tool mode (no live provider)
and the window reloaded to take it; then in the AI panel, in Edit mode limited to the home page (This page), the request
`batch` makes: one `apply_operations` call of 30 `instance.setProp` operations on the home page's text properties, then
the model's answer. Readings: at rest with the request typed and not yet sent (`aiIdle`), sampled throughout the first
request for its peak (`aiRun`), until the preview shows the hero's new heading and the request has ended (its checks,
which ask the app for the project, come after the peak), at rest after it (`aiDone`), and after 9 more such requests in a row, in the same conversation, each one's batch worked out from the
project as it is then (`aiDone10`). Checks, for every request: it was limited to the home page, the project moved
exactly one revision and holds every text its batch wrote, so does the home page's document on disk, the log ends with
that request's own answer and no run is under way, and the canvas reported the revision applied; after the last, the
project is 10 revisions on and the scripted model was asked at least twice a request. Metrics as `memory`'s, for each
reading (`memory.aiIdle.*`, `memory.aiRun.peak.*`, `memory.aiDone.*`, `memory.aiDone10.*`), with two growths:
`memory.aiRun.growth.*` (`aiDone` − `aiIdle`: what one request left behind) and `memory.aiRuns.growth.*` (`aiDone10` −
`aiDone`: what the 9 after it left).

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
`renders` (every component React rendered), `storeUpdates` (changes of the editor's state) and `selectorRuns` (the
selectors of the editor's store hooks run, for a change or in a render, across the whole editor; the panel probes of
`panels` are the harness's and left out), `reportMs` and
`reportMsTotal` (median and sum of the `canvas.rects` and `canvas.hover` spans: one report handled with the React render
and commit it set off), `pageMeasureMs` and `pageMeasureMsTotal` (median and sum, over the reports of the outlines, of
the page's own time measuring for each, with its measurements since the report before that found nothing new: the
editor asks the page to time it while marks are on), and from a watch the scenario
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

**`drag`** (after `open`): with the home hero selected by a click on it and the page at its top, press its chip's grip and
drag it: 10 moves down the canvas, 15 into the band along its bottom edge (28 px inside it, about 440 px a second),
120 held there a pixel either way while the page scrolls under the pointer, and 15 back up to the middle of the
canvas, one move every 16 ms; 400 ms later, let it go. Checks: the page scrolled at least 300 px while the pointer was
held in the band, a drop line showed inside the part of the page the canvas shows, the drag said "Split hero after …"
as it was let go, and the release moved the hero, as one revision, at least two sections down, after the section the
drag named, with the page's other sections in the order they were. Done again when the preview loaded a page or the
project was read from disk before the release (an undo puts back a drop that landed first), as `canvas`'s windows
are; an attempt that fails holding the grip lets it go with Escape. Over the
window from the press to the release: `drag.ms`, `canvasRenders`, `dropShows` (the drag worked out where a drop would
go: a pointer move, a scroll step, a measure landing), `measures` and `listsMeasured` (the page asked where its lists
are, and how many), `scrollSteps` (steps of the edge scroll), `measureMs` (median time for the page to answer a
measure), `rendererCommits`, `renders`, and from the frame watch `frames`, `droppedFrames`, `frameMs` (the window's
length over its frames), `longestFrameMs`, `longTasks` and `longTaskMs`; the frame period at rest,
`drag.framePeriodMs`.

**`colour`** (after `open`): in Site styles, the Brand color's native picker (the first row of Basics) dragged around the
hue circle: 60 steps 5° apart, an `input` event every 16 ms as the native picker sends them, then `change` as it is let
go; until the project, the picker and the preview's primary button show the last color picked, every save has landed
and the revision has stopped moving. Checks: the project, the picker and `tokens.json` on disk hold the last color
picked, the drag made one step in History, and one undo puts the color back, in the project and the preview; the main
process began at least one of the edits before the picker was let go (the page follows a drag). Run once: a reload
the drag's own saves set off is the drag's. From the drag's first step to settled: `colour.dragMs` (first step to release), `applies` (edits
the main process took in, `controller.apply`), `appliesPerSecond` (those begun during the drag, over its length),
`queueDeepest` (the most edits in the main process at once, waiting or running), `durableWrites`, `fsyncs` and
`fileWrites` (in those edits), `lastSaveMs` (release to the last edit's answer), `settleMs` (release to the preview
showing the settled revision), `previewUpdates`, `snapshotsSent` and `snapshotBytes`, `rendererCommits`, and the
longest main-process stall.

**`thumbs`** (after `open`; run it on `large` alone: `small` has no project components): the thumbnails of Your
components in Insert, in four windows. Before them (untimed) the fixture's first card, in view in Insert, is painted on
the brand colour, so the colour change must draw it again (drawn again, the fixture's other cards come out the same).
`fill`: Insert opened (hidden until then: no thumbnail was asked for in the launch, and the project's thumbnail cache is
empty, both checked) and Show all pressed, until every tile in view in the panel's scrolling area shows its picture: the
panel filled from cold. `edit`: with Insert open,
the home hero's Heading changed through the editor's API, which cannot change how any component looks. `colour`: the
brand colour changed once (`token.set`), until the preview's primary button shows it and the card painted on it shows a
new picture. `scroll`: the last component's tile scrolled into view, until every tile in view there shows its picture. Each window ends once no thumbnail was asked for, answered or
photographed for 3.5 s and none is under way. Checks: every tile in view shows a picture and none failed, after every
window the picture each tile in view shows is the one the main process gives for the component as the project is now
(asked for after the window, so not counted in it), the edit and the colour change each moved the project one revision
(the heading in the page's document on disk, the colour in the project and on the preview's primary button), the scroll
brought tiles into view that were not before and the last tile into view, and no window was shown or focused (every
window's `show` and `focus` watched from before the first window). A fill that marks no request or photograph fails (a
build without the marks, not a free fill). Per window (`thumbs.<window>.*`): `requests` (the editor's thumbnail requests,
`thumbs.asked`), `components` (the components they named), `bytes` (their answers as IPC serializes them: a picture's
size depends on the machine's display as well as the build, the same 30 pictures 130 KiB in one launch and 1.1 MiB in
another, so compare bytes only between runs taken together and read `pictures` across launches), `pictures` (answers
carrying a picture), `captures` (photographs taken, `thumbs.captures`) and `captureMs` (their time in the hidden
window), `keys` (thumbnail keys worked out), `brands` (brand fingerprints worked out) and `keyMs` (their time in the main
process), `prepareMs` (making and writing each photograph's preview, `thumbs.prepare`), `generateMs` (making every
component preview of the window, synchronously on main, `componentPreview.generate`: the photographs' and the one Insert
shows of its own), `previewFiles` and `previewBytes` (the files those previews were made of, and their size, as made;
a window that took photographs without these marks fails), `busyMs` (from the window's start to the last thumbnail request, answer or photograph in it) and the longest
main-process stall; for `fill` and `scroll`, `ms` (to every tile in view showing its picture) and `inView` (the tiles in
view then).

## Reading and comparing results

Counts and sizes are the portable evidence: they do not depend on the machine, and two runs of the same build give the
same median. Durations are for this machine only, and move between runs; the median is what is compared, never a max or
a tail from a handful of iterations.

`perf:compare` matches cases by scenario and fixture, refuses fixtures whose hash differs and results measured
differently (`--cold` against warm, or another `--settle`), notes results from different machines (their durations do
not compare; their counts do) or website tools installed from a different template, and prints, per metric,
before and after medians, the difference, the change in percent and a verdict: `same`, `changed`, or `noise` for a
duration whose difference is within the **noise band**: three times the larger MAD of the two runs, and never under 10%
of the before median or 1 ms. A share (unit `share`, one duration as a fraction of another, shown as a percentage) has the same band, its
floor one percentage point. Two full runs of the same build on a quiet M4 Max kept every duration inside it (with
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
each; with no editor window, the main process alone), waits 1 s, reads the two heaps (the main process's alone with no
editor window: a reading says whether it expects one, `ctx.memory.rest(label, { window: false })`, and the other
fails it), and takes one sample: the process table and what the app says each process is.
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

## Prompts

`perf:prompt` measures what each model turn of an AI run sends to the provider, and how much of it the provider can
serve from its prompt cache (#977). That is visible only in what the provider receives, and the built app sends a
cloud provider's requests to that provider's own address and nowhere else, so this one is not a scenario of the built
app: it runs the orchestrator, the project session and the Anthropic and OpenAI adapters (with their SDKs, which put
each request together exactly as in the app) in-process, from source, on the fixture's project, against scripted
servers answered through the adapters' `fetch`. No network and no live provider (`prompt.ts`). It takes `--fixture`
(default both), `--iterations` (default 3, after one untimed run per case), `--out` and `--app <checkout>`, which runs
that checkout's own copy of the script in that checkout, so its source is what is measured. The result is a benchmark
result like `perf:run`'s, with the checkout's commit as its build, and `perf:compare` reads it.

The run is a site request of ten model turns, scripted the same for both providers: read the project, read the home
page, change the hero's heading, read the home page again, change the brand color, add a page of three sections, build
a new component (the one step that changes a tool on offer: the page tool can place the component from then on), read
the project's components, validate, and finish. Checks, every iteration: every scripted turn was asked for, the run
ended completed with the scripted summary, every tool call succeeded, and the project holds each change, four revisions
on. Cases: `prompt.anthropic` and `prompt.openai`, per fixture.

A request is read as the provider reads it, as blocks (`prompt-cache.ts`): the Messages API's tools, system blocks and
each message's content blocks, or the Responses API's tools, instructions and input items, each sized by its JSON as
sent without its `cache_control` marker. The Messages server applies Anthropic's documented caching rule over the run:
a prefix is kept only at a breakpoint (a marked block, or the last block when the request has a top-level
`cache_control`) of at least 2,048 bytes (the 512 tokens the bench's models need, at about four bytes a token: bytes
stand in for tokens, which only the provider counts); each breakpoint reads the longest kept prefix among the 20
positions that end at it, its own included (a run of tool_use, or of tool_result, blocks in one message being one
position); what follows the read up to the last breakpoint is written; the rest is processed afresh; entries do not expire within a run. Each server
reports usage at about four bytes a token, which is what the app records; the metrics are the bytes themselves.

Metrics, per run: `turns`; `promptBytes` (every request's prompt, added up), `firstPrompt`, `lastPrompt`;
`reusableBytes` (each request's leading blocks identical to the request before it: what any prefix cache could reuse);
`toolsChanged`, `systemChanged` and `historyRewritten` (requests whose tools, system or instructions, or a message the
request before already had, differ from the one before); `markers` (the most `cache_control` markers in one request);
`recordedCachedTokens` (the cached input tokens the run's record says it was given); `prepMs`, `prepMsMax` and
`prepMsTotal` (from the end of a turn's last tool call to the next request reaching the server: the run putting it
together). Anthropic's also: `cacheRead`, `cacheWrite`, `uncached` and `freshBytes` (written or uncached: what the
provider processed rather than read), and per turn `turnNN.cacheRead` and `turnNN.fresh`. A live provider's time to
first token, and whether its cache does what the rule says, are not measured here: a handful of live runs outside the
harness settle that.

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
(project, generated and theme pack files) and `files.hashedBytes` (the bytes those hashes ran over), `favicon.read`,
`favicon.readBytes` and `favicon.hashedBytes` (the site's favicon picture read and hashed to make its icons,
`src/main/project/site-icons.ts`; not in `files.read`), `files.stats` (a
project file looked at by its path without being read: a stat, an lstat, or a handle opened for its stat alone;
`src/main/project/stable-read.ts` and the session's publication), `fs.syncCalls` (synchronous filesystem calls on the
main process's event loop by path containment, `safeJoin`, the server-hook check and the publication), `docs.read` (canonical document files read from the project folder, also
counted in `files.read`; `src/main/project/documents.ts`), `export.filesRead`, `export.bytesRead` (what an export reads
in the main process, `src/main/export.ts`), `export.filesCopied` (files and links its copies made, `copyTree`), `ipc.projectChanged.sends`, `ipc.projectChanged.bytes` (as
IPC serializes the snapshot), `ipc.aiEvent.sends`, `ipc.aiEvent.bytes` and `ipc.aiEvent.unsized` (the assistant's
events, sized the same way), `compile.files` and `compile.svelte` (Svelte files a build check looked at, and the
compiler runs it made for them: `src/main/compile.ts`), `apply.docsCopied` (per applied edit, the canonical documents
its new state does not share with the old, `src/main/project/session.ts`), `docs.serialized` (canonical documents
serialized, `src/main/project/documents.ts`), `run.docsHashed` (documents an AI run's recovery marker hashed),
`session.reloadFromDisk`, `session.reloadUnchanged` (a reload that read the project and
found nothing changed), `tools.npmRuns` (npm runs that set up a project's website tools), `tools.idealTrees` (the npm
dependency trees worked out to check what they need, `src/main/runtime/manager.ts`), `thumbs.requests` and
`thumbs.bytes` (Insert's thumbnail requests and their answers as IPC serializes them, `src/main/controller.ts`),
`thumbs.captures` (thumbnails photographed), `thumbs.keys`, `thumbs.brands` and `thumbs.keyMs` (thumbnail keys and brand
fingerprints worked out, and the time the keys took: `src/main/runtime/component-thumbs.ts`), `componentPreview.files`
and `componentPreview.bytes` (the files an isolated component preview was made of and their size, counted as it is
made, for every caller, `src/main/controller.ts`), `main.stalls` (main), and
`react.commits`, `react.renders`
(components rendered, counted from each commit's fibers), per panel marked with `timedPanel`
(`src/renderer/src/lib/perf-panels.tsx`) `panel.<id>.renders` and `panel.<id>.renderMs` (the time between two probes
React renders before and after the panel), `chat.messageRenders` (a Chat message rendered) and `chat.textParses` (model
text read into blocks), `store.updates` (a change of the editor's state) and `store.selectorRuns` (a selector of a store
hook run, as its component renders or as the store tells it of a change, the harness's panel probes left out;
`src/renderer/src/store.ts`), `canvas.renders`,
`canvas.rectReports`, `canvas.rectReportsSame` and `canvas.hoverReports` (the `canvas` scenario's), `canvas.dropShows`, `canvas.dropMeasures`, `canvas.dropMeasured` and `canvas.dropScrolls` (a drag
onto the page, `drag`'s), `layers.rows` (a Layers row rendered), `tree.findParent` and `tree.subtreeIds` (the editor's
calls of the two scans of a tree in `src/engine/tree.ts`, counted from zero), `seo.overviews` (the SEO overview worked
out for a project state), `seo.routes` (the website read for an entry's address in its search previews) and
`chat.starters` (the AI panel's starters worked out), each counted from zero (renderer). The main process also
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
