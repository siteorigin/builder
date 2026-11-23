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
    return prop ? { label: `${kind} · ${prop}`, kind, excerpt: prop, full: `${kind}, shows ${prop}` } : { label: kind, kind, full: kind };
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

/** One record of styles that can hide a layer; `partId` is the placement override a change writes, null when
 *  the record is the component's own design, which a placement does not edit. */
type Layer = { styles?: ResponsiveStyles; partId?: string | null };

const partOf = (def: ComponentDefinition | undefined, nodeId: string) => (def ? Object.entries(def.parts).find(([, p]) => p.nodeId === nodeId)?.[0] : undefined);

/** A node of a placed component's design as that placement shows it: the design's styles, then the options the
 *  placement chose (a variant can show what the design hides), weakest first. */
const designStyles = (def: ComponentDefinition, n: InstanceNode, nodeId: string): Layer[] => [
  { styles: def.tree?.nodes[nodeId]?.styles, partId: null },
  ...selectedVariantStyles(def, n.variants, nodeId).map((styles) => ({ styles, partId: null }))
];

/**
 * The styles that decide whether a layer shows, weakest first: a primitive's own; for a placed component, its
 * design's root (with its chosen options) and the placement's override of it ("root", what Layers' eye and the
 * inspector write); for a part of a placement (`partId`), the same for that part.
 */
function visibilityStyles(state: ProjectState, n: GraphNode, partId?: string): Layer[] {
  if (n.kind !== 'instance') return partId ? [] : [{ styles: n.styles }];
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  const pid = partId ?? 'root';
  const nodeId = def?.parts[pid]?.nodeId ?? (pid === 'root' ? def?.tree?.rootIds[0] : undefined);
  return [...(def && nodeId ? designStyles(def, n, nodeId) : []), { styles: n.overrides?.[pid], partId: pid }];
}

/** Whether a set of records hides at one size, and whether every size's value or that size's own decides it.
 *  Within one record a size's own value wins; across records the stronger one that says anything wins. */
function decide(layers: Layer[], size: Size): { hidden: boolean; by: 'base' | 'size' } | null {
  let d: { hidden: boolean; by: 'base' | 'size' } | null = null;
  for (const l of layers) {
    const own = l.styles?.[size]?.hidden;
    const all = l.styles?.base?.hidden;
    if (typeof own === 'boolean') d = { hidden: own, by: 'size' };
    else if (typeof all === 'boolean') d = { hidden: all, by: 'base' };
  }
  return d;
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
    if (d?.hidden) (out.hiddenAt.push(size), (out.by[size] = d.by));
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

function editable(state: ProjectState, n: GraphNode, partId?: string) {
  const layers = visibilityStyles(state, n, partId);
  let i = layers.length - 1;
  while (i >= 0 && layers[i].partId === null) i--;
  return i < 0 ? null : { layers, edit: layers[i], weaker: layers.slice(0, i), target: layers[i].partId ? { partId: layers[i].partId! } : {} };
}

/**
 * Show a layer again at one size only, leaving every other size as it is: a hide set for just that size is
 * taken away, and a hide every size shares is answered by that size showing it. Empty when it shows there.
 */
export function showHereEdits(state: ProjectState, n: GraphNode, size: Size, partId?: string): VisibilityEdit[] {
  const e = editable(state, n, partId);
  if (!e || !visibilityOf(e.layers).hiddenAt.includes(size)) return [];
  // Taking the size's own hide away is enough when nothing else would hide it there then.
  const without = [...e.weaker, { styles: { ...e.edit.styles, [size]: { ...e.edit.styles?.[size], hidden: undefined } } }];
  return [{ ...e.target, scope: size, value: e.edit.styles?.[size]?.hidden === true && !decide(without, size)?.hidden ? null : false }];
}

/** Hide a layer at one size only. Empty when it already hides there. */
export function hideHereEdits(state: ProjectState, n: GraphNode, size: Size, partId?: string): VisibilityEdit[] {
  const e = editable(state, n, partId);
  if (!e || visibilityOf(e.layers).hiddenAt.includes(size)) return [];
  // Shown here only as an exception to a hide every size shares: taking the exception away hides it.
  const without = [...e.weaker, { styles: { ...e.edit.styles, [size]: { ...e.edit.styles?.[size], hidden: undefined } } }];
  return [{ ...e.target, scope: size, value: e.edit.styles?.[size]?.hidden === false && decide(without, size)?.hidden ? null : true }];
}

/** Hide a layer at every size (sizes with their own visibility keep it), or show it again there. */
export function everySizeEdits(state: ProjectState, n: GraphNode, hide: boolean): VisibilityEdit[] {
  const e = editable(state, n);
  if (!e) return [];
  if (hide) return e.edit.styles?.base?.hidden === true ? [] : [{ ...e.target, scope: 'base', value: true }];
  // The component's own design may hide it too: the placement then says to show it.
  const designHides = e.weaker.some((l) => l.styles?.base?.hidden === true);
  if (designHides) return e.edit.styles?.base?.hidden === false ? [] : [{ ...e.target, scope: 'base', value: false }];
  return e.edit.styles?.base?.hidden === true ? [{ ...e.target, scope: 'base', value: null }] : [];
}

/** What hides a layer from above: the container, or the part of a component holding it in a slot. */
export interface HiddenBy {
  /** The node of the layer's own tree that holds it (a container, or the placement whose part hides it). */
  id: string;
  /** For a part of that placement: the part, and the node of the component's design it is. */
  part?: { id: string; nodeId: string };
  name: string;
  sizes: Size[];
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
      const def = Object.hasOwn(state.components, up.definitionId) ? state.components[up.definitionId] : undefined;
      const design = def?.tree;
      const slotNode = design && Object.values(design.nodes).find((x) => x.kind === 'slot' && x.slot === p!.slot);
      const wrappers = new Set<string>();
      for (let q = slotNode ? findParent(design, slotNode.id) : null; q?.parentId && !wrappers.has(q.parentId); q = findParent(design!, q.parentId)) {
        wrappers.add(q.parentId);
        // The design's root is the placement itself, checked below.
        if (q.parentId === design!.rootIds[0]) break;
        const pid = partOf(def, q.parentId);
        const v = visibilityOf([...designStyles(def!, up, q.parentId), ...(pid ? [{ styles: up.overrides?.[pid] }] : [])]);
        if (v.hiddenAt.includes(size)) {
          const label = pid ? def!.parts[pid].label : layerLabel(state, design!.nodes[q.parentId], def).label;
          return { id: up.id, ...(pid ? { part: { id: pid, nodeId: q.parentId } } : {}), name: `${layerLabel(state, up).label} › ${label}`, sizes: v.hiddenAt };
        }
      }
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
    // A part sits inside its placement: the placement's own hide is its container's.
    const placement = partId ? ownVisibility(state, n) : null;
    hiddenBy = placement?.hiddenAt.includes(size) ? { id: n.id, name: layerLabel(state, n).label, sizes: placement.hiddenAt } : hiddenAncestor(state, tree, n.id, size);
  }
  const notes: string[] = [];
  if (own.hiddenAt.length) notes.push(`hidden ${sizesText(own.hiddenAt)}`);
  if (hiddenBy) notes.push(`hidden ${sizesText([size])} because ${hiddenBy.name} is hidden ${sizesText(hiddenBy.sizes)}`);
  return { own, hiddenHere, hiddenBy, note: notes.join('; ') };
}

