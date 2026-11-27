/**
 * Whether the computer already has a Git of its own (#1152), reported beside the bundled one so Settings can say what
 * is there. Saved versions never need it: the bundled pure-JavaScript Git writes the repository, and a Git found here
 * is only ever asked its version. Looking prompts for nothing, installs nothing and writes no file: the only program it
 * runs is `git --version` (and on macOS `xcode-select -p`, which only prints a folder).
 *
 * On macOS, /usr/bin/git is a stand-in that asks to install Apple's command line tools when they are missing, in a
 * dialog of its own. It is never run: the Git it stands for is found through `xcode-select -p` and asked directly,
 * and with no tools installed there is no Git to find.
 */
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter as hostDelimiter, posix, win32 } from 'node:path';

export type SystemGit =
  /** A Git that answered with its version. */
  | { status: 'present'; path: string; version: string }
  /** No Git on the computer's search path or in the usual places. */
  | { status: 'missing' }
  /** A program named git that did not answer as Git does: it failed, hung, or printed something else. */
  | { status: 'unusable'; path: string; reason: 'failed' | 'timeout' | 'unrecognised' };

/** What a program said, or that it failed to start or finish. */
export interface RunResult {
  /** The exit code; null when it did not start or was ended. */
  code: number | null;
  stdout: string;
  timedOut: boolean;
}
export type Runner = (file: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<RunResult>;

export interface DetectOptions {
  /** Where PATH (and on Windows PATHEXT and SystemRoot) come from; the process's own by default. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How long `git --version` may take before the Git counts as unusable. */
  timeoutMs?: number;
  /** Folders looked in after PATH, where Git is usually installed: an app opened from the Dock or Finder has a short PATH. */
  extraDirs?: string[];
  /** The macOS stand-in never run (see above); a test points this at a script of its own. */
  macShim?: string;
  run?: Runner;
}

const TIMEOUT_MS = 5000;
/** `git --version` prints one short line; anything longer is not Git. */
const MAX_OUTPUT = 4096;
/** `git version 2.39.5 (Apple Git-154)`, `git version 2.47.1.windows.1`: the whole of one line. */
const VERSION_RE = /^git version (\d+\.\d+(?:\.\d+)*)(?:[ (-][^\r\n]*|\.[^\d\r\n][^\r\n]*)?$/;

/** The folders Git's installers put it in, for each platform, looked in after PATH. */
function usualDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')].filter((r): r is string => !!r);
    return roots.map((r) => win32.join(r, 'Git', 'cmd'));
  }
  return ['/usr/bin', '/usr/local/bin', '/bin'];
}

/** A plain file the user may run: on Windows any file with the name, elsewhere one with an execute bit for us. */
async function runnable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    if (platform !== 'win32') await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The programs named git, in the order the system would find them, then the usual install folders; each once. On
 * Windows only `git.exe` counts: a `git.cmd` or `git.bat` would need a command shell to run.
 */
export function gitCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, extraDirs: string[] | undefined): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const delimiter = platform === process.platform ? hostDelimiter : platform === 'win32' ? ';' : ':';
  const pathVar = (platform === 'win32' ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? '';
  const dirs = [...pathVar.split(delimiter), ...(extraDirs ?? usualDirs(platform, env))].map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d && path.isAbsolute(d));
  const name = platform === 'win32' ? 'git.exe' : 'git';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    const file = path.join(d, name);
    const key = platform === 'win32' || platform === 'darwin' ? file.toLowerCase() : file;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

const runFile: Runner = (file, args, { timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, env, cwd: tmpdir(), maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout ?? ''), timedOut: !!e?.killed && !!e.signal });
    });
  });

/**
 * Only what a program needs to start: no settings of the user's, and Git told never to ask for anything. `git
 * --version` reads no configuration or repository, so none is pointed at.
 */
function quietEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', LANG: 'C' };
  for (const k of platform === 'win32' ? ['SystemRoot', 'TEMP', 'TMP'] : ['TMPDIR']) if (env[k]) out[k] = env[k];
  out.PATH = '';
  return out;
}

/** Whether a file is the macOS stand-in itself, by any name: a link or a second name for it is the same file. */
async function isShim(file: string, shim: string): Promise<boolean> {
  const [a, b] = await Promise.all([fs.stat(file).catch(() => null), fs.stat(shim).catch(() => null)]);
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

/**
 * The Git behind macOS's /usr/bin/git stand-in, when Apple's tools (or Xcode) are installed; null when they are not,
 * or when the folder they name leads back to the stand-in.
 */
async function behindMacShim(run: Runner, env: NodeJS.ProcessEnv, timeoutMs: number, shim: string): Promise<string | null> {
  const r = await run('/usr/bin/xcode-select', ['-p'], { timeoutMs, env });
  const dir = r.code === 0 ? r.stdout.trim().split('\n')[0]?.trim() : '';
  if (!dir || !posix.isAbsolute(dir)) return null;
  const git = posix.join(dir, 'usr', 'bin', 'git');
  return (await runnable(git, 'darwin')) && !(await isShim(git, shim)) ? git : null;
}

/** The computer's own Git, if it has one, and its version. Never rejects. */
export async function detectSystemGit(opts: DetectOptions = {}): Promise<SystemGit> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const run = opts.run ?? runFile;
  const macShim = opts.macShim ?? '/usr/bin/git';
  const quiet = quietEnv(env, platform);
  let unusable: SystemGit | null = null;
  for (const candidate of gitCandidates(platform, env, opts.extraDirs)) {
    if (!(await runnable(candidate, platform))) continue;
    let file = candidate;
    if (platform === 'darwin' && (candidate === macShim || (await isShim(candidate, macShim)))) {
      const real = await behindMacShim(run, quiet, timeoutMs, macShim).catch(() => null);
      // The stand-in with nothing behind it is no Git: another may still be installed further on.
      if (!real) continue;
      file = real;
    }
    let r: RunResult;
    try {
      r = await run(file, ['--version'], { timeoutMs, env: quiet });
    } catch {
      r = { code: null, stdout: '', timedOut: false };
    }
    const version = r.code === 0 ? VERSION_RE.exec(r.stdout.trim())?.[1] : undefined;
    if (version) return { status: 'present', path: file, version };
    // The first that fails is the one to report, unless a later one works.
    unusable ??= { status: 'unusable', path: file, reason: r.timedOut ? 'timeout' : r.code === 0 ? 'unrecognised' : 'failed' };
  }
  return unusable ?? { status: 'missing' };
}
