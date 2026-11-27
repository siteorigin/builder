// Categories and tags capture harness: drives the real (built) app through the states of filing a post (the
// Categories and Tags boxes in the writer's details, with a few terms and with many) and of the manager dialog opened
// from the Posts panel (each grouping's list, renaming, a refused change, an empty grouping), and writes one PNG per
// state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/post-terms.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('categories and tags capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'post-terms');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-terms-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

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

/** Capture `target` (a locator, or the whole window) in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, target, verify, themes = BOTH, { moveMouse = true } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (moveMouse) await win.mouse.move(4, 4);
    await pause(200);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    if (target) await target.screenshot({ path });
    else await win.screenshot({ path });
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

// ---- Project and its blog ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await win.locator('.rail [aria-label="Content"]').click();
await win.locator('.posts-panel [data-starter="posts"]').click();
await until(async () => !!(await snapshot()).state.collections.posts, 'the blog');

// A post of its own, filed under a few of the blog's terms.
const terms = (s, tax) => Object.keys(s.state.collections.posts.settings.taxonomies?.[tax]?.terms ?? {});
let s = await snapshot();
const FEW_CATEGORIES = ['Workshops', 'Studio news', 'Glazes', 'Firing', 'Events', 'Open studio'];
const FEW_TAGS = ['beginners', 'celadon', 'cone 10', 'kiln opening', 'studio tour'];
await apply([
  ...FEW_CATEGORIES.filter((l) => !terms(s, 'categories').includes(l.toLowerCase().replace(/[^a-z0-9]+/g, '-'))).map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label })),
  ...FEW_TAGS.filter((l) => !terms(s, 'tags').includes(l.toLowerCase().replace(/[^a-z0-9]+/g, '-'))).map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label }))
]);
s = await snapshot();
console.log('categories:', terms(s, 'categories').length, 'tags:', terms(s, 'tags').length);
await apply([
  {
    type: 'entry.create',
    collectionId: 'posts',
    entryId: 'en_kiln0001',
    title: 'Opening the kiln after the spring glaze firing',
    publishedAt: '2026-11-12',
    author: 'Mere Tākao',
    excerpt: 'What changed in the March firing, and why the celadon came out the way it did.',
    terms: { categories: ['glazes', 'firing'], tags: ['celadon', 'cone-10', 'kiln-opening'] },
    body: ['Every firing is a small act of faith.']
  },
  { type: 'entry.create', collectionId: 'posts', entryId: 'en_open0002', title: 'Open studio weekend', publishedAt: '2026-10-02', draft: false, author: 'Mere Tākao', terms: { categories: ['events', 'open-studio', 'glazes'], tags: ['studio-tour'] }, body: ['Nearly three hundred people came through.'] }
]);
// A list of posts on Home that chooses a category, so that category cannot be deleted.
s = await snapshot();
await apply([{ type: 'node.insert', owner: { kind: 'page', id: s.state.site.homePageId }, componentId: 'blog.grid', props: { category: 'Events', heading: 'Events' } }], 'Latest events');
await pause(600);

/** The blog's list in the Content panel (a list of collections first, when there is more than one). */
async function openBlog() {
  const pick = win.locator('.content-collection-open[data-collection="posts"]');
  if (await pick.isVisible().catch(() => false)) await pick.click();
  else if (!(await win.locator('.posts-panel .post-row').first().isVisible().catch(() => false))) await win.locator('.rail [aria-label="Content"]').click();
  await win.locator('.posts-panel .post-row').first().waitFor().catch(async (e) => {
    await win.screenshot({ path: '/var/folders/4k/8y6fcy3d1tvbpv09130h9vqw0000gn/T/design-review/SiteOriginBuilder-post-terms/debug.png' });
    console.log(await win.locator('.posts-panel').innerHTML().catch(() => 'no panel'));
    throw e;
  });
}
/** The writer's Categories and Tags boxes, cropped together with a margin, the first scrolled to the top of the view. */
const termsBox = {
  async screenshot({ path }) {
    const groups = win.locator('.post-page .post-terms');
    await groups.first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await win.locator('.post-scroll').evaluate((el) => (el.scrollTop -= 24));
    await pause(150);
    const boxes = [];
    for (let i = 0; i < (await groups.count()); i++) boxes.push(await groups.nth(i).boundingBox());
    const view = win.viewportSize();
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 20);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 20);
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + 20;
    const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + 24);
    await win.screenshot({ path, clip: { x, y, width: right - x, height: bottom - y } });
  }
};
/** Close any notice, so one state's toast is not in the next state's picture. */
async function clearToasts() {
  for (const b of await win.locator('.toast-dismiss').all()) await b.click().catch(() => undefined);
  await pause(200);
}
async function openPost(title) {
  await openBlog();
  await win.locator('.posts-panel .post-row', { hasText: title }).first().click({ timeout: 8000 }).catch(async (e) => {
    await win.screenshot({ path: '/var/folders/4k/8y6fcy3d1tvbpv09130h9vqw0000gn/T/design-review/SiteOriginBuilder-post-terms/debug.png' });
    console.log((await win.locator('.posts-panel').innerText().catch(() => 'no panel')).slice(0, 1500));
    throw e;
  });
  await until(async () => (await win.locator('.post-title-input').inputValue()) === title, `the writer to show “${title}”`);
  await pause(400);
  const head = win.locator('.post-page .post-details .section-head').first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await pause(400);
  await win.locator('.post-page .post-terms').last().scrollIntoViewIfNeeded();
  await pause(300);
}
const termsShown = (n = 2) => async () => (await win.locator('.post-page .post-terms').count()) >= n && (await win.locator('.post-page .post-terms').last().isVisible());

