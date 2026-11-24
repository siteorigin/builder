import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { shellMenu } from '@engine/tree';
import { installComponent, makeInstance } from '@engine/install';
import { pageHeadings } from '@generator/checks';
import { headerOrderPlan, inHeaderMenu, renameLabels } from '../../src/renderer/src/lib/page-navigation';

const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const menuOf = (s: ProjectState, part: 'header' | 'footer') => shellMenu(s, part)!.node;
const links = (s: ProjectState, part: 'header' | 'footer') => menuOf(s, part).props.links as Array<{ id: string; label: string; link: { type: string; target: string; anchor?: string } }>;
const labels = (s: ProjectState, part: 'header' | 'footer') => links(s, part).map((l) => l.label);
const pageId = (s: ProjectState, title: string) => s.site.pageOrder.find((id) => s.pages[id].title === title)!;
const intro = (s: ProjectState, id: string) => Object.values(s.pages[id].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'intro.page') as InstanceNode;
const h1 = (s: ProjectState, id: string) => pageHeadings(s, id, { shell: false }).outline.filter((h) => h.level === 1).map((h) => h.text);

/** The issue's page: Lookbook, added with its introduction and Add to header menu checked, then renamed Portfolio. */
function lookbook(edit: (s: ProjectState, id: string) => EditOperation[] = () => []) {
  let s = fresh();
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
