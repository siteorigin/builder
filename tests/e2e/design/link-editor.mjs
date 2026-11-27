// Link editor capture harness: drives the real (built) app through the states of the Inspector's link property
// editor (each kind of link, the page and section pickers on a site with many pages, a web address with its search
// engine ticks, a destination still to be typed, a typed problem, a gone section or document, a section ID being
// typed, a link inside a list item, and the narrowest Inspector) and writes one PNG per state and theme, cropped to
// the dock around the field. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/link-editor.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('link editor capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-link-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1200 });
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
async function shot(state, target, verify, themes = LIGHT, { below = 36 } = {}) {
  await target.first().scrollIntoViewIfNeeded();
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(220);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const dock = await win.locator('.dock').boundingBox();
    const box = await target.first().boundingBox();
    if (!dock || !box) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    const top = Math.max(dock.y, box.y - 36);
    const bottom = Math.min(dock.y + dock.height, box.y + box.height + below);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: dock.x, y: top, width: dock.width, height: bottom - top } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(100);
}

/** Set a section's prop through the same edit the Inspector sends. */
async function setProp(componentId, prop, value) {
  await win.evaluate(
    async ({ componentId, prop, value }) => {
      const s = await window.builder.project.snapshot();
      const page = s.state.pages[s.state.site.homePageId];
      const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === componentId);
      if (!node) throw new Error(`no ${componentId} on the home page`);
      const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop, value }] }, { label: 'Seed link' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    },
    { componentId, prop, value }
  );
  await pause(350);
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
  await pause(400);
}

const group = (title) => insp.locator('fieldset.insp-group', { has: win.locator('legend', { hasText: title }) }).first();

// ---- Project: a business site with many pages, two of them with one title, and a document ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 180000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
  localStorage.setItem('section:content', '1');
});
await win.evaluate(async () => {
  const pages = [
    ['Services', '/services/'],
    ['Kitchens', '/services/kitchens/'],
    ['Bathrooms', '/services/bathrooms/'],
    ['Extensions and loft conversions for older terraced houses', '/services/extensions/'],
    ['Projects', '/projects/'],
    ['Kitchens', '/projects/kitchens/'],
    ['Harbour Road townhouse', '/projects/harbour-road/'],
    ['Pricing', '/pricing/'],
    ['Journal', '/journal/'],
    ['Careers', '/careers/'],
    ['Privacy policy', '/privacy/'],
    ['Terms', '/terms/'],
    ['Accessibility', '/accessibility/'],
    ['Sustainability', '/sustainability/'],
    ['Team', '/team/'],
    ['Press', '/press/'],
    ['Testimonials', '/testimonials/'],
    ['Frequently asked questions', '/faq/'],
    ['Book a site visit', '/book/'],
    ['Thank you', '/thank-you/']
  ];
  const r = await window.builder.project.apply({ operations: pages.map(([title, route]) => ({ type: 'page.create', title, route })) }, { label: 'Seed pages' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
});
const ids = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const byRoute = (r) => Object.values(s.state.pages).find((p) => p.route === r)?.id;
  return { home: s.state.site.homePageId, about: byRoute('/about/') ?? byRoute('/about'), kitchens: byRoute('/projects/kitchens/') };
});
if (!ids.about || !ids.kitchens) throw new Error('the seeded pages are missing');

const pdfPath = join(WORK, 'Harbour-Lane-Studio-renovation-price-guide-and-terms-2026.pdf');
writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n');
const docId = await win.evaluate(async (p) => (await window.builder.project.importAssets([p], 'document')).assetIds[0], pdfPath);
if (!docId) throw new Error('the document did not import');
await until(() => win.evaluate(async (id) => !!(await window.builder.project.snapshot()).state.assets.assets[id], docId), 'the document to arrive');

// ---- The link editor, on the hero's primary button ----
await select('Split hero');
const primary = group('Primary button');
await primary.waitFor({ timeout: 15000 });
const link = primary.locator('.insp-link');
const HERO = 'hero.split';
// The kind is read from the saved link, so a state is checked against what the project holds.
const saved = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'hero.split');
    return node.props.primaryLink;
  });
const savedIs = (t) => async () => (await saved())?.type === t;
const text = async () => primary.innerText();
const kind = primary.getByRole('combobox', { name: /link type$/i }).or(primary.getByRole('button', { name: /link type/i })).first();

await setProp(HERO, 'primaryLink', { type: 'none', target: '' });
await until(savedIs('none'), 'No link');
await shot('none', primary, async () => (await text()).includes('No link'), BOTH);

