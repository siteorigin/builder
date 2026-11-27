/**
 * Looking for the computer's own Git (#1152): a Git that answers is reported with its version, none is reported as
 * missing, and one that fails, hangs or prints something else as unusable. Looking runs nothing but `--version`, never
 * the macOS stand-in that would ask to install Apple's tools, and writes nothing.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSystemGit, gitCandidates, type Runner } from '../../src/main/git/system-git';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-system-git-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A program named git in its own folder: `body` is the shell script it runs, which records every call it gets. */
function fakeGit(name: string, body: string, opts: { executable?: boolean } = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'git');
  writeFileSync(file, `#!/bin/sh\necho "$@" >> "${join(root, 'calls.log')}"\n${body}\n`);
  chmodSync(file, opts.executable === false ? 0o644 : 0o755);
  return dir;
}

const env = (...dirs: string[]) => ({ PATH: dirs.join(':') });
const listing = () => readdirSync(root, { recursive: true }).map(String).sort();

describe.skipIf(process.platform === 'win32')('detectSystemGit', () => {
  it('reports the first Git on PATH that answers, with its version, and asks it nothing else', async () => {
    const first = fakeGit('first', 'echo "git version 2.47.1 (Apple Git-150)"');
    const second = fakeGit('second', 'echo "git version 2.30.0"');
    const before = listing();
    await expect(detectSystemGit({ env: env(first, second), extraDirs: [], platform: 'linux' })).resolves.toEqual({ status: 'present', path: join(first, 'git'), version: '2.47.1' });
    // Only the one found was run, once, and only to say its version; nothing else was written.
    expect(listing()).toEqual([...before, 'calls.log'].sort());
    expect(readFileSync(join(root, 'calls.log'), 'utf8')).toBe('--version\n');
  });

  it('reports a missing Git when there is none on PATH or in the usual places', async () => {
    mkdirSync(join(root, 'empty'));
    await expect(detectSystemGit({ env: env(join(root, 'empty')), extraDirs: [join(root, 'nowhere')], platform: 'linux' })).resolves.toEqual({ status: 'missing' });
    await expect(detectSystemGit({ env: {}, extraDirs: [], platform: 'linux' })).resolves.toEqual({ status: 'missing' });
  });

  it('passes over a file named git that cannot be run, and folders named git', async () => {
    const plain = fakeGit('plain', 'echo "git version 2.47.1"', { executable: false });
    mkdirSync(join(root, 'dir', 'git'), { recursive: true });
    await expect(detectSystemGit({ env: env(plain, join(root, 'dir')), extraDirs: [], platform: 'linux' })).resolves.toEqual({ status: 'missing' });
  });

  it('reports a git that fails, prints something else or hangs as unusable, and a working one later on PATH as present', async () => {
    const failing = fakeGit('failing', 'echo "error: no such thing" >&2; exit 3');
    const other = fakeGit('other', 'echo "this is not git"');
    const hanging = fakeGit('hanging', 'sleep 5');
    const working = fakeGit('working', 'echo "git version 2.43.0"');
    await expect(detectSystemGit({ env: env(failing), extraDirs: [], platform: 'linux' })).resolves.toEqual({ status: 'unusable', path: join(failing, 'git'), reason: 'failed' });
    await expect(detectSystemGit({ env: env(other), extraDirs: [], platform: 'linux' })).resolves.toEqual({ status: 'unusable', path: join(other, 'git'), reason: 'unrecognised' });
    const started = Date.now();
    await expect(detectSystemGit({ env: env(hanging), extraDirs: [], platform: 'linux', timeoutMs: 200 })).resolves.toEqual({ status: 'unusable', path: join(hanging, 'git'), reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(detectSystemGit({ env: env(failing, working), extraDirs: [], platform: 'linux' })).resolves.toEqual({ status: 'present', path: join(working, 'git'), version: '2.43.0' });
  });

  it('looks in the usual install folders after PATH, for an app opened with a short PATH', async () => {
    const usual = fakeGit('usual', 'echo "git version 2.44.0"');
    await expect(detectSystemGit({ env: env(join(root, 'empty')), extraDirs: [usual], platform: 'linux' })).resolves.toEqual({ status: 'present', path: join(usual, 'git'), version: '2.44.0' });
  });

  it('never runs the macOS stand-in: with Apple’s tools missing it is no Git, and with them it asks the real one', async () => {
    const shim = fakeGit('shim', `touch "${join(root, 'install-prompt')}"; echo "git version 9.9.9"`);
    const devDir = join(root, 'CommandLineTools');
    const real = fakeGit(join('CommandLineTools', 'usr', 'bin'), 'echo "git version 2.39.5 (Apple Git-154)"');
    const calls: string[] = [];
    const noTools: Runner = async (file, args) => (calls.push([file, ...args].join(' ')), { code: 2, stdout: '', timedOut: false });
    // The stand-in runs a real program for everything else, as the default runner does.
    await expect(detectSystemGit({ env: env(shim), extraDirs: [], platform: 'darwin', macShim: join(shim, 'git'), run: noTools })).resolves.toEqual({ status: 'missing' });
    expect(calls).toEqual(['/usr/bin/xcode-select -p']);
    const withTools: Runner = async (file, args, opts) => {
      calls.push([file, ...args].join(' '));
      if (file === '/usr/bin/xcode-select') return { code: 0, stdout: `${devDir}\n`, timedOut: false };
      const { execFileSync } = await import('node:child_process');
      return { code: 0, stdout: execFileSync(file, args, { env: opts.env, encoding: 'utf8' }), timedOut: false };
    };
    calls.length = 0;
    await expect(detectSystemGit({ env: env(shim), extraDirs: [], platform: 'darwin', macShim: join(shim, 'git'), run: withTools })).resolves.toEqual({ status: 'present', path: join(real, 'git'), version: '2.39.5' });
    expect(calls).toEqual(['/usr/bin/xcode-select -p', `${join(real, 'git')} --version`]);
    expect(readdirSync(root)).not.toContain('install-prompt');
  });

  it('gives Git no settings of the user’s and tells it never to prompt', async () => {
    const dir = fakeGit('env', 'echo "git version 2.47.1"');
    let seen: NodeJS.ProcessEnv = {};
    const run: Runner = async (_file, _args, opts) => ((seen = opts.env), { code: 0, stdout: 'git version 2.47.1\n', timedOut: false });
    await detectSystemGit({ env: { PATH: dir, HOME: '/home/someone', GIT_DIR: '/somewhere/.git', OPENAI_API_KEY: 'sk-secret' }, extraDirs: [], platform: 'linux', run });
    expect(seen).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
    expect(seen).not.toHaveProperty('HOME');
    expect(seen).not.toHaveProperty('GIT_DIR');
    expect(seen).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('gitCandidates', () => {
  it('on Windows, looks for git.exe on Path, then in Git for Windows’ install folders, each once', () => {
    const env = { Path: 'C:\\Tools;"C:\\Program Files\\Git\\cmd";relative\\dir;C:\\tools', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    expect(gitCandidates('win32', env, undefined)).toEqual([
      'C:\\Tools\\git.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Users\\a\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'
    ]);
  });

  it('on macOS, looks in Homebrew’s and MacPorts’ folders after PATH', () => {
    expect(gitCandidates('darwin', { PATH: '/usr/bin:/bin' }, undefined)).toEqual(['/usr/bin/git', '/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git']);
  });
});
