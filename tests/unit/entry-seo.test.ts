/**
 * Per-entry search settings, canonical overrides and the complete set of social tags (#587): what an author sets on a
 * post or a page, how the engine checks and stores it, and what the exported `<head>` and sitemap say with it and
 * without it. Everything reads the shared metadata contract (#580), so the resolver and the generated files agree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { checkCanonicalUrl, ogLocale, storedCanonical, twitterHandle } from '@shared/seo';
import { applyOperations, assetUsages } from '@engine/apply';
import { entryImageUses } from '@engine/image-uses';
import { validateState } from '@engine/validate';
import { collectionDiagnostics } from '@engine/collections';
import { runSeoAudit } from '@engine/seo-audit';
import { createSeoResolver } from '@generator/seo-metadata';
import { buildSeoGraph } from '@generator/seo-graph';
import { GenerationCache } from '@generator/cache';
import { generateEntry, generatePage, generateProject, generateSitemap } from '@generator/index';
import { buildSearchIndex } from '@generator/search';
import { checkHeld, readFields, shownField, typedText } from '../../src/renderer/src/lib/held';
import { duplicatePostOps } from '../../src/renderer/src/lib/posts';
import { pageDetail } from '@agent/context';
import { ProjectSession } from '../../src/main/project/session';
import { copy, image, run, seoSite } from './fixtures/seo-site';

const POST = { collectionId: 'posts', entryId: 'en_spring' } as const;
const SPRING = 'https://example.com/studio/blog/spring-pottery-classes/';
const post = (s: ProjectState) => createSeoResolver(s).resolve({ kind: 'entry', ...POST })!;
const updatePost = (fields: Record<string, unknown>): EditOperation => ({ type: 'entry.update', ...POST, ...fields }) as EditOperation;
const entryOf = (s: ProjectState) => s.collections.posts.entries.en_spring;
/** The tags of a generated `<head>`, one per line, as written. */
const headOf = (svelte: string) =>
  svelte
    .slice(svelte.indexOf('<svelte:head>') + '<svelte:head>'.length, svelte.indexOf('</svelte:head>'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const sitemapUrls = (s: ProjectState) => [...(generateSitemap(s) ?? '').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
const refused = (s: ProjectState, ops: EditOperation[]) => {
  try {
    applyOperations(s, ops);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('The edit was not refused.');
};

/** The fixture with a tagged, categorised post written by someone. */
function taggedSite() {
  const { state, services } = seoSite();
  const s = run(
    state,
    {
      type: 'collection.update',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { classes: { label: 'Classes' }, news: { label: 'News' } } }, tags: { label: 'Tags', terms: { wheel: { label: 'Wheel, throwing' }, glaze: { label: 'Glazing' } } } }
    },
    updatePost({ author: 'Ana Ruiz', updatedAt: '2027-03-10', terms: { categories: ['classes', 'news'], tags: ['wheel', 'glaze'] } })
  );
  return { state: s, services };
}

describe('the shared helpers', () => {
  it('accepts a canonical URL only as a full http(s) address, written as browsers write it', () => {
    expect(checkCanonicalUrl('')).toEqual({ ok: true, url: '' });
    expect(checkCanonicalUrl('  HTTPS://Example.com/Original/?ref=1  ')).toEqual({ ok: true, url: 'https://example.com/Original/?ref=1' });
    expect(checkCanonicalUrl('http://other.example')).toEqual({ ok: true, url: 'http://other.example/' });
    for (const bad of [
      'example.com/post/',
      '/blog/post/',
      'ftp://example.com/',
      'https://example.com/a#part',
      'https://user:pw@example.com/',
      'https://exa mple.com/',
      // Each of these the URL parser would repair into some other address: a space or "\\" in the path, a missing host.
      'https://example.com/a b/',
      'https://example.com/a\\b/',
      'https:///articles/original',
      'https:\\\\example.com',
      'https://',
      `https://example.com/${'a'.repeat(2000)}`,
      // Short enough as typed, too long once its letters are encoded.
      `https://example.com/${'界'.repeat(225)}`
    ])
      expect(checkCanonicalUrl(bad).ok, bad).toBe(false);
    expect(checkCanonicalUrl(`https://example.com/${'界'.repeat(10)}`)).toEqual({ ok: true, url: `https://example.com/${encodeURIComponent('界'.repeat(10))}` });
    // A stored value is used only when it is one.
    expect(storedCanonical('https://example.com/a')).toBe('https://example.com/a');
    for (const bad of [undefined, '', 42, 'example.com/a']) expect(storedCanonical(bad)).toBeNull();
  });

  it('writes a language as an Open Graph locale, and a handle as twitter:site names it', () => {
    expect(['en', 'en-AU', 'fr', 'pt-BR', 'zh-Hant', 'es-419'].map(ogLocale)).toEqual(['en_US', 'en_AU', 'fr_FR', 'pt_BR', 'zh_TW', 'es_ES']);
    expect(ogLocale('not a code')).toBeNull();
    expect(['@studio', 'studio', ' @River_Side '].map(twitterHandle)).toEqual(['@studio', '@studio', '@River_Side']);
    for (const bad of [undefined, '', '@', 'two words', '@much_too_long_a_handle', 'https://x.com/studio']) expect(twitterHandle(bad)).toBeNull();
  });
});

describe('an entry’s search settings', () => {
  it('sets each one through entry.update, trimmed and checked, and clears each back to no settings at all', () => {
    const { state } = seoSite();
    // Entries stored before the settings existed have none, and an edit that sets none adds none.
    expect(entryOf(state).seo).toBeUndefined();
    expect(entryOf(run(state, updatePost({ excerpt: 'New words.' }))).seo).toBeUndefined();
    const s = run(state, updatePost({ seoTitle: '  Spring classes at Riverside  ', description: ' Six weeks at the wheel. ', socialImage: 'img_bowls', canonical: 'HTTPS://Journal.example/spring/', noindex: true, searchHidden: true }));
    expect(entryOf(s).seo).toEqual({ title: 'Spring classes at Riverside', description: 'Six weeks at the wheel.', socialImage: 'img_bowls', canonical: 'https://journal.example/spring/', noindex: true, searchHidden: true });
    // One setting changes without touching the others.
    const one = run(s, updatePost({ seoTitle: 'Spring at the wheel' }));
    expect(entryOf(one).seo).toEqual({ ...entryOf(s).seo, title: 'Spring at the wheel' });
    // Turning one switch off removes that one alone.
    const { noindex: _off, ...rest } = entryOf(s).seo!;
    expect(entryOf(run(s, updatePost({ noindex: false }))).seo).toEqual(rest);
    const { searchHidden: _hidden, ...kept } = entryOf(s).seo!;
    expect(entryOf(run(s, updatePost({ searchHidden: false }))).seo).toEqual(kept);
    const cleared = run(s, updatePost({ seoTitle: '', description: '  ', socialImage: null, canonical: '', noindex: false, searchHidden: false }));
    expect(entryOf(cleared)).not.toHaveProperty('seo');
    // A new entry can be made with them.
    const made = run(state, { type: 'entry.create', collectionId: 'posts', entryId: 'en_new', title: 'New', seoTitle: 'New at the studio', noindex: true });
    expect(made.collections.posts.entries.en_new.seo).toEqual({ title: 'New at the studio', noindex: true });
  });

  it('refuses a canonical URL that is no full address, and an image the library does not have as a picture', () => {
    const { state } = seoSite();
    const doc = copy(state);
    doc.assets.assets.doc_menu = { ...image('doc_menu'), kind: 'document', name: 'Menu' };
    expect(refused(state, [updatePost({ canonical: 'journal.example/spring/' })])).toMatch(/full address starting with https:\/\//);
    expect(refused(state, [updatePost({ canonical: 'https://journal.example/spring/#top' })])).toMatch(/“#” part/);
    expect(refused(state, [updatePost({ socialImage: 'img_gone' })])).toMatch(/not in the library/);
    expect(refused(doc, [updatePost({ socialImage: 'doc_menu' })])).toMatch(/not a picture/);
    // The whole batch is refused: nothing else in it lands.
    expect(refused(state, [updatePost({ seoTitle: 'Kept?' }), updatePost({ canonical: 'nope' })])).toBeTruthy();
    expect(entryOf(state).seo).toBeUndefined();
  });

  it('undoes and redoes a change to them as one step, on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-entry-seo-'));
    const session = await ProjectSession.create(dir, seoSite().state);
    try {
      const ok = async (p: Promise<{ ok: boolean; error?: { message: string } }>) => expect((await p).error?.message).toBeUndefined();
      await ok(session.apply({ operations: [updatePost({ seoTitle: 'Spring at Riverside', canonical: 'https://journal.example/spring/', noindex: true, updatedAt: '2027-03-09' })] }, { label: 'Change post search settings' }));
      expect(entryOf(session.state)).toMatchObject({ updatedAt: '2027-03-09', seo: { title: 'Spring at Riverside', canonical: 'https://journal.example/spring/', noindex: true } });
      await ok(session.undo());
      expect(entryOf(session.state).seo).toBeUndefined();
      expect(entryOf(session.state).updatedAt).toBeUndefined();
      await ok(session.redo());
      expect(entryOf(session.state)).toMatchObject({ updatedAt: '2027-03-09', seo: { title: 'Spring at Riverside', canonical: 'https://journal.example/spring/', noindex: true } });
      expect(entryOf(session.state).seo).toEqual({ title: 'Spring at Riverside', canonical: 'https://journal.example/spring/', noindex: true });
      await session.close();
      const again = await ProjectSession.open(dir, 'reopen');
      expect(entryOf(again.state).updatedAt).toBe('2027-03-09');
      expect(entryOf(again.state).seo).toEqual({ title: 'Spring at Riverside', canonical: 'https://journal.example/spring/', noindex: true });
      await again.close();
    } finally {
      await session.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds a typed setting against its own stored field, so another setting changed meanwhile is no conflict', () => {
    const { state } = seoSite();
    const base = run(state, updatePost({ seoTitle: 'Spring', description: 'Six weeks.' }));
    const ops = [updatePost({ seoTitle: 'Spring at the wheel' })];
    const reads = readFields(base, ops)!;
    expect(reads).toEqual([{ found: true, value: { seoTitle: 'Spring' } }]);
    const values = reads.map((r) => (r.found ? r.value : undefined));
    expect(checkHeld(run(base, updatePost({ description: 'Seven weeks.' })), ops, values).kind).toBe('apply');
    const changed = checkHeld(run(base, updatePost({ seoTitle: 'Spring term' })), ops, values);
    expect(changed).toEqual({ kind: 'changed', current: [{ seoTitle: 'Spring term' }] });
    // The author is shown what the field holds now, and what they typed, never “nothing”.
    expect(shownField(ops[0], (changed as { current: unknown[] }).current[0])).toBe('Spring term');
    expect(typedText(ops[0])).toBe('Spring at the wheel');
  });

  it('reads every new setting from where it is stored, for posts and pages', () => {
    const { state, services } = seoSite();
    const s = run(
      state,
      updatePost({ seoTitle: 'T', description: 'D', socialImage: 'img_bowls', canonical: 'https://a.example/', noindex: true, searchHidden: true, updatedAt: '2027-01-02' }),
      { type: 'page.update', pageId: services, canonical: 'https://b.example/', updatedAt: '2027-01-03' }
    );
    const read = (op: EditOperation) => readFields(s, [op])![0];
    expect(read(updatePost({ seoTitle: 'x', description: 'x', socialImage: 'x', canonical: 'x', noindex: false, searchHidden: false, updatedAt: null }))).toEqual({
      found: true,
      value: { seoTitle: 'T', description: 'D', socialImage: 'img_bowls', canonical: 'https://a.example/', noindex: true, searchHidden: true, updatedAt: '2027-01-02' }
    });
    expect(read({ type: 'page.update', pageId: services, canonical: 'x', updatedAt: null })).toEqual({ found: true, value: { canonical: 'https://b.example/', updatedAt: '2027-01-03' } });
    // One field at a time, as the writer sends them.
    for (const [key, value] of Object.entries({ description: 'D', socialImage: 'img_bowls', canonical: 'https://a.example/', noindex: true, searchHidden: true }))
      expect(read(updatePost({ [key]: key === 'socialImage' ? null : key === 'noindex' || key === 'searchHidden' ? false : '' }))).toEqual({ found: true, value: { [key]: value } });
  });

  it('carries a post’s search description, sharing image and switches to its copy, but not what names the original', () => {
    const { state } = seoSite();
    const s = run(state, updatePost({ seoTitle: 'Spring', description: 'Six weeks.', socialImage: 'img_bowls', canonical: 'https://journal.example/spring/', noindex: true, searchHidden: true }));
    const plan = duplicatePostOps(s, POST)!;
    const copied = run(s, ...plan.ops);
    expect(copied.collections.posts.entries[plan.ref.entryId].seo).toEqual({ description: 'Six weeks.', socialImage: 'img_bowls', noindex: true, searchHidden: true });
    // What the copy could not be made with (written by hand) is left out, rather than refusing the copy.
    const odd = copy(s);
    entryOf(odd).seo = { ...entryOf(odd).seo, socialImage: 'img_gone', description: 'x'.repeat(400) };
    const oddPlan = duplicatePostOps(odd, POST)!;
    expect(run(odd, ...oddPlan.ops).collections.posts.entries[oddPlan.ref.entryId].seo).toEqual({ noindex: true, searchHidden: true });
    // A post without settings is copied without any.
    const plain = duplicatePostOps(state, POST)!;
    expect(run(state, ...plain.ops).collections.posts.entries[plain.ref.entryId]).not.toHaveProperty('seo');
  });
});

describe('an entry’s generated page', () => {
  it('keeps every tag an untouched post had, in the same order, and adds the locale, the X card and the article details', () => {
    const { state } = taggedSite();
    expect(headOf(generateEntry(state, 'posts', 'en_spring'))).toEqual([
      '<title>{"Spring pottery classes · Riverside Studio"}</title>',
      '<meta name="description" content={"Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing."} />',
      '<meta property="og:type" content="article" />',
      '<meta property="article:published_time" content={"2027-03-02"} />',
      '<meta property="article:modified_time" content={"2027-03-10"} />',
      '<meta property="article:author" content={"Ana Ruiz"} />',
      '<meta property="article:section" content={"Classes"} />',
      '<meta property="article:tag" content={"Wheel, throwing"} />',
      '<meta property="article:tag" content={"Glazing"} />',
      '<meta property="og:title" content={"Spring pottery classes"} />',
      '<meta property="og:description" content={"Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing."} />',
      '<meta property="og:locale" content="en_US" />',
      `<link rel="canonical" href={"${SPRING}"} />`,
      `<meta property="og:url" content={"${SPRING}"} />`,
      '<meta property="og:image" content={"https://example.com/studio/assets/img_share-1a2b3c4d.png"} />',
      '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />',
      '<meta property="og:image:alt" content={"The studio from the river"} />',
      '<meta name="twitter:card" content="summary_large_image" />',
      '<meta name="twitter:title" content={"Spring pottery classes"} />',
      '<meta name="twitter:description" content={"Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing."} />',
      '<meta name="twitter:image" content={"https://example.com/studio/assets/img_share-1a2b3c4d.png"} />',
      '<meta name="twitter:image:alt" content={"The studio from the river"} />',
      // The connected graph every listed entry carries (site-identity.test.ts reads what it says).
      expect.stringMatching(/^\{@html "\\u003cscript type=\\"application\/ld\+json\\">/)
    ]);
  });

  it('says what the author set instead of what it falls back to, as the resolver does', () => {
    const { state } = taggedSite();
    const withImage = copy(state);
    withImage.assets.assets.img_cups = image('img_cups', { description: 'Cups drying on a rack' });
    withImage.site.twitterSite = 'riverside';
    const set = run(withImage, updatePost({ seoTitle: 'Learn to throw this spring', description: 'Six weeks at the wheel, from clay to glaze.', socialImage: 'img_cups', canonical: 'https://journal.example/spring/' }));
    const meta = post(set);
    expect(meta).toMatchObject({ title: 'Learn to throw this spring', socialTitle: 'Learn to throw this spring', description: 'Six weeks at the wheel, from clay to glaze.', imageId: 'img_cups', imageSource: 'own', canonical: 'https://journal.example/spring/', url: SPRING });
    const head = headOf(generateEntry(set, 'posts', 'en_spring'));
    expect(head).toContain('<title>{"Learn to throw this spring"}</title>');
    expect(head).toContain('<meta property="og:title" content={"Learn to throw this spring"} />');
    expect(head).toContain('<meta name="twitter:title" content={"Learn to throw this spring"} />');
    expect(head).toContain('<meta name="description" content={"Six weeks at the wheel, from clay to glaze."} />');
    expect(head).toContain('<meta name="twitter:description" content={"Six weeks at the wheel, from clay to glaze."} />');
    expect(head).toContain('<link rel="canonical" href={"https://journal.example/spring/"} />');
    expect(head).toContain('<meta property="og:url" content={"https://journal.example/spring/"} />');
    expect(head).toContain('<meta name="twitter:image" content={"https://example.com/studio/assets/img_cups-1a2b3c4d.png"} />');
    expect(head).toContain('<meta name="twitter:image:alt" content={"Cups drying on a rack"} />');
    expect(head).toContain('<meta name="twitter:site" content="@riverside" />');
    // A copy of an article first published elsewhere leaves the sitemap to the original, as search engines ask; it
    // stays published, and the graph may still describe it.
    expect(sitemapUrls(set)).not.toContain(SPRING);
    expect(meta.visibility).toMatchObject({ website: true, indexable: true, sitemap: false, jsonLd: true });
    // A canonical URL that names the post's own address is no copy, however it is spelled.
    for (const own of [SPRING, SPRING.slice(0, -1), SPRING.replace('spring', '%73pring')]) expect(sitemapUrls(run(set, updatePost({ canonical: own }))), own).toContain(SPRING);
    // Another address on the same site is one, an escaped "/" being part of a segment and not a separator.
    for (const other of ['https://example.com/studio/blog/', 'https://example.com/studio%2Fblog/spring-pottery-classes/', `${SPRING}/`, `${SPRING}?page=2`])
      expect(sitemapUrls(run(set, updatePost({ canonical: other }))), other).not.toContain(SPRING);
    // Cleared, each falls back again: the entry's title, its excerpt, its featured image before the site's.
    const back = run(set, updatePost({ seoTitle: '', description: '', socialImage: null, canonical: '', featuredImage: 'img_bowls' }));
    expect(post(back)).toMatchObject({ title: 'Spring pottery classes · Riverside Studio', socialTitle: 'Spring pottery classes', description: entryOf(state).excerpt, imageId: 'img_bowls', imageSource: 'featured', canonical: SPRING });
  });

  it('keeps an own sharing image gone from the library as no image, rather than quietly sharing another', () => {
    const { state } = seoSite();
    const s = copy(run(state, updatePost({ socialImage: 'img_bowls', featuredImage: 'img_texture' })));
    delete s.assets.assets.img_bowls;
    expect(post(s)).toMatchObject({ imageId: 'img_bowls', image: undefined, imageSource: 'own', imageUrl: null });
    const head = headOf(generateEntry(s, 'posts', 'en_spring'));
    expect(head.filter((l) => /og:image|twitter:image/.test(l))).toEqual([]);
    expect(head).toContain('<meta name="twitter:card" content="summary" />');
    expect(collectionDiagnostics(s, new Map()).filter((d) => d.site === 'socialImage')).toEqual([expect.objectContaining({ severity: 'warning', code: 'ASSET_MISSING', owner: { kind: 'entry', id: 'en_spring' } })]);
  });

  it('asks search engines not to list a noindex post and leaves it out of every indexable output, while it stays published', () => {
    const { state } = seoSite();
    const s = run(state, updatePost({ noindex: true }));
    const meta = post(s);
    expect(meta.noindex).toBe(true);
    expect(meta.visibility).toEqual({ website: true, indexable: false, sitemap: false, siteSearch: true, jsonLd: false, news: false });
    expect(headOf(generateEntry(s, 'posts', 'en_spring'))).toContain('<meta name="robots" content="noindex" />');
    expect(headOf(generateEntry(state, 'posts', 'en_spring')).some((l) => l.includes('robots'))).toBe(false);
    expect(sitemapUrls(s)).not.toContain(SPRING);
    expect(sitemapUrls(state)).toContain(SPRING);
    expect(buildSeoGraph(s, createSeoResolver(s), { kind: 'entry', ...POST })).toBeNull();
    expect(generateProject(s).has('src/routes/blog/spring-pottery-classes/+page.svelte')).toBe(true);
    // An audit judges only what search engines may list: a too-short title on a noindex post is nobody's business.
    const short = run(state, updatePost({ seoTitle: 'Spring' }));
    expect(runSeoAudit(short).some((f) => f.code === 'SEO_TITLE_LENGTH' && f.owner?.id === 'en_spring')).toBe(true);
    expect(runSeoAudit(run(short, updatePost({ noindex: true }))).some((f) => f.code === 'SEO_TITLE_LENGTH' && f.owner?.id === 'en_spring')).toBe(false);
  });

  it('sends an audit finding about a post’s own search title or description to that field', () => {
    const { state } = seoSite();
    const where = (s: ProjectState, code: string) => runSeoAudit(s).find((f) => f.code === code && f.owner?.id === 'en_spring')?.destination;
    const own = run(state, updatePost({ seoTitle: 'Spring', description: 'Too short.' }));
    expect(where(own, 'SEO_TITLE_LENGTH')).toEqual({ kind: 'entry', ...POST, field: 'seoTitle' });
    expect(where(own, 'SEO_DESCRIPTION_LENGTH')).toEqual({ kind: 'entry', ...POST, field: 'seoDescription' });
    // Without its own, the post's title and excerpt are what search engines see, and where the fix is.
    const plain = run(state, { type: 'entry.update', ...POST, title: 'Spring pottery classes for complete beginners and returning students', excerpt: 'Too short.' });
    expect(where(plain, 'SEO_TITLE_LENGTH')).toEqual({ kind: 'entry', ...POST, field: 'title' });
    expect(where(plain, 'SEO_DESCRIPTION_LENGTH')).toEqual({ kind: 'entry', ...POST, field: 'excerpt' });
  });

  it('makes again only the post’s page and the sitemap when its search settings change', () => {
    let s = seoSite().state;
    const cache = new GenerationCache();
    const check = () => {
      const made: string[] = [];
      for (const opts of [{}, { instrument: true }]) {
        expect([...generateProject(s, opts, cache)]).toEqual([...generateProject(s, opts)]);
        made.push(...cache.made);
      }
      return made.sort();
    };
    check();
    s = run(s, updatePost({ seoTitle: 'Spring at Riverside' }));
    expect(check()).toEqual(['entry:posts:en_spring#clean', 'entry:posts:en_spring#dev', 'sitemap.xml']);
    expect(check()).toEqual([]);
    s = run(s, updatePost({ noindex: true }));
    expect(check()).toEqual(['entry:posts:en_spring#clean', 'entry:posts:en_spring#dev', 'sitemap.xml']);
    expect(check()).toEqual([]);
    expect(generateProject(s).get('static/sitemap.xml')).not.toContain(SPRING);
    // A post that shows no picture from the library is not made again when the library changes.
    s = run(s, { type: 'site.update', socialImage: null }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_plain', title: 'Opening hours', publishedAt: '2027-01-05', draft: false, body: ['Open every day but Monday.'] });
    check();
    s = copy(s);
    s.assets.assets.img_new = image('img_new');
    const made = check();
    expect(made).not.toContain('entry:posts:en_plain#clean');
    expect(made).not.toContain('entry:posts:en_plain#dev');
  });

  it('counts an entry’s sharing image as a use, replaces it with every other use, and keeps it from being removed', () => {
    const base = copy(seoSite().state);
    // An image the post is shared with and used nowhere else.
    base.assets.assets.img_cups = image('img_cups');
    expect(assetUsages(base).img_cups).toBeUndefined();
    const s = run(base, updatePost({ socialImage: 'img_cups' }));
    expect(assetUsages(s).img_cups).toBe(1);
    expect(entryImageUses(s, 'img_cups')).toEqual([{ target: null, entry: { collectionId: 'posts', entryId: 'en_spring', title: 'Spring pottery classes', field: 'sharing' } }]);
    expect(refused(s, [{ type: 'asset.remove', assetId: 'img_cups' }])).toMatch(/used 1 time/);
    // Once the post goes back to its default, the image can go.
    expect(run(s, updatePost({ socialImage: null }), { type: 'asset.remove', assetId: 'img_cups' }).assets.assets.img_cups).toBeUndefined();
    const replaced = run(s, { type: 'asset.replace', assetId: 'img_cups', withAssetId: 'img_texture' });
    expect(entryOf(replaced).seo?.socialImage).toBe('img_texture');
    expect(post(replaced)).toMatchObject({ imageId: 'img_texture', imageSource: 'own' });
  });
});

describe('a page’s canonical URL, revision date and complete tags', () => {
  it('names the author’s canonical URL in place of the page’s own, and clears back to it', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, canonical: 'https://partner.example/classes/' });
    expect(s.pages[services].seo.canonical).toBe('https://partner.example/classes/');
    const meta = createSeoResolver(s).resolve({ kind: 'page', pageId: services })!;
    expect(meta).toMatchObject({ canonical: 'https://partner.example/classes/', url: 'https://example.com/studio/services/' });
    const head = headOf(generatePage(s, s.pages[services], {}));
    expect(head).toContain('<link rel="canonical" href={"https://partner.example/classes/"} />');
    expect(head).toContain('<meta property="og:url" content={"https://partner.example/classes/"} />');
    expect(sitemapUrls(s)).not.toContain('https://example.com/studio/services/');
    const cleared = run(s, { type: 'page.update', pageId: services, canonical: '' });
    expect(cleared.pages[services].seo).not.toHaveProperty('canonical');
    expect(sitemapUrls(cleared)).toContain('https://example.com/studio/services/');
    expect(headOf(generatePage(cleared, cleared.pages[services], {}))).toContain('<link rel="canonical" href={"https://example.com/studio/services/"} />');
    expect(refused(state, [{ type: 'page.update', pageId: services, canonical: '/classes/' }])).toMatch(/full address/);
  });

  it('writes a canonical URL even without a public URL, and nothing that needs one', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'site.update', baseUrl: '' }, { type: 'page.update', pageId: services, canonical: 'https://partner.example/classes/' });
    const head = headOf(generatePage(s, s.pages[services], {}));
    expect(head).toContain('<link rel="canonical" href={"https://partner.example/classes/"} />');
    expect(head).toContain('<meta property="og:url" content={"https://partner.example/classes/"} />');
    expect(generateSitemap(s)).toBeNull();
    expect(head.filter((l) => /og:image|twitter:image/.test(l))).toEqual([]);
    expect(head).toContain('<meta name="twitter:card" content="summary" />');
    // Another page, with no canonical URL of its own, has none without the site's.
    expect(headOf(generatePage(s, s.pages[s.site.homePageId], {})).some((l) => l.includes('canonical'))).toBe(false);
  });

  it('dates the page in the sitemap once its revision date is set, and an article says when it changed and who wrote it', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, updatedAt: '2027-02-01' });
    expect(s.pages[services].updatedAt).toBe('2027-02-01');
    // The assistant reads it back with the page.
    expect(pageDetail(s, services)).toMatchObject({ updatedAt: '2027-02-01' });
    expect(pageDetail(state, services)).not.toHaveProperty('updatedAt');
    expect(generateSitemap(s)).toContain('<loc>https://example.com/studio/services/</loc><lastmod>2027-02-01</lastmod>');
    // Pages stored without one get no date made up.
    expect(generateSitemap(state)).toContain('<loc>https://example.com/studio/services/</loc></url>');
    expect(run(s, { type: 'page.update', pageId: services, updatedAt: null }).pages[services]).not.toHaveProperty('updatedAt');
    expect(refused(state, [{ type: 'page.update', pageId: services, updatedAt: '2027-02-30' }])).toMatch(/calendar date/);
    const article = run(state, { type: 'page.create', pageId: 'pg_opening', title: 'Opening day', route: '/opening-day/', starter: 'article', articleDate: '2027-01-10', byline: 'Ana Ruiz' }, { type: 'page.update', pageId: 'pg_opening', updatedAt: '2027-01-12' });
    const head = headOf(generatePage(article, article.pages.pg_opening, {}));
    expect(head.slice(2, 6)).toEqual([
      '<meta property="og:type" content="article" />',
      '<meta property="article:published_time" content={"2027-01-10"} />',
      '<meta property="article:modified_time" content={"2027-01-12"} />',
      '<meta property="article:author" content={"Ana Ruiz"} />'
    ]);
    // An ordinary page says nothing of articles, revision date or not.
    expect(headOf(generatePage(s, s.pages[services], {})).some((l) => l.includes('article:'))).toBe(false);
  });

  it('names each page’s locale, and on a page with versions in other languages, theirs', () => {
    const { state, home } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_fr', title: 'Accueil', route: '/fr/' }, { type: 'page.update', pageId: 'pg_fr', language: 'fr', linkTranslationTo: home }, { type: 'page.create', pageId: 'pg_au', title: 'G’day', route: '/au/' }, { type: 'page.update', pageId: 'pg_au', language: 'en-AU', linkTranslationTo: home });
    const locales = (pageId: string) => headOf(generatePage(s, s.pages[pageId], {})).filter((l) => l.includes('og:locale'));
    expect(locales(home)).toEqual(['<meta property="og:locale" content="en_US" />', '<meta property="og:locale:alternate" content="fr_FR" />', '<meta property="og:locale:alternate" content="en_AU" />']);
    expect(locales('pg_fr')).toEqual(['<meta property="og:locale" content="fr_FR" />', '<meta property="og:locale:alternate" content="en_US" />', '<meta property="og:locale:alternate" content="en_AU" />']);
    // A page without versions names its own alone.
    expect(locales('pg_services')).toEqual(['<meta property="og:locale" content="en_US" />']);
    // Versions whose languages share one Open Graph locale name it once.
    const both = run(s, { type: 'page.create', pageId: 'pg_frfr', title: 'Accueil (France)', route: '/fr-fr/' }, { type: 'page.update', pageId: 'pg_frfr', language: 'fr-FR', linkTranslationTo: home });
    expect(headOf(generatePage(both, both.pages[home], {})).filter((l) => l.includes('og:locale'))).toEqual([
      '<meta property="og:locale" content="en_US" />',
      '<meta property="og:locale:alternate" content="fr_FR" />',
      '<meta property="og:locale:alternate" content="en_AU" />'
    ]);
  });

  it('points out a canonical URL or revision date written by hand that can’t be used, and uses the page’s own', () => {
    const { state, services } = seoSite();
    const s = copy(state);
    s.pages[services].seo.canonical = 'partner.example/classes';
    s.pages[services].updatedAt = 'last week';
    entryOf(s).seo = { canonical: 'not a url', noindex: true };
    const codes = validateState(s).filter((d) => d.owner?.id === services).map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['CANONICAL_INVALID', 'PAGE_DATE_INVALID']));
    expect(collectionDiagnostics(s, new Map()).filter((d) => d.owner?.id === 'en_spring').map((d) => d.code)).toContain('CANONICAL_INVALID');
    expect(createSeoResolver(s).resolve({ kind: 'page', pageId: services })!.canonical).toBe('https://example.com/studio/services/');
    expect(post(s).canonical).toBe(SPRING);
    expect(generateSitemap(s)).toContain('<loc>https://example.com/studio/services/</loc></url>');
    // Search settings written by hand into a shape they can't have are read as none, and nothing fails.
    const odd = copy(state);
    (entryOf(odd) as { seo: unknown }).seo = 'hidden';
    expect(post(odd)).toMatchObject({ noindex: false, searchHidden: false, title: 'Spring pottery classes · Riverside Studio' });
    expect(() => generateProject(odd)).not.toThrow();
    expect(buildSearchIndex(odd)).toEqual(buildSearchIndex(state));
  });
});
