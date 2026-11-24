import type { EditOperation } from '@shared/ops';
import type { ElementRef, GraphNode, OwnerRef, ProjectState, RichText } from '@shared/types';
import { newId } from '@shared/ids';
import { sameRichText, toRichText } from '@shared/richtext';
import { isBinding, sameRef } from '@shared/types';
import { childLists, findParent } from '@engine/tree';
import type { ProjectSnapshot } from '@shared/api';
import { pageShowing } from '@shared/page-shell';
import { applyOperations } from '@engine/apply';
import { missingSectionLinks } from '@generator/checks';
import { api, applyOps, commitOps, getState, saveLocal, setState, toast, undoAction } from '../store';
import { appliesLanded, trackApply, type ApplyOutcome } from './pending';
import { storedEdit } from './richtext';
import { showAsset } from './place';
import { boundaryOf, computedAt, followsPageAt, listPropFor, ownerLabel, refLabel, resolveRef, shownOrDefault, treeFor } from './model';
import { forgetPlace, placeOn, selectionBack } from './page-place';
import { duplicateOps, groupOf, layerRef, liveSet, moveIntoOps, moveStepOps, moveToPageOps, removeOps, type Group, type LayerSet } from './layer-set';

export type Primitive = 'container' | 'stack' | 'row' | 'grid' | 'heading' | 'paragraph' | 'image' | 'button' | 'icon' | 'divider';

export function currentOwner(): OwnerRef | null {
  const s = getState();
  if (s.definitionMode) return { kind: 'component', id: s.definitionMode.definitionId };
  return s.pageId ? { kind: 'page', id: s.pageId } : null;
}

/** Only nodes in the owner tree itself (not inside component definitions) can be moved, duplicated or removed.
 *  While a component is edited everywhere its own nodes can, except its root, which is the component itself
 *  (`withRoot` keeps it, for inserting into it). */
export function structuralTarget(ref: ElementRef | null, { withRoot = false, state }: { withRoot?: boolean; state?: ProjectState } = {}): ElementRef | null {
  if (!ref) return null;
  const st = state ?? getState().snapshot!.state;
  const b = boundaryOf(st, ref);
  if (b.instancePath.length) return null;
  if (!withRoot && b.owner.kind === 'component' && st.components[b.owner.id]?.tree?.rootIds[0] === b.nodeId) return null;
  return b;
}

export async function deleteSelection() {
  const s = getState();
  const t = structuralTarget(s.selection);
  if (!t || !s.snapshot) return;
  const label = refLabel(s.snapshot.state, t);
  if (t.owner.kind === 'shell') return toast('The shared header and footer cannot be deleted. Hide either one on a page in its page settings instead.', 'error');
  const r = await commitOps([{ type: 'node.remove', owner: t.owner, nodeId: t.nodeId }], `Delete ${label}`);
  // A reply that arrives after its project closed has nothing left here to select or announce.
  if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
  // What the author selected meanwhile (another page, opened at its place) is theirs, and stays.
  if (sameRef(getState().selection, s.selection)) setState({ selection: null });
  toast(`Deleted ${label}`, 'info', undoAction(r));
}

export async function duplicateSelection() {
  const s = getState();
  const t = structuralTarget(s.selection);
  if (!t || t.owner.kind === 'shell') return;
  const r = await applyOps([{ type: 'node.duplicate', owner: t.owner, nodeId: t.nodeId }], 'Duplicate');
  const id = r?.[0]?.nodeId as string | undefined;
  if (id) setState({ selection: { owner: t.owner, instancePath: [], nodeId: id } });
}

export async function moveSelection(dir: -1 | 1) {
  const s = getState();
  const t = structuralTarget(s.selection);
  if (!t || !s.snapshot) return;
  const tree = treeFor(s.snapshot.state, t.owner);
  if (!tree) return;
  const info = findParent(tree, t.nodeId);
  if (!info) return;
  const index = info.index + dir;
  if (index < 0 || index >= info.list.length) return;
  await applyOps([{ type: 'node.move', owner: t.owner, nodeId: t.nodeId, parentId: info.parentId, slot: info.slot, index }], dir < 0 ? 'Move up' : 'Move down');
}

// ---------------------------------------------------------------------------
// Several layers selected together in Layers (lib/layer-set): each action is one change, so one Undo.
// ---------------------------------------------------------------------------

/**
 * What an action from Layers or a shortcut acts on, planned on the project as this window has it: the layers
 * selected together (`several`), or the selection alone (a part counts as its placement). `selection` is the
 * selection it was planned for, to tell whether the author has moved on by the time it lands.
 */
export interface LayersPlan {
  snap: ProjectSnapshot;
  group: Group;
  several: boolean;
  selection: ElementRef | null;
  /** The layers selected with it then, as the store had them (null for one). */
  layerSet: LayerSet | null;
  /** Where the next Shift pick starts, among the layers selected together. */
  anchor?: string;
}

type EditorPlace = Pick<ReturnType<typeof getState>, 'snapshot' | 'selection' | 'layerSet' | 'pageId' | 'definitionMode'>;

