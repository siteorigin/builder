/**
 * Turn into slot (#659): a container of a project component's design becomes the place where each placement puts
 * content of its own. The container stays where it is, with its tag, layout and styles; its children give way to the
 * outlet of a new slot that takes anything, all in one change. They either move into that slot of every placement,
 * each getting its own copy as it shows them now (its values, its look, its own style changes), or go, leaving the
 * slot empty everywhere.
 */
import type { ComponentDefinition, ElementNode, GraphNode, NodeTree, ProjectState, SlotNode } from '@shared/types';
import { conditionRef, isBinding, isBindingRef } from '@shared/types';
import type { Op } from '@shared/ops';
import { newId } from '@shared/ids';
import { groupLookup, hasGroupStyles, partInInteractionGroup } from '@shared/interaction-groups';
import { designLayers, variantOptions } from '@shared/variants';
import { propBindingSchema } from '@shared/bindings';
import { anchorsInUse, displayName, fail, findParent, getTree, instancesOf, settledRoot, subtreeIds } from './tree';
import { shownOnceIn } from './slots';
import { insertsInline } from './semantic-tags';
import { bindingSlots, isProtoKey, usesState } from './schema';
import { dependentsOf, dropPartOverrides, setSlot } from './definitions';
import { placementRenderer, placementStart, type RenderedDesign } from './detach';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The longest a slot's label can be (as component.setSlot takes it). */
const LABEL_MAX = 60;
const SLOT_NAME = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** The nodes around one of a tree's nodes, nearest first, each once (a tree damaged by hand can list one under itself). */
function around(tree: NodeTree, nodeId: string): GraphNode[] {
  const out: GraphNode[] = [];
  const seen = new Set<string>([nodeId]);
  for (let at = findParent(tree, nodeId); at?.parentId && !seen.has(at.parentId); at = findParent(tree, at.parentId)) {
    seen.add(at.parentId);
    const n = own(tree.nodes, at.parentId);
    if (n) out.push(n);
  }
  return out;
}

/** What a container holds, below it: its children and everything under them, content given to components placed there included. */
function heldIds(tree: NodeTree, node: ElementNode): string[] {
  return node.children.flatMap((c) => subtreeIds(tree, c));
}

/** Whether an image is among a container's own elements, the way a container that opens its image looks for one. */
function holdsImage(tree: NodeTree, ids: readonly string[], seen = new Set<string>()): boolean {
  return ids.some((id) => {
    const n = own(tree.nodes, id);
    if (!n || seen.has(id)) return false;
    seen.add(id);
    return n.kind === 'image' || (n.kind === 'element' && holdsImage(tree, n.children, seen));
  });
}

/**
 * Whether a navigation region or a dialog takes its accessible name from the heading it starts with, as the generator
 * picks that heading (labellingHeading): plain text at heading levels only, h2 to h6 for a navigation region, that is
 * there whenever the container is (a navigation region's may show only while its own text is set), and no name of
 * the container's own set in its place.
 */
function namedByHeading(def: RenderedDesign, node: ElementNode): boolean {
  const overlay = node.overlay !== undefined;
  if ((node.tag !== 'nav' && !overlay) || (typeof node.ariaLabel === 'string' && node.ariaLabel.trim())) return false;
  const first = own(def.tree.nodes, node.children[0]);
  if (first?.kind !== 'text' || first.rich || first.unless) return false;
  const choice = isBinding(first.tag) && '$prop' in first.tag ? propBindingSchema(def.properties, first.tag) : undefined;
  const tags = !isBinding(first.tag) ? [first.tag] : choice?.type === 'enum' ? choice.options.map((o) => o.value) : [];
  if (!tags.length || !tags.every((t) => (overlay ? /^h[1-6]$/ : /^h[2-6]$/).test(t))) return false;
  return !first.when || (!overlay && isBinding(first.text) && JSON.stringify(first.when) === JSON.stringify(first.text));
}

/**
 * Why a node of a component's design can't become a slot, whichever way its content goes, or null when it can: a
 * container of a project component built in the editor, that shows once wherever the design shows (not in a list,
 * nor in a slot's fallback, nor in a slot of a component placed in the design that shows it other than once), can
 * hold block content, and holds no list or slot of its own. Nothing around it, nor the container itself, may depend
 * on what it holds now: an image it opens, the heading that names it, hiding while everything in it is hidden.
 */
