/**
 * Collections on disk (#392): settings and every entry are readable JSON files of their own under
 * siteorigin/collections/, saved through the journal like every other document, undone and redone as one step per
 * change, kept in saved versions, and read back exactly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditOperation } from '@shared/ops';
import { SCHEMA_VERSION } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';
import { newestStoredVersion, readState } from '../../src/main/project/documents';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-collections-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Collections', false));
  open.push(s);
  return { dir, s };
}

const POSTS = 'siteorigin/collections/posts';
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const ok = async (p: Promise<{ ok: boolean; error?: { message: string } }>) => {
  const r = await p;
  expect(r.error?.message).toBeUndefined();
  expect(r.ok).toBe(true);
  return r;
};

const blog: EditOperation[] = [
  { type: 'collection.create', collectionId: 'posts' },
  { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', body: ['Twenty new **makers**.'] },
  { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14', body: ['Read [the spring post](entry:en_spring).'] }
];

describe('collections on disk', () => {
  it('writes settings and each entry as a readable file, and reads them back exactly', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    expect(readdirSync(join(dir, POSTS)).sort()).toEqual(['collection.json', 'entries']);
    expect(readdirSync(join(dir, POSTS, 'entries')).sort()).toEqual(['en_spring.json', 'en_winter.json']);
    // The layout every entry is shown with is the collection's own, kept with its settings.
    expect(read(dir, `${POSTS}/collection.json`)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      id: 'posts',
      name: 'Posts',
      route: '/blog/',
      taxonomies: { categories: { label: 'Categories', terms: {} }, tags: { label: 'Tags', terms: {} } },
      fields: {},
      template: s.state.collections.posts.settings.template
    });
    const text = readFileSync(join(dir, `${POSTS}/entries/en_winter.json`), 'utf8');
    // Pretty-printed, like every other document.
    expect(text).toContain('\n  "slug": "winter-hours",\n');
    expect(JSON.parse(text)).toMatchObject({ id: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14', draft: true, body: [{ type: 'p', spans: [{ text: 'Read ' }, { text: 'the spring post', link: { type: 'entry', target: 'en_spring' } }, { text: '.' }] }] });
    const state = s.state;
    await s.close();
    const again = await ProjectSession.open(dir, 'reopen');
    open.push(again);
    expect(again.state.collections).toEqual(state.collections);
    // An entry's edit rewrites that entry's file and nothing else.
    const r = await ok(again.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: false, publishedAt: '2020-01-01' }] }, { label: 'Publish' }));
    expect((r as { changed?: string[] }).changed).toEqual([`${POSTS}/entries/en_spring.json`]);
    await ok(again.apply({ operations: [{ type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_winter'] }] }, { label: 'Order' }));
    expect(read(dir, `${POSTS}/entries/en_spring.json`)).toMatchObject({ draft: false, publishedAt: '2020-01-01' });
    expect(read(dir, `${POSTS}/collection.json`).entryOrder).toEqual(['en_spring', 'en_winter']);
    const published = again.state.collections;
    await again.close();
    const third = await ProjectSession.open(dir, 'third');
    open.push(third);
    expect(third.state.collections).toEqual(published);
  });

  it('undoes and redoes a whole batch as one step, removing and restoring the folder', async () => {
    const { dir, s } = await make();
    // A collection made earlier is left alone by both.
    await ok(s.apply({ operations: [{ type: 'collection.create', collectionId: 'projects' }, { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Hall' }] }, { label: 'Projects' }));
    const projects = readFileSync(join(dir, 'siteorigin/collections/projects/entries/en_hall.json'), 'utf8');
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const files = (rel: string) => readFileSync(join(dir, rel), 'utf8');
    const before = [files(`${POSTS}/collection.json`), files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)];
    await ok(s.undo());
    expect(Object.keys(s.state.collections)).toEqual(['projects']);
    expect(existsSync(join(dir, POSTS))).toBe(false);
    await ok(s.redo());
    expect(Object.keys(s.state.collections.posts.entries).sort()).toEqual(['en_spring', 'en_winter']);
    expect([files(`${POSTS}/collection.json`), files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)]).toEqual(before);
    expect(files('siteorigin/collections/projects/entries/en_hall.json')).toBe(projects);
    expect(Object.keys(s.state.collections.projects.entries)).toEqual(['en_hall']);
  });

  it('renames a category across its settings, its posts and a list of posts on a page as one step, undone and redone together (#396)', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: [...blog, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News' }] }, { label: 'Start the blog' }));
    await ok(s.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', terms: { categories: ['news'] } }] }, { label: 'File' }));
    const home = s.state.site.homePageId;
    const placed = await ok(s.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: home }, componentId: 'blog.grid', props: { category: 'News' } }] }, { label: 'Latest news' }));
    const nodeId = (placed as { results?: Array<Record<string, unknown>> }).results![0].nodeId as string;
    const files = (rel: string) => readFileSync(join(dir, rel), 'utf8');
    const pageFile = readdirSync(join(dir, 'siteorigin/pages')).find((f) => read(dir, `siteorigin/pages/${f}`).id === home)!;
    const shown = () => [files(`${POSTS}/collection.json`), files(`${POSTS}/entries/en_spring.json`), files(`siteorigin/pages/${pageFile}`)];
    const before = shown();
    await ok(s.apply({ operations: [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio news' }] }, { label: 'Rename category' }));
    expect(read(dir, `${POSTS}/collection.json`).taxonomies.categories.terms).toEqual({ 'studio-news': { label: 'Studio news' } });
    expect(read(dir, `${POSTS}/entries/en_spring.json`).terms).toEqual({ categories: ['studio-news'] });
    expect(read(dir, `siteorigin/pages/${pageFile}`).nodes[nodeId].props.category).toBe('studio-news');
    const after = shown();
    await ok(s.undo());
    expect(shown()).toEqual(before);
    await ok(s.redo());
    expect(shown()).toEqual(after);
  });

  it('saves a layout edit in the collection’s settings alone, undoes it as one step, and keeps it from the assistant', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const files = (rel: string) => readFileSync(join(dir, rel), 'utf8');
    const entries = [files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)];
    const settings = files(`${POSTS}/collection.json`);
    const t = s.state.collections.posts.settings.template;
    const title = Object.values(t.nodes).find((n) => n.kind === 'text' && JSON.stringify(n.text) === '{"$entry":"title"}')!;
    const owner = { kind: 'template' as const, id: 'posts' };
    const edit: EditOperation = { type: 'node.setStyle', owner, nodeId: title.id, scope: 'base', property: 'color', value: '#aa0000' };
    // The assistant has no tools for collections yet, their layouts included.
    const ai = await s.apply({ operations: [edit] }, { label: 'AI', source: 'ai' });
    expect(ai).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    await ok(s.apply({ operations: [edit] }, { label: 'Style the title' }));
    expect(read(dir, `${POSTS}/collection.json`).template.nodes[title.id].styles.base.color).toBe('#aa0000');
    expect([files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)]).toEqual(entries);
    // A binding to a field the entries lack is refused where it is made.
    const bad = await s.apply({ operations: [{ type: 'node.setBinding', owner, nodeId: title.id, field: 'text', binding: { $entry: 'field.nope' } }] }, { label: 'Bind' });
    expect(bad.ok).toBe(false);
    // A custom field the layout shows can't be removed (and brought back in the same batch) under it: every entry's
    // value would be dropped.
    await ok(
      s.apply(
        {
          operations: [
            { type: 'collection.update', collectionId: 'posts', fields: { price: { type: 'string', label: 'Price' } } },
            { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', values: { price: '£10' } },
            { type: 'node.setBinding', owner, nodeId: title.id, field: 'text', binding: { $entry: 'field.price' } }
          ]
        },
        { label: 'Show the price' }
      )
    );
    const bound = files(`${POSTS}/collection.json`);
    const spring = files(`${POSTS}/entries/en_spring.json`);
    const gone = await s.apply(
      { operations: [{ type: 'collection.update', collectionId: 'posts', fields: {} }, { type: 'collection.update', collectionId: 'posts', fields: { price: { type: 'string', label: 'Price' } } }] },
      { label: 'Remove and restore the price' }
    );
    expect(gone.ok).toBe(false);
    expect(gone.error?.message).toMatch(/layout shows Price\. Unbind it in the layout before removing it/);
    expect([files(`${POSTS}/collection.json`), files(`${POSTS}/entries/en_spring.json`)]).toEqual([bound, spring]);
    await ok(s.undo());
    await ok(s.undo());
    expect(files(`${POSTS}/collection.json`)).toBe(settings);
    expect([files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)]).toEqual(entries);
  });

  it('deletes a collection with every entry, keeps a file of the author’s in its folder, and undoes the delete', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const kept = structuredClone(s.state.collections);
    writeFileSync(join(dir, POSTS, 'notes.txt'), 'mine');
    await ok(s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Delete Posts' }));
    expect(existsSync(join(dir, `${POSTS}/collection.json`))).toBe(false);
    expect(existsSync(join(dir, POSTS, 'entries'))).toBe(false);
    expect(readFileSync(join(dir, POSTS, 'notes.txt'), 'utf8')).toBe('mine');
    await ok(s.undo());
    // Every document comes back whole, text and links included.
    expect(s.state.collections).toEqual(kept);
    expect(read(dir, `${POSTS}/entries/en_winter.json`)).toEqual(kept.posts.entries.en_winter);
    expect(read(dir, `${POSTS}/collection.json`)).toEqual(kept.posts.settings);
    // Deleting the last entry keeps the collection.
    await ok(s.apply({ operations: [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }] }, { label: 'Empty' }));
    expect(existsSync(join(dir, POSTS, 'entries'))).toBe(false);
    expect(read(dir, `${POSTS}/collection.json`).id).toBe('posts');
  });

  it('refuses a guarded change and leaves the files, the project and its history as they were', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const files = () => [`${POSTS}/entries/en_spring.json`, `${POSTS}/entries/en_winter.json`].map((p) => readFileSync(join(dir, p), 'utf8'));
    const before = { files: files(), state: structuredClone(s.state.collections), revision: s.revision, history: s.historyInfo() };
    // A valid edit first, then the refused removal: the whole batch is refused.
    const r = await s.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Changed' }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }] }, { label: 'Delete' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/1 link point to “Spring open studio”/);
    expect({ files: files(), state: s.state.collections, revision: s.revision, history: s.historyInfo() }).toEqual(before);
  });

  it('keeps collections out of the assistant’s reach', async () => {
    const { s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const before = structuredClone(s.state.collections);
    const ops: EditOperation[] = [
      { type: 'collection.create', collectionId: 'projects' },
      { type: 'collection.update', collectionId: 'posts', name: 'News' },
      { type: 'collection.remove', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', title: 'AI post' },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'AI title' },
      { type: 'entry.reorder', collectionId: 'posts', entryIds: null },
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' }
    ];
    const refused = async (op: EditOperation, opts: Parameters<ProjectSession['apply']>[1]) => {
      const r = await s.apply({ operations: [op] }, opts);
      expect(r.ok, `${op.type} ${JSON.stringify(opts)}`).toBe(false);
      expect(r.error).toMatchObject({ code: 'SCOPE_MISMATCH' });
    };
    for (const op of ops) await refused(op, { label: 'AI', source: 'ai' });
    // Inside a run, the run alone says it is the assistant's.
    expect(await s.beginRun('run_ai')).toBeNull();
    for (const op of ops) await refused(op, { label: 'AI', runId: 'run_ai', history: false });
    expect(s.state.collections).toEqual(before);
  });

  it('waits for an entry added outside the app before a change that depends on every entry', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: [...blog, { type: 'collection.create', collectionId: 'projects' }] }, { label: 'Start' }));
    // Added on disk, not yet loaded: it links to a post.
    const late = { schemaVersion: SCHEMA_VERSION, id: 'en_late', slug: 'late', title: 'Late', publishedAt: '2026-01-01', draft: true, terms: {}, values: {}, body: [{ type: 'p', spans: [{ text: 'Spring', link: { type: 'entry', target: 'en_spring' } }] }] };
    mkdirSync(join(dir, 'siteorigin/collections/projects/entries'), { recursive: true });
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_late.json'), JSON.stringify(late));
    const r = await s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Delete Posts' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CONFLICT');
    expect(existsSync(join(dir, `${POSTS}/entries/en_spring.json`))).toBe(true);
    // An edit that reads no other entry goes ahead.
    await ok(s.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', excerpt: 'Short' }] }, { label: 'Excerpt' }));
    // So does a new page's address, which must be free of the unloaded entry's: it waits for it.
    writeFileSync(join(dir, `${POSTS}/entries/en_launch.json`), JSON.stringify({ ...late, id: 'en_launch', slug: 'launch', body: [] }));
    const page = await s.apply({ operations: [{ type: 'page.create', title: 'Launch', route: '/blog/launch/' }] }, { label: 'Add page' });
    expect(page.error?.code).toBe('CONFLICT');
    expect(Object.values(s.state.pages).some((p) => p.route === '/blog/launch/')).toBe(false);
  });

  it('waits for a source attached to the collection outside the app before editing one of its entries (#673)', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start' }));
    // A sync attached it on disk; the app has not loaded that yet.
    writeFileSync(join(dir, `${POSTS}/collection.json`), JSON.stringify({ ...read(dir, `${POSTS}/collection.json`), sourceId: 'wordpress' }, null, 2));
    const r = await s.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Changed' }] }, { label: 'Retitle' });
    expect(r.error?.code).toBe('CONFLICT');
    expect(read(dir, `${POSTS}/entries/en_winter.json`).title).toBe('Winter hours');
    expect(s.state.collections.posts.entries.en_winter.title).toBe('Winter hours');
    // Any change that would rewrite one of its entries waits for it, whatever else it is: a page removed, say, whose
    // links an entry holds.
    const { dir: other, s: second } = await make();
    await ok(second.apply({ operations: blog }, { label: 'Start' }));
    const contact = Object.values(second.state.pages).find((p) => p.route === '/contact/')!;
    const about = Object.values(second.state.pages).find((p) => p.route === '/about/')!;
    await ok(second.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['[Contact us](/contact/).'] }] }, { label: 'Link' }));
    writeFileSync(join(other, `${POSTS}/collection.json`), JSON.stringify({ ...read(other, `${POSTS}/collection.json`), sourceId: 'wordpress' }, null, 2));
    const removed = await second.apply({ operations: [{ type: 'page.remove', pageId: contact.id, replacementPageId: about.id }] }, { label: 'Remove Contact' });
    expect(removed.error?.code).toBe('CONFLICT');
    expect(second.state.pages[contact.id]).toBeDefined();
  });

  it('never undoes an edit of an entry whose collection has been synced since (#673)', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start' }));
    await ok(s.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Changed' }] }, { label: 'Retitle' }));
    await s.close();
    // A sync attached it while the project was closed, leaving the entry as it was.
    writeFileSync(join(dir, `${POSTS}/collection.json`), JSON.stringify({ ...read(dir, `${POSTS}/collection.json`), sourceId: 'wordpress' }, null, 2));
    const again = await ProjectSession.open(dir, 'reopen');
    open.push(again);
    expect(again.state.collections.posts.settings.sourceId).toBe('wordpress');
    const r = await again.undo();
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/synced from an external source/);
    expect(read(dir, `${POSTS}/entries/en_winter.json`).title).toBe('Changed');
  });

  it('holds an entry a cancelled AI run wrote when its collection was synced outside the app meanwhile (#673)', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start' }));
    expect(await s.beginRun('run_sync')).toBeNull();
    // Through its post tool, whose call grants this one entry.
    await ok(s.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'By the AI' }] }, { label: 'AI', source: 'ai', runId: 'run_sync', history: false, collectionWrite: { kind: 'entry', collectionId: 'posts', entryId: 'en_winter' } }));
    writeFileSync(join(dir, `${POSTS}/collection.json`), JSON.stringify({ ...read(dir, `${POSTS}/collection.json`), sourceId: 'wordpress' }, null, 2));
    const r = await s.abortRun();
    expect(r.restored).toBe(false);
    // Never taken back under the source: the run's version stays on disk, the earlier one held for the author.
    expect(read(dir, `${POSTS}/entries/en_winter.json`).title).toBe('By the AI');
  });

  it('writes a structured collection’s settings and fields and reads them back exactly (#673)', async () => {
    const { dir, s } = await make();
    await ok(
      s.apply(
        {
          operations: [
            { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false } },
            { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz' },
            { type: 'collection.create', collectionId: 'events', kind: 'structured', fields: { on: { type: 'date', label: 'On' }, host: { type: 'reference', label: 'Host', collection: 'team' }, notes: { type: 'richtext', label: 'Notes' }, tickets: { type: 'link', label: 'Tickets' } } },
            { type: 'entry.create', collectionId: 'events', entryId: 'en_open', title: 'Open day', values: { on: '2027-05-01', host: 'en_ruiz', notes: 'Bring **friends**.', tickets: 'https://tickets.example.com' } }
          ]
        },
        { label: 'Add team and events' }
      )
    );
    expect(read(dir, 'siteorigin/collections/team/collection.json')).toMatchObject({ kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false } });
    expect(read(dir, 'siteorigin/collections/team/collection.json')).not.toHaveProperty('route');
    expect(read(dir, 'siteorigin/collections/events/entries/en_open.json').values).toEqual({
      on: '2027-05-01',
      host: 'en_ruiz',
      notes: [{ type: 'p', spans: [{ text: 'Bring ' }, { text: 'friends', strong: true }, { text: '.' }] }],
      tickets: { type: 'url', target: 'https://tickets.example.com' }
    });
    const state = s.state;
    await s.close();
    const again = await ProjectSession.open(dir, 'reopen');
    open.push(again);
    expect(again.state.collections).toEqual(state.collections);
  });

  it('refuses an undo that would leave an entry without its collection or beside another with its ID', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring' }] }, { label: 'Blog' }));
    await ok(s.apply({ operations: [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }] }, { label: 'Remove Spring' }));
    // The collection goes without a step of its own (as an AI run's provisional change would).
    await ok(s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Silent', history: false }));
    const cursor = s.historyInfo();
    const r = await s.undo();
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/en_spring\.json would have no collection/);
    expect(s.historyInfo()).toEqual(cursor);
    // Another collection now has an entry with the same ID.
    await ok(s.apply({ operations: [{ type: 'collection.create', collectionId: 'posts' }] }, { label: 'Posts again', history: false }));
    await s.close();
    mkdirSync(join(dir, 'siteorigin/collections/projects/entries'), { recursive: true });
    writeFileSync(join(dir, 'siteorigin/collections/projects/collection.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: 'projects', name: 'Projects', route: '/projects/', taxonomies: {}, fields: {} }));
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_spring.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: 'en_spring', slug: 'spring', title: 'Other', publishedAt: '2026-01-01', draft: true, terms: {}, values: {}, body: [] }));
    const again = await ProjectSession.open(dir, 'again');
    open.push(again);
    const dup = await again.undo();
    expect(dup.ok).toBe(false);
    expect(dup.error?.message).toMatch(/would share its entry ID with another entry/);
  });

  it('keeps collections in a saved version and brings them back on restore', async () => {
    const { s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const saved = await s.saveVersion('With blog');
    expect(saved.ok).toBe(true);
    await ok(s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Delete Posts' }));
    const { review } = (await s.reviewVersion(saved.id!)) as { review: { revision: number } };
    await ok(s.restoreVersion(saved.id!, review.revision) as Promise<{ ok: boolean }>);
    expect(Object.keys(s.state.collections.posts.entries).sort()).toEqual(['en_spring', 'en_winter']);
  });

  it('reads a collection added outside the app, and refuses an entry without its collection', async () => {
    const { dir, s } = await make();
    await s.close();
    mkdirSync(join(dir, 'siteorigin/collections/projects/entries'), { recursive: true });
    const settings = { schemaVersion: SCHEMA_VERSION, id: 'projects', name: 'Projects', route: '/projects/', taxonomies: {}, fields: {} };
    const entry = { schemaVersion: SCHEMA_VERSION, id: 'en_hall', slug: 'town-hall', title: 'Town hall', publishedAt: '2026-01-01', draft: false, terms: {}, values: {}, body: [] };
    writeFileSync(join(dir, 'siteorigin/collections/projects/collection.json'), JSON.stringify(settings));
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_hall.json'), JSON.stringify(entry));
    expect((await readState(dir)).collections.projects).toEqual({ settings, entries: { en_hall: entry } });
    // A note beside the collections is not one; settings in a folder no collection can be named stop the read.
    writeFileSync(join(dir, 'siteorigin/collections/README.md'), 'notes');
    expect(Object.keys((await readState(dir)).collections)).toEqual(['projects']);
    mkdirSync(join(dir, 'siteorigin/collections/Case_Studies'));
    writeFileSync(join(dir, 'siteorigin/collections/Case_Studies/collection.json'), JSON.stringify({ ...settings, id: 'Case_Studies' }));
    await expect(readState(dir)).rejects.toThrow(/Case_Studies is not a valid collection folder name/);
    rmSync(join(dir, 'siteorigin/collections/Case_Studies'), { recursive: true });
    // A file named for another entry, a file named like no entry, settings for another collection, and one entry ID in two collections.
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_park.json'), JSON.stringify(entry));
    await expect(readState(dir)).rejects.toThrow(/en_park\.json has a mismatched id "en_hall"/);
    rmSync(join(dir, 'siteorigin/collections/projects/entries/en_park.json'));
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/draft.json'), JSON.stringify(entry));
    await expect(readState(dir)).rejects.toThrow(/draft\.json is not named like an entry/);
    rmSync(join(dir, 'siteorigin/collections/projects/entries/draft.json'));
    writeFileSync(join(dir, 'siteorigin/collections/projects/collection.json'), JSON.stringify({ ...settings, id: 'works' }));
    await expect(readState(dir)).rejects.toThrow(/projects\/collection\.json has a mismatched id "works"/);
    writeFileSync(join(dir, 'siteorigin/collections/projects/collection.json'), JSON.stringify(settings));
    mkdirSync(join(dir, 'siteorigin/collections/works/entries'), { recursive: true });
    writeFileSync(join(dir, 'siteorigin/collections/works/collection.json'), JSON.stringify({ ...settings, id: 'works', route: '/works/' }));
    writeFileSync(join(dir, 'siteorigin/collections/works/entries/en_hall.json'), JSON.stringify(entry));
    await expect(readState(dir)).rejects.toThrow(/works\/entries\/en_hall\.json has the same entry ID as an entry of another collection/);
    rmSync(join(dir, 'siteorigin/collections/works'), { recursive: true });
    rmSync(join(dir, 'siteorigin/collections/projects/collection.json'));
    await expect(readState(dir)).rejects.toThrow(/en_hall\.json belongs to a collection that has no collection\.json/);
    // An entry written by a newer app makes the project read-only here, even past a broken document.
    writeFileSync(join(dir, 'siteorigin/collections/projects/collection.json'), JSON.stringify(settings));
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_hall.json'), JSON.stringify({ ...entry, schemaVersion: SCHEMA_VERSION + 1 }));
    await expect(readState(dir)).rejects.toThrow(/newer version/);
    writeFileSync(join(dir, 'siteorigin/tokens.json'), '{ broken');
    await expect(newestStoredVersion(dir)).resolves.toBe(SCHEMA_VERSION + 1);
  });
});

describe('custom field values on disk (#675)', () => {
  it('writes every kind of field into the entry’s own file, each change one step to undo and redo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-collections-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'static/assets'), { recursive: true });
    writeFileSync(join(dir, 'static/assets/ana-1a2b3c4d.png'), 'png');
    const state = createStarterState('business', 'Collections', false);
    state.assets.assets.img_ana = { id: 'img_ana', name: 'Ana', file: 'static/assets/ana-1a2b3c4d.png', mime: 'image/png', bytes: 3, width: 10, height: 10, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' };
    const s = await ProjectSession.create(dir, state);
    open.push(s);
    const text = (label: string) => ({ type: 'string', label, default: '' });
    await ok(
      s.apply(
        {
          operations: [
            {
              type: 'collection.create',
              collectionId: 'team',
              kind: 'structured',
              singularName: 'Team member',
              hasBody: false,
              pages: { detail: false, archive: false },
              taxonomies: { departments: { label: 'Departments', terms: { studio: { label: 'Studio' } } } },
              fields: {
                role: text('Role'),
                years: { type: 'number', label: 'Years', default: 0 },
                featured: { type: 'boolean', label: 'Featured', default: false },
                level: { type: 'enum', label: 'Level', default: 'junior', options: [ { value: 'junior', label: 'Junior' }, { value: 'senior', label: 'Senior' } ] },
                photo: { type: 'image', label: 'Photo', default: { assetId: null, alt: '' } },
                site: { type: 'link', label: 'Website', default: { type: 'none', target: '' } },
                bio: { type: 'richtext', label: 'Bio', default: [] },
                joined: { type: 'date', label: 'Joined', default: '' },
                mentor: { type: 'reference', label: 'Mentor', collection: 'team', default: '' }
              }
            },
            { type: 'entry.create', collectionId: 'team', entryId: 'en_ana1', title: 'Ana' },
            { type: 'entry.create', collectionId: 'team', entryId: 'en_ben1', title: 'Ben' }
          ]
        },
        { label: 'Add the Team collection' }
      )
    );
    const file = 'siteorigin/collections/team/entries/en_ben1.json';
    const values: Record<string, unknown> = {
      role: 'Glazer',
      years: 4,
      featured: true,
      level: 'senior',
      photo: { assetId: 'img_ana', alt: 'Ben at the wheel' },
      site: { type: 'url', target: 'https://example.com/' },
      bio: 'Makes **big** pots.',
      joined: '2024-05-01',
      mentor: 'en_ana1'
    };
    // One change per field, as the entry form sends them.
    for (const [name, value] of Object.entries(values)) await ok(s.apply({ operations: [{ type: 'entry.update', collectionId: 'team', entryId: 'en_ben1', values: { [name]: value } }] }, { label: `Change ${name}` }));
    await ok(s.apply({ operations: [{ type: 'entry.update', collectionId: 'team', entryId: 'en_ben1', terms: { departments: ['studio'] } }] }, { label: 'File under Studio' }));
    const saved = read(dir, file);
    expect(Object.keys(saved.values).sort()).toEqual(Object.keys(values).sort());
    expect(saved.values).toMatchObject({ role: 'Glazer', years: 4, featured: true, level: 'senior', joined: '2024-05-01', mentor: 'en_ana1', site: { type: 'url', target: 'https://example.com/' } });
    expect(saved.values.photo).toMatchObject({ assetId: 'img_ana', alt: 'Ben at the wheel' });
    expect(Array.isArray(saved.values.bio)).toBe(true);
    expect(saved.terms).toEqual({ departments: ['studio'] });
    await ok(s.undo());
    expect(read(dir, file).terms).toEqual({});
    await ok(s.undo());
    expect(Object.hasOwn(read(dir, file).values, 'mentor')).toBe(false);
    expect(read(dir, file).values.joined).toBe('2024-05-01');
    await ok(s.redo());
    await ok(s.redo());
    expect(read(dir, file)).toEqual(saved);
    // A dozen journalled writes: given the time a loaded machine needs for them.
  }, 30000);
});
