/**
 * Saved versions (issue 260): a named copy of the whole site, its documents and the media they name, kept apart from
 * the rolling undo history until the author deletes it. Restoring one is a single Undo step, and the work it replaces
 * is saved first as a version of its own, so the way back outlasts history too.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { sha } from '../../src/main/project/fsutil';
import { describeReview, othersOnly, restoredNotice } from '../../src/renderer/src/lib/versions';
import type { VersionReview } from '@shared/api';
import { inProcessGit, useTestGit } from './fixtures/git-in-process';
import { openRepo } from '../../src/main/git/repo';
import { GitError, VERSIONS_BRANCH, type GitRepository } from '../../src/main/git/protocol';
import { advanceVersions, writeVersionCommit } from '../../src/main/project/versions-git';
import { VersionStore, type SavedVersion } from '../../src/main/project/versions';
import type { EditOperation } from '@shared/ops';
import { deflateSync } from 'node:zlib';
import { denyAccess } from './deny-access';

// Saved versions reach Git as the app's do, through the worker's service run here; versions go to it only in a test
// run in Git mode (`both`), or one that turns it on (#1153).
const git = inProcessGit();
let stopGit: () => void = () => undefined;
beforeAll(() => {
  stopGit = useTestGit(git);
});
afterAll(() => stopGit());
beforeEach(() => {
  git.enabled = false;
});
type Mode = 'objects' | 'git';
/**
 * A test run twice: with versions saved to the plain store (Git snapshots off, the default) and to Git (on). Every
 * version either run leaves listed is checked to be in the store it ran with, so the Git run can never quietly pass on
 * the plain store. Saving to Git takes longer, so both runs have longer than the default.
 */
const both = (name: string, fn: (mode: Mode) => Promise<void>, timeout?: number) =>
  it.each<Mode>(['objects', 'git'])(
    `${name} [%s]`,
    async (mode) => {
      git.enabled = mode === 'git';
      await fn(mode);
      for (const d of dirs) {
        let rows: SavedVersion[] = [];
        try {
          rows = JSON.parse(readFileSync(join(d, '.siteorigin/versions/versions.json'), 'utf8')).versions;
        } catch {
          continue;
        }
        for (const v of rows) expect(!!v.git, `${v.name} is in ${mode === 'git' ? 'Git' : 'the plain store'}`).toBe(mode === 'git');
      }
    },
    timeout ?? 30_000
  );

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-versions-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Portfolio', false));
  open.push(s);
  return { dir, s };
}
async function reopen(dir: string) {
  const s = await ProjectSession.open(dir, 'test');
  open.push(s);
  return s;
}

async function ok<T extends { ok: boolean; message?: string; error?: { message: string } }>(p: Promise<T>): Promise<T> {
  const r = await p;
  expect(r.message ?? r.error?.message).toBeUndefined();
  expect(r.ok).toBe(true);
  return r;
}

const ASSETS = 'static/assets';
const BRIEF_PATH = 'siteorigin/brief.json';
const read = (dir: string, rel: string) => readFileSync(join(dir, rel));
const objects = (dir: string) => (existsSync(join(dir, '.siteorigin/versions/objects')) ? readdirSync(join(dir, '.siteorigin/versions/objects')).filter((f) => /^[a-f0-9]{64}$/.test(f)) : []);

/** An imported picture as the importer leaves it, original and two smaller copies, each file with its own bytes. */
function picture(dir: string, slug: string, seed: number): { asset: Omit<AssetRecord, 'id'>; files: string[]; bytes: Buffer[] } {
  mkdirSync(join(dir, ASSETS), { recursive: true });
  const original = Buffer.from(`${slug} original ${seed}`.repeat(40));
  const hash = sha(original);
  const stem = `${slug}-${hash.slice(0, 8)}`;
  const files = [`${ASSETS}/${stem}.png`, `${ASSETS}/${stem}-480w.png`, `${ASSETS}/${stem}-960w.png`];
  const bytes = [original, Buffer.from(`${slug} 480 ${seed}`), Buffer.from(`${slug} 960 ${seed}`)];
  files.forEach((f, i) => writeFileSync(join(dir, f), bytes[i]));
  return {
    asset: {
      name: slug,
      file: files[0],
      mime: 'image/png',
      bytes: original.length,
      hash,
      kind: 'image',
      createdAt: new Date().toISOString(),
      variants: [
        { width: 480, file: files[1] },
        { width: 960, file: files[2] }
      ]
    },
    files,
    bytes
  };
}

const describe1 = (s: ProjectSession, text: string, label: string) => ok(s.apply({ operations: [{ type: 'site.update', description: text }] }, { label }));

