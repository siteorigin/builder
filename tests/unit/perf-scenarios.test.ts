import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import type { ProjectState } from '../../src/shared/types';
import { Collector, Trace } from '../../scripts/perf/results';
import { ai, AI_EDIT_CASES, aiEdit, aiMeasurements, aiMemory, AI_MEMORY_RUNS, aiMemoryReply, BATCH_REPLY, batch, BATCH_OPERATIONS, batchOperations, canvas, chainFor, chat, CHAT_CASES, CHAT_REPLY_CHECKPOINTS, CHAT_TYPED, chatReply, chatReplyFirst, chatReplyLast, chatSeed, colour, COLOUR_STEPS, colourPath, copiesProblem, coveredMs, create, createAgain, deepest, drag, edit, editBranded, editFullHistory, edits, namedFaces, EDITS, expect as check, expectedCopies, exportAgain, exportSite, findHeading, type FixtureFacts, importHeic, importOriginals, importPhotos, installedPackages, installsHere, launch, memory, MEMORY_EDITS, noWindow, memoryPanels, PANEL_DOCK_VIEWS, PANEL_EDITS, PANEL_SIDE_TURNS, PANEL_SIDE_VIEWS, open, reopen, REOPEN_CYCLES, PANELS, panels, panelsInUse, runChain, SITE_WORK, type Scenario, type ScenarioContext, SHOWN_PANELS, storedPhotoSize, switchProject, THUMB_WINDOWS, thumbs, toolCallsReply, layers, LAYERS_KINDS, LAYERS_SAMPLES, LAYERS_SIZES, layersAncestors, layersPage, type LayersKind, history, HISTORY_WINDOWS } from '../../scripts/perf/scenarios';
import type { MemoryProbe, MemoryReading } from '../../scripts/perf/memory';
import { PHOTO_COUNT, photoSpec } from '../../scripts/perf/photos';
import { FIXTURES } from '../../scripts/perf/fixtures';
import { PROJECT_DEFINITION_ID } from '../../src/shared/component-ids';
import { framesOf, cmdk, CMDK_QUERY, assets, ASSET_LIBRARIES, ASSET_PICKERS, grownImages, GALLERY_PAGE, galleryComponent, galleryDefinitionId, galleryPlacements, galleryRecord, PREVIEW_IMAGE_READINGS, previewImages, windowPictures, memoryBrowse, BROWSE_PAGES, BROWSE_PREVIEWS, fixturePages } from '../../scripts/perf/scenarios';

let seq = 0;
const m = (name: string, t: number, extra: Partial<PerfRecord> = {}): PerfRecord => ({ kind: 'mark', name, t, proc: 'main', pid: 1, seq: ++seq, ...extra });
const r = (name: string, t: number, extra: Partial<PerfRecord> = {}) => m(name, t, { proc: 'renderer', pid: 2, ...extra });
const span = (name: string, t: number, ms: number, extra: Partial<PerfRecord> = {}) => m(name, t, { kind: 'span', ms, ...extra });

const facts: FixtureFacts = { spec: FIXTURES.small, pages: 3, entries: 0, assets: 0, projectComponents: 0, homePageId: 'pg_home', homeRoute: '/', heroId: 'n_hero', heading: 'Welcome' };

describe('the scenario chain', () => {
  it('runs each scenario after the ones it follows', () => {
    expect(chainFor(['edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit']);
    expect(chainFor(['edits']).map((s) => s.name)).toEqual(['launch', 'open', 'edits']);
    expect(chainFor(['history']).map((s) => s.name)).toEqual(['launch', 'open', 'history']);
    expect(chainFor(['history', 'edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit', 'history']);
    // After the others that edit the fixture's own copy, so none of them inherits its saved versions; before editBranded.
    expect(chainFor(['editBranded', 'history', 'batch']).map((s) => s.name)).toEqual(['launch', 'open', 'batch', 'history', 'editBranded']);
    expect(chainFor(['chat']).map((s) => s.name)).toEqual(['launch', 'open', 'chat']);
    expect(chainFor(['aiEdit']).map((s) => s.name)).toEqual(['launch', 'open', 'aiEdit']);
    expect(chainFor(['open']).map((s) => s.name)).toEqual(['launch', 'open']);
    expect(chainFor(['launch']).map((s) => s.name)).toEqual(['launch']);
    expect(chainFor(['edit', 'launch', 'open']).map((s) => s.name)).toEqual(['launch', 'open', 'edit']);
    expect(chainFor(['panels']).map((s) => s.name)).toEqual(['launch', 'open', 'panels']);
    expect(chainFor(['panels', 'edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit', 'panels']);
    expect(chainFor(['export']).map((s) => s.name)).toEqual(['launch', 'open', 'export']);
    expect(chainFor(['exportAgain']).map((s) => s.name)).toEqual(['launch', 'open', 'export', 'exportAgain']);
    expect(chainFor(['export', 'exportAgain']).map((s) => s.name)).toEqual(['launch', 'open', 'export', 'exportAgain']);
    expect(chainFor(['switch']).map((s) => s.name)).toEqual(['launch', 'open', 'switch']);
    // Last of those that follow open: the others measure the fixture's own copy, which switch leaves.
    expect(chainFor(['switch', 'edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit', 'switch']);
    expect(chainFor(['canvas']).map((s) => s.name)).toEqual(['launch', 'open', 'canvas']);
    expect(chainFor(['ai']).map((s) => s.name)).toEqual(['launch', 'open', 'ai']);
    expect(chainFor(['import']).map((s) => s.name)).toEqual(['launch', 'open', 'import']);
    expect(chainFor(['switch', 'import']).map((s) => s.name)).toEqual(['launch', 'open', 'import', 'switch']);
    // Made from Welcome after launch, and the second project after the first.
    expect(chainFor(['create']).map((s) => s.name)).toEqual(['launch', 'create']);
    expect(chainFor(['createAgain']).map((s) => s.name)).toEqual(['launch', 'create', 'createAgain']);
    expect(chainFor(['drag']).map((s) => s.name)).toEqual(['launch', 'open', 'drag']);
    expect(chainFor(['colour', 'drag']).map((s) => s.name)).toEqual(['launch', 'open', 'drag', 'colour']);
    // The command menu before the library is grown, and both before switch.
    expect(chainFor(['assets', 'cmdk']).map((s) => s.name)).toEqual(['launch', 'open', 'cmdk', 'assets']);
    expect(chainFor(['switch', 'assets']).map((s) => s.name)).toEqual(['launch', 'open', 'assets', 'switch']);
    // Before import, which adds to the library assets measures at the fixture's own size.
    expect(chainFor(['import', 'assets']).map((s) => s.name)).toEqual(['launch', 'open', 'assets', 'import']);
    // After every other scenario that edits the fixture's own copy, since it leaves the site a favicon and a new font.
    expect(chainFor(['editBranded', 'edit', 'import']).map((s) => s.name)).toEqual(['launch', 'open', 'edit', 'import', 'editBranded']);
    expect(chainFor(['switch', 'editBranded']).map((s) => s.name)).toEqual(['launch', 'open', 'editBranded', 'switch']);
    expect(chainFor([])).toEqual([]);
    expect(() => chainFor(['nope'])).toThrow('Unknown scenario');
  });

  const fake = (name: string, how: { run?: () => Promise<void>; missing?: string[] } = {}): Scenario => ({
    name,
    after: null,
    description: name,
    run: how.run ?? (async () => {}),
    measure: () => {
      const c = new Collector();
      for (const x of how.missing ?? []) c.need(x, undefined);
      c.count(`${name}.n`, 1);
      return c;
    }
  });
  const ctx = { fixture: facts } as unknown as ScenarioContext;
  const trace = async () => new Trace([]);

  it('stops at a scenario that did not get the app where the next starts, and says why', async () => {
    const out = await runChain([fake('a'), fake('b', { run: async () => check(false, 'the preview never showed it') }), fake('c')], ctx, trace, 1000);
    expect(out.map((o) => [o.scenario, o.ok, o.error?.stage, o.error?.message])).toEqual([
      ['a', true, undefined, undefined],
      ['b', false, 'b', 'predicate: the preview never showed it'],
      ['c', false, 'b', 'not run: b failed (predicate: the preview never showed it)']
    ]);
    expect(out[0].metrics).toEqual({ 'a.n': { unit: 'count', value: 1 } });
  });

  it('fails only the scenario whose trace lacks a mark, and goes on', async () => {
    const out = await runChain([fake('a', { missing: ['launch.loadPacks'] }), fake('b')], ctx, trace, 1000);
    expect(out.map((o) => [o.scenario, o.ok, o.error?.message ?? null])).toEqual([
      ['a', false, 'missing from the trace: launch.loadPacks'],
      ['b', true, null]
    ]);
  });

  it('fails a scenario on a trace with a broken line, and one that runs past its deadline', async () => {
    const broken = await runChain([fake('a')], ctx, async () => new Trace([], true), 1000);
    expect(broken[0]).toMatchObject({ ok: false, error: { message: 'the trace has a line that could not be read' } });
    const slow = await runChain([fake('a', { run: () => new Promise(() => {}) }), fake('b')], ctx, trace, 20);
    expect(slow.map((o) => o.error?.message)).toEqual(['a did not finish within 0s', 'not run: a failed (a did not finish within 0s)']);
  });
});

describe('launch metrics', () => {
  it('time every milestone from the process being created', () => {
    const t = new Trace([
      m('launch.processStart', 1000),
      m('launch.mainLoaded', 1150),
      m('launch.appReady', 1200),
      span('main.stall', 1180, 60),
      span('launch.loadPacks', 1350, 140),
      m('launch.windowCreated', 1400, { c: { 'files.read': 40, 'files.hashed': 38 } }),
      r('launch.pageStart', 1405),
      r('launch.pageParsed', 1430),
      r('launch.scriptStart', 1510),
      r('launch.scriptEvaluated', 1570),
      m('launch.readyToShow', 1600),
      r('launch.catalogueReceived', 1610),
      r('launch.firstRender', 1620),
      r('launch.firstInteractive', 1640),
      r('launch.recentsShown', 1660, { c: { 'react.commits': 5 } }),
      // After the window of the launch: not its stall.
      span('main.stall', 5000, 900)
    ]);
    const got = launch.measure(t, facts);
    expect(got.missing).toEqual([]);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]))).toEqual({
      'launch.mainLoaded': '150 ms',
      'launch.appReady': '200 ms',
      'launch.windowCreated': '400 ms',
      'launch.readyToShow': '600 ms',
      'launch.firstRender': '620 ms',
      'launch.firstInteractive': '640 ms',
      'launch.recentsShown': '660 ms',
      'launch.pageStart': '405 ms',
      'launch.pageParsed': '430 ms',
      'launch.scriptStart': '510 ms',
      'launch.scriptEvaluated': '570 ms',
      'launch.catalogueReceived': '610 ms',
      'launch.scriptCompile': '80 ms',
      'launch.scriptEvaluate': '60 ms',
      'launch.windowToFirstRender': '220 ms',
      'launch.windowToWelcome': '260 ms',
      'launch.loadPacks': '140 ms',
      'launch.rendererCommits': '5 count',
      'launch.filesReadBeforeWindow': '40 count',
      'launch.filesHashedBeforeWindow': '38 count',
      'launch.mainStallMax': '60 ms'
    });
    for (const drop of ['launch.windowCreated', 'launch.readyToShow', 'launch.scriptStart', 'launch.pageParsed', 'launch.catalogueReceived']) expect(launch.measure(new Trace(t.records.filter((x) => x.name !== drop)), facts).missing).toEqual([drop]);
    // Interactive after its recents were listed: the later of the two is the Welcome screen.
    const late = new Trace(t.records.map((x) => (x.name === 'launch.firstInteractive' ? { ...x, t: 1700 } : x)));
    expect(launch.measure(late, facts).metrics['launch.windowToWelcome']).toEqual({ unit: 'ms', value: 300 });
    // The script's marks are the editor's own: the same names from the main process are not them.
    const fromMain = new Trace(t.records.map((x) => (x.name === 'launch.scriptStart' ? { ...x, proc: 'main' as const } : x)));
    expect(launch.measure(fromMain, facts).missing).toEqual(['launch.scriptStart']);
  });
});

describe('open metrics', () => {
  const trace = (drop: (x: PerfRecord) => boolean = () => false) =>
    new Trace(
      [
        // An earlier open, before this scenario: never its request.
        r('open.requested', 100),
        r('scenario.start', 900, { attrs: { scenario: 'open' } }),
        m('scenario.start', 900, { attrs: { scenario: 'open' }, c: { 'files.read': 40, 'docs.read': 0, 'files.hashed': 38, 'fs.durableWrites': 0, 'fs.fsyncs': 1 } }),
        r('open.requested', 1000, { c: { 'react.commits': 6 } }),
        span('session.open.formatCheck', 1004, 3, { dc: { 'files.read': 4, 'docs.read': 4 } }),
        span('session.open.lock', 1010, 5),
        span('session.open.prepare', 1011, 1),
        span('session.open.recover', 1012, 1),
        span('session.open.read', 1030, 15),
        span('session.open.localState', 1032, 1),
        span('session.open.validate', 1050, 16),
        span('session.generate', 1100, 30, { attrs: { variant: 'clean' } }),
        span('session.generate', 1125, 25, { attrs: { variant: 'dev' } }),
        span('session.publish', 1600, 540, { attrs: { initial: false }, dc: { 'files.read': 100, 'files.hashed': 200, 'fs.writes': 2, 'fs.syncCalls': 900, 'files.stats': 300, 'files.hashedBytes': 4_000_000 } }),
        span('session.sweep', 1602, 1),
        span('session.open', 1603, 600, { dc: { 'files.read': 170, 'docs.read': 12, 'files.hashed': 210, 'fs.durableWrites': 1, 'fs.fsyncs': 4 } }),
        span('controller.open', 1690, 680),
        m('controller.snapshotSent', 1700, { attrs: { revision: 0, bytes: 300 } }),
        span('controller.assetCheck', 1701, 1),
        span('controller.attach', 1705, 15, { dc: { 'files.read': 3, 'fs.durableWrites': 1, 'fs.fsyncs': 2 } }),
        r('renderer.commit', 1720, { attrs: { revision: null, screen: 'welcome' } }),
        r('renderer.commit', 1730, { attrs: { revision: 0, screen: 'editor' } }),
        m('runtime.forked', 1740, { attrs: { worker: 1 } }),
        m('runtime.started', 1790, { attrs: { worker: 1 } }),
        m('runtime.viteLoaded', 1850, { attrs: { worker: 1 } }),
        m('runtime.serverCreated', 1950, { attrs: { worker: 1 } }),
        m('runtime.ready', 2000, { attrs: { worker: 1 } }),
        span('controller.startRuntime', 2001, 290, { dc: { 'files.read': 4, 'files.hashed': 1 } }),
        // A later publication's generation (the site's icons, say): not the open's.
        span('session.generate', 2050, 40, { attrs: { variant: 'clean' } }),
        m('controller.snapshotSent', 2002, { attrs: { revision: 0, bytes: 200 } }),
        m('runtime.firstRequest', 2030, { attrs: { worker: 1 } }),
        m('runtime.firstResponse', 2250, { attrs: { worker: 1 } }),
        // Not the home page ready to edit: Preview mode, a component preview, another page.
        r('canvas.ready', 2100, { attrs: { revision: 0, path: '/', mode: 'preview', studio: false } }),
        r('canvas.ready', 2200, { attrs: { revision: 0, path: '/', mode: 'edit', studio: true } }),
        r('canvas.ready', 2300, { attrs: { revision: 0, path: '/about/', mode: 'edit', studio: false } }),
        r('canvas.ready', 2500, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false }, c: { 'react.commits': 20 } }),
        // After the canvas was ready: counted as a reload, not as a snapshot of the open.
        m('controller.snapshotSent', 2600, { attrs: { revision: 0, bytes: 9999 } }),
        m('session.reloadFromDisk', 3000),
        m('scenario.end', 4000, { attrs: { scenario: 'open' }, c: { 'files.read': 217, 'docs.read': 12, 'files.hashed': 249, 'fs.durableWrites': 2, 'fs.fsyncs': 7 } }),
        m('session.reloadFromDisk', 4500)
      ].filter((x) => !drop(x))
    );

  it('time the open from the click to the home page ready to edit', () => {
    const got = open.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect(v('open.canvasReady')).toBe(1500);
    expect([v('open.controller'), v('open.session'), v('open.publish'), v('open.attach'), v('open.startRuntime')]).toEqual([680, 600, 540, 15, 290]);
    expect([v('open.session.formatCheck'), v('open.session.lock'), v('open.session.prepare'), v('open.session.read'), v('open.session.validate'), v('open.sweep')]).toEqual([3, 5, 1, 15, 16, 1]);
    // What the first snapshot waited for: both generations and the sweep, not the asset check that ended after it.
    expect([v('open.generationsBeforeSnapshot'), v('open.sweepsBeforeSnapshot'), v('open.assetChecksBeforeSnapshot')]).toEqual([2, 1, 0]);
    expect([v('open.generate'), v('open.docsRead')]).toEqual([55, 12]);
    expect([v('open.firstSnapshotSent'), v('open.editorShown'), v('open.runtimeForked'), v('open.runtimeReady')]).toEqual([700, 730, 740, 1000]);
    expect([v('open.runtimeStarted'), v('open.runtimeViteLoaded'), v('open.runtimeServerCreated'), v('open.runtimeFirstRequest'), v('open.runtimeFirstResponse')]).toEqual([790, 850, 950, 1030, 1250]);
    // Fork to listening, listening to the first page answered, that answer to the canvas ready; the editor shown to it.
    expect([v('open.forkToListen'), v('open.listenToFirstResponse'), v('open.firstResponseToCanvasReady'), v('open.editorToCanvasReady')]).toEqual([260, 250, 250, 770]);
    expect([v('open.filesRead'), v('open.filesHashed'), v('open.durableWrites'), v('open.fsyncs')]).toEqual([177, 211, 2, 6]);
    expect([v('open.publishFilesRead'), v('open.publishFilesHashed'), v('open.publishFilesWritten')]).toEqual([100, 200, 2]);
    expect([v('open.publishSyncCalls'), v('open.publishStats'), v('open.publishBytesHashed')]).toEqual([900, 300, 4_000_000]);
    expect(got.metrics['open.publishBytesHashed']?.unit).toBe('bytes');
    expect([v('open.snapshotsSent'), v('open.snapshotBytes'), v('open.reloadFromDisk'), v('open.rendererCommits')]).toEqual([2, 500, 1, 14]);
    expect(got.metrics['open.snapshotBytes'].unit).toBe('bytes');
  });

  it('name what is missing instead of timing another event', () => {
    expect(open.measure(trace((x) => x.name === 'canvas.ready' && x.t === 2500), facts).missing).toEqual(['canvas.ready']);
    expect(open.measure(trace((x) => x.name === 'canvas.ready' && x.t === 2500), facts).metrics['open.canvasReady']).toBeUndefined();
    expect(open.measure(trace((x) => x.name === 'scenario.end'), facts).missing).toEqual(['scenario.end (main)']);
    expect(open.measure(trace((x) => x.name === 'session.publish'), facts).missing).toEqual(['session.publish']);
    expect(open.measure(trace((x) => x.name === 'session.sweep'), facts).missing).toEqual(['session.sweep']);
    expect(open.measure(trace((x) => x.name === 'scenario.start' && x.proc === 'main'), facts).missing).toEqual(['scenario.start (main)']);
    // A new project's first publication is never taken for the open's.
    const created = new Trace(trace().records.map((x) => (x.name === 'session.publish' ? { ...x, attrs: { initial: true } } : x)));
    expect(open.measure(created, facts).missing).toEqual(['session.publish']);
    expect(open.measure(trace((x) => x.name === 'session.open.formatCheck'), facts).missing).toEqual(['session.open.formatCheck']);
    expect(open.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'clean' && x.t < 2000), facts).missing).toEqual(['session.generate (clean)']);
    const noDev = open.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'dev'), facts);
    expect(noDev.missing).toEqual(['session.generate (dev)']);
    expect(noDev.metrics['open.generate']).toBeUndefined();
    expect(open.measure(trace((x) => x.name === 'runtime.firstResponse'), facts).missing).toEqual(['runtime.firstResponse']);
    // Another preview process's marks are never taken for this one's.
    const other = trace((x) => x.name === 'runtime.viteLoaded');
    const moved = new Trace([...other.records, m('runtime.viteLoaded', 1860, { attrs: { worker: 2 } })]);
    expect(open.measure(moved, facts).missing).toEqual(['runtime.viteLoaded']);
  });

  it('find the publication and the sweep after the first snapshot, and still count what they did', () => {
    // The publication (1,760 to 2,300) and its generations after the editor's first snapshot (1,700), the sweep after
    // the canvas is ready; a later publication's generation after it.
    const later = new Map<string, number>([
      ['session.publish', 2300],
      ['session.sweep', 3500]
    ]);
    const moved = new Trace(
      trace().records.map((x) => {
        if (x.name === 'session.generate') return { ...x, t: x.t < 2000 ? x.t + 700 : 2900 };
        return later.has(x.name) ? { ...x, t: later.get(x.name)! } : x;
      })
    );
    const got = moved.records.length ? open.measure(moved, facts) : null;
    expect(got?.missing).toEqual([]);
    const v = (k: string) => got?.metrics[k]?.value;
    expect([v('open.publish'), v('open.generate'), v('open.sweep')]).toEqual([540, 55, 1]);
    expect([v('open.generationsBeforeSnapshot'), v('open.sweepsBeforeSnapshot'), v('open.assetChecksBeforeSnapshot')]).toEqual([0, 0, 0]);
    // Counted from the scenario's start to its end, wherever in it the work ran.
    expect([v('open.filesRead'), v('open.docsRead'), v('open.filesHashed'), v('open.durableWrites'), v('open.fsyncs')]).toEqual([177, 12, 211, 2, 6]);
  });

  it('count an asset check that ended before the first snapshot as one the snapshot waited for', () => {
    const awaited = new Trace(trace().records.map((x) => (x.name === 'controller.assetCheck' ? { ...x, t: 1699 } : x)));
    expect(open.measure(awaited, facts).metrics['open.assetChecksBeforeSnapshot']?.value).toBe(1);
  });
});

describe('switch metrics', () => {
  const trace = (drop: (x: PerfRecord) => boolean = () => false) =>
    new Trace(
      [
        // The first project, opened before the switch: its preview process is worker 1.
        r('scenario.start', 50, { attrs: { scenario: 'open' } }),
        r('open.requested', 100),
        m('runtime.forked', 700, { attrs: { worker: 1 } }),
        m('runtime.ready', 1200, { attrs: { worker: 1 } }),
        r('canvas.ready', 1500, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false } }),
        r('scenario.start', 5000, { attrs: { scenario: 'switch' } }),
        m('scenario.start', 5000, { attrs: { scenario: 'switch' } }),
        r('open.requested', 5010),
        span('session.open', 5600, 580),
        span('controller.close', 5900, 290),
        // The first project's canvas, reporting again while it goes: never the second project's.
        r('canvas.ready', 5905, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false } }),
        m('runtime.exited', 5880, { attrs: { worker: 1 } }),
        span('controller.attach', 5920, 15),
        m('runtime.forked', 5930, { attrs: { worker: 2 } }),
        span('controller.open', 5935, 925),
        m('runtime.started', 5980, { attrs: { worker: 2 } }),
        m('runtime.viteLoaded', 6100, { attrs: { worker: 2 } }),
        m('runtime.serverCreated', 6400, { attrs: { worker: 2 } }),
        m('runtime.ready', 6500, { attrs: { worker: 2 } }),
        span('controller.startRuntime', 6501, 580),
        m('runtime.firstRequest', 6530, { attrs: { worker: 2 } }),
        m('runtime.firstResponse', 6800, { attrs: { worker: 2 } }),
        r('canvas.ready', 7210, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false } }),
        m('scenario.end', 9000, { attrs: { scenario: 'switch' } })
      ].filter((x) => !drop(x))
    );

  it('time the switch from the request to the second project’s home page ready to edit, by its own preview process', () => {
    const got = switchProject.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect(v('switch.canvasReady')).toBe(2200);
    expect([v('switch.controller'), v('switch.session'), v('switch.close'), v('switch.attach'), v('switch.startRuntime')]).toEqual([925, 580, 290, 15, 580]);
    expect([v('switch.runtimeForked'), v('switch.runtimeViteLoaded'), v('switch.runtimeReady'), v('switch.runtimeFirstResponse')]).toEqual([920, 1090, 1490, 1790]);
    expect([v('switch.forkToListen'), v('switch.listenToFirstResponse'), v('switch.firstResponseToCanvasReady')]).toEqual([570, 300, 410]);
    expect(v('switch.oldServerExited')).toBe(870);
  });

  it('name what is missing: the second canvas, its server’s marks, or the first server never stopping', () => {
    expect(switchProject.measure(trace((x) => x.name === 'canvas.ready' && x.t === 7210), facts).missing).toEqual(['canvas.ready']);
    expect(switchProject.measure(trace((x) => x.name === 'runtime.ready' && x.attrs?.worker === 2), facts).missing).toEqual(['canvas.ready']);
    expect(switchProject.measure(trace((x) => x.name === 'runtime.exited'), facts).missing).toEqual(['runtime.exited (the first project’s)']);
    expect(switchProject.measure(trace((x) => x.name === 'controller.close'), facts).missing).toEqual(['controller.close']);
  });

  it('take the second project’s canvas only once it is attached, and the marks of the preview process that served it', () => {
    // The second project's preview started while it opened, listening before the first project's canvas let go; a
    // process started for it and stopped unused (its opening's publication changed files) is never the one timed.
    const t = new Trace([
      r('scenario.start', 50, { attrs: { scenario: 'open' } }),
      r('open.requested', 100),
      m('runtime.forked', 200, { attrs: { worker: 1 } }),
      m('runtime.ready', 700, { attrs: { worker: 1 } }),
      r('canvas.ready', 1000, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false } }),
      r('scenario.start', 5000, { attrs: { scenario: 'switch' } }),
      r('open.requested', 5010),
      m('runtime.forked', 5100, { attrs: { worker: 2 } }),
      m('runtime.ready', 5500, { attrs: { worker: 2 } }),
      // The first project's canvas, still shown and reporting again: before the second project is attached.
      r('canvas.ready', 5600, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false } }),
      span('session.open', 5650, 640),
      m('runtime.exited', 5700, { attrs: { worker: 2 } }),
      m('runtime.forked', 5710, { attrs: { worker: 3 } }),
      m('runtime.started', 5750, { attrs: { worker: 3 } }),
      m('runtime.viteLoaded', 5800, { attrs: { worker: 3 } }),
      span('controller.close', 5900, 240),
      m('runtime.exited', 5950, { attrs: { worker: 1 } }),
      span('controller.attach', 5960, 50),
      span('controller.open', 5965, 955),
      m('runtime.serverCreated', 6000, { attrs: { worker: 3 } }),
      m('runtime.ready', 6100, { attrs: { worker: 3 } }),
      span('controller.startRuntime', 6110, 100),
      m('runtime.firstRequest', 6120, { attrs: { worker: 3 } }),
      m('runtime.firstResponse', 6400, { attrs: { worker: 3 } }),
      r('canvas.ready', 6700, { attrs: { revision: 0, path: '/', mode: 'edit', studio: false } })
    ]);
    const got = switchProject.measure(t, facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect(v('switch.canvasReady')).toBe(1690);
    expect([v('switch.runtimeForked'), v('switch.runtimeReady'), v('switch.forkToListen'), v('switch.firstResponseToCanvasReady')]).toEqual([700, 1090, 390, 300]);
    expect(v('switch.oldServerExited')).toBe(940);
  });
});

