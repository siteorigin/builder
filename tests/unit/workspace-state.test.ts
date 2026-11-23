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

/** The opening of the project the editor is showing, as its saves name it. */
const opening = (c: InstanceType<typeof Controller>) => c.snapshot()!.workspaceKey;

const workspaceFile = (dir: string) => join(dir, '.siteorigin', 'workspace.json');
const onDisk = (dir: string) => (existsSync(workspaceFile(dir)) ? JSON.parse(readFileSync(workspaceFile(dir), 'utf8')) : {});

describe('workspace state per project', () => {
  it('a new project does not inherit the previous project’s unsent AI draft', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Kloof Light Studio');
    c.saveLocalState({ chatDrafts: { c_kloof: 'Calm and understated' }, rightTab: 'chat' }, opening(c));
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_kloof: 'Calm and understated' });

    const b = await create(c, parent, '灯台');
    expect(b).not.toBe(a);
    expect(c.snapshot()!.localState).toEqual({});
    // The first save in the new project writes only that project's state.
    c.saveLocalState({ pageId: 'p_home' }, opening(c));
    await c.flushLocalState();
    expect(onDisk(b)).toEqual({ pageId: 'p_home' });
    expect(onDisk(a)).toEqual({ chatDrafts: { c_kloof: 'Calm and understated' }, rightTab: 'chat' });
  });

  it('writes a draft typed just before closing, before the lock is released, and reopening restores each project’s own state', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    // No wait for the write: closing right after typing still keeps it, written before the session lets go.
    c.saveLocalState({ chatDrafts: { c_alpha: 'Alpha draft' } }, opening(c));
    const session = c.session!;
    const release = session.close.bind(session);
    let atRelease: unknown = null;
    session.close = async () => {
      atRelease = onDisk(a);
      return release();
    };
    const b = await create(c, parent, 'Beta');
    expect(atRelease).toEqual({ chatDrafts: { c_alpha: 'Alpha draft' } });
    c.saveLocalState({ chatDrafts: { c_beta: 'Beta draft' } }, opening(c));

    await c.close();
    expect(c.snapshot()).toBeNull();
    expect(onDisk(b).chatDrafts).toEqual({ c_beta: 'Beta draft' });
    expect(await c.open(a)).toEqual({ ok: true });
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_alpha: 'Alpha draft' });
    expect(await c.open(b)).toEqual({ ok: true });
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_beta: 'Beta draft' });
    expect(onDisk(a).chatDrafts).toEqual({ c_alpha: 'Alpha draft' });
  });

  it('drops a save meant for a project that is closing or no longer open', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const alpha = opening(c);
    c.saveLocalState({ chatDrafts: { c_alpha: 'Alpha draft' } }, alpha);

    // A save that reaches the project after it started closing is not written, and not carried over.
    const closing = c.close();
    c.saveLocalState({ chatDrafts: { c_alpha: 'Typed while closing' } }, alpha);
    await closing;
    const b = await create(c, parent, 'Beta');
    expect(c.snapshot()!.localState).toEqual({});

    // A late save from the previous project arrives after the switch.
    c.saveLocalState({ chatDrafts: { c_alpha: 'Typed just before switching' } }, alpha);
    c.saveLocalState({ chatDrafts: { c_alpha: 'Named by folder' } }, a);
    expect(c.snapshot()!.localState).toEqual({});
    await c.flushLocalState();
    expect(onDisk(b)).toEqual({});
    expect(onDisk(a).chatDrafts).toEqual({ c_alpha: 'Alpha draft' });

    // With no project open at all, a late save is dropped too, and never reaches the next project.
    await c.close();
    c.saveLocalState({ chatDrafts: { c_alpha: 'Typed after closing' } }, alpha);
    expect(await c.open(b)).toEqual({ ok: true });
    expect(c.snapshot()!.localState).toEqual({});
    expect(await c.open(a)).toEqual({ ok: true });
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_alpha: 'Alpha draft' });
  });

  it('a save from an earlier opening of the same project does not replace what was saved since', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const first = opening(c);
    c.saveLocalState({ chatDrafts: { c_alpha: 'Older draft' } }, first);
    await c.close();
    expect(await c.open(a)).toEqual({ ok: true });
    const second = opening(c);
    expect(second).not.toBe(first);
    c.saveLocalState({ chatDrafts: { c_alpha: 'Newer draft' } }, second);
    // An edit from the earlier view, delivered after the reopen.
    c.saveLocalState({ chatDrafts: { c_alpha: 'Older draft' } }, first);
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_alpha: 'Newer draft' });
    await c.close();
    expect(onDisk(a).chatDrafts).toEqual({ c_alpha: 'Newer draft' });
  });
});
