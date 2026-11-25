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

const project = () => win.evaluate(() => window.builder.project.snapshot());
const snapshot = async () => (await project()).state;
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const text = (s) => s.replace(/\s+/g, ' ').trim();
const cmdk = win.locator('.cmdk');
const input = cmdk.getByRole('combobox');
const openCmdk = async (q) => {
  await win.keyboard.press(`${MOD}+K`);
  await cmdk.waitFor();
  await eventually(async () => assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'the search has the cursor'));
  if (q) {
    await win.keyboard.type(q);
    await eventually(async () => assert.equal(await input.inputValue(), q));
  }
};
const closeCmdk = async () => {
  await win.keyboard.press('Escape');
  await cmdk.waitFor({ state: 'detached' });
};
const group = (name) => cmdk.getByRole('group', { name, exact: true });
const rows = async (name) => (await group(name).getByRole('option').allInnerTexts()).map(text);
/** Moves the highlight to `option` with the arrow keys. */
const highlight = async (option) => {
  const at = Number(await option.getAttribute('data-index'));
  const now = Number(await cmdk.locator('[role="option"][aria-selected="true"]').getAttribute('data-index'));
  for (let i = now; i !== at; i += at > now ? 1 : -1) await win.keyboard.press(at > now ? 'ArrowDown' : 'ArrowUp');
  await eventually(async () => assert.equal(await input.getAttribute('aria-activedescendant'), await option.getAttribute('id')));
};
const footer = cmdk.locator('.cmdk-foot-action');
const rail = (id) => win.locator(`.rail [data-rail="${id}"]`);
const pressed = (id) => rail(id).getAttribute('aria-pressed');
const nodes = async () => (await snapshot()).pages[pageId];
/** What a section holds, in order (an empty one has no list yet). */
const content = (page, id) => page.nodes[id].slots?.content ?? [];
/** The one node the page has now that it did not have in `before`. */
const addedSince = (before, after) => {
  const added = Object.keys(after.nodes).filter((id) => !before.nodes[id]);
  assert.equal(added.length, 1, `one node is added: ${added.join(', ')}`);
  return added[0];
};

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
const [{ definitionId: headingDef }] = await apply([{ type: 'component.createFromNode', owner, nodeId: closing, name: 'Heading' }], 'Create component');

step('with nothing typed, the project’s components lead Insert, and the rest open in place');
await openCmdk();
let insert = await rows('Insert');
assert.equal(insert[0], 'Insert Heading Component', `Your components come first: ${insert.join(' | ')}`);
const more = group('Insert').getByRole('option', { name: /^Show \d+ more to insert$/ });
assert.equal(await more.count(), 1, 'the rest wait behind Show more');
await more.click();
await eventually(async () => assert.equal(await more.count(), 0, 'Show more gives way to what it held'));
assert.equal(await cmdk.isVisible(), true, 'and the menu stays open');
insert = await rows('Insert');
assert.ok(insert.includes('Insert Paragraph Element') && insert.includes('Insert 2 columns Layout'), `the basic elements are listed: ${insert.join(' | ')}`);
await closeCmdk();

step('a component and the basic element of the same name are both found, and each says where it lands');
await rail('layers').click();
await win.locator(`[role="treeitem"][data-node="${intro}"]`).click();
await openCmdk('heading');
insert = await rows('Insert');
assert.deepEqual(insert.slice(0, 2), ['Insert Heading Component', 'Insert Heading Element'], `both are listed, the project’s first: ${insert.join(' | ')}`);
const component = group('Insert').getByRole('option', { name: /^Insert Heading Component/ });
const element = group('Insert').getByRole('option', { name: /^Insert Heading Element/ });
await highlight(component);
assert.equal(await footer.innerText(), 'Insert after Section', 'a component made from a whole section goes after the selected one');
assert.equal(await footer.getAttribute('title'), 'Insert after Section', 'its whole place on hover');
assert.equal(await component.getAttribute('aria-description'), 'Insert after Section', 'and said to assistive technology');
assert.equal(await cmdk.locator('.cmdk-foot-enter kbd').innerText(), process.platform === 'darwin' ? '↵' : 'Enter', 'Enter written for this platform');
await highlight(element);
assert.equal(await footer.innerText(), 'Insert inside Section', 'the element goes inside the selected Section');
assert.equal(await footer.getAttribute('title'), 'Insert inside Section');
assert.equal(await element.getAttribute('aria-description'), 'Insert inside Section');

