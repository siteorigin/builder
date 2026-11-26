/**
 * Collection queries (#674): filters over built-in, grouping and custom fields, sorting by any field or the editorial
 * order, slices, `$current` and `excludeCurrent`, drafts and addresses the site cannot have left out, unknown names
 * finding nothing, and the stable key the generator's derived cache names a query's result by.
 */
import { describe, expect, it } from 'vitest';
import type { Collection, CollectionDoc, EntryDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { collectionQueryKey, normalizeCollectionQuery, queryEntries, type CollectionQuery, type QueryPlace } from '@shared/collection-query';
import { queriedEntries, queriedEntryIds } from '@generator/collection-query';
import { GenerationCache, derived } from '@generator/cache';

function entry(id: string, over: Partial<EntryDoc> = {}): EntryDoc {
  return {
    schemaVersion: 1,
    id,
    slug: id.slice(3),
    title: id,
    publishedAt: '2026-01-01',
    draft: false,
    terms: {},
    values: {},
    body: [],
    ...over
  };
}

function collection(settings: Partial<CollectionDoc> & { id: string }, entries: EntryDoc[]): Collection {
  return {
    settings: {
      schemaVersion: 1,
      name: settings.id,
      taxonomies: {},
      fields: {},
      template: { rootIds: [], nodes: {} },
      ...settings
    } as CollectionDoc,
    entries: Object.fromEntries(entries.map((e) => [e.id, e]))
  };
}

/** A data-only team, projects with entry pages, and a blog with categories and tags. */
function project(): ProjectState {
  const s = createStarterState('business', 'Riverside Studio', false);
  const team = collection(
    {
      id: 'team',
      kind: 'structured',
      hasBody: false,
      pages: { detail: false, archive: false },
      taxonomies: {
        office: {
          label: 'Office',
          terms: { leeds: { label: 'Leeds' }, york: { label: 'York' } }
        }
      },
      fields: {
        role: { type: 'string', label: 'Role', default: '' },
        level: {
          type: 'enum',
          label: 'Level',
          default: 'junior',
          options: [
            { value: 'junior', label: 'Junior' },
            { value: 'senior', label: 'Senior' }
          ]
        },
        years: { type: 'number', label: 'Years', default: 0 },
        partner: { type: 'boolean', label: 'Partner', default: false },
        joined: { type: 'date', label: 'Joined', default: '' }
      } as CollectionDoc['fields']
    },
    [
      entry('en_ruiz', {
        title: 'Ana Ruiz',
        terms: { office: ['leeds'] },
        values: {
          role: 'Lead Architect',
          level: 'senior',
          years: 12,
          partner: true,
          joined: '2014-03-01'
        }
      }),
      entry('en_okafor', {
        title: 'Ben Okafor',
        terms: { office: ['york'] },
        values: { role: 'Architect', years: 4, joined: '2022-09-15' }
      }),
      entry('en_chen', {
        title: 'Chloe Chen',
        terms: { office: ['leeds', 'york'] },
        values: { role: 'Interior designer', level: 'senior', years: 4 }
      }),
      entry('en_draft', {
        title: 'Dana Draft',
        draft: true,
        values: { role: 'Architect', years: 30 }
      })
    ]
  );
  const projects = collection(
    {
      id: 'projects',
      kind: 'structured',
      route: '/work/',
      pages: { detail: true, archive: false },
      fields: {
        lead: {
          type: 'reference',
          label: 'Lead',
          collection: 'team',
          default: ''
        },
        crew: {
          type: 'reference',
          label: 'Crew',
          collection: 'team',
          multiple: true,
          default: []
        },
        budget: { type: 'number', label: 'Budget', default: 0 }
      } as CollectionDoc['fields']
    },
    [
      entry('en_mill', {
        slug: 'mill',
        title: 'The Mill',
        values: {
          lead: 'en_ruiz',
          crew: ['en_okafor', 'en_chen'],
          budget: 500
        }
      }),
      entry('en_dock', {
        slug: 'dock',
        title: 'Dock House',
        values: { lead: 'en_okafor', crew: ['en_chen'], budget: 120 }
      }),
      entry('en_barn', {
        slug: 'barn',
        title: 'Barn',
        values: { budget: 120 }
      }),
      // An address the site cannot have: a hand-edited slug.
      entry('en_bad', { slug: 'Bad Slug!', title: 'Broken' })
    ]
  );
  const posts = collection(
    {
      id: 'posts',
      route: '/blog/',
      taxonomies: {
        categories: {
          label: 'Categories',
          terms: { news: { label: 'News' }, craft: { label: 'Craft' } }
        },
        tags: { label: 'Tags', terms: { oak: { label: 'Oak' } } }
      },
      entryOrder: ['en_third', 'en_first']
    },
    [
      entry('en_first', {
        slug: 'first',
        title: 'first steps',
        publishedAt: '2026-01-10',
        author: 'Ana',
        terms: { categories: ['news'] }
      }),
      entry('en_second', {
        slug: 'second',
        title: 'Second Thoughts',
        publishedAt: '2026-03-02',
        author: 'Ben',
        terms: { categories: ['craft'], tags: ['oak'] },
        body: [{ type: 'p', spans: [{ text: 'Working with OAK beams' }] }] as EntryDoc['body']
      }),
      entry('en_third', {
        slug: 'third',
        title: 'Third Way',
        publishedAt: '2026-02-20',
        terms: { categories: ['news', 'craft'] }
      }),
      entry('en_samedate', {
        slug: 'same',
        title: 'Third Way',
        publishedAt: '2026-02-20'
      })
    ]
  );
  s.collections = { team, projects, posts };
  return s;
}

const ids = (s: ProjectState, q: unknown, place?: QueryPlace) => queryEntries(s, q, place).map((e) => e.id);
const team = (where: CollectionQuery['where'], sort?: CollectionQuery['sort']) => ({ collectionId: 'team', where, ...(sort ? { sort } : {}) });
const byId: CollectionQuery['sort'] = [{ field: 'id' }];

describe('collection query filters', () => {
  const s = project();

  it('filters string and enum fields exactly, and contains ignoring case', () => {
    expect(ids(s, team([{ field: 'field.role', op: 'eq', value: 'Architect' }]))).toEqual(['en_okafor']);
    expect(ids(s, team([{ field: 'field.role', op: 'eq', value: 'architect' }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.role', op: 'contains', value: 'ARCHITECT' }], byId))).toEqual(['en_okafor', 'en_ruiz']);
    expect(ids(s, team([{ field: 'field.role', op: 'ne', value: 'Architect' }], byId))).toEqual(['en_chen', 'en_ruiz']);
    // An unset enum reads as its default.
    expect(ids(s, team([{ field: 'field.level', op: 'eq', value: 'junior' }]))).toEqual(['en_okafor']);
    expect(ids(s, team([{ field: 'field.level', op: 'in', value: ['senior', 'lead'] }], byId))).toEqual(['en_chen', 'en_ruiz']);
    expect(ids(s, team([{ field: 'title', op: 'contains', value: 'ben' }]))).toEqual(['en_okafor']);
  });

  it('compares numbers by size and never as text', () => {
    expect(ids(s, team([{ field: 'field.years', op: 'gt', value: 4 }]))).toEqual(['en_ruiz']);
    expect(ids(s, team([{ field: 'field.years', op: 'gte', value: 4 }], byId))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
    expect(ids(s, team([{ field: 'field.years', op: 'lt', value: 10 }], byId))).toEqual(['en_chen', 'en_okafor']);
    expect(ids(s, team([{ field: 'field.years', op: 'lte', value: 3 }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.years', op: 'eq', value: 12 }]))).toEqual(['en_ruiz']);
    expect(ids(s, team([{ field: 'field.years', op: 'eq', value: '12' }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.years', op: 'gt', value: '2' }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.years', op: 'in', value: [4, 99] }], byId))).toEqual(['en_chen', 'en_okafor']);
  });

  it('filters yes/no fields, defaults included', () => {
    expect(ids(s, team([{ field: 'field.partner', op: 'eq', value: true }]))).toEqual(['en_ruiz']);
    expect(ids(s, team([{ field: 'field.partner', op: 'eq', value: false }], byId))).toEqual(['en_chen', 'en_okafor']);
    expect(ids(s, team([{ field: 'field.partner', op: 'eq', value: 'true' }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.partner', op: 'gt', value: false }]))).toEqual([]);
  });

  it('compares dates as YYYY-MM-DD, and tells set dates from unset ones', () => {
    expect(ids(s, team([{ field: 'field.joined', op: 'gte', value: '2020-01-01' }]))).toEqual(['en_okafor']);
    expect(ids(s, team([{ field: 'field.joined', op: 'lt', value: '2020-01-01' }]))).toEqual(['en_ruiz']);
    expect(ids(s, team([{ field: 'field.joined', op: 'gt', value: '' }], byId))).toEqual(['en_okafor', 'en_ruiz']);
    expect(ids(s, team([{ field: 'field.joined', op: 'exists' }], byId))).toEqual(['en_okafor', 'en_ruiz']);
    expect(ids(s, team([{ field: 'field.joined', op: 'exists', value: false }]))).toEqual(['en_chen']);
    expect(
      ids(s, {
        collectionId: 'posts',
        where: [{ field: 'publishedAt', op: 'gt', value: '2026-02-01' }],
        sort: byId
      })
    ).toEqual(['en_samedate', 'en_second', 'en_third']);
  });

  it('counts 0 and no as values for exists, and blank text or an empty list as none', () => {
    expect(ids(s, team([{ field: 'field.years', op: 'exists' }])).length).toBe(3);
    expect(ids(s, team([{ field: 'field.partner', op: 'exists' }])).length).toBe(3);
    expect(
      ids(s, {
        collectionId: 'projects',
        where: [{ field: 'field.crew', op: 'exists', value: false }]
      })
    ).toEqual(['en_barn']);
    expect(
      ids(s, {
        collectionId: 'projects',
        where: [{ field: 'field.lead', op: 'exists' }],
        sort: byId
      })
    ).toEqual(['en_dock', 'en_mill']);
  });

  it('filters single and multiple references by the IDs they name', () => {
    const projects = (where: CollectionQuery['where']) => ids(s, { collectionId: 'projects', where, sort: byId });
    expect(projects([{ field: 'field.lead', op: 'eq', value: 'en_ruiz' }])).toEqual(['en_mill']);
    expect(projects([{ field: 'field.lead', op: 'in', value: ['en_ruiz', 'en_okafor'] }])).toEqual(['en_dock', 'en_mill']);
    expect(projects([{ field: 'field.crew', op: 'contains', value: 'en_chen' }])).toEqual(['en_dock', 'en_mill']);
    expect(projects([{ field: 'field.crew', op: 'eq', value: 'en_okafor' }])).toEqual(['en_mill']);
    expect(projects([{ field: 'field.crew', op: 'ne', value: 'en_okafor' }])).toEqual(['en_barn', 'en_dock']);
    expect(projects([{ field: 'field.crew', op: 'in', value: ['en_okafor', 'en_nobody'] }])).toEqual(['en_mill']);
    expect(projects([{ field: 'field.crew', op: 'gt', value: 'en_a' }])).toEqual([]);
  });

  it('filters groupings by term ID or label, and an unknown term finds nothing', () => {
    const posts = (where: CollectionQuery['where']) => ids(s, { collectionId: 'posts', where, sort: byId });
    expect(posts([{ field: 'terms.categories', op: 'eq', value: 'news' }])).toEqual(['en_first', 'en_third']);
    expect(posts([{ field: 'categories', op: 'contains', value: 'Craft' }])).toEqual(['en_second', 'en_third']);
    expect(posts([{ field: 'terms.categories', op: 'ne', value: 'NEWS' }])).toEqual(['en_samedate', 'en_second']);
    expect(posts([{ field: 'terms.tags', op: 'in', value: ['oak'] }])).toEqual(['en_second']);
    expect(posts([{ field: 'terms.tags', op: 'exists', value: false }])).toEqual(['en_first', 'en_samedate', 'en_third']);
    expect(posts([{ field: 'terms.categories', op: 'eq', value: 'gossip' }])).toEqual([]);
    expect(posts([{ field: 'terms.categories', op: 'ne', value: 'gossip' }])).toEqual([]);
    expect(ids(s, team([{ field: 'terms.office', op: 'eq', value: 'Leeds' }], byId))).toEqual(['en_chen', 'en_ruiz']);
  });

  it('ANDs every clause, and reads the text of an entry as its words', () => {
    expect(
      ids(
        s,
        team([
          { field: 'field.level', op: 'eq', value: 'senior' },
          { field: 'terms.office', op: 'eq', value: 'york' }
        ])
      )
    ).toEqual(['en_chen']);
    expect(
      ids(s, {
        collectionId: 'posts',
        where: [{ field: 'body', op: 'contains', value: 'oak beams' }]
      })
    ).toEqual(['en_second']);
    expect(
      ids(s, {
        collectionId: 'posts',
        where: [{ field: 'slug', op: 'eq', value: 'third' }]
      })
    ).toEqual(['en_third']);
  });
});

describe('collection query sorting and slicing', () => {
  const s = project();

  it("keeps the collection's own order without a sort: the editorial order, then newest first", () => {
    expect(ids(s, { collectionId: 'posts' })).toEqual(['en_third', 'en_first', 'en_second', 'en_samedate']);
  });

  it('sorts texts, numbers and dates either way, ties by entry ID', () => {
    expect(ids(s, { collectionId: 'posts', sort: [{ field: 'title' }] })).toEqual(['en_second', 'en_samedate', 'en_third', 'en_first']);
    expect(
      ids(s, {
        collectionId: 'posts',
        sort: [{ field: 'title', direction: 'desc' }]
      })
    ).toEqual(['en_first', 'en_samedate', 'en_third', 'en_second']);
    expect(ids(s, team(undefined, [{ field: 'field.years', direction: 'desc' }]))).toEqual(['en_ruiz', 'en_chen', 'en_okafor']);
    expect(ids(s, team(undefined, [{ field: 'field.years' }]))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
    expect(ids(s, { collectionId: 'posts', sort: [{ field: 'publishedAt' }] })).toEqual(['en_first', 'en_samedate', 'en_third', 'en_second']);
    expect(
      ids(s, {
        collectionId: 'posts',
        sort: [{ field: 'publishedAt', direction: 'desc' }]
      })
    ).toEqual(['en_second', 'en_samedate', 'en_third', 'en_first']);
  });

  it('sorts by later keys within ties of earlier ones', () => {
    expect(ids(s, team(undefined, [{ field: 'field.years' }, { field: 'title', direction: 'desc' }]))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
    expect(ids(s, team(undefined, [{ field: 'field.years' }, { field: 'title' }]))).toEqual(['en_okafor', 'en_chen', 'en_ruiz']);
  });

  it('puts entries without a value last whichever way a key sorts', () => {
    expect(ids(s, team(undefined, [{ field: 'field.joined' }]))).toEqual(['en_ruiz', 'en_okafor', 'en_chen']);
    expect(ids(s, team(undefined, [{ field: 'field.joined', direction: 'desc' }]))).toEqual(['en_okafor', 'en_ruiz', 'en_chen']);
  });

  it('sorts by the editorial order, either way', () => {
    expect(ids(s, { collectionId: 'posts', sort: [{ field: 'entryOrder' }] })).toEqual(['en_third', 'en_first', 'en_second', 'en_samedate']);
    expect(
      ids(s, {
        collectionId: 'posts',
        sort: [{ field: 'entryOrder', direction: 'desc' }]
      })
    ).toEqual(['en_samedate', 'en_second', 'en_first', 'en_third']);
  });

  it('skips the offset, then takes at most the limit', () => {
    const q = { collectionId: 'posts', sort: [{ field: 'publishedAt' }] };
    expect(ids(s, { ...q, limit: 2 })).toEqual(['en_first', 'en_samedate']);
    expect(ids(s, { ...q, offset: 1, limit: 2 })).toEqual(['en_samedate', 'en_third']);
    expect(ids(s, { ...q, offset: 3 })).toEqual(['en_second']);
    expect(ids(s, { ...q, offset: 9 })).toEqual([]);
    expect(ids(s, { ...q, limit: 0 })).toEqual([]);
  });

  it('gives the same order whatever order the entries are stored in', () => {
    const t = project();
    t.collections.posts.entries = Object.fromEntries(Object.entries(t.collections.posts.entries).reverse());
    const q = { collectionId: 'posts', sort: [{ field: 'publishedAt' }] };
    expect(ids(t, q)).toEqual(ids(s, q));
  });
});

describe('collection query scope', () => {
  const s = project();

  it('leaves drafts out', () => {
    expect(ids(s, team([{ field: 'field.years', op: 'gt', value: 20 }]))).toEqual([]);
    expect(ids(s, team(undefined)).includes('en_draft')).toBe(false);
  });

  it('leaves out an entry whose page sits at an address the site cannot have, or one a page holds', () => {
    expect(ids(s, { collectionId: 'projects', sort: byId })).toEqual(['en_barn', 'en_dock', 'en_mill']);
    const t = project();
    const page = Object.values(t.pages)[0];
    page.route = '/WORK/Mill/';
    expect(ids(t, { collectionId: 'projects', sort: byId })).toEqual(['en_barn', 'en_dock']);
  });

  it('lists a data-only collection, whose entries have no address, whatever their slugs', () => {
    const t = project();
    t.collections.team.entries.en_ruiz.slug = 'Not A Slug';
    expect(ids(t, team(undefined, byId))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
  });

  it('reads $current as the collection of the entry whose page it is on, and leaves that entry out when asked', () => {
    const place: QueryPlace = {
      entry: { collectionId: 'posts', entryId: 'en_third' }
    };
    expect(ids(s, { collectionId: '$current', sort: byId }, place)).toEqual(['en_first', 'en_samedate', 'en_second', 'en_third']);
    expect(ids(s, { collectionId: '$current', excludeCurrent: true, sort: byId }, place)).toEqual(['en_first', 'en_samedate', 'en_second']);
    expect(ids(s, { collectionId: 'posts', excludeCurrent: true, sort: byId }, place)).toEqual(['en_first', 'en_samedate', 'en_second']);
    // Off an entry's page there is no current collection, and nothing to leave out.
    expect(ids(s, { collectionId: '$current' })).toEqual([]);
    expect(ids(s, { collectionId: 'posts', excludeCurrent: true }).length).toBe(4);
  });

  it('finds nothing, without throwing, for unknown collections, fields and malformed queries', () => {
    expect(ids(s, { collectionId: 'nowhere' })).toEqual([]);
    expect(ids(s, { collectionId: '__proto__' })).toEqual([]);
    expect(ids(s, { collectionId: 'constructor' })).toEqual([]);
    expect(ids(s, team([{ field: 'field.nothing', op: 'eq', value: 1 }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.nothing', op: 'ne', value: 1 }]))).toEqual([]);
    expect(ids(s, team([{ field: 'field.constructor', op: 'exists', value: false }]))).toEqual([]);
    expect(ids(s, team([{ field: 'terms.nothing', op: 'exists', value: false }]))).toEqual([]);
    expect(ids(s, team([{ field: 'nonsense', op: 'exists', value: false }]))).toEqual([]);
    expect(ids(s, team([{ field: 'prevEntry', op: 'exists', value: false }]))).toEqual([]);
    // A data-only team has no text of its own.
    expect(ids(s, team([{ field: 'body', op: 'exists', value: false }]))).toEqual([]);
    expect(ids(s, team(undefined, [{ field: 'field.nothing' }]))).toEqual([]);
    for (const bad of [
      null,
      'team',
      {},
      { collectionId: 'team', where: {} },
      {
        collectionId: 'team',
        where: [{ field: 'title', op: 'like', value: 'a' }]
      },
      { collectionId: 'team', limit: -1 },
      { collectionId: 'team', limit: 1.5 },
      { collectionId: 'team', sort: [{ field: 'title', direction: 'up' }] },
      {
        collectionId: 'team',
        where: [{ field: 'field.years', op: 'gt', value: Number.NaN }]
      },
      {
        collectionId: 'team',
        where: [{ field: 'field.years', op: 'in', value: [4, , 12] }]
      }
    ]) {
      expect(() => queryEntries(s, bad)).not.toThrow();
      expect(queryEntries(s, bad)).toEqual([]);
    }
  });
});

describe('collection query key', () => {
  it('is the same however the query is written, and differs whenever what it finds could', () => {
    const a = {
      collectionId: 'team',
      where: [{ field: 'field.years', op: 'gt', value: 3 }],
      limit: 2
    };
    const b = {
      limit: 2,
      where: [{ value: 3, op: 'gt', field: 'field.years' }],
      collectionId: 'team',
      offset: 0,
      excludeCurrent: false
    };
    expect(collectionQueryKey(a)).toBe(collectionQueryKey(b));
    expect(collectionQueryKey(a)).not.toBe(collectionQueryKey({ ...a, limit: 3 }));
    expect(collectionQueryKey(a)).not.toBe(
      collectionQueryKey({
        ...a,
        where: [{ field: 'field.years', op: 'gt', value: '3' }]
      })
    );
    expect(collectionQueryKey({ collectionId: 'nope', where: 'x' })).toBeNull();
  });

  it('names the entry whose page it is on only when the query reads it', () => {
    const place = (entryId: string): QueryPlace => ({
      entry: { collectionId: 'posts', entryId }
    });
    const plain = { collectionId: 'posts' };
    expect(collectionQueryKey(plain, place('en_first'))).toBe(collectionQueryKey(plain, place('en_second')));
    expect(collectionQueryKey(plain, place('en_first'))).toBe(collectionQueryKey(plain));
    const related = { collectionId: '$current', excludeCurrent: true };
    expect(collectionQueryKey(related, place('en_first'))).not.toBe(collectionQueryKey(related, place('en_second')));
  });

  it('normalizes to a detached copy', () => {
    const values = ['senior'];
    const q = normalizeCollectionQuery({
      collectionId: 'team',
      where: [{ field: 'field.level', op: 'in', value: values }]
    })!;
    values.push('junior');
    expect(q.where?.[0].value).toEqual(['senior']);
  });
});

describe('collection queries in a generator run', () => {
  it('finds the same entries as queryEntries, read from the state', () => {
    const s = project();
    const q = {
      collectionId: 'posts',
      sort: [{ field: 'publishedAt', direction: 'desc' }],
      limit: 2
    };
    expect(queriedEntryIds(s, q)).toEqual(['en_second', 'en_samedate']);
    expect(queriedEntries(s, q)).toEqual([s.collections.posts.entries.en_second, s.collections.posts.entries.en_samedate]);
    expect(queriedEntries(s, { collectionId: 'nowhere' })).toEqual([]);
  });

  it('works out a query by its own copy, so editing the query afterwards changes nothing under its key', () => {
    const s = project();
    const clause = { field: 'field.years', op: 'gte', value: 10 };
    const q = { collectionId: 'team', where: [clause], sort: byId };
    // Outside a cached run, derived simply works the value out.
    expect(derived(s, 'probe', () => 1)).toBe(1);
    expect(queriedEntryIds(s, q)).toEqual(['en_ruiz']);
    clause.value = 1;
    expect(queriedEntryIds(s, q)).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
  });

  it('reuses a file that lists a query when an edit changes none of its entries, and remakes it when one does', () => {
    const cache = new GenerationCache();
    const q = {
      collectionId: 'posts',
      where: [{ field: 'terms.categories', op: 'eq', value: 'news' }],
      sort: [{ field: 'publishedAt' }]
    };
    const make = (s: ProjectState) => {
      const { file, finish } = cache.run(s, false);
      const content = file('list', (t) =>
        queriedEntries(t, q)
          .map((e) => e.title)
          .join(' | ')
      );
      finish();
      return content;
    };
    const s1 = project();
    expect(make(s1)).toBe('first steps | Third Way');
    expect(cache.made).toEqual(['list']);

    // An entry the query does not find gets a new title: nothing to remake.
    const s2 = structuredClone(s1);
    s2.collections.posts.entries.en_second.title = 'Second, retitled';
    expect(make(s2)).toBe('first steps | Third Way');
    expect(cache.made).toEqual([]);

    // A listed entry's title changes: the file reads it, so it is remade.
    const s3 = structuredClone(s2);
    s3.collections.posts.entries.en_first.title = 'First, retitled';
    expect(make(s3)).toBe('First, retitled | Third Way');
    expect(cache.made).toEqual(['list']);

    // An entry joins the result.
    const s4 = structuredClone(s3);
    s4.collections.posts.entries.en_second.terms = { categories: ['news'] };
    expect(make(s4)).toBe('First, retitled | Third Way | Second, retitled');
    expect(cache.made).toEqual(['list']);
  });
});

describe('collection query edges', () => {
  it('counts 0 as a value and blank text as none, for exists and for sorting', () => {
    const s = project();
    s.collections.team.entries.en_okafor.values.years = 0;
    s.collections.team.entries.en_chen.values.role = '   ';
    expect(ids(s, team([{ field: 'field.years', op: 'exists' }], byId))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
    expect(ids(s, team([{ field: 'field.role', op: 'exists', value: false }]))).toEqual(['en_chen']);
    expect(ids(s, team(undefined, [{ field: 'field.role' }]))).toEqual(['en_okafor', 'en_ruiz', 'en_chen']);
    expect(ids(s, team(undefined, [{ field: 'field.role', direction: 'desc' }]))).toEqual(['en_ruiz', 'en_okafor', 'en_chen']);
    expect(ids(s, team([{ field: 'field.role', op: 'lt', value: 'Z' }], byId))).toEqual(['en_okafor', 'en_ruiz']);
  });

  it('includes the bound of gte and lte', () => {
    const s = project();
    expect(ids(s, team([{ field: 'field.years', op: 'lte', value: 4 }], byId))).toEqual(['en_chen', 'en_okafor']);
    expect(ids(s, team([{ field: 'field.joined', op: 'gte', value: '2022-09-15' }]))).toEqual(['en_okafor']);
    expect(ids(s, team([{ field: 'field.joined', op: 'lte', value: '2014-03-01' }]))).toEqual(['en_ruiz']);
  });

  it('reads an unset yes/no as its default, whatever that is', () => {
    const s = project();
    (s.collections.team.settings.fields.partner as { default: boolean }).default = true;
    s.collections.team.entries.en_okafor.values.partner = false;
    expect(ids(s, team([{ field: 'field.partner', op: 'eq', value: true }], byId))).toEqual(['en_chen', 'en_ruiz']);
  });

  it('matches every value of in, not only the first', () => {
    const s = project();
    expect(ids(s, team([{ field: 'field.level', op: 'in', value: ['junior', 'senior'] }], byId))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
    expect(ids(s, { collectionId: 'projects', where: [{ field: 'field.crew', op: 'in', value: ['en_nobody', 'en_okafor'] }] })).toEqual(['en_mill']);
  });

  it('names a term by a label that is not its ID, and passes over terms in does not know', () => {
    const s = project();
    s.collections.posts.settings.taxonomies.categories.terms.craft.label = 'Arts & Crafts';
    const posts = (where: CollectionQuery['where']) => ids(s, { collectionId: 'posts', where, sort: byId });
    expect(posts([{ field: 'categories', op: 'eq', value: 'arts & crafts' }])).toEqual(['en_second', 'en_third']);
    expect(posts([{ field: 'terms.categories', op: 'in', value: ['gossip', 'Arts & Crafts'] }])).toEqual(['en_second', 'en_third']);
    expect(posts([{ field: 'terms.categories', op: 'in', value: ['gossip'] }])).toEqual([]);
  });

  it('reads every block of rich text', () => {
    const s = project();
    s.collections.posts.entries.en_first.body = [
      { type: 'p', spans: [{ text: 'Intro' }] },
      { type: 'p', spans: [{ text: 'Hand-cut dovetails' }] }
    ] as EntryDoc['body'];
    expect(ids(s, { collectionId: 'posts', where: [{ field: 'body', op: 'contains', value: 'DOVETAILS' }] })).toEqual(['en_first']);
  });

  it('filters before it slices', () => {
    const s = project();
    expect(ids(s, { collectionId: 'posts', where: [{ field: 'categories', op: 'eq', value: 'news' }], sort: [{ field: 'publishedAt' }], offset: 1, limit: 1 })).toEqual(['en_third']);
  });

  it('orders newest first without an editorial order, and sorts by it only when asked', () => {
    const s = project();
    delete s.collections.posts.settings.entryOrder;
    expect(ids(s, { collectionId: 'posts' })).toEqual(['en_second', 'en_samedate', 'en_third', 'en_first']);
    const t = project();
    t.collections.posts.settings.entryOrder = ['en_second', 'en_first', 'en_third', 'en_samedate'];
    expect(ids(t, { collectionId: 'posts', sort: [{ field: 'title' }, { field: 'entryOrder' }] })).toEqual(['en_second', 'en_third', 'en_samedate', 'en_first']);
    expect(ids(t, { collectionId: 'posts', sort: [{ field: 'title' }, { field: 'entryOrder', direction: 'desc' }] })).toEqual(['en_second', 'en_samedate', 'en_third', 'en_first']);
  });

  it('breaks a numeric tie by entry ID whatever the editorial order says', () => {
    const s = project();
    s.collections.team.settings.entryOrder = ['en_okafor', 'en_chen', 'en_ruiz'];
    expect(ids(s, team(undefined, [{ field: 'field.years' }]))).toEqual(['en_chen', 'en_okafor', 'en_ruiz']);
  });

  it('keeps one order for damaged entries, whatever order the files were read in, and lists an entry once', () => {
    const s = project();
    (s.collections.team.entries.en_chen as { publishedAt: unknown }).publishedAt = undefined;
    s.collections.team.settings.entryOrder = ['en_ruiz', 'en_ruiz'];
    const forward = ids(s, team(undefined));
    s.collections.team.entries = Object.fromEntries(Object.entries(s.collections.team.entries).reverse());
    expect(ids(s, team(undefined))).toEqual(forward);
    expect(forward).toEqual(['en_ruiz', 'en_okafor', 'en_chen']);
    expect(ids(s, { ...team(undefined), limit: 2 })).toEqual(['en_ruiz', 'en_okafor']);
  });

  it('leaves out a draft that has a page, and the later entry claiming an address an earlier one holds', () => {
    const s = project();
    s.collections.projects.entries.en_dock.draft = true;
    s.collections.projects.entries.en_barn.slug = 'mill';
    // As the site gives it: the entry first in the collection's order (same date, so by ID) keeps the address.
    expect(ids(s, { collectionId: 'projects', sort: byId })).toEqual(['en_barn']);
  });

  it('reads $current as the collection of whichever entry page it is on', () => {
    const s = project();
    expect(ids(s, { collectionId: '$current', excludeCurrent: true, sort: byId }, { entry: { collectionId: 'projects', entryId: 'en_dock' } })).toEqual(['en_barn', 'en_mill']);
  });

  it('never throws on values that throw or answer differently each time they are read', () => {
    const s = project();
    const throwing = Object.defineProperty({}, 'collectionId', {
      get() {
        throw new Error('no');
      }
    });
    expect(queryEntries(s, throwing)).toEqual([]);
    expect(collectionQueryKey(throwing)).toBeNull();
    const place = Object.defineProperty({}, 'entry', {
      get() {
        throw new Error('no');
      }
    }) as QueryPlace;
    expect(queryEntries(s, { collectionId: 'posts', limit: 1 }, place).length).toBe(1);
    let reads = 0;
    const watched = Object.defineProperty({}, 'entry', {
      get() {
        reads++;
        return { collectionId: 'posts', entryId: 'en_first' };
      }
    }) as QueryPlace;
    expect(ids(s, { collectionId: 'posts', sort: byId }, watched)).toContain('en_first');
    expect(reads).toBe(0);
    let n = 0;
    const shifting = Object.defineProperty({}, 'collectionId', {
      get() {
        return n++ < 1 ? 'posts' : 1n;
      }
    });
    expect(normalizeCollectionQuery(shifting)).toEqual({ collectionId: 'posts' });
    expect(() => collectionQueryKey(shifting)).not.toThrow();
    // Rich text damaged past reading finds nothing rather than stopping whatever asked.
    s.collections.posts.entries.en_first.body = [{ type: 'p', spans: [null] }] as unknown as EntryDoc['body'];
    expect(queryEntries(s, { collectionId: 'posts', where: [{ field: 'body', op: 'contains', value: 'x' }] })).toEqual([]);
    expect(normalizeCollectionQuery({ collectionId: 'team', where: [{ field: 'field.years', op: 'gt', value: Number.NaN }] })).toBeNull();
    // A boxed collection ID is no ID.
    expect(ids(s, { collectionId: '$current' }, { entry: { collectionId: new String('posts') as unknown as string, entryId: 'en_first' } })).toEqual([]);
  });
});

describe('collection query keys, part by part', () => {
  const base = { collectionId: 'posts', sort: [{ field: 'title' }], offset: 1 };
  it('changes with the collection, the sort and the offset', () => {
    const key = collectionQueryKey(base);
    expect(collectionQueryKey({ ...base, collectionId: 'team' })).not.toBe(key);
    expect(collectionQueryKey({ ...base, sort: [{ field: 'title', direction: 'desc' }] })).not.toBe(key);
    expect(collectionQueryKey({ ...base, sort: [{ field: 'publishedAt' }] })).not.toBe(key);
    expect(collectionQueryKey({ ...base, offset: 2 })).not.toBe(key);
  });

  it('names the place for $current alone and for excludeCurrent alone', () => {
    const at = (collectionId: string, entryId: string): QueryPlace => ({ entry: { collectionId, entryId } });
    const current = { collectionId: '$current' };
    expect(collectionQueryKey(current, at('posts', 'en_first'))).not.toBe(collectionQueryKey(current, at('projects', 'en_mill')));
    const except = { collectionId: 'posts', excludeCurrent: true };
    expect(collectionQueryKey(except, at('posts', 'en_first'))).not.toBe(collectionQueryKey(except, at('posts', 'en_second')));
  });

  it('is detached from the clauses and sort keys it was made from', () => {
    const clause = { field: 'title', op: 'eq', value: 'a' };
    const sort = { field: 'title', direction: 'desc' };
    const q = normalizeCollectionQuery({ collectionId: 'posts', where: [clause], sort: [sort] })!;
    clause.field = 'author';
    sort.direction = 'asc';
    expect(q.where?.[0].field).toBe('title');
    expect(q.sort?.[0].direction).toBe('desc');
  });
});

describe('collection queries in a cached generator run', () => {
  const runner = () => {
    const cache = new GenerationCache();
    const make = (s: ProjectState, render: (t: ProjectState) => string) => {
      const { file, finish } = cache.run(s, false);
      const content = file('list', render);
      finish();
      return content;
    };
    return { cache, make };
  };
  const news = { collectionId: 'posts', where: [{ field: 'terms.categories', op: 'eq', value: 'news' }], sort: [{ field: 'publishedAt' }] };

  it('depends on which entries a query finds, not on the documents it looked at', () => {
    const { cache, make } = runner();
    const render = (t: ProjectState) =>
      queriedEntries(t, news)
        .map((e) => e.title)
        .join(' | ');
    const s1 = project();
    expect(make(s1, render)).toBe('first steps | Third Way');
    // An entry left out gets other terms, still not news: the query read them, but finds the same entries.
    const s2 = structuredClone(s1);
    s2.collections.posts.entries.en_second.terms = { categories: ['craft'], tags: [] };
    expect(make(s2, render)).toBe('first steps | Third Way');
    expect(cache.made).toEqual([]);
    // Only the order changes: the file is remade.
    const s3 = structuredClone(s2);
    s3.collections.posts.entries.en_first.publishedAt = '2026-12-01';
    expect(make(s3, render)).toBe('Third Way | first steps');
    expect(cache.made).toEqual(['list']);
  });

  it('keeps finding what the query said when it was keyed, whatever the caller edits afterwards', () => {
    const { cache, make } = runner();
    const clause = { field: 'terms.categories', op: 'eq', value: 'news' };
    const q = { collectionId: 'posts', where: [clause], sort: [{ field: 'id' }] };
    const place = { entry: { collectionId: 'posts', entryId: 'en_first' } };
    const related = { collectionId: '$current', excludeCurrent: true, sort: [{ field: 'id' }] };
    const render = (t: ProjectState) => `${queriedEntryIds(t, q).join(',')} / ${queriedEntryIds(t, related, place).join(',')}`;
    const s1 = project();
    expect(make(s1, render)).toBe('en_first,en_third / en_samedate,en_second,en_third');
    clause.value = 'craft';
    place.entry.entryId = 'en_third';
    // A fresh query naming what the first said reads the answer kept for it on a new state.
    const again = (t: ProjectState) =>
      `${queriedEntryIds(t, { collectionId: 'posts', where: [{ field: 'terms.categories', op: 'eq', value: 'news' }], sort: [{ field: 'id' }] }).join(',')} / ${queriedEntryIds(t, related, { entry: { collectionId: 'posts', entryId: 'en_first' } }).join(',')}`;
    expect(make(structuredClone(s1), again)).toBe('en_first,en_third / en_samedate,en_second,en_third');
    expect(cache.made).toEqual([]);
  });

  it('gives each entry page its own related entries in one run', () => {
    const s = project();
    const cache = new GenerationCache();
    const { file, finish } = cache.run(s, false);
    const related = { collectionId: '$current', excludeCurrent: true, sort: [{ field: 'id' }] };
    const a = file('a', (t) =>
      queriedEntries(t, related, { entry: { collectionId: 'posts', entryId: 'en_first' } })
        .map((e) => e.id)
        .join(',')
    );
    const b = file('b', (t) =>
      queriedEntries(t, related, { entry: { collectionId: 'projects', entryId: 'en_mill' } })
        .map((e) => e.id)
        .join(',')
    );
    finish();
    expect(a).toBe('en_samedate,en_second,en_third');
    expect(b).toBe('en_barn,en_dock');
  });
});
