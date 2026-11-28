/**
 * A project's npm packages (#1480): which a change asks npm for (registry packages only, by name with an optional
 * version, the website's own tools never), how npm's refusals are told, what the Packages list shows, and that npm
 * works a change out in a private copy of the package files, never in the project.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '1.0.0' },
  utilityProcess: {}
}));

/** npm, as far as working out a change can tell: each run recorded, with its folder's files as npm found them. */
const npm = vi.hoisted(() => ({
  runs: [] as Array<{ args: string[]; cwd: string; found: Record<string, string | null> }>,
  result: { code: 0, stderr: '' },
  write: null as null | ((cwd: string) => void),
  hold: false,
  killed: 0
}));
vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_cmd: string, args: string[], opts: { cwd: string }) => {
      const read = (f: string) => (fs.existsSync(path.join(opts.cwd, f)) ? fs.readFileSync(path.join(opts.cwd, f), 'utf8') : null);
      npm.runs.push({ args, cwd: opts.cwd, found: { 'package.json': read('package.json'), 'package-lock.json': read('package-lock.json'), '.npmrc': read('.npmrc') } });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          npm.killed++;
          setTimeout(() => child.emit('close', null), 0);
          return true;
        }
      });
      if (!npm.hold)
        setTimeout(() => {
          if (npm.result.code === 0) npm.write?.(opts.cwd);
          if (npm.result.stderr) child.stderr.emit('data', npm.result.stderr);
          child.emit('close', npm.result.code);
        }, 0);
      return child;
    }
  };
});

const { resolvePackageFiles } = await import('../../src/main/runtime/manager');
const { STARTER_PACKAGES, declaredVersion, listPackages, packageFailure, packageRequest } = await import('../../src/main/runtime/packages');

const starter = join(__dirname, '../../templates/sveltekit-brochure/files');
const STARTER_PKG = readFileSync(join(starter, 'package.json'), 'utf8');
const pkgWith = (extra: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(STARTER_PKG), ...extra });

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-packages-'));
  env.userData = join(root, 'userData');
  mkdirSync(env.userData);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  Object.assign(npm, { runs: [], result: { code: 0, stderr: '' }, write: null, hold: false, killed: 0 });
});

