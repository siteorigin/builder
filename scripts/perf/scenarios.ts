/**
 * The benchmark's scenarios (scripts/perf/README.md says how to add one). A scenario is something a person does in the
 * app, a check that it still did its job, and the metrics read from the iteration's trace.
 *
 * Scenarios run as a chain in one launch of the app: each names the one it follows (`after`), which sets the app up
 * for it and is measured too. `launch` starts the app to Welcome, `open` opens the fixture from Welcome's recent
 * projects to an editable canvas, and `edit` changes the home hero's heading in the Inspector until the preview shows
 * it. `run` throws a PredicateError when the feature did not do its job, and the iteration fails: a scenario never
 * gets faster by doing less. `memory` (after `launch`) reads the memory of every process of the app at named points
 * (memory.ts), and is never reported beside a timing scenario.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CDPSession, ElectronApplication, FrameLocator, Page } from 'playwright';
import { desktopInMain, type DesktopCall } from '../../tests/driver/desktop';
import { HISTORY_LIMIT, type BuilderApi, type ProjectSnapshot } from '../../src/shared/api';
import type { PerfAttrs, PerfRecord } from '../../src/shared/perf';
import type { ProjectState } from '../../src/shared/types';
import { generateProject } from '../../src/generator/index';
import type { ChatMessage, Conversation } from '../../src/shared/api';
import { DONE, envelopeReply, MockOpenAIServer, sseChunk, textReply, toolCallReply, type MockReply } from '../../tests/unit/mock-openai-server';
import { createStarterState, STARTER_ASSETS } from '../../src/catalogue/starters';
import { projectFolderName } from '../../src/shared/project-name';
import { fixturePng, type FixtureSpec } from './fixtures';
import { isAssetSort, sortAssets } from '../../src/shared/asset-order';
import { growthMetrics, readingMetrics, type MemoryProbe, type MemoryReading } from './memory';
import { PHOTO_COUNT, photoSpec, scenarioPhotos } from './photos';
import { atRevision, Collector, counter, delta, forScenario, inProc, median, type Measured, type Trace } from './results';
import { displayName } from '../../src/engine/tree';

/** The feature did not do its job: the iteration fails, whatever its timings. */
export class PredicateError extends Error {}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new PredicateError(message);
}

/** What a fixture holds, for checking that it opened whole. */
export interface FixtureFacts {
  spec: FixtureSpec;
  pages: number;
  entries: number;
  assets: number;
  projectComponents: number;
  homePageId: string;
  /** The home page's address, which the canvas reports when its page is ready. */
  homeRoute: string;
  /** The home hero, the first placement on the home page with a Heading. */
  heroId: string;
  /** Its heading, as the preview first shows it. */
  heading: string;
}

/** The first node in `doc` (depth first, in document order) with a string `props.heading`. */
export function findHeading(doc: unknown, id?: string): { id: string; heading: string } | null {
  const stack: unknown[] = [doc];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    const node = v as { id?: unknown; props?: { heading?: unknown } };
    if (typeof node.id === 'string' && typeof node.props?.heading === 'string' && (id === undefined || node.id === id)) return { id: node.id, heading: node.props.heading };
    const children = Array.isArray(v) ? v : Object.values(v);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
}

export function fixtureFacts(spec: FixtureSpec, state: ProjectState): FixtureFacts {
  const home = state.pages[state.site.homePageId];
  const hero = findHeading(home);
  if (!hero) throw new Error(`The ${spec.name} fixture's home page has no placement with a Heading to edit.`);
  return {
    spec,
    pages: Object.keys(state.pages).length,
    entries: Object.values(state.collections ?? {}).reduce((n, c) => n + Object.keys((c as { entries?: object }).entries ?? {}).length, 0),
    assets: Object.keys(state.assets.assets).length,
    projectComponents: Object.values(state.components).filter((c) => c.owner === 'project').length,
    homePageId: state.site.homePageId,
    homeRoute: home.route,
    heroId: hero.id,
    heading: hero.heading
  };
}

export interface ScenarioContext {
  app: ElectronApplication;
  win: Page;
  fixture: FixtureFacts;
  /** The project folder this iteration opens. */
  projectDir: string;
  /**
   * A second copy of the fixture, trusted and in Recent projects behind the first, put back with it for every
   * iteration: what `switch` opens over the first. Null when no scenario asked for one.
   */
  otherProjectDir: string | null;
  iteration: number;
  /** How long to wait once a scenario's job is done before ending it, so work it set off afterwards is counted. */
  settleMs: number;
  /** When the project's files were last put in place (ms, Date.now): opening waits for them to settle first. */
  restoredAt: number;
  /** Mark a point in both processes, with each one's counters. */
  mark(name: string, attrs?: PerfAttrs): Promise<void>;
  /**
   * The trace once `done` says it has what is needed, or as it is when `timeoutMs` passes. It never throws: a mark that
   * did not arrive is the measurement's to report (a missing mark), not a sign that the app is not where it should be.
   */
  waitTrace(done: (t: Trace) => boolean, timeoutMs?: number): Promise<Trace>;
  /** Memory readings (memory.ts): only in a chain with a memory scenario, so nothing else ever reads or collects. */
  memory?: MemoryProbe;
}

export interface Scenario {
  name: string;
  /** The scenario this one follows in the same launch; null for the one that starts the app. */
  after: string | null;
  description: string;
  run(ctx: ScenarioContext): Promise<void>;
  /** This scenario's metrics from the iteration's trace, and the memory readings its run took (in the order taken). */
  measure(trace: Trace, fixture: FixtureFacts, readings?: MemoryReading[]): Collector;
  /** A memory scenario: it collects garbage and waits for the app to settle, so it is never reported beside a timing one. */
  memory?: boolean;
  /** How long its run may take, when not the runner's usual deadline. */
  deadlineMs?: number;
}

/** The editor page's globals, inside `win.evaluate` (the scripts are not compiled with the DOM's types). Cast inline:
 *  Playwright sends only the function's own source to the page. */
type EditorPage = { builder: BuilderApi };
/** The little of the DOM the chat scenario reads inside `win.waitForFunction`, typed the same way. */
type DomElement = { textContent: string | null; querySelector(selector: string): DomElement | null };
type DomPage = { document: { querySelector(selector: string): DomElement | null; querySelectorAll(selector: string): Iterable<DomElement> } };

/** The preview frame of the canvas. */
const preview = (win: Page): FrameLocator => win.frameLocator('.frame-box iframe');

/** How long a project's files must be left alone before an open reads them as a person's would be (session.ts settleMs). */
const FILES_SETTLE_MS = 3500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough after a panel or tab is chosen for the workspace save it sets off (300 ms later) to have landed. */
const WORKSPACE_SAVE_WAIT_MS = 1000;

/** The bytes `sent` snapshots carried; a snapshot whose size could not be told leaves the total missing, never short. */
function bytesSent(m: Collector, name: string, sent: PerfRecord[]) {
  if (sent.some((r) => typeof r.attrs?.bytes !== 'number')) m.need(`${name} (a snapshot whose size could not be told)`, undefined);
  else m.count(name, sent.reduce((n, r) => n + (r.attrs!.bytes as number), 0), 'bytes');
}

/** React commits between two editor marks; missing when the editor said it could not count them (never a false zero). */
function commits(m: Collector, trace: Trace, name: string, from: PerfRecord | undefined, to: PerfRecord | undefined) {
  if (trace.first('perf.reactCommitsUncounted')) m.need(`${name} (the editor could not count React commits)`, undefined);
  else m.count(name, counter(to, 'react.commits') - counter(from, 'react.commits'));
}

/** The longest main-process stall in [from, to], 0 when there was none. */
function stallMax(trace: Trace, from: PerfRecord | undefined, to: PerfRecord | undefined): number {
  if (!from || !to) return 0;
  return Math.max(0, ...trace.all('main.stall', inProc('main'), from.t, to.t).map((r) => r.ms ?? 0));
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

export const launch: Scenario = {
  name: 'launch',
  after: null,
  description: 'Start the app to an interactive Welcome screen that lists the fixture among its recent projects.',
  async run(ctx) {
    const { win, app } = ctx;
    await win.locator('.welcome').waitFor({ timeout: 60_000 });
    const card = win.locator('.recent-card', { hasText: ctx.fixture.spec.title });
    await card.first().waitFor({ timeout: 30_000 });
    expect(await card.first().isEnabled(), 'the fixture’s recent-project card is not enabled');
    expect(await win.locator('.welcome-action').first().isEnabled(), 'New project is not enabled');
    expect((await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot())) === null, 'a project is open at launch');
    const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
    expect(!shown, 'a window was shown: the run must stay headless');
    // Welcome can be ready before the theme packs are verified and their catalogue has arrived: what is measured waits
    // for those too.
    await ctx.waitTrace((t) => ['launch.recentsShown', 'launch.firstInteractive', 'launch.loadPacks', 'launch.catalogueReceived'].every((name) => !!t.first(name)), 15_000);
    // Welcome is still the screen once the themes are in: a catalogue that failed or held none replaces it.
    expect(await win.locator('.welcome').isVisible(), 'Welcome did not stay once the theme catalogue arrived');
  },
  measure(trace) {
    const m = new Collector();
    const start = m.need('launch.processStart', trace.first('launch.processStart'));
    for (const name of ['launch.mainLoaded', 'launch.appReady', 'launch.windowCreated', 'launch.readyToShow', 'launch.firstRender', 'launch.firstInteractive', 'launch.recentsShown']) m.since(name, start, m.need(name, trace.first(name)));
    // The editor's page and script, from the window being made: its page starting, parsed, the script's first line
    // running (load and compile done), every module it imports up front evaluated, and the theme catalogue arriving.
    const editor = (name: string) => m.need(name, trace.first(name, inProc('renderer')));
    for (const name of ['launch.pageStart', 'launch.pageParsed', 'launch.scriptStart', 'launch.scriptEvaluated', 'launch.catalogueReceived']) m.since(name, start, editor(name));
    m.since('launch.scriptCompile', trace.first('launch.pageParsed', inProc('renderer')), trace.first('launch.scriptStart', inProc('renderer')));
    m.since('launch.scriptEvaluate', trace.first('launch.scriptStart', inProc('renderer')), trace.first('launch.scriptEvaluated', inProc('renderer')));
    const made = trace.first('launch.windowCreated');
    m.since('launch.windowToFirstRender', made, trace.first('launch.firstRender'));
    // An interactive Welcome that lists its recent projects: the later of the two.
    const interactive = trace.first('launch.firstInteractive');
    const listed = trace.first('launch.recentsShown');
    m.since('launch.windowToWelcome', made, interactive && listed ? (interactive.t >= listed.t ? interactive : listed) : undefined);
    m.span('launch.loadPacks', m.need('launch.loadPacks', trace.first('launch.loadPacks')));
    const shown = trace.first('launch.recentsShown');
    commits(m, trace, 'launch.rendererCommits', undefined, shown);
    // What the main process read and hashed before it made the window (theme packs are verified file by file).
    m.count('launch.filesReadBeforeWindow', counter(made, 'files.read'));
    m.count('launch.filesHashedBeforeWindow', counter(made, 'files.hashed'));
    m.ms('launch.mainStallMax', stallMax(trace, start, shown));
    return m;
  }
};

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

export const open: Scenario = {
  name: 'open',
  after: 'launch',
  description: 'Open the fixture from its recent-project card on Welcome, to the canvas bridge reporting the home page ready to edit.',
  async run(ctx) {
    const { fixture } = ctx;
    // A person's project has been left alone a while: freshly copied files are read in full, so they settle first.
    const wait = ctx.restoredAt + FILES_SETTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    await ctx.mark('scenario.start', { scenario: 'open' });
    await openFromWelcome(ctx);
    await checkOpened(ctx);
    await ctx.waitTrace((t) => !!t.first('canvas.ready', homeReady(fixture), forScenarioStart(t, 'open')), 15_000);
    await sleep(ctx.settleMs);
    await ctx.mark('scenario.end', { scenario: 'open' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('open', 'renderer')) && !!t.first('scenario.end', forScenario('open', 'main')));
  },
  measure(trace, fixture) {
    const m = new Collector();
    const begin = trace.first('scenario.start', forScenario('open', 'renderer'));
    const end = trace.first('scenario.end', forScenario('open', 'main'));
    const from = begin?.t ?? Infinity;
    const req = m.need('open.requested', trace.first('open.requested', inProc('renderer'), from));
    const at = req?.t ?? Infinity;
    const ready = m.need('canvas.ready', trace.first('canvas.ready', homeReady(fixture), at));
    const span = (name: string) => m.need(name, trace.first(name, inProc('main'), at));
    const controllerOpen = span('controller.open');
    const session = span('session.open');
    const attach = span('controller.attach');
    const runtime = span('controller.startRuntime');
    const endMain = m.need('scenario.end (main)', end);
    m.span('open.controller', controllerOpen);
    m.span('open.session', session);
    for (const phase of ['formatCheck', 'lock', 'prepare', 'recover', 'read', 'localState', 'validate']) m.span(`open.session.${phase}`, span(`session.open.${phase}`));
    // The open's own publication (never a new project's first, `initial`), wherever it runs: inside session.open or
    // after it, before the canvas is ready.
    const publish = m.need('session.publish', trace.first('session.publish', (r) => r.proc === 'main' && r.attrs?.initial === false, at, ready?.t));
    m.span('open.publish', publish);
    // The open's sweep of history blobs and unused assets, wherever it runs, until the scenario ends.
    const sweep = m.need('session.sweep', trace.first('session.sweep', inProc('main'), at, endMain?.t));
    m.span('open.sweep', sweep);
    // Both of its generations, the website's and the preview's: a sum missing one would look faster than it is.
    const variant = (v: string) => trace.all('session.generate', (r) => r.proc === 'main' && r.attrs?.variant === v, publish ? publish.t - (publish.ms ?? 0) : Infinity, publish?.t);
    const clean = variant('clean');
    const dev = variant('dev');
    if (publish && !clean.length) m.need('session.generate (clean)', undefined);
    if (publish && !dev.length) m.need('session.generate (dev)', undefined);
    if (clean.length && dev.length) m.ms('open.generate', [...clean, ...dev].reduce((n, r) => n + (r.ms ?? NaN), 0));
    m.span('open.attach', attach);
    const assetCheck = span('controller.assetCheck');
    m.span('open.assetCheck', assetCheck);
    m.span('open.startRuntime', runtime);
    const firstSent = m.need('controller.snapshotSent', trace.first('controller.snapshotSent', inProc('main'), at));
    m.since('open.firstSnapshotSent', req, firstSent);
    // What the editor's first snapshot waited for: each of these that ended before it was sent.
    const before = (name: string, r?: (x: PerfRecord) => boolean) => trace.all(name, (x) => x.proc === 'main' && (!r || r(x)), at, firstSent?.t ?? -Infinity).length;
    m.count('open.generationsBeforeSnapshot', before('session.generate'));
    m.count('open.sweepsBeforeSnapshot', before('session.sweep'));
    m.count('open.assetChecksBeforeSnapshot', before('controller.assetCheck'));
    m.since('open.editorShown', req, m.need('renderer.commit (editor)', trace.first('renderer.commit', (r) => r.attrs?.screen === 'editor', at)));
    previewStart(m, trace, 'open', req, at, ready);
    m.since('open.canvasReady', req, ready);
    // What the author watches as "Starting preview": the editor shown to the page ready to edit in its canvas.
    m.since('open.editorToCanvasReady', trace.first('renderer.commit', (r) => r.attrs?.screen === 'editor', at), ready);
    // Everything the main process counted from the click to the scenario's end, so work moved after the editor
    // appears (a publication, a sweep) is still counted.
    const startMain = m.need('scenario.start (main)', trace.first('scenario.start', forScenario('open', 'main')));
    const sum = (name: string) => counter(endMain, name) - counter(startMain, name);
    m.count('open.filesRead', sum('files.read'));
    m.count('open.docsRead', sum('docs.read'));
    m.count('open.filesHashed', sum('files.hashed'));
    m.count('open.durableWrites', sum('fs.durableWrites'));
    m.count('open.fsyncs', sum('fs.fsyncs'));
    m.count('open.publishFilesRead', delta(publish, 'files.read'));
    m.count('open.publishFilesHashed', delta(publish, 'files.hashed'));
    m.count('open.publishFilesWritten', delta(publish, 'fs.writes'));
    m.count('open.publishSyncCalls', delta(publish, 'fs.syncCalls'));
    m.count('open.publishStats', delta(publish, 'files.stats'));
    m.count('open.publishBytesHashed', delta(publish, 'files.hashedBytes'), 'bytes');
    const sent = trace.all('controller.snapshotSent', inProc('main'), at, ready?.t);
    m.count('open.snapshotsSent', sent.length);
    bytesSent(m, 'open.snapshotBytes', sent);
    m.count('open.reloadFromDisk', trace.all('session.reloadFromDisk', inProc('main'), at, endMain?.t).length);
    commits(m, trace, 'open.rendererCommits', req, ready);
    m.ms('open.mainStallMax', stallMax(trace, req, ready));
    return m;
  }
};

/**
 * The preview's start after `req` (#960), phase by phase, all marked by the preview process that served the page the
 * canvas reported ready (`ready`): the last to start listening after `from` and before it, never one stopped unused.
 * Forked, the worker given its start, the project's Vite loaded, its server made, listening (`runtime.ready`), the
 * canvas's first page asked for and its answer gone; with the three stretches between the fork, the server listening,
 * that answer and `ready`.
 */
function previewStart(m: Collector, trace: Trace, prefix: string, req: PerfRecord | undefined, from: number, ready: PerfRecord | undefined) {
  if (!ready) return;
  const listening = m.need('runtime.ready', trace.all('runtime.ready', inProc('main'), from, ready.t).at(-1));
  if (!listening) return;
  const worker = listening.attrs?.worker;
  const ofWorker = (r: PerfRecord) => r.proc === 'main' && worker !== undefined && r.attrs?.worker === worker;
  const at = (name: string) => m.need(name, trace.first(name, ofWorker, from));
  const [forked, started, loaded, created, asked, answered] = ['runtime.forked', 'runtime.started', 'runtime.viteLoaded', 'runtime.serverCreated', 'runtime.firstRequest', 'runtime.firstResponse'].map(at);
  m.since(`${prefix}.runtimeForked`, req, forked);
  m.since(`${prefix}.runtimeStarted`, req, started);
  m.since(`${prefix}.runtimeViteLoaded`, req, loaded);
  m.since(`${prefix}.runtimeServerCreated`, req, created);
  m.since(`${prefix}.runtimeReady`, req, listening);
  m.since(`${prefix}.runtimeFirstRequest`, req, asked);
  m.since(`${prefix}.runtimeFirstResponse`, req, answered);
  m.since(`${prefix}.forkToListen`, forked, listening);
  m.since(`${prefix}.listenToFirstResponse`, listening, answered);
  m.since(`${prefix}.firstResponseToCanvasReady`, answered, ready);
}

/** Open the fixture from its recent-project card on Welcome, to the preview showing the home hero's heading, editable. */
async function openFromWelcome(ctx: ScenarioContext): Promise<void> {
  const { win, fixture } = ctx;
  await win.locator('.recent-card', { hasText: fixture.spec.title }).first().click();
  await win.locator('.editor').waitFor({ timeout: 120_000 });
  const frame = preview(win);
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 120_000 });
  await frame.getByRole('heading', { name: fixture.heading, exact: true, level: 1 }).first().waitFor({ timeout: 30_000 });
}

/** The fixture opened whole and writable, from its own folder: its pages, posts, images, components and home hero. */
async function checkOpened(ctx: ScenarioContext): Promise<void> {
  const { win, fixture } = ctx;
  const snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
  expect(snap, 'no project is open');
  expect(!snap.readOnly, `the project opened read-only: ${snap.readOnly?.reason ?? ''}`);
  expect(snap.dir === ctx.projectDir, `another project opened: ${snap.dir}`);
  const facts = { pages: Object.keys(snap.state.pages).length, entries: Object.values(snap.state.collections ?? {}).reduce((n, c) => n + Object.keys((c as { entries?: object }).entries ?? {}).length, 0), assets: Object.keys(snap.state.assets.assets).length, projectComponents: Object.values(snap.state.components).filter((c) => c.owner === 'project').length };
  for (const k of ['pages', 'entries', 'assets', 'projectComponents'] as const) expect(facts[k] === fixture[k], `the project opened with ${facts[k]} ${k}, not ${fixture[k]}`);
  expect(snap.state.site.homePageId === fixture.homePageId, 'the project opened with another home page');
  expect(findHeading(snap.state.pages[fixture.homePageId], fixture.heroId)?.heading === fixture.heading, 'the home hero opened with another heading');
}

/** When a scenario's start mark reached the trace from the editor; Infinity before it has. */
function forScenarioStart(t: Trace, scenario: string): number {
  return t.first('scenario.start', forScenario(scenario, 'renderer'))?.t ?? Infinity;
}

/** The canvas reporting the fixture's home page ready to edit: not another page, a component preview, or Preview mode. */
const homeReady =
  (fixture: FixtureFacts) =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.mode === 'edit' && r.attrs?.studio === false && r.attrs?.path === fixture.homeRoute;

// ---------------------------------------------------------------------------
// switch
// ---------------------------------------------------------------------------

/** How long the first project's preview server and lock may take to go once the second project is ready to edit. */
const SWITCH_LEFT_MS = 15_000;

/** The project's lock file (src/main/project/session.ts), there while this app holds the project. */
const lockFile = (dir: string) => join(dir, '.siteorigin', 'lock.json');

export const switchProject: Scenario = {
  name: 'switch',
  after: 'open',
  description:
    'With the fixture open, open a second copy of it with File > Open Project…, to the canvas bridge reporting its home page ready to edit; the first project’s preview server must stop and its lock go.',
  async run(ctx) {
    const { app, win, fixture } = ctx;
    const other = ctx.otherProjectDir;
    expect(other, 'no second project was prepared to switch to');
    expect(existsSync(lockFile(ctx.projectDir)), 'the first project is not locked before the switch');
    const wait = ctx.restoredAt + FILES_SETTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    // The folder chooser File > Open Project… shows is answered through the app's chooser fixtures
    // (src/main/headless-desktop.ts), never by patching the dialog. Inline: the runner's compiler wraps named inner
    // functions in a helper the main process does not have, so the driver's own *InMain functions cannot be sent.
    const answered = await app.evaluate((_electron, paths) => {
      const fixtures = (globalThis as Record<symbol, { editor: number | null; setAnswers(a: unknown[], o: { request: null }): string[] } | undefined>)[Symbol.for('siteorigin.desktopFixtures')];
      return fixtures && fixtures.editor !== null ? fixtures.setAnswers([{ dialog: 'open', paths }], { request: null }).length : 0;
    }, [other]);
    expect(answered === 1, 'the app answers no choosers, or has no editor window: it was not launched by a test');
    await ctx.mark('scenario.start', { scenario: 'switch' });
    // Chosen as the menu bar chooses it: the item's own click, for the editor window (never focused: it is headless).
    const chosen = await app.evaluate(({ Menu, BrowserWindow }) => {
      const id = (globalThis as Record<symbol, { editor: number | null } | undefined>)[Symbol.for('siteorigin.desktopFixtures')]?.editor;
      const win = typeof id === 'number' ? BrowserWindow.fromId(id) : null;
      const item = Menu.getApplicationMenu()?.getMenuItemById('open-project');
      if (!win || !item || !item.enabled || item.label !== 'Open Project…') return false;
      item.click({ triggeredByAccelerator: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false } as unknown as KeyboardEvent, win, win.webContents);
      return true;
    });
    expect(chosen, 'File > Open Project… is not there to choose, or is disabled');
    // The second project in the editor, then its page ready to edit in the canvas: never the first project's.
    const deadline = Date.now() + 120_000;
    let snap: Awaited<ReturnType<BuilderApi['project']['snapshot']>> = null;
    while (Date.now() < deadline) {
      snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
      if (snap?.dir === other) break;
      await sleep(25);
    }
    expect(snap?.dir === other, `the second project did not open: ${snap?.dir ?? 'no project is open'}`);
    const t = await ctx.waitTrace((t) => !!switchReady(t, fixture), 120_000);
    expect(switchReady(t, fixture), 'the canvas never reported the second project’s home page ready to edit');
    await preview(win).getByRole('heading', { name: fixture.heading, exact: true, level: 1 }).first().waitFor({ timeout: 30_000 });
    snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(snap?.dir === other, `another project is open after the switch: ${snap?.dir ?? 'none'}`);
    expect(!snap.readOnly, `the second project opened read-only: ${snap.readOnly?.reason ?? ''}`);
    const facts = { pages: Object.keys(snap.state.pages).length, entries: Object.values(snap.state.collections ?? {}).reduce((n, c) => n + Object.keys((c as { entries?: object }).entries ?? {}).length, 0), assets: Object.keys(snap.state.assets.assets).length, projectComponents: Object.values(snap.state.components).filter((c) => c.owner === 'project').length };
    for (const k of ['pages', 'entries', 'assets', 'projectComponents'] as const) expect(facts[k] === fixture[k], `the second project opened with ${facts[k]} ${k}, not ${fixture[k]}`);
    expect(findHeading(snap.state.pages[fixture.homePageId], fixture.heroId)?.heading === fixture.heading, 'the second project’s home hero opened with another heading');
    // The first project's preview server always stops, and its lock goes with it.
    const left = await ctx.waitTrace((t) => !!oldWorkerExited(t, fixture), SWITCH_LEFT_MS);
    expect(oldWorkerExited(left, fixture), 'the first project’s preview server was never stopped');
    const lockDeadline = Date.now() + SWITCH_LEFT_MS;
    while (existsSync(lockFile(ctx.projectDir)) && Date.now() < lockDeadline) await sleep(50);
    expect(!existsSync(lockFile(ctx.projectDir)), 'the first project is still locked after the switch');
    expect(existsSync(lockFile(other)), 'the second project is not locked');
    await sleep(ctx.settleMs);
    await ctx.mark('scenario.end', { scenario: 'switch' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('switch', 'renderer')) && !!t.first('scenario.end', forScenario('switch', 'main')));
  },
  measure(trace, fixture) {
    const m = new Collector();
    const begin = trace.first('scenario.start', forScenario('switch', 'renderer'));
    const from = begin?.t ?? Infinity;
    const req = m.need('open.requested', trace.first('open.requested', inProc('renderer'), from));
    const at = req?.t ?? Infinity;
    const ready = m.need('canvas.ready', switchReady(trace, fixture));
    const span = (name: string) => m.need(name, trace.first(name, inProc('main'), at));
    m.span('switch.controller', span('controller.open'));
    m.span('switch.session', span('session.open'));
    m.span('switch.close', span('controller.close'));
    m.span('switch.attach', span('controller.attach'));
    m.span('switch.startRuntime', span('controller.startRuntime'));
    previewStart(m, trace, 'switch', req, at, ready);
    m.since('switch.canvasReady', req, ready);
    // The first project's server stopping, which the second's start need not wait for, but which must always happen.
    m.since('switch.oldServerExited', req, m.need('runtime.exited (the first project’s)', oldWorkerExited(trace, fixture)));
    m.ms('switch.mainStallMax', stallMax(trace, req, ready));
    return m;
  }
};

/** The preview process that served the first project's canvas in `open` (the last listening before it), reported gone. */
function oldWorkerExited(t: Trace, fixture: FixtureFacts): PerfRecord | undefined {
  const shown = t.first('canvas.ready', homeReady(fixture), forScenarioStart(t, 'open'));
  const listening = shown && t.all('runtime.ready', inProc('main'), -Infinity, shown.t).at(-1);
  return listening ? t.first('runtime.exited', (r) => r.proc === 'main' && r.attrs?.worker === listening.attrs?.worker, shown.t) : undefined;
}

/**
 * The canvas reporting the second project's home page ready to edit: after the switch was asked for, after a preview
 * process forked since then was listening, and after the second project was attached (the first project's canvas let
 * go of by then), so the first project's canvas is never taken for it.
 */
function switchReady(t: Trace, fixture: FixtureFacts): PerfRecord | undefined {
  const req = t.first('open.requested', inProc('renderer'), forScenarioStart(t, 'switch'));
  if (!req) return undefined;
  const forked = t.first('runtime.forked', inProc('main'), req.t);
  const listening = forked && t.first('runtime.ready', (r) => r.proc === 'main' && r.attrs?.worker === forked.attrs?.worker, forked.t);
  const attach = t.first('controller.attach', inProc('main'), req.t);
  if (!listening || !attach) return undefined;
  return t.first('canvas.ready', homeReady(fixture), Math.max(listening.t, attach.t - (attach.ms ?? 0)));
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/**
 * `<prefix>.generate`, every generation of both variants in [from, to] (the website's and the preview's), and
 * `<prefix>.generateCheck`, the part of them the generation cache spent finding which files' inputs are unchanged: a
 * sum missing a variant would look faster than it is.
 */
function generation(m: Collector, trace: Trace, prefix: string, from: number, to: number) {
  const variant = (name: string, v: string) => trace.all(name, (r) => r.proc === 'main' && r.attrs?.variant === v, from, to);
  const clean = variant('session.generate', 'clean');
  const dev = variant('session.generate', 'dev');
  if (!clean.length) m.need('session.generate (clean)', undefined);
  if (!dev.length) m.need('session.generate (dev)', undefined);
  if (clean.length && dev.length) m.ms(`${prefix}.generate`, [...clean, ...dev].reduce((n, r) => n + (r.ms ?? NaN), 0));
  const checks = [...variant('session.generateCheck', 'clean'), ...variant('session.generateCheck', 'dev')];
  if (!checks.some((r) => r.attrs?.variant === 'clean') || !checks.some((r) => r.attrs?.variant === 'dev')) m.need('session.generateCheck (both variants)', undefined);
  else m.ms(`${prefix}.generateCheck`, checks.reduce((n, r) => n + (typeof r.attrs?.ms === 'number' ? r.attrs.ms : NaN), 0));
}

export const EDITED_HEADING = 'Benchmark heading';

/**
 * Change the home hero's Heading in the Inspector to `text` and the iteration, bracketed as `scenario`, and check that the
 * edit landed: the project moved one revision, its document on disk holds the heading, the preview shows it. `check` adds
 * a scenario's own. Each scenario types its own text, so none leaves the page another one will make (whose version
 * History would then hold already).
 */
async function editHeroHeading(ctx: ScenarioContext, scenario: string, text: string, check?: (after: ProjectSnapshot, target: number) => void) {
  const { win, fixture } = ctx;
  const heading = `${text} ${ctx.iteration}`;
  const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
  expect(before, 'no project is open');
  // Choosing what to edit is not timed: the edit starts when the Heading is committed.
  const hero = win.getByRole('treeitem', { name: 'Split hero' }).first();
  // Layers is open already when another edit ran before this one in the same launch: pressing it again would close it.
  if (!(await hero.isVisible())) await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
  await hero.click();
  await win.getByRole('tab', { name: 'Inspector', exact: true }).first().click();
  const field = win.getByRole('textbox', { name: 'Heading', exact: true }).first();
  await field.waitFor({ timeout: 15_000 });
  // Choosing the panel and tab saves the workspace 300 ms later: that save lands before the edit starts, not in it,
  // whatever --settle is.
  await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
  await ctx.mark('scenario.start', { scenario });
  await field.fill(heading);
  await win.keyboard.press('Tab');
  await preview(win).getByRole('heading', { name: heading, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
  const target = before.revision + 1;
  await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(target)), 30_000);
  const after = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
  expect(after && after.revision === target, `the edit left the project at revision ${after?.revision}, not ${target}`);
  expect(findHeading(after.state.pages[fixture.homePageId], fixture.heroId)?.heading === heading, 'the project does not hold the new heading on the home hero');
  const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
  const saved = existsSync(doc) ? (JSON.parse(readFileSync(doc, 'utf8')) as unknown) : null;
  expect(findHeading(saved, fixture.heroId)?.heading === heading, 'the home page’s document on disk does not hold the new heading on the home hero');
  check?.(after, target);
  await sleep(ctx.settleMs);
  await ctx.mark('scenario.end', { scenario });
  await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario(scenario, 'renderer')) && !!t.first('scenario.end', forScenario(scenario, 'main')));
}

/** The project-wide checks an edit's main process works out (#966), with the record kinds they are read from. */
const SESSION_CHECKS = [
  // The save gate's check of the new state, and the snapshot's: the problems Project Health lists.
  ['saveCheck', 'saving'],
  ['diagnostics', 'diagnostics'],
  ['assetUsages', 'usages'],
  ['themeUpdates', 'updates']
] as const;
const BATCH_CHECKS = [
  ['batchSyncedEntries', 'apply.syncedEntries'],
  ['batchItemStates', 'apply.itemStates'],
  ['batchCollectionSources', 'apply.collectionSources'],
  ['batchDependencies', 'apply.dependencies']
] as const;

/**
 * What an edit spends checking and deriving from the whole project: the batch's own checks once it is applied (in the
 * apply, `until`), and each check and value of the session's worked out from the edit to the scenario's end, so one
 * moved later is still counted. Each is a time and how many times it was worked out: a check the edit no longer needs
 * is 0 of both, never missing.
 */
function checkMetrics(m: Collector, trace: Trace, name: (metric: string) => string, at: number, until: number, end: PerfRecord | undefined) {
  const to = end?.t ?? -Infinity;
  const sum = (rs: PerfRecord[]) => rs.reduce((n, r) => n + (r.ms ?? NaN), 0);
  const parts: number[] = [];
  const add = (metric: string, rs: PerfRecord[]) => {
    const ms = sum(rs);
    parts.push(ms);
    m.ms(name(metric), ms);
    m.count(name(`${metric}Runs`), rs.length);
  };
  const batch = m.need('apply.batchChecks', trace.first('apply.batchChecks', inProc('main'), at, until));
  m.span(name('batchChecks'), batch);
  if (batch?.ms !== undefined) parts.push(batch.ms);
  for (const [metric, span] of BATCH_CHECKS) m.ms(name(metric), sum(trace.all(span, inProc('main'), at, until)));
  // Every operation's sweep of item styles that departed with their items, a walk of every page's tree.
  add('itemStyles', trace.all('apply.itemStyles', inProc('main'), at, until));
  for (const [metric, check] of SESSION_CHECKS) add(metric, trace.all('session.check', (r) => r.proc === 'main' && r.attrs?.check === check, at, to));
  add('versionsInfo', trace.all('session.versionsInfo', inProc('main'), at, to));
  m.ms(name('checks'), parts.reduce((n, v) => n + v, 0));
  const snapshots = trace.all('controller.snapshot', inProc('main'), at, to);
  m.ms(name('snapshotBuild'), sum(snapshots));
  m.count(name('snapshotBuilds'), snapshots.length);
}

