import type { EditOperation } from '@shared/ops';
import type { ElementRef, GraphNode, OwnerRef, ProjectState, RichText } from '@shared/types';
import { newId } from '@shared/ids';
import { sameRichText, toRichText } from '@shared/richtext';
import { isBinding } from '@shared/types';
import { childLists, findParent } from '@engine/tree';
import type { ProjectSnapshot } from '@shared/api';
import { pageShowing } from '@shared/page-shell';
import { api, applyOps, commitOps, getState, saveLocal, setState, toast, undoAction } from '../store';
import { appliesLanded, trackApply, type ApplyOutcome } from './pending';
import { showAsset } from './place';
import { boundaryOf, followsPageAt, listPropFor, ownerLabel, refLabel, resolveRef, shownValue, treeFor } from './model';

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
  setState({ selection: null });
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

export async function insert(spec: { componentId?: string; definitionId?: string; primitive?: Primitive }, label: string) {
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
 * Commit inline text from the canvas to the right document field, as that field is in `snapshot` (by default
 * the project now; the project when editing began, for an edit checked because the AI ran meanwhile). Text
 * that ends up as it was makes no edit.
 */
export async function commitText(ref: ElementRef, text: string | RichText, snapshot = getState().snapshot): Promise<'restore' | void> {
  if (!snapshot) return;
  const r = resolveRef(snapshot.state, ref);
  const target = inlineField(r.node as GraphNode | undefined);
  if (!target) return;
  if (sameValue(shownValue(snapshot.state, ref, target.value), text)) return;
  // Erasing a card's text that comes from its page leaves the card as it was (it has no text of its own to clear):
  // the page puts its text back.
  if (typeof text === 'string' && !text.trim() && followsPageAt(snapshot.state, ref, target.value)) {
    toast('This card shows its page’s text while it has none of its own. Type different text to show it here instead.', 'info');
    return 'restore';
  }
  const label = (target.field === 'label' ? 'Edit button text' : 'Edit text') + (ref.owner.kind === 'component' ? ' everywhere' : '');
  if (!ref.instancePath.length) {
    await applyOps([{ type: 'node.setContent', owner: ref.owner, nodeId: ref.nodeId, field: target.field, value: text }], label);
    return;
  }
  if (ref.instancePath.length > 1) return toast('Edit nested component text from the inspector.', 'error');
  const instId = ref.instancePath[0];
  const binding = target.value;
  if (!isBinding(binding)) return toast('This text is part of the component design. Use Edit everywhere or Make unique to change it.', 'error');
  if ('$prop' in binding) {
    await applyOps([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: binding.$prop, value: text }], label);
  } else {
    // The list the repeated item belongs to: the one the enclosing repeat shows (matching field names alone
    // cannot tell a footer's links from its contact links).
    const listProp = listPropFor(r.def!, ref.nodeId);
    const itemId = ref.itemPath?.[ref.itemPath.length - 1];
    if (!listProp || !itemId) return;
    await applyOps([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: listProp, itemId, field: binding.$item, value: text }], label);
  }
}

/** Text and button labels can be edited on the canvas when they are the page's own, or a placement's content. */
export function canInlineEdit(ref: ElementRef): boolean {
  const s = getState();
  if (!s.snapshot) return false;
  const target = inlineField(resolveRef(s.snapshot.state, ref).node);
  if (!target) return false;
  // A component's own text (editing it everywhere) is its design; a bound field is filled in per placement.
  if (ref.owner.kind === 'component') return !ref.instancePath.length && !isBinding(target.value);
  if (!ref.instancePath.length) return true;
  return ref.instancePath.length === 1 && isBinding(target.value);
}

export function selectPage(pageId: string) {
  setState({ pageId, selection: null, definitionMode: null });
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
  setState({ rightTab: 'chat', dockOpen: true, selection: ref ?? getState().selection, ...(ref ? { chatContextEnabled: { page: true, selection: true } } : {}) });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50);
}

/** The one way to switch Edit and Preview, so every entry point leaves the same selection and inspector state. */
export function setMode(mode: 'edit' | 'preview') {
  setState(mode === 'preview' ? { mode, selection: null } : { mode });
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
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('.outline-view .outline-row, .outline-view')?.focus()));
}

export function openSiteStyles() {
  const dm = getState().definitionMode;
  setState(dm ? { definitionMode: null, pageId: dm.returnPageId, selection: null, rightTab: 'styles', dockOpen: true } : { rightTab: 'styles', dockOpen: true });
}
