/**
 * The Business starter's sample photos in a new project (#961). One build of the app gives every project it makes the
 * same files for them, so the first project imports them as any picture is imported (assets.ts), and what that import
 * wrote is kept in a file of the app's own; the projects after it are given those very bytes, without decoding or
 * encoding anything, through the same durable writes.
 *
 * An entry is used only when it was made by this build of the app, on this platform and with this image library, from
 * these very photos in this order, and it reads back whole, as written, with each original the photo it was made
 * from; anything else is a miss, and the photos are imported afresh, as before, and kept again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { STARTER_ASSETS, type StarterAsset } from '@catalogue/starters';
import { newId } from '@shared/ids';
import type { AssetRecord } from '@shared/types';
import { importAsset, MEDIA_PARALLEL } from './assets';
import { atomicWrite, eachAtMost, ensureParents, renameReplacing, safeJoin, sha, WRITES_AT_ONCE } from './fsutil';
import { openRegularFile, readAtMost } from '../regular-file';

/** Where a build keeps its sample photos (a folder of the app's, never inside a project), and what names that build. */
export interface SampleCache {
  dir: string;
  build: string;
}

/** A sample photo imported into a project: its library record as the importer makes it, for the caller to finish. */
export interface ImportedSample {
  asset: StarterAsset;
  record: AssetRecord;
}

/** What an entry is laid out as: raised whenever that changes, so an entry of another layout is never read. */
const FORMAT = 2;
/** Far more than the nine photos and their copies take (a few megabytes): anything larger is not an entry of ours. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** The importer's own limit for a picture: a larger sample is left to it, to refuse as it always has. */
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
/** A sample's file as the importer names it in the project: the photo or one of its copies, in the assets folder. */
const SAMPLE_FILE = /^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png|webp|avif)$/;
/** The files of the cache folder, and the only ones ever removed from it: entries, and fills under way. */
const ENTRY_NAME = /^[0-9a-f]{64}\.bin$/;
const FILL_NAME = /^[0-9a-f]{64}\.[0-9a-f]{12}\.tmp$/;
/** How many photos are imported at once on a miss: as many as the media worker makes copies of at once, and one more being written. */
const IMPORTS_AT_ONCE = MEDIA_PARALLEL + 1;
/** A fill that never finished (the app quit during it) is removed once it is this old. */
const STALE_FILL_MS = 10 * 60_000;
/** Where every sample's files go in the project. */
const ASSETS_FOLDER = 'static/assets';

interface StoredFile {
  rel: string;
  offset: number;
  length: number;
  sha256: string;
}

interface Header {
  format: number;
  key: string;
  samples: Array<{ id: string; record: AssetRecord; files: StoredFile[] }>;
}

interface Source {
  asset: StarterAsset;
  path: string;
  /** The photo's bytes, or null when it is there but could not be read whole: then it is left to the importer. */
  bytes: Buffer | null;
}

type Kept = { asset: StarterAsset; record: AssetRecord; files: ReadonlyArray<{ rel: string; data: Buffer }> };

let library: string | null | undefined;
/**
 * The image library's version, read from its own package (it exports no package.json): the copies are its encoder's
 * bytes, and each version pins its own libvips. Null when it cannot be told, and then nothing is reused.
 */
export function imageLibrary(): string | null {
  if (library !== undefined) return library;
  library = null;
  try {
    for (let dir = dirname(createRequire(import.meta.url).resolve('sharp')); ; dir = dirname(dir)) {
      const pkg = join(dir, 'package.json');
      if (existsSync(pkg)) {
        const { name, version } = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
        if (name === 'sharp') return (library = typeof version === 'string' ? version : null);
      }
      if (dirname(dir) === dir) return library;
    }
  } catch {
    return library;
  }
}

/**
 * The sample photos the app ships, in catalogue order: those whose file is there, as the starter has always taken them.
 * One there but unreadable, or too large for the importer, is kept with no bytes: the importer then says why, as before.
 */
async function readSources(assetsDir: string, read: boolean): Promise<Source[]> {
  const out: Source[] = [];
  for (const asset of STARTER_ASSETS) {
    const path = join(assetsDir, asset.source);
    const st = await fs.stat(path).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : e));
    if (st === null) continue;
    const bytes = !read || st instanceof Error || !st.isFile() || st.size > MAX_PHOTO_BYTES ? null : await fs.readFile(path).catch(() => null);
    out.push({ asset, path, bytes });
  }
  return out;
}

