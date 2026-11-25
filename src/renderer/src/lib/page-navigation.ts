/**
 * A page's title, the labels visitors read for it, and the order of the site's menu. A page is named three times
 * over: its title (what Pages and the inspector show), its page heading, and the menu links that go to it. The heading
 * and the links start as copies of the title, so a rename leaves them behind until the author says otherwise. The
 * Pages panel's order and the header menu's order are independent too: moving a page leaves the menu as it was.
 * These are the plans both offers make, as edits that keep every label and link the author chose.
 */
import { isBinding, type InstanceNode, type LinkValue, type OwnerRef, type ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { headerMenu, isSubItem, menuGroups, shellMenu, shownUnder } from '@engine/tree';
import { pageHeadings } from '@generator/checks';

/** A visitor-facing label that still reads as the page's old name. */
export interface RenameLabel {
  /** Names it across revisions, for the checkbox that chooses it. */
  key: string;
  /** Where visitors read it. */
  where: string;
  /** Chosen to update unless the author unticks it. A label that may have been the author's own choice starts unticked. */
  preselect: boolean;
  /** What it says now: one of the old names. */
  text: string;
  /** The edit that makes it read the page's current title. */
  op: EditOperation;
}

type MenuItem = { id?: unknown; label?: unknown; link?: unknown };

/** The items a menu shows: the placement's own list, or its definition's while it has none (as the engine reads it). */
function menuItems(menu: { node: InstanceNode; schema: { default: unknown } }): MenuItem[] | null {
  const own = menu.node.props.links;
  if (isBinding(own)) return null;
  const list = Array.isArray(own) ? own : menu.schema.default;
  return Array.isArray(list) ? (list as MenuItem[]) : null;
}

/** A link straight to the page, not to a section of it. */
const pageLink = (v: unknown, pageId: string): v is LinkValue => !!v && typeof v === 'object' && (v as LinkValue).type === 'page' && (v as LinkValue).target === pageId && !(v as LinkValue).anchor;

/**
 * The labels that still say `from` (the page's name before it was renamed to its current title): the page's own
 * Heading 1 when a section's heading field holds exactly that text, and the shared header's and footer's menu links
 * to the page labelled exactly that. A label that differs at all (in case, in spacing) was written by someone, and is
 * left alone, and so is a link to a section of the page. A page with its own menu label (`navLabel`) names its menu
 * links on purpose, so with one the links are offered unticked, and a menu label that is the old name is offered
 * (unticked) to give up for the title. The address is never part of it.
 */
export function renameLabels(state: ProjectState, pageId: string, from: string | readonly string[]): RenameLabel[] {
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page) return [];
  const to = page.title;
  // The page's old names (more than one when the rename replaced a title changed elsewhere), never its current one.
  const names = new Set((typeof from === 'string' ? [from] : from).filter((n) => n && n !== to));
  if (!names.size) return [];
  const old = (v: unknown): v is string => typeof v === 'string' && names.has(v);
  const out: RenameLabel[] = [];
  const owner: OwnerRef = { kind: 'page', id: pageId };
  // The headings visitors read as the page's title, by the section that shows them (the outline reads spaces as one).
  const words = (t: string) => t.replace(/\s+/g, ' ').trim();
  const titles = new Map<string, Set<string>>();
  for (const h of pageHeadings(state, pageId, { shell: false }).outline)
    if (h.level === 1 && h.owner.kind === 'page' && h.owner.id === pageId) titles.set(h.nodeId, (titles.get(h.nodeId) ?? new Set()).add(h.text));
  for (const [id, shown] of titles) {
    const n = page.nodes[id];
    const text = n?.kind === 'instance' ? n.props.heading : undefined;
    // The section's heading field holds an old name, and it is that very text the section shows as the Heading 1.
    if (n?.kind !== 'instance' || !old(text) || !shown.has(words(text))) continue;
    const def = state.components[n.definitionId];
    if (def?.properties.heading?.type !== 'string') continue;
    out.push({ key: `heading:${id}`, where: `${def.name} heading`, preselect: true, text, op: { type: 'instance.setProp', owner, nodeId: id, prop: 'heading', value: to } });
  }
  const nav = typeof page.navLabel === 'string' && page.navLabel ? page.navLabel : undefined;
  const chosen = nav !== undefined;
  for (const part of ['header', 'footer'] as const) {
    const menu = shellMenu(state, part);
    const items = menu && menuItems(menu);
    if (!menu || !items) continue;
    const where = part === 'header' ? 'Header menu link' : 'Footer link';
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !old(item.label) || !pageLink(item.link, pageId)) continue;
      out.push({
        key: `${part}:${menu.node.id}:${item.id}`,
        where,
        preselect: !chosen,
        text: item.label,
        op: { type: 'instance.setProp', owner: { kind: 'shell', id: part }, nodeId: menu.node.id, prop: 'links', itemId: item.id, field: 'label', value: to }
      });
    }
  }
  if (old(nav)) out.push({ key: 'navLabel', where: 'Menu label for new menu links', preselect: false, text: nav, op: { type: 'page.update', pageId, navLabel: '' } });
  return out;
}

