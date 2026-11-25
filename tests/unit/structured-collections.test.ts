/**
 * Structured collections (#673): collections of records (team members, projects, events, synced records) beside
 * editorial blogs, with only the pages they ask for, custom fields of richer kinds (links, rich text, dates, references
 * to other entries), references guarded like links when an entry goes, and synced collections whose entries are
 * read-only to manual edits until detached.
 */
import { describe, expect, it } from 'vitest';
import type { EntrySource, InstanceNode, ProjectState, TextNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { generateProject, publishedState, resolveLink } from '@generator/index';
import { entryNeighbours, materializeTemplate } from '@generator/entry-template';
import { archivePages } from '@shared/archives';
import { collectionHasBody, collectionKind, hasArchivePages, hasDetailPages, isDataOnly, siteEntries } from '@shared/collections';
import { entryFieldSchemas, entryFieldValue } from '@shared/entry-fields';
import { collectionsFromDocs, stateToDocs } from '../../src/main/project/documents';

const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const run = (s: ProjectState, ...ops: EditOperation[]) => apply(s, ops).state;
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const routeFiles = (s: ProjectState) => [...generateProject(publishedState(s)).keys()].filter((f) => f.startsWith('src/routes/')).sort();
const pageAt = (s: ProjectState, route: string) => Object.values(s.pages).find((p) => p.route === route)!;

/** The engine error an operation is refused with. */
function refusal(s: ProjectState, ops: EditOperation[]): EngineError {
  try {
    apply(s, ops);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return e as EngineError;
  }
  throw new Error('Expected the change to be refused.');
}

const site = () => createStarterState('business', 'Riverside Studio', false);

/** A data-only team and a projects collection with entry pages and no archive, whose fields name team members. */
function studio() {
  return run(
    site(),
    { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' } } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false, values: { role: 'Architect' } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_okafor', title: 'Ben Okafor', draft: false },
    {
      type: 'collection.create',
      collectionId: 'projects',
      kind: 'structured',
      singularName: 'Project',
      route: '/work/',
      pages: { detail: true, archive: false },
      fields: {
        website: { type: 'link', label: 'Website' },
        summary: { type: 'richtext', label: 'Summary' },
        completed: { type: 'date', label: 'Completed' },
        lead: { type: 'reference', label: 'Lead', collection: 'team' },
        crew: { type: 'reference', label: 'Crew', collection: 'team', multiple: true },
        related: { type: 'reference', label: 'Related', collection: 'projects', multiple: true }
      }
    },
    {
      type: 'entry.create',
      collectionId: 'projects',
      entryId: 'en_hall',
      title: 'Town hall',
      draft: false,
      values: { website: 'https://hall.example.com', summary: 'A **civic** hall. [Ask us](/contact/).', completed: '2026-04-30', lead: 'en_ruiz', crew: ['en_okafor', 'en_ruiz'] }
    }
  );
}

describe('a data-only structured collection', () => {
  it('is created without an address, validates cleanly and generates no routes', () => {
    const before = site();
    const r = apply(before, [
      { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false },
      // A record named like a page takes the slug the page's address has: it holds no address of its own.
      { type: 'entry.create', collectionId: 'team', entryId: 'en_about', title: 'About', draft: false },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_about2', title: 'About', draft: false }
    ]);
    const s = r.state;
    expect(r.results[0]).toEqual({ collectionId: 'team' });
    expect(r.results[1]).toEqual({ collectionId: 'team', entryId: 'en_ruiz', slug: 'ana-ruiz' });
    const { template, ...settings } = s.collections.team.settings;
    expect(settings).toMatchObject({ id: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false } });
    expect(settings).not.toHaveProperty('route');
    // Records without text start with an empty layout: the theme's article layout would show the text they lack.
    expect(template).toEqual({ rootIds: [], nodes: {} });
    expect(pageAt(s, '/about/')).toBeDefined();
    expect([s.collections.team.entries.en_about.slug, s.collections.team.entries.en_about2.slug]).toEqual(['about', 'about-2']);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'team', entryId: 'en_about2', slug: 'about' }])).toThrow(/“About” of Team already has the slug "about"/);
    expect(errors(s)).toEqual([]);
    expect(isDataOnly(s.collections.team.settings)).toBe(true);
    expect(siteEntries(s).filter((e) => e.collection.settings.id === 'team')).toEqual([]);
    expect(archivePages(s).filter((p) => p.collectionId === 'team')).toEqual([]);
    // Nothing under src/routes/ that the same site without it lacks, and its records in no sitemap, feed or index.
    expect(routeFiles(s)).toEqual(routeFiles(before));
    for (const [file, text] of generateProject(publishedState(s))) expect(text.includes('ana-ruiz'), file).toBe(false);
    // An old address can send visitors to no page of it.
    expect(() => apply(s, [{ type: 'entry.create', collectionId: 'team', title: 'Cara', draft: false, redirectFrom: '/staff/cara/' }])).toThrow(/have no pages/);
  });

  it('refuses an archive without entry pages, and pages without an address', () => {
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'quotes', pages: { detail: false, archive: true } }])).toThrow(/needs them/);
    const s = studio();
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'team', pages: { detail: true, archive: false } }])).toThrow(/needs an address for its pages/);
    // Given one, every record takes its address there, which must be free.
    const people = run(s, { type: 'page.create', title: 'Ana', route: '/people/ana-ruiz/' });
    expect(() => apply(people, [{ type: 'collection.update', collectionId: 'team', route: '/people/', pages: { detail: true, archive: false } }])).toThrow(/would give “Ana Ruiz” the address \/people\/ana-ruiz\/, which is the page “Ana”'s/);
    const routed = run(s, { type: 'collection.update', collectionId: 'team', route: '/people/', pages: { detail: true, archive: false } });
    expect(siteEntries(routed).filter((e) => e.collection.settings.id === 'team').map((e) => e.route).sort()).toEqual(['/people/ana-ruiz/', '/people/ben-okafor/']);
    expect(routeFiles(routed)).toContain('src/routes/people/ana-ruiz/+page.svelte');
    // A hand edit asking for an archive without entry pages is reported, and has neither.
    const hand = structuredClone(s);
    hand.collections.team.settings.pages = { detail: false, archive: true };
    expect(hasArchivePages(hand.collections.team.settings)).toBe(false);
    expect(errors(hand).map((d) => d.message)).toEqual([expect.stringMatching(/an archive without entry pages/)]);
  });
});