/**
 * The layers selected together, while they apply: the selection is one of them, they still sit side by side, and
 * they are in what Layers shows (the page open, or the component being edited everywhere). An Undo can bring back a
 * page whose layers were selected while another page is open: they are not acted on from there.
 */
export function liveGroup(s: EditorPlace = getState()): Group | null {
  const set = s.layerSet;
  if (!set || !s.snapshot) return null;
  const shown = s.definitionMode ? set.owner.kind === 'component' && set.owner.id === s.definitionMode.definitionId : set.owner.kind === 'page' && set.owner.id === s.pageId;
  return shown ? liveSet(treeFor(s.snapshot.state, set.owner), s.selection, set) : null;
}

export function planLayers(s: EditorPlace = getState()): LayersPlan | null {
  const snap = s.snapshot;
  if (!snap) return null;
  const live = liveGroup(s);
  // The range starts at its anchor while that is still one of them, else at the selection.
  if (live) return { snap, group: live, several: true, selection: s.selection, layerSet: s.layerSet, anchor: live.ids.includes(s.layerSet?.anchor ?? '') ? s.layerSet!.anchor : s.selection!.nodeId };
  const t = structuralTarget(s.selection, { state: snap.state });
  const tree = t ? treeFor(snap.state, t.owner) : undefined;
  const group = t && tree ? groupOf(tree, t.owner, [t.nodeId]) : null;
  return group ? { snap, group, several: false, selection: s.selection, layerSet: s.layerSet } : null;
}

/** "2 sections", or "3 layers" inside a section or a component. */
export function groupCount(g: Group): string {
  const noun = g.owner.kind === 'page' && g.parentId === null ? 'section' : 'layer';
  return `${g.ids.length} ${noun}${g.ids.length === 1 ? '' : 's'}`;
}

/** "Gallery", "Gallery and Testimonials", or "3 sections". */
export function groupName(st: ProjectState, g: Group): string {
  if (g.ids.length > 2) return groupCount(g);
  return g.ids.map((id) => nodeLabel(st, g.owner, id)).join(' and ');
}

/** Why the layers can't be moved, duplicated or deleted, or null when they can. */
function lockedGroup(st: ProjectState, g: Group): string | null {
  if (g.owner.kind === 'shell') return 'The shared header and footer cannot be moved, duplicated or deleted here. Hide either one on a page in its page settings instead.';
  if (g.owner.kind === 'component' && g.ids.includes(treeFor(st, g.owner)?.rootIds[0] ?? '')) return 'This is the component itself. Select layers inside it.';
  return null;
}

/** Whether the author is still where `plan` was made: the same selection (and the same layers with it: an Escape
 *  meanwhile kept just one), in the same opening of the project. */
const stillOn = (plan: LayersPlan) => getState().selection === plan.selection && getState().layerSet === plan.layerSet && getState().snapshot?.workspaceKey === plan.snap.workspaceKey;

/**
 * Once the rows have caught up with a change made from Layers (copies made, a page opened), move keyboard focus to
 * the selection's row: only while focus is still in Layers (or nowhere), so a Tab away meanwhile keeps its place.
 */
export function focusSelectedRow(tries = 10) {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('.layers-tree, .layers-picked')) return;
    const row = document.querySelector<HTMLElement>('.layers-tree [role="treeitem"][data-primary="true"]');
    if (row) row.focus();
    else if (tries > 1) focusSelectedRow(tries - 1);
  }, 60);
}

/** Whether keyboard focus is in Layers as a change is asked for, so focus goes on to what it selects. */
export const focusInLayers = () => typeof document !== 'undefined' && !!document.activeElement?.closest('.layers-tree, .layers-picked');

/** The selection that stands for `plan`'s layers once a change has made `ids` of them (in order): the same one selected, and the same anchor. */
function resultSelection(plan: LayersPlan, ids: string[], owner: OwnerRef = plan.group.owner) {
  const at = (id: string | undefined) => Math.max(0, plan.group.ids.indexOf(id ?? ''));
  return { selection: layerRef(owner, ids[at(plan.selection?.nodeId)]), layerSet: ids.length > 1 ? { owner, ids, anchor: ids[at(plan.anchor)] } : null };
}

/**
 * A menu command for the layers the menu was built for, planned again as it is chosen (a typed field saved while the
 * menu was open changes nothing it acts on). If the layers selected together changed meanwhile, it says so instead.
 */
export const asPlanned = (shown: LayersPlan | null, act: (plan: LayersPlan | null) => Promise<void>) => (): Promise<void> | void => {
  if (!shown?.several) return act(shown);
  const now = planLayers();
  const same = !!now?.several && now.snap.workspaceKey === shown.snap.workspaceKey && now.group.owner.id === shown.group.owner.id && now.group.ids.join() === shown.group.ids.join();
  if (!same) return toast('The layers selected changed while the menu was open. Choose again.', 'error');
  return act(now);
};

