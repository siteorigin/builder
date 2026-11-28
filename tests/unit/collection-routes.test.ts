/**
 * Collection entries as pages of the website (#393): every published entry is prerendered at its collection's prefix
 * plus its slug, drafts stay out of the website and its sitemap, links between entries follow renames, and a change
 * to one post makes that post's page again and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { entryFile, generateLayout, generateProject, generateSitemap, liveRedirects, publishedState, resolveLink } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { publicationIds, publicationPlan } from '@generator/checks';
import { draftLinksStop, draftSourceNotes, isGeneratedReadme, projectReadme, publishedChanged, withheldRoutes } from '../../src/main/export';
import { withPublished } from '@shared/published';
import { projectDesign } from './fixtures/packs';

/** The project once the website has been exported as it is now: its pages' addresses are kept working when they move (#890). */
const exported = (s: ProjectState): ProjectState => ({ ...s, published: withPublished(s.published, s) ?? s.published });

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

/** A business site with the ready-made blog: two published posts and a draft. */
function blog(baseUrl = 'https://example.com') {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'site.update', baseUrl },
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter workshop', publishedAt: '2026-01-12', draft: false, author: 'Ana Ruiz', excerpt: 'Three evenings of glazing.', body: ['Bring an apron.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2026-03-02', updatedAt: '2026-03-09', draft: false, body: ['Read about [the winter workshop](entry:en_winter).'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans', publishedAt: '2026-04-01', body: ['Not yet.'] }
  );
}

describe('collection entries on the website', () => {
  it('generates a page for every entry, with its date, author and article metadata', () => {
    const s = blog();
    const files = generateProject(s);
    const winter = files.get('src/routes/blog/winter-workshop/+page.svelte')!;
    expect(winter).toBeDefined();
    expect(entryFile('/blog/winter-workshop/')).toBe('src/routes/blog/winter-workshop/+page.svelte');
    expect(winter).toContain('siteorigin/collections/posts/entries/en_winter.json');
    expect(winter).toContain('<time datetime={"2026-01-12"}>{"January 12, 2026"}</time>');
    expect(winter).toContain('{"Ana Ruiz"}');
    expect(winter).toContain('<meta property="og:type" content="article" />');
    expect(winter).toContain('<meta property="article:published_time" content={"2026-01-12"} />');
    expect(winter).toContain('<link rel="canonical" href={"https://example.com/blog/winter-workshop/"} />');
    expect(winter).toContain('<meta name="description" content={"Three evenings of glazing."} />');
    expect(winter).toMatch(/<h1 class=\{\["so-n-[a-z0-9_-]+"\]\}>\{"Winter workshop"\}<\/h1>/);
    expect(files.get('src/routes/blog/spring-open-studio/+page.svelte')).toContain('<meta property="article:modified_time" content={"2026-03-09"} />');
    // The working project has the draft too, as it has draft pages, so the editor can show it.
    expect(files.has('src/routes/blog/secret-plans/+page.svelte')).toBe(true);
    // Nothing of the editor in the page.
    expect(winter).not.toMatch(/data-so-|siteorigin-bridge/);
  });

  it('links entries to each other by their current address, and follows a renamed slug', () => {
    let s = blog();
    expect(resolveLink({ type: 'entry', target: 'en_winter' }, { state: s })).toEqual({ href: '/blog/winter-workshop/' });
    expect(generateProject(s).get('src/routes/blog/spring-open-studio/+page.svelte')).toContain('"href":"/blog/winter-workshop/"');
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'glazing-evenings' });
    expect(resolveLink({ type: 'entry', target: 'en_winter' }, { state: s })).toEqual({ href: '/blog/glazing-evenings/' });
    const files = generateProject(s);
    expect(files.get('src/routes/blog/spring-open-studio/+page.svelte')).toContain('"href":"/blog/glazing-evenings/"');
    expect(files.has('src/routes/blog/glazing-evenings/+page.svelte')).toBe(true);
  });

  it('leaves draft entries out of the website, its sitemap and links to them', () => {
    let s = blog();
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the plans](entry:en_secret).'] });
    const live = publishedState(s);
    expect(Object.keys(live.collections.posts.entries).sort()).toEqual(['en_spring', 'en_winter']);
    // The documents themselves keep the draft.
    expect(s.collections.posts.entries.en_secret).toBeDefined();
    const files = generateProject(live);
    expect([...files.keys()].filter((f) => f.includes('secret-plans'))).toEqual([]);
    expect([...files.values()].some((t) => t.includes('Secret plans') || t.includes('/blog/secret-plans/'))).toBe(false);
    expect(resolveLink({ type: 'entry', target: 'en_secret' }, { state: live })).toBeNull();
    const sitemap = generateSitemap(s)!;
    expect(sitemap).toContain('<url><loc>https://example.com/blog/winter-workshop/</loc><lastmod>2026-01-12</lastmod></url>');
    expect(sitemap).toContain('<url><loc>https://example.com/blog/spring-open-studio/</loc><lastmod>2026-03-09</lastmod></url>');
    expect(sitemap).not.toContain('secret-plans');
  });

  it('makes again only the page of the post that changed', () => {
    let s = blog();
    const cache = new GenerationCache();
    const check = () => {
      const made: string[] = [];
      for (const opts of [{}, { instrument: true }]) {
        expect([...generateProject(s, opts, cache)]).toEqual([...generateProject(s, opts)]);
        made.push(...cache.made);
      }
      return made;
    };
    check();
    expect(check()).toEqual([]);
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['Bring an apron and a towel.'] });
    expect(check()).toEqual(['entry:posts:en_winter#clean', 'entry:posts:en_winter#dev']);
    // A new date changes the post's page, the sitemap that dates it and the feed built that day, nothing else.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', updatedAt: '2026-03-20' });
    expect(check().sort()).toEqual(['entry:posts:en_spring#clean', 'entry:posts:en_spring#dev', 'rss.xml', 'sitemap.xml']);
  });
});

