// Design capture for the Posts panel (the left sidebar's Content tab). Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/posts-panel.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. Panel states are cropped to the rail and
// sidebar so the rows are legible; `context` is the whole window. Every capture checks its state on screen
// after it settles and throws rather than writing a wrong image; a state the panel does not offer is reported
// as skipped, never written.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('posts panel capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'posts-panel');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-posts-')));
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
const skipped = [];
const panel = win.locator('.posts-panel');
const row = (title) => panel.locator('[data-post]', { hasText: title }).first();
/** Opens an entry the way a pointer does: a click on its title. */
const openRow = (title) => row(title).click({ position: { x: 48, y: 12 } });
/** Show a collection: from the head's collection menu. */
async function showCollection(name) {
  await panel.locator('.posts-switch').click();
  await win.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
  await pause(600);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The rail and sidebar, plus a strip of the writer so the panel's edge reads. */
async function panelClip() {
  const box = await win.locator('.side-panel').boundingBox();
  let right = box.x + box.width + 16;
  const menu = win.locator('.menu').first();
  if (await menu.isVisible().catch(() => false)) {
    const m = await menu.boundingBox();
    right = Math.max(right, (m?.x ?? 0) + (m?.width ?? 0) + 12);
  }
  return { x: 0, y: 0, width: Math.ceil(right), height: 900 };
}

async function shot(state, check, themes = BOTH, { full = false, keepPointer = false, hover = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (hover) await hover.hover();
    else if (!keepPointer) await win.mouse.move(900, 880);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await panelClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const skip = (state, why) => (skipped.push(state), console.log(`skipped ${state}: ${why}`));
const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
  return r;
};

// ---- Project: the business starter with a blog of fourteen posts ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);

// The empty blog first: Content with no collection yet.
await win.locator('.rail [aria-label="Content"]').click();
await pause(400);
await shot('no-collection', '.posts-panel [data-starter="posts"]', LIGHT);

const posts = [
  ['Choosing paint for a north-facing room', '2026-10-02', false, 'Mere Tane', 'Cool light flattens warm whites; here is what we reach for instead.'],
  ['We’re opening a Wellington studio', '2026-11-18', true, 'Sam Okafor', 'A second studio on Cuba Street, opening in the new year.'],
  ['Kōwhai Street apartment: before and after', '2026-09-14', false, 'Mere Tane', 'A 1970s two-bedroom opened up around its kitchen.'],
  ['Five fabrics that survive a family', '2026-08-30', false, 'Ana Lima', 'Performance linens, wool bouclé and the rest of our shortlist.'],
  ['Lighting a hallway with no windows', '2026-08-03', false, 'Sam Okafor', 'Layered light for the darkest room in the house.'],
  ['Notes from the Milan furniture fair', '2026-04-22', false, 'Ana Lima', 'Travertine everywhere, and the return of the tubular chair.'],
  ['How we price a renovation', '2026-03-11', false, 'Mere Tane', 'Fixed fees, allowances and where the surprises hide.'],
  ['Draft: winter colour forecast', '2026-11-20', true, 'Ana Lima', 'Ochre, plum and a very dark green.'],
  ['Harbourside café refit', '2026-02-07', false, 'Sam Okafor', 'Forty seats, one weekend, no closure.'],
  ['Small bathrooms, big tiles', '2026-01-19', false, 'Mere Tane', 'Why fewer grout lines make a room feel larger.'],
  ['A guide to sustainable timber finishes for floors, decks and joinery', '2025-12-02', false, 'Ana Lima', 'Oils, waxes and water-based lacquers compared.'],
  ['Our year in projects', '2025-11-28', false, 'Sam Okafor', 'Twenty-two homes, three cafés and one boat.'],
  ['Studio holiday hours', '2025-12-15', false, 'Mere Tane', 'Closed from the 23rd, back on the 6th.'],
  ['Choosing a kitchen benchtop', '2025-10-09', false, 'Ana Lima', 'Stone, timber, steel and composite, side by side.']
];
await apply(
  [
    { type: 'collection.create', collectionId: 'posts' },
    ...posts.map(([title, publishedAt, draft, author, excerpt], i) => ({ type: 'entry.create', collectionId: 'posts', entryId: `en_post${String(i).padStart(2, '0')}`, title, publishedAt, draft, author, excerpt, body: [excerpt] }))
  ],
  'Start the blog'
);
// Two categories, so the category filter sits beside the status filter.
await apply(
  ['Renovations', 'Studio news'].map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label })),
  'Add categories'
);
await pause(800);
await panel.locator('[data-post]').first().waitFor({ timeout: 15000 });

// Rest with nothing open: the single blog, newest first.
await shot('rest', '.posts-panel [data-post]', BOTH);

// A post open in the writer: the current row.
await openRow('Kōwhai Street apartment');
await win.locator('.post-body').waitFor({ timeout: 20000 });
await pause(800);
await shot('current', '.posts-panel [data-post]', BOTH);
await shot('context', '.editor', LIGHT, { full: true });

