/**
 * Opening a file only when it is a regular file, never through a link, on every platform. O_NOFOLLOW refuses a link
 * where the system has it, but Windows has none and its open follows one: so the path is checked first, a link or
 * anything that is not a file refused, and the file opened is checked to be the one checked, so a link swapped in
 * between is refused too.
 */
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** A regular file opened for reading, with its stat; the caller closes it. Throws, saying why, otherwise. */
export async function openRegularFile(path: string): Promise<{ handle: FileHandle; stat: Stats }> {
  const before = await fs.lstat(path);
  if (before.isSymbolicLink()) throw new Error('it is a link, not a file.');
  if (!before.isFile()) throw new Error('it is not a file.');
  // Non-blocking: something put in its place that is not a file (a FIFO) cannot hold the open up; it fails below.
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('it is not a file.');
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('it changed while it was being read.');
    return { handle, stat };
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
}

/**
 * The bytes of an opened file of `size` bytes, or null when it holds more than `maxBytes` (it grew after its stat):
 * one byte past the limit is read to tell.
 */
export async function readAtMost(handle: FileHandle, size: number, maxBytes: number): Promise<Buffer | null> {
  const buf = Buffer.alloc(Math.min(size, maxBytes) + 1);
  let n = 0;
  for (let r = 1; r > 0 && n < buf.length; n += r) r = (await handle.read(buf, n, buf.length - n, n)).bytesRead;
  return n > maxBytes ? null : buf.subarray(0, n);
}
