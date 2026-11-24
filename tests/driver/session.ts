/**
 * One isolated run of the built app, from launch to teardown: the session owner behind the test driver.
 *
 * A session makes a run root of its own (a new temporary folder carrying an ownership mark) holding the app's profile,
 * a workspace that stands in for Documents, a home and temp folder for the app and its children, and an artifacts
 * folder. It launches `out/` headless with an environment built from an allowlist, so nothing of the person's own
 * profile, projects, API keys or running Builder is reachable, and sets the app up with a scripted local AI server
 * that costs nothing. Every step of starting shares one deadline; closing is bounded too, ends every process the app
 * started (the preview's dev server, npm, helpers) and removes only what the session made.
 *
 * Requests go through `call()`, which speaks protocol.ts; in-process callers (the e2e harness) may also use `app`
 * and `page` directly.
 */
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, ElementHandle, Page } from 'playwright';
import { MockOpenAIServer } from '../unit/mock-openai-server.ts';
import { parseAction, runAction } from './act.ts';
import { AssistantTracker, Script, journalInMain, liveSettings, liveSetup, parseLive, writeLiveKey, parseObserveArgs, parseScript, parseWaitArgs as parseAssistantWaitArgs, readChat, rendered, scrubAssistant, settledState, shownTurn } from './assistant.ts';
import type { JournalCall, LiveSetup, RawRecord, RunView, ShownChat } from './assistant.ts';
import { desktopInMain, inMain, invokeMenuInMain, listSessionFolder, menuTreeInMain, resolveAnswer, stageImport } from './desktop.ts';
import type { Area } from './desktop.ts';
import { CLASS_OF, CLIP, Journal, LogKeeper, REPLAY_KIND, REPLAY_VERSION, clipJson, hideDeep, machineRoots, pathHider, scrubAll, scrubText } from './evidence.ts';
import type { EntryOutcome, JournalEntry, ReplayRecord, TargetDescriptor } from './evidence.ts';
import { SECRET_INPUTS, elementFor, frameSecrets, parseLocateArgs, parseSnapshotArgs, parseWaitArgs, uiLocate, uiSnapshot, waitFor } from './observe.ts';
import type { ObserveEnv, Shots, SnapshotResult } from './observe.ts';
import { inspectExport, judgeApp, judgeContext, judgeLocate, judgeTerminal, parseCondition, parseInspectArgs, probeApp, readProjectDocs, toSessionPath } from './outcomes.ts';
import type { AppProbe, Checkpoint, Condition, ExportBrief, LocateSample, Verdict } from './outcomes.ts';
import { killTree, killTreeSync, ownedEntries, processTable } from './processes.ts';
import type { ProcessEntry } from './processes.ts';
import { DriverError, PROTOCOL_VERSION, errorInfo, failure, frameIdentity, parseRequest, success } from './protocol.ts';
import type { Capability, CloseArgs, CloseResult, FixtureName, KeepArtifacts, LocateArgs, Reply, ReplyContext, Request, SessionEvent, StartArgs, WindowRef } from './protocol.ts';
import { DEFAULT_STARTUP_MS, OPERATIONS, capabilities } from './operations.ts';
import type { OpSpec } from './operations.ts';
import { RefRegistry, scrubDeep, scrubber } from './snapshot.ts';
import type { Scope } from './snapshot.ts';
import { ShotRegistry } from './shots.ts';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The file that marks a folder as made by one session: nothing without it is ever removed. */
export const OWNER_MARK = '.siteorigin-test-session.json';

const DEFAULT_CLOSE_MS = 15_000;
/** How long a launch still in flight when the session closes gets to settle once its process is gone. */
const SETTLE_MS = 30_000;
const MAX_EVENTS = 100;
/** Page errors kept for evidence (the count goes on): the latest ones. */
const MAX_PAGE_ERRORS = 200;
/** How often a wait looks again at what it waits for. */
const POLL_MS = 200;
/** Failures that end a wait at once, though a later request could succeed: the window or the app it watches is gone. */
const WAIT_FATAL = new Set(['WINDOW_CLOSED', 'WINDOW_REPLACED', 'APP_EXITED', 'BUSY', 'CLOSED']);
/** How a request's args are kept in the record: whole up to this (a longer one cannot be replayed). */
const ARG_CLIP = { ...CLIP, string: 2000 };
/** How an observation is kept as evidence. */
const OBSERVATION_CLIP = { string: 300, items: 40, depth: 10, keys: 40 };
/** The longest page error kept (its count goes on). */
const PAGE_ERROR_CHARS = 8000;
/** How often app.log is brought up to date while the app runs. */
const LOG_FLUSH_MS = 2000;

/**
 * Whether a key chord types a character into what has the focus (a letter, a digit, a symbol, a space), rather than a
 * shortcut or a named key: such keys can spell a credential one at a time, so the record never keeps them.
 */
export function printableKey(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const parts = key.split('+');
  const last = parts[parts.length - 1] || (key.endsWith('+') ? '+' : '');
  const mods = parts.slice(0, -1);
  if (mods.some((m) => /^(Control|Meta|ControlOrMeta|Alt)$/.test(m))) return false;
  return [...last].length === 1 || /^(Key[A-Z]|Digit\d|Numpad\d|Space)$/.test(last);
}
/** How long a replay record's observation (and its screenshots) may take. */
const RECORD_OBSERVATION_MS = 8000;

const FIXTURES: Record<Exclude<FixtureName, 'welcome'>, { name: string; starter: 'business' | 'blank'; sampleImages: boolean }> = {
  'business-v1': { name: 'Fixture Business', starter: 'business', sampleImages: false }
};

export type StartPhase = 'build' | 'root' | 'provider' | 'app.spawned' | 'app.launched' | 'window' | 'isolation' | 'welcome' | 'provider.settings' | 'fixture.created' | 'fixture.ready' | 'ready';

export interface SessionHooks {
  /** Called as starting reaches each phase; a returned promise holds the start there (tests use it as a barrier). */
  phase?(phase: StartPhase, session: Session): void | Promise<void>;
}

export interface SessionOptions {
  /** Where the run root is made. Default: $WORK, else the OS temp folder. */
  parentDir?: string;
  /** The checkout whose built app (out/) is launched. Default: this one. */
  appRoot?: string;
  /** How long the app gets to quit before it is killed. */
  closeTimeoutMs?: number;
  /** The page's emulated viewport, or null to follow the (hidden) native window. */
  viewport?: { width: number; height: number } | null;
  hooks?: SessionHooks;
  /**
   * Keep the window hidden and the artifacts inside the session's own run folder, whatever a request asks: session.start
   * refuses `headed` and `artifactsDir`. The MCP server's hosts run contained, since its client is a model.
   */
  contained?: boolean;
}

/**
 * The largest image `evidence.read` returns, before base64: its reply (a third larger as base64) stays well inside the
 * 10 MiB line the official MCP SDK reads.
 */
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/**
 * The bytes of an image the session saved at `path`, while it is still a plain file inside its artifacts folder (no
 * link put in its place, or in a folder's), no larger than `limit`, and the very bytes it captured.
 */
export async function readSavedImage(
  artifactsDir: string,
  path: string,
  id: string,
  captured: { bytes: number; sha256: string },
  limit = MAX_EVIDENCE_BYTES
): Promise<{ bytes: number; sha256: string; data: string }> {
  const moved = () => new DriverError('OP_FAILED', `The screenshot ${id} is no longer where the session saved it.`, { details: { reason: 'moved' } });
  const tooLarge = (bytes: number) => new DriverError('OP_FAILED', `The screenshot ${id} is ${bytes} bytes, more than evidence.read returns (${limit}).`, { details: { reason: 'too-large', bytes, limit } });
  const artifacts = await realpath(artifactsDir).catch(() => null);
  const folder = await realpath(dirname(path)).catch(() => null);
  if (!artifacts || !folder || !isInside(artifacts, folder)) throw moved();
  // Non-blocking: something put in its place that is not a file (a FIFO) cannot hold the read up; it fails isFile below.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)).catch(() => null);
  if (!file) throw moved();
  try {
    const info = await file.stat();
    if (!info.isFile()) throw moved();
    if (info.size > limit) throw tooLarge(info.size);
    const png = await file.readFile();
    if (png.length > limit) throw tooLarge(png.length);
    // Only the bytes it captured: a file changed or put in its place since (by any path) is not that screenshot.
    const sha256 = createHash('sha256').update(png).digest('hex');
    if (png.length !== captured.bytes || sha256 !== captured.sha256) throw new DriverError('OP_FAILED', `The screenshot ${id} has changed since the session saved it.`, { details: { reason: 'changed' } });
    return { bytes: png.length, sha256, data: png.toString('base64') };
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** One screenshot the session saved, as `evidence.read` returns it. */
export interface Evidence {
  id: string;
  surface: 'editor' | 'preview';
  mimeType: 'image/png';
  width: number;
  height: number;
  path: string;
  /** Present with the image; absent when it was withheld. */
  bytes?: number;
  sha256?: string;
  /** The PNG, base64. */
  data?: string;
  /** Why the image was not returned. */
  withheld?: string;
}

type State = 'new' | 'starting' | 'ready' | 'closing' | 'closed';

/** The catalog lives in operations.ts, which loads nothing of Playwright; existing callers import it from here. */
export { OPERATIONS, capabilities };

/** Whether an address is the editor's own page (not a hidden thumbnail window or anything else). */
export function isEditorUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'editor';
  } catch {
    return false;
  }
}

/** Whether `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** Variables an app may need from the environment to run at all; nothing else of the caller's reaches it. */
const ENV_ALLOW = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SystemRoot',
  'SYSTEMROOT',
  'SystemDrive',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS'
]);

export interface SessionPaths {
  root: string;
  profile: string;
  workspace: string;
  /** Where new projects go by default: the app's Documents/SiteOrigin. */
  projects: string;
  /** Files for choosers to be answered with (files.stageImport). */
  imports: string;
  /** Where choosers may be answered to save exports. */
  exports: string;
  home: string;
  tmp: string;
  artifacts: string;
}

/** The environment a session's app runs with: an allowlist of the caller's, then the session's own folders. */
export function sessionEnv(paths: SessionPaths, { headed = false, base = process.env }: { headed?: boolean; base?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && (ENV_ALLOW.has(k) || k.startsWith('LC_'))) env[k] = v;
  Object.assign(env, {
    HOME: paths.home,
    USERPROFILE: paths.home,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    XDG_CONFIG_HOME: join(paths.home, '.config'),
    XDG_CACHE_HOME: join(paths.home, '.cache'),
    XDG_DATA_HOME: join(paths.home, '.local', 'share'),
    SITEORIGIN_USER_DATA: paths.profile,
    SITEORIGIN_DOCUMENTS: paths.workspace,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: ''
  });
  if (headed) env.SITEORIGIN_HEADED = '1';
  else env.SITEORIGIN_HEADLESS = '1';
  return env;
}

// ---------------------------------------------------------------------------
// Launching: shared with the e2e harness
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  env: Record<string, string | undefined>;
  cwd?: string;
  /** One deadline for launching, the editor window and its ready selector. */
  timeoutMs?: number;
  viewport?: { width: number; height: number } | null;
  /** What the editor shows once it is ready. */
  readySelector?: string;
  /** Called with the app's main process the moment it is spawned, before Playwright hands it over. */
  onSpawn?: (child: ChildProcess) => void;
  /** Playwright's own files (traces, downloads). Default: a temporary folder it removes. */
  artifactsDir?: string;
}

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  /** The page errors the editor raised. */
  errors: string[];
  pid: number;
}

/** The error Playwright's Electron launcher rejects with when the app exits before it is connected. */
const PLAYWRIGHT_LAUNCH_FAILED = 'Process failed to launch!';

/**
 * Playwright waits for three lines from the app but awaits one at a time: if the app is killed before the first, the
 * other two waits reject with no one listening, which would end this process. While any launch is settling, those
 * rejections, and only those, are let go. Anything else is left to the process's own listeners when it has any, and
 * otherwise thrown, as Node does with an unhandled rejection by default.
 */
