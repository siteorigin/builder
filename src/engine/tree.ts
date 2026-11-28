import type { AppearPreset, ComponentDefinition, ElementNode, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { repeatProp, STYLE_SCOPES, isAppearPreset, isBinding, slotFallback } from '@shared/types';
import { pageParents } from '@shared/page-tree';

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
  if (owner.kind === 'template') {
    const c = Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id] : undefined;
    if (!c) fail(`Collection "${owner.id}" does not exist.`);
    if (!c.settings.template || typeof c.settings.template !== 'object') fail(`The ${c.settings.name} collection has no layout to edit.`);
    return c.settings.template;
  }
  if (owner.kind === 'archive') {
    const c = Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id] : undefined;
    if (!c) fail(`Collection "${owner.id}" does not exist.`);
    if (!c.settings.archiveTemplate || typeof c.settings.archiveTemplate !== 'object') fail(`The ${c.settings.name} collection has no archive layout to edit. Start one with "collection.update" and "archiveTemplate".`);
    return c.settings.archiveTemplate;
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
  // A slot outlet's fallback content (a list damaged by hand is none; validation reports it).
  if (node.kind === 'slot') return slotFallback(node).length ? [{ ids: node.children! }] : [];
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

/**
 * Told of each walk below that scans a tree, for the performance harness (scripts/perf/README.md): set only while the
 * editor's timing marks are on, so otherwise a walk costs one look at an empty variable.
 */
let countWalk: ((walk: 'findParent' | 'subtreeIds') => void) | null = null;
export function countTreeWalks(count: typeof countWalk): void {
  countWalk = count;
}

export function findParent(tree: NodeTree, nodeId: string): ParentInfo | null {
  countWalk?.('findParent');
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
  countWalk?.('subtreeIds');
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
    if (n && n.kind === 'repeat' && n.id !== nodeId) return repeatProp(n);
    id = findParent(def.tree, id)?.parentId;
  }
  return undefined;
}

/**
 * The links a list repeats whose visible text and destination are two fields of the same item (a contact method's
 * value and link): `{ text, link }` field names. Read from the definition's own tree, so a project's copy with
 * renamed fields pairs the same way, or from a code component's markup (codeItemLinks). A destination shared by two
 * different texts belongs to neither, so it is left out.
 */
export function itemLinkPairs(def: ComponentDefinition, listProp: string): Array<{ text: string; link: string }> {
  const schema = Object.hasOwn(def.properties, listProp) ? def.properties[listProp] : undefined;
  if (schema?.type !== 'list') return [];
  const shown: Array<{ text: string; link: string }> = [];
  if (def.tree) {
    for (const n of Object.values(def.tree.nodes)) {
      if (n.kind !== 'link' || !isBinding(n.label) || !isBinding(n.link) || !('$item' in n.label) || !('$item' in n.link)) continue;
      if (enclosingRepeatProp(def, n.id) === listProp) shown.push({ text: n.label.$item, link: n.link.$item });
    }
  } else if (def.kind === 'code') shown.push(...codeItemLinks(def.source ?? '', listProp));
  const found = new Map<string, { text: string; link: string }>();
  for (const { text, link } of shown) {
    if (!Object.hasOwn(schema.fields, text) || !Object.hasOwn(schema.fields, link)) continue;
    if (schema.fields[text].type !== 'string' || schema.fields[link].type !== 'link') continue;
    found.set(`${text}\u0000${link}`, { text, link });
  }
  const pairs = [...found.values()];
  return pairs.filter((p) => pairs.filter((q) => q.link === p.link).length === 1);
}

const JS_ID = '[A-Za-z_$][\\w$]*';
/** `item.field` alone, as a link's destination or a link's only content. */
const ITEM_FIELD = new RegExp(`^\\s*(${JS_ID})\\s*\\.\\s*(${JS_ID})\\s*$`);
/** One attribute of a tag, its value quoted, in braces, or absent. */
const ATTRIBUTE = /\s*([^\s=/>"'{]+)(?:\s*=\s*("[^"]*"|'[^']*'|\{[^{}]*\}|[^\s>"'{]+))?|\s*(\{[^{}]*\})/y;

/**
 * The links a code component's markup draws for each item of a list, each showing only one field of the item:
 * `{#each items as item}…<SoLink link={item.link} …>{item.value}</SoLink>…{/each}` reads as `{ text: 'value', link:
 * 'link' }`. The item is the one the innermost open `#each` names, as Svelte scopes it: a nested list with the same
 * name hides its parent's, and an `{:else}` (shown when the list is empty) has no item of its own.
 */
