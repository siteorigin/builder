// Design capture harness for the component library: Insert > Your components, its manage menu, its larger preview,
// search, Variants and adding a component to the page. Drives the real built app through the library's
// design-relevant states in light and dark and writes one PNG per state and theme. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/component-library.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `library-{state}--{theme}.png`. Panel states are cropped to the
// rail, the panel and a strip of canvas (`wide` takes in the preview beside the panel); `full` states are the
// whole window.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('component library capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'component-library');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-library-')));
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
const library = panel.locator('.insert-group[data-kind="component"]');

await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Thumbnails and live previews arrive asynchronously: wait for those on screen, so a capture never shows one still loading. */
async function settled(state) {
  const ok = await win
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
        const sketches = [...view.querySelectorAll('.insert-tile.section .sketch, .insert-thumb .sketch')].filter((s) => !s.closest('.sparse')).filter(onScreen);
        // A component's live preview says when it is still loading.
        const loading = document.querySelectorAll('[data-preview-state="loading"]').length;
        return !sketches.length && !loading && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      null,
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) console.log(`note: "${state}" still shows a sketch, a loading preview or an unloaded thumbnail`);
}

/**
 * Capture a state; `check` must be visible at the moment of capture. `opts.full` captures the whole window,
 * otherwise the rail, the panel and a strip of canvas. `opts.keepPointer` leaves the mouse where it is.
 */
async function shot(state, check, themes = THEMES, opts = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    // Away from the panel, past the grace a preview gets while the pointer crosses to it.
    if (!opts.keepPointer) {
      await win.mouse.move(900, 6);
      await pause(700);
    }
    await pause(200);
    await settled(state);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `library-${state}--${theme}.png`);
    if (opts.full) await win.screenshot({ path });
    else {
      const box = await win.locator('.side-panel').boundingBox();
      if (!box) throw new Error(`state "${state}": the side panel has no box; refusing to write`);
      await win.screenshot({ path, clip: { x: 0, y: 0, width: Math.round(box.x + box.width + (opts.wide ? 400 : 140)), height: 900 } });
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
  await panel.locator('.search input').first().fill(text);
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
const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r?.ok) throw new Error(`${label}: ${r?.error?.message ?? JSON.stringify(r).slice(0, 200)}`);
      return r.results;
    },
    [operations, label]
  );
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
/** The library row for a component, by its exact name. */
const row = (name) => library.locator('.insert-tile.project', { has: win.locator('strong', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) });

// ---- A populated project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);

// ---- Before any component exists (Developer mode off): the library teaches how to make one ----
await openInsert();
await clearSelection();
await scrollPanel('end');
await shot('empty', '.side-panel-view:not([hidden]) .panel-body', ['light']);
await scrollPanel(0);

// ---- The library ----
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await pause(200);
await win.keyboard.press('Escape');
await pause(600);

let st = await snapshot();
const pages = st.site.pageOrder;
const home = { kind: 'page', id: st.site.homePageId ?? pages[0] };
const about = { kind: 'page', id: pages[1] ?? pages[0] };
const contact = { kind: 'page', id: pages[2] ?? pages[0] };

// A managed component made from a group the way Create component does: a card with a picture, a name, a role and a link.
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }], 'Insert Section');
const [{ nodeId: stack }] = await apply([{ type: 'node.insert', owner: home, parentId: section, slot: 'content', primitive: 'stack' }], 'Insert Stack');
await apply(
  [
    { type: 'node.insert', owner: home, parentId: stack, primitive: 'image' },
    { type: 'node.insert', owner: home, parentId: stack, primitive: 'heading', text: 'Mara Ellison' },
    { type: 'node.insert', owner: home, parentId: stack, primitive: 'paragraph', text: 'Lead architect. Twelve years of coastal homes and quiet studios.' },
    { type: 'node.insert', owner: home, parentId: stack, primitive: 'button', text: 'View projects' }
  ],
  'Fill card'
);
await apply([{ type: 'component.createFromNode', owner: home, nodeId: stack, name: 'Team member card' }], 'Create component');
st = await snapshot();
const card = Object.values(st.components).find((d) => d.owner === 'project' && d.name === 'Team member card');
if (!card) throw new Error('the managed component was not created');

