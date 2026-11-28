/**
 * Running a project's own tests (#1483): the `test` script its package.json declares, run by the npm shipped with the
 * app on Electron's own Node, in the project's folder, as `npm test` would run it there. Nothing else from the project
 * runs: the script must be declared, and the caller checks that the project's setup is still what its author trusted.
 *
 * The script's own commands (`vitest`, a `.bin` shim, `node file.js`) find a `node` on the PATH that is Electron's
 * Node, so a computer without Node installed runs them too. (On Windows that `node` is a batch file, which a program
 * that starts `node` without a shell does not find; Electron's Node is then found only through npm's own.) The run gets the plain environment the preview's server
 * does (no credentials of the app's), no input, and a deadline. Stopping it ends its whole tree of processes: on macOS
 * and Linux it leads a process group of its own, which is signalled as one; on Windows taskkill ends the tree.
 *
 * Output is kept as LineTail keeps it: secrets masked, long lines cut, and a flood of output kept to its first errors
 * and its end. Updates are coalesced, so a chatty run cannot flood the editor.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LineTail } from './line-tail';

export type TestOutcome = { status: 'passed' | 'failed' | 'cancelled' | 'timed-out'; exitCode: number | null; summary: string } | { status: 'not-started'; exitCode: null; summary: string };

export interface ProjectTestOptions {
  /** The project's folder. */
  dir: string;
  /** npm's command-line script (`bin/npm-cli.js` of the npm shipped with the app). */
  npmCli: string;
  /** Electron's own executable, run as Node (`ELECTRON_RUN_AS_NODE`), or Node itself in tests. */
  execPath: string;
  /** The environment the run starts from (the preview's: projectEnv), to which its PATH and Node are added. */
  env: Record<string, string>;
  /** Told the output so far, at most every `updateMs`, and once more at the end. */
  onOutput: (lines: string[]) => void;
  signal: AbortSignal;
  timeoutMs: number;
  updateMs?: number;
  /** How long a stopped run gets to end before its processes are killed. */
  graceMs?: number;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** The test script a package.json declares, or null when it has none (or none that runs anything). */
export function declaredTestScript(packageJson: string | null): string | null {
  if (packageJson === null) return null;
  try {
    const script = (JSON.parse(packageJson) as { scripts?: { test?: unknown } } | null)?.scripts?.test;
    // npm's own placeholder fails on purpose: it is no tests.
    return typeof script === 'string' && script.trim() && !/^echo "Error: no test specified" && exit 1$/.test(script.trim()) ? script : null;
  } catch {
    return null;
  }
}

/** How long output may still arrive after npm exits, from something it started that still holds its output. */
const DRAIN_MS = 1500;

/** A line worth keeping from early in a flood of output: a failure, an error, a stack. */
const important = (line: string) => /\b(FAIL|failed|Error|ERR!|AssertionError|Expected|Received)\b|✗|×/.test(line);

/** A folder holding a `node` that is Electron's Node, for the script's commands to find first on the PATH. */
async function nodeShim(execPath: string, platform: NodeJS.Platform): Promise<string> {
  const dir = join(tmpdir(), `siteorigin-node-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    if (platform === 'win32') {
      // A batch file reads `%` as the start of a variable: one in the app's own path is doubled to stay itself.
      await fs.writeFile(join(dir, 'node.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath.replace(/%/g, '%%')}" %*\r\n`);
    } else {
      const quoted = `'${execPath.replace(/'/g, `'\\''`)}'`;
      await fs.writeFile(join(dir, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`, { mode: 0o755 });
    }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return dir;
}

