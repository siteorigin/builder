// Design capture harness for the editor shell: the left rail, the sidebar and its views, the right dock and its
// tabs, the splitters, the "Editing … everywhere" band, how the panels frame the canvas, and the shell at the
// smallest, common and wide window sizes. Drives the real (built) app. Opt-in only, never part of
// `npm run test:e2e`, and it never calls a real provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/editor-shell.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing
// a plausible-looking wrong image. Files are `{state}--{theme}.png`: full windows, plus crops of the rail, the
// dock's tab strip and each splitter.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('editor shell capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'editor-shell');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-shell-')));
const BOTH = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const pause = (ms) => win.waitForTimeout(ms);
const frame = win.frameLocator('.frame-box iframe');
const written = [];

/** Size the real window rather than emulating a viewport, so captures keep the display's own pixel density. */
async function size(w, h) {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
    const bw = BrowserWindow.getAllWindows()[0];
    bw.unmaximize();
    bw.setContentSize(cw, ch);
  }, [w, h]);
  await pause(700);
  const got = await win.evaluate(() => [innerWidth, innerHeight]);
  if (got[0] !== w || got[1] !== h) throw new Error(`window is ${got.join('x')}, expected ${w}x${h}`);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Regions of the window: the whole window, or one part of the shell. */
async function region(name) {
  if (name === 'window') return undefined;
  const box = async (sel) => {
    const b = await win.locator(sel).first().boundingBox();
    if (!b) throw new Error(`region ${name}: ${sel} has no box`);
    return b;
  };
  const vp = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (name === 'rail') {
    const b = await box('.workspace');
    return { x: 0, y: Math.floor(b.y - 1), width: 360, height: 320 };
  }
  if (name === 'dock-head') {
    const b = await box('.dock');
    return { x: Math.floor(b.x - 24), y: Math.floor(b.y - 1), width: Math.ceil(b.width + 24), height: 140 };
  }
  if (name === 'left-split') {
    const b = await box('.side-panel');
    return { x: Math.floor(b.x + b.width - 120), y: Math.floor(b.y), width: 240, height: 240 };
  }
  if (name === 'right-split') {
    const b = await box('.dock');
    return { x: Math.floor(b.x - 120), y: Math.floor(b.y), width: 240, height: 240 };
  }
  if (name === 'split-menu') {
    const b = await box('.side-panel');
    return { x: Math.floor(b.x + b.width - 140), y: Math.floor(b.y), width: 420, height: 300 };
  }
  if (name === 'grip') {
    const b = await box('.side-panel');
    return { x: Math.floor(b.x + b.width - 200), y: Math.floor(b.y), width: 400, height: 260 };
  }
  if (name === 'band') {
    const b = await box('.mode-band');
    return { x: 0, y: 0, width: vp.width, height: Math.ceil(b.y + b.height + 160) };
  }
  throw new Error(`unknown region ${name}`);
}

