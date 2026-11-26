/**
 * Collection layouts (#394): each collection's entries are shown with one layout, a tree of sections and elements
 * edited like a page's, whose elements and placed sections read the entry they are shown for through
 * `{ $entry: field }`. Editing the layout once changes every entry's page; each entry keeps its own words and details.
 */
import { describe, expect, it } from 'vitest';
import type { ElementNode, GraphNode, InstanceNode, LinkNode, NodeTree, OwnerRef, ProjectState, TextNode } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject, generateSiteCss, pageNodeClass, publishedState } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { missingSectionLinks, publicationPlan } from '@generator/checks';
import { entryNeighbours, materializeTemplate } from '@generator/entry-template';
import { entryMetadata } from '@generator/seo-metadata';
import { entryFieldSchemas, entryFieldValue, readingMinutes } from '@shared/entry-fields';
import { migrateProject } from '@shared/migrations';
import { keepTemplateValid, sampleEntries, shownView, viewAt } from '../../src/renderer/src/lib/template-view';
import { keepViewValid, parseCtx, treeFor } from '../../src/renderer/src/lib/model';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const POSTS: OwnerRef = { kind: 'template', id: 'posts' };

/** The ready-made blog: two published posts (the later one first in the order) and a draft between them by date. */
function blog(theme = 'foundation') {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'theme.apply', themeId: theme },
    { type: 'site.update', baseUrl: 'https://example.com' },
    {
      type: 'collection.create',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' }, craft: { label: 'Craft' } } }, tags: { label: 'Tags', terms: {} } },
      fields: { price: { type: 'string', label: 'Price', default: 'Free' }, seats: { type: 'number', label: 'Seats' } }
    },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter workshop', publishedAt: '2026-01-12', draft: false, author: 'Ana Ruiz', excerpt: 'Three evenings of glazing.', body: ['Bring an apron.'], terms: { categories: ['craft', 'news'] } },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans', publishedAt: '2026-02-01', body: ['Not yet.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2026-03-02', draft: false, body: ['Twenty new makers.'], values: { price: '£10' } }
  );
}

const template = (s: ProjectState) => s.collections.posts.settings.template;
/** The layout's node showing `field` as its text. */
const bound = (s: ProjectState, field: string) => Object.values(template(s).nodes).find((n) => n.kind === 'text' && JSON.stringify(n.text) === JSON.stringify({ $entry: field })) as TextNode;
const pageOf = (files: Map<string, string>, slug: string) => files.get(`src/routes/blog/${slug}/+page.svelte`)!;

describe('a collection layout', () => {
  it('starts every collection with the theme’s article layout, which every entry is shown with', () => {
    const s = blog();
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(publishedState(s));
    const winter = pageOf(files, 'winter-workshop');
    const spring = pageOf(files, 'spring-open-studio');
    // Each entry's own title, date, author, categories, reading time and text, in the same layout.
    expect(winter).toContain('{"Winter workshop"}</h1>');
    expect(winter).toContain('<time datetime={"2026-01-12"}>{"January 12, 2026"}</time>');
    expect(winter).toContain('{"Ana Ruiz"}');
    expect(winter).toContain('{"Craft, News"}');
    expect(winter).toContain('{"1 min read"}');
    expect(winter).toContain('Bring an apron.');
    expect(spring).toContain('{"Spring open studio"}</h1>');
    expect(spring).toContain('Twenty new makers.');
    expect(spring).not.toContain('Ana Ruiz');
    // What an entry lacks (an author, categories, an excerpt) is left out, not shown empty.
    expect(spring).not.toMatch(/<p class=\{\["so-n-[a-z0-9_]+"\]\}>\{""\}<\/p>/);
    const classes = (t: string) => [...t.matchAll(/class=\{\["(so-n-[a-z0-9_-]+)"\]\}/g)].map((m) => m[1]);
    expect(classes(winter).filter((c) => classes(spring).includes(c)).length).toBeGreaterThan(5);
  });

  it('changes every entry’s page when the layout is edited once, and keeps each entry’s own copy', () => {
    let s = blog();
    const before = generateProject(publishedState(s));
    const title = bound(s, 'title');
    const r = applyOperations(s, [
      { type: 'node.setStyle', owner: POSTS, nodeId: title.id, scope: 'base', property: 'color', value: '#aa0000' },
      { type: 'node.setStyle', owner: POSTS, nodeId: title.id, scope: 'phone', property: 'fontSize', value: '2rem' },
      { type: 'node.insert', owner: POSTS, parentId: null, componentId: 'cta.banner', props: { heading: 'Join the next class' } }
    ]);
    s = r.state;
    const cta = r.results[2].nodeId as string;
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(publishedState(s));
    const css = generateSiteCss(s);
    expect(css).toContain(`.${pageNodeClass(title.id)}`);
    expect(css).toMatch(new RegExp(`\\.${pageNodeClass(title.id)} \\{[^}]*#aa0000`));
    // Responsive scopes too: the phone size of the title, for every entry.
    expect(css).toMatch(new RegExp(`@media[^{]*\\{[^@]*\\.${pageNodeClass(title.id)} \\{[^}]*font-size: 2rem`));
    for (const [slug, own] of [
      ['winter-workshop', 'Winter workshop'],
      ['spring-open-studio', 'Spring open studio']
    ]) {
      const page = pageOf(files, slug);
      expect(page).toContain(`{"${own}"}</h1>`);
      expect(page).toContain('Join the next class');
      expect(page).toContain(pageNodeClass(title.id));
      expect(page).not.toBe(pageOf(before, slug));
    }
    // The entries' own documents are untouched.
    expect(s.collections.posts.entries).toEqual(blog().collections.posts.entries);
    // A page is not an entry: the layout's new section is on entry pages only.
    expect([...files].filter(([f, t]) => f.startsWith('src/routes/') && !f.includes('/blog/') && t.includes('Join the next class'))).toEqual([]);
    expect(Object.values(template(s).nodes).some((n) => n.id === cta)).toBe(true);
  });

  it('writes the editor’s identity for the layout’s elements in the preview, and nothing of it in the website', () => {
    const s = blog();
    const dev = pageOf(generateProject(s, { instrument: true }), 'winter-workshop');
    expect(dev).toContain('data-so-ctx={"template:posts"}');
    expect(dev).toContain(`data-so-node="${bound(s, 'title').id}"`);
    expect(pageOf(generateProject(s), 'winter-workshop')).not.toMatch(/data-so-|siteorigin-bridge/);
    expect(parseCtx('template:posts')).toEqual({ owner: POSTS, path: [] });
    expect(treeFor(s, POSTS)).toBe(template(s));
  });
});

