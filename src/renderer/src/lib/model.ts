/** Read-only helpers over the project state for the editor UI. */
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, ListProp, NodeTree, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { propBindingValue } from '@shared/bindings';
import { feedLimit } from '@shared/articles';
import { entryQuery, feedRows } from '@shared/entry-feed';
import { isBinding, isEntryBinding, refKey } from '@shared/types';
import { displayName, enclosingRepeatProp, findParent, isEmptyLayout } from '@engine/tree';
import { effectiveItem, followsPage, inheritedValue } from '@shared/page-teasers';
import type { InspectionDesc, InspectionRef } from '@shared/inspection';
import { placementItems, repeatedPartList } from '@shared/item-styles';
import { isShellPart, pagesShowing, partsShown, showsPart } from '@shared/page-shell';
import { isDraftPage } from '@generator/index';
import { entryNeighbours, materializeTemplate } from '@generator/entry-template';
import { PREVIEW_NODE_ID, previewCtx } from '@shared/component-preview';
import { layerLabel } from './layers';
import { keepTemplateValid, type TemplateMode } from './template-view';
import type { DefinitionMode } from './studio';

export interface BridgeDesc {
  ctx: string;
  node: string;
  items: string;
  tag?: string;
  text?: string;
  code?: boolean;
  /**
   * A part a code component's author marked (`data-so-part`): its declared ID. The rest of the descriptor names the
   * code placement it belongs to.
   */
  part?: string;
  /**
   * One slot of a placement, by the box the page shows while it is empty (#652): the rest of the descriptor names the
   * placement, in the context it is placed in (never through its definition's root, as the placement itself is).
   */
  slot?: string;
}

export function treeFor(state: ProjectState, owner: OwnerRef): NodeTree | undefined {
  // Own keys only: ids can come from the preview, and "toString" must not find Object.prototype's.
  if (owner.kind === 'page') return Object.hasOwn(state.pages, owner.id) ? state.pages[owner.id] : undefined;
  if (owner.kind === 'shell') return owner.id === 'header' || owner.id === 'footer' ? state.site.shell[owner.id] : undefined;
  if (owner.kind === 'template') return Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id]?.settings?.template : undefined;
  return Object.hasOwn(state.components, owner.id) ? state.components[owner.id]?.tree : undefined;
}

export function parseCtx(ctx: string): { owner: OwnerRef; path: string[] } | null {
  const [head, ...path] = ctx.split('|');
  const m = head.match(/^(page|shell|component|template):(.+)$/);
  if (!m) return null;
  return { owner: { kind: m[1] as OwnerRef['kind'], id: m[2] }, path };
}

export function ctxOf(ref: ElementRef): string {
  return [`${ref.owner.kind}:${ref.owner.id}`, ...ref.instancePath].join('|');
}

/** Descriptor the bridge uses to find the DOM element(s) for a reference. */
export function descOf(state: ProjectState, ref: ElementRef): BridgeDesc {
  // A declared part of a code placement is found by its author's marker inside that placement.
  if (isCodePart(state, ref)) {
    const placement = ref.instancePath[ref.instancePath.length - 1];
    return { ctx: ctxOf({ ...ref, instancePath: ref.instancePath.slice(0, -1) }), node: placement, items: '', part: ref.partId };
  }
  const items = (ref.itemPath ?? []).map(encodeItemId).join(',');
  // A slot of a placement is found by its empty box, which names the placement where it is placed, whatever renders it.
  if (ref.slot !== undefined) return { ctx: ctxOf(ref), node: ref.nodeId, items, slot: ref.slot };
  // A managed instance boundary is rendered by its definition root (through any component that root places), which
  // carries the items the placement sits in.
  let ctx = ctxOf(ref);
  let nodeId = ref.nodeId;
  // A definition that places itself at its root (refused by validation) stops at the second visit.
  const seen = new Set<string>();
  for (let n = nodeAt(state, ref); n?.kind === 'instance'; ) {
    const def = own(state.components, n.definitionId);
    const root = def?.kind === 'managed' ? def.tree?.rootIds[0] : undefined;
    if (!def?.tree || !root || seen.has(def.id)) break;
    seen.add(def.id);
    ctx = `${ctx}|${nodeId}`;
    nodeId = root;
    n = own(def.tree.nodes, root);
  }
  // Escaped as the preview writes them, so an item ID with a comma stays one item.
  return { ctx, node: nodeId, items };
}

/**
 * The context a placement's own design renders in, where its nodes (a list's rows among them) are found on the page:
 * the placement's, whichever component renders its outer element.
 */
