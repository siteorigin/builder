/**
 * An open project whose folder is removed or renamed (issue 830): no watch on it throws, and the project is reported
 * as gone rather than left to fail at the next write.
 */
import type { FolderWatch } from '../../src/main/folder-watch';
import { existsSync, mkdtempSync, promises as fs, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from './editor-feed';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: {}
}));

const { Controller, FOLDER_POLL_MS } = await import('../../src/main/controller');
const { LOCK_HEARTBEAT_MS, ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-gone-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

type Watching = { watchers: FolderWatch[]; stageWatchers: FolderWatch[]; watchStageSources(s: unknown): void; attach(s: unknown, workspace: object, runtime: object): Promise<void> };

/**
 * A watch just started may not report yet (macOS starts its events a moment later, much later on a busy machine), and
 * what happens before then is never told. So a file the app ignores is touched until a watch reports it.
 */
async function untilWatching(dir: string, session: InstanceType<typeof ProjectSession>) {
  const look = vi.spyOn(session, 'checkFolder');
  let touched = 0;
  await vi.waitFor(
    () => {
      if (!look.mock.calls.length) {
        // Rarely enough that the look each report asks for is not put off for ever.
        if (Date.now() - touched > 1000) {
          touched = Date.now();
          const probe = join(dir, 'siteorigin', `probe-${touched}.probe`);
          writeFileSync(probe, String(touched));
        }
        throw new Error('No watch has reported yet.');
      }
    },
    { timeout: 15_000, interval: 50 }
  );
  look.mockRestore();
}

/** A project open for editing, its watches running. No preview is started. */
async function openProject() {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('blank', 'Gone Site', false))).close();
  const session = await ProjectSession.open(dir, 'this-window');
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  const view = editorView();
  c.send = (channel: string, payload?: unknown) => void sent.push([channel, view(channel, payload)]);
  controllers.push(c);
  const inside = c as unknown as Watching;
  await inside.attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  // The icons attach leaves publishing take the lock claim too: done here, they cannot be what notices a folder gone.
  await session.refreshSiteIcons().catch(() => null);
  await untilWatching(dir, session);
  return { dir, c, session, sent, inside, watchers: inside.watchers };
}

async function expectReportedGone(c: InstanceType<typeof Controller>) {
  await vi.waitFor(() => expect(c.snapshot()?.readOnly?.reason).toMatch(/project folder is gone/i), { timeout: 15_000 });
  expect(c.snapshot()?.readOnly?.canUnlock).toBe(false);
  expect(c.snapshot()?.runtime).toMatchObject({ state: 'unavailable', message: expect.stringMatching(/project folder is gone/i) });
}

