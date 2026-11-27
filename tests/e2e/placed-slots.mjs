// A placed component's Slots section in the Inspector (#654), against the real app. A card with several slots is
// selected on a page: each slot is listed in the order the card declares them, with what it takes and holds. Add on
// one slot offers only what it takes and inserts into that slot alone; at its limit, Add is off and says why. What a
// slot holds is a click away, and Move out and Clear are one Undo each. A component without slots shows no section.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, MOD, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('placed-slots');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Slot Rows', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => window.builder.project.snapshot());
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);

step('a card with Media, Actions, Body and Quiet slots in a Section, and a component with none');
const pageId = (await snapshot()).state.site.homePageId;
const page = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).state.pages[pageId];
const [{ definitionId: cardDef }] = await apply(
  [
    {
      type: 'component.upsert',
      name: 'Offer card',
      insertAs: 'element',
      properties: {},
      slots: {
        media: { label: 'Media', description: 'A picture above the words.', primitives: ['image'], max: 1 },
        actions: { label: 'Actions', primitives: ['link', 'text'], max: 2 },
        body: { label: 'Body' },
        quiet: { label: 'Quiet', max: 0 }
      },
      nodes: [
        // Placed in another order than they are declared, so only the declaration gives the order listed.
        { kind: 'element', id: 'root', tag: 'article', children: ['quiet', 'body', 'media', 'actions'] },
        { kind: 'slot', id: 'media', slot: 'media' },
        { kind: 'slot', id: 'actions', slot: 'actions' },
        { kind: 'slot', id: 'body', slot: 'body' },
        { kind: 'slot', id: 'quiet', slot: 'quiet' }
      ]
    }
  ],
  'Make Offer card'
);
const [{ definitionId: plainDef }] = await apply([{ type: 'component.upsert', name: 'Plain note', insertAs: 'element', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['words'] }, { kind: 'text', id: 'words', tag: 'p', text: 'Note' }] }], 'Make Plain note');
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner: page, parentId: null, componentId: 'layout.section' }], 'Add a Section');
const [{ nodeId: card }, { nodeId: plain }] = await apply(
  [
    { type: 'node.insert', owner: page, parentId: section, slot: 'content', definitionId: cardDef },
    { type: 'node.insert', owner: page, parentId: section, slot: 'content', definitionId: plainDef }
  ],
  'Place the cards'
);
const slotsOf = async (id) => (await home()).nodes[id].slots ?? {};
const held = async (slot) => (await slotsOf(card))[slot] ?? [];

