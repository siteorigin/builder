// Automatic lists capture harness: drives the real (built) app through the Inspector's lists that fill themselves (a
// feed of a collection's posts, a news list of dated articles, an article header showing the page it is on) and the
// Choices editor of a form's single-choice field, and writes one PNG per state and theme, cropped to the dock around
// the field. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/automatic-lists.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('automatic lists capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-feeds-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1400 });
await win.waitForSelector('.welcome', { timeout: 120000 });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const insp = win.locator('#dock-panel-inspect');

async function until(check, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}

/** Capture the dock's width around `target`, in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, target, verify, themes = LIGHT) {
  await target.first().scrollIntoViewIfNeeded();
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await win.mouse.move(2, 700);
    await pause(220);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const dock = await win.locator('.dock').boundingBox();
    const box = await target.first().boundingBox();
    if (!dock || !box) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    const top = Math.max(dock.y, box.y - 36);
    const bottom = Math.min(dock.y + dock.height, box.y + box.height + 36);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: dock.x, y: top, width: dock.width, height: bottom - top } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(100);
}

const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
  await pause(350);
  return r;
};

/** Set a prop of the first `componentId` section on a page, through the same edit the Inspector sends. */
async function setProp(componentId, prop, value, pageId) {
  await win.evaluate(
    async ({ componentId, prop, value, pageId }) => {
      const s = await window.builder.project.snapshot();
      const page = s.state.pages[pageId ?? s.state.site.homePageId];
      const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === componentId);
      if (!node) throw new Error(`no ${componentId} on ${page.title}`);
      const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop, value }] }, { label: 'Seed field' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    },
    { componentId, prop, value, pageId }
  );
  await pause(450);
}

const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};

async function select(name) {
  await openRail('Layers');
  await win.locator('.list-item', { hasText: name }).first().click();
  await insp.locator('.insp-name h3', { hasText: name }).waitFor({ timeout: 30000 });
  await pause(350);
}

async function insert(search, name) {
  await openRail('Insert');
  await win.getByLabel('Search items to add').fill(search);
  await until(async () => new RegExp(`^${name}`).test(await win.getByRole('listbox', { name: 'Results' }).getByRole('option').first().innerText()), `the ${name} result`);
  await win.getByLabel('Search items to add').press('Enter');
  await insp.locator('.insp-name h3', { hasText: name }).waitFor({ timeout: 45000 });
  await pause(500);
}

async function openPage(title) {
  await openRail('Pages');
  await win.locator('.side-panel [data-page]', { hasText: title }).first().click();
  await pause(900);
}

/** The Content section that holds the automatic list, settings and all. */
const contentOf = (selector) => insp.locator('.section', { has: win.locator(selector) }).first();
const FEED = '.computed-list[data-list="items"]';
const ARTICLE = '.computed-list[data-list="article"]';

// ---- Project ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 180000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
  localStorage.setItem('section:content', '1');
});

// ---- A post feed before the project has a blog ----
await insert('post grid', 'Post grid');
const feed = insp.locator('.computed-list[data-list="items"]');
await feed.waitFor({ timeout: 15000 });
await shot('feed-no-collection', contentOf(FEED), async () => (await feed.innerText()).toLowerCase().includes('no blog'), BOTH);

// ---- The blog: fourteen posts, two of them drafts, two categories ----
const posts = [
  ['Choosing paint for a north-facing room', '2026-10-02', false, 'Mere Tane'],
  ['We’re opening a Wellington studio', '2026-11-18', true, 'Sam Okafor'],
  ['Kōwhai Street apartment: before and after', '2026-09-14', false, 'Mere Tane'],
  ['Five fabrics that survive a family', '2026-08-30', false, 'Ana Lima'],
  ['Lighting a hallway with no windows', '2026-08-03', false, 'Sam Okafor'],
  ['Notes from the Milan furniture fair', '2026-04-22', false, 'Ana Lima'],
  ['How we price a renovation', '2026-03-11', false, 'Mere Tane'],
  ['Draft: winter colour forecast', '2026-11-20', true, 'Ana Lima'],
  ['Harbourside café refit', '2026-02-07', false, 'Sam Okafor'],
  ['Small bathrooms, big tiles', '2026-01-19', false, 'Mere Tane'],
  ['A guide to sustainable timber finishes for floors, decks and joinery', '2026-09-20', false, 'Ana Lima'],
  ['Our year in projects', '2025-11-28', false, 'Sam Okafor'],
  ['Studio holiday hours', '2025-12-15', false, 'Mere Tane'],
  ['Choosing a kitchen benchtop', '2025-10-09', false, 'Ana Lima']
];
await apply(
  [
    { type: 'collection.create', collectionId: 'posts' },
    ...posts.map(([title, publishedAt, draft, author], i) => ({ type: 'entry.create', collectionId: 'posts', entryId: `en_post${String(i).padStart(2, '0')}`, title, publishedAt, draft, author, excerpt: title, body: [title] }))
  ],
  'Start the blog'
);
await apply(['Renovations', 'Studio news'].map((label) => ({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label })), 'Add categories');
await until(async () => (await feed.locator('li').count()) > 0, 'the feed to fill');
await shot('feed-populated', contentOf(FEED), async () => (await feed.locator('li').count()) >= 3, BOTH);
await shot('feed-list-only', feed, async () => (await feed.locator('li').count()) >= 3, LIGHT);

