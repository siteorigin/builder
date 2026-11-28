// The Posts workspace (#395): a post written in the centred writer with a section heading, a list, a link to a page
// and a library picture with its description and caption; nothing typed is lost when the author switches panels
// straight away; the picture is a use Assets lists and opens; Undo and Redo are the project's; the post is saved as a
// draft, previewed on the canvas in the site's own header and footer, backdated, published and previewed again.
// Its Search & sharing settings keep their fields and length meters, and open the post in the SEO view (#708), where
// its previews follow what is typed (seo-view.mjs).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, answerChoosers, createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('posts');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'harbour-lane-studio');

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const entryFile = (id) => JSON.parse(readFileSync(join(dir, 'siteorigin/collections/posts/entries', `${id}.json`), 'utf8'));
const words = (body) => JSON.stringify(body);
/** A dialog's choice lands once it has closed and the writer has the caret back: typing waits for that. */
const writerFocused = () => eventually(async () => assert.ok(await win.evaluate(() => !!document.activeElement?.classList.contains('post-body')), 'the writer has the caret'));

step('a photo in the library');
const png = await win.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#c25b16';
  g.fillRect(0, 0, 900, 600);
  return c.toDataURL('image/png').split(',')[1];
});
const photoPath = join(WORK, 'kiln.png');
writeFileSync(photoPath, Buffer.from(png, 'base64'));
const imported = await win.evaluate((p) => window.builder.project.importAssets([p]), photoPath);
assert.equal(imported.ok, true, `the photo imports: ${imported.message}`);
const photoId = imported.assetIds[0];

step('a section of Home selected in Layers, as the Inspector shows');
const s0 = await snapshot();
const home = s0.state.pages[s0.state.site.homePageId];
const inspector = win.locator('#dock-panel-inspect');
const inspected = inspector.locator('.insp-name h3');
const placeShown = win.locator('.toolbar .project-title .page');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator(`[role="tree"] [role="treeitem"][data-owner="page:${home.id}"]`).first().click();
await openInspector(win);
const sectionName = await eventually(async () => {
  const t = await inspected.innerText();
  assert.ok(t && t !== home.title, `the Inspector shows the section: ${t}`);
  return t;
});
assert.equal(await placeShown.innerText(), home.title, 'the toolbar names Home');

step('the Content tab starts the blog in one click, and a new post opens the writer');
await win.locator('.rail [aria-label="Content"]').click();
await win.locator('.posts-panel [data-starter="posts"]').click();
await win.locator('.posts-panel').getByRole('button', { name: 'New post' }).click();
await win.getByLabel('New post title').fill('Opening the kiln');
await win.getByRole('button', { name: 'Create draft' }).click();
const body = win.locator('.post-body');
await body.waitFor();
const s1 = await snapshot();
const entryId = Object.keys(s1.state.collections.posts.entries)[0];
assert.ok(entryId, 'the post is in the project');
assert.equal(s1.state.collections.posts.entries[entryId].draft, true, 'a new post is a draft');
assert.equal(await win.locator('.post-row .post-status').innerText(), 'Draft', 'the list says it is a draft');
// The writer has the canvas's place, and the canvas under it takes no input meanwhile.
assert.equal(await win.locator('.post-writer-holder').isVisible(), true);
assert.notEqual(await win.locator('.canvas-holder').getAttribute('inert'), null, 'the canvas is inert while writing');

