import type {
  ComponentDefinition,
  GraphNode,
  InstanceNode,
  LinkValue,
  ListItem,
  NodeTree,
  OwnerRef,
  PageDoc,
  ProjectState,
  PropSchema,
  ResponsiveScope,
  StyleValue,
  TokenDef,
  TokenValue,
  RichText
} from '@shared/types';
import type { Binding } from '@shared/types';
import { SCHEMA_VERSION, isBinding } from '@shared/types';
import type { EditOperation, Op } from '@shared/ops';
import { STYLE_PROP_MAP, isSafeCssValue, styleSetFor, tokenVar, validateStyleValue } from '@shared/styles';
import { normalizeRoute, slugify, validateRoute } from '@shared/routes';
import { newId } from '@shared/ids';
import { findVariant, variantOptions } from '@shared/variants';
import { fontAssetUsages, projectFontFamilies, renameFontFamily, sameFontFamily } from '@shared/fonts';
import { getTheme, listThemes } from '@catalogue/index';
import { resolveFontStack } from '@catalogue/fonts';
import { effectiveTokens, generateStandaloneComponent, CUSTOM_DIR } from '@generator/index';
import { pageIds } from '@generator/checks';
import { pageLinkUses, type PageLinkUse } from './page-links';
import { EngineError, RESERVED_ANCHORS, anchorCapable, anchorsInUse, childLists, fail, findParent, getNode, getTree, headerMenu, instancesOf, itemLinkPairs, subtreeIds, allTrees } from './tree';
import { followText, joinedLines } from '@shared/contact-links';
import { clone, definitionHash, freshListIds, installComponent, makeInstance } from './install';
import { normalizeImage, normalizeItem, normalizeLink, normalizeProp, normalizeRichText } from './values';
import { enclosingList, normalizeProperties } from './schema';
import { forEachTokenRef, tokenUsageCounts } from './tokens';
import { settleFormKeys } from './form-keys';
import { namesFormFields, type FormField } from '@catalogue/foundation/form';
import {
  componentRemove,
  dependentsOf,
  directDependencies,
  dropPartOverrides,
  nodeSetBinding,
  removePart,
  removePropSchema,
  removeSlot,
  removeVariant,
  replaceProperties,
  setPart,
  setPropSchema,
  setSlot,
  setVariant
} from './definitions';
import { contractConflicts, themeRefresh } from './theme-updates';

export type OpResult = Record<string, unknown>;

/**
 * What the editor's Copy holds: a detached copy of one page subtree as it was when copied, with the names of
 * the components, pages, images and site styles it refers to, so a paste can say which one has gone since.
 * The open session keeps it in memory; it is never saved.
 */
export interface Clipboard {
  id: string;
  /** The page it was copied from. */
  pageId: string;
  /** The copied subtree; its only root is the copied node. */
  tree: NodeTree;
  /** Placed components: name, and the property schema and slots the copied content was written for. */
  components: Record<string, { name: string; contract: string }>;
  pages: Record<string, string>;
  assets: Record<string, string>;
}

/** State an operation can read that is not part of the project: what the editor has recently copied. */
export interface ApplyContext {
  clipboards?: readonly Clipboard[];
  /** List item fields the batch sets itself (see explicitItemFields). applyOperations fills it. */
  explicitItemFields?: ReadonlySet<string>;
}

