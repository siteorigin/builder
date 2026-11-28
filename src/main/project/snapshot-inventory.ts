/**
 * What a snapshot of a project holds (#1151): the files a Git-backed saved version (#1153) and the publication history
 * (#1154) are made from. An allowlist, never "everything but": the canonical documents (drafts included), the authored
 * code components, the project's source under src/ (generated and the author's own), the generated manifest, the
 * starter's configuration and lockfiles, the developer's own setup files beside them and tests under tests/ (#1484),
 * and the public files under static/ (library media, used or not). Nothing
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
 *
 * A snapshot is restored on other computers too, so two files a case-insensitive disk would take for one (or a file
 * for a folder), and a name that is not valid text, fail the capture. A name only Windows cannot hold is kept as it is;
 * windowsCanHold is for a restore there to check.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { converterPathOf, isCanonicalPath, MANIFEST_FILE, sourcePathOf } from './documents';
import { CREDENTIAL_STEMS, isPrivateFileName } from './private-files';
import { isMissing, stampOf, statTrusted } from './stable-read';

/** Why a path is no part of a snapshot. */
export type SnapshotExclusion =
  /** Not a plain relative path inside the project. */
  | 'unsafe-path'
  /** A repository (`.git`, a folder or a worktree's file) or the editor's own state (`.siteorigin/`), at any depth. */
  | 'local-state'
  /** Installed tools, build and test output: `node_modules/`, `.svelte-kit/`, Vite's and Wrangler's caches, `build/`, a test run's reports. */
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
export const SNAPSHOT_ROOT_FILES: readonly string[] = [MANIFEST_FILE, 'package.json', 'package-lock.json', 'jsconfig.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js', 'vercel.json', '.gitignore', 'README.md', 'NOTICE.md'];
const ROOT_FILES = new Set(SNAPSHOT_ROOT_FILES);
/**
 * The developer's own setup files at the project's top a snapshot holds too (#1484), as an editable export does:
 * TypeScript's (`tsconfig.json`, `tsconfig.node.json`), a host's (`wrangler.toml`, `netlify.toml`), and any tool's
 * `<name>.config.<js|ts|…|json>` (`eslint.config.js`, `vitest.config.ts`, `playwright.config.ts`). Spelled exactly.
 */
