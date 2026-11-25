// Empty component slots in Layers (#653), against the real app: a placed Split with two empty slots lists both, Main
// then Sidebar, each marked empty; picking the second one makes it where Insert puts a tile clicked next; a paragraph
// dragged in Layers onto that empty Sidebar row moves into it as one change, and a second one is refused by the slot's
// contract (one item at most), changing nothing. The slot rows are tree items the arrow keys reach, with one tab stop.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('layers-slots');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Slot Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const history = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).map((e) => e.label));
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const tree = win.locator('.layers-tree');
const row = (id) => tree.locator(`[data-node="${id}"]`);
const panel = win.locator('.side-panel-view:not([hidden])');
const showLayers = async () => {
  if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
  await tree.waitFor();
};
/** Open a row's branch, if it is closed. */
const expand = async (id) => {
  await row(id).waitFor();
  if ((await row(id).getAttribute('aria-expanded')) === 'false') await row(id).locator('.tree-toggle').click();
  await eventually(async () => assert.equal(await row(id).getAttribute('aria-expanded'), 'true', 'the branch is open'));
};

step('a Section holding an empty Split (Main, then a Sidebar taking one text or button), and two paragraphs beside it');
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ definitionId: splitDef }] = await apply(
  [
    {
      type: 'component.upsert',
      name: 'Split',
      insertAs: 'element',
      properties: {},
      nodes: [
        { kind: 'element', id: 'root', tag: 'div', children: ['mainBox', 'sideBox'], styles: { base: { layout: 'row', gap: { token: 'space.md' } } } },
        { kind: 'element', id: 'mainBox', tag: 'div', children: ['mainSlot'] },
        { kind: 'slot', id: 'mainSlot', slot: 'main' },
        { kind: 'element', id: 'sideBox', tag: 'aside', children: ['sideSlot'] },
        { kind: 'slot', id: 'sideSlot', slot: 'sidebar' }
      ],
      slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar', primitives: ['text', 'link'], max: 1 } }
    }
  ],
  'Make Split'
);
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Insert section');
const [{ nodeId: split }, { nodeId: one }, { nodeId: two }] = await apply(
  [
    { type: 'node.insert', owner, parentId: section, slot: 'content', definitionId: splitDef },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'First note' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Second note' }
  ],
  'Insert content'
);
const slots = async () => (await snapshot()).pages[pageId].nodes[split].slots ?? {};
const slotRow = (slot) => tree.locator(`[data-placement="${split}"][data-slot="${slot}"]`);

step('expanding the Split lists both slots in the order it declares them, each marked empty');
await showLayers();
await expand(section);
await expand(split);
const listed = await tree.locator(`[data-placement="${split}"][data-slot]`).evaluateAll((rows) => rows.map((r) => [r.dataset.slot, r.getAttribute('role'), r.getAttribute('aria-label'), r.textContent.trim()]));
assert.deepEqual(listed, [
  ['main', 'treeitem', 'Main, slot of Split, empty', 'MainEmpty'],
  ['sidebar', 'treeitem', 'Sidebar, slot of Split, empty', 'SidebarEmpty']
]);
const splitLevel = Number(await row(split).getAttribute('aria-level'));
assert.equal(Number(await slotRow('sidebar').getAttribute('aria-level')), splitLevel + 1, 'a slot row sits one level inside its component');
await win.screenshot({ path: join(SHOTS, 'layers-slots-empty.png') });

step('clicking the empty Sidebar row picks it, and a Paragraph tile clicked in Insert goes into it');
await slotRow('sidebar').click();
await eventually(async () => assert.equal(await slotRow('sidebar').getAttribute('aria-selected'), 'true', 'the Sidebar row is picked'));
assert.equal(await tree.locator('[role="treeitem"][aria-selected="true"]').count(), 1, 'nothing else is selected');
assert.equal(await tree.locator('[role="treeitem"][tabindex="0"]').count(), 1, 'one tab stop');
assert.equal(await tree.locator('[role="treeitem"][tabindex="0"]').getAttribute('data-slot'), 'sidebar', 'the picked slot holds it');
await win.locator('.rail [aria-label="Insert"]').click();
await eventually(async () => assert.match(await panel.locator('.insert-where').innerText(), /inside Sidebar in Split/, 'Insert says where the next tile goes'));
await panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: /^Paragraph$/ }) }).click();
let added;
await eventually(async () => {
  const s = await slots();
  assert.equal(s.sidebar?.length, 1, 'a paragraph is in the Sidebar');
  assert.deepEqual(s.main ?? [], [], 'Main is still empty');
  added = s.sidebar[0];
});
assert.equal((await snapshot()).pages[pageId].nodes[added].kind, 'text', 'the Paragraph tile');
await win.screenshot({ path: join(SHOTS, 'layers-slots-inserted.png') });

step('one Undo empties the Sidebar again');
await showLayers();
await row(added).waitFor();
await row(added).focus();
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual((await slots()).sidebar ?? [], [], 'the Sidebar is empty'));
await eventually(async () => assert.equal(await slotRow('sidebar').locator('.layer-slot-empty').count(), 1, 'and its row says so'));

step('a paragraph dragged onto the empty Sidebar row moves into it, as one change');
const applied = (await history()).length;
await row(one).dragTo(slotRow('sidebar'));
await eventually(async () => assert.deepEqual((await slots()).sidebar, [one], 'the first paragraph is in the Sidebar'));
assert.deepEqual((await snapshot()).pages[pageId].nodes[section].slots.content, [split, two], 'and gone from beside the Split');
assert.deepEqual((await history()).slice(applied), ['Move Text · First note on Home'], 'one change');
assert.equal(await slotRow('sidebar').locator('.layer-slot-empty').count(), 0, 'the Sidebar row is no longer marked empty');

step('a second paragraph dropped onto the full Sidebar is refused by its contract, changing nothing');
const before = JSON.stringify((await snapshot()).pages[pageId]);
await row(two).dragTo(slotRow('sidebar'));
await win.locator('.toast', { hasText: 'holds at most one item' }).waitFor();
assert.equal(JSON.stringify((await snapshot()).pages[pageId]), before, 'the page is as it was');

step('the slot rows are tree items the keys reach: Up/Down pick them, Left goes back to the Split');
await slotRow('main').click();
await eventually(async () => assert.equal(await slotRow('main').getAttribute('aria-selected'), 'true'));
await slotRow('main').focus();
await win.keyboard.press('ArrowDown');
await eventually(async () => assert.equal(await slotRow('sidebar').getAttribute('aria-selected'), 'true', 'Down picks the Sidebar'));
assert.ok(await slotRow('sidebar').evaluate((el) => el === document.activeElement), 'and focuses it');
await win.keyboard.press('ArrowLeft');
await eventually(async () => assert.equal(await row(split).getAttribute('aria-selected'), 'true', 'Left selects the Split'));
assert.equal(await slotRow('sidebar').getAttribute('aria-selected'), 'false', 'and lets the slot go');
assert.ok(await row(split).evaluate((el) => el === document.activeElement), 'focus is on the Split');
assert.equal(await tree.locator('[role="treeitem"][tabindex="0"]').count(), 1, 'still one tab stop');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nlayers-slots: all checks passed');
