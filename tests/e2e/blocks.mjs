// The theme's blocks (#664), against the real app: compact components made for a column, a grid cell or a component's
// slot. Insert lists them in a Blocks group after the column layouts. With a column selected, the Feature card's tile
// names the column and puts the card in it; the Stat card's tile drags into the other column; the Testimonial card's
// drags into a Section whose slot takes only social proof, one at a time. The + inside an empty column offers every
// block, and the + inside that slot only those it takes. Each insert is one change that one Undo takes away, and
// none adds a section to the page.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('blocks');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Studio blocks', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

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
const blocksGroup = panel.locator('.insert-group[data-group="blocks"]');
const blockTile = (name) => blocksGroup.locator('.insert-tile', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const dropLabel = win.locator('[data-testid="insert-drop-label"]');
const addButton = (side, nodeId) => win.locator(`[data-testid="canvas-add"][data-side="${side}"][data-node="${nodeId}"]`);
const list = win.locator('[data-testid="quick-insert"]');
/**
 * Point at `over` until its + shows, and press it until its list opens. The project holds a change a moment before
 * its save comes back (a second or more on Windows), and a + pressed meanwhile opens nothing, as one pressed by a
 * person would not: they press it again.
 */
const openPlus = async (button, over) => {
  for (let tries = 0; ; tries++) {
    const at = await over();
    await win.mouse.move(at.x, at.y);
    await button.waitFor({ timeout: 10000 });
    await button.click();
    if (await list.waitFor({ timeout: 3000 }).then(() => true, () => false)) return;
    if (tries === 4) throw new Error('the + never opened its list');
  }
};
const openInsert = async () => {
  if (!(await panel.locator('.insert-group[data-group="basics"]').isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await panel.locator('.insert-group[data-group="basics"]').waitFor();
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
/** Select what the chip calls `name` by clicking an element in the page: each click steps one level in. */
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
/** Press on a tile and move it a little, so it is dragged rather than clicked, then over a point of `locator`. */
const dragTo = async (tile, locator, fx, fy) => {
  await tile.scrollIntoViewIfNeeded();
  const t = await tile.boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2 + 4, { steps: 3 });
  const at = await pointIn(locator, fx, fy);
  await win.mouse.move(at.x, at.y, { steps: 12 });
};
/** A node of the page as it shows: an element by its own ID, a placement by the root its design renders for it. */
/** History records a change once it is saved, a moment after the page shows it: the newest change, when it comes. */
const oneChange = (before, label) =>
  eventually(async () => {
    const now = await newest();
    assert.notEqual(now?.id, before?.id, 'a change is recorded');
    assert.equal(now.label, label, 'one change');
  });
const inPage = (nodeId) => frame.locator(`[data-so-node="${nodeId}"], [data-so-ctx$="|${nodeId}"]`).first();

step('Home: a Section with two empty columns, and a Proof section whose slot takes one piece of social proof');
await win.getByRole('radio', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).pages[pageId];
// The Proof section first: copying the Section's design moves every Section on the page onto the copy.
const [{ nodeId: scratchSection }] = await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Insert section');
const sectionDef = (await home()).nodes[scratchSection].definitionId;
const [{ definitionId: proofDef }] = await apply([{ type: 'component.fork', definitionId: sectionDef }], 'Copy Section');
await apply(
  [
    { type: 'node.remove', owner, nodeId: scratchSection },
    { type: 'component.rename', definitionId: proofDef, name: 'Proof section' },
    { type: 'component.setSlot', definitionId: proofDef, slot: 'content', label: 'Proof', categories: ['social-proof'], max: 1 }
  ],
  'Make Proof section'
);
const [{ nodeId: first }, { nodeId: proof }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, definitionId: proofDef }
  ],
  'Insert sections'
);
const [{ nodeId: grid }] = await apply([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'grid' }], 'Insert grid');
const [{ nodeId: col1 }, { nodeId: col2 }] = await apply(
  [
    { type: 'node.insert', owner, parentId: grid, primitive: 'stack' },
    { type: 'node.insert', owner, parentId: grid, primitive: 'stack' }
  ],
  'Insert columns'
);
await apply(
  [
    { type: 'node.rename', owner, nodeId: grid, name: 'Columns' },
    { type: 'node.rename', owner, nodeId: col1, name: 'Column 1' },
    { type: 'node.rename', owner, nodeId: col2, name: 'Column 2' },
    { type: 'node.setStyle', owner, nodeId: grid, scope: 'desktop', property: 'columns', value: 2 }
  ],
  'Name columns'
);
assert.equal((await home()).nodes[first].definitionId, sectionDef, 'the columns sit in a plain Section');
const roots = (await home()).rootIds;
assert.deepEqual(roots, [first, proof]);
await inPage(col1).waitFor();
await inPage(proof).waitFor();

