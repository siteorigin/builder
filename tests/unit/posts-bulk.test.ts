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
    expect([...pickRows(shown, new Set(['en_d']), null, 'en_b', 'range')]).toEqual(['en_b']);
    // A row no longer shown changes nothing.
    expect([...pickRows(shown, new Set(['en_a']), 'en_a', 'en_gone', 'range')]).toEqual(['en_a']);
  });
  it('adds a row with Cmd/Ctrl, or takes it out', () => {
    const was = new Set(['en_a']);
    expect([...pickRows(shown, was, 'en_a', 'en_c', 'toggle')]).toEqual(['en_a', 'en_c']);
    expect([...was]).toEqual(['en_a']);
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
    expect(pub.future).toEqual([{ id: 'en_c', title: 'Summer fair', date: '2027-06-01' }]);
    const after = run(s, ...pub.ops);
    expect([entry(after, 'en_b').draft, entry(after, 'en_c').draft]).toEqual([false, false]);
    const down = bulkStatusOps(after, 'posts', ['en_a', 'en_b', 'en_d', 'en_gone'], true);
    expect(down.ops.map((o) => (o as { entryId: string }).entryId)).toEqual(['en_a', 'en_b', 'en_d']);
    const back = run(after, ...down.ops);
    expect(['en_a', 'en_b', 'en_d'].map((id) => entry(back, id).draft)).toEqual([true, true, true]);
    // A draft dated today is not dated after it.
    expect(bulkStatusOps(s, 'posts', ['en_b'], false, '2026-11-14').future).toEqual([]);
    expect(down.future).toEqual([]);
  });
});

describe('filing several posts', () => {
  it('adds a term to those without it and keeps their other terms', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events'] } }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_b', terms: { categories: ['news'] } });
    const { ops } = bulkTermOps(s, 'posts', ['en_a', 'en_b', 'en_c'], [{ taxonomyId: 'categories', termId: 'news', on: true }]);
    expect(ops.map((o) => (o as { entryId: string }).entryId)).toEqual(['en_a', 'en_c']);
    const after = run(s, ...ops);
    expect(entry(after, 'en_a').terms?.categories).toEqual(['events', 'news']);
    expect(entry(after, 'en_c').terms?.categories).toEqual(['news']);
  });
  it('takes a term out of those filed under it, and never names a term the grouping no longer has', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events', 'news'] } });
    // As a hand-edited file can leave it: a term gone from the grouping still listed on the post.
    s.collections.posts.entries.en_a.terms = { categories: ['events', 'old', 'news'] };
    const { ops } = bulkTermOps(s, 'posts', ['en_a', 'en_b'], [{ taxonomyId: 'categories', termId: 'news', on: false }]);
    expect(ops).toEqual([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events'] } }]);
    expect(entry(run(s, ...ops), 'en_a').terms?.categories).toEqual(['events']);
  });
  it('makes every change to a post in one update, across its groupings', () => {
    const s = run(blog(), { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'Clay', termId: 'clay' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events'] } });
    const { ops } = bulkTermOps(s, 'posts', ['en_a', 'en_b'], [
      { taxonomyId: 'categories', termId: 'news', on: true },
      { taxonomyId: 'categories', termId: 'events', on: false },
      { taxonomyId: 'tags', termId: 'clay', on: true }
    ]);
    expect(ops).toEqual([
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['news'], tags: ['clay'] } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_b', terms: { categories: ['news'], tags: ['clay'] } }
    ]);
    const after = run(s, ...ops);
    expect(entry(after, 'en_a').terms).toMatchObject({ categories: ['news'], tags: ['clay'] });
  });
  it('names the posts a change would file under more terms of a grouping than an entry can hold, and leaves them', () => {
    let s = blog();
    const many = Array.from({ length: 52 }, (_, i) => `t${i}`);
    s = run(s, ...many.map((id) => ({ type: 'collection.createTerm' as const, collectionId: 'posts', taxonomyId: 'tags', label: `Tag ${id}`, termId: id })), { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'One more', termId: 'extra' });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { tags: many.slice(0, 50) } });
    expect(bulkTermOps(s, 'posts', ['en_a', 'en_b'], [{ taxonomyId: 'tags', termId: 'extra', on: true }])).toEqual({ ops: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_b', terms: { tags: ['extra'] } }], full: ['Spring open studio'] });
    // In place of one taken out, it fits.
    const swap = bulkTermOps(s, 'posts', ['en_a'], [{ taxonomyId: 'tags', termId: 'extra', on: true }, { taxonomyId: 'tags', termId: 't0', on: false }]);
    expect(swap.full).toEqual([]);
    expect(run(s, ...swap.ops).collections.posts.entries.en_a.terms?.tags).toEqual([...many.slice(1, 50), 'extra']);
    // One written by hand with more than it can hold is never sent on with more, even as one is taken out.
    s.collections.posts.entries.en_a.terms = { tags: many };
    expect(bulkTermOps(s, 'posts', ['en_a'], [{ taxonomyId: 'tags', termId: 't0', on: false }])).toEqual({ ops: [], full: ['Spring open studio'] });
  });
  it('emits a change that keeps the length, and keeps a term of another grouping with the same ID', () => {
    let s = run(blog(), { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'Events', termId: 'events' });
    s.collections.posts.entries.en_a.terms = { categories: ['gone'], tags: ['events'] };
    expect(bulkTermOps(s, 'posts', ['en_a'], [{ taxonomyId: 'categories', termId: 'news', on: true }]).ops).toEqual([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['news'] } }]);
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', terms: { categories: ['events'], tags: ['events'] } });
    const { ops } = bulkTermOps(s, 'posts', ['en_a'], [{ taxonomyId: 'categories', termId: 'events', on: false }]);
    const terms = run(s, ...ops).collections.posts.entries.en_a.terms;
    expect([terms?.categories ?? [], terms?.tags]).toEqual([[], ['events']]);
  });
  it('changes nothing for a term or grouping the collection does not have', () => {
    expect(bulkTermOps(blog(), 'posts', ['en_a'], [{ taxonomyId: 'categories', termId: 'nope', on: true }]).ops).toEqual([]);
    expect(bulkTermOps(blog(), 'posts', ['en_a'], [{ taxonomyId: 'nope', termId: 'news', on: true }]).ops).toEqual([]);
  });
});