/** Capture a state; `check` must be visible at the moment of capture. */
async function shot(state, check, { themes = BOTH, area = 'window', pointer = [720, 620] } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (pointer) {
      // Through an empty stretch of the status bar first: moves into the preview frame (its own process) never
      // reach this document, so a control hovered by the previous step would otherwise stay hovered.
      const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
      await win.mouse.move(Math.round(w / 2), h - 6);
      await win.mouse.move(pointer[0], pointer[1]);
    }
    await pause(200);
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
const railButton = (name) => win.locator(`.rail [aria-label="${name}"]`);
const openRail = async (name, open = true) => {
  const b = railButton(name);
  if (((await b.getAttribute('aria-pressed')) === 'true') !== open) await b.click();
  await pause(300);
};
const dockTab = (name) => win.locator('.dock [role="tab"]', { hasText: name });
const setDock = async (open) => {
  const b = win.locator('.toolbar [aria-label="Right panel"]');
  if (((await b.getAttribute('aria-pressed')) === 'true') !== open) await b.click();
  await pause(400);
};

await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await size(1440, 900);

// ---- A populated project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await openRail('Pages');

// Rest: Pages open, the Inspector showing the page, nothing selected.
await shot('shell-rest', '.side-panel .pages-list');

// An element selected: the Inspector is populated and the canvas carries the selection.
await frame.locator('h1').first().click();
await pause(800);
await shot('shell-selected', '.ov-selected');
await escape(3);

// Each sidebar view.
await openRail('Layers');
await shot('shell-layers', '.side-panel .layers-tree', { themes: ['light'] });
await openRail('Insert');
await shot('shell-insert', '.rail [aria-label="Insert"][aria-pressed="true"]', { themes: ['light'] });
await openRail('Assets');
await shot('shell-assets', '.rail [aria-label="Assets"][aria-pressed="true"]', { themes: ['light'] });
await openRail('Pages');

// The dock's other views: AI, then Site styles from the rail shortcut.
await dockTab('AI').click();
await pause(500);
await shot('shell-ai', '.dock [role="tab"][aria-selected="true"]', { themes: ['light'] });
await railButton('Site styles').click();
await pause(700);
await shot('shell-styles', '.rail [aria-label="Site styles"][aria-pressed="true"]');
await dockTab('Inspector').click();
await pause(300);

// Keyboard focus on the rail and on the dock's tabs.
await railButton('Layers').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(200);
if (!(await win.evaluate(() => !!document.querySelector('.rail :focus-visible')))) throw new Error('no focus-visible rail button; refusing to write rail-focus');
await shot('rail-focus', '.rail :focus-visible', { area: 'rail', pointer: null });
await dockTab('Inspector').focus();
await win.keyboard.press('ArrowRight');
await pause(400);
if (!(await win.evaluate(() => !!document.querySelector('.dock [role="tab"]:focus-visible')))) throw new Error('no focus-visible dock tab; refusing to write dock-tabs-focus');
await shot('dock-tabs-focus', '.dock [role="tab"]:focus-visible', { themes: ['light'], area: 'dock-head', pointer: null });
await dockTab('Inspector').click();
await win.evaluate(() => document.activeElement && document.activeElement.blur());
await pause(300);

// The splitters: at rest, under the pointer, with keyboard focus, and mid-drag.
await shot('left-split-rest', '.seam.left .resizer', { themes: ['light'], area: 'left-split' });
{
  const r = await win.locator('.seam.left .resizer').boundingBox();
  await win.mouse.move(r.x + r.width / 2, r.y + 120);
  await pause(500);
  await shot('left-split-hover', '.seam.left .resizer:hover', { area: 'left-split', pointer: [r.x + r.width / 2, r.y + 120] });
  // The same steps without dragging: the splitter's own menu.
  await win.mouse.click(r.x + r.width / 2, r.y + 120, { button: 'right' });
  await pause(400);
  await shot('left-split-menu', '.menu', { themes: ['light'], area: 'split-menu', pointer: null });
  await escape();
}

// The seam's grip at the top of each splitter: at rest, under the pointer, and clicked (its width menu).
await win.evaluate(() => document.activeElement && document.activeElement.blur());
{
  const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
  await win.mouse.move(Math.round(w / 2), h - 6);
}
await win.mouse.move(720, 620);
await pause(300);
// Nothing may still be lit from the steps above, or the grip's resting look would not be what is captured.
const stuck = await win.evaluate(() => [...document.querySelectorAll('.resizer')].map((r) => `${r.className} hover=${r.matches(':hover')}`).join(' | '));
if (/dragging|hover=true/.test(stuck)) throw new Error(`a seam is still lit before grip-rest: ${stuck}`);
await shot('grip-rest', '.seam.left .split-grip', { area: 'grip' });
{
  const g = await win.locator('.seam.left .split-grip').boundingBox();
  await win.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await pause(400);
  await shot('grip-hover', '.seam.left .split-grip:hover', { themes: ['light'], area: 'grip', pointer: [g.x + g.width / 2, g.y + g.height / 2] });
  await win.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
  await pause(400);
  await shot('grip-menu', '.menu', { themes: ['light'], area: 'split-menu', pointer: null });
  await escape();
}
await win.locator('.seam.right .resizer').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(200);
await shot('right-split-focus', '.seam.right .resizer:focus-visible', { themes: ['light'], area: 'right-split', pointer: null });
await win.evaluate(() => document.activeElement && document.activeElement.blur());
{
  const r = await win.locator('.seam.right .resizer').boundingBox();
  const x = r.x + r.width / 2;
  await win.mouse.move(x, r.y + 120);
  await win.mouse.down();
  await win.mouse.move(x - 30, r.y + 120, { steps: 4 });
  await pause(300);
  await shot('right-split-drag', '.seam.right .resizer.dragging', { themes: ['light'], area: 'right-split', pointer: null });
  await win.mouse.move(x, r.y + 120, { steps: 4 });
  await win.mouse.up();
  await pause(300);
}

// Enter on a focused seam hides its panel and keeps focus at the edge; Enter again brings it back.
await win.locator('.seam.left .resizer').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await win.keyboard.press('Enter');
await pause(500);
if (await win.locator('.side-panel').isVisible()) throw new Error('Enter on the sidebar seam did not hide the sidebar');
await shot('seam-collapsed-focus', '.seam.left.collapsed .resizer:focus-visible', { themes: ['light'], area: 'rail', pointer: null });
await win.keyboard.press('Enter');
await pause(500);
if (!(await win.locator('.side-panel').isVisible())) throw new Error('Enter on the collapsed seam did not bring the sidebar back');
await win.evaluate(() => document.activeElement && document.activeElement.blur());

// The panels closed: the sidebar alone, then both.
await openRail('Pages', false);
await shot('shell-left-closed', '.rail', { themes: ['light'] });
await setDock(false);
await shot('shell-closed', '.rail');
await setDock(true);
await openRail('Pages');

// The AI working: the dock tab's live mark while another view is showing. Pushed through the agent's own
// event channel; it ends with a stop.
{
  const ev = (status) => ({ runId: 'r_shell', conversationId: 'shell', kind: 'status', status });
  await app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', e), ev('running'));
  await pause(500);
  await shot('dock-ai-busy', '.dock [role="tab"] .live', { area: 'dock-head' });
  await app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', e), ev('awaiting-input'));
  await pause(500);
  await shot('dock-ai-waiting', '.dock [role="tab"] .live.asking', { themes: ['light'], area: 'dock-head' });
  await app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', e), ev('cancelled'));
  await pause(800);
}

// Editing a component everywhere: the band over the whole workspace, and its Done editing focused.
await openRail('Layers');
await win.locator('.list-item', { hasText: 'Services grid' }).first().click();
await pause(600);
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: /Edit everywhere/ }).click();
await pause(300);
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await pause(1800);
await shot('shell-definition', '.mode-band');
await win.locator('.mode-band-done').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(200);
await shot('band-focus', '.mode-band-done:focus-visible', { themes: ['light'], area: 'band', pointer: null });
await win.evaluate(() => document.activeElement && document.activeElement.blur());

