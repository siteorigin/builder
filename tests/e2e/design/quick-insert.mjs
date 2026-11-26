// Design capture for the quick insert list an Add button opens: on the canvas (a + between sections, a + inside a
// container) and on a slot in the Inspector. The states cover the list at rest for sections and for elements (several
// groups, project components among them), a search, the keyboard deep in a long list, a search with no match, a place
// nothing fits, and the Inspector's slot list. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/quick-insert.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`, cropped to the list and the button that
// opened it.
import { _electron as electron } from 'playwright';
import { openInspector } from '../harness.mjs';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('quick insert capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'quick-insert');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-qi-')));
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
// Twice the pixels, as on a Retina display, so 11px labels and 1px rings are legible in the captures.
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
const list = win.locator('[data-testid="quick-insert"]');
const search = list.getByRole('combobox');
const addButton = (side, nodeId) => win.locator(`[data-testid="canvas-add"][data-side="${side}"][data-node="${nodeId}"]`);

/**
 * Capture a state: `check` must be visible at the moment of capture. The image is the list and the button that opened
 * it (`around`), plus `pad` on each side, kept inside the window. The pointer is parked away from the list first.
 */
async function shot(state, check, { themes = LIGHT, around = null, pad = 40, park = true } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (park) await win.mouse.move(W - 4, H - 4);
    await pause(250);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const boxes = [await list.boundingBox()];
    if (around) {
      const b = await win.locator(around).first().boundingBox();
      if (b) boxes.push(b);
    }
    const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const x1 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
    const y1 = Math.min(H, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
    const path = join(OUT, `${state}--${theme}.png`);
    // Through the DevTools protocol: Playwright's own screenshot of an Electron window is taken at one pixel per CSS pixel.
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 } });
    writeFileSync(path, Buffer.from(png.data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(150);
}

const closeList = async () => {
  if (await list.isVisible().catch(() => false)) {
    await win.keyboard.press('Escape');
    await list.waitFor({ state: 'detached' });
  }
};
/** Press `button` until its list opens: a + pressed while a change is still saving opens nothing, as for a person. */
const openFrom = async (button) => {
  for (let tries = 0; ; tries++) {
    await button.waitFor({ timeout: 10000 });
    await button.click();
    if (await list.waitFor({ timeout: 3000 }).then(() => true, () => false)) return;
    if (tries === 4) throw new Error('the + never opened its list');
  }
};

// ---- A small site: two sections, a Row of words in the first, a Proof section that takes one piece of social proof ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('body *').first().waitFor({ timeout: 90000 });
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).pages[pageId];

// The Proof section first: copying the Section's design moves every Section on the page onto the copy.
const [{ nodeId: scratchSection }] = await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Insert section');
const sectionDef = (await home()).nodes[scratchSection].definitionId;
const [{ definitionId: proofDef }] = await apply([{ type: 'component.fork', definitionId: sectionDef }], 'Copy Section');
await apply(
  [
    { type: 'node.remove', owner, nodeId: scratchSection },
    { type: 'component.rename', definitionId: proofDef, name: 'Proof section' },
    { type: 'component.setSlot', definitionId: proofDef, slot: 'content', label: 'Proof', categories: ['social-proof'], max: 1 }
  ],
  'Make Proof section'
);
// A card of the project's own, with slots, so element lists show "Your components" and the Inspector has slots to fill.
const [{ definitionId: cardDef }] = await apply(
  [
    {
      type: 'component.upsert',
      name: 'Offer card',
      insertAs: 'element',
      properties: {},
      slots: { media: { label: 'Media', primitives: ['image'], max: 1 }, actions: { label: 'Actions', primitives: ['link', 'text'], max: 2 } },
      nodes: [
        { kind: 'element', id: 'root', tag: 'article', children: ['media', 'actions'] },
        { kind: 'slot', id: 'media', slot: 'media' },
        { kind: 'slot', id: 'actions', slot: 'actions' }
      ]
    }
  ],
  'Make Offer card'
);
const [{ nodeId: first }, { nodeId: second }, { nodeId: proof }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, definitionId: proofDef }
  ],
  'Insert sections'
);
const [{ nodeId: row }] = await apply([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'row' }], 'Insert row');
await apply(
  [
    { type: 'node.insert', owner, parentId: row, primitive: 'heading', text: 'Harbour Lane Studio' },
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Small-batch ceramics, thrown and glazed by hand on the waterfront.' },
    { type: 'node.insert', owner, parentId: second, slot: 'content', primitive: 'heading', text: 'Visit the workshop' },
    { type: 'node.insert', owner, parentId: second, slot: 'content', definitionId: cardDef },
    { type: 'node.insert', owner, parentId: proof, slot: 'content', componentId: 'block.stat' },
    { type: 'node.rename', owner, nodeId: first, name: 'Intro' },
    { type: 'node.rename', owner, nodeId: second, name: 'Workshop' }
  ],
  'Fill sections'
);
await frame.locator('p', { hasText: 'Small-batch ceramics' }).first().waitFor({ timeout: 30000 });