await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about, newTab: true });
await until(savedIs('page'), 'a page link');
await shot('page-section', primary, async () => (await text()).includes('About') && (await text()).includes('Top of page'), BOTH);

// A page with a title another page shares: the destination has to say which one.
await setProp(HERO, 'primaryLink', { type: 'page', target: ids.kitchens });
await until(async () => (await saved())?.target === ids.kitchens, 'the Kitchens page link');
await shot('page-duplicate-title', primary, async () => (await text()).includes('Kitchens'));

await setProp(HERO, 'primaryLink', { type: 'url', target: 'https://www.harbourlanestudio.example/projects/renovation-guide?utm_source=brochure&utm_campaign=spring', newTab: true, rel: ['sponsored'] });
await until(savedIs('url'), 'a web address');
await shot('url-rels', primary, async () => (await primary.locator('.link-rels').count()) === 1, BOTH);
// Folded search engine settings open, when they fold.
const more = primary.locator('details.insp-link-more > summary');
if (await more.count()) {
  await more.click();
  await pause(200);
  await shot('url-rels-open', primary, async () => await primary.locator('.link-rel').first().isVisible(), BOTH);
}

await setProp(HERO, 'primaryLink', { type: 'email', target: 'hello@harbourlanestudio.example' });
await until(savedIs('email'), 'an email link');
await shot('email', primary, async () => (await link.locator('input, textarea').first().inputValue()).includes('@'));

await setProp(HERO, 'primaryLink', { type: 'tel', target: '+15550134' });
await until(savedIs('tel'), 'a phone link');
await shot('phone', primary, async () => (await link.locator('input, textarea').first().inputValue()) === '+15550134');

await setProp(HERO, 'primaryLink', { type: 'document', target: docId });
await until(savedIs('document'), 'a document link');
await shot('document', primary, async () => (await text()).includes('download'), BOTH);


await setProp(HERO, 'primaryLink', { type: 'anchor', target: 'renovation-guide' });
await until(savedIs('anchor'), 'an anchor link');
await shot('anchor-not-found', primary, async () => (await text()).includes('isn’t on this page'), BOTH);

await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about, anchor: 'spring-offer' });
await until(async () => (await saved())?.anchor === 'spring-offer', 'a page link to a gone section');
await shot('page-missing-section', primary, async () => (await text()).includes('isn’t on About'));

// Typing a section ID.
await setProp(HERO, 'primaryLink', { type: 'anchor', target: 'renovation-guide' });
await until(savedIs('anchor'), 'the anchor link back');
const other = primary.getByRole('button', { name: /^Type an ID/ });
if (await other.count()) await other.first().click();
else await primary.getByRole('combobox', { name: 'Primary button section', exact: true }).selectOption('\u0000other');
const typedId = link.getByRole('textbox', { name: /section/i }).first();
await typedId.waitFor({ timeout: 8000 });
await shot('section-typing', primary, async () => await typedId.evaluate((el) => el === document.activeElement));
// An ID that can't be used, left with Tab.
await typedId.fill('2025-offer');
await typedId.press('Tab');
await pause(300);
await shot('section-typing-problem', primary, async () => (await primary.locator('.field-error').count()) >= 1);
await typedId.focus();
await win.keyboard.press('Escape');
await pause(200);

// A kind still waiting for its destination, over a saved page link: what visitors get until then is said.
await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about });
await until(savedIs('page'), 'the page link back');
const pickKind = async (label) => {
  if ((await kind.evaluate((el) => el.tagName)) === 'SELECT') await kind.selectOption({ label });
  else {
    await kind.click();
    await win.getByRole('option', { name: label, exact: true }).first().click();
  }
  await pause(300);
};
await pickKind('Web address');
await shot('pending-url', primary, async () => (await text()).includes('Until you choose') || (await text()).includes('still goes'), BOTH);

// The pending address typed wrong and left: the problem, the pending note.
const addr = link.getByRole('textbox').first();
await addr.fill('our contact page');
await addr.press('Tab');
await pause(300);
await shot('pending-url-problem', primary, async () => (await primary.locator('.field-error').count()) >= 1, BOTH);
await addr.focus();
await win.keyboard.press('Escape');
await pause(200);

