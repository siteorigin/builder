// Wrap in Stack, Row or Grid, and Ungroup (#386), against the real app: two buttons picked together in Layers are
// wrapped in a Row from their menu as one change, which one Undo takes back; Shift+Cmd/Ctrl+G ungroups the Row again,
// also one change; and with the page itself holding the keyboard, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G wrap and ungroup the
// button selected there, each once.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('wrap');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Wrap Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const history = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).map((e) => e.label));
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const menu = win.getByRole('menu');
const row = (id) => win.locator(`.layers-tree [data-node="${id}"]`);
const selected = () => win.locator('.layers-tree [role="treeitem"][aria-selected="true"]').evaluateAll((rows) => rows.map((r) => r.dataset.node));

step('a section holding a heading, two buttons and a paragraph');
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, componentId: 'layout.section' }], 'Insert section');
const made = await apply(
  [
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'heading', text: 'Visit the studio' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'button', text: 'Book a visit' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'button', text: 'Call us' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Open every day.' }
  ],
  'Insert content'
);
const [title, book, call, note] = made.map((r) => r.nodeId);
const page = async () => JSON.stringify((await snapshot()).pages[pageId]);
const content = async () => (await snapshot()).pages[pageId].nodes[section].slots.content;
await frame.getByText('Call us', { exact: true }).waitFor();
const before = await page();

step('Shift-click picks both buttons in Layers, and their menu wraps them in a Row as one change');
if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
await frame.getByText('Book a visit', { exact: true }).click();
await row(book).waitFor();
await row(book).click();
await row(call).click({ modifiers: ['Shift'] });
await eventually(async () => assert.deepEqual(await selected(), [book, call], 'both buttons are selected together'));
const applied = (await history()).length;
await row(call).click({ button: 'right' });
await menu.getByRole('menuitem', { name: 'Wrap in Row' }).click();
let rowId;
await eventually(async () => {
  const c = await content();
  assert.equal(c.length, 3, 'the two buttons became one Row between the heading and the paragraph');
  rowId = c[1];
  assert.deepEqual([c[0], c[2]], [title, note]);
  const node = (await snapshot()).pages[pageId].nodes[rowId];
  assert.equal(node.kind, 'element');
  assert.equal(node.styles.base.layout, 'row', 'a Row');
  assert.deepEqual(node.children, [book, call], 'holding both buttons, in order');
});
await eventually(async () => assert.deepEqual(await selected(), [rowId], 'the new Row is selected'));
assert.deepEqual((await history()).slice(applied), ['Wrap Button and Button in Row on Home'], 'one change, named for History');
await win.locator('.toast', { hasText: 'Wrapped Button and Button in a Row.' }).waitFor();
await win.screenshot({ path: join(SHOTS, 'wrap-row.png') });
const wrapped = await page();

step('one Undo puts both buttons back as they were');
await row(rowId).focus();
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await page(), before, 'one Undo restores the page'));
await win.keyboard.press(`${MOD}+Shift+z`);
await eventually(async () => assert.equal(await page(), wrapped, 'Redo wraps them again'));

step('Shift+Cmd/Ctrl+G ungroups the Row from Layers, as one change, and selects both buttons');
await row(rowId).click();
await eventually(async () => assert.deepEqual(await selected(), [rowId]));
const beforeUngroup = (await history()).length;
await win.keyboard.press(`${MOD}+Shift+g`);
await eventually(async () => assert.equal(await page(), before, 'the buttons are back where the Row was, as they were'));
await eventually(async () => assert.deepEqual(await selected(), [book, call], 'both buttons are selected'));
assert.deepEqual((await history()).slice(beforeUngroup), ['Ungroup Row on Home'], 'one change');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await page(), wrapped, 'one Undo brings the Row back'));

step('with the page holding the keyboard, Cmd/Ctrl+G wraps the selected button in a Stack and Shift+Cmd/Ctrl+G ungroups it, once each');
await frame.getByText('Call us', { exact: true }).click();
await eventually(async () => assert.deepEqual(await selected(), [call], 'the button is selected on the page'));
assert.ok(await win.evaluate(() => document.activeElement instanceof HTMLIFrameElement), 'the page has the keyboard');
const beforeKeys = (await history()).length;
await win.keyboard.press(`${MOD}+g`);
let stack;
await eventually(async () => {
  const st = await snapshot();
  stack = st.pages[pageId].nodes[rowId].children[1];
  assert.notEqual(stack, call, 'the button is wrapped');
  assert.deepEqual(st.pages[pageId].nodes[stack].children, [call], 'in a container of its own, in the Row');
  assert.equal(st.pages[pageId].nodes[stack].styles.base.layout, 'stack', 'a Stack');
});
await eventually(async () => assert.deepEqual(await selected(), [stack], 'the Stack is selected'));
assert.deepEqual((await history()).slice(beforeKeys), ['Wrap Button in Stack on Home'], 'one change, made once');
assert.ok(await win.evaluate(() => document.activeElement instanceof HTMLIFrameElement), 'the page still has the keyboard');
await win.keyboard.press(`${MOD}+Shift+g`);
await eventually(async () => assert.equal(await page(), wrapped, 'ungrouped, the Row holds both buttons again'));
assert.deepEqual((await history()).slice(beforeKeys), ['Wrap Button in Stack on Home', 'Ungroup Stack on Home'], 'one change each');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nwrap: all checks passed');
