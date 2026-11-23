/** Read-only helpers over the project state for the editor UI. */
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { isBinding, refKey } from '@shared/types';
import { displayName, enclosingRepeatProp, findParent } from '@engine/tree';

export interface BridgeDesc {
  ctx: string;
  node: string;
  items: string;
  tag?: string;
  text?: string;
  code?: boolean;
}

export function treeFor(state: ProjectState, owner: OwnerRef): NodeTree | undefined {
  // Own keys only: ids can come from the preview, and "toString" must not find Object.prototype's.
  if (owner.kind === 'page') return Object.hasOwn(state.pages, owner.id) ? state.pages[owner.id] : undefined;
  if (owner.kind === 'shell') return owner.id === 'header' || owner.id === 'footer' ? state.site.shell[owner.id] : undefined;
  return Object.hasOwn(state.components, owner.id) ? state.components[owner.id]?.tree : undefined;
}

export function parseCtx(ctx: string): { owner: OwnerRef; path: string[] } | null {
  const [head, ...path] = ctx.split('|');
  const m = head.match(/^(page|shell|component):(.+)$/);
  if (!m) return null;
  return { owner: { kind: m[1] as OwnerRef['kind'], id: m[2] }, path };
}

export function ctxOf(ref: ElementRef): string {
  return [`${ref.owner.kind}:${ref.owner.id}`, ...ref.instancePath].join('|');
}

/** Descriptor the bridge uses to find the DOM element(s) for a reference. */
export function descOf(state: ProjectState, ref: ElementRef): BridgeDesc {
  const n = nodeAt(state, ref);
  // A managed instance boundary is rendered by its definition root.
  if (n?.kind === 'instance') {
    const def = state.components[n.definitionId];
    if (def?.kind === 'managed' && def.tree) return { ctx: [ctxOf(ref), ref.nodeId].join('|'), node: def.tree.rootIds[0], items: '' };
  }
  return { ctx: ctxOf(ref), node: ref.nodeId, items: (ref.itemPath ?? []).join(',') };
}

const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** Resolve the definition and node a reference points at. */
export function resolveRef(state: ProjectState, ref: ElementRef): { tree?: NodeTree; node?: GraphNode; def?: ComponentDefinition; instance?: InstanceNode } {
  const ownerTree = treeFor(state, ref.owner);
  if (!ownerTree) return {};
  if (!ref.instancePath.length) return { tree: ownerTree, node: own(ownerTree.nodes, ref.nodeId) };
  let tree: NodeTree | undefined = ownerTree;
  let inst: InstanceNode | undefined;
  let def: ComponentDefinition | undefined;
  for (const id of ref.instancePath) {
    const n: GraphNode | undefined = tree && own(tree.nodes, id);
    if (n?.kind !== 'instance') return {};
    inst = n;
    def = own(state.components, n.definitionId);
    tree = def?.tree;
  }
  return { tree, node: tree && own(tree.nodes, ref.nodeId), def, instance: inst };
}

export function nodeAt(state: ProjectState, ref: ElementRef): GraphNode | undefined {
  return resolveRef(state, ref).node;
}

export function partIdFor(def: ComponentDefinition | undefined, nodeId: string): string | undefined {
  if (!def) return undefined;
  return Object.entries(def.parts).find(([, p]) => p.nodeId === nodeId)?.[0];
}

function refFromDesc(state: ProjectState, d: BridgeDesc): ElementRef | null {
  const p = parseCtx(d.ctx);
  if (!p) return null;
  const ref: ElementRef = { owner: p.owner, instancePath: p.path, nodeId: d.node };
  if (d.items) ref.itemPath = d.items.split(',');
  const r = resolveRef(state, ref);
  if (r.def) ref.partId = partIdFor(r.def, d.node);
  return ref;
}

/** If the reference is the root element of an instance, return the instance boundary instead. */
export function boundaryOf(state: ProjectState, ref: ElementRef): ElementRef {
  if (!ref.instancePath.length) return ref;
  const r = resolveRef(state, ref);
  if (r.def?.tree?.rootIds[0] === ref.nodeId) return { owner: ref.owner, instancePath: ref.instancePath.slice(0, -1), nodeId: ref.instancePath[ref.instancePath.length - 1] };
  return ref;
}

/** Is this reference a useful selection target (a primitive, a declared part or bound content)? */
function selectable(state: ProjectState, ref: ElementRef): boolean {
  if (!ref.instancePath.length) return true;
  const r = resolveRef(state, ref);
  if (!r.node) return false;
  if (ref.partId) return true;
  const n = r.node;
  if (n.kind === 'text') return isBinding(n.text);
  if (n.kind === 'image') return isBinding(n.image);
  if (n.kind === 'link') return isBinding(n.label) || isBinding(n.link);
  return false;
}

