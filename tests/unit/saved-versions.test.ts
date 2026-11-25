/**
 * Saved versions (issue 260): a named copy of the whole site, its documents and the media they name, kept apart from
 * the rolling undo history until the author deletes it. Restoring one is a single Undo step, and the work it replaces
 * is saved first as a version of its own, so the way back outlasts history too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { sha } from '../../src/main/project/fsutil';
import { describeReview, restoredNotice } from '../../src/renderer/src/lib/versions';
import type { VersionReview } from '@shared/api';

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
  it('keeps a version after 100 more edits and a reopen, and restores it as one Undo step with the way back saved', async () => {
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
    expect(listed[0].bytes).toBeGreaterThan(0);

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
    expect(names).toEqual([
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

  it('brings back an image after it was replaced and its old files were deleted, with every size', async () => {
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

  it('puts back a file changed in place outside the app, and the version saved before restoring holds the changed one', async () => {
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

  it('reuses a saved version that already holds the work a restore replaces', async () => {
    const { s } = await make();
    await describe1(s, 'One', 'One');
    const one = await ok(s.saveVersion('One'));
    await describe1(s, 'Two', 'Two');
    const two = await ok(s.saveVersion('Two'));
    const r = await ok(s.restoreVersion(one.id!, s.revision));
    expect(r.backup).toEqual({ id: two.id, name: 'Two' });
    expect(s.versionsInfo().list).toHaveLength(2);
    // Both hold the same starter documents: neither alone frees those.
    const [b, a] = s.versionsInfo().list;
    expect(a.bytes + b.bytes).toBeLessThan(s.versionsInfo().bytes);
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

  it('saves though an image is missing, says which, and restores the rest', async () => {
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

  it('refuses to restore over a change made since the review, while the AI works, or in a read-only project', async () => {
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

  it('refuses a version saved by a newer app', async () => {
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

  it('refuses an empty or overlong name', async () => {
    const { s } = await make();
    expect((await s.saveVersion('   ')).ok).toBe(false);
    expect((await s.saveVersion('x'.repeat(81))).ok).toBe(false);
    expect(s.versionsInfo().list).toEqual([]);
    await ok(s.saveVersion('x'.repeat(80)));
  });
});

describe('saved versions, guarded', () => {
  it('holds a file anywhere under static/ that a document names by its address, but not generated files', async () => {
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

  it('does not hold a file in the project only because an image came from a file of that name', async () => {
    const { dir, s } = await make();
    const photo = picture(dir, 'mark', 1);
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>unrelated</svg>');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: { id: 'a_mark', ...photo.asset, originalName: 'logo.svg' } }] }, { label: 'Add mark' }));
    await ok(s.saveVersion('With a mark'));
    const media = Object.keys(JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions[0].media);
    expect(media).toContain(photo.files[0]);
    expect(media).not.toContain(`${ASSETS}/logo.svg`);
  });

  it('refuses a restore when a file changed outside the app after the review', async () => {
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

  it('keeps the names of versions saved before restores short, however often restores nest', async () => {
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
    expect(again.versionsInfo().list).toHaveLength(5);
  });

  it('refuses to save while a change made outside the app is not loaded yet', async () => {
    const { dir, s } = await make();
    const site = JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));
    writeFileSync(join(dir, 'siteorigin/site.json'), JSON.stringify({ ...site, description: 'Edited outside' }));
    expect(await s.saveVersion('Too soon')).toMatchObject({ ok: false, message: expect.stringMatching(/changed outside the app/) });
    expect(s.versionsInfo().list).toEqual([]);
  });

  it('puts the files back as they were when saving the documents fails, and reopening says nothing of it', async () => {
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

  it('says on reopening that a restore stopped part way, and where the work from before is', async () => {
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

  it('leaves a file changed by someone else while restoring, rather than putting back over it', async () => {
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

  it('holds what a restore replaces in the work saved first, even a file the work did not name', async () => {
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

  it('says which files an earlier restore put back are left when going back to the work from before', async () => {
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

  it('treats a missing file that appeared after the review as a change', async () => {
    const { dir, s, saved } = await withLogo();
    rmSync(join(dir, ASSETS, 'logo.svg'));
    await describe1(s, 'Later', 'Later');
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review).toMatchObject({ files: [`${ASSETS}/logo.svg`], replaced: [] });
    writeFileSync(join(dir, ASSETS, 'logo.svg'), '<svg>new</svg>');
    expect(await s.restoreVersion(saved.id!, review!.revision, { files: review!.files, replaced: review!.replaced })).toMatchObject({ ok: false, stale: true });
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>new</svg>');
  });

  it('holds a file named by its encoded address, and never a private one', async () => {
    const { dir, s } = await make();
    mkdirSync(join(dir, 'static/brand'), { recursive: true });
    writeFileSync(join(dir, 'static/brand/My Logo.svg'), '<svg>mine</svg>');
    writeFileSync(join(dir, 'static/brand/server.key'), 'secret');
    await ok(s.apply({ operations: [{ type: 'component.createCode', name: 'Brand', source: '<img src="/brand/My%20Logo.svg" alt="Logo" />\n<a href="/brand/server.key">Key</a>\n' }] }, { label: 'Add brand' }));
    await ok(s.saveVersion('Brand'));
    const media = Object.keys(JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions[0].media);
    expect(media).toEqual(['static/brand/My Logo.svg']);
  });

  it('refuses to save while a component added outside the app is not loaded yet', async () => {
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

  it('keeps the files once the documents are saved, even when a later step of that save fails', async () => {
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

  it('keeps the note of a restore it could not fully undo through a later restore', async () => {
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

  it('holds a named link, or a library file reached through a link out of the project, as missing', async () => {
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

describe('the saved version wording', () => {
  const base: VersionReview = { revision: 1, pages: { back: [], gone: [], changed: [] }, site: false, styles: false, components: 0, library: false, files: [], replaced: [], left: [], missing: [], unchanged: false };

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
});
