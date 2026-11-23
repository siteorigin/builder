import { app, utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from '../project/fsutil';

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
  return JSON.parse(marker).lockHash === (await lockHash(dir));
}

/**
 * Install the project's locked dependencies with the npm bundled inside the app, running on Electron's own Node.
 * Package lifecycle scripts are disabled; the template's dependencies do not need them.
 */
export async function prepareDependencies(dir: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const npmCli = app.isPackaged ? join(process.resourcesPath, "npm", "bin", "npm-cli.js") : join(dirname(nodeRequire.resolve("npm/package.json")), "bin", "npm-cli.js");
  const cache = await seedCache();
  const base = [npmCli, existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `--cache=${cache}`];
  // Try the packages bundled with the app first (works offline); fall back to downloading what is missing.
  try {
    await runNpm([...base, '--offline'], dir, onLine, signal);
    onLine('Installed from the tools bundled with SiteOrigin Builder.');
  } catch (e) {
    if (signal?.aborted) throw e;
    onLine('Some website tools are not bundled for this system; downloading them…');
    await runNpm([...base, '--prefer-offline'], dir, onLine, signal);
  }
  await fs.mkdir(join(dir, '.siteorigin', 'cache'), { recursive: true });
  await fs.writeFile(join(dir, '.siteorigin', 'cache', 'deps.json'), JSON.stringify({ lockHash: await lockHash(dir), preparedAt: new Date().toISOString() }));
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

/** Dev server for one project, in its own utility process. */
export class DevServer {
  private proc: UtilityProcess | null = null;
  status: RuntimeStatus = { state: 'idle' };
  private restarts = 0;
  private listeners = new Set<(s: RuntimeStatus) => void>();
  logs: Array<{ level: string; message: string; time: number }> = [];
  private stopped = false;

  constructor(private dir: string) {}

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
          void this.start();
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

  /** Stop the server and wait for its process to exit, so a restart never overlaps the old one. */
  stop(): Promise<void> {
    this.stopped = true;
    const p = this.proc;
    this.proc = null;
    if (p) {
      const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()));
      p.postMessage({ type: 'stop' });
      const timer = setTimeout(() => p.kill(), 1500);
      // Every caller waits for the same exit, including one that arrives after this.proc was cleared.
      this.stopping = Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]).finally(() => clearTimeout(timer));
    }
    const done = (this.stopping ?? Promise.resolve()).then(() => this.set({ state: 'idle' }));
    return done;
  }
}

/** Run a production build of the project in a one-shot worker. */
export function buildProject(dir: string): Promise<{ ok: boolean; error?: string; logs: string[] }> {
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(workerPath(), [], { cwd: dir, env: projectEnv({ NODE_ENV: 'production' }), serviceName: 'SiteOrigin project build', stdio: 'pipe' });
    let done = false;
    const errLines: string[] = [];
    proc.stderr?.on('data', (d) => errLines.push(String(d)));
    proc.on('message', (m: { type: string; ok?: boolean; error?: string; logs?: string[] }) => {
      if (m.type === 'built') {
        done = true;
        resolve({ ok: !!m.ok, error: m.error, logs: m.logs ?? [] });
      }
    });
    proc.on('exit', (code) => {
      if (!done) resolve({ ok: false, error: `Build process exited (${code}). ${errLines.join('').slice(-800)}`, logs: [] });
    });
    proc.postMessage({ type: 'build', dir });
  });
}
