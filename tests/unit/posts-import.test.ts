/**
 * Import posts (#399): a WordPress export and a folder of Markdown posts read into posts, planned into the project's
 * Posts collection (slugs, categories and tags, old addresses kept working, pictures found beside the export) and
 * applied as one batch the engine accepts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ProjectState, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateOperation } from '@shared/ops';
import { constants as fsConstants, promises as fsp, realpathSync } from 'node:fs';
import { vi } from 'vitest';
import { validateState } from '@engine/validate';
import { readWordPress, wordpressDay } from '../../src/main/posts-import/wxr';
import { readMarkdownFolder } from '../../src/main/posts-import/folder';
import { checkPlan, planOperations, planPostImport } from '../../src/main/posts-import/plan';
import { postImportPreview } from '../../src/main/posts-import/preview';
import { createSourceReader, type ReadReply, type ReadRequest, type ReaderHandle } from '../../src/main/posts-import/client';
import { readFrontmatter, markdownToHtml } from '../../src/main/posts-import/markdown';
import { readContained } from '../../src/main/posts-import/files';
import { segmentsWithin } from '../../src/main/posts-import/media';
import { POSTS_PER_BATCH, type ParsedSource, type SourcePost } from '../../src/main/posts-import/source';
import { dropPlan, loadPlan, storePlan, sweepPlans } from '../../src/main/posts-import/review-store';

const FIXTURES = join(__dirname, 'fixtures', 'posts-import');
const scratch = mkdtempSync(join(tmpdir(), 'posts-import-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function wordpressFolder(): string {
  const dir = mkdtempSync(join(scratch, 'wp-'));
  cpSync(join(FIXTURES, 'wordpress'), dir, { recursive: true });
  for (const f of ['uploads/2019/03/snow.jpg', 'uploads/2019/03/loaf.jpg', 'uploads/2019/04/tart.png']) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), `picture ${f}`);
  }
  return dir;
}

function markdownFolder(): string {
  const dir = mkdtempSync(join(scratch, 'md-'));
  cpSync(join(FIXTURES, 'markdown'), dir, { recursive: true });
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(dir, 'images', 'oven.png'), 'png');
  writeFileSync(join(dir, 'winter-hours', 'snow.jpg'), 'jpg');
  return dir;
}

const site = (): ProjectState => createStarterState('business', 'Riverside Bakery', false);
const pages = (s: ProjectState) => Object.fromEntries(Object.values(s.pages).map((p) => [p.id, { id: p.id, route: p.route }]));
const text = (body: RichText) => body.map((b) => ('spans' in b ? b.spans.map((s) => s.text).join('') : 'items' in b ? b.items.map((i) => i.map((s) => s.text).join('')).join(' | ') : `[${b.assetId}]`));

/** Apply a plan as the commit does, each picture standing in as a library image of its own. */
let pictures = 0;
function commit(state: ProjectState, source: ParsedSource) {
  const plan = planPostImport(state, source, '2026-11-24');
  expect(plan.problems).toEqual([]);
  const assets = plan.media.map((m) => ({ id: `a_img${pictures}`, name: m.key, file: `static/assets/img${pictures}-1a2b3c4d.jpg`, mime: 'image/jpeg', bytes: 10, hash: `h${pictures++}`, kind: 'image' as const, createdAt: '2026-01-01T00:00:00.000Z' }));
  const ids = new Map(plan.media.map((m, i) => [m.key, assets[i].id]));
  const ops = planOperations(plan, ids, assets);
  // Every operation as the session checks it before the engine applies the batch.
  for (const op of ops) expect(validateOperation(op)).toMatchObject({ ok: true });
  const { state: after } = applyOperations(state, ops);
  return { plan, after };
}

describe('reading a WordPress export', () => {
  it('reads posts, their dates, drafts, authors, categories, tags, text and pictures', async () => {
    const dir = wordpressFolder();
    const source = await readWordPress(join(dir, 'export.xml'), {});
    expect(source.kind).toBe('wordpress');
    expect(source.site).toBe('https://riverside.example');
    expect(source.posts.map((p) => [p.title, p.date, p.draft, p.slug, p.oldPath])).toEqual([
      ['Winter workshop & tasting', '2019-03-01', false, 'winter-workshop', '/2019/03/winter-workshop/'],
      ['Spring menu', '2019-04-02', false, 'spring-menu', '/2019/04/spring-menu/'],
      ['Summer plans', null, true, '', undefined]
    ]);
    const [winter, spring, summer] = source.posts;
    expect(winter.author).toBe('Sam Baker');
    expect(winter.excerpt).toBe('A hands-on bread workshop.');
    expect(winter.categories).toEqual([{ label: 'News', slug: 'news' }, { label: 'Workshops', slug: 'workshops' }]);
    expect(winter.tags).toEqual([{ label: 'Bread', slug: 'bread' }]);
    expect(spring.categories).toEqual([{ label: 'News', slug: 'news' }]);
    expect(text(winter.body)).toEqual(['Join us for a bread-making workshop. Read about our spring menu too.', 'What to bring', 'An apron | A big appetite', 'The best loaf in town.', '[m1]', 'https://www.youtube.com/watch?v=abc123']);
    expect(winter.body[1]).toEqual({ type: 'h2', spans: [{ text: 'What to bring' }] });
    // A link to another post of the export goes to it, by its key.
    expect(winter.body[0]).toMatchObject({ spans: expect.arrayContaining([{ text: 'spring menu', link: { type: 'entry', target: 'post:wp:13' } }]) });
    expect(winter.notes).toEqual(['Removed a script.', 'Left out an embedded frame or player (https://ads.example/banner).', 'Kept an embedded video or post as a link to it.']);
    expect(text(spring.body)).toEqual(['Our spring menu is here.\nIt has new pastries.', '[m3]', 'Click here for the workshop.']);
    expect(spring.body[1]).toEqual({ type: 'image', assetId: 'm3', alt: 'Rhubarb tart', caption: 'Rhubarb tart' });
    expect(spring.notes).toEqual(['Removed a script.', 'Removed the shortcode [gallery].', 'Kept the words of a link whose address could not be kept.']);
    // A draft at the source needs no reason.
    expect(summer.draftReason).toBeUndefined();
    // Pictures: the original of a resized upload, the featured picture, and one not beside the export.
    expect(source.media).toEqual([
      { key: 'm1', ref: 'https://riverside.example/wp-content/uploads/2019/03/loaf-300x200.jpg', path: join(dir, 'uploads/2019/03/loaf.jpg') },
      { key: 'm2', ref: 'https://riverside.example/wp-content/uploads/2019/03/snow.jpg', path: join(dir, 'uploads/2019/03/snow.jpg') },
      { key: 'm3', ref: 'https://riverside.example/wp-content/uploads/2019/04/tart.png', path: join(dir, 'uploads/2019/04/tart.png') },
      { key: 'm4', ref: 'https://riverside.example/wp-content/uploads/2019/05/missing.jpg', problem: 'it is not in the chosen folder' }
    ]);
    expect(winter.featured).toBe('m2');
    expect(source.skipped).toEqual(['1 page (“About us”): only posts are imported.', '1 post (“Old post”) in the trash or never started.']);
  });

  it('refuses a file that is not a WordPress export, or is damaged, with a reason', async () => {
    const dir = mkdtempSync(join(scratch, 'bad-'));
    writeFileSync(join(dir, 'feed.xml'), '<rss><channel><title>Not WordPress</title></channel></rss>');
    await expect(readWordPress(join(dir, 'feed.xml'), {})).rejects.toThrow(/is not a WordPress export\. In WordPress/);
    writeFileSync(join(dir, 'broken.xml'), '<rss><channel><wp:wxr_version>1.2</wp:wxr_version><item></channel></rss>');
    await expect(readWordPress(join(dir, 'broken.xml'), {})).rejects.toThrow(/broken\.xml is not a WordPress export that can be read: <item> is closed by <\/channel>/);
    writeFileSync(join(dir, 'lol.xml'), '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><rss>&b;</rss>');
    await expect(readWordPress(join(dir, 'lol.xml'), {})).rejects.toThrow(/document type/);
  });

  it('reads the dates WordPress writes', () => {
    expect(wordpressDay('0000-00-00 00:00:00', '2019-03-01 10:00:00')).toBe('2019-03-01');
    expect(wordpressDay('', 'Fri, 01 Mar 2019 23:30:00 +0000')).toBe('2019-03-01');
    expect(wordpressDay('2019-02-30 00:00:00')).toBeNull();
  });
});

