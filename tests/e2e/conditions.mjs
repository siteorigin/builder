// Visibility rules on a component's design (#368): Show when, Hide when and "hide when empty" set from the
// Inspector in Edit everywhere, marked in Layers, followed by the preview as values change, and undone and redone.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('conditions');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Condition Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const mac = process.platform === 'darwin';
const inspector = win.locator('#dock-panel-inspect');
const row = (nodeId) => win.locator(`[role="tree"] [data-node="${nodeId}"]`);

/** Choose Edit → Undo or Edit → Redo, as a click on the menu item does (no window has focus while headless). */
const menu = (id) =>
  app.evaluate(
    ({ Menu }, { id, mac }) => {
      const item = Menu.getApplicationMenu()
        .items.find((i) => i.label === 'Edit')
        ?.submenu?.items.find((i) => i.id === id);
      if (!item) throw new Error(`No ${id} item in the Edit menu`);
      item.click({ triggeredByAccelerator: false, metaKey: false, ctrlKey: false }, undefined, undefined);
    },
    { id, mac }
  );

/** The Services grid placed on Home, the design it uses, and its cards. */
const grid = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.name.startsWith('Services grid'));
    const def = s.state.components[node.definitionId];
    return { pageId: page.id, nodeId: node.id, defId: def.id, owner: def.owner, nodes: def.tree.nodes, items: node.props.items ?? def.properties.items.default };
  });
/** How many of a design node the preview of the grid shows. */
const shown = async (nodeId) => {
  const { nodeId: placed } = await grid();
  return frame.locator(`[data-so-ctx$="|${placed}"] [data-so-node="${nodeId}"]`).count();
};

step('open the Services grid design');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.mode-band').waitFor();
await eventually(async () => assert.equal((await grid()).owner, 'project', 'the placement now uses the project’s copy'));
await eventually(async () => assert.equal(await shown('card-icon'), 3, 'every card shows its icon'));

step('show the icon only on one card');
const { nodeId: placedId } = await grid();
// The preview is rebuilt for the copy: pick the icon once it shows the copy's markup. The canvas picks what a
// click lands on, so the click is sent to the icon itself (the page scrolls outside the frame).
const icon = frame.locator(`[data-so-ctx$="|${placedId}"] [data-so-node="card-icon"][class*="so-proj-"]`).first();
await icon.waitFor();
await icon.dispatchEvent('click');
await eventually(async () => assert.equal(await row('card-icon').getAttribute('aria-selected'), 'true', 'Layers selects the icon of the design'));
const showWhen = inspector.getByLabel('Show when…', { exact: true });
const conditions = inspector.locator('.section-head', { hasText: 'Conditions' });
if ((await conditions.getAttribute('aria-expanded')) === 'false') await conditions.click();
assert.equal(await showWhen.inputValue(), '', 'the icon starts with no rule');
await showWhen.selectOption('item:title');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-icon'].when, { $item: 'title' }, 'a presence rule on the card’s title is saved'));
await inspector.getByLabel('Show when test').selectOption('eq');
await eventually(async () => assert.equal((await grid()).nodes['card-icon'].when?.eq, 'Service', 'comparing starts from the field’s default'));
const value = inspector.getByLabel('Show when value');
await value.fill('Materials & colour');
await value.press('Enter');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-icon'].when, { ref: { $item: 'title' }, eq: 'Materials & colour' }, 'the typed value is saved'));
await eventually(async () => assert.equal(await shown('card-icon'), 1, 'only the Materials & colour card shows its icon'));
await eventually(async () => assert.equal(await shown('card-icon-wrap'), 3, 'the other cards keep an empty icon badge'));
await eventually(async () => assert.equal(await row('card-icon').locator('.layer-cond').count(), 1, 'Layers marks the icon as conditional'));
await eventually(async () => assert.match(await row('card-icon').locator('.layer-cond').getAttribute('title'), /Show when Card title is “Materials & colour”/, 'the mark says what the rule is'));

step('hide the empty badges');
await row('card-icon-wrap').click();
await eventually(async () => assert.equal(await row('card-icon-wrap').getAttribute('aria-selected'), 'true', 'the badge row is selected'));
const collapse = inspector.getByRole('switch', { name: 'Hide container when all items inside are hidden' });
await collapse.click();
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, true, 'hide when empty is saved'));
await eventually(async () => assert.equal(await shown('card-icon-wrap'), 1, 'only the badge with an icon is left'));
await eventually(async () => assert.equal(await row('card-icon-wrap').locator('.layer-cond').count(), 1, 'Layers marks the badge too'));
await win.screenshot({ path: join(OUT, 'conditions-1-set.png') });

step('a hidden layer stays selectable in Layers, with its rule');
await row('card-icon').click();
await eventually(async () => assert.equal(await showWhen.inputValue(), 'item:title', 'the icon’s rule is shown again'));
assert.equal(await inspector.getByLabel('Show when value').inputValue(), 'Materials & colour');

step('undo and redo');
await menu('edit-undo');
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, undefined, 'undo turns hide when empty off'));
await eventually(async () => assert.equal(await shown('card-icon-wrap'), 3, 'the empty badges are back'));
await menu('edit-redo');
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, true, 'redo turns it on again'));
await eventually(async () => assert.equal(await shown('card-icon-wrap'), 1, 'and leaves the empty badges out again'));

step('clear the rule');
await eventually(async () => assert.equal(await showWhen.inputValue(), 'item:title'));
await showWhen.selectOption('');
await eventually(async () => assert.equal((await grid()).nodes['card-icon'].when, undefined, 'clearing removes the rule'));
await eventually(async () => assert.equal(await shown('card-icon'), 3, 'every card shows its icon again'));
await eventually(async () => assert.equal(await row('card-icon').locator('.layer-cond').count(), 0, 'Layers no longer marks the icon'));
assert.equal(await row('card-icon-wrap').locator('.layer-cond').count(), 1, 'the badge keeps its own rule');
await menu('edit-undo');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-icon'].when, { ref: { $item: 'title' }, eq: 'Materials & colour' }, 'undo restores the cleared rule'));
await eventually(async () => assert.equal(await shown('card-icon'), 1, 'and the preview follows it'));
await eventually(async () => assert.equal(await showWhen.inputValue(), 'item:title', 'the Inspector shows the restored rule'));

// Last: once a page edit has been undone, the canvas misses the next undo of a design change (on develop too),
// so the design's own undo and redo are covered above.
step('the preview follows a placement’s values');
const { pageId, nodeId, items } = await grid();
const card = items.find((i) => i.title === 'Materials & colour');
const retitle = (title) =>
  win.evaluate(
    (op) => window.builder.project.apply({ operations: [op] }, { label: 'Rename card' }),
    { type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'items', itemId: card.id, field: 'title', value: title }
  );
assert.equal((await retitle('Craft')).ok, true, 'the card is renamed');
await eventually(async () => assert.equal(await shown('card-icon'), 0, 'no card has that title now: no icon'));
await eventually(async () => assert.equal(await shown('card-icon-wrap'), 0, 'and no empty badge'));
await menu('edit-undo');
await eventually(async () => assert.equal(await shown('card-icon'), 1, 'undo brings the title back, with its icon'));
await eventually(async () => assert.equal(await shown('card-icon-wrap'), 1));

await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });
assert.equal(await win.locator('[role="tree"] .layer-cond').count(), 0, 'outside the design, Layers marks no rules');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nconditions: passed');