describe('edit metrics', () => {
  const base = 7;
  const target = 8;
  function trace(drop: (x: PerfRecord) => boolean = () => false) {
    return new Trace(
      [
        r('scenario.start', 9000, { attrs: { scenario: 'edit' }, c: { 'react.commits': 100 } }),
        m('scenario.start', 9000, { attrs: { scenario: 'edit' } }),
        // Before the edit: none of its checks.
        span('session.check', 9500, 99, { attrs: { check: 'updates' } }),
        r('edit.requested', 10_000, { attrs: { revision: base, operations: 1 }, c: { 'react.commits': 110, 'collections.siteEntries': 4 } }),
        // Another revision's records inside the window: never taken for this edit.
        r('canvas.revisionApplied', 10_002, { attrs: { revision: base } }),
        m('session.changed', 10_003, { attrs: { revision: base } }),
        m('controller.snapshotSent', 10_004, { attrs: { revision: base, bytes: 5 } }),
        span('controller.apply', 10_005, 4, { attrs: { revision: base }, dc: { 'fs.durableWrites': 99 } }),
        span('session.validateOperations', 10_010, 1),
        // The batch's checks once it is applied, and the item styles swept after each operation.
        span('apply.itemStyles', 10_010.5, 0.25),
        span('apply.syncedEntries', 10_011, 0.25),
        span('apply.itemStates', 10_011.25, 0.25),
        span('apply.collectionSources', 10_011.5, 0.25),
        span('apply.dependencies', 10_011.75, 0.25),
        span('apply.batchChecks', 10_011.75, 1),
        span('session.applyOperations', 10_012, 2),
        span('session.check', 10_019, 4, { attrs: { check: 'saving' } }),
        span('session.validateState', 10_020, 5),
        span('session.generate', 10_030, 4, { attrs: { variant: 'clean' } }),
        m('session.generateCheck', 10_030, { attrs: { variant: 'clean', ms: 1.5, files: 40, looked: 900, derived: 30 } }),
        span('session.generate', 10_034, 3, { attrs: { variant: 'dev' } }),
        m('session.generateCheck', 10_034, { attrs: { variant: 'dev', ms: 1, files: 40, looked: 12, derived: 0 } }),
        span('session.changedDocs', 10_036, 2, { attrs: { docs: 20, changed: 1 } }),
        span('session.publish', 10_080, 30, { dc: { 'files.read': 1, 'files.hashed': 13, 'files.hashedBytes': 52_000, 'fs.writes': 5, 'fs.durableWrites': 3, 'fs.fsyncs': 6, 'fs.syncCalls': 410, 'files.stats': 120 } }),
        m('runtime.release', 10_082),
        // A sweep the save waited on, before the edit was acknowledged.
        span('session.sweep', 10_099, 12),
        span('session.persist', 10_100, 70),
        m('session.changed', 10_101, { attrs: { revision: target } }),
        // The snapshot's checks and values of the new state.
        span('session.check', 10_103, 6, { attrs: { check: 'diagnostics' } }),
        span('session.check', 10_103.5, 2, { attrs: { check: 'usages' } }),
        span('session.check', 10_104, 3, { attrs: { check: 'updates' } }),
        span('session.versionsInfo', 10_104.5, 1, { attrs: { versions: 0 } }),
        span('controller.snapshot', 10_104.75, 12, { attrs: { revision: target } }),
        m('controller.snapshotSent', 10_105, { attrs: { revision: target, bytes: 120_000 } }),
        span('session.apply', 10_106, 95, { attrs: { revision: target } }),
        span('controller.apply', 10_107, 105, { attrs: { revision: target }, dc: { 'fs.durableWrites': 9, 'fs.fsyncs': 19, 'fs.writes': 11, 'fs.syncCalls': 450, 'files.stats': 130, 'files.hashedBytes': 60_000, 'apply.docsCopied': 20, 'docs.serialized': 20 } }),
        r('renderer.snapshotReceived', 10_108, { attrs: { revision: target } }),
        m('runtime.published', 10_110, { attrs: { revision: target } }),
        r('renderer.commit', 10_115, { attrs: { revision: target } }),
        span('main.stall', 10_120, 70),
        r('canvas.revisionApplied', 10_140, { attrs: { revision: target } }),
        m('session.reloadFromDisk', 10_500),
        // A later snapshot of the same state: its checks are kept, its version sizes worked out again.
        span('session.versionsInfo', 10_599, 1, { attrs: { versions: 0 } }),
        span('controller.snapshot', 10_599.5, 2, { attrs: { revision: target } }),
        m('controller.snapshotSent', 10_600, { attrs: { revision: target, bytes: 1000 } }),
        // One run after the acknowledgement: counted as a sweep, not as one the edit waited on.
        span('session.sweep', 10_700, 5),
        m('scenario.end', 11_640, { attrs: { scenario: 'edit' } }),
        r('scenario.end', 11_641, { attrs: { scenario: 'edit' }, c: { 'react.commits': 160, 'collections.siteEntries': 7 } }),
        // After the scenario: none of its counts.
        m('session.reloadFromDisk', 12_000),
        span('session.check', 12_000.5, 50, { attrs: { check: 'diagnostics' } }),
        m('controller.snapshotSent', 12_001, { attrs: { revision: target, bytes: 7 } }),
        span('main.stall', 12_002, 900),
        span('session.sweep', 12_003, 40)
      ].filter((x) => !drop(x))
    );
  }

  it('time an edit from the editor sending it, by the revision it made', () => {
    const got = edit.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]))).toEqual({
      'edit.apply': '105 ms',
      'edit.sessionApply': '95 ms',
      'edit.validateOperations': '1 ms',
      'edit.applyOperations': '2 ms',
      'edit.validate': '5 ms',
      'edit.generate': '7 ms',
      'edit.generateCheck': '2.5 ms',
      'edit.generateLooked': '912 count',
      'edit.generateDerived': '30 count',
      'edit.changedDocs': '2 ms',
      'edit.docsCopied': '20 count',
      'edit.docsSerialized': '20 count',
      'edit.persist': '70 ms',
      'edit.publish': '30 ms',
      'edit.hmrRelease': '82 ms',
      'edit.changed': '101 ms',
      'edit.snapshotSent': '105 ms',
      'edit.snapshotReceived': '108 ms',
      'edit.rendererCommit': '115 ms',
      'edit.changedToSent': '4 ms',
      'edit.sentToReceived': '3 ms',
      'edit.receivedToCommit': '7 ms',
      'edit.previewPublished': '110 ms',
      'edit.previewApplied': '140 ms',
      'edit.durableWrites': '9 count',
      'edit.fsyncs': '19 count',
      'edit.fileWrites': '11 count',
      'edit.syncCalls': '450 count',
      'edit.fileStats': '130 count',
      'edit.bytesHashed': '60000 bytes',
      'edit.publishFilesRead': '1 count',
      'edit.publishFilesHashed': '13 count',
      'edit.publishBytesHashed': '52000 bytes',
      'edit.publishFilesWritten': '5 count',
      'edit.publishDurableWrites': '3 count',
      'edit.publishFsyncs': '6 count',
      'edit.publishSyncCalls': '410 count',
      'edit.publishStats': '120 count',
      'edit.sweepsAwaited': '1 count',
      'edit.sweepAwaited': '12 ms',
      'edit.sweeps': '2 count',
      'edit.snapshotsSent': '3 count',
      'edit.snapshotBytes': '121005 bytes',
      'edit.reloadFromDisk': '1 count',
      'edit.rendererCommits': '50 count',
      'edit.siteEntryWalks': '3 count',
      'edit.mainStallMax': '70 ms',
      'edit.batchChecks': '1 ms',
      'edit.batchSyncedEntries': '0.25 ms',
      'edit.batchItemStates': '0.25 ms',
      'edit.batchCollectionSources': '0.25 ms',
      'edit.batchDependencies': '0.25 ms',
      'edit.itemStyles': '0.25 ms',
      'edit.itemStylesRuns': '1 count',
      'edit.saveCheck': '4 ms',
      'edit.saveCheckRuns': '1 count',
      'edit.diagnostics': '6 ms',
      'edit.diagnosticsRuns': '1 count',
      'edit.assetUsages': '2 ms',
      'edit.assetUsagesRuns': '1 count',
      'edit.themeUpdates': '3 ms',
      'edit.themeUpdatesRuns': '1 count',
      'edit.versionsInfo': '2 ms',
      'edit.versionsInfoRuns': '2 count',
      'edit.checks': '18.25 ms',
      'edit.snapshotBuild': '14 ms',
      'edit.snapshotBuilds': '2 count'
    });
  });

  it('count a check the edit no longer works out as none, never missing, and need the batch’s checks', () => {
    const kept = edit.measure(trace((x) => x.name === 'session.check' && x.attrs?.check === 'updates'), facts);
    expect(kept.missing).toEqual([]);
    expect(kept.metrics['edit.themeUpdates']).toEqual({ unit: 'ms', value: 0 });
    expect(kept.metrics['edit.themeUpdatesRuns']).toEqual({ unit: 'count', value: 0 });
    expect(kept.metrics['edit.checks'].value).toBe(15.25);
    const unchecked = edit.measure(trace((x) => x.name === 'apply.batchChecks'), facts);
    expect(unchecked.missing).toEqual(['apply.batchChecks']);
    expect(unchecked.metrics['edit.batchChecks']).toBeUndefined();
  });

  it('name a mark that is missing instead of reporting a time without it', () => {
    const without = (name: string, rev = target) => edit.measure(trace((x) => x.name === name && (x.attrs?.revision === rev || x.attrs?.revision === undefined)), facts);
    // The other revision's acknowledgement is there, but is not this edit's.
    expect(without('canvas.revisionApplied').missing).toEqual(['canvas.revisionApplied']);
    expect(without('canvas.revisionApplied').metrics['edit.previewApplied']).toBeUndefined();
    expect(without('session.changed').missing).toEqual(['session.changed']);
    // A sum of one variant would look faster than it is.
    expect(edit.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'clean'), facts).missing).toEqual(['session.generate (clean)']);
    expect(edit.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'clean'), facts).metrics['edit.generate']).toBeUndefined();
    expect(edit.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'dev'), facts).missing).toEqual(['session.generate (dev)']);
    // So would a dependency check of one variant, or a document search that is not there.
    expect(edit.measure(trace((x) => x.name === 'session.generateCheck' && x.attrs?.variant === 'dev'), facts).missing).toEqual(['session.generateCheck (both variants)']);
    expect(edit.measure(trace((x) => x.name === 'session.generateCheck' && x.attrs?.variant === 'dev'), facts).metrics['edit.generateCheck']).toBeUndefined();
    // A check that does not say what it looked up and worked out has no count of them, never a count of nothing.
    const uncounted = new Trace(trace().records.map((x) => (x.name === 'session.generateCheck' && x.attrs?.variant === 'dev' ? { ...x, attrs: { variant: 'dev', ms: 1, files: 40 } } : x)));
    expect(edit.measure(uncounted, facts).missing).toEqual(['session.generateCheck (looked)', 'session.generateCheck (derived)']);
    expect(edit.measure(uncounted, facts).metrics['edit.generateDerived']).toBeUndefined();
    expect(without('session.changedDocs').missing).toEqual(['session.changedDocs']);
  });

  it('count every generation of each variant, and refuse one without a length', () => {
    const twice = new Trace([...trace().records, span('session.generate', 10_036, 2, { attrs: { variant: 'dev' } })]);
    expect(edit.measure(twice, facts).metrics['edit.generate'].value).toBe(9);
    const lengthless = new Trace(trace().records.map((x) => (x.name === 'session.generate' && x.attrs?.variant === 'dev' ? { ...x, kind: 'mark' as const, ms: undefined } : x)));
    expect(edit.measure(lengthless, facts).missing).toEqual(['edit.generate (a finite time)']);
  });

  it('leave React commits missing when the editor could not count them, never a false zero', () => {
    const uncounted = new Trace([...trace().records, r('perf.reactCommitsUncounted', 100)]);
    const got = edit.measure(uncounted, facts);
    expect(got.missing).toEqual(['edit.rendererCommits (the editor could not count React commits)']);
    expect(got.metrics['edit.rendererCommits']).toBeUndefined();
  });

  it('leave the editor’s walks of every entry missing when it never counted them, never a false zero', () => {
    const uncounted = new Trace(trace().records.map((x) => (x.c ? { ...x, c: { 'react.commits': x.c['react.commits'] } } : x)));
    const got = edit.measure(uncounted, facts);
    expect(got.missing).toEqual(['edit.siteEntryWalks (the editor never counted its walks of every entry)']);
    expect(got.metrics['edit.siteEntryWalks']).toBeUndefined();
  });

  it('leave the bytes sent missing when a snapshot’s size could not be told, never short', () => {
    const unsized = new Trace(trace().records.map((x) => (x.name === 'controller.snapshotSent' && x.t === 10_600 ? { ...x, attrs: { revision: target, bytes: null } } : x)));
    const got = edit.measure(unsized, facts);
    expect(got.missing).toEqual(['edit.snapshotBytes (a snapshot whose size could not be told)']);
    expect(got.metrics['edit.snapshotBytes']).toBeUndefined();
    expect(got.metrics['edit.snapshotsSent'].value).toBe(3);
  });

  it('time the edit that lets History’s oldest step go by its own boundary marks, under its own names', () => {
    const renamed = new Trace(trace().records.map((x) => (x.name.startsWith('scenario.') ? { ...x, attrs: { scenario: 'editFullHistory' } } : x)));
    const got = editFullHistory.measure(renamed, facts);
    expect(got.missing).toEqual([]);
    const plain = edit.measure(trace(), facts);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k.replace(/^editFullHistory\./, 'edit.'), v]))).toEqual(plain.metrics);
    // Another scenario's boundaries are not its own.
    expect(editFullHistory.measure(trace(), facts).missing).toContain('edit.requested');
  });

  it('time the save after one that copied a font in by its own boundary marks, with the favicon’s reads', () => {
    // The favicon's new file read by the saves before the edit, as the main process counted at the scenario's start.
    const renamed = (favicon: Record<string, number>, readBefore = 2) =>
      new Trace(
        trace().records.map((x) => {
          if (x.name === 'scenario.start' && x.proc === 'main') return { ...x, attrs: { scenario: 'editBranded' }, c: { ...x.c, 'favicon.read': readBefore } };
          if (x.name.startsWith('scenario.')) return { ...x, attrs: { scenario: 'editBranded' } };
          if (x.name === 'session.publish') return { ...x, dc: { ...x.dc, ...favicon } };
          return x;
        })
      );
    const got = editBranded.measure(renamed({ 'favicon.read': 1, 'favicon.hashedBytes': 196_000 }), facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics['editBranded.publishFaviconReads']).toEqual({ unit: 'count', value: 1 });
    expect(got.metrics['editBranded.publishFaviconBytesHashed']).toEqual({ unit: 'bytes', value: 196_000 });
    // A publication that read no favicon counts none, never missing.
    const none = editBranded.measure(renamed({}), facts);
    expect(none.missing).toEqual([]);
    expect(none.metrics['editBranded.publishFaviconReads']).toEqual({ unit: 'count', value: 0 });
    const plain = edit.measure(trace(), facts);
    const own = Object.fromEntries(Object.entries(got.metrics).filter(([k]) => !k.includes('Favicon')).map(([k, v]) => [k.replace(/^editBranded\./, 'edit.'), v]));
    expect(own).toEqual(plain.metrics);
    // Another scenario's boundaries are not its own, and a publication outside the edit is not the edit's.
    expect(editBranded.measure(trace(), facts).missing).toContain('edit.requested');
    const outside = new Trace(renamed({ 'favicon.read': 1 }).records.map((x) => (x.name === 'session.publish' ? { ...x, t: 9_800 } : x)));
    expect(editBranded.measure(outside, facts).missing).toContain('session.publish');
    expect(editBranded.measure(outside, facts).metrics['editBranded.publishFaviconReads']).toBeUndefined();
    // A build that never counted the favicon's reads cannot pass as one that did not need to read it.
    expect(editBranded.measure(renamed({}, 0), facts).missing).toEqual(['favicon.read (counted before the edit)']);
    const unmarked = new Trace(renamed({}).records.filter((x) => !(x.name === 'scenario.start' && x.proc === 'main')));
    expect(editBranded.measure(unmarked, facts).missing).toEqual(['scenario.start (main)', 'favicon.read (counted before the edit)']);
  });

  it('find the faces of a font the website’s styles name', () => {
    const css = "@font-face {\n\tsrc: url('../fonts/lora-latin-wght-normal.woff2') format('woff2');\n}\n@font-face {\n\tsrc: url('../fonts/inter-latin-wght-normal.woff2') format('woff2');\n}\n@font-face { src: url('../fonts/lora-cyrillic-wght-normal.woff2') format('woff2'); }";
    expect(namedFaces(css, /^lora-/)).toEqual(['lora-latin-wght-normal.woff2', 'lora-cyrillic-wght-normal.woff2']);
    expect(namedFaces('', /^lora-/)).toEqual([]);
  });

  it('count no sweep the edit waited on when every one ran after it was acknowledged', () => {
    const later = new Trace(trace().records.map((x) => (x.name === 'session.sweep' && x.t === 10_099 ? { ...x, t: 10_650 } : x)));
    const got = edit.measure(later, facts);
    expect(got.metrics['edit.sweepsAwaited'].value).toBe(0);
    expect(got.metrics['edit.sweepAwaited'].value).toBe(0);
    expect(got.metrics['edit.sweeps'].value).toBe(2);
  });
});

describe('history metrics', () => {
  const h = { scenario: 'history' };
  const counts = (commits: number, walks: number) => ({ c: { 'react.commits': commits, 'collections.siteEntries': walks } });
  /** Undo (to revision 10), Redo (11) and a restore (12) whose version list went out first, at revision 11. */
  function trace(drop: (x: PerfRecord) => boolean = () => false) {
    return new Trace(
      [
        // Before the windows: the untimed edit's own send, never counted in one.
        m('controller.snapshotSent', 19_000, { attrs: { revision: 9, bytes: 5000 } }),
        r('scenario.start', 20_000, { attrs: h }),
        m('scenario.start', 20_000, { attrs: h }),
        r('scenario.phase', 20_000, { attrs: { ...h, phase: 'undo', target: 10 }, ...counts(10, 2) }),
        m('scenario.phase', 20_000, { attrs: { ...h, phase: 'undo', target: 10 } }),
        m('session.changed', 20_050, { attrs: { revision: 10 } }),
        m('controller.snapshotSent', 20_052, { attrs: { revision: 10, bytes: 600 } }),
        r('renderer.snapshotReceived', 20_053, { attrs: { revision: 10 } }),
        r('renderer.commit', 20_056, { attrs: { revision: 10 } }),
        span('main.stall', 20_060, 55),
        r('canvas.revisionApplied', 20_100, { attrs: { revision: 10 } }),
        m('scenario.phase', 21_600, { attrs: { ...h, phase: 'undone' } }),
        r('scenario.phase', 21_600, { attrs: { ...h, phase: 'undone' }, ...counts(14, 3) }),
        r('scenario.phase', 22_000, { attrs: { ...h, phase: 'redo', target: 11 }, ...counts(14, 3) }),
        m('scenario.phase', 22_000, { attrs: { ...h, phase: 'redo', target: 11 } }),
        m('session.changed', 22_030, { attrs: { revision: 11 } }),
        m('controller.snapshotSent', 22_031, { attrs: { revision: 11, bytes: 610 } }),
        r('renderer.snapshotReceived', 22_032, { attrs: { revision: 11 } }),
        r('renderer.commit', 22_036, { attrs: { revision: 11 } }),
        r('canvas.revisionApplied', 22_080, { attrs: { revision: 11 } }),
        m('scenario.phase', 23_600, { attrs: { ...h, phase: 'redone' } }),
        r('scenario.phase', 23_600, { attrs: { ...h, phase: 'redone' }, ...counts(20, 3) }),
        r('scenario.phase', 24_000, { attrs: { ...h, phase: 'restore', target: 12 }, ...counts(20, 3) }),
        m('scenario.phase', 24_000, { attrs: { ...h, phase: 'restore', target: 12 } }),
        // The version list, with the work the restore replaced saved first: sent in the window, at the revision before.
        m('controller.snapshotSent', 24_010, { attrs: { revision: 11, bytes: 300 } }),
        m('session.changed', 24_400, { attrs: { revision: 12 } }),
        m('controller.snapshotSent', 24_405, { attrs: { revision: 12, bytes: 120_000 } }),
        r('renderer.snapshotReceived', 24_406, { attrs: { revision: 12 } }),
        r('renderer.commit', 24_416, { attrs: { revision: 12 } }),
        r('canvas.revisionApplied', 24_500, { attrs: { revision: 12 } }),
        m('scenario.phase', 26_000, { attrs: { ...h, phase: 'restored' } }),
        r('scenario.phase', 26_000, { attrs: { ...h, phase: 'restored' }, ...counts(30, 9) }),
        m('scenario.end', 26_001, { attrs: h }),
        r('scenario.end', 26_001, { attrs: h, ...counts(31, 9) }),
        // After the scenario: none of its counts.
        m('controller.snapshotSent', 27_000, { attrs: { revision: 12, bytes: 9999 } }),
        span('main.stall', 27_001, 900)
      ].filter((x) => !drop(x))
    );
  }

  it('time each step and the restore by the revision it made, and count what each sent the editor', () => {
    const got = history.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const shown = Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]));
    const window = (w: string, v: Record<string, string>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [`history.${w}.${k}`, x]));
    expect(shown).toEqual({
      ...window('undo', { changed: '50 ms', changedToSent: '2 ms', sentToReceived: '1 ms', receivedToCommit: '3 ms', rendererCommit: '56 ms', previewApplied: '100 ms', snapshotsSent: '1 count', snapshotBytes: '600 bytes', rendererCommits: '4 count', siteEntryWalks: '1 count', mainStallMax: '55 ms' }),
      ...window('redo', { changed: '30 ms', changedToSent: '1 ms', sentToReceived: '1 ms', receivedToCommit: '4 ms', rendererCommit: '36 ms', previewApplied: '80 ms', snapshotsSent: '1 count', snapshotBytes: '610 bytes', rendererCommits: '6 count', siteEntryWalks: '0 count', mainStallMax: '0 ms' }),
      ...window('restore', { changed: '400 ms', changedToSent: '5 ms', sentToReceived: '1 ms', receivedToCommit: '10 ms', rendererCommit: '416 ms', previewApplied: '500 ms', snapshotsSent: '2 count', snapshotBytes: '120300 bytes', rendererCommits: '10 count', siteEntryWalks: '6 count', mainStallMax: '0 ms' })
    });
    expect(HISTORY_WINDOWS).toEqual(['undo', 'redo', 'restore']);
  });

  it('name what is missing instead of timing another revision or counting less', () => {
    // The restore's own send gone: the version list's, at the revision before, is never taken for it.
    const unsent = history.measure(trace((x) => x.name === 'controller.snapshotSent' && x.attrs?.revision === 12), facts);
    expect(unsent.missing).toEqual(['controller.snapshotSent (restore)']);
    expect(unsent.metrics['history.restore.changedToSent']).toBeUndefined();
    const unshown = history.measure(trace((x) => x.name === 'canvas.revisionApplied' && x.attrs?.revision === 10), facts);
    expect(unshown.missing).toEqual(['canvas.revisionApplied (undo)']);
    expect(unshown.metrics['history.undo.previewApplied']).toBeUndefined();
    const unmarked = history.measure(trace((x) => x.name === 'scenario.phase' && x.attrs?.phase === 'redone' && x.proc === 'renderer'), facts);
    expect(unmarked.missing).toContain('scenario.phase redone (renderer)');
    const uncounted = history.measure(new Trace(trace().records.map((x) => (x.c ? { ...x, c: { 'react.commits': x.c['react.commits'] } } : x))), facts);
    expect(uncounted.missing).toEqual(HISTORY_WINDOWS.map((w) => `history.${w}.siteEntryWalks (the editor never counted its walks of every entry)`));
    // A window whose opening mark never counted them is missing too, never the editor's total so far.
    const unopened = history.measure(new Trace(trace().records.map((x) => (x.attrs?.phase === 'undo' && x.c ? { ...x, c: { 'react.commits': x.c['react.commits'] } } : x))), facts);
    expect(unopened.missing).toEqual(['history.undo.siteEntryWalks (the editor never counted its walks of every entry)']);
  });
});

