// Dragging an image from Assets onto the page, against the real app (#505). Held over the Split hero's empty image,
// the tile outlines that image and the strip says what a drop does; released, the image takes the picture with its
// suggested alt text as one change, the hero is selected with its inspector open, and one Undo empties it again.
// Anywhere else on the hero the drop goes to the same empty image; on a section with no empty image nothing is
// outlined and a release changes nothing; Escape cancels.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('asset-drag');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
/** The newest change History holds. */
const newest = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).at(-1) ?? null);
const dropLabel = win.locator('[data-testid="image-drop-label"]');
const dropTarget = win.locator('[data-testid="image-drop-target"]');

const start = await snapshot();
const home = start.site.homePageId;
const owner = { kind: 'page', id: home };
const placed = (componentId) => Object.values(start.pages[home].nodes).find((n) => n.kind === 'instance' && start.components[n.definitionId]?.componentId === componentId).id;
const hero = placed('hero.split');
const stats = placed('stats.row');
const heroImage = async () => (await snapshot()).pages[home].nodes[hero].props.image;
const reading = start.assets.assets.a_reading;
assert.ok(reading?.altSuggestion, 'the starter’s reading nook has a suggested alt text');

/**
 * A point of an element in the page, in the window, brought into the canvas's view first. The preview is scaled to
 * fit, which Playwright's own boxes for elements in the frame leave out, so the point is the frame's box on screen
 * plus the element's place in the page, scaled.
 */
const pointIn = async (locator, fx, fy) => {
  // The page scrolls inside its frame: an element below the fold is brought into the frame's view first.
  await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    if (b.top < 0 || b.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  const view = await win.locator('.canvas-scroll').boundingBox();
  const place = async () => {
    const f = await win.locator('.frame-box iframe').boundingBox();
    const r = await locator.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth };
    });
    const k = f.width / r.vw;
    return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + r.height * fy) * k, width: r.width * k, height: r.height * k, left: f.x + r.x * k, top: f.y + r.y * k };
  };
  let at = await place();
  if (at.y < view.y + 20 || at.y > view.y + view.height - 20) {
    await win.locator('.canvas-scroll').evaluate((el, dy) => el.scrollBy(0, dy), at.y - (view.y + view.height / 2));
    await win.waitForTimeout(150);
    at = await place();
  }
  return at;
};
/** Press on the tile and move it a little, so it is dragged rather than clicked, then over a point of the page. */
const dragTo = async (tile, locator, fx = 0.5, fy = 0.5) => {
  // Scrolled to before the drag starts, as an author would.
  await pointIn(locator, fx, fy);
  await win.waitForTimeout(150);
  await tile.scrollIntoViewIfNeeded();
  const t = await tile.boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2 + 4, { steps: 3 });
  const at = await pointIn(locator, fx, fy);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  return at;
};

step('the Split hero’s image is emptied: it shows the neutral placeholder');
await apply([{ type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: null, alt: '' } }], 'Empty the hero image');
const placeholder = frame.locator(`[data-so-ctx$="|${hero}"][data-so-node="media"]`);
await eventually(async () => assert.equal(await placeholder.evaluate((el) => el.classList.contains('so-img--placeholder')), true, 'the hero shows the placeholder'));
const heading = frame.locator(`[data-so-ctx$="|${hero}"]`).locator('h1').first();
await win.locator('.rail [aria-label="Assets"]').click();
const tile = win.locator('[data-asset="a_reading"]');
await tile.waitFor();

step('held over the placeholder, the placeholder is outlined; released, it takes the picture as one change');
const at = await dragTo(tile, placeholder);
await eventually(async () => assert.match(await dropLabel.innerText(), /^Place .+ as Image in /, 'the strip says the image fills the hero’s image'));
await eventually(async () => {
  const box = await dropTarget.boundingBox();
  assert.ok(box, 'the image is outlined');
  for (const [k, want] of [['x', at.left], ['y', at.top], ['width', at.width], ['height', at.height]]) assert.ok(Math.abs(box[k] - want) < 3, `the outline is the placeholder’s box (${k}: ${box[k]} vs ${want})`);
});
await win.screenshot({ path: join(SHOTS, 'asset-drag-over-placeholder.png') });
const before = await newest();
await win.mouse.up();
await eventually(async () => assert.deepEqual(await heroImage(), { assetId: 'a_reading', alt: reading.altSuggestion }, 'the hero shows the reading nook, with its suggested alt text'));
const change = await newest();
assert.notEqual(change.id, before?.id);
assert.match(change.label, /^Place /, 'one change');
assert.equal(await dropLabel.count(), 0, 'the drop indicator goes away');
await eventually(async () => assert.ok(await win.locator('#dock-panel-inspect').isVisible(), 'the inspector is open'));
// The hero's image field, opened and focused.
await eventually(async () => assert.equal(await win.evaluate(() => !!document.activeElement?.closest('#dock-panel-inspect [data-field="image"]')), true, 'focus is in the hero’s image field'));
await win.screenshot({ path: join(SHOTS, 'asset-drag-dropped.png') });
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(await heroImage(), { assetId: null, alt: '' }, 'one Undo empties the image again'));