describe('deleting several posts', () => {
  it('deletes those nothing points to in one change, and leaves the ones that ask what takes their place', () => {
    // Spring open studio links to Winter hours, so Winter hours asks where that link goes.
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_a', body: [{ type: 'p', spans: [{ text: 'See ' }, { text: 'winter hours', link: { type: 'entry', target: 'en_b' } }] }] });
    const plan = bulkDeletePlan(s, 'posts', ['en_a', 'en_b', 'en_c']);
    expect(plan.free.map((f) => f.id)).toEqual(['en_a', 'en_c']);
    expect(plan.held).toEqual([{ id: 'en_b', title: 'Winter hours' }]);
    const after = run(s, ...plan.ops);
    expect(Object.keys(after.collections.posts.entries).sort()).toEqual(['en_b', 'en_d']);
  });
  it('holds posts an old address goes to, and posts other picked posts name, so the change never fails part-way', () => {
    let s = run(
      blog(),
      { type: 'collection.create', collectionId: 'venues', kind: 'structured', name: 'Venues', singularName: 'Venue', fields: { next: { type: 'reference', label: 'Next', collection: 'venues' } } },
      { type: 'entry.create', collectionId: 'venues', entryId: 'en_hall', title: 'Hall', draft: false },
      { type: 'entry.create', collectionId: 'venues', entryId: 'en_garden', title: 'Garden', draft: false },
      { type: 'entry.create', collectionId: 'venues', entryId: 'en_annexe', title: 'Annexe', draft: false }
    );
    s = run(s, { type: 'entry.update', collectionId: 'venues', entryId: 'en_hall', values: { next: 'en_garden' } }, { type: 'entry.update', collectionId: 'venues', entryId: 'en_garden', values: { next: 'en_hall' } });
    const plan = bulkDeletePlan(s, 'venues', ['en_hall', 'en_garden', 'en_annexe']);
    // Hall and Garden name each other: the engine would refuse whichever went first.
    expect(plan.held.map((h) => h.id).sort()).toEqual(['en_garden', 'en_hall']);
    expect(plan.free.map((f) => f.id)).toEqual(['en_annexe']);
    expect(Object.keys(run(s, ...plan.ops).collections.venues.entries).sort()).toEqual(['en_garden', 'en_hall']);
    const kept = structuredClone(blog());
    kept.site.redirects = [{ from: '/old-winter/', entryId: 'en_b' }] as never;
    expect(bulkDeletePlan(kept, 'posts', ['en_a', 'en_b']).held).toEqual([{ id: 'en_b', title: 'Winter hours' }]);
  });
  it('holds a post linked from outside the pick, or sent visitors by an old address naming its address', () => {
    const s = run(
      blog(),
      { type: 'collection.create', collectionId: 'venues', kind: 'structured', name: 'Venues', singularName: 'Venue', fields: { more: { type: 'link', label: 'More' } } },
      { type: 'entry.create', collectionId: 'venues', entryId: 'en_hall', title: 'Hall', draft: false, values: { more: { type: 'entry', target: 'en_a' } } }
    );
    expect(bulkDeletePlan(s, 'posts', ['en_a', 'en_c']).held.map((h) => h.id)).toEqual(['en_a']);
    const route = s.collections.posts.settings.route;
    const kept = structuredClone(blog());
    kept.site.redirects = [{ from: '/old-spring/', to: `${route}${kept.collections.posts.entries.en_a.slug}/` }] as never;
    expect(bulkDeletePlan(kept, 'posts', ['en_a', 'en_c']).held.map((h) => h.id)).toEqual(['en_a']);
  });
  it('plans nothing for a synced collection, whose entries change in their source', () => {
    const s = structuredClone(blog());
    s.collections.posts.settings.sourceId = 'src_cms';
    expect(bulkDeletePlan(s, 'posts', ['en_a']).ops).toEqual([]);
    expect(bulkStatusOps(s, 'posts', ['en_b'], false).ops).toEqual([]);
  });
});
