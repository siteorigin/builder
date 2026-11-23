import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { renderVariants } from '../../src/main/project/image-variants';
import { createVariantClient, type VariantReply, type VariantRequest, type WorkerHandle } from '../../src/main/project/media-client';

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
    // 1440 is not made for a picture only 1500 wide.
    expect((await renderVariants(await halves(1500, 750, 'jpeg'), 'image/jpeg', 1500)).map((v) => v.width)).toEqual([480, 960]);
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
  });

  it('keeps a PNG a PNG, transparency included', async () => {
    const clear = await sharp({ create: { width: 1200, height: 600, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0 } } }).png().toBuffer();
    const [v] = await renderVariants(clear, 'image/png', 1200);
    expect(await sharp(v.data).metadata()).toMatchObject({ format: 'png', width: 480, hasAlpha: true });
    expect((await pixel(v.data, 10, 10)).a).toBe(0);
  });

  it('is deterministic, and leaves other formats alone', async () => {
    const photo = await halves(2000, 1000, 'jpeg');
    const [a, b] = [await renderVariants(photo, 'image/jpeg', 2000), await renderVariants(photo, 'image/jpeg', 2000)];
    expect(a.map((v) => v.data.equals(b.find((x) => x.width === v.width)!.data))).toEqual([true, true, true]);
    expect(await renderVariants(photo, 'image/webp', 2000)).toEqual([]);
  });
});

/** A stand-in for the utility process: records what it is sent and replies when the test says. */
class FakeWorker implements WorkerHandle {
  sent: VariantRequest[] = [];
  killed = false;
  private listeners: { message: Array<(m: VariantReply) => void>; exit: Array<(code: number) => void> } = { message: [], exit: [] };
  postMessage(m: VariantRequest) {
    this.sent.push(m);
  }
  on(event: 'message' | 'exit', listener: never) {
    (this.listeners[event] as unknown[]).push(listener);
    return this;
  }
  kill() {
    this.killed = true;
    return true;
  }
  reply(m: VariantReply) {
    for (const l of this.listeners.message) l(m);
  }
  exit(code = 1) {
    for (const l of this.listeners.exit) l(code);
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
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    expect(await pending).toEqual([]);
    expect(workers[1].killed).toBe(true);
  });
});
