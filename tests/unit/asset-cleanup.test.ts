import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { applyOperation, applyOperations, assetUsages } from '@engine/apply';
import * as tree from '@engine/tree';
import { EngineError } from '@engine/tree';
import * as fonts from '@shared/fonts';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ProjectState } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';

// Every count of the site's asset uses reads its typography once (`scans`) and walks its pages' trees once
// (`walks`, which other checks also make): counting those reads counts the scans.
vi.mock('@shared/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/fonts')>();
  return { ...actual, fontAssetUsages: vi.fn(actual.fontAssetUsages) };
});
vi.mock('@engine/tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/tree')>();
  return { ...actual, allTrees: vi.fn(actual.allTrees) };
});
const scans = vi.mocked(fonts.fontAssetUsages);
const walks = vi.mocked(tree.allTrees);

const image = (id: string): AssetRecord => ({
  id,
  name: `Photo ${id}`,
  file: `static/assets/${id}-1a2b3c4d.png`,
  mime: 'image/png',
  bytes: 10,
  hash: `hash-${id}`,
  kind: 'image',
  createdAt: '2026-01-01T00:00:00.000Z'
});
const face = (id: string, family: string): AssetRecord => ({
  id,
  name: `${family} ${id}`,
  file: `static/assets/${id}-1a2b3c4d.woff2`,
  mime: 'font/woff2',
  bytes: 1000,
  hash: `hash-${id}`,
  kind: 'font',
  createdAt: '2026-01-01T00:00:00.000Z',
  font: { family, weight: '400', style: 'normal' }
});
const remove = (assetId: string): EditOperation => ({ type: 'asset.remove', assetId });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `img${String(i).padStart(2, '0')}`);

/** An image node inside a new section at the top of a page. */
function placeImage(s: ProjectState, pageId: string, assetId: string) {
  const owner = { kind: 'page' as const, id: pageId };
  const sec = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  const section = sec.results[0].nodeId as string;
  const img = applyOperations(sec.state, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' }]);
  const nodeId = img.results[0].nodeId as string;
  return { s: applyOperations(img.state, [{ type: 'node.setContent', owner, nodeId, field: 'image', value: { assetId, alt: 'A room' } }]).state, section, nodeId };
}

/**
 * A multi-page site with 40 images: img00 on the home page, img01 on the About page, img02 as the favicon and
 * img03 as the Contact page's social image. The other 36 are unused.
 */
function site() {
  let s = createStarterState('business', 'Portfolio', false);
  s = applyOperations(s, ids(40).map((id) => ({ type: 'asset.add' as const, asset: image(id) }))).state;
  const [homeId, aboutId, contactId] = s.site.pageOrder;
  const home = placeImage(s, homeId, 'img00');
  const about = placeImage(home.s, aboutId, 'img01');
  s = applyOperations(about.s, [
    { type: 'site.update', favicon: 'img02' },
    { type: 'page.update', pageId: contactId, socialImage: 'img03' }
  ]).state;
  return { s, homeId, aboutId, contactId, homeImage: home.nodeId, aboutSection: about.section };
}
const USED = ['img00', 'img01', 'img02', 'img03'];
const UNUSED = ids(40).filter((id) => !USED.includes(id));

function rejects(fn: () => unknown, msg: RegExp) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EngineError);
  expect((err as Error).message).toMatch(msg);
}

const clearCounts = () => {
  scans.mockClear();
  walks.mockClear();
};
beforeEach(clearCounts);