/** Own-property lookup: externally supplied keys must never resolve to inherited prototype members. */
function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Apply one operation to a mutable draft. Throws EngineError on invalid input. */
export function applyOperation(state: ProjectState, op: EditOperation, ctx: ApplyContext = {}): OpResult {
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
      return pageSetHome(state, op.pageId, op.keepOldAddress !== false);
    case 'node.insert':
      return nodeInsert(state, op);
    case 'node.remove': {
      const tree = editableTree(state, op.owner);
      const removed = new Set(subtreeIds(tree, op.nodeId));
      removeNode(tree, op.nodeId);
      // In definition editing, parts and variant rules for removed elements go with them.
      if (op.owner.kind === 'component') {
        const def = state.components[op.owner.id];
        for (const [pid, part] of Object.entries(def.parts))
          if (pid !== 'root' && removed.has(part.nodeId)) {
            delete def.parts[pid];
            dropPartOverrides(state, def.id, pid);
          }
        for (const { option: v } of variantOptions(def)) for (const nid of Object.keys(v.styles ?? {})) if (removed.has(nid)) delete v.styles![nid];
      }
      return {};
    }
    case 'node.move':
      return nodeMove(state, op);
    case 'node.duplicate':
      return nodeDuplicate(state, op);
    case 'node.copy':
      return nodeCopy(state, op);
    case 'node.paste':
      return nodePaste(state, op, ctx.clipboards?.find((c) => c.id === op.clipboardId));
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
    case 'node.setBinding':
      return nodeSetBinding(state, op);
    case 'instance.setProp':
      return keepingFormKeys(state, op, () => instanceSetProp(state, op, ctx));
    case 'instance.listInsert':
      return keepingFormKeys(state, op, () => listInsert(state, op));
    case 'instance.listRemove':
      return keepingFormKeys(state, op, () => {
        const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
        const list = (node.props[op.prop] as Array<{ id: string }>) ?? [];
        if (!list.some((i) => i.id === op.itemId)) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
        if (schema.min !== undefined && list.length <= schema.min) fail(`${schema.label} needs at least ${schema.min} items.`);
        node.props[op.prop] = list.filter((i) => i.id !== op.itemId);
        return {};
      });
    case 'instance.listMove':
      return keepingFormKeys(state, op, () => {
        const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
        const list = [...((node.props[op.prop] as Array<{ id: string }>) ?? [])];
        const from = list.findIndex((i) => i.id === op.itemId);
        if (from < 0) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
        const [it] = list.splice(from, 1);
        list.splice(Math.min(op.index, list.length), 0, it);
        node.props[op.prop] = list;
        return {};
      });
    case 'instance.setVariant': {
      const { node, def } = instanceTarget(state, op.owner, op.nodeId);
      const found = variantOption(def, op.variant, op.axis);
      node.variants = { ...node.variants, [found.axis]: found.id };
      return {};
    }
    case 'token.set':
      return tokenSet(state, op);
    case 'token.create':
      return tokenCreate(state, op);
    case 'token.rename': {
      const t = customToken(state, op.tokenId);
      t.label = op.label.trim();
      if (op.description !== undefined) {
        if (op.description.trim()) t.description = op.description.trim();
        else delete t.description;
      }
      return {};
    }
    case 'token.remove':
      return tokenRemove(state, op);
    case 'token.replace':
      return tokenReplace(state, op.tokenId, op.withTokenId);
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
      if (op.properties) replaceProperties(state, def, op.properties);
      def.source = op.source;
      return { hash: sourceHash(op.source) };
    }
    case 'component.remove':
      return componentRemove(state, op);
    case 'component.setPropSchema':
      return setPropSchema(state, op);
    case 'component.removePropSchema':
      return removePropSchema(state, op);
    case 'component.setPart':
      return setPart(state, op);
    case 'component.removePart':
      return removePart(state, op);
    case 'component.setVariant':
      return setVariant(state, op);
    case 'component.removeVariant':
      return removeVariant(state, op);
    case 'component.setSlot':
      return setSlot(state, op);
    case 'component.removeSlot':
      return removeSlot(state, op);
    case 'theme.apply':
      return themeApply(state, op.themeId);
    case 'theme.refresh':
      return themeRefresh(state, op);
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
      if (op.font !== undefined) {
        if (a.kind !== 'font') fail(`"${a.name}" is not a font.`);
        const from = a.font?.family;
        a.font = { ...op.font };
        // Once no file provides the old family name, styles that named it follow the rename.
        if (from && from !== op.font.family && !projectFontFamilies(state).some((f) => f.family.toLowerCase() === from.toLowerCase())) renameFontFamily(state, from, op.font.family);
      }
      return {};
    }
    case 'asset.remove': {
      const removing = own(state.assets.assets, op.assetId);
      if (!removing) fail(`Asset "${op.assetId}" does not exist.`);
      // One face of a family can go while another still provides the family its styles name.
      const otherFace = removing!.kind === 'font' && Object.values(state.assets.assets).some((x) => x?.id !== op.assetId && sameFontFamily(x, removing!));
      const uses = otherFace ? 0 : (assetUsages(state)[op.assetId] ?? 0);
      if (uses) fail(`This ${state.assets.assets[op.assetId].kind === 'font' ? 'font' : 'image'} is used ${uses} time${uses === 1 ? '' : 's'}. Replace or remove those uses first.`);
      delete state.assets.assets[op.assetId];
      return {};
    }
    case 'asset.replace': {
      if (!own(state.assets.assets, op.assetId) || !own(state.assets.assets, op.withAssetId)) fail('Both assets must exist.');
      if (state.assets.assets[op.assetId].kind !== 'image' || state.assets.assets[op.withAssetId].kind !== 'image') fail('Only an image can replace an image.');
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

function variantOption(def: ComponentDefinition, id: string, axis?: string) {
  const found = findVariant(def, id, axis);
  if ('error' in found) fail(found.error);
  return found;
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
  if (isBinding(node.props[prop])) fail(`${schema.label} comes from the enclosing component's own property; edit its items there.`);
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
  // An imported font is in use while a token or style names its family.
  for (const [id, n] of Object.entries(fontAssetUsages(state))) out[id] = (out[id] ?? 0) + n;
  return out;
}

/** How many links from the rest of the site go to a page: the links deleting it would move to a replacement. */
export function pageLinkReferences(state: ProjectState, pageId: string): number {
  return pageLinkUses(state, pageId).length;
}

function routeTaken(state: ProjectState, route: string, exceptPageId?: string): boolean {
  return Object.values(state.pages).some((p) => p.id !== exceptPageId && p.route.toLowerCase() === route.toLowerCase());
}

/** Where the old address `route` is kept working, compared as case-insensitive filesystems do; -1 when it is not. */
function redirectIndex(state: ProjectState, route: string): number {
  const list: unknown = state.site.redirects;
  return Array.isArray(list) ? list.findIndex((r) => typeof r?.from === 'string' && r.from.toLowerCase() === route.toLowerCase()) : -1;
}

/**
 * Whether a route chosen automatically for `forPageId` (or a new page) would collide: with another page, or with
 * an old address kept working for another page. A page may take back an old address of its own.
 */
function routeReserved(state: ProjectState, route: string, forPageId?: string): boolean {
  if (routeTaken(state, route, forPageId)) return true;
  const i = redirectIndex(state, route);
  return i >= 0 && state.site.redirects![i].pageId !== forPageId;
}

/**
 * The route a page titled `title` gets automatically: its slug (made valid when it is a reserved name), with a
 * numbered suffix when it is taken, kept within the 60-character segment limit. The Pages panel previews new
 * pages' routes the same way.
 */
function autoRoute(state: ProjectState, title: string, fallback: string, forPageId?: string): string {
  let slug = slugify(title) || fallback;
  if (validateRoute(`/${slug}/`)) slug = `${slug.slice(0, 55)}-page`;
  let route = `/${slug}/`;
  for (let i = 2; routeReserved(state, route, forPageId); i++) route = `/${slug.slice(0, 60 - `-${i}`.length).replace(/-+$/, '')}-${i}/`;
  return route;
}

/** A page now uses `route`: an old address kept working there stops redirecting, because the page takes it over. */
function claimRoute(state: ProjectState, route: string) {
  const i = redirectIndex(state, route);
  if (i < 0) return;
  state.site.redirects!.splice(i, 1);
  if (!state.site.redirects!.length) delete state.site.redirects;
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
  } else route = autoRoute(state, op.title, 'page');
  if (op.pageId && Object.hasOwn(state.pages, op.pageId)) fail(`Page "${op.pageId}" already exists.`);
  claimRoute(state, route);
  const id = op.pageId ?? newId('pg');
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
    claimRoute(state, route);
  }
  if (op.navLabel !== undefined) page.navLabel = op.navLabel || undefined;
  if (op.seoTitle !== undefined) page.seo.title = op.seoTitle || undefined;
  if (op.description !== undefined) page.seo.description = op.description || undefined;
  if (op.noindex !== undefined) page.seo.noindex = op.noindex || undefined;
  if (op.shell !== undefined) page.shell = op.shell;
  if (op.socialImage !== undefined) {
    if (op.socialImage && own(state.assets.assets, op.socialImage)?.kind !== 'image') fail('Social image asset not found.');
    if (op.socialImage) page.seo.socialImage = op.socialImage;
    else delete page.seo.socialImage;
  }
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
  const page: PageDoc = { ...clone(src), id, title, route: autoRoute(state, title, 'page'), rootIds: [], nodes: {} };
  for (const rid of src.rootIds) page.rootIds.push(copySubtree(src, page, rid, state));
  state.pages[id] = page;
  keepSectionLinksOnCopy(state, src.id, page);
  state.site.pageOrder.splice(state.site.pageOrder.indexOf(src.id) + 1, 0, id);
  return { pageId: id, route: page.route };
}

/**
 * A copied link to one of the source page's own sections would send visitors back to the original. The copy has the
 * same section IDs, so those links move to the copy. Links to another page, to the shared header or footer, and to
 * the source page as a whole stay as they were: a link back to the source is one the author chooses.
 */
function keepSectionLinksOnCopy(state: ProjectState, sourceId: string, copy: PageDoc) {
  // An empty shell set leaves the header and footer's IDs out: those are shared, so their links stay where they were.
  const ids = pageIds(state, copy.id, new Set());
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const l = v as Partial<LinkValue>;
    if (l.type === 'page' && l.target === sourceId && l.anchor && ids.has(l.anchor)) l.target = copy.id;
    Object.values(v).forEach(walk);
  };
  walk(copy.nodes);
}

/**
 * Where each link to a section of a removed page goes on its replacement: the same section when the replacement has
 * one with that ID, else the section chosen for it, else the top of the replacement page. A link is never left
 * pointing at a section its new page does not have, and never moved off a section its new page does have.
 */
