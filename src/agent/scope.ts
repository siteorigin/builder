/**
 * Scope authority for AI runs. The application decides what a run may change; the model cannot widen it
 * by declaring a different scope. A request sent with a selection attached is limited to that element
 * until the user explicitly approves a wider change. A part selected inside a placement (its heading, one card) is
 * limited to that part: its own content and styles, never the rest of the placement. A request about one page is
 * limited to that page's sections and its own settings. A request sent while a post is open in the Posts workspace is
 * limited to that post.
 */
import type { ChatContext } from '@shared/api';
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import { keptPublishedAddresses } from '@shared/collections';
import type { EditOperation, OperationType } from '@shared/ops';
import { allTrees, displayName, enclosingRepeatProp, findParent, getTree, instancesOf, itemLinkPairs, settledRoot, subtreeIds } from '@engine/tree';
import { dependentsOf } from '@engine/definitions';
import { normalizeRoute } from '@shared/routes';
import { repeatedPartList } from '@shared/item-styles';
import { bindingSites } from '@engine/schema';
import { sourceHash, walkOperations } from '@engine/apply';
import { codeTextField, parseCodeTextPath } from '@shared/code-text';
import type { CollectionWriteGrant, LayoutOwner } from '@shared/collection-grant';
import type { SourceWriteGrant } from '@shared/sources';

/** A part selected inside a placement: the run may change only what that part shows. */
export interface PartAuthority {
  /** The node of the placement's definition the selection is in: the selected node, or the nested placement it is inside. */
  regionNodeId: string;
  /** The selected public part, when the selection is one. */
  partId?: string;
  /** The selected list item, when the part is shown once per item. */
  itemId?: string;
  /** Inside a component placed in this one: its parts cannot be changed from the outer placement on their own. */
  nested?: boolean;
  /** A code component's part: the text its code shows there, read as the request started (see codePartReach). */
  texts?: CodePartTexts;
}

/**
 * The text a code component's part shows, as the main process read it from the component's code (codecheck's
 * codePartTexts): each marked property ("primaryLabel") or list field ("features.title"), and the hash of the code it
 * was read from, so a reading of other code never stands for this one.
 */
export interface CodePartTexts {
  sourceHash: string;
  paths: string[];
}

/**
 * - site: anything the request needs.
 * - page: one page's sections (adding, changing, reordering and removing them) and its own settings, never another
 *   page, the shared header and footer (apart from a menu link to this page that the page tool adds), site styles or a
 *   component's design.
 * - selection: one element and what is inside it; with `part`, only what that part of a placement shows.
 * - component: one component's whole design, edited everywhere: every node of it (all its top-level nodes) and its
 *   own contract (properties, defaults, parts, variants and slots). Every change applies to every placement.
 * - entry: one post of a collection, open in the Posts workspace: its own words and details, filed under categories
 *   its collection already has. A new post, a new category (which can change what a feed on a page chooses) and
 *   anything on a page need the user's approval.
 * - template: one collection layout, open on the canvas (#679): its entry pages' layout or its index layout, every node
 *   of it, never a page, the shared header and footer, a component's design or the collection's entries.
 */
export type Authority =
  | { kind: 'site' }
  | { kind: 'page'; pageId: string; label: string }
  | { kind: 'selection'; owner: OwnerRef; nodeId: string; label: string; part?: PartAuthority }
  | { kind: 'component'; definitionId: string; label: string }
  | { kind: 'entry'; collectionId: string; entryId: string; label: string }
  | { kind: 'template'; owner: LayoutOwner; label: string };

/** How a page is named where a run's limit is said: "the About page". */
export const pageLabel = (title: unknown) => `the ${(typeof title === 'string' && title.trim()) || 'current'} page`;

/** How a post is named where a run's limit is said: the post “Spring open studio”. */
export const postLabel = (title: unknown) => `the post “${(typeof title === 'string' && title.trim()) || 'Untitled'}”`;

/** How a collection layout is named where a run's limit is said: “the Team layout”, “the Team index layout”. */
export function layoutLabel(state: ProjectState, owner: LayoutOwner): string {
  const c = Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id] : undefined;
  // A document edited by hand may hold anything as its name: only text is one.
  const name = typeof c?.settings?.name === 'string' ? c.settings.name.trim() : '';
  return `the ${name || owner.id} ${owner.kind === 'archive' ? 'index layout' : 'layout'}`;
}

/** The layout a request was sent from, while its collection still has it (an index layout only while it is designed). */
export function liveLayout(state: ProjectState, owner: LayoutOwner): boolean {
  const c = Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id] : undefined;
  const tree = owner.kind === 'archive' ? c?.settings?.archiveTemplate : c?.settings?.template;
  return !!tree && Array.isArray(tree.rootIds) && !!tree.nodes && typeof tree.nodes === 'object';
}

/** The post a request names, while its collection still has it. */
export function liveEntry(state: ProjectState, collectionId: string, entryId: string) {
  const c = Object.hasOwn(state.collections ?? {}, collectionId) ? state.collections[collectionId] : undefined;
  return c && Object.hasOwn(c.entries, entryId) ? c.entries[entryId] : undefined;
}

/**
 * What a request may change as it starts, from what it was sent with. A request that chose its scope says so; one
 * saved before scopes could be chosen means what it meant then: its selection, its component, or the whole site.
 */
export function requestAuthority(ctx: Pick<ChatContext, 'pageId' | 'pageTitle' | 'selection' | 'selectionLabel' | 'component' | 'scope' | 'post' | 'template'> | undefined, state: ProjectState): Authority {
  // A collection layout open on the canvas: the request is about it, never the page behind it.
  if (ctx?.template && !ctx.component && !ctx.post) {
    const owner: LayoutOwner = { kind: ctx.template.archive ? 'archive' : 'template', id: ctx.template.collectionId };
    return { kind: 'template', owner, label: layoutLabel(state, owner) };
  }
  // A post open in the Posts workspace: the request is about it, whatever page lies under the writer. Named as it is now.
  if (ctx?.post && !ctx.component) {
    const { collectionId, entryId, title } = ctx.post;
    return { kind: 'entry', collectionId, entryId, label: postLabel(liveEntry(state, collectionId, entryId)?.title ?? title) };
  }
  if (ctx?.scope === 'page' && !ctx.component) {
    // Named as it is now: the run's messages talk about the page the author sees.
    const live = Object.hasOwn(state.pages, ctx.pageId) ? state.pages[ctx.pageId].title : ctx.pageTitle;
    return { kind: 'page', pageId: ctx.pageId, label: pageLabel(live) };
  }
  if (ctx?.scope === 'site' && !ctx.component) return { kind: 'site' };
  return authorityFor(ctx?.selection ?? null, ctx?.selectionLabel ?? null, ctx?.component, state);
}

/**
 * `component`: the component the author is editing everywhere; a selection inside it narrows the run further.
 * `state` is the project the selection was made in: it tells a part apart from the whole placement.
 */