// ---- The writer, a few terms each ----
await openPost('Opening the kiln after the spring glaze firing');
await shot('writer-few', termsBox, termsShown());
// Keyboard on a term's box.
await win.locator('.post-page .post-terms[data-taxonomy="categories"] input[type="checkbox"]').nth(1).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('writer-few-focus', termsBox, () => win.evaluate(() => document.activeElement?.matches('.post-terms input:focus-visible')), LIGHT, { moveMouse: false });
await win.evaluate(() => document.activeElement?.blur());
// A name typed to add.
const catField = () => win.locator('.post-page .post-terms[data-taxonomy="categories"] input.input');
await catField().fill('Kiln diaries');
await shot('writer-few-typed', termsBox, async () => (await catField().inputValue()) === 'Kiln diaries', LIGHT);
await catField().fill('');

// ---- A refused change: the project says no to every change of a post's terms ----
await app.evaluate(({ ipcMain }) => {
  const handlers = ipcMain._invokeHandlers;
  const orig = handlers?.get?.('project:apply');
  if (!orig) throw new Error('cannot reach the apply handler');
  globalThis.__termsApply = orig;
  ipcMain.removeHandler('project:apply');
  ipcMain.handle('project:apply', (event, batch, opts) => {
    if (batch?.operations?.some((o) => o.type === 'entry.update' && o.terms)) return { ok: false, error: { code: 'VALIDATION', message: 'Refused for the capture.' } };
    return orig(event, batch, opts);
  });
});
await win.locator('.post-page .post-terms[data-taxonomy="categories"] .post-term', { hasText: 'Workshops' }).click();
await until(() => win.locator('.post-page .post-terms-failed').isVisible(), 'the refused note', 30000);
await shot('writer-refused', termsBox, () => win.locator('.post-page .post-terms-failed').isVisible());
// A name refused too: each refusal beside what it is about.
await catField().fill('Kiln diaries');
await catField().press('Enter');
await until(async () => (await win.locator('.post-page .post-terms-failed').count()) === 2, 'the second refused note', 30000);
await clearToasts();
await shot('writer-refused-add', termsBox, async () => (await win.locator('.post-page .post-terms-failed').count()) === 2, LIGHT);
await app.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('project:apply');
  ipcMain.handle('project:apply', globalThis.__termsApply);
});
while (await win.locator('.post-page .post-terms-failed').count()) await win.locator('.post-page .post-terms-failed').first().getByRole('button', { name: 'Leave it' }).click();
await catField().fill('');
await clearToasts();
await pause(300);

