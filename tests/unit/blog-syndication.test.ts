/**
 * Blog syndication (#398): the website's RSS feed of its published posts, the BlogPosting each post's page says it is
 * about, and posts found by the site's own search beside its pages.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { generateLayout, generateProject, publishedState } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { SUMMARY_LENGTH, startOfText } from '@generator/entry-summary';
import { RSS_PATH, generateRssFeed, rssDate, xmlText } from '@generator/rss';
import { generateLlmsTxt } from '@generator/llms';
import { buildSearchIndex, generateSearchIndex } from '@generator/search';
import { documentGraph } from '@generator/structured-data';
import { validateRoute } from '@shared/routes';
import { validateState } from '@engine/validate';
import { leaveOutDrafts, publicUrlWarning } from '../../src/main/export';
import { heldAsMedia } from '../../src/main/project/versions';
import { ProjectSession } from '../../src/main/project/session';
import { POST_BODY, copy, run, seoSite } from './fixtures/seo-site';
import { assertWellFormed } from './fixtures/xml';

const SITE = 'https://example.com/studio';
const SPRING = `${SITE}/blog/spring-pottery-classes/`;
const POST = { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' } as const;

const create = (entryId: string, title: string, fields: Record<string, unknown> = {}): EditOperation => ({ type: 'entry.create', collectionId: 'posts', entryId, title, draft: false, ...fields }) as EditOperation;
const update = (entryId: string, fields: Record<string, unknown>): EditOperation => ({ type: 'entry.update', collectionId: 'posts', entryId, ...fields }) as EditOperation;

/** The feed's items, the feed checked well-formed first. */
function feedOf(s: ProjectState) {
  const xml = generateRssFeed(s);
  expect(xml).not.toBeNull();
  expect(assertWellFormed(xml!)).toBe('rss');
  const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const field = (body: string, name: string) => {
    const m = new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`).exec(body);
    return m ? unescape(m[1]) : undefined;
  };
  const [channel] = xml!.split('<item>');
  const items = [...xml!.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, body]) => ({
    title: field(body, 'title'),
    link: field(body, 'link'),
    guid: field(body, 'guid'),
    pubDate: field(body, 'pubDate'),
    creator: field(body, 'dc:creator'),
    description: field(body, 'description')
  }));
  return { xml: xml!, items, channel: { title: field(channel, 'title'), link: field(channel, 'link'), description: field(channel, 'description'), language: field(channel, 'language') } };
}

/** The BlogPosting of an entry's graph, from the generated page's script as visitors get it. */
function postingOf(s: ProjectState, entryId = 'en_spring') {
  const files = generateProject(publishedState(s));
  const page = [...files].find(([path, content]) => path.endsWith('+page.svelte') && content.includes(`siteorigin/collections/posts/entries/${entryId}.json`))?.[1];
  expect(page, 'the entry has a page').toBeDefined();
  const scripts = [...page!.matchAll(/\{@html ("(?:[^"\\]|\\.)*")\}/g)].map((m) => JSON.parse(m[1]) as string).filter((html) => html.startsWith('<script type="application/ld+json">'));
  if (!scripts.length) return { graph: null, posting: undefined };
  expect(scripts).toHaveLength(1);
  const graph = JSON.parse(scripts[0].replace(/^<script type="application\/ld\+json">|<\/script>$/g, '')) as { '@graph': Array<Record<string, unknown>> };
  return { graph, posting: graph['@graph'].find((n) => n['@type'] === 'BlogPosting') };
}

describe('the RSS feed', () => {
  it('lists every published post, newest first, with its title, full address, date, author and summary', () => {
    const { state } = seoSite();
    const s = run(
      state,
      create('en_older', 'Winter kiln report', { publishedAt: '2026-12-01', author: 'Ana Ruiz', excerpt: 'How the winter firing went.' }),
      create('en_newer', 'Summer open studio', { publishedAt: '2027-06-20' }),
      create('en_draft', 'Unannounced workshop', { publishedAt: '2027-07-01', draft: true })
    );
    const { xml, items, channel } = feedOf(s);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom" xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/">\n\t<channel>\n/);
    expect(channel).toEqual({ title: 'Riverside Studio', link: `${SITE}/`, description: s.site.description, language: 'en' });
    expect(xml).toContain(`<atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>`);
    expect(items.map((i) => i.title)).toEqual(['Summer open studio', 'Spring pottery classes', 'Winter kiln report']);
    expect(items[1]).toEqual({
      title: 'Spring pottery classes',
      link: SPRING,
      guid: `${s.manifest.projectId}:en_spring`,
      pubDate: 'Tue, 02 Mar 2027 00:00:00 GMT',
      creator: undefined,
      description: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.'
    });
    expect(items[2]).toMatchObject({ creator: 'Ana Ruiz', description: 'How the winter firing went.', pubDate: 'Tue, 01 Dec 2026 00:00:00 GMT' });
    // A draft is no post of the website, in the editor's state or the one exported.
    expect(xml).not.toContain('Unannounced');
    expect(feedOf(publishedState(s)).xml).toBe(xml);
    // RSS's <author> must be an email address: a byline is the creator. The ID names no address.
    expect(xml).not.toContain('<author>');
    expect(xml.match(/<guid isPermaLink="false">/g)).toHaveLength(3);
  });

  it('summarizes a post without an excerpt from the start of its text, in the feed and in llms.txt alike', () => {
    const { state } = seoSite();
    const sentence = 'The kiln was loaded on Friday and opened again on Monday morning. ';
    const s = run(
      state,
      create('en_plain', 'Kiln notes', {
        publishedAt: '2027-02-01',
        body: [
          { type: 'h2', spans: [{ text: 'A heading' }] },
          { type: 'image', assetId: 'img_bowls', alt: 'Three glazed bowls on a shelf', caption: 'A caption' },
          { type: 'p', spans: [{ text: sentence.repeat(6) }] }
        ]
      })
    );
    const [withExcerpt, without] = feedOf(s).items;
    expect(withExcerpt.description).toBe('Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.');
    expect(without.title).toBe('Kiln notes');
    const summary = without.description!;
    // The start of the text, cut between words.
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(200);
    // As much of it as fits, not merely some of it.
    expect(summary.length).toBeGreaterThan(180);
    const kept = summary.slice(0, -1);
    expect(sentence.repeat(6).startsWith(kept)).toBe(true);
    expect(sentence.repeat(6).slice(kept.length)).toMatch(/^[ .]/);
    const llms = generateLlmsTxt(s);
    expect(llms).toContain(`/blog/kiln-notes/): ${summary}\n`);
    expect(llms).toContain(`/blog/spring-pottery-classes/): ${withExcerpt.description}\n`);
  });

  it('takes the excerpt, then the SEO description, then the text, and quotes no text a post’s page does not show', () => {
    const { state } = seoSite();
    const body = [
      { type: 'p', spans: [{ text: 'Doors open ' }, { text: 'at nine', strong: true }, { text: '.' }] },
      { type: 'ul', items: [[{ text: 'Bring an apron' }]] },
      { type: 'blockquote', spans: [{ text: 'A lovely morning.' }] }
    ];
    const s = run(state, create('en_plain', 'Open day', { publishedAt: '2027-05-01', body }));
    const first = (p: ProjectState) => feedOf(p).items[0].description;
    expect(first(s)).toBe('Doors open at nine. Bring an apron A lovely morning.');
    const described = run(s, update('en_plain', { description: 'Come and see the studio.' }));
    expect(first(described)).toBe('Come and see the studio.');
    expect(generateLlmsTxt(described)).toContain('/blog/open-day/): Come and see the studio.\n');
    // The author's own words are never cut, and win over the SEO description in both places.
    const excerpt = `Our open day. ${'Everyone is welcome. '.repeat(14)}`.trim();
    const excerpted = run(described, update('en_plain', { excerpt }));
    expect(excerpt.length).toBeGreaterThan(SUMMARY_LENGTH);
    expect(first(excerpted)).toBe(excerpt);
    expect(generateLlmsTxt(excerpted)).toContain(`/blog/open-day/): ${excerpt}\n`);
    // With no paragraph, quote or list, the words it does have: a heading, then a picture's caption.
    const headed = [{ type: 'h2', spans: [{ text: 'Doors open at nine' }] }, { type: 'image', assetId: 'img_bowls', alt: 'Bowls', caption: 'The glazing table' }];
    expect(first(run(s, update('en_plain', { body: headed })))).toBe('Doors open at nine The glazing table');
    // A layout that leaves the entry's text off its page: the text is on the website nowhere, so nothing quotes it.
    const hidden = copy(s);
    const { nodes } = hidden.collections.posts.settings.template!;
    const placed = Object.values(nodes).filter((n) => JSON.stringify(n).includes('"$entry":"body"'));
    expect(placed).not.toHaveLength(0);
    for (const n of placed) n.when = { $entry: 'author' };
    // Shown for a post with a byline, so quoted for that one; without one, not.
    expect(first(run(hidden, update('en_plain', { author: 'Ana Ruiz' })))).toBe('Doors open at nine. Bring an apron A lovely morning.');
    expect(first(hidden)).toBeUndefined();
    expect(generateLlmsTxt(hidden)).toMatch(/\/blog\/open-day\/\)\n/);
    // A post with no words at all has none to give.
    expect(first(run(s, update('en_plain', { body: [] })))).toBeUndefined();
  });

  it('cuts text between words, in text written without spaces too, and never inside a character', () => {
    expect(startOfText('Short and whole.')).toBe('Short and whole.');
    expect(SUMMARY_LENGTH).toBe(200);
    expect(startOfText('x'.repeat(200))).toBe('x'.repeat(200));
    expect(startOfText('x'.repeat(201))).toBe(`${'x'.repeat(199)}…`);
    expect(startOfText('one two three four', 12)).toBe('one two…');
    expect(startOfText('one two, three', 12)).toBe('one two…');
    // A hyphenated word is kept or left whole.
    expect(startOfText('we use a well-known kiln', 16)).toBe('we use a…');
    // Japanese, with one early space: cut between its words rather than back at that space.
    const japanese = `お知らせ ${'陶芸教室の予約を受け付けています。'.repeat(20)}`;
    const cut = startOfText(japanese);
    expect(cut.length).toBeGreaterThan(SUMMARY_LENGTH / 2);
    expect(cut.length).toBeLessThanOrEqual(SUMMARY_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
    const kept = cut.slice(0, -1);
    expect(japanese.startsWith(kept)).toBe(true);
    // Where the cut falls, the language has a boundary between words (or punctuation stripped before the "…").
    const boundary = new Intl.Segmenter('ja', { granularity: 'word' }).segment(japanese).containing(kept.length)!.index;
    expect(boundary).toBe(kept.length);
    // One word longer than the room is cut between its characters: no half of an emoji, nor of a joined one.
    expect(startOfText('👩‍🎨'.repeat(10), 14)).toBe(`${'👩‍🎨'.repeat(2)}…`);
  });

  it('keeps a summary taken from a post’s text right in a cached run', () => {
    const { state } = seoSite();
    const cache = new GenerationCache();
    const text = (words: string) => update('en_spring', { body: [{ type: 'p', spans: [{ text: words }] }] });
    const long = 'Wheels are booked by the week. '.repeat(10);
    let s = run(state, update('en_spring', { excerpt: '' }), text(long));
    generateProject(s, {}, cache);
    for (const words of [`${long}Aprons provided.`, 'The kiln is cold today.']) {
      s = run(s, text(words));
      const out = generateProject(s, {}, cache);
      expect(out).toEqual(generateProject(s));
      expect(cache.made.filter((k) => k.startsWith('layout'))).toEqual([]);
      // Words past the cut change neither file; new opening words change both.
      const remade = cache.made.filter((k) => k === 'rss.xml' || k === 'llms.txt').sort();
      expect(remade).toEqual(words.startsWith(long) ? [] : ['llms.txt', 'rss.xml']);
    }
    expect(generateProject(s, {}, cache).get(RSS_PATH)).toContain('The kiln is cold today.');
    expect(generateProject(s, {}, cache).get('static/llms.txt')).toContain('The kiln is cold today.');
  });

  it('says when it was built by its newest post’s date, so the same project gives the same bytes', () => {
    const { state } = seoSite();
    const built = (s: ProjectState) => /<lastBuildDate>([^<]*)<\/lastBuildDate>/.exec(feedOf(s).xml.split('<item>')[0])?.[1];
    expect(built(state)).toBe('Tue, 02 Mar 2027 00:00:00 GMT');
    // A later update to a post changes the feed; a draft, which the feed does not list, does not.
    const s = run(state, update('en_spring', { updatedAt: '2027-03-09' }), create('en_draft', 'Later', { publishedAt: '2027-08-01', draft: true }));
    expect(built(s)).toBe('Tue, 09 Mar 2027 00:00:00 GMT');
    expect(generateRssFeed(s)).toBe(generateRssFeed(copy(s)));
    // The newest day of any post, here an older post's revision; a day that is none counts for nothing.
    const revised = run(s, create('en_older', 'Winter kiln report', { publishedAt: '2026-12-01' }), update('en_older', { updatedAt: '2027-04-15' }));
    expect(built(revised)).toBe('Thu, 15 Apr 2027 00:00:00 GMT');
    const damaged = copy(revised);
    damaged.collections.posts.entries.en_older.updatedAt = 'soon';
    expect(built(damaged)).toBe('Tue, 09 Mar 2027 00:00:00 GMT');
    for (const e of Object.values(damaged.collections.posts.entries)) {
      e.publishedAt = 'soon';
      delete e.updatedAt;
    }
    expect(built(damaged)).toBeUndefined();
  });

  it('escapes what XML and HTML give a meaning to, and replaces characters XML does not allow', () => {
    const { state } = seoSite();
    const s = run(state, update('en_spring', { title: 'Cups & <em>saucers</em> ]]> "quoted" \u0001 🍵', excerpt: 'Glazes <b>bold</b> & bright' }));
    const { xml, items } = feedOf(s);
    expect(items[0].title).toBe('Cups & <em>saucers</em> ]]> "quoted" � 🍵');
    expect(xml).not.toContain(']]>');
    // A reader shows a description as HTML: the summary's "<b>" is shown as written, not made bold.
    expect(items[0].description).toBe('Glazes &lt;b&gt;bold&lt;/b&gt; &amp; bright');
    expect(xmlText('a\ud800b\udc00c🍵')).toBe('a�b�c🍵');
    expect(xmlText('tab\tline\nend')).toBe('tab\tline\nend');
    expect(xmlText('\u0000\u000b\ufffe\uffff')).toBe('\ufffd\ufffd\ufffd\ufffd');
  });

  it('keeps each post’s ID through a rename, and lists posts of the same day by ID and undated ones last', () => {
    const { state } = seoSite();
    const before = feedOf(state).items[0];
    const renamed = feedOf(run(state, update('en_spring', { slug: 'spring-classes', title: 'Spring classes' }))).items[0];
    expect(renamed).toMatchObject({ link: `${SITE}/blog/spring-classes/`, guid: before.guid });
    const s = run(state, create('en_bbbb', 'Same day B', { publishedAt: '2027-03-02' }), create('en_aaaa', 'Same day A', { publishedAt: '2027-03-02' }));
    const damaged = copy(s);
    damaged.collections.posts.entries.en_aaaa.publishedAt = 'soon';
    expect(feedOf(s).items.map((i) => i.title)).toEqual(['Same day A', 'Same day B', 'Spring pottery classes']);
    const items = feedOf(damaged).items;
    expect(items.map((i) => i.title)).toEqual(['Same day B', 'Spring pottery classes', 'Same day A']);
    expect(items[2].pubDate).toBeUndefined();
    expect(rssDate('2027-03-02')).toBe('Tue, 02 Mar 2027 00:00:00 GMT');
    // Posts of every collection are one list, newest first, whatever order each collection keeps.
    const two = run(
      s,
      { type: 'collection.create', collectionId: 'projects', name: 'Projects', route: '/projects/' } as EditOperation,
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_mural', title: 'Harbour mural', publishedAt: '2027-04-01', draft: false } as EditOperation,
      { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_bbbb', 'en_aaaa'] }
    );
    expect(feedOf(two).items.map((i) => i.title)).toEqual(['Harbour mural', 'Same day A', 'Same day B', 'Spring pottery classes']);
  });

  it('lists a post hidden from search engines or from site search: subscribers still read it', () => {
    const { state } = seoSite();
    for (const flags of [{ noindex: true }, { searchHidden: true }]) expect(feedOf(run(state, update('en_spring', flags))).items).toHaveLength(1);
  });

  it('is written to static/rss.xml and named in every page’s head, and needs a public URL and a published post', () => {
    const { state } = seoSite();
    const files = generateProject(publishedState(state));
    expect(files.get(RSS_PATH)).toBe(generateRssFeed(state));
    const link = '<link rel="alternate" type="application/rss+xml" title={"Riverside Studio"} href={"https://example.com/studio/rss.xml"} />';
    expect(files.get('src/routes/+layout.svelte')).toContain(link);
    // Without a public URL, or with no post published, there is no feed and nothing names one.
    for (const s of [run(state, { type: 'site.update', baseUrl: '' }), run(state, update('en_spring', { draft: true }))]) {
      const out = generateProject(publishedState(s));
      expect(generateRssFeed(s)).toBeNull();
      expect(out.has(RSS_PATH)).toBe(false);
      expect(out.get('src/routes/+layout.svelte')).not.toContain('application/rss+xml');
    }
    // A page can never take the feed's address, and saved versions never hold the generated file.
    expect(validateRoute('/rss.xml/')).not.toBeNull();
    expect(heldAsMedia(RSS_PATH)).toBe(false);
  });

  it('says in the export note that the feed was left out without a usable public URL, when the site publishes posts', () => {
    const { state } = seoSite();
    expect(publicUrlWarning(state)).toBeNull();
    expect(publicUrlWarning(run(state, { type: 'site.update', baseUrl: '' }))).toBe(
      'No public site URL is set, so canonical links, social image URLs, the sitemap and the RSS feed were omitted. If the site will have its own address, add it as the Public URL in Site styles › Site details.'
    );
    const broken = copy(state);
    broken.site.baseUrl = 'ftp://example.com';
    expect(publicUrlWarning(broken)).toMatch(/^The public site URL “ftp:\/\/example\.com” can’t be used, so canonical links, social image URLs, the sitemap and the RSS feed were omitted\. /);
    // A site with no published post has no feed to leave out.
    expect(publicUrlWarning(run(state, { type: 'site.update', baseUrl: '' }, update('en_spring', { draft: true })))).toMatch(/social image URLs and the sitemap were omitted\./);
  });

  it('is made again in a cached run when a post it lists changes, and the layout only when the feed comes or goes', () => {
    const { state } = seoSite();
    const cache = new GenerationCache();
    const first = generateProject(state, {}, cache);
    const fresh = (s: ProjectState) => generateProject(s);
    // A word of the post's text is not in the feed: neither the feed nor the layout is made again.
    let s = run(state, update('en_spring', { body: [...POST_BODY, { type: 'p', spans: [{ text: 'Aprons provided.' }] }] }));
    let out = generateProject(s, {}, cache);
    expect(out).toEqual(fresh(s));
    expect(out.get(RSS_PATH)).toBe(first.get(RSS_PATH));
    s = run(s, update('en_spring', { excerpt: 'Bookings open now.' }));
    out = generateProject(s, {}, cache);
    expect(out).toEqual(fresh(s));
    expect(out.get(RSS_PATH)).toContain('Bookings open now.');
    // The layout names the feed, not what it says: a new summary leaves it alone.
    expect(cache.made).toContain('rss.xml');
    expect(cache.made.filter((k) => k.startsWith('layout'))).toEqual([]);
    // Unpublished, the last post takes the feed and the layout's link to it away.
    s = run(s, update('en_spring', { draft: true }));
    out = generateProject(publishedState(s), {}, cache);
    expect(out).toEqual(fresh(publishedState(s)));
    expect(out.has(RSS_PATH)).toBe(false);
    expect(generateLayout(publishedState(s), {})).not.toContain('rss.xml');
  });
});

describe('which collections the feed lists', () => {
  const team = (fields: Record<string, unknown> = {}): EditOperation[] => [
    { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', route: '/team/', ...fields } as EditOperation,
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ana', title: 'Ana Ruiz', publishedAt: '2028-01-05', draft: false } as EditOperation
  ];
  const built = (xml: string) => /<lastBuildDate>([^<]*)<\/lastBuildDate>/.exec(xml.split('<item>')[0])?.[1];

  it('leaves a structured collection out by default, from its items and its build date alike', () => {
    const { state } = seoSite();
    const s = run(state, ...team());
    const { xml, items } = feedOf(s);
    expect(items.map((i) => i.title)).toEqual(['Spring pottery classes']);
    // The record's newer day is not the feed's.
    expect(built(xml)).toBeDefined();
    expect(built(xml)).toBe(built(feedOf(state).xml));
    expect(built(xml)).not.toBe(rssDate('2028-01-05'));
  });

  it('lists a structured collection opted in, and leaves out an editorial one opted out', () => {
    const { state } = seoSite();
    const opted = run(state, ...team({ rss: true }));
    expect(feedOf(opted).items.map((i) => i.title)).toEqual(['Ana Ruiz', 'Spring pottery classes']);
    expect(built(feedOf(opted).xml)).toBe(rssDate('2028-01-05'));
    // Back to its kind's default, then the blog opted out: only the opted-in records are left.
    const reset = run(opted, { type: 'collection.update', collectionId: 'team', rss: null } as EditOperation);
    expect(Object.hasOwn(reset.collections.team.settings, 'rss')).toBe(false);
    expect(feedOf(reset).items).toHaveLength(1);
    const blogOut = run(opted, { type: 'collection.update', collectionId: 'posts', rss: false } as EditOperation);
    expect(feedOf(blogOut).items.map((i) => i.title)).toEqual(['Ana Ruiz']);
  });

  it('has no feed, no link to one and no note of one left out when only records not in it are published', () => {
    const { state } = seoSite();
    const s = run(state, update('en_spring', { draft: true }), ...team());
    const out = generateProject(publishedState(s));
    expect(generateRssFeed(s)).toBeNull();
    expect(out.has(RSS_PATH)).toBe(false);
    expect(out.get('src/routes/+layout.svelte')).not.toContain('application/rss+xml');
    expect(publicUrlWarning(run(s, { type: 'site.update', baseUrl: '' }))).toMatch(/social image URLs and the sitemap were omitted\./);
    // Opted in, the records make a feed of their own.
    const opted = run(s, { type: 'collection.update', collectionId: 'team', rss: true } as EditOperation);
    expect(feedOf(opted).items.map((i) => i.title)).toEqual(['Ana Ruiz']);
    expect(publicUrlWarning(run(opted, { type: 'site.update', baseUrl: '' }))).toMatch(/the sitemap and the RSS feed were omitted\./);
    expect(generateProject(publishedState(opted)).get('src/routes/+layout.svelte')).toContain('application/rss+xml');
  });

  it('a cached run follows a collection opted in or out, feed and layout link alike', () => {
    const { state } = seoSite();
    const cache = new GenerationCache();
    let s = run(state, update('en_spring', { draft: true }), ...team());
    generateProject(publishedState(s), {}, cache);
    for (const rss of [true, false, null]) {
      s = run(s, { type: 'collection.update', collectionId: 'team', rss } as EditOperation);
      const out = generateProject(publishedState(s), {}, cache);
      expect(out).toEqual(generateProject(publishedState(s)));
      expect(out.has(RSS_PATH)).toBe(rss === true);
      expect(out.get('src/routes/+layout.svelte')!.includes('application/rss+xml')).toBe(rss === true);
    }
    // With the blog in the feed, opting the records in makes the feed again but leaves the layout's link to it alone.
    s = run(s, update('en_spring', { draft: false }));
    const before = generateProject(publishedState(s), {}, cache);
    s = run(s, { type: 'collection.update', collectionId: 'team', rss: true } as EditOperation);
    const after = generateProject(publishedState(s), {}, cache);
    expect(after.get(RSS_PATH)).not.toBe(before.get(RSS_PATH));
    expect(cache.made).toContain('rss.xml');
    expect(cache.made.filter((k) => k.startsWith('layout'))).toEqual([]);
  });

  it('leaves out a post whose address a record left out of the feed holds, and records without pages even opted in', () => {
    const { state } = seoSite();
    // Edited outside the app: the records (shared out first, by ID) hold the post's address.
    const held = copy(run(state, { type: 'collection.create', collectionId: 'crew', name: 'Crew', kind: 'structured', route: '/crew/' } as EditOperation, { type: 'entry.create', collectionId: 'crew', entryId: 'en_bo', title: 'Bo', draft: false } as EditOperation));
    held.collections.crew.settings.route = '/blog/';
    held.collections.crew.entries.en_bo.slug = 'spring-pottery-classes';
    expect(generateRssFeed(held)).toBeNull();
    // Data only: no entry has an address to list, whatever the collection says.
    const data = run(state, update('en_spring', { draft: true }), ...team({ rss: true, pages: { detail: false, archive: false } }));
    expect(data.collections.team.settings.rss).toBe(true);
    expect(generateRssFeed(data)).toBeNull();
  });

  it('is a problem in a collection edited outside the app to say something other than true or false', () => {
    const { state } = seoSite();
    const broken = copy(state);
    (broken.collections.posts.settings as unknown as Record<string, unknown>).rss = 'false';
    expect(validateState(broken).some((d) => /RSS feed is not true or false/.test(d.message))).toBe(true);
  });
});

describe('the website export', () => {
  it('carries the feed, each post’s BlogPosting and the posts search finds, and no trace of a draft post', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-rss-export-'));
    try {
      const { state, home } = seoSite();
      const withDraft = run(
        state,
        { type: 'node.insert', owner: { kind: 'page', id: home }, componentId: 'site.search' },
        create('en_secret', 'Secret kiln opening', { publishedAt: '2027-08-01', draft: true, excerpt: 'Not yet announced.' })
      );
      const s = await ProjectSession.create(dir, withDraft);
      s.settleMs = 0;
      await s.close();
      const draftPage = join(dir, 'src/routes/blog/secret-kiln-opening/+page.svelte');
      // The editable project has the draft's page, for the preview; the website does not.
      expect(readFileSync(draftPage, 'utf8')).toContain('Secret kiln opening');
      await leaveOutDrafts(dir, withDraft);
      expect(() => readFileSync(draftPage)).toThrow();
      const feed = readFileSync(join(dir, RSS_PATH), 'utf8');
      expect(assertWellFormed(feed)).toBe('rss');
      expect(feed).toContain(`<link>${SPRING}</link>`);
      const index = readFileSync(join(dir, 'src/lib/siteorigin/runtime/search-index.js'), 'utf8');
      expect(index).toContain('"route":"/blog/spring-pottery-classes/"');
      const post = readFileSync(join(dir, 'src/routes/blog/spring-pottery-classes/+page.svelte'), 'utf8');
      expect(post).toContain('\\"@type\\":\\"BlogPosting\\"');
      for (const [path, content] of [[RSS_PATH, feed], ['search-index.js', index]]) expect(content, path).not.toMatch(/Secret kiln|Not yet announced|en_secret/);
      expect(readFileSync(join(dir, 'src/routes/+layout.svelte'), 'utf8')).toContain('href={"https://example.com/studio/rss.xml"}');
      // What the export holds is exactly what the published site generates.
      const published = generateProject(publishedState(withDraft), { instrument: false });
      for (const path of [RSS_PATH, 'src/lib/siteorigin/runtime/search-index.js', 'src/routes/+layout.svelte']) expect(readFileSync(join(dir, path), 'utf8'), path).toBe(published.get(path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a feed edited outside the app', () => {
  it('stays named once the website no longer has a feed, so no export carries the old summaries, until it is restored away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-rss-'));
    try {
      const { state } = seoSite();
      const s = await ProjectSession.create(dir, state);
      s.settleMs = 0;
      const edited = readFileSync(join(dir, RSS_PATH), 'utf8').replace('</channel>', '<!-- note -->\n</channel>');
      writeFileSync(join(dir, RSS_PATH), edited);
      await s.apply({ operations: [update('en_spring', { draft: true })] }, { label: 'Unpublish' });
      expect(readFileSync(join(dir, RSS_PATH), 'utf8')).toBe(edited);
      expect(s.conflicts).toContainEqual(expect.objectContaining({ path: RSS_PATH, kind: 'generated', builderMissing: true, reason: expect.stringMatching(/^This RSS feed was edited outside/) }));
      await s.restoreGeneratedFile(RSS_PATH);
      expect(() => readFileSync(join(dir, RSS_PATH))).toThrow();
      expect(s.conflicts.some((c) => c.path === RSS_PATH)).toBe(false);
      expect(readFileSync(join(dir, s.savedCopies.find((c) => c.path === RSS_PATH)!.file), 'utf8')).toBe(edited);
      await s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a post’s BlogPosting', () => {
  it('is the main thing on its page, with its headline, dates, author, description and image, published by the site’s publisher', () => {
    const { state } = seoSite();
    const s = run(state, update('en_spring', { author: 'Ana Ruiz', updatedAt: '2027-03-09', featuredImage: 'img_bowls' }));
    const { graph, posting } = postingOf(s);
    const ids = Object.fromEntries(graph!['@graph'].map((n) => [n['@type'] as string, n['@id']]));
    expect(posting).toEqual({
      '@type': 'BlogPosting',
      '@id': `${SPRING}#blogposting`,
      mainEntityOfPage: { '@id': ids.WebPage },
      headline: 'Spring pottery classes',
      description: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.',
      datePublished: '2027-03-02',
      dateModified: '2027-03-09',
      author: { '@type': 'Person', name: 'Ana Ruiz' },
      image: { '@type': 'ImageObject', url: `${SITE}/assets/img_bowls-1a2b3c4d.png` },
      publisher: { '@id': ids.Organization }
    });
    // The page's own revision date stays the author's alone.
    expect(graph!['@graph'].find((n) => n['@type'] === 'WebPage')).toMatchObject({ dateModified: '2027-03-09' });
  });

  it('says it was last modified when it was published until a revision is given, leaves out what the post does not say, and follows its own sharing image', () => {
    const { state } = seoSite();
    const { graph, posting } = postingOf(state);
    expect(posting).toMatchObject({ headline: 'Spring pottery classes', datePublished: '2027-03-02', dateModified: '2027-03-02', image: { '@type': 'ImageObject', url: `${SITE}/assets/img_share-1a2b3c4d.png` } });
    expect(posting).not.toHaveProperty('author');
    expect(graph!['@graph'].find((n) => n['@type'] === 'WebPage')).not.toHaveProperty('dateModified');
    expect(postingOf(run(state, update('en_spring', { socialImage: 'img_bowls', seoTitle: 'Book a spring class · Riverside' }))).posting).toMatchObject({
      headline: 'Spring pottery classes',
      image: { url: `${SITE}/assets/img_bowls-1a2b3c4d.png` }
    });
    // The publisher is whoever publishes the site, a person too; a post with no image to share has none.
    const person = run(state, { type: 'site.update', identity: { kind: 'Person' }, socialImage: null } as EditOperation, update('en_spring', { featuredImage: null }));
    const byPerson = postingOf(person);
    expect(byPerson.posting!.publisher).toEqual({ '@id': byPerson.graph!['@graph'].find((n) => n['@type'] === 'Person')!['@id'] });
    expect(byPerson.posting).not.toHaveProperty('image');
    // A headline that would close the script is kept inside it.
    const closing = postingOf(run(state, update('en_spring', { title: 'Glaze </script> notes' })));
    expect(closing.posting).toMatchObject({ headline: 'Glaze </script> notes' });
  });

  it('is an Article for an entry of another collection', () => {
    const { state } = seoSite();
    const s = run(
      state,
      { type: 'collection.create', collectionId: 'projects', name: 'Projects', route: '/projects/' } as EditOperation,
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_mural', title: 'Harbour mural', publishedAt: '2027-04-01', draft: false } as EditOperation
    );
    const g = documentGraph(s, { kind: 'entry', collectionId: 'projects', entryId: 'en_mural' })!['@graph'];
    expect(g.filter((n) => n['@type'] === 'BlogPosting')).toEqual([]);
    expect(g.find((n) => n['@type'] === 'Article')).toMatchObject({ '@id': `${SITE}/projects/harbour-mural/#article`, headline: 'Harbour mural', datePublished: '2027-04-01' });
  });

  it('is on post pages that carry structured data, never on pages, drafts or posts without it', () => {
    const { state, services } = seoSite();
    expect(documentGraph(state, { kind: 'page', pageId: services })!['@graph'].some((n) => n['@type'] === 'BlogPosting')).toBe(false);
    expect(postingOf(run(state, update('en_spring', { noindex: true }))).graph).toBeNull();
    expect(postingOf(run(state, { type: 'site.update', baseUrl: '' })).graph).toBeNull();
    // Hidden from the site's own search, it is still a post search engines may read about.
    expect(postingOf(run(state, update('en_spring', { searchHidden: true }))).posting).toBeDefined();
    const draft = run(state, update('en_spring', { draft: true }));
    expect(generateProject(publishedState(draft)).get('src/routes/blog/spring-pottery-classes/+page.svelte')).toBeUndefined();
    expect(documentGraph(state, POST)!['@graph'].filter((n) => n['@type'] === 'BlogPosting')).toHaveLength(1);
  });
});

