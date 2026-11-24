// Search & sharing shows how a shared link to a page looks, and whose sharing image it carries (#221). A page's own
// photo (set here or by the AI) is visible in its panel with the picture, the title and the description a link
// preview would carry; a page without one shows the site's, labelled as the site's; Use the site's image clears the
// override; and the exported pages carry the same og:image addresses, after the project is closed and opened again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('page-sharing');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'harbour-lane-studio');

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const pageFile = (id) => JSON.parse(readFileSync(join(dir, 'siteorigin/pages', `${id}.json`), 'utf8'));
const siteFile = () => JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));
const pageBy = async (title) => Object.values((await snapshot()).state.pages).find((p) => p.title === title);

const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const openPage = async (title) => {
  await openRail('Pages');
  await win.locator('.pages-list [role="option"]', { hasText: title }).first().click();
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), new RegExp(title), `${title} is open`));
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
  await section().locator('.share-card').waitFor();
};
const section = () => win.locator('#dock-panel-inspect .section', { has: win.locator('button.section-head', { hasText: 'Search & sharing' }) });
const card = () => section().locator('.share-card');
const picker = () => section().locator('.insp-image');
const chooser = () => picker().locator('.insp-image-top .btn', { hasText: /Choose image…|Change…/ });
const back = () => picker().locator('.insp-image-top .btn:not([aria-expanded])', { hasText: /Use the site’s image|Remove image/ });
const imageName = () => picker().locator('.insp-image-name');
const cardText = async () => ({ host: await card().locator('.share-card-host').innerText(), title: await card().locator('.share-card-title').innerText(), description: await card().locator('.share-card-desc').innerText() });
const focusedLabel = () => win.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
/** A picture that has really loaded, and which asset's file it is. */
const loaded = async (img, file) => {
  await eventually(async () => assert.match((await img.getAttribute('src')) ?? '', file));
  await eventually(async () => assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth > 0), 'the picture has loaded'));
};
const cardImage = () => card().locator('.share-card-image img');
const pickerThumb = () => picker().locator('.insp-image-thumb img');
const field = (label) => section().locator('.field', { has: win.locator('label', { hasText: label }) });

/** Choose an image from the library browser opened by the chooser. */
async function choose(name) {
  await chooser().click();
  await picker().locator('.insp-pick-tile', { hasText: new RegExp(`^${name}$`) }).click();
  await eventually(async () => assert.equal(await picker().locator('.insp-pick').count(), 0, 'the library browser closes once an image is chosen'));
}

step('a page whose own photo was set outside the panel: the panel shows it');
const add = await apply([{ type: 'page.create', title: 'Kitchens', route: '/kitchens/', starter: 'intro' }], 'Add page');
assert.ok(add.ok, JSON.stringify(add));
const kitchens = (await pageBy('Kitchens')).id;
const home = (await snapshot()).state.site.homePageId;
const about = (await pageBy('About')).id;
// The same edit the AI makes when asked to use the Kitchen photo for this page only.
const set = await apply([{ type: 'page.update', pageId: kitchens, socialImage: 'a_kitchen' }], 'Use the Kitchen photo for Kitchens');
assert.ok(set.ok, JSON.stringify(set));
assert.equal(siteFile().socialImage ?? null, null, 'the site-wide image stays unset');
await openPage('Kitchens');
await eventually(async () => assert.equal(await imageName().innerText(), 'Kitchen', 'the picker names the page’s own photo'));
await loaded(cardImage(), /kitchen/);
await loaded(pickerThumb(), /kitchen/);
const siteDescription = (await snapshot()).state.site.description;
assert.ok(siteDescription, 'the starter site has a description');
assert.deepEqual(await cardText(), { host: 'No usable public URL', title: 'Kitchens · Harbour Lane Studio', description: siteDescription }, 'the preview shows the page’s title and the site’s description');
assert.match(await section().locator('.scope').innerText(), /Own sharing image/, 'the closed heading says the page has its own image');
assert.match(await section().innerText(), /This page’s own choice/, 'it says the image is this page’s own');
assert.equal(await picker().getByLabel('Image description').count(), 0, 'a sharing image has no description to write');
assert.equal(await picker().getByRole('switch', { name: 'Decorative image' }).count(), 0, 'and is never decorative');
assert.match(await section().innerText(), /no usable public URL/, 'it says the image address needs a public URL');
assert.equal(await back().innerText(), 'Remove image', 'with no site image there is nothing to return to, so it offers Remove');
await section().scrollIntoViewIfNeeded();
await win.screenshot({ path: join(SHOTS, 'page-sharing-own.png') });

step('the preview follows the title and description typed for the page, and falls back when they are cleared');
await field('Browser title').getByRole('textbox').fill('Our kitchens');
await field('Browser title').getByRole('textbox').press('Tab');
await field('Description').getByRole('textbox').fill('Oak, steel and stone.');
await field('Description').getByRole('textbox').press('Tab');
await eventually(async () => assert.deepEqual(await cardText(), { host: 'No usable public URL', title: 'Our kitchens', description: 'Oak, steel and stone.' }));
await field('Browser title').getByRole('textbox').fill('');
await field('Browser title').getByRole('textbox').press('Tab');
await field('Description').getByRole('textbox').fill('');
await field('Description').getByRole('textbox').press('Tab');
await eventually(async () => assert.deepEqual(await cardText(), { host: 'No usable public URL', title: 'Kitchens · Harbour Lane Studio', description: siteDescription }));

