/**
 * Opening a ZIP file someone sent (#263): an editable project exported as a ZIP file (see zip.ts), or a project folder
 * zipped with the computer's own Compress command. The archive is untrusted, so nothing in it decides where a file
 * lands: every name is checked before anything is written, and only regular files and folders are written (never
 * links). Standard ZIP files only (no ZIP64, no encryption), stored or deflated, which is what Builder and the systems'
 * own tools write.
 *
 * Nothing here depends on Electron, so it is unit tested directly.
 */
import { promises as fs } from 'node:fs';
import { createWriteStream, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 } from 'node:zlib';
import { replaceEmptyFolder } from './export';
import { foldName } from './project/snapshot-inventory';
import { isCredentialFile } from './project/private-files';

const END_RECORD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** Info-ZIP's extra field holding a UTF-8 name beside a legacy one. */
const UNICODE_PATH = 0x7075;

/** At most this many entries, and this many bytes once extracted: a project is far smaller, a ZIP bomb is not. */
export const MAX_ENTRIES = 20_000;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
/** The project manifest is read before anything is extracted, so it is held to a small size. */
const MAX_MANIFEST_BYTES = 1024 ** 2;
/** The archive's list of files is read whole, so it is held to what MAX_ENTRIES entries plausibly need. */
const MAX_DIRECTORY_BYTES = 16 * 1024 ** 2;
/** A path's length: no file a computer can hold is longer (and so none is nested deeper than half of it). */
const MAX_PATH_LENGTH = 4096;
/** How many numbered folder names (cafe-2, cafe-3, …) are tried before giving up. */
const MAX_NAMES = 1000;

export const MANIFEST = 'siteorigin.project.json';

/** A ZIP file that cannot be opened as it is, with a message that says why in words the author can act on. */
export class ZipError extends Error {}

export interface ZipEntry {
  /** The entry's path in the archive, with forward slashes, checked to stay inside the folder it is extracted to. */
  path: string;
  directory: boolean;
  /** A symbolic link or other special file: listed, never extracted. */
  special: boolean;
  executable: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Where the next entry (or the list of entries) starts: this entry's data must end before it. */
  dataLimit: number;
}

/** What an archive holds, as far as opening it goes. */
export type ZipContents =
  /** An editable project; `root` is the folder in the archive that holds siteorigin.project.json ('' or 'name/'). */
  | { kind: 'project'; root: string; entries: ZipEntry[] }
  /** A finished website (index.html and _app/, no project documents): what visitors see, not something to edit. */
  | { kind: 'website' }
  | { kind: 'other' };

const DAMAGED = 'That ZIP file is damaged or incomplete, so it was not opened. Download or copy it again, then try again.';
const EXTRACT_ELSEWHERE = 'Extract it with your computer’s own tools, then open the project folder.';
const damagedFile = (name: string) => new ZipError(`${name} in that ZIP file is damaged, so it was not opened. Download or copy the ZIP file again, then try again.`);

export const WEBSITE_ZIP =
  'That ZIP file holds the finished website for visitors, which SiteOrigin Builder cannot edit. Ask whoever sent it for the editable version: in SiteOrigin Builder they choose Export, then Editable project, saved as a ZIP file.';
export const NOT_A_PROJECT_ZIP = `That ZIP file does not hold a SiteOrigin Builder project. Choose an editable project ZIP file, with ${MANIFEST} at its top level or inside its one folder.`;

/** Files the systems' own Compress commands add, which are never part of the project. */
function isSystemClutter(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  return parts[0] === '__MACOSX' || name === '.DS_Store' || name.startsWith('._') || name === 'Thumbs.db' || name === 'desktop.ini';
}

/** Names Windows gives another meaning: devices (COM¹ too), whatever their extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A ZIP entry's name as a safe relative path, or a ZipError. In archives made on Windows (`dosSeparators`) a backslash
 * is a folder separator. Elsewhere it is part of a name: kept as it is on macOS and Linux, and refused on Windows,
 * which would read it as a folder. Absolute paths, drive letters, `..`, control characters, empty, overlong or deeply
 * nested names, and names Windows would read as something else are refused too. The spelling is kept as it is
 * (decomposed accents stay decomposed).
 */
