// Design capture for the canvas selection chip and the hover name tag, close up: every state the chip takes
// (a section with its moves, the first section with Move up unavailable, a part with its parent link, one card
// of a repeat with item stepping, More actions open, keyboard focus on a button and on a text button, the
// editing state, the right panel closed, the selection scrolled out of view, the shared header's green and a
// component's plum, a phone frame) and the hover tag inside and outside an element. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/canvas-selection-chip.mjs
//
// Runs headless, captured at the window's device scale (twice CSS pixels on a Retina Mac), so the 24px controls are legible. Each capture is verified on screen
// after it settles; a state that did not render throws instead of writing a plausible-looking wrong image. Files
// are named `{state}--{theme}.png`, cropped to the chip (or tag) and what it sits on.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { _electron as electron } from 'playwright';
import { createProject, launchEnv } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas selection chip capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-chip-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({ args: ['.'], env: launchEnv(WORK), timeout: 90000 });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
// Captures are drawn at twice the pixels, the same layout, through the DevTools protocol (Playwright's own capture draws at CSS pixels here).
const cdp = await win.context().newCDPSession(win);
await win.waitForSelector('.welcome', { timeout: 90000 });
const written = [];
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** The region around `target` (the chip or the tag): itself, plus enough of what it sits on to judge it. */
async function around(target, { left = 70, right = 70, up = 44, down = 120 } = {}) {
  const b = await win.locator(target).first().boundingBox();
  const vp = win.viewportSize();
  const x = Math.max(0, b.x - left);
  const y = Math.max(0, b.y - up);
  return { x, y, width: Math.min(vp.width - x, b.width + left + right), height: Math.min(vp.height - y, b.height + up + down) };
}

/**
 * Capture a state. `check` must be visible at the moment of capture. `pointer` is where the mouse rests: a
 * function that moves it, 'keep' to leave it, or null to park it off the canvas. `crop` is the selector the
 * capture is cropped around (the chip by default), or 'canvas' for the whole canvas.
 */
