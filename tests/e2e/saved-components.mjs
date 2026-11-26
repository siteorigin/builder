// The personal component library across projects, against the real app (#372): a component saved to the library in
// one project shows under Insert > Saved across projects in another, and one click there imports and places it as one
// change that the strip's Undo takes back whole. Saved code shows only in Developer mode and always asks before it
// comes in. Components also travel as files, through the native save and open choosers (answered here, headless).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, answerChoosers, choosersShown, createProject, desktopCursor, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('saved-components');
const { app, win, errors } = await launch(WORK);
const library = join(WORK, 'userdata', 'saved-components');

const snapshot = () => win.evaluate(async () => await window.builder.project.snapshot());
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
/** Turn Developer mode on or off in Settings, as the author does, so the editor shows (or hides) code at once. */
const setDeveloperMode = async (on) => {
  await win.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = win.getByRole('dialog');
  const toggle = dialog.getByRole('switch', { name: 'Developer mode' });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await eventually(async () => assert.equal(await toggle.getAttribute('aria-checked'), String(on)));
  await eventually(async () => assert.equal((await win.evaluate(() => window.builder.app.getSettings())).developerMode, on));
  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
};
const panel = win.locator('.side-panel-view:not([hidden])');
const yours = panel.locator('.insert-group[data-kind="component"]');
const saved = panel.locator('.insert-group[data-kind="saved"]');
const savedTile = (name) => saved.locator('.insert-tile.saved', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const menu = win.getByRole('menu');
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const openInsert = async () => {
  if (!(await yours.isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await saved.waitFor();
};
/** Project components by name, each with how many times it is placed. */
const components = async () => {
  const st = (await snapshot()).state;
  const uses = {};
  const trees = [...Object.values(st.pages), ...Object.values(st.components).map((d) => d.tree).filter(Boolean)];
  for (const t of trees) for (const n of Object.values(t.nodes)) if (n.kind === 'instance') uses[n.definitionId] = (uses[n.definitionId] ?? 0) + 1;
  return Object.fromEntries(Object.values(st.components).filter((d) => d.owner === 'project').map((d) => [d.name, uses[d.id] ?? 0]));
};
const applied = async () => (await snapshot()).history.entries.filter((e) => e.applied).length;

step('Project A: a component saved to the personal library from Your components');
await createProject(win, { name: 'Studio A', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
const home = { kind: 'page', id: (await snapshot()).state.site.homePageId };
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }], 'Add section');
await apply([{ type: 'node.insert', owner: home, parentId: section, slot: 'content', primitive: 'heading', text: 'Every feature, one band' }], 'Add heading');
await apply([{ type: 'component.createFromNode', owner: home, nodeId: section, name: 'Feature band' }], 'Create component');
await setDeveloperMode(true);
await apply([{ type: 'component.createCode', name: 'Badge', source: '<span class="badge">New</span>\n' }], 'Create code component');
await openInsert();
await panel.getByRole('button', { name: 'Manage Feature band', exact: true }).click();
await menu.getByRole('menuitem', { name: /Save to personal library/ }).click();
await win.locator('.toast', { hasText: 'Saved Feature band in your library' }).waitFor();
await savedTile('Feature band').waitFor();

step('The placement’s menus in the Inspector, on the canvas and in Layers offer it too; saved again, it replaces its copy');
await openRail('Layers');
const row = (name) => win.locator('.list-item', { hasText: name }).first();
await row('Feature band').click();
await openInspector(win);
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Feature band' }).waitFor();
await win.locator('#dock-panel-inspect').getByRole('button', { name: /^More actions for / }).click();
await menu.getByRole('menuitem', { name: /Save to personal library/ }).waitFor();
await menu.getByRole('menuitem', { name: /Export component/ }).waitFor();
await win.keyboard.press('Escape');
await win.locator('.ov-chip').getByRole('button', { name: 'More actions' }).click();
await menu.getByRole('menuitem', { name: /Save to personal library/ }).waitFor();
await win.keyboard.press('Escape');
await row('Feature band').click({ button: 'right' });
await menu.getByRole('menuitem', { name: /Save to personal library/ }).click();
await win.locator('.toast', { hasText: 'Updated Feature band in your library' }).waitFor();
await openInsert();
await panel.getByRole('button', { name: 'Manage Badge', exact: true }).click();
await menu.getByRole('menuitem', { name: /Save to personal library/ }).click();
await savedTile('Badge').waitFor();
assert.equal(readdirSync(library).filter((f) => f.endsWith('.card.json')).length, 2, 'two components in the library');

step('Export component… writes a file through the native save chooser');
const file = join(WORK, 'Feature band.socomponent.json');
const before = await desktopCursor(app);
await answerChoosers(app, [{ dialog: 'save', path: file }]);
await panel.getByRole('button', { name: 'Manage Feature band', exact: true }).click();
await menu.getByRole('menuitem', { name: /Export component/ }).click();
await win.locator('.toast', { hasText: 'Exported Feature band.' }).waitFor();
assert.ok(existsSync(file), 'the package file is written where the chooser said');
assert.deepEqual((await choosersShown(app, before)).map((c) => [c.dialog, c.outcome]), [['save', 'chosen']]);
await setDeveloperMode(false);

step('Project B: the saved component is offered under Saved across projects, without the code one');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await createProject(win, { name: 'Studio B', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
await openInsert();
await savedTile('Feature band').waitFor();
assert.equal(await savedTile('Badge').count(), 0, 'saved code is hidden without Developer mode');
assert.match(await savedTile('Feature band').innerText(), /From Studio A/);
const search = win.getByRole('combobox', { name: 'Search items to add' });
const savedResults = () => panel.locator('.insert-result[data-kind="saved"]');
await search.fill('feature band');
await eventually(async () => assert.match((await savedResults().allInnerTexts()).join('|'), /Feature band/, 'a saved component is found by search'));
await search.fill('badge');
await eventually(async () => assert.equal(await savedResults().count(), 0, 'saved code is not found by search either'));
await search.fill('');
assert.deepEqual(await components(), {}, 'Studio B starts with no components of its own');

step('One click imports and places it, and the strip’s Undo takes both back');
const pageBefore = (await snapshot()).state.pages[(await snapshot()).state.site.homePageId];
const entries = await applied();
await savedTile('Feature band').click();
await eventually(async () => assert.deepEqual(await components(), { 'Feature band': 1 }, 'imported and placed once'));
await eventually(async () => assert.equal(await applied(), entries + 1, 'as one change'));
const st = (await snapshot()).state;
await win.locator('.insert-where-done', { hasText: 'Added Feature band' }).waitFor();
// Focus is still on the saved tile, which takes Copy for what it inserted (#898).
await win.keyboard.press(`${MOD}+c`);
await win.locator('.toast', { hasText: /^Copied Feature band/ }).waitFor();
await win.getByRole('button', { name: 'Undo adding Feature band' }).click();
await eventually(async () => assert.deepEqual(await components(), {}, 'one Undo takes the component back'));
assert.deepEqual((await snapshot()).state.pages[st.site.homePageId], pageBefore, 'and its placement');
await savedTile('Feature band').waitFor();

step('Import component… brings a file in through the native open chooser, without placing it');
const opened = await desktopCursor(app);
await answerChoosers(app, [{ dialog: 'open', paths: [file] }]);
await yours.locator('.insert-tile[data-kind="import"]').click();
await win.locator('.toast', { hasText: 'Imported Feature band' }).waitFor();
assert.deepEqual(await components(), { 'Feature band': 0 });
assert.deepEqual((await choosersShown(app, opened)).map((c) => [c.dialog, c.outcome]), [['open', 'chosen']]);

step('In Developer mode the saved code shows, and asks before its code comes in');
await setDeveloperMode(true);
await savedTile('Badge').waitFor();
await search.fill('badge');
await eventually(async () => assert.equal(await savedResults().count(), 1, 'and search finds it in Developer mode'));
await search.fill('');
const asked = await desktopCursor(app);
const cancelled = await applied();
await answerChoosers(app, [{ dialog: 'message', button: 'Cancel' }]);
await savedTile('Badge').click();
await eventually(async () => assert.equal((await choosersShown(app, asked)).length, 1, 'the code question was asked'));
assert.equal(await applied(), cancelled, 'Cancel brings nothing in');
assert.deepEqual(await components(), { 'Feature band': 0 });
await answerChoosers(app, [{ dialog: 'message', button: 'Import code' }]);
await savedTile('Badge').click();
await eventually(async () => assert.deepEqual(await components(), { 'Feature band': 0, Badge: 1 }, 'Import code places it'));
const shown = await choosersShown(app, asked);
assert.deepEqual(shown.map((c) => c.dialog), ['message', 'message'], 'asked each time, never answered by itself');
assert.ok(shown.every((c) => c.outcome !== 'unanswered' && c.outcome !== 'mismatched'), JSON.stringify(shown));

step('Remove from library takes it out of every project’s Insert, leaving the copies');
await saved.getByRole('button', { name: 'Manage saved Feature band', exact: true }).click();
await menu.getByRole('menuitem', { name: /Remove from library/ }).click();
await eventually(async () => assert.equal(await savedTile('Feature band').count(), 0));
assert.deepEqual(await components(), { 'Feature band': 0, Badge: 1 }, 'the project keeps its copies');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nsaved-components e2e passed');
