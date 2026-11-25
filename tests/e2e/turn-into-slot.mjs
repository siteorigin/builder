// Turn into slot… (#659), against the real app. A two-column Row on Home becomes a Split component, placed twice with
// different opening hours. In Component Studio the Inspector turns its Side column into a slot, moving each
// placement's column into its own slot, as one change that one Undo takes back. Layers then turns it into an empty
// slot instead, and offers it no more, saying why. Back on the page, each Split shows the empty slot at once, and a
// Paragraph dragged from Insert onto one lands in that placement's slot alone.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, MOD, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('turn-into-slot');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Bakery', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
await openInspector(win);

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const history = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).map((e) => e.label));
const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    },
    [operations, label]
  );
/** Choose Edit → Undo, as a click on the menu item does (no window has focus while headless). */
const editMenu = (id) =>
  app.evaluate(
    ({ Menu }, { id }) => {
      const item = Menu.getApplicationMenu()
        .items.find((i) => i.label === 'Edit')
        ?.submenu?.items.find((i) => i.id === id);
      if (!item) throw new Error(`No ${id} item in the Edit menu`);
      item.click({ triggeredByAccelerator: false, metaKey: false, ctrlKey: false }, undefined, undefined);
    },
    { id }
  );
const inspector = win.locator('#dock-panel-inspect');
const menu = win.getByRole('menu');
const dialog = win.getByRole('dialog', { name: 'Turn into slot' });
const panel = win.locator('.side-panel-view:not([hidden])');
const band = win.locator('.mode-band');
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};

step('Home: a two-column Row made into a Split component, placed twice with different opening hours');
const pageId = (await snapshot()).site.homePageId;
const page = { kind: 'page', id: pageId };
const [section, split, main, side] = ['n_section01', 'n_split001', 'n_main0001', 'n_side0001'];
await apply(
  [
    { type: 'node.insert', owner: page, newNodeId: section, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner: page, newNodeId: split, parentId: section, slot: 'content', primitive: 'row' },
    { type: 'node.insert', owner: page, newNodeId: main, parentId: split, primitive: 'stack' },
    { type: 'node.insert', owner: page, newNodeId: side, parentId: split, primitive: 'stack' },
    { type: 'node.rename', owner: page, nodeId: main, name: 'Main column' },
    { type: 'node.rename', owner: page, nodeId: side, name: 'Side column' },
    { type: 'node.insert', owner: page, parentId: main, primitive: 'heading', text: 'Welcome' },
    { type: 'node.insert', owner: page, parentId: main, primitive: 'paragraph', text: 'Fresh bread daily' },
    { type: 'node.insert', owner: page, parentId: side, primitive: 'heading', text: 'Opening hours' },
    { type: 'node.insert', owner: page, parentId: side, primitive: 'paragraph', text: 'Mon to Fri, 8 to 6' }
  ],
  'Build the split'
);
const [{ definitionId: defId, nodeId: first }] = await apply([{ type: 'component.createFromNode', owner: page, nodeId: split, name: 'Split' }], 'Create Split');
const made = (await snapshot()).components[defId];
const column = Object.values(made.tree.nodes).find((n) => n.name === 'Side column').id;
const [hoursProp, daysProp] = made.tree.nodes[column].children.map((id) => made.tree.nodes[id].text.$prop);
const [{ nodeId: second }] = await apply(
  [{ type: 'node.insert', owner: page, parentId: section, slot: 'content', definitionId: defId, props: { [hoursProp]: 'Weekend hours', [daysProp]: 'Sat, 9 to 1' } }],
  'Place a second Split'
);
await eventually(async () => assert.equal(await frame.getByText('Weekend hours', { exact: true }).count(), 1, 'the second Split shows its own hours'), 30000);
const design = async () => JSON.stringify((await snapshot()).components[defId]);
const pageDoc = async () => JSON.stringify((await snapshot()).pages[pageId]);
const staticDesign = await design();
const staticPage = await pageDoc();