/** Move the layers selected together one place up or down, in one change (the selection alone: moveSelection). */
export async function moveLayers(dir: -1 | 1, plan = planLayers()) {
  if (!plan?.several) return moveSelection(dir);
  const why = lockedGroup(plan.snap.state, plan.group);
  if (why) return toast(why, 'error');
  const ops = moveStepOps(plan.group, dir);
  if (ops) await applyOps(ops, `Move ${groupCount(plan.group)} ${dir < 0 ? 'up' : 'down'}`, undefined, plan.snap.revision);
}

/** Duplicate the layers selected together: the copies go together after the last of them, and are selected (with
 *  keyboard focus, when `follow`: asked for from Layers). */
export async function duplicateLayers(plan = planLayers(), follow = focusInLayers()) {
  if (!plan?.several) return duplicateSelection();
  const why = lockedGroup(plan.snap.state, plan.group);
  if (why) return toast(why, 'error');
  const r = await applyOps(duplicateOps(plan.group), `Duplicate ${groupCount(plan.group)}`, undefined, plan.snap.revision);
  const ids = r?.map((x) => x.nodeId);
  if (ids?.length !== plan.group.ids.length || !ids.every((id): id is string => typeof id === 'string') || !stillOn(plan)) return;
  setState(resultSelection(plan, ids));
  if (follow) focusSelectedRow();
}

/** Delete the layers selected together, in one change, with an Undo beside its notice (the selection alone: deleteSelection). */
export async function deleteLayers(plan = planLayers()) {
  if (!plan?.several) return deleteSelection();
  const why = lockedGroup(plan.snap.state, plan.group);
  if (why) return toast(why, 'error');
  const name = groupName(plan.snap.state, plan.group);
  const r = await commitOps(removeOps(plan.group), `Delete ${groupCount(plan.group)}`, undefined, plan.snap.revision);
  if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
  if (stillOn(plan)) setState({ selection: null });
  toast(`Deleted ${name}`, 'info', undoAction(r));
}

/** Move the layers into another container or slot (or the top level), at `to.index`, keeping their order. */
export async function moveLayersInto(to: { parentId: string | null; slot?: string; index: number }, plan = planLayers()): Promise<boolean> {
  if (!plan) return false;
  const why = lockedGroup(plan.snap.state, plan.group);
  if (why) return (toast(why, 'error'), false);
  return !!(await applyOps(moveIntoOps(plan.group, to), plan.several ? `Move ${groupCount(plan.group)}` : 'Move layer', undefined, plan.snap.revision));
}

/** The pages a page's sections can be moved to: every other page, in the site's order. */
export function otherPages(st: ProjectState, pageId: string): Array<{ id: string; title: string }> {
  return st.site.pageOrder.filter((id) => id !== pageId && Object.hasOwn(st.pages, id)).map((id) => ({ id, title: st.pages[id].title }));
}

/**
 * Move sections (the ones selected together, or the one selected) to the end of another page, as one change. That
 * page opens with them selected, unless the author has moved on meanwhile. Section IDs go with them where the page
 * has no section by that ID; a link that jumped to one on the page they left is named in the notice. Returns the
 * moved sections' new IDs, or null when nothing moved.
 */
export async function moveToPage(pageId: string, plan = planLayers(), follow = focusInLayers()): Promise<string[] | null> {
  if (!plan) return null;
  const g = plan.group;
  const st = plan.snap.state;
  const dest = Object.hasOwn(st.pages, pageId) ? st.pages[pageId] : undefined;
  if (g.owner.kind !== 'page' || g.parentId !== null || !dest || pageId === g.owner.id) return null;
  const from = st.pages[g.owner.id]?.title ?? 'this page';
  const ops = moveToPageOps(g, pageId, dest.rootIds.length);
  // Links the move leaves going to a section that isn't there (one that jumped to these sections where they were, or
  // one they carry to a section of the page they left), found on a copy of the project before it is sent.
  let broken = 0;
  try {
    const out = applyOperations(st, ops);
    // Each moved node's copy, back to the node it was copied from: a break a moved link already had is not new.
    const source = new Map<string, string>();
    const pair = (from: string, to: string) => {
      source.set(to, from);
      const a = st.pages[g.owner.id].nodes[from];
      const b = out.state.pages[pageId].nodes[to];
      if (!a || !b) return;
      const lb = childLists(b);
      childLists(a).forEach((l, i) => l.ids.forEach((id, j) => lb[i]?.ids[j] && pair(id, lb[i].ids[j])));
    };
    g.ids.forEach((id, i) => typeof out.results[i]?.nodeId === 'string' && pair(id, out.results[i].nodeId as string));
    const moved = new Set(source.values());
    type Issue = ReturnType<typeof missingSectionLinks>[number];
    // A link that stays put counts again when it breaks on one more page (a shared header's); one that moves, by itself.
    const key = (i: Issue, after: boolean) => {
      const from = after && i.owner.kind === 'page' && i.owner.id === pageId ? source.get(i.nodeId) : undefined;
      const owner = from ? g.owner : i.owner;
      const nodeId = from ?? i.nodeId;
      const travels = owner.kind === 'page' && owner.id === g.owner.id && moved.has(nodeId);
      return JSON.stringify([owner, nodeId, i.fragment, i.pageId ?? null, i.label, travels ? null : [...(i.pages ?? [])].sort()]);
    };
    const before = new Set(missingSectionLinks(st).map((i) => key(i, false)));
    broken = missingSectionLinks(out.state).filter((i) => !before.has(key(i, true))).length;
  } catch {
    // The project refuses it, and says why.
  }
  const name = groupName(st, g);
  const r = await commitOps(ops, `Move ${plan.several ? groupCount(g) : name} to ${dest.title}`, undefined, plan.snap.revision);
  if (!r?.ok) return null;
  const ids = (r.results ?? []).slice(0, g.ids.length).map((x) => x.nodeId);
  if (ids.length !== g.ids.length || !ids.every((id): id is string => typeof id === 'string')) return null;
  if (getState().snapshot?.workspaceKey !== r.workspaceKey) return ids;
  // Followed to their page, selected as they were, unless the author has moved on meanwhile.
  if (stillOn(plan) && getState().pageId === g.owner.id && !getState().definitionMode) {
    selectPage(pageId);
    setState(resultSelection(plan, ids, { kind: 'page', id: pageId }));
    if (follow) focusSelectedRow();
  }
  const note = broken ? ` ${broken === 1 ? 'A link now goes' : `${broken} links now go`} to a section that isn’t there (moved from ${from}): Project health lists ${broken === 1 ? 'it' : 'them'}.` : '';
  toast(`Moved ${name} to the end of ${dest.title}.${note}`, broken ? 'error' : 'info', undoAction(r));
  return ids;
}

