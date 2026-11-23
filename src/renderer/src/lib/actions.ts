import type { EditOperation } from '@shared/ops';
import type { ElementRef, GraphNode, OwnerRef } from '@shared/types';
import { isBinding } from '@shared/types';
import { findParent } from '@engine/tree';
import { api, applyOps, getState, setState, toast } from '../store';
import { boundaryOf, refLabel, resolveRef, treeFor } from './model';

export type Primitive = 'container' | 'stack' | 'row' | 'grid' | 'heading' | 'paragraph' | 'image' | 'button' | 'icon' | 'divider';

export function currentOwner(): OwnerRef | null {
  const s = getState();
  if (s.definitionMode) return { kind: 'component', id: s.definitionMode.definitionId };
  return s.pageId ? { kind: 'page', id: s.pageId } : null;
}

/** Only nodes in the owner tree itself (not inside component definitions) can be moved, duplicated or removed. */
export function structuralTarget(ref: ElementRef | null): ElementRef | null {
  if (!ref) return null;
  const s = getState();
  const b = boundaryOf(s.snapshot!.state, ref);
  return b.instancePath.length ? null : b;
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
  const sel = structuralTarget(s.selection);
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

/** Commit inline text from the canvas to the right document field. */
export async function commitText(ref: ElementRef, text: string | string[]) {
  const s = getState();
  if (!s.snapshot) return;
  const r = resolveRef(s.snapshot.state, ref);
  const node = r.node as GraphNode | undefined;
  if (!node || node.kind !== 'text') return;
  if (!ref.instancePath.length) {
    await applyOps([{ type: 'node.setContent', owner: ref.owner, nodeId: ref.nodeId, field: 'text', value: text }], 'Edit text');
    return;
  }
  if (ref.instancePath.length > 1) return toast('Edit nested component text from the inspector.', 'error');
  const instId = ref.instancePath[0];
  const binding = node.text;
  if (!isBinding(binding)) return toast('This text is part of the component design. Use Edit definition or Make unique to change it.', 'error');
  if ('$prop' in binding) {
    await applyOps([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: binding.$prop, value: text }], 'Edit text');
  } else {
    const def = r.def!;
    // Find which list the repeated item belongs to.
    const listProp = Object.entries(def.properties).find(([, p]) => p.type === 'list' && binding.$item in p.fields)?.[0];
    const itemId = ref.itemPath?.[ref.itemPath.length - 1];
    if (!listProp || !itemId) return;
    await applyOps([{ type: 'instance.setProp', owner: ref.owner, nodeId: instId, prop: listProp, itemId, field: binding.$item, value: text }], 'Edit text');
  }
}

export function canInlineEdit(ref: ElementRef): boolean {
  const s = getState();
  if (!s.snapshot) return false;
  const r = resolveRef(s.snapshot.state, ref);
  const n = r.node;
  if (!n || n.kind !== 'text') return false;
  if (!ref.instancePath.length) return true;
  return ref.instancePath.length === 1 && isBinding(n.text);
}

export function selectPage(pageId: string) {
  setState({ pageId, selection: null, definitionMode: null });
  void api.project.saveLocalState({ pageId });
}

export function askAiAbout(ref: ElementRef | null) {
  setState({ rightTab: 'chat', dockOpen: true, selection: ref ?? getState().selection, chatContextEnabled: { page: true, selection: true } });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50);
}

/** The one way to switch Edit and Preview, so every entry point leaves the same selection and inspector state. */
export function setMode(mode: 'edit' | 'preview') {
  setState(mode === 'preview' ? { mode, selection: null } : { mode });
}
