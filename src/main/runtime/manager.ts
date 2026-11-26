import { app, utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebsiteTools } from '@shared/api';
import { sha } from '../project/fsutil';
import { statesFailure, type BuildErrorInfo } from '../../runtime/build-diagnostics';
import { LineTail } from './line-tail';
import { NETWORK_CODES, ToolsDownloadError, cacheCoverage, lockedPackages, nativeNotInstalled, npmErrorCode, npmLibc, type LockedPackage, type ToolsAvailability } from './availability';
import { perf } from '../perf';

const nodeRequire = createRequire(import.meta.url);

export type RuntimeStatus =
  | { state: 'idle' }
  | { state: 'preparing'; message: string }
  | { state: 'starting' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string; detail?: string };

/**
 * How long a save waits for the preview to say it holds its updates (after showing the save before, see
 * src/runtime/worker.ts CATCH_UP_MS) before it goes ahead without.
 */
export const HOLD_ACK_MS = 1000;

function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime-worker.js');
}

/** Minimal environment for project processes. Credentials and unrelated secrets are never passed through. */
function projectEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.platform === 'win32' ? process.env.PATH ?? '' : '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? app.getPath('home'),
    TMPDIR: process.env.TMPDIR ?? app.getPath('temp'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NODE_ENV: 'development',
    ...extra
  };
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'ComSpec']) if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function lockHash(dir: string): Promise<string> {
  const lock = await fs.readFile(join(dir, 'package-lock.json'), 'utf8').then(
    (t) => (perf.count('files.read'), t),
    () => ''
  );
  const pkg = await fs.readFile(join(dir, 'package.json'), 'utf8');
  perf.count('files.read');
  perf.count('files.hashed');
  return sha(lock + pkg);
}

export async function dependenciesReady(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, 'node_modules', '@sveltejs', 'kit', 'package.json'))) return false;
  const marker = await fs.readFile(join(dir, '.siteorigin', 'cache', 'deps.json'), 'utf8').catch(() => null);
  if (marker !== null) perf.count('files.read');
  if (!marker) return false;
  // A damaged marker says nothing about the install: it is set up again, as with none.
  let prepared: { lockHash?: unknown };
  try {
    prepared = JSON.parse(marker);
  } catch {
    return false;
  }
  return prepared?.lockHash === (await lockHash(dir));
}

/** The npm that installs the website tools: the complete copy shipped with the app, run on Electron's own Node. */
function npmDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'npm') : dirname(nodeRequire.resolve('npm/package.json'));
}

/** The npm cache installs use, in the app's data folder; packaged builds seed it from the cache shipped with the app. */
const userCache = () => join(app.getPath('userData'), 'npm-cache');
const bundledCache = () => (app.isPackaged ? join(process.resourcesPath, 'npm-cache') : null);

/**
 * Whether installing the website tools into `dir` (a project, or the starter it is made from) downloads anything, and
 * which packages it installs: `null` when that cannot be told, such as without a lock. The caches are the ones npm
 * will read.
 */
async function checkTools(dir: string, caches: string[]): Promise<(ToolsAvailability & { packages: LockedPackage[] }) | null> {
  if (!existsSync(join(dir, 'package-lock.json'))) return null;
  const checking = perf.span('tools.check');
  let tools: (ToolsAvailability & { packages: LockedPackage[] }) | null = null;
  try {
    const packages = await lockedPackages(npmDir(), dir, {}, userCache());
    perf.count('tools.idealTrees');
    return (tools = { ...cacheCoverage(packages, caches), packages });
  } catch {
    return null;
  } finally {
    checking(tools ? { needed: tools.needed, missing: tools.missing } : { needed: null });
  }
}

/**
 * What creating a project from the starter in `dir` will do about its website tools, told before anything is
 * created and with the same check setup makes: the shipped cache counts, because setup seeds the user cache from it.
 */
export async function starterTools(dir: string): Promise<WebsiteTools> {
  const bundled = bundledCache();
  const tools = await checkTools(dir, bundled && existsSync(bundled) ? [userCache(), bundled] : [userCache()]);
  return !tools ? 'unknown' : tools.offline ? 'local' : 'download';
}