/** Where an inserted node goes: into a parent's list (or one of an instance's slots), or the owner's top level. */
export type InsertAt = { owner: OwnerRef; parentId: string | null; slot?: string; index?: number };

/** The slot an element put inside a component goes in: the first one its design shows (a declared slot can be left out
 *  of the design, and what is put in it is then never seen), else the first declared. None when it has no slots. */
function slotFor(state: ProjectState, definitionId: string): string | undefined {
  const def = state.components[definitionId];
  const names = Object.keys(def?.slots ?? {});
  const nodes = Object.values(def?.tree?.nodes ?? {});
  return names.find((name) => nodes.some((n) => n.kind === 'slot' && n.slot === name)) ?? names[0];
}

/** Work out where an inserted section or element should go, relative to the selection (or to `from`), in the project
 *  as this window has it (or as `snapshot` has it). */
export function insertionPoint(kind: 'section' | 'element', from: ElementRef | null = getState().selection, snapshot: ProjectSnapshot | null = getState().snapshot): InsertAt | null {
  return snapshot ? insideComponent(snapshot.state, placeFor(kind, from, snapshot)) : null;
}

function placeFor(kind: 'section' | 'element', from: ElementRef | null, snapshot: ProjectSnapshot): InsertAt | null {
  const owner = currentOwner();
  if (!owner || !snapshot) return null;
  const state = snapshot.state;
  const tree = treeFor(state, owner);
  if (!tree) return null;
  const sel = structuralTarget(from, { withRoot: true, state });
  if (sel && sel.owner.kind === owner.kind && sel.owner.id === owner.id) {
    const node = tree.nodes[sel.nodeId];
    // Elements go inside a selected container or section slot.
    if (kind === 'element' && node) {
      if (node.kind === 'element') return { owner, parentId: node.id };
      const slot = node.kind === 'instance' ? slotFor(state, node.definitionId) : undefined;
      if (slot) return { owner, parentId: node.id, slot };
    }
    const info = findParent(tree, sel.nodeId);
    if (info) {
      if (kind === 'section' && info.parentId) {
        // Insert after the top-level section containing the selection.
        let top = sel.nodeId;
        let p = findParent(tree, top);
        while (p?.parentId) {
          top = p.parentId;
          p = findParent(tree, top);
        }
        return { owner, parentId: null, index: tree.rootIds.indexOf(top) + 1 };
      }
      return { owner, parentId: info.parentId, slot: info.slot, index: info.index + 1 };
    }
  }
  if (kind === 'element' && owner.kind === 'page') {
    // Put loose elements inside the last flexible section when there is one.
    const last = [...tree.rootIds].reverse().map((id) => tree.nodes[id]).find((n) => n?.kind === 'instance' && slotFor(state, n.definitionId));
    if (last?.kind === 'instance') return { owner, parentId: last.id, slot: slotFor(state, last.definitionId) };
  }
  return { owner, parentId: null };
}

/**
 * A component has one top-level element, the component itself: what would go beside it goes at the end of it, and
 * nothing can be inserted into one that holds nothing (a paragraph). A design from an older version without its one
 * root keeps the top level, where an element can be inserted to hold the others.
 */
