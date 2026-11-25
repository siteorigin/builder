import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';

// Deleting a parent that holds a component placement or slot content asks first (#662): Delete all, Remove wrapper &
// keep content, or Cancel. Anything else goes at once. The editor's action runs against a real project session
// through a stand-in for the preload bridge, so each answer is checked end to end: what the project holds after it,
// the notice and its Undo, and the one History step it makes.
let session: ProjectSession;
const OPENING = 'opening#1';
let opening = OPENING;
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
interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
}
interface EditorState {
  toasts: Toast[];
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: { owner: OwnerRef; ids: string[]; anchor: string } | null;
  modal: unknown;
  pageId: string | null;
}
interface Question {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  stayLabel?: string;
  tone?: string;
  details?: Array<{ kind: string; text: string }>;
  resolve: (ok: boolean | null) => void;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { deleteSelection } = (await load('../../src/renderer/src/lib/actions')) as { deleteSelection: () => Promise<void> };
const { heldContent } = (await load('../../src/renderer/src/lib/delete-content')) as {
  heldContent: (tree: ProjectState['pages'][string], nodeId: string) => { items: string[]; placements: number } | null;
};
const { getState, setState, getConfirm } = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState> & Record<string, unknown>) => void;
  getConfirm: () => Question | null;
};

/** What the main process sends after every change (`project:changed`). */
function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false } as unknown as ProjectSnapshot });
  return r;
}

const home = (s: ProjectState = session.state) => s.pages[s.site.homePageId];
const page = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const slot = (id: string, name = 'content', s: ProjectState = session.state) => (home(s).nodes[id] as InstanceNode).slots?.[name];

/**
 * A blank site with a two-column Split of the project's own (slots Left and Right) inside a Section, between two
 * paragraphs. Left holds a heading and a Card placement with a style of its own; Right a Stack holding a paragraph.
 * An empty Section sits below it. `contract` limits the Section's Content slot (on a copy of the Section's design).
 */
function fixture(contract?: { max?: number }): ProjectState {
  const s0 = createStarterState('blank', 'Blank', false);
  const o = page(s0);
  const c = applyOperations(s0, [
    { type: 'component.create', name: 'Split' },
    { type: 'component.create', name: 'Card' }
  ]);
  const split = c.results[0].definitionId as string;
  const card = c.results[1].definitionId as string;
  const own = { kind: 'component' as const, id: split };
  const ops: EditOperation[] = [
    { type: 'component.setSlot', definitionId: split, slot: 'left', label: 'Left' },
    { type: 'component.setSlot', definitionId: split, slot: 'right', label: 'Right' },
    { type: 'node.insert', owner: own, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'left' },
    { type: 'node.insert', owner: own, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'right' },
    { type: 'node.insert', owner: { kind: 'component', id: card }, parentId: c.results[1].rootNodeId as string, primitive: 'heading', text: 'Card' },
    { type: 'node.insert', newNodeId: 'n_section', owner: o, componentId: 'layout.section' },
    { type: 'node.insert', newNodeId: 'n_before', owner: o, parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'Before' },
    { type: 'node.insert', newNodeId: 'n_split', owner: o, parentId: 'n_section', slot: 'content', definitionId: split },
    { type: 'node.insert', newNodeId: 'n_after', owner: o, parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'After' },
    { type: 'node.insert', newNodeId: 'n_heading', owner: o, parentId: 'n_split', slot: 'left', primitive: 'heading', text: 'Our story' },
    { type: 'node.insert', newNodeId: 'n_card', owner: o, parentId: 'n_split', slot: 'left', definitionId: card },
    { type: 'node.setStyle', owner: o, nodeId: 'n_card', scope: 'base', property: 'background', value: '#e8f0ff' },
    { type: 'node.insert', newNodeId: 'n_stack', owner: o, parentId: 'n_split', slot: 'right', primitive: 'stack' },
    { type: 'node.insert', newNodeId: 'n_para', owner: o, parentId: 'n_stack', primitive: 'paragraph', text: 'Inside' },
    { type: 'node.insert', newNodeId: 'n_empty', owner: o, componentId: 'layout.section' }
  ];
  const s = applyOperations(c.state, ops).state;
  if (!contract) return s;
  // The Split alone in a Section of the project's own, whose Content slot takes no more than `contract` says.
  const f = applyOperations(s, [{ type: 'component.fork', definitionId: (home(s).nodes.n_section as InstanceNode).definitionId }]);
  const forked = f.results[0].definitionId as string;
  return applyOperations(f.state, [
    { type: 'node.insert', newNodeId: 'n_own', owner: o, definitionId: forked },
    { type: 'node.move', owner: o, nodeId: 'n_split', parentId: 'n_own', slot: 'content', index: 0 },
    { type: 'component.setSlot', definitionId: forked, slot: 'content', label: 'Content', ...contract }
  ]).state;
}

