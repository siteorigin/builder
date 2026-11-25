// Importing several large photos keeps the editor responsive: the main process keeps answering the window
// while the photos' responsive copies are made, because decoding and resizing happen in the media worker.
// Phone photos (issue #230): a HEIC photo and a large PNG go through the import review, in Assets and in the
// inspector's image picker, become web-sized copies with their responsive copies, are placed, and ship in a
// static export the right way up.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { createProject, eventually, launch, openInspector, scratch, step, withTimeout } from './harness.mjs';

/** A record's copies in one format, as their widths. */
const widthsIn = (record, ext) => (record.variants ?? []).filter((v) => v.file.endsWith(`.${ext}`)).map((v) => v.width);
/** A picture's copies: `smaller` in its own format, a WebP set to its `full` width, and an AVIF set of those widths or none. */
function assertCopies(record, ext, smaller, full, what) {
  assert.deepEqual(widthsIn(record, ext), smaller, `${what}: its smaller ${ext} copies`);
  assert.deepEqual(widthsIn(record, 'webp'), [...smaller, full], `${what}: its WebP set`);
  const avif = JSON.stringify(widthsIn(record, 'avif'));
  assert.ok(avif === '[]' || avif === JSON.stringify([...smaller, full]), `${what}: its AVIF set is whole or left out (${avif})`);
}

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
  assertCopies(asset, asset.mime === 'image/png' ? 'png' : 'jpg', [160, 480, 960, 1440], asset.width, `${id} has its copies`);
  for (const v of asset.variants) {
    const res = await fetch(new URL(`/${v.file.replace(/^static\//, '')}`, preview.origin), { signal: AbortSignal.timeout(30000) });
    const data = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, `${v.file} is served`);
    assert.equal(res.headers.get('content-security-policy'), 'frame-ancestors app://editor http://127.0.0.1:* http://localhost:*', `${v.file} carries the development frame policy`);
    const meta = await sharp(data).metadata();
    assert.equal(meta.width, v.width, `${v.file} decodes at its width`);
    const ext = v.file.split('.').pop();
    assert.equal(meta.format, { jpg: 'jpeg', png: 'png', webp: 'webp', avif: 'heif' }[ext], `${v.file} is the format its name says`);
  }
}

step('#223: the Assets grid and the image picker load the small copies, not the originals');
/** What each shown picture loaded: its file name, and the size it decoded at against the size it is displayed at. */
const shown = (sel) =>
  win.locator(sel).evaluateAll((imgs) => imgs.filter((i) => i.complete && i.naturalWidth).map((i) => ({ src: new URL(i.currentSrc).pathname.split('/').pop(), natural: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width), dpr: window.devicePixelRatio })));
const checkSmall = (list, where) => {
  assert.equal(list.length, PHOTOS, `${where} shows every picture`);
  for (const p of list) {
    // The smallest copy that covers the tile: 160px or 480px, never the 2000px original.
    const width = Number(p.src.match(/-(160|480)w\.(jpg|png)$/)?.[1]);
    assert.ok(width, `${where} loads a small copy (${p.src})`);
    assert.equal(p.natural, width, `${where} decoded the copy it named`);
    assert.ok(p.natural >= p.shown * p.dpr, `${where} has a pixel for every device pixel (${p.natural} for ${p.shown}px at ${p.dpr}x)`);
  }
};
await win.locator('.rail [aria-label="Assets"]').click();
await eventually(async () => checkSmall(await shown('.asset-grid .asset-thumb img'), 'the Assets grid'));

const home = snap.state.site.homePageId;
const added = await win.evaluate((h) => window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: h }, parentId: null, index: 0, componentId: 'hero.split' }] }, { label: 'Add hero' }), home);
assert.equal(added.ok, true, `the hero is added: ${added.error?.message}`);
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await openInspector(win);
await win.getByRole('button', { name: /Choose image|Change/ }).first().click();
await eventually(async () => checkSmall(await shown('.insp-pick-grid img'), 'the image picker'));
// Choosing one keeps the original: the placed asset is the record, whatever size the picker showed.
await win.locator('.insp-pick-tile').first().click();
await eventually(async () => {
  const nodes = JSON.stringify((await win.evaluate(() => window.builder.project.snapshot())).state.pages[home].nodes);
  assert.ok(run.result.assetIds.some((id) => nodes.includes(id)), 'the picked image is the asset itself, not a copy');
});
await eventually(async () => {
  const thumb = await shown('.insp-image-thumb img');
  assert.equal(thumb.length, 1, 'the chosen image previews in the inspector');
  assert.match(thumb[0].src, /-(160|480)w\.(jpg|png)$/, 'the inspector preview loads a small copy');
});

