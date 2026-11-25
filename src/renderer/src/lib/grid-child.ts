/**
 * Whether what the Inspector styles sits directly in a grid, and the style rows that follow from it: a grid item's
 * Column span and Row span show in the Layout group itself rather than behind its "more" toggle.
 */
import type { Binding, ComponentDefinition, ElementNode, ElementRef, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, ResponsiveScope } from '@shared/types';
import { isBinding } from '@shared/types';
import { propBindingSchema, propBindingValue } from '@shared/bindings';
import { cascadeStyles, type StyleLayer, type StylePropDef } from '@shared/styles';
import { designLayers, startingVariants } from '@shared/variants';
import { itemStylesOf } from '@shared/item-styles';
import { enclosingRepeatProp, findParent } from '@engine/tree';
import { isCardLink, isCarouselTrack } from '@generator/card-links';
import { treeFor } from './model';

/** The styles that place an item in its parent grid. */
export const GRID_CHILD_PROPS: readonly string[] = ['columnSpan', 'rowSpan'];

/** One tree on the way to the styled element: its owner's own, or a design as one placement shows it. */
interface Frame {
  tree: NodeTree;
  /** The managed design this tree belongs to. */
  def?: ComponentDefinition;
  /** The placement showing the design, in `outer`'s tree. */
  placement?: InstanceNode;
  outer?: Frame;
}

/** A design edited on its own: the look being styled, and no placement. */
export type EditedLook = { axis: string; variant: string };

interface Walk {
  state: ProjectState;
  look?: EditedLook;
  /** The selected list item, outermost list first, whose own part styles and fields shape the boxes around it. */
  itemPath?: string[];
}

const MAX_DEPTH = 64;

const nodeOf = (tree: NodeTree, id: string): GraphNode | undefined => (Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined);

function inside(walk: Walk, outer: Frame, placement: InstanceNode): Frame | null {
  const def = Object.hasOwn(walk.state.components, placement.definitionId) ? walk.state.components[placement.definitionId] : undefined;
  // A code component's markup is its source: what surrounds anything inside it is unknown.
  return def?.kind === 'managed' && def.tree ? { tree: def.tree, def, placement, outer } : null;
}

/** How many lists repeat the placement a frame shows, those around the designs holding it included. */
function listsAround(frame: Frame): number {
  const { placement, outer } = frame;
  if (!placement || !outer) return 0;
  let count = listsAround(outer);
  let at = findParent(outer.tree, placement.id)?.parentId;
  for (let depth = 0; at && depth < MAX_DEPTH; depth++, at = findParent(outer.tree, at)?.parentId) if (nodeOf(outer.tree, at)?.kind === 'repeat') count++;
  return count;
}

/**
 * What a binding on a frame's placement reads: a property of the design around it, or a field of the selected item of
 * the list repeating it there. Undefined where that cannot be told here, as a collection entry's own field.
 */
function boundIn(walk: Walk, frame: Frame, binding: Binding, depth: number): unknown {
  const { placement, outer } = frame;
  if (!placement || !outer) return undefined;
  if ('$prop' in binding) return propIn(walk, outer, binding, depth + 1);
  if (!('$item' in binding) || !outer.def) return undefined;
  const list = enclosingRepeatProp(outer.def, placement.id);
  const rows = list ? propIn(walk, outer, { $prop: list }, depth + 1) : undefined;
  // Item IDs are unique only within their list: the path names one for each list, outermost first.
  const id = walk.itemPath?.[listsAround(frame) - 1];
  const row = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>).find((r) => r.id === id) : undefined;
  return row?.[binding.$item];
}

/** What a property of a design holds here: the placement's value, bound or its own, or the property's default. */
function propIn(walk: Walk, frame: Frame, binding: { $prop: string; field?: string }, depth = 0): unknown {
  const { def, placement } = frame;
  if (!def || depth > MAX_DEPTH) return undefined;
  const own = placement && Object.hasOwn(placement.props, binding.$prop) ? placement.props[binding.$prop] : undefined;
  const value = isBinding(own) ? boundIn(walk, frame, own, depth) : own;
  return propBindingValue(value, binding) ?? propBindingSchema(def.properties, binding)?.default;
}

/** The options a frame's design is shown with: a placement's choices, those it binds read as the page first shows them. */
function chosenIn(walk: Walk, frame: Frame): InstanceNode['variants'] {
  const { placement, outer } = frame;
  if (!placement) return walk.look ? { [walk.look.axis]: walk.look.variant } : undefined;
  const chosen = startingVariants(placement.variants, outer?.def);
  if (!chosen) return chosen;
  return Object.fromEntries(
    Object.entries(chosen).map(([axis, v]) => {
      const bound = isBinding(v) ? boundIn(walk, frame, v, 0) : undefined;
      return [axis, typeof bound === 'string' ? bound : v];
    })
  );
}

