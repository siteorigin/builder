/**
 * The benchmark runner (scripts/perf/README.md): `npm run perf:run -- [--scenario launch,open,edit] [--fixture small,large]
 * [--iterations 5] [--out file.json] [--app <checkout>] [--settle 1500] [--cold]`.
 *
 * Drives the built app in `out/` of `--app` (this checkout by default) headless through tests/driver, with marks on,
 * once per iteration: each iteration is a fresh launch on the same profile and project files, put back from the state
 * a warm-up launch left, and runs the chain of scenarios asked for. It writes one JSON result with each case's
 * iterations and, when all of them passed, the median and spread of every metric; and it exits 1 when any case failed.
 */
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import { buildIdentity, launchApp, sessionEnv } from '../../tests/driver/session';
import { killTree, ownedEntries, processTable, type ProcessEntry } from '../../tests/driver/processes';
import { PERF_ENV, PERF_GLOBAL, type PerfAttrs } from '../../src/shared/perf';
import type { BuilderApi } from '../../src/shared/api';
import { registerBuiltinPacks } from '../../src/main/packs/build';
import { FIXTURES, ROOT, fixtureHash, fixtureState, templateHash, writeFixture, type FixtureName } from './fixtures';
import { caseTable, summarizeCase, Trace, type CaseResult, type Iteration, type RunResult } from './results';
import { chainFor, fixtureFacts, runChain, withDeadline, type ChainOutcome, type FixtureFacts, type ScenarioContext } from './scenarios';

const PERF_DIR = join(ROOT, '.tmp', 'perf');
type EditorPage = { builder: BuilderApi; __siteoriginPerf?: { mark(name: string, attrs?: PerfAttrs): void } };
/** The longest a warm-up open (an install included the first time) and one scenario of an iteration may take. */
const WARMUP_MS = 15 * 60_000;
const SCENARIO_MS = 5 * 60_000;

function options() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'launch,open,edit' },
      fixture: { type: 'string', default: 'small,large' },
      iterations: { type: 'string', default: '5' },
      out: { type: 'string' },
      app: { type: 'string', default: ROOT },
      settle: { type: 'string', default: '1500' },
      cold: { type: 'boolean', default: false }
    }
  });
  const fixtures = values.fixture.split(',').map((f) => f.trim()) as FixtureName[];
  for (const f of fixtures) if (!Object.hasOwn(FIXTURES, f)) throw new Error(`Unknown fixture "${f}". Fixtures: ${Object.keys(FIXTURES).join(', ')}.`);
  const iterations = Number(values.iterations);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('--iterations takes a whole number of at least 1.');
  const settleMs = Number(values.settle);
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60_000) throw new Error('--settle takes a whole number of milliseconds from 0 to 60000.');
  const scenarios = values.scenario.split(',').map((s) => s.trim());
  return { scenarios, chain: chainFor(scenarios), fixtures, iterations, out: values.out ? resolve(values.out) : null, app: resolve(values.app), settleMs, cold: values.cold };
}
type Options = ReturnType<typeof options>;

/** Chromium's caches in a profile: left out of each iteration's profile with --cold, so its code is compiled afresh. */
const BROWSER_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'blob_storage'];
/** What the preview's tools write inside node_modules (src/main/runtime/stage.ts): put back with the project each time. */
const TOOL_CACHES = ['.vite', '.vite-temp'];

const copy = (from: string, to: string) => cpSync(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });

/** Put `from` in place of `to`'s contents, leaving the entries named in `keep` as they are; copies share blocks where the disk can. */
function restore(from: string, to: string, keep: string[] = []) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(to)) if (!keep.includes(name)) rmSync(join(to, name), { recursive: true, force: true });
  for (const name of readdirSync(from)) if (!keep.includes(name)) copy(join(from, name), join(to, name));
}

/** The preview tools' caches of `project` saved to (or, with `back`, put back from) `saved`. */
function toolCaches(project: string, saved: string, back: boolean) {
  for (const name of TOOL_CACHES) {
    const live = join(project, 'node_modules', name);
    const kept = join(saved, name);
    rmSync(back ? live : kept, { recursive: true, force: true });
    if (existsSync(back ? kept : live)) copy(back ? kept : live, back ? live : kept);
  }
}

/** A launch's own folders inside `dir`, for sessionEnv. */
function paths(dir: string, profile: string) {
  const p = { root: dir, profile, workspace: join(dir, 'documents'), projects: join(dir, 'documents', 'SiteOrigin'), imports: join(dir, 'imports'), exports: join(dir, 'exports'), home: join(dir, 'home'), tmp: join(dir, 'tmp'), artifacts: join(dir, 'artifacts') };
  for (const d of [p.workspace, p.home, p.tmp, p.artifacts]) mkdirSync(d, { recursive: true });
  return p;
}

