/**
 * The assistant's tools for posts and other collection entries (#400): grammar-safe schemas for every model, a list
 * and a paged read, a write that keeps what it was not sent, a post scope that keeps a request to the post it was sent
 * from, the project's grant that lets only that tool's batch reach a collection, and the context budget for long reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { AssetRecord, EntryDoc, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { executeTool, toolsForRun, type ToolHost } from '@agent/tools';
import { checkAuthority, requestAuthority, widenChoices, type Authority, type AuthorityGrants } from '@agent/scope';
import { ENTRY_LIST_PAGE, ENTRY_PART_CHARS } from '@agent/collection-tools';
import { applyContextBudget } from '@agent/budget';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { richTextToMarkdown } from '@shared/richtext';
import { collectionGrantRefusal } from '@shared/collection-grant';
import { ProjectSession } from '../../src/main/project/session';

const PHOTO: AssetRecord = { id: 'a_kiln', name: 'Kiln', file: 'static/assets/kiln-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1200, height: 800, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' };

/** A blog with one category, one tag, a pictured post with its author, excerpt, picture, terms and search title set, and a second post. */
function blog(): ProjectState {
  const s = structuredClone(createStarterState('business', 'Riverside Studio', false));
  s.assets.assets[PHOTO.id] = PHOTO;
  return applyOperations(s, [
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News', termId: 'news' },
    { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'Glaze', termId: 'glaze' },
    {
      type: 'entry.create',
      collectionId: 'posts',
      entryId: 'en_spring',
      title: 'Spring open studio',
      publishedAt: '2027-03-02',
      draft: false,
      author: 'Ana Ruiz',
      excerpt: 'Twenty makers open their doors.',
      featuredImage: PHOTO.id,
      terms: { categories: ['news'], tags: ['glaze'] },
      seoTitle: 'Spring open studio at Riverside',
      body: ['## Who is coming', 'Twenty new **makers** join us.', { type: 'image', assetId: PHOTO.id, alt: 'The kiln', caption: 'Our kiln' }, '- Clay', '- Glass']
    },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14', draft: false, body: ['Read [the spring post](entry:en_spring).'] }
  ] as EditOperation[]).state;
}

/** A host over a project in memory, recording the grant each batch came with. */
function host(start: ProjectState, authority: Authority = { kind: 'site' }) {
  const limit = authority.kind === 'entry' ? { collectionId: authority.collectionId, entryId: authority.entryId, label: authority.label } : null;
  let state = start;
  let revision = 1;
  const grants: Array<AuthorityGrants | undefined> = [];
  const h: ToolHost = {
    state: () => state,
    revision: () => revision,
    diagnostics: () => [],
    apply: async (ops, expected, _label, _key, grant) => {
      grants.push(grant);
      if (expected !== revision) return { ok: false, revision, error: { code: 'STALE_REVISION', message: 'stale', recoverable: true } };
      const denied = checkAuthority(state, ops, authority, grant);
      if (denied) return { ok: false, revision, error: { code: 'SCOPE_MISMATCH', message: denied, recoverable: true } };
      const refused = grant?.collectionWrite ? collectionGrantRefusal(ops, grant.collectionWrite) : 'no grant';
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
    entryLimit: () => limit
  };
  return { h, grants, now: () => state };
}

const tool = (h: ToolHost, name: string, args: unknown) => executeTool(name, JSON.stringify(args), h, `call_${name}`);
const entry = (s: ProjectState, id: string): EntryDoc => s.collections.posts.entries[id];
const constrained = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };

