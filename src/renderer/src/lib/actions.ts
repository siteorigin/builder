import type { ApplyResult, EditOperation } from '@shared/ops';
import type { ElementRef, GraphNode, OwnerRef, ProjectState, PropSchema, RichText } from '@shared/types';
import { newId } from '@shared/ids';
import { richTextToMarkdown, sameRichText, toRichText } from '@shared/richtext';
import { propBindingSchema } from '@shared/bindings';
import { DEFAULT_TEXT_MAX, MAX_RICH_CHARS } from '@engine/values';
import { tooLongMessage } from '@shared/text-limits';
import { isBinding, refKey, sameRef } from '@shared/types';
import { childLists, findParent } from '@engine/tree';
import { copiesWrong, type ProjectSnapshot } from '@shared/api';
import { pageShowing } from '@shared/page-shell';
import { hasArchivePages } from '@shared/collections';
import { applyOperations, ungroupRefusal } from '@engine/apply';
import { missingSectionLinks } from '@generator/checks';
import { api, applyOps, claimRefusals, commitOps, confirmDialog, copyTextAction, setPageOpener, getState, inspectorFocusRequest, saveLocal, setState, toast, undoAction, useStore, type ConfirmDetail, type State } from '../store';
import { activeWorkspace, canvasCovered, panelAfterSeo } from './workspace';
import { focusInspector } from './inspector-focus';
import { sameSubject, seoDocument } from './seo-view';
import { postAt, postWorkspace } from './posts';
import { withTypedSeo, type TypedSeo } from './seo-preview';
import type { SeoSubject } from '@shared/seo';
import { imageDropOps, imageInsertOps, type ImageTarget } from './image-drop';
import { flushOpenPost, savePostIfOpen } from './post-draft';
import { appliesLanded, trackApply, type ApplyOutcome } from './pending';
import { storedEdit } from './richtext';
import { COPYRIGHT_PROP, keptCopyrightYear, shownCopyright } from '@shared/site-name';
import { showAsset } from './place';
import { endArrival, markArrival } from './arrival';
import { claimForInsert } from './clip-keys';
import type { InsertSpec } from './insert-search';
import { elementWhere, insertAt, insertOps, insertRole, insertSelection, nodeBefore, nodeLabel, slotInsertAt, whereFor, whereText, type InsertAt, type InsertRole, type Where } from './insert-at';
import { SLOT_NO_PLACE } from './slot-contract';
import { clearSlotOps, moveOutOps, slotTitle } from './slot-overview';
import { boundaryOf, codeTextFollowsPage, codeTextShown, codeTextTarget, codeTextDesc, computedAt, followsPageAt, inDefinition, keepPagesValid, listPropFor, refExists, refLabel, resolveRef, shownOrDefault, treeFor, type CodeTextTarget } from './model';
import { NEW_STUDIO, type StudioView } from './studio';
import { forgetPlace, placeOn, selectionBack } from './page-place';
import { sampleEntries, templateOwner } from './template-view';
import { duplicateOps, groupOf, layerRef, liveSet, moveIntoOps, moveStepOps, moveToPageOps, removeOps, type Group, type LayerSet } from './layer-set';
import { editLabel, fieldLabel, placeWords, subjectWords } from './edit-label';
import { listEditLabel } from './list-editor';
import { heldContent, removalKey, type HeldContent } from './delete-content';
import { dropRefusal, savingProblems } from './insert-drop';
import { draftFor, imagesFor, withDraft } from './chatDrafts';
import { previewHandoff, type SeoHandoff } from './seoHandoff';
import type { SlotTarget } from './slot-target';
import { aiRunning, projectBlock } from './blocked';
import { copyEditableText, copyEditing, copyGrant } from './copy-only';

export type { InsertSpec, Primitive } from './insert-search';

export function currentOwner(): OwnerRef | null {
  const s = getState();
  if (s.definitionMode) return { kind: 'component', id: s.definitionMode.definitionId };
  if (s.templateMode) return templateOwner(s.templateMode);
  return s.pageId ? { kind: 'page', id: s.pageId } : null;
}

/** Only nodes in the owner tree itself (not inside component definitions) can be moved, duplicated or removed.
 *  While a component is edited everywhere its own nodes can, except its root, which is the component itself. */
export function structuralTarget(ref: ElementRef | null, { state }: { state?: ProjectState } = {}): ElementRef | null {
  // A slot of a placement is a place to put content, never the placement to move, duplicate or remove.
  if (!ref || ref.slot !== undefined) return null;
  const st = state ?? getState().snapshot!.state;
  const b = boundaryOf(st, ref);
  if (b.instancePath.length) return null;
  if (b.owner.kind === 'component' && st.components[b.owner.id]?.tree?.rootIds[0] === b.nodeId) return null;
  return b;
}

/** Whether `ref` is `target`, or inside it, in `state`'s tree of their owner. */
function holds(state: ProjectState, target: ElementRef, ref: ElementRef | null): boolean {
  const tree = ref && ref.owner.kind === target.owner.kind && ref.owner.id === target.owner.id ? treeFor(state, ref.owner) : undefined;
  const seen = new Set<string>();
  for (let id = tree && ref ? (ref.instancePath[0] ?? ref.nodeId) : null; tree && id && !seen.has(id); id = findParent(tree, id)?.parentId ?? null) {
    if (id === target.nodeId) return true;
    seen.add(id);
  }
  return false;
}

/** "1 item", "3 items". */
const itemCount = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** Why what `t` holds can't be kept when it goes, found on a copy of the project as saving it would, or null when it can. */
function keepRefusal(st: ProjectState, t: ElementRef): string | null {
  const unsaid = 'The project can’t check that here.';
  try {
    const why = dropRefusal(st, [{ type: 'node.removeKeepContent', owner: t.owner, nodeId: t.nodeId }], () => savingProblems(st));
    return why === null ? null : why || unsaid;
  } catch {
    return unsaid;
  }
}


/**
 * Ask what deleting `t` does with what it holds (#662): 'all' deletes it with everything inside it, 'keep' removes only
 * it and leaves what it held in its place, null does neither. When what it holds can't be kept without it, the
 * question says why and offers only deleting it all.
 */
async function askDelete(st: ProjectState, t: ElementRef, label: string, held: HeldContent): Promise<'all' | 'keep' | null> {
  const n = held.items.length;
  const why = keepRefusal(st, t);
  const p = held.placements;
  const placed = p ? `, including ${p === 1 ? 'a placed component with its own content' : `${p} placed components with their own content`}` : '';
  const details: ConfirmDetail[] = [
    { kind: 'lose', text: `Delete all removes it and everything inside it${placed}.` },
    why ? { kind: 'note', text: `What it holds can’t be kept: ${why}` } : { kind: 'keep', text: `Remove wrapper & keep content puts ${n === 1 ? 'that item' : `those ${n} items`} in its place.` },
    { kind: 'note', text: 'Reusable component definitions stay in the library.' },
    { kind: 'undo', text: why ? 'One Undo puts it all back.' : 'Either way, one Undo puts it all back.' }
  ];
  const ask = { title: `Delete “${label}”?`, icon: 'delete' as const, details };
  if (why) return (await confirmDialog({ ...ask, body: `It holds ${itemCount(n)}, which ${n === 1 ? 'goes' : 'go'} with it.`, confirmLabel: 'Delete all', tone: 'caution' })) ? 'all' : null;
  // Keeping is the main choice and Delete all the one that loses work; Cancel, the safe one, takes the first focus.
  const ok = await confirmDialog({ ...ask, body: n === 1 ? 'It holds 1 item. Delete that with it, or keep it where it is?' : `It holds ${n} items. Delete them with it, or keep them where they are?`, confirmLabel: 'Remove wrapper & keep content', cancelLabel: 'Delete all', stayLabel: 'Cancel' });
  return ok === null ? null : ok ? 'keep' : 'all';
}

/** A deletion being asked about or saved: Delete pressed again meanwhile (a held key) asks nothing twice. */
/** A deletion being asked about or saved, by opening and target: Delete pressed again for it meanwhile (a held key)
 *  asks nothing twice, while another layer picked meanwhile is deleted as asked. */
const deleting = new Set<string>();

/**
 * Delete the selection. One holding a component placement or slot content (heldContent) asks first whether to take
 * what it holds with it or keep that in its place (#662); anything else goes at once. Either way, one change and one
 * Undo, said with an Undo beside it.
 */
