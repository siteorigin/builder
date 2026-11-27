/**
 * The Business starter's sample photos (#961): the first project a build makes imports them, and the projects after it
 * are given the very bytes that import wrote, from an entry the build keeps, only while all of it checks.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VariantRequest } from '../../src/main/project/media-client';

const worker = vi.hoisted(() => ({ requests: 0, fail: false, failWidth: 0 }));

/** The media worker, run in this process by the code the real worker runs; it counts what it is asked. */
class InlineMediaWorker extends EventEmitter {
  postMessage(m: VariantRequest) {
    worker.requests++;
    // A worker that fails (for every photo, or for those of one width): the client takes it as no copies, as it
    // does a crashed or stalled worker.
    if (worker.fail || (worker.failWidth && m.width === worker.failWidth)) {
      queueMicrotask(() => this.emit('message', { id: m.id, ok: false, error: 'the worker failed' }));
      return;
    }
    void import('../../src/main/project/image-variants').then(({ handleVariantRequest }) => handleVariantRequest(m)).then((r) => this.emit('message', r));
  }
  kill() {
    return true;
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => new InlineMediaWorker() }
}));

const { importSamples, imageLibrary, sampleKey } = await import('../../src/main/project/starter-samples');
const { importAsset, stopMediaWorker } = await import('../../src/main/project/assets');
const { STARTER_ASSETS } = await import('@catalogue/starters');

