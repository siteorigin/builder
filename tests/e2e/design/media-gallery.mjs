// Design capture harness for the media gallery (the sidebar's Assets tab). Drives the real built app
// through every state of the panel in light and dark and writes one PNG per state and theme. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/media-gallery.mjs
//
// The fixtures go through the app's own import seam (project.importAssets with file paths), so the grid
// shows real thumbnails, real sizes and real usage counts. Each capture is verified after it settles; a
// state that did not render throws instead of writing a plausible-looking wrong image. Files are named
// `assets-{state}--{theme}.png`. Panel states are cropped to the sidebar; `assets-context` is the window.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('media gallery capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'media-gallery');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-media-')));
const THEMES = ['light', 'dark'];
const STARTER = resolve('resources/starter-assets');

// ---- Fixtures: distinct bytes per file (imports dedupe by hash), long names, odd shapes, one large file ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const photos = ['hero', 'studio', 'kitchen', 'bedroom', 'reading', 'dining', 'person-1', 'person-2', 'person-3'];
const names = [
  'harbour-lane-living-room-oak-floor-afternoon-light-final-v3',
  'team-offsite-2026',
  'IMG_4821',
  'kitchen-renovation-before-after-stone-benchtop',
  'portrait-hannah-wells-crop',
  'DSC00912',
  'dining-room-tall-window-winter',
  'screenshot-2026-10-14-at-09.41.22',
  'brand-photo-shoot-selects-03'
];
const sizes = [1400, 1100, 900, 700];
const fixtures = [];
let n = 0;
for (const w of sizes) {
  for (let i = 0; i < photos.length; i++) {
    const dest = join(FIX, `${names[(i + n) % names.length]}${w === 1400 ? '' : `-${w}`}.jpg`);
    execFileSync('sips', ['-Z', String(w), join(STARTER, `${photos[i]}.jpg`), '--out', dest], { stdio: 'ignore' });
    fixtures.push(dest);
  }
  n++;
}
// A wide transparent logo, a tall banner and a small icon: shapes a square crop handles badly.
const svg = (file, w, h, body) => {
  const p = join(FIX, file);
  writeFileSync(p, `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
  fixtures.push(p);
  return p;
};
const logo = svg('harbour-lane-logo-horizontal.svg', 640, 140, '<circle cx="70" cy="70" r="46" fill="#1b5e7a"/><text x="140" y="92" font-family="Georgia" font-size="64" fill="#1b5e7a">Harbour Lane</text>');
svg('autumn-sale-banner-tall.svg', 240, 900, '<rect width="240" height="900" fill="#c4572c"/><text x="120" y="450" text-anchor="middle" font-family="Helvetica" font-size="40" fill="#fff">SALE</text>');
svg('icon-leaf.svg', 64, 64, '<path d="M12 52C12 24 32 10 54 10c0 26-16 42-42 42z" fill="#3b7a3b"/>');
// Over the 1.5 MB "Large file" threshold.
const large = join(FIX, 'warehouse-wide-shot-uncompressed-original-from-photographer.png');
execFileSync('sips', ['-s', 'format', 'png', '-Z', '2200', join(STARTER, 'studio.jpg'), '--out', large], { stdio: 'ignore' });
fixtures.push(large);
// A numbered series, for the order controls' series filter.
for (let i = 1; i <= 6; i++) {
  const dest = join(FIX, `fabric-swatch-${i}.jpg`);
  execFileSync('sips', ['-Z', String(400 + i * 10), join(STARTER, `${photos[i]}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
}

// ---- App ----
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

const panel = win.locator('aside.side-panel');
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
/**
 * Capture a state; `check` must be visible inside the sidebar at the moment of capture. `window: true`
 * captures the whole window instead of the sidebar, `el` another element. `keep` skips the pointer move
 * (hover/focus states).
 */
async function shot(state, check, { themes = THEMES, window = false, keep = false, el = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keep) await win.mouse.move(900, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `assets-${state}--${theme}.png`);
    if (window) await win.screenshot({ path });
    else await (el ?? panel).screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const openAssets = async () => {
  const b = win.locator('.rail [aria-label="Assets"]');
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(600);
};
const waitThumbs = async () => {
  await win.waitForFunction(() => [...document.querySelectorAll('aside.side-panel img')].filter((i) => i.getBoundingClientRect().height > 0).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 }).catch(() => {});
  await pause(400);
};
const tile = (name) => win.locator('[data-asset]', { hasText: name }).first();
/** Hold a file drag over the panel (a real File in the DataTransfer, as a drag from Finder carries), capture, release. */
async function dragFiles(state, check) {
  const dt = await win.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }));
    return d;
  });
  const target = win.locator('.side-panel-view:not([hidden]) .panel-body');
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await pause(200);
  await shot(state, check, { themes: ['light'], keep: true });
  await target.dispatchEvent('dragleave', { dataTransfer: dt });
  await pause(200);
}
const back = async () => {
  await win.locator('.asset-back').click();
  await pause(300);
};

