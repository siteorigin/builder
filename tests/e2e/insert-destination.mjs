// New elements and reusable components at an explicit destination, against the real app (#52). A card made inside a
// grid inserts beside the selected card in that grid, the Insert strip naming the grid before the click, and a
// component made from a whole section still goes beside the page's sections. Insert tiles drag onto the canvas: a
// section before, between and after the page's sections, a basic element between two cards in a grid, each with its
// line and label before release and one Undo after. A gap an Order style keeps it out of is refused and says so,
// Escape cancels, and a tile still inserts from the keyboard after a drag.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('insert-destination');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Artist profiles', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const undo = () => win.evaluate(() => window.builder.project.undo());
/** The newest change History holds (it trims old ones by size, so they are not counted). */
const newest = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).at(-1) ?? null);
const panel = win.locator('.side-panel-view:not([hidden])');
const strip = panel.locator('.insert-where-next');
const projectTile = (name) => panel.locator('.insert-tile.project', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const sectionTile = (name) => panel.locator('.insert-tile.section', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first();
const basicTile = (name) => panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const dropLabel = win.locator('[data-testid="insert-drop-label"]');
const dropLine = win.locator('[data-testid="insert-drop-line"]');
const dropTarget = win.locator('[data-testid="insert-drop-target"]');
const openInsert = async () => {
  if (!(await panel.locator('.insert-group[data-kind="element"]').isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await panel.locator('.insert-group[data-kind="element"]').waitFor();
};

/**
 * A point of an element in the page, in the window, brought into the canvas's view first. The preview is scaled to
 * fit, which Playwright's own boxes for elements in the frame leave out, so the point is the frame's box on screen
 * plus the element's place in the page, scaled.
 */
const pointIn = async (locator, fx, fy) => {
  const view = await win.locator('.canvas-scroll').boundingBox();
  const place = async () => {
    const f = await win.locator('.frame-box iframe').boundingBox();
    const r = await locator.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth };
    });
    const k = f.width / r.vw;
    return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + r.height * fy) * k };
  };
  let at = await place();
  if (at.y < view.y + 20 || at.y > view.y + view.height - 20) {
    await win.locator('.canvas-scroll').evaluate((el, dy) => el.scrollBy(0, dy), at.y - (view.y + view.height / 2));
    await win.waitForTimeout(150);
    at = await place();
  }
  return at;
};
/** Select what a chip calls `name` by clicking an element in the page where it shows (see pointIn): each click steps
 *  one level in, from the section. */
const selectIn = async (locator, name) => {
  for (let i = 0; i < 5; i++) {
    const at = await pointIn(locator, 0.5, 0.5);
    await win.mouse.click(at.x, at.y);
    try {
      return await eventually(async () => assert.match((await win.locator('.ov-chip .label').allInnerTexts()).join(' '), name), 1500);
    } catch {
      await win.waitForTimeout(400);
    }
  }
  assert.fail(`${name} is selected; the chip says ${(await win.locator('.ov-chip .label').allInnerTexts()).join(' ')}`);
};

