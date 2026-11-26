/**
 * The assistant's collection schema, value and list tools, and a request sent while a collection's layout is open
 * (#679): a Team made, filled with the author's photos and shown on Home in one undoable turn; a layout edited without
 * touching the pages behind it; every new schema closed for a grammar-constrained model; and a synced collection's
 * entries refused with a clear read-only error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { AssetRecord, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { asksForCollection, executeTool, toolsForRun, type ToolHost } from '@agent/tools';
import { checkAuthority, requestAuthority, type Authority, type AuthorityGrants } from '@agent/scope';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { envelopeSchema } from '@agent/constrained';
import { layoutGlance, projectSummary } from '@agent/context';
import { collectionGrantRefusal } from '@shared/collection-grant';
import { ProjectSession } from '../../src/main/project/session';

const photo = (id: string, name: string): AssetRecord => ({ id, name, file: `static/assets/${name.toLowerCase()}-1a2b3c4d.jpg`, mime: 'image/jpeg', bytes: 10, width: 800, height: 1000, hash: id, kind: 'image', createdAt: '2026-01-01T00:00:00.000Z', description: `A portrait of ${name}`, altSuggestion: `${name} smiling` });
const ANA = photo('a_ana', 'Ana');
const BO = photo('a_bo', 'Bo');

/** The business starter with two portraits in Assets, as two files dropped on Chat leave it, and no collections. */
function studio(): ProjectState {
  const s = structuredClone(createStarterState('business', 'Riverside Studio', false));
  s.assets.assets[ANA.id] = ANA;
  s.assets.assets[BO.id] = BO;
  return s;
}

/** A Team with entry pages, a role field, a departments grouping and one member. */
function team(): ProjectState {
  return applyOperations(studio(), [
    {
      type: 'collection.create',
      collectionId: 'team',
      name: 'Team',
      singularName: 'Team member',
      kind: 'structured',
      pages: { detail: true, archive: false },
      route: '/team/',
      fields: { role: { type: 'string', label: 'Role' }, level: { type: 'enum', label: 'Level', options: [{ value: 'junior', label: 'Junior' }, { value: 'senior', label: 'Senior' }] } },
      taxonomies: { departments: { label: 'Departments', terms: { studio: { label: 'Studio' } } } }
    },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ana', title: 'Ana Ruiz', draft: false, values: { role: 'Potter', level: 'senior' }, terms: { departments: ['studio'] } }
  ] as EditOperation[]).state;
}

/** A host over a project in memory that holds each batch to the run's authority and its grant, as the session does. */
function host(start: ProjectState, authority: Authority = { kind: 'site' }) {
  let state = start;
  let revision = 1;
  const h: ToolHost = {
    state: () => state,
    revision: () => revision,
    diagnostics: () => [],
    apply: async (ops, expected, _label, _key, grants?: AuthorityGrants) => {
      if (expected !== revision) return { ok: false, revision, error: { code: 'STALE_REVISION', message: 'stale', recoverable: true } };
      const denied = checkAuthority(state, ops, authority, grants);
      if (denied) return { ok: false, revision, error: { code: 'SCOPE_MISMATCH', message: denied, recoverable: true } };
      const grant = authority.kind === 'template' ? ({ kind: 'layout', owner: authority.owner } as const) : grants?.collectionWrite;
      const touches = ops.some((o) => o.type.startsWith('collection.') || o.type.startsWith('entry.'));
      const refused = grant ? collectionGrantRefusal(ops, grant, state.collections) : touches ? 'no grant' : null;
      if (refused) return { ok: false, revision, error: { code: 'SCOPE_MISMATCH', message: refused, recoverable: true } };
      try {
        const r = applyOperations(state, ops);
        state = r.state;
        revision++;
        return { ok: true, revision, results: r.results };
      } catch (e) {
        return { ok: false, revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message, recoverable: true } };
      }
    },
    compileAll: async () => [],
    inspectLayout: async () => ({}),
    ask: async () => '',
    layoutLimit: () => (authority.kind === 'template' ? { owner: authority.owner, label: authority.label } : null)
  };
  return { h, now: () => state };
}

const tool = (h: ToolHost, name: string, args: unknown) => executeTool(name, JSON.stringify(args), h, `call_${name}`);
const homeGrid = (s: ProjectState) => s.pages[s.site.homePageId].rootIds[2];
const constrained = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
const native = { toolCalling: 'native' as const, contextWindowTokens: 100000 };

