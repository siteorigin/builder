/**
 * Setting up a project's website tools says whether it downloads before it does, using the same check as the New
 * project dialog: offline when the caches hold everything (so it cannot download), straight to a download otherwise.
 * Covers a development build (no shipped tools) and a packaged one (a cache shipped with the app).
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ packaged: false, userData: '' }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return env.packaged;
    },
    getPath: () => env.userData,
    getVersion: () => '1.0.0'
  },
  utilityProcess: {}
}));

/**
 * npm, as far as setup can tell. Each run is recorded in `trace` beside setup's own progress lines, and ends as the
 * test says (exit 0 unless given). A run that succeeds puts the packages it was asked for into the project, except
 * those in `skip` (npm leaves out an optional package it could not fetch, and still succeeds).
 */
const npm = vi.hoisted(() => ({
  runs: [] as string[][],
  trace: [] as string[],
  results: [] as Array<{ code: number; stderr?: string }>,
  skip: [] as string[],
  install: null as null | ((dir: string) => void),
  atSpawn: null as null | ((args: string[]) => void)
}));
vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_cmd: string, args: string[], opts: { cwd: string }) => {
      npm.runs.push(args);
      npm.trace.push(`npm ${args.find((a) => a === '--offline' || a === '--prefer-offline')}`);
      npm.atSpawn?.(args);
      const result = npm.results.shift() ?? { code: 0 };
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      setTimeout(() => {
        if (result.code === 0) npm.install?.(opts.cwd);
        // The process ends before the last of its output has been read, as a real one can.
        child.emit('exit', result.code);
        if (result.stderr) child.stderr.emit('data', result.stderr);
        child.emit('close', result.code);
      }, 0);
      return child;
    }
  };
});

const { prepareDependencies, starterTools } = await import('../../src/main/runtime/manager');
const { ToolsDownloadError, lockedPackages } = await import('../../src/main/runtime/availability');