// Hover on another row: its actions show.
await shot('hover', '.posts-panel [data-post]', LIGHT, { hover: row('Five fabrics') });

// Keyboard: focus into the list and arrow down a row.
{
  await panel.locator('[data-post][aria-selected="true"]').focus();
  await win.keyboard.press('ArrowDown');
  await pause(400);
  await shot('keyboard-focus', '.posts-panel [data-post]:focus-visible', BOTH, { keepPointer: true });
  // Type-ahead: "h" jumps to the next title starting with it.
  await win.keyboard.press('h');
  await pause(300);
  const typed = await win.evaluate(() => document.activeElement?.closest('[data-post]')?.textContent ?? '');
  if (!/^(How|Harbourside)/.test(typed)) throw new Error(`type-ahead did not move to a title starting with h: ${typed}`);
  // Shift+F10 opens the focused row's options.
  await win.keyboard.press('Shift+F10');
  await pause(300);
  await shot('row-menu-keyboard', '.menu', LIGHT, { keepPointer: true });
  await win.keyboard.press('Escape');
  await pause(200);
}

// A row's context menu (right-click).
await row('Lighting a hallway').click({ button: 'right' });
await pause(300);
if (await win.locator('.menu').isVisible().catch(() => false)) {
  await shot('row-menu', '.menu', BOTH, { keepPointer: true });
  await win.keyboard.press('Escape');
  await pause(200);
} else skip('row-menu', 'right-click opens no menu');

// The new-post form, with a typed title.
await panel.getByRole('button', { name: /New post/ }).first().click();
await pause(300);
await win.keyboard.type('Winter planting for courtyards');
await pause(300);
await shot('add', '.posts-panel input:focus', BOTH);
await win.keyboard.press('Escape');
await pause(300);

// Find by an author's name: what matched is said on each row.
const find = panel.locator('.posts-find input');
await find.click();
await win.keyboard.type('sam');
await pause(400);
await shot('find', '.posts-panel [data-post]', BOTH);
await find.fill('/blog/small');
await pause(300);
await shot('find-address', '.posts-panel [data-post]', LIGHT);
await find.fill('travertine');
await pause(300);
await shot('find-excerpt', '.posts-panel [data-post]', LIGHT);
await find.fill('sam');
await pause(300);
// The clear button inside the field.
await find.fill('gallery');
await pause(300);
await shot('find-none', '.posts-panel', LIGHT);
await find.fill('');
await pause(200);

// Drafts only.
{
  const drafts = panel.getByRole('radio', { name: /Drafts/ }).first();
  if (await drafts.isVisible().catch(() => false)) {
    await drafts.click();
    await pause(300);
    await shot('drafts', '.posts-panel [data-post]', LIGHT);
    await panel.getByRole('radio', { name: /^All/ }).first().click();
    await pause(200);
  } else skip('drafts', 'no visible Drafts filter');
}

// The collection's options: sort, groupings, import, settings, layout and source.
await panel.getByRole('button', { name: 'Posts options' }).click();
await pause(300);
await shot('options-menu', '.menu', BOTH, { keepPointer: true });
// A sort other than newest first is said above the list.
await win.getByRole('menuitemradio', { name: 'Title' }).click();
await pause(300);
await shot('sorted', '.posts-panel .posts-count', LIGHT);
await panel.getByRole('button', { name: 'Posts options' }).click();
await win.getByRole('menuitemradio', { name: 'Newest first' }).click();
await pause(300);

// A second and third collection: the collections list has something to choose between.
await apply(
  [
    { type: 'collection.create', collectionId: 'team', name: 'Team', singularName: 'Team member', kind: 'structured' },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_team01', title: 'Mere Tane' },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_team02', title: 'Sam Okafor' },
    { type: 'collection.create', collectionId: 'projects', name: 'Projects', singularName: 'Project', kind: 'structured' }
  ],
  'Add Team and Projects'
);
await pause(800);
await shot('collections', '.posts-panel [data-post]', BOTH);
await panel.locator('.posts-switch').click();
await pause(300);
await shot('switcher', '.menu', BOTH, { keepPointer: true });
await win.keyboard.press('Escape');
await pause(200);
await showCollection('Team');
await shot('team', '.posts-panel [data-post]', LIGHT);

// The narrowest sidebar (200px): the resizer dragged 60px to the left, then back.
{
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
  await showCollection('Posts');
  await openRow('Kōwhai Street apartment');
  await pause(600);
  await resize(-60);
  await shot('narrow', '.posts-panel [data-post]', LIGHT);
  await resize(60);
}

// An empty collection.
await showCollection('Projects');
await shot('empty-collection', '.posts-panel', LIGHT);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`posts panel capture: ${written.length} written, ${count} PNGs in ${OUT}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
