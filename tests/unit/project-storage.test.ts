/**
 * Project storage (issue #253): what current media and files kept for Undo take, and an explicit reclaim that
 * trims history from its ends only, so every step that stays still undoes and redoes, before deleting the files
 * only the dropped steps could bring back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { describeTrim, formatBytes } from '../../src/renderer/src/lib/storage';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-storage-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Storage', false));
  open.push(s);
  return { dir, s };
}

const ASSETS = 'static/assets';
const has = (dir: string, f: string) => existsSync(join(dir, ASSETS, f));

/** An image as the importer leaves it: an original and two responsive copies, `bytes` each. */
function image(dir: string, slug: string, hash: string, bytes = 1000): { asset: AssetRecord; files: string[] } {
  mkdirSync(join(dir, ASSETS), { recursive: true });
  const files = [`${slug}-${hash}.png`, `${slug}-${hash}-480w.png`, `${slug}-${hash}-960w.png`];
  for (const f of files) writeFileSync(join(dir, ASSETS, f), Buffer.alloc(bytes, 1));
  const asset: AssetRecord = {
    id: `a_${slug}`,
    name: slug,
    file: `${ASSETS}/${files[0]}`,
    mime: 'image/png',
    bytes,
    hash,
    kind: 'image',
    createdAt: new Date().toISOString(),
    variants: [
      { width: 480, file: `${ASSETS}/${files[1]}` },
      { width: 960, file: `${ASSETS}/${files[2]}` }
    ]
  };
  return { asset, files };
}

async function ok(p: Promise<{ ok: boolean; error?: { message: string } }>) {
  const r = await p;
  expect(r.error?.message).toBeUndefined();
  expect(r.ok).toBe(true);
}

const site = (s: ProjectSession, patch: { name?: string; description?: string }, label: string) => ok(s.apply({ operations: [{ type: 'site.update', ...patch }] }, { label }));
const labels = (s: ProjectSession) => s.historyInfo().entries.map((e) => e.label);

