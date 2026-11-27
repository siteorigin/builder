// Design capture for the canvas spacing and layout handles: padding, margin, gap, column divider and max-width bars
// on the selected box, the band each lights, and the readout pill while a drag runs. The states cover a full-width
// first section (where the page's edge clips), a dark panel with one side's padding at zero, a box narrower than its
// handles, a grid of uneven fr columns, a centred container's max width, and the handles
// reached from the keyboard. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/canvas-spacing-handles.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`, cropped to the selected box and its
// surroundings so the handles are legible.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas spacing handles capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'canvas-spacing-handles');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-space-')));
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
// Twice the pixels, as on a Retina display, so a 4px bar and its keylines are legible in the captures.
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
const handles = () => win.locator('.ov-space-handle').evaluateAll((els) => els.map((e) => e.dataset.testid));

/**
 * Capture a state. `check` must be visible at the moment of capture. `hold` sets the state up for each theme (a
 * hover, a drag held down) and returns a function that lets it go; without it the pointer is parked off the canvas.
 * The image is the selected box plus `pad` on each side (the readout and the outer handles stand past it), kept
 * inside the canvas.
 */
async function shot(state, check, { themes = LIGHT, hold = null, pad = 90, around = '.ov-selected' } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    const letGo = hold ? await hold() : (await win.mouse.move(2, 450), null);
    await pause(300);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      if (letGo) await letGo();
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    }
    const sel = await win.locator(around).first().boundingBox();
    const canvas = await win.locator('.canvas').boundingBox();
    const x0 = Math.max(canvas.x, sel.x - pad);
    const y0 = Math.max(canvas.y, sel.y - pad);
    const x1 = Math.min(canvas.x + canvas.width, sel.x + sel.width + pad);
    const y1 = Math.min(canvas.y + canvas.height, sel.y + sel.height + pad);
    const path = join(OUT, `${state}--${theme}.png`);
    // Through the DevTools protocol: Playwright's own screenshot of an Electron window is taken at one pixel per CSS pixel.
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: Math.max(80, x1 - x0), height: Math.max(80, y1 - y0), scale: 1 } });
    writeFileSync(path, Buffer.from(png.data, 'base64'));
    written.push(path);
    console.log('wrote', path, JSON.stringify(await handles()));
    if (letGo) await letGo();
    await pause(200);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

