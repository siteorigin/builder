import { app, utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WebsiteTools } from '@shared/api';
import { safeJoin, sha } from '../project/fsutil';
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
  if (perf.on) perf.count('files.hashedBytes', Buffer.byteLength(lock + pkg));
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

type ToolsCheck = (req: { npmDir: string; dir: string; cache: string; caches: string[] }, signal?: AbortSignal) => Promise<ToolsAvailability & { packages: LockedPackage[] }>;

/** The check here, in this process: what tests and tools use, and the app until it sets its own. */
const checkHere: ToolsCheck = async ({ npmDir, dir, cache, caches }) => {
  const packages = await lockedPackages(npmDir, dir, {}, cache);
  return { ...cacheCoverage(packages, caches), packages };
};
let toolsCheck: ToolsCheck = checkHere;

/**
 * Who works out what the website tools need from now on: the app hands the check to a process of its own
 * (tools-client.ts), so its main process never loads npm's resolver. Null puts it back here.
 */
export function setToolsCheck(check: ToolsCheck | null): void {
  toolsCheck = check ?? checkHere;
}

/**
 * Whether installing the website tools into `dir` (a project, or the starter it is made from) downloads anything, and
 * which packages it installs: `null` when that cannot be told, such as without a lock. The caches are the ones npm
 * will read.
 */