describe('edits metrics', () => {
  /** The revision before the first edit, and the one the last leaves; the edits are sent GAP ms apart. */
  const GAP = 500;
  const base = 40;
  const target = base + EDITS;
  function trace(drop: (x: PerfRecord) => boolean = () => false) {
    const records: PerfRecord[] = [
      r('scenario.start', 1000, { attrs: { scenario: 'edits' }, c: { 'react.commits': 10 } }),
      m('scenario.start', 1000, { attrs: { scenario: 'edits' }, c: { 'files.read': 100, 'docs.read': 50, 'files.hashed': 5, 'fs.durableWrites': 3, 'fs.fsyncs': 4 } }),
      // An edit that failed: never taken for the revision the project was at.
      span('controller.apply', 1050, 9999, { attrs: { revision: base + 5, ok: false } }),
      span('session.apply', 1049, 9999, { attrs: { revision: base + 5, ok: false } })
    ];
    for (let k = 0; k < EDITS; k++) {
      const sent = 1100 + GAP * k;
      const rev = base + 1 + k;
      records.push(
        r('edit.requested', sent, { attrs: { revision: rev - 1, operations: 1 } }),
        // The kth edit waited k × 10 ms for its turn, after 200 to 219 ms of its own work.
        span('session.apply', sent + 299, 200 + (k % 20), { attrs: { revision: rev, ok: true } }),
        span('controller.apply', sent + 300, 200 + (k % 20) + 10 * k, { attrs: { revision: rev, ok: true } }),
        m('controller.snapshotSent', sent + 301, { attrs: { revision: rev, bytes: 100 } })
      );
      // The watch went off for every save but the last before the outside change; each look but two read the project,
      // and two of those found something changed.
      if (k < EDITS - 1) records.push(m('controller.watchFired', sent + 690));
      if (k < EDITS - 3) records.push(m('session.reloadFromDisk', sent + 700));
      if (k < EDITS - 5) records.push(m('session.reloadUnchanged', sent + 900));
    }
    records.push(
      span('main.stall', 5000, 80),
      m('edits.outside', 12_000, { attrs: { scenario: 'edits', revision: target }, c: { 'files.read': 300, 'docs.read': 150, 'files.hashed': 25, 'fs.durableWrites': 63, 'fs.fsyncs': 124 } }),
      r('edits.outside', 12_001, { attrs: { scenario: 'edits', revision: target }, c: { 'react.commits': 210 } }),
      // The watch went off twice for the change made outside: the second look took it.
      m('controller.watchFired', 12_100),
      m('controller.watchFired', 12_440),
      m('session.reloadFromDisk', 12_450),
      m('controller.snapshotSent', 12_600, { attrs: { revision: target + 1, bytes: 100 } }),
      r('canvas.revisionApplied', 12_900, { attrs: { revision: target + 1 } }),
      span('main.stall', 12_950, 500),
      m('scenario.end', 13_000, { attrs: { scenario: 'edits' } }),
      r('scenario.end', 13_001, { attrs: { scenario: 'edits' } }),
      // After the scenario: none of its counts.
      m('session.reloadFromDisk', 14_000)
    );
    return new Trace(records.filter((x) => !drop(x)));
  }

  it('time each edit’s wait for its turn by the revision it made, and count the reloads among the edits', () => {
    const got = edits.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]))).toEqual({
      // The edits after the first waited 10 to 190 ms; all of them, 0 to 190.
      'edits.queueWait': '100 ms',
      'edits.queueWaitTotal': '1900 ms',
      'edits.apply': '304.5 ms',
      'edits.sessionApply': '209.5 ms',
      'edits.sendGap': `${GAP} ms`,
      'edits.reloadFromDisk': `${EDITS - 3} count`,
      'edits.reloadUnchanged': `${EDITS - 5} count`,
      'edits.filesRead': '200 count',
      'edits.docsRead': '100 count',
      'edits.filesHashed': '20 count',
      'edits.durableWrites': '60 count',
      'edits.fsyncs': '120 count',
      'edits.snapshotsSent': `${EDITS} count`,
      'edits.snapshotBytes': `${EDITS * 100} bytes`,
      'edits.rendererCommits': '200 count',
      'edits.mainStallMax': '80 ms',
      'edits.watchFired': `${EDITS - 1} count`,
      // From the look that took it.
      'edits.outsideSent': '160 ms',
      'edits.outsideApplied': '460 ms',
      'edits.outsideReloads': '1 count'
    });
  });

  it('name an edit or a mark that is missing instead of reporting less work', () => {
    const without = (drop: (x: PerfRecord) => boolean) => edits.measure(trace(drop), facts);
    const oneShort = without((x) => x.name === 'session.apply' && x.attrs?.revision === base + 10);
    expect(oneShort.missing).toEqual([`session.apply (revision ${base + 10})`]);
    expect(oneShort.metrics['edits.queueWait']).toBeUndefined();
    expect(without((x) => x.name === 'edit.requested' && x.t === 1100).missing).toEqual([`${EDITS} edit.requested (there were ${EDITS - 1})`]);
    expect(without((x) => x.name === 'edits.outside' && x.proc === 'main').missing).toContain('edits.outside (main)');
    const untaken = without((x) => x.name === 'canvas.revisionApplied');
    expect(untaken.missing).toEqual(['canvas.revisionApplied (the change made outside)']);
    expect(untaken.metrics['edits.outsideApplied']).toBeUndefined();
    // A change the app took without its watch going off for it is not timed from an earlier look.
    expect(without((x) => x.name === 'controller.watchFired' && x.t > 12_000).missing).toEqual(['controller.watchFired (for the change made outside)']);
  });
});

describe('batch metrics', () => {
  function trace(drop: (x: PerfRecord) => boolean = () => false) {
    return new Trace(
      [
        // Before the scenario: another run's marker, apply and send, never this one's.
        span('session.runMarker', 900, 50),
        m('controller.snapshotSent', 960, { attrs: { revision: 3, bytes: 40_000 } }),
        span('session.apply', 950, 40, { attrs: { ok: true, revision: 3 } }),
        m('scenario.start', 1000, { attrs: { scenario: 'batch' }, c: { 'run.docsHashed': 100 } }),
        r('scenario.start', 1000, { attrs: { scenario: 'batch' } }),
        span('session.runMarker', 1010, 3, { attrs: { paths: 0 } }),
        span('session.beginRun', 1012, 12),
        span('agent.devModeCheck', 1100, 0.5),
        span('agent.authorityCheck', 1101, 4),
        // A refused try is not the batch.
        span('session.apply', 1102, 1, { attrs: { ok: false, revision: 4 } }),
        span('session.applyOperations', 1110, 6),
        span('session.validateState', 1120, 9),
        span('session.generate', 1130, 8, { attrs: { variant: 'clean' } }),
        m('session.generateCheck', 1130, { attrs: { variant: 'clean', ms: 3, files: 40, looked: 700, derived: 20 } }),
        span('session.generate', 1140, 7, { attrs: { variant: 'dev' } }),
        m('session.generateCheck', 1140, { attrs: { variant: 'dev', ms: 2, files: 40, looked: 5, derived: 1 } }),
        span('session.changedDocs', 1142, 2),
        span('session.runMarker', 1150, 4, { attrs: { paths: 1 } }),
        m('controller.snapshotSent', 1160, { attrs: { revision: 3, bytes: 200 } }),
        span('session.publish', 1170, 15),
        span('session.persist', 1180, 38),
        span('session.apply', 1181, 75, { attrs: { ok: true, revision: 4 }, dc: { 'apply.docsCopied': 600, 'docs.serialized': 650, 'fs.durableWrites': 9, 'fs.fsyncs': 18 } }),
        span('main.stall', 1182, 60),
        // Another revision's report is not the batch's.
        r('canvas.revisionApplied', 1150, { attrs: { revision: 3 } }),
        r('canvas.revisionApplied', 1250, { attrs: { revision: 4 } }),
        m('controller.snapshotSent', 1182, { attrs: { revision: 4, bytes: 5000 } }),
        m('controller.snapshotSent', 2000, { attrs: { revision: 4, bytes: 300 } }),
        m('scenario.end', 3000, { attrs: { scenario: 'batch' }, c: { 'run.docsHashed': 1400 } }),
        r('scenario.end', 3001, { attrs: { scenario: 'batch' } }),
        span('session.runMarker', 3100, 50),
        // After the scenario: not the run's.
        m('controller.snapshotSent', 3200, { attrs: { revision: 4, bytes: 9000 } })
      ].filter((x) => !drop(x))
    );
  }

  it('time the batch’s own apply and the run’s checks and markers around it, by the revision it made', () => {
    const got = batch.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]))).toEqual({
      'batch.beginRun': '12 ms',
      'batch.checks': '4.5 ms',
      'batch.sessionApply': '75 ms',
      'batch.applyOperations': '6 ms',
      'batch.validate': '9 ms',
      'batch.generate': '15 ms',
      'batch.generateCheck': '5 ms',
      'batch.generateLooked': '705 count',
      'batch.generateDerived': '21 count',
      'batch.changedDocs': '2 ms',
      'batch.persist': '38 ms',
      'batch.publish': '15 ms',
      'batch.runMarker': '7 ms',
      'batch.runMarkers': '2 count',
      'batch.runDocsHashed': '1300 count',
      'batch.docsCopied': '600 count',
      'batch.docsSerialized': '650 count',
      'batch.durableWrites': '9 count',
      'batch.fsyncs': '18 count',
      'batch.previewApplied': '250 ms',
      'batch.snapshotsSent': '3 count',
      'batch.snapshotBytes': '5500 bytes',
      'batch.mainStallMax': '60 ms'
    });
  });

  it('name what is missing instead of reporting a batch that did less', () => {
    const without = (name: string) => batch.measure(trace((x) => x.name === name), facts);
    expect(without('session.beginRun').missing).toEqual(['session.beginRun']);
    expect(without('agent.authorityCheck').missing).toEqual(['agent.authorityCheck']);
    expect(without('session.runMarker').missing).toEqual(['session.runMarker']);
    expect(without('session.changedDocs').missing).toEqual(['session.changedDocs']);
    expect(without('session.generateCheck').missing).toEqual(['session.generateCheck (both variants)']);
    expect(without('canvas.revisionApplied').missing).toEqual(['canvas.revisionApplied']);
    // No apply that moved the project: nothing inside it is taken from another.
    expect(batch.measure(trace((x) => x.name === 'session.apply' && x.t === 1181), facts).missing).toContain('session.apply (the batch)');
  });

  it('rewrite the page’s text properties in turn, the later text of one set twice kept', () => {
    const state = {
      pages: { pg_home: { nodes: { a: { id: 'a', kind: 'instance', definitionId: 'hero', props: { heading: 'Hi', level: 'h1', lead: 'L' } }, b: { id: 'b', kind: 'element', tag: 'div' } } } },
      components: { hero: { properties: { heading: { type: 'string' }, level: { type: 'enum' }, lead: { type: 'string' } } } }
    } as unknown as Parameters<typeof batchOperations>[0];
    const { operations, final } = batchOperations(state, 'pg_home', 2);
    expect(operations).toHaveLength(BATCH_OPERATIONS);
    expect(operations[0]).toEqual({ type: 'instance.setProp', owner: { kind: 'page', id: 'pg_home' }, nodeId: 'a', prop: 'heading', value: 'Batch 2.0' });
    expect(operations[1]).toMatchObject({ prop: 'lead', value: 'Batch 2.1' });
    expect([...final]).toEqual([
      ['a:heading', 'Batch 2.28'],
      ['a:lead', 'Batch 2.29']
    ]);
  });
});

describe('panels metrics', () => {
  const base = 4;
  const target = 5;
  /** The editor's counters at a mark: React's, and each panel's renders and render time, scaled by `k`. */
  const counters = (commits: number, renders: number, k: number, drop?: string): Record<string, number> => {
    const c: Record<string, number> = { 'react.commits': commits, 'react.renders': renders };
    PANELS.forEach((id, i) => {
      if (id === drop) return;
      c[`panel.${id}.renders`] = k * (i + 1);
      c[`panel.${id}.renderMs`] = k * (i + 1) * 0.5;
    });
    return c;
  };
  const phase = (name: string) => ({ attrs: { scenario: 'panels', phase: name } });
  function trace(drop: (x: PerfRecord) => boolean = () => false, unmounted?: string) {
    return new Trace(
      [
        // Before the scenario: a selection commit, never the click's.
        r('renderer.selectionCommit', 4000, { attrs: { selected: true } }),
        r('scenario.start', 5000, { attrs: { scenario: 'panels' }, c: counters(100, 1000, 1, unmounted) }),
        m('scenario.start', 5000, { attrs: { scenario: 'panels' } }),
        r('canvas.select', 5100),
        // The selection cleared on the way to the new one: not the commit that shows it.
        r('renderer.selectionCommit', 5104, { attrs: { selected: false } }),
        r('renderer.selectionCommit', 5130, { attrs: { selected: true } }),
        r('scenario.phase', 7000, { ...phase('clicked'), c: counters(110, 1600, 3) }),
        m('scenario.phase', 7000, phase('clicked')),
        // Showing the Inspector, between the windows: in neither.
        r('renderer.selectionCommit', 7100, { attrs: { selected: true } }),
        r('scenario.phase', 8000, { ...phase('edit'), c: counters(130, 2000, 10) }),
        m('scenario.phase', 8000, phase('edit')),
        r('edit.requested', 8200, { attrs: { revision: base, operations: 1 } }),
        // Another revision's records: never this edit's.
        r('renderer.snapshotReceived', 8201, { attrs: { revision: base } }),
        r('renderer.commit', 8202, { attrs: { revision: base } }),
        r('renderer.snapshotReceived', 8300, { attrs: { revision: target } }),
        r('renderer.commit', 8345, { attrs: { revision: target } }),
        r('scenario.end', 9000, { attrs: { scenario: 'panels' }, c: counters(145, 3000, 14) }),
        m('scenario.end', 9000, { attrs: { scenario: 'panels' } })
      ].filter((x) => !drop(x))
    );
  }

  it('time the click and the edit to their commits, and each panel’s renders in each window', () => {
    const got = panels.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect([v('panels.click.commit'), v('panels.edit.commit'), v('panels.edit.rendererCommit')]).toEqual([30, 45, 145]);
    expect([v('panels.click.rendererCommits'), v('panels.edit.rendererCommits'), v('panels.click.renders'), v('panels.edit.renders')]).toEqual([10, 15, 600, 1000]);
    // Each panel gained (k₂ − k₁)·(its place) renders, and half that in ms; nothing between the windows is counted.
    PANELS.forEach((id, i) => {
      expect(v(`panels.click.renders.${id}`)).toBe(2 * (i + 1));
      expect(v(`panels.click.renderMs.${id}`)).toBe(i + 1);
      expect(v(`panels.edit.renders.${id}`)).toBe(4 * (i + 1));
      expect(got.metrics[`panels.edit.renderMs.${id}`].unit).toBe('ms');
    });
    // The hidden panels are every one but the window's shown one: Project for the click, the Inspector for the edit.
    const all = PANELS.reduce((n, _, i) => n + i + 1, 0);
    const place = (id: string) => PANELS.indexOf(id as (typeof PANELS)[number]) + 1;
    expect([v('panels.click.hiddenRenders'), v('panels.click.hiddenRenderMs')]).toEqual([2 * (all - place(SHOWN_PANELS.click)), all - place(SHOWN_PANELS.click)]);
    expect(v('panels.edit.hiddenRenders')).toBe(4 * (all - place(SHOWN_PANELS.edit)));
  });

  it('name what is missing, and never count a panel the editor never had as doing nothing', () => {
    // The selection's commit is looked for only after the click: without the click there is neither.
    expect(panels.measure(trace((x) => x.name === 'canvas.select'), facts).missing).toEqual(['canvas.select', 'renderer.selectionCommit']);
    expect(panels.measure(trace((x) => x.name === 'renderer.selectionCommit' && x.t === 5130), facts).missing).toEqual(['renderer.selectionCommit']);
    expect(panels.measure(trace((x) => x.name === 'renderer.commit' && x.attrs?.revision === target), facts).missing).toEqual(['renderer.commit']);
    expect(panels.measure(trace((x) => x.name === 'scenario.phase' && x.attrs?.phase === 'edit'), facts).missing).toContain('scenario.phase edit (renderer)');
    const gone = panels.measure(trace(undefined, 'insert'), facts);
    expect(gone.missing).toEqual(['panels.click (the insert panel was not mounted)']);
    expect(gone.metrics['panels.click.renders.insert']).toBeUndefined();
    const uncounted = new Trace(trace().records.map((x) => (x.name === 'scenario.start' && x.proc === 'renderer' ? { ...x, c: { 'react.commits': 100 } } : x)));
    expect(panels.measure(uncounted, facts).missing).toEqual(['panels.click (the editor did not count component renders)']);
  });
});

describe('panelsInUse metrics', () => {
  /** The editor's counters at a mark: React's, each panel's, and the work over the whole site, scaled by `k`. */
  const counters = (commits: number, renders: number, k: number, work: [number, number, number] | null): Record<string, number> => {
    const c: Record<string, number> = { 'react.commits': commits, 'react.renders': renders };
    PANELS.forEach((id, i) => {
      c[`panel.${id}.renders`] = k * (i + 1);
      c[`panel.${id}.renderMs`] = k * (i + 1) * 0.5;
    });
    if (work) Object.values(SITE_WORK).forEach((name, i) => (c[name] = work[i]));
    return c;
  };
  const phase = (name: string) => ({ attrs: { scenario: 'panelsInUse', phase: name } });
  function trace(uncounted = false) {
    const w = (x: [number, number, number]) => (uncounted ? null : x);
    return new Trace([
      r('scenario.start', 5000, { attrs: { scenario: 'panelsInUse' }, c: counters(100, 1000, 1, w([3, 5, 7])) }),
      m('scenario.start', 5000, { attrs: { scenario: 'panelsInUse' } }),
      r('canvas.select', 5100),
      r('renderer.selectionCommit', 5130, { attrs: { selected: true } }),
      r('scenario.phase', 7000, { ...phase('clicked'), c: counters(110, 1600, 3, w([3, 5, 9])) }),
      m('scenario.phase', 7000, phase('clicked')),
      // Showing the Inspector, between the windows: its work is in neither.
      r('scenario.phase', 8000, { ...phase('edit'), c: counters(130, 2000, 10, w([4, 6, 10])) }),
      m('scenario.phase', 8000, phase('edit')),
      r('edit.requested', 8200, { attrs: { revision: 4, operations: 1 } }),
      r('renderer.snapshotReceived', 8300, { attrs: { revision: 5 } }),
      r('renderer.commit', 8345, { attrs: { revision: 5 } }),
      r('scenario.end', 9000, { attrs: { scenario: 'panelsInUse' }, c: counters(145, 3000, 14, w([5, 8, 11])) }),
      m('scenario.end', 9000, { attrs: { scenario: 'panelsInUse' } })
    ]);
  }

  it('count, per window, the work over the whole site beside panels’ metrics under its own name', () => {
    const got = panelsInUse.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    expect([v('panelsInUse.click.commit'), v('panelsInUse.edit.commit'), v('panelsInUse.edit.rendererCommit')]).toEqual([30, 45, 145]);
    expect([v('panelsInUse.click.seoOverviews'), v('panelsInUse.click.seoRoutes'), v('panelsInUse.click.chatStarters')]).toEqual([0, 0, 2]);
    expect([v('panelsInUse.edit.seoOverviews'), v('panelsInUse.edit.seoRoutes'), v('panelsInUse.edit.chatStarters')]).toEqual([1, 2, 1]);
    expect(v('panelsInUse.edit.renders.seoView')).toBe(4 * (PANELS.indexOf('seoView') + 1));
    expect(got.metrics['panels.edit.commit']).toBeUndefined();
  });

  it('never count work the editor did not count as none', () => {
    const got = panelsInUse.measure(trace(true), facts);
    expect(got.missing).toEqual([
      'panelsInUse.click.seoOverviews (the editor did not count seo.overviews)',
      'panelsInUse.click.seoRoutes (the editor did not count seo.routes)',
      'panelsInUse.click.chatStarters (the editor did not count chat.starters)',
      'panelsInUse.edit.seoOverviews (the editor did not count seo.overviews)',
      'panelsInUse.edit.seoRoutes (the editor did not count seo.routes)',
      'panelsInUse.edit.chatStarters (the editor did not count chat.starters)'
    ]);
    expect(got.metrics['panelsInUse.edit.seoOverviews']).toBeUndefined();
  });
});