step('Component Studio opens Split');
const inStudio = (sel) => frame.locator(`[data-so-ctx="preview:${defId}|preview"]${sel}`);
await win.locator('.canvas').focus();
await win.keyboard.press(`${MOD}+K`);
await win.locator('.cmdk').waitFor();
await win.keyboard.type('Split studio');
await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
await band.filter({ hasText: 'Split in Component Studio' }).waitFor();
await inStudio(`[data-so-node="${made.tree.rootIds[0]}"]`).first().waitFor({ timeout: 60000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await openRail('Layers');
const row = (nodeId) => win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="${nodeId}"]`);
const selectRow = async (nodeId) => {
  if (await row(nodeId).isVisible()) await row(nodeId).click();
  else await inStudio(` [data-so-node="${nodeId}"]`).first().dispatchEvent('click');
  await eventually(async () => assert.equal(await row(nodeId).getAttribute('aria-selected'), 'true', `the ${nodeId} row is selected`), 15000);
};

step('the Inspector turns the Side column into a slot, each placement keeping its own hours, in one change');
await selectRow(column);
await inspector.getByRole('button', { name: /^More actions for / }).click();
await menu.getByRole('menuitem', { name: 'Turn into slot…' }).click();
await dialog.waitFor();
assert.equal(await dialog.getByLabel('Slot name').inputValue(), 'Side column', 'the slot is named after the column');
assert.equal(await dialog.getByRole('radio', { name: 'Move it into each placement' }).isChecked(), true, 'moving the content is the choice');
assert.match(await dialog.innerText(), /Each of the 2 placements keeps what it shows here now/);
await win.screenshot({ path: join(SHOTS, 'turn-into-slot-dialog.png') });
const applied = (await history()).length;
await dialog.getByRole('button', { name: 'Turn into slot' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => {
  const st = await snapshot();
  const def = st.components[defId];
  assert.deepEqual(def.slots, { sideColumn: { label: 'Side column' } }, 'a slot that takes anything');
  const [outlet, ...rest] = def.tree.nodes[column].children;
  assert.deepEqual(rest, [], 'the column holds the slot alone');
  assert.deepEqual(def.tree.nodes[outlet], { id: outlet, kind: 'slot', slot: 'sideColumn' });
  const words = (id) => (st.pages[pageId].nodes[id].slots?.sideColumn ?? []).map((c) => st.pages[pageId].nodes[c].text);
  assert.deepEqual(words(first), ['Opening hours', 'Mon to Fri, 8 to 6'], 'the first Split keeps its hours');
  assert.deepEqual(words(second), ['Weekend hours', 'Sat, 9 to 1'], 'and the second its own');
});
assert.deepEqual((await history()).slice(applied), ['Turn Side column into a slot'], 'one change, named for History');
await eventually(async () => assert.equal(await row(column).getAttribute('aria-selected'), 'true', 'the column stays selected'));

step('one Undo puts the column’s content back in the design, and takes it off the page');
await editMenu('edit-undo');
await eventually(async () => assert.equal(await design(), staticDesign, 'the design is as it was'));
await eventually(async () => assert.equal(await pageDoc(), staticPage, 'and so is Home'));

step('Layers turns it into an empty slot instead, and then offers it no more, saying why');
await row(column).click({ button: 'right' });
await menu.getByRole('menuitem', { name: 'Turn into slot…' }).click();
await dialog.waitFor();
await dialog.getByRole('radio', { name: 'Leave the slot empty' }).check();
await dialog.getByRole('button', { name: 'Turn into slot' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => {
  const st = await snapshot();
  const def = st.components[defId];
  assert.deepEqual(
    def.tree.nodes[column].children.map((c) => def.tree.nodes[c].kind),
    ['slot'],
    'the column holds the slot alone'
  );
  assert.equal(st.pages[pageId].nodes[first].slots, undefined, 'the first Split’s slot is empty');
  assert.equal(st.pages[pageId].nodes[second].slots, undefined, 'and so is the second’s');
});
await row(column).click({ button: 'right' });
const unavailable = menu.getByRole('menuitem', { name: 'Turn into slot…' });
await unavailable.waitFor();
assert.equal(await unavailable.getAttribute('aria-disabled'), 'true', 'a column holding a slot can’t become one');
assert.match(await unavailable.innerText(), /already holds the “Side column” slot\. Pick a container that holds no slot\./, 'and the menu says why');
await win.keyboard.press('Escape');
await menu.waitFor({ state: 'detached' });
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });

step('on the page, both Splits show the empty slot at once, and a Paragraph dragged onto one lands in it alone');
const placeholder = (id) => frame.locator(`[data-so-ctx$="|${id}"] [data-so-slot-empty="sideColumn"]`);
await placeholder(first).first().waitFor({ timeout: 30000 });
await placeholder(second).first().waitFor();
await openRail('Insert');
await panel.locator('.insert-group[data-group="basics"]').waitFor();
const paragraphTile = panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: /^Paragraph$/ }) });
/** A point of an element in the page, in the window: the scaled preview's place on screen plus the element's in it. */
const pointIn = async (locator, fx, fy) => {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const f = await win.locator('.frame-box iframe').boundingBox();
  const r = await locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth };
  });
  const k = f.width / r.vw;
  return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + r.height * fy) * k };
};
await paragraphTile.scrollIntoViewIfNeeded();
const tile = await paragraphTile.boundingBox();
await win.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
await win.mouse.down();
await win.mouse.move(tile.x + tile.width / 2 + 12, tile.y + tile.height / 2 + 4, { steps: 3 });
const at = await pointIn(placeholder(first).first(), 0.5, 0.5);
await win.mouse.move(at.x, at.y, { steps: 12 });
await eventually(async () => assert.match(await win.locator('[data-testid="insert-drop-label"]').innerText(), /^Paragraph inside Split/, 'the drop names the placement it goes into'));
await win.screenshot({ path: join(SHOTS, 'turn-into-slot-drop.png') });
const beforeDrop = (await history()).length;
await win.mouse.up();
await eventually(async () => {
  const st = await snapshot();
  const held = st.pages[pageId].nodes[first].slots?.sideColumn ?? [];
  assert.equal(held.length, 1, 'the first Split’s slot holds the paragraph');
  assert.equal(st.pages[pageId].nodes[held[0]].kind, 'text', 'a paragraph');
  assert.equal(st.pages[pageId].nodes[second].slots, undefined, 'the second Split’s slot stays empty');
});
assert.equal((await history()).length, beforeDrop + 1, 'in one change');
await eventually(async () => assert.equal(await placeholder(first).count(), 0, 'the filled slot shows its content, not the placeholder'), 20000);
assert.equal(await placeholder(second).count(), 1, 'the empty one still shows it');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nturn-into-slot: passed');
