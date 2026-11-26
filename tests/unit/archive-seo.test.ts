/**
 * A collection's index and its category archives (#883) say what they are when they are found or shared, as every
 * page and entry does: a description (the author's, or a default), Open Graph and X (Twitter) card tags, and the
 * site's structured data with a trail from Home.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject, publishedState } from '@generator/index';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const route = (f: string) => `src/routes/${f.replace(/^\/|\/$/g, '')}/+page.svelte`;
const post = (entryId: string, title: string, publishedAt: string, categories: string[]): EditOperation =>
  ({ type: 'entry.create', collectionId: 'posts', entryId, title, publishedAt, draft: false, body: [`${title}.`], terms: { categories } }) as EditOperation;

function blog(baseUrl = 'https://example.com'): ProjectState {
  const start = createStarterState('business', 'Riverside Studio', false);
  start.site.language = 'en-GB';
  return run(
    start,
    { type: 'site.update', baseUrl } as EditOperation,
    {
      type: 'collection.create',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' }, craft: { label: 'Craft' } } } }
    } as EditOperation,
    post('en_kiln', 'New kiln', '2026-04-01', ['news']),
    post('en_glaze', 'Glaze night', '2026-03-10', ['craft']),
    post('en_open', 'Open studio', '2026-02-20', ['news'])
  );
}

const files = (s: ProjectState) => generateProject(publishedState(s));
/** The structured data a generated file carries, parsed. */
const graph = (source: string) => {
  const scripts = [...source.matchAll(/\{@html ("(?:[^"\\]|\\.)*")\}/g)].map((m) => JSON.parse(m[1]) as string).filter((html) => html.startsWith('<script type="application/ld+json">'));
  if (!scripts.length) return null;
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].replace(/^<script type="application\/ld\+json">|<\/script>$/g, '')) as { '@graph': Array<Record<string, unknown>> };
};

describe('a collection’s archive pages when found or shared', () => {
  it('give the index and each category page a description, sharing tags and structured data', () => {
    const out = files(blog());
    for (const r of ['/blog/', '/blog/category/news/']) {
      const source = out.get(route(r))!;
      expect(source).toMatch(/<meta name="description" content=\{"[^"]+"\} \/>/);
      expect(source).toMatch(/<meta property="og:description" content=\{"[^"]+"\} \/>/);
      expect(source).toContain('<meta name="twitter:card" content="summary" />');
      expect(source).toMatch(/<meta name="twitter:title" content=\{"[^"]+"\} \/>/);
      expect(source).toMatch(/<meta name="twitter:description" content=\{"[^"]+"\} \/>/);
      expect(source).toContain(`<link rel="canonical" href={"https://example.com${r}"} />`);
      const g = graph(source);
      expect(g).not.toBeNull();
      const page = g!['@graph'].find((n) => n['@id'] === `https://example.com${r}#webpage`);
      expect(page).toBeDefined();
      expect(page!.description).toEqual(expect.any(String));
    }
  });

  it('use the description the author gave the collection and each category', () => {
    const s = run(
      blog(),
      { type: 'collection.update', collectionId: 'posts', description: 'Notes from the studio floor.' },
      { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'What is new at the studio.' } }
    );
    const out = files(s);
    expect(out.get(route('/blog/'))).toContain('<meta name="description" content={"Notes from the studio floor."} />');
    expect(out.get(route('/blog/category/news/'))).toContain('<meta name="description" content={"What is new at the studio."} />');
  });
});
