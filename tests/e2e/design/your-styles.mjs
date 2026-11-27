// Design capture for Your styles, the last section of Site styles (CustomTokens.tsx). Opt-in only, never part
// of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/your-styles.mjs
//
// Drives the real (built) app with a populated business project, adds the author's own styles through the same
// project:apply channel the editor uses, and writes `{state}--{theme}.png`: the dock alone at 2x. Every capture is
// checked on screen after it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('your styles capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'your-styles');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-yours-')));
const THEMES = ['light', 'dark'];
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;
const SECTION = `${PANEL} .ss-custom`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1000 });
// Captures at 2x, so 11px labels and swatch edges are legible to a reviewer.
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** Capture `state` per theme: the dock alone, or the whole window when `whole` is set. `hover` leaves the pointer where it is. */
async function shot(state, check, { themes = THEMES, before, hover = false, whole = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    if (!hover) await win.mouse.move(2, 450);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    // Captured through CDP so the 2x device scale holds (Playwright's own screenshot renders at 1x here).
    const b = whole ? { x: 0, y: 0, ...(await win.evaluate(() => ({ width: innerWidth, height: innerHeight }))) } : await win.locator('.dock').boundingBox();
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const scrollTo = (top) => win.evaluate(([sel, t]) => (document.querySelector(sel).scrollTop = t), [SCROLLER, top]);
/** Scroll the panel so `sel` sits `offset` pixels below its top edge, clear of the sticky header. */
const scrollToEl = async (sel, offset = 120) => {
  const top = await win.evaluate(([s, scr, o]) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`nothing matches ${s}`);
    const box = document.querySelector(scr);
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - o;
  }, [sel, SCROLLER, offset]);
  await scrollTo(top);
};
const apply = (operations, label) => win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
const mustApply = async (operations, label) => {
  const r = await apply(operations, label);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(900);
};
const openYours = async () => {
  await win.locator(`${PANEL} .insp-jump button`, { hasText: 'Yours' }).click();
  await pause(500);
};
const blur = () => win.evaluate(() => document.activeElement?.blur());

// ---- A populated business site, open in the editor ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);

// ---- None yet: the section as a new author first opens it ----
await openYours();
await blur();
await shot('empty', `${SECTION} .ss-new-style`, { before: () => scrollToEl(`${PANEL} .section:has(.ss-custom)`, 70) });

// ---- One of each common kind, a very long name, a link, and one in use ----
await mustApply(
  [
    { type: 'token.create', group: 'color', label: 'Sea glass', value: '#2e8b57' },
    { type: 'token.create', group: 'color', label: 'A considerably longer name for a seasonal promotion colour', value: '#c2410c' },
    { type: 'token.create', group: 'space', label: 'Card gap', value: '28px' },
    { type: 'token.create', group: 'radius', label: 'Soft corners', value: '14px' },
    { type: 'token.create', group: 'font', label: 'Quote font', value: "Georgia, 'Times New Roman', serif" },
    { type: 'token.create', group: 'text', label: 'Callout', value: { family: { token: 'font.body' }, size: '1.25rem', weight: 500, lineHeight: '1.5', tracking: '0em' } }
  ],
  'Design capture: add your own styles'
);
await mustApply(
  [
    { type: 'token.create', group: 'color', label: 'Button hover', value: { token: 'color.custom-sea-glass' } },
    { type: 'token.set', tokenId: 'color.accent', value: { token: 'color.custom-sea-glass' } }
  ],
  'Design capture: link and use your own colour'
);
await openYours();
await blur();
const rows = await win.locator(`${SECTION} .ss-custom-row`).count();
if (rows !== 7) throw new Error(`expected 7 of your styles, found ${rows}`);
const seaRow = win.locator(`${SECTION} .ss-custom-row[data-token-id="color.custom-sea-glass"]`);
if (/Not used/.test(await seaRow.innerText())) throw new Error('the colour meant to be in use reports no uses');

await shot('rows', `${SECTION} .ss-custom-row`, { before: () => scrollToEl(`${PANEL} .section:has(.ss-custom)`, 70) });
await shot('rows-end', `${SECTION} .ss-new-style`, { before: () => scrollToEl(`${SECTION} .ss-new-style`, 520) });

// ---- Hover on a row: what the pointer reveals ----
await shot(
  'row-hover',
  `${SECTION} .ss-custom-row`,
  {
    themes: ['light'],
    hover: true,
    before: async () => {
      await scrollToEl(`${PANEL} .section:has(.ss-custom)`, 70);
      await pause(100);
      const b = await win.locator(`${SECTION} .ss-custom-row[data-token-id="space.custom-card-gap"]`).boundingBox();
      await win.mouse.move(b.x + b.width / 2, b.y + 14);
    }
  }
);

// ---- Removing the style in use: the step that asks what takes its place ----
await seaRow.getByRole('button', { name: 'Remove Sea glass' }).click();
await pause(300);
await shot('remove-step', `${SECTION} .ss-custom-row [role="group"]`, { before: () => scrollToEl(`${SECTION} .ss-custom-row[data-token-id="color.custom-sea-glass"]`, 80) });
await seaRow.getByRole('button', { name: 'Cancel' }).click();
await pause(200);
// The step opens its row to show itself; close it again so the list is back at rest.
const toggleOf = (id) => win.locator(`${SECTION} .ss-custom-row[data-token-id="${id}"] [aria-expanded][aria-controls]`).first();
if ((await toggleOf('color.custom-sea-glass').getAttribute('aria-expanded')) === 'true') await toggleOf('color.custom-sea-glass').click();
await pause(200);

