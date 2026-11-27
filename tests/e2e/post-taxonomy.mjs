// Categories and tags in the Posts panel (#396): categories and tags added in the panel's manager; a post filed under
// a category and two tags in the writer, one tag added there as it is typed; the list narrowed by category, by
// Published or Drafts and by its words; a category renamed, its address, its posts and a list of posts on Home that
// chose it by name following it in one step that Undo takes back whole; a category deleted after saying how many
// posts it is on, and refused while a list of posts chooses it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('post-taxonomy');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Kiln Notes', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'kiln-notes');

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r;
};
const collectionFile = () => JSON.parse(readFileSync(join(dir, 'siteorigin/collections/posts/collection.json'), 'utf8'));
const entryFile = (id) => JSON.parse(readFileSync(join(dir, 'siteorigin/collections/posts/entries', `${id}.json`), 'utf8'));
const categories = () => collectionFile().taxonomies.categories.terms;
const titles = () => win.locator('.posts-list .post-title').allInnerTexts();
/** Categories and tags, from the Posts options menu. */
const openTerms = async () => {
  await win.getByRole('button', { name: 'Posts options' }).click();
  await win.getByRole('menuitem', { name: /^Categories and tags/ }).click();
};

step('three posts: two published, one a draft');
await apply(
  [
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_kiln', title: 'New kiln', publishedAt: '2026-04-01', draft: false, body: ['A bigger kiln.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_glaze', title: 'Glaze night', publishedAt: '2026-03-10', draft: false, body: ['Mix your own.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_plans', title: 'Studio plans', publishedAt: '2026-05-01', body: ['Not yet.'] }
  ],
  'Start the blog'
);
await win.locator('.rail [aria-label="Content"]').click();
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln', 'Glaze night'], 'the list shows every post, newest first'));

step('categories and tags added in the manager');
await openTerms();
const manager = win.getByRole('dialog', { name: 'Categories and tags' });
await manager.waitFor();
for (const name of ['Studio news', 'Craft']) {
  await manager.getByLabel('New category name').fill(name);
  await manager.getByRole('button', { name: 'Add category' }).click();
  await eventually(async () => assert.equal(await manager.getByLabel('New category name').inputValue(), '', `“${name}” is added and the field cleared`));
}
await eventually(() => assert.deepEqual(categories(), { 'studio-news': { label: 'Studio news' }, craft: { label: 'Craft' } }, 'each category takes an address from its name'));
await manager.getByRole('tab', { name: 'Tags' }).click();
await manager.getByLabel('New tag name').fill('Glaze');
await manager.getByRole('button', { name: 'Add tag' }).click();
await eventually(() => assert.deepEqual(collectionFile().taxonomies.tags.terms, { glaze: { label: 'Glaze' } }));
await manager.getByRole('tab', { name: 'Categories' }).click();
assert.match(await manager.locator('.term-row[data-term="studio-news"] .term-meta').innerText(), /^0 posts · \/blog\/category\/studio-news\/$/, 'a category shows how many posts it is on and its archive address');
await manager.getByRole('button', { name: 'Done' }).click();

