/**
 * A library image added before its responsive copies are made (#979): it lands waiting for them (copiesPending), and
 * they are folded into the project when they are written, with no step of History of their own. Undo and Redo still
 * find the library as they left it, and a fill interrupted part way is finished when the project opens again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-copies-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Copies', false));
  open.push(s);
  return { dir, s };
}

const ASSETS = 'siteorigin/assets.json';
const HASH = 'ab'.repeat(32);

/** A photo as an import adds it while its copies are still to be made. */
const waiting = (id = 'a_photo', name = 'Harbour'): AssetRecord => ({
  id,
  name,
  file: `static/assets/${id.replace('_', '-')}-abababab.jpg`,
  mime: 'image/jpeg',
  bytes: 1000,
  width: 2560,
  height: 1920,
  hash: HASH,
  kind: 'image',
  createdAt: '2026-11-27T10:00:00.000Z',
  copiesPending: true
});

/** The copies the import made of `rec`, as it names them. */
const copiesOf = (rec: AssetRecord) => [160, 480].map((width) => ({ width, file: rec.file.replace(/\.jpg$/, `-${width}w.webp`) }));
const fillOf = (rec: AssetRecord) => ({ assetId: rec.id, file: rec.file, hash: rec.hash, variants: copiesOf(rec) });

