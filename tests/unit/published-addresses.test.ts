/**
 * Page addresses and their old addresses (#890): an address problem is told in the Address field's own words, and a
 * page that moves keeps an old address working only when the website was exported with it, so correcting a new page's
 * address leaves nothing behind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, planHomeChange } from '@engine/apply';
import { headerMenu, headerMenuRoom } from '@engine/tree';
import { planPageAddress } from '@shared/page-address';
import { PUBLISHED_FILE, publishedDocProblem, publishedPageAt, wasPublishedFor, withPublished } from '@shared/published';
import { validateRoute } from '@shared/routes';
import { isCanonicalPath, stateToDocs } from '../../src/main/project/documents';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Test Studio', false);
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
/** Each operation as its own batch, as the Inspector sends each edit of the Address field. */
const oneByOne = (s: ProjectState, ops: EditOperation[]) => ops.reduce((st, op) => applyOperations(st, [op]).state, s);
/** The project once an export has delivered it as it is now. */
const exported = (s: ProjectState): ProjectState => ({ ...s, published: withPublished(s.published, s) ?? s.published });
const redirects = (s: ProjectState) => s.site.redirects ?? [];

function withPage(): ProjectState {
  return applyOperations(fresh(), [{ type: 'page.create', pageId: 'pg_services', title: 'Services' }]).state;
}

describe('old addresses of pages never exported', () => {
  it('keeps none when a new page’s address is corrected five times', () => {
    const s = oneByOne(
      withPage(),
      ['/servces/', '/service/', '/our-services/', '/what-we-do/', '/services-and-pricing/'].map((route) => ({ type: 'page.update', pageId: 'pg_services', route }) as EditOperation)
    );
    expect(s.pages.pg_services.route).toBe('/services-and-pricing/');
    expect(redirects(s)).toEqual([]);
  });

  it('keeps the exported address working, and only that one, through later corrections', () => {
    const s = oneByOne(exported(withPage()), [
      { type: 'page.update', pageId: 'pg_services', route: '/our-services/' },
      { type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }
    ]);
    expect(redirects(s)).toEqual([{ from: '/services/', pageId: 'pg_services' }]);
  });

  it('keeps an exported address only for the page it was exported as', () => {
    // Services was exported at /services/, then removed; a new page took the address and moves on before any export.
    let s = exported(withPage());
    s = oneByOne(s, [
      { type: 'page.remove', pageId: 'pg_services' },
      { type: 'page.create', pageId: 'pg_newsvc', title: 'New services', route: '/services/' },
      { type: 'page.update', pageId: 'pg_newsvc', route: '/new-services/' }
    ]);
    expect(redirects(s).some((r) => r.from === '/services/')).toBe(false);
  });

  it('keeps the exported addresses of pages moved along with a parent, and no others', () => {
    let s = applyOperations(fresh(), [{ type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook' }, { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/lookbook/kitchens/' }]).state;
    s = exported(s);
    // Added after the export: its address was never published.
    s = applyOperations(s, [{ type: 'page.create', pageId: 'pg_baths', title: 'Baths', route: '/lookbook/baths/' }]).state;
    s = applyOperations(s, [{ type: 'page.update', pageId: 'pg_lookbook', route: '/gallery/' }]).state;
    expect(byTitle(s, 'Baths').route).toBe('/gallery/baths/');
    expect(redirects(s)).toEqual([
      { from: '/lookbook/', pageId: 'pg_lookbook' },
      { from: '/lookbook/kitchens/', pageId: 'pg_kitchens' }
    ]);
  });

  it('keeps a new Home page’s old address only when it was exported', () => {
    const notYet = applyOperations(withPage(), [{ type: 'page.setHome', pageId: 'pg_services', keepOldAddress: true }]).state;
    expect(redirects(notYet)).toEqual([]);
    expect(planHomeChange(withPage(), 'pg_services', true).kept).toBeUndefined();
    const after = applyOperations(exported(withPage()), [{ type: 'page.setHome', pageId: 'pg_services', keepOldAddress: true }]).state;
    expect(redirects(after)).toEqual([{ from: '/services/', pageId: 'pg_services' }]);
    expect(planHomeChange(exported(withPage()), 'pg_services', true).kept).toBe('/services/');
    // Declined, an exported address is not kept either.
    expect(redirects(applyOperations(exported(withPage()), [{ type: 'page.setHome', pageId: 'pg_services', keepOldAddress: false }]).state)).toEqual([]);
  });
});

