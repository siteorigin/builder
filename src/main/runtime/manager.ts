import { app, utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from '../project/fsutil';
import { statesFailure, type BuildErrorInfo } from '../../runtime/build-diagnostics';
import { LineTail } from './line-tail';

const nodeRequire = createRequire(import.meta.url);

export type RuntimeStatus =
  | { state: 'idle' }
  | { state: 'preparing'; message: string }
  | { state: 'starting' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string; detail?: string };

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
  return sha((await fs.readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => '')) + (await fs.readFile(join(dir, 'package.json'), 'utf8')));
}

export async function dependenciesReady(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, 'node_modules', '@sveltejs', 'kit', 'package.json'))) return false;
  const marker = await fs.readFile(join(dir, '.siteorigin', 'cache', 'deps.json'), 'utf8').catch(() => null);
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

/**
 * Install the project's locked dependencies with the npm bundled inside the app, running on Electron's own Node.
 * Package lifecycle scripts are disabled; the template's dependencies do not need them.
 */
/**
 * `mayWrite` is asked before each step that writes into the project (each npm run, the marker), so a project taken
 * over meanwhile gets nothing more.
 */
export async function prepareDependencies(dir: string, onLine: (line: string) => void, signal?: AbortSignal, mayWrite: () => Promise<boolean> = async () => true): Promise<void> {
  const stillMine = async () => {
    if (signal?.aborted || !(await mayWrite()) || signal?.aborted) throw new Error('Cancelled');
  };
  const npmCli = app.isPackaged ? join(process.resourcesPath, "npm", "bin", "npm-cli.js") : join(dirname(nodeRequire.resolve("npm/package.json")), "bin", "npm-cli.js");
  const cache = await seedCache();
  const base = [npmCli, existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `--cache=${cache}`];
  // Try the packages bundled with the app first (works offline); fall back to downloading what is missing.
  try {
    await stillMine();
    await runNpm([...base, '--offline'], dir, onLine, signal);
    onLine('Installed from the tools bundled with SiteOrigin Builder.');
  } catch (e) {
    if (signal?.aborted || (e as Error).message === 'Cancelled') throw e;
    onLine('Some website tools are not bundled for this system; downloading them…');
    await stillMine();
    await runNpm([...base, '--prefer-offline'], dir, onLine, signal);
  }
  const marker = JSON.stringify({ lockHash: await lockHash(dir), preparedAt: new Date().toISOString() });
  // Cancelled or taken over as the install finished: the project may belong to someone else now.
  await stillMine();
  await fs.mkdir(join(dir, '.siteorigin', 'cache'), { recursive: true });
  await fs.writeFile(join(dir, '.siteorigin', 'cache', 'deps.json'), marker);
}

/** The npm cache lives in the app's data folder; packaged builds seed it from the bundled cache once. */
async function seedCache(): Promise<string> {
  const cache = join(app.getPath('userData'), 'npm-cache');
  const bundled = app.isPackaged ? join(process.resourcesPath, 'npm-cache') : null;
  const marker = join(cache, '.siteorigin-seeded');
  if (bundled && existsSync(bundled) && (await fs.readFile(marker, 'utf8').catch(() => '')) !== app.getVersion()) {
    await fs.cp(bundled, cache, { recursive: true, force: false, errorOnExist: false });
    await fs.writeFile(marker, app.getVersion());
  }
  return cache;
}

function runNpm(args: string[], dir: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Cancelled before it started (while the cache was being prepared): an abort event will not come again.
    if (signal?.aborted) return reject(new Error('Cancelled'));
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
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`Installing dependencies failed (exit ${code}). ${err.trim().split('\n').slice(-6).join(' ')}`));
    });
  });
}

/** How long a stopping preview process gets: asked to stop, then terminated, then killed, then no longer waited for. */
export const STOP_LIMITS = { termMs: 1500, killMs: 3000, giveUpMs: 5000 };

/** Dev server for one project, in its own utility process. */
export class DevServer {
  private proc: UtilityProcess | null = null;
  status: RuntimeStatus = { state: 'idle' };
  private restarts = 0;
  private listeners = new Set<(s: RuntimeStatus) => void>();
  logs: Array<{ level: string; message: string; time: number }> = [];
  private stopped = false;
  /** Ends a start still waiting for its process: a stopped server has nothing left to wait for. */
  private settleStart: (() => void) | null = null;

  /** `mayRestart` is asked before a process that stopped unexpectedly is started again in the same folder. */
  constructor(
    private dir: string,
    private mayRestart: () => Promise<boolean> = async () => true
  ) {}

  onStatus(fn: (s: RuntimeStatus) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
      proc.on('message', (m: { type: string; url?: string; message?: string; level?: string }) => {
        // A process that has been stopped or replaced no longer speaks for this server.
        if (this.proc !== proc) return;
        if (m.type === 'ready') {
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
        clearTimeout(timer);
        if (this.proc !== proc) return resolve();
        this.proc = null;
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
      proc.postMessage({ type: 'start', dir: this.dir, packaged: app.isPackaged });
    });
  }

  notifyRevision(revision: number) {
    this.proc?.postMessage({ type: 'revision', revision });
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
