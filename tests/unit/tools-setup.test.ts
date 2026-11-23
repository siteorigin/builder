/**
 * Setting up a project's website tools says whether it downloads before it does, using the same check as the New
 * project dialog: offline when the caches hold everything (so it cannot download), straight to a download otherwise.
 * Covers a development build (no shipped tools) and a packaged one (a cache shipped with the app).
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** npm, as far as setup can tell: each run is recorded, and ends as the test says (exit 0 unless given). */
const npm = vi.hoisted(() => ({ runs: [] as string[][], results: [] as Array<{ code: number; stderr?: string }> }));
vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_cmd: string, args: string[]) => {
      npm.runs.push(args);
      const result = npm.results.shift() ?? { code: 0 };
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
      setTimeout(() => {
        if (result.stderr) child.stderr.emit('data', result.stderr);
        child.emit('exit', result.code);
      }, 0);
      return child;
    }
  };
});

const { prepareDependencies, starterTools } = await import('../../src/main/runtime/manager');
const { ToolsDownloadError, contentPaths, lockedPackages } = await import('../../src/main/runtime/availability');

const require = createRequire(import.meta.url);
const npmDir = dirname(require.resolve('npm/package.json'));
const starter = join(__dirname, '../../templates/sveltekit-brochure/files');

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
});
afterEach(() => {
  npm.runs.splice(0);
  npm.results.splice(0);
  rmSync(root, { recursive: true, force: true });
});

/** Every package this computer installs, put in the npm cache at `cache` (as `npm ci --cache` leaves it). */
const fill = async (cache: string) => {
  const paths = (await lockedPackages(npmDir, starter)).map((p) => contentPaths(cache, p.integrity!)[0]);
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'tarball');
  }
  return paths;
};
const userCache = () => join(env.userData, 'npm-cache');
const install = (signal?: AbortSignal) => {
  const lines: string[] = [];
  return { lines, done: prepareDependencies(project, (l) => lines.push(l), signal) };
};
const mode = (args: string[]) => args.find((a) => a === '--offline' || a === '--prefer-offline');

describe('a development build, with no tools shipped', () => {
  it('says a download is needed before Create, and setup says so first and downloads once, without an offline attempt', async () => {
    expect(await starterTools(starter)).toBe('download');
    const { lines, done } = install();
    await done;
    expect(npm.runs.map(mode)).toEqual(['--prefer-offline']);
    expect(lines[0]).toMatch(/^Downloading the website tools/);
    expect(existsSync(join(project, '.siteorigin', 'cache', 'deps.json'))).toBe(true);
  });

  it('installs offline, and says nothing was downloaded, once an earlier download left everything in the cache', async () => {
    await fill(userCache());
    expect(await starterTools(starter)).toBe('local');
    const { lines, done } = install();
    await done;
    expect(npm.runs.map(mode)).toEqual(['--offline']);
    expect(lines.join('\n')).toMatch(/Nothing was downloaded/);
    expect(lines.join('\n')).not.toMatch(/[Dd]ownloading/);
  });

  it('downloads a copy the cache could not supply once, saying why', async () => {
    await fill(userCache());
    npm.results.push({ code: 1, stderr: 'npm error code EINTEGRITY\nnpm error sha512 integrity checksum failed\n' });
    const { lines, done } = install();
    await done;
    expect(npm.runs.map(mode)).toEqual(['--offline', '--prefer-offline']);
    expect(lines.join('\n')).toMatch(/could not be used, so it is being downloaded again/);
  });

  it('does not go online for a failure a download cannot fix', async () => {
    await fill(userCache());
    npm.results.push({ code: 1, stderr: 'npm error code ENOSPC\nnpm error nospc no space left on device\n' });
    await expect(install().done).rejects.toThrow(/ENOSPC/);
    expect(npm.runs.map(mode)).toEqual(['--offline']);
  });

  it('reports a registry it could not reach as a failed download', async () => {
    npm.results.push({ code: 1, stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/x failed\n' });
    const error = await install().done.catch((e) => e);
    expect(error).toBeInstanceOf(ToolsDownloadError);
    expect(error.code).toBe('ENOTFOUND');
    expect(existsSync(join(project, '.siteorigin', 'cache', 'deps.json'))).toBe(false);
  });

  it('cannot promise anything without a lock, and says a download may happen', async () => {
    unlinkSync(join(project, 'package-lock.json'));
    expect(await starterTools(project)).toBe('unknown');
    const { lines, done } = install();
    await done;
    expect(npm.runs).toHaveLength(1);
    expect(npm.runs[0]).toContain('install');
    expect(lines[0]).toMatch(/may need to be downloaded/);
  });

  it('runs nothing when cancelled while it checks', async () => {
    const abort = new AbortController();
    const { done } = install(abort.signal);
    abort.abort();
    await expect(done).rejects.toThrow('Cancelled');
    expect(npm.runs).toEqual([]);
  });
});

describe('a packaged build, with a cache shipped for this platform', () => {
  beforeEach(() => {
    env.packaged = true;
    const resources = join(root, 'Resources');
    mkdirSync(resources);
    symlinkSync(npmDir, join(resources, 'npm'), 'dir');
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true });
  });

  it('counts the shipped cache before Create, and installs offline from the user cache it seeds', async () => {
    await fill(join(process.resourcesPath, 'npm-cache'));
    expect(await starterTools(starter)).toBe('local');
    const { lines, done } = install();
    await done;
    expect(npm.runs.map(mode)).toEqual(['--offline']);
    expect(npm.runs[0]).toContain(`--cache=${userCache()}`);
    expect(lines.join('\n')).toMatch(/Nothing was downloaded/);
  });

  it('puts back a file the seeded user cache lost before installing offline', async () => {
    await fill(join(process.resourcesPath, 'npm-cache'));
    await install().done;
    const lost = (await fill(join(root, 'scratch'))).map((p) => p.replace(join(root, 'scratch'), userCache()))[0];
    unlinkSync(lost);
    expect(readFileSync(join(userCache(), '.siteorigin-seeded'), 'utf8')).toBe('1.0.0');
    await install().done;
    expect(existsSync(lost)).toBe(true);
    expect(npm.runs.map(mode)).toEqual(['--offline', '--offline']);
  });
});
