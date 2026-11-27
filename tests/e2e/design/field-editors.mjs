// Field editors capture harness: drives the real (built) app through the states of the Inspector's content field
// editors (the link editor with its page, section and document pickers, the image field, the icon picker, choices,
// repeatable lists and their items, grouped fields, and the contact mismatch repair) and writes one PNG per state and
// theme, cropped to the dock around the field. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/field-editors.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('field editors capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-fields-')));
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
async function shot(state, target, verify, themes = LIGHT) {
  await target.first().scrollIntoViewIfNeeded();
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(220);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const dock = await win.locator('.dock').boundingBox();
    const box = await target.first().boundingBox();
    if (!dock || !box) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    const top = Math.max(dock.y, box.y - 44);
    const bottom = Math.min(dock.y + dock.height, box.y + box.height + 44);
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
      const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop, value }] }, { label: 'Seed field' });
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
const row = (text) => insp.locator('.list-editor-item', { has: win.locator('button.title', { hasText: text }) }).first();
async function openRow(text) {
  const head = row(text).locator('button.title');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await until(async () => (await head.getAttribute('aria-expanded')) === 'true', `${text} to open`);
  await pause(200);
}
async function closeRow(text) {
  const head = row(text).locator('button.title');
  if ((await head.getAttribute('aria-expanded')) === 'true') await head.click();
  await pause(120);
}

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
const ids = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const byRoute = (r) => Object.values(s.state.pages).find((p) => p.route === r)?.id;
  return { home: s.state.site.homePageId, about: byRoute('/about/') ?? byRoute('/about'), contact: byRoute('/contact/') ?? byRoute('/contact') };
});
if (!ids.about) throw new Error('the starter has no About page');

// A real document in the library, with the long kind of name people's files have.
const pdfPath = join(WORK, 'Harbour-Lane-Studio-renovation-price-guide-and-terms-2026.pdf');
writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n');
const docId = await win.evaluate(async (p) => (await window.builder.project.importAssets([p], 'document')).assetIds[0], pdfPath);
if (!docId) throw new Error('the document did not import');
await until(() => win.evaluate(async (id) => !!(await window.builder.project.snapshot()).state.assets.assets[id], docId), 'the document to arrive');

// A photo with no suggested description, so choosing it keeps the previous one and flags it for checking.
const photoName = await win.evaluate(async () => {
  const r = await window.builder.project.apply({ operations: [{ type: 'asset.update', assetId: 'a_dining', altSuggestion: '' }] }, { label: 'Seed photo' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (await window.builder.project.snapshot()).state.assets.assets.a_dining.name;
});

// ---- The link editor, on the hero's primary button ----
await select('Split hero');
const primary = group('Primary button');
await primary.waitFor({ timeout: 15000 });
const linkType = insp.getByRole('combobox', { name: 'Primary button link type' });
const typeIs = (t) => async () => (await linkType.inputValue()) === t;
const HERO = 'hero.split';

await setProp(HERO, 'primaryLink', { type: 'none', target: '' });
await until(typeIs('none'), 'No link');
await shot('link-none-unlinked', primary, async () => (await primary.innerText()).includes('No link') || (await linkType.inputValue()) === 'none', BOTH);

await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about, newTab: true });
await until(typeIs('page'), 'a page link');
await shot('link-page-section', primary, async () => (await insp.getByRole('combobox', { name: 'Primary button section on the page' }).count()) === 1, BOTH);

await setProp(HERO, 'primaryLink', { type: 'url', target: 'https://www.harbourlanestudio.example/projects/renovation-guide?utm_source=brochure&utm_campaign=spring', newTab: true });
await until(typeIs('url'), 'a web address');
await shot('link-url-long', primary, async () => (await insp.getByRole('textbox', { name: 'Primary button web address' }).inputValue()).includes('harbourlane'));

