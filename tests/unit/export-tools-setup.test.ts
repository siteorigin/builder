/**
 * The website export builds with the project's website tools, so it waits for them (#1395): while they are still being
 * set up (or reinstalled), it says so and builds nothing; when setting them up failed, it says that and how to recover;
 * and once they are ready the website exports while the preview is still starting.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The folder picker, counted: the author is asked where to export only when the website can be built.
const picker = vi.hoisted(() => ({ asked: 0 }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => (picker.asked++, { canceled: true, filePaths: [] }), showSaveDialog: async () => (picker.asked++, { canceled: true }) },
  shell: {}
}));
vi.mock('../../src/main/settings', () => ({
  addRecent: async () => undefined,
  renameRecent: async () => undefined,
  isTrusted: async () => true,
  trust: async () => undefined,
  loadSettings: async () => ({ settings: { developerMode: false } })
}));

/** Every file under `dir`, as forward-slash paths relative to it. */
const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')).sort() : [];

// The tools are ready or not as the test says; setting them up runs until the test ends it, and the preview server is
// starting until the test lets it go.
const env = vi.hoisted(() => ({
  ready: true,
  installs: 0,
  install: null as { resolve: () => void; reject: (e: Error) => void } | null,
  builds: 0,
  takes: 0,
  take: null as Promise<void> | null,
  starting: null as Promise<void> | null,
  release: () => {}
}));
vi.mock('../../src/main/runtime/manager', () => ({
  dependenciesReady: async () => env.ready,
  prepareDependencies: () => {
    env.installs++;
    return new Promise<void>((resolve, reject) => {
      env.install = {
        resolve: () => {
          env.ready = true;
          resolve();
        },
        reject
      };
    });
  },
  stageDependencies: () => ({ adopt: async () => undefined, discard: async () => undefined }),
  starterTools: async () => 'local',
  // The website build without SvelteKit, as in draft-export.test.ts: each page module becomes the HTML file a static
  // host serves at its address.
  buildProject: async (dir: string) => {
    env.builds++;
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      const source = readFileSync(join(dir, 'src/routes', f), 'utf8');
      const shown = [...source.matchAll(/^\s*import NotFound from '(\.[^']+\/NotFound\.svelte)';$/gm)].map((m) => readFileSync(join(dir, 'src/routes', dirname(f), m[1]), 'utf8'));
      writeFileSync(html, [source, ...shown].join('\n'));
    }
    return { ok: true, logs: [], exited: true };
  },
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
      if (env.starting) await env.starting;
      this.url = 'http://127.0.0.1:9';
      this.tell({ state: 'ready', url: this.url });
    }
    async stop() {
      this.tell({ state: 'idle' });
    }
  }
}));
// The build's copy of the tools, counted, and held open when the test says so.
vi.mock('../../src/main/runtime/stage', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/stage')>()),
  KeptTools: class {
    take = async () => {
      env.takes++;
      if (env.take) await env.take;
      return { keep: async () => undefined };
    };
  }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-export-tools-${name}-`)));
  dirs.push(d);
  return d;
};

afterEach(async () => {
  env.release();
  env.install?.resolve();
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  picker.asked = 0;
  Object.assign(env, { ready: true, installs: 0, install: null, builds: 0, takes: 0, take: null, starting: null, release: () => {} });
});

const until = async (what: () => boolean) => {
  for (let i = 0; i < 300 && !what(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(what()).toBe(true);
};

/** A window the controller tells about the preview, so it starts one. */
const editor = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => undefined } };

/** A project someone handed over, opened in the editor, with its preview under way: `ready` says whether its tools are set up. */
async function opened(ready: boolean) {
  const dir = temp('project');
  const s = await ProjectSession.create(dir, createStarterState('blank', 'Tide Lines', false));
  await s.close();
  env.ready = ready;
  const c = new Controller(() => editor as never);
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await until(() => c.snapshot() !== null);
  return c;
}

const STILL_SETTING_UP = /still setting up the website tools/i;

describe('exporting the website while its tools are set up', () => {
  it('builds nothing while the tools are still being set up, says so, and exports once they are ready', async () => {
    const c = await opened(false);
    await until(() => env.installs === 1 && c.snapshot()?.runtime.state === 'preparing');
    // Said before the author is asked where to put it.
    const asked = await c.exportStatic('folder');
    expect(asked.ok).toBe(false);
    expect(asked.message).toMatch(STILL_SETTING_UP);
    expect(picker.asked).toBe(0);
    const first = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(STILL_SETTING_UP);
    // Nothing of the half-installed tools was copied, and no build ran from them.
    expect(env.takes).toBe(0);
    expect(env.builds).toBe(0);
    // The editable project needs no tools, so it still exports.
    const source = join(temp('out'), 'source');
    expect((await c.exportSourceTo(source)).ok).toBe(true);
    expect(existsSync(join(source, 'siteorigin'))).toBe(true);
    env.install!.resolve();
    await until(() => c.snapshot()?.runtime.state === 'ready');
    const dest = join(temp('out'), 'site');
    const again = await c.buildStaticTo(dest);
    expect(again.message).not.toMatch(STILL_SETTING_UP);
    expect(again.ok).toBe(true);
    expect(existsSync(join(dest, 'index.html'))).toBe(true);
  });

  it('builds nothing when the tools could not be set up, and says how to set them up again', async () => {
    const c = await opened(false);
    await until(() => env.installs === 1);
    env.install!.reject(new Error('Installing dependencies failed: npm ERR! code ENOENT'));
    await until(() => c.snapshot()?.runtime.state === 'error');
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/website tools could not be set up/i);
    expect(r.message).toMatch(/Reinstall website tools/);
    expect(env.takes).toBe(0);
    expect(env.builds).toBe(0);
    expect((await c.exportStatic('folder')).message).toMatch(/website tools could not be set up/i);
    expect(picker.asked).toBe(0);
  });

  it('says how to set the tools up again, never to wait, when they stop being set up with nothing setting them up', async () => {
    const c = await opened(true);
    await until(() => c.snapshot()?.runtime.state === 'ready');
    // The tools' marker damaged (or a package removed) while the preview runs: nothing sets them up again by itself.
    env.ready = false;
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(STILL_SETTING_UP);
    expect(r.message).toMatch(/website tools are not set up.*Reinstall website tools/);
    expect(env.builds).toBe(0);
  });

  it('exports once a reinstall has set the tools up, while the preview it restarts is still starting', async () => {
    const c = await opened(true);
    await until(() => c.snapshot()?.runtime.state === 'ready');
    env.starting = new Promise<void>((r) => (env.release = r));
    env.ready = false;
    const repairing = c.repairDependencies();
    await until(() => env.installs === 1);
    expect((await c.buildStaticTo(join(temp('out'), 'site'))).message).toMatch(STILL_SETTING_UP);
    env.install!.resolve();
    await until(() => c.snapshot()?.runtime.state === 'starting');
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, 'index.html'))).toBe(true);
    env.release();
    await repairing;
  });

  it('builds nothing from tools copied while a reinstall began', async () => {
    const c = await opened(true);
    await until(() => c.snapshot()?.runtime.state === 'ready');
    // The export copies the tools, and the author asks for them to be reinstalled before the copy is done.
    env.take = new Promise<void>((r) => (env.release = r));
    const dest = join(temp('out'), 'site');
    const exporting = c.buildStaticTo(dest);
    await until(() => env.takes === 1);
    env.ready = false;
    const repairing = c.repairDependencies();
    await until(() => env.installs === 1);
    // The reinstall is over before the copy is: the tools are ready again, but the copy may hold some of each.
    env.install!.resolve();
    await repairing;
    await until(() => c.snapshot()?.runtime.state === 'ready');
    env.release();
    const r = await exporting;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(STILL_SETTING_UP);
    expect(env.builds).toBe(0);
    expect(existsSync(dest)).toBe(false);
    // The next export copies them afresh and builds.
    const again = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(again.ok).toBe(true);
  });

  it('exports a project whose tools are ready while its preview is still starting', async () => {
    env.starting = new Promise<void>((r) => (env.release = r));
    const c = await opened(true);
    await until(() => c.snapshot()?.runtime.state === 'starting');
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r.ok).toBe(true);
    expect(env.installs).toBe(0);
    expect(c.snapshot()?.runtime.state).toBe('starting');
  });
});