describe('saved versions', () => {
  both('keeps a version after 100 more edits and a reopen, and restores it as one Undo step with the way back saved', async (mode) => {
    const { dir, s } = await make();
    await ok(s.apply({ operations: [{ type: 'site.update', name: 'Approved design' }] }, { label: 'Rename site' }));
    await describe1(s, 'The approved portfolio.', 'Describe site');
    const approvedSite = read(dir, 'siteorigin/site.json').toString();
    const approvedPages = Object.keys(s.state.pages).sort();
    const home = s.state.site.homePageId;
    const homeTitle = s.state.pages[home].title;
    const started = Date.now();
    const saved = await ok(s.saveVersion('  Approved   portfolio '));
    const firstEntries = s.historyInfo().entries.map((e) => e.id);

    // A redesign: a page renamed, a new page and 101 more steps, so every step from before the save has rotated out.
    await ok(s.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Redesigned home' }] }, { label: 'Rename home' }));
    await ok(s.apply({ operations: [{ type: 'page.create', title: 'Experiments' }] }, { label: 'Add page' }));
    for (let i = 1; i <= 101; i++) await describe1(s, `Redesign ${i}`, `Edit ${i}`);
    const history = s.historyInfo().entries;
    expect(history).toHaveLength(100);
    for (const id of firstEntries) expect(history.some((e) => e.id === id)).toBe(false);

    await s.close();
    const again = await reopen(dir);
    const listed = again.versionsInfo().list;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: saved.id, name: 'Approved portfolio', auto: false, pages: approvedPages.length, missing: [] });
    expect(Date.parse(listed[0].time)).toBeGreaterThanOrEqual(started - 1000);
    expect(Date.parse(listed[0].time)).toBeLessThanOrEqual(started + 5000);
    // A version in Git frees nothing when deleted: its snapshot stays in the history.
    if (mode === 'git') expect(listed[0].bytes).toBeNull();
    else expect(listed[0].bytes).toBeGreaterThan(0);

    const { review } = await ok(again.reviewVersion(saved.id!));
    expect(review).toMatchObject({ site: true, unchanged: false, files: [], missing: [] });
    expect(review!.pages.gone).toEqual(['Experiments']);
    expect(review!.pages.changed).toEqual([homeTitle]);
    expect(review!.problem).toBeUndefined();

    const r = await ok(again.restoreVersion(saved.id!, review!.revision));
    expect(r.entryId).toBeTruthy();
    expect(r.backup?.name).toBe('Before restoring “Approved portfolio”');
    expect(read(dir, 'siteorigin/site.json').toString()).toBe(approvedSite);
    expect(Object.keys(again.state.pages).sort()).toEqual(approvedPages);
    expect(again.state.pages[home].title).toBe(homeTitle);
    // The project keeps its identity: the manifest is never part of what a restore changes.
    expect(again.state.manifest.projectId).toBe(s.state.manifest.projectId);
    const names = again.versionsInfo().list.map((v) => [v.name, v.auto]);
    // With Git snapshots on, the site as the restore left it is saved after it, on top of the history (#1155).
    expect(names).toEqual([
      ...(mode === 'git' ? [['Restored “Approved portfolio”', true]] : []),
      ['Before restoring “Approved portfolio”', true],
      ['Approved portfolio', false]
    ]);
    expect(again.historyInfo().undoLabel).toBe('Restore “Approved portfolio”');

    // One Undo step takes the restore back.
    await ok(again.undo());
    expect(again.state.site.description).toBe('Redesign 101');
    expect(Object.values(again.state.pages).some((p) => p.title === 'Experiments')).toBe(true);

    // And the version saved before restoring brings the redesign back after its undo step is long gone.
    await ok(again.redo());
    for (let i = 1; i <= 100; i++) await describe1(again, `Later ${i}`, `Later ${i}`);
    const back = await ok(again.reviewVersion(r.backup!.id));
    await ok(again.restoreVersion(r.backup!.id, back.review!.revision));
    expect(again.state.site.description).toBe('Redesign 101');
    expect(Object.values(again.state.pages).some((p) => p.title === 'Experiments')).toBe(true);
  }, 120_000);

  both('brings back an image after it was replaced and its old files were deleted, with every size', async (mode) => {
    const { dir, s } = await make();
    const a = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...a.asset } }] }, { label: 'Import photo' }));
    const saved = await ok(s.saveVersion('With the first photo'));

    // The image changes: the same library image now shows another picture, and freeing space deletes the old files.
    const b = picture(dir, 'photo', 2);
    const { name: _n, kind: _k, createdAt: _c, ...file } = b.asset;
    await ok(s.apply({ operations: [{ type: 'asset.relink', assetId: 'a_photo', ...file }] }, { label: 'Change photo' }));
    const plan = (await s.storageInfo()).reclaim!;
    expect(plan.files.files).toBe(3);
    await ok(s.reclaimStorage(plan.key));
    for (const f of a.files) expect(existsSync(join(dir, f))).toBe(false);
    expect((await s.storageInfo()).versions.count).toBe(1);

    await s.close();
    const again = await reopen(dir);
    const { review } = await ok(again.reviewVersion(saved.id!));
    expect(review!.library).toBe(true);
    expect(review!.files.sort()).toEqual([...a.files].sort());
    await ok(again.restoreVersion(saved.id!, review!.revision));
    a.files.forEach((f, i) => expect(read(dir, f).equals(a.bytes[i])).toBe(true));
    expect(again.state.assets.assets.a_photo.file).toBe(a.files[0]);
    expect(again.state.assets.assets.a_photo.variants).toEqual(a.asset.variants);
    // The newer picture's files stay: Undo still needs them.
    for (const f of b.files) expect(existsSync(join(dir, f))).toBe(true);
    await ok(again.undo());
    expect(again.state.assets.assets.a_photo.file).toBe(b.files[0]);
  });

  both('reviews the collection entries a restore removes, brings back and changes', async () => {
    const { s } = await make();
    await ok(s.apply({ operations: [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_kept', title: 'Kept post', publishedAt: '2026-11-01', body: ['One.'] }] }, { label: 'Kept' }));
    const saved = await ok(s.saveVersion('V1'));
    await ok(s.apply({ operations: [{ type: 'entry.create', collectionId: 'posts', entryId: 'en_after', title: 'After V1', publishedAt: '2026-11-02', body: ['Two.'] }] }, { label: 'After' }));
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review).toMatchObject({ unchanged: false, entries: { back: [], gone: ['After V1'], changed: [] }, collections: { back: [], gone: [], changed: [] } });
    expect(describeReview(review!)).toEqual(['Removes 1 entry it doesn’t have: “After V1”']);
  });

  both('puts back a file changed in place outside the app, and the version saved before restoring holds the changed one', async (mode) => {
    const { dir, s } = await make();
    mkdirSync(join(dir, ASSETS), { recursive: true });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>blue</svg>');
    // A code component shows a file the author placed by hand, by its whole name.
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Logo', source: '<img src="/assets/logo.svg" alt="Logo" />\n' }] }, { label: 'Add logo' }));
    const saved = await ok(s.saveVersion('Blue logo'));
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    const changed: Array<{ changedDocs: string[]; changedFiles: string[] }> = [];
    s.on('changed', (e) => changed.push(e));

    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review).toMatchObject({ files: [`${ASSETS}/logo.svg`], replaced: [`${ASSETS}/logo.svg`], unchanged: false });
    const r = await ok(s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced }));
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>blue</svg>');
    // Only a file changed, so there is no document step to undo: the saved work is the way back.
    expect(r.entryId).toBeUndefined();
    expect(r.replaced).toBe(1);
    const aside = readdirSync(join(dir, '.siteorigin/recovery')).find((f) => f.startsWith('restore-'));
    expect(read(dir, `.siteorigin/recovery/${aside}/static/assets/logo.svg`).toString()).toBe('<svg>green</svg>');
    // The docs match the saved version, but the files did not: the work from before is a version of its own.
    expect(r.backup!.id).not.toBe(saved.id);
    expect(changed.some((e) => e.changedFiles.includes(`${ASSETS}/logo.svg`) && !e.changedDocs.length)).toBe(true);
    const back = await ok(s.reviewVersion(r.backup!.id));
    await ok(s.restoreVersion(r.backup!.id, back.review!.revision));
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>green</svg>');

    // Restoring what the project already matches changes nothing.
    const same = await ok(s.reviewVersion(r.backup!.id));
    expect(same.review!.unchanged).toBe(true);
    expect(await s.restoreVersion(r.backup!.id, same.review!.revision)).toMatchObject({ ok: true, unchanged: true });
  });

  both('reuses a saved version that already holds the work a restore replaces', async (mode) => {
    const { s } = await make();
    await describe1(s, 'One', 'One');
    const one = await ok(s.saveVersion('One'));
    await describe1(s, 'Two', 'Two');
    const two = await ok(s.saveVersion('Two'));
    const r = await ok(s.restoreVersion(one.id!, s.revision));
    expect(r.backup).toEqual({ id: two.id, name: 'Two' });
    // With Git snapshots on, the site as restored is saved after it all the same (#1155).
    const listed = s.versionsInfo().list;
    expect(listed.map((v) => v.name)).toEqual([...(mode === 'git' ? ['Restored “One”'] : []), 'Two', 'One']);
    // Both hold the same starter documents: neither alone frees those.
    const [b, a] = listed.slice(-2);
    if (mode === 'git') expect([a.bytes, b.bytes]).toEqual([null, null]);
    else expect(a.bytes! + b.bytes!).toBeLessThan(s.versionsInfo().bytes);
  });

  it('works out what the versions take again only once the list or a stored object changed (#966)', async () => {
    const { dir, s } = await make();
    const a = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...a.asset } }] }, { label: 'Import photo' }));
    const first = await ok(s.saveVersion('First'));
    await describe1(s, 'Changed', 'Change');
    await ok(s.saveVersion('Second'));
    await describe1(s, 'Changed again', 'Change');
    await ok(s.saveVersion('Third'));
    // Each version's own bytes and all of them together, worked out object by object from what is on disk.
    const onDisk = () => {
      const index = JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions as Array<{ docs: Record<string, string>; media: Record<string, string | null> }>;
      const held = (v: (typeof index)[number]) => new Set([...Object.values(v.docs), ...Object.values(v.media).filter((h): h is string => !!h)]);
      const size = (h: string) => readFileSync(join(dir, '.siteorigin/versions/objects', h)).length;
      const sum = (hs: Iterable<string>) => [...hs].reduce((n, h) => n + size(h), 0);
      const alone = index.map((v, i) => sum([...held(v)].filter((h) => !index.some((o, j) => j !== i && held(o).has(h)))));
      return { list: alone.reverse(), bytes: sum(new Set(index.flatMap((v) => [...held(v)]))) };
    };
    const shown = s.versionsInfo();
    expect({ list: shown.list.map((v) => v.bytes), bytes: shown.bytes }).toEqual(onDisk());
    expect(shown.list.every((v) => v.bytes !== null && v.bytes > 0)).toBe(true);
    // An edit changes no version: every snapshot after it shows the same answer.
    await describe1(s, 'Not a version', 'Edit');
    expect(s.versionsInfo()).toBe(shown);
    await ok(s.renameVersion(first.id!, 'Renamed'));
    const renamed = s.versionsInfo();
    expect(renamed).not.toBe(shown);
    expect(renamed.list.find((v) => v.id === first.id)?.name).toBe('Renamed');
    await ok(s.deleteVersion(first.id!));
    const left = s.versionsInfo();
    expect(left.list).toHaveLength(2);
    expect({ list: left.list.map((v) => v.bytes), bytes: left.bytes }).toEqual(onDisk());
    await ok(s.saveVersion('Fourth'));
    expect({ list: s.versionsInfo().list.map((v) => v.bytes), bytes: s.versionsInfo().bytes }).toEqual(onDisk());
  });

  it('deletes a version and only what no other version holds', async () => {
    const { dir, s } = await make();
    const a = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...a.asset } }] }, { label: 'Import photo' }));
    const first = await ok(s.saveVersion('First'));
    await describe1(s, 'Changed', 'Change');
    const second = await ok(s.saveVersion('Second'));
    const before = objects(dir).length;
    const [newest, oldest] = s.versionsInfo().list;
    expect(newest.id).toBe(second.id);

    const r = await ok(s.deleteVersion(first.id!));
    expect(r.freed).toBe(oldest.bytes);
    // Only the site document differed: the pictures and everything else stay for the other version.
    expect(objects(dir)).toHaveLength(before - 1);
    expect(s.versionsInfo().list.map((v) => v.id)).toEqual([second.id]);
    expect(s.versionsInfo().list[0].bytes).toBe(s.versionsInfo().bytes);

    // The deletion is on disk, not only in this session.
    await s.close();
    const again = await reopen(dir);
    expect(again.versionsInfo().list.map((v) => v.id)).toEqual([second.id]);
    await ok(again.deleteVersion(second.id!));
    expect(objects(dir)).toEqual([]);
    expect((await again.storageInfo()).versions).toEqual({ count: 0, bytes: 0 });
    // The project's own pictures are untouched.
    for (const f of a.files) expect(existsSync(join(dir, f))).toBe(true);
  });

  both('renames a version, keeping what it holds and when it was saved', async (mode) => {
    const { dir, s } = await make();
    const saved = await ok(s.saveVersion('First draft'));
    const [before] = s.versionsInfo().list;
    const stored = objects(dir).length;

    await ok(s.renameVersion(saved.id!, '  Approved   by client '));
    const [after] = s.versionsInfo().list;
    expect(after).toEqual({ ...before, name: 'Approved by client' });
    expect(objects(dir)).toHaveLength(stored);

    expect(await s.renameVersion(saved.id!, '   ')).toMatchObject({ ok: false, message: 'Give the version a name.' });
    expect((await s.renameVersion(saved.id!, 'x'.repeat(81))).ok).toBe(false);
    expect(await s.renameVersion('vgone', 'Anything')).toMatchObject({ ok: false, message: 'That saved version is no longer there.' });
    expect(s.versionsInfo().list[0].name).toBe('Approved by client');

    // The new name is on disk, not only in this session.
    await s.close();
    const again = await reopen(dir);
    expect(again.versionsInfo().list[0]).toEqual(after);
  });

  both('saves though an image is missing, says which, and restores the rest', async (mode) => {
    const { dir, s } = await make();
    const a = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...a.asset } }] }, { label: 'Import photo' }));
    rmSync(join(dir, a.files[1]));
    const saved = await ok(s.saveVersion('Missing a copy'));
    expect(saved.missing).toEqual([a.files[1]]);
    expect(s.versionsInfo().list[0].missing).toEqual([a.files[1]]);
    await describe1(s, 'Later', 'Later');
    // The files it does hold still come back.
    rmSync(join(dir, a.files[0]));
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.missing).toEqual([a.files[1]]);
    expect(review!.files).toEqual([a.files[0]]);
    await ok(s.restoreVersion(saved.id!, review!.revision));
    expect(s.state.site.description).not.toBe('Later');
    expect(read(dir, a.files[0]).equals(a.bytes[0])).toBe(true);
    expect(existsSync(join(dir, a.files[1]))).toBe(false);
  });

  both('refuses to restore over a change made since the review, while the AI works, or in a read-only project', async (mode) => {
    const { dir, s } = await make();
    const saved = await ok(s.saveVersion('Start'));
    await describe1(s, 'Later', 'Later');
    const { review } = await ok(s.reviewVersion(saved.id!));
    await describe1(s, 'Even later', 'Even later');
    expect(await s.restoreVersion(saved.id!, review!.revision)).toMatchObject({ ok: false, stale: true });
    expect(s.state.site.description).toBe('Even later');

    expect(await s.beginRun('run_v')).toBeNull();
    expect(await s.restoreVersion(saved.id!, s.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/AI/) });
    expect(await s.saveVersion('During AI')).toMatchObject({ ok: false, message: expect.stringMatching(/AI/) });
    await s.abortRun();

    await s.close();
    const ro = await ProjectSession.openReadOnly(dir, { reason: 'Open elsewhere.', canUnlock: false });
    open.push(ro);
    expect(ro.versionsInfo().list.map((v) => v.name)).toEqual(['Start']);
    expect((await ro.reviewVersion(saved.id!)).ok).toBe(true);
    expect(await ro.restoreVersion(saved.id!, ro.revision)).toMatchObject({ ok: false, message: 'Open elsewhere.' });
    expect(await ro.saveVersion('Nope')).toMatchObject({ ok: false, message: 'Open elsewhere.' });
    expect(await ro.deleteVersion(saved.id!)).toMatchObject({ ok: false, message: 'Open elsewhere.' });
    expect(await ro.renameVersion(saved.id!, 'Renamed')).toMatchObject({ ok: false, message: 'Open elsewhere.' });
  });

  it('refuses a damaged version without changing anything', async () => {
    const { dir, s } = await make();
    const saved = await ok(s.saveVersion('Start'));
    await describe1(s, 'Later', 'Later');
    const index = JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8'));
    const site = join(dir, '.siteorigin/versions/objects', index.versions[0].docs['siteorigin/site.json']);
    // Bytes changed in place are found as surely as an object that is gone.
    writeFileSync(site, readFileSync(site, 'utf8').replace('Portfolio', 'Portfolia'));
    expect((await s.reviewVersion(saved.id!)).review!.problem).toMatch(/damaged/);
    rmSync(site);
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.problem).toMatch(/damaged/);
    const r = await s.restoreVersion(saved.id!, review!.revision);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/damaged/);
    expect(s.state.site.description).toBe('Later');
    expect(s.versionsInfo().list).toHaveLength(1);
  });

  both('refuses a version saved by a newer app', async (mode) => {
    const { dir, s } = await make();
    await ok(s.saveVersion('Start'));
    const path = join(dir, '.siteorigin/versions/versions.json');
    const index = JSON.parse(readFileSync(path, 'utf8'));
    index.versions[0].schemaVersion = SCHEMA_VERSION + 1;
    writeFileSync(path, JSON.stringify(index));
    await s.close();
    const again = await reopen(dir);
    const id = again.versionsInfo().list[0].id;
    expect((await again.reviewVersion(id)).review!.problem).toMatch(/newer version/);
    expect((await again.restoreVersion(id, again.revision)).ok).toBe(false);
  });

  it('leaves a list it cannot read alone: nothing is saved, deleted or collected', async () => {
    const { dir, s } = await make();
    await ok(s.saveVersion('Start'));
    const kept = objects(dir).sort();
    await s.close();
    writeFileSync(join(dir, '.siteorigin/versions/versions.json'), '{ not json');
    const again = await reopen(dir);
    expect(again.versionsInfo()).toMatchObject({ list: [], problem: expect.stringMatching(/could not be read/) });
    expect((await again.saveVersion('Another')).ok).toBe(false);
    expect((await again.deleteVersion('vwhatever1')).ok).toBe(false);
    await again.collectGarbage();
    expect(objects(dir).sort()).toEqual(kept);
    expect(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).toBe('{ not json');
  });

  it('collects what a save that stopped before its list was written left behind', async () => {
    const { dir, s } = await make();
    await ok(s.saveVersion('Start'));
    const kept = objects(dir).sort();
    const stray = join(dir, '.siteorigin/versions/objects', 'f'.repeat(64));
    writeFileSync(stray, 'left by a save that stopped');
    const oldCopy = join(dir, '.siteorigin/versions/objects', '.aaaaaaaaaaaa.tmp');
    const newCopy = join(dir, '.siteorigin/versions/objects', '.bbbbbbbbbbbb.tmp');
    writeFileSync(oldCopy, 'an old copy');
    writeFileSync(newCopy, 'a copy being written');
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(oldCopy, hourAgo, hourAgo);
    await s.close();
    const again = await reopen(dir);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(oldCopy)).toBe(false);
    expect(existsSync(newCopy)).toBe(true);
    expect(objects(dir).sort()).toEqual(kept);
    expect(again.versionsInfo().list).toHaveLength(1);
  });

  both('refuses an empty or overlong name', async (mode) => {
    const { s } = await make();
    expect((await s.saveVersion('   ')).ok).toBe(false);
    expect((await s.saveVersion('x'.repeat(81))).ok).toBe(false);
    expect(s.versionsInfo().list).toEqual([]);
    await ok(s.saveVersion('x'.repeat(80)));
  });
});

