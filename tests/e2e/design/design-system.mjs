// Design capture for the shared design system: buttons, badges, inputs, focus, segmented controls, dialogs, menus,
// toasts and field errors, as a specimen sheet and on the real surfaces that use them. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/design-system.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`, plus `behaviour.json` with what the dismissal and
// Undo probes saw. The specimen is the app's own stylesheet on markup that matches ui.tsx. Every capture checks its
// state on screen after it settles and throws rather than writing a wrong image.
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('design system capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'design-system');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];

const { WORK, cleanup } = scratch('design-system');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const behaviour = {};

/** A box around what `selector` matches, with a margin of the window, kept inside the viewport. */
async function clipOf(selector, pad = 20) {
  const box = await win.locator(selector).last().boundingBox();
  if (!box) throw new Error(`nothing to crop for "${selector}"`);
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + pad * 2)), height: Math.min(size.height - y, Math.ceil(box.height + pad * 2)) };
}

/** Capture a state; `check` must be visible at the moment of capture, in each theme. */
async function shot(state, check, { themes = BOTH, clip = '.modal', pad = 20, keepPointer = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    if (!keepPointer) await win.mouse.move(4, 4);
    await pause(280);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const area = clip === null ? {} : { clip: typeof clip === 'string' ? await clipOf(clip, pad) : clip };
    await win.screenshot({ path, ...area });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

// ---- The specimen: every shared treatment side by side, on the app's own stylesheet ----
await win.evaluate(() => {
  const icon = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const plus = icon('<path d="M5 12h14M12 5v14"/>');
  const trash = icon('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>');
  const gear = icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>');
  const alert = icon('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>');
  const shield = icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>');
  const box = icon('<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8"/>');
  const check = icon('<path d="M20 6L9 17l-5-5"/>');
  const info = icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>');
  const x = icon('<path d="M18 6L6 18M6 6l12 12"/>');
  const group = (title, body, span = 1) => `<section style="grid-column:span ${span};display:flex;flex-direction:column;gap:10px;min-width:0"><h3 style="margin:0;font-size:11px;font-weight:600;color:var(--text-3)">${title}</h3>${body}</section>`;
  const row = (body) => `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">${body}</div>`;
  const btn = (cls, label, attrs = '') => `<button class="btn ${cls}" ${attrs}>${label}</button>`;
  const variants = [['', 'Secondary'], ['btn-primary', 'Primary'], ['btn-ghost', 'Ghost'], ['btn-danger', 'Danger'], ['btn-danger-fill', 'Delete']];
  const seg = (mode, opts, picked, full = false) =>
    `<div class="segmented${full ? ' full' : ''}" role="${mode === 'radio' ? 'radiogroup' : 'group'}" aria-label="${mode}">${opts
      .map((o, i) => (mode === 'radio' ? `<button role="radio" aria-checked="${i === picked}" tabindex="${i === picked ? 0 : -1}">${o}</button>` : `<button aria-pressed="${i === picked}">${o}</button>`))
      .join('')}</div>`;
  const field = (label, control, note = '') => `<div class="field"><label><span class="grow">${label}</span></label>${control}${note}</div>`;
  const head = (ico, title) => `<div class="modal" style="animation:none;width:100%;max-height:none;box-shadow:none"><div class="modal-head">${ico}<h2 class="grow">${title}</h2><button class="icon-btn" aria-label="Close">${x}</button></div></div>`;
  const el = document.createElement('div');
  el.id = 'ds-specimen';
  el.style.cssText = 'position:fixed;inset:0;z-index:2000;overflow:hidden;padding:22px 26px;background:var(--bg);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px 26px;align-content:start';
  el.innerHTML = [
    group('Buttons, rest', variants.map(([c, l]) => row(btn(c, l) + btn(`${c} btn-sm`, l))).join('')),
    group('Buttons, disabled', variants.map(([c, l]) => row(btn(c, l, 'disabled') + btn(`${c} btn-sm`, l, 'disabled'))).join('')),
    group(
      'Icon buttons',
      row(`<button class="icon-btn" aria-label="Rest">${gear}</button><button class="icon-btn" aria-pressed="true" aria-label="Pressed">${gear}</button><button class="icon-btn" disabled aria-label="Disabled">${gear}</button><button class="icon-btn sm" aria-label="Small">${x}</button><button class="icon-btn sm" disabled aria-label="Small disabled">${x}</button>`) +
        row(btn('', `${plus} Add`) + btn('btn-primary', `${plus} Add`) + btn('', `${trash} Remove`, 'disabled')) +
        row('<span class="kbd">⌘K</span><span class="kbd">Esc</span><span class="spinner"></span>')
    ),
    group(
      'Badges',
      row(`<span class="badge">Undone</span><span class="badge accent">Selected</span><span class="badge green">${check} Shared</span><span class="badge amber">Draft</span><span class="badge plum">${box} Component</span><span class="badge red">${alert} Broken</span>`) +
        row('<span class="switch" role="switch" aria-checked="false" style="display:inline-block"></span><span class="switch" role="switch" aria-checked="true" style="display:inline-block"></span>')
    ),
    group(
      'Inputs',
      field('Rest', '<input class="input" value="Harbour Lane Studio">') +
        field('Placeholder', '<input class="input" placeholder="Name your page">') +
        field('Keyboard focus', '<input class="input" id="ds-focus-input" value="Focused field">') +
        field('Disabled', '<input class="input" value="Not available" disabled>')
    ),
    group(
      'Errors and hints',
      field('Address', '<input class="input" value="not a server address" aria-invalid="true">', '<div class="field-error">Enter a full address, like http://localhost:1234/v1.</div>') +
        field('Page title', '<input class="input" value="">', '<div class="field-hint">Shown in the browser tab and in search results.</div>') +
        field('Layout', '<select class="select"><option>Two columns</option></select>') +
        field('Summary', '<textarea class="textarea" rows="2">A short description.</textarea>')
    ),
    group(
      'Segmented',
      row(seg('toggle', ['Folder', 'ZIP file'], 0)) +
        row(seg('radio', ['System', 'Light', 'Dark'], 1)) +
        seg('toggle', ['All 12', 'Unused 3'], 1, true) +
        row(`<div class="segmented" role="group" aria-label="focus"><button id="ds-focus-seg" aria-pressed="true">Edit</button><button aria-pressed="false">Ask</button></div>` + `<button class="btn" id="ds-focus-btn">Focus</button>`)
    ),
    group(
      'Menu',
      `<div class="menu has-lead" role="menu" style="position:static;max-width:none"><div class="menu-label">Page</div><div class="menu-item"><span class="menu-lead">${gear}</span><span class="grow">Page settings</span><span class="kbd">⌘,</span></div><div class="menu-item" data-highlighted><span class="menu-lead">${plus}</span><span class="grow">Duplicate</span></div><div class="menu-item" data-disabled aria-disabled="true"><span class="menu-lead">${box}</span><span class="grow">Move up</span></div><div class="menu-sep"></div><div class="menu-item danger"><span class="menu-lead">${trash}</span><span class="grow">Delete page…</span></div></div>`
    ),
    group('Dialog titles', `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">${head(gear, 'Settings') + head(trash.replace('<svg ', '<svg style="color:var(--red)" '), 'Delete page') + head(shield.replace('<svg ', '<svg style="color:var(--amber)" '), 'Trust this project?') + head(box.replace('<svg ', '<svg style="color:var(--plum)" '), 'Edit component')}</div>`, 2),
    group(
      'Toasts',
      `<div class="toast" style="animation:none;align-self:flex-start">${info}<span class="grow">Removed hero-interior.jpg.</span><button class="btn btn-sm btn-ghost">Undo</button></div><div class="toast success" style="animation:none;align-self:flex-start">${check}<span class="grow">Your site was exported.</span></div><div class="toast error" style="animation:none;align-self:flex-start">${alert}<span class="grow">The preview stopped. Restart it to keep editing.</span><button class="btn btn-sm btn-ghost">Restart</button></div>`,
      2
    )
  ].join('');
  document.body.appendChild(el);
});
await shot('specimen', '#ds-specimen', { clip: null });
for (const [state, id] of [['focus-input', 'ds-focus-input'], ['focus-button', 'ds-focus-btn'], ['focus-segmented', 'ds-focus-seg']]) {
  await win.keyboard.press('Shift');
  await win.locator(`#${id}`).focus();
  await shot(state, `#${id}:focus-visible`, { clip: `#${id}`, pad: 14 });
}
await win.evaluate(() => document.getElementById('ds-specimen').remove());

// ---- Welcome, and the dialogs it opens ----
await shot('welcome', '.welcome', { clip: null });
await win.locator('.welcome button', { hasText: 'New project' }).first().click();
await win.locator('.modal').waitFor();
await shot('new-project', '.modal');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

await win.locator('.welcome button', { hasText: 'Settings' }).click();
await win.locator('.modal').waitFor();
await shot('settings-general', '.modal [role="radiogroup"]');
await win.getByRole('tab', { name: 'AI assistant' }).click();
await win.locator('.modal [role="radio"]', { hasText: 'Local model' }).click();
const url = win.locator('#settings-local-url');
await url.waitFor();
const savedUrl = await url.inputValue();
await url.fill('not a server address');
await pause(300);
await shot('settings-field-error', '#settings-local-url[aria-invalid="true"]');
await url.fill(savedUrl);
await url.press('Enter');
await pause(300);
await win.locator('.modal [role="radio"]', { hasText: 'OpenAI' }).click();
await pause(300);
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- Unpacking a ZIP file, shown through the event the main process sends ----
const sendUnpacking = (value) => app.evaluate(({ BrowserWindow }, v) => BrowserWindow.getAllWindows()[0].webContents.send('projects:unpacking', v), value);
await sendUnpacking({ name: 'harbour-lane-studio.zip', dir: join(WORK, 'sites', 'harbour-lane-studio') });
const unpacking = win.getByRole('dialog', { name: /^Unpacking/ });
await unpacking.waitFor();
await shot('unpacking', '.modal .trust-path');
// A press on the backdrop must leave the work running.
await win.mouse.click(8, 8);
await pause(350);
behaviour.backdropCancelsUnpacking = (await unpacking.count()) === 0 || (await unpacking.getByRole('button', { name: /Cancelling/ }).count()) > 0;
await sendUnpacking(null);
await unpacking.waitFor({ state: 'detached' });

// ---- The editor ----
const sites = join(WORK, 'sites');
await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
await pause(1200);
await shot('editor', '.editor', { clip: null });

const pagesButton = win.locator('.rail [aria-label="Pages"]');
if ((await pagesButton.getAttribute('aria-pressed')) !== 'true') await pagesButton.click();
await pause(400);
const pageRow = (title) => win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first();
await pageRow('Home').click({ button: 'right' });
await win.locator('.menu').waitFor();
await shot('menu', '.menu [role^="menuitem"]', { clip: '.menu', pad: 28, keepPointer: true });
await win.keyboard.press('Escape');
await win.locator('.menu').waitFor({ state: 'detached' });
await pageRow('Contact').click({ button: 'right' });
await win.getByRole('menuitem', { name: /Delete page/ }).click();
await win.getByRole('dialog', { name: /Delete/ }).waitFor();
await shot('confirm-danger', '.modal .btn-danger-fill');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

await win.locator('.export-btn').click();
await win.getByRole('dialog', { name: 'Export your website' }).waitFor();
await shot('export', '.modal .segmented');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- A real Undo toast, from removing an image nothing uses ----
const fixture = join(WORK, 'design-system-fixture.svg');
writeFileSync(fixture, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#1b5e7a"/></svg>');
const imported = await win.evaluate((p) => window.builder.project.importAssets(p), [fixture]);
if (imported?.ok === false) throw new Error(`fixture import failed: ${JSON.stringify(imported)}`);
const assetsButton = win.locator('.rail [aria-label="Assets"]');
if ((await assetsButton.getAttribute('aria-pressed')) !== 'true') await assetsButton.click();
await pause(600);
const tile = win.locator('[data-asset]', { hasText: /design.system.fixture/i }).first();
const undoToast = win.locator('.toast', { hasText: 'Removed' });
const undoButton = undoToast.getByRole('button', { name: 'Undo' });
async function removeFixture() {
  await tile.waitFor();
  await tile.click();
  await win.getByRole('button', { name: 'Remove image' }).click();
  await undoToast.first().waitFor();
}
const undoRemoval = async () => {
  await undoButton.first().click();
  await tile.waitFor();
  await pause(300);
};

// Notifications are held on screen while they are photographed in both themes.
await win.evaluate(() => {
  window.__realSetTimeout = window.setTimeout;
  window.setTimeout = (fn, ms, ...rest) => window.__realSetTimeout(fn, ms === 4000 || ms === 7000 ? ms * 10 : ms, ...rest);
});
await removeFixture();
await shot('toast-undo', '.toast .btn', { clip: '.toasts', pad: 48 });
await win.locator('.export-btn').click();
await win.getByRole('dialog', { name: 'Export your website' }).waitFor();
await shot('toast-over-dialog', '.toast', { clip: null });
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await undoRemoval();
await win.evaluate(() => void (window.setTimeout = window.__realSetTimeout));

// What happens to an Undo whose notification runs out while a dialog is open.
await removeFixture();
await win.locator('.export-btn').click();
await win.getByRole('dialog', { name: 'Export your website' }).waitFor();
await pause(5200);
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await pause(350);
behaviour.undoSurvivesDialog = (await undoButton.count()) > 0 && (await undoButton.first().isVisible());
if (behaviour.undoSurvivesDialog) await undoRemoval();

await app.close();
cleanup();

writeFileSync(join(OUT, 'behaviour.json'), JSON.stringify(behaviour, null, 2));
console.log('behaviour', JSON.stringify(behaviour));
const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`design system capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
