/**
 * Import posts (#399): a WordPress export and a folder of Markdown posts read into posts, planned into the project's
 * Posts collection (slugs, categories and tags, old addresses kept working, pictures found beside the export) and
 * applied as one batch the engine accepts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { readWordPress, wordpressDay } from '../../src/main/posts-import/wxr';
import { readMarkdownFolder } from '../../src/main/posts-import/folder';
import { planOperations, planPostImport } from '../../src/main/posts-import/plan';
import { postImportPreview } from '../../src/main/posts-import/preview';
import { createSourceReader, type ReadReply, type ReadRequest, type ReaderHandle } from '../../src/main/posts-import/client';
import { readFrontmatter, markdownToHtml } from '../../src/main/posts-import/markdown';
import { readContained } from '../../src/main/posts-import/files';
import { segmentsWithin } from '../../src/main/posts-import/media';
import type { ParsedSource } from '../../src/main/posts-import/source';

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
  const { state: after } = applyOperations(state, planOperations(plan, ids, assets));
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
    expect(source.skipped).toEqual(['1 page: only posts are imported.', '1 post in the trash or never started.']);
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
    expect(source.media.map((m) => [m.key, m.ref, m.path?.slice(dir.length)])).toEqual([
      ['m1', 'images/oven.png', '/images/oven.png'],
      ['m2', 'snow.jpg', '/winter-hours/snow.jpg']
    ]);
  });

  it('never reads outside the chosen folder', async () => {
    const dir = markdownFolder();
    const outside = mkdtempSync(join(scratch, 'outside-'));
    writeFileSync(join(outside, 'secret.jpg'), 'secret');
    symlinkSync(join(outside, 'secret.jpg'), join(dir, 'images', 'linked.jpg'));
    symlinkSync(outside, join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'escape.md'), `---\ntitle: Escape\ndate: 2019-01-01\n---\n![a](../${outside.split('/').pop()}/secret.jpg) ![b](images/linked.jpg) ![c](elsewhere/secret.jpg) ![d](%2e%2e/x.jpg) ![e](file:///etc/hosts) ![f](https://example.com/x.jpg)`);
    const source = await readMarkdownFolder(dir, {});
    const escape = source.posts.find((p) => p.title === 'Escape')!;
    const keys = escape.body.flatMap((b) => ('assetId' in b ? [b.assetId] : []));
    const media = source.media.filter((m) => keys.includes(m.key));
    expect(media.map((m) => [m.ref, m.path, m.problem])).toEqual([
      ['../' + outside.split('/').pop() + '/secret.jpg', undefined, 'its address leads outside the chosen folder'],
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
    expect(readFrontmatter('---\ntitle: a\ntitle: b\n---\n').problems).toEqual(['line 3: title is given twice']);
    expect(readFrontmatter('+++\ntitle = "T"\ndraft = true\n[params]\nx = 1\n+++\nB')).toEqual({ data: { title: 'T', draft: true }, problems: [], body: 'B' });
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
    expect(plan.posts[0].notes).toContain('Its old address (/2019/03/winter-workshop/) can’t keep working: it is the address of the old address of “Winter workshop & tasting”.');
    expect(plan.posts[1].notes).toContain('Its old address (/about/) can’t keep working: it is the address of the page “About”.');
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
    expect(validateState(after).filter((d) => d.severity === 'error')).toEqual([]);
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
  const source: ParsedSource = { kind: 'markdown', label: 'posts', root: '/x', posts: [], media: [], skipped: [] };

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
});
