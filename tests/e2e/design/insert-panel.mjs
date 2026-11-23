// Design capture harness for the Insert panel (left sidebar, Insert tab). Drives the real built app through
// the panel's design-relevant states in light and dark and writes one PNG per state and theme. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/insert-panel.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of
// writing a plausible-looking wrong image. Files are named `insert-{state}--{theme}.png`. Panel states are
// cropped to the rail, the panel and a strip of canvas; `full` states are the whole window.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('insert panel capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-insert-')));
const THEMES = ['light', 'dark'];

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
const panel = win.locator('.side-panel-view:not([hidden])');
const body = panel.locator('.panel-body');

await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/**
 * Capture a state; `check` must be visible at the moment of capture. `opts.full` captures the whole window,
 * otherwise the rail, the panel and a strip of canvas. `opts.keepPointer` leaves the mouse where it is.
 */
async function shot(state, check, themes = THEMES, opts = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!opts.keepPointer) await win.mouse.move(900, 6);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `insert-${state}--${theme}.png`);
    if (opts.full) await win.screenshot({ path });
    else {
      const box = await win.locator('.side-panel').boundingBox();
      if (!box) throw new Error(`state "${state}": the side panel has no box; refusing to write`);
      await win.screenshot({ path, clip: { x: 0, y: 0, width: Math.round(box.x + box.width + 140), height: 900 } });
    }
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const openInsert = async () => {
  const b = win.locator('.rail [aria-label="Insert"]');
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(400);
};
const search = async (text) => {
  const input = panel.getByRole('searchbox').or(panel.locator('.search input')).first();
  await input.fill(text);
  await pause(400);
};
const clearSelection = async () => {
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await pause(300);
};
const scrollPanel = async (to) => {
  await body.evaluate((el, to) => el.scrollTo({ top: to === 'end' ? el.scrollHeight : to, behavior: 'instant' }), to);
  await pause(250);
};

// ---- A populated project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);

// ---- Rest: nothing selected, top of the panel ----
await openInsert();
await clearSelection();
await scrollPanel(0);
await shot('rest', '.insert-grid', THEMES, { full: true });

// The panel's own components area before any exist (Developer mode off).
await scrollPanel('end');
await shot('components-empty', '.side-panel-view:not([hidden]) .panel-body', ['light']);
await scrollPanel(0);

// ---- A section selected: sections go after it ----
await frame.locator('h1').first().click();
await pause(700);
await openInsert();
await scrollPanel(0);
await shot('section-selected', '.insert-grid');

// Further down with a section selected: the basic elements and where they go.
const basicsHead = panel.locator('.insert-head, .list-section', { hasText: /Basic|Elements/ }).first();
if (await basicsHead.count()) {
  await basicsHead.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await pause(250);
}
await shot('basics', '.insert-grid', ['light']);
// The pointer on an element tile: the line under search says where elements go.
await panel.locator('button.insert-tile', { hasText: 'Heading' }).first().hover();
await pause(250);
await shot('hover-element', '.insert-grid', ['light'], { keepPointer: true });
await win.mouse.move(900, 6);
await scrollPanel(0);

// ---- Pointer and keyboard ----
await win.locator('.side-panel-view:not([hidden]) button.insert-tile, .side-panel-view:not([hidden]) [data-insert-tile]').nth(1).hover();
await pause(250);
await shot('hover', '.insert-grid', ['light'], { keepPointer: true });
await win.mouse.move(900, 6);
// Keyboard: Down from the search field enters the palette, Right moves to the next tile.
await panel.locator('.search input').first().focus();
await win.keyboard.press('ArrowDown');
await win.keyboard.press('ArrowRight');
await pause(250);
await shot('focus', ':focus-visible', ['light']);

// ---- Search ----
await search('image');
await shot('search', '.insert-results, .insert-grid', ['light']);
await search('carousel');
await shot('no-results', '.side-panel-view:not([hidden]) .panel-body', THEMES);
await search('');

// ---- Your components, with Developer mode on ----
// Code components need Developer mode, so it is on before they are made.
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await pause(200);
await win.keyboard.press('Escape');
await pause(600);
const def = await win.evaluate(async () => {
  const snap = await window.builder.project.snapshot();
  return { pageId: snap.state.site.homePageId ?? Object.keys(snap.state.pages)[0] };
});
for (const [name, description] of [
  ['Booking widget', 'Lets visitors pick a consultation slot.'],
  ['Opening hours and location map', 'Studio hours with a map of how to find us.']
]) {
  const r = await win.evaluate(
    ([name, description]) =>
      window.builder.project.apply({ operations: [{ type: 'component.createCode', name, description, source: `<section class="w"><p>${name}</p></section>\n<style>.w{padding:2rem}</style>\n` }], label: `Create ${name}` }),
    [name, description]
  );
  if (!r?.ok) throw new Error(`could not create ${name}: ${JSON.stringify(r).slice(0, 200)}`);
}
// A managed component, made from a group the way Create component does.
try {
  const sec = await win.evaluate(
    (pageId) => window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: pageId }, parentId: null, componentId: 'layout.section' }], label: 'Insert Section' }),
    def.pageId
  );
  const sectionId = sec?.results?.[0]?.nodeId;
  const stack = await win.evaluate(
    ([pageId, sectionId]) => window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: pageId }, parentId: sectionId, slot: 'content', primitive: 'stack' }], label: 'Insert Stack' }),
    [def.pageId, sectionId]
  );
  const stackId = stack?.results?.[0]?.nodeId;
  await win.evaluate(
    ([pageId, stackId]) => window.builder.project.apply({ operations: [{ type: 'component.createFromNode', owner: { kind: 'page', id: pageId }, nodeId: stackId, name: 'Team member card' }], label: 'Create component' }),
    [def.pageId, stackId]
  );
} catch (e) {
  console.log('managed component not created:', String(e).slice(0, 200));
}
await clearSelection();
await openInsert();
await scrollPanel(0);
await shot('components', '.insert-tile.project, .side-panel-view:not([hidden]) [data-kind="project"]');

// ---- Inserting: the result on the page ----
await scrollPanel(0);
await frame.locator('h1').first().click();
await pause(600);
await openInsert();
const stats = panel.locator('button', { hasText: 'Statistics' }).first();
await stats.click();
await pause(1800);
await openInsert();
await shot('after-insert', '.editor', ['light'], { full: true });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('insert-') && f.endsWith('.png')).length;
console.log(`insert panel capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