describe('the record of exported addresses', () => {
  it('adds every page address an export delivered, keeping earlier ones, and says when nothing changed', () => {
    const s = withPage();
    const first = withPublished(undefined, s)!;
    expect(publishedPageAt({ published: first }, '/services/')).toBe('pg_services');
    expect(publishedPageAt({ published: first }, '/SERVICES/')).toBe('pg_services');
    expect(withPublished(first, s)).toBeUndefined();
    const moved = applyOperations({ ...s, published: first }, [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }]).state;
    const second = withPublished(first, moved)!;
    expect(wasPublishedFor({ published: second }, '/services/', 'pg_services')).toBe(true);
    expect(wasPublishedFor({ published: second }, '/what-we-do/', 'pg_services')).toBe(true);
    expect(Object.keys(second.pages)).toEqual([...Object.keys(second.pages)].sort());
    // An address exported later for another page belongs to that page from then on.
    const taken = applyOperations(moved, [{ type: 'page.create', pageId: 'pg_newsvc', title: 'New services', route: '/services/' }]).state;
    expect(publishedPageAt({ published: withPublished(second, taken) }, '/services/')).toBe('pg_newsvc');
  });

  it('is a canonical document of its own, written once there is a record', () => {
    expect(isCanonicalPath(PUBLISHED_FILE)).toBe(true);
    expect(stateToDocs(withPage()).has(PUBLISHED_FILE)).toBe(false);
    const docs = stateToDocs(exported(withPage()));
    expect(JSON.parse(docs.get(PUBLISHED_FILE)!).pages['/services/']).toBe('pg_services');
    expect(publishedDocProblem(JSON.parse(docs.get(PUBLISHED_FILE)!))).toBeNull();
    expect(publishedDocProblem({ pages: { services: 'pg_services' } })).toMatch(/not an address/);
    expect(publishedDocProblem([])).toMatch(/not a record/);
    expect(publishedDocProblem({ pages: { '/services/': 42 } })).toMatch(/not an address and a page ID/);
  });
});

describe('address problems in the Address field’s words', () => {
  it('names the address, not a route, and says what it may hold', () => {
    const s = withPage();
    const problem = (input: string) => {
      const plan = planPageAddress(s, 'pg_services', input);
      return 'error' in plan ? plan.error : null;
    };
    expect(problem('/bad!/')).toBe('"bad!" can’t be part of an address: start it with a letter or number, and use only letters, numbers and hyphens.');
    expect(problem('/a/b/c/d/e/')).toBe('An address can be at most four levels deep.');
    expect(problem('/')).toBe('Only the Home page can be at "/".');
    expect(problem('/assets/')).toMatch(/^The address "\/assets\/" is kept for the website’s own files/);
    // The home page's and the not-found page's own files: a page there fails the production build unless something links to it.
    for (const kept of ['/index/', '/404/']) expect(problem(kept)).toMatch(/is kept for the website’s own files/);
    for (const deeper of ['/index/old/', '/404/old/']) expect(problem(deeper)).toBeNull();
    expect(problem('/about/')).toBe('Another page already uses /about/.');
    expect(problem(`/${'a'.repeat(61)}/`)).toBe('Each part of an address can be at most 60 characters.');
    // Capitals, accents and spaces are spelled as addresses spell them, never refused.
    expect(planPageAddress(s, 'pg_services', 'Café Menu')).toEqual({ route: '/cafe-menu/', moves: [{ pageId: 'pg_services', from: '/services/', to: '/cafe-menu/' }] });
    for (const m of [validateRoute('/a//b/'), validateRoute('/../'), validateRoute('a/')]) expect(m).toMatch(/^An address /);
  });

  it('refuses in the engine with the reason the field shows', () => {
    expect(() => applyOperations(withPage(), [{ type: 'page.update', pageId: 'pg_services', route: '/bad!/' }])).toThrow('"bad!" can’t be part of an address');
  });
});