describe('what a change to the packages asks of npm (#1480)', () => {
  it('installs a registry package by name, with a version, range or tag, pinned to the version it gets', () => {
    const pkg = pkgWith({ dependencies: { zod: '4.1.0' }, devDependencies: { ...JSON.parse(STARTER_PKG).devDependencies, chartist: '1.0.0' } });
    expect(packageRequest({ add: '  canvas-confetti ' }, pkg)).toEqual({ ok: true, verb: 'add', name: 'canvas-confetti', command: 'install', options: ['--save-exact', '--save-prod'], spec: 'canvas-confetti' });
    expect(packageRequest({ add: '@scope/charts@^2' }, pkg)).toMatchObject({ ok: true, verb: 'add', name: '@scope/charts', spec: '@scope/charts@^2' });
    // One the project has is updated where package.json keeps it.
    expect(packageRequest({ add: 'zod@latest' }, pkg)).toMatchObject({ ok: true, verb: 'update', options: ['--save-exact', '--save-prod'], spec: 'zod@latest' });
    expect(packageRequest({ add: 'chartist@1.1.0' }, pkg)).toMatchObject({ ok: true, verb: 'update', options: ['--save-exact', '--save-dev'], spec: 'chartist@1.1.0' });
    expect(packageRequest({ remove: 'chartist' }, pkg)).toEqual({ ok: true, verb: 'remove', name: 'chartist', command: 'uninstall', options: [], spec: 'chartist' });
    // An optional one stays optional, a peer stays a peer, and an optional peer stays both.
    const more = pkgWith({ optionalDependencies: { fsevents: '2.3.3' }, peerDependencies: { leaflet: '1.9.4', three: '0.170.0' }, peerDependenciesMeta: { three: { optional: true } } });
    expect(packageRequest({ add: 'fsevents@latest' }, more)).toMatchObject({ options: ['--save-exact', '--save-optional'] });
    expect(packageRequest({ add: 'leaflet@latest' }, more)).toMatchObject({ options: ['--save-exact', '--save-peer'] });
    expect(packageRequest({ add: 'three@latest' }, more)).toMatchObject({ options: ['--save-exact', '--save-peer', '--save-optional'] });
  });

  it('refuses anything but a registry package, the website’s own tools, and removing one the project does not have', () => {
    const pkg = pkgWith({ dependencies: { zod: '4.1.0' } });
    for (const add of ['demo@ .', 'demo@ ./x', 'github:sveltejs/svelte', 'file:../secrets', '../x', '/etc', 'https://example.com/x.tgz', 'zod@npm:evil@1', 'git+ssh://git@github.com/a/b.git', 'a b', '@scope', 'node:fs', '-g', `${'a'.repeat(300)}`])
      expect(packageRequest({ add }, pkg)).toMatchObject({ ok: false, message: expect.stringMatching(/isn’t a package from npm/) });
    for (const blank of ['', '   ']) expect(packageRequest({ add: blank }, pkg)).toEqual({ ok: false, message: 'Type the name of a package, such as zod or zod@4.1.0.' });
    for (const name of ['svelte', 'vite', '@sveltejs/kit']) {
      expect(packageRequest({ add: `${name}@latest` }, pkg)).toMatchObject({ ok: false, message: expect.stringMatching(/one of the website’s own tools/) });
      expect(packageRequest({ remove: name }, pkg)).toMatchObject({ ok: false, message: expect.stringMatching(/one of the website’s own tools/) });
    }
    expect(packageRequest({ remove: 'lodash' }, pkg)).toEqual({ ok: false, message: 'The project doesn’t have the package “lodash”.' });
    expect(packageRequest({ remove: '../zod' }, pkgWith({ dependencies: { '../zod': '1' } }))).toMatchObject({ ok: false });
    for (const odd of [null, 'zod', 7, { add: 7 }, { remove: ['zod'] }, {}]) expect(packageRequest(odd, pkg).ok).toBe(false);
  });

  it('keeps the website’s own tools the starter is made with', () => {
    expect([...STARTER_PACKAGES].sort()).toEqual(Object.keys(JSON.parse(STARTER_PKG).devDependencies).sort());
  });

  it('says what npm refused in the author’s terms', () => {
    const add = packageRequest({ add: 'zod@9' }, STARTER_PKG) as Extract<ReturnType<typeof packageRequest>, { ok: true }>;
    const fail = (code: string | undefined, message = 'Installing dependencies failed (exit 1). npm error something') => packageFailure(add, Object.assign(new Error(message), { code }));
    expect(fail('E404')).toBe('npm has no package called “zod”. Check its name, then try again.');
    expect(fail('ETARGET')).toBe('“zod” has no version that matches “9”. Check the version, or leave it out to get the latest.');
    expect(fail('ENOTFOUND')).toBe('The npm registry couldn’t be reached (ENOTFOUND). Check the internet connection, then try again.');
    expect(fail('ERESOLVE', 'Installing dependencies failed (exit 1). npm error peer svelte@4')).toBe('“zod” doesn’t fit with the project’s other packages: npm error peer svelte@4');
    expect(fail(undefined)).toBe('npm couldn’t add “zod”: npm error something');
    const remove = packageRequest({ remove: 'zod' }, pkgWith({ dependencies: { zod: '4.1.0' } })) as Extract<ReturnType<typeof packageRequest>, { ok: true }>;
    expect(packageFailure(remove, Object.assign(new Error('Installing dependencies failed (exit 1). npm error EACCES'), { code: 'EACCES' }))).toBe('npm couldn’t remove “zod”: npm error EACCES');
  });
});

