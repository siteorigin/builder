// Switching preview widths keeps the selected section in view (issue #168): Gallery picked in Layers on Business Home
// stays on screen at phone width and back at desktop, and its Layers row, clicked again or pressed with Enter while
// already selected, brings it back after the page has been scrolled away from it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('keep-selection');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const home = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  return { pageId: page.id, gallery: page.rootIds.find((id) => s.state.components[page.nodes[id].definitionId]?.name === 'Gallery') };
});
assert.ok(home.gallery, 'Business Home has a Gallery');
// The placement's own root: the first of its elements on the page.
const gallery = frame.locator(`[data-so-ctx="page:${home.pageId}|${home.gallery}"]`).first();
/** Where Gallery is in the preview, and the preview's size, in the page's own pixels. */
const where = () =>
  gallery.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
const topShows = async () => {
  const w = await where();
  return w.top > -2 && w.top < w.height - 40;
};
const showsAtAll = async () => {
  const w = await where();
  return w.top < w.height && w.bottom > 0;
};
/**
 * Scrolls the preview until no part of Gallery shows (to the top when Gallery starts below the frame, else past it),
 * once a change of width has settled, and checks that nothing brings it back on its own.
 */
const scrollAway = async () => {
  await new Promise((r) => setTimeout(r, 500));
  await gallery.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = r.top + scrollY;
    scrollTo({ top: top > innerHeight ? 0 : top + r.height + 1, behavior: 'instant' });
  });
  await eventually(async () => assert.equal(await showsAtAll(), false, 'Gallery is scrolled out of view'));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await showsAtAll(), false, 'and stays out of view until its row is used');
};
const row = win.locator('[role="tree"] [role="treeitem"][data-name="Gallery"]').first();

step('Gallery picked in Layers shows at desktop width');
await win.getByRole('button', { name: 'Desktop', exact: true }).click();
await win.locator('.rail [aria-label="Layers"]').click();
await row.click();
await eventually(async () => assert.equal(await topShows(), true, 'Gallery’s top is in view once it is picked'));

step('switching to Phone keeps Gallery in view, and so does switching back to Desktop');
await win.getByRole('button', { name: 'Phone', exact: true }).click();
await eventually(async () => assert.ok((await where()).width < 500, 'the preview is at phone width'));
await eventually(async () => assert.equal(await topShows(), true, 'Gallery’s top is still in view at phone width'));

step('clicking the selected Gallery row again brings it back once the page has scrolled away');
await scrollAway();
await row.click();
await eventually(async () => assert.equal(await topShows(), true, 'the same row clicked again shows Gallery'));
await scrollAway();
await row.focus();
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await topShows(), true, 'Enter on the selected row shows Gallery too'));

await win.getByRole('button', { name: 'Desktop', exact: true }).click();
await eventually(async () => assert.ok((await where()).width > 1000, 'the preview is back at desktop width'));
await eventually(async () => assert.equal(await topShows(), true, 'Gallery’s top is in view back at desktop width'));

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nkeep-selection: passed');
