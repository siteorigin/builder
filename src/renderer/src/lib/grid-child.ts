/**
 * Whether what the Inspector styles sits directly in a grid, and the style rows that follow from it: a grid item's
 * Column span and Row span show in the Layout group itself rather than behind its "more" toggle.
 */
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, NodeTree, ProjectState, ResponsiveScope } from '@shared/types';
import { cascadeStyles, type StyleLayer, type StylePropDef } from '@shared/styles';
import { designLayers } from '@shared/variants';
import { itemStylesOf } from '@shared/item-styles';
import { findParent } from '@engine/tree';
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
  /** The selected list item, whose own part styles apply to the boxes around it. */
  itemId?: string;
}

const MAX_DEPTH = 64;

const nodeOf = (tree: NodeTree, id: string): GraphNode | undefined => (Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined);

function inside(walk: Walk, outer: Frame, placement: InstanceNode): Frame | null {
  const def = Object.hasOwn(walk.state.components, placement.definitionId) ? walk.state.components[placement.definitionId] : undefined;
  // A code component's markup is its source: what surrounds anything inside it is unknown.
  return def?.kind === 'managed' && def.tree ? { tree: def.tree, def, placement, outer } : null;
}

/** What a placement's own changes add to one node of its design. */
function placementLayers(walk: Walk, frame: Frame, nodeId: string): StyleLayer[] {
  const { def, placement, outer } = frame;
  if (!def || !placement) return [];
  const isRoot = def.tree?.rootIds[0] === nodeId;
  const out: StyleLayer[] = [];
  for (const [partId, styles] of Object.entries(placement.overrides ?? {})) {
    const target = partId === 'root' ? def.tree?.rootIds[0] : def.parts[partId]?.nodeId;
    if (target === nodeId) out.push({ styles, strength: 3, wideColumns: true });
  }
  if (walk.itemId) {
    for (const [partId, part] of Object.entries(def.parts)) {
      const styles = part.nodeId === nodeId ? itemStylesOf(def, placement, partId, walk.itemId) : undefined;
      if (styles) out.push({ styles, strength: 4, wideColumns: true });
    }
  }
  // A design whose root is this placement hands its own placement's changes on to this root.
  if (isRoot && outer?.placement && outer.tree.rootIds[0] === placement.id) out.unshift(...placementLayers(walk, outer, placement.id));
  return out;
}

/** The style rules on one element, weakest first. */
function boxLayers(walk: Walk, frame: Frame, node: GraphNode): StyleLayer[] {
  if (!frame.def) return [{ styles: node.styles, strength: 1 }];
  const chosen = frame.placement ? frame.placement.variants : walk.look ? { [walk.look.axis]: walk.look.variant } : undefined;
  return [...designLayers(frame.def, node.id, chosen), ...placementLayers(walk, frame, node.id)];
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

/**
 * Whether the element a node renders is wrapped in another of the runtime's own (a card's action link, a carousel's
 * frame), which is then the grid's item: a span on the element would do nothing.
 */
function wrapped(state: ProjectState, node: GraphNode, depth = 0): boolean {
  if (node.kind === 'instance') {
    const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
    const root = def?.kind === 'managed' && def.tree ? nodeOf(def.tree, def.tree.rootIds[0]) : undefined;
    return !!root && depth < MAX_DEPTH && wrapped(state, root, depth + 1);
  }
  return isCarouselTrack(node) || (node.kind === 'element' && node.action !== undefined && node.action !== null && isCardLink(node));
}

/**
 * Whether the element `ref` styles is a direct item of a grid at the size being edited: the box around it as the site
 * renders it, whatever repeats and slots lie between. Under All sizes, a grid at any screen size counts. `look` is
 * the look a design's own node is styled in. False where it cannot be told, as inside a code component.
 */
export function isGridChild(state: ProjectState, ref: ElementRef, scope: ResponsiveScope, look?: EditedLook): boolean {
  const tree = treeFor(state, ref.owner);
  if (!tree) return false;
  const walk: Walk = { state, look, itemId: ref.itemPath?.[ref.itemPath.length - 1] };
  const owner = ref.owner.kind === 'component' && Object.hasOwn(state.components, ref.owner.id) ? state.components[ref.owner.id] : undefined;
  let frame: Frame = { tree, def: owner };
  for (const id of ref.instancePath) {
    const placement = nodeOf(frame.tree, id);
    const next = placement?.kind === 'instance' ? inside(walk, frame, placement) : null;
    if (!next) return false;
    frame = next;
  }
  const node = nodeOf(frame.tree, ref.nodeId);
  if (!node || node.kind === 'repeat' || node.kind === 'slot' || wrapped(state, node)) return false;
  return parentIsGrid(walk, frame, node.id, scope === 'base' ? ['phone', 'tablet', 'desktop'] : [scope]);
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
