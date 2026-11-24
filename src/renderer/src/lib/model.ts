/** Read-only helpers over the project state for the editor UI. */
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { articleRows, feedLimit } from '@shared/articles';
import { isBinding, refKey } from '@shared/types';
import { displayName, enclosingRepeatProp, findParent } from '@engine/tree';
import { effectiveItem, followsPage, inheritedValue } from '@shared/page-teasers';
import { isShellPart, pagesShowing, partsShown, showsPart } from '@shared/page-shell';
import { isDraftPage } from '@generator/index';
import { layerLabel } from './layers';

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
  const items = (ref.itemPath ?? []).map(encodeItemId).join(',');
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
  const ref: ElementRef = { owner: p.owner, instancePath: p.path, nodeId: d.node };
  if (d.items) ref.itemPath = d.items.split(',').map(decodeItemId);
  const r = resolveRef(state, ref);
  if (r.def) ref.partId = partIdFor(r.def, d.node);
  return ref;
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

/**
 * The page shown, and the page that editing everywhere returns to, kept to pages the project still has: an Undo or
 * the AI may remove either, and both fall back to Home.
 */
export function keepPagesValid(state: ProjectState, pageId: string | null, definitionMode: { definitionId: string; returnPageId: string } | null) {
  const valid = (id: string | null | undefined): id is string => !!id && Object.hasOwn(state.pages, id);
  return {
    pageId: valid(pageId) ? pageId : state.site.homePageId,
    definitionMode: definitionMode && !valid(definitionMode.returnPageId) ? { ...definitionMode, returnPageId: state.site.homePageId } : definitionMode
  };
}

/** Whether the selection is on a page the project no longer has (an Undo took it away): it goes with that page. */
export const onGonePage = (state: ProjectState, selection: ElementRef | null) => selection?.owner.kind === 'page' && !Object.hasOwn(state.pages, selection.owner.id);

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
  if ('$prop' in bound) return props[bound.$prop] ?? (r.def?.properties[bound.$prop] as { default?: unknown } | undefined)?.default;
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const schema = list ? r.def!.properties[list] : undefined;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  // A computed list shows its page's row, where the placement sits directly on a page.
  if (schema?.type === 'list' && schema.feed) {
    const pageId = ref.owner.kind === 'page' ? ref.owner.id : undefined;
    const limit = feedLimit(schema);
    const row = articleRows(state, schema.feed, pageId, Number.isFinite(limit) ? limit : undefined).find((x) => x.id === itemId) as Record<string, unknown> | undefined;
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
