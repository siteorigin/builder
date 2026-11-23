/**
 * How Layers and the breadcrumb name a layer and describe its visibility. Pure functions over the project
 * state, so what a row says (to the eye and to a screen reader) can be tested without rendering it.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, ProjectState, ResponsiveStyles } from '@shared/types';
import { isBinding } from '@shared/types';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { selectedVariantStyles } from '@shared/variants';
import { displayName, findParent } from '@engine/tree';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export interface LayerLabel {
  /** What the row shows: the layer's own name, or its type and a short excerpt of its content. */
  label: string;
  /** The type ("Text", "Heading 2", "Button"), or the layer's own name when it has one. */
  kind: string;
  /** A short excerpt of the content, for an unnamed text or button ("empty" when it has none). */
  excerpt?: string;
  /** The layer has no content at all (an empty paragraph). */
  empty?: boolean;
  /** The whole description, for the accessible name and the tooltip. */
  full: string;
}

/** The longest excerpt a row shows before the rest is left to its tooltip and accessible name. */
const EXCERPT_MAX = 40;
/** The most of the content the accessible name reads out. */
const FULL_MAX = 200;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Cut text at a word boundary near `max` characters, with an ellipsis when anything was left out. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > cut.length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/, '')}…`;
}

/** A node's own words: its text or a button's label, as one line; null when it has no words of its own. */
export function contentText(n: GraphNode): string | null {
  if (n.kind === 'text') {
    if (isBinding(n.text)) return null;
    return squash(typeof n.text === 'string' ? n.text : Array.isArray(n.text) ? richTextToPlain(toRichText(n.text)) : '');
  }
  if (n.kind === 'link') return isBinding(n.label) ? null : squash(String(n.label ?? ''));
  return null;
}

/** For text or a button in a component's design that shows one of its settings: that setting's name. */
function boundTo(n: GraphNode, def: ComponentDefinition | undefined): string | null {
  const v = n.kind === 'text' ? n.text : n.kind === 'link' ? n.label : undefined;
  if (!def || !isBinding(v) || !('$prop' in v)) return null;
  return def.properties[v.$prop]?.label ?? null;
}

/**
 * The name Layers and the breadcrumb give a layer. A name the author gave always wins, whatever the content
 * says later. Otherwise text and buttons are told apart by their words ("Text · Meet the makers…"), an empty
 * one says so, and one in a component's design names the setting it shows. `def` is the component whose
 * design holds the node, if any.
 */
export function layerLabel(state: ProjectState, n: GraphNode, def?: ComponentDefinition): LayerLabel {
  const kind = displayName(state, n, def);
  if (n.name) return { label: kind, kind, full: kind };
  const words = contentText(n);
  if (words === null) {
    const prop = boundTo(n, def);
    return prop ? { label: `${kind} · ${prop}`, kind, excerpt: prop, full: `${kind} · ${prop}` } : { label: kind, kind, full: kind };
  }
  if (!words) return { label: `${kind} · empty`, kind, excerpt: 'empty', empty: true, full: `${kind}, empty` };
  const excerpt = clip(words, EXCERPT_MAX);
  return { label: `${kind} · ${excerpt}`, kind, excerpt, full: `${kind}: ${clip(words, FULL_MAX)}` };
}

// ---------------------------------------------------------------------------
// Visibility at each screen size
// ---------------------------------------------------------------------------

export type Size = 'phone' | 'tablet' | 'desktop';
export const SIZES: Size[] = ['phone', 'tablet', 'desktop'];

/**
 * One record of styles that can hide a layer. `tier` is how strongly its rules apply, as the generated CSS
 * orders them: a component's design (0), the options a placement chose (1), the placement's override (2).
 * `partId` is the placement override a change writes; null for a record a placement does not edit.
 */
type Layer = { styles?: ResponsiveStyles; tier: number; partId?: string | null };

const partOf = (def: ComponentDefinition | undefined, nodeId: string) => (def ? Object.entries(def.parts).find(([, p]) => p.nodeId === nodeId)?.[0] : undefined);
const defOf = (state: ProjectState, n: InstanceNode) => (Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined);

/** A node of a placed component's design as that placement shows it: the design's styles, the options the
 *  placement chose (a variant can show what the design hides), and the placement's override of that part. */
function placedStyles(def: ComponentDefinition, n: InstanceNode, nodeId: string, partId: string | undefined): Layer[] {
  return [
    { styles: def.tree?.nodes[nodeId]?.styles, tier: 0, partId: null },
    ...selectedVariantStyles(def, n.variants, nodeId).map((styles) => ({ styles, tier: 1, partId: null })),
    ...(partId ? [{ styles: n.overrides?.[partId], tier: 2, partId }] : [])
  ];
}

/**
 * The styles that decide whether a layer shows: a primitive's own; for a placed component, its design's root
 * with its chosen options and the placement's override of it ("root", what Layers' eye and the inspector
 * write); for a part of a placement (`partId`), the same for that part.
 */
function visibilityStyles(state: ProjectState, n: GraphNode, partId?: string): Layer[] {
  // A repeat or a slot renders no element of its own, so nothing on it hides anything.
  if (n.kind === 'repeat' || n.kind === 'slot') return [];
  if (n.kind !== 'instance') return partId ? [] : [{ styles: n.styles, tier: 0 }];
  const def = defOf(state, n);
  const pid = partId ?? 'root';
  const nodeId = def?.parts[pid]?.nodeId ?? (pid === 'root' ? def?.tree?.rootIds[0] : undefined);
  return def && nodeId ? placedStyles(def, n, nodeId, pid) : [{ styles: n.overrides?.[pid], tier: 2, partId: pid }];
}

type Decision = { hidden: boolean; by: 'base' | 'size' | 'layout' };

/**
 * What one record says about a size. Its own `hidden` for the size wins, then its every-size `hidden`. Without
 * either, arranging the layer (a layout) gives it a display of its own, which shows it over a weaker hide.
 * `media` is whether the rule that says it sits in the size's media block (after every rule outside one).
 */
function said(styles: ResponsiveStyles | undefined, size: Size): (Decision & { media: boolean }) | null {
  const own = styles?.[size]?.hidden;
  if (typeof own === 'boolean') return { hidden: own, by: 'size', media: true };
  const all = styles?.base?.hidden;
  if (typeof all === 'boolean') {
    // The generator writes an every-size hide into each size's block when any size shows it or arranges it.
    const split = SIZES.some((z) => styles?.[z]?.hidden === false || (styles?.[z]?.layout !== undefined && styles?.[z]?.hidden === undefined));
    return { hidden: all, by: 'base', media: split };
  }
  if (styles?.[size]?.layout !== undefined) return { hidden: false, by: 'layout', media: true };
  if (styles?.base?.layout !== undefined) return { hidden: false, by: 'layout', media: false };
  return null;
}

/** Whether the records hide the layer at one size. The strongest tier that says anything decides; inside a tier
 *  a rule in the size's media block beats one outside it, and a later rule beats an earlier one. */
function decide(layers: Layer[], size: Size): Decision | null {
  for (let tier = 2; tier >= 0; tier--) {
    let best: (Decision & { media: boolean }) | null = null;
    for (const l of layers) {
      if (l.tier !== tier) continue;
      const d = said(l.styles, size);
      if (d && (!best || d.media || !best.media)) best = d;
    }
    if (best) return { hidden: best.hidden, by: best.by };
  }
  return null;
}

export interface OwnVisibility {
  /** The sizes the layer hides itself at, in size order. */
  hiddenAt: Size[];
  /** Where each hidden size's hide comes from: the every-size setting, or that size's own. */
  by: Partial<Record<Size, 'base' | 'size'>>;
}

function visibilityOf(layers: Layer[]): OwnVisibility {
  const out: OwnVisibility = { hiddenAt: [], by: {} };
  for (const size of SIZES) {
    const d = decide(layers, size);
    if (d?.hidden) (out.hiddenAt.push(size), (out.by[size] = d.by === 'size' ? 'size' : 'base'));
  }
  return out;
}

/** A layer's own visibility at each size (a part of a placed component with `partId`). */
export function ownVisibility(state: ProjectState, n: GraphNode, partId?: string): OwnVisibility {
  return visibilityOf(visibilityStyles(state, n, partId));
}

/** A change to the `hidden` style of a layer (`partId` for a placement's override). */
export interface VisibilityEdit {
  partId?: string;
  scope: 'base' | Size;
  value: boolean | null;
}

/** The record a change writes, or null when the layer has none (a repeat, or a part with no override). */
function writable(state: ProjectState, n: GraphNode, partId?: string) {
  const l = visibilityStyles(state, n, partId).find((x) => x.partId !== null);
  return l ? { styles: l.styles ?? {}, target: l.partId ? { partId: l.partId } : {} } : null;
}

/** A copy of the node with the edits made, to see what they leave. */
function withEdits(n: GraphNode, edits: VisibilityEdit[]): GraphNode {
  const out = structuredClone(n);
  for (const e of edits) {
    let styles: ResponsiveStyles;
    if (e.partId && out.kind === 'instance') styles = (out.overrides ??= {})[e.partId] ??= {};
    else styles = out.styles ??= {};
    const props = (styles[e.scope] ??= {});
    if (e.value === null) delete props.hidden;
    else props.hidden = e.value;
  }
  return out;
}

/** Edits that make one size (or every size) hidden or shown, each trying the smallest change first: taking a
 *  setting away before adding one. Empty when the layer is already that way, or cannot be changed. */
function plan(state: ProjectState, n: GraphNode, partId: string | undefined, sizes: Size[], hide: boolean, everySize: boolean): VisibilityEdit[] {
  const w = writable(state, n, partId);
  if (!w) return [];
  const done = (edits: VisibilityEdit[]) => {
    const v = ownVisibility(state, withEdits(n, edits), partId).hiddenAt;
    return sizes.every((z) => v.includes(z) === hide);
  };
  if (done([])) return [];
  const edits: VisibilityEdit[] = [];
  const set = (scope: 'base' | Size, value: boolean | null) => {
    const at = edits.findIndex((e) => e.scope === scope);
    if (at >= 0) edits.splice(at, 1);
    if ((w.styles[scope]?.hidden ?? null) !== value) edits.push({ ...w.target, scope, value });
  };
  // Settings of this record that work against the goal go first.
  for (const z of sizes) if (w.styles[z]?.hidden === !hide) set(z, null);
  if (everySize) {
    if (w.styles.base?.hidden === !hide) set('base', null);
    if (hide) set('base', true);
  }
  if (done(edits)) return edits;
  if (everySize && !hide) {
    // Something weaker hides it everywhere (the component's design): the placement shows it at every size.
    set('base', false);
    if (done(edits)) return edits;
  }
  // Whatever still disagrees gets a setting of its own for that size.
  const now = ownVisibility(state, withEdits(n, edits), partId).hiddenAt;
  for (const z of sizes) if (now.includes(z) !== hide) set(z, hide);
  return edits;
}

/** Show a layer again at one size only, leaving every other size as it is. */
export function showHereEdits(state: ProjectState, n: GraphNode, size: Size, partId?: string): VisibilityEdit[] {
  return plan(state, n, partId, [size], false, false);
}

/** Hide a layer at one size only. */
export function hideHereEdits(state: ProjectState, n: GraphNode, size: Size, partId?: string): VisibilityEdit[] {
  return plan(state, n, partId, [size], true, false);
}

/** Hide a layer at every size, or show it at every size: what each size said of its own goes too. */
export function everySizeEdits(state: ProjectState, n: GraphNode, hide: boolean): VisibilityEdit[] {
  return plan(state, n, undefined, SIZES, hide, true);
}

/** What hides a layer from above: a container, or a part of the component placement that holds it. */
export interface HiddenBy {
  /** The node of the layer's own tree that holds it (a container, or the placement whose part hides it). */
  id: string;
  /** For a part of that placement: the part, and the node of the component's design it is. */
  part?: { id: string; nodeId: string };
  name: string;
  sizes: Size[];
}

/**
 * The nearest layer of a placement's design above `nodeId` (a node of that design) that hides at this size:
 * the design's own wrappers, with the placement's choices and overrides. The design's root is the placement
 * itself, which the caller checks.
 */
function hiddenInPlacement(state: ProjectState, n: InstanceNode, nodeId: string, size: Size): HiddenBy | null {
  const def = defOf(state, n);
  const design = def?.tree;
  if (!def || !design) return null;
  const seen = new Set<string>([nodeId]);
  for (let q = findParent(design, nodeId); q?.parentId && !seen.has(q.parentId); q = findParent(design, q.parentId)) {
    seen.add(q.parentId);
    if (q.parentId === design.rootIds[0]) break;
    const node = design.nodes[q.parentId];
    if (!node || node.kind === 'repeat' || node.kind === 'slot') continue;
    const pid = partOf(def, q.parentId);
    const v = visibilityOf(placedStyles(def, n, q.parentId, pid));
    if (v.hiddenAt.includes(size)) {
      const label = pid ? def.parts[pid].label : layerLabel(state, node, def).label;
      return { id: n.id, ...(pid ? { part: { id: pid, nodeId: q.parentId } } : {}), name: `${layerLabel(state, n).label} › ${label}`, sizes: v.hiddenAt };
    }
  }
  return null;
}

/**
 * The nearest layer above a node in its own tree that hides at this size, and so hides the node too. Content
 * placed in a component's slot also sits inside the wrappers of that slot in the component's design, so a
 * placement that hides one of those (its Container part, say) hides the content as well.
 */
export function hiddenAncestor(state: ProjectState, tree: NodeTree, nodeId: string, size: Size): HiddenBy | null {
  const seen = new Set<string>([nodeId]);
  for (let p = findParent(tree, nodeId); p?.parentId && !seen.has(p.parentId); p = findParent(tree, p.parentId)) {
    seen.add(p.parentId);
    const up = tree.nodes[p.parentId];
    if (!up) break;
    if (up.kind === 'instance' && p.slot) {
      const slotNode = Object.values(defOf(state, up)?.tree?.nodes ?? {}).find((x) => x.kind === 'slot' && x.slot === p!.slot);
      const inside = slotNode && hiddenInPlacement(state, up, slotNode.id, size);
      if (inside) return inside;
    }
    const v = ownVisibility(state, up);
    if (v.hiddenAt.includes(size)) return { id: up.id, name: layerLabel(state, up).label, sizes: v.hiddenAt };
  }
  return null;
}

const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "on phone", "on phone and tablet", or "at every size". */
export function sizesText(sizes: Size[]): string {
  return sizes.length === SIZES.length ? 'at every size' : `on ${listJoin(sizes)}`;
}

export interface RowVisibility {
  own: OwnVisibility;
  /** The layer hides itself in the preview being shown. */
  hiddenHere: boolean;
  /** A layer above hides it in the preview being shown (when it does not hide itself there). */
  hiddenBy: HiddenBy | null;
  /** What a screen reader hears after the name, and what the tooltip says (empty when it shows everywhere). */
  note: string;
}

/** A Layers row's visibility while the preview shows `size` (a part of the placement `n` with `partId`). */
export function rowVisibility(state: ProjectState, tree: NodeTree, n: GraphNode, size: Size, partId?: string): RowVisibility {
  const own = ownVisibility(state, n, partId);
  const hiddenHere = own.hiddenAt.includes(size);
  let hiddenBy: HiddenBy | null = null;
  if (!hiddenHere) {
    if (partId && n.kind === 'instance') {
      // A part sits inside its placement: first the design's wrappers around it, then the placement itself.
      const nodeId = defOf(state, n)?.parts[partId]?.nodeId;
      const placement = ownVisibility(state, n);
      hiddenBy =
        (nodeId ? hiddenInPlacement(state, n, nodeId, size) : null) ??
        (placement.hiddenAt.includes(size) ? { id: n.id, name: layerLabel(state, n).label, sizes: placement.hiddenAt } : hiddenAncestor(state, tree, n.id, size));
    } else hiddenBy = hiddenAncestor(state, tree, n.id, size);
  }
  const notes: string[] = [];
  if (own.hiddenAt.length) notes.push(`hidden ${sizesText(own.hiddenAt)}`);
  if (hiddenBy) notes.push(`hidden ${sizesText([size])} because ${hiddenBy.name} is hidden ${sizesText(hiddenBy.sizes)}`);
  return { own, hiddenHere, hiddenBy, note: notes.join('; ') };
}

export interface EyeAction {
  /** The layer hides itself in the preview being shown. */
  pressed: boolean;
  /** What a click says it does ("Show on phone", "Hide at every size"). */
  action: string;
  edits: VisibilityEdit[];
}

/**
 * What a row's eye does in the preview being shown. It is pressed when the layer hides itself there. A click
 * on a pressed eye shows it again: on this size alone when this size's own setting hides it, otherwise at every
 * size. A click on an open eye hides it at every size, as the eye always has.
 */
export function eyeAction(state: ProjectState, n: GraphNode, size: Size): EyeAction {
  const own = ownVisibility(state, n);
  if (own.hiddenAt.includes(size)) {
    if (own.by[size] === 'size') return { pressed: true, action: `Show on ${size}`, edits: showHereEdits(state, n, size) };
    return { pressed: true, action: 'Show at every size', edits: everySizeEdits(state, n, false) };
  }
  return { pressed: false, action: 'Hide at every size', edits: everySizeEdits(state, n, true) };
}