step('the toolbar and the Inspector speak of the post, never of Home under the writer (#578)');
/** Nothing of a page's in the Inspector: not Home's section, not page settings, no field to change. */
const noPageSettings = async (where) => {
  const text = await inspector.innerText();
  assert.ok(!text.includes(sectionName), `${where}: Home's section is out of the Inspector`);
  assert.ok(!/Home page · \//.test(text), `${where}: Home's page settings are out of the Inspector`);
  assert.equal(await inspector.locator('input, textarea, select, [contenteditable="true"]').count(), 0, `${where}: nothing in the Inspector to change`);
};
/** The toolbar menu's page items that are checked, by their text. */
const checkedPages = async () => {
  await win.locator('.toolbar .project-title').click();
  const menu = win.getByRole('menu');
  await menu.waitFor();
  const checked = await menu.getByRole('menuitemradio', { checked: true }).locator('.grow').allInnerTexts();
  await win.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  return checked;
};
await eventually(async () => assert.equal(await placeShown.innerText(), 'Opening the kiln', 'the toolbar names the post'));
await eventually(async () => assert.equal(await inspected.innerText(), 'Opening the kiln', 'the Inspector names the post'));
assert.match(await inspector.locator('.insp-kind-label').innerText(), /Draft post/);
await noPageSettings('writing');
// The canvas is under the writer: its widths and zoom wait for the preview.
for (const name of ['Desktop', 'Tablet', 'Phone']) assert.equal(await win.locator('.toolbar').getByRole('radio', { name, exact: true }).isDisabled(), true, `${name} waits while writing`);
assert.equal(await win.getByLabel('Preview width in pixels').isDisabled(), true, 'and the width field');
assert.equal(await win.locator('.toolbar .zoom-btn').isDisabled(), true, 'and the zoom');
assert.deepEqual(await checkedPages(), [], 'the toolbar menu checks no page while the post is written');
// No key acts on the section selected out of sight: Delete, Duplicate and Escape from the window leave it as it was.
const homeNodes = async () => {
  const pg = (await snapshot()).state.pages[home.id];
  return JSON.stringify({ rootIds: pg.rootIds, nodes: pg.nodes });
};
const homeBefore = await homeNodes();
assert.ok(JSON.parse(homeBefore).rootIds.length > 0, 'Home has sections to lose');
await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
await win.keyboard.press('Backspace');
await win.keyboard.press(`${MOD}+d`);
await win.keyboard.press('Escape');
await win.waitForTimeout(800);
assert.equal(await homeNodes(), homeBefore, 'Home keeps its sections');
// Home chosen in the toolbar puts the writer away and opens Home where the author left it: the section, still selected.
await win.locator('.toolbar .project-title').click();
await win.getByRole('menu').getByRole('menuitemradio').filter({ hasText: home.title }).first().click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), false, 'the writer goes away'));
await eventually(async () => assert.equal(await inspected.innerText(), sectionName, 'Home opens at the section still selected'));
assert.equal(await placeShown.innerText(), home.title, 'and the toolbar names Home');
await win.locator('.rail [aria-label="Content"]').click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'the writer is back'));
await eventually(async () => assert.equal(await inspected.innerText(), 'Opening the kiln', 'with the post in the Inspector'));

step('writing: paragraphs, a section heading, a list and a link to a page');
await body.click();
await win.keyboard.type('The first firing of the year.');
await win.keyboard.press('Enter');
await win.keyboard.type('What we fired');
await win.locator('.post-tools [aria-label="Heading 2"]').click();
await win.keyboard.press('End');
await win.keyboard.press('Enter');
await win.locator('.post-tools [aria-label="Paragraph"]').click();
await win.keyboard.type('Bowls');
await win.locator('.post-tools [aria-label="Bulleted list"]').click();
await win.keyboard.press('Enter');
await win.keyboard.type('Mugs');
await win.keyboard.press('Enter');
await win.keyboard.press('Enter');
await win.keyboard.type('Come by during our ');
await win.locator('.post-tools [aria-label="Link"]').click();
const linkDialog = win.getByRole('dialog', { name: 'Add link' });
await linkDialog.getByLabel('Link text').fill('studio hours');
const about = Object.values(s1.state.pages).find((p) => p.route === '/about/') ?? Object.values(s1.state.pages).find((p) => p.id !== s1.state.site.homePageId);
await linkDialog.getByLabel('Page', { exact: true }).selectOption(about.id);
await linkDialog.getByRole('button', { name: 'Add link' }).click();
await writerFocused();
await eventually(async () => assert.equal(await body.locator('a', { hasText: 'studio hours' }).count(), 1, 'the link is in the text'));
await win.keyboard.type('.');

step('a library picture with its description and caption');
await win.locator('.post-tools [aria-label="Picture"]').click();
const picture = win.getByRole('dialog', { name: 'Add picture' });
await picture.getByRole('listbox', { name: 'Library pictures' }).getByRole('option', { name: /kiln/i }).click();
await picture.getByLabel('Description').fill('The kiln, glowing orange');
await picture.getByLabel('Caption').fill('First firing of the year.');
await picture.getByRole('button', { name: 'Add picture' }).click();
await eventually(async () => assert.equal(await body.locator('figure.post-figure img').count(), 1, 'the picture shows in the text'), 20000);
assert.equal(await body.locator('figure.post-figure img').getAttribute('alt'), 'The kiln, glowing orange', 'the writer shows the picture with its description');
assert.equal(await body.locator('figure.post-figure figcaption').innerText(), 'First firing of the year.', 'and its caption');
await writerFocused();