step('undo the hero and its image, so every imported picture is unused again');
const hist = (await win.evaluate(() => window.builder.project.snapshot())).history;
assert.equal(hist.entries[0]?.label, `Import ${PHOTOS} images`, 'the import is the first step');
for (const e of hist.entries.slice(1).filter((x) => x.applied).reverse()) assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true, `undo ${e.label}`);
const undone = await win.evaluate(() => window.builder.project.snapshot());
assert.equal(undone.history.undoLabel, `Import ${PHOTOS} images`, 'only the import is left to undo');
assert.ok(!run.result.assetIds.some((id) => JSON.stringify(undone.state.pages[home].nodes).includes(id)), 'no imported picture is placed');

// Issue #253: removing every image leaves their files for Undo; the Assets panel says how much they take and frees
// it on request, showing first which Undo steps go with them.
const assetDir = join(snap.dir, 'static', 'assets');
const onDisk = () => readdirSync(assetDir).filter((f) => !f.startsWith('.'));
const diskBytes = () => onDisk().reduce((n, f) => n + statSync(join(assetDir, f)).size, 0);
const imported = onDisk();
const importedBytes = diskBytes();
const mb = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;
// Each photo is its original and its copies: four smaller JPEGs, a WebP set and an AVIF set (when it is the smaller).
const FILES = run.result.assetIds.reduce((n, id) => n + 1 + snap.state.assets.assets[id].variants.length, 0);
assert.ok(FILES >= PHOTOS * 10, `each photo has its copies in every format (${FILES} files)`);
assert.equal(imported.length, FILES, 'each photo is an original and its responsive copies');

step('remove every unused image: the files stay, and the Assets panel says they are kept for Undo');
await win.getByRole('button', { name: 'Assets', exact: true }).click();
const storage = win.getByTestId('asset-storage');
await storage.getByText(`${FILES} files · ${mb(importedBytes)}`).waitFor({ timeout: 15000 });
await win.getByRole('button', { name: /^Unused/ }).click();
await win.getByRole('button', { name: `Remove all ${PHOTOS}` }).click();
await storage.getByText('Kept for Undo').waitFor({ timeout: 15000 });
await storage.getByText(`${FILES} files · ${mb(importedBytes)}`).waitFor({ timeout: 15000 });
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
await dialog.getByText('Nothing will be left to undo.').waitFor();
assert.deepEqual(await dialog.locator('.storage-steps li').allTextContents(), [`Remove ${PHOTOS} unused images`, `Import ${PHOTOS} images`], 'the lost steps, newest first');
assert.equal(await win.evaluate(() => document.activeElement?.textContent?.trim()), 'Cancel', 'the safe choice has focus');
const { plan, refused } = await win.evaluate(async () => {
  const key = (await window.builder.project.snapshot()).workspaceKey;
  const info = await window.builder.project.storage(key);
  return { plan: info.reclaim, refused: await window.builder.project.reclaimStorage(info.reclaim.key, `${key}-another-opening`) };
});
assert.equal(refused.ok, false, 'a plan is only carried out in the opening it was made for');
assert.deepEqual(plan.files, { files: FILES, bytes: importedBytes }, 'the plan frees every removed file');
assert.deepEqual(onDisk().sort(), imported.sort(), 'nothing is deleted before the author confirms');
await win.getByRole('button', { name: `Free ${mb(plan.files.bytes + plan.historyBytes)}`, exact: true }).click();
await dialog.waitFor({ state: 'detached', timeout: 15000 });
await win.locator('.toast', { hasText: 'Freed ' }).first().waitFor({ timeout: 15000 });
assert.deepEqual(onDisk(), [], 'the removed files are deleted');
await storage.waitFor({ state: 'detached', timeout: 15000 });
const after = await win.evaluate(() => window.builder.project.snapshot());
assert.equal(after.history.canUndo, false, 'the steps that could bring them back are gone');
assert.deepEqual(after.state.assets.assets, {}, 'the library stays empty');

step('phone photos: Add images offers HEIC, and the review says what each file of a mixed batch becomes');
/** sips is part of macOS: elsewhere a HEIC photo is refused with a way forward. */
const CONVERTS = process.platform === 'darwin' && existsSync('/usr/bin/sips');
const heic = join(WORK, 'IMG_0042.heic');
copyFileSync(join(process.cwd(), 'tests/unit/fixtures/portrait-rotated.heic'), heic);
const scan = join(WORK, 'field-scan.png');
await sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } })
  .png({ compressionLevel: 1 })
  .toFile(scan);
// A camera original, imported as it is, for the library's web-sized copy below.
const camera = join(WORK, 'camera.jpg');
await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
  .jpeg({ quality: 90 })
  .toFile(camera);
