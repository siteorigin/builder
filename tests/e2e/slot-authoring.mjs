// Slot authoring in Component Studio (#655), against the real app. An author gives a project component a Buttons
// slot from the Inspector: declared and placed inside the selected container in one Undo. They rename it and choose
// what it takes and how many, Insert offers its placeholder again once it is taken out of the design, and the
// component placed on a page takes only what its slot allows. A tighter contract, or removing the slot, while the
// page holds content there is refused with the engine's reason, and that content stays.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, MOD, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('slot-authoring');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Slot Works', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => window.builder.project.snapshot());
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
/** The engine's refusal of a change, which must be refused. */
const refusal = (operations) =>
  win.evaluate(async (operations) => {
    const r = await window.builder.project.apply({ operations, label: 'Try' });
    return r.ok ? null : r.error?.message;
  }, operations);
const inspector = win.locator('#dock-panel-inspect');
const panel = win.locator('.side-panel-view:not([hidden])');
const band = win.locator('.mode-band');
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const expand = async (title) => {
  const head = inspector.locator('.section-head', { hasText: title }).first();
  await head.waitFor();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
};
const undoRedo = async (keys) => {
  const at = (await snapshot()).revision;
  await win.locator('.canvas').focus();
  await win.keyboard.press(keys);
  await eventually(async () => assert.notEqual((await snapshot()).revision, at, `${keys} takes a step`), 15000);
};

step('a project component with an empty Body, and no slots yet');
const [made] = await apply(
  [
    {
      type: 'component.upsert',
      name: 'Offer card',
      insertAs: 'element',
      properties: {},
      nodes: [
        { kind: 'element', id: 'root', tag: 'article', children: ['title', 'body'] },
        { kind: 'text', id: 'title', name: 'Title', tag: 'h3', text: 'Spring course' },
        { kind: 'element', id: 'body', name: 'Body', children: [] }
      ]
    }
  ],
  'Make Offer card'
);
const defId = made.definitionId;
const design = async () => (await snapshot()).state.components[defId];
const placeholders = (def) => Object.values(def.tree.nodes).filter((n) => n.kind === 'slot');
const inStudio = (sel) => frame.locator(`[data-so-ctx="preview:${defId}|preview"]${sel}`);