export async function deleteSelection() {
  const s = getState();
  const t = structuralTarget(s.selection);
  let snap = s.snapshot;
  if (!t || !snap) return;
  if (t.owner.kind === 'shell') return toast('The shared header and footer cannot be deleted. Hide either one on a page in its page settings instead.', 'error');
  const opening = snap.workspaceKey;
  const key = [opening, t.owner.kind, t.owner.id, t.nodeId].join('\n');
  if (deleting.has(key)) return;
  const remove: EditOperation = { type: 'node.remove', owner: t.owner, nodeId: t.nodeId };
  const here = (key: string | undefined) => key === opening && getState().snapshot?.workspaceKey === opening;
  // A reply that arrives after its project closed has nothing left here to select or announce.
  const landed = (r: Awaited<ReturnType<typeof commitOps>>): r is NonNullable<typeof r> => !!r?.ok && here(r.workspaceKey);
  /** Lets go of a selection that went with the change: in `st`, `t` or inside it (`within`), or `t` alone. */
  const letGo = (st: ProjectState, within: boolean) => {
    const sel = getState().selection;
    const gone = within ? holds(st, t, sel) : !!sel && sel.owner.kind === t.owner.kind && sel.owner.id === t.owner.id && (sel.instancePath[0] ?? sel.nodeId) === t.nodeId;
    if (gone) setState({ selection: null });
  };
  const follow = focusInLayers();
  const watch = followChange(opening);
  deleting.add(key);
  /** What the author saw of it: an unasked deletion planned again goes ahead only while that is unchanged. */
  let seen: string | null = null;
  // An unasked deletion is followed from its first send until it lands or is given up, its plans again included, so
  // saving and leaving wait for all of it. A question is not: nothing is on its way while one is open.
  const tracked: { done: ((o: ApplyOutcome) => void) | null } = { done: null };
  const settle = (o: ApplyOutcome = { ok: true }) => {
    tracked.done?.(o);
    tracked.done = null;
  };
  /** Gives the deletion up, saying why here and to a save or leave waiting for it. */
  const giveUp = (message: string) => {
    settle({ ok: false, message });
    toast(message, 'error');
  };
  try {
    for (let tries = 0; ; tries++) {
      const st = snap.state;
      const tree = treeFor(st, t.owner);
      // Gone already (the AI, an Undo, another window's change): nothing left to delete.
      if (!tree || !Object.hasOwn(tree.nodes, t.nodeId)) return;
      const label = refLabel(st, t);
      // A project taking no edits now (open read-only, or the AI at work) says so when the deletion is sent, unasked.
      const held = !snap.readOnly && !snap.aiBusy ? heldContent(tree, t.nodeId) : null;
      if (!held) {
        const now = removalKey(st, t.owner, tree, t.nodeId);
        // Changed since the author chose it (swapped for another component, given new content): theirs to look at again.
        if (seen !== null && now !== seen) return giveUp(`${label} changed before it could be deleted. Check it, then delete it again.`);
        seen = now;
        if (!tracked.done) trackApply(new Promise<ApplyOutcome>((done) => (tracked.done = done)));
        // Sent for the project as this window has it: one that has moved on meanwhile (an Undo, a save still on its way)
        // is planned again on the project's own copy, quietly, and may now hold something to ask about.
        const r = await commitOps([remove], editLabel(st, 'Delete', t), undefined, snap.revision, { replanStale: true });
        if (r && !r.ok) {
          const again = tries < 2 ? await api.project.snapshot().catch(() => null) : null;
          if (!here(opening)) return;
          if (!again || !here(again.workspaceKey)) return giveUp(`${label} was not deleted: the project changed while it was. Delete it again.`);
          snap = again;
          continue;
        }
        if (!landed(r)) return;
        // What went with it goes, also picked again meanwhile; what the author selected elsewhere (another page) stays.
        letGo(st, true);
        return toast(`Deleted ${label}`, 'info', undoAction(r));
      }
      settle();
      const choice = await askDelete(st, t, label, held);
      // Closed, or another project opened, while the question was open: nothing of it is here to delete.
      if (!choice || !here(opening)) return;
      const n = held.items.length;
      // Only the project the question described: one changed since (the AI, a file saved elsewhere) is refused, to ask again.
      if (choice === 'all') {
        const r = await commitOps([remove], editLabel(st, 'Delete', t), undefined, snap.revision);
        if (!landed(r)) return;
        letGo(st, true);
        return toast(`Deleted ${label} and ${n} nested ${n === 1 ? 'item' : 'items'}`, 'info', undoAction(r));
      }
      const r = await commitOps([{ type: 'node.removeKeepContent', owner: t.owner, nodeId: t.nodeId }], `${editLabel(st, 'Remove', t)}, keeping its content`, undefined, snap.revision);
      if (!landed(r)) return;
      // What took its place first is selected, unless the author has moved on meanwhile. One alone: several picked
      // together would delete at once, without asking about any placement among them.
      const id = r.results?.[0]?.nodeId;
      if (typeof id === 'string' && watch.still()) {
        setState({ selection: layerRef(t.owner, id), layerSet: null });
        if (follow) focusSelectedRow();
        // What it held stays: only a selection of the wrapper itself went with it.
      } else letGo(st, false);
      return toast(`Removed ${label} and kept ${itemCount(n)}`, 'info', undoAction(r));
    }
  } finally {
    settle();
    deleting.delete(key);
    watch.stop();
  }
}

export async function duplicateSelection() {
  const s = getState();
  const t = structuralTarget(s.selection);
  if (!t || t.owner.kind === 'shell' || !s.snapshot) return;
  const r = await applyOps([{ type: 'node.duplicate', owner: t.owner, nodeId: t.nodeId }], editLabel(s.snapshot.state, 'Duplicate', t));
  const id = r?.[0]?.nodeId as string | undefined;
  if (id) setState({ selection: { owner: t.owner, instancePath: [], nodeId: id } });
}

/**
 * The placement a menu offers to detach: a managed component placed on a page, named by the menu itself (a part of it
 * or a component inside its design is not), so the action acts on exactly what the menu names.
 */
export function detachable(st: ProjectState, ref: ElementRef | null): ElementRef | null {
  if (!ref || ref.instancePath.length || ref.partId || ref.slot !== undefined || ref.owner.kind !== 'page') return null;
  const n = resolveRef(st, ref).node;
  if (n?.kind !== 'instance') return null;
  const def = st.components[n.definitionId];
  return def?.kind === 'managed' && def.tree ? ref : null;
}