/** What an entry for these photos is named by: everything that decides the bytes the importer writes for them. */
export function sampleKey(build: string, sources: ReadonlyArray<{ asset: StarterAsset; bytes: Buffer }>, encoder: string | null = imageLibrary()): string {
  const named = { format: FORMAT, build, platform: process.platform, arch: process.arch, encoder, photos: sources.map((s) => ({ id: s.asset.id, source: s.asset.source, sha256: sha(s.bytes) })) };
  return createHash('sha256').update(JSON.stringify(named)).digest('hex');
}

const entryPath = (cache: SampleCache, key: string) => join(cache.dir, `${key}.bin`);

/** The cache folder when it is a folder of its own, not a link elsewhere (a profile copied or restored oddly). */
async function cacheFolder(cache: SampleCache, make: boolean): Promise<boolean> {
  const st = await fs.lstat(cache.dir).catch(() => null);
  if (st) return st.isDirectory();
  if (!make) return false;
  await fs.mkdir(cache.dir, { recursive: true });
  return (await fs.lstat(cache.dir)).isDirectory();
}

/**
 * The entry for `key`, each sample with the bytes of its files, when it is one this build made for these photos and
 * reads back as it was written; null otherwise. Nothing is trusted that was not checked: the digest of the whole
 * entry, its layout, the files each record names and their names, each file's digest, and each original against the
 * photo it was made from.
 */