// A saved address typed over with something that isn't one.
await setProp(HERO, 'primaryLink', { type: 'email', target: 'hello@harbourlanestudio.example' });
await until(savedIs('email'), 'an email link');
const mail = link.getByRole('textbox').first();
await mail.fill('hello at harbourlane');
await mail.press('Tab');
await pause(300);
await shot('email-problem', primary, async () => (await primary.locator('.field-error').count()) >= 1);
await mail.focus();
await win.keyboard.press('Escape');
await pause(200);

// The kind menu open, when it is drawn by the app (a native menu never reaches a screenshot).
await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about });
await until(savedIs('page'), 'the page link');
if ((await kind.evaluate((el) => el.tagName)) !== 'SELECT') {
  await kind.click();
  await pause(300);
  await shot('kind-open', primary, async () => (await win.getByRole('option', { name: 'Web address' }).count()) >= 1, BOTH, { below: 300 });
  await win.keyboard.press('Escape');
  await pause(200);
}
// The page list open, when it is drawn by the app, searched.
const pageBtn = primary.getByRole('button', { name: /page/i }).filter({ hasText: 'About' }).first();
if (await pageBtn.count()) {
  await pageBtn.click();
  await pause(300);
  await shot('page-open', primary, async () => (await win.getByRole('option').count()) >= 10, BOTH, { below: 40 });
  const search = primary.getByRole('combobox', { name: 'Search pages' });
  await search.fill('kitch');
  await search.press('ArrowDown');
  await pause(300);
  await shot('page-search', primary, async () => (await primary.getByRole('listbox').getByRole('option').count()) === 2 && (await search.evaluate((el) => el === document.activeElement)));
  await search.fill('zzz');
  await pause(200);
  await shot('page-no-match', primary, async () => (await primary.innerText()).includes('No pages match'));
  await win.keyboard.press('Escape');
  await pause(200);
}

// A page change that lets a section go says so, quietly, under the page.
await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about, anchor: 'spring-offer' });
await until(async () => (await saved())?.anchor === 'spring-offer', 'a page link with a section');
await primary.getByRole('button', { name: /page/i }).filter({ hasText: 'About' }).first().click();
const find = primary.getByRole('combobox', { name: 'Search pages' });
await find.fill('projects/kitchens');
await find.press('Enter');
await until(async () => (await saved())?.target === ids.kitchens, 'the page change');
await shot('page-change-dropped-section', primary, async () => (await text()).includes('has no “#spring-offer” section'), BOTH);

// The whole Content section: the link editor among its neighbours.
await shot('in-context', insp.locator('.section', { hasText: 'Primary button' }).first(), async () => await group('Secondary button').isVisible());

// ---- A link inside a list item ----
await select('Services grid');
const cards = insp.locator('[data-list="items"]');
await cards.waitFor({ timeout: 15000 });
await setProp('features.grid', 'items', [
  { id: 'c1', icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.', linkLabel: 'How we plan', link: { type: 'page', target: ids.about } },
  { id: 'c2', icon: 'hammer', title: 'Delivery', description: 'On site from first fix to handover.', linkLabel: 'See a project', link: { type: 'url', target: 'https://example.com/work' } }
]);
const card = insp.locator('.list-editor-item', { has: win.locator('button.title', { hasText: 'Planning' }) }).first();
await card.locator('button.title').click();
await pause(300);
const cardLink = card.locator('.insp-link').first();
await cardLink.waitFor({ timeout: 8000 });
await shot('in-list-item', card, async () => await cardLink.isVisible());

// ---- The narrowest Inspector ----
await select('Split hero');
const split = win.getByRole('separator', { name: 'Resize right panel' });
await split.focus();
await win.keyboard.press('Home');
await pause(400);
await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about, anchor: 'spring-offer', newTab: true });
await until(async () => (await saved())?.anchor === 'spring-offer', 'the narrow page link');
await shot('narrow-page-missing-section', primary, async () => (await win.locator('.dock').boundingBox()).width <= 320 && (await text()).includes('isn’t on About'), BOTH);
await setProp(HERO, 'primaryLink', { type: 'url', target: 'https://www.harbourlanestudio.example/projects/renovation-guide', newTab: true, rel: ['nofollow', 'ugc'] });
await until(savedIs('url'), 'the narrow web address');
await shot('narrow-url-rels', primary, async () => (await primary.locator('.link-rels').count()) === 1, BOTH);
await setProp(HERO, 'primaryLink', { type: 'document', target: docId });
await until(savedIs('document'), 'the narrow document');
await shot('narrow-document', primary, async () => (await text()).includes('download'));

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`link editor capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