describe('project storage', () => {
  it('counts removed images as kept for Undo, across a reopen, and as media again once undone', async () => {
    const { dir, s } = await make();
    const { asset } = image(dir, 'photo', '1a2b3c4d');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    let info = await s.storageInfo();
    expect(info.media).toEqual({ files: 3, bytes: 3000 });
    expect(info.kept).toEqual({ files: 0, bytes: 0 });
    expect(info.reclaim).toBeNull();

    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: asset.id }] }, { label: 'Remove image' }));
    info = await s.storageInfo();
    expect(info.media).toEqual({ files: 0, bytes: 0 });
    expect(info.kept).toEqual({ files: 3, bytes: 3000 });
    expect(info.history.steps).toBe(2);
    expect(info.history.bytes).toBeGreaterThan(0);
    expect(info.reclaim).toMatchObject({ files: { files: 3, bytes: 3000 }, undo: ['Import image', 'Remove image'], redo: [], keptUndo: 0, keptRedo: 0 });
    expect(info.blocked).toBeUndefined();

    // The same after closing and reopening: history still holds them.
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    open.push(again);
    expect((await again.storageInfo()).kept).toEqual({ files: 3, bytes: 3000 });
    await ok(again.undo());
    info = await again.storageInfo();
    expect(info.media).toEqual({ files: 3, bytes: 3000 });
    expect(info.kept).toEqual({ files: 0, bytes: 0 });
  });

  it('frees the space by dropping only the oldest steps, so later steps still undo and current images keep every size', async () => {
    const { dir, s } = await make();
    const kept = image(dir, 'logo', 'aaaabbbb', 10);
    const gone = image(dir, 'photo', '1a2b3c4d', 2000);
    writeFileSync(join(dir, ASSETS, 'hand-placed.png'), 'png');
    await site(s, { name: 'Before' }, 'Rename site');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: kept.asset }, { type: 'asset.add', asset: gone.asset }] }, { label: 'Import 2 images' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: gone.asset.id }] }, { label: 'Remove photo' }));
    await site(s, { name: 'Later' }, 'Later edit');
    await site(s, { name: 'Latest' }, 'Latest edit');

    const info = await s.storageInfo();
    expect(info.media).toEqual({ files: 3, bytes: 30 });
    expect(info.kept).toEqual({ files: 3, bytes: 6000 });
    const plan = info.reclaim!;
    expect(plan.undo).toEqual(['Rename site', 'Import 2 images', 'Remove photo']);
    expect(plan.keptUndo).toBe(2);
    expect(plan.historyBytes).toBeGreaterThan(0);

    // The files are minutes old: an explicit reclaim does not wait out the sweep's grace period for them.
    const r = await s.reclaimStorage(plan.key);
    expect(r).toMatchObject({ ok: true });
    expect(r.freed).toBe(6000 + plan.historyBytes);
    for (const f of gone.files) expect(has(dir, f)).toBe(false);
    for (const f of kept.files) expect(has(dir, f)).toBe(true);
    expect(has(dir, 'hand-placed.png')).toBe(true);
    expect(labels(s)).toEqual(['Later edit', 'Latest edit']);
    expect(Object.keys(s.state.assets.assets)).toEqual([kept.asset.id]);

    const after = await s.storageInfo();
    expect(after.kept).toEqual({ files: 0, bytes: 0 });
    expect(after.reclaim).toBeNull();
    // Every step that stayed still undoes and redoes.
    await ok(s.undo());
    await ok(s.undo());
    expect(s.state.site.name).toBe('Before');
    expect(s.historyInfo().canUndo).toBe(false);
    await ok(s.redo());
    await ok(s.redo());
    expect(s.state.site.name).toBe('Latest');
  });

  it('drops the redo steps that would bring a removed image back, keeping the ones before them', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await site(s, { name: 'First' }, 'Rename site');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    await site(s, { name: 'Third' }, 'Rename again');
    await ok(s.undo());
    await ok(s.undo());
    const plan = (await s.storageInfo()).reclaim!;
    expect(plan).toMatchObject({ undo: [], redo: ['Import image', 'Rename again'], keptUndo: 1, keptRedo: 0 });
    expect((await s.reclaimStorage(plan.key)).ok).toBe(true);
    for (const f of files) expect(has(dir, f)).toBe(false);
    expect(labels(s)).toEqual(['Rename site']);
    expect(s.historyInfo().canRedo).toBe(false);
    await ok(s.undo());
  });

  it('keeps a file the project still names outside its library, and drops a later step whose undo would name a deleted one', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: asset.id }] }, { label: 'Remove image' }));
    // A hand-written style sheet uses the small copy by its address.
    mkdirSync(join(dir, 'static/css'), { recursive: true });
    writeFileSync(join(dir, 'static/css/extra.css'), `.hero { background: url(/assets/${files[1]}); }\n`);
    // A document named the large copy for a while: undoing the second edit would bring that mention back.
    await site(s, { description: `See /assets/${files[2]}` }, 'Describe with image');
    await site(s, { description: 'Plain' }, 'Describe plainly');
    await site(s, { name: 'Unrelated' }, 'Unrelated edit');

    const info = await s.storageInfo();
    expect(info.media.files).toBe(1);
    expect(info.kept.files).toBe(2);
    const plan = info.reclaim!;
    expect(plan.undo).toEqual(['Import image', 'Remove image', 'Describe with image', 'Describe plainly']);
    expect(plan.keptUndo).toBe(1);
    expect((await s.reclaimStorage(plan.key)).ok).toBe(true);
    expect(has(dir, files[0])).toBe(false);
    expect(has(dir, files[1])).toBe(true);
    expect(has(dir, files[2])).toBe(false);
    expect(labels(s)).toEqual(['Unrelated edit']);
    await ok(s.undo());
    expect(s.state.site.description).toBe('Plain');
  });

  it('refuses a plan the project has moved past, changing nothing', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: asset.id }] }, { label: 'Remove image' }));
    const plan = (await s.storageInfo()).reclaim!;
    await ok(s.undo());
    await ok(s.redo());
    const second = image(dir, 'other', 'ccccdddd');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset: second.asset }] }, { label: 'Import other' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: second.asset.id }] }, { label: 'Remove other' }));
    const r = await s.reclaimStorage(plan.key);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/changed/);
    for (const f of [...files, ...second.files]) expect(has(dir, f)).toBe(true);
    expect(labels(s)).toEqual(['Import image', 'Remove image', 'Import other', 'Remove other']);
    expect((await s.reclaimStorage('nonsense')).ok).toBe(false);
  });

  it('refuses while an AI run is open or an import is in progress', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: asset.id }] }, { label: 'Remove image' }));
    const { key } = (await s.storageInfo()).reclaim!;

    expect(await s.beginRun('run_a')).toBeNull();
    expect((await s.storageInfo()).blocked).toMatch(/AI/);
    expect((await s.reclaimStorage(key)).ok).toBe(false);
    await s.abortRun();

    let finish!: () => void;
    const importing = s.withImport(() => new Promise<void>((r) => (finish = r)));
    const r = await s.reclaimStorage(key);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/being added/);
    finish();
    await importing;
    for (const f of files) expect(has(dir, f)).toBe(true);
    expect((await s.reclaimStorage(key)).ok).toBe(true);
  });

  it('holds an import back until a reclaim has finished deleting', async () => {
    const { dir, s } = await make();
    const { asset } = image(dir, 'photo', '1a2b3c4d');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: asset.id }] }, { label: 'Remove image' }));
    const { key } = (await s.storageInfo()).reclaim!;
    const rm = fsp.rm;
    let reached!: () => void;
    const deleting = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(fsp, 'rm').mockImplementation(async (...args: Parameters<typeof fsp.rm>) => {
      if (String(args[0]).startsWith(join(dir, ASSETS))) {
        reached();
        await held;
      }
      return rm(...args);
    });
    const reclaim = s.reclaimStorage(key);
    await deleting;
    const order: string[] = [];
    const importing = s.withImport(async () => void order.push('import'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    expect((await reclaim).ok).toBe(true);
    await importing;
    expect(order).toEqual(['import']);
  });

  it('keeps an imported file a style sheet names when a sweep finds no record or history for it', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await ok(s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' }));
    await ok(s.apply({ operations: [{ type: 'asset.remove', assetId: asset.id }] }, { label: 'Remove image' }));
    await site(s, { name: 'Later' }, 'Later edit');
    writeFileSync(join(dir, 'static/extra.css'), `.a { background: url(/assets/${files[2]}); }\n`);
    const old = new Date(Date.now() - 60 * 60_000);
    for (const f of files) utimesSync(join(dir, ASSETS, f), old, old);
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(labels(s)).toEqual(['Later edit']);
    expect(has(dir, files[0])).toBe(false);
    expect(has(dir, files[1])).toBe(false);
    expect(has(dir, files[2])).toBe(true);
  });
});