// Placed again on another page, twice, and a separate copy made from one of those placements.
const placed = await apply(
  [
    { type: 'node.insert', owner: about, parentId: null, definitionId: card.id },
    { type: 'node.insert', owner: about, parentId: null, definitionId: card.id }
  ],
  'Insert Team member card'
);
try {
  await apply([{ type: 'component.makeUnique', owner: about, nodeId: placed[1].nodeId, name: 'Team member card (dark)' }], 'Make unique');
} catch (e) {
  console.log('copy not made:', String(e).slice(0, 200));
}

// A copy of a theme section, kept in the project with its variants, placed nowhere yet.
const hero = Object.values(st.components).find((d) => d.owner === 'theme' && d.componentId === 'hero.split') ?? Object.values(st.components).find((d) => d.owner === 'theme' && d.category === 'hero');
if (hero)
  try {
    await apply([{ type: 'component.fork', definitionId: hero.id }], `Make ${hero.name} a project component`);
  } catch (e) {
    console.log('section copy not made:', String(e).slice(0, 200));
  }

// Code components: one in the shared footer, one with a long name, one placed nowhere.
const CODE = {
  'Newsletter signup': '<section class="w"><h2>The monthly letter</h2><p>New projects, quiet studios and the odd floor plan.</p><form><input placeholder="Email address" /><button>Sign up</button></form></section>',
  'Annual and monthly pricing comparison with feature notes':
    '<section class="w"><h2>Plans</h2><div class="g"><div><h3>Monthly</h3><p>$40 a month</p><ul><li>Two site visits</li><li>Plans and elevations</li></ul><button>Choose monthly</button></div><div><h3>Annual</h3><p>$400 a year</p><ul><li>Unlimited visits</li><li>Plans, elevations and finishes</li></ul><button>Choose annual</button></div></div></section>',
  'Booking widget': '<section class="w"><h2>Book a consultation</h2><img alt="" /><form><select><option>Tuesday</option></select><button>Book</button></form></section>'
};
for (const [name, description] of [
  ['Newsletter signup', 'Collects an email address for the monthly letter.'],
  ['Annual and monthly pricing comparison with feature notes', 'Compares every plan side by side.'],
  ['Booking widget', 'Lets visitors pick a consultation slot.']
]) {
  const source = `${CODE[name]}\n<style>.w{padding:2rem;text-align:center}.g{display:grid;grid-template-columns:1fr 1fr;gap:2rem}form{display:flex;gap:.5rem;justify-content:center}</style>\n`;
  await apply([{ type: 'component.createCode', name, description, source }], `Create ${name}`);
}
st = await snapshot();
const byName = (n) => Object.values(st.components).find((d) => d.owner === 'project' && d.name === n);
const newsletter = byName('Newsletter signup');
const pricing = byName('Annual and monthly pricing comparison with feature notes');
try {
  await apply([{ type: 'node.insert', owner: { kind: 'shell', id: 'footer' }, parentId: null, definitionId: newsletter.id }], 'Insert Newsletter signup');
} catch (e) {
  console.log('footer placement not made:', String(e).slice(0, 200));
}
await apply([{ type: 'node.insert', owner: contact, parentId: null, definitionId: pricing.id }], 'Insert pricing');

await clearSelection();
await openInsert();
await scrollPanel(0);
st = await snapshot();
console.log('library:', Object.values(st.components).filter((d) => d.owner === 'project' && d.category !== 'shell').map((d) => d.name).join(' | '));

// ---- Rest: the library at the top of Insert ----
await library.locator('.insert-tile.project').first().waitFor({ timeout: 15000 });
await shot('rest', '.insert-group[data-kind="component"] .insert-tile.project');

// Every component, after Show all.
const more = library.locator('.insert-more');
if (await more.count()) {
  await more.click();
  await pause(400);
}
await shot('all', '.insert-group[data-kind="component"] .insert-tile.project');

