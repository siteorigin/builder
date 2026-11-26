// Design capture for imported fonts: the Assets panel's Fonts tab (one family's files under it), the Remove font
// dialog in each of its cases, and the font select in Site styles. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/asset-fonts.mjs
//
// The fonts go through the app's own import seam (project.importAssets with file paths) and the site styles through
// project.apply, so families, usage and samples are the real ones. Each capture is checked on screen after it
// settles; a state that did not render throws instead of writing a plausible-looking wrong image. Files are named
// `fonts-{state}--{theme}.png`: list states are the sidebar, dialog states the dialog, `fonts-select` the dock.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('asset fonts capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'asset-fonts');
mkdirSync(OUT, { recursive: true });
const THEMES = ['light', 'dark'];

const { WORK, cleanup } = scratch('design-fonts');
// Tall, so the whole list of files shows in one sidebar capture.
const { app, win, errors } = await launch(WORK, {}, { viewport: { width: 1440, height: 1240 } });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await createProject(win, { name: 'Type Specimen', parentDir: join(WORK, 'sites'), starter: 'blank' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const panel = win.locator('aside.side-panel');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
/** Capture a state; `check` must be visible at the moment of capture. `el` is what is captured (the sidebar by default). */
async function shot(state, check, { themes = THEMES, el = panel, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keep) await win.mouse.move(900, 600);
    await pause(250);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (see debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `fonts-${state}--${theme}.png`);
    await (typeof el === 'string' ? win.locator(el).first() : el).screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
};

// ---- Fixtures: a family of four files (two alphabets, upright and italic), a family of two, an unused one, and a
// family of two static weights (variable files marked with one weight each, through the same op the Weight select uses) ----
const files = (pkg) => resolve('node_modules/@fontsource-variable', pkg, 'files');
const paths = [
  join(files('lora'), 'lora-latin-wght-normal.woff2'),
  join(files('lora'), 'lora-latin-wght-italic.woff2'),
  join(files('lora'), 'lora-cyrillic-wght-normal.woff2'),
  join(files('lora'), 'lora-cyrillic-wght-italic.woff2'),
  join(files('plus-jakarta-sans'), 'plus-jakarta-sans-latin-wght-normal.woff2'),
  join(files('plus-jakarta-sans'), 'plus-jakarta-sans-latin-wght-italic.woff2'),
  join(files('space-grotesk'), 'space-grotesk-latin-wght-normal.woff2'),
  join(files('dm-sans'), 'dm-sans-latin-wght-normal.woff2'),
  join(files('dm-sans'), 'dm-sans-latin-wght-italic.woff2')
];
const imported = await win.evaluate((p) => window.builder.project.importAssets(p, 'font'), paths);
if (!imported.ok || imported.assetIds.length !== paths.length) throw new Error(`the fonts did not import: ${imported.message}`);
await apply(
  [
    { type: 'token.set', tokenId: 'font.display', value: "'Lora', system-ui, sans-serif" },
    { type: 'token.set', tokenId: 'font.body', value: "'Plus Jakarta Sans', system-ui, sans-serif" }
  ],
  'Choose fonts'
);
const assets = (await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets;
const idOf = (file) => imported.assetIds.find((id) => assets[id].file.includes(file));
await apply(
  [
    { type: 'asset.update', assetId: idOf('dm-sans-latin-wght-normal'), font: { family: 'DM Sans', weight: '400', style: 'normal' } },
    { type: 'asset.update', assetId: idOf('dm-sans-latin-wght-italic'), font: { family: 'DM Sans', weight: '700', style: 'italic' } }
  ],
  'Static DM Sans'
);
const sans = idOf('plus-jakarta-sans-latin-wght-normal');
const sansItalic = idOf('plus-jakarta-sans-latin-wght-italic');
const loraCyrillic = idOf('lora-cyrillic-wght-normal');
const row = (id) => win.locator(`[data-font="${id}"]`);
const removeButton = (id) => row(id).getByRole('button', { name: /^Remove / });
const dialog = '[data-testid="remove-font-dialog"]';
const modal = '.modal';

// ---- The Fonts tab ----
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await panel.getByRole('tab', { name: /^Fonts/ }).click();
await win.locator('.font-family').first().waitFor({ timeout: 20000 });
// Every sample drawn, so no capture shows "Loading preview…".
await win.waitForFunction((n) => document.querySelectorAll('[data-font-sample]').length >= n, paths.length, { timeout: 30000 });
await win.evaluate(() => document.fonts.ready);
await pause(500);
// Every family closed: the inventory of families, whether each is used and where.
await shot('list', '.font-family');
const openFamily = async (name) => {
  await win.locator(`.font-family[data-font-family="${name}"] .font-family-toggle`).click();
  await win.locator(`.font-family[data-font-family="${name}"] [data-font]`).first().waitFor();
  await pause(300);
};
// A family of static weights and a variable family of four files, open.
await openFamily('DM Sans');
await openFamily('Lora');
await shot('list-open', '[data-font]');
// Renaming a family keeps its card open and focus in it: committed with Tab, focus goes on to its first file.
// (Enter commits by leaving the field, as every name field in the app does.)
const nameField = win.locator('.font-family[data-font-family="DM Sans"] .font-family-name input');
await nameField.fill('DM Sans Text');
await nameField.press('Tab');
await win.locator('.font-family[data-font-family="DM Sans Text"][data-open]').waitFor({ timeout: 10000 });
if (!(await win.evaluate(() => document.activeElement?.closest('.font-family')?.getAttribute('data-font-family')))?.startsWith('DM Sans Text'))
  throw new Error('focus left the renamed family');
await win.evaluate(() => document.activeElement?.blur());

const separator = win.getByRole('separator', { name: 'Resize sidebar' });
const resize = async (key, times) => {
  await separator.focus();
  for (let i = 0; i < times; i++) await win.keyboard.press(key);
  await pause(300);
};
const sidebarWidth = () => panel.evaluate((el) => el.getBoundingClientRect().width);
// Down to the sidebar's minimum (200px), then out to its maximum (420px), then back to the default.
await resize('ArrowLeft', 20);
if ((await sidebarWidth()) > 205) throw new Error(`the sidebar did not narrow: ${await sidebarWidth()}`);
await shot('list-narrow', '[data-font]', { themes: ['light'], keep: true });
await win.locator('.font-family[data-font-family="Lora"]').scrollIntoViewIfNeeded();
await shot('list-narrow-lora', '[data-font]', { themes: ['light'], keep: true });
await win.locator('.side-panel-view:not([hidden]) .panel-body').evaluate((el) => el.scrollTo(0, 0));
await resize('ArrowRight', 60);
if ((await sidebarWidth()) < 415) throw new Error(`the sidebar did not widen: ${await sidebarWidth()}`);
await shot('list-wide', '[data-font]', { themes: ['light'], keep: true });
await resize('ArrowLeft', 20);
await separator.blur();
await openFamily('Plus Jakarta Sans');

// ---- The Remove font dialog ----
// A family with another upright file left: what drops back to a fallback, nothing chosen yet.
await removeButton(loraCyrillic).click();
await win.locator(dialog).waitFor();
await win.waitForFunction(() => /fallback font/.test(document.querySelector('[data-testid="remove-font-dialog"]')?.textContent ?? ''), null, { timeout: 15000 });
await shot('remove-keep', dialog, { el: modal });
await win.keyboard.press('Escape');
await win.locator(dialog).waitFor({ state: 'detached' });

// Only an italic file would be left: body text would turn italic. Then the replacement chosen.
await removeButton(sans).click();
await win.locator(dialog).waitFor();
await shot('remove-italic', dialog, { el: modal, themes: ['light'] });
await win.locator(dialog).getByRole('radio', { name: 'Another font' }).check();
await win.locator(dialog).getByLabel('Font to use instead').waitFor();
await shot('remove-replace', '.font-remove-replacement', { el: modal });
await win.locator(dialog).getByLabel('Font to use instead').selectOption({ label: 'Lora' });
await pause(200);
await shot('remove-replace-chosen', '.font-remove-replacement', { el: modal, themes: ['light'] });
await win.keyboard.press('Escape');
await win.locator(dialog).waitFor({ state: 'detached' });

// The last file of a family the site uses.
await apply([{ type: 'asset.remove', assetId: sansItalic, fontUses: 'keep' }], 'Remove the italic');
await row(sansItalic).waitFor({ state: 'detached' });
await removeButton(sans).click();
await win.locator(dialog).waitFor();
await shot('remove-last', dialog, { el: modal, themes: ['light'] });
await win.keyboard.press('Escape');
await win.locator(dialog).waitFor({ state: 'detached' });
await win.evaluate(() => window.builder.project.undo());
await row(sansItalic).waitFor();

// ---- The font select in Site styles ----
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles [data-token-id="font.display"]').waitFor();
await win.locator('#dock-panel-styles [data-token-id="font.display"]').scrollIntoViewIfNeeded();
await pause(500);
// The group holding the site's fonts, with a row either side for context.
await shot('select', '[data-token-id="font.display"]', { el: win.locator('#dock-panel-styles [data-token-id="font.display"]').locator('xpath=..') });

if (errors.length) throw new Error(`page errors during capture:\n${errors.join('\n')}`);
const pngs = readdirSync(OUT).filter((f) => f.startsWith('fonts-') && f.endsWith('.png'));
if (pngs.length < written.length) throw new Error(`expected ${written.length} captures in ${OUT}, found ${pngs.length}`);
console.log(`wrote ${written.length} captures to ${OUT}`);
await app.close();
cleanup();
