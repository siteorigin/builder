// Design capture for the component style controls (StyleControls.tsx inside the Inspector's Style section):
// a component, a component part and a primitive, at All sizes and at one screen size, with inherited,
// token-linked, custom and changed values. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/component-styles.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a
// state that did not render. Files are named `{state}--{theme}.png` and show the inspector panel only.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('component styles capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'component-styles');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-styles-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1400 });
await win.waitForSelector('.welcome');
await win.emulateMedia({ reducedMotion: 'reduce' });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const panel = win.locator('#dock-panel-inspect');
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** Capture the inspector in each theme; every `checks` selector must be visible inside it at that moment. */
async function shot(state, checks, { themes = THEMES, keepFocus = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(2, 1000);
    if (!keepFocus) await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await pause(300);
    for (const check of [].concat(checks)) {
      const visible = await panel.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await panel.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Open a Style section and bring it to the top of the inspector, under the sticky header. */
async function openStyle(id) {
  await win.evaluate((sid) => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: sid })), id);
  await pause(500);
}

const styleSelect = (label) => panel.locator(`select[aria-label="${label}"]`).first();
/** Choose the first Site styles token offered for a property. */
async function pickToken(label, index = 0) {
  const sel = styleSelect(label);
  const tokens = await sel.locator('optgroup[label="Site styles"] option').evaluateAll((os) => os.map((o) => o.value));
  if (!tokens.length) throw new Error(`no tokens offered for ${label}`);
  await sel.selectOption(tokens[Math.min(index, tokens.length - 1)]);
  await pause(500);
}
/** Switch a property to a custom value and type it. */
async function pickCustom(label, value) {
  await styleSelect(label).selectOption('custom');
  await pause(400);
  const input = panel.locator(`input[aria-label="${label} value"]`).first();
  await input.fill(value);
  await input.press('Enter');
  await pause(500);
}
async function scope(name) {
  await panel.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: new RegExp(`^${name}`) }).click();
  await pause(400);
}

// ---- A populated project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);

// ---- A component (the hero section) ----
await frame.locator('h1').first().click();
await pause(700);
await openStyle('style');
await shot('component-rest', ['.style-row', '[role="radiogroup"]']);

await pickToken('Vertical padding', 2);
await pickToken('Background', 1);
await pickCustom('Corner radius', '12px').catch(() => console.log('component: no Corner radius control'));
await openStyle('style');
await shot('component-changed', ['.style-row.set', '.reset-dot']);

// One screen size: base changes show through as placeholders, one phone-only change of its own.
await scope('Phone');
await pickToken('Vertical padding', 0);
await openStyle('style');
await shot('component-phone', ['.style-row.set']);
await scope('All sizes');

// The canvas at phone width while editing All sizes offers a shortcut to phone-only changes.
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await pause(1200);
await openStyle('style');
await shot('component-all-sizes-at-phone', ['.style-row'], { themes: ['light'] });
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await pause(900);

// Keyboard focus on the scope control.
await openStyle('style');
await panel.locator('[role="radiogroup"] [aria-checked="true"]').first().focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('component-scope-focus', ['[role="radiogroup"]'], { themes: ['light'], keepFocus: true });

// ---- A component part (the hero heading) ----
await frame.locator('h1').first().click();
await pause(800);
await openStyle('part-style');
await shot('part-rest', ['.style-row']);
await pickToken('Text style', 1).catch(() => console.log('part: no Text style control'));
await pickCustom('Text colour', '#8a3b12').catch(() => console.log('part: no Text colour control'));
await openStyle('part-style');
await shot('part-changed', ['.style-row.set']);

// ---- A primitive (a Stack inserted into the page) ----
await win.locator('.rail [aria-label="Insert"]').click();
await pause(400);
await win.locator('.insert-tile', { hasText: 'Stack' }).first().click();
await pause(1200);
if ((await win.locator('.rail [aria-label="Insert"]').getAttribute('aria-pressed')) === 'true') await win.locator('.rail [aria-label="Insert"]').click();
await win.locator('.dock-tab', { hasText: 'Inspector' }).click().catch(() => {});
await pause(400);
await openStyle('prim-style');
await shot('primitive-rest', ['.style-row']);
const more = panel.getByRole("button", { name: /^More style options/ });
if (await more.count()) {
  await pickToken('Gap', 1).catch(() => console.log('primitive: no Gap control'));
  await more.click();
  await pause(400);
  await openStyle('prim-style');
  await shot('primitive-all', ['.style-row.set']);
} else console.log('skipped primitive-all: no disclosure for this primitive');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`component styles capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
