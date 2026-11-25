import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementNode, ElementRef, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';

// Deleting a parent that holds a component placement or slot content asks first (#662): Delete all, Remove wrapper &
// keep content, or Cancel. Anything else goes at once. The editor's action runs against a real project session
// through a stand-in for the preload bridge that records every change sent, so each answer is checked end to end:
// what was sent, what the project holds after it, the notice and its Undo, and the one History step it makes.
let session: ProjectSession;
const OPENING = 'opening#1';
let opening = OPENING;
let pending: Promise<unknown> = Promise.resolve();
const track = <T>(p: Promise<T>) => ((pending = p), p);
type Batch = Parameters<ProjectSession['apply']>[0];
/** Every change the editor sent, in order. */
let sent: Array<Batch & { label?: string }> = [];
/** Set: the project refuses every change with this reason, as one open read-only does. */
let refusing: string | null = null;
/** Set: replies wait for it (a save still on its way). */
let held: Promise<void> | null = null;
const snapshotNow = () => ({ state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false }) as unknown as ProjectSnapshot;
const bridge = {
  project: {
    apply: (batch: Batch, opts: { label?: string; coalesceKey?: string; opening?: string } = {}) => {
      sent.push({ ...batch, label: opts.label });
      // Named by the opening it was sent in: one that has closed since takes nothing.
      const accepted = opts.opening === undefined || opts.opening === opening;
      return track(
        (async () => {
          if (held) await held;
          if (!accepted) return { ok: false, revision: session.revision, error: { code: 'CONFLICT' as const, message: 'The project was closed before this change could be saved.', recoverable: false } };
          if (refusing) return { ok: false, revision: session.revision, error: { code: 'SCOPE_MISMATCH' as const, message: refusing, recoverable: false } };
          return session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' });
        })().then(refresh)
      );
    },
    snapshot: async () => snapshotNow(),
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
const { heldContent, removalKey } = (await load('../../src/renderer/src/lib/delete-content')) as {
  heldContent: (tree: NodeTree, nodeId: string) => { items: string[]; placements: number } | null;
  removalKey: (state: ProjectState, owner: OwnerRef, tree: NodeTree, nodeId: string) => string;
};
const { appliesLanded } = (await load('../../src/renderer/src/lib/pending')) as { appliesLanded: () => Promise<unknown> };
const { getState, setState, getConfirm, pendingConfirms } = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState> & Record<string, unknown>) => void;
  getConfirm: () => Question | null;
  pendingConfirms: () => readonly Question[];
};

/** What the main process sends after every change (`project:changed`). */
function refresh<T>(r: T): T {
  setState({ snapshot: snapshotNow() });
  return r;
}

const home = (s: ProjectState = session.state) => s.pages[s.site.homePageId];
const page = (s: ProjectState = session.state): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const slot = (id: string, name = 'content', s: ProjectState = session.state) => (home(s).nodes[id] as InstanceNode).slots?.[name];
const ref = (nodeId: string, owner: OwnerRef = page()): ElementRef => ({ owner, instancePath: [], nodeId });

/**
 * A blank site with a Split of the project's own (two slots, Left and Right, shown one after the other) inside a
 * Section, between two paragraphs. Left holds a heading and a Card placement with a style of its own; Right a Stack
 * holding a paragraph. An empty Section sits below it. Card's own design holds a Stack with a Badge placement and a
 * paragraph. `contract` limits the Section's Content slot (on a copy of the Section's design).
 */
