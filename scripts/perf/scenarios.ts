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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ElectronApplication, FrameLocator, Page } from 'playwright';
import { desktopInMain, type DesktopCall } from '../../tests/driver/desktop';
import type { BuilderApi } from '../../src/shared/api';
import type { PerfAttrs, PerfRecord } from '../../src/shared/perf';
import type { ProjectState } from '../../src/shared/types';
import { generateProject } from '../../src/generator/index';
import type { ChatMessage, Conversation } from '../../src/shared/api';
import { envelopeReply, MockOpenAIServer, textReply } from '../../tests/unit/mock-openai-server';
import { createStarterState, STARTER_ASSETS } from '../../src/catalogue/starters';
import { projectFolderName } from '../../src/shared/project-name';
import type { FixtureSpec } from './fixtures';
import { growthMetrics, readingMetrics, type MemoryProbe, type MemoryReading } from './memory';
import { PHOTO_COUNT, photoSpec, scenarioPhotos } from './photos';
import { atRevision, Collector, counter, delta, forScenario, inProc, median, type Measured, type Trace } from './results';

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
    m.span('open.controller', controllerOpen);
    m.span('open.session', session);
    for (const phase of ['formatCheck', 'lock', 'recover', 'read', 'localState', 'validate', 'sweep']) m.span(`open.session.${phase}`, span(`session.open.${phase}`));
    // The open's own publication runs inside session.open.
    const publish = m.need('session.publish', trace.first('session.publish', inProc('main'), at, session?.t));
    m.span('open.publish', publish);
    // Both of its generations, the website's and the preview's: a sum missing one would look faster than it is.
    const variant = (v: string) => trace.all('session.generate', (r) => r.proc === 'main' && r.attrs?.variant === v, at, session?.t);
    const clean = variant('clean');
    const dev = variant('dev');
    if (!clean.length) m.need('session.generate (clean)', undefined);
    if (!dev.length) m.need('session.generate (dev)', undefined);
    if (clean.length && dev.length) m.ms('open.generate', [...clean, ...dev].reduce((n, r) => n + (r.ms ?? NaN), 0));
    m.span('open.attach', attach);
    m.span('open.assetCheck', span('controller.assetCheck'));
    m.span('open.startRuntime', runtime);
    m.since('open.firstSnapshotSent', req, m.need('controller.snapshotSent', trace.first('controller.snapshotSent', inProc('main'), at)));
    m.since('open.editorShown', req, m.need('renderer.commit (editor)', trace.first('renderer.commit', (r) => r.attrs?.screen === 'editor', at)));
    previewStart(m, trace, 'open', req, at, ready);
    m.since('open.canvasReady', req, ready);
    // What the author watches as "Starting preview": the editor shown to the page ready to edit in its canvas.
    m.since('open.editorToCanvasReady', trace.first('renderer.commit', (r) => r.attrs?.screen === 'editor', at), ready);
    const sum = (name: string) => [session, attach, runtime].reduce((n, r) => n + delta(r, name), 0);
    m.count('open.filesRead', sum('files.read'));
    m.count('open.docsRead', sum('docs.read'));
    m.count('open.filesHashed', sum('files.hashed'));
    m.count('open.durableWrites', sum('fs.durableWrites'));
    m.count('open.fsyncs', sum('fs.fsyncs'));
    m.count('open.publishFilesRead', delta(publish, 'files.read'));
    m.count('open.publishFilesHashed', delta(publish, 'files.hashed'));
    m.count('open.publishFilesWritten', delta(publish, 'fs.writes'));
    const sent = trace.all('controller.snapshotSent', inProc('main'), at, ready?.t);
    m.count('open.snapshotsSent', sent.length);
    bytesSent(m, 'open.snapshotBytes', sent);
    m.count('open.reloadFromDisk', trace.all('session.reloadFromDisk', inProc('main'), at, m.need('scenario.end (main)', end)?.t).length);
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