const require = createRequire(import.meta.url);
const npmDir = dirname(require.resolve('npm/package.json'));
/** npm's own cache layout, so the fixtures do not lean on the code under test. */
const cacachePath: (cache: string, integrity: string) => string = require(join(npmDir, 'node_modules', 'cacache', 'lib', 'content', 'path.js'));
const starter = join(__dirname, '../../templates/sveltekit-brochure/files');
/** The native build tool this computer needs: optional in the lock, and what a skipped fetch leaves out. */
const binding = `node_modules/@rolldown/binding-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;

let needed: Array<{ location: string; integrity?: string; native?: boolean }> = [];
beforeAll(async () => {
  needed = await lockedPackages(npmDir, starter);
});

let root = '';
let project = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-tools-setup-'));
  env.userData = join(root, 'userData');
  env.packaged = false;
  mkdirSync(env.userData);
  project = join(root, 'meadow-studio');
  mkdirSync(project);
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(starter, f), join(project, f));
  npm.install = (dir) => {
    for (const p of needed) if (!npm.skip.includes(p.location)) {
      mkdirSync(join(dir, p.location), { recursive: true });
      writeFileSync(join(dir, p.location, 'package.json'), '{}');
    }
  };
});
afterEach(() => {
  npm.runs.splice(0);
  npm.trace.splice(0);
  npm.results.splice(0);
  npm.skip.splice(0);
  npm.atSpawn = null;
  rmSync(root, { recursive: true, force: true });
});

/** Every package this computer installs, put in the npm cache at `cache` (as `npm ci --cache` leaves it). */
const fill = (cache: string) =>
  needed.map((p) => {
    const path = cacachePath(join(cache, '_cacache'), p.integrity!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'tarball');
    return path;
  });
const userCache = () => join(env.userData, 'npm-cache');
const marker = () => join(project, '.siteorigin', 'cache', 'deps.json');
const install = (signal?: AbortSignal) => prepareDependencies(project, (l) => npm.trace.push(l), signal);
const modes = () => npm.runs.map((args) => args.filter((a) => a === '--offline' || a === '--prefer-offline'));

describe('a development build, with no tools shipped', () => {
  it('says a download is needed before Create, and setup says so first and downloads once, without an offline attempt', async () => {
    expect(await starterTools(starter)).toBe('download');
    await install();
    expect(modes()).toEqual([['--prefer-offline']]);
    expect(npm.trace[0]).toMatch(/^Downloading the website tools/);
    expect(npm.trace[1]).toBe('npm --prefer-offline');
    // The platform and packages npm installs are the ones the check counted, whatever the author's npm settings say.
    expect(npm.runs[0]).toEqual(
      expect.arrayContaining(['ci', `--cache=${userCache()}`, `--os=${process.platform}`, `--cpu=${process.arch}`, '--include=dev', '--include=optional', '--include=peer', '--install-strategy=hoisted', '--color=false', '--heading=npm'])
    );
    expect(existsSync(marker())).toBe(true);
  });

  it('installs offline, and says nothing was downloaded, once an earlier download left everything in the cache', async () => {
    fill(userCache());
    expect(await starterTools(starter)).toBe('local');
    await install();
    expect(modes()).toEqual([['--offline']]);
    expect(npm.runs[0]).toContain(`--cache=${userCache()}`);
    expect(npm.trace.at(-1)).toMatch(/Nothing was downloaded/);
    expect(npm.trace.join('\n')).not.toMatch(/[Dd]ownload(ing|ed again)/);
  });

  for (const code of ['EINTEGRITY', 'ENOTCACHED']) {
    it(`downloads once, saying why, a copy the cache could not supply (${code})`, async () => {
      fill(userCache());
      npm.results.push({ code: 1, stderr: `npm error code ${code}\nnpm error the cached copy could not be used\n` });
      await install();
      expect(modes()).toEqual([['--offline'], ['--prefer-offline']]);
      const explained = npm.trace.indexOf('A saved copy of the website tools could not be used, so it is being downloaded again…');
      expect(explained).toBeGreaterThan(npm.trace.indexOf('npm --offline'));
      expect(explained).toBeLessThan(npm.trace.indexOf('npm --prefer-offline'));
      expect(existsSync(marker())).toBe(true);
    });
  }

  it('downloads the native tool an offline install left out without failing', async () => {
    expect(needed.map((p) => p.location)).toContain(binding);
    fill(userCache());
    npm.skip.push(binding);
    npm.results.push({ code: 0 });
    // The second run (the download) puts it in place.
    npm.atSpawn = (args) => args.includes('--prefer-offline') && npm.skip.splice(0);
    await install();
    expect(modes()).toEqual([['--offline'], ['--prefer-offline']]);
    expect(existsSync(join(project, binding, 'package.json'))).toBe(true);
  });

  it('does not go online for a failure a download cannot fix', async () => {
    fill(userCache());
    npm.results.push({ code: 1, stderr: 'npm error code ENOSPC\nnpm error nospc no space left on device\n' });
    const error = await install().catch((e) => e);
    expect(error).not.toBeInstanceOf(ToolsDownloadError);
    expect(error.message).toMatch(/ENOSPC/);
    expect(modes()).toEqual([['--offline']]);
  });

  for (const code of ['ENOTFOUND', 'EIDLETIMEOUT']) {
    it(`reports a registry it could not reach as a failed download (${code})`, async () => {
      npm.results.push({ code: 1, stderr: `npm error code ${code}\nnpm error request to https://registry.npmjs.org/x failed\n` });
      const error = await install().catch((e) => e);
      expect(error).toBeInstanceOf(ToolsDownloadError);
      expect(error.code).toBe(code);
      expect(existsSync(marker())).toBe(false);
    });
  }

  it('reports a native tool the download could not fetch as a failed download, so Try again installs it later', async () => {
    npm.skip.push(binding);
    const error = await install().catch((e) => e);
    expect(error).toBeInstanceOf(ToolsDownloadError);
    expect(error.code).toBe('EMISSING');
    expect(error.message).toContain(binding.replace('node_modules/', ''));
    // No marker: the next preview start installs again.
    expect(existsSync(marker())).toBe(false);
  });

  it('leaves it to npm whether an optional package that is not a native tool is needed', async () => {
    const plain = needed.find((p) => !p.native)!;
    npm.skip.push(plain.location);
    await install();
    expect(existsSync(marker())).toBe(true);
  });

  it('keeps a download that failed for another reason a plain failure', async () => {
    npm.results.push({ code: 1, stderr: 'npm error code ENOSPC\nnpm error nospc no space left on device\n' });
    const error = await install().catch((e) => e);
    expect(error).not.toBeInstanceOf(ToolsDownloadError);
    expect(error.message).toMatch(/ENOSPC/);
  });

  it('cannot promise anything without a lock, and says a download may happen', async () => {
    unlinkSync(join(project, 'package-lock.json'));
    expect(await starterTools(project)).toBe('unknown');
    await install();
    expect(modes()).toEqual([['--prefer-offline']]);
    expect(npm.runs[0]).toContain('install');
    expect(npm.trace[0]).toMatch(/may need to be downloaded/);
  });

  it('runs nothing when cancelled while it checks', async () => {
    const abort = new AbortController();
    const done = install(abort.signal);
    abort.abort();
    await expect(done).rejects.toThrow('Cancelled');
    expect(npm.runs).toEqual([]);
  });
});

describe('a packaged build, with a cache shipped for this platform', () => {
  let resources = '';
  beforeEach(() => {
    env.packaged = true;
    resources = join(root, 'Resources');
    mkdirSync(resources);
    symlinkSync(npmDir, join(resources, 'npm'), 'dir');
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true });
  });

  it('counts the shipped cache before Create, and installs offline with the shipped npm from the user cache it seeds', async () => {
    fill(join(resources, 'npm-cache'));
    expect(await starterTools(starter)).toBe('local');
    await install();
    expect(modes()).toEqual([['--offline']]);
    expect(npm.runs[0][0]).toBe(join(resources, 'npm', 'bin', 'npm-cli.js'));
    expect(npm.runs[0]).toContain(`--cache=${userCache()}`);
    expect(npm.trace.at(-1)).toMatch(/Nothing was downloaded/);
  });

  it('puts back a file the seeded user cache lost before installing offline', async () => {
    fill(join(resources, 'npm-cache'));
    await install();
    const lost = cacachePath(join(userCache(), '_cacache'), needed[0].integrity!);
    unlinkSync(lost);
    expect(readFileSync(join(userCache(), '.siteorigin-seeded'), 'utf8')).toBe('1.0.0');
    const atRun: boolean[] = [];
    npm.atSpawn = () => atRun.push(existsSync(lost));
    await install();
    expect(atRun).toEqual([true]);
    expect(modes()).toEqual([['--offline'], ['--offline']]);
  });
});
