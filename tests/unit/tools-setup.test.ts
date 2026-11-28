/**
 * Setting up a project's website tools says whether it downloads before it does, using the same check as the New
 * project dialog: offline when the caches hold everything (so it cannot download), straight to a download otherwise.
 * Covers a development build (no shipped tools) and a packaged one (a cache shipped with the app).
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
/** A stand-in for the process that loads native modules: what it was told, whether it was killed, whether it ended. */
const warmProcess = vi.hoisted(() => () => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const record = { messages: [] as Array<{ root: string; files?: string[] }>, killed: false, exited: false };
  const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { kill(): boolean; stdin: unknown };
  const exit = () => setTimeout(() => {
    if (record.exited) return;
    record.exited = true;
    child.emit('exit', 0);
  }, 20);
  child.kill = () => {
    record.killed = true;
    exit();
    return true;
  };
  child.stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) record.messages.push(JSON.parse(line));
      return true;
    },
    end: exit
  });
  return { child, record };
});

const npm = vi.hoisted(() => ({
  runs: [] as string[][],
  cwds: [] as string[],
  warmers: [] as Array<{ messages: Array<{ root: string; files?: string[] }>; killed: boolean; exited: boolean }>,
  trace: [] as string[],
  results: [] as Array<{ code: number; stderr?: string }>,
  skip: [] as string[],
  install: null as null | ((dir: string) => void),
  atSpawn: null as null | ((args: string[]) => void),
  /** Holds the next run open until it settles: npm part way through, until it ends or is killed. */
  hold: null as null | Promise<void>
}));
vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_cmd: string, args: string[], opts: { cwd: string }) => {
      // The process that loads a new project's native modules once (macOS): it reads what to load, line by line, and
      // ends when its input does, or a moment after it is killed.
      if (args[0] === '-e') {
        const warm: ReturnType<typeof warmProcess> = warmProcess();
        npm.warmers.push(warm.record);
        return warm.child;
      }
      npm.runs.push(args);
      npm.cwds.push(opts.cwd);
      npm.trace.push(`npm ${args.find((a) => a === '--offline' || a === '--prefer-offline')}`);
      npm.atSpawn?.(args);
      const result = npm.results.shift() ?? { code: 0 };
      const held = npm.hold;
      npm.hold = null;
      let ended = false;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        // Killed, it ends without finishing.
        kill: () => {
          if (!ended) setTimeout(() => (ended = true) && (child.emit('exit', null), child.emit('close', null)), 0);
          return true;
        }
      });
      void (held ?? Promise.resolve()).then(() =>
        setTimeout(() => {
          if (ended) return;
          ended = true;
          if (result.code === 0) npm.install?.(opts.cwd);
          // The process ends before the last of its output has been read, as a real one can.
          child.emit('exit', result.code);
          if (result.stderr) child.stderr.emit('data', result.stderr);
          child.emit('close', result.code);
        }, 0)
      );
      return child;
    }
  };
});

const { dependenciesReady, prepareDependencies, stageDependencies, starterTools } = await import('../../src/main/runtime/manager');
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
  npm.install = installer(needed);
});
/** npm installing `packages` into a folder, as far as setup can tell. */
const installer = (packages: typeof needed) => (dir: string) => {
  for (const p of packages) if (!npm.skip.includes(p.location)) {
    mkdirSync(join(dir, p.location), { recursive: true });
    writeFileSync(join(dir, p.location, 'package.json'), '{}');
    if (p.native) writeFileSync(join(dir, p.location, 'binding.node'), 'native code');
    if (p.location === 'node_modules/svelte') {
      // A native module in a package npm does not count as a native tool (as fsevents, made only for macOS, is not).
      mkdirSync(join(dir, p.location, 'build', 'Release'), { recursive: true });
      writeFileSync(join(dir, p.location, 'build', 'Release', 'watcher.node'), 'native code');
    }
  }
};
afterEach(() => {
  vi.restoreAllMocks();
  npm.runs.splice(0);
  npm.cwds.splice(0);
  npm.warmers.splice(0);
  npm.trace.splice(0);
  npm.results.splice(0);
  npm.skip.splice(0);
  npm.atSpawn = null;
  npm.hold = null;
  rmSync(root, { recursive: true, force: true });
});

