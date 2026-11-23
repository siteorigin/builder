import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { renderVariants } from '../../src/main/project/image-variants';
import { createVariantClient, type VariantReply, type VariantRequest, type WorkerHandle } from '../../src/main/project/media-client';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'ascii'), data, u32(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])))]);

/** Split a PNG into its chunks. */
function chunksOf(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) out.push({ type: png.toString('ascii', i + 4, i + 8), data: png.subarray(i + 8, i + 8 + png.readUInt32BE(i)) });
  return out;
}

/** A real two-frame animated PNG: the picture's own pixels as both frames. */
async function animatedPng(width: number, height: number): Promise<Buffer> {
  const png = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
  const [ihdr, ...rest] = chunksOf(png);
  const idat = rest.filter((c) => c.type === 'IDAT');
  const fctl = (seq: number) => chunk('fcTL', Buffer.concat([u32(seq), u32(width), u32(height), u32(0), u32(0), Buffer.from([0, 10, 0, 100, 0, 0])]));
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr.data),
    chunk('acTL', Buffer.concat([u32(2), u32(0)])),
    fctl(0),
    ...idat.map((c) => chunk('IDAT', c.data)),
    fctl(1),
    ...idat.map((c, i) => chunk('fdAT', Buffer.concat([u32(2 + i), c.data]))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A stored picture: left half red, right half blue, optionally tagged with an EXIF orientation. */
async function halves(width: number, height: number, format: 'jpeg' | 'png', orientation?: number): Promise<Buffer> {
  const half = (r: number, b: number) => sharp({ create: { width: width / 2, height, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
  let img = sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite([
    { input: await half(255, 0), left: 0, top: 0 },
    { input: await half(0, 255), left: width / 2, top: 0 }
  ]);
  img = format === 'png' ? img.png() : img.jpeg({ quality: 95 });
  const flat = await img.toBuffer();
  return orientation ? sharp(flat).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer() : flat;
}

async function pixel(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return { r: data[at], g: data[at + 1], b: data[at + 2], a: info.channels === 4 ? data[at + 3] : 255 };
}

describe('responsive copies', () => {
  it('makes each width meaningfully smaller than the picture, as JPEG without metadata', async () => {
    const variants = await renderVariants(await halves(2000, 1000, 'jpeg'), 'image/jpeg', 2000);
    expect(variants.map((v) => v.width)).toEqual([480, 960, 1440]);
    for (const v of variants) {
      const m = await sharp(v.data).metadata();
      expect(m).toMatchObject({ format: 'jpeg', width: v.width, height: v.width / 2 });
      expect(m.exif).toBeUndefined();
    }
    // A copy is made only when it is under 90% of the picture's width: 1440 is not, at 1600.
    expect((await renderVariants(await halves(1600, 800, 'jpeg'), 'image/jpeg', 1600)).map((v) => v.width)).toEqual([480, 960]);
    expect((await renderVariants(await halves(1602, 800, 'jpeg'), 'image/jpeg', 1602)).map((v) => v.width)).toEqual([480, 960, 1440]);
    // A header that overstates the width gets copies for the picture's real width, each labelled as it is.
    const small = await renderVariants(await halves(600, 300, 'jpeg'), 'image/jpeg', 2000);
    expect(small.map((v) => v.width)).toEqual([480]);
    expect((await sharp(small[0].data).metadata()).width).toBe(480);
  });

  it('turns a copy the way its EXIF orientation says, sized by its displayed width', async () => {
    // Stored 1200x600 on its side (orientation 6: turn clockwise), so displayed 600x1200 with red on top.
    const variants = await renderVariants(await halves(1200, 600, 'jpeg', 6), 'image/jpeg', 600);
    expect(variants.map((v) => v.width)).toEqual([480]);
    const m = await sharp(variants[0].data).metadata();
    expect([m.width, m.height, m.orientation]).toEqual([480, 960, undefined]);
    const top = await pixel(variants[0].data, 240, 100);
    const bottom = await pixel(variants[0].data, 240, 860);
    expect(top.r).toBeGreaterThan(200);
    expect(top.b).toBeLessThan(60);
    expect(bottom.b).toBeGreaterThan(200);
    expect(bottom.r).toBeLessThan(60);
    // Orientation 2 mirrors: red ends up on the right.
    const [mirrored] = await renderVariants(await halves(1200, 600, 'jpeg', 2), 'image/jpeg', 1200);
    expect((await pixel(mirrored.data, 400, 100)).r).toBeGreaterThan(200);
    expect((await pixel(mirrored.data, 80, 100)).b).toBeGreaterThan(200);
  });

  it('keeps a PNG a PNG, transparency included', async () => {
    const clear = await sharp({ create: { width: 1200, height: 600, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0 } } }).png().toBuffer();
    const [v] = await renderVariants(clear, 'image/png', 1200);
    expect(await sharp(v.data).metadata()).toMatchObject({ format: 'png', width: 480, height: 240, hasAlpha: true });
    expect((await pixel(v.data, 10, 10)).a).toBe(0);
  });

  it('makes no copies of an animated PNG, whose resized copies would each be one still frame', async () => {
    const moving = await animatedPng(1200, 600);
    expect(chunksOf(moving).map((c) => c.type)).toContain('acTL');
    expect(await renderVariants(moving, 'image/png', 1200)).toEqual([]);
    // The same pixels as an ordinary still PNG are still resized.
    const still = await sharp(moving).png().toBuffer();
    expect(chunksOf(still).map((c) => c.type)).not.toContain('acTL');
    expect((await renderVariants(still, 'image/png', 1200)).map((v) => v.width)).toEqual([480, 960]);
  });

  it('makes exactly the widths asked for, never wider than the picture', async () => {
    const variants = await renderVariants(await halves(1000, 500, 'jpeg'), 'image/jpeg', 1000, [960, 1000, 1440]);
    expect(variants.map((v) => v.width)).toEqual([960, 1000]);
    expect((await sharp(variants[0].data).metadata()).width).toBe(960);
  });

  it('is deterministic, and leaves other formats alone', async () => {
    const photo = await halves(2000, 1000, 'jpeg');
    const [a, b] = [await renderVariants(photo, 'image/jpeg', 2000), await renderVariants(photo, 'image/jpeg', 2000)];
    expect(a.map((v) => v.data.equals(b.find((x) => x.width === v.width)!.data))).toEqual([true, true, true]);
    for (const mime of ['image/webp', 'image/gif', 'image/avif']) expect(await renderVariants(photo, mime, 2000)).toEqual([]);
  });
});

/** A stand-in for the utility process: records what it is sent and replies when the test says. */
class FakeWorker implements WorkerHandle {
  sent: VariantRequest[] = [];
  killed = false;
  /** Whether the process has started; kill() fails before then, as Electron's does. */
  started = true;
  failSend = false;
  private listeners: Record<'message' | 'exit' | 'error' | 'spawn', Array<(arg?: never) => void>> = { message: [], exit: [], error: [], spawn: [] };
  postMessage(m: VariantRequest) {
    if (this.failSend) throw new Error('channel closed');
    this.sent.push(m);
  }
  on(event: 'message' | 'exit' | 'error' | 'spawn', listener: never) {
    this.listeners[event].push(listener);
    return this;
  }
  kill() {
    if (!this.started) return false;
    this.killed = true;
    return true;
  }
  emit(event: 'message' | 'exit' | 'error' | 'spawn', arg?: unknown) {
    for (const l of this.listeners[event]) l(arg as never);
  }
  reply(m: VariantReply) {
    this.emit('message', m);
  }
  exit(code = 1) {
    this.emit('exit', code);
  }
}

describe('media worker client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const spawner = () => {
    const workers: FakeWorker[] = [];
    return { workers, spawn: () => (workers.push(new FakeWorker()), workers[workers.length - 1]) };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it('sends the picture to the worker and returns its copies as buffers', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const p = client.variants(Buffer.from('photo'), 'image/jpeg', 2000);
    await tick();
    expect(workers).toHaveLength(1);
    const [req] = workers[0].sent;
    expect([Buffer.from(req.data).toString(), req.mime, req.width]).toEqual(['photo', 'image/jpeg', 2000]);
    workers[0].reply({ id: req.id, ok: true, variants: [{ width: 480, data: new Uint8Array([1, 2, 3]) }] });
    const out = await p;
    expect(out).toHaveLength(1);
    expect(Buffer.isBuffer(out[0].data) && [...out[0].data]).toEqual([1, 2, 3]);
    client.stop();
  });

  it('handles one picture at a time, so a batch never holds every photo decoded at once', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const first = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    const second = client.variants(Buffer.from('b'), 'image/png', 2000);
    await tick();
    expect(workers[0].sent).toHaveLength(1);
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, error: 'unsupported image' });
    expect(await first).toEqual([]);
    await tick();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((r) => r.mime)).toEqual(['image/jpeg', 'image/png']);
    workers[0].reply({ id: workers[0].sent[1].id, ok: true, variants: [] });
    expect(await second).toEqual([]);
    client.stop();
  });

  it('gives up on a worker that takes too long, and starts a fresh one for the next picture', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { timeoutMs: 1000 });
    const slow = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await slow).toEqual([]);
    expect(workers[0].killed).toBe(true);
    // A late answer from the stopped worker belongs to no request.
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [{ width: 480, data: new Uint8Array([9]) }] });
    const next = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [{ width: 480, data: new Uint8Array([7]) }] });
    expect((await next).map((v) => [...v.data])).toEqual([[7]]);
    client.stop();
  });

  it('imports without copies when the worker crashes or cannot start', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const crashed = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await tick();
    workers[0].exit(1);
    expect(await crashed).toEqual([]);
    const after = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [] });
    expect(await after).toEqual([]);
    client.stop();
    const broken = createVariantClient(() => {
      throw new Error('no utility process');
    });
    expect(await broken.variants(Buffer.from('c'), 'image/jpeg', 2000)).toEqual([]);
  });

  it('says a picture is unreadable only when the decoder refused it, never because the worker failed', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { timeoutMs: 1000 });
    const refused = client.inspect(Buffer.from('a'), 'image/png', 100);
    await tick();
    expect(workers[0].sent[0]).toMatchObject({ check: true });
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, error: 'The picture could not be decoded.', unreadable: true });
    expect(await refused).toEqual({ unreadable: true, variants: [] });
    const failed = client.inspect(Buffer.from('b'), 'image/png', 100);
    await tick();
    workers[0].reply({ id: workers[0].sent[1].id, ok: false, error: 'out of memory' });
    expect(await failed).toEqual({ unreadable: false, variants: [] });
    const crashed = client.inspect(Buffer.from('c'), 'image/png', 100);
    await tick();
    workers[0].exit(1);
    expect(await crashed).toEqual({ unreadable: false, variants: [] });
    client.stop();
    expect(await createVariantClient(() => { throw new Error('no utility process'); }).inspect(Buffer.from('d'), 'image/png', 100)).toEqual({ unreadable: false, variants: [] });
  });

  it('asks for exactly the widths a library image lists when making its copies again', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const p = client.variants(Buffer.from('a'), 'image/jpeg', 1000, [960]);
    await tick();
    expect(workers[0].sent[0]).toMatchObject({ widths: [960] });
    expect(workers[0].sent[0].check).toBeUndefined();
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [] });
    await p;
    client.stop();
  });

  it('reads copies that sit inside a larger buffer, and survives a failed send or a fatal worker error', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const sliced = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await tick();
    const backing = new Uint8Array([0, 0, 5, 6, 7, 0]);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [{ width: 480, data: backing.subarray(2, 5) }] });
    expect((await sliced).map((v) => [...v.data])).toEqual([[5, 6, 7]]);
    // An error event (a fatal failure in the worker) settles the request instead of being thrown.
    const failing = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await tick();
    workers[0].emit('error');
    expect(await failing).toEqual([]);
    expect(workers[0].killed).toBe(true);
    workers[0].exit(1);
    // A send that fails gives up on that worker.
    const unsent = client.variants(Buffer.from('c'), 'image/jpeg', 2000);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].failSend = true;
    const next = client.variants(Buffer.from('d'), 'image/jpeg', 2000);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [] });
    expect(await unsent).toEqual([]);
    expect(await next).toEqual([]);
    expect(workers[1].killed).toBe(true);
    client.stop();
  });

  it('ends a worker that is stopped before it has started, once it starts', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = createVariantClient(() => {
      const w = new FakeWorker();
      w.started = false;
      workers.push(w);
      return w;
    }, { timeoutMs: 1000 });
    const p = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual([]);
    expect(workers[0].killed).toBe(false);
    workers[0].started = true;
    workers[0].emit('spawn');
    expect(workers[0].killed).toBe(true);
    client.stop();
  });

  it('keeps a reused worker past the idle time of an earlier request, and ignores an old worker’s exit', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { idleMs: 5000, timeoutMs: 8000 });
    const first = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [] });
    await first;
    await vi.advanceTimersByTimeAsync(4000);
    // Reused before the idle time ran out: the idle stop and the first request's deadline must not end it.
    const second = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(workers[0].killed).toBe(false);
    workers[0].reply({ id: workers[0].sent[1].id, ok: true, variants: [{ width: 480, data: new Uint8Array([1]) }] });
    expect(await second).toHaveLength(1);
    // A worker that timed out exits late, while its replacement is busy: the replacement's request is unaffected.
    const slow = client.variants(Buffer.from('c'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await slow).toEqual([]);
    const fresh = client.variants(Buffer.from('d'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    workers[0].exit(1);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [{ width: 480, data: new Uint8Array([2]) }] });
    expect(await fresh).toHaveLength(1);
    client.stop();
  });

  it('stops an idle worker, and settles a request in flight when stopped', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { idleMs: 5000 });
    const p = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [] });
    await p;
    await vi.advanceTimersByTimeAsync(4999);
    expect(workers[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].killed).toBe(true);
    const pending = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    const queued = client.variants(Buffer.from('c'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    expect(await pending).toEqual([]);
    expect(workers[1].killed).toBe(true);
    // Stopped for good: what was queued gets no copies and starts no new worker.
    expect(await queued).toEqual([]);
    expect(workers).toHaveLength(2);
  });
});
