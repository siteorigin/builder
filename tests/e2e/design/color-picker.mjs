// Design capture for the colour swatch and its picker: the colour rows of Site styles and Your styles, and the
// colour controls of the Inspector's Style tab. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/color-picker.mjs
//
// Drives the real (built) app with a populated business project, sets colours through the project's own
// operations (one followed, one see-through, one of the owner's own), opens each picker the way an owner does,
// and writes `{state}--{theme}.png` at 2x: the swatches where they sit, and each picker open over its row. Every
// capture is checked on screen after it settles, and a state that did not render throws instead of writing a
// wrong image. A swatch that still opens the system's own dialog is never clicked (nothing may pop up during a
// capture), so the picker states are skipped, and said to be, on a build without the editor's own picker.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, openInspector } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('color picker capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'color-picker');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-color-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const STYLES = '#dock-panel-styles';
const INSPECT = '#dock-panel-inspect';
const POP = '.color-pop';

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
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const skipped = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(300);
};

/** The union of the boxes of everything `sels` matches (first match each), padded and kept inside the window. */
async function regionOf(sels, pad) {
  return win.evaluate(
    ([ss, p]) => {
      const boxes = ss.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter((r) => r && r.width && r.height);
      if (!boxes.length) return null;
      const x0 = Math.max(0, Math.min(...boxes.map((b) => b.left)) - p);
      const y0 = Math.max(0, Math.min(...boxes.map((b) => b.top)) - p);
      const x1 = Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + p);
      const y1 = Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + p);
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    },
    [sels, pad]
  );
}

