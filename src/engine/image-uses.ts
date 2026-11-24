import type { ImageUseTarget, ImageValue, OwnerRef, ProjectState, ValuePlace } from '@shared/types';
import { allTrees } from './tree';

/**
 * One use of a library image: an image value (`value`, at `place`), or a setting that names the image by ID (a page's
 * sharing image, the site's tab icon or sharing image). `target` names it for a replacement in some places; a value
 * reached through a list item with no ID, or one whose ID another item of its list shares, has none, and changes only
 * with every other use.
 */
export type ImageUse = { target: ImageUseTarget | null } & ({ place: ValuePlace; value: ImageValue } | { place?: undefined; value?: undefined });

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
  if (!place.path.every((s): s is string => typeof s === 'string')) return null;
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
      v.forEach((x, i) => {
        const id = ids[i];
        walk(x, at, [...path, id !== undefined && ids.indexOf(id) === ids.lastIndexOf(id) ? id : i]);
      });
    } else if (v && typeof v === 'object') {
      if ((v as { assetId?: unknown }).assetId === assetId) {
        const place: ValuePlace = { ...at, path };
        out.push({ place, value: v as ImageValue, target: targetOf(place) });
      }
      for (const [k, x] of Object.entries(v)) walk(x, at, [...path, k]);
    }
  };
  for (const t of allTrees(state)) for (const n of Object.values(t.tree.nodes)) walk(n, { owner: t.owner, nodeId: n.id }, []);
  for (const d of Object.values(state.components)) for (const [prop, schema] of Object.entries(d.properties)) walk(schema, { definitionId: d.id }, [prop]);
  for (const pg of Object.values(state.pages)) if (pg.seo.socialImage === assetId) out.push({ target: { kind: 'pageSharing', pageId: pg.id } });
  if (state.site.favicon === assetId) out.push({ target: { kind: 'site', field: 'favicon' } });
  if (state.site.socialImage === assetId) out.push({ target: { kind: 'site', field: 'socialImage' } });
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
