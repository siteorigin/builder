// A section dragged by its grip and held at the canvas's bottom or top edge scrolls the page, with no further pointer
// movement or wheel, and stops when the pointer leaves the edge or the drag is cancelled (#904). The drop line stays
// inside the part of the page the canvas shows, and the release moves the section where it says.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('drag-scroll');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const roots = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    return s.state.pages[s.state.site.homePageId].rootIds;
  });
const name = (id) =>
  win.evaluate(async (id) => {
    const s = await window.builder.project.snapshot();
    const p = s.state.pages[s.state.site.homePageId];
    return s.state.components[p.nodes[id].definitionId]?.name;
  }, id);
const scrollY = () => frame.locator('html').evaluate(() => window.scrollY);
const dropLine = win.locator('[data-testid="insert-drop-line"]');
const wait = (ms) => win.waitForTimeout(ms);

step('select the first section and pick it up by its grip');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await wait(800);
const before = await roots();
assert.ok(before.length >= 4, 'the starter has sections to scroll past');
const first = await name(before[0]);
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: first }).first().click();
await wait(800);
assert.equal(await scrollY(), 0, 'the page starts at its top');

const grab = async () => {
  const gb = await win.locator('.ov-chip [aria-label="Drag to move"]').boundingBox();
  assert.ok(gb, 'the selection chip shows a drag grip');
  const wrap = await win.locator('.frame-wrap').boundingBox();
  await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await win.mouse.down();
  await win.mouse.move(wrap.x + wrap.width / 2, wrap.y + 200, { steps: 6 });
  await wait(300);
};
const view = async () => {
  const v = await win.locator('.canvas-scroll').boundingBox();
  const w = await win.locator('.frame-wrap').boundingBox();
  return { x: w.x + w.width / 2, top: Math.max(v.y, w.y), bottom: Math.min(v.y + v.height, w.y + w.height) };
};

step('held at the bottom edge, the page scrolls with no more movement');
await grab();
let v = await view();
await win.mouse.move(v.x, v.bottom - 6, { steps: 6 });
const atEdge = await scrollY();
await eventually(async () => assert.ok((await scrollY()) > atEdge + 400, 'the page scrolls down while the drag is held at the bottom edge'), 4000, 100);
const later = await scrollY();
await wait(500);
assert.ok((await scrollY()) > later, 'and keeps scrolling while it is held there');
await win.screenshot({ path: join(SHOTS, 'drag-scroll-bottom.png') });

step('the drop line shows inside the part of the page the canvas shows');
await eventually(async () => {
  const line = await dropLine.boundingBox();
  assert.ok(line, 'a drop line shows for the gap under the pointer');
  assert.ok(line.y >= v.top && line.y + line.height <= v.bottom, `the line (${line.y}) is inside the canvas (${v.top}–${v.bottom})`);
});

step('away from the edge it stops');
await win.mouse.move(v.x, (v.top + v.bottom) / 2, { steps: 4 });
await wait(300);
const still = await scrollY();
await wait(600);
assert.equal(await scrollY(), still, 'the page stays put with the pointer away from the edges');
await eventually(async () => assert.ok(await dropLine.boundingBox(), 'the line shows where the pointer now is'));

step('the wheel scrolls the page during the drag without taking the line away');
// Every time the line leaves the overlay is counted, however briefly: a wheel step used to clear it until the page was
// measured again.
await win.evaluate(() => {
  const w = window;
  w.__lineGone = 0;
  w.__lineWatch = new MutationObserver((list) => {
    for (const m of list) for (const n of m.removedNodes) if (n instanceof Element && n.matches('[data-testid="insert-drop-line"]')) w.__lineGone++;
  });
  w.__lineWatch.observe(document.querySelector('.frame-wrap'), { childList: true, subtree: true });
});
const wheelFrom = await scrollY();
for (let i = 0; i < 4; i++) {
  await win.mouse.wheel(0, 120);
  await wait(120);
}
await eventually(async () => assert.ok((await scrollY()) > wheelFrom, 'the wheel scrolls the page'));
await wait(300);
const gone = await win.evaluate(() => {
  window.__lineWatch.disconnect();
  return window.__lineGone;
});
assert.equal(gone, 0, 'the line stays drawn while the page scrolls under the wheel');
assert.ok(await dropLine.boundingBox(), 'and shows where the pointer is after it');

step('the release moves the section to the place shown');
await win.mouse.up();
await eventually(async () => {
  const after = await roots();
  assert.notEqual(after[0], before[0], 'the first section has moved');
  assert.ok(after.indexOf(before[0]) >= 2, 'it moved well down the page, where the scroll took it');
});
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(await roots(), before, 'Undo puts it back'));

step('held at the top edge it scrolls back up, and Escape stops it without a move');
await win.locator('.list-item', { hasText: first }).first().click();
await wait(800);
await frame.locator('html').evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await wait(300);
await grab();
v = await view();
await win.mouse.move(v.x, v.bottom - 6, { steps: 6 });
await eventually(async () => assert.ok((await scrollY()) > 600, 'down first'), 4000, 100);
await win.mouse.move(v.x, v.top + 4, { steps: 6 });
const high = await scrollY();
await eventually(async () => assert.ok((await scrollY()) < high - 200, 'the page scrolls up while the drag is held at the top edge'), 4000, 100);
await win.keyboard.press('Escape');
await wait(200);
const stopped = await scrollY();
await wait(600);
assert.equal(await scrollY(), stopped, 'Escape stops the scrolling');
await win.mouse.up();
await wait(400);
assert.deepEqual(await roots(), before, 'a cancelled drag moves nothing');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ndrag-scroll: all checks passed');
