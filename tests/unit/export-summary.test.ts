/**
 * The Export dialog's words on what the website publishes and leaves out (#568): pages as before, and collection
 * entries (blog posts) counted by their collection, so a published post is seen to go out and a draft post to stay.
 */
import { describe, expect, it } from 'vitest';
import type { PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { siteEntries, type SiteEntry } from '@shared/collections';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { publicationPlan } from '@generator/checks';
import { dialogFixes, draftEntriesSentence, entryCounts, exportedCounts, nothingToFix, pagesSummaryText, publishedEntriesSentence } from '../../src/renderer/src/lib/export-summary';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const entry = (collectionId: string, id: string, draft: boolean): EditOperation => ({ type: 'entry.create', collectionId, entryId: id, title: `Entry ${id}`, publishedAt: '2026-01-12', draft });
const site = (...ops: EditOperation[]) => run(createStarterState('business', 'Riverside Studio', false), ...ops);
/** Posts: two published and one draft. */
const blog = () => site({ type: 'collection.create', collectionId: 'posts' }, entry('posts', 'en_aaaa1', false), entry('posts', 'en_aaaa2', false), entry('posts', 'en_aaaa3', true));
const entriesOf = (s: ProjectState, drafts: boolean): SiteEntry[] => siteEntries(s).filter((e) => (e.entry.draft !== false) === drafts);
const page = (title: string, route = `/${title.toLowerCase()}/`) => ({ id: `pg_${title}${route}`, title, route }) as PageDoc;
const pages = (...titles: string[]) => titles.map((t) => page(t));
const NOTE = 'Drafts stay in the editable project; hiding a page from search engines doesn’t leave it out.';

describe('entries in the export summary', () => {
  it('says nothing about entries when the site has none', () => {
    const plan = publicationPlan(createStarterState('business', 'Riverside Studio', false));
    expect(publishedEntriesSentence(plan.publishedEntries)).toBe('');
    expect(draftEntriesSentence(plan.draftEntries, false)).toBe('');
    expect(draftEntriesSentence(plan.draftEntries, true)).toBe('');
    // A collection with no entries is no entries.
    expect(publishedEntriesSentence(publicationPlan(site({ type: 'collection.create', collectionId: 'posts' })).publishedEntries)).toBe('');
  });

  it('counts the published posts by their collection, and the drafts it leaves out', () => {
    const plan = publicationPlan(blog());
    expect(publishedEntriesSentence(plan.publishedEntries)).toBe('It also publishes 2 entries from Posts.');
    expect(draftEntriesSentence(plan.draftEntries, false)).toBe('1 draft entry from Posts is left out.');
    expect(draftEntriesSentence(plan.draftEntries, true)).toBe('1 draft entry from Posts is also left out.');
  });

  it('uses the singular for one entry, and “are” for several drafts', () => {
    const s = site({ type: 'collection.create', collectionId: 'posts' }, entry('posts', 'en_aaaa1', false), entry('posts', 'en_aaaa2', true), entry('posts', 'en_aaaa3', true));
    const plan = publicationPlan(s);
    expect(publishedEntriesSentence(plan.publishedEntries)).toBe('It also publishes 1 entry from Posts.');
    expect(draftEntriesSentence(plan.draftEntries, false)).toBe('2 draft entries from Posts are left out.');
  });

  it('names each collection, and the address of two that share a name', () => {
    const s = site(
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'collection.create', collectionId: 'studies', name: 'Case studies', route: '/work/' },
      entry('posts', 'en_aaaa1', false),
      entry('studies', 'en_bbbb1', false),
      entry('studies', 'en_bbbb2', false)
    );
    expect(entryCounts(entriesOf(s, false), 'entry')).toBe('1 entry from Posts and 2 entries from Case studies');
    const alike = run(s, { type: 'collection.update', collectionId: 'studies', name: 'posts' });
    expect(entryCounts(entriesOf(alike, false), 'entry')).toBe('1 entry from Posts (/blog/) and 2 entries from posts (/work/)');
  });

  it('names up to three collections, and totals the entries of more of them', () => {
    const ids = ['one', 'two', 'three', 'four'];
    const collections = (n: number): EditOperation[] => ids.slice(0, n).flatMap((id): EditOperation[] => [{ type: 'collection.create', collectionId: id, name: id, route: `/${id}/` }, entry(id, `en_${id}1`, false), entry(id, `en_${id}2`, false)]);
    // Two entries in each collection: the total of collections is not the total of entries (an uneven one follows).
    expect(entryCounts(entriesOf(site(...collections(3)), false), 'entry')).toBe('2 entries from one, 2 entries from three and 2 entries from two');
    expect(publishedEntriesSentence(entriesOf(site(...collections(4)), false))).toBe('It also publishes 8 entries from 4 collections.');
    expect(publishedEntriesSentence(entriesOf(site(...collections(4), entry('one', 'en_one3', false)), false))).toBe('It also publishes 9 entries from 4 collections.');
    const drafts = run(site(...collections(4)), ...ids.flatMap((id): EditOperation[] => [1, 2].map((n): EditOperation => ({ type: 'entry.update', collectionId: id, entryId: `en_${id}${n}`, draft: true }))));
    expect(draftEntriesSentence(entriesOf(drafts, true), false)).toBe('8 draft entries from 4 collections are left out.');
  });

  it('totals a few collections whose names run long, and still names one whatever its length', () => {
    const long = (c: string) => `${c} ${'x'.repeat(66)}`;
    const s = site(
      { type: 'collection.create', collectionId: 'one', name: long('One'), route: '/one/' },
      { type: 'collection.create', collectionId: 'two', name: long('Two'), route: '/two/' },
      entry('one', 'en_dddd1', false),
      entry('two', 'en_dddd2', false),
      entry('two', 'en_dddd3', false)
    );
    expect(entryCounts(entriesOf(s, false), 'entry')).toBe('3 entries from 2 collections');
    // One collection is named, never totalled as "1 collections", even with a stored name past the limit.
    const stored = structuredClone(blog());
    stored.collections.posts.settings.name = 'y'.repeat(150);
    expect(entryCounts(entriesOf(stored, false), 'entry')).toBe(`2 entries from ${'y'.repeat(150)}`);
  });
});