export function containerToSlotProblem(state: ProjectState, def: ComponentDefinition, nodeId: string): string | null {
  if (def.owner !== 'project' || def.kind !== 'managed' || !def.tree) return `“${def.name}” isn’t built in the editor, so its elements can’t become a slot.`;
  const tree = def.tree;
  if (!settledRoot(tree)) return `“${def.name}” has no single top element yet.`;
  const node = own(tree.nodes, nodeId);
  if (!node || node.kind !== 'element') return 'Pick a container (a Stack, Row, Grid or Container) to turn into a slot.';
  const name = `“${displayName(state, node, def)}”`;
  if (!findParent(tree, nodeId)) return `${name} isn’t part of the design.`;
  const outer = around(tree, nodeId);
  if (outer.some((a) => a.kind === 'repeat')) return `${name} is repeated by a list, so a slot there would show once for every item.`;
  const fallbackOf = outer.find((a): a is SlotNode => a.kind === 'slot');
  if (fallbackOf) return `${name} is what the “${own(def.slots, fallbackOf.slot)?.label ?? fallbackOf.slot}” slot shows while it is empty, so a slot there would show only then.`;
  if (!shownOnceIn(state, tree, nodeId)) return `${name} is in a slot of a component placed in the design that doesn’t show it exactly once.`;
  if (insertsInline(state, { kind: 'component', id: def.id }, nodeId)) return `${name} holds only words in a line (a paragraph or span container), so it can’t hold a slot.`;
  for (const id of heldIds(tree, node)) {
    const n = own(tree.nodes, id);
    if (n?.kind === 'repeat') return `${name} holds a list, which can’t become part of a slot. Pick a container that holds no list.`;
    if (n?.kind === 'slot') return `${name} already holds the “${own(def.slots, n.slot)?.label ?? n.slot}” slot. Pick a container that holds no slot.`;
  }
  if (node.collapseEmpty) return `${name} hides while everything in it is hidden, which it can’t tell of a slot’s content. Turn off Hide when empty first.`;
  // A container that opens its image full size finds it among its own elements, up to the first component around it.
  const edge = outer.findIndex((a) => a.kind !== 'element');
  const viewer = [node, ...(edge < 0 ? outer : outer.slice(0, edge))].find((a) => a.kind === 'element' && (a.action === 'image' || isBinding(a.action)));
  if (viewer && holdsImage(tree, node.children)) return `“${displayName(state, viewer, def)}” opens the image in ${name} full size, which it can’t find in a slot. Turn that action off first.`;
  if (namedByHeading(def as RenderedDesign, node))
    return `${name} takes its accessible name from the heading it starts with, which a slot can’t give it. Give it an accessible name of its own first.`;
  return null;
}

/**
 * Why a container's content can't move into its component's placements, or null when it can: content that reads or
 * changes the component's UI state, that follows an interaction group around the container, or that keeps an anchor
 * an earlier element uses; a placement inside another component's design, or filled from a collection's entries,
 * where one copy can't stand for every time it shows; or a component a code component places in its source.
 */
function moveProblem(state: ProjectState, def: RenderedDesign, node: ElementNode): string | null {
  const tree = def.tree;
  const name = `“${displayName(state, node, def)}”`;
  const held = heldIds(tree, node);
  const nodes = held.flatMap((id) => (own(tree.nodes, id) ? [tree.nodes[id]] : []));
  if (usesState(nodes)) return `${name} holds content that reads or changes the UI state of “${def.name}”, which a placement’s own content can’t. Choose an empty slot, or remove those conditions and button actions first.`;
  // A list the site fills in where the component is placed (its pages, its posts, or a list whose cards follow the
  // pages they link to) would be frozen as it is today: it would stop following the site.
  for (const n of nodes)
    for (const slot of bindingSlots(n)) {
      const ref = slot.field === 'when' || slot.field === 'unless' ? conditionRef(slot.value) : slot.value;
      const schema = isBinding(ref) && '$prop' in ref ? own(def.properties, ref.$prop) : undefined;
      if (schema?.type === 'list' && (schema.feed || schema.pageTeaser))
        return `${name} shows “${schema.label}”, which the site fills in wherever “${def.name}” is placed, so a fixed copy of it can’t stand in each placement. Choose an empty slot instead.`;
    }
  // Group states follow the nearest interaction group around an element. A group around the container stays in the
  // design, which never reaches a placement's content: what follows it would no longer show.
  const nearest = groupLookup(tree);
  const inside = new Set(held);
  const lookups = new Map<string, (nodeId: string) => string | null>();
  const placements = instancesOf(state, def.id);
  for (const n of nodes) {
    const group = nearest(n.id);
    const crossed = group !== null && !inside.has(group);
    const parts = Object.entries(def.parts).filter(([pid, p]) => pid !== 'root' && p.nodeId === n.id).map(([pid]) => pid);
    // The design's rules on it, through the look each placement shows, and each placement's own style changes to it.
    const styled = placements.some(({ node: p }) => designLayers(def, n.id, p.variants).some((l) => hasGroupStyles(l.styles)) || parts.some((pid) => hasGroupStyles(own(p.overrides, pid))));
    const inner = n.kind === 'instance' ? own(state.components, n.definitionId) : undefined;
    const lost =
      (crossed && styled) ||
      (n.kind === 'instance' &&
        Object.entries(n.overrides ?? {}).some(([pid, o]) => hasGroupStyles(o) && partInInteractionGroup(inner, pid, group !== null, lookups) && !partInInteractionGroup(inner, pid, group !== null && inside.has(group), lookups)));
    if (lost)
      return `“${displayName(state, n, def)}” has styles for while its card is hovered or has focus, from an interaction group around ${name}, which its content in each placement would no longer follow. Choose an empty slot, or reset those styles first.`;
  }
  for (const { owner, node: p, label } of placements) {
    if (owner.kind === 'component')
      return `“${label}” places “${def.name}” in its design, where one copy of the content would show for every placement of “${label}”. Choose an empty slot, or move that placement first.`;
    const bound = Object.values(p.props).some((v) => isBinding(v)) || Object.values(p.variants ?? {}).some((v) => isBindingRef(v));
    if (bound) return `${label} fills “${def.name}” from each entry it shows, so one copy of the content can’t stand for all of them. Choose an empty slot instead.`;
  }
  const code = dependentsOf(state, def.id)[0];
  if (code) return `“${code.name}” places “${def.name}” in its code, which can’t be given the content. Choose an empty slot instead.`;
  return null;
}