export function authorityFor(selection: ElementRef | null, label: string | null, component?: { id: string; name: string } | null, state?: ProjectState): Authority {
  if (!selection) return component ? { kind: 'component', definitionId: component.id, label: component.name } : { kind: 'site' };
  const authority: Extract<Authority, { kind: 'selection' }> = { kind: 'selection', owner: selection.owner, nodeId: selection.instancePath[0] ?? selection.nodeId, label: label ?? 'the selection' };
  if (!selection.instancePath.length) return authority;
  const part: PartAuthority = {
    regionNodeId: selection.instancePath[1] ?? selection.nodeId,
    ...(selection.instancePath.length === 1 && selection.partId ? { partId: selection.partId } : {}),
    ...(selection.itemPath?.length ? { itemId: selection.itemPath[selection.itemPath.length - 1] } : {}),
    ...(selection.instancePath.length > 1 ? { nested: true } : {})
  };
  // Without the project, a part is assumed; with it, a selection that is really the whole placement is one.
  return !state || selectedPart(state, { ...authority, part }) ? { ...authority, part } : authority;
}

/** What a part of a definition shows, read from the definition's bindings. */
export interface PartReach {
  /** Properties shown only inside the part, wherever they are used (conditions included): changing one changes nothing else. */
  props: Set<string>;
  /** For a part inside a repeated item: each list, and the item fields shown only inside the part. */
  itemFields: Map<string, Set<string>>;
  /** The definition's nodes inside the part. */
  nodes: Set<string>;
  /** The part is shown once per item of a list: a placement property shown inside it shows in every item. */
  repeated: boolean;
  /** The declared slots the part renders: content placed in them is inside it. */
  slots: Set<string>;
}

const NOTHING: PartReach = { props: new Set(), itemFields: new Map(), nodes: new Set(), repeated: false, slots: new Set() };

/**
 * What a part of a code component shows (#1416), which has no tree to say: the text its code marks inside it, as read
 * from the code the request started with (`texts`), among the properties and list fields the component still declares
 * as text the canvas can type over. Without that reading, or once the code has changed, the part reaches nothing but
 * its own styles. A part picked in one item of a list is shown once per item.
 */
export function codePartReach(def: ComponentDefinition, part: { partId?: string; itemId?: string }, texts: CodePartTexts | undefined): PartReach {
  if (!texts || !part.partId || def.kind !== 'code' || typeof def.source !== 'string' || sourceHash(def.source) !== texts.sourceHash) return NOTHING;
  const props = new Set<string>();
  const itemFields = new Map<string, Set<string>>();
  for (const written of texts.paths) {
    const path = parseCodeTextPath(written);
    if (!path || 'problem' in codeTextField(def.properties, path)) continue;
    if (path.field === undefined) props.add(path.prop);
    else itemFields.set(path.prop, (itemFields.get(path.prop) ?? new Set()).add(path.field));
  }
  const own = Object.hasOwn(def.parts, part.partId) ? def.parts[part.partId] : undefined;
  return { props, itemFields, nodes: new Set(), repeated: !!own?.list || part.itemId !== undefined, slots: new Set() };
}

export function partReach(def: ComponentDefinition, regionNodeId: string): PartReach {
  const tree = def.tree;
  const nodes = new Set(tree && Object.hasOwn(tree.nodes, regionNodeId) ? subtreeIds(tree, regionNodeId) : []);
  // Whether every use of a property, or of an item field of a list, is inside the part.
  const only = new Map<string, boolean>();
  const fields = new Map<string, Map<string, boolean>>();
  /** A node's ancestors in the definition, nearest first. */
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    let at = tree ? findParent(tree, id)?.parentId : null;
    // Never longer than the tree, however deep it nests.
    for (let guard = 0; at && tree && guard <= Object.keys(tree.nodes).length; guard++) {
      out.push(at);
      at = findParent(tree, at)?.parentId;
    }
    return out;
  };
  // A list repeated inside another repeat shows the same items in every outer item: one of its items is not one place.
  const insideAnotherRepeat = (id: string) => [id, ...ancestors(id)].filter((a) => tree?.nodes[a]?.kind === 'repeat').length > 1;
  const around = new Set(nodes.size ? ancestors(regionNodeId) : []);
  /** Where each property is used, by node: a list's items change wherever the list is used, not only where it repeats. */
  const propSites = new Map<string, string[]>();
  for (const site of bindingSites(def)) {
    // UI state is the design's own: no placement's content reaches it.
    if ('$state' in site.binding || '$entry' in site.binding) continue;
    const inside = nodes.has(site.node.id);
    if ('$prop' in site.binding) {
      only.set(site.binding.$prop, (only.get(site.binding.$prop) ?? true) && inside);
      propSites.set(site.binding.$prop, [...(propSites.get(site.binding.$prop) ?? []), site.node.id]);
      continue;
    }
    const list = enclosingRepeatProp(def, site.node.id);
    if (!list) continue;
    const uses = fields.get(list) ?? new Map<string, boolean>();
    uses.set(site.binding.$item, (uses.get(site.binding.$item) ?? true) && inside && !insideAnotherRepeat(site.node.id));
    fields.set(list, uses);
  }
  // A list's category filter reads its field for the row of pills above the list: no part inside the list holds that.
  for (const n of Object.values(tree?.nodes ?? {})) {
    if (n?.kind !== 'repeat' || !n.filter || typeof n.filter.field !== 'string' || !isBinding(n.list) || !('$prop' in n.list)) continue;
    const host = findParent(tree!, n.id)?.parentId;
    const uses = fields.get(n.list.$prop) ?? new Map<string, boolean>();
    uses.set(n.filter.field, (uses.get(n.filter.field) ?? true) && !!host && nodes.has(host));
    fields.set(n.list.$prop, uses);
  }
  const itemFields = new Map<string, Set<string>>();
  for (const [list, uses] of fields) {
    // An item of a list also passed on or shown elsewhere (another component given the same list) changes there too.
    if ((propSites.get(list) ?? []).some((id) => !nodes.has(id) && !(around.has(id) && tree?.nodes[id]?.kind === 'repeat'))) continue;
    const own = new Set([...uses].filter(([, inside]) => inside).map(([f]) => f));
    // A visible text that carries its link along when it changes (an email and its mailto) is inside only with the link.
    for (const { text, link } of itemLinkPairs(def, list)) if (own.has(text) && !own.has(link)) own.delete(text);
    // A page card's link also decides the title, text and picture its empty fields show from the linked page.
    const schema = def.properties[list];
    const teaser = schema?.type === 'list' ? schema.pageTeaser : undefined;
    if (teaser && own.has(teaser.link) && [teaser.title, teaser.description, teaser.image].some((f) => f && uses.has(f) && !own.has(f))) own.delete(teaser.link);
    if (own.size) itemFields.set(list, own);
  }
  // A slot placeholder shown twice (in a duplicated container, say) shows its content in both: only one inside is the part's.
  const placeholders = (name: string) => Object.values(tree?.nodes ?? {}).filter((n) => n.kind === 'slot' && n.slot === name).map((n) => n.id);
  const slots = new Set<string>();
  for (const id of nodes) {
    const n = tree!.nodes[id];
    if (n?.kind === 'slot' && placeholders(n.slot).every((p) => nodes.has(p))) slots.add(n.slot);
  }
  return { props: new Set([...only].filter(([, inside]) => inside).map(([p]) => p)), itemFields, nodes, repeated: nodes.size > 0 && !!enclosingRepeatProp(def, regionNodeId), slots };
}

