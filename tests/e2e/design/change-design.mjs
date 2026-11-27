// Design capture for the Change design dialog (SwapComponentModal in Dialogs.tsx): a placed section or block shown
// as another design where it is. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/change-design.mjs
//
// The dialog is opened the way an author opens it, from the Inspector's menu for the selected placement, on the
// business starter's home page plus a layout section holding a heading (whose designs mostly can't take it) and one
// holding a block. Each capture checks its words are on screen after it settles, and throws rather than write an
// image of anything else. Files are `{state}--{theme}.png`, cropped to the dialog with a margin of the window.
import { mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('change design capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];

const { WORK, cleanup } = scratch('design-change-design');
const { app, win, errors } = await launch(WORK, {}, { viewport: { width: 1440, height: 1000 } });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const modal = win.locator('.modal').last();
const inspector = win.locator('#dock-panel-inspect');
const written = [];

/** The dialog with a margin of the window around it, so its edge and shadow read. */
async function clip() {
  const box = await modal.boundingBox();
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 48)), height: Math.min(size.height - y, Math.ceil(box.height + 48)) };
}

/** Capture the dialog in each theme; every `texts` entry must be visible in it at that moment. */
async function shot(state, texts, { themes = BOTH, keepPointer = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    if (!keepPointer) await win.mouse.move(2, 2);
    await pause(400);
    if (!(await modal.isVisible())) throw new Error(`state "${state}" (${theme}): no dialog is open; refusing to write`);
    for (const text of [].concat(texts)) {
      const visible = await modal.getByText(text).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${text}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await clip() });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function closeModal() {
  await win.keyboard.press('Escape');
  await win.locator('.modal').first().waitFor({ state: 'detached', timeout: 10000 });
}

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

const row = (id) => win.locator(`[role="tree"] [role="treeitem"][data-node="${id}"]`).first();
async function showLayers() {
  const layers = win.locator('.rail [aria-label="Layers"]');
  if ((await layers.getAttribute('aria-pressed')) !== 'true') await layers.click();
  await win.locator('[role="tree"]').first().waitFor();
}
/** Select a placement in Layers, opening its parent first when it sits inside one. */
async function select(id, parentId) {
  await showLayers();
  if (parentId) {
    await row(parentId).click();
    await pause(200);
    if ((await row(id).count()) === 0) {
      await win.keyboard.press('ArrowRight');
      await pause(250);
    }
  }
  await row(id).click();
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click().catch(() => {});
  await pause(500);
}
/** Open Change design from the Inspector's menu for the selected placement. */
async function openSwap() {
  await inspector.getByRole('button', { name: /^More actions for/ }).first().click();
  await win.getByRole('menuitem', { name: /^Change (section )?design/ }).click();
  await modal.waitFor();
  await modal.locator('[data-testid="swap-component-dialog"]').waitFor();
  await pause(400);
}
/** Pick a design by name, whatever control the dialog offers for it. */
async function pick(name) {
  const select = modal.locator('select');
  if (await select.count()) {
    const value = await select.locator('option', { hasText: new RegExp(`^${name}$`) }).first().getAttribute('value');
    await select.selectOption(value);
    await pause(350);
    const shown = await select.evaluate((el) => el.selectedOptions[0]?.textContent ?? '');
    if (shown !== name) throw new Error(`picked "${name}" but the dialog shows "${shown}"`);
  } else {
    const option = modal.getByRole('option', { name: new RegExp(`^${name}\\b`) }).first();
    await option.click();
    await pause(350);
    if ((await option.getAttribute('aria-selected')) !== 'true') throw new Error(`picked "${name}" but it is not selected`);
  }
}

// ---- A populated project ----
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1200);

let st = await snapshot();
const homeId = st.site.homePageId;
const page = { kind: 'page', id: homeId };
const home = () => st.pages[homeId];
const placed = (componentId) => home().rootIds.find((id) => st.components[home().nodes[id]?.definitionId]?.componentId === componentId);