function codeItemLinks(source: string, listProp: string): Array<{ text: string; link: string }> {
  const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const out: Array<{ text: string; link: string }> = [];
  // Every block is kept, so each `{/…}` closes its own; only an `#each` over a property names a list's item.
  const open: Array<{ list: string | null; item: string | null }> = [];
  const tokens = /\{#(\w+)\s*([^}]*)\}|\{:else\b[^}]*\}|\{\/\w+\s*\}|<SoLink\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^{}]*\})*)>\s*\{([^{}]*)\}\s*<\/SoLink>/g;
  for (const m of markup.matchAll(tokens)) {
    if (m[1] !== undefined) {
      const each = m[1] === 'each' ? new RegExp(`^(.*?)\\s+as\\s+(${JS_ID})\\b`, 's').exec(m[2]) : null;
      const list = each && new RegExp(`^\\s*(${JS_ID})\\s*$`).exec(each[1]);
      open.push({ list: list?.[1] ?? null, item: each?.[2] ?? null });
    } else if (m[0].startsWith('{:else')) {
      // An `{:else if}` of an `#if` keeps its block; an each's `{:else}` shows no item.
      const top = open.at(-1);
      if (top?.item) open[open.length - 1] = { list: null, item: null };
    } else if (m[0].startsWith('{/')) open.pop();
    else {
      const text = ITEM_FIELD.exec(m[4]);
      const link = linkAttribute(m[3]);
      if (!text || !link || link[1] !== text[1]) continue;
      const each = open.findLast((e) => e.item === text[1]);
      if (each?.list === listProp) out.push({ text: text[2], link: link[2] });
    }
  }
  return out;
}

/** The `item.field` a SoLink's `link={…}` attribute names, read attribute by attribute so quoted text never counts. */
function linkAttribute(attrs: string): RegExpExecArray | null {
  let found: RegExpExecArray | null = null;
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(attrs); m && m[0]; m = ATTRIBUTE.exec(attrs)) {
    if (m[1] !== 'link') continue;
    found = m[2]?.startsWith('{') ? ITEM_FIELD.exec(m[2].slice(1, -1)) : null;
  }
  return found;
}

/**
 * Whether a code component places the override classes it is given (so style changes, hiding included, show).
 * A theme's declares the controls its root takes; a project's own shows it in its script by taking `class`
 * from its props, or by using the `so_o` part classes.
 */
export function codeTakesOverrides(def: ComponentDefinition): boolean {
  return codePlacesClass(def) || (def.owner !== 'theme' && /\bso_o\b/.test(def.source ?? ''));
}

/** Whether a code component places the `class` it is given: inside a component's design, the only way styles reach it. */
export function codePlacesClass(def: ComponentDefinition): boolean {
  if (def.kind !== 'code') return true;
  if (def.owner === 'theme') return !!def.parts.root?.styleControls;
  const src = def.source ?? '';
  const script = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  return /\bclass\s*:/.test(script) || /\bprops\.class\b/.test(src);
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
  return shellMenu(state, 'header');
}

/**
 * The links of the shared header's menu (its own, or its design's defaults) and the most it holds, with whether it is
 * full: a new page's link then has no room. Null for a site whose header has no menu.
 */
export function headerMenuRoom(state: ProjectState): { links: Array<Record<string, unknown>>; max?: number; full: boolean } | null {
  const menu = headerMenu(state);
  if (!menu) return null;
  const links = (menu.node.props.links ?? menu.schema.default ?? []) as Array<Record<string, unknown>>;
  const max = menu.schema.max;
  return { links, max, full: max !== undefined && links.length >= max };
}

/** The shared header's or footer's instance whose `links` list (label + link items) is that part's menu, if there is one. */
export function shellMenu(state: ProjectState, part: 'header' | 'footer'): { node: InstanceNode; schema: Extract<ComponentDefinition['properties'][string], { type: 'list' }> } | null {
  const shell = state.site.shell[part];
  for (const id of shell.rootIds) {
    const n = shell.nodes[id];
    if (n?.kind !== 'instance') continue;
    const schema = state.components[n.definitionId]?.properties.links;
    // A computed list fills itself from the site's pages: a menu link stored in it would never show.
    if (schema?.type === 'list' && !schema.feed && schema.fields.label?.type === 'string' && schema.fields.link?.type === 'link') return { node: n, schema };
  }
  return null;
}

