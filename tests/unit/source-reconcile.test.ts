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
import { sourceIntegrityChange, syncedDependencyLoss } from '@engine/sources';
import { recordHash } from '../../src/main/sources/hash';
import type { NormalizedRecord } from '../../src/main/sources/protocol';

const AT = '2026-11-20T10:00:00.000Z';
const LATER = '2026-11-21T10:00:00.000Z';

/** A project with a data-only team collection, a page linking nowhere yet, and a source for the team. */
function project(removal?: SourceDoc['removal']): ProjectState {
  let s = createStarterState('business', 'Sources', false);
  s = applyOperations(s, [
    { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: false }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' }, photo: { type: 'image', label: 'Photo', default: { assetId: null, alt: '' } } } },
    { type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', config: { credentials: { token: { $secret: 'people-token' } } }, ...(removal ? { removal } : {}) }
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
    // The saved link still names the same entry.
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

  it('gives a new record an ID no entry of the project has, and records of two sources IDs of their own', () => {
    const first = syncedEntryId('people', '1', () => false);
    expect(first).toMatch(/^en_[a-f0-9]{16}$/);
    expect(syncedEntryId('other', '1', () => false)).not.toBe(first);
    // Taken by an entry of another collection: the plan picks another, and later syncs keep that one.
    const s = applyOperations(project(), [
      { type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' },
      { type: 'entry.create', collectionId: 'news', entryId: first, title: 'Squatter' }
    ] as EditOperation[]).state;
    const { plan, next } = sync(s, [rec('1')]);
    const id = plan.creates[0].entryId;
    expect(id).not.toBe(first);
    const again = sync(next, [rec('1', { title: 'Renamed' })], LATER);
    expect(again.plan.updates.map((u) => u.entryId)).toEqual([id]);
    expect(again.next.collections.team.entries[id].title).toBe('Renamed');
  });

  it('refuses two entries that say they are one record, and an attachment left inconsistent', () => {
    const synced = sync(project(), [rec('1')]).next;
    const id = syncedEntryId('people', '1', () => false);
    const twice = structuredClone(synced);
    twice.collections.team.entries.en_copy1 = { ...structuredClone(twice.collections.team.entries[id]), id: 'en_copy1', slug: 'copy' };
    expect(() => planSourceSync(twice, twice.sources!.people, [rec('1')], LATER)).toThrow(/same record/);
    // The source moved to another collection by hand while the first stays attached: no second collection is claimed.
    const moved = applyOperations(synced, [{ type: 'collection.create', collectionId: 'directory', name: 'Directory', kind: 'structured', pages: { detail: false, archive: false } }] as EditOperation[]).state;
    moved.sources!.people = { ...moved.sources!.people, collectionId: 'directory' };
    expect(() => planSourceSync(moved, moved.sources!.people, [rec('1')], LATER)).toThrow(/Team collection is synced from “People API” too/);
    const rival = structuredClone(project());
    rival.sources!.more = { ...rival.sources!.people, id: 'more', name: 'More people' };
    expect(() => planSourceSync(rival, rival.sources!.people, [rec('1')], AT)).toThrow(/“More people” syncs into the Team collection too/);
  });

  it('frees a removed entry’s address for a new record in the same sync, and never takes an old address the author keeps', () => {
    const s = sync(project('remove'), [rec('1'), rec('2', { slug: 'ben' })]).next;
    const { next } = sync(s, [rec('1'), rec('3', { slug: 'ben' })], LATER);
    expect(Object.values(next.collections.team.entries).map((e) => [e.source?.externalId, e.slug]).sort()).toEqual([
      ['1', 'person-1'],
      ['3', 'ben']
    ]);
    // An old address the author pointed at an entry: the sync is refused rather than take it away.
    const two = syncedEntryId('people', '2', () => false);
    const kept = applyOperations(s, [{ type: 'redirect.add', from: '/old-ben/', entryId: two }]).state;
    expect(() => sync(kept, [rec('1')], LATER)).toThrow(/The old address \/old-ben\/ goes to “Person 2”/);
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

describe('what History may not undo around a sync', () => {
  it('tells one broken source from another, and an existing problem from a new one', () => {
    const s = project();
    const missingA = structuredClone(s);
    missingA.sources!.people = { ...missingA.sources!.people, collectionId: 'gone-a' };
    const missingB = structuredClone(s);
    missingB.sources!.people = { ...missingB.sources!.people, collectionId: 'gone-b' };
    expect(sourceIntegrityChange(missingA, missingB)).toMatch(/syncs into a collection that no longer exists/);
    expect(sourceIntegrityChange(missingA, missingA)).toBeNull();
    expect(sourceIntegrityChange(s, s)).toBeNull();
  });

  it('reads what a synced entry needs from where its schema puts it, never from a plain value', () => {
    const base = applyOperations(project(), [
      { type: 'collection.update', collectionId: 'team', fields: { role: { type: 'string', label: 'Role', default: '' }, assetId: { type: 'string', label: 'Code', default: '' }, photo: { type: 'image', label: 'Photo', default: { assetId: null, alt: '' } } } }
    ] as EditOperation[]).state;
    const asset = 'img_photo1';
    base.assets.assets[asset] = { id: asset, name: 'Photo', file: 'static/assets/photo-1a2b3c4d.png', mime: 'image/png', bytes: 10, width: 8, height: 8, hash: 'x', kind: 'image', createdAt: AT };
    const synced = sync(base, [rec('1', { values: { role: 'Maker', assetId: asset } })]).next;
    const without = structuredClone(synced);
    delete without.assets.assets[asset];
    // A text field that happens to hold an image's ID needs no image.
    expect(syncedDependencyLoss(synced, without)).toBeNull();
    // A picture in the entry's text does.
    const inText = structuredClone(synced);
    const id = syncedEntryId('people', '1', () => false);
    inText.collections.team.entries[id].body = [{ type: 'image', assetId: asset, alt: '' }];
    const gone = structuredClone(inText);
    delete gone.assets.assets[asset];
    expect(syncedDependencyLoss(inText, gone)).toMatch(/from the library, which “Person 1” in the Team collection uses/);
  });
});
