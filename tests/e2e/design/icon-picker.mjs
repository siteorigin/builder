// Icon picker capture harness: drives the real (built) app through the states of the Inspector's icon picker (on a
// services card) and writes one PNG per state and theme, cropped to the dock around the picker and the fields under
// it, so a picker that pushes the form down shows it. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/icon-picker.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('icon picker capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-icons-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1000 });
await win.waitForSelector('.welcome', { timeout: 120000 });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const insp = win.locator('#dock-panel-inspect');

async function until(check, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}

// The picker and, when it is open, its popup wherever it is drawn (in the flow or floating over the panel).
const picker = () => insp.locator('.insp-icon-picker').first();
const popup = () => win.locator('.insp-icon-pop, .insp-icon-picker .insp-pick').first();
const tiles = () => popup().locator('[role="option"]');
const search = () => win.getByRole('searchbox', { name: 'Search icons' });

/** Capture the dock's width from just above the picker to below the popup and the field after it. */
async function shot(state, verify, themes = LIGHT, below = 150) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(240);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    // The trigger must be what is drawn at its own centre: not scrolled under the Inspector's sticky head.
    const seen = await trigger().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + 24, r.top + r.height / 2));
    });
    if (!seen) throw new Error(`state "${state}" (${theme}): the trigger is covered or off screen; refusing to write`);
    const dock = await win.locator('.dock').boundingBox();
    const boxes = [await picker().boundingBox()];
    if (await popup().count()) boxes.push(await popup().boundingBox());
    if (!dock || boxes.some((b) => !b)) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    // The popover floats over the window, so the crop may reach above the dock when it opens upward.
    const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 64);
    const bottom = Math.min(dock.y + dock.height, Math.max(...boxes.map((b) => b.y + b.height)) + below);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: dock.x - 2, y: top, width: dock.width + 2, height: bottom - top } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(100);
}

async function setProp(componentId, prop, value) {
  await win.evaluate(
    async ({ componentId, prop, value }) => {
      const s = await window.builder.project.snapshot();
      const page = s.state.pages[s.state.site.homePageId];
      const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === componentId);
      if (!node) throw new Error(`no ${componentId} on the home page`);
      const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop, value }] }, { label: 'Seed field' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    },
    { componentId, prop, value }
  );
  await pause(350);
}

const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
async function select(name) {
  await openRail('Layers');
  await win.locator('.list-item', { hasText: name }).first().click();
  await insp.locator('.insp-name h3', { hasText: name }).waitFor({ timeout: 30000 });
  await pause(350);
}
const row = (text) => insp.locator('.list-editor-item', { has: win.locator('button.title', { hasText: text }) }).first();
async function openRow(text) {
  const head = row(text).locator('button.title');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await until(async () => (await head.getAttribute('aria-expanded')) === 'true', `${text} to open`);
  await pause(200);
}
const trigger = () => picker().locator('button').first();
const isOpen = async () => (await trigger().getAttribute('aria-expanded')) === 'true';
async function openPicker() {
  await place();
  if (!(await isOpen())) await trigger().click();
  await tiles().first().waitFor({ timeout: 8000 });
  await pause(300);
}
async function closePicker() {
  if (await isOpen()) {
    await win.keyboard.press('Escape');
    await until(async () => !(await isOpen()), 'the picker to close');
  }
  await pause(150);
}
async function dockWidth(key) {
  const sep = win.getByRole('separator', { name: 'Resize right panel' });
  await sep.focus();
  await win.keyboard.press(key);
  await pause(400);
  await win.evaluate(() => document.activeElement?.blur());
}

// ---- Project ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 180000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
  localStorage.setItem('section:content', '1');
});

await select('Services grid');
const cards = insp.locator('[data-list="items"]');
await cards.waitFor({ timeout: 15000 });
await setProp('features.grid', 'items', [
  { id: 'c1', icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.', linkLabel: 'How we plan', link: { type: 'none', target: '' } },
  { id: 'c2', icon: 'ruler', title: 'Design', description: 'Drawings, materials and finishes.', linkLabel: '', link: { type: 'none', target: '' } },
  { id: 'c3', icon: 'hammer', title: 'Delivery', description: 'On site from first fix to handover.', linkLabel: '', link: { type: 'none', target: '' } }
]);
await until(async () => (await cards.locator('.list-editor-item').count()) === 3, 'three cards');
await openRow('Planning');
const scoped = () => row('Planning').locator('.insp-icon-picker');
await until(async () => (await scoped().count()) === 1, 'the card icon picker');
// The card's icon field in the upper middle of the panel, clear of its sticky head, as a real edit would have it.
const place = () => scoped().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await place();
await pause(200);

// ---- States ----
await shot('closed', async () => (await trigger().innerText()).includes('Compass'), BOTH);

await openPicker();
await shot('open', async () => (await tiles().count()) > 40 && (await isOpen()), BOTH, 160);

// Pointing at a tile names it.
// A tile that is not the current icon, so the hover fill and the footer's name are both its own.
const pointed = await tiles().nth(2).getAttribute('aria-label');
await tiles().nth(2).hover();
await pause(200);
await shot('hover', async () => (await tiles().nth(2).getAttribute('aria-selected')) === 'false' && (await popup().locator('.insp-icon-foot').innerText()).includes(pointed));
await win.mouse.move(5, 5);

await search().fill('arrow');
await pause(200);
await shot('search-name', async () => (await tiles().count()) >= 1 && (await tiles().count()) < 10);

// A word for what the icon is for, not its name.
await search().fill('email');
await pause(200);
await shot('search-meaning', async () => (await search().inputValue()) === 'email');

await search().fill('zzzz');
await pause(200);
await shot('no-match', async () => (await tiles().count()) === 0 && (await popup().innerText()).includes('zzzz'));

await search().fill('');
await pause(150);
await popup().locator('[role="option"][aria-selected="true"]').focus();
await win.keyboard.press('ArrowDown');
await pause(150);
await shot('keyboard', () => win.evaluate(() => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.matches(':focus-visible')), BOTH);
// Tab from the icons goes on to the card's next field, with the picker put away.
await win.keyboard.press('Tab');
await pause(200);
await shot('tab-out', async () => !(await isOpen()) && (await win.evaluate(() => document.activeElement instanceof HTMLInputElement && document.activeElement.value === 'Planning')));
await closePicker();

// ---- Narrowest and widest dock ----
await dockWidth('Home');
await openPicker();
await shot('open-narrow', async () => (await tiles().count()) > 40);
await closePicker();
await dockWidth('End');
await openPicker();
await shot('open-wide', async () => (await tiles().count()) > 40);
await closePicker();

// A short window: the popover takes the roomier side and shrinks its list rather than covering its own trigger.
await dockWidth('Home');
await win.setViewportSize({ width: 1440, height: 600 });
await pause(400);
await openPicker();
await shot('open-short', async () => {
  const t = await trigger().boundingBox();
  const p = await popup().boundingBox();
  return !!t && !!p && (p.y >= t.y + t.height || p.y + p.height <= t.y) && (await tiles().count()) > 40;
});
await closePicker();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`icon picker capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