/** The metrics of an edit bracketed as `scenario`, each named `<scenario>.<metric>`. */
function measureEdit(trace: Trace, scenario: string): Collector {
  const m = new Collector();
  const name = (metric: string) => `${scenario}.${metric}`;
  const begin = trace.first('scenario.start', forScenario(scenario, 'renderer'));
  const req = m.need('edit.requested', trace.first('edit.requested', inProc('renderer'), begin?.t ?? Infinity));
  const at = req?.t ?? Infinity;
  const target = typeof req?.attrs?.revision === 'number' ? req.attrs.revision + 1 : NaN;
  const applied = m.need('controller.apply', trace.first('controller.apply', atRevision(target), at));
  const until = applied?.t ?? Infinity;
  const inApply = (mark: string) => m.need(mark, trace.first(mark, inProc('main'), at, until));
  m.span(name('apply'), applied);
  m.span(name('sessionApply'), inApply('session.apply'));
  m.span(name('validateOperations'), inApply('session.validateOperations'));
  m.span(name('applyOperations'), inApply('session.applyOperations'));
  m.span(name('validate'), inApply('session.validateState'));
  // Every generation of both variants, the website's and the preview's: a sum missing one would look faster than it is.
  generation(m, trace, scenario, at, until);
  m.span(name('changedDocs'), inApply('session.changedDocs'));
  m.count(name('docsCopied'), delta(applied, 'apply.docsCopied'));
  m.count(name('docsSerialized'), delta(applied, 'docs.serialized'));
  m.span(name('persist'), inApply('session.persist'));
  const publish = inApply('session.publish');
  m.span(name('publish'), publish);
  m.since(name('hmrRelease'), req, inApply('runtime.release'));
  const changed = m.need('session.changed', trace.first('session.changed', atRevision(target), at));
  m.since(name('changed'), req, changed);
  const snapshotSent = m.need('controller.snapshotSent', trace.first('controller.snapshotSent', atRevision(target), at));
  const snapshotReceived = m.need('renderer.snapshotReceived', trace.first('renderer.snapshotReceived', atRevision(target), at));
  const rendererCommit = m.need('renderer.commit', trace.first('renderer.commit', atRevision(target), at));
  m.since(name('snapshotSent'), req, snapshotSent);
  m.since(name('snapshotReceived'), req, snapshotReceived);
  m.since(name('rendererCommit'), req, rendererCommit);
  // The change reaching the editor, stretch by stretch (#967): the main process putting the editor's copy together and
  // sending it, IPC carrying it to the editor's handler, and the editor taking it in to React's commit that shows it.
  m.since(name('changedToSent'), changed, snapshotSent);
  m.since(name('sentToReceived'), snapshotSent, snapshotReceived);
  m.since(name('receivedToCommit'), snapshotReceived, rendererCommit);
  m.since(name('previewPublished'), req, m.need('runtime.published', trace.first('runtime.published', atRevision(target), at)));
  const shown = m.need('canvas.revisionApplied', trace.first('canvas.revisionApplied', atRevision(target), at));
  m.since(name('previewApplied'), req, shown);
  m.count(name('durableWrites'), delta(applied, 'fs.durableWrites'));
  m.count(name('fsyncs'), delta(applied, 'fs.fsyncs'));
  m.count(name('fileWrites'), delta(applied, 'fs.writes'));
  // The whole edit's synchronous filesystem calls, path stats and bytes hashed, then the publication's own.
  m.count(name('syncCalls'), delta(applied, 'fs.syncCalls'));
  m.count(name('fileStats'), delta(applied, 'files.stats'));
  m.count(name('bytesHashed'), delta(applied, 'files.hashedBytes'), 'bytes');
  m.count(name('publishFilesRead'), delta(publish, 'files.read'));
  m.count(name('publishFilesHashed'), delta(publish, 'files.hashed'));
  m.count(name('publishBytesHashed'), delta(publish, 'files.hashedBytes'), 'bytes');
  m.count(name('publishFilesWritten'), delta(publish, 'fs.writes'));
  m.count(name('publishDurableWrites'), delta(publish, 'fs.durableWrites'));
  m.count(name('publishFsyncs'), delta(publish, 'fs.fsyncs'));
  m.count(name('publishSyncCalls'), delta(publish, 'fs.syncCalls'));
  m.count(name('publishStats'), delta(publish, 'files.stats'));
  const endMain = m.need('scenario.end (main)', trace.first('scenario.end', forScenario(scenario, 'main')));
  const endRenderer = m.need('scenario.end (renderer)', trace.first('scenario.end', forScenario(scenario, 'renderer')));
  checkMetrics(m, trace, name, at, until, endMain);
  // Garbage collection (history blobs, unused assets): the sweeps the edit waited on before it was acknowledged, and
  // every sweep until the scenario ends, so a sweep moved later is still seen, never taken for one that was dropped.
  const awaited = trace.all('session.sweep', inProc('main'), at, changed?.t ?? -Infinity);
  m.count(name('sweepsAwaited'), awaited.length);
  m.ms(name('sweepAwaited'), awaited.reduce((n, r) => n + (r.ms ?? NaN), 0));
  m.count(name('sweeps'), trace.all('session.sweep', inProc('main'), at, endMain?.t ?? -Infinity).length);
  const sent = trace.all('controller.snapshotSent', inProc('main'), at, endMain?.t);
  m.count(name('snapshotsSent'), sent.length);
  bytesSent(m, name('snapshotBytes'), sent);
  m.count(name('reloadFromDisk'), trace.all('session.reloadFromDisk', inProc('main'), at, endMain?.t).length);
  commits(m, trace, name('rendererCommits'), req, endRenderer);
  m.ms(name('mainStallMax'), stallMax(trace, req, shown));
  return m;
}

export const edit: Scenario = {
  name: 'edit',
  after: 'open',
  description: 'Change the home hero’s Heading in the Inspector and wait for the preview to show it.',
  run: (ctx) => editHeroHeading(ctx, 'edit', EDITED_HEADING),
  measure: (trace) => measureEdit(trace, 'edit')
};

// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------

/** How many edits the `edits` scenario makes. */
export const EDITS = 20;
/** How long it waits after a save for the file watch to go off before it sends the next edit anyway. */
export const WATCH_WAIT_MS = 5000;
/** How long it gives the app to take the change made outside it before saving the file again. */
const OUTSIDE_WAIT_MS = 15_000;
const OUTSIDE_SAVES = 6;
/** The heading the `edits` scenario writes into the home page's file outside the app. */
export const OUTSIDE_HEADING = 'Benchmark heading changed outside';

/** The `k`th of an iteration's edits to the hero's heading. */
export const editsHeading = (iteration: number, k: number) => `${EDITED_HEADING} ${iteration}.${k}`;

export const edits: Scenario = {
  name: 'edits',
  after: 'open',
  description: `Change the home hero’s Heading in the Inspector ${EDITS} times, each as the file watch goes off for the save before it, then change the home page’s file outside the app and wait for the editor to take it.`,
  async run(ctx) {
    const { win, fixture } = ctx;
    const snapshot = () => win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    const before = await snapshot();
    expect(before, 'no project is open');
    // Choosing what to edit is not timed, and the workspace save it sets off lands before the first edit.
    await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
    await win.getByRole('treeitem', { name: 'Split hero' }).first().click();
    await win.getByRole('tab', { name: 'Inspector', exact: true }).first().click();
    const field = win.getByRole('textbox', { name: 'Heading', exact: true }).first();
    await field.waitFor({ timeout: 15_000 });
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await ctx.mark('scenario.start', { scenario: 'edits' });
    const madeIn = (rev: number) => (r: PerfRecord) => r.proc === 'main' && r.attrs?.revision === rev && r.attrs?.ok === true;
    /** Once edit `k` is saved, until the file watch goes off (for it, or a save before it the system told of late). */
    const watchAfter = async (k: number) => {
      const saved = (await ctx.waitTrace((t) => !!t.first('controller.apply', madeIn(before.revision + k)), 60_000)).first('controller.apply', madeIn(before.revision + k));
      expect(saved, `edit ${k} of ${EDITS} was not saved`);
      await ctx.waitTrace((t) => !!t.first('controller.watchFired', inProc('main'), saved.t), WATCH_WAIT_MS);
    };
    for (let k = 1; k <= EDITS; k++) {
      await field.fill(editsHeading(ctx.iteration, k));
      await win.keyboard.press('Tab');
      // The next edit goes as the watch goes off for this save: when the reload of the project a save sets off starts.
      // The system tells of a save a moment or seconds after it (a fixed delay would miss it), or, on a busy machine,
      // not at all: then the next edit goes WATCH_WAIT_MS after the save.
      await watchAfter(k);
    }
    const last = editsHeading(ctx.iteration, EDITS);
    const target = before.revision + EDITS;
    await preview(win).getByRole('heading', { name: last, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
    await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(target)), 30_000);
    const after = await snapshot();
    expect(after && after.revision === target, `the ${EDITS} edits left the project at revision ${after?.revision}, not ${target}`);
    expect(findHeading(after.state.pages[fixture.homePageId], fixture.heroId)?.heading === last, 'the project does not hold the last heading on the home hero');
    const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
    const text = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
    expect(findHeading(text ? (JSON.parse(text) as unknown) : null, fixture.heroId)?.heading === last, 'the home page’s document on disk does not hold the last heading on the home hero');
    // A reload the last save sets off is counted with the edits.
    await sleep(ctx.settleMs);
    await ctx.mark('edits.outside', { scenario: 'edits', revision: target });
    // Changed outside the app as an editor saves a file: written beside it under a name of its own, then renamed over it
    // (a file renamed in from outside the watched folder is never told of on macOS). A busy machine can lose the
    // system's word of it: then it is saved again, as a person would, until the app takes it.
    const parts = text.split(JSON.stringify(last));
    expect(parts.length === 2, 'the home page’s document holds the last heading other than once');
    const outside = `${OUTSIDE_HEADING} ${ctx.iteration}`;
    const taken = (t: Trace) => !!t.first('controller.snapshotSent', atRevision(target + 1));
    for (let saves = 1; ; saves++) {
      const saving = `${doc}.${ctx.iteration}-${saves}.saving`;
      writeFileSync(saving, parts.join(JSON.stringify(outside)));
      renameSync(saving, doc);
      if (taken(await ctx.waitTrace(taken, OUTSIDE_WAIT_MS))) break;
      expect(saves < OUTSIDE_SAVES, `the change made outside the app was not taken, saved ${saves} times ${OUTSIDE_WAIT_MS / 1000} s apart`);
    }
    await preview(win).getByRole('heading', { name: outside, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
    await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(target + 1)), 30_000);
    const now = await snapshot();
    expect(now && now.revision === target + 1, `the change made outside the app left the project at revision ${now?.revision}, not ${target + 1}`);
    expect(findHeading(now.state.pages[fixture.homePageId], fixture.heroId)?.heading === outside, 'the project does not hold the heading changed outside the app');
    expect(now.history.canUndo && now.history.undoLabel === 'External change', `the change made outside the app is not the step Undo takes back (${now.history.undoLabel ?? 'nothing to undo'})`);
    await ctx.mark('scenario.end', { scenario: 'edits' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('edits', 'renderer')) && !!t.first('scenario.end', forScenario('edits', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const startMain = m.need('scenario.start (main)', trace.first('scenario.start', forScenario('edits', 'main')));
    const startRenderer = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('edits', 'renderer')));
    const outMain = m.need('edits.outside (main)', trace.first('edits.outside', forScenario('edits', 'main')));
    const outRenderer = m.need('edits.outside (renderer)', trace.first('edits.outside', forScenario('edits', 'renderer')));
    const endMain = m.need('scenario.end (main)', trace.first('scenario.end', forScenario('edits', 'main')));
    const from = startMain?.t ?? Infinity;
    const to = outMain?.t ?? -Infinity;
    const target = outMain?.attrs?.revision;
    if (outMain && typeof target !== 'number') m.need('edits.outside (with the revision the edits left)', undefined);
    // Each edit by the revision it made: the edits made the EDITS revisions up to the one the outside mark names.
    const applies: Array<{ whole: number; own: number }> = [];
    if (typeof target === 'number')
      for (let rev = target - EDITS + 1; rev <= target; rev++) {
        const made = (r: PerfRecord) => r.proc === 'main' && r.attrs?.revision === rev && r.attrs?.ok === true;
        const whole = m.need(`controller.apply (revision ${rev})`, trace.first('controller.apply', made, from, to));
        const own = m.need(`session.apply (revision ${rev})`, trace.first('session.apply', made, from, to));
        if (whole && own) applies.push({ whole: whole.ms ?? NaN, own: own.ms ?? NaN });
      }
    if (applies.length === EDITS) {
      // An edit's wait for its turn: its time in the main process less its own work once its turn came.
      const waits = applies.map((a) => a.whole - a.own);
      m.ms('edits.queueWait', median(waits.slice(1)));
      m.ms('edits.queueWaitTotal', waits.reduce((n, w) => n + w, 0));
      m.ms('edits.apply', median(applies.map((a) => a.whole)));
      m.ms('edits.sessionApply', median(applies.map((a) => a.own)));
    }
    const sentAt = trace.all('edit.requested', inProc('renderer'), startRenderer?.t ?? Infinity, outRenderer?.t ?? -Infinity).map((r) => r.t);
    if (startRenderer && outRenderer && sentAt.length !== EDITS) m.need(`${EDITS} edit.requested (there were ${sentAt.length})`, undefined);
    else if (sentAt.length) m.ms('edits.sendGap', median(sentAt.slice(1).map((t, i) => t - sentAt[i])));
    m.count('edits.reloadFromDisk', trace.all('session.reloadFromDisk', inProc('main'), from, to).length);
    m.count('edits.reloadUnchanged', trace.all('session.reloadUnchanged', inProc('main'), from, to).length);
    const gained = (name: string) => counter(outMain, name) - counter(startMain, name);
    m.count('edits.filesRead', gained('files.read'));
    m.count('edits.docsRead', gained('docs.read'));
    m.count('edits.filesHashed', gained('files.hashed'));
    m.count('edits.durableWrites', gained('fs.durableWrites'));
    m.count('edits.fsyncs', gained('fs.fsyncs'));
    const sent = trace.all('controller.snapshotSent', inProc('main'), from, to);
    m.count('edits.snapshotsSent', sent.length);
    bytesSent(m, 'edits.snapshotBytes', sent);
    commits(m, trace, 'edits.rendererCommits', startRenderer, outRenderer);
    m.ms('edits.mainStallMax', stallMax(trace, startMain, outMain));
    m.count('edits.watchFired', trace.all('controller.watchFired', inProc('main'), from, to).length);
    // The change made outside the app, from the watch going off for it (when the system tells of a change is its own
    // affair) to the editor and the canvas being sent and showing it.
    const outRev = typeof target === 'number' ? target + 1 : NaN;
    const sentOut = m.need('controller.snapshotSent (the change made outside)', trace.first('controller.snapshotSent', atRevision(outRev), to));
    const fired = m.need('controller.watchFired (for the change made outside)', trace.all('controller.watchFired', inProc('main'), to, sentOut?.t ?? -Infinity).at(-1));
    m.since('edits.outsideSent', fired, sentOut);
    m.since('edits.outsideApplied', fired, m.need('canvas.revisionApplied (the change made outside)', trace.first('canvas.revisionApplied', atRevision(outRev), to)));
    m.count('edits.outsideReloads', trace.all('session.reloadFromDisk', inProc('main'), to, endMain?.t ?? -Infinity).length);
    return m;
  }
};

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

/** How many operations the `batch` scenario's one change makes: the most one apply_operations call may carry. */
export const BATCH_OPERATIONS = 30;
/** What is asked, in Edit mode on the home page, and the scripted model's answer once its change has landed. */
export const BATCH_REQUEST = 'Rewrite the wording of every section on this page.';
export const BATCH_REPLY = 'Rewrote the wording of every section on the home page.';

/** The text properties the batch rewrites: each placement's own string properties on the page, in document order. */
export function batchTargets(state: ProjectState, pageId: string): Array<{ nodeId: string; prop: string }> {
  const out: Array<{ nodeId: string; prop: string }> = [];
  for (const node of Object.values(state.pages[pageId]?.nodes ?? {})) {
    if (node.kind !== 'instance') continue;
    const props = state.components[node.definitionId]?.properties ?? {};
    for (const [prop, value] of Object.entries(node.props)) if (typeof value === 'string' && props[prop]?.type === 'string') out.push({ nodeId: node.id, prop });
  }
  return out;
}

/**
 * The batch: BATCH_OPERATIONS `instance.setProp` operations over the page's text properties in turn (one set twice
 * keeps its later text), and the text each property holds once it has landed, by `nodeId:prop`.
 */
export function batchOperations(state: ProjectState, pageId: string, iteration: number): { operations: Array<Record<string, unknown>>; final: Map<string, string> } {
  const targets = batchTargets(state, pageId);
  const operations: Array<Record<string, unknown>> = [];
  const final = new Map<string, string>();
  for (let k = 0; targets.length && k < BATCH_OPERATIONS; k++) {
    const { nodeId, prop } = targets[k % targets.length];
    const value = `Batch ${iteration}.${k}`;
    operations.push({ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop, value });
    final.set(`${nodeId}:${prop}`, value);
  }
  return { operations, final };
}

/** Whether `page` (a page's document, as the project holds it or as saved) holds every text of `final`. */
function holdsBatch(page: unknown, final: Map<string, string>): boolean {
  const nodes = (page as { nodes?: Record<string, { props?: Record<string, unknown> }> } | null)?.nodes ?? {};
  return [...final].every(([key, value]) => {
    const [nodeId, prop] = key.split(':');
    return Object.hasOwn(nodes, nodeId) && nodes[nodeId].props?.[prop] === value;
  });
}

export const batch: Scenario = {
  name: 'batch',
  after: 'open',
  description: 'In the AI panel, in Edit mode on the home page, ask for a change the scripted model makes as one apply_operations call of 30 operations, and wait for the preview to show it and the request to end.',
  async run(ctx) {
    const { win, fixture } = ctx;
    const server = await new MockOpenAIServer().start();
    try {
      // The scripted model, in native tool mode; untimed, as is the reload that takes the setting.
      await win.evaluate((url) => (globalThis as unknown as EditorPage).builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: url, allowRemote: false, toolMode: 'native', contextWindow: 131_072 } } } as never), server.baseURL);
      await win.reload();
      await win.locator('.editor').waitFor({ timeout: 60_000 });
      await preview(win).locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60_000 });
      await win.locator('.dock-tab', { hasText: 'AI' }).first().click();
      await composer(win).waitFor({ timeout: 15_000 });
      // An edit, limited to the page: the run checks each batch against what the page may change.
      const asking = win.getByRole('button', { name: /^What your next message does: Ask/ });
      if (await asking.count()) {
        await asking.first().click();
        await win.getByRole('menuitemradio', { name: /^Edit/ }).click();
      }
      const before = await snapshotOf(win);
      expect(before, 'no project is open');
      await win.getByRole('button', { name: /^What the AI may change: / }).first().click();
      await win.getByRole('menuitemradio', { name: /^This page/ }).or(win.getByRole('menuitem', { name: /^This page/ })).first().click();
      const title = before.state.pages[fixture.homePageId].title;
      expect(await win.getByRole('button', { name: `What the AI may change: ${title}`, exact: true }).count(), 'the request is not limited to the home page');
      const { operations, final } = batchOperations(before.state, fixture.homePageId, ctx.iteration);
      expect(operations.length === BATCH_OPERATIONS && final.size > BATCH_OPERATIONS / 2, `the home page has ${final.size} text properties to rewrite, too few for a batch of ${BATCH_OPERATIONS}`);
      const heroHeading = final.get(`${fixture.heroId}:heading`);
      expect(heroHeading, 'the batch does not rewrite the home hero’s heading');
      server.script(toolCallReply('apply_operations', { expectedRevision: before.revision, operations }));
      server.respond = () => textReply(BATCH_REPLY);
      await composer(win).fill(BATCH_REQUEST);
      // Choosing the mode and the scope saves the workspace 300 ms later: that lands before the request is sent.
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      await ctx.mark('scenario.start', { scenario: 'batch' });
      await win.keyboard.press('Enter');
      await preview(win).getByRole('heading', { name: heroHeading, exact: true, level: 1 }).first().waitFor({ timeout: 120_000 });
      await win.waitForFunction(
        (reply) => {
          const doc = (globalThis as unknown as DomPage).document;
          return !doc.querySelector('.run-strip') && ([...doc.querySelectorAll('.chat-log .msg-ai')].at(-1)?.textContent ?? '').includes(reply);
        },
        BATCH_REPLY,
        { timeout: 120_000 }
      );
      const after = await snapshotOf(win);
      expect(after && after.revision === before.revision + 1, `the request left the project at revision ${after?.revision}, not ${before.revision + 1}`);
      expect(holdsBatch(after.state.pages[fixture.homePageId], final), 'the project does not hold every text the batch wrote on the home page');
      const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
      expect(holdsBatch(existsSync(doc) ? JSON.parse(readFileSync(doc, 'utf8')) : null, final), 'the home page’s document on disk does not hold every text the batch wrote');
      const applied = await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(after.revision)), 30_000);
      expect(applied.first('canvas.revisionApplied', atRevision(after.revision)), 'the canvas never reported the batch applied');
      await sleep(ctx.settleMs);
      await ctx.mark('scenario.end', { scenario: 'batch' });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('batch', 'renderer')) && !!t.first('scenario.end', forScenario('batch', 'main')));
    } finally {
      await server.stop();
    }
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (main)', trace.first('scenario.start', forScenario('batch', 'main')));
    const end = m.need('scenario.end (main)', trace.first('scenario.end', forScenario('batch', 'main')));
    const from = begin?.t ?? Infinity;
    const to = end?.t ?? -Infinity;
    m.span('batch.beginRun', m.need('session.beginRun', trace.first('session.beginRun', inProc('main'), from, to)));
    // The batch's own apply: the one that moved the project.
    const applied = m.need('session.apply (the batch)', trace.first('session.apply', (r) => r.proc === 'main' && r.attrs?.ok === true, from, to));
    const start = applied ? applied.t - (applied.ms ?? 0) : Infinity;
    const until = applied?.t ?? -Infinity;
    const inApply = (name: string) => m.need(name, trace.first(name, inProc('main'), start, until));
    // What the run checks before it hands the batch to the project: Developer mode's copies and the request's reach.
    const checks = [...trace.all('agent.devModeCheck', inProc('main'), from, start), ...trace.all('agent.authorityCheck', inProc('main'), from, start)];
    m.need('agent.authorityCheck', trace.first('agent.authorityCheck', inProc('main'), from, start));
    m.ms('batch.checks', checks.reduce((n, r) => n + (r.ms ?? NaN), 0));
    m.span('batch.sessionApply', applied);
    m.span('batch.applyOperations', inApply('session.applyOperations'));
    m.span('batch.validate', inApply('session.validateState'));
    generation(m, trace, 'batch', start, until);
    m.span('batch.changedDocs', inApply('session.changedDocs'));
    m.span('batch.persist', inApply('session.persist'));
    m.span('batch.publish', inApply('session.publish'));
    // The run's recovery marker, written as it starts and again with each batch: every document hashed each time.
    const markers = trace.all('session.runMarker', inProc('main'), from, to);
    m.need('session.runMarker', markers[0]);
    m.ms('batch.runMarker', markers.reduce((n, r) => n + (r.ms ?? NaN), 0));
    m.count('batch.runMarkers', markers.length);
    m.count('batch.runDocsHashed', counter(end, 'run.docsHashed') - counter(begin, 'run.docsHashed'));
    m.count('batch.docsCopied', delta(applied, 'apply.docsCopied'));
    m.count('batch.docsSerialized', delta(applied, 'docs.serialized'));
    m.count('batch.durableWrites', delta(applied, 'fs.durableWrites'));
    m.count('batch.fsyncs', delta(applied, 'fs.fsyncs'));
    const revision = typeof applied?.attrs?.revision === 'number' ? applied.attrs.revision : NaN;
    const shown = m.need('canvas.revisionApplied', trace.first('canvas.revisionApplied', atRevision(revision), from));
    m.since('batch.previewApplied', begin, shown);
    // What the editor was sent over the whole run (#967): the run going busy and idle, and the batch's change.
    const sent = trace.all('controller.snapshotSent', inProc('main'), from, to);
    m.count('batch.snapshotsSent', sent.length);
    bytesSent(m, 'batch.snapshotBytes', sent);
    m.ms('batch.mainStallMax', stallMax(trace, begin, shown));
    return m;
  }
};

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

/** The editor's panels, as its counters name them (src/renderer/src/lib/perf-panels.tsx): the sidebar's six views, the
 *  post writer and SEO view that cover the canvas, and the dock's four. */
export const PANELS = ['pages', 'posts', 'layers', 'insert', 'assets', 'seo', 'postWriter', 'seoView', 'chat', 'inspect', 'styles', 'project'] as const;
/** The one panel on screen in each of `panels`' windows: the dock's Project view for the click (so the Inspector is
 *  hidden too), the Inspector for the edit, which is made there. */
export const SHOWN_PANELS = { click: 'project', edit: 'inspect' } as const;
/** The placement the canvas click selects, as the canvas, Layers and the Inspector name it. */
const HERO_NAME = 'Split hero';
/** The canvas's toolbar for what is selected, which names it. */
const heroChip = (win: Page) => win.getByRole('toolbar', { name: `${HERO_NAME} actions`, exact: true });
/** The Inspector's name for what is selected. */
const inspectorName = (win: Page) => win.locator('#dock-panel-inspect .insp-name h3');

/** Each panel's renders and render time between two editor marks; missing when the editor never counted the panel. */
function perPanel(m: Collector, prefix: string, shown: string, from: PerfRecord | undefined, to: PerfRecord | undefined) {
  if (!from || !to) return;
  if (trackless(from) || trackless(to)) return void m.need(`${prefix} (the editor did not count component renders)`, undefined);
  let hiddenMs = 0;
  let hiddenRenders = 0;
  for (const id of PANELS) {
    const renders = `panel.${id}.renders`;
    const time = `panel.${id}.renderMs`;
    if (from.c?.[renders] === undefined || to.c?.[time] === undefined) {
      m.need(`${prefix} (the ${id} panel was not mounted)`, undefined);
      continue;
    }
    const n = counter(to, renders) - counter(from, renders);
    const ms = counter(to, time) - counter(from, time);
    m.count(`${prefix}.renders.${id}`, n);
    m.ms(`${prefix}.renderMs.${id}`, ms);
    if (id !== shown) {
      hiddenRenders += n;
      hiddenMs += ms;
    }
  }
  m.count(`${prefix}.hiddenRenders`, hiddenRenders);
  m.ms(`${prefix}.hiddenRenderMs`, hiddenMs);
  m.count(`${prefix}.renders`, counter(to, 'react.renders') - counter(from, 'react.renders'));
}
const trackless = (r: PerfRecord) => r.c?.['react.renders'] === undefined;
const atPhase =
  (phase: string, scenario = 'panels') =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.scenario === scenario && r.attrs?.phase === phase;

/** Where every sidebar view's and dock panel's content is held. */
const PANEL_HOLDERS = '#editor-sidebar .side-panel-view, #editor-dock [role="tabpanel"]';
type PanelHolder = { firstElementChild: Record<string, unknown> | null };
/** Tags each panel's content, so `panelsKept` can tell the same elements from new copies; whether each had content. */
const tagPanels = (win: Page): Promise<boolean[]> =>
  win.locator(PANEL_HOLDERS).evaluateAll((els) => els.map((el) => !!(el as unknown as PanelHolder).firstElementChild && ((el as unknown as PanelHolder).firstElementChild!.__perfKept = true)));
/** Whether each panel's content is still the element `tagPanels` tagged. */
const panelsKept = (win: Page): Promise<boolean[]> => win.locator(PANEL_HOLDERS).evaluateAll((els) => els.map((el) => (el as unknown as PanelHolder).firstElementChild?.__perfKept === true));

/**
 * The two windows `panels` times, for `scenario`: from `scenario.start`, a click on the home hero on the canvas (the
 * dock on Project, so the Inspector is hidden too) to the selection shown, then, with the Inspector shown (between the
 * windows, in neither), its Heading changed to `heading` there, to the preview showing it; ends at `scenario.end`.
 */
async function clickThenEdit(ctx: ScenarioContext, scenario: string, before: ProjectSnapshot, heading: string): Promise<void> {
  const { win, fixture } = ctx;
  const shownHeading = findHeading(before.state.pages[fixture.homePageId], fixture.heroId)?.heading ?? fixture.heading;
  await ctx.mark('scenario.start', { scenario });
  // A click on the canvas selects the hero, as the canvas's selection toolbar shows.
  await preview(win).getByRole('heading', { name: shownHeading, exact: true, level: 1 }).first().click();
  await heroChip(win).waitFor({ timeout: 30_000 });
  await ctx.waitTrace((t) => !!t.first('renderer.selectionCommit', (r) => r.attrs?.selected === true, forScenarioStart(t, scenario)), 15_000);
  await sleep(ctx.settleMs);
  await ctx.mark('scenario.phase', { scenario, phase: 'clicked' });
  // Not timed: the Inspector, hidden through the click, shows the hero as soon as it is shown again.
  await win.getByRole('tab', { name: 'Inspector', exact: true }).first().click();
  await win.locator('#dock-panel-inspect').waitFor({ state: 'visible', timeout: 15_000 });
  const named = (await inspectorName(win).first().textContent())?.trim();
  expect(named === HERO_NAME, `the Inspector, shown again, names ${named ? `“${named}”` : 'nothing'}, not the ${HERO_NAME} the canvas selected`);
  await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
  await ctx.mark('scenario.phase', { scenario, phase: 'edit' });
  // One property changed in the Inspector, to the preview showing it.
  const field = win.getByRole('textbox', { name: 'Heading', exact: true }).first();
  await field.waitFor({ timeout: 15_000 });
  await field.fill(heading);
  await win.keyboard.press('Tab');
  await preview(win).getByRole('heading', { name: heading, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
  const target = before.revision + 1;
  await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(target)), 30_000);
  const after = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
  expect(after && after.revision === target, `the edit left the project at revision ${after?.revision}, not ${target}`);
  expect(findHeading(after.state.pages[fixture.homePageId], fixture.heroId)?.heading === heading, 'the project does not hold the new heading on the home hero');
  const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
  const saved = existsSync(doc) ? (JSON.parse(readFileSync(doc, 'utf8')) as unknown) : null;
  expect(findHeading(saved, fixture.heroId)?.heading === heading, 'the home page’s document on disk does not hold the new heading on the home hero');
  await sleep(ctx.settleMs);
  await ctx.mark('scenario.end', { scenario });
  await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario(scenario, 'renderer')) && !!t.first('scenario.end', forScenario(scenario, 'main')));
}

/** `clickThenEdit`'s metrics, named `<scenario>.click.*` and `<scenario>.edit.*`, and its window marks. */
function measureClickThenEdit(trace: Trace, scenario: string) {
  const m = new Collector();
  const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario(scenario, 'renderer')));
  const clicked = m.need('scenario.phase clicked (renderer)', trace.first('scenario.phase', atPhase('clicked', scenario)));
  const editing = m.need('scenario.phase edit (renderer)', trace.first('scenario.phase', atPhase('edit', scenario)));
  const end = m.need('scenario.end (renderer)', trace.first('scenario.end', forScenario(scenario, 'renderer')));
  // The click: from the canvas telling the editor of it to the commit that shows the selection.
  const select = m.need('canvas.select', trace.first('canvas.select', inProc('renderer'), begin?.t ?? Infinity, clicked?.t));
  const shown = m.need('renderer.selectionCommit', trace.first('renderer.selectionCommit', (r) => r.proc === 'renderer' && r.attrs?.selected === true, select?.t ?? Infinity, clicked?.t));
  m.since(`${scenario}.click.commit`, select, shown);
  perPanel(m, `${scenario}.click`, SHOWN_PANELS.click, begin, clicked);
  commits(m, trace, `${scenario}.click.rendererCommits`, begin, clicked);
  // The edit: from the editor receiving the edited project to the commit that shows it.
  const req = m.need('edit.requested', trace.first('edit.requested', inProc('renderer'), editing?.t ?? Infinity, end?.t));
  const target = typeof req?.attrs?.revision === 'number' ? req.attrs.revision + 1 : NaN;
  const at = req?.t ?? Infinity;
  const received = m.need('renderer.snapshotReceived', trace.first('renderer.snapshotReceived', atRevision(target), at));
  const committed = m.need('renderer.commit', trace.first('renderer.commit', atRevision(target), at));
  m.since(`${scenario}.edit.commit`, received, committed);
  m.since(`${scenario}.edit.rendererCommit`, req, committed);
  perPanel(m, `${scenario}.edit`, SHOWN_PANELS.edit, editing, end);
  commits(m, trace, `${scenario}.edit.rendererCommits`, editing, end);
  return { m, windows: { click: [begin, clicked], edit: [editing, end] } as Record<'click' | 'edit', [PerfRecord | undefined, PerfRecord | undefined]> };
}

export const panels: Scenario = {
  name: 'panels',
  after: 'open',
  description: 'With every panel hidden but the dock’s Project view, click the home hero on the canvas; then, with the Inspector shown, change its Heading there.',
  async run(ctx) {
    const { win } = ctx;
    // Its own heading, never the one another scenario in the chain (edit) may have left.
    const heading = `Panels heading ${ctx.iteration}`;
    const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(before, 'no project is open');
    // Not timed: every sidebar view hidden (the open one's rail button pressed again), the dock open on Project.
    const pressed = win.locator('.rail button[aria-pressed="true"]:not([data-rail="styles"])');
    if (await pressed.count()) await pressed.first().click();
    await win.locator('#editor-sidebar').waitFor({ state: 'hidden', timeout: 15_000 });
    if (!(await win.locator('#editor-dock').isVisible())) await win.getByRole('button', { name: 'Right panel', exact: true }).click();
    await win.getByRole('tab', { name: 'Project', exact: true }).first().click();
    await win.locator('#dock-panel-project').waitFor({ state: 'visible', timeout: 15_000 });
    // Nothing of the hero selected (a scenario before this one may have left it so), so the click changes the selection.
    for (let i = 0; i < 4 && (await heroChip(win).count()); i++) await win.keyboard.press('Escape');
    expect(!(await heroChip(win).count()), `the ${HERO_NAME} is still selected, so the click would change nothing`);
    // Hidden, not gone: every panel's content is in the page, and stays the same elements through the scenario (each is
    // tagged here and looked for afterwards), so a panel shown again has what it had, not a new copy.
    const views = await tagPanels(win);
    expect(views.length >= 10 && views.every(Boolean), `only ${views.filter(Boolean).length} of the sidebar's and dock's ${views.length} panels are in the page`);
    // Choosing the panels saves the workspace 300 ms later: that save lands before the click, not in it.
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await clickThenEdit(ctx, 'panels', before, heading);
    // After the window: the panels hidden through it are still there, and Layers, shown again, is up to date at once.
    const still = await panelsKept(win);
    expect(still.length === views.length && still.every(Boolean), `${still.filter((x) => !x).length} of the panels were replaced or left the page while hidden`);
    await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
    await win.locator('#editor-sidebar').waitFor({ state: 'visible', timeout: 15_000 });
    const chosen = await win.locator('#editor-sidebar').getByRole('treeitem', { name: HERO_NAME, selected: true }).count();
    expect(chosen > 0, `Layers, shown again, does not have the ${HERO_NAME} selected`);
  },
  measure(trace) {
    return measureClickThenEdit(trace, 'panels').m;
  }
};

// ---------------------------------------------------------------------------
// panelsInUse
// ---------------------------------------------------------------------------

