/**
 * An export's staging folder (userData/build-staging/export-*): removing it never takes the place of what the export
 * says. On Windows a file the build had open, such as a native module it loaded, can refuse removal for a while after
 * the build has gone, and that refusal replaced a failed build's own report with "The export could not be completed".
 */
import { cpSync, existsSync, lstatSync, mkdirSync, promises as fsp, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  userData: '',
  pick: null as null | (() => Promise<string>),
  build: { ok: true } as { ok: boolean; error?: string },
  /** Whether the build's worker is gone when the build settles, and the real copy of the tools is made. */
  tools: { real: false, exited: false },
  /** The website tools' package.json as each build found it in its staging folder (its inode). */
  builtWith: [] as bigint[]
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {
    showOpenDialog: async () => (env.pick ? { canceled: false, filePaths: [await env.pick()] } : { canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  },
  utilityProcess: { fork: () => undefined }
}));
/** Every file under `dir`, as forward-slash paths relative to it. */
const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')) : [];
// The website build, without SvelteKit: it fails as the test says, or writes each page module as the HTML file a static
// host serves at its address, with static/ copied as it is (as draft-export.test.ts builds).
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  buildProject: async (dir: string) => {
    if (env.tools.real) env.builtWith.push(lstatSync(join(dir, 'node_modules/vite/package.json'), { bigint: true }).ino);
    if (!env.build.ok) return { ...env.build, logs: [], exited: env.tools.exited };
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      writeFileSync(html, readFileSync(join(dir, 'src/routes', f), 'utf8'));
    }
    return { ok: true, logs: [], exited: env.tools.exited };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => {
  const stage = await original<typeof import('../../src/main/runtime/stage')>();
  class KeptTools extends stage.KeptTools {
    override take(...args: Parameters<InstanceType<typeof stage.KeptTools>['take']>) {
      return env.tools.real ? super.take(...args) : Promise.resolve({ keep: async () => undefined });
    }
  }
  return { ...stage, KeptTools };
});

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-staging-${name}-`)));
  dirs.push(d);
  return d;
};
const staged = () => readdirSync(join(env.userData, 'build-staging')).filter((n) => n.startsWith('export-'));

beforeEach(() => {
  env.userData = temp('userdata');
  env.pick = null;
  env.build = { ok: true };
  env.tools = { real: false, exited: false };
  env.builtWith = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function openProject(tools = false) {
  const dir = temp('project');
  await (await ProjectSession.create(dir, createStarterState('business', 'Bookshop', false))).close();
  if (tools) {
    mkdirSync(join(dir, 'node_modules/vite'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/vite/package.json'), '{"name":"vite"}');
  }
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return c;
}

/** Make every removal of a staging folder fail as Windows does while a native module the build loaded is still held. */
function stagingRefusesRemoval() {
  const rm = fsp.rm.bind(fsp);
  return vi.spyOn(fsp, 'rm').mockImplementation(async (path, opts) => {
    if (/build-staging[\\/]export-[^\\/]+$/.test(String(path))) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${path}\\node_modules\\lightningcss-win32-x64-msvc\\lightningcss.win32-x64-msvc.node'`), { code: 'EPERM' });
    return rm(path, opts);
  });
}

describe('an export’s staging folder', () => {
  it('cannot hide why a build failed when it cannot be removed, and is swept before the next export', async () => {
    const c = await openProject();
    env.pick = async () => temp('out');
    env.build = { ok: false, error: 'The opening hours widget could not read its hours' };
    const refusal = stagingRefusesRemoval();
    const failed = await c.exportStatic('folder');
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/production build failed/i);
    expect(failed.message).not.toMatch(/could not be completed|EPERM/);
    expect(staged()).toHaveLength(1);

    // Once the file is let go, the next export removes what the last one left, and its own staging too.
    refusal.mockRestore();
    env.build = { ok: true };
    const done = await c.exportStatic('folder');
    expect(done.ok).toBe(true);
    expect(staged()).toEqual([]);
  });

  it('keeps the build’s copy of the website tools for the next export, once the build has gone', async () => {
    const c = await openProject(true);
    // The tools were installed long ago: their stamps have settled.
    (c as unknown as { session: { settleMs: number } }).session.settleMs = 0;
    await new Promise((r) => setTimeout(r, 30));
    env.pick = async () => temp('out');
    env.tools = { real: true, exited: true };
    const kept = join(env.userData, 'build-staging', 'tools', 'node_modules', 'vite', 'package.json');
    expect((await c.exportStatic('folder')).ok).toBe(true);
    expect(staged()).toEqual([]);
    expect(existsSync(kept)).toBe(true);
    expect((await c.exportStatic('folder')).ok).toBe(true);
    expect(staged()).toEqual([]);
    // The second build ran from the first's copy: the same file, not a new copy of the project's.
    expect(env.builtWith).toHaveLength(2);
    expect(env.builtWith[1]).toBe(env.builtWith[0]);
    expect(lstatSync(kept, { bigint: true }).ino).toBe(env.builtWith[0]);

    // A build whose worker may still be running keeps nothing: its copy goes with its staging folder.
    env.tools.exited = false;
    env.build = { ok: false, error: 'It broke' };
    expect((await c.exportStatic('folder')).ok).toBe(false);
    expect(env.builtWith[2]).toBe(env.builtWith[0]);
    expect(staged()).toEqual([]);
    expect(existsSync(kept)).toBe(false);
  });

  it('is removed when the export ends, whether it worked or not', async () => {
    const c = await openProject();
    env.pick = async () => temp('out');
    const ok = await c.exportStatic('folder');
    expect(ok, ok.message).toMatchObject({ ok: true });
    expect(staged()).toEqual([]);
    env.build = { ok: false, error: 'It broke' };
    expect((await c.exportStatic('folder')).ok).toBe(false);
    expect(staged()).toEqual([]);
  });
});
