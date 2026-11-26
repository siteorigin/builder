/**
 * The benchmark runner (scripts/perf/README.md): `npm run perf:run -- [--scenario launch,open,edit] [--fixture small,large]
 * [--iterations 5] [--out file.json] [--app <checkout>]`.
 *
 * Drives the built app in `out/` of `--app` (this checkout by default) headless through tests/driver, with marks on,
 * once per iteration: each iteration is a fresh launch on the same profile and project files, put back from the state
 * a warm-up launch left, and runs the chain of scenarios asked for. It writes one JSON result with each case's
 * iterations and, when all of them passed, the median and spread of every metric; and it exits 1 when any case failed.
 */
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, arch } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import { buildIdentity, launchApp, sessionEnv } from '../../tests/driver/session';
import { killTree } from '../../tests/driver/processes';
import { PERF_ENV, PERF_GLOBAL, type PerfAttrs } from '../../src/shared/perf';
import type { BuilderApi } from '../../src/shared/api';
import { registerBuiltinPacks } from '../../src/main/packs/build';
import { FIXTURES, ROOT, fixtureHash, fixtureState, writeFixture, type FixtureName } from './fixtures';
import { caseTable, summarizeCase, Trace, type CaseResult, type Iteration, type RunResult } from './results';
import { chainFor, fixtureFacts, PredicateError, type FixtureFacts, type Scenario, type ScenarioContext } from './scenarios';

const PERF_DIR = join(ROOT, '.tmp', 'perf');
type EditorPage = { builder: BuilderApi; __siteoriginPerf?: { mark(name: string, attrs?: PerfAttrs): void } };

function options() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'launch,open,edit' },
      fixture: { type: 'string', default: 'small,large' },
      iterations: { type: 'string', default: '5' },
      out: { type: 'string' },
      app: { type: 'string', default: ROOT },
      settle: { type: 'string', default: '1500' }
    }
  });
  const fixtures = values.fixture.split(',').map((f) => f.trim()) as FixtureName[];
  for (const f of fixtures) if (!FIXTURES[f]) throw new Error(`Unknown fixture "${f}". Fixtures: ${Object.keys(FIXTURES).join(', ')}.`);
  const iterations = Number(values.iterations);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('--iterations takes a whole number of at least 1.');
  const scenarios = values.scenario.split(',').map((s) => s.trim());
  return { scenarios, chain: chainFor(scenarios), fixtures, iterations, out: values.out ? resolve(values.out) : null, app: resolve(values.app), settleMs: Number(values.settle) };
}

/** Put `from` in place of `to`'s contents, leaving the entries named in `keep` as they are; copies share blocks where the disk can. */
function restore(from: string, to: string, keep: string[] = []) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(to)) if (!keep.includes(name)) rmSync(join(to, name), { recursive: true, force: true });
  for (const name of readdirSync(from)) if (!keep.includes(name)) cpSync(join(from, name), join(to, name), { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
}

/** A launch's own folders inside `dir`, for sessionEnv. */
function paths(dir: string, profile: string) {
  const p = { root: dir, profile, workspace: join(dir, 'documents'), projects: join(dir, 'documents', 'SiteOrigin'), imports: join(dir, 'imports'), exports: join(dir, 'exports'), home: join(dir, 'home'), tmp: join(dir, 'tmp'), artifacts: join(dir, 'artifacts') };
  for (const d of [p.workspace, p.home, p.tmp, p.artifacts]) mkdirSync(d, { recursive: true });
  return p;
}

async function start(appDir: string, dir: string, profile: string, trace: string | null) {
  const env = { ...sessionEnv(paths(dir, profile)), ...(trace ? { [PERF_ENV]: trace } : {}) };
  return launchApp({ env, cwd: appDir, timeoutMs: 120_000, viewport: { width: 1440, height: 900 } });
}

async function stop(app: ElectronApplication, pid: number) {
  const closed = await Promise.race([app.close().then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 30_000))]);
  if (!closed) await killTree(pid).catch(() => undefined);
}

