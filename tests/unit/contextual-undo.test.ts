import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';

// The editor's actions run against a real project session through a stand-in for the preload bridge, so the
// notification's Undo is checked end to end: which history entry it reverses, and what it leaves alone.
let session: ProjectSession;
let opening = 'opening#1';
/** The editor has been told the project closed (`project:closed`), so it shows no snapshot. */
let closed = false;
/** The bridge call a notification's action started (actions fire and forget). */
let pending: Promise<unknown> = Promise.resolve();
const track = <T>(p: Promise<T>) => ((pending = p), p);
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string; opening?: string } = {}) =>
      track(
        (opts.opening !== undefined && opts.opening !== opening
          ? Promise.resolve({ ok: false, revision: session.revision, error: { code: 'CONFLICT' as const, message: 'The project was closed before this change could be saved.', recoverable: false } })
          : session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' })
        ).then(refresh)
      ),
    undo: () => track(session.undo().then(refresh)),
    undoEntry: (entryId: string, workspaceKey: string) =>
      track(
        (workspaceKey === opening ? session.undoEntry(entryId) : Promise.resolve({ ok: false, revision: session.revision, error: { code: 'CONFLICT' as const, message: 'That project is no longer open.', recoverable: false } })).then(refresh)
      )
  },
  ai: { stop: async () => {} }
};
vi.stubGlobal('window', { builder: bridge });

// The editor's store and actions are DOM code, outside this test project's types, so they are loaded by a path the
// type checker does not follow, with just the shapes this test uses.
interface UndoTarget {
  entryId: string;
  workspaceKey: string;
  revision: number;
}
interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void; undoes?: UndoTarget };
}
interface EditorState {
  toasts: Toast[];
  snapshot: ProjectSnapshot | null;
  modal: unknown;
  selection: unknown;
  pageId: string | null;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { deleteSelection } = (await load('../../src/renderer/src/lib/actions')) as { deleteSelection: () => Promise<void> };
const { getState, setState, undoAvailable } = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  undoAvailable: (t: UndoTarget, snap: ProjectSnapshot | null) => boolean;
};

/** What the main process sends after every change (`project:changed`). */
function refresh<T>(r: T): T {
  setState({ snapshot: closed ? null : ({ state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false } as unknown as ProjectSnapshot) });
  return r;
}

