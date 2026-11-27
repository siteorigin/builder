// Design capture for what the canvas shows while something is dragged over it: a section moved by the chip's grip, a
// tile dragged from Insert and a picture dragged from Assets. The drop line, the outlined container, the empty slots
// that light up, a place that refuses (on a wide box and on a narrow one at phone width) with its reason, the strip
// above the page, and what the pointer carries. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/canvas-drop-feedback.mjs
//
// Runs headless. Each capture is verified on screen after it settles; a state that did not render throws instead of
// writing a plausible-looking wrong image. Files are named `{state}--{theme}.png`: the `-zoom` ones are a close crop
// round the place under the pointer, the rest the canvas. `cursor.json` records the pointer's cursor in each state,
// which a screenshot does not show.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { createProject, launch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas drop feedback capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-drop-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const { app, win } = await launch(WORK);
const written = [];
const cursors = {};
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
let pointer = { x: 0, y: 0 };
const moveTo = async (x, y, steps = 12) => {
  await win.mouse.move(x, y, { steps });
  pointer = { x, y };
};

/** The cursor the window shows at the pointer, as the element under it computes it. */
const cursorAt = () => win.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  return el ? getComputedStyle(el).cursor : null;
}, pointer);

/**
 * Capture a state mid-drag. `check` must be visible at the moment of capture; `zoom` is a selector whose box (padded)
 * is also written as a close crop.
 */
async function shot(state, check, { themes = BOTH, zoom = null, pad = 70 } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(350);
    // A nudge, so the drag redraws in this theme where the pointer is.
    await win.mouse.move(pointer.x + 1, pointer.y, { steps: 1 });
    await win.mouse.move(pointer.x, pointer.y, { steps: 1 });
    await pause(300);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const canvas = await win.locator('.canvas').boundingBox();
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: canvas });
    written.push(path);
    console.log('wrote', path);
    if (zoom) {
      // The crop takes in the place and, where one shows, the reason hung from it.
      const boxes = [];
      for (const sel of [zoom, '[data-testid="insert-drop-reason"]']) {
        const one = await win.locator(sel).first().boundingBox().catch(() => null);
        if (one) boxes.push(one);
        else if (sel === zoom) throw new Error(`state "${state}" has no "${zoom}" to zoom on; refusing to write`);
      }
      const b = { x: Math.min(...boxes.map((o) => o.x)), y: Math.min(...boxes.map((o) => o.y)) };
      b.width = Math.max(...boxes.map((o) => o.x + o.width)) - b.x;
      b.height = Math.max(...boxes.map((o) => o.y + o.height)) - b.y;
      const x = Math.max(canvas.x, Math.min(b.x, pointer.x) - pad);
      const y = Math.max(canvas.y, Math.min(b.y, pointer.y) - pad);
      const right = Math.min(canvas.x + canvas.width, Math.max(b.x + b.width, pointer.x + 260) + pad);
      const bottom = Math.min(canvas.y + canvas.height, Math.max(b.y + b.height, pointer.y + 40) + pad);
      const zp = join(OUT, `${state}-zoom--${theme}.png`);
      await win.screenshot({ path: zp, clip: { x, y, width: right - x, height: bottom - y } });
      written.push(zp);
      console.log('wrote', zp);
    }
    if (theme === themes[0]) cursors[state] = await cursorAt();
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

const frame = win.frameLocator('.frame-box iframe');
const panel = win.locator('.side-panel-view:not([hidden])');
const basicTile = (name) => panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const openInsert = async () => {
  if (!(await panel.locator('.insert-group[data-group="basics"]').isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await panel.locator('.insert-group[data-group="basics"]').waitFor();
};
/** A point of a frame element in the window: `fx` across its width and `fy` down its height, scrolled into view. */
const pointIn = async (locator, fx = 0.5, fy = 0.5) => {
  await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    if (b.top < 0 || b.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await pause(150);
  const f = await win.locator('.frame-box iframe').boundingBox();
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth };
  });
  const k = f.width / r.vw;
  return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + r.height * fy) * k };
};
/** Press on a tile and move it a little, so it is dragged rather than clicked. */
const pickUp = async (tile) => {
  await tile.scrollIntoViewIfNeeded();
  const t = await tile.boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2 + 4, { steps: 3 });
};
/** Let go off the page, which cancels. */
const cancel = async () => {
  await win.keyboard.press('Escape');
  await pause(150);
  await win.mouse.up();
  await win.locator('.ov-moving').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await pause(300);
};
const clearSelection = async () => {
  const box = await win.locator('.canvas-scroll').boundingBox();
  await win.mouse.click(box.x + 16, box.y + 120);
  await pause(300);
};

const splitDesign = {
  type: 'component.upsert',
  name: 'Split',
  insertAs: 'element',
  properties: {},
  nodes: [
    { kind: 'element', id: 'root', children: ['mainCol', 'sideCol'], styles: { base: { layout: 'grid', columns: 2, gap: { token: 'space.md' } } } },
    { kind: 'element', id: 'mainCol', children: ['main'] },
    { kind: 'slot', id: 'main', slot: 'main' },
    { kind: 'element', id: 'sideCol', children: ['side'] },
    { kind: 'slot', id: 'side', slot: 'sidebar' }
  ],
  slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar', primitives: ['text'] } }
};
const marker = (slot) => frame.locator(`[data-so-slot-empty="${slot}"]`);