/** Open `dir` in a launch with no marks, trusting it as the trust prompt would, and wait for its canvas. */
async function openUntimed(appDir: string, scratch: string, profile: string, dir: string, timeoutMs: number) {
  const { app, win, pid } = await start(appDir, scratch, profile, null);
  try {
    const r = await win.evaluate((d) => (globalThis as unknown as EditorPage).builder.projects.trustAndOpen(d), dir);
    if (!r.ok) throw new Error(`The app could not open ${dir}: ${r.message ?? 'no reason given'}`);
    await win.frameLocator('.frame-box iframe').locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: timeoutMs });
  } finally {
    await stop(app, pid);
  }
}

/**
 * The fixture's project with its website tools installed, built once per machine and fixture version under
 * .tmp/perf/fixtures: written by writeFixture, then opened once in the app, which installs the tools as for a new project.
 */
async function preparedFixture(appDir: string, name: FixtureName): Promise<{ dir: string; hash: string; facts: FixtureFacts }> {
  const spec = FIXTURES[name];
  const { state, files } = fixtureState(spec);
  const hash = fixtureHash(state, files);
  const home = join(PERF_DIR, 'fixtures', `${name}-${hash}`);
  const dir = join(home, 'project');
  const facts = fixtureFacts(spec, state);
  if (existsSync(join(home, 'ready.json'))) return { dir, hash, facts };
  rmSync(home, { recursive: true, force: true });
  console.log(`perf: building the ${name} fixture (${hash}) in ${relative(ROOT, home)}`);
  await writeFixture(dir, spec);
  console.log(`perf: installing the ${name} fixture's website tools through the app (once per fixture version)`);
  // One profile for every preparation, so its npm cache serves the second fixture.
  await openUntimed(appDir, join(home, 'launch'), join(PERF_DIR, 'fixtures', 'profile'), dir, 15 * 60_000);
  rmSync(join(home, 'launch'), { recursive: true, force: true });
  writeFileSync(join(home, 'ready.json'), JSON.stringify({ hash, at: new Date().toISOString() }) + '\n');
  return { dir, hash, facts };
}

async function poll(file: string, done: (t: Trace) => boolean, timeoutMs: number): Promise<Trace> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = Trace.parse(existsSync(file) ? readFileSync(file, 'utf8') : '');
    if (done(t) || Date.now() >= end) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** One iteration: a launch with marks on, the chain run in it, and each scenario's metrics. */
async function iterate(opts: ReturnType<typeof options>, chain: Scenario[], c: { dir: string; profile: string; project: string; facts: FixtureFacts; restoredAt: number }, index: number, runDir: string): Promise<Iteration[]> {
  const trace = join(c.dir, `trace-${index}.ndjson`);
  rmSync(trace, { force: true });
  const rel = relative(runDir, trace);
  const results: Iteration[] = [];
  let launched: Awaited<ReturnType<typeof start>> | null = null;
  let failed: { stage: string; message: string } | null = null;
  try {
    launched = await start(opts.app, join(c.dir, 'launch'), c.profile, trace);
  } catch (e) {
    failed = { stage: 'launch', message: (e as Error).message };
  }
  try {
    for (const s of chain) {
      if (failed) {
        results.push({ index, ok: false, trace: rel, error: failed.stage === s.name ? failed : { stage: s.name, message: `not run: ${failed.stage} failed` } });
        continue;
      }
      const { app, win } = launched!;
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
      try {
        await s.run(ctx);
      } catch (e) {
        failed = { stage: s.name, message: `${e instanceof PredicateError ? 'predicate: ' : ''}${(e as Error).message.split('\n')[0]}` };
        results.push({ index, ok: false, trace: rel, error: failed });
        continue;
      }
      const m = s.measure(await poll(trace, () => false, 0));
      if (m.missing.length) {
        failed = { stage: s.name, message: `missing from the trace: ${m.missing.join(', ')}` };
        results.push({ index, ok: false, trace: rel, error: failed });
        continue;
      }
      results.push({ index, ok: true, trace: rel, metrics: m.metrics });
    }
  } finally {
    if (launched) await stop(launched.app, launched.pid);
  }
  return results;
}