step('Enter inserts the highlighted one where it said');
let before = await nodes();
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => {
  const page = await nodes();
  const added = addedSince(before, page);
  assert.equal(page.nodes[added].kind, 'text');
  assert.equal(page.nodes[added].tag, 'h2', 'a heading');
  assert.deepEqual(content(page, intro), [...content(before, intro), added], 'at the end of the Intro section’s content');
  assert.deepEqual(page.rootIds, before.rootIds, 'not as a section of its own');
});

step('the component of the same name goes after the section instead');
await win.locator(`[role="treeitem"][data-node="${intro}"]`).click();
before = await nodes();
await openCmdk('heading');
await highlight(component);
assert.equal(await footer.innerText(), 'Insert after Section');
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => {
  const page = await nodes();
  const added = addedSince(before, page);
  assert.equal(page.nodes[added].kind, 'instance');
  assert.equal(page.nodes[added].definitionId, headingDef, 'the project’s Heading');
  assert.deepEqual(page.rootIds, [intro, added, ...before.rootIds.slice(1)], 'right after the Intro section');
  assert.deepEqual(content(page, intro), content(before, intro), 'leaving the Intro section as it was');
});

step('basic elements are found by name and by the words Insert finds them by');
await openCmdk('paragraph');
assert.ok((await rows('Insert')).includes('Insert Paragraph Element'), 'Paragraph is offered');
await closeCmdk();
await openCmdk('two columns');
assert.deepEqual(await rows('Insert'), ['Insert 2 columns Layout'], 'a column layout by its other words');
await closeCmdk();

step('Show the Insert panel opens Insert with the cursor in its search');
assert.equal(await pressed('layers'), 'true', 'Layers is open');
await openCmdk('insert panel');
assert.match(text(await cmdk.getByRole('option').first().innerText()), /^Show the Insert panel/, 'the panel leads');
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await pressed('insert'), 'true', 'Insert is open'));
const insertSearch = win.locator('.side-panel-view:not([hidden]) input[aria-label="Search items to add"]');
await eventually(async () => assert.equal(await insertSearch.evaluate((el) => el === document.activeElement), true, 'its search has the cursor'));

step('the open view is listed but cannot be chosen again; the others can');
await openCmdk('panel');
const panelRow = (label) => cmdk.getByRole('option', { name: new RegExp(`^Show the ${label} panel`) });
assert.equal(await panelRow('Insert').getAttribute('aria-disabled'), 'true');
assert.match(text(await panelRow('Insert').innerText()), /Already open$/);
for (const label of ['Pages', 'Posts', 'Layers', 'Assets', 'SEO']) assert.equal(await panelRow(label).getAttribute('aria-disabled'), null, `${label} can be opened`);
await highlight(panelRow('Insert'));
await win.keyboard.press('Enter');
await win.waitForTimeout(200);
assert.equal(await cmdk.isVisible(), true, 'Enter does nothing on it');
assert.equal(await input.getAttribute('aria-activedescendant'), await panelRow('Insert').getAttribute('id'), 'and the highlight stays');
assert.equal(await pressed('insert'), 'true');
await closeCmdk();

step('the sidebar hides from the menu, focus going to the view’s rail button, and shows again');
await eventually(async () => assert.equal(await insertSearch.evaluate((el) => el === document.activeElement), true, 'opened from Insert’s search'));
await openCmdk('hide sidebar');
const toggle = cmdk.getByRole('option', { name: /^Hide the sidebar/ });
assert.match(await toggle.locator('kbd').innerText(), process.platform === 'darwin' ? /^⌘\\$/ : /^Ctrl\+\\$/, 'its shortcut, written for this platform');
await highlight(toggle);
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await win.locator('#editor-sidebar').isVisible(), false, 'the sidebar is hidden'));
await eventually(async () => assert.equal(await rail('insert').evaluate((el) => el === document.activeElement), true, 'focus is on the Insert rail button, as the shortcut leaves it'));
await openCmdk('hide sidebar');
assert.equal(await cmdk.getByRole('option', { name: /the sidebar/ }).count(), 0, 'a hidden sidebar is not offered for “hide”');
await closeCmdk();
await openCmdk('show sidebar');
await highlight(cmdk.getByRole('option', { name: /^Show the sidebar/ }));
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await pressed('pages'), 'true', 'it shows again on Pages'));
await openCmdk('panel');
assert.equal(await panelRow('Pages').getAttribute('aria-disabled'), 'true', 'Pages is now the open one');
assert.equal(await panelRow('Insert').getAttribute('aria-disabled'), null, 'and Insert can be opened again');
await closeCmdk();