step('the last words, then straight to Assets: nothing typed is lost');
await win.keyboard.type('Thanks for coming.');
// Well inside the pause before a save.
await win.locator('.rail [aria-label="Assets"]').click();
await eventually(() => assert.match(words(entryFile(entryId).body), /Thanks for coming\./, 'the last words reach the post file'), 20000).catch(async (e) => {
  await win.locator('.rail [aria-label="Content"]').click();
  console.log('writer:', await win.locator('.post-save-state').innerText().catch(() => '?'), '|', await win.locator('.post-problem').innerText().catch(() => 'no problem'));
  console.log('dom:', await body.innerHTML());
  console.log('toasts:', await win.locator('.toast').allInnerTexts().catch(() => []));
  await win.screenshot({ path: join(SHOTS, 'posts-fail.png') });
  throw e;
});
const saved = entryFile(entryId).body;
assert.deepEqual(
  saved.map((b) => b.type),
  ['p', 'h2', 'ul', 'p', 'image', 'p'],
  `the post keeps its blocks: ${words(saved)}`
);
assert.deepEqual(saved[0], { type: 'p', spans: [{ text: 'The first firing of the year.' }] });
assert.deepEqual(saved[1], { type: 'h2', spans: [{ text: 'What we fired' }] });
assert.deepEqual(saved[2].items, [[{ text: 'Bowls' }], [{ text: 'Mugs' }]]);
assert.deepEqual(saved[3].spans, [{ text: 'Come by during our ' }, { text: 'studio hours', link: { type: 'page', target: about.id } }, { text: '.' }], 'the link stores the page by its ID, in its words');
assert.deepEqual(saved[5], { type: 'p', spans: [{ text: 'Thanks for coming.' }] });
assert.deepEqual(saved[4], { type: 'image', assetId: photoId, alt: 'The kiln, glowing orange', caption: 'First firing of the year.' });

step('Assets lists the picture as a use, and opens the post at it');
await win.locator(`[data-asset="${photoId}"]`).click();
const use = win.locator('button.asset-use[title="Show Picture 1 in the text on Opening the kiln"]');
await use.waitFor();
assert.match(await win.locator('#asset-uses-title').innerText(), /Used in 1 place/);
await use.click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'the writer shows again'));
assert.match(await body.innerText(), /Thanks for coming\./, 'the writer still has every word');
// The picture cannot be removed while the post uses it.
const removed = await win.evaluate((id) => window.builder.project.apply({ operations: [{ type: 'asset.remove', assetId: id }] }, { label: 'Remove' }), photoId);
assert.equal(removed.ok, false, 'a picture a post uses stays in the library');

step('Undo and Redo are the project’s, kept with it');
await body.locator('p').last().click();
await win.keyboard.press('End');
await win.keyboard.type(' See you soon.');
await eventually(() => assert.match(words(entryFile(entryId).body), /See you soon\./), 20000);
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.doesNotMatch(await body.innerText(), /See you soon\./, 'Undo takes the words back in the writer'), 20000);
await eventually(() => assert.doesNotMatch(words(entryFile(entryId).body), /See you soon\./, 'and in the post file'), 20000);
// Only that step: what was written before, the picture included, stays.
assert.match(words(entryFile(entryId).body), /Thanks for coming\./);
assert.equal(entryFile(entryId).body.filter((b) => b.type === 'image').length, 1);
await win.keyboard.press(`${MOD}+Shift+z`);
await eventually(async () => assert.match(await body.innerText(), /See you soon\./, 'Redo brings them back'), 20000);
const history = (await snapshot()).history.entries.filter((e) => e.applied).map((e) => e.label);
assert.ok(history.includes('Edit post text'), `the text edits are project history: ${history.join(', ')}`);

