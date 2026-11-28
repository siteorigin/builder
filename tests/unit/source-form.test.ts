/**
 * The Connect external source dialog's settings (#678): what the author types becomes the source's whole
 * `source.upsert`, and a saved source reads back into the same form; a sync's result is said in a sentence; and
 * Detach is one step that drops the collection's source and the source's settings together.
 */
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { droppedLinksText, sourceDocProblem } from '@shared/sources';
import type { EditOperation } from '@shared/ops';
import { CONVERTER_TEMPLATE, detachOps, draftSecretNames, freeSourceId, sourceDraft, sourceForm, sourceOfCollection, syncSummary } from '../../src/renderer/src/lib/sources';
import { converterProblems } from '../../src/main/sources/converter';

function project() {
  return applyOperations(createStarterState('blank', 'Forms', false), [
    { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role', default: '' } } } as EditOperation
  ]).state;
}

describe('the Connect dialog’s settings', () => {
  it('make a REST source with its headers, pages and mapping, and read back into the same form', () => {
    const state = project();
    const form = sourceForm(state, state.collections.team.settings, undefined);
    expect(form).toMatchObject({ sourceId: 'team', name: 'Team source', adapter: 'rest', shape: 'mapping', removal: 'unpublish', converter: CONVERTER_TEMPLATE });
    const draft = sourceDraft(
      {
        ...form,
        url: ' https://api.example/team ',
        headers: [
          { name: 'Authorization', value: 'Bearer ${secret:team-token}' },
          { name: '', value: 'ignored' }
        ],
        itemsPath: 'data.items',
        paging: 'page',
        pageParam: 'page',
        pageSizeParam: 'per_page',
        pageSize: '50',
        mapping: { title: 'fields.fullName', featuredImageUrl: ' fields.avatar.url ', 'values.role': 'fields.jobTitle', slug: '' },
        removal: 'keep'
      },
      'team'
    );
    expect(draft).toEqual({
      sourceId: 'team',
      name: 'Team source',
      adapter: 'rest',
      collectionId: 'team',
      config: { url: 'https://api.example/team', headers: { Authorization: 'Bearer ${secret:team-token}' }, itemsPath: 'data.items', pagination: { type: 'page', param: 'page', size: 50, sizeParam: 'per_page' } },
      mapping: { title: 'fields.fullName', featuredImageUrl: 'fields.avatar.url', values: { role: 'fields.jobTitle' } },
      removal: 'keep'
    });
    if (typeof draft === 'string') return;
    expect(draftSecretNames(draft)).toEqual(['team-token']);
    const saved = applyOperations(state, [{ ...draft, type: 'source.upsert' } as EditOperation]).state;
    expect(sourceDocProblem(saved.sources!.team, 'team')).toBeNull();
    const again = sourceForm(saved, saved.collections.team.settings, sourceOfCollection(saved, 'team'));
    expect(sourceDraft(again, 'team')).toEqual(draft);
  });

  it('keep a first page numbered 0, and every setting they do not show, when a source is changed', () => {
    const state = project();
    const form = sourceForm(state, state.collections.team.settings, undefined);
    const zero = sourceDraft({ ...form, url: 'https://api.example/team', paging: 'page', pageParam: 'p', pageSize: '20', pageStart: '0' }, 'team');
    expect(zero).toMatchObject({ config: { pagination: { type: 'page', param: 'p', size: 20, start: 0 } } });
    if (typeof zero === 'string') return;
    const saved = applyOperations(state, [{ ...zero, type: 'source.upsert' } as EditOperation]).state;
    const renamed = sourceDraft({ ...sourceForm(saved, saved.collections.team.settings, saved.sources!.team), name: 'Renamed' }, 'team');
    expect(renamed).toEqual({ ...zero, name: 'Renamed' });
    expect(sourceDraft({ ...form, url: 'https://a.example', paging: 'page', pageParam: 'p', pageSize: '20', pageStart: 'one' }, 'team')).toMatch(/whole number/);
  });

  it('make each kind’s own settings, a converter instead of a mapping, and say what is missing', () => {
    const state = project();
    const form = sourceForm(state, state.collections.team.settings, undefined);
    expect(sourceDraft({ ...form, adapter: 'sanity', projectId: 'abc', dataset: 'production', groq: '*[_type=="p"]', token: 'sn' }, 'team')).toMatchObject({ config: { projectId: 'abc', dataset: 'production', groq: '*[_type=="p"]', credentials: { token: { $secret: 'sn' } } } });
    expect(sourceDraft({ ...form, adapter: 'strapi', url: 'https://cms.example', resource: 'articles' }, 'team')).toMatchObject({ config: { url: 'https://cms.example', resource: 'articles' } });
    const wp = sourceDraft({ ...form, adapter: 'wordpress', url: 'https://blog.example', token: 'ignored' }, 'team');
    expect(wp).toMatchObject({ config: { url: 'https://blog.example' } });
    expect(wp).not.toHaveProperty('config.credentials');
    expect(sourceDraft({ ...form, adapter: 'contentful', spaceId: 'sp1', contentType: 'person', token: 'cda' }, 'team')).toMatchObject({ config: { spaceId: 'sp1', contentType: 'person', credentials: { token: { $secret: 'cda' } } } });
    expect(sourceDraft({ ...form, adapter: 'graphql', url: 'https://api.example/gql', graphql: '{ people { id } }', variables: '{ "first": 5 }' }, 'team')).toMatchObject({ config: { graphql: '{ people { id } }', variables: { first: 5 } } });
    expect(sourceDraft({ ...form, adapter: 'graphql', url: 'https://api.example/gql', graphql: '{ a }', variables: '[1]' }, 'team')).toBe('The variables are a JSON object: { "first": 50 }.');
    expect(sourceDraft({ ...form, paging: 'cursor', pageParam: 'after' }, 'team')).toMatch(/where each reply gives the next one/);
    expect(sourceDraft({ ...form, name: ' ' }, 'team')).toBe('Give the source a name.');
    const converted = sourceDraft({ ...form, url: 'https://api.example/team', shape: 'converter', mapping: { title: 'x' } }, 'team');
    expect(converted).toMatchObject({ converter: CONVERTER_TEMPLATE });
    expect(converted).not.toHaveProperty('mapping');
    // The converter it starts from is one that may run.
    expect(converterProblems(CONVERTER_TEMPLATE)).toEqual([]);
  });

  it('give a new source an ID no other source has', () => {
    const state = project();
    expect(freeSourceId(state, 'team')).toBe('team');
    state.sources = { team: { schemaVersion: 1, id: 'team', name: 'Old', adapter: 'rest', collectionId: 'other', config: { url: 'https://a.example' } } };
    expect(freeSourceId(state, 'team')).toBe('team-2');
    state.sources['team-2'] = { ...state.sources.team, id: 'team-2' };
    expect(freeSourceId(state, 'team')).toBe('team-3');
  });
});

describe('a sync, and detaching', () => {
  it('says what a sync changed', () => {
    const base = { ok: true as const, revision: 2, created: 0, updated: 0, unchanged: 0, unpublished: 0, removed: 0, kept: 0, images: 0 };
    expect(syncSummary('Team CMS', { ...base, created: 3, images: 1, unchanged: 2 })).toBe('Synced “Team CMS”: 3 added, 1 picture added to the library; 2 unchanged.');
    expect(syncSummary('Team CMS', { ...base, updated: 1, unpublished: 2 })).toBe('Synced “Team CMS”: 1 changed, 2 made drafts.');
    expect(syncSummary('Team CMS', { ...base, unchanged: 1 })).toBe('“Team CMS” is up to date: 1 entry unchanged.');
    expect(syncSummary('Team CMS', { ...base, removed: 2, kept: 1, images: 2 })).toBe('Synced “Team CMS”: 2 deleted, 1 kept that the source no longer has, 2 pictures added to the library.');
    // Then the links that kept only their words, whether or not the sync changed anything (#1426).
    expect(syncSummary('Old blog', { ...base, unchanged: 4, droppedLinks: { count: 1, records: 1, titles: ['Tickets'] } })).toBe(
      '“Old blog” is up to date: 4 entries unchanged. A link keeps only its words: its address is not one an entry can keep (in “Tickets”). Give it a web address at the source.'
    );
    expect(syncSummary('Old blog', { ...base, created: 2, droppedLinks: { count: 3, records: 2, titles: ['Tickets', 'Hours'] } })).toBe(
      'Synced “Old blog”: 2 added. 3 links keep only their words: their addresses are not ones an entry can keep (in “Tickets” and “Hours”). Give them a web address at the source.'
    );
  });

  it('says which records have links that kept only their words, the rest by how many (#1426)', () => {
    expect(droppedLinksText({ count: 9, records: 5, titles: ['A', 'B', 'C'] })).toBe('9 links keep only their words: their addresses are not ones an entry can keep (in “A”, “B”, “C” and 2 more). Give them a web address at the source.');
    // A converter's are counted only.
    expect(droppedLinksText({ count: 2, records: 0, titles: [] })).toBe('2 links keep only their words: their addresses are not ones an entry can keep. Give them a web address at the source.');
    // A long title is cut, never the sentence.
    expect(droppedLinksText({ count: 1, records: 1, titles: ['x'.repeat(200)] })).toBe(`A link keeps only its words: its address is not one an entry can keep (in “${'x'.repeat(59)}…”). Give it a web address at the source.`);
  });

  it('drops the collection’s source and the source’s settings in one step, or only the settings before a first sync', () => {
    const state = project();
    state.sources = { 'team-cms': { schemaVersion: 1, id: 'team-cms', name: 'Team CMS', adapter: 'rest', collectionId: 'team', config: { url: 'https://a.example' } } };
    expect(detachOps(state, 'team')).toEqual([{ type: 'source.remove', sourceId: 'team-cms' }]);
    state.collections.team.settings.sourceId = 'team-cms';
    expect(detachOps(state, 'team')).toEqual([
      { type: 'collection.update', collectionId: 'team', sourceId: null },
      { type: 'source.remove', sourceId: 'team-cms' }
    ]);
    expect(detachOps(state, 'nothing')).toEqual([]);
  });
});