async function mark(app: ElectronApplication, win: Page, name: string, attrs?: PerfAttrs) {
  await app.evaluate((_electron, a) => (globalThis as Record<symbol, { mark(n: string, at?: PerfAttrs): void } | undefined>)[Symbol.for(a.key)]?.mark(a.name, a.attrs), { key: PERF_GLOBAL, name, attrs });
  await win.evaluate((a) => (globalThis as unknown as EditorPage).__siteoriginPerf?.mark(a.name, a.attrs), { name, attrs });
}

async function main() {
  const opts = options();
  const build = await buildIdentity(opts.app);
  registerBuiltinPacks(ROOT);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(PERF_DIR, 'runs', stamp);
  mkdirSync(runDir, { recursive: true });
  const out = opts.out ?? join(PERF_DIR, 'results', `${stamp}.json`);
  console.log(`perf: ${opts.chain.map((s) => s.name).join(' → ')} on ${opts.fixtures.join(', ')}, ${opts.iterations} iterations, app ${relative(ROOT, opts.app) || '.'} (${build.git?.head.slice(0, 10) ?? 'no git'}${build.git?.dirty ? ', dirty' : ''})`);
  const cases: CaseResult[] = [];
  let stamped: { commit: string | null; builtAt: string | null } = { commit: null, builtAt: null };
  let electron: string | null = null;
  for (const name of opts.fixtures) {
    const fx = await preparedFixture(opts.app, name);
    const dir = join(runDir, name);
    const project = join(dir, 'project');
    const profile = join(dir, 'profile');
    // The warm-up: the fixture copied into place and opened once in a fresh profile, which trusts it and lists it in
    // Recent projects. What it leaves is what every iteration starts from.
    console.log(`perf: ${name}: warm-up`);
    restore(fx.dir, project);
    await openUntimed(opts.app, join(dir, 'launch'), profile, project, 180_000);
    restore(project, join(dir, 'project-start'), ['node_modules']);
    restore(profile, join(dir, 'profile-start'));
    const perScenario = new Map<string, Iteration[]>(opts.chain.map((s) => [s.name, []]));
    for (let i = 1; i <= opts.iterations; i++) {
      restore(join(dir, 'project-start'), project, ['node_modules']);
      restore(join(dir, 'profile-start'), profile);
      const results = await iterate(opts, opts.chain, { dir, profile, project, facts: fx.facts, restoredAt: Date.now() }, i, runDir);
      const t = Trace.parse(existsSync(join(dir, `trace-${i}.ndjson`)) ? readFileSync(join(dir, `trace-${i}.ndjson`), 'utf8') : '');
      if (t.build().commit) stamped = t.build();
      electron = (t.first('perf.start')?.attrs?.electron as string | null) ?? electron;
      for (const [k, r] of opts.chain.map((s, j) => [s.name, results[j]] as const)) perScenario.get(k)!.push(r);
      console.log(`perf: ${name} #${i}: ${results.map((r, j) => `${opts.chain[j].name} ${r.ok ? 'ok' : `FAILED (${r.error?.message})`}`).join(', ')}`);
    }
    for (const s of opts.chain) {
      if (!opts.scenarios.includes(s.name) && !opts.scenarios.includes('all')) continue;
      const iterations = perScenario.get(s.name)!;
      const metrics = summarizeCase(iterations);
      cases.push({ scenario: s.name, fixture: name, fixtureHash: fx.hash, status: metrics ? 'passed' : 'failed', iterations, ...(metrics ? { metrics } : {}) });
    }
  }
  const result: RunResult = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    build: { commit: stamped.commit, builtAt: stamped.builtAt, fingerprint: build.fingerprint, head: build.git?.head ?? null, dirty: build.git?.dirty ?? null, appDir: opts.app },
    machine: { platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.versions.node, electron },
    config: { iterations: opts.iterations, scenarios: opts.chain.map((s) => s.name).filter((n) => opts.scenarios.includes(n)), fixtures: opts.fixtures, settleMs: opts.settleMs },
    cases
  };
  mkdirSync(join(out, '..'), { recursive: true });
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