export function designCtx(state: ProjectState, ref: ElementRef): string {
  const n = nodeAt(state, ref);
  const def = n?.kind === 'instance' ? state.components[n.definitionId] : undefined;
  return def?.kind === 'managed' && def.tree ? `${ctxOf(ref)}|${ref.nodeId}` : ctxOf(ref);
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

/**
 * The rows a computed list holds where a placement on `owner` shows it (see shared/entry-feed.ts): a page's articles or
 * itself, or for an entry feed the entries the placement's own `properties` values chose. A collection's layout is
 * shown on each of its entries' pages without that entry, so there an entry feed holds the rows any of them can show:
 * the collection's, one more than it lists, none left out.
 */
export function placedFeedRows(
  state: ProjectState,
  schema: ListProp,
  owner: OwnerRef | undefined,
  properties: Record<string, PropSchema>,
  props: Record<string, unknown>,
  sample?: { entryId: string | null; nodeId: string }
): Array<Record<string, unknown>> {
  const query = entryQuery(properties, props);
  if (schema.feed === 'entries' && owner?.kind === 'template') {
    const entry = { collectionId: owner.id, entryId: '' };
    // On the entry the canvas shows the layout on (`sample`, the placement's node there): exactly that page's rows,
    // what the placement reads of the entry read for it.
    const shown = sample?.entryId ? sampleQuery(state, owner.id, sample.entryId, sample.nodeId, properties) : undefined;
    if (shown) return feedRows(state, schema, { entry: { ...entry, entryId: sample!.entryId! }, query: shown });
    // A filter read from each entry can show any of the collection's entries on one page or another (and a collection
    // read from each entry, any collection's).
    const bound = (k: string) => isEntryBinding(props[k]);
    if (['collection', 'category', 'tag', 'count'].some(bound)) {
      const widened = { category: bound('category') ? '' : query.category, tag: bound('tag') ? '' : query.tag };
      const ids = bound('collection') ? Object.keys(state.collections ?? {}).sort() : [query.collection];
      return ids.flatMap((collection) => feedRows(state, { feed: 'entries' }, { entry, query: { collection, ...widened } }));
    }
    const limit = Math.min(feedLimit(schema), query.count ?? Infinity);
    return feedRows(state, { feed: 'entries' }, { entry, query: { ...query, count: Number.isFinite(limit) ? limit + 1 : undefined } });
  }
  return feedRows(state, schema, { pageId: owner?.kind === 'page' ? owner.id : undefined, query });
}

/** What a layout's placement `nodeId` chose, as the layout is shown on entry `entryId`: its reads of the entry read for it. */
function sampleQuery(state: ProjectState, collectionId: string, entryId: string, nodeId: string, properties: Record<string, PropSchema>) {
  const collection = own(state.collections ?? {}, collectionId);
  const entry = collection ? own(collection.entries, entryId) : undefined;
  if (!collection || !entry) return undefined;
  const n = own(materializeTemplate(state, collection, entry, entryNeighbours(state, collectionId, entryId)).nodes, nodeId);
  return n?.kind === 'instance' ? entryQuery(properties, n.props as Record<string, unknown>) : undefined;
}

export function nodeAt(state: ProjectState, ref: ElementRef): GraphNode | undefined {
  return resolveRef(state, ref).node;
}

export function partIdFor(def: ComponentDefinition | undefined, nodeId: string): string | undefined {
  if (!def) return undefined;
  return Object.entries(def.parts).find(([, p]) => p.nodeId === nodeId)?.[0];
}

/** One item ID as the preview writes it in an item path: "%" and "," escaped, everything else as it is. */
export function encodeItemId(id: string): string {
  return id.replaceAll('%', '%25').replaceAll(',', '%2C');
}

/** One item ID from the preview's item path. */
function decodeItemId(segment: string): string {
  return segment.replace(/%(25|2C)/g, (_, c: string) => (c === '25' ? '%' : ','));
}

function refFromDesc(state: ProjectState, d: BridgeDesc): ElementRef | null {
  const p = parseCtx(d.ctx);
  if (!p) return null;
  if (d.part !== undefined) return codePartRef(state, p.owner, p.path, d.node, d.part);
  const ref: ElementRef = { owner: p.owner, instancePath: p.path, nodeId: d.node };
  if (d.items) ref.itemPath = d.items.split(',').map(decodeItemId);
  if (d.slot !== undefined) {
    ref.slot = d.slot;
    return placedSlot(state, ref) ? ref : null;
  }
  const r = resolveRef(state, ref);
  if (r.def) ref.partId = partIdFor(r.def, d.node);
  return ref;
}

/**
 * Whether the element a click landed on (the innermost of its chain) is still in `state`, inside what the page showed
 * around it. A click held while a save reached the page is taken again only then: one on an element the save removed
 * (or one repeated item of several it removed) selects nothing, rather than whatever around it survived, and nor does
 * one on an element the save moved elsewhere, whose old surroundings would be selected.
 */
export function clickTargetIn(state: ProjectState, chain: BridgeDesc[]): boolean {
  const refs = chain.map((d) => refFromDesc(state, d));
  const target = refs[0];
  if (!target || !refExists(state, target)) return false;
  const around = ancestry(state, target);
  const bare = (owner: OwnerRef, instancePath: string[], nodeId: string) => refKey({ owner, instancePath, nodeId });
  // An empty slot's box is inside its own placement, whose parts the chain goes on through.
  around.add(bare(target.owner, target.instancePath, target.nodeId));
  return refs.slice(1).every((r) => {
    // What names nothing now (a wrapper the save removed) or belongs to another owner (the shell around the page) is
    // passed over, as a click passes over it.
    if (!r || r.owner.kind !== target.owner.kind || r.owner.id !== target.owner.id || !refExists(state, r)) return true;
    if (around.has(bare(r.owner, r.instancePath, r.nodeId))) return true;
    // A part of a component around the element (the Section's own container around its slot) is around it while that
    // component's placement is.
    return r.instancePath.length > 0 && around.has(bare(r.owner, r.instancePath.slice(0, -1), r.instancePath[r.instancePath.length - 1]));
  });
}

/**
 * The slot a reference names (see ElementRef.slot): one its placement's component declares, on a placement in the
 * owner's own tree, with the label the slot is shown by. Null for any other reference.
 */
export function placedSlot(state: ProjectState, ref: ElementRef | null | undefined): { instance: InstanceNode; def: ComponentDefinition; slot: string; label: string } | null {
  if (!ref || ref.slot === undefined || ref.instancePath.length || ref.partId) return null;
  const node = own(treeFor(state, ref.owner)?.nodes ?? {}, ref.nodeId);
  const def = node?.kind === 'instance' ? own(state.components, node.definitionId) : undefined;
  const decl = def?.slots && Object.hasOwn(def.slots, ref.slot) ? def.slots[ref.slot] : undefined;
  if (node?.kind !== 'instance' || !def || !decl) return null;
  const label = typeof decl.label === 'string' && decl.label.trim() ? decl.label.trim() : ref.slot;
  return { instance: node, def, slot: ref.slot, label };
}

/** The placement a slot reference belongs to (see ElementRef.slot); any other reference as it is. */
export function withoutSlot(ref: ElementRef): ElementRef {
  if (ref.slot === undefined) return ref;
  const { slot: _slot, ...placement } = ref;
  return placement;
}

/**
 * A part a code component's author marked, as the editor names it: the part its contract declares under that ID, on
 * a code placement in the owner's own tree. Null for anything else: a part it does not declare, its root (the
 * placement itself), or a code component placed inside another component's design, whose parts that placement styles.
 */
function codePartRef(state: ProjectState, owner: OwnerRef, path: string[], placementId: string, partId: string): ElementRef | null {
  if (path.length || partId === 'root') return null;
  const placement = own(treeFor(state, owner)?.nodes ?? {}, placementId);
  const def = placement?.kind === 'instance' ? own(state.components, placement.definitionId) : undefined;
  const part = def?.kind === 'code' ? own(def.parts, partId) : undefined;
  return part && typeof part.nodeId === 'string' ? { owner, instancePath: [placementId], nodeId: part.nodeId, partId } : null;
}

/**
 * Whether a reference is a declared part of a code placement in its owner's own tree (see codePartRef). A code
 * component has no tree of its own, so such a part is named by its contract alone, never one item of a list.
 */
export function isCodePart(state: ProjectState, ref: ElementRef | null | undefined): ref is ElementRef & { partId: string } {
  if (!ref || ref.instancePath.length !== 1 || !ref.partId || ref.partId === 'root' || ref.itemPath?.length) return false;
  const r = resolveRef(state, ref);
  return !r.node && !!r.instance && r.def?.kind === 'code' && own(r.def.parts, ref.partId)?.nodeId === ref.nodeId;
}

/**
 * If the reference is the root element of an instance, return the instance boundary instead (the outermost one, when
 * a definition's root is itself a component). A root's items are those its placement sits in, and a placement inside
 * a design is named as the design's part when it is one.
 */
export function boundaryOf(state: ProjectState, ref: ElementRef): ElementRef {
  let b = ref;
  while (b.instancePath.length && resolveRef(state, b).def?.tree?.rootIds[0] === b.nodeId) {
    const next: ElementRef = { owner: b.owner, instancePath: b.instancePath.slice(0, -1), nodeId: b.instancePath[b.instancePath.length - 1] };
    if (ref.itemPath?.length) next.itemPath = ref.itemPath;
    const partId = next.instancePath.length ? partIdFor(resolveRef(state, next).def, next.nodeId) : undefined;
    if (partId) next.partId = partId;
    b = next;
  }
  return b;
}

/**
 * What Create component… turns into a component, if anything: one element or basic element of a page, or of a
 * project component being edited everywhere (not its root, which is the component itself), or a placed section
 * whose slots hold content, which goes into the component together with that content. Never a slot or a repeat, the
 * shared header or footer, a part inside a placed component, a plain or empty placement (nothing of its own to
 * package), or anything while the project is read-only. Canvas, Layers and the inspector all ask this, so the
 * command is offered on the same things everywhere.
 */
export function createComponentTarget(snap: { state: ProjectState; readOnly?: unknown } | null | undefined, ref: ElementRef | null): ElementRef | null {
  if (!snap || !ref || snap.readOnly || ref.instancePath.length || ref.slot !== undefined || ref.owner.kind === 'shell') return null;
  const { state } = snap;
  const tree = treeFor(state, ref.owner);
  if (!tree) return null;
  if (ref.owner.kind === 'component') {
    const def = own(state.components, ref.owner.id);
    if (def?.owner !== 'project' || def.kind !== 'managed' || def.tree?.rootIds[0] === ref.nodeId) return null;
  }
  const node = own(tree.nodes, ref.nodeId);
  if (!node || node.kind === 'slot' || node.kind === 'repeat' || !findParent(tree, node.id)) return null;
  if (node.kind === 'instance') {
    const def = own(state.components, node.definitionId);
    const declared = def?.kind === 'managed' ? (def.slots ?? {}) : {};
    if (!Object.entries(node.slots ?? {}).some(([slot, ids]) => Object.hasOwn(declared, slot) && ids.length > 0)) return null;
  }
  return { owner: ref.owner, instancePath: [], nodeId: node.id };
}

/**
 * The element a layout inspection's finding is about, as operations address it: a node of the owner's own tree
 * and, inside a component placement, the declared part (the element's own, or the nearest one around it) and the
 * one list item that part is shown for. Null when the address names nothing in the project (a stale load, or markup
 * that is not the editor's): a finding never names an element that is not there.
 */
export function inspectionRef(state: ProjectState, d: InspectionDesc): InspectionRef | null {
  if (!d || typeof d.ctx !== 'string' || typeof d.node !== 'string') return null;
  const p = parseCtx(d.ctx);
  if (!p) return null;
  const items = typeof d.items === 'string' && d.items ? d.items.split(',').map(decodeItemId) : [];
  let ref: ElementRef = { owner: p.owner, instancePath: p.path, nodeId: d.node };
  if (!resolveRef(state, ref).node) return null;
  // A definition's root stands for its placement, through any chain of roots.
  ref = boundaryOf(state, ref);
  const ownerTree = treeFor(state, ref.owner);
  if (!ref.instancePath.length) {
    const node = ownerTree && own(ownerTree.nodes, ref.nodeId);
    // A placement's root takes its styles through the part declared on it, which need not be called "root".
    const def = node?.kind === 'instance' ? own(state.components, node.definitionId) : undefined;
    const rootPart = def?.kind === 'managed' && def.tree ? partIdFor(def, def.tree.rootIds[0]) : undefined;
    const alias = rootPart && rootPart !== 'root' ? { partId: rootPart } : {};
    // Markup inside a code component is the placement's as a whole; inside a design's root, that root part's; inside
    // another node (a link in rich text), that node's.
    if (d.inside) return { owner: ref.owner, nodeId: ref.nodeId, ...alias, match: node?.kind !== 'instance' ? 'container' : def?.kind === 'managed' ? 'nearest-part' : 'placement' };
    return { owner: ref.owner, nodeId: ref.nodeId, ...alias };
  }
  const placementId = ref.instancePath[0];
  const placement = ownerTree && own(ownerTree.nodes, placementId);
  const def = placement?.kind === 'instance' ? own(state.components, placement.definitionId) : undefined;
  if (!def?.tree || placement?.kind !== 'instance') return null;
  // The node of the placement's definition the element is in: itself, or the component placed there that renders it.
  const direct = ref.instancePath.length === 1;
  const inner = direct ? ref.nodeId : ref.instancePath[1];
  const partId = nearestPart(def, inner);
  const nearest = !direct || !!d.inside || partId !== partIdFor(def, inner);
  // A component placed in a project component's design, or an element of it: named there too, by its own part, where
  // a change reaches every placement of that design. It is offered beside the placement's part, never instead of it.
  const projectDesign = def.owner === 'project' && def.kind === 'managed';
  const placedThere = direct ? own(def.tree.nodes, inner) : undefined;
  let definition: InspectionRef | undefined;
  if (projectDesign && !direct && ref.instancePath.length === 2) {
    const innerDef = resolveRef(state, ref).def;
    const innerPart = innerDef?.tree ? nearestPart(innerDef, ref.nodeId) : undefined;
    if (innerPart) definition = { owner: { kind: 'component', id: def.id }, nodeId: inner, partId: innerPart, ...(innerPart !== partIdFor(innerDef, ref.nodeId) || d.inside ? { match: 'nearest-part' as const } : {}) };
  } else if (projectDesign && placedThere?.kind === 'instance' && partId !== partIdFor(def, inner)) {
    // The root of a component placed there (its boundary), which the design does not expose as a part of its own.
    const placedDef = own(state.components, placedThere.definitionId);
    const rootPart = placedDef?.kind === 'managed' && placedDef.tree ? partIdFor(placedDef, placedDef.tree.rootIds[0]) : undefined;
    definition = { owner: { kind: 'component', id: def.id }, nodeId: inner, ...(rootPart && rootPart !== 'root' ? { partId: rootPart } : {}), ...(d.inside ? { match: 'placement' as const } : {}) };
  }
  if (!partId) return { owner: ref.owner, nodeId: placementId, match: 'placement', ...(definition ? { definition } : {}) };
  const out: InspectionRef = { owner: ref.owner, nodeId: placementId, partId, ...(nearest ? { match: 'nearest-part' as const } : {}), ...(definition ? { definition } : {}) };
  // The list item the part is shown for. Only an element of the placement's own design carries that design's items
  // (one inside a component placed there carries that component's own), outermost first; a part styled one item at
  // a time sits inside exactly one list, so its item is the first. A part outside every list, or inside several,
  // has none. An element outside every list that carries items, or an item the list no longer has, means the
  // measured page was out of date: nothing is named.
  if (direct && items.length && !inRepeat(def, ref.nodeId)) return null;
  const list = direct && ref.owner.kind !== 'component' ? repeatedPartList(def, partId) : undefined;
  if (list && items.length) {
    if (!placementItems(def, placement, list).some((i) => i.id === items[0])) return null;
    out.itemId = items[0];
  }
  return out;
}

/** Whether a definition's node is rendered inside one of its repeats. */
function inRepeat(def: ComponentDefinition, nodeId: string): boolean {
  // Each node once: a hand-edited design can leave detached nodes holding each other.
  const seen = new Set<string>();
  for (let at = def.tree && findParent(def.tree, nodeId); at?.parentId && !seen.has(at.parentId); at = findParent(def.tree!, at.parentId)) {
    seen.add(at.parentId);
    if (own(def.tree!.nodes, at.parentId)?.kind === 'repeat') return true;
  }
  return false;
}

/** The part declared on a definition's node, or on the nearest node around it that has one. */
function nearestPart(def: ComponentDefinition, nodeId: string): string | undefined {
  let partId = partIdFor(def, nodeId);
  const seen = new Set<string>();
  for (let at = def.tree && findParent(def.tree, nodeId); !partId && at?.parentId && !seen.has(at.parentId); at = findParent(def.tree!, at.parentId)) {
    seen.add(at.parentId);
    partId = partIdFor(def, at.parentId);
  }
  return partId;
}

/** Is this reference a useful selection target (a primitive, a declared part or bound content)? */
function selectable(state: ProjectState, ref: ElementRef): boolean {
  if (!ref.instancePath.length || isCodePart(state, ref)) return true;
  const r = resolveRef(state, ref);
  if (!r.node) return false;
  if (ref.partId) return true;
  const n = r.node;
  if (n.kind === 'text') return isBinding(n.text);
  if (n.kind === 'image') return isBinding(n.image);
  if (n.kind === 'link') return isBinding(n.label) || isBinding(n.link);
  return false;
}

/** Whether a reference is a part of a placed component's design that only lays out other parts: an element
 *  that is neither the design's root nor one repeated item of a list. Containers on the page itself are the
 *  author's own structure and never count. */
function layoutPart(state: ProjectState, ref: ElementRef): boolean {
  if (!ref.instancePath.length || !ref.partId) return false;
  const { tree, node } = resolveRef(state, ref);
  if (!tree || node?.kind !== 'element' || tree.rootIds[0] === node.id) return false;
  const parentId = findParent(tree, node.id)?.parentId;
  return !parentId || own(tree.nodes, parentId)?.kind !== 'repeat';
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
 * a double-click) goes straight to the innermost level, and so does a click on the frame of an empty container of
 * the page's own (a Grid inserted a moment ago): the frame names that container, and Insert then fills it. One in a
 * placed component's design is stepped to as any part is: Insert cannot put anything there from the page.
 */
export function selectionFromChain(state: ProjectState, chain: BridgeDesc[], current: ElementRef | null, deep: boolean): ElementRef | null {
  // An empty slot's box picks that slot of its placement, on the first click: Insert then fills it (#652).
  const slot = chain[0]?.slot !== undefined ? refFromDesc(state, chain[0]) : null;
  if (slot) return slot;
  // Descriptors that name nothing in the project (stale, or not the editor's) are ignored; so is a slot's box that
  // does (one of a placement inside another component's design is not the page's to fill).
  chain = chain.filter((d) => d.slot === undefined);
  const chainRefs = chain.map((d) => refFromDesc(state, d));
  const refs = chainRefs.filter((r): r is ElementRef => !!r && (!!resolveRef(state, r).node || isCodePart(state, r)));
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
  // Nor is a component's layout part (a hero's Container, a Grid, a row of Actions) around what was clicked: the
  // click goes on to the content in it. A click on the part's own space, with nothing inside it under the
  // pointer, still selects it, and each repeated item (a Card) stays a step of its own.
  levels = levels.filter((l, i) => i === levels.length - 1 || !layoutPart(state, l));
  if (!levels.length) return boundaryOf(state, refs[0]);
  // The pointer on an empty container's frame: the innermost element under it is that container, on the page itself.
  const onFrame = refs[0] === chainRefs[0] && refs[0].owner.kind === 'page' && !refs[0].instancePath.length && isEmptyLayout(resolveRef(state, refs[0]).node);
  if (deep || onFrame) return levels[levels.length - 1];
  if (current) {
    const around = ancestry(state, current);
    let j = -1;
    levels.forEach((l, i) => around.has(refKey(l)) && (j = i));
    if (j >= 0) return levels[Math.min(j + 1, levels.length - 1)];
  }
  return levels[0];
}

export function refLabel(state: ProjectState, ref: ElementRef): string {
  const slot = placedSlot(state, ref);
  if (slot) return slot.label;
  const r = resolveRef(state, ref);
  if (r.def && ref.partId) return r.def.parts[ref.partId]?.label ?? 'Part';
  if (!r.node) return 'Element';
  // A node of a component's own design names its slot by the design's label, as one inside a placement does.
  return displayName(state, r.node, r.def ?? (ref.owner.kind === 'component' && !ref.instancePath.length ? own(state.components, ref.owner.id) : undefined));
}

/**
 * The page shown, and the page that editing everywhere returns to, kept to pages the project still has: an Undo or
 * the AI may remove either, and both fall back to Home.
 */
export function keepPagesValid(state: ProjectState, pageId: string | null, definitionMode: DefinitionMode) {
  const valid = (id: string | null | undefined): id is string => !!id && Object.hasOwn(state.pages, id);
  return {
    pageId: valid(pageId) ? pageId : state.site.homePageId,
    definitionMode: definitionMode && !valid(definitionMode.returnPageId) ? { ...definitionMode, returnPageId: state.site.homePageId } : definitionMode
  };
}

/**
 * The IDs of a list's items as the preview names them (each `id` made a string, so a hand-edited 42 is "42"), or
 * undefined when the value is not a list (one passed down from further out).
 */
function idsOf(items: unknown): string[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((i) => (i === null || i === undefined ? [] : [String((i as { id?: unknown }).id)]));
}

/** The trees components are placed in: every page, the shared header and footer, and every component's design. */
function allTrees(state: ProjectState): NodeTree[] {
  const shell = [state.site.shell.header, state.site.shell.footer];
  return [...Object.values(state.pages), ...shell, ...Object.values(state.components).map((d) => d.tree)].filter((t): t is NodeTree => !!t);
}

/**
 * The IDs of the items a repeated element can be selected in, where they can be told. Through a placement: that
 * placement's own list (or the design's defaults while it has none), or for a News list, the articles it lists where
 * it is placed (a shared header or footer lists them for no page in particular). In a design edited everywhere, an
 * element picked on the canvas is named by an item of the placement it was picked through, so there: the design's
 * defaults and every placement's own items. Undefined for an element outside every list, and wherever the items come
 * from further out (a component placed in another, a list passed down from the component around it).
 */
function selectableItemIds(state: ProjectState, ref: ElementRef, r: ReturnType<typeof resolveRef>): string[] | undefined {
  const design = ref.owner.kind === 'component';
  const def = design ? (ref.instancePath.length ? undefined : own(state.components, ref.owner.id)) : ref.instancePath.length === 1 ? r.def : undefined;
  if (!def || (!design && !r.instance)) return undefined;
  const list = listPropFor(def, ref.nodeId);
  const schema = list ? own(def.properties, list) : undefined;
  if (!list || schema?.type !== 'list') return undefined;
  if (schema.feed) {
    if (design) return undefined;
    return placedFeedRows(state, schema, ref.owner, def.properties, r.instance!.props as Record<string, unknown>).map((row) => row.id as string);
  }
  const stored = (n: InstanceNode) => {
    const v = own(n.props as Record<string, unknown>, list);
    return v === undefined ? schema.default : v;
  };
  if (!design) return idsOf(stored(r.instance!));
  const ids = new Set(idsOf(schema.default) ?? []);
  for (const tree of allTrees(state))
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance' || n.definitionId !== def.id) continue;
      const placed = idsOf(stored(n));
      if (!placed) return undefined;
      placed.forEach((id) => ids.add(id));
    }
  return [...ids];
}

