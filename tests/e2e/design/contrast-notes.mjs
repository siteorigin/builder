// Design capture for the contrast notes in Site styles (ContrastNotes.tsx): the flag under a colour that is
// hard to read somewhere, the offer of a colour that reads, the "Contrast where it is used" list, and the
// brand colour's own block in Basics. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/contrast-notes.mjs
//
// Drives the real (built) app with a populated business project, seeds colours through the same
// project:apply channel the editor uses, and writes `{state}--{theme}.png`: the dock alone at 2x, scrolled
// to the state. Every capture is checked on screen after it settles, and a state that did not render
// throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('contrast notes capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'contrast-notes');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-contrast-')));
const THEMES = ['light', 'dark'];
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;
const row = (id) => `${PANEL} .ss-color[data-token-id="${id}"]`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
// Captures at 2x, so 12px notes and swatch edges are legible to a reviewer.
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
const scrollToEl = async (sel, offset = 150) => {
  const top = await win.evaluate(([s, scr, o]) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`nothing matches ${s}`);
    const box = document.querySelector(scr);
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - o;
  }, [sel, SCROLLER, offset]);
  await win.evaluate(([scr, t]) => (document.querySelector(scr).scrollTop = t), [SCROLLER, top]);
};

/** Capture `state` per theme: the dock alone, scrolled so `at` sits under the sticky header. */
async function shot(state, check, { themes = THEMES, at, offset = 150, keepFocus = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (at) await scrollToEl(at, offset);
    if (!keepFocus) await win.mouse.move(2, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const b = await win.locator('.dock').boundingBox();
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const apply = (operations, label) => win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
const mustApply = async (operations, label) => {
  const r = await apply(operations, label);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(900);
};
const reset = (ids) => apply(ids.map((tokenId) => ({ type: 'token.set', tokenId, value: null })), 'Design capture: reset');

/** Open every collapsed section in the panel. */
async function expandAll() {
  for (let i = 0; i < 20; i++) {
    const closed = win.locator(`${PANEL} .section-head[aria-expanded="false"]`);
    if (!(await closed.count())) break;
    await closed.first().click();
    await pause(120);
  }
}

// ---- A populated business site, open in the editor, Site styles showing every section ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
await expandAll();

// ---- 1. A brand colour the button text cannot be read on: the brand block in Basics, and the rows in Colors ----
await mustApply([{ type: 'token.set', tokenId: 'color.brand', value: '#f4d35e' }], 'Design capture: low contrast brand');
await shot('brand-block', `${PANEL} .ss-contrast .ss-pair.fail`, { at: `${PANEL} .ss-contrast`, offset: 230 });
await shot('brand-row', `${row('color.brand')} .ss-flag`, { at: row('color.brand'), offset: 130 });
await shot('on-brand-row', `${row('color.on-brand')} .ss-flag`, { at: row('color.on-brand'), offset: 130, themes: ['light'] });

// ---- 2. Primary text too light for every ground: the flag with "Show all", the offer, and a ground's pointer ----
await reset(['color.brand']);
await mustApply([{ type: 'token.set', tokenId: 'color.text', value: '#8d8d8d' }], 'Design capture: light text');
await shot('text-row', `${row('color.text')} .ss-flag`, { at: row('color.text'), offset: 130 });
await shot('ground-row', `${row('color.surface-alt')} .ss-flag`, { at: row('color.surface-alt'), offset: 130, themes: ['light'] });

// "Show all", by keyboard, as a keyboard user reaches it: the details open and focus lands on the list.
const showAll = win.locator(`${row('color.text')} button`, { hasText: 'Show all' }).first();
await showAll.focus();
await win.keyboard.press('Enter');
await pause(400);
const focusedList = await win.evaluate(() => !!document.activeElement?.closest('.ss-detail'));
if (!focusedList) throw new Error('Show all did not move focus into the details');
await shot('text-detail', `${row('color.text')} .ss-detail:not([hidden]) .ss-pair.fail`, { at: row('color.text'), offset: 110, keepFocus: true });

// ---- 3. A ground that cannot be measured: the list with a pair that can't be checked ----
await mustApply([{ type: 'token.set', tokenId: 'color.surface', value: 'color-mix(in srgb, currentColor 6%, white)' }], 'Design capture: unmeasurable surface');
await shot('unknown-detail', `${row('color.text')} .ss-detail:not([hidden]) .ss-pair.unknown`, { at: row('color.text'), offset: 110 });
// A colour whose only trouble is a pair that cannot be measured: its collapsed row says so, quietly.
// Basics, with links on that ground unmeasurable: the brand block says so beside three readable previews.
await shot('unknown-brand', `${PANEL} .ss-contrast .ss-flag.unknown`, { at: `${PANEL} .ss-contrast`, offset: 230, themes: ['light'] });
await shot('unknown-row', `${row('color.muted')} .ss-flag.unknown`, { at: row('color.muted'), offset: 130, themes: ['light'] });
await reset(['color.text', 'color.surface']);
await pause(600);

// ---- 4. A readable colour's details: every pair passes ----
await win.locator(`${row('color.muted')} .ss-disclose`).click();
await pause(300);
await shot('pass-detail', `${row('color.muted')} .ss-detail:not([hidden]) .ss-pair.pass`, { at: row('color.muted'), offset: 110 });
await win.locator(`${row('color.muted')} .ss-disclose`).click();

// ---- 5. The narrowest dock, with the brand failing ----
await mustApply([{ type: 'token.set', tokenId: 'color.brand', value: '#f4d35e' }], 'Design capture: low contrast brand');
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (box) {
  await win.mouse.move(box.x + box.width / 2, box.y + 200);
  await win.mouse.down();
  await win.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await win.mouse.up();
  await pause(500);
}
await shot('narrow-brand-block', `${PANEL} .ss-contrast .ss-pair.fail`, { at: `${PANEL} .ss-contrast`, offset: 230, themes: ['light'] });
await shot('narrow-brand-row', `${row('color.brand')} .ss-flag`, { at: row('color.brand'), offset: 130, themes: ['light'] });

await reset(['color.brand', 'color.text', 'color.surface']);
await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`contrast notes capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
