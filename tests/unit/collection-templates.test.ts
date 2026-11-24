/**
 * Collection layouts (#394): each collection's entries are shown with one layout, a tree of sections and elements
 * edited like a page's, whose elements and placed sections read the entry they are shown for through
 * `{ $entry: field }`. Editing the layout once changes every entry's page; each entry keeps its own words and details.
 */
import { describe, expect, it } from 'vitest';
import type { GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, TextNode } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject, generateSiteCss, pageNodeClass, publishedState } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { entryNeighbours, materializeTemplate } from '@generator/entry-template';
import { entryFieldSchemas, entryFieldValue, readingMinutes } from '@shared/entry-fields';
import { migrateProject } from '@shared/migrations';
import { keepTemplateValid, sampleEntries, shownView, viewAt } from '../../src/renderer/src/lib/template-view';
import { keepViewValid, parseCtx, treeFor } from '../../src/renderer/src/lib/model';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const POSTS: OwnerRef = { kind: 'template', id: 'posts' };

/** The ready-made blog: two published posts (the later one first in the order) and a draft between them by date. */
function blog() {
  return run(
    createStarterState('business', 'Riverside Studio', false),
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
    expect(pageOf(files, 'spring-open-studio')).toContain('{"Winter workshop"}');
    expect(pageOf(files, 'winter-workshop')).toContain('"href":"/blog/spring-open-studio/"');
    expect(pageOf(files, 'winter-workshop')).not.toContain('secret');
    // An editorial order decides it instead.
    s = run(s, { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_winter', 'en_secret', 'en_spring'] });
    files = generateProject(publishedState(s));
    expect(entryNeighbours(s, 'posts', 'en_winter')).toEqual({ next: s.collections.posts.entries.en_spring });
    expect(pageOf(files, 'winter-workshop')).toContain('{"Spring open studio"}');
  });

  it('shows an element only for the entries its condition holds for, and a collapsing one only with something in it', () => {
    let s = blog();
    s.assets.assets.img_hall = { id: 'img_hall', name: 'Hall', file: 'static/assets/hall-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1600, height: 900, hash: 'h', kind: 'image', description: 'The great hall', createdAt: '2026-01-01T00:00:00.000Z' };
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
    // A comparison reads the stored value: only entries with that price show it.
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: bound(s, 'excerpt').id, field: 'unless', binding: { $entry: 'field.price' }, eq: 'Free' });
    const after = s.collections.posts;
    expect(shown(materializeTemplate(s, after, after.entries.en_winter, {}), bound(s, 'excerpt').id)).toBe(false);
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
    // A custom field the layout shows can't silently go: the layout reports it until it is unbound.
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: bound(s, 'excerpt').id, field: 'text', binding: { $entry: 'field.price' } });
    s = run(s, { type: 'collection.update', collectionId: 'posts', fields: { seats: { type: 'number', label: 'Seats' } } });
    expect(validateState(s).filter((d) => d.code === 'BINDING_INVALID').map((d) => d.message)).toEqual([expect.stringMatching(/Posts layout: .*shows "field.price", which entries of Posts do not have/)]);
    // The generated page shows nothing there rather than failing.
    expect(pageOf(generateProject(publishedState(s)), 'winter-workshop')).toContain('Winter workshop');
  });

  it('is an operation the schema takes, with the template owner and an entry binding', () => {
    expect(validateOperation({ type: 'node.setBinding', owner: POSTS, nodeId: 'n_x', field: 'text', binding: { $entry: 'title' } }).ok).toBe(true);
    expect(validateOperation({ type: 'node.setBinding', owner: POSTS, nodeId: 'n_x', field: 'text', binding: { $entry: 'title', $prop: 'x' } }).ok).toBe(false);
  });
});

describe('a cached run', () => {
  it('makes every entry’s page and the stylesheet again for a layout edit, and a neighbour’s page for a new title', () => {
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
    s = run(s, { type: 'node.setStyle', owner: POSTS, nodeId: bound(s, 'title').id, scope: 'base', property: 'color', value: '#aa0000' });
    const after = made();
    for (const id of ['en_winter', 'en_spring', 'en_secret']) expect(after).toEqual(expect.arrayContaining([`entry:posts:${id}#clean`, `entry:posts:${id}#dev`]));
    expect(after).toContain('site.css');
    expect(after.filter((k) => k.startsWith('page:'))).toEqual([]);
    // Spring's title shows on Winter's page (its previous entry), so Winter's page is made again with it.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open day' });
    expect(made().filter((k) => k.startsWith('entry:'))).toEqual(['entry:posts:en_secret#clean', 'entry:posts:en_secret#dev', 'entry:posts:en_spring#clean', 'entry:posts:en_spring#dev', 'entry:posts:en_winter#clean', 'entry:posts:en_winter#dev']);
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
    expect(a.applied).toEqual(['collection-templates']);
    const t = a.state.collections.posts.settings.template;
    expect(t).toEqual(b.state.collections.posts.settings.template);
    expect(a.state.collections.posts.settings.schemaVersion).toBe(SCHEMA_VERSION);
    expect(validateState(a.state).filter((d) => d.severity === 'error')).toEqual([]);
    const page = pageOf(generateProject(publishedState(a.state)), 'winter-workshop');
    expect(page).toContain('{"Winter workshop"}</h1>');
    expect(page).toContain('<time datetime={"2026-01-12"}>{"January 12, 2026"}</time>');
    expect(page).toContain('{"Ana Ruiz"}');
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
    // An entry removed is replaced by the first; a collection removed closes the layout and lets go of its selection.
    s = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' });
    expect(keepTemplateValid(s, mode)).toEqual({ collectionId: 'posts', entryId: 'en_secret' });
    const selection = { owner: POSTS, instancePath: [], nodeId: bound(s, 'title').id };
    expect(keepViewValid(s, { pageId: s.site.homePageId, selection, definitionMode: null, templateMode: mode })).toEqual({ pageId: s.site.homePageId, definitionMode: null, templateMode: { collectionId: 'posts', entryId: 'en_secret' } });
    s = run(s, { type: 'collection.remove', collectionId: 'posts' });
    expect(keepViewValid(s, { pageId: s.site.homePageId, selection, definitionMode: null, templateMode: mode })).toEqual({ pageId: s.site.homePageId, definitionMode: null, templateMode: null, selection: null });
  });
});
