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
import { readState } from '../../src/main/project/documents';

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
    expect(read(dir, `${POSTS}/collection.json`)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      id: 'posts',
      name: 'Posts',
      route: '/blog/',
      taxonomies: { categories: { label: 'Categories', terms: {} }, tags: { label: 'Tags', terms: {} } },
      fields: {}
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
    const r = await ok(again.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: false }] }, { label: 'Publish' }));
    expect((r as { changed?: string[] }).changed).toEqual([`${POSTS}/entries/en_spring.json`]);
  });

  it('undoes and redoes a whole batch as one step, removing and restoring the folder', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const files = (rel: string) => readFileSync(join(dir, rel), 'utf8');
    const before = [files(`${POSTS}/collection.json`), files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)];
    await ok(s.undo());
    expect(s.state.collections).toEqual({});
    expect(existsSync(join(dir, POSTS))).toBe(false);
    await ok(s.redo());
    expect(Object.keys(s.state.collections.posts.entries).sort()).toEqual(['en_spring', 'en_winter']);
    expect([files(`${POSTS}/collection.json`), files(`${POSTS}/entries/en_spring.json`), files(`${POSTS}/entries/en_winter.json`)]).toEqual(before);
  });

  it('deletes a collection with every entry, keeps a file of the author’s in its folder, and undoes the delete', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    writeFileSync(join(dir, POSTS, 'notes.txt'), 'mine');
    await ok(s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Delete Posts' }));
    expect(existsSync(join(dir, `${POSTS}/collection.json`))).toBe(false);
    expect(existsSync(join(dir, POSTS, 'entries'))).toBe(false);
    expect(readFileSync(join(dir, POSTS, 'notes.txt'), 'utf8')).toBe('mine');
    await ok(s.undo());
    expect(read(dir, `${POSTS}/entries/en_winter.json`).title).toBe('Winter hours');
    expect(Object.keys(s.state.collections.posts.entries)).toHaveLength(2);
    // Deleting the last entry keeps the collection.
    await ok(s.apply({ operations: [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' }, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }] }, { label: 'Empty' }));
    expect(existsSync(join(dir, POSTS, 'entries'))).toBe(false);
    expect(read(dir, `${POSTS}/collection.json`).id).toBe('posts');
  });

  it('refuses a guarded change and leaves the files as they were', async () => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: blog }, { label: 'Start the blog' }));
    const r = await s.apply({ operations: [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }] }, { label: 'Delete' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/1 link point to “Spring open studio”/);
    expect(existsSync(join(dir, `${POSTS}/entries/en_spring.json`))).toBe(true);
  });

  it('keeps collections out of the assistant’s reach', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'posts' }] }, { label: 'AI', source: 'ai' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'SCOPE_MISMATCH' });
    expect(s.state.collections).toEqual({});
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
    // A file named for another entry.
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_park.json'), JSON.stringify(entry));
    await expect(readState(dir)).rejects.toThrow(/en_park\.json has a mismatched id "en_hall"/);
    rmSync(join(dir, 'siteorigin/collections/projects/entries/en_park.json'));
    rmSync(join(dir, 'siteorigin/collections/projects/collection.json'));
    await expect(readState(dir)).rejects.toThrow(/en_hall\.json belongs to a collection that has no collection\.json/);
    // An entry written by a newer app makes the project read-only here.
    writeFileSync(join(dir, 'siteorigin/collections/projects/collection.json'), JSON.stringify(settings));
    writeFileSync(join(dir, 'siteorigin/collections/projects/entries/en_hall.json'), JSON.stringify({ ...entry, schemaVersion: SCHEMA_VERSION + 1 }));
    await expect(readState(dir)).rejects.toThrow(/newer version/);
  });
});