/** The work over the whole site a panel does as it renders (src/renderer/src/lib/perf-panels.tsx), as `panelsInUse` names it. */
export const SITE_WORK = { seoOverviews: 'seo.overviews', seoRoutes: 'seo.routes', chatStarters: 'chat.starters' } as const;
/** The post `panelsInUse` writes and checks in the SEO view, made when the fixture has none. */
const IN_USE_POST = { collectionId: 'posts', entryId: 'en_inuse', title: 'Panels in use post' };
/** The post's address in the SEO view (seoSubjectKey). */
const seoKey = (p: { collectionId: string; entryId: string }) => `entry:${p.collectionId}:${p.entryId}`;
/** The writer's title field, and the SEO view's document for the post. */
const writerTitle = (win: Page) => win.locator('.post-writer .post-title-input');
const seoDoc = (win: Page, key: string) => win.locator(`.seo-view [data-seo-doc="${key}"]`);
type Tagged = { __perfKept?: boolean };

export const panelsInUse: Scenario = {
  name: 'panelsInUse',
  after: 'open',
  description: 'As panels, with each panel holding work: a post open in the writer, that post chosen in the SEO view, and an AI provider connected (the scripted model) with starters offered, every one of them hidden.',
  async run(ctx) {
    const { win } = ctx;
    const heading = `Panels in use heading ${ctx.iteration}`;
    const server = await new MockOpenAIServer().start();
    try {
      // Not timed: the scripted model connected (no live provider; nothing is sent to it), and the reload that takes it.
      await win.evaluate((url) => (globalThis as unknown as EditorPage).builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: url, allowRemote: false, toolMode: 'native', contextWindow: 131_072 } } } as never), server.baseURL);
      await win.reload();
      await win.locator('.editor').waitFor({ timeout: 60_000 });
      await preview(win).locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60_000 });
      // A post to write: the fixture's first, or one made for it when the fixture has none.
      let snap = await snapshotOf(win);
      expect(snap, 'no project is open');
      const posts = Object.hasOwn(snap.state.collections, IN_USE_POST.collectionId) ? Object.keys(snap.state.collections[IN_USE_POST.collectionId].entries).sort() : [];
      if (!posts.length) {
        const made = await win.evaluate(
          (p) => (globalThis as unknown as EditorPage).builder.project.apply({ operations: [...(p.collection ? [] : [{ type: 'collection.create', collectionId: p.collectionId }]), { type: 'entry.create', collectionId: p.collectionId, entryId: p.entryId, title: p.title, publishedAt: '2024-01-02', draft: false, excerpt: 'A post for the benchmark.', body: ['A post for the benchmark.'] }] as never }, { label: 'Benchmark post' }),
          { ...IN_USE_POST, collection: Object.hasOwn(snap.state.collections, IN_USE_POST.collectionId) }
        );
        expect((made as { ok?: boolean }).ok !== false, `the benchmark's post could not be made: ${JSON.stringify(made).slice(0, 300)}`);
        snap = await snapshotOf(win);
      }
      const post = { collectionId: IN_USE_POST.collectionId, entryId: posts[0] ?? IN_USE_POST.entryId };
      const postTitle = snap?.state.collections[post.collectionId]?.entries[post.entryId]?.title;
      expect(postTitle, `the project has no post ${post.entryId} to write`);
      // The AI panel, in Edit mode, offering its starters: what a connected provider works out from the project.
      if (!(await win.locator('#editor-dock').isVisible())) await win.getByRole('button', { name: 'Right panel', exact: true }).click();
      await win.locator('.dock-tab', { hasText: 'AI' }).first().click();
      await composer(win).waitFor({ timeout: 15_000 });
      const asking = win.getByRole('button', { name: /^What your next message does: Ask/ });
      if (await asking.count()) {
        await asking.first().click();
        await win.getByRole('menuitemradio', { name: /^Edit/ }).click();
      }
      await win.locator('#dock-panel-chat .suggestion').first().waitFor({ timeout: 15_000 });
      // The post open in the writer, from the Posts panel.
      await win.locator('.rail [data-rail="posts"]').click();
      await win.locator(`#editor-sidebar [role="option"][data-post="${post.entryId}"]`).click();
      await win.locator('.post-writer-holder').waitFor({ state: 'visible', timeout: 15_000 });
      await writerTitle(win).waitFor({ timeout: 15_000 });
      expect((await writerTitle(win).inputValue()) === postTitle, `the writer does not hold the post “${postTitle}”`);
      // The same post chosen in the SEO view.
      const key = seoKey(post);
      await win.locator('.rail [data-rail="seo"]').click();
      await win.locator('.seo-view-holder').waitFor({ state: 'visible', timeout: 15_000 });
      await win.locator(`#editor-sidebar .seo-panel [data-seo="${key}"]`).click();
      await seoDoc(win, key).waitFor({ timeout: 15_000 });
      // Every sidebar view hidden (the SEO view's rail button pressed again), so the writer and the SEO view are both
      // put away holding the post, and the dock open on Project, so the AI panel is hidden too.
      await win.locator('.rail [data-rail="seo"]').click();
      await win.locator('#editor-sidebar').waitFor({ state: 'hidden', timeout: 15_000 });
      await win.locator('.seo-view-holder').waitFor({ state: 'hidden', timeout: 15_000 });
      await win.locator('.post-writer-holder').waitFor({ state: 'hidden', timeout: 15_000 });
      await win.getByRole('tab', { name: 'Project', exact: true }).first().click();
      await win.locator('#dock-panel-project').waitFor({ state: 'visible', timeout: 15_000 });
      expect(await seoDoc(win, key).count(), 'the SEO view, put away, no longer holds the post');
      expect(await writerTitle(win).count(), 'the writer, put away, no longer holds the post');
      for (let i = 0; i < 4 && (await heroChip(win).count()); i++) await win.keyboard.press('Escape');
      expect(!(await heroChip(win).count()), `the ${HERO_NAME} is still selected, so the click would change nothing`);
      const before = await snapshotOf(win);
      expect(before, 'no project is open');
      // Hidden, not gone: the panels, the writer's title and the SEO view's document stay the same elements throughout.
      const views = await tagPanels(win);
      expect(views.length >= 10 && views.every(Boolean), `only ${views.filter(Boolean).length} of the sidebar's and dock's ${views.length} panels are in the page`);
      await writerTitle(win).evaluate((el) => void ((el as unknown as Tagged).__perfKept = true));
      await seoDoc(win, key).evaluate((el) => void ((el as unknown as Tagged).__perfKept = true));
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      await clickThenEdit(ctx, 'panelsInUse', before, heading);
      // After the windows: everything hidden through them is still there.
      const still = await panelsKept(win);
      expect(still.length === views.length && still.every(Boolean), `${still.filter((x) => !x).length} of the panels were replaced or left the page while hidden`);
      expect(await writerTitle(win).evaluate((el) => (el as unknown as Tagged).__perfKept === true), 'the writer was replaced while hidden');
      expect(await seoDoc(win, key).evaluate((el) => (el as unknown as Tagged).__perfKept === true), 'the SEO view’s document was replaced while hidden');
      // The AI panel, shown again, offers starters for the hero the click selected while it was hidden, at once.
      await win.locator('.dock-tab', { hasText: 'AI' }).first().click();
      await win.locator('#dock-panel-chat').waitFor({ state: 'visible', timeout: 15_000 });
      const starters = await win.locator('#dock-panel-chat .suggestion').allTextContents();
      expect(starters.some((t) => t.toLowerCase().includes(HERO_NAME.toLowerCase())), `the AI panel, shown again, offers ${starters.length ? starters.map((t) => `“${t.trim()}”`).join(', ') : 'no starters'}, none about the ${HERO_NAME} selected`);
      // The post renamed while the writer and the SEO view are hidden: each, shown again, has the new title at once.
      const renamed = `${postTitle} (renamed ${ctx.iteration})`;
      const r = await win.evaluate((a) => (globalThis as unknown as EditorPage).builder.project.apply({ operations: [{ type: 'entry.update', collectionId: a.collectionId, entryId: a.entryId, title: a.title }] as never }, { label: 'Benchmark rename' }), { ...post, title: renamed });
      expect((r as { ok?: boolean }).ok !== false, `the post could not be renamed: ${JSON.stringify(r).slice(0, 300)}`);
      await ctx.waitTrace((t) => !!t.first('renderer.commit', atRevision(before.revision + 2)), 30_000);
      await win.locator('.rail [data-rail="seo"]').click();
      await win.locator('.seo-view-holder').waitFor({ state: 'visible', timeout: 15_000 });
      const seoTitle = (await win.locator('.seo-view .seo-bar .seo-title').first().textContent())?.trim();
      expect(seoTitle === renamed, `the SEO view, shown again, names ${seoTitle ? `“${seoTitle}”` : 'nothing'}, not the renamed post “${renamed}”`);
      await win.locator('.rail [data-rail="posts"]').click();
      await win.locator('.post-writer-holder').waitFor({ state: 'visible', timeout: 15_000 });
      const written = await writerTitle(win).inputValue();
      expect(written === renamed, `the writer, shown again, holds “${written}”, not the renamed post “${renamed}”`);
    } finally {
      await server.stop();
    }
  },
  measure(trace) {
    const { m, windows } = measureClickThenEdit(trace, 'panelsInUse');
    // The work over the whole site done in each window: every panel that did it is hidden there but the one shown.
    for (const [phase, [from, to]] of Object.entries(windows)) {
      if (!from || !to) continue;
      for (const [metric, name] of Object.entries(SITE_WORK)) {
        if (from.c?.[name] === undefined) m.need(`panelsInUse.${phase}.${metric} (the editor did not count ${name})`, undefined);
        else m.count(`panelsInUse.${phase}.${metric}`, counter(to, name) - counter(from, name));
      }
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

/** The pages `layers` makes and works in, by how many nodes each holds. */
export const LAYERS_SIZES = [300, 1000] as const;
/** The nodes in one of a layers page's sections (see layersPage), and the cards in its row. */
const LAYERS_SECTION = 25;
const LAYERS_CARDS = 4;
/** What a layers page is measured by: clicks on rows, steps of the arrow keys, and edits from a row's eye, each a sample. */
export const LAYERS_KINDS = ['click', 'key', 'edit'] as const;
export type LayersKind = (typeof LAYERS_KINDS)[number];
export const LAYERS_SAMPLES: Record<LayersKind, number> = { click: 7, key: 7, edit: 2 };
/** How long a sample goes on once its change is shown, so the work it set off afterwards (focus, scrolling, effects) is counted. */
const LAYERS_SETTLE_MS = 300;
/** A sample the project's being read again from disk lands in is done again, up to this many times. */
const LAYERS_TRIES = 5;

export interface LayersPage {
  size: number;
  pageId: string;
  title: string;
  /** Each node's parent; null for a section. */
  parents: Map<string, string | null>;
  /** The nodes in outline order: the order Layers lists them in with every branch open. */
  order: string[];
  /** The rows Layers shows hidden in the desktop preview: a section's inner container, hidden at every size, and what it holds. */
  hidden: string[];
  /** What the clicks select, in turn: rows of sections across the page, at every depth. The arrow keys start from the last. */
  clicks: string[];
  /** The section whose row's eye hides it, and then shows it again. */
  hides: string;
  /** The change that makes the page. */
  operations: Array<Record<string, unknown>>;
}

/**
 * A page of `size` nodes as a site's long pages are made: sections, each a container holding a container with a heading,
 * a paragraph and a row of four cards, each card a heading, a paragraph and a button in a stack of its own (25 nodes, 6
 * deep). The second section's inner container is hidden at every size, and the fourth section's first card on phones.
 */
export function layersPage(size: number): LayersPage {
  const sections = size / LAYERS_SECTION;
  if (!Number.isInteger(sections)) throw new Error(`A layers page holds whole sections of ${LAYERS_SECTION} nodes, not ${size}.`);
  const pageId = `pg_layers${size}`;
  const title = `Layers ${size}`;
  const owner = { kind: 'page', id: pageId };
  const operations: Array<Record<string, unknown>> = [{ type: 'page.create', pageId, title, route: `/layers-${size}/` }];
  const parents = new Map<string, string | null>();
  const order: string[] = [];
  const id = (s: number, part: string) => `n_l${size}s${String(s).padStart(2, '0')}${part}`;
  const add = (nodeId: string, parentId: string | null, primitive: string, text?: string) => {
    parents.set(nodeId, parentId);
    order.push(nodeId);
    operations.push({ type: 'node.insert', newNodeId: nodeId, owner, parentId, primitive, ...(text === undefined ? {} : { text }) });
  };
  for (let s = 0; s < sections; s++) {
    add(id(s, 'o'), null, 'container');
    add(id(s, 'i'), id(s, 'o'), 'container');
    add(id(s, 'h'), id(s, 'i'), 'heading', `Section ${s + 1}: what we make for the people we work with`);
    add(id(s, 'p'), id(s, 'i'), 'paragraph', `Every project in section ${s + 1} starts with a conversation about what you need, and ends with something you can use every day.`);
    add(id(s, 'r'), id(s, 'i'), 'row');
    for (let c = 1; c <= LAYERS_CARDS; c++) {
      add(id(s, `c${c}`), id(s, 'r'), 'stack');
      add(id(s, `c${c}h`), id(s, `c${c}`), 'heading', `Card ${c} of section ${s + 1}`);
      add(id(s, `c${c}p`), id(s, `c${c}`), 'paragraph', `A short description of what card ${c} offers, long enough to be cut short in Layers.`);
      add(id(s, `c${c}s`), id(s, `c${c}`), 'stack');
      add(id(s, `c${c}b`), id(s, `c${c}s`), 'button', `Read more about card ${c}`);
    }
  }
  const hide = (nodeId: string, scope: string) => operations.push({ type: 'node.setStyle', owner, nodeId, scope, property: 'hidden', value: true });
  hide(id(1, 'i'), 'base');
  hide(id(3, 'c1'), 'phone');
  const at = (f: number) => Math.min(sections - 1, Math.round(f * sections));
  const from = order.indexOf(id(1, 'i'));
  return {
    size,
    pageId,
    title,
    parents,
    order,
    hidden: order.slice(from, from + LAYERS_SECTION - 1),
    clicks: [id(at(0.15), 'c2b'), id(at(0.9), 'o'), id(at(0.35), 'c3p'), id(at(0.7), 'r'), id(at(0.5), 'c4'), id(at(0.25), 'i'), id(at(0.6), 'o')],
    hides: id(at(0.45), 'o'),
    operations
  };
}

/** A node's containers on its page, nearest first. */
export function layersAncestors(page: LayersPage, nodeId: string): string[] {
  const out: string[] = [];
  for (let p = page.parents.get(nodeId) ?? null; p; p = page.parents.get(p) ?? null) out.push(p);
  return out;
}

/** A node and everything inside it, in outline order. */
function layersSubtree(page: LayersPage, nodeId: string): string[] {
  return page.order.filter((n) => n === nodeId || layersAncestors(page, n).includes(nodeId));
}

/** What Layers shows of a page's rows: their order, and which are selected, hold the selection, or are hidden. */
interface LayersRows {
  /** Every row of the tree, the shared header's and footer's too. */
  all: number;
  closed: number;
  rows: string[];
  selected: string[];
  within: string[];
  hidden: string[];
  hiddenBy: string[];
  focused: string | null;
}

/** Read in the editor's page. Source text, not a function: the scripts' compiler wraps a named function in a helper the
 *  page does not have (see WATCH_FRAMES). */
const LAYERS_ROWS = (owner: string) => `(() => {
  const owner = ${JSON.stringify(owner)};
  const tree = [...document.querySelectorAll('.layers-tree [role="treeitem"]')];
  const out = { all: tree.length, closed: 0, rows: [], selected: [], within: [], hidden: [], hiddenBy: [], focused: null };
  for (const r of tree) {
    if (r.getAttribute('aria-expanded') === 'false') out.closed++;
    if (r.getAttribute('data-owner') !== owner) continue;
    const id = r.dataset.node ?? '';
    out.rows.push(id);
    if (r.getAttribute('aria-selected') === 'true') out.selected.push(id);
    if (r.classList.contains('contains-sel')) out.within.push(id);
    if (r.classList.contains('is-hidden')) out.hidden.push(id);
    if (r.querySelector('.layer-hider')) out.hiddenBy.push(id);
  }
  out.focused = document.activeElement?.closest('.layers-tree [role="treeitem"]')?.dataset.node ?? null;
  return out;
})()`;

async function layersRows(win: Page, pageId: string): Promise<LayersRows> {
  return (await win.evaluate(LAYERS_ROWS(`page:${pageId}`))) as LayersRows;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const listed = (ids: string[]) => (ids.length > 4 ? `${ids.slice(0, 4).join(', ')} and ${ids.length - 4} more` : ids.join(', ') || 'none');

/**
 * Layers shows every layer of the page, in order, with `selected` the one selection, exactly its containers marked as
 * holding it, and exactly `hidden` dimmed as hidden in this preview, the ones a layer above hides saying so.
 */
function checkLayersRows(page: LayersPage, got: LayersRows, selected: string, hidden: string[], what: string) {
  expect(got.rows.length === page.size && got.rows.every((n, i) => n === page.order[i]), `${what}: Layers lists ${got.rows.length} rows of the ${page.title} page, not its ${page.size} layers in order`);
  expect(got.closed === 0, `${what}: ${got.closed} branches of Layers are closed`);
  expect(got.selected.length === 1 && got.selected[0] === selected, `${what}: Layers shows ${listed(got.selected)} selected, not ${selected}`);
  const up = layersAncestors(page, selected);
  expect(sameIds(got.within, up), `${what}: Layers marks ${listed(got.within)} as holding the selection, not its containers ${listed(up)}`);
  expect(sameIds(got.hidden, hidden), `${what}: Layers shows ${got.hidden.length} rows hidden in this preview (${listed(got.hidden)}), not ${hidden.length}`);
  const below = hidden.filter((n) => layersAncestors(page, n).some((a) => hidden.includes(a)));
  expect(sameIds(got.hiddenBy, below), `${what}: ${got.hiddenBy.length} rows say a layer above hides them, not ${below.length}`);
}

/** The editor's marks for one edge of one of `layers`' samples, in one attempt (any attempt without one). */
const atLayersSample =
  (size: number, kind: LayersKind, i: number, edge: 'start' | 'end', attempt?: number) =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.scenario === 'layers' && r.attrs?.size === size && r.attrs?.kind === kind && r.attrs?.i === i && r.attrs?.edge === edge && (attempt === undefined || r.attrs?.attempt === attempt);

/** A sample's window in its last attempt, the one measured. */
export function layersWindow(t: Trace, size: number, kind: LayersKind, i: number): { start?: PerfRecord; end?: PerfRecord } {
  const starts = t.all('layers.sample', atLayersSample(size, kind, i, 'start'));
  if (!starts.length) return {};
  const attempt = Math.max(...starts.map((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0)));
  return { start: starts.find((r) => r.attrs?.attempt === attempt), end: t.first('layers.sample', atLayersSample(size, kind, i, 'end', attempt)) };
}

/**
 * A listener in the editor's page, ahead of the editor's own, that marks each click and arrow key a person makes in
 * Layers at the moment the event happened (`layers.input`), and the end of the first frame painted after it
 * (`layers.painted`: a message posted from the frame's animation callback runs once the frame is drawn). The click
 * that the arrow keys make on the row they reach is the key's, not another input.
 */
const WATCH_LAYERS_INPUT = `(() => {
  if (globalThis.__layersInputWatched) return;
  globalThis.__layersInputWatched = true;
  for (const [type, kind] of [['click', 'click'], ['keydown', 'key']]) {
    document.addEventListener(type, (e) => {
      if (!e.isTrusted || !e.target?.closest?.('.layers-tree')) return;
      if (type === 'keydown' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      globalThis.__siteoriginPerf?.mark('layers.input', { kind }, performance.timeOrigin + e.timeStamp);
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => globalThis.__siteoriginPerf?.mark('layers.painted', { kind });
        ch.port2.postMessage(0);
      });
    }, true);
  }
})()`;
async function watchLayersInput(win: Page) {
  await win.evaluate(WATCH_LAYERS_INPUT);
}

/** Show a sidebar view (its rail button pressed), and wait for it. */
async function showSidebar(win: Page, label: string) {
  const button = win.locator(`.rail [aria-label="${label}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await win.locator('#editor-sidebar').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Every branch of Layers opened, as a person opens them one by one, and the rows they show drawn. */
async function openEveryBranch(win: Page) {
  type Toggle = { click(): void };
  type Doc = { document: { querySelectorAll(s: string): Iterable<{ querySelector(s: string): Toggle | null }> } };
  for (let round = 0; round < 20; round++) {
    const closed = await win.evaluate(() => {
      const rows = [...(globalThis as unknown as Doc).document.querySelectorAll('.layers-tree [role="treeitem"][aria-expanded="false"]')];
      for (const r of rows) r.querySelector('.tree-toggle')?.click();
      return rows.length;
    });
    if (!closed) return;
    await sleep(300);
  }
  throw new PredicateError('Layers still has closed branches after opening every one 20 times');
}

export const layers: Scenario = {
  name: 'layers',
  after: 'open',
  description: 'On pages of 300 and 1,000 layers with every branch open in Layers, click rows, step through them with the arrow keys, and hide a section from its row’s eye and show it again.',
  deadlineMs: 10 * 60_000,
  async run(ctx) {
    const { win } = ctx;
    const editor = () => win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(await editor(), 'no project is open');
    // Not timed: the pages, each made in one change, and the input watch.
    const pages = LAYERS_SIZES.map(layersPage);
    for (const page of pages) {
      const r = await win.evaluate(async (a) => (globalThis as unknown as EditorPage).builder.project.apply({ operations: a.operations as never, label: a.label }), { operations: page.operations, label: `Make ${page.title}` });
      expect(r.ok, `making the ${page.title} page failed: ${r.error?.message ?? 'no reason given'}`);
      await ctx.waitTrace((t) => !!t.first('renderer.commit', atRevision(r.revision)), 30_000);
    }
    await watchLayersInput(win);
    await ctx.mark('scenario.start', { scenario: 'layers' });
    for (const page of pages) {
      const tree = win.locator('.layers-tree');
      const row = (nodeId: string) => tree.locator(`[role="treeitem"][data-node="${nodeId}"]`);
      // Not timed: the page opened from Pages, Layers shown with every branch open, the first section selected.
      await showSidebar(win, 'Pages');
      await win.locator(`.side-panel-view:not([hidden]) [data-page="${page.pageId}"]`).first().click();
      await showSidebar(win, 'Layers');
      await row(page.order[0]).waitFor({ timeout: 30_000 });
      await openEveryBranch(win);
      await row(page.order[0]).locator('.layer-name').click();
      await row(page.order[0]).and(win.locator('[aria-selected="true"]')).waitFor({ timeout: 15_000 });
      let selected = page.order[0];
      let hidden = page.hidden;
      const shown = await layersRows(win, page.pageId);
      checkLayersRows(page, shown, selected, hidden, `${page.title} opened`);
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));

      /**
       * One sample: `act` makes the change, which is done once `done` finds it in the trace; the window then stays open
       * LAYERS_SETTLE_MS more. A window the project's being read from disk, or another project snapshot, lands in (an
       * edit's own is its one) is done again from where it started, `undo` putting that back first.
       */
      const sample = async (kind: LayersKind, i: number, act: () => Promise<void>, done: (t: Trace, from: number) => boolean, undo: () => Promise<void>) => {
        for (let attempt = 1; ; attempt++) {
          const at = { scenario: 'layers', size: page.size, kind, i, attempt };
          await ctx.mark('layers.sample', { ...at, edge: 'start', rows: shown.all });
          await act();
          await ctx.waitTrace((t) => {
            const s = t.first('layers.sample', atLayersSample(page.size, kind, i, 'start', attempt));
            return !!s && done(t, s.t);
          }, 30_000);
          await sleep(LAYERS_SETTLE_MS);
          await ctx.mark('layers.sample', { ...at, edge: 'end' });
          const t = await ctx.waitTrace((x) => !!x.first('layers.sample', atLayersSample(page.size, kind, i, 'end', attempt)), 15_000);
          const s = t.first('layers.sample', atLayersSample(page.size, kind, i, 'start', attempt));
          const e = t.first('layers.sample', atLayersSample(page.size, kind, i, 'end', attempt));
          expect(s && e, `the ${page.title} ${kind} ${i + 1} window was never marked`);
          const snapshots = t.all('renderer.snapshotReceived', inProc('renderer'), s.t, e.t).length;
          if (!t.first('session.reloadFromDisk', inProc('main'), s.t, e.t) && snapshots === (kind === 'edit' ? 1 : 0)) return;
          if (attempt >= LAYERS_TRIES) throw new Error(`the project was read from disk during the ${page.title} ${kind} ${i + 1} ${LAYERS_TRIES} times (its files kept changing on disk)`);
          await undo();
          await sleep(QUIET_MS);
        }
      };
      const selectionShown = (kind: LayersKind) => (t: Trace, from: number) => {
        const input = t.first('layers.input', (r) => r.proc === 'renderer' && r.attrs?.kind === kind, from);
        return !!input && !!t.first('renderer.selectionCommit', (r) => r.proc === 'renderer' && r.attrs?.selected === true, input.t) && !!t.first('layers.painted', (r) => r.proc === 'renderer' && r.attrs?.kind === kind, input.t);
      };
      /** Select a row by a click, untimed, as the way back for a sample done again. */
      const clickRow = async (nodeId: string) => {
        await row(nodeId).locator('.layer-name').click();
        await row(nodeId).and(win.locator('[aria-selected="true"]')).waitFor({ timeout: 15_000 });
        await sleep(LAYERS_SETTLE_MS);
      };

      // Clicks: each row scrolled into view and pointed at first (untimed), then pressed where the pointer is.
      for (const [i, target] of page.clicks.entries()) {
        const from = selected;
        const name = row(target).locator('.layer-name');
        const ready = async () => {
          await name.scrollIntoViewIfNeeded();
          await name.hover();
          await sleep(150);
        };
        await ready();
        await sample(
          'click',
          i,
          async () => {
            await win.mouse.down();
            await win.mouse.up();
          },
          selectionShown('click'),
          async () => {
            await clickRow(from);
            await ready();
          }
        );
        selected = target;
        checkLayersRows(page, await layersRows(win, page.pageId), selected, hidden, `${page.title} click ${i + 1}`);
      }
      // Arrow keys: each step selects the row below the selected one, which keyboard focus follows.
      for (let i = 0; i < LAYERS_SAMPLES.key; i++) {
        const from = selected;
        const next = page.order[page.order.indexOf(from) + 1];
        const focus = (await layersRows(win, page.pageId)).focused;
        expect(focus === from, `keyboard focus is on ${focus ?? 'no row'} of Layers, not the selected ${from}`);
        await sample(
          'key',
          i,
          () => win.keyboard.press('ArrowDown'),
          selectionShown('key'),
          async () => {
            await win.keyboard.press('ArrowUp');
            await row(from).and(win.locator('[aria-selected="true"]')).waitFor({ timeout: 15_000 });
            await sleep(LAYERS_SETTLE_MS);
          }
        );
        selected = next;
        checkLayersRows(page, await layersRows(win, page.pageId), selected, hidden, `${page.title} key ${i + 1}`);
      }
      // Edits: a section hidden at every size from its row's eye, then shown again from the same eye.
      const eye = row(page.hides).locator('.layer-eye');
      const section = layersSubtree(page, page.hides);
      for (let i = 0; i < LAYERS_SAMPLES.edit; i++) {
        const hiding = i % 2 === 0;
        // The row pointed at first (untimed), which shows its eye.
        const ready = async () => {
          await row(page.hides).locator('.layer-name').scrollIntoViewIfNeeded();
          await row(page.hides).locator('.layer-name').hover();
          await sleep(150);
        };
        const revision = (await editor())?.revision ?? NaN;
        await ready();
        await sample(
          'edit',
          i,
          () => eye.click(),
          (t, from) => {
            const req = t.first('edit.requested', inProc('renderer'), from);
            const target = typeof req?.attrs?.revision === 'number' ? req.attrs.revision + 1 : NaN;
            return !!t.first('renderer.commit', (r) => r.proc === 'renderer' && r.attrs?.revision === target, req?.t ?? Infinity);
          },
          async () => {
            // The eye pressed again takes the edit back.
            await eye.click();
            await sleep(1000);
            await ready();
          }
        );
        const after = await editor();
        expect(after && after.revision > revision, `the ${page.title} eye left the project at revision ${after?.revision}, not past ${revision}`);
        const styles = (after.state.pages[page.pageId]?.nodes[page.hides] as { styles?: { base?: { hidden?: unknown } } } | undefined)?.styles;
        expect((styles?.base?.hidden === true) === hiding, `the project ${hiding ? 'does not hide' : 'still hides'} the ${page.title} section the eye ${hiding ? 'hid' : 'showed'}`);
        hidden = hiding ? [...page.hidden, ...section] : page.hidden;
        checkLayersRows(page, await layersRows(win, page.pageId), selected, hidden, `${page.title} ${hiding ? 'hide' : 'show'}`);
      }
    }
    await ctx.mark('scenario.end', { scenario: 'layers' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('layers', 'renderer')) && !!t.first('scenario.end', forScenario('layers', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('layers', 'renderer')));
    const end = m.need('scenario.end (renderer)', trace.first('scenario.end', forScenario('layers', 'renderer')));
    if (!begin || !end) return m;
    const byKind = (kind: string) => (r: PerfRecord) => r.proc === 'renderer' && r.attrs?.kind === kind;
    for (const size of LAYERS_SIZES) {
      const p = `layers.at${size}`;
      let rows: unknown;
      for (const kind of LAYERS_KINDS) {
        const got: Record<string, number[]> = { commitMs: [], paintMs: [], layersMs: [], rowRenders: [], renders: [], layersRenders: [], commits: [], findParent: [], subtreeIds: [] };
        for (let i = 0; i < LAYERS_SAMPLES[kind]; i++) {
          const what = `${p} ${kind} ${i + 1}`;
          const w = layersWindow(trace, size, kind, i);
          const s = m.need(`layers.sample start (${what})`, w.start && w.start.t >= begin.t && w.start.t <= end.t ? w.start : undefined);
          const e = m.need(`layers.sample end (${what})`, w.end);
          if (!s || !e) continue;
          rows ??= s.attrs?.rows;
          if (kind === 'edit') {
            // From the editor receiving the edited project to the commit that shows it.
            const req = m.need(`edit.requested (${what})`, trace.first('edit.requested', inProc('renderer'), s.t, e.t));
            const target = typeof req?.attrs?.revision === 'number' ? req.attrs.revision + 1 : NaN;
            const received = m.need(`renderer.snapshotReceived (${what})`, trace.first('renderer.snapshotReceived', (r) => r.proc === 'renderer' && r.attrs?.revision === target, req?.t ?? Infinity, e.t));
            const committed = m.need(`renderer.commit (${what})`, trace.first('renderer.commit', (r) => r.proc === 'renderer' && r.attrs?.revision === target, received?.t ?? Infinity, e.t));
            if (received && committed) got.commitMs.push(committed.t - received.t);
          } else {
            // From the click or key, as the event happened, to the commit that shows the selection and the frame after it.
            const input = m.need(`layers.input (${what})`, trace.first('layers.input', byKind(kind), s.t, e.t));
            const shown = m.need(`renderer.selectionCommit (${what})`, trace.first('renderer.selectionCommit', (r) => r.proc === 'renderer' && r.attrs?.selected === true, input?.t ?? Infinity, e.t));
            const painted = m.need(`layers.painted (${what})`, trace.first('layers.painted', byKind(kind), input?.t ?? Infinity, e.t));
            if (input && shown) got.commitMs.push(shown.t - input.t);
            if (input && painted) got.paintMs.push(painted.t - input.t);
          }
          // What the editor counted over the window: a counter it never had is missing, never a zero.
          const counted = (name: string, key: string) => {
            if (e.c?.[name] === undefined) return void m.need(`${name} (the editor never counted it)`, undefined);
            got[key].push(counter(e, name) - counter(s, name));
          };
          counted('layers.rows', 'rowRenders');
          counted('panel.layers.renders', 'layersRenders');
          counted('panel.layers.renderMs', 'layersMs');
          counted('react.renders', 'renders');
          counted('react.commits', 'commits');
          counted('tree.findParent', 'findParent');
          counted('tree.subtreeIds', 'subtreeIds');
        }
        const k = `${p}.${kind}`;
        m.ms(`${k}.commitMs`, median(got.commitMs));
        if (kind !== 'edit') m.ms(`${k}.paintMs`, median(got.paintMs));
        m.ms(`${k}.layersMs`, median(got.layersMs));
        for (const name of ['rowRenders', 'layersRenders', 'renders', 'commits', 'findParent', 'subtreeIds']) if (got[name].length) m.count(`${k}.${name}`, median(got[name]));
      }
      if (typeof rows === 'number') m.count(`${p}.rows`, rows);
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

/**
 * The conversations the chat scenario works in, each seeded with earlier turns, keyed by how many messages its log
 * holds while the reply streams (the earlier ones, the request and the reply).
 */
export const CHAT_CASES = [
  { key: 'at6', id: 'c_perfshort', title: 'Benchmark: a short conversation', earlier: 4 },
  { key: 'at100', id: 'c_perflong', title: 'Benchmark: a long conversation', earlier: 98 }
] as const;
export type ChatCaseKey = (typeof CHAT_CASES)[number]['key'];

/** What is typed into the composer, one key at a time, before it is sent. */
export const CHAT_TYPED = 'Which pages still need a hero image, and what would suit each one?';
/** The streamed reply's first and last sentences, which the check finds on screen while it streams and once it ends. */
export const chatReplyFirst = (key: string) => `Here is what I found on your site (${key}).`;
export const chatReplyLast = (key: string) => `That is everything for this question (${key}).`;
/**
 * Sentences from the middle and near the end of the reply, each checked on screen while the run is still going: a
 * reply that showed its start and then stopped taking pieces until its end would pass the first and last checks.
 */
export const CHAT_REPLY_CHECKPOINTS = ['Here is how the pages compare today:', 'If you would like, I can add an image block'];
/** The reply comes in pieces of this many characters, one every CHAT_FRAME_MS, as a model streaming tokens would. */
const CHAT_PIECE = 4;
const CHAT_FRAME_MS = 8;

/** A long answer as a model writes one: paragraphs, a list and a table of Markdown, about 2,400 characters. */
export function chatReply(key: string): string {
  const pages = ['Home', 'About', 'Services', 'Pricing', 'Team', 'Contact', 'Blog', 'Careers'];
  return [
    chatReplyFirst(key),
    '',
    'Most of your pages already open with a strong image, but a few start with text alone. A hero image sets the tone before anyone reads a word, so these are worth fixing first:',
    '',
    ...pages.slice(0, 5).map((p, i) => `${i + 1}. **${p}**: the opening section has a heading and a short paragraph, but no image. A photo of ${['your team at work', 'the studio itself', 'a finished project', 'a happy client', 'the people behind the work'][i]} would suit it, cropped wide so the heading stays readable.`),
    '',
    'Here is how the pages compare today:',
    '',
    '| Page | Hero image | Words above the fold |',
    '| --- | --- | ---: |',
    ...pages.map((p, i) => `| ${p} | ${i < 5 ? 'none' : '`hero-' + p.toLowerCase() + '.jpg`'} | ${40 + i * 7} |`),
    '',
    'A few things to keep in mind as you choose them:',
    '',
    '- Use the same aspect ratio on every page, so the layout does not jump as visitors move around.',
    '- Keep faces and text away from the edges: on a phone the image is cropped to its middle.',
    '- Write alt text that says what the picture shows, not what it is for. "Two designers sketching at a long table" tells a screen reader user far more than "hero image".',
    '- Prefer one strong photo to a slideshow. Most visitors never see the second slide.',
    '',
    'If you would like, I can add an image block to each of those five sections and leave the picture for you to choose from the library. Ask in Edit mode and I will make the change as one step you can undo.',
    '',
    chatReplyLast(key)
  ].join('\n');
}

/** Earlier turns of a conversation, alternating questions answered and edits made, as stored ones are. */
export function chatSeed(c: (typeof CHAT_CASES)[number], fixture: FixtureFacts): Conversation {
  const messages: ChatMessage[] = [];
  const at = (i: number) => new Date(Date.UTC(2026, 0, 5, 9, 0, i * 20)).toISOString();
  const context = { pageId: fixture.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  for (let turn = 0; messages.length < c.earlier; turn++) {
    const ask = turn % 2 === 0;
    const runId = `run_seed${turn}`;
    messages.push({ id: `m_${c.key}u${turn}`, role: 'user', text: ask ? `Question ${turn + 1}: what does the ${['header', 'footer', 'hero', 'pricing table'][turn % 4]} say on the home page, and is it clear enough for a new visitor?` : `Edit ${turn + 1}: make the ${['header', 'footer', 'hero', 'pricing table'][turn % 4]} heading shorter and friendlier.`, time: at(turn * 2), context: { ...context, ...(ask ? { mode: 'ask' as const } : { scope: 'page' as const }) }, runId });
    const summary = ask
      ? `The ${['header', 'footer', 'hero', 'pricing table'][turn % 4]} reads well. It says **what you do** in one line and names the city, which helps local visitors.\n\nTwo small things could help:\n\n- The second sentence repeats the first. Cutting it keeps the focus on the heading.\n- The button says "Learn more". "See our work" tells people where it goes.\n\nNothing on your site was changed.`
      : `Shortened the heading to "Good design, made simple" and kept its style. The rest of the section is as it was.`;
    messages.push({
      id: `m_${c.key}a${turn}`,
      role: 'assistant',
      text: ask ? summary : '',
      time: at(turn * 2 + 1),
      runId,
      model: { provider: 'local', id: 'test-model', label: 'test-model' },
      activities: [
        { id: `a_${turn}_1`, label: 'Read the Home page', status: 'done', tool: 'read_page' },
        { id: `a_${turn}_2`, label: ask ? 'Looked at the section' : 'Changed the heading', status: 'done', tool: ask ? 'read_page' : 'update_selected_props' }
      ],
      result: { status: ask ? 'no-changes' : 'completed', summary, changes: ask ? [] : [{ label: 'Home → Split hero: Heading', pageId: fixture.homePageId, nodeId: fixture.heroId }], validation: [], checks: [], canUndo: false, ...(ask ? { ask: true } : {}) }
    } as ChatMessage);
  }
  return { id: c.id, title: c.title, named: true, createdAt: at(0), messages: messages.slice(0, c.earlier) };
}

/**
 * The editor page's own work so far, as Chromium counts it for the page (CDP `Performance.getMetrics`): layouts and
 * style recalculations with their time, script time and the time of every task on its main thread, in ms. Carried on a
 * window's marks, so work moved out of the editor's spans (a layout left to the next frame) is still counted.
 */
const CHAT_WORK = [
  ['layouts', 'LayoutCount', 'Layouts', 'count'],
  ['layoutMs', 'LayoutDuration', 'LayoutMs', 'ms'],
  ['styles', 'RecalcStyleCount', 'Styles', 'count'],
  ['styleMs', 'RecalcStyleDuration', 'StyleMs', 'ms'],
  ['scriptMs', 'ScriptDuration', 'ScriptMs', 'ms'],
  ['taskMs', 'TaskDuration', 'TaskMs', 'ms']
] as const;

async function pageWork(send: (method: 'Performance.getMetrics') => Promise<{ metrics: Array<{ name: string; value: number }> }>): Promise<PerfAttrs> {
  const { metrics } = await send('Performance.getMetrics');
  const of = new Map(metrics.map((x) => [x.name, x.value]));
  const attrs: PerfAttrs = {};
  for (const [attr, name, , unit] of CHAT_WORK) {
    const v = of.get(name);
    if (typeof v === 'number') attrs[attr] = unit === 'ms' ? v * 1000 : v;
  }
  return attrs;
}

/** The page's work between two marks that carry it; missing when either lacks a figure, never a false zero. */
function pageWorkMetrics(m: Collector, prefix: string, from: PerfRecord, to: PerfRecord) {
  for (const [attr, , suffix, unit] of CHAT_WORK) {
    const a = from.attrs?.[attr];
    const b = to.attrs?.[attr];
    if (typeof a !== 'number' || typeof b !== 'number') m.need(`${prefix}${suffix} (the page's ${attr} on both marks)`, undefined);
    else if (unit === 'ms') m.ms(`${prefix}${suffix}`, b - a);
    else m.count(`${prefix}${suffix}`, b - a);
  }
}

/** The chat panel's log, its composer and the button that lists earlier conversations. */
const chatLog = (win: Page) => win.locator('.chat-log');
const composer = (win: Page) => win.getByRole('textbox', { name: 'Message', exact: true });

export const chat: Scenario = {
  name: 'chat',
  after: 'open',
  description: 'In the AI panel, type a question and stream a long answer to it, in a conversation of 6 messages and in one of 100.',
  async run(ctx) {
    const { win, fixture } = ctx;
    const server = await new MockOpenAIServer().start();
    // The editor page's own work, read over each window (CHAT_WORK).
    let cdp: CDPSession | undefined;
    try {
      // The scripted model, in native tool mode so its text streams as it comes; untimed, as are the seeded
      // conversations (stored where the app keeps them, a folder it does not watch) and the reload that takes the setting.
      await win.evaluate((url) => (globalThis as unknown as EditorPage).builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: url, allowRemote: false, toolMode: 'native', contextWindow: 131_072 } } } as never), server.baseURL);
      const chatDir = join(ctx.projectDir, '.siteorigin', 'sessions', 'chat');
      mkdirSync(chatDir, { recursive: true });
      for (const c of CHAT_CASES) writeFileSync(join(chatDir, `${c.id}.json`), JSON.stringify(chatSeed(c, fixture)));
      await win.reload();
      await win.locator('.editor').waitFor({ timeout: 60_000 });
      await preview(win).locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60_000 });
      await win.locator('.dock-tab', { hasText: 'AI' }).first().click();
      await composer(win).waitFor({ timeout: 15_000 });
      cdp = await win.context().newCDPSession(win);
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
      const session = cdp;
      const work = () => pageWork((method) => session.send(method));
      await ctx.mark('scenario.start', { scenario: 'chat' });
      for (const c of CHAT_CASES) {
        // Open the conversation from Earlier conversations, as a person does, and ask rather than edit.
        await win.getByRole('button', { name: 'Earlier conversations', exact: true }).click();
        await win.getByRole('menuitemradio', { name: new RegExp(`^${c.title}`) }).or(win.getByRole('menuitem', { name: new RegExp(`^${c.title}`) })).first().click();
        await win.waitForFunction((n) => [...(globalThis as unknown as DomPage).document.querySelectorAll('.chat-log [data-message-id]')].length === n, c.earlier, { timeout: 30_000 });
        const mode = win.getByRole('button', { name: /^What your next message does: Edit/ });
        if (await mode.count()) {
          await mode.first().click();
          await win.getByRole('menuitemradio', { name: /^Ask/ }).click();
        }
        expect((await composer(win).getAttribute('placeholder')) === 'What would you like to know?', 'the composer is not asking a question');
        await composer(win).click();
        // Opening a conversation and choosing the mode save the workspace 300 ms later: that lands before typing starts.
        await sleep(WORKSPACE_SAVE_WAIT_MS);
        await ctx.mark('chat.typeStart', { at: c.key, ...(await work()) });
        await win.keyboard.type(CHAT_TYPED);
        const typedWork = await work();
        expect((await composer(win).inputValue()) === CHAT_TYPED, 'the composer does not hold what was typed');
        await ctx.mark('chat.typeEnd', { at: c.key, ...typedWork });
        const reply = chatReply(c.key);
        server.script(textReply(reply, { size: CHAT_PIECE, frameMs: CHAT_FRAME_MS }));
        await ctx.mark('chat.streamStart', { at: c.key, ...(await work()) });
        await win.keyboard.press('Enter');
        // The reply shows as it streams: its first sentence, then one from the middle and one near the end, each on
        // screen while the run is still going and before its last sentence has arrived.
        const last = chatReplyLast(c.key);
        for (const part of [chatReplyFirst(c.key), ...CHAT_REPLY_CHECKPOINTS]) {
          const streaming = await win
            .waitForFunction(
              ({ part, last }) => {
                const doc = (globalThis as unknown as DomPage).document;
                const t = [...doc.querySelectorAll('.chat-log .msg-ai')].at(-1)?.textContent ?? '';
                return !!doc.querySelector('.run-strip') && t.includes(part) && !t.includes(last);
              },
              { part, last },
              { timeout: 30_000, polling: 'raf' }
            )
            .then(
              () => true,
              () => false
            );
          expect(streaming, `the reply was not shown as it streamed: “${part}” was not on screen before it ended`);
        }
        await win.waitForFunction(
          ({ last }) => {
            const doc = (globalThis as unknown as DomPage).document;
            return !doc.querySelector('.run-strip') && ([...doc.querySelectorAll('.chat-log .msg-ai')].at(-1)?.querySelector('.reply-text')?.textContent ?? '').includes(last);
          },
          { last },
          { timeout: 60_000 }
        );
        const shown = await chatLog(win).locator('[data-message-id]').count();
        expect(shown === c.earlier + 2, `the conversation shows ${shown} messages, not ${c.earlier + 2}`);
        expect((await composer(win).inputValue()) === '', 'the composer still holds the sent message');
        // The finished turn is saved with the conversation: the request as typed, the answer whole.
        const file = join(chatDir, `${c.id}.json`);
        const saved = async () => {
          const end = Date.now() + 15_000;
          for (;;) {
            const conv = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Conversation) : null;
            if ((conv && conv.messages.length === c.earlier + 2) || Date.now() >= end) return conv;
            await sleep(100);
          }
        };
        const conv = await saved();
        expect(conv?.messages.length === c.earlier + 2, `the conversation was saved with ${conv?.messages.length} messages, not ${c.earlier + 2}`);
        expect(conv.id === c.id && conv.messages.slice(0, c.earlier).every((m, i) => m.id === `m_${c.key}${i % 2 ? 'a' : 'u'}${i >> 1}`), 'the conversation was saved without its earlier messages');
        const [asked, answered] = conv.messages.slice(-2);
        expect(asked.role === 'user' && asked.text === CHAT_TYPED, 'the saved request is not what was typed');
        expect(answered.role === 'assistant' && answered.result?.summary.trim() === reply.trim() && answered.text.trim() === reply.trim(), 'the saved answer is not the reply that streamed');
        const ids = await chatLog(win).locator('[data-message-id]').evaluateAll((els) => els.slice(-2).map((el) => (el as unknown as { dataset: Record<string, string | undefined> }).dataset.messageId));
        expect(ids[0] === asked.id && ids[1] === answered.id, 'the log does not show the request and answer that were saved');
        await sleep(ctx.settleMs);
        await ctx.mark('chat.streamEnd', { at: c.key, ...(await work()) });
      }
      await ctx.mark('scenario.end', { scenario: 'chat' });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('chat', 'renderer')) && !!t.first('scenario.end', forScenario('chat', 'main')));
    } finally {
      await cdp?.detach().catch(() => undefined);
      await server.stop();
    }
  },
  measure(trace) {
    const m = new Collector();
    for (const c of CHAT_CASES) {
      const mark = (name: string, proc: 'main' | 'renderer') => m.need(`${name} (${c.key}, ${proc})`, trace.first(name, (r) => r.proc === proc && r.attrs?.at === c.key));
      const p = `chat.${c.key}`;
      // Typing: every keystroke's update, React's render and commit included; what rendered while it was typed.
      const typeStart = mark('chat.typeStart', 'renderer');
      const typeEnd = mark('chat.typeEnd', 'renderer');
      if (typeStart && typeEnd) {
        const keys = trace.all('chat.keystroke', inProc('renderer'), typeStart.t, typeEnd.t);
        // One span per key typed: fewer is a trace that lost some, never a faster run.
        if (keys.length !== CHAT_TYPED.length) m.need(`chat.keystroke spans (${c.key}: ${keys.length} of ${CHAT_TYPED.length})`, undefined);
        else {
          m.count(`${p}.keystrokes`, keys.length);
          m.ms(`${p}.keyMs`, median(keys.map((k) => k.ms ?? NaN)));
        }
        commits(m, trace, `${p}.keyCommits`, typeStart, typeEnd);
        m.count(`${p}.keyMessageRenders`, counter(typeEnd, 'chat.messageRenders') - counter(typeStart, 'chat.messageRenders'));
        m.count(`${p}.keyTextParses`, counter(typeEnd, 'chat.textParses') - counter(typeStart, 'chat.textParses'));
        m.count(`${p}.keyRenders`, counter(typeEnd, 'react.renders') - counter(typeStart, 'react.renders'));
        pageWorkMetrics(m, `${p}.key`, typeStart, typeEnd);
      }
      // Streaming: what main sent for the reply, and what the editor did with each event.
      const mainStart = mark('chat.streamStart', 'main');
      const mainEnd = mark('chat.streamEnd', 'main');
      const sent = mainStart && mainEnd ? counter(mainEnd, 'ipc.aiEvent.sends') - counter(mainStart, 'ipc.aiEvent.sends') : NaN;
      if (mainStart && mainEnd) {
        m.count(`${p}.events`, sent);
        if (counter(mainEnd, 'ipc.aiEvent.unsized') !== counter(mainStart, 'ipc.aiEvent.unsized')) m.need(`${p}.eventBytes (an event whose size could not be told)`, undefined);
        else m.count(`${p}.eventBytes`, counter(mainEnd, 'ipc.aiEvent.bytes') - counter(mainStart, 'ipc.aiEvent.bytes'), 'bytes');
        m.ms(`${p}.mainStallMax`, stallMax(trace, mainStart, mainEnd));
      }
      const streamStart = mark('chat.streamStart', 'renderer');
      const streamEnd = mark('chat.streamEnd', 'renderer');
      if (streamStart && streamEnd) {
        const events = trace.all('chat.aiEvent', inProc('renderer'), streamStart.t, streamEnd.t);
        // The editor handles every event main sent for the reply: fewer is a trace that lost some.
        if (!events.length || (Number.isFinite(sent) && events.length !== sent)) m.need(`chat.aiEvent spans (${c.key}: ${events.length} of ${sent} sent)`, undefined);
        else {
          m.count(`${p}.eventsHandled`, events.length);
          m.ms(`${p}.eventMs`, median(events.map((e) => e.ms ?? NaN)));
          m.ms(`${p}.eventMsTotal`, events.reduce((n, e) => n + (e.ms ?? NaN), 0));
          // Until the editor had handled the reply's last event.
          m.ms(`${p}.replyMs`, events.at(-1)!.t - streamStart.t);
        }
        commits(m, trace, `${p}.streamCommits`, streamStart, streamEnd);
        m.count(`${p}.streamMessageRenders`, counter(streamEnd, 'chat.messageRenders') - counter(streamStart, 'chat.messageRenders'));
        m.count(`${p}.streamTextParses`, counter(streamEnd, 'chat.textParses') - counter(streamStart, 'chat.textParses'));
        m.count(`${p}.streamRenders`, counter(streamEnd, 'react.renders') - counter(streamStart, 'react.renders'));
        pageWorkMetrics(m, `${p}.stream`, streamStart, streamEnd);
      }
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// aiEdit
// ---------------------------------------------------------------------------

/**
 * Two requests that change the site, one after the other: the first after the project opened, the second with nothing
 * changed since the first ended. Each asks the scripted model to change the selected home hero's Heading, which it
 * does with one tool call before it finishes.
 */
export const AI_EDIT_CASES = [
  { key: 'first', heading: 'Assistant heading one', done: 'Changed the hero heading to the first one.' },
  { key: 'second', heading: 'Assistant heading two', done: 'Changed the hero heading to the second one.' }
] as const;

/** The model turns each request takes: the edit, then the finish. */
const AI_EDIT_TURNS = 2;

/** The Svelte files the website has for `state`, by path: every one a build check looks at, whether it compiles it again or not. */
const svelteFiles = (state: ProjectState) => new Map([...generateProject(state, { instrument: false })].filter(([p]) => p.endsWith('.svelte')));

/** The composer's scope chip, inside `win.waitForFunction`. */
type ScopeChip = DomElement & { getAttribute(name: string): string | null };

export const aiEdit: Scenario = {
  name: 'aiEdit',
  after: 'open',
  description: 'In the AI panel, with the home hero selected, ask twice for its Heading to change, the scripted model doing it each time.',
  async run(ctx) {
    const { win, fixture } = ctx;
    const server = await new MockOpenAIServer().start();
    try {
      // The scripted model, answering as the driver's does (constrained JSON); untimed, with the reload that takes it.
      await win.evaluate((url) => (globalThis as unknown as EditorPage).builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: url, allowRemote: false, toolMode: 'constrained-json', contextWindow: 131_072 } } } as never), server.baseURL);
      await win.reload();
      await win.locator('.editor').waitFor({ timeout: 60_000 });
      await preview(win).locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60_000 });
      // The hero is what each request is about: selected in Layers, as a person picks it.
      await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
      await win.getByRole('treeitem', { name: HERO_NAME }).first().click();
      await win.locator('.dock-tab', { hasText: 'AI' }).first().click();
      await composer(win).waitFor({ timeout: 15_000 });
      const mode = win.getByRole('button', { name: /^What your next message does: Ask/ });
      if (await mode.count()) {
        await mode.first().click();
        await win.getByRole('menuitemradio', { name: /^Edit/ }).click();
      }
      const about = await win
        .waitForFunction(
          (name) => {
            const chip = (globalThis as unknown as DomPage).document.querySelector('.composer .scope-chip') as ScopeChip | null;
            return `${chip?.getAttribute('aria-label') ?? ''} ${chip?.textContent ?? ''}`.includes(name);
          },
          HERO_NAME,
          { timeout: 15_000 }
        )
        .then(
          () => true,
          () => false
        );
      expect(about, `the composer is not about the selected ${HERO_NAME}`);
      // Choosing the panel, the selection and the mode save the workspace 300 ms later: that lands before the first request.
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      await ctx.mark('scenario.start', { scenario: 'aiEdit' });
      const posts = () => server.requests.filter((r) => r.method === 'POST');
      for (const c of AI_EDIT_CASES) {
        const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
        expect(before, 'no project is open');
        const asked = posts().length;
        server.script(envelopeReply('update_selected_props', { props: { heading: c.heading } }, 'Changing the heading'), envelopeReply('finish', { message: c.done }));
        await composer(win).fill(`Make the hero heading say “${c.heading}”`);
        await ctx.mark('aiEdit.send', { at: c.key });
        await composer(win).press('Enter');
        // The run is over once the strip has gone and the reply says what it did.
        await win.waitForFunction(
          (done) => {
            const doc = (globalThis as unknown as DomPage).document;
            return !doc.querySelector('.run-strip') && ([...doc.querySelectorAll('.chat-log .msg-ai')].at(-1)?.textContent ?? '').includes(done);
          },
          c.done,
          { timeout: 120_000 }
        );
        // Every model turn was about the selected hero, and there were as many as the script has.
        const sent = posts().slice(asked);
        expect(sent.length === AI_EDIT_TURNS, `the request took ${sent.length} model turns, not ${AI_EDIT_TURNS}`);
        expect(JSON.stringify(sent[0].body).includes(fixture.heroId), 'the request did not name the selected hero to the model');
        // The run finished as a completed change whose checks, the build's among them, passed.
        const { active } = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.ai.conversations());
        const reply = active.messages.at(-1);
        expect(reply?.role === 'assistant' && reply.result?.status === 'completed', `the request ended ${reply?.result?.status ?? 'without a result'}, not completed`);
        const checks = reply.result!.checks ?? [];
        expect(reply.result!.summary.includes(c.done), 'the reply is not the scripted model’s summary');
        expect(checks.some((k) => k.status === 'pass' && /build/.test(k.text)), 'the result does not say the build was checked');
        expect(!checks.some((k) => k.status !== 'pass' && /build/.test(k.text)), 'the result reports a build problem');
        // The change is in the project, on disk and in the preview.
        await preview(win).getByRole('heading', { name: c.heading, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
        const after = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
        expect(after && after.revision > before.revision, `the request left the project at revision ${after?.revision}, from ${before.revision}`);
        expect(findHeading(after.state.pages[fixture.homePageId], fixture.heroId)?.heading === c.heading, 'the project does not hold the new heading on the home hero');
        const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
        const saved = existsSync(doc) ? (JSON.parse(readFileSync(doc, 'utf8')) as unknown) : null;
        expect(findHeading(saved, fixture.heroId)?.heading === c.heading, 'the home page’s document on disk does not hold the new heading on the home hero');
        await sleep(ctx.settleMs);
        await ctx.mark('aiEdit.end', { at: c.key });
        // Every build check of the run looked at every Svelte file the website has, before the change and after it,
        // and those after the change compiled, both ways, at least every file it changed (an outcome kept from
        // before the change would be stale).
        const was = svelteFiles(before.state);
        const now = svelteFiles(after.state);
        const files = now.size;
        expect(was.size === files && [...now.keys()].every((p) => was.has(p)), 'the change added or removed a Svelte file');
        const changed = [...now].filter(([p, source]) => was.get(p) !== source).length;
        expect(changed > 0, 'the change changed no Svelte file');
        const atKey = (r: PerfRecord) => r.proc === 'main' && r.attrs?.at === c.key;
        const t = await ctx.waitTrace((t) => !!t.first('aiEdit.end', atKey));
        const from = t.first('aiEdit.send', atKey)?.t ?? Infinity;
        const builds = t.all('ai.compile', inProc('main'), from, t.first('aiEdit.end', atKey)?.t);
        expect(builds.length >= 2, `the request checked the build ${builds.length} times, not before and after its change`);
        for (const b of builds) expect(delta(b, 'compile.files') === files, `a build check looked at ${delta(b, 'compile.files')} of the website's ${files} Svelte files`);
        const compiledAfter = builds.slice(1).reduce((n, b) => n + delta(b, 'compile.svelte'), 0);
        expect(compiledAfter >= 2 * changed, `the checks after the change compiled ${compiledAfter} times, fewer than both builds of the ${changed} Svelte files it changed`);
      }
      await ctx.mark('scenario.end', { scenario: 'aiEdit' });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('aiEdit', 'renderer')) && !!t.first('scenario.end', forScenario('aiEdit', 'main')));
    } finally {
      await server.stop();
    }
  },
  measure(trace) {
    const m = new Collector();
    for (const c of AI_EDIT_CASES) {
      const p = `aiEdit.${c.key}`;
      const begin = m.need(`aiEdit.send (${c.key}, main)`, trace.first('aiEdit.send', (r) => r.proc === 'main' && r.attrs?.at === c.key));
      const end = m.need(`aiEdit.end (${c.key}, main)`, trace.first('aiEdit.end', (r) => r.proc === 'main' && r.attrs?.at === c.key));
      if (!begin || !end) continue;
      const within = (name: string, from: number) => m.need(`${name} (${c.key})`, trace.first(name, inProc('main'), from, end.t));
      const sent = within('ai.send', begin.t);
      if (!sent) continue;
      const runEnd = within('ai.runEnd', sent.t);
      const model = within('ai.modelRequest', sent.t);
      const adapter = within('ai.adapterReady', sent.t);
      if (!runEnd || !model || !adapter) continue;
      // The compile before the first model turn is the run's starting build; those after it, its checks.
      const compiles = trace.all('ai.compile', inProc('main'), sent.t, runEnd.t);
      const startCompile = m.need(`ai.compile before the first model turn (${c.key})`, compiles.find((r) => r.t <= model.t));
      const checks = compiles.filter((r) => r.t > model.t);
      if (!checks.length) m.need(`ai.compile after the first model turn (${c.key})`, undefined);
      // Send to the first model turn, in its phases: the adapter prepared, the run set up (the project taken), the
      // starting build, and the request put together after it.
      m.since(`${p}.toModel`, sent, model);
      m.since(`${p}.toAdapter`, sent, adapter);
      if (startCompile) {
        m.ms(`${p}.toCompile`, startCompile.t - (startCompile.ms ?? NaN) - adapter.t);
        m.span(`${p}.startCompile`, startCompile);
        m.ms(`${p}.compileToModel`, model.t - startCompile.t);
        m.count(`${p}.startFiles`, delta(startCompile, 'compile.files'));
        m.count(`${p}.startCompiled`, delta(startCompile, 'compile.svelte'));
      }
      m.ms(`${p}.checkCompile`, checks.reduce((n, r) => n + (r.ms ?? NaN), 0));
      m.count(`${p}.checkCompiled`, checks.reduce((n, r) => n + delta(r, 'compile.svelte'), 0));
      m.count(`${p}.compiles`, compiles.length);
      m.count(`${p}.modelTurns`, trace.all('ai.modelRequest', inProc('main'), sent.t, runEnd.t).length);
      m.since(`${p}.runMs`, sent, runEnd);
      m.ms(`${p}.mainStallMax`, stallMax(trace, sent, runEnd));
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// export, exportAgain
// ---------------------------------------------------------------------------

/** Every file under `dir`, as paths relative to it with forward slashes. */
function filesUnder(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, rel) : e.isFile() ? [rel] : [];
  });
}

