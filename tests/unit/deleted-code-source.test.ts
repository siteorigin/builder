/**
 * A code component's file deleted outside the app while the project is open (#1540). The deletion is noticed when the
 * watch tells of it: the component keeps the source last loaded, the file is held as a conflict naming the component,
 * and the author chooses to put the file back from that version or to remove the component and its placements.
 *
 * The controller's watches here are told what changed by the test, as the system tells them.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
type FakeWatch = { tell: (event: string, file: string | null) => void; watch: import('node:events').EventEmitter };
const watches = vi.hoisted(() => new Map<string, FakeWatch>());
vi.mock('../../src/main/folder-watch', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    watchTree: (dir: string, tell: (event: string, file: string | null) => void) => {
      const watch = Object.assign(new EventEmitter(), { close: () => watches.get(dir)?.watch === watch && watches.delete(dir) });
      watches.set(dir, { tell, watch });
      return watch;
    }
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: {}
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { instancesOf } = await import('@engine/tree');

type Session = InstanceType<typeof ProjectSession>;
type Attaching = { attach(s: unknown, workspace: object, runtime: object): Promise<void> };
const dirs: string[] = [];
const sessions: Session[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-deleted-code-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) await c.close();
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const SOURCE = '<p>Two columns</p>\n';

/** A project open in a controller with its watches running, with a code component placed on Home. */
async function openWithPlacedCode() {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('business', 'Deleted Code', false))).close();
  const session = await ProjectSession.open(dir, 'this-window');
  sessions.push(session);
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  await (c as unknown as Attaching).attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  const home = session.state.site.homePageId;
  const made = await session.apply({ operations: [{ type: 'component.createCode', name: 'Two Columns', source: SOURCE }] }, { label: 'Add Two Columns' });
  expect(made.ok).toBe(true);
  const def = Object.values(session.state.components).find((d) => d.name === 'Two Columns')!;
  expect((await session.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: home }, definitionId: def.id }] }, { label: 'Place' })).ok).toBe(true);
  const tell = (...files: string[]) => {
    for (const f of files) {
      const root = [...watches.keys()].filter((w) => f.startsWith(`${relative(dir, w).split(sep).join('/')}/`)).sort((x, y) => y.length - x.length)[0];
      expect(root, `no watch covers ${f}`).toBeDefined();
      watches.get(root)!.tell('rename', relative(root, join(dir, f)));
    }
  };
  return { dir, c, session, tell, home, def, path: def.sourcePath! };
}

const conflictOf = (s: Session, path: string) => s.conflicts.find((x) => x.path === path);
type Blocking = { exportBlocked(): { ok: boolean; message: string } | null };

/** The file deleted outside the app and the deletion seen by the watch. */
async function deleteOutside(o: Awaited<ReturnType<typeof openWithPlacedCode>>) {
  unlinkSync(join(o.dir, o.path));
  o.tell(o.path);
  await vi.waitFor(() => expect(conflictOf(o.session, o.path)).toBeDefined(), { timeout: 5000, interval: 20 });
}