// ---- A project with no images: the empty state, then a drag over it ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Empty Gallery', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('body *').first().waitFor({ timeout: 90000 });
await openAssets();
await shot('empty', '.side-panel-view:not([hidden]) .asset-drop');
await dragFiles('drop-over', '.side-panel-view:not([hidden]) .over');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

// ---- The Business starter: nine sample images, most of them placed ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await openAssets();
await waitThumbs();
await shot('populated', '[data-asset]');

// Keyboard focus on a tile.
await win.keyboard.press('Shift');
await win.locator('[data-asset]').nth(1).focus();
await shot('focus', '[data-asset]:focus-visible', { themes: ['light'], keep: true });

// An image that is placed on the site, then the picker that replaces it everywhere.
await tile('Hero interior').click();
await waitThumbs();
await shot('detail-used', '.asset-detail');
await win.getByRole('button', { name: /Replace everywhere/ }).click();
await pause(300);
await waitThumbs();
await shot('replace', '.asset-replace', { themes: ['light'] });
// Escape steps back out of the picker to the details, then out of the details to the grid.
await win.locator('.asset-replace-top .asset-back').focus();
await win.keyboard.press('Escape');
await win.locator('.asset-detail').waitFor({ timeout: 3000 });
await win.locator('.asset-detail .asset-back').focus();
await win.keyboard.press('Escape');
await win.locator('[data-asset]').first().waitFor({ timeout: 3000 });

