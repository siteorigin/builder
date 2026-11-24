/**
 * The Export dialog's words on collection entries (#568): a published post is counted among what the website
 * publishes, and a draft post among what it leaves out, by the collection it is in.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { siteEntries, type SiteEntry } from '@shared/collections';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { publicationPlan } from '@generator/checks';
import { draftEntriesSentence, entryCounts, publishedEntriesSentence } from '../../src/renderer/src/lib/export-summary';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const entry = (collectionId: string, id: string, draft: boolean): EditOperation => ({ type: 'entry.create', collectionId, entryId: id, title: `Entry ${id}`, publishedAt: '2026-01-12', draft });
const site = (...ops: EditOperation[]) => run(createStarterState('business', 'Riverside Studio', false), ...ops);
/** Posts: two published and one draft. */
const blog = () => site({ type: 'collection.create', collectionId: 'posts' }, entry('posts', 'en_aaaa1', false), entry('posts', 'en_aaaa2', false), entry('posts', 'en_aaaa3', true));
const entriesOf = (s: ProjectState, drafts: boolean): SiteEntry[] => siteEntries(s).filter((e) => (e.entry.draft !== false) === drafts);

describe('the export summary on collection entries', () => {
  it('says nothing about entries when the site has none, so its summary stays pages only', () => {
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

  it('totals the entries of many collections instead of naming them all', () => {
    const ids = ['one', 'two', 'three', 'four'];
    const s = site(...ids.flatMap((id, i): EditOperation[] => [{ type: 'collection.create', collectionId: id, name: id, route: `/${id}/` }, entry(id, `en_cccc${i}`, i % 2 === 0)]));
    // Two collections are named; the drafts of the other two likewise.
    expect(entryCounts(entriesOf(s, false), 'entry')).toBe('1 entry from four and 1 entry from two');
    expect(entryCounts(entriesOf(s, true), 'draft entry')).toBe('1 draft entry from one and 1 draft entry from three');
    // Four collections are counted as a whole.
    const all = run(s, ...ids.map((id, i): EditOperation => ({ type: 'entry.update', collectionId: id, entryId: `en_cccc${i}`, draft: false })));
    expect(publishedEntriesSentence(entriesOf(all, false))).toBe('It also publishes 4 entries from 4 collections.');
    const drafts = run(s, ...ids.map((id, i): EditOperation => ({ type: 'entry.update', collectionId: id, entryId: `en_cccc${i}`, draft: true })));
    expect(draftEntriesSentence(entriesOf(drafts, true), false)).toBe('4 draft entries from 4 collections are left out.');
  });

  it('totals a few collections whose names run long, and keeps naming one whatever its length', () => {
    const long = (c: string) => `${c} ${'x'.repeat(66)}`;
    const s = site(
      { type: 'collection.create', collectionId: 'one', name: long('One'), route: '/one/' },
      { type: 'collection.create', collectionId: 'two', name: long('Two'), route: '/two/' },
      entry('one', 'en_dddd1', false),
      entry('two', 'en_dddd2', false)
    );
    expect(entryCounts(entriesOf(s, false), 'entry')).toBe('2 entries from 2 collections');
    expect(entryCounts(entriesOf(s, false).slice(0, 1), 'entry')).toBe(`1 entry from ${long('One')}`);
  });
});
