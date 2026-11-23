// Design capture for the canvas selection chrome and the shared menu: the selection chip on a section
// and on a part, hover outlines and labels, the chip's More actions menu, the canvas context menu, the
// keyboard-driven menu, and the app's other menus that share the same primitive. Opt-in only, never
// part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/selection-toolbar.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of
// writing a plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('selection toolbar capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-sel-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

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

/**
 * Capture a state in the given themes. `check` must be visible at the moment of capture. `pointer` is
 * where the mouse rests for the capture: a function that moves it (a hover), or null to park it off the
 * canvas. `clip` crops to the canvas area so the chrome is legible.
 */
async function shot(state, check, { themes = BOTH, pointer = null, clip = true } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (pointer) await pointer();
    else await win.mouse.move(2, 450);
    await pause(250);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const box = clip ? await win.locator('.canvas').boundingBox() : null;
    // The canvas plus a margin, so menus that open past its edge stay in frame.
    await win.screenshot({ path, clip: box ? { x: Math.max(0, box.x - 260), y: Math.max(0, box.y - 60), width: Math.min(1440 - Math.max(0, box.x - 260), box.width + 520), height: Math.min(900, box.height + 60) } : undefined });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}
const esc = async () => {
  await win.keyboard.press('Escape');
  await pause(250);
};
const menuSel = '[role="menu"]';

// ---- A business site to edit ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1800);

// 1. A section selected: the full chip (grip, name, AI, move, duplicate, delete, more).
await frame.locator('h1').first().click();
await pause(800);
await shot('section-selected', '.ov-chip');

// 1b. The pointer over the next section on the page: a thin outline and the name of what a click selects.
const overPage = async () => {
  const fb = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(fb.x + fb.width * 0.35, fb.y + 640, { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover .ov-label'), null, { timeout: 5000 });
  await pause(300);
};
await shot('page-hover', '.ov-hover .ov-label', { pointer: overPage });
await win.mouse.move(2, 450);
await pause(300);

// Layers stays open beside the canvas for the rest of the run, as it would while arranging a page.
await win.locator('.rail [aria-label="Layers"]').click();
await pause(500);

// 2. The chip's More actions menu.
await win.locator('.ov-chip [aria-label="More actions"]').click();
await pause(400);
await shot('chip-more-menu', menuSel);

// 3. The same menu, keyboard-driven: opened from the button with Enter, then two steps down.
await esc();
await win.locator('.ov-chip [aria-label="More actions"]').focus();
await win.keyboard.press('Enter');
await pause(300);
await win.keyboard.press('ArrowDown');
await win.keyboard.press('ArrowDown');
await pause(200);
await shot('chip-menu-keyboard', menuSel, { themes: LIGHT, pointer: async () => {} });
await esc();
const focusBack = await win.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
console.log('focus after Escape:', focusBack);

// 4. A part selected (the heading inside the section): the chip parks above the page frame.
await frame.locator('h1').first().click();
await pause(800);
await shot('part-selected', '.ov-chip');

// 5. Right-click on the page: the canvas context menu for the part.
await frame.locator('h1').first().click({ button: 'right' });
await pause(500);
await shot('canvas-context-menu', menuSel);
await esc();

// 6. One card's title picked on the page: "one of 3". The first click selects the section, the second the title.
await frame.getByText('Materials & colour', { exact: true }).first().dispatchEvent('click');
await pause(600);
await frame.getByText('Materials & colour', { exact: true }).first().dispatchEvent('click');
await pause(800);
await shot('card-picked', '.ov-chip', { themes: LIGHT });

// 7. The shared header selected (green scope).
await frame.locator('h1').first().scrollIntoViewIfNeeded();
await frame.locator('header').first().click({ position: { x: 4, y: 4 } }).catch(async () => frame.locator('nav').first().click());
await pause(800);
await shot('shared-selected', '.ov-chip', { themes: LIGHT });

// 8. The right panel closed: the chip offers Edit to bring the inspector back.
await frame.locator('h1').first().click();
await esc();
await frame.locator('h1').first().click();
await pause(600);
await win.locator('[aria-label="Right panel"]').click();
await pause(800);
await shot('chip-dock-closed', '.ov-chip', { themes: LIGHT });
await win.locator('[aria-label="Right panel"]').click();
await pause(600);

// ---- Other menus that share the primitive ----
// The project menu: a heading, checked pages with a hint, icons and separators.
await win.locator('.project-title').click();
await pause(400);
await shot('project-menu', menuSel, { clip: false });
await esc();

// The Layers context menu, from a right-click on a row.
if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
await pause(400);
await win.locator('.list-item', { hasText: 'Services grid' }).first().click({ button: 'right' });
await pause(400);
await shot('layers-context-menu', menuSel, { themes: LIGHT, clip: false });
await esc();

// The command menu reuses the menu item styles.
await win.keyboard.press('Meta+K');
await pause(250);
await win.keyboard.type('pa');
await pause(300);
await shot('command-menu', '.cmdk', { themes: LIGHT, clip: false });
await esc();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`selection toolbar capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
