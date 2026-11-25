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
// `whileSettingsLoad` runs once inside the next settings read, to change projects in the middle of an edit.
const hooks = vi.hoisted(() => ({ whileSettingsLoad: null as null | (() => Promise<unknown>) }));
vi.mock('../../src/main/settings', () => ({
  addRecent: async () => undefined,
  renameRecent: async () => undefined,
  isTrusted: async () => true,
  trust: async () => undefined,
  loadSettings: async () => {
    const during = hooks.whileSettingsLoad;
    hooks.whileSettingsLoad = null;
    await during?.();
    return { settings: { developerMode: false } };
  }
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
    c.saveLocalState({ pageId: 'p_named_by_folder' }, b);
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
    // The drafts are saved whole: one sent away and emptied is gone, not merged back.
    expect(await c.open(a)).toEqual({ ok: true });
    c.saveLocalState({ chatDrafts: {} }, opening(c));
    await c.close();
    expect(onDisk(a).chatDrafts).toEqual({});
  });

  it('restores the preview width and zoom chosen in a project when it reopens', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    c.saveLocalState({ viewport: 2400 }, opening(c));
    c.saveLocalState({ zoom: 0.75 }, opening(c));
    await c.close();
    expect(await c.open(a)).toEqual({ ok: true });
    expect(c.snapshot()!.localState).toMatchObject({ viewport: 2400, zoom: 0.75 });
  });

  it('a flush resolves only once the writes queued before it are on disk, and only for the opening it was asked in', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const first = opening(c);
    // Hold the project's queue, as a slow write would, with an edit waiting behind it.
    let release!: () => void;
    const entered = new Promise<void>((started) => {
      void c.session!.exclusive(() => {
        started();
        return new Promise<void>((r) => (release = r));
      });
    });
    await entered;
    try {
      const edit = c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
      // The edit joins the queue once the controller has read the settings (Save waits for the edit itself first).
      await new Promise((r) => setTimeout(r, 30));
      let flushed = false;
      const flush = c.flush(first).then((saved) => {
        flushed = true;
        // The edit is written by the time the flush says so.
        return { saved, site: JSON.parse(readFileSync(join(a, 'siteorigin', 'site.json'), 'utf8')) };
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(flushed).toBe(false);
      release();
      expect(await flush).toEqual({ saved: true, site: expect.objectContaining({ name: 'Renamed' }) });
      expect((await edit).ok).toBe(true);
    } finally {
      release();
    }
    // Nothing is confirmed while the AI is still making changes: Stop would take them back.
    c.aiBusy = () => true;
    expect(await c.flush(first)).toBe(false);
    c.aiBusy = () => false;
    // Nor for an opening that starts closing while the flush waits.
    let reopen!: () => void;
    await new Promise<void>((started) => {
      void c.session!.exclusive(() => {
        started();
        return new Promise<void>((r) => (reopen = r));
      });
    });
    const closingFlush = c.flush(first);
    const closing = c.close();
    reopen();
    expect(await closingFlush).toBe(false);
    await closing;
    // A Save from an earlier opening of the same project, or with none open, confirms nothing.
    expect(await c.open(a)).toEqual({ ok: true });
    await c.close();
    expect(await c.flush(first)).toBe(false);
    expect(await c.flush()).toBe(false);
    expect(await c.open(a)).toEqual({ ok: true });
    expect(await c.flush(first)).toBe(false);
    expect(await c.flush(opening(c))).toBe(true);
  });

  it('an Undo offered in an earlier opening of a project never acts on a later one', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const first = opening(c);
    const r = await c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
    expect(r.entryId).toBeDefined();
    await c.close();
    expect(await c.open(a)).toEqual({ ok: true });
    // The same history entry is still the newest one, but the notification belonged to the earlier opening.
    expect(await c.undoEntry(r.entryId!, first)).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'That change was made in a project that is no longer open.' } });
    expect(c.session!.state.site.name).toBe('Renamed');
    expect((await c.undoEntry(r.entryId!, opening(c))).ok).toBe(true);
    expect(c.session!.state.site.name).toBe('Alpha');
  });

  it('a step chosen in History of an earlier opening of a project never moves a later one (#199)', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const first = opening(c);
    const r = await c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
    await c.close();
    expect(await c.open(a)).toEqual({ ok: true });
    expect(await c.stepHistory(r.entryId!, 'undo', {}, first)).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'That change was made in a project that is no longer open.' } });
    expect(c.session!.state.site.name).toBe('Renamed');
    // In this opening, but chosen from History as it was before the project moved on, or promising other than it would do.
    expect(await c.stepHistory(r.entryId!, 'undo', { revision: c.session!.revision - 1, count: 1 }, opening(c))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(await c.stepHistory(r.entryId!, 'undo', { revision: c.session!.revision, count: 2 }, opening(c))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(c.session!.state.site.name).toBe('Renamed');
    expect((await c.stepHistory(r.entryId!, 'undo', { revision: c.session!.revision, count: 1 }, opening(c))).ok).toBe(true);
    expect(c.session!.state.site.name).toBe('Alpha');
    expect((await c.stepHistory(r.entryId!, 'redo', { revision: c.session!.revision, count: 1 }, opening(c))).ok).toBe(true);
    expect(c.session!.state.site.name).toBe('Renamed');
  });

  it('an edit sent while its project is replaced never lands in the next one', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const revision = c.session!.revision;
    hooks.whileSettingsLoad = async () => {
      await c.close();
      expect(await c.open(a)).toEqual({ ok: true });
    };
    const r = await c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.' } });
    expect(c.session!.state.site.name).toBe('Alpha');
    expect(c.session!.revision).toBe(revision);
  });

  it('an edit sent while its project closes is refused, and so is one made in an earlier opening', async () => {
    const { c, parent } = setup();
    const a = await create(c, parent, 'Alpha');
    const first = opening(c);
    hooks.whileSettingsLoad = () => c.close();
    const closing = await c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site', opening: first });
    expect(closing).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await c.open(a)).toEqual({ ok: true });
    expect(c.session!.state.site.name).toBe('Alpha');
    // The editor still showed the earlier opening when it sent this one.
    const stale = await c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site', opening: first });
    expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'The project was closed before this change could be saved.' } });
    expect(c.session!.state.site.name).toBe('Alpha');
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site', opening: opening(c) })).ok).toBe(true);
  });
});