step('a post filed under a category and two tags in the writer, one tag added as it is typed');
await win.locator('.post-row[data-post="en_kiln"] ').click({ position: { x: 48, y: 12 } });
await win.locator('.post-body').waitFor();
await win.locator('.post-details:not(.post-seo) .section-head').click();
const writerCategories = win.locator('.post-terms[data-taxonomy="categories"]');
const writerTags = win.locator('.post-terms[data-taxonomy="tags"]');
await writerCategories.getByLabel('Studio news').check();
await eventually(() => assert.deepEqual(entryFile('en_kiln').terms, { categories: ['studio-news'] }, 'the post is filed under the category'));
await writerTags.getByLabel('Glaze').check();
await writerTags.getByLabel('Add a tag to this post').fill('Firing');
await writerTags.getByLabel('Add a tag to this post').press('Enter');
await eventually(() => assert.deepEqual(entryFile('en_kiln').terms, { categories: ['studio-news'], tags: ['glaze', 'firing'] }, 'and under both tags, the new one added on the way'));
await eventually(async () => assert.equal(await writerTags.getByLabel('Firing').isChecked(), true, 'the new tag is ticked'));
assert.equal(collectionFile().taxonomies.tags.terms.firing.label, 'Firing');
await eventually(async () => assert.match(await win.locator('.post-details:not(.post-seo) .section-head').innerText(), /Studio news$/, 'the details name its category'));
await win.screenshot({ path: join(SHOTS, 'post-taxonomy-writer.png') });
await writerTags.getByLabel('Glaze').uncheck();
await eventually(() => assert.deepEqual(entryFile('en_kiln').terms, { categories: ['studio-news'], tags: ['firing'] }, 'unticking takes the post out of the tag'));
await writerTags.getByLabel('Glaze').check();
await eventually(() => assert.deepEqual(entryFile('en_kiln').terms.tags, ['firing', 'glaze']));
// Opened again, the post shows what it is filed under.
await win.locator('.post-row[data-post="en_glaze"] ').click({ position: { x: 48, y: 12 } });
await eventually(async () => assert.equal(await win.locator('.post-terms[data-taxonomy="categories"]').getByLabel('Studio news').isChecked(), false, 'another post is not filed under it'));
await win.locator('.post-row[data-post="en_kiln"] ').click({ position: { x: 48, y: 12 } });
await eventually(async () => assert.equal(await win.locator('.post-terms[data-taxonomy="categories"]').getByLabel('Studio news').isChecked(), true, 'the post shows its category when opened again'));

step('the draft filed under the same category, the other post under another, and a list on Home that chooses the category by name');
await apply(
  [
    { type: 'entry.update', collectionId: 'posts', entryId: 'en_plans', terms: { categories: ['studio-news'] } },
    { type: 'entry.update', collectionId: 'posts', entryId: 'en_glaze', terms: { categories: ['craft'] } }
  ],
  'File posts'
);
const s0 = await snapshot();
const home = s0.state.site.homePageId;
const inserted = await apply([{ type: 'node.insert', owner: { kind: 'page', id: home }, componentId: 'blog.grid', props: { category: 'Studio news', heading: 'Studio news' } }], 'Latest news');
const gridId = inserted.results[0].nodeId;

step('the list narrowed by category, by Published or Drafts, and by its words');
const byCategory = win.getByLabel('Filter by category');
await byCategory.selectOption({ label: 'Studio news' });
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln'], 'only the category’s posts, drafts too'));
await win.getByRole('radio', { name: 'Published 1' }).click();
await eventually(async () => assert.deepEqual(await titles(), ['New kiln'], 'only its published posts'));
await win.getByRole('radio', { name: 'Drafts 1' }).click();
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans'], 'only its drafts'));
await win.getByRole('radio', { name: 'All 2' }).click();
await win.getByLabel('Find a post by title, address, author or excerpt').fill('kiln');
await eventually(async () => assert.deepEqual(await titles(), ['New kiln'], 'its words narrow it further'));
await win.getByLabel('Find a post by title, address, author or excerpt').fill('glaze');
await eventually(async () => assert.match(await win.locator('.posts-panel .posts-none').innerText(), /No post matches these filters\./, 'a post outside the category is not found'));
await win.getByLabel('Find a post by title, address, author or excerpt').fill('');
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln']));
await byCategory.selectOption({ label: 'Craft' });
await eventually(async () => assert.deepEqual(await titles(), ['Glaze night'], 'another category narrows to its posts'));
await byCategory.selectOption({ label: 'All categories' });
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln', 'Glaze night']));
await byCategory.selectOption({ label: 'Studio news' });
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln']));
await win.screenshot({ path: join(SHOTS, 'post-taxonomy-filtered.png') });