step('Artist profiles: two sections, the first holding a grid with one Exhibitor card');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).pages[pageId];
const [{ nodeId: first }, { nodeId: second }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ],
  'Insert sections'
);
const [{ nodeId: grid }] = await apply([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'grid' }], 'Insert grid');
const [{ nodeId: stack }] = await apply([{ type: 'node.insert', owner, parentId: grid, primitive: 'stack' }], 'Insert stack');
await apply(
  [
    { type: 'node.insert', owner, parentId: stack, primitive: 'paragraph', text: 'Hall A, stand 12' },
    { type: 'node.insert', owner, parentId: second, slot: 'content', primitive: 'heading', text: 'See you there' },
    { type: 'node.setContent', owner, nodeId: first, field: 'anchor', value: 'first' }
  ],
  'Fill sections'
);
const [{ nodeId: card, definitionId: cardDef }] = await apply([{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Exhibitor card' }], 'Create Exhibitor card');
assert.equal((await snapshot()).components[cardDef].insertAs, 'element', 'a card made inside a grid inserts as an element');
await frame.locator('p', { hasText: 'Hall A, stand 12' }).first().waitFor();

step('with the card selected, its tile names the grid before the click, and inserts a second card there');
await selectIn(frame.locator('p', { hasText: 'Hall A, stand 12' }).first(), /Exhibitor card/);
await openInsert();
await projectTile('Exhibitor card').hover();
await eventually(async () => assert.match(await strip.getAttribute('title'), /^Exhibitor card goes after Exhibitor card in Grid$/, 'the strip names the grid the card goes into'));
const rootsBefore = (await home()).rootIds;
const before = await newest();
await projectTile('Exhibitor card').click();
await eventually(async () => {
  const page = await home();
  assert.equal(page.nodes[grid].children.length, 2, 'the grid holds two cards');
  assert.equal(page.nodes[grid].children[0], card, 'the first card is where it was');
  assert.equal(page.nodes[page.nodes[grid].children[1]].definitionId, cardDef, 'the second is a placement of the card');
  assert.deepEqual(page.rootIds, rootsBefore, 'nothing new at the top of the page');
});
assert.notEqual((await newest()).id, before?.id);
assert.equal((await newest()).label, 'Insert Exhibitor card', 'one change');
await panel.locator('.insert-where-done', { hasText: 'Exhibitor card' }).waitFor();
await win.screenshot({ path: join(SHOTS, 'insert-destination-card.png') });
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes[grid].children, [card], 'one Undo takes the second card away'));

step('a component made from a whole section still goes after the section holding the selection');
const [{ nodeId: band, definitionId: bandDef }] = await apply([{ type: 'component.createFromNode', owner, nodeId: second, name: 'Closing band' }], 'Create Closing band');
assert.equal((await snapshot()).components[bandDef].insertAs, 'section');
await selectIn(frame.locator('p', { hasText: 'Hall A, stand 12' }).first(), /Exhibitor card/);
await openInsert();
// Away from the tiles, the strip follows the one with keyboard focus.
await win.mouse.move(5, 500);
await projectTile('Closing band').focus();
await eventually(async () => assert.match(await strip.getAttribute('title'), /^Closing band goes after Section/, 'the strip says it goes after the section'));
await projectTile('Closing band').click();
await eventually(async () => {
  const page = await home();
  assert.equal(page.rootIds.length, 3);
  assert.equal(page.rootIds[0], first);
  assert.equal(page.nodes[page.rootIds[1]].definitionId, bandDef, 'the new band is right after the first section');
  assert.equal(page.rootIds[2], band);
  assert.deepEqual(page.nodes[grid].children, [card], 'and not in the grid');
});
await undo();
await eventually(async () => assert.deepEqual((await home()).rootIds, [first, band]));

/** Press on a tile and move it a little, so it is dragged rather than clicked. */
const pickUp = async (tile) => {
  await tile.scrollIntoViewIfNeeded();
  const t = await tile.boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2 + 4, { steps: 3 });
};
const dragTo = async (tile, locator, fx, fy) => {
  await pickUp(tile);
  const at = await pointIn(locator, fx, fy);
  await win.mouse.move(at.x, at.y, { steps: 12 });
};
const firstBox = frame.locator('#first');
const bandBox = frame.locator(`[data-so-ctx$="|${band}"]`).first();

step('Gallery drags before, between and after the two sections, each in one change');
await openInsert();
for (const [where, locator, fy, index, label] of [
  ['before', firstBox, 0.15, 0, /Gallery at the top of Home/],
  ['between', firstBox, 0.85, 1, /Gallery after Section/],
  ['after', bandBox, 0.85, 2, /Gallery after Closing band/]
]) {
  const roots = (await home()).rootIds;
  const changes = await newest();
  await dragTo(sectionTile('Gallery'), locator, 0.5, fy);
  await eventually(async () => assert.match(await dropLabel.innerText(), label, `the label says where Gallery goes (${where})`));
  assert.ok(await dropLine.isVisible(), `a line shows the gap (${where})`);
  if (where === 'between') await win.screenshot({ path: join(SHOTS, 'insert-destination-drag-section.png') });
  await win.mouse.up();
  await eventually(async () => {
    const page = await home();
    assert.equal(page.rootIds.length, 3, `Gallery is added (${where})`);
    assert.deepEqual(page.rootIds.filter((_, i) => i !== index), roots, `the other sections keep their order (${where})`);
    assert.equal((await snapshot()).components[page.nodes[page.rootIds[index]].definitionId]?.name, 'Gallery', `Gallery is ${where} the sections`);
  });
  assert.notEqual((await newest()).id, changes?.id);
  assert.equal((await newest()).label, 'Insert Gallery', `one change (${where})`);
  assert.equal(await dropLabel.count(), 0, 'the drop indicator goes away');
  await undo();
  await eventually(async () => assert.deepEqual((await home()).rootIds, roots, `one Undo takes it away (${where})`));
}

