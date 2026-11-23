import type { ProjectState } from '@shared/types';

/** One page as the toolbar switcher and the command menu list it: the title, and the address that tells same-title pages apart. */
export interface PageChoice {
  id: string;
  title: string;
  /** The address the page is published at: `/` for the home page, otherwise its route. */
  address: string;
  home: boolean;
}

/** Every page in site order, with the address it is currently published at. */
export function pageChoices(state: ProjectState): PageChoice[] {
  const homeId = state.site.homePageId;
  return state.site.pageOrder.flatMap((id) => {
    const page = state.pages[id];
    if (!page) return [];
    const home = id === homeId;
    return [{ id, title: page.title, address: home ? '/' : page.route, home }];
  });
}

/** Whether every word of the query is in the text, in any order and case; an empty query matches everything. */
export function matchesWords(query: string, text: string): boolean {
  const hay = text.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** The text a command is searched by: its label, then its detail (a page's address) when it has one. */
export const commandText = (label: string, detail?: string): string => (detail ? `${label} ${detail}` : label);

/** Puts the entries whose detail is exactly the query first (stable otherwise), so a page typed by its full address survives a result cap. */
export function exactDetailFirst<T extends { detail?: string }>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const exact = (e: T) => e.detail?.toLowerCase() === q;
  return [...entries.filter(exact), ...entries.filter((e) => !exact(e))];
}