describe('layers pages', () => {
  it('hold the nodes they are named for, in sections, with a hidden section and clicks across the page', () => {
    for (const size of LAYERS_SIZES) {
      const page = layersPage(size);
      expect(page.order).toHaveLength(size);
      expect(new Set(page.order).size).toBe(size);
      const inserts = page.operations.filter((o) => o.type === 'node.insert');
      expect(inserts.map((o) => o.newNodeId)).toEqual(page.order);
      for (const id of page.order) expect(id).toMatch(/^n_[a-z0-9]{4,32}$/);
      expect(page.pageId).toMatch(/^pg_[a-z0-9]{4,32}$/);
      // Six deep at most, every parent made before its children.
      expect(Math.max(...page.order.map((id) => layersAncestors(page, id).length))).toBe(5);
      page.order.forEach((id, i) => {
        const parent = page.parents.get(id);
        if (parent) expect(page.order.indexOf(parent)).toBeLessThan(i);
      });
      // The hidden inner container and the 23 layers it holds.
      expect(page.hidden).toHaveLength(24);
      expect(page.hidden.slice(1).every((id) => layersAncestors(page, id).includes(page.hidden[0]))).toBe(true);
      // Seven different rows, none hidden, at depths from a section to a button; the eye's section is none of them.
      expect(new Set(page.clicks).size).toBe(7);
      expect(page.clicks.some((id) => page.hidden.includes(id) || id === page.hides || layersAncestors(page, id).includes(page.hides))).toBe(false);
      expect(new Set(page.clicks.map((id) => layersAncestors(page, id).length))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
      expect(page.parents.get(page.hides)).toBeNull();
      // The arrow keys start from the last click, a section, and stay in it.
      const start = page.order.indexOf(page.clicks.at(-1)!);
      expect(page.parents.get(page.order[start])).toBeNull();
      expect(page.order.slice(start + 1, start + 1 + LAYERS_SAMPLES.key).every((id) => layersAncestors(page, id).includes(page.order[start]))).toBe(true);
    }
  });
});

describe('layers metrics', () => {
  /** The editor's counters at a mark. */
  const counters = (rows: number, renders: number, ms: number, walks: number, commits: number) => ({ 'layers.rows': rows, 'panel.layers.renders': renders, 'panel.layers.renderMs': ms, 'react.renders': renders + 10, 'react.commits': commits, 'tree.findParent': walks * 3, 'tree.subtreeIds': walks });
  const sample = (size: number, kind: LayersKind, i: number, edge: 'start' | 'end', attempt = 1) => ({ attrs: { scenario: 'layers', size, kind, i, edge, attempt, ...(edge === 'start' ? { rows: size + 20 } : {}) } });
  /** A sample i of a kind on a page: its window from t, the change taking `ms` to commit and one more to paint, its
   *  counters growing by `grow` (rows) and `grow / 2` (walks). */
  function window(size: number, kind: LayersKind, i: number, t: number, ms: number, grow: number, attempt = 1): PerfRecord[] {
    const out: PerfRecord[] = [r('layers.sample', t, { ...sample(size, kind, i, 'start', attempt), c: counters(1000, 5000, 100, 1000, 50) })];
    if (kind === 'edit') {
      const rev = 10 + i;
      out.push(r('edit.requested', t + 5, { attrs: { revision: rev, operations: 1 } }), r('renderer.snapshotReceived', t + 20, { attrs: { revision: rev + 1 } }), r('renderer.commit', t + 20 + ms, { attrs: { revision: rev + 1 } }));
    } else {
      out.push(r('layers.input', t + 5, { attrs: { kind } }), r('renderer.selectionCommit', t + 5 + ms, { attrs: { selected: true } }), r('layers.painted', t + 6 + ms, { attrs: { kind } }));
    }
    out.push(r('layers.sample', t + 30 + ms + 300, { ...sample(size, kind, i, 'end', attempt), c: counters(1000 + grow, 5000 + grow * 5, 100 + ms / 2, 1000 + grow / 2, 50 + 2) }));
    return out;
  }
  function trace(drop: (x: PerfRecord) => boolean = () => false, extra: PerfRecord[] = []) {
    const records: PerfRecord[] = [r('scenario.start', 1000, { attrs: { scenario: 'layers' } })];
    let t = 2000;
    for (const size of LAYERS_SIZES)
      for (const kind of LAYERS_KINDS)
        for (let i = 0; i < LAYERS_SAMPLES[kind]; i++) {
          // Samples i take 10·(i+1) ms on the small page and ten times that on the large one; rows grow the same way.
          const k = size === 300 ? 1 : 10;
          records.push(...window(size, kind, i, t, 10 * (i + 1) * k, 100 * k));
          t += 2000;
        }
    records.push(r('scenario.end', t, { attrs: { scenario: 'layers' } }));
    return new Trace([...records, ...extra].filter((x) => !drop(x)).sort((a, b) => a.t - b.t));
  }

  it('time each selection change and edit to its commit, with what the editor counted over it, per page', () => {
    const got = layers.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k]?.value;
    // Seven samples of 10..70 ms: the median is the fourth; two edits of 10 and 20: their mean.
    expect([v('layers.at300.click.commitMs'), v('layers.at300.key.commitMs'), v('layers.at300.edit.commitMs')]).toEqual([40, 40, 15]);
    expect([v('layers.at1000.click.commitMs'), v('layers.at1000.click.paintMs'), v('layers.at1000.edit.commitMs')]).toEqual([400, 401, 150]);
    expect(got.metrics['layers.at300.edit.paintMs']).toBeUndefined();
    expect([v('layers.at300.click.rowRenders'), v('layers.at300.click.layersRenders'), v('layers.at300.click.renders'), v('layers.at300.click.commits')]).toEqual([100, 500, 500, 2]);
    expect([v('layers.at1000.key.rowRenders'), v('layers.at1000.key.findParent'), v('layers.at1000.key.subtreeIds')]).toEqual([1000, 1500, 500]);
    expect([v('layers.at300.rows'), v('layers.at1000.rows')]).toEqual([320, 1020]);
    expect(got.metrics['layers.at300.click.layersMs']).toEqual({ unit: 'ms', value: 20 });
    expect(got.metrics['layers.at300.click.findParent'].unit).toBe('count');
  });

  it('measure the last attempt of a sample done again', () => {
    // A first attempt of the first click on the large page, before the measured one, that took far longer.
    const first = window(1000, 'click', 0, 1100, 500, 99999, 1).map((x) => ({ ...x, attrs: { ...x.attrs, ...(x.name === 'layers.sample' ? { attempt: 1 } : {}) } }));
    const records = trace().records.map((x) => (x.name === 'layers.sample' && x.attrs?.size === 1000 && x.attrs?.kind === 'click' && x.attrs?.i === 0 ? { ...x, attrs: { ...x.attrs, attempt: 2 } } : x));
    const got = layers.measure(new Trace([...records, ...first].sort((a, b) => a.t - b.t)), facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics['layers.at1000.click.commitMs'].value).toBe(400);
    expect(got.metrics['layers.at1000.click.rowRenders'].value).toBe(1000);
  });

  it('name what is missing, and never count a scan the editor never counted as none', () => {
    expect(layers.measure(trace((x) => x.name === 'layers.input' && x.t === 2005), facts).missing).toEqual(['layers.input (layers.at300 click 1)', 'renderer.selectionCommit (layers.at300 click 1)', 'layers.painted (layers.at300 click 1)']);
    expect(layers.measure(trace((x) => x.name === 'layers.sample' && x.attrs?.kind === 'key' && x.attrs?.i === 6 && x.attrs?.size === 300 && x.attrs?.edge === 'end'), facts).missing).toEqual(['layers.sample end (layers.at300 key 7)']);
    const edit = layers.measure(trace((x) => x.name === 'renderer.commit'), facts);
    expect(edit.missing).toContain('renderer.commit (layers.at300 edit 1)');
    expect(edit.metrics['layers.at300.edit.commitMs']).toBeUndefined();
    const uncounted = new Trace(trace().records.map((x) => (x.name === 'layers.sample' && x.c ? { ...x, c: Object.fromEntries(Object.entries(x.c).filter(([k]) => k !== 'tree.findParent')) } : x)));
    const none = layers.measure(uncounted, facts);
    expect(none.missing).toEqual(['tree.findParent (the editor never counted it)']);
    expect(none.metrics['layers.at300.click.findParent']).toBeUndefined();
    expect(layers.measure(trace((x) => x.name === 'scenario.end'), facts).missing).toEqual(['scenario.end (renderer)']);
  });
});

describe('chat metrics', () => {
  /**
   * One case's window: typing (a span per key, each `keyMs` long in turn), then a reply streamed (an event span each),
   * with the counters each process carries on its marks, and a decoy of each span just outside the window.
   */
  function chatCase(key: string, at: number, o: { keyMs?: number[]; keys?: number; events?: number[]; sent?: number; renders?: [number, number, number, number]; bytes?: [number, number] } = {}): PerfRecord[] {
    const [k0, k1, s0, s1] = o.renders ?? [0, 98, 98, 200];
    const c = (commits: number, renders: number) => ({ c: { 'react.commits': commits, 'react.renders': renders * 3, 'chat.messageRenders': renders, 'chat.textParses': Math.floor(renders / 2) } });
    // The page's work so far, as CDP counts it: each mark later by `n` layouts and style passes, `n` ms of each time.
    const w = (n: number) => ({ layouts: n, layoutMs: n, styles: 2 * n, styleMs: n / 2, scriptMs: 3 * n, taskMs: 10 * n });
    const [b0, b1] = o.bytes ?? [1000, 9000];
    const keyMs = o.keyMs ?? [0.5, 0.7, 0.6];
    const keys = o.keys ?? CHAT_TYPED.length;
    const events = o.events ?? [1.5, 2.5, 2];
    const sent = o.sent ?? events.length;
    return [
      r('chat.keystroke', at - 1, { kind: 'span', ms: 50, attrs: { commits: 1 } }),
      r('chat.typeStart', at, { attrs: { at: key, ...w(1) }, ...c(10, k0) }),
      ...Array.from({ length: keys }, (_, i) => r('chat.keystroke', at + 1 + i * 0.1, { kind: 'span', ms: keyMs[i % keyMs.length], attrs: { commits: 1 } })),
      r('chat.typeEnd', at + 10, { attrs: { at: key, ...w(5) }, ...c(13, k1) }),
      m('chat.streamStart', at + 11, { attrs: { at: key }, c: { 'ipc.aiEvent.sends': 5, 'ipc.aiEvent.bytes': b0 } }),
      r('chat.streamStart', at + 11.5, { attrs: { at: key, ...w(6) }, ...c(13, s0) }),
      ...events.map((ms, i) => r('chat.aiEvent', at + 20 + i * 10, { kind: 'span', ms, attrs: { kind: 'text', commits: 1 } })),
      m('chat.streamEnd', at + 90, { attrs: { at: key }, c: { 'ipc.aiEvent.sends': 5 + sent, 'ipc.aiEvent.bytes': b1 } }),
      r('chat.streamEnd', at + 90.5, { attrs: { at: key, ...w(26) }, ...c(13 + events.length, s1) }),
      r('chat.aiEvent', at + 91, { kind: 'span', ms: 50, attrs: { kind: 'status', commits: 1 } })
    ];
  }
  const both = () => [...chatCase('at6', 1000, { renders: [0, 4, 4, 20], events: [1, 3] }), ...chatCase('at100', 2000, { keyMs: [1, 2, 3, 4], bytes: [9000, 40_000] })];

  it('report each conversation’s keystrokes and streamed events, by its own marks', () => {
    const got = chat.measure(new Trace(both()), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('chat.at6.keystrokes'), v('chat.at6.keyMs'), v('chat.at6.keyCommits'), v('chat.at6.keyMessageRenders')]).toEqual([66, 0.6, 3, 4]);
    expect([v('chat.at100.keystrokes'), v('chat.at100.keyMs'), v('chat.at100.keyMessageRenders'), v('chat.at100.keyTextParses')]).toEqual([66, 2, 98, 49]);
    expect([v('chat.at6.events'), v('chat.at6.eventsHandled'), v('chat.at6.eventMs'), v('chat.at6.eventMsTotal'), v('chat.at6.replyMs')]).toEqual([2, 2, 2, 4, 1030 - 1011.5]);
    expect([v('chat.at100.events'), v('chat.at100.eventsHandled'), v('chat.at100.eventMs'), v('chat.at100.eventMsTotal'), v('chat.at100.replyMs')]).toEqual([3, 3, 2, 6, 2040 - 2011.5]);
    expect([v('chat.at100.streamCommits'), v('chat.at100.streamMessageRenders'), v('chat.at100.streamTextParses')]).toEqual([3, 102, 100 - 49]);
    expect(got.metrics['chat.at100.eventBytes']).toEqual({ unit: 'bytes', value: 31_000 });
    expect(got.metrics['chat.at6.eventBytes']).toEqual({ unit: 'bytes', value: 8000 });
    // Every component rendered in each window, and the page's own work over it.
    expect([v('chat.at6.keyRenders'), v('chat.at6.streamRenders'), v('chat.at100.keyRenders'), v('chat.at100.streamRenders')]).toEqual([12, 48, 294, 306]);
    expect([v('chat.at100.keyLayouts'), v('chat.at100.keyLayoutMs'), v('chat.at100.keyStyles'), v('chat.at100.keyStyleMs'), v('chat.at100.keyScriptMs'), v('chat.at100.keyTaskMs')]).toEqual([4, 4, 8, 2, 12, 40]);
    expect([v('chat.at6.streamLayouts'), v('chat.at6.streamLayoutMs'), v('chat.at6.streamStyles'), v('chat.at6.streamStyleMs'), v('chat.at6.streamScriptMs'), v('chat.at6.streamTaskMs')]).toEqual([20, 20, 40, 10, 60, 200]);
    expect(got.metrics['chat.at6.streamLayouts'].unit).toBe('count');
    expect(got.metrics['chat.at6.streamTaskMs'].unit).toBe('ms');
  });

  it('leave the page’s work missing when a mark does not carry it, never a false zero', () => {
    const records = both().map((x) => (x.name === 'chat.streamEnd' && x.proc === 'renderer' && x.attrs?.at === 'at100' ? { ...x, attrs: { at: 'at100' } } : x));
    const got = chat.measure(new Trace(records), facts);
    expect(got.missing).toEqual(["chat.at100.streamLayouts (the page's layouts on both marks)", "chat.at100.streamLayoutMs (the page's layoutMs on both marks)", "chat.at100.streamStyles (the page's styles on both marks)", "chat.at100.streamStyleMs (the page's styleMs on both marks)", "chat.at100.streamScriptMs (the page's scriptMs on both marks)", "chat.at100.streamTaskMs (the page's taskMs on both marks)"]);
    expect(got.metrics['chat.at100.streamTaskMs']).toBeUndefined();
    expect(got.metrics['chat.at100.keyTaskMs'].value).toBe(40);
  });

  it('take the longest main-process stall inside each reply only', () => {
    const stall = (t: number, ms: number) => m('main.stall', t, { kind: 'span', ms });
    const got = chat.measure(new Trace([...both(), stall(1050, 70), stall(2050, 90), stall(1500, 400)]), facts);
    expect([got.metrics['chat.at6.mainStallMax'].value, got.metrics['chat.at100.mainStallMax'].value]).toEqual([70, 90]);
  });

  it('name a conversation whose marks or spans are missing or short instead of reporting less work', () => {
    const got = chat.measure(new Trace([...chatCase('at6', 1000, { keys: 0 }), ...chatCase('at100', 2000, { events: [] })]), facts);
    expect(got.missing).toEqual(['chat.keystroke spans (at6: 0 of 66)', 'chat.aiEvent spans (at100: 0 of 0 sent)']);
    expect(got.metrics['chat.at6.keyMs']).toBeUndefined();
    // A trace that lost one key's span, or one event's, is not a faster run.
    const short = chat.measure(new Trace([...chatCase('at6', 1000, { keys: 65 }), ...chatCase('at100', 2000, { sent: 4 })]), facts);
    expect(short.missing).toEqual(['chat.keystroke spans (at6: 65 of 66)', 'chat.aiEvent spans (at100: 3 of 4 sent)']);
    const half = chat.measure(new Trace(chatCase('at6', 1000)), facts);
    expect(half.missing).toContain('chat.typeStart (at100, renderer)');
    expect(half.missing).toContain('chat.streamEnd (at100, main)');
  });

  it('leave the bytes sent missing when an event’s size could not be told, never short', () => {
    const records = both().map((x) => (x.name === 'chat.streamEnd' && x.proc === 'main' && x.attrs?.at === 'at6' ? { ...x, c: { ...x.c, 'ipc.aiEvent.unsized': 1 } } : x));
    const got = chat.measure(new Trace(records), facts);
    expect(got.missing).toEqual(['chat.at6.eventBytes (an event whose size could not be told)']);
  });

  it('seed each conversation with the earlier turns its log holds, and stream a reply that starts and ends as checked', () => {
    for (const c of CHAT_CASES) {
      const seeded = chatSeed(c, facts);
      expect(seeded.id).toBe(c.id);
      expect(seeded.messages).toHaveLength(c.earlier);
      expect(seeded.messages.map((x) => x.role)).toEqual(Array.from({ length: c.earlier }, (_, i) => (i % 2 ? 'assistant' : 'user')));
      expect(new Set(seeded.messages.map((x) => x.id)).size).toBe(c.earlier);
      const reply = chatReply(c.key);
      expect(reply.startsWith(chatReplyFirst(c.key))).toBe(true);
      expect(reply.endsWith(chatReplyLast(c.key))).toBe(true);
      expect(reply.length).toBeGreaterThan(2000);
      // Each checkpoint in order, after the first sentence and well before the last.
      const at = CHAT_REPLY_CHECKPOINTS.map((p) => reply.indexOf(p));
      expect(at.every((x, i) => x > (i ? at[i - 1] : chatReplyFirst(c.key).length) && x < reply.length - 200)).toBe(true);
      // Asked and answered, then edited: both kinds of turn, as stored ones are.
      expect(new Set(seeded.messages.filter((x) => x.role === 'assistant').map((x) => x.result?.status))).toEqual(new Set(c.earlier > 2 ? ['no-changes', 'completed'] : ['no-changes']));
      // Real Markdown: a list, a table and emphasis.
      expect(reply).toMatch(/^1\. \*\*/m);
      expect(reply).toMatch(/^\| --- \|/m);
    }
    expect(CHAT_CASES.map((c) => c.earlier + 2)).toEqual([6, 100]);
  });
});

describe('aiEdit metrics', () => {
  /**
   * One request's window, from the scenario's send mark at `at`: main receives it 2 ms later, has the adapter 10 ms
   * after that, starts the starting build at 30 for `startMs`, asks the model 20 ms past it, compiles again for its
   * checks 200 ms after the first model turn, and ends 100 ms after the last; decoys of each record sit just outside
   * the window.
   */
  function aiCase(key: string, at: number, o: { startMs?: number; compiled?: number; checks?: Array<{ ms: number; compiled: number }>; turns?: number } = {}): PerfRecord[] {
    const startMs = o.startMs ?? 100;
    const compiled = o.compiled ?? 54;
    const checks = o.checks ?? [{ ms: 40, compiled: 2 }];
    const turns = o.turns ?? 2;
    const modelAt = at + 32 + startMs + 20;
    return [
      span('ai.compile', at - 1, 500, { dc: { 'compile.svelte': 999, 'compile.files': 999 } }),
      m('ai.modelRequest', at - 0.5),
      m('aiEdit.send', at, { attrs: { at: key } }),
      r('aiEdit.send', at, { attrs: { at: key } }),
      m('ai.send', at + 2, { attrs: { mode: 'edit' } }),
      m('ai.runStart', at + 3),
      m('ai.adapterReady', at + 12),
      span('ai.compile', at + 32 + startMs, startMs, { dc: { 'compile.svelte': compiled, 'compile.files': compiled / 2 } }),
      ...Array.from({ length: turns }, (_, i) => m('ai.modelRequest', modelAt + i * 50)),
      ...checks.map((c, i) => span('ai.compile', modelAt + 200 + i * 60, c.ms, { dc: { 'compile.svelte': c.compiled, 'compile.files': c.compiled / 2 } })),
      m('ai.runEnd', modelAt + 200 + checks.length * 60 + 100),
      m('aiEdit.end', modelAt + 2000, { attrs: { at: key } }),
      span('ai.compile', modelAt + 2001, 500, { dc: { 'compile.svelte': 999 } })
    ];
  }
  const both = () => [...aiCase('first', 1000, { startMs: 1500, compiled: 1316, checks: [{ ms: 900, compiled: 1316 }] }), ...aiCase('second', 10_000, { startMs: 3, compiled: 0, checks: [{ ms: 5, compiled: 2 }, { ms: 4, compiled: 0 }] })];

  it('time each request from main receiving it to the first model turn, in its phases, and count what each compile compiled', () => {
    const got = aiEdit.measure(new Trace(both()), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('aiEdit.first.toModel'), v('aiEdit.first.toAdapter'), v('aiEdit.first.toCompile'), v('aiEdit.first.startCompile'), v('aiEdit.first.compileToModel')]).toEqual([30 + 1500 + 20, 10, 20, 1500, 20]);
    expect([v('aiEdit.first.startCompiled'), v('aiEdit.first.startFiles'), v('aiEdit.first.checkCompile'), v('aiEdit.first.checkCompiled'), v('aiEdit.first.compiles'), v('aiEdit.first.modelTurns')]).toEqual([1316, 658, 900, 1316, 2, 2]);
    expect([v('aiEdit.second.toModel'), v('aiEdit.second.startCompiled'), v('aiEdit.second.checkCompile'), v('aiEdit.second.checkCompiled'), v('aiEdit.second.compiles')]).toEqual([30 + 3 + 20, 0, 9, 2, 3]);
    expect([v('aiEdit.first.runMs'), v('aiEdit.second.runMs')]).toEqual([1550 + 200 + 60 + 100, 53 + 200 + 120 + 100]);
    expect(got.metrics['aiEdit.second.startCompiled'].unit).toBe('count');
  });

  it('take the longest main-process stall inside each run only', () => {
    const stall = (t: number, ms: number) => m('main.stall', t, { kind: 'span', ms });
    const got = aiEdit.measure(new Trace([...both(), stall(1200, 1400), stall(10_100, 60), stall(5000, 3000), stall(10_500, 900)]), facts);
    expect([got.metrics['aiEdit.first.mainStallMax'].value, got.metrics['aiEdit.second.mainStallMax'].value]).toEqual([1400, 60]);
  });

  it('name a request whose marks are missing instead of timing it without them', () => {
    const drop = (names: string[], key: string) => both().filter((x) => !(names.includes(x.name) && x.t > (key === 'first' ? 1000 : 10_000) && x.t < (key === 'first' ? 4500 : 12_000)));
    const noModel = aiEdit.measure(new Trace(drop(['ai.modelRequest'], 'second')), facts);
    expect(noModel.missing).toEqual(['ai.modelRequest (second)']);
    expect(noModel.metrics['aiEdit.second.toModel']).toBeUndefined();
    expect(noModel.metrics['aiEdit.first.toModel']).toBeDefined();
    // A run that never compiled before its first model turn, or never checked its change, is not a faster one.
    const noStart = aiEdit.measure(new Trace(both().filter((x) => !(x.name === 'ai.compile' && x.t === 1000 + 32 + 1500))), facts);
    expect(noStart.missing).toEqual(['ai.compile before the first model turn (first)']);
    const noCheck = aiEdit.measure(new Trace(both().filter((x) => !(x.name === 'ai.compile' && x.t > 1000 + 32 + 1500 && x.t < 4000))), facts);
    expect(noCheck.missing).toEqual(['ai.compile after the first model turn (first)']);
    const half = aiEdit.measure(new Trace(aiCase('first', 1000)), facts);
    expect(half.missing).toEqual(['aiEdit.send (second, main)', 'aiEdit.end (second, main)']);
    const noEnd = aiEdit.measure(new Trace(drop(['ai.runEnd'], 'first')), facts);
    expect(noEnd.missing).toEqual(['ai.runEnd (first)']);
  });

  it('ask for a different heading each time', () => {
    expect(AI_EDIT_CASES.map((c) => c.key)).toEqual(['first', 'second']);
    expect(new Set(AI_EDIT_CASES.map((c) => c.heading)).size).toBe(AI_EDIT_CASES.length);
    expect(AI_EDIT_CASES.every((c) => c.heading !== facts.heading)).toBe(true);
  });
});

describe('ai metrics', () => {
  /** One measurement: main's span from `start` to `end`, the editor's loads of the page for it (each [load, ready, done]). */
  const inspect = (req: string, start: number, end: number, loads: Array<[number, number | null, number]>, ok = true): PerfRecord[] => [
    span('ai.inspect', end, end - start, { attrs: { req, width: 1280, revision: 4, ok } }),
    ...loads.flatMap(([load, ready, done], i) => [
      r('inspect.load', load, { attrs: { req, attempt: i + 1 } }),
      ...(ready === null ? [] : [r('inspect.ready', ready, { attrs: { req, attempt: i + 1 } })]),
      r('inspect.done', done, { attrs: { req, attempt: i + 1, images: 10, fonts: 20, frame: 300 } })
    ])
  ];
  /**
   * A run from 1000 to 9000: a turn of two reads and two page checks (1100–3100), a batch's baselines (3200–5200) and
   * the finish's check (6000–8000), with a measurement just outside the run as a decoy.
   */
  const trace = (o: { retried?: boolean; failed?: boolean; noLoad?: boolean } = {}) =>
    new Trace([
      ...inspect('decoy', 500, 900, [[600, 700, 800]]),
      m('ai.requested', 950),
      r('ai.requested', 950),
      span('ai.turnTools', 3100, 2000, { attrs: { turn: 1, calls: 4, reads: 4 } }),
      span('ai.tool', 1200, 100, { attrs: { tool: 'read_page', turn: 1 } }),
      span('ai.tool', 1300, 100, { attrs: { tool: 'read_page', turn: 1 } }),
      span('ai.tool', 2300, 1000, { attrs: { tool: 'inspect_layout', turn: 1 } }),
      span('ai.tool', 3100, 800, { attrs: { tool: 'inspect_layout', turn: 1 } }),
      ...inspect('t1', 1310, 2290, [[1710, 1910, 2280]]),
      ...inspect('t2', 2310, 3090, [[2710, 2910, 3080]]),
      span('ai.turnTools', 5900, 2600, { attrs: { turn: 2, calls: 1, reads: 0 } }),
      span('ai.tool', 5900, 2600, { attrs: { tool: 'apply_operations', turn: 2 } }),
      span('ai.baselines', 5200, 2000),
      ...inspect('b1', 3200, 4200, [[3600, 3800, 4190]]),
      ...(o.noLoad ? [span('ai.inspect', 5200, 1000, { attrs: { req: 'b2', ok: true } })] : inspect('b2', 4200, 5200, o.retried ? [[4300, 4400, 4500], [4600, null, 5190]] : [[4600, 4800, 5190]])),
      span('ai.finalCheck', 8000, 2000, { attrs: { targets: 2 } }),
      ...inspect('f1', 6000, 7000, [[6400, 6600, 6990]], !o.failed),
      ...inspect('f2', 7000, 8000, [[7400, 7600, 7990]]),
      span('ai.run', 9000, 8000, { attrs: { status: 'completed' } }),
      ...inspect('decoy2', 9100, 9500, [[9200, 9300, 9400]])
    ]);

  it('count the run’s measurements by where they were made, split each into settle, load and measure, and time the turn of reads', () => {
    const got = ai.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('ai.runMs'), v('ai.replyMs')]).toEqual([8000, 8050]);
    expect([v('ai.measurements'), v('ai.toolMeasurements'), v('ai.baselineMeasurements'), v('ai.finalMeasurements'), v('ai.retries')]).toEqual([6, 2, 2, 2, 0]);
    // Each one 400 ms before its load, 200 loading and the rest measuring (less the 10 ms of its answer).
    expect([v('ai.settleMs'), v('ai.loadMs'), v('ai.measureMs')]).toEqual([400, 200, 390]);
    expect([v('ai.waitImagesMs'), v('ai.waitFontsMs'), v('ai.waitFrameMs')]).toEqual([10, 20, 300]);
    expect([v('ai.settleMsTotal'), v('ai.loadMsTotal'), v('ai.measureMsTotal'), v('ai.retryWaitMsTotal')]).toEqual([2400, 1200, 370 + 170 + 4 * 390, 0]);
    expect([v('ai.measureMsSum'), v('ai.measureWallMs')]).toEqual([980 + 780 + 1000 + 1000 + 1000 + 1000, 980 + 780 + 2000 + 2000]);
    expect(got.metrics['ai.measureShare']).toEqual({ unit: 'share', value: 5760 / 8000 });
    expect([v('ai.baselinesMs'), v('ai.finalCheckMs')]).toEqual([2000, 2000]);
    expect([v('ai.readTurnMs'), v('ai.readTurnCalls'), v('ai.readTurnCallMsSum')]).toEqual([2000, 4, 2000]);
  });

  it('count a second load of a page that looked behind, with the wait before it, and time a page that never said it was ready as loading', () => {
    const got = ai.measure(trace({ retried: true }), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('ai.retries'), v('ai.retryWaitMsTotal')]).toEqual([1, 100]);
    expect(v('ai.loadMsTotal')).toBe(1000 + 100 + 590);
  });

  it('name a measurement whose loads are missing, and the run’s span, instead of reporting less work', () => {
    expect(ai.measure(trace({ noLoad: true }), facts).missing).toEqual(['inspect.load / inspect.done (a measurement’s loads)']);
    const noRun = new Trace(trace().records.filter((x) => x.name !== 'ai.run'));
    expect(ai.measure(noRun, facts).missing).toEqual(['ai.run']);
    const noCheck = new Trace(trace().records.filter((x) => x.name !== 'ai.finalCheck'));
    expect(ai.measure(noCheck, facts).missing).toEqual(['ai.finalCheck']);
  });

  it('say which measurements did not answer, and add up overlapping ones once', () => {
    const got = aiMeasurements(trace({ failed: true }), 1000, 9000)!;
    expect(got.filter((x) => !x.ok)).toHaveLength(1);
    expect(coveredMs([{ start: 0, end: 10 }, { start: 5, end: 12 }, { start: 20, end: 25 }, { start: 21, end: 22 }])).toBe(17);
  });

  it('send several tool calls in one response, each with its own index and ID', () => {
    const reply = toolCallsReply([{ id: 'a', name: 'read_page', args: { pageId: 'p1' } }, { id: 'b', name: 'inspect_layout', args: { pageId: 'p1', viewport: 'desktop' } }]);
    const calls = (reply.frames as Array<{ choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; id?: string; function: { name?: string; arguments: string } }> } }> }>).flatMap((f) => (typeof f === 'object' ? (f.choices?.[0]?.delta?.tool_calls ?? []) : []));
    expect(calls.filter((c) => c.id).map((c) => [c.index, c.id, c.function.name])).toEqual([[0, 'a', 'read_page'], [1, 'b', 'inspect_layout']]);
    expect(calls.filter((c) => c.index === 1).map((c) => c.function.arguments).join('')).toBe('{"pageId":"p1","viewport":"desktop"}');
  });
});