/** Replace a component placed on a page with the elements it renders, one change, and select what replaced it. */
export async function detachPlacement(ref: ElementRef | null = getState().selection) {
  const st = getState().snapshot?.state;
  const t = st ? detachable(st, ref) : null;
  if (!t || !st) return;
  const label = refLabel(st, t);
  const r = await commitOps([{ type: 'component.detachInstance', owner: t.owner, nodeId: t.nodeId }], editLabel(st, 'Detach', t));
  // A reply that arrives after its project closed has nothing left here to select or announce.
  if (!r?.ok || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
  const id = r.results?.[0]?.nodeId as string | undefined;
  if (id) setState({ selection: { owner: t.owner, instancePath: [], nodeId: id }, layerSet: null });
  toast(`Detached ${label}. Its elements are now part of this page.`, 'info', undoAction(r));
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
  const r = await commitOps([{ type: 'node.move', owner: t.owner, nodeId: t.nodeId, parentId: info.parentId, slot: info.slot, index }], editLabel(s.snapshot.state, 'Move', t, dir < 0 ? 'up' : 'down'));
  showMovedSelection(s.selection, r);
}

/**
 * After a move from the keyboard or a menu, the selection is shown where it went (issue #902), once the page has the
 * move: unless the author has picked something else, or left the project, meanwhile.
 */
function showMovedSelection(ref: ElementRef | null, r: (ApplyResult & { workspaceKey: string }) | null) {
  const now = getState();
  if (!ref || !r?.ok || now.selection !== ref || now.snapshot?.workspaceKey !== r.workspaceKey) return;
  setState({ showMoved: { ref, revision: r.revision } });
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

type EditorPlace = Pick<ReturnType<typeof getState>, 'snapshot' | 'selection' | 'layerSet' | 'pageId' | 'definitionMode'> & { templateMode?: ReturnType<typeof getState>['templateMode'] };

/**
 * The layers selected together, while they apply: the selection is one of them, they still sit side by side, and
 * they are in what Layers shows (the page open, or the component being edited everywhere). An Undo can bring back a
 * page whose layers were selected while another page is open: they are not acted on from there.
 */
export function liveGroup(s: EditorPlace = getState()): Group | null {
  const set = s.layerSet;
  if (!set || !s.snapshot) return null;
  const shown = s.definitionMode
    ? set.owner.kind === 'component' && set.owner.id === s.definitionMode.definitionId
    : s.templateMode
      ? set.owner.kind === templateOwner(s.templateMode).kind && set.owner.id === s.templateMode.collectionId
      : set.owner.kind === 'page' && set.owner.id === s.pageId;
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

/** A change to the layers selected together, as History names it: "Move Gallery and Testimonials up on Home". */
function groupLabel(st: ProjectState, verb: string, g: Group, detail?: string): string {
  return `${verb} ${groupName(st, g)}${detail ? ` ${detail}` : ''} ${placeWords(st, g.owner)}`;
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
  if (!ops) return;
  const r = await commitOps(ops, groupLabel(plan.snap.state, 'Move', plan.group, dir < 0 ? 'up' : 'down'), undefined, plan.snap.revision);
  showMovedSelection(plan.selection, r);
}

/** Duplicate the layers selected together: the copies go together after the last of them, and are selected (with
 *  keyboard focus, when `follow`: asked for from Layers). */
export async function duplicateLayers(plan = planLayers(), follow = focusInLayers()) {
  if (!plan?.several) return duplicateSelection();
  const why = lockedGroup(plan.snap.state, plan.group);
  if (why) return toast(why, 'error');
  const r = await applyOps(duplicateOps(plan.group), groupLabel(plan.snap.state, 'Duplicate', plan.group), undefined, plan.snap.revision);
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
  const r = await commitOps(removeOps(plan.group), groupLabel(plan.snap.state, 'Delete', plan.group), undefined, plan.snap.revision);
  if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
  if (stillOn(plan)) setState({ selection: null });
  toast(`Deleted ${name}`, 'info', undoAction(r));
}

/** Move the layers into another container or slot (or the top level), at `to.index`, keeping their order. */
export async function moveLayersInto(to: { parentId: string | null; slot?: string; index: number }, plan = planLayers()): Promise<boolean> {
  if (!plan) return false;
  const why = lockedGroup(plan.snap.state, plan.group);
  if (why) return (toast(why, 'error'), false);
  return !!(await applyOps(moveIntoOps(plan.group, to), groupLabel(plan.snap.state, 'Move', plan.group), undefined, plan.snap.revision));
}

// ---------------------------------------------------------------------------
// Wrap in Stack, Row or Grid, and Ungroup (#386): one operation each, so one change and one Undo.
// ---------------------------------------------------------------------------

export type WrapKind = 'stack' | 'row' | 'grid';
export const WRAP_NAMES: Record<WrapKind, string> = { stack: 'Stack', row: 'Row', grid: 'Grid' };

/**
 * What a menu naming `ref` acts on: the layers selected together when it is one of them (as the shortcuts do), else
 * `ref` alone, whatever is selected (the Inspector of a design's node reached through its placement names the node).
 */
export function planFor(ref: ElementRef | null, s: EditorPlace = getState()): LayersPlan | null {
  const live = planLayers(s);
  if (live?.several && ref && !ref.instancePath.length && ref.owner.kind === live.group.owner.kind && ref.owner.id === live.group.owner.id && live.group.ids.includes(ref.nodeId)) return live;
  return planOne(ref, s);
}

/** What a menu naming `ref` alone acts on (the canvas's: it lets go of the layers selected with it). */
export const planOne = (ref: ElementRef | null, s: EditorPlace = getState()): LayersPlan | null => planLayers({ ...s, selection: ref, layerSet: null });

/**
 * Which of Wrap and Ungroup a menu offers for `plan`'s layers: Wrap for anything but a page's (or layout's) sections and
 * a component's root, Ungroup for containers holding something, there too. What the project refuses beyond that (layers
 * picked apart, a container that links) is said when chosen.
 */
export function wrapOffers(plan: LayersPlan | null): { wrap: boolean; ungroup: boolean } {
  const none = { wrap: false, ungroup: false };
  if (!plan || plan.snap.readOnly) return none;
  const g = plan.group;
  const st = plan.snap.state;
  if (lockedGroup(st, g)) return none;
  const wrap = g.parentId !== null || g.owner.kind === 'component';
  // Only containers that can go (plain ones, not a component's root): one that links, say, is never offered.
  return { wrap, ungroup: g.parentId !== null && !ungroupRefusal(st, g.owner, g.ids) };
}

/** Why there is nothing to wrap or ungroup with the selection, when a shortcut asks: the component's own root says so. */
function nothingPlanned(verb: string) {
  const s = getState();
  const st = s.snapshot?.state;
  const sel = s.selection;
  if (st && sel && !sel.instancePath.length && sel.owner.kind === 'component' && treeFor(st, sel.owner)?.rootIds[0] === sel.nodeId) toast(`This is the component itself, so it can’t be ${verb}. Select layers inside it.`, 'error');
}

/**
 * Follows whether the author stays where a change was asked for while it lands, to select what it made only then. The
 * change's own snapshot can arrive before its reply and let go of a selection it took away (an ungrouped container):
 * that is not the author moving on. Any other new selection, layers picked, page, component, layout, mode or opening is.
 * (What is selected then is only ever what a change that landed made: one refused selects nothing.)
 */
function followChange(workspaceKey: string): { still: () => boolean; stop: () => void } {
  const start = getState();
  const view = (s: State) => [s.pageId, s.definitionMode?.definitionId ?? null, s.templateMode?.collectionId ?? null, s.mode, activeWorkspace(s), s.snapshot?.workspaceKey].join('\n');
  let follow = start.snapshot?.workspaceKey === workspaceKey;
  const stop = useStore.subscribe((now, prev) => {
    if (!follow) return;
    if (view(now) !== view(start)) follow = false;
    else if (now.selection !== prev.selection || now.layerSet !== prev.layerSet)
      follow = now.snapshot !== prev.snapshot && prev.selection === start.selection && prev.layerSet === start.layerSet && !now.selection && !now.layerSet;
  });
  return { still: () => follow, stop };
}

/**
 * Wrap the layers selected together (or the selection alone) in a new Stack, Row or Grid where they are, as one change,
 * and select it (with keyboard focus on its row, when `follow`: asked for from Layers). Said with an Undo beside it.
 */
export async function wrapLayers(kind: WrapKind, plan = planLayers(), follow = focusInLayers()): Promise<boolean> {
  if (!plan) return (nothingPlanned('wrapped'), false);
  const g = plan.group;
  const st = plan.snap.state;
  const why = lockedGroup(st, g);
  if (why) return (toast(why, 'error'), false);
  // The project says why it refuses one (layers picked apart, a component's root), in the notice commitOps shows.
  const op: EditOperation = { type: 'node.wrap', owner: g.owner, nodeIds: g.ids, primitive: kind };
  const name = groupName(st, g);
  const watch = followChange(plan.snap.workspaceKey);
  const r = await commitOps([op], `Wrap ${name} in ${WRAP_NAMES[kind]} ${placeWords(st, g.owner)}`, undefined, plan.snap.revision).finally(watch.stop);
  if (!r?.ok || getState().snapshot?.workspaceKey !== r.workspaceKey) return false;
  const id = r.results?.[0]?.nodeId;
  if (typeof id === 'string' && watch.still()) {
    setState({ selection: layerRef(g.owner, id), layerSet: null });
    if (follow) focusSelectedRow();
  }
  toast(`Wrapped ${name} in a ${WRAP_NAMES[kind]}.`, 'info', undoAction(r));
  return true;
}

/**
 * Ungroup the containers selected together (or the selected one): what each holds takes its place, in order, as one
 * change. What they held is selected, together when there are several. Said with an Undo beside it.
 */
export async function ungroupLayers(plan = planLayers(), follow = focusInLayers()): Promise<boolean> {
  if (!plan) return (nothingPlanned('ungrouped'), false);
  const g = plan.group;
  const st = plan.snap.state;
  const why = lockedGroup(st, g);
  if (why) return (toast(why, 'error'), false);
  const op: EditOperation = { type: 'node.unwrap', owner: g.owner, nodeIds: g.ids };
  const name = groupName(st, g);
  const watch = followChange(plan.snap.workspaceKey);
  const r = await commitOps([op], `Ungroup ${name} ${placeWords(st, g.owner)}`, undefined, plan.snap.revision).finally(watch.stop);
  if (!r?.ok || getState().snapshot?.workspaceKey !== r.workspaceKey) return false;
  const ids = r.results?.[0]?.nodeIds;
  if (Array.isArray(ids) && ids.length && ids.every((id): id is string => typeof id === 'string') && watch.still()) {
    setState({ selection: layerRef(g.owner, ids[0]), layerSet: ids.length > 1 ? { owner: g.owner, ids, anchor: ids[0] } : null });
    if (follow) focusSelectedRow();
  }
  toast(`Ungrouped ${name}.`, 'info', undoAction(r));
  return true;
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
  const start = getState();
  let followMove = stillOn(plan) && start.pageId === g.owner.id && !start.definitionMode && start.mode === 'edit';
  const stopWatching = useStore.subscribe((now, prev) => {
    if (!followMove) return;
    // The post writer or the SEO view opened meanwhile is where the author went (#578, #700).
    if (now.pageId !== start.pageId || now.definitionMode || now.mode !== start.mode || activeWorkspace(now) || now.snapshot?.workspaceKey !== plan.snap.workspaceKey) {
      followMove = false;
    } else if (now.selection !== prev.selection || now.layerSet !== prev.layerSet) {
      // The move's snapshot clears the old selection before the apply reply supplies the new IDs.
      followMove =
        now.snapshot !== prev.snapshot && now.snapshot?.revision === plan.snap.revision + 1 &&
        prev.selection === plan.selection && prev.layerSet === plan.layerSet && !now.selection && !now.layerSet;
    }
  });
  const r = await commitOps(ops, `Move ${plan.several ? groupCount(g) : name} from ${from} to ${dest.title}`, undefined, plan.snap.revision).finally(stopWatching);
  if (!r?.ok) return null;
  const ids = (r.results ?? []).slice(0, g.ids.length).map((x) => x.nodeId);
  if (ids.length !== g.ids.length || !ids.every((id): id is string => typeof id === 'string')) return null;
  if (getState().snapshot?.workspaceKey !== r.workspaceKey) return ids;
  // Followed to their page, selected as they were, unless the author has moved on meanwhile.
  if (followMove) {
    const { selection, layerSet } = resultSelection(plan, ids, { kind: 'page', id: pageId });
    selectPage(pageId, selection);
    setState({ layerSet });
    if (follow) focusSelectedRow();
  }
  const note = broken ? ` ${broken === 1 ? 'A link now goes' : `${broken} links now go`} to a section that isn’t there (moved from ${from}): Project health lists ${broken === 1 ? 'it' : 'them'}.` : '';
  toast(`Moved ${name} to the end of ${dest.title}.${note}`, broken ? 'error' : 'info', undoAction(r));
  return ids;
}

export type { InsertAt, Where } from './insert-at';
export { elementWhere, nodeBefore, nodeLabel } from './insert-at';

/** Work out where an inserted section or element should go, relative to the selection (or to `from`; a part of a
 *  placed component counts as the placement, see insertAt), in the project as this window has it (or as `snapshot`
 *  has it). `definitionId`: the component being inserted (see placeFor). `target`: a slot picked for Insert to fill,
 *  which takes everything (see insertAt). */
export function insertionPoint(kind: InsertRole, from: ElementRef | null = getState().selection, snapshot: ProjectSnapshot | null = getState().snapshot, definitionId?: string, target: SlotTarget | null = null): InsertAt | null {
  const owner = currentOwner();
  if (!snapshot || !owner) return null;
  return insertAt(snapshot.state, owner, kind, from, definitionId, target);
}

/**
 * Where `spec` goes when its tile is clicked now: how it is placed, and the place (a slot picked for Insert, if one
 * is). A slot's placeholder goes where the Slots section puts a new one (see slotInsertAt), in the design being edited
 * only.
 */
export function insertPlan(spec: InsertSpec, snapshot: ProjectSnapshot | null = getState().snapshot): { role: InsertRole; at: InsertAt | null } {
  if (spec.primitive === 'slot') {
    const owner = currentOwner();
    return { role: 'element', at: snapshot && owner?.kind === 'component' ? slotInsertAt(snapshot.state, owner.id, getState().selection) : null };
  }
  const role = snapshot ? insertRole(snapshot.state, spec) : spec.primitive ? 'element' : 'section';
  return { role, at: insertionPoint(role, getState().selection, snapshot, spec.definitionId, getState().slotTarget) };
}

/**
 * Insert `spec` where its tile says (see insertPlan), as one change, and select it. Resolves to the history entry the
 * change made, for an Undo beside it, once it has landed. `tile`: the Insert tile it was added from, which then takes
 * Delete and Copy for it (see claimForInsert).
 */
export async function insert(spec: InsertSpec, label: string, tile?: unknown): Promise<string | undefined> {
  const { role, at } = insertPlan(spec);
  const st = getState().snapshot?.state;
  // A slot's placeholder has a place only in some of the design: said, rather than nothing happening.
  if (!at && st && spec.primitive === 'slot') toast(SLOT_NO_PLACE, 'info');
  if (!at || !st) return;
  // Named here, so what is selected is the thing inserted (or a new Grid's first column), not the last node the
  // change made.
  const id = newId('n');
  const ops = insertOps(at, spec, role, id);
  const from = getState();
  const done = await commitOps(ops, `Insert ${label} ${placeWords(st, at.owner)}`);
  const r = done?.ok ? (done.results ?? []) : null;
  if (!r?.some((x) => x?.nodeId === id)) return;
  // Selected, and outlined with the arrival cue once the page shows it (scrolled to as it mounts). Inserted while
  // previewing (the command menu), it is just selected: Edit shows it as the author left it.
  const ref: ElementRef = { owner: at.owner, instancePath: [], nodeId: insertSelection(ops, id) };
  if (getState().mode === 'edit') markArrival(ref);
  setState({ selection: ref, rightTab: 'inspect' });
  // Not once the author has gone to another view while it landed: what it made may be out of sight there.
  const now = getState();
  if (now.pageId === from.pageId && now.templateMode === from.templateMode && now.definitionMode === from.definitionMode) claimForInsert(tile, ref);
  return done?.entryId;
}

/**
 * Insert `spec` (called `name`) at `at`, a place the author pointed at (a drop from Insert onto the canvas, one of its
 * Add buttons, or a slot's Add in the Inspector), as one change planned on the project as `snap` had it: refused if the
 * project has moved on since. Selected while the author is still on the page (or layout) it went on, with the arrival
 * cue once the page shows it, and said where it went, with an Undo. Returns whether it was inserted. `tile`: the Insert
 * tile dragged from, if any (see claimForInsert).
 */
export async function insertHere(spec: InsertSpec, name: string, role: InsertRole, at: InsertAt, snap: ProjectSnapshot, tile?: unknown): Promise<boolean> {
  if (getState().snapshot?.workspaceKey !== snap.workspaceKey) return false;
  const w = whereFor(snap.state, at, role);
  const from = getState();
  // Named here, so what is selected is the thing inserted (or a new Grid's first column), not the last node the
  // change made.
  const named = newId('n');
  const ops = insertOps(at, spec, role, named);
  const r = await commitOps(ops, `Insert ${name} ${placeWords(snap.state, at.owner)}`, undefined, snap.revision);
  if (!r?.ok || getState().snapshot?.workspaceKey !== r.workspaceKey) return false;
  const id = r.results?.some((x) => x?.nodeId === named) ? insertSelection(ops, named) : undefined;
  const now = getState();
  const owner = at.owner;
  // The shared header and footer show on whatever page or layout the author is on: still on the one they added from.
  const here =
    owner.kind === 'template' || owner.kind === 'archive'
      ? !!now.templateMode && templateOwner(now.templateMode).kind === owner.kind && now.templateMode.collectionId === owner.id
      : owner.kind === 'shell'
        ? now.pageId === from.pageId && now.templateMode?.collectionId === from.templateMode?.collectionId
        : now.pageId === owner.id && !now.templateMode;
  if (id && here && now.mode === 'edit' && !now.definitionMode && !activeWorkspace(now)) {
    const ref: ElementRef = { owner, instancePath: [], nodeId: id };
    markArrival(ref);
    setState({ selection: ref, rightTab: 'inspect' });
    claimForInsert(tile, ref);
  }
  toast(`Added ${name}${w ? ` ${whereText(w)}` : ''}.`, 'info', undoAction(r));
  return true;
}

/**
 * Take out what the slot `slot` of the placement `ref` holds, as one change (#654): `clear` deletes it, `move` puts it
 * just after the placement (see moveOutOps). Planned on the project as this window has it and refused if that has moved
 * on; a change the project refuses leaves it all where it was, with the engine's reason. The placement stays selected.
 */
export async function emptySlot(ref: ElementRef, slot: string, how: 'move' | 'clear'): Promise<void> {
  const snap = getState().snapshot;
  if (!snap) return;
  const ops = (how === 'move' ? moveOutOps : clearSlotOps)(snap.state, ref.owner, ref.nodeId, slot);
  if (!ops.length) return;
  const node = treeFor(snap.state, ref.owner)?.nodes[ref.nodeId];
  const def = node?.kind === 'instance' ? snap.state.components[node.definitionId] : undefined;
  const label = slotTitle(def, slot);
  const what = subjectWords(snap.state, ref);
  const r = await commitOps(ops, how === 'move' ? `Move ${label} content out of ${what}` : `Clear ${label} of ${what}`, undefined, snap.revision);
  if (!r?.ok || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
  toast(how === 'move' ? `Moved what “${label}” held to just after ${what}.` : `Cleared “${label}” of ${what}.`, 'info', undoAction(r));
}

/** Where Place on page puts a library image (`key` tells two placements apart), or why it can't be placed now. */
export type ImagePlacement = { at: InsertAt; where: NonNullable<Where>; page: string; key: string } | { at: null; reason: string };

/** Why no library image can be put on a page now, wherever it would go (null when one can). */
function placingRefusal(snap: ProjectSnapshot | null): string | null {
  const s = getState();
  if (!snap) return 'No project is open.';
  const held = projectBlock(snap, 'place the image', s.runStatus);
  if (held) return held.text;
  if (s.definitionMode) return 'Finish editing this component to place the image on a page.';
  if (s.mode === 'preview') return 'Switch to Edit to place the image on a page.';
  return null;
}

/**
 * Why a library image can't be dragged onto the page being edited now, in the words Place on page uses (null when it
 * can): Preview, a component edited everywhere, the AI working, a read-only project, no page on the canvas (a
 * collection's layout is not one), or the picture gone from Assets or any of its files missing. As on the Place on page
 * button, a picture whose smaller copies are missing waits for them to be made again: the page shows those copies.
 */
export function assetDropRefusal(assetId: string, snap: ProjectSnapshot | null = getState().snapshot): string | null {
  const why = placingRefusal(snap);
  if (why || !snap) return why ?? 'No project is open.';
  const s = getState();
  if (s.templateMode || !s.pageId || !Object.hasOwn(snap.state.pages, s.pageId)) return 'Open a page to place the image on it.';
  const asset = Object.hasOwn(snap.state.assets.assets, assetId) ? snap.state.assets.assets[assetId] : undefined;
  if (asset?.kind !== 'image') return 'That image is no longer in Assets.';
  const gone = snap.missingAssets?.find((m) => m.assetId === assetId);
  if (gone?.original) return 'Locate the file to place this image.';
  if (gone) return `Make the ${copiesWrong(gone)} ${gone.variants.length === 1 ? 'copy' : 'copies'} again to place this image.`;
  return null;
}

/**
 * Put a library image in one image on the page (see lib/image-drop): an empty one is filled, a chosen one replaced for
 * that use alone, with the image's suggested alt text. One change, written only on `revision`, the project the drag
 * found the image in; the element is then selected with its inspector open at the field, while the author is still
 * where it was dropped. Returns whether the image was put there.
 */
export async function dropAsset(assetId: string, target: ImageTarget, revision: number): Promise<boolean> {
  const start = getState();
  const snap = start.snapshot;
  const why = assetDropRefusal(assetId, snap);
  if (why || !snap) {
    toast(why ?? 'No project is open.', 'error');
    return false;
  }
  const field = target.field;
  if (!field) return false;
  const name = snap.state.assets.assets[assetId].name.trim() || 'the image';
  const owner = target.owner;
  const r = await commitOps(imageDropOps(owner, field, assetId), target.unfilled ? `Place ${name}` : `Replace with ${name}`, undefined, revision);
  // Refused, and said why (the project changed meanwhile, the AI started): that change's own record reports it.
  if (!r) return false;
  const now = getState();
  if (now.snapshot?.workspaceKey === r.workspaceKey && now.pageId === start.pageId && now.mode === 'edit' && !now.definitionMode && !now.templateMode && now.selection === start.selection) {
    const ref: ElementRef = { owner, instancePath: [], nodeId: field.nodeId };
    markArrival(ref);
    // Its inspector opens, at the field (in a gallery or team, the changed item's row), only if the author has not
    // moved the dock meanwhile (to the AI, say).
    const dock = now.rightTab === start.rightTab && now.dockOpen === start.dockOpen;
    const focus = dock && field.prop !== undefined ? inspectorFocusRequest({ opening: r.workspaceKey, owner, nodeId: field.nodeId, prop: field.prop, ...(field.itemId !== undefined ? { itemId: field.itemId } : {}), ...(field.field !== undefined ? { field: field.field } : {}), label: target.label }) : undefined;
    setState({ selection: ref, ...(dock ? { rightTab: 'inspect' as const, dockOpen: true } : {}), ...(focus ? { inspectorFocus: focus } : {}) });
  }
  toast(target.unfilled ? `Placed “${name}” as ${target.label}.` : `Replaced ${target.label} with “${name}”.`, 'info', undoAction(r));
  return true;
}

/**
 * Put a library image on the page being edited as a new Image element at `at`, the place between content it was
 * dropped on (#506), with the image's suggested alt text: in a Section of its own at the page's top level, as Place on
 * page puts it. Refused, and said why, as a drop on an image is (see assetDropRefusal). One change, written only on
 * `revision`, the project the drag found the place in; the new image is then selected with its inspector open, while
 * the author is still where it was dropped. Returns whether it was placed.
 */
export async function dropAssetAt(assetId: string, at: InsertAt, revision: number): Promise<boolean> {
  const start = getState();
  const snap = start.snapshot;
  const why = assetDropRefusal(assetId, snap);
  if (why || !snap) {
    toast(why ?? 'No project is open.', 'error');
    return false;
  }
  const owner = at.owner;
  // A drop goes on the page the drag was on; one that has moved on (another page opened) places nothing.
  if (owner.kind !== 'page' || owner.id !== start.pageId) return false;
  const name = snap.state.assets.assets[assetId].name.trim() || 'the image';
  const w = elementWhere(snap.state, at);
  const nodeId = newId('n');
  const r = await commitOps(imageInsertOps(at, assetId, nodeId), `Place ${name} ${placeWords(snap.state, owner)}`, undefined, revision);
  // Refused, and said why (the project changed meanwhile, the AI started): that change's own record reports it.
  if (!r) return false;
  const now = getState();
  if (r.results?.some((x) => x?.nodeId === nodeId) && now.snapshot?.workspaceKey === r.workspaceKey && now.pageId === owner.id && now.mode === 'edit' && !now.definitionMode && !now.templateMode && now.selection === start.selection) {
    const ref: ElementRef = { owner, instancePath: [], nodeId };
    markArrival(ref);
    // Its inspector opens only if the author has not moved the dock meanwhile (to the AI, say).
    setState({ selection: ref, ...(now.rightTab === start.rightTab && now.dockOpen === start.dockOpen ? { rightTab: 'inspect' as const, dockOpen: true } : {}) });
  }
  const page = snap.state.pages[owner.id]?.title ?? '';
  toast(`Placed “${name}”${w ? ` ${whereText(w)}${w.node && page ? ` on ${page}` : ''}` : ''}.`, 'info', undoAction(r));
  return true;
}

/**
 * Where Place on page puts a library image: on the page being edited, by the rule an inserted image element follows,
 * in the project as this window has it (or as `snap` has it). A picture or part inside a placed component counts as
 * that component, so the image goes beside it (after the Gallery a picture belongs to). A header or footer selection
 * is not on the page, so the page's own rule applies.
 */
export function imagePlacement(snap: ProjectSnapshot | null = getState().snapshot): ImagePlacement {
  const s = getState();
  const why = placingRefusal(snap);
  if (why || !snap) return { at: null, reason: why ?? 'No project is open.' };
  const page = s.pageId ? snap.state.pages[s.pageId] : undefined;
  if (!page) return { at: null, reason: 'Open a page to place the image on it.' };
  const sel = s.selection;
  const onPage = sel?.owner.kind === 'page' && sel.owner.id === page.id;
  const at = insertionPoint('element', onPage ? sel : null, snap);
  const where = elementWhere(snap.state, at);
  if (!at || !where || at.owner.kind !== 'page') return { at: null, reason: 'Open a page to place the image on it.' };
  // The node it goes after is named by ID: two Galleries side by side share a label, and can trade places.
  const before = nodeBefore(snap.state, at.owner, at.parentId, at.slot, at.index);
  // The words Assets shows; the container's name is the Insert panel's, and renaming it moves nothing.
  return { at, where, page: page.title, key: JSON.stringify([snap.workspaceKey, at, before, { lead: where.lead, target: where.target, node: where.node }]) };
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
      const r = await commitOps(imageInsertOps(p.at, asset.id, nodeId), `Place ${name} ${placeWords(snap.state, owner)}`, undefined, snap.revision, { replanStale: tries < 2 });
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
      if (now.snapshot?.workspaceKey === r.workspaceKey && now.pageId === owner.id && now.mode === 'edit' && !now.definitionMode && now.selection === start.selection) {
        const ref: ElementRef = { owner, instancePath: [], nodeId };
        markArrival(ref);
        setState({ selection: ref, ...(now.rightTab === start.rightTab && now.dockOpen === start.dockOpen ? { rightTab: 'inspect' as const, dockOpen: true } : {}) });
      }
      toast(`Placed “${name}” ${whereText(p.where)}${p.where.node ? ` on ${p.page}` : ''}.`, 'info', undoAction(r));
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

/**
 * Apply a text edit typed on the canvas. The page puts its old text back when the edit is refused, so a refusal of the
 * text itself (longer than its field takes, say) is said with the text offered back to copy, never only dropped (#1447).
 */
function applyTyped(operations: EditOperation[], label: string, text: string | RichText, state: ProjectState) {
  // `text` is what the author typed, before it is put in its stored form (a copyright line's `{year}`).
  const typed = typeof text === 'string' ? text : richTextToMarkdown(text, state.pages);
  return claimRefusals((e) => {
    if (e.code !== 'INVALID_ARGUMENT' || !typed.trim()) return false;
    toast(e.message, 'error', copyTextAction(typed, label));
    return true;
  }, () => applyOps(operations, label));
}

/** The most characters a field takes: a plain text property's limit, rich text's, or null when nothing limits it. */
function schemaTextLimit(schema: PropSchema | undefined, rich: boolean): number | null {
  if (schema?.type === 'string') return schema.maxLength ?? DEFAULT_TEXT_MAX;
  return schema?.type === 'richtext' || (!schema && rich) ? MAX_RICH_CHARS : null;
}

/**
 * The most characters the field a canvas text edit writes takes, as `snapshot` holds it: the property or list field
 * a placement's text shows, or the element's own text. Null when nothing limits it (an element's own plain text).
 */
export function canvasTextLimit(snapshot: ProjectSnapshot, edit: { ref: ElementRef; code?: CodeTextTarget }): number | null {
  const state = snapshot.state;
  if (edit.code) {
    const t = edit.code;
    const placement = treeFor(state, t.owner)?.nodes[t.nodeId];
    const def = placement?.kind === 'instance' && Object.hasOwn(state.components, placement.definitionId) ? state.components[placement.definitionId] : undefined;
    const prop = def && Object.hasOwn(def.properties, t.prop) ? def.properties[t.prop] : undefined;
    const schema = t.field === undefined ? prop : prop?.type === 'list' && Object.hasOwn(prop.fields, t.field) ? prop.fields[t.field] : undefined;
    return schema ? schemaTextLimit(schema, t.rich) : t.rich ? MAX_RICH_CHARS : null;
  }
  const ref = edit.ref;
  const r = resolveRef(state, ref);
  const node = r.node as GraphNode | undefined;
  const target = inlineField(node);
  if (!target) return null;
  const rich = node?.kind === 'text' && !!node.rich;
  if (!isBinding(target.value)) return schemaTextLimit(undefined, rich);
  // A placement's text shows its property; a component's own design, edited everywhere, its property's default.
  const def = ref.instancePath.length ? r.def : ref.owner.kind === 'component' && Object.hasOwn(state.components, ref.owner.id) ? state.components[ref.owner.id] : undefined;
  if (!def) return null;
  const binding = target.value;
  if ('$prop' in binding) return schemaTextLimit(propBindingSchema(def.properties, binding), rich);
  if (!('$item' in binding)) return null;
  const listProp = listPropFor(def, ref.nodeId);
  const list = listProp && Object.hasOwn(def.properties, listProp) ? def.properties[listProp] : undefined;
  return list?.type === 'list' && Object.hasOwn(list.fields, binding.$item) ? schemaTextLimit(list.fields[binding.$item], rich) : null;
}

/**
 * What the canvas says of text its page could not send (see the bridge's commitEdit): longer than the field takes
 * (`limit`, when the field has one), too long to send at all, or formatted too intricately to copy (`structure`).
 */
export function canvasTooLargeReport(cancel: { length?: unknown; structure?: unknown }, limit: number | null): string {
  if (cancel.structure === true) return 'That text has too much formatting to keep, so it was not kept. Paste it in smaller parts, or with Paste and Match Style.';
  const length = typeof cancel.length === 'number' && Number.isInteger(cancel.length) && cancel.length > 0 ? cancel.length : null;
  if (length !== null && limit !== null && length > limit) return `That text was not kept: ${tooLongMessage(length, limit)}`;
  return `That text is too long to send from the page${length !== null ? ` (${length} characters)` : ''}, so it was not kept.`;
}

/** Whether a text shows a placement's copyright line, which the page shows with its `{year}` as the year. */
const showsCopyright = (value: unknown): boolean => isBinding(value) && '$prop' in value && value.$prop === COPYRIGHT_PROP && value.field === undefined;

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
  return typeof v === 'string' ? words(showsCopyright(target.value) ? shownCopyright(v) : v) === words(shown) : !v && !words(shown);
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
  if (!target) return 'restore';
  // Offered back as typed if the field refuses it.
  const typed = text;
  // A repeated item without the field shows the field's default, which is what the edit started from.
  const current = shownOrDefault(snapshot.state, ref, target.value);
  text = storedEdit(r.node as GraphNode | undefined, current, text);
  // A copyright line showing the current year keeps its `{year}` where the edit left the year it showed.
  if (showsCopyright(target.value)) text = keptCopyrightYear(current, text);
  // Nothing to store (an empty line added at the end, say): the page shows the text as stored again.
  if (sameValue(current, text)) return 'restore';
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
  // The element as the page shows it ("Edit Heading on About"), in a component's design when edited everywhere.
  const label = editLabel(snapshot.state, 'Edit', ref);
  if (!ref.instancePath.length) return (await applyTyped([{ type: 'node.setContent', owner: ref.owner, nodeId: ref.nodeId, field: target.field, value: text }], label, typed, snapshot.state)) ? undefined : 'restore';
  if (ref.instancePath.length > 1) {
    toast('Edit nested component text from the inspector.', 'error');
    return 'restore';
  }
  const instId = ref.instancePath[0];
  const binding = target.value;
  if (!isBinding(binding) || '$entry' in binding) {
    toast('This text is part of the component design. Use Edit everywhere or Make unique to change it.', 'error');
    return 'restore';
  }
  if ('$prop' in binding) {
    // Text bound to one field of an object property changes that field alone.
    if (!(await applyTyped([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: binding.$prop, ...(binding.field !== undefined ? { field: binding.field } : {}), value: text }], label, typed, snapshot.state))) return 'restore';
  } else {
    // The list the repeated item belongs to: the one the enclosing repeat shows (matching field names alone
    // cannot tell a footer's links from its contact links).
    const listProp = listPropFor(r.def!, ref.nodeId);
    const itemId = ref.itemPath?.[ref.itemPath.length - 1];
    if (!listProp || !itemId) return 'restore';
    if (!(await applyTyped([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: listProp, itemId, field: binding.$item, value: text }], label, typed, snapshot.state))) return 'restore';
  }
}

/**
 * A code placement's marked text as `snapshot` holds it (see codeTextTarget): the same property, list and item, still
 * text the page can be typed into. Null once it is not.
 */
function codeTextIn(snapshot: ProjectSnapshot, t: CodeTextTarget): CodeTextTarget | null {
  const now = codeTextTarget(snapshot.state, codeTextDesc(t));
  return now && now.rich === t.rich ? now : null;
}

/** Whether a code placement's list is connected to a collection in the project as it is now. */
function connectedNow(t: CodeTextTarget): boolean {
  const node = getState().snapshot ? treeFor(getState().snapshot!.state, t.owner)?.nodes[t.nodeId] : undefined;
  return node?.kind === 'instance' && Object.hasOwn(node.listSources ?? {}, t.prop);
}

/** Whether the plain text a code placement's marked element showed (`shown`) is what its property holds in `snapshot`. */
export function showsCodeText(snapshot: ProjectSnapshot, t: CodeTextTarget, shown: string): boolean {
  if (!codeTextIn(snapshot, t)) return false;
  const v = codeTextShown(snapshot.state, t);
  const words = (x: string) => x.replace(/\s+/g, ' ').trim();
  return typeof v === 'string' ? words(v) === words(shown) : !v && !words(shown);
}

/**
 * Commit text typed over a code placement's marked element to the property or list item field it shows, as that is
 * in `snapshot` (see commitText): the inspector's own operation, one change. 'restore' asks the page to put back the
 * text it showed.
 */
export async function commitCodeText(t: CodeTextTarget, text: string | RichText, snapshot = getState().snapshot): Promise<'restore' | void> {
  if (!snapshot) return;
  if (!codeTextIn(snapshot, t)) return 'restore';
  // A list connected to a collection since the edit began keeps its stored items, which the engine would still
  // write, but shows the collection's entries: the words typed would change items no one sees.
  if (t.field !== undefined && connectedNow(t)) {
    toast('This list now shows entries from a collection, so its words are changed in the collection.', 'info');
    return 'restore';
  }
  const current = codeTextShown(snapshot.state, t);
  if (sameValue(current, text)) return 'restore';
  if (typeof text === 'string' && !text.trim() && codeTextFollowsPage(snapshot.state, t)) {
    toast('This card shows its page’s text while it has none of its own. Type different text to show it here instead.', 'info');
    return 'restore';
  }
  // Named as the inspector names the same change: a list item's field by its item and list.
  const placement = { owner: t.owner, instancePath: [], nodeId: t.nodeId };
  const label = t.field === undefined ? fieldLabel(snapshot.state, t.label, placement) : listEditLabel(snapshot.state, t.owner, t.nodeId, t.prop, { kind: 'field', itemId: t.itemId!, field: t.field }, fieldLabel(snapshot.state, t.label, placement));
  const op: EditOperation = t.field === undefined ? { type: 'instance.setProp', owner: t.owner, nodeId: t.nodeId, prop: t.prop, value: text } : { type: 'instance.setProp', owner: t.owner, nodeId: t.nodeId, prop: t.prop, itemId: t.itemId, field: t.field, value: text };
  if (!(await applyTyped([op], label, text, snapshot.state))) return 'restore';
}

/** Whether a code placement's marked text can be typed over on the canvas now. */
export function canInlineEditCode(t: CodeTextTarget | null | undefined): t is CodeTextTarget {
  const s = getState();
  // A live session's copy editor types on the page only into a page's own text (#1318); the rest is in the Inspector.
  return !!t && !!s.snapshot && !copyGrant(s.snapshot) && !!codeTextIn(s.snapshot, t);
}

/**
 * Text and button labels can be edited on the canvas when they are the page's own, or a placement's content. A live
 * session's copy editor edits only the words of a page's own text elements there (#1318), and none while editing is
 * paused.
 */
export function canInlineEdit(ref: ElementRef): boolean {
  const s = getState();
  if (!s.snapshot) return false;
  if (copyGrant(s.snapshot)) return !!copyEditing(s.snapshot) && copyEditableText(s.snapshot.state, ref);
  const target = inlineField(resolveRef(s.snapshot.state, ref).node);
  if (!target) return false;
  if (computedAt(s.snapshot.state, ref, target.value)) return false;
  // A component's own text (editing it everywhere) is its design; a bound field is filled in per placement.
  if (ref.owner.kind === 'component') return !ref.instancePath.length && !isBinding(target.value);
  // In a collection's layout, what shows an entry's field shows each entry's own words, never words typed here.
  if (!ref.instancePath.length) return !isBinding(target.value);
  if (ref.instancePath.length !== 1 || !isBinding(target.value)) return false;
  const inst = resolveRef(s.snapshot.state, { owner: ref.owner, instancePath: [], nodeId: ref.instancePath[0] }).node;
  const placed = '$prop' in target.value && inst?.kind === 'instance' ? inst.props[target.value.$prop] : undefined;
  return !(placed && typeof placed === 'object' && '$entry' in placed);
}

/**
 * Edit a collection's layout on the canvas, shown on one of its entries (the one given while the collection has it,
 * else its first), with its layers in view. Every entry's page shows what is edited here.
 */
export function openLayout(collectionId: string, entryId?: string) {
  const st = getState().snapshot?.state;
  if (!st || !Object.hasOwn(st.collections ?? {}, collectionId)) return;
  const samples = sampleEntries(st, collectionId);
  const entry = entryId && samples.some((e) => e.id === entryId) ? entryId : (samples[0]?.id ?? null);
  setState({ templateMode: { collectionId, entryId: entry }, definitionMode: null, selection: null, mode: 'edit', previewReturn: null, leftTab: 'layers' });
}

/**
 * Leave a collection's layout for the page that was open, from its Done or from Escape. What was selected in the
 * layout goes with it. The layout's band goes too, so focus that was in it moves to the canvas, where the page now is.
 */
export function leaveLayout() {
  if (!getState().templateMode) return;
  const inside = !!document.activeElement?.closest('[data-testid="template-strip"]');
  setState({ templateMode: null, selection: null });
  if (inside) requestAnimationFrame(() => document.querySelector<HTMLElement>('main.canvas')?.focus());
}

/**
 * Edit a collection's index layout (its archive pages') on the canvas, shown on its index, starting one first when the
 * collection still shows the ready-made cards.
 */
export async function openArchiveLayout(collectionId: string) {
  const st = getState().snapshot?.state;
  if (!st || !Object.hasOwn(st.collections ?? {}, collectionId)) return;
  if (!st.collections[collectionId].settings.archiveTemplate && !(await applyOps([{ type: 'collection.update', collectionId, archiveTemplate: 'start' }], `Design the ${st.collections[collectionId].settings.name} index`))) return;
  enterArchiveLayout(collectionId);
}

/**
 * Edit a collection's index layout on the canvas, as openArchiveLayout does, only while it has one and its index is
 * shown: a destination (a form, a link to a draft) leads to what is there and never starts a layout. False otherwise.
 */
export function showArchiveLayout(collectionId: string): boolean {
  const st = getState().snapshot?.state;
  // Shown on the collection's index: one whose archive pages are turned off has nowhere to show it (template-view.ts).
  const settings = st && Object.hasOwn(st.collections ?? {}, collectionId) ? st.collections[collectionId].settings : undefined;
  if (!settings?.archiveTemplate || !hasArchivePages(settings)) return false;
  enterArchiveLayout(collectionId);
  return true;
}

function enterArchiveLayout(collectionId: string) {
  setState({ templateMode: { collectionId, entryId: null, archive: true }, definitionMode: null, selection: null, mode: 'edit', previewReturn: null, leftTab: 'layers' });
}

/**
 * Whether showing `pageId` takes opening it: another page is open, a component is edited everywhere, or the Posts
 * workspace or the SEO view is in front of the page (#578, #700). A jump to something on the page (a match, a broken
 * link) opens it first.
 */
export function pageOutOfSight(s: Pick<State, 'pageId' | 'definitionMode' | 'templateMode' | 'leftTab' | 'postView' | 'mode' | 'post'>, pageId: string): boolean {
  // A collection's layout open on the canvas covers its page too (#679).
  return s.pageId !== pageId || !!s.definitionMode || !!s.templateMode || !!activeWorkspace(s);
}

/**
 * Open a page. Another page opens at the element last selected there (lib/page-place), so the author resumes where
 * they were; `target` names what to select instead, and null opens the page itself and forgets its place. Choosing the
 * page already shown selects the page itself too (not the page under a component or layout being edited, which was not
 * shown). In Preview nothing is selected.
 */
export function selectPage(pageId: string, target?: ElementRef | null) {
  // A page chosen while a post is previewed ends that preview: the canvas goes to the page (see Editor). One chosen
  // while the post writer or the SEO view covers the canvas puts it away, so the page shows and the editor names it
  // (#578, #700); the page was not on screen, so it opens at its place as another page does.
  const before = getState();
  const covered = canvasCovered(activeWorkspace(before));
  const away = before.leftTab === 'posts' || before.leftTab === 'seo' ? { leftTab: 'pages' as const } : {};
  if (before.postView === 'preview') setState({ postView: 'write', ...away });
  else if (covered) setState({ leftTab: 'pages' });
  const s = getState();
  const st = s.snapshot?.state;
  const itself = target === null || (target === undefined && !covered && pageId === s.pageId && !s.definitionMode && !s.templateMode && s.mode === 'edit');
  const selection = target !== undefined ? target : s.mode === 'edit' && !itself && st ? placeOn(st, s.pagePlaces, pageId) : null;
  // A page opened while previewing is where Edit opens: what was selected before Preview is not selected again.
  setState({ pageId, selection, definitionMode: null, templateMode: null, previewReturn: null, ...(itself ? { pagePlaces: forgetPlace(s.pagePlaces, pageId) } : {}) });
  saveLocal({ pageId });
}
setPageOpener((pageId) => selectPage(pageId));

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
  if (pageOutOfSight(s, pageId)) selectPage(pageId);
  return true;
}

export function askAiAbout(ref: ElementRef | null) {
  // Edit with AI on a specific element is an edit scoped to it, whatever mode the chat was in; opening the chat
  // generically keeps the mode and scope the user chose.
  // Only a specific element is selected for it: the chat opened generically leaves the selection (and the layers
  // selected with it) as they are.
  setState({ rightTab: 'chat', dockOpen: true, ...(ref ? { selection: ref, chatMode: 'edit', chatContextEnabled: { page: true, scope: 'selection' } } : {}) });
  if (ref) saveLocal({ chatMode: 'edit' });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50);
}