const dirs: string[] = [];
async function open(state: ProjectState) {
  const dir = mkdtempSync(join(tmpdir(), 'so-del-nested-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, state);
  opening = OPENING;
  setState({ toasts: [], selection: null, layerSet: null, modal: null, pageId: session.state.site.homePageId });
  refresh(null);
}
beforeEach(() => open(fixture()));
afterEach(async () => {
  // A question left open by a failed test would otherwise be the next test's.
  getConfirm()?.resolve(null);
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const select = (nodeId: string) => setState({ selection: { owner: page(session.state), instancePath: [], nodeId }, layerSet: null });
/**
 * Start deleting `nodeId` as the Delete key does. The question, if any, is asked as soon as the action has read the
 * project (nothing before it waits on the bridge); `done` settles once it is answered and the change has landed.
 */
function startDelete(nodeId: string): { done: Promise<void> } {
  select(nodeId);
  pending = Promise.resolve();
  return { done: deleteSelection() };
}
/** The question on screen, answered: true for Remove wrapper & keep content, false for Delete all, null for Cancel. */
async function answer({ done }: { done: Promise<void> }, ok: boolean | null) {
  const q = getConfirm();
  expect(q).not.toBeNull();
  q!.resolve(ok);
  await done;
  await pending;
}
const appliedSteps = () => session.historyInfo().entries.filter((e) => e.applied).length;
const lastToast = () => getState().toasts.at(-1);
/** Click a notification's action and let the change it starts finish. */
async function click(t: Toast | undefined) {
  pending = Promise.resolve();
  t!.action!.run();
  await pending;
}

describe('which deletions ask first', () => {
  it('asks for a placement whose slots hold anything, and for a container with a placement inside it', () => {
    const tree = home();
    expect(heldContent(tree, 'n_split')).toEqual({ items: ['n_heading', 'n_card', 'n_stack'], placements: 1 });
    // The Section holds three items directly; the Split and the Card inside it are both placements.
    expect(heldContent(tree, 'n_section')).toEqual({ items: ['n_before', 'n_split', 'n_after'], placements: 2 });
    const s = applyOperations(session.state, [
      { type: 'node.insert', newNodeId: 'n_row', owner: page(session.state), parentId: 'n_stack', primitive: 'row' },
      { type: 'node.move', owner: page(session.state), nodeId: 'n_card', parentId: 'n_row', index: 0 }
    ]).state;
    // A placement two levels down still counts: the Stack holds its paragraph and a Row with the Card.
    expect(heldContent(home(s), 'n_stack')).toEqual({ items: ['n_para', 'n_row'], placements: 1 });
  });

  it('deletes at once a leaf, an empty Section, a placement with empty slots and a Stack of plain elements', () => {
    const tree = home();
    expect(heldContent(tree, 'n_para')).toBeNull();
    expect(heldContent(tree, 'n_empty')).toBeNull();
    expect(heldContent(tree, 'n_stack')).toBeNull();
    const s = applyOperations(session.state, [
      { type: 'node.move', owner: page(session.state), nodeId: 'n_heading', parentId: 'n_section', slot: 'content', index: 0 },
      { type: 'node.move', owner: page(session.state), nodeId: 'n_card', parentId: 'n_section', slot: 'content', index: 0 },
      { type: 'node.move', owner: page(session.state), nodeId: 'n_stack', parentId: 'n_section', slot: 'content', index: 0 }
    ]).state;
    expect(slot('n_split', 'left', s)).toEqual([]);
    expect(heldContent(home(s), 'n_split')).toBeNull();
    expect(heldContent(home(s), 'missing')).toBeNull();
  });

  it('deletes a Stack of plain elements and an empty Section without a question, with the notice as before', async () => {
    const steps = appliedSteps();
    const stack = startDelete('n_stack');
    expect(getConfirm()).toBeNull();
    await stack.done;
    expect(home().nodes).not.toHaveProperty('n_stack');
    expect(home().nodes).not.toHaveProperty('n_para');
    expect(lastToast()?.text).toBe('Deleted Stack');
    const empty = startDelete('n_empty');
    expect(getConfirm()).toBeNull();
    await empty.done;
    expect(home().rootIds).not.toContain('n_empty');
    expect(lastToast()?.text).toBe('Deleted Section');
    expect(appliedSteps()).toBe(steps + 2);
  });
});

describe('deleting a parent that holds a placement', () => {
  it('asks with three choices, Cancel the safe one, and changes nothing until answered', async () => {
    const before = JSON.stringify(session.state);
    const steps = appliedSteps();
    const started = startDelete('n_split');
    const q = getConfirm()!;
    expect(q.title).toBe('Delete “Split”?');
    expect(q.body).toBe('It holds 3 items. Delete them with it, or keep them where they are?');
    expect([q.confirmLabel, q.cancelLabel, q.stayLabel]).toEqual(['Remove wrapper & keep content', 'Delete all', 'Cancel']);
    expect(q.details).toEqual([
      { kind: 'lose', text: 'Delete all removes it and the 3 items inside it, including a placed component with its own content.' },
      { kind: 'keep', text: 'Remove wrapper & keep content puts those 3 items in its place.' },
      { kind: 'note', text: 'Reusable component definitions stay in the library.' },
      { kind: 'undo', text: 'Either way, one Undo puts it all back.' }
    ]);
    expect(JSON.stringify(session.state)).toBe(before);
    await answer(started, null);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(appliedSteps()).toBe(steps);
    expect(getState().toasts).toEqual([]);
    expect(getState().selection?.nodeId).toBe('n_split');
  });

  it('Delete all takes the Split and everything inside it in one step, leaves the library alone, and one Undo puts it back', async () => {
    const page0 = structuredClone(home());
    const components = structuredClone(session.state.components);
    const steps = appliedSteps();
    await answer(startDelete('n_split'), false);
    expect(slot('n_section')).toEqual(['n_before', 'n_after']);
    for (const id of ['n_split', 'n_heading', 'n_card', 'n_stack', 'n_para']) expect(home().nodes).not.toHaveProperty(id);
    expect(session.state.components).toEqual(components);
    expect(appliedSteps()).toBe(steps + 1);
    expect(session.historyInfo().undoLabel).toBe('Delete Split on Home');
    expect(getState().selection).toBeNull();
    const t = lastToast();
    expect(t?.text).toBe('Deleted Split and 3 nested items');
    expect(t?.action?.label).toBe('Undo');
    await click(t);
    expect(home()).toEqual(page0);
    expect(session.state.components).toEqual(components);
  });

  it('Remove wrapper & keep content puts what the Split held in its place, selected, in one step that one Undo takes back', async () => {
    const page0 = structuredClone(home());
    const kept = ['n_heading', 'n_card', 'n_stack', 'n_para'].map((id) => JSON.stringify(home().nodes[id]));
    const steps = appliedSteps();
    await answer(startDelete('n_split'), true);
    expect(slot('n_section')).toEqual(['n_before', 'n_heading', 'n_card', 'n_stack', 'n_after']);
    expect(home().nodes).not.toHaveProperty('n_split');
    // The Card keeps its own style, and every kept node its ID and content.
    expect(['n_heading', 'n_card', 'n_stack', 'n_para'].map((id) => JSON.stringify(home().nodes[id]))).toEqual(kept);
    expect(appliedSteps()).toBe(steps + 1);
    expect(session.historyInfo().undoLabel).toBe('Remove Split on Home, keeping its content');
    expect(getState().selection?.nodeId).toBe('n_heading');
    expect(getState().layerSet?.ids).toEqual(['n_heading', 'n_card', 'n_stack']);
    const t = lastToast();
    expect(t?.text).toBe('Removed Split and kept 3 items');
    await click(t);
    expect(home()).toEqual(page0);
  });

  it('asks for a Section with a paragraph in it, and keeping it on the page’s top level puts that in a new Section', async () => {
    // An empty Section is deleted at once (above); one holding only a paragraph asks.
    const s = fixture();
    await open(applyOperations(s, [{ type: 'node.insert', newNodeId: 'n_note', owner: page(s), parentId: 'n_empty', slot: 'content', primitive: 'paragraph', text: 'Note' }]).state);
    const started = startDelete('n_empty');
    expect(getConfirm()?.body).toBe('It holds 1 item. Delete them with it, or keep them where they are?');
    expect(getConfirm()?.details?.[0].text).toBe('Delete all removes it and the 1 item inside it.');
    await answer(started, true);
    const roots = home().rootIds;
    expect(roots).not.toContain('n_empty');
    const wrapper = home().nodes[roots.at(-1)!] as InstanceNode;
    expect(wrapper.slots?.content).toEqual(['n_note']);
    expect(lastToast()?.text).toBe('Removed Section and kept 1 item');
  });

  it('offers only Delete all, saying why, when the slot that held it can’t take what it holds', async () => {
    await open(fixture({ max: 2 }));
    const started = startDelete('n_split');
    const q = getConfirm()!;
    expect([q.confirmLabel, q.cancelLabel, q.stayLabel, q.tone]).toEqual(['Delete all', undefined, undefined, 'caution']);
    expect(q.body).toBe('It holds 3 items, which go with it.');
    expect(q.details?.[1].kind).toBe('note');
    expect(q.details?.[1].text).toMatch(/^What it holds can’t be kept: .*holds at most 2 items/);
    await answer(started, true);
    expect(slot('n_own')).toEqual([]);
    expect(lastToast()?.text).toBe('Deleted Split and 3 nested items');
  });

  it('Cancel on the question that offers only Delete all changes nothing', async () => {
    await open(fixture({ max: 2 }));
    const before = JSON.stringify(session.state);
    await answer(startDelete('n_split'), false);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(getState().toasts).toEqual([]);
  });
});

describe('a project that changes while the question is open', () => {
  it('refuses an answer for a project changed meanwhile, to ask again, though the count is the same', async () => {
    const started = startDelete('n_split');
    // Something else (the AI, a file saved elsewhere) rewrites the heading in the Split: still the same three items.
    await bridge.project.apply({ operations: [{ type: 'node.setContent', owner: page(session.state), nodeId: 'n_heading', field: 'text', value: 'Rewritten' }] }, { label: 'Elsewhere' });
    const before = JSON.stringify(session.state);
    await answer(started, false);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(lastToast()).toMatchObject({ kind: 'error', text: 'The project changed while you were choosing. Choose again.' });
  });

  it('sends nothing when the project closed, or another opened, while the question was open', async () => {
    const before = JSON.stringify(session.state);
    const started = startDelete('n_split');
    opening = 'opening#2';
    refresh(null);
    await answer(started, true);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(getState().toasts).toEqual([]);
  });

  it('asks nothing while the AI works, and refuses the deletion as before', async () => {
    const before = JSON.stringify(session.state);
    setState({ snapshot: { ...getState().snapshot!, aiBusy: true } });
    const started = startDelete('n_split');
    expect(getConfirm()).toBeNull();
    await started.done;
    expect(JSON.stringify(session.state)).toBe(before);
    expect(lastToast()?.text).toBe('The AI is making changes. Stop it to edit manually.');
  });

  it('asks nothing in a project open read-only: the deletion goes to the project, which refuses it there', async () => {
    setState({ snapshot: { ...getState().snapshot!, readOnly: true } });
    const started = startDelete('n_split');
    expect(getConfirm()).toBeNull();
    // This stand-in project takes edits, so the one sent shows what was sent: a plain deletion, as before #662.
    await started.done;
    expect(home().nodes).not.toHaveProperty('n_split');
    expect(lastToast()?.text).toBe('Deleted Split');
  });
});
