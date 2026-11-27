// Design capture harness for the Assets grid's tile states: a picture whose files are missing (all of them, only the
// original, or a smaller copy), the size chip on a large file, two pictures that share a name, the compact grid, the
// picker that replaces a picture (where damaged pictures can't be picked), choosing the places a replacement reaches
// with one picture picked, and the panel at its narrowest. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/assets-tiles.mjs
//
// Fixtures go through the app's own import seam and files are taken from the project folder on disk, as a user
// moving them away would. Each capture is verified after it settles; a state that did not render throws instead of
// writing a plausible-looking wrong image. Files are named `tiles-{state}--{theme}.png`, cropped to the sidebar.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('assets tiles capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'assets-tiles');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-tiles-')));
const THEMES = ['light', 'dark'];
const STARTER = resolve('resources/starter-assets');

// ---- Fixtures: a large file, two pictures that share a name, and a few ordinary photos ----
const FIX = join(WORK, 'fixtures');
const fixtures = [];
const sips = (src, w, dest, png = false) => {
  mkdirSync(join(dest, '..'), { recursive: true });
  execFileSync('sips', [...(png ? ['-s', 'format', 'png'] : []), '-Z', String(w), join(STARTER, src), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
};
// Over the 1.5 MB "Large file" threshold.
sips('studio.jpg', 2200, join(FIX, 'warehouse-wide-shot-uncompressed-original.png'), true);
sips('kitchen.jpg', 1200, join(FIX, 'a', 'shopfront.jpg'));
sips('dining.jpg', 900, join(FIX, 'b', 'shopfront.jpg'));
sips('reading.jpg', 1000, join(FIX, 'team-offsite-2026.jpg'));
sips('person-2.jpg', 800, join(FIX, 'portrait-hannah-wells-crop.jpg'));

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
/** Capture a state; `check` must be visible at the moment of capture. `keep` skips the pointer move (hover states). */
async function shot(state, check, { themes = THEMES, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keep) await win.mouse.move(900, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `tiles-${state}--${theme}.png`);
    await panel.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const waitThumbs = async () => {
  await win.waitForFunction(() => [...document.querySelectorAll('aside.side-panel img')].filter((i) => i.getBoundingClientRect().height > 0).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 }).catch(() => {});
  await pause(400);
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

// ---- The Business starter, its sample images placed across the site, plus the fixtures ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await win.locator('.rail [aria-label="Assets"]').click();
await pause(600);
const r = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures);
if (!r.assetIds.length) throw new Error(`fixture import failed: ${r.message}`);
await pause(1200);

// One picture placed in three spots, so replacing it offers Choose places: the first single-image prop's picture is
// given to two more, through the app's own edit seam.
const snap0 = await snapshot();
const spots = Object.entries(snap0.state.pages).flatMap(([pageId, p]) => Object.values(p.nodes).filter((n) => n.kind === 'instance' && n.props?.image?.assetId).map((n) => ({ pageId, nodeId: n.id, image: n.props.image })));
if (spots.length < 3) throw new Error(`the starter places only ${spots.length} single images`);
const shared = spots[0].image.assetId;
const others = spots.filter((s) => s.image.assetId !== shared).slice(0, 2);
const placedTwice = await win.evaluate(
  ([ops]) => window.builder.project.apply({ operations: ops }, { label: 'Use one picture three times' }),
  [others.map((s) => ({ type: 'instance.setProp', owner: { kind: 'page', id: s.pageId }, nodeId: s.nodeId, prop: 'image', value: { ...s.image, assetId: shared } }))]
);
if (!placedTwice.ok) throw new Error(`could not place the picture again: ${placedTwice.message}`);
await pause(600);

// The picture to replace: the placed one with the most uses (so Choose places is offered). Then the files of three
// others go: every file of one, only the original of another, one smaller copy of a third.
const snap = await snapshot();
const images = Object.values(snap.state.assets.assets).filter((a) => a.kind === 'image');
const placed = images.filter((a) => snap.assetUsage[a.id] && a.variants?.length > 1).sort((a, b) => snap.assetUsage[b.id] - snap.assetUsage[a.id]);
const target = placed[0];
if (!target || snap.assetUsage[target.id] < 2) throw new Error('no picture is placed twice, so Choose places has nothing to choose between');
const [lost, stripped, thinned] = placed.slice(1);
if (!lost || !stripped || !thinned) throw new Error('not enough placed pictures to take the files of');
for (const f of [lost.file, ...lost.variants.map((v) => v.file), stripped.file, thinned.variants[0].file]) rmSync(join(snap.dir, f), { force: true });
// Oldest first keeps the starter's pictures, the damaged ones among them, at the top of the grid.
await win.locator(`${view} select.asset-order-sort`).selectOption('oldest');
await win.locator('.asset-gone').nth(2).waitFor({ timeout: 30000 });
await waitThumbs();
await shot('grid', '.asset-gone');
// The end of the grid: the large file's size chip and the two pictures that share a name.
await win.locator(`${view} .panel-body`).evaluate((el) => (el.scrollTop = el.scrollHeight));
await pause(300);
await waitThumbs();
await shot('grid-end', '.asset-tile-id');
await win.locator(`${view} .panel-body`).evaluate((el) => (el.scrollTop = 0));
await pause(200);

// Hover on a damaged tile, then keyboard focus on one.
await win.locator(`[data-asset="${lost.id}"]`).hover();
await pause(200);
await shot('grid-hover-missing', `[data-asset="${lost.id}"]:hover`, { themes: ['light'], keep: true });
await win.keyboard.press('Shift');
await win.locator(`[data-asset="${lost.id}"]`).focus();
await shot('grid-focus-missing', `[data-asset="${lost.id}"]:focus-visible`, { themes: ['light'], keep: true });

// The compact grid: pictures only.
const density = win.locator(`${view} .asset-density`);
await density.click();
await pause(300);
await waitThumbs();
await shot('compact', '.asset-grid.compact .asset-gone');
await density.click();
await pause(300);

// Replacing the most-used picture: the damaged pictures can't be picked here.
await win.locator(`[data-asset="${target.id}"]`).click();
await win.locator('.asset-detail').waitFor();
await win.getByRole('button', { name: /Replace everywhere/ }).first().click();
await win.locator('.asset-replace').waitFor();
await waitThumbs();
await shot('replace-blocked', '.asset-replace .asset-tile.blocked');

// Choosing places, with every place ticked but one, and a picture picked to show there.
await win.locator('.asset-choose-open').click();
await win.locator('.asset-choose').waitFor();
await win.locator('.asset-choose input[type="checkbox"]').last().uncheck();
const pickable = win.locator('.asset-replace .asset-tile:not(.blocked)');
await pickable.nth(1).click();
await win.locator('.asset-tile.picked').waitFor();
await win.locator(`${view} .panel-body`).evaluate((el) => (el.scrollTop = 0));
await waitThumbs();
await shot('choose-picked', '.asset-choose');
await win.locator('.asset-choose label.asset-use').first().hover();
await pause(150);
await shot('choose-hover', '.asset-choose label.asset-use:hover', { themes: ['light'], keep: true });
// The grid under the list: the picked tile beside a blocked one.
await win.locator('.asset-tile.picked').scrollIntoViewIfNeeded();
await pause(200);
await shot('choose-grid', '.asset-tile.picked', { themes: ['light'] });

// The sidebar at its narrowest, choosing places and then the grid with its header.
const grip = win.getByRole('separator', { name: 'Resize sidebar' });
await grip.focus();
await win.keyboard.press('Home');
await pause(500);
await win.locator('.asset-choose-sum').click();
await win.locator(`${view} .panel-body`).evaluate((el) => (el.scrollTop = 0));
await pause(200);
await shot('narrow-choose', '.asset-choose', { themes: ['light'] });
// The large file picked, its size chip beside the picked check: at the narrowest, then in the compact grid.
const large = images.reduce((a, b) => (b.bytes > a.bytes ? b : a));
const largeTile = win.locator(`.asset-replace [data-asset="${large.id}"]`);
await largeTile.click();
await win.locator(`.asset-tile.picked[data-asset="${large.id}"]`).waitFor();
await largeTile.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await pause(200);
await waitThumbs();
await shot('narrow-picked-large', '.asset-tile.picked .asset-size', { themes: ['light'] });
await grip.focus();
await win.keyboard.press('End');
await pause(400);
await density.click();
await pause(300);
await largeTile.evaluate((el) => el.scrollIntoView({ block: 'center' }));
await waitThumbs();
await shot('compact-picked-large', '.asset-grid.compact .asset-tile.picked .asset-size', { themes: ['light'] });
await density.click();
await grip.focus();
await win.keyboard.press('Home');
await pause(400);
await win.locator('.asset-choose-foot').getByRole('button', { name: 'Every place instead' }).click();
await win.locator('.asset-replace-top .asset-back').click();
await win.locator('.asset-detail').waitFor();
await win.locator('.asset-detail .asset-back').click();
await win.locator('[data-asset]').first().waitFor();
await waitThumbs();
await shot('narrow-grid', '.asset-gone', { themes: ['light'] });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('tiles-') && f.endsWith('.png')).length;
console.log(`assets tiles capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
