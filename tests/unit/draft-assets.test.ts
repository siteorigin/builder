/**
 * The library files only drafts use, held out of an exported editable project's static/ and put back when it is opened
 * (#1450): what is moved, and what never is.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord } from '@shared/types';
import { DRAFT_ASSETS_DIR, heldDraftAssetFiles, heldDraftAssetsStop, holdDraftAssets, keptDraftAssetsNote, restoreDraftAssets } from '../../src/main/project/draft-assets';

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
const there = (root: string, rel: string) => existsSync(join(root, rel));
/** A library whose records own `files`. */
const library = (...files: string[]): Record<string, AssetRecord> =>
  Object.fromEntries(files.map((file, i) => [`a${i}`, { id: `a${i}`, name: `a${i}`, file, mime: 'image/jpeg', bytes: 1, hash: 'x', kind: 'image', createdAt: '' } as AssetRecord]));
/** Whether the disk under the temporary folder ignores case in names. */
const ignoresCase = () => {
  const d = temp();
  writeFileSync(join(d, 'probe'), '');
  return existsSync(join(d, 'PROBE'));
};
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => {
    if (process.platform !== 'win32') for (const sub of ['', 'static', 'static/assets', 'siteorigin']) if (existsSync(join(d, sub))) chmodSync(join(d, sub), 0o755);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('files kept aside for drafts', () => {
  it('holds files at the same paths below siteorigin/draft-assets/, and puts them back, leaving no folder behind', async () => {
    const dir = temp();
    write(dir, 'static/assets/sketch-12345678.jpg', 'sketch');
    write(dir, 'static/assets/fonts/brand.woff2', 'font');
    write(dir, 'static/assets/public-bbbbbbbb.svg', 'public');
    write(dir, 'static/robots.txt', 'robots');
    // Left from before: the copy holds what its drafts use now.
    write(dir, `${DRAFT_ASSETS_DIR}/stale-cccccccc.pdf`, 'stale');
    // Only files in static/assets/ are ever held.
    await holdDraftAssets(dir, ['static/assets/sketch-12345678.jpg', 'static/assets/fonts/brand.woff2', 'static/robots.txt']);
    expect(there(dir, 'static/assets/sketch-12345678.jpg')).toBe(false);
    expect(there(dir, 'static/assets/fonts/brand.woff2')).toBe(false);
    expect(read(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`)).toBe('sketch');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/fonts/brand.woff2`)).toBe('font');
    expect(there(dir, `${DRAFT_ASSETS_DIR}/stale-cccccccc.pdf`)).toBe(false);
    expect(read(dir, 'static/robots.txt')).toBe('robots');
    expect(read(dir, 'static/assets/public-bbbbbbbb.svg')).toBe('public');
    expect((await heldDraftAssetFiles(dir)).sort()).toEqual([`${DRAFT_ASSETS_DIR}/fonts/brand.woff2`, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`]);

    // Extracted somewhere static/assets/ is gone altogether, it is made again. The font is a library file in a folder
    // of its own; the picture is named as the importer names one.
    rmSync(join(dir, 'static'), { recursive: true });
    expect(await restoreDraftAssets(dir, library('static/assets/fonts/brand.woff2'))).toEqual([]);
    expect(read(dir, 'static/assets/sketch-12345678.jpg')).toBe('sketch');
    expect(read(dir, 'static/assets/fonts/brand.woff2')).toBe('font');
    expect(there(dir, DRAFT_ASSETS_DIR)).toBe(false);
    expect(there(dir, 'siteorigin')).toBe(true);
    // Nothing held, nothing done.
    expect(await restoreDraftAssets(dir, {})).toEqual([]);
    expect(await heldDraftAssetFiles(dir)).toEqual([]);
  });

  it('puts back only files an export could have held, never over one already there', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/same-12345678.jpg`, 'same');
    write(dir, 'static/assets/same-12345678.jpg', 'same');
    write(dir, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`, 'held');
    write(dir, 'static/assets/other-12345678.pdf', 'mine');
    write(dir, `${DRAFT_ASSETS_DIR}/folder-12345678.svg`, 'held');
    mkdirSync(join(dir, 'static/assets/folder-12345678.svg'), { recursive: true });
    write(dir, `${DRAFT_ASSETS_DIR}/new-12345678.svg`, 'new');
    // Notes of the author's own, and a file in a folder no record names: never published by being opened.
    write(dir, `${DRAFT_ASSETS_DIR}/reviewer-notes.txt`, 'notes');
    write(dir, `${DRAFT_ASSETS_DIR}/extra/thing-12345678.svg`, 'thing');
    expect((await restoreDraftAssets(dir, {})).sort()).toEqual(
      [`${DRAFT_ASSETS_DIR}/extra/thing-12345678.svg`, `${DRAFT_ASSETS_DIR}/folder-12345678.svg`, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`, `${DRAFT_ASSETS_DIR}/reviewer-notes.txt`].sort()
    );
    expect(read(dir, 'static/assets/same-12345678.jpg')).toBe('same');
    expect(there(dir, `${DRAFT_ASSETS_DIR}/same-12345678.jpg`)).toBe(false);
    expect(read(dir, 'static/assets/other-12345678.pdf')).toBe('mine');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`)).toBe('held');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/folder-12345678.svg`)).toBe('held');
    expect(read(dir, 'static/assets/new-12345678.svg')).toBe('new');
    expect(there(dir, 'static/assets/reviewer-notes.txt')).toBe(false);
    expect(there(dir, 'static/assets/extra')).toBe(false);
    expect(keptDraftAssetsNote([`${DRAFT_ASSETS_DIR}/other-12345678.pdf`])).toBe(
      'siteorigin/draft-assets/other-12345678.pdf was left where it is, in the folder where an exported project keeps the files only its drafts use: it is no file of the project’s assets, another file is in its place in static/assets/, or it could not be moved. Move it into static/assets/ to use it, or delete it.'
    );
    expect(keptDraftAssetsNote([`${DRAFT_ASSETS_DIR}/a-12345678.pdf`, `${DRAFT_ASSETS_DIR}/b-12345678.pdf`])).toBe(
      '2 files were left where they are in siteorigin/draft-assets/, where an exported project keeps the files only its drafts use: each is no file of the project’s assets, has another file in its place in static/assets/, or could not be moved. Move them into static/assets/ to use them, or delete them: siteorigin/draft-assets/a-12345678.pdf, siteorigin/draft-assets/b-12345678.pdf.'
    );
    expect(keptDraftAssetsNote([])).toBeNull();
    expect(heldDraftAssetsStop([`${DRAFT_ASSETS_DIR}/other-12345678.pdf`])).toBe('siteorigin/draft-assets/other-12345678.pdf is still kept aside from an earlier export of this project. Move it into static/assets/ or delete it, then export again.');
  });

  it('copies where the disk has no hard links, never over a file there, and never leaves a copy cut short in its place', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`, 'sketch');
    write(dir, `${DRAFT_ASSETS_DIR}/taken-12345678.jpg`, 'held');
    write(dir, 'static/assets/taken-12345678.jpg', 'mine');
    // Windows reports a disk without hard links this way too.
    vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('no links'), { code: 'EISDIR' }));
    expect(await restoreDraftAssets(dir, {})).toEqual([`${DRAFT_ASSETS_DIR}/taken-12345678.jpg`]);
    expect(read(dir, 'static/assets/sketch-12345678.jpg')).toBe('sketch');
    expect(there(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`)).toBe(false);
    expect(read(dir, 'static/assets/taken-12345678.jpg')).toBe('mine');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/taken-12345678.jpg`)).toBe('held');

    // A copy that fails partway leaves nothing at the public path; what it left beside the held file goes next time.
    write(dir, `${DRAFT_ASSETS_DIR}/cut-12345678.jpg`, 'whole picture');
    const copy = fsPromises.copyFile;
    const cut = vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (from, to) => {
      writeFileSync(to as string, 'wh');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    expect(await restoreDraftAssets(dir, {})).toContain(`${DRAFT_ASSETS_DIR}/cut-12345678.jpg`);
    expect(there(dir, 'static/assets/cut-12345678.jpg')).toBe(false);
    cut.mockImplementation(copy);
    await restoreDraftAssets(dir, {});
    expect(read(dir, 'static/assets/cut-12345678.jpg')).toBe('whole picture');
    expect((await heldDraftAssetFiles(dir)).filter((f) => f.includes('restoring'))).toEqual([]);
  });

  it('leaves a held file where it is when the disk refuses the move for any other reason', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`, 'sketch');
    vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const copy = vi.spyOn(fsPromises, 'copyFile');
    expect(await restoreDraftAssets(dir, {})).toEqual([`${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`]);
    expect(copy).not.toHaveBeenCalled();
    expect(read(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`)).toBe('sketch');
    expect(there(dir, 'static/assets/sketch-12345678.jpg')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('moves, compares and removes nothing through a link', async () => {
    const dir = temp();
    const elsewhere = temp();
    write(elsewhere, 'secret.txt', 'secret');
    write(elsewhere, 'inside/file-12345678.jpg', 'x');
    mkdirSync(join(dir, DRAFT_ASSETS_DIR), { recursive: true });
    symlinkSync(join(elsewhere, 'secret.txt'), join(dir, `${DRAFT_ASSETS_DIR}/secret-12345678.txt`));
    symlinkSync(join(elsewhere, 'inside'), join(dir, `${DRAFT_ASSETS_DIR}/linked`));
    expect(await restoreDraftAssets(dir, {})).toEqual([]);
    expect(there(dir, 'static/assets/secret-12345678.txt')).toBe(false);
    expect(there(dir, 'static/assets/linked')).toBe(false);
    expect(read(elsewhere, 'secret.txt')).toBe('secret');

    // A held folder that is a link is no held folder.
    const other = temp();
    mkdirSync(join(other, 'siteorigin'), { recursive: true });
    symlinkSync(join(elsewhere, 'inside'), join(other, DRAFT_ASSETS_DIR));
    expect(await restoreDraftAssets(other, {})).toEqual([]);
    expect(await heldDraftAssetFiles(other)).toEqual([]);
    expect(there(other, 'static')).toBe(false);
    expect(read(elsewhere, 'inside/file-12345678.jpg')).toBe('x');

    // static/assets/ leading back into the held folder: the file there is the held file itself, never removed as a copy.
    const looped = temp();
    write(looped, `${DRAFT_ASSETS_DIR}/only-12345678.pdf`, 'the only copy');
    mkdirSync(join(looped, 'static'), { recursive: true });
    symlinkSync(join(looped, DRAFT_ASSETS_DIR), join(looped, 'static/assets'));
    expect(await restoreDraftAssets(looped, {})).toEqual([`${DRAFT_ASSETS_DIR}/only-12345678.pdf`]);
    expect(read(looped, `${DRAFT_ASSETS_DIR}/only-12345678.pdf`)).toBe('the only copy');
  });

  it.runIf(ignoresCase())('keeps a held file whose name a file there matches only without case', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/photo-12345678.jpg`, 'same');
    write(dir, 'static/assets/Photo-12345678.jpg', 'same');
    expect(await restoreDraftAssets(dir, {})).toEqual([`${DRAFT_ASSETS_DIR}/photo-12345678.jpg`]);
    expect(read(dir, `${DRAFT_ASSETS_DIR}/photo-12345678.jpg`)).toBe('same');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('holds files from a static/assets/ its owner may not write in, and leaves its mode as it was', async () => {
    const dir = temp();
    write(dir, 'static/assets/sketch-12345678.jpg', 'sketch');
    mkdirSync(join(dir, 'siteorigin'), { recursive: true });
    chmodSync(join(dir, 'static/assets'), 0o555);
    chmodSync(join(dir, 'siteorigin'), 0o555);
    await holdDraftAssets(dir, ['static/assets/sketch-12345678.jpg']);
    expect(read(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`)).toBe('sketch');
    expect(there(dir, 'static/assets/sketch-12345678.jpg')).toBe(false);
    expect(statSync(join(dir, 'static/assets')).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, 'siteorigin')).mode & 0o777).toBe(0o555);
  });
});