// ---- The new-style form, part filled, filled, and refusing a colour ----
const form = win.locator(`${SECTION} .ss-new-style`);
await form.getByLabel('Name').fill('Highlight');
await pause(150);
await blur();
await shot('form-partial', `${SECTION} .ss-new-style`, { themes: ['light'], before: () => scrollToEl(`${SECTION} .ss-new-style`, 300) });
await form.getByLabel('Value').fill('#f4d35e');
await pause(150);
await blur();
await shot('form-ready', `${SECTION} .ss-new-style`, { before: () => scrollToEl(`${SECTION} .ss-new-style`, 300) });
await form.getByLabel('Value').fill('seaweed');
await form.getByRole('button', { name: /Add/ }).click();
await pause(300);
await shot('form-refused', `${SECTION} .ss-new-style .field-error`, { themes: ['light'], before: () => scrollToEl(`${SECTION} .ss-new-style`, 300) });
await form.getByLabel('Value').fill('');
await form.getByLabel('Name').fill('');
await pause(150);

// ---- Keyboard focus on a row's first control ----
await scrollToEl(`${PANEL} .section:has(.ss-custom)`, 70);
await win.locator(`${SECTION} .ss-custom-row[data-token-id="space.custom-card-gap"] :is(input, button)`).first().focus();
await win.keyboard.press('Tab');
await win.keyboard.press('Shift+Tab');
await pause(200);
await shot('focus', `${PANEL} :focus-visible`, { themes: ['light'], hover: false });
await blur();

// ---- A style opened to edit: an own colour, then one that follows another ----
const rowOf = (id) => `${SECTION} .ss-custom-row[data-token-id="${id}"]`;
await toggleOf('color.custom-sea-glass').click();
await pause(250);
await blur();
await shot('open-color', `${rowOf('color.custom-sea-glass')} input.mono`, { before: () => scrollToEl(rowOf('color.custom-sea-glass'), 80) });
await toggleOf('color.custom-button-hover').click();
await pause(250);
await blur();
await shot('open-linked', `${rowOf('color.custom-button-hover')} select`, { themes: ['light'], before: () => scrollToEl(rowOf('color.custom-button-hover'), 80) });
await toggleOf('color.custom-button-hover').click();
await pause(200);

// ---- Removing an unused style at once: what answers it, with the way back ----
await win.locator(rowOf('radius.custom-soft-corners')).getByRole('button', { name: 'Remove Soft corners' }).click();
await pause(400);
await shot('removed', '.toast', { themes: ['light'], whole: true, before: () => scrollToEl(`${PANEL} .section:has(.ss-custom)`, 70) });
await win.locator('.toast').getByRole('button', { name: 'Undo' }).click();
await pause(900);
if ((await win.locator(`${SECTION} .ss-custom-row`).count()) !== 7) throw new Error('Undo did not bring the removed style back');

// ---- The narrowest dock ----
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (!box) throw new Error('no dock resizer to narrow the dock with');
await win.mouse.move(box.x + box.width / 2, box.y + 200);
await win.mouse.down();
await win.mouse.move(box.x + 400, box.y + 200, { steps: 8 });
await win.mouse.up();
await pause(500);
console.log('narrow dock width', (await win.locator('.dock').boundingBox()).width);
await shot('narrow', `${SECTION} .ss-custom-row`, { before: () => scrollToEl(`${PANEL} .section:has(.ss-custom)`, 70) });
await shot('narrow-end', `${SECTION} .ss-new-style`, { themes: ['light'], before: () => scrollToEl(`${SECTION} .ss-new-style`, 520) });
await toggleOf('font.custom-quote-font').click();
await pause(250);
await blur();
await shot('narrow-open-font', `${rowOf('font.custom-quote-font')} select`, { themes: ['light'], before: () => scrollToEl(rowOf('font.custom-quote-font'), 80) });
await toggleOf('font.custom-quote-font').click();
await pause(200);

// ---- A style just added: it lands among its kind, brought into view and marked for a moment ----
await scrollToEl(`${SECTION} .ss-new-style`, 520);
await form.getByLabel('Name').fill('Highlight');
await form.getByLabel('Value').fill('#f4d35e');
await form.getByRole('button', { name: /Add style/ }).click();
await win.locator(`${SECTION} .ss-custom-row.fresh`).waitFor({ timeout: 3000 });
await pause(500);
await shot('added', `${SECTION} .ss-custom-row.fresh`, { themes: ['light'] });

// ---- A style added where showing it would take Name out of view: named beside the form instead ----
await win.setViewportSize({ width: 1440, height: 460 });
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 460, deviceScaleFactor: 2, mobile: false });
await pause(400);
await scrollToEl(`${SECTION} .ss-new-style`, 160);
await form.getByLabel('Name').fill('Footer ink');
await form.getByLabel('Value').fill('#1c2742');
await form.getByRole('button', { name: /Add style/ }).click();
await pause(600);
await shot('added-away', `${SECTION} .ss-new-added .link-btn`, { themes: ['light'] });
await form.getByRole('button', { name: 'Show it' }).click();
await pause(900);
if (await win.locator(`${SECTION} .ss-new-added`).count()) throw new Error('Show it left its note up after showing the style');
await shot('shown', `${SECTION} .ss-custom-row.fresh`, { themes: ['light'] });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`your styles capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
