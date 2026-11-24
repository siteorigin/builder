// The uses of a library image as the Assets panel lists them: one row for each place that shows it (each row of a
// gallery or team on its own), named as the inspector names it, with where Show goes and what a replacement in some
// places sends to name it. Plain functions, tested without a renderer.
import { imageUses, useKey } from '@engine/image-uses';
import { placeRoot } from '@engine/alt-review';
import { allTrees, displayName } from '@engine/tree';
import type { GraphNode, ImageUseTarget, OwnerRef, ProjectState, ValuePlace } from '@shared/types';

/** The field of a placed component an image is in, for the inspector to open: a property, or one field of a list row. */
export interface UseField {
  prop: string;
  itemId?: string;
  field?: string;
}

/** Where a value is, in words, and the element that shows it. */
export interface PlaceLabel {
  icon: 'page' | 'shell' | 'component';
  /** The page, shared part or component it is in. */
  where: string;
  /** The element, and the list row when it is in one ("Gallery · Image 2: Studio front"). */
  what: string;
  /** The element to show it at: none in a component's design or starting value, which no page shows as such. */
  at?: { owner: OwnerRef; nodeId: string };
  /** The field the inspector opens there, when the image is a placed component's property or a field of its list. */
  field?: UseField;
  /** The component whose design or starting value it is in: no page shows it as such. */
  definitionId?: string;
}

/** The row of a list property an image is in ("Image 3: Custom"): its position, and its title when it has one. */
function rowLabel(state: ProjectState, node: GraphNode, path: ReadonlyArray<string | number>): string | undefined {
  if (node.kind !== 'instance' || path[0] !== 'props' || typeof path[1] !== 'string' || path.length < 4) return undefined;
  const schema = state.components[node.definitionId]?.properties[path[1]];
  const items = node.props[path[1]] as unknown;
  if (schema?.type !== 'list' || !Array.isArray(items)) return undefined;
  const rows = items as Array<Record<string, unknown> | null | undefined>;
  const i = typeof path[2] === 'number' ? path[2] : rows.findIndex((x) => x?.id === path[2]);
  if (i < 0 || !rows[i]) return undefined;
  const field = schema.titleField ? rows[i]![schema.titleField] : undefined;
  const title = typeof field === 'string' ? field.trim() : '';
  return `${schema.itemLabel} ${i + 1}${title ? `: ${title}` : ''}`;
}

/**
 * The inspector field an image value is in: a placed component's property (`props.hero`), or one field of a row of
 * its list, by the row's ID (`props.images.g2.image`). Anything else (an image element's own picture, a value
 * deeper in, a row with no ID) has none, and Show selects the element.
 */
function fieldOf(node: GraphNode, path: ReadonlyArray<string | number>): UseField | undefined {
  if (node.kind !== 'instance' || path[0] !== 'props' || typeof path[1] !== 'string') return undefined;
  if (path.length === 2) return { prop: path[1] };
  if (path.length === 4 && typeof path[2] === 'string' && typeof path[3] === 'string') return { prop: path[1], itemId: path[2], field: path[3] };
  return undefined;
}

/** A value's place named as the Assets panel names it, or null when its element or component has gone. */
export function describePlace(state: ProjectState, place: ValuePlace, trees = new Map(allTrees(state).map((t) => [`${t.owner.kind}/${t.owner.id}`, t]))): PlaceLabel | null {
  if ('definitionId' in place) {
    const def = Object.hasOwn(state.components, place.definitionId) ? state.components[place.definitionId] : undefined;
    if (!def) return null;
    const label = typeof place.path[0] === 'string' ? def.properties[place.path[0]]?.label : undefined;
    return { icon: 'component', where: `${def.name} default`, what: label ? `${label}: starting image for new copies` : 'Starting image for new copies', definitionId: def.id };
  }
  const t = trees.get(`${place.owner.kind}/${place.owner.id}`);
  const node = placeRoot(state, place) as GraphNode | undefined;
  if (!t || !node) return null;
  const row = rowLabel(state, node, place.path);
  const what = row ? `${displayName(state, node)} · ${row}` : displayName(state, node);
  if (t.owner.kind === 'component') return { icon: 'component', where: `${t.label} design`, what, definitionId: t.owner.id };
  const field = fieldOf(node, place.path);
  const at = { owner: t.owner, nodeId: node.id };
  const shown = { what, at, ...(field ? { field } : {}) };
  return t.owner.kind === 'page' ? { icon: 'page', where: t.label, ...shown } : { icon: 'shell', where: `Shared ${t.label.toLowerCase()}`, ...shown };
}

/** One use of an image, as the Assets panel lists it and a replacement in some places chooses it. */
export interface ImageUseRow extends Omit<PlaceLabel, 'icon'> {
  icon: PlaceLabel['icon'] | 'site' | 'post';
  /** Tells the row apart from every other use of the image, and stays the same while the row is reordered or renamed. */
  key: string;
  /** What a replacement in some places names it by. None for a value reached through a list row with no ID. */
  target: ImageUseTarget | null;
  /** A page's sharing image opens that page; the site's own images open Site styles. */
  setting?: { pageId: string } | 'site';
  /** A collection entry's featured image or a picture in its text opens that entry in Posts. */
  post?: { collectionId: string; entryId: string; n?: number };
  /** The alt text it has, and whether it is decorative: an image value's own. */
  alt?: string;
  decorative?: boolean;
}

/** Every use of an image, one row each, in the order a replacement changes them. */
export function imageUseRows(state: ProjectState, assetId: string): ImageUseRow[] {
  const trees = new Map(allTrees(state).map((t) => [`${t.owner.kind}/${t.owner.id}`, t]));
  return imageUses(state, assetId).map((u, i): ImageUseRow => {
    const t = u.target;
    const key = t ? useKey(t) : `unnamed:${i}`;
    if (u.entry) {
      const e = u.entry;
      const key = JSON.stringify(['entry', e.collectionId, e.entryId, e.field, e.label ?? '', e.n ?? 0]);
      const what = e.field === 'featured' ? 'Featured image' : e.field === 'body' ? `Picture ${e.n} in the text` : e.field === 'default' ? `${e.label}: starting picture for new entries` : (e.label ?? 'Picture');
      // A collection's default is in no one entry: there is no post to open for it.
      if (e.field === 'default') return { key, target: null, icon: 'post', where: e.title, what };
      return { key, target: null, icon: 'post', where: e.title, what, post: { collectionId: e.collectionId, entryId: e.entryId, ...(e.n ? { n: e.n } : {}) } };
    }
    if (!u.place) {
      if (t?.kind === 'pageSharing') return { key, target: t, icon: 'page', where: state.pages[t.pageId].title, what: 'Sharing image', setting: { pageId: t.pageId } };
      return { key, target: t, icon: 'site', where: 'Site', what: t?.kind === 'site' && t.field === 'favicon' ? 'Browser tab icon' : 'Sharing image', setting: 'site' };
    }
    const label = describePlace(state, u.place, trees) ?? { icon: 'component' as const, where: 'Site', what: 'Image' };
    return { ...label, key, target: t, alt: typeof u.value.alt === 'string' ? u.value.alt : '', ...(u.value.decorative ? { decorative: true } : {}) };
  });
}