/**
 * Whether a menu list can group links: its items have a `sub` switch, on for a link shown under the nearest link
 * above it that is not itself under another (the Foundation header's submenus). A list without one is flat.
 */
export function menuGroups(schema: Extract<ComponentDefinition['properties'][string], { type: 'list' }> | undefined): boolean {
  return schema?.type === 'list' && schema.fields.sub?.type === 'boolean' && schema.fields.link?.type === 'link';
}

/** Whether a menu item is marked to show under the link above it. */
export const isSubItem = (item: unknown): boolean => (item as { sub?: unknown } | null)?.sub === true;

/** Whether each item of a menu shows under another, as the header renders it: a marked first item has none above it. */
export const shownUnder = (items: ReadonlyArray<unknown>): boolean[] => items.map((it, i) => i > 0 && isSubItem(it));

/**
 * Where a new link to `pageId` goes in the header menu `items`: when the page is inside another (by its address)
 * and the menu groups links, under the first top-level link to that whole page, after the links already there;
 * otherwise at the end, at the top level.
 */
export function headerMenuSlot(state: ProjectState, items: ReadonlyArray<Record<string, unknown>>, pageId: string): { index: number; sub: boolean; under?: string } {
  return headerMenuSlotUnder(state, items, pageParents(Object.values(state.pages)).get(pageId) ?? null);
}

/** Where a new link goes in the header menu `items` for a page inside `parentId` (null: at the top level). */
export function headerMenuSlotUnder(state: ProjectState, items: ReadonlyArray<Record<string, unknown>>, parentId: string | null): { index: number; sub: boolean; under?: string } {
  const end = { index: items.length, sub: false };
  const menu = headerMenu(state);
  if (!menu || !menuGroups(menu.schema) || !parentId) return end;
  const under = shownUnder(items);
  const at = items.findIndex((it, i) => {
    const link = it?.link as { type?: unknown; target?: unknown; anchor?: unknown } | undefined;
    return !under[i] && link?.type === 'page' && link.target === parentId && !link.anchor;
  });
  if (at < 0) return end;
  let index = at + 1;
  while (index < items.length && under[index]) index++;
  const label = items[at]?.label;
  return typeof label === 'string' && label.trim() ? { index, sub: true, under: label.trim() } : { index, sub: true };
}

export function allTrees(state: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  const out: Array<{ owner: OwnerRef; tree: NodeTree; label: string }> = [
    { owner: { kind: 'shell', id: 'header' }, tree: state.site.shell.header, label: 'Header' },
    { owner: { kind: 'shell', id: 'footer' }, tree: state.site.shell.footer, label: 'Footer' }
  ];
  for (const id of state.site.pageOrder) if (state.pages[id]) out.push({ owner: { kind: 'page', id }, tree: state.pages[id], label: state.pages[id].title });
  for (const { owner, tree, label } of templateTrees(state)) out.push({ owner, tree, label });
  for (const def of Object.values(state.components)) if (def.tree) out.push({ owner: { kind: 'component', id: def.id }, tree: def.tree, label: def.name });
  return out;
}

/** Each collection's layout template, by collection ID, named for the collection ("Posts layout"). */
export function templateTrees(state: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  const out: Array<{ owner: OwnerRef; tree: NodeTree; label: string }> = [];
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const t = state.collections[id]?.settings?.template;
    if (t && typeof t === 'object' && t.nodes && typeof t.nodes === 'object' && Array.isArray(t.rootIds)) out.push({ owner: { kind: 'template', id }, tree: t, label: `${state.collections[id].settings.name} layout` });
    // Its archive pages' layout, when it has one of its own.
    const a = state.collections[id]?.settings?.archiveTemplate;
    if (a && typeof a === 'object' && a.nodes && typeof a.nodes === 'object' && Array.isArray(a.rootIds)) out.push({ owner: { kind: 'archive', id }, tree: a, label: `${state.collections[id].settings.name} archive layout` });
  }
  return out;
}

export function instancesOf(state: ProjectState, definitionId: string): Array<{ owner: OwnerRef; node: InstanceNode; label: string }> {
  const out: Array<{ owner: OwnerRef; node: InstanceNode; label: string }> = [];
  for (const t of allTrees(state)) {
    for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance' && n.definitionId === definitionId) out.push({ owner: t.owner, node: n, label: t.label });
  }
  return out;
}

/** A placement of a component: the tree it is in, and its node there. */
export interface PlacementRef {
  owner: OwnerRef;
  nodeId: string;
}

