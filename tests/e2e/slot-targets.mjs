// The slots of a component that shows several, against the real app (#652). A Split placed in a Section shows Main
// and Sidebar, both empty. A click on either's empty box selects that slot, and a Paragraph tile clicked then goes
// into it. A Paragraph dragged from Insert draws a drop surface for each empty slot, at least 72px tall, and goes into
// the slot it is dropped on, even a Sidebar whose column is collapsed to no height and clips it, at a point the page
// shows nothing of it (the surface is drawn over the page; the floor for a placeholder itself made shorter than 72px is
// covered by tests/unit/insert-drop.test.ts). An Image the Sidebar does not take says why on the Sidebar itself. Each
// drag leaves the page as it found it, and Preview shows no slot placeholder at all. A Paragraph in Main drags by the
// selection's grip into Sidebar as one change that keeps the node (#658); a Button, which Sidebar does not take, is
// refused there live and released there changes nothing; Escape, or letting go back on the grip, changes nothing.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('slot-targets');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Corner cafe', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const undo = () => win.evaluate(() => window.builder.project.undo());
const newest = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).at(-1) ?? null);
const panel = win.locator('.side-panel-view:not([hidden])');
const basicTile = (name) => panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const chip = async () => (await win.locator('.ov-chip .label').allInnerTexts()).join(' ');
const dropLabel = win.locator('[data-testid="insert-drop-label"]');
const dropTarget = win.locator('[data-testid="insert-drop-target"]');
const dropReason = win.locator('[data-testid="insert-drop-reason"]');
const surfaces = win.locator('[data-testid="insert-slot-surface"]');
const surface = (label) => win.locator(`[data-testid="insert-slot-surface"][data-slot="${label}"]`);
const marker = (slot) => frame.locator(`[data-so-slot-empty="${slot}"]`);
const openInsert = async () => {
  if (!(await panel.locator('.insert-group[data-group="basics"]').isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await panel.locator('.insert-group[data-group="basics"]').waitFor();
};

/** The frame's box on screen and the page's scale in it (the preview is drawn to fit). */
const frameScale = async () => {
  const f = await win.locator('.frame-box iframe').boundingBox();
  const vw = await frame.locator('html').evaluate(() => window.innerWidth);
  return { f, k: f.width / vw };
};
/** A point of a frame element in the window: `fx` across its width, and `dy` page pixels below its top. */
const pointAt = async (locator, fx, dy) => {
  const { f, k } = await frameScale();
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + dy) * k };
};
/** A marker's box in page pixels, for checking the page is as it was. */
const pageBox = (locator) =>
  locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  });
/** Press on a tile and move it a little, so it is dragged rather than clicked. */
const pickUp = async (tile) => {
  await tile.scrollIntoViewIfNeeded();
  const t = await tile.boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2 + 4, { steps: 3 });
};

