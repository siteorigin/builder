import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { pageLinkUses, type PageLinkUse } from '@engine/page-links';
import { dropHeaderLinks, followsPageOrder } from '@engine/header-order';
import { elementIds, pageIds, planSectionPick } from '@generator/checks';
import { SECTION_NODE } from './sections';

/**
 * The choice to leave a new blank Home page in place of the Home page being deleted, instead of a replacement page.
 * A value of its own, so no page ID (or a replacement that has gone) is ever read as this choice.
 */
export const NEW_HOME: unique symbol = Symbol('new blank Home');

/** What takes a deleted page's links: a page, a new blank Home (Home only), or nothing chosen yet. */
export type PageReplacement = string | typeof NEW_HOME | undefined;

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
  /** The header menu's links to the page, by label, taken out of a menu that follows the pages rather than moved. */
  menu: string[];
  /** Sections those links jump to that the replacement page lacks: each needs a section there, or the top. */
  missing: MissingSection[];
}

/**
 * What deleting a page with `replacementId` changes: the links that move to the replacement page, the page lists'
 * cards that go with the page, and the sections those links jump to that the replacement has no ID for. Sections it
 * does have are kept without asking.
 */
export function reviewPageRemoval(state: ProjectState, pageId: string, replacementId: PageReplacement): PageRemovalReview {
  // A new blank Home has no sections: every link, the header menu's too, opens its top, with nothing to choose.
  if (replacementId === NEW_HOME) {
    const all = pageLinkUses(state, pageId);
    return { uses: all.filter((u) => !u.card), cards: all.filter((u) => u.card), menu: [], missing: [] };
  }
  // A header menu that follows the pages lets go of its links to the page first, as the engine does: they need no replacement.
  const { view: base, menu } = withoutMenuLinks(state, pageId);
  const all = pageLinkUses(base, pageId);
  const uses = all.filter((u) => !u.card);
  const cards = all.filter((u) => u.card);
  const view = cards.length ? withoutCards(base, pageId) : base;
  const ids = replacementId && Object.hasOwn(view.pages, replacementId) ? pageIds(view, replacementId) : new Set<string>();
  const missing = new Map<string, PageLinkUse[]>();
  for (const u of uses) if (u.link.anchor && !ids.has(u.link.anchor)) missing.set(u.link.anchor, [...(missing.get(u.link.anchor) ?? []), u]);
  return { uses, cards, menu, missing: [...missing].map(([fragment, list]) => ({ fragment, uses: list })) };
}

/** The project once a header menu that follows the pages has let go of its links to the page, and their labels. */
function withoutMenuLinks(state: ProjectState, pageId: string): { view: ProjectState; menu: string[] } {
  if (!followsPageOrder(state)) return { view: state, menu: [] };
  const view = structuredClone(state);
  const menu = dropHeaderLinks(view, pageId);
  return menu.length ? { view, menu } : { view: state, menu: [] };
}

/**
 * The project once the page's cards have left their page lists, which is when the engine looks at the replacement
 * page's sections: one that only those cards kept showing is not there for the links.
 */
export function withoutCards(state: ProjectState, pageId: string): ProjectState {
  if (!pageLinkUses(state, pageId).some((u) => u.card)) return state;
  const view = structuredClone(state);
  for (const { card } of pageLinkUses(view, pageId)) {
    const at = card ? card.items.indexOf(card.item) : -1;
    if (at >= 0) card!.items.splice(at, 1);
  }
  return view;
}

export interface PageRemovalPlan {
  /** The edits to send as one batch, or null while the dialog cannot delete yet. */
  operations: EditOperation[] | null;
  /** IDs the replacement page has now that the chosen sections' new IDs would take away. */
  lost: string[];
}

/**
 * The edits that delete a page as the dialog was filled in, with `replacementId` a page or, for Home, NEW_HOME: `choices` maps each missing section to `''` (the top of
 * the replacement page), `#id` (a section with that ID) or `node:<id>` (a section given an ID from its heading in the
 * same batch, so the deletion and the new ID undo together). No edits while a missing section has no choice, a
 * choice no longer fits the page, or new IDs would take an ID away from the page that links may still use.
 */
export function planPageRemoval(state: ProjectState, pageId: string, replacementId: PageReplacement, choices: ReadonlyMap<string, string>): PageRemovalPlan {
  const none: PageRemovalPlan = { operations: null, lost: [] };
  // Only Home leaves a new blank Home behind, and it takes every link and kept address with nothing to choose.
  if (replacementId === NEW_HOME) return pageId === state.site.homePageId && Object.hasOwn(state.pages, pageId) ? { operations: [{ type: 'page.remove', pageId, newHome: true }], lost: [] } : none;
  const review = reviewPageRemoval(state, pageId, replacementId);
  if (!review.uses.length && pageId !== state.site.homePageId) return { operations: [{ type: 'page.remove', pageId }], lost: [] };
  if (!replacementId || !Object.hasOwn(state.pages, replacementId) || replacementId === pageId) return none;
  // Sections are the ones the replacement page still has once the menu's links and the cards are gone, as the engine finds them.
  const base = withoutMenuLinks(state, pageId).view;
  const view = review.cards.length ? withoutCards(base, pageId) : base;
  const ids = pageIds(view, replacementId);
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
        // Nor one the page has today, which links may still use even if only a removed card keeps it showing.
        const reserved = [...given.values(), ...review.missing.map((m) => m.fragment).filter((f) => f !== fragment), ...pageIds(state, replacementId)];
        const plan = planSectionPick(view, replacementId, nodeId, reserved);
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
    let afterView: ProjectState;
    try {
      after = applyOperations(state, operations).state;
      afterView = view === state ? after : applyOperations(view, operations).state;
    } catch {
      return none;
    }
    // Elements' own IDs: the layout's fallbacks (`top`) would hide one an element stops rendering.
    const kept = elementIds(after, replacementId);
    const lost = [...elementIds(state, replacementId)].filter((id) => !kept.has(id));
    if (lost.length) return { operations: null, lost };
    // A section given an ID here must still be there once the cards are gone.
    const there = pageIds(afterView, replacementId);
    if (sectionReplacements.some((r) => r.to && !there.has(r.to))) return none;
  }
  operations.push({ type: 'page.remove', pageId, replacementPageId: replacementId, ...(sectionReplacements.length ? { sectionReplacements } : {}) });
  return { operations, lost: [] };
}
