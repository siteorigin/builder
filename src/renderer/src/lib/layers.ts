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
 * One record of styles that can hide a layer, as the generated CSS applies it. `tier` is how strongly its rules
 * apply: a component's design or a primitive's own styles (0), the options a placement chose (1), the
 * placement's overrides (2). `weaker` is what the generator checks before it writes a display that shows the
 * layer again for `hidden: false` (only options and overrides do that). `partId` is the placement override a
 * change writes; null for a record a placement does not edit.
 */
type Layer = { styles?: ResponsiveStyles; tier: number; weaker?: ResponsiveStyles[]; partId?: string | null };

const partOf = (def: ComponentDefinition | undefined, nodeId: string) => (def ? Object.entries(def.parts).find(([, p]) => p.nodeId === nodeId)?.[0] : undefined);
const defOf = (state: ProjectState, n: InstanceNode) => (Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined);
const present = (list: Array<ResponsiveStyles | undefined>) => list.filter((x): x is ResponsiveStyles => !!x);

/**
 * A node of a placed component's design as that placement shows it, in stylesheet order: the design's styles,
 * the options the placement chose (axis by axis), then the placement's overrides that style the node (for the
 * root, every part that is the root element, in the order the generator writes them).
 */
function placedStyles(def: ComponentDefinition, n: InstanceNode, nodeId: string): Layer[] {
  const design = def.tree?.nodes[nodeId]?.styles;
  const axes = Object.entries(def.variantAxes ?? {});
  const chosen = selectedVariantStyles(def, n.variants, nodeId);
  const options: Layer[] = chosen.map((styles) => {
    // An option's "show" undoes a hide from the design or from any option of an earlier axis.
    const at = axes.findIndex(([, a]) => Object.values(a.options).some((o) => o.styles?.[nodeId] === styles));
    const earlier = axes.slice(0, Math.max(0, at)).flatMap(([, a]) => Object.values(a.options).map((o) => o.styles?.[nodeId]));
    return { styles, tier: 1, weaker: present([design, ...earlier]), partId: null };
  });
  const isRoot = nodeId === def.tree?.rootIds[0];
  const overrides = Object.keys(n.overrides ?? {})
    .sort()
    .filter((pid) => (pid === 'root' ? isRoot : def.parts[pid]?.nodeId === nodeId));
  // The part a change writes is the one Layers and the inspector name, even before it holds anything.
  const own = isRoot ? 'root' : partOf(def, nodeId);
  if (own && !overrides.includes(own)) overrides.push(own);
  return [
    { styles: design, tier: 0, partId: null },
    ...options,
    ...overrides.map((pid) => ({ styles: n.overrides?.[pid], tier: 2, weaker: present([design, ...chosen]), partId: pid }))
  ];
}

/**
 * The styles that decide whether a layer shows: a primitive's own; for a placed component, its design's root
 * as the placement shows it ("root" being what Layers' eye and the inspector write); for a part of a placement
 * (`partId`), the same for that part.
 */
function visibilityStyles(state: ProjectState, n: GraphNode, partId?: string): Layer[] {
  // A repeat or a slot renders no element of its own, so nothing on it hides anything.
  if (n.kind === 'repeat' || n.kind === 'slot') return [];
  if (n.kind !== 'instance') return partId ? [] : [{ styles: n.styles, tier: 0 }];
  const def = defOf(state, n);
  const pid = partId ?? 'root';
  const declared = !!def && Object.hasOwn(def.parts, pid);
  const nodeId = declared ? def!.parts[pid].nodeId : pid === 'root' ? def?.tree?.rootIds[0] : undefined;
  if (def && nodeId) return placedStyles(def, n, nodeId);
  return def && (pid === 'root' || declared) ? [{ styles: n.overrides?.[pid], tier: 2, partId: pid }] : [];
}

/** A display the generated CSS gives the layer at one size: `none`, or one that shows it. */
type Decl = { tier: number; media: boolean; order: number; shown: boolean; by: 'base' | 'size' };

/**
 * The displays a rule's other values write, in the order the rule writes them (an arrangement, then custom
 * CSS; its own `hidden` comes after both): true for one that shows the layer, false for `display: none`.
 */
function otherDisplays(props: ResponsiveStyles['base']): boolean[] {
  const out: boolean[] = [];
  if (props?.layout !== undefined) out.push(true);
  if (typeof props?.customCss === 'string') for (const m of props.customCss.matchAll(/(?:^|[;\s{])display\s*:\s*([^;!}]+)/gi)) out.push(m[1].trim().toLowerCase() !== 'none');
  return out;
}

/**
 * The display rules the generator writes for these records at one size (see addRules, resolveVisibility and
 * unhider in the generator): a rule's own `hidden` comes after its other values; an every-size hide moves into
 * each size's block when some size shows the layer; a `hidden: false` from an option or override writes a
 * display only where something weaker hides the layer.
 */