/** Capture the region around `sels` per theme, once every `checks` selector is visible. */
async function shot(state, sels, { themes = BOTH, checks = sels, pad = 12 } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(150);
    for (const check of [].concat(checks)) {
      const visible = await win.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    }
    const clip = await regionOf([].concat(sels), pad);
    if (!clip) throw new Error(`state "${state}" (${theme}) has nothing to frame; refusing to write`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    const path = join(OUT, `${state}--${theme}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const apply = async (operations, label) => {
  for (const op of operations) {
    // One at a time, so a value this build refuses is named and skipped rather than sinking the whole fixture.
    const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: [o] }, { label: l }), [op, label]);
    if (!r?.ok) console.log(`fixture: skipped ${JSON.stringify(op).slice(0, 120)}: ${JSON.stringify(r?.error ?? r).slice(0, 160)}`);
  }
  await pause(900);
};

/** Scroll the scroller holding `sel` so it sits `offset` px below the scroller's top. */
async function scrollTo(sel, offset = 140) {
  await win.evaluate(
    ([s, o]) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`nothing matches ${s}`);
      let box = el.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!box) return;
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - o;
    },
    [sel, offset]
  );
  await pause(250);
}

/** The editor's own picker: the swatch is a button that opens it. Without it the swatch opens the system's dialog. */
const ownPicker = async (swatch) => (await win.locator(swatch).first().evaluate((el) => el.tagName)) === 'BUTTON';

/** Open the picker of `swatch`, check it, capture it over `around`, then close it with Escape. */
async function pickerShot(state, swatch, around, { themes = BOTH, before } = {}) {
  if (!(await ownPicker(swatch))) {
    skipped.push(state);
    console.log(`skip ${state}: this build's swatch opens the system's colour dialog`);
    return;
  }
  await win.locator(swatch).first().click();
  await win.locator(POP).first().waitFor({ timeout: 5000 });
  await pause(300);
  if (before) await before();
  await shot(state, [POP, around], { themes, checks: [POP] });
  await win.keyboard.press('Escape');
  await pause(250);
  if (await win.locator(POP).first().isVisible().catch(() => false)) throw new Error(`${state}: Escape did not close the picker`);
}

// ---- A populated business site, open in the editor ----
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await pause(1200);
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const colorIds = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  return (s.tokens ?? s.state.tokens?.list ?? []).filter?.((t) => t.group === 'color').map((t) => t.id) ?? [];
});
console.log('colour tokens:', colorIds.join(', ') || '(read from the panel)');

// Fixtures through the project's own operations: Accent follows Brand, one colour see-through, and an owner's colour.
await apply(
  [
    { type: 'token.set', tokenId: 'color.accent', value: { token: 'color.brand' } },
    { type: 'token.set', tokenId: 'color.muted', value: 'rgb(28 39 66 / 0.55)' },
    { type: 'token.create', group: 'color', label: 'Harbour teal', value: '#1f7a74' }
  ],
  'Design capture: colours'
);

// ---- Site styles → Colors: the swatches as they sit in their rows ----
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const jump = win.locator(`${STYLES} .insp-jump button`, { hasText: 'Colors' });
if (await jump.count()) await jump.first().click();
await pause(500);
const rowSel = (id) => `${STYLES} .ss-color:not(.compact)[data-token-id="${id}"]`;
const swatchOf = (id) => `${rowSel(id)} .color-pick`;
await win.locator(rowSel('color.brand')).first().waitFor({ timeout: 15000 });
await scrollTo(rowSel('color.brand'));
// The swatch in each state it has: plain (Brand), white (Text on brand color), followed (Accent), see-through (Muted).
await shot('ss-swatches', [rowSel('color.brand'), rowSel('color.accent')], { checks: [swatchOf('color.brand'), swatchOf('color.accent')], pad: 6 });
await scrollTo(rowSel('color.muted'), 200);
await shot('ss-alpha', [rowSel('color.muted')], { checks: [swatchOf('color.muted')], pad: 8 });

// ---- The picker open: a plain colour, a see-through one, and one that follows another ----
await pickerShot('pop-brand', swatchOf('color.brand'), rowSel('color.brand'));
await scrollTo(rowSel('color.muted'));
await pickerShot('pop-alpha', swatchOf('color.muted'), rowSel('color.muted'), { themes: LIGHT });
await scrollTo(rowSel('color.accent'));
await pickerShot('pop-linked', swatchOf('color.accent'), rowSel('color.accent'));
// Keyboard: the picker reached and worked from the swatch with the keyboard alone, focus ring on the colour area.
if (await ownPicker(swatchOf('color.brand'))) {
  await scrollTo(rowSel('color.brand'));
  await win.locator(swatchOf('color.brand')).first().focus();
  await win.keyboard.press('Enter');
  await win.locator(POP).first().waitFor({ timeout: 5000 });
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowUp');
  await pause(500);
  await shot('pop-keyboard', [POP, rowSel('color.brand')], { themes: LIGHT, checks: [POP] });
  await win.keyboard.press('Escape');
  await pause(300);
  const back = await win.evaluate((s) => document.activeElement === document.querySelector(s), swatchOf('color.brand'));
  if (!back) throw new Error('pop-keyboard: Escape did not return focus to the swatch');
  // Shift+Tab from the colour area (the first stop) leaves the picker for its swatch, not for the end of the app.
  await win.keyboard.press('Enter');
  await win.locator(POP).first().waitFor({ timeout: 5000 });
  await pause(200);
  await win.keyboard.press('Shift+Tab');
  await pause(300);
  const tabbedBack = await win.evaluate((s) => document.activeElement === document.querySelector(s) && !document.querySelector('.color-pop'), swatchOf('color.brand'));
  if (!tabbedBack) throw new Error('pop-keyboard: Shift+Tab out of the picker did not return to the swatch');
  // Tab forward from the site colours (the last stop), from the first and from one chosen with the arrows, does the same.
  for (const arrows of [0, 2]) {
    await win.keyboard.press('Enter');
    await win.locator(POP).first().waitFor({ timeout: 5000 });
    await pause(200);
    for (let i = 0; i < 12 && !(await win.evaluate(() => document.activeElement?.classList.contains('color-pop-preset'))); i++) await win.keyboard.press('Tab');
    for (let i = 0; i < arrows; i++) await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Tab');
    await pause(300);
    const forward = await win.evaluate((s) => document.activeElement === document.querySelector(s) && !document.querySelector('.color-pop'), swatchOf('color.brand'));
    if (!forward) throw new Error(`pop-keyboard: Tab out of the site colours (${arrows} down) did not return to the swatch`);
  }
} else skipped.push('pop-keyboard');

// ---- Your styles: the owner's own colour ----
const own = `${STYLES} .ss-custom-row`;
{
  const head = win.locator(`${STYLES} .section-head`, { hasText: 'Your styles' }).first();
  if ((await head.count()) && (await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await win.locator(own).first().waitFor({ timeout: 5000 }).catch(() => {});
}
if (await win.locator(own).count()) {
  await scrollTo(own, 200);
  await shot('custom-row', [own], { themes: LIGHT, pad: 8 });
  await pickerShot('pop-custom', `${own} .color-pick`, own, { themes: LIGHT });
} else console.log('skip custom-row: no colour of the owner\'s own showed in Your styles');

// ---- Inspector → Style: the colour controls on the hero heading ----
const s = await snapshot();
const page = s.state.pages[s.state.site.homePageId];
const hero = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'hero.split');
if (!hero) throw new Error('the business starter has no split hero');
const setStyle = (partId, property, value) => ({ type: 'node.setStyle', owner: { kind: 'page', id: page.id }, nodeId: hero.id, partId, scope: 'base', property, value });
await apply([setStyle('heading', 'color', 'rgb(209 65 49 / 0.8)'), setStyle('root', 'color', 'rgb(209 65 49 / 0.8)'), setStyle('root', 'background', { token: 'color.surface' })], 'Design capture: hero colours');
await frame.locator('h1').first().click();
await openInspector(win);
const head = win.locator(`${INSPECT} .section-head`, { hasText: 'Style' }).first();
await head.waitFor({ timeout: 15000 });
if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
await win.locator(`${INSPECT} .style-scope`).first().waitFor({ timeout: 15000 });
const colorRow = `${INSPECT} .style-row[data-prop="color"]`;
await win.locator(colorRow).first().waitFor({ timeout: 15000 });
await scrollTo(colorRow, 200);
await pause(400);
await shot('style-color', [colorRow], { pad: 10 });
await pickerShot('pop-style', `${colorRow} .color-pick`, colorRow);

if (errors.length) throw new Error(`page errors during capture:\n${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
if (files.length < written.length) throw new Error(`wrote ${written.length} captures but ${OUT} holds ${files.length}`);
console.log(`DONE ${written.length} captures in ${OUT}${skipped.length ? `; skipped (system dialog): ${skipped.join(', ')}` : ''}`);
await app.close();
rmSync(WORK, { recursive: true, force: true });
