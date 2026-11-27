import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { registerBeside, restorePacks, testPack } from './fixtures/packs';
import { centeredHero, pageIntro } from './fixtures/heading-outline-designs';
import { applyOperations } from '@engine/apply';
import { shellMenu } from '@engine/tree';
import { installComponent, makeInstance } from '@engine/install';
import { pageHeadings } from '@generator/checks';
import { ProjectSession } from '../../src/main/project/session';
import { footerCopyPlan, headerOrderPlan, inHeaderMenu, renameLabels } from '../../src/renderer/src/lib/page-navigation';

/**
 * Foundation's sections under another theme's name, with the page introduction and centered hero designed in the
 * editor: Foundation's are code components, whose headings Builder does not read (the Release gap test below), so the
 * headings a rename leaves behind are tried on these.
 */
const THEME = 'page-navigation-theme';
beforeAll(() => {
  const author = testPack(THEME);
  const designed = ['intro.page', 'hero.centered'];
  const others = getTheme('foundation').components.filter((c) => !designed.includes(c.componentId)).map((c) => author.adopt(c));
  registerBeside(author.define([...others, author.managed(pageIntro('intro.page')), author.managed(centeredHero('hero.centered'))]));
});
afterAll(() => restorePacks());

const fresh = () => createStarterState('business', 'Test Studio', false, THEME);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const menuOf = (s: ProjectState, part: 'header' | 'footer') => shellMenu(s, part)!.node;
const links = (s: ProjectState, part: 'header' | 'footer') => menuOf(s, part).props.links as Array<{ id: string; label: string; link: { type: string; target: string; anchor?: string } }>;
const labels = (s: ProjectState, part: 'header' | 'footer') => links(s, part).map((l) => l.label);
const pageId = (s: ProjectState, title: string) => s.site.pageOrder.find((id) => s.pages[id].title === title)!;
const intro = (s: ProjectState, id: string) => Object.values(s.pages[id].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'intro.page') as InstanceNode;
const h1 = (s: ProjectState, id: string) => pageHeadings(s, id, { shell: false }).outline.filter((h) => h.level === 1).map((h) => h.text);

/** The issue's page: Lookbook, added with its introduction and Add to header menu checked, then renamed Portfolio. */
function lookbook(edit: (s: ProjectState, id: string) => EditOperation[] = () => [], base = fresh) {
  let s = base();
  const r = apply(s, [{ type: 'page.create', title: 'Lookbook', route: '/lookbook/', starter: 'intro', addToNavigation: true }]);
  s = r.state;
  const id = r.results[0].pageId as string;
  const extra = edit(s, id);
  if (extra.length) s = apply(s, extra).state;
  s = apply(s, [{ type: 'page.update', pageId: id, title: 'Portfolio' }]).state;
  return { s, id };
}

