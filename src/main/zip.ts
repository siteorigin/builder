/**
 * A small ZIP writer for exports, built on Node's zlib (deflate and CRC-32). Writes standard ZIP files
 * (no ZIP64) with UTF-8 names, which every operating system's built-in extractor opens.
 *
 * It runs in Electron's main process, so compression happens on libuv's thread pool (the async `deflateRaw`),
 * never on the main thread: a synchronous deflate of one large image held every IPC reply for hundreds of ms.
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

const deflate = promisify(deflateRaw);

const LIMIT = 0xffffffff;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/**
 * Formats that are always compressed. Deflating them again costs real time and saves next to nothing (a 14 MB
 * PNG shrank by 13 KB), so they are stored as they are. ZIP is not one: its entries may be stored.
 */
const PRECOMPRESSED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.gz', '.br', '.mp3', '.mp4', '.webm']);

/** DOS timestamps cover 1980 to 2107; anything else is clamped to that range. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

async function listFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Zip every regular file under `dir` into `zipPath`, with paths relative to `dir` (optionally under a
 * top-level `folder`). Symbolic links are skipped. The archive is written to a new temporary file beside its
 * destination and renamed into place, so a failed export never leaves a partial ZIP or damages an existing one.
 */
export async function zipDirectory(dir: string, zipPath: string, folder = '', beforeCommit?: () => Promise<void>): Promise<{ files: number; bytes: number }> {
  if (folder && !/^[\w][\w.-]*$/.test(folder)) throw new Error('Invalid folder name for a ZIP export.');
  const files = (await listFiles(dir)).sort();
  if (files.length > 0xffff) throw new Error('Too many files for a ZIP export.');
  const tmp = `${zipPath}.${randomUUID()}.tmp`;
  const out = await fs.open(tmp, 'wx');
  const central: Buffer[] = [];
  let centralSize = 0;
  let offset = 0;
  const write = async (b: Buffer) => {
    await out.writeFile(b);
    offset += b.length;
  };
  let closed = false;
  try {
    for (const rel of files) {
      const abs = join(dir, rel);
      const [data, stat] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
      const name = Buffer.from((folder ? `${folder}/` : '') + rel.split(sep).join('/'), 'utf8');
      if (name.length > 0xffff) throw new Error('A file path is too long for a ZIP export.');
      // zlib's default level: level 9 keeps a pool thread busy for longer and saves almost nothing more.
      const deflated = PRECOMPRESSED.has(extname(rel).toLowerCase()) ? null : await deflate(data);
      const store = !deflated || deflated.length >= data.length;
      const body = store ? data : deflated;
      // Everything still to be written must keep every offset and size within 32 bits.
      const projected = offset + LOCAL_HEADER + name.length + body.length + centralSize + CENTRAL_HEADER + name.length + END_RECORD;
      if (data.length >= LIMIT || projected >= LIMIT) throw new Error('The export is too large for a ZIP file.');
      const crc = crc32(data);
      const { time, date } = dosDateTime(stat.mtime);
      const local = Buffer.alloc(LOCAL_HEADER);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(store ? 0 : 8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const header = Buffer.alloc(CENTRAL_HEADER);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0 (so the permission bits below are honoured)
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(store ? 0 : 8, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(body.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      const mode = stat.mode & 0o111 ? 0o100755 : 0o100644; // regular file, keeping executable scripts executable
      header.writeUInt32LE((mode << 16) >>> 0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      centralSize += header.length + name.length;
      await write(Buffer.concat([local, name]));
      await write(body);
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(END_RECORD);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(cd);
    await write(end);
    await out.close();
    closed = true;
    // The last chance to call the export off: an existing ZIP is left as it was.
    await beforeCommit?.();
    await fs.rename(tmp, zipPath);
    return { files: files.length, bytes: offset };
  } catch (e) {
    if (!closed) await out.close().catch(() => undefined);
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