describe('a code component’s file deleted outside the app (#1540)', () => {
  it('is noticed at once: the component keeps its loaded code and the file is held, naming the component', async () => {
    const o = await openWithPlacedCode();
    const { dir, session, def, path, c } = o;
    const undoLabel = session.historyInfo().undoLabel;
    const revision = session.revision;
    expect(readFileSync(join(dir, path), 'utf8')).toBe(SOURCE);
    await deleteOutside(o);
    expect(conflictOf(session, path)).toMatchObject({ kind: 'canonical', reason: 'Deleted outside SiteOrigin Builder.', deletedCode: { definitionId: def.id } });
    expect(session.state.components[def.id].source).toBe(SOURCE);
    expect(existsSync(join(dir, path))).toBe(false);
    // Nothing of the project changed: no step of History, no new revision.
    expect(session.historyInfo().undoLabel).toBe(undoLabel);
    expect(session.revision).toBe(revision);
    // The export says which component's file is gone.
    expect((c as unknown as Blocking).exportBlocked()?.message).toContain('“Two Columns”');
  });

  it('puts the file back from the code last loaded', async () => {
    const o = await openWithPlacedCode();
    // Loaded again since it was made: the newer code is what goes back.
    const newer = '<p>Two columns, edited</p>\n';
    writeFileSync(join(o.dir, o.path), newer);
    o.tell(o.path);
    await vi.waitFor(() => expect(o.session.state.components[o.def.id].source).toBe(newer), { timeout: 5000, interval: 20 });
    await deleteOutside(o);
    expect(await o.session.resolveConflict(o.path, 'restore')).toEqual({ ok: true });
    expect(readFileSync(join(o.dir, o.path), 'utf8')).toBe(newer);
    expect(o.session.conflicts).toEqual([]);
    expect(o.session.state.components[o.def.id].source).toBe(newer);
    expect(o.session.diagnostics().some((d) => d.code === 'CODE_SOURCE_MISSING')).toBe(false);
  });

  it('removes only in the opening it was chosen in, and refuses once the file is settled', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    const ctl = o.c as unknown as { resolveConflict(p: string, c: string, opts?: object): Promise<{ ok: boolean; message?: string }>; workspaceKey: string };
    expect((await ctl.resolveConflict(o.path, 'remove', { opening: 'another-opening' })).ok).toBe(false);
    expect(Object.hasOwn(o.session.state.components, o.def.id)).toBe(true);
    expect((await ctl.resolveConflict(o.path, 'remove', { opening: ctl.workspaceKey })).ok).toBe(true);
    expect(Object.hasOwn(o.session.state.components, o.def.id)).toBe(false);
    // Asked again, with nothing held, it says so rather than claim a removal.
    const again = await o.session.resolveConflict(o.path, 'remove');
    expect(again.ok).toBe(false);
  });

  it('waits for a page changed outside the app that the watch has not delivered', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    const other = o.session.state.site.pageOrder.find((id) => id !== o.home)!;
    const rel = `siteorigin/pages/${other}.json`;
    const doc = JSON.parse(readFileSync(join(o.dir, rel), 'utf8'));
    doc.title = 'Edited elsewhere';
    writeFileSync(join(o.dir, rel), JSON.stringify(doc, null, 2));
    const r = await o.session.resolveConflict(o.path, 'remove');
    expect(r.ok).toBe(false);
    expect(r.message).toContain(rel);
    expect(Object.hasOwn(o.session.state.components, o.def.id)).toBe(true);
    expect(conflictOf(o.session, o.path)?.deletedCode).toBeDefined();
  });

  it('removes one of two components whose files were both deleted, the other still held', async () => {
    const o = await openWithPlacedCode();
    expect((await o.session.apply({ operations: [{ type: 'component.createCode', name: 'Banner', source: '<p>Banner</p>\n' }] }, { label: 'Add Banner' })).ok).toBe(true);
    const banner = Object.values(o.session.state.components).find((d) => d.name === 'Banner')!;
    unlinkSync(join(o.dir, banner.sourcePath!));
    unlinkSync(join(o.dir, o.path));
    o.tell(banner.sourcePath!, o.path);
    await vi.waitFor(() => expect(o.session.conflicts).toHaveLength(2), { timeout: 5000, interval: 20 });
    // The other file put back, not loaded yet: it may need this component now, so it is loaded first.
    writeFileSync(join(o.dir, banner.sourcePath!), '<p>Banner</p>\n');
    const waits = await o.session.resolveConflict(o.path, 'remove');
    expect(waits.ok).toBe(false);
    expect(waits.message).toContain(banner.sourcePath!);
    unlinkSync(join(o.dir, banner.sourcePath!));
    expect(await o.session.resolveConflict(o.path, 'remove')).toEqual({ ok: true });
    expect(o.session.conflicts.map((x) => x.path)).toEqual([banner.sourcePath]);
    expect(o.session.state.components[banner.id].source).toBe('<p>Banner</p>\n');
  });

  it('removes the component and its placements in one step that Undo takes back, file and all', async () => {
    const o = await openWithPlacedCode();
    const { session, def, home, dir, path } = o;
    const placed = () => Object.values(session.state.pages[home].nodes).filter((n) => n.kind === 'instance' && n.definitionId === def.id).length;
    expect(placed()).toBe(1);
    await deleteOutside(o);
    expect(await session.resolveConflict(path, 'remove')).toEqual({ ok: true });
    expect(session.conflicts).toEqual([]);
    expect(Object.hasOwn(session.state.components, def.id)).toBe(false);
    expect(placed()).toBe(0);
    expect(existsSync(join(dir, path))).toBe(false);
    expect(existsSync(join(dir, `siteorigin/components/${def.id}/component.json`))).toBe(false);
    expect(session.historyInfo().undoLabel).toBe('Remove “Two Columns” and its placement');
    expect((await session.undo()).ok).toBe(true);
    expect(session.state.components[def.id].source).toBe(SOURCE);
    expect(readFileSync(join(dir, path), 'utf8')).toBe(SOURCE);
    expect(placed()).toBe(1);
  });

  it('removes every placement, on every page, and counts them in the step’s name', async () => {
    const o = await openWithPlacedCode();
    const { session, def, path } = o;
    const other = session.state.site.pageOrder.find((id) => id !== o.home)!;
    const placed = await session.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: o.home }, definitionId: def.id }, { type: 'node.insert', owner: { kind: 'page', id: other }, definitionId: def.id }] }, { label: 'Place twice more' });
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    expect(instancesOf(session.state, def.id)).toHaveLength(3);
    await deleteOutside(o);
    expect(await session.resolveConflict(path, 'remove')).toEqual({ ok: true });
    expect(instancesOf(session.state, def.id)).toHaveLength(0);
    expect(session.historyInfo().undoLabel).toBe('Remove “Two Columns” and its 3 placements');
  });

  it('refuses to keep the file deleted, and to remove the component once the file is back', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    expect((await o.session.resolveConflict(o.path, 'keep')).ok).toBe(false);
    writeFileSync(join(o.dir, o.path), SOURCE);
    const r = await o.session.resolveConflict(o.path, 'remove');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('is back');
    expect(Object.hasOwn(o.session.state.components, o.def.id)).toBe(true);
    expect(readFileSync(join(o.dir, o.path), 'utf8')).toBe(SOURCE);
  });

  it('settles itself when the file is put back as it was, and is an ordinary conflict when other code comes back', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    writeFileSync(join(o.dir, o.path), SOURCE);
    o.tell(o.path);
    await vi.waitFor(() => expect(o.session.conflicts).toEqual([]), { timeout: 5000, interval: 20 });
    await deleteOutside(o);
    writeFileSync(join(o.dir, o.path), '<p>Other</p>\n');
    o.tell(o.path);
    await vi.waitFor(() => expect(conflictOf(o.session, o.path)?.deletedCode).toBeUndefined(), { timeout: 5000, interval: 20 });
    expect(conflictOf(o.session, o.path)).toMatchObject({ reason: 'Changed outside SiteOrigin Builder.' });
    expect(o.session.state.components[o.def.id].source).toBe(SOURCE);
    // Deleted again, it is a deleted file again: Keep is refused, and the choices are back.
    unlinkSync(join(o.dir, o.path));
    o.tell(o.path);
    await vi.waitFor(() => expect(conflictOf(o.session, o.path)?.deletedCode).toEqual({ definitionId: o.def.id }), { timeout: 5000, interval: 20 });
    expect((await o.session.resolveConflict(o.path, 'keep')).ok).toBe(false);
    writeFileSync(join(o.dir, o.path), '<p>Other</p>\n');
    o.tell(o.path);
    await vi.waitFor(() => expect(conflictOf(o.session, o.path)?.deletedCode).toBeUndefined(), { timeout: 5000, interval: 20 });
    expect(await o.session.resolveConflict(o.path, 'keep')).toEqual({ ok: true });
    expect(o.session.state.components[o.def.id].source).toBe('<p>Other</p>\n');
  });

  it('is a changed file at reopen when other code was put back while the project was closed', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    for (const c of controllers.splice(0)) await c.close();
    await o.session.close();
    writeFileSync(join(o.dir, o.path), '<p>Other</p>\n');
    const again = await ProjectSession.open(o.dir, 'this-window');
    sessions.push(again);
    expect(conflictOf(again, o.path)).toMatchObject({ reason: 'Changed outside SiteOrigin Builder.' });
    expect(conflictOf(again, o.path)?.deletedCode).toBeUndefined();
    expect(again.state.components[o.def.id].source).toBe(SOURCE);
  });

  it('is a deleted file again at reopen when a changed file’s hold lost its file while the project was closed', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    writeFileSync(join(o.dir, o.path), '<p>Other</p>\n');
    o.tell(o.path);
    await vi.waitFor(() => expect(conflictOf(o.session, o.path)?.deletedCode).toBeUndefined(), { timeout: 5000, interval: 20 });
    for (const c of controllers.splice(0)) await c.close();
    await o.session.close();
    unlinkSync(join(o.dir, o.path));
    const again = await ProjectSession.open(o.dir, 'this-window');
    sessions.push(again);
    expect(conflictOf(again, o.path)).toMatchObject({ reason: 'Deleted outside SiteOrigin Builder.', deletedCode: { definitionId: o.def.id } });
    expect(await again.resolveConflict(o.path, 'remove')).toEqual({ ok: true });
  });

  it('lets go at reopen of a hold whose component has gone', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    // Removed, as a removal stopped by a crash just before the hold was let go would leave it.
    const remove = (o.session as unknown as { removeDeletedCodeLocked(c: object): Promise<unknown>; saveConflicts(): Promise<void> }).removeDeletedCodeLocked.bind(o.session);
    const save = vi.spyOn(o.session as unknown as { saveConflicts(): Promise<void> }, 'saveConflicts').mockResolvedValue(undefined);
    expect(await remove(conflictOf(o.session, o.path)!)).toEqual({ ok: true });
    save.mockRestore();
    for (const c of controllers.splice(0)) await c.close();
    await o.session.close();
    expect(JSON.parse(readFileSync(join(o.dir, '.siteorigin/conflicts.json'), 'utf8')).conflicts).toHaveLength(1);
    const again = await ProjectSession.open(o.dir, 'this-window');
    sessions.push(again);
    expect(again.conflicts).toEqual([]);
    expect(Object.hasOwn(again.state.components, o.def.id)).toBe(false);
    // Forgotten on disk too.
    expect(existsSync(join(o.dir, '.siteorigin/conflicts.json'))).toBe(false);
  });

  it('stays held across a reopen, with the code last loaded', async () => {
    const o = await openWithPlacedCode();
    await deleteOutside(o);
    for (const c of controllers.splice(0)) await c.close();
    await o.session.close();
    const again = await ProjectSession.open(o.dir, 'this-window');
    sessions.push(again);
    expect(conflictOf(again, o.path)).toMatchObject({ deletedCode: { definitionId: o.def.id } });
    expect(again.state.components[o.def.id].source).toBe(SOURCE);
    expect(again.diagnostics().some((d) => d.code === 'CODE_SOURCE_MISSING')).toBe(false);
    expect(await again.resolveConflict(o.path, 'restore')).toEqual({ ok: true });
    expect(readFileSync(join(o.dir, o.path), 'utf8')).toBe(SOURCE);
  });

  it('opened with the file already gone, names the component in Project health and the export', async () => {
    const o = await openWithPlacedCode();
    for (const c of controllers.splice(0)) await c.close();
    await o.session.close();
    unlinkSync(join(o.dir, o.path));
    const again = await ProjectSession.open(o.dir, 'this-window');
    sessions.push(again);
    const c = new Controller(() => null);
    c.send = () => undefined;
    controllers.push(c);
    await (c as unknown as Attaching).attach(again, {}, { state: 'error', message: 'No preview in this test.' });
    // Nothing was loaded to put back, so nothing is held.
    expect(again.conflicts).toEqual([]);
    const missing = again.diagnostics().filter((d) => d.code === 'CODE_SOURCE_MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ severity: 'error', owner: { kind: 'component', id: o.def.id } });
    expect(missing[0].message).toContain('“Two Columns”');
    expect(missing[0].message).toContain(o.path);
    expect((c as unknown as Blocking).exportBlocked()?.message).toContain('“Two Columns”');
    // Put back by hand, it loads, and the problem goes.
    writeFileSync(join(o.dir, o.path), SOURCE);
    const tell = (f: string) => {
      const root = [...watches.keys()].filter((w) => f.startsWith(`${relative(o.dir, w).split(sep).join('/')}/`)).sort((x, y) => y.length - x.length)[0];
      watches.get(root)!.tell('rename', relative(root, join(o.dir, f)));
    };
    tell(o.path);
    await vi.waitFor(() => expect(again.state.components[o.def.id].source).toBe(SOURCE), { timeout: 5000, interval: 20 });
    expect(again.diagnostics().some((d) => d.code === 'CODE_SOURCE_MISSING')).toBe(false);
    expect((c as unknown as Blocking).exportBlocked()).toBeNull();
  });

  it('opened with the file gone, takes it back as an empty file put there', async () => {
    const o = await openWithPlacedCode();
    for (const c of controllers.splice(0)) await c.close();
    await o.session.close();
    unlinkSync(join(o.dir, o.path));
    const again = await ProjectSession.open(o.dir, 'this-window');
    sessions.push(again);
    const c = new Controller(() => null);
    c.send = () => undefined;
    controllers.push(c);
    await (c as unknown as Attaching).attach(again, {}, { state: 'error', message: 'No preview in this test.' });
    expect(again.diagnostics().some((d) => d.code === 'CODE_SOURCE_MISSING')).toBe(true);
    // An empty file reads as the empty code the project already had: still, the file is there now.
    writeFileSync(join(o.dir, o.path), '');
    const root = [...watches.keys()].filter((w) => o.path.startsWith(`${relative(o.dir, w).split(sep).join('/')}/`)).sort((x, y) => y.length - x.length)[0];
    watches.get(root)!.tell('rename', relative(root, join(o.dir, o.path)));
    await vi.waitFor(() => expect(again.diagnostics().some((d) => d.code === 'CODE_SOURCE_MISSING')).toBe(false), { timeout: 5000, interval: 20 });
  });
});