async function shot(state, check, { themes = BOTH, pointer = null, crop = '.ov-chip', pad } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (typeof pointer === 'function') await pointer();
    else if (pointer !== 'keep') await win.mouse.move(2, 450);
    await pause(300);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const clip = crop === 'canvas' ? await win.locator('.canvas').boundingBox() : await around(crop, pad);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

// ---- A business site to edit ----
const sites = join(WORK, 'sites');
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
await pause(1800);

/** Click the empty pasteboard beside the page, which clears the selection. */
const clearSelection = async () => {
  const box = await win.locator('.canvas-scroll').boundingBox();
  await win.mouse.click(box.x + 16, box.y + 120);
  await win.locator('.ov-chip').waitFor({ state: 'detached', timeout: 8000 });
  await pause(250);
};
const selectHeading = async () => {
  await clearSelection();
  // Dispatched, because at some widths the hero's image sits over the heading for Playwright's hit test.
  await frame.locator('h1').first().dispatchEvent('click');
  await win.getByRole('toolbar', { name: 'Split hero actions', exact: true }).waitFor({ timeout: 8000 });
  await pause(600);
};
/** Pick the innermost element under a click (Alt-click), as a direct pick of a part. */
const deepPick = async (locator) => {
  await locator.dispatchEvent('click', { altKey: true });
  await pause(700);
};
/** The chip must name what the state is about, or the capture is of something else. */
const chipSays = async (text) => {
  const label = await win.locator('.ov-chip').first().textContent();
  if (!label?.includes(text)) throw new Error(`the chip reads "${label}", expected "${text}"; refusing to write`);
};
const setWidth = async (name) => {
  await win.locator(`[aria-label="${name}"]`).click();
  await pause(900);
};

// 1. The first section selected: grip, name, Ask AI, Move up (unavailable: it is first), Move down, Duplicate, More.
await selectHeading();
if ((await win.locator('.ov-chip [aria-label="Move up"]').getAttribute('aria-disabled')) !== 'true') throw new Error('Move up should be unavailable on the first section');
await shot('section-first', '.ov-chip [aria-label="Move up"]');

// 2. A section further down the page: both moves available.
await clearSelection();
await frame.locator('section[data-so-node="root"]').nth(1).dispatchEvent('click');
await win.locator('.ov-chip').waitFor({ timeout: 8000 });
await pause(600);
if ((await win.locator('.ov-chip [aria-label="Move up"]').getAttribute('aria-disabled')) === 'true') throw new Error('Move up should be available on the second section');
await shot('section-middle', '.ov-chip [aria-label="Move up"]', { themes: LIGHT });

// 3. More actions open, then keyboard focus on a neighbouring button: the two must not look alike.
await selectHeading();
await win.locator('.ov-chip [aria-label="More actions"]').click();
await win.locator('[role="menu"]').waitFor({ timeout: 5000 });
await pause(300);
await shot('more-open', '.ov-chip [aria-expanded="true"]', { pad: { down: 60 } });
await win.keyboard.press('Escape');
await pause(300);
await win.locator('.ov-chip [aria-label="Duplicate"]').focus();
await win.keyboard.press('ArrowRight');
await pause(200);
await shot('focus-more', '.ov-chip [aria-label="More actions"]:focus-visible', { pointer: 'keep' });
await win.locator('.ov-chip [aria-label="Move down"]').focus();
await win.keyboard.press('ArrowLeft');
await pause(200);
await shot('focus-disabled', '.ov-chip [aria-label="Move up"]:focus-visible', { themes: LIGHT, pointer: 'keep' });

// 4. A part selected: the heading, with its parent link ("in Split hero").
await clearSelection();
await deepPick(frame.locator('h1').first());
await chipSays('Heading');
await shot('part-selected', '.ov-chip .of.link');
// Reached by the arrow keys, as a keyboard user would, so the focus ring shows.
await win.locator('.ov-chip [aria-label="Ask AI about this"]').focus();
await win.keyboard.press('ArrowLeft');
await pause(200);
await shot('focus-parent', '.ov-chip .of.link:focus-visible', { themes: LIGHT, pointer: 'keep' });

// 5. One card's title picked on the page: item stepping, "2 of 3".
await clearSelection();
await deepPick(frame.getByText('Materials & color', { exact: true }).first());
await chipSays('of 3');
await shot('card-picked', '.ov-chip [data-testid="chip-item-pos"]');

// 6. Editing text on the page: "Editing heading · Esc to cancel", Done.
await clearSelection();
await frame.locator('h1').first().dblclick();
await frame.locator('h1[contenteditable]').first().waitFor({ timeout: 8000 });
await pause(500);
await shot('editing', '.ov-chip.editing', { pointer: 'keep' });
await win.keyboard.press('Escape');
await pause(400);

// 7. The right panel closed: the chip offers Edit, a text button, then keyboard focus on it.
await selectHeading();
const dockButton = win.locator('.toolbar [aria-label="Right panel"]');
await dockButton.click();
await win.locator('.toolbar [aria-label="Right panel"][aria-pressed="false"]').waitFor();
await pause(700);
await shot('dock-closed', '.ov-chip .chip-text');
await win.locator('.ov-chip [aria-label="Ask AI about this"]').focus();
await win.keyboard.press('ArrowRight');
await pause(200);
await shot('focus-text-button', '.ov-chip .chip-text:focus-visible', { themes: LIGHT, pointer: 'keep' });
await dockButton.click();
await win.locator('.toolbar [aria-label="Right panel"][aria-pressed="true"]').waitFor();
await pause(600);

// 8. The selection scrolled out of view: the parked chip offers Show.
await selectHeading();
const canvasBox = await win.locator('.frame-wrap').boundingBox();
await win.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 300);
await win.mouse.wheel(0, 1400);
await pause(800);
await shot('offscreen', '.ov-chip .chip-text', { themes: LIGHT, pointer: 'keep' });
await win.mouse.wheel(0, -3000);
await pause(600);