describe('export metrics', () => {
  /** One export's records from `at`, for the scenario `name`; the export runs 1000 ms from its span's start. */
  const one = (name: string, at: number, scale = 1) => [
    r('scenario.start', at, { attrs: { scenario: name } }),
    m('scenario.start', at, { attrs: { scenario: name } }),
    span('export.sweep', at + 12, 2),
    span('export.icons', at + 20, 5),
    span('export.fingerprint', at + 40, 15, { attrs: { pass: 'before' }, dc: { 'export.filesRead': 10, 'export.bytesRead': 5000 } }),
    span('export.lockHeld', at + 100, 80 * scale, { dc: { 'export.filesRead': 25 * scale, 'export.bytesRead': 12_000 * scale } }),
    span('export.stage', at + 100, 90 * scale),
    m('export.library', at + 101, { attrs: { files: 300, bytes: 6_000_000 } }),
    span('export.assets.prune', at + 150, 30),
    span('main.stall', at + 160, 60),
    span('export.copyTools', at + 300, 100, { dc: { 'export.filesCopied': 1800 * scale } }),
    span('export.build', at + 800, 450),
    span('export.verify.cleanBuilt', at + 880, 40),
    span('export.publish', at + 940, 30),
    span('export.cleanup', at + 1005, 4),
    span('controller.exportStatic', at + 1010, 1000, { dc: { 'export.filesRead': 900 * scale, 'export.bytesRead': 7_000_000 * scale, 'fs.writes': 40, 'export.filesCopied': 3000 * scale } }),
    m('export.output', at + 1500, { attrs: { scenario: name, files: 700, bytes: 3_000_000 } }),
    r('export.output', at + 1500, { attrs: { scenario: name, files: 700, bytes: 3_000_000 } }),
    m('scenario.end', at + 3000, { attrs: { scenario: name } })
  ];
  const trace = (drop: (x: PerfRecord) => boolean = () => false) => new Trace([...one('export', 10_000), ...one('exportAgain', 20_000, 0.5)].filter((x) => !drop(x)));
  const show = (got: ReturnType<Scenario['measure']>) => Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]));

  it('time each phase of an export, from the span of the whole export, and count what it read', () => {
    const got = exportSite.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(show(got)).toEqual({
      'export.total': '1000 ms',
      'export.stage': '90 ms',
      'export.lockHeld': '80 ms',
      // From the snapshot's end (100) to the tools' copy starting (200).
      'export.assets': '100 ms',
      'export.copyTools': '100 ms',
      'export.build': '450 ms',
      // From the build's end (800) to the publication starting (910).
      'export.verify': '110 ms',
      'export.publish': '30 ms',
      // From the publication's end (940) to the cleanup starting (1001).
      'export.finish': '61 ms',
      'export.cleanup': '4 ms',
      'export.filesRead': '900 count',
      'export.bytesRead': '7000000 bytes',
      'export.lockFilesRead': '25 count',
      'export.lockBytesRead': '12000 bytes',
      'export.fileWrites': '40 count',
      'export.filesCopied': '3000 count',
      'export.toolsCopied': '1800 count',
      'export.libraryFiles': '300 count',
      'export.libraryBytes': '6000000 bytes',
      'export.outputFiles': '700 count',
      'export.outputBytes': '3000000 bytes',
      'export.mainStallMax': '60 ms'
    });
  });

  it('take the second export’s records for exportAgain, never the first’s', () => {
    const got = exportAgain.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics['exportAgain.lockHeld'].value).toBe(40);
    expect(got.metrics['exportAgain.bytesRead'].value).toBe(3_500_000);
    expect(got.metrics['exportAgain.lockFilesRead'].value).toBe(12.5);
    expect(got.metrics['exportAgain.toolsCopied'].value).toBe(900);
  });

  it('name a phase that is missing instead of reporting the export without it', () => {
    for (const name of ['export.lockHeld', 'export.build', 'export.copyTools', 'export.publish', 'export.cleanup', 'export.library'])
      expect(exportSite.measure(trace((x) => x.name === name && x.t < 20_000), facts).missing).toEqual([name]);
    // Without its own export's span, the scenario never takes the next export's.
    const without = exportSite.measure(trace((x) => x.name === 'controller.exportStatic' && x.t < 20_000), facts);
    expect(without.missing).toEqual(expect.arrayContaining(['controller.exportStatic', 'export.stage', 'export.lockHeld', 'export.build']));
    expect(without.metrics['export.total']).toBeUndefined();
    expect(exportSite.measure(trace((x) => x.name === 'scenario.end' && x.t < 20_000), facts).missing).toEqual(expect.arrayContaining(['scenario.end (main)']));
    // The output counted on disk after the export, by the scenario's own mark.
    expect(exportSite.measure(trace((x) => x.name === 'export.output' && x.t < 20_000), facts).missing).toEqual(['export.output']);
    expect(exportSite.measure(trace((x) => x.name === 'export.output' && x.t < 20_000), facts).metrics['export.outputFiles']).toBeUndefined();
  });
});

describe('canvas metrics', () => {
  /** One window of `canvas`: its edges with the editor's counters, a report span each (a decoy just outside), and the
   *  frame watch's findings on its end mark. */
  function window(name: 'scroll' | 'sweep', at: number, o: { reports?: number[]; hovers?: number[]; counts?: [number, number]; frames?: Record<string, number>; untimed?: boolean } = {}): PerfRecord[] {
    const [c0, c1] = o.counts ?? [0, 10];
    const c = (n: number) => ({ c: { 'canvas.renders': n * 2, 'canvas.rectReports': n, 'canvas.rectReportsSame': Math.floor(n / 5), 'canvas.hoverReports': n * 3, 'react.commits': n, 'react.renders': n * 20, 'store.updates': n * 4, 'store.selectorRuns': n * 100 } });
    const frames = o.frames ?? { frames: 120, droppedFrames: 1, longTasks: 0, longTaskMs: 0, longestFrameMs: 33.4 };
    return [
      r('canvas.rects', at - 1, { kind: 'span', ms: 50 }),
      r('canvas.window', at, { attrs: { scenario: 'canvas', window: name, edge: 'start' }, ...c(c0) }),
      ...(o.reports ?? [1, 2, 3]).map((ms, i) => r('canvas.rects', at + 1 + i, { kind: 'span', ms, attrs: o.untimed ? {} : { pageMs: ms / 4 } })),
      ...(o.hovers ?? []).map((ms, i) => r('canvas.hover', at + 50 + i, { kind: 'span', ms })),
      r('canvas.window', at + 2000, { attrs: { scenario: 'canvas', window: name, edge: 'end', ...frames }, ...c(c1) }),
      r('canvas.rects', at + 2001, { kind: 'span', ms: 50 })
    ];
  }
  const start = r('scenario.start', 900, { attrs: { scenario: 'canvas', periodMs: 16.7 } });
  const outlined = (t: number, movedAt: number) => r('canvas.hoverOutlined', t, { attrs: { movedAt } });

  it('count each window’s renders and reports, time its reports, and time each hover from the move to its outline', () => {
    const got = canvas.measure(new Trace([start, ...window('scroll', 1000), ...window('sweep', 4000, { reports: [2], hovers: [1, 1, 4], counts: [10, 15] }), outlined(4100, 4080), outlined(4200, 4170), outlined(4300, 4290), outlined(6100, 6000)]), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('canvas.framePeriodMs'), v('canvas.scroll.ms'), v('canvas.scroll.canvasRenders'), v('canvas.scroll.rectReports'), v('canvas.scroll.rectReportsSame'), v('canvas.scroll.hoverReports')]).toEqual([16.7, 2000, 20, 10, 2, 30]);
    expect([v('canvas.scroll.rendererCommits'), v('canvas.scroll.renders'), v('canvas.scroll.reportMs'), v('canvas.scroll.reportMsTotal')]).toEqual([10, 200, 2, 6]);
    expect([v('canvas.scroll.frames'), v('canvas.scroll.droppedFrames'), v('canvas.scroll.longTasks'), v('canvas.scroll.longTaskMs'), v('canvas.scroll.longestFrameMs')]).toEqual([120, 1, 0, 0, 33.4]);
    // The store's updates and selector runs in the window, and the page's time measuring for each report of its outlines
    // (a hover report has none).
    expect([v('canvas.scroll.storeUpdates'), v('canvas.scroll.selectorRuns'), v('canvas.scroll.pageMeasureMs'), v('canvas.scroll.pageMeasureMsTotal')]).toEqual([40, 1000, 0.5, 1.5]);
    expect([v('canvas.sweep.storeUpdates'), v('canvas.sweep.selectorRuns'), v('canvas.sweep.pageMeasureMs'), v('canvas.sweep.pageMeasureMsTotal')]).toEqual([20, 500, 0.5, 0.5]);
    // The sweep's own counters and spans, the hover reports with the rect reports; the outline after its window is not its.
    expect([v('canvas.sweep.canvasRenders'), v('canvas.sweep.rectReports'), v('canvas.sweep.reportMs'), v('canvas.sweep.reportMsTotal')]).toEqual([10, 5, 1.5, 8]);
    expect([v('canvas.sweep.hoversOutlined'), v('canvas.sweep.hoverOutlineMs')]).toEqual([3, 20]);
  });

  it('name what is missing instead of reporting a window that did less', () => {
    const got = canvas.measure(new Trace([...window('scroll', 1000, { reports: [], frames: {} }), ...window('sweep', 4000), r('canvas.hoverOutlined', 4100, { attrs: {} })]), facts);
    expect(got.missing).toEqual([
      'scenario.start (renderer)',
      'scenario.start (renderer, with the frame period)',
      "canvas.scroll: the page's reports (canvas.rects, canvas.hover spans)",
      "canvas.scroll.pageMeasureMs (a report of the outlines without the page's time measuring them)",
      'canvas.scroll.frames (the frame watch)',
      'canvas.scroll.droppedFrames (the frame watch)',
      'canvas.scroll.longTasks (the frame watch)',
      'canvas.scroll.longTaskMs (the frame watch)',
      'canvas.scroll.longestFrameMs (the frame watch)',
      'canvas.hoverOutlined (a hover without the time the pointer moved)'
    ]);
    const none = canvas.measure(new Trace([start, ...window('scroll', 1000), ...window('sweep', 4000)]), facts);
    expect(none.missing).toEqual(['canvas.hoverOutlined (no hover outlined in the sweep)']);
    // A frame watch that stalled: 40 frames in a window of 2 s at 16.7 ms is fewer than half.
    const stalled = canvas.measure(new Trace([start, ...window('scroll', 1000, { frames: { frames: 40, droppedFrames: 0, longTasks: 0, longTaskMs: 0, longestFrameMs: 16.7 } }), ...window('sweep', 4000), outlined(4100, 4080)]), facts);
    expect(stalled.missing).toEqual(['canvas.scroll.frames (the frame watch saw 40 frames in 2000 ms)']);
    // A report of the outlines from a page that did not time its measuring, and an editor that did not count its store.
    const untimed = canvas.measure(new Trace([start, ...window('scroll', 1000, { untimed: true }), ...window('sweep', 4000), outlined(4100, 4080)]), facts);
    expect(untimed.missing).toEqual(["canvas.scroll.pageMeasureMs (a report of the outlines without the page's time measuring them)"]);
    const uncounted = canvas.measure(new Trace([start, ...window('scroll', 1000).map((x) => (x.c ? { ...x, c: { ...x.c, 'store.selectorRuns': undefined as unknown as number } } : x)), ...window('sweep', 4000), outlined(4100, 4080)]), facts);
    expect(uncounted.missing).toEqual(["canvas.scroll.storeUpdates, .selectorRuns (the editor did not count its store's updates and selectors)"]);
    const half = canvas.measure(new Trace([start, ...window('scroll', 1000)]), facts);
    expect(half.missing).toEqual(['canvas.window sweep start', 'canvas.window sweep end']);
  });

  it('measure the last attempt of a window done again after a reload, never the one the reload was in', () => {
    const again = (records: PerfRecord[], attempt: number) => records.map((x) => (x.name === 'canvas.window' ? { ...x, attrs: { ...x.attrs, attempt } } : x));
    const first = again(window('scroll', 1000, { reports: [9, 9, 9], counts: [0, 50] }), 1);
    const second = again(window('scroll', 5000, { reports: [1, 2, 3], counts: [50, 60] }), 2);
    const sweep = again(window('sweep', 9000), 1);
    const got = canvas.measure(new Trace([start, ...first, r('canvas.ready', 1500), ...second, ...sweep, outlined(9100, 9080)]), facts);
    expect(got.missing).toEqual([]);
    expect([got.metrics['canvas.scroll.rectReports'].value, got.metrics['canvas.scroll.reportMs'].value, got.metrics['canvas.scroll.reportMsTotal'].value]).toEqual([10, 2, 6]);
    // A last attempt whose end never arrived is missing, not the attempt before it.
    const cut = canvas.measure(new Trace([start, ...first, ...second.filter((x) => !(x.name === 'canvas.window' && x.attrs?.edge === 'end')), ...sweep, outlined(9100, 9080)]), facts);
    expect(cut.missing).toEqual(['canvas.window scroll end']);
  });

  it('count a frame that came a period or more late as the frames it dropped', () => {
    expect(framesOf([0, 16.7, 33.4, 66.8, 83.5, 150.3], [60, 75], 16.7)).toEqual({ frames: 6, droppedFrames: 4, longestFrameMs: 150.3 - 83.5, longTasks: 2, longTaskMs: 135 });
    expect(framesOf([0, 16, 34, 50], [], 16.7).droppedFrames).toBe(0);
    expect(framesOf([], [], 16.7)).toEqual({ frames: 0, droppedFrames: 0, longestFrameMs: 0, longTasks: 0, longTaskMs: 0 });
  });
});

describe('import metrics', () => {
  /** A web-sized copy of photo `i` and then its copies, from `at`: 100 ms and 300 ms of the worker's time. */
  const photo = (i: number, at: number) => [
    span('import.file', at + 450, 440, { attrs: { i } }),
    m('media.request', at + 110, { attrs: { kind: 'web', ms: 100, workMs: 95, cpuMs: 150, cpuStart: (i - 1) * 850, cpuEnd: (i - 1) * 850 + 150, peakRss: 200_000_000 + i, worker: 7, decodes: 2, encodes: 1, decodeMs: 30 + i, webCopyMs: 60, jpegMs: 0, pngMs: 0, webpMs: 0, avifMs: 0 } }),
    m('media.request', at + 420, { attrs: { kind: 'variants', ms: 300, workMs: 290, cpuMs: 700, cpuStart: (i - 1) * 850 + 150, cpuEnd: i * 850, peakRss: 300_000_000 + i, worker: 7, decodes: 15, encodes: 14, decodeMs: 5, webCopyMs: 0, jpegMs: 40, pngMs: 0, webpMs: 200 + i, avifMs: 50, extra: 'x' } })
  ];
  const at0 = 10_000;
  const records = () => [
    r('scenario.start', at0, { attrs: { scenario: 'import' } }),
    m('scenario.start', at0, { attrs: { scenario: 'import' } }),
    span('controller.reviewImport', at0 + 90, 80),
    r('import.requested', at0 + 500, { attrs: { files: PHOTO_COUNT, revision: 4 } }),
    ...Array.from({ length: PHOTO_COUNT }, (_, n) => photo(n + 1, at0 + 600 + n * 500)).flat(),
    span('session.apply', at0 + 10_900, 200),
    span('main.stall', at0 + 10_700, 80),
    span('controller.importAssets', at0 + 11_000, 10_400, { dc: { 'fs.writes': 220, 'fs.durableWrites': 220, 'fs.fsyncs': 440, 'ipc.projectChanged.sends': 1, 'ipc.projectChanged.bytes': 52_000 } }),
    r('renderer.commit', at0 + 11_050, { attrs: { revision: 5 } }),
    r('import.done', at0 + 11_200, { attrs: { scenario: 'import', revision: 5, images: 20, variants: 280 } }),
    m('import.done', at0 + 11_200, { attrs: { scenario: 'import', revision: 5, images: 20, variants: 280 } }),
    // After the window: another media request, a stall and a commit are none of the import's.
    m('media.request', at0 + 12_000, { attrs: { kind: 'icons', ms: 50, workMs: 50, cpuMs: 50, cpuStart: 0, cpuEnd: 99_999, peakRss: 900_000_000, worker: 9, decodes: 1, encodes: 1, decodeMs: 1, webCopyMs: 0, jpegMs: 0, pngMs: 0, webpMs: 0, avifMs: 0 } }),
    span('main.stall', at0 + 12_100, 500),
    m('scenario.end', at0 + 13_000, { attrs: { scenario: 'import' } })
  ];
  const trace = (drop: (x: PerfRecord) => boolean = () => false) => new Trace(records().filter((x) => !drop(x)));
  const show = (got: ReturnType<Scenario['measure']>) => Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]));

  it('time the import from the editor asking for it to the commit that shows every photo, and add up what the worker did', () => {
    const got = importPhotos.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(show(got)).toEqual({
      'import.review': '80 ms',
      'import.total': '10550 ms',
      'import.firstShown': '10550 ms',
      'import.main': '10400 ms',
      'import.apply': '200 ms',
      'import.applies': '1 count',
      'import.image.ms': '440 ms',
      'import.image.webMs': '100 ms',
      'import.image.webDecodeMs': '40.5 ms',
      'import.image.webCopyMs': '60 ms',
      'import.image.copiesMs': '300 ms',
      'import.image.copiesDecodeMs': '5 ms',
      'import.image.jpegMs': '40 ms',
      'import.image.webpMs': '210.5 ms',
      'import.image.avifMs': '50 ms',
      'import.workerRequests': '40 count',
      'import.decodes': '340 count',
      'import.encodes': '300 count',
      'import.workerCpuMs': '17000 ms',
      'import.workers': '1 count',
      'import.workerPeakRss': '300000020 bytes',
      'import.fileWrites': '220 count',
      'import.durableWrites': '220 count',
      'import.fsyncs': '440 count',
      'import.snapshotsSent': '1 count',
      'import.snapshotBytes': '52000 bytes',
      'import.images': '20 count',
      'import.variants': '280 count',
      'import.mainStallMax': '80 ms'
    });
  });

  it('time the first photos shown apart from the last, and add each worker’s peak memory', () => {
    const t = trace();
    // Photos arriving in two steps (revisions 5 and 6), from two workers.
    const two = new Trace(
      t.records.map((x) => (x.name === 'import.done' ? { ...x, attrs: { ...x.attrs, revision: 6 } } : x.name === 'media.request' && x.attrs?.kind === 'variants' && Number(x.attrs.peakRss) % 2 ? { ...x, attrs: { ...x.attrs, worker: 8 } } : x)).concat([r('renderer.commit', at0 + 11_100, { attrs: { revision: 6 } }), r('renderer.commit', at0 + 4_000, { attrs: { revision: 5 } })])
    );
    const got = importPhotos.measure(new Trace([...two.records].sort((a, b) => a.t - b.t)), facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics['import.firstShown'].value).toBe(3500);
    expect(got.metrics['import.total'].value).toBe(10_600);
    expect(got.metrics['import.workers'].value).toBe(2);
    // Each worker's CPU from its first request's start to its last answer: 0 to 17,000 and 150 to 16,150.
    expect(got.metrics['import.workerCpuMs'].value).toBe(17_000 + 16_000);
    expect(got.metrics['import.workerPeakRss'].value).toBe(300_000_020 + 300_000_019);
  });

  it('time the change that adds the photos, the first of the import, and count the ones after it', () => {
    // The photos land first, with their copies following in two more changes.
    const later = new Trace([...records(), span('session.apply', at0 + 2_300, 120), span('session.apply', at0 + 6_100, 90)].sort((a, b) => a.t - b.t));
    const got = importPhotos.measure(later, facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics['import.apply'].value).toBe(120);
    expect(got.metrics['import.applies'].value).toBe(3);
    // A change outside the import's own span is none of its.
    expect(importPhotos.measure(new Trace([...records(), span('session.apply', at0 + 12_500, 70)].sort((a, b) => a.t - b.t)), facts).metrics['import.applies'].value).toBe(1);
  });

  /** The same import under another of the scenario's modes: its own name on the marks, and `drop` left out. */
  const asMode = (scenario: string, drop: (x: PerfRecord) => boolean = () => false) =>
    new Trace(records().filter((x) => !drop(x)).map((x) => (x.attrs?.scenario === 'import' ? { ...x, attrs: { ...x.attrs, scenario } } : x)));

  it('measure kept originals without web-sized copies, and HEIC photos with them, each under its own name', () => {
    const originals = importOriginals.measure(asMode('importOriginals', (x) => x.name === 'media.request' && x.attrs?.kind === 'web'), facts);
    expect(originals.missing).toEqual([]);
    expect(Object.keys(originals.metrics).every((k) => k.startsWith('importOriginals.'))).toBe(true);
    expect(originals.metrics['importOriginals.image.webMs']).toBeUndefined();
    expect([originals.metrics['importOriginals.total'].value, originals.metrics['importOriginals.workerRequests'].value, originals.metrics['importOriginals.image.copiesMs'].value]).toEqual([10_550, 20, 300]);
    // A kept original is never given a web-sized copy by the import: one the editor asks for meanwhile is not the import's.
    const weighed = importOriginals.measure(asMode('importOriginals', (x) => x.name === 'media.request' && x.attrs?.kind === 'web' && x.t > at0 + 1000), facts);
    expect(weighed.missing).toEqual([]);
    expect(weighed.metrics['importOriginals.image.webMs']).toBeUndefined();
    expect(weighed.metrics['importOriginals.workerRequests'].value).toBe(PHOTO_COUNT + 1);
    // A picture only checked, encoding nothing, is no photo's copies: the copies of each photo are still needed.
    const checked = (x: PerfRecord) => (x.name === 'media.request' && x.attrs?.kind === 'variants' && x.t < at0 + 2000 ? { ...x, attrs: { ...x.attrs, encodes: 0 } } : x);
    expect(importPhotos.measure(new Trace(records().map(checked)), facts).missing).toEqual([`media.request marks (${PHOTO_COUNT} web-sized and ${PHOTO_COUNT - 2} copies of ${PHOTO_COUNT} photos)`]);
    const alsoChecked = new Trace([...records(), m('media.request', at0 + 700, { attrs: { kind: 'variants', ms: 5, workMs: 5, cpuMs: 5, cpuStart: 1, cpuEnd: 6, peakRss: 1, worker: 7, decodes: 1, encodes: 0, decodeMs: 4, webCopyMs: 0, jpegMs: 0, pngMs: 0, webpMs: 0, avifMs: 0 } })].sort((a, b) => a.t - b.t));
    const withCheck = importPhotos.measure(alsoChecked, facts);
    expect(withCheck.missing).toEqual([]);
    expect([withCheck.metrics['import.workerRequests'].value, withCheck.metrics['import.decodes'].value, withCheck.metrics['import.image.copiesDecodeMs'].value]).toEqual([41, 341, 5]);
    const heic = importHeic.measure(asMode('importHeic'), facts);
    expect(heic.missing).toEqual([]);
    expect([heic.metrics['importHeic.image.webMs'].value, heic.metrics['importHeic.workerRequests'].value]).toEqual([100, 40]);
    // Each mode reads only its own marks: the web-sized import's are not the HEIC one's.
    expect(importHeic.measure(trace(), facts).missing).toEqual(expect.arrayContaining(['scenario.start (renderer)', 'import.done']));
  });

  it('expect each photo at the size it is stored at, upright', () => {
    expect(storedPhotoSize('web', false)).toEqual([2560, 1920]);
    expect(storedPhotoSize('heic', true)).toEqual([1920, 2560]);
    expect(storedPhotoSize('originals', false)).toEqual([4032, 3024]);
    expect(storedPhotoSize('originals', true)).toEqual([3024, 4032]);
  });

  it('name what is missing instead of reporting an import with less in it', () => {
    for (const name of ['import.requested', 'import.done', 'controller.importAssets', 'controller.reviewImport', 'session.apply']) expect(importPhotos.measure(trace((x) => x.name === name), facts).missing).toContain(name);
    expect(importPhotos.measure(trace((x) => x.name === 'renderer.commit'), facts).missing).toEqual(expect.arrayContaining(['renderer.commit (the import)']));
    // A photo whose span or worker requests are missing is not a faster import.
    expect(importPhotos.measure(trace((x) => x.name === 'import.file' && x.attrs?.i === 3), facts).missing).toEqual([`import.file spans (${PHOTO_COUNT - 1} of ${PHOTO_COUNT})`]);
    expect(importPhotos.measure(trace((x) => x.name === 'media.request' && x.attrs?.kind === 'web' && x.t < at0 + 2000), facts).missing).toEqual([`media.request marks (${PHOTO_COUNT - 3} web-sized and ${PHOTO_COUNT} copies of ${PHOTO_COUNT} photos)`]);
    expect(importPhotos.measure(trace((x) => x.name === 'import.file' && x.attrs?.i === 3), facts).metrics['import.image.ms']).toBeUndefined();
  });

  it('check each photo’s copies by format and width', () => {
    expect(expectedCopies(2560)).toEqual({ jpg: [160, 480, 960, 1440], webp: [160, 480, 960, 1440, 2560], avif: [160, 480, 960, 1440, 2560] });
    // 1440 is not meaningfully smaller than 1500.
    expect(expectedCopies(1500).jpg).toEqual([160, 480, 960]);
    const rec = (files: string[]) => ({ id: 'a', name: 'photo 01', file: 'static/assets/photo-01-abc.jpg', mime: 'image/jpeg', kind: 'image', width: 2560, height: 1920, variants: files.map((f) => ({ width: Number(f.split('.')[0]), file: `static/assets/photo-01-abc-${f.split('.')[0]}w.${f.split('.')[1]}` })) });
    const jpg = ['160.jpg', '480.jpg', '960.jpg', '1440.jpg'];
    const webp = ['160.webp', '480.webp', '960.webp', '1440.webp', '2560.webp'];
    const avif = webp.map((f) => f.replace('webp', 'avif'));
    expect(copiesProblem(rec([...jpg, ...webp]))).toBeNull();
    expect(copiesProblem(rec([...jpg, ...webp, ...avif]))).toBeNull();
    expect(copiesProblem(rec([...jpg, ...webp.slice(0, 4)]))).toBe('webp copies at 160, 480, 960, 1440, not 160, 480, 960, 1440, 2560');
    expect(copiesProblem(rec([...jpg, ...webp, ...avif.slice(1)]))).toBe('AVIF copies at 480, 960, 1440, 2560, not 160, 480, 960, 1440, 2560 or none');
    expect(copiesProblem(rec([...jpg.slice(1), ...webp]))).toBe('jpg copies at 480, 960, 1440, not 160, 480, 960, 1440');
    expect(copiesProblem(rec([...jpg, ...webp, '480.png']))).toMatch(/^a copy in another format/);
    expect(copiesProblem({ ...rec([]), variants: undefined })).toBe('jpg copies at no widths, not 160, 480, 960, 1440');
  });

  it('turn some of the photos and credit others, by number', () => {
    const specs = Array.from({ length: PHOTO_COUNT }, (_, n) => photoSpec(n + 1));
    expect(specs.filter((x) => x.turned).length).toBe(5);
    expect(specs.filter((x) => x.credited).length).toBe(4);
    expect(new Set(specs.map((x) => x.name)).size).toBe(PHOTO_COUNT);
  });
});

