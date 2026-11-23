// Design capture for the Pages panel (the left sidebar's Pages tab). Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/pages-panel.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. Panel states are cropped to the rail and
// sidebar so the rows are legible; `context` is the whole window. Every capture checks its state on
// screen after it settles and throws rather than writing a wrong image.
import { _electron as electron } from 'playwright';
import { MOD } from '../harness.mjs';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('pages panel capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'pages-panel');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-pages-')));
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
const panel = win.locator('.side-panel-view:not([hidden])');
const row = (title) => panel.locator('[data-page]', { hasText: title }).first();

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The rail and sidebar, plus a strip of canvas so the panel's edge reads. */
async function panelClip() {
  const box = await win.locator('.side-panel').boundingBox();
  let right = box.x + box.width + 16;
  // An open menu can extend past the sidebar; widen the crop so it is captured whole.
  const menu = win.locator('.menu').first();
  if (await menu.isVisible().catch(() => false)) right = Math.max(right, ((await menu.boundingBox())?.x ?? 0) + ((await menu.boundingBox())?.width ?? 0) + 12);
  return { x: 0, y: 0, width: Math.ceil(right), height: 900 };
}

/**
 * Capture a state; `check` must be visible at the moment of capture. `hover` is re-hovered after each theme
 * switch; `keepPointer` leaves the mouse where the state put it (menus); otherwise it is parked on the canvas.
 */
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
const apply = (operations, label) => win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });

// ---- Project: the business starter, opened on Home with nothing selected ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);
if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();
await pause(300);

// Rest: Home is the current page and the inspector shows the page itself.
await shot('rest', '[data-page][aria-selected="true"]');

// Editing on another page: About is current and something on the canvas is selected (the usual state).
await row('About').click();
await frame.locator('h1').first().waitFor({ timeout: 30000 });
await pause(900);
await frame.locator('h1').first().click();
await pause(600);
await shot('current-editing', '[data-page][aria-selected="true"]', LIGHT);

// Hover on a row that is not current: its actions show.
await shot('hover', '[data-page]:hover', LIGHT, { hover: row('Contact') });

// Keyboard: arrow from the current row, so focus is visible on a row.
await row('About').click();
await pause(400);
await win.keyboard.press('ArrowDown');
await pause(700);
await shot('keyboard-focus', '[data-page]:focus-visible', BOTH);

// A page's options menu from its … button.
await row('About').click();
await pause(500);
await row('Contact').hover();
await row('Contact').locator('button[aria-haspopup="menu"]').click();
await pause(300);
await shot('menu', '.menu', BOTH, { keepPointer: true });
await win.keyboard.press('Escape');
await pause(200);

// The home page's context menu (right-click).
await row('Home').click({ button: 'right' });
await pause(300);
await shot('menu-home', '.menu', LIGHT, { keepPointer: true });
await win.keyboard.press('Escape');
await pause(200);

// Inline rename (F2 on a row).
await row('About').click();
await pause(400);
await row('About').press('F2');
await pause(300);
await shot('rename', '.side-panel input.pages-rename:focus', LIGHT);
await win.keyboard.press('Escape');
await pause(300);
if (await win.locator('.side-panel input.pages-rename').count()) throw new Error('rename field still open after Escape');

// Adding a page inline, with a typed title.
await panel.getByRole('button', { name: /Add page/ }).last().click();
await pause(200);
await win.keyboard.type('Our services & pricing');
await pause(300);
await shot('add', '.side-panel input.inline-edit', BOTH);
// A title whose address is already taken: the preview shows the address the page will really get.
await win.keyboard.press(`${MOD}+A`);
await win.keyboard.type('About');
await pause(300);
await shot('add-taken', '.side-panel input.inline-edit', LIGHT);
await win.keyboard.press('Escape');
await pause(300);

// Drag in progress: the drop indicator between two rows.
{
  const dt = await win.evaluateHandle(() => new DataTransfer());
  await row('About').dispatchEvent('dragstart', { dataTransfer: dt });
  const target = await row('Contact').boundingBox();
  await row('Contact').dispatchEvent('dragover', { dataTransfer: dt, clientX: target.x + 40, clientY: target.y + target.height - 4 });
  await pause(200);
  await shot('drag', '.side-panel .drop-before, .side-panel .drop-after', LIGHT);
  await row('Contact').dispatchEvent('dragleave', { dataTransfer: dt });
  await row('About').dispatchEvent('dragend', { dataTransfer: dt });
  await win.evaluate(() => document.dispatchEvent(new Event('dragend')));
  await pause(200);
}

// Many pages: long titles, nested routes, and the current page far down the list.
{
  const extra = [
    ['Our team', '/about/team/'],
    ['Careers', '/about/careers/'],
    ['Residential interior design & renovation', '/services/residential-interior-design/'],
    ['Commercial fit-outs', '/services/commercial/'],
    ['Colour consultations', '/services/colour/'],
    ['Portfolio', '/portfolio/'],
    ['Kōwhai Street apartment', '/portfolio/kowhai-street-apartment/'],
    ['Harbourside café refit', '/portfolio/harbourside-cafe/'],
    ['Journal', '/journal/'],
    ['Frequently asked questions', '/faq/'],
    ['Privacy policy', '/privacy/'],
    ['Terms of service', '/terms/']
  ];
  let after;
  for (const [title, route] of extra) {
    const r = await apply([{ type: 'page.create', title, route, ...(after ? { afterPageId: after } : {}), starter: 'intro' }], `Add ${title}`);
    if (!r?.ok) throw new Error(`could not add page ${title}: ${JSON.stringify(r?.error)}`);
    after = r.results?.[0]?.pageId;
  }
  await pause(800);
  await row('Kōwhai Street apartment').click();
  await pause(1200);
  await frame.locator('h1').first().click().catch(() => {});
  await pause(500);
  await row('Kōwhai Street apartment').scrollIntoViewIfNeeded();
  await shot('many', '[data-page]:has-text("Terms of service")', BOTH);
  await shot('context', '.editor', LIGHT, { full: true });
}

// Delete confirmation for a page other links point to.
await row('Contact').scrollIntoViewIfNeeded();
await row('Contact').click({ button: 'right' });
await win.getByRole('menuitem', { name: /Delete/ }).click();
await pause(400);
await shot('delete', '.modal', LIGHT, { full: true });
await win.keyboard.press('Escape');
await pause(300);

// The minimum: a blank site with a single page.
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Blank', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await pause(2500);
if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();
await pause(300);
await shot('single', '[data-page]', LIGHT);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`pages panel capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
