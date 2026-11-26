/**
 * Reading a project file so that what was read can be told apart from what is there later: a file's stat (its stamp)
 * changes with any write to it, and a stamp left alone long enough can stand for the bytes read under it. Shared by
 * the session, which remembers generated files' hashes this way, and the export, which fingerprints the project.
 */
import { promises as fs, constants as fsConstants, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { perf } from '../perf';

const countRead = () => perf.count('files.read');

/** Opened for reading without waiting: a pipe at the path must never hold a save up. */
export const OPEN_READ = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/** The path's stat, or whether nothing is there or it could not be looked at. */
export async function lookAt(abs: string): Promise<BigIntStats | 'missing' | 'failed'> {
  perf.count('files.stats');
  try {
    return await fs.stat(abs, { bigint: true });
  } catch (e) {
    return isMissing(e) ? 'missing' : 'failed';
  }
}

/**
 * A regular file's bytes, read through one handle, with that handle's stat; 'changed' when it changed while read.
 * `counted` is told of each read (by default, the project's files.read counter).
 */
export async function readFileAt(abs: string, counted: (bytes: number) => void = countRead): Promise<{ bytes: Buffer; stamp: string } | 'missing' | 'failed' | 'changed'> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, OPEN_READ);
  } catch (e) {
    return isMissing(e) ? 'missing' : 'failed';
  }
  try {
    const before = await handle.stat({ bigint: true });
    // Only a regular file is read: a pipe or device could block, or never end.
    if (!before.isFile()) return 'failed';
    const bytes = await handle.readFile();
    counted(bytes.length);
    const after = await handle.stat({ bigint: true });
    return stampOf(after) === stampOf(before) ? { bytes, stamp: stampOf(before) } : 'changed';
  } catch {
    return 'failed';
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Nothing at all is at the path: not a file that merely cannot be looked at now. */
export async function absent(abs: string): Promise<boolean> {
  perf.count('files.stats');
  return fs.lstat(abs).then(
    () => false,
    (e) => isMissing(e)
  );
}

/** The stat of whatever a new handle on the path reaches, taken as `readFileAt` takes it; null when nothing can be. */
export async function handleStamp(abs: string): Promise<string | null> {
  perf.count('files.stats');
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, OPEN_READ);
  } catch {
    return null;
  }
  try {
    return stampOf(await handle.stat({ bigint: true }));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Nothing at the path: the file, or a folder above it, is not there. */
export function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** What a file's stat says about its bytes: any write to it, or a new file in its place, changes this. */
export function stampOf(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * Whether a file's stat, taken at `now` (ms), can stand for its bytes later. It must have been last changed more
 * than `settleMs` before, so a later change cannot share its timestamps. A change time that only repeats a
 * whole-second modification time (SSHFS, FAT) is no change time at all: an edit that puts the old modification time
 * back would go unseen, so such files are always read.
 */
export function statTrusted(st: Pick<BigIntStats, 'mtimeNs' | 'ctimeNs'>, now: number, settleMs: number): boolean {
  if (st.mtimeNs === st.ctimeNs && st.mtimeNs % 1_000_000_000n === 0n) return false;
  const settled = (ns: bigint) => now - Number(ns / 1_000_000n) > settleMs;
  return settled(st.mtimeNs) && settled(st.ctimeNs);
}

/**
 * A regular file's SHA-256, read through one handle a chunk at a time (so a large file is never held whole), with that
 * handle's stat; 'changed' when it changed while read. `counted` is told of the bytes read.
 */
export async function hashFileAt(abs: string, counted: (bytes: number) => void): Promise<{ hash: string; stamp: string } | 'missing' | 'failed' | 'changed'> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, OPEN_READ);
  } catch (e) {
    return isMissing(e) ? 'missing' : 'failed';
  }
  try {
    const before = await handle.stat({ bigint: true });
    // Only a regular file is read: a pipe or device could block, or never end.
    if (!before.isFile()) return 'failed';
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    counted(total);
    const after = await handle.stat({ bigint: true });
    return stampOf(after) === stampOf(before) ? { hash: hash.digest('hex'), stamp: stampOf(before) } : 'changed';
  } catch {
    return 'failed';
  } finally {
    await handle.close().catch(() => undefined);
  }
}
