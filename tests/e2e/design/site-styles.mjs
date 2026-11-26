// Design capture for the Site styles panel (the right dock's "Site styles" tab). Opt-in only, never part
// of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/site-styles.mjs
//
// Drives the real (built) app with a populated business project, seeds site-style changes through the
// same project:apply channel the editor uses, and writes `{state}--{theme}.png`. Panel captures are the
// dock alone at 2x; `context` is the whole window. Every capture is checked on screen after it settles,
// and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('site styles capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'site-styles');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-styles-')));
const THEMES = ['light', 'dark'];
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
// Captures at 2x, so 11px labels and swatch edges are legible to a reviewer.
const cdp = await win.context().newCDPSession(win);
const metrics = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
await metrics(1440, 900);
await win.waitForSelector('.welcome');
console.log('devicePixelRatio', await win.evaluate(() => devicePixelRatio));
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** Capture `state` per theme: the dock alone, or the whole window when `whole` is set. */
async function shot(state, check, { themes = THEMES, whole = false, before } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    await win.mouse.move(2, 450);
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

/** Capture the whole panel as consecutive screens, `{state}-01`, `{state}-02`, ... per theme. */
async function scrollShots(state, themes = THEMES) {
  const { h, c } = await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { h: el.scrollHeight, c: el.clientHeight };
  }, SCROLLER);
  const step = Math.max(200, c - 80);
  const stops = [];
  for (let t = 0; t < h - c + step; t += step) stops.push(Math.min(t, Math.max(0, h - c)));
  const unique = [...new Set(stops)];
  for (const [i, top] of unique.entries()) await shot(`${state}-${String(i + 1).padStart(2, '0')}`, PANEL, { themes, before: () => scrollTo(top) });
  await scrollTo(0);
  return unique.length;
}

/** Open every collapsed section in the panel. */
async function expandAll() {
  for (let i = 0; i < 20; i++) {
    const closed = win.locator(`${PANEL} .section-head[aria-expanded="false"]`);
    if (!(await closed.count())) break;
    await closed.first().click();
    await pause(120);
  }
}

const apply = (operations, label) => win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);

// ---- A populated business site, open in the editor ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);

// ---- Rest: as a site owner first sees it ----
await shot('context', PANEL, { whole: true });
await shot('rest', PANEL, { before: () => scrollTo(0) });

// ---- Every section open, the whole panel screen by screen ----
await expandAll();
const screens = await scrollShots('all');
console.log(`all: ${screens} screens per theme`);

// ---- Site styles changed from the theme: a brand colour, a linked colour and a heading size ----
const seeded = await apply(
  [
    { type: 'token.set', tokenId: 'color.brand', value: '#2b5d8a' },
    { type: 'token.set', tokenId: 'color.focus', value: { token: 'color.brand' } },
    { type: 'token.set', tokenId: 'text.h1', value: { size: '3rem' } },
    { type: 'token.set', tokenId: 'font.display', value: "Georgia, 'Times New Roman', serif" },
    { type: 'token.set', tokenId: 'radius.md', value: '8px' }
  ],
  'Design capture: change site styles'
);
if (!seeded?.ok) throw new Error('could not seed site style changes: ' + JSON.stringify(seeded?.error));
await pause(900);
await scrollTo(0);
await shot('changed', PANEL, { before: () => scrollTo(0) });
await scrollShots('changed-all', ['light']);

// ---- The changes reviewed, a text style open, and a linked colour's details ----
const review = win.locator(`${PANEL} button`, { hasText: /^Review/ }).first();
if (await review.count()) {
  await review.click();
  await pause(300);
  await shot('review', `${PANEL} .ss-review:not([hidden])`, { before: () => scrollTo(0) });
  await review.click();
}
const h1 = win.locator(`${PANEL} .ss-text-toggle`, { hasText: 'Heading 1' }).first();
if (await h1.count()) {
  await h1.click();
  await pause(300);
  const top = await win.evaluate(([sel, scr]) => {
    const el = document.querySelector(sel);
    const s = document.querySelector(scr);
    return el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 120;
  }, [`${PANEL} .ss-text.open`, SCROLLER]);
  await shot('text-open', `${PANEL} .ss-text.open`, { before: () => scrollTo(top) });
  await h1.click();
}
const linked = win.locator(`${PANEL} .ss-disclose[aria-label^="Keyboard focus outline"]`).first();
if (await linked.count()) {
  await linked.click();
  await pause(300);
  const top = await win.evaluate(([sel, scr]) => {
    const el = document.querySelector(sel);
    const s = document.querySelector(scr);
    return el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 200;
  }, [`${PANEL} .ss-color.open`, SCROLLER]);
  await shot('color-detail', `${PANEL} .ss-detail:not([hidden])`, { themes: ['light'], before: () => scrollTo(top) });
  await linked.click();
}

