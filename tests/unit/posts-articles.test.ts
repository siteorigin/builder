/**
 * Posts (#395): a collection entry's text is an article, with section headings (h2) and library pictures with captions
 * between its paragraphs. Only entries hold them; the pictures count as uses of their library image (Assets lists and
 * replaces them, a used image cannot be removed), Project health checks them, and the post's page renders them.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ProjectState, RichText } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, assetUsages } from '@engine/apply';
import { normalizeRichText, MAX_ENTRY_CHARS } from '@engine/values';
import { EngineError } from '@engine/tree';
import { imageUses } from '@engine/image-uses';
import { validateState } from '@engine/validate';
import { cleanBlocks, escapeLineStart, isRichBlock, parseRichText, richTextToMarkdown, richTextToPlain, spanRuns, toRichText } from '@shared/richtext';
import { generateEntry, resolveRichText } from '@generator/index';
import { todayArticleDate } from '@shared/articles';
import { RICHTEXT_SVELTE } from '@generator/runtime-files';
import { blocksFromDom } from '../../src/renderer/src/lib/richtext';
import { readField, fieldKey, placeOf } from '../../src/renderer/src/lib/held';
import { duplicatePostOps, newPostOps, postRows, postsCollection } from '../../src/renderer/src/lib/posts';
import { imageUseRows } from '../../src/renderer/src/lib/asset-uses';

const image = (id: string, altSuggestion?: string): AssetRecord => ({ id, name: `Photo ${id}`, file: `static/assets/${id}-1a2b3c4d.png`, mime: 'image/png', bytes: 10, hash: `hash-${id}`, kind: 'image', createdAt: '2026-01-01T00:00:00.000Z', width: 1200, height: 800, ...(altSuggestion ? { altSuggestion } : {}) });
const doc = (id: string): AssetRecord => ({ id, name: `Guide ${id}`, file: `static/assets/${id}-1a2b3c4d.pdf`, mime: 'application/pdf', bytes: 10, hash: `hash-${id}`, kind: 'document', createdAt: '2026-01-01T00:00:00.000Z' });

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

function blog(): ProjectState {
  const s = createStarterState('business', 'Riverside Studio', false);
  s.assets.assets.img_a = image('img_a', 'A potter at the wheel');
  s.assets.assets.img_b = image('img_b', 'Bowls drying on a shelf');
  s.assets.assets.doc_a = doc('doc_a');
  return run(
    s,
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14', author: 'Ana' }
  );
}

const ARTICLE: RichText = [
  { type: 'p', spans: [{ text: 'We open the doors.' }] },
  { type: 'h2', spans: [{ text: 'At the workshop' }] },
  { type: 'image', assetId: 'img_a', alt: 'Two potters glazing', caption: 'Saturday at the studio.' },
  { type: 'ul', items: [[{ text: 'Clay' }], [{ text: 'Glaze', strong: true }]] },
  { type: 'image', assetId: 'img_b', alt: '', decorative: true }
];

const withBody = (s: ProjectState, body: unknown, entryId = 'en_spring') => run(s, { type: 'entry.update', collectionId: 'posts', entryId, body });

describe('article text', () => {
  it('reads pictures as blocks of their own, with a description and a caption collapsed to one line', () => {
    expect(isRichBlock({ type: 'image', assetId: 'img_a', alt: '' })).toBe(true);
    expect(isRichBlock({ type: 'image', alt: 'no picture' })).toBe(false);
    expect(isRichBlock({ type: 'image', assetId: 7, alt: '' })).toBe(false);
    // Each field is what it claims to be, so a hand-damaged picture is reported, never read.
    expect(isRichBlock({ type: 'image', assetId: 'img_a', alt: 7 })).toBe(false);
    expect(isRichBlock({ type: 'image', assetId: 'img_a', alt: '', caption: 3 })).toBe(false);
    expect(isRichBlock({ type: 'image', assetId: 'img_a', alt: '', decorative: 'yes' })).toBe(false);
    expect(isRichBlock({ type: 'h2', spans: [] })).toBe(true);
    const clean = cleanBlocks([
      { type: 'image', assetId: 'img_a', alt: '  Two\n potters ', caption: ' Saturday  at the studio. ', decorative: true },
      { type: 'image', assetId: 'img_b', alt: 'x', caption: '   ' },
      { type: 'image', assetId: '', alt: 'gone' }
    ]);
    expect(clean).toEqual([
      { type: 'image', assetId: 'img_a', alt: 'Two potters', caption: 'Saturday at the studio.', decorative: true },
      { type: 'image', assetId: 'img_b', alt: 'x' }
    ]);
    expect(spanRuns(clean[0])).toEqual([]);
    expect(toRichText(ARTICLE)).toEqual(ARTICLE);
  });

  it('reads "## " as a section heading only in an article, and escapes a paragraph that starts with it', () => {
    expect(parseRichText('## Hours', { markdown: true })).toEqual([{ type: 'p', spans: [{ text: '## Hours' }] }]);
    expect(parseRichText('## Hours', { markdown: true, articles: true })).toEqual([{ type: 'h2', spans: [{ text: 'Hours' }] }]);
    expect(parseRichText('##Hours', { markdown: true, articles: true })).toEqual([{ type: 'p', spans: [{ text: '##Hours' }] }]);
    expect(parseRichText('## Hours', { articles: true })).toEqual([{ type: 'p', spans: [{ text: '## Hours' }] }]);
    const md = richTextToMarkdown([{ type: 'p', spans: [{ text: '## not a heading' }] }], {});
    expect(md).toBe('\\## not a heading');
    expect(parseRichText(md, { markdown: true, articles: true })).toEqual([{ type: 'p', spans: [{ text: '## not a heading' }] }]);
    expect(escapeLineStart('### x')).toBe('\\### x');
  });

  it('says a picture in words by its caption, else its description, and in the text form as an image line', () => {
    expect(richTextToPlain(ARTICLE)).toBe('We open the doors.\n\nAt the workshop\n\nSaturday at the studio.\n\nClay\nGlaze');
    const bare: RichText = [
      { type: 'image', assetId: 'img_a', alt: 'A kiln' },
      { type: 'image', assetId: 'img_b', alt: 'Hidden words', decorative: true }
    ];
    expect(richTextToPlain(bare)).toBe('A kiln');
    expect(richTextToMarkdown(bare, {})).toBe('![A kiln](asset:img_a)\n\n![](asset:img_b)');
    const md = richTextToMarkdown(ARTICLE, {});
    expect(md).toContain('## At the workshop');
    expect(md).toContain('![Two potters glazing](asset:img_a "Saturday at the studio.")');
    expect(md).toContain('![](asset:img_b)');
  });
});

describe('entry text in the project', () => {
  it('keeps section headings and pictures in an entry', () => {
    const s = withBody(blog(), ARTICLE);
    expect(s.collections.posts.entries.en_spring.body).toEqual(ARTICLE);
    // Written as text too: "## " is a heading there.
    const t = withBody(blog(), '## Hours\nOpen late on Fridays.');
    expect(t.collections.posts.entries.en_spring.body).toEqual([
      { type: 'h2', spans: [{ text: 'Hours' }] },
      { type: 'p', spans: [{ text: 'Open late on Fridays.' }] }
    ]);
  });

  it('refuses section headings and pictures anywhere but an entry', () => {
    const s = blog();
    expect(() => normalizeRichText([{ type: 'h2', spans: [{ text: 'x' }] }], s, 'Text')).toThrow(/collection entry/);
    expect(() => normalizeRichText([{ type: 'image', assetId: 'img_a', alt: 'x' }], s, 'Text')).toThrow(/collection entry/);
    // A component's text keeps reading "## " as words.
    expect(normalizeRichText('## Hours', s, 'Text')).toEqual([{ type: 'p', spans: [{ text: '## Hours' }] }]);
  });

  it('refuses a picture that is not a library image, or a caption over its limit', () => {
    const s = blog();
    expect(() => withBody(s, [{ type: 'image', assetId: 'img_gone', alt: '' }])).toThrow(EngineError);
    expect(() => withBody(s, [{ type: 'image', assetId: 'doc_a', alt: '' }])).toThrow(/not an image/);
    expect(() => withBody(s, [{ type: 'image', assetId: 'img_a', alt: '', caption: 'x'.repeat(301) }])).toThrow(/caption/);
    expect(withBody(s, [{ type: 'image', assetId: 'img_a', alt: '', caption: 'x'.repeat(300) }]).collections.posts.entries.en_spring.body).toHaveLength(1);
    expect(() => withBody(s, [{ type: 'image', assetId: 'img_a', alt: 7 }])).toThrow(EngineError);
    expect(() => withBody(s, [{ type: 'image', assetId: 'img_a', alt: '', caption: 4 }])).toThrow(EngineError);
    // Stored as the page shows it: one line, and no empty caption.
    const t = withBody(s, [{ type: 'image', assetId: 'img_a', alt: ' Two\n potters ', caption: ' ' }]);
    expect(t.collections.posts.entries.en_spring.body).toEqual([{ type: 'image', assetId: 'img_a', alt: 'Two potters' }]);
  });

  it('gives an entry room for a long article, and a component its own smaller limit', () => {
    const s = blog();
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'word '.repeat(80)}`.trim());
    const chars = long.join('').length;
    expect(chars).toBeGreaterThan(20000);
    expect(chars).toBeLessThan(MAX_ENTRY_CHARS);
    expect(withBody(s, long).collections.posts.entries.en_spring.body).toHaveLength(60);
    expect(() => normalizeRichText(long, s, 'Text')).toThrow(/too long/);
  });
});

describe('pictures in posts as uses of the library', () => {
  it('counts each picture, featured or in the text, and keeps a used image from being removed', () => {
    const s = run(withBody(blog(), ARTICLE), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', featuredImage: 'img_a', body: [{ type: 'image', assetId: 'img_a', alt: 'Again' }] });
    expect(assetUsages(s).img_a).toBe(3);
    expect(assetUsages(s).img_b).toBe(1);
    expect(() => run(s, { type: 'asset.remove', assetId: 'img_b' })).toThrow(EngineError);
  });

  it('numbers the pictures of a post as its text shows them, and lists picture fields too', () => {
    const s0 = withBody(blog(), [
      { type: 'image', assetId: 'img_b', alt: 'Other' },
      { type: 'image', assetId: 'img_a', alt: 'First' },
      { type: 'p', spans: [{ text: 'Between' }] },
      { type: 'image', assetId: 'img_a', alt: 'Second' }
    ]);
    const s = run(
      s0,
      { type: 'collection.update', collectionId: 'posts', fields: { cover: { type: 'image', label: 'Cover', default: { assetId: 'img_a', alt: '' } } } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', values: { cover: { assetId: 'img_a', alt: 'Snow' } } }
    );
    const rows = imageUseRows(s, 'img_a').filter((r) => r.icon === 'post');
    expect(rows.map((r) => [r.where, r.what])).toEqual([
      ['Posts', 'Cover: starting picture for new entries'],
      ['Spring open studio', 'Picture 2 in the text'],
      ['Spring open studio', 'Picture 3 in the text'],
      ['Winter hours', 'Cover']
    ]);
    expect(rows.map((r) => r.post)).toEqual([undefined, { collectionId: 'posts', entryId: 'en_spring', n: 2 }, { collectionId: 'posts', entryId: 'en_spring', n: 3 }, { collectionId: 'posts', entryId: 'en_winter' }]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(4);
  });

  it('lists the uses in Assets by post, and opens the post from each', () => {
    const s = run(withBody(blog(), ARTICLE), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', featuredImage: 'img_a' });
    const uses = imageUses(s, 'img_a').filter((u) => u.entry);
    expect(uses.map((u) => u.entry)).toEqual([
      { collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', field: 'body', n: 1 },
      { collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', field: 'featured' }
    ]);
    // Changed only with every other use: no place a replacement in some places can name.
    expect(uses.every((u) => u.target === null)).toBe(true);
    const rows = imageUseRows(s, 'img_a').filter((r) => r.post);
    expect(rows.map((r) => [r.where, r.what, r.post])).toEqual([
      ['Spring open studio', 'Picture 1 in the text', { collectionId: 'posts', entryId: 'en_spring', n: 1 }],
      ['Winter hours', 'Featured image', { collectionId: 'posts', entryId: 'en_winter' }]
    ]);
    expect(new Set(imageUseRows(s, 'img_a').map((r) => r.key)).size).toBe(imageUseRows(s, 'img_a').length);
  });

  it('replaces a picture in a post with every other use, its suggested description following, its own kept', () => {
    const s0 = withBody(blog(), [
      { type: 'image', assetId: 'img_a', alt: 'A potter at the wheel' },
      { type: 'image', assetId: 'img_a', alt: 'My own words', caption: 'Kept' }
    ]);
    const s = run(s0, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b' });
    expect(s.collections.posts.entries.en_spring.body).toEqual([
      { type: 'image', assetId: 'img_b', alt: 'Bowls drying on a shelf' },
      { type: 'image', assetId: 'img_b', alt: 'My own words', caption: 'Kept' }
    ]);
    expect(assetUsages(s).img_a).toBeUndefined();
  });

  it('changes pictures in posts only with every other use, keeping a decorative one and a kept description as they are', () => {
    const start = withBody(blog(), [
      { type: 'image', assetId: 'img_a', alt: 'A potter at the wheel' },
      { type: 'image', assetId: 'img_a', alt: 'Shown as nothing', decorative: true },
      { type: 'image', assetId: 'img_b', alt: 'Unrelated' }
    ]);
    const page = start.site.homePageId;
    // Placed on a page too, so a replacement can choose that place alone.
    const s0 = run(start, { type: 'page.update', pageId: page, socialImage: 'img_a' } as EditOperation);
    expect(s0.pages[page].seo.socialImage).toBe('img_a');
    const some = run(s0, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b', uses: [{ kind: 'pageSharing', pageId: page }] });
    expect(some.collections.posts.entries.en_spring.body).toEqual(s0.collections.posts.entries.en_spring.body);
    const all = run(s0, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b' });
    expect(all.collections.posts.entries.en_spring.body).toEqual([
      { type: 'image', assetId: 'img_b', alt: 'Bowls drying on a shelf' },
      { type: 'image', assetId: 'img_b', alt: 'Shown as nothing', decorative: true },
      { type: 'image', assetId: 'img_b', alt: 'Unrelated' }
    ]);
    const kept = run(s0, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b', keepAlt: true });
    expect(kept.collections.posts.entries.en_spring.body[0]).toEqual({ type: 'image', assetId: 'img_b', alt: 'A potter at the wheel' });
  });

  it('follows a suggested description written with doubled spaces, as the picture stores it on one line', () => {
    const s0 = blog();
    s0.assets.assets.img_a.altSuggestion = 'A potter  at the wheel';
    const s = run(withBody(s0, [{ type: 'image', assetId: 'img_a', alt: 'A potter  at the wheel' }]), { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b' });
    expect(s.collections.posts.entries.en_spring.body).toEqual([{ type: 'image', assetId: 'img_b', alt: 'Bowls drying on a shelf' }]);
  });

  it('reports a damaged picture as damaged text, without failing to open the project', () => {
    const s = withBody(blog(), ARTICLE);
    (s.collections.posts.entries.en_spring.body as unknown[])[2] = { type: 'image', assetId: 'img_a', alt: { toString: null } };
    const found = validateState(s).filter((d) => d.code === 'ENTRY_INVALID');
    expect(found.map((d) => d.message)).toEqual(['The Posts collection: the entry en_spring is damaged.']);
    // The page leaves it out rather than showing what it holds.
    const resolved = resolveRichText(s.collections.posts.entries.en_spring.body, { state: s }) as Array<{ type: string }>;
    expect(resolved.map((b) => b.type)).toEqual(['p', 'h2', 'ul', 'image']);
  });

  it('warns about a section heading or picture in a page\'s text, which only a post holds', () => {
    const s = blog();
    const home = s.pages[s.site.homePageId];
    const node = home.nodes[home.rootIds[0]] as unknown as { id: string; props: Record<string, unknown> };
    expect(validateState(s).filter((d) => d.code === 'ARTICLE_BLOCK')).toEqual([]);
    node.props.sneaked = [{ type: 'h2', spans: [{ text: 'Sneaked in' }] }, { type: 'image', assetId: 'img_a', alt: 'x' }];
    expect(validateState(s).filter((d) => d.code === 'ARTICLE_BLOCK').map((d) => [d.nodeId, /section heading|picture/.exec(d.message)?.[0]])).toEqual([
      [node.id, 'section heading'],
      [node.id, 'picture']
    ]);
  });

  it('reports a picture that is no longer in the library, and one left undescribed', () => {
    const s = withBody(blog(), [
      { type: 'image', assetId: 'img_b', alt: 'Described' },
      { type: 'image', assetId: 'img_a', alt: '' },
      { type: 'image', assetId: 'img_b', alt: '', decorative: true }
    ]);
    const body = (t: ProjectState) => validateState(t).filter((d) => /in its text/.test(d.message)).map((d) => [d.code, d.message]);
    expect(body(s)).toEqual([['ALT_MISSING', 'Posts: “Spring open studio”: picture 2 in its text has no description.']]);
    delete s.assets.assets.img_a;
    s.assets.assets.img_b = { ...s.assets.assets.img_b, kind: 'document', mime: 'application/pdf' };
    expect(body(s)).toEqual([
      ['ASSET_NOT_IMAGE', 'Posts: “Spring open studio”: picture 1 in its text is “Photo img_b”, which is a document, not a picture.'],
      ['ASSET_MISSING', 'Posts: “Spring open studio”: picture 2 in its text is not in the library.'],
      ['ASSET_NOT_IMAGE', 'Posts: “Spring open studio”: picture 3 in its text is “Photo img_b”, which is a document, not a picture.']
    ]);
  });
});

describe('the post page', () => {
  it('renders a picture with its caption, and a section heading, through the site runtime', () => {
    const s = withBody(blog(), ARTICLE);
    const resolved = resolveRichText(s.collections.posts.entries.en_spring.body, { state: s }) as Array<Record<string, unknown>>;
    expect(resolved[2]).toMatchObject({ type: 'image', caption: 'Saturday at the studio.', image: { src: '/assets/img_a-1a2b3c4d.png', alt: 'Two potters glazing', width: 1200, height: 800 } });
    expect(resolved[4]).toMatchObject({ type: 'image', image: { decorative: true } });
    expect(resolved[4]).not.toHaveProperty('caption');
    const page = generateEntry(s, 'posts', 'en_spring');
    expect(page).toContain('SoRichText');
    expect(page).toContain('Saturday at the studio.');
    expect(page).toContain('.so-rich__figure');
    // An entry whose text has no section heading or picture gets no article rules.
    expect(generateEntry(blog(), 'posts', 'en_spring')).not.toContain('.so-rich__figure');
    expect(RICHTEXT_SVELTE).toContain("import SoImage from './Image.svelte';");
    expect(RICHTEXT_SVELTE).toMatch(/block\.type === 'image'[\s\S]*<figure class="so-rich__figure">[\s\S]*<figcaption>\{block\.caption\}<\/figcaption>/);
    expect(RICHTEXT_SVELTE).toContain('<h2>{@render inline(block.spans)}</h2>');
  });

  it('shows a placeholder, never a broken file, for a picture no longer in the library', () => {
    const s = withBody(blog(), ARTICLE);
    delete s.assets.assets.img_a;
    const resolved = resolveRichText(s.collections.posts.entries.en_spring.body, { state: s }) as Array<Record<string, unknown>>;
    expect(resolved[2]).toMatchObject({ type: 'image', image: { src: null } });
  });
});

describe('the Posts writer reads its text', () => {
  const s = blog();
  const article = { link: (href: string) => (href.startsWith('entry:') ? { type: 'entry' as const, target: href.slice(6) } : null) };
  it('keeps section headings, pictures and links to posts in article mode', () => {
    const { blocks } = blocksFromDom(
      [
        { tag: 'h2', children: ['Hours'] },
        { tag: 'p', children: ['See ', { tag: 'a', href: 'entry:en_winter', children: ['winter'] }, '.'] },
        { tag: 'figure', image: { assetId: 'img_a', alt: 'Potter', caption: 'At work' }, children: [] },
        { tag: 'p', children: ['After'] }
      ],
      s.pages,
      article
    );
    expect(blocks).toEqual([
      { type: 'h2', spans: [{ text: 'Hours' }] },
      { type: 'p', spans: [{ text: 'See ' }, { text: 'winter', link: { type: 'entry', target: 'en_winter' } }, { text: '.' }] },
      { type: 'image', assetId: 'img_a', alt: 'Potter', caption: 'At work' },
      { type: 'p', spans: [{ text: 'After' }] }
    ]);
  });

  it('leaves the canvas as it was: a heading there is a page section (h3), and a picture is read as its words', () => {
    const { blocks } = blocksFromDom([{ tag: 'h2', children: ['Hours'] }, { tag: 'figure', image: { assetId: 'img_a', alt: 'x' }, children: [{ tag: 'figcaption', children: ['Kiln at night'] }] }], s.pages);
    expect(blocks).toEqual([{ type: 'h3', spans: [{ text: 'Hours' }] }, { type: 'p', spans: [{ text: 'Kiln at night' }] }]);
  });
});

describe('checked writes of a post', () => {
  it('reads each field an entry update writes, and names the post', () => {
    const s = withBody(blog(), ARTICLE);
    const op: EditOperation = { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [] };
    expect(readField(s, op)).toEqual({ found: true, value: { body: ARTICLE } });
    expect(readField(s, { ...op, body: undefined, title: 'x', excerpt: null, draft: true } as EditOperation)).toEqual({ found: true, value: { title: 'Spring open studio', excerpt: undefined, draft: false } });
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, collectionId: 'news' } as EditOperation]));
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, body: undefined, title: 'x' } as EditOperation]));
    expect(readField(s, { ...op, entryId: 'en_gone' } as EditOperation)).toEqual({ found: false, what: 'post' });
    expect(placeOf(s, op)).toBe('Spring open studio');
    // Typing in one post's text never replaces a held edit of another's.
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, entryId: 'en_winter' } as EditOperation]));
    expect(fieldKey([op])).toBe(fieldKey([{ ...op, body: ARTICLE } as EditOperation]));
  });
});

describe('the Posts list', () => {
  it('finds posts by their words and sorts them, ties in the collection order', () => {
    const s = run(blog(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_autumn', title: 'Autumn kiln firing', publishedAt: '2027-03-02', excerpt: 'Glaze tests' });
    const c = s.collections.posts;
    expect(postRows(c, '', 'newest').map((r) => r.id)).toEqual(['en_autumn', 'en_spring', 'en_winter']);
    expect(postRows(c, '', 'oldest').map((r) => r.id)).toEqual(['en_winter', 'en_autumn', 'en_spring']);
    expect(postRows(c, '', 'title').map((r) => r.title)).toEqual(['Autumn kiln firing', 'Spring open studio', 'Winter hours']);
    expect(postRows(c, 'GLAZE', 'newest').map((r) => r.id)).toEqual(['en_autumn']);
    expect(postRows(c, 'kiln', 'newest').map((r) => r.id)).toEqual(['en_autumn']);
    expect(postRows(c, 'open-studio', 'newest').map((r) => r.id)).toEqual(['en_spring']);
    // A chosen order decides between posts of the same day, and is the order of its own.
    const ordered = run(s, { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_winter', 'en_autumn'] }).collections.posts;
    expect(postRows(ordered, '', 'newest').map((r) => r.id)).toEqual(['en_spring', 'en_autumn', 'en_winter']);
    expect(postRows(ordered, '', 'order').map((r) => r.id)).toEqual(['en_spring', 'en_winter', 'en_autumn']);
    expect(postRows(c, 'ana', 'newest').map((r) => r.id)).toEqual(['en_winter']);
    expect(postRows(c, '', 'newest').find((r) => r.id === 'en_spring')).toMatchObject({ draft: false, date: '2027-03-02', route: '/blog/spring-open-studio/' });
    expect(postRows(c, '', 'newest').find((r) => r.id === 'en_winter')?.draft).toBe(true);
  });

  it('creates the blog with the first post, and puts later ones in the collection shown', () => {
    const empty = createStarterState('business', 'Riverside Studio', false);
    const first = newPostOps(empty, null, '  Opening day ');
    expect(first.ops[0]).toEqual({ type: 'collection.create', collectionId: 'posts' });
    const s = run(empty, ...first.ops);
    expect(s.collections.posts.entries[first.ref.entryId]).toMatchObject({ title: 'Opening day', draft: true });
    const next = newPostOps(s, 'posts', 'Second');
    expect(next.ops).toHaveLength(1);
    expect(postsCollection(s, null)?.settings.id).toBe('posts');
    // Into the collection shown, when the project has several.
    const two = run(s, { type: 'collection.create', collectionId: 'case-studies' });
    const study = newPostOps(two, 'case-studies', 'Harbour house');
    expect(study.ref.collectionId).toBe('case-studies');
    expect(run(two, ...study.ops).collections['case-studies'].entries[study.ref.entryId].title).toBe('Harbour house');
  });

  it('duplicates a post as a dated draft with its text, pictures and byline', () => {
    const s = run(
      withBody(blog(), ARTICLE),
      { type: 'collection.update', collectionId: 'posts', taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' } } } }, fields: { mood: { type: 'string', label: 'Mood', default: '' } } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', author: 'Ana', excerpt: 'Doors open', featuredImage: 'img_b', publishedAt: '2020-01-02', terms: { categories: ['news'] }, values: { mood: 'Warm' } }
    );
    const plan = duplicatePostOps(s, { collectionId: 'posts', entryId: 'en_spring' })!;
    const t = run(s, ...plan.ops);
    const copy = t.collections.posts.entries[plan.ref.entryId];
    expect(copy).toMatchObject({ title: 'Spring open studio (copy)', draft: true, author: 'Ana', excerpt: 'Doors open', featuredImage: 'img_b', body: ARTICLE, terms: { categories: ['news'] }, values: { mood: 'Warm' } });
    // Dated the day it is made, not the day of the post it copies.
    expect(copy.publishedAt).toBe(todayArticleDate());
    expect(copy.slug).not.toBe(s.collections.posts.entries.en_spring.slug);
    expect(assetUsages(t).img_a).toBe(2);
  });
});
