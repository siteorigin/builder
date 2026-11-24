/**
 * Child pages (#169): a page's place comes from its address, moving a page moves the pages inside it and keeps
 * every old address working, and a new page inside another joins the header menu under its parent's link, while
 * the menu and the pages' places stay independently editable.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { headerMenu, headerMenuSlot, headerMenuSlotUnder } from '@engine/tree';
import { validateState } from '@engine/validate';
import { generateProject, pageFile, redirectFile } from '@generator/index';
import { pageParents, pageRows, pagesWithin, planRouteMove, routeFolder, routeLeaf, routeWithin } from '@shared/page-tree';
import { suggestRoute, validateRoute } from '@shared/routes';

const fresh = () => createStarterState('business', 'Test Studio', false);
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
const menu = (s: ProjectState) => (headerMenu(s)!.node.props.links ?? []) as ListItem[];
const menuRows = (s: ProjectState) => menu(s).map((i) => `${i.sub ? '  ' : ''}${i.label}`);
const routes = (s: ProjectState) => Object.fromEntries(Object.values(s.pages).map((p) => [p.title, p.route]));

/** The business starter (Home, About, Contact; all three in the header menu) with a Lookbook page and two inside it. */
function lookbook(): ProjectState {
  return applyOperations(fresh(), [
    { type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook', addToNavigation: true },
    { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/lookbook/kitchens/', addToNavigation: true },
    { type: 'page.create', pageId: 'pg_spring01', title: 'Spring', route: '/lookbook/kitchens/spring/' }
  ]).state;
}

describe('page places from addresses', () => {
  const page = (id: string, route: string) => ({ id, route });

  it('splits an address into its folder and last segment', () => {
    expect(routeFolder('/lookbook/kitchens/')).toBe('/lookbook/');
    expect(routeFolder('/lookbook/')).toBeNull();
    expect(routeFolder('/')).toBeNull();
    expect(routeLeaf('/lookbook/kitchens/')).toBe('kitchens');
    expect(routeLeaf('/lookbook/')).toBe('lookbook');
    expect(routeWithin('/lookbook/kitchens/', '/lookbook/')).toBe(true);
    expect(routeWithin('/lookbook-old/', '/lookbook/')).toBe(false);
    expect(routeWithin('/lookbook/', '/lookbook/')).toBe(false);
    expect(routeWithin('/about/', '/')).toBe(false);
  });

  it('puts a page inside the nearest page above its address, never inside Home', () => {
    const parents = pageParents([page('home', '/'), page('look', '/lookbook/'), page('kit', '/lookbook/kitchens/'), page('deep', '/lookbook/2026/spring/'), page('old', '/lookbook-old/'), page('up', '/Work/'), page('w', '/work/case/')]);
    expect(Object.fromEntries(parents)).toEqual({ home: null, look: null, kit: 'look', deep: 'look', old: null, up: null, w: 'up' });
  });

  it('lists pages as an outline: each followed by the pages inside it, siblings in their saved order', () => {
    const pages = Object.fromEntries([page('home', '/'), page('kit', '/lookbook/kitchens/'), page('about', '/about/'), page('look', '/lookbook/'), page('bath', '/lookbook/baths/'), page('spring', '/lookbook/kitchens/spring/')].map((p) => [p.id, p]));
    const rows = pageRows(pages, ['home', 'kit', 'about', 'bath', 'look', 'spring', 'missing']);
    expect(rows.map((r) => `${'-'.repeat(r.depth)}${r.id}`)).toEqual(['home', 'about', 'look', '-kit', '--spring', '-bath']);
    expect(rows.find((r) => r.id === 'spring')!.parentId).toBe('kit');
    expect(pagesWithin(pages, 'look').sort()).toEqual(['bath', 'kit', 'spring']);
    expect(pagesWithin(pages, 'home')).toEqual([]);
    // A page whose parent is left out of the order is shown at the top level rather than lost.
    expect(pageRows(pages, ['kit', 'home']).map((r) => r.id)).toEqual(['kit', 'home']);
  });

  it('suggests a new address inside a folder the way it does at the top level', () => {
    const taken = new Set(['/lookbook/kitchens/']);
    expect(suggestRoute('Kitchens', (r) => taken.has(r), 'page', '/lookbook/')).toEqual({ route: '/lookbook/kitchens-2/', base: '/lookbook/kitchens/' });
    // Only a top-level name can be reserved.
    expect(suggestRoute('API', () => false)).toEqual({ route: '/api-page/', base: '/api-page/', reserved: '/api/' });
    expect(suggestRoute('API', () => false, 'page', '/lookbook/')).toEqual({ route: '/lookbook/api/', base: '/lookbook/api/' });
    const long = 'a'.repeat(70);
    const r = suggestRoute(long, (x) => x === `/lookbook/${'a'.repeat(60)}/`, 'page', '/lookbook/');
    expect(r.route).toBe(`/lookbook/${'a'.repeat(58)}-2/`);
    expect(validateRoute(r.route)).toBeNull();
  });
});

describe('moving a page', () => {
  it('moves the pages inside it along, and keeps every old address leading to its page', () => {
    const s = lookbook();
    const r = applyOperations(s, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/work/lookbook/' }]);
    expect(routes(r.state)).toMatchObject({ Lookbook: '/work/lookbook/', Kitchens: '/work/lookbook/kitchens/', Spring: '/work/lookbook/kitchens/spring/' });
    expect(r.state.site.redirects).toEqual([
      { from: '/lookbook/', pageId: 'pg_lookbook' },
      { from: '/lookbook/kitchens/', pageId: 'pg_kitchens' },
      { from: '/lookbook/kitchens/spring/', pageId: 'pg_spring01' }
    ]);
    expect(r.results[0]).toEqual({
      route: '/work/lookbook/',
      moved: [
        { pageId: 'pg_lookbook', from: '/lookbook/', to: '/work/lookbook/' },
        { pageId: 'pg_kitchens', from: '/lookbook/kitchens/', to: '/work/lookbook/kitchens/' },
        { pageId: 'pg_spring01', from: '/lookbook/kitchens/spring/', to: '/work/lookbook/kitchens/spring/' }
      ]
    });
    // Menus store pages, not addresses: nothing in the header changes, and its links follow.
    expect(menu(r.state)).toEqual(menu(s));
    expect(validateState(r.state).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(r.state);
    expect(files.has(pageFile(r.state.pages.pg_spring01))).toBe(true);
    expect(files.get(redirectFile('/lookbook/kitchens/'))).toContain('resolve("/work/lookbook/kitchens/")');
    expect(files.get('src/routes/+layout.svelte')).toContain('"/work/lookbook/kitchens/"');
  });

  it('sends earlier addresses straight to the latest one, and lets a page take its own old address back', () => {
    let s = lookbook();
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/kitchens/' }]).state;
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/rooms/kitchens/' }]).state;
    expect(routes(s)).toMatchObject({ Kitchens: '/rooms/kitchens/', Spring: '/rooms/kitchens/spring/' });
    const files = generateProject(s);
    for (const old of ['/lookbook/kitchens/', '/kitchens/']) expect(files.get(redirectFile(old))).toContain('resolve("/rooms/kitchens/")');
    // Back where it started: it takes the address back, and the old address of its child is the child's own again.
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/lookbook/kitchens/' }]).state;
    expect(routes(s)).toMatchObject({ Kitchens: '/lookbook/kitchens/', Spring: '/lookbook/kitchens/spring/' });
    expect(s.site.redirects?.map((r) => r.from).sort()).toEqual(['/kitchens/', '/kitchens/spring/', '/rooms/kitchens/', '/rooms/kitchens/spring/']);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('changes nothing for the address the page already has, and keeps no old address a page still uses', () => {
    const s = lookbook();
    const same = applyOperations(s, [{ type: 'page.update', pageId: 'pg_lookbook', route: 'lookbook' }]);
    expect(same.state.site.redirects).toBeUndefined();
    expect(same.results[0]).toEqual({ route: '/lookbook/' });
    // A legacy address written with capitals, given its lowercase form: the same folder on disk, so nothing is kept.
    const legacy = structuredClone(s);
    legacy.pages.pg_kitchens.route = '/Lookbook/Kitchens/';
    expect(applyOperations(legacy, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/lookbook/kitchens/' }]).state.site.redirects).toBeUndefined();
    // A child taking over the address its parent leaves: no old address is kept there.
    const up = applyOperations(s, [{ type: 'page.create', pageId: 'pg_lookbook2', title: 'Lookbook', route: '/lookbook/lookbook/' }]).state;
    const r = applyOperations(up, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/archive/' }, { type: 'page.update', pageId: 'pg_lookbook2', route: '/lookbook/' }]).state;
    expect(r.pages.pg_lookbook2.route).toBe('/lookbook/');
    expect(r.site.redirects?.some((x) => x.from === '/lookbook/')).toBe(false);
  });

  it('refuses a move that would go inside itself, too deep, or onto a page that stays put, and changes nothing', () => {
    const s = lookbook();
    const refused = (route: string) => {
      try {
        applyOperations(s, [{ type: 'page.update', pageId: 'pg_lookbook', route }]);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(refused('/lookbook/kitchens/lookbook/')).toMatch(/“Lookbook” cannot move inside itself/);
    // Spring would end up five levels deep.
    expect(refused('/a/b/lookbook/')).toMatch(/would move “Spring” to \/a\/b\/lookbook\/kitchens\/spring\/, which is not possible: Routes can be at most four levels deep/);
    const blocked = applyOperations(s, [{ type: 'page.create', pageId: 'pg_workkit', title: 'Work kitchens', route: '/work/kitchens/' }]).state;
    expect(() => applyOperations(blocked, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/WORK/' }])).toThrow(/would move “Kitchens” to \/work\/kitchens\/, which “Work kitchens” already uses/);
    expect(() => applyOperations(blocked, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/work/kitchens/' }])).toThrow(/Another page already uses \/work\/kitchens\//);
    expect(routes(blocked)).toMatchObject({ Lookbook: '/lookbook/', Kitchens: '/lookbook/kitchens/', Spring: '/lookbook/kitchens/spring/' });
    expect(blocked.site.redirects).toBeUndefined();
  });

  it('refuses to move a page inside it onto the address the page has now, so old links never open another page', () => {
    const s = applyOperations(fresh(), [
      { type: 'page.create', pageId: 'pg_studio01', title: 'Studio', route: '/work/studio/' },
      { type: 'page.create', pageId: 'pg_studio02', title: 'Studio team', route: '/work/studio/studio/' }
    ]).state;
    // Studio would go to /work/, and the page inside it onto /work/studio/, Studio's address until now.
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: 'pg_studio01', route: '/work/' }])).toThrow(/would move “Studio team” to \/work\/studio\/, the address “Studio” has now/);
    // Renaming the inner page first lets it through.
    const r = applyOperations(s, [{ type: 'page.update', pageId: 'pg_studio02', route: '/work/studio/team/' }, { type: 'page.update', pageId: 'pg_studio01', route: '/work/' }]).state;
    expect(routes(r)).toMatchObject({ Studio: '/work/', 'Studio team': '/work/team/' });
  });

  it('keeps only addresses a page had when the edit began, not ones it passed through', () => {
    let s = lookbook();
    const about = byTitle(s, 'About').id;
    const contact = byTitle(s, 'Contact').id;
    // Swapping two addresses through a spare one: both old addresses are in use again, and the spare was never served.
    const swap = applyOperations(s, [
      { type: 'page.update', pageId: about, route: '/swap/' },
      { type: 'page.update', pageId: contact, route: '/about/' },
      { type: 'page.update', pageId: about, route: '/contact/' }
    ]).state;
    expect([swap.pages[about].route, swap.pages[contact].route]).toEqual(['/contact/', '/about/']);
    expect(swap.site.redirects).toBeUndefined();
    // A parent moved before its child: the child's stop on the way is not kept, its first address is.
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/work/' }, { type: 'page.update', pageId: 'pg_kitchens', route: '/rooms/kitchens/' }]).state;
    expect(s.site.redirects?.map((r) => `${r.from}>${r.pageId}`).sort()).toEqual(['/lookbook/>pg_lookbook', '/lookbook/kitchens/>pg_kitchens', '/lookbook/kitchens/spring/>pg_spring01']);
    expect(routes(s)).toMatchObject({ Kitchens: '/rooms/kitchens/', Spring: '/rooms/kitchens/spring/' });
  });

  it('keeps no address a page was created at in the same edit, or one that is not a route', () => {
    const made = applyOperations(fresh(), [{ type: 'page.create', pageId: 'pg_team0001', title: 'Team' }, { type: 'page.update', pageId: 'pg_team0001', route: '/about/team/' }]).state;
    expect(made.pages.pg_team0001.route).toBe('/about/team/');
    expect(made.site.redirects).toBeUndefined();
    // A page that passed through an address keeps nothing there to stop a later move in the same edit.
    const s = lookbook();
    const through = applyOperations(s, [
      { type: 'page.update', pageId: byTitle(s, 'About').id, route: '/work/kitchens/' },
      { type: 'page.update', pageId: byTitle(s, 'About').id, route: '/about-us/' },
      { type: 'page.update', pageId: 'pg_lookbook', route: '/work/' }
    ]).state;
    expect(through.pages.pg_kitchens.route).toBe('/work/kitchens/');
    expect(through.site.redirects?.some((r) => r.from === '/work/kitchens/')).toBe(false);
    const legacy = lookbook();
    legacy.pages.pg_lookbook.route = '/Lookbook/';
    const moved = applyOperations(legacy, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/studio/' }]).state;
    expect(moved.site.redirects?.some((r) => r.from === '/Lookbook/')).toBe(false);
  });

  it('never lets a page moved along take another page’s old address, though the page moved on purpose may', () => {
    let s = lookbook();
    s = applyOperations(s, [{ type: 'page.create', pageId: 'pg_studio01', title: 'Studio', route: '/work/kitchens/' }]).state;
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_studio01', route: '/studio/' }]).state;
    expect(s.site.redirects).toEqual([{ from: '/work/kitchens/', pageId: 'pg_studio01' }]);
    expect(() => applyOperations(s, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/work/' }])).toThrow(/would move “Kitchens” to \/work\/kitchens\/, an old address kept working for “Studio”/);
    const plan = planRouteMove(s, 'pg_lookbook', '/work/', validateRoute);
    expect('error' in plan).toBe(true);
    const taken = applyOperations(s, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/work/kitchens/' }]).state;
    expect(taken.pages.pg_kitchens.route).toBe('/work/kitchens/');
    expect(taken.site.redirects?.some((r) => r.pageId === 'pg_studio01')).toBe(false);
  });

  it('keeps a copy beside its original', () => {
    const s = lookbook();
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: 'pg_kitchens', title: 'Kitchens' }]);
    expect(r.results[0].route).toBe('/lookbook/kitchens-2/');
    expect(r.state.pages[r.results[0].pageId as string].route).toBe('/lookbook/kitchens-2/');
  });
});

describe('a page inside another in the header menu', () => {
  it('goes under its parent’s link, after the links already there, when it joins the menu', () => {
    const s = lookbook();
    expect(menuRows(s)).toEqual(['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']);
    // Spring sits inside Kitchens, which is itself under Lookbook: it is not added under a submenu link.
    const t = applyOperations(s, [{ type: 'page.create', pageId: 'pg_baths001', title: 'Baths', route: '/lookbook/baths/', addToNavigation: true }, { type: 'page.create', title: 'Autumn', route: '/lookbook/kitchens/autumn/', addToNavigation: true }]).state;
    expect(menuRows(t)).toEqual(['Home', 'About', 'Contact', 'Lookbook', '  Kitchens', '  Baths', 'Autumn']);
    expect(menu(t)[5]).toMatchObject({ label: 'Baths', link: { type: 'page', target: 'pg_baths001' }, sub: true });
  });

  it('goes under a parent link in the middle of the menu, before the next top-level link', () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    const t = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/team/', addToNavigation: true }, { type: 'page.create', title: 'History', route: '/about/history/', addToNavigation: true }]).state;
    expect(menuRows(t)).toEqual(['Home', 'About', '  Team', '  History', 'Contact']);
    expect(headerMenuSlot(t, menu(t), about)).toEqual({ index: 5, sub: false });
  });

  it('goes at the end when its parent has no whole-page link at the top level, or the menu has no submenus', () => {
    let s = fresh();
    const about = byTitle(s, 'About').id;
    const header = headerMenu(s)!.node;
    // A link to a section of About is not a link to the page.
    header.props.links = (header.props.links as ListItem[]).map((i) => ((i.link as { target?: string }).target === about ? { ...i, link: { type: 'page', target: about, anchor: 'team' } } : i));
    s = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/team/', addToNavigation: true }]).state;
    expect(menuRows(s)).toEqual(['Home', 'About', 'Contact', 'Team']);
    // A header installed before submenus existed keeps a flat menu.
    const old = fresh();
    const def = old.components[(headerMenu(old)!.node as InstanceNode).definitionId];
    const links = def.properties.links;
    if (links.type === 'list') delete links.fields.sub;
    const flat = applyOperations(old, [{ type: 'page.create', title: 'Team', route: '/about/team/', addToNavigation: true }]).state;
    expect(menuRows(flat)).toEqual(['Home', 'About', 'Contact', 'Team']);
    expect(menu(flat)[3]).not.toHaveProperty('sub');
  });

  it('treats a marked first link as the top-level link the website shows it as', () => {
    const s = fresh();
    const about = byTitle(s, 'About').id;
    const header = headerMenu(s)!.node;
    const items = header.props.links as ListItem[];
    header.props.links = [{ ...items[1], label: 'Our studio', sub: true }, items[0], items[2]];
    const t = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/team/', addToNavigation: true }]).state;
    expect(menuRows(t)).toEqual(['  Our studio', '  Team', 'Home', 'Contact']);
    // The parent is named as the menu names it.
    expect(headerMenuSlotUnder(t, menu(t), about)).toMatchObject({ index: 2, sub: true, under: 'Our studio' });
  });

  it('keeps the menu and the page’s place independent of each other', () => {
    let s = lookbook();
    const kitchensItem = menu(s).find((i) => i.label === 'Kitchens')!;
    // Grouping or ungrouping a link edits the header only.
    const header = headerMenu(s)!.node.id;
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', itemId: kitchensItem.id, field: 'sub', value: false }]).state;
    expect(menuRows(s)).toEqual(['Home', 'About', 'Contact', 'Lookbook', 'Kitchens']);
    expect(s.pages.pg_kitchens.route).toBe('/lookbook/kitchens/');
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', itemId: kitchensItem.id, field: 'sub', value: true }]).state;
    expect(s.pages.pg_kitchens.route).toBe('/lookbook/kitchens/');
    expect(s.site.redirects).toBeUndefined();
    // Moving the page leaves its link under Lookbook, still leading to it.
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/about/kitchens/' }]).state;
    expect(menuRows(s)).toEqual(['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']);
    expect(menu(s).find((i) => i.label === 'Kitchens')!.link).toEqual({ type: 'page', target: 'pg_kitchens' });
    const layout = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('"/about/kitchens/"');
    expect(layout).toMatch(/"sub":\s*true/);
  });

  it('is left out of a full menu, and the page is still made', () => {
    let s = fresh();
    const header = headerMenu(s)!.node;
    header.props.links = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, label: `L${i}`, link: { type: 'url', target: 'https://example.com' } }));
    const r = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/team/', addToNavigation: true }]);
    expect(r.results[0].addedToNavigation).toBe(false);
    s = r.state;
    expect(menu(s)).toHaveLength(10);
    expect(s.pages[r.results[0].pageId as string].route).toBe('/about/team/');
  });
});

describe('what else reads a page’s place', () => {
  it('tells the AI which page a child page is inside', async () => {
    const { projectSummary } = await import('@agent/context');
    const pages = projectSummary(lookbook(), 1).pages;
    expect(pages.find((p) => p.id === 'pg_kitchens')).toMatchObject({ parentPageId: 'pg_lookbook' });
    expect(pages.find((p) => p.id === 'pg_spring01')).toMatchObject({ parentPageId: 'pg_kitchens' });
    expect(pages.find((p) => p.id === 'pg_lookbook')).not.toHaveProperty('parentPageId');
  });

  it('holds a new address against the pages inside the page as well as its own address', async () => {
    const { checkHeld, readFields } = await import('../../src/renderer/src/lib/held');
    const s = lookbook();
    const ops = [{ type: 'page.update' as const, pageId: 'pg_lookbook', route: '/work/lookbook/' }];
    const base = readFields(s, ops)!.map((r) => (r.found ? r.value : undefined));
    expect(checkHeld(s, ops, base).kind).toBe('apply');
    // A page added inside Lookbook meanwhile would move too: the author is asked again.
    const added = applyOperations(s, [{ type: 'page.create', title: 'Baths', route: '/lookbook/baths/' }]).state;
    expect(checkHeld(added, ops, base).kind).toBe('changed');
    // So would a page inside it that moved within it.
    const renamed = applyOperations(s, [{ type: 'page.update', pageId: 'pg_spring01', route: '/lookbook/kitchens/spring-2026/' }]).state;
    expect(checkHeld(renamed, ops, base).kind).toBe('changed');
    // A page elsewhere does not matter.
    const elsewhere = applyOperations(s, [{ type: 'page.create', title: 'Baths', route: '/baths/' }]).state;
    expect(checkHeld(elsewhere, ops, base).kind).toBe('apply');
    // An old address kept at the destination meanwhile would be taken over: that is asked again too.
    const made = applyOperations(s, [{ type: 'page.create', pageId: 'pg_workold', title: 'Work', route: '/work/lookbook/' }]).state;
    const taken = applyOperations(made, [{ type: 'page.update', pageId: 'pg_workold', route: '/work-old/' }]).state;
    expect(taken.site.redirects).toEqual([{ from: '/work/lookbook/', pageId: 'pg_workold' }]);
    expect(checkHeld(taken, ops, base).kind).toBe('changed');
    // However the address was typed.
    const typed = [{ type: 'page.update' as const, pageId: 'pg_lookbook', route: ' Work/Lookbook ' }];
    expect(checkHeld(taken, typed, readFields(s, typed)!.map((r) => (r.found ? r.value : undefined))).kind).toBe('changed');
  });

  it('reports the pages a move carried along, and counts every page as changed', async () => {
    const { describeOps, pagesTouched } = await import('@agent/report');
    const s = lookbook();
    const ops = [{ type: 'page.update' as const, pageId: 'pg_lookbook', route: '/work/' }];
    const r = applyOperations(s, ops);
    const labels = describeOps(ops, s, r.state, r.results).map((c) => c.label);
    expect(labels).toEqual(['Changed the address of page Lookbook', 'Moved Kitchens (now /work/kitchens/) and Spring (now /work/kitchens/spring/) with it; old addresses keep working']);
    expect(pagesTouched(ops, r.state)).toBe('all');
    // Moved again later in the run: the report says where they ended up, and only promises what still holds.
    const again = applyOperations(r.state, [{ type: 'page.update', pageId: 'pg_kitchens', route: '/rooms/' }]).state;
    expect(describeOps(ops, s, again, r.results).at(-1)!.label).toBe('Moved Kitchens (now /rooms/) and Spring (now /rooms/spring/) with it; old addresses keep working');
    // A page made later at one of the old addresses takes it over: the report no longer promises it.
    const taken = applyOperations(s, [...ops, { type: 'page.create', title: 'Kitchens archive', route: '/lookbook/kitchens/' }]);
    expect(describeOps(ops, s, taken.state, taken.results.slice(0, 1)).at(-1)!.label).toBe('Moved Kitchens (now /work/kitchens/) and Spring (now /work/kitchens/spring/) with it');
    // A page with nothing inside it changes where links to it lead on other pages too.
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_spring01', route: '/spring/' }], r.state)).toBe('all');
    expect(pagesTouched([{ type: 'page.update', pageId: 'pg_lookbook', seoTitle: 'Lookbook' }], r.state)).toEqual(new Set(['pg_lookbook']));
  });
});