/** Text as an HTML page shows it, for the few character references Svelte writes. */
const htmlText = (html: string) => html.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Markup and code only the editor's preview carries (controller.ts's own checks look for the same). */
const EDITOR_ONLY = /data-so-(ctx|node|part)|siteorigin-bridge/;

/** A span's start, on the trace's clock. */
const startOf = (r: PerfRecord | undefined) => (r && typeof r.ms === 'number' ? r.t - r.ms : undefined);

/**
 * Export the website as a folder from the Export dialog, as a person does: open the dialog, choose Website files, pick
 * a folder (the chooser answered through the driver), and wait for the dialog to say what it exported. `exportAgain`
 * does it once more with nothing changed, into a second folder beside the first.
 */
function exportScenario(name: 'export' | 'exportAgain', after: 'open' | 'export'): Scenario {
  return {
    name,
    after,
    description: after === 'open' ? 'Export the website as a folder from the Export dialog, to the dialog saying it is done.' : 'Export the website again with nothing changed, into a second folder.',
    async run(ctx) {
      const { win, app, fixture } = ctx;
      const parent = join(dirname(ctx.projectDir), 'exports');
      if (name === 'export') {
        rmSync(parent, { recursive: true, force: true });
        mkdirSync(parent, { recursive: true });
      }
      const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
      expect(before, 'no project is open');
      const earlier = new Set(before.recentExports.map((e) => e.path));
      await win.getByRole('button', { name: 'Export', exact: true }).first().click();
      const modal = win.locator('.modal');
      const card = modal.getByRole('button', { name: /Website files, ready to upload/ });
      await card.waitFor({ timeout: 30_000 });
      for (let end = Date.now() + 30_000; (await card.getAttribute('aria-disabled')) === 'true'; ) {
        expect(Date.now() < end, 'the Website files card never became available');
        await sleep(100);
      }
      const answer: DesktopCall = { op: 'setAnswers', answers: [{ dialog: 'open', selection: 'folder', paths: [parent] }], request: null };
      const set = (await app.evaluate(desktopInMain, answer)) as { error?: string };
      if (set.error) throw new Error(`The folder chooser could not be answered: ${set.error}`);
      // Opening the dialog may set off a workspace save: it lands before the export starts, not in it.
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      await ctx.mark('scenario.start', { scenario: name });
      await card.click();
      // The dialog's result: a status when the export finished, an alert when it stopped.
      const result = modal.locator('.export-result');
      await result.first().waitFor({ timeout: SCENARIO_EXPORT_MS });
      const said = (await result.first().innerText()).trim();
      expect((await result.first().getAttribute('role')) === 'status' && said.startsWith(`Exported ${fixture.pages} pages`), `the export did not finish: ${said.split('\n')[0]}`);
      if (fixture.entries) expect(said.includes(`${fixture.entries} entries`), `the export did not publish the fixture's ${fixture.entries} entries: ${said.split('\n')[0]}`);
      const after = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
      expect(after, 'no project is open');
      const made = after.recentExports[0];
      expect(made && !earlier.has(made.path) && dirname(made.path) === parent, 'the export was not listed as a new folder in the chosen place');
      expect(made.kind === 'site' && made.format === 'folder', `the export listed is a ${made.kind} ${made.format}, not a website folder`);
      // Made from the revision it started on (recording the addresses it published may move the project on after).
      expect(made.revision === before.revision, `the export was made from revision ${made.revision}, not the ${before.revision} it started on`);
      // The website, on disk: every page and entry, the home page's hero, and nothing of the editor's.
      expect(existsSync(made.path), 'the exported folder is not there');
      const files = filesUnder(made.path);
      const pagesBuilt = files.filter((f) => f === 'index.html' || f.endsWith('/index.html')).length;
      expect(pagesBuilt >= fixture.pages + fixture.entries, `the website has ${pagesBuilt} pages, fewer than the fixture's ${fixture.pages} pages and ${fixture.entries} entries`);
      const home = join(made.path, 'index.html');
      expect(existsSync(home) && htmlText(readFileSync(home, 'utf8')).includes(fixture.heading), 'the exported home page does not show the home hero’s heading');
      let bytes = 0;
      for (const f of files) {
        expect(!/(^|\/)(node_modules|\.siteorigin|\.svelte-kit)(\/|$)/.test(f), `the website carries ${f}`);
        const body = readFileSync(join(made.path, f));
        bytes += body.length;
        if (/\.(html|js)$/.test(f)) expect(!EDITOR_ONLY.test(body.toString('utf8')), `the website carries editor-only markup in ${f}`);
      }
      await ctx.mark('export.output', { scenario: name, files: files.length, bytes });
      await sleep(ctx.settleMs);
      await ctx.mark('scenario.end', { scenario: name });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario(name, 'renderer')) && !!t.first('scenario.end', forScenario(name, 'main')));
      // The dialog closed, as a person leaves it, so a scenario after this one starts from the editor.
      await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
      await modal.waitFor({ state: 'detached', timeout: 15_000 });
    },
    measure(trace) {
      const m = new Collector();
      const begin = m.need('scenario.start (main)', trace.first('scenario.start', forScenario(name, 'main')));
      const end = m.need('scenario.end (main)', trace.first('scenario.end', forScenario(name, 'main'), begin?.t));
      // This scenario's own export: never the one before or after it in the chain.
      const total = m.need('controller.exportStatic', trace.first('controller.exportStatic', inProc('main'), begin?.t ?? Infinity, end?.t ?? -Infinity));
      const from = startOf(total) ?? Infinity;
      const to = total?.t ?? -Infinity;
      const span = (n: string) => m.need(n, trace.first(n, inProc('main'), from, to));
      const stage = span('export.stage');
      const lock = span('export.lockHeld');
      const tools = span('export.copyTools');
      const build = span('export.build');
      const publish = span('export.publish');
      const cleanup = span('export.cleanup');
      const gap = (metric: string, a: PerfRecord | undefined, b: PerfRecord | undefined) => {
        const start = startOf(b);
        if (a && start !== undefined) m.ms(metric, start - a.t);
      };
      m.span(`${name}.total`, total);
      // Staging: the site's icons, then the snapshot taken under the writer lock, while no edit can land.
      m.span(`${name}.stage`, stage);
      m.span(`${name}.lockHeld`, lock);
      // The checks and asset passes on the staged copy, from the snapshot to copying the website tools.
      gap(`${name}.assets`, stage, tools);
      m.span(`${name}.copyTools`, tools);
      m.span(`${name}.build`, build);
      // The built website's checks: its pages, its scripts, and its images cleaned again.
      gap(`${name}.verify`, build, publish);
      m.span(`${name}.publish`, publish);
      // Recording the export and starting its preview.
      gap(`${name}.finish`, publish, cleanup);
      m.span(`${name}.cleanup`, cleanup);
      m.count(`${name}.filesRead`, delta(total, 'export.filesRead'));
      m.count(`${name}.bytesRead`, delta(total, 'export.bytesRead'), 'bytes');
      m.count(`${name}.lockFilesRead`, delta(lock, 'export.filesRead'));
      m.count(`${name}.lockBytesRead`, delta(lock, 'export.bytesRead'), 'bytes');
      m.count(`${name}.fileWrites`, delta(total, 'fs.writes'));
      const library = m.need('export.library', trace.first('export.library', inProc('main'), from, to));
      if (library) {
        m.count(`${name}.libraryFiles`, Number(library.attrs?.files));
        m.count(`${name}.libraryBytes`, Number(library.attrs?.bytes), 'bytes');
      }
      const output = m.need('export.output', trace.first('export.output', forScenario(name, 'main'), to, end?.t));
      if (output) {
        m.count(`${name}.outputFiles`, Number(output.attrs?.files));
        m.count(`${name}.outputBytes`, Number(output.attrs?.bytes), 'bytes');
      }
      m.ms(`${name}.mainStallMax`, total ? Math.max(0, ...trace.all('main.stall', inProc('main'), from, to).map((r) => r.ms ?? 0)) : undefined);
      return m;
    }
  };
}

/** How long one export may take before the scenario stops waiting for the dialog to say it is done. */
const SCENARIO_EXPORT_MS = 280_000;

export const exportSite = exportScenario('export', 'open');
export const exportAgain = exportScenario('exportAgain', 'export');

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

/** How many edits `memory` makes to the home hero's Heading; `edits` growth is what the 2nd to the last left behind. */
export const MEMORY_EDITS = 50;
/** The readings `memory` takes, in order, and their kinds. */
export const MEMORY_READINGS = [
  ['welcome', 'rest'],
  ['open', 'peak'],
  ['canvas', 'rest'],
  ['edit1', 'rest'],
  [`edit${MEMORY_EDITS}`, 'rest'],
  ['closed', 'rest']
] as const;
/** How long after the project has closed `closed` is read: always the same age, so a build that lets go of a process
 *  later than another shows it (Chromium ends the preview frame's renderer some 10 s after the frame goes). */
export const CLOSED_AFTER_MS = 20_000;
/** How long `memory` leaves the app after each edit is applied: past the file watcher's look at the save (400 ms
 *  after it), so the next edit never lands in the middle of it. */
export const EDIT_PACE_MS = 600;

type Snapshot = Awaited<ReturnType<BuilderApi['project']['snapshot']>>;
const snapshotOf = (win: Page): Promise<Snapshot> => win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());