const rename = (entryId: string, slug: string): EditOperation => ({ type: 'entry.update', collectionId: 'posts', entryId, slug });
const kept = (s: ProjectState) => s.site.redirects ?? [];
/** The old addresses kept for entries, apart from a moved collection's archive's (#1548). */
const entryKept = (s: ProjectState) => kept(s).filter((r) => !r.archiveOf);

describe('old addresses of entries', () => {
  it('keeps a published entry’s old address working, following it through later renames', () => {
    let s = run(blog(), rename('en_winter', 'glazing-evenings'));
    expect(kept(s)).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_winter' }]);
    expect(validateState(s).filter((d) => /REDIRECT|ROUTE/.test(d.code))).toEqual([]);
    let files = generateProject(s);
    const old = files.get('src/routes/blog/winter-workshop/+page.svelte')!;
    expect(old).toContain('resolve("/blog/glazing-evenings/")');
    expect(old).toContain('<link rel="canonical" href={"https://example.com/blog/glazing-evenings/"} />');
    expect(liveRedirects(s).map((r) => [r.from, r.to])).toEqual([['/blog/winter-workshop/', '/blog/glazing-evenings/']]);
    // The old address shows no header or footer while it sends visitors on.
    expect(generateLayout(s, {})).toContain('"/blog/winter-workshop"');
    // Renamed again, both old addresses go straight to the newest.
    s = run(s, rename('en_winter', 'glaze'));
    expect(kept(s)).toEqual([
      { from: '/blog/winter-workshop/', entryId: 'en_winter' },
      { from: '/blog/glazing-evenings/', entryId: 'en_winter' }
    ]);
    files = generateProject(s);
    for (const from of ['winter-workshop', 'glazing-evenings']) expect(files.get(`src/routes/blog/${from}/+page.svelte`)).toContain('resolve("/blog/glaze/")');
    // Taking an old address back makes it the entry's own again.
    s = run(s, rename('en_winter', 'winter-workshop'));
    expect(kept(s)).toEqual([
      { from: '/blog/glazing-evenings/', entryId: 'en_winter' },
      { from: '/blog/glaze/', entryId: 'en_winter' }
    ]);
    expect(generateProject(s).get('src/routes/blog/winter-workshop/+page.svelte')).toMatch(/<h1 class=\{\["so-n-[a-z0-9_-]+"\]\}>\{"Winter workshop"\}<\/h1>/);
  });

  it('keeps nothing for a draft, for one published in the same change, or for a slug it only passed through', () => {
    // A draft's address is one no visitor has.
    expect(kept(run(blog(), rename('en_secret', 'plans')))).toEqual([]);
    expect(kept(run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false, slug: 'plans' }))).toEqual([]);
    expect(kept(run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false }, rename('en_secret', 'plans')))).toEqual([]);
    // A rename through a spare slug keeps the address visitors knew, not the spare one.
    expect(kept(run(blog(), rename('en_winter', 'spare'), rename('en_winter', 'final')))).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_winter' }]);
  });

  it('keeps an entry’s old address from every other entry, and lets a page take it over', () => {
    const s = run(blog(), rename('en_winter', 'glazing-evenings'));
    expect(() => run(s, rename('en_spring', 'winter-workshop'))).toThrow(/old address of “Winter workshop”/);
    expect(() => run(s, { type: 'entry.create', collectionId: 'posts', title: 'Other', slug: 'winter-workshop' })).toThrow(/old address/);
    // A new entry with the same title is numbered around it.
    const again = applyOperations(s, [{ type: 'entry.create', collectionId: 'posts', title: 'Winter workshop' }]);
    expect(again.results[0].route).toBe('/blog/winter-workshop-2/');
    // A page given the address takes it over, as it does a page's old address.
    const page = run(s, { type: 'page.create', pageId: 'pg_winterws', title: 'Workshop', route: '/blog/winter-workshop/' });
    expect(kept(page)).toEqual([]);
    expect(page.pages.pg_winterws.route).toBe('/blog/winter-workshop/');
  });

  it('keeps every published entry’s address when the collection moves, and settles old addresses when entries go', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    // Its index's old address too (#1548).
    expect(kept(s)).toEqual([
      { from: '/blog/winter-workshop/', entryId: 'en_winter' },
      { from: '/blog/spring-open-studio/', entryId: 'en_spring' },
      { from: '/blog/', to: '/journal/', archiveOf: 'posts' }
    ]);
    expect(generateProject(s).get('src/routes/blog/winter-workshop/+page.svelte')).toContain('resolve("/journal/winter-workshop/")');
    // Moving back takes each address back.
    expect(kept(run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' }))).toEqual([
      { from: '/journal/winter-workshop/', entryId: 'en_winter' },
      { from: '/journal/spring-open-studio/', entryId: 'en_spring' },
      { from: '/journal/', to: '/blog/', archiveOf: 'posts' }
    ]);
    // An entry removed for another sends its old addresses there; without one they go with it.
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!.id;
    expect(entryKept(run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' }))).toEqual([
      { from: '/blog/winter-workshop/', entryId: 'en_spring' },
      { from: '/blog/spring-open-studio/', entryId: 'en_spring' }
    ]);
    expect(entryKept(run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementPageId: about }))).toContainEqual({ from: '/blog/winter-workshop/', pageId: about });
    const unlinked = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] });
    expect(entryKept(run(unlinked, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' }))).toEqual([{ from: '/blog/spring-open-studio/', entryId: 'en_spring' }]);
    s = run(exported(s), { type: 'page.update', pageId: about, route: '/about-us/' });
    expect(entryKept(run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementEntryId: 'en_winter' }, { type: 'collection.remove', collectionId: 'posts' }))).toEqual([{ from: '/about/', pageId: about }]);
  });

  it('refuses to hand links and old addresses to a record with no page of its own (#1495)', () => {
    const s = run(
      blog(),
      rename('en_winter', 'glazing-evenings'),
      { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: false, archive: false } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false }
    );
    const remove = (entryId: string) => ({ type: 'entry.remove' as const, collectionId: 'posts', entryId, replacementEntryId: 'en_ruiz' });
    // Linked from another post, with an old address: neither could reach the record.
    expect(() => run(s, remove('en_winter'))).toThrow(/“Ana Ruiz” has no page of its own/);
    // An old address alone is refused too.
    const unlinked = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] });
    expect(() => run(unlinked, remove('en_winter'))).toThrow(/has no page of its own/);
    // And a link alone.
    expect(() => run(s, { type: 'redirect.remove', from: '/blog/winter-workshop/' }, remove('en_winter'))).toThrow(/has no page of its own/);
    // With nothing to hand over, the replacement is never used.
    expect(run(unlinked, remove('en_secret')).collections.posts.entries).not.toHaveProperty('en_secret');
  });

  it('refuses a record with no page for an address the same change takes back (#1495)', () => {
    const s = run(
      blog(),
      rename('en_winter', 'glazing-evenings'),
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] },
      { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: false, archive: false } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false }
    );
    // Taken back, and the spare address's own redirect removed: only the reclaimed address is left to hand over.
    const remove = (replacementEntryId: string) =>
      run(s, rename('en_winter', 'winter-workshop'), { type: 'redirect.remove', from: '/blog/glazing-evenings/' }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId });
    expect(() => remove('en_ruiz')).toThrow(/has no page of its own/);
    expect(kept(remove('en_spring'))).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_spring' }]);
  });

  it('lets a record with no page take over where reference fields leave no other choice, and brings its address back with the pages (#1495)', () => {
    const s = run(
      blog(),
      { type: 'collection.update', collectionId: 'posts', fields: { next: { type: 'reference', label: 'Next', collection: 'posts' } } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', values: { next: 'en_winter' } },
      rename('en_winter', 'glazing-evenings'),
      { type: 'collection.update', collectionId: 'posts', pages: { detail: false, archive: false } }
    );
    // With no reference to move, a sibling with no page is no way out either.
    expect(() => run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', values: { next: null } }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' })).toThrow(/has no page of its own/);
    const gone = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' });
    expect(gone.collections.posts.entries.en_secret.values.next).toBe('en_spring');
    expect(kept(gone)).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_spring' }]);
    const back = run(gone, { type: 'collection.update', collectionId: 'posts', pages: { detail: true, archive: true } });
    expect(liveRedirects(back).map((r) => [r.from, r.to])).toContainEqual(['/blog/winter-workshop/', '/blog/spring-open-studio/']);
  });

  it('reports an old address that names no entry, or both a page and an entry', () => {
    const s = blog();
    const home = s.site.homePageId;
    const codes = (redirects: unknown) => {
      const t = structuredClone(s);
      t.site.redirects = redirects as never;
      return validateState(t).filter((d) => d.code.startsWith('REDIRECT')).map((d) => d.code);
    };
    expect(codes([{ from: '/old/', entryId: 'en_winter' }])).toEqual([]);
    expect(codes([{ from: '/old/', entryId: 'en_gone' }])).toEqual(['REDIRECT_TARGET']);
    expect(codes([{ from: '/old/', entryId: 'en_winter', pageId: home }])).toEqual(['REDIRECT_INVALID']);
    expect(codes([{ from: '/old/' }])).toEqual(['REDIRECT_INVALID']);
  });
});

