import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';

export class EngineError extends Error {
  constructor(
    public code: 'INVALID_ARGUMENT' | 'SCOPE_MISMATCH' | 'VALIDATION_FAILED' | 'CONFLICT',
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function fail(message: string, details?: unknown): never {
  throw new EngineError('INVALID_ARGUMENT', message, details);
}

export function getTree(state: ProjectState, owner: OwnerRef): NodeTree {
  if (owner.kind === 'page') {
    const p = Object.hasOwn(state.pages, owner.id) ? state.pages[owner.id] : undefined;
    if (!p) fail(`Page "${owner.id}" does not exist.`);
    return p;
  }
  if (owner.kind === 'shell') {
    if (owner.id !== 'header' && owner.id !== 'footer') fail('Shell owner must be "header" or "footer".');
    return state.site.shell[owner.id];
  }
  const def = Object.hasOwn(state.components, owner.id) ? state.components[owner.id] : undefined;
  if (!def) fail(`Component definition "${owner.id}" does not exist.`);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is a code component; edit its source instead.`);
  return def.tree;
}

export function getNode(tree: NodeTree, nodeId: string): GraphNode {
  const n = Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
  if (!n) fail(`Node "${nodeId}" does not exist in this document.`);
  return n;
}

export function childLists(node: GraphNode): Array<{ slot?: string; ids: string[] }> {
  if (node.kind === 'element' || node.kind === 'repeat') return [{ ids: node.children }];
  if (node.kind === 'instance') return Object.entries(node.slots ?? {}).map(([slot, ids]) => ({ slot, ids }));
  return [];
}

export interface ParentInfo {
  parentId: string | null;
  slot?: string;
  list: string[];
  index: number;
}

export function findParent(tree: NodeTree, nodeId: string): ParentInfo | null {
  const ri = tree.rootIds.indexOf(nodeId);
  if (ri >= 0) return { parentId: null, list: tree.rootIds, index: ri };
  for (const n of Object.values(tree.nodes)) {
    for (const cl of childLists(n)) {
      const i = cl.ids.indexOf(nodeId);
      if (i >= 0) return { parentId: n.id, slot: cl.slot, list: cl.ids, index: i };
    }
  }
  return null;
}

export function subtreeIds(tree: NodeTree, nodeId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    const n = tree.nodes[id];
    if (!n || out.includes(id)) return;
    out.push(id);
    for (const cl of childLists(n)) cl.ids.forEach(walk);
  };
  walk(nodeId);
  return out;
}

export function isDescendant(tree: NodeTree, ancestorId: string, nodeId: string): boolean {
  return subtreeIds(tree, ancestorId).includes(nodeId);
}

/**
 * The list property a definition node repeats over: the `$prop` of the nearest repeat enclosing it (not the
 * node itself). A definition can repeat over several lists with the same item fields (a footer's links and its
 * contact links), so the enclosing repeat is the only exact answer.
 */
export function enclosingRepeatProp(def: ComponentDefinition, nodeId: string): string | undefined {
  if (!def.tree) return undefined;
  let id: string | null | undefined = nodeId;
  for (let guard = 0; id && guard < 50; guard++) {
    const n: GraphNode | undefined = def.tree.nodes[id];
    if (n && n.kind === 'repeat' && n.id !== nodeId) return n.list.$prop;
    id = findParent(def.tree, id)?.parentId;
  }
  return undefined;
}

export function allTrees(state: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  const out: Array<{ owner: OwnerRef; tree: NodeTree; label: string }> = [
    { owner: { kind: 'shell', id: 'header' }, tree: state.site.shell.header, label: 'Header' },
    { owner: { kind: 'shell', id: 'footer' }, tree: state.site.shell.footer, label: 'Footer' }
  ];
  for (const id of state.site.pageOrder) if (state.pages[id]) out.push({ owner: { kind: 'page', id }, tree: state.pages[id], label: state.pages[id].title });
  for (const def of Object.values(state.components)) if (def.tree) out.push({ owner: { kind: 'component', id: def.id }, tree: def.tree, label: def.name });
  return out;
}

export function instancesOf(state: ProjectState, definitionId: string): Array<{ owner: OwnerRef; node: InstanceNode; label: string }> {
  const out: Array<{ owner: OwnerRef; node: InstanceNode; label: string }> = [];
  for (const t of allTrees(state)) {
    for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance' && n.definitionId === definitionId) out.push({ owner: t.owner, node: n, label: t.label });
  }
  return out;
}

export function displayName(state: ProjectState, node: GraphNode, def?: ComponentDefinition): string {
  if (node.name) return node.name;
  switch (node.kind) {
    case 'instance':
      return state.components[node.definitionId]?.name ?? 'Missing component';
    case 'text':
      return node.tag.startsWith('h') ? `Heading ${node.tag.slice(1)}` : node.rich ? 'Rich text' : 'Text';
    case 'image':
      return 'Image';
    case 'link':
      return 'Button';
    case 'icon':
      return 'Icon';
    case 'divider':
      return 'Divider';
    case 'repeat':
      return 'Repeated items';
    case 'slot':
      return `Slot: ${def?.slots?.[node.slot]?.label ?? node.slot}`;
    case 'element': {
      const layout = node.styles?.base?.layout;
      if (layout === 'grid') return 'Grid';
      if (layout === 'row') return 'Row';
      if (layout === 'stack') return 'Stack';
      return node.tag === 'section' ? 'Section' : 'Container';
    }
  }
}