function insideComponent(state: ProjectState, at: InsertAt | null): InsertAt | null {
  if (!at || at.owner.kind !== 'component' || at.parentId) return at;
  const tree = treeFor(state, at.owner);
  if (tree?.rootIds.length !== 1) return at;
  const node = tree.nodes[tree.rootIds[0]];
  if (node?.kind === 'element') return { owner: at.owner, parentId: node.id };
  const slot = node?.kind === 'instance' ? slotFor(state, node.definitionId) : undefined;
  if (slot) return { owner: at.owner, parentId: node!.id, slot };
  return node?.kind === 'repeat' || node?.kind === 'slot' ? at : null;
}

/**
 * The operations that insert one element at `at`, as one change: a loose element on a page with no flexible section
 * goes into a new Section made for it. The element is the last one inserted; `nodeId` names it, for operations in
 * the same batch that fill it.
 */
function elementOps(at: InsertAt, spec: { primitive: Primitive }, nodeId?: string): EditOperation[] {
  const named = nodeId ? { newNodeId: nodeId } : {};
  if (at.owner.kind === 'page' && !at.parentId) {
    const sectionId = newId('n');
    return [
      { type: 'node.insert', newNodeId: sectionId, owner: at.owner, parentId: null, index: at.index, componentId: 'layout.section' },
      { type: 'node.insert', ...named, owner: at.owner, parentId: sectionId, slot: 'content', ...spec }
    ];
  }
  return [{ type: 'node.insert', ...named, owner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index, ...spec }];
}

export async function insert(spec: { componentId?: string; definitionId?: string; primitive?: Primitive; variants?: Record<string, string> }, label: string) {
  const isSection = !spec.primitive;
  const at = insertionPoint(isSection ? 'section' : 'element');
  if (!at) return;
  const ops: EditOperation[] = spec.primitive ? elementOps(at, { primitive: spec.primitive }) : [{ type: 'node.insert', owner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index, ...spec }];
  const r = await applyOps(ops, `Insert ${label}`);
  const id = r?.at(-1)?.nodeId as string | undefined;
  if (id) setState({ selection: { owner: at.owner, instancePath: [], nodeId: id }, rightTab: 'inspect' });
}

/** Where an insert lands, in words: "after" + "Split hero". `node`: the target is an element, not the page itself. */
export type Where = { lead: string; target: string; node?: boolean } | null;

/** The node just before an insertion index, in the list that index counts in. */
export function nodeBefore(st: ProjectState, owner: OwnerRef, parentId: string | null, slot: string | undefined, index: number | undefined): string | null {
  if (!index) return null;
  const tree = treeFor(st, owner);
  if (!tree) return null;
  if (!parentId) return tree.rootIds[index - 1] ?? null;
  const parent = tree.nodes[parentId];
  if (!parent) return null;
  const lists = childLists(parent);
  return ((slot ? lists.find((l) => l.slot === slot) : lists[0])?.ids ?? [])[index - 1] ?? null;
}

export const nodeLabel = (st: ProjectState, owner: OwnerRef, nodeId: string) => refLabel(st, { owner, instancePath: [], nodeId });

/** Where a basic element inserted at `at` goes. On a page with nowhere to put it, insert() wraps it in a new section. */
export function elementWhere(st: ProjectState, at: InsertAt | null): Where {
  if (!at) return null;
  const before = nodeBefore(st, at.owner, at.parentId, at.slot, at.index);
  if (at.owner.kind === 'page' && !at.parentId)
    return before ? { lead: 'in a new section after', target: nodeLabel(st, at.owner, before), node: true } : { lead: at.index === 0 ? 'in a new section at the top of' : 'in a new section at the end of', target: ownerLabel(st, at.owner) };
  if (before) return { lead: 'after', target: nodeLabel(st, at.owner, before), node: true };
  if (at.parentId) return { lead: 'inside', target: nodeLabel(st, at.owner, at.parentId), node: true };
  return { lead: 'at the end of', target: ownerLabel(st, at.owner) };
}

/** Where Place on page puts a library image (`key` tells two placements apart), or why it can't be placed now. */
export type ImagePlacement = { at: InsertAt; where: NonNullable<Where>; page: string; key: string } | { at: null; reason: string };

/**
 * Where Place on page puts a library image: on the page being edited, by the rule an inserted image element follows,
 * in the project as this window has it (or as `snap` has it). A picture or part inside a placed component counts as
 * that component, so the image goes beside it (after the Gallery a picture belongs to). A header or footer selection
 * is not on the page, so the page's own rule applies.
 */
export function imagePlacement(snap: ProjectSnapshot | null = getState().snapshot): ImagePlacement {
  const s = getState();
  if (!snap) return { at: null, reason: 'No project is open.' };
  if (snap.readOnly) return { at: null, reason: 'This project is open read-only, so the image can’t be placed.' };
  if (snap.aiBusy) return { at: null, reason: 'The AI is making changes. Stop it to place the image.' };
  if (s.definitionMode) return { at: null, reason: 'Finish editing this component to place the image on a page.' };
  if (s.mode === 'preview') return { at: null, reason: 'Switch to Edit to place the image on a page.' };
  const page = s.pageId ? snap.state.pages[s.pageId] : undefined;
  if (!page) return { at: null, reason: 'Open a page to place the image on it.' };
  const sel = s.selection;
  const onPage = sel?.owner.kind === 'page' && sel.owner.id === page.id;
  const from = onPage && sel.instancePath.length ? { owner: sel.owner, instancePath: [], nodeId: sel.instancePath[0] } : onPage ? sel : null;
  const at = insertionPoint('element', from, snap);
  const where = elementWhere(snap.state, at);
  if (!at || !where || at.owner.kind !== 'page') return { at: null, reason: 'Open a page to place the image on it.' };
  // The node it goes after is named by ID: two Galleries side by side share a label, and can trade places.
  const before = nodeBefore(snap.state, at.owner, at.parentId, at.slot, at.index);
  return { at, where, page: page.title, key: JSON.stringify([snap.workspaceKey, at, before, where]) };
}