const openStudio = async () => {
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type('Offer card studio');
  await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
  await band.filter({ hasText: 'Offer card in Component Studio' }).waitFor();
  await inStudio('[data-so-node="root"]').first().waitFor({ timeout: 60000 });
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
};
await openStudio();
await openRail('Layers');
const row = (nodeId) => win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="${nodeId}"]`);
const selectRow = async (nodeId) => {
  if (await row(nodeId).isVisible()) await row(nodeId).click();
  else await inStudio(` [data-so-node="${nodeId}"]`).first().dispatchEvent('click');
  await eventually(async () => assert.equal(await row(nodeId).getAttribute('aria-selected'), 'true', `the ${nodeId} row is selected`), 15000);
};

step('Add slot declares Buttons and places it inside the selected Body, in one Undo');
await selectRow('body');
await expand('Slots');
await eventually(async () => assert.match(await inspector.locator('[data-slot-where]').innerText(), /goes inside Body/, 'the Inspector says where it goes'));
const before = await design();
assert.equal(before.slots, undefined, 'no slot is declared yet');
assert.deepEqual(before.tree.nodes.body.children, [], 'Body is empty');
await inspector.getByLabel('Name of the new slot').fill('Buttons');
await inspector.getByRole('button', { name: 'Add slot' }).click();
await eventually(async () => assert.deepEqual((await design()).slots, { buttons: { label: 'Buttons' } }, 'declared, taking anything'));
const added = await design();
{
  const [placeholder] = placeholders(added);
  assert.equal(placeholder?.slot, 'buttons', 'its placeholder is in the design');
  assert.deepEqual(added.tree.nodes.body.children, [placeholder.id], 'inside Body');
}
const slotGroup = inspector.locator('[data-slot="buttons"]');
await eventually(async () => assert.match(await slotGroup.innerText(), /Takes anything · No limit/, 'the section lists it'));
await undoRedo(`${MOD}+z`);
await eventually(async () => assert.deepEqual(await design(), before, 'one Undo takes back the slot and its placeholder'));
await undoRedo(`${MOD}+Shift+z`);
await eventually(async () => assert.deepEqual(await design(), added, 'Redo brings both back, where they were'));

step('its name, description, what it takes and how many save together, under the same name');
await selectRow('body');
await expand('Slots');
await slotGroup.getByRole('button', { name: 'Edit Buttons' }).click();
const form = inspector.locator('[data-slot-form="buttons"]');
await form.getByLabel('Name', { exact: true }).fill('Actions');
await form.getByLabel('What belongs there').fill('A short call to action');
await form.getByRole('radio', { name: 'Only what’s checked' }).click();
await form.getByRole('checkbox', { name: 'Media', exact: true }).check();
await form.getByRole('checkbox', { name: 'Text', exact: true }).check();
await form.getByLabel('Holds at most').fill('1');
const configuring = (await snapshot()).revision;
await form.getByRole('button', { name: 'Save' }).click();
await eventually(async () =>
  assert.deepEqual((await design()).slots, { buttons: { label: 'Actions', description: 'A short call to action', categories: ['media'], primitives: ['text'], max: 1 } }, 'saved')
);
assert.equal((await snapshot()).revision, configuring + 1, 'in one change');
await form.waitFor({ state: 'detached' });
await eventually(async () => assert.match(await inspector.locator('[data-slot="buttons"]').innerText(), /Takes media components and text · At most 1/));

step('Insert offers the placeholder of a slot the design no longer shows, and only then');
await openRail('Insert');
const slotTile = panel.locator('.insert-group[data-group="slots"] [data-key$=":buttons"]');
assert.equal(await panel.locator('.insert-group[data-group="slots"]').count(), 0, 'nothing to offer while it is placed');
await apply([{ type: 'node.remove', owner: { kind: 'component', id: defId }, nodeId: placeholders(await design())[0].id }], 'Take the placeholder out');
await slotTile.waitFor();
assert.match(await slotTile.innerText(), /Actions slot/, 'named for the slot');
// With a heading picked, it goes where Add slot would put it: inside the whole design, not beside the heading.
await openRail('Layers');
await selectRow('title');
await openRail('Insert');
await eventually(async () => assert.match(await win.locator(`[id="${await slotTile.getAttribute('aria-describedby')}"]`).textContent(), /^Goes inside Container$/, 'the tile says where it goes'));
await slotTile.click();
await eventually(async () => {
  const def = await design();
  const [placeholder] = placeholders(def);
  assert.equal(placeholder?.slot, 'buttons', 'placed again');
  assert.deepEqual(def.tree.nodes.root.children, ['title', 'body', placeholder.id], 'at the end of the whole design');
  assert.deepEqual(def.tree.nodes.body.children, [], 'not in Body');
});
await panel.locator('.insert-group[data-group="slots"]').waitFor({ state: 'detached' });
await win.screenshot({ path: join(SHOTS, 'slot-authoring-studio.png') });
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });

step('placed on a page, the slot takes one paragraph and nothing else');
const pageId = (await snapshot()).state.site.homePageId;
const page = { kind: 'page', id: pageId };
await openRail('Insert');
await panel.locator(`[data-key="c:${defId}"]`).first().click();
let instance;
await eventually(async () => {
  instance = Object.values((await snapshot()).state.pages[pageId].nodes).find((n) => n.kind === 'instance' && n.definitionId === defId);
  assert.ok(instance, 'the card is on the page');
}, 15000);
const [{ nodeId: words }] = await apply([{ type: 'node.insert', owner: page, parentId: instance.id, slot: 'buttons', primitive: 'paragraph', text: 'Book your place' }], 'Fill the slot');
const held = async () => (await snapshot()).state.pages[pageId].nodes[instance.id].slots?.buttons;
assert.deepEqual(await held(), [words], 'the slot holds the paragraph');
assert.match(await refusal([{ type: 'node.insert', owner: page, parentId: instance.id, slot: 'buttons', primitive: 'image' }]), /“Actions” slot of “Offer card” takes media components and text, not an image/, 'an image is refused');
assert.match(await refusal([{ type: 'node.insert', owner: page, parentId: instance.id, slot: 'buttons', primitive: 'paragraph' }]), /holds at most one item/, 'a second paragraph is refused');
await eventually(async () => assert.equal(await frame.getByText('Book your place', { exact: true }).count(), 1, 'the page shows the slot’s content, once'), 30000);
const wordsNode = (await snapshot()).state.pages[pageId].nodes[words];

step('a tighter contract, or removing the slot, is refused with the engine’s reason, and the content stays');
await openStudio();
await openRail('Layers');
await selectRow('root');
await expand('Slots');
await eventually(async () => assert.match(await inspector.locator('[data-slot="buttons"]').innerText(), /Holds content on Home/, 'the section says where it holds content'));
await inspector.locator('[data-slot="buttons"]').getByRole('button', { name: 'Edit Actions' }).click();
await form.getByLabel('Holds at most').fill('0');
await form.getByRole('button', { name: 'Save' }).click();
await win.locator('.toast.error', { hasText: /Home: the “Actions” slot already holds more than 0\. Move some of it out first\./ }).waitFor();
assert.equal(await form.getByLabel('Holds at most').inputValue(), '0', 'the form keeps what was chosen');
assert.equal((await design()).slots.buttons.max, 1, 'the contract is unchanged');
assert.deepEqual(await held(), [words], 'and so is the page’s content');
assert.deepEqual((await snapshot()).state.pages[pageId].nodes[words], wordsNode, 'word for word');
await form.getByRole('button', { name: 'Cancel' }).click();
await inspector.locator('[data-slot="buttons"]').getByRole('button', { name: 'Remove Actions' }).click();
await win.locator('.toast.error', { hasText: /The "Actions" slot has content in 1 place \(Home\)\. Move or remove it first\./ }).waitFor();
assert.ok((await design()).slots?.buttons, 'the slot stays');
assert.deepEqual(await held(), [words], 'with its content');
assert.deepEqual((await snapshot()).state.pages[pageId].nodes[words], wordsNode, 'word for word');

step('once the page’s content is gone, the slot goes with its placeholder');
await apply([{ type: 'node.remove', owner: page, nodeId: words }], 'Empty the slot');
await eventually(async () => assert.match(await inspector.locator('[data-slot="buttons"]').innerText(), /Empty on every placement/));
await inspector.locator('[data-slot="buttons"]').getByRole('button', { name: 'Remove Actions' }).click();
await eventually(async () => {
  const def = await design();
  assert.equal(def.slots, undefined, 'no slot is declared');
  assert.equal(placeholders(def).length, 0, 'and no placeholder is left');
  assert.deepEqual(def.tree.nodes.root.children, ['title', 'body'], 'nor a trace of it in the design');
  assert.equal((await snapshot()).state.pages[pageId].nodes[instance.id].slots?.buttons, undefined, 'or on the page');
});
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nslot-authoring: passed');