let launchesSettling = 0;
/** How this process was told to treat unhandled rejections (`--unhandled-rejections`); Node's default is `throw`. */
function rejectionMode(): string {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  return flags.map((f) => /^--unhandled-rejections=(\S+)$/.exec(f)?.[1]).filter((m): m is string => !!m).pop() ?? 'throw';
}
function onUnhandledRejection(reason: unknown) {
  if (reason instanceof Error && reason.message === PLAYWRIGHT_LAUNCH_FAILED) return;
  if (process.listenerCount('unhandledRejection') > 1) return;
  // Having a listener turns Node's own handling off, so it is done here as the process was told to.
  const mode = rejectionMode();
  if (mode === 'throw' || mode === 'strict') throw reason;
  if (mode === 'none') return;
  process.emitWarning(`Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  if (mode === 'warn-with-error-code') process.exitCode = 1;
}
function tolerateStrayLaunchFailures(): () => void {
  if (launchesSettling++ === 0) process.on('unhandledRejection', onUnhandledRejection);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setTimeout(() => {
      if (--launchesSettling === 0) process.off('unhandledRejection', onUnhandledRejection);
    }, 5000).unref();
  };
}

interface ElectronStart {
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs: number;
  /** Arguments after the app path. */
  args?: string[];
  artifactsDir?: string;
  /** Called with the app's main process once it has spawned, before Playwright hands it over. */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * Launch Electron through Playwright, knowing its main process from the moment it spawns. Playwright spawns the app
 * inside `electron.launch()`, so watching this process's spawns is the only way to know its pid if the launch never
 * returns. Each launch carries an argument of its own, so two launches at once never take each other's process.
 */
async function startElectron(opts: ElectronStart): Promise<ElectronApplication> {
  const token = `--siteorigin-launch=${randomBytes(8).toString('hex')}`;
  const onMessage = (message: unknown) => {
    const child = (message as { process?: ChildProcess }).process;
    // Published as the process object is made, before it has arguments or a pid: look once it has spawned. On Windows
    // Playwright runs the app through a shell, with the arguments inside one command line.
    child?.once('spawn', () => {
      if (child.pid && child.spawnargs.some((a) => a.includes(token))) opts.onSpawn?.(child);
    });
  };
  subscribe('child_process', onMessage);
  const release = tolerateStrayLaunchFailures();
  try {
    return await electron.launch({ args: ['.', ...(opts.args ?? []), token], cwd: opts.cwd, env: definedEnv(opts.env), timeout: opts.timeoutMs, ...(opts.artifactsDir ? { artifactsDir: opts.artifactsDir } : {}) });
  } finally {
    unsubscribe('child_process', onMessage);
    release();
  }
}

/** The process-table entry of a process just spawned, read as soon as it can be: its identity from then on. */
async function identify(pid: number): Promise<ProcessEntry | null> {
  return processTable()
    .then((t) => t.find((p) => p.pid === pid) ?? null)
    .catch(() => null);
}

/** Wait for the app's editor window: the first window at the editor's address, skipping any other (hidden) window. */
export async function editorWindow(app: ElectronApplication, timeoutMs: number, isEditor: (url: string) => boolean = isEditorUrl): Promise<Page> {
  return new Promise<Page>((resolvePage, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(null, new Error(`No editor window appeared within ${timeoutMs / 1000}s.`)), timeoutMs);
    const finish = (page: Page | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      app.off('window', consider);
      app.off('close', onClose);
      if (page) resolvePage(page);
      else reject(err);
    };
    const onClose = () => finish(null, new Error('The app exited before its editor window appeared.'));
    const consider = (page: Page) => {
      void settledUrl(page, timeoutMs).then((url) => {
        if (url && isEditor(url)) finish(page);
      });
    };
    app.on('window', consider);
    app.on('close', onClose);
    for (const page of app.windows()) consider(page);
  });
}

/** The page's address once it has left about:blank, or null if it closed or never did. */
async function settledUrl(page: Page, timeoutMs: number): Promise<string | null> {
  try {
    await page.waitForURL((u) => u.protocol !== 'about:', { waitUntil: 'commit', timeout: timeoutMs });
    return page.url();
  } catch {
    return null;
  }
}

/**
 * Launch the built app and wait until its editor is ready. A launch that fails part-way kills the app and everything
 * it started before the error is passed on; nothing is left for the caller to clean up.
 */
export async function launchApp(opts: LaunchOptions): Promise<LaunchedApp> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  let pid: number | null = null;
  let identity: Promise<ProcessEntry | null> = Promise.resolve(null);
  let app: ElectronApplication | null = null;
  // An unpackaged build given a dev server's address loads the editor from there instead.
  const devUrl = opts.env.ELECTRON_RENDERER_URL;
  const isEditor = (url: string) => isEditorUrl(url) || (!!devUrl && sameOrigin(url, devUrl));
  try {
    app = await startElectron({
      env: opts.env,
      cwd: opts.cwd ?? REPO_ROOT,
      timeoutMs: left(),
      artifactsDir: opts.artifactsDir,
      onSpawn: (child) => {
        pid = child.pid!;
        identity = identify(pid);
        opts.onSpawn?.(child);
      }
    });
    pid = app.process().pid ?? pid;
    const win = await editorWindow(app, left(), isEditor);
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(String(e)));
    if (opts.viewport !== null) await win.setViewportSize(opts.viewport ?? { width: 1440, height: 900 });
    await win.waitForSelector(opts.readySelector ?? '.welcome', { timeout: left() });
    return { app, win, errors, pid: pid! };
  } catch (e) {
    // An app that started but never became ready is ended here: the caller never gets a handle to it.
    const known = await identity;
    if (pid) await killTree(pid, { known: known ? [known] : [] }).catch(() => undefined);
    else if (app) await app.close().catch(() => undefined);
    throw e;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Build identity
// ---------------------------------------------------------------------------

export interface BuildIdentity {
  outDir: string;
  /** sha256 over every file in out/main, out/preload and out/renderer: names and bytes, in name order. */
  fingerprint: string;
  files: number;
  builtAt: string;
  packageVersion: string | null;
  /** The checkout the build sits in, which may have changed since it was built. */
  git: { head: string; dirty: boolean } | null;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => execFile('git', args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => done(err ? null : stdout)));
}

export async function buildIdentity(root = REPO_ROOT): Promise<BuildIdentity> {
  const outDir = join(root, 'out');
  const main = join(outDir, 'main', 'index.js');
  if (!existsSync(main)) throw new DriverError('BUILD_MISSING', `There is no built app at ${outDir}: run \`npm run build\` first.`);
  const files = (await Promise.all(['main', 'preload', 'renderer'].map((d) => listFiles(join(outDir, d))))).flat();
  const names = files.map((f) => relative(outDir, f).split('\\').join('/')).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(join(outDir, name)));
    hash.update('\0');
  }
  const pkg = await readFile(join(root, 'package.json'), 'utf8').then((t) => JSON.parse(t) as { version?: string }, () => null);
  const head = (await git(['rev-parse', 'HEAD'], root))?.trim();
  const status = head ? await git(['status', '--porcelain', '--untracked-files=no'], root) : null;
  return {
    outDir,
    fingerprint: `sha256:${hash.digest('hex')}`,
    files: names.length,
    builtAt: (await stat(main)).mtime.toISOString(),
    packageVersion: pkg?.version ?? null,
    git: head ? { head, dirty: !!status?.trim() } : null
  };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface Bound {
  page: Page;
  ref: WindowRef;
  closed: boolean;
}

export interface AppIdentity {
  name: string;
  version: string;
  packaged: boolean;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  paths: { userData: string; sessionData: string; documents: string; temp: string; home: string; tmpdir: string | null };
  /** Whether the app answers its native choosers from the test (src/main/headless-desktop.ts). */
  desktopFixtures: boolean;
}

export interface Description {
  protocol: number;
  session: {
    id: string;
    state: State;
    root: string | null;
    paths: SessionPaths | null;
    fixture: FixtureName | null;
    project: string | null;
    provider: { kind: 'scripted'; baseURL: string } | { kind: 'none' } | { kind: 'configured'; provider: string; model: string | null; maxTurns: number; timeoutMs: number } | null;
    headless: boolean;
    keepArtifacts: KeepArtifacts;
    /** The app's main process, and every process the session owns now (it first, then what it started). */
    pid: number | null;
    processes: number[];
    window: WindowRef | null;
    /** The window generation requests run against without naming one. */
    acknowledgedWindow: number | null;
  };
  build: BuildIdentity | null;
  app: AppIdentity | null;
  capabilities: Capability[];
}

const KEEP: KeepArtifacts[] = ['always', 'on-failure', 'never'];

export function parseStartArgs(args: Record<string, unknown> | undefined, contained = false): StartArgs {
  const a = args ?? {};
  const out: StartArgs = {};
  const known = new Set(['fixture', 'provider', 'live', 'keepArtifacts', 'artifactsDir', 'headed']);
  for (const key of Object.keys(a)) if (!known.has(key)) throw new DriverError('BAD_REQUEST', `session.start does not take "${key}".`);
  for (const key of ['headed', 'artifactsDir'])
    if (contained && a[key] !== undefined) throw new DriverError('BAD_REQUEST', `session.start does not take "${key}" here: this session keeps its window hidden and its artifacts inside the session.`);
  if (a.fixture !== undefined) {
    if (a.fixture !== 'welcome' && !(typeof a.fixture === 'string' && Object.hasOwn(FIXTURES, a.fixture))) throw new DriverError('BAD_REQUEST', `Unknown fixture "${String(a.fixture)}": use welcome or ${Object.keys(FIXTURES).join(', ')}.`);
    out.fixture = a.fixture as FixtureName;
  }
  if (a.provider !== undefined) {
    if (a.provider !== 'scripted' && a.provider !== 'none' && a.provider !== 'configured') throw new DriverError('BAD_REQUEST', '"provider" is "scripted", "none" or "configured".');
    out.provider = a.provider;
  }
  if ((a.provider === 'configured') !== (a.live !== undefined)) throw new DriverError('BAD_REQUEST', 'A configured provider is named in "live", and "live" goes only with provider "configured".');
  if (a.live !== undefined) out.live = parseLive(a.live);
  if (a.keepArtifacts !== undefined) {
    if (!KEEP.includes(a.keepArtifacts as KeepArtifacts)) throw new DriverError('BAD_REQUEST', `"keepArtifacts" is one of ${KEEP.join(', ')}.`);
    out.keepArtifacts = a.keepArtifacts as KeepArtifacts;
  }
  if (a.artifactsDir !== undefined) {
    if (typeof a.artifactsDir !== 'string' || !isAbsolute(a.artifactsDir)) throw new DriverError('BAD_REQUEST', '"artifactsDir" is an absolute folder path.');
    out.artifactsDir = a.artifactsDir;
  }
  if (a.headed !== undefined) {
    if (typeof a.headed !== 'boolean') throw new DriverError('BAD_REQUEST', '"headed" is true or false.');
    out.headed = a.headed;
  }
  return out;
}

export function parseCloseArgs(args: Record<string, unknown> | undefined): CloseArgs {
  const a = args ?? {};
  for (const key of Object.keys(a)) if (key !== 'keepArtifacts' && key !== 'failed') throw new DriverError('BAD_REQUEST', `session.close does not take "${key}".`);
  if (a.keepArtifacts !== undefined && !KEEP.includes(a.keepArtifacts as KeepArtifacts)) throw new DriverError('BAD_REQUEST', `"keepArtifacts" is one of ${KEEP.join(', ')}.`);
  if (a.failed !== undefined && typeof a.failed !== 'boolean') throw new DriverError('BAD_REQUEST', '"failed" is true or false.');
  return a as CloseArgs;
}

/** A reply that hands out a screenshot or an evidence id. */
function carriesEvidence(op: string, result: unknown): boolean {
  const r = (result ?? {}) as { data?: unknown; screenshots?: Shots };
  return (op === 'evidence.read' && typeof r.data === 'string') || (op === 'ui.snapshot' && !!(r.screenshots?.editor || r.screenshots?.preview));
}

/** An operation that takes no arguments refuses any, as every other refuses one it does not know. */
function noArgs(request: Request) {
  for (const key of Object.keys(request.args ?? {})) throw new DriverError('BAD_REQUEST', `${request.op} does not take "${key}".`);
}

const now = () => new Date().toISOString();

/**
 * Write a file whole, or not at all: into a new file beside it, then renamed over it. A link put where the file was is
 * replaced, never followed. `check` runs just before the rename (a request that ran out of time publishes nothing).
 */
async function writeWhole(file: string, text: string, check?: () => void) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx' });
    check?.();
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

function writeWholeSync(file: string, text: string) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new DriverError('TIMEOUT', 'The request ran out of time.');
}

