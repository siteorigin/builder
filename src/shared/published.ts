/**
 * The addresses the website has been exported with (#890): each page address a successful export delivered, and the
 * page it led to then. Only an address someone may have been given (a link, a bookmark, a search result) is worth
 * keeping working when a page moves, so a page's corrections before its first export leave no old addresses behind.
 * The record is the project's own, in a document of its own, written by the export rather than by an edit: undo,
 * History and restoring a version never take it back, since none of them takes back what was published.
 */
import type { ProjectState, PublishedDoc } from './types';

/** Where the record is kept, relative to the project folder. */
export const PUBLISHED_FILE = 'siteorigin/published.json';

/** The page an export last delivered at `address`, or undefined for an address no export has had. */
export function publishedPageAt(state: Pick<ProjectState, 'published'>, address: string): string | undefined {
  const pages = state.published?.pages;
  if (!pages || typeof pages !== 'object') return undefined;
  const key = address.toLowerCase();
  return Object.hasOwn(pages, key) && typeof pages[key] === 'string' ? pages[key] : undefined;
}

/** Whether `address` was exported as the address of the page `pageId`, so it is kept working when the page leaves it. */
export const wasPublishedFor = (state: Pick<ProjectState, 'published'>, address: string, pageId: string): boolean => publishedPageAt(state, address) === pageId;

/**
 * The record once `live` (the published project an export delivered) is added to `current`: every page address it
 * delivered, with the page there, and every address recorded before kept. Undefined when that changes nothing.
 */
export function withPublished(current: PublishedDoc | undefined, live: Pick<ProjectState, 'pages'>): PublishedDoc | undefined {
  const pages: Record<string, string> = { ...(current?.pages ?? {}) };
  let changed = false;
  for (const p of Object.values(live.pages)) {
    if (typeof p?.route !== 'string' || typeof p.id !== 'string') continue;
    const key = p.route.toLowerCase();
    if (pages[key] === p.id) continue;
    pages[key] = p.id;
    changed = true;
  }
  if (!changed) return undefined;
  return { pages: Object.fromEntries(Object.keys(pages).sort().map((k) => [k, pages[k]])) };
}

/** A stored record, checked: an object whose `pages` map addresses to page IDs. Null when it is not one. */
export function publishedDocProblem(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'is not a record of exported addresses';
  const pages = (doc as { pages?: unknown }).pages;
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) return 'has no list of exported page addresses';
  for (const [address, id] of Object.entries(pages)) if (!address.startsWith('/') || typeof id !== 'string') return `has an entry for ${JSON.stringify(address)} that is not an address and a page ID`;
  return null;
}
