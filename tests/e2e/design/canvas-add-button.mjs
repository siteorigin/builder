// Design capture for the canvas's Add (+) buttons: the + on a section's top and bottom edge and the + inside a
// container, at rest, pointed at, focused from the keyboard and open, on a light section, a dark one and a photo, on a
// tall container, a one-line Row and a box smaller than the button's room, on a hovered section that is not selected,
// and on a phone-width page where the chip, the spacing handles and the + share a narrow section. Opt-in only, never
// part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/canvas-add-button.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`: the `-zoom` ones are a close crop round the
// buttons, the rest the box they belong to and its surroundings.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas add button capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'canvas-add-button');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-add-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), SITEORIGIN_DOCUMENTS: join(WORK, 'documents'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
// Twice the pixels, as on a Retina display, so the 1.5px rim and the 2px drop line are legible in the captures.
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    },
    [operations, label]
  );
const adds = () => win.locator('[data-testid="canvas-add"]').evaluateAll((els) => els.map((e) => `${e.dataset.side}:${e.getAttribute('aria-label')}`));
const addButton = (side, nodeId) => win.locator(`[data-testid="canvas-add"][data-side="${side}"][data-node="${nodeId}"]`);
const list = win.locator('[data-testid="quick-insert"]');

/**
 * Capture a state. `check` must be visible at the moment of capture. `hold` sets the state up for each theme (a hover,
 * a focus) and returns nothing; without it the pointer is parked off the canvas. The image is the union of `around`'s
 * boxes plus `pad` on each side, kept inside the canvas (or the window, with `inWindow`).
 */