/**
 * Whether a reference still names something the project has: its page, shared header or footer, or component, each
 * component on its path, its element, the part it names and, for an element of a list, its item. An Undo, a Redo, the
 * AI or the files changing on disk can take any of them away while it stays selected.
 */
export function refExists(state: ProjectState, ref: ElementRef): boolean {
  // A slot holds while its placement is there and still declares it, whatever is put in it or taken out.
  if (ref.slot !== undefined && !placedSlot(state, ref)) return false;
  const r = resolveRef(state, ref);
  // A code component has no tree: its parts are the ones its contract declares, never one item of a list.
  if (!r.node) return !!r.instance && r.def?.kind === 'code' && !!ref.partId && !ref.itemPath?.length && own(r.def.parts, ref.partId)?.nodeId === ref.nodeId;
  if (r.node.kind === 'instance' && !own(state.components, r.node.definitionId)) return false;
  // A part is named by the component it belongs to: the one placed, or the one edited everywhere.
  const partOf = ref.instancePath.length ? r.def : ref.owner.kind === 'component' ? own(state.components, ref.owner.id) : undefined;
  if (ref.partId && partOf && own(partOf.parts, ref.partId)?.nodeId !== ref.nodeId) return false;
  // Every reader of an item path names the item by its last ID: the item of the innermost list around the element.
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const items = itemId === undefined ? undefined : selectableItemIds(state, ref, r);
  return !items || items.includes(itemId!);
}