describe('posts in site search', () => {
  it('lists each published post after the pages, with its address, title, summary and text', () => {
    const { state } = seoSite();
    const s = run(state, update('en_spring', { seoTitle: 'Book a spring class · Riverside' }), create('en_draft', 'Unannounced workshop', { draft: true }));
    const index = buildSearchIndex(s);
    const pages = s.site.pageOrder.map((id) => s.pages[id].route);
    expect(index.map((e) => e.route)).toEqual([...pages, '/blog/spring-pottery-classes/']);
    expect(index.at(-1)).toEqual({
      route: '/blog/spring-pottery-classes/',
      title: 'Spring pottery classes',
      alias: 'Book a spring class · Riverside',
      description: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.',
      text: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.\nOur spring classes open for bookings this week. What you will make Three glazed bowls on a shelf Bowls and cups Every student leaves with a set. When'
    });
    expect(generateSearchIndex(s)).toContain('Every student leaves with a set.');
    expect(generateSearchIndex(s)).not.toContain('Unannounced');
    // Its own search description is its description; its excerpt stays among its words.
    const described = buildSearchIndex(run(s, update('en_spring', { description: 'Six weeks at the wheel this spring.' }))).at(-1)!;
    expect(described.description).toBe('Six weeks at the wheel this spring.');
    expect(described.text).toMatch(/^Spring wheel classes open/);
  });

  it('finds a post only by the text its page shows: a layout without the entry’s text leaves it out', () => {
    const { state } = seoSite();
    const layout = state.collections.posts.settings.template!;
    const bodyNode = Object.values(layout.nodes).find((n) => n.kind === 'text' && JSON.stringify(n.text).includes('"$entry":"body"'));
    expect(bodyNode).toBeTruthy();
    const noBody = run(state, { type: 'node.remove', owner: { kind: 'template', id: 'posts' }, nodeId: bodyNode!.id });
    const post = buildSearchIndex(noBody).at(-1)!;
    expect(post.route).toBe('/blog/spring-pottery-classes/');
    expect(post.text).toBe('Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.');
    // In a cached run, the layout's change makes the index again.
    const searching = (s: ProjectState) => run(s, { type: 'node.insert', owner: { kind: 'page', id: s.site.homePageId }, componentId: 'site.search' });
    const cache = new GenerationCache();
    expect(generateProject(searching(state), {}, cache).get('src/lib/siteorigin/runtime/search-index.js')).toContain('Every student leaves with a set.');
    const warm = generateProject(searching(noBody), {}, cache);
    expect(cache.made).toContain('search-index.js');
    expect(warm).toEqual(generateProject(searching(noBody)));
    expect(warm.get('src/lib/siteorigin/runtime/search-index.js')).not.toContain('Every student leaves with a set.');
  });

  it('leaves out a post hidden from site search, but not one hidden only from search engines, and follows a rename', () => {
    const { state } = seoSite();
    const routes = (s: ProjectState) => buildSearchIndex(s).map((e) => e.route);
    expect(routes(run(state, update('en_spring', { searchHidden: true })))).not.toContain('/blog/spring-pottery-classes/');
    // A hand-edited value the switch shows as on hides it too.
    const edited = copy(state);
    (edited.collections.posts.entries.en_spring as { seo?: unknown }).seo = { searchHidden: 1 };
    expect(routes(edited)).not.toContain('/blog/spring-pottery-classes/');
    expect(routes(run(state, update('en_spring', { noindex: true })))).toContain('/blog/spring-pottery-classes/');
    expect(routes(run(state, update('en_spring', { draft: true })))).not.toContain('/blog/spring-pottery-classes/');
    const renamed = routes(run(state, update('en_spring', { slug: 'spring-classes' })));
    expect(renamed).toContain('/blog/spring-classes/');
    expect(renamed).not.toContain('/blog/spring-pottery-classes/');
    // The site's search needs no public URL.
    expect(routes(run(state, { type: 'site.update', baseUrl: '' }))).toContain('/blog/spring-pottery-classes/');
  });

  it('lists the post where it is published when a draft page held its address first', () => {
    const { state } = seoSite();
    const s = copy(state);
    s.pages.pg_old = { ...structuredClone(s.pages.pg_services), id: 'pg_old', title: 'Old', route: '/blog/spring-pottery-classes/', draft: true };
    s.site.pageOrder.push('pg_old');
    expect(buildSearchIndex(s).filter((e) => e.route === '/blog/spring-pottery-classes/')).toEqual([expect.objectContaining({ title: 'Spring pottery classes' })]);
  });
});