function fixture(contract?: { max?: number }): ProjectState {
  const s0 = createStarterState('blank', 'Blank', false);
  const o = page(s0);
  const c = applyOperations(s0, [
    { type: 'component.create', name: 'Split' },
    { type: 'component.create', name: 'Card' },
    { type: 'component.create', name: 'Badge' }
  ]);
  const [split, card, badge] = c.results.map((r) => r.definitionId as string);
  const own = { kind: 'component' as const, id: split };
  const cardOwn = { kind: 'component' as const, id: card };
  const ops: EditOperation[] = [
    { type: 'component.setSlot', definitionId: split, slot: 'left', label: 'Left' },
    { type: 'component.setSlot', definitionId: split, slot: 'right', label: 'Right' },
    { type: 'node.insert', owner: own, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'left' },
    { type: 'node.insert', owner: own, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'right' },
    { type: 'node.insert', owner: cardOwn, parentId: c.results[1].rootNodeId as string, primitive: 'heading', text: 'Card' },
    { type: 'node.insert', newNodeId: 'd_stack', owner: cardOwn, parentId: c.results[1].rootNodeId as string, primitive: 'stack' },
    { type: 'node.insert', newNodeId: 'd_badge', owner: cardOwn, parentId: 'd_stack', definitionId: badge },
    { type: 'node.insert', newNodeId: 'd_text', owner: cardOwn, parentId: 'd_stack', primitive: 'paragraph', text: 'Badge note' },
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
const cardId = (s: ProjectState = session.state) => (home(s).nodes.n_card as InstanceNode).definitionId;

const dirs: string[] = [];
async function open(state: ProjectState) {
  if (session) await session.close();
  const dir = mkdtempSync(join(tmpdir(), 'so-del-nested-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, state);
  opening = OPENING;
  sent = [];
  refusing = null;
  held = null;
  setState({ toasts: [], selection: null, layerSet: null, modal: null, pageId: session.state.site.homePageId });
  refresh(null);
}
beforeEach(() => open(fixture()));
afterEach(async () => {
  // A question left open by a failed test would otherwise be the next test's.
  for (const q of [...pendingConfirms()]) q.resolve(null);
  await pending;
  await session.close();
  session = undefined as unknown as ProjectSession;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const select = (r: ElementRef | string) => setState({ selection: typeof r === 'string' ? ref(r) : r, layerSet: null });
/**
 * Start deleting `target` as the Delete key does. The question, if any, is asked as soon as the action has read the
 * project (nothing before it waits on the bridge); `done` settles once it is answered and the change has landed.
 */
function startDelete(target: ElementRef | string): { done: Promise<void> } {
  select(target);
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
/** The changes sent since `from`: each one's operations, as type and node. */
const sentSince = (from: number) => sent.slice(from).map((b) => b.operations.map((o) => `${o.type} ${(o as { nodeId?: string }).nodeId}`).join(', '));

describe('which deletions ask first', () => {
  it('asks for a placement whose slots hold anything, and for a container with a placement anywhere inside it', () => {
    expect(heldContent(home(), 'n_split')).toEqual({ items: ['n_heading', 'n_card', 'n_stack'], placements: 1 });
    // The Section holds three items directly; the Split and the Card inside it are both placements.
    expect(heldContent(home(), 'n_section')).toEqual({ items: ['n_before', 'n_split', 'n_after'], placements: 2 });
    const s = applyOperations(session.state, [
      { type: 'node.insert', newNodeId: 'n_row', owner: page(), parentId: 'n_stack', primitive: 'row' },
      { type: 'node.move', owner: page(), nodeId: 'n_card', parentId: 'n_row', index: 0 }
    ]).state;
    // A placement two levels down still counts: the Stack holds its paragraph and a Row with the Card.
    expect(heldContent(home(s), 'n_stack')).toEqual({ items: ['n_para', 'n_row'], placements: 1 });
    // In a component's own design too.
    expect(heldContent(session.state.components[cardId()].tree!, 'd_stack')).toEqual({ items: ['d_badge', 'd_text'], placements: 1 });
  });

  it('asks nothing for a leaf, an empty Section, a placement with empty slots or none, or a Stack of plain elements', () => {
    for (const id of ['n_para', 'n_empty', 'n_stack', 'n_card', 'missing']) expect(heldContent(home(), id)).toBeNull();
    const s = applyOperations(session.state, ['n_heading', 'n_card', 'n_stack'].map((nodeId): EditOperation => ({ type: 'node.move', owner: page(), nodeId, parentId: 'n_section', slot: 'content', index: 0 }))).state;
    expect(slot('n_split', 'left', s)).toEqual([]);
    expect(heldContent(home(s), 'n_split')).toBeNull();
  });
});

describe('what a deletion planned again compares', () => {
  it('in a design, also the parts on what it removes, their variant styles, and what placements set for those parts', () => {
    const card = cardId();
    const owner: OwnerRef = { kind: 'component', id: card };
    const key = (s: ProjectState) => removalKey(s, owner, s.components[card].tree!, 'd_stack');
    const s0 = applyOperations(session.state, [{ type: 'component.setVariant', definitionId: card, variant: 'bold', label: 'Bold' }]).state;
    expect(key(structuredClone(s0))).toBe(key(s0));
    // What it holds goes with it; a style elsewhere in the design does not.
    expect(key(applyOperations(s0, [{ type: 'node.setContent', owner, nodeId: 'd_text', field: 'text', value: 'Other' }]).state)).not.toBe(key(s0));
    const elsewhere = applyOperations(s0, [{ type: 'node.setStyle', owner, nodeId: (s0.components[card].tree!.rootIds[0]), variant: 'bold', scope: 'base', property: 'gap', value: { token: 'space.lg' } }]).state;
    expect(key(elsewhere)).toBe(key(s0));
    const styled = applyOperations(s0, [{ type: 'node.setStyle', owner, nodeId: 'd_stack', variant: 'bold', scope: 'base', property: 'gap', value: { token: 'space.lg' } }]).state;
    expect(key(styled)).not.toBe(key(s0));
    const part = applyOperations(s0, [{ type: 'component.setPart', definitionId: card, partId: 'box', nodeId: 'd_stack', label: 'Box' }]).state;
    expect(key(part)).not.toBe(key(s0));
    const overridden = applyOperations(part, [{ type: 'node.setStyle', owner: page(), nodeId: 'n_card', partId: 'box', scope: 'base', property: 'gap', value: { token: 'space.lg' } }]).state;
    expect(key(overridden)).not.toBe(key(part));
  });
});

describe('deleting at once', () => {
  it('deletes a placement without slots, a leaf, an emptied Stack and Split, and an empty Section unasked, each one plain change', async () => {
    const steps = appliedSteps();
    const cases: Array<[string, string]> = [
      ['n_card', 'Deleted Card'],
      ['n_para', 'Deleted Text'],
      ['n_stack', 'Deleted Stack'],
      ['n_heading', 'Deleted Heading 2'],
      ['n_split', 'Deleted Split'],
      ['n_empty', 'Deleted Section']
    ];
    for (const [id, text] of cases) {
      const from = sent.length;
      const revision = session.revision;
      const { done } = startDelete(id);
      expect(getConfirm(), id).toBeNull();
      await done;
      expect(sentSince(from), id).toEqual([`node.remove ${id}`]);
      expect(sent.at(-1)!.expectedRevision, id).toBe(revision);
      expect(home().nodes, id).not.toHaveProperty(id);
      expect(lastToast()?.text).toBe(text);
      expect(lastToast()?.action?.label).toBe('Undo');
    }
    expect(appliedSteps()).toBe(steps + cases.length);
  });
});

describe('deleting a parent that holds a placement', () => {
  it('asks with three choices, Cancel the safe one, and sends nothing when cancelled', async () => {
    const before = JSON.stringify(session.state);
    const steps = appliedSteps();
    const started = startDelete('n_split');
    const q = getConfirm()!;
    expect(q.title).toBe('Delete “Split”?');
    expect(q.body).toBe('It holds 3 items. Delete them with it, or keep them where they are?');
    expect([q.confirmLabel, q.cancelLabel, q.stayLabel]).toEqual(['Remove wrapper & keep content', 'Delete all', 'Cancel']);
    expect(q.details).toEqual([
      { kind: 'lose', text: 'Delete all removes it and everything inside it, including a placed component with its own content.' },
      { kind: 'keep', text: 'Remove wrapper & keep content puts those 3 items in its place.' },
      { kind: 'note', text: 'Reusable component definitions stay in the library.' },
      { kind: 'undo', text: 'Either way, one Undo puts it all back.' }
    ]);
    await answer(started, null);
    expect(sent).toEqual([]);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(appliedSteps()).toBe(steps);
    expect(getState().toasts).toEqual([]);
    expect(getState().selection).toEqual(ref('n_split'));
  });

  it('Delete all takes the Split and everything inside it in one step, leaves the library alone, and one Undo puts it back', async () => {
    const before = structuredClone(session.state);
    const revision = session.revision;
    const steps = appliedSteps();
    await answer(startDelete('n_split'), false);
    expect(sentSince(0)).toEqual(['node.remove n_split']);
    expect(sent[0].expectedRevision).toBe(revision);
    expect(slot('n_section')).toEqual(['n_before', 'n_after']);
    for (const id of ['n_split', 'n_heading', 'n_card', 'n_stack', 'n_para']) expect(home().nodes).not.toHaveProperty(id);
    expect(session.state.components).toEqual(before.components);
    expect(appliedSteps()).toBe(steps + 1);
    expect(session.historyInfo().undoLabel).toBe('Delete Split on Home');
    expect(getState().selection).toBeNull();
    const t = lastToast();
    expect(t?.text).toBe('Deleted Split and 3 nested items');
    expect(t?.action?.label).toBe('Undo');
    await click(t);
    expect(session.state).toEqual(before);
  });

  it('Delete all lets go of a layer inside the Split picked while asking, and keeps one outside it', async () => {
    for (const [picked, stays] of [
      ['n_para', false],
      ['n_before', true]
    ] as const) {
      await open(fixture());
      const started = startDelete('n_split');
      select(picked);
      await answer(started, false);
      expect(getState().selection, picked).toEqual(stays ? ref(picked) : null);
    }
  });

  it('Remove wrapper & keep content puts what the Split held in its place, selects the first, in one step one Undo takes back', async () => {
    const before = structuredClone(session.state);
    const revision = session.revision;
    const steps = appliedSteps();
    await answer(startDelete('n_split'), true);
    expect(sentSince(0)).toEqual(['node.removeKeepContent n_split']);
    expect(sent[0].expectedRevision).toBe(revision);
    expect(slot('n_section')).toEqual(['n_before', 'n_heading', 'n_card', 'n_stack', 'n_after']);
    expect(home().nodes).not.toHaveProperty('n_split');
    // The Card keeps its own style, and every kept node its ID and content; the library is as it was.
    for (const id of ['n_heading', 'n_card', 'n_stack', 'n_para']) expect(home().nodes[id], id).toEqual(home(before).nodes[id]);
    expect(session.state.components).toEqual(before.components);
    expect(appliedSteps()).toBe(steps + 1);
    expect(session.historyInfo().undoLabel).toBe('Remove Split on Home, keeping its content');
    // The first alone: several picked together would delete at once, the Card among them, without asking.
    expect(getState().selection).toEqual(ref('n_heading'));
    expect(getState().layerSet).toBeNull();
    const t = lastToast();
    expect(t?.text).toBe('Removed Split and kept 3 items');
    await click(t);
    expect(session.state).toEqual(before);
  });

  it('Remove wrapper & keep content leaves a layer picked while asking as it is, the Split’s own content included', async () => {
    for (const picked of ['n_card', 'n_after']) {
      await open(fixture());
      const started = startDelete('n_split');
      select(picked);
      await answer(started, true);
      expect(slot('n_section'), picked).toEqual(['n_before', 'n_heading', 'n_card', 'n_stack', 'n_after']);
      expect(getState().selection, picked).toEqual(ref(picked));
    }
  });

  it('asks for a plain Stack with a placement deep inside it, and counts several placements', async () => {
    const s = fixture();
    await open(
      applyOperations(s, [
        { type: 'node.insert', newNodeId: 'n_row', owner: page(s), parentId: 'n_stack', primitive: 'row' },
        { type: 'node.move', owner: page(s), nodeId: 'n_card', parentId: 'n_row', index: 0 }
      ]).state
    );
    const section = startDelete('n_section');
    expect(getConfirm()?.details?.[0].text).toBe('Delete all removes it and everything inside it, including 2 placed components with their own content.');
    await answer(section, null);
    const stack = startDelete('n_stack');
    const q = getConfirm()!;
    expect(q.title).toBe('Delete “Stack”?');
    expect(q.body).toBe('It holds 2 items. Delete them with it, or keep them where they are?');
    expect(q.details?.[0].text).toBe('Delete all removes it and everything inside it, including a placed component with its own content.');
    await answer(stack, true);
    expect(slot('n_split', 'right')).toEqual(['n_para', 'n_row']);
    expect((home().nodes.n_row as ElementNode).children).toEqual(['n_card']);
    expect(lastToast()?.text).toBe('Removed Stack and kept 2 items');
  });

  it('keeping a Section’s paragraph on the page’s top level puts it in a new Section where that one was', async () => {
    const s = fixture();
    await open(
      applyOperations(s, [
        { type: 'node.insert', newNodeId: 'n_note', owner: page(s), parentId: 'n_empty', slot: 'content', primitive: 'paragraph', text: 'Note' },
        { type: 'node.move', owner: page(s), nodeId: 'n_empty', parentId: null, index: 0 }
      ]).state
    );
    const before = structuredClone(session.state);
    const note = structuredClone(home().nodes.n_note);
    const started = startDelete('n_empty');
    expect(getConfirm()?.body).toBe('It holds 1 item. Delete them with it, or keep them where they are?');
    expect(getConfirm()?.details?.slice(0, 2).map((d) => d.text)).toEqual(['Delete all removes it and everything inside it.', 'Remove wrapper & keep content puts that item in its place.']);
    await answer(started, true);
    const [first, second] = home().rootIds;
    expect(home().rootIds).toHaveLength(2);
    expect(second).toBe('n_section');
    expect(first).not.toBe('n_empty');
    const wrapper = home().nodes[first] as InstanceNode;
    expect(session.state.components[wrapper.definitionId]?.componentId).toBe('layout.section');
    expect(wrapper.slots?.content).toEqual(['n_note']);
    expect(home().nodes.n_note).toEqual(note);
    expect(getState().selection).toEqual(ref(first));
    expect(getState().layerSet).toBeNull();
    expect(lastToast()?.text).toBe('Removed Section and kept 1 item');
    await click(lastToast());
    expect(session.state).toEqual(before);
  });

  it('in a component’s own design, asks about a Stack holding a placement and keeps what it held there', async () => {
    const card = cardId();
    const owner: OwnerRef = { kind: 'component', id: card };
    const before = structuredClone(session.state);
    const started = startDelete(ref('d_stack', owner));
    expect(getConfirm()?.title).toBe('Delete “Stack”?');
    await answer(started, true);
    expect(sent.map((b) => b.operations)).toEqual([[{ type: 'node.removeKeepContent', owner, nodeId: 'd_stack' }]]);
    const tree = session.state.components[card].tree!;
    expect(tree.nodes).not.toHaveProperty('d_stack');
    expect((tree.nodes[tree.rootIds[0]] as ElementNode).children.slice(-2)).toEqual(['d_badge', 'd_text']);
    expect(session.historyInfo().undoLabel).toBe('Remove Stack in the Card design, keeping its content');
    expect(getState().selection).toEqual(ref('d_badge', owner));
    expect(lastToast()?.text).toBe('Removed Stack and kept 2 items');
    await click(lastToast());
    expect(session.state).toEqual(before);
  });

  it('asks once while Delete is pressed again with the question open', async () => {
    const started = startDelete('n_split');
    await deleteSelection();
    expect(pendingConfirms()).toHaveLength(1);
    await answer(started, false);
    expect(sentSince(0)).toEqual(['node.remove n_split']);
  });
});

describe('when what it holds can’t be kept', () => {
  beforeEach(() => open(fixture({ max: 2 })));

  it('offers Delete all and Cancel, saying why; Delete all is one change one Undo takes back', async () => {
    const before = structuredClone(session.state);
    const started = startDelete('n_split');
    const q = getConfirm()!;
    expect([q.confirmLabel, q.cancelLabel, q.stayLabel, q.tone]).toEqual(['Delete all', undefined, undefined, 'caution']);
    expect(q.body).toBe('It holds 3 items, which go with it.');
    expect(q.details?.[1].kind).toBe('note');
    expect(q.details?.[1].text).toMatch(/^What it holds can’t be kept: .*holds at most 2 items/);
    expect(q.details?.[3].text).toBe('One Undo puts it all back.');
    await answer(started, true);
    expect(sentSince(0)).toEqual(['node.remove n_split']);
    expect(slot('n_own')).toEqual([]);
    expect(session.historyInfo().undoLabel).toBe('Delete Split on Home');
    expect(lastToast()?.text).toBe('Deleted Split and 3 nested items');
    await click(lastToast());
    expect(session.state).toEqual(before);
  });

  it('sends nothing for Cancel or a dismissal', async () => {
    const before = JSON.stringify(session.state);
    for (const ok of [false, null]) await answer(startDelete('n_split'), ok);
    expect(sent).toEqual([]);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(getState().toasts).toEqual([]);
  });
});

describe('a project that changes while asking or deleting', () => {
  it('refuses either answer for a project changed meanwhile, to ask again, though what it holds counts the same', async () => {
    for (const ok of [false, true]) {
      await open(fixture());
      const revision = session.revision;
      const started = startDelete('n_split');
      // Something else (the AI, a file saved elsewhere) rewrites the heading in the Split: still the same three items.
      const rewrite = await bridge.project.apply({ operations: [{ type: 'node.setContent', owner: page(), nodeId: 'n_heading', field: 'text', value: 'Rewritten' }] }, { label: 'Elsewhere' });
      expect(rewrite.ok).toBe(true);
      expect(session.revision).toBe(revision + 1);
      const after = JSON.stringify(session.state);
      const steps = appliedSteps();
      await answer(started, ok);
      expect(sent.at(-1)!.operations[0].type, String(ok)).toBe(ok ? 'node.removeKeepContent' : 'node.remove');
      expect(sent.at(-1)!.expectedRevision).toBe(revision);
      expect(JSON.stringify(session.state)).toBe(after);
      expect(appliedSteps()).toBe(steps);
      expect(getState().toasts.map((x) => [x.kind, x.text])).toEqual([['error', 'The project changed while you were choosing. Choose again.']]);
    }
  });

  it('sends nothing when the project closed, or another opened, while asking', async () => {
    const before = JSON.stringify(session.state);
    for (const leave of [() => setState({ snapshot: null }), () => ((opening = 'opening#2'), refresh(null))]) {
      const started = startDelete('n_split');
      leave();
      await answer(started, true);
      opening = OPENING;
      refresh(null);
    }
    expect(sent).toEqual([]);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(getState().toasts).toEqual([]);
  });

  it('announces nothing and selects nothing for a change whose reply arrives after another project opened', async () => {
    let release!: () => void;
    held = new Promise((r) => (release = r));
    const started = startDelete('n_split');
    getConfirm()!.resolve(true);
    // Sent, its reply still on the way.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    opening = 'opening#2';
    setState({ snapshot: snapshotNow(), selection: null });
    release();
    await started.done;
    await pending;
    expect(getState().toasts).toEqual([]);
    expect(getState().selection).toBeNull();
  });

  it('plans a deletion again on the project’s own copy when this window’s is behind, and asks if it now holds a placement', async () => {
    // The project has put the Card in the empty Section (an Undo, say) before this window has heard of it.
    await session.apply({ operations: [{ type: 'node.move', owner: page(), nodeId: 'n_card', parentId: 'n_empty', slot: 'content', index: 0 }] }, { label: 'Elsewhere', source: 'user' });
    const after = JSON.stringify(session.state);
    const started = startDelete('n_empty');
    expect(getConfirm()).toBeNull();
    await vi.waitFor(() => expect(getConfirm()?.title).toBe('Delete “Section”?'));
    expect(getConfirm()?.body).toBe('It holds 1 item. Delete them with it, or keep them where they are?');
    // The first try was refused as planned on an older copy, and nothing was deleted.
    expect(sentSince(0)).toEqual(['node.remove n_empty']);
    await answer(started, null);
    expect(JSON.stringify(session.state)).toBe(after);
    expect(getState().toasts).toEqual([]);
  });

  it('deletes a leaf unasked when this window’s copy is behind with an unrelated change, with no refusal shown', async () => {
    await session.apply({ operations: [{ type: 'node.setContent', owner: page(), nodeId: 'n_heading', field: 'text', value: 'Typed' }] }, { label: 'Typed', source: 'user' });
    const { done } = startDelete('n_after');
    await done;
    await pending;
    expect(sentSince(0)).toEqual(['node.remove n_after', 'node.remove n_after']);
    expect(home().nodes).not.toHaveProperty('n_after');
    expect(getState().toasts.map((t) => t.text)).toEqual(['Deleted Text']);
  });

  it('deletes nothing unasked that changed before this window heard of it, and says to look again', async () => {
    // The AI rewrites the paragraph the author is deleting, before this window has heard of it.
    await session.apply({ operations: [{ type: 'node.setContent', owner: page(), nodeId: 'n_para', field: 'text', value: 'Rewritten' }] }, { label: 'Elsewhere', source: 'user' });
    const after = JSON.stringify(session.state);
    const { done } = startDelete('n_para');
    await done;
    await pending;
    expect(sentSince(0)).toEqual(['node.remove n_para']);
    expect(JSON.stringify(session.state)).toBe(after);
    expect(getState().toasts.map((x) => [x.kind, x.text])).toEqual([['error', 'Text changed before it could be deleted. Check it, then delete it again.']]);
  });

  it('keeps a save waiting while an unasked deletion is planned again, until it lands', async () => {
    await session.apply({ operations: [{ type: 'node.setContent', owner: page(), nodeId: 'n_heading', field: 'text', value: 'Typed' }] }, { label: 'Typed', source: 'user' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const snapshot = bridge.project.snapshot;
    // The project's own copy is slow to come: the deletion is between its two sends.
    bridge.project.snapshot = async () => (await gate, snapshotNow());
    try {
      const { done } = startDelete('n_after');
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await pending;
      let settled = false;
      const saving = appliesLanded().then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);
      release();
      await done;
      await saving;
      expect(home().nodes).not.toHaveProperty('n_after');
    } finally {
      bridge.project.snapshot = snapshot;
    }
  });

  it('deletes another layer picked and deleted while the first deletion is still saving', async () => {
    let release!: () => void;
    held = new Promise((r) => (release = r));
    const first = startDelete('n_para');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const second = startDelete('n_after');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    release();
    await Promise.all([first.done, second.done]);
    await pending;
    // Both were planned on the same copy: the second, refused as behind, went again once the first had landed.
    expect(sentSince(0)).toEqual(['node.remove n_para', 'node.remove n_after', 'node.remove n_after']);
    expect(getState().toasts.map((x) => x.text)).toEqual(['Deleted Text', 'Deleted Text']);
    expect(home().nodes).not.toHaveProperty('n_para');
    expect(home().nodes).not.toHaveProperty('n_after');
  });

  it('asks nothing and sends nothing while the AI works', async () => {
    const before = JSON.stringify(session.state);
    setState({ snapshot: { ...getState().snapshot!, aiBusy: true } });
    const { done } = startDelete('n_split');
    expect(getConfirm()).toBeNull();
    await done;
    expect(sent).toEqual([]);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(lastToast()?.text).toBe('The AI is making changes. Stop it to edit manually.');
  });

  it('asks nothing in a project open read-only: the plain deletion it sends is refused there', async () => {
    const before = JSON.stringify(session.state);
    const reason = 'This project is open in another window, so it is read-only here.';
    refusing = reason;
    setState({ snapshot: { ...getState().snapshot!, readOnly: { reason, canUnlock: true } } });
    const { done } = startDelete('n_split');
    expect(getConfirm()).toBeNull();
    await done;
    expect(sentSince(0)).toEqual(['node.remove n_split']);
    expect(JSON.stringify(session.state)).toBe(before);
    expect(lastToast()).toMatchObject({ kind: 'error', text: reason });
  });
});