step('Corner cafe: a Section holding a Split that shows Main and Sidebar side by side, both empty');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).pages[pageId];
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Insert section');
const design = (sideStyles) => ({
  type: 'component.upsert',
  name: 'Split',
  insertAs: 'element',
  properties: {},
  nodes: [
    { kind: 'element', id: 'root', children: ['mainCol', 'sideCol'], styles: { base: { layout: 'grid', columns: 2, gap: { token: 'space.md' } } } },
    { kind: 'element', id: 'mainCol', children: ['main'] },
    { kind: 'slot', id: 'main', slot: 'main' },
    { kind: 'element', id: 'sideCol', children: ['side'], ...(sideStyles ? { styles: { base: sideStyles } } : {}) },
    { kind: 'slot', id: 'side', slot: 'sidebar' }
  ],
  slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar', primitives: ['text'] } }
});
const [{ definitionId }] = await apply([design(null)], 'Create Split');
const [{ nodeId: split }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', definitionId }], 'Place Split');
const slotOf = async (slot) => (await home()).nodes[split].slots?.[slot] ?? [];
await marker('main').waitFor({ timeout: 30000 });
await marker('sidebar').waitFor({ timeout: 30000 });
await openInsert();

for (const [slot, label] of [
  ['main', 'Main'],
  ['sidebar', 'Sidebar']
]) {
  step(`a click on ${label}’s empty box selects ${label}, and a Paragraph tile then goes into it`);
  const at = await pointAt(marker(slot), 0.5, 20);
  await win.mouse.click(at.x, at.y);
  await eventually(async () => assert.match(await chip(), new RegExp(`^${label}`), `the chip names ${label}`));
  assert.ok((await win.locator('.ov-selected').count()) >= 1, `${label}’s box is outlined`);
  await eventually(async () => assert.match(await panel.locator('.insert-where-next').innerText(), new RegExp(`inside\\s+${label} in Split`, "i"), 'the Insert strip says where it goes'));
  if (slot === 'sidebar') await win.screenshot({ path: join(SHOTS, 'slot-targets-selected.png') });
  await basicTile('Paragraph').click();
  await eventually(async () => assert.equal((await slotOf(slot)).length, 1, `the Paragraph is in ${label}`));
  assert.deepEqual(await slotOf(slot === 'main' ? 'sidebar' : 'main'), [], 'and the other slot is untouched');
  await undo();
  await eventually(async () => assert.deepEqual(await slotOf(slot), []));
  await marker(slot).waitFor();
}

step('a Paragraph dragged from Insert draws a surface for each empty slot, at least 72px tall, and drops into Main');
{
  await win.keyboard.press('Escape');
  const resting = { main: await pageBox(marker('main')), sidebar: await pageBox(marker('sidebar')) };
  const changes = await newest();
  await pickUp(basicTile('Paragraph'));
  const at = await pointAt(marker('main'), 0.5, 30);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.equal(await surfaces.count(), 2, 'both empty slots show as places to drop'));
  const { k } = await frameScale();
  for (const label of ['Main', 'Sidebar']) {
    const b = await surface(label).boundingBox();
    assert.ok(b.height >= 72 * k - 1, `${label}’s surface is at least 72px of the page tall: ${b.height / k}`);
  }
  await eventually(async () => assert.match(await dropLabel.innerText(), /Paragraph inside Main in Split/, 'the label names the slot'));
  assert.ok(await dropTarget.isVisible(), 'the slot is outlined');
  await win.screenshot({ path: join(SHOTS, 'slot-targets-drag.png') });
  await win.mouse.up();
  await eventually(async () => assert.equal((await slotOf('main')).length, 1, 'the Paragraph is in Main'));
  assert.deepEqual(await slotOf('sidebar'), [], 'and not in Sidebar');
  assert.notEqual((await newest()).id, changes?.id, 'as one change');
  assert.equal(await surfaces.count(), 0, 'the surfaces go with the drag');
  await undo();
  await eventually(async () => assert.deepEqual(await slotOf('main'), []));
  await marker('main').waitFor();
  assert.deepEqual({ main: await pageBox(marker('main')), sidebar: await pageBox(marker('sidebar')) }, resting, 'the page lays out as it did before the drag');
}