// Filtered to a category nothing is in yet, chosen by name as an owner does.
await insp.locator('select[data-feed-pick="category"]').selectOption({ label: 'Renovations' });
await until(async () => (await feed.locator('li').count()) === 0, 'the category to empty the feed');
await shot('feed-no-entries', contentOf(FEED), async () => (await feed.innerText()).toLowerCase().includes('nothing published'), BOTH);
await setProp('blog.grid', 'category', '');

// A collection that is not in the project.
await setProp('blog.grid', 'collection', 'case-studies');
await until(async () => (await feed.innerText()).includes('case-studies'), 'the missing collection');
await shot('feed-missing-collection', contentOf(FEED), async () => (await feed.locator('li').count()) === 0, LIGHT);
await setProp('blog.grid', 'collection', '');
await until(async () => (await feed.locator('li').count()) > 0, 'the feed to come back');

// The featured post: a list of at most one.
await insert('featured post', 'Featured post');
const featured = insp.locator('.computed-list[data-list="items"]');
await featured.waitFor({ timeout: 15000 });
await until(async () => (await featured.locator('li').count()) === 1, 'the featured post');
await shot('feed-featured', contentOf(FEED), async () => (await featured.locator('li').count()) === 1, LIGHT);

// ---- A news list, before and after the site has dated articles ----
await insert('news list', 'News list');
const news = insp.locator('.computed-list[data-list="items"]');
await news.waitFor({ timeout: 15000 });
await shot('news-empty', contentOf(FEED), async () => (await news.locator('li').count()) === 0, LIGHT);
await apply(
  [
    ['Spring open studio weekend', '2026-09-28', 'Mere Tane'],
    ['We’ve joined the Master Builders association', '2026-08-12', 'Sam Okafor'],
    ['New showroom hours from October', '2026-07-01', '']
  ].map(([title, articleDate, byline], i) => ({ type: 'page.create', pageId: `pg_news${i}`, title, route: `/news/item-${i}/`, starter: 'article', articleDate, ...(byline ? { byline } : {}), ...(i === 0 ? { excerpt: 'Two days of open doors at the Harbour Lane studio, with samples, sketches and coffee.' } : {}) })),
  'Add articles'
);
await select('News list');
await until(async () => (await news.locator('li').count()) === 3, 'three articles');
await shot('news-populated', contentOf(FEED), async () => (await news.locator('li').count()) === 3, BOTH);

// ---- An article header, on a dated article and on an ordinary page ----
await openPage('Spring open studio weekend');
await select('Article header');
const header = insp.locator('.computed-list[data-list="article"]');
await header.waitFor({ timeout: 15000 });
await shot('article-on-article', contentOf(ARTICLE), async () => (await header.innerText()).includes('page settings'), BOTH);

await openPage('About');
await insert('article header', 'Article header');
await header.waitFor({ timeout: 15000 });
await shot('article-on-page', contentOf(ARTICLE), async () => (await header.innerText()).toLowerCase().includes('dated article'), LIGHT);

// ---- Choices, on a contact form's single-choice field ----
await openPage('Home');
await insert('contact form', 'Contact form');
const fields = insp.locator('[data-list="fields"]');
await fields.waitFor({ timeout: 15000 });
const choiceField = (options) => [
  { id: 'f1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
  { id: 'f2', label: 'What are you planning?', name: 'planning', type: 'choice', required: true, placeholder: '', options }
];
await setProp(
  'contact.form',
  'fields',
  choiceField([
    { id: 'o1', label: 'A full renovation', value: 'Renovation' },
    { id: 'o2', label: 'A new kitchen or bathroom', value: 'A new kitchen or bathroom' },
    { id: 'o3', label: 'An extension with planning permission and structural drawings', value: 'An extension with planning permission and structural drawings' },
    { id: 'o4', label: 'Not sure yet', value: 'Not sure yet' }
  ])
);
await until(async () => (await fields.locator('.list-editor-item').count()) === 2, 'two form fields');
const head = fields.locator('.list-editor-item', { has: win.locator('button.title', { hasText: 'What are you planning' }) }).first().locator('button.title');
if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
const choices = insp.locator('.choices-editor');
await choices.waitFor({ timeout: 10000 });
await pause(300);
await shot('choices-populated', choices, async () => (await choices.innerText()).includes('Renovation'), BOTH);

// Keyboard focus on a row's control.
await choices.getByRole('button', { name: /^Move “Not sure yet” up$/ }).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('choices-keyboard-focus', choices, () => win.evaluate(() => document.activeElement?.matches(':focus-visible') && !!document.activeElement.closest('.choices-editor')));
await win.evaluate(() => document.activeElement?.blur());

const addChoice = choices.getByRole('textbox', { name: 'New choice' });
await addChoice.fill('Not sure yet');
await addChoice.press('Enter');
await choices.locator('.field-error').waitFor({ timeout: 5000 });
await shot('choices-duplicate', choices, async () => (await choices.locator('.field-error').innerText()).includes('already'));
await addChoice.fill('');

await setProp('contact.form', 'fields', choiceField([]));
await until(async () => (await choices.locator('.choices-row').count()) === 0, 'no choices');
await shot('choices-empty', choices, async () => (await choices.innerText()).includes('No choices'), BOTH);

await setProp('contact.form', 'fields', choiceField(Array.from({ length: 24 }, (_, i) => ({ id: `x${i}`, label: `Answer ${i + 1}`, value: `Answer ${i + 1}` }))));
await until(async () => (await choices.locator('.choices-row').count()) === 24, 'a full set of choices');
await shot('choices-full', choices.locator('.choices-add').locator('..'), async () => await addChoice.evaluate((el) => el.readOnly));

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`automatic lists capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