// ---- Many images: everything above through the real import seam ----
const r = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures);
if (!r.ok && !r.assetIds.length) throw new Error(`fixture import failed: ${r.message}`);
console.log(`imported ${r.assetIds.length} fixtures${r.message ? ` (${r.message})` : ''}`);
await pause(1200);
await waitThumbs();
await shot('many', '[data-asset]');
await win.locator('.side-panel-view:not([hidden]) .panel-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
await pause(300);
await waitThumbs();
await shot('many-end', '[data-asset]', { themes: ['light'] });
await win.locator('.side-panel-view:not([hidden]) .panel-body').evaluate((el) => (el.scrollTop = 0));
await pause(200);
// Smaller thumbnails, for scanning a long library by eye.
const density = win.locator('.side-panel-view:not([hidden]) .asset-density');
if (await density.count()) {
  await density.click();
  await pause(300);
  await waitThumbs();
  await shot('compact', '.asset-grid.compact [data-asset]', { themes: ['light'] });
  await density.click();
  await pause(300);
}

// Files dragged over a full library.
await dragFiles('drop-overlay', '.asset-drop-overlay');

// Searching, then only the unused images with their clean-up action.
await win.locator('.side-panel-view:not([hidden]) input[type="search"]').fill('harbour');
await pause(300);
await waitThumbs();
await shot('search', '[data-asset]', { themes: ['light'] });
await win.locator('.side-panel-view:not([hidden]) input[type="search"]').fill('');
await win.getByRole('radio', { name: /^Unused/ }).click();
await pause(300);
await waitThumbs();
await shot('unused', '.asset-cleanup', { themes: ['light'] });
await win.getByRole('radiogroup', { name: 'Filter images' }).getByRole('radio', { name: /^All/ }).click();
await pause(200);

// An unused, oversized image with a long name.
await tile(/warehouse/i).click();
await waitThumbs();
await shot('detail-unused-large', '.asset-detail');
await back();

// A wide transparent logo.
await tile(/harbour lane logo/i).click();
await waitThumbs();
await shot('detail-wide-svg', '.asset-detail', { themes: ['light'] });
await back();

// The panel in the window, for proportion against the rest of the editor.
await shot('context', '[data-asset]', { themes: ['light'], window: true });

const scrollBody = (to) => win.locator('.side-panel-view:not([hidden]) .panel-body').evaluate((el, y) => (el.scrollTop = y === 'end' ? el.scrollHeight : 0), to);
const searchBox = win.locator('.side-panel-view:not([hidden]) input[type="search"]');
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

// One numbered series chosen, then a search that finds nothing.
const seriesSelect = win.locator('.side-panel-view:not([hidden]) [aria-label="Numbered series"]');
await seriesSelect.selectOption({ index: 1 });
await pause(300);
await waitThumbs();
await shot('series', '[data-asset]', { themes: ['light'] });
await seriesSelect.selectOption('');
await pause(200);
await searchBox.fill('zebra crossing');
await pause(300);
await shot('no-match', '.asset-nomatch', { themes: ['light'] });
await searchBox.fill('');
await pause(200);

// Documents and a font, with one document open, down to the storage summary at the end of the panel.
const pdf = join(FIX, 'harbour-lane-price-list-2026.pdf');
writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const csv = join(FIX, 'opening-hours.csv');
writeFileSync(csv, 'day,open,close\nMonday,9,5\n');
const font = resolve('node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2');
const more = await win.evaluate((paths) => window.builder.project.importAssets(paths), [pdf, csv, font]);
if (!more.assetIds.length) throw new Error(`document and font import failed: ${more.message}`);
await win.getByTestId('asset-storage').waitFor({ timeout: 20000 });
const sectionTab = (name) => panel.getByRole('tab', { name });
await sectionTab(/^Documents/).click();
await win.locator('.doc-item').first().waitFor({ timeout: 20000 });
await win.locator('.doc-toggle').first().click();
await pause(200);
await shot('library-end', '.doc-item');
await win.locator('.doc-toggle').first().click();
await sectionTab(/^Fonts/).click();
await win.locator('.font-face').first().waitFor({ timeout: 20000 });
await pause(200);
await shot('fonts', '.font-face', { themes: ['light'] });
await sectionTab(/^Images/).click();
await win.locator('[data-asset]').first().waitFor({ timeout: 5000 });
await pause(200);

// The import review: a HEIC photo, a large scan, a plain photo and a file that can't be added.
const heic = join(FIX, 'IMG_0042.heic');
copyFileSync(resolve('tests/unit/fixtures/portrait-rotated.heic'), heic);
const scan = join(FIX, 'field-scan-from-the-archive.png');
await sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).png({ compressionLevel: 1 }).toFile(scan);
const plain = join(FIX, 'plain.jpg');
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#406080' } }).jpeg().toFile(plain);
const layered = join(FIX, 'layered-artwork.psd');
writeFileSync(layered, '8BPS not a web picture');
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
}, [heic, scan, plain, layered]);
await win.locator('.asset-add').click();
const reviewRow = win.locator('[data-testid="import-review-row"]');
await reviewRow.first().waitFor({ timeout: 60000 });
await shot('import-review', '[data-testid="import-review-row"]', { window: true });
await win.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
await reviewRow.first().waitFor({ state: 'detached', timeout: 10000 });
await pause(300);