/**
 * For a part picked in one repeated item (one card of three): which item it is ("2 of 3") in the innermost list
 * repeating it, read as the placement shows it (its own items, the design's while it has none, a list passed down from
 * the component around it, or the pages a computed list shows; `sample` is the entry a collection's layout is shown on),
 * and the same part in every item of that list, which the selection chip's Previous and Next item step through (see
 * stepItem). Items further out stay as they are. Naming another item never changes the list.
 */
export function itemStep(state: ProjectState, ref: ElementRef, sample?: { entryId: string | null }): { n: number; count: number; parts: Array<ElementRef | null> } | null {
  const path = ref.itemPath ?? [];
  const itemId = path[path.length - 1];
  if (!itemId || !ref.instancePath.length) return null;
  // The placements on the way to the part, outermost first, with the designs they place.
  const placed: Array<{ props: Record<string, unknown>; def: ComponentDefinition }> = [];
  for (let k = 0; k < ref.instancePath.length; k++) {
    const node = resolveRef(state, { owner: ref.owner, instancePath: ref.instancePath.slice(0, k), nodeId: ref.instancePath[k] }).node;
    const def = node?.kind === 'instance' ? own(state.components, node.definitionId) : undefined;
    if (!def || node?.kind !== 'instance') return null;
    placed.push({ props: (node.props ?? {}) as Record<string, unknown>, def });
  }
  // The innermost repeat around the part is in the deepest design on the way that repeats it (or the component holding it).
  let k = placed.length - 1;
  let key: string | undefined;
  for (; k >= 0 && !key; k--) key = listPropFor(placed[k].def, k + 1 < placed.length ? ref.instancePath[k + 1] : ref.nodeId);
  if (!key) return null;
  k++;
  const schema = own(placed[k].def.properties ?? {}, key) as ListProp;
  let list: unknown;
  if (schema.feed) {
    // A computed list's rows are the pages it shows where it is placed: known only for a placement on the page itself.
    if (k > 0) return null;
    list = placedFeedRows(state, schema, ref.owner, placed[0].def.properties, placed[0].props, ref.owner.kind === 'template' && sample ? { entryId: sample.entryId, nodeId: ref.instancePath[0] } : undefined);
  } else {
    // A list passed down from the component around it is read where it is set.
    let at = k;
    let name = key;
    let value = placed[at].props[name];
    while (isBinding(value) && '$prop' in value && at > 0) {
      const from = value;
      at--;
      name = from.$prop;
      const outer = placed[at].props[name] ?? (own(placed[at].def.properties ?? {}, name) as { default?: unknown } | undefined)?.default;
      value = propBindingValue(outer, from);
    }
    list = value === undefined || value === null ? (at === k ? schema.default : undefined) : value;
  }
  if (!Array.isArray(list)) return null;
  // An item's ID as the preview names it (a hand-edited 42 is "42"); one without an ID can't be selected.
  const idAt = (i: number) => {
    const id = (list as Array<{ id?: unknown } | null>)[i]?.id;
    return (typeof id === 'string' && id) || typeof id === 'number' ? String(id) : null;
  };
  const n = list.findIndex((_, i) => idAt(i) === itemId);
  if (n < 0) return null;
  const parts = list.map((_, i) => {
    const id = idAt(i);
    return id ? { ...ref, itemPath: [...path.slice(0, -1), id] } : null;
  });
  return { n: n + 1, count: list.length, parts };
}

