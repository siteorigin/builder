// Design capture harness for the Insert panel (left sidebar, Insert tab). Drives the real built app through
// the panel's design-relevant states in light and dark and writes one PNG per state and theme. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/insert-panel.mjs
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
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'insert-panel');
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

/** Pack thumbnails arrive over IPC: wait for those on screen, so a capture never shows a sketch standing in for one. */
async function thumbnailsSettled(state) {
  const settled = await win
    .waitForFunction(
      () => {
        const view = document.querySelector('.side-panel-view:not([hidden])');
        if (!view) return true;
        const box = view.getBoundingClientRect();
        const onScreen = (el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom;
        };
        const imgs = [...view.querySelectorAll('img.insert-shot')].filter(onScreen);
        // A sketch inside `.sparse` was chosen over near-empty artwork; any other is still waiting for its thumbnail.
        const sketches = [...view.querySelectorAll('.insert-tile.section .sketch, .insert-thumb .sketch')].filter((s) => !s.closest('.sparse')).filter(onScreen);
        return !sketches.length && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      null,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!settled) console.log(`note: "${state}" still shows a sketch or an unloaded thumbnail`);
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
    await thumbnailsSettled(state);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `insert-${state}--${theme}.png`);
    if (opts.full) await win.screenshot({ path });
    else {
      const box = await win.locator('.side-panel').boundingBox();
      if (!box) throw new Error(`state "${state}": the side panel has no box; refusing to write`);
      // `wide` takes in the preview that opens beside the panel.
      await win.screenshot({ path, clip: { x: 0, y: 0, width: Math.round(box.x + box.width + (opts.wide ? 380 : 140)), height: 900 } });
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
await panel.getByRole('button', { name: 'Heading', exact: true }).hover();
await pause(250);
await shot('hover-element', '.insert-grid', ['light'], { keepPointer: true });
await win.mouse.move(900, 6);
await scrollPanel(0);

// ---- Pointer and keyboard: resting on a section tile opens its larger preview beside the panel ----
await win.locator('.side-panel-view:not([hidden]) button.insert-tile.section').nth(1).hover();
await pause(700);
await shot('hover', '.insert-peek', THEMES, { keepPointer: true, wide: true });
// A short section further down, whose small thumbnail says least.
await panel.getByRole('button', { name: 'Statistics', exact: true }).hover();
await pause(700);
await shot('hover-short', '.insert-peek', ['light'], { keepPointer: true, wide: true });
await win.mouse.move(900, 6);
await pause(300);
// A section inserted without its media: its preview adds the layout sketch in a corner.
await panel.getByRole('button', { name: 'Gallery', exact: true }).hover();
await pause(700);
await shot('hover-media', '.insert-peek-inset', ['light'], { keepPointer: true, wide: true });
await win.mouse.move(900, 6);
await pause(300);
await scrollPanel(0);
// Keyboard: Down from the search field enters the palette at the column layouts, Right moves to the next tile.
await panel.locator('.search input').first().focus();
await win.keyboard.press('ArrowDown');
await win.keyboard.press('ArrowRight');
await pause(400);
await shot('focus', '.insert-grid', ['light']);

// ---- Search ----
await search('image');
await shot('search', '.insert-results, .insert-grid', ['light']);
await search('carousel');
await shot('no-results', '.side-panel-view:not([hidden]) .panel-body', THEMES);
// Section results carry the theme pack's real thumbnails.
await search('hero');
await pause(300);
await shot('search-sections', '.insert-result .insert-shot', THEMES, { wide: true });
await search('');

// ---- Variants: each option listed as its own tile with its own thumbnail, under its section's name ----
await panel.locator('.insert-variants').click();
await pause(500);
await scrollPanel(0);
await shot('variants', '.insert-band', THEMES);
await panel.locator('.insert-variants').click();
await pause(300);
await scrollPanel(0);

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
  ['Opening hours and location map', 'Studio hours with a map of how to find us.'],
  ['Annual and monthly pricing comparison with feature notes','Compares every plan side by side.'],
  ['Newsletter signup', 'Collects an email address.'],
  ['Client logo wall', 'A wall of client logos.']
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

// The library's manage menu: rename, where it is used, delete.
await panel.locator('.insert-manage').first().click();
await pause(300);
await shot('manage-menu', '[role="menu"]', ['light']);
await win.keyboard.press('Escape');
await pause(200);

// ---- Inserting: the moment after adding, while the confirmation and its Undo are showing ----
await scrollPanel(0);
await frame.locator('h1').first().click();
await pause(600);
await openInsert();
const stats = panel.getByRole('button', { name: 'Statistics', exact: true });
await stats.scrollIntoViewIfNeeded();
await stats.click();
await panel.locator('.insert-where.added .insert-undo').waitFor({ timeout: 15000 });
await shot('after-insert', '.insert-where.added .insert-undo', ['light'], { full: true, keepPointer: true });
// Moving on to the next tile keeps the confirmation and says where that one would go.
await panel.getByRole('button', { name: 'Testimonials', exact: true }).hover();
await pause(200);
await shot('after-insert-next', '.insert-where.added .insert-undo', ['light'], { keepPointer: true });

// ---- The narrowest sidebar the divider allows (last: the width is not put back) ----
const divider = win.locator('.side-panel .resizer');
const sideWidth = async () => (await win.locator('.side-panel').boundingBox())?.width ?? 0;
await divider.focus();
for (let presses = 0; presses < 24; presses++) {
  const before = await sideWidth();
  await win.keyboard.press('ArrowLeft');
  await pause(60);
  if ((await sideWidth()) >= before) break;
}
await win.mouse.move(900, 6);
await pause(300);
await scrollPanel(0);
await shot('narrow', '.insert-grid', ['light']);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('insert-') && f.endsWith('.png')).length;
console.log(`insert panel capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