/** Everything a reference sits inside: the components on its instance path and the containers and sections
 *  above it in its owner's tree, as reference keys (the reference's own key included). */
function ancestry(state: ProjectState, ref: ElementRef): Set<string> {
  const keys = new Set([refKey(ref)]);
  // Containers are keyed both for the selection's repeated item and for none, so a part inside one card and
  // the parts around the whole list are both found.
  const add = (instancePath: string[], nodeId: string) => {
    keys.add(refKey({ owner: ref.owner, instancePath, nodeId }));
    if (ref.itemPath?.length) keys.add(refKey({ owner: ref.owner, instancePath, nodeId, itemPath: ref.itemPath }));
  };
  for (let i = 0; i < ref.instancePath.length; i++) {
    const path = ref.instancePath.slice(0, i);
    add(path, ref.instancePath[i]);
    // Inside a component, the containers between its root and the next component (or the target) count too.
    const tree = i === 0 ? treeFor(state, ref.owner) : resolveRef(state, { owner: ref.owner, instancePath: path, nodeId: ref.instancePath[i] }).tree;
    if (tree) for (let p = findParent(tree, ref.instancePath[i]); p?.parentId; p = findParent(tree, p.parentId)) add(path, p.parentId);
  }
  const inner = resolveRef(state, ref).tree;
  if (inner) for (let p = findParent(inner, ref.nodeId); p?.parentId; p = findParent(inner, p.parentId)) add(ref.instancePath, p.parentId);
  return keys;
}

/**
 * Decide what a click selects. What sits under the pointer forms levels, outermost first: the section, any
 * container or component placed in its slot, then that component's editable parts. The first click selects
 * the outermost level; each further click steps in one level from the selection (Section, then the Card in
 * it, then the Card's heading). A click elsewhere inside something already selected or worked in selects the
 * level just inside it there, so moving between a component's parts stays at the parts. `deep` (a modifier,
 * a double-click) goes straight to the innermost level.
 */
export function selectionFromChain(state: ProjectState, chain: BridgeDesc[], current: ElementRef | null, deep: boolean): ElementRef | null {
  // Descriptors that name nothing in the project (stale, or not the editor's) are ignored.
  const refs = chain.map((d) => refFromDesc(state, d)).filter((r): r is ElementRef => !!r && !!resolveRef(state, r).node);
  if (!refs.length) return null;
  let levels: ElementRef[] = [];
  const seen = new Set<string>();
  // The chain is innermost first; levels are collected outermost first.
  for (const r of [...refs].reverse()) {
    const b = boundaryOf(state, r);
    const k = refKey(b);
    if (seen.has(k) || !selectable(state, b)) continue;
    seen.add(k);
    levels.push(b);
  }
  // A component's part that wraps content placed in its slot (a Section's inner container around a Card) is
  // not a step of its own: the click goes from the Section to what was placed in it.
  levels = levels.filter((l, i) => !levels.slice(i + 1).some((m) => m.owner.kind === l.owner.kind && m.owner.id === l.owner.id && m.instancePath.length < l.instancePath.length));
  if (!levels.length) return boundaryOf(state, refs[0]);
  if (deep) return levels[levels.length - 1];
  if (current) {
    const around = ancestry(state, current);
    let j = -1;
    levels.forEach((l, i) => around.has(refKey(l)) && (j = i));
    if (j >= 0) return levels[Math.min(j + 1, levels.length - 1)];
  }
  return levels[0];
}

export function refLabel(state: ProjectState, ref: ElementRef): string {
  const r = resolveRef(state, ref);
  if (r.def && ref.partId) return r.def.parts[ref.partId]?.label ?? 'Part';
  if (!r.node) return 'Element';
  return displayName(state, r.node, r.def);
}

export function ownerLabel(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'page') return state.pages[owner.id]?.title ?? 'Page';
  if (owner.kind === 'shell') return owner.id === 'header' ? 'Header' : 'Footer';
  return state.components[owner.id]?.name ?? 'Component';
}

/** Breadcrumb from owner to the selection. */
export function breadcrumb(state: ProjectState, ref: ElementRef): Array<{ label: string; ref: ElementRef | null }> {
  const out: Array<{ label: string; ref: ElementRef | null }> = [{ label: ownerLabel(state, ref.owner), ref: null }];
  for (let i = 0; i < ref.instancePath.length; i++) {
    const b: ElementRef = { owner: ref.owner, instancePath: ref.instancePath.slice(0, i), nodeId: ref.instancePath[i] };
    out.push({ label: refLabel(state, b), ref: b });
  }
  out.push({ label: refLabel(state, ref), ref });
  return out;
}

