// Importing several large photos keeps the editor responsive: the main process keeps answering the window
// while the photos' responsive copies are made, because decoding and resizing happen in the media worker.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import sharp from 'sharp';
import { createProject, launch, scratch, step, withTimeout } from './harness.mjs';

/**
 * The longest the main process may go without answering the window. A frame is 16 ms; a few frames of
 * scheduling noise under load is fine, a photo decoded on the main thread (several hundred ms) is not.
 */
const MAX_STALL_MS = 250;
const PHOTOS = 4;

const { WORK, cleanup } = scratch('import');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Import Test', parentDir: join(WORK, 's'), starter: 'blank', sampleImages: false });

step(`make ${PHOTOS} large photos`);
const photos = [];
for (let i = 0; i < PHOTOS; i++) {
  // Noise makes each 24-megapixel photo as costly to decode as a real one, and every one different.
  const file = join(WORK, `photo-${i}.jpg`);
  await sharp({ create: { width: 6000, height: 4000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 85 }).toFile(file);
  photos.push(file);
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