describe('recording an export in the project', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function session() {
    const dir = mkdtempSync(join(tmpdir(), 'so-published-'));
    dirs.push(dir);
    return { dir, s: await ProjectSession.create(dir, withPage()) };
  }
  const onDisk = (dir: string) => (existsSync(join(dir, PUBLISHED_FILE)) ? JSON.parse(readFileSync(join(dir, PUBLISHED_FILE), 'utf8')) : null);

  it('keeps the record through undo, reopening and restoring a version, and keeps the exported address on the next move', async () => {
    const { dir, s } = await session();
    const saved = await s.saveVersion('Before the export');
    expect(saved.ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' })).ok).toBe(true);
    expect(await s.recordPublished(s.state)).toBeNull();
    expect(onDisk(dir)?.pages['/services/']).toBe('pg_services');
    // The export is no step of History: the edit before it still undoes, and the record stays.
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.site.name).toBe('Test Studio');
    expect(wasPublishedFor(s.state, '/services/', 'pg_services')).toBe(true);
    // Restoring a version from before the export never takes it back.
    expect((await s.restoreVersion(saved.id!, s.revision)).ok).toBe(true);
    expect(wasPublishedFor(s.state, '/services/', 'pg_services')).toBe(true);
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    expect(wasPublishedFor(again.state, '/services/', 'pg_services')).toBe(true);
    expect((await again.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }] }, { label: 'Change page address' })).ok).toBe(true);
    expect(again.state.site.redirects).toEqual([{ from: '/services/', pageId: 'pg_services' }]);
    await again.close();
  });

  it('records the addresses the export delivered, not where pages have moved since, and writes nothing else', async () => {
    const { s } = await session();
    const delivered = s.state;
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }] }, { label: 'Change page address' })).ok).toBe(true);
    const site = JSON.stringify(s.state.site);
    expect(await s.recordPublished(delivered)).toBeNull();
    expect(wasPublishedFor(s.state, '/services/', 'pg_services')).toBe(true);
    expect(publishedPageAt(s.state, '/what-we-do/')).toBeUndefined();
    expect(JSON.stringify(s.state.site)).toBe(site);
    // So the move stays undoable.
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/services/');
    await s.close();
  });

  it('keeps an export recorded while an AI request runs, however the request ends', async () => {
    for (const end of ['complete', 'abort'] as const) {
      const { s } = await session();
      expect(await s.beginRun(`run_${end}`)).toBeNull();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed by AI' }] }, { label: 'AI', source: 'ai', runId: `run_${end}`, history: false })).ok).toBe(true);
      expect(await s.recordPublished(s.state)).toBeNull();
      if (end === 'complete') {
        expect(await s.completeRun('AI: Rename the site')).toBe(true);
        // Undoing the request takes back its edit, never the export.
        expect((await s.undo()).ok).toBe(true);
      } else expect((await s.abortRun()).restored).toBe(true);
      expect(s.state.site.name).toBe('Test Studio');
      expect(wasPublishedFor(s.state, '/services/', 'pg_services')).toBe(true);
      await s.close();
    }
  });

  it('loads a record changed outside the app without a step of History, so a later export never blocks Undo', async () => {
    const { dir, s } = await session();
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' })).ok).toBe(true);
    // Pulled from another copy of the project: an older export had About at /about-us/.
    writeFileSync(join(dir, PUBLISHED_FILE), JSON.stringify({ pages: { '/about-us/': byTitle(s.state, 'About').id } }, null, 2) + '\n');
    expect((await s.reloadFromDisk()).ok).toBe(true);
    expect(wasPublishedFor(s.state, '/about-us/', byTitle(s.state, 'About').id)).toBe(true);
    expect(s.historyInfo().entries.map((e) => e.label)).not.toContain('External change');
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.site.name).toBe('Test Studio');
    expect(wasPublishedFor(s.state, '/about-us/', byTitle(s.state, 'About').id)).toBe(true);
    expect(wasPublishedFor(s.state, '/services/', 'pg_services')).toBe(true);
    await s.close();
  });

  it('keeps the record out of a version saved after an export, so restoring it takes back no later export', async () => {
    const { s } = await session();
    expect(await s.recordPublished(s.state)).toBeNull();
    const saved = await s.saveVersion('After the first export');
    expect(saved.ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'page.create', pageId: 'pg_team0001', title: 'Team' }] }, { label: 'Add page' })).ok).toBe(true);
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.restoreVersion(saved.id!, s.revision)).ok).toBe(true);
    expect(Object.hasOwn(s.state.pages, 'pg_team0001')).toBe(false);
    expect(wasPublishedFor(s.state, '/team/', 'pg_team0001')).toBe(true);
    await s.close();
  });
});

describe('a full header menu', () => {
  it('is full once it holds as many links as it takes, its design’s defaults counted, as adding a page finds it', () => {
    const s = fresh();
    const menu = headerMenu(s)!;
    const links = (menu.node.props.links ?? menu.schema.default) as Array<Record<string, unknown>>;
    expect(menu.schema.max).toBeGreaterThan(links.length);
    expect(headerMenuRoom(s)).toEqual({ links, max: menu.schema.max, full: false });
    // Filled to the cap, a submenu link counted like any other.
    const filled = structuredClone(s);
    const node = headerMenu(filled)!.node;
    node.props.links = Array.from({ length: menu.schema.max! }, (_, i) => ({ ...links[0], id: `it_${i}`, ...(i === 1 ? { sub: true } : {}) }));
    expect(headerMenuRoom(filled)?.full).toBe(true);
    const r = applyOperations(filled, [{ type: 'page.create', title: 'Extra', addToNavigation: true }]);
    expect(r.results[0].addedToNavigation).toBe(false);
    expect(applyOperations(s, [{ type: 'page.create', title: 'Extra', addToNavigation: true }]).results[0].addedToNavigation).toBe(true);
  });
});