describe('removing many assets in one batch', () => {
  it('removes every unused image of a multi-page site, counting the site’s uses once', () => {
    const { s } = site();
    expect(s.site.pageOrder.length).toBeGreaterThan(2);
    expect(Object.keys(assetUsages(s)).sort()).toEqual(USED);
    clearCounts();
    const r = applyOperations(s, UNUSED.map(remove));
    expect(Object.keys(r.state.assets.assets).sort()).toEqual(USED);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(walks).toHaveBeenCalledTimes(1);
  });

  it('keeps counts only for the project they were made from', () => {
    // A caller that hands the same context to edits of two projects gets each one's own counts.
    const { s } = site();
    const ctx = { assetUses: {} };
    applyOperation(structuredClone(s), remove('img10'), ctx);
    const other = applyOperations(s, [{ type: 'site.update', favicon: 'img11' }]).state;
    rejects(() => applyOperation(other, remove('img11'), ctx), /^This image is used 1 time\. /);
  });

  it('refuses the whole cleanup when it includes an image in use anywhere on the site', () => {
    const { s } = site();
    for (const used of USED) {
      rejects(() => applyOperations(s, [...UNUSED.map(remove), remove(used)]), /^Operation 37 \(asset\.remove\): This image is used 1 time\. /);
      rejects(() => applyOperations(s, [remove(used), ...UNUSED.map(remove)]), /^Operation 1 \(asset\.remove\): This image is used 1 time\. /);
    }
    expect(Object.keys(s.assets.assets)).toHaveLength(40);
  });

  it('counts the uses again after an edit in the same batch moves them', () => {
    const { s, aboutId, homeImage, aboutSection } = site();
    const homeImageAsset = (st: ProjectState) => (st.pages[st.site.homePageId].nodes[homeImage] as { image?: { assetId?: string } }).image?.assetId;

    // An unused image that a replacement puts on the page stays protected for the rest of the batch.
    rejects(() => applyOperations(s, [remove('img10'), { type: 'asset.replace', assetId: 'img00', withAssetId: 'img11' }, remove('img11')]), /^Operation 3 \(asset\.remove\): This image is used 1 time\. /);

    // The image it replaced can go.
    scans.mockClear();
    const replaced = applyOperations(s, [remove('img10'), { type: 'asset.replace', assetId: 'img00', withAssetId: 'img11' }, remove('img00'), remove('img12')]).state;
    expect(replaced.assets.assets.img00).toBeUndefined();
    expect(replaced.assets.assets.img11).toBeDefined();
    expect(homeImageAsset(replaced)).toBe('img11');
    expect(scans).toHaveBeenCalledTimes(2);

    // Removing the section that shows it, clearing the favicon or the social image frees an image too.
    const freed = applyOperations(s, [
      remove('img10'),
      { type: 'node.remove', owner: { kind: 'page', id: aboutId }, nodeId: aboutSection },
      remove('img01'),
      { type: 'site.update', favicon: null },
      remove('img02'),
      { type: 'page.update', pageId: s.site.pageOrder[2], socialImage: null },
      remove('img03')
    ]).state;
    expect(Object.keys(freed.assets.assets).filter((id) => USED.includes(id))).toEqual(['img00']);

    // A favicon or site social image set in the batch protects the image it names.
    rejects(() => applyOperations(s, [remove('img10'), { type: 'site.update', favicon: 'img11' }, remove('img11')]), /^Operation 3 \(asset\.remove\): This image is used 1 time\. /);
    rejects(() => applyOperations(s, [remove('img10'), { type: 'site.update', socialImage: 'img11' }, remove('img11')]), /^Operation 3 \(asset\.remove\): This image is used 1 time\. /);

    // A duplicated page shows the image a second time.
    rejects(() => applyOperations(s, [remove('img10'), { type: 'page.duplicate', pageId: aboutId }, remove('img01')]), /^Operation 3 \(asset\.remove\): This image is used 2 times\. /);
  });

  it('keeps a font family protected until its last face goes, whatever case the faces name it in', () => {
    const base = site().s;
    const s = applyOperations(base, [
      { type: 'asset.add', asset: face('f1', 'Brand Sans') },
      { type: 'asset.add', asset: face('f2', 'brand sans') },
      { type: 'asset.add', asset: face('f3', 'Other') },
      { type: 'token.set', tokenId: 'font.display', value: fonts.importedFontStack('Brand Sans') }
    ]).state;
    // One face can go while the other still provides the family; the last one cannot.
    expect(applyOperations(s, [remove('img10'), remove('f1'), remove('f3')]).state.assets.assets.f2).toBeDefined();
    rejects(() => applyOperations(s, [remove('img10'), remove('f1'), remove('f2')]), /^Operation 3 \(asset\.remove\): This font is used 1 time\. /);
    // Once the style stops naming the family, both faces can go.
    const done = applyOperations(s, [remove('f1'), { type: 'token.set', tokenId: 'font.display', value: 'system-ui, sans-serif' }, remove('f2'), remove('img10')]).state;
    expect(done.assets.assets.f1 ?? done.assets.assets.f2).toBeUndefined();
  });

  it('counts a font a code component names, even when a removal already counted before the component was added', () => {
    const s = applyOperations(site().s, [{ type: 'asset.add', asset: face('f1', 'Brand Sans') }]).state;
    const code: EditOperation = { type: 'component.createCode', name: 'Banner', source: "<h2>Hi</h2>\n<style>h2 { font-family: 'Brand Sans', serif; }</style>", properties: {} };
    // The first removal counts every use; the component added after it must still be seen by the one that follows.
    rejects(() => applyOperations(s, [remove('img10'), code, remove('f1')]), /^Operation 3 \(asset\.remove\): This font is used 1 time\. /);
    rejects(() => applyOperations(applyOperations(s, [code]).state, [remove('img10'), remove('f1')]), /^Operation 2 \(asset\.remove\): This font is used 1 time\. /);
    // Without the component, the font can go.
    expect(applyOperations(s, [remove('img10'), remove('f1')]).state.assets.assets.f1).toBeUndefined();
  });

  it('never counts a broken font file as another face of the family', () => {
    const s = applyOperations(site().s, [
      { type: 'asset.add', asset: face('f1', 'Brand Sans') },
      { type: 'token.set', tokenId: 'font.display', value: fonts.importedFontStack('Brand Sans') }
    ]).state;
    s.assets.assets.broken = { ...face('broken', 'Brand Sans'), file: 'static/assets/broken.exe' };
    rejects(() => applyOperations(s, [remove('img10'), remove('f1')]), /^Operation 2 \(asset\.remove\): This font is used 1 time\. /);
    rejects(() => applyOperations(s, [remove('img10'), remove('broken'), remove('f1')]), /^Operation 3 \(asset\.remove\): This font is used 1 time\. /);
  });

  it('counts again after a font goes, whose record may be filed under another name', () => {
    // A hand-edited asset list can file a font's record under a key that differs from its ID; its uses are
    // counted under the ID, which here is also an unused image's.
    const base = site().s;
    base.assets.assets.target = image('target');
    base.assets.assets.miskeyed = face('target', 'Brand Sans');
    const s = applyOperations(base, [{ type: 'token.set', tokenId: 'font.display', value: fonts.importedFontStack('Brand Sans') }]).state;
    expect(assetUsages(s).target).toBe(1);
    scans.mockClear();
    const r = applyOperations(s, [remove('img10'), remove('miskeyed'), remove('target'), remove('img11')]).state;
    expect(r.assets.assets.target ?? r.assets.assets.miskeyed).toBeUndefined();
    expect(scans).toHaveBeenCalledTimes(2);
  });
});

describe('a bulk cleanup in the editor', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('is one Undo step that brings every image back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-cleanup-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, site().s);
    const original = structuredClone(session.state.assets);
    const steps = session.historyInfo().entries.length;
    clearCounts();
    const r = await session.apply({ operations: UNUSED.map(remove) }, { label: `Remove ${UNUSED.length} unused images` });
    expect(r.ok).toBe(true);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(Object.keys(session.state.assets.assets).sort()).toEqual(USED);
    expect(session.historyInfo().entries).toHaveLength(steps + 1);
    expect(session.historyInfo().undoLabel).toBe('Remove 36 unused images');

    expect((await session.undo()).ok).toBe(true);
    expect(session.state.assets).toEqual(original);

    // A cleanup that reaches a used image changes nothing at all.
    const before = { revision: session.revision, history: session.historyInfo(), assets: structuredClone(session.state.assets) };
    const refused = await session.apply({ operations: [remove('img10'), remove('img01')] }, { label: 'Remove 2 unused images' });
    expect(refused).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^Operation 2 \(asset\.remove\): This image is used 1 time/) } });
    expect({ revision: session.revision, history: session.historyInfo(), assets: session.state.assets }).toEqual(before);
  });
});