step('a Paragraph in Main drags by its grip into Sidebar as one change, keeping itself; Undo puts it back (#658)');
const grip = win.locator('.ov-chip [aria-label="Drag to move"]');
/** Select what the chip calls `name` by clicking `locator` in the page: each click steps one level in. */
const selectIn = async (locator, name) => {
  for (let i = 0; i < 5; i++) {
    const at = await pointAt(locator, 0.5, 4);
    await win.mouse.click(at.x, at.y);
    try {
      return await eventually(async () => assert.match(await chip(), name), 1500);
    } catch {
      await win.waitForTimeout(400);
    }
  }
  assert.fail(`${name} is selected; the chip says ${await chip()}`);
};
/** Press the selection's grip and move off it a little, so the selection is dragged; returns where it was pressed. */
const pickUpSelection = async () => {
  // The chip moves to a new selection once the page has measured it: pressed where it has settled.
  const g = await eventually(async () => {
    const a = await grip.boundingBox();
    await win.waitForTimeout(250);
    const b = await grip.boundingBox();
    assert.ok(a && b && a.x === b.x && a.y === b.y, 'the chip shows its grip, settled where it is');
    return b;
  });
  const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 12, from.y + 6, { steps: 3 });
  return from;
};
const [{ nodeId: para }, { nodeId: button }] = await apply(
  [
    { type: 'node.insert', owner, parentId: split, slot: 'main', primitive: 'paragraph', text: 'Open daily from eight' },
    { type: 'node.insert', owner, parentId: split, slot: 'main', primitive: 'button', text: 'Book a table' }
  ],
  'Fill Main'
);
const paraEl = frame.locator('p', { hasText: 'Open daily from eight' }).first();
await paraEl.waitFor({ timeout: 30000 });
await marker('sidebar').waitFor();
{
  const before = (await home()).nodes[para];
  const changes = await newest();
  await selectIn(paraEl, /^Text/);
  await pickUpSelection();
  const at = await pointAt(marker('sidebar'), 0.5, 30);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.match(await dropLabel.innerText(), /Text inside Sidebar in Split/, 'the label names the slot before release'));
  assert.ok(await dropTarget.isVisible(), 'Sidebar is outlined');
  await win.screenshot({ path: join(SHOTS, 'slot-targets-move.png') });
  await win.mouse.up();
  await eventually(async () => assert.deepEqual(await slotOf('sidebar'), [para], 'the Paragraph is in Sidebar'));
  assert.deepEqual(await slotOf('main'), [button], 'and only the Button is left in Main');
  assert.deepEqual((await home()).nodes[para], before, 'the same node, with its text and styles');
  const moved = await newest();
  assert.notEqual(moved.id, changes?.id, 'as a change');
  assert.match(moved.label, /^Move Text/, 'named as a move');
  await undo();
  await eventually(async () => assert.deepEqual(await slotOf('main'), [para, button], 'one Undo puts it back where it was'));
  assert.deepEqual(await slotOf('sidebar'), []);
  assert.equal((await newest()).id, changes?.id, 'Undo took back exactly that one change');
}

step('the Button dragged over Sidebar, which takes only text, is refused there and says why; released there, nothing changes (#658)');
{
  await marker('sidebar').waitFor();
  const changes = await newest();
  await selectIn(frame.getByText('Book a table', { exact: true }).first(), /^(Button|Link)/);
  await pickUpSelection();
  const at = await pointAt(marker('sidebar'), 0.5, 30);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.match(await dropReason.innerText(), /“Sidebar” slot of “Split” takes text/, 'the reason shows on the slot'));
  assert.match(await dropLabel.innerText(), /Can’t move (Button|Link) here/);
  assert.equal(await surface('Sidebar').count(), 0, 'Sidebar is not drawn as a place for it');
  await win.screenshot({ path: join(SHOTS, 'slot-targets-move-refused.png') });
  await win.mouse.up();
  await eventually(async () => assert.equal(await dropLabel.count(), 0, 'the drag is over'));
  await win.waitForTimeout(300);
  assert.equal((await newest()).id, changes?.id, 'nothing changed');
  assert.deepEqual([await slotOf('main'), await slotOf('sidebar')], [[para, button], []]);
}