const ASSETS = join(process.cwd(), 'resources', 'starter-assets');
const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-samples-${name}-`)));
  dirs.push(d);
  return d;
};
let cacheDir = '';
const cache = (build = 'build 1') => ({ dir: cacheDir, build });
const entries = () => (existsSync(cacheDir) ? readdirSync(cacheDir).filter((n) => n.endsWith('.bin')) : []);

/** Every file under `dir`, by path relative to it, with its bytes. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const at = join(d, e.name);
      if (e.isDirectory()) walk(at);
      else out[relative(dir, at)] = readFileSync(at).toString('base64');
    }
  };
  walk(dir);
  return out;
}
/** A record with what differs between two imports of the same photo (its ID, the time it was added) left out. */
const stable = ({ id: _id, createdAt: _at, ...rest }: { id: string; createdAt?: string }) => rest;

/** The one entry's parts: its header and its files' bytes. */
function readEntry(at: string) {
  const whole = readFileSync(at);
  const length = whole.readUInt32LE(32);
  return { whole, header: JSON.parse(whole.subarray(36, 36 + length).toString('utf8')), body: whole.subarray(36 + length) };
}
/** Write an entry from a header and body, with a digest that matches it, or with the digest of `old` left on it. */
function writeEntry(at: string, header: unknown, body: Buffer, old?: Buffer) {
  const head = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(head.length);
  const rest = Buffer.concat([size, head, body]);
  writeFileSync(at, Buffer.concat([old ? old.subarray(0, 32) : createHash('sha256').update(rest).digest(), rest]));
}
/** Import into a new project, and whether the photos were encoded for it. */
async function encodedFor(c = cache()): Promise<{ dir: string; encoded: boolean }> {
  const dir = temp('project');
  worker.requests = 0;
  await importSamples(dir, ASSETS, c);
  return { dir, encoded: worker.requests > 0 };
}

beforeEach(() => {
  cacheDir = join(temp('cache'), 'starter-samples');
  worker.requests = 0;
  worker.fail = false;
  worker.failWidth = 0;
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
afterAll(() => stopMediaWorker());

describe('the starter’s sample photos', () => {
  it('are imported by the first project as one by one before, and given to the next as the same bytes, without encoding again', async () => {
    // What importing each photo in turn writes and records, as creation did before.
    const reference = temp('reference');
    const before = [];
    for (const a of STARTER_ASSETS) before.push((await importAsset(reference, join(ASSETS, a.source), [])).record);

    const first = temp('first');
    const made = await importSamples(first, ASSETS, cache());
    expect(made.map((s) => s.asset.id)).toEqual(STARTER_ASSETS.map((a) => a.id));
    expect(files(first)).toEqual(files(reference));
    expect(made.map((s) => stable(s.record))).toEqual(before.map(stable));
    expect(made.map((s) => Object.keys(s.record))).toEqual(before.map((r) => Object.keys(r)));
    expect(entries()).toHaveLength(1);

    worker.requests = 0;
    const second = temp('second');
    const startedAt = Date.now();
    const again = await importSamples(second, ASSETS, cache());
    expect(worker.requests).toBe(0);
    // The same files, byte for byte, and the same records but for each one's own ID and the time it was added.
    expect(files(second)).toEqual(files(reference));
    expect(again.map((s) => stable(s.record))).toEqual(before.map(stable));
    expect(again.map((s) => Object.keys(s.record))).toEqual(before.map((r) => Object.keys(r)));
    const ids = new Set([...made, ...again].map((s) => s.record.id));
    expect(ids.size).toBe(made.length * 2);
    for (const s of again) expect(Date.parse(s.record.createdAt!)).toBeGreaterThanOrEqual(startedAt);
    // Added one after another, in catalogue order, whichever way they were made: the library lists them so.
    for (const list of [made, again]) {
      const times = list.map((s) => Date.parse(s.record.createdAt!));
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  }, 180_000);

  it('import every photo afresh from an entry that does not read back as written, or is another layout, and keep a new one', async () => {
    await importSamples(temp('fill'), ASSETS, cache());
    const [name] = entries();
    const at = join(cacheDir, name);
    const { whole, header, body } = readEntry(at);

    // One byte of one copy changed.
    const damaged = Buffer.from(whole);
    damaged[damaged.length - 10] ^= 0xff;
    writeFileSync(at, damaged);
    expect((await encodedFor()).encoded).toBe(true);
    // Kept again, whole: the next project is given it.
    expect((await encodedFor()).encoded).toBe(false);

    // Cut short.
    writeFileSync(at, whole.subarray(0, whole.length - 100));
    expect((await encodedFor()).encoded).toBe(true);

    // A record's width changed, the files untouched: the entry's digest no longer matches.
    const wider = structuredClone(header);
    wider.samples[0].record.width += 1;
    writeEntry(at, wider, body, whole);
    expect((await encodedFor()).encoded).toBe(true);

    // Another layout, even with a digest that matches it.
    writeEntry(at, { ...header, format: 1 }, body);
    expect((await encodedFor()).encoded).toBe(true);

    // A file named outside the assets folder, in the record and the entry alike, with a digest that matches.
    const escape = structuredClone(header);
    escape.samples[0].files[1].rel = '../escape.webp';
    escape.samples[0].record.variants[0].file = '../escape.webp';
    writeEntry(at, escape, body);
    const escaped = await encodedFor();
    expect(escaped.encoded).toBe(true);
    expect(existsSync(join(escaped.dir, '..', 'escape.webp'))).toBe(false);

    // An original that is not the photo shipped, though its digests say it is what the entry holds.
    const other = structuredClone(header);
    const swapped = Buffer.from(body);
    const f = other.samples[0].files[0];
    swapped[f.offset + 100] ^= 0xff;
    f.sha256 = createHash('sha256').update(swapped.subarray(f.offset, f.offset + f.length)).digest('hex');
    other.samples[0].record.hash = f.sha256;
    writeEntry(at, other, swapped);
    expect((await encodedFor()).encoded).toBe(true);

    // Another build reads none of it, and its own entry replaces this build's.
    const sources = STARTER_ASSETS.map((asset) => ({ asset, bytes: readFileSync(join(ASSETS, asset.source)) }));
    expect((await encodedFor(cache('build 2'))).encoded).toBe(true);
    expect(entries()).toEqual([`${sampleKey('build 2', sources)}.bin`]);
  }, 300_000);

  it('are named by the photos, the build, the encoder, the platform and their order', () => {
    const sources = STARTER_ASSETS.map((asset) => ({ asset, bytes: readFileSync(join(ASSETS, asset.source)) }));
    const changed = sources.map((s, i) => (i === 3 ? { ...s, bytes: Buffer.concat([s.bytes, Buffer.from([0])]) } : s));
    expect(sampleKey('b', changed)).not.toBe(sampleKey('b', sources));
    expect(sampleKey('b', sources)).not.toBe(sampleKey('c', sources));
    expect(sampleKey('b', sources, '0.34.1')).not.toBe(sampleKey('b', sources, '0.34.2'));
    expect(sampleKey('b', [...sources].reverse())).not.toBe(sampleKey('b', sources));
    // The encoder is the image library the app runs, read from its own package.
    expect(imageLibrary()).toBe(JSON.parse(readFileSync(join(process.cwd(), 'node_modules', 'sharp', 'package.json'), 'utf8')).version);
  });

  it('keep nothing from an import missing copies (a worker that failed, for all or one), and work with no cache at all', async () => {
    worker.fail = true;
    const made = await importSamples(temp('failed'), ASSETS, cache());
    expect(made).toHaveLength(STARTER_ASSETS.length);
    expect(made.every((s) => !s.record.variants?.length)).toBe(true);
    expect(entries()).toEqual([]);
    worker.fail = false;
    // The worker fails for the photos 1024 pixels wide only: the others' copies are made, but nothing is kept.
    worker.failWidth = 1024;
    const some = await importSamples(temp('some'), ASSETS, cache());
    expect(some.some((s) => s.record.variants?.length)).toBe(true);
    expect(some.some((s) => !s.record.variants?.length)).toBe(true);
    expect(entries()).toEqual([]);
    worker.failWidth = 0;
    worker.requests = 0;
    const plain = await importSamples(temp('plain'), ASSETS, null);
    expect(plain).toHaveLength(STARTER_ASSETS.length);
    expect(worker.requests).toBeGreaterThan(0);
    expect(entries()).toEqual([]);
  }, 180_000);

  it('take the photos shipped: one missing is left out, one unreadable stops the creation as before', async () => {
    await importSamples(temp('fill'), ASSETS, cache());
    const fewer = temp('assets');
    for (const a of STARTER_ASSETS.slice(1)) copyFileSync(join(ASSETS, a.source), join(fewer, a.source));
    worker.requests = 0;
    const made = await importSamples(temp('fewer'), fewer, cache());
    expect(made.map((s) => s.asset.id)).toEqual(STARTER_ASSETS.slice(1).map((a) => a.id));
    expect(worker.requests).toBeGreaterThan(0);
    // Kept for those eight, and given to the next project made from them.
    worker.requests = 0;
    await importSamples(temp('fewer-again'), fewer, cache());
    expect(worker.requests).toBe(0);
    // One there that cannot be read is refused by the importer, as it was, never quietly left out.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = join(fewer, STARTER_ASSETS[1].source);
      chmodSync(locked, 0o000);
      try {
        await expect(importSamples(temp('locked'), fewer, cache())).rejects.toThrow();
      } finally {
        chmodSync(locked, 0o644);
      }
    }
  }, 180_000);

  it('take something at the entry’s place that is not a file (a FIFO) as no entry, without waiting on it', async () => {
    if (process.platform === 'win32') return;
    await importSamples(temp('fill'), ASSETS, cache());
    const [name] = entries();
    rmSync(join(cacheDir, name));
    execFileSync('mkfifo', [join(cacheDir, name)]);
    expect((await encodedFor()).encoded).toBe(true);
  }, 180_000);

  it('never read or clear a cache folder that is a link to somewhere else, and clear only the cache’s own files', async () => {
    const elsewhere = temp('elsewhere');
    writeFileSync(join(elsewhere, 'keep.bin'), 'not ours');
    writeFileSync(join(elsewhere, `${'a'.repeat(64)}.bin`), 'looks like ours');
    symlinkSync(elsewhere, cacheDir);
    await importSamples(temp('linked'), ASSETS, cache());
    expect(readdirSync(elsewhere).sort()).toEqual([`${'a'.repeat(64)}.bin`, 'keep.bin']);
    rmSync(cacheDir);
    // In its own folder, the cache leaves alone what it did not write.
    await importSamples(temp('own'), ASSETS, cache('old build'));
    writeFileSync(join(cacheDir, 'notes.txt'), 'someone’s');
    await importSamples(temp('own2'), ASSETS, cache('new build'));
    expect(readdirSync(cacheDir).sort()).toEqual([entries()[0], 'notes.txt'].sort());
  }, 240_000);
});
