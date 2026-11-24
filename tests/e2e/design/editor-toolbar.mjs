// Design capture harness for the editor chrome: the top toolbar in each of its states (rest, editing, undo, the
// AI working, checking and asking, a width error, presets, Preview, both panels hidden, editing a component
// everywhere, a file conflict, and the compact and overflow widths with their menus), plus the bottom status bar,
// the left icon rail and the "Editing … everywhere" mode band. Drives the real (built) app and writes full-window captures
// plus crops of each strip, in light and dark. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/editor-toolbar.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of
// writing a plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('editor toolbar capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'editor-toolbar');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-chrome-')));
const BOTH = ['light', 'dark'];
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: W, height: H });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Regions of the window: the whole window, or one strip of the chrome. */
async function region(name) {
  const vp = win.viewportSize();
  if (name === 'window') return undefined;
  const box = async (sel) => {
    const b = await win.locator(sel).first().boundingBox();
    if (!b) throw new Error(`region ${name}: ${sel} has no box`);
    return b;
  };
  if (name === 'toolbar') {
    const b = await box('.toolbar');
    const band = await win.locator('.mode-band').boundingBox().catch(() => null);
    return { x: 0, y: 0, width: vp.width, height: Math.ceil((band ? band.y + band.height : b.y + b.height) + 1) };
  }
  if (name === 'status') {
    const b = await box('.status-bar');
    return { x: 0, y: Math.floor(b.y - 1), width: vp.width, height: Math.ceil(b.height + 1) };
  }
  if (name === 'rail') {
    const b = await box('.rail');
    return { x: 0, y: 0, width: Math.ceil(b.width + 260), height: Math.ceil(Math.min(vp.height, b.y + 260)) };
  }
  if (name === 'top-left') return { x: 0, y: 0, width: 640, height: 520 };
  if (name === 'top-center') return { x: Math.round(vp.width / 2 - 380), y: 0, width: 760, height: 320 };
  if (name === 'top-right') return { x: vp.width - 520, y: 0, width: 520, height: 380 };
  throw new Error(`unknown region ${name}`);
}

/** Capture a state; `check` must be visible at the moment of capture. */
async function shot(state, check, { themes = BOTH, area = 'window', keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    // Park the pointer on the empty foot of the icon rail: over the canvas it would be inside the preview's
    // frame, which leaves the editor's last :hover in place.
    if (!keepPointer) await win.mouse.move(24, win.viewportSize().height - 60);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await region(area) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const escape = async (n = 1) => {
  for (let i = 0; i < n; i++) await win.keyboard.press('Escape'), await pause(150);
};
// AI run states, pushed through the agent's own event channel as the main process sends them.
async function emit(e) {
  await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), e);
  await pause(150);
}
const openRail = async (name, open = true) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if (((await b.getAttribute('aria-pressed')) === 'true') !== open) await b.click();
  await pause(250);
};

// ---- A populated project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
// The preview is still starting right after the project opens: the status bar's busy state.
if (await win.locator('.status-dot.busy').waitFor({ timeout: 4000 }).then(() => true, () => false)) {
  const path = join(OUT, 'sb-starting--light.png');
  await win.screenshot({ path, clip: await region('status') });
  if (await win.locator('.status-dot.busy').isVisible()) written.push(path), console.log('wrote', path);
  else rmSync(path, { force: true }), console.log('skipped sb-starting: it ended during the capture');
} else console.log('skipped sb-starting: the preview was ready before it could be captured');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await openRail('Pages');

// Rest: nothing selected, Pages open, everything saved, nothing to undo.
await shot('editor-rest', '.save-state.saved');
await shot('tb-rest', '.save-state.saved', { area: 'toolbar' });
await shot('sb-rest', '.status-dot.ready', { area: 'status' });