/**
 * The placement a part authority is in, its definition and what the part reaches, or null for the whole placement (its
 * definition's root). A part inside a nested component reaches nothing but its own styles, and one of a code component
 * (which has no tree to say what its parts show) only the text its code marks inside it (codePartReach): anything
 * more needs the user's approval.
 */
function selectedPart(state: ProjectState, authority: Extract<Authority, { kind: 'selection' }>): { def: ComponentDefinition; inst: InstanceNode; reach: PartReach; part: PartAuthority } | null {
  const part = authority.part;
  if (!part) return null;
  let inst: GraphNode | undefined;
  try {
    inst = getTree(state, authority.owner).nodes[authority.nodeId];
  } catch {
    return null;
  }
  const def = inst?.kind === 'instance' ? state.components[inst.definitionId] : undefined;
  if (!def || inst?.kind !== 'instance') return null;
  // A code component's root part is the placement itself.
  if (!part.nested && !def.tree && part.partId === 'root') return null;
  if (part.nested) return { def, inst, reach: NOTHING, part };
  if (!def.tree) return { def, inst, reach: codePartReach(def, part, part.texts), part };
  // Only the first top-level node is the placement itself; another is a part like any other.
  if (def.tree.rootIds[0] === part.regionNodeId) return null;
  return { def, inst, reach: partReach(def, part.regionNodeId), part };
}

/** Why an operation on the placement itself reaches beyond its selected part, or null when it stays inside. */
function outsidePart(op: EditOperation, sel: NonNullable<ReturnType<typeof selectedPart>>, label: string): string | null {
  const { def, reach, part } = sel;
  const beyond = `${op.type} changes more of ${label} than the selected part.`;
  if (part.nested) return `${op.type} changes more than the selected part, which is inside another component placed in ${label}.`;
  // A placement property shown in a repeated part shows in every item, not only the selected one.
  const whole = (prop: string) => reach.props.has(prop) && !(part.itemId !== undefined && reach.repeated);
  switch (op.type) {
    case 'node.setStyle':
    case 'node.resetStyles': {
      const partId = op.partId ?? 'root';
      const own = Object.hasOwn(def.parts, partId) ? def.parts[partId] : undefined;
      if (partId !== part.partId && !(own && reach.nodes.has(own.nodeId))) return `${op.type} styles a part of ${label} other than the selected one.`;
      // With one item selected, a part shown for every item is styled for that item alone: its shared style is every item's.
      // A code component's part picked in one item stays that item's: if its code no longer repeats it, styling it
      // would reach every item, which needs the user's approval.
      const shownPerItem = !!own && (def.tree ? !!enclosingRepeatProp(def, own.nodeId) : true);
      if (part.itemId !== undefined && shownPerItem) {
        if (!repeatedPartList(def, partId)) return `${op.type} would style every item of ${label}: this part cannot be styled for one item alone, so ask the user first.`;
        if (op.itemId !== part.itemId) return `${op.type} styles ${op.itemId === undefined ? 'every item' : 'another item'} of ${label}, not only the selected one: pass itemId "${part.itemId}", or ask the user before styling more.`;
      }
      return null;
    }
    case 'instance.setProp': {
      // The engine treats an empty item ID as none: the whole list.
      if (!op.itemId) return whole(op.prop) ? null : beyond;
      if (whole(op.prop)) return null;
      const fields = reach.itemFields.get(op.prop);
      if (!fields) return beyond;
      if (part.itemId !== undefined && op.itemId !== part.itemId) return `${op.type} changes an item of ${label} other than the selected one.`;
      const sent = op.field ? [op.field] : op.value && typeof op.value === 'object' && !Array.isArray(op.value) ? Object.keys(op.value) : [];
      return sent.every((f) => fields.has(f)) ? null : `${op.type} changes fields of the item that the selected part does not show.`;
    }
    case 'instance.listInsert':
    case 'instance.listRemove':
    case 'instance.listMove':
    case 'instance.editTable':
      return whole(op.prop) ? null : beyond;
    default:
      return beyond;
  }
}

/** Content placed in the slots a selected part renders, in the owner's tree: it is inside the part. */
function slotContent(state: ProjectState, owner: OwnerRef, sel: NonNullable<ReturnType<typeof selectedPart>>): Set<string> {
  const out = new Set<string>();
  // A slot inside a repeated part shows the same content in every item: not one selected item's.
  if (!sel.reach.slots.size || (sel.part.itemId !== undefined && sel.reach.repeated)) return out;
  const tree = getTree(state, owner);
  for (const name of sel.reach.slots) for (const child of sel.inst.slots?.[name] ?? []) for (const id of subtreeIds(tree, child)) out.add(id);
  return out;
}

/** Whether a destination is inside a selected part: content in a slot it renders, or that slot of the placement itself. */
function inPartSlot(parentId: string | null | undefined, slot: string | undefined, sel: NonNullable<ReturnType<typeof selectedPart>>, placed: Set<string>): boolean {
  // A slot inside a repeated part shows the same content in every item: not one selected item's.
  if (!parentId || (sel.part.itemId !== undefined && sel.reach.repeated)) return false;
  if (parentId === sel.inst.id) return slot !== undefined && sel.reach.slots.has(slot);
  return placed.has(parentId);
}

/** Content fields the engine writes to a property's default when they are bound in a definition (see nodeSetContent). */
const BOUND_FIELDS = new Set(['text', 'image', 'link', 'label', 'icon', 'iconPosition', 'action', 'ariaLabel', 'tag']);

/** Whether an edit inside a definition writes a property's default, which every placement without its own value shows. */
function writesDefault(state: ProjectState, op: EditOperation): string | null {
  if (op.type !== 'node.setContent' || op.owner.kind !== 'component' || !BOUND_FIELDS.has(op.field)) return null;
  let node: GraphNode | undefined;
  try {
    node = getTree(state, op.owner).nodes[op.nodeId];
  } catch {
    return null;
  }
  const current = node ? (node as unknown as Record<string, unknown>)[op.field] : undefined;
  return isBinding(current) && '$prop' in current ? `node.setContent changes the default of the "${current.$prop}" property, which every placement of this component without its own value shows.` : null;
}

/** Whether a run may change a component's own contract (its properties, parts, variants, slots and bindings). These
 *  are visual edits to a managed component, never code, so they do not depend on Developer mode. A page's run never
 *  may: a component's contract shows on every page it is placed on. */
