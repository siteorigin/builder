// Inspector capture harness: drives the real (built) app through every state the right dock's Inspector
// tab can show (the page, a section, its parts and list items, primitives, the shared header, component
// editing, preview) and writes one PNG of the dock per state and theme. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/inspector.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`; `window-*` files are the whole
// window, the rest are the dock alone.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('inspector capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'inspector');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-insp-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
// Tall enough that most inspector states fit without scrolling, so one image shows the whole panel.
await win.setViewportSize({ width: 1440, height: 1200 });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Capture the dock (or the whole window) in the given themes; `check` must be visible inside the dock. */
async function shot(state, check, themes = BOTH, { full = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(700, 1190);
    await pause(200);
    const visible = await win.locator('.dock').locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}" in the dock; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    if (full) await win.screenshot({ path });
    else await win.locator('.dock').screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

/** Sections remember open/closed in localStorage; reset to defaults, or open every one. */
async function sections(mode) {
  await win.evaluate((m) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
    if (m === 'open') for (const id of ['content', 'style', 'component', 'advanced', 'part-content', 'part-style', 'prim-content', 'prim-style', 'prim-actions', 'prim-advanced', 'page-basic', 'page-seo', 'page-adv', 'def-text', 'def-style']) localStorage.setItem(`section:${id}`, '1');
  }, mode);
}

async function clearSelection() {
  await win.mouse.click(700, 1190);
  for (let i = 0; i < 4; i++) await win.keyboard.press('Escape');
  await pause(400);
}

const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(300);
};

// ---- Project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await sections('default');

// ---- The page, nothing selected ----
await clearSelection();
await shot('page', '.insp-head');

// ---- A section (component instance) ----
await frame.locator('h1').first().click();
await pause(800);
await shot('window-hero', '.insp-head', LIGHT, { full: true });
await shot('instance-hero', '.insp-head');
await clearSelection();
await sections('open');
await frame.locator('h1').first().click();
await pause(800);
await shot('instance-hero-open', '.insp-head', LIGHT);
await clearSelection();
await sections('default');

// ---- A part of the section ----
await frame.locator('h1').first().click();
await pause(600);
await frame.locator('h1').first().click();
await pause(800);
await shot('part-heading', '.insp-head');
await clearSelection();

// ---- A section whose content is a list ----
await openRail('Layers');
const gridRow = win.locator('.list-item', { hasText: 'Services grid' }).first();
await gridRow.click();
await pause(700);
await win.locator('.dock .list-editor-head button.title').first().click();
await pause(400);
await shot('instance-list', '.list-editor-body');

// ---- One list item's part, then the same part in every item ----
await frame.getByText('Materials & colour', { exact: true }).first().dispatchEvent('click');
await pause(800);
await shot('part-card-one', '.insp-head', LIGHT);
if ((await gridRow.getAttribute('aria-expanded')) !== 'true') await gridRow.locator('.tree-toggle').click();
await win.locator('.list-item', { hasText: 'Card title' }).first().click();
await pause(800);
await shot('part-card-all', '.insp-head', LIGHT);
await clearSelection();

// ---- The shared header ----
await frame.locator('header').first().click({ position: { x: 4, y: 4 } });
await pause(800);
await shot('shell-header', '.insp-scope.shared, .scope-note.shared', LIGHT);
await clearSelection();

// ---- Primitives, added from Insert at the end of the page ----
async function addBasic(name) {
  await clearSelection();
  await openRail('Insert');
  await win.locator('.insert-tile.basic', { hasText: name }).first().click();
  await pause(1200);
}
await addBasic('Heading');
await shot('primitive-heading', '.insp-head');
await addBasic('Button');
await shot('primitive-button', '.insp-head', LIGHT);
await addBasic('Image');
await shot('primitive-image', '.insp-image, .image-picker', LIGHT);
await clearSelection();

// ---- Preview mode, nothing selected ----
await win.getByRole('button', { name: /Preview/ }).first().click();
await pause(600);
await shot('page-preview', '.insp-head', LIGHT);
await win.getByRole('button', { name: /Edit/ }).first().click();
await pause(400);

// ---- Editing a component everywhere ----
await openRail('Layers');
await win.locator('.list-item', { hasText: 'Services grid' }).first().click();
await pause(500);
const compSection = win.locator('.dock .section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: /Edit everywhere/ }).click();
await pause(400);
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await pause(1800);
// One Escape steps to the component overview; a second would leave the mode.
await win.keyboard.press('Escape');
await pause(500);
await shot('definition-overview', '.insp-empty, .empty-insp', LIGHT);
await frame.getByText('Materials & colour', { exact: true }).first().dispatchEvent('click');
await pause(900);
await shot('definition-node', '.insp-head', LIGHT);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`inspector capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
