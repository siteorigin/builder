// Design capture for the Inspector's Tag field: the HTML element a plain text or a container is, with the tags that
// don't fit where it sits and why. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/tag-picker.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`, clipped to the Inspector's Content section, plus
// `{state}.options.txt`: the select's options as the open native menu lists them (a page screenshot never shows the
// menu itself). Each capture checks its state on screen after it settles and throws rather than writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('tag picker capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'tag-picker');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-tag-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
win.setDefaultTimeout(60000);
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1100 });
await win.waitForSelector('.welcome', { timeout: 120000 });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The Tag select in the dock: the select its "Tag" label names. */
const tagSelect = () => win.locator('.dock .section-body select').filter({ has: win.locator('optgroup') }).first();

/** The Content section holding the Tag field, as a clip rectangle with a margin of the dock around it. */
async function contentClip() {
  const rect = await tagSelect().evaluate((el) => {
    const section = el.closest('.section');
    const dock = el.closest('.dock');
    if (!section || !dock) return null;
    const s = section.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    return { x: d.x, y: s.y - 8, width: d.width, height: Math.min(s.height + 16, 620) };
  });
  if (!rect) throw new Error('the Tag select is not inside an Inspector section');
  return rect;
}

/** The options the open native menu lists, one per line: group headings, then each option and whether it is disabled. */
async function optionsText() {
  return tagSelect().evaluate((sel) => {
    const lines = [`value=${sel.value}`];
    for (const child of sel.children) {
      if (child.tagName === 'OPTGROUP') {
        lines.push(`[${child.label}]`);
        for (const o of child.children) lines.push(`  ${o.disabled ? '(disabled) ' : ''}${o.textContent}${o.title ? `   title="${o.title}"` : ''}${o.selected ? '   <selected>' : ''}`);
      } else lines.push(`${child.disabled ? '(disabled) ' : ''}${child.textContent}${child.selected ? '   <selected>' : ''}`);
    }
    return lines.join('\n');
  });
}

/** Capture the Content section per theme; `check` must be visible in the dock at the moment of capture. */
async function shot(state, check, { themes = BOTH, prepare } = {}) {
  writeFileSync(join(OUT, `${state}.options.txt`), (await optionsText()) + '\n');
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(700, 1090);
    await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    if (prepare) await prepare();
    await pause(250);
    if (!(await win.locator('.dock').locator(check).first().isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await contentClip() });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

async function clearSelection() {
  await win.mouse.click(700, 1090);
  for (let i = 0; i < 4; i++) await win.keyboard.press('Escape');
  await pause(400);
}
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(300);
};
async function addBasic(name) {
  await clearSelection();
  await openRail('Insert');
  await win.locator('.insert-tile.basic', { hasText: name }).first().click();
  await pause(1200);
  await tagSelect().waitFor();
}
/** Open the disclosure under the Tag field that says why some tags can't be chosen. */
const openReasons = async () => {
  const d = win.locator('.dock .section-body details').first();
  if (!(await d.evaluate((el) => el.open))) await d.locator('summary').click();
  await pause(200);
};
const closeReasons = async () => {
  const d = win.locator('.dock .section-body details').first();
  if (await d.count()) if (await d.evaluate((el) => el.open)) await d.locator('summary').click();
  await pause(200);
};
const choose = async (tag) => {
  await tagSelect().selectOption(tag);
  await pause(900);
};

// ---- Project: the business starter ----
const sites = join(WORK, 'sites');
const created = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
if (!created?.ok) throw new Error(`project creation failed: ${created?.message}`);
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 240000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
});

// 1. A heading added from Insert: plain text, Heading 2, at the page's top level.
await addBasic('Heading');
await shot('heading', 'select');
await shot('heading-reasons', 'details[open]', { prepare: openReasons });
await closeReasons();

// 2. The same heading made a paragraph: no longer a heading.
await choose('p');
await shot('paragraph', 'select', { themes: LIGHT });
await choose('h3');
await shot('heading-h3', 'select', { themes: LIGHT });
await choose('h1');
await shot('heading-h1', 'select', { themes: LIGHT });

// 3. A container added from Insert.
await addBasic('Container');
await shot('container', 'select');
await shot('container-reasons', 'details[open]', { prepare: openReasons });
await closeReasons();
await choose('ul');
await shot('container-list', 'select', { themes: LIGHT });

// 4. Text added inside a Paragraph container: inline text, where most tags can't go (the fullest fold).
await addBasic('Container');
await choose('p');
await openRail('Insert');
await win.locator('.insert-tile.basic', { hasText: 'Heading' }).first().click();
await pause(1200);
await win.locator('.dock .section-body select optgroup[label="Headings"]').first().waitFor({ state: 'attached' });
await shot('in-paragraph', 'select', { themes: LIGHT });
await shot('in-paragraph-reasons', 'details[open]', { themes: LIGHT, prepare: openReasons });
await closeReasons();
await clearSelection();

// 5. A text in a component's design, edited everywhere (the field's third home).
await openRail('Layers');
await win.locator('.list-item', { hasText: 'Services grid' }).first().click();
await pause(500);
const compSection = win.locator('.dock .section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: /Edit everywhere/ }).click();
await pause(400);
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await pause(1800);
await win.keyboard.press('Escape');
await pause(500);
await frame.getByText('Materials & color', { exact: true }).first().dispatchEvent('click');
await pause(900);
await tagSelect().waitFor({ timeout: 15000 });
await shot('design-node', 'select');

if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
await app.close();
rmSync(WORK, { recursive: true, force: true });
const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`tag picker capture: ${written.length} written, ${pngs.length} PNGs in ${OUT}`);
if (written.length !== 16) throw new Error(`expected 16 captures, wrote ${written.length}`);