describe('entry fields', () => {
  it('offers every built-in field, each grouping and each custom field, and reads them for an entry', () => {
    const s = blog();
    const c = s.collections.posts;
    const fields = entryFieldSchemas(c);
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['title', 'publishedAt', 'updatedAt', 'author', 'excerpt', 'featuredImage', 'categories', 'body', 'readingTime', 'prevEntry', 'nextEntry', 'terms.tags', 'field.price', 'field.seats']));
    const read = (id: string) => ({ state: s, collection: c, entry: c.entries[id], neighbours: entryNeighbours(s, 'posts', id) });
    expect(entryFieldValue(read('en_winter'), 'publishedAt', 'raw')).toBe('2026-01-12');
    expect(entryFieldValue(read('en_winter'), 'categories')).toBe('Craft, News');
    expect(entryFieldValue(read('en_winter'), 'field.price')).toBe('Free');
    expect(entryFieldValue(read('en_spring'), 'field.price')).toBe('£10');
    expect(entryFieldValue(read('en_spring'), 'featuredImage')).toEqual({ assetId: null, alt: '' });
    expect(entryFieldValue(read('en_spring'), 'nope')).toBeUndefined();
    expect(readingMinutes([{ type: 'p', spans: [{ text: 'word '.repeat(401) }] }])).toBe(3);
    expect(readingMinutes([])).toBe(0);
    // Reading time is minutes, shown in the site's words: a condition compares the minutes, whatever the wording.
    expect(fields.readingTime.type).toBe('number');
    expect(entryFieldValue(read('en_winter'), 'readingTime', 'raw')).toBe(1);
    expect(entryFieldValue(read('en_winter'), 'readingTime')).toBe('1 min read');
    // A condition on the minutes holds whatever the site's wording for them.
    const t = bound(s, 'excerpt');
    const reading = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: t.id, field: 'when', binding: { $entry: 'readingTime' }, eq: 1 }, { type: 'site.update', visitorText: { language: 'en', text: { readingTime: 'A {count}-minute read' } } });
    const article = materializeTemplate(reading, reading.collections.posts, reading.collections.posts.entries.en_winter, {});
    expect(JSON.stringify(article)).toContain('Three evenings of glazing.');
    // Something not a field name (a hand edit) reads as nothing rather than failing.
    expect(entryFieldValue(read('en_winter'), 42 as unknown as string)).toBeUndefined();
  });

  it('links each published entry to the ones listed beside it, never to a draft, in the collection’s order', () => {
    let s = blog();
    // Newest first: Spring, (the draft), Winter.
    expect(entryNeighbours(s, 'posts', 'en_spring')).toEqual({ next: s.collections.posts.entries.en_winter });
    expect(entryNeighbours(s, 'posts', 'en_winter')).toEqual({ prev: s.collections.posts.entries.en_spring });
    // A draft shown in the editor has the published entries on either side of it.
    expect(entryNeighbours(s, 'posts', 'en_secret')).toEqual({ prev: s.collections.posts.entries.en_spring, next: s.collections.posts.entries.en_winter });
    let files = generateProject(publishedState(s));
    expect(pageOf(files, 'spring-open-studio')).toContain('"href":"/blog/winter-workshop/"');
    expect(pageOf(files, 'spring-open-studio')).toContain('{"Next: Winter workshop"}');
    expect(pageOf(files, 'winter-workshop')).toContain('"href":"/blog/spring-open-studio/"');
    expect(pageOf(files, 'winter-workshop')).not.toContain('secret');
    // An editorial order decides it instead.
    s = run(s, { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_winter', 'en_secret', 'en_spring'] });
    files = generateProject(publishedState(s));
    expect(entryNeighbours(s, 'posts', 'en_winter')).toEqual({ next: s.collections.posts.entries.en_spring });
    expect(pageOf(files, 'winter-workshop')).toContain('{"Next: Spring open studio"}');
  });

  it.each(['foundation', 'editorial', 'signal'])('names the links to the posts beside one, with one arrow, in a named nav (%s)', (theme) => {
    const s = run(blog(theme), { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false });
    expect(s.site.themeId).toBe(theme);
    const c = s.collections.posts;
    const shownOn = (state: ProjectState, id: string) => materializeTemplate(state, state.collections.posts, state.collections.posts.entries[id], entryNeighbours(state, 'posts', id));
    const article = shownOn(s, 'en_secret');
    const nav = Object.values(article.nodes).find((n) => n.name === 'Previous and next') as ElementNode;
    expect(nav).toMatchObject({ tag: 'nav', ariaLabel: 'Previous and next' });
    // Both links are inside it, in its one row.
    expect((article.nodes[nav.children[0]] as ElementNode).children.map((id) => article.nodes[id].name)).toEqual(['Previous entry', 'Next entry']);
    const prev = Object.values(article.nodes).find((n) => n.name === 'Previous entry') as LinkNode;
    const next = Object.values(article.nodes).find((n) => n.name === 'Next entry') as LinkNode;
    // A plain link has no arrow; a text button has the theme's one, after it. Neither adds an icon of its own.
    expect(prev).toMatchObject({ appearance: 'link', label: 'Previous: Spring open studio', link: { type: 'entry', target: 'en_spring' } });
    expect(next).toMatchObject({ appearance: 'text', label: 'Next: Winter workshop', link: { type: 'entry', target: 'en_winter' } });
    expect([prev.icon, next.icon]).toEqual([undefined, undefined]);
    const page = generateProject(publishedState(s)).get('src/routes/blog/secret-plans/+page.svelte')!;
    expect(page).toMatch(/<nav [^>]*aria-label=\{"Previous and next"\}>/);
    expect(page).toContain('{"Previous: Spring open studio"}');
    expect(page).toContain('{"Next: Winter workshop"}');
    expect(page).not.toContain('so-link__icon');
    // A post with no post beside it has no empty landmark.
    const lone = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: true });
    expect(generateProject(publishedState(lone)).get('src/routes/blog/secret-plans/+page.svelte')).not.toContain('<nav ');
    expect(entryFieldValue({ state: s, collection: c, entry: c.entries.en_spring, neighbours: entryNeighbours(s, 'posts', 'en_spring') }, 'prevEntry.label')).toBe('');
    expect(entryFieldValue({ state: s, collection: c, entry: c.entries.en_spring, neighbours: {} }, 'entryNavLabel')).toBe('');
  });

  it('words the links beside a post as the site does, and keeps the title when the wording leaves it out', () => {
    // Set after the layout is made: the layout reads the wording rather than holding a copy of it.
    const s = run(
      blog(),
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Costs $& more' },
      { type: 'site.update', language: 'he' }
    );
    const words = (state: ProjectState) => {
      const article = materializeTemplate(state, state.collections.posts, state.collections.posts.entries.en_secret, entryNeighbours(state, 'posts', 'en_secret'));
      return Object.values(article.nodes).flatMap((n) => (n.name === 'Previous and next' ? [(n as ElementNode).ariaLabel] : n.name === 'Previous entry' || n.name === 'Next entry' ? [(n as LinkNode).label] : []));
    };
    expect(words(s).sort()).toEqual(['הקודם והבא', 'הקודם: Costs $& more', 'הבא: Winter workshop'].sort());
    const own = run(s, { type: 'site.update', visitorText: { language: 'he', text: { entryNav: 'More', entryPrevious: 'Before: {title}.', entryNext: 'After: {title}.' } } });
    expect(words(own).sort()).toEqual(['After: Winter workshop.', 'Before: Costs $& more.', 'More']);
    const bare = run(s, { type: 'site.update', visitorText: { language: 'he', text: { entryNav: 'More', entryPrevious: 'Go back', entryNext: 'Go on' } } });
    expect(words(bare).sort()).toEqual(['Go back Costs $& more', 'Go on Winter workshop', 'More']);
  });

  it('shows an element only for the entries its condition holds for, and a collapsing one only with something in it', () => {
    let s = blog();
    s.assets.assets.img_hall = { id: 'img_hall', name: 'Hall', file: 'static/assets/hall-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1600, height: 900, hash: 'h', kind: 'image', altSuggestion: 'The great hall', createdAt: '2026-01-01T00:00:00.000Z' };
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', featuredImage: 'img_hall' });
    const c = s.collections.posts;
    const image = Object.values(template(s).nodes).find((n) => n.kind === 'image')!;
    const winter = materializeTemplate(s, c, c.entries.en_winter, entryNeighbours(s, 'posts', 'en_winter'));
    const spring = materializeTemplate(s, c, c.entries.en_spring, entryNeighbours(s, 'posts', 'en_spring'));
    const shown = (t: NodeTree, id: string) => {
      const seen = new Set<string>();
      const walk = (ids: string[]) => ids.forEach((i) => (seen.add(i), walk(((t.nodes[i] as { children?: string[] }).children ?? []).slice())));
      walk(t.rootIds);
      return seen.has(id);
    };
    expect(shown(winter, image.id)).toBe(true);
    expect((winter.nodes[image.id] as GraphNode & { image: unknown }).image).toEqual({ assetId: 'img_hall', alt: 'The great hall' });
    expect(shown(spring, image.id)).toBe(false);
    // Spring has no excerpt, author or categories: those elements go, and the layout itself never changes.
    expect(shown(spring, bound(s, 'excerpt').id)).toBe(false);
    expect(shown(spring, bound(s, 'author').id)).toBe(false);
    expect(JSON.stringify(template(s))).toContain('"$entry":"featuredImage"');
    // An entry with no neighbour at all: the links' row and the band around it collapse, not only the links.
    const alone = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_secret' });
    const more = Object.values(template(s).nodes).find((n) => n.name === 'Previous and next')!;
    const lone = materializeTemplate(alone, alone.collections.posts, alone.collections.posts.entries.en_winter, entryNeighbours(alone, 'posts', 'en_winter'));
    expect(shown(lone, more.id)).toBe(false);
    expect(shown(winter, more.id)).toBe(true);
    // A comparison reads the stored value: only entries with that price show it.
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: bound(s, 'excerpt').id, field: 'unless', binding: { $entry: 'field.price' }, eq: 'Free' });
    const after = s.collections.posts;
    expect(shown(materializeTemplate(s, after, after.entries.en_winter, {}), bound(s, 'excerpt').id)).toBe(false);
  });
});