describe('saved versions, guarded', () => {
  both('holds a file anywhere under static/ that a document names by its address, but not generated files', async (mode) => {
    const { dir, s } = await make();
    mkdirSync(join(dir, 'static/brand'), { recursive: true });
    writeFileSync(join(dir, 'static/brand/logo.svg'), '<svg>blue</svg>');
    writeFileSync(join(dir, 'static/brand/unused.svg'), '<svg>unused</svg>');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Brand', source: '<img src="/brand/logo.svg" alt="Logo" />\n<a href="/robots.txt">Robots</a>\n' }] }, { label: 'Add brand' }));
    const saved = await ok(s.saveVersion('Blue brand'));
    const media = Object.keys(JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions[0].media);
    expect(media).toContain('static/brand/logo.svg');
    expect(media).not.toContain('static/brand/unused.svg');
    expect(existsSync(join(dir, 'static/robots.txt'))).toBe(true);
    expect(media).not.toContain('static/robots.txt');
    rmSync(join(dir, 'static/brand/logo.svg'));
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.files).toEqual(['static/brand/logo.svg']);
    await ok(s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced }));
    expect(read(dir, 'static/brand/logo.svg').toString()).toBe('<svg>blue</svg>');
  });

  both('does not hold a file in the project only because an image came from a file of that name', async (mode) => {
    const { dir, s } = await make();
    const photo = picture(dir, 'mark', 1);
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>unrelated</svg>');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_mark', ...photo.asset, originalName: 'logo.svg' } }] }, { label: 'Add mark' }));
    await ok(s.saveVersion('With a mark'));
    const media = Object.keys(JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions[0].media);
    expect(media).toContain(photo.files[0]);
    expect(media).not.toContain(`${ASSETS}/logo.svg`);
  });

  both('refuses a restore when a file changed outside the app after the review', async (mode) => {
    const { dir, s } = await make();
    mkdirSync(join(dir, ASSETS), { recursive: true });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>blue</svg>');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Logo', source: '<img src="/assets/logo.svg" alt="Logo" />\n' }] }, { label: 'Add logo' }));
    const saved = await ok(s.saveVersion('Blue logo'));
    await describe1(s, 'Later', 'Later');
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.files).toEqual([]);
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    expect(await s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced })).toMatchObject({ ok: false, stale: true });
    expect(s.state.site.description).toBe('Later');
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>green</svg>');
    expect(s.versionsInfo().list).toHaveLength(1);
  });

  both('keeps the names of versions saved before restores short, however often restores nest', async (mode) => {
    const { dir, s } = await make();
    let v = await ok(s.saveVersion('n'.repeat(80)));
    for (let i = 0; i < 4; i++) {
      await describe1(s, `Edit ${i}`, `Edit ${i}`);
      const r = await ok(s.restoreVersion(v.id!, s.revision));
      v = { ...v, id: r.backup!.id };
    }
    expect(Math.max(...s.versionsInfo().list.map((x) => x.name.length))).toBeLessThanOrEqual(80);
    expect(s.versionsInfo().list.at(-2)!.name).toBe(`Before restoring “${'n'.repeat(49)}…”`);
    await s.close();
    const again = await reopen(dir);
    expect(again.versionsInfo().problem).toBeUndefined();
    // With Git snapshots on, each restore also saves the site as it left it (#1155).
    expect(again.versionsInfo().list).toHaveLength(mode === 'git' ? 9 : 5);
  });

  both('refuses to save while a change made outside the app is not loaded yet', async (mode) => {
    const { dir, s } = await make();
    const site = JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));
    writeFileSync(join(dir, 'siteorigin/site.json'), JSON.stringify({ ...site, description: 'Edited outside' }));
    expect(await s.saveVersion('Too soon')).toMatchObject({ ok: false, message: expect.stringMatching(/changed outside the app/) });
    expect(s.versionsInfo().list).toEqual([]);
  });

  both('puts the files back as they were when saving the documents fails, and reopening says nothing of it', async (mode) => {
    const { dir, s } = await make();
    mkdirSync(join(dir, ASSETS), { recursive: true });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>blue</svg>');
    writeFileSync(join(dir, ASSETS, 'badge.svg'), '<svg>badge</svg>');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Logo', source: '<img src="/assets/logo.svg" alt="" /><img src="/assets/badge.svg" alt="" />\n' }] }, { label: 'Add logo' }));
    const saved = await ok(s.saveVersion('Blue logo'));
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    rmSync(join(dir, ASSETS, 'badge.svg'));
    await describe1(s, 'Later', 'Later');
    let marked = false;
    vi.spyOn(s as unknown as { persist: () => Promise<unknown> }, 'persist').mockImplementationOnce(async () => {
      marked = existsSync(join(dir, '.siteorigin/versions/restoring.json'));
      expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>blue</svg>');
      throw new Error('disk full');
    });
    await expect(s.restoreVersion(saved.id!, s.revision)).rejects.toThrow('disk full');
    expect(marked).toBe(true);
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>green</svg>');
    expect(existsSync(join(dir, ASSETS, 'badge.svg'))).toBe(false);
    expect(existsSync(join(dir, '.siteorigin/versions/restoring.json'))).toBe(false);
    expect(s.state.site.description).toBe('Later');
    await s.close();
    expect((await reopen(dir)).recoveryNotes.join(' ')).not.toMatch(/interrupted/);
  });

  both('says on reopening that a restore stopped part way, and where the work from before is', async (mode) => {
    const { dir, s } = await make();
    await s.close();
    mkdirSync(join(dir, '.siteorigin/versions'), { recursive: true });
    writeFileSync(join(dir, '.siteorigin/versions/restoring.json'), JSON.stringify({ version: 'Approved', backup: 'Before restoring “Approved”' }));
    const again = await reopen(dir);
    expect(again.recoveryNotes.join(' ')).toMatch(/Restoring “Approved” was interrupted.*“Before restoring “Approved”” in History/);
    expect(existsSync(join(dir, '.siteorigin/versions/restoring.json'))).toBe(false);
  });

  it('stores an object again when the copy kept of it was cut short', async () => {
    const { dir, s } = await make();
    const first = await ok(s.saveVersion('First'));
    const index = JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8'));
    const site = join(dir, '.siteorigin/versions/objects', index.versions[0].docs['siteorigin/site.json']);
    writeFileSync(site, '{');
    const second = await ok(s.saveVersion('Second'));
    await describe1(s, 'Later', 'Later');
    await ok(s.restoreVersion(second.id!, s.revision));
    expect(s.state.site.description).not.toBe('Later');
    // The first version names the same object, now whole again.
    expect((await s.reviewVersion(first.id!)).review!.problem).toBeUndefined();
  });
});

describe('saved versions, guarded further', () => {
  /** A project whose code component shows /assets/logo.svg, saved with a blue logo. */
  async function withLogo() {
    const { dir, s } = await make();
    mkdirSync(join(dir, ASSETS), { recursive: true });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>blue</svg>');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Logo', source: '<img src="/assets/logo.svg" alt="Logo" />\n' }] }, { label: 'Add logo' }));
    const saved = await ok(s.saveVersion('Blue logo'));
    return { dir, s, saved };
  }

  both('leaves a file changed by someone else while restoring, rather than putting back over it', async (mode) => {
    const { dir, s, saved } = await withLogo();
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    await describe1(s, 'Later', 'Later');
    vi.spyOn(s as unknown as { persist: () => Promise<unknown> }, 'persist').mockImplementationOnce(async () => {
      writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>red</svg>');
      throw new Error('disk full');
    });
    await expect(s.restoreVersion(saved.id!, s.revision)).rejects.toThrow('disk full');
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>red</svg>');
  });

  both('holds what a restore replaces in the work saved first, even a file the work did not name', async (mode) => {
    const { dir, s, saved } = await withLogo();
    const logo = Object.values(s.state.components).find((d) => d.name === 'Logo')!;
    await ok(s.apply({ operations: [{ type: 'component.updateSource', definitionId: logo.id, source: '<p>No logo</p>\n' }] }, { label: 'Drop logo' }));
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green, kept by hand</svg>');
    const { review } = await ok(s.reviewVersion(saved.id!));
    const r = await ok(s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced }));
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>blue</svg>');
    const back = await ok(s.reviewVersion(r.backup!.id));
    expect(back.review!.files).toEqual([`${ASSETS}/logo.svg`]);
    await ok(s.restoreVersion(r.backup!.id, back.review!.revision, { files: back.review!.files, replaced: back.review!.replaced }));
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>green, kept by hand</svg>');
  });

  both('says which files an earlier restore put back are left when going back to the work from before', async (mode) => {
    const { dir, s, saved } = await withLogo();
    const logo = Object.values(s.state.components).find((d) => d.name === 'Logo')!;
    await ok(s.apply({ operations: [{ type: 'component.updateSource', definitionId: logo.id, source: '<p>No logo</p>\n' }] }, { label: 'Drop logo' }));
    rmSync(join(dir, ASSETS, 'logo.svg'));
    const r = await ok(s.restoreVersion(saved.id!, s.revision));
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>blue</svg>');
    const back = await ok(s.reviewVersion(r.backup!.id));
    expect(back.review!.left).toEqual([`${ASSETS}/logo.svg`]);
    const done = await ok(s.restoreVersion(r.backup!.id, back.review!.revision));
    expect(done.left).toEqual([`${ASSETS}/logo.svg`]);
    // Undo of that restore would name it again, so it stays.
    expect(existsSync(join(dir, ASSETS, 'logo.svg'))).toBe(true);
    await ok(s.undo());
    expect(Object.values(s.state.components).find((d) => d.name === 'Logo')!.source).toContain('/assets/logo.svg');
  });

  both('treats a missing file that appeared after the review as a change', async (mode) => {
    const { dir, s, saved } = await withLogo();
    rmSync(join(dir, ASSETS, 'logo.svg'));
    await describe1(s, 'Later', 'Later');
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review).toMatchObject({ files: [`${ASSETS}/logo.svg`], replaced: [] });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>new</svg>');
    expect(await s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced })).toMatchObject({ ok: false, stale: true });
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>new</svg>');
  });

  both('holds a file named by its encoded address, and never a private one', async (mode) => {
    const { dir, s } = await make();
    mkdirSync(join(dir, 'static/brand'), { recursive: true });
    writeFileSync(join(dir, 'static/brand/My Logo.svg'), '<svg>mine</svg>');
    writeFileSync(join(dir, 'static/brand/server.key'), 'secret');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Brand', source: '<img src="/brand/My%20Logo.svg" alt="Logo" />\n<a href="/brand/server.key">Key</a>\n' }] }, { label: 'Add brand' }));
    await ok(s.saveVersion('Brand'));
    const media = Object.keys(JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions[0].media);
    expect(media).toEqual(['static/brand/My Logo.svg']);
  });

  both('refuses to save while a component added outside the app is not loaded yet', async (mode) => {
    const { dir, s } = await make();
    mkdirSync(join(dir, 'siteorigin/components/proj.outside-abcde'), { recursive: true });
    writeFileSync(join(dir, 'siteorigin/components/proj.outside-abcde/component.json'), '{}');
    expect(await s.saveVersion('Too soon')).toMatchObject({ ok: false, message: expect.stringMatching(/components\/proj.outside-abcde/) });
  });

  it('stores an object again when its bytes were damaged in place, size and all', async () => {
    const { dir, s } = await make();
    const first = await ok(s.saveVersion('First'));
    const index = JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8'));
    const site = join(dir, '.siteorigin/versions/objects', index.versions[0].docs['siteorigin/site.json']);
    writeFileSync(site, readFileSync(site, 'utf8').replace('Portfolio', 'Portfolia'));
    await s.close();
    const again = await reopen(dir);
    const second = await ok(again.saveVersion('Second'));
    await describe1(again, 'Later', 'Later');
    await ok(again.restoreVersion(second.id!, again.revision));
    expect((await again.reviewVersion(first.id!)).review!.problem).toBeUndefined();
  });
});

describe('saved versions, at the edges', () => {
  async function withLogo() {
    const { dir, s } = await make();
    mkdirSync(join(dir, ASSETS), { recursive: true });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>blue</svg>');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Logo', source: '<img src="/assets/logo.svg" alt="Logo" />\n' }] }, { label: 'Add logo' }));
    const saved = await ok(s.saveVersion('Blue logo'));
    return { dir, s, saved };
  }
  type Persist = { persist: (...a: unknown[]) => Promise<unknown> };

  it('never collects through a versions folder linked to another project', async () => {
    const other = mkdtempSync(join(tmpdir(), 'so-versions-other-'));
    dirs.push(other);
    writeFileSync(join(other, 'a'.repeat(64)), 'another project’s version');
    const { dir, s } = await make();
    await s.close();
    mkdirSync(join(dir, '.siteorigin/versions'), { recursive: true });
    symlinkSync(other, join(dir, '.siteorigin/versions/objects'));
    await reopen(dir);
    expect(existsSync(join(other, 'a'.repeat(64)))).toBe(true);
  });

  both('keeps the files once the documents are saved, even when a later step of that save fails', async (mode) => {
    const { dir, s, saved } = await withLogo();
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    await describe1(s, 'Later', 'Later');
    const real = (s as unknown as Persist).persist.bind(s);
    vi.spyOn(s as unknown as Persist, 'persist').mockImplementationOnce(async (...args: unknown[]) => {
      await real(...args);
      throw new Error('folder sync failed');
    });
    await expect(s.restoreVersion(saved.id!, s.revision)).rejects.toThrow('folder sync failed');
    expect(s.state.site.description).not.toBe('Later');
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>blue</svg>');
    expect(existsSync(join(dir, '.siteorigin/versions/restoring.json'))).toBe(false);
  });

  both('keeps the note of a restore it could not fully undo through a later restore', async (mode) => {
    const { dir, s, saved } = await withLogo();
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    await describe1(s, 'Later', 'Later');
    vi.spyOn(s as unknown as Persist, 'persist').mockImplementationOnce(async () => {
      // The copy set aside is gone, so the logo can't be put back as it was.
      rmSync(join(dir, '.siteorigin/recovery'), { recursive: true, force: true });
      throw new Error('disk full');
    });
    await expect(s.restoreVersion(saved.id!, s.revision)).rejects.toThrow('disk full');
    expect(existsSync(join(dir, '.siteorigin/versions/restoring.json'))).toBe(true);
    await ok(s.restoreVersion(saved.id!, s.revision));
    expect(existsSync(join(dir, '.siteorigin/versions/restoring.json'))).toBe(true);
    await s.close();
    expect((await reopen(dir)).recoveryNotes.join(' ')).toMatch(/Restoring “Blue logo” was interrupted/);
  });

  both('holds a named link, or a library file reached through a link out of the project, as missing', async (mode) => {
    const outside = mkdtempSync(join(tmpdir(), 'so-versions-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'logo.svg'), '<svg>elsewhere</svg>');
    const { dir, s } = await make();
    mkdirSync(join(dir, 'static/brand'), { recursive: true });
    symlinkSync(join(outside, 'logo.svg'), join(dir, 'static/brand/logo.svg'));
    mkdirSync(join(dir, ASSETS), { recursive: true });
    symlinkSync(outside, join(dir, ASSETS, 'linked'));
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Brand', source: '<img src="/brand/logo.svg" alt="Logo" />\n' }] }, { label: 'Add brand' }));
    const pic = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...pic.asset } }] }, { label: 'Import photo' }));
    // The library's file now sits behind a link that leads out of the project.
    rmSync(join(dir, pic.files[1]));
    symlinkSync(join(outside, 'logo.svg'), join(dir, pic.files[1]));
    const saved = await ok(s.saveVersion('Linked'));
    expect(saved.missing).toEqual(expect.arrayContaining(['static/brand/logo.svg', pic.files[1]]));
    expect(saved.missing).not.toContain(`${ASSETS}/linked`);
  });
});