/** How long a placement waits for changes already on their way when it was asked for (a suggested alt text committed
 *  as the author clicked away from it). A change that takes longer (a large import) is not waited for: the
 *  placement is planned again if it lands first. */
const EARLIER_MS = 1500;

/** Resolves when `p` settles, or after `ms`, whichever comes first. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Place a library image on the page being edited, as a new image element with the image's suggested alt text,
 * where `imagePlacement` says. Its other uses stay as they are. `shown` is the placement's `key` as the author saw it.
 * Changes already on their way go first (briefly). The image then goes there only on the revision it was planned
 * on: when the project has moved on meanwhile (a change this window has not heard of yet), it is planned again on
 * the project's own copy and placed only if it still goes where the author was shown, up to twice. One change, so
 * one Undo takes it (and a section made for it) away again. The whole placement counts as a save in flight until it
 * ends, so saving or leaving the project waits for it. Returns whether the image was placed.
 */
export async function placeAsset(assetId: string, shown: string): Promise<boolean> {
  // Where the author is as they click: the opening the image is for, and the selection and dock it may change.
  const start = getState();
  const opening = start.snapshot?.workspaceKey;
  const earlier = appliesLanded();
  let landed!: (o: ApplyOutcome) => void;
  trackApply(new Promise<ApplyOutcome>((r) => (landed = r)));
  setState({ pendingSave: getState().pendingSave + 1 });
  let outcome: ApplyOutcome = { ok: true };
  const refuse = (message: string, kind: 'error' | 'info' = 'error') => {
    toast(message, kind);
    outcome = { ok: false, message };
    return false;
  };
  try {
    await within(earlier, EARLIER_MS);
    let snap = getState().snapshot;
    // Planned on this window's copy, then on the project's own; never once the project has closed or opened again.
    for (let tries = 0; snap && opening && snap.workspaceKey === opening && getState().snapshot?.workspaceKey === opening; tries++) {
      const asset = Object.hasOwn(snap.state.assets.assets, assetId) ? snap.state.assets.assets[assetId] : undefined;
      if (asset?.kind !== 'image') return refuse('That image is no longer in Assets.');
      if (snap.missingAssets?.some((m) => m.assetId === assetId && m.original)) return refuse('Locate the file to place this image.');
      const p = imagePlacement(snap);
      if (!p.at) return refuse(p.reason);
      // The page, the selection or what is around it changed: the panel now shows where it would go.
      if (p.key !== shown) return refuse('Where the image would go has changed. Check the new place, then place it again.', 'info');
      const name = asset.name.trim() || 'the image';
      const nodeId = newId('n');
      const owner = p.at.owner;
      const ops: EditOperation[] = [...elementOps(p.at, { primitive: 'image' }, nodeId), { type: 'node.setContent', owner, nodeId, field: 'image', value: asset.id }];
      const r = await commitOps(ops, `Place ${name}`, undefined, snap.revision, { replanStale: tries < 2 });
      // Refused, and said why (the AI started, the project changed again): that change's own record reports it.
      if (!r) return false;
      if (!r.ok) {
        snap = await api.project.snapshot().catch(() => null);
        if (!snap && getState().snapshot?.workspaceKey === opening) return refuse('The image was not placed: the project could not be checked again. Try placing it again.');
        continue;
      }
      const now = getState();
      // Selected only while the author is still where it was placed and has not selected something else; its
      // inspector opens only if the author has not moved the dock meanwhile (to the AI, say).
      if (now.snapshot?.workspaceKey === r.workspaceKey && now.pageId === owner.id && now.mode === 'edit' && !now.definitionMode && now.selection === start.selection)
        setState({ selection: { owner, instancePath: [], nodeId }, ...(now.rightTab === start.rightTab && now.dockOpen === start.dockOpen ? { rightTab: 'inspect' as const, dockOpen: true } : {}) });
      toast(`Placed “${name}” ${p.where.lead} ${p.where.target}${p.where.node ? ` on ${p.page}` : ''}.`, 'info', undoAction(r));
      return true;
    }
    // The project closed or was opened again before the image could be placed in it.
    outcome = { ok: false, message: 'The image was not placed: the project was closed while it was being placed.' };
    return false;
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
    landed(outcome);
  }
}

