// Design capture for the Content list at the widths it is used at (#1520): a magazine of 300 posts whose titles
// run to 40-60 characters and share their opening words, in the sidebar at its default 260px, its 200px minimum
// and its 420px maximum, and in a window at the 1100px minimum. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/content-list.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. `*-panel` states are cropped to the rail and
// sidebar so the rows are legible; the others are the whole window. Every capture checks its state on screen after
// it settles (and the sidebar's width where it matters) and throws rather than writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('content list capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'content-list');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-content-list-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const HEIGHT = 900;
// Rendered at 2x (a Retina screen's density) unless DESIGN_CAPTURE_SCALE says otherwise, so 11-13px row text is legible.
const SCALE = Number(process.env.DESIGN_CAPTURE_SCALE ?? 2);

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
// The window itself is sized (Playwright's viewport emulation would put the scale back to 1), and drawn at SCALE.
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: SCALE, mobile: false });
/** The window's content size in CSS pixels. */
async function setViewport(width) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, HEIGHT]);
  await win.waitForFunction((w) => window.innerWidth === w, width);
}
await setViewport(1440);
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const panel = win.locator('.posts-panel');
const row = (title) => panel.locator('[data-post]', { hasText: title }).first();
/** Opens an entry the way a pointer does: a click on its title. */
const openRow = (title) => row(title).click({ position: { x: 48, y: 12 } });

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The rail and sidebar, plus a strip of what is beside it so the panel's edge reads; wider when a menu sticks out. */
async function panelClip() {
  const box = await win.locator('.side-panel').boundingBox();
  let right = box.x + box.width + 16;
  // A menu, or a focused row's peek card beside the sidebar.
  for (const sel of ['.menu', '.list-peek']) {
    const pop = win.locator(sel).first();
    if (!(await pop.isVisible().catch(() => false))) continue;
    const m = await pop.boundingBox();
    right = Math.max(right, (m?.x ?? 0) + (m?.width ?? 0) + 12);
  }
  return { x: 0, y: 0, width: Math.ceil(right), height: HEIGHT };
}

async function sidebarWidth() {
  return Math.round((await win.locator('.side-panel').boundingBox()).width);
}

/** Drag the sidebar's splitter until the sidebar is `target` px wide, and check that it is. */
async function setSidebar(target) {
  const handle = win.locator('.seam.left .resizer');
  if (!(await handle.boundingBox())) throw new Error('no sidebar resizer');
  for (let i = 0; i < 3; i++) {
    const now = await sidebarWidth();
    if (Math.abs(now - target) <= 1) break;
    const b = await handle.boundingBox();
    await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await win.mouse.down();
    await win.mouse.move(b.x + b.width / 2 + (target - now), b.y + b.height / 2, { steps: 8 });
    await win.mouse.up();
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await pause(300);
  }
  const w = await sidebarWidth();
  if (Math.abs(w - target) > 2) throw new Error(`sidebar is ${w}px, wanted ${target}px`);
}

/**
 * Capture a state in the given themes; `check` must be visible at the moment of capture, and the sidebar must be
 * `width` px wide when one is given.
 */
