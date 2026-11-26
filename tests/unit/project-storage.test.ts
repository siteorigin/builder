/**
 * Project storage (issue #253): what current media and files kept for Undo take, and an explicit reclaim that
 * trims history from its ends only, so every step that stays still undoes and redoes, before deleting the files
 * only the dropped steps could bring back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
async function reopen(dir: string) {
  const s = await ProjectSession.open(dir, 'test');
  open.push(s);
  return s;
}

const ASSETS = 'static/assets';
const has = (dir: string, f: string) => existsSync(join(dir, ASSETS, f));
const blobBytes = (dir: string) => readdirSync(join(dir, '.siteorigin/history/blobs')).filter((f) => f.endsWith('.json')).reduce((n, f) => n + statSync(join(dir, '.siteorigin/history/blobs', f)).size, 0);

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
const add = (s: ProjectSession, assets: AssetRecord[], label: string) => ok(s.apply({ operations: assets.map((asset) => ({ type: 'asset.add' as const, asset })) }, { label }));
const remove = (s: ProjectSession, assets: AssetRecord[], label: string) => ok(s.apply({ operations: assets.map((a) => ({ type: 'asset.remove' as const, assetId: a.id })) }, { label }));
const labels = (s: ProjectSession) => s.historyInfo().entries.map((e) => e.label);
const write = (dir: string, rel: string, content: string | Buffer) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

describe('project storage', () => {
  it('counts removed images as kept for Undo, across a reopen, and as media again once undone', async () => {
    const { dir, s } = await make();
    const { asset } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    let info = await s.storageInfo();
    expect(info.media).toEqual({ files: 3, bytes: 3000 });
    expect(info.kept).toEqual({ files: 0, bytes: 0 });
    expect(info.reclaim).toBeNull();

    await remove(s, [asset], 'Remove image');
    info = await s.storageInfo();
    expect(info.media).toEqual({ files: 0, bytes: 0 });
    expect(info.kept).toEqual({ files: 3, bytes: 3000 });
    // Each stored version counts once, however many steps share it.
    expect(info.history).toEqual({ steps: 2, bytes: blobBytes(dir) });
    expect(info.reclaim).toMatchObject({ files: { files: 3, bytes: 3000 }, historyBytes: blobBytes(dir), undo: ['Import image', 'Remove image'], redo: [], keptUndo: 0, keptRedo: 0 });
    expect(info.blocked).toBeUndefined();

    // The same after closing and reopening: history still holds them.
    await s.close();
    const again = await reopen(dir);
    expect((await again.storageInfo()).kept).toEqual({ files: 3, bytes: 3000 });
    await ok(again.undo());
    info = await again.storageInfo();
    expect(info.media).toEqual({ files: 3, bytes: 3000 });
    expect(info.kept).toEqual({ files: 0, bytes: 0 });
    // Steps that can be redone count too.
    expect(info.history.steps).toBe(2);
  });

  it('frees the space by dropping only the oldest steps, so later steps still undo and current images keep every size', async () => {
    const { dir, s } = await make();
    const kept = image(dir, 'logo', 'aaaabbbb', 10);
    const gone = image(dir, 'photo', '1a2b3c4d', 2000);
    writeFileSync(join(dir, ASSETS, 'hand-placed.png'), 'png');
    await site(s, { name: 'Before' }, 'Rename site');
    await add(s, [kept.asset, gone.asset], 'Import 2 images');
    await remove(s, [gone.asset], 'Remove photo');
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
    // The versions only the dropped steps used are gone from disk too.
    expect(blobBytes(dir)).toBe(after.history.bytes);
    // The shorter history is what the project reopens with, and every step that stayed still undoes and redoes.
    await s.close();
    const again = await reopen(dir);
    expect(labels(again)).toEqual(['Later edit', 'Latest edit']);
    await ok(again.undo());
    await ok(again.undo());
    expect(again.state.site.name).toBe('Before');
    expect(again.historyInfo().canUndo).toBe(false);
    await ok(again.redo());
    await ok(again.redo());
    expect(again.state.site.name).toBe('Latest');
  });

  it('drops the redo steps that would bring a removed image back, keeping the nearer ones', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await site(s, { name: 'First' }, 'Rename site');
    await site(s, { name: 'Second' }, 'Rename again');
    await add(s, [asset], 'Import image');
    await site(s, { name: 'Fourth' }, 'Rename last');
    for (let i = 0; i < 3; i++) await ok(s.undo());
    const plan = (await s.storageInfo()).reclaim!;
    expect(plan).toMatchObject({ undo: [], redo: ['Import image', 'Rename last'], keptUndo: 1, keptRedo: 1 });
    expect((await s.reclaimStorage(plan.key)).ok).toBe(true);
    for (const f of files) expect(has(dir, f)).toBe(false);
    expect(labels(s)).toEqual(['Rename site', 'Rename again']);
    await ok(s.redo());
    expect(s.state.site.name).toBe('Second');
    expect(s.historyInfo().canRedo).toBe(false);
    await ok(s.undo());
    await ok(s.undo());
    expect(s.state.site.name).toBe('Storage');
  });

  it('remembers whether each AI step it drops was applied or undone, so its chat turn still says (issue 276)', async () => {
    const ai = async (s: ProjectSession, runId: string, name: string) => {
      expect(await s.beginRun(runId)).toBeNull();
      await ok(s.apply({ operations: [{ type: 'site.update', name }] }, { label: 'AI', source: 'ai', runId, history: false }));
      expect(await s.completeRun(`AI: ${name}`)).toBe(true);
    };
    const { dir, s } = await make();
    const { asset } = image(dir, 'photo', '1a2b3c4d');
    await ai(s, 'run_before', 'Before');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
    await site(s, { name: 'Middle' }, 'Rename site');
    await add(s, [asset], 'Import image again');
    await ai(s, 'run_after', 'After');
    await ok(s.undo());
    await ok(s.undo());
    const plan = (await s.storageInfo()).reclaim!;
    expect(plan).toMatchObject({ undo: ['AI: Before', 'Import image', 'Remove image'], redo: ['Import image again', 'AI: After'] });
    expect((await s.reclaimStorage(plan.key)).ok).toBe(true);
    expect(labels(s)).toEqual(['Rename site']);
    expect(s.historyInfo().droppedRuns).toEqual({ run_before: 'applied', run_after: 'undone' });
    await s.close();
    const again = await reopen(dir);
    expect(again.historyInfo().droppedRuns).toEqual({ run_before: 'applied', run_after: 'undone' });
    expect(labels(again)).toEqual(['Rename site']);
    await ok(again.undo());
    expect(again.state.site.name).toBe('Before');
  });

  it('keeps every size of an image the project still names in any file, and drops a later step whose undo would name a deleted one', async () => {
    const { dir, s } = await make();
    const styled = image(dir, 'photo', '1a2b3c4d');
    const built = image(dir, 'third', 'eeeeffff');
    const aliased = image(dir, 'hero', '99990000');
    const gone = image(dir, 'other', 'ccccdddd');
    await add(s, [styled.asset, built.asset, aliased.asset, gone.asset], 'Import 4 images');
    await remove(s, [styled.asset, built.asset, aliased.asset, gone.asset], 'Remove 4 images');
    // Build configuration at the project's top level names one by an alias; a style sheet in a public folder named
    // build (only the top-level build output is left out) names another's copy.
    write(dir, 'vite.config.ts', `export default { resolve: { alias: { hero: '/static/assets/${aliased.files[0]}' } } };\n`);
    // A hand-written style sheet uses one small copy by its address; a caption file of a kind no list of text
    // extensions would name builds the other's address from its parts.
    write(dir, 'static/build/extra.css', `.hero { background: url(/assets/${styled.files[1]}); }\n`);
    write(dir, 'src/lib/captions.vtt', `WEBVTT\n\n00:00.000 --> 00:01.000\n<img src="/assets/third-' + 'eeeeffff' + '.png">\n`);
    // A document named a copy of the third image for a while: undoing the second edit would bring that mention back.
    await site(s, { description: `See /assets/${gone.files[2]}` }, 'Describe with image');
    await site(s, { description: 'Plain' }, 'Describe plainly');
    await site(s, { name: 'Unrelated' }, 'Unrelated edit');

    const info = await s.storageInfo();
    expect(info.media.files).toBe(9);
    expect(info.kept.files).toBe(3);
    const plan = info.reclaim!;
    expect(plan.undo).toEqual(['Import 4 images', 'Remove 4 images', 'Describe with image', 'Describe plainly']);
    expect(plan.keptUndo).toBe(1);
    expect((await s.reclaimStorage(plan.key)).ok).toBe(true);
    for (const f of [...styled.files, ...built.files, ...aliased.files]) expect(has(dir, f)).toBe(true);
    for (const f of gone.files) expect(has(dir, f)).toBe(false);
    expect(labels(s)).toEqual(['Unrelated edit']);
    await ok(s.undo());
    expect(s.state.site.description).toBe('Plain');
  });

  it('finds a name in a large file even where it spans two reads', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
    // Just over one read's worth of data, with the image's hash split across the first one-megabyte read.
    const big = Buffer.alloc(1024 * 1024 + 4096, 0x20);
    big.write('1a2b3c4d', 1024 * 1024 - 7, 'latin1');
    write(dir, 'static/data/archive.json', big);
    const info = await s.storageInfo();
    expect(info.media).toEqual({ files: 3, bytes: 3000 });
    expect(info.reclaim).toBeNull();
    for (const f of files) expect(has(dir, f)).toBe(true);
  });

  it('refuses a plan whose steps were replaced since, though the position in history is the same, changing nothing', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
    const plan = (await s.storageInfo()).reclaim!;
    await ok(s.undo());
    await remove(s, [asset], 'Remove image');
    const ids = s.historyInfo().entries.map((e) => e.id);
    const r = await s.reclaimStorage(plan.key);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/changed/);
    for (const f of files) expect(has(dir, f)).toBe(true);
    expect(s.historyInfo().entries.map((e) => e.id)).toEqual(ids);
    expect((await s.reclaimStorage('nonsense')).ok).toBe(false);
    // The plan for the project as it is now goes ahead.
    expect((await s.reclaimStorage((await s.storageInfo()).reclaim!.key)).ok).toBe(true);
  });

  it('keeps a file another app names while the reclaim is under way, though its steps go', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
    write(dir, 'static/late.css', '.a { color: red; }\n');
    const { key } = (await s.storageInfo()).reclaim!;
    // Edited after the plan was checked and the history trimmed, before anything is deleted.
    s.once('history', () => write(dir, 'static/late.css', `.a { background: url(/assets/${files[0]}); }\n`));
    expect((await s.reclaimStorage(key)).ok).toBe(true);
    expect(labels(s)).toEqual([]);
    for (const f of files) expect(has(dir, f)).toBe(true);
    expect((await s.storageInfo()).media.files).toBe(3);
  });

  it('never deletes through a static/assets folder swapped for a link while the reclaim is under way', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
    const { key } = (await s.storageInfo()).reclaim!;
    const elsewhere = mkdtempSync(join(tmpdir(), 'so-elsewhere-'));
    dirs.push(elsewhere);
    s.once('history', () => {
      renameSync(join(dir, ASSETS), join(elsewhere, 'assets'));
      symlinkSync(join(elsewhere, 'assets'), join(dir, ASSETS));
    });
    expect((await s.reclaimStorage(key)).ok).toBe(true);
    for (const f of files) expect(existsSync(join(elsewhere, 'assets', f))).toBe(true);
  });

  it('refuses while an AI run is open or an import is in progress', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
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

  it('holds an import back until a reclaim has deleted every file', async () => {
    const { dir, s } = await make();
    const { asset, files } = image(dir, 'photo', '1a2b3c4d');
    await add(s, [asset], 'Import image');
    await remove(s, [asset], 'Remove image');
    const { key } = (await s.storageInfo()).reclaim!;
    const rm = fsp.rm;
    const order: string[] = [];
    let reached!: () => void;
    const deleting = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(fsp, 'rm').mockImplementation(async (...args: Parameters<typeof fsp.rm>) => {
      const p = String(args[0]);
      if (p.startsWith(join(dir, ASSETS))) {
        order.push(basename(p));
        if (order.length === 1) {
          reached();
          await held;
        }
      }
      return rm(...args);
    });
    const reclaim = s.reclaimStorage(key);
    await deleting;
    const importing = s.withImport(async () => void order.push('import'));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await reclaim).ok).toBe(true);
    await importing;
    // Every file went before the import ran.
    expect(order.slice(0, -1).sort()).toEqual([...files].sort());
    expect(order.at(-1)).toBe('import');
  });

  it('keeps an image a style sheet names, and one still in its grace period, when a sweep finds no record or history for them', async () => {
    const { dir, s } = await make();
    const named = image(dir, 'photo', '1a2b3c4d');
    const unnamed = image(dir, 'other', 'ccccdddd');
    const fresh = image(dir, 'fresh', 'eeeeffff');
    await add(s, [named.asset, unnamed.asset, fresh.asset], 'Import 3 images');
    await remove(s, [named.asset, unnamed.asset, fresh.asset], 'Remove 3 images');
    await site(s, { name: 'Later' }, 'Later edit');
    write(dir, 'static/extra.css', `.a { background: url(/assets/${named.files[2]}); }\n`);
    const old = new Date(Date.now() - 60 * 60_000);
    for (const f of [...named.files, ...unnamed.files]) utimesSync(join(dir, ASSETS, f), old, old);
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(labels(s)).toEqual(['Later edit']);
    for (const f of named.files) expect(has(dir, f)).toBe(true);
    for (const f of unnamed.files) expect(has(dir, f)).toBe(false);
    for (const f of fresh.files) expect(has(dir, f)).toBe(true);
  });
});

describe('the Free up space dialog wording', () => {
  const plan = (undo: string[], redo: string[], keptUndo: number, keptRedo: number) => ({ key: 'k', files: { files: 1, bytes: 1 }, historyBytes: 0, undo, redo, keptUndo, keptRedo });

  it('names the newest lost undo steps first, counts the rest, and says what stays', () => {
    const t = describeTrim(plan(['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6'], [], 2, 0));
    expect(t.undo).toEqual({ lead: 'These 6 steps can no longer be undone:', steps: ['Step 6', 'Step 5', 'Step 4', 'Step 3'], more: 'and 2 earlier steps', after: 'Your 2 latest steps can still be undone.' });
    expect(t.redo).toBeNull();
    expect(describeTrim(plan(['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5'], [], 1, 0)).undo).toMatchObject({ more: 'and 1 earlier step', after: 'Your latest step can still be undone.' });
  });

  it('says when nothing is left to undo, and which redo steps stay, nearest first', () => {
    const t = describeTrim(plan(['Remove 6 unused images'], ['Import image', 'Rename site'], 0, 1));
    expect(t.undo).toMatchObject({ lead: 'This step can no longer be undone:', steps: ['Remove 6 unused images'], more: null, after: 'Nothing will be left to undo.' });
    expect(t.redo).toMatchObject({ lead: 'These 2 steps can no longer be redone:', steps: ['Import image', 'Rename site'], after: '1 step before them can still be redone.' });
    expect(describeTrim(plan([], ['Import image'], 0, 2)).redo).toMatchObject({ lead: 'This step can no longer be redone:', after: '2 steps before it can still be redone.' });
  });

  it('formats sizes the way the panel shows them', () => {
    expect(formatBytes(49_661_260)).toBe('47.4 MB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(0)).toBe('0 bytes');
  });
});
