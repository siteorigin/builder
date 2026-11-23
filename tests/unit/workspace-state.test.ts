/**
 * Workspace state (open page, tabs, unsent AI drafts) belongs to the project it was saved in. Creating or opening
 * another project starts from that project's own state, and a save meant for one project never lands in another.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}));
// Trust, recents and the preview's website tools are outside this test: no settings file, no npm, no dev server.
vi.mock('../../src/main/settings', () => ({
  addRecent: async () => undefined,
  isTrusted: async () => true,
  trust: async () => undefined,
  loadSettings: async () => ({ settings: { developerMode: false } })
}));
vi.mock('../../src/main/runtime/manager', () => ({
  dependenciesReady: async () => true,
  prepareDependencies: async () => undefined,
  buildProject: async () => ({ ok: true, logs: [] }),
  DevServer: class {
    status = { state: 'idle' };
    onStatus() {}
    notifyRevision() {}
    async start() {}
    async stop() {}
  }
}));

const { Controller } = await import('../../src/main/controller');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-workspace-')));
  dirs.push(parent);
  const c = new Controller(() => null);
  controllers.push(c);
  return { c, parent };
}

async function create(c: InstanceType<typeof Controller>, parent: string, name: string): Promise<string> {
  const r = await c.create({ name, parentDir: parent, starter: 'blank', sampleImages: false });
  expect(r).toEqual({ ok: true });
  return c.session!.dir;
}

const workspaceFile = (dir: string) => join(dir, '.siteorigin', 'workspace.json');
const onDisk = (dir: string) => (existsSync(workspaceFile(dir)) ? JSON.parse(readFileSync(workspaceFile(dir), 'utf8')) : {});

describe('workspace state per project', () => {
  it('a new project does not inherit the previous project’s unsent AI draft', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Kloof Light Studio');
    await c.saveLocalState({ chatDrafts: { c_kloof: 'Calm and understated' }, rightTab: 'chat' }, a);
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_kloof: 'Calm and understated' });

    const b = await create(c, parent, '灯台');
    expect(b).not.toBe(a);
    expect(c.snapshot()!.localState).toEqual({});
    // The first save in the new project writes only that project's state.
    await c.saveLocalState({ pageId: 'p_home' }, b);
    expect(onDisk(b)).toEqual({ pageId: 'p_home' });
  });

  it('closing to the welcome screen and opening another project starts from that project’s own state', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    await c.saveLocalState({ chatDrafts: { c_alpha: 'Alpha draft' } }, a);
    const b = await create(c, parent, 'Beta');
    await c.saveLocalState({ chatDrafts: { c_beta: 'Beta draft' } }, b);

    await c.close();
    expect(c.snapshot()).toBeNull();
    expect(await c.open(a)).toEqual({ ok: true });
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_alpha: 'Alpha draft' });
    expect(await c.open(b)).toEqual({ ok: true });
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_beta: 'Beta draft' });
    expect(onDisk(a).chatDrafts).toEqual({ c_alpha: 'Alpha draft' });
  });

  it('drops a save meant for a project that is no longer open', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    await c.saveLocalState({ chatDrafts: { c_alpha: 'Alpha draft' } }, a);
    const b = await create(c, parent, 'Beta');

    // A debounced save from the previous project arrives after the switch.
    await c.saveLocalState({ chatDrafts: { c_alpha: 'Typed just before switching' } }, a);
    expect(c.snapshot()!.localState).toEqual({});
    expect(onDisk(b)).toEqual({});
    expect(onDisk(a).chatDrafts).toEqual({ c_alpha: 'Alpha draft' });

    // With no project open at all, a late save is dropped too, and never reaches the next project.
    await c.close();
    await c.saveLocalState({ chatDrafts: { c_alpha: 'Typed while closing' } }, a);
    expect(await c.open(b)).toEqual({ ok: true });
    expect(c.snapshot()!.localState).toEqual({});
    expect(await c.open(a)).toEqual({ ok: true });
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_alpha: 'Alpha draft' });
  });
});
