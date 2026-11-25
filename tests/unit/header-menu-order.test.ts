import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { shellMenu } from '@engine/tree';
import { dropHeaderLinks, headerOrder, keepHeaderOrder, menuBefore } from '@engine/header-order';
import { pagesTouched } from '../../src/agent/report';
import { ProjectSession } from '../../src/main/project/session';
import { headerOrderPlan, headerOrderPreview } from '../../src/renderer/src/lib/page-navigation';
import { NEW_HOME, planPageRemoval, reviewPageRemoval } from '../../src/renderer/src/lib/page-removal';

type Row = { id: string; label: string; sub?: boolean; link: { type: string; target: string; anchor?: string } };
const HEADER: OwnerRef = { kind: 'shell', id: 'header' };
const FOOTER: OwnerRef = { kind: 'shell', id: 'footer' };
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const menuOf = (s: ProjectState, part: 'header' | 'footer' = 'header') => shellMenu(s, part)!.node;
const links = (s: ProjectState, part: 'header' | 'footer' = 'header') => menuOf(s, part).props.links as Row[];
/** The menu as it reads, a link in a submenu indented. */
const rows = (s: ProjectState) => links(s).map((l) => `${l.sub ? '  ' : ''}${l.label}`);
const titles = (s: ProjectState) => s.site.pageOrder.map((id) => s.pages[id].title);
const pageId = (s: ProjectState, title: string) => s.site.pageOrder.find((id) => s.pages[id].title === title)!;
const reorder = (s: ProjectState, order: string[]): EditOperation => ({ type: 'page.reorder', pageIds: order.map((t) => pageId(s, t)) });
const follow: EditOperation = { type: 'site.update', headerMenuOrder: 'follow' };
const own: EditOperation = { type: 'site.update', headerMenuOrder: 'own' };
const insert = (s: ProjectState, item: Record<string, unknown>, index?: number): EditOperation => ({ type: 'instance.listInsert', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', ...(index === undefined ? {} : { index }), item });
const moveRow = (s: ProjectState, label: string, index: number): EditOperation => ({ type: 'instance.listMove', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: links(s).find((l) => l.label === label)!.id, index });
/** No footer links, so deleting a page asks for a replacement only for what the test puts elsewhere. */
const noFooter = (s: ProjectState): EditOperation => ({ type: 'instance.setProp', owner: FOOTER, nodeId: menuOf(s, 'footer').id, prop: 'links', value: [] });

/**
 * The business starter (Home, About, Contact, each in the header menu) with Services and Lookbook pages, Lookbook's
 * Kitchens and Baths in its submenu, a Shop link to another site after About, and a link to About's team section.
 */
function site(): ProjectState {
  let s = createStarterState('business', 'Test Studio', false);
  s = apply(s, [
    { type: 'page.create', pageId: 'pg_services', title: 'Services', addToNavigation: true },
    { type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook', addToNavigation: true },
    { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/lookbook/kitchens/', addToNavigation: true },
    { type: 'page.create', pageId: 'pg_baths001', title: 'Baths', route: '/lookbook/baths/', addToNavigation: true }
  ]);
  s = apply(s, [insert(s, { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } }, 2), noFooter(s)]);
  return s;
}

describe('the header menu order setting (#749)', () => {
  it('is saved with the site only while the menu follows the pages', () => {
    let s = site();
    expect(s.site.headerMenuOrder).toBeUndefined();
    s = apply(s, [follow]);
    expect(s.site.headerMenuOrder).toBe('follow');
    s = apply(s, [own]);
    expect('headerMenuOrder' in s.site).toBe(false);
  });

  it('reorders the page links at once on switching to Follow page order, keeping the rest in place', () => {
    let s = site();
    s = apply(s, [reorder(s, ['Home', 'Lookbook', 'Baths', 'Kitchens', 'Contact', 'About', 'Services'])]);
    // Own order: Pages moved, the menu did not.
    expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', '  Kitchens', '  Baths']);
    const ids = links(s).map((l) => l.id);
    // What the switch is shown before it is made.
    expect(headerOrderPreview(s)).toEqual({ before: ['Home', 'About', 'Shop', 'Contact', 'Services', 'Lookbook (Kitchens, Baths)'], after: ['Home', 'Lookbook (Baths, Kitchens)', 'Shop', 'Contact', 'About', 'Services'], changed: true });
    const after = apply(s, [follow]);
    expect(rows(after)).toEqual(['Home', 'Lookbook', '  Baths', '  Kitchens', 'Shop', 'Contact', 'About', 'Services']);
    // The same rows, moved: IDs and links kept.
    // The same rows, moved: each keeps its own ID.
    const idOf = new Map(links(s).map((l) => [l.label, l.id]));
    expect(links(after).map((l) => l.id)).toEqual(links(after).map((l) => idOf.get(l.label)));
    // Each row keeps its own destination too.
    const linkOf = new Map(links(s).map((l) => [l.label, l.link]));
    expect(links(after).map((l) => l.link)).toEqual(links(after).map((l) => linkOf.get(l.label)));
    expect(links(after).map((l) => l.id).sort()).toEqual([...ids].sort());
    expect(links(after).find((l) => l.label === 'Shop')!.link).toEqual({ type: 'url', target: 'https://shop.example.com' });
  });

  it('changes nothing but the setting when the menu already follows the pages', () => {
    const s = site();
    expect(headerOrderPreview(s)!.changed).toBe(false);
    const after = apply(s, [follow]);
    expect(links(after)).toEqual(links(s));
  });

  describe('while following', () => {
    const following = () => apply(site(), [follow]);

    it('moves the menu’s page links with any reorder, in the same change', () => {
      let s = following();
      s = apply(s, [reorder(s, ['Home', 'Services', 'About', 'Lookbook', 'Kitchens', 'Baths', 'Contact'])]);
      expect(rows(s)).toEqual(['Home', 'Services', 'Shop', 'About', 'Lookbook', '  Kitchens', '  Baths', 'Contact']);
      // Then Contact last, and Baths above Kitchens: the submenu sorts within itself.
      s = apply(s, [reorder(s, ['Home', 'Services', 'About', 'Lookbook', 'Baths', 'Kitchens', 'Contact'])]);
      expect(rows(s)).toEqual(['Home', 'Services', 'Shop', 'About', 'Lookbook', '  Baths', '  Kitchens', 'Contact']);
      expect(headerOrderPlan(s)).toBeNull();
    });

    it('leaves a page linked twice, a link to a section and a link to another site where they are', () => {
      let s = following();
      s = apply(s, [
        insert(s, { label: 'Team', link: { type: 'page', target: pageId(s, 'About'), anchor: 'team' } }, 1),
        insert(s, { label: 'Contact us', link: { type: 'page', target: pageId(s, 'Contact') } }, 0)
      ]);
      expect(rows(s)).toEqual(['Contact us', 'Home', 'Team', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', '  Kitchens', '  Baths']);
      s = apply(s, [reorder(s, ['Lookbook', 'Kitchens', 'Baths', 'Services', 'About', 'Contact', 'Home'])]);
      // Contact is linked twice, so neither of its links moves; Team and Shop keep their places.
      expect(rows(s)).toEqual(['Contact us', 'Lookbook', '  Kitchens', '  Baths', 'Team', 'Services', 'Shop', 'Contact', 'About', 'Home']);
    });

    it('applies to the assistant’s reorder in the same batch as its other edits', () => {
      let s = following();
      const about = links(s).find((l) => l.label === 'About')!;
      s = apply(s, [reorder(s, ['Home', 'Contact', 'About', 'Services', 'Lookbook', 'Kitchens', 'Baths']), { type: 'instance.setProp', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: about.id, field: 'label', value: 'Our story' }]);
      expect(rows(s)).toEqual(['Home', 'Contact', 'Shop', 'Our story', 'Services', 'Lookbook', '  Kitchens', '  Baths']);
    });

    it('puts a page added to the menu at its place in the page order, at its level', () => {
      let s = following();
      // A page added between About and Contact goes between them, not at the end; Shop stays after About.
      s = apply(s, [{ type: 'page.create', pageId: 'pg_pricing1', title: 'Pricing', afterPageId: pageId(s, 'Home'), addToNavigation: true }]);
      expect(titles(s)).toEqual(['Home', 'Pricing', 'About', 'Contact', 'Services', 'Lookbook', 'Kitchens', 'Baths']);
      expect(rows(s)).toEqual(['Home', 'Pricing', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', '  Kitchens', '  Baths']);
      // A child page goes into its parent's submenu, at its place there.
      s = apply(s, [{ type: 'page.create', pageId: 'pg_decks001', title: 'Decks', route: '/lookbook/decks/', afterPageId: 'pg_lookbook', addToNavigation: true }]);
      expect(rows(s)).toEqual(['Home', 'Pricing', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', '  Decks', '  Kitchens', '  Baths']);
    });

    it('puts the last page after the last page link, ahead of a link after it that sorts no other way', () => {
      let s = following();
      const remove = (label: string): EditOperation => ({ type: 'instance.listRemove', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: links(s).find((l) => l.label === label)!.id });
      s = apply(s, [remove('Kitchens'), remove('Baths'), insert(s, { label: 'Email', link: { type: 'email', target: 'hi@example.com' } })]);
      s = apply(s, [{ type: 'page.create', pageId: 'pg_faq00001', title: 'FAQ', addToNavigation: true }]);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', 'FAQ', 'Email']);
    });

    it('sorts a link added by hand, or pointed at a page, into the page order', () => {
      let s = following();
      s = apply(s, [{ type: 'page.create', pageId: 'pg_pricing1', title: 'Pricing', afterPageId: pageId(s, 'Home') }]);
      expect(rows(s)).not.toContain('Pricing');
      // The Inspector adds a blank row at the end, then the author picks its page.
      s = apply(s, [insert(s, { label: 'Pricing' })]);
      const row = links(s).at(-1)!;
      s = apply(s, [{ type: 'instance.setProp', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: row.id, field: 'link', value: { type: 'page', target: 'pg_pricing1' } }]);
      // At its page's place, as a page added to the menu goes: Shop stays after About.
      expect(rows(s).slice(0, 4)).toEqual(['Home', 'Pricing', 'About', 'Shop']);
      expect(headerOrderPlan(s)).toBeNull();
      // A link inserted anywhere at the top level goes to its page's place too.
      s = apply(s, [{ type: 'page.create', pageId: 'pg_team0001', title: 'Team', afterPageId: pageId(s, 'Contact') }]);
      s = apply(s, [insert(s, { label: 'Team', link: { type: 'page', target: 'pg_team0001' } }, 0)]);
      expect(rows(s).slice(0, 6)).toEqual(['Home', 'Pricing', 'About', 'Shop', 'Contact', 'Team']);
    });

    it('sorts a page’s link once it is no longer one of two', () => {
      let s = following();
      s = apply(s, [insert(s, { label: 'Get in touch', link: { type: 'page', target: pageId(s, 'Contact') } }, 0)]);
      expect(rows(s).slice(0, 2)).toEqual(['Get in touch', 'Home']);
      s = apply(s, [{ type: 'instance.listRemove', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: links(s).find((l) => l.label === 'Contact')!.id }]);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Get in touch', 'Services', 'Lookbook', '  Kitchens', '  Baths']);
    });

    it('never takes another link’s submenu along with a link added above it', () => {
      let s = following();
      // Lookbook and its submenu lead the menu, its first row marked to go under nothing.
      const top = links(s).find((l) => l.label === 'Lookbook')!;
      s = apply(s, [{ type: 'instance.setProp', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: top.id, field: 'sub', value: true }]);
      s = apply(s, [own, moveRow(s, 'Lookbook', 0), moveRow(s, 'Kitchens', 1), moveRow(s, 'Baths', 2), follow]);
      expect(rows(s).slice(0, 4)).toEqual(['  Lookbook', '  Kitchens', '  Baths', 'Home']);
      s = apply(s, [{ type: 'page.create', pageId: 'pg_zzz00001', title: 'Zebra' }]);
      s = apply(s, [insert(s, { label: 'Zebra', link: { type: 'page', target: 'pg_zzz00001' } }, 0)]);
      // Zebra goes to its place at the end; Lookbook keeps Kitchens and Baths.
      expect(rows(s)).toEqual(['  Lookbook', '  Kitchens', '  Baths', 'Home', 'About', 'Shop', 'Contact', 'Services', 'Zebra']);
    });

    it('keeps a submenu with the link to its page when that page’s other link, which led it, goes', () => {
      let s = following();
      const remove = (label: string): EditOperation => ({ type: 'instance.listRemove', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: links(s).find((l) => l.label === label)!.id });
      s = apply(s, [{ type: 'page.create', pageId: 'pg_late0001', title: 'Late' }]);
      // Late is linked twice after Home, the second link leading a submenu, so neither sorts.
      s = apply(s, [own, remove('Kitchens'), remove('Baths'), insert(s, { label: 'Late', link: { type: 'page', target: 'pg_late0001' } }, 1), insert(s, { label: 'Late again', link: { type: 'page', target: 'pg_late0001' } }, 2), insert(s, { label: 'Child', sub: true, link: { type: 'url', target: 'https://child.example.com' } }, 3), follow]);
      expect(rows(s)).toEqual(['Home', 'Late', 'Late again', '  Child', 'About', 'Shop', 'Contact', 'Services', 'Lookbook']);
      // Removing the link that led Child leaves Late to sort: Child, now shown under it, goes along to its place.
      s = apply(s, [remove('Late again')]);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', 'Late', '  Child']);
    });

    it('leaves a link pointed at a page where it is when that is already its place', () => {
      let s = following();
      const shop = links(s).find((l) => l.label === 'Shop')!;
      // Shop sits between About and Contact; Team, a page between them in Pages, takes its link there.
      s = apply(s, [{ type: 'page.create', pageId: 'pg_team0001', title: 'Team', afterPageId: pageId(s, 'About') }]);
      s = apply(s, [insert(s, { label: 'Blog', link: { type: 'url', target: 'https://blog.example.com' } }, 3)]);
      s = apply(s, [{ type: 'instance.setProp', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: shop.id, field: 'link', value: { type: 'page', target: 'pg_team0001' } }]);
      // It never crosses Blog to sit right before Contact.
      expect(rows(s).slice(0, 5)).toEqual(['Home', 'About', 'Shop', 'Blog', 'Contact']);
    });

    it('counts a page linked twice across the whole menu while it places a link', () => {
      let s = site();
      const row = (label: string, link: Record<string, unknown>, sub?: boolean) => ({ label, link, ...(sub ? { sub: true } : {}) });
      // Services is linked twice, once under Resources (another site), so neither of its links sorts.
      s = apply(s, [
        { type: 'instance.setProp', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', value: [row('Services', { type: 'page', target: 'pg_services' }), row('Shop', { type: 'url', target: 'https://shop.example.com' }), row('Resources', { type: 'url', target: 'https://example.com' }), row('Our services', { type: 'page', target: 'pg_services' }, true), row('Home', { type: 'page', target: pageId(s, 'Home') })] },
        follow
      ]);
      expect(rows(s)).toEqual(['Services', 'Shop', 'Resources', '  Our services', 'Home']);
      const resources = links(s).find((l) => l.label === 'Resources')!;
      // Pointed at About, Resources goes after Home with its submenu; the top-level Services link stays first.
      s = apply(s, [{ type: 'instance.setProp', owner: HEADER, nodeId: menuOf(s).id, prop: 'links', itemId: resources.id, field: 'link', value: { type: 'page', target: pageId(s, 'About') } }]);
      expect(rows(s)).toEqual(['Services', 'Shop', 'Home', 'Resources', '  Our services']);
    });

    it('keeps a menu shown from its design’s list when an edit leaves it in order', () => {
      const s = following();
      const shared = structuredClone(s);
      const node = menuOf(shared);
      const schema = shared.components[node.definitionId].properties.links as unknown as { default: Row[] };
      schema.default = (structuredClone(node.props.links) as Row[]).slice(0, 1);
      delete node.props.links;
      const before = menuBefore(shared);
      // The design's list gains About after Home, which is its place in Pages.
      schema.default = [...schema.default, { id: 'li_about0001', label: 'About', link: { type: 'page', target: pageId(s, 'About') } }];
      keepHeaderOrder(shared, before);
      expect('links' in menuOf(shared).props).toBe(false);
      // Out of order, the menu takes a list of its own, and the design's stays as it was.
      schema.default = [schema.default[1], schema.default[0]];
      keepHeaderOrder(shared, menuBefore(shared));
      expect((menuOf(shared).props.links as Row[]).map((l) => l.label)).toEqual(['Home', 'About']);
      // Copies: editing the menu's rows never edits the design's.
      expect((menuOf(shared).props.links as Row[])[0]).not.toBe(schema.default[1]);
      expect(schema.default.map((l) => l.label)).toEqual(['About', 'Home']);
    });

    it('takes a deleted page’s links out of the menu rather than pointing them at another page', () => {
      let s = following();
      s = apply(s, [insert(s, { label: 'Services FAQ', link: { type: 'page', target: 'pg_services', anchor: 'faq' } })]);
      expect(rows(s)).toContain('Services FAQ');
      // Contact is already in the menu: pointing Services' link at it would list Contact twice.
      const review = reviewPageRemoval(s, 'pg_services', undefined);
      expect(review.menu).toEqual(['Services', 'Services FAQ']);
      expect(review.uses).toEqual([]);
      // Nothing else links to it, so it needs no replacement page.
      expect(planPageRemoval(s, 'pg_services', undefined, new Map()).operations).toEqual([{ type: 'page.remove', pageId: 'pg_services' }]);
      s = apply(s, [{ type: 'page.remove', pageId: 'pg_services' }]);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Lookbook', '  Kitchens', '  Baths']);
    });

    it('still asks for a replacement for the page’s other links, and points only those at it', () => {
      let s = following();
      s = apply(s, [{ type: 'instance.listInsert', owner: FOOTER, nodeId: menuOf(s, 'footer').id, prop: 'links', item: { label: 'Services', link: { type: 'page', target: 'pg_services' } } }]);
      const review = reviewPageRemoval(s, 'pg_services', pageId(s, 'Contact'));
      expect(review.menu).toEqual(['Services']);
      expect(review.uses.map((u) => u.where)).toEqual(['Footer']);
      expect(() => apply(s, [{ type: 'page.remove', pageId: 'pg_services' }])).toThrow(/Choose a replacement page/);
      s = apply(s, planPageRemoval(s, 'pg_services', pageId(s, 'Contact'), new Map()).operations!);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Lookbook', '  Kitchens', '  Baths']);
      expect(links(s, 'footer')[0].link).toEqual({ type: 'page', target: pageId(s, 'Contact') });
    });

    it('points Home’s menu link at a new blank Home, which stands in its place in the pages', () => {
      let s = following();
      const home = s.site.homePageId;
      const review = reviewPageRemoval(s, home, NEW_HOME);
      expect(review.menu).toEqual([]);
      expect(review.uses.map((u) => u.where)).toContain('Header');
      s = apply(s, planPageRemoval(s, home, NEW_HOME, new Map()).operations!);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Services', 'Lookbook', '  Kitchens', '  Baths']);
      expect(links(s)[0].link).toEqual({ type: 'page', target: s.site.homePageId });
      expect(s.site.homePageId).not.toBe(home);
    });

    it('keeps a deleted page’s submenu whole, under the first link that was in it', () => {
      let s = following();
      s = apply(s, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/kitchens/' }, { type: 'page.update', pageId: 'pg_baths001', route: '/baths/' }]);
      s = apply(s, [{ type: 'page.remove', pageId: 'pg_lookbook' }]);
      expect(rows(s)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Services', 'Kitchens', '  Baths']);
      // Said outright, so a list whose rows go under the one above by default still shows it at the top level.
      expect(links(s).find((l) => l.label === 'Kitchens')!.sub).toBe(false);
    });

    it('refuses a link moved by hand, which the next reorder would put back', () => {
      const s = following();
      expect(() => apply(s, [moveRow(s, 'Contact', 0)])).toThrow(/follows the page order/);
      // Switched to its own order in the same change, it moves.
      expect(rows(apply(s, [own, moveRow(s, 'Contact', 0)])).slice(0, 2)).toEqual(['Contact', 'Home']);
    });

    it('marks every page as changed by a reorder, since the shared header moves', () => {
      const s = following();
      expect(pagesTouched([reorder(s, titles(s).reverse())], s)).toBe('all');
      expect(pagesTouched([reorder(s, titles(s).reverse())], apply(s, [own]))).toEqual(new Set());
    });

    it('gives a menu shown from its design’s list a list of its own only when it moves', () => {
      const s = following();
      const shared = structuredClone(s);
      const node = menuOf(shared);
      const def = shared.components[node.definitionId];
      (def.properties.links as { default: unknown }).default = structuredClone(node.props.links);
      delete node.props.links;
      expect(headerOrder(shared)!.changed).toBe(false);
      const same = apply(shared, [{ type: 'site.update', name: 'Other Studio' }]);
      expect('links' in menuOf(same).props).toBe(false);
      const moved = apply(shared, [reorder(shared, ['Contact', 'Home', 'About', 'Services', 'Lookbook', 'Kitchens', 'Baths'])]);
      expect(rows(moved).slice(0, 4)).toEqual(['Contact', 'Home', 'Shop', 'About']);
      // The design's own list is left as it was.
      expect((moved.components[node.definitionId].properties.links as unknown as { default: Row[] }).default.map((l) => l.label).slice(0, 2)).toEqual(['Home', 'About']);
    });

    it('leaves a list set from elsewhere, and a menu that must keep its links, alone', () => {
      const s = following();
      const bound = structuredClone(s);
      menuOf(bound).props.links = { $prop: 'links' };
      expect(headerOrder(bound)).toBeNull();
      expect(dropHeaderLinks(bound, 'pg_services')).toEqual([]);
      const full = structuredClone(s);
      (full.components[menuOf(full).definitionId].properties.links as { min?: number }).min = links(full).length;
      expect(dropHeaderLinks(full, 'pg_services')).toEqual([]);
      expect(links(full).some((l) => l.link.target === 'pg_services')).toBe(true);
    });
  });

  describe('with its own order', () => {
    it('leaves the menu alone on a reorder, adds a page at the end, and points a deleted page’s link elsewhere', () => {
      let s = site();
      const before = rows(s);
      s = apply(s, [reorder(s, ['Services', 'Home', 'About', 'Contact', 'Lookbook', 'Kitchens', 'Baths'])]);
      expect(rows(s)).toEqual(before);
      s = apply(s, [{ type: 'page.create', pageId: 'pg_pricing1', title: 'Pricing', afterPageId: pageId(s, 'Home'), addToNavigation: true }]);
      expect(rows(s).at(-1)).toBe('Pricing');
      expect(reviewPageRemoval(s, 'pg_services', undefined).menu).toEqual([]);
      expect(() => apply(s, [{ type: 'page.remove', pageId: 'pg_services' }])).toThrow(/Choose a replacement page/);
      s = apply(s, [{ type: 'page.remove', pageId: 'pg_services', replacementPageId: pageId(s, 'Contact') }]);
      expect(links(s).filter((l) => l.link.target === pageId(s, 'Contact')).map((l) => l.label)).toEqual(['Contact', 'Services']);
      // A hand move is the author's to make.
      expect(rows(apply(s, [moveRow(s, 'Contact', 0)]))[0]).toBe('Contact');
    });
  });

  describe('in a project', () => {
    const dirs: string[] = [];
    const open: ProjectSession[] = [];
    afterEach(async () => {
      for (const s of open.splice(0)) await s.close().catch(() => undefined);
      dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
    });
    async function session(state: ProjectState) {
      const dir = mkdtempSync(join(tmpdir(), 'so-menu-order-'));
      dirs.push(dir);
      const s = await ProjectSession.create(dir, state);
      open.push(s);
      return s;
    }
    const applied = (s: ProjectSession) => s.historyInfo().entries.filter((e) => e.applied);
    /** Apply one change and check it is one step in History that one Undo takes back whole, and Redo brings back. */
    async function oneStep(s: ProjectSession, ops: EditOperation[], label: string) {
      const before = structuredClone({ site: s.state.site, pages: Object.keys(s.state.pages).sort() });
      const was = applied(s).length;
      const r = await s.apply({ operations: ops }, { label });
      expect(r.ok).toBe(true);
      const after = structuredClone({ site: s.state.site, pages: Object.keys(s.state.pages).sort() });
      expect(applied(s).length).toBe(was + 1);
      expect(applied(s).at(-1)?.label).toBe(label);
      expect((await s.undo()).ok).toBe(true);
      expect({ site: s.state.site, pages: Object.keys(s.state.pages).sort() }).toEqual(before);
      expect((await s.redo()).ok).toBe(true);
      expect({ site: s.state.site, pages: Object.keys(s.state.pages).sort() }).toEqual(after);
    }

    it('makes switching, reordering, adding and deleting each one step in History', async () => {
      let base = site();
      base = apply(base, [reorder(base, ['Home', 'Contact', 'About', 'Services', 'Lookbook', 'Kitchens', 'Baths'])]);
      const s = await session(base);
      await oneStep(s, [follow], 'Header menu follows page order');
      expect(rows(s.state).slice(0, 4)).toEqual(['Home', 'Contact', 'Shop', 'About']);
      await oneStep(s, [reorder(s.state, ['Home', 'About', 'Contact', 'Lookbook', 'Kitchens', 'Baths', 'Services'])], 'Reorder pages');
      expect(rows(s.state)).toEqual(['Home', 'About', 'Shop', 'Contact', 'Lookbook', '  Kitchens', '  Baths', 'Services']);
      await oneStep(s, [{ type: 'page.create', pageId: 'pg_pricing1', title: 'Pricing', afterPageId: pageId(s.state, 'Home'), addToNavigation: true }], 'Add page');
      expect(rows(s.state).slice(0, 2)).toEqual(['Home', 'Pricing']);
      await oneStep(s, [{ type: 'page.remove', pageId: 'pg_pricing1' }], 'Delete page');
      expect(rows(s.state)).not.toContain('Pricing');
    }, 30000);
  });
});