step('saved as a draft, previewed in the site');
await win.getByRole('button', { name: 'Save draft' }).click();
await win.getByRole('button', { name: 'Preview in site' }).click();
const route = (await snapshot()).state.collections.posts.entries[entryId].slug;
const path = `/blog/${route}/`;
await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), path, 'the canvas shows the post'), 60000);
// The previewed post is what the toolbar and the Inspector name (#578), and the canvas's width is the author's again.
await eventually(async () => assert.equal(await placeShown.innerText(), 'Opening the kiln', 'the toolbar names the previewed post'));
await eventually(async () => assert.match(await inspector.locator('.insp-kind-label').innerText(), /Draft post · preview/, 'the Inspector names the previewed post'));
assert.equal(await inspected.innerText(), 'Opening the kiln');
await noPageSettings('previewing');
assert.deepEqual(await checkedPages(), [], 'the toolbar menu checks no page while the post is shown');
for (const name of ['Desktop', 'Tablet', 'Phone']) assert.equal(await win.locator('.toolbar').getByRole('radio', { name, exact: true }).isEnabled(), true, `${name} acts on the preview`);
assert.equal(await win.getByLabel('Preview width in pixels').isEnabled(), true, 'and the width field');
assert.equal(await win.locator('.toolbar .zoom-btn').isEnabled(), true, 'and the zoom');
// The post's page is its collection's layout, read for this post.
const article = frame.locator('article', { has: frame.locator('h1') });
await eventually(async () => assert.equal(await article.locator('h1').innerText(), 'Opening the kiln'), 60000);
assert.equal(await frame.locator('header.so-header').count(), 1, 'in the site’s own header');
assert.ok((await frame.locator('footer').count()) >= 1, 'and its footer');
assert.equal(await article.locator('.so-rich h2').innerText(), 'What we fired');
assert.deepEqual(await article.locator('.so-rich ul li').allInnerTexts(), ['Bowls', 'Mugs']);
assert.equal(await article.locator('.so-rich a', { hasText: 'studio hours' }).getAttribute('href'), about.route);
const img = article.locator('figure.so-rich__figure img');
assert.equal(await img.getAttribute('alt'), 'The kiln, glowing orange');
await eventually(async () => assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth > 0), 'the picture loads'), 20000);
assert.equal(await article.locator('figure.so-rich__figure figcaption').innerText(), 'First firing of the year.');
await win.screenshot({ path: join(SHOTS, 'posts-preview-draft.png') });

step('a visitor’s link from the post: the editor names where they went, and Back names the post again (#578)');
// With the sidebar hidden, so nothing depends on the Posts panel showing.
await win.locator('.toolbar [aria-label="Sidebar"]').click();
await eventually(async () => assert.equal(await win.locator('#editor-sidebar').isVisible(), false, 'the sidebar is hidden'));
/** Follow a link on the page as a visitor does, once the page is ready for one, and wait to be there. */
const visit = async (link, to) => {
  await eventually(async () => assert.equal(await frame.locator('html').evaluate((html) => document.readyState === 'complete' && !html.hasAttribute('data-so-editing')), true, 'the page is ready for a visitor'));
  await link.evaluate((a) => a.click());
  await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), to, `the visitor is at ${to}`), 60000);
};
// The post's own link to About.
await visit(article.locator('.so-rich a', { hasText: 'studio hours' }), about.route);
await eventually(async () => assert.equal(await placeShown.innerText(), about.title, 'the toolbar names About, where the visitor is'));
await eventually(async () => assert.equal(await inspected.innerText(), about.title, 'and so does the Inspector'));
assert.equal(await inspector.locator('.insp-kind-label').innerText(), 'Page · preview');
await noPageSettings('a visitor on About');
assert.deepEqual(await checkedPages(), [about.title], 'the toolbar menu checks About');
await win.getByRole('group', { name: 'Preview', exact: true }).getByRole('button', { name: 'Back', exact: true }).click();
await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), path, 'Back is the post'), 60000);
await eventually(async () => assert.equal(await placeShown.innerText(), 'Opening the kiln', 'the toolbar names the post again'));
await eventually(async () => assert.equal(await inspected.innerText(), 'Opening the kiln', 'and the Inspector'));
assert.deepEqual(await checkedPages(), [], 'and the menu checks no page');
// The site's own link home, then the Inspector's way back to the writer, which brings the sidebar back with it.
await visit(frame.locator('header.so-header a[href="/"]').first(), '/');
await eventually(async () => assert.match(await inspector.locator('.insp-kind-label').innerText(), /^Home page · preview$/));
await noPageSettings('a visitor on Home');
await inspector.getByRole('button', { name: 'Back to writing' }).click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'the writer shows again'));
assert.equal(await win.locator('.posts-panel').isVisible(), true, 'with the Posts panel');
await eventually(async () => assert.match(await inspector.locator('.insp-kind-label').innerText(), /^Draft post$/));
await win.getByRole('button', { name: 'Preview in site' }).click();
await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), path, 'the post again'), 60000);

