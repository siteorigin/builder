// Deleting a parent that holds a component placement (#662), against the real app: a two-column Split of the
// project's own, in a Section between two paragraphs, holds a heading and a configured Card placement in one slot and
// a Stack in the other. The Delete key asks first: Cancel changes nothing, Delete all takes the Split with everything
// in it, and Remove wrapper & keep content (from the Layers menu) puts what it held in its place, selected. Each
// answer is one change, said in a notice whose Undo takes it back in one step. An empty Section still goes at once.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('delete-nested-content');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Nested Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
// The project records a change's History step just after its documents, so a read can see the one before the other.
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
const question = win.getByRole('dialog', { name: 'Delete “Split”?' });
const toastFor = (text) => win.locator('.toast', { hasText: text });

step('a Split holding a heading, a configured Card and a Stack, in a Section between two paragraphs, and an empty Section');
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [made, card] = await apply(
  [
    { type: 'component.create', name: 'Split' },
    { type: 'component.create', name: 'Card' }
  ],
  'Create components'
);
const split = made.definitionId;
await apply(
  [
    { type: 'component.setSlot', definitionId: split, slot: 'left', label: 'Left' },
    { type: 'component.setSlot', definitionId: split, slot: 'right', label: 'Right' },
    { type: 'node.insert', owner: { kind: 'component', id: split }, parentId: made.rootNodeId, primitive: 'slot', bind: 'left' },
    { type: 'node.insert', owner: { kind: 'component', id: split }, parentId: made.rootNodeId, primitive: 'slot', bind: 'right' },
    { type: 'node.insert', owner: { kind: 'component', id: card.definitionId }, parentId: card.rootNodeId, primitive: 'heading', text: 'Card title' }
  ],
  'Design the components'
);
await apply(
  [
    { type: 'node.insert', newNodeId: 'n_section', owner, componentId: 'layout.section' },
    { type: 'node.insert', newNodeId: 'n_before', owner, parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'Before the split' },
    { type: 'node.insert', newNodeId: 'n_split', owner, parentId: 'n_section', slot: 'content', definitionId: split },
    { type: 'node.insert', newNodeId: 'n_after', owner, parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'After the split' },
    { type: 'node.insert', newNodeId: 'n_heading', owner, parentId: 'n_split', slot: 'left', primitive: 'heading', text: 'Our story' },
    { type: 'node.insert', newNodeId: 'n_card', owner, parentId: 'n_split', slot: 'left', definitionId: card.definitionId },
    { type: 'node.setStyle', owner, nodeId: 'n_card', scope: 'base', property: 'background', value: '#e8f0ff' },
    { type: 'node.insert', newNodeId: 'n_stack', owner, parentId: 'n_split', slot: 'right', primitive: 'stack' },
    { type: 'node.insert', newNodeId: 'n_para', owner, parentId: 'n_stack', primitive: 'paragraph', text: 'Inside the stack' },
    { type: 'node.insert', newNodeId: 'n_empty', owner, componentId: 'layout.section' }
  ],
  'Fill the page'
);
await frame.getByText('Inside the stack', { exact: true }).waitFor();
const page = async () => JSON.stringify((await snapshot()).pages[pageId]);
const library = async () => JSON.stringify(Object.keys((await snapshot()).components).sort());
const content = async () => (await snapshot()).pages[pageId].nodes.n_section.slots.content;
const before = await page();
const libraryBefore = await library();

if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
/** Select the Split in Layers, opening its Section's branch first, with the keyboard on its row. */
const pickSplit = async () => {
  await row('n_section').waitFor();
  if ((await row('n_section').getAttribute('aria-expanded')) === 'false') {
    await row('n_section').click();
    await win.keyboard.press('ArrowRight');
  }
  await row('n_split').click();
  await eventually(async () => assert.deepEqual(await selected(), ['n_split'], 'the Split is selected'));
};

