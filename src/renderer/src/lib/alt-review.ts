import { altStillToCheck } from '@engine/alt-review';
import { allTrees } from '@engine/tree';
import type { AltReview, OwnerRef, ProjectState } from '@shared/types';
import { describePlace, type UseField } from './asset-uses';

/** A use whose alt text an image replacement left for the author to check, as the Assets panel lists it. */
export interface AltCheck {
  key: string;
  reason: AltReview['reason'];
  /** The alt text it was left with. */
  alt: string;
  icon: 'page' | 'shell' | 'component';
  /** The page, shared part or component it is in. */
  where: string;
  /** The element, and the list row when it is in one. */
  what: string;
  /** The element to show it at (see PlaceLabel): in Component Studio for a project component's design. */
  at?: { owner: OwnerRef; nodeId: string };
  /** The field the inspector opens there (see UseField). */
  field?: UseField;
  /** The component whose design or starting value it is in, and for a starting value, its property. */
  definitionId?: string;
  prop?: string;
  part?: string;
}

/** The uses still to check after a replacement with `withId` (see altStillToCheck), named as the Assets panel lists them. */
export function altChecks(state: ProjectState, withId: string, review: readonly AltReview[]): AltCheck[] {
  const trees = new Map(allTrees(state).map((t) => [`${t.owner.kind}/${t.owner.id}`, t]));
  return altStillToCheck(state, withId, review).flatMap((r): AltCheck[] => {
    const label = describePlace(state, r, trees);
    return label ? [{ key: JSON.stringify(r), reason: r.reason, alt: r.alt, ...label }] : [];
  });
}
