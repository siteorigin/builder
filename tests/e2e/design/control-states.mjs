// Design capture for the shared control states: the segmented control in each of its uses (the toolbar's Preview
// width and Mode, Layers | Headings, Visitor text's All | Changed, Settings), its chosen-but-unavailable face (the
// SEO view covers the canvas), keyboard focus inside one, icon buttons enabled, unavailable and pressed (the toolbar,
// the Assets grid's density toggle), the switch rows of Settings and New project, and the Show key button. Drives
// the real (built) app and writes padded crops of each control at 2x, in light and dark. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/control-states.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('control states capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'control-states');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-controls-')));
const BOTH = ['light', 'dark'];
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: W, height: H });
// Captures at 2x, so 1px edges and 12px labels are legible to a reviewer.
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** The union of the boxes of `sels`, padded, kept inside the window. */
async function clipOf(sels, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sel of [sels].flat()) {
    const b = await win.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} has no box`);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  const x = Math.max(0, Math.floor(x0 - pad)), y = Math.max(0, Math.floor(y0 - pad));
  return { x, y, width: Math.min(W, Math.ceil(x1 + pad)) - x, height: Math.min(H, Math.ceil(y1 + pad)) - y, scale: 1 };
}

/** Capture `state` per theme, clipped to `area` (selectors) padded by `pad`; `check` must be visible. */
async function shot(state, check, { area = check, pad = 16, themes = BOTH, keepPointer = false, keepFocus = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(W - 4, H - 4);
    if (!keepFocus) await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.matches('button') && document.activeElement.blur());
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    // Through CDP so the 2x device scale holds (Playwright's own screenshot renders at 1x here).
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: await clipOf(area, pad) });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const escape = async () => {
  await win.keyboard.press('Escape');
  await pause(250);
};

// ---- New project: its switch rows ----
await win.getByRole('button', { name: /New project/ }).first().click();
await win.waitForSelector('.modal .new-project-form');
await win.fill('#new-project-name', 'Harbour Lane Studio');
await pause(300);
await shot('new-project-switches', '.new-project-form .switch-row', { area: '.new-project-form .switch-row', pad: 40 });
await escape();

// ---- Settings: General (switch rows, segmented radios) and the AI key's Show button ----
const tab = (name) => win.locator('.modal [role="tab"]', { hasText: name });
await win.locator('.welcome button', { hasText: 'Settings' }).click();
await win.locator('.modal').waitFor();
await pause(300);
await shot('settings-general', '.modal [role="switch"]', { area: '.modal', pad: 0 });
await tab('AI assistant').click();
await pause(400);
const KEY = ['.modal [aria-label="Show key"]', '.modal .input.mono'];
await shot('settings-key', '.modal [aria-label="Show key"][aria-pressed="false"]', { area: KEY, pad: 40 });
// Shown: the toggle is pressed.
await win.locator('.modal [aria-label="Show key"]').click();
await pause(200);
await shot('settings-key-shown', '.modal [aria-label="Show key"][aria-pressed="true"]', { area: KEY, pad: 40 });
// The provider choice: a full-width tray at the shared height.
await shot('settings-provider', '.modal .settings-provider .segmented', { area: '.modal .settings-provider', pad: 12, themes: ['light'] });
await escape();
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- A populated business site in the editor ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
const rail = (name) => win.locator(`.rail [aria-label="${name}"]`);
const openRail = async (name, open = true) => {
  if (((await rail(name).getAttribute('aria-pressed')) === 'true') !== open) await rail(name).click();
  await pause(400);
};

// ---- The toolbar at rest: width and mode segmented, undo and redo unavailable, pressed panel toggles ----
const TB = ['.toolbar-center', '.toolbar-end'];
await shot('toolbar-rest', '.toolbar-center .segmented', { area: TB, pad: 8 });
// Tablet chosen, and Preview mode.
await win.locator('.toolbar [aria-label="Tablet"]').click();
await win.locator('.toolbar [aria-label="Preview"]').click();
await pause(400);
await shot('toolbar-tablet-preview', '.toolbar [aria-label="Tablet"][aria-pressed="true"], .toolbar [aria-label="Tablet"][aria-checked="true"]', { area: TB, pad: 8 });
await win.locator('.toolbar [aria-label="Desktop"]').click();
await win.locator('.toolbar [aria-label="Edit"]').click();
await pause(400);
// Keyboard focus inside the Mode control.
await win.locator('.toolbar [aria-label="Edit"]').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(200);
await shot('toolbar-mode-focus', '.toolbar :focus-visible', { area: '.toolbar-center', pad: 8, themes: ['light'], keepFocus: true });
await win.evaluate(() => document.activeElement?.blur());

// ---- The SEO view covers the canvas: the chosen width and mode are unavailable ----
await win.locator('.rail [data-rail="seo"]').click();
await win.locator('.seo-view').waitFor();
await pause(600);
await shot('toolbar-covered', '.toolbar-center .segmented button:is(:disabled, [aria-disabled="true"])', { area: TB, pad: 8 });
await escape();
await pause(400);

// ---- Layers | Headings ----
await openRail('Layers');
const LH = ['.panel-head:has(+ .layers-views)', '.layers-views'];
await shot('layers-views', '.layers-views', { area: LH, pad: 12 });
await win.locator('.layers-views button', { hasText: 'Headings' }).click();
await pause(500);
await shot('layers-headings', '.layers-views', { area: LH, pad: 12 });
await win.locator('.layers-views button', { hasText: 'Layers' }).click();
await pause(300);

// ---- Insert: Variants, a ghost button that toggles ----
await openRail('Insert');
const variants = win.locator('.side-panel-view:not([hidden]) .insert-variants');
await variants.waitFor();
if ((await variants.getAttribute('aria-pressed')) !== 'true') await variants.click();
await pause(400);
await shot('insert-variants-pressed', '.insert-variants[aria-pressed="true"]', { area: '.side-panel-view:not([hidden]) .panel-head', pad: 8, themes: ['light'] });
await variants.click();
await pause(300);

// ---- Assets: the density toggle, off and pressed ----
await openRail('Assets');
await win.locator('.asset-density').waitFor();
await shot('assets-tools', '.asset-density', { area: ['.asset-tools', '.asset-density'], pad: 12 });
await win.locator('.asset-density').click();
await pause(400);
await shot('assets-tools-compact', '.asset-density[aria-pressed="true"]', { area: ['.asset-tools', '.asset-density'], pad: 12 });
await win.locator('.asset-density').click();
await pause(300);

// ---- Visitor text: All | Changed, with wording of the author's own ----
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const r = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'site.update', visitorText: { language: 'en', text: { menu: 'Browse', skipLink: 'Jump to the main content' } } }] }, { label: 'Design capture: own visitor text' }));
if (!r?.ok) throw new Error(`could not apply visitor text: ${JSON.stringify(r?.error)}`);
await pause(900);
const vtHead = win.locator('#dock-panel-styles .section-head', { hasText: /^Visitor text/ }).first();
if ((await vtHead.getAttribute('aria-expanded')) !== 'true') await vtHead.click();
await pause(400);
await win.locator('.vt-find').scrollIntoViewIfNeeded();
await pause(300);
await shot('visitor-filter', '.vt-find .segmented', { area: '.vt-find', pad: 12 });
await win.locator('.vt-find .segmented button', { hasText: /^Changed/ }).click();
await pause(400);
await shot('visitor-filter-changed', '.vt-find .segmented', { area: '.vt-find', pad: 12 });

// ---- Site styles' Type scale: a tray built by hand ----
const tsHead = win.locator('#dock-panel-styles .section-head', { hasText: /^Text styles/ }).first();
if ((await tsHead.getAttribute('aria-expanded')) !== 'true') await tsHead.click();
await pause(400);
await win.locator('.ss-scale').scrollIntoViewIfNeeded();
await pause(300);
await shot('type-scale', '.ss-scale .segmented', { area: '.ss-scale', pad: 12 });

// ---- Verify ----
await app.close();
rmSync(WORK, { recursive: true, force: true });
if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const p of written) if (!files.includes(p.split('/').pop())) throw new Error(`missing ${p}`);
console.log(`control states capture: ${written.length} images in ${OUT}`);
