import type { BackgroundImageValue, ImageUseTarget, ImageValue, OwnerRef, ProjectState, ValuePlace } from '@shared/types';
import { allTrees } from './tree';
import { orderedEntries } from '@shared/collections';

/**
 * A use in a collection entry: its featured image, the image it is shared with, or the `n`th picture in its text
 * (counted from 1, as the Posts writer shows them).
 */
export interface EntryImagePlace {
  collectionId: string;
  /** Empty for a collection's own default of a picture field, which no one entry holds. */
  entryId: string;
  title: string;
  field: 'featured' | 'sharing' | 'body' | 'value' | 'default';
  n?: number;
  /** A picture field's label (`value`, `default`). */
  label?: string;
}

/**
 * One use of a library image: an image value (`value`, at `place`), a setting that names the image by ID (a page's
 * sharing image, the site's tab icon or sharing image), or a use in a collection entry (`entry`). `target` names it
 * for a replacement in some places; a value reached through a list item with no ID, or one whose ID another item of
 * its list shares, has none, and changes only with every other use, as an entry's uses do.
 */
export type ImageUse = { target: ImageUseTarget | null; entry?: EntryImagePlace; background?: true } & ({ place: ValuePlace; value: ImageValue } | { place?: undefined; value?: undefined });

/**
 * Whether a path from an element reaches a style rule's background image (`styles.base.backgroundImage`, a part's
 * `overrides.card.phone.backgroundImage`, one item's `itemOverrides.card.items.i1.base.backgroundImage`), rather than
 * an image the element shows as content (a property that happens to be called backgroundImage, say).
 */
export function isBackgroundPath(path: ReadonlyArray<string | number>): boolean {
  const last = path.length - 1;
  if (path[last] !== 'backgroundImage') return false;
  if (path[0] === 'styles') return last === 2;
  if (path[0] === 'overrides') return last === 3;
  if (path[0] === 'itemOverrides') return last === 5 && path[2] === 'items';
  // A variant option's rules (see imageUses): ['variant', axis, option, scope, 'backgroundImage'].
  return path[0] === 'variant' && last === 4;
}

/** Names a use in any revision of the project: the same place gives the same key, whatever its label or row number. */
export function useKey(t: ImageUseTarget): string {
  switch (t.kind) {
    case 'node':
      return JSON.stringify(['node', t.owner.kind, t.owner.id, t.nodeId, t.path]);
    case 'default':
      return JSON.stringify(['default', t.definitionId, t.path]);
    case 'pageSharing':
      return JSON.stringify(['pageSharing', t.pageId]);
    case 'site':
      return JSON.stringify(['site', t.field]);
  }
}

/** The target for an image value's place, or null when its path steps through a list item by position. */
function targetOf(place: ValuePlace): ImageUseTarget | null {
  if (!place.path.every((s): s is string => typeof s === 'string' && s !== '')) return null;
  const path = place.path as string[];
  return 'definitionId' in place ? { kind: 'default', definitionId: place.definitionId, path } : { kind: 'node', owner: place.owner, nodeId: place.nodeId, path };
}

/**
 * Every use of a library image, in the order a replacement changes them: the image values in the site's trees (pages,
 * shared header and footer, component designs), then in components' starting values, then each page's sharing image
 * and the site's own. The values are the project's own objects, so a replacement changes them in place.
 */
export function imageUses(state: ProjectState, assetId: string): ImageUse[] {
  const out: ImageUse[] = [];
  const idOf = (x: unknown) => (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? (x as { id: string }).id : undefined);
  const walk = (v: unknown, at: { owner: OwnerRef; nodeId: string } | { definitionId: string }, path: Array<string | number>) => {
    if (Array.isArray(v)) {
      // A list item is reached by its ID only when no other item of the list has it; otherwise by position, so it
      // is never mistaken for the other one.
      const ids = v.map(idOf);
      const seen = new Map<string, number>();
      for (const id of ids) if (id !== undefined) seen.set(id, (seen.get(id) ?? 0) + 1);
      v.forEach((x, i) => {
        const id = ids[i];
        walk(x, at, [...path, id && seen.get(id) === 1 ? id : i]);
      });
    } else if (v && typeof v === 'object') {
      if ((v as { assetId?: unknown }).assetId === assetId) {
        const place: ValuePlace = { ...at, path };
        out.push({ place, value: v as ImageValue, target: targetOf(place), ...(isBackgroundPath(path) ? { background: true as const } : {}) });
      }
      for (const [k, x] of Object.entries(v)) walk(x, at, [...path, k]);
    }
  };
  for (const t of allTrees(state)) for (const n of Object.values(t.tree.nodes)) walk(n, { owner: t.owner, nodeId: n.id }, []);
  for (const d of Object.values(state.components)) for (const [prop, schema] of Object.entries(d.properties)) walk(schema, { definitionId: d.id }, [prop]);
  // A design's variant options hold background images for its elements (only those: a variant styles, never fills in
  // content). Each is placed at its element, but has no target: one changes only with every other use.
  for (const u of variantBackgrounds(state, assetId)) out.push({ place: { owner: { kind: 'component', id: u.definitionId }, nodeId: u.nodeId, path: ['variant', u.axis, u.option, u.scope, 'backgroundImage'] }, value: u.value as unknown as ImageValue, target: null, background: true });
  for (const pg of Object.values(state.pages)) if (pg.seo.socialImage === assetId) out.push({ target: { kind: 'pageSharing', pageId: pg.id } });
  if (state.site.favicon === assetId) out.push({ target: { kind: 'site', field: 'favicon' } });
  if (state.site.socialImage === assetId) out.push({ target: { kind: 'site', field: 'socialImage' } });
  if (state.site.identity?.logo === assetId) out.push({ target: { kind: 'site', field: 'logo' } });
  out.push(...entryImageUses(state, assetId));
  return out;
}