/**
 * The part a Previous (-1) or Next (1) item step from item `n` (1-based) selects: the same part in the nearest item that
 * way the page shows it in. `shown` says whether the page shows the part in an item (undefined while unknown, which
 * counts as shown): a rule can hide it in some (a button whose link is left empty). Null at either end: never wraps.
 */
export function stepItem(parts: Array<ElementRef | null>, n: number, dir: -1 | 1, shown?: ReadonlyArray<boolean | undefined>): ElementRef | null {
  for (let i = n - 1 + dir; i >= 0 && i < parts.length; i += dir) if (parts[i] && shown?.[i] !== false) return parts[i];
  return null;
}

type View = { pageId: string | null; selection: ElementRef | null; definitionMode: DefinitionMode; templateMode?: TemplateMode | null };

/**
 * The page shown, the selection and Edit everywhere kept to what the project still has after it changes (an Undo, a
 * Redo, the AI, a theme refresh, the files changing on disk). A selection naming something that has gone is let go,
 * never moved to what held it, so neither the Inspector nor the AI acts on a target the author did not pick. A
 * component edited everywhere that has gone (its copy undone) ends that mode, back on the page it was entered from.
 * `selection` is in the result only when it changes, so a selection that still holds is kept as it is.
 */
export function keepViewValid(state: ProjectState, view: View): { pageId: string; definitionMode: DefinitionMode; selection?: null; templateMode?: TemplateMode | null } {
  // A collection's layout whose collection went closes, and one whose entry went is shown on another. While one is
  // open, `templateMode` is always in the result, so the page shown changing under it (an Undo took the page away and
  // Home is shown) never closes it.
  if (view.templateMode) {
    const tm = keepTemplateValid(state, view.templateMode);
    const rest = keepViewValid(state, { ...view, templateMode: undefined });
    return { ...rest, templateMode: tm, ...(!tm && view.selection?.owner.kind === 'template' ? { selection: null } : {}) };
  }
  const dm = view.definitionMode;
  if (dm && !own(state.components, dm.definitionId)) {
    const pageId = keepPagesValid(state, dm.returnPageId, null).pageId;
    return view.selection ? { pageId, definitionMode: null, selection: null } : { pageId, definitionMode: null };
  }
  const pages = keepPagesValid(state, view.pageId, dm);
  return view.selection && !refExists(state, view.selection) ? { ...pages, selection: null } : pages;
}