describe('draft entries and the website export', () => {
  it('withholds a draft entry’s address and the old addresses that lead to it', () => {
    let s = run(blog(), rename('en_winter', 'glazing-evenings'), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: true });
    const live = publishedState(s);
    expect(live.site.redirects).toBeUndefined();
    expect(liveRedirects(live)).toEqual([]);
    expect(withheldRoutes(s, live)).toEqual([
      { route: '/blog/secret-plans/', draft: 'Secret plans' },
      { route: '/blog/glazing-evenings/', draft: 'Winter workshop' },
      { route: '/blog/winter-workshop/', draft: 'Winter workshop' }
    ]);
    const files = generateProject(live);
    // The published entry's page, and the collection's index listing it alone (#397).
    expect([...files.keys()].filter((f) => f.startsWith('src/routes/blog/'))).toEqual(['src/routes/blog/spring-open-studio/+page.svelte', 'src/routes/blog/+page.svelte']);
    expect(files.get('src/routes/blog/+page.svelte')).toContain('Spring open studio');
    expect(files.get('src/routes/blog/+page.svelte')).not.toContain('Winter workshop');
    // Published again, its old address works again.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: false });
    expect(publishedState(s).site.redirects).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_winter' }]);
  });

  it('lists the entries the website publishes and the drafts it leaves out, beside the pages (#568)', () => {
    const s = blog();
    const plan = publicationPlan(s);
    // Newest first, as the collection lists them; each with the address its page has.
    expect(plan.publishedEntries.map((e) => [e.entry.id, e.collection.settings.id, e.route])).toEqual([
      ['en_spring', 'posts', '/blog/spring-open-studio/'],
      ['en_winter', 'posts', '/blog/winter-workshop/']
    ]);
    expect(plan.draftEntries.map((e) => e.entry.id)).toEqual(['en_secret']);
    // The pages are reported as before.
    expect(plan.drafts).toEqual([]);
    expect(plan.published.length).toBeGreaterThan(0);
    // Every entry published: the plan's short path (no drafts at all) reports them too.
    const all = publicationPlan(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false }));
    expect(all.draftEntries).toEqual([]);
    expect(all.publishedEntries.map((e) => e.entry.id)).toEqual(['en_secret', 'en_spring', 'en_winter']);
    // Only drafts: nothing of the collection is published.
    const onlyDrafts = publicationPlan(run(s, ...['en_winter', 'en_spring'].map((entryId): EditOperation => ({ type: 'entry.update', collectionId: 'posts', entryId, draft: true }))));
    expect(onlyDrafts.publishedEntries).toEqual([]);
    expect(onlyDrafts.draftEntries.map((e) => e.entry.id).sort()).toEqual(['en_secret', 'en_spring', 'en_winter']);
    // Entries of every collection are counted.
    const two = publicationPlan(run(s, { type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' }, { type: 'entry.create', collectionId: 'news', entryId: 'en_news1', title: 'Opening', publishedAt: '2026-05-01', draft: false }));
    expect(two.publishedEntries.map((e) => e.entry.id).sort()).toEqual(['en_news1', 'en_spring', 'en_winter']);
    // A site without collections has none.
    expect(publicationPlan(createStarterState('business', 'Riverside Studio', false))).toMatchObject({ publishedEntries: [], draftEntries: [] });
    // An entry at an address the site cannot have is no page of the website, so it is not counted.
    const damaged = structuredClone(s);
    damaged.collections.posts.entries.en_winter.slug = 'Not a slug';
    expect(publicationPlan(damaged).publishedEntries.map((e) => e.entry.id)).toEqual(['en_spring']);
    // A newer draft hand-edited onto a published post's address does not hide the post: the website gets it once the draft is out.
    const clash = structuredClone(s);
    clash.collections.posts.entries.en_secret.slug = 'winter-workshop';
    const held = publicationPlan(clash);
    expect(held.publishedEntries.map((e) => [e.entry.id, e.route])).toEqual([['en_spring', '/blog/spring-open-studio/'], ['en_winter', '/blog/winter-workshop/']]);
    expect(generateProject(publishedState(clash)).has('src/routes/blog/winter-workshop/+page.svelte')).toBe(true);
  });

  it('stops a website export when the entries it publishes are not the ones the author was shown (#568)', () => {
    const s = blog();
    const shown = publicationIds(publicationPlan(s));
    expect(shown).toEqual(expect.arrayContaining(['entry:en_spring', 'entry:en_winter']));
    expect(shown).not.toContain('entry:en_secret');
    expect(publishedChanged(s, shown)).toBeNull();
    // A hand-edited page that shares an entry's ID is still told apart: the export is not stopped for it.
    const shared = structuredClone(s);
    const [aboutId] = shared.site.pageOrder.filter((id) => id !== shared.site.homePageId);
    shared.pages['en_winter'] = { ...shared.pages[aboutId], id: 'en_winter', route: '/winter-page/' };
    shared.site.pageOrder.push('en_winter');
    expect(publishedChanged(shared, publicationIds(publicationPlan(shared)))).toBeNull();
    // The draft was published while the export was starting: the author saw it counted among the drafts.
    const published = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false });
    expect(publishedChanged(published, shown)?.message).toMatch(/changed while the export was starting/);
    // And a post kept back in its place, with as many entries as before.
    const swapped = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: true });
    expect(publicationIds(publicationPlan(swapped))).toHaveLength(shown.length);
    expect(publishedChanged(swapped, shown)).not.toBeNull();
    // Pages alone are not what this site publishes.
    expect(publishedChanged(s, publicationPlan(s).published.map((p) => p.id))).not.toBeNull();
  });

  it('stops the website export over a typed address of a draft entry, naming it', () => {
    const s = run(blog(), rename('en_secret', 'plans'));
    const home = s.site.homePageId;
    s.pages[home].nodes.n_typed001 = { id: 'n_typed001', kind: 'link', label: 'Our plans', appearance: 'primary', link: { type: 'url', target: 'https://example.com/blog/plans/#soon' } } as never;
    s.pages[home].rootIds.push('n_typed001');
    expect(publicationPlan(s).draftLinks).toEqual([{ owner: { kind: 'page', id: home }, nodeId: 'n_typed001', label: 'Our plans', inText: false, entryId: 'en_secret', anchor: 'soon' }]);
    const stop = draftLinksStop(s)!;
    expect(stop.message).toBe('A published page links to Secret plans, which is a draft and is left out of the website. Change the link or publish the entry, then export again.');
    expect(stop.warnings).toEqual(['Home: “Our plans” goes to Secret plans (/blog/plans/#soon)']);
    // A published entry's address is no draft.
    (s.pages[home].nodes.n_typed001 as { link: { target: string } }).link.target = 'https://example.com/blog/winter-workshop/';
    expect(publicationPlan(s).draftLinks).toEqual([]);
  });

  /** The blog with its header's first link pointed at `target`, a section ID, and the name of that link property. */
  const headerLinkTo = (s: ProjectState, target: string) => {
    const nav = Object.values(s.site.shell.header.nodes).find((n) => n.kind === 'instance') as InstanceNode;
    const linkProp = Object.entries(s.components[nav.definitionId].properties).find(([, p]) => p.type === 'link')?.[0];
    expect(linkProp).toBeDefined();
    return run(s, { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: nav.id, prop: linkProp!, value: { type: 'anchor', target } });
  };
  const sectionMissing = (s: ProjectState) => validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING').map((d) => d.message);

  it('reports a header link to a section of the page it is on, which an entry’s page does not have', () => {
    // The layout's own sections are on every entry's page.
    expect(sectionMissing(headerLinkTo(blog(), 'main'))).toEqual([]);
    // A section of Home's, as a managed design of the project's own: the release's sections are code, which takes no
    // anchor (the Release gap test below).
    let s = blog();
    const def = projectDesign(s, { componentId: 'test.visit', name: 'Visit', properties: {}, parts: {}, build: (b) => b.el('root', 'section', {}, [b.text('heading', 'h2', 'Visit us')]) });
    const home = s.site.homePageId;
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, definitionId: def.id }]);
    s = run(r.state, { type: 'node.setContent', owner: { kind: 'page', id: home }, nodeId: r.results[0].nodeId as string, field: 'anchor', value: 'visit' });
    const found = sectionMissing(headerLinkTo(s, 'visit'));
    expect(found).toHaveLength(1);
    // The collection's index (#397) shows the header too, and has none of a page's sections either.
    expect(found[0]).toMatch(/goes to #visit, but .*2 collection entries and the collection index at \/blog\/ have no section with that ID/);
    expect(found[0]).toMatch(/Entries have none of a page’s sections/);
  });

  it('gives a section of the shipped theme on Home an anchor a header link can go to', () => {
    const s = blog();
    const home = s.pages[s.site.homePageId];
    const anchored = Object.values(home.nodes).find((n) => n.kind === 'instance')!;
    expect(applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: home.id }, nodeId: anchored.id, field: 'anchor', value: 'visit' }]).state.pages[home.id].nodes[anchored.id]).toMatchObject({ anchor: 'visit' });
  });
});