function displaysAt(layers: Layer[], size: Size): Decl[] {
  const out: Decl[] = [];
  let order = 0;
  const add = (l: Layer, media: boolean, shown: boolean, by: Decl['by']) => out.push({ tier: l.tier, media, order: order++, shown, by });
  for (const l of layers) {
    const input = l.styles;
    if (!input) continue;
    const weakerHides = !!l.weaker?.some((w) => w.base?.hidden === true || w[size]?.hidden === true);
    const split = SIZES.some((z) => input[z]?.hidden === false);
    for (const shown of otherDisplays(input.base)) add(l, false, shown, 'base');
    if (input.base?.hidden === true && !split) add(l, false, false, 'base');
    if (input.base?.hidden === false && input[size]?.hidden === undefined && weakerHides) add(l, true, true, 'base');
    if (input[size]?.hidden === false && weakerHides) add(l, true, true, 'size');
    for (const shown of otherDisplays(input[size])) add(l, true, shown, 'size');
    if (input[size]?.hidden === true) add(l, true, false, 'size');
    else if (split && input.base?.hidden === true && input[size]?.hidden !== false) add(l, true, false, 'base');
  }
  return out;
}

/** Whether the layer is hidden at one size: the winning display rule is the stronger tier, then the one in the
 *  size's media block, then the later one. */
function decide(layers: Layer[], size: Size): Decl | null {
  let best: Decl | null = null;
  for (const d of displaysAt(layers, size)) {
    if (!best || d.tier > best.tier || (d.tier === best.tier && (d.media > best.media || (d.media === best.media && d.order > best.order)))) best = d;
  }
  return best;
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
    if (d && !d.shown) (out.hiddenAt.push(size), (out.by[size] = d.by));
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

/**
 * Edits that make the layer hidden or shown at the given sizes, leaving any other size as it was. The smallest
 * change is tried first: settings that work against the goal are taken away (on every record a change can
 * write), then the every-size setting, then a setting of its own for each size that still disagrees, on the
 * record the inspector names first and then on the others. Empty when it is already that way, or when nothing
 * a change can write gets it there.
 */
function plan(state: ProjectState, n: GraphNode, partId: string | undefined, sizes: Size[], hide: boolean, everySize: boolean): VisibilityEdit[] {
  const writable = visibilityStyles(state, n, partId).filter((l) => l.partId !== null);
  // The record a new setting goes in first: the one Layers and the inspector name ("root" for a placement).
  const main = writable.find((l) => l.partId === (partId ?? (n.kind === 'instance' ? 'root' : undefined))) ?? writable[0];
  if (!main) return [];
  const before = ownVisibility(state, n, partId).hiddenAt;
  const after = (edits: VisibilityEdit[]) => ownVisibility(state, withEdits(n, edits), partId).hiddenAt;
  const reaches = (edits: VisibilityEdit[]) => {
    const v = after(edits);
    return SIZES.every((z) => v.includes(z) === (sizes.includes(z) ? hide : before.includes(z)));
  };
  if (reaches([])) return [];
  type Set = (l: Layer, scope: 'base' | Size, value: boolean | null) => void;
  const build = (...steps: Array<(set: Set, edits: VisibilityEdit[]) => void>) => {
    const edits: VisibilityEdit[] = [];
    const set: Set = (l, scope, value) => {
      const at = edits.findIndex((e) => e.scope === scope && e.partId === l.partId);
      if (at >= 0) edits.splice(at, 1);
      if ((l.styles?.[scope]?.hidden ?? null) !== value) edits.push({ ...(l.partId ? { partId: l.partId } : {}), scope, value });
    };
    for (const step of steps) step(set, edits);
    return edits;
  };
  const clearContrary = (set: Set) => {
    for (const l of writable) {
      for (const z of sizes) if (l.styles?.[z]?.hidden === !hide) set(l, z, null);
      if (everySize && l.styles?.base?.hidden === !hide) set(l, 'base', null);
    }
    if (everySize && hide) set(main, 'base', true);
  };
  // Something no change can write hides it everywhere (the component's design): the placement shows it.
  const showAll = (set: Set) => everySize && !hide && set(main, 'base', false);
  const ownSizes = (l: Layer) => (set: Set, edits: VisibilityEdit[]) => {
    const now = after(edits);
    for (const z of sizes) if (now.includes(z) !== hide) set(l, z, hide);
  };
  const order = [main, ...writable.filter((l) => l !== main).reverse()];
  const candidates = [
    () => build(clearContrary),
    () => build(clearContrary, showAll),
    ...order.map((l) => () => build(clearContrary, showAll, ownSizes(l))),
    // For one size, a setting of its own may be all it takes, where taking others away would move other sizes.
    ...(everySize ? [] : order.map((l) => () => build(ownSizes(l))))
  ];
  for (const candidate of candidates) {
    const edits = candidate();
    if (edits.length && reaches(edits)) return edits;
  }
  return [];
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
  /** What hides it ("Grid", "Section › Container", "Services grid › Icon badge"). */
  name: string;
  /** What selecting it picks: the same layer, or for a wrapper of the design that is not a part (which only the
   *  component's own editing reaches), the placement. */
  target: string;
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
    const v = visibilityOf(placedStyles(def, n, q.parentId));
    if (v.hiddenAt.includes(size)) {
      const placement = layerLabel(state, n).label;
      const name = `${placement} › ${pid ? def.parts[pid].label : layerLabel(state, node, def).label}`;
      return { id: n.id, ...(pid ? { part: { id: pid, nodeId: q.parentId } } : {}), name, target: pid ? name : placement, sizes: v.hiddenAt };
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
    if (v.hiddenAt.includes(size)) {
      const name = layerLabel(state, up).label;
      return { id: up.id, name, target: name, sizes: v.hiddenAt };
    }
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
        (placement.hiddenAt.includes(size) ? { id: n.id, name: layerLabel(state, n).label, target: layerLabel(state, n).label, sizes: placement.hiddenAt } : hiddenAncestor(state, tree, n.id, size));
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
