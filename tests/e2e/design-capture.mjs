// Design capture harness: drives the real (built) app through every design-relevant state in light
// and dark and writes one PNG per state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design-capture.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead
// of writing a plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { MOD } from './harness.mjs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('design capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'design-capture');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-')));
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

// Appearance stays on "System" (as most users run it) and the system scheme is emulated per capture, so
// the Settings dialog shows the setting the user would actually see.
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Capture a state in the given themes; `check` must be visible at the moment of capture. */
async function shot(state, check, themes = THEMES) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(2, 450);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const closeModal = async () => {
  await win.keyboard.press('Escape');
  await pause(200);
};

// ---- Welcome ----
await shot('welcome-empty', '.empty-state');
await win.getByRole('button', { name: /New project/ }).first().click();
await win.waitForSelector('.modal');
await win.fill('input[placeholder^="For example"]', 'Harbour Lane Studio');
await shot('new-project', '.starter-grid');
await closeModal();

// Seed recents: a blank site with a long name, then the business starter we edit in.
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Kōwhai Garden Supplies & Landscaping Co-operative', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('body *').first().waitFor({ timeout: 90000 });
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.recent-card');
await pause(300);
await shot('welcome-recents', '.recent-grid');

// Trust prompt: a project whose build configuration changed since it was last opened.
try {
  const recents = await win.evaluate(() => window.builder.projects.recents());
  const blankPkg = join(recents.find((r) => r.name.startsWith('K')).dir, 'package.json');
  const pkg = JSON.parse(readFileSync(blankPkg, 'utf8'));
  pkg.scripts = { ...pkg.scripts, postinstall: 'echo changed' };
  writeFileSync(blankPkg, JSON.stringify(pkg, null, 2));
  await win.locator('.recent-card', { hasText: 'Kōwhai' }).click();
  if (await win.locator('.modal', { hasText: 'Trust' }).waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    await shot('trust-project', '.modal');
    await win.getByRole('button', { name: 'Cancel' }).click();
  } else if (await win.locator('.editor').isVisible()) {
    console.log('skipped trust-project: the changed project opened without a trust prompt');
    await win.evaluate(() => window.builder.projects.close());
    await win.waitForSelector('.welcome');
  } else console.log('skipped trust-project: no trust prompt appeared');
} catch (e) {
  console.log('skipped trust-project:', String(e).slice(0, 160));
}

// ---- Editor ----
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
// The preview takes a moment to start when a project reopens; catch that state when it is visible.
if (await win.locator('.canvas-state').waitFor({ timeout: 5000 }).then(() => true, () => false)) {
  // Captured directly: the state lasts only a moment, too short for the theme round trip in shot().
  const path = join(OUT, 'editor-starting--light.png');
  await win.screenshot({ path });
  if (!(await win.locator('.canvas-state').isVisible())) rmSync(path, { force: true }), console.log('skipped editor-starting: it ended during the capture');
  else written.push(path);
} else console.log('skipped editor-starting: the preview was ready before it could be captured');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);
await shot('editor-pages', '.side-panel .list');

// Section selected (hero) with its inspector.
await frame.locator('h1').first().click();
await pause(700);
await shot('editor-section-selected', '.insp-head');

// Text inside the section selected (a part).
await frame.locator('h1').first().click();
await pause(700);
await shot('editor-part-selected', '.ov-selected');

// A style changed here: its reset sits beside the name.
{
  const sel = win.locator('#dock-panel-inspect select[aria-label="Text style"]').first();
  if (await sel.count()) {
    const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    if (opts.length) {
      await sel.selectOption(opts[Math.min(1, opts.length - 1)]);
      await pause(700);
      await shot('style-changed', '.reset-dot');
      await win.locator('.reset-dot').first().click();
      await pause(500);
    }
  }
}