/**
 * Inspect, from an element's menu: the right panel opens on the Inspector with that element alone selected, and focus
 * follows into it. An element that has gone since the menu opened is left alone.
 */
export function inspectElement(ref: ElementRef) {
  const st = getState().snapshot?.state;
  // The element is what has to be there, not the item it was picked in: a list that leaves out the entry a layout is
  // shown on holds items that can't be told from here.
  if (!st || !refExists(st, { ...ref, itemPath: undefined })) return;
  // A post's preview keeps the Inspector on the post: Edit comes back, as only then does it show an element.
  if (activeWorkspace(getState()) === 'preview') setMode('edit');
  // The menu names one element: layers selected with it are let go.
  setState({ selection: ref, rightTab: 'inspect', dockOpen: true });
  // An element with no sections (an empty slot) is waited on: focus is not taken once the author has moved on.
  focusInspector(undefined, () => {
    const s = getState();
    return s.dockOpen && s.rightTab === 'inspect' && sameRef(s.selection, ref);
  });
}

/**
 * Open the AI chat to write the page on screen: the request is about the whole page (nothing selected), an edit, and
 * the message box takes focus, ready for pasted copy or a description of the page (see Chat's `chatFocus`).
 */
export function writePageWithAi(pageId: string) {
  const s = getState();
  if (!s.snapshot || s.pageId !== pageId) return;
  setState({ selection: null, rightTab: 'chat', dockOpen: true, chatMode: 'edit', chatContextEnabled: { page: true, scope: 'page' }, chatFocus: { workspaceKey: s.snapshot.workspaceKey, pageId, at: Date.now() } });
  saveLocal({ chatMode: 'edit' });
}

