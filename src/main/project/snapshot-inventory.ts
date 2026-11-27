/**
 * What a snapshot of a project holds (#1151): the files a Git-backed saved version (#1153) and the publication history
 * (#1154) are made from. An allowlist, never "everything but": the canonical documents (drafts included), the authored
 * code components, the project's source under src/ (generated and the author's own), the generated manifest, the
 * starter's configuration and lockfiles, and the public files under static/ (library media, used or not). Nothing
 * private ever reaches a tree: not the brief or the copies an editor leaves beside it, not a credential or key at any
 * depth, not another repository or the editor's own state (`.git`, `.siteorigin/`), not installed tools or build
 * caches, not a link or a special file, not a path that would lead out of the project.
 *
 * External sources' settings and converters are the one private part a saved version still needs to restore the site
 * as it was, so they are captured as attachments beside the tree: read and checked like every other file, but kept apart
 * so they can be stored outside Git. Whether they hold what the project holds is the caller's to check (as
 * exportedSourcesProblem does for an export).
 *
 * Capturing reads the project while it may be changing. Every file is opened without following a link and checked to
 * be the one listed, hashed, and the whole project listed again: a file changed, replaced, added or removed, a mode
 * changed, or a file or folder swapped for a link meanwhile fails the capture rather than mixing two states. A file whose
 * stat cannot stand for its bytes (changed only just now, or on a disk with coarse times) is hashed again. Each file's
 * bytes are read again only when the caller asks, through the same checks, and compared with the hash captured, so a
 * large library is never held in memory at once. Node has no way to open a file relative to a folder already opened, so
 * a folder swapped for a link and back between two checks goes unseen; so does a hard link that gives a private file's
 * bytes a public name. Both need someone writing into the project on purpose, who could write any public file anyway.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { converterPathOf, isCanonicalPath, MANIFEST_FILE, sourcePathOf } from './documents';
import { isPrivateFileName } from './private-files';
import { isMissing, stampOf, statTrusted } from './stable-read';

/** Why a path is no part of a snapshot. */
export type SnapshotExclusion =
  /** Not a plain relative path inside the project. */
  | 'unsafe-path'
  /** A repository (`.git`, a folder or a worktree's file) or the editor's own state (`.siteorigin/`), at any depth. */
  | 'local-state'
  /** Installed tools and build output: `node_modules/`, `.svelte-kit/`, Vite's caches, `build/`. */
  | 'cache'
  /** What a computer leaves beside files (`.DS_Store`, `Thumbs.db`, `._` files) and half-written temporary files. */
  | 'clutter'
  /** A credential or key, or a copy of the app's own credential files (isPrivateFileName), at any depth. */
  | 'private'
  /** The project brief, or a copy of it beside it. */
  | 'brief'
  /** Anything in the external sources' folder but their settings and converters. */
  | 'source'
  /** Outside the allowlist. */
  | 'outside';

/** Where a project path goes in a snapshot. */
export type SnapshotPlace =
  | { kind: 'tree' }
  /** An external source's settings or converter: held beside the tree, never in it. */
  | { kind: 'attachment'; sourceId: string; part: 'settings' | 'converter' }
  | { kind: 'excluded'; reason: SnapshotExclusion };

/** The files at the project's top a snapshot holds: its manifest, the starter's configuration and lockfile, and the files the app writes there. */
const ROOT_FILES = new Set([MANIFEST_FILE, 'package.json', 'package-lock.json', 'jsconfig.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js', 'vercel.json', '.gitignore', 'README.md', 'NOTICE.md']);
/** The folders at the project's top a snapshot looks in. */
const ROOT_FOLDERS = new Set(['src', 'static', 'siteorigin', 'scripts']);
/** The generator's record of what it wrote, beside the canonical documents. */
export const GENERATED_MANIFEST = 'siteorigin/generated-manifest.json';
/** The sync script an exported project with external sources carries (SYNC_SCRIPT in export.ts). */
export const SNAPSHOT_SYNC_SCRIPT = 'scripts/sync-sources.mjs';
const LOCAL_STATE = new Set(['.git', '.siteorigin']);
const CACHES = new Set(['node_modules', '.svelte-kit', '.vite', '.vite-temp']);
const CLUTTER = /^(\.ds_store|thumbs\.db|desktop\.ini|\._.*|.*\.tmp)$/i;

