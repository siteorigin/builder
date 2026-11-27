// Design capture harness for the post writer's Link and Picture dialogs: drives the real (built) app through the
// states of both dialogs (each kind of link, a wrong address, a link edited in place; the library with and without a
// choice, a search, a decorative picture, a missing file, the arrow keys, an empty library) and writes one PNG of the
// dialog per state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/post-dialogs.mjs
//
// Pictures go through the app's own import seam (project.importAssets); a missing file and an empty library through
// the main process's own `project:changed` broadcast. Each capture is verified after it settles; a state that did
// not render throws instead of writing a plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('post dialogs capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'post-dialogs');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-dialogs-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const STARTER = resolve('resources/starter-assets');

// ---- Fixtures: distinct bytes per file (imports dedupe by hash) ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const photos = ['hero', 'studio', 'kitchen', 'bedroom', 'reading', 'dining', 'person-1', 'person-2', 'person-3'];
const names = ['kiln-opening-spring-firing-celadon-shelf', 'studio-wide', 'glaze-test-tiles', 'wheel-throwing-class', 'reading-nook', 'open-studio-seconds-table', 'portrait-mere-takao', 'IMG_4821', 'raku-firing-night'];
const fixtures = [];
photos.forEach((p, i) => {
  const dest = join(FIX, `${names[i]}.jpg`);
  execFileSync('sips', ['-Z', String(880 + i), join(STARTER, `${p}.jpg`), '--out', dest], { stdio: 'ignore' });
  fixtures.push(dest);
});
// A wide transparent logo, shown whole.
const logo = join(FIX, 'harbour-lane-logo-horizontal.svg');
writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="140" viewBox="0 0 640 140"><circle cx="70" cy="70" r="46" fill="#1b5e7a"/><text x="140" y="92" font-family="Georgia" font-size="64" fill="#1b5e7a">Harbour Lane</text></svg>');
fixtures.push(logo);

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 960 });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}
const modal = win.locator('.modal');
const waitThumbs = async () => {
  await win
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.modal img')]
          .filter((i) => {
            const r = i.getBoundingClientRect();
            const box = (i.closest('[role="listbox"]') ?? document.body).getBoundingClientRect();
            return r.height > 0 && r.bottom > Math.max(0, box.top) && r.top < Math.min(innerHeight, box.bottom);
          })
          .every((i) => i.complete && i.naturalWidth > 0),
      null,
      { timeout: 30000 }
    )
    .catch(() => {});
  await pause(400);
};
/** Capture the dialog (or the whole window) in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, verify, themes = BOTH, { moveMouse = true, whole = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (moveMouse) await win.mouse.move(4, 4);
    await waitThumbs();
    if (!(await verify().catch(() => false))) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    if (whole) await win.screenshot({ path });
    else await modal.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(120);
}

const apply = (operations, label = 'Seed') =>
  win.evaluate(
    async ({ operations, label }) => {
      const r = await window.builder.project.apply({ operations }, { label });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r;
    },
    { operations, label }
  );
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
/** Push a changed snapshot through the channel the main process announces every change on. */
const broadcast = (snap) =>
  app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    w.webContents.send('project:changed', s);
  }, snap);

// ---- Project, pictures and entries in three collections ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
const imported = await win.evaluate((paths) => window.builder.project.importAssets(paths), fixtures);
if (imported && imported.ok === false) throw new Error(`import failed: ${JSON.stringify(imported)}`);
await win.locator('.rail [aria-label="Content"]').click();
await win.locator('.posts-panel [data-starter="posts"]').click();
await until(async () => !!(await snapshot()).state.collections.posts, 'the blog');

const BODY = [
  'Every firing is a small act of faith. We load the kiln on a Friday afternoon, close the lid, and for two days the work is out of our hands.',
  'This month we moved the **celadon** pots to the middle shelf, where the heat is most even, and slowed the last hundred degrees to let the glaze settle.',
  'If you came to the open studio last weekend, you saw some of these on the front table. The [workshop timetable](/) has dates for the next glaze class.',
  'Next month we try a long cool-down for the tenmoku.'
];
const POSTS = [
  ['en_kiln0001', 'Opening the kiln after the spring glaze firing', '2026-11-12'],
  ['en_open0002', 'Open studio weekend', '2026-10-02'],
  ['en_glaz0003', 'Five glaze faults and what causes them', '2026-09-18'],
  ['en_whee0004', 'A first term on the wheel: what our beginners made', '2026-08-30'],
  ['en_raku0005', 'Raku night by the harbour', '2026-07-21']
];
await apply(POSTS.map(([entryId, title, publishedAt], i) => ({ type: 'entry.create', collectionId: 'posts', entryId, title, publishedAt, author: 'Mere Tākao', body: i === 0 ? BODY : [`${title}.`] })));
await apply([
  {
    type: 'collection.create',
    collectionId: 'case-studies',
    name: 'Case studies',
    singularName: 'Case study',
    kind: 'editorial',
    route: '/work/',
    fields: { client: { type: 'string', label: 'Client', default: '' } }
  }
]);
await apply([
  { type: 'entry.create', collectionId: 'case-studies', entryId: 'en_case0001', title: 'A dinner service for the harbour restaurant', author: 'Mere Tākao', values: { client: 'The Wharf Kitchen' }, body: ['Plates that look like the harbour on a grey morning.'] },
  { type: 'entry.create', collectionId: 'case-studies', entryId: 'en_case0002', title: 'Tableware for Kōwhai Café', author: 'Mere Tākao', values: { client: 'Kōwhai Café' }, body: ['Eighty place settings.'] }
]);
await pause(600);

