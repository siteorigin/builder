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
import { generateHostRedirects } from '@generator/host-redirects';
import { generateProject, liveRedirects, publishedState, redirectFile, siteEntries } from '@generator/index';
import { planPageAddress } from '@shared/page-address';
import { redirectRecords } from '@shared/redirects';
import { routeOwners } from '@shared/collections';
import { publicationState } from '../../src/main/publication';
import { planPageRemoval } from '../../src/renderer/src/lib/page-removal';
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
    const declined = applyOperations(exported(withPage()), [{ type: 'page.setHome', pageId: 'pg_services', keepOldAddress: false }]).state;
    expect(redirects(declined)).toEqual([]);
    expect(liveRedirects(declined)).toEqual([]);
  });
});

describe('addresses exported for a page that has left them some other way (#1382)', () => {
  /** Services exported at /services/, moved to /what-we-do/ and exported again, then put back as Undo does: the documents from before the move. */
  function undoneMove(): ProjectState {
    const first = exported(withPage());
    const moved = exported(applyOperations(first, [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }]).state);
    return { ...first, published: moved.published };
  }
  const kept = (s: ProjectState) => redirectRecords(s).map((r) => [r.from, r.pageId ?? r.to]);

  it('keeps the newer address working, as an old address the site lists, without writing it', () => {
    const s = undoneMove();
    expect(s.pages.pg_services.route).toBe('/services/');
    expect(redirects(s)).toEqual([]);
    expect(kept(s)).toEqual([['/what-we-do/', 'pg_services']]);
    expect(liveRedirects(s).map((r) => [r.from, r.to])).toEqual([['/what-we-do/', '/services/']]);
    // A new page is never given it without asking, and a collection cannot take it.
    expect(applyOperations(s, [{ type: 'page.create', pageId: 'pg_wwd', title: 'What we do' }]).state.pages.pg_wwd.route).not.toBe('/what-we-do/');
    expect(routeOwners(s).some((o) => o.kind === 'redirect' && o.route === '/what-we-do/' && o.pageId === 'pg_services')).toBe(true);
  });

  it('stays gone once the author removes it, until the removal is undone', () => {
    const s = undoneMove();
    const removed = applyOperations(s, [{ type: 'redirect.remove', from: '/what-we-do/' }]).state;
    expect(kept(removed)).toEqual([]);
    expect(removed.site.droppedAddresses).toEqual([{ from: '/what-we-do/', pageId: 'pg_services' }]);
    expect(generateHostRedirects(removed)).toBeNull();
    // Undo puts back the site settings from before, where it was kept.
    expect(kept({ ...removed, site: s.site })).toEqual([['/what-we-do/', 'pg_services']]);
  });

  it('stays gone when the author removes the redirect a move recorded for it', () => {
    const moved = applyOperations(exported(withPage()), [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }]).state;
    expect(redirects(moved)).toEqual([{ from: '/services/', pageId: 'pg_services' }]);
    const removed = applyOperations(moved, [{ type: 'redirect.remove', from: '/services/' }]).state;
    expect(redirects(removed)).toEqual([]);
    expect(kept(removed)).toEqual([]);
    // Nor does sending it somewhere else bring the page's back.
    const elsewhere = applyOperations(moved, [{ type: 'redirect.update', from: '/services/', to: '/about/' }]).state;
    expect(kept(elsewhere)).toEqual([['/services/', '/about/']]);
    // Nor once that redirect goes later, by the author's removal or a page taking its address for a while.
    expect(kept(applyOperations(elsewhere, [{ type: 'redirect.remove', from: '/services/' }]).state)).toEqual([]);
    const passing = oneByOne(elsewhere, [
      { type: 'page.create', pageId: 'pg_temp', title: 'Temporary', route: '/services/' },
      { type: 'page.update', pageId: 'pg_temp', route: '/temporary/' }
    ]);
    expect(kept(passing)).toEqual([]);
  });

  it('is sent somewhere else as a redirect of the site’s own, and refused as a new one', () => {
    const s = undoneMove();
    const sent = applyOperations(s, [{ type: 'redirect.update', from: '/what-we-do/', to: '/about/' }]).state;
    expect(redirects(sent)).toEqual([{ from: '/what-we-do/', to: '/about/' }]);
    expect(kept(sent)).toEqual([['/what-we-do/', '/about/']]);
    expect(() => applyOperations(s, [{ type: 'redirect.add', from: '/what-we-do/', pageId: 'pg_services' }])).toThrow(/already sends visitors on/);
  });

  it('gives way to a page that takes the address, and to one an export delivered there since', () => {
    const s = undoneMove();
    const taken = applyOperations(s, [{ type: 'page.create', pageId: 'pg_wwd', title: 'What we do', route: '/what-we-do/' }]).state;
    expect(kept(taken)).toEqual([]);
    // Exported there and moved on, the address leads to that page now.
    const movedOn = exported(taken);
    const left = applyOperations(movedOn, [{ type: 'page.update', pageId: 'pg_wwd', route: '/our-work/' }]).state;
    expect(kept(left)).toEqual([['/what-we-do/', 'pg_wwd']]);
    // A draft there leaves it working until it is published.
    const draft = applyOperations(s, [{ type: 'page.create', pageId: 'pg_wwd', title: 'What we do', route: '/what-we-do/', draft: true }]).state;
    expect(kept(draft)).toEqual([['/what-we-do/', 'pg_services']]);
    expect(liveRedirects(publishedState(draft)).map((r) => [r.from, r.to])).toEqual([['/what-we-do/', '/services/']]);
    // Published, it takes the address over.
    expect(kept(applyOperations(draft, [{ type: 'page.update', pageId: 'pg_wwd', draft: false }]).state)).toEqual([]);
  });

  it('keeps nothing for a page removed since, or for a new Home page told not to keep its address', () => {
    expect(kept(applyOperations(undoneMove(), [{ type: 'page.remove', pageId: 'pg_services' }]).state)).toEqual([]);
    // Removed with a replacement, it leads there, as the redirects kept for the page do.
    const undone = undoneMove();
    const home = undone.site.homePageId;
    expect(kept(applyOperations(undone, [{ type: 'page.remove', pageId: 'pg_services', replacementPageId: home }]).state)).toEqual([['/what-we-do/', home]]);
    // The page replacing a removed Home leaves its own address behind: it is not moved, Home is removed.
    const s = exported(withPage());
    const replaced = applyOperations(s, [{ type: 'page.remove', pageId: s.site.homePageId, replacementPageId: 'pg_services' }]).state;
    expect(replaced.pages.pg_services.route).toBe('/');
    expect(kept(replaced)).toEqual([]);
    const declined = applyOperations(exported(withPage()), [{ type: 'page.setHome', pageId: 'pg_services', keepOldAddress: false }]).state;
    expect(kept(declined)).toEqual([]);
    expect(declined.site.droppedAddresses).toEqual([{ from: '/services/', pageId: 'pg_services' }]);
  });

  it('keeps an address under a collection’s that no entry or archive page of it holds', () => {
    let s = applyOperations(withPage(), [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter workshop', publishedAt: '2026-01-12', draft: false, body: ['Bring an apron.'] }
    ]).state;
    const entry = siteEntries(s).find((e) => e.entry.id === 'en_winter')!.route;
    const prefix = s.collections.posts.settings.route;
    s = { ...s, published: { pages: { [`${prefix}team/`]: 'pg_services', [entry]: 'pg_services', [`${prefix}page/2/`]: 'pg_services' } } };
    expect(kept(s)).toEqual([[`${prefix}team/`, 'pg_services']]);
  });

  it('is never taken silently by a page moved along with its parent', () => {
    let s = applyOperations(withPage(), [
      { type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook' },
      { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/lookbook/kitchens/' }
    ]).state;
    s = { ...s, published: { pages: { '/gallery/kitchens/': 'pg_services' } } };
    expect(planPageAddress(s, 'pg_lookbook', '/gallery/')).toEqual({ error: expect.stringContaining('an old address kept working for “Services”') });
  });

  it('follows a removed page to the replacement the delete dialog offers, though nothing links to it', () => {
    const s = undoneMove();
    const home = s.site.homePageId;
    expect(planPageRemoval(s, 'pg_services', home, new Map()).operations).toEqual([{ type: 'page.remove', pageId: 'pg_services', replacementPageId: home }]);
  });

  it('is left out once the author sends it to a draft, by the website and by the publication', () => {
    const s = applyOperations(undoneMove(), [
      { type: 'page.create', pageId: 'pg_soon', title: 'Coming soon', route: '/coming-soon/', draft: true },
      { type: 'redirect.update', from: '/what-we-do/', pageId: 'pg_soon' }
    ]).state;
    expect(kept(s)).toEqual([['/what-we-do/', 'pg_soon']]);
    expect(liveRedirects(publishedState(s))).toEqual([]);
    expect(publicationState(s).site.redirects).toBeUndefined();
  });

  it('is a redirect of the publication beside the site’s own, which keep their order', () => {
    const s = applyOperations(undoneMove(), [{ type: 'redirect.add', from: '/old-team/', to: '/about/' }]).state;
    expect(publicationState(s).site.redirects).toEqual([
      { from: '/old-team/', custom: true, to: '/about/' },
      { from: '/what-we-do/', pageId: 'pg_services' }
    ]);
  });

  it('is a redirect of the publication, which carries no record of exports or of the addresses dropped', () => {
    const s = undoneMove();
    const published = publicationState(s);
    expect(published.published).toBeUndefined();
    expect(published.site.redirects).toEqual([{ from: '/what-we-do/', pageId: 'pg_services' }]);
    const removed = publicationState(applyOperations(s, [{ type: 'redirect.remove', from: '/what-we-do/' }]).state);
    expect(removed.site.redirects).toBeUndefined();
    expect(removed.site.droppedAddresses).toBeUndefined();
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

  it('keeps a page’s exported newer address working when Undo takes it back off it (#1382)', async () => {
    const { s } = await session();
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }] }, { label: 'Change page address' })).ok).toBe(true);
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/services/');
    // The next export sends the newer address on to the page, by host rule and by its own page.
    const live = publishedState(s.state);
    expect(liveRedirects(live).map((r) => [r.from, r.to])).toEqual([['/what-we-do/', '/services/']]);
    expect(generateHostRedirects(live)).toContain('/what-we-do/ /services/ 301');
    expect(generateProject(live).get(redirectFile('/what-we-do/'))).toContain('/services/');
    // Redo still puts the page back where it was moved, keeping its first address working.
    expect((await s.redo()).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/what-we-do/');
    expect(liveRedirects(publishedState(s.state)).map((r) => [r.from, r.to])).toEqual([['/services/', '/what-we-do/']]);
    await s.close();
  });

  it('keeps a kept address the author removed gone, until the removal is undone', async () => {
    const { s } = await session();
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }] }, { label: 'Change page address' })).ok).toBe(true);
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.undo()).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'redirect.remove', from: '/what-we-do/' }] }, { label: 'Remove redirect' })).ok).toBe(true);
    expect(generateProject(publishedState(s.state)).has(redirectFile('/what-we-do/'))).toBe(false);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' })).ok).toBe(true);
    // Undoing what came after leaves it removed; undoing the removal brings it back, and Redo takes it away again.
    expect((await s.undo()).ok).toBe(true);
    expect(liveRedirects(publishedState(s.state))).toEqual([]);
    expect((await s.undo()).ok).toBe(true);
    expect(liveRedirects(publishedState(s.state)).map((r) => [r.from, r.to])).toEqual([['/what-we-do/', '/services/']]);
    expect((await s.redo()).ok).toBe(true);
    expect(liveRedirects(publishedState(s.state))).toEqual([]);
    await s.close();
  });

  it('keeps every exported address leading straight back when History steps back over several moves, and on redo', async () => {
    const { s } = await session();
    const move = async (route: string) => expect((await s.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', route }] }, { label: 'Change page address' })).ok).toBe(true);
    const saved = await s.saveVersion('Before any move');
    expect(saved.ok).toBe(true);
    expect(await s.recordPublished(s.state)).toBeNull();
    await move('/what-we-do/');
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' })).ok).toBe(true);
    await move('/our-work/');
    expect(await s.recordPublished(s.state)).toBeNull();
    const live = () => liveRedirects(publishedState(s.state)).map((r) => [r.from, r.to]);
    const first = s.historyInfo().entries[0];
    expect((await s.stepTo(first.id, 'undo')).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/services/');
    expect(live()).toEqual([
      ['/our-work/', '/services/'],
      ['/what-we-do/', '/services/']
    ]);
    // Put back one step at a time, each address leads to where the page is then.
    expect((await s.redo()).ok).toBe(true);
    expect(live()).toEqual([
      ['/services/', '/what-we-do/'],
      ['/our-work/', '/what-we-do/']
    ]);
    expect((await s.redo()).ok).toBe(true);
    expect((await s.redo()).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/our-work/');
    expect(live().sort()).toEqual([
      ['/services/', '/our-work/'],
      ['/what-we-do/', '/our-work/']
    ]);
    // And back one step at a time, past the unrelated rename too.
    for (let i = 0; i < 3; i++) expect((await s.undo()).ok).toBe(true);
    expect(live()).toEqual([
      ['/our-work/', '/services/'],
      ['/what-we-do/', '/services/']
    ]);
    // A version from before the moves puts the page back where it was, its later addresses kept working.
    await move('/our-work/');
    expect((await s.restoreVersion(saved.id!, s.revision)).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/services/');
    expect(live()).toEqual([
      ['/our-work/', '/services/'],
      ['/what-we-do/', '/services/']
    ]);
    await s.close();
  });

  it('keeps nothing when Undo takes a page off an address no export delivered', async () => {
    const { s } = await session();
    expect(await s.recordPublished(s.state)).toBeNull();
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', route: '/what-we-do/' }] }, { label: 'Change page address' })).ok).toBe(true);
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.pages.pg_services.route).toBe('/services/');
    expect(liveRedirects(publishedState(s.state))).toEqual([]);
    expect(generateHostRedirects(publishedState(s.state))).toBeNull();
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