/** The header menu's page links, reordered to follow the Pages panel. */
export interface HeaderOrderPlan {
  /** The header's own placement and the edits that reorder its links, one move each. */
  ops: EditOperation[];
  /** The menu's labels as it lists them now, and as it would once the edits apply: one per top-level link, with its submenu. */
  before: string[];
  after: string[];
}

/**
 * Reorder the header menu's links to the pages to follow the Pages panel's order. Only links straight to a page that
 * appears once in the menu move, and only among the places such links hold now: a link to another site, an email
 * address, a section of a page, or a page linked twice stays where the author put it, and a page that is not in the
 * menu is not added. A menu that groups links keeps every group whole: a top-level link moves with the links under it
 * (a section moved with its pages in Pages brings its submenu along), and a link in a submenu moves only within that
 * submenu, so no link joins or leaves a submenu. Null when there is no menu to reorder or it already follows the pages.
 */
export function headerOrderPlan(state: ProjectState): HeaderOrderPlan | null {
  const menu = headerMenu(state);
  const items = menu && menuItems(menu);
  // A row without an ID (a document written by hand) cannot be moved, or moved around, by an edit.
  if (!menu || !items || items.some((it) => typeof it?.id !== 'string')) return null;
  const rank = new Map(state.site.pageOrder.map((id, i) => [id, i]));
  const target = (item: MenuItem) => {
    const link = item?.link as LinkValue | undefined;
    return link && link.type === 'page' && !link.anchor && typeof link.target === 'string' && rank.has(link.target) ? link.target : null;
  };
  const count = new Map<string, number>();
  for (const it of items) {
    const t = target(it);
    if (t) count.set(t, (count.get(t) ?? 0) + 1);
  }
  const movable = (it: MenuItem) => {
    const t = target(it);
    return !!t && count.get(t) === 1;
  };
  // The menu as the header shows it: each top-level link with the links shown under it. A flat menu is all top level.
  const under = menuGroups(menu.schema) ? shownUnder(items) : items.map(() => false);
  const groups: MenuItem[][] = [];
  items.forEach((it, i) => (under[i] ? groups[groups.length - 1].push(it) : groups.push([it])));
  /** `list` with the movable links among the places they hold now sorted into Pages order, every other one in place. */
  const follow = <T>(list: T[], head: (x: T) => MenuItem, may: (x: T) => boolean): T[] => {
    const slots = list.flatMap((x, i) => (may(x) ? [i] : []));
    const sorted = slots.map((i) => list[i]).sort((a, b) => rank.get(target(head(a))!)! - rank.get(target(head(b))!)!);
    const out = [...list];
    slots.forEach((slot, k) => (out[slot] = sorted[k]));
    return out;
  };
  // A first link marked to go under the one above shows at the top level only while it is first: it stays there.
  const wanted = follow(groups, (g) => g[0], (g) => movable(g[0]) && !isSubItem(g[0])).map((g) => [g[0], ...follow(g.slice(1), (it) => it, movable)]);
  const desired = wanted.flat();
  if (desired.every((it, i) => it === items[i])) return null;
  // One move per link out of place, left to right: each puts the link that belongs there in its place.
  const cur = [...items];
  const ops: EditOperation[] = [];
  const owner: OwnerRef = { kind: 'shell', id: 'header' };
  desired.forEach((want, i) => {
    if (cur[i] === want) return;
    const from = cur.indexOf(want);
    cur.splice(i, 0, cur.splice(from, 1)[0]);
    ops.push({ type: 'instance.listMove', owner, nodeId: menu.node.id, prop: 'links', itemId: want.id as string, index: i });
  });
  const label = (it: MenuItem) => (typeof it?.label === 'string' && it.label.trim() ? it.label.trim() : 'Link');
  // A submenu is named after its link: "Lookbook (Kitchens, Baths)".
  const listed = (gs: MenuItem[][]) => gs.map((g) => (g.length > 1 ? `${label(g[0])} (${g.slice(1).map(label).join(', ')})` : label(g[0])));
  return { ops, before: listed(groups), after: listed(wanted) };
}

