// Visibility rules on a component's design (#368): Show when, Hide when and "hide when empty" set from the
// Inspector in Edit everywhere, marked in Layers, followed by the preview as values change, and undone and redone.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('conditions');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Condition Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const inspector = win.locator('#dock-panel-inspect');
const initial = await win.evaluate(() => window.builder.project.snapshot());
const homeId = initial.state.site.homePageId;
const fixture = await win.evaluate(async (pageId) => {
  const made = await window.builder.project.apply({ operations: [{ type: 'component.upsert', name: 'Services grid fixture',
    properties: {
      eyebrow: { type: 'string', label: 'Eyebrow', default: 'What we do' },
      items: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: {
        title: { type: 'string', label: 'Title', default: 'Service' },
        description: { type: 'string', label: 'Description', default: 'A service' }
      }, default: [
        { id: 'planning', title: 'Planning & layout', description: 'Plan the space' },
        { id: 'materials', title: 'Materials & color', description: 'Choose materials' },
        { id: 'delivery', title: 'Project delivery', description: 'Bring it home' }
      ] }
    },
    nodes: [
      { kind: 'element', id: 'root', tag: 'section', children: ['cards'] },
      { kind: 'repeat', id: 'cards', list: 'items', children: ['card'] },
      { kind: 'element', id: 'card', tag: 'article', children: ['card-icon-wrap', 'card-title', 'card-text'] },
      { kind: 'element', id: 'card-icon-wrap', tag: 'div', children: ['card-icon'] },
      { kind: 'text', id: 'card-icon', tag: 'span', text: '★' },
      { kind: 'text', id: 'card-title', tag: 'h3', text: { $item: 'title' } },
      { kind: 'text', id: 'card-text', tag: 'p', text: { $item: 'description' } }
    ]
  }], label: 'Make conditions fixture' });
  if (!made.ok) throw new Error(made.error?.message);
  const definitionId = made.results[0].definitionId;
  const placed = await window.builder.project.apply({ operations: [
    { type: 'node.insert', owner: { kind: 'page', id: pageId }, parentId: null, definitionId },
  ], label: 'Place conditions fixture' });
  if (!placed.ok) throw new Error(placed.error?.message);
  const nodeId = placed.results[0].nodeId;
  const filled = await window.builder.project.apply({ operations: [
    { type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'eyebrow', value: 'Services' }
  ], label: 'Set fixture eyebrow' });
  if (!filled.ok) throw new Error(filled.error?.message);
  return { definitionId, nodeId };
}, homeId);

/** Choose Edit → Undo or Edit → Redo, as a click on the menu item does (no window has focus while headless). */
const menu = (id) =>
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

/** The Services grid placed on Home, the design it uses, and its cards. */
const grid = () =>
  win.evaluate(async (fixtureNodeId) => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = page.nodes[fixtureNodeId];
    const def = s.state.components[node.definitionId];
    return { pageId: page.id, nodeId: node.id, defId: def.id, owner: def.owner, nodes: def.tree.nodes, props: node.props, items: node.props.items ?? def.properties.items.default };
  }, fixture.nodeId);

step('open the Services grid design');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator(`[role="tree"] .list-item[data-node="${fixture.nodeId}"]`).click();
await openInspector(win);
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('button', { name: 'Edit design' }).click();
await win.locator('.mode-band').waitFor();
await eventually(async () => assert.equal((await grid()).owner, 'project', 'the placement now uses the project’s copy'));
const { pageId, nodeId: placedId, defId, items } = await grid();
const itemId = (title) => items.find((i) => i.title === title).id;
const [planning, materials, delivery] = ['Planning & layout', 'Materials & color', 'Project delivery'].map(itemId);
const everyCard = [planning, materials, delivery].sort();

/** The cards (by item ID) for which the preview shows a node of the copied design, read in one go. */
const shownFor = (nodeId) =>
  frame
    .locator(`[data-so-ctx$="|${placedId}"][class*="so-proj-"] [data-so-node="${nodeId}"][class*="so-proj-"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-so-items')).sort());
/** The Layers row of a node of the copied design. */
const row = (nodeId) => win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="${nodeId}"]`);
const selectRow = async (nodeId) => {
  await row(nodeId).click();
  await eventually(async () => assert.equal(await row(nodeId).getAttribute('aria-selected'), 'true', `the ${nodeId} row is selected`));
};
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), everyCard, 'every card shows its icon'));

