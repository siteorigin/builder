// Design capture for the strip above the page while a collection's layout is edited: whose layout it is, the entry it
// is shown on and the way back. Every state it takes: at rest on a wide frame (both themes), with a section of the
// layout selected so the selection chip shares the row, on a small laptop's canvas and on a phone frame (where the two
// compete for the row), with a long collection name and a long entry title, an index layout (wide and narrow), the
// narrow canvas at 100% zoom (the page wider than the canvas), an entry opening,
// keyboard focus on the entry picker and on Done, and the whole window for context. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/layout-strip.mjs
//
// Runs headless, captured at twice CSS pixels (through the DevTools protocol) so the 24px controls are legible. The
// collections and entries go through the real apply seam. Each capture is verified on screen after it settles; a
// state that did not render throws instead of writing a plausible-looking wrong image. Files are named
// `{state}--{theme}.png`, cropped to the top of the canvas (the strip, the row it shares and the top of the page).
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { _electron as electron } from 'playwright';
import { createProject, launchEnv } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('layout strip capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-layout-strip-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const STRIP = '[data-testid="template-strip"]';

const app = await electron.launch({ args: ['.'], env: launchEnv(WORK), timeout: 90000 });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
const cdp = await win.context().newCDPSession(win);
await win.waitForSelector('.welcome', { timeout: 90000 });
const written = [];
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** The top of the canvas: the row above the page and the first of the page under it. */
async function canvasTop(height = 180) {
  const b = await win.locator('.canvas').boundingBox();
  return { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, height) };
}

/**
 * Capture a state. `check` (a selector, or a function returning true) must hold at the moment of capture. `pointer`:
 * 'keep' leaves the mouse where it is; otherwise it is parked off the canvas. `clip`: 'top' (the canvas's top),
 * 'window' (everything).
 */
async function shot(state, check, { themes = BOTH, pointer = null, clip = 'top', height } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (pointer !== 'keep') await win.mouse.move(2, 450);
    await pause(300);
    const ok = typeof check === 'function' ? await check() : await win.locator(check).first().isVisible().catch(() => false);
    if (!ok) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const vp = win.viewportSize();
    const area = clip === 'window' ? { x: 0, y: 0, width: vp.width, height: vp.height } : await canvasTop(height);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...area, scale: clip === 'window' ? 1 : 2 } });
    const path = join(OUT, `${state}--${theme}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}
const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label} failed: ${JSON.stringify(r?.error)}`);
  return r;
};
const showPages = async () => {
  if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();
  await pause(300);
};
const setWidth = async (name) => {
  await win.locator(`[aria-label="${name}"]`).click();
  await pause(900);
};

// ---- A business site with a journal (one draft among its posts) and a long-named events collection ----
const sites = join(WORK, 'sites');
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
await pause(1500);
const posts = [
  ['A garden room that opened up the whole house', '2026-10-28', false],
  ['Choosing oak: oiled, lacquered or left alone', '2026-10-14', false],
  ['Small flats, big ideas: storage that disappears', '2026-09-30', true],
  ['Planning light before you plan furniture', '2026-09-12', false]
];
await apply(
  [
    { type: 'collection.create', collectionId: 'posts', name: 'Journal', singularName: 'Post', route: '/journal/' },
    ...posts.map(([title, publishedAt, draft], i) => ({ type: 'entry.create', collectionId: 'posts', entryId: `en_post0${i}`, title, publishedAt, draft, body: ['A short note from the studio.'] })),
    { type: 'collection.create', collectionId: 'events', name: 'Workshops & open studio evenings', singularName: 'Workshop', route: '/workshops/', archiveTemplate: 'start' },
    { type: 'entry.create', collectionId: 'events', entryId: 'en_event01', title: 'Colour workshop for renters who cannot paint their walls', publishedAt: '2026-12-11', draft: false, body: ['Come along.'] },
    { type: 'entry.create', collectionId: 'events', entryId: 'en_event02', title: 'Open studio evening', publishedAt: '2026-12-04', draft: false, body: ['Come along.'] }
  ],
  'Add the collections'
);
await pause(800);

/** Open a collection's layout as an author does, from the Pages panel, and wait for its entry to show. */
async function openLayout(id) {
  await showPages();
  await win.locator(`[data-testid="edit-layout-${id}"]`).click();
  await win.locator(STRIP).waitFor({ timeout: 15000 });
  await settled();
}
/** The strip has stopped saying an entry is opening, and the page shows. */
async function settled() {
  const end = Date.now() + 30000;
  while ((await win.locator(STRIP).getAttribute('aria-busy').catch(() => 'true')) === 'true') {
    if (Date.now() > end) throw new Error('the layout never finished opening');
    await pause(200);
  }
  await frame.locator('h1').first().waitFor({ timeout: 30000 });
  await pause(1200);
}
/** Select the first section of the layout, as a click on the page does. */
async function selectFirstSection() {
  await frame.locator('[data-so-node]').first().dispatchEvent('click');
  await win.locator('.ov-chip').first().waitFor({ timeout: 8000 });
  await pause(700);
}
const clearSelection = async () => {
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const box = await win.locator('.canvas-scroll').boundingBox();
  await win.mouse.click(box.x + 8, box.y + box.height - 8);
  await win.locator('.ov-chip').waitFor({ state: 'detached', timeout: 8000 }).catch(() => undefined);
  await pause(300);
};