const plain = join(WORK, 'plain.jpg');
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#406080' } }).jpeg().toFile(plain);
const notes = join(WORK, 'notes.unsupported');
writeFileSync(notes, 'not a picture');
// The native chooser answers with the next batch, and records what it offered.
await app.evaluate(({ dialog }) => {
  globalThis.chosen = [];
  globalThis.offered = [];
  dialog.showOpenDialog = async (_win, opts) => {
    globalThis.offered.push(opts);
    const files = globalThis.chosen.shift();
    return files ? { canceled: false, filePaths: files } : { canceled: true, filePaths: [] };
  };
});
const choose = (files) => app.evaluate((_e, f) => void globalThis.chosen.push(f), files);
/** Show a sidebar tab: its rail button toggles, so it is pressed only while the tab is not already open. */
const openTab = async (label) => {
  const button = win.locator(`.rail [aria-label="${label}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
};
const before = new Set(Object.keys((await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets));
await openTab('Assets');
await choose([heic, scan, plain, notes]);
// The library is empty by now: its Add images is the empty state's.
await win.locator('.asset-add, .asset-drop').first().click();
const rows = win.locator('[data-testid="import-review-row"]');
await rows.first().waitFor({ timeout: 30000 });
const offered = await app.evaluate(() => globalThis.offered.at(-1));
assert.ok(offered.filters.some((f) => f.extensions.includes('heic') && f.extensions.includes('heif')), 'the chooser offers HEIC photos');
assert.equal(await rows.count(), 3, 'the review lists the photo to convert, the large PNG and the file that can’t be added');
const [heicRow, scanRow] = [await rows.nth(0).innerText(), await rows.nth(1).innerText()];
if (CONVERTS) assert.match(heicRow, /IMG_0042\.heic[^]*HEIC · 1,200 × 1,600[^]*JPEG · 1,200 × 1,600/, 'the HEIC photo becomes an upright JPEG of its displayed size');
else assert.match(heicRow, /Can’t be added: it is a HEIC photo[^]*JPEG/, 'without a converter the review says what to do instead');
assert.match(scanRow, /field-scan\.png[^]*PNG · 3,000 × 2,000[^]*web-sized copy instead: JPEG · 2,560 × 1,707/, 'the large PNG is offered a web-sized JPEG');
assert.ok(await rows.nth(1).locator('input[type="checkbox"]').isChecked(), 'the web-sized copy is chosen by default');
assert.match(await win.locator('.import-review-rest').innerText(), /One other file is added as it is/);
assert.match(await rows.filter({ hasText: 'notes.unsupported' }).innerText(), /Can’t be added: only JPEG, PNG/, 'the unsupported file is named as one that can’t be added');
// Nothing is written while the author decides.
assert.deepEqual(Object.keys((await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets).sort(), [...before].sort(), 'nothing is added before the author confirms');
await win.locator('[data-testid="import-review-add"]').click();
await win.locator('.asset-detail').waitFor({ timeout: 60000 });
let now = await win.evaluate(() => window.builder.project.snapshot());
const arrived = Object.values(now.state.assets.assets).filter((a) => !before.has(a.id));
const byName = Object.fromEntries(arrived.map((a) => [a.name, a]));
assert.deepEqual(Object.keys(byName).sort(), [...(CONVERTS ? ['IMG 0042'] : []), 'field scan', 'plain'].sort(), 'the photos and the plain picture arrive; the text file does not');
assert.deepEqual([byName['field scan'].mime, byName['field scan'].width, byName['field scan'].height], ['image/jpeg', 2560, 1707], 'the large PNG arrives as its web-sized JPEG');
assertCopies(byName['field scan'], 'jpg', [160, 480, 960, 1440], 2560, 'the web-sized copy has its responsive copies');
assert.equal(byName.plain.mime, 'image/jpeg');
const first = CONVERTS ? byName['IMG 0042'] : byName['field scan'];
assert.equal(await win.locator('.asset-detail h4').innerText(), first.name, 'the first picture made opens in Assets');
if (CONVERTS) {
  assert.deepEqual([first.mime, first.width, first.height], ['image/jpeg', 1200, 1600], 'the HEIC photo arrives as an upright JPEG');
  assertCopies(first, 'jpg', [160, 480, 960], 1200, 'the converted photo has its responsive copies');
}

step('the inspector image picker: Choose image → Import reviews the photo and places it at once');
const inserted = await win.evaluate((pageId) => window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: pageId }, componentId: 'hero.split' }] }, { label: 'Insert hero' }), home);
assert.equal(inserted.ok, true, `a hero is inserted: ${inserted.error?.message}`);
const heroId = inserted.results[0].nodeId;
await openTab('Layers');
await win.locator(`[role="tree"] [data-node="${heroId}"]`).click();
const field = win.locator('.insp-image').first();
await field.locator('button', { hasText: /Choose image…|Change…/ }).click();
await choose(CONVERTS ? [heic, notes] : [scan, notes]);
await field.locator('.insp-pick button', { hasText: 'Import…' }).click();
await rows.first().waitFor({ timeout: 30000 });
assert.equal(await rows.count(), 2, 'the picker reviews the photo and names the text file as no image');
await win.locator('[data-testid="import-review-add"]').click();
const placedId = await eventually(async () => {
  const s = await win.evaluate(() => window.builder.project.snapshot());
  const v = s.state.pages[home].nodes[heroId].props.image;
  assert.ok(v?.assetId, 'the hero has an image');
  return v.assetId;
}, 60000);
now = await win.evaluate(() => window.builder.project.snapshot());
const placed = now.state.assets.assets[placedId];
assert.equal(placed.id, first.id, 'the same photo is the same asset, placed in the hero');
const frame = win.frameLocator('.frame-box iframe');
await frame.locator(`img[src*="${basename(placed.file).replace(/\.jpg$/, '')}"]`).first().waitFor({ timeout: 60000 });

step('Assets: a large library image gets a web-sized copy without leaving the builder');
const cameraImport = await win.evaluate((p) => window.builder.project.importAssets([p]), camera);
assert.equal(cameraImport.ok, true, `the camera original imports as it is: ${cameraImport.message}`);
now = await win.evaluate(() => window.builder.project.snapshot());
const original = now.state.assets.assets[cameraImport.assetIds[0]];
assert.ok(original.bytes > 1_500_000 && original.width === 4000, 'a large camera original is in the library');
await openTab('Assets');
if (await win.locator('.asset-detail .asset-back').count()) await win.locator('.asset-detail .asset-back').click();
await win.locator(`[data-asset="${original.id}"]`).click();
const copyButton = win.locator('[data-testid="asset-web-copy"]');
await copyButton.waitFor({ timeout: 30000 });
assert.match(await win.locator('[data-testid="asset-large-note"]').innerText(), /A web-sized copy \(JPEG · 2560 × 1920\) keeps it light\. It’s added to Assets beside the original/);
await copyButton.click();
await eventually(async () => assert.equal(await win.locator('.asset-detail h4').innerText(), 'camera (web-sized)'), 60000);
now = await win.evaluate(() => window.builder.project.snapshot());
const copy = Object.values(now.state.assets.assets).find((a) => a.name === 'camera (web-sized)');
assert.deepEqual([copy.mime, copy.width, copy.height], ['image/jpeg', 2560, 1920], 'the copy is web-sized');
assertCopies(copy, 'jpg', [160, 480, 960, 1440], 2560, 'the web-sized copy has its responsive copies');
assert.ok(copy.bytes < original.bytes, 'the copy is lighter than the original');
assert.ok(now.state.assets.assets[original.id], 'the original stays in Assets');

step('the static export ships the placed photo the right way up, with its responsive copies');
const out = join(WORK, 'export-static');
const exported = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), out), 300000, 'Static export');
assert.equal(exported.ok, true, `static export succeeds: ${exported.message}`);
const html = readFileSync(join(out, 'index.html'), 'utf8');
const stem = basename(placed.file).replace(/\.jpg$/, '');
assert.match(html, new RegExp(`<img[^>]*src="[^"]*${stem}\\.jpg"`), 'the home page shows the placed photo');
for (const v of placed.variants) assert.match(html, new RegExp(`${basename(v.file).replace('.', '\\.')} ${v.width}w`), `the srcset lists the ${v.width}w copy`);
const files = readdirSync(out, { recursive: true }).map(String);
const shipped = files.find((f) => basename(f) === basename(placed.file));
assert.ok(shipped, 'the photo is in the export');
for (const v of placed.variants) {
  const shippedCopy = files.find((f) => basename(f) === basename(v.file));
  assert.ok(shippedCopy, `${basename(v.file)} is in the export`);
  assert.equal((await sharp(readFileSync(join(out, shippedCopy))).metadata()).width, v.width, `${basename(v.file)} is ${v.width} pixels wide`);
}
assert.deepEqual(files.filter((f) => /\.(heic|heif|tiff?)$/i.test(f)), [], 'no HEIC or intermediate files ship');
const { data, info } = await sharp(readFileSync(join(out, shipped))).raw().toBuffer({ resolveWithObject: true });
const at = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
if (CONVERTS) {
  assert.deepEqual([info.width, info.height], [1200, 1600], 'the exported photo is a portrait');
  const [top, bottom, right] = [at(360, 320), at(360, 1280), at(1196, 800)];
  assert.ok(top[0] > 200 && top[2] < 60 && bottom[2] > 200 && bottom[0] < 60 && right[1] > 200, `the exported photo is upright (top ${top}, bottom ${bottom}, right edge ${right})`);
} else assert.deepEqual([info.width, info.height], [2560, 1707], 'the exported photo is the web-sized copy');

assert.deepEqual(errors, [], 'no page errors');

await app.close();
cleanup();
console.log('\nimport: passed');
