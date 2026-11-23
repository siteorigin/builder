import type { EditOperation } from '@shared/ops';
import type { ElementRef, GraphNode, OwnerRef, RichText } from '@shared/types';
import { sameRichText, toRichText } from '@shared/richtext';
import { isBinding } from '@shared/types';
import { findParent } from '@engine/tree';
import { api, applyOps, getState, setState, toast } from '../store';
import { boundaryOf, listPropFor, refLabel, resolveRef, treeFor } from './model';

export type Primitive = 'container' | 'stack' | 'row' | 'grid' | 'heading' | 'paragraph' | 'image' | 'button' | 'icon' | 'divider';

export function currentOwner(): OwnerRef | null {
  const s = getState();
  if (s.definitionMode) return { kind: 'component', id: s.definitionMode.definitionId };
  return s.pageId ? { kind: 'page', id: s.pageId } : null;
}

/** Only nodes in the owner tree itself (not inside component definitions) can be moved, duplicated or removed.
 *  While a component is edited everywhere its own nodes can, except its root, which is the component itself
 *  (`withRoot` keeps it, for inserting into it). */
export function structuralTarget(ref: ElementRef | null, { withRoot = false }: { withRoot?: boolean } = {}): ElementRef | null {
  if (!ref) return null;
  const s = getState();
  const st = s.snapshot!.state;
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
  if (t.owner.kind === 'shell') return toast('The shared header and footer cannot be deleted. Hide a page’s header and footer in its page settings instead.', 'error');
  if (await applyOps([{ type: 'node.remove', owner: t.owner, nodeId: t.nodeId }], `Delete ${label}`)) {
    setState({ selection: null });
    toast(`Deleted ${label}`, 'info', { label: 'Undo', run: () => void api.project.undo() });
  }
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

/** Work out where an inserted section or element should go, relative to the selection. */
export function insertionPoint(kind: 'section' | 'element'): { owner: OwnerRef; parentId: string | null; slot?: string; index?: number } | null {
  const s = getState();
  const owner = currentOwner();
  if (!owner || !s.snapshot) return null;
  const state = s.snapshot.state;
  const tree = treeFor(state, owner);
  if (!tree) return null;
  const sel = structuralTarget(s.selection, { withRoot: true });
  if (sel && sel.owner.kind === owner.kind && sel.owner.id === owner.id) {
    const node = tree.nodes[sel.nodeId];
    // Elements go inside a selected container or section slot.
    if (kind === 'element' && node) {
      if (node.kind === 'element') return { owner, parentId: node.id };
      if (node.kind === 'instance' && state.components[node.definitionId]?.slots) return { owner, parentId: node.id, slot: Object.keys(state.components[node.definitionId].slots!)[0] };
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
    const last = [...tree.rootIds].reverse().map((id) => tree.nodes[id]).find((n) => n?.kind === 'instance' && state.components[n.definitionId]?.slots);
    if (last) return { owner, parentId: last.id, slot: Object.keys(state.components[(last as { definitionId: string }).definitionId].slots!)[0] };
  }
  return { owner, parentId: null };
}

export async function insert(spec: { componentId?: string; definitionId?: string; primitive?: Primitive }, label: string) {
  const isSection = !spec.primitive;
  const at = insertionPoint(isSection ? 'section' : 'element');
  if (!at) return;
  let ops: EditOperation[] = [{ type: 'node.insert', owner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index, ...spec }];
  // A loose element on a page with no flexible section gets wrapped in a new Section.
  if (!isSection && at.owner.kind === 'page' && !at.parentId) {
    const r = await applyOps([{ type: 'node.insert', owner: at.owner, parentId: null, index: at.index, componentId: 'layout.section' }], `Insert ${label}`);
    const sectionId = r?.[0]?.nodeId as string | undefined;
    if (!sectionId) return;
    ops = [{ type: 'node.insert', owner: at.owner, parentId: sectionId, slot: 'content', ...spec }];
  }
  const r = await applyOps(ops, `Insert ${label}`);
  const id = r?.[0]?.nodeId as string | undefined;
  if (id) setState({ selection: { owner: at.owner, instancePath: [], nodeId: id }, rightTab: 'inspect' });
}

/** The field an inline edit on the canvas writes: a text node's text, or a link's (button's) label. */
function inlineField(node: GraphNode | undefined): { field: 'text' | 'label'; value: unknown } | null {
  if (node?.kind === 'text') return { field: 'text', value: node.text };
  if (node?.kind === 'link') return { field: 'label', value: node.label };
  return null;
}

/** The value a reference's inline-editable field shows now: a bound field shows its placement's value, or the
 *  property's default when the placement has none. */
function currentValue(ref: ElementRef, bound: unknown): unknown {
  if (!isBinding(bound)) return bound;
  const r = resolveRef(getState().snapshot!.state, ref);
  const props = (r.instance?.props ?? {}) as Record<string, unknown>;
  if ('$prop' in bound) return props[bound.$prop] ?? (r.def?.properties[bound.$prop] as { default?: unknown } | undefined)?.default;
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const items = list ? props[list] : undefined;
  const item = Array.isArray(items) ? items.find((it) => (it as { id?: unknown } | null)?.id === itemId) : undefined;
  return item ? (item as Record<string, unknown>)[bound.$item] : undefined;
}

/** Whether an edit leaves the field as it was. Rich text compares as canonical blocks, plain text as a string. */
function sameValue(current: unknown, next: string | RichText): boolean {
  if (!Array.isArray(next)) return typeof current === 'string' && current === next;
  return sameRichText(toRichText(current), next);
}

/** Commit inline text from the canvas to the right document field. Text that ends up as it was makes no edit. */
export async function commitText(ref: ElementRef, text: string | RichText) {
  const s = getState();
  if (!s.snapshot) return;
  const r = resolveRef(s.snapshot.state, ref);
  const target = inlineField(r.node as GraphNode | undefined);
  if (!target) return;
  if (sameValue(currentValue(ref, target.value), text)) return;
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
  void api.project.saveLocalState({ pageId });
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
export function openSiteStyles() {
  const dm = getState().definitionMode;
  setState(dm ? { definitionMode: null, pageId: dm.returnPageId, selection: null, rightTab: 'styles', dockOpen: true } : { rightTab: 'styles', dockOpen: true });
}