describe('the words of the summary', () => {
  const none = { publishedEntries: [] as SiteEntry[], draftEntries: [] as SiteEntry[] };

  it('keeps a site without entries reading as its pages alone', () => {
    expect(pagesSummaryText({ published: pages('Home', 'Projects', 'Services', 'About', 'Contact'), drafts: [], ...none })).toEqual({
      long: false,
      published: { lead: 'The website publishes 5 pages:', rest: ' Home, Projects, Services, About and Contact.' },
      drafts: null
    });
    expect(pagesSummaryText({ published: pages('Home'), drafts: pages('Winter'), ...none })).toEqual({
      long: false,
      published: { lead: 'The website publishes 1 page:', rest: ' Home.' },
      drafts: { lead: '1 draft is left out:', rest: ` Winter. ${NOTE}` }
    });
    expect(pagesSummaryText({ published: pages('Home', 'About'), drafts: pages('Winter', 'Spring'), ...none }).drafts).toEqual({ lead: '2 drafts are left out:', rest: ` Winter and Spring. ${NOTE}` });
    // Pages that share a title are told apart by their address, as before.
    expect(pagesSummaryText({ published: [page('Shop', '/shop/'), page('Home')], drafts: [page('Shop', '/shop-two/')], ...none }).published.rest).toBe(' Shop (/shop/) and Home.');
  });

  it('counts many pages, and says the same of the entries', () => {
    const many = pages('Home', 'About', 'Contact', 'Services', 'Projects', 'Team', 'News');
    expect(pagesSummaryText({ published: many, drafts: [], ...none })).toEqual({ long: true, published: { lead: 'The website publishes 7 pages.', rest: '' }, drafts: null });
    const s = blog();
    expect(pagesSummaryText({ published: many, drafts: [], publishedEntries: entriesOf(s, false), draftEntries: entriesOf(s, true) })).toEqual({
      long: true,
      published: { lead: 'The website publishes 7 pages.', rest: ' It also publishes 2 entries from Posts.' },
      drafts: { lead: '1 draft entry from Posts is left out.', rest: ' Drafts stay in the editable project.' }
    });
  });

  it('adds the published entries to the pages that are named', () => {
    const s = blog();
    const text = pagesSummaryText({ published: pages('Home', 'About'), drafts: [], publishedEntries: entriesOf(s, false), draftEntries: [] });
    expect(text.long).toBe(false);
    expect(text.published).toEqual({ lead: 'The website publishes 2 pages:', rest: ' Home and About. It also publishes 2 entries from Posts.' });
    expect(text.drafts).toBeNull();
  });

  it('puts draft pages and draft entries in one line, with the note about search engines', () => {
    const s = blog();
    const mixed = pagesSummaryText({ published: pages('Home'), drafts: pages('Winter'), publishedEntries: entriesOf(s, false), draftEntries: entriesOf(s, true) });
    expect(mixed.published).toEqual({ lead: 'The website publishes 1 page:', rest: ' Home. It also publishes 2 entries from Posts.' });
    expect(mixed.drafts).toEqual({
      lead: '1 draft is left out:',
      rest: ` Winter. 1 draft entry from Posts is also left out. ${NOTE}`
    });
    // Only entries are left out: the note about hiding a page from search engines has nothing to say.
    expect(pagesSummaryText({ published: pages('Home'), drafts: [], publishedEntries: [], draftEntries: entriesOf(s, true) }).drafts).toEqual({ lead: '1 draft entry from Posts is left out.', rest: ' Drafts stay in the editable project.' });
  });
});

