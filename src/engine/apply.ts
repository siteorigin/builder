import type {
  ComponentDefinition,
  GraphNode,
  InstanceNode,
  LinkValue,
  NodeTree,
  OwnerRef,
  PageDoc,
  ProjectState,
  PropSchema,
  ResponsiveScope,
  StyleValue,
  TokenValue
} from '@shared/types';
import { SCHEMA_VERSION, isBinding } from '@shared/types';
import type { EditOperation, Op } from '@shared/ops';
import { STYLE_PROP_MAP, validateStyleValue } from '@shared/styles';
import { normalizeRoute, slugify, validateRoute } from '@shared/routes';
import { newId } from '@shared/ids';
import { getTheme, listThemes } from '@catalogue/index';
import { effectiveTokens, generateManagedComponent, CUSTOM_DIR } from '@generator/index';
import { EngineError, fail, findParent, getNode, getTree, headerMenu, instancesOf, subtreeIds, allTrees } from './tree';
import { clone, freshListIds, installComponent, makeInstance } from './install';
import { normalizeImage, normalizeItem, normalizeLink, normalizeProp } from './values';

export type OpResult = Record<string, unknown>;

/** Own-property lookup: externally supplied keys must never resolve to inherited prototype members. */
function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Apply one operation to a mutable draft. Throws EngineError on invalid input. */
export function applyOperation(state: ProjectState, op: EditOperation): OpResult {
  switch (op.type) {
    case 'page.create':
      return pageCreate(state, op);
    case 'page.update':
      return pageUpdate(state, op);
    case 'page.duplicate':
      return pageDuplicate(state, op);
    case 'page.reorder': {
      const ids = op.pageIds;
      if (ids.length !== state.site.pageOrder.length || !ids.every((id) => state.pages[id]) || new Set(ids).size !== ids.length)
        fail('page.reorder must list every existing page exactly once.');
      state.site.pageOrder = [...ids];
      return {};
    }
    case 'page.remove':
      return pageRemove(state, op);
    case 'page.setHome':
      return pageSetHome(state, op.pageId);
    case 'node.insert':
      return nodeInsert(state, op);
    case 'node.remove': {
      const tree = editableTree(state, op.owner);
      const removed = new Set(subtreeIds(tree, op.nodeId));
      removeNode(tree, op.nodeId);
      // In definition editing, parts and variant rules for removed elements go with them.
      if (op.owner.kind === 'component') {
        const def = state.components[op.owner.id];
        for (const [pid, part] of Object.entries(def.parts)) if (pid !== 'root' && removed.has(part.nodeId)) delete def.parts[pid];
        for (const v of Object.values(def.variants ?? {})) for (const nid of Object.keys(v.styles ?? {})) if (removed.has(nid)) delete v.styles![nid];
      }
      return {};
    }
    case 'node.move':
      return nodeMove(state, op);
    case 'node.duplicate':
      return nodeDuplicate(state, op);
    case 'node.copy':
      return nodeCopy(state, op);
    case 'node.rename': {
      const n = getNode(editableTree(state, op.owner), op.nodeId);
      if (op.name.trim()) n.name = op.name.trim();
      else delete n.name;
      return {};
    }
    case 'node.setStyle':
      return nodeSetStyle(state, op);
    case 'node.resetStyles':
      return nodeResetStyles(state, op);
    case 'node.setContent':
      return nodeSetContent(state, op);
    case 'instance.setProp':
      return instanceSetProp(state, op);
    case 'instance.listInsert':
      return listInsert(state, op);
    case 'instance.listRemove': {
      const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
      const list = (node.props[op.prop] as Array<{ id: string }>) ?? [];
      if (!list.some((i) => i.id === op.itemId)) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
      if (schema.min !== undefined && list.length <= schema.min) fail(`${schema.label} needs at least ${schema.min} items.`);
      node.props[op.prop] = list.filter((i) => i.id !== op.itemId);
      return {};
    }
    case 'instance.listMove': {
      const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
      const list = [...((node.props[op.prop] as Array<{ id: string }>) ?? [])];
      const from = list.findIndex((i) => i.id === op.itemId);
      if (from < 0) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
      const [it] = list.splice(from, 1);
      list.splice(Math.min(op.index, list.length), 0, it);
      node.props[op.prop] = list;
      return {};
    }
    case 'instance.setVariant': {
      const { node, def } = instanceTarget(state, op.owner, op.nodeId);
      if (!def.variants?.[op.variant]) fail(`"${def.name}" has no variant "${op.variant}". Variants: ${Object.keys(def.variants ?? {}).join(', ') || 'none'}.`);
      node.variant = op.variant;
      return {};
    }
    case 'token.set':
      return tokenSet(state, op);
    case 'site.update':
      return siteUpdate(state, op);
    case 'component.createFromNode':
      return createFromNode(state, op);
    case 'component.makeUnique':
      return makeUnique(state, op);
    case 'component.duplicate': {
      const def = own(state.components, op.definitionId) ?? fail(`Component "${op.definitionId}" does not exist.`);
      const copy = copyDefinition(state, def, op.name);
      return { definitionId: copy.id };
    }
    case 'component.rename': {
      const def = projectDef(state, op.definitionId);
      def.name = op.name;
      if (op.description !== undefined) def.description = op.description;
      return {};
    }
    case 'component.fork': {
      const id = ensureProjectOwned(state, op.definitionId);
      return { definitionId: id };
    }
    case 'component.convertToCode':
      return convertToCode(state, op);
    case 'component.createCode':
      return createCode(state, op);
    case 'component.updateSource': {
      const def = projectDef(state, op.definitionId);
      if (def.kind !== 'code') fail(`"${def.name}" is a managed component. Convert a copy to code before editing source.`);
      if (op.expectedHash && op.expectedHash !== sourceHash(def.source ?? '')) throw new EngineError('CONFLICT', 'The source changed since it was read. Read it again before patching.');
      def.source = op.source;
      return { hash: sourceHash(op.source) };
    }
    case 'theme.apply':
      return themeApply(state, op.themeId);
    case 'asset.add': {
      if (state.assets.assets[op.asset.id]) fail(`Asset "${op.asset.id}" already exists.`);
      state.assets.assets[op.asset.id] = clone(op.asset);
      return { assetId: op.asset.id };
    }
    case 'asset.update': {
      const a = own(state.assets.assets, op.assetId) ?? fail(`Asset "${op.assetId}" does not exist.`);
      if (op.name !== undefined) a.name = op.name;
      if (op.description !== undefined) a.description = op.description;
      if (op.altSuggestion !== undefined) a.altSuggestion = op.altSuggestion;
      return {};
    }
    case 'asset.remove': {
      if (!own(state.assets.assets, op.assetId)) fail(`Asset "${op.assetId}" does not exist.`);
      const uses = assetUsages(state)[op.assetId] ?? 0;
      if (uses) fail(`This image is used ${uses} time${uses === 1 ? '' : 's'}. Replace or remove those uses first.`);
      delete state.assets.assets[op.assetId];
      return {};
    }
    case 'asset.replace': {
      if (!own(state.assets.assets, op.assetId) || !own(state.assets.assets, op.withAssetId)) fail('Both assets must exist.');
      walkValues(state, (v) => {
        if (v && typeof v === 'object' && (v as { assetId?: string }).assetId === op.assetId) (v as { assetId: string }).assetId = op.withAssetId;
      });
      if (state.site.favicon === op.assetId) state.site.favicon = op.withAssetId;
      for (const pg of Object.values(state.pages)) if (pg.seo.socialImage === op.assetId) pg.seo.socialImage = op.withAssetId;
      if (state.site.socialImage === op.assetId) state.site.socialImage = op.withAssetId;
      return {};
    }
  }
  fail(`Unsupported operation "${(op as { type: string }).type}".`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sourceHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Returns the tree for an owner, forking theme-owned definitions before a shared edit. */
function editableTree(state: ProjectState, owner: OwnerRef): NodeTree {
  if (owner.kind === 'component') {
    const def = state.components[owner.id];
    if (def?.owner === 'theme') {
      throw new EngineError(
        'SCOPE_MISMATCH',
        `"${def.name}" is a theme component. Fork it first with component.fork, then edit the returned project definition.`
      );
    }
  }
  return getTree(state, owner);
}

function projectDef(state: ProjectState, id: string): ComponentDefinition {
  const def = own(state.components, id) ?? fail(`Component "${id}" does not exist.`);
  if (def.owner !== 'project') fail(`"${def.name}" belongs to the theme. Use component.fork or component.duplicate first.`);
  return def;
}

function instanceTarget(state: ProjectState, owner: OwnerRef, nodeId: string): { node: InstanceNode; def: ComponentDefinition; tree: NodeTree } {
  const tree = editableTree(state, owner);
  const node = getNode(tree, nodeId);
  if (node.kind !== 'instance') fail(`Node "${nodeId}" is not a component instance.`);
  const def = state.components[node.definitionId] ?? fail(`Missing definition "${node.definitionId}".`);
  return { node, def, tree };
}

function listTarget(state: ProjectState, owner: OwnerRef, nodeId: string, prop: string) {
  const { node, def } = instanceTarget(state, owner, nodeId);
  const schema = def.properties[prop];
  if (!schema) fail(`"${def.name}" has no property "${prop}".`);
  if (schema.type !== 'list') fail(`"${prop}" is not a list property.`);
  if (!Array.isArray(node.props[prop])) node.props[prop] = clone(schema.default);
  return { node, def, schema };
}

function walkValues(state: ProjectState, fn: (v: unknown) => void) {
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      fn(v);
      Object.values(v).forEach(walk);
    }
  };
  for (const t of allTrees(state)) walk(t.tree.nodes);
  for (const d of Object.values(state.components)) walk(d.properties);
  for (const p of Object.values(state.pages)) walk(p.seo);
}

