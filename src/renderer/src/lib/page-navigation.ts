/**
 * A page's title, the labels visitors read for it, and the order of the site's menu. A page is named three times
 * over: its title (what Pages and the inspector show), its page heading, and the menu links that go to it. The heading
 * and the links start as copies of the title, so a rename leaves them behind until the author says otherwise. The
 * Pages panel's order and the header menu's order are independent too: moving a page leaves the menu as it was.
 * These are the plans both offers make, as edits that keep every label and link the author chose.
 */
import { isBinding, type InstanceNode, type LinkValue, type OwnerRef, type ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { headerMenu, shellMenu } from '@engine/tree';
import { pageHeadings } from '@generator/checks';

/** A visitor-facing label that still reads as the page's old name. */
export interface RenameLabel {
  /** Names it across revisions, for the checkbox that chooses it. */
  key: string;
  /** Where visitors read it. */
  where: string;
  /** Chosen to update unless the author unticks it. A label that may have been the author's own choice starts unticked. */
  preselect: boolean;
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
export function renameLabels(state: ProjectState, pageId: string, from: string): RenameLabel[] {
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page || !from || page.title === from) return [];
  const to = page.title;
  const out: RenameLabel[] = [];
  const owner: OwnerRef = { kind: 'page', id: pageId };
  // The headings visitors read as the page's title, by the section that shows them (the outline reads spaces as one).
  const words = from.replace(/\s+/g, ' ').trim();
  const titles = new Set(
    pageHeadings(state, pageId, { shell: false })
      .outline.filter((h) => h.level === 1 && h.text === words && h.owner.kind === 'page' && h.owner.id === pageId)
      .map((h) => h.nodeId)
  );
  for (const id of titles) {
    const n = page.nodes[id];
    if (n?.kind !== 'instance' || n.props.heading !== from) continue;
    const def = state.components[n.definitionId];
    if (def?.properties.heading?.type !== 'string') continue;
    out.push({ key: `heading:${id}`, where: `${def.name} heading`, preselect: true, op: { type: 'instance.setProp', owner, nodeId: id, prop: 'heading', value: to } });
  }
  const nav = typeof page.navLabel === 'string' && page.navLabel ? page.navLabel : undefined;
  const chosen = nav !== undefined;
  for (const part of ['header', 'footer'] as const) {
    const menu = shellMenu(state, part);
    const items = menu && menuItems(menu);
    if (!menu || !items) continue;
    const where = part === 'header' ? 'Header menu link' : 'Footer link';
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || item.label !== from || !pageLink(item.link, pageId)) continue;
      out.push({
        key: `${part}:${menu.node.id}:${item.id}`,
        where,
        preselect: !chosen,
        op: { type: 'instance.setProp', owner: { kind: 'shell', id: part }, nodeId: menu.node.id, prop: 'links', itemId: item.id, field: 'label', value: to }
      });
    }
  }
  if (nav === from) out.push({ key: 'navLabel', where: 'Menu label for new menu links', preselect: false, op: { type: 'page.update', pageId, navLabel: '' } });
  return out;
}

/** The header menu's page links, reordered to follow the Pages panel. */
export interface HeaderOrderPlan {
  /** The header's own placement and the edits that reorder its links, one move each. */
  ops: EditOperation[];
  /** The menu's labels as it lists them now, and as it would once the edits apply. */
  before: string[];
  after: string[];
}

/**
 * Reorder the header menu's links to the pages to follow the Pages panel's order. Only links straight to a page that
 * appears once in the menu move, and only among the places such links hold now: a link to another site, an email
 * address, a section of a page, or a page linked twice stays where the author put it, and a page that is not in the
 * menu is not added. Null when there is no menu to reorder or it already follows the pages.
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
  const slots: number[] = [];
  items.forEach((it, i) => {
    const t = target(it);
    if (t && count.get(t) === 1) slots.push(i);
  });
  const sorted = slots.map((i) => items[i]).sort((a, b) => rank.get(target(a)!)! - rank.get(target(b)!)!);
  const desired = [...items];
  slots.forEach((slot, k) => (desired[slot] = sorted[k]));
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
  return { ops, before: items.map(label), after: desired.map(label) };
}

/** Whether the shared header's menu links straight to the page. */
export function inHeaderMenu(state: ProjectState, pageId: string): boolean {
  const menu = headerMenu(state);
  const items = menu && menuItems(menu);
  return !!items?.some((it) => pageLink(it?.link, pageId));
}