step('Insert lists the six blocks in a Blocks group, right after the column layouts');
await openInsert();
await blocksGroup.waitFor();
const groups = await panel.locator('.insert-group').evaluateAll((els) => els.map((g) => g.dataset.group ?? g.dataset.kind));
assert.equal(groups[groups.indexOf('columns') + 1], 'blocks', `the blocks follow the column layouts (${groups.join(', ')})`);
assert.equal(await blocksGroup.locator('.insert-head').innerText(), 'Blocks');
assert.deepEqual(
  await blocksGroup.locator('.insert-tile strong').allInnerTexts(),
  ['Feature card', 'Stat card', 'Testimonial card', 'Callout box', 'Signup form', 'Compact video'],
  'every block, in the theme’s order'
);

step('with Column 1 selected, the Feature card’s tile names the column, and its click puts the card there in one change');
await selectIn(inPage(col1), /Column 1/);
await openInsert();
await blockTile('Feature card').hover();
await eventually(async () => assert.match(await strip.getAttribute('title'), /^Feature card goes inside Column 1/, 'the strip names the column'));
let before = await newest();
await blockTile('Feature card').click();
await eventually(async () => {
  const page = await home();
  assert.equal(page.nodes[col1].children.length, 1, 'the column holds the card');
  assert.equal(page.nodes[page.nodes[col1].children[0]].definitionId, 'foundation.block.feature', 'a Feature card');
  assert.deepEqual(page.rootIds, roots, 'no new section on the page');
});
await oneChange(before, 'Insert Feature card on Home');
await frame.locator('h3', { hasText: 'Thoughtful planning' }).first().waitFor();
await win.screenshot({ path: join(SHOTS, 'blocks-column-click.png') });
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes[col1].children, [], 'one Undo takes it away'));
await eventually(async () => assert.equal((await newest())?.id, before?.id, 'and History is as it was'));

step('the + inside an empty column offers every block, in its own group');
await win.keyboard.press('Escape');
await openPlus(addButton('inside', col2), () => pointIn(inPage(col2), 0.5, 0.5));
/** What the list offers, by name, and the group each is listed under. */
const offered = () => list.getByRole('option').evaluateAll((els) => els.map((el) => ({ name: el.querySelector('.qi-name')?.textContent ?? '', group: el.dataset.group })));
for (const name of ['Feature card', 'Stat card', 'Testimonial card', 'Callout box', 'Signup form', 'Compact video'])
  assert.ok((await offered()).some((o) => o.name === name && o.group === 'Blocks'), `${name} is offered under Blocks`);
assert.equal(await list.getByRole('group', { name: 'Blocks' }).count(), 1, 'under a Blocks heading');
assert.equal((await offered()).some((o) => o.name.startsWith('Statistics')), false, 'sections are not offered inside a column');
await win.screenshot({ path: join(SHOTS, 'blocks-column-plus.png') });
await win.keyboard.press('Escape');
await list.waitFor({ state: 'detached' });