step('show the icon only on one card');
// The canvas picks what a click lands on, so the click is sent to the icon itself (the page scrolls outside the frame).
const icon = frame.locator(`[data-so-ctx$="|${placedId}"] [data-so-node="card-icon"][class*="so-proj-"]`).first();
await icon.waitFor();
await icon.dispatchEvent('click');
await eventually(async () => assert.equal(await row('card-icon').getAttribute('aria-selected'), 'true', 'Layers selects the icon of the design'));
const showWhen = inspector.getByLabel('Show when…', { exact: true });
const hideWhen = inspector.getByLabel('Hide when…', { exact: true });
const conditions = inspector.locator('.section-head', { hasText: 'Conditions' });
if ((await conditions.getAttribute('aria-expanded')) === 'false') await conditions.click();
assert.equal(await showWhen.inputValue(), '', 'the icon starts with no rule');
await showWhen.selectOption('item:title');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-icon'].when, { $item: 'title' }, 'a presence rule on the card’s title is saved'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), everyCard, 'every card has a title, so every icon stays'));
await inspector.getByLabel('Show when test').selectOption('eq');
await eventually(async () => assert.equal((await grid()).nodes['card-icon'].when?.eq, 'Service', 'comparing starts from the field’s default'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), [], 'no card is titled Service'));
const showValue = inspector.getByLabel('Show when value');
await showValue.fill('Materials & color');
await showValue.press('Enter');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-icon'].when, { ref: { $item: 'title' }, eq: 'Materials & color' }, 'the typed value is saved'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), [materials], 'only the Materials & color card shows its icon'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), everyCard, 'the other cards keep an empty icon badge'));
await eventually(async () => assert.match((await row('card-icon').locator('.layer-cond').getAttribute('title')) ?? '', /Show when Card title is “Materials & color”/, 'Layers marks the icon with its rule'));
assert.match((await row('card-icon').getAttribute('aria-description')) ?? '', /Show when Card title is “Materials & color”/, 'and the row says it to assistive technology');

step('hide the empty badges, and show them again');
await selectRow('card-icon-wrap');
const collapse = inspector.getByRole('switch', { name: 'Hide container when all items inside are hidden' });
assert.equal(await collapse.getAttribute('aria-checked'), 'false');
assert.equal(await row('card-icon-wrap').locator('.layer-cond').count(), 0, 'the badge has no rule yet');
await collapse.click();
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, true, 'hide when empty is saved'));
await eventually(async () => assert.equal(await collapse.getAttribute('aria-checked'), 'true'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), [materials], 'only the badge with an icon is left'));
await eventually(async () => assert.equal(await row('card-icon-wrap').locator('.layer-cond').count(), 1, 'Layers marks the badge too'));
await win.screenshot({ path: join(OUT, 'conditions-1-set.png') });
await collapse.click();
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, undefined, 'turning it off removes the flag'));
await eventually(async () => assert.equal(await collapse.getAttribute('aria-checked'), 'false'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), everyCard, 'the empty badges are back'));
await eventually(async () => assert.equal(await row('card-icon-wrap').locator('.layer-cond').count(), 0, 'and no longer marked'));
await collapse.click();
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), [materials]));

step('undo and redo');
await menu('edit-undo');
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, undefined, 'undo turns hide when empty off'));
await eventually(async () => assert.equal(await collapse.getAttribute('aria-checked'), 'false'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), everyCard, 'the empty badges are back'));
await menu('edit-redo');
await eventually(async () => assert.equal((await grid()).nodes['card-icon-wrap'].collapseEmpty, true, 'redo turns it on again'));
await eventually(async () => assert.equal(await collapse.getAttribute('aria-checked'), 'true'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), [materials], 'and leaves the empty badges out again'));