const sites = join(WORK, 'sites');

// ---- A business site ----
await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
await win.getByRole('radio', { name: 'Desktop', exact: true }).first().click();
await pause(1800);

// 1. A section dragged by the chip's grip: the moving strip and the drop line between sections.
{
  await clearSelection();
  await frame.locator('h1').first().dispatchEvent('click');
  await win.locator('.ov-chip .grip').waitFor({ timeout: 8000 });
  await pause(900);
  const grip = await win.locator('.ov-chip .grip').boundingBox();
  // Below the hero, within the window: anywhere between the hero and the next section is where it already is.
  const wrap = await win.locator('.frame-wrap').boundingBox();
  const scroll = await win.locator('.canvas-scroll').boundingBox();
  const next = await frame.locator('section[data-so-node="root"]').nth(1).boundingBox();
  await win.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 3 });
  await win.mouse.down();
  await win.mouse.move(grip.x + grip.width / 2 + 12, grip.y + grip.height / 2 + 6, { steps: 3 });
  await win.locator('.ov-moving').waitFor({ timeout: 8000 });
  await moveTo(wrap.x + wrap.width * 0.5, Math.min(next.y + next.height * 0.8, scroll.y + scroll.height - 90));
  await win.locator('.ov-drop').waitFor({ timeout: 8000 });
  await shot('move-line', '.ov-drop', { zoom: '.ov-drop' });
  await cancel();
}

// 2. A Paragraph from Insert over the hero's text: the line, the outlined container, the strip and the ghost.
await openInsert();
{
  await pickUp(basicTile('Paragraph'));
  const at = await pointIn(frame.locator('h1').first(), 0.3, 1.2);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="insert-drop-line"]').waitFor({ timeout: 8000 });
  await shot('insert-line', '[data-testid="insert-drop-line"]', { zoom: '[data-testid="insert-drop-line"]' });
  await cancel();
}

// 3. The same drag over a page painted in the selection's own blue: every mark has to hold on it.
{
  const paint = (on) =>
    frame.locator('html').evaluate((html, on) => {
      html.querySelector('#capture-paint')?.remove();
      if (!on) return;
      const s = document.createElement('style');
      s.id = 'capture-paint';
      s.textContent = 'main, main > *, main section { background: #1766c0 !important; color: #fff !important; } main h1, main h2, main h3, main p, main a, main span { color: #fff !important; }';
      html.querySelector('head').append(s);
    }, on);
  await paint(true);
  await pause(300);
  await pickUp(basicTile('Paragraph'));
  const at = await pointIn(frame.locator('h1').first(), 0.3, 1.2);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="insert-drop-line"]').waitFor({ timeout: 8000 });
  await shot('insert-on-blue', '[data-testid="insert-drop-line"]', { themes: LIGHT, zoom: '[data-testid="insert-drop-line"]' });
  await cancel();
  await paint(false);
  await pause(300);
}

// 4. A picture from Assets over the hero's empty image: the image outlined and filled, the strip and the ghost.
{
  const start = await snapshot();
  const home = start.site.homePageId;
  const hero = Object.values(start.pages[home].nodes).find((n) => n.kind === 'instance' && start.components[n.definitionId]?.componentId === 'hero.split').id;
  await apply([{ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: hero, prop: 'image', value: { assetId: null, alt: '' } }], 'Empty the hero image');
  const placeholder = frame.locator(`[data-so-ctx$="|${hero}"][data-so-node="media"]`);
  await placeholder.waitFor({ timeout: 15000 });
  await pause(600);
  await win.locator('.rail [aria-label="Assets"]').click();
  const tile = win.locator('[data-asset="a_reading"]');
  await tile.waitFor();
  await pickUp(tile);
  const at = await pointIn(placeholder, 0.5, 0.5);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="image-drop-target"]').waitFor({ timeout: 8000 });
  await shot('image-over-placeholder', '[data-testid="image-drop-target"]');

  // 5. The same picture off any place that takes it (the pasteboard beside the page): the quiet strip.
  const scroll = await win.locator('.canvas-scroll').boundingBox();
  const page = await win.locator('.frame-box iframe').boundingBox();
  // Over the page, where nothing takes a picture: tried along the shared header, then the footer.
  let idle = false;
  for (const target of [frame.locator('header').first(), frame.locator('footer').first()]) {
    for (const fx of [0.5, 0.15, 0.85]) {
      const p = await pointIn(target, fx, 0.5).catch(() => null);
      if (!p) continue;
      await moveTo(p.x, p.y, 6);
      await pause(250);
      if (await win.locator('.ov-moving.ov-placing.idle').isVisible().catch(() => false)) {
        idle = true;
        break;
      }
    }
    if (idle) break;
  }
  if (idle) await shot('image-idle', '.ov-moving.ov-placing.idle', { themes: LIGHT });
  else console.log('note: no idle place found for a picture on this page; image-idle not captured');
  // Off the page, on the pasteboard: the strip says to drag it onto the page.
  await moveTo(scroll.x + 14, page.y + 200, 6);
  await shot('image-off-page', '.ov-moving.ov-placing', { themes: LIGHT });
  await cancel();

  // 6. A Section holding a Split appended to this page, and the picture over its Sidebar, which takes only text.
  const [{ nodeId: sec }] = await apply([{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, componentId: 'layout.section' }], 'Insert section');
  const [{ definitionId: splitDef }] = await apply([splitDesign], 'Create Split');
  await apply([{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: sec, slot: 'content', definitionId: splitDef }], 'Place Split');
  await marker('sidebar').waitFor({ timeout: 30000 });
  await pointIn(marker('sidebar'), 0.5, 0.4);
  await pause(600);
  await pickUp(tile);
  const side = await pointIn(marker('sidebar'), 0.5, 0.4);
  await moveTo(side.x, side.y);
  await win.locator('.ov-moving.ov-placing.refused').waitFor({ timeout: 8000 });
  await shot('image-refused', '.ov-moving.ov-placing.refused', { themes: LIGHT, zoom: '[data-testid="insert-drop-target"]', pad: 40 });
  await cancel();
}

