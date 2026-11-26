/**
 * The files of the loaded packs (fonts and previews), read only through their validated inventory: every read
 * checks the file's size and SHA-256 again, so a file replaced on disk after the pack was loaded is never used.
 */
import { sha } from '../project/fsutil';
import { openRegularFile, readAtMost } from '../regular-file';
import { perf } from '../perf';

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
  const { handle, stat } = await openRegularFile(abs);
  try {
    if (stat.size > maxBytes) throw new Error(`${abs} is larger than expected.`);
    const bytes = await readAtMost(handle, stat.size, maxBytes);
    if (!bytes) throw new Error(`${abs} is larger than expected.`);
    perf.count('files.read');
    return bytes;
  } finally {
    await handle.close();
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
  if (bytes && bytes.length === src.size) perf.count('files.hashed');
  if (!bytes || bytes.length !== src.size || sha(bytes) !== src.sha256) throw new Error(`The ${packId} theme's file ${file} changed after it was loaded. Restart SiteOrigin Builder to load the theme again.`);
  return bytes;
}
