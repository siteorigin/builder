/**
 * Reconciling an external source's records with its collection (#676): each record is matched to its entry by its
 * external ID, so the entry keeps its ID (and every link to it) across syncs; an unchanged record leaves its entry as
 * it is; an entry whose record has gone is drafted, deleted or kept, as the source says. Only a sync's own grant
 * writes a synced collection, and only that one.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState, SourceDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { knownHashes, planIsEmpty, planSourceSync, SyncPlanError, syncedEntryId, syncOperations } from '../../src/main/sources/reconcile';
import { recordHash } from '../../src/main/sources/hash';
import type { NormalizedRecord } from '../../src/main/sources/protocol';

const AT = '2026-11-20T10:00:00.000Z';
const LATER = '2026-11-21T10:00:00.000Z';

/** A project with a data-only team collection, a page linking nowhere yet, and a source for the team. */
function project(removal?: SourceDoc['removal']): ProjectState {
  let s = createStarterState('business', 'Sources', false);
  s = applyOperations(s, [
    { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: false }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' }, photo: { type: 'image', label: 'Photo', default: { assetId: null, alt: '' } } } },
    { type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', credentials: { token: { $secret: 'people-token' } }, ...(removal ? { removal } : {}) }
  ] as EditOperation[]).state;
  return s;
}

const rec = (id: string, extra: Partial<NormalizedRecord> = {}): NormalizedRecord => ({ externalId: id, title: `Person ${id}`, publishedAt: '2026-01-01', values: { role: 'Maker' }, ...extra });

/** The project with a local news entry whose text links to entry `id`. */
function linkTo(s: ProjectState, id: string): ProjectState {
  return applyOperations(s, [
    { type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' },
    { type: 'entry.create', collectionId: 'news', entryId: 'en_news1', title: 'Welcome', body: [`Meet [our maker](entry:${id}).`] }
  ] as EditOperation[]).state;
}

/** One sync of `records` into the project, as the session would land it. */
function sync(s: ProjectState, records: NormalizedRecord[], at = AT, assets = new Map<string, string>()) {
  const source = s.sources!.people;
  const plan = planSourceSync(s, source, records, at);
  const ops = syncOperations(plan, s, assets);
  const next = applyOperations(s, ops, { sourceSync: { sourceId: source.id, collectionId: plan.collectionId, provenance: plan.provenance } }).state;
  return { plan, next };
}

describe('planning a sync', () => {
  it('creates an entry for each new record, attaching the collection, with an ID the same record always gets', () => {
    const s = project();
    const { plan, next } = sync(s, [rec('2'), rec('1')]);
    expect(plan.attach).toBe(true);
    expect(plan.creates.map((c) => c.record.externalId)).toEqual(['1', '2']);
    const team = next.collections.team;
    expect(team.settings.sourceId).toBe('people');
    const one = team.entries[syncedEntryId('people', '1', () => false)];
    expect(one).toMatchObject({ title: 'Person 1', draft: false, values: { role: 'Maker' }, source: { sourceId: 'people', externalId: '1', syncedAt: AT, contentHash: recordHash(rec('1')) } });
    expect(validateState(next).filter((d) => d.severity === 'error')).toEqual([]);
    // The same records, planned again from the same project, plan the same.
    expect(planSourceSync(s, s.sources!.people, [rec('1'), rec('2')], AT)).toEqual(plan);
  });

  it('updates a changed record in place, leaves an unchanged one as it is, and clears what a record no longer says', () => {
    const first = sync(project(), [rec('1', { author: 'Ana', excerpt: 'Hello' }), rec('2')]).next;
    const ids = Object.keys(first.collections.team.entries).sort();
    const { plan, next } = sync(first, [rec('1', { title: 'Person One' }), rec('2')], LATER);
    expect(plan).toMatchObject({ attach: false, creates: [], unchanged: 1, unpublish: [], remove: [] });
    expect(plan.updates.map((u) => u.record.externalId)).toEqual(['1']);
    expect(Object.keys(next.collections.team.entries).sort()).toEqual(ids);
    const id1 = syncedEntryId('people', '1', () => false);
    const id2 = syncedEntryId('people', '2', () => false);
    expect(next.collections.team.entries[id1]).toMatchObject({ title: 'Person One', slug: first.collections.team.entries[id1].slug, source: { syncedAt: LATER, contentHash: recordHash(rec('1', { title: 'Person One' })) } });
    expect(next.collections.team.entries[id1].author).toBeUndefined();
    expect(next.collections.team.entries[id1].excerpt).toBeUndefined();
    // Not written at all: the very same entry, provenance and all.
    expect(next.collections.team.entries[id2]).toEqual(first.collections.team.entries[id2]);
    expect(knownHashes(next, next.sources!.people)).toEqual({ '1': recordHash(rec('1', { title: 'Person One' })), '2': recordHash(rec('2')) });
    // Nothing changed since: nothing to do.
    expect(planIsEmpty(planSourceSync(next, next.sources!.people, [rec('1', { title: 'Person One' }), rec('2')], LATER))).toBe(true);
  });

  it('drafts an entry whose record has gone, keeping its ID and every link to it, and publishes it again when it is back', () => {
    const first = sync(project(), [rec('1'), rec('2')]).next;
    const gone = syncedEntryId('people', '2', () => false);
    const withLink = linkTo(first, gone);
    const { plan, next } = sync(withLink, [rec('1')], LATER);
    expect(plan.unpublish).toEqual([gone]);
    expect(next.collections.team.entries[gone]).toMatchObject({ draft: true, source: first.collections.team.entries[gone].source });
    // The link still goes to it.
    expect(JSON.stringify(next.collections.news.entries.en_news1.body)).toContain(gone);
    // Gone still, it is left alone: drafted once.
    const again = planSourceSync(next, next.sources!.people, [rec('1')], LATER);
    expect(planIsEmpty(again)).toBe(true);
    // Back as it was: published again, under the same ID.
    const back = sync(next, [rec('1'), rec('2')], LATER);
    expect(back.plan.republish.map((r) => r.entryId)).toEqual([gone]);
    expect(back.next.collections.team.entries[gone]).toMatchObject({ draft: false, title: 'Person 2' });
  });

  it('deletes or keeps an entry whose record has gone when the source says so, and never deletes one something links to', () => {
    const removing = sync(project('remove'), [rec('1'), rec('2')]).next;
    const two = syncedEntryId('people', '2', () => false);
    const { plan, next } = sync(removing, [rec('1')], LATER);
    expect(plan.remove).toEqual([two]);
    expect(next.collections.team.entries[two]).toBeUndefined();
    // An entry linking to it: the whole sync is refused, nothing pointed elsewhere.
    const linked = linkTo(sync(project('remove'), [rec('1'), rec('2')]).next, two);
    expect(() => sync(linked, [rec('1')], LATER)).toThrow(/link/);
    const keeping = sync(project('keep'), [rec('1'), rec('2')]).next;
    const kept = sync(keeping, [rec('1')], LATER);
    expect(kept.plan.kept).toBe(1);
    expect(kept.next.collections.team.entries[two]).toEqual(keeping.collections.team.entries[two]);
  });

  it('attaches only an empty collection, never one with entries of its own or synced from elsewhere', () => {
    const s = project();
    const local = applyOperations(s, [{ type: 'entry.create', collectionId: 'team', entryId: 'en_local1', title: 'Local person' }]).state;
    expect(() => planSourceSync(local, local.sources!.people, [rec('1')], AT)).toThrow(SyncPlanError);
    expect(() => planSourceSync(local, local.sources!.people, [rec('1')], AT)).toThrow(/has entries of its own/);
    const other = structuredClone(s);
    other.collections.team.settings.sourceId = 'elsewhere';
    expect(() => planSourceSync(other, other.sources!.people, [rec('1')], AT)).toThrow(/synced from another source/);
    expect(() => planSourceSync(s, s.sources!.people, [rec('1'), rec('1')], AT)).toThrow(/two records with the same ID/);
  });

  it('gives a new record an ID no entry of the project has', () => {
    const taken = syncedEntryId('people', '1', () => false);
    expect(syncedEntryId('people', '1', (id) => id === taken)).not.toBe(taken);
    expect(syncedEntryId('people', '1', () => false)).toMatch(/^en_[a-f0-9]{16}$/);
  });
});

describe('the sync grant', () => {
  it('writes its own collection only, and leaves every manual edit of a synced collection refused', () => {
    const synced = sync(project(), [rec('1')]).next;
    const id = syncedEntryId('people', '1', () => false);
    expect(() => applyOperations(synced, [{ type: 'entry.update', collectionId: 'team', entryId: id, title: 'Edited' }])).toThrow(/synced from an external source/);
    // Another synced collection stays read-only, grant or not.
    const two = applyOperations(synced, [{ type: 'collection.create', collectionId: 'more', name: 'More', kind: 'structured', pages: { detail: false, archive: false } }]).state;
    two.collections.more.settings.sourceId = 'other';
    two.collections.more.entries.en_other1 = { ...structuredClone(synced.collections.team.entries[id]), id: 'en_other1', slug: 'other-1', source: { sourceId: 'other', externalId: '9', syncedAt: AT, contentHash: 'x' } };
    const grant = { sourceId: 'people', collectionId: 'team', provenance: {} };
    expect(() => applyOperations(two, [{ type: 'entry.update', collectionId: 'more', entryId: 'en_other1', title: 'Edited' }], { sourceSync: grant })).toThrow(/synced from an external source/);
    // The grant of a source that no longer syncs into the collection writes nothing.
    const moved = structuredClone(synced);
    moved.sources!.people = { ...moved.sources!.people, collectionId: 'more' };
    expect(() => applyOperations(moved, [{ type: 'entry.update', collectionId: 'team', entryId: id, title: 'Edited' }], { sourceSync: grant })).toThrow(/changed while it was being synced/);
  });
});