describe('create metrics', () => {
  /** One creation's records from `at`, for the scenario `name`, with its preview served by `worker`. */
  const one = (name: string, at: number, worker: number, scale = 1) => [
    r('scenario.start', at, { attrs: { scenario: name } }),
    m('scenario.start', at, { attrs: { scenario: name } }),
    r('newProject.requested', at + 10, { attrs: { from: 'welcome' } }),
    r('newProject.formShown', at + 60),
    span('main.stall', at + 200, 120 * scale),
    span('controller.websiteTools', at + 300, 250 * scale, { attrs: { tools: 'local' }, dc: { 'tools.idealTrees': 1 } }),
    r('newProject.toolsKnown', at + 310, { attrs: { tools: 'local' } }),
    r('create.requested', at + 1000, { attrs: { starter: 'business', sampleImages: true } }),
    span('create.files', at + 1050, 40),
    span('create.images', at + 2000, 900 * scale, { attrs: { images: 9 }, dc: { 'fs.writes': 96 } }),
    span('session.create.writeDocs', at + 2050, 30),
    span('session.generate', at + 2100, 50, { attrs: { variant: 'clean' } }),
    span('session.generate', at + 2160, 50, { attrs: { variant: 'dev' } }),
    span('session.publish.icons', at + 2300, 70),
    span('session.publish.write', at + 2390, 80, { attrs: { files: 61 } }),
    span('session.publish', at + 2400, 200, { dc: { 'fs.writes': 112 } }),
    span('session.create.localState', at + 2420, 10),
    span('session.create', at + 2430, 420),
    span('create.lock', at + 2440, 5),
    span('create.trust', at + 2460, 15),
    span('tools.seedCache', at + 2471, 1),
    span('tools.check', at + 2600, 120, { dc: { 'tools.idealTrees': 1 } }),
    span('tools.npm', at + 6600, 4000 * scale, { attrs: { command: 'ci', offline: true } }),
    span('tools.marker', at + 6610, 5),
    span('create.dependencies', at + 6620, 4150),
    span('create.makeWay', at + 6630, 5),
    span('controller.attach', at + 6700, 60),
    m('runtime.forked', at + 6710, { attrs: { worker } }),
    m('runtime.started', at + 6720, { attrs: { worker } }),
    m('runtime.viteLoaded', at + 6900, { attrs: { worker } }),
    m('runtime.serverCreated', at + 7000, { attrs: { worker } }),
    m('runtime.ready', at + 7100, { attrs: { worker } }),
    span('controller.startRuntime', at + 7110, 400),
    span('controller.create', at + 7120, 6115, { dc: { 'fs.writes': 120, 'fs.durableWrites': 60, 'fs.fsyncs': 120, 'files.read': 10, 'files.hashed': 20, 'tools.npmRuns': 1, 'tools.idealTrees': 1 } }),
    m('runtime.firstRequest', at + 7300, { attrs: { worker } }),
    span('main.stall', at + 7500, 80),
    m('runtime.firstResponse', at + 7600, { attrs: { worker } }),
    r('renderer.commit', at + 6800, { attrs: { screen: 'editor', revision: 0, opening: false } }),
    r('canvas.ready', at + 8000, { attrs: { mode: 'edit', studio: false, path: '/', revision: 0 } }),
    m('scenario.end', at + 10_000, { attrs: { scenario: name } })
  ];
  const trace = (drop: (x: PerfRecord) => boolean = () => false) => new Trace([...one('create', 10_000, 1), ...one('createAgain', 40_000, 2, 0.5)].filter((x) => !drop(x)));
  const show = (got: ReturnType<Scenario['measure']>) => Object.fromEntries(Object.entries(got.metrics).map(([k, v]) => [k, `${v.value} ${v.unit}`]));

  it('time the dialog to Create being available, and the creation from Create to the home page ready to edit', () => {
    const got = create.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(show(got)).toMatchObject({
      'create.dialogShown': '50 ms',
      'create.dialogReady': '300 ms',
      'create.websiteTools': '250 ms',
      'create.dialogIdealTrees': '1 count',
      'create.dialogStallMax': '120 ms',
      'create.controller': '6115 ms',
      'create.files': '40 ms',
      'create.images': '900 ms',
      'create.session': '420 ms',
      'create.session.writeDocs': '30 ms',
      'create.publish': '200 ms',
      'create.publish.icons': '70 ms',
      'create.publish.write': '80 ms',
      'create.imageFileWrites': '96 count',
      'create.publishFileWrites': '112 count',
      'create.generate': '100 ms',
      'create.session.localState': '10 ms',
      'create.dependencies': '4150 ms',
      'create.tools.check': '120 ms',
      'create.tools.npm': '4000 ms',
      'create.tools.marker': '5 ms',
      'create.attach': '60 ms',
      'create.startRuntime': '400 ms',
      'create.editorShown': '5800 ms',
      'create.runtimeForked': '5710 ms',
      'create.runtimeReady': '6100 ms',
      'create.canvasReady': '7000 ms',
      'create.fromDialog': '7990 ms',
      'create.imagesImported': '9 count',
      'create.fileWrites': '120 count',
      'create.durableWrites': '60 count',
      'create.fsyncs': '120 count',
      'create.npmRuns': '1 count',
      'create.idealTrees': '1 count',
      'create.toolChecks': '1 count',
      // The stall in the dialog's check is not the creation's.
      'create.mainStallMax': '80 ms'
    });
  });

  it('take the second creation’s records for createAgain, never the first’s', () => {
    const got = createAgain.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics['createAgain.images'].value).toBe(450);
    expect(got.metrics['createAgain.tools.npm'].value).toBe(2000);
    expect(got.metrics['createAgain.dialogStallMax'].value).toBe(60);
    expect(got.metrics['createAgain.runtimeReady'].value).toBe(6100);
  });

  it('name what is missing instead of reporting a creation without it', () => {
    for (const name of ['newProject.toolsKnown', 'controller.websiteTools', 'create.images', 'session.create', 'session.publish.write', 'create.dependencies', 'tools.npm', 'tools.check', 'controller.startRuntime', 'canvas.ready'])
      expect(create.measure(trace((x) => x.name === name && x.t < 40_000), facts).missing).toEqual(expect.arrayContaining([name]));
    // Without its own creation's span, the scenario never takes the next one's.
    const without = create.measure(trace((x) => x.name === 'controller.create' && x.t < 40_000), facts);
    expect(without.missing).toEqual(expect.arrayContaining(['controller.create', 'create.images', 'create.dependencies']));
    expect(without.metrics['create.images']).toBeUndefined();
    // Both of the first publication's generations, or no generation time at all.
    const oneVariant = create.measure(trace((x) => x.name === 'session.generate' && x.attrs?.variant === 'dev' && x.t < 40_000), facts);
    expect(oneVariant.missing).toEqual(['session.generate (dev)']);
    expect(oneVariant.metrics['create.generate']).toBeUndefined();
  });

  it('list the locked packages npm ci installs here: those needed, through what each needs, never another computer’s', () => {
    const packages = {
      '': { dependencies: { a: '1' }, devDependencies: { b: '1' }, optionalDependencies: { 'native-linux': '1', 'native-mac': '1' } },
      'node_modules/a': { dependencies: { c: '1' }, peerDependencies: { d: '1', e: '1' }, peerDependenciesMeta: { e: { optional: true } } },
      'node_modules/b': { dependencies: { c: '2' } },
      // Each a's and b's own c, found as Node finds it: nested first, then hoisted.
      'node_modules/c': {},
      'node_modules/b/node_modules/c': {},
      'node_modules/d': {},
      'node_modules/e': {},
      'node_modules/native-linux': { os: ['linux'], dependencies: { helper: '1' } },
      'node_modules/native-mac': { os: ['darwin'], cpu: ['arm64'] },
      // Needed only by the other computer's native package.
      'node_modules/helper': {},
      // Nothing needs it.
      'node_modules/stray': {}
    };
    expect(installedPackages(packages, 'darwin', 'arm64')).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/b/node_modules/c', 'node_modules/c', 'node_modules/d', 'node_modules/native-mac']);
    expect(installedPackages(packages, 'linux', 'x64')).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/b/node_modules/c', 'node_modules/c', 'node_modules/d', 'node_modules/helper', 'node_modules/native-linux']);
  });

  it('count a locked package as installed here only when npm installs it on this computer', () => {
    expect(installsHere({}, 'darwin', 'arm64')).toBe(true);
    expect(installsHere({ os: ['darwin'], cpu: ['arm64'] }, 'darwin', 'arm64')).toBe(true);
    expect(installsHere({ os: ['linux'], cpu: ['arm64'] }, 'darwin', 'arm64')).toBe(false);
    expect(installsHere({ os: ['darwin'], cpu: ['x64'] }, 'darwin', 'arm64')).toBe(false);
    expect(installsHere({ os: ['!win32'] }, 'darwin', 'arm64')).toBe(true);
    expect(installsHere({ os: ['!win32'] }, 'win32', 'x64')).toBe(false);
    expect(installsHere({ link: true }, 'darwin', 'arm64')).toBe(false);
    // npm alone tells a Linux computer's C library: a package bound to one is not checked.
    expect(installsHere({ os: ['linux'], libc: ['musl'] }, 'linux', 'x64')).toBe(false);
    expect(installsHere({ os: ['linux'] }, 'linux', 'x64')).toBe(true);
  });
});

describe('fixture facts', () => {
  it('find the first placement with a heading, or the one with an ID', () => {
    const page = { nodes: [{ id: 'a', props: { title: 'x' } }, { id: 'b', props: { heading: 'First' }, children: [{ id: 'c', props: { heading: 'Inner' } }] }, { id: 'd', props: { heading: 'Later' } }] };
    expect(findHeading(page)).toEqual({ id: 'b', heading: 'First' });
    expect(findHeading(page, 'd')).toEqual({ id: 'd', heading: 'Later' });
    expect(findHeading(page, 'zz')).toBeNull();
  });
});

describe('memory', () => {
  const MiB = 2 ** 20;
  const reading = (label: string, mainMiB: number, kind: 'rest' | 'peak' = 'rest', extra: Record<string, number> = {}): MemoryReading => {
    const roles = Object.fromEntries(Object.entries({ main: mainMiB, ...extra }).map(([k, v]) => [k, { processes: 1, bytes: v * MiB }]));
    const total = Object.values(roles).reduce((n, r) => n + r.bytes, 0);
    return { label, kind, at: 0, processes: [], roles, total, count: Object.keys(roles).length, ...(kind === 'rest' ? { heap: { main: 10 * MiB, editor: 20 * MiB } } : {}), how: {} as MemoryReading['how'] };
  };

  it('runs on its own after the launch it needs, and never beside a timing scenario', () => {
    expect(chainFor(['memory']).map((s) => s.name)).toEqual(['launch', 'memory']);
    expect(() => chainFor(['memory', 'edit'])).toThrow('Memory scenarios (memory) are run on their own: their waits and garbage collections would change the numbers of edit.');
    expect(() => chainFor(['launch', 'memory'])).toThrow('are run on their own');
    expect(() => chainFor(['memory', 'nope'])).toThrow('Unknown scenario "nope"');
    // A timing chain never makes a memory probe.
    expect(chainFor(['launch', 'open', 'edit', 'panels']).some((s) => s.memory)).toBe(false);
  });

  it('report every reading and both growths, and a reading not taken as missing', () => {
    const all = [reading('welcome', 150, 'rest', { editor: 100 }), reading('open', 300, 'peak', { editor: 200, devServer: 400 }), reading('canvas', 200, 'rest', { editor: 140, devServer: 300 }), reading('edit1', 210, 'rest', { editor: 150, devServer: 300 }), reading(`edit${MEMORY_EDITS}`, 260, 'rest', { editor: 160, devServer: 310 }), reading('closed', 170, 'rest', { editor: 101, preview: 90 })];
    const got = memory.measure(new Trace([]), facts, all);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.welcome.total'), v('memory.open.peak.total'), v('memory.open.peak.mem.devServer'), v('memory.canvas.processes'), v('memory.canvas.heap.editor')]).toEqual([250, 900, 400, 3, 20]);
    expect([v('memory.edits.growth.mem.main'), v('memory.edits.growth.mem.devServer'), v('memory.edits.growth.total'), v('memory.edits.growth.heap.main')]).toEqual([50, 10, 70, 0]);
    expect([v('memory.close.growth.mem.main'), v('memory.close.growth.mem.preview'), v('memory.close.growth.processes'), v('memory.close.growth.total')]).toEqual([20, 90, 1, 111]);
    const lacking = memory.measure(new Trace([]), facts, all.slice(0, -1));
    expect(lacking.missing).toEqual(['memory reading closed']);
    expect(Object.keys(lacking.metrics).some((k) => k.startsWith('memory.close'))).toBe(false);
    // A reading at rest named like the peak is not the peak.
    expect(memory.measure(new Trace([]), facts, all.map((r) => (r.label === 'open' ? { ...r, kind: 'rest' as const } : r))).missing).toEqual(['memory reading open']);
  });

  it('memoryPanels: report both readings, their growth and the snapshots the editor still held at each', () => {
    const held = (label: string, snapshots: number, states: number, proc: 'renderer' | 'main' = 'renderer') => m('editor.held', 0, { proc, pid: proc === 'renderer' ? 2 : 1, attrs: { scenario: 'memoryPanels', label, snapshots, states } });
    const readings = [reading('edit0', 200, 'rest', { editor: 300 }), reading(`edit${PANEL_EDITS}`, 210, 'rest', { editor: 360 })];
    readings[1] = { ...readings[1], heap: { main: 10 * MiB, editor: 45 * MiB } };
    // The main process's copy of the mark carries no counts; a decoy from another scenario neither.
    // The last count for a reading stands (one made again because a snapshot arrived meanwhile).
    const trace = new Trace([held('edit0', 99, 99, 'main'), held('edit0', 2, 2), { ...held(`edit${PANEL_EDITS}`, 50, 50), attrs: { scenario: 'other', label: `edit${PANEL_EDITS}`, snapshots: 50, states: 50 } }, held(`edit${PANEL_EDITS}`, 12, 10), held(`edit${PANEL_EDITS}`, 11, 9)]);
    const got = memoryPanels.measure(trace, facts, readings);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.edit0.heap.editor'), v(`memory.edit${PANEL_EDITS}.heap.editor`), v('memory.panelEdits.growth.heap.editor'), v('memory.panelEdits.growth.mem.editor'), v('memory.panelEdits.growth.total')]).toEqual([20, 45, 25, 60, 70]);
    expect([v('held.edit0.snapshots'), v('held.edit0.states'), v(`held.edit${PANEL_EDITS}.snapshots`), v(`held.edit${PANEL_EDITS}.states`)]).toEqual([2, 2, 11, 9]);
    // A reading not taken, or an editor that never said what it held (or was never asked to follow), is missing, never a zero.
    const untracked = m('editor.held', 0, { proc: 'renderer', pid: 2, attrs: { scenario: 'memoryPanels', label: 'edit0', untracked: true } });
    const lacking = memoryPanels.measure(new Trace([untracked]), facts, readings.slice(0, 1));
    expect(lacking.missing).toEqual(['editor.held edit0', `memory reading edit${PANEL_EDITS}`, `editor.held edit${PANEL_EDITS}`]);
    expect(Object.keys(lacking.metrics).some((k) => k.startsWith('memory.panelEdits'))).toBe(false);
  });

  it('memoryPanels: 30 edits, the sidebar views that leave the canvas uncovered and every dock view besides the Inspector shown in turn between them', () => {
    expect([PANEL_EDITS, PANEL_SIDE_VIEWS.length, PANEL_DOCK_VIEWS.length]).toEqual([30, 6, 3]);
    expect(PANEL_SIDE_TURNS).toEqual(['pages', 'layers', 'insert', 'assets']);
    expect(PANEL_DOCK_VIEWS).not.toContain('inspect');
    expect([memoryPanels.memory, memoryPanels.after]).toEqual([true, 'launch']);
    expect(chainFor(['memoryPanels']).map((s) => s.name)).toEqual(['launch', 'memoryPanels']);
    expect(() => chainFor(['memoryPanels', 'panels'])).toThrow('are run on their own');
    // Each opens the fixture as the warm-up left it: two in one launch would find it changed by the first.
    expect(() => chainFor(['memory', 'memoryPanels'])).toThrow('Memory scenarios (memory, memoryPanels) are run one at a time');
  });

  it('reopen: report Welcome, the canvas and Welcome after the first and last close, and what each stretch left', () => {
    expect(REOPEN_CYCLES).toBe(5);
    expect([reopen.memory, reopen.after, reopen.deadlineMs]).toEqual([true, 'launch', 15 * 60_000]);
    expect(chainFor(['reopen']).map((s) => s.name)).toEqual(['launch', 'reopen']);
    expect(() => chainFor(['reopen', 'open'])).toThrow('Memory scenarios (reopen) are run on their own');
    const all = [reading('welcome', 150, 'rest', { editor: 100 }), reading('canvas', 260, 'rest', { editor: 140, devServer: 300 }), reading('closed1', 190, 'rest', { editor: 104 }), reading('closed5', 200, 'rest', { editor: 101, preview: 30 })];
    const heaps = { welcome: 10, canvas: 70, closed1: 40, closed5: 41 } as Record<string, number>;
    const got = reopen.measure(new Trace([]), facts, all.map((r) => ({ ...r, heap: { main: heaps[r.label] * MiB, editor: 20 * MiB } })));
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.welcome.heap.main'), v('memory.canvas.heap.main'), v('memory.closed1.heap.main'), v('memory.closed5.heap.main'), v('memory.canvas.mem.devServer')]).toEqual([10, 70, 40, 41, 300]);
    expect([v('memory.close.growth.heap.main'), v('memory.close.growth.mem.main'), v('memory.close.growth.total')]).toEqual([30, 40, 44]);
    expect([v('memory.cycles.growth.heap.main'), v('memory.cycles.growth.mem.preview'), v('memory.cycles.growth.processes'), v('memory.cycles.growth.total')]).toEqual([1, 30, 1, 37]);
    expect([v('memory.reopen.growth.heap.main'), v('memory.reopen.growth.mem.main'), v('memory.reopen.growth.total')]).toEqual([31, 50, 81]);
    // The last close's reading not taken: it, and every growth that needs it, is missing, never zero.
    const lacking = reopen.measure(new Trace([]), facts, all.slice(0, -1));
    expect(lacking.missing).toEqual(['memory reading closed5']);
    expect(Object.keys(lacking.metrics).some((k) => k.startsWith('memory.cycles') || k.startsWith('memory.reopen'))).toBe(false);
    // A peak is not a reading at rest.
    expect(reopen.measure(new Trace([]), facts, all.map((r) => (r.label === 'closed1' ? { ...r, kind: 'peak' as const } : r))).missing).toEqual(['memory reading closed1']);
  });

  it('memoryBrowse: report the canvas, the pages and the previews, what each stretch left behind, and a reading not taken as missing', () => {
    expect([memoryBrowse.memory, memoryBrowse.after, BROWSE_PAGES, BROWSE_PREVIEWS]).toEqual([true, 'launch', 20, 6]);
    expect(chainFor(['memoryBrowse']).map((s) => s.name)).toEqual(['launch', 'memoryBrowse']);
    const all = [reading('canvas', 200, 'rest', { editor: 140, devServer: 300 }), reading('pages20', 205, 'rest', { editor: 150, devServer: 420 }), reading('previews', 210, 'rest', { editor: 145, devServer: 470, thumbnails: 60 })];
    const got = memoryBrowse.measure(new Trace([]), facts, all);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.canvas.mem.devServer'), v('memory.pages20.mem.devServer'), v('memory.previews.mem.devServer'), v('memory.previews.processes')]).toEqual([300, 420, 470, 4]);
    expect([v('memory.visits.growth.mem.devServer'), v('memory.peeks.growth.mem.devServer'), v('memory.browse.growth.mem.devServer'), v('memory.browse.growth.mem.thumbnails'), v('memory.browse.growth.total')]).toEqual([120, 50, 170, 60, 245]);
    const lacking = memoryBrowse.measure(new Trace([]), facts, all.slice(0, 2));
    expect(lacking.missing).toEqual(['memory reading previews']);
    expect(Object.keys(lacking.metrics).some((k) => k.startsWith('memory.peeks') || k.startsWith('memory.browse'))).toBe(false);
  });

  it('memoryBrowse: visit the fixture’s own pages in their number’s order, each with the card it places', () => {
    const page = (id: string, route: string, title = id) => ({ id, route, title });
    const state = {
      site: { pageOrder: ['pg_home', 'pg_fx010', 'pg_fx002', 'pg_about', 'pg_fx001', 'pg_fx031'] },
      pages: { pg_home: page('pg_home', '/'), pg_about: page('pg_about', '/about/'), pg_fx001: page('pg_fx001', '/fixture-001/'), pg_fx002: page('pg_fx002', '/fixture-002/'), pg_fx010: page('pg_fx010', '/fixture-010/'), pg_fx031: page('pg_fx031', '/fixture-031/') },
      components: { a: { owner: 'project', name: 'Fixture card 01' }, b: { owner: 'project', name: 'Fixture card 02' }, c: { owner: 'project', name: 'Fixture card 10' }, d: { owner: 'theme', name: 'Fixture card 31' } }
    } as unknown as ProjectState;
    expect(fixturePages(state).map((p) => [p.id, p.route, p.card])).toEqual([
      ['pg_fx001', '/fixture-001/', 'Card 01'],
      ['pg_fx002', '/fixture-002/', 'Card 02'],
      ['pg_fx010', '/fixture-010/', 'Card 10'],
      ['pg_fx031', '/fixture-031/', null]
    ]);
  });

  it('report the AI request’s peak, the rest before and after it and after ten, and both growths', () => {
    const all = [reading('aiIdle', 200, 'rest', { editor: 150 }), reading('aiRun', 320, 'peak', { editor: 180, buildCheck: 90 }), reading('aiDone', 215, 'rest', { editor: 152 }), reading(`aiDone${AI_MEMORY_RUNS}`, 230, 'rest', { editor: 160 })];
    const got = aiMemory.measure(new Trace([]), facts, all);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.aiIdle.mem.main'), v('memory.aiIdle.heap.main'), v('memory.aiRun.peak.mem.main'), v('memory.aiRun.peak.mem.buildCheck'), v('memory.aiRun.peak.total'), v('memory.aiDone.heap.main')]).toEqual([200, 10, 320, 90, 590, 10]);
    expect([v('memory.aiRun.growth.mem.main'), v('memory.aiRun.growth.total'), v('memory.aiRuns.growth.mem.main'), v('memory.aiRuns.growth.mem.editor'), v('memory.aiRuns.growth.heap.main')]).toEqual([15, 17, 15, 8, 0]);
    // The peak has no heap: it is read from the process table alone.
    expect(Object.keys(got.metrics).some((k) => k.startsWith('memory.aiRun.peak.heap'))).toBe(false);
    expect(aiMemory.measure(new Trace([]), facts, all.slice(0, -1)).missing).toEqual([`memory reading aiDone${AI_MEMORY_RUNS}`]);
    expect(aiMemory.measure(new Trace([]), facts, all.map((r) => (r.label === 'aiRun' ? { ...r, kind: 'rest' as const } : r))).missing).toEqual(['memory reading aiRun']);
  });

  it('make ten AI requests on their own, after the launch, each answered in its own words', () => {
    expect(AI_MEMORY_RUNS).toBe(10);
    expect([aiMemory.memory, aiMemory.after, aiMemory.deadlineMs]).toEqual([true, 'launch', 15 * 60_000]);
    expect(chainFor(['aiMemory']).map((s) => s.name)).toEqual(['launch', 'aiMemory']);
    expect(() => chainFor(['aiMemory', 'batch'])).toThrow('Memory scenarios (aiMemory) are run on their own');
    // Each request's answer is its own, so the log is known to hold the one just made, never the one before.
    expect(new Set(Array.from({ length: AI_MEMORY_RUNS }, (_, i) => aiMemoryReply(i + 1))).size).toBe(AI_MEMORY_RUNS);
    expect(aiMemoryReply(2).startsWith(BATCH_REPLY)).toBe(true);
    // The answer before a request's never reads as that request's.
    for (let n = 2; n <= AI_MEMORY_RUNS; n++) expect(aiMemoryReply(n - 1).includes(aiMemoryReply(n))).toBe(false);
  });

  it('make 50 edits and give itself longer than a timing scenario, as a memory scenario', () => {
    expect(MEMORY_EDITS).toBe(50);
    expect([memory.memory, memory.after, memory.deadlineMs]).toEqual([true, 'launch', 15 * 60_000]);
    expect([launch, open, edit, panels, chat].some((s) => s.memory)).toBe(false);
  });

  const scenario = (name: string, run: () => Promise<void>, seen: string[][]): Scenario => ({
    name,
    after: null,
    description: name,
    run,
    measure: (_t, _f, readings = []) => {
      seen.push(readings.map((r) => r.label));
      const c = new Collector();
      c.count(`${name}.n`, readings.length);
      return c;
    }
  });

  it('give each scenario the readings its run took, and keep them on its outcome, a failed one’s too', async () => {
    const probe = { readings: [] as MemoryReading[] } as unknown as MemoryProbe;
    const take = (label: string) => probe.readings.push(reading(label, 1));
    const seen: string[][] = [];
    const ctx = { fixture: facts, memory: probe } as unknown as ScenarioContext;
    const out = await runChain(
      [
        scenario('a', async () => {}, seen),
        scenario('b', async () => void (take('x'), take('y')), seen),
        scenario('b2', async () => void take('w'), seen),
        scenario('c', async () => (take('z'), check(false, 'the project did not close')), seen)
      ],
      ctx,
      async () => new Trace([]),
      1000
    );
    // Each scenario's own readings, never the ones before it.
    expect(seen).toEqual([[], ['x', 'y'], ['w']]);
    expect(out.map((o) => [o.scenario, o.ok, o.memory?.map((r) => r.label)])).toEqual([
      ['a', true, undefined],
      ['b', true, ['x', 'y']],
      ['b2', true, ['w']],
      ['c', false, ['z']]
    ]);
    // A scenario failed on its trace or its measure keeps the readings it took too.
    const missing: Scenario = {
      ...scenario('m', async () => void take('v'), []),
      measure: () => {
        const c = new Collector();
        c.need('x', undefined);
        return c;
      }
    };
    const [broken] = await runChain([scenario('t', async () => void take('u'), [])], ctx, async () => new Trace([], true), 1000);
    const [lacking] = await runChain([missing], ctx, async () => new Trace([]), 1000);
    expect([broken.ok, broken.memory?.map((r) => r.label), lacking.ok, lacking.memory?.map((r) => r.label)]).toEqual([false, ['u'], false, ['v']]);
  });

  it('give a scenario its own deadline when it names one', async () => {
    const ctx = { fixture: facts } as unknown as ScenarioContext;
    const slow = { ...scenario('m', () => new Promise((r) => setTimeout(r, 200)), []), deadlineMs: 10 };
    expect((await runChain([slow], ctx, async () => new Trace([]), 60_000))[0].error?.message).toBe('m did not finish within 0s');
    const patient = { ...scenario('m', () => new Promise((r) => setTimeout(r, 30)), []), deadlineMs: 60_000 };
    expect((await runChain([patient], ctx, async () => new Trace([]), 10))[0].ok).toBe(true);
  });
});

