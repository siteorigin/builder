// Repeat as list… (#369), against the real app: a component's static card (icon, heading, text and button) is offered
// Repeat as list from the inspector and the canvas (cancelled there) and from Layers, where it becomes a list of three
// cards in every placement as one change, which one Undo takes back and Redo makes again. Back on the page, one
// placement edits its second card without touching the other placement.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('repeat-as-list');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Repeat Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
const inspector = win.locator('#dock-panel-inspect');
const menu = win.getByRole('menu');
const dialog = win.getByRole('dialog', { name: 'Repeat as list' });

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
/** Choose Edit → Undo or Edit → Redo, as a click on the menu item does (no window has focus while headless). */
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

step('a Feature cards component whose grid holds one static card, placed twice on Home');
const pageId = (await snapshot()).site.homePageId;
const [{ definitionId: defId, rootNodeId: root }] = await apply([{ type: 'component.create', name: 'Feature cards' }], 'Create Feature cards');
const design = { kind: 'component', id: defId };
const [grid, card, icon, title, body, button] = ['n_grid0001', 'n_card0001', 'n_icon0001', 'n_title001', 'n_body0001', 'n_button01'];
await apply(
  [
    { type: 'node.insert', owner: design, newNodeId: grid, parentId: root, primitive: 'grid' },
    { type: 'node.insert', owner: design, newNodeId: card, parentId: grid, primitive: 'container' },
    { type: 'node.rename', owner: design, nodeId: card, name: 'Card' },
    { type: 'node.insert', owner: design, newNodeId: icon, parentId: card, primitive: 'icon' },
    { type: 'node.insert', owner: design, newNodeId: title, parentId: card, primitive: 'heading', text: 'Fast setup' },
    { type: 'node.insert', owner: design, newNodeId: body, parentId: card, primitive: 'paragraph', text: 'Up and running in minutes.' },
    { type: 'node.insert', owner: design, newNodeId: button, parentId: card, primitive: 'button', text: 'Read more' },
    { type: 'node.setContent', owner: design, nodeId: button, field: 'link', value: { type: 'url', target: 'https://example.com/learn' } },
    { type: 'node.insert', owner: { kind: 'page', id: pageId }, definitionId: defId },
    { type: 'node.insert', owner: { kind: 'page', id: pageId }, definitionId: defId }
  ],
  'Build Feature cards'
);
const placements = async () => {
  const st = await snapshot();
  return st.pages[pageId].rootIds.filter((id) => st.pages[pageId].nodes[id].definitionId === defId);
};
const [first, second] = await placements();
/** How many cards the page shows in each placement, read from the preview. */
const cardsShown = () => Promise.all([first, second].map((id) => frame.locator(`[data-so-ctx$="|${id}"] [data-so-node="${card}"]`).count()));
await eventually(async () => assert.deepEqual(await cardsShown(), [1, 1], 'each placement shows its one card'), 30000);
const definition = async () => JSON.stringify((await snapshot()).components[defId]);
const pageDoc = async () => JSON.stringify((await snapshot()).pages[pageId]);
const staticDesign = await definition();
const staticPage = await pageDoc();

