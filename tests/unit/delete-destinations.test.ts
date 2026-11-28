/**
 * Where a deleted entry's links and old addresses may go (#1495): pages and published entries with addresses of their
 * own, so a record other pages only list is never offered, nor accepted once its collection's pages are turned off.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { deleteDestinations, isDeleteDestination } from '../../src/renderer/src/lib/content';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const target = { collectionId: 'posts', entryId: 'en_winter' };

const site = () =>
  run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter workshop', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans' },
    { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: false, archive: false } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false }
  );

const entries = (s: ProjectState) => deleteDestinations(s, target).groups.map((g) => [g.name, g.entries.map((e) => e.value)]);

describe('destinations for a deleted entry', () => {
  it('offers published entries with pages, and leaves out a collection with none', () => {
    const s = site();
    expect(entries(s)).toEqual([[s.collections.posts.settings.name, ['entry:en_spring']]]);
    expect(deleteDestinations(s, target).pages.map((p) => p.value)).toContain(`page:${s.site.homePageId}`);
    expect(isDeleteDestination(s, target, 'entry:en_spring')).toBe(true);
    expect(isDeleteDestination(s, target, 'entry:en_ruiz')).toBe(false);
    expect(isDeleteDestination(s, target, `page:${s.site.homePageId}`)).toBe(true);
    // The deleted entry gone meanwhile, nothing is left to choose for it.
    const without = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' });
    expect(isDeleteDestination(without, target, 'entry:en_spring')).toBe(false);
  });

  it('offers published pages, and leaves out drafts', () => {
    const s = run(site(), { type: 'page.create', pageId: 'pg_open', title: 'Open', route: '/open/' }, { type: 'page.create', pageId: 'pg_later', title: 'Later', route: '/later/' }, { type: 'page.update', pageId: 'pg_later', draft: true });
    const offered = deleteDestinations(s, target).pages.map((p) => p.value);
    expect(offered).toContain('page:pg_open');
    expect(offered).not.toContain('page:pg_later');
  });

  it('turns away a chosen entry whose pages have since been turned off', () => {
    const s = run(site(), { type: 'collection.create', collectionId: 'projects', name: 'Projects', kind: 'structured', pages: { detail: true, archive: false }, route: '/projects/' }, { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Town hall', draft: false });
    expect(isDeleteDestination(s, target, 'entry:en_hall')).toBe(true);
    expect(isDeleteDestination(run(s, { type: 'collection.update', collectionId: 'projects', pages: { detail: false, archive: false } }), target, 'entry:en_hall')).toBe(false);
  });

  it('offers a sibling with no page only while reference fields need one of the collection', () => {
    const off = run(site(), { type: 'collection.update', collectionId: 'posts', pages: { detail: false, archive: false } });
    expect(entries(off)).toEqual([]);
    const referenced = run(off, { type: 'collection.update', collectionId: 'posts', fields: { next: { type: 'reference', label: 'Next', collection: 'posts' } } }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', values: { next: 'en_winter' } });
    expect(entries(referenced)).toEqual([[referenced.collections.posts.settings.name, ['entry:en_spring']]]);
  });
});