describe('noWindow', () => {
  const MiB = 2 ** 20;
  const reading = (label: string, roles: Record<string, number>, editorHeap = true): MemoryReading => {
    const r = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, { processes: 1, bytes: v * MiB }]));
    return { label, kind: 'rest', at: 0, processes: [], roles: r, total: Object.values(r).reduce((n, x) => n + x.bytes, 0), count: Object.keys(r).length, heap: editorHeap ? { main: 10 * MiB, editor: 20 * MiB } : { main: 12 * MiB }, how: {} as MemoryReading['how'] };
  };
  const all = [reading('welcome', { main: 60, editor: 40, gpu: 50 }), reading('canvas', { main: 70, editor: 100, gpu: 130, preview: 70, devServer: 240 }), reading('noWindow', { main: 70, gpu: 35, devServer: 130 }, false), reading('reopened', { main: 75, editor: 90, gpu: 110, preview: 75, devServer: 140 })];
  const at = { scenario: 'noWindow' };
  const ready = (t: number, revision: number, extra: Record<string, unknown> = {}) => r('canvas.ready', t, { pid: 3, attrs: { mode: 'edit', studio: false, path: '/', revision, ...extra } });

  it('run on its own after launch, as a memory scenario, never in a chain with another', () => {
    expect(chainFor(['noWindow']).map((s) => s.name)).toEqual(['launch', 'noWindow']);
    expect(() => chainFor(['noWindow', 'open'])).toThrow('are run on their own');
    expect(() => chainFor(['memory', 'noWindow'])).toThrow('Memory scenarios (memory, noWindow) are run one at a time');
    expect(chainFor(['noWindow', 'noWindow']).map((s) => s.name)).toEqual(['launch', 'noWindow']);
    expect([noWindow.memory, noWindow.after]).toEqual([true, 'launch']);
  });

  it('report each reading, what closing the window let go of, and the time back to the canvas in the new window', () => {
    const trace = new Trace([
      // The first window's canvas, before the window closed: never the one brought up again.
      ready(900, 4, { path: '/about/' }),
      m('noWindow.reopen', 1000, { attrs: { ...at, revision: 4, route: '/about/' } }),
      m('launch.windowCreated', 1012),
      r('renderer.commit', 1120, { pid: 3, attrs: { screen: 'editor' } }),
      m('runtime.forked', 1130),
      m('runtime.ready', 1600),
      // Another page, and the page at another revision, are not the canvas the window came back to.
      ready(1700, 4),
      ready(1750, 3, { path: '/about/' }),
      ready(1800, 4, { path: '/about/' }),
      m('noWindow.shown', 2500, { attrs: at }),
      m('noWindow.outsideTaken', 9000, { attrs: { ...at, saves: 1, withoutWindow: true } })
    ]);
    const got = noWindow.measure(trace, facts, all);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.welcome.total'), v('memory.canvas.total'), v('memory.noWindow.total'), v('memory.noWindow.processes'), v('memory.reopened.mem.devServer')]).toEqual([150, 610, 235, 3, 140]);
    // With no window there is no editor, and no editor heap.
    expect(got.metrics['memory.noWindow.heap.editor']).toBeUndefined();
    expect([v('memory.windowClosed.growth.total'), v('memory.windowClosed.growth.mem.editor'), v('memory.windowClosed.growth.processes'), v('memory.restWithoutWindow.growth.total')]).toEqual([-375, -100, -2, 85]);
    expect([v('memory.project.growth.total'), v('memory.windowBack.growth.mem.devServer')]).toEqual([460, -100]);
    expect([v('noWindow.reopen.windowCreated'), v('noWindow.reopen.editorShown'), v('noWindow.reopen.canvasReady'), v('noWindow.reopen.runtimeReady'), v('noWindow.reopen.previewStarts'), v('noWindow.outside.saves'), v('noWindow.outside.takenWithoutWindow')]).toEqual([12, 120, 800, 600, 1, 1, 1]);
  });

  it('report a reading not taken, or a window that never came back to the canvas, as missing', () => {
    const lacking = noWindow.measure(new Trace([m('noWindow.reopen', 1000, { attrs: { ...at, revision: 4, route: '/about/' } }), m('noWindow.shown', 2500, { attrs: at })]), facts, all.slice(0, 2));
    expect(lacking.missing).toEqual(['memory reading noWindow', 'memory reading reopened', 'canvas.ready (window brought up again)', 'launch.windowCreated (window brought up again)', 'renderer.commit (editor, window brought up again)', 'noWindow.outsideTaken']);
    expect(Object.keys(lacking.metrics).some((k) => k.startsWith('memory.windowClosed'))).toBe(false);
    // A window brought back to a preview already running starts none.
    const warm = noWindow.measure(new Trace([m('noWindow.reopen', 1000, { attrs: { ...at, revision: 4, route: '/about/' } }), m('launch.windowCreated', 1010), r('renderer.commit', 1100, { pid: 3, attrs: { screen: 'editor' } }), ready(1300, 4, { path: '/about/' }), m('noWindow.shown', 2500, { attrs: at }), m('noWindow.outsideTaken', 9000, { attrs: { ...at, saves: 2 } })]), facts, all);
    expect(warm.missing).toEqual([]);
    // Taken only once the window was back: counted as such.
    expect([warm.metrics['noWindow.reopen.previewStarts'].value, warm.metrics['noWindow.reopen.runtimeReady'], warm.metrics['noWindow.outside.saves'].value, warm.metrics['noWindow.outside.takenWithoutWindow'].value]).toEqual([0, undefined, 2, 0]);
    // A reopen mark that does not say which page the window was left on cannot be timed.
    const unnamed = noWindow.measure(new Trace([m('noWindow.reopen', 1000, { attrs: { ...at, revision: 4 } }), m('launch.windowCreated', 1010), r('renderer.commit', 1100, { pid: 3, attrs: { screen: 'editor' } }), ready(1300, 4), m('noWindow.shown', 2500, { attrs: at }), m('noWindow.outsideTaken', 9000, { attrs: { ...at, saves: 1 } })]), facts, all);
    expect(unnamed.missing).toEqual(['noWindow.reopen (with the page it was left on)', 'canvas.ready (window brought up again)']);
  });
});

describe('previewImages', () => {
  const MiB = 2 ** 20;
  const reading = (label: string, previewMiB: number, kind: 'rest' | 'peak' = 'rest', extra: Record<string, number> = {}): MemoryReading => {
    const roles = Object.fromEntries(Object.entries({ main: 200, preview: previewMiB, ...extra }).map(([k, v]) => [k, { processes: 1, bytes: v * MiB }]));
    const total = Object.values(roles).reduce((n, x) => n + x.bytes, 0);
    return { label, kind, at: 0, processes: [], roles, total, count: Object.keys(roles).length, ...(kind === 'rest' ? { heap: { main: 10 * MiB, editor: 20 * MiB } } : {}), how: {} as MemoryReading['how'] };
  };
  const readings = [reading('gallery', 300), reading('chat', 320, 'peak', { gpu: 580 }), reading('chatted', 302), reading('layout', 700, 'peak', { gpu: 670 }), reading('laidOut', 305), reading('component', 650, 'peak', { gpu: 650 }), reading('inspected', 320), reading('insertShown', 330, 'rest', { thumbnails: 80 }), reading('hover', 340, 'peak', { thumbnails: 80, gpu: 610 }), reading('hovered', 331, 'rest', { thumbnails: 80 }), reading('insert', 900, 'peak', { thumbnails: 120, gpu: 720 }), reading('peeked', 310, 'rest', { thumbnails: 90 })];
  const at = (window: string, edge: string, t: number, canvasY?: number) => r('previewImages.window', t, { attrs: { scenario: 'previewImages', window, edge, ...(canvasY !== undefined ? { canvasY } : {}), ...(window === 'insert' && edge === 'end' ? { retried: 1 } : {}) } });
  const trace = () =>
    new Trace([
      at('layout', 'start', 100),
      r('inspect.done', 150, { attrs: { req: 'q1', attempt: 1, images: 40, fonts: 1, frame: 30, pictures: 20, pixels: 20 * 2560 * 1920 } }),
      at('layout', 'end', 200, 0),
      r('previewImages.checked', 210, { attrs: { scenario: 'previewImages', window: 'layout', digest: 123456, height: 23855 } }),
      at('component', 'start', 300),
      r('componentPreview.measured', 320, { attrs: { width: 390, pictures: 1, pixels: 960 * 720 } }),
      r('componentPreview.measured', 340, { attrs: { width: 1280, pictures: 1, pixels: 2560 * 1920 } }),
      at('component', 'end', 400, 0),
      r('previewImages.checked', 410, { attrs: { scenario: 'previewImages', window: 'component', digest: 654321, height: -1 } }),
      // A measurement outside every window is no window's.
      r('inspect.done', 450, { attrs: { req: 'q2', attempt: 1, pictures: 20, pixels: 1 } }),
      at('insert', 'start', 500),
      // A live preview measured twice counts once, as its last measurement found it.
      r('livePreview.measured', 501, { attrs: { session: 's1', pictures: 0, pixels: 0 } }),
      ...Array.from({ length: 20 }, (_, n) => r('livePreview.measured', 510 + n, { attrs: { session: `s${n + 1}`, pictures: 1, pixels: 960 * 720 } })),
      at('insert', 'end', 600, 1500)
    ]);

  it('runs on its own after open, as a memory scenario with a memory scenario’s deadline', () => {
    expect(chainFor(['previewImages']).map((s) => s.name)).toEqual(['launch', 'open', 'previewImages']);
    expect(() => chainFor(['previewImages', 'edit'])).toThrow('are run on their own');
    expect([previewImages.memory, previewImages.after, previewImages.deadlineMs]).toEqual([true, 'open', 15 * 60_000]);
    expect(PREVIEW_IMAGE_READINGS.map(([l, k]) => `${l}:${k}`)).toEqual(['gallery:rest', 'chat:peak', 'chatted:rest', 'layout:peak', 'laidOut:rest', 'component:peak', 'inspected:rest', 'insertShown:rest', 'hover:peak', 'hovered:rest', 'insert:peak', 'peeked:rest']);
  });

  it('report every reading, the growth over the checks and over the previews, each window over its control, each window’s pictures and each check’s report', () => {
    const got = previewImages.measure(trace(), facts, readings);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.gallery.mem.preview'), v('memory.layout.peak.mem.preview'), v('memory.component.peak.mem.preview'), v('memory.insert.peak.mem.preview'), v('memory.peeked.mem.preview')]).toEqual([300, 700, 650, 900, 310]);
    // Over the walk: from the rest just before it (after the hover control), to the rest once its previews are gone.
    expect([v('memory.inspect.growth.mem.preview'), v('memory.previews.growth.mem.preview'), v('memory.previews.growth.mem.thumbnails')]).toEqual([20, -21, 10]);
    // Each window's frames over its control's peak: the checks over the turn that only answered, the walk over the sketches.
    expect([v('memory.layoutOverChat.growth.mem.gpu'), v('memory.componentOverChat.growth.mem.gpu'), v('memory.insertOverHover.growth.mem.gpu'), v('memory.insertOverHover.growth.mem.preview')]).toEqual([90, 70, 110, 560]);
    expect(got.metrics['memory.layoutOverChat.growth.heap.main']).toBeUndefined();
    expect([v('pictures.layout.measured'), v('pictures.layout.pictures'), v('pictures.layout.bytes')]).toEqual([1, 20, 20 * 2560 * 1920 * 4]);
    expect([v('pictures.component.measured'), v('pictures.component.pictures'), v('pictures.component.bytes')]).toEqual([2, 2, (960 * 720 + 2560 * 1920) * 4]);
    expect([v('pictures.insert.measured'), v('pictures.insert.pictures'), v('pictures.insert.bytes')]).toEqual([20, 20, 20 * 960 * 720 * 4]);
    expect(got.metrics['pictures.insert.bytes'].unit).toBe('bytes');
    expect([v('checks.layout.digest'), v('checks.layout.documentHeight'), v('checks.component.digest')]).toEqual([123456, 23855, 654321]);
    // Where the canvas's page was scrolled when each window ended.
    expect([v('canvas.layout.scrollY'), v('canvas.component.scrollY'), v('canvas.insert.scrollY')]).toEqual([0, 0, 1500]);
    // The live previews shown a second time because their page never said it was ready.
    expect(v('insert.retried')).toBe(1);
    expect(got.metrics['checks.component.documentHeight']).toBeUndefined();
  });

  it('fail a window whose frames said nothing of their pictures, and a reading not taken', () => {
    const t = trace();
    const bare = new Trace(t.records.map((x) => (x.name === 'componentPreview.measured' ? { ...x, attrs: { width: 390 } } : x)));
    expect(previewImages.measure(bare, facts, readings).missing).toEqual(['the pictures of the component window\'s frames']);
    expect(windowPictures(new Trace(t.records.filter((x) => x.name !== 'livePreview.measured')), 'insert', 500, 600)).toBeNull();
    // 19 of the 20 previews, a preview's mark without its session, or a component measured at one width: not counted.
    expect(windowPictures(new Trace(t.records.filter((x) => x.attrs?.session !== 's20')), 'insert', 500, 600)).toBeNull();
    expect(windowPictures(new Trace(t.records.map((x) => (x.attrs?.session === 's3' ? { ...x, attrs: { pictures: 1, pixels: 1 } } : x))), 'insert', 500, 600)).toBeNull();
    expect(windowPictures(new Trace(t.records.filter((x) => !(x.name === 'componentPreview.measured' && x.attrs?.width === 1280))), 'component', 300, 400)).toBeNull();
    expect(windowPictures(t, 'insert', 500, 600)).toEqual({ measured: 20, pictures: 20, pixels: 20 * 960 * 720 });
    expect(previewImages.measure(t, facts, readings.slice(0, -1)).missing).toEqual(['memory reading peeked']);
    expect(previewImages.measure(new Trace(t.records.filter((x) => x.name !== 'previewImages.checked')), facts, readings).missing).toEqual(['previewImages.checked layout', 'previewImages.checked component']);
  });

  it('make each photo’s component and the page that places them as the fixture places its cards', () => {
    const ops = galleryPlacements(['pc_a', 'pc_b']);
    expect(ops.map((o) => o.type)).toEqual(['page.create', 'node.insert', 'node.insert', 'node.insert', 'node.insert']);
    expect(ops[0]).toMatchObject({ pageId: GALLERY_PAGE.pageId, route: '/gallery/', starter: 'empty' });
    expect(ops[2]).toMatchObject({ parentId: 'n_gals01', slot: 'content', definitionId: 'pc_a', newNodeId: 'n_galc01' });
    expect(ops[3]).toMatchObject({ parentId: null, componentId: 'layout.section', newNodeId: 'n_gals02' });
    expect(galleryComponent(7)).toMatchObject({ type: 'component.upsert', name: 'Gallery photo 07', newDefinitionId: 'proj.gallery-photo-07-bench' });
    expect(PROJECT_DEFINITION_ID.test(galleryDefinitionId(7))).toBe(true);
    const record = galleryRecord({ name: 'Gallery photo 03', file: 'static/assets/gallery-03-abcd.jpg', width: 2560, height: 1920, variants: [{ width: 160, file: 'static/assets/gallery-03-abcd-160w.jpg' }] }, 3, Buffer.from('jpeg'));
    expect(record).toMatchObject({ id: 'img-gallery-03', mime: 'image/jpeg', bytes: 4, width: 2560, height: 1920, kind: 'image', variants: [{ width: 160, file: 'static/assets/gallery-03-abcd-160w.jpg' }] });
    expect((galleryComponent(3).nodes as Array<{ kind: string; image?: { assetId: string } }>).find((n) => n.kind === 'image')?.image?.assetId).toBe(record.id);
  });
});