export function safeEntryPath(raw: string, dosSeparators = false, windows = process.platform === 'win32'): string {
  const quoted = JSON.stringify(raw.slice(0, 120));
  const outside = () => new ZipError(`That ZIP file contains a file that would be saved outside its folder (${quoted}), so it was not opened.`);
  const unusable = () => new ZipError(`That ZIP file contains a file name that cannot be used safely on this computer (${quoted}), so it was not opened.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > MAX_PATH_LENGTH) throw unusable();
  if (raw.includes('\\') && !dosSeparators && windows) throw unusable();
  const name = dosSeparators ? raw.replace(/\\/g, '/') : raw;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw outside();
  // A directory entry ends with a slash, and a doubled slash or a `.` changes nothing: those parts are dropped.
  const kept = name.split('/').filter((p) => p !== '' && p !== '.');
  if (kept.some((p) => p === '..')) throw outside();
  if (!kept.length) throw unusable();
  if (kept.some((p) => p.includes(':') || WINDOWS_RESERVED.test(p) || /[. ]$/.test(p))) throw unusable();
  return kept.join('/');
}

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipError(DAMAGED);
  return buf;
}

/** The upper half of code page 437, which a ZIP entry's name is in unless it says it is UTF-8. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/**
 * Decode a name: UTF-8 when the entry says so (Builder, Finder, 7-Zip) or carries a matching Info-ZIP Unicode name,
 * otherwise code page 437 (older Windows tools).
 */
export function decodeName(raw: Buffer, utf8: boolean, extra: Buffer = Buffer.alloc(0)): string {
  if (utf8) return raw.toString('utf8');
  // The Unicode name wins over the legacy one, even a plain ASCII stand-in such as "cafe.png" for "café.png". Only
  // the first such field counts, so a name is checked against at most one.
  for (let i = 0; i + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(i);
    const length = extra.readUInt16LE(i + 2);
    if (i + 4 + length > extra.length) break;
    if (id === UNICODE_PATH) {
      // Version 1, then the CRC-32 of the legacy name it stands for, then the name in UTF-8.
      if (length >= 5 && extra[i + 4] === 1 && extra.readUInt32LE(i + 5) === crc32(raw) >>> 0) return extra.toString('utf8', i + 9, i + 4 + length);
      break;
    }
    i += 4 + length;
  }
  return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join('');
}

/**
 * Where the end record is in `tail` (the end of a file of `size` bytes): the last one whose comment runs exactly to
 * the end of the file and whose list of files ends right where it starts, so one quoted in a comment is passed over.
 */
function findEndRecord(tail: Buffer, size: number): number {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== END_RECORD || i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue;
    if (tail.readUInt32LE(i + 16) + tail.readUInt32LE(i + 12) === size - tail.length + i) return i;
  }
  return -1;
}

/** A folder (or file) in the archive's tree, keyed by each name as a case-insensitive disk would compare it. */
interface TreeNode {
  kind: 'file' | 'dir';
  children?: Map<string, TreeNode>;
}

/** The archive's folders as spelled, which is what a case-sensitive disk makes. */
type Spelled = Map<string, Spelled>;

/** List a ZIP file's entries from its central directory, checking every name and limit before anything is written. */
export async function readZipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError(DAMAGED);
    // The end record is the last 22 bytes, followed by a comment of at most 64 KB.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLength, tailLength);
    const end = findEndRecord(tail, size);
    if (end < 0) throw new ZipError(DAMAGED);
    const disk = tail.readUInt16LE(end + 4);
    const cdDisk = tail.readUInt16LE(end + 6);
    const count = tail.readUInt16LE(end + 10);
    const cdSize = tail.readUInt32LE(end + 12);
    const cdOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError(`That ZIP file is too large to open here. ${EXTRACT_ELSEWHERE}`);
    if (disk !== 0 || cdDisk !== 0) throw new ZipError(`That ZIP file is split into several parts. ${EXTRACT_ELSEWHERE}`);
    if (count > MAX_ENTRIES || cdSize > MAX_DIRECTORY_BYTES) throw new ZipError('That ZIP file holds more files than a project can, so it was not opened.');
    if (cdOffset + cdSize > size) throw new ZipError(DAMAGED);
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    // Every path, folders included, as a tree of names a case-insensitive disk would compare: each name is held once,
    // so a hostile list of long, deep paths costs no more than its own size.
    const tree: TreeNode = { kind: 'dir', children: new Map() };
    const spelledTree: Spelled = new Map();
    let folders = 0;
    let total = 0;
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_HEADER) throw new ZipError(DAMAGED);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const entrySize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLength + extraLength + commentLength > cd.length) throw new ZipError(DAMAGED);
      const rawName = cd.subarray(p + 46, p + 46 + nameLength);
      const raw = decodeName(rawName, (flags & 0x800) !== 0, cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength));
      p += 46 + nameLength + extraLength + commentLength;
      // Unix (3) and macOS (19) archives keep file types in the top 16 bits of the external attributes; MS-DOS (0),
      // NTFS (10) and VFAT (14) archives use backslashes as folder separators.
      const unix = madeBy === 3 || madeBy === 19;
      const dos = madeBy === 0 || madeBy === 10 || madeBy === 14;
      const path = safeEntryPath(raw, dos);
      // A trailing backslash marks a folder only where backslashes are separators; elsewhere it ends a file's name.
      const directory = raw.endsWith('/') || (dos && raw.endsWith('\\'));
      const unixMode = unix ? external >>> 16 : 0;
      const type = unixMode & 0o170000;
      const special = type !== 0 && type !== 0o100000 && !(directory && type === 0o040000);
      if (flags & 0x41) throw new ZipError(`That ZIP file is password-protected. ${EXTRACT_ELSEWHERE}`);
      if (!directory && !special && method !== 0 && method !== 8) throw new ZipError(`That ZIP file uses a kind of compression SiteOrigin Builder cannot read. ${EXTRACT_ELSEWHERE}`);
      if (compressedSize === 0xffffffff || entrySize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError(`That ZIP file is too large to open here. ${EXTRACT_ELSEWHERE}`);
      if (method === 0 && compressedSize !== entrySize) throw new ZipError(DAMAGED);
      if (localOffset + 30 + compressedSize > cdOffset) throw new ZipError(DAMAGED);
      if (!directory) {
        total += entrySize;
        if (total > MAX_TOTAL_BYTES) throw new ZipError(`That ZIP file would take more than ${MAX_TOTAL_BYTES / 1024 ** 3} GB once extracted, so it was not opened. ${EXTRACT_ELSEWHERE}`);
      }
      const parts = path.split('/');
      // Every folder a path implies counts, as spelled, so empty folders cannot multiply unseen on any disk.
      let at = spelledTree;
      for (const part of directory ? parts : parts.slice(0, -1)) {
        let next = at.get(part);
        if (!next) {
          if (++folders > MAX_ENTRIES) throw new ZipError('That ZIP file holds more folders than a project can, so it was not opened.');
          at.set(part, (next = new Map()));
        }
        at = next;
      }
      // Two names one folder cannot tell apart (different case or accents, a file where a folder must go) would
      // overwrite each other.
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const kind = i < parts.length - 1 || directory ? 'dir' : 'file';
        const key = parts[i].normalize('NFC').toLowerCase();
        const before = node.children!.get(key);
        const where = () => JSON.stringify(parts.slice(0, i + 1).join('/').slice(0, 120));
        if (before && before.kind !== kind) throw new ZipError(`That ZIP file contains ${where()} both as a file and as a folder, so it was not opened.`);
        if (before?.kind === 'file') throw new ZipError(`That ZIP file contains two files named ${where()} (perhaps with different capital letters or accents), so it was not opened.`);
        if (before) {
          node = before;
          continue;
        }
        const added: TreeNode = kind === 'dir' ? { kind, children: new Map() } : { kind };
        node.children!.set(key, added);
        node = added;
      }
      entries.push({ path, directory, special, executable: (unixMode & 0o111) !== 0, method, crc, compressedSize, size: entrySize, localOffset, dataLimit: cdOffset });
    }
    // Each entry's data must end before the next entry starts: entries that share their bytes are refused when read.
    const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    for (let i = 0; i + 1 < byOffset.length; i++) byOffset[i].dataLimit = byOffset[i + 1].localOffset;
    return entries;
  } finally {
    await fh.close();
  }
}

/**
 * Say what an archive holds. An editable project has siteorigin.project.json at its top level, or inside the one
 * folder everything else is in (Builder's own export, or a project folder zipped by the computer). A website export
 * has index.html and SvelteKit's _app/ folder in the same place, and no manifest.
 */
export function classifyZip(entries: ZipEntry[]): ZipContents {
  // Another project's state at the archive's top (a repository beside the project's folder) or anywhere in it says
  // nothing about what the archive holds, and is never extracted.
  const listed = entries.filter((e) => !e.special && !isSystemClutter(e.path) && !isLocalState(e.path));
  const tops = new Set(listed.map((e) => e.path.split('/')[0]));
  // The archive's one folder, if everything in it is in one folder.
  const top = tops.size === 1 ? [...tops][0] : null;
  const wrapper = top !== null && !listed.some((e) => !e.directory && e.path === top) ? `${top}/` : null;
  // Nor does that folder's own: its local state holds no project or website of the archive's.
  const kept = wrapper === null ? listed : listed.filter((e) => !isLocalState(e.path.slice(wrapper.length)));
  const files = kept.filter((e) => !e.directory);
  const has = (path: string) => files.some((e) => e.path === path);
  const roots = wrapper === null ? [''] : ['', wrapper];
  for (const root of roots) {
    if (has(`${root}${MANIFEST}`)) return { kind: 'project', root, entries: kept.filter((e) => e.path.startsWith(root)) };
  }
  if (files.some((e) => e.path.endsWith(`/${MANIFEST}`))) return { kind: 'other' };
  for (const root of roots) {
    if (has(`${root}index.html`) && files.some((e) => e.path.startsWith(`${root}_app/`))) return { kind: 'website' };
  }
  return { kind: 'other' };
}

/** Counts bytes and the CRC-32 of what passes through, refusing more than the entry says it holds. */
function checked(e: ZipEntry, name: string) {
  const state = { bytes: 0, crc: 0 };
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      state.bytes += chunk.length;
      if (state.bytes > e.size) return done(damagedFile(name));
      state.crc = crc32(chunk, state.crc);
      done(null, chunk);
    }
  });
  const verify = () => {
    if (state.bytes !== e.size || state.crc >>> 0 !== e.crc) throw damagedFile(name);
  };
  return { stream, verify };
}

/** The bytes from `start`, read from the archive's own handle (never reopened by name) in pieces. */
async function* readRange(fh: fs.FileHandle, start: number, length: number) {
  for (let position = start, left = length; left > 0; ) {
    const buf = Buffer.alloc(Math.min(left, 256 * 1024));
    const { bytesRead } = await fh.read(buf, 0, buf.length, position);
    if (!bytesRead) throw new ZipError(DAMAGED);
    yield buf.subarray(0, bytesRead);
    position += bytesRead;
    left -= bytesRead;
  }
}

/**
 * Send one entry's contents, decompressed and checked, to the stream `open` makes. The stream is made only once the
 * entry's header has been checked, and handed straight to the pipeline, so a file that cannot be made is an error
 * the caller sees rather than one nobody hears.
 */
async function copyEntry(fh: fs.FileHandle, e: ZipEntry, name: string, open: () => Writable, signal?: AbortSignal) {
  const local = await readAt(fh, e.localOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipError(DAMAGED);
  const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + e.compressedSize > e.dataLimit) throw new ZipError(DAMAGED);
  signal?.throwIfAborted();
  const source = Readable.from(readRange(fh, start, e.compressedSize));
  const check = checked(e, name);
  try {
    if (e.method === 8) await pipeline(source, createInflateRaw(), check.stream, open(), { signal });
    else await pipeline(source, check.stream, open(), { signal });
  } catch (err) {
    if (/^Z_/.test((err as NodeJS.ErrnoException).code ?? '')) throw damagedFile(name);
    throw err;
  }
  check.verify();
}

/** One file from the archive, as text: for the project manifest, read before anything is extracted. */
export async function readEntryText(file: string, e: ZipEntry, limit = MAX_MANIFEST_BYTES): Promise<string> {
  if (e.size > limit) throw damagedFile(e.path.split('/').pop()!);
  const fh = await fs.open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const collect = () =>
      new Writable({
        write(chunk: Buffer, _enc, done) {
          chunks.push(chunk);
          done();
        }
      });
    await copyEntry(fh, e, e.path.split('/').pop()!, collect);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Another project's own state, by its path under the project's folder in the archive (#1151): a Git folder or worktree
 * file (`.git`) anywhere in it, which carries that repository's history and remotes, and the project's local state
 * (`.siteorigin/`: its undo history, saved versions and their repositories, locks and remote bindings). Never written:
 * a project opened from a ZIP file starts clean, with no history or remote of anyone else's. Compared as a
 * case-insensitive disk compares names (foldName): `.GIT` is the same folder, and so, to APFS, is `.ſiteorigin`.
 */
export function isLocalState(rel: string): boolean {
  const parts = rel.split('/').map(foldName);
  return parts[0] === '.siteorigin' || parts.includes('.git');
}

/**
 * Whether an entry is a copy of one of the app's own credential files (`remote-credentials.json`, `api-keys (1).json`),
 * by its name, anywhere in the archive (#1157): a ZIP file the app makes never holds one, and one put together
 * elsewhere does not bring someone's tokens into a project.
 */
const isCredentialCopy = (rel: string) => isCredentialFile(rel.slice(rel.lastIndexOf('/') + 1));

/** Whether an entry under `root` is one extraction writes (a folder or a file), rather than one it passes over. */
const extracted = (e: ZipEntry, root: string) =>
  !e.special &&
  !isSystemClutter(e.path) &&
  e.path.startsWith(root) &&
  e.path.length > root.length &&
  !isLocalState(e.path) &&
  !isLocalState(e.path.slice(root.length)) &&
  !(!e.directory && isCredentialCopy(e.path));

/** How many files extracting `entries` under `root` writes, so the count of those written can be shown against it. */
export const filesToWrite = (entries: ZipEntry[], root: string) => entries.filter((e) => !e.directory && extracted(e, root)).length;

/**
 * Write the files and folders under `root` in the archive into the folder `dest` (which must exist and be empty),
 * without `root` itself. Links and the systems' clutter are left out. Every file's size and CRC-32 are checked; a file
 * that fails, or a signal that aborts, stops the extraction with what was written left for the caller to remove.
 * `onFile` hears the count of files written after each one.
 */
export async function extractEntries(file: string, entries: ZipEntry[], root: string, dest: string, signal?: AbortSignal, onFile?: (written: number) => void): Promise<number> {
  const fh = await fs.open(file, 'r');
  let written = 0;
  try {
    for (const e of entries) {
      signal?.throwIfAborted();
      if (!extracted(e, root)) continue;
      const rel = e.path.slice(root.length);
      const target = join(dest, ...rel.split('/'));
      if (e.directory) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(dirname(target), { recursive: true });
      await copyEntry(fh, e, rel, () => createWriteStream(target, { flags: 'wx', mode: e.executable ? 0o755 : 0o644 }), signal);
      written++;
      onFile?.(written);
    }
    signal?.throwIfAborted();
    return written;
  } finally {
    await fh.close();
  }
}

/** A project ZIP file's contents and the project's name, read without extracting anything. */
export async function readProjectZip(file: string): Promise<{ kind: 'project'; name: string; root: string; entries: ZipEntry[] } | { kind: 'website' | 'other' }> {
  const contents = classifyZip(await readZipEntries(file));
  if (contents.kind !== 'project') return contents;
  const manifest = contents.entries.find((e) => e.path === `${contents.root}${MANIFEST}`)!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readEntryText(file, manifest));
  } catch (e) {
    if (e instanceof ZipError) throw e;
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ZipError(`${MANIFEST} in that ZIP file is incomplete or damaged, so it was not opened. Ask for the ZIP file again.`);
  const name = (parsed as { name?: unknown }).name;
  return { ...contents, name: typeof name === 'string' && name.trim() ? name.trim() : '' };
}

/**
 * Remove the empty folder claimed at `dest`, trying again while Windows holds it for a moment. Only an empty folder
 * is ever removed: one someone else has put files in stays. One that cannot be removed is named.
 */
async function removeClaim(dest: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rmdir(dest);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EEXIST') return;
      if (attempt >= 5) throw new ZipError(`The empty folder "${dest}" could not be removed. Delete it yourself.`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Is something at `path` now (a folder, a file, a link)? */
async function occupied(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false
  );
}

/** The folder name an unpacked project is given: a name Windows reserves for a device (a project called "Con") gets a suffix. */
const folderBase = (name: string) => (WINDOWS_RESERVED.test(name) ? `${name}-site` : name);

/**
 * The folder `unpackProject` would make for `name` in `parent` as things stand: the name, or the first numbered one
 * that is free. Another folder can still take it before the project is in place, and then the next one is used.
 */
export function expectedFolder(parent: string, name: string): string {
  const base = folderBase(name);
  for (let i = 1; i <= MAX_NAMES; i++) {
    const folder = i === 1 ? base : `${base}-${i}`;
    // Anything by that name counts, a link to nothing included, as it does when the folder is claimed.
    if (!lstatSync(join(parent, folder), { throwIfNoEntry: false })) return folder;
  }
  return base;
}

/**
 * Extract the project in `file` into a new folder in `parent`, named `name` (or `name-2`, `name-3`, … when that is
 * taken), and return its path. The files go to a private folder beside it first; the name is claimed only once every
 * file is written and checked, so a folder that is there already, or appears meanwhile, is never written into or
 * replaced. `beforePublish` runs once the empty folder is claimed, before the project appears in it. Aborting `signal`
 * any time before the final move removes everything written; the ZIP file itself is only read.
 */
export async function unpackProject(
  file: string,
  project: { root: string; entries: ZipEntry[] },
  parent: string,
  name: string,
  opts: { signal?: AbortSignal; beforePublish?: (dir: string) => Promise<void>; onProgress?: (done: number, total: number) => void } = {}
): Promise<string> {
  const { signal, beforePublish, onProgress } = opts;
  const total = filesToWrite(project.entries, project.root);
  const base = folderBase(name);
  const tmp = await fs.mkdtemp(join(parent, '.siteorigin-open-'));
  try {
    await extractEntries(file, project.entries, project.root, tmp, signal, onProgress && ((done) => onProgress(done, total)));
    for (let i = 1; i <= MAX_NAMES; i++) {
      signal?.throwIfAborted();
      const dest = join(parent, i === 1 ? base : `${base}-${i}`);
      try {
        await fs.mkdir(dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      try {
        await beforePublish?.(dest);
        // The last chance to call it off is just before the move (after Windows lets go of the claim): from the move
        // on, the project is in place.
        await replaceEmptyFolder(tmp, dest, () => signal?.throwIfAborted());
        return dest;
      } catch (e) {
        // Someone else's files arrived in the claimed folder: they stay, and the next name is tried. A move that failed
        // with the name still free (Windows reports a file held open in the private folder as EPERM) is no collision.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST' && (await occupied(dest))) continue;
        await removeClaim(dest);
        throw e;
      }
    }
    throw new ZipError(`There is no free folder name for ${base} in ${parent}. Choose another folder.`);
  } catch (e) {
    // A file a virus scanner holds for a moment (Windows) is tried again before the private folder is given up on.
    const removed = await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).then(
      () => true,
      () => false
    );
    if (!removed) throw new ZipError(`Some unpacked files could not be removed. Delete the folder "${tmp}" yourself.`);
    throw e;
  }
}
