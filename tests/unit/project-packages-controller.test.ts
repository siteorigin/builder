/**
 * Project health's Packages (#1480): adding, updating and removing one of the open project's npm packages. npm works
 * the change out away from the project (faked here), so a change it refuses leaves the project and its preview as they
 * were; the two package files are then written together, trusted as the author made them, and the website tools set up
 * again for them before the preview starts again. A change is refused outside Developer mode, for build settings
 * changed outside the app, for a package code still imports, and once the project it was asked in has closed.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  shell: {}
}));

/** What the author trusts, as the settings keep it, and whether Developer mode is on. */
const settings = vi.hoisted(() => ({ trusted: new Map<string, string>(), developerMode: true, trusts: 0 }));
vi.mock('../../src/main/settings', () => ({
  addRecent: async () => undefined,
  renameRecent: async () => undefined,
  isTrusted: async (dir: string, hash: string) => settings.trusted.get(dir) === hash,
  trust: async (dir: string, hash: string) => {
    settings.trusts++;
    settings.trusted.set(dir, hash);
  },
  loadSettings: async () => ({ settings: { developerMode: settings.developerMode } })
}));

type Files = { 'package.json': string; 'package-lock.json': string };
/** npm, as far as a change to the packages can tell: it answers as the test says, and may be held until released. */
const npm = vi.hoisted(() => ({
  runs: [] as Array<{ command: string; options: string[]; spec: string; files: Record<string, unknown> }>,
  answer: null as null | ((files: Files, spec: string) => Files),
  fail: null as null | (Error & { code?: string }),
  hold: null as null | Promise<void>,
  aborted: 0,
  installs: 0,
  /** Runs while the tools are being set up, as the author can edit files meanwhile. */
  duringInstall: null as null | ((dir: string) => void)
}));
vi.mock('../../src/main/runtime/manager', async () => {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { createHash } = await import('node:crypto');
  const marker = (dir: string) => join(dir, '.siteorigin', 'cache', 'deps.json');
  const read = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const lockHash = (dir: string) => createHash('sha256').update(read(dir, 'package-lock.json') + read(dir, 'package.json')).digest('hex');
  return {
    // Set up while the marker the install leaves is for the package files as they are, as the real check has it.
    dependenciesReady: async (dir: string) => existsSync(marker(dir)) && JSON.parse(readFileSync(marker(dir), 'utf8')).lockHash === lockHash(dir),
    prepareDependencies: async (dir: string) => {
      npm.installs++;
      npm.duringInstall?.(dir);
      mkdirSync(join(dir, '.siteorigin', 'cache'), { recursive: true });
      writeFileSync(marker(dir), JSON.stringify({ lockHash: lockHash(dir) }));
    },
    resolvePackageFiles: async (files: Files & Record<string, unknown>, command: string, options: string[], spec: string, signal?: AbortSignal) => {
      npm.runs.push({ command, options, spec, files });
      // Stopped, it ends at once (npm's process is killed), held or not.
      if (npm.hold) await Promise.race([npm.hold, new Promise((stop) => signal?.addEventListener('abort', stop))]);
      if (signal?.aborted) {
        npm.aborted++;
        throw new Error('Canceled');
      }
      if (npm.fail) throw npm.fail;
      return npm.answer!(files, spec);
    },
    stageDependencies: () => ({ adopt: async () => undefined, discard: async () => undefined }),
    starterTools: async () => 'local',
    buildProject: async () => ({ ok: true, logs: [], exited: true }),
    npmModule: (name: string) => createRequire(join(process.cwd(), 'node_modules', 'npm', 'package.json'))(name),
    DevServer: class {
      status: { state: string; url?: string } = { state: 'idle' };
      url: string | null = null;
      exited = Promise.resolve();
      private statusFns: Array<(s: unknown) => void> = [];
      constructor(readonly dir: string) {}
      onStatus(fn: (s: unknown) => void) {
        this.statusFns.push(fn);
      }
      onPublished() {}
      onGone() {}
      notifyRevision() {}
      async hold() {
        return () => {};
      }
      private tell(status: { state: string; url?: string }) {
        this.status = status;
        for (const fn of this.statusFns) fn(status);
      }
      async start() {
        this.tell({ state: 'starting' });
        this.url = 'http://127.0.0.1:9';
        this.tell({ state: 'ready', url: this.url });
      }
      async stop() {
        this.tell({ state: 'idle' });
      }
    }
  };
});

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');