// The smallest window, still in the mode: the band has to keep its sentence and its exit.
await size(1100, 700);
await pause(600);
await shot('window-1100-definition', '.mode-band', { themes: ['light'] });
await win.locator('.mode-band-done').click();
await pause(800);
await escape(3);

// The smallest window with both panels open, then a common laptop and a wide display.
await openRail('Pages');
await pause(600);
await shot('window-1100', '.editor', { themes: ['light', 'dark'] });
// The dock at its widest squeezes the sidebar to its 200px floor: the head's actions move under the title.
await win.locator('.seam.right .resizer').focus();
await win.keyboard.press('End');
await pause(600);
await shot('window-1100-narrow-sidebar', '.side-panel.narrow', { themes: ['light'] });
await win.locator('.seam.right .resizer').dblclick();
await win.evaluate(() => document.activeElement && document.activeElement.blur());
await pause(600);
await size(1280, 800);
await shot('window-1280', '.editor', { themes: ['light'] });
await size(1920, 1080);
await shot('window-1920', '.editor', { themes: ['light'] });

await app.close();
rmSync(WORK, { recursive: true, force: true });
if (errors.length) console.log('page errors:\n' + errors.join('\n'));

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`editor shell capture: ${written.length} written, ${count} PNGs in ${OUT}`);
