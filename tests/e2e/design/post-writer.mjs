// Post writer capture harness: drives the real (built) app through the states of the full writing view that takes the
// canvas's place (the bar, the paper, its details, the formatting toolbar, the text and what it says when text is not
// saved), and writes one PNG of the writer per state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/post-writer.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('post writer capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'post-writer');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-writer-')));
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

const holder = win.locator('.post-writer-holder');
/** Capture the writer in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, verify, themes = BOTH, { moveMouse = true, whole = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (moveMouse) await win.mouse.move(4, 4);
    await pause(200);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    if (whole) await win.screenshot({ path });
    else await holder.screenshot({ path });
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

// ---- Project and its collections ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await win.locator('.rail [aria-label="Content"]').click();
await win.locator('.posts-panel [data-starter="posts"]').click();
await until(async () => !!(await snapshot()).state.collections.posts, 'the blog');

const CATEGORIES = ['Workshops', 'Studio news', 'Glazes', 'Firing', 'Wheel throwing', 'Hand building', 'Kiln diaries', 'Events', 'Open studio', 'Materials', 'Tools', 'Students', 'Exhibitions', 'Commissions', 'Behind the scenes', 'Raku', 'Stoneware', 'Porcelain', 'Earthenware', 'Surface decoration', 'Sgraffito', 'Slip casting', 'Community', 'Guest makers', 'Holiday courses', 'Kids classes'];
const TAGS = ['beginners', 'advanced', 'glaze recipes', 'cone 6', 'cone 10', 'reduction', 'oxidation', 'celadon', 'tenmoku', 'shino', 'ash glaze', 'crawling', 'pinholes', 'crazing', 'bisque', 'wedging', 'centering', 'trimming', 'handles', 'lids', 'mugs', 'bowls', 'plates', 'vases', 'teapots', 'studio tour', 'kiln opening', 'sale', 'gift ideas', 'summer', 'winter'];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
await apply([...CATEGORIES.map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label })), ...TAGS.map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label }))]);

const BODY = [
  'Every firing is a small act of faith. We load the kiln on a Friday afternoon, close the lid, and for two days the work is out of our hands.',
  '### What we changed this time',
  'This month we moved the **celadon** pots to the middle shelf, where the heat is most even, and slowed the last hundred degrees to let the glaze settle. The difference shows in the colour: a deeper, quieter green with far fewer pinholes.',
  '- Middle shelf for anything glazed in celadon',
  '- A slower climb through the last hundred degrees',
  '- Cones on every shelf, not just the top one',
  '> The kiln never lies. It just tells you things you did not want to hear.',
  'If you came to the open studio last weekend, you saw some of these on the front table. The rest go on sale with the spring collection, and the [workshop timetable](/) has dates for the next glaze class.',
  'Next month we try a long cool-down for the tenmoku, which should bring out the rust tones on the rims. We will write up how it goes, good or bad.'
];
await apply([
  {
    type: 'entry.create',
    collectionId: 'posts',
    entryId: 'en_kiln0001',
    title: 'Opening the kiln after the spring glaze firing',
    publishedAt: '2026-11-12',
    author: 'Mere Tākao',
    excerpt: 'What changed in the March firing, and why the celadon came out the way it did.',
    terms: { categories: ['glazes', 'firing', 'kiln-diaries'], tags: ['celadon', 'cone-10', 'kiln-opening'] },
    body: BODY
  },
  {
    type: 'entry.create',
    collectionId: 'posts',
    entryId: 'en_open0002',
    title: 'Open studio weekend',
    publishedAt: '2026-10-02',
    draft: false,
    author: 'Mere Tākao',
    excerpt: 'Two days of demonstrations, a seconds table and tea.',
    terms: { categories: ['events', 'open-studio'], tags: ['studio-tour', 'sale'] },
    body: ['We opened the doors for two days and nearly three hundred people came through.', 'Thank you to everyone who bought a mug from the seconds table.']
  }
]);
// Records with fields and a page of their own: the writer's form for them.
await win.locator('.posts-panel .content-collection-add, .posts-panel button:has-text("Add a collection")').first().click().catch(() => undefined);
const projectStarter = win.locator('.posts-panel [data-starter="projects"]');
if (await projectStarter.isVisible().catch(() => false)) {
  await projectStarter.click();
  await until(async () => !!(await snapshot()).state.collections.projects, 'the projects collection');
  await apply([{ type: 'entry.create', collectionId: 'projects', entryId: 'en_proj0001', title: 'Tableware for Kōwhai Café', values: { client: 'Kōwhai Café', completed: '2026-08-30' }, body: ['Eighty place settings in a speckled oatmeal glaze, made to survive a commercial dishwasher.'] }]);
} else console.log('skipped the projects collection: its starter is not offered');
// An article collection of its own, with custom fields and its own name for an entry.
await apply([
  {
    type: 'collection.create',
    collectionId: 'case-studies',
    name: 'Case studies',
    singularName: 'Case study',
    kind: 'editorial',
    route: '/work/',
    fields: { client: { type: 'string', label: 'Client', default: '' }, sector: { type: 'string', label: 'Sector', default: '' }, duration: { type: 'string', label: 'Project length', default: '' } }
  }
]);
await apply([{ type: 'entry.create', collectionId: 'case-studies', entryId: 'en_case0001', title: 'A dinner service for the harbour restaurant', author: 'Mere Tākao', values: { client: 'The Wharf Kitchen', sector: 'Hospitality', duration: 'Six months' }, body: ['The brief was simple: plates that look like the harbour on a grey morning.'] }]);
await pause(600);

/** Open an entry of a collection in the writer. */
async function open(collectionId, title) {
  await win.locator(`.content-collection-open[data-collection="${collectionId}"]`).click();
  await win.locator('.post-row .post-open', { hasText: title }).first().click();
  await until(async () => (await win.locator('.post-title-input').inputValue()) === title, `the writer to show “${title}”`);
  await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 0));
  await pause(500);
}
const bodyShows = (text) => async () => (await holder.isVisible()) && (await win.locator('.post-body').innerText()).includes(text);