step('a Paragraph drags between two cards in the grid');
const [{ nodeId: card2 }] = await apply([{ type: 'node.insert', owner, parentId: grid, definitionId: cardDef }], 'Insert second card');
const secondCard = frame.locator(`[data-so-ctx$="|${card2}"]`).first();
await secondCard.waitFor();
{
  const changes = await newest();
  await dragTo(basicTile('Paragraph'), secondCard, 0.15, 0.5);
  await eventually(async () => assert.match(await dropLabel.innerText(), /Paragraph after Exhibitor card in Grid/, 'the label names the grid'));
  assert.ok(await dropTarget.isVisible(), 'the grid is outlined');
  assert.ok(await dropLine.isVisible(), 'a line shows the gap between the cards');
  await win.screenshot({ path: join(SHOTS, 'insert-destination-drag-element.png') });
  await win.mouse.up();
  await eventually(async () => {
    const kids = (await home()).nodes[grid].children;
    assert.equal(kids.length, 3, 'the paragraph is in the grid');
    assert.deepEqual([kids[0], kids[2]], [card, card2], 'between the two cards');
  });
  assert.notEqual((await newest()).id, changes?.id);
  assert.equal((await newest()).label, 'Insert Paragraph', 'one change');
  await undo();
  await eventually(async () => assert.deepEqual((await home()).nodes[grid].children, [card, card2], 'one Undo takes it away'));
}

step('a gap an Order style keeps it out of is refused, and says why');
const [{ nodeId: row }] = await apply([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'row' }], 'Insert row');
const [{ nodeId: one }, { nodeId: two }] = await apply(
  [
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Shown second' },
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Shown first' }
  ],
  'Fill row'
);
await apply([{ type: 'node.setStyle', owner, nodeId: one, scope: 'base', property: 'order', value: 1 }], 'Order');
const shownLast = frame.locator('p', { hasText: 'Shown second' }).first();
await shownLast.waitFor();
{
  const page = await home();
  const changes = await newest();
  await dragTo(basicTile('Paragraph'), shownLast, 0.9, 0.5);
  await eventually(async () => assert.match(await dropLabel.innerText(), /Can’t place Paragraph here/, 'the label refuses the spot'));
  assert.equal(await dropLine.count(), 0, 'no line shows there');
  assert.match(await dropTarget.getAttribute('class'), /refused/, 'the row is outlined as refused');
  await win.screenshot({ path: join(SHOTS, 'insert-destination-refused.png') });
  await win.mouse.up();
  await win.locator('.toast', { hasText: 'Paragraph wasn’t added' }).waitFor();
  assert.deepEqual(await home(), page, 'nothing is added');
  assert.equal((await newest())?.id, changes?.id, 'and nothing is recorded');
  assert.deepEqual(page.nodes[row].children, [one, two]);
}

step('Escape cancels a drag; a tile still inserts from the keyboard afterwards');
{
  const page = await home();
  await dragTo(sectionTile('Gallery'), firstBox, 0.5, 0.85);
  await dropLabel.waitFor();
  await win.keyboard.press('Escape');
  await dropLabel.waitFor({ state: 'detached' });
  await win.mouse.up();
  await win.waitForTimeout(300);
  assert.deepEqual(await home(), page, 'Escape adds nothing');
  await selectIn(frame.locator('p', { hasText: 'Shown first' }).first(), /^Text$/);
  await openInsert();
  await basicTile('Heading').focus();
  await win.keyboard.press('Enter');
  await eventually(async () => assert.equal((await home()).nodes[row].children.length, 3, 'Enter on a tile adds it after the selection'));
}

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ninsert-destination: all checks passed');