/** A copy of the node with the edits made, to see what they leave. */
function withEdits(n: GraphNode, edits: VisibilityEdit[]): GraphNode {
  const out = structuredClone(n);
  for (const e of edits) {
    let styles: ResponsiveStyles;
    if (e.partId && out.kind === 'instance') styles = ((out.overrides ??= {})[e.partId] ??= {});
    else styles = out.styles ??= {};
    const props = (styles[e.scope] ??= {});
    if (e.value === null) delete props.hidden;
    else props.hidden = e.value;
  }
  return out;
}

export interface EyeAction {
  /** The layer hides itself in the preview being shown. */
  pressed: boolean;
  /** What a click says it does ("Show on phone", "Hide at every size"). */
  action: string;
  edits: VisibilityEdit[];
}

/**
 * What a row's eye does in the preview being shown. It is pressed when the layer hides itself there. Showing
 * undoes what hides it there: a hide set for just this size is taken away on this size alone, and a hide set
 * for every size is taken away everywhere (sizes with their own hide keep it). Hiding hides at every size, as
 * the eye always has, unless the layer shows here only as an exception to such a hide: then the exception goes.
 */
export function eyeAction(state: ProjectState, n: GraphNode, size: Size): EyeAction {
  const own = ownVisibility(state, n);
  if (own.hiddenAt.includes(size)) {
    if (own.by[size] === 'size') return { pressed: true, action: `Show on ${size}`, edits: showHereEdits(state, n, size) };
    const all = everySizeEdits(state, n, false);
    // Whatever still hides it here once every size shows it (the design's own hide for this size, say).
    return { pressed: true, action: 'Show at every size', edits: [...all, ...showHereEdits(state, withEdits(n, all), size)] };
  }
  const all = everySizeEdits(state, n, true);
  const rest = hideHereEdits(state, withEdits(n, all), size);
  if (!all.length) return { pressed: false, action: `Hide on ${size}`, edits: rest };
  return { pressed: false, action: 'Hide at every size', edits: [...all, ...rest] };
}