step('the Stat card’s tile drags into Column 2, in one change');
await openInsert();
before = await newest();
await dragTo(blockTile('Stat card'), inPage(col2), 0.5, 0.5);
await eventually(async () => assert.match(await dropLabel.innerText(), /Stat card .*Column 2/, 'the label names the column'));
await win.screenshot({ path: join(SHOTS, 'blocks-column-drag.png') });
await win.mouse.up();
await eventually(async () => {
  const page = await home();
  assert.equal(page.nodes[col2].children.length, 1, 'the column holds the card');
  assert.equal(page.nodes[page.nodes[col2].children[0]].definitionId, 'foundation.block.stat', 'a Stat card');
  assert.deepEqual(page.rootIds, roots, 'no new section on the page');
});
await oneChange(before, 'Insert Stat card on Home');
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes[col2].children, [], 'one Undo takes it away'));
await eventually(async () => assert.equal((await newest())?.id, before?.id, 'and History is as it was'));

step('the + inside the Proof section offers only the blocks its slot takes');
await win.keyboard.press('Escape');
await openPlus(addButton('inside', proof), () => pointIn(inPage(proof), 0.5, 0.5));
const proofBlocks = (await offered()).filter((o) => o.group === 'Blocks').map((o) => o.name);
assert.deepEqual(proofBlocks, ['Stat card', 'Testimonial card'], 'social proof only');
await win.screenshot({ path: join(SHOTS, 'blocks-slot-plus.png') });
before = await newest();
await list.getByRole('option', { name: /^Stat card/ }).click();
await list.waitFor({ state: 'detached' });
await eventually(async () => {
  const page = await home();
  const held = page.nodes[proof].slots?.content ?? [];
  assert.equal(held.length, 1, 'the slot holds the chosen card');
  assert.equal(page.nodes[held[0]].definitionId, 'foundation.block.stat', 'a Stat card');
  assert.deepEqual(page.rootIds, roots, 'no new section on the page');
});
await oneChange(before, 'Insert Stat card on Home');
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes[proof].slots?.content ?? [], [], 'one Undo takes it away'));
await eventually(async () => assert.equal((await newest())?.id, before?.id, 'and History is as it was'));

step('the Testimonial card’s tile drags into the Proof section’s slot, in one change');
await openInsert();
before = await newest();
await dragTo(blockTile('Testimonial card'), inPage(proof), 0.5, 0.5);
await eventually(async () => assert.match(await dropLabel.innerText(), /Testimonial card .*Proof section/, 'the label names the section'));
await win.mouse.up();
await eventually(async () => {
  const page = await home();
  const held = page.nodes[proof].slots?.content ?? [];
  assert.equal(held.length, 1, 'the slot holds the card');
  assert.equal(page.nodes[held[0]].definitionId, 'foundation.block.testimonial', 'a Testimonial card');
  assert.deepEqual(page.rootIds, roots, 'no new section on the page');
});
await oneChange(before, 'Insert Testimonial card on Home');
await frame.locator('cite', { hasText: 'Amelia Hart' }).first().waitFor();
await win.screenshot({ path: join(SHOTS, 'blocks-slot-drag.png') });

step('the full slot takes no second block: a click on its tile with the slot’s card selected says so, and adds nothing');
const held = (await home()).nodes[proof].slots.content[0];
// The drop selected the card it put there.
await eventually(async () => assert.equal(JSON.parse((await win.locator('.canvas').getAttribute('data-selected-ref')) ?? 'null')?.nodeId, held, 'the dropped card is selected'));
await openInsert();
await eventually(async () => assert.equal(await blockTile('Stat card').getAttribute('data-refused'), '', 'the Stat card’s tile is marked refused'));
assert.match(await blockTile('Stat card').getAttribute('title'), /holds at most one item/);
const testimonialAdded = await newest();
await blockTile('Stat card').click();
await win.waitForTimeout(500);
assert.deepEqual((await home()).nodes[proof].slots.content, [held], 'nothing more in the slot');
assert.equal((await newest()).id, testimonialAdded?.id, 'and no change');
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes[proof].slots?.content ?? [], [], 'one Undo takes the testimonial away'));
await eventually(async () => assert.equal((await newest())?.id, before?.id, 'and History is as it was'));

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nblocks: all checks passed');
