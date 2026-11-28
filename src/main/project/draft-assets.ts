/**
 * Library files only drafts use, held out of an exported editable project's `static/` (#1450): a plain build of the
 * handoff serves `static/` as it is, so a draft's picture or document left there would be published while the draft
 * itself is not. The export moves them to `siteorigin/draft-assets/`, at the same paths below it as below
 * `static/assets/`, and the project's first writable opening in SiteOrigin Builder puts them back.
 */
import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { AssetRecord } from '@shared/types';
import { removeEmptyDirs, safeJoin } from './fsutil';

/** Where an exported editable project keeps the library files only its drafts use. */
export const DRAFT_ASSETS_DIR = 'siteorigin/draft-assets';
const ASSETS_DIR = 'static/assets';

/** Errors of a disk that has no hard links (as src/main/git/repo.ts knows them), or no more for one file: the file is copied instead. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR', 'UNKNOWN', 'EMLINK']);

/** Every regular file below `dir`, relative to it with forward slashes. A link, or anything in a linked folder, is none. */
async function filesBelow(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await filesBelow(dir, rel)));
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

/** Whether any part of `rel` below `root` that is there is a link: a file is never moved, compared or removed through one. */
async function linkOnTheWay(root: string, rel: string): Promise<boolean> {
  let at = root;
  for (const part of rel.split('/')) {
    const st = await fs.lstat((at = join(at, part))).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/** Whether every part of `rel` below `root` is there spelled exactly so, as a disk that ignores case may not show it. */
async function spelledAs(root: string, rel: string): Promise<boolean> {
  let at = root;
  for (const part of rel.split('/')) {
    if (!(await fs.readdir(at).catch(() => [] as string[])).includes(part)) return false;
    at = join(at, part);
  }
  return true;
}

/** The held folder's own files, as project paths (`siteorigin/draft-assets/…`), or none when it is not a folder of its own. */
export async function heldDraftAssetFiles(dir: string): Promise<string[]> {
  if (await linkOnTheWay(dir, DRAFT_ASSETS_DIR)) return [];
  const st = await fs.lstat(join(dir, DRAFT_ASSETS_DIR)).catch(() => null);
  return st?.isDirectory() ? (await filesBelow(join(dir, DRAFT_ASSETS_DIR))).map((rel) => `${DRAFT_ASSETS_DIR}/${rel}`) : [];
}

/**
 * Put `from` at `to` without replacing anything there: linked and then let go of where the disk can, so the file is at
 * one path or both but never half written, and copied where it can't, into a file the copy alone makes. A copy that
 * fails is taken away again; one cut short by the app stopping is the start of the held file, which the next opening
 * knows (heldAt). False when something is already at `to`.
 */
async function moveNew(from: string, to: string): Promise<boolean> {
  try {
    await fs.link(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') return false;
    if (!NO_LINKS.has(code)) throw e;
    try {
      await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      await fs.rm(to, { force: true });
      throw err;
    }
  }
  await fs.rm(from);
  return true;
}

/**
 * What the file at `to` (the project path `target`) is of the held file `from`, reached through no link and at exactly
 * that name: the held file put back already (`same`: the same bytes, a move cut short), the start of it (`start`: a
 * copy cut short), or another file.
 */
async function heldAt(dir: string, from: string, to: string, target: string): Promise<'same' | 'start' | 'other'> {
  if ((await fs.realpath(from)) === (await fs.realpath(to))) return 'other';
  if (!(await fs.lstat(to)).isFile() || !(await spelledAs(dir, target))) return 'other';
  const [whole, there] = [await fs.readFile(from), await fs.readFile(to)];
  if (whole.equals(there)) return 'same';
  return there.length < whole.length && whole.subarray(0, there.length).equals(there) ? 'start' : 'other';
}

/**
 * Let the owner write in `folder` (a copy keeps its original's modes, and a delivered project its export's) while
 * files are moved out of or into it, noting its own mode in `opened` to be given back. Windows reports no such bits
 * for a folder, nor needs them.
 */
async function openFolder(folder: string, opened: Map<string, number>): Promise<void> {
  if (process.platform === 'win32' || opened.has(folder)) return;
  const mode = (await fs.stat(folder)).mode & 0o7777;
  if ((mode & 0o300) === 0o300) return;
  opened.set(folder, mode);
  await fs.chmod(folder, mode | 0o700);
}

/** Give each folder openFolder opened its own mode back, the deepest first. */
async function closeFolders(opened: Map<string, number>): Promise<void> {
  for (const [folder, mode] of [...opened].reverse()) await fs.chmod(folder, mode).catch(() => undefined);
}

/**
 * Move the project files `files` (each in `static/assets/`) of the staged copy `dir` into `siteorigin/draft-assets/`,
 * at the same paths below it. The export stops before this while the project has files there of its own
 * (heldDraftAssetFiles), so anything still there is no file of the project's.
 */
export async function holdDraftAssets(dir: string, files: readonly string[]): Promise<void> {
  await fs.rm(join(dir, DRAFT_ASSETS_DIR), { recursive: true, force: true });
  const opened = new Map<string, number>();
  try {
    for (const rel of files) {
      if (!rel.startsWith(`${ASSETS_DIR}/`)) continue;
      const target = `${DRAFT_ASSETS_DIR}/${rel.slice(ASSETS_DIR.length + 1)}`;
      await openFolder(join(dir, 'siteorigin'), opened);
      await fs.mkdir(safeJoin(dir, posix.dirname(target)), { recursive: true });
      const from = safeJoin(dir, rel);
      await openFolder(dirname(from), opened);
      await fs.rename(from, safeJoin(dir, target));
    }
  } finally {
    await closeFolders(opened);
  }
}

/**
 * Put the library files an export held back (holdDraftAssets) where the project uses them, in `static/assets/`, and
 * remove the folder once it is empty. Only one of `assets`' own files (an original or a copy, its path matched
 * without case) is ever put back: anything else there is no file an export held. A file is never put over one already
 * there: one with the same bytes at exactly that name is the same file (a move cut short), so the held copy goes; one
 * that is the start of it is a copy cut short, made again; anything else stays as it is, beside the held copy.
 * Nothing is moved, compared or removed through a link.
 * Returns the held files left where they are (as `siteorigin/draft-assets/…`), for the opening to say so.
 */
export async function restoreDraftAssets(dir: string, assets: Readonly<Record<string, AssetRecord>>): Promise<string[]> {
  if (await linkOnTheWay(dir, DRAFT_ASSETS_DIR)) return [];
  const held = join(dir, DRAFT_ASSETS_DIR);
  if (!(await fs.lstat(held).then((st) => st.isDirectory(), () => false))) return [];
  const library = new Set<string>();
  for (const a of Object.values(assets)) for (const f of [a?.file, ...(a?.variants ?? []).map((v) => v?.file)]) if (typeof f === 'string') library.add(f.toLowerCase());
  const kept: string[] = [];
  const opened = new Map<string, number>();
  try {
    for (const path of await heldDraftAssetFiles(dir)) {
      const target = `${ASSETS_DIR}/${path.slice(DRAFT_ASSETS_DIR.length + 1)}`;
      if (!library.has(target.toLowerCase())) {
        kept.push(path);
        continue;
      }
      try {
        const from = safeJoin(dir, path);
        if (await linkOnTheWay(dir, target)) {
          kept.push(path);
          continue;
        }
        await fs.mkdir(safeJoin(dir, posix.dirname(target)), { recursive: true });
        if (await linkOnTheWay(dir, target)) {
          kept.push(path);
          continue;
        }
        const to = safeJoin(dir, target);
        await openFolder(dirname(to), opened);
        await openFolder(dirname(from), opened);
        if (await moveNew(from, to)) continue;
        const there = await heldAt(dir, from, to, target);
        if (there === 'same') await fs.rm(from);
        else if (there !== 'start' || !(await fs.rm(to).then(() => moveNew(from, to)))) kept.push(path);
      } catch {
        kept.push(path);
      }
    }
    for (const folder of (await allFolders(held)).reverse()) await removeEmptyDirs(folder, dirname(held));
  } finally {
    await closeFolders(opened);
  }
  return kept;
}

/** What the opening says of held files it left where they are (restoreDraftAssets), each named by its project path. */
export function keptDraftAssetsNote(kept: readonly string[]): string | null {
  if (!kept.length) return null;
  return kept.length === 1
    ? `${kept[0]} was left where it is, in the folder where an exported project keeps the files only its drafts use: it is no file of the project’s assets, another file is in its place in ${ASSETS_DIR}/, or it could not be moved. Move it into ${ASSETS_DIR}/ to use it, or delete it.`
    : `${kept.length} files were left where they are in ${DRAFT_ASSETS_DIR}/, where an exported project keeps the files only its drafts use: each is no file of the project’s assets, has another file in its place in ${ASSETS_DIR}/, or could not be moved. Move them into ${ASSETS_DIR}/ to use them, or delete them: ${kept.join(', ')}.`;
}

/** Why an editable export stops while the project still has held files (heldDraftAssetFiles), each named by its project path. */
export function heldDraftAssetsStop(files: readonly string[]): string {
  return files.length === 1
    ? `${files[0]} is still kept aside from an earlier export of this project. Move it into ${ASSETS_DIR}/ or delete it, then export again.`
    : `${files.length} files in ${DRAFT_ASSETS_DIR}/ are still kept aside from an earlier export of this project: ${files.join(', ')}. Move them into ${ASSETS_DIR}/ or delete them, then export again.`;
}
