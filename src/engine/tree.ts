import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';

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
  // A slot's list damaged by hand is no list of children (validation reports it).
  if (node.kind === 'instance') return Object.entries(node.slots ?? {}).flatMap(([slot, ids]) => (Array.isArray(ids) ? [{ slot, ids }] : []));
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

/**
 * Whether a component definition's tree has the one root it renders through: the generator gives `rootIds[0]` the
 * component's classes, anchor and variant rules, so it is a single element of its own (not a repeat or a slot). A
 * design from an older version may not have it yet.
 */
export function settledRoot(tree: NodeTree): boolean {
  const root = tree.rootIds.length === 1 && Object.hasOwn(tree.nodes, tree.rootIds[0]) ? tree.nodes[tree.rootIds[0]] : undefined;
  return !!root && root.kind !== 'repeat' && root.kind !== 'slot';
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

/**
 * The links a list repeats whose visible text and destination are two fields of the same item (a contact method's
 * value and link): `{ text, link }` field names. Read from the definition's own tree, so a project's copy with
 * renamed fields pairs the same way; a code component has no tree to read and pairs nothing. A destination shared
 * by two different texts belongs to neither, so it is left out.
 */
export function itemLinkPairs(def: ComponentDefinition, listProp: string): Array<{ text: string; link: string }> {
  const schema = Object.hasOwn(def.properties, listProp) ? def.properties[listProp] : undefined;
  if (!def.tree || schema?.type !== 'list') return [];
  const found = new Map<string, { text: string; link: string }>();
  for (const n of Object.values(def.tree.nodes)) {
    if (n.kind !== 'link' || !isBinding(n.label) || !isBinding(n.link) || !('$item' in n.label) || !('$item' in n.link)) continue;
    const text = n.label.$item;
    const link = n.link.$item;
    if (!Object.hasOwn(schema.fields, text) || !Object.hasOwn(schema.fields, link)) continue;
    if (schema.fields[text].type !== 'string' || schema.fields[link].type !== 'link') continue;
    if (enclosingRepeatProp(def, n.id) !== listProp) continue;
    found.set(`${text}\u0000${link}`, { text, link });
  }
  const pairs = [...found.values()];
  return pairs.filter((p) => pairs.filter((q) => q.link === p.link).length === 1);
}

/**
 * Whether a code component places the override classes it is given (so style changes, hiding included, show).
 * A theme's declares the controls its root takes; a project's own shows it in its script by taking `class`
 * from its props, or by using the `so_o` part classes.
 */
export function codeTakesOverrides(def: ComponentDefinition): boolean {
  if (def.kind !== 'code') return true;
  if (def.owner === 'theme') return !!def.parts.root?.styleControls;
  const src = def.source ?? '';
  const script = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  return /\bclass\s*:/.test(script) || /\bso_o\b/.test(src) || /\bprops\.class\b/.test(src);
}

/**
 * The CSS properties a code component's own styles mark `!important`, sorted. Placement styles are important too,
 * which beats any selector the component writes, but not its own important values: the Inspector says so.
 */
export function codeImportantProps(def: ComponentDefinition): string[] {
  if (def.kind !== 'code') return [];
  // Its style blocks and its markup's inline styles (not its scripts), without comments.
  const src = (def.source ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const blocks = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const markup = src.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
  const inline = [...markup.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2]);
  const css = [...blocks, ...inline].join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const m of css.matchAll(/([a-z-]+)\s*:[^;{}]*!\s*important/gi)) out.add(m[1].toLowerCase());
  return [...out].sort();
}

/** The shared header instance whose `links` list (label + link items) is the site's menu, if there is one. */
export function headerMenu(state: ProjectState): { node: InstanceNode; schema: Extract<ComponentDefinition['properties'][string], { type: 'list' }> } | null {
  const header = state.site.shell.header;
  for (const id of header.rootIds) {
    const n = header.nodes[id];
    if (n?.kind !== 'instance') continue;
    const schema = state.components[n.definitionId]?.properties.links;
    // A computed list fills itself from the site's pages: a menu link stored in it would never show.
    if (schema?.type === 'list' && !schema.feed && schema.fields.label?.type === 'string' && schema.fields.link?.type === 'link') return { node: n, schema };
  }
  return null;
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

/** How many times each definition is placed, counted the way `instancesOf` counts, in one pass over the project. */
export function placementCounts(state: ProjectState): Record<string, number> {
  // No prototype, so a definition ID such as "constructor" counts from zero like any other.
  const out: Record<string, number> = Object.create(null);
  for (const t of allTrees(state)) for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance') out[n.definitionId] = (out[n.definitionId] ?? 0) + 1;
  return out;
}

/** Where a definition is placed: one entry per page, shared header or footer, or component design, in site order. */
export function placesOf(state: ProjectState, definitionId: string): Array<{ owner: OwnerRef; label: string; nodeIds: string[] }> {
  const out: Array<{ owner: OwnerRef; label: string; nodeIds: string[] }> = [];
  for (const u of instancesOf(state, definitionId)) {
    const last = out.at(-1);
    if (last && last.owner.kind === u.owner.kind && last.owner.id === u.owner.id) last.nodeIds.push(u.node.id);
    else out.push({ owner: u.owner, label: u.label, nodeIds: [u.node.id] });
  }
  return out;
}

export function displayName(state: ProjectState, node: GraphNode, def?: ComponentDefinition): string {
  if (node.name) return node.name;
  switch (node.kind) {
    case 'instance':
      return state.components[node.definitionId]?.name ?? 'Missing component';
    case 'text':
      // A tag a property chooses is a heading of whichever level the placement picks.
      if (isBinding(node.tag)) return 'Heading';
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

/**
 * IDs the generated site already uses: the main landmark and the header's navigation, and the ids no element may
 * have that give the theme's print and reduced-motion rules (and the editor's hiding) an id's weight.
 */
export const RESERVED_ANCHORS = new Set(['main', 'so-site-nav', 'so-print', 'so-motion', 'so-editor']);

/**
 * Anchors that would share a document with one placed in `owner`: a page renders with the shared header and
 * footer, and those render with every page. A definition is checked on its own.
 */
export function anchorsInUse(state: ProjectState, owner: OwnerRef, exceptNodeId?: string): Set<string> {
  const trees: NodeTree[] =
    owner.kind === 'component'
      ? [getTree(state, owner)]
      : [state.site.shell.header, state.site.shell.footer, ...(owner.kind === 'page' ? [getTree(state, owner)] : Object.values(state.pages))];
  const out = new Set(RESERVED_ANCHORS);
  for (const t of trees) for (const n of Object.values(t.nodes)) if (n.anchor && !(t === getTree(state, owner) && n.id === exceptNodeId)) out.add(n.anchor);
  return out;
}

/** A managed definition places a placement's anchor on its root, unless that root is a code component. */
export function anchorCapable(state: ProjectState, def: ComponentDefinition | undefined, depth = 0): boolean {
  if (!def || def.kind !== 'managed' || !def.tree || depth > 10) return false;
  const root = def.tree.nodes[def.tree.rootIds[0]];
  return root?.kind !== 'instance' || anchorCapable(state, state.components[root.definitionId], depth + 1);
}