// 9. The shared header selected: the green scope.
await clearSelection();
await frame.locator('header').first().click({ position: { x: 4, y: 4 } });
await pause(700);
await shot('shared-selected', '.ov-chip');

// 10. The hover tag: inside a tall section, and outside a short element.
await clearSelection();
const overHero = async () => {
  const b = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(b.x + b.width * 0.35, b.y + 150, { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover .ov-label'), null, { timeout: 8000 });
};
await shot('hover-inside', '.ov-hover .ov-label', { pointer: overHero, crop: '.ov-hover .ov-label', pad: { left: 40, right: 260, up: 30, down: 90 } });
// The hover beside a selection: the tag next to the chip.
await selectHeading();
const overNext = async () => {
  const b = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(b.x + b.width * 0.35, b.y + Math.min(b.height - 40, 640), { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover .ov-label'), null, { timeout: 8000 });
};
await shot('hover-beside-selection', '.ov-hover .ov-label', { themes: LIGHT, pointer: overNext, crop: 'canvas' });
await clearSelection();
await win.locator('[aria-label="Preview width in pixels"]').fill('1920');
await win.keyboard.press('Enter');
await pause(900);
const overHeader = async () => {
  const b = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(b.x + b.width * 0.5, b.y + 6, { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover .ov-label.outside'), null, { timeout: 8000 });
};
await shot('hover-outside', '.ov-hover .ov-label.outside', { pointer: overHeader, crop: '.ov-hover .ov-label', pad: { left: 40, right: 260, up: 30, down: 60 } });
await setWidth('Desktop');

// 11. A phone frame: the chip under pressure, on a part with a parent and on a card of a repeat.
await setWidth('Phone');
await deepPick(frame.locator('h1').first());
await chipSays('Heading');
await shot('phone-part', '.ov-chip', { pad: { left: 40, right: 40, up: 30, down: 200 } });
await clearSelection();
await frame.getByText('Materials & color', { exact: true }).first().scrollIntoViewIfNeeded();
await deepPick(frame.getByText('Materials & color', { exact: true }).first());
await chipSays('of 3');
await shot('phone-card', '.ov-chip', { themes: LIGHT, pad: { left: 40, right: 40, up: 30, down: 200 } });
// The same with the inspector showing, so the chip has no Inspect button to offer.
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.locator('#dock-panel-inspect').waitFor({ timeout: 8000 });
await pause(600);
await chipSays('of 3');
await shot('phone-card-inspector', '.ov-chip', { themes: LIGHT, pad: { left: 40, right: 40, up: 30, down: 200 } });
await setWidth('Desktop');

// 12. Two sections selected together in Layers: the chip names the one picked and counts the other.
await clearSelection();
if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
await pause(400);
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await win.locator('.list-item', { hasText: 'Logo strip' }).first().click({ modifiers: ['Shift'] });
await pause(700);
await chipSays('and 1 more');
await shot('layers-group', '.ov-chip', { themes: LIGHT });

// 13. A component's own design open (Edit everywhere): the plum scope, on the chip and on the hover tag.
await clearSelection();
if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await pause(500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click().catch(() => {});
await pause(300);
const componentSection = win.locator('.section-head', { hasText: 'Component' }).first();
if ((await componentSection.getAttribute('aria-expanded')) === 'false') await componentSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).first().click();
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.editor.defining').waitFor({ timeout: 20000 });
await pause(1800);
await deepPick(frame.locator('h1').first());
await win.locator('.ov-chip').waitFor({ timeout: 8000 });
await shot('defining-part', '.editor.defining .ov-chip');
await clearSelection();
await shot('defining-hover', '.editor.defining .ov-hover .ov-label', { themes: LIGHT, pointer: overHero, crop: '.ov-hover .ov-label', pad: { left: 40, right: 260, up: 30, down: 60 } });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`canvas selection chip capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
