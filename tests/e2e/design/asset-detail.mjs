// Design capture harness for one image's details in Assets (the pane that replaces the grid): a picture used in many
// places, an unused one carrying the large-file and recorded-location notes, a picture whose files are all missing,
// one missing only its original, the alt text check after a replacement, and the pane at the sidebar's narrowest.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/asset-detail.mjs
//
// Fixtures go through the app's own import seam, uses through its edit seam, and files are taken from the project
// folder on disk, as a user moving them away would. The window is made tall enough that the whole pane is in one
// image (`full`), and one state is also taken at the usual height (`fold`), to show what is seen without scrolling.
// Each capture is verified after it settles; a state that did not render throws instead of writing a wrong image.
// Files are named `detail-{state}--{theme}.png`, cropped to the sidebar.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('asset detail capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'asset-detail');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-detail-')));
const STARTER = resolve('resources/starter-assets');
const TALL = 2000;

// ---- Fixtures: a large photo that records where it was taken, and an ordinary one to replace with ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const gps = { IFD0: { Make: 'Fujifilm', Model: 'X-T5' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 0/1' } };
const stacked = join(FIX, 'harbour-lane-rooftop-terrace-golden-hour.jpg');
await sharp(join(STARTER, 'studio.jpg')).resize(4200).withExif(gps).jpeg({ quality: 100 }).toFile(stacked);
const plain = join(FIX, 'team-offsite-2026.jpg');
execFileSync('sips', ['-Z', '1000', join(STARTER, 'reading.jpg'), '--out', plain], { stdio: 'ignore' });

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
const view = '.side-panel-view:not([hidden])';

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
const waitImages = async () => {
  await win.waitForFunction(() => [...document.querySelectorAll('aside.side-panel img')].filter((i) => i.getBoundingClientRect().height > 0).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 }).catch(() => {});
  await pause(400);
};
/** Capture the open details; `check` must be visible. `height` is the window's; the pane scrolls to its top first. */
async function shot(state, check, { themes = ['light'], height = TALL } = {}) {
  await win.setViewportSize({ width: 1440, height });
  await pause(400);
  await win.locator(`${view} .panel-body`).evaluate((el) => (el.scrollTop = 0));
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(900, 450);
    await waitImages();
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    // Crop to the pane's own height, so a tall window's empty panel below it is not in the image.
    const box = await panel.boundingBox();
    const body = await win.locator(`${view} .asset-detail`).boundingBox();
    const bottom = Math.min(box.y + box.height, body.y + body.height + 12);
    const path = join(OUT, `detail-${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: box.x, y: box.y, width: box.width, height: bottom - box.y } });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
  await win.setViewportSize({ width: 1440, height: 900 });
  await pause(200);
}
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const open = async (id) => {
  if (await win.locator('.asset-detail').isVisible().catch(() => false)) {
    await win.locator('.asset-detail .asset-back').click();
    await win.locator('[data-asset]').first().waitFor();
  }
  await win.locator(`${view} [data-asset="${id}"]`).click();
  await win.locator('.asset-detail').waitFor();
  await pause(600);
};

// ---- The Business starter, its sample images placed across the site, plus the fixtures ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await win.locator('.rail [aria-label="Assets"]').click();
await pause(600);
const r = await win.evaluate((paths) => window.builder.project.importAssets(paths), [stacked, plain]);
if (r.assetIds.length < 2) throw new Error(`fixture import failed: ${r.message}`);
await pause(1200);

// One picture in seven places, so its list folds past four: every single-image block, two copies of the first, and
// the home page's and the site's sharing image. One of its uses keeps alt text of its own.
const snap0 = await snapshot();
const spots = Object.entries(snap0.state.pages).flatMap(([pageId, p]) => Object.values(p.nodes).filter((n) => n.kind === 'instance' && n.props?.image?.assetId).map((n) => ({ pageId, nodeId: n.id, image: n.props.image })));
if (spots.length < 3) throw new Error(`the starter places only ${spots.length} single images`);
const shared = spots[0].image.assetId;
const others = spots.filter((s) => s.image.assetId !== shared).slice(0, 2);
const first = { kind: 'page', id: spots[0].pageId };
const ops = [
  ...others.map((s, i) => ({ type: 'instance.setProp', owner: { kind: 'page', id: s.pageId }, nodeId: s.nodeId, prop: 'image', value: { ...s.image, assetId: shared, ...(i === 0 ? { alt: 'Sam and Priya at the long table, planning the spring menu' } : {}) } })),
  { type: 'node.duplicate', owner: first, nodeId: spots[0].nodeId },
  { type: 'node.duplicate', owner: first, nodeId: spots[0].nodeId },
  { type: 'page.update', pageId: snap0.state.site.homePageId, socialImage: shared },
  { type: 'site.update', socialImage: shared }
];
const placed = await win.evaluate(([o]) => window.builder.project.apply({ operations: o }, { label: 'Use one picture in more places' }), [ops]);
if (!placed.ok) throw new Error(`could not place the picture again: ${placed.message}`);
await pause(800);

const snap = await snapshot();
const images = Object.values(snap.state.assets.assets).filter((a) => a.kind === 'image');
const many = snap.state.assets.assets[shared];
if ((snap.assetUsage[shared] ?? 0) < 5) throw new Error(`the shared picture is used ${snap.assetUsage[shared]} times, not five or more`);
const big = images.find((a) => a.originalName?.startsWith('harbour-lane-rooftop') || a.name.startsWith('harbour-lane-rooftop'));
if (!big || big.bytes < 1_500_000) throw new Error(`the large fixture is ${big?.bytes} bytes, under the large-file threshold`);
const used = images.filter((a) => a.id !== shared && snap.assetUsage[a.id] && a.variants?.length > 1);
const [lost, stripped] = used;
if (!lost || !stripped) throw new Error('not enough placed pictures to take the files of');
for (const f of [lost.file, ...lost.variants.map((v) => v.file), stripped.file]) rmSync(join(snap.dir, f), { force: true });
await win.locator(`${view} [aria-label="Sort images"]`).selectOption('oldest');
await win.locator('.asset-gone').nth(1).waitFor({ timeout: 30000 });
await pause(400);

// A picture used in many places: the whole pane, then only what shows without scrolling, then every place shown.
await open(many.id);
await shot('used', '.asset-uses .asset-more', { themes: ['light', 'dark'] });
await shot('used-fold', '.asset-detail .asset-place', { height: 900 });
await win.locator('.asset-uses .asset-more').click();
await pause(300);
await shot('used-all', '.asset-uses li:nth-child(5)');

// Unused, large, and recording where it was taken: two notes stacked, and Remove.
await open(big.id);
await win.locator('[data-testid="asset-location-note"]').waitFor({ timeout: 15000 });
await win.locator('[data-testid="asset-large-note"]').waitFor();
await pause(800);
await shot('unused-notes', '[data-testid="asset-location-note"]', { themes: ['light', 'dark'] });

// Every file missing, then only the original.
await open(lost.id);
await shot('missing-all', '.asset-note.asset-missing', { themes: ['light', 'dark'] });
await open(stripped.id);
await shot('missing-original', '.asset-note.asset-missing');

// Replaced everywhere: the alt text check on the picture that was replaced.
await open(many.id);
await win.getByRole('button', { name: /Replace everywhere/ }).first().click();
await win.locator('.asset-replace').waitFor();
await waitImages();
const plainId = r.assetIds.find((id) => id !== big.id);
await win.locator(`.asset-replace [data-asset="${plainId}"]`).click();
await win.locator('[data-testid="asset-alt-review"]').waitFor({ timeout: 15000 });
await pause(600);
await shot('alt-review', '[data-testid="asset-alt-review"]', { themes: ['light', 'dark'] });

// A picture missing its original, replaced everywhere from its note: both notes at once, the missing file first.
await open(stripped.id);
await win.locator('.asset-missing').getByRole('button', { name: /Replace everywhere/ }).click();
await win.locator('.asset-replace').waitFor();
await waitImages();
await win.locator(`.asset-replace [data-asset="${plainId}"]`).click();
await win.locator('[data-testid="asset-alt-review"]').waitFor({ timeout: 15000 });
await pause(600);
await shot('missing-review', '.asset-note.asset-missing ~ [data-testid="asset-alt-review"]');

// The sidebar at its narrowest: the picture that is now used in every place.
const grip = win.getByRole('separator', { name: 'Resize sidebar' });
await grip.focus();
await win.keyboard.press('Home');
await pause(500);
await open(plainId);
await shot('narrow-used', '.asset-uses .asset-more');
await open(big.id);
await win.locator('[data-testid="asset-location-note"]').waitFor({ timeout: 15000 });
await pause(600);
await shot('narrow-notes', '[data-testid="asset-location-note"]');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('detail-') && f.endsWith('.png')).length;
console.log(`asset detail capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