/** npm failures an install from the cache alone can have that a fresh download may fix. */
const CACHE_PROBLEMS = new Set(['ENOTCACHED', 'EINTEGRITY']);

/**
 * Install the project's locked dependencies with the npm bundled inside the app, running on Electron's own Node.
 * Package lifecycle scripts are disabled; the template's dependencies do not need them.
 *
 * Whether anything is downloaded is decided up front, by the check the New project dialog uses: when every package is
 * already in the cache npm runs offline, so it cannot download; otherwise it says so before it downloads. A download
 * that cannot reach the registry fails with a `ToolsDownloadError`.
 *
 * `mayWrite` is asked before each step that writes into the project (each npm run, the marker), so a project taken
 * over meanwhile gets nothing more.
 */
export async function prepareDependencies(dir: string, onLine: (line: string) => void, signal?: AbortSignal, mayWrite: () => Promise<boolean> = async () => true): Promise<void> {
  const stillMine = async () => {
    if (signal?.aborted || !(await mayWrite()) || signal?.aborted) throw new Error('Canceled');
  };
  const npmCli = join(npmDir(), 'bin', 'npm-cli.js');
  const seeding = perf.span('tools.seedCache');
  let cache = await seedCache();
  seeding();
  let tools = await checkTools(dir, [cache]);
  // The shipped cache may have what the user cache lost since it was seeded (a cleared or damaged file): seed it again.
  const bundled = bundledCache();
  if (tools && !tools.offline && bundled && existsSync(bundled)) {
    cache = await seedCache(true);
    tools = await checkTools(dir, [cache]);
  }
  const libc = npmLibc(npmDir());
  const base = [
    npmCli,
    existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    // Plain error lines, so the code npm reports can be read whatever the author's own npm settings say.
    '--color=false',
    '--heading=npm',
    // The packages the check worked out, laid out where it expects them, whatever those settings say.
    `--os=${process.platform}`,
    `--cpu=${process.arch}`,
    ...(libc ? [`--libc=${libc}`] : []),
    '--include=dev',
    '--include=optional',
    '--include=peer',
    '--install-strategy=hoisted',
    `--cache=${cache}`
  ];
  // npm skips an optional native tool it could not fetch without failing: the ones the check counted must be in place.
  const left = () => (tools ? nativeNotInstalled(dir, tools.packages) : []);
  const download = async () => {
    try {
      await runNpm([...base, '--prefer-offline'], dir, onLine, signal);
    } catch (e) {
      const code = (e as NpmError).code;
      if (!signal?.aborted && code && NETWORK_CODES.includes(code)) throw new ToolsDownloadError(`Downloading the website tools failed (${code}). ${(e as Error).message}`, code);
      throw e;
    }
    const missing = left();
    if (missing.length) throw new ToolsDownloadError(`Downloading the website tools failed: ${missing.map((p) => p.location.replace(/^.*node_modules\//, '')).join(', ')} could not be downloaded.`, 'EMISSING');
  };
  await stillMine();
  if (tools?.offline) {
    onLine('Setting up the website tools from copies on this computer…');
    let unusable = false;
    try {
      // Offline: npm cannot download anything, so the dialog's "nothing needs to be downloaded" holds.
      await runNpm([...base, '--offline'], dir, onLine, signal);
      unusable = left().length > 0;
    } catch (e) {
      if (signal?.aborted || (e as Error).message === 'Canceled' || !CACHE_PROBLEMS.has((e as NpmError).code ?? '')) throw e;
      unusable = true;
    }
    if (unusable) {
      onLine('A saved copy of the website tools could not be used, so it is being downloaded again…');
      await stillMine();
      await download();
    } else onLine('Installed the website tools from this computer. Nothing was downloaded.');
  } else {
    onLine(tools ? 'Downloading the website tools that are not included for this computer…' : 'Setting up the website tools. Some may need to be downloaded…');
    await download();
  }
  const marking = perf.span('tools.marker');
  const marker = JSON.stringify({ lockHash: await lockHash(dir), preparedAt: new Date().toISOString() });
  // Cancelled or taken over as the install finished: the project may belong to someone else now.
  await stillMine();
  await fs.mkdir(join(dir, '.siteorigin', 'cache'), { recursive: true });
  await fs.writeFile(join(dir, '.siteorigin', 'cache', 'deps.json'), marker);
  marking();
}

