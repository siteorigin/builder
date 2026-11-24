/**
 * Files an import may read: only regular files inside the folder the author chose, never through a link, and never
 * larger than the import takes. A reference in a post (`../../etc/passwd`, `%2e%2e/`, `C:\…`, `file:` URLs) is
 * checked segment by segment before anything is joined, and the file opened is checked to be the one inside the
 * folder, so a link swapped in after the check is refused too.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Whether `path` (a real path) is `root` (a real path) or inside it, compared by whole path components. */
export function isInsideRoot(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (!!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * The path segments of a relative reference, each decoded once, or null when any could lead outside the folder or
 * names something no reference may: `..`, an empty or `.` segment is allowed only as written (`./a`), and a
 * backslash, NUL, colon (a drive or a scheme) or an encoded separator anywhere is refused.
 */
export function safeSegments(ref: string): string[] | null {
  if (!ref || ref.length > 1024 || /[\\\0]/.test(ref) || /%(2f|5c|00)/i.test(ref)) return null;
  const out: string[] = [];
  for (const raw of ref.split('/')) {
    if (raw === '' || raw === '.') continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '..' || seg === '.' || /[\\/\0:]/.test(seg) || seg.length > 255) return null;
    out.push(seg);
  }
  return out.length ? out : null;
}

/** A regular file at `base`/`segments` inside `realRoot` (the chosen folder's real path), or null. Nothing is opened. */
export async function containedFile(realRoot: string, base: string, segments: string[], maxBytes: number): Promise<string | null> {
  const path = join(base, ...segments);
  try {
    const st = await fs.lstat(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    const real = await fs.realpath(path);
    return isInsideRoot(realRoot, real) ? path : null;
  } catch {
    return null;
  }
}

/**
 * A file's bytes, read only when it is a regular file inside `realRoot`, opened without following a link, and the
 * very file the folder holds at that path (so one swapped for a link meanwhile is refused).
 */
export async function readContained(realRoot: string, path: string, maxBytes: number): Promise<Buffer> {
  const fh = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('it is not a file.');
    if (st.size > maxBytes) throw new Error(`it is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    const real = await fs.realpath(path);
    if (!isInsideRoot(realRoot, real)) throw new Error('it is outside the chosen folder.');
    const there = await fs.stat(real);
    if (there.ino !== st.ino || there.dev !== st.dev) throw new Error('it changed while it was being read.');
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = (await fh.read(buf, n, buf.length - n, n)).bytesRead;
    if (n > maxBytes) throw new Error(`it is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}
