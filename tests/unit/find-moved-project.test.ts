/**
 * A moved project found from its missing Recent projects entry (#217): Find folder… opens the chosen project through
 * the ordinary open and trust flow, and once it has opened the missing entry gives way to it, in the saved list that a
 * restart reads. A cancel, another project of the same name, or an opening that is not listed keeps the entry.
 */
import { EventEmitter } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenDialogReturnValue } from 'electron';

/** A stand-in for Electron's utility process that starts at once and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

/** What the folder picker answers next, in order: a cancel once none are left. */
const env = vi.hoisted(() => ({ userData: '', picks: [] as OpenDialogReturnValue[] }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => env.picks.shift() ?? { canceled: true, filePaths: [] } },
  utilityProcess: { fork: () => new FakeWorker() }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');
const { SCHEMA_VERSION } = await import('@shared/types');
const settings = await import('../../src/main/settings');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-find-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
  env.picks = [];
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function makeProject(parent: string, folder: string, name: string): Promise<string> {
  const dir = join(parent, folder);
  mkdirSync(dir, { recursive: true });
  const created = await ProjectSession.create(dir, createStarterState('blank', name, false));
  await created.close();
  const pkg = '{"name":"site","type":"module"}';
  writeFileSync(join(dir, 'package.json'), pkg);
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  mkdirSync(join(dir, 'node_modules/@sveltejs/kit'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@sveltejs/kit/package.json'), '{"name":"@sveltejs/kit"}');
  mkdirSync(join(dir, 'node_modules/.bin'));
  symlinkSync('../@sveltejs/kit/package.json', join(dir, 'node_modules/.bin/kit'));
  writeFileSync(join(dir, '.siteorigin/cache/deps.json'), JSON.stringify({ lockHash: sha('' + pkg), preparedAt: '2026-01-01T00:00:00.000Z' }));
  return dir;
}

function controller() {
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  return c;
}

/** The next folder picker chooses `dir`. */
const pick = (dir: string) => env.picks.push({ canceled: false, filePaths: [dir] });
const projectId = (dir: string) => JSON.parse(readFileSync(join(dir, 'siteorigin.project.json'), 'utf8')).projectId as string;
/** This test's entries (the settings stay loaded between tests), as the Welcome screen gets them. */
const listed = async (...roots: string[]) => (await settings.recents()).filter((r) => roots.some((root) => r.dir.startsWith(root)));
/** The list as saved, which is what the next start of the app reads. */
const saved = (...roots: string[]) =>
  (JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')) as { recents: Array<{ dir: string; name: string; projectId?: string }> }).recents.filter((r) => roots.some((root) => r.dir.startsWith(root)));

/** Mill Road opened once in its client folder, then closed and moved to delivered work while the app was not looking. */
async function movedMillRoad() {
  const root = temp('work');
  const old = await makeProject(join(root, 'clients'), 'mill-road', 'Mill Road');
  const c = controller();
  expect((await c.trustAndOpen(old)).ok).toBe(true);
  await c.close();
  mkdirSync(join(root, 'delivered'));
  const moved = join(root, 'delivered', 'mill-road');
  renameSync(old, moved);
  return { root, old, moved, c };
}

describe('finding a moved project from its missing recent entry (#217)', () => {
  it('lists each project with its own ID, through a rename of its site', async () => {
    const root = temp('work');
    const dir = await makeProject(root, 'mill-road', 'Mill Road');
    const c = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Mill Road Bakery' }] }, { label: 'Rename site' })).ok).toBe(true);
    await c.close();
    expect(saved(root)).toEqual([expect.objectContaining({ dir, name: 'Mill Road Bakery', projectId: projectId(dir) })]);
  });

  it('replaces the missing entry with the moved folder once it has opened, even when the moved folder is listed already, and keeps it so after a restart', async () => {
    const { root, old, moved, c } = await movedMillRoad();
    expect(await listed(root)).toEqual([expect.objectContaining({ dir: old, name: 'Mill Road', missing: true })]);

    // The report: Open project on the moved folder lists it beside the missing entry, which stays.
    expect((await c.open(moved)).needsTrust).toEqual({ dir: moved, name: 'Mill Road' });
    expect((await c.trustAndOpen(moved)).ok).toBe(true);
    await c.close();
    expect((await listed(root)).map((r) => [r.dir, r.missing])).toEqual([
      [moved, false],
      [old, true]
    ]);

    // Find folder… on the missing entry, choosing the moved folder: it opens, and the list has Mill Road once.
    pick(moved);
    expect(await c.open(undefined, { folder: true, replaces: old })).toEqual({ ok: true });
    expect(c.session?.dir).toBe(moved);
    expect((await listed(root)).map((r) => [r.dir, r.missing])).toEqual([[moved, false]]);
    expect(saved(root).map((r) => r.dir)).toEqual([moved]);

    // A restart reads the same list back.
    vi.resetModules();
    const fresh = await import('../../src/main/settings');
    expect((await fresh.recents()).filter((r) => r.dir.startsWith(root)).map((r) => [r.dir, r.name, r.missing])).toEqual([[moved, 'Mill Road', false]]);
  });

  it('keeps the missing entry when the picker or the trust prompt is cancelled, and replaces it once trusted', async () => {
    const { root, old, moved, c } = await movedMillRoad();
    // The picker cancelled.
    expect(await c.open(undefined, { folder: true, replaces: old })).toEqual({ ok: false });
    expect((await listed(root)).map((r) => r.dir)).toEqual([old]);
    // The moved folder is not trusted at its new place: the open stops at the trust prompt, and Cancel ends it there.
    pick(moved);
    expect(await c.open(undefined, { folder: true, replaces: old })).toEqual({ ok: false, needsTrust: { dir: moved, name: 'Mill Road' } });
    expect((await listed(root)).map((r) => r.dir)).toEqual([old]);
    // Trust and open, asked for the same entry: the moved folder takes its place.
    expect(await c.trustAndOpen(moved, { replaces: old })).toEqual({ ok: true });
    expect((await listed(root)).map((r) => [r.dir, r.missing])).toEqual([[moved, false]]);
    expect(saved(root).map((r) => r.dir)).toEqual([moved]);
  });

  it('keeps the missing entry when another project of the same name, in a folder of the same name, is chosen', async () => {
    const { root, old, moved, c } = await movedMillRoad();
    const other = await makeProject(join(root, 'another-client'), 'mill-road', 'Mill Road');
    expect(projectId(other)).not.toBe(projectId(moved));
    pick(other);
    const asked = await c.open(undefined, { folder: true, replaces: old });
    expect(asked.needsTrust?.dir).toBe(other);
    // It opens as any project does, listed beside the entry it was not.
    expect(await c.trustAndOpen(other, { replaces: old })).toEqual({ ok: true });
    expect(c.session?.dir).toBe(other);
    expect((await listed(root)).map((r) => [r.dir, r.missing])).toEqual([
      [other, false],
      [old, true]
    ]);
    expect(saved(root).map((r) => r.dir)).toEqual([other, old]);
  });

  it('keeps the entry when its own folder is back, and when the project found opens read-only', async () => {
    // A copy made in Finder shares its original's ID; the original's folder is still there, so its entry stays.
    const root = temp('work');
    const original = await makeProject(join(root, 'clients'), 'mill-road', 'Mill Road');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    await c.close();
    const copy = join(root, 'delivered', 'mill-road');
    mkdirSync(join(root, 'delivered'));
    cpSync(original, copy, { recursive: true, verbatimSymlinks: true });
    expect(await c.trustAndOpen(copy, { replaces: original })).toEqual({ ok: true });
    await c.close();
    expect((await listed(root)).map((r) => r.dir).sort()).toEqual([copy, original].sort());

    // The moved folder is in a newer format: it opens read-only, unlisted, and the missing entry stays.
    rmSync(original, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(copy, 'siteorigin.project.json'), 'utf8'));
    rmSync(join(copy, 'siteorigin.project.json'));
    const moved = join(root, 'moved', 'mill-road');
    mkdirSync(join(root, 'moved'));
    renameSync(copy, moved);
    writeFileSync(join(moved, 'siteorigin.project.json'), JSON.stringify({ ...manifest, schemaVersion: SCHEMA_VERSION + 1 }));
    expect(await c.trustAndOpen(moved, { replaces: original })).toEqual({ ok: true });
    expect(c.session?.readOnly).toBeTruthy();
    expect((await listed(root)).map((r) => [r.dir, r.missing])).toEqual([
      [copy, true],
      [original, true]
    ]);
  });
});

describe('the recent entry a found project replaces', () => {
  const at = (dir: string, name: string, projectId?: string) => ({ dir, name, openedAt: '2026-01-01T00:00:00.000Z', ...(projectId ? { projectId } : {}) });

  it('matches an entry listed before IDs were kept by its name and its folder’s name together', async () => {
    const root = temp('legacy');
    const s = await settings.loadSettings();
    const gone = join(root, 'clients', 'mill-road');
    s.recents = [at(gone, 'Mill Road')];
    const elsewhere = join(root, 'harbour', 'harbour-site');
    const renamed = join(root, 'renamed', 'mill-road');
    const moved = join(root, 'delivered', 'mill-road');
    // Same name in another folder, or the same folder name under another name: not the project that was listed.
    await settings.addRecent(elsewhere, 'Mill Road', 'pharbour', gone);
    await settings.addRecent(renamed, 'Mill Road Bakery', 'pbakery', gone);
    expect((await listed(root)).map((r) => r.dir)).toEqual([renamed, elsewhere, gone]);
    await settings.addRecent(moved, 'Mill Road', 'pmill', gone);
    expect((await listed(root)).map((r) => r.dir)).toEqual([moved, renamed, elsewhere]);
    expect(saved(root).find((r) => r.dir === moved)?.projectId).toBe('pmill');
  });

  it('is never pushed off a full list by another project opened for it', async () => {
    const root = temp('full');
    const s = await settings.loadSettings();
    const gone = join(root, 'gone', 'mill-road');
    s.recents = [...Array.from({ length: 19 }, (_, i) => at(join(root, `p${i}`), `P${i}`, `id${i}`)), at(gone, 'Mill Road', 'pmill')];
    await settings.addRecent(join(root, 'other', 'mill-road'), 'Mill Road', 'pother', gone);
    const list = s.recents.map((r) => r.dir);
    expect(list).toHaveLength(20);
    expect(list[0]).toBe(join(root, 'other', 'mill-road'));
    expect(list[19]).toBe(gone);
    expect(list).not.toContain(join(root, 'p18'));
    // Any other opening drops the oldest as before.
    await settings.addRecent(join(root, 'new'), 'New', 'pnew');
    expect(s.recents).toHaveLength(20);
    expect(s.recents.at(-1)?.dir).toBe(join(root, 'p17'));
  });
});