step('a move dragged to Sidebar and cancelled with Escape, or let go back on its grip, changes nothing (#658)');
{
  const changes = await newest();
  // The Button's chip sits over the Paragraph above it: Escape steps out to Main first, so a click finds the Paragraph.
  await win.keyboard.press('Escape');
  await eventually(async () => assert.doesNotMatch(await chip(), /^(Button|Link)/));
  await selectIn(paraEl, /^Text/);
  await pickUpSelection();
  const at = await pointAt(marker('sidebar'), 0.5, 30);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.match(await dropLabel.innerText(), /Text inside Sidebar in Split/));
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await dropLabel.count(), 0, 'Escape ends the drag'));
  await win.mouse.up();
  await eventually(async () => assert.match(await chip(), /^Text/, 'the Paragraph is still selected'));
  const from = await pickUpSelection();
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.match(await dropLabel.innerText(), /Text inside Sidebar in Split/));
  await win.mouse.move(from.x, from.y, { steps: 12 });
  await eventually(async () => assert.doesNotMatch(await dropLabel.innerText(), /inside Sidebar/, 'back on the grip, it goes nowhere'));
  await win.mouse.up();
  await eventually(async () => assert.equal(await dropLabel.count(), 0));
  await win.waitForTimeout(300);
  assert.equal((await newest()).id, changes?.id, 'nothing changed');
  assert.deepEqual([await slotOf('main'), await slotOf('sidebar')], [[para, button], []]);
  await win.keyboard.press('Escape');
  await undo();
  await eventually(async () => assert.deepEqual(await slotOf('main'), [], 'the fill is taken away for the steps after'));
  await marker('main').waitFor();
}

step('with Sidebar’s column collapsed to no height, a drop below where the column shows still goes into Sidebar');
{
  await apply([{ ...design({ height: '0px', overflow: 'hidden' }), definitionId }], 'Collapse the sidebar');
  await eventually(async () => {
    const col = await marker('sidebar').evaluate((el) => el.parentElement.getBoundingClientRect().height);
    assert.equal(col, 0, 'the column takes no height');
  }, 30000);
  await pickUp(basicTile('Paragraph'));
  // 40 page pixels below the column's top: inside the surface, where the collapsed column shows nothing.
  const at = await pointAt(marker('sidebar'), 0.5, 40);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.match(await dropLabel.innerText(), /Paragraph inside Sidebar in Split/, 'the drop goes into Sidebar'));
  const { k } = await frameScale();
  const b = await surface('Sidebar').boundingBox();
  assert.ok(b.height >= 72 * k - 1, `Sidebar’s surface is at least 72px of the page tall though its column has none: ${b.height / k}`);
  await win.screenshot({ path: join(SHOTS, 'slot-targets-collapsed.png') });
  await win.mouse.up();
  await eventually(async () => assert.equal((await slotOf('sidebar')).length, 1, 'the Paragraph is in Sidebar'));
  assert.deepEqual(await slotOf('main'), [], 'and not in Main');
  await undo();
  await eventually(async () => assert.deepEqual(await slotOf('sidebar'), []));
}

step('an Image dragged over Sidebar, which takes only text, says so on Sidebar; Escape leaves everything as it was');
{
  await marker('sidebar').waitFor({ state: 'attached' });
  const changes = await newest();
  await pickUp(basicTile('Image'));
  const at = await pointAt(marker('sidebar'), 0.5, 30);
  await win.mouse.move(at.x, at.y, { steps: 12 });
  await eventually(async () => assert.match(await dropReason.innerText(), /“Sidebar” slot of “Split” takes text, not an image/, 'the reason shows on the slot'));
  assert.equal(await surface('Sidebar').count(), 0, 'Sidebar is not drawn as a place for an Image');
  assert.equal(await surface('Main').count(), 1, 'Main still is');
  await win.screenshot({ path: join(SHOTS, 'slot-targets-refused.png') });
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await surfaces.count(), 0, 'the surfaces go'));
  await win.mouse.up();
  assert.equal(await dropLabel.count(), 0, 'the drag is over');
  assert.equal((await newest()).id, changes?.id, 'nothing changed');
  assert.deepEqual([await slotOf('main'), await slotOf('sidebar')], [[], []]);
}

step('Preview shows no slot placeholder, and no slot address, anywhere on the page');
{
  await win.locator('.toolbar').getByRole('button', { name: 'Preview', exact: true }).click();
  await frame.locator('html:not([data-so-editing])').waitFor({ state: 'attached' });
  await eventually(async () => assert.equal(await frame.locator('[data-so-slot-empty], [data-so-slot-node], [data-so-slot-ctx]').count(), 0));
  await win.locator('.toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached' });
  await marker('main').waitFor({ timeout: 15000 });
}

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nslot-targets: all checks passed');