/** A Fix with AI already opening its conversation: a second click waits for it rather than opening another. */
let seoOpening = false;

/**
 * Open the AI chat with an SEO request in the message box (#599: Fix with AI in Project health and the export dialog,
 * Optimize with AI in Search & sharing; see lib/seoHandoff), closing the dialog it came from. An edit of one page opens
 * that page, as Write with AI does; an edit of the whole site leaves the page on screen, out of a component edited
 * everywhere or a layout; a question leaves everything where it is. Nothing is sent: the author reads the request,
 * changes it if they like, and sends it. A message already being written is never replaced: the request goes to a new
 * conversation, and the message stays with its own (offered under Not sent yet). True once the chat shows the request.
 */
export async function openSeoChat(h: SeoHandoff): Promise<boolean> {
  const s = getState();
  const snap = s.snapshot;
  if (!snap || seoOpening) return false;
  // While the AI works (or waits on an answer) the chat is busy with that request; this one would sit unseen behind it.
  // The run's status says so: its ID stays on the last run once that has ended.
  if (s.runStatus) return (toast(aiRunning(s.runStatus, 'try again'), 'info'), false);
  if (!s.conversation) return (toast('The AI conversation is still loading. Try again in a moment.', 'info'), false);
  const pageGone = (st: ProjectState) => h.mode === 'edit' && h.scope === 'page' && !Object.hasOwn(st.pages, h.pageId);
  if (pageGone(snap.state)) return (toast('That page is no longer on the site.', 'info'), false);
  const opening = snap.workspaceKey;
  let conversation = s.conversation;
  if (draftFor(s.chatDrafts, conversation.id).trim() || imagesFor(s.chatImages, conversation.id).length) {
    seoOpening = true;
    try {
      conversation = await api.ai.newConversation();
    } catch (e) {
      if (getState().snapshot?.workspaceKey === opening) toast((e as Error)?.message || 'Could not start a new AI conversation.', 'error');
      return false;
    } finally {
      seoOpening = false;
    }
    // Another project opened meanwhile: the request was for the one before.
    if (getState().snapshot?.workspaceKey !== opening) return false;
    // The AI now writes to the new conversation, so the chat shows it whatever follows; the message being written stays
    // with its own (under Not sent yet).
    setState({ conversation });
    // A dialog opened meanwhile is the author's latest choice: the request doesn't close it to open the chat.
    if (getState().modal !== s.modal) return false;
  }
  const now = getState();
  const st = now.snapshot!.state;
  if (h.mode === 'edit' && h.scope === 'page') {
    // Removed while the conversation opened.
    if (pageGone(st)) return (toast('That page is no longer on the site.', 'info'), false);
    if (now.mode !== 'edit') setMode('edit');
    // The page itself, so the request is about the whole page; also out of a component edited everywhere or a layout,
    // and out of the SEO view that chose it (#701), so the request stays with that page whatever the view shows next.
    selectPage(h.pageId, null);
  } else if (h.mode === 'edit' && (now.definitionMode || now.templateMode || activeWorkspace(now))) {
    // A component edited everywhere or a layout would make the request about that design, and the Posts workspace or the
    // SEO view about the post or document it shows (#700): the page goes back on screen.
    selectPage(keepPagesValid(st, now.definitionMode?.returnPageId ?? now.pageId, null).pageId ?? st.site.homePageId, null);
  }
  const after = getState();
  const scope = h.mode === 'edit' ? { chatContextEnabled: { page: true, scope: h.scope } } : {};
  setState({
    modal: null,
    rightTab: 'chat',
    dockOpen: true,
    chatMode: h.mode,
    ...scope,
    chatDrafts: withDraft(after.chatDrafts, conversation.id, h.text),
    ...(after.pageId ? { chatFocus: { workspaceKey: opening, pageId: after.pageId, at: Date.now() } } : {})
  });
  saveLocal({ chatMode: h.mode });
  return true;
}