/** One background image a design's variant option sets on one of its elements. */
export interface VariantBackground {
  definitionId: string;
  axis: string;
  option: string;
  nodeId: string;
  scope: string;
  value: BackgroundImageValue;
}

/**
 * The background images designs' variant options set (every option, chosen by a placement or not), each for an
 * element the design still has; `assetId` keeps only those showing that image.
 */
export function variantBackgrounds(state: ProjectState, assetId?: string): VariantBackground[] {
  const out: VariantBackground[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const d of Object.values(state.components)) {
    if (!obj(d?.variantAxes)) continue;
    for (const [axis, a] of Object.entries(d.variantAxes))
      for (const [option, o] of Object.entries(obj(a?.options) ? a.options : {}))
        for (const [nodeId, rules] of Object.entries(obj(o?.styles) ? o.styles : {}))
          for (const [scope, props] of Object.entries(obj(rules) ? rules : {})) {
            const value: unknown = obj(props) ? props.backgroundImage : undefined;
            if (obj(value) && typeof value.assetId === 'string' && (assetId === undefined || value.assetId === assetId)) out.push({ definitionId: d.id, axis, option, nodeId, scope, value: value as BackgroundImageValue });
          }
  }
  return out;
}

/**
 * The uses of a library image in collection entries, drafts included: each entry's featured image, the image it is
 * shared with and the pictures in its text, in the collections' and entries' own order. They are changed only with
 * every other use.
 */
export function entryImageUses(state: ProjectState, assetId: string): ImageUse[] {
  const out: ImageUse[] = [];
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const c = state.collections[id];
    if (!c?.entries || typeof c.entries !== 'object') continue;
    // Picture fields: each one's default, and each entry's own value below, change with every other use too.
    const pictures = Object.entries(c.settings?.fields ?? {}).filter(([, f]) => f?.type === 'image');
    for (const [, f] of pictures) if ((f.default as { assetId?: unknown } | undefined)?.assetId === assetId) out.push({ target: null, entry: { collectionId: id, entryId: '', title: c.settings.name, field: 'default', label: f.label } });
    for (const e of orderedEntries(c)) {
      if (!e || typeof e !== 'object') continue;
      const at = { collectionId: id, entryId: e.id, title: typeof e.title === 'string' ? e.title : e.id };
      if (e.featuredImage === assetId) out.push({ target: null, entry: { ...at, field: 'featured' } });
      if (e.seo && typeof e.seo === 'object' && e.seo.socialImage === assetId) out.push({ target: null, entry: { ...at, field: 'sharing' } });
      for (const [name, f] of pictures) if ((e.values?.[name] as { assetId?: unknown } | undefined)?.assetId === assetId) out.push({ target: null, entry: { ...at, field: 'value', label: f.label } });
      let n = 0;
      for (const b of Array.isArray(e.body) ? e.body : []) {
        if (!b || typeof b !== 'object' || b.type !== 'image') continue;
        n++;
        if (b.assetId === assetId) out.push({ target: null, entry: { ...at, field: 'body', n } });
      }
    }
  }
  return out;
}

/**
 * The uses `targets` name, each matched to exactly one use the image has now. A target named twice, or one that no
 * longer shows the image (removed, given another image, or a list item whose ID is no longer unique), is an error:
 * nothing is chosen for it, and the caller replaces nothing.
 */
export function chosenUses(uses: readonly ImageUse[], targets: readonly ImageUseTarget[]): { uses: ImageUse[] } | { error: string } {
  const byKey = new Map<string, ImageUse[]>();
  for (const u of uses) if (u.target) byKey.set(useKey(u.target), [...(byKey.get(useKey(u.target)) ?? []), u]);
  const chosen = new Set<ImageUse>();
  for (const t of targets) {
    const found = byKey.get(useKey(t)) ?? [];
    if (found.length !== 1) return { error: 'One of the chosen places no longer shows the image.' };
    if (chosen.has(found[0])) return { error: 'The same place is named twice.' };
    chosen.add(found[0]);
  }
  // In the order of the uses, whatever order they were named in.
  return { uses: uses.filter((u) => chosen.has(u)) };
}