async function checkTools(dir: string, caches: string[], signal?: AbortSignal): Promise<(ToolsAvailability & { packages: LockedPackage[] }) | null> {
  if (!existsSync(join(dir, 'package-lock.json'))) return null;
  const checking = perf.span('tools.check');
  let tools: (ToolsAvailability & { packages: LockedPackage[] }) | null = null;
  try {
    tools = await toolsCheck({ npmDir: npmDir(), dir, cache: userCache(), caches }, signal);
    perf.count('tools.idealTrees');
    return tools;
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
  const stillMine = ownership(signal, mayWrite);
  // npm removes what is installed before it installs: tools it leaves part done (it failed, the app quit) must never
  // pass for set up, so the marker that says they are goes first, and comes back only once they are (#1395).
  await stillMine();
  await fs.rm(join(dir, '.siteorigin', 'cache', 'deps.json'), { force: true });
  // `npm ci` installs the lock as it was when it began and never writes the package files: they are marked set up as
  // they were then, so files changed while it ran (#1480) are never taken for set up. Without a lock, npm writes one.
  const began = existsSync(join(dir, 'package-lock.json')) ? await lockHash(dir) : null;
  await installTools(dir, onLine, signal, stillMine);
  await markTools(dir, stillMine, began);
}

/** Throws `Canceled` when `signal` has been aborted or `mayWrite` says no. */
const ownership = (signal: AbortSignal | undefined, mayWrite: () => Promise<boolean>) => async () => {
  if (signal?.aborted || !(await mayWrite()) || signal?.aborted) throw new Error('Canceled');
};

/**
 * The bundled npm run as `command` with the settings every run in a project uses, whatever the author's own npm
 * settings say; options of its own go after these, and the packages it is given last (after `--`).
 */
function npmArgs(command: 'ci' | 'install' | 'uninstall', cache: string): string[] {
  const libc = npmLibc(npmDir());
  return [
    join(npmDir(), 'bin', 'npm-cli.js'),
    command,
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
}

/** The cache seeded, what the tools need checked and npm run in `dir`; `stillMine` is asked before each npm run. */
async function installTools(dir: string, onLine: (line: string) => void, signal: AbortSignal | undefined, stillMine: () => Promise<void>): Promise<void> {
  const seeding = perf.span('tools.seedCache');
  let cache = await seedCache();
  seeding();
  let tools = await checkTools(dir, [cache], signal);
  // The shipped cache may have what the user cache lost since it was seeded (a cleared or damaged file): seed it again.
  const bundled = bundledCache();
  if (tools && !tools.offline && bundled && existsSync(bundled)) {
    cache = await seedCache(true);
    tools = await checkTools(dir, [cache], signal);
  }
  const base = npmArgs(existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', cache);
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
}

/**
 * The marker that `dir`'s tools are set up for its lock (dependenciesReady), written once `stillMine` agrees: for the
 * package files that hashed to `hash` when given, else for them as they are now.
 */
async function markTools(dir: string, stillMine: () => Promise<void>, hash: string | null = null): Promise<void> {
  const marking = perf.span('tools.marker');
  hash ??= await lockHash(dir);
  // Cancelled or taken over as the install finished: the project may belong to someone else now.
  await stillMine();
  await writeMarker(dir, hash);
  marking();
}

async function writeMarker(dir: string, hash: string): Promise<void> {
  await fs.mkdir(join(dir, '.siteorigin', 'cache'), { recursive: true });
  await fs.writeFile(join(dir, '.siteorigin', 'cache', 'deps.json'), JSON.stringify({ lockHash: hash, preparedAt: new Date().toISOString() }));
}

/** One of the bundled npm's own modules (`npm-package-arg`), as the npm that runs the installs has it. */
export function npmModule<T>(name: string): T {
  return createRequire(join(npmDir(), 'package.json'))(name) as T;
}

/** A project's package files, with its own npm settings (`.npmrc`) when it has them. */
export type ProjectPackageFiles = PackageFiles & { '.npmrc'?: string | null };

/**
 * What npm makes of a project's package files for one change to its packages (#1480): `npm <command> <options> --
 * <spec>` with `--package-lock-only`, run in a private folder that holds a copy of them. Nothing of the project is
 * touched (its files, its tools, its preview), so a change npm refuses, a package or version the registry does not
 * have or no network, leaves everything as it was. The project's own npm settings (a registry of its own) come along.
 */
export async function resolvePackageFiles(files: ProjectPackageFiles, command: 'install' | 'uninstall', options: string[], spec: string, signal?: AbortSignal): Promise<PackageFiles> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'siteorigin-packages-'));
  try {
    for (const name of ['package.json', 'package-lock.json', '.npmrc'] as const) {
      const text = files[name];
      if (typeof text === 'string') await fs.writeFile(join(dir, name), text);
    }
    const cache = await seedCache();
    // An install asks the registry what is there now (`zod@latest` is the latest), where a removal needs nothing new.
    // Whatever the author's own npm settings say, the change is saved and made for real.
    const fresh = command === 'install' ? '--prefer-online' : '--prefer-offline';
    await runNpm([...npmArgs(command, cache), '--package-lock-only', fresh, '--save=true', '--dry-run=false', ...options, '--', spec], dir, () => undefined, signal);
    const [pkg, lock] = await Promise.all(['package.json', 'package-lock.json'].map((f) => fs.readFile(join(dir, f), 'utf8')));
    return { 'package.json': pkg, 'package-lock.json': lock };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Where a new project's website tools are installed before they are moved into it (stageDependencies). */
const stagingRoot = () => join(app.getPath('userData'), 'tools-staging');
/** Stages are named after the app process that made them, so one a crash left behind can be told apart. */
const TOOLS_STAGE_RE = /^tools-(\d+)-[0-9a-f]{12}$/;
/** Every stage carries this mark: only a folder with it is ever removed as one. */
const TOOLS_STAGE_MARK = '.siteorigin-tools-stage';
/** The stages in use in this app. */
const activeStages = new Set<string>();
/** Windows can refuse to move a folder of files just written while something (an indexer, antivirus) holds one open. */
const MOVE_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** How many times a refused move is tried, each under its own claim on the lock, with a longer wait after each. */
const MOVE_ATTEMPTS = 8;

/** The package files a new project is made with, as the app wrote them: what npm installs from. */
export interface PackageFiles {
  'package.json': string;
  'package-lock.json': string;
}

/** What a staged install may do in the project it is moved into: its session's checks of the lock. */
export interface ToolsOwner {
  /** Asked before an install runs in the project itself (prepareDependencies' `mayWrite`). */
  mayWrite(): Promise<boolean>;
  /** Run `fn` only while this app owns the project, holding its lock's claim throughout (ProjectSession.whileOwner). */
  whileOwner(fn: () => Promise<unknown>): Promise<boolean>;
}

/** A new project's website tools being installed beside it, until they are moved in (`adopt`) or dropped (`discard`). */
export interface StagedDependencies {
  /**
   * Wait for the install, then, holding the project's lock claim, move its `node_modules` into the project and mark
   * the tools set up, as prepareDependencies leaves them. npm's lines so far go to `onLine` at once, later ones as they
   * come. When the install could not be staged (no stage could be made on the project's volume) or the project is no
   * longer as it was staged for (its package files changed, it has npm settings of its own, something is where its
   * node_modules go), or the move is refused, the install runs in the project now instead.
   */
  adopt(onLine: (line: string) => void, owner: ToolsOwner): Promise<void>;
  /** Stop the install and everything it started, and remove what it left; nothing goes into the project. */
  discard(): Promise<void>;
}

/**
 * Start installing the website tools of the project being made in `dir` from `files`, the package files the app wrote
 * there, in a folder of the app's own, so npm's run overlaps the writing of the project's documents while nothing is
 * written into the project before it is locked: `adopt` moves the install in by a rename, which keeps every file npm
 * wrote as it wrote it. npm installs from the same lock and manifest, in a folder of the project's name, so the project
 * gets the node_modules an install in place makes (npm's hidden lockfile names the package, and every link in it is
 * relative). Aborting `signal` stops it.
 */
export function stageDependencies(dir: string, files: PackageFiles, signal?: AbortSignal): StagedDependencies {
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const stage = join(stagingRoot(), `tools-${process.pid}-${randomBytes(6).toString('hex')}`);
  const cwd = join(stage, basename(dir));
  // As lockHash reads the project's own.
  const hash = sha(files['package-lock.json'] + files['package.json']);
  activeStages.add(stage);
  let sink: ((line: string) => void) | null = null;
  const held: string[] = [];
  const onLine = (line: string) => (sink ? sink(line) : held.push(line));
  let warmer: Warmer | null = null;
  // Set once this made the stage: only then is it this one's to remove.
  let made = false;
  // A folder to install in, on the project's volume (a rename cannot cross volumes), never through a link. One that
  // cannot be made is no failure of the install: it runs in the project instead, as before.
  const prepare = async () => {
    try {
      await fs.mkdir(stagingRoot(), { recursive: true });
      if ((await fs.lstat(stagingRoot())).isSymbolicLink()) return false;
      await fs.mkdir(stage);
      made = true;
      await fs.writeFile(join(stage, TOOLS_STAGE_MARK), JSON.stringify({ pid: process.pid }));
      await fs.mkdir(cwd);
      if ((await fs.stat(cwd)).dev !== (await fs.stat(dir)).dev) return false;
      for (const [name, text] of Object.entries(files)) await fs.writeFile(join(cwd, name), text);
      return true;
    } catch {
      return false;
    }
  };
  // Whether the install is in the stage, ready to move in.
  const work = (async () => {
    if (abort.signal.aborted) throw new Error('Canceled');
    void clearLeftStages();
    if (!(await prepare())) return false;
    warmer = startWarmer(abort.signal);
    try {
      await installTools(cwd, onLine, abort.signal, ownership(abort.signal, async () => true));
      // What there is to load is read while it is all still here; the tools move in once installed, loaded or not.
      warmer?.load(cwd, await nativeModules(cwd));
      return true;
    } catch (e) {
      warmer?.stop();
      throw e;
    }
  })();
  work.catch(() => undefined);
  let removed: Promise<void> | null = null;
  const remove = () =>
    (removed ??= work
      .catch(() => undefined)
      .then(() => (made ? fs.rm(stage, { recursive: true, force: true }) : undefined))
      .catch(() => undefined)
      .finally(() => {
        activeStages.delete(stage);
        signal?.removeEventListener('abort', stop);
      }));
  // The process loading native modules stopped and gone, when there is one.
  const ended = async () => {
    warmer?.stop();
    await warmer?.exited;
  };
  // Each attempt under its own claim, every check made again: a wait between two never holds the claim, which an
  // unlock passes over once it has sat unchanged for a while.
  const moveIn = async (owner: ToolsOwner) => {
    // Ended only with the marker written: a move that does not happen leaves the marker to the install in place.
    const marking = perf.span('tools.marker');
    let moved = false;
    let marked = false;
    try {
      for (let attempt = 1; ; attempt++) {
        let busy = false;
        const ran = await owner.whileOwner(async () => {
          if (signal?.aborted) return;
          const target = safeJoin(dir, 'node_modules');
          // Installed for the package files the project has now, with no npm settings of its own, into a place
          // nothing has taken meanwhile.
          if ((await lockHash(dir)) !== hash || (await taken(join(dir, '.npmrc'))) || (await taken(target))) return;
          try {
            await fs.rename(join(cwd, 'node_modules'), target);
          } catch (e) {
            busy = MOVE_RETRY.has((e as NodeJS.ErrnoException).code ?? '');
            return;
          }
          moved = true;
          await writeMarker(dir, hash);
          marked = true;
        });
        if (!ran || signal?.aborted) throw new Error('Canceled');
        if (moved || !busy || attempt === MOVE_ATTEMPTS) return moved;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    } finally {
      if (marked) marking();
    }
  };
  return {
    async adopt(lines, owner) {
      sink = lines;
      for (const line of held.splice(0)) lines(line);
      try {
        const moved = (await work) && (await moveIn(owner));
        if (moved) warmer?.moved(dir);
        else {
          await ended();
          const stillMine = ownership(signal, () => owner.mayWrite());
          await installTools(dir, lines, signal, stillMine);
          await markTools(dir, stillMine);
        }
      } catch (e) {
        // A project opened without its tools (a download that failed) has nothing of this running on.
        await ended();
        throw e;
      } finally {
        await remove();
      }
    },
    async discard() {
      stop();
      await remove();
      await ended();
    }
  };
}

/** The process loading a new project's native modules once (startWarmer). */
interface Warmer {
  /** Settles once the process has gone. */
  readonly exited: Promise<void>;
  /** The native modules to load, relative to `root`, where they are now. */
  load(root: string, files: string[]): void;
  /** They are in `root` now, moved there by the app: the rest load from there. */
  moved(root: string): void;
  stop(): void;
}

/**
 * macOS checks a native binary the first time anything loads it, which for one npm has just written takes a while
 * (on an M4 Max, ~240 ms for Rolldown's 18 MB binding and ~130 ms for the file watcher's 160 KB one, one check at a time
 * for the whole system), and remembers the check for that file wherever it is moved. So a new project's native modules
 * are loaded once in a process of their own while the project is still being made, and its preview's first start finds
 * them checked. The process starts with the install and waits for it (`load`), so its own start is not waited for too.
 * It loads only what npm installed into the stage, and from the project only once the app has moved that install there
 * itself (`moved`). Failing or slow, it is only time not saved. Null where there is nothing to gain.
 */
function startWarmer(signal: AbortSignal): Warmer | null {
  if (process.platform !== 'darwin' || signal.aborted) return null;
  const child = spawn(process.execPath, ['-e', WARM_NATIVES], { env: projectEnv({ ELECTRON_RUN_AS_NODE: '1' }), stdio: ['pipe', 'ignore', 'ignore'] });
  const stop = () => {
    child.kill();
  };
  const exited = new Promise<void>((resolve) => {
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
  // One that never got its list, or never finished it, is ended. Its input ends when the app does, and so does it.
  const timer = setTimeout(stop, 60_000);
  signal.addEventListener('abort', stop, { once: true });
  child.stdin?.on('error', () => undefined);
  void exited.then(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  });
  const send = (m: { root: string; files?: string[] }) => child.stdin?.write(`${JSON.stringify(m)}\n`);
  return {
    exited,
    load(root, files) {
      if (!files.length) return stop();
      const warming = perf.span('tools.warm', { files: files.length });
      void exited.then(() => warming());
      send({ root, files });
    },
    moved(root) {
      send({ root });
      child.stdin?.end();
    },
    stop
  };
}
/**
 * Every native module npm wrote into `dir`'s node_modules, relative to `dir`, in the order of their paths, as the lock
 * lists packages (a scoped build tool's binding before the file watcher's).
 */
async function nativeModules(dir: string): Promise<string[]> {
  const names = await fs.readdir(join(dir, 'node_modules'), { recursive: true }).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith('.node'))
    .map((n) => join('node_modules', n))
    .sort();
}

/**
 * Reads lines of `{ root, files }` (the modules to load, relative to `root`) and then `{ root }` (they were moved there)
 * and loads each native module, as Node's require would, and nothing else. One no longer where it was waits to be told
 * where it went; once its input ends it loads what it can and stops.
 */
const WARM_NATIVES = `const path = require('node:path');
const fs = require('node:fs');
let root = '';
let files = [];
let input = '';
let ended = false;
const step = () => {
  while (files.length) {
    const file = path.join(root, files[0]);
    try {
      process.dlopen({ exports: {} }, file);
    } catch {
      if (!ended && !fs.existsSync(file)) return;
    }
    files.shift();
  }
  if (ended) process.exit(0);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
  for (let i; (i = input.indexOf('\\n')) >= 0; ) {
    const m = JSON.parse(input.slice(0, i));
    input = input.slice(i + 1);
    root = m.root;
    if (m.files) files = m.files;
  }
  step();
});
process.stdin.on('end', () => {
  ended = true;
  step();
});`;

/** Whether anything is at `path`, a link included. */
async function taken(path: string): Promise<boolean> {
  perf.count('files.stats');
  return fs.lstat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  );
}

/**
 * Remove the stages a creation that never finished (the app quit or crashed meanwhile) left behind: only folders with
 * the mark, made by an app that is no longer running, or by this one and no longer in use; never through a link.
 */
async function clearLeftStages(): Promise<void> {
  const root = stagingRoot();
  if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) return;
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const pid = Number(TOOLS_STAGE_RE.exec(name)?.[1]);
    const path = join(root, name);
    if (!pid || activeStages.has(path) || (pid !== process.pid && running(pid))) continue;
    if (!(await fs.lstat(path).catch(() => null))?.isDirectory() || !(await fs.lstat(join(path, TOOLS_STAGE_MARK)).catch(() => null))?.isFile()) continue;
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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

/**
 * V8 settings of the preview's dev server: compiled code is never thrown away for being idle. The server collects its
 * garbage once it has gone quiet (src/runtime/idle-collect.ts), a collection that would otherwise drop the bytecode of
 * everything it has not just run, and the next save would compile the toolchain's code all over again. Given as
 * Chromium's switch, which the utility process reads before it creates its V8 isolate.
 */
export const DEV_SERVER_V8_FLAGS = ['--no-flush-bytecode'];

/** How long a stopping preview process gets: asked to stop, then terminated, then killed, then no longer waited for. */
export const STOP_LIMITS = { termMs: 1500, killMs: 3000, giveUpMs: 5000 };

/** Dev server for one project, in its own utility process. */
export class DevServer {
  private proc: UtilityProcess | null = null;
  status: RuntimeStatus = { state: 'idle' };
  private restarts = 0;
  private listeners = new Set<(s: RuntimeStatus) => void>();
  private publishedListeners = new Set<(revision: number, ticket: number) => void>();
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
   * a page loaded from here on is that revision. `ticket` is the notification's own, given back.
   */
  onPublished(fn: (revision: number, ticket: number) => void) {
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
      execArgv: [`--js-flags=${DEV_SERVER_V8_FLAGS.join(' ')}`],
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
      proc.on('message', (m: { type: string; url?: string; message?: string; level?: string; id?: string; revision?: number; ticket?: unknown; name?: unknown; at?: unknown }) => {
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
          for (const fn of this.publishedListeners) fn(Number(m.revision), Number.isSafeInteger(m.ticket) ? (m.ticket as number) : 0);
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

  /** `ticket` numbers this notification: the preview gives it back once it has published the revision (onPublished). */
  notifyRevision(revision: number, ticket = 0) {
    this.proc?.postMessage({ type: 'revision', revision, ticket });
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
  /** Whether the worker had exited when the build settled: one that had not may still be writing where it ran. */
  exited?: boolean;
}

/**
 * The production build's own environment. Rolldown's native heap (mimalloc) keeps the pages each bundle frees for a
 * second before handing them back, so the SSR bundle's are still held while the client bundle and then prerendering
 * add theirs: on a site of 550 pages some 150 MB of the build's peak. With no delay they go back as they are freed.
 * The dev server is not given it: its native heap is live data.
 */
export const BUILD_ENV = { NODE_ENV: 'production', MIMALLOC_PURGE_DELAY: '0' } as const;

/**
 * V8 settings of the production build, given as Chromium's switch as the dev server's are. Its heaps (the build's own
 * and those of SvelteKit's analysis and prerendering workers) grow by a fifth at a time instead of the factor of up
 * to four V8 picks for itself, with young generations of 4 MB semi-spaces: on a site of 550 pages some 190 MB less at
 * the build's peak, for no measurable change in how long it takes. Neither lowers the old generation's limit, so a
 * large site still has the room V8 gives it.
 */
export const BUILD_V8_FLAGS = ['--heap-growing-percent=20', '--max-semi-space-size=4'];

/**
 * Run a production build of the project in a one-shot worker. It always settles: on the build's result, the
 * worker exiting, an error the worker reports without exiting, or a time limit. The worker never outlives it.
 */
export function buildProject(dir: string): Promise<BuildOutcome> {
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(workerPath(), [], { cwd: dir, env: projectEnv(BUILD_ENV), execArgv: [`--js-flags=${BUILD_V8_FLAGS.join(' ')}`], serviceName: 'SiteOrigin project build', stdio: 'pipe' });
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
          resolve({ ...result(), exited: wait });
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