/**
 * Something of a launch may still be running (it would not start, or would not end): nothing more is measured beside
 * it. The result is still written, with what was not measured reported as failed.
 */
class StopRun extends Error {}

/**
 * A launch, with the identity of its main process read while it is surely running, for its teardown to check against.
 * A launch that fails, or whose identity cannot be read, stops the run: what it started cannot be told apart from
 * another process later.
 */
async function start(appDir: string, dir: string, profile: string, trace: string | null) {
  const env = { ...sessionEnv(paths(dir, profile)), ...(trace ? { [PERF_ENV]: trace } : {}) };
  let launched: Awaited<ReturnType<typeof launchApp>>;
  try {
    launched = await launchApp({ env, cwd: appDir, timeoutMs: 120_000, viewport: { width: 1440, height: 900 } });
  } catch (e) {
    throw new StopRun(`The app did not start (${(e as Error).message.split('\n')[0]}).`);
  }
  const root = (await processTable().catch(() => [])).filter((p) => p.pid === launched.pid);
  if (!root.length) {
    await launched.app.close().catch(() => undefined);
    throw new StopRun(`Could not read the launched app's process (${launched.pid}), so its processes could not be told apart from others when it ends.`);
  }
  return { ...launched, root };
}

/**
 * Quit the app, then end anything it started that outlived it (a preview server, an install). Ownership is judged
 * against the identity read at launch, so a pid the system has since given to another process is never signalled.
 * Files are only put back once nothing of the app is left: a process that would not end, or a process table that
 * cannot be read, stops the run rather than share the next iteration with it.
 */
async function stop(app: ElectronApplication, pid: number, root: ProcessEntry[]) {
  let known = root;
  try {
    known = [...root, ...ownedEntries(await processTable(), pid, root)];
  } catch {
    // Quit anyway; the sweep below reads the table again and stops the run if it still cannot.
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([app.close().catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, 30_000)))]);
  clearTimeout(timer);
  let survivors: ProcessEntry[];
  try {
    ({ survivors } = await killTree(pid, { known }));
  } catch (e) {
    throw new StopRun(`Could not check that the app's processes ended: ${(e as Error).message}`);
  }
  if (survivors.length) throw new StopRun(`Processes the app started would not end (${survivors.map((s) => s.pid).join(', ')}): stopping before the next iteration shares the machine with them.`);
}

/** Open `dir` in a launch with no marks, trusting it as the trust prompt would, and wait for its canvas. */
async function openUntimed(appDir: string, scratch: string, profile: string, dir: string) {
  const { app, win, pid, root } = await start(appDir, scratch, profile, null);
  try {
    await withDeadline(
      (async () => {
        const r = await win.evaluate((d) => (globalThis as unknown as EditorPage).builder.projects.trustAndOpen(d), dir);
        if (!r.ok) throw new Error(`The app could not open ${dir}: ${r.message ?? 'no reason given'}`);
        await win.frameLocator('.frame-box iframe').locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: WARMUP_MS });
      })(),
      WARMUP_MS,
      'the warm-up open'
    );
  } finally {
    await stop(app, pid, root);
  }
}

/**
 * The fixture's project with its website tools installed, built once per machine, fixture and template under
 * .tmp/perf/fixtures: written by writeFixture, then opened once in the app, which installs the tools as for a new project.
 */
async function preparedFixture(appDir: string, name: FixtureName): Promise<{ dir: string; hash: string; tools: string; facts: FixtureFacts }> {
  const spec = FIXTURES[name];
  const { state, files } = fixtureState(spec);
  const hash = fixtureHash(state, files);
  // The installed tools follow the template's lock and this machine, not only the documents.
  const tools = templateHash();
  const home = join(PERF_DIR, 'fixtures', `${name}-${hash}-${tools}-${platform()}-${arch()}`);
  const dir = join(home, 'project');
  const facts = fixtureFacts(spec, state);
  if (existsSync(join(home, 'ready.json'))) return { dir, hash, tools, facts };
  rmSync(home, { recursive: true, force: true });
  console.log(`perf: building the ${name} fixture (${hash}, template ${tools}) in ${relative(ROOT, home)}`);
  await writeFixture(dir, spec);
  console.log(`perf: installing the ${name} fixture's website tools through the app (once per fixture and template)`);
  // One profile for every preparation, so its npm cache serves the second fixture.
  await openUntimed(appDir, join(home, 'launch'), join(PERF_DIR, 'fixtures', 'profile'), dir);
  rmSync(join(home, 'launch'), { recursive: true, force: true });
  writeFileSync(join(home, 'ready.json'), JSON.stringify({ hash, tools, at: new Date().toISOString() }) + '\n');
  return { dir, hash, tools, facts };
}

