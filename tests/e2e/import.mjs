// Importing several large photos keeps the editor responsive: the main process keeps answering the window
// while the photos' responsive copies are made, because decoding and resizing happen in the media worker.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
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

step('each picture has its responsive copies, served by the preview under the development frame policy');
const snap = await win.evaluate(() => window.builder.project.snapshot());
const preview = new URL(await win.locator('.frame-box iframe').getAttribute('src'));
for (const id of run.result.assetIds) {
  const asset = snap.state.assets.assets[id];
  assert.deepEqual(asset.variants?.map((v) => v.width), [480, 960, 1440], `${id} has its copies`);
  for (const v of asset.variants) {
    const res = await fetch(new URL(`/${v.file.replace(/^static\//, '')}`, preview.origin), { signal: AbortSignal.timeout(30000) });
    const data = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, `${v.file} is served`);
    assert.equal(res.headers.get('content-security-policy'), 'frame-ancestors app://editor http://127.0.0.1:* http://localhost:*', `${v.file} carries the development frame policy`);
    const meta = await sharp(data).metadata();
    assert.equal(meta.width, v.width, `${v.file} decodes at its width`);
    assert.equal(meta.format, asset.mime === 'image/png' ? 'png' : 'jpeg', `${v.file} keeps its format`);
  }
}

// Issue #253: removing every image leaves their files for Undo; the Assets panel says how much they take and frees
// it on request, showing first which Undo steps go with them.
const assetDir = join(snap.dir, 'static', 'assets');
const onDisk = () => readdirSync(assetDir).filter((f) => !f.startsWith('.'));
const diskBytes = () => onDisk().reduce((n, f) => n + statSync(join(assetDir, f)).size, 0);
const imported = onDisk();
const importedBytes = diskBytes();
const mb = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;
assert.equal(imported.length, PHOTOS * 4, 'each photo is an original and three responsive copies');

step('remove every unused image: the files stay, and the Assets panel says they are kept for Undo');
await win.getByRole('button', { name: 'Assets', exact: true }).click();
const storage = win.getByTestId('asset-storage');
await storage.getByText(`${PHOTOS * 4} files · ${mb(importedBytes)}`).waitFor({ timeout: 15000 });
await win.getByRole('button', { name: /^Unused/ }).click();
await win.getByRole('button', { name: `Remove all ${PHOTOS}` }).click();
await storage.getByText('Kept for Undo').waitFor({ timeout: 15000 });
await storage.getByText(`${PHOTOS * 4} files · ${mb(importedBytes)}`).waitFor({ timeout: 15000 });
await storage.getByText('0 files · 0 bytes').waitFor();
assert.deepEqual(onDisk().sort(), imported.sort(), 'removing keeps every file for Undo');

step('normal removal stays undoable');
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true, 'undo the removal');
assert.equal(Object.keys((await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets).length, PHOTOS, 'undo brings every image back');
assert.equal((await win.evaluate(() => window.builder.project.redo())).ok, true, 'redo the removal');
await storage.getByText('Kept for Undo').waitFor({ timeout: 15000 });

step('Free up space shows what it deletes and which steps go, then frees it');
await storage.getByRole('button', { name: 'Free up space…' }).click();
const dialog = win.getByTestId('free-space-dialog');
await dialog.waitFor();
await dialog.getByText(`Remove ${PHOTOS} unused images`, { exact: true }).waitFor();
await dialog.getByText(`Import ${PHOTOS} images`, { exact: true }).waitFor();
await dialog.getByText('Nothing will be left to undo.').waitFor();
assert.equal(await win.evaluate(() => document.activeElement?.textContent?.trim()), 'Cancel', 'the safe choice has focus');
assert.deepEqual(onDisk().sort(), imported.sort(), 'nothing is deleted before the author confirms');
await win.getByRole('button', { name: /^Free \d/ }).click();
await dialog.waitFor({ state: 'detached', timeout: 15000 });
await win.locator('.toast', { hasText: 'Freed ' }).first().waitFor({ timeout: 15000 });
assert.deepEqual(onDisk(), [], 'the removed files are deleted');
await storage.waitFor({ state: 'detached', timeout: 15000 });
const after = await win.evaluate(() => window.builder.project.snapshot());
assert.equal(after.history.canUndo, false, 'the steps that could bring them back are gone');
assert.deepEqual(after.state.assets.assets, {}, 'the library stays empty');
assert.deepEqual(errors, [], 'no page errors');

await app.close();
cleanup();
console.log('\nimport: passed');
