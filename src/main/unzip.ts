/**
 * Opening a ZIP file someone sent (#263): an editable project exported as a ZIP file (see zip.ts), or a project folder
 * zipped with the computer's own Compress command. The archive is untrusted, so nothing in it decides where a file
 * lands: every name is checked before anything is written, and only regular files are written (never links). Standard
 * ZIP files only (no ZIP64, no encryption), stored or deflated, which is what Builder and the systems' own tools write.
 *
 * Nothing here depends on Electron, so it is unit tested directly.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 } from 'node:zlib';
import { replaceEmptyFolder } from './export';

const END_RECORD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** At most this many entries, and this many bytes once extracted: a project is far smaller, a ZIP bomb is not. */
export const MAX_ENTRIES = 20_000;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
/** The project manifest is read before anything is extracted, so it is held to a small size. */
const MAX_MANIFEST_BYTES = 1024 ** 2;
/** The archive's list of files is read whole, so it is held to what MAX_ENTRIES entries plausibly need. */
const MAX_DIRECTORY_BYTES = 16 * 1024 ** 2;

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

/** Names Windows gives another meaning: devices, alternate streams, and names it would trim to another. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A ZIP entry's name as a safe relative path, or a ZipError. Backslashes (written by some Windows tools) count as
 * folder separators; absolute paths, drive letters, `..`, control characters, empty names and names Windows would
 * read as something else are refused.
 */
