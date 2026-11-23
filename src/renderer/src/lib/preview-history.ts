/**
 * A visitor's journey through the site in Preview, kept apart from project Undo.
 *
 * The preview frame keeps the real history: each link, section jump and page picked is an entry of the frame's own
 * session history, so Back and Forward traverse it natively and the site restores each entry's scroll position. The
 * page reports where it is (see bridge.client.js: `history`): its address and the keys of the entries just before
 * and after it. What the editor adds is which of those entries are the visitor's: Back and Forward only step to an
 * entry visited while previewing, never to a page the author opened while editing, so the journey starts where
 * Preview was entered.
 */

/** Where the preview frame is in its own history, as the page last reported it. */
export interface FrameEntry {
  /** The address inside the site, with its query and #fragment: "/contact/#studio-hours". */
  address: string;
  /** The entry's history key (Navigation API), or null where the page cannot tell. */
  key: string | null;
  /** The keys of the entries just before and after it in the frame's history, if any. */
  back: string | null;
  forward: string | null;
}

export interface VisitorHistory {
  at: FrameEntry | null;
  /** The entries visited in this journey, by key, the most recently visited last. */
  visited: string[];
  /** The site's page addresses when the journey began (see siteAddresses). */
  site: string | null;
}

export const NO_HISTORY: VisitorHistory = { at: null, visited: [], site: null };

/** Entries kept for one journey. The frame's own history holds far fewer; the rest were left behind by a link
 *  followed after Back. */
const MAX_VISITED = 1000;

/** The entry is the most recent visit: a page visited again is not the first to be forgotten. */
const visit = (visited: string[], key: string | null) => (!key ? visited : visited[visited.length - 1] === key ? visited : [...visited.filter((k) => k !== key), key].slice(-MAX_VISITED));

/** The site's page addresses, as one value: when they change, an earlier journey may lead to a page that is gone. */
export function siteAddresses(routes: string[]): string {
  return [...routes].sort().join('\n');
}

/**
 * Preview was entered. A frame still on an entry of the last journey, on a site whose pages are where they were (the
 * author went back to editing, changed some text, and returned) carries on with it; anything else starts a new
 * journey at the current entry. `settled` is false while a page the editor asked for is still opening: the journey
 * then starts once the frame is there.
 */
export function startJourney(h: VisitorHistory, site: string, settled = true): VisitorHistory {
  const key = settled ? (h.at?.key ?? null) : null;
  if (key && h.visited.includes(key) && h.site === site) return h;
  return { at: h.at, visited: key ? [key] : [], site };
}

/** The page reported where it is now. While previewing, the entry it is on is part of the journey. */
export function observe(h: VisitorHistory, at: FrameEntry, previewing: boolean): VisitorHistory {
  return { ...h, at, visited: previewing ? visit(h.visited, at.key) : h.visited };
}

/** The entry Back or Forward goes to: the neighbouring entry of the frame's history, only if it was visited. */
export function stepTarget(h: VisitorHistory, dir: 'back' | 'forward'): string | null {
  const key = dir === 'back' ? h.at?.back : h.at?.forward;
  return key && h.visited.includes(key) ? key : null;
}

/** The path of an address, without its query or #fragment. */
export const addressPath = (address: string) => address.split(/[?#]/)[0];

/** An address reported by the page, cleaned for display: a site-relative path, never another origin. */
export function frameEntry(p: Record<string, unknown>): FrameEntry | null {
  const address = typeof p.address === 'string' && p.address.startsWith('/') && !p.address.startsWith('//') ? p.address.slice(0, 2000) : null;
  if (!address) return null;
  const key = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);
  return { address, key: key(p.key), back: key(p.back), forward: key(p.forward) };
}
