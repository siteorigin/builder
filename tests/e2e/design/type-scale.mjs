// Design capture for Site styles → Text styles: the type scale choice, the specimen it draws at a phone's and a
// desktop's width, and the text styles under it. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/type-scale.mjs
//
// Drives the real (built) app with a populated business project, works the controls the way an owner does (so
// what they say back is on screen), and writes `{state}--{theme}.png`: the dock alone at 2x, scrolled to the
// state, or the whole window for the toast. Every capture is checked on screen after it settles, and a state
// that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('type scale capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'type-scale');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-type-')));
const THEMES = ['light', 'dark'];
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;
const SECTION = `${PANEL} #tok-text`;
const SCALE = `${PANEL} .ss-scale`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** Scroll the panel so `sel` sits `offset` pixels below its top edge, clear of the sticky header. */
const scrollToEl = async (sel, offset = 110) => {
  const top = await win.evaluate(([s, scr, o]) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`nothing matches ${s}`);
    const box = document.querySelector(scr);
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - o;
  }, [sel, SCROLLER, offset]);
  await win.evaluate(([scr, t]) => (document.querySelector(scr).scrollTop = t), [SCROLLER, top]);
};

const write = async (state, theme, whole) => {
  const path = join(OUT, `${state}--${theme}.png`);
  const b = whole ? { x: 0, y: 0, ...(await win.evaluate(() => ({ width: innerWidth, height: innerHeight }))) } : await win.locator('.dock').boundingBox();
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
  writeFileSync(path, Buffer.from(data, 'base64'));
  written.push(path);
  console.log('wrote', path);
};

/** Capture the dock per theme, scrolled to `at`, once `check` is on screen. `keepMouse` leaves the pointer where it is. */
async function shot(state, check, { themes = THEMES, at = SCALE, offset, whole = false, keepMouse = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (at) await scrollToEl(at, offset);
    if (!keepMouse) await win.mouse.move(2, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    await write(state, theme, whole);
  }
  await setTheme('light');
}

const apply = async (operations, label) => {
  const r = await win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(900);
};
/** The scale option named `name`, whatever role the chooser gives its options. */
const option = (name) => win.locator(`${SCALE} :is([role="radio"], button)`, { hasText: new RegExp(`^\\s*${name}\\b`) }).first();

// ---- A populated business site, open in the editor, at Site styles → Text ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const jump = win.locator(`${PANEL} .insp-jump button`, { hasText: /^Text$/ });
if (await jump.count()) await jump.first().click();
await pause(500);

// ---- The theme's own sizes, as a site starts: the chooser and the specimen, then the list of styles ----
await shot('rest', SCALE);
await shot('list', `${PANEL} .ss-text-list`, { at: `${PANEL} .ss-text-list`, offset: 120 });

// ---- Pointing at another scale: what it would do, before it is chosen ----
await setTheme('light');
await scrollToEl(SCALE);
await option('Editorial').hover();
await pause(700);
await shot('hover', SCALE, { themes: ['light'], keepMouse: true });

// ---- A scale chosen: the panel, and what choosing it says at the foot of the window ----
await option('Balanced').click();
await pause(1200);
await shot('chosen', SCALE);
{
  const t = win.locator('.toast').first();
  if (await t.isVisible().catch(() => false)) {
    await setTheme('light');
    await scrollToEl(SCALE);
    await write('chosen-toast', 'light', true);
  } else console.log('note: choosing a scale showed no toast');
}

// ---- Sizes of the owner's own: a heading changed by hand, so no scale fits ----
await apply([{ type: 'token.set', tokenId: 'text.h1', value: { size: '3.1rem' } }], 'Design capture: own heading size');
await shot('custom', SCALE);

// ---- A text style open: its numbers under it ----
const h1 = win.locator(`${PANEL} .ss-text-toggle`, { hasText: 'Heading 1' }).first();
await h1.click();
await pause(400);
await shot('text-open', `${PANEL} .ss-text.open`, { at: `${PANEL} .ss-text.open`, offset: 140 });
await h1.click();
await pause(200);

// ---- Keyboard focus on the chooser ----
await setTheme('light');
await scrollToEl(SCALE);
await win.locator(`${SCALE} :is([role="radio"][tabindex="0"], button)`).first().focus();
await win.keyboard.press('Tab');
await win.keyboard.press('Shift+Tab');
await pause(200);
await shot('focus', `${SCALE} :focus-visible`, { themes: ['light'] });
await win.evaluate(() => document.activeElement?.blur());

// ---- A text style of the owner's own with a long name, changed, in the list ----
await apply(
  [{ type: 'token.create', group: 'text', label: 'Pull quote for the seasonal landscaping feature', value: { family: { token: 'font.display' }, size: '1.6rem', weight: 400, lineHeight: '1.3', tracking: '0em' } }],
  'Design capture: a long text style name'
);
await shot('long-name', `${PANEL} .ss-text-list`, { themes: ['light'], at: `${PANEL} .ss-text:last-child`, offset: 420 });

// ---- The narrowest dock ----
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (box) {
  await win.mouse.move(box.x + box.width / 2, box.y + 200);
  await win.mouse.down();
  await win.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await win.mouse.up();
  await pause(500);
}
await shot('narrow', SCALE, { themes: ['light'] });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`type scale capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