export function safeEntryPath(raw: string): string {
  const quoted = JSON.stringify(raw.slice(0, 120));
  const outside = () => new ZipError(`That ZIP file contains a file that would be saved outside its folder (${quoted}), so it was not opened.`);
  const unusable = () => new ZipError(`That ZIP file contains a file name that cannot be used safely on this computer (${quoted}), so it was not opened.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw unusable();
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw outside();
  // A directory entry ends with a slash, and a doubled slash or a `.` changes nothing: those parts are dropped.
  const kept = name.split('/').filter((p) => p !== '' && p !== '.');
  if (kept.some((p) => p === '..')) throw outside();
  if (!kept.length) throw unusable();
  if (kept.some((p) => p.includes(':') || WINDOWS_RESERVED.test(p) || /[. ]$/.test(p))) throw unusable();
  return kept.join('/').normalize('NFC');
}

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipError(DAMAGED);
  return buf;
}

/** The upper half of code page 437, which a ZIP entry's name is in unless it says it is UTF-8. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/** Decode a name: UTF-8 when the entry says so (Builder, Finder, 7-Zip), otherwise code page 437 (older Windows tools). */
export function decodeName(raw: Buffer, utf8: boolean): string {
  if (utf8 || raw.every((b) => b < 0x80)) return raw.toString('utf8');
  return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join('');
}

/** List a ZIP file's entries from its central directory, checking every name and limit before anything is written. */
export async function readZipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError(DAMAGED);
    // The end record is the last 22 bytes, followed by a comment of at most 64 KB.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLength, tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_RECORD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new ZipError(DAMAGED);
    const disk = tail.readUInt16LE(end + 4);
    const cdDisk = tail.readUInt16LE(end + 6);
    const count = tail.readUInt16LE(end + 10);
    const cdSize = tail.readUInt32LE(end + 12);
    const cdOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError(`That ZIP file is too large to open here. ${EXTRACT_ELSEWHERE}`);
    if (disk !== 0 || cdDisk !== 0) throw new ZipError(`That ZIP file is split into several parts. ${EXTRACT_ELSEWHERE}`);
    if (count > MAX_ENTRIES) throw new ZipError(`That ZIP file holds more files than a project can (${count}), so it was not opened.`);
    if (cdOffset + cdSize > size) throw new ZipError(DAMAGED);
    if (cdSize > MAX_DIRECTORY_BYTES) throw new ZipError('That ZIP file holds more files than a project can, so it was not opened.');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    // Every path, folders included, as a folder on a case-insensitive disk would see it.
    const seen = new Map<string, 'file' | 'dir'>();
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
      const raw = decodeName(cd.subarray(p + 46, p + 46 + nameLength), (flags & 0x800) !== 0);
      p += 46 + nameLength + extraLength + commentLength;
      const path = safeEntryPath(raw);
      const directory = /[\\/]$/.test(raw);
      // Unix file types live in the top 16 bits of the external attributes, for archives made on Unix or macOS.
      const unixMode = madeBy === 3 ? external >>> 16 : 0;
      const type = unixMode & 0o170000;
      const special = !directory && type !== 0 && type !== 0o100000;
      if (flags & 0x41) throw new ZipError(`That ZIP file is password-protected. ${EXTRACT_ELSEWHERE}`);
      if (!directory && !special && method !== 0 && method !== 8) throw new ZipError(`That ZIP file uses a kind of compression SiteOrigin Builder cannot read. ${EXTRACT_ELSEWHERE}`);
      if (compressedSize === 0xffffffff || entrySize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError(`That ZIP file is too large to open here. ${EXTRACT_ELSEWHERE}`);
      if (method === 0 && compressedSize !== entrySize) throw new ZipError(DAMAGED);
      if (localOffset + 30 + compressedSize > cdOffset) throw new ZipError(DAMAGED);
      if (!directory) {
        total += entrySize;
        if (total > MAX_TOTAL_BYTES) throw new ZipError(`That ZIP file would take more than ${MAX_TOTAL_BYTES / 1024 ** 3} GB once extracted, so it was not opened. ${EXTRACT_ELSEWHERE}`);
      }
      // Two names one folder cannot tell apart (different case, or a file where a folder must go) would overwrite each other.
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/');
        const kind = i < parts.length || directory ? 'dir' : 'file';
        const before = seen.get(sub.toLowerCase());
        if (before === 'file' && kind === 'dir') throw new ZipError(`That ZIP file contains ${JSON.stringify(sub.slice(0, 120))} both as a file and as a folder, so it was not opened.`);
        if (before && kind === 'file') throw new ZipError(`That ZIP file contains two files named ${JSON.stringify(path.slice(0, 120))} (perhaps with different capital letters), so it was not opened.`);
        if (!before) seen.set(sub.toLowerCase(), kind);
      }
      entries.push({ path, directory, special, executable: (unixMode & 0o111) !== 0, method, crc, compressedSize, size: entrySize, localOffset });
    }
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
  const files = entries.filter((e) => !e.directory && !e.special && !isSystemClutter(e.path));
  const has = (path: string) => files.some((e) => e.path === path);
  const tops = new Set(entries.filter((e) => !isSystemClutter(e.path)).map((e) => e.path.split('/')[0]));
  // The archive's one folder, if everything in it is in one folder.
  const wrapper = tops.size === 1 && !has([...tops][0]) ? `${[...tops][0]}/` : null;
  for (const root of wrapper === null ? [''] : ['', wrapper]) {
    if (has(`${root}${MANIFEST}`)) return { kind: 'project', root, entries: files.filter((e) => e.path.startsWith(root)) };
  }
  if (files.some((e) => e.path === MANIFEST || e.path.endsWith(`/${MANIFEST}`))) return { kind: 'other' };
  for (const root of wrapper === null ? [''] : ['', wrapper]) {
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

/** Send one entry's contents, decompressed and checked, to `out`. */
async function copyEntry(file: string, fh: fs.FileHandle, e: ZipEntry, name: string, out: Writable, signal?: AbortSignal) {
  const local = await readAt(fh, e.localOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipError(DAMAGED);
  const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const source = e.compressedSize ? createReadStream(file, { start, end: start + e.compressedSize - 1 }) : Readable.from([]);
  const check = checked(e, name);
  try {
    if (e.method === 8) await pipeline(source, createInflateRaw(), check.stream, out, { signal });
    else await pipeline(source, check.stream, out, { signal });
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
    const out = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      }
    });
    await copyEntry(file, fh, e, e.path.split('/').pop()!, out);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Write the files under `root` in the archive into the folder `dest` (which must exist and be empty), without `root`
 * itself. Links and the systems' clutter are left out. Every file's size and CRC-32 are checked; a file that fails,
 * or a signal that aborts, stops the extraction with what was written left for the caller to remove.
 */
export async function extractEntries(file: string, entries: ZipEntry[], root: string, dest: string, signal?: AbortSignal): Promise<number> {
  const fh = await fs.open(file, 'r');
  let written = 0;
  try {
    for (const e of entries) {
      signal?.throwIfAborted();
      if (e.special || isSystemClutter(e.path) || !e.path.startsWith(root)) continue;
      const rel = e.path.slice(root.length);
      if (!rel) continue;
      const target = join(dest, ...rel.split('/'));
      if (e.directory) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(dirname(target), { recursive: true });
      await copyEntry(file, fh, e, rel, createWriteStream(target, { flags: 'wx', mode: e.executable ? 0o755 : 0o644 }), signal);
      written++;
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
 * Extract the project in `file` into a new folder in `parent`, named `base` (or `base-2`, `base-3`, … when that is
 * taken), and return its path. The files go to a private folder beside it first; the name is claimed only once every
 * file is written and checked, so a folder that is there already, or appears meanwhile, is never written into or
 * replaced. `beforePublish` runs once the empty folder is claimed, before the project appears in it. Aborting `signal`
 * before then removes everything written; the ZIP file itself is only read.
 */
export async function unpackProject(
  file: string,
  project: { root: string; entries: ZipEntry[] },
  parent: string,
  name: string,
  opts: { signal?: AbortSignal; beforePublish?: (dir: string) => Promise<void> } = {}
): Promise<string> {
  const { signal, beforePublish } = opts;
  // A name Windows reserves for a device (a project called "Con") gets a suffix.
  const base = WINDOWS_RESERVED.test(name) ? `${name}-site` : name;
  const tmp = await fs.mkdtemp(join(parent, '.siteorigin-open-'));
  try {
    await extractEntries(file, project.entries, project.root, tmp, signal);
    for (let i = 1; ; i++) {
      // The last chance to call it off.
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
        await replaceEmptyFolder(tmp, dest);
        return dest;
      } catch (e) {
        // Someone else's files arrived in the claimed folder: they stay, and the next name is tried.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        // Removed only while it is still the empty folder claimed above.
        await fs.rmdir(dest).catch(() => undefined);
        throw e;
      }
    }
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}