/** Whether the drop outline is an element's box on screen. */
const outlines = async (locator, what) => {
  const want = await pointIn(locator, 0.5, 0.5);
  const box = await dropTarget.boundingBox();
  assert.ok(box, `${what} is outlined`);
  for (const [k, w] of [['x', want.left], ['y', want.top], ['width', want.width], ['height', want.height]]) assert.ok(Math.abs(box[k] - w) < 3, `the outline is ${what}’s box (${k}: ${box[k]} vs ${w})`);
};
const other = Object.keys(start.assets.assets).find((id) => id !== 'a_reading' && start.assets.assets[id].kind === 'image');

step('anywhere else on the hero, the drop goes to its one empty image, outlined as itself');
await dragTo(tile, heading);
await eventually(async () => assert.match(await dropLabel.innerText(), /^Place .+ as Image in /, 'over the heading, the hero’s empty image would take it'));
await eventually(() => outlines(placeholder, 'the hero’s empty image'));
await win.mouse.up();
await eventually(async () => assert.deepEqual(await heroImage(), { assetId: 'a_reading', alt: reading.altSuggestion }, 'the hero’s image takes it'));
assert.match((await newest()).label, /^Place /);
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(await heroImage(), { assetId: null, alt: '' }, 'one Undo empties it again'));

step('Escape cancels');
await dragTo(tile, placeholder);
await eventually(async () => assert.ok(await dropTarget.isVisible(), 'the image is outlined'));
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await dropLabel.count(), 0, 'Escape ends the drag'));
await win.mouse.up();
await win.waitForTimeout(300);
assert.deepEqual(await heroImage(), { assetId: null, alt: '' }, 'and nothing changes');

step('an image chosen elsewhere while the tile is held is kept');
await dragTo(tile, placeholder);
await eventually(async () => assert.ok(await dropTarget.isVisible(), 'the image is outlined'));
await apply([{ type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: other }], 'Choose another image');
await win.waitForTimeout(400);
await win.mouse.up();
await eventually(async () => assert.match(await win.locator('.toast').last().innerText(), /The project changed while you were choosing/, 'the drop says why it was not made'));
assert.equal((await heroImage()).assetId, other, 'the image chosen meanwhile stays');
await apply([{ type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: null, alt: '' } }], 'Empty the hero image');

step('the header’s logo, drawn by the header’s own code, takes a drop: empty from anywhere on the header, chosen from the logo itself');
const logo = async () => (await snapshot()).site.shell.header.nodes[start.site.shell.header.rootIds[0]].props.logo ?? null;
const logoBefore = await logo();
if (logoBefore?.assetId) {
  await apply([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: start.site.shell.header.rootIds[0], prop: 'logo', value: { assetId: null, alt: '' } }], 'Empty the logo');
}
const brand = frame.locator('.so-header__brand');
await dragTo(tile, brand);
await eventually(async () => assert.match(await dropLabel.innerText(), /^Place .+ as Logo in Header/, 'the header’s empty logo would take it'));
assert.ok(await dropTarget.isVisible(), 'the header is outlined');
await win.mouse.up();
await eventually(async () => assert.deepEqual(await logo(), { assetId: 'a_reading', alt: reading.altSuggestion }, 'the logo is the reading nook'));
const shownLogo = frame.locator('.so-header__logo');
await eventually(async () => assert.equal(await shownLogo.count(), 1, 'the header shows it'));
await dragTo(win.locator(`[data-asset="${other}"]`), shownLogo);
await eventually(async () => assert.match(await dropLabel.innerText(), /^Replace Logo in Header with /, 'over the logo, the logo would be replaced'));
await eventually(() => outlines(shownLogo, 'the logo'));
await win.screenshot({ path: join(SHOTS, 'asset-drag-logo.png') });
await win.mouse.up();
await eventually(async () => assert.equal((await logo())?.assetId, other, 'the logo is replaced'));
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.equal((await logo())?.assetId, 'a_reading', 'one Undo puts the first logo back'));

step('over a section with no empty image, nothing is outlined and a release changes nothing');
const plain = frame.locator(`[data-so-ctx$="|${stats}"]`).first();
await dragTo(tile, plain);
await eventually(async () => assert.match(await dropLabel.innerText(), /^Point at an image/, 'the strip asks for an image'));
assert.equal(await dropTarget.count(), 0, 'nothing is outlined');
const still = await newest();
await win.mouse.up();
await win.waitForTimeout(500);
assert.equal((await newest()).id, still.id, 'no change is made');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nasset-drag: all checks passed');
