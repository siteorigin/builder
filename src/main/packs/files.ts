/**
 * The files of the loaded packs (fonts and previews), read only through their validated inventory: every read
 * checks the file's size and SHA-256 again, so a file replaced on disk after the pack was loaded is never used.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import { sha } from '../project/fsutil';

export interface PackFileSource {
  /** Where the bytes are on this computer. */
  abs: string;
  size: number;
  sha256: string;
}

const sources = new Map<string, Map<string, PackFileSource>>();

/**
 * A regular file's bytes, never through a link and never more than `maxBytes`: a file that grew or was swapped for
 * something larger after it was checked is refused before it is read whole.
 */
export async function readRegularFile(abs: string, maxBytes: number): Promise<Buffer> {
  const fh = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${abs} is not a file.`);
    if (st.size > maxBytes) throw new Error(`${abs} is larger than expected.`);
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = (await fh.read(buf, n, buf.length - n, n)).bytesRead;
    if (n > maxBytes) throw new Error(`${abs} is larger than expected.`);
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}

/** Make a loaded pack's files readable, replacing whatever was registered for that pack before. */
export function registerPackFiles(packId: string, files: Map<string, PackFileSource>): void {
  sources.set(packId, new Map(files));
}

export function clearPackFiles(): void {
  sources.clear();
}

/** The registered inventory entry of a pack file, if the pack ships it. */
export function packFileInfo(packId: string, file: string): PackFileSource | undefined {
  return sources.get(packId)?.get(file);
}

/** The bytes of one of a loaded pack's files, exactly as validated. */
export async function readPackFile(packId: string, file: string): Promise<Buffer> {
  const src = packFileInfo(packId, file);
  if (!src) throw new Error(`The ${packId} theme has no file ${file}.`);
  const bytes = await readRegularFile(src.abs, src.size).catch(() => null);
  if (!bytes || bytes.length !== src.size || sha(bytes) !== src.sha256) throw new Error(`The ${packId} theme's file ${file} changed after it was loaded. Restart SiteOrigin Builder to load the theme again.`);
  return bytes;
}