await setProp(HERO, 'primaryLink', { type: 'email', target: 'hello@harbourlanestudio.example' });
await until(typeIs('email'), 'an email link');
await shot('link-email', primary, async () => (await insp.getByRole('textbox', { name: 'Primary button email address' }).inputValue()).includes('@'));

await setProp(HERO, 'primaryLink', { type: 'tel', target: '+15550134' });
await until(typeIs('tel'), 'a phone link');
await shot('link-phone', primary, async () => (await insp.getByRole('textbox', { name: 'Primary button phone number' }).inputValue()) === '+15550134');

await setProp(HERO, 'primaryLink', { type: 'document', target: docId });
await until(typeIs('document'), 'a document link');
await shot('link-document', primary, async () => (await primary.locator('.insp-link-file').innerText()).includes('download'), BOTH);

await setProp(HERO, 'primaryLink', { type: 'anchor', target: 'renovation-guide' });
await until(typeIs('anchor'), 'an anchor link');
await shot('link-anchor-not-found', primary, async () => (await insp.getByRole('combobox', { name: 'Primary button section', exact: true }).inputValue()) === '#renovation-guide' && (await primary.innerText()).includes('isn’t on this page'), BOTH);

await setProp(HERO, 'primaryLink', { type: 'page', target: ids.about, anchor: 'spring-offer' });
await until(typeIs('page'), 'a page link to a gone section');
await shot('link-page-missing-section', primary, async () => (await primary.innerText()).includes('isn’t on About'));
await setProp(HERO, 'primaryLink', { type: 'anchor', target: 'renovation-guide' });
await until(typeIs('anchor'), 'the anchor link back');

await insp.getByRole('combobox', { name: 'Primary button section', exact: true }).selectOption('\u0000other');
const typedId = insp.getByRole('textbox', { name: 'Primary button section', exact: true });
await typedId.waitFor({ timeout: 8000 });
await shot('link-section-typing', primary, async () => await typedId.evaluate((el) => el === document.activeElement));
await win.keyboard.press('Escape');
await pause(200);

await setProp(HERO, 'primaryLink', { type: 'page', target: ids.home });
await until(typeIs('page'), 'the page link back');

// The whole Content section: grouped fields as they sit together.
await shot('groups-hero-content', insp.locator('.section', { hasText: 'Primary button' }).first(), async () => await group('Secondary button').isVisible());

// ---- The image field ----
const image = insp.locator('.insp-image').first();
await image.waitFor({ timeout: 15000 });
const heroImage = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'hero.split');
  return node.props.image;
});
await shot('image-populated', image, async () => (await image.locator('.insp-image-name').innerText()).length > 0 && (await image.getByRole('button', { name: /Change/ }).count()) === 1, BOTH);

await image.getByRole('button', { name: /Change/ }).click();
await image.locator('.insp-pick-grid').waitFor({ timeout: 8000 });
await pause(600);
await shot('image-browsing', image, async () => (await image.locator('.insp-pick-tile').count()) >= 6, BOTH);

const search = image.getByRole('searchbox', { name: 'Search images' });
await search.fill('zzz');
await shot('image-browse-no-match', image, async () => (await image.innerText()).includes('match'));
await search.fill('');
// Choosing a picture with no suggested description keeps the old one, flagged until it is checked.
await image.locator('.insp-pick-tile', { hasText: photoName }).first().click();
await until(async () => (await image.locator('.insp-image-name').innerText()).includes(photoName), 'the new image');
await pause(300);
await shot('image-carried-description', image, async () => await image.locator('.insp-check').isVisible());

await setProp(HERO, 'image', { ...heroImage, decorative: true });
await until(async () => (await image.getByRole('switch', { name: 'Decorative image' }).getAttribute('aria-checked')) === 'true', 'decorative');
await shot('image-decorative', image, async () => (await image.locator('textarea').count()) === 0);

await setProp(HERO, 'image', { assetId: null, alt: '' });
await until(async () => (await image.locator('.insp-image-name').innerText()).includes('No image'), 'no image');
await shot('image-empty', image, async () => (await image.getByRole('button', { name: /Choose image/ }).count()) === 1, BOTH);
await setProp(HERO, 'image', heroImage);