describe('the Packages list (#1480)', () => {
  it('lists every package the project declares, its own first, with the version set up in its tools', async () => {
    const dir = join(root, 'project');
    const pkg = pkgWith({ dependencies: { zod: '4.1.0', '@scope/charts': '^2.0.0' }, optionalDependencies: { fsevents: '2.3.3' }, peerDependencies: { leaflet: '1.9.4' } });
    mkdirSync(join(dir, 'node_modules', '@scope', 'charts'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@scope', 'charts', 'package.json'), JSON.stringify({ version: '2.3.1' }));
    mkdirSync(join(dir, 'node_modules', 'svelte'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'svelte', 'package.json'), JSON.stringify({ version: '5.59.1' }));
    const list = await listPackages(dir, pkg);
    expect(list.slice(0, 4)).toEqual([
      { name: '@scope/charts', wanted: '^2.0.0', section: 'dependencies', installed: '2.3.1', tool: false },
      { name: 'fsevents', wanted: '2.3.3', section: 'optionalDependencies', installed: null, tool: false },
      { name: 'leaflet', wanted: '1.9.4', section: 'peerDependencies', installed: null, tool: false },
      { name: 'zod', wanted: '4.1.0', section: 'dependencies', installed: null, tool: false }
    ]);
    expect(list.slice(4).map((p) => [p.name, p.tool, p.installed])).toEqual([
      ['@sveltejs/adapter-static', true, null],
      ['@sveltejs/kit', true, null],
      ['@sveltejs/vite-plugin-svelte', true, null],
      ['svelte', true, '5.59.1'],
      ['vite', true, null]
    ]);
    expect(await listPackages(dir, 'not json')).toEqual([]);
    expect(await listPackages(dir, pkgWith({ dependencies: { '../../etc': '1' } }))).toHaveLength(5);
    expect(declaredVersion(pkg, 'leaflet')).toBe('1.9.4');
    expect(declaredVersion(pkg, 'lodash')).toBeNull();
  });
});

describe('working a change out away from the project (#1480)', () => {
  const files = () => ({ 'package.json': STARTER_PKG, 'package-lock.json': readFileSync(join(starter, 'package-lock.json'), 'utf8'), '.npmrc': 'registry=https://registry.example.com/\n' });

  it('runs npm on a private copy of the package files, with the project’s npm settings, for the lock alone', async () => {
    npm.write = (cwd) => {
      writeFileSync(join(cwd, 'package.json'), '{"changed":true}');
      writeFileSync(join(cwd, 'package-lock.json'), '{"lock":true}');
    };
    const out = await resolvePackageFiles(files(), 'install', ['--save-exact', '--save-prod'], 'zod@4.1.0');
    expect(out).toEqual({ 'package.json': '{"changed":true}', 'package-lock.json': '{"lock":true}' });
    expect(npm.runs).toHaveLength(1);
    const run = npm.runs[0];
    expect(run.found).toEqual(files());
    // Nothing is left of the copy.
    expect(existsSync(run.cwd)).toBe(false);
    const args = run.args.slice(1);
    expect(args[0]).toBe('install');
    // The same settings as the install that follows (so its lock is the one `npm ci` installs), the change saved and
    // made for real whatever the author's npm settings say, and what the registry has now.
    for (const flag of ['--package-lock-only', '--prefer-online', '--save=true', '--dry-run=false', '--ignore-scripts', '--install-strategy=hoisted', '--include=dev', '--include=optional', '--include=peer', `--os=${process.platform}`, `--cpu=${process.arch}`, '--save-exact', '--save-prod'])
      expect(args).toContain(flag);
    expect(args).not.toContain('--prefer-offline');
    // The package is given last, after `--`, so nothing in it is ever read as a setting.
    expect(args.slice(-2)).toEqual(['--', 'zod@4.1.0']);
    expect(args.indexOf('--save-prod')).toBeLessThan(args.indexOf('--'));
  });

  it('passes npm’s refusal on with its code, and leaves no copy behind', async () => {
    npm.result = { code: 1, stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/zodd\n' };
    const failed = await resolvePackageFiles(files(), 'install', [], 'zodd').catch((e: Error & { code?: string }) => e);
    expect(failed).toMatchObject({ code: 'E404' });
    expect(existsSync(npm.runs[0].cwd)).toBe(false);
  });

  it('needs nothing new from the registry to remove a package', async () => {
    npm.write = () => undefined;
    await resolvePackageFiles(files(), 'uninstall', [], 'zod');
    expect(npm.runs[0].args.slice(1)).toEqual(expect.arrayContaining(['uninstall', '--prefer-offline', '--save=true']));
    expect(npm.runs[0].args).not.toContain('--prefer-online');
  });

  it('starts no npm once already stopped', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await resolvePackageFiles(files(), 'install', [], 'zod', abort.signal).catch((e: Error) => e)).toMatchObject({ message: 'Canceled' });
    expect(npm.runs).toEqual([]);
  });

  it('stops npm when asked to', async () => {
    npm.hold = true;
    const abort = new AbortController();
    const resolving = resolvePackageFiles(files(), 'uninstall', [], 'zod', abort.signal).catch((e: Error) => e);
    for (let i = 0; i < 100 && !npm.runs.length; i++) await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    expect(await resolving).toMatchObject({ message: 'Canceled' });
    expect(npm.killed).toBe(1);
    expect(existsSync(npm.runs[0].cwd)).toBe(false);
  });
});