// ---- Keyboard focus on a control in the panel ----
await scrollTo(0);
await win.locator(`${PANEL} :is(button, input, select)`).first().focus();
await win.keyboard.press('Tab');
await win.keyboard.press('Shift+Tab');
await pause(200);
await shot('focus', `${PANEL} :focus-visible`, { themes: ['light'] });

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
const mustApply = async (operations, label) => {
  const r = await apply(operations, label);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(900);
};

// ---- The effect on the site: the whole window with the changes in place ----
await win.evaluate(() => document.activeElement?.blur());
await shot('changed-context', PANEL, { whole: true, themes: ['light'], before: () => scrollTo(0) });

// ---- A brand colour the button text cannot be read on: where it is set, and on the colour's own row ----
await mustApply([{ type: 'token.set', tokenId: 'color.brand', value: '#f4d35e' }], 'Design capture: low contrast brand');
await shot('contrast-fail', `${PANEL} .ss-contrast .ss-pair.fail`, { before: () => scrollToEl(`${PANEL} .ss-contrast`, 220) });
await shot('contrast-flag', `${PANEL} .ss-color .ss-flag`, { themes: ['light'], before: () => scrollToEl(`${PANEL} .ss-color:has(.ss-flag)`, 160) });
await mustApply([{ type: 'token.set', tokenId: 'color.brand', value: '#2b5d8a' }], 'Design capture: readable brand');

// ---- Your own styles: one of each common kind, a very long name, a link, and one that is in use ----
await mustApply(
  [
    { type: 'token.create', group: 'color', label: 'Sea glass', value: '#2e8b57' },
    { type: 'token.create', group: 'color', label: 'A considerably longer name for a seasonal promotion colour', value: '#c2410c' },
    { type: 'token.create', group: 'space', label: 'Card gap', value: '28px' },
    { type: 'token.create', group: 'font', label: 'Quote font', value: "Georgia, 'Times New Roman', serif" },
    { type: 'token.create', group: 'text', label: 'Callout', value: { family: { token: 'font.body' }, size: '1.25rem', weight: 500, lineHeight: '1.5', tracking: '0em' } }
  ],
  'Design capture: add your own styles'
);
await mustApply([{ type: 'token.set', tokenId: 'color.accent', value: { token: 'color.custom-sea-glass' } }], 'Design capture: use your own colour');
await win.locator(`${PANEL} .insp-jump button`, { hasText: 'Yours' }).click();
await pause(500);
await shot('yours', `${PANEL} .ss-custom-row`, { before: () => scrollToEl(`${PANEL} .ss-custom`, 110) });
const seaRow = win.locator(`${PANEL} .ss-custom-row[data-token-id="color.custom-sea-glass"]`);
if (/Not used yet/.test(await seaRow.innerText())) throw new Error('the colour meant to be in use reports no uses');
await seaRow.getByRole('button', { name: 'Remove Sea glass' }).click();
await pause(250);
await shot('yours-remove', `${PANEL} .ss-custom-row [role="group"]`, { themes: ['light'], before: () => scrollToEl(`${PANEL} .ss-custom-row[data-token-id="color.custom-sea-glass"]`, 110) });
await seaRow.getByRole('button', { name: 'Cancel' }).click();
await mustApply([{ type: 'token.set', tokenId: 'color.accent', value: null }], 'Design capture: stop using your own colour');

// ---- Another theme applied, with the changes kept: the panel and the site ----
await mustApply([{ type: 'theme.apply', themeId: 'foundation-alt' }], 'Design capture: switch theme');
await pause(1500);
await shot('theme-alt', PANEL, { themes: ['light'], before: () => scrollTo(0) });
await shot('theme-alt-context', PANEL, { whole: true, themes: ['light'], before: () => scrollTo(0) });
await mustApply([{ type: 'theme.apply', themeId: 'foundation' }], 'Design capture: switch theme back');
await pause(1000);

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
await shot('narrow', PANEL, { themes: ['light'], before: () => scrollTo(0) });

// Put the theme's values back so a rerun starts clean.
await apply(['color.brand', 'color.focus', 'text.h1', 'font.display', 'radius.md'].map((tokenId) => ({ type: 'token.set', tokenId, value: null })), 'Design capture: reset');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`site styles capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