describe('define_collection', () => {
  it('creates a structured collection with custom fields and groupings, and refuses a mistyped action', async () => {
    const { h, now } = host(studio());
    const made = await tool(h, 'define_collection', {
      action: 'create',
      collectionId: 'team',
      name: 'Team',
      singularName: 'Team member',
      kind: 'structured',
      pages: { detail: false, archive: false },
      fields: [{ name: 'role', type: 'string', label: 'Role' }, { name: 'photo', type: 'image', label: 'Photo' }, { name: 'level', type: 'enum', options: ['Junior', 'Senior'] }],
      taxonomies: [{ id: 'departments', label: 'Departments' }]
    });
    expect(made.ok, JSON.stringify(made.content)).toBe(true);
    const settings = now().collections.team.settings;
    expect(settings).toMatchObject({ name: 'Team', singularName: 'Team member', kind: 'structured', pages: { detail: false, archive: false }, taxonomies: { departments: { label: 'Departments', terms: {} } } });
    expect(Object.keys(settings.fields)).toEqual(['role', 'photo', 'level']);
    expect(settings.fields.level).toMatchObject({ type: 'enum', options: [{ value: 'Junior', label: 'Junior' }, { value: 'Senior', label: 'Senior' }] });
    // The collection's own summary now says what each entry fills in.
    expect(projectSummary(now(), 1).collections).toContainEqual(expect.objectContaining({ id: 'team', kind: 'structured', singularName: 'Team member', pages: { detail: false, archive: false }, fields: [{ name: 'role', type: 'string', label: 'Role' }, { name: 'photo', type: 'image', label: 'Photo' }, { name: 'level', type: 'enum', label: 'level', options: ['Junior', 'Senior'] }] }));
    // Creating one that exists, or updating one that does not, is refused rather than taken for the other.
    expect((await tool(h, 'define_collection', { action: 'create', collectionId: 'team', name: 'Again' })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/already a collection "team": use action "update"/) } });
    expect((await tool(h, 'define_collection', { action: 'update', collectionId: 'staff', name: 'Staff' })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/no collection "staff"\. Collections: team/) } });
    expect((await tool(h, 'define_collection', { action: 'create', collectionId: 'Team Members' })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/is not a collection ID/) } });
    expect((await tool(h, 'define_collection', { action: 'rename', collectionId: 'team', name: 'Staff' })).content).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect((await tool(h, 'define_collection', { action: 'update', collectionId: 'team', taxonomies: [{ id: 'skills', label: 'Skills' }, { id: 'skills', label: 'Abilities' }] })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/“skills” is listed twice/) } });
    expect(now().collections.team.settings.name).toBe('Team');
  });

  it('only adds and relabels on update: every field, option, grouping, term and entry value stays', async () => {
    const start = team();
    const { h, now } = host(start);
    const r = await tool(h, 'define_collection', {
      action: 'update',
      collectionId: 'team',
      fields: [{ name: 'level', type: 'enum', label: 'Seniority', options: ['lead'] }, { name: 'photo', type: 'image', label: 'Photo' }],
      taxonomies: [{ id: 'departments', label: 'Teams' }, { id: 'skills', label: 'Skills' }]
    });
    expect(r.ok, JSON.stringify(r.content)).toBe(true);
    const s = now().collections.team.settings;
    expect(Object.keys(s.fields)).toEqual(['role', 'level', 'photo']);
    expect(s.fields.role).toEqual(start.collections.team.settings.fields.role);
    expect(s.fields.level).toMatchObject({ label: 'Seniority', options: [{ value: 'junior' }, { value: 'senior' }, { value: 'lead' }] });
    expect(s.taxonomies).toEqual({ departments: { label: 'Teams', terms: { studio: { label: 'Studio' } } }, skills: { label: 'Skills', terms: {} } });
    expect(now().collections.team.entries.en_ana).toMatchObject({ values: { role: 'Potter', level: 'senior' }, terms: { departments: ['studio'] } });
    // A field keeps its type, and a field or grouping listed twice is refused, applying nothing.
    const after = now();
    expect((await tool(h, 'define_collection', { action: 'update', collectionId: 'team', fields: [{ name: 'role', type: 'number' }] })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/“role” is a string field, and its type stays/) } });
    expect((await tool(h, 'define_collection', { action: 'update', collectionId: 'team', fields: [{ name: 'bio', type: 'string' }, { name: 'bio', type: 'richtext' }] })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/“bio” is listed twice/) } });
    expect(now()).toBe(after);
  });

  it('is held by the project to one collection, never losing a field, option or term, nor detaching a source', () => {
    const s = team();
    const grant = { kind: 'schema' as const, collectionId: 'team', action: 'update' as const };
    const fields = s.collections.team.settings.fields as unknown as Record<string, Record<string, unknown>>;
    const update = (extra: Record<string, unknown>) => [{ type: 'collection.update', collectionId: 'team', ...extra }] as EditOperation[];
    expect(collectionGrantRefusal(update({ fields: { ...fields, bio: { type: 'string', label: 'Bio' } } }), grant, s.collections)).toBeNull();
    expect(collectionGrantRefusal(update({ fields: { level: fields.level } }), grant, s.collections)).toMatch(/never removes a field: Team would lose “role”/);
    expect(collectionGrantRefusal(update({ fields: { ...fields, level: { ...fields.level, options: [{ value: 'junior', label: 'Junior' }] } } }), grant, s.collections)).toMatch(/never removes or changes a choice of “level”/);
    expect(collectionGrantRefusal(update({ taxonomies: { departments: { label: 'Departments', terms: {} } } }), grant, s.collections)).toMatch(/never removes a term: “departments” would lose “studio”/);
    expect(collectionGrantRefusal(update({ fields: { ...fields, role: { type: 'number', label: 'Role' } } }), grant, s.collections)).toMatch(/never changes a field’s type: “role” is string/);
    expect(collectionGrantRefusal(update({ fields: { ...fields, role: { ...fields.role, default: 'Potter' } } }), grant, s.collections)).toMatch(/changes no more of “role” than its label and new choices/);
    expect(collectionGrantRefusal(update({ fields: { ...fields, role: { ...fields.role, label: 'Job' }, level: { ...fields.level, options: [...(fields.level.options as unknown[]), { value: 'lead', label: 'Lead' }] } } }), grant, s.collections)).toBeNull();
    expect(collectionGrantRefusal(update({ taxonomies: { departments: { label: 'Departments', terms: { studio: { label: 'Workshop' } } } } }), grant, s.collections)).toMatch(/never renames a term: “studio” of “departments” is “Studio”/);
    expect(collectionGrantRefusal(update({ sourceId: null }), grant, s.collections)).toMatch(/never detaches a collection from its source/);
    expect(collectionGrantRefusal([...update({ name: 'Staff' }), { type: 'site.update', name: 'Other' } as EditOperation], grant, s.collections)).toMatch(/only the one collection/);
    expect(collectionGrantRefusal([{ type: 'collection.create', collectionId: 'team' }] as EditOperation[], grant, s.collections)).toMatch(/only the one collection/);
  });
});