const body = win.locator('.post-body');
// The Content tab may already be in the blog; otherwise open it from the collections.
const blogOpen = win.locator('.content-collection-open[data-collection="posts"]');
if (await blogOpen.isVisible().catch(() => false)) await blogOpen.click();
await win.locator('.post-row', { hasText: 'Opening the kiln after the spring glaze firing' }).first().click({ timeout: 8000 }).catch(async (e) => {
  await win.screenshot({ path: join(OUT, 'debug-open.png') });
  throw e;
});
await until(async () => (await win.locator('.post-title-input').inputValue()) === 'Opening the kiln after the spring glaze firing', 'the writer');
await pause(500);

const closeDialog = async () => {
  await win.keyboard.press('Escape');
  await until(async () => !(await modal.isVisible()), 'the dialog to close');
  await pause(200);
};
/** The caret at the end of the last paragraph, nothing chosen. */
const caretAtEnd = async () => {
  await body.locator('p').last().click();
  await win.keyboard.press('End');
  await pause(150);
};
const openLink = async () => {
  await win.locator('.post-tools [aria-label="Link"], .post-tools [aria-label="Edit link"]').first().click();
  await until(() => modal.isVisible(), 'the link dialog');
  await pause(300);
};
const isLink = async () => (await modal.isVisible()) && /web address/i.test(await modal.innerText());
const kind = (name) => modal.getByRole('radio', { name });

// ---- Link: a new link at the caret, to a page ----
await caretAtEnd();
await openLink();
await shot('link-new-page', isLink);
await shot('link-new-page-window', isLink, LIGHT, { whole: true });
// Open in a new tab, turned on: the dialog stays open with it on.
const newTab = modal.getByRole('switch', { name: /new tab/i });
if (await newTab.count()) {
  await newTab.click();
  await pause(250);
  await shot('link-newtab', async () => (await isLink()) && (await newTab.getAttribute('aria-checked')) === 'true', LIGHT);
  await newTab.click();
} else console.log('skipped link-newtab: no new-tab switch');
// To an entry of any collection.
await kind(/entry/i).click();
await pause(200);
await shot('link-entry', async () => (await isLink()) && (await modal.locator('select').count()) > 0);
// The entry list, opened: what it offers to choose from.
const entryOptions = await modal.locator('select').last().evaluate((s) => [...s.querySelectorAll('optgroup, option')].map((o) => (o.tagName === 'OPTGROUP' ? `[${o.label}]` : o.textContent)));
console.log('entry options:', entryOptions.join(' | '));
await kind(/collection index/i).click();
await pause(200);
await shot('link-index', isLink, LIGHT);
// A web address that is not one.
await kind(/web address/i).click();
await pause(200);
await modal.getByLabel('Web address', { exact: true }).fill('harbour lane pottery');
await modal.getByRole('button', { name: /^(Apply|Add|Update)/ }).click();
await pause(300);
await shot('link-url-error', async () => (await isLink()) && (await modal.locator('.field-error').first().isVisible()));
await closeDialog();

// ---- Link: the caret in a link edits it ----
await body.locator('a', { hasText: 'workshop timetable' }).click();
await pause(200);
await openLink();
await shot('link-edit', isLink, LIGHT);
await closeDialog();