describe('a renamed entry in a cached run', () => {
  it('makes its page, its old address, the pages linking to it, the layout, the sitemap, the RSS feed and llms.txt again, and nothing else', () => {
    let s = blog();
    const cache = new GenerationCache();
    const made = () => {
      const out: string[] = [];
      for (const opts of [{}, { instrument: true }]) {
        expect([...generateProject(s, opts, cache)]).toEqual([...generateProject(s, opts)]);
        out.push(...cache.made);
      }
      return [...new Set(out)].sort();
    };
    made();
    s = run(s, rename('en_winter', 'glazing-evenings'));
    expect(made()).toEqual([
      // The host's 301 rules gain the old address (#581).
      '_redirects',
      // The collection's index links to the entry at its new address (#397).
      'archive:posts:/blog/',
      'entry:posts:en_spring#clean',
      'entry:posts:en_spring#dev',
      'entry:posts:en_winter#clean',
      'entry:posts:en_winter#dev',
      'layout#clean',
      'layout#dev',
      // llms.txt lists the entry at its address.
      'llms.txt',
      'redirect:posts:en_winter:/blog/winter-workshop/',
      // The RSS feed links to the entry at its address (#398).
      'rss.xml',
      'sitemap.xml'
    ]);
    // A change to its text afterwards reaches its own page alone, not its old address.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['New words.'] });
    expect(made()).toEqual(['entry:posts:en_winter#clean', 'entry:posts:en_winter#dev']);
    // Renamed again, the cached old address is made again to go straight to the newest.
    s = run(s, rename('en_winter', 'glaze'));
    expect(made()).toContain('redirect:posts:en_winter:/blog/winter-workshop/');
    expect(generateProject(s, {}, cache).get('src/routes/blog/winter-workshop/+page.svelte')).toContain('resolve("/blog/glaze/")');
    // A change to the collection's name makes its index again, whose heading it is (#397), its entries, whose trail
    // from Home in their structured data (#586) names it, and llms.txt, which lists its entries under it; no other page.
    s = run(s, { type: 'collection.update', collectionId: 'posts', name: 'Journal' });
    expect(made()).toEqual(['archive:posts:/blog/', 'entry:posts:en_spring#clean', 'entry:posts:en_spring#dev', 'entry:posts:en_winter#clean', 'entry:posts:en_winter#dev', 'llms.txt']);
    const entryPage = generateProject(s, {}, cache).get('src/routes/blog/glaze/+page.svelte')!;
    const graph = JSON.parse((JSON.parse(/\{@html ("(?:[^"\\]|\\.)*")\}/.exec(entryPage)![1]) as string).replace(/^<script type="application\/ld\+json">|<\/script>$/g, '')) as { '@graph': Array<{ '@type': string; itemListElement?: Array<{ name: string; item: string }> }> };
    expect(graph['@graph'].find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement!.map((i) => [i.name, i.item])).toEqual([
      ['Home', 'https://example.com/'],
      ['Journal', 'https://example.com/blog/'],
      ['Winter workshop', 'https://example.com/blog/glaze/']
    ]);
    expect(generateProject(s, {}, cache).get('src/routes/blog/+page.svelte')).toContain('{"Journal"}</h1>');
  });
});

describe('old addresses of entries, across a batch', () => {
  const draft = (entryId: string, value: boolean): EditOperation => ({ type: 'entry.update', collectionId: 'posts', entryId, draft: value });

  it('keeps the address a post was published at, whatever its draft flag in between', () => {
    // Withdrawn, renamed and published again in one batch: the address visitors knew still works.
    expect(kept(run(blog(), draft('en_winter', true), rename('en_winter', 'final'), draft('en_winter', false)))).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_winter' }]);
    // Withdrawn and renamed: kept for when it is published again, and out of the website meanwhile.
    const withdrawn = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: true, slug: 'final' });
    expect(kept(withdrawn)).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_winter' }]);
    expect(publishedState(withdrawn).site.redirects).toBeUndefined();
  });

  it('keeps an address an entry inherited from one removed in the same batch through a round trip', () => {
    const s = run(blog(), rename('en_winter', 'glazing-evenings'));
    const after = run(
      s,
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] },
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' },
      rename('en_spring', 'winter-workshop'),
      rename('en_spring', 'spring-open-studio')
    );
    expect(kept(after)).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_spring' }]);
  });

  it('keeps only the addresses visitors knew when the collection moves twice in one batch', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' }, { type: 'collection.update', collectionId: 'posts', route: '/news/' });
    expect(kept(s)).toEqual([
      { from: '/blog/winter-workshop/', entryId: 'en_winter' },
      { from: '/blog/spring-open-studio/', entryId: 'en_spring' },
      { from: '/blog/', to: '/news/', archiveOf: 'posts' }
    ]);
  });

  it('refuses to move a collection onto one of its entries’ addresses, or an entry onto another’s old address', () => {
    expect(() => run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/blog/winter-workshop/' })).toThrow(/address of the entry “Winter workshop”/);
    // Spring leaves /blog/spring/ behind; Winter takes Spring's old slug under /journal/, so moving back would put
    // Winter on Spring's old address.
    let s = run(blog(), rename('en_spring', 'spring'), { type: 'collection.update', collectionId: 'posts', route: '/journal/' }, rename('en_winter', 'spring-open-studio'));
    expect(() => run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' })).toThrow(/old address of “Spring open studio”/);
    // Moving back with no clash takes each entry's own addresses back.
    s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    expect(kept(run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' })).map((r) => r.from)).toEqual(['/journal/winter-workshop/', '/journal/spring-open-studio/', '/journal/']);
  });

  it('gives a page made automatically a numbered address beside an entry’s old address', () => {
    let s = run(blog(), rename('en_winter', 'glazing-evenings'), { type: 'page.create', pageId: 'pg_notes01', title: 'Notes', route: '/blog/notes/' });
    s = run(s, { type: 'page.duplicate', pageId: 'pg_notes01', title: 'Winter workshop' });
    const copy = Object.values(s.pages).find((p) => p.title === 'Winter workshop')!;
    expect(copy.route).toBe('/blog/winter-workshop-2/');
    expect(kept(s)).toEqual([{ from: '/blog/winter-workshop/', entryId: 'en_winter' }]);
  });

  it('takes back an old address kept for an entry ID that is created again', () => {
    const s = blog();
    s.site.redirects = [{ from: '/blog/ghost/', entryId: 'en_ghost' }];
    const after = run(s, { type: 'entry.create', collectionId: 'posts', entryId: 'en_ghost', title: 'Ghost' });
    expect(after.collections.posts.entries.en_ghost.slug).toBe('ghost');
    expect(kept(after)).toEqual([]);
    expect(validateState(after).filter((d) => d.code === 'ROUTE_DUPLICATE')).toEqual([]);
  });

  it('removes only the removed collection’s old addresses, and reports one on another address', () => {
    let s = run(blog(), rename('en_winter', 'glazing-evenings'), { type: 'collection.create', collectionId: 'projects' }, { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall01', title: 'Hall', draft: false });
    s = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall01', slug: 'great-hall' });
    expect(kept(s)).toContainEqual({ from: '/projects/hall/', entryId: 'en_hall01' });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] }, { type: 'collection.remove', collectionId: 'posts' });
    expect(kept(s)).toEqual([{ from: '/projects/hall/', entryId: 'en_hall01' }]);
    const clash = structuredClone(s);
    clash.site.redirects = [{ from: '/about/', entryId: 'en_hall01' }];
    expect(validateState(clash).map((d) => d.code)).toContain('ROUTE_DUPLICATE');
    // The page keeps its address in the website: the old address is left out.
    expect(liveRedirects(clash)).toEqual([]);
  });
});

describe('entry pages in more detail', () => {
  it('writes the date as readers of the site’s language do, shows its picture and dates a same-day revision', () => {
    let s = blog();
    s.assets.assets.img_hall = { id: 'img_hall', name: 'Hall', file: 'static/assets/hall-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1600, height: 900, hash: 'h', kind: 'image', altSuggestion: 'The great hall', createdAt: '2026-01-01T00:00:00.000Z' };
    s = run(s, { type: 'site.update', language: 'fr' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', featuredImage: 'img_hall', updatedAt: '2026-01-12' });
    const page = generateProject(s).get('src/routes/blog/winter-workshop/+page.svelte')!;
    expect(page).toContain('<time datetime={"2026-01-12"}>{"12 janvier 2026"}</time>');
    expect(page).toContain('<meta property="article:modified_time" content={"2026-01-12"} />');
    expect(page).toContain('<SoImage image={{"src":"/assets/hall-1a2b3c4d.jpg","alt":"The great hall","width":1600,"height":900}}');
    expect(page).toContain('<meta property="og:image" content={"https://example.com/assets/hall-1a2b3c4d.jpg"} />');
  });

  it('keeps a chosen order without its drafts, and shows a link to a draft as its words', () => {
    let s = run(blog(), { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_secret', 'en_winter', 'en_spring'] });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the plans](entry:en_secret).'] });
    const live = publishedState(s);
    expect(live.collections.posts.settings.entryOrder).toEqual(['en_winter', 'en_spring']);
    const page = generateProject(live).get('src/routes/blog/winter-workshop/+page.svelte')!;
    expect(page).toContain('{"text":"the plans"}');
  });

  it('links to an entry in another collection, and follows a collection that moves', () => {
    let s = run(blog(), { type: 'collection.create', collectionId: 'case-studies', route: '/work/studies/' }, { type: 'entry.create', collectionId: 'case-studies', entryId: 'en_hall01', title: 'Hall', draft: false });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['See [the hall](entry:en_hall01) and [hours](entry:en_winter).'] });
    expect(generateProject(s).has('src/routes/work/studies/hall/+page.svelte')).toBe(true);
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    const spring = generateProject(s).get('src/routes/journal/spring-open-studio/+page.svelte')!;
    expect(spring).toContain('"href":"/work/studies/hall/"');
    expect(spring).toContain('"href":"/journal/winter-workshop/"');
  });
});

describe('links in entries that the website cannot follow', () => {
  it('reports a section an entry’s page or the linked page does not have', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [details](#not-here), [the top](#main) and [About](/about/#not-here).'] });
    const found = validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING');
    expect(found.map((d) => d.owner)).toEqual([
      { kind: 'entry', id: 'en_winter' },
      { kind: 'entry', id: 'en_winter' }
    ]);
    expect(found[0].message).toMatch(/^Winter workshop \(Posts\): the “details” link in the text goes to #not-here, but its page has no section with that ID/);
    expect(found[1].message).toMatch(/goes to #not-here on About, but that page has no section with that ID/);
  });

  it('stops the website export over a published entry’s link to a draft, naming the entry', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the plans](entry:en_secret) and [typed](https://example.com/blog/secret-plans/).'] });
    expect(publicationPlan(s).draftLinks).toEqual([
      { owner: { kind: 'entry', id: 'en_winter' }, nodeId: '', label: 'the plans', inText: true, entryId: 'en_secret' },
      { owner: { kind: 'entry', id: 'en_winter' }, nodeId: '', label: 'typed', inText: true, entryId: 'en_secret' }
    ]);
    expect(draftLinksStop(s)!.warnings).toEqual(['Winter workshop (Posts): “the plans” goes to Secret plans (/blog/secret-plans/)', 'Winter workshop (Posts): “typed” goes to Secret plans (/blog/secret-plans/)']);
    // A draft's own links are not checked.
    expect(publicationPlan(run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', body: ['[x](entry:en_secret)'] })).draftLinks).toEqual([]);
  });

  it('names a draft entry in the exported project’s notes, and catches a typed old address of one', () => {
    let s = blog();
    expect(draftSourceNotes(s)).toEqual(['The draft Secret plans is kept in the project to edit in SiteOrigin Builder, and left out of its website build.']);
    s = run(s, rename('en_winter', 'glazing-evenings'), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: true });
    const home = s.site.homePageId;
    s.pages[home].nodes.n_typed002 = { id: 'n_typed002', kind: 'link', label: 'Workshop', appearance: 'primary', link: { type: 'url', target: 'https://example.com/blog/winter-workshop/' } } as never;
    s.pages[home].rootIds.push('n_typed002');
    expect(publicationPlan(s).draftLinks.filter((l) => l.nodeId === 'n_typed002')).toEqual([{ owner: { kind: 'page', id: home }, nodeId: 'n_typed002', label: 'Workshop', inText: false, entryId: 'en_winter' }]);
  });
});

describe('after the focused review', () => {
  it('never hands a removed entry’s address to an entry it was not given to', () => {
    // Winter is removed with no replacement; Spring takes Winter's slug and leaves it again in the same batch.
    const s = run(
      blog(),
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] },
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' },
      rename('en_spring', 'winter-workshop'),
      rename('en_spring', 'elsewhere')
    );
    expect(kept(s)).toEqual([{ from: '/blog/spring-open-studio/', entryId: 'en_spring' }]);
  });

  it('opens damaged entry text, and checks only what published entries show', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', body: ['See [About](/about/#not-here).'] });
    // A draft's links are not the website's yet.
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    const damaged = structuredClone(s);
    damaged.collections.posts.entries.en_winter.body = [null as never, { type: 'p', spans: [{ text: '  ', link: { type: 'entry', target: 'en_secret' } }] }];
    expect(() => validateState(damaged)).not.toThrow();
    expect(validateState(damaged).map((d) => d.code)).toContain('ENTRY_INVALID');
    // A link with no words shows nothing to follow.
    expect(publicationPlan(damaged).draftLinks).toEqual([]);
  });

  it('names an entry that links to a draft as the source of the stop, and keeps the README’s note on reopening', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the plans](entry:en_secret).'] });
    expect(draftLinksStop(s)!.message).toBe('A published entry links to Secret plans, which is a draft and is left out of the website. Change the link or publish the entry, then export again.');
    const readme = projectReadme('Riverside Studio', false, undefined, true);
    expect(readme).toContain('## Draft entries');
    expect(isGeneratedReadme(readme)).toBe(true);
    expect(isGeneratedReadme(projectReadme('Riverside Studio', true, undefined, true))).toBe(true);
  });
});

