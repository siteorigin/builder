import type { AltReview, ProjectState, ValuePlace } from '@shared/types';
import { allTrees } from './tree';

/** The value a path leads to: through objects by key, and through lists by item ID, or by position (see ValuePlace). */
export function valueAt(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let v = root;
  for (const step of path) {
    if (Array.isArray(v)) v = typeof step === 'number' ? v[step] : v.find((x) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === step);
    else if (v && typeof v === 'object' && typeof step === 'string' && Object.hasOwn(v, step)) v = (v as Record<string, unknown>)[step];
    else return undefined;
  }
  return v;
}

/** The element or component property a place starts from, as the project holds it now. */
export function placeRoot(state: ProjectState, place: ValuePlace): unknown {
  if ('definitionId' in place) return Object.hasOwn(state.components, place.definitionId) ? state.components[place.definitionId].properties : undefined;
  const t = allTrees(state).find((x) => x.owner.kind === place.owner.kind && x.owner.id === place.owner.id);
  return t && Object.hasOwn(t.tree.nodes, place.nodeId) ? t.tree.nodes[place.nodeId] : undefined;
}

/**
 * The uses a replacement with `withId` left to check that still need it: each still shows that image, is not
 * decorative, and still has the alt text the replacement left it. One removed, given another image or edited since
 * drops out.
 */
export function altStillToCheck(state: ProjectState, withId: string, review: readonly AltReview[]): AltReview[] {
  return review.filter((r) => {
    const v = valueAt(placeRoot(state, r), r.path) as { assetId?: unknown; alt?: unknown; decorative?: unknown } | undefined;
    return !!v && typeof v === 'object' && v.assetId === withId && !v.decorative && (typeof v.alt === 'string' ? v.alt : '') === r.alt;
  });
}