describe('collection tools for every model', () => {
  it('offers closed, grammar-safe schemas wherever posts can be read or written, and nothing without a collection', () => {
    const state = blog();
    const site = toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false });
    const pinned = toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, entry: { collectionId: 'posts', entryId: 'en_spring' } });
    const page = toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, page: { route: '/' } });
    const ask = toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, ask: true });
    expect(site.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['upsert_collection_entry', 'list_collection_entries', 'read_collection_entry', 'upsert_page_with_sections']));
    // One post: its read and write, and the question that asks for more. Nothing else, for every model.
    expect(pinned).toMatchObject({ mode: 'entry' });
    expect(pinned.tools.map((t) => t.name)).toEqual(['read_collection_entry', 'upsert_collection_entry', 'request_clarification']);
    // A page or a question reads posts; neither writes one.
    expect(page.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_collection_entries', 'read_collection_entry']));
    expect(page.tools.map((t) => t.name)).not.toContain('upsert_collection_entry');
    expect(ask.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_collection_entries', 'read_collection_entry']));
    expect(ask.tools.map((t) => t.name)).not.toContain('upsert_collection_entry');
    for (const t of [...site.tools, ...pinned.tools, ...page.tools, ...ask.tools].filter((x) => x.name.includes('collection'))) {
      const strict = toStrictSchema(t.parameters);
      expect(findForbiddenShapes(strict), t.name).toEqual([]);
      expect(JSON.stringify(strict), t.name).not.toContain('$json');
      expect(t.brief, t.name).toBeTruthy();
    }
    // The pinned write names the post and cannot create one; the collection is a closed choice.
    const upsert = pinned.tools[1].parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect((pinned.tools[0].parameters as { properties: Record<string, { enum?: string[] }> }).properties.entryId.enum).toEqual(['en_spring']);
    expect(upsert.properties.entryId.enum).toEqual(['en_spring']);
    // A question about the open post reads that post alone.
    const askPost = toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, ask: true, entry: { collectionId: 'posts', entryId: 'en_spring' } });
    expect(askPost.tools.filter((t) => t.name.includes('collection')).map((t) => [t.name, (t.parameters as { properties: Record<string, { enum?: string[] }> }).properties.entryId?.enum])).toEqual([['read_collection_entry', ['en_spring']]]);
    expect(upsert.required).toContain('entryId');
    expect(upsert.properties.collectionId.enum).toEqual(['posts']);
    // Without a collection there is nothing to list, read or write.
    const plain = createStarterState('business', 'Riverside Studio', false);
    const none = JSON.stringify(toolsForRun({ state: plain, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false }).tools.map((t) => t.name));
    expect(none).not.toMatch(/collection/);
    // Raw collection operations are never offered: a post is written only with its tool.
    expect(JSON.stringify(toolsForRun({ state, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 200000 }, codeEnabled: true, definitionOps: true }).tools)).not.toMatch(/"entry\.(create|update)"/);
  });

  it('lists entries a page at a time, drafts marked, and says where to go on', async () => {
    let s = blog();
    s = applyOperations(s, Array.from({ length: 12 }, (_, i) => ({ type: 'entry.create', collectionId: 'posts', title: `Note ${i + 1}`, publishedAt: `2025-01-${String(i + 1).padStart(2, '0')}` }) as EditOperation)).state;
    const { h } = host(s);
    const first = (await tool(h, 'list_collection_entries', { collectionId: 'posts' })).content as unknown as { total: number; next: number | null; entries: Array<{ entryId: string; title: string; draft?: boolean }> };
    expect(first.total).toBe(14);
    expect(first.entries).toHaveLength(ENTRY_LIST_PAGE);
    expect(first.entries[0]).toEqual({ entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02' });
    expect(first.entries.find((e) => e.title === 'Note 12')).toMatchObject({ draft: true });
    expect(first.next).toBe(ENTRY_LIST_PAGE);
    const rest = (await tool(h, 'list_collection_entries', { collectionId: 'posts', offset: first.next })).content as unknown as { next: number | null; entries: Array<{ title: string }> };
    expect(rest).toMatchObject({ next: null });
    // Newest first, as the collection orders them.
    expect(rest.entries.map((e) => e.title)).toEqual(['Note 4', 'Note 3', 'Note 2', 'Note 1']);
    expect((await tool(h, 'list_collection_entries', { collectionId: 'news' })).content).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/no collection "news". Collections: posts/) } });
  });

  it('reads an entry with its details, and a long text as Markdown parts that join up exactly', async () => {
    let s = blog();
    const long = Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1} says “quoted” things and ünïcödé 😀 at length so the text runs on.`);
    s = applyOperations(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['## Opening times', ...long] }]).state;
    const { h } = host(s);
    const spring = (await tool(h, 'read_collection_entry', { collectionId: 'posts', entryId: 'en_spring' })).content as Record<string, unknown>;
    expect(spring).toMatchObject({ title: 'Spring open studio', publishedAt: '2027-03-02', draft: false, excerpt: 'Twenty makers open their doors.', categories: ['News'], route: '/blog/spring-open-studio/', format: 'markdown', offset: 0, next: null });
    expect(spring.text).toBe('## Who is coming\n\nTwenty new **makers** join us.\n\n![The kiln](asset:a_kiln "Our kiln")\n\n- Clay\n- Glass');
    const parts: string[] = [];
    let offset: number | null = 0;
    let reads = 0;
    while (offset !== null && reads++ < 50) {
      const r = (await tool(h, 'read_collection_entry', { collectionId: 'posts', entryId: 'en_winter', offset })).content as unknown as { text: string; next: number | null; offset: number; title?: string; length: number };
      // Only the first part repeats the details.
      expect(r.title !== undefined).toBe(r.offset === 0);
      expect(JSON.stringify(r.text).length - 2).toBeLessThanOrEqual(ENTRY_PART_CHARS);
      parts.push(r.text);
      offset = r.next;
    }
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join('')).toBe(richTextToMarkdown(entry(s, 'en_winter').body, s.pages));
    expect((await tool(h, 'read_collection_entry', { collectionId: 'posts', entryId: 'en_gone' })).content).toMatchObject({ error: { message: expect.stringMatching(/no entry "en_gone"/) } });
  });

  it('drafts a post with its date, categories, excerpt and structured text in one batch the grant names', async () => {
    const { h, grants, now } = host(blog());
    const r = await tool(h, 'upsert_collection_entry', {
      collectionId: 'posts',
      title: 'Kiln opening night',
      publishedAt: '2027-04-01',
      excerpt: 'Come and see the new kiln fired for the first time.',
      categories: ['news', 'Workshop Events'],
      body: ['## What to expect', 'Doors open at **6pm**, with *tea*.', '- Tours of the studio', '- Glaze demos', '1. Book a place', 'Book on the [contact page](/contact/), or read [the spring post](entry:en_spring).']
    });
    expect(r).toMatchObject({ ok: true, mutated: true, content: { ok: true, collectionId: 'posts', draft: true, addedCategories: ['Workshop Events'] } });
    const id = (r.content as unknown as { entryId: string }).entryId;
    const post = entry(now(), id);
    expect(post).toMatchObject({ title: 'Kiln opening night', publishedAt: '2027-04-01', draft: true, excerpt: 'Come and see the new kiln fired for the first time.', terms: { categories: ['news', 'workshop-events'] } });
    expect(now().collections.posts.settings.taxonomies.categories.terms['workshop-events']).toEqual({ label: 'Workshop Events' });
    expect(post.body.map((b) => b.type)).toEqual(['h2', 'p', 'ul', 'ol', 'p']);
    const links = JSON.stringify(post.body.at(-1));
    expect(links).toContain(`"type":"page","target":"${Object.values(now().pages).find((p) => p.route === '/contact/')!.id}"`);
    expect(links).toContain('"type":"entry","target":"en_spring"');
    // The categories first, then the one post, with the grant for exactly that.
    expect(r.ops!.map((o) => o.type)).toEqual(['collection.createTerm', 'entry.create']);
    expect(grants.at(-1)).toEqual({ collectionWrite: { kind: 'entry', collectionId: 'posts' } });
  });

  it('edits only the fields it is sent, keeping every other detail, and keeps the pictures a rewrite reads back', async () => {
    const before = blog();
    const { h, now } = host(before);
    const r = await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', body: ['## Who is coming', 'Twenty new **makers** join us this spring.', '![The kiln](asset:a_kiln "Our kiln")', '- Clay', '- Glass'] });
    expect(r.ok).toBe(true);
    const after = entry(now(), 'en_spring');
    const was = entry(before, 'en_spring');
    // The text changed; the picture is the same block it was; nothing else moved.
    expect(after.body[2]).toEqual(was.body[2]);
    expect(JSON.stringify(after.body[1])).toContain('join us this spring.');
    expect({ ...after, body: undefined }).toEqual({ ...was, body: undefined });
    expect(entry(now(), 'en_winter')).toEqual(entry(before, 'en_winter'));
    // Categories replace its categories alone: its tags stay. An emptied excerpt is removed.
    await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', categories: [], excerpt: '' });
    expect(entry(now(), 'en_spring').terms).toEqual({ tags: ['glaze'] });
    expect(entry(now(), 'en_spring').excerpt).toBeUndefined();
    expect(entry(now(), 'en_spring').author).toBe('Ana Ruiz');
    // A picture the post does not have, a bad date, a missing title and an empty edit are refused, applying nothing.
    const still = structuredClone(now());
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', body: ['![Other](asset:a_other)'] })).content).toMatchObject({ error: { message: expect.stringMatching(/body\[0\]: the entry has no picture "a_other"/) } });
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', publishedAt: 'April 1st' })).content).toMatchObject({ error: { message: expect.stringMatching(/publishedAt/) } });
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', body: ['Hello'] })).content).toMatchObject({ error: { message: expect.stringMatching(/title: a new entry needs a title/) } });
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring' })).content).toMatchObject({ error: { message: expect.stringMatching(/send at least one field/) } });
    expect(now()).toEqual(still);
  });

  it('tells two placements of one picture apart by their lines, writes a paragraph of any length, and refuses a blank category', async () => {
    const s = applyOperations(blog(), [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: [{ type: 'image', assetId: PHOTO.id, alt: 'Kiln', caption: 'Before' }, 'Between.', { type: 'image', assetId: PHOTO.id, alt: 'Kiln', caption: 'After' }] }
    ] as EditOperation[]).state;
    const { h, now } = host(s);
    // Only the second picture is kept: it keeps its own caption, not the first one's.
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_winter', body: ['Between, revised.', '![Kiln](asset:a_kiln "After")'] })).ok).toBe(true);
    expect(entry(now(), 'en_winter').body[1]).toEqual({ type: 'image', assetId: PHOTO.id, alt: 'Kiln', caption: 'After' });
    const long = `A long paragraph ${'that runs on '.repeat(500)}to its end.`;
    expect(long.length).toBeGreaterThan(ENTRY_PART_CHARS);
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_winter', body: [long] })).ok).toBe(true);
    expect(entry(now(), 'en_winter').body).toEqual([{ type: 'p', spans: [{ text: long }] }]);
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', categories: [' '] })).content).toMatchObject({ error: { message: expect.stringMatching(/categories\[0\]: a category needs a name/) } });
    expect(entry(now(), 'en_spring').terms.categories).toEqual(['news']);
  });

  it('refuses a picture line whose caption or alt was altered, applying nothing, and keeps exact lines reordered or left out', async () => {
    const s = applyOperations(blog(), [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: [{ type: 'image', assetId: PHOTO.id, alt: 'Kiln', caption: 'Before' }, 'Between.', { type: 'image', assetId: PHOTO.id, alt: 'Kiln', caption: 'After' }] }
    ] as EditOperation[]).state;
    const { h, grants, now } = host(s);
    const write = (body: string[]) => tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_winter', title: 'Rewritten', categories: ['Events'], body });
    for (const altered of ['![Kiln](asset:a_kiln "During")', '![A new description](asset:a_kiln "Before")', '![Kiln](asset:a_kiln)']) {
      const r = await write(['![Kiln](asset:a_kiln "After")', altered]);
      expect(r.content, altered).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/body\[1\]: this picture line does not match/) } });
    }
    // Nor is one retyped, given text around it, or sent inside a longer element written as text in the picture's place.
    for (const altered of [`![Kiln](asset:a_kiln 'Before')`, '![Kiln](asset:a_kiln "Before") and more', '- ![Kiln](asset:a_kiln "Before")', '![A [new] kiln](<asset:a_kiln>)', '![Kiln](< asset:a_kiln > "During")', '![Kiln](\nasset:a_kiln "During")', '![A new\ndescription](asset:a_kiln "Before")', 'Between.\n\n![Kiln](asset:a_kiln "Before")']) {
      const r = await write(['![Kiln](asset:a_kiln "After")', altered]);
      expect(r.content, altered).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/body\[1\]: this picture line does not match/) } });
    }
    // One figure cannot be placed twice.
    expect((await write(['![Kiln](asset:a_kiln "After")', '![Kiln](asset:a_kiln "After")'])).content).toMatchObject({ error: { message: expect.stringMatching(/body\[1\]: this picture line does not match/) } });
    // Nothing reached the project: no text, title or new category.
    expect(grants).toEqual([]);
    expect(now()).toEqual(s);
    const [before, , after] = entry(s, 'en_winter').body;
    expect((await write(['  ![Kiln](asset:a_kiln "After") ', '![Kiln](asset:a_kiln "Before")'])).ok).toBe(true);
    expect(entry(now(), 'en_winter').body).toEqual([after, before]);
    expect((await write(['![Kiln](asset:a_kiln "Before")'])).ok).toBe(true);
    expect(entry(now(), 'en_winter').body).toEqual([before]);
    // Literal text that looks like a picture reads back escaped, and is written as the text it is.
    const literal = applyOperations(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: [{ type: 'p', spans: [{ text: 'Type ![Kiln](asset:a_kiln) here.' }] }] }] as EditOperation[]).state;
    const other = host(literal);
    const read = (await tool(other.h, 'read_collection_entry', { collectionId: 'posts', entryId: 'en_winter' })).content as unknown as { text: string };
    expect((await tool(other.h, 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_winter', body: [read.text] })).ok).toBe(true);
    expect(entry(other.now(), 'en_winter').body).toEqual(entry(literal, 'en_winter').body);
  });

  it('gives a collection without categories its first one', async () => {
    const s = applyOperations(blog(), [
      { type: 'collection.create', collectionId: 'projects', route: '/projects/' },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_mill', title: 'The old mill' }
    ] as EditOperation[]).state;
    expect(s.collections.projects.settings.taxonomies.categories).toBeUndefined();
    const { h, now } = host(s);
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'projects', entryId: 'en_mill', categories: ['Restoration'] })).ok).toBe(true);
    expect(now().collections.projects.settings.taxonomies.categories.terms).toEqual({ restoration: { label: 'Restoration' } });
    expect(now().collections.projects.entries.en_mill.terms.categories).toEqual(['restoration']);
  });

  it('reads only the open post in a run limited to it', async () => {
    const state = blog();
    const { h } = host(state, requestAuthority({ pageId: 'pg_any', pageTitle: 'Home', selection: null, selectionLabel: null, post: { collectionId: 'posts', entryId: 'en_spring', title: 'Spring' } }, state));
    expect((await tool(h, 'read_collection_entry', { collectionId: 'posts', entryId: 'en_spring' })).ok).toBe(true);
    expect((await tool(h, 'read_collection_entry', { collectionId: 'posts', entryId: 'en_winter' })).content).toMatchObject({ error: { message: expect.stringMatching(/entryId: this request is about the post “Spring open studio” \(posts\/en_spring\) alone/) } });
    expect((await tool(h, 'list_collection_entries', { collectionId: 'posts' })).ok).toBe(false);
  });
});

describe('one block of an entry’s text (#1120)', () => {
  type Row = { block: number; start: number; end: number; hash?: string; picture?: true };
  type Part = { revision: number; text: string; offset: number; next: number | null; length: number; blocks: Row[] };
  const tail = Array.from({ length: 80 }, (_, i) => `Later paragraph ${i + 1} runs on about the studio and its kiln, at some length, so the text needs several parts.`);
  /** Two identical paragraphs, a captioned picture beside them, a list, and a tail long enough that the first part is all a model reads. */
  function article(): ProjectState {
    return applyOperations(blog(), [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['Doors open at ten.', 'Doors open at ten.', { type: 'image', assetId: PHOTO.id, alt: 'The kiln', caption: 'Our kiln, fired' }, '- Clay', '- Glass', ...tail] }
    ] as EditOperation[]).state;
  }
  const read = async (h: ToolHost, offset?: number, entryId = 'en_winter') => (await tool(h, 'read_collection_entry', { collectionId: 'posts', entryId, ...(offset !== undefined ? { offset } : {}) })).content as unknown as Part;
  const edit = (h: ToolHost, blockEdit: Record<string, unknown>, more: Record<string, unknown> = {}, entryId = 'en_winter') => tool(h, 'upsert_collection_entry', { collectionId: 'posts', entryId, ...more, blockEdit });

  it('locates every block a part shows, with a hash for each block of text, in parts that still join up exactly', async () => {
    const s = article();
    const { h } = host(s);
    const parts: Part[] = [];
    for (let offset: number | null = 0, n = 0; offset !== null && n < 50; n++) {
      const p = await read(h, offset);
      expect(JSON.stringify(p.text).length - 2 + JSON.stringify(p.blocks).length).toBeLessThanOrEqual(ENTRY_PART_CHARS);
      parts.push(p);
      offset = p.next;
    }
    const whole = parts.map((p) => p.text).join('');
    expect(parts.length).toBeGreaterThan(1);
    expect(whole).toBe(richTextToMarkdown(entry(s, 'en_winter').body, s.pages));
    const body = entry(s, 'en_winter').body;
    const rows = new Map<number, Row>();
    for (const p of parts)
      for (const r of p.blocks) {
        // Each row lies in the part it is listed with, and a block shown by two parts has the same row in both.
        expect(r.start < p.offset + p.text.length && r.end >= p.offset).toBe(true);
        if (rows.has(r.block)) expect(rows.get(r.block)).toEqual(r);
        rows.set(r.block, r);
      }
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual(body.map((_, i) => i));
    for (const [i, r] of rows) expect(whole.slice(r.start, r.end)).toBe(richTextToMarkdown([body[i]], s.pages));
    // Every part lists exactly the blocks it shows any of, so a part that goes on with a paragraph still locates it.
    for (const p of parts) expect(p.blocks.map((r) => r.block)).toEqual([...rows.values()].filter((r) => r.start < p.offset + p.text.length && r.end > p.offset).map((r) => r.block));
    expect([...rows.keys()].some((b) => parts.filter((p) => p.blocks.some((r) => r.block === b)).length > 1)).toBe(true);
    // The picture is marked, and has no hash; the two identical paragraphs have hashes of their own.
    expect(rows.get(2)).toEqual({ block: 2, start: expect.any(Number), end: expect.any(Number), picture: true });
    expect(rows.get(0)!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rows.get(0)!.hash).not.toBe(rows.get(1)!.hash);
    // The same words at the same place of another entry hash differently too.
    const twin = applyOperations(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['Doors open at ten.'] }] as EditOperation[]).state;
    const th = host(twin).h;
    expect(entry(twin, 'en_spring').body[0]).toEqual(body[0]);
    expect((await read(th, 0, 'en_spring')).blocks[0].hash).not.toBe((await read(th)).blocks[0].hash);
  });

  it('reads a text of many tiny paragraphs in parts its rows fit in, always moving on', async () => {
    const s = applyOperations(blog(), [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: Array.from({ length: 300 }, (_, i) => `${i % 10}`) }] as EditOperation[]).state;
    const { h } = host(s);
    const texts: string[] = [];
    let seen = 0;
    for (let offset: number | null = 0, n = 0; offset !== null && n < 200; n++) {
      const p = await read(h, offset);
      expect(JSON.stringify(p.text).length - 2 + JSON.stringify(p.blocks).length).toBeLessThanOrEqual(ENTRY_PART_CHARS);
      if (p.next !== null) expect(p.next).toBeGreaterThan(p.offset);
      texts.push(p.text);
      seen = Math.max(seen, ...p.blocks.map((r) => r.block));
      offset = p.next;
    }
    expect(texts.join('')).toBe(richTextToMarkdown(entry(s, 'en_winter').body, s.pages));
    expect(seen).toBe(299);
  });

  it('replaces the second of two identical paragraphs alone, keeping the first, the captioned picture beside it and the unread rest', async () => {
    const s = article();
    const { h, grants, now } = host(s);
    const first = await read(h);
    expect(first.next).not.toBeNull();
    const second = first.blocks.find((r) => r.block === 1)!;
    const r = await edit(h, { block: 1, hash: second.hash, revision: first.revision, text: 'Doors open at **eleven**.' });
    expect(r).toMatchObject({ ok: true, mutated: true, content: { ok: true, collectionId: 'posts', entryId: 'en_winter', block: { block: 1, hash: expect.stringMatching(/^[0-9a-f]{16}$/) } } });
    const before = entry(s, 'en_winter').body;
    const after = entry(now(), 'en_winter').body;
    expect(after).toEqual([before[0], { type: 'p', spans: [{ text: 'Doors open at ' }, { text: 'eleven', strong: true }, { text: '.' }] }, ...before.slice(2)]);
    expect(after[2]).toEqual({ type: 'image', assetId: PHOTO.id, alt: 'The kiln', caption: 'Our kiln, fired' });
    // One entry.update through the grant for this entry, with nothing else of the post or the project changed.
    expect(r.ops!.map((o) => o.type)).toEqual(['entry.update']);
    expect(grants).toEqual([{ collectionWrite: { kind: 'entry', collectionId: 'posts', entryId: 'en_winter' } }]);
    expect({ ...entry(now(), 'en_winter'), body: undefined }).toEqual({ ...entry(s, 'en_winter'), body: undefined });
    expect(entry(now(), 'en_spring')).toEqual(entry(s, 'en_spring'));
    // The result's hash and revision are what a read gives now, and the other blocks keep theirs: the next edit goes on from them.
    const again = await read(h);
    const content = r.content as unknown as { revision: number; block: { hash: string } };
    expect(again.revision).toBe(content.revision);
    expect(again.blocks.find((b) => b.block === 1)!.hash).toBe(content.block.hash);
    expect(content.block.hash).not.toBe(second.hash);
    const unchanged = structuredClone(now());
    expect((await edit(h, { block: 1, hash: second.hash, revision: content.revision, text: 'Doors open at noon.' })).content).toMatchObject({ error: { code: 'STALE_REVISION', message: expect.stringMatching(/does not have the hash/) } });
    expect(now()).toEqual(unchanged);
    const grew = 'Doors open at **eleven**.'.length - 'Doors open at ten.'.length;
    const kept = again.blocks.filter((b) => b.block !== 1);
    expect(kept.length).toBeGreaterThan(10);
    expect(kept).toEqual(first.blocks.filter((b) => b.block !== 1 && kept.some((k) => k.block === b.block)).map((b) => (b.start > second.start ? { ...b, start: b.start + grew, end: b.end + grew } : b)));
    const list = first.blocks.find((b) => b.block === 3)!;
    expect((await edit(h, { block: 3, hash: list.hash, revision: content.revision, text: '- Clay\n- Glass\n- Wood' }, { title: 'Winter hours, revised' })).ok).toBe(true);
    expect(entry(now(), 'en_winter').body[3]).toEqual({ type: 'ul', items: [[{ text: 'Clay' }], [{ text: 'Glass' }], [{ text: 'Wood' }]] });
    expect(entry(now(), 'en_winter').title).toBe('Winter hours, revised');
    expect(entry(now(), 'en_winter').body.slice(4)).toEqual(before.slice(4));
  });

  it('refuses a stale hash or revision, the first duplicate’s hash for the second, and a paragraph added since, applying nothing', async () => {
    const s = article();
    const { h, grants, now } = host(s);
    const p = await read(h);
    const [a, b] = p.blocks;
    const flipped = `${b.hash!.slice(0, -1)}${b.hash!.endsWith('0') ? '1' : '0'}`;
    for (const blockEdit of [
      { block: 1, hash: flipped, revision: p.revision, text: 'Changed.' },
      { block: 1, hash: a.hash, revision: p.revision, text: 'Changed.' },
      { block: 1, hash: b.hash, revision: p.revision - 1, text: 'Changed.' }
    ]) {
      const r = await edit(h, blockEdit, { title: 'Not this', categories: ['Not this either'] });
      expect(r.content, JSON.stringify(blockEdit)).toMatchObject({ revision: p.revision, error: { code: 'STALE_REVISION', recoverable: true, message: expect.stringMatching(/block 1 of posts\/en_winter.*Nothing was applied\. Read that part of the entry again/) } });
    }
    expect(grants).toEqual([]);
    expect(now()).toEqual(s);
    // The author adds the same paragraph ahead of it: block 1 holds the same words still, but the read is out of date.
    await h.apply([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['Doors open at ten.', ...entry(s, 'en_winter').body] } as EditOperation], p.revision, 'Author', 'author', { collectionWrite: { kind: 'entry', collectionId: 'posts', entryId: 'en_winter' } });
    const moved = structuredClone(now());
    expect((await edit(h, { block: 1, hash: b.hash, revision: p.revision, text: 'Changed.' })).content).toMatchObject({ error: { code: 'STALE_REVISION' } });
    expect(now()).toEqual(moved);
  });

  it('changes only a block of text: never the picture, a picture line, two blocks or a list joining its neighbour', async () => {
    const s = applyOperations(article(), [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['- Clay', 'Between the lists.', '- Glass', { type: 'image', assetId: PHOTO.id, alt: 'Kiln', caption: 'Fired' }] }
    ] as EditOperation[]).state;
    const { h, grants, now } = host(s);
    const p = await read(h);
    const at = (i: number) => p.blocks.find((r) => r.block === i)!;
    const refused = async (blockEdit: Record<string, unknown>, pattern: RegExp, more: Record<string, unknown> = {}, entryId?: string) =>
      expect((await edit(h, { revision: p.revision, ...blockEdit }, more, entryId)).content, JSON.stringify(blockEdit)).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(pattern) } });
    await refused({ block: 2, hash: 'whatever', text: 'A new caption' }, /blockEdit\.block: block 2 of posts\/en_winter is a picture/);
    await refused({ block: 1, hash: at(1).hash, text: '![The kiln](asset:a_kiln "Our kiln, fired")' }, /blockEdit\.text: a picture is placed by the author/);
    await refused({ block: 1, hash: at(1).hash, text: 'One paragraph.\n\nAnd another.' }, /makes 2 blocks, and blockEdit changes one/);
    await refused({ block: 1, hash: at(1).hash, text: '   ' }, /blockEdit\.text: the block is empty/);
    await refused({ block: 1, hash: at(1).hash, text: 'See [the shop](/no-such-page/).' }, /blockEdit\.text: the block: no page or entry has the route/);
    await refused({ block: 99, hash: at(1).hash, text: 'Changed.' }, /blockEdit\.block: the entry's text has 84 blocks \(0 to 83\)/);
    await refused({ block: 1, hash: at(1).hash, text: 'Changed.' }, /send blockEdit or body, not both/, { body: [] });
    expect((await tool(h, 'upsert_collection_entry', { collectionId: 'posts', title: 'New', blockEdit: { block: 0, hash: 'whatever', revision: p.revision, text: 'Changed.' } })).content).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/a block edit changes a block of an entry that exists/) } });
    // A list sent between two lists would make them one.
    const spring = await read(h, 0, 'en_spring');
    const mid = spring.blocks.find((r) => r.block === 1)!;
    await refused({ block: 1, hash: mid.hash, revision: spring.revision, text: '- Wood' }, /would join or change the block next to it/, { title: 'Not this', categories: ['Brand new'] }, 'en_spring');
    expect(grants).toEqual([]);
    expect(now()).toEqual(s);
    // A heading in its place is one block, and the lists and the picture stay.
    expect((await edit(h, { block: 1, hash: mid.hash, revision: spring.revision, text: '### Between' }, {}, 'en_spring')).ok).toBe(true);
    expect(entry(now(), 'en_spring').body).toEqual([entry(s, 'en_spring').body[0], { type: 'h3', spans: [{ text: 'Between' }] }, ...entry(s, 'en_spring').body.slice(2)]);
  });

  it('refuses a block edit of another post in a run limited to one, before reading anything of it', async () => {
    const s = article();
    const { h, grants, now } = host(s, requestAuthority({ pageId: 'pg_any', pageTitle: 'Home', selection: null, selectionLabel: null, post: { collectionId: 'posts', entryId: 'en_spring', title: 'Spring' } }, s));
    const other = await read(host(s).h);
    for (const hash of [other.blocks[0].hash, 'not-a-hash'])
      expect((await edit(h, { block: 0, hash, revision: other.revision, text: 'Changed.' })).content).toMatchObject({ error: { code: 'SCOPE_MISMATCH', message: "entryId: this request is about the post “Spring open studio” (posts/en_spring) alone, so only it can be changed. Nothing was applied. Change this post's blocks, or ask with request_clarification (widenScope: true) to change another." } });
    expect(grants).toEqual([]);
    expect(now()).toEqual(s);
    // Its own post's blocks it may change.
    const own = await read(h, 0, 'en_spring');
    const p = own.blocks.find((r) => r.block === 1)!;
    expect((await edit(h, { block: 1, hash: p.hash, revision: own.revision, text: 'Twenty new makers join us this year.' }, {}, 'en_spring')).ok).toBe(true);
    expect(entry(now(), 'en_spring').body.map((b) => b.type)).toEqual(['h2', 'p', 'image', 'ul']);
    expect(entry(now(), 'en_winter')).toEqual(entry(s, 'en_winter'));
  });
  it('edits a block beside one stored in a form the engine writes more simply, an empty or picture-only text not at all, and says to read again when the project moved meanwhile', async () => {
    const s = article();
    // Two spans with the same link side by side, as a link pointed elsewhere leaves them.
    const link = { type: 'entry' as const, target: 'en_spring' };
    s.collections.posts.entries.en_winter.body[0] = { type: 'p', spans: [{ text: 'See ', link }, { text: 'spring', link }] };
    const { h, now } = host(s);
    const p = await read(h);
    const r = await edit(h, { block: 1, hash: p.blocks[1].hash, revision: p.revision, text: 'Doors open at noon.' });
    expect(r.ok).toBe(true);
    expect(entry(now(), 'en_winter').body[0]).toEqual({ type: 'p', spans: [{ text: 'See spring', link }] });
    expect(entry(now(), 'en_winter').body.slice(2)).toEqual(entry(s, 'en_winter').body.slice(2));
    const again = await read(h);
    expect(again.blocks[1].hash).toBe((r.content as unknown as { block: { hash: string } }).block.hash);
    // An entry with no block of text is written whole.
    const bare = applyOperations(blog(), [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: [] },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [{ type: 'image', assetId: PHOTO.id, alt: 'Kiln' }] }
    ] as EditOperation[]).state;
    const b = host(bare);
    expect((await read(b.h)).blocks).toEqual([]);
    expect((await edit(b.h, { block: 0, hash: 'x', revision: 1, text: 'Hello.' })).content).toMatchObject({ error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/blockEdit: the entry's text has no block of text to change: send body with the whole text\. Nothing/) } });
    expect((await edit(b.h, { block: 0, hash: 'x', revision: 1, text: 'Hello.' }, {}, 'en_spring')).content).toMatchObject({ error: { message: expect.stringMatching(/no block of text to change: send body with the whole text, keeping each picture line as read/) } });
    // Another change lands between the call's checks and its write: the session refuses it, and the call says what to do.
    const late = host(article());
    const lp = await read(late.h);
    const racing: ToolHost = { ...late.h, apply: async (ops, expected, ...rest) => (await late.h.apply([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Meanwhile' } as EditOperation], expected, 'Author', 'author', { collectionWrite: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' } }), late.h.apply(ops, expected, ...rest)) };
    expect((await edit(racing, { block: 1, hash: lp.blocks[1].hash, revision: lp.revision, text: 'Changed.' })).content).toMatchObject({ error: { code: 'STALE_REVISION', message: expect.stringMatching(/Read that part of the entry again with read_collection_entry/) } });
    expect(entry(late.now(), 'en_winter')).toEqual(entry(article(), 'en_winter'));
  });

  it('offers blockEdit as a closed object with every key required, in the site and the pinned schema', () => {
    const state = blog();
    for (const run of [toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false }), toolsForRun({ state, selection: null, capabilities: constrained, codeEnabled: false, definitionOps: false, entry: { collectionId: 'posts', entryId: 'en_spring' } })]) {
      const upsert = run.tools.find((t) => t.name === 'upsert_collection_entry')!.parameters as { properties: Record<string, { type?: string; required?: string[]; additionalProperties?: unknown }> };
      expect(upsert.properties.blockEdit).toMatchObject({ type: 'object', additionalProperties: false });
      expect([...(upsert.properties.blockEdit.required ?? [])].sort()).toEqual(['block', 'hash', 'revision', 'text']);
    }
  });
});

describe('a request about one post', () => {
  const postCtx = { pageId: 'pg_any', pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, post: { collectionId: 'posts', entryId: 'en_spring', title: 'Old title' } } as ChatContext;

  it('is limited to that post: its own details and categories it already has, never another post, a new one, a new category or a page', () => {
    const state = blog();
    const authority = requestAuthority(postCtx, state);
    expect(authority).toEqual({ kind: 'entry', collectionId: 'posts', entryId: 'en_spring', label: 'the post “Spring open studio”' });
    expect(widenChoices(authority)).toEqual(['Yes, allow changes across the whole site', 'No, only change the post “Spring open studio”']);
    const check = (...ops: unknown[]) => checkAuthority(state, ops as EditOperation[], authority);
    expect(check({ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Spring', body: ['x'], terms: { categories: ['news'] }, draft: true })).toBeNull();
    expect(check({ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'X' })).toMatch(/outside the post “Spring open studio”/);
    expect(check({ type: 'entry.create', collectionId: 'posts', title: 'X' })).toMatch(/Creating a new post/);
    expect(check({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Events', termId: 'events' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', terms: { categories: ['events'] } })).toMatch(/Adding the category “Events”/);
    expect(check({ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', slug: 'spring' })).toMatch(/new address/);
    const home = state.site.homePageId;
    expect(check({ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: state.pages[home].rootIds[0], prop: 'heading', value: 'Hi' })).toMatch(/outside the post/);
    const gone = structuredClone(state);
    delete gone.collections.posts.entries.en_spring;
    expect(checkAuthority(gone, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'X' }], authority)).toBe('The post “Spring open studio” is no longer in the site.');
    // A component edited everywhere decides first, as it always has.
    expect(requestAuthority({ ...postCtx, component: { id: 'x', name: 'X' } }, state)).toMatchObject({ kind: 'component' });
  });
});

describe('the project lets a run reach a collection only through the post tool', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const session = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-posts-ai-'));
    dirs.push(dir);
    return ProjectSession.create(dir, blog());
  };

  it('applies the batch the grant names and refuses anything else, applying nothing', async () => {
    const s = await session();
    const ai = { label: 'AI', source: 'ai' as const };
    const before = structuredClone(s.state);
    const refused = async (ops: unknown[], grant?: { collectionId: string; entryId?: string }) => {
      const r = await s.apply({ operations: ops as EditOperation[] }, { ...ai, ...(grant ? { collectionWrite: { kind: 'entry' as const, ...grant } } : {}) });
      expect(r, JSON.stringify(ops)).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    };
    const update = { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Spring' };
    // Without a grant, as before: no collection change from a run.
    await refused([update]);
    // A grant for another post, another collection, or a create; a term the post is not filed under; a term alone;
    // anything else beside the post.
    await refused([update], { collectionId: 'posts', entryId: 'en_winter' });
    await refused([update], { collectionId: 'posts' });
    await refused([update], { collectionId: 'news', entryId: 'en_spring' });
    await refused([{ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Events', termId: 'events' }, update], { collectionId: 'posts', entryId: 'en_spring' });
    await refused([{ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Events', termId: 'events' }], { collectionId: 'posts', entryId: 'en_spring' });
    await refused([{ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'Kilns', termId: 'kilns' }, { ...update, terms: { categories: ['kilns'] } }], { collectionId: 'posts', entryId: 'en_spring' });
    await refused([{ type: 'site.update', name: 'Other' }, update], { collectionId: 'posts', entryId: 'en_spring' });
    await refused([{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }], { collectionId: 'posts', entryId: 'en_spring' });
    // Nor a new address, an old one kept working, or an ID chosen for a new post: the tool sends none of them.
    await refused([{ ...update, slug: 'spring' }], { collectionId: 'posts', entryId: 'en_spring' });
    await refused([{ type: 'entry.create', collectionId: 'posts', title: 'New', redirectFrom: '/2019/old/' }], { collectionId: 'posts' });
    await refused([{ type: 'entry.create', collectionId: 'posts', title: 'New', entryId: 'en_chosen' }], { collectionId: 'posts' });
    // Inside a run, the run alone says it is the assistant's.
    expect(await s.beginRun('run_ai')).toBeNull();
    const inRun = await s.apply({ operations: [update] as EditOperation[] }, { label: 'AI', runId: 'run_ai', history: false });
    expect(inRun).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    await s.abortRun();
    expect(s.state.collections).toEqual(before.collections);
    // The tool's own batch lands.
    const ok = await s.apply(
      { operations: [{ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Events', termId: 'events' }, { ...update, terms: { categories: ['news', 'events'] } }] as EditOperation[] },
      { ...ai, collectionWrite: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' } }
    );
    expect(ok.error).toBeUndefined();
    expect(entry(s.state, 'en_spring')).toMatchObject({ title: 'Spring', terms: { categories: ['news', 'events'], tags: ['glaze'] } });
    await s.close();
  });
});

/** Replays scripted turns, as the agent tests do. */
class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(
    private turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>,
    private caps: Partial<ReturnType<AgentModelAdapter['capabilities']>> = {}
  ) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000, ...this.caps } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    for (const ev of turn ? turn(req) : [{ type: 'done' as const, stopReason: 'end' as const, text: 'Done.', toolCalls: [] }]) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'done', stopReason: 'end', text, toolCalls: [] }];

describe('posts in an AI turn', () => {
  const dirs: string[] = [];
  const sessions: ProjectSession[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });
  async function setup(turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>, caps: Partial<ReturnType<AgentModelAdapter['capabilities']>> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'so-posts-turn-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, blog());
    sessions.push(session);
    const adapter = new FakeAdapter(turns, caps);
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
    const send = async (text: string, extra: Partial<ChatContext> = {}, answers: string[] = []) => {
      const r = await orch.send(text, { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, ...extra });
      expect(r.message).toBeUndefined();
      const answered = new Set<string>();
      while (orch.busy || busy) {
        const q = [...events].reverse().find((e) => e.message?.questions?.some((x) => x.answered === undefined && !answered.has(x.id!)))?.message?.questions?.find((x) => x.answered === undefined && !answered.has(x.id!));
        if (q?.id) {
          answered.add(q.id);
          orch.answer(r.runId!, q.id, answers.shift() ?? 'No');
        }
        await new Promise((res) => setTimeout(res, 10));
      }
      return r.runId!;
    };
    return { session, adapter, orch, send, events, home };
  }
  const result = (req: CanonicalModelRequest) => JSON.stringify(req.items.at(-1));

  it('drafts a post from notes and puts a Latest news feed on Home in one turn, undone in one step, for a constrained local model too', async () => {
    for (const caps of [{}, { toolCalling: 'constrained-json' as const, contextWindowTokens: 16000, maxOutputTokens: 2000 }]) {
      const env = await setup([
        () => [call('c1', 'upsert_collection_entry', { collectionId: 'posts', title: 'Kiln opening night', publishedAt: '2027-04-01', excerpt: 'The new kiln fires for the first time.', categories: ['News', 'Events'], body: ['## What to expect', 'Doors open at **6pm**.', '- Studio tours', 'Book on the [contact page](/contact/).'] })],
        () => [call('c2', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'blog.grid', props: { heading: 'Latest news', collection: 'posts', count: 3 } }] })],
        () => finish('Drafted the post and added a Latest news feed to Home.')
      ], caps);
      const before = structuredClone(env.session.state);
      const runId = await env.send('Draft a post from these notes: kiln opening night, April 1st, doors at 6pm, studio tours. File it under News and Events. Then add a Latest news section to the home page.', { scope: 'site' });
      const tools = env.adapter.requests[0].tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['upsert_collection_entry', 'list_collection_entries', 'read_collection_entry', 'upsert_page_with_sections']));
      expect(env.adapter.requests[0].system).toMatch(/upsert_collection_entry drafts a post/);
      expect(result(env.adapter.requests[1])).not.toMatch(/SCOPE_MISMATCH|VALIDATION_FAILED/);
      expect(result(env.adapter.requests[2])).not.toMatch(/SCOPE_MISMATCH|VALIDATION_FAILED/);
      const drafted = Object.values(env.session.state.collections.posts.entries).find((e) => e.title === 'Kiln opening night')!;
      expect(drafted).toMatchObject({ publishedAt: '2027-04-01', draft: true, excerpt: 'The new kiln fires for the first time.', terms: { categories: ['news', 'events'] } });
      expect(drafted.body.map((b) => b.type)).toEqual(['h2', 'p', 'ul', 'p']);
      const home = env.session.state.pages[env.home];
      const feed = home.rootIds.map((id) => home.nodes[id] as InstanceNode).find((n) => env.session.state.components[n.definitionId]?.componentId === 'blog.grid');
      expect(feed?.props).toMatchObject({ heading: 'Latest news', collection: 'posts', count: 3 });
      // The sections Home had stay.
      for (const id of before.pages[env.home].rootIds) expect(home.rootIds).toContain(id);
      // One step undoes the whole turn: the post, the new category and the feed.
      expect((await env.session.undoGroup(runId)).ok).toBe(true);
      expect(env.session.state.collections).toEqual(before.collections);
      expect(env.session.state.pages[env.home]).toEqual(before.pages[env.home]);
      await env.session.close();
    }
  });

  it('keeps a request sent from an open post to that post until the author allows more', async () => {
    const env = await setup([
      () => [call('r1', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_spring' })],
      () => [call('r2', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_winter' })],
      () => [call('u1', 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_winter', title: 'Rewritten' })],
      () => [call('u2', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Raw' }] })],
      () => [call('u3', 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', categories: ['News', 'Events'] })],
      () => [call('w1', 'request_clarification', { question: 'May I add an Events category?', widenScope: true })],
      () => [call('u5', 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', body: ['## Who is coming', 'Twenty new **makers** join us.', '![The kiln](asset:a_kiln "Our kiln")', '- Clay', '- Glass and enamel'] })],
      () => finish('Proofread the post.')
    ]);
    const before = structuredClone(env.session.state);
    await env.send('Proofread this post and file it under Events too.', { post: { collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio' } }, ['No, only change the post “Spring open studio”']);
    const first = env.adapter.requests[0];
    // History is the author's whole project's, so its Undo and Redo are offered beside the post's own tools (#1405).
    expect(first.tools.map((t) => t.name)).toEqual(['read_collection_entry', 'upsert_collection_entry', 'request_clarification', 'step_history']);
    expect(first.system).toMatch(/one post/);
    const context = JSON.parse(/<editor_context>\n([\s\S]*)\n<\/editor_context>/.exec((first.items.at(-1) as { text: string }).text)![1]);
    expect(context.currentPost).toEqual({ collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio' });
    expect(context.currentPage).toBeUndefined();
    expect(context.allowedScope).toMatch(/only the post “Spring open studio” \(posts\/en_spring\)/);
    expect(result(env.adapter.requests[1])).toContain('Spring open studio');
    // Another post's words, a write to it, a raw operation (no such tool here) and a new category are each refused; the
    // answer keeps the limit.
    expect(result(env.adapter.requests[2])).toMatch(/alone, so only it can be read/);
    expect(result(env.adapter.requests[2])).not.toContain('Read [the spring post]');
    expect(result(env.adapter.requests[3])).toMatch(/SCOPE_MISMATCH[\s\S]*outside the post/);
    expect(result(env.adapter.requests[4])).toMatch(/apply_operations/);
    expect(result(env.adapter.requests[5])).toMatch(/Adding the category “Events”/);
    expect(result(env.adapter.requests[6])).toMatch(/Keep changes within the post “Spring open studio”/);
    expect(result(env.adapter.requests[7])).toMatch(/"ok\\":true/);
    // Only the post's text changed; every other detail, the other post and the pages are as they were.
    const after = entry(env.session.state, 'en_spring');
    expect(JSON.stringify(after.body)).toContain('Glass and enamel');
    expect({ ...after, body: undefined }).toEqual({ ...entry(before, 'en_spring'), body: undefined });
    expect(after.body[2]).toEqual(entry(before, 'en_spring').body[2]);
    expect(entry(env.session.state, 'en_winter')).toEqual(entry(before, 'en_winter'));
    expect(env.session.state.collections.posts.settings).toEqual(before.collections.posts.settings);
    expect(env.session.state.pages).toEqual(before.pages);
  });

  it('places a feed of posts on a page from a request limited to that page, with no items of its own', async () => {
    const env = await setup([
      () => [call('p1', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'blog.list', props: { heading: 'Latest news', collection: 'posts', category: 'news', count: 2 } }] })],
      () => [call('p2', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'blog.grid', props: { heading: 'More', items: [{ title: 'Typed by hand' }] } }] })],
      () => finish('Added the feed.')
    ]);
    const before = structuredClone(env.session.state);
    await env.send('Add a Latest news list to this page.', { scope: 'page' });
    expect(env.adapter.requests[0].tools.map((t) => t.name)).not.toContain('upsert_collection_entry');
    expect(result(env.adapter.requests[2])).toMatch(/fills itself from a collection's published entries/);
    const home = env.session.state.pages[env.home];
    const feeds = home.rootIds.map((id) => home.nodes[id] as InstanceNode).filter((n) => env.session.state.components[n.definitionId]?.componentId?.startsWith('blog.'));
    expect(feeds.map((n) => n.props)).toEqual([expect.objectContaining({ heading: 'Latest news', collection: 'posts', category: 'news', count: 2 })]);
    expect(env.session.state.collections).toEqual(before.collections);
  });

  it('adds a category once the author allows more', async () => {
    const env = await setup([
      () => [call('w1', 'request_clarification', { question: 'May I add an Events category?', widenScope: true })],
      () => [call('u1', 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', categories: ['News', 'Events'] })],
      () => finish('Filed it under Events.')
    ]);
    await env.send('File this under a new Events category.', { post: { collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio' } }, ['Yes, allow changes across the whole site']);
    expect(entry(env.session.state, 'en_spring').terms.categories).toEqual(['news', 'events']);
  });

  it('refuses a request about a post that has gone, or one that names more than the post', async () => {
    const env = await setup([]);
    const home = env.home;
    const base = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
    expect(await env.orch.send('Tighten it', { ...base, post: { collectionId: 'posts', entryId: 'en_gone', title: 'Old post' } })).toMatchObject({ ok: false, message: 'The post “Old post” is no longer in the site. Open a post, then send again.' });
    expect(await env.orch.send('Tighten it', { ...base, scope: 'site', post: { collectionId: 'posts', entryId: 'en_spring', title: 'Spring' } })).toMatchObject({ ok: false });
    expect(await env.orch.send('Tighten it', { ...base, post: { collectionId: 'posts', entryId: 7, title: 'Spring' } } as unknown as ChatContext)).toMatchObject({ ok: false });
  });
});

describe('long post reads in the context budget', () => {
  const user = (text: string): CanonicalItem => ({ kind: 'user', text });
  const asks = (id: string, name: string, args: unknown): CanonicalItem => ({ kind: 'assistant', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
  const answer = (id: string, name: string, content: unknown): CanonicalItem => ({ kind: 'tool_result', callId: id, name, content: JSON.stringify(content) });
  const part = (entryId: string, offset: number) => ({ revision: 1, collectionId: 'posts', entryId, ...(offset === 0 ? { title: 'Spring open studio' } : {}), format: 'markdown', length: 20000, offset, next: offset + 4000, text: 'x'.repeat(4000) });
  const budget = (items: CanonicalItem[], window: number) =>
    applyContextBudget(items, { system: 'system', tools: [], capabilities: { contextWindowTokens: window, maxOutputTokens: 1000 }, isMutation: (n) => n === 'upsert_collection_entry' });

  it('collapses a part read again, and the parts of a post once it is written, but never a part still needed', () => {
    const items: CanonicalItem[] = [
      user('Proofread the spring post'),
      asks('a', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_spring' }),
      answer('a', 'read_collection_entry', part('en_spring', 0)),
      asks('b', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_spring', offset: 4000 }),
      answer('b', 'read_collection_entry', part('en_spring', 4000)),
      asks('c', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_winter' }),
      answer('c', 'read_collection_entry', { ...part('en_winter', 0), text: `Mentions en_spring. ${'y'.repeat(3980)}` }),
      asks('d', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_spring' }),
      answer('d', 'read_collection_entry', part('en_spring', 0)),
      asks('l', 'list_collection_entries', { collectionId: 'posts', offset: 10 }),
      answer('l', 'list_collection_entries', { revision: 1, collectionId: 'posts', total: 12, offset: 10, next: null, entries: [{ entryId: 'en_spring', title: 'x'.repeat(3000) }] }),
      asks('e', 'upsert_collection_entry', { collectionId: 'posts', entryId: 'en_spring', body: ['short'] }),
      answer('e', 'upsert_collection_entry', { ok: true, revision: 2, collectionId: 'posts', entryId: 'en_spring' }),
      asks('f', 'list_collection_entries', { collectionId: 'posts' }),
      answer('f', 'list_collection_entries', { revision: 2, collectionId: 'posts', total: 2, offset: 0, next: null, entries: [] }),
      asks('g', 'read_collection_entry', { collectionId: 'posts', entryId: 'en_winter', offset: 4000 }),
      answer('g', 'read_collection_entry', part('en_winter', 4000))
    ];
    /** A collapsed result as the line it shows, once it is checked to be a result like any other: ok, at a revision. */
    const shown = (item: unknown) => {
      const content = (item as { content: string }).content;
      const body = JSON.parse(content) as Record<string, unknown>;
      if (typeof body.superseded !== 'string') return content;
      expect(body).toEqual({ ok: true, revision: expect.any(Number), superseded: body.superseded });
      return `[Superseded ${body.superseded}]`;
    };
    // Just past half the window: only the part read again collapses.
    const soft = structuredClone(items);
    const r = budget(soft, 9600);
    expect(r.tombstoned).toBe(1);
    expect(shown(soft[2])).toBe('[Superseded read_collection_entry posts/en_spring "Spring open studio" of 20000 characters at rev 1. Read this part again before relying on its text or rewriting it.]');
    expect(shown(soft[4])).not.toMatch(/^\[Superseded/);
    expect(shown(soft[10])).not.toMatch(/^\[Superseded/);
    // Tighter: the spring post's parts went out of date when it was written; the winter post, which only names it, did not.
    const hard = structuredClone(items);
    budget(hard, 4000);
    expect(shown(hard[4])).toBe('[Superseded read_collection_entry posts/en_spring from offset 4000 of 20000 characters at rev 1. Read this part again before relying on its text or rewriting it.]');
    expect(shown(hard[8])).toMatch(/^\[Superseded read_collection_entry posts\/en_spring "Spring open studio"/);
    expect(shown(hard[6])).toContain('Mentions en_spring');
    // A list of the collection went out of date with the write too.
    expect(shown(hard[10])).toBe('[Superseded list_collection_entries posts from offset 10, 12 entries at rev 1. List it again for the current entries.]');
    // The latest turns are still being worked from.
    expect(shown(hard[14])).not.toMatch(/^\[Superseded/);
    expect(shown(hard[16])).not.toMatch(/^\[Superseded/);
  });
});