await openInspector(win);
const inspector = win.locator('#dock-panel-inspect');
const name = inspector.locator('.insp-name h3');
const row = (slot) => inspector.locator(`[data-instance-slot="${slot}"]`);
const addTo = (label) => inspector.getByRole('button', { name: `Add to ${label}`, exact: true });
const list = win.getByTestId('quick-insert');
const offered = () => list.getByRole('option').locator('.qi-name').allInnerTexts();
const layer = (nodeId) => win.locator(`[role="tree"] [data-owner="page:${pageId}"][data-node="${nodeId}"]`);
const openLayers = async () => {
  if ((await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Layers"]').click();
};
/** Back to the card: through the Section's own Slots section, which lists it. */
const selectCard = async () => {
  await openLayers();
  await layer(section).click();
  await inspector.locator('[data-instance-slot="content"]').getByRole('button', { name: 'Select Offer card' }).click();
  await eventually(async () => assert.equal(await name.innerText(), 'Offer card'));
};
/** Wait for a change to have saved: `check` reads the page and its revision from one snapshot. */
const saved = (before, check) =>
  eventually(async () => {
    const now = await snapshot();
    check(now.state.pages[pageId].nodes);
    assert.equal(now.revision, before + 1, 'one change');
  }, 15000);
/** The editor has `nodeId` selected, with focus on its name in the Inspector. */
const arrived = async (nodeId) => {
  await openLayers();
  await eventually(async () => assert.equal(await layer(nodeId).getAttribute('aria-selected'), 'true', `${nodeId} is selected`), 15000);
  await focused(name, 'focus is on its name');
};
const focused = (locator, what) => eventually(async () => assert.equal(await locator.evaluate((el) => el === document.activeElement), true, what), 15000);
const undo = async () => {
  const at = (await snapshot()).revision;
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+z`);
  await eventually(async () => assert.notEqual((await snapshot()).revision, at, 'Undo takes a step'), 15000);
};

step('the Section lists its one slot, and what it holds leads to the card');
await openLayers();
await layer(section).click();
await eventually(async () => assert.match(await inspector.locator('.section-head', { hasText: 'Slots' }).innerText(), /1 slot$/));
await selectCard();

step('the card lists its slots in the order it declares them, with what each takes and holds');
assert.deepEqual(await inspector.locator('[data-instance-slot]').evaluateAll((els) => els.map((el) => el.dataset.instanceSlot)), ['media', 'actions', 'body', 'quiet']);
assert.deepEqual(await inspector.locator('[data-slot-contract]').allInnerTexts(), ['Takes images · At most 1', 'Takes buttons and text · At most 2', 'Takes anything · No limit']);
assert.deepEqual(await inspector.locator('[data-slot-count]').allInnerTexts(), ['Empty', 'Empty', 'Empty'], 'a slot that takes nothing says only that');
assert.match(await row('media').innerText(), /A picture above the words\./);
assert.equal(await addTo('Quiet').isDisabled(), true, 'a slot that takes nothing has no Add');
const describedBy = async (button) => win.locator(`[id="${await button.getAttribute('aria-describedby')}"]`).innerText();
assert.match(await row('quiet').innerText(), /This slot takes no content\./);
assert.equal(await describedBy(addTo('Quiet')), 'This slot takes no content.');
assert.equal(await inspector.getByRole('button', { name: /^Clear (all in )?Actions$/ }).count(), 0, 'nothing to clear while empty');

step('Add on Actions offers only what Actions takes, and inserts into it alone, in one change');
await addTo('Actions').click();
await list.waitFor();
await focused(list.getByRole('combobox'), 'the cursor is in its search');
assert.equal(await win.getByRole('dialog', { name: 'Add to Actions' }).count(), 1, 'the list is named for its slot');
assert.deepEqual((await offered()).sort(), ['Bulleted list', 'Button', 'Heading', 'Numbered list', 'Paragraph']);
await win.keyboard.press('Escape');
await list.waitFor({ state: 'detached' });
await focused(addTo('Actions'), 'Escape hands focus back to Add');
/** Add the first thing found by `words` from the open list. */
const choose = async (words) => {
  await focused(list.getByRole('combobox'), 'the cursor is in its search');
  await win.keyboard.type(words);
  await win.keyboard.press('Enter');
};
await addTo('Actions').click();
await list.waitFor();
let at = (await snapshot()).revision;
await choose('button');
await saved(at, (nodes) => assert.equal(nodes[card].slots?.actions?.length, 1));
const [button] = await held('actions');
assert.equal((await home()).nodes[button].kind, 'link');
assert.deepEqual(await slotsOf(card), { actions: [button] }, 'no other slot is touched');
await list.waitFor({ state: 'detached' });
await arrived(button);

step('at its limit, Add is off and says why');
await selectCard();
await addTo('Actions').click();
await list.waitFor();
at = (await snapshot()).revision;
await choose('paragraph');
await saved(at, (nodes) => assert.equal(nodes[card].slots?.actions?.length, 2));
const [, words] = await held('actions');
// The add selects the paragraph as its reply arrives: gone back only after that.
await arrived(words);
await selectCard();
await eventually(async () => assert.equal(await row('actions').locator('[data-slot-count]').innerText(), '2 of 2'));
assert.equal(await addTo('Actions').isDisabled(), true);
assert.equal(await describedBy(addTo('Actions')), 'Full. Take something out to add more.');
await win.screenshot({ path: join(SHOTS, 'placed-slots.png') });

step('an open list goes when the project changes under it, adding nothing, and focus returns to its Add');
await addTo('Body').click();
await list.waitFor();
await focused(list.getByRole('combobox'), 'the cursor is in its search');
await apply([{ type: 'node.rename', owner: page, nodeId: plain, name: 'Aside' }], 'Rename the note');
await list.waitFor({ state: 'detached' });
await focused(addTo('Body'), 'focus returns to Add');
assert.deepEqual(await held('body'), []);

step('when the change under an open list turns its Add off, focus goes to the selection’s name');
await addTo('Media').click();
await list.waitFor();
await focused(list.getByRole('combobox'), 'the cursor is in its search');
const [{ nodeId: picture }] = await apply([{ type: 'node.insert', owner: page, parentId: card, slot: 'media', primitive: 'image' }], 'Fill Media');
await list.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await addTo('Media').isDisabled(), true));
await focused(name, 'focus is not lost');

step('a second slot takes what is added to it, beside the full one, which is left as it was');
await addTo('Body').click();
await list.waitFor();
at = (await snapshot()).revision;
await choose('heading');
await saved(at, (nodes) => assert.equal(nodes[card].slots?.body?.length, 1));
const [heading] = await held('body');
assert.equal((await home()).nodes[heading].kind, 'text');
assert.deepEqual(await slotsOf(card), { actions: [button, words], media: [picture], body: [heading] });
await arrived(heading);

step('what a slot holds is a click away, each named as Layers names it');
const contents = row('actions').getByRole('list', { name: 'In Actions' }).getByRole('button');
await selectCard();
assert.deepEqual(await contents.allInnerTexts(), ['Button', 'Text · Write something here.']);
await contents.nth(1).click();
await arrived(words);
await selectCard();
await contents.nth(0).press('Enter');
await arrived(button);

step('Move out puts what Actions holds just after the card, in one Undo');
await selectCard();
const filled = await home();
at = (await snapshot()).revision;
await inspector.getByRole('button', { name: /^Move (all )?out of Actions$/ }).click();
await saved(at, (nodes) => {
  assert.deepEqual(nodes[section].slots.content, [card, button, words, plain]);
  assert.deepEqual(nodes[card].slots, { actions: [], media: [picture], body: [heading] });
});
await eventually(async () => assert.equal(await row('actions').locator('[data-slot-count]').innerText(), 'Empty'));
assert.equal(await name.innerText(), 'Offer card', 'the card stays selected');
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes, filled.nodes, 'one Undo puts it all back'));

step('Clear deletes what Actions holds, in one Undo');
await selectCard();
at = (await snapshot()).revision;
await inspector.getByRole('button', { name: /^Clear (all in )?Actions$/ }).click();
await saved(at, (nodes) => {
  assert.deepEqual(nodes[card].slots, { actions: [], media: [picture], body: [heading] });
  assert.equal(button in nodes || words in nodes, false, 'both are gone');
  assert.deepEqual(nodes[section].slots.content, [card, plain]);
});
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes, filled.nodes, 'one Undo puts it all back'));

step('a component with no slots shows no Slots section');
await openLayers();
await layer(section).click();
await inspector.locator('[data-instance-slot="content"]').getByRole('button', { name: 'Select Aside' }).click();
await eventually(async () => assert.equal(await name.innerText(), 'Aside'));
await inspector.locator('.section-head', { hasText: 'Content' }).first().waitFor();
assert.equal(await inspector.locator('.section-head', { hasText: 'Slots' }).count(), 0);
assert.equal(await inspector.locator('[data-instance-slot]').count(), 0);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nplaced-slots: passed');