/** Whether the shared header's menu links straight to the page. */
export function inHeaderMenu(state: ProjectState, pageId: string): boolean {
  const menu = headerMenu(state);
  const items = menu && menuItems(menu);
  return !!items?.some((it) => pageLink(it?.link, pageId));
}

/** The footer's links made from the header menu's top-level links. */
export interface FooterCopyPlan {
  /** The edit that replaces every footer link with a copy of a header link, as one change. */
  op: EditOperation;
  /** How many links the footer will list, and how many it lists now (all replaced). */
  count: number;
  replaces: number;
  /** Header links left out because the footer holds fewer links than the header shows. */
  left: number;
  /** Whether the footer already lists exactly these links, in this order. */
  matches: boolean;
}

/** A link as the engine saves it, so two that go to the same place compare equal however they were written. */
const linkKey = (v: unknown): string => {
  if (!v || typeof v !== 'object') return JSON.stringify(v ?? null);
  const l = v as Partial<LinkValue>;
  return JSON.stringify([l.type ?? 'none', String(l.target ?? '').trim(), l.anchor ? String(l.anchor).replace(/^#/, '') : '', l.newTab === true]);
};

/**
 * Copy the header menu's top-level links into the footer's links, replacing the footer's own: each keeps its label and
 * destination, in the header's order, and any other field a footer link has starts at its default. A link shown in a
 * submenu stays out, and a footer that holds fewer links than the header shows takes the first ones. Null when there
 * is no header menu with a top-level link, no footer menu, or either list comes from somewhere else.
 */
export function footerCopyPlan(state: ProjectState): FooterCopyPlan | null {
  const header = headerMenu(state);
  const footer = shellMenu(state, 'footer');
  const from = header && menuItems(header);
  const now = footer && menuItems(footer);
  if (!header || !footer || !from || !now) return null;
  const under = menuGroups(header.schema) ? shownUnder(from) : from.map(() => false);
  const top = from.filter((it, i) => !under[i] && !!it && typeof it === 'object' && !Array.isArray(it));
  if (!top.length) return null;
  // Each link as the header shows it: a field it leaves out reads as the header's default for that field.
  const shown = (it: MenuItem, menu: NonNullable<ReturnType<typeof shellMenu>>, key: 'label' | 'link') => (Object.hasOwn(it, key) ? it[key] : (menu.schema.fields[key] as { default?: unknown }).default);
  const copied = top.slice(0, footer.schema.max ?? top.length).map((it) => ({ label: structuredClone(shown(it, header, 'label')), link: structuredClone(shown(it, header, 'link')) }));
  if (footer.schema.min !== undefined && copied.length < footer.schema.min) return null;
  const same = (want: (typeof copied)[number], have: MenuItem) => !!have && typeof have === 'object' && want.label === shown(have, footer, 'label') && linkKey(want.link) === linkKey(shown(have, footer, 'link'));
  return {
    op: { type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: footer.node.id, prop: 'links', value: copied },
    count: copied.length,
    replaces: now.length,
    left: top.length - copied.length,
    matches: now.length === copied.length && copied.every((it, i) => same(it, now[i]))
  };
}