const TREE: SnapshotPlace = { kind: 'tree' };
const excluded = (reason: SnapshotExclusion): SnapshotPlace => ({ kind: 'excluded', reason });

/** Whether `rel` is not a plain relative path: empty, absolute, a drive, a backslash or control character, or a `.`, `..` or empty part. */
function unsafePath(rel: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || /[\\\u0000-\u001f\u007f]/.test(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..');
}

/** Why a part of a path (the `i`th) leaves everything under it out, or null. Without case: on a case-insensitive disk, `.GIT` is the same folder. */
function partExcluded(part: string, i: number): SnapshotExclusion | null {
  const p = part.toLowerCase();
  if (LOCAL_STATE.has(p)) return 'local-state';
  if (CACHES.has(p) || (i === 0 && p === 'build')) return 'cache';
  return isPrivateFileName(part) ? 'private' : null;
}

/**
 * Where the project file at `rel` (relative, with forward slashes, as the disk spells it) goes in a snapshot. The
 * allowlist is spelled exactly; what keeps private files out is matched without case, as a case-insensitive disk would.
 * A path from a snapshot being restored is checked the same way.
 */
export function snapshotPlace(rel: string): SnapshotPlace {
  if (unsafePath(rel)) return excluded('unsafe-path');
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const why = partExcluded(parts[i], i);
    if (why) return excluded(why);
  }
  const name = parts[parts.length - 1];
  if (CLUTTER.test(name)) return excluded('clutter');
  if (parts[0].toLowerCase() === 'siteorigin' && parts.length > 1) {
    // The brief, and any copy of it an editor or a file manager left beside it (`brief.json~`, `.#brief.json`,
    // `brief (1).json`), which can hold notes the author has since taken out.
    if (parts.length === 2 && name.toLowerCase().includes('brief')) return excluded('brief');
    if (parts[1].toLowerCase() === 'sources') {
      const settings = sourcePathOf(rel);
      if (settings) return { kind: 'attachment', sourceId: settings, part: 'settings' };
      const converter = converterPathOf(rel);
      return converter ? { kind: 'attachment', sourceId: converter, part: 'converter' } : excluded('source');
    }
  }
  if (parts.length === 1) return ROOT_FILES.has(rel) ? TREE : excluded('outside');
  if (parts[0] === 'src' || parts[0] === 'static') return TREE;
  if (parts[0] === 'siteorigin') return rel === GENERATED_MANIFEST || isCanonicalPath(rel) ? TREE : excluded('outside');
  return rel === SNAPSHOT_SYNC_SCRIPT ? TREE : excluded('outside');
}

/** Whether a folder at `rel` can hold a file a snapshot takes, so the walk looks inside it. */
function folderKept(rel: string): boolean {
  if (unsafePath(rel)) return false;
  const parts = rel.split('/');
  return ROOT_FOLDERS.has(parts[0]) && parts.every((p, i) => !partExcluded(p, i));
}

/** A file of a snapshot, by its project path. */
export interface SnapshotFile {
  /** Relative to the project, with forward slashes, as the disk spells it. */
  path: string;
  /** Git's mode for it: executable or not. */
  mode: '100644' | '100755';
  size: number;
  /** The SHA-256 of its bytes, as captured. */
  sha256: string;
  /**
   * Its bytes, read again through a handle checked to reach the file captured, unchanged: a SnapshotCaptureError says
   * the file changed (or went) since.
   */
  read(): Promise<Buffer>;
}

/** An external source's settings (`source.json`) or converter (`converter.mjs`), captured beside the tree. */
export interface SnapshotAttachment extends SnapshotFile {
  sourceId: string;
  part: 'settings' | 'converter';
}

/** A project's snapshot: the tree a version holds, and the attachments kept beside it. Each sorted by path. */
export interface SnapshotInventory {
  tree: SnapshotFile[];
  attachments: SnapshotAttachment[];
}

/**
 * Why a project could not be captured: a file `changed` while it was read (edited, replaced, added, removed, swapped for
 * a link), could not be read (`unreadable`), or shares its name with another on a computer that cannot tell them apart
 * (`collision`). `path` is the file's project path.
 */
export class SnapshotCaptureError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'changed' | 'unreadable' | 'collision',
    message: string
  ) {
    super(message);
    this.name = 'SnapshotCaptureError';
  }
}