// Hovering the project and page switcher.
await win.locator('.project-title').hover();
await pause(200);
await shot('tb-hover-title', '.project-title:hover', { themes: ['light'], area: 'toolbar', keepPointer: true });
// Leave the switcher for an element of the editor itself, so its hover does not carry into later captures.
await win.locator('.status-bar').hover();
await pause(200);

// The AI working on the site, checking its changes, then waiting for the author's answer.
const aiRun = { runId: 'r_toolbar', conversationId: 'c_toolbar', kind: 'status' };
await emit({ ...aiRun, status: 'running' });
await shot('tb-ai-working', '.save-state >> text=AI is working', { area: 'toolbar' });
await emit({ ...aiRun, status: 'validating' });
await shot('tb-ai-checking', '.save-state >> text=AI is checking', { themes: ['light'], area: 'toolbar' });
await emit({ ...aiRun, status: 'awaiting-input' });
await shot('tb-ai-asking', '.save-state >> text=AI is waiting for you', { area: 'toolbar' });
await emit({ ...aiRun, status: 'cancelled' });
await pause(600);

// An edit through the inspector: mid-typing is "Editing…", then saved with a named undo.
await frame.locator('h1').first().click();
await pause(700);
const eyebrow = win.locator('.field', { hasText: 'Eyebrow' }).locator('input').first();
await eyebrow.waitFor({ timeout: 5000 });
await eyebrow.fill('Interior design studio, est. 2009');
await pause(300);
await shot('tb-editing', '.save-state.pending', { themes: ['light'], area: 'toolbar', keepPointer: true });
await eyebrow.press('Enter');
await pause(1200);
// Saved, with a named change to undo.
await escape(2);
await shot('tb-undo-ready', '.toolbar [aria-label^="Undo "]:not([disabled])', { area: 'toolbar' });

// Text inside the hero selected: the status bar breadcrumb at its deepest.
await frame.locator('h1').first().click();
await pause(700);
await shot('editor-selected', '.ov-selected');
await shot('sb-selected', '.status-bar .crumbs button', { area: 'status' });

// Menus from the toolbar: the page switcher and zoom.
await win.locator('.project-title').click();
await pause(300);
await shot('tb-page-menu', '.menu', { area: 'top-left' });
await escape();
await win.locator('.zoom-btn').click();
await pause(300);
await shot('tb-zoom-menu', '.menu', { themes: ['light'], area: 'top-center' });
await escape();

// Keyboard focus on a toolbar control (a ring must show, not be clipped).
await win.locator('[aria-label="Settings"]').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(200);
if (!(await win.evaluate(() => !!document.querySelector('.toolbar :focus-visible')))) throw new Error('no focus-visible control in the toolbar; refusing to write tb-focus');
await shot('tb-focus', '.toolbar :focus-visible', { themes: ['light'], area: 'toolbar', keepPointer: true });
await win.evaluate(() => document.activeElement && document.activeElement.blur());

// A custom preview width (no preset matches), at 75% zoom.
await escape(3);
const width = win.locator('.width-input');
await width.fill('600');
await width.press('Enter');
await win.locator('.zoom-btn').click();
await win.getByRole('menuitemradio', { name: '75%' }).click();
await pause(900);
await shot('tb-custom-width', '.width-input', { themes: ['light'], area: 'toolbar' });
// A width outside 240-2560: the field turns red and keeps focus.
await width.fill('99');
await width.press('Enter');
await pause(300);
await shot('tb-width-error', '.width-error', { area: 'top-center', keepPointer: true });
await width.press('Escape');
await pause(300);
// The tablet preset.
await win.getByRole('button', { name: 'Tablet', exact: true }).first().click();
await pause(700);
await shot('tb-tablet', '.segmented [aria-label="Tablet"][aria-pressed="true"]', { themes: ['light'], area: 'toolbar' });
await win.locator('.zoom-btn').click();
await win.getByRole('menuitemradio', { name: /Fit/ }).click();
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await pause(700);