export function canEditContracts(authority: Authority): boolean {
  if (authority.kind === 'page' || authority.kind === 'entry' || authority.kind === 'template') return false;
  return authority.kind !== 'selection' || authority.owner.kind === 'component';
}

/**
 * How far each operation reaches, for a run limited to a selection:
 * - node: changes one node, which must be inside the selection.
 * - insert / copy: adds content, whose destination must be inside the selection.
 * - definition: adds to the contract of the component being edited, when the selection is inside it.
 * - wider: changes pages, site styles, shared definitions or assets, so it needs the user's approval.
 * Typed over every operation, so a new operation does not compile until it is classified here.
 */
export type OpReach = 'node' | 'insert' | 'copy' | 'definition' | 'wider';

export const OP_REACH: Record<OperationType, OpReach> = {
  'page.create': 'wider',
  'page.update': 'wider',
  'page.duplicate': 'wider',
  'page.reorder': 'wider',
  'page.remove': 'wider',
  'page.setHome': 'wider',
  'redirect.add': 'wider',
  'redirect.update': 'wider',
  'redirect.remove': 'wider',
  'node.insert': 'insert',
  'node.remove': 'node',
  // One node, whose content takes its place in the same list: checkOne keeps the selection itself from it.
  'node.removeKeepContent': 'node',
  'node.move': 'node',
  // Several siblings of one list at once; checkOne and checkComponentAuthority check each one.
  'node.wrap': 'node',
  'node.unwrap': 'node',
  'node.duplicate': 'node',
  'node.copy': 'copy',
  // The editor's own clipboard; the session refuses it from an AI run.
  'node.paste': 'wider',
  'node.rename': 'node',
  'node.setStyle': 'node',
  'node.resetStyles': 'node',
  'node.setContent': 'node',
  'node.setBinding': 'node',
  'node.setStateAction': 'node',
  'instance.setProp': 'node',
  // One placement's list, or one loop: the node's own, reading the collection without changing it.
  'instance.setListSource': 'node',
  'node.setRepeatSource': 'node',
  'instance.listInsert': 'node',
  'instance.listRemove': 'node',
  'instance.listMove': 'node',
  'instance.editTable': 'node',
  'instance.setVariant': 'node',
  // The placement changes design where it is; the components themselves stay as they are.
  'instance.swapComponent': 'node',
  'token.set': 'wider',
  'token.setColorScheme': 'wider',
  'token.create': 'wider',
  'token.rename': 'wider',
  'token.remove': 'wider',
  'token.replace': 'wider',
  'site.update': 'wider',
  'brief.update': 'wider',
  'component.create': 'wider',
  // A rebuild moves every placement to the new contract.
  'component.upsert': 'wider',
  'component.createFromNode': 'wider',
  'component.makeUnique': 'node',
  // Only the placement's own page changes: the component and its other placements stay as they are.
  'component.detachInstance': 'node',
  'component.duplicate': 'wider',
  'component.rename': 'wider',
  'component.setInsertAs': 'wider',
  'component.fork': 'wider',
  'component.convertToCode': 'node',
  'component.createCode': 'wider',
  'component.updateSource': 'wider',
  'component.remove': 'wider',
  'component.import': 'wider',
  'component.setPropSchema': 'definition',
  'component.removePropSchema': 'wider',
  // The order every placement's Content lists the properties in.
  'component.orderProperties': 'wider',
  // A new default changes every placement without a value of its own.
  'component.setPropDefault': 'wider',
  'component.setPart': 'definition',
  'component.removePart': 'wider',
  'component.setVariant': 'definition',
  'component.removeVariant': 'wider',
  'component.setSlot': 'definition',
  'component.removeSlot': 'wider',
  // Its content can move into every placement.
  'component.containerToSlot': 'wider',
  'component.setState': 'definition',
  'component.removeState': 'wider',
  'theme.apply': 'wider',
  'theme.refresh': 'wider',
  'asset.add': 'wider',
  'asset.update': 'wider',
  'asset.remove': 'wider',
  'asset.replace': 'wider',
  'asset.relink': 'wider',
  // Collections are the editor's only, for now: the session refuses them from an AI run.
  'collection.create': 'wider',
  'collection.update': 'wider',
  'collection.remove': 'wider',
  'collection.createTerm': 'wider',
  'collection.renameTerm': 'wider',
  'collection.removeTerm': 'wider',
  'entry.create': 'wider',
  'entry.update': 'wider',
  'entry.reorder': 'wider',
  'entry.remove': 'wider',
  // External sources are the editor's only: the session refuses them from an AI run.
  'source.upsert': 'wider',
  'source.remove': 'wider'
};

/**
 * Whether a contract edit stays within a selection inside that component. Only additions qualify: changing
 * or removing an existing property, part, variant or slot affects content outside the selected element.
 */
function definitionOpAllowed(state: ProjectState, op: EditOperation, authority: Extract<Authority, { kind: 'selection' }>, allowed: Set<string>): boolean {
  if (authority.owner.kind !== 'component') return false;
  const def = state.components[authority.owner.id];
  if (!def) return false;
  switch (op.type) {
    case 'component.setPropSchema':
      return op.definitionId === def.id && !Object.hasOwn(def.properties, op.prop);
    case 'component.setPart':
      return op.definitionId === def.id && !Object.hasOwn(def.parts, op.partId) && allowed.has(op.nodeId);
    case 'component.setVariant':
      // A first variant adds a new choice to every placement's Inspector, so it is not a local addition.
      return op.definitionId === def.id && !op.makeDefault && addsOptionToExistingAxis(def, op.variant, op.axis, op.axisLabel, op.prop);
    case 'component.setSlot':
      return op.definitionId === def.id && !Object.hasOwn(def.slots ?? {}, op.slot);
    default:
      return false;
  }
}

/** A new option on an axis that already exists changes no placement; a new axis gives every placement a new choice. */
function addsOptionToExistingAxis(def: ComponentDefinition, option: string, axis?: string, axisLabel?: string, prop?: string): boolean {
  const axes = Object.keys(def.variantAxes ?? {});
  const id = axis ?? (axes.length === 1 ? axes[0] : undefined);
  const target = id !== undefined && Object.hasOwn(def.variantAxes ?? {}, id) ? def.variantAxes![id] : undefined;
  // Renaming the axis shows in every placement's Inspector; moving a code axis to another prop changes what every
  // placement passes.
  if (axisLabel !== undefined && axisLabel.trim() !== target?.label) return false;
  if (prop !== undefined && prop !== target?.prop) return false;
  return !!target && !Object.hasOwn(target.options, option);
}

/**
 * Contract edits a run on a component's whole design may make to that component. Changing or removing an existing
 * property, default, part, variant or slot is what editing a component everywhere is for; the engine still
 * validates each one.
 */
const CONTRACT_EDITS = new Set<OperationType>([
  'component.setPropSchema',
  'component.removePropSchema',
  'component.setPropDefault',
  'component.setPart',
  'component.removePart',
  'component.setVariant',
  'component.removeVariant',
  'component.setSlot',
  'component.removeSlot',
  'component.containerToSlot',
  'component.setState',
  'component.removeState'
]);