step('the Delete key asks first, with Cancel holding the focus, and Cancel changes nothing');
await pickSplit();
let applied = await history();
await win.keyboard.press('Delete');
await question.waitFor();
await question.getByText('It holds 3 items. Delete them with it, or keep them where they are?').waitFor();
await question.getByText('Delete all removes it and the 3 items inside it, including a placed component with its own content.').waitFor();
await question.getByText('Reusable component definitions stay in the library.').waitFor();
for (const name of ['Cancel', 'Delete all', 'Remove wrapper & keep content']) await question.getByRole('button', { name, exact: true }).waitFor();
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.textContent), 'Cancel', 'the safe choice has the focus'));
await win.screenshot({ path: join(SHOTS, 'delete-nested-question.png') });
await question.getByRole('button', { name: 'Cancel', exact: true }).click();
await question.waitFor({ state: 'detached' });
assert.equal(await page(), before, 'nothing changed');
assert.deepEqual(await history(), applied, 'no change was made');
assert.equal(await win.locator('.toast', { hasText: 'Split' }).count(), 0, 'nothing to announce');

step('Delete all takes the Split and everything in it as one change; the library keeps its components; one Undo puts it all back');
await pickSplit();
await win.keyboard.press('Delete');
await question.getByRole('button', { name: 'Delete all', exact: true }).click();
await eventually(async () => assert.deepEqual(await content(), ['n_before', 'n_after'], 'the Split is gone from between the paragraphs'));
const afterAll = (await snapshot()).pages[pageId].nodes;
for (const id of ['n_split', 'n_heading', 'n_card', 'n_stack', 'n_para']) assert.equal(afterAll[id], undefined, `${id} went with it`);
assert.equal(await library(), libraryBefore, 'the Split and Card components stay in the library');
await eventually(async () => assert.deepEqual((await history()).slice(applied.length), ['Delete Split on Home'], 'one change'));
await toastFor('Deleted Split and 3 nested items').getByRole('button', { name: 'Undo' }).click();
await eventually(async () => assert.equal(await page(), before, 'one Undo restores the page exactly'));
await frame.getByText('Inside the stack', { exact: true }).waitFor();

step('Remove wrapper & keep content, from the Layers menu, puts what the Split held in its place, selected, as one change');
await pickSplit();
applied = await history();
await row('n_split').click({ button: 'right' });
await menu.getByRole('menuitem', { name: /^Delete/ }).click();
await question.getByRole('button', { name: 'Remove wrapper & keep content', exact: true }).click();
await eventually(async () => assert.deepEqual(await content(), ['n_before', 'n_heading', 'n_card', 'n_stack', 'n_after'], 'its content takes its place, in order'));
const kept = (await snapshot()).pages[pageId].nodes;
assert.equal(kept.n_split, undefined, 'the Split itself is gone');
const original = JSON.parse(before).nodes;
// The Card keeps its own background, and every kept node its ID, content and what it holds.
for (const id of ['n_heading', 'n_card', 'n_stack', 'n_para']) assert.deepEqual(kept[id], original[id], `${id} is kept as it was`);
assert.match(JSON.stringify(kept.n_card), /#e8f0ff/, 'the Card’s own style is among what it keeps');
await eventually(async () => assert.deepEqual((await history()).slice(applied.length), ['Remove Split on Home, keeping its content'], 'one change'));
await eventually(async () => assert.deepEqual(await selected(), ['n_heading', 'n_card', 'n_stack'], 'what took its place is selected'));
await frame.getByText('Inside the stack', { exact: true }).waitFor();
await win.screenshot({ path: join(SHOTS, 'delete-nested-kept.png') });
await toastFor('Removed Split and kept 3 items').getByRole('button', { name: 'Undo' }).click();
await eventually(async () => assert.equal(await page(), before, 'one Undo puts the Split back with its slots as they were'));

step('an empty Section is deleted at once, with no question');
await row('n_empty').click();
await eventually(async () => assert.deepEqual(await selected(), ['n_empty']));
applied = await history();
await win.keyboard.press('Delete');
await eventually(async () => assert.ok(!(await snapshot()).pages[pageId].rootIds.includes('n_empty'), 'the empty Section is gone'));
assert.equal(await win.getByRole('dialog').count(), 0, 'nothing was asked');
await eventually(async () => assert.deepEqual((await history()).slice(applied.length), ['Delete Section on Home'], 'one change'));
await toastFor('Deleted Section').waitFor();

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ndelete-nested-content: all checks passed');