describe('the opening the File menu follows (#255)', () => {
  it('announces each opening as it starts, and its end as soon as an allowed close begins', async () => {
    const { c, parent } = setup();
    const seen: (string | null)[] = [];
    let atClosing: (string | null)[] = [];
    c.onOpeningChange = () => seen.push(c.openingKey);
    c.onSessionClosing = async () => void (atClosing = [...seen]);
    await create(c, parent, 'Harbour Bakery');
    const a = c.openingKey;
    expect(a).not.toBeNull();
    expect(seen).toEqual([a]);
    // While the editor is still deciding whether the project may be left, it stays open and offered.
    let allow!: (ok: boolean) => void;
    c.beforeLeave = () => new Promise((r) => (allow = r));
    const closing = c.closeProject();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([a]);
    expect(c.openingKey).toBe(a);
    allow(true);
    expect(await closing).toEqual({ ok: true });
    // Export and Close Project are withdrawn before the project is unloaded, not after.
    expect(atClosing).toEqual([a, null]);
    expect(seen).toEqual([a, null]);
  });

  it('a close the editor turns down keeps the opening', async () => {
    const { c, parent } = setup();
    await create(c, parent, 'Harbour Bakery');
    const a = c.openingKey;
    const seen: (string | null)[] = [];
    c.onOpeningChange = () => seen.push(c.openingKey);
    c.beforeLeave = async () => false;
    expect(await c.closeProject()).toEqual({ ok: false });
    expect(seen).toEqual([]);
    expect(c.openingKey).toBe(a);
    c.beforeLeave = null;
  });

  it('a close that fails gives the opening back', async () => {
    const { c, parent } = setup();
    await create(c, parent, 'Harbour Bakery');
    const a = c.openingKey;
    const seen: (string | null)[] = [];
    c.onOpeningChange = () => seen.push(c.openingKey);
    c.onSessionClosing = async () => {
      throw new Error('The disk is full.');
    };
    await expect(c.close()).rejects.toThrow('The disk is full.');
    expect(seen).toEqual([null, a]);
    expect(c.openingKey).toBe(a);
    c.onSessionClosing = null;
  });
});