const changed = (rel: string) => new SnapshotCaptureError(rel, 'changed', `${rel || 'The project folder'} changed while the project was being read. Try again once nothing is changing it.`);
const unreadable = (rel: string, e: unknown) => new SnapshotCaptureError(rel, 'unreadable', `${rel || 'The project folder'} could not be read: ${(e as Error)?.message ?? e}`);

/** What a listing saw at a path. */
interface Listed {
  rel: string;
  abs: string;
  dir: boolean;
  /** The device and inode: the same only for the same file or folder. */
  id: string;
  /** The path's stat (stampOf): any write to the file changes it. */
  stamp: string;
  size: bigint;
  executable: boolean;
  /** Whether the stamp can stand for the bytes (statTrusted when listed). */
  trusted: boolean;
  place: SnapshotPlace;
}

/** Opened for reading without following a link (where the system can refuse one) and without waiting on a pipe. */
const OPEN_FILE = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const windows = process.platform === 'win32';

/** Every folder the walk looks in and every file a snapshot takes in `root`, by project path ('' is the project folder). */
async function listProject(root: string, settleMs: number): Promise<Map<string, Listed>> {
  const now = Date.now();
  const out = new Map<string, Listed>();
  const record = (rel: string, abs: string, st: BigIntStats, place: SnapshotPlace) =>
    out.set(rel, {
      rel,
      abs,
      dir: st.isDirectory(),
      id: `${st.dev}:${st.ino}`,
      stamp: stampOf(st),
      size: st.size,
      executable: !windows && (st.mode & 0o111n) !== 0n,
      trusted: statTrusted(st, now, settleMs),
      place
    });
  let top: BigIntStats;
  try {
    top = await fs.lstat(root, { bigint: true });
  } catch (e) {
    throw unreadable('', e);
  }
  if (!top.isDirectory()) throw unreadable('', new Error('it is not a folder.'));
  record('', root, top, TREE);
  const walk = async (rel: string, abs: string) => {
    let names: string[];
    try {
      names = await fs.readdir(abs);
    } catch (e) {
      // A folder listed a moment ago that is gone, or is no folder now, has changed.
      if (isMissing(e)) throw changed(rel);
      throw unreadable(rel, e);
    }
    for (const name of names.sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const place = snapshotPlace(r);
      const descend = folderKept(r);
      if (place.kind === 'excluded' && !descend) continue;
      const a = join(abs, name);
      let st: BigIntStats;
      try {
        st = await fs.lstat(a, { bigint: true });
      } catch (e) {
        // Gone since the folder was read: no part of the project as it is now.
        if (isMissing(e)) continue;
        throw unreadable(r, e);
      }
      if (st.isDirectory()) {
        if (!descend) continue;
        record(r, a, st, place);
        await walk(r, a);
      } else if (st.isFile() && place.kind !== 'excluded') record(r, a, st, place);
      // A link, or anything else that is not a plain file (a pipe, a socket, a device), is no file of a snapshot's.
    }
  };
  await walk('', root);
  return out;
}

/** A handle on the listed file, checked to be it: a plain file, the same one, the same size (and, where the path and handle are stat'ed alike, the same stamp). */
async function openListed(l: Listed): Promise<{ handle: FileHandle; stamp: string }> {
  let handle: FileHandle;
  try {
    handle = await fs.open(l.abs, OPEN_FILE);
  } catch (e) {
    // Gone, or a link now where the file was (refused by O_NOFOLLOW).
    const code = (e as NodeJS.ErrnoException).code;
    if (isMissing(e) || code === 'ELOOP' || code === 'EMLINK') throw changed(l.rel);
    throw unreadable(l.rel, e);
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile() || `${st.dev}:${st.ino}` !== l.id || st.size !== l.size || (!windows && stampOf(st) !== l.stamp)) throw changed(l.rel);
    return { handle, stamp: stampOf(st) };
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
}