describe('upsert_collection_entry with custom fields and groupings', () => {
  it('writes custom values by their field type and files the entry under any grouping, adding the terms it lacks', async () => {
    const { h, now } = host(team());
    const r = await tool(h, 'upsert_collection_entry', {
      collectionId: 'team',
      title: 'Bo Chen',
      draft: false,
      featuredImage: BO.id,
      values: [{ field: 'role', value: 'Glaze chemist' }, { field: 'level', value: 'junior' }],
      terms: [{ taxonomyId: 'departments', names: ['Studio', 'Lab'] }]
    });
    expect(r.ok, JSON.stringify(r.content)).toBe(true);
    expect(r.content).toMatchObject({ ok: true, addedTerms: { departments: ['Lab'] } });
    const bo = Object.values(now().collections.team.entries).find((e) => e.title === 'Bo Chen')!;
    expect(bo).toMatchObject({ draft: false, featuredImage: BO.id, values: { role: 'Glaze chemist', level: 'junior' }, terms: { departments: ['studio', 'lab'] } });
    // Read back as it is written, with every field it can fill in, so a run limited to it can name them.
    const read = await tool(h, 'read_collection_entry', { collectionId: 'team', entryId: bo.id });
    expect(read.content).toMatchObject({ featuredImage: BO.id, terms: [{ taxonomyId: 'departments', names: ['Studio', 'Lab'] }], values: [{ field: 'role', value: 'Glaze chemist' }, { field: 'level', value: 'junior' }], fields: [{ name: 'role', type: 'string' }, { name: 'level', type: 'enum' }] });
  });

  it('refuses a value of the wrong kind, a field or grouping the collection lacks, and categories sent as terms, applying nothing', async () => {
    const { h, now } = host(team());
    const before = now();
    const bad = async (args: Record<string, unknown>, message: RegExp) => {
      const r = await tool(h, 'upsert_collection_entry', { collectionId: 'team', entryId: 'en_ana', ...args });
      expect(r.content, JSON.stringify(args)).toMatchObject({ ok: false, error: { message: expect.stringMatching(message) } });
    };
    await bad({ values: [{ field: 'role', value: 3 }] }, /“role” is a string field: send text/);
    await bad({ values: [{ field: 'level', value: true }] }, /send one of its options \(junior, senior\)/);
    await bad({ values: [{ field: 'level', value: 'principal' }] }, /must be one of junior, senior/);
    await bad({ values: [{ field: 'nickname', value: 'A' }] }, /has no field "nickname"\. Its fields: role, level/);
    await bad({ terms: [{ taxonomyId: 'skills', names: ['Throwing'] }] }, /has no grouping "skills"/);
    await bad({ terms: [{ taxonomyId: 'categories', names: ['News'] }] }, /categories are sent as categories, by name/);
    await bad({ featuredImage: 'a_missing' }, /not in the library/);
    await bad({ values: [{ field: 'role', value: 'Potter' }, { field: 'role', value: 'Glazer' }] }, /“role” is given twice/);
    expect(now()).toBe(before);
    // Clearing categories or tags the collection does not have yet changes nothing, and is no error.
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'team', entryId: 'en_ana', categories: [], terms: [{ taxonomyId: 'tags', names: [] }], values: [{ field: 'role', value: 'Kiln lead' }] })).ok).toBe(true);
    expect(now().collections.team.entries.en_ana).toMatchObject({ values: { role: 'Kiln lead' }, terms: { departments: ['studio'] } });
  });

  it('writes every kind of custom value, and reads long text and links back as they can be written', async () => {
    const s = applyOperations(team(), [
      { type: 'collection.update', collectionId: 'team', fields: { ...structuredClone(team().collections.team.settings.fields), active: { type: 'boolean', label: 'Active', default: true }, bio: { type: 'string', label: 'Bio', multiline: true }, story: { type: 'richtext', label: 'Story' }, site: { type: 'link', label: 'Website' }, photo: { type: 'image', label: 'Photo' } } }
    ] as EditOperation[]).state;
    const { h, now } = host(s);
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    const bio = `${'Thrown by hand. '.repeat(60)}The end.`;
    // Longer than one part of a read, so reading it whole takes the offsets the reads return.
    const story = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: ${'clay and glaze '.repeat(14)}`.trim());
    const r = await tool(h, 'upsert_collection_entry', { collectionId: 'team', entryId: 'en_ana', values: [{ field: 'active', value: false }, { field: 'bio', value: bio }, { field: 'story', value: story }, { field: 'site', value: `${about.route}#team` }, { field: 'photo', value: ANA.id }] });
    expect(r.ok, JSON.stringify(r.content)).toBe(true);
    expect(now().collections.team.entries.en_ana.values).toMatchObject({ active: false, bio, site: { type: 'page', target: about.id, anchor: 'team' }, photo: { assetId: ANA.id, alt: 'Ana smiling' } });
    const read = (await tool(h, 'read_collection_entry', { collectionId: 'team', entryId: 'en_ana' })).content as unknown as { values: Array<{ field: string; value: unknown; clipped?: true; editorOnly?: true }> };
    const shown = Object.fromEntries(read.values.map((v) => [v.field, v]));
    expect(shown.active.value).toBe(false);
    expect(shown.site.value).toBe(`${about.route}#team`);
    expect(shown.photo.value).toBe(ANA.id);
    expect(shown.bio).toMatchObject({ clipped: true });
    expect(shown.story).toMatchObject({ clipped: true });
    // Read whole with field, a part at a time.
    const readWhole = async (field: string) => {
      let whole = '';
      let parts = 0;
      for (let offset: number | null = 0; offset !== null && parts < 10; parts++) {
        const part = (await tool(h, 'read_collection_entry', { collectionId: 'team', entryId: 'en_ana', field, offset })).content as unknown as { text: string; next: number | null };
        whole += part.text;
        offset = part.next;
      }
      return { whole, parts };
    };
    expect((await readWhole('bio')).whole).toBe(bio);
    const told = await readWhole('story');
    expect(told.parts).toBeGreaterThan(1);
    expect(told.whole).toBe(story.join('\n\n'));
    // A link this tool cannot write as it is (one opening in a new tab) is the editor's: read as such, never as a bare address.
    const tab = structuredClone(now());
    tab.collections.team.entries.en_ana.values.site = { type: 'url', target: 'https://example.com', newTab: true };
    const { h: h2 } = host(tab);
    const again = (await tool(h2, 'read_collection_entry', { collectionId: 'team', entryId: 'en_ana' })).content as unknown as { values: Array<{ field: string; value: unknown; editorOnly?: true }> };
    expect(again.values.find((v) => v.field === 'site')).toEqual({ field: 'site', value: null, editorOnly: true });
    // A picture with the author's own alt text, sent back as read, keeps it; "" empties the field.
    const alt = structuredClone(now());
    alt.collections.team.entries.en_ana.values.photo = { assetId: ANA.id, alt: 'Ana at the wheel', decorative: false };
    const { h: h4, now: now4 } = host(alt);
    expect((await tool(h4, 'upsert_collection_entry', { collectionId: 'team', entryId: 'en_ana', values: [{ field: 'photo', value: ANA.id }, { field: 'role', value: 'Thrower' }] })).ok).toBe(true);
    expect(now4().collections.team.entries.en_ana.values.photo).toMatchObject({ assetId: ANA.id, alt: 'Ana at the wheel' });
    expect((await tool(h4, 'upsert_collection_entry', { collectionId: 'team', entryId: 'en_ana', values: [{ field: 'photo', value: '' }] })).ok).toBe(true);
    expect(now4().collections.team.entries.en_ana.values.photo).toMatchObject({ assetId: null });
    expect(((await tool(h4, 'read_collection_entry', { collectionId: 'team', entryId: 'en_ana' })).content as unknown as { values: Array<{ field: string; value: unknown }> }).values.find((v) => v.field === 'photo')?.value).toBe('');
    // Any other field is read whole with field too.
    expect((await tool(h4, 'read_collection_entry', { collectionId: 'team', entryId: 'en_ana', field: 'active' })).content).toMatchObject({ ok: true, field: 'active', type: 'boolean', value: false });
    // Rich text sent as one Markdown string reads as its blocks, as the field writes them back.
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'team', entryId: 'en_ana', values: [{ field: 'story', value: 'Early days.\n\nFirst **kiln**.\n\n- Clay\n- Glaze' }] })).ok).toBe(true);
    expect((now().collections.team.entries.en_ana.values.story as Array<{ type: string }>).map((b) => b.type)).toEqual(['p', 'p', 'ul']);
  });

  it('returns a clear read-only error for a synced collection, before anything is planned', async () => {
    const synced = structuredClone(team());
    synced.collections.team.settings.sourceId = 'airtable';
    const { h, now } = host(synced);
    for (const args of [
      { collectionId: 'team', entryId: 'en_ana', values: [{ field: 'role', value: 'Kiln lead' }] },
      { collectionId: 'team', title: 'New member', terms: [{ taxonomyId: 'departments', names: ['Lab'] }] }
    ]) {
      const r = await tool(h, 'upsert_collection_entry', args);
      expect(r.content).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/The Team collection is synced from an external source, so its entries and settings are read-only here\. The author can detach it/) } });
    }
    const d = await tool(h, 'define_collection', { action: 'update', collectionId: 'team', name: 'Staff' });
    expect(d.content).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/synced from an external source/) } });
    expect(now()).toBe(synced);
    // The project holds an entry grant to the same rule.
    expect(collectionGrantRefusal([{ type: 'entry.update', collectionId: 'team', entryId: 'en_ana', title: 'X' }] as EditOperation[], { kind: 'entry', collectionId: 'team', entryId: 'en_ana' }, synced.collections)).toMatch(/read-only/);
    // read_project says so before any write is tried.
    expect(projectSummary(synced, 1).collections).toContainEqual(expect.objectContaining({ id: 'team', sourceId: 'airtable', readOnly: true }));
  });

  it('matches each new term to the grouping the entry is filed under it in', () => {
    const s = team();
    const grant = { kind: 'entry' as const, collectionId: 'team', entryId: 'en_ana' };
    const term = { type: 'collection.createTerm', collectionId: 'team', taxonomyId: 'departments', label: 'Lab', termId: 'lab' };
    expect(collectionGrantRefusal([term, { type: 'entry.update', collectionId: 'team', entryId: 'en_ana', terms: { departments: ['lab'] } }] as EditOperation[], grant, s.collections)).toBeNull();
    // Made in one grouping and filed in another: a term the entry was never filed under.
    expect(collectionGrantRefusal([term, { type: 'entry.update', collectionId: 'team', entryId: 'en_ana', terms: { tags: ['lab'] } }] as EditOperation[], grant, s.collections)).toMatch(/adds a term only to file the entry under it/);
  });
});