export function assetUsages(state: ProjectState): Record<string, number> {
  const out: Record<string, number> = {};
  walkValues(state, (v) => {
    const id = (v as { assetId?: unknown }).assetId;
    if (typeof id === 'string') out[id] = (out[id] ?? 0) + 1;
  });
  for (const k of [state.site.favicon, state.site.socialImage]) if (k) out[k] = (out[k] ?? 0) + 1;
  for (const p of Object.values(state.pages)) if (p.seo.socialImage) out[p.seo.socialImage] = (out[p.seo.socialImage] ?? 0) + 1;
  return out;
}

export function pageLinkReferences(state: ProjectState, pageId: string): number {
  let count = 0;
  walkValues(state, (v) => {
    const l = v as Partial<LinkValue>;
    if (l.type === 'page' && l.target === pageId) count++;
  });
  return count;
}

function routeTaken(state: ProjectState, route: string, exceptPageId?: string): boolean {
  return Object.values(state.pages).some((p) => p.id !== exceptPageId && p.route.toLowerCase() === route.toLowerCase());
}

function uniqueRoute(state: ProjectState, base: string): string {
  let route = base;
  let i = 2;
  while (routeTaken(state, route)) route = base.replace(/\/$/, `-${i++}/`);
  return route;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function pageCreate(state: ProjectState, op: Op<'page.create'>): OpResult {
  let route: string;
  if (op.route) {
    route = normalizeRoute(op.route);
    const err = validateRoute(route);
    if (err) fail(err);
    if (route === '/') fail('The "/" route belongs to the Home page.');
    if (routeTaken(state, route)) fail(`Another page already uses ${route}.`);
  } else {
    const slug = slugify(op.title) || 'page';
    route = uniqueRoute(state, `/${slug}/`);
  }
  const id = newId('pg');
  const page: PageDoc = { schemaVersion: SCHEMA_VERSION, id, title: op.title.trim(), route, seo: {}, shell: 'default', rootIds: [], nodes: {} };
  if (op.starter === 'intro') {
    const defId = installComponent(state, 'intro.page');
    const intro = makeInstance(state.components[defId], { eyebrow: '', heading: op.title.trim(), lead: '' });
    page.nodes[intro.id] = intro;
    page.rootIds.push(intro.id);
  }
  state.pages[id] = page;
  const after = op.afterPageId ? state.site.pageOrder.indexOf(op.afterPageId) : -1;
  if (after >= 0) state.site.pageOrder.splice(after + 1, 0, id);
  else state.site.pageOrder.push(id);
  const nav = op.addToNavigation ? { addedToNavigation: addToHeaderNavigation(state, page) } : {};
  return { pageId: id, route, ...nav };
}

/**
 * Append a link to a page to the shared header's navigation list: its `links` list whose items are a label and
 * a link. Returns false (and changes nothing) when there is no such list or it is full.
 */
function addToHeaderNavigation(state: ProjectState, page: PageDoc): boolean {
  const menu = headerMenu(state);
  if (!menu) return false;
  const { node, schema } = menu;
  const list = (node.props.links ?? structuredClone(schema.default)) as Array<Record<string, unknown>>;
  if (schema.max !== undefined && list.length >= schema.max) return false;
  node.props.links = [...list, normalizeItem(schema, { label: page.navLabel || page.title, link: { type: 'page', target: page.id } }, state, schema.label)];
  return true;
}

function pageUpdate(state: ProjectState, op: Op<'page.update'>): OpResult {
  const page = own(state.pages, op.pageId) ?? fail(`Page "${op.pageId}" does not exist.`);
  if (op.title !== undefined) page.title = op.title.trim();
  if (op.route !== undefined) {
    const route = normalizeRoute(op.route);
    const err = validateRoute(route);
    if (err) fail(err);
    if (page.id === state.site.homePageId && route !== '/') fail('The Home page always uses "/". Make another page Home first.');
    if (page.id !== state.site.homePageId && route === '/') fail('Only the Home page can use "/".');
    if (routeTaken(state, route, page.id)) fail(`Another page already uses ${route}.`);
    page.route = route;
  }
  if (op.navLabel !== undefined) page.navLabel = op.navLabel || undefined;
  if (op.seoTitle !== undefined) page.seo.title = op.seoTitle || undefined;
  if (op.description !== undefined) page.seo.description = op.description || undefined;
  if (op.noindex !== undefined) page.seo.noindex = op.noindex || undefined;
  if (op.shell !== undefined) page.shell = op.shell;
  return { route: page.route };
}

/** Copy a node subtree from one tree into another, allocating new IDs. Returns the new root ID. */
function copySubtree(from: NodeTree, to: NodeTree, nodeId: string, state: ProjectState): string {
  const idMap = new Map<string, string>();
  for (const id of subtreeIds(from, nodeId)) idMap.set(id, newId('n'));
  for (const [oldId, nid] of idMap) {
    const n = clone(from.nodes[oldId]);
    n.id = nid;
    // Copies never reuse an anchor: HTML IDs must stay unique.
    if (from === to) delete n.anchor;
    if (n.kind === 'element' || n.kind === 'repeat') n.children = n.children.map((c) => idMap.get(c) ?? c);
    if (n.kind === 'instance') {
      if (n.slots) for (const k of Object.keys(n.slots)) n.slots[k] = n.slots[k].map((c) => idMap.get(c) ?? c);
      const def = state.components[n.definitionId];
      if (def) n.props = freshListIds(def.properties, n.props);
    }
    to.nodes[nid] = n;
  }
  return idMap.get(nodeId)!;
}

function pageDuplicate(state: ProjectState, op: Op<'page.duplicate'>): OpResult {
  const src = own(state.pages, op.pageId) ?? fail(`Page "${op.pageId}" does not exist.`);
  const title = op.title?.trim() || `${src.title} copy`;
  const id = newId('pg');
  const page: PageDoc = { ...clone(src), id, title, route: uniqueRoute(state, `/${slugify(title) || 'page'}/`), rootIds: [], nodes: {} };
  for (const rid of src.rootIds) page.rootIds.push(copySubtree(src, page, rid, state));
  state.pages[id] = page;
  state.site.pageOrder.splice(state.site.pageOrder.indexOf(src.id) + 1, 0, id);
  return { pageId: id, route: page.route };
}

function rewritePageLinks(state: ProjectState, fromId: string, toId: string) {
  walkValues(state, (v) => {
    const l = v as Partial<LinkValue>;
    if (l.type === 'page' && l.target === fromId) (l as LinkValue).target = toId;
  });
}

function pageRemove(state: ProjectState, op: Op<'page.remove'>): OpResult {
  const page = own(state.pages, op.pageId) ?? fail(`Page "${op.pageId}" does not exist.`);
  if (state.site.pageOrder.length <= 1) fail('A site needs at least one page.');
  const refs = pageLinkReferences(state, page.id);
  if (op.replacementPageId && !state.pages[op.replacementPageId]) fail('The replacement page does not exist.');
  if (op.replacementPageId === page.id) fail('The replacement must be a different page.');
  if (refs && !op.replacementPageId)
    throw new EngineError('VALIDATION_FAILED', `${refs} link${refs === 1 ? '' : 's'} point to "${page.title}". Choose a replacement page for them.`, { references: refs });
  if (page.id === state.site.homePageId) {
    const next = op.replacementPageId ?? state.site.pageOrder.find((id) => id !== page.id)!;
    pageSetHome(state, next);
  }
  if (op.replacementPageId) rewritePageLinks(state, page.id, op.replacementPageId);
  delete state.pages[page.id];
  state.site.pageOrder = state.site.pageOrder.filter((id) => id !== page.id);
  return {};
}

function pageSetHome(state: ProjectState, pageId: string): OpResult {
  const page = own(state.pages, pageId) ?? fail(`Page "${pageId}" does not exist.`);
  if (state.site.homePageId === pageId) return {};
  const old = state.pages[state.site.homePageId];
  page.route = '/';
  if (old) old.route = uniqueRoute(state, `/${slugify(old.title) || 'previous-home'}/`);
  state.site.homePageId = pageId;
  return {};
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function primitiveNode(kind: NonNullable<Op<'node.insert'>['primitive']>, text?: string): GraphNode[] {
  const id = newId('n');
  const space = (t: string) => ({ token: t });
  switch (kind) {
    case 'container':
      return [{ id, kind: 'element', tag: 'div', children: [], styles: { base: { layout: 'stack', gap: space('space.md'), paddingBlock: space('space.lg') } } }];
    case 'stack':
      return [{ id, kind: 'element', tag: 'div', children: [], styles: { base: { layout: 'stack', gap: space('space.md') } } }];
    case 'row':
      return [{ id, kind: 'element', tag: 'div', children: [], styles: { base: { layout: 'row', gap: space('space.md'), wrap: true, align: 'center' } } }];
    case 'grid':
      return [{ id, kind: 'element', tag: 'div', children: [], styles: { base: { layout: 'grid', columns: 1, gap: space('space.lg') }, desktop: { columns: 3 } } }];
    case 'heading':
      return [{ id, kind: 'text', tag: 'h2', text: text ?? 'New heading', styles: { base: { textStyle: space('text.h2') } } }];
    case 'paragraph':
      return [{ id, kind: 'text', tag: 'p', text: text ?? 'Write something here.', styles: { base: { textStyle: space('text.body') } } }];
    case 'image':
      return [{ id, kind: 'image', image: { assetId: null, alt: '' }, styles: { base: { radius: space('radius.md') } } }];
    case 'button':
      return [{ id, kind: 'link', link: { type: 'none', target: '' }, label: text ?? 'Button', appearance: 'primary' }];
    case 'icon':
      return [{ id, kind: 'icon', icon: 'sparkles', styles: { base: { color: space('color.brand'), fontSize: '1.5rem' } } }];
    case 'divider':
      return [{ id, kind: 'divider' }];
  }
}

function insertionList(tree: NodeTree, parentId: string | null | undefined, slot: string | undefined, state: ProjectState): string[] {
  if (!parentId) return tree.rootIds;
  const parent = getNode(tree, parentId);
  if (parent.kind === 'element') {
    if (slot) fail('Elements do not have slots.');
    return parent.children;
  }
  if (parent.kind === 'instance') {
    const def = state.components[parent.definitionId];
    const slots = Object.keys(def?.slots ?? {});
    if (!slots.length) fail(`"${def?.name ?? 'This component'}" has no slots. Insert before or after it instead.`);
    const name = slot ?? slots[0];
    if (!slots.includes(name)) fail(`Unknown slot "${name}". Slots: ${slots.join(', ')}.`);
    parent.slots ??= {};
    parent.slots[name] ??= [];
    return parent.slots[name];
  }
  fail(`Cannot insert inside a ${parent.kind} node.`);
}

function nodeInsert(state: ProjectState, op: Op<'node.insert'>): OpResult {
  const tree = editableTree(state, op.owner);
  const list = insertionList(tree, op.parentId, op.slot, state);
  let nodes: GraphNode[];
  if (op.primitive) {
    nodes = primitiveNode(op.primitive, op.text);
  } else {
    let def: ComponentDefinition;
    if (op.definitionId) def = state.components[op.definitionId] ?? fail(`Component definition "${op.definitionId}" is not installed.`);
    else if (op.componentId) {
      // Always the active theme's implementation (older theme definitions may be retained for existing uses).
      def = state.components[installComponent(state, op.componentId)];
    } else fail('node.insert needs componentId, definitionId or primitive.');
    if (def.category === 'shell') fail('Header and footer are shared across pages and cannot be inserted.');
    if (op.owner.kind === 'component' && (def.id === op.owner.id || dependsOn(state, def.id, op.owner.id))) fail('A component cannot contain itself.');
    const inst = makeInstance(def, {}, op.variant);
    if (op.props) {
      for (const [k, v] of Object.entries(op.props)) {
        const schema = def.properties[k];
        if (!schema) fail(`"${def.name}" has no property "${k}". Properties: ${Object.keys(def.properties).join(', ')}.`);
        inst.props[k] = normalizeProp(schema, v, state, `${def.name} → ${schema.label}`);
      }
    }
    if (op.variant && !def.variants?.[op.variant]) fail(`"${def.name}" has no variant "${op.variant}".`);
    nodes = [inst];
  }
  for (const n of nodes) tree.nodes[n.id] = n;
  const index = op.index === undefined ? list.length : Math.min(op.index, list.length);
  list.splice(index, 0, nodes[0].id);
  return { nodeId: nodes[0].id };
}

function dependsOn(state: ProjectState, defId: string, targetId: string, seen = new Set<string>()): boolean {
  if (seen.has(defId)) return false;
  seen.add(defId);
  const def = state.components[defId];
  // Code converted from a managed component still imports what that design used.
  const tree = def?.tree ?? (def?.provenance?.forkedFrom ? state.components[def.provenance.forkedFrom]?.tree : undefined);
  if (!tree) return false;
  for (const n of Object.values(tree.nodes)) {
    if (n.kind === 'instance' && (n.definitionId === targetId || dependsOn(state, n.definitionId, targetId, seen))) return true;
  }
  return false;
}

function removeNode(tree: NodeTree, nodeId: string) {
  const info = findParent(tree, nodeId) ?? fail(`Node "${nodeId}" is not attached.`);
  info.list.splice(info.index, 1);
  for (const id of subtreeIds(tree, nodeId)) delete tree.nodes[id];
}

function nodeMove(state: ProjectState, op: Op<'node.move'>): OpResult {
  const tree = editableTree(state, op.owner);
  getNode(tree, op.nodeId);
  if (op.parentId && subtreeIds(tree, op.nodeId).includes(op.parentId)) fail('Cannot move a node inside itself.');
  const info = findParent(tree, op.nodeId) ?? fail('Node is not attached.');
  const target = insertionList(tree, op.parentId, op.slot, state);
  info.list.splice(info.index, 1);
  target.splice(Math.min(op.index, target.length), 0, op.nodeId);
  return {};
}

function nodeDuplicate(state: ProjectState, op: Op<'node.duplicate'>): OpResult {
  const tree = editableTree(state, op.owner);
  const info = findParent(tree, op.nodeId) ?? fail('Node is not attached.');
  const nid = copySubtree(tree, tree, op.nodeId, state);
  info.list.splice(info.index + 1, 0, nid);
  return { nodeId: nid };
}

/** IDs the generated layout already uses: the main landmark and the header's navigation. */
const RESERVED_ANCHORS = new Set(['main', 'so-site-nav']);

/**
 * Anchors that would share a document with one placed in `owner`: a page renders with the shared header and
 * footer, and those render with every page. A definition is checked on its own.
 */
function anchorsInUse(state: ProjectState, owner: OwnerRef, exceptNodeId?: string): Set<string> {
  const trees: NodeTree[] =
    owner.kind === 'component'
      ? [getTree(state, owner)]
      : [state.site.shell.header, state.site.shell.footer, ...(owner.kind === 'page' ? [getTree(state, owner)] : Object.values(state.pages))];
  const out = new Set(RESERVED_ANCHORS);
  for (const t of trees) for (const n of Object.values(t.nodes)) if (n.anchor && !(t === getTree(state, owner) && n.id === exceptNodeId)) out.add(n.anchor);
  return out;
}

/** A managed definition places a placement's anchor on its root, unless that root is a code component. */
function anchorCapable(state: ProjectState, def: ComponentDefinition | undefined, depth = 0): boolean {
  if (!def || def.kind !== 'managed' || !def.tree || depth > 10) return false;
  const root = def.tree.nodes[def.tree.rootIds[0]];
  return root?.kind !== 'instance' || anchorCapable(state, state.components[root.definitionId], depth + 1);
}

/**
 * Copy page content to a position in any editable document (another page, usually). The copy gets new node
 * and list item IDs; an anchor stays only while nothing in the destination already uses it.
 */
function nodeCopy(state: ProjectState, op: Op<'node.copy'>): OpResult {
  // Only page content is self-contained: a definition's nodes carry bindings to its own properties.
  if (op.owner.kind !== 'page') fail('Only content on a page can be copied. Copy the section that holds it instead.');
  const from = getTree(state, op.owner);
  getNode(from, op.nodeId);
  if (!findParent(from, op.nodeId)) fail('Node is not attached.');
  const to = editableTree(state, op.toOwner);
  for (const id of subtreeIds(from, op.nodeId)) {
    const n = from.nodes[id];
    if (n.kind !== 'instance') continue;
    const def = state.components[n.definitionId] ?? fail(`Component definition "${n.definitionId}" is missing.`);
    if (def.category === 'shell') fail('The shared header and footer cannot be copied.');
    if (op.toOwner.kind === 'component' && (def.id === op.toOwner.id || dependsOn(state, def.id, op.toOwner.id))) fail('A component cannot contain itself.');
  }
  // A definition keeps its one designated root; a slot belongs to an instance parent.
  if (op.toOwner.kind === 'component' && !op.parentId) fail('Paste inside the component, not beside its root.');
  if (op.slot && !op.parentId) fail('A slot needs the instance that has it as parentId.');
  const list = insertionList(to, op.parentId, op.slot, state);
  const taken = anchorsInUse(state, op.toOwner);
  const nid = copySubtree(from, to, op.nodeId, state);
  for (const id of subtreeIds(to, nid)) {
    const n = to.nodes[id];
    if (n.anchor && taken.has(n.anchor)) delete n.anchor;
    else if (n.anchor) taken.add(n.anchor);
  }
  list.splice(op.index === undefined ? list.length : Math.min(op.index, list.length), 0, nid);
  return { nodeId: nid };
}

function checkTokenRef(state: ProjectState, value: StyleValue) {
  if (value && typeof value === 'object' && 'token' in value) {
    if (!effectiveTokens(state).some((t) => t.id === value.token)) fail(`Token "${value.token}" does not exist.`);
  }
}

function nodeSetStyle(state: ProjectState, op: Op<'node.setStyle'>): OpResult {
  const tree = editableTree(state, op.owner);
  const node = getNode(tree, op.nodeId);
  if (!STYLE_PROP_MAP[op.property]) fail(`Unknown style property "${op.property}". Valid: ${Object.keys(STYLE_PROP_MAP).join(', ')}.`);
  if (op.value !== null) {
    const err = validateStyleValue(op.property, op.value);
    if (err) fail(err);
    checkTokenRef(state, op.value);
  }
  const scope = op.scope as ResponsiveScope;
  let target: { styles?: Record<string, Record<string, StyleValue>> };
  if (node.kind === 'instance') {
    const def = state.components[node.definitionId] ?? fail('Missing definition.');
    const partId = op.partId ?? 'root';
    if (partId !== 'root' && !own(def.parts, partId)) fail(`"${def.name}" has no part "${partId}". Parts: ${Object.keys(def.parts).join(', ')}.`);
    // Code components take overrides on their root and on parts they declare: the generator hands them the
    // override classes (root through `class`, every part through `so_o`) to place in their markup.
    node.overrides ??= {};
    node.overrides[partId] ??= {};
    target = { styles: node.overrides[partId] as Record<string, Record<string, StyleValue>> };
    setStyle(target.styles!, scope, op.property, op.value);
    if (!Object.keys(node.overrides[partId]).length) delete node.overrides[partId];
    if (!Object.keys(node.overrides).length) delete node.overrides;
  } else {
    if (op.partId) fail('partId only applies to component instances.');
    node.styles ??= {};
    setStyle(node.styles as Record<string, Record<string, StyleValue>>, scope, op.property, op.value);
    if (!Object.keys(node.styles).length) delete node.styles;
  }
  return {};
}

function setStyle(styles: Record<string, Record<string, StyleValue>>, scope: string, prop: string, value: StyleValue | null) {
  if (value === null) {
    if (styles[scope]) {
      delete styles[scope][prop];
      if (!Object.keys(styles[scope]).length) delete styles[scope];
    }
  } else {
    styles[scope] ??= {};
    styles[scope][prop] = value;
  }
}

function nodeResetStyles(state: ProjectState, op: Op<'node.resetStyles'>): OpResult {
  const node = getNode(editableTree(state, op.owner), op.nodeId);
  if (node.kind === 'instance') {
    if (!node.overrides) return {};
    const parts = op.partId ? [op.partId] : Object.keys(node.overrides);
    for (const p of parts) {
      if (!node.overrides[p]) continue;
      if (op.scope) delete node.overrides[p][op.scope];
      else delete node.overrides[p];
      if (node.overrides[p] && !Object.keys(node.overrides[p]).length) delete node.overrides[p];
    }
    if (!Object.keys(node.overrides).length) delete node.overrides;
  } else if (node.styles) {
    if (op.scope) delete node.styles[op.scope];
    else delete node.styles;
  }
  return {};
}

function nodeSetContent(state: ProjectState, op: Op<'node.setContent'>): OpResult {
  const owner = op.owner;
  const tree = editableTree(state, owner);
  const node = getNode(tree, op.nodeId);
  const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
  const label = node.name ?? node.kind;
  // In definition mode, editing bound content edits the property default.
  const setBound = (field: unknown, schemaFix: (s: PropSchema) => unknown): boolean => {
    if (!isBinding(field)) return false;
    if (!def || !('$prop' in field)) fail('This content is bound to a repeated item; edit the list item instead.');
    const schema = def.properties[field.$prop];
    if (!schema) fail(`Missing property ${field.$prop}.`);
    (schema as { default: unknown }).default = schemaFix(schema);
    return true;
  };
  const v = op.value;
  switch (op.field) {
    case 'text': {
      if (node.kind !== 'text') fail('Only text nodes have text.');
      const val = node.rich ? (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/\n{2,}|\n/)).map((s) => s.trim()).filter(Boolean) : String(v ?? '');
      if (!setBound(node.text, () => val)) node.text = val;
      return {};
    }
    case 'image': {
      if (node.kind !== 'image') fail('Only image nodes have an image.');
      const val = normalizeImage(v, state, label);
      if (!setBound(node.image, () => val)) node.image = val;
      return {};
    }
    case 'link': {
      if (node.kind !== 'link') fail('Only buttons and links have a destination.');
      const val = normalizeLink(v, state, label);
      if (!setBound(node.link, () => val)) node.link = val;
      return {};
    }
    case 'label': {
      if (node.kind !== 'link') fail('Only buttons have a label.');
      if (!setBound(node.label, () => String(v ?? ''))) node.label = String(v ?? '');
      return {};
    }
    case 'appearance': {
      if (node.kind !== 'link') fail('Only buttons have an appearance.');
      if (!['primary', 'secondary', 'text', 'light', 'link', 'plain'].includes(String(v))) fail('Appearance must be primary, secondary, text, light, link or plain.');
      node.appearance = String(v);
      return {};
    }
    case 'icon': {
      if (node.kind !== 'icon') fail('Only icon nodes have an icon.');
      if (!setBound(node.icon, () => String(v))) node.icon = String(v);
      return {};
    }
    case 'tag': {
      if (node.kind !== 'text') fail('Only text nodes have a tag.');
      if (!['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].includes(String(v))) fail('Tag must be h1–h6 or p.');
      if (node.rich) fail('Rich text keeps its paragraph structure.');
      node.tag = String(v) as typeof node.tag;
      return {};
    }
    case 'anchor': {
      if (node.kind === 'repeat' || node.kind === 'slot') fail('Anchors can be set on sections, elements, text, images, buttons, icons and dividers.');
      // A section's anchor becomes the id of its component's root element, which only managed components place.
      if (node.kind === 'instance' && !anchorCapable(state, state.components[node.definitionId])) fail('Anchors can only be set on sections built in the editor, not on code components.');
      const a = String(v ?? '').replace(/^#/, '');
      if (a && !/^[A-Za-z][\w-]{0,60}$/.test(a)) fail('Anchors start with a letter and use letters, numbers, - and _.');
      if (a && anchorsInUse(state, owner, node.id).has(a)) fail(RESERVED_ANCHORS.has(a) ? `"${a}" is used by the site itself. Choose another anchor.` : `Another element on this page already uses the anchor "${a}".`);
      if (a) node.anchor = a;
      else delete node.anchor;
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Instance properties
// ---------------------------------------------------------------------------

function instanceSetProp(state: ProjectState, op: Op<'instance.setProp'>): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  const schema = def.properties[op.prop];
  if (!schema) fail(`"${def.name}" has no property "${op.prop}". Properties: ${Object.keys(def.properties).join(', ')}.`);
  if (op.itemId) {
    if (schema.type !== 'list') fail(`"${op.prop}" is not a list.`);
    const list = (node.props[op.prop] as Array<Record<string, unknown> & { id: string }>) ?? [];
    const idx = list.findIndex((i) => i.id === op.itemId);
    if (idx < 0) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
    if (op.field) {
      const f = schema.fields[op.field];
      if (!f) fail(`${schema.itemLabel} has no field "${op.field}". Fields: ${Object.keys(schema.fields).join(', ')}.`);
      const next = normalizeItem(schema, { ...list[idx], [op.field]: op.value }, state, `${schema.itemLabel}`, { id: list[idx].id } as never);
      list[idx] = next;
    } else {
      list[idx] = normalizeItem(schema, op.value as Record<string, unknown>, state, schema.itemLabel, list[idx] as never);
    }
    node.props[op.prop] = [...list];
    return {};
  }
  node.props[op.prop] = normalizeProp(schema, op.value, state, `${def.name} → ${schema.label}`);
  return {};
}

function listInsert(state: ProjectState, op: Op<'instance.listInsert'>): OpResult {
  const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
  const list = [...(node.props[op.prop] as Array<{ id: string }>)];
  if (schema.max !== undefined && list.length >= schema.max) fail(`${schema.label} allows at most ${schema.max} items.`);
  const template = list.length ? clone(list[list.length - 1]) : undefined;
  const item = normalizeItem(schema, op.item ?? (template as Record<string, unknown>), state, schema.itemLabel);
  item.id = newId('i');
  list.splice(op.index === undefined ? list.length : Math.min(op.index, list.length), 0, item);
  node.props[op.prop] = list;
  return { itemId: item.id };
}

// ---------------------------------------------------------------------------
// Tokens and site
// ---------------------------------------------------------------------------

function assertNoTokenCycles(state: ProjectState) {
  const theme = getTheme(state.site.themeId);
  const value = (id: string) => (Object.hasOwn(state.tokens.overrides, id) ? state.tokens.overrides[id] : [...theme.tokens, ...state.tokens.custom].find((t) => t.id === id)?.value);
  for (const t of [...theme.tokens, ...state.tokens.custom]) {
    const seen = new Set<string>();
    let cur: string | undefined = t.id;
    while (cur) {
      if (seen.has(cur)) fail('That change would make site styles refer to each other in a loop.');
      seen.add(cur);
      const v = value(cur);
      cur = v && typeof v === 'object' && 'token' in v ? (v as { token: string }).token : undefined;
    }
  }
}

function tokenSet(state: ProjectState, op: Op<'token.set'>): OpResult {
  const r = tokenSetInner(state, op);
  assertNoTokenCycles(state);
  return r;
}

function tokenSetInner(state: ProjectState, op: Op<'token.set'>): OpResult {
  const theme = getTheme(state.site.themeId);
  const tdef = [...theme.tokens, ...state.tokens.custom].find((t) => t.id === op.tokenId) ?? fail(`Token "${op.tokenId}" does not exist.`);
  if (op.value === null) {
    delete state.tokens.overrides[op.tokenId];
    return {};
  }
  const v = op.value;
  if (tdef.group === 'color') {
    if (typeof v === 'object' && v && 'token' in v) {
      const target = String((v as { token: string }).token);
      if (!target.startsWith('color.')) fail('Colors can only reference other color tokens.');
      // Detect cycles
      const seen = new Set([op.tokenId]);
      let cur: string | undefined = target;
      const lookup = (id: string) => state.tokens.overrides[id] ?? [...theme.tokens, ...state.tokens.custom].find((t) => t.id === id)?.value;
      while (cur) {
        if (seen.has(cur)) fail('That token reference would create a cycle.');
        seen.add(cur);
        const val = lookup(cur);
        if (val === undefined) fail(`Token "${cur}" does not exist.`);
        cur = val && typeof val === 'object' && 'token' in val ? (val as { token: string }).token : undefined;
      }
    } else {
      const err = validateStyleValue('color', String(v));
      if (err) fail(err);
    }
  } else if (tdef.group === 'text') {
    if (!v || typeof v !== 'object') fail('Text styles need { family, size, lineHeight, weight, tracking }.');
    const cur = (state.tokens.overrides[op.tokenId] ?? tdef.value) as Record<string, unknown>;
    const merged = { ...cur, ...(v as Record<string, unknown>) };
    for (const k of ['size', 'lineHeight', 'tracking'] as const) {
      const s = String(merged[k]);
      if (!/^[0-9a-z.,%+\-*/ ()]+$/i.test(s)) fail(`Invalid ${k} "${s}".`);
    }
    const w = Number(merged.weight);
    if (!Number.isFinite(w) || w < 100 || w > 900) fail('Weight must be between 100 and 900.');
    merged.weight = w;
    const fam = merged.family as unknown;
    if (fam && typeof fam === 'object') {
      const ref = String((fam as { token?: string }).token ?? '');
      if (!ref.startsWith('font.') || !effectiveTokens(state).some((t) => t.id === ref)) fail('A text style font must reference an existing font token.');
    } else if (!/^[\w\s'",.-]{1,200}$/.test(String(fam))) fail('Font names may contain letters, numbers, spaces, quotes, commas and hyphens only.');
    if (merged.transform !== undefined && !['none', 'uppercase', 'lowercase', 'capitalize'].includes(String(merged.transform))) fail('Text transform must be none, uppercase, lowercase or capitalize.');
    state.tokens.overrides[op.tokenId] = merged as unknown as TokenValue;
    return {};
  } else if (tdef.group === 'font') {
    const s = String(v);
    if (!/^[\w\s'",.-]+$/.test(s) || s.length > 200) fail('Font stacks may contain names, quotes, commas and hyphens only.');
  } else {
    const s = String(v);
    if (!/^[0-9a-z.,%+\-*/ ()#]+$/i.test(s) || s.length > 200) fail(`Invalid value "${s}".`);
  }
  state.tokens.overrides[op.tokenId] = v as TokenValue;
  return {};
}

function siteUpdate(state: ProjectState, op: Op<'site.update'>): OpResult {
  const s = state.site;
  if (op.name !== undefined) s.name = op.name.trim();
  if (op.language !== undefined) {
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(op.language)) fail('Language must be a code such as "en" or "en-AU".');
    s.language = op.language;
  }
  if (op.description !== undefined) s.description = op.description;
  if (op.baseUrl !== undefined) {
    const b = op.baseUrl.trim();
    if (b && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(b)) fail('The public URL must start with https://.');
    s.baseUrl = b || undefined;
  }
  if (op.favicon !== undefined) {
    if (op.favicon && !state.assets.assets[op.favicon]) fail('Favicon asset not found.');
    s.favicon = op.favicon;
  }
  if (op.socialImage !== undefined) {
    if (op.socialImage && !state.assets.assets[op.socialImage]) fail('Social image asset not found.');
    s.socialImage = op.socialImage;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function projectDefId(name: string, prefix = 'proj'): string {
  return `${prefix}.${slugify(name) || 'component'}-${newId('x', 5).slice(2)}`;
}

function copyDefinition(state: ProjectState, def: ComponentDefinition, name: string): ComponentDefinition {
  const copy = clone(def);
  copy.id = projectDefId(name);
  copy.owner = 'project';
  copy.name = name;
  copy.componentId = `project.${slugify(name) || 'component'}`;
  copy.category = def.category === 'shell' ? 'shell' : 'custom';
  copy.provenance = { ...def.provenance, forkedFrom: def.id, createdBy: 'user' };
  if (copy.kind === 'code') {
    copy.sourcePath = `${CUSTOM_DIR}/${pascal(name)}-${copy.id.slice(-5).replace(/[^A-Za-z0-9]/g, '')}.svelte`;
    copy.source ??= '';
  }
  state.components[copy.id] = copy;
  return copy;
}

function pascal(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(out) ? out : `Component${out}`;
}

/** Fork a theme-owned definition and rebind every use to the project-owned copy. */
export function ensureProjectOwned(state: ProjectState, defId: string): string {
  const def = own(state.components, defId) ?? fail(`Component "${defId}" does not exist.`);
  if (def.owner === 'project') return def.id;
  const copy = copyDefinition(state, def, def.name);
  copy.componentId = def.componentId;
  copy.category = def.category;
  for (const { node } of instancesOf(state, def.id)) node.definitionId = copy.id;
  return copy.id;
}

function makeUnique(state: ProjectState, op: Op<'component.makeUnique'>): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  const copy = copyDefinition(state, def, op.name?.trim() || `${def.name} (unique)`);
  node.definitionId = copy.id;
  return { definitionId: copy.id };
}

function createFromNode(state: ProjectState, op: Op<'component.createFromNode'>): OpResult {
  const tree = editableTree(state, op.owner);
  const root = getNode(tree, op.nodeId);
  const info = findParent(tree, op.nodeId) ?? fail('Node is not attached.');
  const defTree: NodeTree = { rootIds: [], nodes: {} };
  const properties: Record<string, PropSchema> = {};
  const props: Record<string, unknown> = {};
  const used = new Set<string>();
  const propName = (base: string) => {
    let n = base;
    let i = 2;
    while (used.has(n)) n = `${base}${i++}`;
    used.add(n);
    return n;
  };
  const parts: ComponentDefinition['parts'] = {};
  const rootCopy = copySubtree(tree, defTree, op.nodeId, state);
  defTree.rootIds = [rootCopy];
  parts.root = { nodeId: rootCopy, label: root.name ?? 'Root' };
  for (const n of Object.values(defTree.nodes)) {
    if (n.kind === 'text' && !isBinding(n.text)) {
      const isHeading = /^h\d$/.test(n.tag);
      const name = propName(n.rich ? 'body' : isHeading ? 'heading' : 'text');
      properties[name] = n.rich
        ? { type: 'richtext', label: titleCase(name), default: n.text as string[] }
        : { type: 'string', label: titleCase(name), default: String(n.text), multiline: !isHeading };
      props[name] = clone(n.text);
      n.text = { $prop: name };
      parts[name] = { nodeId: n.id, label: titleCase(name) };
    } else if (n.kind === 'image' && !isBinding(n.image)) {
      const name = propName('image');
      properties[name] = { type: 'image', label: titleCase(name), default: clone(n.image) };
      props[name] = clone(n.image);
      n.image = { $prop: name };
      parts[name] = { nodeId: n.id, label: titleCase(name) };
    } else if (n.kind === 'link' && !isBinding(n.link)) {
      const name = propName('button');
      properties[`${name}Label`] = { type: 'string', label: `${titleCase(name)} label`, default: String(n.label) };
      properties[`${name}Link`] = { type: 'link', label: `${titleCase(name)} link`, default: clone(n.link as LinkValue) };
      props[`${name}Label`] = String(n.label);
      props[`${name}Link`] = clone(n.link);
      n.label = { $prop: `${name}Label` };
      n.link = { $prop: `${name}Link` };
      parts[name] = { nodeId: n.id, label: titleCase(name) };
    } else if (n.kind === 'instance' && n.slots) {
      // Slot contents become part of the definition's structure.
    }
  }
  const def: ComponentDefinition = {
    schemaVersion: SCHEMA_VERSION,
    id: projectDefId(op.name),
    componentId: `project.${slugify(op.name) || 'component'}`,
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name: op.name.trim(),
    description: `Project component created from ${root.name ?? 'a selection'}.`,
    category: 'custom',
    tags: ['custom', 'project'],
    icon: 'component',
    properties,
    parts,
    tree: defTree,
    provenance: { createdBy: 'user' },
    license: 'Project'
  };
  state.components[def.id] = def;
  // Replace the subtree with an instance.
  const inst: InstanceNode = { id: newId('n'), kind: 'instance', definitionId: def.id, props };
  for (const id of subtreeIds(tree, op.nodeId)) delete tree.nodes[id];
  tree.nodes[inst.id] = inst;
  info.list.splice(info.index, 1, inst.id);
  return { definitionId: def.id, nodeId: inst.id };
}

function titleCase(s: string): string {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/(\d+)$/, ' $1');
}

function convertToCode(state: ProjectState, op: Op<'component.convertToCode'>): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is already a code component.`);
  const name = op.name?.trim() || `${def.name} (code)`;
  const newId = projectDefId(name, 'code');
  const sourcePath = `${CUSTOM_DIR}/${pascal(name)}-${newId.slice(-5).replace(/[^A-Za-z0-9]/g, '')}.svelte`;
  // Generate as if the file already lives at its final path, so relative imports resolve.
  const source = generateManagedComponent(state, { ...def, kind: 'code', sourcePath }, { instrument: false }).replace(/^<!-- Generated by[^\n]*\n/, `<!-- Code component converted from "${def.name}". Edit freely; declared properties stay editable in SiteOrigin Builder. -->\n`);
  const copy: ComponentDefinition = {
    ...clone(def),
    id: newId,
    componentId: `project.${slugify(name)}`,
    kind: 'code',
    owner: 'project',
    name,
    category: 'custom',
    tree: undefined,
    source,
    provenance: { ...def.provenance, forkedFrom: def.id, createdBy: 'user' }
  };
  copy.sourcePath = sourcePath;
  copy.parts = { root: { nodeId: 'root', label: 'Root' } };
  state.components[copy.id] = copy;
  node.definitionId = copy.id;
  return { definitionId: copy.id, sourcePath: copy.sourcePath };
}

function createCode(state: ProjectState, op: Op<'component.createCode'>): OpResult {
  const properties: Record<string, PropSchema> = {};
  for (const [k, raw] of Object.entries(op.properties ?? {})) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(k)) fail(`Property names must be camelCase identifiers ("${k}").`);
    const p = raw as Partial<PropSchema> & { type?: string };
    if (!p || typeof p !== 'object' || !['string', 'richtext', 'number', 'boolean', 'link', 'image', 'icon'].includes(String(p.type)))
      fail(`Property "${k}" needs a type of string, richtext, number, boolean, link, image or icon.`);
    const defaults: Record<string, unknown> = { string: '', richtext: [], number: 0, boolean: false, link: { type: 'none', target: '' }, image: { assetId: null, alt: '' }, icon: 'sparkles' };
    properties[k] = { type: p.type, label: String(p.label ?? k), default: p.default ?? defaults[p.type as string] } as PropSchema;
  }
  // Source safety (imports, module scripts, raw HTML) is checked from the syntax tree when the session saves it.
  const id = projectDefId(op.name, 'code');
  const def: ComponentDefinition = {
    schemaVersion: SCHEMA_VERSION,
    id,
    componentId: `project.${slugify(op.name)}`,
    contractVersion: 1,
    kind: 'code',
    owner: 'project',
    name: op.name.trim(),
    description: op.description ?? 'Custom code component.',
    category: 'custom',
    tags: ['custom', 'code'],
    icon: 'code',
    properties,
    parts: { root: { nodeId: 'root', label: 'Root' } },
    source: op.source,
    sourcePath: `${CUSTOM_DIR}/${pascal(op.name)}-${id.slice(-5).replace(/[^A-Za-z0-9]/g, '')}.svelte`,
    provenance: { createdBy: 'user' },
    license: 'Project'
  };
  state.components[id] = def;
  return { definitionId: id, sourcePath: def.sourcePath, hash: sourceHash(op.source) };
}

/**
 * Switch to a compatible theme: theme-owned definitions are replaced by the new theme's implementation of the
 * same public contract and every use is rebound. Project-owned components, content, list IDs, overrides and
 * token overrides are preserved. Incompatible contracts block the switch with a conflict report.
 */
function themeApply(state: ProjectState, themeId: string): OpResult {
  const theme = listThemes().find((t) => t.id === themeId) ?? fail(`Unknown theme "${themeId}".`);
  if (state.site.themeId === themeId) return {};
  const conflicts: string[] = [];
  const mapping = new Map<string, ComponentDefinition>();
  for (const def of Object.values(state.components)) {
    if (def.owner !== 'theme') continue;
    const next = theme.components.find((c) => c.componentId === def.componentId);
    if (!next) {
      conflicts.push(`${def.name}: not provided by ${theme.name}.`);
      continue;
    }
    for (const p of Object.keys(def.properties)) if (!next.properties[p] || next.properties[p].type !== def.properties[p].type) conflicts.push(`${def.name}: property "${p}" is not compatible.`);
    for (const p of Object.keys(def.parts)) if (!next.parts[p]) conflicts.push(`${def.name}: part "${p}" is missing.`);
    for (const v of Object.keys(def.variants ?? {})) if (!next.variants?.[v]) conflicts.push(`${def.name}: variant "${v}" is missing.`);
    for (const sl of Object.keys(def.slots ?? {})) if (!next.slots?.[sl]) conflicts.push(`${def.name}: slot "${sl}" is missing.`);
    mapping.set(def.id, next);
  }
  if (conflicts.length) throw new EngineError('CONFLICT', `${theme.name} is not compatible with this project: ${conflicts.join(' ')}`, { conflicts });
  for (const [oldId, next] of mapping) {
    const installed = clone(next);
    state.components[installed.id] = installed;
    state.themeLock.components[installed.id] = { componentId: installed.componentId, version: theme.version, hash: sourceHash(JSON.stringify(next)) };
    for (const t of allTrees(state)) {
      // Project-owned components keep their pinned dependencies.
      if (t.owner.kind === 'component' && state.components[t.owner.id]?.owner === 'project') continue;
      for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance' && n.definitionId === oldId) n.definitionId = installed.id;
    }
  }
  // Old theme definitions are dropped once nothing references them (code converted from them still uses their CSS).
  const stillNeeded = new Set(Object.values(state.components).filter((d) => d.kind === 'code' && d.provenance?.forkedFrom).map((d) => d.provenance!.forkedFrom!));
  for (const oldId of mapping.keys()) {
    if (!instancesOf(state, oldId).length && !stillNeeded.has(oldId)) {
      delete state.components[oldId];
      delete state.themeLock.components[oldId];
    }
  }
  state.site.themeId = theme.id;
  state.themeLock.theme = { id: theme.id, version: theme.version };
  return { rebound: mapping.size };
}

export function applyOperations(state: ProjectState, ops: EditOperation[]): { state: ProjectState; results: OpResult[] } {
  const draft = clone(state);
  const results: OpResult[] = [];
  for (const [i, op] of ops.entries()) {
    try {
      results.push(applyOperation(draft, op));
    } catch (e) {
      if (e instanceof EngineError) {
        e.message = ops.length > 1 ? `Operation ${i + 1} (${op.type}): ${e.message}` : e.message;
      }
      throw e;
    }
  }
  return { state: draft, results };
}
