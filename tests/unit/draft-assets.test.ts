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
/** A library whose records own `files`: each a record's original, or `original<variant` for one of its copies too. */
const library = (...files: string[]): Record<string, AssetRecord> =>
  Object.fromEntries(
    files.map((spec, i) => {
      const [file, ...variants] = spec.split('<');
      return [`a${i}`, { id: `a${i}`, name: `a${i}`, file, variants: variants.map((v) => ({ width: 480, file: v })), mime: 'image/jpeg', bytes: 1, hash: 'x', kind: 'image', createdAt: '' } as AssetRecord];
    })
  );
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
    write(dir, 'static/assets/sketch-12345678-480w.webp', 'small sketch');
    write(dir, 'static/assets/fonts/brand.woff2', 'font');
    write(dir, 'static/assets/public-bbbbbbbb.svg', 'public');
    write(dir, 'static/robots.txt', 'robots');
    // Left from before: the copy holds what its drafts use now.
    write(dir, `${DRAFT_ASSETS_DIR}/stale-cccccccc.pdf`, 'stale');
    // Only files in static/assets/ are ever held.
    await holdDraftAssets(dir, ['static/assets/sketch-12345678.jpg', 'static/assets/sketch-12345678-480w.webp', 'static/assets/fonts/brand.woff2', 'static/robots.txt']);
    expect(there(dir, 'static/assets/sketch-12345678.jpg')).toBe(false);
    expect(there(dir, 'static/assets/fonts/brand.woff2')).toBe(false);
    expect(read(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`)).toBe('sketch');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/fonts/brand.woff2`)).toBe('font');
    expect(there(dir, `${DRAFT_ASSETS_DIR}/stale-cccccccc.pdf`)).toBe(false);
    expect(read(dir, 'static/robots.txt')).toBe('robots');
    expect(read(dir, 'static/assets/public-bbbbbbbb.svg')).toBe('public');
    expect((await heldDraftAssetFiles(dir)).sort()).toEqual([`${DRAFT_ASSETS_DIR}/fonts/brand.woff2`, `${DRAFT_ASSETS_DIR}/sketch-12345678-480w.webp`, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`]);

    // Extracted somewhere static/assets/ is gone altogether, it is made again: a record's original and its copy, and a
    // font in a folder of its own.
    rmSync(join(dir, 'static'), { recursive: true });
    expect(await restoreDraftAssets(dir, library('static/assets/fonts/brand.woff2', 'static/assets/sketch-12345678.jpg<static/assets/sketch-12345678-480w.webp'))).toEqual([]);
    expect(read(dir, 'static/assets/sketch-12345678.jpg')).toBe('sketch');
    expect(read(dir, 'static/assets/sketch-12345678-480w.webp')).toBe('small sketch');
    expect(read(dir, 'static/assets/fonts/brand.woff2')).toBe('font');
    expect(there(dir, DRAFT_ASSETS_DIR)).toBe(false);
    expect(there(dir, 'siteorigin')).toBe(true);
    // Nothing held, nothing done.
    expect(await restoreDraftAssets(dir, {})).toEqual([]);
    expect(await heldDraftAssetFiles(dir)).toEqual([]);
  });

  it('puts back only files of the library, never over one already there', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/same-12345678.jpg`, 'same');
    write(dir, 'static/assets/same-12345678.jpg', 'same');
    write(dir, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`, 'held');
    write(dir, 'static/assets/other-12345678.pdf', 'help');
    write(dir, `${DRAFT_ASSETS_DIR}/folder-12345678.svg`, 'held');
    mkdirSync(join(dir, 'static/assets/folder-12345678.svg'), { recursive: true });
    write(dir, `${DRAFT_ASSETS_DIR}/new-12345678.svg`, 'new');
    // Notes of the author's own, even one dated like an imported file's name, and a file no record names in a folder:
    // never published by being opened.
    write(dir, `${DRAFT_ASSETS_DIR}/reviewer-notes.txt`, 'notes');
    write(dir, `${DRAFT_ASSETS_DIR}/notes-20261128.txt`, 'notes');
    write(dir, `${DRAFT_ASSETS_DIR}/extra/thing-12345678.svg`, 'thing');
    const records = library('static/assets/same-12345678.jpg', 'static/assets/other-12345678.pdf', 'static/assets/folder-12345678.svg', 'static/assets/new-12345678.svg');
    expect((await restoreDraftAssets(dir, records)).sort()).toEqual(
      [
        `${DRAFT_ASSETS_DIR}/extra/thing-12345678.svg`,
        `${DRAFT_ASSETS_DIR}/folder-12345678.svg`,
        `${DRAFT_ASSETS_DIR}/notes-20261128.txt`,
        `${DRAFT_ASSETS_DIR}/other-12345678.pdf`,
        `${DRAFT_ASSETS_DIR}/reviewer-notes.txt`
      ].sort()
    );
    expect(read(dir, 'static/assets/same-12345678.jpg')).toBe('same');
    expect(there(dir, `${DRAFT_ASSETS_DIR}/same-12345678.jpg`)).toBe(false);
    expect(read(dir, 'static/assets/other-12345678.pdf')).toBe('help');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/other-12345678.pdf`)).toBe('held');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/folder-12345678.svg`)).toBe('held');
    expect(read(dir, 'static/assets/new-12345678.svg')).toBe('new');
    expect(there(dir, 'static/assets/reviewer-notes.txt')).toBe(false);
    expect(there(dir, 'static/assets/notes-20261128.txt')).toBe(false);
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
    const records = library('static/assets/sketch-12345678.jpg', 'static/assets/taken-12345678.jpg', 'static/assets/cut-12345678.jpg');
    vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('no links'), { code: 'EISDIR' }));
    expect(await restoreDraftAssets(dir, records)).toEqual([`${DRAFT_ASSETS_DIR}/taken-12345678.jpg`]);
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
    expect(await restoreDraftAssets(dir, records)).toContain(`${DRAFT_ASSETS_DIR}/cut-12345678.jpg`);
    expect(there(dir, 'static/assets/cut-12345678.jpg')).toBe(false);
    // One a restore cut short left behind is its own, never a held file, and goes.
    write(dir, `${DRAFT_ASSETS_DIR}/.siteorigin-restoring-a1b2c3/cut-12345678.jpg`, 'wh');
    expect(await heldDraftAssetFiles(dir)).toEqual([`${DRAFT_ASSETS_DIR}/cut-12345678.jpg`, `${DRAFT_ASSETS_DIR}/taken-12345678.jpg`]);
    cut.mockImplementation(copy);
    expect(await restoreDraftAssets(dir, records)).toEqual([`${DRAFT_ASSETS_DIR}/taken-12345678.jpg`]);
    expect(read(dir, 'static/assets/cut-12345678.jpg')).toBe('whole picture');
    expect(there(dir, `${DRAFT_ASSETS_DIR}/.siteorigin-restoring-a1b2c3`)).toBe(false);
  });

  it.each(['EACCES', 'EIO'])('leaves a held file where it is when the disk refuses the move otherwise (%s)', async (code) => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`, 'sketch');
    vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('refused'), { code }));
    const copy = vi.spyOn(fsPromises, 'copyFile');
    expect(await restoreDraftAssets(dir, library('static/assets/sketch-12345678.jpg'))).toEqual([`${DRAFT_ASSETS_DIR}/sketch-12345678.jpg`]);
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
    expect(await restoreDraftAssets(dir, library('static/assets/secret-12345678.txt'))).toEqual([]);
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
    expect(await restoreDraftAssets(looped, library('static/assets/only-12345678.pdf'))).toEqual([`${DRAFT_ASSETS_DIR}/only-12345678.pdf`]);
    expect(read(looped, `${DRAFT_ASSETS_DIR}/only-12345678.pdf`)).toBe('the only copy');
  });

  it.runIf(ignoresCase())('keeps a held file whose name a file there matches only without case', async () => {
    const dir = temp();
    write(dir, `${DRAFT_ASSETS_DIR}/photo-12345678.jpg`, 'same');
    write(dir, 'static/assets/Photo-12345678.jpg', 'same');
    // A folder on the way spelled otherwise is no more the same place.
    write(dir, `${DRAFT_ASSETS_DIR}/fonts/brand.woff2`, 'font');
    write(dir, 'static/assets/Fonts/brand.woff2', 'font');
    expect((await restoreDraftAssets(dir, library('static/assets/photo-12345678.jpg', 'static/assets/fonts/brand.woff2'))).sort()).toEqual([`${DRAFT_ASSETS_DIR}/fonts/brand.woff2`, `${DRAFT_ASSETS_DIR}/photo-12345678.jpg`]);
    expect(read(dir, `${DRAFT_ASSETS_DIR}/photo-12345678.jpg`)).toBe('same');
    expect(read(dir, `${DRAFT_ASSETS_DIR}/fonts/brand.woff2`)).toBe('font');
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
    // Delivered so, the project still gets them back when it is opened, its folders' modes as they were.
    expect(await restoreDraftAssets(dir, library('static/assets/sketch-12345678.jpg'))).toEqual([]);
    expect(read(dir, 'static/assets/sketch-12345678.jpg')).toBe('sketch');
    expect(statSync(join(dir, 'static/assets')).mode & 0o777).toBe(0o555);
  });
});