// ---- Repeatable lists and the icon picker, on the services grid ----
await select('Services grid');
const cards = insp.locator('[data-list="items"]');
await cards.waitFor({ timeout: 15000 });
await setProp('features.grid', 'items', [
  { id: 'c1', icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.', linkLabel: 'How we plan', link: { type: 'page', target: ids.about } },
  { id: 'c2', icon: 'ruler', title: 'Design and full technical documentation for builders and council approval', description: 'Drawings, materials and finishes.', linkLabel: '', link: { type: 'none', target: '' } },
  { id: 'c3', icon: 'hammer', title: 'Delivery', description: 'On site from first fix to handover.', linkLabel: 'See a project', link: { type: 'url', target: 'https://example.com/work' } },
  { id: 'c4', icon: 'sparkles', title: '', description: 'A card with no title yet.', linkLabel: '', link: { type: 'none', target: '' } }
]);
await until(async () => (await cards.locator('.list-editor-item').count()) === 4, 'four cards');
await shot('list-collapsed', cards, async () => (await cards.locator('.insp-count').innerText()).includes('4'), BOTH);

await openRow('Planning');
await shot('list-item-open', cards, async () => (await cards.locator('.list-editor-body:not([hidden])').count()) === 1, BOTH);

// Keyboard focus on a row's move control.
await row('Delivery').getByRole('button', { name: /^Move Delivery up$/ }).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('list-keyboard-focus', cards, () => win.evaluate(() => /^Move Delivery/.test(document.activeElement?.getAttribute('aria-label') ?? '') && document.activeElement.matches(':focus-visible')));
await win.evaluate(() => document.activeElement?.blur());

// ---- The icon picker, inside the open card; it opens as a popover over the Inspector ----
const icon = row('Planning').locator('.insp-icon-picker');
const iconPop = win.locator('.insp-icon-pop');
await shot('icon-closed', icon, async () => (await icon.locator('.insp-icon-btn').innerText()).includes('Compass'));
await icon.locator('.insp-icon-btn').click();
await iconPop.locator('.insp-icon-list').waitFor({ timeout: 8000 });
await pause(300);
await shot('icon-open', iconPop, async () => (await iconPop.locator('.insp-icon-tile').count()) > 12, BOTH);
await iconPop.getByRole('searchbox', { name: 'Search icons' }).fill('arrow');
await pause(200);
await shot('icon-search', iconPop, async () => (await iconPop.locator('.insp-icon-tile').count()) >= 1);
await iconPop.getByRole('searchbox', { name: 'Search icons' }).fill('zzzz');
await pause(200);
await shot('icon-no-match', iconPop, async () => (await iconPop.innerText()).includes('No icons match'));
await iconPop.getByRole('searchbox', { name: 'Search icons' }).fill('');
await iconPop.locator('.insp-icon-list').waitFor({ timeout: 4000 });
await iconPop.locator('.insp-icon-tile[aria-selected="true"]').focus();
await win.keyboard.press('ArrowRight');
await shot('icon-keyboard-focus', iconPop, () => win.evaluate(() => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.matches(':focus-visible')));
await win.keyboard.press('Escape');
await pause(150);

// A link group inside a list item, under its straight divider.
await shot('group-in-list-item', row('Planning'), async () => (await row('Planning').locator('fieldset.insp-group').count()) >= 1);
await closeRow('Planning');

// A list at its maximum: Add stays focusable and says why.
await setProp('features.grid', 'items', Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, icon: 'sparkles', title: `Service ${i + 1}`, description: '', linkLabel: '', link: { type: 'none', target: '' } })));
await until(async () => (await cards.locator('.list-editor-item').count()) === 12, 'twelve cards');
await shot('list-at-max', cards, async () => (await cards.innerText()).toLowerCase().includes('at most') || (await cards.locator('.insp-add[aria-disabled="true"]').count()) === 1);