export async function readSamples(cache: SampleCache, key: string, sources: ReadonlyArray<{ asset: StarterAsset; bytes: Buffer }>): Promise<Kept[] | null> {
  let buf: Buffer | null;
  try {
    if (!(await cacheFolder(cache, false))) return null;
    // Only a file of its own, never through a link, read without waiting on anything that is not a file.
    const { handle, stat } = await openRegularFile(entryPath(cache, key));
    try {
      buf = stat.size > MAX_ENTRY_BYTES || stat.size < 36 ? null : await readAtMost(handle, stat.size, MAX_ENTRY_BYTES);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  try {
    if (!buf || buf.length < 36 || !createHash('sha256').update(buf.subarray(32)).digest().equals(buf.subarray(0, 32))) return null;
    const length = buf.readUInt32LE(32);
    if (36 + length > buf.length) return null;
    const header = JSON.parse(buf.subarray(36, 36 + length).toString('utf8')) as Header;
    if (header?.format !== FORMAT || header.key !== key || !Array.isArray(header.samples) || header.samples.length !== sources.length) return null;
    const body = buf.subarray(36 + length);
    const seen = new Set<string>();
    const out: Kept[] = [];
    for (const [i, s] of header.samples.entries()) {
      const r = s?.record;
      if (s?.id !== sources[i].asset.id || !r || typeof r !== 'object' || !Array.isArray(s.files) || !s.files.length) return null;
      const files: Array<{ rel: string; data: Buffer }> = [];
      for (const f of s.files) {
        if (typeof f?.rel !== 'string' || !SAMPLE_FILE.test(f.rel) || seen.has(f.rel)) return null;
        if (!Number.isSafeInteger(f.offset) || !Number.isSafeInteger(f.length) || f.offset < 0 || f.length <= 0 || f.offset + f.length > body.length) return null;
        const data = body.subarray(f.offset, f.offset + f.length);
        if (sha(data) !== f.sha256) return null;
        seen.add(f.rel);
        files.push({ rel: f.rel, data });
      }
      // The record names exactly the files kept with it, the picture first, and the picture is the photo shipped.
      const named = [r.file, ...(Array.isArray(r.variants) ? r.variants.map((v) => v?.file) : [])];
      if (named.length !== files.length || named.some((n, j) => n !== files[j].rel)) return null;
      if (!files[0].data.equals(sources[i].bytes) || r.bytes !== files[0].data.length || r.hash !== sha(files[0].data)) return null;
      out.push({ asset: sources[i].asset, record: r, files });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether an import made every copy a photo gets, so later projects may be given it: the WebP and AVIF ones at its
 * full width, the last of each set. A set the encoder could not make is left out whole, and a worker that failed made
 * none; such an import is not kept. (A photo whose AVIF set is left out for being no smaller is never kept either:
 * none of the starter's are.)
 */
function complete(record: AssetRecord): boolean {
  const full = (ext: string) => !!record.variants?.some((v) => v.width === record.width && v.file.endsWith(ext));
  return typeof record.width === 'number' && full('.webp') && full('.avif');
}

/** Keep these imports as the entry for `key`, written whole or not at all, in place of any other build's. */
async function keepSamples(cache: SampleCache, key: string, samples: Kept[]): Promise<void> {
  const payloads: Buffer[] = [];
  let offset = 0;
  const header: Header = {
    format: FORMAT,
    key,
    samples: samples.map((s) => ({
      id: s.asset.id,
      record: s.record,
      files: s.files.map((f) => {
        const stored = { rel: f.rel, offset, length: f.data.length, sha256: sha(f.data) };
        payloads.push(f.data);
        offset += f.data.length;
        return stored;
      })
    }))
  };
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(head.length, 0);
  const rest = Buffer.concat([size, head, ...payloads]);
  if (!(await cacheFolder(cache, true))) return;
  // A cache, read back only once its digest checks: no flush is needed for it to be safe, only a whole file.
  const tmp = join(cache.dir, `${key}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, Buffer.concat([createHash('sha256').update(rest).digest(), rest]), { flag: 'wx' });
    await renameReplacing(tmp, entryPath(cache, key));
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  // One build's entry at a time: those of earlier builds, and fills that never finished, go. Nothing else is touched.
  for (const name of await fs.readdir(cache.dir).catch(() => [] as string[])) {
    if (name === `${key}.bin`) continue;
    const at = join(cache.dir, name);
    if (ENTRY_NAME.test(name)) await fs.rm(at, { force: true }).catch(() => undefined);
    else if (FILL_NAME.test(name)) {
      const st = await fs.lstat(at).catch(() => null);
      if (st?.isFile() && Date.now() - st.mtimeMs > STALE_FILL_MS) await fs.rm(at, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * `n` times from now, each a millisecond or more after the one before: the library lists pictures added at the same
 * moment by name, and the samples are listed in catalogue order, oldest first, as when they were imported one by one.
 */
export function addedTimes(n: number, now: number = Date.now()): string[] {
  return Array.from({ length: n }, (_, i) => new Date(now + i).toISOString());
}

/**
 * Import the starter's sample photos into `projectDir`, in catalogue order, each record as `importAsset` makes it
 * (with an ID and the time it was added of its own). With `cache`, the bytes this build's first project was given are
 * given again when its entry checks; otherwise each photo is imported, and kept for the next project when every
 * import made all its copies. The cache costs a creation nothing it would not do anyway: one that cannot be read or
 * kept is passed over. `encoding` is called once the photos are to be imported afresh, as their encoding begins.
 */
export async function importSamples(projectDir: string, assetsDir: string, cache: SampleCache | null, encoding?: () => void): Promise<ImportedSample[]> {
  // Without a cache the photos are only looked for, and each importer reads its own, as always.
  const sources = await readSources(assetsDir, !!cache);
  if (!sources.length) return [];
  const read = sources.every((s) => s.bytes) ? (sources as Array<Source & { bytes: Buffer }>) : null;
  const encoder = cache && read ? imageLibrary() : null;
  const key = cache && read && encoder ? sampleKey(cache.build, read, encoder) : null;
  const kept = cache && read && key ? await readSamples(cache, key, read) : null;
  if (kept) {
    // Each file durably, as the importer writes it, a few at a time, into the folder made first: one flush need not
    // wait for the one before. Each path is checked to be in the project as it is written.
    const writes = kept.flatMap((s) => s.files);
    await ensureParents(projectDir, writes.map((w) => w.rel));
    await eachAtMost(WRITES_AT_ONCE, writes, (w) => atomicWrite(safeJoin(projectDir, w.rel), w.data));
    // Stamped once their files are in place, as the importer stamps a picture it has written, in catalogue order.
    const at = addedTimes(kept.length);
    return kept.map((s, i) => ({ asset: s.asset, record: { ...s.record, id: newId('a'), createdAt: at[i] } }));
  }
  encoding?.();
  // The folder every photo goes in, made durably before several importers write into it at once.
  await ensureParents(projectDir, [`${ASSETS_FOLDER}/.`]);
  const imported: Array<Awaited<ReturnType<typeof importAsset>>> = [];
  // Each photo imported from the very bytes the entry is named by: one changed meanwhile is refused, never kept.
  await eachAtMost(IMPORTS_AT_ONCE, sources.map((s, i) => ({ s, i })), async ({ s, i }) => (imported[i] = await importAsset(projectDir, s.path, [], undefined, key && s.bytes ? { keepFiles: true, fingerprint: sha(s.bytes) } : {})));
  // Stamped once every photo is in place, in catalogue order, as one after another they were before.
  const at = addedTimes(sources.length);
  const out = sources.map((s, i) => ({ asset: s.asset, record: { ...imported[i].record, createdAt: at[i] } }));
  const made = out.flatMap((o, i) => (imported[i].files ? [{ ...o, files: imported[i].files! }] : []));
  if (cache && key && made.length === sources.length && made.every((m) => complete(m.record))) await keepSamples(cache, key, made).catch(() => undefined);
  return out;
}