/**
 * The npm cache lives in the app's data folder; packaged builds seed it from the bundled cache once per version, or
 * again when `refill` is set. Seeding only adds files, so what the cache already holds is kept.
 */
async function seedCache(refill = false): Promise<string> {
  const cache = userCache();
  const bundled = bundledCache();
  const marker = join(cache, '.siteorigin-seeded');
  if (bundled && existsSync(bundled) && (refill || (await fs.readFile(marker, 'utf8').catch(() => '')) !== app.getVersion())) {
    await fs.cp(bundled, cache, { recursive: true, force: false, errorOnExist: false });
    await fs.writeFile(marker, app.getVersion());
  }
  return cache;
}

/** A failed npm run, with the code npm printed for it (`ENOTCACHED`, `ENOTFOUND`, …). */
type NpmError = Error & { code?: string };

function runNpm(args: string[], dir: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const running = perf.span('tools.npm', { command: args[1] ?? null, offline: args.includes('--offline') });
  return runNpmNow(args, dir, onLine, signal).finally(() => running());
}

function runNpmNow(args: string[], dir: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Cancelled before it started (while the cache was being prepared): an abort event will not come again.
    if (signal?.aborted) return reject(new Error('Canceled'));
    perf.count('tools.npmRuns');
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: projectEnv({ ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort);
    let err = '';
    child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(onLine));
    child.stderr.on('data', (d) => {
      err += String(d);
      String(d).split('\n').filter(Boolean).forEach(onLine);
    });
    child.on('error', reject);
    // Once its output has all arrived, so the code npm reported is read in full.
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('Canceled'));
      else if (code === 0) resolve();
      else reject(Object.assign(new Error(`Installing dependencies failed (exit ${code}). ${err.trim().split('\n').slice(-6).join(' ')}`), { code: npmErrorCode(err) }));
    });
  });
}

/** Numbers each preview process forked, so the benchmark's marks can tell one from the next. */
let forks = 0;

/** How long a stopping preview process gets: asked to stop, then terminated, then killed, then no longer waited for. */
export const STOP_LIMITS = { termMs: 1500, killMs: 3000, giveUpMs: 5000 };

/** Dev server for one project, in its own utility process. */
export class DevServer {
  private proc: UtilityProcess | null = null;
  status: RuntimeStatus = { state: 'idle' };
  private restarts = 0;
  private listeners = new Set<(s: RuntimeStatus) => void>();
  private publishedListeners = new Set<(revision: number) => void>();
  private goneListeners = new Set<() => void>();
  /** Holds asked for and not yet released: a save's files are landing. */
  private activeHolds = 0;
  logs: Array<{ level: string; message: string; time: number }> = [];
  private stopped = false;
  /** Ends a start still waiting for its process: a stopped server has nothing left to wait for. */
  private settleStart: (() => void) | null = null;
  /** Holds asked of the worker, answered when it holds its updates. */
  private holdAcks = new Map<string, () => void>();
  private holdCount = 0;

  /** `mayRestart` is asked before a process that stopped unexpectedly is started again in the same folder. */
  constructor(
    private dir: string,
    private mayRestart: () => Promise<boolean> = async () => true
  ) {}

