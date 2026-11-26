// Design capture for direct editing on the canvas: hover and selection outlines, the selection chip and its
// menu, drag-to-reorder with its drop line, inline text editing, the empty page, the starting and problem
// states, the pasteboard, and the screen-size frames. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/canvas-editing.mjs
//
// Runs headless. Each capture is verified on screen after it settles; a state that did not render throws
// instead of writing a plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createProject, launch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas editing capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-canvas-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const { app, win, errors } = await launch(WORK);
const written = [];
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/**
 * Capture a state. `check` is a selector that must be visible at the moment of capture. `pointer` is where
 * the mouse rests: a function that moves it, 'keep' to leave it (mid-drag), or null to park it off the
 * canvas. `area` is 'canvas' (cropped so the chrome is legible) or 'all' (the whole window).
 */
async function shot(state, check, { themes = BOTH, pointer = null, area = 'canvas' } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (typeof pointer === 'function') await pointer();
    else if (pointer !== 'keep') await win.mouse.move(2, 450);
    await pause(300);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const box = area === 'canvas' ? await win.locator('.canvas').boundingBox() : null;
    await win.screenshot({ path, clip: box ?? undefined });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

const sites = join(WORK, 'sites');

// ---- The empty page: a blank project, before anything is on it ----
const blank = await createProject(win, { name: 'Blank Studio', parentDir: sites, starter: 'blank', sampleImages: false });
await pause(1500);
// The blank starter opens with an empty Home page. Should it ever start with a section again, that section is
// deleted, so the page really has nothing on it.
if (await blank.locator('main h1').count()) {
  await blank.locator('main h1').first().dispatchEvent('click');
  await win.locator('.ov-chip [aria-label="More actions"]').click();
  await win.locator('[role^="menuitem"]', { hasText: 'Delete' }).click();
  await blank.locator('main h1').waitFor({ state: 'detached', timeout: 15000 });
}
// A toast (Undo) would otherwise sit over the empty page in the capture.
await win.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 30000 });
await win.locator('.canvas-empty .empty-card').waitFor({ timeout: 15000 });
await pause(800);
await shot('empty-page', '.canvas-empty .empty-card', { area: 'all' });

// ---- A business site to edit ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await pause(1800);

/** Click the empty pasteboard beside the page, which clears the selection. Clear of the left seam's splitter,
 * which reaches 8px into the canvas, and inside the pasteboard's 28px gutter. */
const clearSelection = async () => {
  const box = await win.locator('.canvas-scroll').boundingBox();
  await win.mouse.click(box.x + 16, box.y + 120);
  await pause(250);
};
const selectHeading = async () => {
  await clearSelection();
  // Dispatched, because at some widths the hero's image sits over the heading for Playwright's hit test.
  await frame.locator('h1').first().dispatchEvent('click');
  // The first click on a cleared canvas selects the section; anything else means the clear missed.
  await win.getByRole('toolbar', { name: 'Split hero actions', exact: true }).waitFor({ timeout: 8000 });
  await pause(600);
};
const hoverText = (text) => async () => {
  const b = await frame.getByText(text, { exact: true }).first().boundingBox();
  await win.mouse.move(b.x + b.width / 2 + 4, b.y + b.height / 2 + 2, { steps: 5 });
  await pause(250);
};
const setWidth = async (name) => {
  await win.locator(`[aria-label="${name}"]`).click();
  await pause(900);
};

// 1. The page at rest: the frame on its pasteboard, nothing selected.
await shot('rest', '.frame-box iframe', { area: 'all' });