describe('the export result in the dialog’s words (#884)', () => {
  it('counts what the website published as the dialog does', () => {
    const plan = publicationPlan(blog());
    expect(exportedCounts(3, plan.publishedEntries)).toBe('3 pages and 2 entries from Posts');
    expect(exportedCounts(1, [])).toBe('1 page');
    expect(exportedCounts(2, plan.publishedEntries.slice(0, 1))).toBe('2 pages and 1 entry from Posts');
  });

  it('lists what the dialog still had to fix, in its headings’ words', () => {
    expect(dialogFixes({ samples: 0, seo: 0 })).toEqual([]);
    expect(dialogFixes({ samples: 3, seo: 2 })).toEqual(['3 sample contact details from the starter are still on the website.', '2 things keep the website from being found or shared well.']);
    expect(dialogFixes({ samples: 1, seo: 1 })).toEqual(['A sample contact detail from the starter is still on the website.', 'One thing keeps the website from being found or shared well.']);
  });

  it('says nothing is left to fix only when neither the export nor the dialog found anything', () => {
    expect(nothingToFix({ ok: true, warnings: [], fixesListed: [] })).toBe(true);
    expect(nothingToFix({ ok: true, warnings: [] })).toBe(true);
    expect(nothingToFix({ ok: true, warnings: [], fixesListed: dialogFixes({ samples: 3, seo: 2 }) })).toBe(false);
    expect(nothingToFix({ ok: true, warnings: ['One image has not been chosen yet and shows a placeholder.'] })).toBe(false);
    expect(nothingToFix({ ok: false, warnings: [] })).toBe(false);
    expect(dialogFixes({ samples: 2, seo: 0 })).toEqual(['2 sample contact details from the starter are still on the website.']);
    expect(nothingToFix({ ok: true, warnings: [], fixesListed: dialogFixes({ samples: 1, seo: 0 }) })).toBe(false);
  });
});
