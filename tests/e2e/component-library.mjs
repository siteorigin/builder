// The component library in Insert > Your components, against the real app (#56): Make unique asks for a name and
// never stacks "(unique)", each tile says how often it is used, and its menu renames it, lists and shows where it
// is placed, and deletes it once unused, with Undo bringing it back.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('component-library');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Expo Hall', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
/** Project components by name, each with how many times it is placed. */
const library = async () => {
  const st = await snapshot();
  const uses = {};
  const trees = [st.site.shell.header, st.site.shell.footer, ...Object.values(st.pages), ...Object.values(st.components).map((d) => d.tree).filter(Boolean)];
  for (const t of trees) for (const n of Object.values(t.nodes)) if (n.kind === 'instance') uses[n.definitionId] = (uses[n.definitionId] ?? 0) + 1;
  return Object.fromEntries(Object.values(st.components).filter((d) => d.owner === 'project').map((d) => [d.name, uses[d.id] ?? 0]));
};
const panel = win.locator('.side-panel-view:not([hidden])');
const tile = (name) => panel.locator('.insert-tile.project', { has: win.locator('strong', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) });
const manage = (name) => panel.getByRole('button', { name: `Manage ${name}`, exact: true });
const menu = win.getByRole('menu');
const dialog = win.getByRole('dialog');
const openInsert = async () => {
  const group = panel.locator('.insert-group[data-kind="component"]');
  // The rail button toggles the panel, so it is pressed only while Insert is closed.
  if (!(await group.isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await group.waitFor();
};
const componentSection = async () => {
  const head = win.locator('#dock-panel-inspect .section-head', { hasText: 'Component' });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
};

step('an Exhibitor card made from a group, and a second copy from Insert');
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const section = (await snapshot()).pages[pageId].rootIds[0];
const [{ nodeId: stack }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }], 'Insert stack');
await apply([{ type: 'node.insert', owner, parentId: stack, primitive: 'heading', text: 'Exhibitor' }], 'Insert heading');
const [{ nodeId: first }] = await apply([{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Exhibitor card' }], 'Create component');
await openInsert();
await eventually(async () => assert.match(await tile('Exhibitor card').innerText(), /Used once/, 'the tile says how often the card is used'));
await tile('Exhibitor card').click();
await eventually(async () => assert.deepEqual(await library(), { 'Exhibitor card': 2 }, 'clicking the tile still inserts a copy'));
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Exhibitor card' }).waitFor();

step('Make unique asks for a name: Cancel changes nothing, a chosen name is kept');
await componentSection();
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Make unique…' }).click();
const nameField = dialog.getByLabel('Name for the copy');
assert.equal(await nameField.inputValue(), 'Exhibitor card (unique)', 'the dialog suggests a name');
assert.equal(await nameField.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), 'Exhibitor card (unique)', 'the suggestion is selected, so typing replaces it');
await dialog.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'detached' });
assert.deepEqual(await library(), { 'Exhibitor card': 2 }, 'Cancel makes no copy');
await win.getByRole('button', { name: 'More actions for Exhibitor card' }).click();
await menu.getByRole('menuitem', { name: /Make unique…/ }).click();
await nameField.fill('Exhibitor card blue');
await nameField.press('Enter');
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.deepEqual(await library(), { 'Exhibitor card': 1, 'Exhibitor card blue': 1 }, 'the copy takes the chosen name'));

step('accepting suggestions twice never stacks "(unique)"');
for (const expected of ['Exhibitor card blue (unique)', 'Exhibitor card blue (unique 2)']) {
  await componentSection();
  await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Make unique…' }).click();
  assert.equal(await nameField.inputValue(), expected, 'the suggestion is numbered rather than stacked');
  await dialog.getByRole('button', { name: 'Make unique' }).click();
  await dialog.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal((await library())[expected], 1, `${expected} is made`));
}
assert.deepEqual(await library(), { 'Exhibitor card': 1, 'Exhibitor card blue': 0, 'Exhibitor card blue (unique)': 0, 'Exhibitor card blue (unique 2)': 1 });

step('each tile says how often it is used, and its menu is one arrow key away');
await openInsert();
await eventually(async () => assert.match(await tile('Exhibitor card blue').innerText(), /Not used/, 'an unused variant says so'));
assert.match(await tile('Exhibitor card blue (unique 2)').innerText(), /Used once/);
await tile('Exhibitor card blue').focus();
await win.keyboard.press('ArrowRight');
await eventually(async () => assert.equal(await manage('Exhibitor card blue').evaluate((el) => el === document.activeElement), true, 'ArrowRight moves from the tile to its menu button'));
await win.keyboard.press('Enter');
await menu.waitFor();
assert.ok(await menu.getByText('Not used anywhere').isVisible(), 'the menu says the variant is not used');
assert.equal(await menu.getByRole('menuitem', { name: /Delete component/ }).getAttribute('aria-disabled'), null, 'an unused variant can be deleted');
await win.keyboard.press('Escape');
await menu.waitFor({ state: 'detached' });

step('usage locations show where a component is placed, and a used one cannot be deleted');
await manage('Exhibitor card').click();
await menu.waitFor();
assert.ok(await menu.getByText('Used once').isVisible(), 'the menu counts the placements');
await win.waitForTimeout(300);
await win.screenshot({ path: join(SHOTS, 'component-library-menu.png'), clip: { x: 0, y: 180, width: 420, height: 300 } });
assert.equal(await menu.getByRole('menuitem', { name: /Delete component/ }).getAttribute('aria-disabled'), 'true', 'a used component cannot be deleted');
const homeTitle = (await snapshot()).pages[pageId].title;
await menu.getByRole('menuitem', { name: homeTitle }).click();
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${first}"]`).getAttribute('aria-selected'), 'true', 'choosing the page selects that placement'));

step('Rename gives a variant a descriptive name and a description');
await openInsert();
await manage('Exhibitor card blue (unique 2)').click();
await menu.getByRole('menuitem', { name: 'Rename…' }).click();
const renameField = dialog.getByLabel('Component name');
assert.equal(await renameField.inputValue(), 'Exhibitor card blue (unique 2)');
await renameField.fill('Exhibitor card gold sponsor');
await dialog.getByLabel('Description').fill('For gold sponsors on the floor plan');
await dialog.getByRole('button', { name: 'Rename' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await library())['Exhibitor card gold sponsor'], 1, 'the placement keeps the renamed component'));
const gold = Object.values((await snapshot()).components).find((d) => d.name === 'Exhibitor card gold sponsor');
assert.equal(gold.description, 'For gold sponsors on the floor plan');
await tile('Exhibitor card gold sponsor').waitFor();

step('deleting an unused variant keeps the others, and Undo brings it back');
const before = (await snapshot()).pages[pageId];
await manage('Exhibitor card blue').click();
await menu.getByRole('menuitem', { name: /Delete component/ }).click();
await eventually(async () => assert.deepEqual(await library(), { 'Exhibitor card': 1, 'Exhibitor card blue (unique)': 0, 'Exhibitor card gold sponsor': 1 }, 'only the deleted variant goes'));
await tile('Exhibitor card blue').waitFor({ state: 'detached' });
assert.deepEqual((await snapshot()).pages[pageId], before, 'the page and its placements are untouched');
await win.locator('.toast', { hasText: 'Deleted Exhibitor card blue' }).getByRole('button', { name: 'Undo' }).click();
await eventually(async () => assert.equal((await library())['Exhibitor card blue'], 0, 'Undo restores the deleted variant'));
await tile('Exhibitor card blue').waitFor();

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncomponent-library: passed');
