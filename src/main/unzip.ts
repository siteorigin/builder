/**
 * Reading ZIP files someone else sent: an editable project exported as a ZIP file (see zip.ts), or a ZIP file made by
 * the computer's own Compress command. The archive is untrusted, so nothing in it decides where a file lands: every
 * name is checked before anything is written, and only regular files are written (never links). Standard ZIP files
 * only (no ZIP64, no encryption), stored or deflated, which is what Builder and the systems' own tools write.
 *
 * Nothing here depends on Electron, so it is unit tested directly.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 } from 'node:zlib';

const END_RECORD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** At most this many entries, and this many bytes once extracted: a project is far smaller, a ZIP bomb is not. */
export const MAX_ENTRIES = 50_000;
export const MAX_TOTAL_BYTES = 4 * 1024 ** 3;

export const MANIFEST = 'siteorigin.project.json';

/** A ZIP file that cannot be opened as it is, with a message that says why in words the author can act on. */
export class ZipError extends Error {}

export interface ZipEntry {
  /** The entry's path in the archive, with forward slashes, checked to stay inside the folder it is extracted to. */
  path: string;
  directory: boolean;
  /** A symbolic link: listed, never extracted. */
  link: boolean;
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
  /** A finished website (index.html, no project documents): what visitors see, not something Builder can edit. */
  | { kind: 'website' }
  /** Several projects side by side. */
  | { kind: 'several' }
  | { kind: 'other' };

const DAMAGED = 'That ZIP file is damaged or incomplete, so it was not opened. Download or copy it again, then try again.';
const EXTRACT_ELSEWHERE = 'Extract it with your computer’s own tools, then open the project folder.';

/** Files the systems' own Compress commands add, which are never part of the project. */
function isSystemClutter(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  return parts[0] === '__MACOSX' || name === '.DS_Store' || name.startsWith('._') || name === 'Thumbs.db' || name === 'desktop.ini';
}

/**
 * A ZIP entry's name as a safe relative path, or a ZipError. Backslashes (written by some Windows tools) count as
 * folder separators; absolute paths, drive letters, `..`, control characters and empty names are refused.
 */
export function safeEntryPath(raw: string): string {
  const unsafe = () => new ZipError(`That ZIP file contains a file that would be saved outside its folder (${JSON.stringify(raw.slice(0, 120))}), so it was not opened.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw unsafe();
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw unsafe();
  const parts = name.split('/');
  // A directory entry ends with a slash, and a doubled slash or a `.` changes nothing: those parts are dropped.
  const kept = parts.filter((p) => p !== '' && p !== '.');
  if (kept.some((p) => p === '..') || !kept.length) throw unsafe();
  return kept.join('/').normalize('NFC');
}

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipError(DAMAGED);
  return buf;
}

/** Decode a name: UTF-8 when the entry says so (Builder, Finder, 7-Zip), otherwise as plain bytes. */
function decodeName(raw: Buffer, utf8: boolean): string {
  return utf8 || raw.every((b) => b < 0x80) ? raw.toString('utf8') : raw.toString('latin1');
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
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    const seen = new Map<string, string>();
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
      const link = (unixMode & 0o170000) === 0o120000;
      if (flags & 0x1) throw new ZipError(`That ZIP file is password-protected. ${EXTRACT_ELSEWHERE}`);
      if (!directory && !link && method !== 0 && method !== 8) throw new ZipError(`That ZIP file uses a kind of compression SiteOrigin Builder cannot read. ${EXTRACT_ELSEWHERE}`);
      if (compressedSize === 0xffffffff || entrySize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError(`That ZIP file is too large to open here. ${EXTRACT_ELSEWHERE}`);
      if (method === 0 && compressedSize !== entrySize) throw new ZipError(DAMAGED);
      if (localOffset + 30 > cdOffset || localOffset + compressedSize > cdOffset) throw new ZipError(DAMAGED);
      if (!directory) {
        total += entrySize;
        if (total > MAX_TOTAL_BYTES) throw new ZipError(`That ZIP file would take more than ${MAX_TOTAL_BYTES / 1024 ** 3} GB once extracted, so it was not opened. ${EXTRACT_ELSEWHERE}`);
      }
      // Two names one folder cannot tell apart (different case, or a file where a folder must go) would overwrite each other.
      const key = path.toLowerCase();
      const before = seen.get(key);
      if (before !== undefined && !(directory && before === 'dir')) throw new ZipError(`That ZIP file contains two files named ${JSON.stringify(path.slice(0, 120))} (perhaps with different capital letters), so it was not opened.`);
      if (before === undefined) seen.set(key, directory ? 'dir' : 'file');
      entries.push({ path, directory, link, executable: (unixMode & 0o111) !== 0, method, crc, compressedSize, size: entrySize, localOffset });
    }
    // A file that is also another file's folder.
    for (const e of entries) {
      const parts = e.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (seen.get(parts.slice(0, i).join('/').toLowerCase()) === 'file') throw new ZipError(`That ZIP file contains ${JSON.stringify(parts.slice(0, i).join('/'))} both as a file and as a folder, so it was not opened.`);
      }
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/**
 * Say what an archive holds. An editable project has one siteorigin.project.json at its shallowest; everything the
 * project needs sits beside it. A website export has an index.html at its root (or in one folder) and no manifest.
 */
export function classifyZip(entries: ZipEntry[]): ZipContents {
  const files = entries.filter((e) => !e.directory && !e.link && !isSystemClutter(e.path));
  const manifests = files.filter((e) => e.path === MANIFEST || e.path.endsWith(`/${MANIFEST}`));
  if (manifests.length) {
    const depth = (e: ZipEntry) => e.path.split('/').length;
    const shallowest = Math.min(...manifests.map(depth));
    const top = manifests.filter((e) => depth(e) === shallowest);
    if (top.length > 1) return { kind: 'several' };
    const root = top[0].path.slice(0, -MANIFEST.length);
    return { kind: 'project', root, entries: files.filter((e) => e.path.startsWith(root)) };
  }
  if (files.some((e) => /^([^/]+\/)?index\.html?$/i.test(e.path))) return { kind: 'website' };
  return { kind: 'other' };
}

/** Counts bytes and the CRC-32 of what passes through, refusing more than `limit` bytes. */
function checker(limit: number, name: string) {
  const state = { bytes: 0, crc: 0 };
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      state.bytes += chunk.length;
      if (state.bytes > limit) return done(new ZipError(`${name} in that ZIP file is damaged, so it was not opened. Download or copy it again, then try again.`));
      state.crc = crc32(chunk, state.crc);
      done(null, chunk);
    }
  });
  return { stream, state };
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
      if (e.directory || e.link || isSystemClutter(e.path) || !e.path.startsWith(root)) continue;
      const rel = e.path.slice(root.length);
      if (!rel) continue;
      const target = join(dest, ...rel.split('/'));
      const local = await readAt(fh, e.localOffset, 30);
      if (local.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipError(DAMAGED);
      const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await fs.mkdir(dirname(target), { recursive: true });
      const check = checker(e.size, rel);
      const source = e.compressedSize ? createReadStream(file, { start, end: start + e.compressedSize - 1 }) : Readable.from([]);
      const out = createWriteStream(target, { flags: 'wx', mode: e.executable ? 0o755 : 0o644 });
      try {
        if (e.method === 8) await pipeline(source, createInflateRaw(), check.stream, out, { signal });
        else await pipeline(source, check.stream, out, { signal });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'Z_DATA_ERROR' || (err as NodeJS.ErrnoException).code === 'Z_BUF_ERROR') throw new ZipError(`${rel} in that ZIP file is damaged, so it was not opened. Download or copy it again, then try again.`);
        throw err;
      }
      if (check.state.bytes !== e.size || check.state.crc >>> 0 !== e.crc) throw new ZipError(`${rel} in that ZIP file is damaged, so it was not opened. Download or copy it again, then try again.`);
      written++;
    }
    signal?.throwIfAborted();
    return written;
  } finally {
    await fh.close();
  }
}
