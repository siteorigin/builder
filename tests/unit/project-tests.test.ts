/**
 * A project's own `npm test`, as the code workspace runs it (#1483): through the app's npm on its own Node, which the
 * script's commands find as `node` on a PATH that has none of its own; with its output kept bounded and its secrets
 * masked; and stopped, with every process it started, at its deadline or when asked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { declaredTestScript, runProjectTests, type ProjectTestOptions } from '../../src/main/runtime/project-tests';

const npmCli = join(dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin', 'npm-cli.js');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project whose package.json's test script is `script`, and the scripts it runs. */
function project(script: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'so-project-tests-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'site', private: true, scripts: { test: script } }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** The environment the app gives project processes: no Node of the computer's own on the PATH. */
const env = () => ({ PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' });

function run(dir: string, over: Partial<ProjectTestOptions> = {}) {
  const updates: string[][] = [];
  const abort = new AbortController();
  const done = runProjectTests({ dir, npmCli, execPath: process.execPath, env: env(), onOutput: (l) => updates.push(l), signal: abort.signal, timeoutMs: 60_000, updateMs: 20, graceMs: 500, ...over });
  return { done, updates, abort, last: () => updates.at(-1) ?? [] };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('declaredTestScript', () => {
  it('reads the test script a package.json declares, and none for npm’s placeholder or a broken file', () => {
    expect(declaredTestScript(JSON.stringify({ scripts: { test: 'vitest run' } }))).toBe('vitest run');
    expect(declaredTestScript(JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))).toBeNull();
    expect(declaredTestScript(JSON.stringify({ scripts: { dev: 'vite dev' } }))).toBeNull();
    expect(declaredTestScript(JSON.stringify({ scripts: { test: '  ' } }))).toBeNull();
    expect(declaredTestScript('{ not json')).toBeNull();
    expect(declaredTestScript(null)).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('runProjectTests', { timeout: 60_000 }, () => {
  it('runs the script with Electron’s Node as `node`, and passes when it does', async () => {
    const dir = project('node check.mjs', { 'check.mjs': "console.log('endpoint returns 200');\n" });
    const r = run(dir);
    expect(await r.done).toEqual({ status: 'passed', exitCode: 0, summary: 'The tests passed.' });
    expect(r.last()).toContain('endpoint returns 200');
  });

  it('fails with the script’s own output and exit code, its secrets masked', async () => {
    const dir = project('node check.mjs', { 'check.mjs': "console.error('AssertionError: expected 404 to be 200');\nconsole.log('stdout marker');\nconsole.log('token=sk-live-abcdefghijklmnop');\nprocess.stdout.write('no line break at the end');\nprocess.exitCode = 3;\n" });
    const r = run(dir);
    const outcome = await r.done;
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 3 });
    const out = r.last().join('\n');
    expect(out).toContain('AssertionError: expected 404 to be 200');
    expect(out).toContain('stdout marker');
    expect(out).toContain('token=');
    expect(out).not.toContain('sk-live-abcdefghijklmnop');
    expect(r.last().at(-1)).toBe('no line break at the end');
  });

  it('ends when npm does, though something it started still holds its output', async () => {
    const dir = project('node linger.mjs', { 'linger.mjs': "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });\nwriteFileSync('child.pid', String(c.pid));\nconsole.log('done');\nprocess.exit(0);\n" });
    const started = Date.now();
    const r = run(dir, { timeoutMs: 30_000 });
    expect(await r.done).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });

  it('keeps a flood of output to its first failures and its end', async () => {
    const dir = project('node flood.mjs', { 'flood.mjs': "console.log('FAIL first.test.js');\nfor (let i = 0; i < 20000; i++) console.log('progress ' + i);\nconsole.log('the end');\n" });
    const r = run(dir);
    await r.done;
    const out = r.last();
    expect(out.length).toBeLessThan(500);
    expect(out).toContain('FAIL first.test.js');
    expect(out.at(-1)).toBe('the end');
    expect(out.some((l) => /lines? omitted/.test(l))).toBe(true);
  });

  it('stops at its deadline, with every process it started', async () => {
    const dir = project('node hang.mjs', {
      'hang.mjs': "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nwriteFileSync('child.pid', String(child.pid));\nconsole.log('waiting');\nsetInterval(() => {}, 1000);\n"
    });
    const r = run(dir, { timeoutMs: 2500 });
    const outcome = await r.done;
    expect(outcome.status).toBe('timed-out');
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    // Signals are delivered at once, but a process takes a moment to go.
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });

  it('starts nothing when stopped before or while it is being set up', async () => {
    const dir = project('node -e "1"');
    let spawned = 0;
    const spawn = (() => {
      spawned++;
      throw new Error('started');
    }) as unknown as ProjectTestOptions['spawn'];
    const before = new AbortController();
    before.abort();
    expect(await runProjectTests({ dir, npmCli, execPath: process.execPath, env: env(), onOutput: () => undefined, signal: before.signal, timeoutMs: 1000, spawn })).toMatchObject({ status: 'cancelled' });
    // Stopped once it has begun, while the Node it gives the script is still being made.
    const during = new AbortController();
    const done = runProjectTests({ dir, npmCli, execPath: process.execPath, env: env(), onOutput: () => undefined, signal: during.signal, timeoutMs: 1000, spawn });
    during.abort();
    expect(await done).toMatchObject({ status: 'cancelled' });
    expect(spawned).toBe(0);
  });

  it('stops when asked, and starts nothing once asked before it began', async () => {
    const dir = project('node hang.mjs', { 'hang.mjs': "console.log('started');\nsetInterval(() => {}, 1000);\n" });
    const r = run(dir);
    // Once it has said something, it is running.
    for (let i = 0; i < 200 && !r.last().includes('started'); i++) await new Promise((res) => setTimeout(res, 50));
    r.abort.abort();
    expect(await r.done).toMatchObject({ status: 'cancelled' });
    const early = new AbortController();
    early.abort();
    expect(await runProjectTests({ dir, npmCli, execPath: process.execPath, env: env(), onOutput: () => undefined, signal: early.signal, timeoutMs: 1000 })).toMatchObject({ status: 'cancelled' });
  });

  it('leaves no Node of its own behind', async () => {
    const dir = project('node path.mjs', { 'path.mjs': "for (const p of process.env.PATH.split(':')) console.log(p);\n" });
    const r = run(dir);
    await r.done;
    const shim = r.last().find((l) => l.includes('siteorigin-node-'));
    expect(shim).toBeTruthy();
    expect(existsSync(shim!)).toBe(false);
  });
});

describe('runProjectTests on Windows', () => {
  it('gives the script a node.cmd on its own Path, and ends the whole tree with taskkill', async () => {
    const dir = project('vitest run');
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    let shim = '';
    const { EventEmitter } = await import('node:events');
    let killed = 0;
    const npm = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => (killed++, true) });
    const spawn = ((command: string, args: string[], o: { env?: Record<string, string> }) => {
      calls.push({ command, args, env: o.env });
      if (command.endsWith('taskkill.exe')) {
        const killer = new EventEmitter();
        // taskkill could not end the tree: npm itself is ended at least.
        queueMicrotask(() => (killer.emit('exit', 128), npm.emit('exit', 1, null), npm.emit('close', 1, null)));
        return killer;
      }
      shim = (o.env?.Path ?? '').split(';')[0];
      return npm;
    }) as unknown as ProjectTestOptions['spawn'];
    const abort = new AbortController();
    const done = runProjectTests({ dir, npmCli: 'C:\\app\\npm-cli.js', execPath: 'C:\\Program Files\\100% Builder\\Builder.exe', env: { Path: 'C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, onOutput: () => undefined, signal: abort.signal, timeoutMs: 60_000, platform: 'win32', spawn });
    for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]).toMatchObject({ command: 'C:\\Program Files\\100% Builder\\Builder.exe', args: ['C:\\app\\npm-cli.js', 'test'] });
    expect(calls[0].env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(calls[0].env?.PATH).toBeUndefined();
    expect(readFileSync(join(shim, 'node.cmd'), 'utf8')).toBe('@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\100%% Builder\\Builder.exe" %*\r\n');
    abort.abort();
    expect(await done).toMatchObject({ status: 'cancelled' });
    expect(calls[1]).toMatchObject({ args: ['/pid', '4242', '/T', '/F'] });
    expect(calls[1].command).toMatch(/taskkill\.exe$/);
    expect(killed).toBe(1);
    expect(existsSync(shim)).toBe(false);
  });
});