/** Why a slot can't be stored under `slot` in `def`, or null: taken by a slot, a property, an outlet, or content a placement keeps. */
function slotNameProblem(state: ProjectState, def: RenderedDesign, slot: string): string | null {
  if (!SLOT_NAME.test(slot) || isProtoKey(slot)) return `Slot names must be camelCase identifiers ("${slot}").`;
  const taken =
    Object.hasOwn(def.slots ?? {}, slot) ||
    Object.hasOwn(def.properties, slot) ||
    Object.values(def.tree.nodes).some((n) => n.kind === 'slot' && n.slot === slot) ||
    instancesOf(state, def.id).some(({ node }) => Object.hasOwn(node.slots ?? {}, slot));
  return taken ? `“${def.name}” already uses the name "${slot}". Choose another.` : null;
}

/**
 * The operation: the container's children give way to a new slot's outlet, and the slot is declared, taking anything.
 * With `keep: 'placements'`, each placement first gets its own copy of the children as it shows them, in its new slot,
 * rendered as detaching renders a design; with `keep: 'none'`, the children go, and the slot starts empty everywhere.
 * Their parts and variant rules go with them, and so do the placements' own style changes to those parts (each
 * copy carries them already). The component's properties stay, though nothing in the design may show some of them
 * any more: placements keep their values.
 */
export function containerToSlot(state: ProjectState, op: Op<'component.containerToSlot'>, copy: (tree: NodeTree, nodeId: string) => string): { definitionId: string; nodeId: string; slot: string; filled: number } {
  const def = own(state.components, op.definitionId) ?? fail(`Component "${op.definitionId}" does not exist.`);
  if (def.owner !== 'project') fail(`"${def.name}" belongs to the theme. Use component.fork or component.duplicate first.`);
  const structural = containerToSlotProblem(state, def, op.nodeId);
  if (structural) fail(structural);
  const design = def as RenderedDesign;
  const tree = design.tree;
  const node = tree.nodes[op.nodeId] as ElementNode;
  const label = op.label.trim().slice(0, LABEL_MAX).trim();
  if (!label) fail('Enter a name for the slot.');
  const taken = slotNameProblem(state, design, op.slot);
  if (taken) fail(taken);
  const children = [...node.children];
  const held = heldIds(tree, node);
  let filled = 0;
  if (op.keep === 'placements' && children.length) {
    const problem = moveProblem(state, design, node);
    if (problem) fail(problem);
    // Every placement is rendered from the design as it is now, before any of it changes. Each one's copies are in its
    // tree before the next is rendered, so a later copy on the same page sees the anchors an earlier one kept.
    for (const { owner, node: inst, label: where } of instancesOf(state, def.id)) {
      const placed = getTree(state, owner);
      const pageId = owner.kind === 'page' ? owner.id : undefined;
      const anchors = anchorsInUse(state, owner);
      const render = placementRenderer(
        state,
        {
          owner,
          tree: placed,
          inst,
          def: design,
          label: inst.name ?? def.name,
          anchors,
          pageId,
          anchorTaken: (anchor, src) =>
            fail(`${where} already uses the anchor “${anchor}”, which “${displayName(state, src, def)}” would take there. Rename one of them first, or choose an empty slot.`)
        },
        copy
      );
      const start = placementStart(state, design, inst, pageId);
      const roots = children.flatMap((c) => render.emit(c, start));
      for (const n of render.added) placed.nodes[n.id] = n;
      if (!roots.length) continue;
      inst.slots = { ...(inst.slots ?? {}), [op.slot]: roots };
      filled++;
    }
  }
  // The container keeps everything of its own; what it held goes, with the parts and variant rules on it.
  const removed = new Set(held);
  for (const id of removed) delete tree.nodes[id];
  for (const [pid, part] of Object.entries(def.parts))
    if (pid !== 'root' && removed.has(part.nodeId)) {
      delete def.parts[pid];
      dropPartOverrides(state, def.id, pid);
    }
  for (const { option } of variantOptions(def)) for (const nid of Object.keys(option.styles ?? {})) if (removed.has(nid)) delete option.styles![nid];
  const outlet: SlotNode = { id: newId('n'), kind: 'slot', slot: op.slot };
  tree.nodes[outlet.id] = outlet;
  node.children = [outlet.id];
  setSlot(state, { type: 'component.setSlot', definitionId: def.id, slot: op.slot, label });
  return { definitionId: def.id, nodeId: outlet.id, slot: op.slot, filled };
}
