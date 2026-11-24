/**
 * Saved versions (issue 260): a named copy of the whole site, its documents and the media they name, kept apart from
 * the rolling undo history until the author deletes it. Restoring one is a single Undo step, and the work it replaces
 * is saved first as a version of its own, so the way back outlasts history too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { sha } from '../../src/main/project/fsutil';
import { describeReview, restoredNotice } from '../../src/renderer/src/lib/versions';
import type { VersionReview } from '@shared/api';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
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
    const saved = await ok(s.saveVersion('  Approved   portfolio '));
    const firstEntries = s.historyInfo().entries.map((e) => e.id);

    // A redesign: a new page and 101 more steps, so every step from before the save has rotated out of history.
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
    expect(Date.parse(listed[0].time)).toBeLessThanOrEqual(Date.now());
    expect(listed[0].bytes).toBeGreaterThan(0);

    const { review } = await ok(again.reviewVersion(saved.id!));
    expect(review).toMatchObject({ site: true, unchanged: false, files: [], missing: [] });
    expect(review!.pages.gone).toEqual(['Experiments']);
    expect(review!.problem).toBeUndefined();

    const r = await ok(again.restoreVersion(saved.id!, review!.revision));
    expect(r.entryId).toBeTruthy();
    expect(r.backup?.name).toBe('Before restoring “Approved portfolio”');
    expect(read(dir, 'siteorigin/site.json').toString()).toBe(approvedSite);
    expect(Object.keys(again.state.pages).sort()).toEqual(approvedPages);
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

    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review).toMatchObject({ files: [`${ASSETS}/logo.svg`], unchanged: false });
    const r = await ok(s.restoreVersion(saved.id!, review!.revision));
    expect(read(dir, `${ASSETS}/logo.svg`).toString()).toBe('<svg>blue</svg>');
    // Only a file changed, so there is no document step to undo: the saved work is the way back.
    expect(r.entryId).toBeUndefined();
    expect(readdirSync(join(dir, '.siteorigin/recovery')).some((f) => f.endsWith('static__assets__logo.svg'))).toBe(true);
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

    await ok(s.deleteVersion(second.id!));
    expect(objects(dir)).toEqual([]);
    expect((await s.storageInfo()).versions).toEqual({ count: 0, bytes: 0 });
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
    const { review } = await ok(s.reviewVersion(saved.id!));
    expect(review!.missing).toEqual([a.files[1]]);
    await ok(s.restoreVersion(saved.id!, review!.revision));
    expect(s.state.site.description).not.toBe('Later');
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
    expect((await s.restoreVersion(saved.id!, s.revision)).message).toMatch(/AI/);
    expect((await s.saveVersion('During AI')).message).toMatch(/AI/);
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
    rmSync(join(dir, '.siteorigin/versions/objects', index.versions[0].docs['siteorigin/site.json']));
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
    index.versions[0].schemaVersion = 999;
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
    await s.close();
    const again = await reopen(dir);
    expect(existsSync(stray)).toBe(false);
    expect(objects(dir).sort()).toEqual(kept);
    expect(again.versionsInfo().list).toHaveLength(1);
  });

  it('refuses an empty or overlong name', async () => {
    const { s } = await make();
    expect((await s.saveVersion('   ')).ok).toBe(false);
    expect((await s.saveVersion('x'.repeat(81))).ok).toBe(false);
    expect(s.versionsInfo().list).toEqual([]);
  });
});

describe('the saved version wording', () => {
  const base: VersionReview = { revision: 1, pages: { back: [], gone: [], changed: [] }, site: false, styles: false, components: 0, library: false, files: [], missing: [], unchanged: false };

  it('names pages first, at most four a line, then what else changes', () => {
    const lines = describeReview({
      ...base,
      pages: { back: ['About'], gone: ['Experiments', 'Lab'], changed: ['Home', 'Work', 'Team', 'Prices', 'Blog', 'FAQ'] },
      styles: true,
      components: 2,
      files: ['static/assets/a-12345678.png']
    });
    expect(lines).toEqual([
      'Brings back 1 page: “About”',
      'Removes 2 pages it doesn’t have: “Experiments” and “Lab”',
      'Changes 6 pages: “Home”, “Work”, “Team”, “Prices” and 2 more',
      'Changes site styles: colors, fonts and spacing',
      'Changes 2 components',
      'Puts back 1 file the site uses'
    ]);
  });

  it('says where the replaced work went after a restore', () => {
    expect(restoredNotice('Approved', true)).toBe('Restored “Approved”. Your work from before is kept in Saved versions.');
    expect(restoredNotice('Approved', false)).toBe('Restored “Approved”.');
  });
});