/**
 * Optimize with AI on a post's Search & sharing previews (#599, #701): the question about the post, from `from`, the
 * previews in the post writer or in the SEO view (on the post chosen there). The writer holding this post saves what it
 * holds first, so the question quotes it as typed, whether it is in front or out of sight under the SEO view; a writer
 * holding another post is never saved. `typed` is the text typed into the previews' own fields, laid over the project
 * as it is once that save lands. Null, so nothing opens, when the author moved on at any point while it saved (another
 * post or document, the previews put away, a dialog, another project) or the post has gone.
 */
export async function postPreviewHandoff(subject: Extract<SeoSubject, { kind: 'entry' }>, typed: TypedSeo, from: 'writer' | 'view'): Promise<SeoHandoff | null> {
  const post = { collectionId: subject.collectionId, entryId: subject.entryId };
  const here = (s: State) =>
    from === 'view' ? activeWorkspace(s) === 'seo' && sameSubject(s.seoSubject, subject) : postWorkspace(s) === 'write' && s.post?.collectionId === post.collectionId && s.post.entryId === post.entryId;
  const start = getState();
  if (!start.snapshot || !postAt(start.snapshot.state, post) || !here(start)) return null;
  const opening = start.snapshot.workspaceKey;
  // Leaving at any moment while it saves ends the request, even when the author comes back to the post before it lands:
  // another request may have been made meanwhile.
  let left = false;
  const stop = useStore.subscribe((s) => {
    if (!s.snapshot || s.snapshot.workspaceKey !== opening || s.modal || !here(s)) left = true;
  });
  try {
    // What could not be saved is said in the writer; the question still quotes what the project holds.
    await savePostIfOpen(post).catch(() => false);
  } finally {
    stop();
  }
  const now = getState();
  if (left || !now.snapshot || now.snapshot.workspaceKey !== opening || now.modal || !here(now)) return null;
  const st = now.snapshot.state;
  return previewHandoff(st, subject, withTypedSeo(st, subject, typed));
}

