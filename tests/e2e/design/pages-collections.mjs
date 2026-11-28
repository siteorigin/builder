// Design capture for the Collections block of the Pages panel: each collection with the layout its entries share and
// the settings of its index. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/pages-collections.mjs
//
// Drives the real (built) app: a business starter gets three collections through the real apply seam (a blog with
// categories and its own index description, an events collection whose index has its own design and a long name, and a
// data-only team list with no pages of its own). Captures are cropped to the rail and sidebar (`panel-*`) or to the
// block alone (`block-*`, for legibility); `context` is the whole window. Every capture checks its state on screen after
// it settles and throws rather than writing a wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('pages collections capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'pages-collections');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-collections-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const block = win.locator('.side-panel-view:not([hidden]) .pages-collections');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The rail and sidebar, plus a strip of canvas so the panel's edge reads. */
async function panelClip() {
  const box = await win.locator('.side-panel').boundingBox();
  return { x: 0, y: 0, width: Math.ceil(box.x + box.width + 16), height: 900 };
}
/** The Collections block alone, with a margin of sidebar round it. */
async function blockClip() {
  const side = await win.locator('.side-panel').boundingBox();
  const box = await block.boundingBox();
  const top = Math.max(0, Math.floor(box.y - 14));
  return { x: Math.floor(side.x), y: top, width: Math.ceil(side.width), height: Math.min(900 - top, Math.ceil(box.height + 28)) };
}