export const memory: Scenario = {
  name: 'memory',
  after: 'launch',
  memory: true,
  deadlineMs: 15 * 60_000,
  description: `The memory of every process of the app at rest on a fresh Welcome, with the fixture open on the canvas, after 1 and ${MEMORY_EDITS} edits of the home hero's Heading, and back on Welcome once the project is closed; and its peak while the fixture opens.`,
  async run(ctx) {
    const { win, fixture } = ctx;
    const probe = ctx.memory;
    if (!probe) throw new Error('the memory scenario was run without a memory probe');
    await probe.rest('welcome');
    // Opened as `open` opens it, after the files have settled, to the canvas reporting the home page ready to edit;
    // not timed, and sampled throughout for its peak.
    const wait = ctx.restoredAt + FILES_SETTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    await probe.peak('open', async () => {
      await openFromWelcome(ctx);
      const ready = (t: Trace) => {
        const asked = t.first('open.requested', inProc('renderer'));
        return asked ? t.first('canvas.ready', homeReady(fixture), asked.t) : undefined;
      };
      expect(ready(await ctx.waitTrace((t) => !!ready(t), 15_000)), 'the canvas never reported the home page ready to edit');
    });
    await checkOpened(ctx);
    await probe.rest('canvas');
    const before = await snapshotOf(win);
    expect(before, 'no project is open');
    // The hero chosen in Layers and its Heading shown in the Inspector once; each edit is one commit of that field.
    await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
    await win.getByRole('treeitem', { name: HERO_NAME }).first().click();
    await win.getByRole('tab', { name: 'Inspector', exact: true }).first().click();
    const field = win.getByRole('textbox', { name: 'Heading', exact: true }).first();
    await field.waitFor({ timeout: 15_000 });
    const heading = (i: number) => `Memory heading ${ctx.iteration}.${i}`;
    /** The canvas reporting the edit `n` applied: the preview can show a heading before its bridge says so. */
    const applied = async (n: number) => {
      // Applied in place, or by a full reload of the preview, whose new page reports itself ready at that revision.
      const shown = (x: Trace) => x.first('canvas.revisionApplied', atRevision(before.revision + n)) ?? x.first('canvas.ready', (r) => homeReady(fixture)(r) && r.attrs?.revision === before.revision + n);
      expect(shown(await ctx.waitTrace((x) => !!shown(x), 30_000)), `the canvas never reported edit ${n} applied`);
    };
    for (let i = 1; i <= MEMORY_EDITS; i++) {
      await field.fill(heading(i));
      await win.keyboard.press('Tab');
      await preview(win).getByRole('heading', { name: heading(i), exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
      await applied(i);
      if (i === 1) await probe.rest('edit1');
      else await sleep(EDIT_PACE_MS);
    }
    const after = await snapshotOf(win);
    expect(after && after.revision === before.revision + MEMORY_EDITS, `the edits left the project at revision ${after?.revision}, not ${before.revision + MEMORY_EDITS}`);
    expect(findHeading(after.state.pages[fixture.homePageId], fixture.heroId)?.heading === heading(MEMORY_EDITS), 'the project does not hold the last heading on the home hero');
    const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
    const saved = existsSync(doc) ? (JSON.parse(readFileSync(doc, 'utf8')) as unknown) : null;
    expect(findHeading(saved, fixture.heroId)?.heading === heading(MEMORY_EDITS), 'the home page’s document on disk does not hold the last heading on the home hero');
    await probe.rest(`edit${MEMORY_EDITS}`);
    const closed = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.projects.close());
    expect(closed.ok, 'the project did not close');
    await win.locator('.welcome').waitFor({ timeout: 60_000 });
    expect((await snapshotOf(win)) === null, 'a project is still open after it was closed');
    await sleep(CLOSED_AFTER_MS);
    await probe.rest('closed');
  },
  measure(_trace, _fixture, readings = []) {
    const m = new Collector();
    const reading = (label: string, kind: 'rest' | 'peak' = 'rest') => readings.find((r) => r.label === label && r.kind === kind);
    for (const [label, kind] of MEMORY_READINGS) readingMetrics(m, label, reading(label, kind));
    growthMetrics(m, 'edits', reading('edit1'), reading(`edit${MEMORY_EDITS}`));
    growthMetrics(m, 'close', reading('welcome'), reading('closed'));
    return m;
  }
};

// ---------------------------------------------------------------------------
// canvas
// ---------------------------------------------------------------------------

/** `canvas`' two timed windows: the wheel scrolling the page down and back with the hero selected, and the pointer
 *  sweeping across it. */
export const CANVAS_WINDOWS = ['scroll', 'sweep'] as const;
/** The scroll: this many wheel notches of this many pixels down, then as many back up, one every STEP_MS. */
export const SCROLL_STEPS = 30;
export const SCROLL_STEP = 60;
/** The sweep: two diagonals across the page, each this many pointer moves, one every STEP_MS. */
export const SWEEP_STEPS = 60;
/** About a frame between two inputs, as a wheel or a mouse at 60 Hz sends them. */
const STEP_MS = 16;
/** How far an outline may sit from the element it outlines (device-pixel snapping), in the editor's pixels. */
const OUTLINE_SLACK = 1.5;

/** What the editor's frames did in one window, as the injected watch below saw them. */
interface FramesSeen {
  frames: number;
  droppedFrames: number;
  longestFrameMs: number;
  longTasks: number;
  longTaskMs: number;
}
/**
 * The frame watch, run in the editor's page: every animation frame's time, and every long task (50 ms or more) of its
 * main thread, until it is stopped. Source text, not a function: the scripts' compiler wraps a named function in a
 * helper the page does not have.
 */
const WATCH_FRAMES = `(() => {
  const w = { times: [], long: [], on: true };
  const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) w.long.push(e.duration); });
  po.observe({ type: 'longtask' });
  w.tick = (t) => { if (!w.on) return; w.times.push(t); requestAnimationFrame(w.tick); };
  w.stop = () => { w.on = false; for (const e of po.takeRecords()) w.long.push(e.duration); po.disconnect(); return { times: w.times, long: w.long }; };
  requestAnimationFrame(w.tick);
  globalThis.__perfFrames = w;
})()`;
const STOP_FRAMES = 'globalThis.__perfFrames.stop()';

/** Start watching the editor's frames. The scenario's own, injected for the window and stopped after it: nothing of
 *  the app's. */
async function watchFrames(win: Page) {
  await win.evaluate(WATCH_FRAMES);
}

/** Stop the watch and say what it saw: a frame later than `periodMs` after the one before stands for the frames it
 *  dropped (one interval of two periods is one dropped frame). */
export function framesOf(times: number[], long: number[], periodMs: number): FramesSeen {
  let dropped = 0;
  let longest = 0;
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    longest = Math.max(longest, dt);
    dropped += Math.max(0, Math.round(dt / periodMs) - 1);
  }
  return { frames: times.length, droppedFrames: dropped, longestFrameMs: longest, longTasks: long.length, longTaskMs: long.reduce((n, d) => n + d, 0) };
}
async function framesSeen(win: Page, periodMs: number): Promise<FramesSeen> {
  const { times, long } = (await win.evaluate(STOP_FRAMES)) as { times: number[]; long: number[] };
  return framesOf(times, long, periodMs);
}

/** The editor's frame period at rest: the median time between its animation frames over a second of doing nothing. */
async function framePeriod(win: Page): Promise<number> {
  await watchFrames(win);
  await sleep(1000);
  const { times } = (await win.evaluate(STOP_FRAMES)) as { times: number[] };
  return median(times.slice(1).map((t, i) => t - times[i]));
}

type Box = { x: number; y: number; width: number; height: number };
/** The page's scroll position once it has stopped moving (two readings 100 ms apart agree). */
async function settledScroll(frame: FrameLocator): Promise<number> {
  const read = () => frame.locator('html').evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY);
  let was = await read();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const now = await read();
    if (now === was) return now;
    was = now;
  }
  return was;
}

/** The boxes of an element of the page and each of the editor's elements around it (`data-so-node`), in the page's
 *  pixels; the element is the one at a point of the page, or the first heading of the page with this text. */
type ChainAt = { point: { x: number; y: number } } | { heading: string };
async function chainBoxes(frame: FrameLocator, at: ChainAt): Promise<Box[]> {
  return frame.locator('html').evaluate((_html, at) => {
    type El = { getAttribute(n: string): string | null; hasAttribute(n: string): boolean; parentElement: El | null; textContent: string | null; getBoundingClientRect(): Box };
    const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): El | null; querySelectorAll(s: string): Iterable<El> } }).document;
    let el: El | null = 'point' in at ? doc.elementFromPoint(at.point.x, at.point.y) : ([...doc.querySelectorAll('h1')].find((h) => h.textContent?.trim() === at.heading) ?? null);
    const out: Box[] = [];
    for (; el; el = el.parentElement) {
      if (!el.hasAttribute('data-so-node')) continue;
      const r = el.getBoundingClientRect();
      out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    }
    return out;
  }, at);
}

/** Whether `drawn` (an outline, in the editor) outlines one of `boxes` (the page's, shown at `frame` scaled by `z`), with
 *  the breathing room an outline may have (0 or 6 px). */
function outlines(drawn: Box, boxes: Box[], frame: Box, z: number): boolean {
  return boxes.some((b) =>
    [0, 6].some((pad) => {
      const x = frame.x + b.x * z - pad;
      const y = frame.y + b.y * z - pad;
      return Math.abs(drawn.x - x) <= OUTLINE_SLACK && Math.abs(drawn.y - y) <= OUTLINE_SLACK && Math.abs(drawn.width - (b.width * z + pad * 2)) <= OUTLINE_SLACK * 2 && Math.abs(drawn.height - (b.height * z + pad * 2)) <= OUTLINE_SLACK * 2;
    })
  );
}

/**
 * How many times a window (or the outlines' check) is tried. A machine busy with other work can tell the app of the
 * project's files changing on disk (they were put back before the launch) seconds late: the app reads the project
 * again, or the preview reloads its page, and a window that happens in measures a page loading instead. Such a window
 * is done again; the one measured is the last, which nothing reloaded. Each arm is held to the same rule.
 */
const WINDOW_TRIES = 5;
/** Longer than any one input takes: one still not taken went to a page that was reloading under it. */
const INPUT_MS = 5_000;
const input = (p: Promise<void>, what: string) => withDeadline(p, INPUT_MS, what);

/** The preview loaded a page, or the project was read again from disk, between two times. */
const reloadedIn = (t: Trace, from: number, to: number) => !!t.first('canvas.ready', inProc('renderer'), from, to) || !!t.first('session.reloadFromDisk', inProc('main'), from, to);

/** The editor's mark for one edge of one of `canvas`' windows, in one attempt (any attempt without one). */
const atWindow =
  (window: string, edge: 'start' | 'end', attempt?: number) =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.scenario === 'canvas' && r.attrs?.window === window && r.attrs?.edge === edge && (attempt === undefined || r.attrs?.attempt === attempt);
/** The window's mark in its last attempt: the one measured. */
function lastWindow(t: Trace, window: string, edge: 'start' | 'end'): PerfRecord | undefined {
  const all = t.all('canvas.window', atWindow(window, edge));
  const last = Math.max(...all.map((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0)));
  return all.find((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0) === last);
}

/** How long nothing must have reloaded before a window starts. The reloads come in bursts up to about 4 s apart. */
const QUIET_MS = 3000;
/** Until the page is there, editing, and nothing has reloaded for QUIET_MS (30 s at most), then the settle time. */
async function settledAgain(ctx: ScenarioContext) {
  await preview(ctx.win).locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60_000 });
  for (let i = 0; i < 60 && reloadedIn(await ctx.waitTrace(() => true, 0), Date.now() - QUIET_MS, Infinity); i++) await sleep(500);
  await sleep(ctx.settleMs);
}

/** `body` done again, up to WINDOW_TRIES times, while a reload happens during it; what it threw stands otherwise. */
async function undisturbed(ctx: ScenarioContext, what: string, body: (attempt: number) => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now() - 100;
    let failed: unknown = null;
    try {
      await body(attempt);
    } catch (e) {
      failed = e;
    }
    await sleep(500);
    if (!reloadedIn(await ctx.waitTrace(() => true, 0), t0, Infinity)) {
      if (failed) throw failed;
      return;
    }
    if (attempt >= WINDOW_TRIES) throw new Error(`the preview reloaded during ${what} ${WINDOW_TRIES} times (the project’s files kept changing on disk)`);
    await settledAgain(ctx);
  }
}

/** One of `canvas`' windows: its edges marked, with what the frame watch saw on the end, done again if a reload
 *  happened during it. */
async function inWindow(ctx: ScenarioContext, window: (typeof CANVAS_WINDOWS)[number], periodMs: number, body: () => Promise<void>) {
  await undisturbed(ctx, `the ${window}`, async (attempt) => {
    // From the page's top every time: a page loaded again can come back where it was scrolled to.
    const frame = preview(ctx.win);
    await frame.locator('html').evaluate(() => (globalThis as unknown as { scrollTo(o: object): void }).scrollTo({ top: 0, behavior: 'instant' }));
    expect((await settledScroll(frame)) === 0, `the page would not go back to its top before the ${window}`);
    await sleep(500);
    await watchFrames(ctx.win);
    await ctx.mark('canvas.window', { scenario: 'canvas', window, edge: 'start', attempt });
    try {
      await body();
    } finally {
      await ctx.mark('canvas.window', { scenario: 'canvas', window, edge: 'end', attempt, ...(await framesSeen(ctx.win, periodMs)) });
    }
  });
}

export const canvas: Scenario = {
  name: 'canvas',
  after: 'open',
  description: 'With the home hero selected, scroll the home page down and back with the wheel, then sweep the pointer across it, and check the outlines sit on what they outline.',
  async run(ctx) {
    const { win, fixture } = ctx;
    const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(before, 'no project is open');
    const shownHeading = findHeading(before.state.pages[fixture.homePageId], fixture.heroId)?.heading ?? fixture.heading;
    const frame = preview(win);
    // Not timed: the hero selected by a click on it, from nothing selected, as the selection toolbar shows. Done again
    // if the page reloads under the click (see WINDOW_TRIES).
    await settledAgain(ctx);
    await undisturbed(ctx, 'selecting the hero', async () => {
      for (let i = 0; i < 4 && (await heroChip(win).count()); i++) await win.keyboard.press('Escape');
      await frame.getByRole('heading', { name: shownHeading, exact: true, level: 1 }).first().click({ timeout: 15_000 });
      await heroChip(win).waitFor({ timeout: 15_000 });
    });
    const box = await win.locator('.frame-box iframe').boundingBox();
    expect(box, 'the preview frame has no box');
    const view = await frame.locator('html').evaluate(() => {
      const g = globalThis as unknown as { innerWidth: number; innerHeight: number; document: { documentElement: { scrollHeight: number } } };
      return { width: g.innerWidth, height: g.innerHeight, scrollable: g.document.documentElement.scrollHeight - g.innerHeight };
    });
    const z = box.width / view.width;
    const editorHeight = await win.evaluate(() => (globalThis as unknown as { innerHeight: number }).innerHeight);
    const shown = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, editorHeight - box.y) };
    // A notch moves the page by its pixels on screen: the page's own are larger while the canvas shows it zoomed out.
    const travel = Math.round((SCROLL_STEPS * SCROLL_STEP) / z);
    expect(view.scrollable >= travel, `the home page scrolls ${view.scrollable}px, short of the ${travel}px the scroll needs`);
    // The pointer rests over the page, a third of the way across: clear of the selection's spacing handles in the middle
    // of its edges and its Add buttons three quarters across, which take the wheel when they pass under it.
    await win.mouse.move(shown.x + shown.width * 0.3, shown.y + shown.height / 2);
    const periodMs = await framePeriod(win);
    expect(Number.isFinite(periodMs) && periodMs > 0, 'the editor drew no frames at rest');
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    // A launch's late reports of the project's files being put back are let pass first (see WINDOW_TRIES).
    await settledAgain(ctx);
    await ctx.mark('scenario.start', { scenario: 'canvas', periodMs });

    // The wheel scrolls the page down and back up with the hero selected.
    await inWindow(ctx, 'scroll', periodMs, async () => {
      for (let i = 0; i < SCROLL_STEPS; i++) {
        await input(win.mouse.wheel(0, SCROLL_STEP), 'a wheel notch');
        await sleep(STEP_MS);
      }
      const down = await settledScroll(frame);
      for (let i = 0; i < SCROLL_STEPS; i++) {
        await input(win.mouse.wheel(0, -SCROLL_STEP), 'a wheel notch');
        await sleep(STEP_MS);
      }
      const up = await settledScroll(frame);
      // Images that load above the view as it scrolls make the page longer, and the browser keeps what shows in place, so
      // a scroll can end a little past where the notches alone would take it: it went most of the way each way.
      expect(down >= travel * 0.75, `the wheel scrolled the page from its top to ${down}px, short of the ${travel}px its notches go`);
      expect(down - up >= travel * 0.75, `the wheel brought the page back from ${down}px only to ${up}px`);
    });
    expect(await heroChip(win).count(), `the ${HERO_NAME} is no longer selected after the scroll`);

    // The pointer sweeps across the page, corner to corner and back across the other diagonal.
    await inWindow(ctx, 'sweep', periodMs, async () => {
      const legs = [
        [0.1, 0.05, 0.9, 0.95],
        [0.9, 0.05, 0.1, 0.95]
      ];
      for (const [x0, y0, x1, y1] of legs)
        for (let i = 0; i <= SWEEP_STEPS; i++) {
          const f = i / SWEEP_STEPS;
          await input(win.mouse.move(shown.x + shown.width * (x0 + (x1 - x0) * f), shown.y + shown.height * (y0 + (y1 - y0) * f)), 'a pointer move');
          await sleep(STEP_MS);
        }
      await sleep(300);
    });
    await ctx.waitTrace((t) => !!t.first('canvas.hoverOutlined', inProc('renderer'), lastWindow(t, 'sweep', 'start')?.t ?? Infinity), 5_000);

    // Not timed: scrolled part of the way down from the page's top, the selection's outline sits on the hero, half out of
    // view, and the hover's on an element of another of the page's sections under the pointer. From the top each time: a
    // page loaded again can come back where it was scrolled to.
    await undisturbed(ctx, 'the outlines’ check', async () => {
      await frame.locator('html').evaluate(() => (globalThis as unknown as { scrollTo(o: object): void }).scrollTo({ top: 0, behavior: 'instant' }));
      await input(win.mouse.move(shown.x + shown.width * 0.3, shown.y + shown.height / 2), 'a pointer move');
      const top = await settledScroll(frame);
      for (let i = 0; i < 5; i++) {
        await input(win.mouse.wheel(0, SCROLL_STEP), 'a wheel notch');
        await sleep(STEP_MS);
      }
      const at = await settledScroll(frame);
      expect(at > top, 'the page did not scroll before the outlines were checked');
      const spot = await frame.locator('html').evaluate((_html, heading) => {
        type El = { contains(o: El): boolean; textContent: string | null; closest(s: string): El | null; parentElement: El | null; getBoundingClientRect(): Box };
        const g = globalThis as unknown as { innerWidth: number; innerHeight: number; document: { querySelectorAll(s: string): Iterable<El> }; getComputedStyle(el: El): { position: string } };
        const h1 = [...g.document.querySelectorAll('h1')].find((h) => h.textContent?.trim() === heading);
        const section = h1?.closest('section') ?? null;
        // In the page's own content (not the shared header or footer), and in nothing pinned to the view while it scrolls.
        for (const el of g.document.querySelectorAll('main [data-so-node]')) {
          if (section && (section.contains(el) || el.contains(section))) continue;
          let pinned = false;
          for (let up: El | null = el; up && !pinned; up = up.parentElement) pinned = ['fixed', 'sticky'].includes(g.getComputedStyle(up).position);
          if (pinned) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 40 && r.height >= 20 && r.y >= 10 && r.y + r.height <= g.innerHeight - 10 && r.x >= 0 && r.x + r.width <= g.innerWidth) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      }, shownHeading);
      expect(spot, 'no element of another section is in view to hover');
      await input(win.mouse.move(box.x + spot.x * z, box.y + spot.y * z), 'a pointer move');
      await win.locator('.ov-hover').first().waitFor({ timeout: 10_000 });
      await sleep(500);
      const selected = await win.locator('.ov-selected').first().boundingBox();
      expect(selected && outlines(selected, await chainBoxes(frame, { heading: shownHeading }), box, z), `the selection’s outline (${JSON.stringify(selected)}) is not on the ${HERO_NAME} after the scroll`);
      const hovered = await win.locator('.ov-hover').first().boundingBox();
      expect(hovered && outlines(hovered, await chainBoxes(frame, { point: spot }), box, z), `the hover’s outline (${JSON.stringify(hovered)}) is not on what the pointer is over`);
    });
    await ctx.mark('scenario.end', { scenario: 'canvas' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('canvas', 'renderer')) && !!t.first('scenario.end', forScenario('canvas', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('canvas', 'renderer')));
    const period = begin?.attrs?.periodMs;
    if (typeof period === 'number') m.ms('canvas.framePeriodMs', period);
    else m.need('scenario.start (renderer, with the frame period)', undefined);
    for (const w of CANVAS_WINDOWS) {
      // The last attempt: any before it had a reload during it, and was done again.
      const start = m.need(`canvas.window ${w} start`, lastWindow(trace, w, 'start'));
      const end = m.need(`canvas.window ${w} end`, start && trace.first('canvas.window', atWindow(w, 'end', start.attrs?.attempt as number)));
      if (!start || !end) continue;
      const p = `canvas.${w}`;
      const gained = (name: string) => counter(end, name) - counter(start, name);
      m.since(`${p}.ms`, start, end);
      m.count(`${p}.canvasRenders`, gained('canvas.renders'));
      m.count(`${p}.rectReports`, gained('canvas.rectReports'));
      m.count(`${p}.rectReportsSame`, gained('canvas.rectReportsSame'));
      m.count(`${p}.hoverReports`, gained('canvas.hoverReports'));
      commits(m, trace, `${p}.rendererCommits`, start, end);
      if (trackless(start) || trackless(end)) m.need(`${p}.renders (the editor did not count component renders)`, undefined);
      else m.count(`${p}.renders`, gained('react.renders'));
      // Each report from the page, handled with the render and commit it set off.
      const reports = [...trace.all('canvas.rects', inProc('renderer'), start.t, end.t), ...trace.all('canvas.hover', inProc('renderer'), start.t, end.t)];
      if (!reports.length) m.need(`${p}: the page's reports (canvas.rects, canvas.hover spans)`, undefined);
      else {
        m.ms(`${p}.reportMs`, median(reports.map((r) => r.ms ?? NaN)));
        m.ms(`${p}.reportMsTotal`, reports.reduce((n, r) => n + (r.ms ?? NaN), 0));
      }
      for (const k of ['frames', 'droppedFrames', 'longTasks'] as const) {
        const v = end.attrs?.[k];
        if (typeof v === 'number') m.count(`${p}.${k}`, v);
        else m.need(`${p}.${k} (the frame watch)`, undefined);
      }
      // A watch that saw fewer than half the frames the window should have had stalled: its dropped frames say nothing.
      const frames = end.attrs?.frames;
      if (typeof frames === 'number' && typeof period === 'number' && frames < (end.t - start.t) / period / 2) m.need(`${p}.frames (the frame watch saw ${frames} frames in ${Math.round(end.t - start.t)} ms)`, undefined);
      for (const k of ['longTaskMs', 'longestFrameMs'] as const) {
        const v = end.attrs?.[k];
        if (typeof v === 'number') m.ms(`${p}.${k}`, v);
        else m.need(`${p}.${k} (the frame watch)`, undefined);
      }
    }
    // From the pointer moving onto an element in the page to the frame that paints its outline.
    const sweepStart = lastWindow(trace, 'sweep', 'start');
    const sweepEnd = sweepStart && trace.first('canvas.window', atWindow('sweep', 'end', sweepStart.attrs?.attempt as number));
    if (sweepStart && sweepEnd) {
      const outlined = trace.all('canvas.hoverOutlined', inProc('renderer'), sweepStart.t, sweepEnd.t);
      const waits = outlined.map((r) => r.t - (typeof r.attrs?.movedAt === 'number' ? r.attrs.movedAt : NaN));
      if (!outlined.length) m.need('canvas.hoverOutlined (no hover outlined in the sweep)', undefined);
      else if (waits.some((w) => !Number.isFinite(w))) m.need('canvas.hoverOutlined (a hover without the time the pointer moved)', undefined);
      else {
        m.count('canvas.sweep.hoversOutlined', outlined.length);
        m.ms('canvas.sweep.hoverOutlineMs', median(waits));
      }
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** The widths of the smaller copies a picture is given (src/main/project/image-variants.ts VARIANT_WIDTHS). */
const COPY_WIDTHS = [160, 480, 960, 1440];
/** The longest side of a web-sized copy (src/main/project/media-client.ts WEB_EDGE). */
const WEB_EDGE = 2560;
/** How long the import of the scenario's photos may take before the scenario stops waiting for it. */
const SCENARIO_IMPORT_MS = 240_000;

/** A library record as the scenario reads it from the snapshot. */
type ImportedRecord = { id: string; name: string; file: string; mime: string; kind: string; width?: number; height?: number; variants?: Array<{ width: number; file: string }> };

/**
 * The copies a web-sized copy of `w` × `h` is given: JPEG at each smaller width, WebP at those and its full width, and
 * AVIF the same as WebP or none (when its set is not the smaller), by file extension.
 */
export function expectedCopies(w: number): { jpg: number[]; webp: number[]; avif: number[] } {
  const smaller = COPY_WIDTHS.filter((x) => x < w * 0.9);
  return { jpg: smaller, webp: [...smaller, w], avif: [...smaller, w] };
}

/** What is wrong with an imported record's copies, or null: each format's widths, as expectedCopies says. */
export function copiesProblem(rec: ImportedRecord): string | null {
  const want = expectedCopies(rec.width ?? 0);
  const got: Record<string, number[]> = { jpg: [], webp: [], avif: [] };
  for (const v of rec.variants ?? []) {
    const ext = v.file.split('.').pop() ?? '';
    if (!(ext in got)) return `a copy in another format (${v.file})`;
    got[ext].push(v.width);
  }
  for (const ext of ['jpg', 'webp'] as const) if (got[ext].join(',') !== want[ext].join(',')) return `${ext} copies at ${got[ext].join(', ') || 'no widths'}, not ${want[ext].join(', ')}`;
  if (got.avif.length && got.avif.join(',') !== want.avif.join(',')) return `AVIF copies at ${got.avif.join(', ')}, not ${want.avif.join(', ')} or none`;
  return null;
}

/**
 * Add the scenario's 20 photos of 12 megapixels (scripts/perf/photos.ts) in Assets, as a person does: Add images, the
 * chooser answered through the driver, and the import review confirmed as it opens, with a web-sized copy of each;
 * until every photo is in the library with all its copies.
 */
export const importPhotos: Scenario = {
  name: 'import',
  after: 'open',
  description: 'Add 20 photos of 12 megapixels in Assets, confirming the import review as it opens, until each is in the library with every copy.',
  async run(ctx) {
    const { win, app } = ctx;
    // Drawn once per machine, before anything is timed.
    const photos = await scenarioPhotos();
    const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(before, 'no project is open');
    const had = new Set(Object.keys(before.state.assets.assets));
    // Not timed: the Assets view shown, on its images.
    const rail = win.locator('.rail [data-rail="assets"]');
    if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
    // The panel's own button, or the empty library's when it has no images yet.
    const add = win.locator('#editor-sidebar').getByRole('button', { name: /Add images/ }).first();
    await add.waitFor({ timeout: 15_000 });
    expect(await add.isEnabled(), 'Add images is not enabled');
    const answer: DesktopCall = { op: 'setAnswers', answers: [{ dialog: 'open', selection: 'files', paths: photos.files }], request: null };
    const set = (await app.evaluate(desktopInMain, answer)) as { error?: string };
    if (set.error) throw new Error(`The file chooser could not be answered: ${set.error}`);
    // Showing the view saves the workspace 300 ms later: that lands before the import starts, not in it.
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await ctx.mark('scenario.start', { scenario: 'import', photos: photos.hash });
    await add.click();
    // The review opens for photos this large, each offered a web-sized copy and checked for one.
    const confirm = win.getByTestId('import-review-add');
    await confirm.waitFor({ timeout: 60_000 });
    expect((await confirm.innerText()).trim() === `Add ${PHOTO_COUNT} files to Assets`, `the import review offers “${(await confirm.innerText()).trim()}”, not all ${PHOTO_COUNT} photos`);
    const copies = win.locator('.modal input[type="checkbox"]');
    expect((await copies.count()) === PHOTO_COUNT, `the import review offers ${await copies.count()} web-sized copies, not ${PHOTO_COUNT}`);
    for (let i = 0; i < PHOTO_COUNT; i++) expect(await copies.nth(i).isChecked(), `the import review does not offer photo ${i + 1} as a web-sized copy`);
    await confirm.click();
    // Until every photo is in the library with its copies.
    const deadline = Date.now() + SCENARIO_IMPORT_MS;
    let added: ImportedRecord[] = [];
    let revision = before.revision;
    while (Date.now() < deadline) {
      const snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
      added = Object.values((snap?.state.assets.assets ?? {}) as Record<string, ImportedRecord>).filter((a) => !had.has(a.id));
      revision = snap?.revision ?? revision;
      if (added.length >= PHOTO_COUNT && added.every((a) => !copiesProblem(a))) break;
      await sleep(50);
    }
    expect(added.length === PHOTO_COUNT, `${added.length} of the ${PHOTO_COUNT} photos reached the library`);
    for (const a of added) {
      const problem = copiesProblem(a);
      expect(!problem, `${a.name} has ${problem}`);
    }
    const variants = added.reduce((n, a) => n + (a.variants?.length ?? 0), 0);
    await ctx.mark('import.done', { scenario: 'import', revision, images: added.length, variants });
    await win.getByText(`Added ${PHOTO_COUNT} images.`, { exact: false }).first().waitFor({ timeout: 15_000 });
    // Each photo as its web-sized copy: named for its file, turned upright, at the size the review promised.
    const sharp = (await import('sharp')).default;
    const byName = new Map(added.map((a) => [a.name, a]));
    for (let i = 1; i <= PHOTO_COUNT; i++) {
      const spec = photoSpec(i);
      const name = spec.name.replace(/\.jpg$/, '').replace(/[-_]+/g, ' ');
      const rec = byName.get(name);
      expect(rec, `no image named “${name}” was added`);
      const [w, h] = spec.turned ? [1920, WEB_EDGE] : [WEB_EDGE, 1920];
      expect(rec.kind === 'image' && rec.mime === 'image/jpeg' && rec.width === w && rec.height === h, `${name} was added as a ${rec.width} × ${rec.height} ${rec.mime}, not a ${w} × ${h} web-sized JPEG`);
      // Every file on disk, each the size and format its record says.
      for (const f of [{ file: rec.file, width: w }, ...(rec.variants ?? [])]) {
        const at = join(ctx.projectDir, f.file);
        expect(existsSync(at), `${f.file} is not in the project`);
        const meta = await sharp(at).metadata();
        const ext = f.file.split('.').pop();
        expect(meta.width === f.width && (meta.autoOrient?.width ?? meta.width) === f.width, `${f.file} is ${meta.width} wide, not ${f.width}`);
        expect({ jpg: 'jpeg', webp: 'webp', avif: 'heif' }[ext ?? ''] === meta.format, `${f.file} is ${meta.format}`);
        // Upright: a portrait photo's copies are portrait too.
        if (meta.height) expect(spec.turned ? meta.height > meta.width! : meta.height < meta.width!, `${f.file} is not turned the way the photo is shown`);
        // The modern copies carry the photo's credits, which an export cannot add to them.
        if (spec.credited && (ext === 'webp' || ext === 'avif')) expect(meta.exif?.includes('Ana Field'), `${f.file} does not carry the photo’s credits`);
      }
    }
    // Shown from the preview, as the canvas and Assets show them: each original and its smallest copy load.
    const snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    const devUrl = snap?.runtime.state === 'ready' ? snap.runtime.url : null;
    expect(devUrl, 'the preview is not running');
    const urls = added.flatMap((a) => [a.file, a.variants![0].file].map((f) => `${devUrl}/${f.replace(/^static\//, '')}`));
    type Img = { naturalWidth: number; onload: (() => void) | null; onerror: (() => void) | null; src: string };
    const widths = await win.evaluate(
      (list) => Promise.all(list.map((src) => new Promise<number>((resolve) => { const img = new (globalThis as unknown as { Image: new () => Img }).Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = src; }))),
      urls
    );
    const unshown = widths.filter((w) => !w).length;
    expect(!unshown, `${unshown} of the ${urls.length} files the preview should serve did not load`);
    await sleep(ctx.settleMs);
    await ctx.mark('scenario.end', { scenario: 'import' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('import', 'renderer')) && !!t.first('scenario.end', forScenario('import', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('import', 'renderer')));
    const from = begin?.t ?? Infinity;
    const req = m.need('import.requested', trace.first('import.requested', inProc('renderer'), from));
    const at = req?.t ?? Infinity;
    const done = m.need('import.done', trace.first('import.done', forScenario('import', 'renderer'), at));
    const revision = typeof done?.attrs?.revision === 'number' ? done.attrs.revision : NaN;
    const shown = m.need('renderer.commit (the import)', trace.first('renderer.commit', (r) => r.proc === 'renderer' && r.attrs?.revision === revision, at));
    // The first commit to show any of the photos: with them all arriving together, the same one.
    const from0 = typeof req?.attrs?.revision === 'number' ? req.attrs.revision : NaN;
    const first = trace.first('renderer.commit', (r) => r.proc === 'renderer' && typeof r.attrs?.revision === 'number' && r.attrs.revision > from0, at);
    m.span('import.review', m.need('controller.reviewImport', trace.first('controller.reviewImport', inProc('main'), from, at)));
    m.since('import.total', req, shown);
    m.since('import.firstShown', req, m.need('renderer.commit (the first photos)', first));
    const whole = m.need('controller.importAssets', trace.first('controller.importAssets', inProc('main'), at));
    m.span('import.main', whole);
    const until = whole?.t ?? -Infinity;
    const start = startOf(whole) ?? Infinity;
    m.span('import.apply', m.need('session.apply', trace.all('session.apply', inProc('main'), start, until).at(-1)));
    // Every photo's own time in the main process, from reading it to its files written.
    const files = trace.all('import.file', inProc('main'), start, until);
    if (files.length !== PHOTO_COUNT) m.need(`import.file spans (${files.length} of ${PHOTO_COUNT})`, undefined);
    else m.ms('import.image.ms', median(files.map((f) => f.ms ?? NaN)));
    // What the media worker did: a web-sized copy and the copies of it, for each photo.
    const asked = trace.all('media.request', inProc('main'), start, until);
    const kind = (k: string) => asked.filter((r) => r.attrs?.kind === k);
    const web = kind('web');
    const copies = kind('variants');
    const num = (r: PerfRecord, k: string) => (typeof r.attrs?.[k] === 'number' ? (r.attrs[k] as number) : NaN);
    if (web.length !== PHOTO_COUNT || copies.length !== PHOTO_COUNT) m.need(`media.request marks (${web.length} web-sized and ${copies.length} copies of ${PHOTO_COUNT} photos)`, undefined);
    else {
      const med = (list: PerfRecord[], k: string) => median(list.map((r) => num(r, k)));
      m.ms('import.image.webMs', med(web, 'ms'));
      m.ms('import.image.webDecodeMs', med(web, 'decodeMs'));
      m.ms('import.image.webCopyMs', med(web, 'webCopyMs'));
      m.ms('import.image.copiesMs', med(copies, 'ms'));
      m.ms('import.image.copiesDecodeMs', med(copies, 'decodeMs'));
      for (const f of ['jpeg', 'webp', 'avif']) m.ms(`import.image.${f}Ms`, med(copies, `${f}Ms`));
    }
    m.count('import.workerRequests', asked.length);
    m.count('import.decodes', asked.reduce((n, r) => n + num(r, 'decodes'), 0));
    m.count('import.encodes', asked.reduce((n, r) => n + num(r, 'encodes'), 0));
    // Each worker's CPU from the first request it was given to the last it answered (requests that overlap share it),
    // and its peak memory; added up over the workers.
    const workers = new Map<unknown, { from: number; to: number; peak: number }>();
    for (const r of asked) {
      const w = workers.get(r.attrs?.worker) ?? { from: Infinity, to: -Infinity, peak: 0 };
      workers.set(r.attrs?.worker, { from: Math.min(w.from, num(r, 'cpuStart')), to: Math.max(w.to, num(r, 'cpuEnd')), peak: Math.max(w.peak, num(r, 'peakRss')) });
    }
    m.ms('import.workerCpuMs', [...workers.values()].reduce((n, w) => n + (w.to - w.from), 0));
    const peaks = new Map([...workers].map(([k, w]) => [k, w.peak]));
    m.count('import.workers', peaks.size);
    m.count('import.workerPeakRss', [...peaks.values()].reduce((n, v) => n + v, 0), 'bytes');
    m.count('import.fileWrites', delta(whole, 'fs.writes'));
    m.count('import.durableWrites', delta(whole, 'fs.durableWrites'));
    m.count('import.fsyncs', delta(whole, 'fs.fsyncs'));
    if (done) {
      m.count('import.images', Number(done.attrs?.images));
      m.count('import.variants', Number(done.attrs?.variants));
    }
    m.ms('import.mainStallMax', stallMax(trace, req, shown));
    return m;
  }
};

// ---------------------------------------------------------------------------
// cmdk
// ---------------------------------------------------------------------------

/** What the command menu scenario types: a page's title, a dozen sections' names and words on many pages (#973). */
export const CMDK_QUERY = 'contact';
/** The time between two keys, as a quick typist leaves them. */
export const CMDK_KEY_GAP_MS = 100;

/** The command menu's rows, in order, as the listbox shows them: each option's id (which names its result) and text. */
async function menuRows(win: Page): Promise<string[]> {
  return win.locator('.cmdk-list [role="option"]').evaluateAll((els) => els.map((el) => `${(el as unknown as { id: string }).id.replace(/^.*?-(?=[a-z])/, '')} ${(el as unknown as { textContent: string | null }).textContent ?? ''}`));
}

/** The results mark for a search of `chars` characters, from `from` on. */
const resultsFor = (chars: number) => (r: PerfRecord) => r.proc === 'renderer' && r.attrs?.chars === chars;

export const cmdk: Scenario = {
  name: 'cmdk',
  after: 'open',
  description: `Open the command menu with its shortcut, type “${CMDK_QUERY}” a key at a time, and wait for the site’s words that match to be listed.`,
  async run(ctx) {
    const { win } = ctx;
    // Nothing else open, and the editor's own page taking keys (not the preview's frame).
    for (let i = 0; i < 3 && (await win.locator('.overlay-backdrop').count()); i++) await win.keyboard.press('Escape');
    await win.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
    const periodMs = await framePeriod(win);
    expect(Number.isFinite(periodMs) && periodMs > 0, 'the editor drew no frames at rest');
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await ctx.mark('scenario.start', { scenario: 'cmdk' });
    await win.keyboard.press('ControlOrMeta+K');
    const input = win.getByRole('combobox', { name: 'Search pages, sections, content and commands' });
    await input.waitFor({ timeout: 15_000 });
    await ctx.waitTrace((t) => !!t.first('cmdk.painted', inProc('renderer'), forScenarioStart(t, 'cmdk')), 15_000);
    expect(await input.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), 'the command menu’s search does not have the focus');
    await sleep(500);
    await watchFrames(win);
    await ctx.mark('cmdk.typeStart', { scenario: 'cmdk' });
    for (const ch of CMDK_QUERY) {
      await win.keyboard.press(ch);
      await sleep(CMDK_KEY_GAP_MS);
    }
    // Until the results for the whole search are listed, then the frames' watch stops.
    await ctx.waitTrace((t) => !!t.first('cmdk.results', resultsFor(CMDK_QUERY.length), t.first('cmdk.typeStart', inProc('renderer'))?.t ?? Infinity), 15_000);
    await sleep(500);
    await ctx.mark('cmdk.typeEnd', { scenario: 'cmdk', ...(await framesSeen(win, periodMs)) });
    expect((await input.inputValue()) === CMDK_QUERY, `the search holds “${await input.inputValue()}”, not what was typed`);
    const typed = await menuRows(win);
    // The search finds a page, sections placed on the site and the site's words, each listed.
    expect(typed.some((r) => r.startsWith('page_3a')), `typing “${CMDK_QUERY}” lists no page`);
    // As many sections as the menu lists before Show more, and as many of the site's words as it previews: the search
    // matches more of both on the large fixture.
    const sections = typed.filter((r) => /^sec_3a\d/.test(r)).length;
    const words = typed.filter((r) => r.startsWith('find_3a') && !r.startsWith('find_3aall')).length;
    expect(sections >= 6, `typing “${CMDK_QUERY}” lists ${sections} sections on the site, not the 6 it lists before Show more`);
    expect(words >= 5, `typing “${CMDK_QUERY}” lists ${words} of the site’s words, not the 5 it previews`);
    await ctx.mark('scenario.end', { scenario: 'cmdk' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('cmdk', 'renderer')) && !!t.first('scenario.end', forScenario('cmdk', 'main')));
    // Not timed: the same search entered at once lists the same rows in the same order, so what was typed a key at a
    // time was not left behind on an earlier search.
    await input.fill('');
    await input.fill(CMDK_QUERY);
    await sleep(1000);
    const pasted = await menuRows(win);
    expect(JSON.stringify(pasted) === JSON.stringify(typed), `the search typed a key at a time lists ${typed.length} rows that differ from the ${pasted.length} the same search entered at once lists`);
    await win.keyboard.press('Escape');
    await win.locator('.cmdk').waitFor({ state: 'detached', timeout: 15_000 });
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('cmdk', 'renderer')));
    const end = m.need('scenario.end (renderer)', trace.first('scenario.end', forScenario('cmdk', 'renderer')));
    const from = begin?.t ?? Infinity;
    const req = m.need('cmdk.requested', trace.first('cmdk.requested', inProc('renderer'), from));
    m.since('cmdk.openMs', req, m.need('cmdk.shown', trace.first('cmdk.shown', inProc('renderer'), from)));
    m.since('cmdk.openPaintMs', req, m.need('cmdk.painted', trace.first('cmdk.painted', inProc('renderer'), from)));
    const typeStart = m.need('cmdk.typeStart', trace.first('cmdk.typeStart', inProc('renderer'), from));
    const typeEnd = m.need('cmdk.typeEnd', trace.first('cmdk.typeEnd', inProc('renderer'), from));
    if (!typeStart || !typeEnd || !end) return m;
    // One span per key, each the update it made with the React render and commit it set off.
    const keys = trace.all('cmdk.keystroke', inProc('renderer'), typeStart.t, typeEnd.t);
    if (keys.length !== CMDK_QUERY.length) m.need(`cmdk.keystroke (${keys.length} of the ${CMDK_QUERY.length} keys typed)`, undefined);
    else {
      m.count('cmdk.keystrokes', keys.length);
      m.ms('cmdk.keyMs', median(keys.map((k) => k.ms ?? NaN)));
      m.ms('cmdk.keyMsTotal', keys.reduce((n, k) => n + (k.ms ?? NaN), 0));
      // From each key to the commit that lists its search's results, which can come after the key's own.
      const waits = keys.map((k) => {
        const chars = k.attrs?.chars as number;
        const started = k.t - (k.ms ?? NaN);
        const shown = trace.first('cmdk.results', resultsFor(chars), started, typeEnd.t);
        return shown ? shown.t - started : NaN;
      });
      if (waits.some((w) => !Number.isFinite(w))) m.need('cmdk.results (a key whose search was never listed)', undefined);
      else {
        m.ms('cmdk.resultsMs', median(waits));
        m.ms('cmdk.lastResultsMs', waits[waits.length - 1]);
      }
    }
    const last = m.need('cmdk.results (the whole search)', trace.all('cmdk.results', resultsFor(CMDK_QUERY.length), typeStart.t, typeEnd.t).at(-1));
    if (last) {
      m.count('cmdk.rows', Number(last.attrs?.rows));
      m.count('cmdk.contentRows', Number(last.attrs?.content));
    }
    commits(m, trace, 'cmdk.typeCommits', typeStart, typeEnd);
    if (trackless(typeStart) || trackless(typeEnd)) m.need('cmdk.typeRenders (the editor did not count component renders)', undefined);
    else m.count('cmdk.typeRenders', counter(typeEnd, 'react.renders') - counter(typeStart, 'react.renders'));
    for (const k of ['frames', 'droppedFrames', 'longTasks'] as const) {
      const v = typeEnd.attrs?.[k];
      if (typeof v === 'number') m.count(`cmdk.type.${k}`, v);
      else m.need(`cmdk.type.${k} (the frame watch)`, undefined);
    }
    for (const k of ['longTaskMs', 'longestFrameMs'] as const) {
      const v = typeEnd.attrs?.[k];
      if (typeof v === 'number') m.ms(`cmdk.type.${k}`, v);
      else m.need(`cmdk.type.${k} (the frame watch)`, undefined);
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

/** The libraries `assets` measures: the large fixture's own 300 images, then grown (untimed) to 1,000. */
export const ASSET_LIBRARIES = [
  { key: 'at300', images: 300 },
  { key: 'at1000', images: 1000 }
] as const;
export const ASSET_WINDOWS = ['show', 'edit', 'scroll'] as const;
/** A wheel notch over the grid, and the most the scroll may take to reach the grid's end. */
export const ASSET_NOTCH = 400;
const ASSET_NOTCHES_MAX = 400;
const ASSET_GROWN_AT = '2026-01-02T00:00:00.000Z';

/** The images the scenario adds to reach `to`, after the fixture's own (named and drawn as fixtures.ts draws them). */
export function grownImages(from: number, to: number): Array<{ record: Record<string, unknown>; file: string; bytes: Buffer }> {
  const out: Array<{ record: Record<string, unknown>; file: string; bytes: Buffer }> = [];
  for (let i = from + 1; i <= to; i++) {
    const bytes = fixturePng(i);
    const n = String(i).padStart(3, '0');
    const file = `static/assets/fixture-${n}.png`;
    out.push({ file, bytes, record: { id: `img-${n}`, name: `Fixture image ${n}`, file, mime: 'image/png', bytes: bytes.length, width: 96, height: 72, hash: createHash('sha256').update(bytes).digest('hex'), kind: 'image', createdAt: ASSET_GROWN_AT } });
  }
  return out;
}

/** The Assets view's grid and its scrolling body, in the sidebar. */
const ASSET_BODY = '#editor-sidebar .asset-host .panel-body';
const ASSET_TILES = `${ASSET_BODY} .asset-grid [data-asset]`;

/**
 * The show watch, run in the editor's page: the time of the click on the Assets rail button, the first frame after it
 * with the grid's tiles in view, and the first with every tile in view showing its picture. It reads the tiles from the
 * top of the grid until the first below the view, so it costs the same however many the grid holds. Source text, as
 * the frame watch is.
 */
const WATCH_SHOW = `(() => {
  const w = { clickAt: null, laidOutAt: null, picturedAt: null, inView: 0 };
  const onClick = (e) => { if (e.target && e.target.closest && e.target.closest('[data-rail="assets"]')) w.clickAt = e.timeStamp; };
  document.addEventListener('click', onClick, true);
  const tick = (t) => {
    if (w.clickAt !== null) {
      const body = document.querySelector(${JSON.stringify(ASSET_BODY)});
      const box = body && body.offsetParent ? body.getBoundingClientRect() : null;
      if (box && box.height > 0) {
        let seen = 0, pictured = 0;
        for (const tile of body.querySelectorAll('.asset-grid [data-asset]')) {
          const r = tile.getBoundingClientRect();
          if (r.top >= box.bottom) break;
          if (r.bottom <= box.top || r.height === 0) continue;
          seen++;
          const img = tile.querySelector('img');
          if (img && img.complete && img.naturalWidth > 0) pictured++;
        }
        if (seen && w.laidOutAt === null) w.laidOutAt = t;
        if (seen && pictured === seen && w.picturedAt === null) { w.picturedAt = t; w.inView = seen; }
      }
    }
    if (w.picturedAt === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  w.stop = () => { document.removeEventListener('click', onClick, true); return { clickAt: w.clickAt, laidOutAt: w.laidOutAt, picturedAt: w.picturedAt, inView: w.inView }; };
  globalThis.__perfShow = w;
})()`;

/** The pictures the grid holds loaded, and their decoded size (width × height × 4 bytes each). */
async function picturesHeld(win: Page): Promise<{ pictures: number; pictureBytes: number }> {
  return win.evaluate((sel) => {
    let pictures = 0;
    let pictureBytes = 0;
    type Img = { complete: boolean; naturalWidth: number; naturalHeight: number };
    for (const img of (globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<Img> } }).document.querySelectorAll(`${sel} .asset-grid img`)) {
      if (!img.complete || !img.naturalWidth) continue;
      pictures++;
      pictureBytes += img.naturalWidth * img.naturalHeight * 4;
    }
    return { pictures, pictureBytes };
  }, ASSET_BODY);
}

/** The grid's scroll position and how far it can go. */
const gridScroll = (win: Page) =>
  win.locator(ASSET_BODY).first().evaluate((el) => {
    const b = el as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
    return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight };
  });

