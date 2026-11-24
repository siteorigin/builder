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
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, ElementHandle, Page } from 'playwright';
import { MockOpenAIServer } from '../unit/mock-openai-server.ts';
import { parseAction, runAction } from './act.ts';
import { desktopInMain, inMain, invokeMenuInMain, listSessionFolder, menuTreeInMain, resolveAnswer, stageImport } from './desktop.ts';
import type { Area } from './desktop.ts';
import { SECRET_INPUTS, elementFor, frameSecrets, parseLocateArgs, parseSnapshotArgs, uiLocate, uiSnapshot } from './observe.ts';
import type { ObserveEnv } from './observe.ts';
import { killTree, killTreeSync, ownedEntries, processTable } from './processes.ts';
import type { ProcessEntry } from './processes.ts';
import { DriverError, PROTOCOL_VERSION, failure, frameIdentity, parseRequest, success } from './protocol.ts';
import type { Capability, CloseArgs, CloseResult, FixtureName, KeepArtifacts, OpKind, Reply, ReplyContext, Request, SessionEvent, StartArgs, WindowRef } from './protocol.ts';
import { RefRegistry, scrubDeep } from './snapshot.ts';
import { ShotRegistry } from './shots.ts';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The file that marks a folder as made by one session: nothing without it is ever removed. */
export const OWNER_MARK = '.siteorigin-test-session.json';

const DEFAULT_STARTUP_MS = 180_000;
const DEFAULT_CLOSE_MS = 15_000;
/** How long a launch still in flight when the session closes gets to settle once its process is gone. */
const SETTLE_MS = 30_000;
const MAX_EVENTS = 100;

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
}

type State = 'new' | 'starting' | 'ready' | 'closing' | 'closed';

interface OpSpec {
  kind: OpKind;
  defaultTimeoutMs: number;
  needsApp: boolean;
  usesWindow: boolean;
  summary: string;
}

/** The operations a session answers: `session.describe` lists them as its capabilities. */
export const OPERATIONS: Record<string, OpSpec> = {
  'session.start': {
    kind: 'session',
    defaultTimeoutMs: DEFAULT_STARTUP_MS,
    needsApp: false,
    usesWindow: false,
    summary: 'Start the built app headless in a new profile and workspace, at Welcome or with a named fixture project. Its deadline covers the whole start; one that passes ends the session.'
  },
  'session.describe': {
    kind: 'session',
    defaultTimeoutMs: 15_000,
    needsApp: false,
    usesWindow: false,
    summary: 'The session, the build and the running app, the processes the session owns, and these capabilities.'
  },
  'window.info': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: true,
    summary: 'The bound editor window: generation, native id, address, title, visibility and size.'
  },
  'window.close': {
    kind: 'act',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Close the bound editor window, as its close button does: the editor may first ask about unsaved work. On macOS the app keeps running with no window.'
  },
  'menu.list': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'The native application menu: every item with its label path, id, role, enabled and visible state, accelerator, and whether menu.invoke can choose it.'
  },
  'menu.invoke': {
    kind: 'act',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Choose an application menu item by its label path (["File", "Open Project…"]) through its own handler, for the bound editor window or, with none open, for none. Refused when it is missing, hidden, disabled or a system role.'
  },
  'desktop.setAnswers': {
    kind: 'fixture',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary:
      'Set the answers for the next native choosers, in order, replacing any left ([] clears them). Each is { dialog: open|save|message, title?, message?, selection?: file|files|folder|fileOrFolder } with one of { cancel: true }, { paths } (open), { path, overwrite?: replace|decline } (save) or { button } (message). Paths are session paths: imports/…, exports/… or workspace/…. A chooser with no answer for it is closed without a choice; none is ever shown.'
  },
  'desktop.events': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'What happened at the desktop after a cursor: each chooser shown and how it was answered, links, reveals and paths the app handed to the system, menu items chosen and answers set or expired. Also the answers still waiting.'
  },
  'files.stageImport': {
    kind: 'fixture',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'Copy a sample image into the session’s imports/ folder under a new name, for a chooser to be answered with. Never replaces a file.'
  },
  'files.list': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'One level of a session folder (default exports/): each entry’s name, path, type and size.'
  },
  'ui.snapshot': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'The accessibility tree of the editor and of its live preview, bounded (maxNodes, depth) with refs to drill into (within, offset), plus the context: screen, mode, dialog, focus, preview state and the selection. Optionally saves screenshots of both.'
  },
  'ui.locate': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'One element, by role and name (in a region or within a ref) or by a ref seen before, as it is now: its ref, states, box, regions and page ids. Several matches answer AMBIGUOUS_TARGET with candidates; an outdated ref, STALE_REF.'
  },
  'ui.click': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'Click a target with the real pointer: { target: { ref, position? } or a screenshot point { observation, surface, x, y }, button?: left|right, count?: 1|2, modifiers?: [Shift, Alt, Control, Meta, ControlOrMeta] }. Waits up to waitMs (default 3000) for it to be visible, enabled, not under a dialog and not covered; else NOT_ACTIONABLE with nothing sent.'
  },
  'ui.hover': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Move the pointer onto a target (a ref, or a screenshot point), once it is visible and not covered.'
  },
  'ui.fill': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Replace the text of a field or of text being edited ({ target: { ref }, text }; empty text clears it): the focus goes to it, everything in it is selected and the text is inserted as typing would. Nothing is committed.'
  },
  'ui.type': {
    kind: 'act',
    defaultTimeoutMs: 30_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Type text key by key ({ text, target?: { ref } }): into the target, keeping its caret when it already has the focus, or into what has the focus, which must take text. Stops if the focus moves while typing.'
  },
  'ui.select': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Choose one option of a single-choice <select> ({ target: { ref }, option: { label } or { value } }) after putting the focus on it, as a person would. Other lists are chosen in with ui.click.'
  },
  'ui.press': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Press one key chord ({ key: "Escape" | "Shift+Tab" | "ControlOrMeta+z" | ..., target?: { ref } }): on the target, after putting the focus on it, or on what has the focus now. The whole chord is checked before any key goes down.'
  },
  'ui.scroll': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Turn the mouse wheel over a target that is in view ({ target, deltaX?, deltaY? } in CSS pixels): what scrolls is what a person\'s wheel would scroll there.'
  },
  'ui.drag': {
    kind: 'act',
    defaultTimeoutMs: 20_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'Press on `from`, move to `to` (a drop target) or `by` an offset in the editor window\'s CSS pixels (a resize handle), in `steps` moves, and release: { from, to? | by?: { x, y }, steps? }. Both ends are checked before the button goes down; a drag that stops part way is cancelled (Escape) where it started.'
  },
  'session.close': {
    kind: 'session',
    defaultTimeoutMs: 60_000,
    needsApp: false,
    usesWindow: false,
    summary: 'Quit the app (killing it if it does not quit in time), end every process it started and remove the run-owned data, keeping artifacts when asked.'
  }
};