/**
 * Where a design's block comes in the components' stylesheet, which writes each in turn by ID: between rules of one
 * weight from two designs the later block wins at every size. Less than the step between weights.
 */
function blockOrder(state: ProjectState, defId: string): number {
  const ids = Object.keys(state.components).sort((a, b) => a.localeCompare(b));
  return ids.indexOf(defId) / (ids.length + 1) / 10;
}

/** What a placement's own changes add to one node of its design. */
function placementLayers(walk: Walk, frame: Frame, nodeId: string): StyleLayer[] {
  const { def, placement, outer } = frame;
  if (!def || !placement) return [];
  // A placement inside a design is written in that design's block. One on a page is written after every design's, and
  // two classes heavier on a part that is itself a placed component, so it beats that placement's own changes.
  const within = outer?.def;
  const base = within ? 3 + blockOrder(walk.state, within.id) : def.tree?.nodes[nodeId]?.kind === 'instance' ? 4 : 3;
  const out: StyleLayer[] = [];
  for (const [partId, styles] of Object.entries(placement.overrides ?? {})) {
    const target = partId === 'root' ? def.tree?.rootIds[0] : def.parts[partId]?.nodeId;
    if (target === nodeId) out.push({ styles, strength: base, wideColumns: true });
  }
  const itemId = walk.itemPath?.[walk.itemPath.length - 1];
  if (itemId) {
    for (const [partId, part] of Object.entries(def.parts)) {
      const styles = part.nodeId === nodeId ? itemStylesOf(def, placement, partId, itemId) : undefined;
      if (styles) out.push({ styles, strength: base + 1, wideColumns: true });
    }
  }
  return out;
}

/** The style rules on one element of a frame's tree. */
function boxLayers(walk: Walk, frame: Frame, node: GraphNode): StyleLayer[] {
  const { def, outer } = frame;
  if (!def) return [{ styles: node.styles, strength: 1 }];
  const order = blockOrder(walk.state, def.id);
  const design = designLayers(def, node.id, chosenIn(walk, frame)).map((l) => ({ ...l, strength: l.strength + order }));
  const own = placementLayers(walk, frame, node.id);
  // A design's root also carries what the tree around it gives the placement: that design's rules for it, and its
  // own placement's changes to it.
  const placed = def.tree?.rootIds[0] === node.id && frame.placement && outer?.def ? nodeOf(outer.tree, frame.placement.id) : undefined;
  return placed ? [...boxLayers(walk, outer!, placed), ...design, ...own] : [...design, ...own];
}

/** Whether the element that renders directly around a node is a grid at any of `sizes`. */
function parentIsGrid(walk: Walk, frame: Frame, nodeId: string, sizes: ReadonlyArray<'phone' | 'tablet' | 'desktop'>, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const parent = findParent(frame.tree, nodeId);
  if (!parent) return false;
  if (parent.parentId === null) {
    // A design's root renders where its placement sits.
    return !!frame.outer && !!frame.placement && parentIsGrid(walk, frame.outer, frame.placement.id, sizes, depth + 1);
  }
  const node = nodeOf(frame.tree, parent.parentId);
  if (!node) return false;
  if (node.kind === 'element') {
    const styles = cascadeStyles(boxLayers(walk, frame, node));
    return sizes.some((size) => styles[size]?.layout === 'grid');
  }
  // Repeats and slot outlets render no element of their own.
  if (node.kind === 'repeat' || node.kind === 'slot') return parentIsGrid(walk, frame, node.id, sizes, depth + 1);
  if (node.kind !== 'instance') return false;
  // Content in a placement's slot renders where the placement's design shows that slot.
  const design = inside(walk, frame, node);
  return !!design && Object.values(design.tree.nodes).some((n) => n.kind === 'slot' && n.slot === parent.slot && parentIsGrid(walk, design, n.id, sizes, depth + 1));
}

/** Whether an element holds a picture its own action could open: one of its images, outside lists and components. */
function holdsImage(tree: NodeTree, node: ElementNode, depth = 0): boolean {
  return node.children.some((id) => {
    const child = nodeOf(tree, id);
    return child?.kind === 'image' || (child?.kind === 'element' && depth < MAX_DEPTH && holdsImage(tree, child, depth + 1));
  });
}

/**
 * Whether the element a node renders is wrapped in another of the runtime's own (a card's action link, a carousel's
 * frame), which is then the grid's item: a span on the element would do nothing.
 */