/** Returns null when every operation stays within one component's own design, otherwise a reason. */
function checkComponentAuthority(state: ProjectState, ops: EditOperation[], authority: Extract<Authority, { kind: 'component' }>): string | null {
  const def = state.components[authority.definitionId];
  // A code component's design is its source: a patch to it is a change to that component alone.
  if (def?.kind === 'code' && ops.every((op) => op.type === 'component.updateSource' && op.definitionId === def.id)) return null;
  if (!def?.tree) return `${authority.label} is no longer in the site.`;
  const nodes = def.tree.nodes;
  // The first top-level node is the component's own root: placements' classes and variants style it, so it stays
  // first. The engine keeps anything else from joining it at the top level (a design from an older version may still
  // have other top-level nodes after it).
  const root = def.tree.rootIds[0];
  const beforeRoot = (parentId: string | null | undefined, index: number | undefined) => !parentId && !!root && index === 0;
  // A design from an older version without its one root is put right by a container that goes first and holds the
  // others, the old first root included (see the engine's `settledRoot`).
  const unsettled = !settledRoot(def.tree);
  const insideRoot = new Set(root ? subtreeIds(def.tree, root) : []);
  const repair = (op: EditOperation) =>
    unsettled &&
    ((op.type === 'node.insert' && !op.parentId && !!op.primitive && ['container', 'stack', 'row', 'grid'].includes(op.primitive)) ||
      (op.type === 'node.move' && op.nodeId === root && !!op.parentId && !insideRoot.has(op.parentId)));
  const rootFirst = `The first top-level node of ${authority.label} is its root, which every placement and variant styles: keep it first, and put new content inside it.`;
  const mine = (o: OwnerRef) => o.kind === 'component' && o.id === def.id;
  /** A node of the design, or its top level (null). */
  const inside = (id: string | null | undefined) => !id || Object.hasOwn(nodes, id);
  const outside = (op: EditOperation) => `${op.type} changes something outside ${authority.label}.`;
  for (const op of ops) {
    if (CONTRACT_EDITS.has(op.type)) {
      if ((op as { definitionId?: string }).definitionId !== def.id) return outside(op);
      // Removing a slot removes its placeholder too, which may be the root.
      const first = root ? nodes[root] : undefined;
      if (op.type === 'component.removeSlot' && first?.kind === 'slot' && first.slot === op.slot) return `component.removeSlot: ${rootFirst}`;
      continue;
    }
    // Both add a new component to the site, for one placement inside the design.
    if (op.type === 'component.makeUnique' || op.type === 'component.convertToCode') return `${op.type} adds a new component to the site, which changes more than ${authority.label}.`;
    // Siblings wrapped or ungrouped where they are: each one in the design, and never its root.
    if (op.type === 'node.wrap' || op.type === 'node.unwrap') {
      if (!mine(op.owner) || !op.nodeIds.every((id) => Object.hasOwn(nodes, id))) return outside(op);
      if (root && op.nodeIds.includes(root)) return `${op.type}: ${rootFirst}`;
      continue;
    }
    switch (OP_REACH[op.type] ?? 'wider') {
      case 'node': {
        const o = op as unknown as { owner: OwnerRef; nodeId: string; parentId?: string | null; index?: number };
        if (!mine(o.owner) || !Object.hasOwn(nodes, o.nodeId)) return outside(op);
        if (op.type === 'node.move' && !inside(o.parentId)) return `node.move would move content outside ${authority.label}.`;
        if (op.type === 'node.move' && !repair(op) && (o.nodeId === root ? !(!o.parentId && o.index === 0) : beforeRoot(o.parentId, o.index))) return `node.move: ${rootFirst}`;
        if ((op.type === 'node.remove' || op.type === 'node.removeKeepContent') && o.nodeId === root) return `${op.type}: ${rootFirst}`;
        break;
      }
      case 'insert': {
        const o = op as Extract<EditOperation, { type: 'node.insert' }>;
        if (!mine(o.owner) || !inside(o.parentId)) return `node.insert adds content outside ${authority.label}.`;
        if (!repair(op) && beforeRoot(o.parentId, o.index)) return `node.insert: ${rootFirst}`;
        break;
      }
      case 'copy': {
        // The source is only read, so it may be anywhere; the copy must land in the design.
        const o = op as Extract<EditOperation, { type: 'node.copy' }>;
        if (!mine(o.toOwner) || !inside(o.parentId)) return `node.copy adds content outside ${authority.label}.`;
        if (beforeRoot(o.parentId, o.index)) return `node.copy: ${rootFirst}`;
        break;
      }
      default:
        return `${op.type} changes more than ${authority.label}.`;
    }
  }
  return null;
}

/** Settings of a page that are its own. A new route moves the pages inside it and keeps the old address working
 *  site-wide, and a translation joins or leaves another page's group, so neither is the page's alone. */
const PAGE_SETTINGS = new Set(['title', 'navLabel', 'seoTitle', 'description', 'noindex', 'searchHidden', 'draft', 'language', 'showHeader', 'showFooter', 'socialImage', 'canonical', 'updatedAt', 'articleDate', 'byline', 'excerpt', 'article', 'newsHidden', 'structuredData']);

/** What a page's run may also do, granted by the tool call that sends the batch: never by the model. */
export interface AuthorityGrants {
  /** The menu links to the page that the page tool compiled, because the call asked for them (addToHeaderNav,
   *  addToFooterNav). Only these exact insertions reach the shared header and footer. */
  navigation?: EditOperation[];
  /** The one post (and the categories it is filed under) the post tool's call writes: the project refuses every other
   *  collection change from a run (see shared/collection-grant). */
  collectionWrite?: CollectionWriteGrant;
  /** The one installed theme component the theme update tool's call updates (see agent/theme-update.ts). */
  themeRefresh?: string;
  /** The one source mapping or converter the source tool's call tested (see agent/source-tools.ts): the project
   *  refuses every other source change from a run. */
  sourceWrite?: SourceWriteGrant;
}

/**
 * Whether a theme update the update tool asked for stays within what a page or a selection may change. An update
 * changes how every placement of the component shows, so it is theirs only when every placement is: on the page, or
 * inside the selected element (a selected shared header, say). Anything else (a raw or bulk update, or a component
 * placed elsewhere too) needs the user to approve a wider change.
 */
function themeRefreshWithin(state: ProjectState, op: Extract<EditOperation, { type: 'theme.refresh' }>, grants: AuthorityGrants, label: string, inside: (owner: OwnerRef, nodeId: string) => boolean): string | null {
  const id = op.definitionIds?.length === 1 ? op.definitionIds[0] : undefined;
  if (!id || id !== grants.themeRefresh) return `theme.refresh changes more than ${label}.`;
  const name = Object.hasOwn(state.components, id) ? state.components[id].name : id;
  const placed = instancesOf(state, id);
  if (!placed.length || !placed.every((p) => inside(p.owner, p.node.id))) return `Updating "${name}" changes every placement of it, and some are outside ${label}: ask the user to approve a wider change first.`;
  return null;
}

