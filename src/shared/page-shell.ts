/**
 * Which pages show the shared header and the shared footer. Each page chooses the two on its own: a landing page
 * can keep the footer's contact details without the header's menu.
 */
import type { PageDoc, ProjectState } from './types';

export type ShellPart = 'header' | 'footer';

/** The shared parts in the order a page renders them. */
export const SHELL_PARTS: readonly ShellPart[] = ['header', 'footer'];

export const isShellPart = (id: unknown): id is ShellPart => id === 'header' || id === 'footer';

/** Whether a page shows a shared part. */
export function showsPart(page: Pick<PageDoc, 'showHeader' | 'showFooter'> | null | undefined, part: ShellPart): boolean {
  if (!page) return false;
  return part === 'header' ? page.showHeader !== false : page.showFooter !== false;
}

/** The shared parts a page shows, in render order. */
export const partsShown = (page: PageDoc | null | undefined): ShellPart[] => SHELL_PARTS.filter((part) => showsPart(page, part));

/** The site's pages, in site order, that show a shared part. */
export function pagesShowing(state: ProjectState, part: ShellPart): PageDoc[] {
  return state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id)).map((id) => state.pages[id]).filter((p) => showsPart(p, part));
}

/**
 * The page to show a shared part on: `preferred` (the page on screen) when it shows the part, else the first page
 * in site order that does. Undefined when no page shows it, or `part` is not a shared part.
 */
export function pageShowing(state: ProjectState, part: string, preferred?: string | null): string | undefined {
  if (!isShellPart(part)) return undefined;
  if (preferred && Object.hasOwn(state.pages, preferred) && showsPart(state.pages[preferred], part)) return preferred;
  return pagesShowing(state, part)[0]?.id;
}

/** "the shared header" or "the shared footer", for messages. */
export const partName = (part: string): string => (part === 'footer' ? 'the shared footer' : part === 'header' ? 'the shared header' : 'the shared header and footer');