// ---- The manager, a few terms ----
async function openManager() {
  await openBlog();
  await pause(300);
  await win.locator('[data-testid="collection-options-posts"]').click();
  await win.locator('[role^="menuitem"]', { hasText: 'Categories and tags' }).first().click();
  await win.locator('.modal .terms-panel').waitFor();
  await pause(400);
}
const modal = win.locator('.modal');
await openManager();
await shot('manager-categories', modal, () => modal.locator('.term-row').first().isVisible());
await modal.getByRole('tab', { name: 'Tags' }).click();
await pause(300);
await shot('manager-tags', modal, async () => (await modal.locator('.terms-panel').getAttribute('data-taxonomy')) === 'tags', LIGHT);
await modal.getByRole('tab', { name: 'Categories' }).click();
await pause(300);
// A category a list of posts on Home chooses: it cannot be deleted, and says why.
await modal.locator('.term-row').filter({ hasText: 'Events' }).first().scrollIntoViewIfNeeded();
await pause(200);
await shot('manager-blocked', modal, () => modal.locator('.term-row').filter({ hasText: 'Events' }).first().isVisible(), LIGHT);
await modal.locator('.terms-list').evaluate((el) => (el.scrollTop = 0));
// A category's archive description, opened to edit.
const describeToggle = modal.locator('.term-row').filter({ hasText: 'Studio news' }).locator('.term-describe');
if (await describeToggle.count()) {
  await describeToggle.click();
  await pause(300);
  await shot('manager-describe', modal, () => modal.locator('.term-describe-field textarea').isVisible(), BOTH, { moveMouse: false });
  await describeToggle.click();
  await pause(200);
} else console.log('skipped manager-describe: no description toggle');
// A row under the pointer.
await modal.locator('.term-row').nth(1).hover();
await shot('manager-hover', modal, () => modal.locator('.term-row').nth(1).isVisible(), LIGHT, { moveMouse: false });
// Renaming, with the archive's new address.
await modal.locator('.term-row').filter({ hasText: 'Glazes' }).getByRole('button', { name: /^Rename/ }).click();
await modal.locator('.term-rename input').fill('Glazes and surfaces');
await pause(300);
await shot('manager-rename', modal, () => modal.locator('.term-rename').isVisible(), BOTH, { moveMouse: false });
await win.keyboard.press('Escape');
await pause(200);
// Adding: a name typed.
await modal.locator('.terms-add input').fill('Kiln diaries');
await shot('manager-typed', modal, async () => (await modal.locator('.terms-add input').inputValue()) === 'Kiln diaries', LIGHT);
// A name already in use: Add unavailable, and why.
await modal.locator('.terms-add input').fill('Glazes');
await shot('manager-taken', modal, () => modal.locator('.terms-panel .field-error').isVisible(), LIGHT);
await modal.locator('.terms-add input').fill('');
// A rename to a name already in use.
await modal.locator('.term-row').filter({ hasText: 'Glazes' }).getByRole('button', { name: /^Rename/ }).click();
await modal.locator('.term-row.editing input').fill('Firing');
await pause(200);
await shot('manager-rename-clash', modal, () => modal.locator('.term-row.editing .field-error').isVisible(), LIGHT, { moveMouse: false });
await win.keyboard.press('Escape');
await pause(200);
await win.keyboard.press('Escape');
await until(async () => !(await modal.isVisible()), 'the manager to close');