export function textPreview(v: unknown): string {
  if (Array.isArray(v)) return v.join(' ');
  if (typeof v === 'string') return v;
  return '';
}

export function pagesUsingShell(state: ProjectState): number {
  return state.site.pageOrder.filter((id) => state.pages[id]?.shell !== 'none').length;
}

export function assetUrl(devUrl: string | null, file: string): string | null {
  if (!devUrl) return null;
  return `${devUrl}/${file.replace(/^static\//, '')}`;
}

/*
 * Editing a component everywhere ("definition mode"). The selection then names the component's own nodes
 * ({ owner: component, instancePath: [], nodeId }), the same references Layers and the definition inspector
 * use and the ones edits apply to. The canvas shows them through one placement of the component on the page.
 */

/** Whether a reference is one of the edited component's own nodes. */
export function inDefinition(ref: ElementRef | null | undefined, definitionId: string): boolean {
  return !!ref && ref.owner.kind === 'component' && ref.owner.id === definitionId;
}

/** The component's own reference for a reference made through one of its placements (and that placement);
 *  null when the reference is not inside a placement of the component. */
export function toDefinitionRef(state: ProjectState, definitionId: string, ref: ElementRef): { ref: ElementRef; placement: ElementRef } | null {
  if (inDefinition(ref, definitionId)) return null;
  const isPlacement = (instancePath: string[], nodeId: string) => {
    const n = resolveRef(state, { owner: ref.owner, instancePath, nodeId }).node;
    return n?.kind === 'instance' && n.definitionId === definitionId;
  };
  const owner = { kind: 'component' as const, id: definitionId };
  const root = state.components[definitionId]?.tree?.rootIds[0];
  // The placement itself stands for the whole component.
  if (root && isPlacement(ref.instancePath, ref.nodeId)) return { ref: { owner, instancePath: [], nodeId: root }, placement: { owner: ref.owner, instancePath: ref.instancePath, nodeId: ref.nodeId } };
  for (let k = ref.instancePath.length - 1; k >= 0; k--) {
    if (!isPlacement(ref.instancePath.slice(0, k), ref.instancePath[k])) continue;
    // A component placed inside the edited one is one of its nodes too: it is picked whole.
    const nested = ref.instancePath[k + 1];
    let inner: ElementRef = nested ? { owner, instancePath: [], nodeId: nested } : { owner, instancePath: [], nodeId: ref.nodeId };
    if (!nested && ref.itemPath?.length) inner.itemPath = ref.itemPath;
    const partId = partIdFor(state.components[definitionId], inner.nodeId);
    if (partId) inner = { ...inner, partId };
    return { ref: inner, placement: { owner: ref.owner, instancePath: ref.instancePath.slice(0, k), nodeId: ref.instancePath[k] } };
  }
  return null;
}

/** What a click on the canvas picks while editing a component everywhere: the innermost of the component's
 *  own nodes under the pointer (every node of the design can be picked), or null outside the component. */
export function definitionPick(state: ProjectState, definitionId: string, chain: BridgeDesc[]): { ref: ElementRef; placement: ElementRef } | null {
  for (const d of chain) {
    const r = refFromDesc(state, d);
    const hit = r && toDefinitionRef(state, definitionId, r);
    if (hit) return hit;
  }
  return null;
}

/** The component's placements on a page (its own content, then the shared header and footer it shows). */
export function placementsOn(state: ProjectState, definitionId: string, pageId: string): ElementRef[] {
  const page = state.pages[pageId];
  if (!page) return [];
  const owners: OwnerRef[] = [{ kind: 'page', id: pageId }, ...(page.shell !== 'none' ? [{ kind: 'shell' as const, id: 'header' }, { kind: 'shell' as const, id: 'footer' }] : [])];
  const out: ElementRef[] = [];
  for (const owner of owners) {
    const tree = treeFor(state, owner);
    for (const n of Object.values(tree?.nodes ?? {})) if (n.kind === 'instance' && n.definitionId === definitionId) out.push({ owner, instancePath: [], nodeId: n.id });
  }
  return out;
}

/** The list property a repeated part's content comes from: the enclosing repeat's list, which tells apart two
 *  lists whose items have fields of the same name (a footer's Links and Contact). */
export function listPropFor(def: ComponentDefinition, nodeId: string): string | undefined {
  const prop = enclosingRepeatProp(def, nodeId);
  return prop && own(def.properties, prop)?.type === 'list' ? prop : undefined;
}

/** A component's own reference as the page shows it, through one placement. */
export function throughPlacement(ref: ElementRef, placement: ElementRef): ElementRef {
  return { ...ref, owner: placement.owner, instancePath: [...placement.instancePath, placement.nodeId, ...ref.instancePath] };
}
