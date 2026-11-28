/**
 * Library files only drafts use, held out of an exported editable project's `static/` (#1450): a plain build of the
 * handoff serves `static/` as it is, so a draft's picture or document left there would be published while the draft
 * itself is not. The export moves them to `siteorigin/draft-assets/`, at the same paths below it as below
 * `static/assets/`, and the project's first writable opening in SiteOrigin Builder puts them back.
 */
import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { removeEmptyDirs, safeJoin } from './fsutil';

/** Where an exported editable project keeps the library files only its drafts use. */
export const DRAFT_ASSETS_DIR = 'siteorigin/draft-assets';
const ASSETS_DIR = 'static/assets';

/** Every regular file below `dir`, relative to it with forward slashes. A link, or anything in a linked folder, is none. */
async function heldFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await heldFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** `dir` and every folder below it, each before the folders in it. */
async function allFolders(dir: string): Promise<string[]> {
  const out = [dir];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) out.push(...(await allFolders(join(dir, e.name))));
  return out;
}

/**
 * Put `from` at `to` without replacing anything there: linked and then let go of where the disk can, so the file is
 * at one path or both but never half written, and copied where it cannot (a disk without hard links). False when
 * something is already at `to`.
 */
async function moveNew(from: string, to: string): Promise<boolean> {
  try {
    await fs.link(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EMLINK' && code !== 'ENOSYS') throw e;
    try {
      await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }
  await fs.rm(from);
  return true;
}

/**
 * Move the project files `files` (each in `static/assets/`) of the staged copy `dir` into `siteorigin/draft-assets/`,
 * at the same paths below it. Whatever that folder held before (one the project still had, say) goes first: the copy
 * holds what its drafts use now.
 */
export async function holdDraftAssets(dir: string, files: readonly string[]): Promise<void> {
  await fs.rm(join(dir, DRAFT_ASSETS_DIR), { recursive: true, force: true });
  for (const rel of files) {
    if (!rel.startsWith(`${ASSETS_DIR}/`)) continue;
    const target = `${DRAFT_ASSETS_DIR}/${rel.slice(ASSETS_DIR.length + 1)}`;
    await fs.mkdir(safeJoin(dir, posix.dirname(target)), { recursive: true });
    await fs.rename(safeJoin(dir, rel), safeJoin(dir, target));
  }
}

/**
 * Put the library files an export held back (holdDraftAssets) where the project uses them, in `static/assets/`, and
 * remove the folder once it is empty. A file is never put over one already there: one with the same bytes is the
 * same file (a move cut short), so the held copy goes; anything else there stays as it is, beside the held copy. Only
 * files of their own are moved, never a link nor anything through one. Returns the paths in `static/assets/` of the
 * files left held (another file in the place, or the move refused), for the opening to say so.
 */
export async function restoreDraftAssets(dir: string): Promise<string[]> {
  const held = join(dir, DRAFT_ASSETS_DIR);
  const st = await fs.lstat(held).catch(() => null);
  if (!st?.isDirectory()) return [];
  const kept: string[] = [];
  for (const rel of await heldFiles(held)) {
    const target = `${ASSETS_DIR}/${rel}`;
    try {
      const from = safeJoin(dir, `${DRAFT_ASSETS_DIR}/${rel}`);
      await fs.mkdir(safeJoin(dir, posix.dirname(target)), { recursive: true });
      const to = safeJoin(dir, target);
      if (await moveNew(from, to)) continue;
      const there = await fs.lstat(to);
      if (there.isFile() && (await fs.readFile(from)).equals(await fs.readFile(to))) await fs.rm(from);
      else kept.push(target);
    } catch {
      kept.push(target);
    }
  }
  for (const folder of (await allFolders(held)).reverse()) await removeEmptyDirs(folder, dirname(held));
  return kept;
}

/** What the opening says of held files it could not put back (restoreDraftAssets), each named by its path in `static/assets/`. */
export function keptDraftAssetsNote(kept: readonly string[]): string | null {
  if (!kept.length) return null;
  const at = (rel: string) => `${DRAFT_ASSETS_DIR}/${rel.slice(ASSETS_DIR.length + 1)}`;
  return kept.length === 1
    ? `${kept[0]} was kept aside for a draft when the project was exported, and could not be put back: another file is in its place, or it could not be moved. It is still at ${at(kept[0])}; move it to ${kept[0]} to use it.`
    : `${kept.length} files kept aside for drafts when the project was exported could not be put back: another file is in each one’s place, or it could not be moved. They are still in ${DRAFT_ASSETS_DIR}/; move each to the same place in ${ASSETS_DIR}/ to use it: ${kept.join(', ')}.`;
}