const starter = join(__dirname, '../../templates/sveltekit-brochure/files');
const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-packages-${name}-`)));
  dirs.push(d);
  return d;
};

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  settings.trusted.clear();
  Object.assign(settings, { developerMode: true, trusts: 0 });
  Object.assign(npm, { runs: [], answer: null, fail: null, hold: null, aborted: 0, installs: 0, duringInstall: null });
});

const until = async (what: () => boolean) => {
  for (let i = 0; i < 300 && !what(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(what()).toBe(true);
};

const editor = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => undefined } };

/** What npm makes of the files for `zod@4.1.0`: the dependency in package.json and the lock, as `--save-exact` saves it. */
const addZod = (files: Files): Files => {
  const pkg = JSON.parse(files['package.json']);
  pkg.dependencies = { ...pkg.dependencies, zod: '4.1.0' };
  const lock = JSON.parse(files['package-lock.json']);
  lock.packages[''].dependencies = { ...lock.packages[''].dependencies, zod: '4.1.0' };
  lock.packages['node_modules/zod'] = { version: '4.1.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.1.0.tgz', license: 'MIT' };
  return { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` };
};

/** A project made from the starter (`lock: false`, without its lock), trusted and open with its preview ready. */
async function opened({ lock = true } = {}) {
  const dir = temp('project');
  const s = await ProjectSession.create(dir, createStarterState('blank', 'Tide Lines', false));
  await s.close();
  for (const f of lock ? ['package.json', 'package-lock.json'] : ['package.json']) copyFileSync(join(starter, f), join(dir, f));
  const c = new Controller(() => editor as never);
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await until(() => c.snapshot()?.runtime.state === 'ready');
  const opening = c.snapshot()!.workspaceKey;
  return { c, dir, opening, read: (f: string) => readFileSync(join(dir, f), 'utf8') };
}