step('the category renamed: its address, its posts and the list on Home follow it in one step');
await openTerms();
await manager.waitFor();
await manager.getByRole('button', { name: 'Rename “Studio news”' }).click();
await manager.getByLabel('New name for “Studio news”').fill('Workshop news');
await eventually(async () => assert.match(await manager.locator('.term-moves').innerText(), /from \/blog\/category\/studio-news\/ to \/blog\/category\/workshop-news\//, 'the move of its archive is said before it is saved'));
await manager.getByRole('button', { name: 'Save name' }).click();
await eventually(() => {
  assert.deepEqual(categories(), { 'workshop-news': { label: 'Workshop news' }, craft: { label: 'Craft' } }, 'the category has its new name and address, in its place');
  assert.deepEqual(entryFile('en_kiln').terms.categories, ['workshop-news']);
  assert.deepEqual(entryFile('en_plans').terms.categories, ['workshop-news'], 'drafts follow it too');
});
await eventually(async () => assert.match(await manager.locator('.term-row[data-term="workshop-news"] .term-meta').innerText(), /^2 posts · \/blog\/category\/workshop-news\/$/, 'the manager counts its posts at its new address'));
const s1 = await snapshot();
assert.equal(s1.state.pages[home].nodes[gridId].props.category, 'workshop-news', 'the list on Home still chooses it');
await manager.getByRole('button', { name: 'Done' }).click();
await eventually(async () => assert.equal(await byCategory.inputValue(), 'workshop-news', 'the list’s filter follows the rename'));
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln']));
assert.equal(await byCategory.locator('option:checked').innerText(), 'Workshop news');

step('Undo takes the whole rename back at once, and Redo makes it again');
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);
await eventually(() => {
  assert.deepEqual(categories(), { 'studio-news': { label: 'Studio news' }, craft: { label: 'Craft' } }, 'the old name and address are back');
  assert.deepEqual(entryFile('en_kiln').terms.categories, ['studio-news']);
  assert.deepEqual(entryFile('en_plans').terms.categories, ['studio-news']);
});
assert.equal((await snapshot()).state.pages[home].nodes[gridId].props.category, 'Studio news', 'the list chooses it as it did');
// The filter on a category Undo took away shows every post again.
await eventually(async () => assert.equal(await byCategory.inputValue(), '', 'the filter lets go of the category Undo took away'));
await eventually(async () => assert.deepEqual(await titles(), ['Studio plans', 'New kiln', 'Glaze night']));
assert.equal((await win.evaluate(() => window.builder.project.redo())).ok, true);
await eventually(() => {
  assert.deepEqual(Object.keys(categories()), ['workshop-news', 'craft']);
  assert.deepEqual(entryFile('en_kiln').terms.categories, ['workshop-news']);
  assert.deepEqual(entryFile('en_plans').terms.categories, ['workshop-news']);
});
assert.equal((await snapshot()).state.pages[home].nodes[gridId].props.category, 'workshop-news');

step('deleting a category says how many posts it is on; one a list of posts chooses is refused');
await openTerms();
await manager.waitFor();
const blockedDelete = manager.getByRole('button', { name: 'Delete “Workshop news”' });
assert.equal(await blockedDelete.getAttribute('aria-disabled'), 'true', 'the category used by a list cannot be deleted');
const reason = await blockedDelete.getAttribute('aria-describedby');
assert.match(await win.locator(`[id="${reason}"]`).innerText(), /“Post grid” in Home lists posts by it\. Choose something else there to delete it\./, 'the list choosing it is named');
assert.ok(Object.hasOwn(categories(), 'workshop-news'), 'and the category stays');
await manager.getByRole('button', { name: 'Delete “Craft”' }).click();
const confirm = win.getByRole('dialog', { name: 'Delete this category?' });
await confirm.waitFor();
assert.match(await confirm.innerText(), /1 post is filed under it\. It stays, without this category\./, 'the count of posts it is on is said first');
await confirm.getByRole('button', { name: 'Cancel' }).click();
assert.ok(Object.hasOwn(categories(), 'craft'), 'Cancel keeps it');
await manager.getByRole('button', { name: 'Delete “Craft”' }).click();
await confirm.getByRole('button', { name: 'Delete category' }).click();
await eventually(() => {
  assert.deepEqual(Object.keys(categories()), ['workshop-news'], 'the category is gone');
  assert.deepEqual(entryFile('en_glaze').terms, {}, 'and its post is filed under nothing');
});
await manager.getByRole('button', { name: 'Done' }).click();

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npost-taxonomy: passed');