describe('connect_collection_list', () => {
  it("connects a placed section's list to a collection, and is the assistant's only way to do it", async () => {
    const { h, now } = host(team());
    const owner = { kind: 'page', id: now().site.homePageId };
    const r = await tool(h, 'connect_collection_list', { owner, nodeId: homeGrid(now()), prop: 'items', query: { collectionId: 'team', sort: [{ field: 'title' }], limit: 6 }, fields: [{ itemField: 'title', entryField: 'title' }, { itemField: 'description', entryField: 'field.role' }] });
    expect(r.ok, JSON.stringify(r.content)).toBe(true);
    const grid = now().pages[now().site.homePageId].nodes[homeGrid(now())] as InstanceNode;
    expect(grid.listSources?.items).toMatchObject({ query: { collectionId: 'team', sort: [{ field: 'title' }], limit: 6 }, fields: { title: 'title', description: 'field.role' } });
    // A field mapped twice, a section without the list named, or a missing node: refused with what to send.
    expect((await tool(h, 'connect_collection_list', { owner, nodeId: homeGrid(now()), prop: 'items', query: { collectionId: 'team' }, fields: [{ itemField: 'title', entryField: 'title' }, { itemField: 'title', entryField: 'field.role' }] })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/“title” is filled twice/) } });
    expect((await tool(h, 'connect_collection_list', { owner, nodeId: homeGrid(now()), query: { collectionId: 'team' } })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/name the list property to connect/) } });
    // Disconnecting shows its own items again.
    expect((await tool(h, 'connect_collection_list', { owner, nodeId: homeGrid(now()), prop: 'items', disconnect: true })).ok).toBe(true);
    expect((now().pages[now().site.homePageId].nodes[homeGrid(now())] as InstanceNode).listSources).toBeUndefined();
    // The raw operations are not offered, and refused if sent anyway.
    const raw = await tool(h, 'apply_operations', { expectedRevision: h.revision(), operations: [{ type: 'instance.setListSource', owner, nodeId: homeGrid(now()), prop: 'items', source: null }] });
    expect(raw.content).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringMatching(/connect_collection_list/) } });
    const site = toolsForRun({ state: now(), selection: null, capabilities: native, codeEnabled: false, definitionOps: true });
    const ops = JSON.stringify(site.tools.find((t) => t.name === 'apply_operations')!.parameters);
    expect(ops).not.toContain('instance.setListSource');
    expect(ops).not.toContain('node.setRepeatSource');
    // A whole placement selected on a page connects its own list; a part of it never offers it.
    const selected = toolsForRun({ state: now(), selection: { owner: owner as never, nodeId: homeGrid(now()) }, capabilities: native, codeEnabled: false, definitionOps: false, selectionPart: false });
    expect(selected.tools.map((t) => t.name)).toContain('connect_collection_list');
    expect(toolsForRun({ state: now(), selection: { owner: owner as never, nodeId: homeGrid(now()) }, capabilities: native, codeEnabled: false, definitionOps: false, selectionPart: true }).tools.map((t) => t.name)).not.toContain('connect_collection_list');
  });

  it("changes which entries a collection loop repeats, and returns an index loop to the index page's own", async () => {
    const s = applyOperations(team(), [{ type: 'collection.update', collectionId: 'team', pages: { detail: true, archive: true }, archiveTemplate: 'start' }] as EditOperation[]).state;
    const owner = { kind: 'archive' as const, id: 'team' };
    const tree = s.collections.team.settings.archiveTemplate!;
    const loop = Object.values(tree.nodes).find((n) => n.kind === 'repeat')!.id;
    const { h, now } = host(s, { kind: 'template', owner, label: 'the Team index layout' });
    const queried = await tool(h, 'connect_collection_list', { owner, nodeId: loop, query: { collectionId: '$current', sort: [{ field: 'title' }] } });
    expect(queried.ok, JSON.stringify(queried.content)).toBe(true);
    expect(now().collections.team.settings.archiveTemplate!.nodes[loop]).toMatchObject({ list: { $query: { collectionId: '$current', sort: [{ field: 'title' }] } } });
    // A loop's elements show its rows themselves: no list or field mapping is taken.
    expect((await tool(h, 'connect_collection_list', { owner, nodeId: loop, prop: 'items', query: { collectionId: 'team' } })).content).toMatchObject({ ok: false, error: { message: expect.stringMatching(/is a collection loop/) } });
    expect((await tool(h, 'connect_collection_list', { owner, nodeId: loop, archivePage: true })).ok).toBe(true);
    expect(now().collections.team.settings.archiveTemplate!.nodes[loop]).toMatchObject({ list: { $archive: true } });
    // Pinned to the layout: another owner is refused before anything is planned.
    expect((await tool(h, 'connect_collection_list', { owner: { kind: 'template', id: 'team' }, nodeId: loop, archivePage: true })).content).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
  });
});