step('Open Site details under the address note goes to the Public URL');
await section().getByRole('button', { name: 'Open Site details' }).click();
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.id), 'site-public-url', 'the Public URL field has the cursor'));
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();

step('two pages with different photos, chosen from the visual picker');
await openPage('About');
assert.equal(await imageName().innerText(), 'No sharing image', 'About has none, and the site has none');
assert.equal(await card().locator('.share-card-image.empty').count(), 1, 'the preview says there is no picture');
await choose('Bedroom');
await eventually(() => assert.equal(pageFile(about).seo.socialImage, 'a_bedroom', 'About is saved with the Bedroom photo'));
await eventually(async () => assert.equal(await imageName().innerText(), 'Bedroom'));
await loaded(cardImage(), /bedroom/);
await loaded(pickerThumb(), /bedroom/);
assert.equal(pageFile(kitchens).seo.socialImage, 'a_kitchen', 'Kitchens keeps its own');

step('an open picker closes when another page opens');
await chooser().click();
await picker().locator('.insp-pick').waitFor();
await openPage('Kitchens');
assert.equal(await picker().locator('.insp-pick').count(), 0, 'Kitchens opens with its picker closed');
assert.equal(await imageName().innerText(), 'Kitchen');

step('the site’s image and public URL, set from the page panel, and a page that follows them');
await win.getByRole('button', { name: 'Change the site’s sharing image' }).click();
const detailsField = win.locator('#dock-panel-styles select[data-site-field="socialImage"]');
await detailsField.waitFor({ state: 'visible' });
await eventually(async () => assert.equal(await detailsField.evaluate((el) => el === document.activeElement), true, 'Site details opens with the sharing image under the cursor'));
await detailsField.selectOption('a_studio');
await eventually(() => assert.equal(siteFile().socialImage, 'a_studio'));
const url = win.locator('#dock-panel-styles .field', { has: win.locator('label', { hasText: 'Public URL' }) }).getByRole('textbox', { name: 'Public URL', exact: true });
await url.fill('https://studio.example/work/');
await url.press('Tab');
await eventually(() => assert.equal(siteFile().baseUrl, 'https://studio.example/work'));
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();

await openPage('Home');
await eventually(async () => assert.equal(await imageName().innerText(), 'Studio table', 'Home shows the site’s image'));
assert.match(await picker().innerText(), /The site’s sharing image\./, 'it says whose image it is');
assert.match(await section().innerText(), /has no image of its own, so a shared link shows the site’s sharing image/);
assert.equal(pageFile(home).seo.socialImage, undefined, 'Home stores no image of its own');
assert.equal(await back().count(), 0, 'there is nothing to clear on a page that follows the site');
assert.equal(await chooser().innerText(), 'Choose image…');
await loaded(cardImage(), /studio/);
await loaded(pickerThumb(), /studio/);
assert.equal((await cardText()).host, 'studio.example', 'the preview names the public URL’s host');
assert.equal((await cardText()).title, 'Harbour Lane Studio', 'the home page is titled with the site name');
await win.screenshot({ path: join(SHOTS, 'page-sharing-site-default.png') });

await openPage('Kitchens');
assert.equal(await imageName().innerText(), 'Kitchen');
await loaded(cardImage(), /kitchen/);
assert.equal(await back().innerText(), 'Use the site’s image', 'Kitchens can return to the site’s image');
assert.match(await section().innerText(), /Pages without their own image show the site’s sharing image, Studio table\./);
assert.equal(await section().getByText(/no usable public URL/).count(), 0, 'the address note goes once the site has a public URL');

step('replacing a page’s own photo with another from the library');
await choose('Dining room');
await eventually(() => assert.equal(pageFile(kitchens).seo.socialImage, 'a_dining', 'Kitchens is saved with the new photo'));
await eventually(async () => assert.equal(await imageName().innerText(), 'Dining room'));
await loaded(cardImage(), /dining/);
await choose('Kitchen');
await eventually(() => assert.equal(pageFile(kitchens).seo.socialImage, 'a_kitchen', 'and with its own photo again'));