describe('a collection without the new settings', () => {
  it('is an editorial collection with entry pages, an archive and text, as every blog has been', () => {
    const s = run(site(), { type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring', draft: false });
    const settings = s.collections.posts.settings;
    for (const k of ['kind', 'singularName', 'hasBody', 'pages', 'sourceId']) expect(settings).not.toHaveProperty(k);
    expect([collectionKind(settings), hasDetailPages(settings), hasArchivePages(settings), collectionHasBody(settings)]).toEqual(['editorial', true, true, true]);
    expect(Object.keys(entryFieldSchemas(s.collections.posts))).toEqual(expect.arrayContaining(['body', 'readingTime']));
    expect(routeFiles(s)).toEqual(expect.arrayContaining(['src/routes/blog/+page.svelte', 'src/routes/blog/spring/+page.svelte']));
  });
});

describe('rich custom fields', () => {
  it('stores links, rich text, dates and references, and round-trips them through the documents', () => {
    const s = studio();
    const hall = s.collections.projects.entries.en_hall;
    const contact = pageAt(s, '/contact/');
    expect(hall.values).toEqual({
      website: { type: 'url', target: 'https://hall.example.com' },
      summary: [{ type: 'p', spans: [{ text: 'A ' }, { text: 'civic', strong: true }, { text: ' hall. ' }, { text: 'Ask us', link: { type: 'page', target: contact.id } }, { text: '.' }] }],
      completed: '2026-04-30',
      lead: 'en_ruiz',
      crew: ['en_okafor', 'en_ruiz']
    });
    expect(s.collections.projects.settings.fields.lead).toEqual({ type: 'reference', label: 'Lead', collection: 'team', default: '' });
    expect(s.collections.projects.settings.fields.crew).toEqual({ type: 'reference', label: 'Crew', collection: 'team', multiple: true, default: [] });
    expect(s.collections.projects.settings.fields.completed).toEqual({ type: 'date', label: 'Completed', default: '' });
    expect(errors(s)).toEqual([]);
    // Written as documents and read back, entries before their settings, exactly as they were.
    const synced = structuredClone(s);
    synced.collections.team.entries.en_ruiz.source = { sourceId: 'people-api', externalId: '42', syncedAt: '2026-11-01T10:00:00.000Z', contentHash: 'abc123' };
    const docs = [...stateToDocs(synced)].filter(([p]) => p.startsWith('siteorigin/collections/')).reverse();
    const back = collectionsFromDocs(docs.map(([p, text]) => [p, JSON.parse(text)]));
    expect(back.orphans).toEqual([]);
    expect(back.duplicates).toEqual([]);
    expect(back.collections).toEqual(synced.collections);
  });

  it('reads each field for an entry as its kind, and shows it in the layout', () => {
    let s = studio();
    const read = () => ({ state: s, collection: s.collections.projects, entry: s.collections.projects.entries.en_hall, neighbours: {} });
    expect(entryFieldValue(read(), 'field.completed')).toBe('April 30, 2026');
    expect(entryFieldValue(read(), 'field.completed', 'raw')).toBe('2026-04-30');
    expect(entryFieldValue(read(), 'field.lead')).toBe('Ana Ruiz');
    expect(entryFieldValue(read(), 'field.lead', 'raw')).toBe('en_ruiz');
    expect(entryFieldValue(read(), 'field.crew')).toBe('Ben Okafor, Ana Ruiz');
    expect(entryFieldValue(read(), 'field.crew', 'raw')).toEqual(['en_okafor', 'en_ruiz']);
    expect(entryFieldValue(read(), 'field.related', 'raw')).toEqual([]);
    expect(entryFieldValue(read(), 'field.website')).toEqual({ type: 'url', target: 'https://hall.example.com' });
    expect(entryFieldValue(read(), 'field.summary')).toEqual(s.collections.projects.entries.en_hall.values.summary);
    const fields = entryFieldSchemas(s.collections.projects);
    expect([fields['field.completed'].type, fields['field.lead'].type, fields['field.crew'].type, fields['field.website'].type, fields['field.summary'].type]).toEqual(['string', 'string', 'string', 'link', 'richtext']);
    // The theme's article layout, rebound to the fields.
    const nodes = () => Object.values(s.collections.projects.settings.template.nodes);
    const bound = (field: string) => nodes().find((n) => (n.kind === 'text' && JSON.stringify(n.text) === JSON.stringify({ $entry: field })) || JSON.stringify(n).includes(`{"$entry":"${field}"}`)) as TextNode;
    const owner = { kind: 'template' as const, id: 'projects' };
    const date = bound('publishedAt');
    const excerpt = bound('excerpt');
    const body = bound('body');
    const inserted = apply(s, [{ type: 'node.insert', owner, parentId: null, componentId: 'cta.banner' }]);
    s = inserted.state;
    const cta = inserted.results[0].nodeId as string;
    s = run(
      s,
      { type: 'node.setBinding', owner, nodeId: date.id, field: 'text', binding: { $entry: 'field.completed' } },
      { type: 'node.setBinding', owner, nodeId: date.id, field: 'datetime', binding: { $entry: 'field.completed' } },
      { type: 'node.setBinding', owner, nodeId: excerpt.id, field: 'text', binding: { $entry: 'field.lead' } },
      { type: 'node.setBinding', owner, nodeId: excerpt.id, field: 'when', binding: { $entry: 'field.crew' } },
      { type: 'node.setBinding', owner, nodeId: body.id, field: 'text', binding: { $entry: 'field.summary' } },
      { type: 'node.setBinding', owner, nodeId: cta, field: 'prop', prop: 'heading', binding: { $entry: 'field.crew' } },
      { type: 'node.setBinding', owner, nodeId: cta, field: 'prop', prop: 'primaryLink', binding: { $entry: 'field.website' } }
    );
    expect(errors(s)).toEqual([]);
    const page = materializeTemplate(s, s.collections.projects, s.collections.projects.entries.en_hall, entryNeighbours(s, 'projects', 'en_hall'));
    expect(page.nodes[date.id]).toMatchObject({ text: 'April 30, 2026', datetime: '2026-04-30' });
    expect(page.nodes[excerpt.id]).toMatchObject({ text: 'Ana Ruiz' });
    expect(page.rootIds.length).toBeGreaterThan(0);
    expect((page.nodes[body.id] as TextNode).text).toEqual(s.collections.projects.entries.en_hall.values.summary);
    expect((page.nodes[cta] as InstanceNode).props).toMatchObject({ heading: 'Ben Okafor, Ana Ruiz', primaryLink: { type: 'url', target: 'https://hall.example.com' } });
    const html = generateProject(publishedState(s)).get('src/routes/work/town-hall/+page.svelte')!;
    expect(html).toContain('<time datetime={"2026-04-30"}>{"April 30, 2026"}</time>');
    expect(html).toContain('Ana Ruiz');
    expect(html).toContain('https://hall.example.com');
    // Entry pages, no archive: nothing at the collection's own address.
    expect(routeFiles(s)).not.toContain('src/routes/work/+page.svelte');
    // An entry naming nobody leaves out what shows its crew.
    const nobody = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { crew: [] } });
    expect(materializeTemplate(nobody, nobody.collections.projects, nobody.collections.projects.entries.en_hall, {}).nodes[excerpt.id]).toBeDefined();
    expect(JSON.stringify(materializeTemplate(nobody, nobody.collections.projects, nobody.collections.projects.entries.en_hall, {}).rootIds)).not.toContain(excerpt.id);
    // A date's machine form is a date's alone; a list of entries equals no one value; one entry can be compared.
    expect(() => apply(s, [{ type: 'node.setBinding', owner, nodeId: date.id, field: 'datetime', binding: { $entry: 'field.lead' } }])).toThrow(/not a date/);
    expect(() => apply(s, [{ type: 'node.setBinding', owner, nodeId: excerpt.id, field: 'when', binding: { $entry: 'field.crew' }, eq: 'en_ruiz' }])).toThrow(/names several entries/);
    expect(() => apply(s, [{ type: 'node.setBinding', owner, nodeId: excerpt.id, field: 'when', binding: { $entry: 'field.lead' }, eq: 'en_ruiz' }])).not.toThrow();
  });

  it('refuses values a field does not take', () => {
    const s = studio();
    const set = (values: Record<string, unknown>) => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values }]);
    expect(() => set({ completed: '2026-02-30' })).toThrow(/not a calendar date/);
    expect(() => set({ lead: 'en_nobody' })).toThrow(/Team collection has no entry "en_nobody"/);
    expect(() => set({ lead: 'en_hall' })).toThrow(/Team collection has no entry "en_hall"/);
    expect(() => set({ lead: 'Ana' })).toThrow(/not an entry ID/);
    expect(() => set({ crew: ['en_ruiz', 'en_ruiz'] })).toThrow(/named twice/);
    expect(() => set({ crew: 'en_ruiz' })).toThrow(/list of entry IDs/);
    expect(() => set({ crew: Array.from({ length: 51 }, () => 'en_ruiz') })).toThrow(/at most 50/);
    expect(() => set({ summary: [{ type: 'h2', spans: [{ text: 'Heading' }] }] })).toThrow(/section headings \(h2\) can only be placed in a collection entry's text/);
    expect(() => set({ summary: [{ type: 'image', assetId: 'img_a', alt: '' }] })).toThrow(/pictures can only be placed in a collection entry's text/);
    // A link field may go to another entry, as the entry's text may.
    expect(set({ website: { type: 'entry', target: 'en_ruiz' } }).state.collections.projects.entries.en_hall.values.website).toEqual({ type: 'entry', target: 'en_ruiz' });
    // A reference names an existing collection (its own included, as it is created) and starts empty.
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'events', fields: { venue: { type: 'reference', label: 'Venue', collection: 'venues' } } }])).toThrow(/name the collection whose entries it refers to/);
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'events', fields: { host: { type: 'reference', label: 'Host', collection: 'team', default: 'en_ruiz' } } }])).toThrow(/its default is ""/);
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'events', fields: { when: { type: 'date', label: 'When', default: 'soon' } } }])).toThrow(/default must be a calendar date/);
    // A reference retargeted, or made a list, would read each entry's value differently: refused while one has one.
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'projects', fields: { ...s.collections.projects.settings.fields, lead: { type: 'reference', label: 'Lead', collection: 'projects' } } }])).toThrow(/value for Lead/);
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'projects', fields: { ...s.collections.projects.settings.fields, lead: { type: 'reference', label: 'Lead', collection: 'team', multiple: true } } }])).toThrow(/value for Lead/);
  });

  it('counts document links in link fields as uses, and repoints page links in fields when a page goes', () => {
    let s = studio();
    s.assets.assets.doc_a = { id: 'doc_a', name: 'Brochure', file: 'static/assets/doc-a-1a2b3c4d.pdf', mime: 'application/pdf', bytes: 10, hash: 'h', kind: 'document', createdAt: '2026-01-01T00:00:00.000Z' };
    s = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { website: { type: 'document', target: 'doc_a' } } });
    expect(() => apply(s, [{ type: 'asset.remove', assetId: 'doc_a' }])).toThrow(/linked/);
    const contact = pageAt(s, '/contact/');
    const about = pageAt(s, '/about/');
    const moved = run(s, { type: 'page.remove', pageId: contact.id, replacementPageId: about.id });
    expect(JSON.stringify(moved.collections.projects.entries.en_hall.values.summary)).toContain(`{"type":"page","target":"${about.id}"}`);
    expect(errors(moved)).toEqual([]);
    // Fields of other kinds are plain values, whatever they hold.
    const plain = run(s, { type: 'entry.update', collectionId: 'team', entryId: 'en_ruiz', values: { role: contact.id } });
    expect(run(plain, { type: 'page.remove', pageId: contact.id, replacementPageId: about.id }).collections.team.entries.en_ruiz.values.role).toBe(contact.id);
  });
});