const sameOp = (a: EditOperation, b: EditOperation) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * One operation of a run limited to a collection layout: it changes a node of that layout, or adds one to it. A
 * component placed there is installed as on a page; nothing else reaches beyond the layout.
 */
function checkLayoutOne(state: ProjectState, op: EditOperation, authority: Extract<Authority, { kind: 'template' }>): string | null {
  const { label, owner } = authority;
  if (!liveLayout(state, owner)) return `${label[0].toUpperCase()}${label.slice(1)} is no longer in the site.`;
  const mine = (o: OwnerRef | undefined) => o?.kind === owner.kind && o.id === owner.id;
  // A new component made from a placement, or its code, is one every page could place.
  if (op.type === 'component.makeUnique' || op.type === 'component.convertToCode') return `${op.type} adds a new component to the site, which changes more than ${label}.`;
  switch (OP_REACH[op.type] ?? 'wider') {
    case 'node':
      return mine((op as { owner?: OwnerRef }).owner) ? null : `${op.type} changes something outside ${label}.`;
    case 'insert':
      return mine((op as Extract<EditOperation, { type: 'node.insert' }>).owner) ? null : `node.insert adds content outside ${label}.`;
    default:
      return `${op.type} changes more than ${label}.`;
  }
}

function checkPageOne(state: ProjectState, op: EditOperation, authority: Extract<Authority, { kind: 'page' }>, grants: AuthorityGrants): string | null {
  const { label } = authority;
  if (!Object.hasOwn(state.pages, authority.pageId)) return `${label[0].toUpperCase()}${label.slice(1)} is no longer in the site.`;
  const mine = (o: OwnerRef | undefined) => o?.kind === 'page' && o.id === authority.pageId;
  const outside = `${op.type} changes something outside ${label}.`;
  switch (op.type) {
    case 'page.update': {
      if (op.pageId !== authority.pageId) return `page.update changes another page, not ${label}.`;
      const wider = Object.keys(op).filter((k) => k !== 'type' && k !== 'pageId' && !PAGE_SETTINGS.has(k));
      if (wider.length) return `page.update ${wider.join(' and ')} changes more than ${label}: it reaches other pages.`;
      // A draft published takes over an old address the site keeps working at its route, which is the site's (#1363).
      const page = state.pages[authority.pageId];
      const kept: unknown[] = [...(Array.isArray(state.site.redirects) ? state.site.redirects : []), ...keptPublishedAddresses(state)];
      const at = (r: unknown) => typeof (r as { from?: unknown })?.from === 'string' && (r as { from: string }).from.toLowerCase() === page.route.toLowerCase();
      if (op.draft === false && page.draft === true && kept.some(at)) return `page.update draft publishes ${label} at ${page.route}, an old address the site keeps sending visitors on from, which changes more than ${label}.`;
      return null;
    }
    // Each adds a new component to the site, which every page can then place.
    case 'component.makeUnique':
    case 'component.convertToCode':
    case 'component.fork':
      return `${op.type} adds a new component to the site, which changes more than ${label}.`;
    case 'instance.listInsert':
      // A menu link to this page, added because the page tool was asked to add it.
      if (op.owner.kind === 'shell' && (grants.navigation ?? []).some((g) => sameOp(g, op))) return null;
      break;
    case 'theme.refresh':
      return themeRefreshWithin(state, op, grants, label, (o) => mine(o));
  }
  switch (OP_REACH[op.type] ?? 'wider') {
    case 'node':
      return mine((op as { owner?: OwnerRef }).owner) ? null : outside;
    case 'insert':
      return mine((op as Extract<EditOperation, { type: 'node.insert' }>).owner) ? null : `node.insert adds content outside ${label}.`;
    case 'copy':
      // The source is only read, so it may be anywhere; the copy must land on the page.
      return mine((op as Extract<EditOperation, { type: 'node.copy' }>).toOwner) ? null : `node.copy adds content outside ${label}.`;
    case 'definition':
      // A component's contract shows wherever it is placed, on every page.
      return `${op.type} changes a component's design, which shows on every page it is placed on: more than ${label}.`;
    default:
      return `${op.type} changes more than ${label}.`;
  }
}

/**
 * Returns null when every operation stays within the authority, otherwise a reason. Within a selection or a page, each
 * operation is checked against the project as the operations before it leave it, so a batch cannot bind a field and
 * then write the default it bound, and a section a batch adds can be changed later in it.
 */
export function checkAuthority(state: ProjectState, ops: EditOperation[], authority: Authority, grants: AuthorityGrants = {}): string | null {
  const step = authorityCheck(state, ops, authority, grants);
  return typeof step === 'function' ? walkOperations(state, ops, step) : step;
}

/**
 * `checkAuthority` without its walk: the reason (or null) when no walk is needed to know it, otherwise what to ask of
 * each operation in a walk of the batch (walkChecks).
 */
export function authorityCheck(state: ProjectState, ops: EditOperation[], authority: Authority, grants: AuthorityGrants = {}): string | null | ((draft: ProjectState, op: EditOperation) => string | null) {
  if (authority.kind === 'site') return null;
  if (authority.kind === 'component') return checkComponentAuthority(state, ops, authority);
  if (authority.kind === 'entry') return checkEntryAuthority(state, ops, authority);
  if (authority.kind === 'template') return (draft, op) => checkLayoutOne(draft, op, authority);
  if (authority.kind === 'page') return (draft, op) => checkPageOne(draft, op, authority, grants);
  return (draft, op) => checkOne(draft, op, authority, grants);
}

