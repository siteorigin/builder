/**
 * How a page's settings are saved, wherever they are edited: the Inspector, and the SEO view for its Search & sharing
 * and structured data (#702). One `page.update`, with a history label naming the page ("Change browser title (About)"),
 * so a change and its undo read the same from either place.
 */
import type { PageDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { applyOps, getState } from '../store';

/** Saves a change to one page's settings. */
export type PageUpd = (patch: Record<string, unknown>, label?: string) => void;

/** The operation and history label a change to a page's settings is saved with. */
export function pageUpdate(page: Pick<PageDoc, 'id' | 'title'>, patch: Record<string, unknown>, label = 'Update page settings'): { operations: EditOperation[]; label: string } {
  return { operations: [{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], label: `${label} (${page.title})` };
}

/** Saves changes to `page`'s settings (see pageUpdate). */
export const pageUpdater =
  (page: Pick<PageDoc, 'id' | 'title'>): PageUpd =>
  (patch, label) => {
    const u = pageUpdate(page, patch, label);
    void applyOps(u.operations, u.label);
  };

/** Whether a page is still in the project: text kept for one of its fields goes with it (see DraftInput's keepWhile). */
export const pageAlive = (id: string) => () => Object.hasOwn(getState().snapshot?.state.pages ?? {}, id);