/** End a run's whole tree of processes: its group on macOS and Linux, its tree through taskkill on Windows. */
function endTree(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals, spawn: NonNullable<ProjectTestOptions['spawn']>) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    try {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      // taskkill that could not end the tree ends the process itself at least.
      killer.on('error', () => child.kill());
      killer.on('exit', (code) => code !== 0 && child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already, or the process never led one: the process itself, then.
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

/** Run the project's `npm test` once, to its end, a stop (`signal`) or its deadline. Never rejects. */
export async function runProjectTests(opts: ProjectTestOptions): Promise<TestOutcome> {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? nodeSpawn;
  const updateMs = opts.updateMs ?? 100;
  const graceMs = opts.graceMs ?? 3000;
  if (opts.signal.aborted) return { status: 'cancelled', exitCode: null, summary: 'Stopped before the tests started.' };
  const tail = new LineTail(400, 2000, important, 30, 10);
  // Two streams share one view: a line one of them left unfinished is ended before the other's text follows it.
  let open: 'out' | 'err' | null = null;
  const take = (from: 'out' | 'err', chunk: Buffer) => {
    if (open && open !== from) tail.write('\n');
    tail.write(chunk);
    open = chunk[chunk.length - 1] === 0x0a ? null : from;
  };
  let shim: string;
  try {
    shim = await nodeShim(opts.execPath, platform);
  } catch (e) {
    return { status: 'not-started', exitCode: null, summary: `The tests could not be started: ${(e as Error).message}` };
  }
  // Stopped while that was being made: nothing is started.
  if (opts.signal.aborted) {
    await fs.rm(shim, { recursive: true, force: true }).catch(() => undefined);
    return { status: 'cancelled', exitCode: null, summary: 'Stopped before the tests started.' };
  }
  const pathKey = platform === 'win32' ? (Object.keys(opts.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH') : 'PATH';
  const env: Record<string, string> = {
    ...opts.env,
    [pathKey]: [shim, opts.env[pathKey]].filter(Boolean).join(platform === 'win32' ? ';' : ':'),
    ELECTRON_RUN_AS_NODE: '1',
    CI: '1',
    FORCE_COLOR: '0',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false'
    // The project's own npm settings (.npmrc, workspaces) are as much the project's as the tests the script runs:
    // they are taken as npm takes them, with the project the author trusted.
  };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sent = '';
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    const lines = tail.read();
    const key = lines.join('\n');
    if (key === sent) return;
    sent = key;
    opts.onOutput(lines);
  };
  const soon = () => {
    flushTimer ??= setTimeout(flush, updateMs);
  };
  try {
    return await new Promise<TestOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(opts.execPath, [opts.npmCli, 'test'], { cwd: opts.dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true });
      } catch (e) {
        resolve({ status: 'not-started', exitCode: null, summary: `The tests could not be started: ${(e as Error).message}` });
        return;
      }
      let ending: 'cancelled' | 'timed-out' | null = null;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      let settled = false;
      const later = (ms: number, fn: () => void) => void (settled || timers.push(setTimeout(fn, ms)));
      // How npm exited, once it has: its output may still be on its way.
      let exited: { code: number | null; sig: NodeJS.Signals | null } | null = null;
      const finish = (outcome: TestOutcome) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        opts.signal.removeEventListener('abort', onAbort);
        // Nothing it says from here on is the run's.
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        // Whatever the script left running in its group goes with it.
        if (platform !== 'win32') endTree(child, platform, 'SIGKILL', spawn);
        resolve(outcome);
      };
      /** How the run ended, once npm has: by its exit code, or by the stop that ended it. */
      const conclude = (code: number | null, sig: NodeJS.Signals | null) => {
        if (ending === 'cancelled') return finish({ status: 'cancelled', exitCode: code, summary: 'Stopped.' });
        if (ending === 'timed-out') return finish({ status: 'timed-out', exitCode: code, summary: `Stopped after ${Math.round(opts.timeoutMs / 60_000)} minutes: the tests were still running.` });
        if (code === 0) return finish({ status: 'passed', exitCode: 0, summary: 'The tests passed.' });
        finish({ status: 'failed', exitCode: code, summary: code === null ? `The tests stopped (${sig ?? 'signal'}).` : `The tests failed (exit code ${code}).` });
      };
      const stop = (why: 'cancelled' | 'timed-out') => {
        if (ending || settled) return;
        // npm had already ended (its output still draining): that is how the run ended.
        if (why === 'timed-out' && exited) return conclude(exited.code, exited.sig);
        ending = why;
        endTree(child, platform, 'SIGTERM', spawn);
        later(graceMs, () => {
          endTree(child, platform, 'SIGKILL', spawn);
          // Ended however it went: a run is never left running once it was stopped.
          later(graceMs, () => conclude(null, 'SIGKILL'));
        });
      };
      later(opts.timeoutMs, () => stop('timed-out'));
      const onAbort = () => stop('cancelled');
      opts.signal.addEventListener('abort', onAbort);
      child.stdout?.on('data', (d: Buffer) => (take('out', d), soon()));
      child.stderr?.on('data', (d: Buffer) => (take('err', d), soon()));
      child.on('error', (e) => finish({ status: 'not-started', exitCode: null, summary: `The tests could not be started: ${e.message}` }));
      // Once its output has all arrived; or a moment after npm exits, when something it started still holds its output.
      child.on('close', (code, sig) => conclude(code, sig));
      child.on('exit', (code, sig) => {
        exited = { code, sig };
        later(DRAIN_MS, () => conclude(code, sig));
      });
    });
  } finally {
    // The last of the output, said once, after which nothing more is told.
    flush();
    if (flushTimer) clearTimeout(flushTimer);
    await fs.rm(shim, { recursive: true, force: true }).catch(() => undefined);
  }
}