// Preview mode.
await win.getByRole('button', { name: /Preview/ }).first().click();
await pause(500);
await shot('tb-preview', '.segmented [aria-pressed="true"]', { themes: ['light'], area: 'toolbar' });
await win.getByRole('button', { name: /Edit/ }).first().click();
await pause(300);

// Both side panels hidden: the toolbar toggles and rail at rest.
await openRail('Pages', false);
await win.locator('[aria-label="Right panel"]').click();
await pause(700);
await shot('tb-panels-closed', '.toolbar', { themes: ['light'], area: 'toolbar' });
await win.locator('[aria-label="Right panel"]').click();
await pause(400);

// Rail: Layers open, then the Site styles shortcut active.
await openRail('Layers');
await shot('rail-layers', '.rail [aria-pressed="true"]', { area: 'rail' });
await win.locator('.rail [aria-label="Site styles"]').click();
await pause(600);
await shot('rail-styles', '.rail [aria-label="Site styles"][aria-pressed="true"]', { themes: ['light'], area: 'rail' });
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await pause(300);

// Editing a component everywhere: the mode band, the plum breadcrumb, Done editing.
await win.locator('.list-item', { hasText: 'Services grid' }).first().click();
await pause(500);
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: /Edit everywhere/ }).click();
await pause(300);
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await pause(1800);
await shot('definition-mode', '.mode-band');
await shot('tb-definition', '.mode-band', { area: 'toolbar' });
await shot('sb-definition', '.status-bar .crumbs button.def', { themes: ['light'], area: 'status' });
await win.locator('.mode-band-done').click();
await pause(800);
await escape(3);

// The smallest supported window.
await win.setViewportSize({ width: 1280, height: 800 });
await openRail('Pages');
await pause(900);
await shot('window-1280', '.editor', { themes: ['light'] });
await shot('tb-1280', '.toolbar', { area: 'toolbar' });
await win.setViewportSize({ width: W, height: H });
await pause(600);

// A file conflict: a generated file edited outside the app, then an edit that regenerates it.
{
  const recents = await win.evaluate(() => window.builder.projects.recents());
  const dir = recents.find((r) => r.name === 'Harbour Lane Studio').dir;
  const pageFile = join(dir, 'src', 'routes', '+page.svelte');
  if (!existsSync(pageFile)) throw new Error(`expected a generated home page at ${pageFile}`);
  appendFileSync(pageFile, '\n<!-- edited outside the app -->\n');
  await pause(600);
  // An edit that regenerates the home page: its title, from the Inspector with nothing selected.
  await escape(3);
  const field = win.locator('#dock-panel-inspect .field', { hasText: /^Title/ }).locator('input').first();
  await field.fill('Home page');
  await field.press('Enter');
  await win.locator('.save-state.error').waitFor({ timeout: 10000 });
  await escape(3);
  await pause(600);
  await shot('tb-conflict', '.save-state.error', { area: 'toolbar' });
  await shot('sb-conflict', '.status-bar', { area: 'status' });
}

// Narrower windows: compact (no Edit and Preview labels), then overflow (Zoom and Settings in More).
await win.setViewportSize({ width: 1180, height: 800 });
await pause(700);
await shot('tb-compact-1180', '.toolbar[data-tier="compact"]', { area: 'toolbar' });
await win.setViewportSize({ width: 1040, height: 800 });
await pause(700);
await shot('tb-overflow-1040', '.toolbar[data-tier="overflow"]', { themes: ['light'], area: 'toolbar' });
await win.locator('.toolbar-more').click();
await pause(300);
await shot('tb-more-menu', '.menu', { themes: ['light'], area: 'top-right' });
await escape();
await win.setViewportSize({ width: W, height: H });
await pause(600);

// A long project name at the smallest window, on a blank site.
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Kōwhai Garden Supplies & Landscaping Co-operative', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('body *').first().waitFor({ timeout: 120000 });
await win.setViewportSize({ width: 1280, height: 800 });
await pause(1500);
await shot('tb-long-name-1280', '.project-title', { area: 'toolbar' });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`editor toolbar capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