describe('drag metrics', () => {
  const start = r('scenario.start', 900, { attrs: { scenario: 'drag', periodMs: 16.7 } });
  const c = (n: number) => ({ c: { 'canvas.renders': n * 2, 'canvas.dropShows': n, 'canvas.dropMeasures': Math.floor(n / 10), 'canvas.dropMeasured': n * 3, 'canvas.dropScrolls': Math.floor(n / 4), 'react.commits': n, 'react.renders': n * 20 } });
  /** One attempt of the drag: its edges with the editor's counters, its list measures (a decoy after it), and the frame
   *  watch's findings on its end mark. */
  function attempt(at: number, n: number, o: { counts?: [number, number]; measures?: number[]; frames?: Record<string, number> } = {}): PerfRecord[] {
    const [c0, c1] = o.counts ?? [0, 100];
    const frames = o.frames ?? { frames: 150, droppedFrames: 6, longTasks: 1, longTaskMs: 70, longestFrameMs: 80 };
    return [
      r('drag.window', at, { attrs: { scenario: 'drag', edge: 'start', attempt: n }, ...c(c0) }),
      ...(o.measures ?? [12, 20, 16]).map((ms, i) => r('canvas.dropMeasure', at + 10 + i, { attrs: { ms, lists: 9 } })),
      r('drag.window', at + 3000, { attrs: { scenario: 'drag', edge: 'end', attempt: n, ...frames }, ...c(c1) }),
      r('canvas.dropMeasure', at + 3001, { attrs: { ms: 900, lists: 9 } })
    ];
  }

  it('count the drag’s renders, shows, measures and scroll steps, and time its frames and measures', () => {
    const got = drag.measure(new Trace([start, ...attempt(1000, 1)]), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('drag.framePeriodMs'), v('drag.ms'), v('drag.canvasRenders'), v('drag.dropShows'), v('drag.measures'), v('drag.listsMeasured'), v('drag.scrollSteps')]).toEqual([16.7, 3000, 200, 100, 10, 300, 25]);
    expect([v('drag.rendererCommits'), v('drag.renders'), v('drag.measureMs')]).toEqual([100, 2000, 16]);
    expect([v('drag.frames'), v('drag.droppedFrames'), v('drag.longTasks'), v('drag.longTaskMs'), v('drag.longestFrameMs'), v('drag.frameMs')]).toEqual([150, 6, 1, 70, 80, 20]);
  });

  it('measure the last attempt, and name what is missing instead of reporting a drag that did less', () => {
    const again = drag.measure(new Trace([start, ...attempt(1000, 1, { counts: [0, 999] }), ...attempt(5000, 2, { counts: [999, 1099], measures: [4] })]), facts);
    expect(again.missing).toEqual([]);
    expect([again.metrics['drag.dropShows'].value, again.metrics['drag.measureMs'].value]).toEqual([100, 4]);
    const bare = drag.measure(new Trace([...attempt(1000, 1, { measures: [], frames: { frames: 40 } })]), facts);
    expect(bare.missing).toEqual([
      'scenario.start (renderer)',
      'scenario.start (renderer, with the frame period)',
      'canvas.dropMeasure (no list measured in the drag)',
      'drag.droppedFrames (the frame watch)',
      'drag.longTasks (the frame watch)',
      'drag.longTaskMs (the frame watch)',
      'drag.longestFrameMs (the frame watch)'
    ]);
    const stalled = drag.measure(new Trace([start, ...attempt(1000, 1, { frames: { frames: 60, droppedFrames: 0, longTasks: 0, longTaskMs: 0, longestFrameMs: 16.7 } })]), facts);
    expect(stalled.missing).toEqual(['drag.frames (the frame watch saw 60 frames in 3000 ms)']);
    const cut = drag.measure(new Trace([start, ...attempt(1000, 1).filter((x) => x.attrs?.edge !== 'end')]), facts);
    expect(cut.missing).toEqual(['drag.window end']);
  });
});

describe('colour metrics', () => {
  const point = (p: string, t: number, extra: Record<string, number> = {}, n = 1) => [
    r('colour.window', t, { attrs: { scenario: 'colour', point: p, attempt: n, ...extra }, c: { 'react.commits': t / 100 } }),
    m('colour.window', t, { attrs: { scenario: 'colour', point: p, attempt: n, ...extra }, c: { 'fs.durableWrites': t / 250, 'fs.fsyncs': t / 200, 'fs.writes': t / 100 } })
  ];
  const apply = (end: number, ms: number, revision: number, dc: Record<string, number> = { 'fs.durableWrites': 3, 'fs.fsyncs': 4, 'fs.writes': 5 }) => span('controller.apply', end, ms, { attrs: { revision }, dc });
  const shown = (t: number, revision: number) => r('canvas.revisionApplied', t, { attrs: { revision } });
  const sent = (t: number, revision: number) => m('controller.snapshotSent', t, { attrs: { revision, bytes: 1000 } });

  it('count the edits the drag made, how many ran at once, and time the preview settling after the release', () => {
    // A drag from 1000 to 2000: four edits, the second and third queued behind the first, the last after the release.
    const trace = new Trace([
      apply(990, 10, 9),
      ...point('start', 1000),
      apply(1300, 200, 11),
      apply(1500, 350, 12),
      apply(1700, 500, 13),
      sent(1310, 11),
      shown(1400, 11),
      ...point('release', 2000),
      apply(2400, 300, 14),
      sent(2410, 14),
      shown(2500, 13),
      shown(2700, 14),
      ...point('settled', 3000, { revision: 14 }),
      apply(3500, 100, 15)
    ]);
    const got = colour.measure(trace, facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('colour.dragMs'), v('colour.applies'), v('colour.appliesPerSecond'), v('colour.queueDeepest')]).toEqual([1000, 4, 3, 3]);
    // From the main process's marks, not the overlapping edits' own counts.
    expect([v('colour.durableWrites'), v('colour.fsyncs'), v('colour.fileWrites')]).toEqual([8, 10, 20]);
    expect([v('colour.lastSaveMs'), v('colour.settleMs'), v('colour.previewUpdates'), v('colour.snapshotsSent'), v('colour.snapshotBytes'), v('colour.rendererCommits')]).toEqual([400, 700, 3, 2, 2000, 20]);
  });

  it('name what is missing instead of reporting a drag that did less', () => {
    expect(colour.measure(new Trace([...point('start', 1000), ...point('release', 2000)]), facts).missing).toEqual(['colour.window settled']);
    // No edit at all, and a settled revision the preview never showed.
    expect(colour.measure(new Trace([...point('start', 1000), ...point('release', 2000), ...point('settled', 3000, { revision: 14 })]), facts).missing).toEqual(['controller.apply (no edit in the colour drag)', 'canvas.revisionApplied (the settled revision)']);
    // A drag whose edits all began after the picker was let go showed nothing as it was dragged.
    const late = colour.measure(new Trace([...point('start', 1000), ...point('release', 2000), apply(2400, 300, 11), shown(2500, 11), ...point('settled', 3000, { revision: 11 })]), facts);
    expect(late.missing).toEqual(['controller.apply begun before the picker was let go (the drag was saved only once it ended)']);
    // Without the main process's own marks, its writes are missing, never summed from the overlapping edits.
    const rendererOnly = new Trace([...point('start', 1000), apply(1300, 200, 11), ...point('release', 2000), shown(2100, 11), ...point('settled', 3000, { revision: 11 })].filter((x) => x.proc === 'renderer' || x.name !== 'colour.window'));
    const got = colour.measure(rendererOnly, facts);
    expect(got.missing).toEqual(['colour.window start (main)', 'colour.window settled (main)']);
    expect(got.metrics['colour.durableWrites']).toBeUndefined();
    // A settled mark of an earlier attempt is not this attempt's.
    expect(colour.measure(new Trace([...point('start', 500, {}, 1), ...point('release', 600, {}, 1), ...point('settled', 700, { revision: 3 }, 1), ...point('start', 1000, {}, 2), ...point('release', 2000, {}, 2)]), facts).missing).toEqual(['colour.window settled']);
  });

  it('count the most edits running at once, one ending as the next starts not beside it', () => {
    expect(deepest([])).toBe(0);
    expect(deepest([apply(100, 100, 1), apply(200, 100, 2), apply(300, 100, 3)])).toBe(1);
    expect(deepest([apply(100, 100, 1), apply(150, 100, 2), apply(400, 300, 3), apply(450, 400, 4)])).toBe(3);
  });

  it('pick a different colour at every step of the drag', () => {
    const path = colourPath();
    expect(path).toHaveLength(COLOUR_STEPS);
    for (const hex of path) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(path).size).toBe(COLOUR_STEPS);
    expect(path[0]).toBe('#bd2828');
  });
});

describe('thumbs metrics', () => {
  const point = (p: string, t: number, c: Record<string, number> = {}, extra: Record<string, number> = {}) => [
    r('thumbs.window', t, { attrs: { scenario: 'thumbs', point: p, ...extra } }),
    m('thumbs.window', t, { attrs: { scenario: 'thumbs', point: p, ...extra }, c })
  ];
  const asked = (t: number, id: string) => m('thumbs.asked', t, { attrs: { definitionId: id } });
  const answered = (t: number, ms: number, id: string, picture: boolean) => span('thumbs.answered', t, ms, { attrs: { definitionId: id, state: 'ready', picture, bytes: picture ? 5000 : 100 } });
  /** A photograph, after the preview it is of was made and written (as a build with those marks has them). */
  const shot = (t: number, ms: number, id: string) => [span('componentPreview.generate', t - ms - 9, 2), span('thumbs.prepare', t - ms - 5, 5, { attrs: { definitionId: id } }), span('thumbs.capture', t, ms, { attrs: { definitionId: id } })];
  /** Counters as the main process's marks carry them. */
  const c = (requests: number, bytes: number, captures: number, keys: number, keyMs: number, brands = keys) => ({ 'thumbs.requests': requests, 'thumbs.bytes': bytes, 'thumbs.captures': captures, 'thumbs.keys': keys, 'thumbs.keyMs': keyMs, 'thumbs.brands': brands });

  it('count each window’s requests, bytes and captures, and time the panel filling and going quiet', () => {
    const trace = new Trace([
      // fill: two tiles asked for (one twice), both photographed, one in view shown at 1600; the main process stalled once.
      ...point('fill', 1000, c(0, 0, 0, 0, 0)),
      asked(1010, 'a'),
      asked(1011, 'b'),
      asked(1012, 'a'),
      span('main.stall', 1500, 70),
      ...shot(1400, 300, 'a'),
      answered(1410, 400, 'a', true),
      ...point('filled', 1600, {}, { inView: 1 }),
      ...shot(1800, 350, 'b'),
      answered(1810, 800, 'b', true),
      ...point('fillQuiet', 5400, c(3, 10000, 2, 6, 3, 1)),
      // The check after the window is not the window's.
      asked(5500, 'a'),
      answered(5501, 1, 'a', true),
      // edit: both asked for again, answered without a picture.
      ...point('edit', 6000, c(4, 15000, 2, 7, 3.5, 1)),
      asked(6600, 'a'),
      asked(6601, 'b'),
      answered(6602, 2, 'a', false),
      answered(6603, 2, 'b', false),
      ...point('edited', 10200, c(6, 15200, 2, 9, 4.5, 2)),
      // colour: one asked for and photographed again.
      ...point('colour', 11000, c(6, 15200, 2, 9, 4.5, 2)),
      asked(11600, 'a'),
      ...shot(12000, 300, 'a'),
      answered(12010, 410, 'a', true),
      ...point('coloured', 15600, c(7, 20200, 3, 12, 6, 3)),
      // scroll: one tile newly in view, from memory.
      ...point('scroll', 16000, c(7, 20200, 3, 12, 6, 3)),
      asked(16020, 'b'),
      answered(16025, 5, 'b', true),
      ...point('scrolled', 16100, {}, { inView: 1 }),
      ...point('scrollQuiet', 19600, c(8, 25200, 3, 13, 6.5, 3))
    ]);
    const got = thumbs.measure(trace, facts);
    expect(got.missing).toEqual([]);
    const v = (w: string, metric: string) => got.metrics[`thumbs.${w}.${metric}`]?.value;
    const row = (w: string) => ['requests', 'components', 'bytes', 'pictures', 'captures', 'captureMs', 'keys', 'brands', 'keyMs', 'busyMs'].map((x) => v(w, x));
    expect([v('fill', 'ms'), v('fill', 'inView')]).toEqual([600, 1]);
    // Requests counted as made, the components they named once each; keys and brands each from their own counter.
    expect(row('fill')).toEqual([3, 2, 10000, 2, 2, 650, 6, 1, 3, 810]);
    expect(row('edit')).toEqual([2, 2, 200, 0, 0, 0, 2, 1, 1, 603]);
    expect(row('colour')).toEqual([1, 1, 5000, 1, 1, 300, 3, 1, 1.5, 1010]);
    expect([v('scroll', 'ms'), v('scroll', 'inView')]).toEqual([100, 1]);
    expect(row('scroll')).toEqual([1, 1, 5000, 1, 0, 0, 1, 0, 0.5, 25]);
    // The stall in the fill is the fill's alone.
    expect(THUMB_WINDOWS.map((w) => v(w.name, 'mainStallMax'))).toEqual([70, 0, 0, 0]);
  });

  it('time and size the preview each photograph is made from, window by window', () => {
    const prepare = (t: number, ms: number, id: string) => span('thumbs.prepare', t, ms, { attrs: { definitionId: id } });
    const generate = (t: number, ms: number) => span('componentPreview.generate', t, ms);
    const made = (files: number, bytes: number, captures: number) => ({ ...c(0, 0, captures, 0, 0), 'componentPreview.files': files, 'componentPreview.bytes': bytes });
    const trace = new Trace([
      // fill: two previews made, of 63 files each, and photographed.
      ...point('fill', 1000, made(0, 0, 0)),
      asked(1010, 'a'),
      generate(1040, 30),
      prepare(1050, 38, 'a'),
      // The editor's own records are not the main process's.
      span('thumbs.prepare', 1060, 500, { proc: 'renderer', pid: 2 }),
      span('componentPreview.generate', 1060, 500, { proc: 'renderer', pid: 2 }),
      ...shot(1200, 140, 'a').slice(2),
      generate(1240, 33),
      prepare(1250, 40, 'b'),
      ...shot(1400, 140, 'b').slice(2),
      ...point('filled', 1500, {}, { inView: 2 }),
      ...point('fillQuiet', 5000, made(126, 540000, 2)),
      // edit: none made.
      ...point('edit', 6000, made(126, 540000, 2)),
      ...point('edited', 9600, made(126, 540000, 2)),
      // colour: one made and photographed, after the window's start (one made before it is not the window's).
      generate(9900, 31),
      ...point('colour', 10000, made(189, 810000, 2)),
      generate(10040, 32),
      prepare(10050, 39, 'a'),
      ...shot(10200, 140, 'a').slice(2),
      ...point('coloured', 14000, made(252, 1080000, 3)),
      ...point('scroll', 15000, made(252, 1080000, 3)),
      ...point('scrolled', 15100, {}, { inView: 1 }),
      ...point('scrollQuiet', 18600, made(252, 1080000, 3))
    ]);
    const got = thumbs.measure(trace, facts);
    expect(got.missing).toEqual([]);
    const v = (w: string, metric: string) => got.metrics[`thumbs.${w}.${metric}`]?.value;
    const row = (w: string) => ['prepareMs', 'generateMs', 'previewFiles', 'previewBytes'].map((x) => v(w, x));
    expect(row('fill')).toEqual([78, 63, 126, 540000]);
    expect(row('edit')).toEqual([0, 0, 0, 0]);
    expect(row('colour')).toEqual([39, 32, 63, 270000]);
    expect(row('scroll')).toEqual([0, 0, 0, 0]);
    expect(got.metrics['thumbs.fill.previewBytes']?.unit).toBe('bytes');
    // A build that photographs without marking what it made them from reports nothing for it, rather than none.
    const unmarked = thumbs.measure(new Trace([...point('fill', 1000, made(0, 0, 0)), asked(1010, 'a'), ...shot(1200, 140, 'a').slice(2), ...point('filled', 1500, {}, { inView: 1 }), ...point('fillQuiet', 5000, made(0, 0, 1))]), facts);
    expect(unmarked.missing).toContain('thumbs.prepare and componentPreview.generate (none in fill, which took photographs)');
  });

  it('name a window that never ended instead of reporting one that did less', () => {
    const got = thumbs.measure(new Trace([...point('fill', 1000, c(0, 0, 0, 0, 0)), asked(1010, 'a'), ...point('filled', 1600)]), facts);
    expect(got.missing).toEqual(['thumbs.window fillQuiet (main)', 'thumbs.window edit (main)', 'thumbs.window edited (main)', 'thumbs.window colour (main)', 'thumbs.window coloured (main)', 'thumbs.window scroll (main)', 'thumbs.window scrollQuiet (main)', 'thumbs.window scroll', 'thumbs.window scrolled']);
    expect(got.metrics['thumbs.fill.requests']).toBeUndefined();
    // Insert filled from cold with no request or photograph marked: a build without the marks, never a free fill.
    const unmarked = thumbs.measure(new Trace([...point('fill', 1000, c(0, 0, 0, 0, 0)), ...point('filled', 1600, {}, { inView: 1 }), ...point('fillQuiet', 5400, c(0, 0, 0, 0, 0))]), facts);
    expect(unmarked.missing[0]).toBe('thumbs.asked and thumbs.captures (none while Insert filled from cold)');
  });
});

describe('cmdk metrics', () => {
  const frames = { frames: 60, droppedFrames: 2, longTasks: 1, longTaskMs: 70, longestFrameMs: 50 };
  /** The menu opened at 1000, then one key every 100 ms from 2000, each listed `lag` ms after it started. */
  function typed(lag: (k: number) => number, o: { keys?: number; counts?: [number, number] } = {}): PerfRecord[] {
    const [c0, c1] = o.counts ?? [10, 40];
    const keys = o.keys ?? CMDK_QUERY.length;
    const out: PerfRecord[] = [
      r('scenario.start', 900, { attrs: { scenario: 'cmdk' } }),
      r('cmdk.results', 950, { attrs: { chars: CMDK_QUERY.length, rows: 99, content: 9 } }),
      r('cmdk.requested', 1000),
      r('cmdk.shown', 1030),
      r('cmdk.painted', 1045),
      r('cmdk.typeStart', 1990, { c: { 'react.commits': c0, 'react.renders': c0 * 10 } })
    ];
    for (let k = 1; k <= keys; k++) {
      const at = 2000 + (k - 1) * 100;
      out.push(r('cmdk.results', at + lag(k), { attrs: { chars: k, rows: 20 + k, content: k === CMDK_QUERY.length ? 5 : 3 } }));
      out.push(r('cmdk.keystroke', at + 4 + k, { kind: 'span', ms: 4 + k, attrs: { chars: k, commits: 1 } }));
    }
    out.push(r('cmdk.typeEnd', 3500, { attrs: { scenario: 'cmdk', ...frames }, c: { 'react.commits': c1, 'react.renders': c1 * 10 } }));
    out.push(r('scenario.end', 3600, { attrs: { scenario: 'cmdk' } }));
    return out;
  }
  it('time the open, each key, and each key to the commit that lists its results', () => {
    const got = cmdk.measure(new Trace(typed((k) => 2 + k)), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    expect([v('cmdk.openMs'), v('cmdk.openPaintMs')]).toEqual([30, 45]);
    // Keys of 5 to 11 ms, each listed 2 + k ms after it started (the result mark comes before the span ends).
    expect([v('cmdk.keystrokes'), v('cmdk.keyMs'), v('cmdk.keyMsTotal'), v('cmdk.resultsMs'), v('cmdk.lastResultsMs')]).toEqual([7, 8, 56, 6, 9]);
    expect([v('cmdk.rows'), v('cmdk.contentRows'), v('cmdk.typeCommits'), v('cmdk.typeRenders')]).toEqual([27, 5, 30, 300]);
    expect([v('cmdk.type.frames'), v('cmdk.type.droppedFrames'), v('cmdk.type.longTasks'), v('cmdk.type.longTaskMs'), v('cmdk.type.longestFrameMs')]).toEqual([60, 2, 1, 70, 50]);
  });
  it('count results that come after their key, and never take an earlier search’s results for a later one', () => {
    const late = cmdk.measure(new Trace(typed((k) => 30 + k)), facts);
    expect([late.metrics['cmdk.resultsMs'].value, late.metrics['cmdk.lastResultsMs'].value]).toEqual([34, 37]);
    // The whole search never listed: its key has no results (the mark from before the menu opened is not its).
    const records = typed((k) => 2 + k).filter((x) => !(x.name === 'cmdk.results' && x.attrs?.chars === CMDK_QUERY.length && x.t > 1000));
    const got = cmdk.measure(new Trace(records), facts);
    expect(got.missing).toEqual(['cmdk.results (a key whose search was never listed)', 'cmdk.results (the whole search)']);
    const short = cmdk.measure(new Trace(typed((k) => 2 + k, { keys: 3 })), facts);
    expect(short.missing).toContain(`cmdk.keystroke (3 of the ${CMDK_QUERY.length} keys typed)`);
  });
});

describe('assets metrics', () => {
  const frames = { frames: 100, droppedFrames: 3, longTasks: 2, longTaskMs: 130, longestFrameMs: 80 };
  const c = (n: number) => ({ c: { 'react.commits': n, 'react.renders': n * 100, 'panel.assets.renders': n * 50, 'panel.assets.renderMs': n * 2 } });
  const w = (at: string, window: string, edge: 'start' | 'end', t: number, n: number, attrs: Record<string, number> = {}) => r('assets.window', t, { attrs: { scenario: 'assets', at, window, edge, ...attrs }, ...c(n) });
  function library(at: string, t: number, revision: number): PerfRecord[] {
    return [
      w(at, 'show', 'start', t, 0),
      w(at, 'show', 'end', t + 1000, 2, { ...frames, showMs: 120, picturesMs: 300, inView: 18, tiles: at === 'at300' ? 300 : 1000 }),
      w(at, 'edit', 'start', t + 2000, 2),
      r('renderer.snapshotReceived', t + 2100, { attrs: { revision } }),
      r('renderer.commit', t + 2140, { attrs: { revision } }),
      w(at, 'edit', 'end', t + 3000, 3, { revision }),
      w(at, 'scroll', 'start', t + 4000, 3),
      w(at, 'scroll', 'end', t + 6000, 7, { ...frames, notches: 30 }),
      r('assets.held', t + 7000, { attrs: { scenario: 'assets', at, pictures: 300, pictureBytes: 300 * 96 * 72 * 4 } }),
      ...ASSET_PICKERS.flatMap(({ key }, k) => [
        w(at, key, 'start', t + 8000 + k * 2000, 7 + k * 4),
        w(at, key, 'end', t + 8500 + k * 2000, 9 + k * 4, { tiles: at === 'at300' ? 300 : 1000 }),
        r('assets.pickerHeld', t + 9000 + k * 2000, { attrs: { scenario: 'assets', at, picker: key, pictures: 240 + k, pictureBytes: (240 + k) * 96 * 72 * 4 } })
      ])
    ];
  }
  it('measure each library’s show, edit and scroll windows, and the pictures it holds', () => {
    const got = assets.measure(new Trace([r('scenario.start', 10, { attrs: { scenario: 'assets' } }), ...library('at300', 100, 5), ...library('at1000', 10_000, 7)]), facts);
    expect(got.missing).toEqual([]);
    const v = (name: string) => got.metrics[name]?.value;
    for (const { key } of ASSET_LIBRARIES) {
      expect([v(`assets.${key}.showMs`), v(`assets.${key}.picturesMs`), v(`assets.${key}.tilesInView`), v(`assets.${key}.show.renders`), v(`assets.${key}.show.assetsRenders`), v(`assets.${key}.show.assetsRenderMs`), v(`assets.${key}.show.longTaskMs`)]).toEqual([120, 300, 18, 200, 100, 4, 130]);
      expect([v(`assets.${key}.edit.commitMs`), v(`assets.${key}.edit.renders`), v(`assets.${key}.edit.assetsRenders`), v(`assets.${key}.edit.rendererCommits`)]).toEqual([40, 100, 50, 1]);
      expect([v(`assets.${key}.scroll.ms`), v(`assets.${key}.scroll.notches`), v(`assets.${key}.scroll.droppedFrames`), v(`assets.${key}.scroll.renders`), v(`assets.${key}.picturesHeld`), v(`assets.${key}.pictureBytes`)]).toEqual([2000, 30, 3, 400, 300, 300 * 96 * 72 * 4]);
    }
    expect([v('assets.at300.tiles'), v('assets.at1000.tiles')]).toEqual([300, 1000]);
    for (const { key } of ASSET_LIBRARIES)
      ASSET_PICKERS.forEach(({ key: pk }, k) => expect([v(`assets.${key}.${pk}.renders`), v(`assets.${key}.${pk}.rendererCommits`), v(`assets.${key}.${pk}.picturesHeld`), v(`assets.${key}.${pk}.pictureBytes`)]).toEqual([200, 2, 240 + k, (240 + k) * 96 * 72 * 4]));
    expect([v('assets.at300.imagePicker.tiles'), v('assets.at1000.imagePicker.tiles'), v('assets.at1000.galleryPicker.tiles')]).toEqual([300, 1000, 1000]);
  });
  it('name what is missing instead of reporting a library that was not measured', () => {
    const got = assets.measure(new Trace([r('scenario.start', 10, { attrs: { scenario: 'assets' } }), ...library('at300', 100, 5)]), facts);
    expect(got.missing).toEqual(['assets.window at1000 show start', 'assets.window at1000 show end', 'assets.window at1000 edit start', 'assets.window at1000 edit end', 'assets.window at1000 scroll start', 'assets.window at1000 scroll end', 'assets.held at1000', 'assets.window at1000 imagePicker start', 'assets.window at1000 imagePicker end', 'assets.pickerHeld at1000 imagePicker', 'assets.window at1000 galleryPicker start', 'assets.window at1000 galleryPicker end', 'assets.pickerHeld at1000 galleryPicker']);
    const blind = assets.measure(new Trace(library('at300', 100, 5).map((x) => (x.attrs?.window === 'show' && x.attrs?.edge === 'end' ? { ...x, attrs: { ...x.attrs, picturesMs: -1 } } : x))), facts);
    expect(blind.missing).toContain('assets.at300.picturesMs (the show watch)');
  });
  it('grow the library with images drawn and named as the fixture’s own', () => {
    const grown = grownImages(300, 1000);
    expect(grown.length).toBe(700);
    expect(grown[0].record).toMatchObject({ id: 'img-301', name: 'Fixture image 301', file: 'static/assets/fixture-301.png', width: 96, height: 72, kind: 'image' });
    expect(grown.at(-1)!.record.id).toBe('img-1000');
    expect(new Set(grown.map((g) => g.file)).size).toBe(700);
  });
});