describe('references when an entry goes', () => {
  it('refuses removing an entry another names until it names another entry of the collection, or none', () => {
    const s = studio();
    const refused = refusal(s, [{ type: 'entry.remove', collectionId: 'team', entryId: 'en_ruiz' }]);
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.message).toMatch(/2 references name “Ana Ruiz” \(in Town hall \(Projects\)\)\. Choose a replacement entry of Team/);
    expect(refused.details).toEqual({ references: 2 });
    const about = pageAt(s, '/about/');
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'team', entryId: 'en_ruiz', replacementPageId: about.id }])).toThrow(/Choose a replacement entry of Team/);
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'team', entryId: 'en_ruiz', replacementEntryId: 'en_hall' }])).toThrow(/only another entry of Team can take its place/);
    // Pointed at another member: once in a list already naming them, where they were.
    const r = apply(s, [{ type: 'entry.remove', collectionId: 'team', entryId: 'en_ruiz', replacementEntryId: 'en_okafor' }]);
    expect(r.results[0]).toMatchObject({ referencesRepointed: 2 });
    expect(r.state.collections.projects.entries.en_hall.values).toMatchObject({ lead: 'en_okafor', crew: ['en_okafor'] });
    expect(r.state.collections.team.entries).not.toHaveProperty('en_ruiz');
    expect(errors(r.state)).toEqual([]);
    // Cleared first, it goes.
    const cleared = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { lead: null, crew: [] } }, { type: 'entry.remove', collectionId: 'team', entryId: 'en_ruiz' });
    expect(cleared.collections.team.entries).not.toHaveProperty('en_ruiz');
    // An entry naming only itself goes with what it names.
    const self = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { related: ['en_hall'] } }, { type: 'entry.remove', collectionId: 'projects', entryId: 'en_hall' });
    expect(self.collections.projects.entries).toEqual({});
  });

  it('refuses removing a collection another collection’s reference field names, and reports one naming nothing', () => {
    const s = studio();
    expect(() => apply(s, [{ type: 'collection.remove', collectionId: 'team' }])).toThrow(/Lead of the Projects collection refers to entries of Team\. Remove that field first/);
    // Its own references go with it.
    expect(run(s, { type: 'collection.remove', collectionId: 'projects' }).collections).not.toHaveProperty('projects');
    const hand = structuredClone(s);
    hand.collections.projects.entries.en_hall.values.lead = 'en_gone';
    expect(validateState(hand).find((d) => d.code === 'FIELD_VALUE_INVALID')).toMatchObject({ severity: 'warning', message: expect.stringMatching(/Lead names "en_gone", which the Team collection has no entry for/) });
  });
});