step('back to writing, backdated and published');
await win.locator('.posts-panel').getByRole('button', { name: 'Back to writing' }).click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true));
await win.locator('.post-details:not(.post-seo) .section-head').click();
const date = win.getByLabel('Publication date');

step('a future-dated post asks before it is published (#1115)');
// Typed and not yet committed: Publish saves it first, and asks about the date as saved.
await date.fill('2099-01-01');
const futureAsk = win.getByRole('dialog', { name: /^Publish this post dated .*1.*2099\?$/ });
await win.getByRole('button', { name: 'Publish' }).click();
await eventually(async () => assert.equal(await futureAsk.isVisible(), true, 'Publish asks, naming the date'), 20000);
assert.equal(entryFile(entryId).publishedAt, '2099-01-01', 'the date was saved before the question');
await futureAsk.getByRole('button', { name: 'Keep as draft' }).click();
await eventually(async () => assert.equal(await futureAsk.count(), 0));
assert.equal(entryFile(entryId).draft, true, 'Keep as draft leaves it a draft');
await win.getByRole('button', { name: 'Publish' }).click();
await eventually(async () => assert.equal(await futureAsk.isVisible(), true));
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await futureAsk.count(), 0));
assert.equal(entryFile(entryId).draft, true, 'dismissing the question leaves it a draft');
await win.getByRole('button', { name: 'Publish' }).click();
await futureAsk.getByRole('button', { name: 'Publish now' }).click();
await eventually(() => assert.equal(entryFile(entryId).draft, false, 'Publish now publishes it'), 20000);
await win.getByRole('button', { name: 'Move to drafts' }).click();
await eventually(() => assert.equal(entryFile(entryId).draft, true, 'and it moves back to drafts'), 20000);

step('backdated, it publishes without a question');
await date.fill('2025-06-01');
await date.press('Enter');
await eventually(() => assert.equal(entryFile(entryId).publishedAt, '2025-06-01', 'the post is backdated'), 20000);

