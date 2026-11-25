// The command menu inserts what the Insert panel does and opens the sidebar's views (#174): the project's own components
// (code ones only in Developer mode) and the basic elements sit under Insert beside the theme's sections, each says where
// it lands, a component and an element of one name each go to their own place, a component never goes inside itself,
// and Show the Insert panel leaves the cursor in Insert's search.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('command-insert');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Expo Hall', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const text = (s) => s.replace(/\s+/g, ' ').trim();
const cmdk = win.locator('.cmdk');
const openCmdk = async (q) => {
  await win.keyboard.press(`${MOD}+K`);
  await cmdk.waitFor();
  if (q) await win.keyboard.type(q);
};
const closeCmdk = async () => {
  await win.keyboard.press('Escape');
  await cmdk.waitFor({ state: 'detached' });
};
const group = (name) => cmdk.getByRole('group', { name, exact: true });
const rows = async (name) => (await group(name).getByRole('option').allInnerTexts()).map(text);
/** Moves the highlight to `option` with the arrow keys, as the menu opens on its first row. */
const highlight = async (option) => {
  const at = Number(await option.getAttribute('data-index'));
  const now = Number(await cmdk.locator('[role="option"][aria-selected="true"]').getAttribute('data-index'));
  for (let i = now; i < at; i++) await win.keyboard.press('ArrowDown');
  await eventually(async () => assert.equal(await option.getAttribute('aria-selected'), 'true'));
};
const footer = () => cmdk.locator('.cmdk-foot-action').innerText();
const railPressed = (name) => win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed');

// An Intro section, then a closing Section made into a component called Heading, the basic element's name.
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ nodeId: intro }, { nodeId: closing }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ],
  'Add sections'
);
await apply([{ type: 'node.insert', owner, parentId: closing, slot: 'content', primitive: 'heading', text: 'See you there' }], 'Add a heading');
await apply([{ type: 'component.createFromNode', owner, nodeId: closing, name: 'Heading' }], 'Create component');

step('with nothing typed, the project’s components lead Insert, and the rest open in place');
await openCmdk();
let insert = await rows('Insert');
assert.equal(insert[0], 'Insert Heading Component', `Your components come first: ${insert.join(' | ')}`);
assert.ok(insert.some((r) => /^Show \d+ more to insert$/.test(r)), 'the rest wait behind Show more');
await closeCmdk();

step('a component and the basic element of the same name are both found, and each says where it lands');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator(`[role="treeitem"][data-node="${intro}"]`).click();
await openCmdk('heading');
insert = await rows('Insert');
assert.deepEqual(insert.slice(0, 2), ['Insert Heading Component', 'Insert Heading Element'], `both are listed, the project’s first: ${insert.join(' | ')}`);
const component = group('Insert').getByRole('option', { name: /^Insert Heading Component/ });
const element = group('Insert').getByRole('option', { name: /^Insert Heading Element/ });
await highlight(component);
assert.equal(await footer(), 'Insert after Section', 'a component made from a whole section goes after the selected one');
assert.equal(await component.getAttribute('aria-description'), 'Insert after Section', 'and says so to assistive technology');
await highlight(element);
assert.equal(await footer(), 'Insert inside Section', 'the element goes inside the selected Section');
assert.equal(await element.getAttribute('aria-description'), 'Insert inside Section');

step('Enter inserts the highlighted one where it said');
const before = await snapshot();
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => {
  const page = (await snapshot()).pages[pageId];
  const added = Object.keys(page.nodes).filter((id) => !before.pages[pageId].nodes[id]);
  assert.equal(added.length, 1, 'one node is added');
  assert.ok(JSON.stringify(page.nodes[intro]).includes(added[0]), 'inside the Intro section');
  assert.equal(page.rootIds.length, before.pages[pageId].rootIds.length, 'not as a section of its own');
});

step('basic elements and sidebar views are found by name');
await openCmdk('paragraph');
assert.ok((await rows('Insert')).includes('Insert Paragraph Element'), 'Paragraph is offered');
await closeCmdk();
await openCmdk('two columns');
assert.equal((await rows('Insert'))[0], 'Insert 2 columns Layout', 'a column layout by the words Insert finds it by');
await closeCmdk();

step('Show the Insert panel opens Insert with the cursor in its search');
assert.equal(await railPressed('Layers'), 'true', 'Layers is open');
await openCmdk('insert panel');
assert.match(text(await cmdk.getByRole('option').first().innerText()), /^Show the Insert panel/, 'the panel leads');
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await railPressed('Insert'), 'true', 'Insert is open'));
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search items to add', 'its search has the cursor'));

step('the open view is listed but cannot be chosen again');
await openCmdk('insert panel');
const open = cmdk.getByRole('option', { name: /^Show the Insert panel/ });
assert.equal(await open.getAttribute('aria-disabled'), 'true');
assert.match(text(await open.innerText()), /Already open$/);
await win.keyboard.press('Enter');
assert.equal(await cmdk.isVisible(), true, 'Enter does nothing on it');
await closeCmdk();

step('the sidebar shows and hides from the menu, with its shortcut written for this platform');
await openCmdk('sidebar');
const toggle = cmdk.getByRole('option', { name: /^Hide the sidebar/ });
assert.match(await toggle.locator('kbd').innerText(), process.platform === 'darwin' ? /^⌘\\$/ : /^Ctrl\+\\$/);
await highlight(toggle);
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await win.locator('#editor-sidebar').isVisible(), false, 'the sidebar is hidden'));
await openCmdk('pages panel');
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await railPressed('Pages'), 'true', 'Pages opens the sidebar on Pages'));

step('code components are offered only in Developer mode');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
const SOURCE = `<script>\n\tlet { class: className = '' } = $props();\n</script>\n\n<p class="ticker {className}">News</p>\n`;
await apply([{ type: 'component.createCode', name: 'Ticker', source: SOURCE }], 'Create code component');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: false }));
await openCmdk('ticker');
assert.equal(await cmdk.getByRole('option', { name: /Ticker/ }).count(), 0, 'neither inserted nor opened in Component Studio without Developer mode');
await closeCmdk();
await win.locator('[aria-label="Settings"]').click();
const devSwitch = win.getByRole('switch', { name: 'Developer mode' });
assert.equal(await devSwitch.getAttribute('aria-checked'), 'false');
await devSwitch.click();
await eventually(async () => assert.equal(await devSwitch.getAttribute('aria-checked'), 'true'));
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await openCmdk('ticker');
assert.ok((await rows('Insert')).includes('Insert Ticker Code component'), 'the code component is offered in Developer mode');
assert.equal(await cmdk.getByRole('option', { name: /^Open Ticker in Component Studio/ }).count(), 1, 'and opens in Component Studio');
await closeCmdk();

step('a component edited everywhere cannot be inserted into itself');
await openCmdk('open heading');
await cmdk.getByRole('option', { name: /^Open Heading in Component Studio/ }).click();
await win.locator('.mode-band').waitFor();
await openCmdk('heading');
// Listed after the element it shares a name with, since a row that cannot run never outranks one that can.
assert.deepEqual((await rows('Insert')).slice(0, 2), ['Insert Heading Element', 'Insert Heading Would contain itself'], 'the component itself says why it is unavailable, in place of what it is');
assert.equal(await group('Insert').getByRole('option', { name: /^Insert Heading Would contain itself/ }).getAttribute('aria-disabled'), 'true', 'the component itself is unavailable');
await highlight(element);
assert.match(await footer(), /^Insert (inside|after) /, 'a basic element still names its place in the component');
await closeCmdk();

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncommand-insert: passed');
