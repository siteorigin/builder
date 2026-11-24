/**
 * Collection entries as pages of the website (#393): every published entry is prerendered at its collection's prefix
 * plus its slug, drafts stay out of the website and its sitemap, links between entries follow renames, and a change
 * to one post makes that post's page again and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { entryFile, generateProject, generateSitemap, publishedState, resolveLink } from '@generator/index';
import { GenerationCache } from '@generator/cache';

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
    expect(winter).toContain('<time datetime="2026-01-12">{"January 12, 2026"}</time>');
    expect(winter).toContain('{"Ana Ruiz"}');
    expect(winter).toContain('<meta property="og:type" content="article" />');
    expect(winter).toContain('<meta property="article:published_time" content={"2026-01-12"} />');
    expect(winter).toContain('<link rel="canonical" href={"https://example.com/blog/winter-workshop/"} />');
    expect(winter).toContain('<meta name="description" content={"Three evenings of glazing."} />');
    expect(winter).toContain('<h1 class="so-entry__title">{"Winter workshop"}</h1>');
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
    expect(check()).toEqual(['entry:posts:en_winter']);
    // A new date changes the post's page and the sitemap that dates it, nothing else.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', updatedAt: '2026-03-20' });
    expect(check().sort()).toEqual(['entry:posts:en_spring', 'sitemap.xml']);
  });
});
