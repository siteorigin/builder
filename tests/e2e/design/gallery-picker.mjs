// Design capture harness for the gallery's image picker in the Inspector (Choose images…). Drives the real built
// app through the picker's states in light and dark and writes one PNG per state and theme. Opt-in only, never
// part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/gallery-picker.mjs
//
// The fixtures go through the app's own import seam (project.importAssets with file paths): long names, a
// numbered series, two images with the same name, a transparent logo. Each capture is verified after it
// settles; a state that did not render throws instead of writing a plausible-looking wrong image. Files are
// named `picker-{state}--{theme}.png` and show the right panel as the author sees it.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('gallery picker capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'gallery-picker');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-picker-')));
const THEMES = ['light', 'dark'];
const STARTER = resolve('resources/starter-assets');

// ---- Fixtures: distinct bytes per file (imports dedupe by hash) ----
const FIX = join(WORK, 'fixtures');
mkdirSync(join(FIX, 'second-card'), { recursive: true });
const photos = ['hero', 'studio', 'kitchen', 'bedroom', 'reading', 'dining', 'person-1', 'person-2', 'person-3'];
const names = [
  'harbour-lane-living-room-oak-floor-afternoon-light-final-v3',
  'kitchen-renovation-before-after-stone-benchtop',
  'portrait-hannah-wells-crop',
  'dining-room-tall-window-winter',
  'screenshot-2026-10-14-at-09.41.22',
  'brand-photo-shoot-selects-03',
  'reading-nook',
  'studio-wide',
  'bedroom-linen'
];
const fixtures = [];
photos.forEach((p, i) => {
  const dest = join(FIX, `${names[i]}.jpg`);
  execFileSync('sips', ['-Z', '900', join(STARTER, `${p}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
});
// A numbered series: the endings are what tell them apart.
for (let i = 1; i <= 5; i++) {
  const dest = join(FIX, `team-offsite-2026-${1300 - i * 100}.jpg`);
  execFileSync('sips', ['-Z', String(600 + i * 10), join(STARTER, `${photos[i + 1]}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
}
// Two pictures with the same name, from two cards: the picker tells them apart by ID.
for (const [dir, p, w] of [['', 'person-1', 700], ['second-card', 'person-3', 710]]) {
  const dest = join(FIX, dir, 'IMG_4821.jpg');
  execFileSync('sips', ['-Z', String(w), join(STARTER, `${p}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
}
// A wide transparent logo, shown whole on the checker.
const logo = join(FIX, 'harbour-lane-logo-horizontal.svg');
writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="140" viewBox="0 0 640 140"><circle cx="70" cy="70" r="46" fill="#1b5e7a"/><text x="140" y="92" font-family="Georgia" font-size="64" fill="#1b5e7a">Harbour Lane</text></svg>');
fixtures.push(logo);

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

const dock = win.locator('aside.dock');
const picker = win.locator('.insp-pick-many');
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
const waitThumbs = async () => {
  // The pictures in view inside their scroller (lazy ones further down never load until scrolled to).
  await win
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.insp-pick-many img')]
          .filter((i) => {
            const r = i.getBoundingClientRect();
            const box = (i.closest('.insp-pick-grid, .insp-pick-order') ?? document.body).getBoundingClientRect();
            return r.height > 0 && r.bottom > Math.max(0, box.top) && r.top < Math.min(innerHeight, box.bottom);
          })
          .every((i) => i.complete && i.naturalWidth > 0),
      null,
      { timeout: 30000 }
    )
    .catch(() => {});
  await pause(500);
};
/** Capture the right panel; `check` must be visible at the moment of capture. `keep` skips the pointer move. */
async function shot(state, check, { themes = THEMES, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    // The pointer rests on the empty toolbar, away from every tile, so no capture carries a leftover hover.
    if (!keep) await win.mouse.move(460, 25);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `picker-${state}--${theme}.png`);
    await dock.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
/** The picker's heading at the top of the panel, or its foot (the order and Add) at the bottom. */
const toTop = async () => {
  await picker.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await pause(300);
};
const toEnd = async () => {
  await picker.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await pause(300);
};
const seam = win.getByRole('separator', { name: 'Resize right panel' });
const width = async (key) => {
  await seam.focus();
  await win.keyboard.press(key);
  await pause(500);
};
const tiles = picker.locator('.insp-pick-tile');
const search = picker.locator('input[type="search"]');

// ---- The Business starter, then the fixtures through the real import seam ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
const r = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures);
if (!r.ok && !r.assetIds.length) throw new Error(`fixture import failed: ${r.message}`);
console.log(`imported ${r.assetIds.length} fixtures${r.message ? ` (${r.message})` : ''}`);
await pause(1200);

// The gallery, reached from where one of its images is used.
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const snapA = await snapshot();
let galleryImage;
for (const p of Object.values(snapA.state.pages)) {
  for (const n of Object.values(p.nodes)) {
    if (!galleryImage && n.kind === 'instance' && snapA.state.components[n.definitionId]?.componentId === 'media.gallery') galleryImage = n.props.images[0].image.assetId;
  }
}
if (!galleryImage) throw new Error('the starter has no gallery to open the picker on');
await win.locator('.rail [aria-label="Assets"]').click();
await pause(600);
await win.locator(`[data-asset="${galleryImage}"]`).click();
await win.locator('.asset-detail').waitFor();
await win.locator('.asset-use', { hasText: /gallery/i }).first().click();
const openPicker = async () => {
  await win.locator('.insp-pick-open').first().click();
  await picker.waitFor({ timeout: 10000 });
  await pause(600);
  await waitThumbs();
};
const cancel = async () => {
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await picker.waitFor({ state: 'detached', timeout: 5000 });
};
/** Choose tiles by their place in the grid, in the order given. */
const choose = async (places) => {
  for (const i of places) await tiles.nth(i).click();
  await picker.locator('.insp-pick-grid').evaluate((el) => el.scrollTo(0, 0));
  await pause(300);
};

// The library browser only shows the gallery's own Assets in the sidebar; the picker lives in the right panel.
await openPicker();
await toTop();
await shot('rest', '.insp-pick-grid');

await choose([2, 0, 5, 9]);
await toTop();
await waitThumbs();
await shot('chosen', '.insp-pick-order');
await toEnd();
await shot('chosen-end', '.insp-pick-order', { themes: ['light'] });
// The way past a long order to Add, shown only while it has keyboard focus.
await win.keyboard.press('Shift');
await picker.locator('.insp-pick-skip').focus();
await toTop();
await shot('skip', '.insp-pick-skip:focus-visible', { themes: ['light'], keep: true });

// Keyboard focus on a tile in the grid.
await win.keyboard.press('Shift');
await tiles.first().focus();
await win.keyboard.press('ArrowRight');
await pause(200);
await toTop();
await shot('focus', '.insp-pick-tile:focus-visible', { themes: ['light'], keep: true });

// The narrowest and widest right panel.
await width('Home');
await toTop();
await waitThumbs();
await shot('narrow', '.insp-pick-order', { themes: ['light'] });
await width('End');
await toTop();
await waitThumbs();
await shot('wide', '.insp-pick-order', { themes: ['light'] });
await win.locator('.resizer[aria-label="Resize right panel"]').dblclick();
await pause(500);

// A search that finds a few, one that finds two images with the same name, and one that finds nothing.
await search.fill('team');
await pause(300);
await toTop();
await waitThumbs();
await shot('search', '.insp-pick-result', { themes: ['light'] });
await search.fill('4821');
await pause(300);
await waitThumbs();
await shot('same-name', '.insp-pick-id', { themes: ['light'] });
await search.fill('zebra crossing');
await pause(300);
await shot('no-match', '.insp-pick-nomatch', { themes: ['light'] });
await search.fill('');
await pause(300);
await cancel();

// A full gallery: every place left taken, the rest can't be chosen, and the order is long.
await openPicker();
// The grid draws only the rows near its view: the images are counted by the list's size, and chosen from the
// keyboard, which brings each next one into view.
const count = Number(await tiles.first().getAttribute('aria-setsize'));
if (count < 25) throw new Error(`only ${count} images to choose from; a full gallery needs 25`);
await tiles.first().focus();
for (let i = 0; i < count; i++) {
  const at = picker.locator('.insp-pick-tile:focus');
  if ((await at.getAttribute('aria-disabled')) === 'true') break;
  await win.keyboard.press('Space');
  await win.keyboard.press('ArrowRight');
}
await picker.locator('.insp-pick-grid').evaluate((el) => el.scrollTo(0, 0));
await pause(300);
await toTop();
// The first images that can't be chosen, in view in the grid.
await picker.locator('.insp-pick-tile[aria-disabled="true"]').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await toTop();
await waitThumbs();
await shot('full', '.insp-pick-tile[aria-disabled="true"]', { themes: ['light'] });
await toEnd();
await shot('full-end', '.insp-pick-order', { themes: ['light'] });
await cancel();

// Files gone from the project folder: every file of one image, the smaller copies of another. One is chosen first.
const snapB = await snapshot();
const byName = (re) => Object.values(snapB.state.assets.assets).find((a) => a.kind === 'image' && re.test(a.name));
const lost = byName(/portrait hannah/i);
const thinned = byName(/dining room tall/i);
const stripped = byName(/brand photo/i);
if (!lost || !thinned || !stripped || !thinned.variants?.length) throw new Error('fixtures for the missing state were not found');
await openPicker();
const lostTile = picker.locator('.insp-pick-tile[title*="hannah" i]').first();
await lostTile.click();
await tiles.nth(0).click();
for (const f of [lost.file, ...lost.variants.map((v) => v.file), ...thinned.variants.map((v) => v.file), stripped.file, ...stripped.variants.map((v) => v.file)]) rmSync(join(snapB.dir, f), { force: true });
await picker.locator('.insp-pick-gone').nth(2).waitFor({ timeout: 30000 });
await picker.locator('.insp-pick-grid').evaluate((el) => el.scrollTo(0, 0));
await toTop();
await pause(800);
await shot('missing', '.insp-pick-gone');
await toEnd();
await shot('missing-end', '.insp-pick-order-miss', { themes: ['light'] });
// The ones not chosen: a picture whose smaller copies are gone, and one with no file left.
await picker.locator('.insp-pick-tile[title*="brand photo" i]').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await toTop();
await pause(600);
await shot('missing-unchosen', '.insp-pick-tile[aria-disabled="true"] .insp-pick-gone');
// Leaving the damaged image out from the foot: Add works again.
await picker.getByRole('button', { name: 'Leave it out' }).click();
await picker.locator('.insp-pick-fix').waitFor({ state: 'detached', timeout: 5000 });
await toEnd();
await shot('missing-left-out', '.insp-pick-foot', { themes: ['light'] });
await cancel();

// The reviewed sibling: the media library grid in the sidebar, for comparison.
await win.locator('.asset-back').first().click().catch(() => {});
await pause(400);
const side = win.locator('aside.side-panel');
await side.locator('[data-asset]').first().waitFor();
await pause(600);
const sib = join(OUT, 'picker-assets-sibling--light.png');
await side.screenshot({ path: sib });
written.push(sib);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const pngs = readdirSync(OUT).filter((f) => f.startsWith('picker-') && f.endsWith('.png')).length;
console.log(`gallery picker capture: ${written.length} written, ${pngs} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (pngs < written.length) throw new Error('fewer PNGs on disk than captures written');