/** Whether a value reads from somewhere else (an enclosing design's property, a list item, a collection entry), at any depth. */
function readsElsewhere(v: unknown): boolean {
  if (isBinding(v)) return true;
  if (Array.isArray(v)) return v.some(readsElsewhere);
  return !!v && typeof v === 'object' && Object.values(v).some(readsElsewhere);
}

/** A placement's own content: its property values, the lists it connects to a collection, and the page it is on. */
export interface PlacementContent {
  props: Record<string, unknown>;
  listSources?: InstanceNode['listSources'];
  /** The page it is on, which computed lists (news, an article's header) are worked out for. */
  pageId?: string;
}

/**
 * The content a placement of `definitionId` holds of its own, as it is saved: each property the definition still
 * declares, except one bound to something (an enclosing design's property, a collection entry's field), which is known
 * only where that design or entry is shown; with the lists it connects to a collection and the page it is on. Null
 * when the node (or the tree it was in) is gone, or is no longer a placement of it.
 */
export function placementContent(state: ProjectState, definitionId: string, ref: PlacementRef): PlacementContent | null {
  let tree: NodeTree;
  try {
    tree = getTree(state, ref.owner);
  } catch {
    return null;
  }
  const node = tree?.nodes && Object.hasOwn(tree.nodes, ref.nodeId) ? tree.nodes[ref.nodeId] : undefined;
  const def = Object.hasOwn(state.components, definitionId) ? state.components[definitionId] : undefined;
  if (!node || node.kind !== 'instance' || node.definitionId !== definitionId || !def) return null;
  const out: Record<string, unknown> = {};
  const props = node.props && typeof node.props === 'object' ? node.props : {};
  for (const [name, value] of Object.entries(props)) if (Object.hasOwn(def.properties, name) && value !== undefined && !readsElsewhere(value)) out[name] = value;
  const sources = node.listSources && typeof node.listSources === 'object' && !Array.isArray(node.listSources) ? node.listSources : undefined;
  return { props: out, ...(sources && Object.keys(sources).length ? { listSources: sources } : {}), ...(ref.owner.kind === 'page' ? { pageId: ref.owner.id } : {}) };
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
    case 'element':
      return elementKind(node);
  }
}

/** The kind of container an element is, by its layout at all sizes, as Layers and Insert name it. */
export function elementKind(node: ElementNode): string {
  const layout = node.styles?.base?.layout;
  if (layout === 'grid') return 'Grid';
  if (layout === 'row') return 'Row';
  if (layout === 'stack') return 'Stack';
  return node.tag === 'section' ? 'Section' : 'Container';
}

const LAYOUTS = new Set(['block', 'stack', 'row', 'grid']);

/**
 * A container laid out as one (a layout chosen at some size, as every Container, Stack, Row and Grid inserted has)
 * with nothing in it yet. The editor frames it while editing, so it can be seen and picked, and Insert then puts
 * what comes next inside it. An empty element with no layout of its own (a spacer, a decorative block) is drawn as
 * it is designed.
 */
export function isEmptyLayout(node: GraphNode | undefined): node is ElementNode {
  if (node?.kind !== 'element' || !Array.isArray(node.children) || node.children.length) return false;
  return STYLE_SCOPES.some((scope) => {
    const layout: unknown = node.styles?.[scope]?.layout;
    return typeof layout === 'string' && LAYOUTS.has(layout);
  });
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
      : [
          state.site.shell.header,
          state.site.shell.footer,
          ...(owner.kind === 'page' || owner.kind === 'template' ? [getTree(state, owner)] : [...Object.values(state.pages), ...templateTrees(state).map((t) => t.tree)])
        ];
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

/**
 * The entrance a design gives its root (`appear`), which a placement shows unless it chooses its own: the root
 * container's, or, for a root that places another design, that placement's choice or else its design's.
 */
export function designAppear(state: ProjectState, def: ComponentDefinition | undefined, depth = 0): AppearPreset | undefined {
  if (!def || def.kind !== 'managed' || !def.tree || depth > 10) return undefined;
  const root = def.tree.nodes[def.tree.rootIds[0]];
  if (root?.kind === 'element') return isAppearPreset(root.appear) ? root.appear : undefined;
  if (root?.kind !== 'instance' || root.appear === 'none') return undefined;
  return isAppearPreset(root.appear) ? root.appear : designAppear(state, state.components[root.definitionId], depth + 1);
}
