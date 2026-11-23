/**
 * How Layers and the breadcrumb name a layer and describe its visibility. Pure functions over the project
 * state, so what a row says (to the eye and to a screen reader) can be tested without rendering it.
 */
import type { ComponentDefinition, GraphNode, NodeTree, ProjectState, ResponsiveStyles } from '@shared/types';
import { isBinding } from '@shared/types';
import { richTextToPlain } from '@shared/richtext';
import { displayName, findParent } from '@engine/tree';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export interface LayerLabel {
  /** What the row shows: the layer's own name, or its type and a short excerpt of its content. */
  label: string;
  /** The type ("Text", "Heading 2", "Button"), or the layer's own name when it has one. */
  kind: string;
  /** A short excerpt of the content, for an unnamed text or button; "empty" when it has none. */
  excerpt?: string;
  /** The layer has no content at all (an empty paragraph). */
  empty?: boolean;
  /** The whole description, for the accessible name and the tooltip: never cut short mid-word. */
  full: string;
}

/** The longest excerpt a row shows before the rest is left to its tooltip and accessible name. */
const EXCERPT_MAX = 40;
/** The most of the content the accessible name reads out. */
const FULL_MAX = 200;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Cut text at a word boundary near `max` characters, with an ellipsis when anything was left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/, '')}…`;
}

/** A node's own words: its text or a button's label, as one line; null when the content is bound or not words. */
export function contentText(n: GraphNode): string | null {
  if (n.kind === 'text') {
    if (isBinding(n.text)) return null;
    return squash(typeof n.text === 'string' ? n.text : Array.isArray(n.text) ? richTextToPlain(n.text) : '');
  }
  if (n.kind === 'link') return isBinding(n.label) ? null : squash(String(n.label ?? ''));
  return null;
}

/**
 * The name Layers and the breadcrumb give a layer. A name the author gave always wins, whatever the content
 * says later. Otherwise text and buttons are told apart by their words ("Text · Meet the makers…"), and an
 * empty one says so.
 */
export function layerLabel(state: ProjectState, n: GraphNode, def?: ComponentDefinition): LayerLabel {
  const kind = displayName(state, n, def);
  if (n.name) return { label: kind, kind, full: kind };
  const words = contentText(n);
  if (words === null) return { label: kind, kind, full: kind };
  if (!words) return { label: `${kind} · empty`, kind, excerpt: 'empty', empty: true, full: `${kind}, empty` };
  const excerpt = clip(words, EXCERPT_MAX);
  return { label: `${kind} · ${excerpt}`, kind, excerpt, full: `${kind}: ${clip(words, FULL_MAX)}` };
}

// ---------------------------------------------------------------------------
// Visibility at each screen size
// ---------------------------------------------------------------------------

export type Size = 'phone' | 'tablet' | 'desktop';
export const SIZES: Size[] = ['phone', 'tablet', 'desktop'];
export const SIZE_NAME: Record<Size, string> = { phone: 'phone', tablet: 'tablet', desktop: 'desktop' };

/** The screen size a preview width shows (the ranges the generated media queries use). */
export const sizeForWidth = (w: number): Size => (w < 768 ? 'phone' : w < 1024 ? 'tablet' : 'desktop');

/**
 * The styles that decide whether a layer shows, weakest first: its own, and for a placed component the
 * overrides of its root (what Layers' eye and the inspector write). `partId` names the override a reset
 * writes; null means the node's own styles, which a component's placement does not edit.
 */
function visibilityStyles(n: GraphNode, partId?: string): Array<{ styles?: ResponsiveStyles; partId?: string | null }> {
  if (partId) return n.kind === 'instance' ? [{ styles: n.overrides?.[partId], partId }] : [];
  if (n.kind !== 'instance') return [{ styles: n.styles }];
  return [{ styles: n.styles, partId: null }, { styles: n.overrides?.root, partId: 'root' }];
}

/** What decides a layer's visibility at one size: a value set for that size wins over one set for every size. */
function decided(styles: ResponsiveStyles | undefined, size: Size): { hidden: boolean; scope: 'base' | Size } | null {
  const own = styles?.[size]?.hidden;
  if (typeof own === 'boolean') return { hidden: own, scope: size };
  const all = styles?.base?.hidden;
  if (typeof all === 'boolean') return { hidden: all, scope: 'base' };
  return null;
}

export interface OwnVisibility {
  /** The sizes the layer hides itself at, in size order. */
  hiddenAt: Size[];
  /** Hidden at every size by its every-size setting: a site-wide hide (the eye's own state). */
  everywhere: boolean;
  /** Where each hidden size's hide comes from: the every-size setting, or that size's own. */
  by: Partial<Record<Size, 'base' | 'size'>>;
}

/** A layer's own visibility at each size (a part of a placed component with `partId`). */
export function ownVisibility(n: GraphNode, partId?: string): OwnVisibility {
  const layers = visibilityStyles(n, partId);
  const out: OwnVisibility = { hiddenAt: [], everywhere: false, by: {} };
  for (const size of SIZES) {
    // The strongest layer that says anything decides.
    let d: ReturnType<typeof decided> = null;
    for (const l of layers) d = decided(l.styles, size) ?? d;
    if (d?.hidden) (out.hiddenAt.push(size), (out.by[size] = d.scope === 'base' ? 'base' : 'size'));
  }
  out.everywhere = layers.some((l) => l.styles?.base?.hidden === true);
  return out;
}

/**
 * The style edit that shows a layer again at one size only, leaving every other size as it is: a hide set for
 * just that size is taken away, and a hide set for every size is answered by that size showing it.
 */
export function showHereOp(n: GraphNode, size: Size, partId?: string): { partId?: string; scope: Size; value: false | null } | null {
  const layers = visibilityStyles(n, partId);
  const edit = [...layers].reverse().find((l) => l.partId !== null);
  if (!edit || !ownVisibility(n, partId).hiddenAt.includes(size)) return null;
  const everySize = layers.some((l) => l.styles?.base?.hidden === true);
  const onlyHere = edit.styles?.[size]?.hidden === true && !everySize;
  return { ...(edit.partId ? { partId: edit.partId } : {}), scope: size, value: onlyHere ? null : false };
}

/** The nearest container above a node, in its own tree, that hides itself at this size (so the node too). */
export function hiddenAncestor(tree: NodeTree, nodeId: string, size: Size): GraphNode | null {
  const seen = new Set<string>([nodeId]);
  for (let p = findParent(tree, nodeId); p?.parentId && !seen.has(p.parentId); p = findParent(tree, p.parentId)) {
    seen.add(p.parentId);
    const up = tree.nodes[p.parentId];
    if (up && ownVisibility(up).hiddenAt.includes(size)) return up;
  }
  return null;
}

const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "on phone", "on phone and tablet", or "at every size". */
export function sizesText(sizes: Size[]): string {
  return sizes.length === SIZES.length ? 'at every size' : `on ${listJoin(sizes.map((s) => SIZE_NAME[s]))}`;
}

export interface RowVisibility {
  own: OwnVisibility;
  /** Hidden in the preview being shown, by itself or by a container above it. */
  hiddenHere: boolean;
  /** The container that hides it in this preview, when it does not hide itself here. */
  hiddenBy: { id: string; name: string; sizes: Size[] } | null;
  /** What a screen reader hears after the name, and what the tooltip says (empty when it shows everywhere). */
  note: string;
}

/** A Layers row's visibility while the preview shows `size`. */
export function rowVisibility(state: ProjectState, tree: NodeTree, n: GraphNode, size: Size, partId?: string): RowVisibility {
  const own = ownVisibility(n, partId);
  const selfHere = own.hiddenAt.includes(size);
  // A part sits inside its placement: the placement's own hide is its container's.
  const up = partId ? (ownVisibility(n).hiddenAt.includes(size) ? n : hiddenAncestor(tree, n.id, size)) : selfHere ? null : hiddenAncestor(tree, n.id, size);
  const hiddenBy = !selfHere && up ? { id: up.id, name: layerLabel(state, up).label, sizes: ownVisibility(up).hiddenAt } : null;
  const notes: string[] = [];
  if (own.hiddenAt.length) notes.push(`hidden ${sizesText(own.hiddenAt)}`);
  if (hiddenBy) notes.push(`hidden ${sizesText([size])} because ${hiddenBy.name} is hidden ${sizesText(hiddenBy.sizes)}`);
  return { own, hiddenHere: selfHere || !!hiddenBy, hiddenBy, note: notes.join('; ') };
}