step('the featured image is chosen, imported and removed in the visual picker, each an undo step (#563)');
const featured = win.locator('.post-details:not(.post-seo)').getByRole('group', { name: 'Featured image' });
const featuredNow = () => entryFile(entryId).featuredImage ?? null;
assert.equal(await featured.locator('select').count(), 0, 'no dropdown of names');
assert.equal(await featured.locator('.insp-image-name').innerText(), 'No image chosen', 'the post starts with none');
await featured.getByRole('button', { name: 'Choose image…' }).click();
const featuredTile = win.locator('.insp-image-pop .insp-pick-tile', { hasText: /^kiln$/ });
await featuredTile.waitFor();
assert.equal(await featuredTile.locator('img').count(), 1, 'the library shows as thumbnails');
await featuredTile.click();
await eventually(() => assert.equal(featuredNow(), photoId, 'the chosen photo is the featured image'), 20000);
assert.equal(await win.locator('.insp-image-pop').count(), 0, 'the picker closed after choosing');
await eventually(async () => assert.equal(await featured.getByTestId('featured-preview').locator('img').evaluate((el) => el.complete && el.naturalWidth > 0), true, 'its thumbnail shows, loaded'));
assert.equal(await featured.locator('.insp-alt').count(), 0, 'no description to write');
// A new photo imported from inside the writer replaces it.
const glaze = await win.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 500;
  const g = c.getContext('2d');
  g.fillStyle = '#2f6f8f';
  g.fillRect(0, 0, 800, 500);
  return c.toDataURL('image/png').split(',')[1];
});
const glazePath = join(WORK, 'glaze.png');
writeFileSync(glazePath, Buffer.from(glaze, 'base64'));
await featured.getByRole('button', { name: 'Change…' }).click();
await answerChoosers(app, [{ dialog: 'open', paths: [glazePath] }]);
await win.locator('.insp-image-pop').getByRole('button', { name: 'Import…' }).click();
const glazeId = await eventually(() => {
  const id = featuredNow();
  assert.ok(id && id !== photoId, 'the imported photo is the featured image');
  return id;
}, 20000);
assert.equal((await snapshot()).state.assets.assets[glazeId].name, 'glaze', 'and it is in the library');
await eventually(async () => assert.equal(await win.locator('.insp-image-pop').count(), 0, 'the picker closed after the import'));
await featured.getByRole('button', { name: 'Remove featured image' }).click();
await eventually(() => assert.equal(featuredNow(), null, 'Remove clears the featured image'), 20000);
// The file is written before the change is recorded in History and the editor hears of it: the picker shows it once
// it has, and only then is History counted.
await eventually(async () => assert.equal(await featured.locator('.insp-image-name').innerText(), 'No image chosen', 'the picker shows none'));
const featuredSteps = (await snapshot()).history.entries.filter((e) => e.applied && e.label === 'Change featured image').length;
assert.equal(featuredSteps, 3, 'choosing, importing and removing are each an undo step');
await win.locator('.post-tools').getByRole('button', { name: 'Undo' }).click();
await eventually(() => assert.equal(featuredNow(), glazeId, 'Undo brings the featured image back'), 20000);
await eventually(async () => assert.equal(await featured.locator('.insp-image-name').innerText(), 'glaze', 'and the picker shows it'));
// The same photo imported again is the featured image already: nothing changes, and nothing stops Publish next.
const stepsBefore = (await snapshot()).history.entries.filter((e) => e.applied).length;
await featured.getByRole('button', { name: 'Change…' }).click();
await answerChoosers(app, [{ dialog: 'open', paths: [glazePath] }]);
await win.locator('.insp-image-pop').getByRole('button', { name: 'Import…' }).click();
await eventually(async () => assert.equal(await win.locator('.insp-image-pop').count(), 0, 'the picker closed after importing the same photo'), 20000);
assert.equal(featuredNow(), glazeId, 'the same photo stays the featured image');
assert.equal((await snapshot()).history.entries.filter((e) => e.applied).length, stepsBefore, 'and no undo step is added');
await win.getByRole('button', { name: 'Publish' }).click();
await eventually(() => assert.equal(entryFile(entryId).draft, false, 'the post is published'), 20000);
// Published is the unmarked state: the row's Draft badge goes.
await eventually(async () => assert.equal(await win.locator('.post-row .post-status').count(), 0, 'a published post carries no status badge'));
await win.screenshot({ path: join(SHOTS, 'posts-writer.png') });

step('the published post in the site');
await win.getByRole('button', { name: 'Preview in site' }).click();
await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), path), 60000);
await eventually(async () => assert.equal(await frame.locator('article time').getAttribute('datetime'), '2025-06-01', 'the page shows the backdated day'), 60000);
await win.locator('.posts-panel').getByRole('button', { name: 'Back to writing' }).click();
// Back on the page the editor shows (Home), editing again.
await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), '/', 'the canvas returns to the page'), 60000);
assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'the writer shows again');

step('a long title wraps instead of clipping, and Enter saves it rather than adding a line (#561)');
const titleField = win.getByLabel('Post title');
/** How the title shows: its lines, and whether any of it lies out of sight (sideways or below). */
const titleFit = () =>
  titleField.evaluate((el) => {
    const line = parseFloat(getComputedStyle(el).lineHeight);
    return { lines: Math.round(el.clientHeight / line), clippedSideways: el.scrollWidth > el.clientWidth + 1, clippedBelow: el.scrollHeight > el.clientHeight + 1, focused: document.activeElement === el };
  });