// ---- Choosing: resting on a component, then reaching one by keyboard ----
await row('Team member card').hover();
await pause(1200);
await shot('hover', '.insert-peek', THEMES, { keepPointer: true, wide: true });
// The pointer crosses from the row to the preview, which stays open for it.
{
  const from = await row('Team member card').boundingBox();
  const to = await win.locator('.insert-peek').boundingBox();
  if (!from || !to) throw new Error('no row or preview to cross between');
  await win.mouse.move(to.x + 40, from.y + from.height / 2, { steps: 12 });
  await pause(600);
  if (!(await win.locator('.insert-peek').isVisible())) throw new Error('the preview closed while the pointer crossed to it');
}
await win.mouse.move(900, 6);
await pause(400);
// A code component, whose preview is its own render.
await row('Newsletter signup').hover();
await pause(1200);
await shot('hover-code', '.insert-peek', ['light'], { keepPointer: true, wide: true });
await win.mouse.move(900, 6);
await pause(400);
// The project's copy of a theme section.
await row('Split hero').hover();
await pause(1200);
await shot('hover-theme-copy', '.insert-peek', ['light'], { keepPointer: true, wide: true });
await win.mouse.move(900, 6);
await pause(400);
// Keyboard: from one row, Down moves to the next, as the grid's arrow keys do.
await row('Newsletter signup').focus();
await win.keyboard.press('ArrowDown');
await pause(1200);
await shot('focus', '.insert-peek', ['light'], { wide: true });

// ---- Managing: a component used on pages and in the footer, and a copy placed nowhere ----
await panel.getByRole('button', { name: 'Manage Team member card', exact: true }).click();
await pause(400);
await shot('menu-used', '[role="menu"]', THEMES);
await win.keyboard.press('Escape');
await pause(250);
const unused = (await row('Booking widget').count()) ? 'Booking widget' : 'Team member card (dark)';
await panel.getByRole('button', { name: `Manage ${unused}`, exact: true }).click();
await pause(400);
await shot('menu-unused', '[role="menu"]', ['light']);
await win.keyboard.press('Escape');
await pause(250);
// Right-click opens the same menu where the pointer is.
await row('Newsletter signup').click({ button: 'right' });
await pause(400);
await shot('menu-context', '[role="menu"]', ['light']);
await win.keyboard.press('Escape');
await pause(250);

// ---- Search: components rank with sections and elements ----
await search('card');
await shot('search', '.insert-results', ['light'], { wide: true });
// The first Escape puts the preview away and keeps the search; the second clears it.
await win.keyboard.press('Escape');
await pause(400);
if ((await panel.locator('.search input').first().inputValue()) !== 'card') throw new Error('the first Escape cleared the search');
if (await win.locator('.insert-peek').isVisible().catch(() => false)) throw new Error('the first Escape left the preview open');
await shot('search-escape', '.insert-result.active', ['light'], { wide: true });
await search('');
await pause(300);

// ---- Variants: the library above each section's options ----
await panel.locator('.insert-variants').click();
await pause(600);
await scrollPanel(0);
await shot('variants', '.insert-group[data-kind="component"]', THEMES);
await panel.locator('.insert-variants').click();
await pause(400);
await scrollPanel(0);

// ---- Adding one to the page, with a section selected ----
await frame.locator('h1').first().click();
await pause(700);
await openInsert();
await scrollPanel(0);
await row('Team member card').click();
await panel.locator('.insert-where.added').waitFor({ timeout: 15000 });
await pause(300);
await shot('after-insert', '.insert-where.added', ['light'], { full: true, keepPointer: true });
await win.mouse.move(900, 6);

// ---- The narrowest sidebar the divider allows (last: the width is not put back) ----
await clearSelection();
const divider = win.locator('.seam.left .resizer');
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
await shot('narrow', '.insert-group[data-kind="component"] .insert-tile.project', ['light']);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('library-') && f.endsWith('.png')).length;
console.log(`component library capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
