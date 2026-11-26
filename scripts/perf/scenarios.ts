/**
 * The benchmark's scenarios (scripts/perf/README.md says how to add one). A scenario is something a person does in the
 * app, a check that it still did its job, and the metrics read from the iteration's trace.
 *
 * Scenarios run as a chain in one launch of the app: each names the one it follows (`after`), which sets the app up
 * for it and is measured too. `launch` starts the app to Welcome, `open` opens the fixture from Welcome's recent
 * projects to an editable canvas, and `edit` changes the home hero's heading in the Inspector until the preview shows
 * it. `run` throws a PredicateError when the feature did not do its job, and the iteration fails: a scenario never
 * gets faster by doing less.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ElectronApplication, FrameLocator, Page } from 'playwright';
import { desktopInMain, type DesktopCall } from '../../tests/driver/desktop';
import type { BuilderApi } from '../../src/shared/api';
import type { PerfAttrs, PerfRecord } from '../../src/shared/perf';
import type { ProjectState } from '../../src/shared/types';
import type { ChatMessage, Conversation } from '../../src/shared/api';
import { MockOpenAIServer, textReply } from '../../tests/unit/mock-openai-server';
import type { FixtureSpec } from './fixtures';
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
}

export interface Scenario {
  name: string;
  /** The scenario this one follows in the same launch; null for the one that starts the app. */
  after: string | null;
  description: string;
  run(ctx: ScenarioContext): Promise<void>;
  /** This scenario's metrics from the iteration's trace. */
  measure(trace: Trace, fixture: FixtureFacts): Collector;
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
    await ctx.waitTrace((t) => !!t.first('launch.recentsShown') && !!t.first('launch.firstInteractive'), 15_000);
  },
  measure(trace) {
    const m = new Collector();
    const start = m.need('launch.processStart', trace.first('launch.processStart'));
    for (const name of ['launch.mainLoaded', 'launch.appReady', 'launch.windowCreated', 'launch.readyToShow', 'launch.firstRender', 'launch.firstInteractive', 'launch.recentsShown']) m.since(name, start, m.need(name, trace.first(name)));
    m.span('launch.loadPacks', m.need('launch.loadPacks', trace.first('launch.loadPacks')));
    const shown = trace.first('launch.recentsShown');
    commits(m, trace, 'launch.rendererCommits', undefined, shown);
    // What the main process read and hashed before it made the window (theme packs are verified file by file).
    const made = trace.first('launch.windowCreated');
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
    const { win, fixture } = ctx;
    // A person's project has been left alone a while: freshly copied files are read in full, so they settle first.
    const wait = ctx.restoredAt + FILES_SETTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    await ctx.mark('scenario.start', { scenario: 'open' });
    await win.locator('.recent-card', { hasText: fixture.spec.title }).first().click();
    await win.locator('.editor').waitFor({ timeout: 120_000 });
    const frame = preview(win);
    await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 120_000 });
    await frame.getByRole('heading', { name: fixture.heading, exact: true, level: 1 }).first().waitFor({ timeout: 30_000 });
    const snap = await win.evaluate(() => (globalThis as unknown as EditorPage).builder.project.snapshot());
    expect(snap, 'no project is open');
    expect(!snap.readOnly, `the project opened read-only: ${snap.readOnly?.reason ?? ''}`);
    expect(snap.dir === ctx.projectDir, `another project opened: ${snap.dir}`);
    const facts = { pages: Object.keys(snap.state.pages).length, entries: Object.values(snap.state.collections ?? {}).reduce((n, c) => n + Object.keys((c as { entries?: object }).entries ?? {}).length, 0), assets: Object.keys(snap.state.assets.assets).length, projectComponents: Object.values(snap.state.components).filter((c) => c.owner === 'project').length };
    for (const k of ['pages', 'entries', 'assets', 'projectComponents'] as const) expect(facts[k] === fixture[k], `the project opened with ${facts[k]} ${k}, not ${fixture[k]}`);
    expect(snap.state.site.homePageId === fixture.homePageId, 'the project opened with another home page');
    expect(findHeading(snap.state.pages[fixture.homePageId], fixture.heroId)?.heading === fixture.heading, 'the home hero opened with another heading');
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
    m.since('open.runtimeForked', req, m.need('runtime.forked', trace.first('runtime.forked', inProc('main'), at)));
    m.since('open.runtimeReady', req, m.need('runtime.ready', trace.first('runtime.ready', inProc('main'), at)));
    m.since('open.canvasReady', req, ready);
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

export const SCENARIOS: Scenario[] = [launch, open, edit, panels, chat, exportSite, exportAgain];

/**
 * The scenarios to run in one launch for those asked for: each with every one it follows, in the order of SCENARIOS
 * (where a scenario always comes after the one it follows). Scenarios that follow the same one run one after the other,
 * so a later one starts from what the earlier left.
 */
export function chainFor(names: string[]): Scenario[] {
  const byName = new Map(SCENARIOS.map((s) => [s.name, s]));
  const wanted = new Set<string>();
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
    try {
      await withDeadline(s.run(ctx), deadlineMs, s.name);
    } catch (e) {
      blocked = { stage: s.name, message: `${e instanceof PredicateError ? 'predicate: ' : ''}${(e as Error).message.split('\n')[0]}` };
      out.push({ scenario: s.name, ok: false, error: blocked });
      continue;
    }
    const trace = await readTrace();
    if (trace.incomplete) {
      out.push({ scenario: s.name, ok: false, error: { stage: s.name, message: 'the trace has a line that could not be read' } });
      continue;
    }
    const m = s.measure(trace, ctx.fixture);
    if (m.missing.length) out.push({ scenario: s.name, ok: false, error: { stage: s.name, message: `missing from the trace: ${m.missing.join(', ')}` } });
    else out.push({ scenario: s.name, ok: true, metrics: m.metrics });
  }
  return out;
}
