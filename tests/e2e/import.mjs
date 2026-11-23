// Importing several large photos keeps the editor responsive: the main process keeps answering the window
// while the photos' responsive copies are made, because decoding and resizing happen in the media worker.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import sharp from 'sharp';
import { createProject, launch, scratch, step, withTimeout } from './harness.mjs';

/**
 * The longest the main process may go without answering the window. With the pictures decoded in the media
 * worker it answers within about 10 ms throughout; decoding them on the main thread stalled it for 280 ms.
 */
const MAX_STALL_MS = 100;
const PHOTOS = 4;

const { WORK, cleanup } = scratch('import');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Import Test', parentDir: join(WORK, 's'), starter: 'blank', sampleImages: false });

step(`make ${PHOTOS} large pictures`);
const [W, H] = [6000, 4000];
const photos = [];
for (let i = 0; i < PHOTOS; i++) {
  if (i % 2 === 0) {
    // A 24-megapixel progressive JPEG of noise: as costly to decode as a real photo, and every one different.
    const file = join(WORK, `photo-${i}.jpg`);
    await sharp({ create: { width: W, height: H, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 85, progressive: true }).toFile(file);
    photos.push(file);
  } else {
    // A 24-megapixel PNG of smooth colour: a small file that still decodes every pixel.
    const px = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([(x * 255) / W, (y * 255) / H, i * 40], (y * W + x) * 3);
    const file = join(WORK, `picture-${i}.png`);
    await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
    photos.push(file);
  }
}

step('import them while the window keeps asking the main process for something');
const run = await withTimeout(
  win.evaluate(async (paths) => {
    let done = false;
    let last = performance.now();
    let worst = 0;
    let answers = 0;
    const ask = (async () => {
      while (!done) {
        await window.builder.app.info();
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        answers++;
      }
    })();
    const t0 = performance.now();
    const result = await window.builder.project.importAssets(paths);
    const took = performance.now() - t0;
    done = true;
    await ask;
    return { result, took: Math.round(took), worst: Math.round(worst), answers };
  }, photos),
  180000,
  'importing the photos'
);
console.log(`imported ${PHOTOS} photos in ${run.took} ms; longest wait for the main process ${run.worst} ms over ${run.answers} answers`);
assert.equal(run.result.ok, true, `the photos import: ${run.result.message}`);
assert.equal(run.result.assetIds.length, PHOTOS, 'every photo becomes an asset');
assert.ok(run.answers > 10, 'the window kept getting answers during the import');
assert.ok(run.worst < MAX_STALL_MS, `the main process never stalls for ${MAX_STALL_MS} ms or more (longest: ${run.worst} ms)`);

step('each photo has its responsive copies');
const snap = await win.evaluate(() => window.builder.project.snapshot());
for (const id of run.result.assetIds) assert.deepEqual(snap.state.assets.assets[id].variants?.map((v) => v.width), [480, 960, 1440], `${id} has its copies`);
assert.deepEqual(errors, [], 'no page errors');

await app.close();
cleanup();
console.log('\nimport: passed');