export function capabilities(): Capability[] {
  return Object.entries(OPERATIONS).map(([op, s]) => ({ op, kind: s.kind, defaultTimeoutMs: s.defaultTimeoutMs, needsApp: s.needsApp, usesWindow: s.usesWindow, summary: s.summary }));
}

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
    provider: { kind: 'scripted'; baseURL: string } | { kind: 'none' } | null;
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

function parseStartArgs(args: Record<string, unknown> | undefined): StartArgs {
  const a = args ?? {};
  const out: StartArgs = {};
  const known = new Set(['fixture', 'provider', 'keepArtifacts', 'artifactsDir', 'headed']);
  for (const key of Object.keys(a)) if (!known.has(key)) throw new DriverError('BAD_REQUEST', `session.start does not take "${key}".`);
  if (a.fixture !== undefined) {
    if (a.fixture !== 'welcome' && !(typeof a.fixture === 'string' && a.fixture in FIXTURES)) throw new DriverError('BAD_REQUEST', `Unknown fixture "${String(a.fixture)}": use welcome or ${Object.keys(FIXTURES).join(', ')}.`);
    out.fixture = a.fixture as FixtureName;
  }
  if (a.provider !== undefined) {
    if (a.provider !== 'scripted' && a.provider !== 'none') throw new DriverError('BAD_REQUEST', '"provider" is "scripted" or "none".');
    out.provider = a.provider;
  }
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

function parseCloseArgs(args: Record<string, unknown> | undefined): CloseArgs {
  const a = args ?? {};
  for (const key of Object.keys(a)) if (key !== 'keepArtifacts' && key !== 'failed') throw new DriverError('BAD_REQUEST', `session.close does not take "${key}".`);
  if (a.keepArtifacts !== undefined && !KEEP.includes(a.keepArtifacts as KeepArtifacts)) throw new DriverError('BAD_REQUEST', `"keepArtifacts" is one of ${KEEP.join(', ')}.`);
  if (a.failed !== undefined && typeof a.failed !== 'boolean') throw new DriverError('BAD_REQUEST', '"failed" is true or false.');
  return a as CloseArgs;
}

const now = () => new Date().toISOString();

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
  /** Page errors the editor raised, across every window the session bound. */
  readonly pageErrors: string[] = [];
  paths: SessionPaths | null = null;
  pid: number | null = null;
  mock: MockOpenAIServer | null = null;

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
  private log: WriteStream | null = null;
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
    try {
      if (!spec) throw new DriverError('UNKNOWN_OP', `There is no operation "${request.op}".`, { details: { ops: Object.keys(OPERATIONS) } });
      if (request.op !== 'session.close' && this.inFlight) throw new DriverError('BUSY', `Request "${this.inFlight}" is still running; requests run one at a time.`, { retryable: true });
      if (request.op !== 'session.close' && request.op !== 'session.describe' && (this.state === 'closing' || this.state === 'closed')) throw new DriverError('CLOSED', 'The session is closed.');
      if (spec.needsApp && this.state !== 'ready') throw new DriverError('NOT_STARTED', 'Start the session first (session.start).');
    } catch (e) {
      return failure(request, e, await this.replyContext(began));
    }
    if (request.op !== 'session.close') this.inFlight = request.id;
    try {
      const timeoutMs = request.timeoutMs ?? spec.defaultTimeoutMs;
      let result: unknown;
      if (request.op === 'session.start') result = await this.start(parseStartArgs(request.args), { timeoutMs });
      else if (request.op === 'session.close') result = await this.close(parseCloseArgs(request.args));
      else result = await this.withDeadline(request, spec, timeoutMs);
      return success(request, result, await this.replyContext(began));
    } catch (e) {
      return failure(request, e, await this.replyContext(began));
    } finally {
      if (this.inFlight === request.id) this.inFlight = null;
    }
  }

  private async withDeadline(request: Request, spec: OpSpec, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Work that outlives its deadline is told to stop, so a late observation publishes no refs and saves no files.
    const abort = new AbortController();
    const work = this.run(request, abort.signal, Date.now() + timeoutMs);
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
        reject(new DriverError('TIMEOUT', `${request.op} did not finish within ${timeoutMs / 1000}s.`, { details: { phase: request.op, sessionState: terminal ? 'closing' : this.state } }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(request: Request, signal: AbortSignal, deadline: number): Promise<unknown> {
    switch (request.op) {
      case 'session.describe':
        return this.describe();
      case 'window.info':
        return this.windowInfo(this.windowFor(request));
      case 'window.close':
        return this.closeWindow(request);
      case 'menu.list':
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
        return uiSnapshot(this.observer(this.windowFor(request), signal), args, ++this.observations);
      }
      case 'ui.locate': {
        const args = parseLocateArgs(request.args);
        await this.settled();
        return uiLocate(this.observer(this.windowFor(request), signal), args);
      }
      case 'ui.click':
      case 'ui.hover':
      case 'ui.fill':
      case 'ui.type':
      case 'ui.select':
      case 'ui.press':
      case 'ui.scroll':
      case 'ui.drag': {
        try {
          const action = parseAction(request.op, request.args);
          // Never past the point where the action could still fail with a reason rather than run out of time.
          await this.settled(Math.max(0, deadline - Date.now() - 2000));
          const page = this.windowFor(request);
          return await runAction({ observe: this.observer(page, signal), page, deadline, shots: this.shots }, action);
        } catch (e) {
          // A request can quote what it was given (a key chord, say): nothing the session knows as a credential goes back.
          if (e instanceof DriverError && this.secrets.size) {
            const known = [...this.secrets];
            throw new DriverError(e.code, scrubDeep(e.message, known), { retryable: e.retryable, ...(e.details ? { details: scrubDeep(e.details, known) } : {}) });
          }
          throw e;
        }
      }
      default:
        throw new DriverError('UNKNOWN_OP', `There is no operation "${request.op}".`);
    }
  }

  private observer(page: Page, signal: AbortSignal): ObserveEnv {
    return {
      page,
      generation: this.bound!.ref.generation,
      registry: this.refs,
      artifacts: this.paths?.artifacts ?? null,
      signal,
      storedSecrets: (strict) => this.storedSecrets(strict),
      remember: (secrets) => {
        for (const x of secrets) if (x) this.secrets.add(x);
      },
      remembered: () => [...this.secrets],
      shots: this.shots
    };
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
      this.pageErrors.push(String(e));
      // Kept whole: the reply that carries it is scrubbed of credentials first, then cuts it to length.
      this.event({ type: 'page.error', at: now(), generation: ref.generation, message: String(e) });
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
    this.args = parseStartArgs(args as Record<string, unknown>);
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
    this.log = createWriteStream(join(this.paths.artifacts, 'app.log'), { flags: 'a' });
    // A full disk must not end the process hosting the session: the log is evidence, not a requirement.
    this.log.on('error', () => undefined);
    await reach('root');
    await reach('provider');
    if ((this.args.provider ?? 'scripted') === 'scripted') this.mock = await new MockOpenAIServer().start();
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
        child.stdout?.on('data', (d) => this.log?.write(d));
        child.stderr?.on('data', (d) => this.log?.write(d));
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
    await reach('provider.settings');
    const fixture = this.args.fixture ?? 'welcome';
    if (fixture !== 'welcome') await this.createFixture(page, fixture, left, reach);
    await reach('ready');
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
    const provider = this.mock ? { kind: 'scripted' as const, baseURL: this.mock.baseURL } : this.state === 'new' ? null : { kind: 'none' as const };
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
    await this.mock?.stop().catch(() => undefined);
    if (this.log) await bounded(new Promise<void>((r) => this.log!.end(() => r())), 5000, undefined);
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