function sectionsOnReplacement(state: ProjectState, page: PageDoc, replacementId: string, uses: PageLinkUse[], choices: Op<'page.remove'>['sectionReplacements']): (anchor: string) => string {
  const ids = pageIds(state, replacementId);
  const title = state.pages[replacementId].title;
  const incoming = new Set(uses.map((u) => u.link.anchor).filter(Boolean));
  const chosen = new Map<string, string>();
  for (const c of choices ?? []) {
    const from = c.from.replace(/^#/, '');
    const to = c.to.replace(/^#/, '');
    if (!incoming.has(from)) fail(`No link to "${page.title}" goes to #${from}.`);
    if (chosen.has(from)) fail(`Links to #${from} were given more than one section.`);
    if (to && !ids.has(to)) fail(`"${title}" has no section with the ID "${to}". Choose one of its sections, or "" for the top of the page.`);
    chosen.set(from, to);
  }
  return (anchor) => (ids.has(anchor) ? anchor : (chosen.get(anchor) ?? ''));
}

function pageRemove(state: ProjectState, op: Op<'page.remove'>): OpResult {
  const page = own(state.pages, op.pageId) ?? fail(`Page "${op.pageId}" does not exist.`);
  if (state.site.pageOrder.length <= 1) fail('A site needs at least one page.');
  const uses = pageLinkUses(state, page.id);
  const refs = uses.length;
  if (op.replacementPageId && !own(state.pages, op.replacementPageId)) fail('The replacement page does not exist.');
  if (op.replacementPageId === page.id) fail('The replacement must be a different page.');
  if (refs && !op.replacementPageId)
    throw new EngineError('VALIDATION_FAILED', `${refs} link${refs === 1 ? '' : 's'} point to "${page.title}". Choose a replacement page for them.`, { references: refs });
  if (op.sectionReplacements?.length && !op.replacementPageId) fail('Sections for links can only be chosen on a replacement page.');
  // Sections are looked up before anything moves: the replacement page's IDs do not depend on the page going.
  const section = op.replacementPageId ? sectionsOnReplacement(state, page, op.replacementPageId, uses, op.sectionReplacements) : null;
  if (page.id === state.site.homePageId) {
    // The page replacing Home moves to "/". Its old address is not kept: this removes a page, it moves none.
    const next = op.replacementPageId ?? state.site.pageOrder.find((id) => id !== page.id)!;
    state.pages[next].route = '/';
    state.site.homePageId = next;
  }
  if (op.replacementPageId && section)
    for (const { link } of uses) {
      link.target = op.replacementPageId;
      const anchor = link.anchor ? section(link.anchor) : '';
      if (anchor) link.anchor = anchor;
      else delete link.anchor;
    }
  // Old addresses kept for the removed page follow its links to the replacement, or go with it.
  if (Array.isArray(state.site.redirects)) {
    state.site.redirects = state.site.redirects.flatMap((r) => (r.pageId !== page.id ? [r] : op.replacementPageId ? [{ ...r, pageId: op.replacementPageId }] : []));
    if (!state.site.redirects.length) delete state.site.redirects;
  }
  delete state.pages[page.id];
  state.site.pageOrder = state.site.pageOrder.filter((id) => id !== page.id);
  return {};
}

/** A page's address before and after an edit. */
export type RouteMove = { pageId: string; from: string; to: string };

/** What making a page Home changes: the addresses that move, and the old address kept working, if any. */
export type HomeChange = { moved: RouteMove[]; kept?: string };

/**
 * Make `pageId` the Home page. It moves to "/" and the previous Home page moves to an address of its own. With
 * `keepOldAddress`, the page's old address keeps working and sends visitors on, so old links and bookmarks still
 * reach it. That address is kept before the previous Home's is chosen, so the previous Home can never take it.
 */
function pageSetHome(state: ProjectState, pageId: string, keepOldAddress: boolean): HomeChange {
  const page = own(state.pages, pageId) ?? fail(`Page "${pageId}" does not exist.`);
  if (state.site.homePageId === pageId) return { moved: [] };
  const old = own(state.pages, state.site.homePageId);
  const vacated = page.route;
  const moved: RouteMove[] = [{ pageId, from: vacated, to: '/' }];
  page.route = '/';
  state.site.homePageId = pageId;
  if (keepOldAddress) state.site.redirects = [...(Array.isArray(state.site.redirects) ? state.site.redirects : []), { from: vacated, pageId }];
  if (old) {
    const from = old.route;
    old.route = autoRoute(state, old.title, 'previous-home', old.id);
    claimRoute(state, old.route);
    moved.push({ pageId: old.id, from, to: old.route });
  }
  return keepOldAddress ? { moved, kept: vacated } : { moved };
}

/** What making `pageId` Home would change, without changing anything. */
export function planHomeChange(state: ProjectState, pageId: string, keepOldAddress: boolean): HomeChange {
  const draft: ProjectState = { ...state, site: clone(state.site), pages: Object.fromEntries(Object.entries(state.pages).map(([id, p]) => [id, { ...p }])) };
  return pageSetHome(draft, pageId, keepOldAddress);
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function primitiveNode(state: ProjectState, kind: NonNullable<Op<'node.insert'>['primitive']>, text?: string): GraphNode[] {
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
    case 'richtext':
      return [{ id, kind: 'text', tag: 'div', rich: true, text: normalizeRichText(text ?? 'Write something here.', state, 'Rich text'), styles: { base: { textStyle: space('text.body') } } }];
    case 'slot':
    case 'repeat':
      fail(`A ${kind} needs a component definition and "bind".`);
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
  if (parent.kind === 'element' || parent.kind === 'repeat') {
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
  if (op.primitive === 'slot' || op.primitive === 'repeat') {
    nodes = [structuralNode(state, op.owner, op.primitive, op.bind)];
  } else if (op.primitive) {
    nodes = primitiveNode(state, op.primitive, op.text);
  } else {
    let def: ComponentDefinition;
    if (op.definitionId) def = state.components[op.definitionId] ?? fail(`Component definition "${op.definitionId}" is not installed.`);
    else if (op.componentId) {
      // Always the active theme's implementation (older theme definitions may be retained for existing uses).
      def = state.components[installComponent(state, op.componentId)];
    } else fail('node.insert needs componentId, definitionId or primitive.');
    if (def.category === 'shell') fail('Header and footer are shared across pages and cannot be inserted.');
    if (op.owner.kind === 'component' && (def.id === op.owner.id || dependsOn(state, def.id, op.owner.id))) fail('A component cannot contain itself.');
    const chosen: Record<string, string> = {};
    if (op.variant) {
      const found = variantOption(def, op.variant);
      chosen[found.axis] = found.id;
    }
    for (const [axis, id] of Object.entries(op.variants ?? {})) chosen[axis] = variantOption(def, id, axis).id;
    const inst = makeInstance(def, {}, chosen);
    if (op.props) {
      for (const [k, v] of Object.entries(op.props)) {
        const schema = def.properties[k];
        if (!schema) fail(`"${def.name}" has no property "${k}". Properties: ${Object.keys(def.properties).join(', ')}.`);
        inst.props[k] = normalizeProp(schema, v, state, `${def.name} → ${schema.label}`);
      }
      // Every field of a new form is new, so each gets a key of its own unless its name already decides one.
      if (Array.isArray(inst.props.fields) && 'fields' in op.props && namesFormFields(def)) inst.props.fields = settleFormKeys([], inst.props.fields as ListItem[], new Set(), formDefaults(def));
    }
    nodes = [inst];
  }
  for (const n of nodes) tree.nodes[n.id] = n;
  const index = op.index === undefined ? list.length : Math.min(op.index, list.length);
  list.splice(index, 0, nodes[0].id);
  return { nodeId: nodes[0].id };
}

/** Slots and repeats belong to component definitions: a slot renders a declared slot, a repeat a list property. */
function structuralNode(state: ProjectState, owner: OwnerRef, kind: 'slot' | 'repeat', bind: string | undefined): GraphNode {
  if (owner.kind !== 'component') fail(`A ${kind} can only be added while editing a component definition.`);
  const def = state.components[owner.id];
  if (!bind) fail(kind === 'slot' ? 'Name the slot to render with "bind".' : 'Name the list property to repeat with "bind".');
  if (kind === 'slot') {
    if (!own(def.slots ?? {}, bind)) fail(`"${def.name}" has no slot "${bind}". Declare it with component.setSlot first.`);
    if (Object.values(def.tree!.nodes).some((n) => n.kind === 'slot' && n.slot === bind)) fail(`The "${bind}" slot is already placed in this design.`);
    return { id: newId('n'), kind: 'slot', slot: bind };
  }
  const schema = own(def.properties, bind);
  if (schema?.type !== 'list') fail(`"${bind}" is not a list property of "${def.name}".`);
  return { id: newId('n'), kind: 'repeat', list: { $prop: bind }, children: [], styles: { base: { layout: 'stack', gap: { token: 'space.md' } } } };
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
  return placeCopy(state, from, op.nodeId, op);
}

/** What copied content relies on a component for: its property schema and slots. Its look can change freely. */
function contentContract(def: ComponentDefinition): string {
  return JSON.stringify({ properties: Object.keys(def.properties).sort().map((k) => [k, def.properties[k]]), slots: Object.keys(def.slots ?? {}).sort() });
}

function styleTokens(n: GraphNode): string[] {
  const out: string[] = [];
  const all = [n.styles, ...(n.kind === 'instance' ? Object.values(n.overrides ?? {}) : [])];
  for (const rs of all)
    for (const scope of Object.values(rs ?? {}))
      for (const v of Object.values(scope ?? {})) if (v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string') out.push((v as { token: string }).token);
  return out;
}

/** Take a copy of page content as it is now, for a later paste that must not depend on the original. */
export function captureClipboard(state: ProjectState, pageId: string, nodeId: string): Clipboard {
  const page = getTree(state, { kind: 'page', id: pageId });
  getNode(page, nodeId);
  if (!findParent(page, nodeId)) fail('Node is not attached.');
  const clip: Clipboard = { id: newId('clip'), pageId, tree: { rootIds: [nodeId], nodes: {} }, components: {}, pages: {}, assets: {} };
  for (const id of subtreeIds(page, nodeId)) {
    const n = clone(page.nodes[id]);
    for (const cl of childLists(n)) if (cl.ids.some((c) => !own(page.nodes, c))) fail('Part of this content is missing from the page, so it cannot be copied.');
    if (n.kind === 'instance') {
      const def = own(state.components, n.definitionId) ?? fail(`Component definition "${n.definitionId}" is missing.`);
      if (def.category === 'shell') fail('The shared header and footer cannot be copied.');
      clip.components[def.id] = { name: def.name, contract: contentContract(def) };
    }
    clip.tree.nodes[id] = n;
  }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o.type === 'page' && typeof o.target === 'string') clip.pages[o.target] = own(state.pages, o.target)?.title ?? o.target;
    if (typeof o.assetId === 'string') clip.assets[o.assetId] = own(state.assets.assets, o.assetId)?.name ?? o.assetId;
    Object.values(o).forEach(walk);
  };
  walk(clip.tree.nodes);
  return clip;
}

/**
 * Paste what was copied, as it was when copied: the original may since have been edited or removed. What it
 * refers to must still be in the project, and the components it places must still take the same content.
 */
function nodePaste(state: ProjectState, op: Op<'node.paste'>, clip: Clipboard | undefined): OpResult {
  if (!clip) fail('Nothing copied is available to paste. Copy it again.');
  // The editor pastes onto pages only; content placed inside a definition follows other rules.
  if (op.toOwner.kind !== 'page') fail('Paste onto a page.');
  const gone = (what: string) => fail(`Nothing was pasted: the copy ${what}, which has been removed since it was copied.`);
  for (const [id, c] of Object.entries(clip.components)) {
    const def = own(state.components, id);
    if (!def) gone(`uses the "${c.name}" component`);
    if (contentContract(def!) !== c.contract) fail(`Nothing was pasted: the content "${c.name}" takes has changed since it was copied. Copy it again.`);
  }
  for (const [id, title] of Object.entries(clip.pages)) if (!own(state.pages, id)) gone(`links to the "${title}" page`);
  for (const [id, name] of Object.entries(clip.assets)) if (!own(state.assets.assets, id)) gone(`shows the image "${name}"`);
  // Variant options and parts removed since copying are dropped, as they were from every live placement;
  // only then is what remains checked for site styles.
  const tree = clone(clip.tree);
  const tokens = new Set(effectiveTokens(state).map((t) => t.id));
  for (const n of Object.values(tree.nodes)) {
    if (n.kind === 'instance') {
      const def = state.components[n.definitionId];
      for (const [axis, v] of Object.entries(n.variants ?? {})) {
        const a = def.variantAxes && own(def.variantAxes, axis);
        if (!a || typeof v !== 'string' || !own(a.options, v)) delete n.variants![axis];
      }
      if (n.variants && !Object.keys(n.variants).length) delete n.variants;
      for (const part of Object.keys(n.overrides ?? {})) if (part !== 'root' && !own(def.parts, part)) delete n.overrides![part];
      if (n.overrides && !Object.keys(n.overrides).length) delete n.overrides;
    }
    for (const t of styleTokens(n)) if (!tokens.has(t)) gone(`uses the site style "${t}"`);
  }
  return placeCopy(state, tree, tree.rootIds[0], op);
}

/** Place a copy of `from`'s subtree at `op`'s destination, with new IDs; shared by copy and paste. */
function placeCopy(state: ProjectState, from: NodeTree, nodeId: string, op: { toOwner: OwnerRef; parentId?: string | null; slot?: string; index?: number }): OpResult {
  const to = editableTree(state, op.toOwner);
  for (const id of subtreeIds(from, nodeId)) {
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
  const nid = copySubtree(from, to, nodeId, state);
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

/** Style rules a definition's variant sets on one of its nodes. */
function variantStyles(state: ProjectState, owner: OwnerRef, nodeId: string, variant: string, partId?: string, axis?: string) {
  if (owner.kind !== 'component') fail('Variants belong to component definitions. Edit the component to style a variant.');
  const tree = editableTree(state, owner);
  const node = getNode(tree, nodeId);
  if (partId) fail('partId does not apply to variant rules; target the node itself.');
  if (node.kind === 'repeat' || node.kind === 'slot') fail('Repeats and slots render no element of their own; style an element inside them.');
  if (tree.rootIds.indexOf(nodeId) > 0) fail('Only the first top-level element carries the variant; style an element inside it.');
  const def = state.components[owner.id];
  const found = variantOption(def, variant, axis);
  const v = def.variantAxes![found.axis].options[found.id];
  v.styles ??= {};
  return v;
}

function nodeSetStyle(state: ProjectState, op: Op<'node.setStyle'>): OpResult {
  if (op.axis !== undefined && op.variant === undefined) fail('"axis" needs a "variant": name the option to style.');
  const tree = editableTree(state, op.owner);
  const node = getNode(tree, op.nodeId);
  if (!own(STYLE_PROP_MAP, op.property)) fail(`Unknown style property "${op.property}". Valid: ${Object.keys(STYLE_PROP_MAP).join(', ')}.`);
  if (op.value !== null) {
    const err = validateStyleValue(op.property, op.value);
    if (err) fail(err);
    checkTokenRef(state, op.value);
    // A literal family on an element follows the same rule as a font token; keywords and var() name no family.
    if (op.property === 'fontFamily' && typeof op.value === 'string' && !/^(inherit|initial|unset|revert|revert-layer|var\(.*)$/i.test(op.value.trim())) {
      const font = resolveFontStack(state, op.value);
      if ('error' in font) fail(font.error);
      op = { ...op, value: font.stack };
    }
  }
  const scope = op.scope as ResponsiveScope;
  if (op.variant !== undefined) {
    const v = variantStyles(state, op.owner, op.nodeId, op.variant, op.partId, op.axis);
    v.styles![op.nodeId] ??= {};
    setStyle(v.styles![op.nodeId] as Record<string, Record<string, StyleValue>>, scope, op.property, op.value);
    if (!Object.keys(v.styles![op.nodeId]).length) delete v.styles![op.nodeId];
    if (!Object.keys(v.styles!).length) delete v.styles;
    return {};
  }
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
  if (op.axis !== undefined && op.variant === undefined) fail('"axis" needs a "variant": name the option to reset.');
  const node = getNode(editableTree(state, op.owner), op.nodeId);
  if (op.variant !== undefined) {
    const v = variantStyles(state, op.owner, op.nodeId, op.variant, op.partId, op.axis);
    const rules = v.styles![op.nodeId];
    if (rules && op.scope) delete rules[op.scope];
    if (rules && (!op.scope || !Object.keys(rules).length)) delete v.styles![op.nodeId];
    if (!Object.keys(v.styles!).length) delete v.styles;
    return {};
  }
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
    const schema = own(def.properties, field.$prop);
    if (!schema) fail(`Missing property ${field.$prop}.`);
    // The default must still fit its schema (a number or choice can be bound to text).
    (schema as { default: unknown }).default = normalizeProp(schema, schemaFix(schema), state, `${def.name} → ${schema.label}`);
    return true;
  };
  const v = op.value;
  switch (op.field) {
    case 'text': {
      if (node.kind !== 'text') fail('Only text nodes have text.');
      // A bound field is read by its property's schema, which knows how plain lines are shown there.
      if (setBound(node.text, () => (node.rich ? (v ?? '') : String(v ?? '')))) return {};
      node.text = node.rich ? normalizeRichText(v ?? '', state, label) : String(v ?? '');
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

/** The key of one field of one list item, for the fields a batch sets itself. */
const itemFieldKey = (owner: OwnerRef, nodeId: string, prop: string, itemId: string, field: string) => JSON.stringify([owner.kind, owner.id, nodeId, prop, itemId, field]);

/**
 * The list item fields a batch sets by name: a field edit, the fields of an item patch, and the fields of the
 * items a whole list carries. A link set this way is the caller's choice, whatever order the batch puts it in,
 * so an edit to its visible text in the same batch never moves it.
 */
function explicitItemFields(ops: EditOperation[]): Set<string> {
  const out = new Set<string>();
  const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const op of ops) {
    if (op.type !== 'instance.setProp') continue;
    const add = (itemId: string, fields: string[]) => fields.forEach((f) => out.add(itemFieldKey(op.owner, op.nodeId, op.prop, itemId, f)));
    if (op.itemId && op.field) add(op.itemId, [op.field]);
    else if (op.itemId && row(op.value)) add(op.itemId, Object.keys(op.value));
    else if (!op.itemId && Array.isArray(op.value)) for (const it of op.value) if (row(it) && typeof it.id === 'string') add(it.id, Object.keys(it));
  }
  return out;
}

/**
 * Keep an item's email or phone link with the visible text an edit changed (`sent` holds the fields the edit
 * names): when the old text showed what the link opens and the new text is an address or number too, the link
 * opens the new one. A deliberate label ("Call reception"), a link the edit sets itself, and a pair that already
 * disagreed stay as they are. Returns the link fields that moved.
 */
function followItemLinks(state: ProjectState, def: ComponentDefinition, op: Op<'instance.setProp'>, before: ListItem, next: ListItem, sent: Record<string, unknown>, ctx: ApplyContext): string[] {
  const moved: string[] = [];
  for (const { text, link } of itemLinkPairs(def, op.prop)) {
    if (!Object.hasOwn(sent, text) || Object.hasOwn(sent, link) || ctx.explicitItemFields?.has(itemFieldKey(op.owner, op.nodeId, op.prop, before.id, link))) continue;
    // Lines that are each a number are a list, even once a one-line field joins them.
    const to = joinedLines(sent[text]) === null ? null : followText(before[text], next[text], before[link]);
    if (!to) continue;
    try {
      next[link] = normalizeLink(to, state, `${def.name} → ${link}`);
    } catch (e) {
      // A link that cannot carry the new text (an old subject this version refuses) stays as it was.
      if (e instanceof EngineError) continue;
      throw e;
    }
    moved.push(link);
  }
  return moved;
}

function instanceSetProp(state: ProjectState, op: Op<'instance.setProp'>, ctx: ApplyContext = {}): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  const schema = def.properties[op.prop];
  if (!schema) fail(`"${def.name}" has no property "${op.prop}". Properties: ${Object.keys(def.properties).join(', ')}.`);
  if (op.itemId) {
    if (schema.type !== 'list') fail(`"${op.prop}" is not a list.`);
    const list = (node.props[op.prop] as Array<ListItem>) ?? [];
    const idx = list.findIndex((i) => i.id === op.itemId);
    if (idx < 0) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
    const before = list[idx];
    let next: ListItem;
    let sent: Record<string, unknown>;
    if (op.field) {
      const f = schema.fields[op.field];
      if (!f) fail(`${schema.itemLabel} has no field "${op.field}". Fields: ${Object.keys(schema.fields).join(', ')}.`);
      next = normalizeItem(schema, { ...before, [op.field]: op.value }, state, `${schema.itemLabel}`, { id: before.id } as never, before);
      sent = { [op.field]: op.value };
    } else {
      next = normalizeItem(schema, op.value as Record<string, unknown>, state, schema.itemLabel, before, before);
      sent = op.value && typeof op.value === 'object' && !Array.isArray(op.value) ? (op.value as Record<string, unknown>) : {};
    }
    const followed = followItemLinks(state, def, op, before, next, sent, ctx);
    list[idx] = next;
    node.props[op.prop] = [...list];
    return followed.length ? { followed } : {};
  }
  node.props[op.prop] = normalizeProp(schema, op.value, state, `${def.name} → ${schema.label}`, node.props[op.prop]);
  return {};
}

/**
 * Runs an edit of an instance's property and, when it edits a contact form's fields, settles their submission
 * keys so no answer moves to another key as a side effect (see form-keys.ts).
 */
function keepingFormKeys(state: ProjectState, op: Op<'instance.setProp' | 'instance.listInsert' | 'instance.listRemove' | 'instance.listMove'>, run: () => OpResult): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  if (op.prop !== 'fields' || !namesFormFields(def)) return run();
  const stored = node.props.fields;
  // An instance without its own list shows the definition's; a list bound from outside has no keys to keep.
  const before = clone(stored === undefined ? def.properties.fields.default : Array.isArray(stored) ? stored : []) as FormField[];
  const result = run();
  const after = node.props.fields;
  if (Array.isArray(after)) {
    const cleared = op.type === 'instance.setProp' && op.itemId && op.field === 'name' ? [op.itemId] : [];
    node.props.fields = settleFormKeys(before, after as ListItem[], new Set(cleared), formDefaults(def));
  }
  return result;
}

/** The name and label a form field without its own gets on export. */
function formDefaults(def: ComponentDefinition): { name?: unknown; label?: unknown } {
  const schema = def.properties.fields;
  return schema?.type === 'list' ? { name: schema.fields.name?.default, label: schema.fields.label?.default } : {};
}

function listInsert(state: ProjectState, op: Op<'instance.listInsert'>): OpResult {
  const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
  const list = [...(node.props[op.prop] as Array<{ id: string }>)];
  if (schema.max !== undefined && list.length >= schema.max) fail(`${schema.label} allows at most ${schema.max} items.`);
  // New items start from the schema's field defaults, never from another item's content.
  const item = normalizeItem(schema, op.item, state, schema.itemLabel);
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
  const v = op.value as Record<string, unknown> | null;
  if (v && typeof v === 'object' && 'token' in v) {
    // A reference is exactly { token } naming a style of the same kind.
    const target = effectiveTokens(state).find((t) => t.id === v.token);
    const self = effectiveTokens(state).find((t) => t.id === op.tokenId);
    if (typeof v.token !== 'string' || Object.keys(v).length !== 1) fail('A site style reference must be { "token": "group.name" }.');
    if (target && self && target.group !== self.group) fail(`"${self.label}" can only follow another ${self.group} style.`);
  }
  const r = tokenSetInner(state, op);
  // A custom style has no theme default to return to: its value is its own, not an override.
  const custom = state.tokens.custom.find((t) => t.id === op.tokenId);
  if (custom && Object.hasOwn(state.tokens.overrides, op.tokenId)) {
    custom.value = state.tokens.overrides[op.tokenId];
    delete state.tokens.overrides[op.tokenId];
  }
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
      if (!/^[0-9a-z.,%+\-*/ ()]+$/i.test(s) || !isSafeCssValue(s)) fail(`Invalid ${k} "${s}".`);
    }
    const w = Number(merged.weight);
    if (!Number.isFinite(w) || w < 100 || w > 900) fail('Weight must be between 100 and 900.');
    merged.weight = w;
    const fam = merged.family as unknown;
    if (fam && typeof fam === 'object') {
      const ref = String((fam as { token?: string }).token ?? '');
      if (!ref.startsWith('font.') || !effectiveTokens(state).some((t) => t.id === ref)) fail('A text style font must reference an existing font token.');
    } else if (Object.hasOwn(v as object, 'family')) {
      // Only a family being set now is checked, so an older value never blocks an unrelated change.
      if (!/^[\p{L}\p{N}_\s'",.-]{1,200}$/u.test(String(fam)) || !isSafeCssValue(String(fam))) fail('Font names may contain letters, numbers, spaces, quotes, commas and hyphens only.');
      const font = resolveFontStack(state, String(fam));
      if ('error' in font) fail(font.error);
      merged.family = font.stack;
    }
    if (merged.transform !== undefined && !['none', 'uppercase', 'lowercase', 'capitalize'].includes(String(merged.transform))) fail('Text transform must be none, uppercase, lowercase or capitalize.');
    state.tokens.overrides[op.tokenId] = merged as unknown as TokenValue;
    return {};
  } else if (tdef.group === 'font') {
    const s = String(v);
    if (!/^[\p{L}\p{N}_\s'",.-]+$/u.test(s) || s.length > 200 || !isSafeCssValue(s)) fail('Font stacks may contain names, quotes, commas and hyphens only.');
    const font = resolveFontStack(state, s);
    if ('error' in font) fail(font.error);
    state.tokens.overrides[op.tokenId] = font.stack;
    return {};
  } else {
    const s = String(v);
    if (!/^[0-9a-z.,%+\-*/ ()#]+$/i.test(s) || s.length > 200 || !isSafeCssValue(s)) fail(`Invalid value "${s}".`);
  }
  state.tokens.overrides[op.tokenId] = v as TokenValue;
  return {};
}

function customToken(state: ProjectState, tokenId: string): TokenDef {
  const t = state.tokens.custom.find((x) => x.id === tokenId);
  if (t) return t;
  if (getTheme(state.site.themeId).tokens.some((x) => x.id === tokenId)) fail(`"${tokenId}" belongs to the theme. Only your own site styles can be renamed or removed.`);
  fail(`Token "${tokenId}" does not exist.`);
}

function tokenCreate(state: ProjectState, op: Op<'token.create'>): OpResult {
  if (state.tokens.custom.length >= 200) fail('A project can have at most 200 custom site styles.');
  if (op.value === null || op.value === undefined || op.value === '') fail('A new site style needs a value.');
  if (op.group === 'text') {
    const v = op.value as Record<string, unknown>;
    const missing = ['family', 'size', 'lineHeight', 'weight', 'tracking'].filter((k) => !v || typeof v !== 'object' || v[k] === undefined || v[k] === '');
    if (missing.length) fail(`A text style needs ${missing.join(', ')}.`);
    // Only the text-style keys are kept, so nothing else can change how the style is generated.
    op = { ...op, value: Object.fromEntries(['family', 'size', 'lineHeight', 'weight', 'tracking', 'transform'].filter((k) => v[k] !== undefined).map((k) => [k, v[k]])) };
  }
  // Custom IDs carry a "custom-" step so a later theme token can never take the same name.
  const base = `${op.group}.custom-${slugify(op.label) || 'style'}`;
  const taken = new Set(effectiveTokens(state).map((t) => t.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  const def: TokenDef = { id, label: op.label.trim(), group: op.group, value: op.value as TokenValue };
  if (op.description?.trim()) def.description = op.description.trim();
  state.tokens.custom.push(def);
  // The value passes the same checks as token.set, which keeps it as the style's own value.
  tokenSet(state, { type: 'token.set', tokenId: id, value: op.value });
  return { tokenId: id };
}

/** A token's value with references followed, for turning its uses into explicit values. */
/** Places CSS text names a token's variable: code component sources and literal style or token values. */
function literalTokenUses(state: ProjectState, tokenId: string): string[] {
  const re = new RegExp(`var\\(\\s*${tokenVar(tokenId).replace(/[-]/g, '\\-')}\\s*[,)]`);
  const out = new Set<string>();
  for (const d of Object.values(state.components)) if (d.owner === 'project' && d.kind === 'code' && d.source && re.test(d.source)) out.add(`the source of "${d.name}"`);
  for (const t of allTrees(state)) {
    if (t.owner.kind === 'component' && state.components[t.owner.id]?.owner !== 'project') continue;
    const hit = (rs: unknown) => Object.values((rs ?? {}) as Record<string, Record<string, unknown>>).some((sc) => Object.values(sc ?? {}).some((x) => typeof x === 'string' && re.test(x)));
    for (const n of Object.values(t.tree.nodes)) if (hit(n.styles) || (n.kind === 'instance' && Object.values(n.overrides ?? {}).some(hit))) out.add(t.label);
  }
  for (const [id, v] of [...Object.entries(state.tokens.overrides), ...state.tokens.custom.map((c) => [c.id, c.value] as const)])
    if (id !== tokenId && typeof v === 'string' && re.test(v)) out.add(`the site style "${id}"`);
  return [...out];
}

function resolvedTokenValue(state: ProjectState, tokenId: string): TokenValue | undefined {
  const tokens = effectiveTokens(state);
  let v = tokens.find((t) => t.id === tokenId)?.value;
  const seen = new Set([tokenId]);
  while (v && typeof v === 'object' && 'token' in v) {
    const ref = (v as { token: string }).token;
    if (seen.has(ref)) fail('That site style refers to itself in a loop.');
    seen.add(ref);
    v = tokens.find((t) => t.id === ref)?.value;
  }
  if (v === undefined) fail('That site style refers to a style that does not exist.');
  return v;
}

function tokenRemove(state: ProjectState, op: Op<'token.remove'>): OpResult {
  const t = customToken(state, op.tokenId);
  const uses = tokenUsageCounts(state)[t.id] ?? 0;
  // CSS text (code component sources, literal values) can name the variable; it cannot be rewritten safely.
  const literal = literalTokenUses(state, t.id);
  if (literal.length) fail(`"${t.label}" is written into ${literal.join(', ')}. Change those first.`);
  if (op.replacementTokenId) tokenReplace(state, t.id, op.replacementTokenId);
  else if (uses) {
    if (!op.detach)
      throw new EngineError('VALIDATION_FAILED', `"${t.label}" is used ${uses} time${uses === 1 ? '' : 's'}. Choose a replacement style, or keep its current value where it is used.`, { references: uses });
    if (t.group === 'text') fail('A text style cannot be kept as a plain value. Choose a replacement text style.');
    const literal = resolvedTokenValue(state, t.id);
    forEachTokenRef(state, (id, site) => id === t.id && site.replace(clone(literal)));
  }
  state.tokens.custom = state.tokens.custom.filter((x) => x.id !== t.id);
  delete state.tokens.overrides[t.id];
  return {};
}

function tokenReplace(state: ProjectState, fromId: string, toId: string): OpResult {
  const tokens = effectiveTokens(state);
  const from = tokens.find((t) => t.id === fromId) ?? fail(`Token "${fromId}" does not exist.`);
  const to = tokens.find((t) => t.id === toId) ?? fail(`Token "${toId}" does not exist.`);
  if (from.id === to.id) fail('Choose a different site style to replace it with.');
  if (from.group !== to.group) fail(`"${from.label}" is a ${from.group} style and "${to.label}" is a ${to.group} style; replace it with a ${from.group} style.`);
  let replaced = 0;
  forEachTokenRef(state, (id, site) => {
    if (id !== from.id) return;
    site.replace({ token: to.id });
    replaced++;
  });
  assertNoTokenCycles(state);
  return { replaced };
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
  // Theme-owned definitions are fixed theme data: uses inside them stay on the theme original.
  for (const { node, owner } of instancesOf(state, def.id)) {
    if (owner.kind === 'component' && state.components[owner.id]?.owner !== 'project') continue;
    node.definitionId = copy.id;
  }
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
  if (root.kind === 'slot' || root.kind === 'repeat') fail('Select an element rather than a slot or repeat to create a component.');
  const ownerDef = op.owner.kind === 'component' ? state.components[op.owner.id] : undefined;
  const defTree: NodeTree = { rootIds: [], nodes: {} };
  const properties: Record<string, PropSchema> = {};
  const props: Record<string, unknown> = {};
  const slots: NonNullable<ComponentDefinition['slots']> = {};
  const instSlots: NonNullable<InstanceNode['slots']> = {};
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
  const rootNode = defTree.nodes[rootCopy];
  // A component can be placed many times, so its root cannot hold a page-unique anchor: the placement keeps it.
  const anchor = rootNode.anchor;
  delete rootNode.anchor;
  parts.root = { nodeId: rootCopy, label: root.name ?? 'Root', ...withControls(rootNode) };

  if (ownerDef) {
    // Inside a definition the selection may already show the owner's properties, list item fields and slots.
    // They become properties and slots of the new component, passed straight through by the new instance.
    const outerList = enclosingList(ownerDef, op.nodeId);
    const hoisted = new Map<string, string>();
    const hoist = (b: Binding): Binding => {
      const isProp = '$prop' in b;
      const key = isProp ? `p:${b.$prop}` : `i:${b.$item}`;
      let name = hoisted.get(key);
      if (!name) {
        const src = isProp ? b.$prop : b.$item;
        const schema = isProp ? own(ownerDef.properties, b.$prop) : outerList ? own(outerList.fields, b.$item) : undefined;
        if (!schema) fail(`The selection uses "${src}", which "${ownerDef.name}" does not define.`);
        name = propName(src);
        properties[name] = clone(schema);
        props[name] = clone(b);
        hoisted.set(key, name);
      }
      return { $prop: name };
    };
    const walk = (id: string, innerRepeat: boolean) => {
      const n = defTree.nodes[id];
      if (!n) return;
      // List item fields inside a repeat that is part of the selection still belong to that repeat.
      const fix = <T,>(v: T): T => (isBinding(v) && !('$item' in v && innerRepeat) ? (hoist(v) as T) : v);
      if (n.when) n.when = fix(n.when);
      if (n.unless) n.unless = fix(n.unless);
      if (n.kind === 'text') n.text = fix(n.text);
      else if (n.kind === 'image') {
        n.image = fix(n.image);
        if (n.fallbackAlt !== undefined) n.fallbackAlt = fix(n.fallbackAlt);
      }
      else if (n.kind === 'link') {
        n.link = fix(n.link);
        n.label = fix(n.label);
        n.appearance = fix(n.appearance);
      } else if (n.kind === 'icon') n.icon = fix(n.icon);
      else if (n.kind === 'repeat') n.list = fix(n.list);
      else if (n.kind === 'instance') for (const k of Object.keys(n.props)) n.props[k] = fix(n.props[k]);
      else if (n.kind === 'slot') {
        const decl = own(ownerDef.slots ?? {}, n.slot);
        if (decl && !slots[n.slot]) {
          slots[n.slot] = clone(decl);
          const through: GraphNode = { id: newId('n'), kind: 'slot', slot: n.slot };
          tree.nodes[through.id] = through;
          instSlots[n.slot] = [through.id];
        }
      }
      for (const cl of childLists(n)) cl.ids.forEach((c) => walk(c, innerRepeat || n.kind === 'repeat'));
    };
    walk(rootCopy, false);
  }

  for (const n of Object.values(defTree.nodes)) {
    const part = (name: string) => (parts[name] = { nodeId: n.id, label: titleCase(name), ...withControls(n) });
    if (n.kind === 'text' && !isBinding(n.text)) {
      const isHeading = /^h\d$/.test(n.tag);
      const name = propName(n.rich ? 'body' : isHeading ? 'heading' : 'text');
      properties[name] = n.rich
        ? { type: 'richtext', label: titleCase(name), default: clone(n.text as RichText) }
        : { type: 'string', label: titleCase(name), default: String(n.text), multiline: !isHeading };
      props[name] = clone(n.text);
      n.text = { $prop: name };
      part(name);
    } else if (n.kind === 'image' && !isBinding(n.image)) {
      const name = propName('image');
      properties[name] = { type: 'image', label: titleCase(name), default: clone(n.image) };
      props[name] = clone(n.image);
      n.image = { $prop: name };
      part(name);
    } else if (n.kind === 'link' && (!isBinding(n.label) || !isBinding(n.link))) {
      const name = propName('button');
      if (!isBinding(n.label)) {
        const key = propName(`${name}Label`);
        properties[key] = { type: 'string', label: `${titleCase(name)} label`, default: String(n.label) };
        props[key] = String(n.label);
        n.label = { $prop: key };
      }
      if (!isBinding(n.link)) {
        const key = propName(`${name}Link`);
        properties[key] = { type: 'link', label: `${titleCase(name)} link`, default: clone(n.link) };
        props[key] = clone(n.link);
        n.link = { $prop: key };
      }
      part(name);
    } else if (n.kind === 'icon' && !isBinding(n.icon)) {
      const name = propName('icon');
      properties[name] = { type: 'icon', label: titleCase(name), default: String(n.icon) };
      props[name] = String(n.icon);
      n.icon = { $prop: name };
      part(name);
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
  if (Object.keys(slots).length) def.slots = slots;
  const deps = directDependencies(def);
  if (deps.length) def.dependencies = deps;
  state.components[def.id] = def;
  // Replace the subtree with an instance.
  const inst: InstanceNode = { id: newId('n'), kind: 'instance', definitionId: def.id, props };
  if (anchor) inst.anchor = anchor;
  if (Object.keys(instSlots).length) inst.slots = instSlots;
  const removed = new Set(subtreeIds(tree, op.nodeId));
  if (ownerDef) {
    // The owner's parts and variant rules on the selection's root now target the new instance; those deeper
    // inside move into the new component, so placements must not still be styling them.
    for (const [pid, p] of Object.entries(ownerDef.parts)) {
      if (p.nodeId === op.nodeId) p.nodeId = inst.id;
      else if (removed.has(p.nodeId)) {
        const styled = instancesOf(state, ownerDef.id).filter((u) => u.node.overrides?.[pid]);
        if (styled.length) fail(`"${p.label}" has its own styles in ${styled.length} placement${styled.length === 1 ? '' : 's'}. Reset them first, or create the component from a different element.`);
        delete ownerDef.parts[pid];
      }
    }
    for (const { option: v } of variantOptions(ownerDef)) {
      if (!v.styles) continue;
      // Variant rules inside the selection would need the new component to know the owner's variant.
      const inner = Object.keys(v.styles).filter((nid) => nid !== op.nodeId && removed.has(nid));
      if (inner.length) fail(`The "${v.label}" variant styles elements inside the selection. Remove those variant styles first, or create the component from a different element.`);
      if (v.styles[op.nodeId]) v.styles[inst.id] = v.styles[op.nodeId];
      delete v.styles[op.nodeId];
    }
  }
  for (const id of removed) delete tree.nodes[id];
  tree.nodes[inst.id] = inst;
  info.list.splice(info.index, 1, inst.id);
  return { definitionId: def.id, nodeId: inst.id };
}

/** The style controls a part offers: only those that do something on its kind of node. */
function withControls(node: GraphNode): { styleControls?: string[] } {
  const controls = styleSetFor(node);
  return controls ? { styleControls: controls } : {};
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
  // Generate as if the file already lives at its final path under its own ID, so relative imports resolve and
  // the markup and its <style> block use the new component's class names: the code no longer depends on the
  // original definition's stylesheet.
  const source = generateStandaloneComponent(state, { ...clone(def), id: newId, kind: 'code', sourcePath }).replace(
    /^<!-- Generated by[^\n]*\n/,
    `<!-- Code component converted from "${def.name}". Edit freely; declared properties stay editable in SiteOrigin Builder. -->\n`
  );
  const deps = [...new Set([...(def.dependencies ?? []), ...directDependencies(def)])].sort();
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
  // Parts keep their node IDs: the converted source keeps each part's class and so_o hook, so existing
  // placement overrides still reach the same elements.
  // Variant styles now live in the source; the variant names remain the component's contract.
  if (copy.variantAxes) copy.variantAxes = Object.fromEntries(Object.entries(copy.variantAxes).map(([axis, a]) => [axis, { ...a, options: Object.fromEntries(Object.entries(a.options).map(([k, v]) => [k, { label: v.label }])) }]));
  if (deps.length) copy.dependencies = deps;
  else delete copy.dependencies;
  state.components[copy.id] = copy;
  node.definitionId = copy.id;
  return { definitionId: copy.id, sourcePath: copy.sourcePath };
}

function createCode(state: ProjectState, op: Op<'component.createCode'>): OpResult {
  const properties = normalizeProperties(op.properties, state);
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
    conflicts.push(...contractConflicts(state, def, next));
    mapping.set(def.id, next);
  }
  if (conflicts.length) throw new EngineError('CONFLICT', `${theme.name} is not compatible with this project: ${conflicts.join(' ')}`, { conflicts });
  const install = (next: ComponentDefinition) => {
    const existing = own(state.components, next.id);
    if (existing?.owner === 'project') fail(`"${next.id}" is already a project component.`);
    // A definition kept for a project component must not change under it.
    if (existing && definitionHash(existing) !== definitionHash(next) && (instancesOf(state, next.id).length || dependentsOf(state, next.id).length))
      throw new EngineError('CONFLICT', `${theme.name} has a different "${next.name}" than the one your components use.`);
    state.components[next.id] = clone(next);
    state.themeLock.components[next.id] = { componentId: next.componentId, version: theme.version, hash: definitionHash(next) };
    for (const dep of next.dependencies ?? []) {
      const d = theme.components.find((c) => c.id === dep) ?? fail(`${theme.name} is missing "${dep}", which "${next.name}" needs.`);
      if (!own(state.components, d.id) || definitionHash(state.components[d.id]) !== definitionHash(d)) install(d);
    }
  };
  for (const next of mapping.values()) install(next);
  // Only pages and the shared shell move to the new theme. Project components keep their pinned theme
  // dependencies, and theme definitions retained for them stay exactly as they were.
  for (const t of allTrees(state)) {
    if (t.owner.kind === 'component') continue;
    for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance' && mapping.has(n.definitionId)) n.definitionId = mapping.get(n.definitionId)!.id;
  }
  // Old theme definitions are dropped once nothing places or needs them, repeating until the set is stable
  // because dropping one can free the definitions it placed.
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const oldId of mapping.keys()) {
      const old = state.components[oldId];
      if (!old || old.owner !== 'theme' || mapping.get(oldId)!.id === oldId) continue;
      if (instancesOf(state, oldId).length || dependentsOf(state, oldId).length) continue;
      delete state.components[oldId];
      delete state.themeLock.components[oldId];
      dropped = true;
    }
  }
  state.site.themeId = theme.id;
  state.themeLock.theme = { id: theme.id, version: theme.version };
  return { rebound: mapping.size };
}

export function applyOperations(state: ProjectState, ops: EditOperation[], ctx: ApplyContext = {}): { state: ProjectState; results: OpResult[] } {
  const draft = clone(state);
  const results: OpResult[] = [];
  const batch: ApplyContext = { ...ctx, explicitItemFields: explicitItemFields(ops) };
  for (const [i, op] of ops.entries()) {
    try {
      results.push(applyOperation(draft, op, batch));
    } catch (e) {
      if (e instanceof EngineError) {
        e.message = ops.length > 1 ? `Operation ${i + 1} (${op.type}): ${e.message}` : e.message;
      }
      throw e;
    }
  }
  // A theme update changes no project component, not even this derived field.
  if (ops.every((op) => op.type === 'theme.refresh')) return { state: draft, results };
  // A managed project component's dependencies are the components its tree places: keep them current.
  for (const d of Object.values(draft.components)) {
    if (d.owner !== 'project' || d.kind !== 'managed' || !d.tree) continue;
    const deps = directDependencies(d);
    if (JSON.stringify(deps) === JSON.stringify(d.dependencies ?? [])) continue;
    if (deps.length) d.dependencies = deps;
    else delete d.dependencies;
  }
  return { state: draft, results };
}