describe('the alt text of an entry’s picture', () => {
  it('is its suggested alt text wherever it is published, and never the library’s note about the file', () => {
    let s = blog();
    s = run(s, { type: 'collection.update', collectionId: 'posts', fields: { photo: { type: 'image', label: 'Photo' } } });
    const picture = { file: 'static/assets/hall-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1600, height: 900, kind: 'image' as const, description: 'Sample image. Replace it with your own.', createdAt: '2026-01-01T00:00:00.000Z' };
    s.assets.assets.img_hall = { ...picture, id: 'img_hall', name: 'Hall', hash: 'h', altSuggestion: '  The great hall  ' };
    s.assets.assets.img_bare = { ...picture, id: 'img_bare', name: 'Bare', hash: 'b' };
    s = run(
      s,
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', featuredImage: 'img_hall', values: { photo: { assetId: 'img_hall', alt: '' } } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', featuredImage: 'img_bare', values: { photo: { assetId: 'img_bare', alt: '' } } }
    );
    const c = s.collections.posts;
    const read = (id: string) => ({ state: s, collection: c, entry: c.entries[id], neighbours: {} });
    for (const field of ['featuredImage', 'field.photo']) {
      expect(entryFieldValue(read('en_winter'), field)).toEqual({ assetId: 'img_hall', alt: 'The great hall' });
      expect(entryFieldValue(read('en_spring'), field)).toEqual({ assetId: 'img_bare', alt: '' });
    }
    expect(entryMetadata(s, 'posts', 'en_winter')!.imageAlt).toBe('The great hall');
    expect(entryMetadata(s, 'posts', 'en_spring')!.imageAlt).toBe('');
    const files = generateProject(publishedState(s));
    const winter = pageOf(files, 'winter-workshop');
    expect(winter).toContain('"alt":"The great hall"');
    expect(winter).toContain('<meta property="og:image:alt" content={"The great hall"} />');
    expect(pageOf(files, 'spring-open-studio')).toContain('<meta property="og:image" content=');
    expect(pageOf(files, 'spring-open-studio')).not.toContain('image:alt');
    expect([...files.values()].join('\n')).not.toContain('Replace it with your own');
  });
});