/** Capture a state; `check` must be visible at the moment of capture. `clip`: 'panel', 'block' or 'full'. */
async function shot(state, check, themes = BOTH, { clip = 'panel', keepPointer = false, hover = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (hover) await hover.hover();
    else if (!keepPointer) await win.mouse.move(900, 880);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(clip === 'full' ? {} : { clip: clip === 'block' ? await blockClip() : await panelClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label} failed: ${JSON.stringify(r?.error)}`);
  return r;
};
const showPages = async () => {
  if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();
  await pause(300);
  await block.waitFor();
  await block.scrollIntoViewIfNeeded();
  await pause(200);
};

// ---- Project: the business starter, with three collections ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);

const posts = [
  ['A garden room that opened up the whole house', '2026-10-28', 'projects'],
  ['Choosing oak: oiled, lacquered or left alone', '2026-10-14', 'materials'],
  ['Small flats, big ideas: storage that disappears', '2026-09-30', 'ideas'],
  ['Planning light before you plan furniture', '2026-09-12', 'ideas'],
  ['Inside the studio: how a project runs', '2026-08-25', 'projects'],
  ['The kitchen we almost got wrong', '2026-08-02', 'projects'],
  ['One colour, every wall: a case for restraint', '2026-07-15', 'materials']
];
const events = [
  ['Open studio evening', '2026-12-04'],
  ['Colour workshop for renters', '2026-12-11'],
  ['Kitchen planning clinic', '2027-01-15']
];
await apply(
  [
    { type: 'collection.create', collectionId: 'posts', name: 'Journal', route: '/journal/' },
    {
      type: 'collection.update',
      collectionId: 'posts',
      pageSize: 12,
      description: 'Notes from the studio on projects, materials and the small decisions that make a room work.',
      taxonomies: { categories: { label: 'Categories', terms: { projects: { label: 'Projects' }, materials: { label: 'Materials' }, ideas: { label: 'Ideas' } } } }
    },
    ...posts.map(([title, publishedAt, cat], i) => ({ type: 'entry.create', collectionId: 'posts', entryId: `en_post0${i}`, title, publishedAt, draft: false, body: ['A short note.'], terms: { categories: [cat] } })),
    { type: 'collection.create', collectionId: 'events', name: 'Workshops & open studio evenings', route: '/workshops-and-open-evenings/', pageSize: 9, termArchives: false, archiveTemplate: 'start' },
    ...events.map(([title, publishedAt], i) => ({ type: 'entry.create', collectionId: 'events', entryId: `en_event0${i}`, title, publishedAt, draft: false, body: ['Come along.'] })),
    { type: 'collection.create', collectionId: 'projects', name: 'Case studies', route: '/case-studies/', pages: { detail: true, archive: false } },
    { type: 'entry.create', collectionId: 'projects', entryId: 'en_proj01', title: 'Kōwhai Street apartment', publishedAt: '2026-06-01', draft: false, body: ['A calm flat.'] },
    { type: 'collection.create', collectionId: 'team', name: 'Team', pages: { detail: false, archive: false }, hasBody: false },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_team01', title: 'Hannah Wells', draft: false },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_team02', title: 'Marcus Lee', draft: false }
  ],
  'Add the collections'
);
await pause(800);
await showPages();

// Rest: the page list with the Collections block under it, and the block alone.
await shot('panel-rest', '.pages-collections');
await shot('block-rest', '.pages-collections', BOTH, { clip: 'block' });

// Every index's settings open (any disclosure the block has), the state the remaining captures keep.
for (let i = 0; i < 10 && (await block.locator('button[aria-expanded="false"]').count()); i++) await block.locator('button[aria-expanded="false"]').first().click();
await pause(300);
await block.scrollIntoViewIfNeeded();
await shot('block-settings', '.pages-collections', BOTH, { clip: 'block' });
// The end of the block, scrolled down: the last collection (Team, whose entries have no pages).
await block.locator('li').last().scrollIntoViewIfNeeded();
await pause(200);
await shot('panel-settings-end', '.pages-collections li:last-child', LIGHT);
await block.scrollIntoViewIfNeeded();

// Keyboard: Tab from the last page row into the block, to the first control in it.
await win.locator('.side-panel [data-page]').last().focus();
for (let i = 0; i < 3; i++) await win.keyboard.press('Tab');
await pause(300);
await shot('block-keyboard', '.pages-collections :focus-visible', LIGHT, { clip: 'block', keepPointer: true });
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

// The index description being written: focused, with its own text.
const desc = block.getByRole('textbox').first();
await desc.click();
await pause(300);
await shot('block-description-focus', '.pages-collections :focus', LIGHT, { clip: 'block', keepPointer: true });
await win.keyboard.press('Escape');
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
await pause(200);

// A layout open on the canvas: Edit layout on the Journal, then back to Pages to see the open row.
await win.locator('[data-testid="edit-layout-posts"]').click();
await pause(1500);
await shot('context-layout-open', '[data-testid="template-strip"]', LIGHT, { clip: 'full' });
await showPages();
await shot('block-layout-open', '.pages-collections', BOTH, { clip: 'block' });
// Back out of the layout.
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
const done = win.locator('[data-testid="template-strip"] button', { hasText: 'Done' });
if (await done.count()) await done.click();
await pause(800);
await showPages();

// The whole window, for the block's place in the editor.
await shot('context', '.editor', LIGHT, { clip: 'full' });

// The narrowest sidebar (200px): the resizer dragged 60px to the left, then back.
const handle = win.locator('.seam.left .resizer');
const resize = async (dx) => {
  const b = await handle.boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 6 });
  await win.mouse.up();
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await pause(300);
};
if (!(await handle.boundingBox())) throw new Error('no sidebar resizer for the narrow capture');
await resize(-60);
await block.scrollIntoViewIfNeeded();
await shot('block-narrow', '.pages-collections', LIGHT, { clip: 'block' });
await resize(60);
await block.scrollIntoViewIfNeeded();

// Going back to the ready-made cards on the designed events index: what one click does (a question, or the change).
const readyMade = block.getByRole('button', { name: /ready-made/i }).first();
if (!(await readyMade.count())) {
  // Collapsed behind a disclosure: open the events collection's settings first.
  const more = block.locator('li', { hasText: 'Workshops' }).locator('button[aria-expanded="false"]').first();
  if (await more.count()) await more.click();
  await pause(300);
}
await block.getByRole('button', { name: /ready-made/i }).first().scrollIntoViewIfNeeded();
await shot('block-designed', '.pages-collections', LIGHT, { clip: 'block' });
await block.getByRole('button', { name: /ready-made/i }).first().click();
await pause(500);
const asked = await win.locator('.modal').isVisible().catch(() => false);
await shot(asked ? 'ready-made-ask' : 'ready-made-click', asked ? '.modal' : '.pages-collections', LIGHT, { clip: asked ? 'full' : 'block' });
if (asked) await win.keyboard.press('Escape');
await pause(300);

// A collection whose entries have no pages (Team): its settings, from its row (when the row offers them).
const settingsButton = block.getByRole('button', { name: 'Collection settings of Team' });
if (await settingsButton.count()) {
  await settingsButton.scrollIntoViewIfNeeded();
  await settingsButton.click();
  await win.locator('.modal', { hasText: 'Team settings' }).waitFor({ timeout: 5000 });
  await shot('lists-only-settings', '.modal', LIGHT, { clip: 'full' });
  await win.keyboard.press('Escape');
  await pause(300);
  if (!(await settingsButton.evaluate((el) => el === document.activeElement))) throw new Error('closing the settings did not return focus to the Team row');
}

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`pages collections capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
