// Design capture for downloadable documents: the Assets panel's Documents tab, empty, as a list, and with a document
// open in each of its cases (linked, not linked, its file missing), at the sidebar's default width and its narrowest.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/asset-documents.mjs
//
// The documents go through the app's own import seam (project.importAssets with file paths) and the links through
// project.apply, so names, details, usage and places are the real ones. A file is taken away by deleting it from the
// project folder, as the app finds it. Each capture is checked on screen after it settles; a state that did not render
// throws instead of writing a plausible-looking wrong image. Files are named `documents-{state}--{theme}.png`.
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerChoosers, createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('asset documents capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'asset-documents');
mkdirSync(OUT, { recursive: true });
const THEMES = ['light', 'dark'];

const { WORK, cleanup } = scratch('design-documents');
const { app, win, errors } = await launch(WORK, {}, { viewport: { width: 1440, height: 1000 } });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const panel = win.locator('aside.side-panel');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
/** Capture a state; `check` must be visible at the moment of capture. `keep` leaves the pointer and focus where they are. */
async function shot(state, check, { themes = THEMES, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    // Parked on the status bar, in the editor itself: over the preview iframe the editor keeps a stale :hover.
    if (!keep) await win.mouse.move(900, 994);
    await pause(250);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (see debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `documents-${state}--${theme}.png`);
    await panel.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

// ---- The empty tab ----
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await panel.getByRole('tab', { name: /^Documents/ }).click();
await win.locator('.doc-list').waitFor({ timeout: 20000 });
await pause(300);
await shot('empty', '.doc-list', { themes: ['light'] });

// ---- Fixtures: a price list linked from three places, a menu linked once, an unlinked form with a long name, a CSV,
// and a brochure whose file goes missing while a button still links to it ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const file = (name, body) => {
  const p = join(FIX, name);
  writeFileSync(p, body);
  return p;
};
const pdf = (tag) => `%PDF-1.4\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n${'0'.repeat(tag.length * 997)}`;
const paths = [
  file('Price list 2026.pdf', pdf('price list 2026 harbour lane studio')),
  file('Autumn menu.pdf', pdf('autumn menu')),
  file('Wedding and private event booking enquiry form.txt', `Booking enquiry form\n${'Name: ____\n'.repeat(4000)}`),
  file('opening-hours.csv', 'day,open,close\nMonday,9,17\nTuesday,9,17\n'),
  file('Studio brochure.pdf', pdf('studio brochure for the spring open days'))
];
const imported = await win.evaluate((p) => window.builder.project.importAssets(p, 'document'), paths);
if (!imported.ok || imported.assetIds.length !== paths.length) throw new Error(`the documents did not import: ${imported.message}`);
const snapA = await snapshot();
const docs = snapA.state.assets.assets;
const idOf = (part) => imported.assetIds.find((id) => (docs[id].originalName ?? docs[id].file).includes(part));
const priceList = idOf('Price list');
const menu = idOf('Autumn menu');
const form = idOf('booking enquiry');
const brochure = idOf('Studio brochure');
await apply([{ type: 'asset.update', assetId: form, name: 'Wedding and private event booking enquiry form' }], 'Name the form');

// Every link prop on the starter's pages (a button's link, a card's), and the header's call to action.
const linkSlots = [];
for (const page of Object.values(snapA.state.pages)) {
  for (const n of Object.values(page.nodes)) {
    if (n.kind !== 'instance') continue;
    for (const [prop, v] of Object.entries(n.props ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string' && ['page', 'url', 'anchor', 'none'].includes(v.type)) linkSlots.push({ owner: { kind: 'page', id: page.id }, nodeId: n.id, prop });
    }
  }
}
const header = Object.values(snapA.state.site.shell.header.nodes).find((n) => n.kind === 'instance' && n.props?.ctaLink);
if (linkSlots.length < 4) throw new Error(`the starter has only ${linkSlots.length} links to point at documents`);
const link = (slot, target) => ({ type: 'instance.setProp', ...slot, value: { type: 'document', target } });
await apply(
  [
    link(linkSlots[0], priceList),
    link(linkSlots[1], priceList),
    ...(header ? [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'ctaLink', value: { type: 'document', target: priceList } }] : [link(linkSlots[2], priceList)]),
    link(linkSlots[3], menu),
    link(linkSlots[header ? 2 : 4] ?? linkSlots[3], brochure)
  ],
  'Link the documents'
);
const snapB = await snapshot();
if ((snapB.assetUsage[priceList] ?? 0) < 3 || !snapB.assetUsage[brochure]) throw new Error(`links did not count: ${JSON.stringify(snapB.assetUsage)}`);
// The brochure's file leaves the project folder.
rmSync(join(snapB.dir, docs[brochure].file), { force: true });
await win.locator(`[data-document="${brochure}"] .doc-state.gone`).first().waitFor({ timeout: 30000 });
await pause(400);

const row = (id) => win.locator(`[data-document="${id}"]`);
const toggle = (id) => row(id).locator('.doc-toggle');
const openDoc = async (id) => {
  if ((await toggle(id).getAttribute('aria-expanded')) !== 'true') await toggle(id).click();
  await row(id).locator('.doc-body').waitFor();
  await pause(250);
};
const closeAll = async () => {
  for (const t of await win.locator('.doc-toggle[aria-expanded="true"]').all()) await t.click();
  await pause(200);
};

// ---- The list, every document closed ----
await shot('list', '.doc-item');

// ---- One document open in each case ----
await openDoc(priceList);
await shot('open-linked', `[data-document="${priceList}"] .doc-body`);
await closeAll();
await openDoc(form);
await shot('open-unlinked', `[data-document="${form}"] .doc-body`, { themes: ['light'] });
await closeAll();
await openDoc(brochure);
await shot('open-missing', `[data-document="${brochure}"] .doc-body`);
await closeAll();

// ---- Keyboard: focus on a row's toggle, the row open ----
await openDoc(menu);
await toggle(menu).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('open-focus', `[data-document="${menu}"] .doc-toggle:focus-visible`, { themes: ['light'], keep: true });
await win.evaluate(() => document.activeElement?.blur());
await closeAll();

// ---- The sidebar at its narrowest (200px), the linked document open ----
const separator = win.getByRole('separator', { name: 'Resize sidebar' });
await separator.focus();
for (let i = 0; i < 20; i++) await win.keyboard.press('ArrowLeft');
await separator.blur();
await pause(300);
const width = await panel.evaluate((el) => el.getBoundingClientRect().width);
if (width > 205) throw new Error(`the sidebar did not narrow: ${width}`);
await openDoc(priceList);
await shot('narrow-linked', `[data-document="${priceList}"] .doc-body`, { themes: ['light'] });
await closeAll();
await openDoc(brochure);
await shot('narrow-missing', `[data-document="${brochure}"] .doc-body`, { themes: ['light'] });

// ---- Locating the missing file from its note, by keyboard: the note goes, and focus lands on the document's row ----
await answerChoosers(app, [{ dialog: 'open', paths: [paths[4]] }]);
await row(brochure).getByRole('button', { name: /^Locate file/ }).focus();
await win.keyboard.press('Enter');
await row(brochure).locator('.doc-state.gone').waitFor({ state: 'detached', timeout: 30000 });
await win.waitForFunction((id) => document.activeElement?.closest('[data-document]')?.getAttribute('data-document') === id && document.activeElement.classList.contains('doc-toggle'), brochure, { timeout: 5000 }).catch(async () => {
  throw new Error(`focus did not return to the repaired document's row: ${await win.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`);
});

await app.close();
if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.startsWith('documents-') && f.endsWith('.png'));
if (files.length < written.length) throw new Error(`expected ${written.length} captures in ${OUT}, found ${files.length}`);
console.log(`asset documents capture: ${written.length} images in ${OUT}`);
cleanup();