function wrapped(state: ProjectState, tree: NodeTree, node: GraphNode, depth = 0): boolean {
  if (node.kind === 'instance') {
    const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
    const root = def?.kind === 'managed' && def.tree ? nodeOf(def.tree, def.tree.rootIds[0]) : undefined;
    return !!root && depth < MAX_DEPTH && wrapped(state, def!.tree!, root, depth + 1);
  }
  if (isCarouselTrack(node)) return true;
  if (node.kind !== 'element' || node.action === undefined || node.action === null || !isCardLink(node)) return false;
  // With no picture to open, an image action adds no link around the element.
  return node.action !== 'image' || holdsImage(tree, node);
}

/**
 * Whether the element `ref` styles is a direct item of a grid at the size being edited: the box around it as the site
 * renders it, whatever repeats and slots lie between. Under All sizes, a grid at any screen size counts. `look` is
 * the look a design's own node is styled in. False where it cannot be told, as inside a code component.
 */
export function isGridChild(state: ProjectState, ref: ElementRef, scope: ResponsiveScope, look?: EditedLook): boolean {
  const tree = treeFor(state, ref.owner);
  if (!tree) return false;
  const walk: Walk = { state, look, itemPath: ref.itemPath };
  const owner = ref.owner.kind === 'component' && Object.hasOwn(state.components, ref.owner.id) ? state.components[ref.owner.id] : undefined;
  let frame: Frame = { tree, def: owner };
  for (const id of ref.instancePath) {
    const placement = nodeOf(frame.tree, id);
    const next = placement?.kind === 'instance' ? inside(walk, frame, placement) : null;
    if (!next) return false;
    frame = next;
  }
  const node = nodeOf(frame.tree, ref.nodeId);
  if (!node || node.kind === 'repeat' || node.kind === 'slot' || wrapped(state, frame.tree, node)) return false;
  return parentIsGrid(walk, frame, node.id, scope === 'base' ? ['phone', 'tablet', 'desktop'] : [scope]);
}

/**
 * What to ask `isGridChild` about for a node of a design being edited. Edited through a placement on the canvas, it
 * is the box that placement shows; in Component Studio, or in a look (shown on its own), the design's, with the list
 * item that is selected.
 */
export function designGridRef(selection: ElementRef | null, design: OwnerRef, nodeId: string, standalone: boolean): ElementRef {
  const selected = selection?.nodeId === nodeId ? selection : null;
  if (!standalone && selected?.instancePath.length === 1) return selected;
  return { owner: design, instancePath: [], nodeId, itemPath: selected?.itemPath };
}

/** The style controls a grid item offers: a design's own list, with the spans added so the first one can be set. */
export function withGridChildProps(allowed: string[] | undefined, gridChild: boolean): string[] | undefined {
  if (!gridChild || !allowed?.length) return allowed;
  const missing = GRID_CHILD_PROPS.filter((p) => !allowed.includes(p));
  return missing.length ? [...allowed, ...missing] : allowed;
}

export interface StyleRowGroup {
  g: StylePropDef['group'];
  /** Every row of the group that means something here. */
  rel: StylePropDef[];
  /** The rows shown while the group is closed. */
  visible: StylePropDef[];
  hidden: number;
}

/**
 * The inspector's style rows by group, in the order the properties come. A long list shows the common rows of its
 * first two groups plus anything set at any size; the rest are tucked behind their group's heading. A grid item's
 * spans always show, and neither make a list long nor take another group's place among the first two.
 */
export function styleRowGroups(
  props: StylePropDef[],
  { relevant, setAnywhere, gridChild }: { relevant: (id: string) => boolean; setAnywhere: (id: string) => boolean; gridChild?: boolean }
): StyleRowGroup[] {
  const promoted = (id: string) => !!gridChild && GRID_CHILD_PROPS.includes(id);
  const groups = new Map<StylePropDef['group'], StylePropDef[]>();
  for (const p of props) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const entries = [...groups.entries()];
  const long = props.filter((p) => !promoted(p.id) && relevant(p.id)).length > 10;
  const primary = new Set(
    entries
      .filter(([, list]) => list.some((p) => !promoted(p.id)))
      .slice(0, 2)
      .map(([g]) => g)
  );
  // A list that held no layout control of its own leads with Layout, where its spans are.
  const added = entries.findIndex(([g, list]) => g === 'layout' && list.every((p) => promoted(p.id)));
  if (added > 0) entries.unshift(...entries.splice(added, 1));
  const tucked = (g: StylePropDef['group'], p: StylePropDef) => long && !promoted(p.id) && !(primary.has(g) && !p.advanced) && !setAnywhere(p.id);
  return entries
    .map(([g, list]) => {
      const rel = list.filter((p) => relevant(p.id));
      const visible = rel.filter((p) => !tucked(g, p));
      return { g, rel, visible, hidden: rel.length - visible.length };
    })
    .filter((x) => x.rel.length);
}