// The gallery's image picker in the Inspector, reached from where an image is used: at rest, then with an order.
const snapA = await snapshot();
let galleryImage;
for (const p of Object.values(snapA.state.pages)) {
  for (const n of Object.values(p.nodes)) {
    if (!galleryImage && n.kind === 'instance' && snapA.state.components[n.definitionId]?.componentId === 'media.gallery') galleryImage = n.props.images[0].image.assetId;
  }
}
if (!galleryImage) throw new Error('the starter has no gallery to open the picker on');
await win.locator(`[data-asset="${galleryImage}"]`).click();
await win.locator('.asset-detail').waitFor();
await win.locator('.asset-use', { hasText: /gallery/i }).first().click();
await win.locator('.insp-pick-open').first().click();
const picker = win.locator('.insp-pick-many');
await picker.waitFor({ timeout: 10000 });
await pause(1000);
const dock = win.locator('aside.dock');
await shot('picker-rest', '.insp-pick-many', { themes: ['light'], el: dock });
const picks = picker.locator('.insp-pick-tile');
for (const i of [1, 3, 2]) await picks.nth(i).click();
await pause(300);
await picks.first().evaluate((el) => el.closest('.insp-pick-grid').scrollTo(0, 0));
await picker.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await pause(300);
await shot('picker', '.insp-pick-order', { el: dock });
await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
await picker.waitFor({ state: 'detached', timeout: 5000 });
await back();

// Every unused image removed: their files are kept for Undo, and Free up space says what it would delete.
await win.getByRole('radio', { name: /^Unused/ }).click();
await pause(300);
await win.locator('.asset-cleanup .btn-danger').click();
const storage = win.getByTestId('asset-storage');
await storage.getByText('Kept for Undo').waitFor({ timeout: 30000 });
await scrollBody('end');
await pause(300);
await shot('storage-kept', '.asset-storage', { themes: ['light'] });
await storage.getByRole('button', { name: /^Free .+…$/ }).click();
await win.getByTestId('free-space-dialog').waitFor({ timeout: 10000 });
await pause(300);
await shot('free-space', '[data-testid="free-space-dialog"]', { window: true });
await win.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
await win.getByTestId('free-space-dialog').waitFor({ state: 'detached', timeout: 5000 });
if (!(await win.evaluate(() => window.builder.project.undo())).ok) throw new Error('could not undo the clean-up');
await win.locator('[data-asset]').nth(12).waitFor({ timeout: 20000 });
await scrollBody(0);
await pause(400);

// Files gone from the project folder, on placed images listed first: every file of one, only the original of
// another (its smaller copies still show), and one smaller copy of a third.
const snapB = await snapshot();
const placedImages = Object.values(snapB.state.assets.assets).filter((a) => a.kind === 'image' && snapB.assetUsage[a.id] && a.variants?.length > 1);
const lost = placedImages.find((a) => a.name === 'Hero interior') ?? placedImages[0];
const [thinned, stripped] = placedImages.filter((a) => a.id !== lost?.id);
if (!lost || !thinned || !stripped) throw new Error('not enough placed images to take the files of');
for (const f of [lost.file, ...lost.variants.map((v) => v.file), thinned.variants[0].file, stripped.file]) rmSync(join(snapB.dir, f), { force: true });
await win.locator('.side-panel-view:not([hidden]) [aria-label="Sort images"]').selectOption('oldest');
await win.locator('.asset-gone').nth(2).waitFor({ timeout: 30000 });
await scrollBody(0);
await pause(800);
await shot('missing', '.asset-gone');
// Every damaged image at once, whatever the order: the Missing filter.
await win.getByRole('radio', { name: /^Missing/ }).click();
await pause(300);
await shot('missing-filter', '.asset-gone', { themes: ['light'] });
await win.getByRole('radiogroup', { name: 'Filter images' }).getByRole('radio', { name: /^All/ }).click();
await pause(300);
await win.locator(`[data-asset="${lost.id}"]`).click();
await pause(400);
await shot('detail-missing', '.asset-missing');
await back();
await win.locator(`[data-asset="${stripped.id}"]`).click();
await pause(400);
await shot('detail-original-missing', '.asset-missing', { themes: ['light'] });
await back();
await win.locator(`[data-asset="${thinned.id}"]`).click();
await pause(400);
await shot('detail-copies-missing', '.asset-missing', { themes: ['light'] });
await back();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('assets-') && f.endsWith('.png')).length;
console.log(`media gallery capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
