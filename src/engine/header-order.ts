/**
 * The header menu's order beside the Pages order (spec §4.2). The menu keeps an order of its own unless the site says
 * it follows the pages (`site.headerMenuOrder: 'follow'`): then every edit leaves its page links in Pages order, a
 * page added to it goes in at its place in that order, and a page deleted takes its links out of it. Either way the
 * same rules decide which links sort: only a link straight to a page that appears once in the menu, and only among
 * the places such links hold, so a link to another site, an email address, a section of a page or a page linked twice
 * stays where the author put it, and every submenu stays whole.
 */
import { isBinding, type InstanceNode, type LinkValue, type ProjectState } from '@shared/types';
import { headerMenu, isSubItem, menuGroups, shownUnder } from './tree';

export type MenuItem = Record<string, unknown>;

/** Whether the header menu's page links follow the Pages order. */
export const followsPageOrder = (state: ProjectState): boolean => state.site.headerMenuOrder === 'follow';

/** The items a menu shows: the placement's own list, or its definition's while it has none (as the engine reads it). */
export function menuItems(menu: { node: InstanceNode; schema: { default: unknown } }): MenuItem[] | null {
  const own = menu.node.props.links;
  if (isBinding(own)) return null;
  const list = own === undefined ? menu.schema.default : own;
  return Array.isArray(list) ? (list as MenuItem[]) : null;
}

/** The header menu's rows in Pages order, and the menu as it is: each a top-level link with the links under it. */
export interface HeaderOrder {
  node: InstanceNode;
  items: MenuItem[];
  /** The menu as the header shows it now, and as it would follow the pages. A flat menu is all top level. */
  groups: MenuItem[][];
  wanted: MenuItem[][];
  /** The rows in the order that follows the pages: the same rows, moved. */
  desired: MenuItem[];
  /** Whether that differs from the order they are in now. */
  changed: boolean;
}

/** The page a row links straight to, while it is a page of the site. */
function targetOf(item: MenuItem | null | undefined, rank: ReadonlyMap<string, number>): string | null {
  const link = item?.link as LinkValue | undefined;
  return link && typeof link === 'object' && link.type === 'page' && !link.anchor && typeof link.target === 'string' && rank.has(link.target) ? link.target : null;
}