/** The Assets view hidden behind Pages, so showing it again is what is measured. */
async function hideAssets(win: Page) {
  const pages = win.locator('.rail [data-rail="pages"]');
  if ((await pages.getAttribute('aria-pressed')) !== 'true') await pages.click();
  await win.locator(ASSET_BODY).first().waitFor({ state: 'hidden', timeout: 15_000 });
}

/** Which tile has the focus. */
const focusedTile = (win: Page) => win.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute('data-asset') ?? null);

const atAssets =
  (at: string, window: string, edge: 'start' | 'end') =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.scenario === 'assets' && r.attrs?.at === at && r.attrs?.window === window && r.attrs?.edge === edge;

export const assets: Scenario = {
  name: 'assets',
  after: 'open',
  description: 'In Assets, show the grid of the fixture’s 300 images, take an edit with it shown, scroll it to its end, and walk it with the keyboard; then grow the library to 1,000 images (untimed) and do the same. Run it on large.',
  async run(ctx) {
    const { win } = ctx;
    const snap = () => win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    const first = await snap();
    expect(first, 'no project is open');
    const own = Object.values(first.state.assets.assets).filter((a) => a.kind === 'image').length;
    expect(own === ASSET_LIBRARIES[0].images, `the fixture has ${own} images, not the ${ASSET_LIBRARIES[0].images} this scenario measures first: run it on large`);
    const sort = await win.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('siteorigin.assetSort'));
    await settledAgain(ctx);
    const periodMs = await framePeriod(win);
    expect(Number.isFinite(periodMs) && periodMs > 0, 'the editor drew no frames at rest');
    await ctx.mark('scenario.start', { scenario: 'assets' });
    for (const lib of ASSET_LIBRARIES) {
      const at = lib.key;
      if (lib.images > own) {
        // Not timed: the library grown to this size, its files written where an import puts them and their records
        // added as one change, then left until the project and the preview are quiet again.
        await hideAssets(win);
        const now = (await snap())!;
        const have = Object.values(now.state.assets.assets).filter((a) => a.kind === 'image').length;
        const grown = grownImages(have, lib.images);
        for (const g of grown) {
          mkdirSync(dirname(join(ctx.projectDir, g.file)), { recursive: true });
          writeFileSync(join(ctx.projectDir, g.file), g.bytes);
        }
        const refused = await win.evaluate(async (records) => {
          const r = await (globalThis as unknown as EditorPage).builder.project.apply({ operations: records.map((asset) => ({ type: 'asset.add', asset })) } as never, { label: 'Benchmark images' });
          return r.ok ? null : (r.error?.message ?? 'no reason given');
        }, grown.map((g) => g.record));
        expect(refused === null, `adding the benchmark's images was refused: ${refused}`);
        await settledAgain(ctx);
      }
      const now = (await snap())!;
      const images = Object.values(now.state.assets.assets).filter((a) => a.kind === 'image');
      expect(images.length === lib.images, `the library holds ${images.length} images, not ${lib.images}`);
      expect(!now.missingAssets.length, `${now.missingAssets.length} of the library's images have missing files`);
      const order = sortAssets(images, isAssetSort(sort) ? sort : 'newest').map((a) => a.id);

      // Shown: from the rail button's click to the grid's tiles in view, then to each of them showing its picture.
      await hideAssets(win);
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      await win.evaluate(WATCH_SHOW);
      await watchFrames(win);
      await ctx.mark('assets.window', { scenario: 'assets', at, window: 'show', edge: 'start' });
      await win.locator('.rail [data-rail="assets"]').click();
      await win.waitForFunction(() => (globalThis as unknown as { __perfShow: { picturedAt: number | null } }).__perfShow.picturedAt !== null, undefined, { timeout: 30_000, polling: 100 });
      const shown = (await win.evaluate('globalThis.__perfShow.stop()')) as { clickAt: number | null; laidOutAt: number | null; picturedAt: number | null; inView: number };
      await ctx.mark('assets.window', { scenario: 'assets', at, window: 'show', edge: 'end', ...(await framesSeen(win, periodMs)), showMs: shown.clickAt !== null && shown.laidOutAt !== null ? shown.laidOutAt - shown.clickAt : -1, picturesMs: shown.clickAt !== null && shown.picturedAt !== null ? shown.picturedAt - shown.clickAt : -1, inView: shown.inView, tiles: await win.locator(ASSET_TILES).count() });
      expect(shown.inView > 0, 'the grid showed no tiles in view');
      const tiles = await win.locator(ASSET_TILES).count();
      expect(tiles === lib.images, `the grid shows ${tiles} tiles for the library's ${lib.images} images`);
      expect((await win.locator(ASSET_TILES).first().getAttribute('data-asset')) === order[0], 'the grid does not start with the first image in its order');

      // An edit elsewhere with the grid shown: the project the editor receives is drawn again.
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      const before = (await snap())!;
      await ctx.mark('assets.window', { scenario: 'assets', at, window: 'edit', edge: 'start' });
      const heading = `Assets heading ${ctx.iteration} ${at}`;
      const refused = await win.evaluate(
        async ([pageId, nodeId, text]) => {
          const r = await (globalThis as unknown as EditorPage).builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'heading', value: text }] }, { label: 'Benchmark edit' });
          return r.ok ? null : (r.error?.message ?? 'no reason given');
        },
        [ctx.fixture.homePageId, ctx.fixture.heroId, heading] as const
      );
      expect(refused === null, `the edit was refused: ${refused}`);
      const target = before.revision + 1;
      await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(target)), 30_000);
      await sleep(ctx.settleMs);
      await ctx.mark('assets.window', { scenario: 'assets', at, window: 'edit', edge: 'end', revision: target });
      expect(findHeading((await snap())!.state.pages[ctx.fixture.homePageId], ctx.fixture.heroId)?.heading === heading, 'the project does not hold the edit made with the grid shown');

      // Scrolled with the wheel from the grid's top to its end.
      const body = await win.locator(ASSET_BODY).first().boundingBox();
      expect(body, 'the grid has no box');
      await win.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
      expect((await gridScroll(win)).top === 0, 'the grid is not at its top before the scroll');
      await sleep(500);
      await watchFrames(win);
      await ctx.mark('assets.window', { scenario: 'assets', at, window: 'scroll', edge: 'start' });
      let notches = 0;
      let pos = await gridScroll(win);
      while (pos.top < pos.max - 1 && notches < ASSET_NOTCHES_MAX) {
        await input(win.mouse.wheel(0, ASSET_NOTCH), 'a wheel notch');
        notches++;
        await sleep(STEP_MS);
        pos = await gridScroll(win);
      }
      await ctx.mark('assets.window', { scenario: 'assets', at, window: 'scroll', edge: 'end', notches, ...(await framesSeen(win, periodMs)) });
      expect(pos.top >= pos.max - 1, `the wheel took the grid ${Math.round(pos.top)} of its ${Math.round(pos.max)}px in ${notches} notches`);
      // At its end, the last image is there, showing its picture once it has loaded.
      await sleep(1000);
      const lastTile = win.locator(`${ASSET_BODY} .asset-grid [data-asset="${order[order.length - 1]}"]`);
      expect(await lastTile.count(), 'the grid’s end does not show the last image');
      const lastShown = await lastTile.locator('img').evaluate((img) => (img as unknown as { complete: boolean; naturalWidth: number }).complete && (img as unknown as { naturalWidth: number }).naturalWidth > 0).catch(() => false);
      expect(lastShown, 'the grid’s last image does not show its picture');
      const held = await picturesHeld(win);
      await ctx.mark('assets.held', { scenario: 'assets', at, ...held });
      expect(held.pictures > 0, 'the grid holds no pictures at its end');

      // Not timed: the keyboard walks the whole grid (End, Home, arrows) and Enter opens the image focused.
      await win.locator(ASSET_BODY).first().evaluate((el) => ((el as unknown as { scrollTop: number }).scrollTop = 0));
      await sleep(300);
      await win.locator(ASSET_TILES).first().focus();
      expect((await focusedTile(win)) === order[0], 'the first tile would not take the focus');
      await win.keyboard.press('End');
      expect((await focusedTile(win)) === order[order.length - 1], `End moved the focus to ${await focusedTile(win)}, not the last image`);
      await win.keyboard.press('Home');
      expect((await focusedTile(win)) === order[0], `Home moved the focus to ${await focusedTile(win)}, not the first image`);
      await win.keyboard.press('ArrowRight');
      expect((await focusedTile(win)) === order[1], 'ArrowRight did not move the focus to the second image');
      const cols = await win.locator(ASSET_TILES).evaluateAll((els) => els.filter((e) => (e as unknown as { offsetTop: number }).offsetTop === (els[0] as unknown as { offsetTop: number }).offsetTop).length);
      await win.keyboard.press('ArrowDown');
      expect((await focusedTile(win)) === order[1 + cols], `ArrowDown did not move the focus one row (${cols} images) down`);
      await win.keyboard.press('Enter');
      const name = (now.state.assets.assets[order[1 + cols]] as { name: string }).name;
      const opened = win.locator('#editor-sidebar .asset-detail .asset-ident h4');
      await opened.waitFor({ timeout: 15_000 });
      expect(((await opened.textContent()) ?? '').trim() === name, `Enter opened “${await opened.textContent()}”, not ${name}`);
      await win.locator('#editor-sidebar .asset-detail .asset-back').click();
      await win.locator(ASSET_TILES).first().waitFor({ timeout: 15_000 });
      expect((await focusedTile(win)) === order[1 + cols], 'Back did not return the focus to the image it opened');
    }
    await ctx.mark('scenario.end', { scenario: 'assets' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('assets', 'renderer')) && !!t.first('scenario.end', forScenario('assets', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('assets', 'renderer')));
    for (const { key: at } of ASSET_LIBRARIES) {
      const p = `assets.${at}`;
      const edge = (w: string, e: 'start' | 'end') => m.need(`assets.window ${at} ${w} ${e}`, trace.first('assets.window', atAssets(at, w, e)));
      const gained = (from: PerfRecord, to: PerfRecord, name: string) => counter(to, name) - counter(from, name);
      for (const w of ASSET_WINDOWS) {
        const start = edge(w, 'start');
        const end = edge(w, 'end');
        if (!start || !end) continue;
        const q = `${p}.${w}`;
        if (trackless(start) || trackless(end)) m.need(`${q}.renders (the editor did not count component renders)`, undefined);
        else m.count(`${q}.renders`, gained(start, end, 'react.renders'));
        if (end.c?.['panel.assets.renders'] === undefined) m.need(`${q} (the assets panel was not mounted)`, undefined);
        else {
          m.count(`${q}.assetsRenders`, gained(start, end, 'panel.assets.renders'));
          m.ms(`${q}.assetsRenderMs`, gained(start, end, 'panel.assets.renderMs'));
        }
        commits(m, trace, `${q}.rendererCommits`, start, end);
        if (w === 'edit') {
          const revision = end.attrs?.revision as number;
          const received = m.need(`renderer.snapshotReceived (${at})`, trace.first('renderer.snapshotReceived', atRevision(revision), start.t, end.t));
          m.since(`${q}.commitMs`, received, m.need(`renderer.commit (${at})`, trace.first('renderer.commit', (r) => r.proc === 'renderer' && r.attrs?.revision === revision, received?.t ?? Infinity, end.t)));
          continue;
        }
        for (const k of ['frames', 'droppedFrames', 'longTasks'] as const) {
          const v = end.attrs?.[k];
          if (typeof v === 'number') m.count(`${q}.${k}`, v);
          else m.need(`${q}.${k} (the frame watch)`, undefined);
        }
        for (const k of ['longTaskMs', 'longestFrameMs'] as const) {
          const v = end.attrs?.[k];
          if (typeof v === 'number') m.ms(`${q}.${k}`, v);
          else m.need(`${q}.${k} (the frame watch)`, undefined);
        }
        if (w === 'show') {
          for (const k of ['showMs', 'picturesMs'] as const) {
            const v = end.attrs?.[k];
            if (typeof v === 'number' && v >= 0) m.ms(`${p}.${k}`, v);
            else m.need(`${p}.${k} (the show watch)`, undefined);
          }
          m.count(`${p}.tiles`, Number(end.attrs?.tiles));
          m.count(`${p}.tilesInView`, Number(end.attrs?.inView));
        } else {
          m.since(`${q}.ms`, start, end);
          m.count(`${q}.notches`, Number(end.attrs?.notches));
        }
      }
      const held = m.need(`assets.held ${at}`, trace.first('assets.held', (r) => r.proc === 'renderer' && r.attrs?.scenario === 'assets' && r.attrs?.at === at));
      if (held) {
        m.count(`${p}.picturesHeld`, Number(held.attrs?.pictures));
        m.count(`${p}.pictureBytes`, Number(held.attrs?.pictureBytes), 'bytes');
      }
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// create, createAgain
// ---------------------------------------------------------------------------

/** How long a creation may take, from Create to its home page ready to edit in the canvas. */
const CREATE_MS = 240_000;

/** The projects `create` and `createAgain` make, each in its own folder in the app's default projects folder. */
export const CREATED_NAMES = { create: 'Perf created', createAgain: 'Perf created again' } as const;

/** A lock entry npm installs on this computer: optional packages bound to another OS or CPU are skipped (npm ci). */
export function installsHere(entry: { os?: string[]; cpu?: string[]; libc?: string[]; link?: boolean }, platform: string = process.platform, arch: string = process.arch): boolean {
  if (entry.link) return false;
  const fits = (list: string[] | undefined, value: string) => {
    if (!list?.length) return true;
    if (list.includes(`!${value}`)) return false;
    const allowed = list.filter((v) => !v.startsWith('!'));
    return !allowed.length || allowed.includes(value);
  };
  // libc is told only on Linux, and only by npm itself: an entry bound to one is not checked here.
  return fits(entry.os, platform) && fits(entry.cpu, arch) && !(platform === 'linux' && entry.libc?.length);
}

/** A package as the lock records it: what it needs, and the computers it is made for. */
interface LockEntry {
  os?: string[];
  cpu?: string[];
  libc?: string[];
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/**
 * The lock's packages `npm ci` installs on this computer: those the project needs, followed through what each needs
 * (optional and required peers too), each found as Node finds it from where it is needed, leaving out the optional
 * ones made for another OS or CPU and anything only they need.
 */
export function installedPackages(packages: Record<string, LockEntry>, platform: string = process.platform, arch: string = process.arch): string[] {
  const found = new Set<string>();
  const needs = (e: LockEntry, root: boolean) => [
    ...Object.keys(e.dependencies ?? {}),
    ...Object.keys(e.optionalDependencies ?? {}),
    ...(root ? Object.keys(e.devDependencies ?? {}) : []),
    ...Object.keys(e.peerDependencies ?? {}).filter((n) => !e.peerDependenciesMeta?.[n]?.optional)
  ];
  const resolve = (from: string, name: string): string | null => {
    for (let at = from; ; at = at.includes('/node_modules/') ? at.slice(0, at.lastIndexOf('/node_modules/')) : '') {
      const key = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[key]) return key;
      if (!at) return null;
    }
  };
  const visit = (key: string) => {
    for (const name of needs(packages[key], key === '')) {
      const dep = resolve(key, name);
      if (!dep || found.has(dep) || !installsHere(packages[dep], platform, arch)) continue;
      found.add(dep);
      visit(dep);
    }
  };
  visit('');
  return [...found].sort();
}

/**
 * The packages of `dir`'s lock that `npm ci` installs here and that are not in its node_modules: a created project's
 * website tools must be whole and its own, so they install, build and run without the app.
 */
export function missingPackages(dir: string): string[] {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { packages?: Record<string, LockEntry> };
  return installedPackages(lock.packages ?? {}).filter((key) => !existsSync(join(dir, key, 'package.json')));
}

/**
 * Make a project from the New project dialog, as a person does: on Welcome, New project, a name, the Business starter
 * with its sample images in the default folder, Create; until the canvas reports its home page ready to edit.
 * `createAgain` closes that project and makes a second one the same way, in the same launch: what the second project
 * made with this app costs. The profile's npm cache holds every package the starter installs (the runner copies the
 * fixtures' in), so setup installs offline, as from the cache a packaged app ships.
 */
function createScenario(name: 'create' | 'createAgain', after: 'launch' | 'create'): Scenario {
  const projectName = CREATED_NAMES[name];
  const expected = () => {
    const state = createStarterState('business', projectName, true);
    const home = state.pages[state.site.homePageId];
    // The library gets one record per sample image the app ships, made as each is imported (controller.ts).
    return { pages: Object.keys(state.pages).length, assets: STARTER_ASSETS.length, homeRoute: home.route, heading: findHeading(home)?.heading ?? '' };
  };
  const createdHomeReady = (route: string) => (r: PerfRecord) => r.proc === 'renderer' && r.attrs?.mode === 'edit' && r.attrs?.studio === false && r.attrs?.path === route;
  return {
    name,
    after,
    description:
      name === 'create'
        ? 'Create a project from the Business starter with sample images in the New project dialog, from opening the dialog to the canvas reporting its home page ready to edit.'
        : 'Close the project made by create and make a second one the same way, in the same launch.',
    async run(ctx) {
      const { win } = ctx;
      const want = expected();
      expect(want.heading && want.assets > 0, 'the Business starter has no sample images or no hero heading to check');
      if (name === 'createAgain') {
        // Back on Welcome, as the first creation started: closing the first project is not timed.
        const closed = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.projects.close());
        expect(closed.ok, 'the project create made could not be closed');
        await win.locator('.welcome').waitFor({ timeout: 60_000 });
      }
      expect(await win.locator('.welcome').isVisible(), 'creating starts from Welcome, and Welcome is not showing');
      const parent = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.dialogs.defaultProjectsFolder());
      const dir = join(parent, projectFolderName(projectName));
      // Each iteration makes the project afresh in a folder that is not there yet.
      rmSync(dir, { recursive: true, force: true });
      // A screen change saves the workspace 300 ms later: that lands before the creation starts, not in it.
      await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
      await ctx.mark('scenario.start', { scenario: name });
      await win.locator('.welcome-action').first().click();
      const dialog = win.getByRole('dialog', { name: 'New project' });
      await dialog.waitFor({ timeout: 30_000 });
      // Create waits for the check of the website tools; it must find every one of them on this computer.
      const tools = dialog.locator('#new-project-tools');
      for (let end = Date.now() + 60_000; (await tools.getAttribute('data-tools')) === 'checking'; ) {
        expect(Date.now() < end, 'the New project dialog never finished checking the website tools');
        await sleep(25);
      }
      const said = await tools.getAttribute('data-tools');
      expect(said === 'local', `the New project dialog says the website tools are ${said}, not on this computer: the profile's npm cache does not hold the starter's packages`);
      expect((await dialog.getByRole('radio', { name: /Business/ }).getAttribute('aria-checked')) === 'true', 'the Business starter is not the one chosen');
      expect(await dialog.getByRole('switch', { name: 'Include sample images' }).isChecked(), 'sample images are not included');
      await dialog.getByLabel('Project name').fill(projectName);
      const create = dialog.getByRole('button', { name: 'Create project' });
      for (let end = Date.now() + 30_000; !(await create.isEnabled()); ) {
        expect(Date.now() < end, 'Create project never became available');
        await sleep(25);
      }
      await create.click();
      // The new project in the editor, then its home page ready to edit in the canvas.
      const real = () => (existsSync(dir) ? realpathSync(dir) : dir);
      const deadline = Date.now() + CREATE_MS;
      let snap: Awaited<ReturnType<BuilderApi['project']['snapshot']>> = null;
      while (Date.now() < deadline) {
        snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
        if (snap && snap.dir === real()) break;
        const problem = await dialog.locator('#new-project-error').textContent({ timeout: 50 }).catch(() => null);
        expect(!problem, `the project was not created: ${problem}`);
        await sleep(50);
      }
      expect(snap && snap.dir === real(), `the new project did not open: ${snap?.dir ?? 'no project is open'}`);
      expect(!snap.readOnly, `the new project opened read-only: ${snap.readOnly?.reason ?? ''}`);
      const pages = Object.keys(snap.state.pages).length;
      const assets = Object.keys(snap.state.assets.assets).length;
      expect(pages === want.pages, `the new project has ${pages} pages, not the starter's ${want.pages}`);
      expect(assets === want.assets, `the new project has ${assets} images, not the starter's ${want.assets} samples`);
      expect(findHeading(snap.state.pages[snap.state.site.homePageId])?.heading === want.heading, 'the new project’s home hero has another heading');
      const t = await ctx.waitTrace((t) => !!t.first('canvas.ready', createdHomeReady(want.homeRoute), forScenarioStart(t, name)), CREATE_MS);
      expect(t.first('canvas.ready', createdHomeReady(want.homeRoute), forScenarioStart(t, name)), 'the canvas never reported the new project’s home page ready to edit');
      await preview(win).getByRole('heading', { name: want.heading, exact: true, level: 1 }).first().waitFor({ timeout: 30_000 });
      // Its sample images are files of its own, and its website tools a whole node_modules npm made, there for good.
      for (const a of Object.values(snap.state.assets.assets)) expect(existsSync(join(dir, a.file)), `the sample image ${a.file} is not in the new project`);
      const missing = missingPackages(dir);
      expect(!missing.length, `the new project's node_modules lacks ${missing.length} locked packages (${missing.slice(0, 3).join(', ')})`);
      const hidden = join(dir, 'node_modules', '.package-lock.json');
      expect(existsSync(hidden), 'the new project’s node_modules has no lock of its own (npm’s hidden lockfile)');
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string };
      expect((JSON.parse(readFileSync(hidden, 'utf8')) as { name?: string }).name === pkg.name, 'the new project’s node_modules was installed for another package');
      expect(existsSync(join(dir, '.siteorigin', 'cache', 'deps.json')), 'the new project does not record its website tools as set up');
      await sleep(ctx.settleMs);
      await ctx.mark('scenario.end', { scenario: name });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario(name, 'renderer')) && !!t.first('scenario.end', forScenario(name, 'main')));
    },
    measure(trace) {
      const m = new Collector();
      const want = expected();
      const begin = trace.first('scenario.start', forScenario(name, 'renderer'));
      const end = m.need('scenario.end (main)', trace.first('scenario.end', forScenario(name, 'main'), begin?.t));
      const from = begin?.t ?? Infinity;
      const to = end?.t ?? -Infinity;
      // The dialog: New project pressed, the form on screen, and the check of the website tools that Create waits for.
      const asked = m.need('newProject.requested', trace.first('newProject.requested', inProc('renderer'), from, to));
      const shown = m.need('newProject.formShown', trace.first('newProject.formShown', inProc('renderer'), asked?.t ?? Infinity, to));
      const known = m.need('newProject.toolsKnown', trace.first('newProject.toolsKnown', inProc('renderer'), asked?.t ?? Infinity, to));
      m.since(`${name}.dialogShown`, asked, shown);
      m.since(`${name}.dialogReady`, asked, known);
      const check = m.need('controller.websiteTools', trace.first('controller.websiteTools', inProc('main'), asked?.t ?? Infinity, to));
      m.span(`${name}.websiteTools`, check);
      m.count(`${name}.dialogIdealTrees`, delta(check, 'tools.idealTrees'));
      m.ms(`${name}.dialogStallMax`, asked && known ? stallMax(trace, asked, known) : undefined);
      // The creation: Create pressed, to the new project's home page ready to edit.
      const req = m.need('create.requested', trace.first('create.requested', inProc('renderer'), known?.t ?? Infinity, to));
      const at = req?.t ?? Infinity;
      const total = m.need('controller.create', trace.first('controller.create', inProc('main'), at, to));
      const inside = (n: string) => m.need(n, trace.first(n, inProc('main'), startOf(total) ?? Infinity, total?.t ?? -Infinity));
      const allInside = (n: string) => trace.all(n, inProc('main'), startOf(total) ?? Infinity, total?.t ?? -Infinity);
      m.span(`${name}.controller`, total);
      m.span(`${name}.files`, inside('create.files'));
      const images = inside('create.images');
      m.span(`${name}.images`, images);
      const session = inside('session.create');
      m.span(`${name}.session`, session);
      m.span(`${name}.session.writeDocs`, inside('session.create.writeDocs'));
      const publish = inside('session.publish');
      m.span(`${name}.publish`, publish);
      // The publication's site icons, drawn in the media worker, and its generated files written.
      const inPublish = (n: string) => m.need(n, trace.first(n, inProc('main'), startOf(publish) ?? Infinity, publish?.t ?? -Infinity));
      m.span(`${name}.publish.icons`, inPublish('session.publish.icons'));
      m.span(`${name}.publish.write`, inPublish('session.publish.write'));
      // Both of the first publication's generations, the website's and the preview's.
      const variant = (v: string) => trace.all('session.generate', (r) => r.proc === 'main' && r.attrs?.variant === v, startOf(session) ?? Infinity, session?.t ?? -Infinity);
      const clean = variant('clean');
      const dev = variant('dev');
      if (!clean.length) m.need('session.generate (clean)', undefined);
      if (!dev.length) m.need('session.generate (dev)', undefined);
      if (clean.length && dev.length) m.ms(`${name}.generate`, [...clean, ...dev].reduce((n, r) => n + (r.ms ?? NaN), 0));
      m.span(`${name}.session.localState`, inside('session.create.localState'));
      m.span(`${name}.lock`, inside('create.lock'));
      m.span(`${name}.trust`, inside('create.trust'));
      // Setting up the website tools: the cache, the checks of what they need, npm, and the marker that they are set up.
      const deps = inside('create.dependencies');
      m.span(`${name}.dependencies`, deps);
      const within = (n: string) => trace.all(n, inProc('main'), startOf(deps) ?? Infinity, deps?.t ?? -Infinity);
      m.span(`${name}.tools.seedCache`, m.need('tools.seedCache', within('tools.seedCache')[0]));
      const checks = within('tools.check');
      if (!checks.length) m.need('tools.check', undefined);
      else m.ms(`${name}.tools.check`, checks.reduce((n, r) => n + (r.ms ?? NaN), 0));
      const npm = within('tools.npm');
      if (!npm.length) m.need('tools.npm', undefined);
      else m.ms(`${name}.tools.npm`, npm.reduce((n, r) => n + (r.ms ?? NaN), 0));
      m.span(`${name}.tools.marker`, m.need('tools.marker', within('tools.marker')[0]));
      m.span(`${name}.makeWay`, inside('create.makeWay'));
      m.span(`${name}.attach`, inside('controller.attach'));
      m.span(`${name}.startRuntime`, inside('controller.startRuntime'));
      const ready = m.need('canvas.ready', trace.first('canvas.ready', createdHomeReady(want.homeRoute), at, to));
      m.since(`${name}.editorShown`, req, m.need('renderer.commit (editor)', trace.first('renderer.commit', (r) => r.attrs?.screen === 'editor', at, to)));
      previewStart(m, trace, name, req, at, ready);
      // The headline: Create pressed, to the new project's home page ready to edit.
      m.since(`${name}.canvasReady`, req, ready);
      m.since(`${name}.fromDialog`, asked, ready);
      if (typeof images?.attrs?.images === 'number') m.count(`${name}.imagesImported`, images.attrs.images);
      else if (images) m.need('create.images (the images it imported)', undefined);
      m.count(`${name}.fileWrites`, delta(total, 'fs.writes'));
      m.count(`${name}.imageFileWrites`, delta(images, 'fs.writes'));
      m.count(`${name}.publishFileWrites`, delta(publish, 'fs.writes'));
      m.count(`${name}.durableWrites`, delta(total, 'fs.durableWrites'));
      m.count(`${name}.fsyncs`, delta(total, 'fs.fsyncs'));
      m.count(`${name}.filesRead`, delta(total, 'files.read'));
      m.count(`${name}.filesHashed`, delta(total, 'files.hashed'));
      m.count(`${name}.npmRuns`, delta(total, 'tools.npmRuns'));
      m.count(`${name}.idealTrees`, delta(total, 'tools.idealTrees'));
      m.count(`${name}.toolChecks`, allInside('tools.check').length);
      m.ms(`${name}.mainStallMax`, req && ready ? stallMax(trace, req, ready) : undefined);
      return m;
    }
  };
}

