// A collection's index seen in Preview, then Back to editing (#868): View index in Pages opens the blog index, an
// address that is no page of the editor's, and Edit brings the canvas back to the page the editor names. On a blank
// Home, the empty page's card never sits over the blog list, and Preview after it starts on Home again.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('view-index');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Index Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const framePath = () => frame.locator('html').evaluate(() => location.pathname);
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const pill = win.getByRole('group', { name: 'Preview', exact: true });
const emptyCard = win.locator('#canvas-empty-title');

step('a blog with two published posts');
await openRail('Content');
await win.locator('.posts-panel [data-starter="posts"]').click();
await eventually(async () => assert.ok((await snapshot()).state.collections?.posts, 'the blog is in the project'), 20000);
const r = await apply(
  [
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_first01', title: 'First light', publishedAt: '2026-01-10', draft: false, excerpt: 'The first post.', body: ['One.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_second01', title: 'Second firing', publishedAt: '2026-02-10', draft: false, excerpt: 'The second post.', body: ['Two.'] }
  ],
  'Publish two posts'
);
assert.equal(r.ok, true, `the posts are published: ${r.error?.message}`);
const s = (await snapshot()).state;
const home = s.pages[s.site.homePageId];
const index = s.collections.posts.settings.route;
assert.ok(index, 'the blog has an index address');
await eventually(async () => assert.equal(await framePath(), home.route, 'the canvas shows Home'), 20000);
await emptyCard.waitFor({ timeout: 20000 });

step('View index opens the blog index in Preview');
await openRail('Pages');
await win.getByTestId('view-index-posts').click();
await pill.waitFor();
await eventually(async () => assert.equal(await framePath(), index, 'the frame is on the blog index'), 30000);
await eventually(async () => assert.equal(await frame.getByText('Second firing').count() > 0, true, 'the index lists the posts'), 20000);
await win.screenshot({ path: join(SHOTS, 'view-index-preview.png') });

step('Back to editing shows Home again, not the index under its name');
await pill.getByRole('button', { name: 'Back to editing' }).click();
await eventually(async () => assert.equal(await framePath(), home.route, 'the canvas is back on Home'), 30000);
await eventually(async () => assert.equal(await frame.getByText('Second firing').count(), 0, 'the blog list is gone from the canvas'), 20000);
assert.match(await win.locator('.project-title .page').innerText(), new RegExp(home.title), 'the toolbar names Home');
await emptyCard.waitFor({ timeout: 20000 });
await win.screenshot({ path: join(SHOTS, 'view-index-edit.png') });

step('Preview after it starts on Home');
await win.locator('button[title^="Preview:"]').click();
await pill.waitFor();
await eventually(async () => assert.equal(await pill.locator('output').innerText(), home.route, 'the pill shows Home\'s address'), 15000);
assert.equal(await framePath(), home.route, 'the frame stays on Home');
await pill.getByRole('button', { name: 'Back to editing' }).click();
await eventually(async () => assert.equal(await framePath(), home.route, 'the canvas stays on Home'), 15000);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nview-index: passed');
