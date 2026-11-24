// The Posts workspace (#395): a post written in the centred writer with a section heading, a list, a link to a page
// and a library picture with its description and caption; nothing typed is lost when the author switches panels
// straight away; the picture is a use Assets lists and opens; Undo and Redo are the project's; the post is saved as a
// draft, previewed on the canvas in the site's own header and footer, backdated, published and previewed again.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

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

step('a new post from the Posts panel creates the blog and opens the writer');
await win.locator('.rail [aria-label="Posts"]').click();
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
const linkDialog = win.getByRole('dialog', { name: 'Link' });
await linkDialog.getByLabel('Text').fill('studio hours');
const about = Object.values(s1.state.pages).find((p) => p.route === '/about/') ?? Object.values(s1.state.pages).find((p) => p.id !== s1.state.site.homePageId);
await linkDialog.getByLabel('Page', { exact: true }).selectOption(about.id);
await linkDialog.getByRole('button', { name: 'Apply link' }).click();
await writerFocused();
await eventually(async () => assert.equal(await body.locator('a', { hasText: 'studio hours' }).count(), 1, 'the link is in the text'));
await win.keyboard.type('.');

step('a library picture with its description and caption');
await win.locator('.post-tools [aria-label="Picture"]').click();
const picture = win.getByRole('dialog', { name: 'Add a picture' });
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
  await win.locator('.rail [aria-label="Posts"]').click();
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

step('back to writing, backdated and published');
await win.locator('.posts-panel').getByRole('button', { name: 'Back to writing' }).click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true));
await win.locator('.post-details > summary').click();
const date = win.getByLabel('Publication date');
await date.fill('2025-06-01');
await date.press('Enter');
await eventually(() => assert.equal(entryFile(entryId).publishedAt, '2025-06-01', 'the post is backdated'), 20000);
await win.getByRole('button', { name: 'Publish' }).click();
await eventually(() => assert.equal(entryFile(entryId).draft, false, 'the post is published'), 20000);
await eventually(async () => assert.equal(await win.locator('.post-row .post-status').innerText(), 'Published'));
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
// Pasted line breaks become spaces.
await titleField.click();
await titleField.press(`${MOD}+a`);
await titleField.evaluate((el) => {
  const data = new DataTransfer();
  data.setData('text/plain', 'Spring glaze tests\nand what we learned\r\n');
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
});
assert.equal(await titleField.inputValue(), 'Spring glaze tests and what we learned ', 'pasted line breaks become spaces');
await titleField.press('Enter');
await eventually(() => assert.equal(savedTitle(), 'Spring glaze tests and what we learned', 'the saved title is one line'), 20000);
// Text put in some other way (an input method, a drop) is one line before it is counted or saved.
await titleField.click();
await titleField.press(`${MOD}+a`);
await win.keyboard.insertText('Raku firing\nnotes\r\nfrom the weekend');
assert.equal(await titleField.inputValue(), 'Raku firing notes from the weekend', 'inserted line breaks become spaces');
await titleField.press('Enter');
await eventually(() => assert.equal(savedTitle(), 'Raku firing notes from the weekend', 'the saved title is one line'), 20000);
// A title over the limit is kept whole and refused, with the reason beside it; Escape puts the saved one back.
const tooLong = 'Winter light on the water '.repeat(9).trim().slice(0, 201);
assert.equal(tooLong.length, 201);
await titleField.click();
await titleField.fill(tooLong);
await titleField.press('Enter');
await eventually(async () => assert.equal(await titleField.getAttribute('aria-invalid'), 'true', 'a title over the limit is marked'), 20000);
assert.equal(await titleField.inputValue(), tooLong, 'and kept whole');
assert.equal(savedTitle(), 'Raku firing notes from the weekend', 'but not saved');
await titleField.click();
await titleField.press('Escape');
await eventually(async () => assert.equal(await titleField.inputValue(), 'Raku firing notes from the weekend', 'Escape puts the saved title back'), 20000);
// An empty title is still refused: the saved one stays.
await titleField.click();
await titleField.fill('');
await titleField.press('Enter');
await eventually(async () => assert.equal(await titleField.inputValue(), 'Raku firing notes from the weekend', 'the saved title comes back'), 20000);
assert.equal(savedTitle(), 'Raku firing notes from the weekend', 'an empty title is not saved');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nposts: passed');
