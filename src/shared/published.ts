/**
 * The addresses the website has been exported with (#890): each page address a successful export delivered, and the
 * page it led to then. Only an address someone may have been given (a link, a bookmark, a search result) is worth
 * keeping working when a page moves, so a page's corrections before its first export leave no old addresses behind.
 * The record is the project's own, in a document of its own, written by the export rather than by an edit: undo,
 * History and restoring a version never take it back, since none of them takes back what was published.
 *
 * So an address it holds is kept working for its page whenever the page has left it, however it left: an Address edit
 * records the old address as a redirect, and an undone move, a step back in History or a restored version, which put
 * back documents from before the export, still find it here (keptPublishedAddresses, #1382). Only the author stops
 * keeping one (SiteDoc.droppedAddresses), and a collection's own address is the collection's.
 */
import { validateRoute } from './routes';
import type { ProjectState, PublishedDoc, SiteRedirect } from './types';

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

/** Whether the author stopped keeping `address` working for the page `pageId` (SiteDoc.droppedAddresses). */
export function isDroppedAddress(state: { site: { droppedAddresses?: unknown } }, address: string, pageId: string): boolean {
  const list: unknown = state.site?.droppedAddresses;
  const key = address.toLowerCase();
  return Array.isArray(list) && list.some((d) => typeof d?.from === 'string' && d.from.toLowerCase() === key && d.pageId === pageId);
}

/**
 * The site's dropped addresses once the author stops keeping `address` working for `pageId`, when an export delivered
 * it for that page (any other address was never kept for it here); undefined when that changes nothing.
 */
export function withDroppedAddress(state: Pick<ProjectState, 'site' | 'published'>, address: string, pageId: string | undefined): Array<{ from: string; pageId: string }> | undefined {
  if (pageId === undefined || !wasPublishedFor(state, address, pageId) || isDroppedAddress(state, address, pageId)) return undefined;
  const list: unknown = state.site.droppedAddresses;
  return [...(Array.isArray(list) ? list : []), { from: address.toLowerCase(), pageId }];
}

/** The parts of a project the addresses its pages left are worked out from. */
type LeftSite = {
  site: { homePageId: string; redirects?: unknown; droppedAddresses?: unknown };
  pages: Record<string, { id: string; route: string; draft?: boolean }>;
  published?: PublishedDoc;
};

/**
 * The addresses an export delivered for a page that has left them since (`{ from, pageId }`, in the record's order):
 * each one no redirect of the site's own is at, that its page or a published page does not have now, and that the
 * author has not dropped. A draft at one leaves it working until the draft is published, as it does a redirect of
 * the site's own (#1363). The site keeps those no collection holds working (keptPublishedAddresses in
 * shared/collections, which knows the collections' addresses).
 */
export function addressesLeft(state: LeftSite): SiteRedirect[] {
  const recorded = state.published?.pages;
  if (!recorded || typeof recorded !== 'object' || !state.pages) return [];
  const stored: unknown = state.site.redirects;
  const kept = new Set(Array.isArray(stored) ? stored.flatMap((r) => (typeof r?.from === 'string' ? [r.from.toLowerCase()] : [])) : []);
  const held = new Map<string, { id: string; draft: boolean }>();
  for (const p of Object.values(state.pages)) if (typeof p?.route === 'string') held.set(p.route.toLowerCase(), { id: p.id, draft: p.draft === true && p.id !== state.site.homePageId });
  const out: SiteRedirect[] = [];
  for (const [from, pageId] of Object.entries(recorded)) {
    if (typeof pageId !== 'string' || !Object.hasOwn(state.pages, pageId) || from === '/' || validateRoute(from) || kept.has(from)) continue;
    const holder = held.get(from);
    if (holder && (holder.id === pageId || !holder.draft)) continue;
    if (isDroppedAddress(state, from, pageId)) continue;
    out.push({ from, pageId });
  }
  return out;
}

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
