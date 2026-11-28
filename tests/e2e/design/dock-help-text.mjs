// Design capture for the right dock's help text: the Inspector's Page settings (Page, Search & sharing and the
// sections most pages leave closed), a selected section and one of its parts, Site styles and the Project tab. Each
// capture is the whole panel in one image, however long it is, so how much text a panel carries can be judged at a
// glance. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/dock-help-text.mjs
//
// Drives the real (built) app with a populated business project and writes `{state}--{theme}.png` at 2x. Every
// capture is checked on screen after it settles, and a state that did not render throws instead of writing.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('dock help text capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'dock-help-text');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-dock-text-')));
const WIDTH = 1440;
const HEIGHT = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: WIDTH, height: HEIGHT });
const cdp = await win.context().newCDPSession(win);
const metrics = (height) => cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height, deviceScaleFactor: 2, mobile: false });
await metrics(HEIGHT);
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** The visible panel's scroller in the dock. */
const SCROLLER = '.dock [role="tabpanel"]:not([hidden]) .panel-body, .dock .panel-body:not([hidden])';

/**
 * Capture the dock with its panel unrolled: the window grows until the panel's whole content shows, so one image
 * holds all of it. `check` must be visible in the dock. `before` runs once the window is tall.
 */
async function shot(state, check, { themes = ['light'], before, mouse } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    const extra = await win.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent);
      return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    }, SCROLLER);
    await metrics(Math.min(HEIGHT + extra + 40, 7000));
    await pause(400);
    if (before) await before();
    if (mouse) await win.mouse.move(mouse.x, mouse.y);
    else await win.mouse.move(700, 5);
    await pause(300);
    const visible = await win.locator('.dock').locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const b = await win.locator('.dock').boundingBox();
    const path = join(OUT, `${state}--${theme}.png`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
    await metrics(HEIGHT);
    await pause(200);
  }
  await setTheme('light');
}

const apply = (operations, label) => win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
const mustApply = async (operations, label) => {
  const r = await apply(operations, label);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(600);
  return r;
};

const PANEL = '#dock-panel-inspect';
const head = (title) => win.locator(`${PANEL} .section-head`, { hasText: new RegExp(`^${title}`) }).first();
const setOpen = async (title, open) => {
  const h = head(title);
  if (!(await h.count())) return;
  if ((await h.getAttribute('aria-expanded')) !== String(open)) {
    await h.click();
    await pause(250);
  }
};
const PAGE_SECTIONS = ['Page', 'Article', 'Language', 'Header & footer', 'Search & sharing', 'Structured data', 'Advanced'];
const only = async (...open) => {
  for (const t of PAGE_SECTIONS) await setOpen(t, open.includes(t));
};

async function pageSettings(title) {
  await win.locator('.side-panel .list-item', { hasText: title }).first().hover();
  await win.locator(`[aria-label="${title} options"]`).first().click();
  await win.getByRole('menuitem', { name: 'Page settings' }).click();
  await head('Page').waitFor();
  await pause(400);
}

async function clearSelection() {
  for (let i = 0; i < 4; i++) await win.keyboard.press('Escape');
  await pause(400);
}

const dockTab = async (name) => {
  await win.locator('.dock-tab', { hasText: name }).first().click();
  await pause(600);
};

/** Open every collapsed section in the visible panel. */
async function expandAll(scope) {
  for (let i = 0; i < 30; i++) {
    const closed = win.locator(`${scope} .section-head[aria-expanded="false"]`);
    if (!(await closed.count())) break;
    await closed.first().click();
    await pause(150);
  }
}

// ---- A populated business site, open in the editor ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await dockTab('Inspector');

// ---- Page settings for About: Page and Search & sharing open, as an author first sees them ----
await pageSettings('About');
await only('Page', 'Search & sharing');
await shot('page-settings', `${PANEL} input[aria-label="Page address"]`, { themes: ['light', 'dark'] });

// ---- A field's explanation open: Canonical URL's info button, clicked ----
const tip = win.locator(`${PANEL} button.info-tip[aria-label="About Canonical URL"]`).first();
if (await tip.count()) {
  await shot('info-open', '.info-tip[aria-expanded="true"]', {
    before: async () => {
      await tip.scrollIntoViewIfNeeded();
      await tip.click();
      await pause(250);
      if (!(await win.locator('.info-bubble').isVisible())) throw new Error('the info bubble did not open');
    },
    mouse: { x: 700, y: 5 }
  });
  await win.keyboard.press('Escape');
  await pause(200);
}

// ---- The same page with its quieter sections open ----
await only('Article', 'Language', 'Header & footer', 'Structured data');
await shot('page-settings-more', `${PANEL} .section-head[aria-expanded="true"]`);

// ---- A draft page with pages inside it: the notes that change with its state ----
await mustApply([{ type: 'page.update', pageId: Object.values((await win.evaluate(() => window.builder.project.snapshot())).state.pages).find((p) => p.title === 'About').id, draft: true }], 'Draft About');
await only('Page', 'Search & sharing');
await shot('page-settings-draft', `${PANEL} input[aria-label="Page address"]`);
await win.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
await pause(500);

// ---- A section of the page, every group open ----
await clearSelection();
await frame.locator('h1').first().click();
await pause(900);
await expandAll(PANEL);
await shot('section', `${PANEL} .insp-head`);

// ---- One part of it: the heading ----
await frame.locator('h1').first().click();
await pause(900);
await expandAll(PANEL);
await shot('part', `${PANEL} .insp-head`);
await clearSelection();

// ---- Site styles as it opens: Basics, Colors and Text styles ----
const STYLES = '#dock-panel-styles';
const stylesOnly = async (...open) => {
  for (const h of await win.locator(`${STYLES} .section-head`).all()) {
    const title = (await h.innerText()).split('\n')[0].trim();
    if ((await h.getAttribute('aria-expanded')) !== String(open.includes(title))) {
      await h.click();
      await pause(200);
    }
  }
};
await dockTab('Site styles');
await stylesOnly('Basics', 'Colors', 'Text styles');
await shot('site-styles', `${STYLES} .section-head`);

// ---- Site styles' site-wide settings: Site details, AI agents and Crawlers open ----
await stylesOnly('Site details', 'AI agents', 'Crawlers', 'Redirects');
await shot('site-styles-site', `${STYLES} .section-head[aria-expanded="true"]`);
await stylesOnly('Basics', 'Colors', 'Text styles');

// ---- The Project tab ----
await dockTab('Project');
await expandAll('#dock-panel-project');
await shot('project', '#dock-panel-project');

if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`dock help text capture: ${written.length} written, ${files.length} in ${OUT}`);
await app.close();
rmSync(WORK, { recursive: true, force: true });