const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-ctx-undo-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, createStarterState('business', 'Studio', false));
  opening = `opening#${dirs.length}`;
  closed = false;
  setState({ toasts: [], selection: null, modal: null, pageId: session.state.site.homePageId });
  refresh(null);
});
afterEach(async () => {
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const homeId = () => session.state.site.homePageId;
const home = (s: ProjectState = session.state) => s.pages[s.site.homePageId];
const sectionOf = (componentId: string, s: ProjectState = session.state) =>
  home(s).rootIds.find((id) => s.components[(home(s).nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;

/** Select a top-level section on Home and delete it as Layers does, returning the notification it left. */
async function deleteSection(nodeId: string) {
  setState({ selection: { owner: { kind: 'page', id: homeId() }, instancePath: [], nodeId } });
  const before = getState().toasts.length;
  await deleteSelection();
  const t = getState().toasts.slice(before).find((x) => x.text.startsWith('Deleted '));
  expect(t?.action?.label).toBe('Undo');
  return t!;
}

/** Click a notification's action and let the change it starts finish. */
async function click(t: { action?: { run: () => void } }) {
  pending = Promise.resolve();
  t.action!.run();
  await pending;
}
const setBrowserTitle = (seoTitle: string) => bridge.project.apply({ operations: [{ type: 'page.update', pageId: homeId(), seoTitle }] }, { label: 'Edit browser title' });
const rename = (nodeId: string, name: string) => bridge.project.apply({ operations: [{ type: 'node.rename', owner: { kind: 'page', id: homeId() }, nodeId, name }] }, { label: 'Rename' });
const lastError = () => getState().toasts.filter((t) => t.kind === 'error').at(-1);
const available = (t: { action?: { undoes?: Parameters<typeof undoAvailable>[0] } }) => undoAvailable(t.action!.undoes!, getState().snapshot);

describe('a deletion notification’s Undo', () => {
  it('restores only the deleted section and keeps a later browser title', async () => {
    const logos = sectionOf('logos.strip');
    const order = [...home().rootIds];
    const subtree = structuredClone(home().nodes[logos]);
    const t = await deleteSection(logos);
    expect(t.text).toBe('Deleted Logo strip');
    expect(home().rootIds).not.toContain(logos);
    await setBrowserTitle('November client proof');
    expect(available(t)).toBe(true);
    await click(t);
    expect(home().seo.title).toBe('November client proof');
    expect(home().rootIds).toEqual(order);
    expect(home().nodes[logos]).toEqual(subtree);
    expect(lastError()).toBeUndefined();
    // Toolbar Undo stays chronological: the restore, then the title, then the deletion.
    expect(session.historyInfo().undoLabel).toBe('Restore Logo strip');
    await bridge.project.undo();
    expect(home().rootIds).not.toContain(logos);
    expect(home().seo.title).toBe('November client proof');
    await bridge.project.undo();
    expect(home().seo.title).toBeUndefined();
    expect(home().rootIds).not.toContain(logos);
    await bridge.project.undo();
    expect(home().rootIds).toEqual(order);
  });

  it.each([
    ['the upper one first', 1, 2],
    ['the lower one first', 2, 1]
  ])('keeps two fast deletions of neighbours with the same name apart, deleting %s and clicking the older Undo first', async (_, i, j) => {
    const order = [...home().rootIds];
    const [a, b] = [order[i], order[j]];
    await rename(a, 'Promo');
    await rename(b, 'Promo');
    const ta = await deleteSection(a);
    const tb = await deleteSection(b);
    expect(ta.text).toBe(tb.text);
    // The older notification brings back its own section, not the newer one with the same name.
    await click(ta);
    expect(home().rootIds).toContain(a);
    expect(home().rootIds).not.toContain(b);
    await click(tb);
    expect(home().rootIds).toEqual(order);
    expect(lastError()).toBeUndefined();
  });

  it('undoes the newest deletion like Undo, keeping Redo, and leaves an earlier same-named one deleted', async () => {
    const order = [...home().rootIds];
    const [a, b] = order.slice(1, 3);
    await rename(a, 'Promo');
    await rename(b, 'Promo');
    const ta = await deleteSection(a);
    const tb = await deleteSection(b);
    await click(tb);
    expect(home().rootIds).toContain(b);
    expect(home().rootIds).not.toContain(a);
    expect(session.historyInfo()).toMatchObject({ canRedo: true, redoLabel: 'Delete Promo' });
    // The earlier deletion is the newest applied change again, so its Undo steps back through history too.
    await click(ta);
    expect(home().rootIds).toEqual(order);
    expect(session.historyInfo().redoLabel).toBe('Delete Promo');
  });

  it('never brings a section back twice: a later deletion of it stands', async () => {
    const logos = sectionOf('logos.strip');
    const t = await deleteSection(logos);
    await setBrowserTitle('November client proof');
    await click(t);
    expect(home().rootIds).toContain(logos);
    await deleteSection(logos);
    const revision = session.revision;
    await click(t);
    expect(home().rootIds).not.toContain(logos);
    expect(session.revision).toBe(revision);
    expect(lastError()?.text).toBe('“Delete Logo strip” was already undone.');
  });

  it('explains when later edits leave no single place for the section, and opens History at it', async () => {
    const order = [...home().rootIds];
    const [p, a, n] = order.slice(1, 4);
    const t = await deleteSection(a);
    // The neighbours swap across the gap the section left.
    await bridge.project.apply({ operations: [{ type: 'node.move', owner: { kind: 'page', id: homeId() }, nodeId: n, parentId: null, index: order.indexOf(p) }] }, { label: 'Move up' });
    const before = { revision: session.revision, history: session.historyInfo(), page: structuredClone(home()) };
    await click(t);
    expect(session.revision).toBe(before.revision);
    expect(session.historyInfo()).toEqual(before.history);
    expect(home()).toEqual(before.page);
    const e = lastError()!;
    expect(e.text).toMatch(/^Other changes came after “Delete .+”, so it can’t be undone on its own\. The sections around where it was have changed\. Open History to undo it\.$/);
    expect(e.action?.label).toBe('History');
    e.action!.run();
    const entryId = t.action!.undoes!.entryId;
    expect(getState().modal).toEqual({ kind: 'history', entryId });
    expect(session.historyInfo().entries.find((x) => x.id === entryId)?.label).toMatch(/^Delete /);
  });

  it('withdraws the Undo once its deletion is undone some other way, or its project is no longer open', async () => {
    const logos = sectionOf('logos.strip');
    const t = await deleteSection(logos);
    await bridge.project.undo();
    expect(available(t)).toBe(false);
    // Redo puts back that very deletion, so the Undo describes it again.
    await (session.redo().then(refresh));
    expect(available(t)).toBe(true);
    // Another opening (even of the same folder) never acts on it.
    opening = 'opening#reopened';
    refresh(null);
    expect(available(t)).toBe(false);
    const revision = session.revision;
    await click(t);
    expect(session.revision).toBe(revision);
    expect(home().rootIds).not.toContain(logos);
    // Its History button opens nothing here: this opening's History holds other changes.
    lastError()!.action?.run();
    expect(getState().modal).toBeNull();
  });

  it('leaves the editor alone when a deletion’s reply arrives after its project closed', async () => {
    const logos = sectionOf('logos.strip');
    const selection = { owner: { kind: 'page', id: homeId() }, instancePath: [], nodeId: logos };
    setState({ selection });
    const deleting = deleteSelection();
    opening = 'opening#closed';
    closed = true;
    await deleting;
    expect(getState().snapshot).toBeNull();
    expect(getState().selection).toEqual(selection);
    expect(getState().toasts.some((x) => x.text.startsWith('Deleted '))).toBe(false);
  });

  it('sends a deletion with the opening it was made in, so another one refuses it', async () => {
    const logos = sectionOf('logos.strip');
    setState({ selection: { owner: { kind: 'page', id: homeId() }, instancePath: [], nodeId: logos } });
    // The editor still shows the earlier opening when the request arrives.
    opening = 'opening#reopened';
    await deleteSelection();
    expect(home().rootIds).toContain(logos);
    expect(lastError()?.text).toBe('The project was closed before this change could be saved.');
  });

  it('opens History only in the project the change was made in', async () => {
    const order = [...home().rootIds];
    const [p, a, n] = order.slice(1, 4);
    const t = await deleteSection(a);
    await bridge.project.apply({ operations: [{ type: 'node.move', owner: { kind: 'page', id: homeId() }, nodeId: n, parentId: null, index: order.indexOf(p) }] }, { label: 'Move up' });
    await click(t);
    const e = lastError()!;
    closed = true;
    refresh(null);
    e.action!.run();
    expect(getState().modal).toBeNull();
  });
});
