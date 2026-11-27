// Design capture for the shared checkbox and radio (primitives.css): every state of both, on each surface the app
// puts them on (a panel, a dialog's raised body, an option card, the dark notice), plus the switch beside them.
// The specimen is built from the app's own classes inside the real editor, so it shows exactly what every
// <input type="checkbox"> and <input type="radio"> in the app draws. Then the real surfaces that hold one. Drives
// the real (built) app and writes padded crops at 2x, in light, dark and forced colours. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/checks-radios.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('checks and radios capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'checks-radios');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-checks-')));
const BOTH = ['light', 'dark'];
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: W, height: H });
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  if (theme === 'forced') await win.emulateMedia({ colorScheme: 'light', forcedColors: 'active' });
  else await win.emulateMedia({ colorScheme: theme, forcedColors: 'none' });
  await pause(250);
};

async function clipOf(sels, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sel of [sels].flat()) {
    const b = await win.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} has no box`);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  const x = Math.max(0, Math.floor(x0 - pad)), y = Math.max(0, Math.floor(y0 - pad));
  return { x, y, width: Math.min(W, Math.ceil(x1 + pad)) - x, height: Math.min(H, Math.ceil(y1 + pad)) - y, scale: 1 };
}

/** Capture `state` per theme, clipped to `area` padded by `pad`; `check` must be visible. `before` runs per theme. */
async function shot(state, check, { area = check, pad = 16, themes = BOTH, before } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    else await win.mouse.move(W - 4, H - 4);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: await clipOf(area, pad) });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

// ---- A business site in the editor ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1200);

// ---- The specimen: every state, on every surface, from the app's own classes ----
await win.evaluate(() => {
  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const box = (label, attrs = '', type = 'checkbox', name = '') => `<label class="cr-row"><input type="${type}" ${name ? `name="${name}"` : ''} ${attrs}><span>${label}</span></label>`;
  const states = (n) => `
    <div class="cr-col">
      <b class="cr-h">Checkbox</b>
      ${box('Off')}
      ${box('On', 'checked')}
      ${box('Some of them', 'data-mixed')}
      ${box('Off, unavailable', 'disabled')}
      ${box('On, unavailable', 'checked disabled')}
      ${box('Some, unavailable', 'data-mixed disabled')}
      ${box('Needs an answer', 'aria-invalid="true"')}
      ${box('Needs an answer, on', 'aria-invalid="true" checked')}
      ${box('Hovered', 'data-hover')}
      ${box('On, hovered', 'data-hover-on checked')}
      ${box('Focused from the keyboard', `data-focus="${n}" checked`)}
    </div>
    <div class="cr-col">
      <b class="cr-h">Radio</b>
      ${box('Off', '', 'radio', `r${n}`)}
      ${box('On', 'checked', 'radio', `r${n}`)}
      ${box('Off, unavailable', 'disabled', 'radio', `d${n}`)}
      ${box('On, unavailable', 'checked disabled', 'radio', `d${n}`)}
      ${box('Focused from the keyboard', `data-focus-radio="${n}" checked`, 'radio', `f${n}`)}
      <b class="cr-h">Wrapping label</b>
      <label class="cr-row" style="max-width:190px"><input type="checkbox" checked><span>Leave out the entry whose page it is shown on</span></label>
      <b class="cr-h">Switch</b>
      <div class="cr-row"><button type="button" class="switch" role="switch" aria-checked="false" aria-label="Off"></button><span>Off</span></div>
      <div class="cr-row"><button type="button" class="switch" role="switch" aria-checked="true" aria-label="On"></button><span>On</span></div>
    </div>`;
  const spec = el(`
    <div id="cr-spec" style="position:fixed; inset:24px auto auto 24px; z-index:99999; display:flex; gap:16px; padding:16px; border-radius:var(--r-lg); background:var(--bg); align-items:flex-start; font-size:13px; line-height:1.45; color:var(--text)">
      <style>
        #cr-spec .cr-surface { display:flex; gap:24px; padding:16px; border-radius:var(--r-md); box-shadow:var(--card-ring) }
        #cr-spec .cr-col { display:flex; flex-direction:column; gap:6px; min-width:170px }
        #cr-spec .cr-h { font-size:11px; font-weight:600; color:var(--text-3); margin-top:6px }
        #cr-spec .cr-row { display:flex; align-items:flex-start; gap:8px }
        #cr-spec .cr-cap { font-size:11px; color:var(--text-3); margin-bottom:8px; display:block }
      </style>
      <div>
        <span class="cr-cap">On a panel (--panel)</span>
        <div id="cr-panel" class="cr-surface" style="background:var(--panel)">${states(1)}</div>
      <div style="margin-top:16px">
        <span class="cr-cap">Consumer rows (their own classes), narrow</span>
        <div id="cr-rows" class="cr-surface" style="background:var(--panel); flex-direction:column; gap:4px; width:330px">
          <div class="post-terms-list" style="grid-template-columns:1fr 1fr"><label class="post-term"><input type="checkbox" checked><span>Kiln opening and studio firing days</span></label><label class="post-term"><input type="checkbox"><span>Glazes</span></label></div>
          <div style="max-width:200px; display:flex; flex-direction:column"><label class="cq-check"><input type="checkbox" checked> Leave out the entry whose page it is on</label><label class="cq-check"><input type="checkbox"> Featured</label></div>
          <fieldset class="slot-kinds" style="max-width:240px"><label><input type="checkbox" checked><span>Text and headings</span></label><label><input type="checkbox"><span>Images</span></label></fieldset>
          <label class="content-check" style="max-width:220px"><input type="checkbox" checked> A page for each entry, and one listing them all</label>
          <ul class="entry-refs" style="max-width:220px"><li><label><input type="checkbox" checked> Getting started with wheel throwing</label></li><li><label><input type="checkbox"> Raku</label></li></ul>
        </div>
      </div>
      </div>
      <div>
        <span class="cr-cap">In a dialog (--raised)</span>
        <div id="cr-raised" class="cr-surface" style="background:var(--raised)">${states(2)}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:16px; width:330px">
        <div>
          <span class="cr-cap">Option cards (Delete page, Remove font)</span>
          <div id="cr-cards" class="cr-surface" style="background:var(--raised); flex-direction:column; gap:8px">
            <div class="page-dialog-option"><label><input type="radio" name="cards" checked> Delete the page and its sections</label><p class="page-dialog-option-note">The page and its 4 sections go. Undo brings them back.</p></div>
            <div class="page-dialog-option"><label><input type="radio" name="cards"> Keep the sections on another page</label><p class="page-dialog-option-note">They move to the end of Home.</p></div>
            <div class="page-dialog-option"><label><input type="radio" name="cards" disabled> Merge into its parent</label><p class="page-dialog-option-note">This page has no parent.</p></div>
            <div class="page-dialog-option"><label><input type="checkbox" checked> Keep it in the menu</label><p class="page-dialog-option-note">Visitors still find it under About.</p></div>
          </div>
        </div>
        <div>
          <span class="cr-cap">The notice (rename offer)</span>
          <div class="toasts" id="cr-toasts" style="position:static; inset:auto; transform:none; width:330px; max-width:330px; pointer-events:auto; display:block">
            <div class="toast rename-offer" style="position:static; width:330px; max-width:330px">
              <div class="grow rename-offer-body">
                <span class="rename-offer-title">Update labels to “Our work”?</span>
                <ul class="rename-offer-list">
                  <li><label><input type="checkbox" checked> Header menu</label></li>
                  <li><label><input type="checkbox" data-mixed> Buttons (3)</label></li>
                  <li><label><input type="checkbox"> Footer link</label></li>
                  <li><label><input type="checkbox" disabled> Card title</label></li>
                  <li><label><input type="checkbox" checked disabled> Image caption</label></li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`);
  document.body.append(spec);
  for (const i of spec.querySelectorAll('[data-mixed]')) i.indeterminate = true;
});
await pause(300);

const hoverSpec = (sel) => async () => {
  const b = await win.locator(sel).boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
};
const focusSpec = (n) => async () => {
  await win.mouse.move(W - 4, H - 4);
  await win.keyboard.press('Shift');
  await win.evaluate((k) => document.querySelector(`#cr-spec [data-focus="${k}"]`).focus(), n);
};
// The whole specimen, with the raised surface's focus and the panel's hover.
await shot('specimen', '#cr-spec input', {
  area: '#cr-spec', pad: 12, themes: ['light', 'dark', 'forced'],
  before: async () => { await focusSpec(2)(); await hoverSpec('#cr-panel [data-hover]')(); }
});
// Close crops, so 1px edges and the tick read at size.
await shot('specimen-panel', '#cr-panel input', { area: '#cr-panel', pad: 4, before: async () => { await focusSpec(1)(); await hoverSpec('#cr-panel [data-hover]')(); } });
await shot('specimen-hover-on', '#cr-raised input', { area: '#cr-raised', pad: 4, before: hoverSpec('#cr-raised [data-hover-on]') });
await shot('specimen-cards-notice', '#cr-cards input', { area: ['#cr-cards', '#cr-toasts'], pad: 8 });
await shot('specimen-rows', '#cr-rows input', { area: '#cr-rows', pad: 8 });
// Keyboard focus on a radio, and on a notice's checkbox (the notice's own focus colour), in every theme.
await shot('specimen-focus', '#cr-raised input', {
  area: ['#cr-raised', '#cr-toasts'], pad: 8, themes: ['light', 'dark', 'forced'],
  before: async () => { await win.mouse.move(W - 4, H - 4); await win.keyboard.press('Shift'); await win.evaluate(() => document.querySelector('#cr-raised [data-focus-radio]').focus()); }
});
await shot('specimen-notice-focus', '#cr-toasts input', {
  area: '#cr-toasts', pad: 8, themes: ['light', 'dark', 'forced'],
  before: async () => { await win.mouse.move(W - 4, H - 4); await win.keyboard.press('Shift'); await win.evaluate(() => document.querySelectorAll('#cr-toasts input')[2].focus()); }
});
await win.evaluate(() => document.getElementById('cr-spec')?.remove());