const DEVELOPER_ROOT_FILES = new Set(['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'netlify.toml']);
const DEVELOPER_ROOT_FILE = /^(tsconfig(\.[\w-]+)*\.json|[\w.-]+\.config\.(js|ts|mjs|cjs|mts|cts|json))$/;
/** The folder of the project's own tests, held at any depth (#1484). */
const TESTS = 'tests';
/** What a test run writes into the tests' folder: its reports and coverage, held as a cache is. Folded. */
const TEST_OUTPUT = new Set(['playwright-report', 'test-results', 'blob-report', 'coverage']);
/** The folders at the project's top a snapshot looks in. */
const ROOT_FOLDERS = new Set(['src', 'static', 'siteorigin', 'scripts', TESTS]);
/** The generator's record of what it wrote, beside the canonical documents. */
export const GENERATED_MANIFEST = 'siteorigin/generated-manifest.json';
/** The sync script an exported project with external sources carries (SYNC_SCRIPT in export.ts). */
export const SNAPSHOT_SYNC_SCRIPT = 'scripts/sync-sources.mjs';
const LOCAL_STATE = new Set(['.git', '.siteorigin']);
/** Wrangler's local state (#1126) among them: its local databases and bundles hold what `.dev.vars` gave them. */
const CACHES = new Set(['node_modules', '.svelte-kit', '.vite', '.vite-temp', '.wrangler']);
const CLUTTER = /^(\.ds_store|thumbs\.db|desktop\.ini|\._.*|.*\.tmp)$/;
/** Names Windows gives another meaning: devices (COM¹ too), whatever their extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** What HFS+ leaves out when it compares names (as Git's own check for `.git` does): joiners, direction marks, a BOM. */
const IGNORED_BY_HFS = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * A name as a case-insensitive disk compares it, near enough: composed, with what HFS+ ignores taken out, and folded
 * through both cases, so that APFS's equivalents match too (`.ſiteorigin`, with a long s, is `.siteorigin`; `client.Key`
 * with a Kelvin sign is `client.key`; `STRAẞE` is `straße`). One name at a time: never a whole path, which a character
 * that folds into a slash would split.
 */
export const foldName = (name: string) => name.replace(IGNORED_BY_HFS, '').normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
const fold = foldName;

const TREE: SnapshotPlace = { kind: 'tree' };
const excluded = (reason: SnapshotExclusion): SnapshotPlace => ({ kind: 'excluded', reason });

/** Whether `rel` is not a plain relative path: empty, absolute, a drive, a backslash or control character, or a `.`, `..` or empty part. */
function unsafePath(rel: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || /[\\\u0000-\u001f\u007f]/.test(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..');
}

/** Why a part of a path (the `i`th) leaves everything under it out, or null. Folded: on a case-insensitive disk, `.GIT` is the same folder. */
function partExcluded(part: string, i: number): SnapshotExclusion | null {
  const p = fold(part);
  if (LOCAL_STATE.has(p)) return 'local-state';
  if (CACHES.has(p) || (i === 0 && p === 'build')) return 'cache';
  return isPrivateFileName(part) || isPrivateFileName(p) ? 'private' : null;
}

/** What an editor or a sync tool adds to a file's name for its copy: a backup, a swap file, an autosave. */
const EDITOR_SUFFIX = /(~|#|\.(bak|old|orig|swp|swo|tmp|sav))+$/;
/** Any JSON file named after one of the app's own credential files, whatever was added to the name. */
const NAMED_AFTER_CREDENTIALS = new RegExp(`(${CREDENTIAL_STEMS.join('|')}).*\\.json([~#]|\\.(bak|old|orig|swp|swo|tmp|sav))*$`);

/**
 * Whether a file named `folded` (folded) is a copy of a private file: what an editor leaves of one (`client.pem~`,
 * `.env.swp`, `#.npmrc#`), and any JSON file named after the app's own credential files whatever was added to the name
 * (`api-keys (conflicted copy).json`, as a sync tool names its copy). Broader than an export's rule on purpose: a
 * snapshot keeps what it holds for good, so a public file named after them stays out too. A file's name only: a
 * folder's is never stripped, and a canonical document is never one.
 */
function copyOfPrivate(folded: string): boolean {
  const bare = folded.replace(EDITOR_SUFFIX, '').replace(/^\.?#/, '');
  if (bare && bare !== folded && isPrivateFileName(bare)) return true;
  return NAMED_AFTER_CREDENTIALS.test(folded);
}

/**
 * Whether Windows can hold a file at `rel` as it is named, for a restore there to check before it writes one: none of
 * the characters Windows refuses, no part it reads as something else (`photo.jpg:preview` is a stream of photo.jpg,
 * `aux` a device) and none whose trailing dot or space it would drop, making it another file's name. A snapshot taken
 * on macOS or Linux holds such names as they are (a `/` typed in the Finder is a `:` on disk, a page may be at /aux/).
 */
export function windowsCanHold(rel: string): boolean {
  return rel.split('/').every((p) => !/[<>:"|?*]/.test(p) && !WINDOWS_RESERVED.test(p) && !/[. ]$/.test(p));
}

/**
 * Where the project file at `rel` (relative, with forward slashes, as the disk spells it) goes in a snapshot. The
 * allowlist is spelled exactly; what keeps private files out is folded (foldName), as a case-insensitive disk compares
 * names. A path from a snapshot being restored is checked the same way.
 */
export function snapshotPlace(rel: string): SnapshotPlace {
  if (unsafePath(rel)) return excluded('unsafe-path');
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const why = partExcluded(parts[i], i);
    if (why) return excluded(why);
  }
  if (testOutput(parts.slice(0, -1))) return excluded('cache');
  const name = fold(parts[parts.length - 1]);
  if (CLUTTER.test(name)) return excluded('clutter');
  if (copyOfPrivate(name) && !isCanonicalPath(rel)) return excluded('private');
  if (fold(parts[0]) === 'siteorigin' && parts.length > 1) {
    // The brief, and any copy of it an editor or a file manager left beside it (`brief.json~`, `.#brief.json`,
    // `brief (1).json`), which can hold notes the author has since taken out.
    if (parts.length === 2 && name.includes('brief')) return excluded('brief');
    if (fold(parts[1]) === 'sources') {
      const settings = sourcePathOf(rel);
      if (settings) return { kind: 'attachment', sourceId: settings, part: 'settings' };
      const converter = converterPathOf(rel);
      return converter ? { kind: 'attachment', sourceId: converter, part: 'converter' } : excluded('source');
    }
  }
  if (parts.length === 1) return ROOT_FILES.has(rel) || DEVELOPER_ROOT_FILES.has(rel) || DEVELOPER_ROOT_FILE.test(rel) ? TREE : excluded('outside');
  if (parts[0] === 'src' || parts[0] === 'static' || parts[0] === TESTS) return TREE;
  if (parts[0] === 'siteorigin') return rel === GENERATED_MANIFEST || isCanonicalPath(rel) ? TREE : excluded('outside');
  return rel === SNAPSHOT_SYNC_SCRIPT ? TREE : excluded('outside');
}

/**
 * Whether a project file at `rel` is a developer's own, which a snapshot holds and a publication never carries
 * (#1484): a setup file at the project's top beyond the starter's (DEVELOPER_ROOT_FILE), or anything under tests/.
 * By its name alone: whether a snapshot holds it at all is snapshotPlace's to say.
 */
export function developerOnly(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.length === 1) return !ROOT_FILES.has(rel) && (DEVELOPER_ROOT_FILES.has(rel) || DEVELOPER_ROOT_FILE.test(rel));
  return parts[0] === TESTS;
}

/** Whether a path under tests/ is in a folder a test run writes its reports into (TEST_OUTPUT). The folder's own path included. */
function testOutput(parts: readonly string[]): boolean {
  return parts[0] === TESTS && parts.some((p, i) => i > 0 && TEST_OUTPUT.has(fold(p)));
}

/**
 * Whether a folder at `rel` can hold a file a snapshot takes, so the walk looks inside it: anywhere in src/, static/
 * and tests/ (but a test run's reports), only the canonical documents' folders in siteorigin/ (and the sources' own, for their attachments), and
 * nothing deeper in scripts/.
 */
function folderKept(rel: string): boolean {
  if (unsafePath(rel)) return false;
  const parts = rel.split('/');
  if (!ROOT_FOLDERS.has(parts[0]) || !parts.every((p, i) => !partExcluded(p, i)) || testOutput(parts)) return false;
  if (parts[0] === 'scripts') return parts.length === 1;
  if (parts[0] !== 'siteorigin') return true;
  const [, kind, , sub] = parts;
  if (parts.length <= 1) return true;
  if (parts.length === 2) return ['pages', 'components', 'collections'].includes(kind) || fold(kind) === 'sources';
  if (parts.length === 3) return kind === 'components' || kind === 'collections' || fold(kind) === 'sources';
  return parts.length === 4 && kind === 'collections' && sub === 'entries';
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
 * a link), could not be read (`unreadable`), has a `name` some computers cannot use (one they cannot tell from another
 * file's or folder's, or one that is not valid text), or is larger than a snapshot holds (`too-large`,
 * MAX_SNAPSHOT_FILE). `path` is the file's project path.
 */
export class SnapshotCaptureError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'changed' | 'unreadable' | 'name' | 'too-large',
    message: string
  ) {
    super(message);
    this.name = 'SnapshotCaptureError';
  }
}

/**
 * The largest file a snapshot holds: what one buffer read whole can hold everywhere (Node reads no more into one), as
 * Git's own tools hold each file. A larger one fails the capture rather than be left out or held in memory whole.
 */
export const MAX_SNAPSHOT_FILE = 2 ** 31 - 1;

const changed = (rel: string) => new SnapshotCaptureError(rel, 'changed', `${rel || 'The project folder'} changed while the project was being read. Try again once nothing is changing it.`);
const unreadable = (rel: string, e: unknown) => new SnapshotCaptureError(rel, 'unreadable', `${rel || 'The project folder'} could not be read: ${(e as Error)?.message ?? e}`);
const badName = (rel: string, why: string) => new SnapshotCaptureError(rel, 'name', `${rel} ${why}. Rename it, then try again.`);
/** A SnapshotCaptureError as it is; anything else thrown reading `rel`, as its being unreadable. */
const asCaptureError = (rel: string, e: unknown) => (e instanceof SnapshotCaptureError ? e : unreadable(rel, e));

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

/**
 * Every folder the walk looks in and every file a snapshot takes in `root`, by project path ('' is the project folder).
 * `capture`: a file too large for a snapshot, or one whose name is not valid text, fails the listing; otherwise the
 * first is listed and the second left out, for a listing that only compares (listSnapshotFiles).
 */
async function listProject(root: string, settleMs: number, capture = true): Promise<Map<string, Listed>> {
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
    let raw: Buffer[];
    try {
      raw = await fs.readdir(abs, { encoding: 'buffer' });
    } catch (e) {
      // A folder listed a moment ago that is gone, or is no folder now, has changed.
      if (isMissing(e)) throw changed(rel);
      throw unreadable(rel, e);
    }
    const names = raw.map((b) => ({ name: b.toString('utf8'), raw: b })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // A folder with a `.git` of its own (a submodule, a nested checkout) is another repository's work: none of it is
    // read. The marker itself is never opened. The project's own `.git`, at its top, leaves the project as it is.
    if (rel && names.some(({ name }) => fold(name) === '.git')) return;
    // Nor a bare repository's folder (a clone kept as Git keeps one): its objects hold whatever it ever held.
    const kind = async (n: string) => (await fs.lstat(join(abs, n)).catch(() => null))?.isDirectory();
    const head = async () => /^(ref: refs\/|[0-9a-f]{40})/.test(await fs.readFile(join(abs, 'HEAD'), 'utf8').catch(() => ''));
    if (rel && names.some(({ name }) => name === 'HEAD') && (await kind('objects')) && (await kind('refs')) && (await head())) return;
    for (const { name, raw: bytes } of names) {
      const r = rel ? `${rel}/${name}` : name;
      const place = snapshotPlace(r);
      const descend = folderKept(r);
      if (place.kind === 'excluded' && !descend) continue;
      // A name that is not valid text can only be looked up by another (decoded) name: a file or folder by it would be
      // missed, so it is refused (a link by it is left out like any link, by its type).
      const a = join(abs, name);
      const valid = Buffer.from(name, 'utf8').equals(bytes);
      if (!valid) {
        const st = await fs.lstat(Buffer.concat([Buffer.from(`${abs}${sep}`), bytes])).catch((e: unknown) => {
          // Gone since the folder was read, it is no part of the project; anything else can't be told to be a link.
          if (isMissing(e)) return null;
          throw unreadable(r, e);
        });
        if (capture && st && (st.isFile() || st.isDirectory())) throw badName(r, 'has a name that is not valid text');
        continue;
      }
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
      } else if (st.isFile() && place.kind !== 'excluded') {
        if (capture && st.size > BigInt(MAX_SNAPSHOT_FILE)) throw new SnapshotCaptureError(r, 'too-large', `${r} is larger than a saved version can hold (2 GB). Move it out of the project, then try again.`);
        record(r, a, st, place);
      }
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
    throw asCaptureError(l.rel, e);
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
    throw asCaptureError(l.rel, e);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Git's name for the listed file's bytes (`blob <size>\0` and the bytes, by SHA-1), read through one checked handle. */
async function blobOidListed(l: Listed): Promise<string> {
  const { handle, stamp } = await openListed(l);
  try {
    const hash = createHash('sha1').update(`blob ${l.size}\0`);
    const chunk = Buffer.allocUnsafe(1 << 20);
    let total = 0n;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += BigInt(bytesRead);
    }
    if (total !== l.size || stampOf(await handle.stat({ bigint: true })) !== stamp) throw changed(l.rel);
    return hash.digest('hex');
  } catch (e) {
    throw asCaptureError(l.rel, e);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A file a snapshot of the project would hold now, listed but not read (listSnapshotFiles). */
export interface ListedSnapshotFile {
  /** Relative to the project, with forward slashes, as the disk spells it. */
  path: string;
  executable: boolean;
  /** Its size in bytes, as listed: one past MAX_SNAPSHOT_FILE is no file a snapshot holds. */
  size: number;
  /** Git's name for its bytes, read through a handle checked to reach the file listed: a SnapshotCaptureError says it changed since. */
  blobOid(): Promise<string>;
}

/**
 * The files a snapshot of the project in `root` would hold in its tree now, chosen as a capture chooses them (never
 * through a link, nor into another repository), none of them read: for a comparison with a saved snapshot that reads
 * only the files it has to (#1396). A file no snapshot could take (too large, or a name that is not valid text) stops
 * a capture but not this: the first is listed, the second can't be named and is left out. Throws a SnapshotCaptureError
 * when the project changes while it is listed.
 */
export async function listSnapshotFiles(root: string): Promise<ListedSnapshotFile[]> {
  const listed = await listProject(root, 0, false);
  return [...listed.values()].filter((l) => !l.dir && l.place.kind === 'tree').map((l) => ({ path: l.rel, executable: l.executable, size: Number(l.size), blobOid: () => blobOidListed(l) }));
}

/** The listed file's bytes, read through a checked handle, as long as they are still the ones captured. */
async function readCaptured(l: Listed, captured: { sha256: string; stamp: string }): Promise<Buffer> {
  const { handle, stamp } = await openListed(l);
  try {
    if (stamp !== captured.stamp) throw changed(l.rel);
    // A piece at a time into one buffer: readFile refuses a file past 2 GiB, which a video in the library can be.
    const bytes = Buffer.allocUnsafe(Number(l.size));
    for (let n = 0; n < bytes.length; ) {
      const { bytesRead } = await handle.read(bytes, n, Math.min(bytes.length - n, 1 << 24), n);
      if (!bytesRead) throw changed(l.rel);
      n += bytesRead;
    }
    if (stampOf(await handle.stat({ bigint: true })) !== stamp || createHash('sha256').update(bytes).digest('hex') !== captured.sha256) throw changed(l.rel);
    return bytes;
  } catch (e) {
    throw asCaptureError(l.rel, e);
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

/**
 * Two paths of `paths` (files) that no case-insensitive or accent-insensitive disk could hold both of, or null: two
 * files whose names it takes for one, or a file whose name it takes for a folder another file is in.
 */
export function nameClash(paths: readonly string[]): [string, string] | null {
  const key = (p: string) => p.split('/').map(foldName).join('/');
  const files = new Map<string, string>();
  for (const p of paths) {
    const k = key(p);
    const other = files.get(k);
    if (other !== undefined) return [other, p];
    files.set(k, p);
  }
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const file = files.get(key(folder));
      if (file !== undefined) return [file, p];
    }
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
 * once the files are listed and once they are hashed, before the check that nothing changed (for tests). `stop` is
 * asked before each file is hashed (or hashed again): true ends the capture with an error.
 */
export async function captureSnapshotInventory(root: string, opts: { settleMs?: number; paused?: (at: 'listed' | 'hashed') => Promise<void> | void; stop?: () => boolean } = {}): Promise<SnapshotInventory> {
  const settleMs = opts.settleMs ?? 3000;
  const before = await listProject(root, settleMs);
  const files = [...before.values()].filter((l) => !l.dir);
  const clash = nameClash(files.map((l) => l.rel));
  if (clash) throw badName(clash[1], `and ${clash[0]} have names some computers cannot tell apart`);
  await opts.paused?.('listed');
  const hashed = await settledBatches(files, (l) => (opts.stop?.() ? Promise.reject(new Error('The snapshot was stopped.')) : hashListed(l)));
  await opts.paused?.('hashed');
  // A file whose stamp cannot stand for its bytes could have changed without it: it is hashed again. Before the last
  // listing, so that one also sees what was added, removed or swapped while these were read.
  await settledBatches(
    files.map((l, i) => ({ l, i })).filter(({ l }) => !l.trusted),
    async ({ l, i }) => {
      if (opts.stop?.()) throw new Error('The snapshot was stopped.');
      if ((await hashListed(l)).sha256 !== hashed[i].sha256) throw changed(l.rel);
    }
  );
  const after = await listProject(root, settleMs);
  const moved = firstChange(before, after);
  if (moved !== null) throw changed(moved);
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