describe('saved versions in Git (#1153)', () => {
  const gitdir = (dir: string) => join(dir, '.siteorigin/versions.git');
  const catalogue = (dir: string) => JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions as Array<SavedVersion>;
  /** Every file of a tree, by its path, read straight from the repository (not through the code under test). */
  const treeFiles = async (dir: string, tree: string, prefix = ''): Promise<string[]> => {
    const repo = openRepo(dir);
    const out: string[] = [];
    for (const e of await repo.readTree(tree)) {
      if (e.type === 'tree') out.push(...(await treeFiles(dir, e.oid, `${prefix}${e.path}/`)));
      else out.push(`${prefix}${e.path}`);
    }
    return out.sort();
  };
  /** Every file of the project outside .siteorigin/, with its bytes and times: what a watch on the project would see. */
  const outsideState = (dir: string) => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        const rel = relative(dir, p).split(sep).join('/');
        if (rel === '.siteorigin') continue;
        const st = lstatSync(p);
        if (st.isDirectory()) {
          out[rel] = `dir ${st.mtimeMs}`;
          walk(p);
        } else out[rel] = `${st.size} ${st.mtimeMs} ${sha(readFileSync(p))}`;
      }
    };
    walk(dir);
    return out;
  };

  it('with Git snapshots off, saves, restores and deletes in the plain store and never makes the repository', async () => {
    const { dir, s } = await make();
    const calls = git.calls.length;
    const saved = await ok(s.saveVersion('Plain'));
    await describe1(s, 'Later', 'Later');
    const r = await ok(s.restoreVersion(saved.id!, s.revision));
    await ok(s.deleteVersion(r.backup!.id));
    expect(existsSync(gitdir(dir))).toBe(false);
    expect(catalogue(dir).every((v) => !v.git)).toBe(true);
    // Nor is the site as restored saved after the restore: that is Git's alone (#1155).
    expect(s.versionsInfo().list.some((v) => v.restored)).toBe(false);
    expect(s.versionsInfo().historyBytes).toBeUndefined();
    expect(git.calls.length).toBe(calls);
  });

  it('saves the whole site as a commit by the app on the versions branch, with nothing of the person in it', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const pic = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...pic.asset } }] }, { label: 'Import photo' }));
    // A public file nothing names is part of the site's snapshot too, though a restore never puts it back.
    writeFileSync(join(dir, 'static', 'unused.txt'), 'kept in the snapshot');
    const first = await ok(s.saveVersion('Approved by Jane Citizen'));
    const firstSite = read(dir, 'siteorigin/site.json').toString();
    await describe1(s, 'Later', 'Later');
    const second = await ok(s.saveVersion('Second'));
    const [one, two] = catalogue(dir);
    expect(one).toMatchObject({ id: first.id, name: 'Approved by Jane Citizen', git: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), tree: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(two.id).toBe(second.id);
    const repo = openRepo(dir);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(two.git!.commit);
    const commit = await repo.readCommit(two.git!.commit);
    expect(commit.parents).toEqual([one.git!.commit]);
    expect(commit.tree).toBe(two.git!.tree);
    for (const c of [commit, await repo.readCommit(one.git!.commit)]) {
      expect(c.author).toEqual({ name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: expect.any(Number), timezoneOffset: 0 });
      expect(c.committer).toEqual(c.author);
      // The author's own name for the version, or the computer's, is never written into history.
      for (const personal of ['Jane', 'Citizen', 'Second', userInfo().username, hostname()]) expect(`${c.message}${c.author.name}${c.author.email}`).not.toContain(personal);
    }
    expect(commit.message).toBe(`Saved version\n\nSiteOrigin-Version: ${second.id}\n`);
    const files = await treeFiles(dir, one.git!.tree);
    expect(files).toEqual(expect.arrayContaining(['siteorigin.project.json', 'siteorigin/site.json', 'static/unused.txt', ...pic.files]));
    expect(files.some((f) => f.startsWith('src/routes/'))).toBe(true);
    expect(files.filter((f) => f.startsWith('.siteorigin') || f.startsWith('node_modules') || f === BRIEF_PATH)).toEqual([]);
    // The documents are the loaded ones, byte for byte, and the media the ones the row records.
    expect(Buffer.from(await repo.readBlob(one.git!.commit, 'siteorigin/site.json')).toString()).toBe(firstSite);
    expect(sha(Buffer.from(await repo.readBlob(one.git!.commit, pic.files[0])))).toBe(one.media[pic.files[0]]);
    expect(one.media['static/unused.txt']).toBeUndefined();
    // Nothing of a version in Git is an object of the plain store.
    expect(objects(dir)).toEqual([]);
    expect(s.versionsInfo().historyBytes).toBeGreaterThan(0);
    expect(s.versionsInfo().bytes).toBe(s.versionsInfo().historyBytes);
  });

  it('keeps an external source’s settings out of Git, beside the list, and restores them with the site', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    await ok(
      s.apply(
        {
          operations: [
            { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: false }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' } } },
            { type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', config: { credentials: { token: { $secret: 'people-token' } } } }
          ] as EditOperation[]
        },
        { label: 'Add the team source' }
      )
    );
    const SOURCE = 'siteorigin/sources/people/source.json';
    const saved = await ok(s.saveVersion('With the source'));
    const [row] = catalogue(dir);
    expect(await treeFiles(dir, row.git!.tree)).not.toContain(SOURCE);
    expect(objects(dir)).toEqual([row.docs[SOURCE]]);
    expect(readFileSync(join(dir, '.siteorigin/versions/objects', row.docs[SOURCE]), 'utf8')).toContain('$secret');
    await ok(s.apply({ operations: [{ type: 'source.upsert', sourceId: 'people', name: 'Renamed API', adapter: 'fixture', collectionId: 'team', config: {} }] as EditOperation[] }, { label: 'Rename source' }));
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.problem).toBeUndefined();
    await ok(s.restoreVersion(saved.id!, review!.revision));
    expect(s.state.sources?.people?.name).toBe('People API');
    // The source's settings are what the backup of the work replaced holds too, and deleting both versions frees them.
    for (const v of s.versionsInfo().list) await ok(s.deleteVersion(v.id));
    expect(objects(dir)).toEqual([]);
  });

  it('lists and restores versions in Git after the setting is turned off, beside versions saved before it was on', async () => {
    const { dir, s } = await make();
    await describe1(s, 'Plain', 'Plain');
    const plain = await ok(s.saveVersion('Plain'));
    git.enabled = true;
    await describe1(s, 'In Git', 'In Git');
    const inGit = await ok(s.saveVersion('In Git'));
    git.enabled = false;
    await describe1(s, 'Off again', 'Off again');
    await s.close();
    const again = await reopen(dir);
    expect(again.versionsInfo().list.map((v) => [v.name, v.bytes === null])).toEqual([
      ['In Git', true],
      ['Plain', false]
    ]);
    const tip = await openRepo(dir).resolveRef(VERSIONS_BRANCH);
    const { review } = await ok(again.reviewVersion(inGit.id!));
    expect(review!.problem).toBeUndefined();
    const r = await ok(again.restoreVersion(inGit.id!, review!.revision));
    expect(again.state.site.description).toBe('In Git');
    // With the setting off, the work the restore replaced is saved in the plain store, and history is not added to.
    expect(catalogue(dir).find((v) => v.id === r.backup!.id)!.git).toBeUndefined();
    expect(await openRepo(dir).resolveRef(VERSIONS_BRANCH)).toBe(tip);
    const back = await ok(again.reviewVersion(plain.id!));
    await ok(again.restoreVersion(plain.id!, back.review!.revision));
    expect(again.state.site.description).toBe('Plain');
  });

  it('renames and deletes a version in Git from the list only, freeing nothing and leaving its history', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const first = await ok(s.saveVersion('First'));
    await describe1(s, 'Changed', 'Change');
    const second = await ok(s.saveVersion('Second'));
    const repo = openRepo(dir);
    const tip = await repo.resolveRef(VERSIONS_BRANCH);
    const history = await repo.listCommits(VERSIONS_BRANCH, 10);
    await ok(s.renameVersion(first.id!, 'Renamed'));
    const r = await ok(s.deleteVersion(first.id!));
    expect(r.freed).toBe(0);
    expect(s.versionsInfo().list.map((v) => [v.id, v.name, v.bytes])).toEqual([[second.id, 'Second', null]]);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(tip);
    expect(await repo.listCommits(VERSIONS_BRANCH, 10)).toEqual(history);
    const storage = (await s.storageInfo()).versions;
    expect(storage).toEqual({ count: 1, bytes: s.versionsInfo().bytes, historyBytes: s.versionsInfo().historyBytes });
    // The history is still measured once every version is deleted from the list: it takes that space until removed.
    await ok(s.deleteVersion(second.id!));
    await s.close();
    const again = await reopen(dir);
    expect(again.versionsInfo()).toMatchObject({ list: [], historyBytes: expect.any(Number) });
    expect(again.versionsInfo().bytes).toBe(again.versionsInfo().historyBytes);
  });

  it('refuses a version whose snapshot is damaged or gone without changing anything', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const saved = await ok(s.saveVersion('Start'));
    await describe1(s, 'Later', 'Later');
    const [row] = catalogue(dir);
    // The site document's object, rewritten with other bytes under its name.
    const blob = (await openRepo(dir).readTree(row.git!.tree)).find((e) => e.path === 'siteorigin')!;
    const site = (await openRepo(dir).readTree(blob.oid)).find((e) => e.path === 'site.json')!.oid;
    const object = join(gitdir(dir), 'objects', site.slice(0, 2), site.slice(2));
    const original = readFileSync(object);
    chmodSync(object, 0o644);
    writeFileSync(object, deflateSync(Buffer.from('blob 2\0{}')));
    expect((await s.reviewVersion(saved.id!)).review!.problem).toMatch(/damaged/);
    writeFileSync(object, original);
    expect((await s.reviewVersion(saved.id!)).review!.problem).toBeUndefined();
    // An intact snapshot whose bytes are not the ones the list recorded is no more the version than a damaged one.
    const listPath = join(dir, '.siteorigin/versions/versions.json');
    const list = readFileSync(listPath, 'utf8');
    const other = JSON.parse(list);
    other.versions[0].docs['siteorigin/site.json'] = sha('{"name":"Another site"}');
    writeFileSync(listPath, JSON.stringify(other));
    await s.close();
    const swapped = await reopen(dir);
    expect((await swapped.reviewVersion(saved.id!)).review!.problem).toMatch(/damaged/);
    await swapped.close();
    writeFileSync(listPath, list);
    const s2 = await reopen(dir);
    expect((await s2.reviewVersion(saved.id!)).review!.problem).toBeUndefined();
    // The whole repository gone: the version can't be restored, and nothing is made to look for it.
    rmSync(gitdir(dir), { recursive: true });
    const { review } = await ok(s2.reviewVersion(saved.id!));
    expect(review!.problem).toMatch(/damaged/);
    expect(existsSync(gitdir(dir))).toBe(false);
    const r = await s2.restoreVersion(saved.id!, review!.revision);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/damaged/) });
    expect(s2.state.site.description).toBe('Later');
    expect(s2.versionsInfo().list).toHaveLength(1);
  });

  it('leaves the developer’s own Git repository, and every watched folder, untouched by saving and by Git', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    // A repository of the developer's, with a change staged and its index locked by a Git that is running.
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
    writeFileSync(join(dir, '.git', 'index'), 'DIRC staged edits');
    writeFileSync(join(dir, '.git', 'index.lock'), 'held by the developer');
    const before = outsideState(dir);
    const saved = await ok(s.saveVersion('Start'));
    await ok(s.saveVersion('Again'));
    expect(outsideState(dir)).toEqual(before);
    const changed: string[][] = [];
    s.on('changed', (e) => changed.push([...e.changedDocs, ...e.changedFiles]));
    await describe1(s, 'Later', 'Later');
    const afterEdit = outsideState(dir);
    changed.length = 0;
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(outsideState(dir)).toEqual(afterEdit);
    await ok(s.restoreVersion(saved.id!, review!.revision));
    // The restore writes the site's own documents, as ever (and says so); nothing of Git's lands where the project is
    // watched, and nothing of the developer's repository is added, changed or removed.
    const after = outsideState(dir);
    const moved = [...new Set([...Object.keys(after), ...Object.keys(afterEdit)])].filter((p) => after[p] !== afterEdit[p]);
    expect(moved).toContain('siteorigin/site.json');
    expect(moved.filter((p) => p === '.git' || p.startsWith('.git/'))).toEqual([]);
    expect(changed.flat()).toContain('siteorigin/site.json');
    expect(changed.flat().filter((p) => p.startsWith('.git') || p.startsWith('.siteorigin'))).toEqual([]);
    expect(readFileSync(join(dir, '.git', 'index.lock'), 'utf8')).toBe('held by the developer');
  });

  it('keeps a file the site names but a snapshot leaves out (a private name) beside the list, never in Git, and restores it', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    mkdirSync(join(dir, 'static', 'brand'), { recursive: true });
    // An editor's backup of a key, under a public folder, that a component happens to name.
    writeFileSync(join(dir, 'static/brand/client.pem.bak'), 'PRIVATE KEY BYTES');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Key', source: '<a href="/brand/client.pem.bak">Key</a>\n' }] }, { label: 'Add key link' }));
    const saved = await ok(s.saveVersion('With the key'));
    const [row] = catalogue(dir);
    expect(row.git!.outside).toEqual(['static/brand/client.pem.bak']);
    expect(await treeFiles(dir, row.git!.tree)).not.toContain('static/brand/client.pem.bak');
    expect(objects(dir)).toContain(row.media['static/brand/client.pem.bak']);
    rmSync(join(dir, 'static/brand/client.pem.bak'));
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.files).toEqual(['static/brand/client.pem.bak']);
    await ok(s.restoreVersion(saved.id!, review!.revision));
    expect(readFileSync(join(dir, 'static/brand/client.pem.bak'), 'utf8')).toBe('PRIVATE KEY BYTES');
    // Deleting every version that holds it frees it: it was never part of history.
    for (const v of s.versionsInfo().list) await ok(s.deleteVersion(v.id));
    expect(objects(dir)).toEqual([]);
  });

  it('saves the work a restore replaces as a new snapshot when the site differs where a restore never looks', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    await describe1(s, 'One', 'One');
    const one = await ok(s.saveVersion('One'));
    await describe1(s, 'Two', 'Two');
    const two = await ok(s.saveVersion('Two'));
    // The same documents and media as Two, but a public file no document names has changed since.
    writeFileSync(join(dir, 'static', 'notes.txt'), 'changed after Two');
    const r = await ok(s.restoreVersion(one.id!, s.revision));
    expect(r.backup!.id).not.toBe(two.id);
    const backup = catalogue(dir).find((v) => v.id === r.backup!.id)!;
    expect(await treeFiles(dir, backup.git!.tree)).toContain('static/notes.txt');
    // With nothing else changed, the snapshot that already holds the whole site is the way back.
    const again = await ok(s.restoreVersion(r.backup!.id, s.revision));
    const back = await ok(s.restoreVersion(one.id!, s.revision));
    expect(back.backup!.id).toBe(r.backup!.id);
    expect(again.ok).toBe(true);
  });

  it('saves the work a restore replaces anew when the version that held it can no longer be read', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    await describe1(s, 'One', 'One');
    const one = await ok(s.saveVersion('One'));
    await describe1(s, 'Two', 'Two');
    const two = await ok(s.saveVersion('Two'));
    await describe1(s, 'Three', 'Three');
    await ok(s.saveVersion('Three'));
    // Back to the site Two holds; Two's commit, no longer the branch's tip, is gone (its tree is not).
    await describe1(s, 'Two', 'Two again');
    const commit = catalogue(dir).find((v) => v.id === two.id)!.git!.commit;
    rmSync(join(gitdir(dir), 'objects', commit.slice(0, 2), commit.slice(2)));
    const r = await ok(s.restoreVersion(one.id!, s.revision));
    expect(r.backup!.id).not.toBe(two.id);
    const back = await ok(s.reviewVersion(r.backup!.id));
    expect(back.review!.problem).toBeUndefined();
    await ok(s.restoreVersion(r.backup!.id, back.review!.revision));
    expect(s.state.site.description).toBe('Two');
  });

  both('never puts a file back through a link inside the project, nor stores versions through a linked folder', async () => {
    const { dir, s } = await make();
    const before = () => readdirSync(join(dir, '.git'), { recursive: true }).map(String).sort();
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(dir, 'static', 'brand'), { recursive: true });
    writeFileSync(join(dir, 'static/brand/HEAD'), 'the brand’s own file');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Brand', source: '<a href="/brand/HEAD">Brand</a>\n' }] }, { label: 'Add brand' }));
    const saved = await ok(s.saveVersion('Brand'));
    const git0 = before();
    // The folder becomes a link to the developer's repository: restoring would write its HEAD.
    rmSync(join(dir, 'static', 'brand'), { recursive: true });
    symlinkSync(join(dir, '.git'), join(dir, 'static', 'brand'));
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.problem).toMatch(/reached through a link/);
    expect((await s.restoreVersion(saved.id!, review!.revision)).ok).toBe(false);
    expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    // The store's own folder swapped for a link: nothing is saved through it.
    rmSync(join(dir, 'static', 'brand'));
    rmSync(join(dir, '.siteorigin/versions/objects'), { recursive: true, force: true });
    symlinkSync(join(dir, '.git', 'objects'), join(dir, '.siteorigin/versions/objects'));
    expect(await s.saveVersion('Through the link')).toMatchObject({ ok: false, message: expect.stringMatching(/link/) });
    expect(before()).toEqual(git0);
    // Changing the list itself writes no object: renaming and deleting still work.
    await ok(s.renameVersion(saved.id!, 'Renamed'));
    await ok(s.deleteVersion(saved.id!));
    expect(before()).toEqual(git0);
  });

  both('puts the library back when the whole static folder is gone, and restores past media that a link holds unchanged', async () => {
    const { dir, s } = await make();
    const pic = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...pic.asset } }] }, { label: 'Import photo' }));
    const saved = await ok(s.saveVersion('With the photo'));
    await describe1(s, 'Later', 'Later');
    rmSync(join(dir, 'static'), { recursive: true });
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.problem).toBeUndefined();
    await ok(s.restoreVersion(saved.id!, review!.revision));
    pic.files.forEach((f, i) => expect(read(dir, f).equals(pic.bytes[i])).toBe(true));
    // The library folder moved and linked back, its files the same: nothing to put back there, so the restore goes on.
    await describe1(s, 'Later again', 'Later again');
    const moved = join(dir, 'static', 'assets-moved');
    renameSync(join(dir, ASSETS), moved);
    symlinkSync(moved, join(dir, ASSETS));
    const again = await ok(s.reviewVersion(saved.id!));
    expect(again.review).toMatchObject({ files: [] });
    expect(again.review!.problem).toBeUndefined();
    await ok(s.restoreVersion(saved.id!, again.review!.revision));
    expect(s.state.site.description).not.toBe('Later again');
  });

  it('saves the work a restore replaces beside the list when the history’s newest version is damaged', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    await describe1(s, 'One', 'One');
    const one = await ok(s.saveVersion('One'));
    await describe1(s, 'Two', 'Two');
    await ok(s.saveVersion('Two'));
    const tip = (await openRepo(dir).resolveRef(VERSIONS_BRANCH))!;
    rmSync(join(gitdir(dir), 'objects', tip.slice(0, 2), tip.slice(2)));
    await describe1(s, 'Three', 'Three');
    // A new version can't be added to damaged history, and says what to do.
    expect(await s.saveVersion('Three')).toMatchObject({ ok: false, message: expect.stringMatching(/damaged.*Turn off Git snapshots/) });
    // A restore still saves the way back, in the plain store, and the history is left as it is.
    const r = await ok(s.restoreVersion(one.id!, s.revision));
    expect(catalogue(dir).find((v) => v.id === r.backup!.id)!.git).toBeUndefined();
    expect(await openRepo(dir).resolveRef(VERSIONS_BRANCH)).toBe(tip);
    expect(s.state.site.description).toBe('One');
    const back = await ok(s.reviewVersion(r.backup!.id));
    await ok(s.restoreVersion(r.backup!.id, back.review!.revision));
    expect(s.state.site.description).toBe('Three');
  });

  it('passes the hash a source file was read under through to the worker, which refuses other bytes', async () => {
    const { dir } = await make();
    writeFileSync(join(dir, 'static', 'notes.txt'), 'these bytes');
    const repo = git.client.repository(dir);
    await repo.init();
    await expect(repo.writeFiles([{ path: 'static/notes.txt', source: 'static/notes.txt', sha256: sha('other bytes') }])).rejects.toMatchObject({ code: 'changed' });
    const tree = await repo.writeFiles([{ path: 'static/notes.txt', source: 'static/notes.txt', sha256: sha('these bytes'), mode: '100755' }]);
    const [folder] = await repo.readTree(tree);
    expect(await repo.readTree(folder.oid)).toEqual([expect.objectContaining({ path: 'notes.txt', mode: '100755' })]);
  });

  it('commits again on top of a branch another save moved meanwhile, holding the same site', async () => {
    const root = mkdtempSync(join(tmpdir(), 'so-versions-git-'));
    dirs.push(root);
    const repo = git.client.repository(root);
    // Stale: written on an empty branch, which another save then moves.
    const files = [{ path: 'siteorigin/site.json', bytes: new TextEncoder().encode('{"name":"Mine"}') }];
    const mine = await writeVersionCommit(repo, files, 'vmine000000', new Date().toISOString(), 'saved');
    const theirs = await writeVersionCommit(repo, [{ path: 'siteorigin/site.json', bytes: new TextEncoder().encode('{"name":"Theirs"}') }], 'vtheirs00000', new Date().toISOString(), 'saved');
    await repo.advanceRef(VERSIONS_BRANCH, theirs.commit, null);
    const tip = await advanceVersions(repo, mine.commit);
    expect(tip).not.toBe(mine.commit);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(tip);
    const c = await repo.readCommit(tip);
    const first = await repo.readCommit(mine.commit);
    expect(c).toEqual({ oid: tip, tree: mine.tree, parents: [theirs.commit], author: first.author, committer: first.committer, message: first.message });
  });
});