// Layers with a repeated item selected.
await win.locator('.rail [aria-label="Layers"]').click();
const gridRow = win.locator('.list-item', { hasText: 'Services grid' });
await gridRow.locator('.tree-toggle').click();
await win.locator('.list-item', { hasText: 'Card title' }).first().click();
await pause(700);
await shot('layers-part', '[role="tree"] .list-item.selected');

// One card's title picked on the page: "one of 3", and "This card only" on Content.
await frame.getByText('Materials & colour', { exact: true }).first().dispatchEvent('click');
await pause(700);
await shot('card-picked', '.ov-chip', ['light']);

// Section context menu from the canvas overlay (shift-click on delete opens "more").
await gridRow.click();
await pause(500);
await win.locator('.list-item', { hasText: 'Services grid' }).click({ button: 'right' });
await pause(300);
if (await win.locator('.menu').isVisible().catch(() => false)) {
  await shot('layers-context-menu', '.menu', ['light']);
  await win.keyboard.press('Escape');
}

// Insert panel.
await win.locator('.rail [aria-label="Insert"]').click();
await pause(400);
await shot('insert-panel', '.insert-grid');

// Assets panel.
await win.locator('.rail [aria-label="Assets"]').click();
await pause(600);
await shot('assets-panel', '.asset-grid');
await win.locator('.asset-tile').first().click();
await pause(400);
await shot('asset-selected', '.asset-detail', ['light']);
await win.locator('.asset-back').click();

// Pages panel with a page's options menu.
await win.locator('.rail [aria-label="Pages"]').click();
await pause(300);
await win.locator('.side-panel .list-item', { hasText: 'About' }).hover();
await win.locator('[aria-label="About options"]').click();
await pause(300);
await shot('pages-menu', '.menu', ['light']);
await win.keyboard.press('Escape');

// Site styles.
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(500);
await shot('site-styles', '#dock-panel-styles .insp-head');
// A site colour changed from the theme.
{
  const hex = win.locator('#dock-panel-styles input.ss-hex').first();
  await hex.fill('#2b5d8a');
  await hex.press('Enter');
  await pause(700);
  await shot('site-style-changed', '#dock-panel-styles .reset-dot');
  await win.locator('#dock-panel-styles .reset-dot').first().click();
  await pause(500);
}

// AI assistant before a provider is connected, then with one.
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await pause(400);
await shot('ai-no-provider', '.chat-empty');
await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-design-capture-not-a-real-key'));
await win.evaluate(() => window.builder.app.setSettings({}));
await pause(200);
// Reload providers into the renderer through the same channel the app uses on start.
await win.reload();
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await frame.locator('h1').first().click();
await pause(600);
await shot('ai-ready', '.composer');
await win.evaluate(() => window.builder.ai.setKey('openai', null));

// Phone viewport with a selection.
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await pause(1200);
await shot('phone-viewport', '.frame-box');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await pause(800);

// The smallest supported window, then the same with the right panel collapsed.
await win.mouse.click(5, 300);
await win.keyboard.press('Escape');
await win.keyboard.press('Escape');
await win.keyboard.press('Escape');
await win.setViewportSize({ width: 1280, height: 800 });
await pause(900);
// Select the hero heading through Layers, then close the sidebar as the small-window rule does for Pages.
await win.locator('.rail [aria-label="Layers"]').click();
await pause(300);
const heroRow = win.locator('.list-item', { hasText: 'Split hero' }).first();
if ((await heroRow.getAttribute('aria-expanded')) !== 'true') await heroRow.locator('.tree-toggle').click();
await win.locator('[role="treeitem"]', { hasText: /^Heading$/ }).first().click();
await win.locator('.rail [aria-label="Layers"]').click();
await pause(900);
await shot('window-1280', '.editor');
await win.locator('[aria-label="Right panel"]').click();
await pause(900);
await shot('dock-collapsed', '.editor', ['light']);
await win.locator('[aria-label="Right panel"]').click();
await win.setViewportSize({ width: 1440, height: 900 });
if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();
await pause(900);

// Preview mode.
await win.getByRole('button', { name: /Preview/ }).first().click();
await pause(500);
await shot('preview-mode', '.canvas', ['light']);
await win.getByRole('button', { name: /Edit/ }).first().click();
await pause(300);