export const create = createScenario('create', 'launch');
export const createAgain = createScenario('createAgain', 'create');

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

/** `drag`'s pointer path, one move every STEP_MS: from the grip down the canvas, into the band along its bottom edge,
 *  held there (a hand never holds still: a pixel either way each move) while the page scrolls under it, then back up
 *  to the middle of the canvas, where it is let go. */
export const DRAG_MOVES = { down: 10, toEdge: 15, hold: 120, back: 15 } as const;
/** How far inside the bottom edge the pointer is held: halfway into the 56 px band, about 440 px a second. */
const DRAG_EDGE_INSET = 28;
/** How far the page must have scrolled under the held pointer, in the page's pixels. */
const DRAG_MIN_SCROLL = 300;

/** The editor's mark for one edge of `drag`'s window, in one attempt (any attempt without one). */
const atDrag =
  (edge: 'start' | 'end', attempt?: number) =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.scenario === 'drag' && r.attrs?.edge === edge && (attempt === undefined || r.attrs?.attempt === attempt);

/** The page's sections, by ID, from the project the editor holds. */
const homeRoots = async (win: Page, pageId: string): Promise<{ revision: number; roots: string[]; names: string[] }> => {
  const s = await snapshotOf(win);
  expect(s, 'no project is open');
  const page = s.state.pages[pageId];
  return { revision: s.revision, roots: page.rootIds, names: page.rootIds.map((id) => displayName(s.state, page.nodes[id])) };
};

export const drag: Scenario = {
  name: 'drag',
  after: 'open',
  description: 'Pick up the home hero by its grip, hold it in the band along the canvas’s bottom edge while the page scrolls, then let it go in the middle of the canvas, and check it moved where the drop line said.',
  async run(ctx) {
    const { win, fixture } = ctx;
    const before = await snapshotOf(win);
    expect(before, 'no project is open');
    const shownHeading = findHeading(before.state.pages[fixture.homePageId], fixture.heroId)?.heading ?? fixture.heading;
    const frame = preview(win);
    const selectHero = () =>
      undisturbed(ctx, 'selecting the hero', async () => {
        for (let i = 0; i < 4 && (await heroChip(win).count()); i++) await win.keyboard.press('Escape');
        await frame.locator('html').evaluate(() => (globalThis as unknown as { scrollTo(o: object): void }).scrollTo({ top: 0, behavior: 'instant' }));
        await frame.getByRole('heading', { name: shownHeading, exact: true, level: 1 }).first().click({ timeout: 15_000 });
        await heroChip(win).waitFor({ timeout: 15_000 });
      });
    await settledAgain(ctx);
    await selectHero();
    const periodMs = await framePeriod(win);
    expect(Number.isFinite(periodMs) && periodMs > 0, 'the editor drew no frames at rest');
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await settledAgain(ctx);
    await ctx.mark('scenario.start', { scenario: 'drag', periodMs });
    const initial = await homeRoots(win, fixture.homePageId);
    /** One attempt at the drag, checked; it returns when it let go. */
    const once = async (attempt: number, released: { at: number }) => {
      const was = await homeRoots(win, fixture.homePageId);
      const from = was.roots.indexOf(fixture.heroId);
      expect(from >= 0, 'the home hero is not one of the home page’s sections');
      expect(await heroChip(win).count(), `the ${HERO_NAME} is not selected before the drag`);
      await frame.locator('html').evaluate(() => (globalThis as unknown as { scrollTo(o: object): void }).scrollTo({ top: 0, behavior: 'instant' }));
      expect((await settledScroll(frame)) === 0, 'the page would not go back to its top before the drag');
      await sleep(500);
      const grip = await win.locator('.ov-chip [aria-label="Drag to move"]').boundingBox();
      expect(grip, 'the selection’s chip shows no grip to drag it by');
      const v = await win.locator('.canvas-scroll').boundingBox();
      const w = await win.locator('.frame-wrap').boundingBox();
      expect(v && w, 'the canvas has no box');
      const x = w.x + w.width / 2;
      const top = Math.max(v.y, w.y);
      const bottom = Math.min(v.y + v.height, w.y + w.height);
      const path = (x0: number, y0: number, x1: number, y1: number, n: number) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * (i + 1)) / n, y: y0 + ((y1 - y0) * (i + 1)) / n }));
      const edgeY = bottom - DRAG_EDGE_INSET;
      const scrollY = () => frame.locator('html').evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY);
      const moves = async (list: Array<{ x: number; y: number }>) => {
        for (const p of list) {
          await input(win.mouse.move(p.x, p.y), 'a pointer move');
          await sleep(STEP_MS);
        }
      };
      await win.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await watchFrames(win);
      await ctx.mark('drag.window', { scenario: 'drag', edge: 'start', attempt });
      let shown: { label: string; line: Box | null; scrolled: number };
      let pressed = false;
      try {
        await input(win.mouse.down(), 'the press on the grip');
        pressed = true;
        await moves([...path(grip.x + grip.width / 2, grip.y + grip.height / 2, x, top + 200, DRAG_MOVES.down), ...path(x, top + 200, x, edgeY, DRAG_MOVES.toEdge)]);
        // Scrolled while held in the band, not only on the way into it.
        const atEdge = await scrollY();
        await moves(Array.from({ length: DRAG_MOVES.hold }, (_, i) => ({ x: x + (i % 2 ? 1 : -1), y: edgeY })));
        const held = (await scrollY()) - atEdge;
        expect(held >= DRAG_MIN_SCROLL, `held in the band along the bottom edge, the page scrolled ${held}px, short of ${DRAG_MIN_SCROLL}px`);
        await moves(path(x, edgeY, x, (top + bottom) / 2, DRAG_MOVES.back));
        // Long enough for the lists measured where the page now shows to land: the release then drops by them.
        await sleep(400);
        const label = (await win.locator('[data-testid="insert-drop-label"] .what').first().textContent({ timeout: 5_000 })) ?? '';
        const line = await win.locator('[data-testid="insert-drop-line"]').first().boundingBox({ timeout: 5_000 }).catch(() => null);
        const scrolled = await scrollY();
        shown = { label: label.trim(), line, scrolled };
        released.at = Date.now();
        pressed = false;
        await input(win.mouse.up(), 'the release');
      } finally {
        await ctx.mark('drag.window', { scenario: 'drag', edge: 'end', attempt, ...(await framesSeen(win, periodMs)) });
        // An attempt that failed holding the grip lets it go without a drop, so the next starts with nothing held.
        if (pressed) {
          await win.keyboard.press('Escape').catch(() => undefined);
          await win.mouse.up().catch(() => undefined);
        }
      }
      // The page scrolled under the held pointer, the line showed where the drop goes, inside what the canvas shows, and
      // the release moved the hero there, as one change.
      expect(shown.scrolled >= DRAG_MIN_SCROLL, `held at the bottom edge, the page scrolled ${shown.scrolled}px, short of ${DRAG_MIN_SCROLL}px`);
      expect(shown.line, 'no drop line showed where the drag was let go');
      expect(shown.line.y >= top - 1 && shown.line.y + shown.line.height <= bottom + 1, `the drop line (${Math.round(shown.line.y)}) was outside the canvas (${Math.round(top)}–${Math.round(bottom)})`);
      const lead = `${HERO_NAME} after `;
      expect(shown.label.startsWith(lead), `the drag said “${shown.label}” as it was let go, not where the ${HERO_NAME} would go`);
      let now = was;
      for (let i = 0; i < 100 && now.revision === was.revision; i++) {
        await sleep(100);
        now = await homeRoots(win, fixture.homePageId);
      }
      expect(now.revision === was.revision + 1, `the drop left the project at revision ${now.revision}, not ${was.revision + 1}`);
      const to = now.roots.indexOf(fixture.heroId);
      expect(to >= from + 2, `the ${HERO_NAME} went from section ${from + 1} to ${to + 1}, not down the page where the scroll took it`);
      expect(now.names[to - 1] === shown.label.slice(lead.length), `the ${HERO_NAME} landed after ${now.names[to - 1]}, not after ${shown.label.slice(lead.length)} as the drag said`);
      const others = (roots: string[]) => roots.filter((id) => id !== fixture.heroId).join();
      expect(others(now.roots) === others(was.roots), 'the drop moved or changed other sections of the home page');
    };
    // Done again when the preview loaded a page or the project was read from disk before the release (see WINDOW_TRIES),
    // from the project as the first attempt found it. What the drop's own save sets off afterwards is the drag's.
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now() - 100;
      const released = { at: Infinity };
      let failed: unknown = null;
      try {
        await once(attempt, released);
      } catch (e) {
        failed = e;
      }
      await sleep(500);
      if (!reloadedIn(await ctx.waitTrace(() => true, 0), t0, Math.min(released.at, Date.now()))) {
        if (failed) throw failed;
        break;
      }
      if (attempt >= WINDOW_TRIES) throw new Error(`the preview reloaded during the drag ${WINDOW_TRIES} times (the project’s files kept changing on disk)`);
      await settledAgain(ctx);
      if ((await homeRoots(win, fixture.homePageId)).roots.join() !== initial.roots.join()) {
        await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.undo());
        for (let i = 0; (await homeRoots(win, fixture.homePageId)).roots.join() !== initial.roots.join(); i++) {
          expect(i < 100, 'an undo did not put the hero back before the drag was done again');
          await sleep(100);
        }
        await settledAgain(ctx);
      }
      await selectHero();
    }
    await sleep(ctx.settleMs);
    await ctx.mark('scenario.end', { scenario: 'drag' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('drag', 'renderer')) && !!t.first('scenario.end', forScenario('drag', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('drag', 'renderer')));
    const period = begin?.attrs?.periodMs;
    if (typeof period === 'number') m.ms('drag.framePeriodMs', period);
    else m.need('scenario.start (renderer, with the frame period)', undefined);
    // The last attempt: any before it had a reload during it, and was done again.
    const starts = trace.all('drag.window', atDrag('start'));
    const lastAttempt = Math.max(...starts.map((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0)));
    const start = m.need('drag.window start', starts.find((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0) === lastAttempt));
    const end = m.need('drag.window end', start && trace.first('drag.window', atDrag('end', start.attrs?.attempt as number)));
    if (!start || !end) return m;
    const gained = (name: string) => counter(end, name) - counter(start, name);
    m.since('drag.ms', start, end);
    m.count('drag.canvasRenders', gained('canvas.renders'));
    m.count('drag.dropShows', gained('canvas.dropShows'));
    m.count('drag.measures', gained('canvas.dropMeasures'));
    m.count('drag.listsMeasured', gained('canvas.dropMeasured'));
    m.count('drag.scrollSteps', gained('canvas.dropScrolls'));
    commits(m, trace, 'drag.rendererCommits', start, end);
    if (trackless(start) || trackless(end)) m.need('drag.renders (the editor did not count component renders)', undefined);
    else m.count('drag.renders', gained('react.renders'));
    // Each measure of the page's lists, from asking to the last batch's answer.
    const measured = trace.all('canvas.dropMeasure', inProc('renderer'), start.t, end.t);
    if (!measured.length) m.need('canvas.dropMeasure (no list measured in the drag)', undefined);
    else m.ms('drag.measureMs', median(measured.map((r) => (typeof r.attrs?.ms === 'number' ? r.attrs.ms : NaN))));
    for (const k of ['frames', 'droppedFrames', 'longTasks'] as const) {
      const v = end.attrs?.[k];
      if (typeof v === 'number') m.count(`drag.${k}`, v);
      else m.need(`drag.${k} (the frame watch)`, undefined);
    }
    const frames = end.attrs?.frames;
    if (typeof frames === 'number' && typeof period === 'number' && frames < (end.t - start.t) / period / 2) m.need(`drag.frames (the frame watch saw ${frames} frames in ${Math.round(end.t - start.t)} ms)`, undefined);
    // The editor's mean frame time over the drag: what a dropped frame or a long one adds to the period.
    if (typeof frames === 'number' && frames > 0) m.ms('drag.frameMs', (end.t - start.t) / frames);
    for (const k of ['longTaskMs', 'longestFrameMs'] as const) {
      const v = end.attrs?.[k];
      if (typeof v === 'number') m.ms(`drag.${k}`, v);
      else m.need(`drag.${k} (the frame watch)`, undefined);
    }
    return m;
  }
};

// ---------------------------------------------------------------------------
// colour
// ---------------------------------------------------------------------------

/** `colour`'s drag in the native picker: this many steps, one every STEP_MS, around the hue circle. */
export const COLOUR_STEPS = 60;
/** The picker's steps: hues 5° apart at one saturation and lightness, as six-digit hex the picker reports. */
export function colourPath(steps = COLOUR_STEPS): string[] {
  const hex = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16)
        .padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  return Array.from({ length: steps }, (_, i) => hex((i * 5) % 360, 0.65, 0.45));
}
/** A six-digit hex as the browser reports a computed colour. */
const rgbOf = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

/** The editor's mark for one point of `colour`'s window, in one attempt (any attempt without one). */
const atColour =
  (point: 'start' | 'release' | 'settled', attempt?: number, proc: 'main' | 'renderer' = 'renderer') =>
  (r: PerfRecord): boolean =>
    r.proc === proc && r.attrs?.scenario === 'colour' && r.attrs?.point === point && (attempt === undefined || r.attrs?.attempt === attempt);

/** The most spans of `spans` running at once. */
export function deepest(spans: PerfRecord[]): number {
  const edges = spans.flatMap((r) => [
    { t: r.t - (r.ms ?? 0), d: 1 },
    { t: r.t, d: -1 }
  ]);
  // An end before a start at the same time: one that ends as another starts was not running beside it.
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let now = 0;
  let most = 0;
  for (const e of edges) most = Math.max(most, (now += e.d));
  return most;
}

const BRAND = 'color.brand';

export const colour: Scenario = {
  name: 'colour',
  after: 'open',
  description: 'In Site styles, drag the Brand color’s native picker around the hue circle and let go, until the preview shows the last color picked; check it is saved as one step that one undo takes back.',
  async run(ctx) {
    const { win, projectDir } = ctx;
    const frame = preview(win);
    const path = colourPath();
    const last = path[path.length - 1];
    if (!(await win.locator('#editor-dock').isVisible())) await win.getByRole('button', { name: 'Right panel', exact: true }).click();
    await win.locator('.dock-tab', { hasText: 'Styles' }).click();
    const section = win.locator('#dock-panel-styles .section').filter({ has: win.locator('button.section-head', { hasText: 'Basics' }) });
    const picker = section.locator('[data-ss-row]').first().locator('input[type="color"]');
    await picker.waitFor({ timeout: 15_000 });
    const cta = () => frame.locator('.so-btn--primary').first().evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(el).backgroundColor);
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await settledAgain(ctx);
    await ctx.mark('scenario.start', { scenario: 'colour' });
    // Never done again on a reload: the drag's own saves can set one off, and that is the drag's cost.
    await (async (attempt: number) => {
      const was = await snapshotOf(win);
      expect(was, 'no project is open');
      const wasValue = was.state.tokens.overrides[BRAND];
      const wasSteps = was.history.entries.length;
      const wasPaint = await cta();
      expect(wasPaint !== rgbOf(last), `the preview already shows ${last} before the drag`);
      await ctx.mark('colour.window', { scenario: 'colour', point: 'start', attempt });
      // The native picker's drag: an input event for each step, then a change event as it is let go.
      for (const hex of path) {
        await input(
          picker.evaluate((el, hex) => {
            const input = el as unknown as { dispatchEvent(e: Event): boolean };
            // Through the element's own setter, as the picker sets it: React reads a change from it.
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, hex);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }, hex),
          'a step of the picker'
        );
        await sleep(STEP_MS);
      }
      await input(
        picker.evaluate((el) => void (el as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent(new Event('change', { bubbles: true }))),
        'the picker let go'
      );
      await ctx.mark('colour.window', { scenario: 'colour', point: 'release', attempt });
      // Settled: the last colour picked saved and on the page, every save landed, the revision still.
      const deadline = Date.now() + 120_000;
      let at = was.revision;
      for (;;) {
        const s = await snapshotOf(win);
        expect(s, 'the project closed during the colour drag');
        const saving = (await win.locator('.toolbar .save-state').innerText().catch(() => '')) !== 'Saved';
        if (!saving && s.revision === at && s.state.tokens.overrides[BRAND] === last && (await cta()) === rgbOf(last)) break;
        at = s.revision;
        expect(Date.now() < deadline, `two minutes after the picker was let go, the project holds ${String(s.state.tokens.overrides[BRAND])} at revision ${s.revision}, not ${last}`);
        await sleep(100);
      }
      await ctx.mark('colour.window', { scenario: 'colour', point: 'settled', attempt, revision: at });
      const after = await snapshotOf(win);
      expect(after, 'the project closed during the colour drag');
      expect(after.state.tokens.overrides[BRAND] === last, `the project holds ${String(after.state.tokens.overrides[BRAND])}, not the last color picked (${last})`);
      expect((await picker.inputValue()) === last, `the picker shows ${await picker.inputValue()}, not the last color picked (${last})`);
      const onDisk = JSON.parse(readFileSync(join(projectDir, 'siteorigin', 'tokens.json'), 'utf8')) as { overrides?: Record<string, unknown> };
      expect(onDisk.overrides?.[BRAND] === last, `tokens.json on disk holds ${String(onDisk.overrides?.[BRAND])}, not ${last}`);
      expect(after.history.entries.length === wasSteps + 1, `the drag made ${after.history.entries.length - wasSteps} steps in History, not one`);
      // Not timed: one undo takes the whole drag back, in the project and on the page.
      await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.undo());
      for (let i = 0; ; i++) {
        const s = await snapshotOf(win);
        expect(s, 'the project closed after the colour drag');
        if (s.state.tokens.overrides[BRAND] === wasValue && (await cta()) === wasPaint) break;
        expect(i < 300, `one undo left ${String(s.state.tokens.overrides[BRAND])} and the preview at ${await cta()}, not the color before the drag (${String(wasValue)}, ${wasPaint})`);
        await sleep(100);
      }
    })(1);
    await sleep(ctx.settleMs);
    await ctx.mark('scenario.end', { scenario: 'colour' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('colour', 'renderer')) && !!t.first('scenario.end', forScenario('colour', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const starts = trace.all('colour.window', atColour('start'));
    const lastAttempt = Math.max(...starts.map((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0)));
    const start = m.need('colour.window start', starts.find((r) => (typeof r.attrs?.attempt === 'number' ? r.attrs.attempt : 0) === lastAttempt));
    const attempt = start?.attrs?.attempt as number;
    const release = m.need('colour.window release', start && trace.first('colour.window', atColour('release', attempt)));
    const settled = m.need('colour.window settled', start && trace.first('colour.window', atColour('settled', attempt)));
    if (!start || !release || !settled) return m;
    const revision = settled.attrs?.revision;
    m.since('colour.dragMs', start, release);
    // Every edit the main process took in, from the drag's first step until everything settled.
    const applies = trace.all('controller.apply', inProc('main'), start.t, settled.t);
    if (!applies.length) m.need('controller.apply (no edit in the colour drag)', undefined);
    m.count('colour.applies', applies.length);
    const during = applies.filter((r) => r.t - (r.ms ?? 0) <= release.t).length;
    // The page follows the picker while it is held: a drag saved only once let go shows nothing as it is dragged.
    if (applies.length && !during) m.need('controller.apply begun before the picker was let go (the drag was saved only once it ended)', undefined);
    m.count('colour.appliesPerSecond', Math.round((during / ((release.t - start.t) / 1000)) * 10) / 10);
    m.count('colour.queueDeepest', deepest(applies));
    // The main process's own counters across the window: the edits overlap, and each span's would count the others'.
    const mainStart = m.need('colour.window start (main)', trace.first('colour.window', atColour('start', attempt, 'main')));
    const mainSettled = m.need('colour.window settled (main)', trace.first('colour.window', atColour('settled', attempt, 'main')));
    for (const [name, c] of [['durableWrites', 'fs.durableWrites'], ['fsyncs', 'fs.fsyncs'], ['fileWrites', 'fs.writes']] as const) if (mainStart && mainSettled) m.count(`colour.${name}`, counter(mainSettled, c) - counter(mainStart, c));
    const lastApply = applies[applies.length - 1];
    if (lastApply) m.ms('colour.lastSaveMs', Math.max(0, lastApply.t - release.t));
    // From the picker let go to the preview showing the project as it settled.
    const shown = m.need('canvas.revisionApplied (the settled revision)', typeof revision === 'number' ? trace.first('canvas.revisionApplied', atRevision(revision), start.t) : undefined);
    if (shown) m.ms('colour.settleMs', Math.max(0, shown.t - release.t));
    m.count('colour.previewUpdates', trace.all('canvas.revisionApplied', inProc('renderer'), start.t, settled.t).length);
    const sent = trace.all('controller.snapshotSent', inProc('main'), start.t, settled.t);
    m.count('colour.snapshotsSent', sent.length);
    bytesSent(m, 'colour.snapshotBytes', sent);
    commits(m, trace, 'colour.rendererCommits', start, settled);
    m.ms('colour.mainStallMax', stallMax(trace, start, settled));
    return m;
  }
};

// ---------------------------------------------------------------------------
// editFullHistory
// ---------------------------------------------------------------------------

/** The headings the edits that fill History set, numbered, so each is a step of its own and the last is known. */
const FILLER_HEADING = 'Filler heading';
/** What the timed edit types, never what `edit` typed before it in the same launch. */
const FULL_HISTORY_HEADING = 'Full History heading';

export const editFullHistory: Scenario = {
  name: 'editFullHistory',
  after: 'open',
  description: `Fill History to its limit of ${HISTORY_LIMIT} steps (untimed), then change the home hero’s Heading in the Inspector, so the edit lets the oldest step go, and wait for the preview to show it.`,
  async run(ctx) {
    const { win, fixture } = ctx;
    // Not what is measured: each filler is an edit of its own through the editor's API, as an AI batch or a script
    // makes them, without the Inspector's joining of quick edits to one field.
    const failed = await win.evaluate(
      async ([pageId, nodeId, steps, text]) => {
        const project = (globalThis as unknown as EditorPage).builder.project;
        for (let i = 1; i <= steps; i++) {
          const r = await project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'heading', value: `${text} ${i}` }] }, { label: 'Benchmark filler' });
          if (!r.ok) return `filler edit ${i} was refused: ${r.error?.message ?? 'no reason given'}`;
        }
        return null;
      },
      [fixture.homePageId, fixture.heroId, HISTORY_LIMIT, FILLER_HEADING] as const
    );
    expect(failed === null, failed ?? '');
    const filled = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    const steps = filled?.history.entries ?? [];
    expect(steps.length === HISTORY_LIMIT && steps.every((e) => e.applied), `History holds ${steps.length} steps before the edit, not ${HISTORY_LIMIT} applied ones`);
    await preview(win).getByRole('heading', { name: `${FILLER_HEADING} ${HISTORY_LIMIT}`, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
    const oldest = steps[0].id;
    await editHeroHeading(ctx, 'editFullHistory', FULL_HISTORY_HEADING, (after, target) => {
      const entries = after.history.entries;
      expect(entries.length === HISTORY_LIMIT, `History holds ${entries.length} steps after the edit, not ${HISTORY_LIMIT}`);
      expect(entries[entries.length - 1]?.revision === target && entries[entries.length - 1]?.applied, 'the edit is not History’s last applied step');
      expect(!entries.some((e) => e.id === oldest), 'History kept its oldest step past its limit');
    });
  },
  measure: (trace) => measureEdit(trace, 'editFullHistory')
};

// ---------------------------------------------------------------------------
// ai
// ---------------------------------------------------------------------------

/** Pages the scripted run changes directly (the first that have a placement with a Heading), and pages its request names besides. */
export const AI_EDITED_PAGES = 3;
export const AI_NAMED_PAGES = 4;
/** The brand colour the run sets: a change every page shows. */
export const AI_BRAND = '#1f3a8a';
export const aiHeading = (heading: string) => `${heading} (sharper)`;
const AI_RUN_MS = 240_000;

export interface AiPlan {
  /** The pages it edits: each's first section repeated (so a page loaded before the change is missing a section) and its first Heading changed. */
  edited: Array<{ pageId: string; title: string; nodeId: string; heading: string; firstRoot: string }>;
  /** The pages the request names, which the preview check samples for the brand colour. */
  named: Array<{ pageId: string; title: string }>;
  request: string;
  operations: unknown[];
}

/** What the scripted run asks for and does, from the project as it is before the request. */
export function aiPlan(state: ProjectState): AiPlan {
  const order = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id));
  const edited = order
    .map((pageId) => ({ pageId, page: state.pages[pageId], hero: findHeading(state.pages[pageId]) }))
    .filter((p) => p.hero && p.page.rootIds.length)
    .slice(0, AI_EDITED_PAGES)
    .map(({ pageId, page, hero }) => ({ pageId, title: page.title, nodeId: hero!.id, heading: hero!.heading, firstRoot: page.rootIds[0] }));
  const named = order
    .filter((id) => !edited.some((e) => e.pageId === id))
    .slice(0, AI_NAMED_PAGES)
    .map((pageId) => ({ pageId, title: state.pages[pageId].title }));
  const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const request = `Give the site a deeper brand colour, and on ${list(edited.map((e) => e.title))} repeat the opening section and sharpen its heading.${named.length ? ` Check that ${list(named.map((n) => n.title))} still look right.` : ''}`;
  const operations = [
    { type: 'token.set', tokenId: 'color.brand', value: AI_BRAND },
    ...edited.flatMap((e) => [
      { type: 'node.duplicate', owner: { kind: 'page', id: e.pageId }, nodeId: e.firstRoot },
      { type: 'instance.setProp', owner: { kind: 'page', id: e.pageId }, nodeId: e.nodeId, prop: 'heading', value: aiHeading(e.heading) }
    ])
  ];
  return { edited, named, request, operations };
}

/** One reply carrying several native tool calls, as a model asking for independent reads at once sends them. */
export function toolCallsReply(calls: Array<{ id: string; name: string; args: unknown }>): MockReply {
  return {
    frames: [
      sseChunk({ role: 'assistant', content: null }),
      ...calls.flatMap((c, index) => [sseChunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }), sseChunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }] })]),
      sseChunk({}, 'tool_calls'),
      DONE
    ]
  };
}

/** A measurement of a page for the assistant: main's request and answer, and the editor's loads of the page for it. */
export interface AiMeasurement {
  start: number;
  end: number;
  ok: boolean;
  /** The project revision the page was checked at, as main asked. */
  revision: number;
  /** When the page answered its last load. */
  answered: number;
  /** Before the first load: getting the request to the editor and any wait for the preview. */
  settleMs: number;
  /** Each load's frame set going until the page said it was ready, added up. */
  loadMs: number;
  /** Each ready page until it answered (or its deadline), added up. */
  measureMs: number;
  /** Of that, what the page waited for before measuring (each load's, added up): its images, its web fonts, then a frame. */
  waitImagesMs: number;
  waitFontsMs: number;
  waitFrameMs: number;
  /** A second load because the first looked behind, and the wait before it. */
  retried: boolean;
  retryWaitMs: number;
}

/** Every measurement main asked the editor for in [from, to], each with the editor's loads for it; null when a load's marks are missing. */
export function aiMeasurements(trace: Trace, from: number, to: number): AiMeasurement[] | null {
  const out: AiMeasurement[] = [];
  for (const r of trace.all('ai.inspect', inProc('main'), from, to)) {
    const req = r.attrs?.req;
    const start = r.t - (r.ms ?? NaN);
    const mine = (name: string) => trace.all(name, (x) => x.proc === 'renderer' && x.attrs?.req === req);
    const loads = mine('inspect.load');
    const ready = mine('inspect.ready');
    const done = mine('inspect.done');
    if (!loads.length || done.length !== loads.length || loads.length > 2) return null;
    const at = (xs: PerfRecord[], attempt: number) => xs.find((x) => x.attrs?.attempt === attempt);
    let loadMs = 0;
    let measureMs = 0;
    const waits = { images: 0, fonts: 0, frame: 0 };
    for (const l of loads) {
      const attempt = l.attrs?.attempt as number;
      const d = at(done, attempt);
      const rd = at(ready, attempt);
      if (!d) return null;
      // A page that never said it was ready spent its whole time loading.
      loadMs += (rd ?? d).t - l.t;
      measureMs += rd ? d.t - rd.t : 0;
      // A page that answered nothing of its waits (an error) waited for none of them.
      for (const k of ['images', 'fonts', 'frame'] as const) if (typeof d.attrs?.[k] === 'number') waits[k] += d.attrs[k] as number;
    }
    const first = at(loads, 1);
    const second = at(loads, 2);
    if (!first) return null;
    out.push({ start, end: r.t, ok: r.attrs?.ok === true, revision: typeof r.attrs?.revision === 'number' ? r.attrs.revision : NaN, answered: at(done, loads.length)?.t ?? NaN, settleMs: first.t - start, loadMs, measureMs, waitImagesMs: waits.images, waitFontsMs: waits.fonts, waitFrameMs: waits.frame, retried: !!second, retryWaitMs: second ? second.t - (at(done, 1)?.t ?? NaN) : 0 });
  }
  return out;
}