export const EDITED_HEADING = 'Benchmark heading';

export const edit: Scenario = {
  name: 'edit',
  after: 'open',
  description: 'Change the home hero’s Heading in the Inspector and wait for the preview to show it.',
  async run(ctx) {
    const { win, fixture } = ctx;
    const heading = `${EDITED_HEADING} ${ctx.iteration}`;
    const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(before, 'no project is open');
    // Choosing what to edit is not timed: the edit starts when the Heading is committed.
    await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
    await win.getByRole('treeitem', { name: 'Split hero' }).first().click();
    await win.getByRole('tab', { name: 'Inspector', exact: true }).first().click();
    const field = win.getByRole('textbox', { name: 'Heading', exact: true }).first();
    await field.waitFor({ timeout: 15_000 });
    // Choosing the panel and tab saves the workspace 300 ms later: that save lands before the edit starts, not in it,
    // whatever --settle is.
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await ctx.mark('scenario.start', { scenario: 'edit' });
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
    await ctx.mark('scenario.end', { scenario: 'edit' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('edit', 'renderer')) && !!t.first('scenario.end', forScenario('edit', 'main')));
  },
  measure(trace) {
    const m = new Collector();
    const begin = trace.first('scenario.start', forScenario('edit', 'renderer'));
    const req = m.need('edit.requested', trace.first('edit.requested', inProc('renderer'), begin?.t ?? Infinity));
    const at = req?.t ?? Infinity;
    const target = typeof req?.attrs?.revision === 'number' ? req.attrs.revision + 1 : NaN;
    const applied = m.need('controller.apply', trace.first('controller.apply', atRevision(target), at));
    const until = applied?.t ?? Infinity;
    const inApply = (name: string) => m.need(name, trace.first(name, inProc('main'), at, until));
    m.span('edit.apply', applied);
    m.span('edit.sessionApply', inApply('session.apply'));
    m.span('edit.validateOperations', inApply('session.validateOperations'));
    m.span('edit.applyOperations', inApply('session.applyOperations'));
    m.span('edit.validate', inApply('session.validateState'));
    // Every generation of both variants, the website's and the preview's: a sum missing one would look faster than it is.
    const variant = (v: string) => trace.all('session.generate', (r) => r.proc === 'main' && r.attrs?.variant === v, at, until);
    const clean = variant('clean');
    const dev = variant('dev');
    if (!clean.length) m.need('session.generate (clean)', undefined);
    if (!dev.length) m.need('session.generate (dev)', undefined);
    if (clean.length && dev.length) m.ms('edit.generate', [...clean, ...dev].reduce((n, r) => n + (r.ms ?? NaN), 0));
    m.span('edit.persist', inApply('session.persist'));
    const publish = inApply('session.publish');
    m.span('edit.publish', publish);
    m.since('edit.hmrRelease', req, inApply('runtime.release'));
    m.since('edit.changed', req, m.need('session.changed', trace.first('session.changed', atRevision(target), at)));
    m.since('edit.snapshotSent', req, m.need('controller.snapshotSent', trace.first('controller.snapshotSent', atRevision(target), at)));
    m.since('edit.snapshotReceived', req, m.need('renderer.snapshotReceived', trace.first('renderer.snapshotReceived', atRevision(target), at)));
    m.since('edit.rendererCommit', req, m.need('renderer.commit', trace.first('renderer.commit', atRevision(target), at)));
    m.since('edit.previewPublished', req, m.need('runtime.published', trace.first('runtime.published', atRevision(target), at)));
    const shown = m.need('canvas.revisionApplied', trace.first('canvas.revisionApplied', atRevision(target), at));
    m.since('edit.previewApplied', req, shown);
    m.count('edit.durableWrites', delta(applied, 'fs.durableWrites'));
    m.count('edit.fsyncs', delta(applied, 'fs.fsyncs'));
    m.count('edit.fileWrites', delta(applied, 'fs.writes'));
    m.count('edit.publishFilesRead', delta(publish, 'files.read'));
    m.count('edit.publishFilesHashed', delta(publish, 'files.hashed'));
    m.count('edit.publishFilesWritten', delta(publish, 'fs.writes'));
    const endMain = m.need('scenario.end (main)', trace.first('scenario.end', forScenario('edit', 'main')));
    const endRenderer = m.need('scenario.end (renderer)', trace.first('scenario.end', forScenario('edit', 'renderer')));
    const sent = trace.all('controller.snapshotSent', inProc('main'), at, endMain?.t);
    m.count('edit.snapshotsSent', sent.length);
    bytesSent(m, 'edit.snapshotBytes', sent);
    m.count('edit.reloadFromDisk', trace.all('session.reloadFromDisk', inProc('main'), at, endMain?.t).length);
    commits(m, trace, 'edit.rendererCommits', req, endRenderer);
    m.ms('edit.mainStallMax', stallMax(trace, req, shown));
    return m;
  }
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
  (phase: string) =>
  (r: PerfRecord): boolean =>
    r.proc === 'renderer' && r.attrs?.scenario === 'panels' && r.attrs?.phase === phase;

export const panels: Scenario = {
  name: 'panels',
  after: 'open',
  description: 'With every panel hidden but the dock’s Project view, click the home hero on the canvas; then, with the Inspector shown, change its Heading there.',
  async run(ctx) {
    const { win, fixture } = ctx;
    // Its own heading, never the one another scenario in the chain (edit) may have left.
    const heading = `Panels heading ${ctx.iteration}`;
    const before = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(before, 'no project is open');
    const shownHeading = findHeading(before.state.pages[fixture.homePageId], fixture.heroId)?.heading ?? fixture.heading;
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
    const holders = '#editor-sidebar .side-panel-view, #editor-dock [role="tabpanel"]';
    type Holder = { firstElementChild: Record<string, unknown> | null };
    const views = await win.locator(holders).evaluateAll((els) => els.map((el) => !!(el as unknown as Holder).firstElementChild && ((el as unknown as Holder).firstElementChild!.__perfKept = true)));
    expect(views.length >= 10 && views.every(Boolean), `only ${views.filter(Boolean).length} of the sidebar's and dock's ${views.length} panels are in the page`);
    // Choosing the panels saves the workspace 300 ms later: that save lands before the click, not in it.
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await ctx.mark('scenario.start', { scenario: 'panels' });
    // A click on the canvas selects the hero, as the canvas's selection toolbar shows.
    await preview(win).getByRole('heading', { name: shownHeading, exact: true, level: 1 }).first().click();
    await heroChip(win).waitFor({ timeout: 30_000 });
    await ctx.waitTrace((t) => !!t.first('renderer.selectionCommit', (r) => r.attrs?.selected === true, forScenarioStart(t, 'panels')), 15_000);
    await sleep(ctx.settleMs);
    await ctx.mark('scenario.phase', { scenario: 'panels', phase: 'clicked' });
    // Not timed: the Inspector, hidden through the click, shows the hero as soon as it is shown again.
    await win.getByRole('tab', { name: 'Inspector', exact: true }).first().click();
    await win.locator('#dock-panel-inspect').waitFor({ state: 'visible', timeout: 15_000 });
    const named = (await inspectorName(win).first().textContent())?.trim();
    expect(named === HERO_NAME, `the Inspector, shown again, names ${named ? `“${named}”` : 'nothing'}, not the ${HERO_NAME} the canvas selected`);
    await sleep(Math.max(ctx.settleMs, WORKSPACE_SAVE_WAIT_MS));
    await ctx.mark('scenario.phase', { scenario: 'panels', phase: 'edit' });
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
    await ctx.mark('scenario.end', { scenario: 'panels' });
    await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('panels', 'renderer')) && !!t.first('scenario.end', forScenario('panels', 'main')));
    // After the window: the panels hidden through it are still there, and Layers, shown again, is up to date at once.
    const still = await win.locator(holders).evaluateAll((els) => els.map((el) => (el as unknown as Holder).firstElementChild?.__perfKept === true));
    expect(still.length === views.length && still.every(Boolean), `${still.filter((x) => !x).length} of the panels were replaced or left the page while hidden`);
    await win.getByRole('button', { name: 'Layers', exact: true }).first().click();
    await win.locator('#editor-sidebar').waitFor({ state: 'visible', timeout: 15_000 });
    const chosen = await win.locator('#editor-sidebar').getByRole('treeitem', { name: HERO_NAME, selected: true }).count();
    expect(chosen > 0, `Layers, shown again, does not have the ${HERO_NAME} selected`);
  },
  measure(trace) {
    const m = new Collector();
    const begin = m.need('scenario.start (renderer)', trace.first('scenario.start', forScenario('panels', 'renderer')));
    const clicked = m.need('scenario.phase clicked (renderer)', trace.first('scenario.phase', atPhase('clicked')));
    const editing = m.need('scenario.phase edit (renderer)', trace.first('scenario.phase', atPhase('edit')));
    const end = m.need('scenario.end (renderer)', trace.first('scenario.end', forScenario('panels', 'renderer')));
    // The click: from the canvas telling the editor of it to the commit that shows the selection.
    const select = m.need('canvas.select', trace.first('canvas.select', inProc('renderer'), begin?.t ?? Infinity, clicked?.t));
    const shown = m.need('renderer.selectionCommit', trace.first('renderer.selectionCommit', (r) => r.proc === 'renderer' && r.attrs?.selected === true, select?.t ?? Infinity, clicked?.t));
    m.since('panels.click.commit', select, shown);
    perPanel(m, 'panels.click', SHOWN_PANELS.click, begin, clicked);
    commits(m, trace, 'panels.click.rendererCommits', begin, clicked);
    // The edit: from the editor receiving the edited project to the commit that shows it.
    const req = m.need('edit.requested', trace.first('edit.requested', inProc('renderer'), editing?.t ?? Infinity, end?.t));
    const target = typeof req?.attrs?.revision === 'number' ? req.attrs.revision + 1 : NaN;
    const at = req?.t ?? Infinity;
    const received = m.need('renderer.snapshotReceived', trace.first('renderer.snapshotReceived', atRevision(target), at));
    const committed = m.need('renderer.commit', trace.first('renderer.commit', atRevision(target), at));
    m.since('panels.edit.commit', received, committed);
    m.since('panels.edit.rendererCommit', req, committed);
    perPanel(m, 'panels.edit', SHOWN_PANELS.edit, editing, end);
    commits(m, trace, 'panels.edit.rendererCommits', editing, end);
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
        await ctx.mark('chat.typeStart', { at: c.key });
        await win.keyboard.type(CHAT_TYPED);
        expect((await composer(win).inputValue()) === CHAT_TYPED, 'the composer does not hold what was typed');
        await ctx.mark('chat.typeEnd', { at: c.key });
        const reply = chatReply(c.key);
        server.script(textReply(reply, { size: CHAT_PIECE, frameMs: CHAT_FRAME_MS }));
        await ctx.mark('chat.streamStart', { at: c.key });
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
        await ctx.mark('chat.streamEnd', { at: c.key });
      }
      await ctx.mark('scenario.end', { scenario: 'chat' });
      await ctx.waitTrace((t) => !!t.first('scenario.end', forScenario('chat', 'renderer')) && !!t.first('scenario.end', forScenario('chat', 'main')));
    } finally {
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

export const SCENARIOS: Scenario[] = [launch, open, edit, edits, panels, chat, aiEdit, canvas, exportSite, exportAgain, importPhotos, switchProject, create, createAgain, memory];

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