/**
 * The one way to switch Edit and Preview, so every entry point leaves the same selection and inspector state. Preview
 * selects nothing; back in Edit, what was selected is selected again when the visitor stayed where they were (the
 * page and the place on it the author left; Canvas lets it go when the visitor moves on). It is not scrolled to: the
 * visitor may have scrolled the page, and the page stays as they left it.
 */
export function setMode(mode: 'edit' | 'preview') {
  // Previewing is a visitor's view of the site: Component Studio, which shows a component on its own, ends first, on
  // the page it was entered from.
  const dm = getState().definitionMode;
  if (mode === 'preview' && dm?.studio) setState({ definitionMode: null, pageId: dm.returnPageId, selection: null });
  const s = getState();
  const editing = s.definitionMode?.definitionId ?? null;
  if (mode === 'preview') {
    // What is selected is what Edit returns to: also one made while previewing (in Layers, a change shown from the
    // chat), which choosing Preview again lets go of on the page, as entering it does.
    const back = s.selection && s.pageId && s.snapshot ? { pageId: s.pageId, ref: s.selection, revision: s.snapshot.revision, definitionId: editing } : s.mode === 'preview' ? s.previewReturn : null;
    endArrival();
    setState({ mode, selection: null, previewReturn: back });
    return;
  }
  if (s.mode === 'edit') return;
  const back = s.previewReturn;
  const st = s.snapshot?.state;
  // A selection (or a slot picked for Insert) made while previewing is the author's latest choice and stays. Otherwise the one Preview was entered
  // with, on the same page and in the same component edited everywhere (or none), while it is still there.
  // A layout's element comes back while that layout is still open and has it.
  const layoutBack = !!back && !!s.templateMode && back.ref.owner.kind === templateOwner(s.templateMode).kind && s.templateMode.collectionId === back.ref.owner.id;
  const ref =
    !s.selection && !s.slotTarget && back && st && back.pageId === s.pageId && back.definitionId === editing
      ? layoutBack
        ? resolveRef(st, back.ref).node && (back.ref.slot === undefined || refExists(st, back.ref))
          ? back.ref
          : null
        : selectionBack(st, back.pageId, back.ref, back.revision === s.snapshot?.revision)
      : null;
  unscrolled = ref;
  setState({ mode, previewReturn: null, ...(ref ? { selection: ref } : {}) });
  // The page Edit returns on (one a visitor's link opened, say) is the page being worked on, and reopens.
  if (s.pageId) saveLocal({ pageId: s.pageId });
}