// ---- Nothing chosen ----
await win.locator('.content-collection-open[data-collection="posts"]').click();
if (await win.locator('.post-none').isVisible().catch(() => false)) await shot('writer-none', () => win.locator('.post-none').isVisible(), LIGHT);
else console.log('skipped writer-none: the Content tab opened an entry straight away');

// ---- A draft post, at rest ----
await open('posts', 'Opening the kiln after the spring glaze firing');
await shot('draft-rest', bodyShows('Every firing'));

// Its details open: the date, address, author, excerpt, picture, and the categories and tags.
const details = win.locator('.post-page details.post-details').first();
const detailsHead = win.locator('.post-page .post-details > summary, .post-page .post-meta-toggle, .post-page .post-details .section-head').first();
await detailsHead.click();
await pause(400);
await shot('details-open', async () => (await win.locator('.post-page .post-terms').count()) > 0, BOTH);
// Further down, through the many categories and tags.
await win.locator('.post-page .post-terms').last().scrollIntoViewIfNeeded();
await pause(300);
await shot('details-terms', async () => (await win.locator('.post-page .post-terms').last().isVisible()), LIGHT);
await detailsHead.click();
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 0));
await pause(300);

// ---- Keyboard focus: the title, the toolbar, the text ----
await win.locator('.post-bar button').last().focus();
await win.keyboard.press('Tab');
await shot('focus-title', () => win.evaluate(() => document.activeElement?.classList.contains('post-title-input') && document.activeElement.matches(':focus-visible')), LIGHT, { moveMouse: false });
await win.locator('.post-body').focus();
await win.keyboard.press('Shift+Tab');
await shot('focus-toolbar', () => win.evaluate(() => !!document.activeElement?.closest('.post-tools') && document.activeElement.matches(':focus-visible')), LIGHT, { moveMouse: false });
await win.keyboard.press('Tab');
await shot('focus-body', () => win.evaluate(() => document.activeElement?.classList.contains('post-body')), LIGHT, { moveMouse: false });
await win.evaluate(() => document.activeElement?.blur());

