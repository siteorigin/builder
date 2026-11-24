import { propBindingSchema, withProp } from '@shared/bindings';
import type {
  AltReview,
  AssetRecord,
  ComponentDefinition,
  GraphNode,
  ImageValue,
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
  TokenGroup,
  TokenValue,
  RichSpan,
  RichText,
  VariantAxis
} from '@shared/types';
import type { Binding } from '@shared/types';
import { APPEAR_PRESETS, ELEMENT_ACTIONS, ICON_POSITIONS, SCHEMA_VERSION, conditionRef, isAppearPreset, isBinding, isBindingRef, isComparison, slotChildren, type AppearPreset, type ElementAction, type ElementTag, type IconPosition, type TextTag } from '@shared/types';
import { propertiesHash, type EditOperation, type Op } from '@shared/ops';
import { STYLE_PROP_MAP, isSafeCssValue, isTokenLength, linkOf, partStyleControls, styleSetFor, textStyleValue, textWeight, tokenVar, validateStyleValue } from '@shared/styles';
import { normalizeRoute, slugify, suggestRoute, validateRoute } from '@shared/routes';
import { planRouteMove, routeFolder, type RouteMove } from '@shared/page-tree';
import { VISITOR_TEXT_KEYS, isVisitorTextKey, ownVisitorText, ownVisitorTextFor, visitorTextLanguage } from '@shared/visitor-text';
import { LANGUAGE_CODE_ERROR, isLanguageCode, linkedGroup, siteLanguageProblem, translationClash, translationClashMessage, translationGroup, translationMembers } from '@shared/languages';
import { newId } from '@shared/ids';
import { checkPublicUrl } from '@shared/public-url';
import { ARTICLE_ROW_FIELDS, isArticleDate, pageArticle, todayArticleDate } from '@shared/articles';
import { collectionRouteOwner } from '@shared/collections';
import { collectionCreate, collectionRemove, collectionUpdate, entryCreate, entryRemove, entryReorder, entryUpdate } from './collections';
import { isListBlock, toRichText } from '@shared/richtext';
import { axesOf, findVariant, variantOptions } from '@shared/variants';
import { teaserFields } from '@shared/page-teasers';
import { dropFontFamily, familyUses, fontAssetUsages, isValidFontAsset, projectFontFamilies, renameFontFamily, sameFontFamily, siteChoosesFamily, stackLeadsWith, withoutFamily } from '@shared/fonts';
import { documentFormat, isDocumentMime } from '@shared/document-files';
import { catalogueComponent, getTheme, listThemes, themeLockEntry } from '@catalogue/index';
import { resolveFontStack } from '@catalogue/fonts';
import { codeTakesBlocks, effectiveTokens, generateStandaloneComponent, CUSTOM_DIR } from '@generator/index';
import { slotsInsideCards } from '@generator/card-links';
import { chosenUses, imageUses } from './image-uses';
import { NO_SHELL_IDS, labelKeyFor, pageIds } from '@generator/checks';
import { pageLinkUses, type PageLinkUse } from './page-links';
import { batchTagProblem, insertsInline, tagKindProblem } from './semantic-tags';
import { EngineError, RESERVED_ANCHORS, anchorCapable, anchorsInUse, childLists, codePlacesClass, displayName, enclosingRepeatProp, fail, findParent, getNode, getTree, headerMenu, headerMenuSlot, instancesOf, itemLinkPairs, settledRoot, subtreeIds, allTrees } from './tree';
import { itemStyleRecords, liveItemStyles, placementItems, repeatedPartList } from '@shared/item-styles';
import { followText, joinedLines } from '@shared/contact-links';
import { clone, definitionHash, freshListIds, installComponent, makeInstance, placedItemId, placedItemIndex } from './install';
import { normalizeImage, normalizeItem, normalizeLink, normalizeProp, normalizeRichText, storedAlt } from './values';
import { editTable } from './table';
import { acceptedTypes, bindingProblem, bindingSlots, boundSchema, checkPropName, enclosingList, isProtoKey, normalizeProperties, usesState } from './schema';
import { declaredTokens, findTokenCycle, forEachTokenRef, tokenPropUsageCounts, tokenUsageCounts } from './tokens';
import { slotDecl, slotFill, slotLandingProblem } from './slots';
import { formDefaults, settleFormKeys } from './form-keys';
import { namesFormFields, type FormField } from '@catalogue/foundation/form';
import {
  componentRemove,
  codeImports,
  dependentsOf,
  directDependencies,
  dropPartOverrides,
  nodeSetBinding,
  nodeSetStateAction,
  removePart,
  removePropSchema,
  setPropDefault,
  removeSlot,
  removeState,
  removeVariant,
  replaceProperties,
  setPart,
  setPropSchema,
  setSlot,
  setState,
  setVariant,
  uniqueCopyName
} from './definitions';
import { contractConflicts, hiddenSlotContent, themeRefresh } from './theme-updates';
import { detachInstance } from './detach';

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
  /** The copied subtrees; its roots are the copied nodes (siblings, when several were copied together), in page order. */
  tree: NodeTree;
  /** Placed components: name, and the property schema and slots the copied content was written for. */
  components: Record<string, { name: string; contract: string }>;
  pages: Record<string, string>;
  assets: Record<string, string>;
  /** Library documents its links go to, by name. */
  documents?: Record<string, string>;
}