const savedTitle = () => entryFile(entryId).title;
const longTitle = 'Designing for Winter Light in the Pacific Northwest';
await titleField.click();
await titleField.fill(longTitle);
let fit = await titleFit();
assert.ok(fit.lines >= 2, `a title of ${longTitle.length} characters takes more than one line at the editor's width: ${JSON.stringify(fit)}`);
assert.equal(fit.clippedSideways || fit.clippedBelow, false, `none of the title is out of sight: ${JSON.stringify(fit)}`);
// Enter saves the title and leaves the field; it adds no line.
await titleField.press('Enter');
await eventually(() => assert.equal(savedTitle(), longTitle, 'Enter saves the whole title'), 20000);
assert.equal((await titleFit()).focused, false, 'and leaves the field');
assert.equal(await titleField.inputValue(), longTitle, 'the title has no added line');
// The longest title the project keeps shows whole, too.
const longest = 'Winter light on the water '.repeat(8).trim().slice(0, 200);
assert.equal(longest.length, 200);
await titleField.click();
await titleField.fill(longest);
fit = await titleFit();
assert.ok(fit.lines >= 4, `a title of the most characters wraps over several lines: ${JSON.stringify(fit)}`);
assert.equal(fit.clippedSideways || fit.clippedBelow, false, `all of it shows: ${JSON.stringify(fit)}`);
await win.screenshot({ path: join(SHOTS, 'posts-long-title.png') });
await titleField.press('Enter');
await eventually(() => assert.equal(savedTitle(), longest), 20000);
// A word too long for the line breaks across lines rather than running out of sight.
const unbroken = 'Antidisestablishmentarianism'.repeat(3);
await titleField.click();
await titleField.fill(unbroken);
fit = await titleFit();
assert.ok(fit.lines >= 2, `a very long word wraps: ${JSON.stringify(fit)}`);
assert.equal(fit.clippedSideways || fit.clippedBelow, false, `all of the word shows: ${JSON.stringify(fit)}`);
// Pasted line breaks become spaces, and one at the end of a copied line is not kept as a space.
const pasteInto = (text) =>
  titleField.evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
await titleField.press(`${MOD}+a`);
await pasteInto('Spring glaze tests\nand what we learned\r\n');
assert.equal(await titleField.inputValue(), 'Spring glaze tests and what we learned', 'pasted line breaks become spaces');
// Shift+Enter saves it too, and adds no line.
await titleField.press('Shift+Enter');
await eventually(() => assert.equal(savedTitle(), 'Spring glaze tests and what we learned', 'the saved title is one line'), 20000);
assert.equal((await titleFit()).focused, false, 'Shift+Enter leaves the field as well');
// A paste in the middle lands there with the caret after it, and so does text put in some other way (an input method, a drop).
await titleField.click();
await titleField.fill('Spring glaze');
await titleField.press('Home');
for (let i = 0; i < 6; i++) await titleField.press('ArrowRight');
await pasteInto('one\ntwo');
await win.keyboard.type('!');
assert.equal(await titleField.inputValue(), 'Springone two! glaze', 'the paste lands at the caret, which stays after it');
await win.keyboard.insertText('a\nb');
await win.keyboard.type('?');
assert.equal(await titleField.inputValue(), 'Springone two!a b? glaze', 'inserted line breaks become spaces without moving the caret to the end');
await titleField.press(`${MOD}+a`);
await win.keyboard.insertText('Raku firing\nnotes\r\nfrom the weekend');
assert.equal(await titleField.inputValue(), 'Raku firing notes from the weekend', 'inserted line breaks become spaces');
await titleField.press('Enter');
await eventually(() => assert.equal(savedTitle(), 'Raku firing notes from the weekend', 'the saved title is one line'), 20000);
// The limit counts what is saved: 201 characters with a line break in them are 200 without it, and fit.
const left = 'Winter light on the water '.repeat(4).trim();
const right = 'Winter light on the water '.repeat(4).trim().slice(0, 96);
assert.equal(`${left}\r\n${right}`.length, 201);
await titleField.click();
await titleField.press(`${MOD}+a`);
await win.keyboard.insertText(`${left}\r\n${right}`);
assert.equal((await titleField.inputValue()).length, 200, 'the line break is one space');
assert.equal(await titleField.getAttribute('aria-invalid'), null, 'and the title is within the limit');
await titleField.press('Enter');
await eventually(() => assert.equal(savedTitle(), `${left} ${right}`, 'the title of exactly the limit is saved'), 20000);
// A title over the limit is kept whole and refused, with the reason beside it; Escape puts the saved one back.
const tooLong = 'Winter light on the water '.repeat(9).trim().slice(0, 201);
assert.equal(tooLong.length, 201);
await titleField.click();
await titleField.fill(tooLong);
await titleField.press('Enter');
await eventually(async () => assert.equal(await titleField.getAttribute('aria-invalid'), 'true', 'a title over the limit is marked'), 20000);
assert.equal(await titleField.inputValue(), tooLong, 'and kept whole');
assert.equal(savedTitle(), `${left} ${right}`, 'but not saved');
await titleField.click();
await titleField.press('Escape');
await eventually(async () => assert.equal(await titleField.inputValue(), `${left} ${right}`, 'Escape puts the saved title back'), 20000);
// An empty title is still refused: the saved one stays.
await titleField.click();
await titleField.fill('');
await titleField.press('Enter');
await eventually(async () => assert.equal(await titleField.inputValue(), `${left} ${right}`, 'the saved title comes back'), 20000);
assert.equal(savedTitle(), `${left} ${right}`, 'an empty title is not saved');