// Layers selects exactly what the capture needs, without depending on where the page puts it.
const openLayers = async () => {
  if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
};
const layer = (nodeId) => win.locator(`[role="tree"] [data-owner="page:${pageId}"][data-node="${nodeId}"]`);
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
const chip = async () => (await win.locator('.ov-chip .label').allInnerTexts()).join(' ');
/** Select what the chip calls `name` by clicking an element in the page: each click steps one level in. */
const selectIn = async (locator, name) => {
  for (let i = 0; i < 6; i++) {
    if (name.test(await chip())) return;
    const at = await pointIn(locator, 0.5, 0.5);
    await win.mouse.click(at.x, at.y);
    await pause(700);
  }
  if (!name.test(await chip())) throw new Error(`${name} is not selected; the chip says ${await chip()}`);
};
const select = async (nodeId) => {
  await openLayers();
  await layer(nodeId).first().click();
  await pause(500);
};

// ---- Between sections: the + below Intro ----
await select(first);
const below = addButton('after', first);
await openFrom(below);
await shot('sections', '.qi-item', { themes: BOTH, around: '[data-testid="canvas-add"][aria-expanded="true"]' });
await search.fill('ga');
await pause(300);
await shot('sections-search', '.qi-item', { themes: LIGHT, around: '[data-testid="canvas-add"][aria-expanded="true"]' });
await search.fill('zzqx');
await pause(300);
await shot('no-match', '.qi-empty', { themes: BOTH, around: '[data-testid="canvas-add"][aria-expanded="true"]' });
await closeList();

// ---- Inside a container: the + inside the Row ----
await select(first);
await selectIn(frame.locator('p', { hasText: 'Small-batch ceramics' }).first(), /^Row/);
await openFrom(addButton('inside', row));
await shot('elements', '.qi-item', { themes: BOTH, around: '[data-testid="canvas-add"][aria-expanded="true"]' });
for (let i = 0; i < 11; i++) await search.press('ArrowDown');
await pause(300);
await shot('elements-keyboard', '.qi-item[aria-selected="true"]', { themes: LIGHT, around: '[data-testid="canvas-add"][aria-expanded="true"]' });
await closeList();

// ---- Nothing fits: the Proof section's one place is taken, so its + offers nothing ----
// (A refusal after a choice is not captured: everything but a theme section is tried before it is listed.)
await select(proof);
await openFrom(addButton('inside', proof));
await shot('nothing-fits', '.qi-empty', { themes: BOTH, around: '[data-testid="canvas-add"][aria-expanded="true"]' });
await closeList();

// ---- A slot in the Inspector: Add to Actions on the Offer card ----
{
  // Through the Workshop section's own Slots section, which lists the card.
  await select(second);
  await openInspector(win);
  await win.locator('#dock-panel-inspect [data-instance-slot="content"]').getByRole('button', { name: 'Select Offer card' }).click();
  await pause(500);
  const add = win.getByRole('button', { name: 'Add to Actions', exact: true });
  await add.waitFor({ timeout: 10000 });
  await openFrom(add);
  await shot('inspector-slot', '.qi-item', { themes: BOTH, around: 'button[aria-label="Add to Actions"]' });
  await closeList();
}

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`quick insert capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