// Project menu.
await win.locator('.project-title').click();
await pause(300);
await shot('project-menu', '.menu', ['light']);
await win.keyboard.press('Escape');

// Modals.
await win.locator('[aria-label="Settings"]').click();
await pause(300);
await shot('settings-general', '.modal');
await win.getByRole('tab', { name: 'AI assistant' }).click();
await pause(300);
await shot('settings-ai', '.modal');
// A typed key that was not saved: closing asks, with Keep editing first.
{
  const key = win.locator('.modal input[type="password"]').first();
  if (await key.count()) {
    await key.fill('sk-typed-but-not-saved');
    await win.keyboard.press('Escape');
    await pause(400);
    await shot('settings-unsaved', '.modal >> text=Keep editing', ['light']);
    await win.getByRole('button', { name: 'Discard', exact: true }).click();
    await pause(300);
  } else await closeModal();
}
if (await win.locator('.modal').count()) await closeModal();

await win.getByRole('button', { name: 'Export', exact: true }).click();
await pause(300);
await shot('export', '.modal');
await closeModal();

await win.keyboard.press(`${MOD}+K`);
await pause(200);
await win.keyboard.type('pa');
await pause(300);
await shot('command-menu', '.cmdk');
await closeModal();

await win.locator('.project-title').click();
await win.getByRole('menuitem', { name: /History/ }).click();
await pause(400);
await shot('history', '.modal', ['light']);
await closeModal();

await win.locator('.status-bar button[title^="Project health:"]').click();
await pause(300);
await shot('diagnostics', '.modal');
await closeModal();

// An edit through the inspector, so History has entries; then the save toast.
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
await openRail('Pages');
await frame.locator('h1').first().click();
await pause(600);
const eyebrow = win.locator('.field', { hasText: 'Eyebrow' }).locator('input').first();
if (await eyebrow.isVisible().catch(() => false)) {
  await eyebrow.fill('Interior design studio, est. 2009');
  await eyebrow.press('Enter');
  await pause(1200);
}
await win.keyboard.press('Escape');
await pause(200);
await win.keyboard.press(`${MOD}+S`);
await pause(400);
await shot('toast', '.toast', ['light']);
await win.locator('.project-title').click();
await win.getByRole('menuitem', { name: /History/ }).click();
await pause(400);
await shot('history-entries', '.modal');
await closeModal();

// Adding a page inline, then the delete confirmation for an existing page.
await win.locator('.side-panel .btn', { hasText: 'Add page' }).click();
await win.keyboard.type('Our services');
await pause(300);
await shot('add-page', '.side-panel input.inline-edit', ['light']);
await win.keyboard.press('Escape');
await pause(200);
await win.locator('.side-panel .list-item', { hasText: 'Contact' }).hover();
await win.locator('[aria-label="Contact options"]').click();
await win.getByRole('menuitem', { name: /Delete page/ }).click();
await pause(400);
await shot('delete-page', '.modal');
await closeModal();

// Edit definition: the confirmation, then definition mode.
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Services grid' }).click();
await pause(400);
const compSection = win.locator('.section-head', { hasText: 'Component' });
if (await compSection.getAttribute('aria-expanded') === 'false') await compSection.click();
await win.getByRole('button', { name: /Edit everywhere/ }).click();
await pause(300);
await shot('edit-definition', '.modal', ['light']);
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await pause(1800);
await shot('definition-mode', '.mode-band');
await win.locator('.mode-band-done').click();
await pause(800);

// Source view (a Developer mode feature).
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await pause(200);
await closeModal();
await frame.locator('h1').first().click();
await pause(400);
if (!(await win.getByRole('button', { name: 'View source' }).isVisible())) await win.locator('.section-head', { hasText: 'Component' }).click();
await win.getByRole('button', { name: 'View source' }).click();
await pause(600);
await shot('source', '.modal');
await closeModal();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`design capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