// 2. The pointer over a section: the thin outline and the name of what a click selects.
const overHero = async () => {
  const b = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(b.x + b.width * 0.35, b.y + 150, { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover .ov-label'), null, { timeout: 8000 });
};
await shot('hover-section', '.ov-hover .ov-label', { pointer: overHero });

// 3. A section selected, then the pointer over the next one.
await selectHeading();
await shot('section-selected', '.ov-chip');
const overNext = async () => {
  const b = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(b.x + b.width * 0.35, b.y + Math.min(b.height - 40, 640), { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover'), null, { timeout: 8000 });
};
await shot('hover-beside-selection', '.ov-hover', { themes: LIGHT, pointer: overNext });
await win.mouse.move(2, 450);
await selectHeading();

// 4. The chip's More actions menu.
await win.locator('.ov-chip [aria-label="More actions"]').click();
await pause(400);
await shot('chip-menu', '[role="menu"]');
await win.keyboard.press('Escape');
await pause(250);

// 5. Keyboard focus in the chip.
await win.locator('.ov-chip [aria-label="Move down"]').focus();
await win.keyboard.press('ArrowRight');
await pause(200);
await shot('chip-focus', '.ov-chip button:focus-visible', { themes: LIGHT });
await selectHeading();

/** Pick the innermost element under a click (Alt-click), as a direct pick of a part. */
const deepPick = async (locator) => {
  await locator.dispatchEvent('click', { altKey: true });
  await pause(700);
};
/** The chip must name what the state is about, or the capture is of something else. */
const chipSays = async (text) => {
  // The whole chip: its name, the parent it sits in, and which item of a repeat ("2 of 3").
  const label = await win.locator('.ov-chip').first().textContent();
  if (!label?.includes(text)) throw new Error(`the chip reads "${label}", expected "${text}"; refusing to write`);
};

// 6. A part selected: the heading inside the section, with the chip parked above the frame.
await clearSelection();
await deepPick(frame.locator('h1').first());
await chipSays('Heading');
await shot('part-selected', '.ov-chip.strip');

// 6b. The keyboard's way into text editing: Edit text in the chip's More actions.
await win.locator('.ov-chip [aria-label="More actions"]').click();
await win.locator('[role^="menuitem"]', { hasText: 'Edit text' }).waitFor({ timeout: 5000 });
await shot('text-menu', '[role="menu"]', { themes: LIGHT });
await win.locator('[role^="menuitem"]', { hasText: 'Edit text' }).click();
await frame.locator('h1[contenteditable]').first().waitFor({ timeout: 8000 });
await win.waitForFunction(() => !!document.querySelector('.ov-chip.editing'), null, { timeout: 8000 });
await shot('edit-text-from-menu', '.ov-chip.editing', { themes: LIGHT, pointer: 'keep' });
await frame.locator('h1[contenteditable]').first().press('Escape');
await pause(400);

// 7. Inline text editing on that heading.
await clearSelection();
await frame.locator('h1').first().dblclick();
await frame.locator('h1[contenteditable]').first().waitFor({ timeout: 8000 });
await pause(500);
await shot('inline-edit-heading', '.ov-chip.editing', { pointer: 'keep' });
await win.keyboard.press('Escape');
await pause(400);

// 8. Inline editing a longer run of text, with the caret placed rather than everything selected.
await clearSelection();
// Dispatched, because the hero's layout wrapper sits over its paragraph for Playwright's hit test.
const lead = frame.getByText(/^Harbour Lane Studio designs homes/).first();
await lead.dispatchEvent('dblclick');
await frame.locator('[contenteditable]', { hasText: 'Harbour Lane Studio designs homes' }).first().waitFor({ timeout: 8000 });
// The caret at the end of the text, rather than all of it selected.
await win.keyboard.press('ArrowRight');
await pause(400);
await shot('inline-edit-paragraph', '.ov-chip.editing', { themes: LIGHT, pointer: 'keep' });
await win.keyboard.press('Escape');
await pause(400);

// 9. One card's title picked on the page: "one of 3".
await clearSelection();
await deepPick(frame.getByText('Materials & colour', { exact: true }).first());
await chipSays('of 3');
await shot('card-picked', '.ov-chip', { themes: LIGHT });

// 10. The shared header selected: the green scope.
await clearSelection();
await frame.locator('header').first().click({ position: { x: 4, y: 4 } });
await pause(700);
await shot('shared-selected', '.ov-chip');

// 11. Dragging a section by the chip's grip: the drop line between sections. Released where it started.
const startDrag = async () => {
  await selectHeading();
  const grip = await win.locator('.ov-chip .grip').boundingBox();
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await win.mouse.move(from.x, from.y, { steps: 3 });
  await win.mouse.down();
  await win.waitForSelector('.ov-moving', { timeout: 8000 });
  // Over the lower part of the next section, so the drop line goes after it: anywhere between the hero and that
  // section is where the hero already is, which draws no line.
  const wrap = await win.locator('.frame-wrap').boundingBox();
  const next = await frame.locator('section[data-so-node="root"]').nth(1).boundingBox();
  await win.mouse.move(wrap.x + wrap.width * 0.5, Math.min(next.y + next.height * 0.8, wrap.y + wrap.height - 30), { steps: 8 });
  await pause(250);
  return from;
};
const endDrag = async (from) => {
  await win.mouse.move(from.x, from.y, { steps: 6 });
  await pause(150);
  await win.mouse.up();
  await pause(500);
};
let from = await startDrag();
await shot('drag-reorder', '.ov-moving', { pointer: 'keep' });
if (!(await win.locator('.ov-drop').isVisible())) throw new Error('no drop line mid-drag');
await endDrag(from);

// 12. The stress case: a page that uses the selection's own blue, under the outline, the chip and the drop line.
const paintPage = (on) =>
  frame.locator('html').evaluate((html, on) => {
    html.querySelector('#capture-paint')?.remove();
    if (!on) return;
    const s = document.createElement('style');
    s.id = 'capture-paint';
    s.textContent = 'main, main > *, main section { background: #1766c0 !important; color: #fff !important; } main h1, main h2, main h3, main p, main a, main span { color: #fff !important; }';
    html.querySelector('head').append(s);
  }, on);
await paintPage(true);
await pause(300);
await selectHeading();
await shot('selected-on-blue', '.ov-selected', { themes: LIGHT });
from = await startDrag();
await shot('drag-on-blue', '.ov-drop', { themes: LIGHT, pointer: 'keep' });
await endDrag(from);
await paintPage(false);
await pause(300);

// 13. A selection scrolled past the top of the page: the chip keeps it reachable.
await selectHeading();
const canvasBox = await win.locator('.frame-wrap').boundingBox();
await win.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 300);
await win.mouse.wheel(0, 260);
await pause(700);
await shot('selection-scrolled', '.ov-chip', { themes: LIGHT });
// Scrolled right out of view: the parked chip offers the way back to it.
await win.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 300);
await win.mouse.wheel(0, 900);
await pause(700);
await shot('selection-offscreen', '.ov-chip .chip-text', { themes: LIGHT });
await win.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 300);
await win.mouse.wheel(0, -2400);
await pause(500);

// 14. The screen-size frames: tablet, phone with a selection, and a wide desktop scaled to fit.
await clearSelection();
await setWidth('Tablet');
await shot('frame-tablet', '.frame-width-label', { themes: LIGHT });
await setWidth('Phone');
await shot('frame-phone', '.frame-width-label');
await deepPick(frame.locator('h1').first());
await chipSays('Heading');
await shot('frame-phone-part', '.ov-chip', { themes: LIGHT });
await clearSelection();
const handle = win.locator('.frame-handle.right');
await shot('frame-handle-hover', '.frame-handle.right', { themes: LIGHT, pointer: () => handle.hover() });
// Mid-resize: the handle held and moved, the label showing the width as it changes. Released where it began.
const hb = await handle.boundingBox();
await win.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await win.mouse.down();
await win.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2, { steps: 6 });
await pause(300);
await shot('frame-resizing', '.frame-handle.right.dragging', { themes: LIGHT, pointer: 'keep' });
await win.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2, { steps: 6 });
await win.mouse.up();
await pause(400);
await win.locator('[aria-label="Preview width in pixels"]').fill('1920');
await win.keyboard.press('Enter');
await pause(900);
await shot('frame-wide', '.frame-width-label', { themes: LIGHT });
// A short element names itself outside its outline, so the name covers nothing: scaled this far, the shared
// header is only a few pixels tall.
const overHeader = async () => {
  const b = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(b.x + b.width * 0.5, b.y + 6, { steps: 6 });
  await win.waitForFunction(() => !!document.querySelector('.ov-hover'), null, { timeout: 8000 });
};
await shot('hover-short', '.ov-hover .ov-label.outside', { themes: LIGHT, pointer: overHeader });
// The name stays while the pointer rests on it (WCAG 1.4.13: hoverable).
await overHeader();
const tag = await win.locator('.ov-label.outside').boundingBox();
// Along the header to above the name, then down onto it, as a hand reaching for it would.
await win.mouse.move(tag.x + tag.width / 2, tag.y - 4, { steps: 6 });
await win.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2, { steps: 3 });
await pause(500);
if (!(await win.locator('.ov-label.outside').isVisible())) throw new Error('the hover name went away when the pointer moved onto it');
await setWidth('Desktop');