describe('restoring with Git snapshots on (#1155)', () => {
  const catalogue = (dir: string) => JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions as Array<SavedVersion>;
  const RECORDING = '.siteorigin/versions/recording.json';
  const RESTORING = '.siteorigin/versions/restoring.json';
  const tipOf = (dir: string) => openRepo(dir).resolveRef(VERSIONS_BRANCH);
  const commits = async (dir: string) => (await openRepo(dir).listCommits(VERSIONS_BRANCH, 100)).map((c) => c.oid);
  const restoredRows = (dir: string) => catalogue(dir).filter((v) => v.restored);
  /**
   * The project's versions repository as the session reaches it, with `wrap` standing in for some of its calls: the
   * client gives a new one each time it is asked, so the same one is given every time instead.
   */
  const intercept = (wrap: (real: GitRepository) => Partial<GitRepository>) => {
    const real = git.client.repository.bind(git.client);
    return vi.spyOn(git.client, 'repository').mockImplementation((root: string) => {
      const repo = real(root);
      return { ...repo, ...wrap(repo) } as GitRepository;
    });
  };
  /** A project with a saved version, changed since: restoring it changes the site's description back. */
  async function changed() {
    git.enabled = true;
    const { dir, s } = await make();
    const first = await ok(s.saveVersion('First'));
    const firstSite = read(dir, 'siteorigin/site.json').toString();
    await describe1(s, 'Later', 'Later');
    return { dir, s, first, firstSite };
  }

  it('saves the site as restored on top of the history, its parent the tip before it, and Undo still takes the restore back', async () => {
    const { dir, s, first, firstSite } = await changed();
    const before = s.revision;
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    expect(r.notice).toBeUndefined();
    expect(r.revision).toBeGreaterThan(before);
    const rows = catalogue(dir);
    const backup = rows.find((v) => v.id === r.backup!.id)!;
    const [row] = restoredRows(dir);
    expect(rows.map((v) => v.name)).toEqual(['First', 'Before restoring “First”', 'Restored “First”']);
    expect(row).toMatchObject({ name: 'Restored “First”', auto: true, restored: true, revision: s.revision });
    expect(s.versionsInfo().list[0]).toMatchObject({ id: row.id, auto: true, restored: true, bytes: null });
    const repo = openRepo(dir);
    expect(await tipOf(dir)).toBe(row.git!.commit);
    const c = await repo.readCommit(row.git!.commit);
    expect(c.parents).toEqual([backup.git!.commit]);
    expect(c.tree).toBe(row.git!.tree);
    expect(c.message).toBe(`Restored version\n\nSiteOrigin-Version: ${row.id}\n`);
    expect(c.author).toEqual({ name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: expect.any(Number), timezoneOffset: 0 });
    // What the project holds after the restore, byte for byte.
    expect(Buffer.from(await repo.readBlob(row.git!.commit, 'siteorigin/site.json')).toString()).toBe(firstSite);
    expect(read(dir, 'siteorigin/site.json').toString()).toBe(firstSite);
    expect((await ok(s.reviewVersion(row.id))).review!.unchanged).toBe(true);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
    expect(existsSync(join(dir, RESTORING))).toBe(false);
    // Undo takes back the documents; history only ever goes forward.
    await ok(s.undo());
    expect(s.state.site.description).toBe('Later');
    expect(s.revision).toBeGreaterThan(r.revision!);
    expect(await tipOf(dir)).toBe(row.git!.commit);
    await s.close();
    const again = await reopen(dir);
    expect(again.recoveryNotes).toEqual([]);
    expect(again.versionsInfo().list).toHaveLength(3);
  });

  it('builds on the tip, not on an older version a restore reuses as the way back', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    await describe1(s, 'One', 'One');
    const one = await ok(s.saveVersion('One'));
    await describe1(s, 'Two', 'Two');
    const two = await ok(s.saveVersion('Two'));
    await ok(s.saveVersion('Two again'));
    const tip = await tipOf(dir);
    const r = await ok(s.restoreVersion(one.id!, s.revision));
    // The older of the two that hold the work is the way back; history goes on from its newest commit all the same.
    expect(r.backup!.id).toBe(two.id);
    const [row] = restoredRows(dir);
    expect(catalogue(dir).find((v) => v.id === two.id)!.git!.commit).not.toBe(tip);
    expect((await openRepo(dir).readCommit(row.git!.commit)).parents).toEqual([tip]);
    expect(await tipOf(dir)).toBe(row.git!.commit);
  });

  it('saves the files a restore put back when no document changed, as they now are', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    mkdirSync(join(dir, ASSETS), { recursive: true });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>blue</svg>');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Logo', source: '<img src="/assets/logo.svg" alt="Logo" />\n' }] }, { label: 'Add logo' }));
    const saved = await ok(s.saveVersion('Blue logo'));
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>green</svg>');
    const revision = s.revision;
    const events: string[] = [];
    s.on('changed', (e) => events.push(e.label ?? ''));
    const { review } = await ok(s.reviewVersion(saved.id!));
    const r = await ok(s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced }));
    expect(r.entryId).toBeUndefined();
    expect(r.revision).toBe(revision);
    expect(events).toEqual(['Restore “Blue logo”']);
    const backup = catalogue(dir).find((v) => v.id === r.backup!.id)!;
    const [row] = restoredRows(dir);
    const repo = openRepo(dir);
    expect(Buffer.from(await repo.readBlob(row.git!.commit, `${ASSETS}/logo.svg`)).toString()).toBe('<svg>blue</svg>');
    expect(Buffer.from(await repo.readBlob(backup.git!.commit, `${ASSETS}/logo.svg`)).toString()).toBe('<svg>green</svg>');
    expect(row.media[`${ASSETS}/logo.svg`]).toBe(sha('<svg>blue</svg>'));
    expect((await repo.readCommit(row.git!.commit)).parents).toEqual([backup.git!.commit]);
    // Restoring what the project already matches saves nothing more.
    const same = await ok(s.reviewVersion(saved.id!));
    expect(await s.restoreVersion(saved.id!, same.review!.revision)).toMatchObject({ ok: true, unchanged: true });
    expect(await tipOf(dir)).toBe(row.git!.commit);
  });

  it('moves the branch on reopening when the app stopped before it could, and lists the version once', async () => {
    const { dir, s, first } = await changed();
    const spy = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        // The backup's own move goes through; the restore's stops here, as the app would by stopping.
        if (restoredRows(dir).length || existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    spy.mockRestore();
    expect(r.notice).toMatch(/not in Saved versions yet.*next time the project opens/);
    expect(s.state.site.description).not.toBe('Later');
    const backup = catalogue(dir).find((v) => v.id === r.backup!.id)!;
    expect(await tipOf(dir)).toBe(backup.git!.commit);
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    expect(pending).toMatchObject({ op: pending.row.id, version: 'First', backup: 'Before restoring “First”', expected: backup.git!.commit, row: { name: 'Restored “First”', restored: true } });
    expect(restoredRows(dir)).toEqual([]);
    const history = await commits(dir);
    await s.close();
    // As if the app had stopped before it cleared its note of the restore, too.
    writeFileSync(join(dir, RESTORING), JSON.stringify({ version: 'First', backup: 'Before restoring “First”', op: pending.op, settled: true }));
    const again = await reopen(dir);
    expect(again.recoveryNotes).toEqual([]);
    expect(await tipOf(dir)).toBe(pending.row.git.commit);
    expect(await commits(dir)).toEqual([pending.row.git.commit, ...history]);
    expect(restoredRows(dir)).toEqual([pending.row]);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
    expect(catalogue(dir).find((v) => v.id === r.backup!.id)).toEqual(backup);
    await again.close();
    // Nothing is left to do, however often it is opened.
    const third = await reopen(dir);
    expect(third.recoveryNotes).toEqual([]);
    expect(await commits(dir)).toEqual([pending.row.git.commit, ...history]);
    expect(third.versionsInfo().list).toHaveLength(3);
  });

  it('lists the version on reopening when the branch moved and the list could not be written (a full disk), without committing again', async () => {
    const { dir, s, first } = await changed();
    const publish = VersionStore.prototype.publish;
    const full = vi.spyOn(VersionStore.prototype, 'publish').mockImplementation(async function (this: VersionStore, next) {
      if (next.some((v) => v.restored)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return publish.call(this, next);
    });
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    full.mockRestore();
    expect(r.notice).toMatch(/not in Saved versions yet\. ENOSPC/);
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    // The branch is at the restore's commit already; only the list is behind.
    expect(await tipOf(dir)).toBe(pending.row.git.commit);
    expect(restoredRows(dir)).toEqual([]);
    expect(existsSync(join(dir, RESTORING))).toBe(false);
    const history = await commits(dir);
    await s.close();
    const again = await reopen(dir);
    expect(again.recoveryNotes).toEqual([]);
    expect(await commits(dir)).toEqual(history);
    expect(restoredRows(dir)).toEqual([pending.row]);
    expect(catalogue(dir).map((v) => v.name)).toEqual(['First', 'Before restoring “First”', 'Restored “First”']);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
  });

  it('says so, and leaves nothing to finish, when the version could not be noted on a full disk', async () => {
    const { dir, s, first } = await changed();
    let marker: unknown = null;
    vi.spyOn(VersionStore.prototype, 'writePending').mockImplementationOnce(async () => {
      // By now the restore is noted as done, with the ID of the version that was to record it.
      marker = JSON.parse(readFileSync(join(dir, RESTORING), 'utf8'));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    expect(r.notice).toMatch(/could not be saved as a version of its own\. ENOSPC/);
    expect(marker).toMatchObject({ version: 'First', backup: 'Before restoring “First”', op: expect.stringMatching(/^v/), settled: true });
    expect(s.state.site.description).not.toBe('Later');
    const backup = catalogue(dir).find((v) => v.id === r.backup!.id)!;
    expect(await tipOf(dir)).toBe(backup.git!.commit);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
    expect(existsSync(join(dir, RESTORING))).toBe(false);
    const history = await commits(dir);
    await s.close();
    const again = await reopen(dir);
    expect(again.recoveryNotes).toEqual([]);
    expect(await commits(dir)).toEqual(history);
    expect(again.versionsInfo().list.map((v) => v.name)).toEqual(['Before restoring “First”', 'First']);
  });

  it('says on reopening that the restore finished but its version was not saved, when the app stopped while saving it', async () => {
    const { dir, s } = await changed();
    await s.close();
    writeFileSync(join(dir, RESTORING), JSON.stringify({ version: 'First', backup: 'Before restoring “First”', op: 'vstopped0000', settled: true }));
    const again = await reopen(dir);
    expect(again.recoveryNotes.join(' ')).toMatch(/Restoring “First” finished, but the site as it left it could not be saved as a version of its own\. Your work from before is saved as “Before restoring “First””/);
    expect(again.recoveryNotes.join(' ')).not.toMatch(/may be missing/);
    expect(existsSync(join(dir, RESTORING))).toBe(false);
  });

  it('leaves the branch and the restore’s commit as they are when something else moved the branch meanwhile', async () => {
    const { dir, s, first } = await changed();
    const spy = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    spy.mockRestore();
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    await s.close();
    // Another Git moves the branch on from where the restore's commit was written.
    const repo = git.client.repository(dir);
    const other = await writeVersionCommit(repo, [{ path: 'siteorigin/site.json', bytes: new TextEncoder().encode('{"name":"Elsewhere"}') }], 'velsewhere00', new Date().toISOString(), 'saved');
    await repo.advanceRef(VERSIONS_BRANCH, other.commit, pending.expected);
    const again = await reopen(dir);
    expect(again.recoveryNotes.join(' ')).toMatch(/Restoring “First” finished, but the project’s version history was changed by something else.*both were left as they are\. Your work from before is saved as “Before restoring “First””/);
    expect(await tipOf(dir)).toBe(other.commit);
    expect((await openRepo(dir).readCommit(pending.row.git.commit)).tree).toBe(pending.row.git.tree);
    expect(restoredRows(dir)).toEqual([]);
    expect(catalogue(dir).some((v) => v.id === r.backup!.id)).toBe(true);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, `.siteorigin/versions/unrecorded-${pending.op}.json`), 'utf8'))).toEqual(pending);
    await again.close();
    // Told once, and saving goes on from where the branch is.
    const third = await reopen(dir);
    expect(third.recoveryNotes).toEqual([]);
    const next = await ok(third.saveVersion('Next'));
    const row = catalogue(dir).find((v) => v.id === next.id)!;
    expect((await openRepo(dir).readCommit(row.git!.commit)).parents).toEqual([other.commit]);
  });

  it('finishes the restore’s version before the next version is saved, so that one builds on it', async () => {
    const { dir, s, first } = await changed();
    let stop = true;
    const spy = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (stop && existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    await ok(s.restoreVersion(first.id!, s.revision));
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    // Still stopped: nothing else may move the branch from under the restore's version.
    await describe1(s, 'Next', 'Next');
    expect(await s.saveVersion('Next')).toMatchObject({ ok: false, message: expect.stringMatching(/not in Saved versions yet/) });
    expect(await s.restoreVersion(first.id!, s.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/not in Saved versions yet/) });
    stop = false;
    const next = await ok(s.saveVersion('Next'));
    spy.mockRestore();
    expect(catalogue(dir).map((v) => v.name)).toEqual(['First', 'Before restoring “First”', 'Restored “First”', 'Next']);
    const row = catalogue(dir).find((v) => v.id === next.id)!;
    expect((await openRepo(dir).readCommit(row.git!.commit)).parents).toEqual([pending.row.git.commit]);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
  });

  it('finishes the restore’s version before a theme switch saves the site first (#1156), so that one builds on it', async () => {
    const { dir, s, first } = await changed();
    let stop = true;
    const spy = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (stop && existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    await ok(s.restoreVersion(first.id!, s.revision));
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    await describe1(s, 'Next', 'Next');
    const theme = s.state.site.themeId;
    // Still stopped: the switch's safety version may not move the branch from under the restore's.
    const refused = await s.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'Switch theme', source: 'user' });
    expect(refused.error?.message).toMatch(/not in Saved versions yet/);
    expect(s.state.site.themeId).toBe(theme);
    stop = false;
    await ok(s.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'Switch theme', source: 'user' }));
    spy.mockRestore();
    expect(catalogue(dir).map((v) => v.name)).toEqual(['First', 'Before restoring “First”', 'Restored “First”', 'Before changing theme']);
    const row = catalogue(dir).find((v) => v.name === 'Before changing theme')!;
    expect((await openRepo(dir).readCommit(row.git!.commit)).parents).toEqual([pending.row.git.commit]);
  });

  it('finishes a version noted whole when only flushing its folder failed', async () => {
    const { dir, s, first } = await changed();
    const write = VersionStore.prototype.writePending;
    vi.spyOn(VersionStore.prototype, 'writePending').mockImplementationOnce(async function (this: VersionStore, p) {
      await write.call(this, p);
      throw new Error('EIO: i/o error, fsync');
    });
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    expect(r.notice).toBeUndefined();
    const [row] = restoredRows(dir);
    expect(await tipOf(dir)).toBe(row.git!.commit);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
  });

  it('tries again on reopening when the restore’s commit could not be read just then, rather than setting it aside', async () => {
    const { dir, s, first } = await changed();
    const crash = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    await ok(s.restoreVersion(first.id!, s.revision));
    crash.mockRestore();
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    await s.close();
    const busy = intercept((repo) => ({
      readCommit: async (oid, opts) => {
        if (oid === pending.row.git.commit) throw new GitError('timeout', 'The versions repository took too long.');
        return repo.readCommit(oid, opts);
      }
    }));
    const again = await reopen(dir);
    busy.mockRestore();
    expect(again.recoveryNotes.join(' ')).toMatch(/Restoring “First” finished, but the site as it left it is not in Saved versions yet/);
    expect(existsSync(join(dir, RECORDING))).toBe(true);
    expect(readdirSync(join(dir, '.siteorigin/versions')).filter((f) => f.startsWith('unrecorded-'))).toEqual([]);
    await again.close();
    const third = await reopen(dir);
    expect(third.recoveryNotes).toEqual([]);
    expect(restoredRows(dir)).toEqual([pending.row]);
    expect(await tipOf(dir)).toBe(pending.row.git.commit);
  });

  it('never lists a version again from a record left behind once it was listed and then deleted', async () => {
    const { dir, s, first } = await changed();
    vi.spyOn(VersionStore.prototype, 'clearPending').mockRejectedValueOnce(new Error('EBUSY: resource busy'));
    await ok(s.restoreVersion(first.id!, s.revision));
    const [row] = restoredRows(dir);
    expect(existsSync(join(dir, RECORDING))).toBe(true);
    await ok(s.deleteVersion(row.id));
    expect(existsSync(join(dir, RECORDING))).toBe(false);
    await s.close();
    const again = await reopen(dir);
    expect(restoredRows(dir)).toEqual([]);
    expect(again.versionsInfo().list.map((v) => v.name)).toEqual(['Before restoring “First”', 'First']);
  });

  it('says nothing on reopening when the version was listed and only the note of the restore was left', async () => {
    const { dir, s, first } = await changed();
    await ok(s.restoreVersion(first.id!, s.revision));
    const [row] = restoredRows(dir);
    await s.close();
    // As if the app had stopped after the version was listed and its record removed, but before the note was.
    writeFileSync(join(dir, RESTORING), JSON.stringify({ version: 'First', backup: 'Before restoring “First”', op: row.id, settled: true }));
    const again = await reopen(dir);
    expect(again.recoveryNotes).toEqual([]);
    expect(restoredRows(dir)).toEqual([row]);
  });

  it('leaves another project’s record alone when the versions folder is a link to it', async () => {
    const { dir: theirs, s: other, first } = await changed();
    const crash = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (existsSync(join(theirs, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    await ok(other.restoreVersion(first.id!, other.revision));
    crash.mockRestore();
    await other.close();
    const record = readFileSync(join(theirs, RECORDING));
    const { dir, s } = await make();
    await s.close();
    rmSync(join(dir, '.siteorigin/versions'), { recursive: true, force: true });
    symlinkSync(join(theirs, '.siteorigin/versions'), join(dir, '.siteorigin/versions'));
    const again = await reopen(dir);
    expect(again.recoveryNotes.join(' ')).toMatch(/not in Saved versions yet\. The saved versions folder in \.siteorigin is a link/);
    expect(readFileSync(join(theirs, RECORDING)).equals(record)).toBe(true);
    expect(readdirSync(join(theirs, '.siteorigin/versions')).filter((f) => f.startsWith('unrecorded-'))).toEqual([]);
  });

  it('lets nothing go past a version still being saved whose record could not be read just then', async () => {
    const { dir, s, first } = await changed();
    const crash = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    await ok(s.restoreVersion(first.id!, s.revision));
    crash.mockRestore();
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    const giveBack = denyAccess(join(dir, RECORDING), 'read');
    try {
      expect(await s.saveVersion('Next')).toMatchObject({ ok: false, message: expect.stringMatching(/could not be read just now/) });
      expect(await s.deleteVersion(first.id!)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be read just now/) });
    } finally {
      giveBack();
    }
    const next = await ok(s.saveVersion('Next'));
    const row = catalogue(dir).find((v) => v.id === next.id)!;
    expect((await openRepo(dir).readCommit(row.git!.commit)).parents).toEqual([pending.row.git.commit]);
  });

  it('keeps an edit made outside the app while the site as restored is saved, and does not save it', async () => {
    const { dir, s, first } = await changed();
    const site = JSON.parse(read(dir, 'siteorigin/site.json').toString());
    let writes = 0;
    const external = JSON.stringify({ ...site, description: 'Edited outside' }, null, 2) + '\n';
    const spy = intercept((repo) => ({
      writeFiles: async (files, opts) => {
        // The second tree written is the site as restored: an editor saves the site's settings just then.
        if (++writes === 2) writeFileSync(join(dir, 'siteorigin/site.json'), external);
        return repo.writeFiles(files, opts);
      }
    }));
    const events: string[] = [];
    s.on('changed', (e) => events.push(e.label ?? ''));
    const r = await ok(s.restoreVersion(first.id!, s.revision));
    spy.mockRestore();
    expect(r.notice).toMatch(/could not be saved as a version of its own\. siteorigin\/site\.json changed outside the app meanwhile/);
    expect(read(dir, 'siteorigin/site.json').toString()).toBe(external);
    expect(events).toEqual(['Restore “First”']);
    const backup = catalogue(dir).find((v) => v.id === r.backup!.id)!;
    expect(await tipOf(dir)).toBe(backup.git!.commit);
    expect(restoredRows(dir)).toEqual([]);
    expect(existsSync(join(dir, RECORDING))).toBe(false);
    // The edit is the project's next change, as any made outside the app.
    expect(await s.reloadChanged(['siteorigin/site.json'])).toMatchObject({ ok: true });
    expect(s.state.site.description).toBe('Edited outside');
  });

  it('keeps what a version still to be listed holds when versions are deleted meanwhile', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    await ok(
      s.apply(
        {
          operations: [
            { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', pages: { detail: true, archive: false }, route: '/team/', fields: { role: { type: 'string', label: 'Role', default: '' } } },
            { type: 'source.upsert', sourceId: 'people', name: 'People API', adapter: 'fixture', collectionId: 'team', config: {} }
          ] as EditOperation[]
        },
        { label: 'Add the team source' }
      )
    );
    const saved = await ok(s.saveVersion('With the source'));
    await ok(s.apply({ operations: [{ type: 'source.upsert', sourceId: 'people', name: 'Renamed API', adapter: 'fixture', collectionId: 'team', config: {} }] as EditOperation[] }, { label: 'Rename source' }));
    const spy = intercept((repo) => ({
      advanceRef: async (ref, next, expected) => {
        if (existsSync(join(dir, RECORDING))) throw new GitError('crashed', 'The worker stopped.');
        return repo.advanceRef(ref, next, expected);
      }
    }));
    await ok(s.restoreVersion(saved.id!, s.revision));
    spy.mockRestore();
    const pending = JSON.parse(readFileSync(join(dir, RECORDING), 'utf8'));
    const SOURCE = 'siteorigin/sources/people/source.json';
    // Deleting every listed version would free the source's settings, but the version still to be listed holds them.
    for (const v of s.versionsInfo().list) await ok(s.deleteVersion(v.id));
    expect(objects(dir)).toEqual([pending.row.docs[SOURCE]]);
    await s.close();
    const again = await reopen(dir);
    const [row] = restoredRows(dir);
    expect(row.id).toBe(pending.op);
    expect((await ok(again.reviewVersion(row.id))).review!.problem).toBeUndefined();
  });

  it('names the hand-written files that differ from a version, which a restore doesn’t copy (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const ROUTE = 'src/routes/volunteer/+page.svelte';
    mkdirSync(join(dir, 'src/routes/volunteer'), { recursive: true });
    writeFileSync(join(dir, ROUTE), '<h1>Volunteer</h1>\n<p>Saturdays in April</p>\n');
    const april = await ok(s.saveVersion('April'));
    writeFileSync(join(dir, ROUTE), '<h1>Volunteer</h1>\n<p>Sundays in June</p>\n');
    await ok(s.saveVersion('June'));
    // Only the hand-written route differs: the review says so rather than that the site already matches.
    const only = (await ok(s.reviewVersion(april.id!))).review!;
    expect(only).toMatchObject({ unchanged: true, others: [ROUTE] });
    // With a page changed too, the review names both, and the restore puts the page back but leaves the route.
    const home = s.state.site.homePageId;
    const homeTitle = s.state.pages[home].title;
    await ok(s.apply({ operations: [{ type: 'page.update', pageId: home, title: 'June home' }] }, { label: 'Rename home' }));
    const both = (await ok(s.reviewVersion(april.id!))).review!;
    expect(both).toMatchObject({ unchanged: false, others: [ROUTE] });
    expect(both.pages.changed).toEqual([homeTitle]);
    // Another route written by hand since the review, the project's revision the same: the review is out of date.
    const LATER = 'src/routes/later/+page.svelte';
    mkdirSync(join(dir, 'src/routes/later'), { recursive: true });
    writeFileSync(join(dir, LATER), '<p>Written since the review</p>\n');
    expect(s.revision).toBe(both.revision);
    const tip = await tipOf(dir);
    expect(await s.restoreVersion(april.id!, both.revision, { files: both.files, replaced: both.replaced, others: both.others })).toMatchObject({ ok: false, stale: true });
    expect(s.state.pages[home].title).toBe('June home');
    expect(await tipOf(dir)).toBe(tip);
    const stale = (await ok(s.reviewVersion(april.id!))).review!;
    expect(stale.others).toEqual([LATER, ROUTE]);
    // As many files as the review named, but not the same ones: out of date too.
    renameSync(join(dir, 'src/routes/later'), join(dir, 'src/routes/latest'));
    const LATEST = 'src/routes/latest/+page.svelte';
    expect(await s.restoreVersion(april.id!, stale.revision, { files: stale.files, replaced: stale.replaced, others: stale.others })).toMatchObject({ ok: false, stale: true });
    renameSync(join(dir, 'src/routes/latest'), join(dir, 'src/routes/later'));
    const again = (await ok(s.reviewVersion(april.id!))).review!;
    expect(again.others).toEqual([LATER, ROUTE]);
    expect(LATEST).not.toBe(LATER);
    const r = await ok(s.restoreVersion(april.id!, again.revision, { files: again.files, replaced: again.replaced, others: again.others }));
    expect(s.state.pages[home].title).toBe(homeTitle);
    expect(read(dir, ROUTE).toString()).toContain('Sundays in June');
    expect(r.others).toEqual([LATER, ROUTE]);
    // The site as restored is saved as it is, routes and all: it matches itself, and April still differs.
    const [row] = restoredRows(dir);
    expect(Buffer.from(await openRepo(dir).readBlob(row.git!.commit, ROUTE)).toString()).toContain('Sundays in June');
    expect((await ok(s.reviewVersion(row.id))).review).toMatchObject({ unchanged: true, others: [] });
    expect((await ok(s.reviewVersion(april.id!))).review).toMatchObject({ unchanged: true, others: [LATER, ROUTE] });
    // Restoring it again changes nothing, saves nothing more, and says what still differs.
    const last = await tipOf(dir);
    expect(await s.restoreVersion(april.id!, s.revision)).toMatchObject({ ok: true, unchanged: true, others: [LATER, ROUTE] });
    expect(await tipOf(dir)).toBe(last);
  });

  it('names a version’s own copy of a file the generator writes now, which restoring its pages retires (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const ROUTE = 'src/routes/signup/+page.svelte';
    await ok(s.apply({ operations: [{ type: 'page.create', title: 'Signup' }] }, { label: 'Add page' }));
    const bytes = read(dir, ROUTE);
    await ok(s.undo());
    expect(existsSync(join(dir, ROUTE))).toBe(false);
    // Written by hand, byte for byte what the generator writes for the page, and saved so.
    mkdirSync(join(dir, 'src/routes/signup'), { recursive: true });
    writeFileSync(join(dir, ROUTE), bytes);
    const april = await ok(s.saveVersion('April'));
    // The page back: the generator takes the file for its own, since it holds just what it would write.
    await ok(s.redo());
    expect(JSON.parse(read(dir, 'siteorigin/generated-manifest.json').toString()).files[ROUTE]).toBe(sha(bytes));
    const { review } = await ok(s.reviewVersion(april.id!));
    expect(review!.pages.gone).toEqual(['Signup']);
    // The same bytes on both sides, but April's copy isn't put back when the page goes, and the generator's goes with it.
    expect(review!.others).toEqual([ROUTE]);
    const r = await ok(s.restoreVersion(april.id!, review!.revision, { files: review!.files, replaced: review!.replaced, others: review!.others }));
    expect(r.others).toEqual([ROUTE]);
    expect(existsSync(join(dir, ROUTE))).toBe(false);
  });

  // Only a disk that tells names apart by case can hold a file named as a generated one but for its case.
  const caseSensitive = (() => {
    const d = mkdtempSync(join(tmpdir(), 'so-case-'));
    writeFileSync(join(d, 'a'), '');
    const yes = !existsSync(join(d, 'A'));
    rmSync(d, { recursive: true, force: true });
    return yes;
  })();
  it.runIf(caseSensitive)('tells a file written by hand from a generated one named the same but for its case (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    expect(JSON.parse(read(dir, 'siteorigin/generated-manifest.json').toString()).files['static/robots.txt']).toBeDefined();
    const april = await ok(s.saveVersion('April'));
    writeFileSync(join(dir, 'static/ROBOTS.txt'), 'User-agent: *\n');
    expect((await ok(s.reviewVersion(april.id!))).review!.others).toEqual(['static/ROBOTS.txt']);
  });

  it.runIf(!caseSensitive)('takes a library file renamed but for its case for the one the library names (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const pic = picture(dir, 'photo', 1);
    const early = picture(dir, 'early', 2);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...pic.asset } }, { type: 'asset.add', asset: { id: 'a_early', ...early.asset } }] }, { label: 'Import' }));
    // One renamed before the version is saved, so its snapshot holds it by the disk's spelling; one after.
    const rename = (file: string) => {
      const upper = file.replace(/\/(photo|early)-/, (m) => m.toUpperCase());
      renameSync(join(dir, file), join(dir, upper));
      return upper;
    };
    const before = rename(early.files[0]);
    const april = await ok(s.saveVersion('April'));
    writeFileSync(join(dir, before), 'changed since');
    writeFileSync(join(dir, rename(pic.files[0])), 'changed since');
    const { review } = await ok(s.reviewVersion(april.id!));
    expect(review!.replaced.sort()).toEqual([early.files[0], pic.files[0]].sort());
    expect(review!.others).toEqual([]);
  });

  it.runIf(!caseSensitive)('names a version’s hand-written file that Builder has taken over since under another spelling (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const HAND = 'src/routes/Signup/+page.svelte';
    mkdirSync(join(dir, 'src/routes/Signup'), { recursive: true });
    writeFileSync(join(dir, HAND), '<p>By hand</p>\n');
    const april = await ok(s.saveVersion('April'));
    // The page's route written into the folder as the disk spells it: the same file, now the generator's.
    rmSync(join(dir, HAND));
    await ok(s.apply({ operations: [{ type: 'page.create', title: 'Signup' }] }, { label: 'Add page' }));
    expect(JSON.parse(read(dir, 'siteorigin/generated-manifest.json').toString()).files['src/routes/signup/+page.svelte']).toBeDefined();
    expect(readdirSync(join(dir, 'src/routes'))).toContain('Signup');
    const { review } = await ok(s.reviewVersion(april.id!));
    expect(review!.pages.gone).toEqual(['Signup']);
    expect(review!.others).toEqual([HAND]);
  });

  it('reviews and restores past a file no snapshot could hold, naming it (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    writeFileSync(join(dir, 'static/grown.bin'), 'small in April');
    const april = await ok(s.saveVersion('April'));
    await describe1(s, 'Later', 'Later');
    // Too large for a snapshot (sparse, so nothing is written), one new and one that grew: with Git snapshots off the
    // work goes to the plain store.
    git.enabled = false;
    for (const name of ['huge.bin', 'grown.bin']) {
      const fd = openSync(join(dir, 'static', name), 'w');
      ftruncateSync(fd, 2 ** 31);
      closeSync(fd);
    }
    const { review } = await ok(s.reviewVersion(april.id!));
    expect(review!.problem).toBeUndefined();
    expect(review).toMatchObject({ site: true, others: ['static/grown.bin', 'static/huge.bin'] });
    expect(await ok(s.restoreVersion(april.id!, review!.revision, { files: review!.files, replaced: review!.replaced, others: review!.others }))).toMatchObject({ others: ['static/grown.bin', 'static/huge.bin'] });
    expect(s.state.site.description).not.toBe('Later');
  });

  it('compares the files a restore never copies, written by hand on either side, and not Builder’s own (#1396)', async () => {
    git.enabled = true;
    const { dir, s } = await make();
    const put = (rel: string, text: string) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    put('src/routes/same/+page.svelte', '<p>The same</p>\n');
    put('src/routes/gone/+page.svelte', '<p>Deleted since</p>\n');
    put('src/lib/schedule.js', 'export const day = "Saturday";\n');
    put('src/lib/tool.js', 'export {};\n');
    put('static/schedule.txt', 'Saturdays\n');
    const pic = picture(dir, 'photo', 1);
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_photo', ...pic.asset } }] }, { label: 'Import photo' }));
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Badge', source: '<p>One</p>\n' }] }, { label: 'Add badge' }));
    await ok(s.apply({ operations: [{ type: 'page.create', title: 'Volunteer' }] }, { label: 'Add page' }));
    await ok(s.apply({ operations: [{ type: 'page.create', title: 'Events' }] }, { label: 'Add page' }));
    const april = await ok(s.saveVersion('April'));
    const generated = () => Object.keys(JSON.parse(read(dir, 'siteorigin/generated-manifest.json').toString()).files as Record<string, string>);
    const volunteer = generated().find((p) => p.startsWith('src/routes/') && p.includes('volunteer'))!;
    expect(volunteer).toBeDefined();

    // Since: hand-written files changed, added, removed and made to run; the component's code, a library picture and
    // the pages changed; and the Volunteer page removed, a hand-written route put where its generated one was.
    put('src/lib/schedule.js', 'export const day = "Sunday";\n');
    rmSync(join(dir, 'src/routes/gone'), { recursive: true });
    put('src/routes/new/+page.svelte', '<p>Added since</p>\n');
    put('static/schedule.txt', 'Sundays\n');
    if (process.platform !== 'win32') chmodSync(join(dir, 'src/lib/tool.js'), 0o755);
    const badge = Object.values(s.state.components).find((c) => c.name === 'Badge')!;
    await ok(s.apply({ operations: [{ type: 'component.updateSource', definitionId: badge.id, source: '<p>Two</p>\n' }] }, { label: 'Edit badge' }));
    writeFileSync(join(dir, pic.files[1]), 'another 480');
    const page = Object.values(s.state.pages).find((p) => p.title === 'Volunteer')!;
    await ok(s.apply({ operations: [{ type: 'page.remove', pageId: page.id }] }, { label: 'Remove page' }));
    expect(generated()).not.toContain(volunteer);
    put(volunteer, '<p>Written by hand</p>\n');
    // Generated output that only one side has is no other file: Events' route went with its page, Later's came with its.
    const events = Object.values(s.state.pages).find((p) => p.title === 'Events')!;
    await ok(s.apply({ operations: [{ type: 'page.remove', pageId: events.id }, { type: 'page.create', title: 'Later' }] }, { label: 'Swap pages' }));
    expect(generated().some((p) => p.includes('events'))).toBe(false);
    expect(generated().some((p) => p.includes('later'))).toBe(true);

    const others = ['src/lib/schedule.js', ...(process.platform !== 'win32' ? ['src/lib/tool.js'] : []), 'src/routes/gone/+page.svelte', 'src/routes/new/+page.svelte', volunteer, 'static/schedule.txt'].sort();
    const { review } = await ok(s.reviewVersion(april.id!));
    // The component's code, the picture, the generated routes and the documents are reviewed as ever, not as other files.
    expect(review).toMatchObject({ components: 1, replaced: [pic.files[1]], others });
    expect(review!.pages.back.sort()).toEqual(['Events', 'Volunteer']);
    // So whether Git snapshots are still on or not, and opened read-only, where the generator's record is only read.
    git.enabled = false;
    expect((await ok(s.reviewVersion(april.id!))).review!.others).toEqual(others);
    await s.close();
    const ro = await ProjectSession.openReadOnly(dir, { reason: 'Open elsewhere.', canUnlock: false });
    open.push(ro);
    expect((await ok(ro.reviewVersion(april.id!))).review!.others).toEqual(others);
  });

  it('names no other files for a version in the plain store, and asks nothing of Git for it (#1396)', async () => {
    const { dir, s } = await make();
    mkdirSync(join(dir, 'src/routes/volunteer'), { recursive: true });
    writeFileSync(join(dir, 'src/routes/volunteer/+page.svelte'), '<p>April</p>\n');
    const plain = await ok(s.saveVersion('Plain'));
    writeFileSync(join(dir, 'src/routes/volunteer/+page.svelte'), '<p>June</p>\n');
    git.enabled = true;
    const calls = git.calls.length;
    expect((await ok(s.reviewVersion(plain.id!))).review).toMatchObject({ unchanged: true, others: [] });
    expect(git.calls.length).toBe(calls);
  });

  it('refuses a review whose saved files can’t be read, rather than say none differ (#1396)', async () => {
    git.enabled = true;
    const { s } = await make();
    const saved = await ok(s.saveVersion('Saved'));
    // A folder deep in the tree, not its top: every part of it is read.
    const src = (await openRepo(s.dir).readTree(catalogue(s.dir).find((v) => v.id === saved.id)!.git!.tree)).find((e) => e.path === 'src')!.oid;
    const spy = intercept((repo) => ({ readTree: async (oid, call) => (oid === src ? Promise.reject(new GitError('not-found', 'gone')) : repo.readTree(oid, call)) }));
    const { review } = await ok(s.reviewVersion(saved.id!));
    spy.mockRestore();
    expect(review!.problem).toMatch(/damaged/);
    const healthy = (await ok(s.reviewVersion(saved.id!))).review!;
    expect(healthy.problem).toBeUndefined();
    expect(healthy).toMatchObject({ unchanged: true, others: [] });
  });
});