step('Search & sharing keeps its fields and meters, and opens the post in the SEO view with what is typed saved first (#708)');
const seoBox = win.locator('.post-seo');
await seoBox.locator('.section-head').first().click();
const postMeter = (kind) => seoBox.locator(`.seo-meter[data-meter="${kind}"]`);
const postTitleBox = seoBox.getByLabel('Search title');
const postCanonical = seoBox.getByLabel('Canonical URL');
const openInView = seoBox.getByRole('button', { name: 'Open in SEO view' });
const seoView = win.getByRole('region', { name: 'SEO view' });
const savedSeo = () => entryFile(entryId).seo ?? {};
assert.equal(await seoBox.getByRole('tab').count(), 0, 'the writer shows no previews of its own');
assert.equal(await seoBox.locator('.serp, .share-card').count(), 0);
assert.equal(await seoBox.getByRole('button', { name: 'Optimize with AI' }).count(), 1, 'Optimize with AI is still beside the settings');
assert.equal(await seoBox.getByRole('button', { name: 'Optimize with AI' }).isEnabled(), true);
await eventually(async () => assert.match(await postMeter('title').innerText(), /^Default · \d+ characters · too long$/, 'the title meter measures the default title'));
assert.match(await postMeter('description').innerText(), /^Default ·/, 'the description meter measures the excerpt it falls back to');
await postTitleBox.fill('Raku notes');
await eventually(async () => assert.equal(await postMeter('title').innerText(), '10 characters · aim for 15–60', 'the meter follows the title as it is typed'));
assert.equal(savedSeo().title, undefined, 'nothing is saved while it is typed');
await postTitleBox.press('Escape');
await eventually(async () => assert.match(await postMeter('title').innerText(), /^Default ·/, 'Escape puts the default back'));
// An address that is not one stays in the writer, with its note: the view, which would show the saved address, waits.
await postCanonical.fill('journal.example/raku');
// Pressed without taking focus from the field (as a click that takes none would): the button leaves it itself, and
// sees the refusal at once.
await openInView.dispatchEvent('click');
await eventually(async () => assert.equal(await postCanonical.getAttribute('aria-invalid'), 'true', 'the address is refused, and kept'));
await eventually(async () => assert.match((await win.locator('.toast').allInnerTexts()).join('\n'), /What is typed in Canonical URL is not saved yet\./, 'and the button says why the view does not open'));
assert.equal(await seoView.count(), 0, 'the SEO view stays closed');
assert.equal(await postCanonical.evaluate((el) => el === document.activeElement), true, 'the refused address has the caret');
assert.equal(await postCanonical.inputValue(), 'journal.example/raku', 'nothing typed is lost');
await postCanonical.press('Escape');
await eventually(async () => assert.equal(await postCanonical.getAttribute('aria-invalid'), null, 'Escape lets it go'));
// A title being typed is saved as the button is pressed, and the view opens on the post with it.
await postTitleBox.fill('Raku firing notes from the weekend');
await openInView.click();
await eventually(() => assert.equal(savedSeo().title, 'Raku firing notes from the weekend', 'what was typed is saved first'), 20000);
await eventually(async () => assert.equal(await seoView.locator('.seo-title').innerText(), `${left} ${right}`, 'the SEO view opens on the post'));
await eventually(async () => assert.equal(await seoView.locator('.serp-desktop .serp-title').innerText(), 'Raku firing notes from the weekend', 'its result shows the saved title'));
assert.equal(await seoView.getByLabel('Search title', { exact: true }).inputValue(), 'Raku firing notes from the weekend', 'and so does its field');
await eventually(async () => assert.equal(await seoView.getByRole('button', { name: 'Back to overview' }).evaluate((el) => el === document.activeElement), true, 'focus moves into the view'));
await win.screenshot({ path: join(SHOTS, 'posts-seo-view.png') });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nposts: passed');