/** State an operation can read that is not part of the project: what the editor has recently copied. */
export interface ApplyContext {
  clipboards?: readonly Clipboard[];
  /** List item fields the batch sets itself (see explicitItemFields). applyOperations fills it. */
  explicitItemFields?: ReadonlySet<string>;
  /**
   * The batch's asset use counts (assetUsages), shared by a run of removals so a bulk cleanup walks the site once.
   * Deleting an image record changes no count; any other edit may, so applyOperations forgets the counts before
   * every operation that is not a removal, and a font removal forgets them after it. The counts are kept only for
   * the draft they were made from. applyOperations fills it.
   */
  assetUses?: { state?: ProjectState; counts?: Record<string, number> };
  /**
   * The addresses in use when the batch began, lowercased: page routes and old addresses kept working. A page moved
   * from an address outside it only passed through (a swap through a spare address, a parent moved before its
   * child), was never served there, and keeps nothing at it. applyOperations fills it.
   */
  addressesAtStart?: ReadonlySet<string>;
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
      return pageUpdate(state, op, ctx);
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
      return pageSetHome(state, op.pageId, op.keepOldAddress !== false, ctx.addressesAtStart);
    case 'node.insert':
      return nodeInsert(state, op);
    case 'node.remove': {
      const tree = editableTree(state, op.owner);
      const settled = settledRoot(tree);
      if (op.owner.kind === 'component' && settled && tree.rootIds[0] === op.nodeId) fail(ROOT_IS_COMPONENT('removed'));
      const removed = new Set(subtreeIds(tree, op.nodeId));
      removeNode(tree, op.nodeId);
      if (op.owner.kind === 'component' && !settled) followRoot(state.components[op.owner.id]);
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
    case 'node.setStateAction':
      return nodeSetStateAction(state, op);
    case 'instance.setProp':
      return keepingFormKeys(state, op, () => instanceSetProp(state, op, ctx));
    case 'instance.listInsert':
      return keepingFormKeys(state, op, () => listInsert(state, op));
    case 'instance.listRemove':
      return keepingFormKeys(state, op, () => {
        const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
        const list = (node.props[op.prop] as ListItem[]) ?? [];
        const at = placedItemIndex(list, op.owner, node.id, op.itemId);
        if (at < 0) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
        if (schema.min !== undefined && list.length <= schema.min) fail(`${schema.label} needs at least ${schema.min} items.`);
        node.props[op.prop] = list.filter((_, i) => i !== at);
        return {};
      });
    case 'instance.listMove':
      return keepingFormKeys(state, op, () => {
        const { node, schema } = listTarget(state, op.owner, op.nodeId, op.prop);
        const list = [...((node.props[op.prop] as ListItem[]) ?? [])];
        const from = placedItemIndex(list, op.owner, node.id, op.itemId);
        if (from < 0) fail(`Item "${op.itemId}" not found in ${schema.label}.`);
        const [it] = list.splice(from, 1);
        list.splice(Math.min(op.index, list.length), 0, it);
        node.props[op.prop] = list;
        return {};
      });
    case 'instance.editTable':
      return tableEdit(state, op);
    case 'instance.setVariant': {
      const { node, def } = instanceTarget(state, op.owner, op.nodeId);
      const found = variantOption(def, op.variant, op.axis);
      // A choice the design passes down from the enclosing component's property is not replaced by a fixed one.
      const chosen = node.variants && Object.hasOwn(node.variants, found.axis) ? node.variants[found.axis] : undefined;
      refuseBound(state, op.owner, chosen, def.variantAxes?.[found.axis]?.label ?? found.axis);
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
    case 'component.detachInstance':
      return detachInstance(state, op, (tree, id) => copySubtree(tree, tree, id, state));
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
      if (op.renames?.length && !op.properties) fail('renames needs the whole new schema in properties.');
      // A whole schema edited from an older one (undo or an outside edit landed meanwhile) would silently replace the newer.
      if (op.expectedPropertiesHash !== undefined && op.expectedPropertiesHash !== propertiesHash(def.properties))
        throw new EngineError('CONFLICT', `The properties of "${def.name}" changed since they were opened. Review them again before saving.`);
      if (op.properties) replaceProperties(state, def, op.properties, op.renames);
      def.source = op.source;
      return { hash: sourceHash(op.source) };
    }
    case 'component.remove':
      return componentRemove(state, op);
    case 'component.setPropSchema':
      return setPropSchema(state, op);
    case 'component.removePropSchema':
      return removePropSchema(state, op);
    case 'component.setPropDefault':
      return setPropDefault(state, op);
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
    case 'component.setState':
      return setState(state, op);
    case 'component.removeState':
      return removeState(state, op);
    case 'theme.apply':
      return themeApply(state, op.themeId);
    case 'theme.refresh':
      return themeRefresh(state, op);
    case 'asset.add': {
      if (state.assets.assets[op.asset.id]) fail(`Asset "${op.asset.id}" already exists.`);
      if (op.asset.kind === 'document' ? !isDocumentFile(op.asset.file, op.asset.mime) : isDocumentMime(op.asset.mime) || !!documentFormat(op.asset.file)) fail(`"${op.asset.name}" is not ${op.asset.kind === 'document' ? 'a document the library takes' : `an ${op.asset.kind}`}.`);
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
    case 'collection.create':
      return collectionCreate(state, op);
    case 'collection.update':
      return collectionUpdate(state, op);
    case 'collection.remove':
      return collectionRemove(state, op);
    case 'entry.create':
      return entryCreate(state, op);
    case 'entry.update':
      return entryUpdate(state, op);
    case 'entry.reorder':
      return entryReorder(state, op);
    case 'entry.remove':
      return entryRemove(state, op);
    case 'asset.remove': {
      const removing = own(state.assets.assets, op.assetId);
      if (!removing) fail(`Asset "${op.assetId}" does not exist.`);
      if (removing!.kind === 'font' && isValidFontAsset(removing!)) {
        removeUsedFontFace(state, op.assetId, removing!, op.fontUses);
        delete state.assets.assets[op.assetId];
        if (ctx.assetUses) ctx.assetUses.counts = undefined;
        return {};
      }
      const uses = batchAssetUsages(state, ctx)[op.assetId] ?? 0;
      const times = `${uses} time${uses === 1 ? '' : 's'}`;
      if (uses && removing!.kind === 'document') fail(`This document is linked ${times}. Point those links somewhere else first, or give the document a new file instead.`);
      if (uses) fail(`This ${removing!.kind === 'font' ? 'font' : 'image'} is used ${times}. Replace or remove those uses first.`);
      delete state.assets.assets[op.assetId];
      // Fonts are counted by family, from the records themselves: count again once one has gone.
      if (removing!.kind === 'font' && ctx.assetUses) ctx.assetUses.counts = undefined;
      return {};
    }
    case 'asset.replace': {
      if (!own(state.assets.assets, op.assetId) || !own(state.assets.assets, op.withAssetId)) fail('Both assets must exist.');
      const kind = state.assets.assets[op.assetId].kind;
      if (kind === 'document') {
        if (state.assets.assets[op.withAssetId].kind !== 'document') fail('Only a document can replace a document.');
        if (op.uses) fail('A document is replaced in every place it is linked from.');
        // Every link to the document goes to the other one instead.
        walkValues(state, (v) => {
          if (isDocumentLink(v) && v.target === op.assetId) v.target = op.withAssetId;
        });
        return {};
      }
      if (kind !== 'image' || state.assets.assets[op.withAssetId].kind !== 'image') fail('Only an image can replace an image.');
      // Every use, or only the ones chosen: all of those must still show the image, or nothing is replaced.
      let uses = imageUses(state, op.assetId);
      if (op.uses) {
        const chosen = chosenUses(uses, op.uses);
        if ('error' in chosen) fail(`${chosen.error} Nothing was replaced: choose the places again.`);
        uses = chosen.uses;
      }
      if (op.assetId === op.withAssetId) return { altReview: [] };
      // A use that still has the old image's suggested description takes the new one's; a decorative use stays as it
      // is; a description of the use's own is kept, for the author to check against the new picture. A copy of the
      // same picture (`keepAlt`) leaves every description as it is.
      const was = state.assets.assets[op.assetId].altSuggestion?.trim() ?? '';
      const now = state.assets.assets[op.withAssetId].altSuggestion?.trim() ?? '';
      const altReview: AltReview[] = [];
      for (const u of uses) {
        const t = u.target;
        if (!u.value) {
          if (t?.kind === 'pageSharing') state.pages[t.pageId].seo.socialImage = op.withAssetId;
          else if (t?.kind === 'site') state.site[t.field] = op.withAssetId;
          continue;
        }
        const v = u.value;
        v.assetId = op.withAssetId;
        if (op.keepAlt || v.decorative) continue;
        const alt = typeof v.alt === 'string' ? v.alt.trim() : '';
        if (alt === was) v.alt = now;
        // A use left with no description at all is listed too, however it came to have none.
        if (!(alt === was ? now : alt)) altReview.push({ ...u.place, reason: 'missing', alt: typeof v.alt === 'string' ? v.alt : '' });
        else if (alt !== was && alt !== now) altReview.push({ ...u.place, reason: 'custom', alt: v.alt });
      }
      // Collections' uses have no place a replacement can name yet, so they change only with every other use: each
      // entry's featured image, and their picture fields' defaults and each entry's value. A description that was the
      // old image's suggestion follows the new one, as above; entries have no place in the review list yet.
      if (!op.uses) {
        for (const e of collectionEntries(state)) if (e.featuredImage === op.assetId) e.featuredImage = op.withAssetId;
        for (const v of collectionImageValues(state, op.assetId)) {
          v.assetId = op.withAssetId;
          if (!op.keepAlt && !v.decorative && (typeof v.alt === 'string' ? v.alt.trim() : '') === was) v.alt = now;
        }
      }
      return { altReview };
    }
    case 'asset.relink': {
      const a = own(state.assets.assets, op.assetId) ?? fail(`Asset "${op.assetId}" does not exist.`);
      if (a.kind === 'document') {
        // A document's new file is any document the library takes; it has no picture details.
        if (!isDocumentFile(op.file, op.mime) || op.width !== undefined || op.height !== undefined || op.variants?.length) fail(`The new file for "${a.name}" is not a document the library takes.`);
      } else if (a.kind !== 'image' || !op.mime.startsWith('image/') || documentFormat(op.file)) fail(`"${a.name}" is not an image.`);
      a.file = op.file;
      a.mime = op.mime;
      a.bytes = op.bytes;
      a.hash = op.hash;
      // Details the new file does not have are dropped, never left over from the old one.
      for (const k of ['width', 'height', 'variants', 'originalName'] as const) delete a[k];
      if (op.width !== undefined) a.width = op.width;
      if (op.height !== undefined) a.height = op.height;
      if (op.variants?.length) a.variants = clone(op.variants);
      if (a.kind === 'document' && op.originalName) a.originalName = op.originalName;
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

/** A computed list's items are pages of the site: they change with those pages, never one at a time here. */
function refuseFeed(schema: PropSchema) {
  if (schema.type !== 'list' || !schema.feed) return;
  const what = schema.feed === 'articles' ? 'the site’s dated articles, newest first' : 'the page it is on';
  fail(`${schema.label} shows ${what} and changes with them. Edit the article’s title, date, byline or excerpt in its page settings, or hide it from news lists there.`);
}

/**
 * A nested component's property that its design fills in, from the enclosing component's own property or from each
 * item of a list the design repeats, takes no value of its own: writing one would drop that link without a word.
 */
function refuseBound(state: ProjectState, owner: OwnerRef, value: unknown, label: string) {
  if (!isBinding(value)) return;
  if ('$item' in value) fail(`${label} is filled in from each item of the list the design repeats. Edit those items, or unbind it in the design first.`);
  const parent = owner.kind === 'component' ? state.components[owner.id] : undefined;
  const from = parent && Object.hasOwn(parent.properties, value.$prop) ? parent.properties[value.$prop].label : value.$prop;
  fail(`${label} comes from the enclosing component's "${from}" property. Change it there, or unbind it in the design first.`);
}

function listTarget(state: ProjectState, owner: OwnerRef, nodeId: string, prop: string) {
  const { node, def } = instanceTarget(state, owner, nodeId);
  const schema = def.properties[prop];
  if (!schema) fail(`"${def.name}" has no property "${prop}".`);
  if (schema.type !== 'list') fail(`"${prop}" is not a list property.`);
  refuseFeed(schema);
  refuseBound(state, owner, node.props[prop], schema.label);
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
  for (const c of Object.values(state.collections ?? {})) {
    // A custom field's default, and each entry's value of a picture field: only those hold a picture.
    const pictures = Object.entries(c.settings.fields ?? {}).filter(([, f]) => f?.type === 'image');
    for (const [, f] of pictures) walk(f.default);
    for (const e of Object.values(c.entries)) {
      for (const [name] of pictures) if (Object.hasOwn(e.values ?? {}, name)) walk(e.values[name]);
      walk(e.body);
    }
  }
}

/** Every entry of every collection. */
const collectionEntries = (state: ProjectState) => Object.values(state.collections ?? {}).flatMap((c) => Object.values(c.entries));

/** The picture values of collections' image fields showing `assetId`: each field's default and each entry's value. */
function collectionImageValues(state: ProjectState, assetId: string): ImageValue[] {
  const out: ImageValue[] = [];
  const pick = (v: unknown) => {
    if (v && typeof v === 'object' && (v as ImageValue).assetId === assetId) out.push(v as ImageValue);
  };
  for (const c of Object.values(state.collections ?? {}))
    for (const [name, f] of Object.entries(c.settings.fields ?? {})) {
      if (f?.type !== 'image') continue;
      pick(f.default);
      for (const e of Object.values(c.entries)) if (Object.hasOwn(e.values ?? {}, name)) pick(e.values[name]);
    }
  return out;
}

/** A stored link to a library document (see LinkValue). */
export function isDocumentLink(v: unknown): v is LinkValue & { type: 'document' } {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'document' && typeof (v as { target?: unknown }).target === 'string';
}

/** Whether a file is one of the document formats, its name and MIME type agreeing. */
const isDocumentFile = (file: string, mime: string) => isDocumentMime(mime) && documentFormat(file)?.mime === mime;

export function assetUsages(state: ProjectState): Record<string, number> {
  const out: Record<string, number> = {};
  walkValues(state, (v) => {
    const id = (v as { assetId?: unknown }).assetId;
    if (typeof id === 'string') out[id] = (out[id] ?? 0) + 1;
    // A document is in use while a link goes to it.
    if (isDocumentLink(v)) out[v.target] = (out[v.target] ?? 0) + 1;
  });
  for (const k of [state.site.favicon, state.site.socialImage]) if (k) out[k] = (out[k] ?? 0) + 1;
  for (const p of Object.values(state.pages)) if (p.seo.socialImage) out[p.seo.socialImage] = (out[p.seo.socialImage] ?? 0) + 1;
  for (const e of collectionEntries(state)) if (typeof e.featuredImage === 'string' && e.featuredImage) out[e.featuredImage] = (out[e.featuredImage] ?? 0) + 1;
  // An imported font is in use while a token or style names its family.
  for (const [id, n] of Object.entries(fontAssetUsages(state, themeFontTokens(state)))) out[id] = (out[id] ?? 0) + n;
  return out;
}

/**
 * Settle the uses of a font file's family before the file goes. Any file of a family the site uses changes how
 * some text is drawn (a lone italic left to draw upright text, a Cyrillic file whose letters fall back), so it only
 * goes with the author's choice for those uses, made after seeing what changes: keep the family on its other
 * files, fall back (the family leaves every style), or put another font in its place.
 */
function removeUsedFontFace(state: ProjectState, assetId: string, removing: AssetRecord, choice: Extract<EditOperation, { type: 'asset.remove' }>['fontUses']) {
  const family = removing.font!.family;
  const fontTokens = themeFontTokens(state);
  const uses = familyUses(state, family, fontTokens).length;
  if (!uses) return;
  const times = `${uses} time${uses === 1 ? '' : 's'}`;
  const others = Object.entries(state.assets.assets).some(([k, x]) => k !== assetId && sameFontFamily(x, removing));
  if (!choice)
    fail(
      `This font is used ${times}. ${others ? `Text drawn with this file of ${family} would be drawn with another of its files, or a fallback font. ` : ''}Replace or remove those uses first, or remove the file in Assets, which shows what changes.`
    );
  if (choice === 'keep') {
    if (!others) fail(`This font is used ${times}, and it is the last file of ${family}. Choose another font for its uses, or let them fall back.`);
    return;
  }
  if (choice === 'fallback') return dropFontFamily(state, family, null, fontTokens);
  const stack = choice!.replaceWith;
  if (!/^[\p{L}\p{N}_\s'",.-]+$/u.test(stack) || !isSafeCssValue(stack) || stack.split(',').some((part) => !part.trim())) fail('Font stacks may contain names, quotes, commas and hyphens only.');
  const font = resolveFontStack(state, stack);
  if ('error' in font) fail(font.error);
  if (stackLeadsWith(font.stack, family)) fail(`Choose a font other than ${family} to put in its place.`);
  // A font that lists this family as a backup (a theme's own copy of it) keeps the rest of its stack.
  const rest = withoutFamily(font.stack, family);
  if (!rest) fail(`Choose a font other than ${family} to put in its place.`);
  dropFontFamily(state, family, rest, fontTokens);
}

/** The theme's font tokens, which may be named other than font.*: a site's choice in one is a use of its family. */
const themeFontTokens = (state: ProjectState) => new Set(getTheme(state.site.themeId).tokens.filter((t) => t.group === 'font').map((t) => t.id));

/** assetUsages, kept for the rest of a run of removals when the batch holds the counts (ApplyContext.assetUses). */
function batchAssetUsages(state: ProjectState, ctx: ApplyContext): Record<string, number> {
  const held = ctx.assetUses;
  if (!held) return assetUsages(state);
  if (!held.counts || held.state !== state) Object.assign(held, { state, counts: assetUsages(state) });
  return held.counts!;
}

/** How many links from the rest of the site go to a page: the links deleting it would move to a replacement (page lists' cards for it go with it). */
export function pageLinkReferences(state: ProjectState, pageId: string): number {
  return pageLinkUses(state, pageId).filter((u) => !u.card).length;
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
  if (routeTaken(state, route, forPageId) || collectionRouteOwner(state, route)) return true;
  const i = redirectIndex(state, route);
  return i >= 0 && state.site.redirects![i].pageId !== forPageId;
}

/**
 * The route a page titled `title` gets automatically: its slug (made valid when it is a reserved name), with a
 * numbered suffix when it is taken, kept within the 60-character segment limit. The Pages panel previews new
 * pages' routes the same way.
 */
function autoRoute(state: ProjectState, title: string, fallback: string, forPageId?: string, folder = '/'): string {
  return suggestRoute(title, (r) => routeReserved(state, r, forPageId), fallback, folder).route;
}

/** Refuses an address a collection or one of its entries holds: a page can never take it over. */
function refuseCollectionRoute(state: ProjectState, route: string) {
  const owner = collectionRouteOwner(state, route);
  if (owner) fail(`${route} is the address of ${owner.label}. Choose another address for the page.`);
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
    refuseCollectionRoute(state, route);
  } else route = autoRoute(state, op.title, 'page');
  if (op.pageId && Object.hasOwn(state.pages, op.pageId)) fail(`Page "${op.pageId}" already exists.`);
  claimRoute(state, route);
  const id = op.pageId ?? newId('pg');
  const page: PageDoc = { schemaVersion: SCHEMA_VERSION, id, title: op.title.trim(), route, seo: {}, showHeader: true, showFooter: true, rootIds: [], nodes: {} };
  if (op.starter === 'intro') {
    const defId = installComponent(state, 'intro.page');
    const intro = makeInstance(state.components[defId], { eyebrow: '', heading: op.title.trim(), lead: '' });
    page.nodes[intro.id] = intro;
    page.rootIds.push(intro.id);
  }
  if (op.starter === 'article') {
    // The header shows the page's own title, date, byline and excerpt; the text section below is the body. A theme
    // without one of them makes the article without it.
    const has = (id: string) => !!catalogueComponent(state.site.themeId, id);
    const header = has('content.article') ? makeInstance(state.components[installComponent(state, 'content.article')], { eyebrow: '' }) : null;
    const body = has('content.text') ? makeInstance(state.components[installComponent(state, 'content.text')], { heading: '', body: toRichText(['Write the article here.']) }) : null;
    for (const n of [header, body]) {
      if (!n) continue;
      page.nodes[n.id] = n;
      page.rootIds.push(n.id);
    }
  }
  // An article is dated when it is made: the date given, or today for the article starter.
  const articleDate = op.articleDate ?? (op.starter === 'article' ? todayArticleDate() : undefined);
  applyArticle(page, { articleDate, byline: op.byline, excerpt: op.excerpt, newsHidden: op.newsHidden });
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
  // A page inside another goes under the link to that page, when the menu has one and groups links.
  const slot = headerMenuSlot(state, list, page.id);
  const item = normalizeItem(schema, { label: page.navLabel || page.title, link: { type: 'page', target: page.id }, ...(slot.sub ? { sub: true } : {}) }, state, schema.label);
  node.props.links = [...list.slice(0, slot.index), item, ...list.slice(slot.index)];
  return true;
}

function pageUpdate(state: ProjectState, op: Op<'page.update'>, ctx: ApplyContext = {}): OpResult {
  const page = own(state.pages, op.pageId) ?? fail(`Page "${op.pageId}" does not exist.`);
  let moved: RouteMove[] | undefined;
  if (op.title !== undefined) page.title = op.title.trim();
  if (op.route !== undefined) {
    const route = normalizeRoute(op.route);
    const err = validateRoute(route);
    if (err) fail(err);
    if (page.id === state.site.homePageId && route !== '/') fail('The Home page always uses "/". Make another page Home first.');
    if (page.id !== state.site.homePageId && route === '/') fail('Only the Home page can use "/".');
    // The pages inside it move with it, and every address left behind keeps working for its page.
    const plan = planRouteMove(state, page.id, route, validateRoute);
    if ('error' in plan) fail(plan.error);
    refuseCollectionRoute(state, route);
    // No page moved along with it may land on an address a collection or one of its entries holds either.
    for (const m of plan.moves) {
      if (m.pageId === page.id) continue;
      const owner = collectionRouteOwner(state, m.to);
      if (owner) fail(`Moving “${page.title}” would move “${state.pages[m.pageId].title}” to ${m.to}, which is the address of ${owner.label}. Choose another address for the page.`);
    }
    movePages(state, plan.moves, ctx.addressesAtStart);
    if (plan.moves.length > 1) moved = plan.moves;
  }
  if (op.navLabel !== undefined) page.navLabel = op.navLabel || undefined;
  if (op.seoTitle !== undefined) page.seo.title = op.seoTitle || undefined;
  if (op.description !== undefined) page.seo.description = op.description || undefined;
  if (op.noindex !== undefined) page.seo.noindex = op.noindex || undefined;
  if (op.searchHidden !== undefined) page.seo.searchHidden = op.searchHidden || undefined;
  if (op.draft !== undefined) {
    if (op.draft && page.id === state.site.homePageId) fail('The Home page cannot be a draft. Make another page Home first.');
    if (op.draft) page.draft = true;
    else delete page.draft;
  }
  if (op.showHeader !== undefined) page.showHeader = op.showHeader;
  if (op.showFooter !== undefined) page.showFooter = op.showFooter;
  if (op.language !== undefined) {
    const language = op.language.trim();
    if (language && !isLanguageCode(language)) fail(LANGUAGE_CODE_ERROR);
    if (language) page.language = language;
    else delete page.language;
  }
  if (op.linkTranslationTo !== undefined) {
    if (op.linkTranslationTo === null) leaveTranslations(state, page);
    else linkTranslation(state, page, op.linkTranslationTo);
  }
  // The language and the link are checked together, so one edit can both set a copy's language and link it.
  if (op.language !== undefined || op.linkTranslationTo) {
    const group = translationGroup(page);
    const clash = group ? translationClash(state, group) : null;
    if (clash) fail(translationClashMessage(clash));
  }
  if (op.socialImage !== undefined) {
    if (op.socialImage && own(state.assets.assets, op.socialImage)?.kind !== 'image') fail('Social image asset not found.');
    if (op.socialImage) page.seo.socialImage = op.socialImage;
    else delete page.seo.socialImage;
  }
  applyArticle(page, op);
  return moved ? { route: page.route, moved } : { route: page.route };
}

/**
 * Give pages the addresses `moves` plans. Each takes over any old address kept at its new one, and each address
 * a page left that no page now uses is kept working for it, so old links and bookmarks still arrive (a page moved
 * again keeps every earlier address leading to where it is now, because kept addresses name the page).
 */
function movePages(state: ProjectState, moves: RouteMove[], atStart?: ReadonlySet<string>) {
  for (const m of moves) state.pages[m.pageId].route = m.to;
  for (const m of moves) claimRoute(state, m.to);
  const used = new Set(Object.values(state.pages).map((p) => p.route.toLowerCase()));
  // Not an address the page only passed through in this batch, nor one that is not a valid route (a hand-written
  // one), which could not be kept working.
  const keep = (m: RouteMove) => !used.has(m.from.toLowerCase()) && redirectIndex(state, m.from) < 0 && (!atStart || atStart.has(m.from.toLowerCase())) && !validateRoute(m.from);
  const kept = moves.filter(keep).map((m) => ({ from: m.from, pageId: m.pageId }));
  if (kept.length) state.site.redirects = [...(Array.isArray(state.site.redirects) ? state.site.redirects : []), ...kept];
}

/** Make two pages versions of each other: one joins the other's translations, or the two start a set of their own. */
function linkTranslation(state: ProjectState, page: PageDoc, otherId: string) {
  if (otherId === page.id) fail('Choose another page as its translation.');
  const other = own(state.pages, otherId) ?? fail('The page to link as a translation does not exist.');
  // A key left on one page alone (in a document written by hand) is no set: the page joins as if it had none.
  const mine = linkedGroup(state, page);
  const theirs = linkedGroup(state, other);
  if (mine && theirs && mine !== theirs) fail(`“${page.title}” and “${other.title}” each already have other translations. Unlink one of them first.`);
  const group = mine ?? theirs ?? newId('tr');
  page.translationGroup = group;
  other.translationGroup = group;
}

/** Take a page out of its translations. A page left on its own is no longer a translation of anything. */
function leaveTranslations(state: ProjectState, page: PageDoc) {
  const group = translationGroup(page);
  delete page.translationGroup;
  if (!group) return;
  const rest = translationMembers(state, group);
  if (rest.length === 1) delete rest[0].translationGroup;
}

type ArticleFields = Pick<Op<'page.update'>, 'articleDate' | 'byline' | 'excerpt' | 'article' | 'newsHidden'>;

/**
 * An op's article fields on a page. A publication date makes the page a dated article (or redates it); the byline,
 * excerpt and news-list visibility belong to an article, so a page that is not one takes them only with a date.
 * `article: false` makes it an ordinary page again and drops what only an article has.
 */
function applyArticle(page: PageDoc, op: ArticleFields) {
  const details = op.byline !== undefined || op.excerpt !== undefined || op.newsHidden !== undefined;
  if (op.article === false) {
    if (op.articleDate !== undefined || details) fail('An article cannot be turned into an ordinary page and given article details in the same change.');
    delete page.article;
    return;
  }
  if (op.articleDate !== undefined) {
    if (!isArticleDate(op.articleDate)) fail(`"${op.articleDate}" is not a calendar date. Write it as YYYY-MM-DD, such as 2026-11-14.`);
    // A stored article whose date was unreadable keeps its byline and excerpt when it is given a real date.
    page.article = { ...(page.article && typeof page.article === 'object' ? page.article : {}), date: op.articleDate };
  }
  if (!details) return;
  const article = pageArticle(page) ?? fail(`"${page.title}" is not an article. Give it a publication date first.`);
  const text = (v: string | undefined, key: 'byline' | 'excerpt') => {
    if (v === undefined) return;
    if (v.trim()) article[key] = v.trim();
    else delete article[key];
  };
  text(op.byline, 'byline');
  text(op.excerpt, 'excerpt');
  if (op.newsHidden !== undefined) {
    if (op.newsHidden) article.hidden = true;
    else delete article.hidden;
  }
}

/** Copy a node subtree from one tree into another, allocating new IDs. Returns the new root ID. */
function copySubtree(from: NodeTree, to: NodeTree, nodeId: string, state: ProjectState, groups = new Map<string, string>()): string {
  const idMap = new Map<string, string>();
  for (const id of subtreeIds(from, nodeId)) idMap.set(id, newId('n'));
  // A copied detached gallery is a gallery of its own: its images move through the viewer together, apart. Copies made
  // together (a page's sections) share one map, so a gallery spread over them stays one.
  for (const [oldId, nid] of idMap) {
    const n = clone(from.nodes[oldId]);
    n.id = nid;
    const group = n.detachedFrom?.group;
    if (typeof group === 'string') {
      if (!groups.has(group)) groups.set(group, `${newId('g')}${group.includes('|') ? group.slice(group.indexOf('|')) : ''}`);
      n.detachedFrom!.group = groups.get(group);
    }
    // Copies never reuse an anchor: HTML IDs must stay unique.
    if (from === to) delete n.anchor;
    if (n.kind === 'element' || n.kind === 'repeat') n.children = n.children.map((c) => idMap.get(c) ?? c);
    if (n.kind === 'instance') {
      if (n.slots) for (const k of Object.keys(n.slots)) n.slots[k] = slotChildren(n, k).map((c) => idMap.get(c) ?? c);
      const def = state.components[n.definitionId];
      if (def) {
        const before = n.props;
        n.props = freshListIds(def.properties, n.props);
        remapItemStyles(n, before);
      }
    }
    to.nodes[nid] = n;
  }
  return idMap.get(nodeId)!;
}

/**
 * A copy's list items get new IDs; its item styles move to the new IDs of the same items. A list the placement does
 * not hold itself (the definition's defaults) keeps its IDs, and so do the styles of its items.
 */
function remapItemStyles(n: InstanceNode, before: Record<string, unknown>) {
  if (!n.itemOverrides) return;
  for (const entry of Object.values(n.itemOverrides)) {
    const from = before[entry.list];
    const to = n.props[entry.list];
    if (!Array.isArray(from) || !Array.isArray(to) || from === to) continue;
    const ids = new Map<string, string>();
    from.forEach((it, i) => {
      const old = (it as ListItem | undefined)?.id;
      const next = (to[i] as ListItem | undefined)?.id;
      if (typeof old === 'string' && typeof next === 'string' && !ids.has(old)) ids.set(old, next);
    });
    entry.items = Object.fromEntries(Object.entries(entry.items ?? {}).flatMap(([id, rs]) => (ids.has(id) ? [[ids.get(id)!, rs]] : [])));
  }
  pruneEmptyItemStyles(n);
}

/** Item styles in a subtree about to become part of a component definition, where every placement shares its items. */
function refuseItemStylesInto(state: ProjectState, tree: NodeTree, ids: string[], what: string) {
  for (const id of ids) {
    const n = tree.nodes[id];
    if (n?.kind !== 'instance' || !n.itemOverrides) continue;
    const def = own(state.components, n.definitionId);
    const styled = Object.keys(n.itemOverrides).find((p) => liveItemStyles(def, n, p));
    if (!styled || !def) continue;
    const list = def.properties[n.itemOverrides[styled].list];
    const items = list?.type === 'list' ? list.itemLabel.toLowerCase() : 'item';
    fail(`"${n.name ?? def.name}" has a ${items} styled on its own. Reset it to the shared style first: ${what}`);
  }
}

function pageDuplicate(state: ProjectState, op: Op<'page.duplicate'>): OpResult {
  const src = own(state.pages, op.pageId) ?? fail(`Page "${op.pageId}" does not exist.`);
  const title = op.title?.trim() || `${src.title} copy`;
  const id = newId('pg');
  // A copy sits beside its original, in the same folder.
  const page: PageDoc = { ...clone(src), id, title, route: autoRoute(state, title, 'page', undefined, routeFolder(src.route) ?? '/'), rootIds: [], nodes: {} };
  // A copy is in the same language until it is translated: it is nobody's translation yet.
  delete page.translationGroup;
  const groups = new Map<string, string>();
  for (const rid of src.rootIds) page.rootIds.push(copySubtree(src, page, rid, state, groups));
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
  // No shell IDs leaves the header and footer's IDs out: those are shared, so their links stay where they were. A
  // section in a panel kept in the page hidden is the copy's too.
  const ids = pageIds(state, copy.id, NO_SHELL_IDS, true);
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
  const all = pageLinkUses(state, page.id);
  // Page lists' cards for this page go with it; every other link is pointed at the replacement.
  const cards = all.filter((u) => u.card);
  const uses = all.filter((u) => !u.card);
  const refs = uses.length;
  if (op.replacementPageId && !own(state.pages, op.replacementPageId)) fail('The replacement page does not exist.');
  if (op.replacementPageId === page.id) fail('The replacement must be a different page.');
  if (refs && !op.replacementPageId)
    throw new EngineError('VALIDATION_FAILED', `${refs} link${refs === 1 ? '' : 's'} point to "${page.title}". Choose a replacement page for them.`, { references: refs });
  if (op.sectionReplacements?.length && !op.replacementPageId) fail('Sections for links can only be chosen on a replacement page.');
  // The cards go first: a section on the replacement page that only they kept showing is gone for the links too.
  for (const { card } of cards) {
    const at = card!.items.indexOf(card!.item);
    if (at >= 0) card!.items.splice(at, 1);
  }
  // Sections are looked up before anything else moves: the replacement page's IDs do not depend on the page going.
  const section = op.replacementPageId ? sectionsOnReplacement(state, page, op.replacementPageId, uses, op.sectionReplacements) : null;
  if (page.id === state.site.homePageId) {
    // The page replacing Home moves to "/". Its old address is not kept: this removes a page, it moves none.
    // Home is never a draft, so the first published page takes over unless another is chosen.
    const next = op.replacementPageId ?? state.site.pageOrder.find((id) => id !== page.id && state.pages[id]?.draft !== true);
    if (!next) fail('Every other page is a draft. Publish one before removing the Home page.');
    if (state.pages[next].draft === true) fail(`"${state.pages[next].title}" is a draft and cannot become the Home page. Publish it first, or choose a published page.`);
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
  // Its translations stay linked to each other; they are never handed to the replacement page.
  delete state.pages[page.id];
  leaveTranslations(state, page);
  state.site.pageOrder = state.site.pageOrder.filter((id) => id !== page.id);
  // Where each removed card was, for the change summary: what this removal did, not what the batch started with.
  return cards.length ? { removedCards: cards.map((u) => u.where) } : {};
}

export type { RouteMove };

/** What making a page Home changes: the addresses that move, and the old address kept working, if any. */
export type HomeChange = { moved: RouteMove[]; kept?: string };

/**
 * Make `pageId` the Home page. It moves to "/" and the previous Home page moves to an address of its own. With
 * `keepOldAddress`, the page's old address keeps working and sends visitors on, so old links and bookmarks still
 * reach it. That address is kept before the previous Home's is chosen, so the previous Home can never take it.
 */
function pageSetHome(state: ProjectState, pageId: string, keepOldAddress: boolean, atStart?: ReadonlySet<string>): HomeChange {
  const page = own(state.pages, pageId) ?? fail(`Page "${pageId}" does not exist.`);
  if (state.site.homePageId === pageId) return { moved: [] };
  if (page.draft === true) fail(`"${page.title}" is a draft. Publish it before making it the Home page.`);
  const old = own(state.pages, state.site.homePageId);
  const vacated = page.route;
  const moved: RouteMove[] = [{ pageId, from: vacated, to: '/' }];
  page.route = '/';
  state.site.homePageId = pageId;
  // Only an address the page was served at when the batch began, as a move keeps (see movePages).
  const keep = keepOldAddress && (!atStart || atStart.has(vacated.toLowerCase())) && !validateRoute(vacated);
  if (keep) state.site.redirects = [...(Array.isArray(state.site.redirects) ? state.site.redirects : []), { from: vacated, pageId }];
  if (old) {
    // Home was published whatever its document said: it stays published at its new address.
    delete old.draft;
    const from = old.route;
    old.route = autoRoute(state, old.title, 'previous-home', old.id);
    claimRoute(state, old.route);
    moved.push({ pageId: old.id, from, to: old.route });
  }
  return keep ? { moved, kept: vacated } : { moved };
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
    // A list damaged by hand holds nothing that can be shown (validation reports it): new content starts it again.
    if (!Array.isArray(parent.slots[name])) parent.slots[name] = [];
    return parent.slots[name];
  }
  fail(`Cannot insert inside a ${parent.kind} node.`);
}

/** The placement and slot a child list belongs to, when it is one of a placement's slots. */
function slotAt(tree: NodeTree, parentId: string | null | undefined, list: string[]): { inst: InstanceNode; slot: string } | null {
  const parent = parentId && Object.hasOwn(tree.nodes, parentId) ? tree.nodes[parentId] : undefined;
  if (parent?.kind !== 'instance') return null;
  const slot = Object.keys(parent.slots ?? {}).find((k) => parent.slots![k] === list);
  return slot === undefined ? null : { inst: parent, slot };
}

/**
 * Content about to land in `list`: what its slot shows now (for the limit check after the edit), and a check to run
 * once it has landed that refuses content the slot does not take, or more than it holds. Lists that are no slot pass.
 */
function slotLanding(state: ProjectState, owner: OwnerRef, tree: NodeTree, parentId: string | null | undefined, list: string[]): (added: string[]) => void {
  const at = slotAt(tree, parentId, list);
  if (!at) return () => {};
  const design = owner.kind === 'component' ? state.components[owner.id] : undefined;
  const decl = slotDecl(state, at.inst, at.slot);
  const before = decl ? slotFill(state, tree, list, decl, design).count : 0;
  return (added) => {
    const problem = slotLandingProblem(state, tree, at.inst, at.slot, added, before, design);
    if (problem) fail(problem);
  };
}

function nodeInsert(state: ProjectState, op: Op<'node.insert'>): OpResult {
  const tree = editableTree(state, op.owner);
  if (op.newNodeId && Object.hasOwn(tree.nodes, op.newNodeId)) fail(`Node "${op.newNodeId}" already exists.`);
  const list = insertionList(tree, op.parentId, op.slot, state);
  const settled = settledRoot(tree);
  if (op.owner.kind === 'component' && list === tree.rootIds) {
    if (settled) fail('Insert inside the component, not beside its root.');
    if (!op.primitive || !HOLDERS.has(op.primitive)) fail(UNSETTLED);
  }
  const landed = slotLanding(state, op.owner, tree, op.parentId, list);
  let nodes: GraphNode[];
  if (op.primitive === 'slot' || op.primitive === 'repeat') {
    nodes = [structuralNode(state, op.owner, op.primitive, op.bind)];
  } else if (op.primitive) {
    nodes = primitiveNode(state, op.primitive, op.text);
    // A paragraph or span container holds only inline content, so text inserted there is inline text.
    const text = nodes[0];
    const holder = op.parentId && Object.hasOwn(tree.nodes, op.parentId) ? tree.nodes[op.parentId] : undefined;
    // Content placed in a component without naming a slot goes in its first one (see insertionList).
    const slot = op.slot ?? (holder?.kind === 'instance' ? Object.keys(state.components[holder.definitionId]?.slots ?? {})[0] : undefined);
    if (text.kind === 'text' && !text.rich && op.parentId && insertsInline(state, op.owner, op.parentId, slot)) text.tag = 'span';
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
  // The editor names the node it inserts when the same batch goes on to fill it (an image and its picture).
  if (op.newNodeId) nodes[0].id = op.newNodeId;
  for (const n of nodes) tree.nodes[n.id] = n;
  const index = op.index === undefined ? list.length : Math.min(op.index, list.length);
  list.splice(index, 0, nodes[0].id);
  landed([nodes[0].id]);
  if (op.owner.kind === 'component' && !settled) followRoot(state.components[op.owner.id]);
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
  // Code that imports another component's file renders it, whatever it declares.
  if (def?.kind === 'code') for (const other of Object.values(state.components)) if (codeImports(state, def, other.id) && (other.id === targetId || dependsOn(state, other.id, targetId, seen))) return true;
  // Code converted from a managed component still imports what that design used.
  const tree = def?.tree ?? (def?.provenance?.forkedFrom ? state.components[def.provenance.forkedFrom]?.tree : undefined);
  if (!tree) return false;
  for (const n of Object.values(tree.nodes)) {
    if (n.kind === 'instance' && (n.definitionId === targetId || dependsOn(state, n.definitionId, targetId, seen))) return true;
  }
  return false;
}

/**
 * A managed definition renders through its one root: the generator gives `rootIds[0]` the component's classes, its
 * anchor and its variant rules, so nothing may replace it, move it or stand beside it.
 */
const ROOT_IS_COMPONENT = (what: string) => `This is the component itself, so it cannot be ${what}. Change what is inside it instead.`;

/*
 * A definition without its one root (see `settledRoot`) can have its top level put right, and only that: an element
 * that holds others inserted there, the top level reordered, and the old roots (the first included) moved into it or
 * removed.
 */

/** The elements that can hold a design's old top-level elements while it is put right. */
const HOLDERS: ReadonlySet<string> = new Set(['container', 'stack', 'row', 'grid']);
const UNSETTLED = 'This design has no single top-level element yet. Insert a container at the top level to hold the others, then move them into it.';

/** The definition's `root` part is its first top-level element, whichever that is while its top level is put right. */
function followRoot(def: ComponentDefinition) {
  const first = def.tree?.rootIds[0];
  if (first && def.parts.root && def.parts.root.nodeId !== first) def.parts.root = { ...def.parts.root, nodeId: first };
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
  const def = op.owner.kind === 'component' ? state.components[op.owner.id] : undefined;
  const settled = settledRoot(tree);
  if (def && settled && tree.rootIds[0] === op.nodeId) fail(ROOT_IS_COMPONENT('moved'));
  const target = insertionList(tree, op.parentId, op.slot, state);
  // Until the design has its one root, its top level can be reordered, but nothing more can join it.
  if (def && target === tree.rootIds && (settled || info.list !== tree.rootIds)) fail(settled ? 'Move it inside the component, not beside its root.' : UNSETTLED);
  // Only what shows list items, or repeats one, depends on the repeat around it.
  const listed = def ? subtreeIds(tree, op.nodeId).filter((id) => tree.nodes[id].kind === 'repeat' || showsItemField(tree.nodes[id])) : [];
  const listsBefore = def ? new Map(listed.map((id) => [id, enclosingRepeatProp(def, id)])) : undefined;
  // A move within one slot changes nothing it holds; into another, the slot must take it.
  const landed = target === info.list ? () => {} : slotLanding(state, op.owner, tree, op.parentId, target);
  info.list.splice(info.index, 1);
  target.splice(Math.min(op.index, target.length), 0, op.nodeId);
  landed([op.nodeId]);
  if (def && listsBefore) checkMovedItemFields(state, def, listsBefore);
  if (def && !settled) followRoot(def);
  return {};
}

/** The bindings a node holds, conditions included (the binding a comparison reads). */
function nodeBindings(n: GraphNode) {
  return bindingSlots(n).flatMap((slot) => {
    const condition = slot.field === 'when' || slot.field === 'unless';
    const b = condition ? conditionRef(slot.value) : isBinding(slot.value) ? slot.value : undefined;
    return b ? [{ slot, b, comparison: condition && isComparison(slot.value) ? slot.value : undefined }] : [];
  });
}

const showsItemField = (n: GraphNode) => nodeBindings(n).some(({ b }) => '$item' in b);

/**
 * Moved definition content must still find the list items it shows. Where a node's nearest repeat now goes over
 * another list (or there is none), each item field it shows has to be a field of that list, of a type that fits
 * where it is shown; a repeat cannot land inside a repeat over its own list. A move between two repeats over the
 * same list changes nothing it shows.
 */
function checkMovedItemFields(state: ProjectState, def: ComponentDefinition, listsBefore: Map<string, string | undefined>) {
  for (const [id, before] of listsBefore) {
    const n = def.tree!.nodes[id];
    const list = enclosingRepeatProp(def, id);
    if (list === before) continue;
    if (n.kind === 'repeat' && list !== undefined && n.list.$prop === list) fail('A repeat cannot repeat the list it is already inside.');
    for (const { slot, b, comparison } of nodeBindings(n)) {
      if (!('$item' in b)) continue;
      const what = `${displayName(state, n, def)} shows the list item field "${b.$item}"`;
      if (list === undefined) fail(`${what}, so it has to stay inside a repeat over its list.`);
      const schema = boundSchema(def, id, b);
      const nested = slot.field === 'prop' && n.kind === 'instance' ? state.components[n.definitionId]?.properties[slot.prop!] : undefined;
      const ok = acceptedTypes(n, slot.field, nested);
      if (!schema || (ok && !ok.includes(schema.type)) || bindingProblem(state, { node: n, field: slot.field, prop: slot.prop, comparison }, schema))
        fail(`${what}, which "${list}" items do not have${schema ? ' in a fitting type' : ''}.`);
    }
  }
}

function nodeDuplicate(state: ProjectState, op: Op<'node.duplicate'>): OpResult {
  const tree = editableTree(state, op.owner);
  const info = findParent(tree, op.nodeId) ?? fail('Node is not attached.');
  if (op.owner.kind === 'component' && info.list === tree.rootIds) fail(ROOT_IS_COMPONENT('duplicated'));
  // The copy goes right after the original, or (the editor duplicating several siblings) where `index` says in the
  // same list, so the copies stay together after the last of them.
  const at = op.index ?? info.index + 1;
  if (at > info.list.length) fail(`index ${at} is past the end of the list, which has ${info.list.length} items.`);
  const landed = slotLanding(state, op.owner, tree, info.parentId, info.list);
  const nid = copySubtree(tree, tree, op.nodeId, state);
  info.list.splice(at, 0, nid);
  landed([nid]);
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
  const all = [n.styles, ...(n.kind === 'instance' ? Object.values(n.overrides ?? {}) : []), ...itemStyleRecords(n)];
  for (const rs of all)
    for (const scope of Object.values(rs ?? {}))
      for (const v of Object.values(scope ?? {})) if (v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string') out.push((v as { token: string }).token);
  return out;
}

/**
 * Take a copy of page content as it is now, for a later paste that must not depend on the original. Several nodes
 * are copied together only when they are siblings (one list of one parent), and are kept in the page's order.
 */
export function captureClipboard(state: ProjectState, pageId: string, nodeIds: string | readonly string[]): Clipboard {
  const page = getTree(state, { kind: 'page', id: pageId });
  const wanted = typeof nodeIds === 'string' ? [nodeIds] : [...nodeIds];
  if (!wanted.length) fail('Nothing was chosen to copy.');
  if (new Set(wanted).size !== wanted.length) fail('The same content was named twice.');
  for (const id of wanted) getNode(page, id);
  const info = findParent(page, wanted[0]) ?? fail('Node is not attached.');
  if (!wanted.every((id) => info.list.includes(id))) fail('Only sections or elements side by side in one place can be copied together.');
  const roots = info.list.filter((id) => wanted.includes(id));
  const clip: Clipboard = { id: newId('clip'), pageId, tree: { rootIds: roots, nodes: {} }, components: {}, pages: {}, assets: {} };
  for (const id of roots.flatMap((root) => subtreeIds(page, root))) {
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
    if (isDocumentLink(o)) (clip.documents ??= {})[o.target] = own(state.assets.assets, o.target)?.name ?? o.target;
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
  // The editor pastes onto a page, or inside a component it is editing everywhere (placeCopy checks that: inside its root,
  // never the component itself). The shared header and footer are not pasted into.
  if (op.toOwner.kind === 'shell') fail('Paste onto a page, or inside a component. The shared header and footer take no pasted content.');
  const gone = (what: string) => fail(`Nothing was pasted: the copy ${what}, which has been removed since it was copied.`);
  for (const [id, c] of Object.entries(clip.components)) {
    const def = own(state.components, id);
    if (!def) gone(`uses the "${c.name}" component`);
    if (contentContract(def!) !== c.contract) fail(`Nothing was pasted: the content "${c.name}" takes has changed since it was copied. Copy it again.`);
  }
  for (const [id, title] of Object.entries(clip.pages)) if (!own(state.pages, id)) gone(`links to the "${title}" page`);
  for (const [id, name] of Object.entries(clip.assets)) if (!own(state.assets.assets, id)) gone(`shows the image "${name}"`);
  for (const [id, name] of Object.entries(clip.documents ?? {})) if (own(state.assets.assets, id)?.kind !== 'document') gone(`links to the document "${name}"`);
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
      for (const part of Object.keys(n.itemOverrides ?? {})) if (!own(def.parts, part)) delete n.itemOverrides![part];
      if (n.itemOverrides && !Object.keys(n.itemOverrides).length) delete n.itemOverrides;
    }
    for (const t of styleTokens(n)) if (!tokens.has(t)) gone(`uses the site style "${t}"`);
  }
  // Several copied together go in their order, from the place asked for (or each at the end).
  const nodeIds = tree.rootIds.map((root, i) => placeCopy(state, tree, root, { ...op, index: op.index === undefined ? undefined : op.index + i, dropAnchors: op.toOwner.kind === 'component' }).nodeId as string);
  return { nodeId: nodeIds[0], nodeIds };
}

/** Place a copy of `from`'s subtree at `op`'s destination, with new IDs; shared by copy and paste. */
function placeCopy(state: ProjectState, from: NodeTree, nodeId: string, op: { toOwner: OwnerRef; parentId?: string | null; slot?: string; index?: number; dropAnchors?: boolean }): OpResult {
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
  if (op.toOwner.kind === 'component') refuseItemStylesInto(state, from, subtreeIds(from, nodeId), 'inside a component every placement shares its items.');
  if (op.slot && !op.parentId) fail('A slot needs the instance that has it as parentId.');
  const list = insertionList(to, op.parentId, op.slot, state);
  const landed = slotLanding(state, op.toOwner, to, op.parentId, list);
  const taken = anchorsInUse(state, op.toOwner);
  const nid = copySubtree(from, to, nodeId, state);
  for (const id of subtreeIds(to, nid)) {
    const n = to.nodes[id];
    // A pasted copy in a component (placed many times) keeps no page-unique anchor: each placement would repeat it.
    if (n.anchor && (taken.has(n.anchor) || op.dropAnchors)) delete n.anchor;
    else if (n.anchor) taken.add(n.anchor);
  }
  list.splice(op.index === undefined ? list.length : Math.min(op.index, list.length), 0, nid);
  landed([nid]);
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

/**
 * The placement and part one repeated item is styled on (`itemId`): a part inside exactly one repeat of a managed
 * definition, placed on a page or in the shared header or footer, and an item its list shows now.
 */
function itemStyleTarget(state: ProjectState, owner: OwnerRef, node: GraphNode, partId: string | undefined, itemId: string): { node: InstanceNode; partId: string; list: string; itemId: string } {
  if (node.kind !== 'instance') fail('"itemId" styles one item of a repeated part of a component; this node is not a component.');
  if (owner.kind === 'component') fail('Only a placement on a page or in the shared header or footer can style one item on its own.');
  const def = own(state.components, node.definitionId) ?? fail(`Component definition "${node.definitionId}" is missing.`);
  if (partId === undefined) fail('"itemId" needs a "partId": name the repeated part to style, such as the card.');
  if (def.kind !== 'managed') fail(`"${def.name}" is a code component, so its items are styled together. Leave out itemId.`);
  if (!own(def.parts, partId)) fail(`"${def.name}" has no part "${partId}". Parts: ${Object.keys(def.parts).join(', ')}.`);
  const list = repeatedPartList(def, partId);
  if (!list) fail(`"${def.parts[partId].label}" in "${def.name}" is not shown once per list item, so it has no single item to style. Leave out itemId to style it everywhere.`);
  const items = placementItems(def, node, list);
  // An item copied from the definition's defaults is found by the default's ID too (see placedItemIndex).
  const at = placedItemIndex(items, owner, node.id, itemId);
  if (at < 0) fail(`${def.properties[list].label} has no item "${itemId}". Items: ${items.map((i) => i.id).join(', ') || 'none'}.`);
  return { node, partId, list, itemId: items[at].id };
}

/**
 * Remove empty records left behind in a placement's item styles, then the map itself once it is empty. A record
 * that is not an object (a hand-edited document) holds no styles and goes the same way.
 */
function pruneEmptyItemStyles(node: InstanceNode) {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const [partId, entry] of Object.entries(node.itemOverrides ?? {})) {
    if (!isObject(entry) || !isObject(entry.items)) continue;
    for (const [itemId, rs] of Object.entries(entry.items)) {
      if (isObject(rs)) for (const scope of Object.keys(rs) as ResponsiveScope[]) if (!isObject(rs[scope]) || !Object.keys(rs[scope]!).length) delete rs[scope];
      if (!isObject(rs) || !Object.keys(rs).length) delete entry.items[itemId];
    }
    if (!Object.keys(entry.items).length) delete node.itemOverrides![partId];
  }
  if (node.itemOverrides && !Object.keys(node.itemOverrides).length) delete node.itemOverrides;
}

/**
 * Item styles belong to their item: once it leaves the placement's own list (removed, or the whole list replaced
 * without it), its styles go too, so later operations in the same batch (a token removal) no longer see them. This
 * holds whether or not the part still repeats over that list. A placement still showing the definition's default
 * items has no list of its own to leave: a theme change can give those defaults other IDs, so their styles are kept.
 */
function dropDepartedItemStyles(state: ProjectState) {
  for (const tree of [state.site.shell.header, state.site.shell.footer, ...Object.values(state.pages)]) {
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance' || !n.itemOverrides) continue;
      for (const entry of Object.values(n.itemOverrides)) {
        if (!entry || typeof entry !== 'object' || !entry.items || typeof entry.items !== 'object' || typeof entry.list !== 'string') continue;
        const stored = Object.hasOwn(n.props, entry.list) ? n.props[entry.list] : undefined;
        if (!Array.isArray(stored)) continue;
        const present = new Set(stored.map((i) => (i && typeof i === 'object' ? (i as ListItem).id : undefined)));
        for (const itemId of Object.keys(entry.items)) if (!present.has(itemId)) delete entry.items[itemId];
      }
      pruneEmptyItemStyles(n);
    }
  }
}

function nodeSetStyle(state: ProjectState, op: Op<'node.setStyle'>): OpResult {
  if (op.axis !== undefined && op.variant === undefined) fail('"axis" needs a "variant": name the option to style.');
  if (op.itemId !== undefined && op.variant !== undefined) fail('"itemId" styles one item of a placement; variant rules belong to the component definition and apply to every item.');
  const tree = editableTree(state, op.owner);
  const node = getNode(tree, op.nodeId);
  const itemTarget = op.itemId !== undefined ? itemStyleTarget(state, op.owner, node, op.partId, op.itemId) : undefined;
  if (!own(STYLE_PROP_MAP, op.property)) fail(`Unknown style property "${op.property}". Valid: ${Object.keys(STYLE_PROP_MAP).join(', ')}.`);
  if (op.value !== null) {
    const err = validateStyleValue(op.property, op.value);
    if (err) fail(err);
    checkTokenRef(state, op.value);
    // Column sizes are kept on one line with single spaces, as the inspector's field shows them.
    if (STYLE_PROP_MAP[op.property].kind === 'tracks' && typeof op.value === 'string') op = { ...op, value: op.value.trim().replace(/\s+/g, ' ') };
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
  if (itemTarget) {
    const { node: inst, partId, list, itemId } = itemTarget;
    const entry = inst.itemOverrides && Object.hasOwn(inst.itemOverrides, partId) ? inst.itemOverrides[partId] : undefined;
    const current = entry?.list === list && entry.items && typeof entry.items === 'object';
    // Clearing a value this item does not have changes nothing, and must not discard styles kept for another list.
    if (op.value === null && !current) return {};
    inst.itemOverrides ??= {};
    // Styles kept for a list the part no longer repeats over style nothing; the item's first new value replaces them.
    if (!current) inst.itemOverrides[partId] = { list, items: {} };
    const items = inst.itemOverrides[partId].items;
    // Own keys only: an item ID can be any word, "toString" included.
    if (!Object.hasOwn(items, itemId) || !items[itemId] || typeof items[itemId] !== 'object') items[itemId] = {};
    setStyle(items[itemId] as Record<string, Record<string, StyleValue>>, scope, op.property, op.value);
    pruneEmptyItemStyles(inst);
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
  if (op.itemId !== undefined && op.variant !== undefined) fail('"itemId" resets one item of a placement; variant rules belong to the component definition.');
  const node = getNode(editableTree(state, op.owner), op.nodeId);
  if (op.itemId !== undefined) {
    // Back to the shared style: the item's own values go, and the part's shared values show through again.
    const { node: inst, partId, list, itemId } = itemStyleTarget(state, op.owner, node, op.partId, op.itemId);
    const entry = inst.itemOverrides?.[partId];
    const rs = entry?.list === list && Object.hasOwn(entry.items, itemId) ? entry.items[itemId] : undefined;
    if (rs && op.scope) delete rs[op.scope];
    else if (rs) delete entry!.items[itemId];
    pruneEmptyItemStyles(inst);
    return {};
  }
  if (op.variant !== undefined) {
    const v = variantStyles(state, op.owner, op.nodeId, op.variant, op.partId, op.axis);
    const rules = v.styles![op.nodeId];
    if (rules && op.scope) delete rules[op.scope];
    if (rules && (!op.scope || !Object.keys(rules).length)) delete v.styles![op.nodeId];
    if (!Object.keys(v.styles!).length) delete v.styles;
    return {};
  }
  if (node.kind === 'instance') {
    // Resetting every part of the placement takes its item styles with it; resetting one part keeps them.
    if (!op.partId && node.itemOverrides) {
      for (const entry of Object.values(node.itemOverrides))
        for (const rs of Object.values(entry?.items ?? {})) if (rs && typeof rs === 'object') for (const sc of Object.keys(rs) as ResponsiveScope[]) if (!op.scope || sc === op.scope) delete rs[sc];
      pruneEmptyItemStyles(node);
    }
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
    if (field.field !== undefined) {
      // One field of an object's default; its other fields keep theirs.
      const f = propBindingSchema(def.properties, field) ?? fail(`Missing field ${field.field} of ${field.$prop}.`);
      (schema as { default: unknown }).default = normalizeProp(schema, { [field.field]: schemaFix(f) }, state, `${def.name} → ${schema.label}`, schema.default);
      return true;
    }
    // The default must still fit its schema (a number or choice can be bound to text); an image's description saved
    // before the limit stays while it is not changed.
    const saved = schema.type === 'image' ? (schema as { default: unknown }).default : undefined;
    (schema as { default: unknown }).default = normalizeProp(schema, schemaFix(schema), state, `${def.name} → ${schema.label}`, saved);
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
      // A description saved before the limit stays while it is not changed: the node's own, or the default of the
      // property (or the object field) it is bound to.
      const bound = isBinding(node.image) && def && '$prop' in node.image ? propBindingSchema(def.properties, node.image) : undefined;
      const val = normalizeImage(v, state, label, storedAlt(bound ? (bound as { default?: unknown }).default : node.image));
      if (!setBound(node.image, () => val)) node.image = val;
      return {};
    }
    case 'link': {
      if (node.kind !== 'link' && node.kind !== 'element') fail('Only buttons, links and containers have a destination.');
      const val = normalizeLink(v, state, label);
      if (setBound(node.link, () => val)) return {};
      // A container with no destination is no longer a card.
      if (node.kind === 'element' && val.type === 'none') delete node.link;
      else node.link = val;
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
      if (node.kind !== 'icon' && node.kind !== 'link') fail('Only icons, buttons and links have an icon.');
      if (setBound(node.icon, () => String(v ?? ''))) return {};
      // A button without an icon simply leaves it out.
      if (node.kind === 'link' && !String(v ?? '').trim()) delete node.icon;
      else node.icon = String(v ?? '');
      return {};
    }
    case 'iconPosition': {
      if (node.kind !== 'link') fail('Only buttons and links have an icon position.');
      if (!(ICON_POSITIONS as string[]).includes(String(v))) fail(`Icon position must be ${ICON_POSITIONS.join(' or ')}.`);
      if (!setBound(node.iconPosition, () => String(v))) node.iconPosition = String(v) as IconPosition;
      return {};
    }
    case 'action': {
      if (node.kind !== 'element') fail('Only containers do something when clicked.');
      if (typeof v !== 'string' || !(ELEMENT_ACTIONS as string[]).includes(v)) fail(`What a click does must be ${ELEMENT_ACTIONS.join(', ')}.`);
      if (!setBound(node.action, () => String(v))) node.action = String(v) as ElementAction;
      return {};
    }
    case 'ariaLabel': {
      if (node.kind !== 'element' && node.kind !== 'icon' && node.kind !== 'link') fail('Only containers, icons, buttons and links have an accessible name.');
      const text = String(v ?? '').trim().slice(0, 200);
      if (setBound(node.ariaLabel, () => text)) return {};
      if (text) node.ariaLabel = text;
      else delete node.ariaLabel;
      return {};
    }
    case 'tag': {
      if (node.kind !== 'text' && node.kind !== 'element') fail('Only text and containers have a tag.');
      if (node.kind === 'text' && node.rich) fail('Rich text keeps its paragraph structure.');
      // A bound tag is the choice's default, which must stay one of the choice's options.
      if (isBinding(node.tag) && typeof v !== 'string') fail('A tag is the name of one, such as "h2" or "section".');
      if (setBound(node.tag, () => String(v))) return {};
      // Any tag of its kind. Whether it fits where it sits (a list item in a list, only inline content in a
      // paragraph) is judged once the whole batch is applied, so a list and its items can change together.
      const problem = tagKindProblem(node, v);
      if (problem) fail(problem);
      if (node.kind === 'text') node.tag = v as TextTag;
      else node.tag = v as ElementTag;
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
    case 'collapseEmpty': {
      // Only a component's design leaves a container out by the conditions inside it (generator childrenCondition).
      if (!def || node.kind !== 'element') fail('Only containers in a component’s design can hide when every item inside is hidden.');
      if (typeof v !== 'boolean') fail('collapseEmpty is true or false.');
      if (v) node.collapseEmpty = true;
      else delete node.collapseEmpty;
      return {};
    }
    case 'appear': {
      if (node.kind !== 'element' && node.kind !== 'instance') fail('Only sections and containers have an entrance.');
      const a = v === null || v === undefined || v === '' ? null : v;
      // A section's entrance lands on its component's root element, which only managed components place. One left
      // behind when the component changed can still be cleared.
      if (a !== null && node.kind === 'instance' && !anchorCapable(state, state.components[node.definitionId])) fail('Entrances can only be set on sections built in the editor, not on code components.');
      if (a !== null && a !== 'none' && !isAppearPreset(a)) fail(`An entrance is ${APPEAR_PRESETS.join(', ')} or none.`);
      // A placement keeps `none`, which turns its design's own entrance off; clearing it goes back to the design's.
      if (a === null) delete node.appear;
      else if (node.kind === 'instance') node.appear = a as AppearPreset | 'none';
      else if (a === 'none') delete node.appear;
      else node.appear = a as AppearPreset;
      return {};
    }
    case 'appearStagger': {
      if (!def || node.kind !== 'repeat') fail('Only a repeated list in a component’s design staggers its items’ entrances.');
      if (typeof v !== 'boolean') fail('appearStagger is true or false.');
      if (v) node.appearStagger = true;
      else delete node.appearStagger;
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
  const pairs = itemLinkPairs(def, op.prop);
  if (!pairs.length) return moved;
  // The batch may name the item by its own ID or by the ID of the default it was copied from (see placedItemIndex).
  const schema = def.properties[op.prop];
  const defaults = schema?.type === 'list' && Array.isArray(schema.default) ? (schema.default as unknown[]) : [];
  const copiedFrom = defaults.flatMap((d) => (d && typeof d === 'object' && typeof (d as ListItem).id === 'string' && placedItemId(op.owner, op.nodeId, (d as ListItem).id) === before.id ? [(d as ListItem).id] : []));
  const names = [before.id, ...(op.itemId ? [op.itemId] : []), ...copiedFrom];
  for (const { text, link } of pairs) {
    const explicit = names.some((id) => ctx.explicitItemFields?.has(itemFieldKey(op.owner, op.nodeId, op.prop, id, link)));
    if (!Object.hasOwn(sent, text) || Object.hasOwn(sent, link) || explicit) continue;
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
  refuseBound(state, op.owner, node.props[op.prop], schema.label);
  if (op.itemId) {
    if (schema.type !== 'list') fail(`"${op.prop}" is not a list.`);
    refuseFeed(schema);
    // A placement without its own list shows the definition's items, so an edit to one of them starts from those.
    const own = node.props[op.prop];
    const list = (Array.isArray(own) ? own : clone(schema.default)) as Array<ListItem>;
    const idx = placedItemIndex(list, op.owner, node.id, op.itemId);
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
      if (!op.value || typeof op.value !== 'object' || Array.isArray(op.value)) fail(`${schema.itemLabel}: send the item's fields as an object, or name one field.`);
      next = normalizeItem(schema, op.value as Record<string, unknown>, state, schema.itemLabel, before, before);
      sent = op.value && typeof op.value === 'object' && !Array.isArray(op.value) ? (op.value as Record<string, unknown>) : {};
    }
    const followed = followItemLinks(state, def, op, before, next, sent, ctx);
    list[idx] = next;
    node.props[op.prop] = [...list];
    return followed.length ? { followed } : {};
  }
  if (op.field !== undefined) {
    // One field of an object: the rest keep what the placement shows now (its own value, or the definition's).
    if (schema.type !== 'object') fail(`"${op.prop}" is not an object or a list; leave out field.`);
    if (!Object.hasOwn(schema.fields, op.field)) fail(`${schema.label} has no field "${op.field}". Fields: ${Object.keys(schema.fields).join(', ')}.`);
    const own = node.props[op.prop];
    if (isBinding(own)) fail(`${schema.label} comes from the enclosing component's own property; edit it there.`);
    const current = own && typeof own === 'object' && !Array.isArray(own) ? own : schema.default;
    node.props[op.prop] = normalizeProp(schema, { [op.field]: op.value }, state, `${def.name} → ${schema.label}`, current);
    return {};
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
    const at = op.type === 'instance.setProp' && op.itemId && op.field === 'name' ? placedItemIndex(after as ListItem[], op.owner, node.id, op.itemId) : -1;
    const cleared = at >= 0 ? [(after as ListItem[])[at].id] : [];
    node.props.fields = settleFormKeys(before, after as ListItem[], new Set(cleared), formDefaults(def));
  }
  return result;
}

/**
 * One step of a table edit, by row and column ID, on the table the placement shows now (its own, or the
 * definition's while it has none). A step whose row or column has gone is refused.
 */
function tableEdit(state: ProjectState, op: Op<'instance.editTable'>): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  const schema = def.properties[op.prop];
  if (!schema) fail(`"${def.name}" has no property "${op.prop}". Properties: ${Object.keys(def.properties).join(', ')}.`);
  if (schema.type !== 'table') fail(`"${op.prop}" is not a table property.`);
  refuseBound(state, op.owner, node.props[op.prop], schema.label);
  const current = Object.hasOwn(node.props, op.prop) ? node.props[op.prop] : clone(schema.default);
  const r = editTable(current, op, `${def.name} → ${schema.label}`);
  node.props[op.prop] = r.value;
  return r.rowId ? { rowId: r.rowId } : r.columnId ? { columnId: r.columnId } : {};
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
  if (findTokenCycle(state)) fail('That change would make site styles refer to each other in a loop.');
}

/** What each kind of site style is called in messages. */
const TOKEN_KIND: Record<TokenGroup, string> = { color: 'color', font: 'font', text: 'text', space: 'spacing', container: 'page width', radius: 'corner', shadow: 'shadow', border: 'border' };

function tokenSet(state: ProjectState, op: Op<'token.set'>): OpResult {
  const tdef = declaredTokens(state).find((t) => t.id === op.tokenId) ?? fail(`Token "${op.tokenId}" does not exist.`);
  const custom = state.tokens.custom.find((t) => t.id === op.tokenId);
  if (op.value === null) {
    // A custom style's value is its own: there is no theme default under it to go back to.
    if (custom) fail(`"${custom.label}" is one of your own site styles, so it has no theme default to go back to. Give it a new value, or remove it.`);
    delete state.tokens.overrides[op.tokenId];
    // The theme's own value can link to a style that now links back.
    assertNoTokenCycles(state);
    return {};
  }
  const v = op.value as Record<string, unknown>;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'token' in v) {
    // A reference is exactly { token } naming an existing style of the same kind.
    if (typeof v.token !== 'string' || Object.keys(v).length !== 1) fail('A site style reference must be { "token": "group.name" }.');
    // Text styles are written out metric by metric, so one cannot stand in for another as a whole.
    if (tdef.group === 'text') fail(`"${tdef.label}" is a text style, and a text style cannot follow another text style. Change its font, size or spacing instead.`);
    const tokens = effectiveTokens(state);
    const target = tokens.find((t) => t.id === v.token) ?? fail(`Token "${v.token}" does not exist.`);
    if (target.group !== tdef.group) fail(`"${tdef.label}" can only follow another ${TOKEN_KIND[tdef.group]} style, and "${target.label}" is a ${TOKEN_KIND[target.group]} style.`);
    // The style followed must lead to a value: every style further along it exists and is the same kind.
    const seen = new Set([target.id, op.tokenId]);
    for (let cur = linkOf(target.value, target.group); cur && !seen.has(cur); ) {
      seen.add(cur);
      const next = tokens.find((t) => t.id === cur) ?? fail(`"${target.label}" follows "${cur}", which does not exist. Link to another style, or give "${target.label}" its own value first.`);
      if (next.group !== tdef.group) fail(`"${target.label}" follows "${next.label}", which is a ${TOKEN_KIND[next.group]} style.`);
      cur = linkOf(next.value, next.group);
    }
    state.tokens.overrides[op.tokenId] = { token: target.id };
  } else tokenSetLiteral(state, tdef, op.value);
  // A custom style has no theme default to return to: its value is its own, not an override.
  if (custom && Object.hasOwn(state.tokens.overrides, op.tokenId)) {
    custom.value = state.tokens.overrides[op.tokenId];
    delete state.tokens.overrides[op.tokenId];
  }
  assertNoTokenCycles(state);
  return {};
}

const TEXT_KEYS = ['family', 'size', 'lineHeight', 'weight', 'tracking', 'transform'] as const;

/** Check a literal value for a style's kind and store it as the style's override. */
function tokenSetLiteral(state: ProjectState, tdef: TokenDef, v: unknown) {
  const id = tdef.id;
  if (tdef.group === 'color') {
    const err = validateStyleValue('color', String(v));
    if (err) fail(err);
    state.tokens.overrides[id] = v as TokenValue;
  } else if (tdef.group === 'text') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Text styles need { family, size, lineHeight, weight, tracking }.');
    // A text style saved as a link to another (hand-edited, or from an older version) starts from what it is
    // written out with: the text style it follows, or the theme's own metrics when the link leads nowhere.
    const declared = getTheme(state.site.themeId).tokens.find((t) => t.id === id)?.value;
    const cur = textStyleValue(effectiveTokens(state), id, declared) ?? undefined;
    // Only the text-style keys are kept, so nothing else can change how the style is written out.
    const merged: Record<string, unknown> = Object.fromEntries(TEXT_KEYS.map((k) => [k, Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : cur?.[k]]).filter(([, x]) => x !== undefined));
    if (merged.family === undefined || merged.family === null || merged.family === '') fail('Text styles need a font family.');
    for (const k of ['size', 'lineHeight', 'tracking'] as const) {
      const x = merged[k];
      const s = typeof x === 'number' && Number.isFinite(x) ? String(x) : typeof x === 'string' ? x : '';
      if (!s.trim() || !/^[0-9a-z.,%+\-*/ ()]+$/i.test(s) || !isSafeCssValue(s)) fail(`Invalid ${k} "${x === undefined ? '' : String(x)}".`);
    }
    const w = textWeight(merged.weight);
    if (!Number.isFinite(w) || w < 100 || w > 900) fail('Weight must be between 100 and 900.');
    merged.weight = w;
    const fam = merged.family as unknown;
    if (fam && typeof fam === 'object') {
      const ref = (fam as { token?: unknown }).token;
      if (typeof ref !== 'string' || !effectiveTokens(state).some((t) => t.id === ref && t.group === 'font')) fail('A text style font must reference an existing font token.');
    } else if (Object.hasOwn(v, 'family')) {
      // Only a family being set now is checked, so an older value never blocks an unrelated change.
      if (!/^[\p{L}\p{N}_\s'",.-]{1,200}$/u.test(String(fam)) || !isSafeCssValue(String(fam))) fail('Font names may contain letters, numbers, spaces, quotes, commas and hyphens only.');
      const font = resolveFontStack(state, String(fam));
      if ('error' in font) fail(font.error);
      merged.family = font.stack;
    }
    if (merged.transform !== undefined && !['none', 'uppercase', 'lowercase', 'capitalize'].includes(String(merged.transform))) fail('Text transform must be none, uppercase, lowercase or capitalize.');
    state.tokens.overrides[id] = merged as unknown as TokenValue;
  } else if (tdef.group === 'font') {
    const s = String(v);
    if (!/^[\p{L}\p{N}_\s'",.-]+$/u.test(s) || s.length > 200 || !isSafeCssValue(s)) fail('Font stacks may contain names, quotes, commas and hyphens only.');
    const font = resolveFontStack(state, s);
    if ('error' in font) fail(font.error);
    state.tokens.overrides[id] = font.stack;
  } else if (tdef.group === 'space' || tdef.group === 'container' || tdef.group === 'radius') {
    const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    const negative = tdef.group === 'space';
    if (!isTokenLength(s, { negative }) || s.length > 200 || !isSafeCssValue(s))
      fail(`"${(s || String(v)).slice(0, 60)}" is not a valid length for ${tdef.label}. Use a ${negative ? '' : 'positive '}value such as 24px, 1.5rem, 50% or clamp(1rem, 2vw, 2rem).`);
    state.tokens.overrides[id] = s;
  } else {
    const s = String(v);
    if (!/^[0-9a-z.,%+\-*/ ()#]+$/i.test(s) || s.length > 200 || !isSafeCssValue(s)) fail(`Invalid value "${s}".`);
    state.tokens.overrides[id] = v as TokenValue;
  }
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
    if (v && typeof v === 'object' && 'token' in v) fail('A text style cannot follow another text style. Start it from one instead, and change its font, size or spacing.');
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
    for (const n of Object.values(t.tree.nodes)) if (hit(n.styles) || (n.kind === 'instance' && Object.values(n.overrides ?? {}).some(hit)) || itemStyleRecords(n).some(hit)) out.add(t.label);
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
    // A token property always holds a token, so its uses can only move to another one.
    const props = tokenPropUsageCounts(state)[t.id] ?? 0;
    if (props) fail(`"${t.label}" is chosen by ${props} component propert${props === 1 ? 'y' : 'ies'}, which can only hold a site style. Choose a replacement style.`);
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
    const problem = siteLanguageProblem(state, op.language);
    if (problem) fail(problem);
    s.language = op.language;
  }
  // Automatic is no choice at all: the language decides.
  if (op.direction !== undefined) {
    if (op.direction === 'auto') delete s.direction;
    else s.direction = op.direction;
  }
  if (op.description !== undefined) s.description = op.description;
  if (op.baseUrl !== undefined) {
    // Checked and stored the way browsers and the site build read it, so every generated link agrees with it.
    const check = checkPublicUrl(op.baseUrl);
    if (!check.ok) fail(check.message);
    s.baseUrl = check.url || undefined;
  }
  if (op.favicon !== undefined) {
    if (op.favicon && own(state.assets.assets, op.favicon)?.kind !== 'image') fail('Favicon asset not found.');
    s.favicon = op.favicon;
  }
  if (op.socialImage !== undefined) {
    if (op.socialImage && own(state.assets.assets, op.socialImage)?.kind !== 'image') fail('Social image asset not found.');
    s.socialImage = op.socialImage;
  }
  // Empty text restores the default wording.
  if (op.notFoundHeading !== undefined) s.notFoundHeading = op.notFoundHeading.trim() || undefined;
  if (op.notFoundMessage !== undefined) s.notFoundMessage = op.notFoundMessage.trim() || undefined;
  if (op.notFoundLinkLabel !== undefined) s.notFoundLinkLabel = op.notFoundLinkLabel.trim() || undefined;
  if (op.visitorText) setVisitorText(s, op.visitorText.language, op.visitorText.text);
  return {};
}

/**
 * Sets the author's wording for pieces of visitor text in one language. Empty wording restores the built-in one, and
 * a language left with none of its own is dropped, as is the whole map once it is empty.
 */
function setVisitorText(site: ProjectState['site'], language: string, text: Record<string, string>): void {
  if (!isLanguageCode(language)) fail(LANGUAGE_CODE_ERROR);
  const unknown = Object.keys(text).filter((key) => !isVisitorTextKey(key));
  if (unknown.length) fail(`“${unknown[0]}” is not a piece of visitor text. Use one of: ${VISITOR_TEXT_KEYS.join(', ')}.`);
  const code = visitorTextLanguage(language);
  const all = site.visitorText && typeof site.visitorText === 'object' && !Array.isArray(site.visitorText) ? { ...site.visitorText } : {};
  // The language's wording as the site reads it, under its lower-case code: a key written by hand in another case is
  // folded in, and pieces that say nothing are dropped.
  const own: Record<string, string> = ownVisitorTextFor({ visitorText: all }, code);
  for (const key of Object.keys(all)) if (visitorTextLanguage(key) === code) delete all[key];
  for (const key of VISITOR_TEXT_KEYS) {
    if (!Object.hasOwn(text, key) || text[key] === undefined) continue;
    const value = ownVisitorText(text[key]);
    if (value) own[key] = value;
    else delete own[key];
  }
  if (Object.keys(own).length) all[code] = own;
  else delete all[code];
  if (Object.keys(all).length) site.visitorText = all;
  else delete site.visitorText;
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
  const copy = copyDefinition(state, def, op.name?.trim() || uniqueCopyName(state, def.name));
  node.definitionId = copy.id;
  return { definitionId: copy.id };
}

function createFromNode(state: ProjectState, op: Op<'component.createFromNode'>): OpResult {
  const tree = editableTree(state, op.owner);
  const root = getNode(tree, op.nodeId);
  const info = findParent(tree, op.nodeId) ?? fail('Node is not attached.');
  if (root.kind === 'slot' || root.kind === 'repeat') fail('Select an element rather than a slot or repeat to create a component.');
  refuseItemStylesInto(state, tree, subtreeIds(tree, op.nodeId), 'every placement of a component shares its items.');
  if (op.owner.kind !== 'component') refuseCodeRootStylesInto(state, tree, subtreeIds(tree, op.nodeId));
  // UI state belongs to the design that declares it; the new component would read or change state it does not have.
  if (usesState(subtreeIds(tree, op.nodeId).flatMap((id) => (tree.nodes[id] ? [tree.nodes[id]] : []))))
    fail('Part of this content reads or changes the UI state of the component around it, which a component of its own would not have. Remove those conditions and button actions first.');
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
  // The root's entrance stays with the placement too, so the section enters as before and the next one chooses its own.
  const appear = rootNode.kind === 'element' || rootNode.kind === 'instance' ? rootNode.appear : undefined;
  if (rootNode.kind === 'element' || rootNode.kind === 'instance') delete rootNode.appear;
  // A section made into a component (with the content in its slots) is still called what it was, and its placements
  // offer the styles the section's own root offers.
  const named = root.name ?? (root.kind === 'instance' ? displayName(state, root) : undefined);
  parts.root = { nodeId: rootCopy, label: named ?? 'Root', ...(rootNode.kind === 'instance' ? rootControls(state, rootNode) : withControls(rootNode)) };

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
        // An object field moves with its whole object, which the new component reads the same field of.
        props[name] = isProp ? { $prop: b.$prop } : clone(b);
        hoisted.set(key, name);
      }
      return isProp ? withProp(b, name) : { $prop: name };
    };
    const walk = (id: string, innerRepeat: boolean) => {
      const n = defTree.nodes[id];
      if (!n) return;
      // List item fields inside a repeat that is part of the selection still belong to that repeat.
      const fix = <T,>(v: T): T => (isBinding(v) && !('$item' in v && innerRepeat) ? (hoist(v) as T) : v);
      // A compared condition keeps its comparison; only the value it reads moves to the new property.
      for (const slot of bindingSlots(n)) {
        if (isComparison(slot.value)) slot.set({ ...slot.value, ref: fix(slot.value.ref) });
        else if (isBinding(slot.value)) slot.set(fix(slot.value));
      }
      if (n.kind === 'slot') {
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
      const isHeading = typeof n.tag === 'string' ? /^h\d$/.test(n.tag) : true;
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
    description: `Project component created from ${named ?? 'a selection'}.`,
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
  if (appear) inst.appear = appear;
  if (Object.keys(instSlots).length) inst.slots = instSlots;
  const removed = new Set(subtreeIds(tree, op.nodeId));
  if (ownerDef) {
    // The owner's parts and variant rules on the selection's root now target the new instance; those deeper
    // inside move into the new component, so placements must not still be styling them.
    for (const [pid, p] of Object.entries(ownerDef.parts)) {
      if (p.nodeId === op.nodeId) p.nodeId = inst.id;
      else if (removed.has(p.nodeId)) {
        const styled = instancesOf(state, ownerDef.id).filter((u) => u.node.overrides?.[pid] || u.node.itemOverrides?.[pid]);
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
  // In a slot, the new component takes the selection's place: the slot must take a component of its category. What
  // the slot shows is measured while the selection is still there, so taking its place adds nothing.
  const landed = slotLanding(state, op.owner, tree, info.parentId, info.list);
  for (const id of removed) delete tree.nodes[id];
  tree.nodes[inst.id] = inst;
  info.list.splice(info.index, 1, inst.id);
  landed([inst.id]);
  return { definitionId: def.id, nodeId: inst.id };
}

/** The style controls a part offers: only those that do something on its kind of node. */
function withControls(node: GraphNode): { styleControls?: string[] } {
  const controls = styleSetFor(node);
  return controls ? { styleControls: controls } : {};
}

/** A component placed at the root of a new one: the root offers what that component's own root offers. */
function rootControls(state: ProjectState, node: InstanceNode): { styleControls?: string[] } {
  const def = own(state.components, node.definitionId);
  const controls = def ? partStyleControls(def, 'root') : undefined;
  // Kept as listed, an empty list included: it offers only Hidden on a placement, never every property.
  return controls ? { styleControls: [...controls] } : {};
}

/**
 * Inside a component's design, a code component's root takes styles only through the class it places (its inner parts
 * take theirs through the part classes): root styles that would no longer apply are refused rather than quietly lost.
 * Code may place its class in ways not read here (from its props object, or passed on with the rest of them), so it is
 * refused only when it plainly does not.
 */
function mayPlaceClass(def: ComponentDefinition): boolean {
  if (codePlacesClass(def)) return true;
  const src = (def.source ?? '').replace(/<style\b[\s\S]*?<\/style>/g, '');
  if (/\.\s*class\b|\[\s*['"`]class['"`]\s*\]|\$\$(rest)?props\b/.test(src)) return true;
  // Passed on with the rest of its props (`let { …, ...rest } = $props()`, then `{...rest}` on an element).
  const rest = src.match(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*\$props\(\)/)?.[1];
  return !!rest && new RegExp(`\\{\\s*\\.\\.\\.\\s*${rest.replace(/\$/g, '\\$')}\\s*\\}`).test(src);
}

function refuseCodeRootStylesInto(state: ProjectState, tree: NodeTree, ids: string[]) {
  for (const id of ids) {
    const n = tree.nodes[id];
    const root = n?.kind === 'instance' ? n.overrides?.root : undefined;
    if (!root || !Object.values(root).some((scope) => !!scope && Object.keys(scope).length > 0)) continue;
    const def = own(state.components, (n as InstanceNode).definitionId);
    if (def?.kind === 'code' && !mayPlaceClass(def)) fail(`"${n!.name ?? def.name}" has its own styles on its root, which this code component takes only on a page. Reset them first, or create the component from a different element.`);
  }
}

function titleCase(s: string): string {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/(\d+)$/, ' $1');
}

function convertToCode(state: ProjectState, op: Op<'component.convertToCode'>): OpResult {
  const { node, def } = instanceTarget(state, op.owner, op.nodeId);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is already a code component.`);
  refuseItemStylesInto(state, getTree(state, op.owner), [op.nodeId], 'a code component styles its items together.');
  // The code would show only the state's starting values, and its buttons would no longer change them.
  if (Object.keys(def.state ?? {}).length) fail(`"${def.name}" has UI state its buttons change, which a code copy would not keep. Remove its UI state first.`);
  // Content placed in such a slot could no longer be checked for links inside the card's own link.
  const carded = slotsInsideCards(state, def);
  if (carded.length) fail(`"${def.name}" places its ${carded.map((s) => `“${def.slots?.[s]?.label ?? s}”`).join(', ')} content inside a card that links somewhere, which a code component cannot keep free of other links. Remove the card's link first.`);
  const name = op.name?.trim() || `${def.name} (code)`;
  const newId = projectDefId(name, 'code');
  const sourcePath = `${CUSTOM_DIR}/${pascal(name)}-${newId.slice(-5).replace(/[^A-Za-z0-9]/g, '')}.svelte`;
  // One working copy is both generated and stored, so the source shows exactly the properties the copy declares.
  const work: ComponentDefinition = { ...clone(def), id: newId, kind: 'code', sourcePath };
  // An empty state map (all it can be here) means nothing to a code component, which keeps its own state.
  delete work.state;
  // A code component takes `class` for its root's classes, so a property of that name (older documents may have
  // one) moves to a name of its own first, with the placement's value and every binding to it.
  moveCodeReservedProps(work, node);
  promotePageLinks(state, work);
  // The source renders rich text through the RichText helper, which takes blocks.
  for (const schema of Object.values(work.properties)) {
    if (schema.type === 'richtext') schema.codeForm = 'blocks';
    if (schema.type === 'list' || schema.type === 'object') for (const f of Object.values(schema.fields)) if (f.type === 'richtext') f.codeForm = 'blocks';
  }
  // Generate as if the file already lives at its final path under its own ID, so relative imports resolve and
  // the markup and its <style> block use the new component's class names: the code no longer depends on the
  // original definition's stylesheet. Every placement passes every property, so the source's own fallbacks are
  // only for other callers, and keep no page's address of today.
  // A list's field defaults included, since its items fill in from them.
  const forSource = { ...clone(work), properties: Object.fromEntries(Object.entries(work.properties).map(([k, schema]) => [k, sourceFallback(schema)])) } as ComponentDefinition;
  // A code component takes no entrance from its placement: the placement's own is written into the copy's source.
  const appear = node.appear === 'none' || isAppearPreset(node.appear) ? node.appear : undefined;
  const source = generateStandaloneComponent(state, forSource, appear).replace(
    /^<!-- Generated by[^\n]*\n/,
    `<!-- Code component converted from "${def.name}". Edit freely; declared properties stay editable in SiteOrigin Builder. -->\n`
  );
  const deps = [...new Set([...(def.dependencies ?? []), ...directDependencies(def)])].sort();
  const copy: ComponentDefinition = {
    ...work,
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
  delete node.appear;
  return { definitionId: copy.id, sourcePath: copy.sourcePath };
}

const holdsPageLink = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(holdsPageLink);
  if (!v || typeof v !== 'object' || isBinding(v)) return false;
  return (v as LinkValue).type === 'page' || Object.values(v).some(holdsPageLink);
};

/** A value with each page link in it replaced by no link, read as its schema stores it: words stay, no address. */
function withoutPageLinks(schema: PropSchema, v: unknown): unknown {
  if (!v || typeof v !== 'object' || isBinding(v)) return v;
  switch (schema.type) {
    case 'link':
      return (v as LinkValue).type === 'page' ? { type: 'none', target: '' } : v;
    case 'richtext':
      // Older strings and malformed blocks hold no links and pass through as they are.
      return Array.isArray(v) ? v.map((b) => (!b || typeof b !== 'object' ? b : Array.isArray(b.items) ? { ...b, items: b.items.map((it: unknown) => (Array.isArray(it) ? it.map(unlinked) : it)) } : Array.isArray(b.spans) ? { ...b, spans: b.spans.map(unlinked) } : b)) : v;
    case 'list':
      return Array.isArray(v)
        ? v.map((it) => (it && typeof it === 'object' ? { ...it, ...Object.fromEntries(Object.entries(schema.fields).filter(([f]) => Object.hasOwn(it, f)).map(([f, fs]) => [f, withoutPageLinks(fs, (it as Record<string, unknown>)[f])])) } : it))
        : v;
    case 'object':
      return Array.isArray(v) ? v : { ...v, ...Object.fromEntries(Object.entries(schema.fields).filter(([f]) => Object.hasOwn(v, f)).map(([f, fs]) => [f, withoutPageLinks(fs, (v as Record<string, unknown>)[f])])) };
    default:
      return v;
  }
}
const unlinked = (s: RichSpan): RichSpan => (s && typeof s === 'object' && s.link?.type === 'page' ? { ...s, link: { type: 'none', target: '' } } : s);

/** A property as the converted source's own fallback holds it: its default, and a list's field defaults, unlinked from pages. */
function sourceFallback(schema: PropSchema): PropSchema {
  const out = { ...schema, default: withoutPageLinks(schema, schema.default) } as PropSchema;
  if (out.type === 'list' || out.type === 'object') out.fields = Object.fromEntries(Object.entries(out.fields).map(([f, fs]) => [f, { ...fs, default: withoutPageLinks(fs, fs.default) } as typeof fs]));
  return out;
}

/**
 * Before a design becomes source: each literal value in its tree that holds a page link (rich text, a link, or a
 * nested component's property, given or left at its default) becomes a property of its own, with that value as its
 * default. Source keeps only the address a page had when it was written, while a default is a link the project
 * counts, moves with its page and checks, and every placement is given it as the page is now.
 */
function promotePageLinks(state: ProjectState, def: ComponentDefinition) {
  const used = new Set(Object.keys(def.properties));
  // Names the generated code reads for itself (a variant axis, the class); every numbered form of one is too.
  const internal = (n: string) => isProtoKey(n) || /^(variant(_.*)?|class|children|__so|so_.*)$/.test(n);
  const valid = (n: string) => {
    try {
      checkPropName(n);
      return !internal(n);
    } catch {
      return false;
    }
  };
  /** A name the copy's property schema accepts: camelCase, not reserved, with room for a number. */
  const propName = (base: string) => {
    const words = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const camel = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('').replace(/^[^a-zA-Z]+/, '').replace(/^./, (c) => c.toLowerCase()).slice(0, 30);
    const root = camel && valid(camel) && !/^item$/.test(camel) ? camel : `${(camel || 'page').slice(0, 26)}Link`;
    // A name whose label property exists would look as if that label decided whether the link shows.
    for (let i = 1; i < 1000; i++) {
      const n = i === 1 ? root : `${root}${i}`;
      if (!used.has(n) && valid(n) && !used.has(labelKeyFor(n))) {
        used.add(n);
        return n;
      }
    }
    return fail(`"${def.name}" has no free name left for a property that keeps a page link.`);
  };
  const promote = (schema: PropSchema, base: string, value: unknown) => {
    if (used.size >= 60) fail(`"${def.name}" has too many properties to keep its page links as properties of a code copy. Remove a property first.`);
    const name = propName(base);
    def.properties[name] = { ...clone(schema), label: schema.label || titleCase(name), default: clone(value) } as PropSchema;
    return { $prop: name };
  };
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    const nested = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
    const code = nested?.kind === 'code';
    for (const slot of bindingSlots(n)) {
      if (isBindingRef(slot.value) || isComparison(slot.value)) continue;
      // An element that does nothing on click renders no link (see isCardLink), so its destination stays out of the
      // properties, where the site's link checks would count it.
      if (slot.field === 'link' && n.kind === 'element' && n.action === 'none') continue;
      if (slot.field === 'text' && n.kind === 'text' && n.rich) {
        if (holdsPageLink(slot.value)) slot.set(promote({ type: 'richtext', label: '', default: [] }, 'body', slot.value));
      } else if (slot.field === 'link') {
        if (holdsPageLink(slot.value)) slot.set(promote({ type: 'link', label: '', default: { type: 'none', target: '' } }, 'link', slot.value));
      } else if (slot.field === 'prop' && nested && Object.hasOwn(nested.properties, slot.prop!)) {
        const schema = nested.properties[slot.prop!];
        // The value moves as it is: the copied schema keeps the field defaults its items are filled from.
        if (showsPageLink(schema, slot.value, code)) slot.set(promote(schema, slot.prop!, slot.value));
      }
    }
    if (n.kind === 'instance' && nested)
      for (const [k, schema] of Object.entries(nested.properties)) {
        // A list worked out from the site's pages takes no value, so its fields' defaults would be written into the code.
        // Fields every row supplies itself (a story's own page link) never show their default.
        if (schema.type === 'list' && schema.feed && Object.entries(schema.fields).some(([f, fs]) => !Object.hasOwn(ARTICLE_ROW_FIELDS, f) && showsPageLink(fs, fs.default, code)))
          fail(`"${def.name}" shows “${schema.label}”, a list filled in from pages, with a page link in a field's default. A code copy would keep that page's address of today: remove the link first.`);
        if (!Object.hasOwn(n.props, k) && showsPageLink(schema, schema.default, code)) n.props[k] = promote(schema, k, schema.default);
      }
  }
}

/**
 * Whether a nested component's property value shows a link to a page, read as its schema stores it: a link, rich
 * text (unless the nested component is code that takes it as paragraph strings, which keep no links), and list items,
 * whose missing fields show the field's default.
 */
function showsPageLink(schema: PropSchema, v: unknown, code: boolean): boolean {
  if (!v || typeof v !== 'object' || isBinding(v)) return false;
  switch (schema.type) {
    case 'link':
      return (v as LinkValue).type === 'page';
    case 'richtext':
      return (!code || codeTakesBlocks(schema)) && holdsPageLink(v);
    case 'list':
      return Array.isArray(v) && v.some((it) => !!it && typeof it === 'object' && Object.entries(schema.fields).some(([f, fs]) => showsPageLink(fs, Object.hasOwn(it, f) ? (it as Record<string, unknown>)[f] : fs.default, code)));
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
    case 'icon':
    case 'image':
      return false;
    default:
      return holdsPageLink(v);
  }
}

/**
 * Names a converted code component cannot keep: a placement passes `class` as its root's classes, and a code
 * component's manifest refuses it as a property or list field name.
 */
const CODE_RESERVED_PROPS = ['class'];

/**
 * Renames what a definition converted to code cannot keep (CODE_RESERVED_PROPS): its properties of those names, and
 * its lists' fields of those names, each to a free name of its own (`classValue`, `classValue2`…, also clear of keys
 * saved values still hold). Its schema, list defaults, examples and design follow, and so do the values `placed` (the
 * placement being converted) gives it, so nothing it shows changes. A list whose rows are handed in from the design
 * around it, or handed whole to a component inside it, keeps its fields: its rows carry their keys.
 */
function moveCodeReservedProps(def: ComponentDefinition, placed: InstanceNode) {
  const free = (taken: Set<string>, from: string) => {
    let to = `${from}Value`;
    for (let i = 2; taken.has(to); i++) to = `${from}Value${i}`;
    taken.add(to);
    return to;
  };
  const keyed = <T>(o: Record<string, T>, rename: (k: string) => string) => Object.fromEntries(Object.entries(o).map(([k, v]) => [rename(k), v]));
  const examples = def.examples ?? [];
  const takenProps = new Set([...Object.keys(def.properties), ...Object.keys(placed.props), ...examples.flatMap((e) => Object.keys(e.props))]);
  const props = new Map<string, string>();
  for (const from of CODE_RESERVED_PROPS) if (Object.hasOwn(def.properties, from)) props.set(from, free(takenProps, from));
  const prop = (k: string) => props.get(k) ?? k;
  // Each list's moved fields, by the list's new name. A list whose rows come with their keys from outside (handed in
  // by the design around the placement) or go out with them (handed whole to a component inside the design, which
  // reads those keys) keeps its fields' names.
  const handedOn = new Set(Object.values(def.tree?.nodes ?? {}).flatMap((n) => (n.kind === 'instance' ? Object.values(n.props).flatMap((v) => (isBinding(v) && '$prop' in v ? [v.$prop] : [])) : [])));
  const fields = new Map<string, Map<string, string>>();
  for (const [name, schema] of Object.entries(def.properties)) {
    if (schema.type !== 'list' || isBinding(placed.props[name]) || handedOn.has(name)) continue;
    const saved = [schema.default, placed.props[name], ...examples.map((e) => e.props[name])].flatMap((v) => (Array.isArray(v) ? v : []));
    const taken = new Set([...Object.keys(schema.fields), ...saved.flatMap((it) => (it && typeof it === 'object' ? Object.keys(it) : []))]);
    const moved = new Map<string, string>();
    for (const from of CODE_RESERVED_PROPS) if (Object.hasOwn(schema.fields, from)) moved.set(from, free(taken, from));
    if (moved.size) fields.set(prop(name), moved);
  }
  if (!props.size && !fields.size) return;
  const items = (list: string, v: unknown) => {
    const moved = fields.get(list);
    return moved && Array.isArray(v) ? v.map((it) => (it && typeof it === 'object' && !isBinding(it) ? keyed(it as Record<string, unknown>, (k) => moved.get(k) ?? k) : it)) : v;
  };
  def.properties = Object.fromEntries(
    Object.entries(def.properties).map(([k, schema]): [string, PropSchema] => {
      const name = prop(k);
      const moved = fields.get(name);
      if (schema.type !== 'list' || !moved) return [name, schema];
      const f = (x: string) => moved.get(x) ?? x;
      const teaser = schema.pageTeaser ? (Object.fromEntries(Object.entries(schema.pageTeaser).map(([t, v]) => [t, typeof v === 'string' ? f(v) : v])) as typeof schema.pageTeaser) : undefined;
      return [name, { ...schema, fields: keyed(schema.fields, f), default: items(name, schema.default) as ListItem[], ...(schema.titleField ? { titleField: f(schema.titleField) } : {}), ...(teaser ? { pageTeaser: teaser } : {}) }];
    })
  );
  const values = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [prop(k), items(prop(k), v)]));
  for (const ex of examples) ex.props = values(ex.props);
  placed.props = values(placed.props);
  if (!def.tree) return;
  // Bindings sit anywhere in a node (text, conditions and their comparisons, a nested component's values and
  // variants): a property anywhere, and an item field in what a repeat over that list shows.
  const rebind = (v: unknown, list?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => rebind(x, list));
    if (!v || typeof v !== 'object') return v;
    if (isBinding(v)) {
      if ('$prop' in v && typeof v.$prop === 'string') return { ...v, $prop: prop(v.$prop) };
      if ('$item' in v && typeof v.$item === 'string' && list) return { ...v, $item: fields.get(list)?.get(v.$item) ?? v.$item };
      return v;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebind(x, list)]));
  };
  const tree = def.tree;
  const seen = new Set<string>();
  const walk = (id: string, list?: string) => {
    const n = tree.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    tree.nodes[id] = rebind(n, list) as GraphNode;
    const inner = n.kind === 'repeat' && isBinding(n.list) && '$prop' in n.list ? prop(n.list.$prop) : list;
    for (const cl of childLists(n)) for (const c of cl.ids) walk(c, inner);
  };
  tree.rootIds.forEach((r) => walk(r));
  // A node not attached to the tree still follows the renamed properties.
  for (const [id, n] of Object.entries(tree.nodes)) if (!seen.has(id)) tree.nodes[id] = rebind(n) as GraphNode;
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

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isItem = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether the generator shows a schema's default for what a placement (or a list item) stores: nothing, null, or a
 * value of the wrong kind where `resolveValue` falls back (a boolean that is not one, a list that is not an array).
 */
function showsDefault(schema: PropSchema, has: boolean, v: unknown): boolean {
  if (!has || v == null) return true;
  if (schema.type === 'boolean') return typeof v !== 'boolean';
  if (schema.type === 'list') return !Array.isArray(v);
  return false;
}

/**
 * The values a placement shows from `was` without setting them, wherever `next` would show something else: properties
 * it leaves unset, list item fields left empty, and variant axes it has not chosen on. Each is written as `was`
 * stores it (never resolved). An item field that follows its linked page is left alone unless it is missing, where
 * the old default decides whether it follows. A value `next` cannot hold is a conflict, named for the placement.
 */
function inheritedValues(state: ProjectState, node: InstanceNode, was: ComponentDefinition, next: ComponentDefinition, label: string) {
  const props: Record<string, unknown> = {};
  const variants: Record<string, string> = {};
  const conflicts: string[] = [];
  const check = (schema: PropSchema, value: unknown, what: string) => {
    try {
      // Stored as the old theme has it, so a value only the editor would refuse to take in afresh still counts.
      normalizeProp(schema, value, state, `${label}: ${was.name} → ${what}`, value);
      return true;
    } catch (e) {
      conflicts.push(e instanceof EngineError ? e.message : `${label}: ${was.name} shows a “${what}” the new theme cannot keep.`);
      return false;
    }
  };
  for (const [name, schema] of Object.entries(was.properties)) {
    const now = own(next.properties, name);
    // A list that fills itself (articles, the current page) ignores what is stored, so nothing is kept for it.
    if (!now || isBinding(node.props[name]) || (schema.type === 'list' && schema.feed)) continue;
    const inherited = showsDefault(schema, Object.hasOwn(node.props, name), node.props[name]);
    let value = inherited ? schema.default : node.props[name];
    if (inherited && value !== undefined && !sameValue(value, now.default)) {
      if (!check(now, value, now.label)) continue;
      // Styles a placement keeps for items its inherited list does not show now wait for them; once the list is its
      // own, they would be dropped as styles of removed items.
      const rows = new Set((Array.isArray(value) ? value : []).map((it) => (isItem(it) ? it.id : undefined)));
      const waiting = Object.values(node.itemOverrides ?? {}).some((e) => e?.list === name && Object.keys(e.items ?? {}).some((id) => !rows.has(id)));
      if (schema.type === 'list' && waiting) {
        conflicts.push(`${label}: ${was.name} keeps styles for “${now.label}” items its list does not show now, which the switch would drop.`);
        continue;
      }
      value = props[name] = clone(value);
    }
    // Item fields left empty show their field's default, which the new version may have changed too.
    if (schema.type !== 'list' || now.type !== 'list' || !Array.isArray(value)) continue;
    const follows = new Set(schema.pageTeaser ? teaserFields(schema.pageTeaser).map(([f]) => f) : []);
    const empty = (it: Record<string, unknown>, f: string, field: PropSchema) => (follows.has(f) ? !Object.hasOwn(it, f) : showsDefault(field, Object.hasOwn(it, f), it[f]));
    const fill = Object.entries(schema.fields).filter(([f, field]) => {
      const nf = own(now.fields, f);
      return nf && field.default !== undefined && !sameValue(field.default, nf.default) && value.some((it: unknown) => isItem(it) && empty(it, f, field));
    });
    if (!fill.length || !fill.every(([f, field]) => check(now.fields[f], field.default, `${now.label} → ${now.fields[f].label}`))) continue;
    const items = (props[name] ?? clone(value)) as unknown[];
    for (const it of items) if (isItem(it)) for (const [f, field] of fill) if (empty(it, f, field)) it[f] = clone(field.default);
    props[name] = items;
  }
  const nextAxes = new Map(axesOf(next));
  for (const [axis, a] of axesOf(was)) {
    const chosen = node.variants && Object.hasOwn(node.variants, axis) ? node.variants[axis] : undefined;
    // A bound axis is the placement's own; a code placement's choice naming no option passes nothing at all.
    if (isBindingRef(chosen) || (was.kind === 'code' && typeof chosen === 'string' && !Object.hasOwn(a.options, chosen))) continue;
    const now = nextAxes.get(axis);
    if (!now) continue;
    const pick = (x: VariantAxis) => (typeof chosen === 'string' && Object.hasOwn(x.options, chosen) ? chosen : x.default);
    const shown = pick(a);
    if (pick(now) !== shown && Object.hasOwn(now.options, shown)) variants[axis] = shown;
  }
  return { props, variants, conflicts };
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
  // What placements on pages and in the shell show without setting it themselves (a property, an item's field, a
  // variant) comes from their definition. The new theme's defaults would silently change it, so those placements
  // are given the value they show now, wherever the new default differs.
  const kept = new Map<InstanceNode, ReturnType<typeof inheritedValues>>();
  for (const t of allTrees(state)) {
    if (t.owner.kind === 'component') continue;
    for (const n of Object.values(t.tree.nodes)) {
      if (n.kind !== 'instance' || !mapping.has(n.definitionId)) continue;
      const next = mapping.get(n.definitionId)!;
      const values = inheritedValues(state, n, state.components[n.definitionId], next, t.label);
      conflicts.push(...values.conflicts);
      // Content in a slot the new version shows only inside a list this placement leaves empty would disappear.
      conflicts.push(...hiddenSlotContent(state.components[n.definitionId], next, { ...n, props: { ...n.props, ...values.props } }, t.label));
      kept.set(n, values);
    }
  }
  // Fonts ship with their theme. One the site chose itself (a site style, a text style, an element's font, a project
  // component's code) would silently fall back to a system font under a theme without it.
  const current = getTheme(state.site.themeId);
  const fontTokens = new Set(current.tokens.filter((t) => t.group === 'font').map((t) => t.id));
  for (const f of current.fonts)
    // A font the project imported itself stays whatever the theme.
    if (!theme.fonts.some((n) => n.family.toLowerCase() === f.family.toLowerCase()) && !projectFontFamilies(state).some((p) => p.family.toLowerCase() === f.family.toLowerCase()) && siteChoosesFamily(state, f.family, fontTokens))
      conflicts.push(`${f.name}: your site uses this font, which ${theme.name} does not include. Choose another font first.`);
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
    for (const n of Object.values(t.tree.nodes)) {
      if (n.kind !== 'instance' || !mapping.has(n.definitionId)) continue;
      const values = kept.get(n);
      if (values) {
        Object.assign(n.props, values.props);
        if (Object.keys(values.variants).length) n.variants = { ...(n.variants ?? {}), ...values.variants };
      }
      n.definitionId = mapping.get(n.definitionId)!.id;
    }
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
  state.themeLock.theme = themeLockEntry(theme);
  return { rebound: mapping.size };
}

/**
 * Walk a batch as applyOperations applies it, asking `check` about each operation against the project as the operations
 * before it leave it. Returns the first reason `check` gives, or null: also where the engine refuses the batch, which
 * then applies nothing anyway. The project is copied only when there is a later operation to check.
 */
export function walkOperations(state: ProjectState, ops: EditOperation[], check: (state: ProjectState, op: EditOperation) => string | null, ctx: ApplyContext = {}): string | null {
  let draft: ProjectState | null = null;
  const assetUses: NonNullable<ApplyContext['assetUses']> = {};
  const batch: ApplyContext = { ...ctx, explicitItemFields: explicitItemFields(ops), assetUses, addressesAtStart: ctx.addressesAtStart ?? addressesInUse(state) };
  for (const [i, op] of ops.entries()) {
    const reason = check(draft ?? state, op);
    if (reason) return reason;
    if (i === ops.length - 1) break;
    draft ??= clone(state);
    if (op.type !== 'asset.remove') assetUses.counts = undefined;
    try {
      applyOperation(draft, op, batch);
      dropDepartedItemStyles(draft);
    } catch {
      return null;
    }
  }
  return null;
}

/** The addresses in use in `state`, lowercased: its pages' routes and the old addresses it keeps working. */
function addressesInUse(state: ProjectState): Set<string> {
  const out = new Set<string>(Object.values(state.pages).map((p) => p.route.toLowerCase()));
  for (const r of Array.isArray(state.site.redirects) ? (state.site.redirects as unknown[]) : []) if (typeof (r as { from?: unknown })?.from === 'string') out.add((r as { from: string }).from.toLowerCase());
  return out;
}

export function applyOperations(state: ProjectState, ops: EditOperation[], ctx: ApplyContext = {}): { state: ProjectState; results: OpResult[] } {
  const draft = clone(state);
  const results: OpResult[] = [];
  const assetUses: NonNullable<ApplyContext['assetUses']> = {};
  const batch: ApplyContext = { ...ctx, explicitItemFields: explicitItemFields(ops), assetUses, addressesAtStart: ctx.addressesAtStart ?? addressesInUse(state) };
  for (const [i, op] of ops.entries()) {
    // Any edit but a removal may move an asset's uses: the next removal counts them again.
    if (op.type !== 'asset.remove') assetUses.counts = undefined;
    try {
      results.push(applyOperation(draft, op, batch));
      dropDepartedItemStyles(draft);
    } catch (e) {
      if (e instanceof EngineError) {
        e.message = ops.length > 1 ? `Operation ${i + 1} (${op.type}): ${e.message}` : e.message;
      }
      throw e;
    }
  }
  // Retagged nodes must fit where they render once the batch is done (a list item in a list, say).
  const retagged = ops.flatMap((op, i) => (op.type === 'node.setContent' && op.field === 'tag' ? [{ op, i }] : []));
  if (retagged.length) {
    const problem = batchTagProblem(state, draft, retagged.map(({ op }) => op.owner));
    // Named by the edit that retagged the node out of place, when one did; else it is where the batch leaves it.
    const by = problem ? retagged.findLast(({ op }) => op.nodeId === problem.nodeId && op.owner.kind === problem.owner.kind && op.owner.id === problem.owner.id) : undefined;
    if (problem) throw new EngineError('INVALID_ARGUMENT', ops.length > 1 && by ? `Operation ${by.i + 1} (node.setContent): ${problem.message}` : problem.message);
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