/** Every package this computer installs, put in the npm cache at `cache` (as `npm ci --cache` leaves it). */
const fill = (cache: string, packages = needed) =>
  packages.map((p) => {
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
    // The C library too, on Linux, where the author's npm settings could name another.
    if (process.platform !== 'linux') expect(npm.runs[0].some((a) => a.startsWith('--libc'))).toBe(false);
    else expect(npm.runs[0].some((a) => /^--libc=(glibc|musl)$/.test(a))).toBe(true);
    expect(existsSync(marker())).toBe(true);
  });

  it('never marks package files changed while npm ran as set up (#1480)', async () => {
    // The lock is installed as it was when npm began: package.json edited meanwhile is not what the tools are for.
    const install0 = npm.install!;
    npm.install = (dir) => {
      install0(dir);
      writeFileSync(join(dir, 'package.json'), readFileSync(join(dir, 'package.json'), 'utf8').replace('"private": true', '"private": true, "dependencies": { "zod": "4.1.0" }'));
    };
    await install();
    expect(existsSync(marker())).toBe(false);
    expect(await dependenciesReady(project)).toBe(false);
    // Unchanged, they are set up.
    npm.install = install0;
    await install();
    expect(await dependenciesReady(project)).toBe(true);
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

  for (const code of ['ENOTFOUND', 'EIDLETIMEOUT', 'FETCH_ERROR']) {
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

  it.runIf(process.platform === 'darwin')('does not hold the tools up for macOS’s optional file watcher, which they work without', async () => {
    npm.skip.push('node_modules/fsevents');
    await install();
    expect(existsSync(marker())).toBe(true);
  });

  it('leaves tools an install stopped part way through never marked as set up, even ones that were set up before (#1395)', async () => {
    await install();
    expect(await dependenciesReady(project)).toBe(true);
    // Installed again (the tools changed since, say), npm fails part way, leaving what it had installed.
    npm.results.push({ code: 1, stderr: 'npm error code ENOSPC\nnpm error nospc no space left on device\n' });
    await expect(install()).rejects.toThrow(/ENOSPC/);
    expect(existsSync(marker())).toBe(false);
    expect(await dependenciesReady(project)).toBe(false);
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
    await expect(done).rejects.toThrow('Canceled');
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

describe('a new project’s tools, installed beside it while it is made', () => {
  const platform = process.platform;
  const stages = () => join(env.userData, 'tools-staging');
  const left = () => (existsSync(stages()) ? readdirSync(stages()) : []);
  /** The project's checks of its lock, as its session makes them: `mine` says whether this app still owns it. */
  const owner = (mine: () => boolean = () => true) => {
    const o = {
      claims: 0,
      mayWrite: async () => mine(),
      whileOwner: async (fn: () => Promise<unknown>) => {
        o.claims++;
        if (!mine()) return false;
        await fn();
        return true;
      }
    };
    return o;
  };
  /** The package files as the app wrote them into the project. */
  const written = () => ({ 'package.json': readFileSync(join(project, 'package.json'), 'utf8'), 'package-lock.json': readFileSync(join(project, 'package-lock.json'), 'utf8') });
  const stage = (signal?: AbortSignal) => stageDependencies(project, written(), signal);
  const lockHash = () => createHash('sha256').update(readFileSync(join(project, 'package-lock.json'), 'utf8') + readFileSync(join(project, 'package.json'), 'utf8')).digest('hex');
  /** Until npm has run in the stage, and the stage holds what it installed. */
  const installed = () => vi.waitFor(() => expect(npm.runs.length > 0 && existsSync(join(npm.cwds[0], needed[0].location, 'package.json'))).toBe(true));
  beforeEach(() => fill(userCache()));

  it('runs npm outside the project, in a folder of its name, and moves what it installed in, marked set up, once adopted', async () => {
    const before = written();
    const staged = stage();
    await installed();
    expect(npm.cwds[0]).not.toBe(project);
    expect(npm.cwds[0].startsWith(stages())).toBe(true);
    expect(basename(npm.cwds[0])).toBe(basename(project));
    // npm installs from the package files the app wrote, not from what the project folder holds by then.
    expect(readFileSync(join(npm.cwds[0], 'package-lock.json'), 'utf8')).toBe(before['package-lock.json']);
    // Nothing is in the project until it is adopted, when the project is this app's for certain.
    expect(readdirSync(project).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(await dependenciesReady(project)).toBe(false);
    const lines: string[] = [];
    const mine = owner();
    await staged.adopt((l) => lines.push(l), mine);
    for (const p of needed) expect(existsSync(join(project, p.location, 'package.json'))).toBe(true);
    expect(JSON.parse(readFileSync(marker(), 'utf8')).lockHash).toBe(lockHash());
    expect(await dependenciesReady(project)).toBe(true);
    expect(written()).toEqual(before);
    // Moved in under one claim on the lock; npm ran once, and what it said before the dialog reached this step is told then.
    expect(mine.claims).toBe(1);
    expect(npm.runs).toHaveLength(1);
    expect(lines).toEqual(['Setting up the website tools from copies on this computer…', 'Installed the website tools from this computer. Nothing was downloaded.']);
    expect(left()).toEqual([]);
  });

  it('moves nothing in, and leaves nothing beside it, when the project is no longer this app’s', async () => {
    const staged = stage();
    await installed();
    await expect(staged.adopt(() => undefined, owner(() => false))).rejects.toThrow('Canceled');
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(existsSync(marker())).toBe(false);
    expect(left()).toEqual([]);
  });

  it('installs in the project instead when its package files changed after the install began, and marks that install', async () => {
    const staged = stage();
    await installed();
    const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ ...lock, name: 'renamed-meanwhile' }, null, 2));
    await staged.adopt(() => undefined, owner());
    expect(npm.cwds).toEqual([npm.cwds[0], project]);
    expect(JSON.parse(readFileSync(marker(), 'utf8')).lockHash).toBe(lockHash());
    expect(left()).toEqual([]);
  });

  it('installs in the project instead when the project has npm settings of its own by then', async () => {
    const staged = stage();
    await installed();
    writeFileSync(join(project, '.npmrc'), 'bin-links=false\n');
    await staged.adopt(() => undefined, owner());
    expect(npm.cwds).toEqual([npm.cwds[0], project]);
    expect(existsSync(marker())).toBe(true);
  });

  it('installs in the project instead when something is already where its node_modules go', async () => {
    const staged = stage();
    await installed();
    mkdirSync(join(project, 'node_modules', 'left-here'), { recursive: true });
    await staged.adopt(() => undefined, owner());
    expect(npm.cwds.at(-1)).toBe(project);
    expect(existsSync(marker())).toBe(true);
    expect(left()).toEqual([]);
  });

  it('installs in the project when no folder of its own can be made for the install', async () => {
    mkdirSync(env.userData, { recursive: true });
    writeFileSync(stages(), 'not a folder');
    await stage().adopt(() => undefined, owner());
    expect(npm.cwds).toEqual([project]);
    expect(existsSync(marker())).toBe(true);
  });

  it('leaves a folder already where its own would go, and installs in the project', async () => {
    const mkdir = fsp.mkdir.bind(fsp);
    let theirs = '';
    vi.spyOn(fsp, 'mkdir').mockImplementation(async (path, opts) => {
      if (!theirs && /tools-\d+-[0-9a-f]{12}$/.test(String(path))) {
        theirs = String(path);
        await mkdir(join(theirs, 'kept'), { recursive: true });
        throw Object.assign(new Error('EEXIST: file already exists, mkdir'), { code: 'EEXIST' });
      }
      return mkdir(path, opts);
    });
    await stage().adopt(() => undefined, owner());
    expect(npm.cwds).toEqual([project]);
    expect(existsSync(join(theirs, 'kept'))).toBe(true);
  });

  it('never installs, or clears anything, through a link where its folder goes', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'tools-999999-0123456789ab'), { recursive: true });
    writeFileSync(join(elsewhere, 'tools-999999-0123456789ab', '.siteorigin-tools-stage'), '{}');
    symlinkSync(elsewhere, stages(), 'dir');
    await stage().adopt(() => undefined, owner());
    expect(npm.cwds).toEqual([project]);
    expect(readdirSync(elsewhere)).toEqual(['tools-999999-0123456789ab']);
  });

  it('tries a move the system refuses for a moment again, each time under a claim of its own and checked again (Windows)', async () => {
    const rename = fsp.rename.bind(fsp);
    let refusals = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('node_modules') && refusals++ < 2) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      return rename(from, to);
    });
    const mine = owner();
    await stage().adopt(() => undefined, mine);
    expect(refusals).toBe(3);
    expect(mine.claims).toBe(3);
    expect(npm.cwds).toHaveLength(1);
    expect(existsSync(join(project, needed[0].location, 'package.json'))).toBe(true);
  });

  it('moves nothing when the project stops being this app’s between two refused moves', async () => {
    vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    });
    let claims = 0;
    const mine = owner(() => ++claims < 2);
    await expect(stage().adopt(() => undefined, mine)).rejects.toThrow('Canceled');
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it('installs in the project when it cannot be moved in at all', async () => {
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('node_modules')) throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
      return rename(from, to);
    });
    await stage().adopt(() => undefined, owner());
    expect(npm.cwds.at(-1)).toBe(project);
    expect(existsSync(marker())).toBe(true);
    expect(left()).toEqual([]);
  });

  it('stops before npm runs and removes its folder when discarded, writing nothing into the project', async () => {
    await stage().discard();
    expect(npm.runs).toEqual([]);
    expect(readdirSync(project).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(left()).toEqual([]);
  });

  it('stops when the creation is cancelled, and says so when adopted', async () => {
    const abort = new AbortController();
    const staged = stage(abort.signal);
    abort.abort();
    await expect(staged.adopt(() => undefined, owner())).rejects.toThrow('Canceled');
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(left()).toEqual([]);
  });

  it('reports a download that failed as it would in the project, and leaves the project without tools to try again', async () => {
    rmSync(userCache(), { recursive: true, force: true });
    npm.results.push({ code: 1, stderr: 'npm error code ENOTFOUND\nnpm error network request failed\n' });
    const error = await stage().adopt(() => undefined, owner()).catch((e) => e);
    expect(error).toBeInstanceOf(ToolsDownloadError);
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(existsSync(marker())).toBe(false);
    expect(left()).toEqual([]);
  });

  describe('stopped part way (the app quit or crashed)', () => {
    it('while npm installs: the project has no tools, so opening it sets them up; what was left is marked as this app’s', async () => {
      let release!: () => void;
      npm.hold = new Promise<void>((r) => (release = r));
      const staged = stage();
      await vi.waitFor(() => expect(npm.runs).toHaveLength(1));
      // npm part way through when the app stopped: nothing was moved in, and its folder is one the next creation clears
      // once this app is gone (below).
      installer(needed.slice(0, 3))(npm.cwds[0]);
      expect(existsSync(join(project, 'node_modules'))).toBe(false);
      expect(await dependenciesReady(project)).toBe(false);
      expect(left()).toEqual([expect.stringMatching(new RegExp(`^tools-${process.pid}-[0-9a-f]{12}$`))]);
      expect(existsSync(join(stages(), left()[0], '.siteorigin-tools-stage'))).toBe(true);
      await prepareDependencies(project, () => undefined);
      expect(npm.cwds.at(-1)).toBe(project);
      expect(await dependenciesReady(project)).toBe(true);
      await staged.discard();
      release();
      expect(left()).toEqual([]);
    });

    it('between moving the tools in and marking them: opening it sets them up again', async () => {
      const writes = fsp.writeFile.bind(fsp);
      vi.spyOn(fsp, 'writeFile').mockImplementation(async (path, ...rest) => {
        if (String(path).endsWith('deps.json')) throw new Error('The app stopped.');
        return writes(path, ...rest);
      });
      await expect(stage().adopt(() => undefined, owner())).rejects.toThrow('The app stopped.');
      vi.restoreAllMocks();
      expect(existsSync(join(project, needed[0].location, 'package.json'))).toBe(true);
      expect(await dependenciesReady(project)).toBe(false);
      await prepareDependencies(project, () => undefined);
      expect(npm.cwds.at(-1)).toBe(project);
      expect(await dependenciesReady(project)).toBe(true);
    });
  });

  describe('on macOS, which checks a native binary the first time it is loaded', () => {
    // What npm installs on a Mac of this computer's CPU, in the cache and installed as npm would there.
    let mac: typeof needed = [];
    beforeEach(async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mac = await lockedPackages(npmDir, starter);
      fill(userCache(), mac);
      npm.install = installer(mac);
    });
    afterEach(() => Object.defineProperty(process, 'platform', { value: platform, configurable: true }));
    const natives = () => [...mac.filter((p) => p.native).map((p) => join(p.location, 'binding.node')), join('node_modules', 'svelte', 'build', 'Release', 'watcher.node')].sort();

    it('loads the native modules npm installed once in a process of their own, from the project only once it moved them there', async () => {
      await stage().adopt(() => undefined, owner());
      // Started with the install, so its own start is not waited for, and given the list once npm is done.
      expect(npm.warmers).toHaveLength(1);
      const [warm] = npm.warmers;
      expect(natives().length).toBeGreaterThan(1);
      expect(warm.messages).toEqual([{ root: npm.cwds[0], files: natives() }, { root: project }]);
      expect(warm.killed).toBe(false);
    });

    it('never points it at the project when the install was not moved in, and ends it', async () => {
      const staged = stage();
      await installed();
      mkdirSync(join(project, 'node_modules', 'left-here'), { recursive: true });
      await staged.adopt(() => undefined, owner());
      const [warm] = npm.warmers;
      expect(warm.messages).toEqual([{ root: npm.cwds[0], files: natives() }]);
      expect(warm.killed).toBe(true);
    });

    it('ends it, and waits for it to go, when the install fails as the project is set up', async () => {
      rmSync(userCache(), { recursive: true, force: true });
      npm.results.push({ code: 1, stderr: 'npm error code ENOTFOUND\nnpm error network request failed\n' });
      const error = await stage().adopt(() => undefined, owner()).catch((e) => e);
      expect(error).toBeInstanceOf(ToolsDownloadError);
      expect(npm.warmers[0].killed).toBe(true);
      expect(npm.warmers[0].exited).toBe(true);
    });

    it('ends it, and waits for it to go, when the install is discarded', async () => {
      const staged = stage();
      await installed();
      await vi.waitFor(() => expect(npm.warmers[0]?.messages).toHaveLength(1));
      await staged.discard();
      expect(npm.warmers[0].killed).toBe(true);
      expect(npm.warmers[0].exited).toBe(true);
    });
  });

  it('clears only what a creation that never finished left: its own marked folders, of an app no longer running', async () => {
    const make = (name: string, mark = true) => {
      mkdirSync(join(stages(), name, 'old-project', 'node_modules'), { recursive: true });
      if (mark) writeFileSync(join(stages(), name, '.siteorigin-tools-stage'), '{}');
    };
    make('tools-999999-0123456789ab');
    make(`tools-${process.pid}-0123456789ab`);
    make(`tools-${process.ppid}-0123456789ab`);
    make('tools-999998-0123456789ab', false);
    make('a-project-saved-here', false);
    // A link named like a stage, to a marked folder elsewhere: neither is touched.
    const elsewhere = join(root, 'elsewhere', 'tools-999997-0123456789ab');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, '.siteorigin-tools-stage'), '{}');
    symlinkSync(elsewhere, join(stages(), 'tools-999997-0123456789ab'), 'dir');
    await stage().adopt(() => undefined, owner());
    await vi.waitFor(() => expect(left().sort()).toEqual([`tools-${process.ppid}-0123456789ab`, 'a-project-saved-here', 'tools-999997-0123456789ab', 'tools-999998-0123456789ab'].sort()));
    expect(existsSync(join(elsewhere, '.siteorigin-tools-stage'))).toBe(true);
  });
});
