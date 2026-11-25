// Deleting a parent that holds a component placement (#662), against the real app: a Split of the project's own
// with two slots, in a Section between two paragraphs, holds a heading and a configured Card placement in one slot and
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
/** The newest History entry, applied or not. */
const newest = () => win.evaluate(async () => (({ label, applied }) => ({ label, applied }))((await window.builder.project.snapshot()).history.entries.at(-1)));
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
/** The notice saying exactly `text`. */
const toastFor = (text) => win.locator('.toast').filter({ has: win.getByText(text, { exact: true }) });
/** Every value with its keys in order, so two reads of the same project compare equal however it lists them. */
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

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
const library = async () => canonical((await snapshot()).components);
const content = async () => (await snapshot()).pages[pageId].nodes.n_section.slots.content;
const before = await page();
const libraryBefore = await library();

if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
/** Select the Split in Layers, opening its Section's branch first, with the keyboard on its row. */
const pickSplit = async () => {
  await row('n_section').waitFor();
  if ((await row('n_section').getAttribute('aria-expanded')) === 'false') await row('n_section').locator('.tree-toggle').click();
  await row('n_split').click();
  await eventually(async () => assert.deepEqual(await selected(), ['n_split'], 'the Split is selected'));
  await eventually(async () => assert.ok(await row('n_split').evaluate((r) => r === document.activeElement), 'its row has the keyboard'));
};
/** After an Undo: the page as it was, and the change it took back still in History, no longer applied (to redo). */
const restored = async (applied, label, what) => {
  await eventually(async () => assert.equal(await page(), before, what));
  await eventually(async () => assert.deepEqual(await history(), applied, 'only the change is undone in History'));
  assert.deepEqual(await newest(), { label, applied: false }, 'it can be redone');
};

step('the Delete key asks first, with Cancel holding the focus, and Enter on it changes nothing');
await pickSplit();
let applied = await history();
await win.keyboard.press('Delete');
await question.waitFor();
await question.getByText('It holds 3 items. Delete them with it, or keep them where they are?').waitFor();
await question.getByText('Delete all removes it and everything inside it, including a placed component with its own content.').waitFor();
await question.getByText('Remove wrapper & keep content puts those 3 items in its place.').waitFor();
await question.getByText('Reusable component definitions stay in the library.').waitFor();
for (const name of ['Cancel', 'Delete all', 'Remove wrapper & keep content']) await question.getByRole('button', { name, exact: true }).waitFor();
const cancel = question.getByRole('button', { name: 'Cancel', exact: true });
await eventually(async () => assert.ok(await cancel.evaluate((b) => b === document.activeElement), 'the safe choice has the focus'));
await win.screenshot({ path: join(SHOTS, 'delete-nested-question.png') });
await win.keyboard.press('Enter');
await question.waitFor({ state: 'detached' });
assert.equal(await page(), before, 'nothing changed');
assert.deepEqual(await history(), applied, 'no change was made');
assert.equal(await win.locator('.toast', { hasText: 'Split' }).count(), 0, 'nothing to announce');
assert.deepEqual(await selected(), ['n_split'], 'the Split is still selected');
// Escape is a dismissal: it stays, as Cancel does.
await win.keyboard.press('Delete');
await question.waitFor();
await win.keyboard.press('Escape');
await question.waitFor({ state: 'detached' });
assert.equal(await page(), before, 'Escape changed nothing');
assert.deepEqual(await history(), applied, 'and made no change');

step('Delete all takes the Split and everything in it as one change; the library keeps its components; one Undo puts it all back');
await pickSplit();
await win.keyboard.press('Delete');
await question.getByRole('button', { name: 'Delete all', exact: true }).click();
await eventually(async () => assert.deepEqual(await content(), ['n_before', 'n_after'], 'the Split is gone from between the paragraphs'));
// Held under the pointer, so it stays while the rest is checked.
await toastFor('Deleted Split and 3 nested items').hover();
const afterAll = (await snapshot()).pages[pageId].nodes;
for (const id of ['n_split', 'n_heading', 'n_card', 'n_stack', 'n_para']) assert.equal(afterAll[id], undefined, `${id} went with it`);
assert.equal(await library(), libraryBefore, 'the Split and Card components stay in the library as they were');
await eventually(async () => assert.deepEqual(await history(), [...applied, 'Delete Split on Home'], 'one change'));
await eventually(async () => assert.deepEqual(await selected(), [], 'nothing that went is still selected'));
await toastFor('Deleted Split and 3 nested items').getByRole('button', { name: 'Undo' }).click();
await restored(applied, 'Delete Split on Home', 'one Undo restores the page exactly');
await frame.getByText('Inside the stack', { exact: true }).waitFor();

step('Remove wrapper & keep content, from the Layers menu, puts what the Split held in its place, selected, as one change');
await pickSplit();
applied = await history();
await row('n_split').click({ button: 'right' });
await menu.getByRole('menuitem', { name: /^Delete/ }).click();
await question.getByRole('button', { name: 'Remove wrapper & keep content', exact: true }).click();
await eventually(async () => assert.deepEqual(await content(), ['n_before', 'n_heading', 'n_card', 'n_stack', 'n_after'], 'its content takes its place, in order'));
await toastFor('Removed Split and kept 3 items').hover();
const kept = (await snapshot()).pages[pageId].nodes;
assert.equal(kept.n_split, undefined, 'the Split itself is gone');
const original = JSON.parse(before).nodes;
// The Card keeps its own background, and every kept node its ID, content and what it holds.
for (const id of ['n_heading', 'n_card', 'n_stack', 'n_para']) assert.deepEqual(kept[id], original[id], `${id} is kept as it was`);
assert.match(JSON.stringify(kept.n_card), /#e8f0ff/, 'the Card’s own style is among what it keeps');
assert.equal(await library(), libraryBefore, 'the library is as it was');
await eventually(async () => assert.deepEqual(await history(), [...applied, 'Remove Split on Home, keeping its content'], 'one change'));
await eventually(async () => assert.deepEqual(await selected(), ['n_heading'], 'the first of what took its place is selected'));
await frame.getByText('Inside the stack', { exact: true }).waitFor();
await win.screenshot({ path: join(SHOTS, 'delete-nested-kept.png') });
await toastFor('Removed Split and kept 3 items').getByRole('button', { name: 'Undo' }).click();
await restored(applied, 'Remove Split on Home, keeping its content', 'one Undo puts the Split back with its slots as they were');

step('an empty Section is deleted at once, with no question');
await row('n_empty').click();
await eventually(async () => assert.deepEqual(await selected(), ['n_empty']));
applied = await history();
await win.keyboard.press('Delete');
await eventually(async () => assert.ok(!(await snapshot()).pages[pageId].rootIds.includes('n_empty'), 'the empty Section is gone'));
assert.equal(await win.getByRole('dialog').count(), 0, 'nothing was asked');
await eventually(async () => assert.deepEqual(await history(), [...applied, 'Delete Section on Home'], 'one change'));
await toastFor('Deleted Section').waitFor();

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ndelete-nested-content: all checks passed');