// ---- A Section holding a Split: Main takes anything, Sidebar only text ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Corner cafe', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60000 });
await pause(1500);
await win.getByRole('radio', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Insert section');
const [{ definitionId }] = await apply([splitDesign], 'Create Split');
const [{ nodeId: split }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', definitionId }], 'Place Split');
await marker('main').waitFor({ timeout: 30000 });
await marker('sidebar').waitFor({ timeout: 30000 });
await pause(800);
await openInsert();

// 6. A Paragraph over Main: both empty slots light up, named.
{
  await pickUp(basicTile('Paragraph'));
  const at = await pointIn(marker('main'), 0.5, 0.4);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="insert-slot-surface"]').nth(1).waitFor({ timeout: 8000 });
  await shot('insert-slots', '[data-testid="insert-slot-surface"]', { zoom: '[data-testid="insert-drop-target"]', pad: 40 });
  await cancel();
}

// 7. An Image tile over Sidebar, which takes only text: refused there, with the reason on it.
{
  await pickUp(basicTile('Image'));
  const at = await pointIn(marker('sidebar'), 0.5, 0.4);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="insert-drop-reason"]').waitFor({ timeout: 8000 });
  await shot('insert-refused', '[data-testid="insert-drop-reason"]', { zoom: '[data-testid="insert-drop-target"]', pad: 40 });
  await cancel();
}

// 8. A Button in Main moved by its grip over Sidebar: the move refused.
{
  await apply([{ type: 'node.insert', owner, parentId: split, slot: 'main', primitive: 'button', text: 'Book a table' }], 'Fill Main');
  const btn = frame.getByText('Book a table', { exact: true }).first();
  await btn.waitFor({ timeout: 30000 });
  await pause(600);
  const grip = win.locator('.ov-chip [aria-label="Drag to move"]');
  for (let i = 0; i < 5 && !/^(Button|Link)/.test((await win.locator('.ov-chip .label').allInnerTexts().catch(() => [])).join(' ')); i++) {
    const p = await pointIn(btn, 0.5, 0.5);
    await win.mouse.click(p.x, p.y);
    await pause(700);
  }
  await grip.waitFor({ timeout: 8000 });
  await pause(500);
  const g = await grip.boundingBox();
  await win.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await win.mouse.down();
  await win.mouse.move(g.x + g.width / 2 + 12, g.y + g.height / 2 + 6, { steps: 3 });
  const at = await pointIn(marker('sidebar'), 0.5, 0.4);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="insert-drop-reason"]').waitFor({ timeout: 8000 });
  await shot('move-refused', '[data-testid="insert-drop-reason"]', { themes: LIGHT, zoom: '[data-testid="insert-drop-target"]', pad: 40 });
  await cancel();
  await win.keyboard.press('Escape');
  await clearSelection();
}

// 10. At phone width, the same refused Image over a narrow Sidebar: the reason on a box under 220px wide.
{
  await win.getByRole('radio', { name: 'Phone', exact: true }).first().click();
  await pause(1500);
  await openInsert();
  await pickUp(basicTile('Image'));
  const at = await pointIn(marker('sidebar'), 0.5, 0.4);
  await moveTo(at.x, at.y);
  await win.locator('[data-testid="insert-drop-reason"]').waitFor({ timeout: 8000 });
  await shot('insert-refused-phone', '[data-testid="insert-drop-reason"]', { zoom: '[data-testid="insert-drop-target"]', pad: 40 });
  await cancel();
}

writeFileSync(join(OUT, 'cursor.json'), JSON.stringify(cursors, null, 2));
await app.close();
rmSync(WORK, { recursive: true, force: true });
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const p of written) if (!files.includes(basename(p))) throw new Error(`missing ${p}`);
console.log(`DONE ${written.length} captures in ${OUT}`);