/**
 * Open one of the project's components in Component Studio (see lib/studio): edited everywhere, shown on its own
 * rather than through a placement, so one placed nowhere, or used only inside other designs, can be designed too.
 * Finishing goes back to the page open now (or the one Edit everywhere was entered from). The component as a whole
 * is selected; a node of its own already selected while editing it on a page stays selected, without the item of that
 * placement's list it was picked in. False when there is no such component of the project's own.
 */
export function openComponentStudio(definitionId: string): boolean {
  const s = getState();
  const st = s.snapshot?.state;
  const def = st && Object.hasOwn(st.components, definitionId) ? st.components[definitionId] : undefined;
  if (!st || !def || def.owner !== 'project') return false;
  if (s.mode !== 'edit') setMode('edit');
  const now = getState();
  const same = now.definitionMode?.definitionId === definitionId;
  const returnPageId = keepPagesValid(st, now.definitionMode?.returnPageId ?? now.pageId, null).pageId;
  const kept = same && now.selection && inDefinition(now.selection, definitionId) ? { ...now.selection } : null;
  if (kept) delete kept.itemPath;
  const root = def.kind === 'managed' ? def.tree?.rootIds[0] : undefined;
  const studio: StudioView = (same && now.definitionMode?.studio) || NEW_STUDIO;
  setState({
    modal: null,
    pageId: returnPageId,
    definitionMode: { definitionId, returnPageId, studio },
    selection: kept ?? (root ? { owner: { kind: 'component', id: definitionId }, instancePath: [], nodeId: root } : null),
    rightTab: 'inspect',
    dockOpen: true,
    // The post writer or the SEO view covers the canvas the studio shows on: the component's layers show instead.
    ...(now.leftTab === 'posts' || now.leftTab === 'seo' ? { leftTab: 'layers' as const } : {})
  });
  return true;
}

/** Change what Component Studio shows (a variant option, the sample content): the author's view only, never saved. */
export function setStudioView(patch: Partial<StudioView>) {
  const dm = getState().definitionMode;
  if (!dm?.studio) return;
  setState({ definitionMode: { ...dm, studio: { ...dm.studio, ...patch } } });
}

/** A selection made without being scrolled to (see setMode and selectOnPage). */
let unscrolled: ElementRef | null = null;

/** Whether `ref` is a selection made unscrolled: asked once, by the canvas, as it scrolls to a new selection. */
export function takeUnscrolled(ref: ElementRef | null): boolean {
  const quiet = !!ref && ref === unscrolled;
  unscrolled = null;
  return quiet;
}

/**
 * Select what the author picked on the page itself, which is not scrolled to (issue #1109): they are looking at it,
 * and a scroll would move it from under the pointer between the two clicks of a double-click, then leave a heading
 * under the site's sticky header.
 */
export function selectOnPage(ref: ElementRef | null, also: Parameters<typeof setState>[0] = {}) {
  const now = getState().selection;
  // Only a change of selection is asked about: the same one again scrolls nothing.
  if (ref && (!now || refKey(ref) !== refKey(now))) unscrolled = ref;
  setState({ ...also, selection: ref });
}

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
  if (pageOutOfSight(s, target)) selectPage(target);
  setState({ modal: null, leftTab: 'layers', layersView: 'outline' });
  // The first heading's row, or the outline itself when the page has none.
  requestAnimationFrame(() => requestAnimationFrame(() => (document.querySelector<HTMLElement>('.outline-view .outline-row') ?? document.querySelector<HTMLElement>('.outline-view'))?.focus()));
}

/** Open Site styles. Site styles are site-wide, so this leaves component editing first: the plum band
 *  must never sit over site-wide controls. A change to them is watched on the page, so a workspace over the canvas
 *  (the SEO view, the post writer) gives way too (#1108). */
export function openSiteStyles() {
  // A Preview still waiting on the writer's save never began. It goes first, so the page is never seen as previewed.
  const asked = getState();
  if (activeWorkspace(asked) === 'write' && asked.mode === 'preview') setMode('edit');
  const s = getState();
  const dm = s.definitionMode;
  const uncover = canvasCovered(activeWorkspace(s)) ? { leftTab: panelShowingCanvas(s) } : {};
  setState({ ...(dm ? { definitionMode: null, pageId: dm.returnPageId, selection: null } : {}), ...uncover, rightTab: 'styles', dockOpen: true });
}

/** The sidebar panel that leaves a covering workspace: the one the SEO view replaced, else Pages. */
function panelShowingCanvas(s: State): State['leftTab'] {
  if (s.leftTab !== 'seo') return 'pages';
  const back = panelAfterSeo() as State['leftTab'];
  return canvasCovered(activeWorkspace({ ...s, leftTab: back })) ? 'pages' : back;
}

/**
 * Open the SEO view (#700), in the canvas's place with its list in the sidebar, on `subject` when one is given (another
 * panel's link straight to a document), else on the document it last chose. Closes the dialog that asked. False, with
 * the editor left as it is, while no project is open or when the project no longer has that page or post.
 */
export function openSeoView(subject?: SeoSubject | null): boolean {
  const s = getState();
  if (!s.snapshot) return false;
  if (subject && !seoDocument(s.snapshot.state, subject)) return (toast('That page or post is no longer in the project.', 'info'), false);
  setState({ modal: null, leftTab: 'seo', ...(subject ? { seoSubject: subject } : {}) });
  return true;
}

/**
 * The Search & sharing settings beside a document (the Inspector's for a page, the post writer's for a post), as Open
 * in SEO view sees them: `leave` leaves the field being typed in, so its own control saves what it holds or keeps it as
 * refused; `refused` is a field still holding text it could not save, with its name.
 */
export type SeoSettingsPlace = { leave: () => void; refused: () => { name: string; focus: () => void } | null };

/**
 * Open in SEO view from a document's own Search & sharing settings (#708). What is being typed is saved first. Text a
 * page's field could not save (too long, an address that is not one) goes with the field, and the view's field shows it
 * again (#702). A post's stays in the control it was typed in, under the view (#703): the view does not open over it,
 * and the field says why, until it is corrected or Escape lets it go.
 */
export function openSeoViewFrom(subject: SeoSubject, place: SeoSettingsPlace): boolean {
  place.leave();
  const held = subject.kind === 'entry' ? place.refused() : null;
  if (held) {
    held.focus();
    toast(`What is typed in ${held.name} is not saved yet. Correct it, or press Escape to put the saved text back, then open the SEO view.`, 'error');
    return false;
  }
  return openSeoView(subject);
}

/**
 * Open a post in the writer: the Posts panel shows, with the post chosen. `picture` (counted from 1) asks the writer
 * to bring that picture of its text into view, as Show in Assets does. False when the post open now has text that
 * could not be saved, which keeps it open.
 */
export async function openPost(collectionId: string, entryId: string, picture?: number): Promise<boolean> {
  const s = getState();
  // Never over text the open post could not save: it stays, with its note above the text.
  if (s.post?.entryId !== entryId && !(await flushOpenPost())) {
    toast('The post you are writing has text that is not saved yet. See the note above its text.', 'error');
    return false;
  }
  setState({ modal: null, leftTab: 'posts', post: { collectionId, entryId }, postView: 'write', postReveal: picture ? { entryId, picture, seq: (getState().postReveal?.seq ?? 0) + 1 } : null });
  return true;
}