describe('a synced collection', () => {
  const SOURCE: EntrySource = { sourceId: 'people-api', externalId: '42', syncedAt: '2026-11-01T10:00:00.000Z', contentHash: 'abc123' };
  /** The studio with its team synced from an external source (attached by a sync, as #676 will). */
  function synced(collectionId = 'team') {
    const s = studio();
    s.collections[collectionId].settings.sourceId = 'people-api';
    for (const e of Object.values(s.collections[collectionId].entries)) e.source = { ...SOURCE, externalId: e.id };
    return s;
  }

  it('refuses manual changes to its entries until it is detached', () => {
    const s = synced();
    expect(errors(s)).toEqual([]);
    for (const op of [
      { type: 'entry.create', collectionId: 'team', title: 'Cara' },
      { type: 'entry.update', collectionId: 'team', entryId: 'en_okafor', title: 'Ben O.' },
      { type: 'entry.remove', collectionId: 'team', entryId: 'en_okafor' }
    ] as EditOperation[]) {
      const refused = refusal(s, [op]);
      expect(refused.code, op.type).toBe('VALIDATION_FAILED');
      expect(refused.message, op.type).toMatch(/The Team collection is synced from an external source, so its entries are read-only here .* detach the collection/);
    }
    // Everything else stays editable, its settings included.
    expect(run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', title: 'Old town hall' }).collections.projects.entries.en_hall.title).toBe('Old town hall');
    expect(run(s, { type: 'entry.reorder', collectionId: 'team', entryIds: ['en_okafor', 'en_ruiz'] }).collections.team.settings.entryOrder).toEqual(['en_okafor', 'en_ruiz']);
    // Detached, in the same change: its entries are local again, each keeping where it came from.
    const local = run(s, { type: 'collection.update', collectionId: 'team', sourceId: null }, { type: 'entry.update', collectionId: 'team', entryId: 'en_okafor', title: 'Ben O.' });
    expect(local.collections.team.settings).not.toHaveProperty('sourceId');
    expect(local.collections.team.entries.en_okafor).toMatchObject({ title: 'Ben O.', source: { ...SOURCE, externalId: 'en_okafor' } });
    expect(run(local, { type: 'entry.create', collectionId: 'team', entryId: 'en_cara', title: 'Cara' }).collections.team.entries).toHaveProperty('en_cara');
    // Only detaching is an operation: a sync attaches.
    expect(validateOperation({ type: 'collection.update', collectionId: 'team', sourceId: 'other' })).not.toMatchObject({ ok: true });
  });

  it('refuses pointing its entries’ links or references elsewhere, as removing what they go to would', () => {
    const s = synced('projects');
    const contact = pageAt(s, '/contact/');
    const about = pageAt(s, '/about/');
    expect(() => apply(s, [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id }])).toThrow(/Town hall \(Projects\) links to "Contact".*synced from an external source/);
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'team', entryId: 'en_ruiz', replacementEntryId: 'en_okafor' }])).toThrow(/Town hall \(Projects\) links to “Ana Ruiz”.*synced/);
  });

  it('reports damaged provenance', () => {
    const s = synced();
    s.collections.team.entries.en_ruiz.source = { sourceId: 'people-api', externalId: '', syncedAt: 'yesterday', contentHash: 'abc' };
    s.collections.team.settings.sourceId = '  ';
    const found = validateState(s);
    expect(found.find((d) => d.code === 'ENTRY_SOURCE_INVALID')).toMatchObject({ severity: 'warning' });
    expect(found.find((d) => d.code === 'COLLECTION_INVALID')?.message).toMatch(/external source it is synced from is damaged/);
  });
});