describe('handing on an entry’s addresses', () => {
  it('gives nothing of a removed entry to a new entry that reuses its ID in the same batch', () => {
    const s = run(
      blog(),
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] },
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Unrelated', slug: 'winter-workshop' },
      rename('en_winter', 'unrelated'),
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' }
    );
    expect(kept(s)).toEqual([]);
  });

  it('gives nothing of a removed collection’s entries to one created again with an ID of theirs', () => {
    const s = run(blog(), rename('en_winter', 'glazing-evenings'));
    const after = run(
      s,
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] },
      { type: 'collection.remove', collectionId: 'posts' },
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_other', title: 'Other', draft: false },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Unrelated', slug: 'winter-workshop' },
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_other' }
    );
    expect(kept(after)).toEqual([]);
  });

  it('hands on an old address the removed entry had just taken back', () => {
    const s = run(blog(), rename('en_winter', 'glazing-evenings'));
    const after = run(
      s,
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] },
      rename('en_winter', 'winter-workshop'),
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' }
    );
    expect(kept(after)).toEqual([
      { from: '/blog/glazing-evenings/', entryId: 'en_spring' },
      { from: '/blog/winter-workshop/', entryId: 'en_spring' }
    ]);
    // Its own address at the start of the batch is not one: a removed entry's address goes, as a page's does.
    expect(kept(run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['No link.'] }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter', replacementEntryId: 'en_spring' }))).toEqual([]);
  });
});
