/**
 * The editor's copy of the open project, as the controller sends it (#967): each change against the copy sent before.
 * Through edits, undo, redo, a version restored, a change made outside the app and a page loaded again, the editor ends
 * up holding exactly the snapshot the main process does, keeping the documents a change did not touch.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSnapshot } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState } from '@shared/types';
import { ProjectFeedReader, type ProjectChange } from '@shared/project-feed';

const env = vi.hoisted(() => ({ userData: '' }));
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

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-feed-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

type Attaching = { attach(s: unknown, workspace: object, runtime: object): Promise<void> };

/** A project open for editing with no preview, and an editor reading what it is sent, through IPC's copy. */
async function openProject() {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('business', 'Feed Site', false))).close();
  const session = await ProjectSession.open(dir, 'this-window');
  const c = new Controller(() => null);
  controllers.push(c);
  const editor = { reader: new ProjectFeedReader(), changes: [] as ProjectChange[], unread: 0 };
  c.send = (channel: string, payload?: unknown) => {
    if (channel !== 'project:changed') return;
    const change = structuredClone(payload) as ProjectChange;
    editor.changes.push(change);
    if (!editor.reader.read(change)) editor.unread++;
  };
  await (c as unknown as Attaching).attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  return { dir, c, session, editor };
}

/**
 * Where two values differ, or null when they are the same: the same own keys in the same order, each the same, by
 * Object.is for anything that is not an object. What IPC's copy keeps apart, so is told apart here.
 */
function difference(a: unknown, b: unknown, at = 'snapshot'): string | null {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b) ? null : `${at}: ${String(a)} is not ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: a list and not a list`;
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return `${at}: keys ${ka.map(String).join(',')} are not ${kb.map(String).join(',')}`;
  for (const k of ka) {
    const d = difference((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k], `${at}.${String(k)}`);
    if (d) return d;
  }
  return null;
}
/** The editor holds exactly what the main process does, once the change has been sent. */
async function settled(c: InstanceType<typeof Controller>, reader: ProjectFeedReader) {
  await vi.waitFor(() => expect(difference(reader.snapshot, structuredClone(c.snapshot()))).toBeNull(), { timeout: 10_000 });
}
/** The state's changes in the patch just sent, by record and document: what crossed to the editor. */
function sentDocs(change: ProjectChange): string[] {
  if (change.base === null) return ['(whole)'];
  const out: string[] = [];
  const walk = (p: { set?: Record<string, unknown>; sub?: Record<string, never> } | undefined, at: string) => {
    for (const k of Object.keys(p?.set ?? {})) out.push(`${at}${k}`);
    for (const [k, q] of Object.entries(p?.sub ?? {})) walk(q, `${at}${k}.`);
  };
  walk(change.state as never, '');
  return out;
}

function textOnHome(s: ProjectState): { nodeId: string; prop: string } {
  const home = s.pages[s.site.homePageId];
  for (const [nodeId, node] of Object.entries(home.nodes)) {
    if (node.kind !== 'instance') continue;
    const prop = Object.entries((node as InstanceNode).props).find(([, v]) => typeof v === 'string')?.[0];
    if (prop) return { nodeId, prop };
  }
  throw new Error('The starter’s home page has no text to edit.');
}
const setText = (s: ProjectState, value: string): EditOperation => ({ type: 'instance.setProp', owner: { kind: 'page', id: s.site.homePageId }, ...textOnHome(s), value }) as EditOperation;
const textNow = (s: ProjectState) => {
  const { nodeId, prop } = textOnHome(s);
  return (s.pages[s.site.homePageId].nodes[nodeId] as InstanceNode).props[prop];
};