/** The field an inline edit on the canvas writes: a text node's text, or a link's (button's) label. */
function inlineField(node: GraphNode | undefined): { field: 'text' | 'label'; value: unknown } | null {
  if (node?.kind === 'text') return { field: 'text', value: node.text };
  if (node?.kind === 'link') return { field: 'label', value: node.label };
  return null;
}

/** Whether an edit leaves the field as it was. Rich text compares as canonical blocks, plain text as a string. */
function sameValue(current: unknown, next: string | RichText): boolean {
  if (!Array.isArray(next)) return typeof current === 'string' && current === next;
  return sameRichText(toRichText(current), next);
}

/**
 * Whether the plain text a canvas element showed (`shown`, as the preview read it) is what its field holds in
 * `snapshot`: an edit begun before the page caught up with the project was typed over something else.
 */
export function showsInlineText(snapshot: ProjectSnapshot, ref: ElementRef, shown: string): boolean {
  const target = inlineField(resolveRef(snapshot.state, ref).node as GraphNode | undefined);
  if (!target) return false;
  const v = shownOrDefault(snapshot.state, ref, target.value);
  const words = (t: string) => t.replace(/\s+/g, ' ').trim();
  return typeof v === 'string' ? words(v) === words(shown) : !v && !words(shown);
}

/**
 * Commit inline text from the canvas to the right document field, as that field is in `snapshot` (by default
 * the project now; the project when editing began, for a typed edit, checked before it is applied). Text that
 * ends up as it was makes no edit. 'restore' asks the page to put back the text it showed: the edit made no
 * change, or was not saved (it was held, or refused).
 */
export async function commitText(ref: ElementRef, text: string | RichText, snapshot = getState().snapshot): Promise<'restore' | void> {
  if (!snapshot) return;
  const r = resolveRef(snapshot.state, ref);
  const target = inlineField(r.node as GraphNode | undefined);
  if (!target) return;
  // A repeated item without the field shows the field's default, which is what the edit started from.
  const current = shownOrDefault(snapshot.state, ref, target.value);
  text = storedEdit(r.node as GraphNode | undefined, current, text);
  if (sameValue(current, text)) return;
  // A news card or article header shows a page's settings: typing over it would change nothing, so it goes back.
  if (computedAt(snapshot.state, ref, target.value)) {
    toast('This comes from the article’s page settings. Change its title, date, byline or excerpt there.', 'info');
    return 'restore';
  }
  // Erasing a card's text that comes from its page leaves the card as it was (it has no text of its own to clear):
  // the page puts its text back.
  if (typeof text === 'string' && !text.trim() && followsPageAt(snapshot.state, ref, target.value)) {
    toast('This card shows its page’s text while it has none of its own. Type different text to show it here instead.', 'info');
    return 'restore';
  }
  const label = (target.field === 'label' ? 'Edit button text' : 'Edit text') + (ref.owner.kind === 'component' ? ' everywhere' : '');
  if (!ref.instancePath.length) return (await applyOps([{ type: 'node.setContent', owner: ref.owner, nodeId: ref.nodeId, field: target.field, value: text }], label)) ? undefined : 'restore';
  if (ref.instancePath.length > 1) return toast('Edit nested component text from the inspector.', 'error');
  const instId = ref.instancePath[0];
  const binding = target.value;
  if (!isBinding(binding)) return toast('This text is part of the component design. Use Edit everywhere or Make unique to change it.', 'error');
  if ('$prop' in binding) {
    // Text bound to one field of an object property changes that field alone.
    if (!(await applyOps([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: binding.$prop, ...(binding.field !== undefined ? { field: binding.field } : {}), value: text }], label))) return 'restore';
  } else {
    // The list the repeated item belongs to: the one the enclosing repeat shows (matching field names alone
    // cannot tell a footer's links from its contact links).
    const listProp = listPropFor(r.def!, ref.nodeId);
    const itemId = ref.itemPath?.[ref.itemPath.length - 1];
    if (!listProp || !itemId) return;
    if (!(await applyOps([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: listProp, itemId, field: binding.$item, value: text }], label))) return 'restore';
  }
}

/** Text and button labels can be edited on the canvas when they are the page's own, or a placement's content. */
export function canInlineEdit(ref: ElementRef): boolean {
  const s = getState();
  if (!s.snapshot) return false;
  const target = inlineField(resolveRef(s.snapshot.state, ref).node);
  if (!target) return false;
  if (computedAt(s.snapshot.state, ref, target.value)) return false;
  // A component's own text (editing it everywhere) is its design; a bound field is filled in per placement.
  if (ref.owner.kind === 'component') return !ref.instancePath.length && !isBinding(target.value);
  if (!ref.instancePath.length) return true;
  return ref.instancePath.length === 1 && isBinding(target.value);
}

/**
 * Open a page. Another page opens at the element last selected there (lib/page-place), so the author resumes where
 * they were; `target` names what to select instead, and null opens the page itself and forgets its place. Choosing the
 * page already shown selects the page itself too. In Preview nothing is selected.
 */