describe('a deleted conversation’s workspace state (#235)', () => {
  it('drops its draft, images and place as the open conversation, and nothing of another thread', async () => {
    const { c, parent } = setup();
    const dir = await create(c, parent, 'Kiln and Clay');
    const key = opening(c);
    c.saveLocalState({ chatDrafts: { c_gone: 'Ask about the contact form', c_kept: 'Warmer hero' }, chatImages: { c_gone: ['a_1'], c_kept: ['a_2'] }, chatConversation: 'c_gone', rightTab: 'chat' }, key);
    // Another opening's delete changes nothing here.
    c.forgetConversation('c_gone', 'another-opening');
    expect(c.snapshot()!.localState.chatDrafts).toEqual({ c_gone: 'Ask about the contact form', c_kept: 'Warmer hero' });
    c.forgetConversation('c_gone', key);
    // Closing straight after still writes the state without it.
    await c.close();
    expect(onDisk(dir)).toEqual({ chatDrafts: { c_kept: 'Warmer hero' }, chatImages: { c_kept: ['a_2'] }, rightTab: 'chat' });
  });

  it('puts everything back for a delete that failed, and drops a remembered place or images held alone', async () => {
    const { c, parent } = setup();
    await create(c, parent, 'Kiln and Clay');
    const key = opening(c);
    c.saveLocalState({ chatDrafts: { c_gone: 'Ask about the contact form' }, chatImages: { c_gone: ['a_1'] }, chatConversation: 'c_gone' }, key);
    const restore = c.forgetConversation('c_gone', key);
    expect(c.snapshot()!.localState).toMatchObject({ chatDrafts: {}, chatImages: {}, chatConversation: undefined });
    restore();
    expect(c.snapshot()!.localState).toMatchObject({ chatDrafts: { c_gone: 'Ask about the contact form' }, chatImages: { c_gone: ['a_1'] }, chatConversation: 'c_gone' });
    // Put back beside whatever changed meanwhile, which stays: another thread's draft, and another one opened.
    const again = c.forgetConversation('c_gone', key);
    c.saveLocalState({ chatDrafts: { c_new: 'Newer draft' }, chatImages: { c_new: ['a_9'] }, chatConversation: 'c_new' }, key);
    again();
    expect(c.snapshot()!.localState).toMatchObject({ chatDrafts: { c_new: 'Newer draft', c_gone: 'Ask about the contact form' }, chatImages: { c_new: ['a_9'], c_gone: ['a_1'] }, chatConversation: 'c_new' });
    // Only the remembered place, or only images: each goes on its own.
    c.saveLocalState({ chatDrafts: {}, chatImages: {}, chatConversation: 'c_pointer' }, key);
    c.forgetConversation('c_pointer', key);
    expect(c.snapshot()!.localState.chatConversation).toBeUndefined();
    c.saveLocalState({ chatImages: { c_pics: ['a_2'] } }, key);
    c.forgetConversation('c_pics', key);
    expect(c.snapshot()!.localState.chatImages).toEqual({});
  });

  it('leaves the state alone when the conversation had nothing kept', async () => {
    const { c, parent } = setup();
    await create(c, parent, 'Kiln and Clay');
    const key = opening(c);
    c.saveLocalState({ chatDrafts: { c_kept: 'Warmer hero' }, chatConversation: 'c_kept' }, key);
    const before = c.snapshot()!.localState;
    c.forgetConversation('c_other', key);
    expect(c.snapshot()!.localState).toBe(before);
  });
});