async function shot(state, check, themes = LIGHT, { full = false, keepPointer = false, hover = null, width = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (hover) await hover.hover();
    else if (!keepPointer) await win.mouse.move(2, HEIGHT - 2);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (width !== null) {
      const w = await sidebarWidth();
      if (Math.abs(w - width) > 2) throw new Error(`state "${state}" (${theme}): sidebar is ${w}px, wanted ${width}px; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await panelClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
  return r;
};

// ---- Project: a farming magazine with 300 posts ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'The Long Paddock', parentDir: dir, starter: 'business', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);

// Titles that share their opening words, newest first; the drafts are among the newest, as an editor's are.
const lead = [
  ['Scheduled: Winter field day at the Longreach research station', true],
  ['Field diary 8: the first frost and a late planting of garlic', true],
  ['Rethinking compost tea for market gardens on heavy clay', true],
  ['Why drip lines fail in hard water, and how to stop it', true],
  ['Why sorghum in the north is worth a second look this season', true],
  ['What the grazing trials taught us about native pasture', false],
  ['Field diary 35: three weeks of rain and a flooded creek crossing', false],
  ['Rethinking farmers’ markets after the supermarket price war', false],
  ['What seed banks are doing to keep heirloom wheat alive', false],
  ['Measuring water rights across the lower Murray catchment', false],
  ['What the grazing records say about stocking rates in drought', false],
  ['Why sorghum yields fell short in the 2025 southern trials', true],
  ['Measuring water use on small dairy farms through a dry summer', false],
  ['Rethinking compost: what the long-term trials actually show', false],
  ['Why drip irrigation pays back faster on sandy loam', false],
  ['How to read a soil test without a chemistry degree', false],
  ['How to read a soil moisture probe in heavy clay', true],
  ['A beginner’s guide to cover crops for small vegetable farms', false],
  ['A beginner’s guide to rotational grazing on ten hectares', false],
  ['The case for hedgerows on broadacre cropping farms', false],
  ['The case for keeping bees between the orchard rows', false],
  ['What seed savers wish every new grower knew', false]
];
const topics = [
  'lambing in the wet and a new shed roof',
  'fencing the river paddock before the floods',
  'a week of hay, and why we bale small',
  'soil tests back from the lab at last',
  'the neighbour’s dam and a shared pump',
  'planting tagasaste along the eastern boundary',
  'counting dung beetles after the summer rain',
  'the old tractor, a new clutch and a long day'
];
const posts = [...lead];
for (let n = 278; posts.length < 300; n--) posts.push([`Field diary ${n}: ${topics[n % topics.length]}`, false]);
// A draft left from last year: its date keeps its year, the longest a Draft row's date line gets.
posts[130] = ['Measuring soil carbon on a mixed farm: a first-year report', true];
const day = (i) => new Date(Date.UTC(2026, 11, 15) - i * 3 * 86400000).toISOString().slice(0, 10);
const ops = posts.map(([title, draft], i) => ({
  type: 'entry.create',
  collectionId: 'posts',
  entryId: `en_p${String(i).padStart(4, '0')}`,
  title,
  publishedAt: day(i),
  draft,
  author: ['Mere Tane', 'Sam Okafor', 'Ana Lima'][i % 3],
  excerpt: 'Notes from the paddock, the shed and the long drive to town.',
  body: ['Notes from the paddock, the shed and the long drive to town.']
}));
await apply([{ type: 'collection.create', collectionId: 'posts' }, ...ops.slice(0, 100)], 'Start the magazine');
await apply(ops.slice(100, 200), 'More posts');
await apply(ops.slice(200), 'More posts');
await pause(800);

await win.locator('.rail [aria-label="Content"]').click();
await panel.locator('[data-post]').first().waitFor({ timeout: 15000 });
await pause(600);
const count = await panel.locator('[data-post]').count();
if (count < 20) throw new Error(`only ${count} rows rendered`);

// ---- 1440 window, the sidebar at its default 260px ----
const DEFAULT = await sidebarWidth();
if (Math.abs(DEFAULT - 260) > 2) throw new Error(`sidebar opened at ${DEFAULT}px, expected the 260px default`);
await shot('list-1440', '.post-none', LIGHT, { full: true, width: 260 });
await shot('list-260-panel', '.posts-panel [data-post]', BOTH, { width: 260 });

// A pointer on a row: its options button shows.
await shot('hover-260-panel', '.posts-panel [data-post]:hover .hover-only', LIGHT, { hover: row('Why drip lines fail'), width: 260 });

// A post open in the writer: its row is the current one.
await openRow('Rethinking compost tea');
await win.locator('.post-body').waitFor({ timeout: 20000 });
await pause(800);
await shot('open-1440', '.post-body', LIGHT, { full: true, width: 260 });
await shot('open-260-panel', '.posts-panel [data-post][aria-selected="true"]', BOTH, { width: 260 });

// Keyboard: focus into the list and arrow down to a title too long for two lines at 260px; it shows whole in a card.
await panel.locator('[data-post][aria-selected="true"]').focus();
for (let i = 0; i < 4; i++) await win.keyboard.press('ArrowDown');
await pause(400);
const focused = await win.evaluate(() => document.activeElement?.closest('[data-post]')?.textContent ?? '');
if (!focused.startsWith('Field diary 35')) throw new Error(`keyboard focus is on "${focused}", not the long Field diary 35 title`);
await shot('focus-260-panel', '.list-peek', LIGHT, { keepPointer: true, width: 260 });
await win.keyboard.press('Escape');
await pause(200);

// A row's options menu, from a right-click.
await row('Measuring water rights').click({ button: 'right' });
await pause(300);
await shot('menu-260-panel', '.menu', LIGHT, { keepPointer: true, width: 260 });
await win.keyboard.press('Escape');
await pause(200);

// Finding: titles show whole, what matched is marked.
const find = panel.locator('.posts-find input');
await find.fill('grazing');
await pause(400);
await shot('find-260-panel', '.posts-panel [data-post]', LIGHT, { width: 260 });
// One Escape from a result leaves the find (no hidden peek card takes it first).
await find.focus();
await win.keyboard.press('ArrowDown');
await pause(200);
await win.keyboard.press('Escape');
await pause(300);
if ((await find.inputValue()) !== '') throw new Error('one Escape from a find result did not leave the find');

// ---- The narrowest sidebar (200px), where the issue's titles were cut to a dozen characters ----
await setSidebar(200);
await shot('open-200-panel', '.posts-panel [data-post][aria-selected="true"]', LIGHT, { width: 200 });
await panel.getByRole('radio', { name: /Drafts/ }).first().click();
await pause(300);
await shot('drafts-200-panel', '.posts-panel [data-post]', LIGHT, { width: 200 });
if (!(await row('Measuring soil carbon').isVisible())) throw new Error('the draft from last year is not in the Drafts list');
await panel.getByRole('radio', { name: /^All/ }).first().click();
await pause(300);

// Show full titles, from the collection's options: every title whole at the narrowest width, then back to two lines.
await panel.getByRole('button', { name: 'Posts options' }).click();
await pause(300);
await shot('options-200-panel', '.menu', LIGHT, { keepPointer: true, width: 200 });
await win.getByRole('menuitemcheckbox', { name: /Show full titles/ }).click();
await pause(400);
await shot('full-titles-200-panel', '.posts-list.full-titles [data-post]', LIGHT, { width: 200 });
await panel.getByRole('button', { name: 'Posts options' }).click();
await win.getByRole('menuitemcheckbox', { name: /Show full titles/ }).click();
await pause(300);

// Between the narrow and default widths (240px), where the filter's counts beside their labels no longer fit.
await setSidebar(240);
await shot('open-240-panel', '.posts-panel [data-post][aria-selected="true"]', LIGHT, { width: 240 });
await setSidebar(200);

// ---- The smallest window (1100px): the sidebar at 200px, then back at its default ----
await setViewport(1100);
await pause(600);
await shot('open-1100-200', '.post-body', LIGHT, { full: true, width: 200 });
await setSidebar(260);
await shot('open-1100', '.post-body', LIGHT, { full: true, width: 260 });

// ---- The widest sidebar (420px) in the 1440 window ----
await setViewport(1440);
await pause(600);
await setSidebar(420);
await shot('open-420-panel', '.posts-panel [data-post][aria-selected="true"]', LIGHT, { width: 420 });
await setSidebar(260);

// ---- Records: a collection with long names and no dates (one-line rows) ----
await apply(
  [
    { type: 'collection.create', collectionId: 'team', name: 'Team', singularName: 'Team member', kind: 'structured' },
    ...[
      'Dr Margaret Oyelaran-Whitcombe, soil scientist',
      'Sam Okafor',
      'Ana Lima, field editor and photographer for the southern region',
      'Mere Tane',
      'Hamish Te Rangi-McAllister, agronomy and irrigation'
    ].map((title, i) => ({ type: 'entry.create', collectionId: 'team', entryId: `en_team${i}`, title, draft: false }))
  ],
  'Add the team'
);
await pause(800);
await panel.locator('.posts-switch').click();
await win.getByRole('menuitemradio', { name: /^Team/ }).click();
await pause(600);
await shot('records-260-panel', '.posts-panel [data-post]', LIGHT, { hover: row('Ana Lima'), width: 260 });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`content list capture: ${written.length} written, ${pngs} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (pngs < written.length) throw new Error('fewer PNGs on disk than captures written');