describe('the schemas a grammar-constrained model is offered', () => {
  it('are closed and plain for every new tool, wherever each is offered, and inside the envelope the local model answers in', () => {
    const s = team();
    const runs = [
      toolsForRun({ state: studio(), selection: null, capabilities: native, codeEnabled: false, definitionOps: true }),
      toolsForRun({ state: s, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, collectionRequest: true }),
      toolsForRun({ state: s, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, page: { route: '/' }, collectionRequest: true }),
      toolsForRun({ state: s, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, layout: { owner: { kind: 'template', id: 'team' } } }),
      toolsForRun({ state: s, selection: null, capabilities: native, codeEnabled: false, definitionOps: false, layout: { owner: { kind: 'template', id: 'team' } } })
    ];
    const names = new Set(runs.flatMap((r) => r.tools.map((t) => t.name)));
    for (const n of ['define_collection', 'connect_collection_list', 'upsert_collection_entry', 'read_layout']) expect(names, n).toContain(n);
    expect(runs.map((r) => [r.mode, r.focused])).toEqual([['site', false], ['site', true], ['page', true], ['layout', true], ['layout', false]]);
    for (const run of runs) {
      for (const t of run.tools.filter((x) => ['define_collection', 'connect_collection_list', 'upsert_collection_entry', 'read_collection_entry', 'read_layout'].includes(x.name))) {
        const strict = toStrictSchema(t.parameters);
        expect(findForbiddenShapes(strict), t.name).toEqual([]);
        expect(JSON.stringify(strict), t.name).not.toContain('$json');
        expect(t.brief, t.name).toBeTruthy();
      }
      if (run.focused) for (const compact of [false, true]) expect(findForbiddenShapes(envelopeSchema(run.tools, { compact })), `${run.mode} envelope`).toEqual([]);
    }
    // The index layout's and a question's constrained runs too.
    for (const extra of [
      toolsForRun({ state: s, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, layout: { owner: { kind: 'archive', id: 'team' } } }),
      toolsForRun({ state: s, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, ask: true, layout: { owner: { kind: 'template', id: 'team' } } })
    ]) {
      expect(extra.tools.map((t) => t.name)).toContain('read_layout');
      for (const compact of [false, true]) expect(findForbiddenShapes(envelopeSchema(extra.tools, { compact })), `${extra.mode} envelope`).toEqual([]);
    }
    // A small model's site run keeps its window for pages unless the request asks for a collection, in so many words or
    // by naming one the project has.
    const plain = toolsForRun({ state: s, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false });
    expect(plain.tools.map((t) => t.name)).not.toContain('define_collection');
    expect(asksForCollection('Add a Role field to Team', s)).toBe(true);
    expect(asksForCollection('Show our team members on Home')).toBe(true);
    expect(asksForCollection('Make the hero teal', s)).toBe(false);
    expect(asksForCollection('Add a Role field to Team')).toBe(false);
    // Names in scripts written without spaces, and composed the other way, are found too.
    const named = { collections: { team: { settings: { name: 'チーム' } }, cafe: { settings: { name: 'Caf\u00e9' } } } } as unknown as ProjectState;
    expect(asksForCollection('チームに役割を追加して', named)).toBe(true);
    expect(asksForCollection('Show the Cafe\u0301 menu', named)).toBe(true);
    // A page run connects lists on its own page alone.
    const page = runs[2].tools.find((t) => t.name === 'connect_collection_list')!.parameters as { properties: { owner: { properties: { id: { enum: string[] } } } } };
    expect(page.properties.owner.properties.id.enum).toEqual([s.site.homePageId]);
  });
});

