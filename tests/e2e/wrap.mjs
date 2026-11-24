// Wrap in Stack, Row or Grid, and Ungroup (#386), against the real app: two buttons picked together in Layers are
// wrapped in a Row from their menu as one change, which one Undo takes back; Shift+Cmd/Ctrl+G ungroups the Row again,
// also one change; and with the page itself holding the keyboard, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G wrap and ungroup the
// heading selected there, each once.
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
/** Press a chord as native input, the way the keyboard delivers it, so it passes the main process's forwarding (see undo.mjs). */
const chord = (key, shift = false) =>
  app.evaluate(
    ({ BrowserWindow }, { key, shift, mac }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const modifiers = [mac ? 'meta' : 'control', ...(shift ? ['shift'] : [])];
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    },
    { key, shift, mac: process.platform === 'darwin' }
  );
/** Click the middle of an element on the page, as a person would: the canvas scales the page to fit (see columns.mjs). */
const clickMiddle = async (locator) => {
  const p = await locator.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: innerWidth };
  });
  const box = await win.locator('.frame-box iframe').boundingBox();
  const scale = box.width / p.width;
  await win.mouse.click(box.x + p.x * scale, box.y + p.y * scale);
};

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
/** Pick the heading on the page: a first click picks its section, the next one the heading inside it. */
const pickHeading = async () => {
  const heading = frame.getByText('Visit the studio', { exact: true });
  await clickMiddle(heading);
  await eventually(async () => assert.ok((await selected()).length === 1, 'something is picked on the page'));
  if ((await selected())[0] !== title) {
    await new Promise((r) => setTimeout(r, 600));
    await clickMiddle(heading);
  }
  await eventually(async () => assert.deepEqual(await selected(), [title], 'the heading is selected on the page'));
};
const content = async () => (await snapshot()).pages[pageId].nodes[section].slots.content;
await frame.getByText('Call us', { exact: true }).waitFor();
const before = await page();

step('Shift-click picks both buttons in Layers, and their menu wraps them in a Row as one change');
if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
// The heading picked on the page opens its section in Layers, showing the buttons beside it.
await pickHeading();
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

step('with the page holding the keyboard, Cmd/Ctrl+G wraps the selected heading in a Stack and Shift+Cmd/Ctrl+G ungroups it, once each');
await pickHeading();
// The page takes the keyboard (a window never shown keeps focus where it was on a click): its keys reach the editor
// only as the main process forwards them, so they are sent as native input.
await win.locator('.frame-box iframe').focus();
assert.ok(await win.evaluate(() => document.activeElement instanceof HTMLIFrameElement), 'the page has the keyboard');
const beforeKeys = (await history()).length;
await chord('g');
let stack;
await eventually(async () => {
  const st = await snapshot();
  stack = st.pages[pageId].nodes[section].slots.content[0];
  assert.notEqual(stack, title, 'the heading is wrapped');
  assert.deepEqual(st.pages[pageId].nodes[stack].children, [title], 'in a container of its own, where it was');
  assert.equal(st.pages[pageId].nodes[stack].styles.base.layout, 'stack', 'a Stack');
});
await eventually(async () => assert.deepEqual(await selected(), [stack], 'the Stack is selected'));
assert.deepEqual((await history()).slice(beforeKeys), ['Wrap Heading 2 in Stack on Home'], 'one change, made once');
assert.ok(await win.evaluate(() => document.activeElement instanceof HTMLIFrameElement), 'the page still has the keyboard');
await chord('g', true);
await eventually(async () => assert.equal(await page(), wrapped, 'ungrouped, the heading is back where it was'));
assert.deepEqual((await history()).slice(beforeKeys), ['Wrap Heading 2 in Stack on Home', 'Ungroup Stack on Home'], 'one change each');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nwrap: all checks passed');