describe('a custom picture field', () => {
  it('keeps each entry’s own description, or that it is decorative', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', fields: { photo: { type: 'image', label: 'Photo' } } });
    s.assets.assets.img_hall = { id: 'img_hall', name: 'Hall', file: 'static/assets/hall-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1600, height: 900, hash: 'h', kind: 'image', description: 'The great hall', createdAt: '2026-01-01T00:00:00.000Z' };
    s = run(
      s,
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', values: { photo: { assetId: 'img_hall', alt: 'Glazes drying in the hall' } } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', values: { photo: { assetId: 'img_hall', alt: '', decorative: true } } }
    );
    const c = s.collections.posts;
    const read = (id: string) => ({ state: s, collection: c, entry: c.entries[id], neighbours: {} });
    expect(entryFieldValue(read('en_winter'), 'field.photo')).toEqual({ assetId: 'img_hall', alt: 'Glazes drying in the hall' });
    expect(entryFieldValue(read('en_spring'), 'field.photo')).toEqual({ assetId: 'img_hall', alt: '', decorative: true });
  });
});

describe('binding a layout to entry fields', () => {
  it('binds an element or a placed section to a field that fits, and refuses one that does not', () => {
    let s = blog();
    const excerpt = bound(s, 'excerpt');
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'text', binding: { $entry: 'field.price' } }, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'when', binding: null });
    expect(template(s).nodes[excerpt.id]).toMatchObject({ text: { $entry: 'field.price' } });
    // Each entry's own value, or the field's default for one without.
    expect(pageOf(generateProject(publishedState(s)), 'spring-open-studio')).toContain('{"£10"}');
    expect(pageOf(generateProject(publishedState(s)), 'winter-workshop')).toContain('{"Free"}');
    const r = applyOperations(s, [{ type: 'node.insert', owner: POSTS, parentId: null, componentId: 'cta.banner' }]);
    s = r.state;
    const cta = r.results[0].nodeId as string;
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: cta, field: 'prop', prop: 'heading', binding: { $entry: 'title' } });
    expect((template(s).nodes[cta] as InstanceNode).props.heading).toEqual({ $entry: 'title' });
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(publishedState(s));
    expect(pageOf(files, 'winter-workshop').match(/Winter workshop/g)!.length).toBeGreaterThan(pageOf(generateProject(publishedState(blog())), 'winter-workshop').match(/Winter workshop/g)!.length);
    // A picture cannot be text, a date's machine form only a date, and a section's look is the same for every entry.
    expect(() => run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'text', binding: { $entry: 'featuredImage' } })).toThrow(/cannot be shown as the text/);
    expect(() => run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'datetime', binding: { $entry: 'title' } })).toThrow(/not a date/);
    expect(() => run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'text', binding: { $entry: 'field.colour' } })).toThrow(/have no field "field.colour"/);
    expect(() => run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'text', binding: { $prop: 'heading' } })).toThrow(/bind to \{ "\$entry": field \}/);
    // Unbound, it keeps an empty value of its own: never one entry's words.
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'text', binding: null });
    expect(template(s).nodes[excerpt.id]).toMatchObject({ text: '' });
  });

  it('keeps the layout’s structure its own: a tag, or a choice a section does not offer, is never an entry’s', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', fields: { season: { type: 'enum', label: 'Season', default: 'winter', options: [{ value: 'winter', label: 'Winter' }, { value: 'summer', label: 'Summer' }] } } });
    const excerpt = bound(s, 'excerpt');
    expect(() => run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'tag', binding: { $entry: 'field.season' } })).toThrow(/same for every entry/);
    const r = applyOperations(s, [{ type: 'node.insert', owner: POSTS, parentId: null, componentId: 'cta.banner' }]);
    s = r.state;
    const cta = r.results[0].nodeId as string;
    expect(() => run(s, { type: 'node.setBinding', owner: POSTS, nodeId: cta, field: 'prop', prop: 'headingLevel', binding: { $entry: 'field.season' } })).toThrow(/offers "winter", "summer", which "Heading level" does not have/);
    // Stored by hand, it is reported, and the page keeps the layout's own tag.
    const hand = structuredClone(s);
    (hand.collections.posts.settings.template.nodes[excerpt.id] as { tag: unknown }).tag = { $entry: 'field.season' };
    expect(validateState(hand).filter((d) => d.code === 'BINDING_INVALID').map((d) => d.message)).toEqual([expect.stringMatching(/takes its tag from "Season"; that is the layout's own/)]);
    expect(pageOf(generateProject(publishedState(hand)), 'winter-workshop')).not.toMatch(/<winter|<summer/);
    // A field the layout shows can't be removed or retyped under it.
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: excerpt.id, field: 'text', binding: { $entry: 'field.season' } });
    expect(() => run(s, { type: 'collection.update', collectionId: 'posts', fields: {} })).toThrow(/layout shows Season\. Unbind it in the layout before removing it/);
    expect(() => run(s, { type: 'collection.update', collectionId: 'posts', fields: { season: { type: 'string', label: 'Season' } } })).toThrow(/before changing its kind/);
  });

  it('never fails on a hand-edited binding that names no field', () => {
    const s = blog();
    const broken = structuredClone(s);
    const title = broken.collections.posts.settings.template.nodes[bound(s, 'title').id] as TextNode;
    title.when = { $entry: 42 } as never;
    expect(() => generateProject(broken)).not.toThrow();
    expect(validateState(broken).some((d) => d.code === 'BINDING_INVALID' || d.code === 'BINDING_SCOPE')).toBe(true);
  });

  it('never types one entry’s words over a field every entry fills', () => {
    const s = blog();
    expect(() => run(s, { type: 'node.setContent', owner: POSTS, nodeId: bound(s, 'title').id, field: 'text', value: 'Winter workshop' })).toThrow(/each entry's own title/);
  });

  it('reads entry fields only in a layout, and reports a field the collection no longer has', () => {
    let s = blog();
    const home = s.pages[s.site.homePageId];
    const broken = structuredClone(s);
    const node = broken.pages[home.id].nodes[home.rootIds[0]] as GraphNode;
    (node as { when?: unknown }).when = { $entry: 'title' };
    expect(validateState(broken).find((d) => d.code === 'BINDING_SCOPE')?.message).toMatch(/field of a collection entry, which only an element of a collection's layout can/);
    // A custom field the layout shows, gone by a hand edit of the settings: the layout reports it until it is unbound.
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: bound(s, 'excerpt').id, field: 'text', binding: { $entry: 'field.price' } });
    s = structuredClone(s);
    delete s.collections.posts.settings.fields.price;
    expect(validateState(s).filter((d) => d.code === 'BINDING_INVALID').map((d) => d.message)).toEqual([expect.stringMatching(/Posts layout: .*shows "field.price", which entries of Posts do not have/)]);
    // The generated page shows nothing there rather than failing.
    expect(pageOf(generateProject(publishedState(s)), 'winter-workshop')).toContain('Winter workshop');
  });

  it('is an operation the schema takes, with the template owner and an entry binding', () => {
    expect(validateOperation({ type: 'node.setBinding', owner: POSTS, nodeId: 'n_x', field: 'text', binding: { $entry: 'title' } }).ok).toBe(true);
    expect(validateOperation({ type: 'node.setBinding', owner: POSTS, nodeId: 'n_x', field: 'text', binding: { $entry: 'title', $prop: 'x' } }).ok).toBe(false);
  });
});