const centre = async (testId) => {
  const b = await win.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`no handle ${testId}: ${JSON.stringify(await handles())}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Point at a handle (its band lights, and its readout follows after a moment). */
const hover = (testId) => async () => {
  const c = await centre(testId);
  await win.mouse.move(c.x, c.y, { steps: 3 });
  await pause(500);
  return null;
};
/** Press a handle and drag it `dx`, `dy` screen pixels, held down; the returned function presses Escape and lets go. */
const drag = (testId, dx, dy, { alt = false } = {}) => async () => {
  const c = await centre(testId);
  await win.mouse.move(c.x, c.y);
  if (alt) await win.keyboard.down('Alt');
  await win.mouse.down();
  await win.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 4 });
  await win.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
  await win.getByTestId('spacing-hud').waitFor({ timeout: 5000 });
  await pause(400);
  return async () => {
    await win.keyboard.press('Escape');
    await win.mouse.up();
    if (alt) await win.keyboard.up('Alt');
    await pause(300);
  };
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
  await win.locator('.ov-space-handle').first().waitFor({ timeout: 8000 });
  await pause(500);
}
async function selectPart(section, part) {
  const row = layerRow(section);
  await row.click();
  const partRow = win.locator('[role="tree"] .list-item.layer-part', { hasText: part }).first();
  if (!(await partRow.isVisible())) await row.locator('.tree-toggle').click();
  await partRow.click();
  await win.locator('.ov-chip').filter({ hasText: part }).first().waitFor({ timeout: 8000 });
  await win.locator('.ov-space-handle').first().waitFor({ timeout: 8000 });
  await pause(500);
}

// ---- A business site, with a fixture section first on the page ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await win.getByRole('radio', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }], 'Insert section');
const [{ nodeId: panel }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }], 'Insert panel');
await apply(
  [
    { type: 'node.insert', owner, parentId: panel, primitive: 'heading', text: 'Visit the studio' },
    { type: 'node.insert', owner, parentId: panel, primitive: 'paragraph', text: 'Open Tuesday to Saturday, ten until four. Bring your floor plan and we will sketch it with you.' }
  ],
  'Fill panel'
);
const [{ nodeId: badge }] = await apply([{ type: 'node.insert', owner, parentId: panel, primitive: 'stack' }], 'Insert badge');
await apply([{ type: 'node.insert', owner, parentId: badge, primitive: 'paragraph', text: 'New' }], 'Fill badge');
const [{ nodeId: grid }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'grid' }], 'Insert grid');
const [{ nodeId: col1 }, { nodeId: col2 }] = await apply(
  [
    { type: 'node.insert', owner, parentId: grid, primitive: 'stack' },
    { type: 'node.insert', owner, parentId: grid, primitive: 'stack' }
  ],
  'Insert columns'
);
await apply(
  [
    { type: 'node.insert', owner, parentId: col1, primitive: 'heading', text: 'Considered layouts' },
    { type: 'node.insert', owner, parentId: col1, primitive: 'paragraph', text: 'Rooms that hold their shape as the light moves through the day.' },
    { type: 'node.insert', owner, parentId: col2, primitive: 'heading', text: 'Honest materials' },
    { type: 'node.insert', owner, parentId: col2, primitive: 'paragraph', text: 'Timber, lime and stone, chosen to age well.' }
  ],
  'Fill columns'
);
await apply(
  [
    { type: 'node.rename', owner, nodeId: section, name: 'Studio intro' },
    { type: 'node.rename', owner, nodeId: panel, name: 'Visit panel' },
    { type: 'node.rename', owner, nodeId: badge, name: 'Badge' },
    { type: 'node.rename', owner, nodeId: grid, name: 'Columns' },
    // A dark panel with no padding on its left: the handles must hold on it, and the zero side still be findable.
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'background', value: '#14213d' },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'color', value: '#ffffff' },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'paddingBlock', value: { token: 'space.lg' } },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'paddingInlineStart', value: '0' },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'paddingInlineEnd', value: { token: 'space.xl' } },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'gap', value: { token: 'space.md' } },
    { type: 'node.setStyle', owner, nodeId: panel, scope: 'base', property: 'marginBlockEnd', value: { token: 'space.lg' } },
    // A small saturated badge, narrower than its padding and margin handles side by side.
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'background', value: '#ea580c' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'maxWidth', value: '64px' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'paddingBlock', value: '6px' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'paddingInline', value: '10px' },
    { type: 'node.setStyle', owner, nodeId: badge, scope: 'base', property: 'marginBlockStart', value: '4px' },
    // Uneven columns, as a person would set them by hand.
    { type: 'node.setStyle', owner, nodeId: grid, scope: 'desktop', property: 'columns', value: 2 },
    { type: 'node.setStyle', owner, nodeId: grid, scope: 'base', property: 'gridTemplate', value: '1.5fr 1fr' }
  ],
  'Style fixture'
);
await frame.locator('h2, h3', { hasText: 'Visit the studio' }).first().waitFor({ timeout: 30000 });
await pause(1500);
await win.locator('.rail [aria-label="Layers"]').click();
await pause(400);

// ---- The full-width first section ----
await select('Studio intro');
console.log('section handles', JSON.stringify(await handles()));
await shot('section-rest', '.ov-space-handle', { themes: BOTH });
{
  const hs = await handles();
  const side = hs.find((h) => h === 'spacing-padding-right') ?? hs.find((h) => h === 'spacing-padding-left');
  if (side) await shot('section-drag-side', '[data-testid="spacing-hud"]', { hold: drag(side, side.endsWith('right') ? -40 : 40, 0) });
  else console.log('skipped section-drag-side: no side padding handle on the section');
  if (hs.includes('spacing-padding-top')) await shot('section-drag-top', '[data-testid="spacing-hud"]', { themes: BOTH, hold: drag('spacing-padding-top', 0, 30) });
  if (hs.includes('spacing-margin-top')) await shot('section-hover-margin-top', '.ov-space-handle', { hold: hover('spacing-margin-top') });
  else console.log('skipped section-hover-margin-top: no top margin handle on the section');
}

// ---- The dark panel: a zero side, gap between what it holds ----
await select('Visit panel');
console.log('panel handles', JSON.stringify(await handles()));
await shot('panel-rest', '.ov-space-handle', { themes: BOTH });
{
  const hs = await handles();
  const zero = hs.includes('spacing-padding-left') ? 'spacing-padding-left' : null;
  if (zero) await shot('panel-hover-zero', '.ov-space-handle', { hold: hover(zero) });
  else console.log('skipped panel-hover-zero: no left padding handle');
  const gap = hs.find((h) => h.startsWith('layout-gap-'));
  if (gap) await shot('panel-drag-gap', '[data-testid="spacing-hud"]', { themes: BOTH, hold: drag(gap, 0, 24) });
  else console.log('skipped panel-drag-gap: no gap handle');
  // Its space below (Large): a margin band with something in it.
  if (hs.includes('spacing-margin-bottom')) await shot('panel-hover-margin', '[data-testid="spacing-hud"]', { hold: hover('spacing-margin-bottom') });
}

// ---- The narrow badge ----
await select('Badge');
console.log('badge handles', JSON.stringify(await handles()));
await shot('badge-rest', '.ov-space-handle', { pad: 70 });
{
  const hs = await handles();
  if (hs.includes('spacing-margin-top')) await shot('badge-hover-margin', '.ov-space-handle', { pad: 70, hold: hover('spacing-margin-top') });
}

// ---- The uneven grid: its divider ----
await select('Columns');
console.log('grid handles', JSON.stringify(await handles()));
await shot('grid-rest', '.ov-space-handle');
{
  const hs = await handles();
  const split = hs.find((h) => h.startsWith('layout-split-'));
  if (split) await shot('grid-drag-split', '[data-testid="spacing-hud"]', { hold: drag(split, 60, 0) });
  else console.log('skipped grid-drag-split: no divider');
}

// ---- The Split hero: an exact (Alt) drag, its Actions' gap, its Container's max width ----
await select('Split hero');
await shot('hero-drag-alt', '[data-testid="spacing-hud"]', { hold: drag('spacing-padding-bottom', 0, -23, { alt: true }) });
await selectPart('Split hero', 'Actions');
await shot('actions-drag-gap', '[data-testid="spacing-hud"]', { hold: drag('layout-gap-x-0', 14, 0) });
// The first Container part in Layers is the Studio intro's: a centred box with a max width.
await selectPart('Split hero', 'Container');
await shot('container-drag-width', '[data-testid="spacing-hud"]', { pad: 90, hold: drag('layout-width-right', -120, 0) });

// ---- A phone-width page: the readout must fit a narrow canvas ----
await win.getByRole('radio', { name: 'Phone', exact: true }).first().click();
await frame.locator('html').evaluate(() => new Promise((r) => setTimeout(r, 800)));
await select('Visit panel');
{
  const gap = (await handles()).find((h) => h.startsWith('layout-gap-'));
  if (gap) await shot('phone-drag-gap', '[data-testid="spacing-hud"]', { pad: 60, hold: drag(gap, 0, 24) });
  else console.log('skipped phone-drag-gap: no gap handle on a phone');
}
await win.getByRole('radio', { name: 'Desktop', exact: true }).first().click();
await pause(1200);

// ---- The keyboard: a handle reached with Tab, shown focused ----
await select('Visit panel');
{
  const focusable = await win.locator('.ov-space-handle[tabindex]').count();
  if (focusable) {
    // Reached with the keyboard, so it shows as keyboard focus: onto the second handle, and back with Shift+Tab.
    await win.locator('.ov-space-handle[tabindex]').first().focus();
    await win.keyboard.press('Tab');
    await win.keyboard.press('Shift+Tab');
    await pause(300);
    await shot('panel-focus', '.ov-space-handle:focus-visible, .ov-space-handle:focus', { hold: async () => null });
    await win.keyboard.press('ArrowUp');
    await pause(700);
    await shot('panel-key-step', '[data-testid="spacing-hud"]', { hold: async () => null });
    await win.keyboard.press('Escape');
    await pause(300);
  } else console.log('skipped panel-focus, panel-key-step: no handle takes focus');
}

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`canvas spacing handles capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