/**
 * Where a selected shared header or footer shows: on how many pages, and whether the page on screen is one. An Undo
 * or the AI can hide it on that page while it stays selected, and edits to it still reach the pages that show it.
 */
export function shellReach(state: ProjectState, part: string, pageId: string | null): { pages: number; here: boolean } {
  const here = !!pageId && Object.hasOwn(state.pages, pageId) && isShellPart(part) && showsPart(state.pages[pageId], part);
  return { pages: pagesUsingShell(state, part), here };
}

/** "a", "a and b", "a, b and c". */
const inWords = (items: string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The pages a shared header or footer shows on, by name in site order: `text` names up to `max` of them and counts
 * the rest ("Home, About and 4 more"), and `all` names every one, for a tooltip. A draft is marked, since the
 * website leaves it out; a page without a title goes by its address.
 */
export function shellPageNames(state: ProjectState, part: string, max = 5): { text: string; all: string } {
  const names = isShellPart(part) ? pagesShowing(state, part).map((p) => `${p.title?.trim() || p.route}${isDraftPage(state, p) ? ' (draft)' : ''}`) : [];
  const listed = names.length > max ? [...names.slice(0, max - 1), `${names.length - max + 1} more`] : names;
  return { text: inWords(listed), all: inWords(names) };
}

export function ownerLabel(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'page') return state.pages[owner.id]?.title ?? 'Page';
  if (owner.kind === 'shell') return owner.id === 'header' ? 'Header' : 'Footer';
  if (owner.kind === 'template') return `${state.collections[owner.id]?.settings.name ?? 'Collection'} layout`;
  return state.components[owner.id]?.name ?? 'Component';
}

export interface Crumb {
  /** The short name shown. */
  label: string;
  /** The whole description, for the tooltip and the accessible name. */
  full: string;
  /** What selecting the crumb selects; null for the page (or component) the path starts at. */
  ref: ElementRef | null;
  /** A placed component: one from the theme, or one made in this project. */
  component?: 'theme' | 'custom';
}

/** The nodes above `nodeId` in a tree, outermost first (the tree's roots included, `nodeId` not), each with how
 *  many repeats it sits outside of on the way down to `nodeId` (a repeat counts itself). */
function ancestorsIn(tree: NodeTree, nodeId: string): Array<{ id: string; outside: number }> {
  const out: Array<{ id: string; outside: number }> = [];
  const seen = new Set([nodeId]);
  let outside = 0;
  for (let p = findParent(tree, nodeId); p?.parentId && !seen.has(p.parentId); p = findParent(tree, p.parentId)) {
    seen.add(p.parentId);
    if (tree.nodes[p.parentId]?.kind === 'repeat') outside++;
    out.push({ id: p.parentId, outside });
  }
  return out.reverse();
}

/** The repeated items a layer above the selection is inside: the selection's own, less the repeats it is outside. */
function itemsFor(itemPath: string[] | undefined, outside: number): Pick<ElementRef, 'itemPath'> {
  const kept = itemPath?.slice(0, Math.max(0, itemPath.length - outside));
  return kept?.length ? { itemPath: kept } : {};
}

/**
 * Breadcrumb from the page (or the component being edited) to the selection: every selectable layer it sits
 * in, outermost first. That is each container and component above it in the page's own tree, then for a
 * selection inside a placed component, the component and the parts of it that hold the selection.
 */
export function breadcrumb(state: ProjectState, ref: ElementRef): Crumb[] {
  const out: Crumb[] = [];
  const ownerName = ownerLabel(state, ref.owner);
  out.push({ label: ownerName, full: ownerName, ref: null });
  const crumb = (r: ElementRef): Crumb => {
    const res = resolveRef(state, r);
    // A part is named by its component; anything else as Layers names it (in the component being edited
    // everywhere, within that component: the settings its text shows, say).
    const part = res.def && r.partId ? res.def.parts[r.partId]?.label ?? 'Part' : undefined;
    const l = part
      ? { label: part, full: `${part}, part of ${res.def!.name}` }
      : res.node
        ? layerLabel(state, res.node, res.def ?? (r.owner.kind === 'component' ? own(state.components, r.owner.id) : undefined))
        : { label: 'Element', full: 'Element' };
    // A placed component (also one that is a part of another) is marked as one.
    const def = res.node?.kind === 'instance' ? own(state.components, res.node.definitionId) : undefined;
    if (!def) return { label: l.label, full: l.full, ref: r };
    const custom = def.owner === 'project';
    return { label: l.label, full: `${l.full}, ${custom ? 'component made in this project' : 'component'}`, ref: r, component: custom ? 'custom' : 'theme' };
  };
  const ownerTree = treeFor(state, ref.owner);
  const anchor = ref.instancePath[0] ?? ref.nodeId;
  // While a component is edited everywhere, its first crumb is the component's overview and the next its root.
  if (ownerTree) for (const a of ancestorsIn(ownerTree, anchor)) out.push(crumb({ owner: ref.owner, instancePath: [], nodeId: a.id, ...(ref.instancePath.length ? {} : itemsFor(ref.itemPath, a.outside)) }));
  for (let i = 0; i < ref.instancePath.length; i++) {
    // A component placed inside another is reachable as that one's part, and only when it is one.
    const boundary: ElementRef = { owner: ref.owner, instancePath: ref.instancePath.slice(0, i), nodeId: ref.instancePath[i] };
    const outerPart = i > 0 ? partIdFor(resolveRef(state, boundary).def, boundary.nodeId) : undefined;
    if (outerPart) boundary.partId = outerPart;
    if (selectable(state, boundary)) out.push(crumb(boundary));
    // Inside the component: the parts that hold the next component or the selection (other nodes there are
    // not selectable on their own; the component's root is the placement itself).
    const res = resolveRef(state, { owner: ref.owner, instancePath: ref.instancePath.slice(0, i + 1), nodeId: ref.nodeId });
    const inner = res.def?.tree;
    if (!res.def || !inner) continue;
    const next = ref.instancePath[i + 1] ?? ref.nodeId;
    const last = i === ref.instancePath.length - 1;
    for (const a of ancestorsIn(inner, next)) {
      const partId = partIdFor(res.def, a.id);
      if (!partId || a.id === inner.rootIds[0]) continue;
      out.push(crumb({ owner: ref.owner, instancePath: ref.instancePath.slice(0, i + 1), nodeId: a.id, partId, ...(last ? itemsFor(ref.itemPath, a.outside) : {}) }));
    }
  }
  // A slot of a placement: the placement, then the slot in it.
  const slot = placedSlot(state, ref);
  if (slot) {
    out.push(crumb(withoutSlot(ref)));
    out.push({ label: slot.label, full: `${slot.label}, a place for content in ${out[out.length - 1].label}`, ref });
    return out;
  }
  out.push(crumb(ref));
  return out;
}