// ---- Real surfaces ----
// The SEO view's "Problems only".
await win.locator('.rail [data-rail="seo"]').click();
await win.locator('.seo-view').waitFor();
await pause(800);
const problems = win.locator('.seo-view label:has(input[type="checkbox"])').first();
await problems.waitFor();
await shot('seo-problems-only', '.seo-view label:has(input[type="checkbox"])', { pad: 40 });
await win.keyboard.press('Escape');
await pause(400);

// Delete page: the option cards' radios, in a dialog.
const pagesRail = win.locator('.rail [aria-label="Pages"]');
if ((await pagesRail.getAttribute('aria-pressed')) !== 'true') await pagesRail.click();
await pause(500);
const row = win.locator('.pages-list [role="treeitem"], .page-row').filter({ hasText: /About|Services|Contact/ }).first();
await row.click({ button: 'right' });
await pause(300);
const del = win.getByRole('menuitem', { name: /Delete/ }).first();
if (await del.isVisible().catch(() => false)) {
  await del.click();
  await win.locator('.modal').waitFor();
  await pause(500);
  if (await win.locator('.modal input[type="radio"], .modal input[type="checkbox"]').first().isVisible().catch(() => false)) {
    await shot('delete-page', '.modal input', { area: '.modal', pad: 0 });
  } else console.log('delete page: no choice in this dialog, skipped');
  await win.keyboard.press('Escape');
  await pause(300);
} else {
  await win.keyboard.press('Escape');
  console.log('delete page: no Delete in the page menu, skipped');
}

// Site styles' theme list: one radio per theme, the picked one in its raised row.
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const change = win.locator('.ss-theme-change').first();
await change.scrollIntoViewIfNeeded();
await change.click();
await win.locator('.ss-theme-option').first().waitFor();
await pause(500);
await shot('site-styles-themes', '.ss-theme-option input', { area: '.ss-theme-options', pad: 8 });
await shot('site-styles-themes-focus', '.ss-theme-option:has(input:focus-visible)', {
  area: '.ss-theme-options', pad: 8, themes: ['light'],
  before: async () => { await win.mouse.move(W - 4, H - 4); await win.keyboard.press('Shift'); await win.locator('.ss-theme-option input:checked').focus(); }
});

// ---- Verify ----
await app.close();
rmSync(WORK, { recursive: true, force: true });
if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
for (const p of written) if (!files.includes(p.split('/').pop())) throw new Error(`missing ${p}`);
console.log(`checks and radios capture: ${written.length} images in ${OUT}`);