describe('the editor’s copy of the open project', { timeout: 60_000 }, () => {
  it('follows edits, undo, redo, a restore and a change made outside, keeping what each did not touch', async () => {
    const { dir, c, session, editor } = await openProject();
    await settled(c, editor.reader);
    expect(editor.changes[0].base).toBeNull();
    const home = session.state.site.homePageId;
    const before = editor.reader.snapshot!;

    const edit = await c.apply({ operations: [setText(session.state, 'Feed heading')] }, { opening: c.snapshot()!.workspaceKey });
    expect(edit.ok).toBe(true);
    await settled(c, editor.reader);
    const after = editor.reader.snapshot!;
    // Only the page edited was sent, and every other document is the very object the editor held.
    expect(editor.changes.slice(1).every((ch) => ch.base !== null)).toBe(true);
    expect(after.state.pages[home]).not.toBe(before.state.pages[home]);
    for (const id of Object.keys(before.state.pages).filter((id) => id !== home)) expect(after.state.pages[id]).toBe(before.state.pages[id]);
    for (const id of Object.keys(before.state.components)) expect(after.state.components[id]).toBe(before.state.components[id]);
    expect(after.state.site).toBe(before.state.site);

    const original = textNow(before.state);
    expect(textNow(after.state)).toBe('Feed heading');

    // Undo and redo rebuild the project from its documents' texts: only the page they change crosses, and every other
    // document stays the very object the editor held.
    let from = editor.changes.length;
    expect((await session.undo()).ok).toBe(true);
    await settled(c, editor.reader);
    expect(textNow(editor.reader.snapshot!.state)).toBe(original);
    expect(editor.changes.slice(from).flatMap(sentDocs)).toEqual([`pages.${home}`]);
    for (const id of Object.keys(before.state.pages).filter((id) => id !== home)) expect(editor.reader.snapshot!.state.pages[id]).toBe(before.state.pages[id]);
    expect(editor.reader.snapshot!.state.components).toBe(after.state.components);
    from = editor.changes.length;
    expect((await session.redo()).ok).toBe(true);
    await settled(c, editor.reader);
    expect(textNow(editor.reader.snapshot!.state)).toBe('Feed heading');
    expect(editor.changes.slice(from).flatMap(sentDocs)).toEqual([`pages.${home}`]);

    const saved = await session.saveVersion('Before the second edit');
    expect(saved.ok).toBe(true);
    expect((await c.apply({ operations: [setText(session.state, 'Second heading')] }, { opening: c.snapshot()!.workspaceKey })).ok).toBe(true);
    await settled(c, editor.reader);
    expect(textNow(editor.reader.snapshot!.state)).toBe('Second heading');
    expect((await session.restoreVersion(saved.id!, session.revision)).ok).toBe(true);
    await settled(c, editor.reader);
    expect(textNow(editor.reader.snapshot!.state)).toBe('Feed heading');

    // Changed outside the app: the page's file written as another editor saves it, then read again.
    const file = join(dir, 'siteorigin', 'pages', `${home}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { title: string };
    writeFileSync(file, JSON.stringify({ ...doc, title: 'Changed outside' }, null, 2));
    from = editor.changes.length;
    const kept = editor.reader.snapshot!.state;
    expect((await c.reloadFromDisk()).ok).toBe(true);
    await settled(c, editor.reader);
    expect(editor.reader.snapshot!.state.pages[home].title).toBe('Changed outside');
    // Read again from the files, the documents that read the same are still the project's own: only the page crosses.
    expect(editor.changes.slice(from).flatMap(sentDocs)).toEqual([`pages.${home}`]);
    expect(editor.reader.snapshot!.state.components).toBe(kept.components);
    expect(editor.reader.snapshot!.state.site).toBe(kept.site);
    // Every change fitted the copy the editor held.
    expect(editor.unread).toBe(0);
    expect(editor.changes.filter((ch) => ch.base === null)).toHaveLength(1);
  });

  it('sends no project content when only the preview or the AI changed', async () => {
    const { c, editor } = await openProject();
    await settled(c, editor.reader);
    const state = editor.reader.snapshot!.state;
    const from = editor.changes.length;
    c.aiBusy = () => true;
    c.aiRunId = () => 'run_1';
    c.broadcast();
    c.aiBusy = () => false;
    c.aiRunId = () => null;
    c.broadcast();
    // As the preview reporting it is starting, which the editor is sent with the project (onStatus).
    (c as unknown as { status(s: object): void }).status({ state: 'starting' });
    c.broadcast();
    const sent = editor.changes.slice(from);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const ch of sent) {
      expect(ch.base).not.toBeNull();
      expect('state' in ch).toBe(false);
      expect(Object.keys((ch as Extract<ProjectChange, { base: number }>).fields ?? {})).not.toContain('state');
    }
    expect(sent[0]).toMatchObject({ fields: { aiBusy: true, aiRunId: 'run_1' } });
    expect(sent[2]).toMatchObject({ fields: { runtime: { state: 'starting' } } });
    await settled(c, editor.reader);
    expect(editor.reader.snapshot!.state).toBe(state);
  });

  it('sends another window the project whole, and the next change whole after a send that failed', async () => {
    const { c, session } = await openProject();
    delete (c as unknown as { send?: unknown }).send;
    const got: Array<{ to: string; change: ProjectChange }> = [];
    let failNext = false;
    const window = (name: string) => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, change: ProjectChange) => {
          if (channel !== 'project:changed') return;
          if (failNext) {
            failNext = false;
            throw new Error('An object could not be cloned.');
          }
          got.push({ to: name, change: structuredClone(change) });
        }
      }
    });
    const first = window('first');
    const second = window('second');
    let shown = first;
    (c as unknown as { getWindow: () => unknown }).getWindow = () => shown;
    c.broadcast();
    c.broadcast();
    expect(got.map((g) => [g.to, g.change.base === null])).toEqual([['first', true], ['first', false]]);
    expect(got[1].change.base).toBe(got[0].change.seq);
    shown = second;
    c.broadcast();
    c.broadcast();
    expect(got.slice(2).map((g) => [g.to, g.change.base === null])).toEqual([['second', true], ['second', false]]);
    failNext = true;
    expect(() => c.broadcast()).toThrow(/could not be cloned/);
    expect((await c.apply({ operations: [setText(session.state, 'After a failed send')] }, { opening: c.snapshot()!.workspaceKey })).ok).toBe(true);
    const after = got.filter((g) => g.change.revision === session.revision);
    expect(after[0].change.base).toBeNull();
  });

  it('gives a page loaded again the project whole, and sends it changes against that copy', async () => {
    const { c, session, editor } = await openProject();
    await settled(c, editor.reader);
    // The page loads again: the copy it was sent before is gone with it.
    const fresh = new ProjectFeedReader();
    const whole = structuredClone(c.editorFeed()) as ProjectChange;
    expect(whole.base).toBeNull();
    expect(fresh.read(whole)).not.toBeNull();
    expect((await c.apply({ operations: [setText(session.state, 'After the reload')] }, { opening: c.snapshot()!.workspaceKey })).ok).toBe(true);
    const next = editor.changes.at(-1)!;
    expect(next.base).toBe(whole.seq);
    expect(fresh.read(next)).not.toBeNull();
    await settled(c, fresh);
    // The copy the old page held does not fit what follows, and is never taken for the project.
    expect(editor.unread).toBeGreaterThan(0);

    // An editor that missed a change asks for the project again, and is sent it whole.
    const missed = new ProjectFeedReader();
    const sent = editor.changes.length;
    c.resyncEditor();
    expect(editor.changes[sent].base).toBeNull();
    expect(missed.read(editor.changes[sent])).not.toBeNull();
    await settled(c, missed);
  });
});