async function poll(file: string, done: (t: Trace) => boolean, timeoutMs: number): Promise<Trace> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = Trace.parse(existsSync(file) ? readFileSync(file, 'utf8') : '');
    if (done(t) || Date.now() >= end) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function mark(app: ElectronApplication, win: Page, name: string, attrs?: PerfAttrs) {
  await app.evaluate((_electron, a) => (globalThis as Record<symbol, { mark(n: string, at?: PerfAttrs): void } | undefined>)[Symbol.for(a.key)]?.mark(a.name, a.attrs), { key: PERF_GLOBAL, name, attrs });
  await win.evaluate((a) => (globalThis as unknown as EditorPage).__siteoriginPerf?.mark(a.name, a.attrs), { name, attrs });
}

/** One iteration: a launch with marks on and the chain run in it. */
async function iterate(opts: Options, c: { dir: string; profile: string; project: string; facts: FixtureFacts; restoredAt: number }, index: number, trace: string): Promise<ChainOutcome[]> {
  rmSync(trace, { force: true });
  const { app, win, pid, root } = await start(opts.app, join(c.dir, 'launch'), c.profile, trace);
  try {
    const ctx: ScenarioContext = {
      app,
      win,
      fixture: c.facts,
      projectDir: c.project,
      iteration: index,
      settleMs: opts.settleMs,
      restoredAt: c.restoredAt,
      mark: (name, attrs) => mark(app, win, name, attrs),
      waitTrace: (done, timeoutMs = 10_000) => poll(trace, done, timeoutMs)
    };
    return await runChain(opts.chain, ctx, () => poll(trace, () => false, 0), SCENARIO_MS);
  } finally {
    await stop(app, pid, root);
  }
}