function checkOne(state: ProjectState, op: EditOperation, authority: Extract<Authority, { kind: 'selection' }>, grants: AuthorityGrants = {}): string | null {
  let allowed: Set<string>;
  try {
    const tree = getTree(state, authority.owner);
    allowed = new Set(subtreeIds(tree, authority.nodeId));
  } catch {
    return 'The selected element no longer exists.';
  }
  // Gone since it was selected (or never there): nothing is limited to it, not even an addition to its contract.
  if (!allowed.size) return 'The selected element no longer exists.';
  const sameOwner = (o: OwnerRef) => o.kind === authority.owner.kind && o.id === authority.owner.id;
  const part = selectedPart(state, authority);
  // A selected part reaches only what that part shows, never the component's design.
  if (op.type === 'theme.refresh') return authority.part ? `theme.refresh changes the design of the component the selected part is in, which is more than the part.` : themeRefreshWithin(state, op, grants, authority.label, (o, id) => sameOwner(o) && allowed.has(id));
  // Inside a component's design, a placement made unique or turned into code adds a new component to the site.
  if (authority.owner.kind === 'component' && (op.type === 'component.makeUnique' || op.type === 'component.convertToCode')) return `${op.type} adds a new component to the site, which changes more than ${authority.label}.`;
  if (op.type === 'component.updateSource') return sourceWithin(state, op.definitionId, authority, allowed, sameOwner);
  if (op.type === 'component.fork') return forkWithin(op, authority, allowed, sameOwner);
  // Siblings wrapped or ungrouped where they are: every one inside the selection, never the selected element itself (a
  // new container around it, or what it held put beside it, would be outside it), and inside the selected part.
  if (op.type === 'node.wrap' || op.type === 'node.unwrap') {
    if (!sameOwner(op.owner) || !op.nodeIds.every((id) => allowed.has(id))) return `${op.type} targets something outside ${authority.label}.`;
    if (op.nodeIds.includes(authority.nodeId)) return `${op.type} would change what holds ${authority.label}, which is outside it.`;
    if (part) {
      const placed = slotContent(state, authority.owner, part);
      if (!op.nodeIds.every((id) => placed.has(id))) return `${op.type} changes content of ${authority.label} outside the selected part.`;
    }
    return null;
  }
  // Anything not classified (an operation from a newer document) is treated as the widest reach.
  switch (OP_REACH[op.type] ?? 'wider') {
    case 'node': {
      const o = op as unknown as { owner: OwnerRef; nodeId: string; parentId?: string | null };
      if (!sameOwner(o.owner) || !allowed.has(o.nodeId)) return `${op.type} targets something outside ${authority.label}.`;
      if (op.type === 'node.move' && (!o.parentId || !allowed.has(o.parentId))) return `node.move would move content outside ${authority.label}.`;
      if (op.type === 'node.move' && o.nodeId === authority.nodeId) return `node.move would move ${authority.label} itself.`;
      if (op.type === 'node.duplicate' && o.nodeId === authority.nodeId) return `node.duplicate would add a new section outside ${authority.label}.`;
      // What the selected element holds would take its place, beside it: outside it.
      if (op.type === 'node.removeKeepContent' && o.nodeId === authority.nodeId) return `node.removeKeepContent would put what ${authority.label} holds outside it.`;
      if (part) {
        if (o.nodeId === authority.nodeId) return outsidePart(op, part, authority.label);
        // Content placed in a slot the part renders is inside it, and may move only within such content.
        const placed = slotContent(state, authority.owner, part);
        if (!placed.has(o.nodeId)) return `${op.type} changes content of ${authority.label} outside the selected part.`;
        if (op.type === 'node.move' && !inPartSlot(o.parentId, (op as { slot?: string }).slot, part, placed)) return `node.move would move content outside the selected part of ${authority.label}.`;
      }
      return writesDefault(state, op);
    }
    case 'insert': {
      const o = op as Extract<EditOperation, { type: 'node.insert' }>;
      if (!sameOwner(o.owner) || !o.parentId || !allowed.has(o.parentId)) return `node.insert adds content outside ${authority.label}.`;
      if (part && !inPartSlot(o.parentId, o.slot, part, slotContent(state, authority.owner, part))) return `node.insert adds content outside the selected part of ${authority.label}.`;
      return null;
    }
    case 'copy': {
      // The source is only read, so it may be anywhere; the copy must land inside the selection.
      const o = op as Extract<EditOperation, { type: 'node.copy' }>;
      if (!sameOwner(o.toOwner) || !o.parentId || !allowed.has(o.parentId)) return `node.copy adds content outside ${authority.label}.`;
      if (part && !inPartSlot(o.parentId, (o as { slot?: string }).slot, part, slotContent(state, authority.owner, part))) return `node.copy adds content outside the selected part of ${authority.label}.`;
      return null;
    }
    case 'definition':
      // The selected part's component contract is shown in every placement: more than the part.
      if (part) return `${op.type} changes the contract of the component the selected part is in, which is more than the part.`;
      return definitionOpAllowed(state, op, authority, allowed) ? null : `${op.type} changes more than ${authority.label}.`;
    default:
      return `${op.type} changes more than ${authority.label}.`;
  }
}

/**
 * Whether a source change stays inside a selection (spec 13.4). A component's code shows wherever it is placed, so it is
 * the selection's only when every placement is inside the selected element and no other code renders it: the copy
 * component.convertToCode makes of the selected placement, say. A selected part never reaches its component's code,
 * and neither does a selection inside a component's design, where the code would show wherever that design is placed.
 */
function sourceWithin(state: ProjectState, definitionId: string, authority: Extract<Authority, { kind: 'selection' }>, allowed: Set<string>, sameOwner: (o: OwnerRef) => boolean): string | null {
  if (authority.part) return `component.updateSource changes the code of the component the selected part is in, which is more than the part.`;
  if (authority.owner.kind === 'component') return `component.updateSource changes code that shows wherever this design is placed: more than ${authority.label}.`;
  const def = Object.hasOwn(state.components, definitionId) ? state.components[definitionId] : undefined;
  if (!def || def.kind !== 'code' || def.owner !== 'project') return `component.updateSource changes more than ${authority.label}.`;
  const inside = (id: string) => {
    const placed = instancesOf(state, id);
    return placed.length > 0 && placed.every((p) => sameOwner(p.owner) && allowed.has(p.node.id)) && !dependentsOf(state, id).length;
  };
  // Code that loads components by pattern or at run time can render this one without naming its file: when such code
  // shows anywhere outside the selection, who shows this one cannot be told, so it is not the selection's alone.
  const loaders = Object.values(state.components).filter((d) => d.id !== def.id && d.kind === 'code' && DYNAMIC_IMPORT.test(d.source ?? ''));
  const unknown = loaders.some((d) => (instancesOf(state, d.id).length || dependentsOf(state, d.id).length) && !inside(d.id));
  if (inside(def.id) && !unknown) return null;
  return `Changing the source of "${def.name}" changes every placement of it, and it is used outside ${authority.label}. Give the selected placement a component of its own first (component.convertToCode for a managed component, component.makeUnique for code, or component.fork with placements for several inside it), then patch that copy.`;
}

/**
 * Whether a copy of a component stays inside a selection: as component.makeUnique makes one for the selected
 * placement, a fork may move placements inside the selected element to a copy they share, and never one outside
 * it. A selected part reaches neither, and a selection inside a component's design adds no component to the site.
 */
function forkWithin(op: Extract<EditOperation, { type: 'component.fork' }>, authority: Extract<Authority, { kind: 'selection' }>, allowed: Set<string>, sameOwner: (o: OwnerRef) => boolean): string | null {
  if (authority.owner.kind === 'component') return `component.fork adds a new component to the site, which changes more than ${authority.label}.`;
  if (authority.part) return 'component.fork gives the component the selected part is in a copy, which is more than the part.';
  if (!op.placements?.length) return `component.fork without placements moves every placement of the component to the copy, which changes more than ${authority.label}: list the placements inside it.`;
  if (!op.placements.every((u) => sameOwner(u.owner) && allowed.has(u.nodeId))) return `component.fork moves placements outside ${authority.label} to the copy.`;
  return null;
}