describe('copies made after an image lands (#979)', () => {
  it('gives a waiting image its copies with no step of its own: Undo takes the import back, Redo brings it back with them', async () => {
    const { s } = await make();
    const rec = waiting();
    expect((await s.apply({ operations: [{ type: 'asset.add', asset: rec }] }, { label: 'Import image' })).ok).toBe(true);
    const steps = s.historyInfo().entries.length;
    expect(await s.fillCopies([fillOf(rec)])).toEqual({ ok: true, filled: [rec.id] });
    const filled = s.state.assets.assets[rec.id];
    expect(filled.variants).toEqual(copiesOf(rec));
    expect(filled.copiesPending).toBeUndefined();
    // The import is still the last step, and it is the import Undo takes back.
    expect(s.historyInfo().entries).toHaveLength(steps);
    expect(s.historyInfo().entries.at(-1)?.label).toBe('Import image');
    expect((await s.undo()).ok).toBe(true);
    expect(rec.id in s.state.assets.assets).toBe(false);
    expect((await s.redo()).ok).toBe(true);
    expect(s.state.assets.assets[rec.id]).toEqual(filled);
  });

  it('keeps what changed about the image meanwhile, and Undo of that change goes back to it waiting', async () => {
    const { s } = await make();
    const rec = waiting();
    await s.apply({ operations: [{ type: 'asset.add', asset: rec }] }, { label: 'Import image' });
    await s.apply({ operations: [{ type: 'site.update', name: 'Elsewhere' }] }, { label: 'Rename site' });
    expect((await s.apply({ operations: [{ type: 'asset.update', assetId: rec.id, name: 'Harbour at dusk' }] }, { label: 'Rename image' })).ok).toBe(true);
    expect((await s.fillCopies([fillOf(rec)])).filled).toEqual([rec.id]);
    expect(s.state.assets.assets[rec.id]).toMatchObject({ name: 'Harbour at dusk', variants: copiesOf(rec) });
    // Undo of the rename restores the image as it was then, still waiting (the app makes its copies again).
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.assets.assets[rec.id]).toMatchObject({ name: 'Harbour', copiesPending: true });
    // Every step before it is still undone as it was, two at a time too, and redone again.
    const travel = await s.stepTo(s.historyInfo().entries.at(-3)!.id, 'undo');
    expect(travel.ok).toBe(true);
    expect(rec.id in s.state.assets.assets).toBe(false);
    expect(s.state.site.name).toBe('Copies');
    expect((await s.stepTo(s.historyInfo().entries.at(-1)!.id, 'redo')).ok).toBe(true);
    expect(s.state.assets.assets[rec.id]).toMatchObject({ name: 'Harbour at dusk', variants: copiesOf(rec) });
    expect(s.state.assets.assets[rec.id].copiesPending).toBeUndefined();
  });

  it('fills an image undone and redone while its copies were made, and nothing for one gone, given another file or already filled', async () => {
    const { s } = await make();
    const rec = waiting();
    const other = waiting('a_other', 'Pier');
    await s.apply({ operations: [{ type: 'asset.add', asset: rec }, { type: 'asset.add', asset: other }] }, { label: 'Import 2 images' });
    // Undone while its copies were being made: there is nothing to fill.
    await s.undo();
    expect(await s.fillCopies([fillOf(rec)])).toEqual({ ok: true, filled: [] });
    await s.redo();
    // Copies of other content, or named as no copy of its file is, are not this image's.
    expect((await s.fillCopies([{ ...fillOf(rec), hash: 'cd'.repeat(32) }])).filled).toEqual([]);
    expect((await s.fillCopies([{ ...fillOf(rec), variants: [{ width: 160, file: other.file.replace(/\.jpg$/, '-160w.webp') }] }])).filled).toEqual([]);
    expect((await s.fillCopies([{ ...fillOf(rec), variants: [{ width: 160, file: 'static/assets/elsewhere.webp' }] }])).filled).toEqual([]);
    expect(s.state.assets.assets[rec.id].copiesPending).toBe(true);
    // Both in one change; then again, nothing.
    const revision = s.revision;
    expect((await s.fillCopies([fillOf(rec), { ...fillOf(other), variants: [] }])).filled).toEqual([rec.id, other.id]);
    expect(s.revision).toBe(revision + 1);
    // A picture the worker made no copies of stops waiting, with none.
    expect(s.state.assets.assets[other.id].variants).toBeUndefined();
    expect(s.state.assets.assets[other.id].copiesPending).toBeUndefined();
    expect((await s.fillCopies([fillOf(rec)])).filled).toEqual([]);
    expect(s.revision).toBe(revision + 1);
  });

  it('waits while an AI request is changing the project', async () => {
    const { s } = await make();
    const rec = waiting();
    await s.apply({ operations: [{ type: 'asset.add', asset: rec }] }, { label: 'Import image' });
    expect(await s.beginRun('run_x')).toBeNull();
    expect(await s.fillCopies([fillOf(rec)])).toEqual({ ok: false, filled: [], busy: true });
    await s.abortRun();
    expect((await s.fillCopies([fillOf(rec)])).filled).toEqual([rec.id]);
  });

  it('refuses a waiting record that is no picture, or already has copies, and stops waiting for the copies of a file the image no longer has', () => {
    const state = createStarterState('business', 'Copies', false);
    const rec = waiting();
    // A new file for the image (Locate) leaves the copies still to be made of the old one behind.
    const added = applyOperations(state, [{ type: 'asset.add', asset: rec }]).state;
    const relinked = applyOperations(added, [{ type: 'asset.relink', assetId: rec.id, file: rec.file.replace('abababab', 'cdcdcdcd'), mime: 'image/jpeg', bytes: 10, hash: 'cd'.repeat(32) }]).state;
    expect(relinked.assets.assets[rec.id].copiesPending).toBeUndefined();
    expect(() => applyOperations(state, [{ type: 'asset.add', asset: { ...rec, variants: copiesOf(rec) } }])).toThrow(/has no copies to wait for/);
    expect(() => applyOperations(state, [{ type: 'asset.add', asset: { ...rec, kind: 'document', mime: 'application/pdf', file: 'static/assets/guide-abababab.pdf' } }])).toThrow(/has no copies to wait for/);
  });

  it('finishes a fill stopped after its journal was down when the project opens again, History and all', async () => {
    const { dir, s } = await make();
    const rec = waiting();
    await s.apply({ operations: [{ type: 'asset.add', asset: rec }] }, { label: 'Import image' });
    const imported = readFileSync(join(dir, ASSETS), 'utf8');
    // The app stops as the fill replaces the library's document: its journal is on disk, nothing else of it is.
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).split('\\').join('/').endsWith(ASSETS)) throw new Error('the app stopped');
      return rename(from, to);
    });
    await expect(s.fillCopies([fillOf(rec)])).rejects.toThrow('the app stopped');
    vi.restoreAllMocks();
    expect(readFileSync(join(dir, ASSETS), 'utf8')).toBe(imported);
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    open.push(again);
    expect(again.state.assets.assets[rec.id]).toMatchObject({ variants: copiesOf(rec) });
    expect(again.state.assets.assets[rec.id].copiesPending).toBeUndefined();
    // History was finished with it: the import is undone and redone, copies and all.
    expect(again.historyInfo().entries.at(-1)?.label).toBe('Import image');
    expect((await again.undo()).ok).toBe(true);
    expect(rec.id in again.state.assets.assets).toBe(false);
    expect((await again.redo()).ok).toBe(true);
    expect(again.state.assets.assets[rec.id].variants).toEqual(copiesOf(rec));
  });

  it('keeps the copies and the step they belong to after the project is closed and opened again', async () => {
    const { dir, s } = await make();
    const rec = waiting();
    await s.apply({ operations: [{ type: 'asset.add', asset: rec }] }, { label: 'Import image' });
    await s.fillCopies([fillOf(rec)]);
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    open.push(again);
    expect(again.state.assets.assets[rec.id].variants).toEqual(copiesOf(rec));
    expect((await again.undo()).ok).toBe(true);
    expect(rec.id in again.state.assets.assets).toBe(false);
  });
});