/** Electron's version as installed in `dir`'s own node_modules (never a folder above it), or null. */
function electronVersion(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

async function main() {
  const opts = options();
  const build = await buildIdentity(opts.app);
  // The app's code runs on the Electron this checkout's Playwright launches: a checkout on another Electron would be
  // measured on the wrong one.
  const ours = electronVersion(ROOT);
  const theirs = electronVersion(opts.app);
  if (theirs !== ours) throw new Error(`${opts.app} uses Electron ${theirs ?? '(not installed: run npm ci there)'}, but this checkout launches ${ours}: measure it with its own harness, or install the same Electron.`);
  registerBuiltinPacks(ROOT);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(PERF_DIR, 'runs', stamp);
  mkdirSync(runDir, { recursive: true });
  const out = opts.out ?? join(PERF_DIR, 'results', `${stamp}.json`);
  console.log(`perf: ${opts.chain.map((s) => s.name).join(' → ')} on ${opts.fixtures.join(', ')}, ${opts.iterations} iterations, ${opts.cold ? 'cold' : 'warm'} profile, app ${relative(ROOT, opts.app) || '.'} (${build.git?.head.slice(0, 10) ?? 'no git'}${build.git?.dirty ? ', dirty' : ''})`);
  const reported = opts.chain.filter((s) => opts.scenarios.includes(s.name));
  const cases: CaseResult[] = [];
  let stamped: { commit: string | null; builtAt: string | null } = { commit: null, builtAt: null };
  let electron: string | null = null;
  let counters: number | null = null;
  let stopped: string | null = null;
  const unmeasured = (fixture: string, message: string, hash = '', tools = '') => {
    for (const s of reported) if (!cases.some((c) => c.scenario === s.name && c.fixture === fixture)) cases.push({ scenario: s.name, fixture, fixtureHash: hash, templateHash: tools, status: 'failed', iterations: [{ index: 0, ok: false, trace: '', error: { stage: 'run', message } }] });
  };
  for (const name of opts.fixtures) {
    if (stopped) {
      unmeasured(name, `not measured: ${stopped}`);
      continue;
    }
    const dir = join(runDir, name);
    const project = join(dir, 'project');
    const profile = join(dir, 'profile');
    const perScenario = new Map<string, Iteration[]>(opts.chain.map((s) => [s.name, []]));
    let fx: Awaited<ReturnType<typeof preparedFixture>> | null = null;
    try {
      fx = await preparedFixture(opts.app, name);
      // The warm-up: the fixture copied into place and opened once in a fresh profile, which trusts it and lists it in
      // Recent projects. What it leaves is what every iteration starts from.
      console.log(`perf: ${name}: warm-up`);
      restore(fx.dir, project);
      await openUntimed(opts.app, join(dir, 'launch'), profile, project);
      restore(project, join(dir, 'project-start'), ['node_modules']);
      toolCaches(project, join(dir, 'tools-start'), false);
      restore(profile, join(dir, 'profile-start'));
    } catch (e) {
      // A launch that would not start or end may still be running: nothing more is measured beside it.
      if (e instanceof StopRun) {
        stopped = e.message;
        console.log(`perf: ${name}: stopping the run (${stopped})`);
        unmeasured(name, `not measured: ${stopped}`, fx?.hash, fx?.tools);
        continue;
      }
      // A fixture that cannot be set up fails its own cases; the other fixtures are still measured.
      const error = { stage: 'warm-up', message: (e as Error).message.split('\n')[0] };
      console.log(`perf: ${name}: FAILED to set up (${error.message})`);
      for (const s of reported) cases.push({ scenario: s.name, fixture: name, fixtureHash: fx?.hash ?? '', templateHash: fx?.tools ?? '', status: 'failed', iterations: [{ index: 0, ok: false, trace: '', error }] });
      continue;
    }
    for (let i = 1; i <= opts.iterations && !stopped; i++) {
      restore(join(dir, 'project-start'), project, ['node_modules']);
      toolCaches(project, join(dir, 'tools-start'), true);
      restore(join(dir, 'profile-start'), profile);
      if (opts.cold) for (const cache of BROWSER_CACHES) rmSync(join(profile, cache), { recursive: true, force: true });
      const trace = join(dir, `trace-${i}.ndjson`);
      const rel = relative(dirname(out), trace);
      let outcomes: ChainOutcome[];
      try {
        outcomes = await iterate(opts, { dir, profile, project, facts: fx.facts, restoredAt: Date.now() }, i, trace);
      } catch (e) {
        if (!(e instanceof StopRun)) throw e;
        stopped = e.message;
        console.log(`perf: ${name} #${i}: stopping the run (${stopped})`);
        outcomes = opts.chain.map((s) => ({ scenario: s.name, ok: false, error: { stage: 'run', message: stopped! } }));
      }
      const t = Trace.parse(existsSync(trace) ? readFileSync(trace, 'utf8') : '');
      if (t.build().commit) stamped = t.build();
      electron = (t.first('perf.start')?.attrs?.electron as string | null) ?? electron;
      counters = (t.first('perf.start')?.attrs?.counters as number | null) ?? counters;
      for (const o of outcomes) perScenario.get(o.scenario)!.push({ index: i, ok: o.ok, trace: rel, ...(o.metrics ? { metrics: o.metrics } : {}), ...(o.error ? { error: o.error } : {}) });
      console.log(`perf: ${name} #${i}: ${outcomes.map((o) => `${o.scenario} ${o.ok ? 'ok' : `FAILED (${o.error?.stage}: ${o.error?.message})`}`).join(', ')}`);
    }
    for (const s of reported) {
      const iterations = perScenario.get(s.name)!;
      const metrics = summarizeCase(iterations);
      cases.push({ scenario: s.name, fixture: name, fixtureHash: fx.hash, templateHash: fx.tools, status: metrics ? 'passed' : 'failed', iterations, ...(metrics ? { metrics } : {}) });
    }
  }
  const result: RunResult = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    build: { commit: stamped.commit, builtAt: stamped.builtAt, fingerprint: build.fingerprint, head: build.git?.head ?? null, dirty: build.git?.dirty ?? null, appDir: opts.app, counters },
    machine: { platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.versions.node, electron },
    config: { iterations: opts.iterations, scenarios: reported.map((s) => s.name), fixtures: opts.fixtures, settleMs: opts.settleMs, cold: opts.cold },
    cases
  };
  mkdirSync(dirname(out), { recursive: true });
  // Written whole or not at all: an interrupted run never leaves a result that looks complete.
  writeFileSync(`${out}.partial`, JSON.stringify(result, null, 2) + '\n');
  renameSync(`${out}.partial`, out);
  console.log('\n' + cases.map(caseTable).join('\n\n'));
  if (stamped.commit && build.git && !build.git.head.startsWith(stamped.commit)) console.log(`\nperf: note: the build was made from ${stamped.commit}, but ${opts.app} is at ${build.git.head}: rebuild to measure this tree.`);
  console.log(`\nperf: result in ${relative(ROOT, out)}; traces in ${relative(ROOT, runDir)}`);
  process.exitCode = cases.some((c) => c.status === 'failed') ? 1 : 0;
}

main().catch((e) => {
  console.error(`perf: ${(e as Error).stack ?? e}`);
  process.exitCode = 2;
});
