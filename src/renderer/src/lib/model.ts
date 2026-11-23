/** Read-only helpers over the project state for the editor UI. */
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { isBinding, refKey } from '@shared/types';
import { displayName } from '@engine/tree';

export interface BridgeDesc {
  ctx: string;
  node: string;
  items: string;
  tag?: string;
  text?: string;
  code?: boolean;
}

export function treeFor(state: ProjectState, owner: OwnerRef): NodeTree | undefined {
  if (owner.kind === 'page') return state.pages[owner.id];
  if (owner.kind === 'shell') return state.site.shell[owner.id as 'header' | 'footer'];
  return state.components[owner.id]?.tree;
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

/** Resolve the definition and node a reference points at. */
export function resolveRef(state: ProjectState, ref: ElementRef): { tree?: NodeTree; node?: GraphNode; def?: ComponentDefinition; instance?: InstanceNode } {
  const ownerTree = treeFor(state, ref.owner);
  if (!ownerTree) return {};
  if (!ref.instancePath.length) return { tree: ownerTree, node: ownerTree.nodes[ref.nodeId] };
  let tree: NodeTree | undefined = ownerTree;
  let inst: InstanceNode | undefined;
  let def: ComponentDefinition | undefined;
  for (const id of ref.instancePath) {
    const n: GraphNode | undefined = tree?.nodes[id];
    if (n?.kind !== 'instance') return {};
    inst = n;
    def = state.components[n.definitionId];
    tree = def?.tree;
  }
  return { tree, node: tree?.nodes[ref.nodeId], def, instance: inst };
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

/**
 * Decide what a click selects. The first click selects the outermost component;
 * clicking again inside the same component (or with a modifier) selects the part under the pointer.
 */
export function selectionFromChain(state: ProjectState, chain: BridgeDesc[], current: ElementRef | null, deep: boolean): ElementRef | null {
  const refs = chain.map((d) => refFromDesc(state, d)).filter((r): r is ElementRef => !!r);
  if (!refs.length) return null;
  const deepest = refs.map((r) => boundaryOf(state, r)).find((r) => selectable(state, r)) ?? boundaryOf(state, refs[0]);
  // Outermost component boundary under the pointer.
  let outer: ElementRef | null = null;
  for (const r of refs) {
    const b = boundaryOf(state, r);
    const n = nodeAt(state, b);
    if (!b.instancePath.length && n?.kind === 'instance') outer = b;
  }
  if (!outer || deep) return deepest;
  if (current) {
    // Already working inside this component: the click goes to the element under the pointer.
    const keys = new Set<string>();
    for (const r of refs) {
      const b = boundaryOf(state, r);
      keys.add(refKey(b));
      for (let i = 1; i <= r.instancePath.length; i++) keys.add(refKey({ owner: r.owner, instancePath: r.instancePath.slice(0, i - 1), nodeId: r.instancePath[i - 1] }));
    }
    const top: ElementRef = current.instancePath.length ? { owner: current.owner, instancePath: [], nodeId: current.instancePath[0] } : current;
    if (keys.has(refKey(current)) || keys.has(refKey(top))) return deepest;
  }
  return outer;
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