/** A run's measurements, and those made by its page checks the model asked for, before its batch landed and at its finish. */
export function aiPhases(trace: Trace, run: PerfRecord): { all: AiMeasurement[]; tool: AiMeasurement[]; baseline: AiMeasurement[]; final: AiMeasurement[]; baselines: PerfRecord[]; finals: PerfRecord[] } | null {
  const from = run.t - (run.ms ?? NaN);
  const all = aiMeasurements(trace, from, run.t);
  if (!all) return null;
  const within = (spans: PerfRecord[]) => (x: AiMeasurement) => spans.some((s) => x.start >= s.t - (s.ms ?? 0) && x.end <= s.t);
  const baselines = trace.all('ai.baselines', inProc('main'), from, run.t);
  const finals = trace.all('ai.finalCheck', inProc('main'), from, run.t);
  const inspectTools = trace.all('ai.tool', (r) => r.proc === 'main' && r.attrs?.tool === 'inspect_layout', from, run.t);
  return { all, tool: all.filter(within(inspectTools)), baseline: all.filter(within(baselines)), final: all.filter(within(finals)), baselines, finals };
}

/** How long at least one of these stretches was under way: overlapping ones count once. */
export function coveredMs(stretches: Array<{ start: number; end: number }>): number {
  let total = 0;
  let reach = -Infinity;
  for (const s of [...stretches].sort((a, b) => a.start - b.start)) {
    if (s.end <= reach) continue;
    total += s.end - Math.max(s.start, reach);
    reach = s.end;
  }
  return total;
}

/** The latest conversation saved for this project that holds `request`, with its last message. */
function savedRun(chatDir: string, request: string): ChatMessage | null {
  if (!existsSync(chatDir)) return null;
  for (const f of readdirSync(chatDir).filter((n) => n.endsWith('.json'))) {
    const conv = JSON.parse(readFileSync(join(chatDir, f), 'utf8')) as Conversation;
    const i = conv.messages.findIndex((m) => m.role === 'user' && m.text === request);
    if (i >= 0) return conv.messages.at(-1) ?? null;
  }
  return null;
}

export const ai: Scenario = {
  name: 'ai',
  after: 'open',
  description: 'Ask the assistant (a scripted model) for a site-wide change: one turn of reads and page checks together, one batch of changes, and the preview check before it finishes.',
  deadlineMs: AI_RUN_MS + 60_000,
  async run(ctx) {
    const { win } = ctx;
    const server = await new MockOpenAIServer().start();
    try {
      // The scripted model in native tool mode, which may ask for several calls at once; set untimed, as the reload is.
      await win.evaluate((url) => (globalThis as unknown as EditorPage).builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: url, allowRemote: false, toolMode: 'native', contextWindow: 131_072 } } } as never), server.baseURL);
      await win.reload();
      await win.locator('.editor').waitFor({ timeout: 60_000 });
      await preview(win).locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60_000 });
      await win.locator('.dock-tab', { hasText: 'AI' }).first().click();
      await composer(win).waitFor({ timeout: 15_000 });
      // An edit of the whole site, as a person picks it in the composer.
      const ask = win.getByRole('button', { name: /^What your next message does: Ask/ });
      if (await ask.count()) {
        await ask.first().click();
        await win.getByRole('menuitemradio', { name: /^Edit/ }).click();
      }
      await win.getByRole('button', { name: /^What the AI may change:/ }).first().click();
      await win.getByRole('menuitemradio', { name: /^Whole site/ }).or(win.getByRole('menuitem', { name: /^Whole site/ })).first().click();
      await expectChip(win);
      const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
      expect(before, 'no project is open');
      const plan = aiPlan(before.state);
      expect(plan.edited.length > 0, 'the fixture has no page with a Heading to change');
      await composer(win).fill(plan.request);
      // Choosing the mode and scope saves the workspace 300 ms later: that lands before the request is sent.
      await sleep(WORKSPACE_SAVE_WAIT_MS);
      // Reads and page checks in one response, then one batch of changes, then the answer.
      server.script(
        toolCallsReply([...plan.edited.map((e, i) => ({ id: `call_read${i}`, name: 'read_page', args: { pageId: e.pageId } })), ...plan.edited.map((e, i) => ({ id: `call_inspect${i}`, name: 'inspect_layout', args: { pageId: e.pageId, viewport: 'desktop' } }))]),
        toolCallReply('apply_operations', { expectedRevision: before.revision, operations: plan.operations }, { id: 'call_apply' }),
        textReply('The brand colour is deeper, and those pages open with their first section twice and a sharper heading.')
      );
      // Anything the app asks the model after that (a nudge to finish) is answered as done.
      server.respond = () => textReply('Done.');
      await ctx.mark('scenario.start', { scenario: 'ai' });
      await ctx.mark('ai.requested');
      await win.keyboard.press('Enter');
      await win.waitForFunction(() => !!(globalThis as unknown as DomPage).document.querySelector('.run-strip'), undefined, { timeout: 30_000 });
      await win.waitForFunction(() => !(globalThis as unknown as DomPage).document.querySelector('.run-strip'), undefined, { timeout: AI_RUN_MS, polling: 100 });
      await ctx.mark('ai.finished');
      // The run did its job: finished, its batch landed whole, in the project, on disk and in the preview.
      const chatDir = join(ctx.projectDir, '.siteorigin', 'sessions', 'chat');
      const end = Date.now() + 15_000;
      let result = savedRun(chatDir, plan.request)?.result;
      while (!result && Date.now() < end) {
        await sleep(100);
        result = savedRun(chatDir, plan.request)?.result;
      }
      expect(result, 'the run’s result was not saved with its conversation');
      expect(result.status === 'completed', `the run ended ${result.status}: ${result.summary}`);
      // The scripted three steps and nothing more: a run that took a repair turn, or stopped short, is another run.
      const asked = server.requests.filter((q) => q.method === 'POST').length;
      expect(asked === 3, `the run asked the model ${asked} times, not 3`);
      const unchecked = (result.checks ?? []).filter((c) => /could not|couldn.t|not caught up/i.test(c.text));
      expect(!unchecked.length, `the preview check did not run on every page: ${unchecked.map((c) => c.text).join(' ')}`);
      const after = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
      expect(after && after.revision === before.revision + 1, `the run left the project at revision ${after?.revision}, not ${before.revision + 1}`);
      expect((after.state.tokens.overrides as Record<string, unknown>)['color.brand'] === AI_BRAND, 'the project does not hold the new brand colour');
      const tokensDoc = join(ctx.projectDir, 'siteorigin', 'tokens.json');
      expect(existsSync(tokensDoc) && readFileSync(tokensDoc, 'utf8').includes(AI_BRAND), 'the tokens document on disk does not hold the new brand colour');
      for (const e of plan.edited) {
        const page = after.state.pages[e.pageId];
        expect(page.rootIds.length === before.state.pages[e.pageId].rootIds.length + 1, `${e.title} does not have its first section twice`);
        expect(findHeading(page, e.nodeId)?.heading === aiHeading(e.heading), `${e.title} does not hold its new heading`);
        const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${e.pageId}.json`);
        const saved = existsSync(doc) ? (JSON.parse(readFileSync(doc, 'utf8')) as unknown) : null;
        expect(findHeading(saved, e.nodeId)?.heading === aiHeading(e.heading), `${e.title}’s document on disk does not hold its new heading`);
      }
      const home = plan.edited.find((e) => e.pageId === before.state.site.homePageId);
      if (home) await preview(win).getByText(aiHeading(home.heading), { exact: true }).first().waitFor({ timeout: 30_000 });
      // Every page the run checked, this run's (not an earlier one's in the same launch): its reads' turn checked the
      // pages it edits at desktop width; before the batch landed, each page it reaches as it was, at phone width (and
      // desktop for those its reads had not); the finish every page it changed or the request named; each answered.
      const requested = (t: Trace) => t.first('ai.requested', inProc('main'));
      const runOf = (t: Trace) => t.first('ai.run', inProc('main'), requested(t)?.t ?? Infinity);
      const t = await ctx.waitTrace((t) => !!runOf(t), 15_000);
      const run = runOf(t);
      expect(run, 'the run’s span is not in the trace');
      const phases = aiPhases(t, run);
      expect(phases, 'a measurement’s loads are missing from the trace');
      const failed = phases.all.filter((m) => !m.ok).length;
      expect(!failed, `${failed} of ${phases.all.length} measurements of the preview did not answer`);
      const [edited, named] = [plan.edited.length, plan.named.length];
      const want = { tool: edited, baseline: edited + 2 * named, final: edited + named };
      for (const k of ['tool', 'baseline', 'final'] as const) expect(phases[k].length === want[k], `the run made ${phases[k].length} ${k} measurements, not ${want[k]}`);
      // No page checked after the change answered before the preview had it: a check that read the page from before
      // the edit and came back at once would be fast and wrong.
      const landed = before.revision + 1;
      const published = t.first('runtime.published', (r) => r.proc === 'main' && typeof r.attrs?.revision === 'number' && r.attrs.revision >= landed, run.t - (run.ms ?? 0));
      const early = phases.all.filter((m) => m.revision >= landed && !(published && m.answered >= published.t));
      expect(!early.length, `${early.length} measurements after the change answered before the preview published it`);
      await sleep(ctx.settleMs);
      await ctx.mark('scenario.end', { scenario: 'ai' });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('ai', 'renderer')) && !!t.first('scenario.end', forScenario('ai', 'main')));
    } finally {
      await server.stop();
    }
  },
  measure(trace) {
    const m = new Collector();
    const req = m.need('ai.requested (main)', trace.first('ai.requested', inProc('main')));
    const run = m.need('ai.run', trace.first('ai.run', inProc('main'), req?.t ?? Infinity));
    if (!req || !run) return m;
    const from = run.t - (run.ms ?? NaN);
    m.span('ai.runMs', run);
    m.since('ai.replyMs', req, run);
    const phases = aiPhases(trace, run);
    if (!phases) {
      m.need('inspect.load / inspect.done (a measurement’s loads)', undefined);
      return m;
    }
    const { all, baselines, finals } = phases;
    m.need('ai.baselines', baselines[0]);
    m.need('ai.finalCheck', finals[0]);
    m.count('ai.measurements', all.length);
    m.count('ai.toolMeasurements', phases.tool.length);
    m.count('ai.baselineMeasurements', phases.baseline.length);
    m.count('ai.finalMeasurements', phases.final.length);
    m.count('ai.retries', all.filter((x) => x.retried).length);
    const sum = (f: (x: AiMeasurement) => number) => all.reduce((n, x) => n + f(x), 0);
    m.ms('ai.measureMsSum', sum((x) => x.end - x.start));
    const wall = coveredMs(all);
    m.ms('ai.measureWallMs', wall);
    if (typeof run.ms === 'number' && run.ms > 0) m.share('ai.measureShare', wall / run.ms);
    m.ms('ai.settleMs', median(all.map((x) => x.settleMs)));
    m.ms('ai.loadMs', median(all.map((x) => x.loadMs)));
    m.ms('ai.measureMs', median(all.map((x) => x.measureMs)));
    m.ms('ai.waitImagesMs', median(all.map((x) => x.waitImagesMs)));
    m.ms('ai.waitFontsMs', median(all.map((x) => x.waitFontsMs)));
    m.ms('ai.waitFrameMs', median(all.map((x) => x.waitFrameMs)));
    m.ms('ai.settleMsTotal', sum((x) => x.settleMs));
    m.ms('ai.loadMsTotal', sum((x) => x.loadMs));
    m.ms('ai.measureMsTotal', sum((x) => x.measureMs));
    m.ms('ai.retryWaitMsTotal', sum((x) => x.retryWaitMs));
    m.ms('ai.baselinesMs', baselines.reduce((n, s) => n + (s.ms ?? NaN), 0));
    m.ms('ai.finalCheckMs', finals.reduce((n, s) => n + (s.ms ?? NaN), 0));
    // The turn whose response asked for several reads and page checks at once: how long it took, and its calls added up.
    const turn = m.need('ai.turnTools (the turn of reads)', trace.all('ai.turnTools', inProc('main'), from, run.t).find((r) => typeof r.attrs?.reads === 'number' && r.attrs.reads > 1));
    if (turn) {
      m.span('ai.readTurnMs', turn);
      const calls = trace.all('ai.tool', (r) => r.proc === 'main' && r.attrs?.turn === turn.attrs?.turn, from, run.t);
      m.count('ai.readTurnCalls', calls.length);
      m.ms('ai.readTurnCallMsSum', calls.reduce((n, c) => n + (c.ms ?? NaN), 0));
    }
    m.ms('ai.mainStallMax', stallMax(trace, req, run));
    return m;
  }
};

// ---------------------------------------------------------------------------
// thumbs
// ---------------------------------------------------------------------------

/** `thumbs`' windows, in the order they run: each its opening mark, the mark once its tiles are shown (fill and scroll), and its end. */
export const THUMB_WINDOWS = [
  { name: 'fill', start: 'fill', shown: 'filled', end: 'fillQuiet' },
  { name: 'edit', start: 'edit', shown: null, end: 'edited' },
  { name: 'colour', start: 'colour', shown: null, end: 'coloured' },
  { name: 'scroll', start: 'scroll', shown: 'scrolled', end: 'scrollQuiet' }
] as const;
/** A window ends once no thumbnail was asked for, answered or photographed for this long, and none is under way. */
export const THUMBS_QUIET_MS = 3500;
/** How long a window may take to go quiet. */
const THUMBS_WINDOW_MS = 180_000;
/** What `thumbs` sets the brand colour to (the Business starter's is another). */
export const THUMBS_BRAND = '#1f7a5c';
const THUMBS_HEADING = 'Thumbs heading';
/** The component `thumbs` paints on the brand colour before it starts (the fixture's first card, in view in Insert). */
export const THUMBS_BRAND_CARD = 'Fixture card 01';

const atThumbs =
  (point: string, proc: 'main' | 'renderer' = 'renderer') =>
  (r: PerfRecord): boolean =>
    r.proc === proc && r.attrs?.scenario === 'thumbs' && r.attrs?.point === point;

/** A tile of Your components in Insert as the page shows it now. */
interface ThumbTile {
  id: string;
  state: string;
  /** Its picture has loaded (rather than the sketch standing in). */
  shown: boolean;
  /** The picture shown, when asked for (thumbTiles' `pictures`); null while the sketch stands in. */
  src: string | null;
  /** Some of it is inside the part of the panel that is scrolled into view. */
  inView: boolean;
}

/**
 * Every tile of Your components in Insert, with whether it is in view in the panel's scrolling area, and with its
 * picture when `pictures` (only for the checks: a data URL a poll carries out of the page costs time in the window).
 */
function thumbTiles(win: Page, pictures = false): Promise<ThumbTile[]> {
  return win.evaluate((pictures) => {
    type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
    type El = { getBoundingClientRect(): Rect; parentElement: El | null; getAttribute(n: string): string | null; querySelector(s: string): (El & { complete: boolean; naturalWidth: number; currentSrc: string }) | null; scrollHeight: number; clientHeight: number };
    const g = globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<El> }; getComputedStyle(e: El): { overflowY: string }; innerWidth: number; innerHeight: number };
    // No named functions in here: the script's compiler would wrap them in a helper the page does not have.
    return [...g.document.querySelectorAll('#editor-sidebar [data-definition-id]')].map((el) => {
      let scroller: El | null = null;
      for (let at = el.parentElement; at && !scroller; at = at.parentElement) if (/(auto|scroll)/.test(g.getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) scroller = at;
      const r = el.getBoundingClientRect();
      const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: g.innerHeight, left: 0, right: g.innerWidth };
      const top = Math.max(r.top, box.top, 0);
      const bottom = Math.min(r.bottom, box.bottom, g.innerHeight);
      const left = Math.max(r.left, box.left, 0);
      const right = Math.min(r.right, box.right, g.innerWidth);
      const img = el.querySelector('img');
      const shown = !!img && img.complete && img.naturalWidth > 0;
      return {
        id: el.getAttribute('data-definition-id') ?? '',
        state: el.getAttribute('data-thumb') ?? '',
        shown,
        src: pictures && shown ? img!.currentSrc : null,
        inView: r.width > 0 && r.height > 0 && bottom > top && right > left
      };
    });
  }, pictures);
}

/** Wait until there are `count` tiles and every one in view shows its picture; the tiles then. */
async function thumbsShown(win: Page, count: number, what: string): Promise<ThumbTile[]> {
  const deadline = Date.now() + THUMBS_WINDOW_MS;
  for (;;) {
    const tiles = await thumbTiles(win);
    const seen = tiles.filter((t) => t.inView);
    const broken = seen.find((t) => t.state === 'failed');
    expect(!broken, `${what}: the thumbnail of ${broken?.id} could not be drawn`);
    if (tiles.length === count && seen.length && seen.every((t) => t.state === 'ready' && t.shown)) return tiles;
    expect(Date.now() < deadline, `${what}: after ${THUMBS_WINDOW_MS / 1000} s, ${tiles.length} tiles of ${count}, ${seen.filter((t) => t.shown).length} of the ${seen.length} in view with a picture`);
    await sleep(16);
  }
}

/** Wait until no thumbnail is being asked for or photographed and none was for THUMBS_QUIET_MS, nor since `from` (ms, Date.now). */
async function thumbsQuiet(ctx: ScenarioContext, what: string, from = Date.now()): Promise<void> {
  const deadline = Date.now() + THUMBS_WINDOW_MS;
  for (;;) {
    const t = await ctx.waitTrace(() => true, 0);
    const main = (name: string) => t.all(name, inProc('main'));
    const asked = main('thumbs.asked');
    const answered = main('thumbs.answered');
    const started = main('thumbs.captureStart');
    const shot = main('thumbs.capture');
    const last = Math.max(from, ...[asked, answered, started, shot].map((rs) => rs[rs.length - 1]?.t ?? 0));
    if (asked.length === answered.length && started.length === shot.length && Date.now() - last >= THUMBS_QUIET_MS) return;
    expect(Date.now() < deadline, `${what}: the thumbnails were still being drawn after ${THUMBS_WINDOW_MS / 1000} s (${asked.length - answered.length} asked for, ${started.length - shot.length} being photographed)`);
    await sleep(250);
  }
}

/** Every tile in view (there are some) shows the picture the main process has for its component as the project is now. */
async function thumbsCurrent(win: Page, what: string) {
  const seen = (await thumbTiles(win, true)).filter((t) => t.inView);
  expect(seen.length, `${what}: no tile of Your components is in view`);
  const answers = await win.evaluate(
    async (ids) => {
      const b = (globalThis as unknown as EditorPage).builder;
      const opening = (await b.project.snapshot())?.workspaceKey ?? '';
      return Promise.all(ids.map(async (id) => ({ id, answer: await b.project.componentThumb(id, opening) })));
    },
    seen.map((t) => t.id)
  );
  for (const { id, answer } of answers) {
    const shown = seen.find((t) => t.id === id)?.src;
    expect(answer.state === 'ready' && answer.url, `${what}: the main process has no picture of ${id} (${answer.state})`);
    expect(shown === answer.url, `${what}: the tile of ${id} does not show the picture of the component as it is now`);
  }
}

export const thumbs: Scenario = {
  name: 'thumbs',
  after: 'open',
  description: 'Open Insert and show all of Your components until every tile in view has its thumbnail (from cold); with it open, change the home hero’s Heading, then the brand colour, each until the thumbnails go quiet; then scroll the panel to its end until the tiles there have theirs.',
  async run(ctx) {
    const { win, app, fixture } = ctx;
    const count = fixture.projectComponents;
    expect(count > 4, `the ${fixture.spec.name} fixture has ${count} project components: thumbs needs more than Insert shows before Show all (run it on large)`);
    const before = await snapshotOf(win);
    expect(before, 'no project is open');
    // A window shown or focused while thumbnails are drawn, counted from here on.
    await app.evaluate(({ app: electron, BrowserWindow }) => {
      const g = globalThis as unknown as { __perfThumbWindows?: { shown: number; focused: number } };
      if (g.__perfThumbWindows) return;
      const seen = (g.__perfThumbWindows = { shown: 0, focused: 0 });
      for (const w of BrowserWindow.getAllWindows()) {
        w.on('show', () => seen.shown++);
        w.on('focus', () => seen.focused++);
      }
      electron.on('browser-window-created', (_e, w) => {
        w.on('show', () => seen.shown++);
        w.on('focus', () => seen.focused++);
      });
    });
    // Not timed: Insert hidden (another sidebar view, or none), so opening it is the first time its tiles are asked for.
    const insert = win.locator('.rail button[data-rail="insert"]');
    if ((await insert.getAttribute('aria-pressed')) === 'true') await insert.click();
    // Not timed: one card painted on the brand colour, so the colour change must draw it again (the fixture's cards
    // do not use the brand colour: drawn again, the others come out the same).
    const card = Object.values(before.state.components).find((d) => d.owner === 'project' && d.name === THUMBS_BRAND_CARD);
    expect(card?.tree?.rootIds[0], `the fixture has no ${THUMBS_BRAND_CARD} to paint on the brand colour`);
    const unpainted = await win.evaluate(
      async ([id, nodeId]) => {
        const r = await (globalThis as unknown as EditorPage).builder.project.apply({ operations: [{ type: 'node.setStyle', owner: { kind: 'component', id }, nodeId, scope: 'base', property: 'background', value: { token: 'color.brand' } }] }, { label: 'Benchmark brand card' });
        return r.ok ? null : (r.error?.message ?? 'no reason given');
      },
      [card.id, card.tree.rootIds[0]] as const
    );
    expect(unpainted === null, `painting ${THUMBS_BRAND_CARD} on the brand colour was refused: ${unpainted}`);
    const tiles0 = await thumbTiles(win);
    expect(tiles0.every((t) => t.state !== 'ready'), 'a thumbnail was already drawn before Insert was opened');
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await thumbsQuiet(ctx, 'before Insert was opened');
    // From cold: nothing asked for in this launch, and nothing in the project's thumbnail cache.
    const early = await ctx.waitTrace(() => true, 0);
    expect(!early.first('thumbs.asked'), 'a thumbnail was asked for before Insert was opened');
    const cache = join(ctx.projectDir, '.siteorigin', 'cache', 'thumbs');
    expect(!existsSync(cache) || !readdirSync(cache).some((n) => n.endsWith('.png')), 'the project’s thumbnail cache is not empty before Insert was opened');
    await ctx.mark('scenario.start', { scenario: 'thumbs' });

    // fill: Insert opened and every component shown, until each tile in view has its picture; then until quiet.
    const fillAt = Date.now();
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'fill' });
    await insert.click();
    await win.locator('#editor-sidebar button.insert-more', { hasText: `Show all ${count} components` }).click({ timeout: 15_000 });
    const filled = await thumbsShown(win, count, 'opening Insert');
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'filled', inView: filled.filter((t) => t.inView).length });
    await thumbsQuiet(ctx, 'opening Insert', fillAt);
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'fillQuiet' });
    await thumbsCurrent(win, 'opening Insert');
    await thumbsQuiet(ctx, 'after opening Insert');

    // edit: with Insert open, a change that cannot change how any component looks (the home hero's Heading).
    const heading = `${THUMBS_HEADING} ${ctx.iteration}`;
    const atEdit = await snapshotOf(win);
    expect(atEdit, 'the project closed');
    const editAt = Date.now();
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'edit' });
    const refused = await win.evaluate(
      async ([pageId, nodeId, value]) => {
        const r = await (globalThis as unknown as EditorPage).builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'heading', value }] }, { label: 'Benchmark heading' });
        return r.ok ? null : (r.error?.message ?? 'no reason given');
      },
      [fixture.homePageId, fixture.heroId, heading] as const
    );
    expect(refused === null, `the heading edit was refused: ${refused}`);
    await preview(win).getByRole('heading', { name: heading, exact: true, level: 1 }).first().waitFor({ timeout: 60_000 });
    await ctx.waitTrace((t) => !!t.first('canvas.revisionApplied', atRevision(atEdit.revision + 1)), 30_000);
    await thumbsQuiet(ctx, 'the heading edit', editAt);
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'edited' });
    const edited = await snapshotOf(win);
    expect(edited && edited.revision === atEdit.revision + 1, `the heading edit left the project at revision ${edited?.revision}, not ${atEdit.revision + 1}`);
    const doc = join(ctx.projectDir, 'siteorigin', 'pages', `${fixture.homePageId}.json`);
    expect(findHeading(existsSync(doc) ? (JSON.parse(readFileSync(doc, 'utf8')) as unknown) : null, fixture.heroId)?.heading === heading, 'the home page’s document on disk does not hold the new heading');
    await thumbsCurrent(win, 'after the heading edit');
    await thumbsQuiet(ctx, 'after the heading edit');

    // colour: one change of the brand colour, until the thumbnails go quiet; every tile in view then shows the brand.
    const brand = edited.state.tokens.overrides[BRAND] === THUMBS_BRAND ? '#7a1f5c' : THUMBS_BRAND;
    const brandPicture = () => win.locator(`#editor-sidebar [data-definition-id="${card.id}"] img`).getAttribute('src', { timeout: 5_000 }).catch(() => null);
    const brandTile = (await thumbTiles(win)).find((t) => t.id === card.id);
    expect(brandTile?.inView && brandTile.shown, `${THUMBS_BRAND_CARD} is not in view with its picture before the colour change`);
    const wasPainted = await brandPicture();
    const cta = () => preview(win).locator('.so-btn--primary').first().evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(el).backgroundColor);
    expect((await cta()) !== rgbOf(brand), `the preview already shows ${brand} before the colour change`);
    const colourAt = Date.now();
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'colour' });
    const notSet = await win.evaluate(
      async ([tokenId, value]) => {
        const r = await (globalThis as unknown as EditorPage).builder.project.apply({ operations: [{ type: 'token.set', tokenId, value }] }, { label: 'Benchmark brand' });
        return r.ok ? null : (r.error?.message ?? 'no reason given');
      },
      [BRAND, brand] as const
    );
    expect(notSet === null, `the brand colour change was refused: ${notSet}`);
    for (let i = 0; (await cta()) !== rgbOf(brand); i++) {
      expect(i < 600, `the preview’s primary button does not show the new brand colour ${brand}`);
      await sleep(100);
    }
    // The card on the brand colour is drawn again (the window lasts until it is, then until quiet).
    for (const until = Date.now() + THUMBS_WINDOW_MS; (await brandPicture()) === wasPainted; ) {
      expect(Date.now() < until, `${THUMBS_BRAND_CARD}, painted on the brand colour, still shows its picture from before the colour change`);
      await sleep(16);
    }
    await thumbsQuiet(ctx, 'the colour change', colourAt);
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'coloured' });
    const coloured = await snapshotOf(win);
    expect(coloured && coloured.revision === edited.revision + 1 && coloured.state.tokens.overrides[BRAND] === brand, `the colour change left the project at revision ${coloured?.revision} with ${String(coloured?.state.tokens.overrides[BRAND])}`);
    await thumbsShown(win, count, 'after the colour change');
    await thumbsCurrent(win, 'after the colour change');
    await thumbsQuiet(ctx, 'after the colour change');

    // scroll: the panel scrolled until the last component's tile is at the bottom of the view, until each tile in view
    // there has its picture; then until quiet.
    const scrollAt = Date.now();
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'scroll' });
    await win.locator('#editor-sidebar [data-definition-id]').last().evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: 'end', behavior: 'instant' }));
    const atEnd = await thumbsShown(win, count, 'scrolling Insert');
    expect(atEnd.some((t) => t.inView && !filled.find((f) => f.id === t.id)?.inView), 'scrolling Insert brought no tile into view that was not in view before');
    expect(atEnd[atEnd.length - 1]?.inView, 'scrolled to the last component, its tile is not in view');
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'scrolled', inView: atEnd.filter((t) => t.inView).length });
    await thumbsQuiet(ctx, 'scrolling Insert', scrollAt);
    await ctx.mark('thumbs.window', { scenario: 'thumbs', point: 'scrollQuiet' });
    await thumbsCurrent(win, 'after scrolling Insert');

    await sleep(ctx.settleMs);
    const windows = await app.evaluate(({ BrowserWindow }) => ({ ...(globalThis as unknown as { __perfThumbWindows: { shown: number; focused: number } }).__perfThumbWindows, visible: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length }));
    expect(!windows.shown && !windows.focused && !windows.visible, `a window was shown (${windows.shown}) or focused (${windows.focused}) while thumbnails were drawn, or is visible (${windows.visible})`);
    await ctx.mark('scenario.end', { scenario: 'thumbs' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('thumbs', 'renderer')) && !!t.first('scenario.end', forScenario('thumbs', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    for (const w of THUMB_WINDOWS) {
      const name = (metric: string) => `thumbs.${w.name}.${metric}`;
      const start = m.need(`thumbs.window ${w.start} (main)`, trace.first('thumbs.window', atThumbs(w.start, 'main')));
      const end = m.need(`thumbs.window ${w.end} (main)`, trace.first('thumbs.window', atThumbs(w.end, 'main')));
      if (w.shown) {
        const from = m.need(`thumbs.window ${w.start}`, trace.first('thumbs.window', atThumbs(w.start)));
        const shown = m.need(`thumbs.window ${w.shown}`, trace.first('thumbs.window', atThumbs(w.shown)));
        // To every tile in view showing its picture.
        m.since(name('ms'), from, shown);
        if (typeof shown?.attrs?.inView === 'number') m.count(name('inView'), shown.attrs.inView);
      }
      if (!start || !end) continue;
      const asked = trace.all('thumbs.asked', inProc('main'), start.t, end.t);
      const answered = trace.all('thumbs.answered', inProc('main'), start.t, end.t);
      const shots = trace.all('thumbs.capture', inProc('main'), start.t, end.t);
      const gained = (c: string) => counter(end, c) - counter(start, c);
      // Insert filled from cold asks for pictures and photographs them: a build that reports none did not mark them.
      if (w.name === 'fill' && (!asked.length || !gained('thumbs.captures'))) m.need('thumbs.asked and thumbs.captures (none while Insert filled from cold)', undefined);
      m.count(name('requests'), asked.length);
      m.count(name('components'), new Set(asked.map((r) => r.attrs?.definitionId)).size);
      m.count(name('bytes'), gained('thumbs.bytes'), 'bytes');
      m.count(name('pictures'), answered.filter((r) => r.attrs?.picture === true).length);
      m.count(name('captures'), gained('thumbs.captures'));
      m.ms(name('captureMs'), shots.reduce((n, r) => n + (r.ms ?? NaN), 0));
      m.count(name('keys'), gained('thumbs.keys'));
      m.count(name('brands'), gained('thumbs.brands'));
      m.ms(name('keyMs'), gained('thumbs.keyMs'));
      // How long the thumbnails kept the main process working after the window began: to the last of them.
      const last = Math.max(start.t, ...[...asked, ...answered, ...shots].map((r) => r.t));
      m.ms(name('busyMs'), last - start.t);
      m.ms(name('mainStallMax'), stallMax(trace, start, end));
    }
    return m;
  }
};

/** The composer's chip says the next edit may change the whole site. */
async function expectChip(win: Page) {
  const chip = win.getByRole('button', { name: /^What the AI may change: Whole site/ });
  await chip.first().waitFor({ timeout: 5_000 }).catch(() => undefined);
  expect(await chip.count(), 'the composer does not say the request may change the whole site');
}

export const SCENARIOS: Scenario[] = [launch, open, edit, editFullHistory, edits, batch, panels, panelsInUse, layers, chat, aiEdit, ai, canvas, drag, colour, thumbs, exportSite, exportAgain, cmdk, assets, importPhotos, switchProject, create, createAgain, memory];

/**
 * The scenarios to run in one launch for those asked for: each with every one it follows, in the order of SCENARIOS
 * (where a scenario always comes after the one it follows). Scenarios that follow the same one run one after the other,
 * so a later one starts from what the earlier left.
 */
export function chainFor(names: string[]): Scenario[] {
  const byName = new Map(SCENARIOS.map((s) => [s.name, s]));
  const wanted = new Set<string>();
  const memoryAsked = names.filter((n) => byName.get(n)?.memory);
  if (memoryAsked.length && memoryAsked.length !== names.length && names.every((n) => byName.has(n)))
    throw new Error(`Memory scenarios (${memoryAsked.join(', ')}) are run on their own: their waits and garbage collections would change the numbers of ${names.filter((n) => !memoryAsked.includes(n)).join(', ')}. Run them in a separate perf:run.`);
  for (const name of names) {
    let s = byName.get(name);
    if (!s) throw new Error(`Unknown scenario "${name}". Scenarios: ${SCENARIOS.map((x) => x.name).join(', ')}.`);
    while (s) {
      wanted.add(s.name);
      s = s.after ? byName.get(s.after) : undefined;
    }
  }
  return SCENARIOS.filter((s) => wanted.has(s.name));
}

/** `promise`, or an error naming `what` once `ms` pass first. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ChainOutcome {
  scenario: string;
  ok: boolean;
  metrics?: Record<string, Measured>;
  error?: { stage: string; message: string };
  /** The memory readings the scenario took, those before a failure included. */
  memory?: MemoryReading[];
}

/**
 * Run `chain` in one launch. A scenario that did not get the app where the next one starts (its run threw, or its check
 * failed) stops the chain: the ones after it are not run, and say why. One whose trace lacks a mark it measures fails
 * on its own, and the chain goes on, since the app is where the next scenario expects it.
 */
export async function runChain(chain: Scenario[], ctx: ScenarioContext, readTrace: () => Promise<Trace>, deadlineMs: number): Promise<ChainOutcome[]> {
  const out: ChainOutcome[] = [];
  let blocked: { stage: string; message: string } | null = null;
  for (const s of chain) {
    if (blocked) {
      out.push({ scenario: s.name, ok: false, error: { stage: blocked.stage, message: `not run: ${blocked.stage} failed (${blocked.message})` } });
      continue;
    }
    const from = ctx.memory?.readings.length ?? 0;
    const taken = () => {
      const readings = ctx.memory?.readings.slice(from) ?? [];
      return readings.length ? { memory: readings } : {};
    };
    try {
      await withDeadline(s.run(ctx), s.deadlineMs ?? deadlineMs, s.name);
    } catch (e) {
      blocked = { stage: s.name, message: `${e instanceof PredicateError ? 'predicate: ' : ''}${(e as Error).message.split('\n')[0]}` };
      out.push({ scenario: s.name, ok: false, error: blocked, ...taken() });
      continue;
    }
    const trace = await readTrace();
    if (trace.incomplete) {
      out.push({ scenario: s.name, ok: false, error: { stage: s.name, message: 'the trace has a line that could not be read' }, ...taken() });
      continue;
    }
    const m = s.measure(trace, ctx.fixture, ctx.memory?.readings.slice(from) ?? []);
    if (m.missing.length) out.push({ scenario: s.name, ok: false, error: { stage: s.name, message: `missing from the trace: ${m.missing.join(', ')}` }, ...taken() });
    else out.push({ scenario: s.name, ok: true, metrics: m.metrics, ...taken() });
  }
  return out;
}