export function textPreview(v: unknown): string {
  if (Array.isArray(v)) return v.join(' ');
  if (typeof v === 'string') return v;
  return '';
}

/** How many pages show the shared header or the shared footer: each page chooses them separately. */
export function pagesUsingShell(state: ProjectState, part: string): number {
  return isShellPart(part) ? pagesShowing(state, part).length : 0;
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

/**
 * What the Inspector shows for a selection while a component is edited everywhere: one of the design's own nodes, a
 * part of a component placed in the design (its row under that component in Layers), or the overview (nothing
 * selected, or something outside the design).
 */
export function definitionView(state: ProjectState, definitionId: string, ref: ElementRef | null): { kind: 'node'; node: GraphNode } | { kind: 'nested-part'; def: ComponentDefinition; instance: InstanceNode; node: GraphNode } | { kind: 'overview' } {
  if (!ref || !inDefinition(ref, definitionId)) return { kind: 'overview' };
  const r = resolveRef(state, ref);
  if (!r.node) return { kind: 'overview' };
  if (!ref.instancePath.length) return { kind: 'node', node: r.node };
  // One level in, through a managed component: deeper parts belong to that component's own design.
  if (ref.instancePath.length === 1 && r.instance && r.def?.kind === 'managed') return { kind: 'nested-part', def: r.def, instance: r.instance, node: r.node };
  return { kind: 'overview' };
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
    // Picked on its own root, a component inside the design keeps the items of the design it is repeated in.
    const b = nested ? boundaryOf(state, ref) : undefined;
    if (b?.itemPath?.length && b.instancePath.length === k + 1 && b.nodeId === nested) inner.itemPath = b.itemPath;
    const partId = partIdFor(state.components[definitionId], inner.nodeId);
    if (partId) inner = { ...inner, partId };
    return { ref: inner, placement: { owner: ref.owner, instancePath: ref.instancePath.slice(0, k), nodeId: ref.instancePath[k] } };
  }
  return null;
}

/** What a click on the canvas picks while editing a component everywhere: the innermost of the component's
 *  own nodes under the pointer (every node of the design can be picked), or null outside the component. */
export function definitionPick(state: ProjectState, definitionId: string, chain: BridgeDesc[]): { ref: ElementRef; placement: ElementRef } | null {
  // A placement's slot is filled on its page, not in the design edited everywhere.
  chain = chain.filter((d) => d.slot === undefined);
  for (const [i, d] of chain.entries()) {
    const r = refFromDesc(state, d);
    const hit = r && toDefinitionRef(state, definitionId, r);
    if (!hit) continue;
    // A component inside the design, picked by something inside it: its own root, further out, says which item of
    // the design's lists it is in.
    if (!hit.ref.itemPath?.length && resolveRef(state, hit.ref).node?.kind === 'instance')
      for (const outer of chain.slice(i + 1)) {
        const o = refFromDesc(state, outer);
        const at = o && toDefinitionRef(state, definitionId, o);
        if (!at || at.ref.nodeId !== hit.ref.nodeId || refKey(at.placement) !== refKey(hit.placement)) break;
        if (at.ref.itemPath?.length) return { ...hit, ref: { ...hit.ref, itemPath: at.ref.itemPath } };
      }
    return hit;
  }
  return null;
}

/*
 * Component Studio: the component edited everywhere shown on its own, in the editor's isolated preview (see
 * @shared/component-preview), placed nowhere. Its design renders there inside the preview's one instance, so the
 * design's own nodes carry the context "preview:<id>|preview" where a placement's carry "<owner>|<placement>". The
 * selection still names the design's own nodes; only what the frame is told and what it reports are translated.
 */

/** The context the studio's preview renders a component's design in. */
export const studioCtx = (definitionId: string) => `${previewCtx(definitionId)}|${PREVIEW_NODE_ID}`;

/** A context that begins with `head` (as a whole segment), with it swapped for `to`; null for any other context. */
function swapHead(ctx: string, head: string, to: string): string | null {
  return ctx === head || ctx.startsWith(`${head}|`) ? to + ctx.slice(head.length) : null;
}

/** The descriptor the studio's preview finds one of the edited component's references by; null for anything else. */
export function studioDescOf(state: ProjectState, definitionId: string, ref: ElementRef | null | undefined): BridgeDesc | null {
  if (!ref || !inDefinition(ref, definitionId)) return null;
  const d = descOf(state, ref);
  const ctx = swapHead(d.ctx, `component:${definitionId}`, studioCtx(definitionId));
  return ctx === null ? null : { ...d, ctx };
}

/** The context the design around one of the edited component's references renders in, in the studio's preview (see designCtx). */
export function studioDesignCtx(state: ProjectState, definitionId: string, ref: ElementRef): string | null {
  return inDefinition(ref, definitionId) ? swapHead(designCtx(state, ref), `component:${definitionId}`, studioCtx(definitionId)) : null;
}

/**
 * One of the edited component's references as the studio's preview can show it: an item of a list is kept only when
 * it is one of the design's own starting items, the only ones every preview shows under the same ID (sample content
 * adds its own, and a placement's items are that placement's). An item of a list inside another list's item is let
 * go too, since the outer item may be one only a sample has: the node is then outlined in every item.
 */
export function studioRef(state: ProjectState, definitionId: string, ref: ElementRef): ElementRef {
  const itemId = ref.itemPath?.length === 1 ? ref.itemPath[0] : undefined;
  if (!ref.itemPath?.length) return ref;
  const def = own(state.components, definitionId);
  const list = def ? listPropFor(def, ref.nodeId) : undefined;
  const schema = def && list ? own(def.properties, list) : undefined;
  const shown = itemId !== undefined && schema?.type === 'list' && !schema.feed && (idsOf(schema.default) ?? []).includes(itemId) && refExists(state, ref);
  if (shown) return ref;
  const out = { ...ref };
  delete out.itemPath;
  return out;
}

/**
 * What a pick in the studio's preview selects, as definitionPick does on a page: the innermost of the component's own
 * nodes under the pointer, a component placed in the design picked whole, or null outside it (the code component's
 * own wrapper among it: a code component has no nodes to pick). An item of a list is kept only when it is one of the
 * design's own (see studioRef), so a pick never names an item the next preview may not show.
 */