describe('reading a folder of Markdown posts', () => {
  it('reads each post file and each folder’s index.md, but not README or files starting with _', async () => {
    const dir = markdownFolder();
    const source = await readMarkdownFolder(dir, {});
    expect(source.posts.map((p) => [p.from, p.title, p.date, p.draft, p.slug])).toEqual([
      ['2019-05-01-open-day.md', 'Open day: meet the bakers', '2019-05-01', false, 'open-day'],
      ['bad-draft.md', 'Broken setting', '2019-06-01', true, 'bad-draft'],
      ['no-settings.md', 'A note without settings', null, true, 'no-settings'],
      ['winter-hours/index.md', 'Winter hours', '2019-01-10', true, 'winter-hours']
    ]);
    const [open, bad, note, winter] = source.posts;
    expect(open.categories.map((t) => t.label)).toEqual(['Events', 'News']);
    expect(open.tags.map((t) => t.label)).toEqual(['community', 'bread']);
    expect(open.author).toBe('Sam Baker');
    expect(open.excerpt).toBe('Come and see how we bake.');
    expect(text(open.body)).toEqual([
      'We open our doors on Saturday. This paragraph runs over two lines.',
      'The schedule',
      'Tours at 10 | Tasting at 12',
      'Bring the family.',
      '[m1]',
      'See the winter hours and our site.'
    ]);
    expect(open.body[1].type).toBe('h2');
    expect(open.body[5]).toMatchObject({ spans: expect.arrayContaining([{ text: 'the winter hours', link: { type: 'entry', target: 'post:md:winter-hours/index.md' } }]) });
    expect(open.notes).toEqual(['Removed a script.', 'Left out an embedded frame or player (https://maps.example/embed).']);
    // The same picture as featured and in the text is one.
    expect(open.featured).toBe('m1');
    expect(bad.draftReason).toBe('its draft setting is not true or false');
    expect(note.draftReason).toBe('it has no publication date');
    // A link by the address another post of the folder ends in.
    expect(note.body[0]).toMatchObject({ spans: expect.arrayContaining([{ text: 'link to the open day', link: { type: 'entry', target: 'post:md:2019-05-01-open-day.md' } }]) });
    expect(winter.tags.map((t) => t.label)).toEqual(['hours']);
    expect(text(winter.body)).toEqual(['We close at four in winter.', '[m2]']);
    expect(source.media.map((m) => [m.key, m.ref, m.path])).toEqual([
      ['m1', 'images/oven.png', join(dir, 'images', 'oven.png')],
      ['m2', 'snow.jpg', join(dir, 'winter-hours', 'snow.jpg')]
    ]);
  });

  it('says what was wrong with a date it could not read, and warns of a file that is not UTF-8', async () => {
    const dir = mkdtempSync(join(scratch, 'md-dates-'));
    writeFileSync(join(dir, 'a-bad-day.md'), '---\ntitle: Bad day\ndate: 2024-02-30\n---\nText.');
    writeFileSync(join(dir, 'b-words.md'), '---\ntitle: Words\ndate: last spring\n---\nText.');
    writeFileSync(join(dir, 'c-none.md'), '---\ntitle: None\n---\nText.');
    writeFileSync(join(dir, 'd-jekyll.md'), '---\ntitle: Jekyll\npublished: true\n---\nText.');
    writeFileSync(join(dir, 'd-true.md'), '---\ntitle: Flagged\ndate: true\n---\nText.');
    // A date in the file's name still dates a post whose date setting can't be read.
    writeFileSync(join(dir, '2024-05-06-named.md'), '---\ntitle: Named\ndate: soon\n---\nText.');
    // "Café" in Windows-1252: é is the one byte 0xE9, which UTF-8 never has alone.
    writeFileSync(join(dir, 'e-latin.md'), Buffer.concat([Buffer.from('---\ntitle: Latin\ndate: 2024-01-01\n---\nCaf'), Buffer.from([0xe9]), Buffer.from('.')]));
    writeFileSync(join(dir, 'g-published.md'), '---\ntitle: Published\npublished: 2024-02-30\n---\nText.');
    // Beside a date that can be read, a published date that can't still keeps the post a draft.
    writeFileSync(join(dir, 'g2-both.md'), '---\ntitle: Both\ndate: 2024-03-01\npublished: 2024-02-30\n---\nText.');
    writeFileSync(join(dir, 'h-utf16.md'), Buffer.from('---\ntitle: Wide\ndate: 2024-01-03\n---\nText.', 'utf16le'));
    writeFileSync(join(dir, 'f-utf8.md'), '\ufeff---\ntitle: Plain\ndate: 2024-01-02\n---\nCafé.');
    const source = await readMarkdownFolder(dir, {});
    expect(source.posts.map((p) => [p.title, p.date, p.draft, p.draftReason])).toEqual([
      ['Named', '2024-05-06', false, undefined],
      ['Bad day', null, true, 'its date “2024-02-30” is not a date, such as 2024-03-01'],
      ['Words', null, true, 'its date “last spring” is not a date, such as 2024-03-01'],
      ['None', null, true, 'it has no publication date'],
      ['Jekyll', null, true, 'it has no publication date'],
      ['Flagged', null, true, 'its date “true” is not a date, such as 2024-03-01'],
      ['Latin', '2024-01-01', false, undefined],
      ['Plain', '2024-01-02', false, undefined],
      ['Published', null, true, 'its published “2024-02-30” is not a date, such as 2024-03-01'],
      ['Both', '2024-03-01', true, 'its published “2024-02-30” is not a date, such as 2024-03-01'],
      ['h utf16', null, true, 'it has no publication date']
    ]);
    expect(source.posts[10].notes).toEqual([expect.stringContaining('not saved as UTF-8')]);
    const [latin, plain] = source.posts.slice(6);
    expect(latin.notes).toEqual([expect.stringContaining('not saved as UTF-8')]);
    expect(text(latin.body)).toEqual(['Caf\ufffd.']);
    expect(plain.notes).toEqual([]);
    expect(text(plain.body)).toEqual(['Café.']);
  });

  it('never reads outside the chosen folder', async () => {
    const dir = markdownFolder();
    const outside = mkdtempSync(join(scratch, 'outside-'));
    writeFileSync(join(outside, 'secret.jpg'), 'secret');
    symlinkSync(join(outside, 'secret.jpg'), join(dir, 'images', 'linked.jpg'));
    symlinkSync(outside, join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'escape.md'), `---\ntitle: Escape\ndate: 2019-01-01\n---\n![a](../${basename(outside)}/secret.jpg) ![b](images/linked.jpg) ![c](elsewhere/secret.jpg) ![d](%2e%2e/x.jpg) ![e](file:///etc/hosts) ![f](https://example.com/x.jpg)`);
    const source = await readMarkdownFolder(dir, {});
    const escape = source.posts.find((p) => p.title === 'Escape')!;
    const keys = escape.body.flatMap((b) => ('assetId' in b ? [b.assetId] : []));
    const media = source.media.filter((m) => keys.includes(m.key));
    expect(media.map((m) => [m.ref, m.path, m.problem])).toEqual([
      ['../' + basename(outside) + '/secret.jpg', undefined, 'its address leads outside the chosen folder'],
      ['images/linked.jpg', undefined, 'it is not in the chosen folder'],
      ['elsewhere/secret.jpg', undefined, 'it is not in the chosen folder'],
      ['%2e%2e/x.jpg', undefined, 'its address leads outside the chosen folder'],
      ['file:///etc/hosts', undefined, 'it is not a file in the chosen folder'],
      ['https://example.com/x.jpg', undefined, 'it is on the web (example.com), and only pictures in the chosen folder are imported']
    ]);
    // A file read for the import is the very file inside the folder, never one a link leads to.
    const real = (await import('node:fs')).realpathSync(dir);
    await expect(readContained(real, join(dir, 'images', 'linked.jpg'), 1000)).rejects.toThrow();
    await expect(readContained(real, join(dir, 'elsewhere', 'secret.jpg'), 1000)).rejects.toThrow(/outside the chosen folder/);
    expect((await readContained(real, join(dir, 'images', 'oven.png'), 1000)).toString()).toBe('png');
  });

  it('reads references within the folder only', () => {
    expect(segmentsWithin(['posts'], '../images/a.jpg')).toEqual(['images', 'a.jpg']);
    expect(segmentsWithin([], '../a.jpg')).toBeNull();
    expect(segmentsWithin(['a'], 'b\\..\\..\\c')).toBeNull();
    expect(segmentsWithin([], 'a%2Fb.jpg')).toBeNull();
    expect(segmentsWithin([], 'C:/x.jpg')).toBeNull();
    expect(segmentsWithin(['a'], '/img/x%20y.jpg')).toEqual(['img', 'x y.jpg']);
  });

  it('reads YAML and TOML frontmatter, passing over what it does not need', () => {
    expect(readFrontmatter('---\ntitle: \'It\'\'s here\'\ndraft: false\ntags: [a, "b, c"]\nlist:\n- x\n- y\nnested:\n  a: 1\nsummary: >\n  one\n  two\n---\nBody').data).toEqual({ title: "It's here", draft: false, tags: ['a', 'b, c'], list: ['x', 'y'], summary: 'one two' });
    const twice = readFrontmatter('---\ntitle: a\ntitle: b\n---\n');
    expect(twice.problems).toEqual(['line 3: title is given twice']);
    expect([twice.data.title, twice.unreadable]).toEqual(['a', ['title']]);
    expect(readFrontmatter('---\nnote: |\n  one\n  two\n---\n').data.note).toBe('one\ntwo');
    expect(readFrontmatter('+++\ntitle = "T"\ndraft = true\n[params]\nx = 1\n+++\nB')).toEqual({ data: { title: 'T', draft: true }, problems: [], unreadable: [], body: 'B' });
    expect(readFrontmatter('No settings').body).toBe('No settings');
  });

  it('reads the Markdown posts use', () => {
    expect(markdownToHtml('Para *em* and __strong__ and snake_case_name.\n\n- a\n  - nested\n- b\n\n```\n<b>code</b>\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |')).toBe(
      '<p>Para <em>em</em> and <strong>strong</strong> and snake_case_name.</p>\n<ul><li>a\n<ul><li>nested</li></ul></li><li>b</li></ul>\n<pre>&lt;b&gt;code&lt;/b&gt;</pre>\n<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>'
    );
    expect(markdownToHtml('[ref link][r]\n\n[r]: https://example.com/r')).toBe('<p><a href="https://example.com/r">ref link</a></p>');
  });
});