// ---- A gallery list: rows named by their pictures ----
await select('Gallery');
const gallery = insp.locator('[data-list="images"]');
await gallery.waitFor({ timeout: 15000 });
await shot('list-gallery-thumbs', gallery, async () => (await gallery.locator('.list-editor-thumb').count()) >= 1, BOTH);

// ---- The contact mismatch repair ----
await insert('contact details', 'Contact details');
const methods = insp.locator('[data-list="items"]');
await methods.waitFor({ timeout: 15000 });
await setProp('contact.details', 'items', [
  { id: 'e1', icon: 'mail', label: 'Email', value: 'hello@harbourlanestudio.example', link: { type: 'email', target: 'enquiries@previous-studio-name.example' } },
  { id: 'e2', icon: 'phone', label: 'Phone', value: '+1 555 0134', link: { type: 'tel', target: '+15550199' } },
  { id: 'e3', icon: 'map-pin', label: 'Studio', value: '12 Harbour Lane, Millbrook', link: { type: 'none', target: '' } }
]);
await until(async () => (await methods.locator('.list-editor-item').count()) === 3, 'three contact methods');
await openRow('Email');
const mismatch = row('Email').locator('.contact-mismatch');
await mismatch.waitFor({ timeout: 10000 });
await shot('contact-mismatch-email', row('Email'), async () => (await mismatch.innerText()).includes('previous-studio-name'), BOTH);
await closeRow('Email');
await openRow('Phone');
const phoneNote = row('Phone').locator('.contact-mismatch');
await phoneNote.waitFor({ timeout: 10000 });
await shot('contact-mismatch-phone', phoneNote, async () => (await phoneNote.innerText()).includes('number'));
await closeRow('Phone');

// ---- Choices, on a contact form's single-choice field ----
await insert('contact form', 'Contact form');
const fields = insp.locator('[data-list="fields"]');
await fields.waitFor({ timeout: 15000 });
const choiceField = (options) => [
  { id: 'f1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
  { id: 'f2', label: 'What are you planning?', name: 'planning', type: 'choice', required: true, placeholder: '', options }
];
await setProp('contact.form', 'fields', choiceField([
  { id: 'o1', label: 'A full renovation', value: 'Renovation' },
  { id: 'o2', label: 'A new kitchen or bathroom', value: 'A new kitchen or bathroom' },
  { id: 'o3', label: 'An extension with planning permission and structural drawings', value: 'An extension with planning permission and structural drawings' },
  { id: 'o4', label: 'Not sure yet', value: 'Not sure yet' }
]));
await until(async () => (await fields.locator('.list-editor-item').count()) === 2, 'two form fields');
await openRow('What are you planning');
const choices = insp.locator('.choices-editor');
await choices.waitFor({ timeout: 10000 });
await shot('choices-populated', choices, async () => (await choices.innerText()).includes('Sent as'), BOTH);

const addChoice = choices.getByRole('textbox', { name: 'New choice' });
await addChoice.fill('Not sure yet');
await addChoice.press('Enter');
await choices.locator('.field-error').waitFor({ timeout: 5000 });
await shot('choices-duplicate', choices, async () => (await choices.locator('.field-error').innerText()).includes('already'));
await addChoice.fill('');

await setProp('contact.form', 'fields', choiceField([]));
await until(async () => (await choices.locator('.choices-row').count()) === 0, 'no choices');
await shot('choices-empty', choices, async () => (await choices.innerText()).includes('No choices yet'), BOTH);

await setProp('contact.form', 'fields', choiceField(Array.from({ length: 24 }, (_, i) => ({ id: `x${i}`, label: `Answer ${i + 1}`, value: `Answer ${i + 1}` }))));
await until(async () => (await choices.locator('.choices-row').count()) === 24, 'a full set of choices');
await shot('choices-full', choices.locator('.choices-add').locator('..'), async () => (await addChoice.evaluate((el) => el.readOnly)) && (await choices.innerText()).includes('are in use'));

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`field editors capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