export function studioPick(state: ProjectState, definitionId: string, chain: BridgeDesc[]): ElementRef | null {
  const def = own(state.components, definitionId);
  if (!def?.tree) return null;
  chain = chain.filter((d) => d.slot === undefined);
  const owner: OwnerRef = { kind: 'component', id: definitionId };
  const inDesign = (d: BridgeDesc) => {
    const ctx = swapHead(d.ctx, studioCtx(definitionId), `component:${definitionId}`);
    const r = ctx === null ? null : refFromDesc(state, { ...d, ctx });
    return r && resolveRef(state, r).node ? r : null;
  };
  for (const [i, d] of chain.entries()) {
    const r = inDesign(d);
    if (!r) continue;
    const nested = r.instancePath[0];
    let hit: ElementRef = { owner, instancePath: [], nodeId: nested ?? r.nodeId };
    if (!nested && r.itemPath?.length) hit.itemPath = r.itemPath;
    if (nested) {
      // Picked on its own root, a component inside the design keeps the items of the design it is repeated in; picked
      // by something inside it, its root further out says which.
      const b = boundaryOf(state, r);
      if (b.itemPath?.length && !b.instancePath.length && b.nodeId === nested) hit.itemPath = b.itemPath;
      else
        for (const outer of chain.slice(i + 1)) {
          const o = inDesign(outer);
          const ob = o && boundaryOf(state, o);
          if (!ob || (ob.instancePath.length ? ob.instancePath[0] : ob.nodeId) !== nested) break;
          if (!ob.instancePath.length && ob.itemPath?.length) {
            hit.itemPath = ob.itemPath;
            break;
          }
        }
    }
    const partId = partIdFor(def, hit.nodeId);
    if (partId) hit = { ...hit, partId };
    return studioRef(state, definitionId, hit);
  }
  return null;
}

/**
 * Whether editing a component everywhere has to show it in Component Studio: the page on screen no longer places it
 * (its last placement there removed or undone), so the canvas would show the page without it. Only a component of
 * the project's own: a theme's original is never edited.
 */
export function needsStudio(state: ProjectState, definitionMode: DefinitionMode, pageId: string | null): boolean {
  if (!definitionMode || definitionMode.studio) return false;
  const def = own(state.components, definitionMode.definitionId);
  return def?.owner === 'project' && !(pageId && placementsOn(state, def.id, pageId).length);
}

/** The component's placements on a page (its own content, then the shared header and footer it shows). */
export function placementsOn(state: ProjectState, definitionId: string, pageId: string): ElementRef[] {
  const page = state.pages[pageId];
  if (!page) return [];
  const owners: OwnerRef[] = [{ kind: 'page', id: pageId }, ...partsShown(page).map((part) => ({ kind: 'shell' as const, id: part }))];
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

/** Whether a reference's bound field is a page list card's empty field, showing its page's value instead. */
export function followsPageAt(state: ProjectState, ref: ElementRef, bound: unknown): boolean {
  if (!isBinding(bound) || !('$item' in bound)) return false;
  const r = resolveRef(state, ref);
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const schema = list ? r.def!.properties[list] : undefined;
  if (schema?.type !== 'list' || !schema.pageTeaser) return false;
  const props = (r.instance?.props ?? {}) as Record<string, unknown>;
  const items = Object.hasOwn(props, list!) ? props[list!] : schema.default;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const item = Array.isArray(items) ? (items.find((it) => (it as { id?: unknown } | null)?.id === itemId) as Record<string, unknown> | undefined) : undefined;
  return !!item && followsPage(item[bound.$item]) && inheritedValue(state, schema, item, bound.$item) !== undefined;
}

/** Whether a reference's bound field belongs to a computed list (news, an article header): its words come from a
 *  page's settings and are never typed where they show. */
export function computedAt(state: ProjectState, ref: ElementRef, bound: unknown): boolean {
  if (!isBinding(bound) || !('$item' in bound)) return false;
  const r = resolveRef(state, ref);
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const schema = list ? r.def!.properties[list] : undefined;
  return schema?.type === 'list' && !!schema.feed;
}

/** The value a reference's inline-editable field shows in `state`: a bound field shows its placement's value,
 *  or the property's default when the placement has none. A page list's card shows its page's title (and so on)
 *  while it has none of its own, so leaving that text as it was writes nothing. */
export function shownValue(state: ProjectState, ref: ElementRef, bound: unknown): unknown {
  if (!isBinding(bound)) return bound;
  const r = resolveRef(state, ref);
  const props = (r.instance?.props ?? {}) as Record<string, unknown>;
  if ('$prop' in bound) return propBindingValue(props[bound.$prop] ?? (r.def?.properties[bound.$prop] as { default?: unknown } | undefined)?.default, bound);
  // An entry's field shows the entry previewed, which the canvas shows; it is never typed where it shows.
  if (!('$item' in bound)) return undefined;
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const schema = list ? r.def!.properties[list] : undefined;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  // A computed list shows its page's row, where the placement sits directly on a page.
  if (schema?.type === 'list' && schema.feed) {
    const row = placedFeedRows(state, schema, ref.owner, r.def!.properties, props).find((x) => x.id === itemId);
    return row?.[bound.$item];
  }
  const items = list ? (Object.hasOwn(props, list) ? props[list] : schema?.default) : undefined;
  const item = Array.isArray(items) ? items.find((it) => (it as { id?: unknown } | null)?.id === itemId) : undefined;
  if (!item || typeof item !== 'object') return undefined;
  return (schema?.type === 'list' ? effectiveItem(state, schema, item as Record<string, unknown>) : (item as Record<string, unknown>))[bound.$item];
}

/**
 * A field as the page shows it (`shownValue`), and for a repeated item stored without that field, the field's
 * default, as the site shows it. Undefined when it can't be told.
 */
export function shownOrDefault(state: ProjectState, ref: ElementRef, bound: unknown): unknown {
  const v = shownValue(state, ref, bound);
  if (v !== undefined || !isBinding(bound) || !('$item' in bound)) return v;
  const r = resolveRef(state, ref);
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const schema = list ? r.def!.properties[list] : undefined;
  if (schema?.type !== 'list') return undefined;
  const props = (r.instance?.props ?? {}) as Record<string, unknown>;
  const items = Object.hasOwn(props, list!) ? props[list!] : schema.default;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const item = Array.isArray(items) ? (items.find((it) => (it as { id?: unknown } | null)?.id === itemId) as Record<string, unknown> | undefined) : undefined;
  return item && !Object.hasOwn(item, bound.$item) ? (schema.fields[bound.$item] as { default?: unknown } | undefined)?.default : undefined;
}

/** A component's own reference as the page shows it, through one placement. */
export function throughPlacement(ref: ElementRef, placement: ElementRef): ElementRef {
  return { ...ref, owner: placement.owner, instancePath: [...placement.instancePath, placement.nodeId, ...ref.instancePath] };
}
