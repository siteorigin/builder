/**
 * The library files only drafts use, held out of an exported editable project's static/ and put back when it is opened
 * (#1450): what is moved, and what never is.
 */
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_ASSETS_DIR, holdDraftAssets, keptDraftAssetsNote, restoreDraftAssets } from '../../src/main/project/draft-assets';

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-draft-assets-')));
  dirs.push(d);
  return d;
};
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('files kept aside for drafts', () => {
  it('holds files at the same paths below siteorigin/draft-assets/, and puts them back, leaving no folder behind', async () => {
    const dir = temp();
    write(dir, 'static/assets/sketch-12345678.jpg', 'sketch');
    write(dir, 'static/assets/fonts/brand-aaaaaaaa.woff2', 'font');
    write(dir, 'static/assets/public-bbbbbbbb.svg', 'public');
    // Left from before: the copy holds what its drafts use now.
    write(dir, `${DRAFT_ASSETS_DIR}/stale-cccccccc.pdf`, 'stale');
    await holdDraftAssets(dir, ['static/assets/sketch-12345678.jpg', 'static/assets/fonts/brand-aaaaaaaa.woff2']);
    expect(existsSync(join(dir, 'static/assets/sketch-12345678.jpg'))).toBe(false);
    expect(existsSync(join(dir, 'static/assets/fonts/brand-aaaaaaaa.woff2'))).toBe(false);
    expect(read(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`)).toBe('sketch');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/fonts/brand-aaaaaaaa.woff2`)).toBe('font');
    expect(existsSync(join(dir, `${DRAFT_ASSETS_DIR}/stale-cccccccc.pdf`))).toBe(false);
    expect(read(dir, 'static/assets/public-bbbbbbbb.svg')).toBe('public');

    // Extracted somewhere static/assets/ is gone altogether, it is made again.
    rmSync(join(dir, 'static'), { recursive: true });
    expect(await restoreDraftAssets(dir)).toEqual([]);
    expect(read(dir, 'static/assets/sketch-12345678.jpg')).toBe('sketch');
    expect(read(dir, 'static/assets/fonts/brand-aaaaaaaa.woff2')).toBe('font');
    expect(existsSync(join(dir, DRAFT_ASSETS_DIR))).toBe(false);
    expect(existsSync(join(dir, 'siteorigin'))).toBe(true);
    // Nothing held, nothing done.
    expect(await restoreDraftAssets(dir)).toEqual([]);
  });

  it('never puts a held file over one already there: the same bytes finish the move, other bytes stay as they are', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/same-12345678.jpg`, 'same');
    write(dir, 'static/assets/same-12345678.jpg', 'same');
    write(dir, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`, 'held');
    write(dir, 'static/assets/other-12345678.pdf', 'mine');
    write(dir, `${DRAFT_ASSETS_DIR}/new-12345678.svg`, 'new');
    expect(await restoreDraftAssets(dir)).toEqual(['static/assets/other-12345678.pdf']);
    expect(read(dir, 'static/assets/same-12345678.jpg')).toBe('same');
    expect(existsSync(join(dir, `${DRAFT_ASSETS_DIR}/same-12345678.jpg`))).toBe(false);
    expect(read(dir, 'static/assets/other-12345678.pdf')).toBe('mine');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`)).toBe('held');
    expect(read(dir, 'static/assets/new-12345678.svg')).toBe('new');
    expect(keptDraftAssetsNote(['static/assets/other-12345678.pdf'])).toBe(
      'static/assets/other-12345678.pdf was kept aside for a draft when the project was exported, and could not be put back: another file is in its place, or it could not be moved. It is still at siteorigin/draft-assets/other-12345678.pdf; move it to static/assets/other-12345678.pdf to use it.'
    );
    expect(keptDraftAssetsNote(['static/assets/a-12345678.pdf', 'static/assets/b-12345678.pdf'])).toBe(
      '2 files kept aside for drafts when the project was exported could not be put back: another file is in each one’s place, or it could not be moved. They are still in siteorigin/draft-assets/; move each to the same place in static/assets/ to use it: static/assets/a-12345678.pdf, static/assets/b-12345678.pdf.'
    );
    expect(keptDraftAssetsNote([])).toBeNull();
  });

  it('copies where the disk has no hard links, still never over a file there', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`, 'sketch');
    write(dir, `${DRAFT_ASSETS_DIR}/taken-12345678.jpg`, 'held');
    write(dir, 'static/assets/taken-12345678.jpg', 'mine');
    vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('not supported'), { code: 'EPERM' }));
    expect(await restoreDraftAssets(dir)).toEqual(['static/assets/taken-12345678.jpg']);
    expect(read(dir, 'static/assets/sketch-12345678.jpg')).toBe('sketch');
    expect(existsSync(join(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`))).toBe(false);
    expect(read(dir, 'static/assets/taken-12345678.jpg')).toBe('mine');
  });

  it.skipIf(process.platform === 'win32')('moves no link, nothing through one, and nothing from a held folder that is a link', async () => {
    const dir = temp();
    const elsewhere = temp();
    write(elsewhere, 'secret.txt', 'secret');
    write(elsewhere, 'inside/file-12345678.jpg', 'x');
    mkdirSync(join(dir, DRAFT_ASSETS_DIR), { recursive: true });
    symlinkSync(join(elsewhere, 'secret.txt'), join(dir, `${DRAFT_ASSETS_DIR}/secret-12345678.txt`));
    symlinkSync(join(elsewhere, 'inside'), join(dir, `${DRAFT_ASSETS_DIR}/linked`));
    expect(await restoreDraftAssets(dir)).toEqual([]);
    expect(existsSync(join(dir, 'static/assets/secret-12345678.txt'))).toBe(false);
    expect(existsSync(join(dir, 'static/assets/linked'))).toBe(false);
    expect(read(elsewhere, 'secret.txt')).toBe('secret');

    const other = temp();
    mkdirSync(join(other, 'siteorigin'), { recursive: true });
    symlinkSync(join(elsewhere, 'inside'), join(other, DRAFT_ASSETS_DIR));
    expect(await restoreDraftAssets(other)).toEqual([]);
    expect(existsSync(join(other, 'static'))).toBe(false);
    expect(read(elsewhere, 'inside/file-12345678.jpg')).toBe('x');
  });
});