step('choosing the photo the page already shows from the site keeps it for this page when the site’s image changes');
const contact = (await pageBy('Contact')).id;
await openPage('Home');
await choose('Studio table');
await eventually(() => assert.equal(pageFile(home).seo.socialImage, 'a_studio', 'Home now holds the choice itself, though the site already had it'));
assert.equal(await back().innerText(), 'Use the site’s image', 'and can return to following the site');
await win.getByRole('button', { name: 'Change the site’s sharing image' }).click();
await win.locator('#dock-panel-styles select[data-site-field="socialImage"]').selectOption('a_dining');
await eventually(() => assert.equal(siteFile().socialImage, 'a_dining'));
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await openPage('Home');
assert.equal(await imageName().innerText(), 'Studio table', 'Home keeps what it chose');
await loaded(cardImage(), /studio/);
await openPage('Contact');
await eventually(async () => assert.equal(await imageName().innerText(), 'Dining room', 'a page that follows the site moves with it'));
await loaded(cardImage(), /dining/);
assert.equal(pageFile(contact).seo.socialImage, undefined);
// Back to following the site, with Studio table as the site's image, and Kitchens on its own photo, for the rest.
await openPage('Home');
await back().click();
await eventually(() => assert.equal(pageFile(home).seo.socialImage, undefined, 'Home follows the site again'));
await eventually(async () => assert.equal(await imageName().innerText(), 'Dining room'));
await win.getByRole('button', { name: 'Change the site’s sharing image' }).click();
await win.locator('#dock-panel-styles select[data-site-field="socialImage"]').selectOption('a_studio');
await eventually(() => assert.equal(siteFile().socialImage, 'a_studio'));
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await openPage('Home');
await eventually(async () => assert.equal(await imageName().innerText(), 'Studio table'));

step('Use the site’s image clears the override from the keyboard, and undo and redo follow');
await openPage('Kitchens');
assert.equal(await imageName().innerText(), 'Kitchen');
await back().focus();
await win.keyboard.press('Enter');
await eventually(() => assert.equal(pageFile(kitchens).seo.socialImage, undefined, 'the page’s own image is gone from its file'));
await eventually(async () => assert.equal(await imageName().innerText(), 'Studio table', 'Kitchens now shows the site’s image'));
await loaded(cardImage(), /studio/);
await eventually(async () => assert.equal(await focusedLabel(), 'Choose image…', 'focus lands on the chooser when the button goes'));
assert.equal(await section().locator('.scope').count(), 0, 'the closed heading no longer mentions an own image');
assert.equal(pageFile(about).seo.socialImage, 'a_bedroom', 'About keeps Bedroom');
assert.equal(siteFile().socialImage, 'a_studio', 'the site keeps its image');
const undone = await win.evaluate(() => window.builder.project.undo());
assert.ok(undone.ok, JSON.stringify(undone));
await eventually(async () => assert.equal(await imageName().innerText(), 'Kitchen', 'undo brings the own image back'));
await loaded(cardImage(), /kitchen/);
assert.equal(pageFile(kitchens).seo.socialImage, 'a_kitchen');
const redone = await win.evaluate(() => window.builder.project.redo());
assert.ok(redone.ok, JSON.stringify(redone));
await eventually(async () => assert.equal(await imageName().innerText(), 'Studio table', 'redo clears it again'));
await loaded(cardImage(), /studio/);
assert.equal(pageFile(kitchens).seo.socialImage, undefined);
// Left with its own image again, as the closing checks expect.
await choose('Kitchen');
await eventually(() => assert.equal(pageFile(kitchens).seo.socialImage, 'a_kitchen'));

step('the project closed and opened again: every page still says the same');
const closed = await win.evaluate(() => window.builder.projects.close());
assert.ok(closed === undefined || closed?.ok !== false, JSON.stringify(closed));
await win.waitForSelector('.welcome');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(reopened.ok, JSON.stringify(reopened));
await win.waitForSelector('.editor');
await openPage('Kitchens');
await eventually(async () => assert.equal(await imageName().innerText(), 'Kitchen'));
await loaded(cardImage(), /kitchen/);
assert.equal(await back().innerText(), 'Use the site’s image');
await openPage('About');
await eventually(async () => assert.equal(await imageName().innerText(), 'Bedroom'));
await loaded(cardImage(), /bedroom/);
await openPage('Home');
await eventually(async () => assert.equal(await imageName().innerText(), 'Studio table'));
await loaded(cardImage(), /studio/);
assert.match(await picker().innerText(), /The site’s sharing image\./);
assert.equal((await cardText()).host, 'studio.example');

step('the exported pages carry the same og:image addresses');
const out = join(WORK, 'export');
const r = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), out), 300000, 'Static export');
assert.equal(r.ok, true, `static export succeeds: ${r.message} ${r.warnings?.join(' ') ?? ''}`);
const assets = (await snapshot()).state.assets.assets;
const expected = (id) => `https://studio.example/work/${assets[id].file.replace(/^static\//, '')}`;
const ogImages = (route) => {
  const html = readFileSync(join(out, route, 'index.html'), 'utf8');
  return [...html.matchAll(/<meta property="og:image" content="([^"]*)"/g)].map((m) => m[1]);
};
assert.deepEqual(ogImages('kitchens'), [expected('a_kitchen')], 'Kitchens is shared with its own photo');
assert.deepEqual(ogImages('about'), [expected('a_bedroom')], 'About is shared with its own photo');
assert.deepEqual(ogImages(''), [expected('a_studio')], 'Home is shared with the site’s image');
assert.notEqual(expected('a_kitchen'), expected('a_bedroom'));

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npage-sharing: passed');
