// Design capture harness for the order controls over a grid of images (Sort, and the numbered-series filter): in
// Assets at rest and with a series chosen, at the sidebar's narrowest, and inside the Inspector's image browser and the
// gallery picker. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/asset-order.mjs
//
// Fixtures go through the app's own import seam: three numbered series (a short one, one with a long name, a long run
// of swatches) beside ordinary photos. A native menu can't be captured, so each state also writes what its menus offer
// to `order-{state}.txt`. Each capture is verified after it settles; a state that did not render throws instead of
// writing a plausible-looking wrong image. Files are named `order-{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('asset order capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'asset-order');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-order-')));
const THEMES = ['light', 'dark'];
const STARTER = resolve('resources/starter-assets');

// ---- Fixtures: distinct bytes per file (imports dedupe by hash) ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const photos = ['hero', 'studio', 'kitchen', 'bedroom', 'reading', 'dining', 'person-1', 'person-2', 'person-3'];
const fixtures = [];
let size = 400;
const add = (name, from) => {
  const dest = join(FIX, `${name}.jpg`);
  execFileSync('sips', ['-Z', String(size++), join(STARTER, `${from}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
};
for (let i = 1; i <= 5; i++) add(`team-offsite-2026-${1300 - i * 100}`, photos[i]);
for (let i = 1; i <= 4; i++) add(`harbour-lane-brand-photo-shoot-selects-final-edit-${String(i).padStart(2, '0')}`, photos[i + 3]);
for (let i = 1; i <= 14; i++) add(`Swatch ${i}`, photos[i % photos.length]);
['reading-nook', 'portrait-hannah-wells-crop', 'dining-room-tall-window-winter'].forEach((n, i) => add(n, photos[i + 6]));

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

const view = '.side-panel-view:not([hidden])';
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
const waitThumbs = async (scope) => {
  await win
    .waitForFunction((s) => [...document.querySelectorAll(`${s} img`)].filter((i) => { const r = i.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight; }).every((i) => i.complete && i.naturalWidth > 0), scope, { timeout: 30000 })
    .catch(() => {});
  await pause(400);
};
/** What every order control in `scope` offers, written beside the captures (a native menu never reaches a screenshot). */
async function menus(state, scope) {
  const text = await win.evaluate((s) => {
    const root = document.querySelector(s);
    const row = root?.querySelector('.asset-order');
    if (!row) return '(no order controls)';
    const out = [`row text: ${JSON.stringify(row.innerText)}`];
    for (const sel of row.querySelectorAll('select')) {
      const name = sel.labels?.[0]?.innerText || sel.getAttribute('aria-label');
      out.push(`select "${name}" (aria-label=${JSON.stringify(sel.getAttribute('aria-label'))}, title=${JSON.stringify(sel.title)}) value=${JSON.stringify(sel.value)}`);
      for (const node of sel.children) {
        if (node.tagName === 'OPTGROUP') {
          out.push(`  [group] ${node.label}`);
          for (const o of node.children) out.push(`    ${o.selected ? '*' : ' '} ${JSON.stringify(o.textContent)}${o.title ? ` title=${JSON.stringify(o.title)}` : ''}`);
        } else out.push(`  ${node.selected ? '*' : ' '} ${JSON.stringify(node.textContent)}${node.title ? ` title=${JSON.stringify(node.title)}` : ''}`);
      }
    }
    for (const b of row.querySelectorAll('button')) out.push(`button ${JSON.stringify(b.innerText)} aria-label=${JSON.stringify(b.getAttribute('aria-label'))} title=${JSON.stringify(b.title)}`);
    const status = root.querySelector('[role="status"]');
    if (status) out.push(`status: ${JSON.stringify(status.innerText)}`);
    return out.join('\n');
  }, scope);
  writeFileSync(join(OUT, `order-${state}.txt`), text + '\n');
}
/** Capture `target`; `check` must be visible at the moment of capture. */
async function shot(state, target, check, { themes = THEMES, scope } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(700, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `order-${state}--${theme}.png`);
    await win.locator(target).first().screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  if (scope) await menus(state, scope);
  await setTheme('light');
}

// ---- The Business starter, then the fixtures through the real import seam ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1200);
await win.locator('.rail [aria-label="Assets"]').click();
await pause(600);
const r = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures);
if (!r.assetIds.length) throw new Error(`fixture import failed: ${r.message}`);
await pause(1500);

// ---- Assets ----
const panel = 'aside.side-panel';
const seriesIn = (scope) => win.locator(`${scope} select.asset-series`);
/** Choose the series whose name matches `re`. */
const pickSeries = async (scope, re) => {
  const value = await seriesIn(scope).evaluate((s, src) => [...s.options].find((o) => new RegExp(src, 'i').test(o.textContent))?.value, re);
  if (!value) throw new Error(`no series matching ${re}`);
  await seriesIn(scope).selectOption(value);
};
await win.locator(`${view} [data-asset]`).first().waitFor();
await waitThumbs(panel);
await shot('assets-rest', panel, `${view} .asset-order`, { scope: view });
await pickSeries(view, 'swatch');
await pause(400);
await waitThumbs(panel);
await shot('assets-series', panel, `${view} .asset-order`, { scope: view });
// The long-named series: how its name sits in the closed control.
await pickSeries(view, 'harbour');
await pause(400);
await waitThumbs(panel);
await shot('assets-series-long', panel, `${view} .asset-order`, { themes: ['light'], scope: view });

// The sidebar at its narrowest, the long series still chosen, then with none.
const grip = win.getByRole('separator', { name: 'Resize sidebar' });
await grip.focus();
await win.keyboard.press('Home');
await pause(500);
await waitThumbs(panel);
await shot('assets-narrow-series', panel, `${view} .asset-order`, { themes: ['light'], scope: view });
await seriesIn(view).selectOption('');
await pause(400);
await shot('assets-narrow-rest', panel, `${view} .asset-order`, { themes: ['light'], scope: view });
await grip.focus();
await win.keyboard.press('End');
await pause(300);
await grip.dblclick().catch(() => {});
await pause(500);

// ---- The gallery picker in the Inspector ----
const snap = await win.evaluate(() => window.builder.project.snapshot());
let galleryImage;
for (const p of Object.values(snap.state.pages))
  for (const n of Object.values(p.nodes)) if (!galleryImage && n.kind === 'instance' && snap.state.components[n.definitionId]?.componentId === 'media.gallery') galleryImage = n.props.images[0].image.assetId;
if (!galleryImage) throw new Error('the starter has no gallery to open the picker on');
await win.locator(`[data-asset="${galleryImage}"]`).click();
await win.locator('.asset-detail').waitFor();
await win.locator('.asset-use', { hasText: /gallery/i }).first().click();
await win.locator('.insp-pick-open').first().click();
const picker = '.insp-pick-many';
await win.locator(picker).waitFor({ timeout: 10000 });
await win.locator(picker).evaluate((el) => el.scrollIntoView({ block: 'start' }));
await pause(600);
await waitThumbs(picker);
await shot('picker-rest', 'aside.dock', `${picker} .asset-order`, { scope: picker });
await pickSeries(picker, 'swatch');
await pause(400);
await waitThumbs(picker);
await shot('picker-series', 'aside.dock', `${picker} .asset-order`, { scope: picker });
await win.locator(picker).getByRole('button', { name: 'Cancel', exact: true }).click();
await pause(400);

// ---- The Inspector's image browser (a single image) ----
await win.locator('.rail [aria-label="Layers"]').click();
await pause(300);
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
const card = win.locator('#dock-panel-inspect .insp-image').first();
await card.waitFor({ timeout: 30000 });
await card.getByRole('button', { name: /^(Change|Choose)/ }).first().click();
const pop = '.insp-image-pop';
await win.locator(pop).first().waitFor({ timeout: 10000 });
await win.locator(pop).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
await pause(600);
await waitThumbs(pop);
await shot('browser-rest', 'aside.dock', `${pop} .asset-order`, { scope: pop });
await pickSeries(pop, 'team');
await pause(400);
await waitThumbs(pop);
await shot('browser-series', 'aside.dock', `${pop} .asset-order`, { themes: ['light'], scope: pop });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('order-') && f.endsWith('.png')).length;
console.log(`asset order capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