describe('labels a page rename leaves behind', () => {
  it('offers the page heading and the header link that still say the old name, and changes only them', () => {
    const { s, id } = lookbook();
    // The issue's repro: Pages says Portfolio while the heading and header link still say Lookbook.
    expect(h1(s, id)).toEqual(['Lookbook']);
    expect(labels(s, 'header')).toEqual(['Home', 'About', 'Contact', 'Lookbook']);
    const found = renameLabels(s, id, 'Lookbook');
    expect(found.map((l) => [l.where, l.preselect])).toEqual([
      ['Page introduction heading', true],
      ['Header menu link', true]
    ]);
    const after = apply(s, found.map((l) => l.op)).state;
    expect(h1(after, id)).toEqual(['Portfolio']);
    expect(labels(after, 'header')).toEqual(['Home', 'About', 'Contact', 'Portfolio']);
    // The address is kept, and the link still goes to the page.
    expect(after.pages[id].route).toBe('/lookbook/');
    expect(links(after, 'header')[3].link).toEqual({ type: 'page', target: id });
    expect(links(after, 'header')[3].id).toBe(links(s, 'header')[3].id);
    // Nothing is left to offer once they match.
    expect(renameLabels(after, id, 'Lookbook')).toEqual([]);
  });

  it('offers the release’s header menu link that still says the old name, and changes only it', () => {
    const { s, id } = lookbook(undefined, () => createStarterState('business', 'Test Studio', false));
    expect(labels(s, 'header')).toEqual(['Home', 'About', 'Contact', 'Lookbook']);
    const found = renameLabels(s, id, 'Lookbook').filter((l) => l.where === 'Header menu link');
    expect(found.map((l) => [l.where, l.preselect])).toEqual([['Header menu link', true]]);
    const after = apply(s, found.map((l) => l.op)).state;
    expect(labels(after, 'header')).toEqual(['Home', 'About', 'Contact', 'Portfolio']);
    expect(links(after, 'header')[3]).toMatchObject({ id: links(s, 'header')[3].id, link: { type: 'page', target: id } });
  });

  it('offers the release’s page introduction heading that still says the old name', () => {
    const { s, id } = lookbook(undefined, () => createStarterState('business', 'Test Studio', false));
    expect(renameLabels(s, id, 'Lookbook').filter((l) => l.where !== 'Header menu link').map((l) => [l.where, l.preselect])).toEqual([['Page introduction heading', true]]);
  });

  it('leaves labels the author changed, even only in case or spacing', () => {
    const { s, id } = lookbook((s, id) => {
      const header = menuOf(s, 'header');
      return [
        { type: 'instance.setProp', owner: { kind: 'page', id }, nodeId: intro(s, id).id, prop: 'heading', value: 'LOOKBOOK' },
        { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', itemId: links(s, 'header')[3].id, field: 'label', value: 'Lookbook ' }
      ];
    });
    expect(renameLabels(s, id, 'Lookbook')).toEqual([]);
  });

  it('offers a footer link labelled with the old name, but no link to a section of the page or to another page', () => {
    const { s, id } = lookbook((s, id) => {
      const footer = menuOf(s, 'footer');
      const header = menuOf(s, 'header');
      return [
        { type: 'instance.listInsert', owner: { kind: 'shell', id: 'footer' }, nodeId: footer.id, prop: 'links', item: { label: 'Lookbook', link: { type: 'page', target: id } } },
        { type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', item: { label: 'Lookbook', link: { type: 'page', target: id, anchor: 'top' } } },
        // The same words on a link to another page name that page.
        { type: 'instance.listInsert', owner: { kind: 'shell', id: 'footer' }, nodeId: footer.id, prop: 'links', item: { label: 'Lookbook', link: { type: 'page', target: pageId(s, 'About') } } }
      ];
    });
    const found = renameLabels(s, id, 'Lookbook');
    expect(found.map((l) => [l.where, l.preselect])).toEqual([
      ['Page introduction heading', true],
      ['Header menu link', true],
      ['Footer link', true]
    ]);
    const after = apply(s, found.map((l) => l.op)).state;
    expect(labels(after, 'footer')).toEqual(['Home', 'About', 'Contact', 'Portfolio', 'Lookbook']);
    expect(links(after, 'footer')[3].link).toEqual({ type: 'page', target: id });
    // The section link keeps its label.
    expect(labels(after, 'header')).toEqual(['Home', 'About', 'Contact', 'Portfolio', 'Lookbook']);
  });

  it('keeps a menu label the page was given on purpose', () => {
    // A menu label of its own names the page's menu links: one that still says the old title is offered, unticked.
    const own = lookbook((_, id) => [{ type: 'page.update', pageId: id, navLabel: 'Looks' }]);
    expect(renameLabels(own.s, own.id, 'Lookbook').map((l) => [l.where, l.preselect])).toEqual([
      ['Page introduction heading', true],
      ['Header menu link', false]
    ]);
    // One that matches the old title is offered, with the links named by it, but unticked.
    const same = lookbook((_, id) => [{ type: 'page.update', pageId: id, navLabel: 'Lookbook' }]);
    const found = renameLabels(same.s, same.id, 'Lookbook');
    expect(found.map((l) => [l.where, l.preselect])).toEqual([
      ['Page introduction heading', true],
      ['Header menu link', false],
      ['Menu label for new menu links', false]
    ]);
    const after = apply(same.s, found.map((l) => l.op)).state;
    expect(after.pages[same.id].navLabel).toBeUndefined();
    expect(labels(after, 'header')[3]).toBe('Portfolio');
  });

  it('offers only a heading that visitors read as the page title, on that page', () => {
    const { s, id } = lookbook((s, id) => [{ type: 'instance.setProp', owner: { kind: 'page', id }, nodeId: intro(s, id).id, prop: 'headingLevel', value: 'h2' }]);
    expect(renameLabels(s, id, 'Lookbook').map((l) => l.where)).toEqual(['Header menu link']);
    // Another page's heading with the same words is that page's own.
    const other = apply(s, [{ type: 'page.create', title: 'Lookbook', route: '/lookbook-2/', starter: 'intro' }]).state;
    expect(renameLabels(other, id, 'Lookbook').map((l) => l.where)).toEqual(['Header menu link']);
  });

  it('offers nothing when the title did not change or the page is gone', () => {
    const { s, id } = lookbook();
    const matched = apply(s, renameLabels(s, id, 'Lookbook').map((l) => l.op)).state;
    // Every label says the title: renaming it to itself has nothing to bring along.
    expect(renameLabels(matched, id, 'Portfolio')).toEqual([]);
    expect(renameLabels(s, 'pg_missing', 'Lookbook')).toEqual([]);
  });

  it('offers labels with any of the page’s old names, saying which each one holds', () => {
    // The title was changed elsewhere to Team (and the header link with it) before the author's rename replaced it.
    const { s, id } = lookbook((s) => [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: menuOf(s, 'header').id, prop: 'links', itemId: links(s, 'header')[3].id, field: 'label', value: 'Team' }]);
    expect(renameLabels(s, id, 'Lookbook').map((l) => [l.where, l.text])).toEqual([['Page introduction heading', 'Lookbook']]);
    const found = renameLabels(s, id, ['Lookbook', 'Team']);
    expect(found.map((l) => [l.where, l.text])).toEqual([
      ['Page introduction heading', 'Lookbook'],
      ['Header menu link', 'Team']
    ]);
    expect(labels(apply(s, found.map((l) => l.op)).state, 'header')[3]).toBe('Portfolio');
    // The current title is never an old name.
    expect(renameLabels(s, id, ['Portfolio'])).toEqual([]);
    // A section whose Heading 1 says one old name while its heading field, shown smaller, holds the other: the field is
    // not the page's title. (Its design shows the eyebrow as the Heading 1 here.)
    const crossed = apply(s, [
      { type: 'instance.setProp', owner: { kind: 'page', id }, nodeId: intro(s, id).id, prop: 'headingLevel', value: 'h2' },
      { type: 'instance.setProp', owner: { kind: 'page', id }, nodeId: intro(s, id).id, prop: 'eyebrow', value: 'Team' }
    ]).state;
    const tree = crossed.components[intro(crossed, id).definitionId].tree!;
    const eyebrow = Object.values(tree.nodes).find((n) => n.name === 'Eyebrow') as { tag: string };
    eyebrow.tag = 'h1';
    expect(h1(crossed, id)).toEqual(['Team']);
    expect(renameLabels(crossed, id, ['Lookbook', 'Team']).map((l) => l.where)).toEqual(['Header menu link']);
  });

  it('finds a title written with doubled spaces, and a hero’s Heading 1 as well as an introduction’s', () => {
    let s = apply(fresh(), [{ type: 'page.create', title: 'Case  Studies', route: '/case-studies/', starter: 'intro', pageId: 'pg_cases01' }]).state;
    s = apply(s, [{ type: 'page.update', pageId: 'pg_cases01', title: 'Projects' }]).state;
    expect(renameLabels(s, 'pg_cases01', 'Case  Studies').map((l) => l.where)).toEqual(['Page introduction heading']);
    // A page whose Heading 1 is a hero's, written the same as the title.
    s = apply(fresh(), [{ type: 'page.create', title: 'Lookbook', route: '/lookbook/', starter: 'empty', pageId: 'pg_looks01' }]).state;
    const hero = makeInstance(s.components[installComponent(s, 'hero.centered')], { heading: 'Lookbook' });
    s.pages.pg_looks01.nodes[hero.id] = hero;
    s.pages.pg_looks01.rootIds.push(hero.id);
    s = apply(s, [{ type: 'page.update', pageId: 'pg_looks01', title: 'Portfolio' }]).state;
    const found = renameLabels(s, 'pg_looks01', 'Lookbook');
    expect(found.map((l) => [l.where, l.preselect])).toEqual([['Centered hero heading', true]]);
    expect(h1(apply(s, found.map((l) => l.op)).state, 'pg_looks01')).toEqual(['Portfolio']);
  });
});

describe('the header menu’s order beside the Pages order', () => {
  /** The issue's setup: a fourth page added to the header menu, then moved above Contact in Pages. */
  function moved(edit: (s: ProjectState, ids: Record<string, string>) => EditOperation[] = () => []) {
    let s = apply(fresh(), [{ type: 'page.create', title: 'Gallery', starter: 'intro', addToNavigation: true }]).state;
    const ids = { home: pageId(s, 'Home'), about: pageId(s, 'About'), contact: pageId(s, 'Contact'), gallery: pageId(s, 'Gallery') };
    const extra = edit(s, ids);
    if (extra.length) s = apply(s, extra).state;
    const order = s.site.pageOrder.filter((x) => x !== ids.gallery);
    order.splice(order.indexOf(ids.contact), 0, ids.gallery);
    s = apply(s, [{ type: 'page.reorder', pageIds: order }]).state;
    return { s, ids };
  }

  it('moves only the menu when asked, keeping each link as it was', () => {
    const { s, ids } = moved();
    // Moving the page changed Pages, not the menu.
    expect(s.site.pageOrder.map((id) => s.pages[id].title)).toEqual(['Home', 'About', 'Gallery', 'Contact']);
    expect(labels(s, 'header')).toEqual(['Home', 'About', 'Contact', 'Gallery']);
    expect(inHeaderMenu(s, ids.gallery)).toBe(true);
    const plan = headerOrderPlan(s)!;
    expect(plan.before).toEqual(['Home', 'About', 'Contact', 'Gallery']);
    expect(plan.after).toEqual(['Home', 'About', 'Gallery', 'Contact']);
    const before = links(s, 'header');
    const after = apply(s, plan.ops).state;
    expect(links(after, 'header')).toEqual([before[0], before[1], before[3], before[2]]);
    // The footer keeps its own order, and Pages is as it was.
    expect(labels(after, 'footer')).toEqual(labels(s, 'footer'));
    expect(after.site.pageOrder).toEqual(s.site.pageOrder);
    expect(headerOrderPlan(after)).toBeNull();
  });

  it('keeps an external link in its place and leaves out a page that is not in the menu', () => {
    const { s, ids } = moved((s, ids) => {
      const header = menuOf(s, 'header');
      // Notes is a page of its own outside the menu, between Home and About in Pages.
      const order = [...s.site.pageOrder];
      return [
        { type: 'page.create', title: 'Notes', starter: 'empty', pageId: 'pg_notes01' },
        { type: 'page.reorder', pageIds: [order[0], 'pg_notes01', ...order.slice(1)] },
        { type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', index: 2, item: { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } } },
        // A custom label goes with its link.
        { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', itemId: links(s, 'header')[3].id, field: 'label', value: 'Our work' }
      ];
    });
    expect(s.site.pageOrder.map((id) => s.pages[id].title)).toEqual(['Home', 'Notes', 'About', 'Gallery', 'Contact']);
    expect(labels(s, 'header')).toEqual(['Home', 'About', 'Shop', 'Contact', 'Our work']);
    const plan = headerOrderPlan(s)!;
    expect(plan.after).toEqual(['Home', 'About', 'Shop', 'Our work', 'Contact']);
    const after = apply(s, plan.ops).state;
    expect(labels(after, 'header')).toEqual(['Home', 'About', 'Shop', 'Our work', 'Contact']);
    expect(links(after, 'header')[3].link).toEqual({ type: 'page', target: ids.gallery });
    expect(links(after, 'header')[2].link).toEqual({ type: 'url', target: 'https://shop.example.com' });
    expect(inHeaderMenu(after, 'pg_notes01')).toBe(false);
    expect(ids.home).toBe(links(after, 'header')[0].link.target);
  });

  it('puts a menu in any order back into the order of Pages', () => {
    let s = apply(fresh(), [{ type: 'page.create', title: 'Gallery', starter: 'intro', addToNavigation: true }]).state;
    const header = menuOf(s, 'header');
    const [home, about, contact, gallery] = links(s, 'header');
    const move = (itemId: string, index: number): EditOperation => ({ type: 'instance.listMove', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', itemId, index });
    s = apply(s, [move(gallery.id, 0), move(home.id, 2)]).state;
    expect(labels(s, 'header')).toEqual(['Gallery', 'About', 'Home', 'Contact']);
    expect(labels(apply(s, headerOrderPlan(s)!.ops).state, 'header')).toEqual(['Home', 'About', 'Contact', 'Gallery']);
    expect(links(apply(s, headerOrderPlan(s)!.ops).state, 'header').map((l) => l.id)).toEqual([home.id, about.id, contact.id, gallery.id]);
  });

  it('swaps page links across a link that stays put', () => {
    let s = fresh();
    const header = menuOf(s, 'header');
    const [home, about, contact] = links(s, 'header');
    s = apply(s, [
      { type: 'instance.listMove', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', itemId: contact.id, index: 1 },
      { type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', index: 2, item: { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } } }
    ]).state;
    expect(labels(s, 'header')).toEqual(['Home', 'Contact', 'Shop', 'About']);
    const after = apply(s, headerOrderPlan(s)!.ops).state;
    expect(labels(after, 'header')).toEqual(['Home', 'About', 'Shop', 'Contact']);
    expect(links(after, 'header').map((l) => l.id)).toEqual([home.id, about.id, links(s, 'header')[2].id, contact.id]);
  });

  it('leaves a page linked twice and a link to a section where they are', () => {
    const { s } = moved((s, ids) => {
      const header = menuOf(s, 'header');
      return [
        { type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', index: 0, item: { label: 'Visit', link: { type: 'page', target: ids.contact, anchor: 'map' } } },
        { type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', item: { label: 'Home again', link: { type: 'page', target: ids.home } } }
      ];
    });
    expect(labels(s, 'header')).toEqual(['Visit', 'Home', 'About', 'Contact', 'Gallery', 'Home again']);
    const after = apply(s, headerOrderPlan(s)!.ops).state;
    expect(labels(after, 'header')).toEqual(['Visit', 'Home', 'About', 'Gallery', 'Contact', 'Home again']);
  });

  it('counts only a link straight to the page as the page being in the menu', () => {
    let s = apply(fresh(), [{ type: 'page.create', title: 'Notes', starter: 'empty', pageId: 'pg_notes01' }]).state;
    const header = menuOf(s, 'header');
    s = apply(s, [{ type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', item: { label: 'Notes', link: { type: 'page', target: 'pg_notes01', anchor: 'latest' } } }]).state;
    expect(inHeaderMenu(s, 'pg_notes01')).toBe(false);
  });

  it('leaves a menu with a row that has no ID as it is', () => {
    let s = fresh();
    const order = s.site.pageOrder;
    s = apply(s, [{ type: 'page.reorder', pageIds: [order[0], order[2], order[1]] }]).state;
    expect(headerOrderPlan(s)).not.toBeNull();
    // A document written by hand: a link with no ID cannot be named by an edit.
    (menuOf(s, 'header').props.links as unknown[]).splice(1, 0, { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } });
    expect(headerOrderPlan(s)).toBeNull();
  });

  it('has nothing to do when the menu already follows the pages, or there is no menu', () => {
    expect(headerOrderPlan(fresh())).toBeNull();
    // A page outside the menu moving changes nothing the menu shows.
    let s = apply(fresh(), [{ type: 'page.create', title: 'Notes', starter: 'empty' }]).state;
    const notes = pageId(s, 'Notes');
    s = apply(s, [{ type: 'page.reorder', pageIds: [notes, ...s.site.pageOrder.filter((x) => x !== notes)] }]).state;
    expect(inHeaderMenu(s, notes)).toBe(false);
    expect(headerOrderPlan(s)).toBeNull();
    const header = s.site.shell.header;
    s = apply(s, [{ type: 'node.remove', owner: { kind: 'shell', id: 'header' }, nodeId: header.rootIds[0] }]).state;
    expect(headerOrderPlan(s)).toBeNull();
  });
});

describe('the header menu’s order with child pages in submenus', () => {
  /** The business starter with a Lookbook page in the header menu, and Kitchens and Baths inside it, in its submenu. */
  function lookbookMenu(): ProjectState {
    return apply(fresh(), [
      { type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook', addToNavigation: true },
      { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/lookbook/kitchens/', addToNavigation: true },
      { type: 'page.create', pageId: 'pg_baths001', title: 'Baths', route: '/lookbook/baths/', addToNavigation: true }
    ]).state;
  }
  const rows = (s: ProjectState) => (menuOf(s, 'header').props.links as Array<{ label: string; sub?: boolean }>).map((l) => `${l.sub ? '  ' : ''}${l.label}`);
  const titles = (s: ProjectState) => s.site.pageOrder.map((id) => s.pages[id].title);
  const reorder = (s: ProjectState, order: string[]) => apply(s, [{ type: 'page.reorder', pageIds: order.map((t) => pageId(s, t)) }]).state;

  it('brings a section’s submenu along when the section moves with its pages', () => {
    let s = lookbookMenu();
    expect(rows(s)).toEqual(['Home', 'About', 'Contact', 'Lookbook', '  Kitchens', '  Baths']);
    // Pages moves Lookbook up with the pages inside it.
    s = reorder(s, ['Home', 'Lookbook', 'Kitchens', 'Baths', 'About', 'Contact']);
    expect(inHeaderMenu(s, 'pg_lookbook')).toBe(true);
    const plan = headerOrderPlan(s)!;
    expect(plan.before).toEqual(['Home', 'About', 'Contact', 'Lookbook (Kitchens, Baths)']);
    expect(plan.after).toEqual(['Home', 'Lookbook (Kitchens, Baths)', 'About', 'Contact']);
    const after = apply(s, plan.ops).state;
    expect(rows(after)).toEqual(['Home', 'Lookbook', '  Kitchens', '  Baths', 'About', 'Contact']);
    expect(titles(after)).toEqual(titles(s));
    expect(headerOrderPlan(after)).toBeNull();
  });

  it('reorders a child page’s link within its submenu', () => {
    let s = lookbookMenu();
    s = reorder(s, ['Home', 'About', 'Contact', 'Lookbook', 'Baths', 'Kitchens']);
    expect(inHeaderMenu(s, 'pg_baths001')).toBe(true);
    const plan = headerOrderPlan(s)!;
    expect(plan.after).toEqual(['Home', 'About', 'Contact', 'Lookbook (Baths, Kitchens)']);
    const after = apply(s, plan.ops).state;
    expect(rows(after)).toEqual(['Home', 'About', 'Contact', 'Lookbook', '  Baths', '  Kitchens']);
    expect(headerOrderPlan(after)).toBeNull();
  });

  it('never takes a link out of its submenu, or puts one into another', () => {
    let s = lookbookMenu();
    // Pages lists Baths apart from Lookbook, first after Home: its link stays in Lookbook’s submenu, first there.
    s = reorder(s, ['Home', 'Baths', 'About', 'Contact', 'Lookbook', 'Kitchens']);
    const after = apply(s, headerOrderPlan(s)!.ops).state;
    expect(rows(after)).toEqual(['Home', 'About', 'Contact', 'Lookbook', '  Baths', '  Kitchens']);
    // A first link marked to go under the one above shows at the top level only while it is first, so it stays first.
    let t = fresh();
    const header = menuOf(t, 'header');
    const [home, about, contact] = links(t, 'header');
    header.props.links = [{ ...about, label: 'Our studio', sub: true }, contact, home];
    expect(rows(t)).toEqual(['  Our studio', 'Contact', 'Home']);
    t = apply(t, headerOrderPlan(t)!.ops).state;
    expect(rows(t)).toEqual(['  Our studio', 'Home', 'Contact']);
    expect(headerOrderPlan(t)).toBeNull();
  });
});

describe('the footer’s links copied from the header menu (#575)', () => {
  const shell = (part: 'header' | 'footer') => ({ kind: 'shell' as const, id: part });
  /** Each link as visitors read it: its label and where it goes. */
  const shown = (s: ProjectState, part: 'header' | 'footer') => links(s, part).map((l) => ({ label: l.label, link: l.link }));
  /** The issue's site: built from scratch, with About and Contact added from Pages with Add to header menu checked. */
  function scratchSite(more: EditOperation[] = []) {
    return apply(createStarterState('blank', 'Test Studio', false), [
      { type: 'page.create', pageId: 'pg_about001', title: 'About', addToNavigation: true },
      { type: 'page.create', pageId: 'pg_contact1', title: 'Contact', addToNavigation: true },
      ...more
    ]).state;
  }

  it('replaces the footer’s links with the header’s, labels and destinations alike, in one edit', () => {
    const s = scratchSite();
    // The footer still has only its first Home link, while the header lists every page.
    expect(labels(s, 'footer')).toEqual(['Home']);
    expect(labels(s, 'header')).toEqual(['Home', 'About', 'Contact']);
    const plan = footerCopyPlan(s)!;
    expect(plan).toMatchObject({ count: 3, replaces: 1, left: 0, matches: false });
    const after = apply(s, [plan.op]).state;
    expect(shown(after, 'footer')).toEqual(shown(s, 'header'));
    expect(links(after, 'footer').map((l) => l.link)).toEqual([s.site.homePageId, 'pg_about001', 'pg_contact1'].map((target) => ({ type: 'page', target })));
    // Each is the footer's own row: editing one never edits the header's.
    const ids = links(after, 'footer').map((l) => l.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.some((id) => links(s, 'header').some((h) => h.id === id))).toBe(false);
    expect(links(after, 'header')).toEqual(links(s, 'header'));
    // Once they match there is nothing new to copy.
    expect(footerCopyPlan(after)).toMatchObject({ count: 3, replaces: 3, matches: true });
  });

  it('replaces links the author added by hand, and copies only the top-level links, not the ones in a submenu', () => {
    let s = scratchSite([
      { type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook', addToNavigation: true },
      { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/lookbook/kitchens/', addToNavigation: true }
    ]);
    s = apply(s, [{ type: 'instance.listInsert', owner: shell('footer'), nodeId: menuOf(s, 'footer').id, prop: 'links', item: { label: 'Press', link: { type: 'url', target: 'https://press.example.com' } } }]).state;
    expect(links(s, 'header').map((l) => [l.label, !!(l as { sub?: boolean }).sub])).toEqual([
      ['Home', false],
      ['About', false],
      ['Contact', false],
      ['Lookbook', false],
      ['Kitchens', true]
    ]);
    expect(footerCopyPlan(s)).toMatchObject({ count: 4, replaces: 2 });
    const after = apply(s, [footerCopyPlan(s)!.op]).state;
    expect(labels(after, 'footer')).toEqual(['Home', 'About', 'Contact', 'Lookbook']);
    // The footer's rows have no submenu switch to carry.
    expect(links(after, 'footer').every((l) => !Object.hasOwn(l, 'sub'))).toBe(true);
  });

  it('copies a first link marked for a submenu, which the header shows at the top level', () => {
    let s = scratchSite();
    s = apply(s, [{ type: 'instance.setProp', owner: shell('header'), nodeId: menuOf(s, 'header').id, prop: 'links', itemId: links(s, 'header')[0].id, field: 'sub', value: true }]).state;
    expect((links(s, 'header')[0] as { sub?: boolean }).sub).toBe(true);
    expect(labels(apply(s, [footerCopyPlan(s)!.op]).state, 'footer')).toEqual(['Home', 'About', 'Contact']);
  });

  it('keeps an external link, a link to a section and a label the author wrote, exactly as the header has them', () => {
    let s = scratchSite();
    const header = menuOf(s, 'header');
    s = apply(s, [
      { type: 'instance.setProp', owner: shell('header'), nodeId: header.id, prop: 'links', itemId: links(s, 'header')[1].id, field: 'label', value: 'Our story' },
      { type: 'instance.listInsert', owner: shell('header'), nodeId: header.id, prop: 'links', item: { label: 'Team', link: { type: 'page', target: 'pg_about001', anchor: 'team' } } },
      { type: 'instance.listInsert', owner: shell('header'), nodeId: header.id, prop: 'links', item: { label: '', link: { type: 'url', target: 'https://shop.example.com', newTab: true } } }
    ]).state;
    const after = apply(s, [footerCopyPlan(s)!.op]).state;
    expect(shown(after, 'footer')).toEqual([
      { label: 'Home', link: { type: 'page', target: s.site.homePageId } },
      { label: 'Our story', link: { type: 'page', target: 'pg_about001' } },
      { label: 'Contact', link: { type: 'page', target: 'pg_contact1' } },
      { label: 'Team', link: { type: 'page', target: 'pg_about001', anchor: 'team' } },
      { label: '', link: { type: 'url', target: 'https://shop.example.com', newTab: true } }
    ]);
    expect(shown(after, 'footer')).toEqual(shown(s, 'header'));
    expect(footerCopyPlan(after)!.matches).toBe(true);
  });

  it('does not count a footer with the same links in another order, or other labels, as matching', () => {
    const s = scratchSite();
    const copied = apply(s, [footerCopyPlan(s)!.op]).state;
    const footer = menuOf(copied, 'footer');
    const moved = apply(copied, [{ type: 'instance.listMove', owner: shell('footer'), nodeId: footer.id, prop: 'links', itemId: links(copied, 'footer')[2].id, index: 0 }]).state;
    expect(footerCopyPlan(moved)!.matches).toBe(false);
    const renamed = apply(copied, [{ type: 'instance.setProp', owner: shell('footer'), nodeId: footer.id, prop: 'links', itemId: links(copied, 'footer')[1].id, field: 'label', value: 'Who we are' }]).state;
    expect(footerCopyPlan(renamed)!.matches).toBe(false);
    // The same labels in the same order, but one goes somewhere else.
    const elsewhere = apply(copied, [{ type: 'instance.setProp', owner: shell('footer'), nodeId: footer.id, prop: 'links', itemId: links(copied, 'footer')[1].id, field: 'link', value: { type: 'page', target: 'pg_contact1' } }]).state;
    expect(labels(elsewhere, 'footer')).toEqual(labels(s, 'header'));
    expect(footerCopyPlan(elsewhere)!.matches).toBe(false);
  });

  it('counts a footer link that says something else about the same site as different, and copies what the header says (#582)', () => {
    let s = scratchSite();
    const shop = { type: 'url', target: 'https://shop.example.com' };
    s = apply(s, [{ type: 'instance.listInsert', owner: shell('header'), nodeId: menuOf(s, 'header').id, prop: 'links', item: { label: 'Shop', link: { ...shop, rel: ['ugc', 'sponsored'] } } }]).state;
    const copied = apply(s, [footerCopyPlan(s)!.op]).state;
    expect(links(copied, 'footer')[3].link).toEqual({ ...shop, rel: ['sponsored', 'ugc'] });
    expect(footerCopyPlan(copied)!.matches).toBe(true);
    const footer = menuOf(copied, 'footer');
    const plain = apply(copied, [{ type: 'instance.setProp', owner: shell('footer'), nodeId: footer.id, prop: 'links', itemId: links(copied, 'footer')[3].id, field: 'link', value: shop }]).state;
    expect(footerCopyPlan(plain)!.matches).toBe(false);
  });

  it('counts a link written with options it does not use as the same link once copied', () => {
    // A header written outside the app, its link saying newTab: false and an empty section.
    const s = structuredClone(scratchSite());
    (links(s, 'header')[1].link as Record<string, unknown>).newTab = false;
    (links(s, 'header')[1].link as Record<string, unknown>).anchor = '';
    const after = apply(s, [footerCopyPlan(s)!.op]).state;
    expect(links(after, 'footer')[1].link).toEqual({ type: 'page', target: 'pg_about001' });
    expect(footerCopyPlan(after)!.matches).toBe(true);
  });

  it('counts a section link on the same page written with its # as the same once copied', () => {
    let s = scratchSite();
    s = apply(s, [{ type: 'instance.listInsert', owner: shell('header'), nodeId: menuOf(s, 'header').id, prop: 'links', item: { label: 'Team', link: { type: 'anchor', target: 'team' } } }]).state;
    s = structuredClone(s);
    (links(s, 'header')[3].link as Record<string, unknown>).target = '#team';
    const after = apply(s, [footerCopyPlan(s)!.op]).state;
    expect(links(after, 'footer')[3].link).toEqual({ type: 'anchor', target: 'team' });
    expect(footerCopyPlan(after)!.matches).toBe(true);
  });

  it('never counts a footer link written outside the app that goes nowhere as its header link', () => {
    const s = scratchSite();
    const copied = structuredClone(apply(s, [footerCopyPlan(s)!.op]).state);
    // A page ID with a space after it names no page: the copy can put it right.
    (links(copied, 'footer')[1].link as Record<string, unknown>).target = 'pg_about001 ';
    expect(footerCopyPlan(copied)!.matches).toBe(false);
    (links(copied, 'footer')[1].link as Record<string, unknown>).target = ['pg_about001'];
    expect(footerCopyPlan(copied)!.matches).toBe(false);
    // Nor a link that is not an object, shaped like the header link's parts.
    links(copied, 'footer')[1].link = ['page', 'pg_about001', '', false] as never;
    expect(footerCopyPlan(copied)!.matches).toBe(false);
  });

  it('counts a header link to nowhere, written with options it cannot use, as the same once copied', () => {
    let s = scratchSite();
    s = apply(s, [{ type: 'instance.listInsert', owner: shell('header'), nodeId: menuOf(s, 'header').id, prop: 'links', item: { label: 'Soon' } }]).state;
    s = structuredClone(s);
    links(s, 'header')[3].link = { type: 'none', target: 'later', anchor: 'top', newTab: true } as never;
    const after = apply(s, [footerCopyPlan(s)!.op]).state;
    expect(links(after, 'footer')[3].link).toEqual({ type: 'none', target: '' });
    expect(footerCopyPlan(after)!.matches).toBe(true);
  });

  it('reads a header without a list of its own, and a link without a label, as the header shows them', () => {
    const s = structuredClone(scratchSite());
    const header = menuOf(s, 'header');
    const schema = s.components[header.definitionId].properties.links as { default: unknown; fields: Record<string, { default?: unknown }> };
    // The header's own list is unset: it shows its design's links.
    delete header.props.links;
    schema.default = [
      { id: 'd1', label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } },
      { id: 'd2', link: { type: 'page', target: 'pg_about001' } }
    ];
    const plan = footerCopyPlan(s)!;
    expect(plan).toMatchObject({ count: 2, replaces: 1 });
    expect(shown(apply(s, [plan.op]).state, 'footer')).toEqual([
      { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } },
      { label: schema.fields.label.default, link: { type: 'page', target: 'pg_about001' } }
    ]);
  });

  it('takes the first links a footer can hold when the header shows more', () => {
    const s = structuredClone(scratchSite());
    const footer = s.components[menuOf(s, 'footer').definitionId].properties.links as { max?: number };
    footer.max = 2;
    const plan = footerCopyPlan(s)!;
    expect(plan).toMatchObject({ count: 2, left: 1 });
    expect(labels(apply(s, [plan.op]).state, 'footer')).toEqual(['Home', 'About']);
  });

  it('replaces a footer that is already full', () => {
    let s = structuredClone(scratchSite());
    (s.components[menuOf(s, 'footer').definitionId].properties.links as { max?: number }).max = 2;
    s = apply(s, [{ type: 'instance.listInsert', owner: shell('footer'), nodeId: menuOf(s, 'footer').id, prop: 'links', item: { label: 'Press', link: { type: 'url', target: 'https://press.example.com' } } }]).state;
    expect(labels(s, 'footer')).toEqual(['Home', 'Press']);
    const plan = footerCopyPlan(s)!;
    expect(plan).toMatchObject({ count: 2, replaces: 2, left: 1, matches: false });
    expect(labels(apply(s, [plan.op]).state, 'footer')).toEqual(['Home', 'About']);
  });

  it('has nothing to copy without a header link at the top level, without a footer menu, or from a list set elsewhere', () => {
    let s = scratchSite();
    s = apply(s, [{ type: 'instance.setProp', owner: shell('header'), nodeId: menuOf(s, 'header').id, prop: 'links', value: [] }]).state;
    expect(footerCopyPlan(s)).toBeNull();
    const noFooter = structuredClone(scratchSite());
    noFooter.site.shell.footer.rootIds = [];
    expect(footerCopyPlan(noFooter)).toBeNull();
    const bound = structuredClone(scratchSite());
    menuOf(bound, 'footer').props.links = { $prop: 'links' };
    expect(footerCopyPlan(bound)).toBeNull();
  });

  describe('in a project', () => {
    const dirs: string[] = [];
    const open: ProjectSession[] = [];
    afterEach(async () => {
      for (const s of open.splice(0)) await s.close().catch(() => undefined);
      dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
    });
    async function session() {
      const dir = mkdtempSync(join(tmpdir(), 'so-footer-copy-'));
      dirs.push(dir);
      const s = await ProjectSession.create(dir, scratchSite());
      open.push(s);
      return s;
    }
    const LABEL = 'Copy header menu to footer links';
    const applied = (s: ProjectSession) => s.historyInfo().entries.filter((e) => e.applied);

    it('is one step in History, and Undo brings the footer’s own links back', async () => {
      const s = await session();
      const before = structuredClone(links(s.state, 'footer'));
      const was = applied(s).length;
      const r = await s.apply({ operations: [footerCopyPlan(s.state)!.op], expectedRevision: s.revision }, { label: LABEL });
      expect(r.ok).toBe(true);
      expect(shown(s.state, 'footer')).toEqual(shown(s.state, 'header'));
      expect(applied(s).length).toBe(was + 1);
      expect(applied(s).at(-1)?.label).toBe(LABEL);
      expect((await s.undo()).ok).toBe(true);
      expect(links(s.state, 'footer')).toEqual(before);
      expect((await s.redo()).ok).toBe(true);
      expect(shown(s.state, 'footer')).toEqual(shown(s.state, 'header'));
    });

    it('is refused, changing nothing, when the footer changed after the copy was planned', async () => {
      const s = await session();
      const plan = footerCopyPlan(s.state)!;
      const planned = s.revision;
      const footer = menuOf(s.state, 'footer');
      expect((await s.apply({ operations: [{ type: 'instance.setProp', owner: shell('footer'), nodeId: footer.id, prop: 'links', itemId: links(s.state, 'footer')[0].id, field: 'label', value: 'Start' }] }, { label: 'Edit Footer link' })).ok).toBe(true);
      const r = await s.apply({ operations: [plan.op], expectedRevision: planned }, { label: LABEL });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('STALE_REVISION');
      expect(applied(s).at(-1)?.label).toBe('Edit Footer link');
      expect(labels(s.state, 'footer')).toEqual(['Start']);
    });
  });
});