// 1. At rest: the Journal's layout shown on its newest post, nothing selected.
await openLayout('posts');
await shot('rest', STRIP);
// 2. The whole window, for the strip's place in the editor (Layers is open with the layout's tree).
await shot('context', STRIP, { themes: LIGHT, clip: 'window' });

// 3. A section of the layout selected: the chip parks in the same row, after the strip.
await selectFirstSection();
await shot('selected', '.ov-chip', { themes: BOTH });

// 4. A small laptop's canvas (1024 wide, both panels open), with and without a selection.
await win.setViewportSize({ width: 1024, height: 760 });
await pause(900);
await shot('narrow-selected', '.ov-chip', { themes: LIGHT });
await clearSelection();
await shot('narrow', STRIP, { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(900);

// 5. A phone frame: the strip and the chip share 390px.
await setWidth('Phone');
await shot('phone', STRIP, { themes: LIGHT });
await selectFirstSection();
await shot('phone-selected', '.ov-chip', { themes: LIGHT });
await clearSelection();
await setWidth('Desktop');

// 6. Keyboard: focus on the entry picker, then on Done, as Tab reaches them.
await win.locator('[data-testid="template-sample"]').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(300);
await shot('focus-picker', () => win.locator('[data-testid="template-sample"]:focus-visible').isVisible(), { themes: LIGHT, pointer: 'keep' });
await win.keyboard.press('Tab');
await pause(300);
await shot('focus-done', () => win.evaluate((sel) => !!document.querySelector(sel)?.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON', STRIP), { themes: BOTH, pointer: 'keep' });
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

// 7. Another entry opening: the page's requests held, so the strip shows it opening.
const origin = new URL(await win.locator('.frame-box iframe').getAttribute('src')).origin;
let release;
const gate = new Promise((resolve) => (release = resolve));
const hold = async (route) => {
  await gate;
  await route.continue().catch(() => undefined);
};
await app.context().route(`${origin}/**`, hold);
await win.locator('[data-testid="template-sample"]').selectOption('en_post01');
await pause(500);
await shot('opening', () => win.locator(`${STRIP}[aria-busy="true"]`).isVisible(), { themes: LIGHT });
// The same on the small laptop canvas, where the spinner takes the mode glyph's place rather than room of its own.
await win.setViewportSize({ width: 1024, height: 760 });
await pause(900);
await shot('opening-narrow', () => win.locator(`${STRIP}[aria-busy="true"] .spinner`).isVisible(), { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(600);
release();
await app.context().unroute(`${origin}/**`, hold);
await settled();

// 8. A long collection name with a long entry title, on the small laptop canvas.
await openLayout('events');
await shot('long', STRIP, { themes: LIGHT });
await win.setViewportSize({ width: 1024, height: 760 });
await pause(900);
await shot('long-narrow', STRIP, { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(900);

// 9. An index layout: the events index, which has its own design.
await showPages();
const toggle = win.getByRole('button', { name: 'Index settings of Workshops & open studio evenings' });
if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
await win.locator('[data-testid="design-index-events"]').click();
await win.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes('index'), STRIP, { timeout: 15000 });
await settled();
await shot('index', STRIP, { themes: BOTH });
// The index on the small laptop canvas, then that canvas at 100% zoom, where the page is wider than the canvas: the
// band stays within the canvas, with Done on screen.
await win.setViewportSize({ width: 1024, height: 760 });
await pause(900);
await shot('index-narrow', STRIP, { themes: LIGHT });
const setZoom = async (label) => {
  await win.locator('button[title^="More: zoom"]').click();
  await win.getByRole('menuitemradio', { name: label }).or(win.getByRole('menuitem', { name: label })).first().click();
  await pause(900);
};
await setZoom('100%');
const doneOnScreen = async () => {
  const done = await win.locator(STRIP).getByRole('button', { name: /Done/ }).boundingBox();
  const canvas = await win.locator('.canvas').boundingBox();
  const ok = !!done && done.x + done.width <= canvas.x + canvas.width && done.x >= canvas.x;
  if (!ok) console.log('Done', done, 'canvas', canvas);
  return ok;
};
await shot('zoom-100-narrow', doneOnScreen, { themes: LIGHT });
await setZoom('Fit to window');
await win.setViewportSize({ width: 1440, height: 900 });
await pause(900);

// Done: the strip goes, and the page that was open shows again.
await win.locator(STRIP).getByRole('button', { name: /Done/ }).click();
await win.locator(STRIP).waitFor({ state: 'detached', timeout: 10000 });

await app.close();
rmSync(WORK, { recursive: true, force: true });
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const p of written) if (!files.includes(p.split('/').pop())) throw new Error(`missing capture ${p}`);
if (errors.length) console.log('page errors:', errors);
console.log(`layout strip capture: ${written.length} images in ${OUT}`);
