import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { pageLinkUses, type PageLinkUse } from '@engine/page-links';
import { elementIds, pageIds, planSectionPick } from '@generator/checks';
import { SECTION_NODE } from './sections';

/** A section of the deleted page that links jump to and the replacement page does not have. */
export interface MissingSection {
  fragment: string;
  /** The links that jump to it, as listed in the review. */
  uses: PageLinkUse[];
}

export interface PageRemovalReview {
  /** Every link from the rest of the site that moves to the replacement page. */
  uses: PageLinkUse[];
  /** Cards for the page in page lists: they are removed from their lists with the page. */
  cards: PageLinkUse[];
  /** Sections those links jump to that the replacement page lacks: each needs a section there, or the top. */
  missing: MissingSection[];
}

/**
 * What deleting a page with `replacementId` changes: the links that move to the replacement page, the page lists'
 * cards that go with the page, and the sections those links jump to that the replacement has no ID for. Sections it
 * does have are kept without asking.
 */
export function reviewPageRemoval(state: ProjectState, pageId: string, replacementId: string | undefined): PageRemovalReview {
  const all = pageLinkUses(state, pageId);
  const uses = all.filter((u) => !u.card);
  const cards = all.filter((u) => u.card);
  const ids = replacementId && Object.hasOwn(state.pages, replacementId) ? pageIds(state, replacementId) : new Set<string>();
  const missing = new Map<string, PageLinkUse[]>();
  for (const u of uses) if (u.link.anchor && !ids.has(u.link.anchor)) missing.set(u.link.anchor, [...(missing.get(u.link.anchor) ?? []), u]);
  return { uses, cards, missing: [...missing].map(([fragment, list]) => ({ fragment, uses: list })) };
}

export interface PageRemovalPlan {
  /** The edits to send as one batch, or null while the dialog cannot delete yet. */
  operations: EditOperation[] | null;
  /** IDs the replacement page has now that the chosen sections' new IDs would take away. */
  lost: string[];
}

/**
 * The edits that delete a page as the dialog was filled in: `choices` maps each missing section to `''` (the top of
 * the replacement page), `#id` (a section with that ID) or `node:<id>` (a section given an ID from its heading in the
 * same batch, so the deletion and the new ID undo together). No edits while a missing section has no choice, a
 * choice no longer fits the page, or new IDs would take an ID away from the page that links may still use.
 */
export function planPageRemoval(state: ProjectState, pageId: string, replacementId: string | undefined, choices: ReadonlyMap<string, string>): PageRemovalPlan {
  const none: PageRemovalPlan = { operations: null, lost: [] };
  const review = reviewPageRemoval(state, pageId, replacementId);
  if (!review.uses.length && pageId !== state.site.homePageId) return { operations: [{ type: 'page.remove', pageId }], lost: [] };
  if (!replacementId || !Object.hasOwn(state.pages, replacementId) || replacementId === pageId) return none;
  const ids = pageIds(state, replacementId);
  const operations: EditOperation[] = [];
  const sectionReplacements: Array<{ from: string; to: string }> = [];
  // IDs given out in this batch, so two sections with the same heading get different ones.
  const given = new Map<string, string>();
  for (const { fragment } of review.missing) {
    const choice = choices.get(fragment);
    if (choice === undefined) return none;
    let to = '';
    if (choice.startsWith('#')) {
      to = choice.slice(1);
      if (!ids.has(to)) return none;
    } else if (choice.startsWith(SECTION_NODE)) {
      const nodeId = choice.slice(SECTION_NODE.length);
      if (!given.has(nodeId)) {
        // A new ID never takes another missing section's name, which still means a different place.
        const reserved = [...given.values(), ...review.missing.map((m) => m.fragment).filter((f) => f !== fragment)];
        const plan = planSectionPick(state, replacementId, nodeId, reserved);
        if (!plan) return none;
        operations.push(...plan.operations);
        given.set(nodeId, plan.anchor);
      }
      to = given.get(nodeId)!;
    } else if (choice) return none;
    sectionReplacements.push({ from: fragment, to });
  }
  // A section can render an ID it shares with another (both inherit it from their component). Giving every one of
  // them a new ID would take that ID off the page, from links that still jump to it.
  if (operations.length) {
    let after: ProjectState;
    try {
      after = applyOperations(state, operations).state;
    } catch {
      return none;
    }
    // Elements' own IDs: the layout's fallbacks (`top`) would hide one an element stops rendering.
    const kept = elementIds(after, replacementId);
    const lost = [...elementIds(state, replacementId)].filter((id) => !kept.has(id));
    if (lost.length) return { operations: null, lost };
  }
  operations.push({ type: 'page.remove', pageId, replacementPageId: replacementId, ...(sectionReplacements.length ? { sectionReplacements } : {}) });
  return { operations, lost: [] };
}