describe('a request sent while a collection layout is open', () => {
  it('is limited to that layout: entry bindings are offered there alone, and nothing reaches a page or the other layout', async () => {
    const s = team();
    const authority = requestAuthority({ pageId: s.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, template: { collectionId: 'team', name: 'Team' } }, s);
    expect(authority).toEqual({ kind: 'template', owner: { kind: 'template', id: 'team' }, label: 'the Team layout' });
    const run = toolsForRun({ state: s, selection: null, capabilities: native, codeEnabled: false, definitionOps: false, layout: { owner: { kind: 'template', id: 'team' } } });
    expect(run.mode).toBe('layout');
    const names = run.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_layout', 'inspect_element', 'apply_operations', 'connect_collection_list', 'request_clarification']));
    for (const n of ['upsert_page_with_sections', 'read_page', 'upsert_collection_entry', 'define_collection', 'update_site_brand']) expect(names).not.toContain(n);
    expect(JSON.stringify(run.tools.find((t) => t.name === 'apply_operations')!.parameters)).toContain('"$entry"');
    expect(JSON.stringify(run.tools.find((t) => t.name === 'request_clarification')!.parameters)).not.toContain('widenScope');
    // The index layout's elements show their loop's rows, never one entry; a general run is never offered $entry.
    const index = toolsForRun({ state: s, selection: null, capabilities: native, codeEnabled: false, definitionOps: false, layout: { owner: { kind: 'archive', id: 'team' } } });
    expect(JSON.stringify(index.tools.find((t) => t.name === 'apply_operations')!.parameters)).not.toContain('"$entry"');
    expect(JSON.stringify(toolsForRun({ state: s, selection: null, capabilities: native, codeEnabled: false, definitionOps: true }).tools.find((t) => t.name === 'apply_operations')!.parameters)).not.toContain('"$entry"');

    const { h, now } = host(s, authority);
    const owner = { kind: 'template', id: 'team' };
    const added = await tool(h, 'apply_operations', { expectedRevision: h.revision(), operations: [{ type: 'node.insert', owner, primitive: 'paragraph', text: 'Role' }] });
    expect(added.ok, JSON.stringify(added.content)).toBe(true);
    const nodeId = (added.results?.[0] as { nodeId: string }).nodeId;
    const bound = await tool(h, 'apply_operations', { expectedRevision: h.revision(), operations: [{ type: 'node.setBinding', owner, nodeId, field: 'text', binding: { $entry: 'field.role' } }] });
    expect(bound.ok, JSON.stringify(bound.content)).toBe(true);
    expect(now().collections.team.settings.template.nodes[nodeId]).toMatchObject({ text: { $entry: 'field.role' } });
    expect(now().pages).toEqual(s.pages);
    // A batch that edits the layout and then a page, or reads the page through inspect_element, is refused whole.
    const at = now();
    const home = s.pages[s.site.homePageId];
    const mixed = await tool(h, 'apply_operations', { expectedRevision: h.revision(), operations: [{ type: 'node.setContent', owner, nodeId, field: 'anchor', value: 'role' }, { type: 'node.setContent', owner: { kind: 'page', id: home.id }, nodeId: home.rootIds[0], field: 'anchor', value: 'top' }] });
    expect(mixed.content).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/outside the Team layout/) } });
    expect(now()).toBe(at);
    expect((await tool(h, 'inspect_element', { owner: { kind: 'page', id: home.id }, nodeId: home.rootIds[0] })).content).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    expect((await tool(h, 'read_layout', {})).content).toMatchObject({ ok: true, owner, collectionId: 'team' });
  });

  it('is held by the project to that one layout, whatever the batch names', () => {
    const s = team();
    const grant = { kind: 'layout' as const, owner: { kind: 'template' as const, id: 'team' } };
    const tpl = s.collections.team.settings.template;
    const node = tpl.rootIds[0];
    const home = s.pages[s.site.homePageId];
    const edit = (owner: unknown, nodeId = node) => ({ type: 'node.setContent', owner, nodeId, field: 'anchor', value: 'x' }) as EditOperation;
    expect(collectionGrantRefusal([edit({ kind: 'template', id: 'team' })], grant)).toBeNull();
    expect(collectionGrantRefusal([edit({ kind: 'page', id: home.id }, home.rootIds[0])], grant)).toMatch(/outside the layout/);
    expect(collectionGrantRefusal([edit({ kind: 'template', id: 'team' }), edit({ kind: 'archive', id: 'team' })], grant)).toMatch(/outside the layout/);
    expect(collectionGrantRefusal([edit({ kind: 'template', id: 'team' }), { type: 'site.update', name: 'Other' } as EditOperation], grant)).toMatch(/outside the layout/);
    expect(collectionGrantRefusal([{ type: 'entry.update', collectionId: 'team', entryId: 'en_ana', title: 'X' } as EditOperation], grant)).toMatch(/changes the collection itself/);
    // Only what an operation targets counts: a page's sharing image among an image's uses, a new component made from a
    // placement, and another collection's layout are refused; a value that merely reads like an owner is not.
    expect(collectionGrantRefusal([{ type: 'asset.replace', assetId: 'a_ana', replacementId: 'a_bo', uses: [{ kind: 'node', owner: { kind: 'template', id: 'team' }, nodeId: node, path: ['image'] }, { kind: 'pageSharing', pageId: home.id }] } as unknown as EditOperation], grant)).toMatch(/outside the layout/);
    expect(collectionGrantRefusal([{ type: 'component.makeUnique', owner: { kind: 'template', id: 'team' }, nodeId: node } as unknown as EditOperation], grant)).toMatch(/outside the layout/);
    expect(collectionGrantRefusal([edit({ kind: 'template', id: 'posts' })], grant)).toMatch(/outside the layout/);
    expect(collectionGrantRefusal([{ type: 'instance.setProp', owner: { kind: 'template', id: 'team' }, nodeId: node, prop: 'items', value: [{ id: 'i_1', kind: 'page', title: 'x' }] } as unknown as EditOperation], grant)).toBeNull();
  });

  it('is refused by the project itself: a granted batch that also reaches a page, and a synced entry, change nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-layout-grant-'));
    try {
      const start = team();
      start.collections.posts = structuredClone(start.collections.team);
      start.collections.posts.settings = { ...start.collections.posts.settings, id: 'posts', name: 'Posts', route: '/blog/' };
      start.collections.posts.entries = {};
      const session = await ProjectSession.create(dir, start);
      const before = structuredClone(session.state);
      const revision = session.revision;
      const tpl = session.state.collections.team.settings.template;
      const home = session.state.pages[session.state.site.homePageId];
      const ai = { label: 'AI', source: 'ai' as const, collectionWrite: { kind: 'layout' as const, owner: { kind: 'template' as const, id: 'team' } } };
      const mixed = await session.apply({ operations: [{ type: 'node.setContent', owner: { kind: 'template', id: 'team' }, nodeId: tpl.rootIds[0], field: 'anchor', value: 'top' }, { type: 'node.setContent', owner: { kind: 'page', id: home.id }, nodeId: home.rootIds[0], field: 'anchor', value: 'top' }] as EditOperation[] }, ai);
      expect(mixed).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      const other = await session.apply({ operations: [{ type: 'node.setContent', owner: { kind: 'template', id: 'posts' }, nodeId: session.state.collections.posts.settings.template.rootIds[0], field: 'anchor', value: 'top' }] as EditOperation[] }, ai);
      expect(other).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      // A layout edit without the grant is refused as before.
      expect(await session.apply({ operations: [{ type: 'node.setContent', owner: { kind: 'template', id: 'team' }, nodeId: tpl.rootIds[0], field: 'anchor', value: 'top' }] as EditOperation[] }, { label: 'AI', source: 'ai' })).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      expect(session.revision).toBe(revision);
      expect(session.state.pages).toEqual(before.pages);
      expect(session.state.collections).toEqual(before.collections);
      await session.close();
      // A synced collection's entry, written with the entry tool's grant, is refused as read-only by the project.
      const synced = structuredClone(team());
      synced.collections.team.settings.sourceId = 'airtable';
      const dir2 = mkdtempSync(join(tmpdir(), 'so-synced-grant-'));
      try {
        const s2 = await ProjectSession.create(dir2, synced);
        const r = await s2.apply({ operations: [{ type: 'entry.update', collectionId: 'team', entryId: 'en_ana', title: 'By the AI' }] as EditOperation[] }, { label: 'AI', source: 'ai', collectionWrite: { kind: 'entry', collectionId: 'team', entryId: 'en_ana' } });
        expect(r).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/synced from an external source.*read-only/) } });
        expect(s2.state.collections.team.entries.en_ana.title).toBe('Ana Ruiz');
        await s2.close();
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a layout too long for the window by its sections, which read_layout reads whole', () => {
    const s = team();
    const owner = { kind: 'template' as const, id: 'team' };
    const whole = layoutGlance(s, owner, 'the Team layout', 1_000_000);
    expect(whole).toMatchObject({ owner, label: 'the Team layout', collection: { id: 'team' } });
    expect(whole).not.toHaveProperty('shortened');
    const short = layoutGlance(s, owner, 'the Team layout', 900);
    expect(short).toMatchObject({ owner, shortened: expect.stringMatching(/read_layout/), collection: { fields: ['role:string', 'level:enum'], taxonomies: ['departments'] } });
    expect((short.sections as Array<{ id: string }>).map((x) => x.id)).toEqual(s.collections.team.settings.template.rootIds);
    // However many sections it has, it fits: those that do not are counted.
    const many = structuredClone(s);
    const tpl = many.collections.team.settings.template;
    for (let i = 0; i < 60; i++) {
      tpl.nodes[`n_extra${i}`] = { ...structuredClone(tpl.nodes[tpl.rootIds[0]]), id: `n_extra${i}` } as never;
      tpl.rootIds.push(`n_extra${i}`);
    }
    const fitted = layoutGlance(many, owner, 'the Team layout', 900);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(900);
    expect(fitted.omittedSections).toBeGreaterThan(0);
    // With no room at all, the owner alone, and how many sections it has.
    expect(layoutGlance(many, owner, 'the Team layout', 0)).toEqual({ owner, collectionId: 'team', label: 'the Team layout', sectionCount: tpl.rootIds.length, shortened: expect.stringMatching(/read_layout/) });
  });
});

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    for (const ev of turn ? turn(req) : [{ type: 'done' as const, stopReason: 'end' as const, text: 'Done.', toolCalls: [] }]) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'done', stopReason: 'end', text, toolCalls: [] }];
/** The last tool result a request carries, parsed. */
const lastResult = (req: CanonicalModelRequest) => {
  const item = req.items.at(-1) as { content?: string };
  return JSON.parse(item.content ?? '{}') as Record<string, any>;
};
const editorContext = (req: CanonicalModelRequest) => {
  const user = req.items.find((i) => i.kind === 'user' && i.text.includes('<editor_context>')) as { text: string };
  return JSON.parse(user.text.split('<editor_context>\n')[1].split('\n</editor_context>')[0]) as Record<string, any>;
};