step('Edit everywhere opens the design');
if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
await win.locator(`.layers-tree [data-node="${first}"]`).click();
const componentSection = inspector.locator('.section-head', { hasText: 'Component' });
await componentSection.waitFor();
if ((await componentSection.getAttribute('aria-expanded')) === 'false') await componentSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('dialog').getByRole('button', { name: /^Edit (everywhere|design)$/ }).click();
await win.locator('.mode-band').waitFor();
const row = (nodeId) => win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="${nodeId}"]`);
await row(card).waitFor();
await row(card).click();
await eventually(async () => assert.equal(await row(card).getAttribute('aria-selected'), 'true', 'the card of the design is selected'));

step('the inspector’s menu offers Repeat as list…, and Cancel changes nothing');
await inspector.getByRole('button', { name: /^More actions for / }).click();
await menu.getByRole('menuitem', { name: 'Repeat as list…' }).click();
await dialog.waitFor();
assert.equal(await dialog.getByLabel('List name').inputValue(), 'Cards', 'the list is named after the card');
const details = await dialog.locator('.authoring-details').innerText();
assert.match(details, /Each item has its own icon, title, description, button label and button link\./, `the dialog says what each item holds: ${details}`);
assert.match(details, /Every placement starts with 3 items, each a copy of this one\./);
await dialog.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'detached' });
assert.equal(await definition(), staticDesign, 'Cancel leaves the design as it was');

step('the canvas offers it too, from the card’s chip');
await win.locator('.ov-chip').getByRole('button', { name: 'More actions' }).click();
await menu.getByRole('menuitem', { name: 'Repeat as list…' }).click();
await dialog.waitFor();
await dialog.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'detached' });
// Not offered on the design's root, which is the component itself.
await row(root).click({ button: 'right' });
await menu.waitFor();
assert.equal(await menu.getByRole('menuitem', { name: 'Repeat as list…' }).count(), 0, 'the root is not repeated as a list');
await win.keyboard.press('Escape');
await menu.waitFor({ state: 'detached' });

step('Layers repeats the card as a list, as one change');
const applied = (await history()).length;
await row(card).click({ button: 'right' });
await menu.getByRole('menuitem', { name: 'Repeat as list…' }).click();
await dialog.waitFor();
await dialog.getByLabel('List name').fill('Features');
await dialog.getByRole('button', { name: 'Repeat as list' }).click();
await dialog.waitFor({ state: 'detached' });
let repeatId;
await eventually(async () => {
  const def = (await snapshot()).components[defId];
  const list = def.properties.features;
  assert.equal(list?.type, 'list', 'a Features list property');
  assert.deepEqual(Object.keys(list.fields), ['icon', 'title', 'description', 'label', 'link']);
  assert.equal(list.default.length, 3);
  repeatId = def.tree.nodes[grid].children[0];
  assert.deepEqual(def.tree.nodes[repeatId], { ...def.tree.nodes[repeatId], kind: 'repeat', list: { $prop: 'features' }, children: [card] }, 'the card is the one child of a repeat where it was');
  assert.deepEqual(def.tree.nodes[title].text, { $item: 'title' });
  assert.deepEqual(def.tree.nodes[button].label, { $item: 'label' });
  assert.deepEqual(def.tree.nodes[button].link, { $item: 'link' });
});
assert.deepEqual((await history()).slice(applied), ['Repeat Card as a list'], 'one change, named for History');
await eventually(async () => assert.deepEqual(await cardsShown(), [3, 3], 'every placement shows three cards at once'), 20000);
await eventually(async () => assert.equal(await row(card).getAttribute('aria-selected'), 'true', 'the card stays selected'));
await win.screenshot({ path: join(SHOTS, 'repeat-as-list.png') });
const repeatedDesign = await definition();
const repeatedPage = await pageDoc();
{
  const st = await snapshot();
  const ids = [first, second].flatMap((id) => st.pages[pageId].nodes[id].props.features.map((it) => it.id));
  assert.equal(new Set(ids).size, 6, 'each placement has its own items, under IDs of their own');
}

step('one Undo puts the single static card back, and Redo repeats it again');
await editMenu('edit-undo');
await eventually(async () => assert.equal(await definition(), staticDesign, 'one Undo restores the design'));
await eventually(async () => assert.equal(await pageDoc(), staticPage, 'and the placements'));
await eventually(async () => assert.deepEqual(await cardsShown(), [1, 1], 'each placement shows its one card again'), 20000);
await editMenu('edit-redo');
await eventually(async () => assert.equal(await definition(), repeatedDesign, 'Redo repeats it again'));
await eventually(async () => assert.equal(await pageDoc(), repeatedPage));
await eventually(async () => assert.deepEqual(await cardsShown(), [3, 3]), 20000);

step('back on the page, one placement edits its second card alone');
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });
await win.locator(`.layers-tree [data-node="${first}"]`).click();
const list = inspector.locator('[data-list="features"]');
await list.waitFor();
const heads = list.locator('.list-editor-head button.title');
await eventually(async () => assert.equal(await heads.count(), 3, 'the placement lists its three cards'));
await heads.nth(1).click();
const field = list.locator('.list-editor-item').nth(1).getByLabel('Title', { exact: true });
await field.fill('Friendly support');
await field.press('Tab');
const titles = async (id) => (await snapshot()).pages[pageId].nodes[id].props.features.map((it) => it.title);
await eventually(async () => assert.deepEqual(await titles(first), ['Fast setup', 'Friendly support', 'Fast setup'], 'the second card of this placement changed'));
assert.deepEqual(await titles(second), ['Fast setup', 'Fast setup', 'Fast setup'], 'the other placement keeps its own cards');
await eventually(async () => assert.equal(await frame.locator(`[data-so-ctx$="|${first}"]`).getByText('Friendly support', { exact: true }).count(), 1, 'the page shows the edit'), 20000);
assert.equal(await frame.locator(`[data-so-ctx$="|${second}"]`).getByText('Friendly support', { exact: true }).count(), 0, 'and only in that placement');
await win.screenshot({ path: join(SHOTS, 'repeat-as-list-edited.png') });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nrepeat-as-list: passed');