describe('changing the project’s npm packages (#1480)', () => {
  it('adds a package: both package files written as npm made them, trusted, and the tools set up again before the preview restarts', async () => {
    const { c, dir, opening, read } = await opened();
    const installs = npm.installs;
    npm.answer = addZod;
    const before = { pkg: read('package.json'), lock: read('package-lock.json') };
    const r = await c.changeProjectPackage({ add: 'zod@4.1.0' }, opening);
    expect(r).toEqual({ ok: true, message: 'Added “zod” 4.1.0.' });
    // npm was asked for a registry install pinned to the version it gets, from the project's files as they were.
    expect(npm.runs).toHaveLength(1);
    expect(npm.runs[0]).toMatchObject({ command: 'install', options: ['--save-exact', '--save-prod'], spec: 'zod@4.1.0', files: { 'package.json': before.pkg, 'package-lock.json': before.lock, '.npmrc': null } });
    const expected = addZod({ 'package.json': before.pkg, 'package-lock.json': before.lock });
    expect(read('package.json')).toBe(expected['package.json']);
    expect(read('package-lock.json')).toBe(expected['package-lock.json']);
    // The new files are what is trusted (the preview started again on them), and the tools were set up for them.
    expect(npm.installs).toBe(installs + 1);
    expect(existsSync(join(dir, '.siteorigin', 'cache', 'deps.json'))).toBe(true);
    expect(c.snapshot()?.runtime.state).toBe('ready');
    // Listed with what package.json asks for.
    const list = await c.projectPackages();
    expect(list.locked).toBeNull();
    expect(list.packages.find((p) => p.name === 'zod')).toMatchObject({ wanted: '4.1.0', section: 'dependencies', tool: false });
    expect(list.packages.filter((p) => p.tool).map((p) => p.name)).toEqual(['@sveltejs/adapter-node', '@sveltejs/adapter-static', '@sveltejs/kit', '@sveltejs/vite-plugin-svelte', 'svelte', 'vite']);
    // A developer's code may now import it, as saved and as the code editor checks it.
    const source = `<script>\n\timport { z } from 'zod';\n\tconst name = z.string().parse('Hi');\n</script>\n\n<p>{name}</p>\n`;
    const saved = await c.session!.apply({ operations: [{ type: 'component.createCode', name: 'Greeting', source }] }, { label: 'Create Greeting', codeAllowed: true });
    expect(saved).toMatchObject({ ok: true });
  });

  it('leaves the project and its preview as they were when npm refuses the change', async () => {
    const { c, opening, read } = await opened();
    const installs = npm.installs;
    const before = { pkg: read('package.json'), lock: read('package-lock.json') };
    npm.fail = Object.assign(new Error('Installing dependencies failed (exit 1). npm error 404 Not Found'), { code: 'E404' });
    const r = await c.changeProjectPackage({ add: 'zodd' }, opening);
    expect(r).toEqual({ ok: false, message: 'npm has no package called “zodd”. Check its name, then try again.' });
    expect(read('package.json')).toBe(before.pkg);
    expect(read('package-lock.json')).toBe(before.lock);
    expect(npm.installs).toBe(installs);
    expect(c.snapshot()?.runtime.state).toBe('ready');
  });

  it('refuses a change outside Developer mode, to the website’s own tools, and to build settings changed outside the app', async () => {
    const { c, dir, opening } = await opened();
    settings.developerMode = false;
    expect((await c.changeProjectPackage({ add: 'zod' }, opening)).message).toMatch(/Developer mode/);
    expect((await c.projectPackages()).locked).toMatch(/Developer mode/);
    settings.developerMode = true;
    expect((await c.changeProjectPackage({ add: 'svelte@latest' }, opening)).message).toMatch(/one of the website’s own tools/);
    expect((await c.changeProjectPackage({ remove: 'vite' }, opening)).message).toMatch(/one of the website’s own tools/);
    expect((await c.changeProjectPackage({ add: 'github:sveltejs/svelte' }, opening)).message).toMatch(/isn’t a package from npm/);
    expect((await c.changeProjectPackage({ remove: 'zod' }, opening)).message).toBe('The project doesn’t have the package “zod”.');
    // Settings edited elsewhere: reviewed on reopening, never changed further (nor trusted) from here.
    writeFileSync(join(dir, 'vite.config.js'), 'export default {};\n');
    const trusts = settings.trusts;
    expect((await c.changeProjectPackage({ add: 'zod' }, opening)).message).toMatch(/build settings changed outside SiteOrigin Builder/);
    expect((await c.projectPackages()).locked).toMatch(/build settings changed outside SiteOrigin Builder/);
    expect(npm.runs).toEqual([]);
    expect(settings.trusts).toBe(trusts);
  });

  it('writes nothing when the build settings change while npm works the change out, and trusts nothing new', async () => {
    const { c, dir, opening, read } = await opened();
    npm.answer = addZod;
    let release = () => {};
    npm.hold = new Promise<void>((r) => (release = r));
    const before = read('package.json');
    const trusts = settings.trusts;
    const changing = c.changeProjectPackage({ add: 'zod@4.1.0' }, opening);
    await until(() => npm.runs.length === 1);
    writeFileSync(join(dir, 'vite.config.js'), 'export default { plugins: [] };\n');
    release();
    expect((await changing).message).toMatch(/build settings changed while the package was being worked out/);
    expect(read('package.json')).toBe(before);
    expect(settings.trusts).toBe(trusts);
  });

  for (const [what, file] of [
    ['package.json', 'package.json'],
    ['the npm settings', '.npmrc']
  ] as const)
    it(`writes nothing over ${what} edited outside the app while npm works the change out`, async () => {
      const { c, dir, opening, read } = await opened();
      npm.answer = addZod;
      let release = () => {};
      npm.hold = new Promise<void>((r) => (release = r));
      // The npm settings were there already: what they say changed, not whether there are any.
      if (file === '.npmrc') writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
      const edited = file === 'package.json' ? read('package.json').replace('"private": true', '"private": true, "description": "mine"') : 'registry=https://registry.example.com/\n';
      const changing = c.changeProjectPackage({ add: 'zod@4.1.0' }, opening);
      await until(() => npm.runs.length === 1);
      writeFileSync(join(dir, file), edited);
      const lock = read('package-lock.json');
      release();
      expect((await changing).message).toMatch(/changed while the package was being worked out/);
      expect(read(file)).toBe(edited);
      expect(read('package-lock.json')).toBe(lock);
    });

  it('refuses a change npm reports done but did not make, and one Developer mode was turned off for meanwhile', async () => {
    const { c, opening, read } = await opened();
    const before = read('package.json');
    // npm settings of the author's own (save=false) leave the files as they were, and npm still succeeds.
    npm.answer = (files) => files;
    expect(await c.changeProjectPackage({ add: 'zod' }, opening)).toEqual({ ok: false, message: 'npm didn’t change the project’s package files for “zod”, so nothing was changed. Check the project’s npm settings (.npmrc).' });
    npm.answer = addZod;
    let release = () => {};
    npm.hold = new Promise<void>((r) => (release = r));
    const changing = c.changeProjectPackage({ add: 'zod@4.1.0' }, opening);
    await until(() => npm.runs.length === 2);
    settings.developerMode = false;
    release();
    expect((await changing).message).toBe('Developer mode was turned off, so the project’s packages were not changed.');
    expect(read('package.json')).toBe(before);
  });

  it('refuses an update npm settings would move to another part of package.json', async () => {
    const { c, dir, opening, read } = await opened();
    const pkg = JSON.parse(read('package.json'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...pkg, peerDependencies: { three: '0.170.0' }, peerDependenciesMeta: { three: { optional: true } } }, null, 2)}\n`);
    // Trusted as the author would trust it on reopening.
    const { createHash } = await import('node:crypto');
    const config = ['package.json', 'package-lock.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js'].map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : ''));
    settings.trusted.set(dir, createHash('sha256').update(config.join('\n--\n')).digest('hex'));
    const before = read('package.json');
    // `save-prod` in the author's npm settings: the optional peer becomes a dependency.
    npm.answer = (files) => {
      const next = JSON.parse(files['package.json']);
      delete next.peerDependencies;
      delete next.peerDependenciesMeta;
      next.dependencies = { three: '0.171.0' };
      return { 'package.json': JSON.stringify(next), 'package-lock.json': files['package-lock.json'] };
    };
    expect((await c.changeProjectPackage({ add: 'three@latest' }, opening)).message).toMatch(/npm would move “three” to another part of package\.json/);
    // Kept optional, it is updated.
    npm.answer = (files) => ({ 'package.json': files['package.json'].replace('"three": "0.170.0"', '"three": "0.171.0"'), 'package-lock.json': files['package-lock.json'] });
    expect(await c.changeProjectPackage({ add: 'three@latest' }, opening)).toEqual({ ok: true, message: 'Updated “three” 0.171.0.' });
    expect(read('package.json')).toBe(before.replace('"three": "0.170.0"', '"three": "0.171.0"'));
  });

  it('stops the preview at the trust check when the build settings change while the tools are set up for a new package', async () => {
    const { c, dir, opening } = await opened();
    npm.answer = addZod;
    npm.duringInstall = (d) => writeFileSync(join(d, 'vite.config.js'), 'export default { plugins: [] };\n');
    expect((await c.changeProjectPackage({ add: 'zod@4.1.0' }, opening)).ok).toBe(true);
    expect(c.snapshot()?.runtime).toMatchObject({ state: 'error', message: expect.stringMatching(/build settings changed outside SiteOrigin Builder/) });
    expect(existsSync(join(dir, 'vite.config.js'))).toBe(true);
  });

  it('starts the preview of a project whose lock npm writes as it sets the tools up, with no review asked', async () => {
    npm.duringInstall = (d) => {
      if (!existsSync(join(d, 'package-lock.json'))) copyFileSync(join(starter, 'package-lock.json'), join(d, 'package-lock.json'));
    };
    const { c, read } = await opened({ lock: false });
    expect(c.snapshot()?.runtime.state).toBe('ready');
    expect(read('package-lock.json')).toBe(readFileSync(join(starter, 'package-lock.json'), 'utf8'));
    // The lock is trusted with the package.json it was made from: starting again asks for no review either.
    await c.startRuntime();
    expect(c.snapshot()?.runtime.state).toBe('ready');
  });

  it('refuses a removal when code importing the package is saved while npm works it out', async () => {
    const { c, opening, read } = await opened();
    npm.answer = addZod;
    expect((await c.changeProjectPackage({ add: 'zod@4.1.0' }, opening)).ok).toBe(true);
    npm.answer = (files) => {
      const pkg = JSON.parse(files['package.json']);
      delete pkg.dependencies;
      return { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': files['package-lock.json'] };
    };
    let release = () => {};
    npm.hold = new Promise<void>((r) => (release = r));
    const removing = c.changeProjectPackage({ remove: 'zod' }, opening);
    await until(() => npm.runs.length === 2);
    const source = `<script>\n\timport { z } from 'zod';\n</script>\n\n<p>{String(z)}</p>\n`;
    expect(await c.session!.apply({ operations: [{ type: 'component.createCode', name: 'Late', source }] }, { label: 'Create Late', codeAllowed: true })).toMatchObject({ ok: true });
    release();
    expect(await removing).toEqual({ ok: false, message: '“zod” is still imported by the code component “Late”. Remove the import from it first.' });
    expect(JSON.parse(read('package.json')).dependencies).toEqual({ zod: '4.1.0' });
  });

  it('refuses to remove a package a code component imports, naming it, and removes it once nothing does', async () => {
    const { c, opening, read } = await opened();
    npm.answer = addZod;
    expect((await c.changeProjectPackage({ add: 'zod@4.1.0' }, opening)).ok).toBe(true);
    const source = `<script>\n\timport { z } from 'zod';\n</script>\n\n<p>{String(z)}</p>\n`;
    expect(await c.session!.apply({ operations: [{ type: 'component.createCode', name: 'Schema', source }] }, { label: 'Create Schema', codeAllowed: true })).toMatchObject({ ok: true });
    const r = await c.changeProjectPackage({ remove: 'zod' }, opening);
    expect(r).toEqual({ ok: false, message: '“zod” is still imported by the code component “Schema”. Remove the import from it first.' });
    expect(npm.runs).toHaveLength(1);
    // Its import gone, it goes.
    const def = Object.values(c.session!.state.components).find((d) => d.name === 'Schema')!;
    expect(await c.session!.apply({ operations: [{ type: 'component.updateSource', definitionId: def.id, source: '<p>Plain</p>\n' }] }, { label: 'Edit Schema', codeAllowed: true })).toMatchObject({ ok: true });
    npm.answer = (files) => {
      const pkg = JSON.parse(files['package.json']);
      delete pkg.dependencies;
      return { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': files['package-lock.json'] };
    };
    expect(await c.changeProjectPackage({ remove: 'zod' }, opening)).toEqual({ ok: true, message: 'Removed “zod”.' });
    expect(npm.runs[1]).toMatchObject({ command: 'uninstall', options: [], spec: 'zod' });
    expect(JSON.parse(read('package.json')).dependencies).toBeUndefined();
  });

  it('stops npm and writes nothing when the project closes while the change is worked out, or was asked in an opening since closed', async () => {
    const { c, dir, opening, read } = await opened();
    npm.answer = addZod;
    let release = () => {};
    npm.hold = new Promise<void>((r) => (release = r));
    const before = read('package.json');
    const changing = c.changeProjectPackage({ add: 'zod' }, opening);
    await until(() => npm.runs.length === 1);
    // Closing waits for the change, which it stops: npm is never let go.
    await c.close();
    expect(await changing).toEqual({ ok: false, message: 'The project was closed before its packages could be changed.' });
    expect(npm.aborted).toBe(1);
    release();
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(await c.changeProjectPackage({ add: 'zod' }, opening)).toEqual({ ok: false, message: 'The project was closed before its packages could be changed.' });
    // Opened again, it is another opening: a change asked in the one before changes nothing.
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready');
    expect(c.snapshot()!.workspaceKey).not.toBe(opening);
    expect(await c.changeProjectPackage({ add: 'zod' }, opening)).toEqual({ ok: false, message: 'The project was closed before its packages could be changed.' });
    expect(npm.runs).toHaveLength(1);
  });
});