describe('in an AI turn', () => {
  const dirs: string[] = [];
  const sessions: ProjectSession[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });
  async function setup(start: ProjectState, turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>) {
    const dir = mkdtempSync(join(tmpdir(), 'so-team-turn-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, start);
    sessions.push(session);
    const adapter = new FakeAdapter(turns);
    const events: AiEvent[] = [];
    let busy = false;
    const orch = new Orchestrator({
      session: () => session,
      adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
      emit: (e) => events.push(e),
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: (b) => (busy = b)
    });
    const home = session.state.site.homePageId;
    const send = async (text: string, extra: Partial<ChatContext> = {}) => {
      const r = await orch.send(text, { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, ...extra });
      expect(r.message).toBeUndefined();
      while (orch.busy || busy) await new Promise((res) => setTimeout(res, 10));
      return r.runId!;
    };
    return { session, adapter, send, home };
  }
  const ok = (req: CanonicalModelRequest) => expect(lastResult(req), JSON.stringify(lastResult(req)).slice(0, 300)).toMatchObject({ ok: true });

  it('makes a Team from two dropped photos, fills two members, shows them on Home, and is undone in one step', async () => {
    const attached = (i: number) => (editorContext(env.adapter.requests[0]).attachedImages as Array<{ assetId: string }>)[i].assetId;
    const env = await setup(studio(), [
      () => [call('c1', 'define_collection', { action: 'create', collectionId: 'team', name: 'Team', singularName: 'Team member', kind: 'structured', pages: { detail: false, archive: false }, fields: [{ name: 'role', type: 'string', label: 'Role' }, { name: 'photo', type: 'image', label: 'Photo' }] })],
      // Each member's photo is the one the request attached, as the model is told it.
      (req) => (ok(req), [call('c2', 'upsert_collection_entry', { collectionId: 'team', title: 'Ana Ruiz', draft: false, values: [{ field: 'role', value: 'Potter' }, { field: 'photo', value: attached(0) }] })]),
      (req) => (ok(req), [call('c3', 'upsert_collection_entry', { collectionId: 'team', title: 'Bo Chen', draft: false, values: [{ field: 'role', value: 'Glaze chemist' }, { field: 'photo', value: attached(1) }] })]),
      (req) => (ok(req), [call('c4', 'connect_collection_list', { owner: { kind: 'page', id: env.home }, nodeId: homeGrid(env.session.state), prop: 'items', query: { collectionId: 'team' }, fields: [{ itemField: 'title', entryField: 'title' }, { itemField: 'description', entryField: 'field.role' }] })]),
      (req) => (ok(req), finish('Made a Team with Ana and Bo, and showed them on Home.'))
    ]);
    const before = structuredClone(env.session.state);
    const groups = env.session.historyInfo().entries.length;
    const runId = await env.send('Make a Team collection with a role and a photo, add Ana (Potter) and Bo (Glaze chemist) with these photos, and show them in the services grid on Home.', { scope: 'site', assetIds: [ANA.id, BO.id] });
    expect(env.adapter.requests).toHaveLength(5);
    // The model is told each photo's name and asset ID, and nothing else about it.
    expect(editorContext(env.adapter.requests[0]).attachedImages).toEqual([{ assetId: ANA.id, name: 'Ana' }, { assetId: BO.id, name: 'Bo' }]);
    // The collection tools are there from the start; the entry tool names Team once it exists.
    expect(env.adapter.requests[0].tools.map((t) => t.name)).toContain('define_collection');
    expect(JSON.stringify(env.adapter.requests[1].tools.find((t) => t.name === 'upsert_collection_entry')!.parameters)).toContain('"team"');
    const team = env.session.state.collections.team;
    const members = Object.values(team.entries).sort((a, b) => a.title.localeCompare(b.title));
    expect(members.map((e) => [e.title, e.values.role, (e.values.photo as { assetId: string }).assetId])).toEqual([
      ['Ana Ruiz', 'Potter', ANA.id],
      ['Bo Chen', 'Glaze chemist', BO.id]
    ]);
    expect((env.session.state.pages[env.home].nodes[homeGrid(env.session.state)] as InstanceNode).listSources?.items).toMatchObject({ query: { collectionId: 'team' } });
    // One step undoes the whole turn; the photos the drop imported stay in Assets.
    expect(env.session.historyInfo().entries.slice(groups).map((e) => e.runId)).toEqual([runId]);
    expect((await env.session.undoGroup(runId)).ok).toBe(true);
    expect(env.session.state.collections).toEqual(before.collections);
    expect(env.session.state.pages[env.home]).toEqual(before.pages[env.home]);
    expect(Object.keys(env.session.state.assets.assets)).toEqual(expect.arrayContaining([ANA.id, BO.id]));
  });

  it("edits only the open layout, binding an element to the entry's field, with the pages behind it unchanged", async () => {
    let nodeId = '';
    const owner = { kind: 'template', id: 'team' };
    const env = await setup(team(), [
      // Called once the request is sent, when env is set: the revision it names is the project's.
      () => [call('c1', 'apply_operations', { expectedRevision: env.session.revision, operations: [{ type: 'node.insert', owner, primitive: 'paragraph', text: 'Role' }] })],
      (req) => {
        const r = lastResult(req);
        expect(r, JSON.stringify(r).slice(0, 300)).toMatchObject({ ok: true });
        nodeId = r.results[0].nodeId;
        return [call('c2', 'apply_operations', { expectedRevision: r.revision, operations: [{ type: 'node.setBinding', owner, nodeId, field: 'text', binding: { $entry: 'field.role' } }] })];
      },
      (req) => {
        ok(req);
        const home = env.session.state.pages[env.home];
        return [call('c3', 'apply_operations', { expectedRevision: lastResult(req).revision, operations: [{ type: 'node.setContent', owner: { kind: 'page', id: env.home }, nodeId: home.rootIds[0], field: 'anchor', value: 'top' }] })];
      },
      (req) => {
        expect(lastResult(req)).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/sent with the Team layout open/) } });
        return finish('Added the role under each member’s name.');
      }
    ]);
    const before = structuredClone(env.session.state);
    await env.send('Show each member’s role under their name', { template: { collectionId: 'team', entryId: 'en_ana', name: 'Team' } });
    const first = env.adapter.requests[0];
    const context = editorContext(first);
    // Whole while it fits the window's room for it, else by its sections: either way the owner and the entry's fields.
    expect(context.currentLayout).toMatchObject({ owner, collectionId: 'team', label: 'the Team layout', collection: { id: 'team' } });
    expect(JSON.stringify(context.currentLayout.collection.fields)).toMatch(/role.*level/);
    expect(context.allowedScope).toMatch(/only the Team layout \(owner template:team\)/);
    expect(context).not.toHaveProperty('currentPage');
    expect(first.system).toMatch(/\{ "\$entry": field \}/);
    expect(first.tools.map((t) => t.name)).not.toContain('upsert_page_with_sections');
    expect(env.session.state.collections.team.settings.template.nodes[nodeId]).toMatchObject({ text: { $entry: 'field.role' } });
    expect(env.session.state.pages).toEqual(before.pages);
    expect(env.session.state.collections.team.entries).toEqual(before.collections.team.entries);
  });

  it('refuses a layout request whose layout has gone, or that also names a page target', async () => {
    const env = await setup(team(), []);
    const s = new Orchestrator({ session: () => env.session, adapter: async () => ({ adapter: env.adapter, model: 'fake', provider: 'openai' }), emit: () => undefined, compileAll: async () => [], inspectLayout: async () => ({}), onBusyChange: () => undefined });
    const base = { pageId: env.home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
    expect((await s.send('Change it', { ...base, template: { collectionId: 'team', archive: true, name: 'Team' } })).message).toMatch(/The Team index layout is no longer in the site/);
    expect((await s.send('Change it', { ...base, scope: 'page', template: { collectionId: 'team', name: 'Team' } })).message).toMatch(/could not be read/);
    expect((await s.send('Change it', { ...base, template: { collectionId: 'team', name: 'Team', entryId: 7 } as never })).message).toMatch(/could not be read/);
  });
});