// ---- Picture: the library, nothing chosen yet ----
const isPicture = async () => (await modal.isVisible()) && (await modal.locator('[role="listbox"]').isVisible());
await caretAtEnd();
await win.locator('.post-tools [aria-label="Picture"]').click();
await until(isPicture, 'the picture dialog');
await shot('picture-new', isPicture);
await shot('picture-new-window', isPicture, LIGHT, { whole: true });
// One chosen, its description suggested or typed.
const tiles = modal.locator('[role="option"]');
await tiles.nth(1).click();
await pause(200);
const alt = modal.getByLabel(/description/i).first();
if (!(await alt.inputValue())) await alt.fill('The studio from the door, wheels along the window and shelves of bisqueware');
await modal.getByLabel(/caption/i).fill('The studio on a Saturday morning.');
await shot('picture-chosen', async () => (await isPicture()) && (await modal.locator('[role="option"][aria-selected="true"]').count()) === 1);
// The library scrolled to its end, the chosen picture out of view.
await modal.locator('[role="listbox"]').evaluate((el) => (el.scrollTop = el.scrollHeight));
await pause(400);
await shot('picture-scrolled', isPicture, LIGHT);
await modal.locator('[role="listbox"]').evaluate((el) => (el.scrollTop = 0));
await pause(200);
// The arrow keys, from the chosen picture: where focus goes, and what is chosen.
await modal.locator('[role="option"][aria-selected="true"]').focus();
await win.keyboard.press('ArrowRight');
await win.keyboard.press('ArrowRight');
await shot('picture-keys', async () => (await isPicture()) && (await win.evaluate(() => document.activeElement?.getAttribute('role') === 'option')), LIGHT, { moveMouse: false });
// The description emptied and Add pressed: what the field asks for.
{
  const kept = await alt.inputValue();
  await alt.fill('');
  await modal.getByRole('button', { name: /^(Add|Update) picture/ }).click();
  await pause(250);
  await shot('picture-nodesc', async () => (await isPicture()) && (await alt.inputValue()) === '' && (await modal.locator('.field-error').first().isVisible()), LIGHT, { moveMouse: false });
  await alt.fill(kept);
}
// Decorative.
await modal.getByLabel(/decorative/i).first().click();
await pause(200);
await shot('picture-decorative', isPicture, LIGHT);
await modal.getByLabel(/decorative/i).first().click();
// A search with nothing found.
const search = modal.locator('input[type="search"]');
if (await search.count()) {
  await search.fill('teapot');
  await pause(250);
  await shot('picture-nomatch', async () => (await modal.isVisible()) && (await search.inputValue()) === 'teapot', LIGHT);
  await search.fill('');
} else console.log('skipped picture-nomatch: no search field');
await closeDialog();

// ---- Picture: one already in the text, opened to change ----
await caretAtEnd();
await win.locator('.post-tools [aria-label="Picture"]').click();
await until(isPicture, 'the picture dialog');
await tiles.nth(0).click();
await modal.getByLabel(/description/i).first().fill('Celadon bowls on the kiln shelf, just out of the firing');
await modal.getByRole('button', { name: /Add picture/ }).click();
await until(async () => (await body.locator('figure.post-figure').count()) > 0, 'the picture in the text');
await pause(800);
await body.locator('figure.post-figure').first().click();
await until(isPicture, 'the picture dialog, editing');
await shot('picture-edit', isPicture, LIGHT);
await closeDialog();

// ---- Picture: a file gone missing ----
{
  const s = await snapshot();
  const ids = Object.values(s.state.assets.assets).filter((a) => a.kind === 'image').sort((a, b) => a.name.localeCompare(b.name)).map((a) => a.id);
  s.missingAssets = [{ assetId: ids[2], original: true, variants: [] }];
  await broadcast(s);
  await pause(400);
}
await caretAtEnd();
await win.locator('.post-tools [aria-label="Picture"]').click();
await until(isPicture, 'the picture dialog');
await shot('picture-missing', isPicture, LIGHT);
await closeDialog();
// The picture already in the text, its own file gone: opened to change it.
{
  const s = await snapshot();
  const figId = await body.locator('figure.post-figure').first().getAttribute('data-asset-id');
  s.missingAssets = [{ assetId: figId, original: true, variants: [] }];
  await broadcast(s);
  await pause(400);
}
await body.locator('figure.post-figure').first().click();
await until(isPicture, 'the picture dialog, editing a missing picture');
await shot('picture-edit-missing', async () => (await isPicture()) && (await modal.locator('.field-error').count()) > 0, LIGHT);
await closeDialog();

// ---- Picture: an empty library ----
{
  const s = await snapshot();
  s.state.assets.assets = Object.fromEntries(Object.entries(s.state.assets.assets).filter(([, a]) => a.kind !== 'image'));
  s.missingAssets = [];
  await broadcast(s);
  await pause(400);
}
await caretAtEnd();
await win.locator('.post-tools [aria-label="Picture"]').click();
await until(() => modal.isVisible(), 'the picture dialog');
await shot('picture-empty', async () => (await modal.isVisible()) && /Assets/.test(await modal.innerText()), LIGHT);
await closeDialog();
await broadcast(await snapshot());

if (errors.length) console.log('page errors:', errors.join('\n'));
await app.close();
rmSync(WORK, { recursive: true, force: true });
const files = readdirSync(OUT).filter((f) => f.endsWith('.png') && !f.startsWith('debug-'));
console.log(`wrote ${written.length} captures; ${files.length} PNGs in ${OUT}`);
if (written.length !== files.length) process.exit(1);