// One design of the project's own, so Your components is offered; a layout section holding a heading, which most
// designs have no slot for; and one holding a block, which is changed as a block.
await apply(
  [
    { type: 'component.duplicate', definitionId: 'foundation.hero.split', name: 'Studio hero' },
    { type: 'node.insert', owner: page, newNodeId: 'n_band', parentId: null, index: 3, componentId: 'layout.section' },
    { type: 'node.insert', owner: page, parentId: 'n_band', slot: 'content', primitive: 'heading', text: 'Visit the studio' },
    { type: 'node.insert', owner: page, newNodeId: 'n_stats', parentId: null, index: 4, componentId: 'layout.section' },
    { type: 'node.insert', owner: page, parentId: 'n_stats', slot: 'content', newNodeId: 'n_stat', componentId: 'block.stat' }
  ],
  'Seed the capture'
);
await pause(800);
st = await snapshot();
const hero = placed('hero.split');
const media = placed('content.media');
if (!hero || !media) throw new Error('the business starter no longer has a split hero and a content section');

// ---- A section: opened, then each kind of plan ----
await select(hero);
await openSwap();
await shot('opened', ['Change section design']);
await pick('Centered hero');
await shot('keeps-everything', []);
await pick('Article header');
await shot('drops-most', []);
await pick('Studio hero');
await shot('own-component', []);
await closeModal();

await select(media);
await openSwap();
await pick('Services grid');
await shot('drops-with-reasons', []);
await closeModal();

// ---- A section whose content no design can take ----
await select('n_band');
await openSwap();
await shot('refusals-opened', ['Change section design']);
// The last row reached from the keyboard: the list keeps the dialog's focus from the moment it opens.
await win.keyboard.press('End');
await shot('refusals-end', ['Change section design']);
await closeModal();

// ---- The same section once the project has a layout design of its own: one fits, the rest share a reason ----
await apply([{ type: 'component.duplicate', definitionId: 'foundation.layout.section', name: 'Band' }], 'A layout of its own');
await pause(600);
await select('n_band');
await openSwap();
await shot('refusals-mixed', ['Band']);
await pick('Band');
await shot('refusals-mixed-picked', ['Band'], { themes: ['light'] });
// Browsing the refused designs with Band picked: their shared reason stays pinned under its heading.
await win.keyboard.press('End');
await shot('refusals-mixed-end', ['has a place for'], { themes: ['light'], keepPointer: true });
await closeModal();

// ---- A block inside a section ----
await select('n_stat', 'n_stats');
await openSwap();
await pick('Testimonial card');
await shot('block', ['Change design'], { themes: ['light'] });
await closeModal();

// ---- Keyboard: the choice made from the keyboard alone ----
await select(hero);
await openSwap();
await win.keyboard.press('ArrowDown');
await pause(150);
await win.keyboard.press('ArrowDown');
await pause(150);
await win.keyboard.press('Enter');
await pause(350);
const focused = await win.evaluate(() => document.activeElement?.getAttribute('role'));
if (focused !== 'listbox') throw new Error(`keyboard: focus is on "${focused}", not the list of designs; refusing to write`);
await shot('keyboard', ['Change section design'], { themes: ['light'], keepPointer: true });
await closeModal();

// ---- What the picked design would drop changes while the dialog is open ----
await select(hero);
await openSwap();
await pick('Article header');
await apply([{ type: 'instance.setProp', owner: page, nodeId: hero, prop: 'secondaryLabel', value: '' }], 'Clear the second button');
await pause(600);
await shot('losses-changed', ['has changed since you picked it'], { themes: ['light'] });
await closeModal();
await apply([{ type: 'instance.setProp', owner: page, nodeId: hero, prop: 'secondaryLabel', value: 'About the studio' }], 'Put the second button back');
await pause(400);

// ---- Forced colors: the picked row and the plan ----
await select(hero);
await openSwap();
await pick('Article header');
await win.emulateMedia({ forcedColors: 'active' });
await shot('forced-colors', ['Article header'], { themes: ['dark'] });
await win.emulateMedia({ forcedColors: 'none' });
await closeModal();

// ---- The picked design is removed while the dialog is open ----
await select(hero);
await openSwap();
await pick('Studio hero');
st = await snapshot();
const studio = Object.values(st.components).find((d) => d.name === 'Studio hero');
await apply([{ type: 'component.remove', definitionId: studio.id }], 'Remove Studio hero');
await pause(600);
await shot('gone', ['Studio hero'], { themes: ['light'] });
await closeModal();

const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`change design capture: ${written.length} images written, ${files.length} in ${OUT}`);
if (errors.length) console.log('page errors:', errors);
await app.close();
cleanup();
if (written.length !== 23) throw new Error(`expected 23 captures, wrote ${written.length}`);