// ---- Scrolled into the text: the toolbar stays ----
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 520));
await pause(300);
await shot('scrolled', bodyShows('Next month'), LIGHT);
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 0));

// ---- Text that could not be saved ----
/** Type in the text and, before it saves, change or remove the post somewhere else. */
async function typeThen(ops) {
  const p = win.locator('.post-body p').last();
  await p.click();
  await win.keyboard.press('End');
  await win.keyboard.type(' One more sentence before it saves.');
  await apply(ops, 'Changed elsewhere');
}
await typeThen([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_kiln0001', body: ['Someone else rewrote this post.'] }]);
await until(() => win.locator('.post-problem').isVisible(), 'the changed note');
await win.evaluate(() => document.activeElement?.blur());
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 0));
await pause(400);
await shot('problem-changed', async () => /changed somewhere else/.test(await win.locator('.post-problem').innerText()));
// The note scrolled: what still says the text is not saved.
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 640));
await pause(300);
await shot('problem-scrolled', async () => /Not saved/.test(await win.locator('.post-bar').innerText()), LIGHT);
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 0));
// The saved text, read before choosing it over the author's.
await win.getByRole('button', { name: 'Review the saved text' }).click();
await shot('review-saved', async () => /rewrote this post/.test(await win.locator('.modal').innerText()), LIGHT, { whole: true });
await win.locator('.modal').getByRole('button', { name: 'Keep my text' }).click();
await until(async () => !(await win.locator('.modal').isVisible()), 'the dialog to close');
await until(async () => !(await win.locator('.post-problem').isVisible()), 'the note to go');
await pause(800);

// ---- A published post ----
await open('posts', 'Open studio weekend');
await shot('published-rest', bodyShows('three hundred'), LIGHT);

// ---- An article collection of its own, with fields ----
await open('case-studies', 'A dinner service for the harbour restaurant');
await shot('custom-collection', bodyShows('harbour on a grey'), LIGHT);
// Its details opened: its own fields first, then the publication details.
await win.locator('.post-page .post-details .section-head').first().click();
await pause(400);
await shot('custom-details-open', async () => (await win.locator('.post-page .post-custom').isVisible()), LIGHT);
await win.locator('.post-page .post-details .section-head').first().click();

// ---- A record ----
if (await win.locator('.content-collection-open[data-collection="projects"]').count()) {
  await open('projects', 'Tableware for Kōwhai Café');
  await shot('record', bodyShows('Eighty place'), LIGHT);
}

// ---- The post gone while its text is not saved ----
await open('posts', 'Opening the kiln after the spring glaze firing');
await typeThen([{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_kiln0001' }]);
await until(() => win.locator('.post-problem').isVisible(), 'the gone note');
await win.evaluate(() => document.activeElement?.blur());
await win.locator('.post-scroll').evaluate((el) => (el.scrollTop = 0));
await pause(400);
await shot('problem-gone', async () => /no longer in the project/.test(await win.locator('.post-problem').innerText()), LIGHT);
await win.getByRole('button', { name: /Discard/ }).click();
await pause(600);

// ---- Narrow: a small window, a published entry and a draft ----
await open('posts', 'Open studio weekend');
await win.setViewportSize({ width: 960, height: 900 });
await pause(600);
await shot('narrow', bodyShows('three hundred'), LIGHT, { whole: true });
await open('case-studies', 'A dinner service for the harbour restaurant');
await shot('narrow-draft', bodyShows('harbour on a grey'), LIGHT, { whole: true });

if (errors.length) console.log('page errors:', errors.join('\n'));
await app.close();
rmSync(WORK, { recursive: true, force: true });
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`wrote ${written.length} captures; ${files.length} PNGs in ${OUT}`);