describe('the saved version wording', () => {
  const base: VersionReview = { revision: 1, pages: { back: [], gone: [], changed: [] }, entries: { back: [], gone: [], changed: [] }, collections: { back: [], gone: [], changed: [] }, site: false, styles: false, components: 0, library: false, files: [], replaced: [], left: [], others: [], missing: [], unchanged: false };

  it('names pages first, at most four a line, then what else changes', () => {
    const lines = describeReview({
      ...base,
      pages: { back: ['About'], gone: ['Experiments', 'Lab'], changed: ['Home', 'Work', 'Team', 'Prices', 'Blog', 'FAQ'] },
      site: true,
      styles: true,
      components: 2,
      library: true,
      files: ['static/assets/a-12345678.png', 'static/brand/logo.svg'],
      replaced: ['static/brand/logo.svg'],
      left: ['static/proof.pdf']
    });
    expect(lines).toEqual([
      'Brings back 1 page: “About”',
      'Removes 2 pages it doesn’t have: “Experiments” and “Lab”',
      'Changes 6 pages: “Home”, “Work”, “Team”, “Prices” and 2 more',
      'Changes site settings: the name, header, footer or page order',
      'Changes site styles: colors, fonts and spacing',
      'Changes 2 components',
      'Changes the images and fonts in the library',
      'Puts back 1 file the site uses',
      'Replaces 1 file changed since it was saved: logo.svg',
      '1 file the earlier restore put back stays in the project folder, since its Undo needs it: proof.pdf'
    ]);
    expect(describeReview(base)).toEqual([]);
  });

  it('names collection entries a restore removes, brings back or changes', () => {
    expect(describeReview({ ...base, entries: { back: ['Old'], gone: ['After V1'], changed: ['A', 'B'] }, collections: { back: ['Docs'], gone: ['Team'], changed: ['Posts'] } })).toEqual([
      'Brings back 1 entry: “Old”',
      'Removes 1 entry it doesn’t have: “After V1”',
      'Changes 2 entries: “A” and “B”',
      'Brings back 1 collection: “Docs”',
      'Removes 1 collection it doesn’t have: “Team”',
      'Changes the settings of 1 collection: “Posts”'
    ]);
  });

  it('says where the replaced work went after a restore', () => {
    expect(restoredNotice('Approved', true)).toBe('Restored “Approved”. Your work from before is kept in Saved versions.');
    expect(restoredNotice('Draft', false)).toBe('Restored “Draft”.');
    // Undo takes back documents only: files put over others are pointed to the saved work.
    expect(restoredNotice('Approved', true, 2)).toBe('Restored “Approved”. Undo won’t bring back the 2 files it replaced, but your work from before, kept in Saved versions, has them.');
    expect(restoredNotice('Approved', true, 1)).toBe('Restored “Approved”. Undo won’t bring back the 1 file it replaced, but your work from before, kept in Saved versions, has it.');
    expect(restoredNotice('Before', true, 0, ['static/a.pdf', 'static/b.pdf'])).toBe(
      'Restored “Before”. Your work from before is kept in Saved versions. 2 files the earlier restore put back stay in the project folder, since its Undo needs them: a.pdf, b.pdf.'
    );
  });

  it('names the other files a restore doesn’t copy by their whole paths, since routes share a name (#1396)', () => {
    const routes = ['src/routes/a/+page.svelte', 'src/routes/b/+page.svelte', 'src/routes/c/+page.svelte', 'src/routes/d/+page.svelte', 'src/routes/e/+page.svelte'];
    expect(describeReview({ ...base, pages: { back: [], gone: [], changed: ['Home'] }, others: ['src/routes/volunteer/+page.svelte'] })).toEqual([
      'Changes 1 page: “Home”',
      'Doesn’t copy 1 other file from it, which stays as it is now, or as Builder generates it (removed if it no longer does): src/routes/volunteer/+page.svelte'
    ]);
    // A review names every one of them; a notice at most four.
    expect(describeReview({ ...base, others: routes })).toEqual([`Doesn’t copy 5 other files from it, which stay as they are now, or as Builder generates them (removed where it no longer does): ${routes.join(', ')}`]);
    expect(othersOnly(['package.json'])).toEqual(['Your pages, settings and media already match this version.', '1 other file differs from it, and restoring doesn’t copy it: package.json.']);
    expect(othersOnly(routes)[1]).toBe(`5 other files differ from it, and restoring doesn’t copy them: ${routes.join(', ')}.`);
    expect(restoredNotice('April', true, 0, [], ['src/routes/volunteer/+page.svelte'])).toBe(
      'Restored “April”. Your work from before is kept in Saved versions. 1 other file wasn’t copied from it: src/routes/volunteer/+page.svelte.'
    );
    expect(restoredNotice('April', true, 0, [], routes.slice(0, 4))).toBe(
      `Restored “April”. Your work from before is kept in Saved versions. 4 other files weren’t copied from it: ${routes.slice(0, 4).join(', ')}.`
    );
    expect(restoredNotice('April', true, 2, [], routes)).toBe(
      'Restored “April”. Undo won’t bring back the 2 files it replaced, but your work from before, kept in Saved versions, has them. 5 other files weren’t copied from it: src/routes/a/+page.svelte, src/routes/b/+page.svelte, src/routes/c/+page.svelte, src/routes/d/+page.svelte and 1 more.'
    );
  });
});