describe('planning an import', () => {
  it('makes the Posts collection with the categories and tags, and keeps old addresses working', async () => {
    const source = await readWordPress(join(wordpressFolder(), 'export.xml'), {});
    const { plan, after } = commit(site(), source);
    expect(plan.collection).toEqual({ id: 'posts', name: 'Posts', route: '/blog/', create: true });
    const posts = after.collections.posts;
    expect(posts.settings.taxonomies).toEqual({
      categories: { label: 'Categories', terms: { news: { label: 'News' }, workshops: { label: 'Workshops' } } },
      tags: { label: 'Tags', terms: { bread: { label: 'Bread' } } }
    });
    const entries = Object.values(posts.entries);
    expect(entries.map((e) => [e.title, e.slug, e.publishedAt, e.draft, e.author])).toEqual([
      ['Winter workshop & tasting', 'winter-workshop', '2019-03-01', false, 'Sam Baker'],
      ['Spring menu', 'spring-menu', '2019-04-02', false, 'Sam Baker'],
      ['Summer plans', 'summer-plans', '2026-11-24', true, 'Sam Baker']
    ]);
    const [winter, spring] = entries;
    expect(winter.terms).toEqual({ categories: ['news', 'workshops'], tags: ['bread'] });
    expect(winter.featuredImage).toBe('a_img1');
    expect(winter.excerpt).toBe('A hands-on bread workshop.');
    expect(winter.body.find((b) => b.type === 'image')).toEqual({ type: 'image', assetId: 'a_img0', alt: 'A fresh loaf', caption: 'Fresh from the oven' });
    // Links between imported posts go to their entries, each way.
    expect(JSON.stringify(winter.body)).toContain(`{"type":"entry","target":"${spring.id}"}`);
    expect(JSON.stringify(spring.body)).toContain(`{"type":"entry","target":"${winter.id}"}`);
    expect(after.site.redirects).toEqual([
      { from: '/2019/03/winter-workshop/', entryId: winter.id },
      { from: '/2019/04/spring-menu/', entryId: spring.id }
    ]);
    expect(validateState(after).filter((d) => d.severity === 'error')).toEqual([]);
    // The draft's missing picture is left out and said.
    expect(plan.missing).toEqual([{ post: 'Summer plans', ref: 'https://riverside.example/wp-content/uploads/2019/05/missing.jpg', problem: 'it is not in the chosen folder' }]);
    const preview = postImportPreview('r1', plan);
    expect(preview).toMatchObject({ id: 'r1', kind: 'wordpress', source: 'export.xml', pictures: 3, redirects: 2, newTerms: { categories: ['News', 'Workshops'], tags: ['Bread'] }, problems: [] });
    expect(preview.posts[0]).toMatchObject({ title: 'Winter workshop & tasting', route: '/blog/winter-workshop/', redirectFrom: '/2019/03/winter-workshop/', pictures: 2, categories: ['News', 'Workshops'], tags: ['Bread'] });
    expect(preview.posts[2].notes).toContain('A picture it shows was not found in the chosen folder, so it was left out.');
  });

  it('numbers a slug that is taken, keeps the collection’s own terms, and skips an old address something holds', async () => {
    const source = await readWordPress(join(wordpressFolder(), 'export.xml'), {});
    const first = commit(site(), source).after;
    // The same export again, into a project that already has the posts and a page at one old address.
    const s = structuredClone(first);
    const again = { ...source, posts: source.posts.map((p) => ({ ...p, oldPath: p.oldPath === '/2019/04/spring-menu/' ? '/about/' : p.oldPath })) };
    const { plan, after } = commit(s, again);
    expect(plan.collection.create).toBe(false);
    expect(plan.posts.map((p) => [p.slug, p.wantedSlug])).toEqual([
      ['winter-workshop-2', 'winter-workshop'],
      ['spring-menu-2', 'spring-menu'],
      ['summer-plans-2', 'summer-plans']
    ]);
    expect(plan.posts[0].notes).toContain('Its old address (/2019/03/winter-workshop/) can’t keep working, because it is the address of the old address of “Winter workshop & tasting”.');
    expect(plan.posts[1].notes).toContain('Its old address (/about/) can’t keep working, because it is the address of the page “About”.');
    expect(plan.taxonomies).toBeNull();
    expect(Object.keys(after.collections.posts.entries)).toHaveLength(6);
    expect(validateState(after).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('stops when the blog’s address is taken, with the reason', async () => {
    const s = site();
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    about.route = '/blog/';
    const source = await readWordPress(join(wordpressFolder(), 'export.xml'), {});
    expect(planPostImport(s, source).problems).toEqual(['The posts would go to /blog/, which is the address of the page “About”. Move that first, then import again.']);
  });

  it('plans a Markdown folder: drafts stay drafts, pictures shared by posts are one', async () => {
    const source = await readMarkdownFolder(markdownFolder(), pages(site()));
    const { plan, after } = commit(site(), source);
    const entries = Object.values(after.collections.posts.entries);
    expect(entries.map((e) => [e.title, e.slug, e.draft])).toEqual([
      ['Open day: meet the bakers', 'open-day', false],
      ['Broken setting', 'bad-draft', true],
      ['A note without settings', 'no-settings', true],
      ['Winter hours', 'winter-hours', true]
    ]);
    expect(after.collections.posts.settings.taxonomies.categories.terms).toEqual({ events: { label: 'Events' }, news: { label: 'News' } });
    expect(after.site.redirects).toBeUndefined();
    expect(plan.media.map((m) => m.ref)).toEqual(['images/oven.png', 'snow.jpg']);
    // The published open day links to a post that arrives as a draft: the review says so.
    expect(plan.posts[0].notes).toContain('It links to “Winter hours”, which arrives as a draft: publish that post, or change the link, before the website is exported.');
    expect(validateState(after).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('planning an import from a read it may spend', () => {
  const post = (key: string, over: Partial<SourcePost> = {}): SourcePost => ({ key, from: key, title: key, slug: '', date: '2020-01-01', draft: false, categories: [], tags: [], body: [{ type: 'p', spans: [{ text: 'Words' }] }], notes: [], ...over });
  const src = (posts: SourcePost[]): ParsedSource => ({ kind: 'markdown', label: 'posts', root: '/x', realRoot: '/x', posts, media: [], skipped: [] });
  /** A plan's JSON with each entry ID it made named by its post's key, so two plans of one source compare whole. */
  const byKey = (plan: ReturnType<typeof planPostImport>) => {
    let text = JSON.stringify(plan);
    for (const p of plan.posts) text = text.replaceAll(p.entryId, `entry:${p.key}`);
    return text;
  };

  it('makes the same plan whether or not it may let go of the posts’ text as read, and lets go of it only when told', async () => {
    for (const read of [() => readWordPress(join(wordpressFolder(), 'export.xml'), {}), () => readMarkdownFolder(markdownFolder(), pages(site()))]) {
      const kept = await read();
      const spent = structuredClone(kept);
      const before = structuredClone(kept);
      const plain = planPostImport(site(), kept, '2026-11-24');
      const consumed = planPostImport(site(), spent, '2026-11-24', { consume: true });
      expect(byKey(consumed)).toBe(byKey(plain));
      expect(postImportPreview('r', consumed)).toEqual(postImportPreview('r', plain));
      // Without `consume` the read is the caller's still; with it, only its text is gone.
      expect(kept).toEqual(before);
      expect(spent.posts.map((p) => p.body)).toEqual(spent.posts.map(() => []));
      expect(spent.posts.map(({ body: _b, ...p }) => p)).toEqual(before.posts.map(({ body: _b, ...p }) => p));
    }
  });

  it('still tells a published post that it links to one arriving as a draft, from the text as read', () => {
    const big = 'w'.repeat(100_001);
    const link = (target: string) => ({ type: 'p' as const, spans: [{ text: 'see', link: { type: 'entry' as const, target: `post:${target}` } }] });
    const posts = [post('a', { body: [link('b'), link('b'), link('c'), link('d')] }), post('b', { body: [{ type: 'p', spans: [{ text: big }] }] }), post('c', { draft: true }), post('d')];
    const plain = planPostImport(site(), src(structuredClone(posts)), '2026-11-24');
    const consumed = planPostImport(site(), src(structuredClone(posts)), '2026-11-24', { consume: true });
    expect(consumed.posts[0].notes).toEqual(plain.posts[0].notes);
    // Each draft it links to named once, in the order linked; the published one not at all.
    expect(consumed.posts[0].notes.filter((n) => n.startsWith('It links to'))).toEqual(['b', 'c'].map((t) => `It links to “${t}”, which arrives as a draft: publish that post, or change the link, before the website is exported.`));
  });
});

describe('the review kept on disk', () => {
  it('reads back exactly the plan the review was made from, and the import it makes is the same', async () => {
    const source = await readWordPress(join(wordpressFolder(), 'export.xml'), {});
    const plan = planPostImport(site(), source, '2026-11-24');
    const root = mkdtempSync(join(scratch, 'reviews-'));
    const stored = await storePlan(plan, root);
    expect(readdirSync(root)).toEqual([basename(stored.dir)]);
    // Only this app's user can read it.
    expect(statSync(stored.dir).mode & 0o777).toBe(0o700);
    expect(statSync(stored.file).mode & 0o777).toBe(0o600);
    const back = await loadPlan<typeof plan>(stored);
    expect(back).toStrictEqual(plan);
    const ids = new Map(plan.media.map((m) => [m.key, `a_${m.key}`]));
    expect(planOperations(back, ids)).toStrictEqual(planOperations(plan, ids));
    await dropPlan(stored);
    expect(readdirSync(root)).toEqual([]);
    // Gone already: fine.
    await dropPlan(stored);
  });

  it('refuses a plan whose file changed, grew, shrank or went, and leaves nothing when it cannot be written', async () => {
    const root = mkdtempSync(join(scratch, 'reviews-'));
    const plan = { posts: [{ title: 'A post’s “title”', body: [{ type: 'p', spans: [{ text: 'x'.repeat(5000) }] }] }] };
    const changed = await storePlan(plan, root);
    const bytes = readFileSync(changed.file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(changed.file, bytes);
    await expect(loadPlan(changed)).rejects.toThrow('changed on disk');
    const grown = await storePlan(plan, root);
    writeFileSync(grown.file, Buffer.concat([readFileSync(grown.file), Buffer.from('more')]));
    await expect(loadPlan(grown)).rejects.toThrow('changed on disk');
    const shrunk = await storePlan(plan, root);
    writeFileSync(shrunk.file, readFileSync(shrunk.file).subarray(0, 10));
    await expect(loadPlan(shrunk)).rejects.toThrow('changed on disk');
    const gone = await storePlan(plan, root);
    rmSync(gone.dir, { recursive: true });
    await expect(loadPlan(gone)).rejects.toThrow();
    for (const s of [changed, grown, shrunk]) await dropPlan(s);
    expect(readdirSync(root)).toEqual([]);
    // A plan that can't be written (a function is no plan) leaves no folder behind, nor one whose file can't be.
    await expect(storePlan({ f: () => 1 }, root)).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
    const full = vi.spyOn(fsp, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    await expect(storePlan(plan, root)).rejects.toThrow('no space');
    full.mockRestore();
    expect(readdirSync(root)).toEqual([]);
  });

  it('sweeps what an earlier run left, and makes the folder it keeps plans in when there is none', async () => {
    const root = join(mkdtempSync(join(scratch, 'reviews-')), 'post-reviews');
    const a = await storePlan({ a: 1 }, root);
    const b = await storePlan({ b: 2 }, root);
    expect(readdirSync(root).sort()).toEqual([basename(a.dir), basename(b.dir)].sort());
    await sweepPlans(root);
    expect(readdirSync(root)).toEqual([]);
    // Nothing to sweep: fine.
    await sweepPlans(join(root, 'none'));
  });
});

describe('the import reader process', () => {
  function fakeWorker(answer: (m: ReadRequest, w: { reply: (r: ReadReply) => void; exit: () => void }) => void) {
    const spawned: Array<{ killed: boolean }> = [];
    const spawn = (): ReaderHandle => {
      const listeners: Record<string, Array<(x: unknown) => void>> = {};
      const state = { killed: false };
      spawned.push(state);
      const emit = (e: string, x?: unknown) => (listeners[e] ?? []).forEach((l) => l(x));
      return {
        postMessage: (m) => setTimeout(() => answer(m, { reply: (r) => emit('message', r), exit: () => emit('exit', 1) })),
        on: (e: string, l: (x: never) => void) => ((listeners[e] ??= []).push(l as (x: unknown) => void), undefined),
        kill: () => ((state.killed = true), true)
      } as ReaderHandle;
    };
    return { spawn, spawned };
  }
  const source: ParsedSource = { kind: 'markdown', label: 'posts', root: '/x', realRoot: '/x', posts: [], media: [], skipped: [] };

  it('answers with what the reader read, and ends the reader', async () => {
    const { spawn, spawned } = fakeWorker((m, w) => w.reply({ id: m.id, ok: true, source }));
    await expect(createSourceReader(spawn).read('markdown', '/x/posts', {})).resolves.toEqual(source);
    expect(spawned).toEqual([{ killed: true }]);
  });

  it('says why when the reader fails, crashes or takes too long, and ends it', async () => {
    const failing = fakeWorker((m, w) => w.reply({ id: m.id, ok: false, error: 'export.xml is damaged.' }));
    await expect(createSourceReader(failing.spawn).read('wordpress', '/x/export.xml', {})).rejects.toThrow('export.xml is damaged.');
    const crashing = fakeWorker((_m, w) => w.exit());
    await expect(createSourceReader(crashing.spawn).read('wordpress', '/x/export.xml', {})).rejects.toThrow(/the reader stopped/);
    const slow = fakeWorker(() => undefined);
    await expect(createSourceReader(slow.spawn, { timeoutMs: 20 }).read('wordpress', '/x/export.xml', {})).rejects.toThrow(/took too long/);
    expect([...failing.spawned, ...crashing.spawned, ...slow.spawned].every((s) => s.killed)).toBe(true);
  });

  it('ignores a late or foreign reply, and stop() ends a read in progress', async () => {
    const { spawn } = fakeWorker((m, w) => w.reply({ id: m.id + 1, ok: true, source }));
    const reader = createSourceReader(spawn, { timeoutMs: 5000 });
    const read = reader.read('wordpress', '/x/export.xml', {});
    setTimeout(() => reader.stop(), 10);
    await expect(read).rejects.toThrow('The import was stopped.');
  });

  it('puts the posts sent in batches before those in its answer, in order, and gives up on a read whose reader stops half way', async () => {
    const posts = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}` }) as SourcePost);
    const batched = fakeWorker((m, w) => {
      w.reply({ id: m.id, posts: posts.slice(0, 2) });
      // Another read's batch is not this one's.
      w.reply({ id: m.id + 1, posts: [posts[4]] });
      w.reply({ id: m.id, posts: posts.slice(2, 4) });
      w.reply({ id: m.id, ok: true, source: { ...source, posts: [posts[4]] } });
    });
    const got = await createSourceReader(batched.spawn).read('wordpress', '/x/export.xml', {});
    expect(got.posts.map((p) => p.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect({ ...got, posts: [] }).toEqual(source);
    const dying = fakeWorker((m, w) => {
      w.reply({ id: m.id, posts: posts.slice(0, 2) });
      w.exit();
    });
    await expect(createSourceReader(dying.spawn).read('wordpress', '/x/export.xml', {})).rejects.toThrow(/the reader stopped/);
    const garbled = fakeWorker((m, w) => w.reply({ id: m.id, posts: 'x' } as unknown as ReadReply));
    await expect(createSourceReader(garbled.spawn).read('wordpress', '/x/export.xml', {})).rejects.toThrow('export.xml could not be read.');
    expect([...dying.spawned, ...garbled.spawned].every((s) => s.killed)).toBe(true);
  });

  it('asks the reader what a read cost only when told to report it, answers first, and ends the reader once it has said', async () => {
    const asked: Array<boolean | undefined> = [];
    const stats = { ms: 12, peakRss: 64 * 2 ** 20 };
    const later: Array<() => void> = [];
    const { spawn, spawned } = fakeWorker((m, w) => {
      asked.push(m.stats);
      w.reply({ id: m.id, ok: true, source });
      if (m.stats) later.push(() => w.reply({ id: m.id, stats }));
    });
    await expect(createSourceReader(spawn).read('wordpress', '/x/export.xml', {})).resolves.toEqual(source);
    expect(spawned[0].killed).toBe(true);
    const reported: unknown[] = [];
    await expect(createSourceReader(spawn, { onStats: (s) => reported.push(s) }).read('wordpress', '/x/export.xml', {})).resolves.toEqual(source);
    // Answered, and left to say what the read cost: then ended.
    expect([reported, spawned[1].killed]).toEqual([[], false]);
    later[0]();
    expect([reported, spawned[1].killed]).toEqual([[stats], true]);
    expect(asked).toEqual([undefined, true]);
    // One that never says is ended all the same.
    const silent = fakeWorker((m, w) => w.reply({ id: m.id, ok: true, source }));
    await createSourceReader(silent.spawn, { onStats: () => undefined }).read('wordpress', '/x/export.xml', {});
    await new Promise((r) => setTimeout(r, 1100));
    expect(silent.spawned[0].killed).toBe(true);
  });
});

/** A WordPress export of `items` (each an <item>'s inner XML), in a folder of its own. */
function wxr(items: string[], extra = ''): string {
  const dir = mkdtempSync(join(scratch, 'wxr-'));
  writeFileSync(
    join(dir, 'export.xml'),
    `<?xml version="1.0"?><rss xmlns:wp="w" xmlns:content="c" xmlns:dc="d" xmlns:excerpt="e"><channel><link>https://old.example</link><wp:wxr_version>1.2</wp:wxr_version>${extra}${items.map((i) => `<item>${i}</item>`).join('')}</channel></rss>`
  );
  return join(dir, 'export.xml');
}
const item = (id: number, fields: Record<string, string>, body = '') =>
  `<wp:post_id>${id}</wp:post_id><wp:post_type>post</wp:post_type>${Object.entries(fields)
    .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
    .join('')}<content:encoded><![CDATA[${body}]]></content:encoded>`;

describe('reading posts in batches', () => {
  it('hands a WordPress export’s posts over as it reads them: the same posts, in the same order, and the rest of the source the same', async () => {
    const file = wxr(Array.from({ length: 2 * POSTS_PER_BATCH + 20 }, (_, i) => item(i + 1, { title: `Post ${i}`, 'wp:status': 'publish', 'wp:post_date': '2020-01-02 00:00:00' }, `<p>Text ${i}</p>`)), '<item><wp:post_type>page</wp:post_type><title>About</title></item>');
    const whole = await readWordPress(file, {});
    const batches: SourcePost[][] = [];
    const rest = await readWordPress(file, {}, (b) => batches.push(b));
    expect(batches.map((b) => b.length)).toEqual([POSTS_PER_BATCH, POSTS_PER_BATCH]);
    expect([...batches.flat(), ...rest.posts]).toEqual(whole.posts);
    expect({ ...rest, posts: [] }).toEqual({ ...whole, posts: [] });
    expect(whole.skipped).toEqual(['1 page (“About”): only posts are imported.']);
  });

  it('hands a Markdown folder’s posts over as it reads them, the same way', async () => {
    const dir = mkdtempSync(join(scratch, 'md-batches-'));
    for (let i = 0; i < POSTS_PER_BATCH + 7; i++) writeFileSync(join(dir, `post-${String(i).padStart(3, '0')}.md`), `---\ntitle: Post ${i}\ndate: 2020-01-02\n---\nText ${i} links to [the next](post-${String(i + 1).padStart(3, '0')}.md).\n`);
    const whole = await readMarkdownFolder(dir, {});
    const batches: SourcePost[][] = [];
    const rest = await readMarkdownFolder(dir, {}, (b) => batches.push(b));
    expect(batches.map((b) => b.length)).toEqual([POSTS_PER_BATCH]);
    expect([...batches.flat(), ...rest.posts]).toEqual(whole.posts);
    expect({ ...rest, posts: [] }).toEqual({ ...whole, posts: [] });
    expect(whole.posts).toHaveLength(POSTS_PER_BATCH + 7);
  });
});

describe('reading a WordPress export: statuses, dates and links', () => {
  it('keeps a post a draft when it was private, password-protected or has no date', async () => {
    const source = await readWordPress(
      wxr([
        item(1, { title: 'No date', 'wp:status': 'publish', 'wp:post_date': '0000-00-00 00:00:00' }),
        item(2, { title: 'Locked', 'wp:status': 'publish', 'wp:post_date': '2020-01-02 00:00:00', 'wp:post_password': 'secret' }),
        item(3, { title: 'Private', 'wp:status': 'private', 'wp:post_date': '2020-01-03 00:00:00' }),
        item(4, { title: 'Open', 'wp:status': 'publish', 'wp:post_date': '2020-01-04 00:00:00' })
      ]),
      {}
    );
    expect(source.posts.map((p) => [p.title, p.draft, p.draftReason])).toEqual([
      ['No date', true, 'it has no publication date'],
      ['Locked', true, 'it was password-protected'],
      ['Private', true, 'it was private'],
      ['Open', false, undefined]
    ]);
  });

  it('refuses an export whose root is not an RSS feed', async () => {
    const dir = mkdtempSync(join(scratch, 'root-'));
    writeFileSync(join(dir, 'x.xml'), '<feed><channel><wp:wxr_version>1.2</wp:wxr_version></channel></feed>');
    await expect(readWordPress(join(dir, 'x.xml'), {})).rejects.toThrow(/is not a WordPress export\. In WordPress/);
  });

  it('reads the day an RSS date names, as the site wrote it', () => {
    expect(wordpressDay('', 'Thu, 01 Mar 2018 00:30:00 +0200')).toBe('2018-03-01');
  });

  it('reads links as the old site did: relative to the post, by ?p= only for a post, and keeping a section', async () => {
    const s = site();
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    const source = await readWordPress(
      wxr([
        item(10, { title: 'First', link: 'https://old.example/blog/2020/first/', 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, '<p><a href="../second/">next</a> <a href="/?p=88">gone</a> <a href="/about/#team">team</a> <a href="https://old.example/?p=11">by id</a></p>'),
        item(11, { title: 'Second', link: 'https://old.example/blog/2020/second/', 'wp:status': 'publish', 'wp:post_date': '2020-01-02 00:00:00' })
      ]),
      pages(s)
    );
    const links = source.posts[0].body.flatMap((b) => ('spans' in b ? b.spans : [])).filter((x) => x.link).map((x) => [x.text, x.link]);
    expect(links).toEqual([
      ['next', { type: 'entry', target: 'post:wp:11' }],
      ['gone', { type: 'url', target: 'https://old.example/?p=88' }],
      ['team', { type: 'page', target: about.id, anchor: 'team' }],
      ['by id', { type: 'entry', target: 'post:wp:11' }]
    ]);
    expect(source.posts[0].notes).toContain('A link still goes to the old site.');
  });

  it('says when a featured picture is not in the export', async () => {
    const source = await readWordPress(wxr([item(1, { title: 'Pictured', 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, 'Text') + '<wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>99</wp:meta_value></wp:postmeta>']), {});
    expect(source.posts[0].featured).toBeUndefined();
    expect(source.posts[0].notes).toContain('Its featured picture was left out: the export does not include it. Export All content to bring pictures’ details along.');
  });

  it('leaves out SVG drawings, which are added in Assets', async () => {
    const path = wxr([item(1, { title: 'Logo', 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, '<img src="https://old.example/wp-content/uploads/logo.svg" alt="Logo">')]);
    mkdirSync(join(path, '..', 'uploads'));
    writeFileSync(join(path, '..', 'uploads', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const source = await readWordPress(path, {});
    expect(source.media).toEqual([expect.objectContaining({ problem: 'it is an SVG drawing, which is added in Assets rather than with posts' })]);
  });
});

/** A folder of Markdown files, by name. */
function mdFolder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, 'mdf-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('reading Markdown posts: drafts, dates and text', () => {
  it('never publishes a post whose draft setting it could not read', async () => {
    const source = await readMarkdownFolder(
      mdFolder({
        'tagged.md': '---\ntitle: Tagged\ndate: 2020-01-01\ndraft: !!bool true\n---\nText',
        'nested.md': '---\ntitle: Nested\ndate: 2020-01-01\ndraft:\n  value: true\n---\nText',
        'twice.md': '---\ntitle: Twice\ndate: 2020-01-01\ndraft: false\ndraft: true\n---\nText',
        'plain.md': '---\ntitle: Plain\ndate: 2020-01-01\n---\nText',
        '_ignored.md': '---\ntitle: Ignored\n---\n'
      }),
      {}
    );
    expect(source.posts.map((p) => [p.title, p.draft, p.draftReason])).toEqual([
      ['Nested', true, 'its draft setting could not be read'],
      ['Plain', false, undefined],
      ['Tagged', true, undefined],
      ['Twice', true, 'its draft setting could not be read']
    ]);
  });

  it('takes the date its settings give over its name, and a name’s date only when the calendar has it', async () => {
    const source = await readMarkdownFolder(mdFolder({ '2023-02-30-notes.md': 'Notes', '2019-05-01-later.md': '---\ndate: 2019-06-02\n---\nText' }), {});
    expect(source.posts.map((p) => [p.from, p.date, p.slug])).toEqual([
      ['2019-05-01-later.md', '2019-06-02', 'later'],
      ['2023-02-30-notes.md', null, 'notes']
    ]);
  });

  it('keeps code as written: an indented block, and a reference inside a fence', async () => {
    const html = markdownToHtml('Intro\n\n    <a href="https://x.example/">not a link</a>\n\n```\n[ref]: https://sample.example/\n```\n\n[manual][ref]\n\n[ref]: https://real.example/');
    expect(html).toContain('<pre>&lt;a href="https://x.example/"&gt;not a link&lt;/a&gt;</pre>');
    expect(html).toContain('<pre>[ref]: https://sample.example/</pre>');
    expect(html).toContain('<a href="https://real.example/">manual</a>');
  });

  it('reads a destination’s character references once', () => {
    const source = '[offers](https://example.org/?a=1&amp;b=2)';
    const blocks = htmlToRichTextFromMarkdown(source);
    expect(blocks[0]).toMatchObject({ spans: [{ text: 'offers', link: { type: 'url', target: 'https://example.org/?a=1&b=2' } }] });
  });

  it('stops a post whose references would grow it past what a post holds, and keeps it a draft', async () => {
    const long = `https://example.org/${'a'.repeat(2000)}`;
    const source = await readMarkdownFolder(mdFolder({ 'big.md': `---\ntitle: Big\ndate: 2020-01-01\n---\n${'[x][r] '.repeat(60_000)}\n\n[r]: ${long}` }), {});
    expect(source.posts[0]).toMatchObject({ title: 'Big', draft: true, draftReason: 'its text could not be read', body: [] });
    expect(source.posts[0].notes[0]).toMatch(/^Its text could not be read: its text is too long to read\./);
  });

  it('reads hostile Markdown in one pass: unclosed marks, brackets and tags', () => {
    const t0 = performance.now();
    markdownToHtml('**a '.repeat(2500));
    markdownToHtml('['.repeat(200_000));
    markdownToHtml('<a b'.repeat(50_000));
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

import { htmlToRichText } from '../../src/main/posts-import/html';
import { linkFromTarget } from '@shared/richtext';
const htmlToRichTextFromMarkdown = (md: string) => htmlToRichText(markdownToHtml(md), { image: () => null, link: (h, t) => linkFromTarget(h, {}, t) });

describe('reading only inside the chosen folder', () => {
  it('refuses a link to a file inside the folder, and a folder beside it that shares its name’s start', async () => {
    const dir = markdownFolder();
    const sibling = `${dir}-outside`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'secret.jpg'), 'secret');
    symlinkSync(join(dir, 'images', 'oven.png'), join(dir, 'images', 'alias.png'));
    symlinkSync(sibling, join(dir, 'beside'));
    writeFileSync(join(dir, 'links.md'), `---\ntitle: Links\ndate: 2019-01-01\n---\n![a](images/alias.png) ![b](beside/secret.jpg)`);
    const source = await readMarkdownFolder(dir, {});
    const keys = source.posts.find((p) => p.title === 'Links')!.body.flatMap((b) => ('assetId' in b ? [b.assetId] : []));
    expect(source.media.filter((m) => keys.includes(m.key)).map((m) => [m.ref, m.path, m.problem])).toEqual([
      ['images/alias.png', undefined, 'it is not in the chosen folder'],
      ['beside/secret.jpg', undefined, 'it is not in the chosen folder']
    ]);
    const real = realpathSync(dir);
    await expect(readContained(real, join(dir, 'images', 'alias.png'), 1000)).rejects.toThrow();
  });

  it('refuses a link where opening a file follows one, as on Windows (no O_NOFOLLOW), and one swapped in after the check', async () => {
    const dir = markdownFolder();
    const real = realpathSync(dir);
    symlinkSync(join(dir, 'images', 'oven.png'), join(dir, 'images', 'alias.png'));
    writeFileSync(join(dir, 'images', 'other.png'), 'other');
    const open = fsp.open;
    let swap: string | null = null;
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (p, flags, mode) => {
      // The file at `swap` becomes a link to another file of the folder between the check and the open.
      if (swap && p === swap) {
        rmSync(swap);
        symlinkSync(join(dir, 'images', 'other.png'), swap);
      }
      return open(p, typeof flags === 'number' ? flags & ~(fsConstants.O_NOFOLLOW ?? 0) : flags, mode);
    });
    try {
      await expect(readContained(real, join(dir, 'images', 'alias.png'), 1000)).rejects.toThrow('it is a link, not a file.');
      expect((await readContained(real, join(dir, 'images', 'oven.png'), 1000)).toString()).toBe('png');
      swap = join(dir, 'images', 'oven.png');
      await expect(readContained(real, swap, 1000)).rejects.toThrow('it changed while it was being read.');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a file that is not the one the folder holds at its path', async () => {
    const dir = markdownFolder();
    const real = realpathSync(dir);
    const stat = fsp.stat;
    const spy = vi.spyOn(fsp, 'stat').mockImplementation(async (p, o) => ({ ...(await stat(p, o as never)), ino: 1, dev: 1 }) as never);
    try {
      await expect(readContained(real, join(dir, 'images', 'oven.png'), 1000)).rejects.toThrow('it changed while it was being read.');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('planning an import: limits, drafts and the review', () => {
  const post = (key: string, over: Partial<SourcePost> = {}): SourcePost => ({ key, from: key, title: key, slug: '', date: '2020-01-01', draft: false, categories: [], tags: [], body: [{ type: 'p', spans: [{ text: 'Words' }] }], notes: [], ...over });
  const src = (posts: SourcePost[], media: ParsedSource['media'] = []): ParsedSource => ({ kind: 'markdown', label: 'posts', root: '/x', realRoot: '/x', posts, media, skipped: [] });

  it('keeps no old address for a draft, numbers two posts that want one slug, and reuses a term whatever its case', () => {
    const s = site();
    const first = commit(s, src([post('a', { slug: 'news', categories: [{ label: 'Local News' }] })])).after;
    const { plan, after } = commit(first, src([post('b', { slug: 'same', draft: true, oldPath: '/old-b/' }), post('c', { slug: 'same', categories: [{ label: 'local news' }] })]));
    expect(plan.posts.map((p) => [p.slug, p.wantedSlug, p.redirectFrom])).toEqual([
      ['same', undefined, undefined],
      ['same-2', 'same', undefined]
    ]);
    expect(after.site.redirects).toBeUndefined();
    const c = Object.values(after.collections.posts.entries).find((e) => e.slug === 'same-2')!;
    expect(c.terms.categories).toEqual(['local-news']);
    // Nothing new to the collection: the review still names the term.
    expect(plan.taxonomies).toBeNull();
    expect(postImportPreview('r', plan).posts[1].categories).toEqual(['Local News']);
  });

  it('keeps a post whose text had to be cut as a draft, importing only the pictures it still shows', () => {
    const big = 'x'.repeat(100_001);
    const media = [{ key: 'm1', ref: 'a.jpg', path: '/x/a.jpg' }];
    const plan = planPostImport(site(), src([post('long', { body: [{ type: 'p', spans: [{ text: big }] }, { type: 'image', assetId: 'm1', alt: '' }] })], media), '2026-11-24');
    expect(plan.posts[0]).toMatchObject({ draft: true, draftReason: 'its text was longer than a post holds, so it was cut', body: [] });
    expect(plan.media).toEqual([]);
    expect(plan.problems).toEqual([]);
  });

  it('says what it shortened', () => {
    const media = [{ key: 'm1', ref: 'a.jpg', path: '/x/a.jpg' }];
    const plan = planPostImport(site(), src([post('p', { author: 'A'.repeat(81), categories: [{ label: 'C'.repeat(81) }], body: [{ type: 'image', assetId: 'm1', alt: 'd'.repeat(301), caption: 'c'.repeat(301) }] })], media), '2026-11-24');
    expect(plan.posts[0].notes).toEqual(['Its author’s name was shortened to 80 characters.', 'A picture’s description or caption was shortened to 300 characters.', 'A category or tag name was shortened to 80 characters.']);
    expect(plan.problems).toEqual([]);
  });

  it('stops on too many tags quickly, without adding past the limit', () => {
    const posts = Array.from({ length: 1000 }, (_, i) => post(`p${i}`, { tags: Array.from({ length: 20 }, (_, k) => ({ label: `tag ${i}-${k}` })) }));
    const t0 = performance.now();
    const plan = planPostImport(site(), src(posts), '2026-11-24');
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(plan.problems).toEqual(['The posts bring 20000 new tags, which would give the collection 20000: it can have at most 200.']);
  });

  it('says when the collection has no room for the posts’ tags', () => {
    const s = site();
    const taxonomies = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`g${i}`, { label: `Group ${i}` }]));
    const made = applyOperations(s, [{ type: 'collection.create', collectionId: 'posts', taxonomies } as never]).state;
    const plan = planPostImport(made, src([post('p', { tags: [{ label: 'Bread' }] })]), '2026-11-24');
    expect(plan.skipped).toEqual(['The posts’ tags: the Posts collection has as many groupings as it can, so it has no room for Tags.']);
    expect(plan.problems).toEqual([]);
  });

  it('keeps no old address at the new blog’s own address, without stopping the import', () => {
    const plan = planPostImport(site(), src([post('p', { slug: 'news', oldPath: '/blog/' })]), '2026-11-24');
    expect(plan.problems).toEqual([]);
    expect(plan.posts[0].notes).toContain('Its old address (/blog/) can’t keep working, because it is the address of the Posts collection.');
  });

  it('refuses at review what the session would refuse at commit', () => {
    const s = site();
    const made = applyOperations(s, [{ type: 'collection.create', collectionId: 'posts' } as never]).state;
    made.collections.posts.settings.taxonomies.categories.label = 'C'.repeat(61);
    const plan = planPostImport(made, src([post('p', { tags: [{ label: 'Bread' }] })]), '2026-11-24');
    expect(plan.problems[0]).toMatch(/^The posts can’t be imported: taxonomies\.categories\.label/);
    // Planned first and checked after, the same is found, once.
    const later = planPostImport(made, src([post('p', { tags: [{ label: 'Bread' }] })]), '2026-11-24', { check: false });
    expect(later.problems).toEqual([]);
    checkPlan(made, later);
    expect(later.problems).toEqual(plan.problems);
    checkPlan(made, later);
    expect(later.problems).toEqual(plan.problems);
    // Spending the plan's posts on the check finds the same.
    const spent = planPostImport(made, src([post('p', { tags: [{ label: 'Bread' }] })]), '2026-11-24', { check: false });
    checkPlan(made, spent, { spend: true });
    expect(spent.problems).toEqual(plan.problems);
    // And what only the engine refuses (a link to a page the project does not have), the same with or without a copy.
    const linking = () => src([post('p', { body: [{ type: 'p', spans: [{ text: 'see', link: { type: 'page', target: 'pg_gone' } }] }] })]);
    const byEngine = planPostImport(site(), linking(), '2026-11-24');
    expect(byEngine.problems).toEqual([expect.stringMatching(/^The posts can’t be imported: .*pg_gone/)]);
    const byEngineSpent = planPostImport(site(), linking(), '2026-11-24', { check: false });
    checkPlan(site(), byEngineSpent, { spend: true });
    expect(byEngineSpent.problems).toEqual(byEngine.problems);
  });

  it('applies operations it may keep exactly as copies of them, leaving the project it was given as it was', async () => {
    const source = await readWordPress(join(wordpressFolder(), 'export.xml'), {});
    // A project with its blog already made: a new collection's layout takes random IDs in each batch.
    const before = applyOperations(site(), [{ type: 'collection.create', collectionId: 'posts' } as never]).state;
    const frozen = structuredClone(before);
    const plan = planPostImport(before, source, '2026-11-24');
    const ids = new Map(plan.media.map((m) => [m.key, `a_${m.key}`]));
    const assets = plan.media.map((m) => ({ id: `a_${m.key}`, name: m.key, file: `static/assets/${m.key}-1a2b3c4d.jpg`, mime: 'image/jpeg', bytes: 10, hash: m.key, kind: 'image' as const, createdAt: '2026-01-01T00:00:00.000Z' }));
    // The operations given are copied first, unless they are the batch's own.
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const given = planOperations(plan, ids, assets);
    const copied = applyOperations(before, given);
    expect(clone.mock.calls.some(([v]) => v === given)).toBe(true);
    clone.mockClear();
    const mine = planOperations(plan, ids, assets);
    const owned = applyOperations(before, mine, { ownOperations: true });
    expect(clone.mock.calls.some(([v]) => v === mine)).toBe(false);
    clone.mockRestore();
    expect(owned.state).toEqual(copied.state);
    expect(owned.results).toEqual(copied.results);
    expect(before).toEqual(frozen);
    // A refused batch is refused the same.
    const bad = planOperations(plan, ids, assets).map((op) => (op.type === 'entry.create' ? { ...op, title: '' } : op));
    expect(() => applyOperations(before, bad, { ownOperations: true })).toThrow(/needs a title/);
    expect(before).toEqual(frozen);
  });

  it('counts one picture for one file, however it is referred to', () => {
    const media = [
      { key: 'm1', ref: 'photo.jpg', path: '/x/photo.jpg' },
      { key: 'm2', ref: './photo.jpg', path: '/x/photo.jpg' }
    ];
    const plan = planPostImport(site(), src([post('p', { body: [{ type: 'image', assetId: 'm1', alt: '' }, { type: 'image', assetId: 'm2', alt: '' }] })], media), '2026-11-24');
    expect(postImportPreview('r', plan).pictures).toBe(1);
  });
});

describe('the import reader process: what it asks and how it stops', () => {
  it('sends the project’s pages, and stop() ends every read in progress', async () => {
    const sent: ReadRequest[] = [];
    let killed = 0;
    const spawn = (): ReaderHandle => ({ postMessage: (m: ReadRequest) => void sent.push(m), on: () => undefined, kill: () => (killed++, true) }) as unknown as ReaderHandle;
    const reader = createSourceReader(spawn, { timeoutMs: 5000 });
    const pagesMap = { pg_1: { id: 'pg_1', route: '/about/' } };
    const reads = [reader.read('wordpress', '/x/a.xml', pagesMap), reader.read('markdown', '/x/posts', {})];
    expect(sent.map((m) => [m.kind, m.path, m.pages])).toEqual([
      ['wordpress', '/x/a.xml', pagesMap],
      ['markdown', '/x/posts', {}]
    ]);
    reader.stop();
    for (const r of reads) await expect(r).rejects.toThrow('The import was stopped.');
    expect(killed).toBe(2);
  });
});

describe('second review: drafts, sizes and links read as written', () => {
  it('never publishes a post whose settings are indented, quoted or tagged as text', async () => {
    const source = await readMarkdownFolder(
      mdFolder({
        'indented.md': '---\n  title: Indented\n  date: 2020-01-01\n  published: false\n---\nText',
        'quoted.md': "+++\ntitle = 'Quoted'\ndate = 2020-01-01\n'draft' = true\n+++\nText",
        'text.md': '---\ntitle: Text\ndate: 2020-01-01\npublished: !!str true\n---\nText',
        'odd.md': '---\ntitle: Odd\ndate: 2020-01-01\n- draft: false\n---\nText'
      }),
      {}
    );
    expect(source.posts.map((p) => [p.title, p.draft])).toEqual([
      ['Indented', true],
      ['Odd', true],
      ['Quoted', true],
      ['Text', true]
    ]);
  });

  it('reads many settings it passes over in one pass', () => {
    const t0 = performance.now();
    readFrontmatter(`---\n${Array.from({ length: 30_000 }, (_, i) => `k${i}:\n  a: 1`).join('\n')}\n---\n`);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('keeps what an export names within what a post holds', async () => {
    const source = await readWordPress(wxr([item(1, { title: 'T'.repeat(50_000), 'wp:post_name': 's'.repeat(200_000), 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, 'Text')]), {});
    expect([source.posts[0].title.length, source.posts[0].slug.length]).toEqual([1000, 400]);
    const t0 = performance.now();
    const plan = planPostImport(site(), source, '2026-11-24');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(plan.posts[0].notes).toContain('Its title was shortened to 200 characters.');
  });

  it('never links a ?p= address to the post it is read from', async () => {
    const source = await readWordPress(wxr([item(5, { title: 'Here', link: 'https://old.example/post/', 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, '<p><a href="?p=88">gone</a></p>')]), {});
    expect(source.posts[0].body[0]).toMatchObject({ spans: [{ text: 'gone', link: { type: 'url', target: 'https://old.example/post/?p=88' } }] });
  });

  it('keeps a Markdown comment hidden and an address’s query as written', () => {
    expect(htmlToRichTextFromMarkdown('before <!-- <em>note</em> --> after')).toEqual([{ type: 'p', spans: [{ text: 'before after' }] }]);
    expect(htmlToRichTextFromMarkdown('[go](https://example.org/?a=1&copy=2)')[0]).toMatchObject({ spans: [{ link: { target: 'https://example.org/?a=1&copy=2' } }] });
  });

  it('counts what a table’s references add against the post’s budget', () => {
    const long = `https://example.org/${'a'.repeat(2000)}`;
    expect(() => markdownToHtml(`| A |\n|---|\n${'| [x][r] |\n'.repeat(10_000)}\n[r]: ${long}`)).toThrow('its text is too long to read.');
  });

  it('tells a post that it links to one cut to fit, which arrives as a draft', () => {
    const src2: ParsedSource = {
      kind: 'markdown',
      label: 'posts',
      root: '/x',
      realRoot: '/x',
      media: [],
      skipped: [],
      posts: [
        { key: 'a', from: 'a', title: 'A', slug: 'a', date: '2020-01-01', draft: false, categories: [], tags: [], notes: [], body: [{ type: 'p', spans: [{ text: 'See B', link: { type: 'entry', target: 'post:b' } }] }] },
        { key: 'b', from: 'b', title: 'B', slug: 'b', date: '2020-01-01', draft: false, categories: [], tags: [], notes: [], body: [{ type: 'p', spans: [{ text: 'x'.repeat(100_001) }] }] }
      ]
    };
    const plan = planPostImport(site(), src2, '2026-11-24');
    expect(plan.posts[0].notes).toContain('It links to “B”, which arrives as a draft: publish that post, or change the link, before the website is exported.');
  });
});

describe('last review: what a draft setting, an address or a name can hide', () => {
  it('keeps a post a draft whose setting is tagged as a number, quoted with escapes, or never closed', async () => {
    const source = await readMarkdownFolder(
      mdFolder({
        '2020-01-01-int.md': '---\ntitle: Int\ndraft: !!int false\n---\nText',
        '2020-01-01-escaped.md': '+++\ntitle = "Escaped"\n"\\u0064raft" = true\n+++\nText',
        '2020-01-01-open.md': '---\ntitle: Open\ndraft: true\nText with no end to its settings'
      }),
      {}
    );
    expect(source.posts.map((p) => [p.slug, p.draft])).toEqual([
      ['escaped', true],
      ['int', true],
      ['open', true]
    ]);
  });

  it('keeps no old address longer than a site’s addresses can be, and plans quickly', async () => {
    const path = `/${'a'.repeat(3_000_000)}/`;
    const source = await readWordPress(wxr([item(1, { title: 'Long', link: `https://old.example${path}`, 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, 'Text')]), {});
    expect(source.posts[0].oldPath).toBeUndefined();
    const t0 = performance.now();
    planPostImport(site(), source, '2026-11-24');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('reads a Markdown tag whose quoted attribute holds markup as one tag', () => {
    expect(htmlToRichTextFromMarkdown('<span title="<img src=x.jpg>">words</span>')).toEqual([{ type: 'p', spans: [{ text: 'words' }] }]);
  });

  it('titles a post by its name when its first heading can’t be read, and reads the rest of the folder', async () => {
    const heading = `# ${`<http://x.example/${'&'.repeat(2000)}>`.repeat(900)}`;
    const source = await readMarkdownFolder(mdFolder({ 'huge-heading.md': `${heading}\n\nText`, 'fine.md': '---\ntitle: Fine\ndate: 2020-01-01\n---\nText' }), {});
    expect(source.posts.map((p) => p.title)).toEqual(['Fine', 'huge heading']);
  });

  it('reads an excerpt whose words come after a lot of markup', async () => {
    const source = await readWordPress(wxr([item(1, { title: 'E', 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00', 'excerpt:encoded': `${'<span></span>'.repeat(3000)}The words.` }, 'Text')]), {});
    expect(source.posts[0].excerpt).toBe('The words.');
  });

  it('maps a link with a tracking query by its path, and reads no RSS date whose time is not one', async () => {
    const source = await readWordPress(
      wxr([
        item(10, { title: 'First', link: 'https://old.example/blog/first/', 'wp:status': 'publish', 'wp:post_date': '2020-01-01 00:00:00' }, '<p><a href="https://old.example/blog/second/?utm_source=mail">next</a></p>'),
        item(11, { title: 'Second', link: 'https://old.example/blog/second/', 'wp:status': 'publish', pubDate: 'Thu, 02 Jan 2020 99:99:99 +0000' })
      ]),
      {}
    );
    expect(source.posts[0].body[0]).toMatchObject({ spans: [{ text: 'next', link: { type: 'entry', target: 'post:wp:11' } }] });
    expect(source.posts[1]).toMatchObject({ date: null, draft: true });
  });

  it('keeps two names that differ before 80 characters as two terms', () => {
    const base = 'word '.repeat(14);
    const plan = planPostImport(site(), { kind: 'markdown', label: 'p', root: '/x', realRoot: '/x', media: [], skipped: [], posts: [{ key: 'a', from: 'a', title: 'A', slug: 'a', date: '2020-01-01', draft: false, notes: [], tags: [], body: [], categories: [{ label: `${base}alphabetical` }, { label: `${base}alphanumeric` }] }] }, '2026-11-24');
    expect(Object.keys(plan.termLabels.categories)).toHaveLength(2);
  });

  it('keeps a numeric reference without its semicolon as written in an address', () => {
    expect(htmlToRichTextFromMarkdown('[go](https://example.org/?q=&#65)')[0]).toMatchObject({ spans: [{ link: { target: 'https://example.org/?q=&#65' } }] });
  });
});

describe('reading a static site folder (#1517)', () => {
  const pictures = (source: ParsedSource) => source.media.map((m) => [m.ref, m.path ? m.path.slice(source.root.length + 1) : undefined, m.problem]);

  it('reads a Jekyll site’s _posts and finds its pictures at the site’s root', async () => {
    const dir = mdFolder({
      '_posts/2020-01-01-jekyll-post.md': '---\ntitle: Jekyll post\nimage: /assets/img/cover.jpg\n---\n![A cover](/assets/img/cover.jpg) ![Beside](beside.jpg) [Next](2020-02-01-later.md)',
      '_posts/2020-02-01-later.md': '---\ntitle: Later\n---\nText',
      '_posts/beside.jpg': 'jpg',
      'assets/img/cover.jpg': 'jpg',
      'index.md': '---\nlayout: home\n---\nHome page',
      'about.md': '---\ntitle: About\n---\nAbout page'
    });
    const source = await readMarkdownFolder(dir, {});
    expect(source.posts.map((p) => [p.from, p.title, p.date])).toEqual([
      ['_posts/2020-01-01-jekyll-post.md', 'Jekyll post', '2020-01-01'],
      ['_posts/2020-02-01-later.md', 'Later', '2020-02-01']
    ]);
    const [post] = source.posts;
    expect(post.featured).toBe('m1');
    expect(pictures(source)).toEqual([
      ['/assets/img/cover.jpg', join('assets', 'img', 'cover.jpg'), undefined],
      ['beside.jpg', join('_posts', 'beside.jpg'), undefined]
    ]);
    expect(JSON.stringify(post.body)).toContain('md:_posts/2020-02-01-later.md');
  });

  it('reads a Hugo site’s content/posts, page bundles included, and finds root pictures in static/', async () => {
    const dir = mdFolder({
      'content/posts/hugo-post.md': '---\ntitle: Hugo post\ndate: 2021-03-01\nimage: /images/cover.jpg\n---\nText',
      'content/posts/bundle/index.md': '---\ntitle: Bundle\ndate: 2021-04-01\n---\n![Here](here.jpg)',
      'content/posts/bundle/here.jpg': 'jpg',
      'content/about.md': '---\ntitle: About\n---\nAbout page',
      'static/images/cover.jpg': 'jpg'
    });
    const source = await readMarkdownFolder(dir, {});
    expect(source.posts.map((p) => p.from)).toEqual(['content/posts/bundle/index.md', 'content/posts/hugo-post.md']);
    expect(pictures(source).sort()).toEqual([
      ['/images/cover.jpg', join('static', 'images', 'cover.jpg'), undefined],
      ['here.jpg', join('content', 'posts', 'bundle', 'here.jpg'), undefined]
    ]);
  });

  it('never reads a posts folder a link leads to outside the chosen folder', async () => {
    const outside = mdFolder({ 'posts/secret.md': '---\ntitle: Secret\ndate: 2020-01-01\n---\nText' });
    const dir = mdFolder({ 'mine.md': '---\ntitle: Mine\ndate: 2020-01-01\n---\nText' });
    symlinkSync(outside, join(dir, 'content'));
    const source = await readMarkdownFolder(dir, {});
    expect(source.posts.map((p) => p.from)).toEqual(['mine.md']);
  });

  it('still reads a folder of posts chosen on its own', async () => {
    const dir = mdFolder({ 'one.md': '---\ntitle: One\ndate: 2020-01-01\n---\nText', '_draft.md': 'Not a post' });
    const source = await readMarkdownFolder(dir, {});
    expect(source.posts.map((p) => p.from)).toEqual(['one.md']);
  });
});