// ---- An empty grouping: every tag deleted ----
s = await snapshot();
const tagIds = terms(s, 'tags');
await apply(tagIds.map((termId) => ({ type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'tags', termId })));
await openManager();
await modal.getByRole('tab', { name: 'Tags' }).click();
await pause(300);
await shot('manager-empty', modal, async () => (await modal.locator('.term-row').count()) === 0, BOTH);
await win.keyboard.press('Escape');
await until(async () => !(await modal.isVisible()), 'the manager to close');

// ---- Many terms ----
const MANY_CATEGORIES = ['Wheel throwing', 'Hand building', 'Kiln diaries', 'Materials', 'Tools', 'Students', 'Exhibitions', 'Commissions', 'Behind the scenes', 'Raku', 'Stoneware', 'Porcelain', 'Earthenware', 'Surface decoration', 'Sgraffito', 'Slip casting', 'Community', 'Guest makers', 'Holiday courses', 'Kids classes and family days at the studio'];
const MANY_TAGS = ['beginners', 'advanced', 'glaze recipes', 'cone 6', 'cone 10', 'reduction', 'oxidation', 'celadon', 'tenmoku', 'shino', 'ash glaze', 'crawling', 'pinholes', 'crazing', 'bisque', 'wedging', 'centering', 'trimming', 'handles', 'lids', 'mugs', 'bowls', 'kiln opening', 'studio tour'];
s = await snapshot();
await apply([...MANY_CATEGORIES.filter((l) => !terms(s, 'categories').includes(l.toLowerCase().replace(/[^a-z0-9]+/g, '-'))).map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label })), ...MANY_TAGS.map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label }))]);
await apply([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_kiln0001', terms: { categories: ['glazes', 'firing', 'kiln-diaries', 'stoneware'], tags: ['celadon', 'cone-10', 'kiln-opening', 'reduction', 'bowls'] } }]);
await pause(500);

await openPost('Opening the kiln after the spring glaze firing');
await shot('writer-many', termsBox, async () => (await win.locator('.post-page .post-term-chips').count()) >= 1);
const findField = () => win.locator('.post-page .post-terms[data-taxonomy="categories"] input.input');
// A refusal with many terms: between the field and the list.
await app.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('project:apply');
  ipcMain.handle('project:apply', (event, batch, opts) => (batch?.operations?.some((o) => o.type === 'entry.update' && o.terms) ? { ok: false, error: { code: 'VALIDATION', message: 'Refused for the capture.' } } : globalThis.__termsApply(event, batch, opts)));
});
await win.locator('.post-page .post-terms[data-taxonomy="categories"] .post-term', { hasText: 'Materials' }).click();
await until(() => win.locator('.post-page .post-terms-failed').isVisible(), 'the refused note (many)', 30000);
await clearToasts();
await shot('writer-many-refused', termsBox, () => win.locator('.post-page .post-terms-failed').isVisible(), LIGHT);
await app.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('project:apply');
  ipcMain.handle('project:apply', globalThis.__termsApply);
});
await win.locator('.post-page .post-terms-failed').getByRole('button', { name: 'Leave it' }).click();
await pause(300);
await findField().fill('gla');
await pause(200);
await shot('writer-many-find', termsBox, async () => (await findField().inputValue()) === 'gla', LIGHT);
await findField().fill('Raku');
await pause(200);
await shot('writer-many-choose', termsBox, async () => (await findField().inputValue()) === 'Raku', LIGHT);
await findField().fill('Pit firing');
await pause(200);
await shot('writer-many-none', termsBox, () => win.locator('.post-page .post-terms-none').isVisible(), LIGHT);
await findField().fill('');

// ---- The manager, many terms ----
await openManager();
await shot('manager-many', modal, async () => (await modal.locator('.term-row').count()) > 12, BOTH);
await win.keyboard.press('Escape');

if (errors.length) console.log('page errors:', errors.join('\n'));
await app.close();
rmSync(WORK, { recursive: true, force: true });
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`wrote ${written.length} captures; ${files.length} PNGs in ${OUT}`);
