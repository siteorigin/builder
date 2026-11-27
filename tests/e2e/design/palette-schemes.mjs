// Design capture for the top of Site styles → Colors: which palettes visitors get, which one the panel
// shows, and a palette made from the brand colour. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/palette-schemes.mjs
//
// Drives the real (built) app with a populated business project, works the controls the way an owner
// does (so what they say back is on screen), and writes `{state}--{theme}.png`: the dock alone at 2x,
// scrolled to the state. Every capture is checked on screen after it settles, and a state that did not
// render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('palette schemes capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'palette-schemes');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-palettes-')));
const THEMES = ['light', 'dark'];
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;
const SCHEMES = `${PANEL} .ss-schemes`;
const HARMONY = `${PANEL} .ss-harmony`;

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
const scrollToEl = async (sel, offset = 150) => {
  const top = await win.evaluate(([s, scr, o]) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`nothing matches ${s}`);
    const box = document.querySelector(scr);
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - o;
  }, [sel, SCROLLER, offset]);
  await win.evaluate(([scr, t]) => (document.querySelector(scr).scrollTop = t), [SCROLLER, top]);
};

/** Capture the dock per theme, scrolled to `at`, once `check` is on screen. */
async function shot(state, check, { themes = THEMES, at = SCHEMES, offset } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await scrollToEl(at, offset);
    await win.mouse.move(2, 450);
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

const apply = async (operations, label) => {
  const r = await win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(900);
};

/** Choose what visitors see: one palette, or light and dark chosen by the device or by a header switch. */
const MODE_LABELS = { single: ['One palette'], system: ['Light and dark', 'Their device'], toggle: ['Light and dark', 'A header switch'] };
async function chooseMode(mode) {
  for (const label of MODE_LABELS[mode]) {
    const option = win.locator(`${SCHEMES} [role="radio"]`, { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
    await option.waitFor();
    if ((await option.getAttribute('aria-checked')) !== 'true') await option.click();
    await pause(900);
  }
}
const choosePalette = async (name) => {
  await win.locator(`${SCHEMES} button`, { hasText: new RegExp(`^\\s*${name}( colors)?\\s*$`) }).first().click();
  await pause(600);
};
const chooseMood = async (name) => {
  await win.locator(`${HARMONY} button`, { hasText: new RegExp(`^\\s*${name}\\s*$`) }).first().click();
  await pause(400);
};

// ---- A populated business site, open in the editor, at Site styles → Colors ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const colors = win.locator(`${PANEL} .insp-jump button`, { hasText: 'Colors' });
if (await colors.count()) await colors.first().click();
await pause(500);

// ---- One palette, as most sites start: the palette from brand previewing its first mood ----
await shot('single', HARMONY);
await shot('single-harmony', `${HARMONY} .ss-harmony-chips`, { at: HARMONY, offset: 110 });

// ---- A pale brand no background can carry: another mood, the brand made darker, and why ----
await apply([{ type: 'token.set', tokenId: 'color.brand', value: '#f4d35e' }], 'Design capture: pale brand');
await chooseMood('Warm');
await shot('adjusted', HARMONY, { at: HARMONY, offset: 110 });
// The site's own verdict goes to the first pair that is hard to read, opened at its contrast details.
await win.locator(`${SCHEMES} .ss-verdict.fail .link-btn`).first().click();
await pause(700);
if (!(await win.evaluate(() => !!document.activeElement?.closest('.ss-contrast-block')))) throw new Error('"Show the first" did not land on contrast details');
await shot('jump', `${PANEL} .ss-color.open .ss-contrast-block`, { themes: ['light'], at: `${PANEL} .ss-color.open`, offset: 160 });

// ---- The palette used: what it says, and the button once the palette is in use ----
await apply([{ type: 'token.set', tokenId: 'color.brand', value: '#2b5d8a' }], 'Design capture: readable brand');
await chooseMood('Tinted');
await win.locator(`${HARMONY} .ss-harmony-apply button`).first().click();
await pause(1000);
await shot('in-use', HARMONY, { at: HARMONY, offset: 110 });

// ---- Light and dark with a switch: just turned on, then the dark palette shown ----
await chooseMode('toggle');
// What turning it on says: the toast at the foot of the window, with its Undo.
{
  const t = win.locator('.toast').first();
  if (!(await t.isVisible().catch(() => false))) throw new Error('turning dark on showed no toast');
  const b = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...b, scale: 1 } });
  const path = join(OUT, 'toggle-on-toast--light.png');
  writeFileSync(path, Buffer.from(data, 'base64'));
  written.push(path);
  console.log('wrote', path);
}
await shot('toggle-on', `${SCHEMES} :is(button, [role="radio"])`, { offset: 150 });
await choosePalette('Dark');
await shot('toggle-dark', `${SCHEMES} :is(button, [role="radio"])`, { offset: 150 });
// The colour rows below, which belong to the palette shown.
await shot('dark-rows', `${PANEL} .ss-color`, { at: `${SCHEMES} ~ .ss-group:not(.ss-harmony)`, offset: 200 });

// ---- Light and dark from the visitor's device, the light palette shown with the palette from brand ----
await choosePalette('Light');
await chooseMode('system');
await shot('system-light', HARMONY, { offset: 150 });
// A mood the site does not use, in a two-palette site: what using it does to the light colors, and to the dark ones.
await chooseMood('Warm');
await shot('dual-apply', `${HARMONY} .ss-harmony-chips`, { at: HARMONY, offset: 110 });
await chooseMood('Tinted');

// ---- A dark palette with a pair that fails, seen from Light: its verdict offers to show it ----
await apply([{ type: 'token.set', tokenId: 'color.text', value: '#1a2230', scheme: 'dark' }], 'Design capture: unreadable dark text');
await shot('dark-fails', `${SCHEMES} .ss-verdict.fail`, { offset: 150 });
await apply([{ type: 'token.setColorScheme', mode: 'system', regenerate: true }], 'Design capture: remake dark colors');

// ---- The narrowest dock ----
await win.evaluate(() => document.activeElement?.blur());
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (box) {
  await win.mouse.move(box.x + box.width / 2, box.y + 200);
  await win.mouse.down();
  await win.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await win.mouse.up();
  await pause(500);
}
await shot('narrow', HARMONY, { themes: ['light'], offset: 150 });
await shot('narrow-harmony', `${HARMONY} .ss-harmony-chips`, { themes: ['light'], at: HARMONY, offset: 110 });
await apply([{ type: 'token.set', tokenId: 'color.text', value: '#1a2230', scheme: 'dark' }], 'Design capture: unreadable dark text');
await shot('narrow-dark-fails', `${SCHEMES} .ss-verdict.fail`, { themes: ['light'], offset: 150 });
await apply([{ type: 'token.setColorScheme', mode: 'system', regenerate: true }], 'Design capture: remake dark colors');
await choosePalette('Dark');
await shot('narrow-dark', `${SCHEMES} :is(button, [role="radio"])`, { themes: ['light'], offset: 150 });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`palette schemes capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