/** The SHA-256 of the listed file's bytes, read through one checked handle, and that handle's stamp. */
async function hashListed(l: Listed): Promise<{ sha256: string; stamp: string }> {
  const { handle, stamp } = await openListed(l);
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1 << 20);
    let total = 0n;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += BigInt(bytesRead);
    }
    if (total !== l.size || stampOf(await handle.stat({ bigint: true })) !== stamp) throw changed(l.rel);
    return { sha256: hash.digest('hex'), stamp };
  } catch (e) {
    if (e instanceof SnapshotCaptureError) throw e;
    throw unreadable(l.rel, e);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The listed file's bytes, read through a checked handle, as long as they are still the ones captured. */
async function readCaptured(l: Listed, captured: { sha256: string; stamp: string }): Promise<Buffer> {
  const { handle, stamp } = await openListed(l);
  try {
    if (stamp !== captured.stamp) throw changed(l.rel);
    const bytes = await handle.readFile();
    if (stampOf(await handle.stat({ bigint: true })) !== stamp || createHash('sha256').update(bytes).digest('hex') !== captured.sha256) throw changed(l.rel);
    return bytes;
  } catch (e) {
    if (e instanceof SnapshotCaptureError) throw e;
    throw unreadable(l.rel, e);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The path in `after` that differs from `before`: added, removed, another file or folder, a file changed or its mode. */
function firstChange(before: Map<string, Listed>, after: Map<string, Listed>): string | null {
  for (const [rel, b] of before) {
    const a = after.get(rel);
    // A folder's own stamp moves with any file made or removed in it, kept or not: only what it is counts.
    if (!a || a.dir !== b.dir || a.id !== b.id) return rel;
    if (!b.dir && (a.stamp !== b.stamp || a.executable !== b.executable)) return rel;
  }
  for (const rel of after.keys()) if (!before.has(rel)) return rel;
  return null;
}

/** Two paths no case-insensitive or accent-insensitive disk could hold both of, or null. */
function collision(paths: string[]): [string, string] | null {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const key = p.normalize('NFC').toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) return [other, p];
    seen.set(key, p);
  }
  return null;
}

/** How many files are hashed at once: enough to overlap the disk's waits. */
const HASH_BATCH = 8;

async function settledBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += HASH_BATCH) {
    // Every one of a batch is done before a failure among them is thrown, so no handle is left open behind it.
    const settled = await Promise.allSettled(items.slice(i, i + HASH_BATCH).map(fn));
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    for (const r of settled) out.push((r as PromiseFulfilledResult<R>).value);
  }
  return out;
}

/**
 * Capture the snapshot of the project in `root` (a real path): every file it takes, listed, hashed and checked to be
 * the project as it was throughout (see the top of this file). Throws a SnapshotCaptureError when it was not. `settleMs`
 * is how long a file must have been left alone for its stat to stand for its bytes (statTrusted); `paused` is called
 * once the files are listed and once they are hashed, before the check that nothing changed (for tests).
 */
export async function captureSnapshotInventory(root: string, opts: { settleMs?: number; paused?: (at: 'listed' | 'hashed') => Promise<void> | void } = {}): Promise<SnapshotInventory> {
  const settleMs = opts.settleMs ?? 3000;
  const before = await listProject(root, settleMs);
  const files = [...before.values()].filter((l) => !l.dir);
  const clash = collision(files.map((l) => l.rel));
  if (clash) throw new SnapshotCaptureError(clash[1], 'collision', `${clash[0]} and ${clash[1]} have names some computers cannot tell apart. Rename one of them, then try again.`);
  await opts.paused?.('listed');
  const hashed = await settledBatches(files, hashListed);
  await opts.paused?.('hashed');
  const after = await listProject(root, settleMs);
  const moved = firstChange(before, after);
  if (moved !== null) throw changed(moved);
  // A file whose stamp cannot stand for its bytes could have changed without it: it is hashed again.
  await settledBatches(
    files.map((l, i) => ({ l, i })).filter(({ l }) => !l.trusted),
    async ({ l, i }) => {
      if ((await hashListed(l)).sha256 !== hashed[i].sha256) throw changed(l.rel);
    }
  );
  const tree: SnapshotFile[] = [];
  const attachments: SnapshotAttachment[] = [];
  files.forEach((l, i) => {
    const captured = hashed[i];
    const file: SnapshotFile = { path: l.rel, mode: l.executable ? '100755' : '100644', size: Number(l.size), sha256: captured.sha256, read: () => readCaptured(l, captured) };
    if (l.place.kind === 'attachment') attachments.push({ ...file, sourceId: l.place.sourceId, part: l.place.part });
    else tree.push(file);
  });
  const byPath = (a: SnapshotFile, b: SnapshotFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { tree: tree.sort(byPath), attachments: attachments.sort(byPath) };
}