step('code components are offered only in Developer mode');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
const SOURCE = `<script>\n\tlet { class: className = '' } = $props();\n</script>\n\n<p class="ticker {className}">News</p>\n`;
const [{ definitionId: tickerDef }] = await apply([{ type: 'component.createCode', name: 'Ticker', source: SOURCE }], 'Create code component');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: false }));
const devMode = async (on) => {
  await win.locator('[aria-label="Settings"]').click();
  const devSwitch = win.getByRole('switch', { name: 'Developer mode' });
  if ((await devSwitch.getAttribute('aria-checked')) !== String(on)) await devSwitch.click();
  await eventually(async () => assert.equal(await devSwitch.getAttribute('aria-checked'), String(on)));
  await eventually(async () => assert.equal((await win.evaluate(() => window.builder.app.getSettings())).developerMode, on, 'saved'));
  await win.keyboard.press('Escape');
  await win.locator('.modal').waitFor({ state: 'detached' });
};
const tickerRows = () => cmdk.getByRole('option', { name: /Ticker/ });
await openCmdk('ticker');
assert.equal(await tickerRows().count(), 0, 'neither inserted nor opened in Component Studio without Developer mode');
await closeCmdk();
await devMode(true);
await openCmdk('ticker');
assert.ok((await rows('Insert')).includes('Insert Ticker Code component'), 'the code component is offered in Developer mode');
assert.equal(await cmdk.getByRole('option', { name: /^Open Ticker in Component Studio/ }).count(), 1, 'and opens in Component Studio');
before = await nodes();
await highlight(group('Insert').getByRole('option', { name: /^Insert Ticker/ }));
await win.keyboard.press('Enter');
await cmdk.waitFor({ state: 'detached' });
await eventually(async () => {
  const page = await nodes();
  const added = addedSince(before, page);
  assert.equal(page.nodes[added].definitionId, tickerDef, 'Enter inserts the code component');
});
await devMode(false);
await openCmdk('ticker');
// The one placed on the page is still found there, under On the site.
assert.equal(await cmdk.getByRole('option', { name: /^Insert Ticker|^Open Ticker in Component Studio/ }).count(), 0, 'and it goes again when Developer mode is turned off');
await closeCmdk();

step('a component edited everywhere cannot be inserted into itself');
await openCmdk('open heading');
await cmdk.getByRole('option', { name: /^Open Heading in Component Studio/ }).click();
await win.locator('.mode-band').waitFor();
await openCmdk('heading');
// Listed after the element it shares a name with, since a row that cannot run never outranks one that can.
assert.deepEqual((await rows('Insert')).slice(0, 2), ['Insert Heading Element', 'Insert Heading Would contain itself'], 'the component itself says why it is unavailable, in place of what it is');
const self = group('Insert').getByRole('option', { name: /^Insert Heading Would contain itself/ });
assert.equal(await self.getAttribute('aria-disabled'), 'true', 'the component itself is unavailable');
assert.equal(await self.getAttribute('aria-description'), null, 'and names no place it would go');
const revision = (await project()).revision;
await highlight(self);
assert.equal(await footer.count(), 0, 'the footer offers nothing for Enter');
await win.keyboard.press('Enter');
// Forced: the row stands still, but Playwright's stability wait never settles over the headless Component Studio.
await self.click({ force: true });
await win.waitForTimeout(300);
assert.equal(await cmdk.isVisible(), true, 'neither Enter nor a click runs it');
assert.equal((await project()).revision, revision, 'and the project is unchanged');
await highlight(element);
assert.match(await footer.innerText(), /^Insert (inside|after) /, 'a basic element still names its place in the component');
await closeCmdk();

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncommand-insert: passed');
