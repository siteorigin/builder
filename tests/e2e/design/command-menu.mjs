// Design capture for the Command menu (⌘K). Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/command-menu.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. Menu states are cropped to the menu with a
// margin of the window behind it; `context` is the whole window. Every capture checks its state on screen after
// it settles and throws rather than writing a wrong image.
import { _electron as electron } from 'playwright';
import { MOD } from '../harness.mjs';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('command menu capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'command-menu');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-cmdk-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const WIDE = { width: 1440, height: 900 };

const app = await electron.launch({
  args: ['--force-device-scale-factor=2', '.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize(WIDE);
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const menu = win.locator('.cmdk');
const input = menu.locator('input');
const optionRows = menu.locator('[role="option"]');
const activeRow = menu.locator('[role="option"][aria-selected="true"]');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

async function closeMenu() {
  if (await menu.count()) {
    await win.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 10000 });
  }
}

/** Opens the menu fresh and types the query, so no state carries over from the one before. */
async function openMenu(query = '') {
  await closeMenu();
  await win.mouse.move(4, 4);
  await win.keyboard.press(`${MOD}+K`);
  await menu.waitFor({ timeout: 15000 });
  await input.waitFor({ timeout: 15000 });
  if (query) await input.fill(query);
  await pause(350);
}

/** The menu plus a margin of the window behind it, inside the viewport. */
async function menuClip() {
  const box = await menu.boundingBox();
  const view = win.viewportSize() ?? WIDE;
  const m = 24;
  const x = Math.max(0, Math.floor(box.x - m));
  const y = Math.max(0, Math.floor(box.y - m));
  return { x, y, width: Math.min(view.width - x, Math.ceil(box.width + m * 2)), height: Math.min(view.height - y, Math.ceil(box.height + m * 2)) };
}

/**
 * Capture a state. `query` must be in the field, `expects` must each be in a visible row, exactly one row must be
 * highlighted (none when `count` is 0), and with `count` there must be exactly that many rows. `note` must be shown in the menu. `hover`
 * re-hovers a row after each theme switch, and that row must take the highlight. `active` must be in the highlighted row.
 */
async function shot(state, { query = '', expects = [], count = null, note = null, themes = BOTH, full = false, hover = null, active = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (hover) await hover.hover();
    await pause(200);
    if (!(await menu.isVisible())) throw new Error(`state "${state}" (${theme}): the menu is not open; refusing to write`);
    if ((await input.inputValue()) !== query) throw new Error(`state "${state}" (${theme}): field holds "${await input.inputValue()}", expected "${query}"`);
    const focused = await input.evaluate((el) => document.activeElement === el);
    if (!focused) throw new Error(`state "${state}" (${theme}): focus left the search field`);
    const rows = await optionRows.count();
    if (count !== null && rows !== count) throw new Error(`state "${state}" (${theme}): expected ${count} rows, found ${rows}`);
    if (count !== 0 && !rows) throw new Error(`state "${state}" (${theme}): no results rendered`);
    if ((await activeRow.count()) !== (count === 0 ? 0 : 1)) throw new Error(`state "${state}" (${theme}): wrong number of highlighted rows`);
    for (const text of expects) if (!(await optionRows.filter({ hasText: text }).first().isVisible())) throw new Error(`state "${state}" (${theme}): no visible row has "${text}"`);
    if (note && !(await menu.getByText(note).first().isVisible())) throw new Error(`state "${state}" (${theme}): "${note}" is not shown`);
    if (hover && (await hover.getAttribute('aria-selected')) !== 'true') throw new Error(`state "${state}" (${theme}): the hovered row is not highlighted`);
    if (active && !(await activeRow.innerText()).includes(active)) throw new Error(`state "${state}" (${theme}): the highlighted row is "${await activeRow.innerText()}", expected it to have "${active}"`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await menuClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const apply = (operations, label) => win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });

// ---- Project: the business starter plus a realistic spread of pages, with same-title pages and long addresses ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
{
  const extra = [
    ['Our team', '/about/team/'],
    ['Careers', '/about/careers/'],
    ['Residential interior design, renovation and colour for heritage villas', '/services/residential-interior-design-and-renovation/heritage-villas/'],
    ['Commercial fit-outs', '/services/commercial/'],
    ['Colour consultations', '/services/colour/'],
    ['Portfolio', '/portfolio/'],
    ['Portfolio', '/portfolio-archive/'],
    ['Kōwhai Street apartment', '/portfolio/kowhai-street-apartment/'],
    ['Journal', '/journal/'],
    ['Frequently asked questions', '/faq/'],
    ['Privacy policy', '/privacy/']
  ];
  let after;
  for (const [title, route] of extra) {
    const r = await apply([{ type: 'page.create', title, route, ...(after ? { afterPageId: after } : {}), starter: 'intro' }], `Add ${title}`);
    if (!r?.ok) throw new Error(`could not add page ${title}: ${JSON.stringify(r?.error)}`);
    after = r.results?.[0]?.pageId;
  }
  await pause(1200);
}

// Rest: just opened, nothing typed, the first row highlighted. A few pages (not the open one), a few things to insert,
// each with a row that shows the rest, then the commands.
await openMenu();
await shot('rest', { expects: ['Go to About', 'more pages', 'more to insert'] });

// The whole window, so the menu's weight and position over the editor can be judged.
await shot('context', { expects: ['Go to About'], full: true });

// The rest list opened up from the keyboard: the highlight lands on the first page it revealed.
await openMenu();
{
  const rows = await optionRows.allInnerTexts();
  const more = rows.findIndex((t) => /more pages/.test(t));
  if (more < 0) throw new Error('rest: no "more pages" row');
  for (let i = 0; i < more; i++) await win.keyboard.press('ArrowDown');
  const next = (await optionRows.nth(more).innerText()).trim();
  await win.keyboard.press('Enter');
  await pause(300);
  const after = (await activeRow.innerText()).trim();
  if (after === next || /more pages/.test(after)) throw new Error(`pages-expanded: the highlight stayed on "${after}"`);
  await shot('pages-expanded', { themes: LIGHT });
}

// Keyboard: arrowed well down the list, so the highlight has scrolled the list.
await openMenu();
for (let i = 0; i < 24; i++) await win.keyboard.press('ArrowDown');
await pause(300);
await shot('keyboard-scrolled');

// The very end of the list, reached with End.
await openMenu();
await win.keyboard.press('End');
await pause(300);
await shot('keyboard-end', { themes: LIGHT });

// Pointer on a row that is not the first.
await openMenu('page');
await shot('hover', { query: 'page', themes: LIGHT, hover: optionRows.nth(3) });

// Same-title pages told apart by their address.
await openMenu('portfolio');
await shot('pages-same-title', { query: 'portfolio', expects: ['/portfolio-archive/'], active: '/portfolio/' });

// A word from a page's address: the page leads, ahead of a section of the same name on another page.
await openMenu('faq');
await shot('address-word', { query: 'faq', active: 'Frequently asked questions', themes: LIGHT });

// A page found by its exact address: only that page.
await openMenu('/faq/');
await shot('address-exact', { query: '/faq/', expects: ['/faq/'], themes: LIGHT });

// A long title with a long address, the hardest row to fit.
await openMenu('residential');
await shot('long-title', { query: 'residential', expects: ['/services/residential'] });

// Mixed results: sections on the site, words in its content, pages, inserts and the search-everything row.
await openMenu('contact');
await shot('mixed', { query: 'contact', expects: ['Search all site content'], active: 'Contact' });

// Commands with shortcuts.
await openMenu('project');
await shot('shortcuts', { query: 'project', expects: ['New project', 'Close project'], active: 'Project brief' });

// A command that cannot run now: listed with its reason, highlighted without the blue that means Enter runs it.
await openMenu('redo');
await shot('unavailable', { query: 'redo', expects: ['Nothing to redo'] });

// Nothing matches anywhere: the menu says so and offers nothing to press.
await openMenu('zzqxv');
await shot('empty', { query: 'zzqxv', count: 0, note: 'No matches' });

// Too short to search the content: the way to search it is the one thing left.
await openMenu('ξ');
await shot('one-character', { query: 'ξ', expects: ['Search all site content'], count: 1, note: 'another character', themes: LIGHT });

// One character that finds pages and commands: the note that site words were skipped stays in view over the footer.
await openMenu('p');
await shot('one-character-results', { query: 'p', note: 'another character', themes: LIGHT });

// An abbreviation of a command's whole name leads with that command.
await openMenu('proj health');
await shot('abbreviation', { query: 'proj health', active: 'Project health', themes: LIGHT });

// A long query with nothing to find.
{
  const long = 'the quarterly residential renovation brochure for the heritage villas';
  await openMenu(long);
  await shot('empty-long', { query: long, count: 0, note: 'No matches', themes: LIGHT });
}

// A narrow window: the menu has to give way without losing the address or the shortcut.
await closeMenu();
await win.setViewportSize({ width: 620, height: 640 });
await pause(600);
await openMenu('portfolio');
await shot('narrow', { query: 'portfolio', expects: ['/portfolio-archive/'], themes: LIGHT });
await closeMenu();
await win.setViewportSize(WIDE);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`command menu capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