describe('content checks on entries’ pages', () => {
  it('finds a layout’s sections for links in entries, and a layout’s link to a draft before the website goes out', () => {
    let s = blog();
    const column = Object.values(template(s).nodes).find((n) => n.name === 'Reading column')!;
    s = run(s, { type: 'node.setContent', owner: POSTS, nodeId: column.id, field: 'anchor', value: 'credits' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the credits](#credits).'] });
    expect(missingSectionLinks(s).filter((i) => i.owner.kind === 'entry')).toEqual([]);
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the notes](#notes).'] });
    expect(missingSectionLinks(s).filter((i) => i.owner.kind === 'entry').map((i) => i.fragment)).toEqual(['notes']);
    // A button in the layout linking to a draft page stops the website export, as one on a page does.
    const r = applyOperations(s, [
      { type: 'page.create', pageId: 'pg_plans', title: 'Plans' },
      { type: 'page.update', pageId: 'pg_plans', draft: true },
      { type: 'node.insert', owner: POSTS, parentId: column.id, primitive: 'button', text: 'Our plans' }
    ]);
    s = run(r.state, { type: 'node.setContent', owner: POSTS, nodeId: r.results[2].nodeId as string, field: 'link', value: { type: 'page', target: 'pg_plans' } });
    expect(publicationPlan(s).draftLinks).toEqual([expect.objectContaining({ owner: POSTS, pageId: 'pg_plans', label: 'Our plans' })]);
    // Shown only with an author, which no published post but Winter has: reported for Winter's page alone, once; with
    // no post showing it, nothing stops the website.
    const button = r.results[2].nodeId as string;
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: button, field: 'when', binding: { $entry: 'author' } });
    expect(publicationPlan(s).draftLinks).toHaveLength(1);
    expect(publicationPlan(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', author: '' })).draftLinks).toEqual([]);
    // A section placed in the layout whose button's words are each entry's title is checked with those words.
    const placed = applyOperations(s, [{ type: 'node.insert', owner: POSTS, parentId: null, componentId: 'cta.banner' }]);
    const cta = placed.results[0].nodeId as string;
    const bad = run(
      placed.state,
      { type: 'node.setBinding', owner: POSTS, nodeId: cta, field: 'prop', prop: 'primaryLabel', binding: { $entry: 'title' } },
      { type: 'instance.setProp', owner: POSTS, nodeId: cta, prop: 'primaryLink', value: { type: 'page', target: 'pg_plans' } }
    );
    const ctaLinks = publicationPlan(bad).draftLinks.filter((l) => l.owner.kind === 'template' && l.nodeId === cta);
    expect(ctaLinks.length).toBeGreaterThan(0);
    expect(['Winter workshop', 'Spring open studio']).toContain(ctaLinks[0].label);
    // A section anchor only some entries show counts only on those.
    const author = bound(s, 'author');
    const anchored = run(s, { type: 'node.setContent', owner: POSTS, nodeId: author.id, field: 'anchor', value: 'byline' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['See [who wrote it](#byline).'] });
    expect(missingSectionLinks(anchored).filter((i) => i.owner.kind === 'entry' && i.fragment === 'byline').map((i) => i.owner.id)).toEqual(['en_spring']);
    expect(missingSectionLinks(run(anchored, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', author: 'Ana' })).filter((i) => i.fragment === 'byline')).toEqual([]);
  });
});

describe('after the last review', () => {
  it('judges a layout link by what each entry’s page shows, and an entry’s own text only where its page shows it', () => {
    const r = applyOperations(blog(), [
      { type: 'page.create', pageId: 'pg_plans', title: 'Plans' },
      { type: 'page.update', pageId: 'pg_plans', draft: true }
    ]);
    let s = r.state;
    const column = Object.values(template(s).nodes).find((n) => n.name === 'Reading column')!;
    const button = applyOperations(s, [{ type: 'node.insert', owner: POSTS, parentId: column.id, primitive: 'button', text: 'Our plans' }]);
    const id = button.results[0].nodeId as string;
    // Shown with a reading time, which every post with text has: the website shows it, so the export stops.
    s = run(button.state, { type: 'node.setContent', owner: POSTS, nodeId: id, field: 'link', value: { type: 'page', target: 'pg_plans' } }, { type: 'node.setBinding', owner: POSTS, nodeId: id, field: 'when', binding: { $entry: 'readingTime' } });
    expect(publicationPlan(s).draftLinks.filter((l) => l.owner.kind === 'template')).toHaveLength(1);
    // A post's own text linking to the draft stops it too, until the layout no longer shows the text.
    s = run(s, { type: 'node.remove', owner: POSTS, nodeId: id }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [the plans](/plans/).'] });
    expect(publicationPlan(s).draftLinks.map((l) => l.owner)).toEqual([{ kind: 'entry', id: 'en_winter' }]);
    s = run(s, { type: 'node.remove', owner: POSTS, nodeId: bound(s, 'body').id });
    expect(publicationPlan(s).draftLinks).toEqual([]);
  });

  it('reports a layout link to a missing section once, naming every entry it is missing on', () => {
    const s0 = blog();
    const s = run(s0, { type: 'node.setContent', owner: POSTS, nodeId: bound(s0, 'title').id, field: 'anchor', value: 'top-title' });
    const column = Object.values(template(s).nodes).find((n) => n.name === 'Reading column')!;
    const r = applyOperations(s, [{ type: 'node.insert', owner: POSTS, parentId: column.id, primitive: 'button', text: 'Notes' }]);
    const withLink = run(r.state, { type: 'node.setContent', owner: POSTS, nodeId: r.results[0].nodeId as string, field: 'link', value: { type: 'anchor', target: 'notes' } });
    const issues = missingSectionLinks(withLink).filter((i) => i.owner.kind === 'template');
    expect(issues).toHaveLength(1);
    expect([...(issues[0].entries ?? [])].sort()).toEqual(['en_spring', 'en_winter']);
  });

  it('never fails on a damaged choice a condition compares, or a layout link whose destination is not text', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', fields: { season: { type: 'enum', label: 'Season', default: 'winter', options: [{ value: 'winter', label: 'Winter' }] } } });
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: bound(s, 'excerpt').id, field: 'when', binding: { $entry: 'field.season' }, eq: 'winter' });
    const damaged = structuredClone(s);
    delete (damaged.collections.posts.settings.fields.season as { options?: unknown }).options;
    expect(() => validateState(damaged)).not.toThrow();
    expect(validateState(damaged).some((d) => d.code === 'COLLECTION_INVALID')).toBe(true);
    const odd = structuredClone(s);
    const link = Object.values(odd.collections.posts.settings.template.nodes).find((n) => n.kind === 'link')!;
    (link as { link: unknown }).link = { type: 'anchor', target: 42 };
    expect(() => generateProject(odd)).not.toThrow();
    // A layout without its list of top-level elements is reported, never a failure to open the project.
    const rootless = structuredClone(s);
    delete (rootless.collections.posts.settings.template as { rootIds?: unknown }).rootIds;
    expect(() => validateState(rootless)).not.toThrow();
    expect(validateState(rootless).some((d) => d.code === 'COLLECTION_INVALID')).toBe(true);
  });

  it('gives a draft listed first the published entry after it, and one listed last the one before it', () => {
    const s = run(blog(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_later', title: 'Later', publishedAt: '2026-12-01' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_early', title: 'Early', publishedAt: '2025-01-01' });
    expect(entryNeighbours(s, 'posts', 'en_later')).toEqual({ next: s.collections.posts.entries.en_spring });
    expect(entryNeighbours(s, 'posts', 'en_early')).toEqual({ prev: s.collections.posts.entries.en_winter });
  });
});

describe('a cached run', () => {
  it('makes every entry’s page and the stylesheet again for a layout edit, and a neighbour’s page for a new title', () => {
    // A second collection with published entries of its own, whose pages a posts change never reaches.
    let s = run(
      blog(),
      { type: 'collection.create', collectionId: 'projects' },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall01', title: 'Hall', publishedAt: '2026-01-01', draft: false },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_barn01', title: 'Barn', publishedAt: '2026-02-01', draft: false }
    );
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
    s = run(s, { type: 'node.setStyle', owner: POSTS, nodeId: bound(s, 'title').id, scope: 'base', property: 'color', value: '#aa0000' });
    const after = made();
    for (const id of ['en_winter', 'en_spring', 'en_secret']) expect(after).toEqual(expect.arrayContaining([`entry:posts:${id}#clean`, `entry:posts:${id}#dev`]));
    expect(after).toContain('site.css');
    expect(after.filter((k) => k.startsWith('page:') || k.startsWith('entry:projects:'))).toEqual([]);
    // Spring's title shows on Winter's page (its previous entry), so Winter's page is made again with it.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open day' });
    expect(made().filter((k) => k.startsWith('entry:'))).toEqual(['entry:posts:en_secret#clean', 'entry:posts:en_secret#dev', 'entry:posts:en_spring#clean', 'entry:posts:en_spring#dev', 'entry:posts:en_winter#clean', 'entry:posts:en_winter#dev']);
    // A new draft changes no published entry's neighbours: only its own page is made.
    s = run(s, { type: 'entry.create', collectionId: 'posts', entryId: 'en_later', title: 'Later', publishedAt: '2026-12-01' });
    expect(made().filter((k) => k.startsWith('entry:'))).toEqual(['entry:posts:en_later#clean', 'entry:posts:en_later#dev']);
    // The other collection's neighbours follow its own order.
    s = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall01', title: 'Great hall' });
    expect(made().filter((k) => k.startsWith('entry:'))).toEqual(['entry:projects:en_barn01#clean', 'entry:projects:en_barn01#dev', 'entry:projects:en_hall01#clean', 'entry:projects:en_hall01#dev']);
  });
});

describe('collections stored before layouts', () => {
  it('get the layout their entries had, the same every time, with node IDs of their own', () => {
    const s = blog();
    const old = structuredClone(s);
    for (const c of Object.values(old.collections)) delete (c.settings as { template?: unknown }).template;
    old.collections.posts.settings.schemaVersion = 11;
    const a = migrateProject(old)!;
    const b = migrateProject(old)!;
    expect(a.applied).toEqual(['collection-templates', 'entry-articles', 'repeat-filters', 'style-strength', 'color-schemes', 'managed-overlays', 'project-brief', 'divider-shapes']);
    const t = a.state.collections.posts.settings.template;
    expect(t).toEqual(b.state.collections.posts.settings.template);
    expect(a.state.collections.posts.settings.schemaVersion).toBe(SCHEMA_VERSION);
    expect(validateState(a.state).filter((d) => d.severity === 'error')).toEqual([]);
    const page = pageOf(generateProject(publishedState(a.state)), 'winter-workshop');
    expect(page).toContain('{"Winter workshop"}</h1>');
    expect(page).toContain('<time datetime={"2026-01-12"}>{"January 12, 2026"}</time>');
    expect(page).toContain('{"Ana Ruiz"}');
    // Two collections migrated together never share an element, so a style set in one never reaches the other.
    const two = structuredClone(old);
    two.collections.costarring = structuredClone(old.collections.posts);
    two.collections.costarring.settings.id = 'costarring';
    two.collections.costarring.settings.route = '/costarring/';
    two.collections.costarring.entries = {};
    two.collections.liquid = structuredClone(two.collections.costarring);
    two.collections.liquid.settings.id = 'liquid';
    two.collections.liquid.settings.route = '/liquid/';
    const migrated = migrateProject(two)!.state;
    const ids = (id: string) => Object.keys(migrated.collections[id].settings.template.nodes);
    const all = [...ids('costarring'), ...ids('liquid'), ...ids('posts')];
    expect(new Set(all).size).toBe(all.length);
    // A collection that already has a layout keeps it.
    const kept = structuredClone(s);
    kept.collections.posts.settings.schemaVersion = 11;
    expect(migrateProject(kept)!.state.collections.posts.settings.template).toEqual(s.collections.posts.settings.template);
  });
});

describe('the layout on the canvas', () => {
  it('is shown on one of the collection’s entries, which the author can switch, and closes when its collection goes', () => {
    let s = blog();
    const mode = { collectionId: 'posts', entryId: 'en_spring' };
    expect(sampleEntries(s, 'posts').map((e) => e.id)).toEqual(['en_spring', 'en_secret', 'en_winter']);
    expect(shownView(s, s.site.homePageId, mode)).toMatchObject({ route: '/blog/spring-open-studio/', title: 'Posts layout', key: 'template:posts:en_spring' });
    expect(shownView(s, s.site.homePageId, { collectionId: 'posts', entryId: 'en_winter' })?.key).not.toBe(shownView(s, s.site.homePageId, mode)?.key);
    // The frame reporting another entry keeps the layout, on that entry; a page closes it.
    expect(viewAt(s, mode, '/blog/winter-workshop')).toEqual({ templateMode: { collectionId: 'posts', entryId: 'en_winter' } });
    expect(viewAt(s, mode, '/blog/spring-open-studio/')).toBeNull();
    expect(viewAt(s, mode, '/')).toEqual({ pageId: s.site.homePageId });
    // A shown entry that is still there keeps the mode as it is.
    const winter = { collectionId: 'posts', entryId: 'en_winter' };
    expect(keepTemplateValid(s, winter)).toBe(winter);
    // An entry of another collection, reached in Preview, opens that collection's layout on it.
    const other = run(s, { type: 'collection.create', collectionId: 'projects' }, { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall01', title: 'Hall', draft: false });
    expect(viewAt(other, mode, '/projects/hall/')).toEqual({ templateMode: { collectionId: 'projects', entryId: 'en_hall01' } });
    expect(viewAt(other, null, '/blog/winter-workshop/')).toEqual({ templateMode: { collectionId: 'posts', entryId: 'en_winter' } });
    // An entry removed is replaced by the first; a collection removed closes the layout and lets go of its selection.
    s = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' });
    expect(keepTemplateValid(s, mode)).toEqual({ collectionId: 'posts', entryId: 'en_secret' });
    const selection = { owner: POSTS, instancePath: [], nodeId: bound(s, 'title').id };
    expect(keepViewValid(s, { pageId: s.site.homePageId, selection, definitionMode: null, templateMode: mode })).toEqual({ pageId: s.site.homePageId, definitionMode: null, templateMode: { collectionId: 'posts', entryId: 'en_secret' } });
    // The page behind it going (an Undo) moves that page to Home and keeps the layout, and what is selected in it, open.
    const valid = { collectionId: 'posts', entryId: 'en_secret' };
    expect(keepViewValid(s, { pageId: 'pg_gone', selection, definitionMode: null, templateMode: valid })).toEqual({ pageId: s.site.homePageId, definitionMode: null, templateMode: valid });
    s = run(s, { type: 'collection.remove', collectionId: 'posts' });
    expect(keepViewValid(s, { pageId: s.site.homePageId, selection, definitionMode: null, templateMode: mode })).toEqual({ pageId: s.site.homePageId, definitionMode: null, templateMode: null, selection: null });
  });
});