describe('the Free up space dialog wording', () => {
  const plan = (undo: string[], redo: string[], keptUndo: number, keptRedo: number) => ({ key: 'k', files: { files: 1, bytes: 1 }, historyBytes: 0, undo, redo, keptUndo, keptRedo });

  it('names the newest lost undo steps first, counts the rest, and says what stays', () => {
    const t = describeTrim(plan(['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6'], [], 2, 0));
    expect(t.undo).toEqual({ lead: 'These 6 steps can no longer be undone:', steps: ['Step 6', 'Step 5', 'Step 4', 'Step 3'], more: 'and 2 earlier steps', after: 'Your 2 latest steps can still be undone.' });
    expect(t.redo).toBeNull();
  });

  it('says when nothing is left to undo, and which redo steps stay', () => {
    const t = describeTrim(plan(['Remove 6 unused images'], ['Import image'], 0, 1));
    expect(t.undo).toMatchObject({ lead: 'This step can no longer be undone:', steps: ['Remove 6 unused images'], more: null, after: 'Nothing will be left to undo.' });
    expect(t.redo).toMatchObject({ lead: 'This step can no longer be redone:', steps: ['Import image'], after: '1 step before it can still be redone.' });
  });

  it('formats sizes the way the panel shows them', () => {
    expect(formatBytes(49_661_260)).toBe('47.4 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1)).toBe('1 byte');
  });
});