describe('entry text', () => {
  it('is refused for records without it, and turned off only once every entry and the layout leave it', () => {
    const s = studio();
    expect(Object.keys(entryFieldSchemas(s.collections.team))).not.toEqual(expect.arrayContaining(['body']));
    expect(Object.keys(entryFieldSchemas(s.collections.team))).not.toContain('readingTime');
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'team', entryId: 'en_ruiz', body: ['A bio.'] }])).toThrow(/have no text of their own/);
    expect(run(s, { type: 'entry.update', collectionId: 'team', entryId: 'en_ruiz', body: [] }).collections.team.entries.en_ruiz.body).toEqual([]);
    const blog = run(site(), { type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring', body: ['Words.'] });
    expect(() => apply(blog, [{ type: 'collection.update', collectionId: 'posts', hasBody: false }])).toThrow(/“Spring” has text of its own/);
    const empty = run(blog, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [] });
    expect(() => apply(empty, [{ type: 'collection.update', collectionId: 'posts', hasBody: false }])).toThrow(/The Posts layout shows the entries' (text|reading time)\. Unbind it/);
  });
});

describe('the pages a collection asks for', () => {
  it('gives entry pages under a page’s own address when the collection has no archive there', () => {
    let s = run(site(), { type: 'page.create', pageId: 'pg_team', title: 'Team', route: '/team/' });
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'people', route: '/team/' }])).toThrow(/already the address of the page “Team”/);
    s = run(s, { type: 'collection.create', collectionId: 'people', kind: 'structured', route: '/team/', pages: { detail: true, archive: false } }, { type: 'entry.create', collectionId: 'people', entryId: 'en_jane', title: 'Jane', draft: false });
    expect(s.collections.people.entries.en_jane.slug).toBe('jane');
    expect(errors(s)).toEqual([]);
    expect(routeFiles(s)).toEqual(expect.arrayContaining(['src/routes/team/+page.svelte', 'src/routes/team/jane/+page.svelte']));
    expect(archivePages(s).filter((p) => p.collectionId === 'people')).toEqual([]);
    // Its archive would take the page's address.
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'people', pages: { detail: true, archive: true } }])).toThrow(/already the address of the page “Team”/);
  });

  it('keeps entry pages out of another collection’s archive folders, in either order', () => {
    const blog = run(site(), { type: 'collection.create', collectionId: 'posts' });
    expect(() => apply(blog, [{ type: 'collection.create', collectionId: 'notes', route: '/blog/page/', pages: { detail: true, archive: false } }])).toThrow(/kept for the Posts collection's archive pages/);
    const notes = run(site(), { type: 'collection.create', collectionId: 'notes', route: '/journal/page/', pages: { detail: true, archive: false } });
    expect(() => apply(notes, [{ type: 'collection.create', collectionId: 'posts', route: '/journal/' }])).toThrow(/kept for the collection's archive pages/);
    // Without an archive of its own, it reserves no folders.
    expect(() => apply(notes, [{ type: 'collection.create', collectionId: 'posts', route: '/journal/', pages: { detail: true, archive: false } }])).not.toThrow();
  });

  it('turns entry pages off, leaving links to them as their words until they are on again', () => {
    let s = studio();
    s = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { related: [] } });
    const blog = run(s, { type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_news', title: 'News', draft: false, body: ['See [the hall](entry:en_hall).'] });
    const off = run(blog, { type: 'collection.update', collectionId: 'projects', pages: { detail: false, archive: false } });
    expect(off.collections.projects.settings.route).toBe('/work/');
    expect(errors(off)).toEqual([]);
    expect(routeFiles(off).some((f) => f.startsWith('src/routes/work/'))).toBe(false);
    expect(resolveLink({ type: 'entry', target: 'en_hall' }, { state: off } as never)).toBeNull();
    const on = run(off, { type: 'collection.update', collectionId: 'projects', pages: { detail: true, archive: false } });
    expect(resolveLink({ type: 'entry', target: 'en_hall' }, { state: on } as never)).toEqual({ href: '/work/town-hall/' });
  });

  it('takes every new setting through the shared validator', () => {
    for (const op of [
      { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Member', hasBody: false, pages: { detail: false, archive: false } },
      { type: 'collection.update', collectionId: 'team', kind: 'editorial', singularName: null, hasBody: true, pages: { detail: true, archive: true }, sourceId: null, route: '/team/' },
      { type: 'entry.update', collectionId: 'team', entryId: 'en_ruiz', values: { lead: 'en_okafor', crew: ['en_ruiz'], completed: '2026-01-01' } }
    ])
      expect(validateOperation(op), op.type).toMatchObject({ ok: true });
    expect(validateOperation({ type: 'collection.create', collectionId: 'team', kind: 'gallery' })).not.toMatchObject({ ok: true });
    expect(validateOperation({ type: 'collection.create', collectionId: 'team', pages: { detail: false } })).not.toMatchObject({ ok: true });
  });
});