/** An import whose target is chosen by a pattern or at run time (developer code may use them; the assistant's may not). */
const DYNAMIC_IMPORT = /import\.meta\.glob|\bimport\s*\(/;

/** What a mutating call asks to change (spec 13.3): the whole site, or one page, component design or element by its ID. */
export interface RequestedScope {
  kind: 'site' | 'page' | 'component' | 'selection';
  targetIds?: string[];
}

/** How an authority is named where a call asks for more than it, or is limited to it. */
export function authorityLabel(authority: Authority): string {
  if (authority.kind === 'site') return 'the whole site';
  if (authority.kind === 'component') return `the ${authority.label} component`;
  return authority.label;
}

/**
 * The authority a call's requested scope names, which must lie within the run's: a scope that reaches further is
 * refused, never narrowed, and the model cannot widen a run by asking. The call is then checked against both, so a
 * narrower scope limits it and never grants what the run's own authority refuses (a page run naming an element of the
 * page still may not convert it to code). A selected part is named by its placement's ID and stays that part.
 */
export function requestedAuthority(state: ProjectState, requested: RequestedScope, run: Authority): { authority: Authority } | { code: 'INVALID_ARGUMENT' | 'SCOPE_MISMATCH'; message: string; reread?: true } {
  const wider = (what: string) => ({ code: 'SCOPE_MISMATCH' as const, message: `This call asks to change ${what}, which is more than ${authorityLabel(run)}.` });
  if (requested.kind === 'site') return run.kind === 'site' ? { authority: run } : wider('the whole site');
  const ids = requested.targetIds ?? [];
  if (ids.length !== 1 || typeof ids[0] !== 'string' || !ids[0].trim()) return { code: 'INVALID_ARGUMENT', message: `scope.targetIds: a ${requested.kind} scope names exactly one ${requested.kind === 'page' ? 'page ID' : requested.kind === 'component' ? 'definitionId' : 'node ID'}.` };
  const id = ids[0];
  if (requested.kind === 'page') {
    const route = normalizeRoute(id.trim());
    const pageId = Object.hasOwn(state.pages, id) ? id : Object.values(state.pages).find((p) => p?.route === route)?.id;
    if (!pageId) return { code: 'SCOPE_MISMATCH', reread: true, message: `scope names the page "${id}", which is not in the site.` };
    const label = pageLabel(state.pages[pageId].title);
    if (run.kind === 'site') return { authority: { kind: 'page', pageId, label } };
    return run.kind === 'page' && run.pageId === pageId ? { authority: run } : wider(label);
  }
  if (requested.kind === 'component') {
    if (!Object.hasOwn(state.components, id)) return { code: 'SCOPE_MISMATCH', reread: true, message: `scope names the component "${id}", which is not in the site.` };
    const label = state.components[id].name;
    if (run.kind === 'site') return { authority: { kind: 'component', definitionId: id, label } };
    return run.kind === 'component' && run.definitionId === id ? { authority: run } : wider(`the ${label} component`);
  }
  // An element: found in the tree the run is limited to, or anywhere in the site for a run that may change it all.
  if (run.kind === 'selection' && run.nodeId === id) return { authority: run };
  const owners: OwnerRef[] =
    run.kind === 'site'
      ? allTrees(state).flatMap((t) => (Object.hasOwn(t.tree.nodes, id) ? [t.owner] : []))
      : run.kind === 'selection'
        ? [run.owner]
        : run.kind === 'page'
          ? [{ kind: 'page', id: run.pageId }]
          : run.kind === 'component'
            ? [{ kind: 'component', id: run.definitionId }]
            : run.kind === 'template'
              ? [run.owner]
              : [];
  const found = owners.filter((o) => {
    try {
      return Object.hasOwn(getTree(state, o).nodes, id);
    } catch {
      return false;
    }
  });
  if (found.length > 1) return { code: 'SCOPE_MISMATCH', reread: true, message: `scope names the element "${id}", which is in more than one place in the site. Name the page or component instead.` };
  if (!found.length) {
    // Not where the run may change things: elsewhere in the site, or a wrong ID.
    const anywhere = run.kind !== 'site' && allTrees(state).some((t) => Object.hasOwn(t.tree.nodes, id));
    return anywhere ? wider(`the element "${id}"`) : { code: 'SCOPE_MISMATCH', reread: true, message: `scope names the element "${id}", which is not in the site.` };
  }
  const owner = found[0];
  const node = getTree(state, owner).nodes[id];
  const label = `the ${displayName(state, node)} element`;
  // Inside a selection: an element in it. A part is named by its placement, or by content placed in a slot it renders.
  if (run.kind === 'selection') {
    const part = run.part ? selectedPart(state, run) : null;
    const inside = run.part ? !!part && slotContent(state, run.owner, part).has(id) : subtreeIds(getTree(state, run.owner), run.nodeId).includes(id);
    if (!inside) return wider(label);
  }
  return { authority: { kind: 'selection', owner, nodeId: id, label } };
}

/**
 * Returns null when every operation changes only the one post: its own words and details, filed under categories it
 * may already be filed under. A new category is refused: the engine may move a feed on a page onto another term so it
 * goes on listing what it did, which reaches beyond the post.
 */
function checkEntryAuthority(state: ProjectState, ops: EditOperation[], authority: Extract<Authority, { kind: 'entry' }>): string | null {
  const label = authority.label;
  if (!liveEntry(state, authority.collectionId, authority.entryId)) return `${label[0].toUpperCase()}${label.slice(1)} is no longer in the site.`;
  for (const op of ops) {
    if (op.type === 'collection.createTerm') return `Adding the ${op.taxonomyId === 'categories' ? 'category' : op.taxonomyId === 'tags' ? 'tag' : 'term'} “${op.label}” changes the ${op.taxonomyId === 'categories' ? 'categories' : 'terms'} every entry of the collection can be filed under: more than ${label}.`;
    if (op.type === 'entry.create') return `Creating a new post changes more than ${label}.`;
    if (op.type !== 'entry.update' || op.collectionId !== authority.collectionId || op.entryId !== authority.entryId) return `${op.type} changes something outside ${label}.`;
    // A new address keeps the old one working site-wide; the post tool never sends one, but the check stays honest.
    if (op.slug !== undefined) return `A new address for ${label} changes the site's addresses: more than the post.`;
  }
  return null;
}

// Says what yes allows, as the note above the choices does: the whole site.
export const WIDEN_YES = 'Yes, allow changes across the whole site';
export const WIDEN_NO = 'No, only change the selection';

/** The two answers to a request for more than the authority allows: the first allows it. */
export function widenChoices(authority: Authority): [string, string] {
  if (authority.kind === 'component') return [`Yes, allow changes beyond ${authority.label}`, `No, only change ${authority.label}`];
  // Allowing more lets the run change anything on the site, so the answer says that.
  if (authority.kind === 'page' || authority.kind === 'entry' || authority.kind === 'template') return ['Yes, allow changes across the whole site', `No, only change ${authority.label}`];
  return [WIDEN_YES, WIDEN_NO];
}
