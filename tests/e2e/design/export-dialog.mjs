// Design capture for the Export dialog. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/export-dialog.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`, cropped to the dialog; `context` is the whole
// window. Builds, failures, conflicts and the recent exports are all real, so the dialog shows what the export
// actually said. Every capture checks its state on screen after it settles and throws rather than writing a wrong
// image.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, withTimeout } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('export dialog capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'export-dialog');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
// A real build can take minutes while the machine is busy.
const BUILD_MS = 600000;

const { WORK, cleanup } = scratch('design-export');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: true }));
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const modal = win.getByRole('dialog', { name: 'Export your website' });
const websiteButton = modal.getByRole('button', { name: /Website files, ready to upload/ });

/** The dialog with a margin of the window around it, so its edge and shadow read. */
async function modalClip() {
  const box = await win.locator('.modal').boundingBox();
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 16));
  const y = Math.max(0, Math.floor(box.y - 16));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 32)), height: Math.min(size.height - y, Math.ceil(box.height + 32)) };
}

/** Capture a state; `check` must be visible at the moment of capture, in each theme. */
async function shot(state, check, themes = BOTH, { full = false, keepPointer = false, reveal = false } = {}) {
  // `reveal` scrolls the checked element to the top of the dialog body, for a state below the dialog's first screen.
  if (reveal) await win.locator(check).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    if (!keepPointer) await win.mouse.move(4, 4);
    await pause(260);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await modalClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

async function openDialog() {
  await win.locator('.export-btn').click();
  await modal.waitFor();
  await pause(260);
}
async function closeDialog() {
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await modal.waitFor({ state: 'detached' });
}
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
async function apply(operations, label) {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
  return r;
}

// ---- Project: the business starter, exported into a deep client folder so paths are realistically long ----
const sites = join(WORK, 'sites');
await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
const dir = join(sites, 'harbour-lane-studio');
const exportsDir = join(WORK, 'Client handoffs', '2026', 'Harbour Lane Studio', 'Final proofs for sign-off');
mkdirSync(exportsDir, { recursive: true });
// Stand in for the native dialogs and keep Finder and the browser from opening.
await app.evaluate(({ dialog, shell }, parent) => {
  let zips = 0;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${parent}/harbour-lane-studio-${++zips}.zip` });
  shell.showItemInFolder = () => undefined;
  shell.openExternal = async () => undefined;
}, exportsDir);
await pause(1200);

// ---- Choosing what to export ----
await openDialog();
await shot('rest', '.modal [data-testid="export-pages"]');
// The starter's sample contact details, opened from their one line, one of them to show where it appears.
await modal.getByTestId('export-sample-contacts').getByRole('button', { name: 'Review', exact: true }).click();
await modal.getByTestId('export-sample-email').getByRole('button', { name: 'Show where' }).click();
await shot('samples-where', '.modal [data-testid="export-sample-email"] li', LIGHT);
await modal.getByTestId('export-sample-email').getByRole('button', { name: 'Show where' }).click();
await modal.getByRole('radio', { name: 'ZIP file', exact: true }).click();
await shot('format-zip', '.modal [aria-pressed="true"]:has-text("ZIP file")', LIGHT);
// Keyboard: Tab from the format control lands on the first export choice.
await modal.getByRole('radio', { name: 'ZIP file', exact: true }).focus();
await win.keyboard.press('Tab');
await shot('keyboard-focus', '.modal :focus-visible', LIGHT);
await modal.getByRole('radio', { name: 'Folder', exact: true }).click();
await closeDialog();

// ---- Published pages and drafts left out ----
await apply(
  [
    { type: 'page.create', pageId: 'pg_winterstock', title: 'Winter stock preview', route: '/winter-stock/' },
    { type: 'page.update', pageId: 'pg_winterstock', draft: true },
    { type: 'page.create', pageId: 'pg_pricing', title: 'Pricing', route: '/pricing/' },
    { type: 'page.update', pageId: 'pg_pricing', draft: true }
  ],
  'Add drafts'
);
await pause(500);
await openDialog();
await shot('drafts', '.modal [data-testid="export-drafts"]');
await closeDialog();

// A published page that links to a draft stops the website export.
await apply(
  [
    { type: 'page.create', pageId: 'pg_offers', title: 'Spring offers', route: '/spring-offers/' },
    { type: 'node.insert', owner: { kind: 'page', id: 'pg_offers' }, componentId: 'cta.banner', props: { heading: 'See this winter', primaryLabel: 'Preview the winter range', primaryLink: { type: 'page', target: 'pg_winterstock' } } },
    { type: 'node.insert', owner: { kind: 'page', id: 'pg_offers' }, componentId: 'cta.banner', props: { heading: 'What it costs', primaryLabel: 'See our pricing', primaryLink: { type: 'page', target: 'pg_pricing' } } }
  ],
  'Add offers'
);
await pause(500);
await openDialog();
await shot('draft-links', '.modal [data-testid="export-draft-links"]');
// A short window folds even a short list, so the export that is still available stays in view.
await win.setViewportSize({ width: 1024, height: 640 });
await pause(300);
await shot('draft-links-small', '.modal [data-testid="export-draft-links"]', LIGHT);
await win.setViewportSize({ width: 1440, height: 900 });
await pause(300);
// More links than the note lists outright: they fold behind a disclosure.
await apply(
  ['Winter hours', 'Winter gift cards'].map((heading) => ({ type: 'node.insert', owner: { kind: 'page', id: 'pg_offers' }, componentId: 'cta.banner', props: { heading, primaryLabel: heading, primaryLink: { type: 'page', target: 'pg_winterstock' } } })),
  'Add more links'
);
await modal.getByRole('button', { name: 'Review links to drafts' }).waitFor();
await shot('draft-links-many', '.modal [data-testid="export-draft-links"]', LIGHT);
await closeDialog();
await apply([{ type: 'page.remove', pageId: 'pg_offers' }], 'Remove offers');
await pause(500);

// ---- Blocked: a project file changed outside the app, held as a real conflict across a reopen ----
{
  await win.evaluate(() => window.builder.project.flush());
  const pagesDir = join(dir, 'siteorigin', 'pages');
  const file = readdirSync(pagesDir).find((f) => JSON.parse(readFileSync(join(pagesDir, f), 'utf8')).route === '/about/');
  if (!file) throw new Error('the starter has no About page document');
  const rel = `siteorigin/pages/${file}`;
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  const builder = readFileSync(join(dir, rel), 'utf8');
  const hash = createHash('sha256').update(builder).digest('hex');
  mkdirSync(join(dir, '.siteorigin', 'history', 'blobs'), { recursive: true });
  writeFileSync(join(dir, '.siteorigin', 'history', 'blobs', `${hash}.json`), builder);
  const changed = JSON.parse(builder);
  changed.title = `${changed.title} (edited in another app)`;
  writeFileSync(join(dir, rel), `${JSON.stringify(changed, null, 2)}\n`);
  writeFileSync(join(dir, '.siteorigin', 'conflicts.json'), JSON.stringify({ conflicts: [{ path: rel, reason: 'Changed outside SiteOrigin Builder.', builder: hash }] }));
  const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
  if (!reopened?.ok) throw new Error(`the project did not reopen: ${JSON.stringify(reopened)}`);
  await win.waitForSelector('.editor');
  await win.frameLocator('.frame-box iframe').locator('h1').first().waitFor({ timeout: 120000 });
  await eventually(async () => {
    if (!(await snapshot()).conflicts.length) throw new Error('the conflict is not held');
  }, 30000);
  await openDialog();
  await shot('blocked-conflict', '.modal #export-blocked-conflict', LIGHT);
  await closeDialog();
  const settled = await win.evaluate((p) => window.builder.project.resolveConflict(p, 'restore'), rel);
  if (!settled?.ok) throw new Error(`the conflict did not resolve: ${JSON.stringify(settled)}`);
  await eventually(async () => {
    if ((await snapshot()).conflicts.length) throw new Error('the conflict is still held');
  }, 30000);
  await pause(800);
}

// ---- A real failed build, with the build in progress on the way ----
const BROKEN = `<script>\n  import { building } from '$app/environment';\n  if (building) throw new Error('The opening hours widget could not read its hours');\n</script>\n<section class="hours"><p>Open every day</p></section>\n`;
const FIXED = `<section class="hours"><p>Open every day</p></section>\n`;
await apply([{ type: 'component.createCode', name: 'Opening hours', description: 'Shows when the studio is open.', source: BROKEN }], 'Create the component');
const built = (await snapshot()).state;
const definitionId = Object.entries(built.components).find(([, c]) => c.name === 'Opening hours')?.[0];
const contactId = Object.values(built.pages).find((p) => p.route === '/contact/')?.id;
if (!definitionId || !contactId) throw new Error('the failing component or the Contact page is missing');
await apply([{ type: 'node.insert', owner: { kind: 'page', id: contactId }, definitionId }], 'Add it to Contact');
await pause(800);

await openDialog();
// The headless window is not focused, so the page's clipboard would refuse.
await win.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } }));
await websiteButton.click();
await modal.getByText(/Building your website/).first().waitFor({ timeout: 30000 });
await shot('building', '.modal [role="status"]:has-text("Building")');
await withTimeout(modal.getByRole('alert').waitFor({ timeout: BUILD_MS }), BUILD_MS + 5000, 'The failed export');
await pause(400);
await shot('failed', '.modal [role="alert"]');
await modal.getByRole('button', { name: 'Technical details' }).click();
await modal.getByRole('button', { name: 'Copy details' }).click();
await modal.getByText(/^Copied/).waitFor();
await modal.getByTestId('export-build-details-text').scrollIntoViewIfNeeded();
await shot('failed-details', '.modal [data-testid="export-build-details-text"]', LIGHT);

// ---- Fixed: a real success, which joins the recent exports ----
await apply([{ type: 'component.updateSource', definitionId, source: FIXED }], 'Fix the component');
await pause(800);
await websiteButton.click();
const success = modal.getByRole('status').filter({ hasText: /^Exported \d+ pages/ });
await withTimeout(success.waitFor({ timeout: BUILD_MS }), BUILD_MS + 5000, 'The website export');
await pause(400);
await shot('success', '.modal [role="status"]:has-text("Exported")');
await closeDialog();

// ---- Recent exports: one of each kind, with long paths ----
for (const [what, call] of [
  ['source folder', () => win.evaluate(() => window.builder.project.exportSource())],
  ['source ZIP', () => win.evaluate(() => window.builder.project.exportSource('zip'))],
  ['website ZIP', () => win.evaluate(() => window.builder.project.exportStatic('zip'))]
]) {
  const r = await withTimeout(call(), BUILD_MS, `The ${what} export`);
  if (!r?.ok) throw new Error(`the ${what} export failed: ${r?.message}`);
}
await openDialog();
await modal.getByRole('region', { name: 'Recent exports' }).getByRole('listitem').nth(3).waitFor();
await shot('history', '.modal .export-history h3', BOTH, { reveal: true });
await win.locator('.modal-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
await shot('history-scrolled', '.modal .export-history li:last-child', LIGHT);
await closeDialog();

// ---- Stress: many pages and drafts with long titles, and a small window ----
{
  const titles = ['Our team', 'Careers', 'Residential interior design & renovation', 'Commercial fit-outs', 'Colour consultations', 'Portfolio', 'Kōwhai Street apartment', 'Harbourside café refit', 'Journal', 'Frequently asked questions', 'Privacy policy', 'Terms of service'];
  const operations = titles.map((title, i) => ({ type: 'page.create', pageId: `pg_extra${i}`, title, route: `/extra-${i}/` }));
  for (const i of [2, 7, 9]) operations.push({ type: 'page.update', pageId: `pg_extra${i}`, draft: true });
  await apply(operations, 'Add many pages');
  await pause(800);
}
await openDialog();
await shot('dense', '.modal [data-testid="export-drafts"]', LIGHT);
await shot('context', '.modal', LIGHT, { full: true });
await closeDialog();

// A success with more notes than it lists in place. Real exports rarely reach three, so this one result is stubbed.
await app.evaluate(({ ipcMain }, result) => {
  ipcMain.removeHandler('project:exportStatic');
  ipcMain.handle('project:exportStatic', () => result);
}, {
  ok: true,
  path: (await snapshot()).recentExports[0].path,
  message: 'Exported 12 pages as a ZIP file.',
  // Notes the website export really gives (main/controller.ts), worded as it words them.
  warnings: ['No public site URL is set, so canonical links, social image URLs and the sitemap were omitted. If the site will have its own address, add it as the Public URL in Site styles › Site details.', 'One image has not been chosen yet and shows a placeholder.', 'kitchen.jpg is 2.4 MB; consider a smaller image.']
});
await openDialog();
await websiteButton.click();
await modal.getByRole('button', { name: 'Review 3 export notes' }).click();
await pause(300);
await shot('success-notes', '.modal .export-row-notes', LIGHT);
await closeDialog();
await win.setViewportSize({ width: 1024, height: 640 });
await pause(300);
await openDialog();
await shot('small-window', '.modal [data-testid="export-pages"]', LIGHT);
await closeDialog();
await win.setViewportSize({ width: 1440, height: 900 });
await pause(300);

// ---- Every sample detail kept on purpose: the review settles to one line ----
await openDialog();
await modal.getByTestId('export-sample-contacts').getByRole('button', { name: 'Review', exact: true }).click();
for (let left = await modal.getByRole('button', { name: 'Keep it' }).count(); left > 0; left--) {
  await modal.getByRole('button', { name: 'Keep it' }).first().click();
  await pause(200);
}
await modal.getByTestId('export-samples-kept').waitFor();
await shot('samples-kept', '.modal [data-testid="export-samples-kept"]');
await closeDialog();

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`export dialog capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