/** Wait `ms`, or less if the request is told to stop: the pause between a wait's looks, never a guess at timing. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      r();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** `promise`, or `fallback` once `ms` pass; the timer never outlives the race. */
async function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class Session {
  readonly id = `s-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  state: State = 'new';
  app: ElectronApplication | null = null;
  /** The bound editor window's page; null before the app starts. */
  get page(): Page | null {
    return this.bound?.page ?? null;
  }
  /** Page errors the editor raised, across every window the session bound: the latest MAX_PAGE_ERRORS of them. */
  readonly pageErrors: string[] = [];
  /** How many page errors there have been in all. */
  pageErrorCount = 0;
  paths: SessionPaths | null = null;
  pid: number | null = null;
  mock: MockOpenAIServer | null = null;
  /** What the scripted model answers (assistant.script). */
  script: Script | null = null;
  /** The assistant's runs, read from the app's journal of its events (assistant.observe, assistant.wait). */
  readonly assistant = new AssistantTracker();
  /** A real provider's setup, when the session was started with one (its key never leaves this object). */
  private live: LiveSetup | null = null;

  private readonly options: SessionOptions;
  private readonly appRoot: string;
  private args: StartArgs = {};
  private bound: Bound | null = null;
  private generations = 0;
  private acknowledged: number | null = null;
  private events: SessionEvent[] = [];
  private droppedEvents = 0;
  private appExited = false;
  /** The app's main process as spawned: Node knows when it has exited, after which its pid may be another's. */
  private proc: ChildProcess | null = null;
  /** Every process seen as the session's, by pid, with the start time that tells it from a later one. */
  private readonly seen = new Map<number, ProcessEntry>();
  private failed = false;
  private inFlight: string | null = null;
  private build: BuildIdentity | null = null;
  private appIdentity: AppIdentity | null = null;
  private fixtureProject: string | null = null;
  /** The app's stdout and stderr, bounded; written to the artifacts as app.log when they are kept. */
  private readonly appLog = new LogKeeper();
  private readonly created = Date.now();
  /** Every request, in order, classed as setup, input, observation or session (#497). */
  private readonly journal = new Journal();
  /** The app as it was just before the last input that sent anything: what change conditions compare with. */
  private lastInput: Checkpoint | null = null;
  /** The search that found each ref, while it was unique: how a replay finds the element again. */
  private readonly recipes = new Map<string, { scope: Scope; role: string; name?: string; exact?: boolean; region?: string }>();
  /** The wait running now: what a deadline that cuts it short reports. */
  private waiting: { condition: Condition; samples: number; pending: string; last: unknown; since: number } | null = null;
  /** How much of the app's output app.log holds, and the timer that keeps it up to date. */
  private logFlushed = 0;
  private logTimer: ReturnType<typeof setInterval> | null = null;
  /** The last request that failed, for the evidence. */
  private lastFailure: Record<string, unknown> | null = null;
  /** The latest observation's context and a bounded tree, for the evidence. */
  private lastObservation: unknown = null;
  /** Whether the session got as far as ready: only then is there a run to replay. */
  private reachedReady = false;
  private hide: ((s: string) => string) | null = null;
  /** The replay record being written, and app.log being brought up to date: each write waits for the one before. */
  private saving: Promise<unknown> | null = null;
  /** Closing wrote the run's last record: no save still under way replaces it. */
  private recordSealed = false;
  private flushing: Promise<unknown> | null = null;
  private closeRequested = false;
  /** Whether closing keeps the artifacts: settled by the first close, so a later one cannot change it. */
  private keeping: boolean | null = null;
  private abortStart: ((e: DriverError) => void) | null = null;
  /** The refs observations gave out, and how many observations there have been. */
  private readonly refs = new RefRegistry();
  private observations = 0;
  /** The latest screenshot actions may aim at. */
  private readonly shots = new ShotRegistry();
  /** Operations that ran out of time and may still be running. */
  private readonly lingering = new Set<Promise<unknown>>();
  /** Every credential the session's observations have seen: kept out of everything else it reports. */
  private readonly secrets = new Set<string>();
  /** Every screenshot saved this session, by evidence id, for `evidence.read`. */
  private readonly evidence = new Map<string, { surface: 'editor' | 'preview'; path: string; width: number; height: number; bytes: number; sha256: string }>();
  /** Begins this session's evidence ids. */
  private readonly evidenceTag = randomBytes(3).toString('hex');
  private starting: Promise<unknown> | null = null;
  private launching: Promise<unknown> | null = null;
  private closing: Promise<CloseResult> | null = null;
  /** The artifacts folder lives outside the root (in a caller's folder), in a child the session made. */
  private artifactsOutside = false;

  constructor(options: SessionOptions = {}) {
    this.options = options;
    this.appRoot = resolve(options.appRoot ?? REPO_ROOT);
  }

  // -- requests --------------------------------------------------------------

  /** Answer one request (a parsed frame or its JSON text). Never throws: every failure is a protocol reply. */
  async call(frame: unknown): Promise<Reply> {
    const began = Date.now();
    let request: Request;
    try {
      request = parseRequest(frame);
    } catch (e) {
      let raw = frame;
      if (typeof frame === 'string') {
        try {
          raw = JSON.parse(frame);
        } catch {
          raw = null;
        }
      }
      return failure(frameIdentity(raw), e, await this.replyContext(began));
    }
    const spec = OPERATIONS[request.op];
    // Every request the session knows is numbered as it comes in, whatever becomes of it.
    const entry = spec ? this.admit(request, spec, began) : null;
    const done = (reply: Reply) => {
      if (entry) this.record(entry, request, reply);
      return reply;
    };
    try {
      if (!spec) throw new DriverError('UNKNOWN_OP', `There is no operation "${request.op}".`, { details: { ops: Object.keys(OPERATIONS) } });
      if (request.op !== 'session.close' && this.inFlight) throw new DriverError('BUSY', `Request "${this.inFlight}" is still running; requests run one at a time.`, { retryable: true });
      if (request.op !== 'session.close' && request.op !== 'session.describe' && (this.state === 'closing' || this.state === 'closed')) throw new DriverError('CLOSED', 'The session is closed.');
      if (spec.needsApp && this.state !== 'ready') throw new DriverError('NOT_STARTED', 'Start the session first (session.start).');
    } catch (e) {
      return done(failure(request, e, await this.replyContext(began)));
    }
    if (request.op !== 'session.close') this.inFlight = request.id;
    try {
      const timeoutMs = request.timeoutMs ?? spec.defaultTimeoutMs;
      let result: unknown;
      if (request.op === 'session.start') result = await this.start((request.args ?? {}) as StartArgs, { timeoutMs });
      else if (request.op === 'session.close') result = await this.close(parseCloseArgs(request.args));
      else result = await this.withDeadline(request, spec, timeoutMs, entry);
      const ctx = await this.replyContext(began);
      // Preparing the reply can wait (a page error's scrub reads the saved keys): a close in that time has the last word
      // over anything that hands out evidence, which the close has just forgotten.
      if (this.state !== 'ready' && carriesEvidence(request.op, result)) return done(failure(request, new DriverError('CLOSED', 'The session closed before the reply was sent.'), ctx));
      return done(success(request, result, ctx));
    } catch (e) {
      return done(failure(request, e, await this.replyContext(began)));
    } finally {
      if (this.inFlight === request.id) this.inFlight = null;
    }
  }

  private async withDeadline(request: Request, spec: OpSpec, timeoutMs: number, entry: JournalEntry | null): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Work that outlives its deadline is told to stop, so a late observation publishes no refs and saves no files.
    const abort = new AbortController();
    const work = this.run(request, abort.signal, Date.now() + timeoutMs, entry);
    work.catch(() => undefined);
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        // Until it has stopped, it may still take Playwright snapshots that the next request's refs resolve against.
        const settling: Promise<unknown> = work.catch(() => undefined).finally(() => this.lingering.delete(settling));
        this.lingering.add(settling);
        // Reading leaves nothing half-done, so the session goes on; anything else may still be changing the app.
        const terminal = spec.kind !== 'observe' && spec.kind !== 'session';
        if (terminal) {
          this.failed = true;
          void this.close({ failed: true }).catch(() => undefined);
        }
        // A wait cut short still says what it was waiting for and what it saw last.
        const waited = request.op === 'wait.for' && this.waiting ? this.cutShort(this.waiting) : {};
        reject(new DriverError('TIMEOUT', `${request.op} did not finish within ${timeoutMs / 1000}s.`, { retryable: request.op === 'wait.for', details: { phase: request.op, sessionState: terminal ? 'closing' : this.state, ...waited } }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(request: Request, signal: AbortSignal, deadline: number, entry: JournalEntry | null): Promise<unknown> {
    try {
      // An input is compared against the app as it was just before it: taken now, kept once the input sent something.
      if (OPERATIONS[request.op]?.kind === 'act') {
        const checkpoint = await this.takeCheckpoint(entry?.seq ?? this.journal.last);
        // Reading the app took time: an input whose request ran out of it, or whose session is closing, is not sent.
        aborted(signal);
        if (Date.now() >= deadline) throw new DriverError('TIMEOUT', `${request.op} ran out of time before anything was sent.`, { details: { phase: request.op, dispatched: 'none' } });
        if (this.closeRequested) throw new DriverError('CLOSED', 'The session is closing; nothing was sent.');
        try {
          const result = await this.runOp(request, signal, deadline, entry);
          this.lastInput = checkpoint;
          return result;
        } catch (e) {
          if (e instanceof DriverError && e.details?.dispatched === 'partial') this.lastInput = checkpoint;
          throw e;
        }
      }
      return await this.runOp(request, signal, deadline, entry);
    } catch (e) {
      // A request can quote what it was given (a key chord, a path, a name): nothing the session knows as a credential goes back.
      throw this.scrubError(e);
    }
  }

  private async runOp(request: Request, signal: AbortSignal, deadline: number, entry: JournalEntry | null): Promise<unknown> {
    switch (request.op) {
      case 'session.describe':
        noArgs(request);
        return this.describe();
      case 'window.info':
        noArgs(request);
        return this.windowInfo(this.windowFor(request));
      case 'window.close':
        noArgs(request);
        return this.closeWindow(request);
      case 'menu.list':
        noArgs(request);
        return { items: await inMain(this.app!, menuTreeInMain, undefined) };
      case 'menu.invoke':
        return this.invokeMenu(request);
      case 'desktop.setAnswers':
        return this.setAnswers(request);
      case 'desktop.events':
        return this.desktopEvents(request.args);
      case 'files.stageImport':
        return stageImport(this.appRoot, this.paths!.imports, request.args);
      case 'files.list': {
        const a = request.args ?? {};
        for (const k of Object.keys(a)) if (k !== 'path') throw new DriverError('BAD_REQUEST', `files.list does not take "${k}".`);
        return listSessionFolder(this.areas(), a.path);
      }
      case 'ui.snapshot': {
        const args = parseSnapshotArgs(request.args);
        await this.settled();
        let result: Awaited<ReturnType<typeof uiSnapshot>>;
        try {
          result = await uiSnapshot(this.observer(this.windowFor(request), signal), args, ++this.observations);
        } catch (e) {
          // A capture that failed because the session closed under it (its folder gone) says so.
          if (args.screenshot && this.state !== 'ready') throw new DriverError('CLOSED', 'The session closed while the screenshots were taken.');
          throw e;
        }
        // Nothing is published by a capture that ran out of time, or that finished while the session closed: no id is
        // handed out that evidence.read would not know.
        if (result.screenshots && (result.screenshots.editor || result.screenshots.preview) && this.state !== 'ready') throw new DriverError('CLOSED', 'The session closed while the screenshots were taken.');
        if (!signal.aborted) this.keepEvidence(result.screenshots);
        return result;
      }
      case 'ui.locate': {
        const args = parseLocateArgs(request.args);
        await this.settled();
        return uiLocate(this.observer(this.windowFor(request), signal), args);
      }
      case 'ui.waitFor': {
        const args = parseWaitArgs(request.args);
        await this.settled();
        const env = this.observer(this.windowFor(request), signal);
        // Every look is at the window the wait began on: one replacing it or closing is answered as any request's is.
        const pinned = () => this.windowFor({ expectWindow: env.generation });
        const look = async (search: LocateArgs) => {
          pinned();
          try {
            return await uiLocate(env, search);
          } finally {
            pinned();
          }
        };
        return waitFor(look, args, { deadline, signal });
      }
      case 'evidence.read':
        return this.readEvidence(request.args);
      case 'ui.click':
      case 'ui.hover':
      case 'ui.fill':
      case 'ui.type':
      case 'ui.select':
      case 'ui.press':
      case 'ui.scroll':
      case 'ui.drag': {
        const action = parseAction(request.op, request.args);
        if (entry) {
          entry.targets = this.targetsOf(request.args);
          this.journal.measure(entry);
        }
        // Never past the point where the action could still fail with a reason rather than run out of time.
        await this.settled(Math.max(0, deadline - Date.now() - 2000));
        const page = this.windowFor(request);
        return runAction({ observe: this.observer(page, signal), page, deadline, shots: this.shots }, action);
      }
      case 'wait.for':
        return this.waitFor(request, signal, deadline);
      case 'project.summary':
        return this.projectSummary(request, signal);
      case 'exports.inspect':
        return this.present(await inspectExport(this.areas(), parseInspectArgs(request.args), signal));
      case 'evidence.log': {
        const a = request.args ?? {};
        for (const k of Object.keys(a)) if (k !== 'after' && k !== 'limit') throw new DriverError('BAD_REQUEST', `evidence.log does not take "${k}".`);
        if (a.after !== undefined && (!Number.isInteger(a.after) || (a.after as number) < 0)) throw new DriverError('BAD_REQUEST', '"after" is a cursor: a whole number from 0.');
        if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 200)) throw new DriverError('BAD_REQUEST', '"limit" is a whole number from 1 to 200.');
        // Up to the request reading it: its own entry is not finished yet.
        const read = this.journal.read(a.after as number | undefined, (a.limit as number | undefined) ?? 100, entry?.seq ?? Infinity);
        return this.present({ ...read, entries: this.presentEntries(read.entries) }, true);
      }
      case 'evidence.save': {
        const a = request.args ?? {};
        for (const k of Object.keys(a)) if (k !== 'screenshot') throw new DriverError('BAD_REQUEST', `evidence.save does not take "${k}".`);
        if (a.screenshot !== undefined && typeof a.screenshot !== 'boolean') throw new DriverError('BAD_REQUEST', '"screenshot" is true or false.');
        return this.saveReplay(signal, a.screenshot !== false);
      }
      case 'assistant.script': {
        const script = this.scripted();
        const { steps, mode, scenario } = parseScript(request.args);
        return { ...(scenario ? { scenario } : {}), added: steps.length, ...script.add(steps, mode) };
      }
      case 'assistant.release': {
        const script = this.scripted();
        const a = request.args ?? {};
        for (const k of Object.keys(a)) if (k !== 'gate') throw new DriverError('BAD_REQUEST', `assistant.release does not take "${k}".`);
        if (typeof a.gate !== 'string' || !a.gate) throw new DriverError('BAD_REQUEST', '"gate" names a gate a step was held at.');
        return { ...script.release(a.gate), script: script.state() };
      }
      case 'assistant.observe':
      case 'assistant.wait':
        try {
          if (request.op === 'assistant.observe') return this.scrubbed(await this.observeAssistant(parseObserveArgs(request.args), deadline));
          return this.scrubbed(await this.waitAssistant(parseAssistantWaitArgs(request.args), signal, deadline));
        } catch (e) {
          // A failure can quote what it was given (a run ID) or what it read: nothing known as a credential goes back,
          // whether it is the driver's own failure or one from the app or Playwright.
          if (!this.secrets.size) throw e;
          if (e instanceof DriverError) throw new DriverError(e.code, this.scrubbed(e.message), { retryable: e.retryable, ...(e.details ? { details: this.scrubbed(e.details) } : {}) });
          throw new DriverError('OP_FAILED', this.scrubbed(e instanceof Error ? e.message : String(e)));
        }
      default:
        throw new DriverError('UNKNOWN_OP', `There is no operation "${request.op}".`);
    }
  }

  // -- evidence ------------------------------------------------------------------

  /** Remember the screenshots an observation saved, so `evidence.read` can return them by id. */
  private keepEvidence(shots: Shots | undefined) {
    for (const surface of ['editor', 'preview'] as const) {
      const shot = shots?.[surface];
      if (shot) this.evidence.set(shot.id, { surface, path: shot.path, width: shot.width, height: shot.height, bytes: shot.bytes, sha256: shot.sha256 });
    }
  }

  /**
   * One saved screenshot, by the id its observation gave. Only files this session wrote can be named, and only while
   * they are still where it wrote them, inside its artifacts folder: nothing a client names is opened as a path. As
   * with taking a screenshot, none is returned while any credential is known, or that cannot be told.
   */
  private async readEvidence(args: Record<string, unknown> | undefined): Promise<Evidence> {
    const a = args ?? {};
    for (const key of Object.keys(a)) if (key !== 'id') throw new DriverError('BAD_REQUEST', `evidence.read does not take "${key}".`);
    if (typeof a.id !== 'string' || !a.id) throw new DriverError('BAD_REQUEST', '"id" is an evidence id from a screenshot: screenshots.editor.id or screenshots.preview.id.');
    const found = this.evidence.get(a.id);
    if (!found)
      throw new DriverError('BAD_REQUEST', 'No screenshot of this session has that id: ids come from ui.snapshot\'s screenshots, and last until the session closes.', {
        details: { known: [...this.evidence.keys()].slice(-20) }
      });
    const out: Evidence = { id: a.id, surface: found.surface, mimeType: 'image/png', width: found.width, height: found.height, path: found.path };
    const page = this.bound && !this.bound.closed ? this.bound.page : null;
    // A credential seen here is remembered, frame by frame as each is read, as one an observation sees is: later replies
    // scrub it too, even when another frame could not be read. Saved keys are read whatever the frames do.
    const remember = (values: string[]) => values.forEach((x) => x && this.secrets.add(x));
    // One already known settles it: the frames are still read, briefly and as far as they can be, so a credential shown
    // there now is learned before this reply (and any page error it carries) is scrubbed.
    if (this.secrets.size) {
      if (page) await bounded(frameSecrets(page, { found: remember }).catch((): string[] => []), 1000, []);
      if (this.state !== 'ready') throw new DriverError('CLOSED', 'The session closed while the screenshot was read.');
      return { ...out, withheld: 'A credential is known in this session, and the image could show it.' };
    }
    const clear = async () => {
      const [shown, stored] = await Promise.all([page ? frameSecrets(page, { strict: true, found: remember }) : Promise.resolve([]), this.storedSecrets(true)]);
      return !this.secrets.size && !stored.length && !shown.length;
    };
    const withheld = !(await bounded(clear().catch(() => false), 3000, false));
    // A close that began meanwhile has the last word, whatever the read found.
    const closed = () => new DriverError('CLOSED', 'The session closed while the screenshot was read.');
    if (this.state !== 'ready') throw closed();
    if (withheld) return { ...out, withheld: 'A credential is known in this session, and the image could show it.' };
    let image: Awaited<ReturnType<typeof readSavedImage>>;
    try {
      image = await readSavedImage(this.paths!.artifacts, found.path, a.id, found);
    } catch (e) {
      if (this.state !== 'ready') throw closed();
      throw e;
    }
    if (this.state !== 'ready') throw closed();
    return { ...out, ...image };
  }

  // -- the assistant (#495) ------------------------------------------------------

  private scripted(): Script {
    if (!this.script) throw new DriverError('OP_FAILED', `Only a scripted session has a script; this one's provider is ${this.args.provider ?? 'scripted'}.`, { details: { reason: 'not-scripted' } });
    return this.script;
  }

  /** Nothing the session knows as a credential goes back, wherever the assistant or the page quoted it. */
  private scrubbed<T>(value: T): T {
    if (!this.secrets.size) return value;
    const known = [...this.secrets];
    return scrubAssistant(value, known, scrubber(known));
  }

  /**
   * What `start` does, or a TIMEOUT once `deadline` comes: a read of the app that stalls never outlives the request.
   * Nothing is started with no time left.
   */
  private async within<T>(start: () => Promise<T>, deadline: number, what: string): Promise<T> {
    const late = () => new DriverError('TIMEOUT', `${what} did not finish in time.`, { details: { phase: what, sessionState: this.state } });
    const ms = deadline - Date.now();
    if (ms <= 0) throw late();
    const work = start();
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(late()), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The journal read under way, shared: a stalled app never gets a pile of them. */
  private pulling: Promise<void> | null = null;

  /** The latest deadline of anyone waiting on the journal read under way: past it, it reads no further page. */
  private pullUntil = 0;

  /** Bring the tracker up to date with the app's journal of the assistant's events. */
  private async pull(deadline: number) {
    await this.within(
      () => {
        this.pullUntil = Math.max(this.pullUntil, deadline);
        this.pulling ??= (async () => {
          for (let i = 0; i < 100 && Date.now() < this.pullUntil; i++) {
            const page = (await inMain(this.app!, journalInMain, { op: 'read', after: this.assistant.cursor, limit: 1000 } as JournalCall)) as { records: RawRecord[]; next: number; latest: number; missed: number };
            this.assistant.ingest(page.records, page.missed);
            if (!page.records.length || page.next >= page.latest) return;
          }
        })().finally(() => {
          this.pulling = null;
          this.pullUntil = 0;
        });
        return this.pulling;
      },
      deadline,
      'reading the assistant’s events'
    );
  }

  /** What the chat panel shows now, or null with no editor window to read (or none read before `deadline`). */
  private async shownChat(deadline: number): Promise<ShownChat | null> {
    const b = this.bound;
    if (!b || b.closed || this.appExited) return null;
    return this.within(() => b.page.evaluate(readChat), deadline, 'reading the chat').catch(() => null);
  }

  /** A live session's limits, as the app keeps them, and what is used of them. */
  private async budget(deadline: number) {
    if (!this.live) return undefined;
    const turns = (await this.within(() => inMain(this.app!, journalInMain, { op: 'turns' } as JournalCall), deadline, 'reading the limits').catch(() => null)) as {
      used: number;
      limit: number | null;
      deadline: number | null;
      spent: boolean;
    } | null;
    return { maxTurns: this.live.maxTurns, turnsUsed: turns?.used ?? null, timeoutMs: this.live.timeoutMs, ...(turns?.deadline ? { until: new Date(turns.deadline).toISOString() } : {}), spent: turns?.spent ?? null };
  }

  private async observeAssistant(a: { after?: number; limit?: number; runId?: string; conversationId?: string }, deadline: number) {
    // A little kept back from the request's deadline to reply in: a fifth of a short one, at most 250 ms.
    const end = deadline - Math.min(250, (deadline - Date.now()) / 5);
    await this.pull(end);
    const read = this.assistant.read(a);
    const after = a.after ?? 0;
    // The runs this page is about: those that moved since the cursor, and any still going; within both filters.
    const runs = (a.runId ? [this.assistant.runView(a.runId)].filter((r): r is RunView => !!r) : this.assistant.runViews()).filter(
      (r) => (!a.conversationId || r.conversationId === a.conversationId) && (a.runId || r.lastSeq > after || r.state !== 'terminal')
    );
    const shown = await this.shownChat(end);
    const budget = await this.budget(end);
    return { ...read, runs, shown, ...(this.script ? { script: this.script.state() } : {}), ...(budget ? { budget } : {}) };
  }

  private async waitAssistant(a: { runId: string; after?: number }, signal: AbortSignal, deadline: number) {
    const POLL = 100;
    // Kept back from the request's deadline to say where the run stood: a fifth of a short wait, at most 750 ms.
    const end = deadline - Math.min(750, (deadline - Date.now()) / 5);
    const timedOut = (run: RunView) =>
      new DriverError('TIMEOUT', `Run ${a.runId} neither finished nor asked the author anything in time (it is ${run.state}${run.status ? `, ${run.status}` : ''}).`, {
        details: { phase: 'assistant.wait', sessionState: this.state, runId: a.runId, state: run.state, status: run.status, lastSeq: run.lastSeq, next: this.assistant.cursor, ...(run.gap ? { gap: true } : {}) }
      });
    let run: RunView | null = null;
    let settled: ReturnType<typeof settledState>;
    let shown: ShownChat | null = null;
    for (;;) {
      if (signal.aborted) throw new DriverError('TIMEOUT', 'assistant.wait was stopped.');
      try {
        await this.pull(end);
      } catch (e) {
        // A read cut short by the end of the wait ends it with where the run last stood.
        if (e instanceof DriverError && e.code === 'TIMEOUT' && run) throw timedOut(run);
        throw e;
      }
      run = this.assistant.runView(a.runId);
      if (!run) throw new DriverError('TARGET_NOT_FOUND', `No run "${a.runId}" is known to this session: never seen, or let go after many newer runs.`, { details: { runId: a.runId, hint: 'Take a runId from a run.started entry of assistant.observe.' } });
      settled = settledState(run, a.after);
      // After a gap in the journal, the panel says where the run is: its very question waiting, or its finished card.
      if (!settled && run.gap) {
        shown = await this.shownChat(end);
        const card = shown ? shownTurn(shown, run)?.reply.result : undefined;
        if (shown && run.state === 'input' && (a.after === undefined || run.question!.askedSeq > a.after) && rendered(shown, run, 'input')) settled = { reason: 'input' };
        else if (card) {
          // The journal lost its end; the panel shows it. The run is reported as over, with what its card says.
          settled = { reason: 'terminal' };
          run = { ...run, state: 'terminal', status: card.status || run.status, question: null, result: run.result ?? { status: card.status, summary: card.summary, changes: card.changes ?? [], canUndo: card.buttons.includes('Undo turn') } };
        }
      }
      if (settled) break;
      const left = end - Date.now();
      if (left <= 0) throw timedOut(run);
      // A short wait still looks several times: never longer than a quarter of what is left between looks.
      await new Promise((r) => setTimeout(r, Math.max(5, Math.min(POLL, left / 4))));
    }
    // The journal leads the panel by a moment: when the panel shows the run's conversation, wait (briefly) until it
    // shows the run where it stands, so the author's next action finds it there.
    shown ??= await this.shownChat(end);
    const until = Math.min(end, Date.now() + 5000);
    while (shown?.visible && shown.conversationId === run.conversationId && !rendered(shown, run, settled.reason) && Date.now() + POLL < until && !signal.aborted) {
      await new Promise((r) => setTimeout(r, POLL));
      shown = await this.shownChat(end);
    }
    const turn = shown ? shownTurn(shown, run) : null;
    const budget = await this.budget(end);
    return {
      reason: settled.reason,
      run,
      shown: turn,
      // The card, only when it is this run's and this question: never one the panel has not moved on from yet.
      ...(settled.reason === 'input' && shown && rendered(shown, run, 'input') ? { question: shown.question } : {}),
      next: this.assistant.cursor,
      ...(budget ? { budget } : {})
    };
  }

  private observer(page: Page, signal: AbortSignal): ObserveEnv {
    return {
      page,
      generation: this.bound!.ref.generation,
      registry: this.refs,
      artifacts: this.paths?.artifacts ?? null,
      evidenceTag: this.evidenceTag,
      signal,
      storedSecrets: (strict) => this.storedSecrets(strict),
      remember: (secrets) => {
        for (const x of secrets) if (x) this.secrets.add(x);
      },
      remembered: () => [...this.secrets],
      shots: this.shots
    };
  }

  // -- the record of the run (#497) ------------------------------------------------

  /**
   * Number a request as it comes in, with what it asked for: cut to length (a step whose arguments had to be cut cannot
   * be replayed), typed text and printable keys held back until it is known where they went.
   */
  private admit(request: Request, spec: OpSpec, began: number): JournalEntry {
    let unreplayable: string | undefined;
    let args: Record<string, unknown> | undefined;
    if (request.args) {
      const raw: Record<string, unknown> = { ...request.args };
      if (request.op === 'ui.fill' || request.op === 'ui.type') delete raw.text;
      if (request.op === 'ui.press' && printableKey(raw.key)) delete raw.key;
      // The caller's own folder is not the session's to show.
      if (request.op === 'session.start' && raw.artifactsDir !== undefined) raw.artifactsDir = '<caller folder>';
      const cut = { cut: false };
      args = clipJson(raw, ARG_CLIP, 0, cut) as Record<string, unknown>;
      if (cut.cut) unreplayable = 'its arguments were too long to keep whole';
    }
    if (args && request.op === 'desktop.setAnswers' && Array.isArray(args.answers) && this.paths) {
      // Absolute session paths as session paths, which mean the same in a fresh session.
      const logical = (p: unknown) => (typeof p === 'string' && isAbsolute(p) ? (toSessionPath(this.areas(), p) ?? p) : p);
      args.answers = (args.answers as unknown[]).map((x) => (x && typeof x === 'object' ? { ...(x as Record<string, unknown>), ...('paths' in x && Array.isArray((x as { paths: unknown[] }).paths) ? { paths: (x as { paths: unknown[] }).paths.map(logical) } : {}), ...('path' in x ? { path: logical((x as { path: unknown }).path) } : {}) } : x));
    }
    if (request.op === 'wait.for' && request.args?.within !== undefined) unreplayable ??= 'it searches within a ref of this session';
    const entry = this.journal.admit({
      id: request.id,
      op: request.op,
      class: CLASS_OF[spec.kind],
      t: began - this.created,
      window: this.bound && !this.bound.closed ? this.bound.ref.generation : null,
      ...(args ? { args } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(unreplayable ? { unreplayable } : {})
    });
    if (request.op === 'ui.fill' || request.op === 'ui.type') this.heldText.set(entry, { key: 'text', value: typeof request.args?.text === 'string' ? request.args.text : '' });
    if (request.op === 'ui.press' && printableKey(request.args?.key)) this.heldText.set(entry, { key: 'key', value: String(request.args?.key) });
    return entry;
  }

  private readonly heldText = new WeakMap<JournalEntry, { key: 'text' | 'key'; value: string }>();

  /** Record how a request ended, and what the evidence keeps of it. */
  private record(entry: JournalEntry, request: Request, reply: Reply) {
    const outcome: EntryOutcome = reply.ok ? { ok: true } : { ok: false, code: reply.error.code, message: reply.error.message, ...(typeof reply.error.details?.dispatched === 'string' ? { dispatched: reply.error.details.dispatched } : {}) };
    if (reply.ok) {
      const summary = this.summarize(request, reply.result);
      if (summary) outcome.summary = summary;
    } else if (request.op !== 'evidence.log' && request.op !== 'evidence.save') {
      this.lastFailure = { seq: entry.seq, op: request.op, class: entry.class, ...(clipJson(reply.error) as Record<string, unknown>) };
    }
    // Typed text, and a printable key, are kept only once the action went through and the session does not know them
    // as (part of) a credential: one typed into a credential field was learned as one while it was typed. A printable key
    // is never kept: a credential could be typed one key at a time.
    const held = this.heldText.get(entry);
    if (held) {
      const secret = !!this.secrets.size && scrubber([...this.secrets])(held.value) !== held.value;
      if (held.key === 'text' && reply.ok && !secret && held.value.length <= ARG_CLIP.string) entry.args = { ...entry.args, text: held.value };
      else {
        entry.args = { ...entry.args, [held.key === 'text' ? 'textLeftOut' : 'keyLeftOut']: { length: [...held.value].length } };
        entry.unreplayable ??= held.key === 'text' ? 'its typed text was left out of the record' : 'its printable key was left out of the record';
      }
      this.heldText.delete(entry);
    }
    this.journal.finish(entry, outcome, reply.elapsedMs);
  }

  /** A few facts from a reply for the record; observations also leave the latest one for the evidence. */
  private summarize(request: Request, result: unknown): Record<string, unknown> | undefined {
    const r = result as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!r || typeof r !== 'object') return undefined;
    switch (request.op) {
      case 'ui.snapshot': {
        const snap = r as SnapshotResult;
        this.lastObservation = clipJson({ id: snap.id, context: snap.context, editor: snap.editor, preview: snap.preview }, OBSERVATION_CLIP);
        return { observation: snap.id, screen: snap.context.screen, preview: snap.context.preview.state, dialog: snap.context.dialog?.name ?? null };
      }
      case 'ui.locate': {
        const a = request.args ?? {};
        const ref = r.node?.ref as string | undefined;
        // Remembered while it is the search's one answer: a replay repeats the search rather than guess one from the tree.
        if (ref && typeof a.role === 'string' && a.ref === undefined && a.within === undefined) {
          this.recipes.delete(ref);
          this.recipes.set(ref, { scope: r.scope, role: a.role, ...(typeof a.name === 'string' ? { name: a.name } : {}), ...(a.exact === false ? { exact: false } : {}), ...(typeof a.region === 'string' ? { region: a.region } : {}) });
          if (this.recipes.size > 2000) this.recipes.delete(this.recipes.keys().next().value as string);
        }
        return { ref, role: r.node?.role, name: r.node?.name };
      }
      case 'wait.for':
        return { condition: r.condition, met: true, ...(r.outcome ? { outcome: r.outcome } : {}), ...(typeof r.revision === 'number' ? { revision: r.revision } : {}), ...(typeof r.count === 'number' ? { count: r.count } : {}) };
      case 'project.summary':
        return { revision: r.revision, ...(r.project?.find ? { found: r.project.find.matches.length, complete: r.project.find.complete } : {}) };
      case 'exports.inspect':
        return { type: r.type, ...(typeof r.files === 'number' ? { files: r.files } : {}), ...(r.find ? { found: r.find.matches.length, complete: r.find.complete } : typeof r.complete === 'boolean' ? { complete: r.complete } : {}) };
      case 'evidence.save':
        return { file: 'replay.json' };
      default:
        if (OPERATIONS[request.op]?.kind === 'act') return { ...(r.dispatched ? { dispatched: r.dispatched } : {}), ...(r.target ? { target: { surface: r.target.surface, role: r.target.role, name: r.target.name, tag: r.target.tag } } : {}), ...(r.status ? { status: r.status } : {}) };
        return undefined;
    }
  }

  /** How a replay finds each target of an input again: the search that found its ref, else what was seen of it. */
  private targetsOf(args: Record<string, unknown> | undefined): TargetDescriptor[] {
    const out: TargetDescriptor[] = [];
    for (const at of ['target', 'from', 'to'] as const) {
      const t = args?.[at] as Record<string, unknown> | undefined;
      if (!t || typeof t !== 'object') continue;
      const position = t.position && typeof t.position === 'object' ? (t.position as { x: number; y: number }) : undefined;
      if (typeof t.ref !== 'string') {
        out.push({ at, replayable: false, reason: 'a screenshot point names pixels of this run' });
        continue;
      }
      const recipe = this.recipes.get(t.ref);
      const b = this.refs.get(t.ref);
      if (recipe) out.push({ at, ...recipe, ...(position ? { position } : {}), replayable: true });
      else if (b) {
        const region = b.regions?.length ? b.regions[b.regions.length - 1] : undefined;
        out.push({ at, scope: b.scope, role: b.role, ...(b.name ? { name: b.name } : {}), ...(region ? { region } : {}), ...(position ? { position } : {}), replayable: true });
      } else out.push({ at, replayable: false, reason: 'a ref this session does not know' });
    }
    return out;
  }

  /** The app as it is now, for conditions that ask what an input changed: bounded, and marked unknown when unread. */
  private async takeCheckpoint(seq: number): Promise<Checkpoint> {
    const b = this.bound && !this.bound.closed && !this.appExited ? this.bound : null;
    const probe = b ? await bounded(probeApp(b.page).catch(() => null), 2000, null) : null;
    return {
      seq,
      // With no window there is nothing to read, and nothing is unknown: no project is open.
      known: !b || (!!probe && !probe.unreadable),
      generation: b?.ref.generation ?? null,
      opening: probe?.opening ?? null,
      revision: probe?.revision ?? null,
      newestExport: probe?.exports.newest ?? null,
      exportReport: probe?.exportView?.kept ?? null,
      pageErrors: this.pageErrorCount
    };
  }

  /** The page errors since the `since`-th, as far as they are kept. */
  private pageErrorsSince(since: number): string[] {
    const n = Math.max(0, Math.min(this.pageErrorCount - since, this.pageErrors.length));
    return n ? this.pageErrors.slice(-n) : [];
  }

  /** The latest page errors for evidence: each scrubbed whole before it is cut, so no part of a credential is left. */
  private latestErrors(list: string[], n = 5): string[] {
    const secrets = [...this.secrets];
    return list.slice(-n).map((m) => {
      const clean = scrubText(m, secrets);
      return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
    });
  }

  private hider(): (s: string) => string {
    this.hide ??= pathHider([
      ...(this.paths ? [{ path: this.paths.root, label: '<session>' }, ...(this.artifactsOutside ? [{ path: this.paths.artifacts, label: '<artifacts>' }] : [])] : []),
      { path: this.appRoot, label: '<repo>' },
      ...machineRoots()
    ]);
    return this.hide;
  }

  /**
   * What leaves the session from its record and evidence: scrubbed of every credential it knows, host paths hidden.
   * `all`: every string and key is scrubbed, whatever its key (for what callers sent: the record and a wait's evidence).
   */
  private present<T>(v: T, all = false, keys = false): T {
    const secrets = [...this.secrets];
    const scrubbed = secrets.length ? (all ? scrubAll(v, secrets, keys) : scrubDeep(v, secrets)) : v;
    return hideDeep(scrubbed, this.hider());
  }

  /** A failure as it goes back: scrubbed of every credential the session knows, wherever the request quoted one. */
  private scrubError(e: unknown): unknown {
    if (!(e instanceof DriverError) || !this.secrets.size) return e;
    const secrets = [...this.secrets];
    // The protocol's own words in the details (a role, a reason, a ref) are kept as they are.
    return new DriverError(e.code, scrubText(e.message, secrets), { retryable: e.retryable, ...(e.details ? { details: scrubDeep(e.details, secrets) } : {}) });
  }

  /** A probe as a client sees it: the project folder and export paths as session paths. */
  private publicProbe(p: AppProbe) {
    const areas = this.areas();
    const at = (abs: string | null) => (abs ? (toSessionPath(areas, abs) ?? abs) : null);
    const brief = (e: ExportBrief | null) => (e ? { ...e, path: at(e.path) } : null);
    const { dir, exports, ...rest } = p;
    return { ...rest, project: at(dir), exports: { count: exports.count, newest: brief(exports.newest) } };
  }

  /**
   * Run a look with its own stop, for at most `ms`: one that takes longer is told to stop and is waited for before the
   * next request observes (it could still replace what the page's last snapshot holds). Null when it did not finish.
   */
  private async boundedLook<T>(look: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal, keep?: (e: unknown) => boolean, tracked = true): Promise<T | null> {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    if (parent.aborted) return null;
    parent.addEventListener('abort', stop, { once: true });
    const work = look(ctl.signal).then(
      (v) => ({ v }),
      (e: unknown) => ({ e })
    );
    try {
      const done = await bounded(work, Math.max(0, ms), null);
      // A failure the caller must hear of (a window gone) is passed on; any other is a look that found nothing.
      if (done && 'e' in done) {
        if (keep?.(done.e)) throw done.e;
        return null;
      }
      if (done) return done.v;
      ctl.abort();
      // Only a look that can still change what refs resolve against (an observation) holds the next request back.
      if (tracked) {
        const settling: Promise<unknown> = work.finally(() => this.lingering.delete(settling));
        this.lingering.add(settling);
      }
      return null;
    } finally {
      parent.removeEventListener('abort', stop);
    }
  }

  // -- waits -----------------------------------------------------------------------

  private async waitFor(request: Request, signal: AbortSignal, deadline: number) {
    const c = parseCondition(request.args);
    const began = Date.now();
    const base = this.lastInput;
    const since = c.condition === 'outcome.terminal' && c.since === 'start' ? 0 : (base?.pageErrors ?? 0);
    const progress = { condition: c, samples: 0, pending: 'nothing has been looked at yet', last: null as unknown, since };
    this.waiting = progress;
    // What a wait still needs once it stops looking: a last look, an observation and the errors, before its deadline.
    const reserve = Math.min(3000, Math.max(500, Math.floor(((deadline - began) * 2) / 5)));
    const met = (verdict: Verdict) => this.present({ condition: c.condition, met: true, waitedMs: Date.now() - began, samples: progress.samples, ...verdict.value });
    const look = async (sig: AbortSignal): Promise<{ verdict: Verdict; last: unknown }> => {
      try {
        return await this.sample(c, request, sig, base, since);
      } catch (e) {
        // A look the app's changes cut short (a project opening, a page navigating) is looked at again; one that can
        // never succeed (the window or the app gone, a bad argument) ends the wait.
        aborted(sig);
        if (e instanceof DriverError && (!e.retryable || WAIT_FATAL.has(e.code))) throw e;
        const info = errorInfo(e);
        // Scrubbed whole before it is cut, so no part of a credential it quotes is left.
        const said = scrubText(info.message, [...this.secrets]);
        return { verdict: { met: false, pending: `the last look was cut short (${said.split('\n')[0].slice(0, 200)})` }, last: { error: { code: info.code, message: said.slice(0, 300) } } };
      }
    };
    try {
      await this.settled(Math.max(0, deadline - Date.now() - reserve));
      for (;;) {
        aborted(signal);
        if (this.closeRequested) throw new DriverError('CLOSED', 'The session closed while it waited.');
        const { verdict, last } = await look(signal);
        progress.samples++;
        progress.last = last;
        if (verdict.met) return met(verdict);
        progress.pending = verdict.pending ?? 'not yet';
        if (Date.now() + POLL_MS >= deadline - reserve) break;
        await pause(POLL_MS, signal);
      }
      // The evidence first, then one last look with what time is left: what held by the very end still counts.
      const details = await this.waitEvidence(progress, request, signal, deadline - Math.min(400, Math.floor(reserve / 3)), since, began);
      const fatal = (e: unknown) => e instanceof DriverError && (!e.retryable || WAIT_FATAL.has(e.code));
      // An observation is not taken over one still stopping; a probe of the app's state never holds anything back.
      const observes = c.condition.startsWith('ui.') || c.condition === 'preview.ready';
      const left = () => deadline - Date.now() - 100;
      if (observes && this.lingering.size && left() > 0) await this.settled(left()).catch(() => undefined);
      const final = left() > 0 && !(observes && this.lingering.size) ? await this.boundedLook(look, left(), signal, fatal, observes) : null;
      if (final) {
        progress.samples++;
        // Met in time, by a session still open: it counts.
        if (final.verdict.met && Date.now() < deadline && !this.closeRequested) return met(final.verdict);
        if (!final.verdict.met) Object.assign(details, this.present({ pending: final.verdict.pending ?? details.pending, last: final.last }, true));
        details.samples = progress.samples;
      }
      details.waitedMs = Date.now() - began;
      throw new DriverError('TIMEOUT', `${c.condition} did not hold within ${Math.round((deadline - began) / 100) / 10}s: ${String(details.pending)}.`, { retryable: true, details });
    } finally {
      if (this.waiting === progress) this.waiting = null;
    }
  }

  /** What a deadline that cut a wait short reports, from what the wait had seen: nothing here waits for the app. */
  private cutShort(w: NonNullable<typeof this.waiting>) {
    return this.present(
      {
        condition: w.condition,
        pending: w.pending,
        samples: w.samples,
        last: w.last,
        observation: this.lastObservation ? { earlier: true, ...(this.lastObservation as object) } : null,
        errors: { page: this.latestErrors(this.pageErrorsSince(w.since)), pageTotal: this.pageErrorCount - w.since, log: this.appLog.troubles(8) }
      },
      true
    );
  }

  /** One look at what a condition needs, judged. A window that closed or an app that ended fails the wait at once. */
  private async sample(c: Condition, request: Request, signal: AbortSignal, base: Checkpoint | null, since: number): Promise<{ verdict: Verdict; last: unknown }> {
    switch (c.condition) {
      case 'ui.present':
      case 'ui.absent': {
        const page = this.windowFor(request);
        const { condition: _, ...args } = c;
        let s: LocateSample;
        try {
          s = { ok: true, located: await uiLocate(this.observer(page, signal), args) };
        } catch (e) {
          // A ref to search within that went stale can never be searched again: the wait cannot be met.
          if (e instanceof DriverError && (e.code === 'STALE_REF' || e.code === 'BAD_REQUEST')) throw e;
          aborted(signal);
          s = { ok: false, error: errorInfo(e) };
        }
        const last = s.ok ? { found: { ref: s.located.node.ref, role: s.located.node.role, name: s.located.node.name, region: s.located.region } } : { search: { code: s.error.code, message: s.error.message, ...(s.error.details?.preview ? { preview: s.error.details.preview } : {}), ...(s.error.details?.count ? { count: s.error.details.count } : {}) } };
        // A search within a ref covers that ref's own scope; any other, the scopes it names.
        const within = c.within ? this.refs.get(c.within)?.scope : undefined;
        return { verdict: judgeLocate(c, s, within ? within === 'preview' : c.scope !== 'editor'), last };
      }
      case 'ui.context':
      case 'preview.ready': {
        const page = this.windowFor(request);
        const snap = await uiSnapshot(this.observer(page, signal), { scope: 'editor', maxNodes: 1, depth: 0 }, ++this.observations);
        if (!signal.aborted) this.lastObservation = { id: snap.id, context: snap.context };
        return { verdict: judgeContext(c, snap.context), last: { context: snap.context } };
      }
      case 'save.settled':
      case 'project.revision':
      case 'export.finished': {
        const page = this.windowFor(request);
        const probe = await probeApp(page);
        const verdict = judgeApp(c, probe, base);
        // What met it names files as session paths, as everything else a client gets does.
        const exported = verdict.value?.export as ExportBrief | undefined;
        if (exported) verdict.value = { ...verdict.value, export: { ...exported, path: toSessionPath(this.areas(), exported.path) ?? exported.path } };
        return { verdict, last: { app: this.publicProbe(probe) } };
      }
      case 'outcome.terminal': {
        const alive = this.bound && !this.bound.closed && !this.appExited ? this.bound.page : null;
        const probe = alive ? await bounded(probeApp(alive).catch(() => null), 2000, null) : null;
        const state = { appExited: this.appExited, windowClosed: !this.appExited && (!this.bound || this.bound.closed), pageErrors: this.latestErrors(this.pageErrorsSince(since), 20), runtime: probe?.runtime ?? null };
        return { verdict: judgeTerminal(state), last: { appExited: state.appExited, windowClosed: state.windowClosed, pageErrors: state.pageErrors.length, runtime: state.runtime } };
      }
    }
  }

  /** What a wait that ran out of time reports: the condition, the last sample, an observation now, and the errors. */
  private async waitEvidence(progress: { condition: Condition; samples: number; pending: string; last: unknown }, request: Request, signal: AbortSignal, deadline: number, since: number, began: number) {
    const left = () => Math.max(0, deadline - Date.now() - 200);
    const page = this.bound && !this.bound.closed && !this.appExited ? this.bound.page : null;
    let observation: unknown = null;
    let probe: AppProbe | null = null;
    if (page) {
      const snap = await this.boundedLook((sig) => this.observeForEvidence(page, sig, 40, false), Math.floor(left() * 0.8), signal);
      // One that cannot be taken in time leaves the latest one there is, saying it is older.
      observation = snap ?? (this.lastObservation ? { earlier: true, ...(this.lastObservation as object) } : null);
      probe = await bounded(probeApp(page).catch(() => null), left(), null);
    }
    const errors = {
      page: this.latestErrors(this.pageErrorsSince(since)),
      pageTotal: this.pageErrorCount - since,
      ...(probe?.runtime && (probe.runtime.state === 'error' || probe.runtime.state === 'unavailable') ? { runtime: probe.runtime } : {}),
      log: this.appLog.troubles(8)
    };
    return this.present(
      {
        phase: 'wait.for',
        sessionState: this.state,
        condition: progress.condition,
        pending: progress.pending,
        samples: progress.samples,
        waitedMs: Date.now() - began,
        last: progress.last,
        observation,
        ...(probe ? { app: this.publicProbe(probe) } : {}),
        errors,
        ...(request.expectWindow !== undefined ? { expectWindow: request.expectWindow } : {})
      },
      true
    );
  }

  /** A bounded observation for evidence (context and the first nodes), kept as the latest one; null if it fails. */
  private async observeForEvidence(page: Page, signal: AbortSignal, maxNodes: number, screenshot: boolean): Promise<SnapshotResult | null> {
    const snap = await uiSnapshot(this.observer(page, signal), { maxNodes, screenshot }, ++this.observations).catch(() => null);
    if (!snap || signal.aborted) return null;
    this.lastObservation = clipJson({ id: snap.id, context: snap.context, editor: snap.editor, preview: snap.preview }, OBSERVATION_CLIP);
    return snap;
  }

  // -- independent checks ----------------------------------------------------------

  private async projectSummary(request: Request, signal: AbortSignal) {
    const a = request.args ?? {};
    for (const k of Object.keys(a)) if (k !== 'find') throw new DriverError('BAD_REQUEST', `project.summary does not take "${k.slice(0, 100)}".`);
    if (a.find !== undefined && (typeof a.find !== 'string' || !a.find || a.find.length > 1000)) throw new DriverError('BAD_REQUEST', '"find" is the text to look for in the documents (at most 1000 characters).');
    const page = this.windowFor(request);
    const probe = await probeApp(page);
    const app = this.publicProbe(probe);
    if (!probe.dir) return this.present({ ...app, project: null });
    // Only a project inside the session's own folders is read.
    const dir = await realpath(probe.dir).catch(() => null);
    const at = dir ? toSessionPath(this.areas(), dir) : null;
    if (!dir || !at) throw new DriverError('OP_FAILED', 'The open project is not in the session\'s folders, so it is not read.', { details: { reason: 'outside' } });
    const docs = await readProjectDocs(dir, { ...(a.find !== undefined ? { find: a.find as string } : {}), signal });
    return this.present({ ...app, project: { path: at, ...docs } });
  }

  // -- evidence ----------------------------------------------------------------------

  /** The replay record from what the session holds now, with the observation and screenshots given. */
  private recordFrom(observation: unknown, screenshots: ReplayRecord['evidence']['screenshots'], artifacts: string[]): ReplayRecord {
    const b = this.build;
    const record: ReplayRecord = {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      savedAt: now(),
      build: b ? { fingerprint: b.fingerprint, files: b.files, builtAt: b.builtAt, packageVersion: b.packageVersion, git: b.git } : null,
      platform: { os: process.platform, arch: process.arch, electron: this.appIdentity?.electron ?? null, chrome: this.appIdentity?.chrome ?? null },
      scenario: { fixture: this.args.fixture ?? 'welcome', provider: this.args.provider ?? 'scripted' },
      steps: this.presentEntries(this.journal.entries()),
      dropped: this.journal.dropped,
      complete: this.journal.dropped === 0,
      evidence: {
        observation,
        ...(screenshots ? { screenshots } : {}),
        failure: this.lastFailure,
        pageErrors: { total: this.pageErrorCount, latest: this.latestErrors(this.pageErrors) },
        log: this.appLog.troubles(8)
      },
      // A file still being written (a new copy about to replace app.log) is not among them.
      artifacts: [...new Set([...artifacts.filter((n) => n !== OWNER_MARK && !/\.[0-9a-f]{12}\.tmp$/.test(n)).sort().slice(0, 200), 'replay.json'])].sort()
    };
    return this.present(record, true);
  }

  /** Build the replay record now: with a fresh observation while the window is there, else the latest one. */
  private async replayRecord(signal: AbortSignal, screenshot: boolean): Promise<ReplayRecord> {
    let observation: unknown = this.lastObservation;
    let screenshots: ReplayRecord['evidence']['screenshots'];
    const page = this.bound && !this.bound.closed && !this.appExited && this.paths ? this.bound.page : null;
    if (page) {
      const snap = await this.boundedLook((sig) => this.observeForEvidence(page, sig, 80, screenshot), RECORD_OBSERVATION_MS, signal);
      if (snap) {
        observation = this.lastObservation;
        const shot = snap.screenshots;
        const rel = (p: string | undefined) => (p && this.paths ? relative(this.paths.artifacts, p).split('\\').join('/') : undefined);
        if (shot) screenshots = { ...(shot.editor ? { editor: rel(shot.editor.path) } : {}), ...(shot.preview ? { preview: rel(shot.preview.path) } : {}), ...(shot.withheld ? { withheld: shot.withheld } : {}) };
      }
    }
    const artifacts = this.paths ? (await readdir(this.paths.artifacts, { recursive: true }).catch(() => [] as string[])).slice(0, 1000).map((n) => String(n).split('\\').join('/')) : [];
    return this.recordFrom(observation, screenshots, artifacts);
  }

  /** Write replay.json into the artifacts, and return where and what: one save at a time, the last one written last. */
  private saveReplay(signal: AbortSignal, screenshot: boolean): Promise<{ file: string; record: ReplayRecord }> {
    const paths = this.paths;
    if (!paths) return Promise.reject(new DriverError('NOT_STARTED', 'The session has no artifacts folder yet: start it first.'));
    const before = this.saving;
    const run = (async () => {
      await before?.catch(() => undefined);
      const record = await this.replayRecord(signal, screenshot);
      const file = join(paths.artifacts, 'replay.json');
      // A request that ran out of time publishes nothing after its reply.
      // Once closing has written the last record, no earlier save replaces it.
      await writeWhole(file, JSON.stringify(record, null, 2), () => {
        aborted(signal);
        if (this.recordSealed) throw new DriverError('CLOSED', 'The session closed; its record is written.');
      });
      return { file, record };
    })();
    this.saving = run.catch(() => undefined);
    return run;
  }

  /**
   * Journal entries as they leave the session, scrubbed and with host paths hidden; one whose arguments that changed
   * cannot be replayed as recorded, and says so.
   */
  private presentEntries(entries: JournalEntry[]): JournalEntry[] {
    return entries.map((e) => {
      // The entry's own fields keep their keys; what the caller sent is scrubbed in its keys too.
      const { args, targets, ...own } = e;
      const shown: JournalEntry = { ...this.present(own, true), ...(args ? { args: this.present(args, true, true) } : {}), ...(targets ? { targets: this.present(targets, true, true) } : {}) };
      if (shown.unreplayable || JSON.stringify([e.args ?? null, e.targets ?? null]) === JSON.stringify([shown.args ?? null, shown.targets ?? null])) return shown;
      return { ...shown, unreplayable: 'its arguments held a credential or a host path, which the record leaves out' };
    });
  }

  /** The app's output as it is kept: bounded, scrubbed of every credential the session knows, host paths hidden. */
  private logText(): string {
    const secrets = [...this.secrets];
    const hide = this.hider();
    return this.appLog.text((part) => hide(scrubText(part, secrets)));
  }

  /** Write app.log as it is now, when there is new output: a host that is killed still leaves what came before. */
  private flushLog(): Promise<unknown> {
    if (!this.paths || this.appLog.written === this.logFlushed || this.flushing) return this.flushing ?? Promise.resolve();
    this.logFlushed = this.appLog.written;
    const file = join(this.paths.artifacts, 'app.log');
    this.flushing = writeWhole(file, this.logText())
      .catch(() => undefined)
      .finally(() => (this.flushing = null));
    return this.flushing;
  }

  /**
   * The element a ref from `ui.snapshot` or `ui.locate` names, for acting on it in-process (issue #493 builds its
   * actions on this): checked as `ui.locate` checks a ref, and bound to the document it was seen in, so it can never
   * reach an element of a page that has since replaced it. The caller disposes of the handle.
   */
  async elementFor(ref: string, request: Pick<Request, 'expectWindow'> = {}): Promise<ElementHandle> {
    if (this.state !== 'ready') throw new DriverError('NOT_STARTED', 'Start the session first (session.start).');
    await this.settled();
    const page = this.windowFor(request);
    return elementFor(this.observer(page, new AbortController().signal), ref);
  }

  /** Wait (a bounded time) for operations that ran out of time to stop before observing again; BUSY if they will not. */
  private async settled(maxMs = 10_000) {
    if (!this.lingering.size) return;
    const done = await bounded(Promise.all([...this.lingering]).then(() => true), Math.min(10_000, maxMs), false);
    if (!done) throw new DriverError('BUSY', 'An earlier request that ran out of time is still stopping; try again shortly.', { retryable: true });
  }

  /**
   * The provider keys the app saved in the profile this session made (the app is started with it as its user data;
   * a profile the app reports elsewhere fails isolation and is never read).
   */
  private async storedSecrets(strict = false): Promise<string[]> {
    const dir = this.paths?.profile;
    if (!dir) return [];
    const keys = await readFile(join(dir, 'api-keys.json'), 'utf8').then(
      (t) => JSON.parse(t) as Record<string, unknown>,
      (e: NodeJS.ErrnoException) => {
        // No file is no keys; a file that cannot be read is, strictly, keys unknown.
        if (strict && e.code !== 'ENOENT') throw e;
        return {};
      }
    );
    const found = Object.values(keys).filter((v): v is string => typeof v === 'string' && !!v);
    for (const x of found) this.secrets.add(x);
    return found;
  }

  /** The reply's context: with a page error waiting, once the saved keys it could quote are known (bounded). */
  private async replyContext(began: number): Promise<ReplyContext> {
    if (this.events.some((e) => e.type === 'page.error')) await bounded(this.storedSecrets().catch(() => undefined), 2000, undefined);
    return this.context(began);
  }

  private context(began: number): ReplyContext {
    // A page's own error can quote what was on it, a credential included: scrubbed whole, then cut to length.
    const scrubbed = this.secrets.size ? scrubDeep(this.events, [...this.secrets]) : this.events;
    const events = scrubbed.map((e) => (e.type === 'page.error' ? { ...e, message: e.message.slice(0, 2000) } : e));
    this.events = [];
    if (this.droppedEvents) {
      events.unshift({ type: 'events.dropped', at: now(), count: this.droppedEvents });
      this.droppedEvents = 0;
    }
    return { sessionId: this.id, window: this.bound && !this.bound.closed ? this.bound.ref : null, elapsedMs: Date.now() - began, events };
  }

  private event(e: SessionEvent) {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
      this.droppedEvents++;
    }
  }

  // -- the window ----------------------------------------------------------------

  /** The page a window request runs against, or the reason it may not. */
  windowFor(request: Pick<Request, 'expectWindow'> = {}): Page {
    if (this.appExited) throw new DriverError('APP_EXITED', 'The app is no longer running.');
    const b = this.bound;
    if (!b) throw new DriverError('WINDOW_CLOSED', 'The app has no editor window.', { retryable: true });
    if (b.closed) throw new DriverError('WINDOW_CLOSED', `Editor window ${b.ref.generation} closed and no other has replaced it.`, { retryable: true, details: { generation: b.ref.generation } });
    if (request.expectWindow !== undefined && request.expectWindow !== b.ref.generation)
      throw new DriverError('WINDOW_REPLACED', `The editor window is generation ${b.ref.generation}, not ${request.expectWindow}.`, { details: { from: request.expectWindow, to: b.ref.generation, nativeId: b.ref.nativeId } });
    if (b.ref.generation !== this.acknowledged) {
      if (request.expectWindow !== b.ref.generation)
        throw new DriverError('WINDOW_REPLACED', `Editor window ${this.acknowledged} was replaced by window ${b.ref.generation}; send expectWindow: ${b.ref.generation} to use it.`, {
          details: { from: this.acknowledged, to: b.ref.generation, nativeId: b.ref.nativeId }
        });
      this.acknowledged = b.ref.generation;
    }
    return b.page;
  }

  // -- the desktop around the editor (#494) ------------------------------------

  /** The session folders a chooser answer may name. */
  private areas(): Record<Area, string> {
    const p = this.paths!;
    return { imports: p.imports, exports: p.exports, workspace: p.workspace };
  }

  private async closeWindow(request: Request) {
    const extra = Object.keys(request.args ?? {});
    if (extra.length) throw new DriverError('BAD_REQUEST', `window.close does not take "${extra[0]}".`);
    this.windowFor(request);
    const ref = this.bound!.ref;
    const closed = await this.app!.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.fromId(id);
      if (!w || w.isDestroyed()) return false;
      w.close();
      return true;
    }, ref.nativeId);
    if (!closed) throw new DriverError('WINDOW_CLOSED', `Editor window ${ref.generation} is already gone.`, { retryable: true });
    return { generation: ref.generation, nativeId: ref.nativeId, status: 'requested' as const };
  }

  /**
   * Choose a menu item for the bound editor window. With none open (macOS keeps running without one) and no window
   * named, the item is chosen for none, as the menu bar does then; the app brings a window up for what needs one.
   */
  private async invokeMenu(request: Request) {
    const a = request.args ?? {};
    for (const k of Object.keys(a)) if (k !== 'path') throw new DriverError('BAD_REQUEST', `menu.invoke does not take "${k}".`);
    if (!Array.isArray(a.path) || !a.path.length || !a.path.every((l) => typeof l === 'string' && l)) throw new DriverError('BAD_REQUEST', '"path" is the item\'s labels from the menu bar down, such as ["File", "Open Project…"].');
    let window: number | null = null;
    if (this.appExited) throw new DriverError('APP_EXITED', 'The app is no longer running.');
    if ((this.bound && !this.bound.closed) || request.expectWindow !== undefined) window = (this.windowFor(request), this.bound!.ref.nativeId);
    const [done] = await inMain(this.app!, invokeMenuInMain, { paths: [a.path as string[]], window, request: request.id });
    return { ...done, status: 'dispatched' as const };
  }

  private async setAnswers(request: Request) {
    const a = request.args ?? {};
    for (const k of Object.keys(a)) if (k !== 'answers') throw new DriverError('BAD_REQUEST', `desktop.setAnswers does not take "${k}".`);
    if (!Array.isArray(a.answers)) throw new DriverError('BAD_REQUEST', '"answers" is a list ([] clears them).');
    const answers = await Promise.all(a.answers.map((x) => resolveAnswer(this.areas(), x)));
    const set = (await inMain(this.app!, desktopInMain, { op: 'setAnswers', answers, request: request.id })) as { ids: string[] } | { error: string };
    // A malformed answer changes nothing: the app says which one and why.
    if ('error' in set) throw new DriverError('BAD_REQUEST', set.error);
    return { answers: set.ids };
  }

  private async desktopEvents(args: Record<string, unknown> | undefined) {
    const a = args ?? {};
    for (const k of Object.keys(a)) if (k !== 'after' && k !== 'limit') throw new DriverError('BAD_REQUEST', `desktop.events does not take "${k}".`);
    if (a.after !== undefined && (!Number.isInteger(a.after) || (a.after as number) < 0)) throw new DriverError('BAD_REQUEST', '"after" is a cursor: a whole number from 0.');
    if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 1000)) throw new DriverError('BAD_REQUEST', '"limit" is a whole number from 1 to 1000.');
    return inMain(this.app!, desktopInMain, { op: 'events', after: a.after as number | undefined, limit: a.limit as number | undefined });
  }

  private async windowInfo(page: Page) {
    const ref = this.bound!.ref;
    const handle = await this.app!.browserWindow(page);
    const native = (await handle.evaluate((w: any) => ({ id: w.id, visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds(), title: w.getTitle() }))) as {
      id: number;
      visible: boolean;
      focused: boolean;
      bounds: { x: number; y: number; width: number; height: number };
      title: string;
    };
    return { generation: ref.generation, nativeId: native.id, url: page.url(), title: native.title, visible: native.visible, focused: native.focused, bounds: native.bounds, viewport: page.viewportSize(), pageErrors: this.pageErrors.length };
  }

  /** Bind `page` if it is an editor window: the first one, or one that appears after (replaces) the bound one. */
  private async consider(page: Page) {
    const url = await settledUrl(page, 30_000);
    if (!url || !isEditorUrl(url) || page.isClosed() || !this.app || this.bound?.page === page) return;
    const nativeId = await this.app
      .browserWindow(page)
      .then((h) => h.evaluate((w: any) => w.id as number))
      .catch(() => null);
    if (nativeId === null || page.isClosed() || this.bound?.page === page) return;
    if (this.options.viewport !== null) await page.setViewportSize(this.options.viewport ?? { width: 1440, height: 900 }).catch(() => undefined);
    if (page.isClosed() || this.bound?.page === page) return;
    const previous = this.bound;
    const ref: WindowRef = { generation: ++this.generations, nativeId };
    const bound: Bound = { page, ref, closed: false };
    this.bound = bound;
    page.on('pageerror', (e) => {
      const message = String(e);
      this.pageErrors.push(message.length > PAGE_ERROR_CHARS ? `${message.slice(0, PAGE_ERROR_CHARS)}…` : message);
      this.pageErrorCount++;
      if (this.pageErrors.length > MAX_PAGE_ERRORS) this.pageErrors.shift();
      // Kept long: the reply that carries it is scrubbed of credentials first, then cuts it to a shorter length.
      this.event({ type: 'page.error', at: now(), generation: ref.generation, message: this.pageErrors[this.pageErrors.length - 1] });
    });
    page.on('close', () => {
      bound.closed = true;
      if (this.bound === bound) this.event({ type: 'window.closed', at: now(), generation: ref.generation });
    });
    if (previous) this.event({ type: 'window.replaced', at: now(), from: previous.ref.generation, to: ref.generation });
    else this.acknowledged = ref.generation;
  }

  // -- starting ------------------------------------------------------------------

  /**
   * Start the app. Every phase shares one deadline; a start that fails or runs out of time ends the session (its
   * processes killed, its data removed, artifacts kept on failure unless told otherwise) and throws.
   */
  async start(args: StartArgs = {}, { timeoutMs = DEFAULT_STARTUP_MS }: { timeoutMs?: number } = {}): Promise<Description> {
    if (this.state !== 'new') throw new DriverError(this.state === 'closing' || this.state === 'closed' ? 'CLOSED' : 'ALREADY_STARTED', 'This session was already started; each session starts once.');
    const parsed = parseStartArgs(args as Record<string, unknown>, this.options.contained);
    // Refused before anything is made: a live session needs the host's own say-so and key.
    this.live = parsed.live ? liveSetup(parsed.live, process.env) : null;
    if (this.live?.key) this.secrets.add(this.live.key);
    this.args = parsed;
    this.state = 'starting';
    let phase: StartPhase = 'build';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + timeoutMs;
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DriverError('TIMEOUT', `The session did not start within ${timeoutMs / 1000}s (it was at ${phase}).`)), timeoutMs);
      this.abortStart = reject;
    });
    stopped.catch(() => undefined);
    const steps = this.startSteps(deadline, (p) => (phase = p), stopped);
    this.starting = steps.catch(() => undefined);
    // The description is part of starting: the deadline covers it too.
    const ready = steps.then(() => {
      this.state = 'ready';
      this.reachedReady = true;
      return this.describe();
    });
    try {
      return await Promise.race([ready, stopped]);
    } catch (e) {
      // Closed by its owner while starting is not a failure, and that close is already removing the run's folders.
      const interrupted = this.closeRequested;
      if (!interrupted) this.failed = true;
      const err =
        e instanceof DriverError
          ? e
          : new DriverError('LAUNCH_FAILED', `The app did not start (at ${phase}): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, { details: { phase } });
      // Bounded: the app is still running until the close below, and Playwright's own deadline is not far off.
      if (!interrupted && this.args.keepArtifacts !== 'never') await bounded(this.writeEvidence(err).catch(() => undefined), 3000, undefined);
      const closed = await this.close({ failed: !interrupted }).catch((c: unknown) => c);
      // A failure that names its own phase knows better than the last phase reached.
      const details: Record<string, unknown> = { ...err.details, phase: err.details?.phase ?? phase, sessionState: 'closed' };
      if (closed && typeof closed === 'object' && 'processes' in closed) Object.assign(details, { artifacts: (closed as CloseResult).artifacts, processes: (closed as CloseResult).processes });
      else details.cleanup = closed instanceof DriverError ? { code: closed.code, message: closed.message, ...closed.details } : String(closed);
      throw new DriverError(err.code, err.message, { retryable: err.retryable, details });
    } finally {
      clearTimeout(timer);
      this.abortStart = null;
    }
  }

  /**
   * The start itself. Each step either finishes quickly, watches for the session closing, or waits on the app (which
   * closing kills), so this settles soon after `stopped` rejects: closing waits for it before removing anything.
   */
  private async startSteps(deadline: number, at: (p: StartPhase) => void, stopped: Promise<never>): Promise<void> {
    const left = () => {
      if (this.closeRequested) throw new DriverError('CLOSED', 'The session was closed while it started.');
      return Math.max(1, deadline - Date.now());
    };
    const reach = async (p: StartPhase) => {
      at(p);
      left();
      const held = this.options.hooks?.phase?.(p, this);
      if (held) await Promise.race([held, stopped]);
      left();
    };
    this.build = await buildIdentity(this.appRoot);
    left();
    this.paths = await this.makeRoot();
    this.logTimer = setInterval(() => void this.flushLog(), LOG_FLUSH_MS);
    this.logTimer.unref();
    await reach('root');
    await reach('provider');
    if ((this.args.provider ?? 'scripted') === 'scripted') {
      this.mock = await new MockOpenAIServer().start();
      const script = (this.script = new Script());
      // What a test queued on the server itself comes first; then the session's script answers.
      this.mock.respond = (req) => script.next(req);
    }
    // A live session's key goes into the profile it made, readable only by this account, before the app starts.
    if (this.live) await writeLiveKey(this.paths.profile, this.live);
    // Nothing is launched once the session is closing; a launch already under way is ended as its process appears.
    left();
    at('app.spawned');
    const launch = startElectron({
      env: sessionEnv(this.paths, { headed: this.args.headed }),
      cwd: this.appRoot,
      // The profile from the first instruction the app runs, so even a build that ignores SITEORIGIN_USER_DATA never
      // takes the single-instance lock of a Builder already running in the person's own profile.
      args: [`--user-data-dir=${this.paths.profile}`],
      // Playwright's own deadline comes after the session's, which kills the app first: Playwright's leaves waits
      // that reject with no one listening.
      timeoutMs: left() + 30_000,
      artifactsDir: join(this.paths.root, 'playwright'),
      onSpawn: (child) => {
        this.proc = child;
        this.pid = child.pid!;
        void identify(child.pid!).then((e) => e && this.seen.set(e.pid, e));
        // A live session's app talks to a real provider: what it prints is not kept, in case it quotes the key.
        if (this.live) this.appLog.write('The app\'s output is not kept in a session with a configured provider.\n');
        else {
          child.stdout?.on('data', (d) => this.appLog.write(d));
          child.stderr?.on('data', (d) => this.appLog.write(d));
        }
        if (this.closeRequested) void killTree(child.pid!).catch(() => undefined);
        else void Promise.resolve(this.options.hooks?.phase?.('app.spawned', this)).catch(() => undefined);
      }
    });
    this.launching = launch.catch(() => undefined);
    const app = await launch;
    this.app = app;
    // A throw inside a Playwright event handler would end this whole process, so these never throw.
    app.on('close', () => {
      this.appExited = true;
      this.event({ type: 'app.exited', at: now(), code: this.proc?.exitCode ?? null, signal: this.proc?.signalCode ?? null });
    });
    app.on('window', (page) => void this.consider(page).catch(() => undefined));
    for (const page of app.windows()) void this.consider(page).catch(() => undefined);
    await reach('app.launched');
    const page = await this.waitForWindow(left());
    await reach('window');
    this.appIdentity = await this.readAppIdentity();
    this.checkIsolation(this.appIdentity);
    await reach('isolation');
    await page.waitForSelector('.welcome', { timeout: left() });
    await reach('welcome');
    if (this.mock) await this.useScriptedProvider(page, this.mock.baseURL, left);
    if (this.live) await this.useLiveProvider(page, this.live, left);
    await reach('provider.settings');
    const fixture = this.args.fixture ?? 'welcome';
    if (fixture !== 'welcome') await this.createFixture(page, fixture, left, reach);
    // A live session's time runs from here, kept by the app: past it nothing reaches a provider, and the app stops
    // what is running.
    if (this.live) await inMain(this.app!, journalInMain, { op: 'limitTurns', max: this.live.maxTurns, withinMs: this.live.timeoutMs } as JournalCall);
    await reach('ready');
  }

  /**
   * Set the app up with the configured provider, and cap the requests its assistant may start (its time is set once
   * the session is ready). The app keeps both limits itself, so they hold whatever this process or the editor window
   * is doing.
   */
  private async useLiveProvider(page: Page, live: LiveSetup, left: () => number) {
    await inMain(this.app!, journalInMain, { op: 'limitTurns', max: live.maxTurns } as JournalCall);
    await page.evaluate((patch) => (globalThis as any).builder.app.setSettings(patch), liveSettings(live));
    await page.reload({ timeout: left() });
    await page.waitForSelector('.welcome', { timeout: left() });
    const ai = (await page.evaluate(() => (globalThis as any).builder.app.getSettings().then((s: any) => s.ai))) as { provider: string };
    if (ai.provider !== live.provider) throw new DriverError('LAUNCH_FAILED', `The app did not take the configured provider (it uses ${ai.provider}).`, { details: { phase: 'provider.settings' } });
  }

  private async waitForWindow(timeoutMs: number): Promise<Page> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.bound && !this.bound.closed) return this.bound.page;
      if (this.appExited) throw new DriverError('LAUNCH_FAILED', 'The app exited before its editor window appeared.');
      if (this.closeRequested) throw new DriverError('CLOSED', 'The session was closed while it started.');
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new DriverError('TIMEOUT', 'No editor window appeared in time.', { details: { phase: 'window' } });
  }

  private async readAppIdentity(): Promise<AppIdentity> {
    return (await this.app!.evaluate(({ app }) => ({
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      paths: {
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
        documents: app.getPath('documents'),
        temp: app.getPath('temp'),
        home: app.getPath('home'),
        tmpdir: process.env.TMPDIR ?? process.env.TEMP ?? null
      },
      desktopFixtures: !!(globalThis as Record<symbol, unknown>)[Symbol.for('siteorigin.desktopFixtures')]
    }))) as AppIdentity;
  }

  /** The app must keep its profile and Documents inside the session, or nothing about the run is isolated. */
  private checkIsolation(identity: AppIdentity) {
    const p = this.paths!;
    const wrong = (['userData', 'sessionData', 'documents'] as const).filter((k) => !isInside(p.root, identity.paths[k]));
    if (wrong.length) throw new DriverError('LAUNCH_FAILED', `The app is not using the session's own folders (${wrong.map((k) => `${k}: ${identity.paths[k]}`).join(', ')}).`, { details: { phase: 'isolation', paths: identity.paths } });
    // A build that would show its own native dialogs could put one on the person's screen.
    if (!identity.desktopFixtures) throw new DriverError('LAUNCH_FAILED', 'The app does not answer its native choosers from the test: it predates desktop fixtures. Rebuild it (npm run build).', { details: { phase: 'isolation' } });
  }

  private async useScriptedProvider(page: Page, baseURL: string, left: () => number) {
    await page.evaluate((url) => (globalThis as any).builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: url, allowRemote: false, toolMode: 'constrained-json' } } }), baseURL);
    await page.reload({ timeout: left() });
    await page.waitForSelector('.welcome', { timeout: left() });
    const ai = (await page.evaluate(() => (globalThis as any).builder.app.getSettings().then((s: any) => s.ai))) as { provider: string; local: { baseURL: string } };
    if (ai.provider !== 'local' || ai.local.baseURL !== baseURL) throw new DriverError('LAUNCH_FAILED', `The app did not take the scripted provider (it uses ${ai.provider} at ${ai.local?.baseURL}).`, { details: { phase: 'provider.settings' } });
  }

  private async createFixture(page: Page, name: Exclude<FixtureName, 'welcome'>, left: () => number, reach: (p: StartPhase) => Promise<void>) {
    const spec = FIXTURES[name];
    const parentDir = this.paths!.projects;
    const res = (await page.evaluate((o) => (globalThis as any).builder.projects.create(o), { ...spec, parentDir })) as { ok: boolean; message?: string };
    if (!res.ok) throw new DriverError('LAUNCH_FAILED', `The ${name} fixture could not be created: ${res.message ?? 'no reason given'}`, { details: { phase: 'fixture.created' } });
    const made = (await readdir(parentDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(parentDir, e.name));
    this.fixtureProject = made.length === 1 ? made[0] : null;
    await page.waitForSelector('.editor', { timeout: left() });
    await reach('fixture.created');
    const frame = page.frameLocator('.frame-box iframe');
    await frame.locator(spec.starter === 'blank' ? 'body *' : 'h1').first().waitFor({ timeout: left() });
    // The selection bridge loads after hydration; until then the preview is not ready to work with.
    await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: left() });
    // And the page has taken the editor's mode: from here, observations call the preview ready.
    await frame.locator('html[data-so-bridge]').waitFor({ state: 'attached', timeout: left() });
    await reach('fixture.ready');
  }

  /** Make the run root, marked as this session's, and its folders. A root that cannot be finished is removed again. */
  private async makeRoot(): Promise<SessionPaths> {
    const parent = resolve(this.options.parentDir ?? process.env.WORK ?? (await realpath(tmpdir())));
    await mkdir(parent, { recursive: true });
    // Resolved, because Vite fails to import through a symlinked project path (the macOS temp folder is one).
    const root = await realpath(await mkdtemp(join(parent, 'so-session-')));
    let outside: string | null = null;
    try {
      await writeFile(join(root, OWNER_MARK), JSON.stringify({ sessionId: this.id, pid: process.pid, createdAt: now() }));
      let artifacts = join(root, 'artifacts');
      if (this.args.artifactsDir) {
        await mkdir(this.args.artifactsDir, { recursive: true });
        artifacts = join(await realpath(this.args.artifactsDir), this.id);
        await mkdir(artifacts);
        outside = artifacts;
        await writeFile(join(artifacts, OWNER_MARK), JSON.stringify({ sessionId: this.id, pid: process.pid, createdAt: now() }));
        this.artifactsOutside = true;
      }
      const paths: SessionPaths = {
        root,
        profile: join(root, 'profile'),
        workspace: join(root, 'workspace'),
        projects: join(root, 'workspace', 'SiteOrigin'),
        imports: join(root, 'imports'),
        exports: join(root, 'exports'),
        home: join(root, 'home'),
        tmp: join(root, 'tmp'),
        artifacts
      };
      for (const dir of [paths.profile, paths.projects, paths.imports, paths.exports, paths.home, paths.tmp, paths.artifacts]) await mkdir(dir, { recursive: true });
      return paths;
    } catch (e) {
      // Nothing else knows these folders yet: they were made just now, by this call.
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (outside) await rm(outside, { recursive: true, force: true }).catch(() => undefined);
      throw new DriverError('LAUNCH_FAILED', `The session's folders could not be made: ${e instanceof Error ? e.message : String(e)}`, { details: { phase: 'root' } });
    }
  }

  // -- describing ----------------------------------------------------------------

  /** The processes the session owns now, remembered by identity so they can still be found if they leave the tree. */
  private async ownedNow(): Promise<ProcessEntry[]> {
    if (!this.pid) return [];
    const owned = ownedEntries(await processTable(), this.pid, [...this.seen.values()]);
    for (const e of owned) this.seen.set(e.pid, e);
    return owned;
  }

  async describe(): Promise<Description> {
    const processes = (await this.ownedNow().catch((): ProcessEntry[] => [])).map((e) => e.pid);
    const provider = this.mock
      ? { kind: 'scripted' as const, baseURL: this.mock.baseURL }
      : this.live
        ? { kind: 'configured' as const, provider: this.live.provider, model: this.live.model ?? null, maxTurns: this.live.maxTurns, timeoutMs: this.live.timeoutMs }
        : this.state === 'new'
          ? null
          : { kind: 'none' as const };
    return {
      protocol: PROTOCOL_VERSION,
      session: {
        id: this.id,
        state: this.state,
        root: this.paths?.root ?? null,
        paths: this.paths,
        fixture: this.state === 'new' ? null : (this.args.fixture ?? 'welcome'),
        project: this.fixtureProject,
        provider,
        headless: !this.args.headed,
        keepArtifacts: this.args.keepArtifacts ?? 'on-failure',
        pid: this.pid,
        processes,
        window: this.bound && !this.bound.closed ? this.bound.ref : null,
        acknowledgedWindow: this.acknowledged
      },
      build: this.build,
      app: this.appIdentity,
      capabilities: capabilities()
    };
  }

  // -- closing -------------------------------------------------------------------

  /**
   * End the session. Safe to call at any time and more than once: every call gets the same result, and the first
   * call's arguments decide whether artifacts are kept.
   */
  close(args: CloseArgs = {}): Promise<CloseResult> {
    if (args.failed) this.failed = true;
    this.closing ??= this.teardown(args);
    return this.closing;
  }

  private keepsArtifacts(args: CloseArgs = {}): boolean {
    if (this.keeping !== null) return this.keeping;
    const keep = args.keepArtifacts ?? this.args.keepArtifacts ?? 'on-failure';
    return keep === 'always' || (keep === 'on-failure' && this.failed);
  }

  private appRunning(): boolean {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private async teardown(args: CloseArgs): Promise<CloseResult> {
    const wasStarted = this.state !== 'new';
    this.closeRequested = true;
    this.state = 'closing';
    this.keeping = this.keepsArtifacts(args);
    this.abortStart?.(new DriverError('CLOSED', 'The session was closed while it started.'));
    this.refs.clear();
    this.evidence.clear();
    // The record of a run that got going, with what the app shows now when it still can (bounded). If that cannot be
    // written in time (an earlier save still stuck), it is written from what the session holds, and is the last word.
    if (this.keeping && this.reachedReady && this.paths) {
      const stop = new AbortController();
      const saved = await bounded(this.saveReplay(stop.signal, true).then(() => true, () => false), RECORD_OBSERVATION_MS + 4000, false);
      this.recordSealed = true;
      if (!saved) {
        stop.abort();
        const artifacts = await readdir(this.paths.artifacts).catch(() => [] as string[]);
        await writeWhole(join(this.paths.artifacts, 'replay.json'), JSON.stringify(this.recordFrom(this.lastObservation, undefined, artifacts), null, 2)).catch(() => undefined);
      }
    }
    if (this.keeping && this.bound && !this.bound.closed && !this.appExited) {
      const page = this.bound.page;
      // As with every screenshot the session takes, none while any credential is known (or that cannot be told in
      // time), and credential fields masked in every frame.
      const mask = page.frames().map((f) => f.locator(SECRET_INPUTS));
      const clear = async () => !this.secrets.size && !(await this.storedSecrets(true)).length && !(await frameSecrets(page, { strict: true })).length;
      if (await bounded(clear().catch(() => false), 3000, false)) {
        const png = await page.screenshot({ timeout: 5000, mask }).catch(() => null);
        if (png && (await bounded(clear().catch(() => false), 3000, false))) await writeFile(join(this.paths!.artifacts, 'final.png'), png).catch(() => undefined);
      }
    }
    let ended: CloseResult['ended'] = !wasStarted || !this.pid ? 'not-started' : this.appExited ? 'already-exited' : 'quit';
    // Whatever the session cannot account for once it is done (a process table it could not read, a start that would
    // not settle, a process that would not end) keeps the run folder in place rather than delete it under something
    // still running.
    const problems: string[] = [];
    await this.ownedNow().catch(() => undefined);
    if (this.app && !this.appExited) {
      const quit = await bounded(
        this.app.close().then(
          () => true,
          () => false
        ),
        this.options.closeTimeoutMs ?? DEFAULT_CLOSE_MS,
        false
      );
      if (!quit) ended = 'killed';
    } else if (this.appRunning()) ended = 'killed';
    // Even an app that quit can leave a child behind (an npm install whose parent is gone): sweep what it owned.
    const sweep = async (final: boolean) => {
      if (!this.pid) return [];
      try {
        const report = await killTree(this.pid, { known: [...this.seen.values()] });
        for (const e of report.owned) this.seen.set(e.pid, e);
        return report.survivors;
      } catch (e) {
        // Without a process table, the app itself is still known to be this process's child while Node has not seen
        // it exit: end it and its group, which takes what it started with it.
        this.killAppDirectly();
        if (final) problems.push(`the process table could not be read (${String(e)})`);
        return [];
      }
    };
    await sweep(false);
    // A launch or start still in flight settles once its process is gone; anything it spawned meanwhile is swept.
    const settled = await bounded(Promise.all([this.launching, this.starting]).then(() => true), SETTLE_MS, false);
    if (!settled) problems.push(`the start did not settle within ${SETTLE_MS / 1000}s`);
    const survivors = await sweep(true);
    if (survivors.length) problems.push(`processes ${survivors.map((e) => e.pid).join(', ')} did not end`);
    const processes = [...this.seen.keys()];
    // Held replies go before the server stops, so nothing waits on a gate after the session.
    this.script?.close();
    // A live key leaves the run folder even when the folder is kept because cleanup could not account for everything:
    // the key file and any copy the app was writing when it ended. One that cannot be removed is said.
    if (this.live?.key && this.paths) {
      const profile = this.paths.profile;
      // The key file, and the temporary files the app writes settings and keys through (".<hex>.tmp"), any of which
      // may hold the key if the app ended mid-write.
      const copies = await readdir(profile).then(
        (names) => names.filter((n) => n.startsWith('api-keys.json') || /^\.[0-9a-f]+\.tmp$/.test(n)),
        (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : (problems.push(`the profile could not be listed to remove the live key (${String(e)})`), []))
      );
      for (const name of copies) await rm(join(profile, name), { force: true }).catch((e: unknown) => problems.push(`the live key in ${join(profile, name)} could not be removed (${String(e)})`));
    }
    await this.mock?.stop().catch(() => undefined);
    // The app's output, once it can write no more: kept with the artifacts, or with a run folder that stays as evidence.
    if (this.logTimer) clearInterval(this.logTimer);
    this.logTimer = null;
    // A flush still writing finishes first, so the last word in app.log is this one.
    await this.flushing;
    if (this.paths && (this.keeping || problems.length)) await writeWhole(join(this.paths.artifacts, 'app.log'), this.logText()).catch(() => undefined);
    this.state = 'closed';
    if (problems.length) {
      throw new DriverError('CLEANUP_FAILED', `The run folder ${this.paths?.root ?? '(none)'} was kept: ${problems.join('; ')}.`, {
        details: { problems, survivors: survivors.map((e) => e.pid), processes, root: this.paths?.root ?? null }
      });
    }
    try {
      const { removed, artifacts } = await this.removeOwned(this.keeping);
      return { artifacts, removed, processes, ended };
    } catch (e) {
      if (e instanceof DriverError) throw e;
      throw new DriverError('CLEANUP_FAILED', `The run folder ${this.paths?.root} could not be removed: ${e instanceof Error ? e.message : String(e)}`, { details: { processes, root: this.paths?.root ?? null } });
    }
  }

  /** End the app's main process and its group without a process table: only while Node holds it as an unexited child. */
  private killAppDirectly() {
    if (!this.appRunning() || !this.pid) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-this.pid, 'SIGKILL');
      } catch {
        // No such group.
      }
    }
    this.proc?.kill('SIGKILL');
  }

  /** Remove what the session made, after checking each folder still carries its mark; keep the artifacts if asked. */
  private async removeOwned(keeping: boolean): Promise<{ removed: string[]; artifacts: string | null }> {
    const p = this.paths;
    if (!p) return { removed: [], artifacts: null };
    const removed: string[] = [];
    await this.checkMark(p.root);
    if (keeping && !this.artifactsOutside) {
      for (const name of await readdir(p.root)) {
        if (name === 'artifacts' || name === OWNER_MARK) continue;
        await rm(join(p.root, name), { recursive: true, force: true, maxRetries: 5 });
        removed.push(join(p.root, name));
      }
      return { removed, artifacts: p.artifacts };
    }
    await rm(p.root, { recursive: true, force: true, maxRetries: 5 });
    removed.push(p.root);
    if (this.artifactsOutside) {
      if (keeping) return { removed, artifacts: p.artifacts };
      await this.checkMark(p.artifacts);
      await rm(p.artifacts, { recursive: true, force: true, maxRetries: 5 });
      removed.push(p.artifacts);
    }
    return { removed, artifacts: null };
  }

  private async checkMark(dir: string) {
    const mark = await readFile(join(dir, OWNER_MARK), 'utf8').then(
      (t) => JSON.parse(t) as { sessionId?: string },
      () => null
    );
    if (mark?.sessionId !== this.id) throw new DriverError('CLEANUP_FAILED', `${dir} does not carry this session's mark; it was left in place.`, { details: { dir } });
  }

  /** What a failed start leaves for whoever looks into it. */
  private async writeEvidence(error: DriverError) {
    if (!this.paths) return;
    const description = await this.describe().catch(() => null);
    const evidence = { error: { code: error.code, message: error.message, details: error.details }, description, pageErrors: this.pageErrors };
    const secrets = [...this.secrets, ...(await this.storedSecrets().catch((): string[] => []))];
    await writeFile(join(this.paths.artifacts, 'session.json'), JSON.stringify(scrubDeep(evidence, secrets), null, 2));
  }

  /**
   * Last resort when the process hosting the session is exiting and cannot wait: kill what the app owns and remove
   * the run's folders, keeping the artifacts when the session would have. Synchronous, so it can run in an 'exit'
   * handler.
   */
  disposeSync() {
    if (this.state === 'closed') return;
    this.closeRequested = true;
    const keeping = this.keepsArtifacts();
    if (this.pid) {
      try {
        killTreeSync(this.pid, [...this.seen.values()]);
      } catch {
        // Nothing more can be done on the way out.
      }
      this.killAppDirectly();
    }
    const ours = (dir: string) => {
      try {
        return (JSON.parse(readFileSync(join(dir, OWNER_MARK), 'utf8')) as { sessionId?: string }).sessionId === this.id;
      } catch {
        return false;
      }
    };
    const p = this.paths;
    if (this.logTimer) clearInterval(this.logTimer);
    this.logTimer = null;
    if (p && keeping) {
      try {
        writeWholeSync(join(p.artifacts, 'app.log'), this.logText());
        // The record of the run from what is held now: no observation can be taken on the way out.
        if (this.reachedReady) writeWholeSync(join(p.artifacts, 'replay.json'), JSON.stringify(this.recordFrom(this.lastObservation, undefined, readdirSync(p.artifacts)), null, 2));
      } catch {
        // The process is exiting: the evidence is kept as far as it can be.
      }
    }
    try {
      if (p && ours(p.root)) {
        if (keeping && !this.artifactsOutside) {
          for (const name of readdirSync(p.root)) if (name !== 'artifacts' && name !== OWNER_MARK) rmSync(join(p.root, name), { recursive: true, force: true, maxRetries: 3 });
        } else rmSync(p.root, { recursive: true, force: true, maxRetries: 3 });
      }
      if (p && this.artifactsOutside && !keeping && ours(p.artifacts)) rmSync(p.artifacts, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Left for whoever looks: the process is exiting.
    }
    this.state = 'closed';
  }
}
