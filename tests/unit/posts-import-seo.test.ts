/** A WordPress import brings each post's search settings from its SEO plugin's meta (#1514). */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateOperation } from '@shared/ops';
import { findEntry } from '@shared/collections';
import { entryMetadata } from '@generator/seo-metadata';
import { readWordPress } from '../../src/main/posts-import/wxr';
import { planOperations, planPostImport, selectPlan } from '../../src/main/posts-import/plan';
import { postImportPreview } from '../../src/main/posts-import/preview';
import type { ParsedSource } from '../../src/main/posts-import/source';

const scratch = mkdtempSync(join(tmpdir(), 'posts-import-seo-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function wxr(items: string[]): string {
  const dir = mkdtempSync(join(scratch, 'wxr-'));
  writeFileSync(
    join(dir, 'export.xml'),
    `<?xml version="1.0"?><rss xmlns:wp="w" xmlns:content="c" xmlns:dc="d" xmlns:excerpt="e"><channel><title>Old &amp; Grazing</title><link>https://old.example</link><wp:wxr_version>1.2</wp:wxr_version>${items.map((i) => `<item>${i}</item>`).join('')}</channel></rss>`
  );
  return join(dir, 'export.xml');
}
const meta = (key: string, value: string) => `<wp:postmeta><wp:meta_key>${key}</wp:meta_key><wp:meta_value><![CDATA[${value}]]></wp:meta_value></wp:postmeta>`;
const post = (id: number, title: string, ...metas: string[]) =>
  `<title>${title}</title><link>https://old.example/2019/03/post-${id}/</link><wp:post_id>${id}</wp:post_id><wp:post_name>post-${id}</wp:post_name><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_date>2019-03-01 10:00:00</wp:post_date><excerpt:encoded><![CDATA[A short excerpt for ${title}.]]></excerpt:encoded><content:encoded><![CDATA[<p>Text of ${title}.</p>]]></content:encoded>${metas.join('')}`;

const read = (...items: string[]) => readWordPress(wxr(items), {});
const site = (): ProjectState => createStarterState('business', 'Riverside Bakery', false);

function commit(state: ProjectState, source: ParsedSource, existing: 'skip' | 'update' = 'skip') {
  const plan = selectPlan(planPostImport(state, source, '2026-11-24'), existing);
  expect(plan.problems).toEqual([]);
  const ops = planOperations(plan, new Map());
  for (const op of ops) expect(validateOperation(op)).toMatchObject({ ok: true });
  const { state: after } = applyOperations(state, ops);
  return { plan, after, entry: (i: number) => findEntry(after, plan.posts[i].entryId)!.entry };
}

describe('search settings from a WordPress SEO plugin (#1514)', () => {
  it('gives each post its Yoast or Rank Math search title, description, canonical address and noindex, and its page shows them', async () => {
    const source = await read(
      post(1, 'Counting the grazing paradox', meta('_yoast_wpseo_title', 'Grazing, counted'), meta('_yoast_wpseo_metadesc', 'SEO description for &quot;Counting&quot;'), meta('_yoast_wpseo_canonical', 'https://journal.example/grazing/'), meta('_yoast_wpseo_meta-robots-noindex', '1')),
      post(2, 'Fences', meta('rank_math_title', 'Fences that last'), meta('rank_math_description', 'How to build fences.'), meta('rank_math_canonical_url', 'https://journal.example/fences/'), meta('rank_math_robots', 'a:2:{i:0;s:7:"noindex";i:1;s:8:"nofollow";}')),
      post(3, 'Hedges', meta('_seopress_titles_title', 'Hedges, trimmed'), meta('_seopress_titles_desc', 'All about hedges.'), meta('_seopress_robots_index', 'yes')),
      post(4, 'Plain')
    );
    expect(source.posts.map((p) => p.seo)).toEqual([
      { title: 'Grazing, counted', description: 'SEO description for "Counting"', canonical: 'https://journal.example/grazing/', noindex: true },
      { title: 'Fences that last', description: 'How to build fences.', canonical: 'https://journal.example/fences/', noindex: true },
      { title: 'Hedges, trimmed', description: 'All about hedges.', noindex: true },
      undefined
    ]);
    expect(source.posts.map((p) => p.notes)).toEqual([[], [], [], []]);
    const { plan, after, entry } = commit(site(), source);
    expect(entry(0).seo).toEqual({ title: 'Grazing, counted', description: 'SEO description for "Counting"', canonical: 'https://journal.example/grazing/', noindex: true });
    expect(entry(3).seo).toBeUndefined();
    const page = entryMetadata(after, plan.collection.id, plan.posts[0].entryId)!;
    expect([page.title, page.description, page.canonical, page.noindex]).toEqual(['Grazing, counted', 'SEO description for "Counting"', 'https://journal.example/grazing/', true]);
    // The post without settings keeps falling back to its excerpt.
    expect(entryMetadata(after, plan.collection.id, plan.posts[3].entryId)!.description).toBe('A short excerpt for Plain.');
    expect(postImportPreview('r', planPostImport(site(), source, '2026-11-24')).searchSettings).toBe(3);
  });

  it('reads Yoast first, then Rank Math, then SEOPress, field by field', async () => {
    const source = await read(
      post(1, 'Both', meta('_yoast_wpseo_metadesc', 'Yoast says.'), meta('rank_math_title', 'Rank Math title'), meta('rank_math_description', 'Rank Math says.')),
      post(2, 'All', meta('_seopress_titles_title', 'SEOPress title'), meta('rank_math_title', 'Rank Math title'), meta('_yoast_wpseo_title', 'Yoast title'), meta('_seopress_titles_desc', 'SEOPress says.'))
    );
    expect(source.posts.map((p) => p.seo)).toEqual([
      { title: 'Rank Math title', description: 'Yoast says.' },
      { title: 'Yoast title', description: 'SEOPress says.' }
    ]);
  });

  it('reads each value as the plain text the plugins save, never as HTML', async () => {
    const source = await read(post(1, 'Code', meta('_yoast_wpseo_title', 'JavaScript <constructor> guide'), meta('_yoast_wpseo_metadesc', 'Use ?a=1&copy=2 when a<b &amp; more')));
    expect(source.posts[0].seo).toEqual({ title: 'JavaScript <constructor> guide', description: 'Use ?a=1&copy=2 when a<b & more' });
  });

  it('fills in the plugins’ placeholders, and leaves out their stock title and any placeholder it can’t fill', async () => {
    const source = await read(
      post(1, 'Oats', meta('_yoast_wpseo_title', '%%title%% %%page%% %%sep%% %%sitename%%'), meta('_yoast_wpseo_metadesc', 'All about %%title%% at %%sitename%%')),
      post(2, 'Barley', meta('rank_math_title', '%title% %sep% %sitename%')),
      post(3, 'Rye', meta('rank_math_title', 'Growing %title% %sep% %sitename%'), meta('rank_math_description', '%excerpt%')),
      post(4, 'Spelt', meta('rank_math_title', '%title%'), meta('_yoast_wpseo_metadesc', '%%excerpt%%'), meta('rank_math_description', 'Rank Math’s own words.')),
      // Yoast's stock title with a placeholder the import can't fill is not stock: Rank Math's title stands.
      post(5, 'Emmer', meta('_yoast_wpseo_title', '%%title%% %%sep%% %%sitename%% %%sitedesc%%'), meta('rank_math_title', 'Ancient %title% %page%'), meta('_yoast_wpseo_metadesc', '%%title%% %%sep%% %%sitename%%')),
      // Percent signs that are no plugin's placeholder are words; Rank Math's own with arguments is a placeholder.
      post(6, 'Path', meta('_yoast_wpseo_title', 'Add a folder to %PATH% for 100% of users'), meta('rank_math_description', 'Updated %date(F j, Y)%'))
    );
    expect(source.posts.map((p) => p.seo)).toEqual([
      { description: 'All about Oats at Old & Grazing' },
      undefined,
      { title: 'Growing Rye - Old & Grazing' },
      { title: 'Spelt', description: 'Rank Math’s own words.' },
      { title: 'Ancient Emmer', description: 'Emmer - Old & Grazing' },
      { title: 'Add a folder to %PATH% for 100% of users' }
    ]);
    expect(source.posts.map((p) => p.notes)).toEqual([
      [],
      [],
      ['Its search description was left out: it uses the SEO plugin’s “excerpt” placeholder, which the import can’t fill in.'],
      [],
      [],
      ['Its search description was left out: it uses the SEO plugin’s “date” placeholder, which the import can’t fill in.']
    ]);
  });

  it('leaves a canonical address naming the post’s own old address to the new page, and says which ones stay on the old site or can’t be used', async () => {
    const source = await read(
      post(1, 'Self', meta('_yoast_wpseo_canonical', 'https://old.example/2019/03/post-1')),
      post(2, 'Elsewhere on the old site', meta('_yoast_wpseo_canonical', 'https://old.example/2018/original/')),
      post(3, 'Broken', meta('_yoast_wpseo_canonical', '/relative/'), meta('rank_math_canonical_url', 'not a url')),
      post(4, 'Fallback', meta('_yoast_wpseo_canonical', '/relative/'), meta('rank_math_canonical_url', 'https://journal.example/fallback/')),
      post(5, 'Padded', meta('_yoast_wpseo_canonical', `${' '.repeat(3990)}https://journal.example/padded/`))
    );
    expect(source.posts.map((p) => p.seo)).toEqual([undefined, { canonical: 'https://old.example/2018/original/' }, undefined, { canonical: 'https://journal.example/fallback/' }, { canonical: 'https://journal.example/padded/' }]);
    expect(source.posts[3].notes).toEqual([]);
    expect(source.posts[1].notes).toEqual(['Its canonical address (https://old.example/2018/original/) is on the old site: change it in Search & sharing if the new site replaces that address.']);
    expect(source.posts[2].notes).toEqual(['Its canonical address (/relative/) was left out: the canonical URL must be a full address starting with https:// (or http://).']);
  });

  it('takes a canonical address escaping its letters differently for the post’s own', async () => {
    const own = `<title>Café</title><link>https://old.example/caf%c3%a9/</link><wp:post_id>1</wp:post_id><wp:post_name>cafe</wp:post_name><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_date>2019-03-01 10:00:00</wp:post_date>${meta('_yoast_wpseo_canonical', 'https://old.example/caf%C3%A9')}`;
    expect((await read(own)).posts[0].seo).toBeUndefined();
  });

  it('lists a post as the site’s others are when its plugins disagree, or when one says to list it', async () => {
    const source = await read(
      post(1, 'Disagree', meta('_yoast_wpseo_meta-robots-noindex', '1'), meta('rank_math_robots', 'a:1:{i:0;s:5:"index";}')),
      post(4, 'Yoast lists it', meta('_yoast_wpseo_meta-robots-noindex', '2'), meta('rank_math_robots', 'a:1:{i:0;s:7:"noindex";}')),
      post(2, 'Index', meta('_yoast_wpseo_meta-robots-noindex', '2')),
      post(3, 'Default', meta('_yoast_wpseo_meta-robots-noindex', '0'))
    );
    expect(source.posts.map((p) => p.seo)).toEqual([undefined, undefined, undefined, undefined]);
    expect(source.posts[1].notes).toEqual(source.posts[0].notes);
    expect(source.posts[0].notes).toEqual(['Its SEO plugins disagree on whether search engines may list it, so it is listed as the site’s other posts are: check Search & sharing.']);
  });

  it('shortens a search title and description over the project’s limits, and says so', async () => {
    const long = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    const source = await read(post(1, 'Long', meta('_yoast_wpseo_title', long(40)), meta('_yoast_wpseo_metadesc', long(100))));
    const { plan, entry } = commit(site(), source);
    expect(entry(0).seo!.title!.length).toBeLessThanOrEqual(120);
    expect(entry(0).seo!.description!.length).toBeLessThanOrEqual(320);
    expect(entry(0).seo!.title!.endsWith('…')).toBe(true);
    expect(plan.posts[0].notes).toEqual(['Its search title was shortened to 120 characters.', 'Its search description was shortened to 320 characters.']);
  });

  it('never cuts a character in two when shortening one without spaces', async () => {
    const source = await read(post(1, 'Emoji', meta('_yoast_wpseo_title', '😀'.repeat(100))));
    const { entry } = commit(site(), source);
    const t = entry(0).seo!.title!;
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t).toBe(`${'😀'.repeat(59)}…`);
  });

  it('leaves the search settings of a post already here as they are when updating it, and counts only new posts', async () => {
    const first = await read(post(1, 'Oats'));
    const { after } = commit(site(), first);
    const id = Object.values(after.collections.posts.entries)[0].id;
    const edited = applyOperations(after, [{ type: 'entry.update', collectionId: 'posts', entryId: id, seoTitle: 'Hand-written' }]).state;
    const again = await read(post(1, 'Oats', meta('_yoast_wpseo_title', 'From Yoast')), post(2, 'Barley', meta('_yoast_wpseo_metadesc', 'New.')));
    const preview = postImportPreview('r', planPostImport(edited, again, '2026-11-24'));
    expect(preview.searchSettings).toBe(1);
    const long = await read(post(1, 'Oats', meta('_yoast_wpseo_title', 'word '.repeat(40)), meta('_yoast_wpseo_meta-robots-noindex', '1')));
    expect(selectPlan(planPostImport(edited, long, '2026-11-24'), 'update').posts[0].notes).toEqual([]);
    const renamed = await read(post(1, 'Oats, again', meta('_yoast_wpseo_title', 'From Yoast'), meta('_yoast_wpseo_meta-robots-noindex', '1')));
    const { after: updated } = commit(edited, renamed, 'update');
    // The update did happen, and left the search settings alone.
    expect(findEntry(updated, id)!.entry.title).toBe('Oats, again');
    expect(findEntry(updated, id)!.entry.seo).toEqual({ title: 'Hand-written' });
  });
});