/** The rows that sort: links straight to a page that appears once in the menu. */
function sortable(items: ReadonlyArray<MenuItem>, rank: ReadonlyMap<string, number>): (it: MenuItem) => boolean {
  const count = new Map<string, number>();
  for (const it of items) {
    const t = targetOf(it, rank);
    if (t) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return (it) => {
    const t = targetOf(it, rank);
    return !!t && count.get(t) === 1;
  };
}

/** The menu as the header shows it: each top-level link with the links shown under it. */
function grouped(items: MenuItem[], groups: boolean): MenuItem[][] {
  const under = groups ? shownUnder(items) : items.map(() => false);
  const out: MenuItem[][] = [];
  items.forEach((it, i) => (under[i] ? out[out.length - 1].push(it) : out.push([it])));
  return out;
}

/**
 * The header menu's rows reordered to follow Pages. A top-level link moves with the links under it, and a link in a
 * submenu moves only within that submenu, so no link joins or leaves one. Null when there is no menu, or its list is
 * set from elsewhere.
 */
export function headerOrder(state: ProjectState): HeaderOrder | null {
  const menu = headerMenu(state);
  const items = menu && menuItems(menu);
  if (!menu || !items) return null;
  const rank = new Map(state.site.pageOrder.map((id, i) => [id, i]));
  const movable = sortable(items, rank);
  const groups = grouped(items, menuGroups(menu.schema));
  /** `list` with the movable links among the places they hold now sorted into Pages order, every other one in place. */
  const follow = <T>(list: T[], head: (x: T) => MenuItem, may: (x: T) => boolean): T[] => {
    const slots = list.flatMap((x, i) => (may(x) ? [i] : []));
    const sorted = slots.map((i) => list[i]).sort((a, b) => rank.get(targetOf(head(a), rank)!)! - rank.get(targetOf(head(b), rank)!)!);
    const out = [...list];
    slots.forEach((slot, k) => (out[slot] = sorted[k]));
    return out;
  };
  // A first link marked to go under the one above shows at the top level only while it is first: it stays there.
  const wanted = follow(groups, (g) => g[0], (g) => movable(g[0]) && !isSubItem(g[0])).map((g) => [g[0], ...follow(g.slice(1), (it) => it, movable)]);
  const desired = wanted.flat();
  return { node: menu.node, items, groups, wanted, desired, changed: desired.some((it, i) => it !== items[i]) };
}

/** The header menu before an edit, while it follows the pages: the rows that sort, and the link each row shows under. */
export interface MenuBefore {
  sorted: ReadonlySet<string>;
  /** By row ID: the ID of the top-level row it shows under, or null for a top-level row. */
  head: ReadonlyMap<string, string | null>;
}

const shownIn = (groups: boolean, list: ReadonlyArray<MenuItem>) => (groups ? shownUnder(list) : list.map(() => false));

/** The header menu as an edit finds it, for `keepHeaderOrder` to compare with after it; null while it keeps its own order. */
export function menuBefore(state: ProjectState): MenuBefore | null {
  if (!followsPageOrder(state)) return null;
  const menu = headerMenu(state);
  const items = menu && menuItems(menu);
  if (!menu || !items) return null;
  const movable = sortable(items, new Map(state.site.pageOrder.map((id, i) => [id, i])));
  const under = shownIn(menuGroups(menu.schema), items);
  const head = new Map<string, string | null>();
  let top: string | null = null;
  items.forEach((it, i) => {
    const id = typeof it?.id === 'string' ? it.id : null;
    if (!under[i]) top = id;
    if (id) head.set(id, under[i] ? top : null);
  });
  return { sorted: new Set(items.filter((it) => movable(it) && typeof it?.id === 'string').map((it) => it.id as string)), head };
}

/**
 * The rows at row `at`'s level, by index, without it: the top-level rows, or the other rows of its submenu.
 */
function peers(under: boolean[], at: number): number[] {
  if (!under[at]) return under.flatMap((u, i) => (!u && i !== at ? [i] : []));
  let start = at;
  while (start > 0 && under[start]) start--;
  let end = at + 1;
  while (end < under.length && under[end]) end++;
  const out: number[] = [];
  for (let i = start + 1; i < end; i++) if (i !== at) out.push(i);
  return out;
}

/**
 * While the menu follows the pages, put its page links in Pages order. Run after every edit, so the edit and the
 * menu's new order are one change. A row that sorts only since the edit (a link added, or pointed at a page, or no
 * longer one of two to its page: one `before` did not count) and is out of order among the rows that sort at its
 * level goes in at its page's place there, as a page added to the menu does, with only the links that showed under it
 * before the edit; the rest then sort among the places they hold. A menu shown from its definition's list gets a list
 * of its own only when it moves.
 */
export function keepHeaderOrder(state: ProjectState, before?: MenuBefore | null): void {
  if (!followsPageOrder(state)) return;
  const menu = headerMenu(state);
  let items: MenuItem[] | null = menu && menuItems(menu);
  if (!menu || !items) return;
  const inherited = menu.node.props.links === undefined;
  const start = items;
  if (before) {
    const rank = new Map(state.site.pageOrder.map((id, i) => [id, i]));
    // Which rows sort is counted across the whole menu, whatever is lifted out of it for a moment.
    const movable = sortable(items, rank);
    const groups = menuGroups(menu.schema);
    const rankOf = (it: MenuItem) => rank.get(targetOf(it, rank)!)!;
    for (const row of items.filter((it) => movable(it) && typeof it?.id === 'string' && !before.sorted.has(it.id as string))) {
      const at = items.indexOf(row);
      const under = shownIn(groups, items);
      // A first row marked for a submenu shows at the top level only where it is.
      if (!under[at] && isSubItem(row)) continue;
      const mine = rankOf(row);
      const level = peers(under, at).filter((i) => movable(items![i]) && (under[at] || !isSubItem(items![i])));
      const prev = level.filter((i) => i < at).at(-1);
      const next = level.find((i) => i > at);
      // Already in its page's place: it stays, and so does everything around it.
      if ((prev === undefined || rankOf(items[prev]) < mine) && (next === undefined || rankOf(items[next]) > mine)) continue;
      // It takes along only the links that showed under it before the edit, never another link's submenu.
      let end = at + 1;
      const id = row.id as string;
      if (!under[at])
        while (end < items.length && under[end]) {
          // A link stays behind that was at the top level before, or under a link still in the menu; one whose link
          // went with the edit (a second link to the page, removed) keeps showing under this one.
          const child = items[end]?.id;
          const was = typeof child === 'string' ? before.head.get(child) : undefined;
          if (was === null || (was !== undefined && was !== id && items.some((it) => it?.id === was))) break;
          end++;
        }
      const rest: MenuItem[] = [...items.slice(0, at), ...items.slice(end)];
      let place = rest.length;
      if (under[at]) {
        const left = shownIn(groups, rest);
        place = at;
        while (place < rest.length && left[place]) place++;
      }
      const index = followingSlot(state, rest, targetOf(row, rank)!, { index: place, sub: under[at] }, movable);
      items = [...rest.slice(0, index), ...items.slice(at, end), ...rest.slice(index)];
    }
    if (items.some((it, i) => it !== start[i])) menu.node.props.links = inherited ? structuredClone(items) : items;
  }
  const order = headerOrder(state);
  if (!order?.changed) return;
  order.node.props.links = order.node.props.links === undefined ? structuredClone(order.desired) : order.desired;
}

/**
 * Where a new link to `pageId` goes in a menu that follows the pages, given the place `slot` the menu would give it
 * (`headerMenuSlot`: the end of the top level, or of its parent's submenu): among the links at that level that sort,
 * before the first one whose page comes later in Pages, else after the last one. The level never changes. `movable`
 * says which rows sort when that was counted on the whole menu, before a row was lifted out of it.
 */
export function followingSlot(state: ProjectState, items: ReadonlyArray<MenuItem>, pageId: string, slot: { index: number; sub: boolean }, movable?: (it: MenuItem) => boolean): number {
  const menu = headerMenu(state);
  const rank = new Map(state.site.pageOrder.map((id, i) => [id, i]));
  const mine = rank.get(pageId);
  if (!menu || mine === undefined || items.some((it) => targetOf(it, rank) === pageId)) return slot.index;
  const sorts = movable ?? sortable(items, rank);
  const under = shownIn(menuGroups(menu.schema), items);
  // The rows at its level, as [start, end) spans: a top-level link with its submenu, or one link of the parent's submenu.
  const spans: Array<[number, number]> = [];
  if (slot.sub) {
    let start = slot.index;
    while (start > 0 && under[start - 1]) start--;
    for (let i = start; i < slot.index; i++) spans.push([i, i + 1]);
  } else
    items.forEach((_, i) => {
      if (under[i]) return;
      let end = i + 1;
      while (end < items.length && under[end]) end++;
      spans.push([i, end]);
    });
  const sorted = spans.filter(([s]) => sorts(items[s]) && (slot.sub || !isSubItem(items[s])));
  const later = sorted.find(([s]) => rank.get(targetOf(items[s], rank)!)! > mine);
  if (later) return later[0];
  return sorted.length ? sorted[sorted.length - 1][1] : slot.index;
}

/**
 * Take the header menu's links to `pageId` out of it, as deleting the page does while the menu follows the pages.
 * With `duplicateOf` (the page its links are about to be pointed at), only its plain links go, and only when the menu
 * already links plainly to that page, so the menu never shows two links to one page.
 * A link that had links under it leaves them together, under the first of them. Returns their labels; none, and
 * nothing changes, when the menu would end up with fewer links than it must hold.
 */
export function dropHeaderLinks(state: ProjectState, pageId: string, duplicateOf?: string): string[] {
  const menu = headerMenu(state);
  const items = menu && menuItems(menu);
  if (!menu || !items) return [];
  const plain = (it: MenuItem, id: string) => {
    const link = it?.link as LinkValue | undefined;
    return !!link && typeof link === 'object' && link.type === 'page' && link.target === id && !link.anchor;
  };
  // With `duplicateOf`: only the plain links to the page that would repeat a plain link the menu already has to that page.
  if (duplicateOf !== undefined && !items.some((it) => plain(it, duplicateOf))) return [];
  const goes = (it: MenuItem) => {
    const link = it?.link as LinkValue | undefined;
    if (duplicateOf !== undefined) return plain(it, pageId);
    return !!link && typeof link === 'object' && link.type === 'page' && link.target === pageId;
  };
  if (!items.some(goes)) return [];
  const kept = items.filter((it) => !goes(it));
  if (menu.schema.min !== undefined && kept.length < menu.schema.min) return [];
  const under = menuGroups(menu.schema) ? shownUnder(items) : items.map(() => false);
  const out = structuredClone(kept);
  // The first link left of a submenu whose link went leads it now, so the rest never join the submenu above.
  let headGone = false;
  let k = 0;
  items.forEach((it, i) => {
    if (!under[i]) headGone = goes(it);
    if (goes(it)) return;
    const row = out[k++];
    if (under[i] && headGone) {
      // Said outright: a list whose rows sit under the one above by default would keep it there.
      row.sub = false;
      headGone = false;
    }
  });
  menu.node.props.links = out;
  const label = (it: MenuItem) => (typeof it?.label === 'string' && it.label.trim() ? it.label.trim() : 'Link');
  return items.filter(goes).map(label);
}
