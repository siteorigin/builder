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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, FrameLocator, Page } from 'playwright';
import type { BuilderApi } from '../../src/shared/api';
import type { PerfAttrs, PerfRecord } from '../../src/shared/perf';
import type { ProjectState } from '../../src/shared/types';
import type { FixtureSpec } from './fixtures';
import { atRevision, Collector, counter, delta, forScenario, inProc, type Measured, type Trace } from './results';

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
    for (const phase of ['lock', 'recover', 'read', 'localState', 'validate', 'sweep']) m.span(`open.session.${phase}`, span(`session.open.${phase}`));
    // The open's own publication runs inside session.open.
    const publish = m.need('session.publish', trace.first('session.publish', inProc('main'), at, session?.t));
    m.span('open.publish', publish);
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

export const SCENARIOS: Scenario[] = [launch, open, edit];

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