// Each opens a real project on disk and waits on real watches: room for a busy machine.
describe('an open project whose folder goes away', { timeout: 30_000 }, () => {
  it('survives an error from any of its watches, closing it and looking for the folder', async () => {
    const { session, inside, watchers } = await openProject();
    inside.watchStageSources(session);
    const all = [...watchers, ...inside.stageWatchers];
    expect(watchers).toHaveLength(3);
    expect(inside.stageWatchers.length).toBeGreaterThan(0);
    const look = vi.spyOn(session, 'checkFolder');
    for (const w of all) {
      const close = vi.spyOn(w, 'close');
      look.mockClear();
      // As Windows ends a watch whose folder went: with no handler, this is thrown.
      expect(() => w.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }))).not.toThrow();
      expect(close).toHaveBeenCalled();
      await vi.waitFor(() => expect(look).toHaveBeenCalled(), { timeout: 15_000 });
    }
    for (const w of inside.stageWatchers.splice(0)) w.close();
  });

  it('is reported as gone when it is removed, and can still be closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { dir, c, sent } = await openProject();
    rmSync(dir, { recursive: true, force: true });
    // The watches usually report it; a busy Mac sometimes never does, and then the app's slow look finds it.
    vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
    await expectReportedGone(c);
    expect(sent).toContainEqual(['project:changed', expect.objectContaining({ readOnly: expect.objectContaining({ reason: expect.stringMatching(/project folder is gone/i) }) })]);
    expect((await c.closeProject()).ok).toBe(true);
    expect(c.session).toBeNull();
    expect(sent.map(([channel]) => channel)).toContain('project:closed');
    // Nothing the app did afterwards made the folder again.
    expect(existsSync(dir)).toBe(false);
  });

  it('is reported as gone at the next lock check when it is renamed', async () => {
    const { dir, c, session, watchers } = await openProject();
    if (process.platform === 'win32') {
      // Windows will not rename a folder while anything inside it is held open, as the watches of its folders are: a
      // project open in the app cannot be renamed there. Once they have stopped it can, and is found gone all the same.
      expect(() => renameSync(dir, `${dir}-moved`)).toThrow(expect.objectContaining({ code: 'EPERM' }));
      for (const w of watchers) w.close();
    }
    renameSync(dir, `${dir}-moved`);
    await expect(session.refreshLock()).resolves.toBe('unknown');
    await expectReportedGone(c);
    await expect(session.stillOwner()).resolves.toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('is reported as gone within a second of a rename that no watch reports, well before the lock check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { dir, c, watchers } = await openProject();
    for (const w of watchers) w.close();
    // The looks the watches last asked for (300 ms, 400 ms) have been and gone: only the app's own timing can notice.
    await new Promise((r) => setTimeout(r, 800));
    renameSync(dir, `${dir}-moved`);
    expect(FOLDER_POLL_MS).toBeLessThan(LOCK_HEARTBEAT_MS);
    vi.advanceTimersByTime(FOLDER_POLL_MS);
    // The preview stops (lock-lost) and the editor shows the folder gone, with no edit and no lock check.
    await expectReportedGone(c);
    expect(existsSync(dir)).toBe(false);
  });

  it('is not mistaken for a removed lock when it goes during a lock check', async () => {
    const { dir, c, session, watchers } = await openProject();
    for (const w of watchers) w.close();
    const open = fs.open;
    // The folder goes once the check has its claim, just as it reads the lock.
    let went = false;
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (!went && flags === 'r' && String(path) === join(dir, '.siteorigin', 'lock.json')) {
        went = true;
        rmSync(dir, { recursive: true, force: true });
      }
      return open(path, flags, mode);
    });
    await expect(session.refreshLock()).resolves.toBe('unknown');
    expect(went).toBe(true);
    await expectReportedGone(c);
  });

  it('is reported as gone when a read-only project moves and no watch says so', async () => {
    const dir = join(temp('project'), 'site');
    await (await ProjectSession.create(dir, createStarterState('blank', 'Gone Site', false))).close();
    const session = await ProjectSession.openReadOnly(dir, { reason: 'Another app has it.', canUnlock: true });
    const c = new Controller(() => null);
    c.send = () => undefined;
    controllers.push(c);
    const inside = c as unknown as Watching;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await inside.attach(session, {}, { state: 'error', message: 'No preview in this test.' });
    for (const w of inside.watchers) w.close();
    renameSync(dir, `${dir}-moved`);
    vi.advanceTimersByTime(LOCK_HEARTBEAT_MS);
    await expectReportedGone(c);
    await c.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is still watched after a close that failed', async () => {
    const { dir, c, inside, watchers } = await openProject();
    c.onSessionClosing = async () => {
      throw new Error('Not yet.');
    };
    await expect(c.closeProject()).rejects.toThrow('Not yet.');
    c.onSessionClosing = null;
    expect(inside.watchers).toHaveLength(3);
    expect(inside.watchers.some((w) => watchers.includes(w))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    // Told by the new watch's error, not by when the system gets round to reporting the removal.
    inside.watchers[0].emit('error', new Error('EPERM'));
    await expectReportedGone(c);
  });

  it('is not called gone while it still has either of its own files, and its other lock errors are not hidden', async () => {
    const { dir, session, watchers } = await openProject();
    for (const w of watchers) w.close();
    const manifest = join(dir, 'siteorigin.project.json');
    renameSync(manifest, `${manifest}.aside`);
    await expect(session.checkFolder()).resolves.toBe(false);
    const open = fs.open;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path).includes('.claim.')) throw Object.assign(new Error('EACCES: claim refused'), { code: 'EACCES' });
      return open(path, flags, mode);
    });
    await expect(session.refreshLock()).rejects.toThrow('claim refused');
    spy.mockRestore();
    renameSync(`${manifest}.aside`, manifest);
    await expect(session.stillOwner()).resolves.toBe(true);
  });

  it('can be closed when nothing noticed before the close', async () => {
    const { dir, c, watchers } = await openProject();
    for (const w of watchers) w.close();
    rmSync(dir, { recursive: true, force: true });
    expect((await c.closeProject()).ok).toBe(true);
    expect(c.session).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('stays open and editable when only a watched folder is removed', async () => {
    const { dir, c, session, watchers } = await openProject();
    rmSync(join(dir, 'static'), { recursive: true, force: true });
    for (const w of watchers) w.emit('error', new Error('EPERM'));
    await new Promise((r) => setTimeout(r, 800));
    expect(c.snapshot()?.readOnly).toBeNull();
    await expect(session.stillOwner()).resolves.toBe(true);
  });
});