async function shot(state, check, { themes = LIGHT, hold = null, pad = 60, around = ['.ov-selected'], inWindow = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (hold) await hold();
    else await win.mouse.move(W - 4, H - 4);
    await pause(350);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (${JSON.stringify(await adds())})`);
    const boxes = [];
    for (const sel of around) for (const b of await win.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }))) if (b.width || b.height) boxes.push(b);
    if (!boxes.length) throw new Error(`state "${state}" (${theme}): nothing of ${around.join(', ')} to frame`);
    const bound = inWindow ? { x: 0, y: 0, width: W, height: H } : await win.locator('.canvas').boundingBox();
    const x0 = Math.max(bound.x, Math.min(...boxes.map((b) => b.x)) - pad);
    const y0 = Math.max(bound.y, Math.min(...boxes.map((b) => b.y)) - pad);
    const x1 = Math.min(bound.x + bound.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
    const y1 = Math.min(bound.y + bound.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
    const path = join(OUT, `${state}--${theme}.png`);
    // Through the DevTools protocol: Playwright's own screenshot of an Electron window is taken at one pixel per CSS pixel.
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: Math.max(60, x1 - x0), height: Math.max(60, y1 - y0), scale: 1 } });
    writeFileSync(path, Buffer.from(png.data, 'base64'));
    written.push(path);
    console.log('wrote', path, JSON.stringify(await adds()));
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(150);
}

/** Point at a + (its drop line shows). */
const hoverOn = (locator) => async () => {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`no + to point at: ${JSON.stringify(await adds())}`);
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  await pause(250);
};
/** A + reached with the keyboard, shown as keyboard focus: onto it, past it, and back with Shift+Tab. */
const keyFocus = (locator) => async () => {
  await win.mouse.move(W - 4, H - 4);
  await locator.focus();
  await win.keyboard.press('Tab');
  await win.keyboard.press('Shift+Tab');
  await pause(200);
  const focused = await locator.evaluate((el) => el.matches(':focus-visible'));
  if (!focused) throw new Error('the + did not take keyboard focus back');
};

const layerRow = (name) => win.locator('[role="tree"] .list-item', { hasText: name }).first();
/** Open the Layers tree until a row shows. */
async function reveal(row) {
  for (let i = 0; i < 12 && !(await row.isVisible()); i++) {
    const closed = win.locator('[role="tree"] [aria-expanded="false"] .tree-toggle, [role="tree"] .list-item[aria-expanded="false"] .tree-toggle');
    if (!(await closed.count())) break;
    await closed.first().click();
    await pause(150);
  }
}
async function select(name) {
  await reveal(layerRow(name));
  await layerRow(name).click();
  await win.locator('.ov-chip').filter({ hasText: name }).first().waitFor({ timeout: 8000 });
  await win.locator('[data-testid="canvas-add"]').first().waitFor({ timeout: 8000 });
  await pause(600);
}
/** A point of an element in the page, in the window: the frame's box on screen plus the element's place, scaled. */
const pointIn = async (locator, fx, fy) => {
  const f = await win.locator('.frame-box iframe').boundingBox();
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth };
  });
  const k = f.width / r.vw;
  return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + r.height * fy) * k };
};
/** Scroll the page so an element of it is in view, with room above it. */
const scrollTo = async (locator) => {
  await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top - 140);
  });
  await pause(500);
};

// ---- A business site, with fixture sections first on the page ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ nodeId: intro }, { nodeId: dark }, { nodeId: strip }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, index: 1, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, index: 2, componentId: 'layout.section' }
  ],
  'Insert sections'
);
const [{ nodeId: panel }, { nodeId: row }] = await apply(
  [
    { type: 'node.insert', owner, parentId: intro, slot: 'content', primitive: 'stack' },
    { type: 'node.insert', owner, parentId: intro, slot: 'content', primitive: 'row' }
  ],
  'Insert containers'
);
await apply(
  [
    { type: 'node.insert', owner, parentId: panel, primitive: 'heading', text: 'Visit the studio' },
    { type: 'node.insert', owner, parentId: panel, primitive: 'paragraph', text: 'Open Tuesday to Saturday, ten until four. Bring your floor plan and we will sketch it with you.' },
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Free parking' },
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Step-free entrance' },
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Dogs welcome' },
    { type: 'node.insert', owner, parentId: dark, slot: 'content', primitive: 'heading', text: 'Commissions open for spring' },
    { type: 'node.insert', owner, parentId: dark, slot: 'content', primitive: 'paragraph', text: 'Tell us about the room and we will come back within a week.' },
    { type: 'node.insert', owner, parentId: strip, slot: 'content', primitive: 'paragraph', text: 'Free delivery within the city.' }
  ],
  'Fill containers'
);
const [{ nodeId: badge }] = await apply([{ type: 'node.insert', owner, parentId: panel, primitive: 'stack' }], 'Insert badge');
await apply([{ type: 'node.insert', owner, parentId: badge, primitive: 'paragraph', text: 'New' }], 'Fill badge');
// A short container (one line and a little padding): its inside + must clear its side padding handle.
const [{ nodeId: note }] = await apply([{ type: 'node.insert', owner, parentId: intro, slot: 'content', primitive: 'stack' }], 'Insert note');
await apply([{ type: 'node.insert', owner, parentId: note, primitive: 'paragraph', text: 'Closed on public holidays.' }], 'Fill note');
await apply(
  [
    { type: 'node.rename', owner, nodeId: intro, name: 'Studio intro' },
    { type: 'node.rename', owner, nodeId: dark, name: 'Commissions' },
    // A shallow strip of a section: its two edge buttons must not land on each other.
    { type: 'node.rename', owner, nodeId: strip, name: 'Delivery strip' },
    { type: 'node.setStyle', owner, nodeId: strip, scope: 'base', property: 'paddingBlock', value: '0' },
    { type: 'node.rename', owner, nodeId: panel, name: 'Visit panel' },
    { type: 'node.rename', owner, nodeId: row, name: 'Access row' },
    { type: 'node.rename', owner, nodeId: badge, name: 'Badge' },
    { type: 'node.rename', owner, nodeId: note, name: 'Holiday note' },
    { type: 'node.setStyle', owner, nodeId: note, scope: 'base', property: 'background', value: '#e7eef6' },
    { type: 'node.setStyle', owner, nodeId: note, scope: 'base', property: 'paddingBlock', value: '14px' },
    { type: 'node.setStyle', owner, nodeId: note, scope: 'base', property: 'paddingInline', value: '16px' },
    // A dark section: the + and its rim must hold on it.
    { type: 'node.setStyle', owner, nodeId: dark, scope: 'base', property: 'background', value: '#14213d' },
    { type: 'node.setStyle', owner, nodeId: dark, scope: 'base', property: 'color', value: '#ffffff' },
    // A small saturated badge, shorter than the + needs to sit in its corner.
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'background', value: '#ea580c' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'color', value: '#ffffff' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'maxWidth', value: '64px' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'paddingBlock', value: '4px' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'paddingInline', value: '10px' },
    // The panel sits on a light tint, so its corner + is on a coloured box.
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'background', value: '#f1ece2' },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'paddingBlock', value: { token: 'space.lg' } },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'paddingInline', value: { token: 'space.lg' } }
  ],
  'Style fixture'
);
await frame.locator('h2, h3', { hasText: 'Visit the studio' }).first().waitFor({ timeout: 30000 });
await pause(1500);
await win.locator('.rail [aria-label="Layers"]').click();
await pause(400);

const ADD = '[data-testid="canvas-add"]';
const zoomAround = (side, nodeId) => [`${ADD}[data-side="${side}"][data-node="${nodeId}"]`];

// ---- The light first section, selected: its two edge buttons among the chip and the spacing handles ----
await select('Studio intro');
await shot('section-selected', ADD, { themes: BOTH, pad: 40 });
await shot('section-after-zoom', ADD, { around: zoomAround('after', intro), pad: 90 });
await shot('section-after-hover-zoom', `${ADD}:hover`, { around: zoomAround('after', intro), pad: 90, hold: hoverOn(addButton('after', intro)) });
await shot('section-after-focus-zoom', `${ADD}:focus-visible`, { around: zoomAround('after', intro), pad: 90, hold: keyFocus(addButton('after', intro)) });
// Open: the list beside it.
await addButton('after', intro).click();
await list.waitFor({ timeout: 5000 });
await shot('section-after-open', `${ADD}[aria-expanded="true"]`, { around: [`${ADD}[aria-expanded="true"]`, '[data-testid="quick-insert"]'], pad: 50, inWindow: true, hold: async () => win.mouse.move(W - 4, H - 4) });
await win.keyboard.press('Escape');
await list.waitFor({ state: 'detached' });
await pause(300);
// Back on the + after Escape, focused from the keyboard: it must read apart from open.
await shot('section-after-focus-after-close-zoom', `${ADD}[data-side="after"]`, { around: zoomAround('after', intro), pad: 90, hold: async () => win.mouse.move(W - 4, H - 4) });

// ---- The dark section, selected ----
await select('Commissions');
await shot('dark-section-selected', ADD, { pad: 40 });
await shot('dark-before-zoom', ADD, { around: zoomAround('before', dark), pad: 90 });

await select('Delivery strip');
await shot('shallow-section', ADD, { pad: 40 });
// The section above it selected and the strip pointed at: the gap they share has one +, and the strip's other one
// must still keep clear of it.
{
  await select('Commissions');
  const target = frame.locator('p', { hasText: 'Free delivery within the city.' }).first();
  const hold = async () => {
    const at = await pointIn(target, 0.5, 0.5);
    await win.mouse.move(at.x + 300, at.y, { steps: 4 });
    await pause(400);
  };
  await hold();
  await win.locator(`${ADD}[data-node="${strip}"]`).first().waitFor({ timeout: 8000 });
  await shot('shallow-section-hovered', `${ADD}[data-node="${strip}"]`, { around: ['.ov-hover'], pad: 40, hold });
}

// ---- A tall container on a tint: the + inside its corner ----
await select('Visit panel');
await shot('panel-inside', `${ADD}[data-side="inside"]`, { pad: 50 });
await shot('panel-inside-hover-zoom', `${ADD}:hover`, { around: zoomAround('inside', panel), pad: 70, hold: hoverOn(addButton('inside', panel)) });
await shot('panel-inside-focus-zoom', `${ADD}:focus-visible`, { around: zoomAround('inside', panel), pad: 70, hold: keyFocus(addButton('inside', panel)) });

// ---- A one-line Row, and a box smaller than the +'s corner: what the + sits on ----
await select('Access row');
await shot('row-inside', `${ADD}[data-side="inside"]`, { pad: 50 });
await select('Badge');
await shot('badge-inside', `${ADD}[data-side="inside"]`, { pad: 60 });
await shot('badge-inside-hover', `${ADD}:hover`, { pad: 60, hold: hoverOn(addButton('inside', badge)) });
await select('Holiday note');
await shot('note-inside', `${ADD}[data-side="inside"]`, { pad: 50 });

// ---- A photo hero, selected ----
{
  await select('Split hero');
  const id = await win.locator(`${ADD}[data-side="after"]`).first().getAttribute('data-node');
  await shot('hero-selected', ADD, { pad: 40 });
  await shot('hero-after-zoom', ADD, { around: zoomAround('after', id), pad: 90 });
}

// ---- Hovered, not selected: the buttons a pointer finds on another section ----
{
  await select('Studio intro');
  const target = frame.locator('h2, h3', { hasText: 'Commissions open for spring' }).first();
  const hold = async () => {
    const at = await pointIn(target, 0.5, 0.5);
    await win.mouse.move(at.x + 200, at.y + 10, { steps: 4 });
    await pause(400);
  };
  await hold();
  await win.locator(`${ADD}[data-node="${dark}"]`).first().waitFor({ timeout: 8000 });
  await shot('hovered-section', `${ADD}[data-node="${dark}"]`, { around: ['.ov-hover', '.ov-selected'], pad: 30, hold });
}

// ---- A phone-width page: the chip, the spacing handles and the + share a narrow section ----
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await frame.locator('html').evaluate(() => new Promise((r) => setTimeout(r, 800)));
await pause(800);
await select('Studio intro');
await shot('phone-section', ADD, { pad: 50 });
await select('Commissions');
await shot('phone-dark-section', ADD, { pad: 50 });
// At a phone's zoom the badge is short but not narrow: its + must still clear its bottom handles.
await select('Badge');
await shot('phone-badge-inside', `${ADD}[data-side="inside"]`, { pad: 60 });
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await pause(1000);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`canvas add button capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