export function selectPage(pageId: string, target?: ElementRef | null) {
  const s = getState();
  const st = s.snapshot?.state;
  const itself = target === null || (target === undefined && pageId === s.pageId && !s.definitionMode && s.mode === 'edit');
  const selection = target !== undefined ? target : s.mode === 'edit' && !itself && st ? placeOn(st, s.pagePlaces, pageId) : null;
  // A page opened while previewing is where Edit opens: what was selected before Preview is not selected again.
  setState({ pageId, selection, definitionMode: null, previewReturn: null, ...(itself ? { pagePlaces: forgetPlace(s.pagePlaces, pageId) } : {}) });
  saveLocal({ pageId });
}

/**
 * Open a page that shows the shared header or footer, when the page on screen does not: each page chooses them on its
 * own, so an element selected there would not be on the canvas. Editing a component everywhere ends, since the part
 * is then selected as itself. False when no page shows that part.
 */
export function goToShellPart(part: string): boolean {
  const s = getState();
  const st = s.snapshot?.state;
  const pageId = st && pageShowing(st, part, s.definitionMode?.returnPageId ?? s.pageId);
  if (!pageId) return false;
  if (pageId !== s.pageId || s.definitionMode) selectPage(pageId);
  return true;
}

export function askAiAbout(ref: ElementRef | null) {
  // Asking about a specific element scopes the message to it; opening the chat generically keeps the
  // scope the user chose.
  // Only a specific element is selected for it: the chat opened generically leaves the selection (and the layers
  // selected with it) as they are.
  setState({ rightTab: 'chat', dockOpen: true, ...(ref ? { selection: ref, chatContextEnabled: { page: true, selection: true } } : {}) });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50);
}

/**
 * The one way to switch Edit and Preview, so every entry point leaves the same selection and inspector state. Preview
 * selects nothing; back in Edit, what was selected is selected again when the visitor stayed where they were (the
 * page and the place on it the author left; Canvas lets it go when the visitor moves on). It is not scrolled to: the
 * visitor may have scrolled the page, and the page stays as they left it.
 */
export function setMode(mode: 'edit' | 'preview') {
  const s = getState();
  const editing = s.definitionMode?.definitionId ?? null;
  if (mode === 'preview') {
    // What is selected is what Edit returns to: also one made while previewing (in Layers, a change shown from the
    // chat), which choosing Preview again lets go of on the page, as entering it does.
    const back = s.selection && s.pageId && s.snapshot ? { pageId: s.pageId, ref: s.selection, revision: s.snapshot.revision, definitionId: editing } : s.mode === 'preview' ? s.previewReturn : null;
    setState({ mode, selection: null, previewReturn: back });
    return;
  }
  if (s.mode === 'edit') return;
  const back = s.previewReturn;
  const st = s.snapshot?.state;
  // A selection made while previewing is the author's latest choice and stays. Otherwise the one Preview was entered
  // with, on the same page and in the same component edited everywhere (or none), while it is still there.
  const ref = !s.selection && back && st && back.pageId === s.pageId && back.definitionId === editing ? selectionBack(st, back.pageId, back.ref, back.revision === s.snapshot?.revision) : null;
  unscrolled = ref;
  setState({ mode, previewReturn: null, ...(ref ? { selection: ref } : {}) });
  // The page Edit returns on (one a visitor's link opened, say) is the page being worked on, and reopens.
  if (s.pageId) saveLocal({ pageId: s.pageId });
}

/** A selection made again without being scrolled to (see setMode). */
let unscrolled: ElementRef | null = null;

/** Whether `ref` is the selection Edit just made again unscrolled: asked once, by the canvas, as it scrolls to a new selection. */
export function takeUnscrolled(ref: ElementRef | null): boolean {
  const quiet = !!ref && ref === unscrolled;
  unscrolled = null;
  return quiet;
}

/** Open Site styles. Site styles are site-wide, so this leaves component editing first: the plum band
 *  must never sit over site-wide controls. */
/** Show one library image in Assets, closing the dialog that asked for it (Project health, an export). */
export function openAsset(assetId: string) {
  setState({ modal: null });
  showAsset(getState().snapshot?.workspaceKey ?? '', assetId);
}

/**
 * Show a page's headings in the Layers panel, leaving component editing and closing the dialog that asked for them
 * (Project health), with focus on the outline.
 */
export function openOutline(pageId?: string | null) {
  const s = getState();
  const target = pageId ?? s.definitionMode?.returnPageId ?? s.pageId;
  if (!target) return;
  if (s.pageId !== target || s.definitionMode) selectPage(target);
  setState({ modal: null, leftTab: 'layers', layersView: 'outline' });
  // The first heading's row, or the outline itself when the page has none.
  requestAnimationFrame(() => requestAnimationFrame(() => (document.querySelector<HTMLElement>('.outline-view .outline-row') ?? document.querySelector<HTMLElement>('.outline-view'))?.focus()));
}

export function openSiteStyles() {
  const dm = getState().definitionMode;
  setState(dm ? { definitionMode: null, pageId: dm.returnPageId, selection: null, rightTab: 'styles', dockOpen: true } : { rightTab: 'styles', dockOpen: true });
}