  onStatus(fn: (s: RuntimeStatus) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Called each time a revision told to the preview (notifyRevision) has reached Vite: its files' updates have gone, so
   * a page loaded from here on is that revision.
   */
  onPublished(fn: (revision: number) => void) {
    this.publishedListeners.add(fn);
    return () => this.publishedListeners.delete(fn);
  }

  /** Called the moment the server's process is stopped or exits, before anything is waited for (see `url`). */
  onGone(fn: () => void) {
    this.goneListeners.add(fn);
    return () => this.goneListeners.delete(fn);
  }

  private gone() {
    for (const fn of this.goneListeners) fn();
  }

  /** Whether a save's files are landing now (a hold asked for and not yet released): pages loaded meanwhile may mix the two. */
  get holding(): boolean {
    return this.activeHolds > 0;
  }

  /**
   * The preview's address while its process is running and has said it is ready; null from the moment that process
   * is stopped or exits, even while `status` still reads ready (a restart being considered), so nothing is sent to a
   * port the process no longer holds.
   */
  get url(): string | null {
    return this.proc && this.status.state === 'ready' ? this.status.url : null;
  }

  private set(s: RuntimeStatus) {
    this.status = s;
    for (const l of this.listeners) l(s);
  }

  private log(level: string, message: string) {
    this.logs.push({ level, message: message.replace(/\x1b\[[0-9;]*m/g, ''), time: Date.now() });
    if (this.logs.length > 200) this.logs.shift();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.set({ state: 'starting' });
    const proc = utilityProcess.fork(workerPath(), [], {
      cwd: this.dir,
      env: projectEnv(),
      serviceName: 'SiteOrigin project runtime',
      stdio: 'pipe'
    });
    const worker = ++forks;
    perf.mark('runtime.forked', { worker });
    this.proc = proc;
    proc.stdout?.on('data', (d) => this.log('info', String(d)));
    proc.stderr?.on('data', (d) => this.log('error', String(d)));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.set({ state: 'error', message: 'The preview server did not start in time.', detail: this.logs.slice(-5).map((l) => l.message).join('\n') });
        resolve();
      }, 60000);
      this.settleStart = () => {
        clearTimeout(timer);
        resolve();
      };
      proc.on('message', (m: { type: string; url?: string; message?: string; level?: string; id?: string; revision?: number; name?: unknown; at?: unknown }) => {
        // The worker's own timing marks, taken at the time it gives (src/runtime/worker.ts; sent only while marks are on).
        if (m.type === 'perf') {
          if (typeof m.name === 'string' && m.name.startsWith('runtime.') && typeof m.at === 'number' && Number.isFinite(m.at)) perf.mark(m.name, { worker }, m.at);
          return;
        }
        // A process that has been stopped or replaced no longer speaks for this server.
        if (this.proc !== proc) return;
        if (m.type === 'held') this.holdAcks.get(String(m.id))?.();
        else if (m.type === 'published') {
          perf.mark('runtime.published', { revision: Number(m.revision) });
          for (const fn of this.publishedListeners) fn(Number(m.revision));
        } else if (m.type === 'ready') {
          perf.mark('runtime.ready', { worker });
          clearTimeout(timer);
          this.restarts = 0;
          this.set({ state: 'ready', url: m.url! });
          resolve();
        } else if (m.type === 'log') this.log(m.level ?? 'info', m.message ?? '');
        else if (m.type === 'error') {
          this.log('error', m.message ?? '');
          if (this.status.state !== 'ready') {
            clearTimeout(timer);
            this.set({ state: 'error', message: 'The preview server failed to start.', detail: m.message });
            resolve();
          }
        }
      });
      proc.on('exit', (code) => {
        perf.mark('runtime.exited', { worker });
        clearTimeout(timer);
        if (this.proc !== proc) return resolve();
        this.proc = null;
        this.gone();
        if (this.stopped) return;
        if (this.restarts < 1) {
          this.restarts++;
          this.log('warn', `Preview process exited (${code}); restarting once.`);
          void this.mayRestart()
            .catch(() => false)
            .then((ok) => {
              if (this.stopped || this.proc) return;
              if (ok) void this.start();
              else this.set({ state: 'error', message: 'The preview process stopped unexpectedly.', detail: this.logs.slice(-5).map((l) => l.message).join('\n') });
            });
        } else {
          this.set({ state: 'error', message: 'The preview process stopped unexpectedly.', detail: this.logs.slice(-5).map((l) => l.message).join('\n') });
        }
        resolve();
      });
      // No port: the worker binds port 0 and reports the one it got.
      proc.postMessage({ type: 'start', dir: this.dir, packaged: app.isPackaged, ...(perf.on ? { perf: true } : {}) });
    });
  }

  notifyRevision(revision: number) {
    this.proc?.postMessage({ type: 'revision', revision });
  }

  /**
   * Ask the preview to hold its hot updates while a batch of files lands, so the page takes the batch as one update
   * (src/runtime/publication-gate.ts). Resolves once the preview holds them, or has not said so in time, with the call
   * that hands it the files the batch changed (project-relative). Nothing is held while no preview is running.
   */
  async hold(): Promise<(files: string[]) => void> {
    const proc = this.proc;
    if (!proc || this.status.state !== 'ready') return () => {};
    this.activeHolds++;
    const id = String(++this.holdCount);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, HOLD_ACK_MS);
      const acks = this.holdAcks;
      function done() {
        clearTimeout(timer);
        acks.delete(id);
        resolve();
      }
      acks.set(id, done);
      try {
        proc.postMessage({ type: 'hold', id });
      } catch {
        done();
      }
    });
    let released = false;
    return (files) => {
      if (released) return;
      released = true;
      this.activeHolds--;
      // A worker stopped or replaced meanwhile held nothing of this server's; one that ends its holds on its own.
      if (this.proc !== proc) return;
      try {
        proc.postMessage({ type: 'release', id, files });
        perf.mark('runtime.release', { files: files.length });
      } catch {
        /* the process is gone */
      }
    };
  }

  private stopping: Promise<void> | null = null;
  /** Settles when the last process this server stopped has really exited. */
  exited: Promise<void> = Promise.resolve();

  /**
   * Stop the server and wait for its process to exit, so a restart never overlaps the old one: asked first, then
   * terminated, then killed outright when it ignores both (a plugin still shutting down must not keep writing).
   */
  stop(): Promise<void> {
    this.stopped = true;
    const p = this.proc;
    this.proc = null;
    if (p) this.gone();
    this.settleStart?.();
    this.settleStart = null;
    if (p) {
      const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()));
      this.exited = exited;
      p.postMessage({ type: 'stop' });
      const term = setTimeout(() => p.kill(), STOP_LIMITS.termMs);
      const kill = setTimeout(() => {
        try {
          if (p.pid) process.kill(p.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, STOP_LIMITS.killMs);
      // Every caller waits for the same exit, including one that arrives after this.proc was cleared.
      this.stopping = Promise.race([exited, new Promise<void>((r) => setTimeout(r, STOP_LIMITS.giveUpMs))]).finally(() => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    }
    const done = (this.stopping ?? Promise.resolve()).then(() => this.set({ state: 'idle' }));
    return done;
  }
}

/** How long a build may take, and how long a build that reported an error may still finish on its own. */
export const BUILD_LIMITS = { timeoutMs: 10 * 60_000, errorGraceMs: 5_000, exitWaitMs: 3_000, streamWaitMs: 500 };

/** A production build's result. A failed one carries what the build threw and everything it printed. */
export interface BuildOutcome {
  ok: boolean;
  error?: string;
  /** What the build threw, with its causes, when the worker could report it. */
  failure?: BuildErrorInfo;
  /** On failure: the worker's own warnings, then the build's stdout and stderr. */
  logs: string[];
}

/**
 * Run a production build of the project in a one-shot worker. It always settles: on the build's result, the
 * worker exiting, an error the worker reports without exiting, or a time limit. The worker never outlives it.
 */
export function buildProject(dir: string): Promise<BuildOutcome> {
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(workerPath(), [], { cwd: dir, env: projectEnv({ NODE_ENV: 'production' }), serviceName: 'SiteOrigin project build', stdio: 'pipe' });
    let done = false;
    let exited = false;
    const onExit: Array<() => void> = [];
    // SvelteKit prints what went wrong while prerendering straight to the process's streams, before the build throws a
    // generic error, so both streams are kept for a failure to explain itself: their last lines, and the lines that
    // state an error with the lines after them, which a long build's progress would otherwise push out.
    const stdout = new LineTail(200, 2000, statesFailure);
    const stderr = new LineTail(200, 2000, statesFailure);
    const timers: NodeJS.Timeout[] = [];
    /** An error the worker reported without a result: it is the build's own account if the process then exits. */
    let reported: { error: string; failure?: BuildErrorInfo } | null = null;
    /** What the worker reported after its first error: the first is the cause, the rest is context for it. */
    const later: string[] = [];
    /** After the worker exits its pipes may still hold output: wait for them to end, but not for long. */
    const drained = () =>
      new Promise<void>((resume) => {
        const open = [proc.stdout, proc.stderr].filter((s): s is NonNullable<typeof s> => !!s && (s as { readable?: boolean }).readable === true && !(s as { readableEnded?: boolean }).readableEnded);
        if (!open.length) return resume();
        let left = open.length;
        const cleanups: Array<() => void> = [];
        const stop = () => {
          clearTimeout(limit);
          for (const c of cleanups.splice(0)) c();
          resume();
        };
        const limit = setTimeout(stop, BUILD_LIMITS.streamWaitMs);
        for (const s of open) {
          let ended = false;
          const end = () => {
            if (ended) return;
            ended = true;
            if (--left === 0) stop();
          };
          s.once('end', end);
          s.once('close', end);
          cleanups.push(() => {
            s.off('end', end);
            s.off('close', end);
          });
        }
      });
    /** Settle once the worker is gone (or has not left after a few seconds), so callers can clean up its folder. */
    const finish = (outcome: BuildOutcome) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      // The streams can still be delivering when the worker reports, so they are read only once the worker has gone.
      const result = (): BuildOutcome => (outcome.ok ? outcome : { ...outcome, logs: [...outcome.logs, ...later, ...stdout.read(), ...stderr.read()] });
      let settled = false;
      const settle = (wait: boolean) => {
        if (settled) return;
        settled = true;
        void (wait ? drained() : Promise.resolve()).then(() => {
          resolve(result());
          // Nothing reads what the pipes still carry once the result is out.
          proc.stdout?.off('data', onOut);
          proc.stderr?.off('data', onErr);
        });
      };
      if (exited) return settle(true);
      const stuck = setTimeout(() => settle(false), BUILD_LIMITS.exitWaitMs);
      onExit.push(() => {
        clearTimeout(stuck);
        settle(true);
      });
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    };
    const onOut = (d: string | Uint8Array) => stdout.write(d);
    const onErr = (d: string | Uint8Array) => stderr.write(d);
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onErr);
    proc.on('message', (m: { type: string; ok?: boolean; error?: string; failure?: BuildErrorInfo; message?: string; logs?: string[] }) => {
      if (done) return;
      // A failed build often explains itself only on its streams (the static build lists links to missing sections there).
      if (m.type === 'built') {
        // An exception the worker reported earlier is the cause when the result only says the build failed.
        const failure = !m.ok && reported?.failure ? (m.failure ? { ...m.failure, cause: m.failure.cause ?? reported.failure } : reported.failure) : m.failure;
        finish({ ok: !!m.ok, error: m.error, failure, logs: m.logs ?? [] });
      }
      else if (m.type === 'error') {
        // The worker hit an error it could not hand back as a result (an uncaught exception, a failed plugin).
        // Give the build a moment in case it still completes, then stop waiting for it.
        const detail = String(m.message ?? '').split('\n').slice(0, 6).join('\n');
        if (reported) later.push(detail);
        else {
          reported = { error: `The build stopped with an error: ${detail}`, failure: m.failure };
          timers.push(setTimeout(() => finish({ ok: false, ...reported!, logs: [] }), BUILD_LIMITS.errorGraceMs));
        }
      }
    });
    proc.on('exit', (code) => {
      exited = true;
      // An error the worker reported just before it went is the cause; the exit code only adds to it.
      finish(reported ? { ok: false, ...reported, logs: [`Build process exited (${code}).`] } : { ok: false, error: `Build process exited (${code}).`, logs: [] });
      for (const fn of onExit.splice(0)) fn();
    });
    timers.push(setTimeout(() => finish({ ok: false, error: 'The build took too long and was stopped.', logs: [] }), BUILD_LIMITS.timeoutMs));
    proc.postMessage({ type: 'build', dir });
  });
}
