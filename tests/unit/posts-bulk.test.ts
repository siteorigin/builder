/**
 * Several posts picked in the Content list and changed together (#1507): Shift picks a range and Cmd/Ctrl one more, as
 * in a file manager, and the picked posts are published, moved to drafts, filed under a category or tag or taken out of
 * it, or deleted, each as one change the engine applies whole.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { bulkDeletePlan, bulkStatusOps, bulkTermOps, pickRows } from '../../src/renderer/src/lib/posts';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

function blog(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_a', title: 'Spring open studio', publishedAt: '2026-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_b', title: 'Winter hours', publishedAt: '2026-11-14' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_c', title: 'Summer fair', publishedAt: '2027-06-01' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_d', title: 'Autumn kiln', publishedAt: '2026-09-01', draft: false },
    { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News', termId: 'news' },
    { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Events', termId: 'events' }
  );
}
const entry = (s: ProjectState, id: string) => s.collections.posts.entries[id];

describe('picking rows', () => {
  const shown = ['en_a', 'en_b', 'en_c', 'en_d'];
  it('picks the range from the anchor to the row clicked, in the order shown, either way', () => {
    expect([...pickRows(shown, new Set(['en_a']), 'en_a', 'en_c', 'range')]).toEqual(['en_a', 'en_b', 'en_c']);
    expect([...pickRows(shown, new Set(), 'en_d', 'en_b', 'range')]).toEqual(['en_b', 'en_c', 'en_d']);
    // In place of what was picked, as a file manager does.
    expect([...pickRows(shown, new Set(['en_a', 'en_d']), 'en_c', 'en_b', 'range')]).toEqual(['en_b', 'en_c']);
  });
  it('starts the range at the row clicked when the anchor is not shown', () => {
    expect([...pickRows(shown, new Set(), 'en_gone', 'en_b', 'range')]).toEqual(['en_b']);
    expect([...pickRows(shown, new Set(), null, 'en_b', 'range')]).toEqual(['en_b']);
  });
  it('adds a row with Cmd/Ctrl, or takes it out', () => {
    expect([...pickRows(shown, new Set(['en_a']), 'en_a', 'en_c', 'toggle')]).toEqual(['en_a', 'en_c']);
    expect([...pickRows(shown, new Set(['en_a', 'en_c']), 'en_a', 'en_a', 'toggle')]).toEqual(['en_c']);
  });
});

describe('publishing or unpublishing several posts', () => {
  it('changes only those not already so, as one change, and names the drafts dated after today', () => {
    const s = blog();
    const pub = bulkStatusOps(s, 'posts', ['en_a', 'en_b', 'en_c'], false, '2026-11-28');
    expect(pub.ops).toEqual([
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_b', draft: false },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_c', draft: false }
    ]);
    expect(pub.future).toEqual(['Summer fair']);
    const after = run(s, ...pub.ops);
    expect([entry(after, 'en_b').draft, entry(after, 'en_c').draft]).toEqual([false, false]);
    const down = bulkStatusOps(after, 'posts', ['en_a', 'en_b', 'en_d', 'en_gone'], true);
    expect(down.ops.map((o) => (o as { entryId: string }).entryId)).toEqual(['en_a', 'en_b', 'en_d']);
    expect(down.future).toEqual([]);
  });
});

describe('filing several posts', () => {
  it('adds a term to those without it and keeps their other terms', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events'] } }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_b', terms: { categories: ['news'] } });
    const ops = bulkTermOps(s, 'posts', ['en_a', 'en_b', 'en_c'], 'categories', 'news', true);
    expect(ops.map((o) => (o as { entryId: string }).entryId)).toEqual(['en_a', 'en_c']);
    const after = run(s, ...ops);
    expect(entry(after, 'en_a').terms?.categories).toEqual(['events', 'news']);
    expect(entry(after, 'en_c').terms?.categories).toEqual(['news']);
  });
  it('takes a term out of those filed under it, and never names a term the grouping no longer has', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events', 'news'] } });
    // As a hand-edited file can leave it: a term gone from the grouping still listed on the post.
    s.collections.posts.entries.en_a.terms = { categories: ['events', 'old', 'news'] };
    const ops = bulkTermOps(s, 'posts', ['en_a', 'en_b'], 'categories', 'news', false);
    expect(ops).toEqual([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events'] } }]);
    expect(entry(run(s, ...ops), 'en_a').terms?.categories).toEqual(['events']);
  });
  it('changes nothing for a term or grouping the collection does not have', () => {
    expect(bulkTermOps(blog(), 'posts', ['en_a'], 'categories', 'nope', true)).toEqual([]);
    expect(bulkTermOps(blog(), 'posts', ['en_a'], 'nope', 'news', true)).toEqual([]);
  });
});

describe('deleting several posts', () => {
  it('deletes those nothing points to in one change, and leaves the ones that ask what takes their place', () => {
    // Spring open studio links to Winter hours, so Winter hours asks where that link goes.
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', body: [{ type: 'p', spans: [{ text: 'See ' }, { text: 'winter hours', link: { type: 'entry', target: 'en_b' } }] }] });
    const plan = bulkDeletePlan(s, 'posts', ['en_a', 'en_b', 'en_c']);
    expect(plan.free.map((f) => f.id)).toEqual(['en_a', 'en_c']);
    expect(plan.held).toEqual(['Winter hours']);
    const after = run(s, ...plan.ops);
    expect(Object.keys(after.collections.posts.entries).sort()).toEqual(['en_b', 'en_d']);
  });
});