step('hide the descriptions by a property, then only when it differs');
const { props } = await grid();
assert.equal(props.eyebrow, 'Services', 'the placement’s eyebrow');
await selectRow('card-text');
await hideWhen.selectOption('prop:eyebrow');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-text'].unless, { $prop: 'eyebrow' }, 'a hide rule on the eyebrow is saved'));
await eventually(async () => assert.deepEqual(await shownFor('card-text'), [], 'the eyebrow has a value, so every description is hidden'));
await inspector.getByLabel('Hide when test').selectOption('eq');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-text'].unless, { ref: { $prop: 'eyebrow' }, eq: 'What we do' }, 'comparing starts from the property’s default'));
await eventually(async () => assert.deepEqual(await shownFor('card-text'), everyCard, 'the eyebrow differs, so every description shows'));
const hideValue = inspector.getByLabel('Hide when value');
await hideValue.fill('Services');
await hideValue.press('Enter');
// Chosen at once, before the typed value's save has come back: "is not" keeps what was typed.
await inspector.getByLabel('Hide when test').selectOption('ne');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-text'].unless, { ref: { $prop: 'eyebrow' }, ne: 'Services' }, 'is not keeps the typed value'));
await eventually(async () => assert.deepEqual(await shownFor('card-text'), everyCard, 'the eyebrow is Services, so the descriptions show'));
await eventually(async () => assert.equal(await inspector.getByLabel('Hide when value').inputValue(), 'Services'));
await eventually(async () => assert.match((await row('card-text').locator('.layer-cond').getAttribute('title')) ?? '', /Hide when Eyebrow is not “Services”/));

step('clear a rule, and undo that');
await selectRow('card-icon');
await eventually(async () => assert.equal(await showWhen.inputValue(), 'item:title'));
await showWhen.selectOption('');
await eventually(async () => assert.equal((await grid()).nodes['card-icon'].when, undefined, 'clearing removes the rule'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), everyCard, 'every card shows its icon again'));
await eventually(async () => assert.equal(await row('card-icon').locator('.layer-cond').count(), 0, 'Layers no longer marks the icon'));
assert.equal(await row('card-icon-wrap').locator('.layer-cond').count(), 1, 'the badge keeps its own rule');
await menu('edit-undo');
await eventually(async () => assert.deepEqual((await grid()).nodes['card-icon'].when, { ref: { $item: 'title' }, eq: 'Materials & color' }, 'undo restores the cleared rule'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), [materials], 'and the preview follows it'));
await eventually(async () => assert.equal(await showWhen.inputValue(), 'item:title', 'the Inspector shows the restored rule'));

// Last: once a page edit has been undone, the canvas misses the next undo of a design change (on develop too), so
// the design's own undo and redo are covered above, and only the page's edits are undone here.
step('the preview follows a placement’s values');
const apply = (op) => win.evaluate((op) => window.builder.project.apply({ operations: [op] }, { label: 'Edit placement' }), op);
const setProp = (prop, value, extra = {}) => apply({ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: placedId, prop, value, ...extra });
assert.equal((await setProp('items', 'Craft', { itemId: materials, field: 'title' })).ok, true, 'the card is renamed');
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), [], 'no card has that title now: no icon'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), [], 'and no empty badge'));
assert.equal((await setProp('eyebrow', 'Our services')).ok, true, 'the eyebrow changes');
await eventually(async () => assert.deepEqual(await shownFor('card-text'), [], 'the eyebrow is not Services: the descriptions hide'));

step('a layer the preview shows nowhere stays selectable, with its rule');
await selectRow('card-title');
await selectRow('card-icon');
await eventually(async () => assert.equal(await showWhen.inputValue(), 'item:title', 'the icon’s rule is shown'));
assert.equal(await inspector.getByLabel('Show when test').inputValue(), 'eq');
assert.equal(await inspector.getByLabel('Show when value').inputValue(), 'Materials & color');

await menu('edit-undo');
await eventually(async () => assert.deepEqual(await shownFor('card-text'), everyCard, 'undo brings the eyebrow back, and the descriptions'));
await menu('edit-undo');
await eventually(async () => assert.deepEqual(await shownFor('card-icon'), [materials], 'undo brings the title back, with its icon'));
await eventually(async () => assert.deepEqual(await shownFor('card-icon-wrap'), [materials]));

await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });
await win.locator('[role="tree"] [data-owner^="page:"]').first().waitFor();
await eventually(async () => assert.equal(await win.locator('[role="tree"] .layer-cond').count(), 0, 'outside the design, Layers marks no rules'));

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nconditions: passed');
