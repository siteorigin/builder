/**
 * Where pages sit in the site. A page's place comes from its address: it is inside the page whose address is the
 * nearest folder above its own, so "/lookbook/kitchens/" is inside "/lookbook/", and moving a page means giving it
 * an address in another folder. Home ("/") holds no pages: a page at "/about/" is at the top level. Nothing else
 * records the hierarchy, so a page's address and its place can never disagree.
 */

type PageLike = { id: string; route: string };

/** The folder above a route: "/lookbook/kitchens/" → "/lookbook/"; null for a top-level route or Home. */
export function routeFolder(route: string): string | null {
  const cut = route.lastIndexOf('/', route.length - 2);
  return cut > 0 ? route.slice(0, cut + 1) : null;
}

/** The last segment of a route: "/lookbook/kitchens/" → "kitchens"; "" for Home. */
export function routeLeaf(route: string): string {
  return route.slice(route.lastIndexOf('/', route.length - 2) + 1, -1);
}

/** Whether `route` is inside the folder `parent` (at any depth), compared as case-insensitive file systems do. */
export function routeWithin(route: string, parent: string): boolean {
  return parent !== '/' && route.length > parent.length && route.toLowerCase().startsWith(parent.toLowerCase());
}

/** Each page's parent page: the page at the nearest folder above its address, or null at the top level. */
export function pageParents(pages: Iterable<PageLike>): Map<string, string | null> {
  const list = [...pages];
  const byRoute = new Map(list.filter((p) => p.route !== '/').map((p) => [p.route.toLowerCase(), p.id]));
  const out = new Map<string, string | null>();
  for (const p of list) {
    let parent: string | null = null;
    for (let folder = routeFolder(p.route); folder && !parent; folder = routeFolder(folder)) parent = byRoute.get(folder.toLowerCase()) ?? null;
    out.set(p.id, parent === p.id ? null : parent);
  }
  return out;
}

/** One page in the Pages list: its depth below the top level and the page it is inside. */
export interface PageRow {
  id: string;
  depth: number;
  parentId: string | null;
}

/**
 * The pages in `order` as an outline: each page followed by the pages inside it, siblings keeping their order.
 * A page whose parent is not in `order` is shown at the top level.
 */
export function pageRows(pages: Record<string, PageLike>, order: readonly string[]): PageRow[] {
  const ids = order.filter((id) => Object.hasOwn(pages, id));
  const parents = pageParents(ids.map((id) => pages[id]));
  const children = new Map<string | null, string[]>();
  for (const id of ids) {
    const parent = parents.get(id) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const rows: PageRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const id of children.get(parentId) ?? []) {
      rows.push({ id, depth, parentId });
      visit(id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** The pages inside `pageId`, at any depth: every page whose address is in its folder. */
export function pagesWithin(pages: Record<string, PageLike>, pageId: string): string[] {
  const page = pages[pageId];
  if (!page || page.route === '/') return [];
  return Object.values(pages)
    .filter((p) => p.id !== pageId && routeWithin(p.route, page.route))
    .map((p) => p.id);
}

/** A page's address before and after an edit. */
export type RouteMove = { pageId: string; from: string; to: string };

type MoveSite = {
  pages: Record<string, PageLike & { title: string }>;
  site: { homePageId: string; redirects?: unknown };
};

const quoteTitle = (p: { title: string }) => `“${p.title}”`;

/**
 * What giving `pageId` the address `to` (already normalized and valid) changes: the page moves, and the pages
 * inside it move with it, each keeping the rest of its address ("/lookbook/kitchens/" follows "/lookbook/" to
 * "/work/lookbook/kitchens/"). Returns why it cannot happen instead, naming the page and address in the way: an
 * address inside the page itself, too deep, or taken by a page that stays put. The page given the address may take
 * over an old address kept working for another page, as an address chosen on purpose always could; a page moved
 * along with it never takes one silently. Nothing changes when the address is the one the page already has.
 */
export function planRouteMove(state: MoveSite, pageId: string, to: string, validate: (route: string) => string | null): { moves: RouteMove[] } | { error: string } {
  const page = state.pages[pageId];
  if (!page || page.route === to) return { moves: [] };
  if (page.route === '/') return { moves: [{ pageId, from: page.route, to }] };
  if (routeWithin(to, page.route)) return { error: `${quoteTitle(page)} cannot move inside itself. Choose an address outside ${page.route}.` };
  const branch = [page, ...pagesWithin(state.pages, pageId).map((id) => state.pages[id])];
  const inBranch = new Set(branch.map((p) => p.id));
  const kept: unknown[] = Array.isArray(state.site.redirects) ? state.site.redirects : [];
  const moves: RouteMove[] = [];
  for (const p of branch) {
    const next = p.id === pageId ? to : to + p.route.slice(page.route.length);
    if (p.id !== pageId) {
      const err = validate(next);
      if (err) return { error: `Moving ${quoteTitle(page)} would move ${quoteTitle(p)} to ${next}, which is not possible: ${err}` };
    }
    const other = Object.values(state.pages).find((q) => !inBranch.has(q.id) && q.route.toLowerCase() === next.toLowerCase());
    if (other) return { error: p.id === pageId ? `Another page already uses ${next}.` : `Moving ${quoteTitle(page)} would move ${quoteTitle(p)} to ${next}, which ${quoteTitle(other)} already uses.` };
    if (p.id !== pageId) {
      const old = kept.find((r): r is { from: string; pageId: string } => typeof (r as { from?: unknown })?.from === 'string' && (r as { from: string }).from.toLowerCase() === next.toLowerCase());
      if (old && old.pageId !== p.id) {
        const owner = state.pages[old.pageId];
        return { error: `Moving ${quoteTitle(page)} would move ${quoteTitle(p)} to ${next}, an old address kept working for ${owner ? quoteTitle(owner) : 'another page'}.` };
      }
    }
    if (next !== p.route) moves.push({ pageId: p.id, from: p.route, to: next });
  }
  return { moves };
}