// 15. A short, narrow window: the chip, the frame and the label under pressure.
await win.setViewportSize({ width: 1080, height: 640 });
await pause(700);
await selectHeading();
await shot('narrow-window', '.ov-chip', { themes: LIGHT, area: 'all' });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(700);
await clearSelection();

// 16. Opening another page: its requests are held, so the "opening" state stays up to be seen.
const origin = new URL(await win.locator('.frame-box iframe').getAttribute('src')).origin;
let release;
const gate = new Promise((resolve) => (release = resolve));
const hold = async (route) => {
  await gate;
  await route.continue().catch(() => undefined);
};
await app.context().route(`${origin}/**`, hold);
await win.locator('.project-title').click();
await win.locator('[role^="menuitem"]', { hasText: 'Contact' }).first().click();
await win.locator('.frame-status').waitFor({ timeout: 8000 });
await shot('opening-page', '.frame-status');
release();
await app.context().unroute(`${origin}/**`, hold);
await win.locator('.frame-status').waitFor({ state: 'detached', timeout: 30000 });
await pause(600);

// 17. A problem on the page, in edit mode.
await frame.locator('html').evaluate(() => {
  setTimeout(() => {
    throw new Error('Capture: this section failed to render');
  });
});
await win.locator('.ai-veil.issue').waitFor({ timeout: 8000 });
await shot('page-problem', '.ai-veil.issue', { themes: LIGHT });

// ---- The preview's own states, pushed through the app's runtime status broadcast ----
const status = (s) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('runtime:status', s), s);
await status({ state: 'starting' });
await win.locator('.canvas-state .canvas-card').waitFor({ timeout: 8000 });
await shot('runtime-starting', '.canvas-state .starting-mark');
await status({ state: 'preparing', message: 'Installing the website tools. The first run takes about a minute.' });
await pause(200);
await shot('runtime-preparing', '.canvas-state .starting-mark', { themes: LIGHT });
await status({ state: 'error', message: 'The preview could not start', detail: 'vite: failed to bind port 5174' });
await pause(200);
await shot('runtime-error', '.canvas-state [role="alert"]');
await status({ state: 'idle' });
await pause(200);
await shot('runtime-paused', '.canvas-state .canvas-card', { themes: LIGHT });
await status({ state: 'unavailable', message: 'The website tools are not available on this computer.' });
await pause(200);
await shot('runtime-unavailable', '.canvas-state [role="status"]', { themes: LIGHT });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`canvas editing capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.filter((e) => !e.includes('Capture:')).length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
