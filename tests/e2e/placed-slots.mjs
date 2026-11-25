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
        { kind: 'element', id: 'root', tag: 'article', children: ['media', 'actions', 'body', 'quiet'] },
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
const undo = async () => {
  const at = (await snapshot()).revision;
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+z`);
  await eventually(async () => assert.notEqual((await snapshot()).revision, at, 'Undo takes a step'), 15000);
};

step('the Section lists its one slot, and what it holds leads to the card');
await selectCard();

step('the card lists its slots in the order it declares them, with what each takes and holds');
assert.deepEqual(await inspector.locator('[data-instance-slot]').evaluateAll((els) => els.map((el) => el.dataset.instanceSlot)), ['media', 'actions', 'body', 'quiet']);
assert.deepEqual(await inspector.locator('[data-slot-contract]').allInnerTexts(), ['Takes images · At most 1', 'Takes buttons and text · At most 2', 'Takes anything · No limit', 'Takes nothing']);
assert.deepEqual(await inspector.locator('[data-slot-count]').allInnerTexts(), ['Empty', 'Empty', 'Empty', 'Empty']);
assert.match(await row('media').innerText(), /A picture above the words\./);
assert.equal(await addTo('Quiet').isDisabled(), true, 'a slot that takes nothing has no Add');
assert.match(await row('quiet').innerText(), /This slot takes no content\./);
assert.equal(await inspector.getByRole('button', { name: 'Clear Actions', exact: true }).count(), 0, 'nothing to clear while empty');

step('Add on Actions offers only what Actions takes, and inserts into it alone, in one change');
await addTo('Actions').click();
await list.waitFor();
assert.equal(await list.getAttribute('aria-label'), 'Add to Actions');
assert.deepEqual((await offered()).sort(), ['Bulleted list', 'Button', 'Heading', 'Numbered list', 'Paragraph']);
await win.keyboard.press('Escape');
await list.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await addTo('Actions').evaluate((el) => el === document.activeElement), true, 'Escape hands focus back to Add'));
await addTo('Actions').click();
await list.waitFor();
const before = (await snapshot()).revision;
await win.keyboard.type('button');
await win.keyboard.press('Enter');
await eventually(async () => assert.equal((await held('actions')).length, 1));
assert.equal((await snapshot()).revision, before + 1, 'one change');
const [button] = await held('actions');
assert.equal((await home()).nodes[button].kind, 'link');
assert.deepEqual(Object.keys(await slotsOf(card)), ['actions'], 'no other slot is touched');
await list.waitFor({ state: 'detached' });
// What was added is selected, with focus on its name.
await eventually(async () => assert.equal(await name.evaluate((el) => el === document.activeElement), true, 'focus follows to the new button'));

step('at its limit, Add is off and says why');
await selectCard();
await addTo('Actions').click();
await list.waitFor();
await win.keyboard.type('paragraph');
await win.keyboard.press('Enter');
await eventually(async () => assert.equal((await held('actions')).length, 2));
const [, words] = await held('actions');
// The add selects the paragraph as its reply arrives: gone back only after that.
await eventually(async () => assert.equal(await name.evaluate((el) => el === document.activeElement && el.textContent !== 'Offer card'), true, 'the paragraph is selected'));
await selectCard();
await eventually(async () => assert.equal(await row('actions').locator('[data-slot-count]').innerText(), '2 items'));
assert.equal(await addTo('Actions').isDisabled(), true);
const why = await addTo('Actions').getAttribute('aria-describedby');
assert.equal(await win.locator(`[id="${why}"]`).innerText(), 'Full: it holds at most 2 items. Take something out to add more.');
await win.screenshot({ path: join(SHOTS, 'placed-slots.png') });

step('an open list goes when the project changes under it, adding nothing');
await addTo('Body').click();
await list.waitFor();
await apply([{ type: 'node.rename', owner: page, nodeId: plain, name: 'Aside' }], 'Rename the note');
await list.waitFor({ state: 'detached' });
assert.deepEqual(await held('body'), []);

step('what a slot holds is a click away, each named as Layers names it');
const contents = row('actions').getByRole('list', { name: 'In Actions' }).getByRole('button');
assert.deepEqual(await contents.allInnerTexts(), ['Button · Button', 'Text · Write something here.']);
await contents.nth(1).click();
await openLayers();
await eventually(async () => assert.equal(await layer(words).getAttribute('aria-selected'), 'true', 'the paragraph is selected'), 15000);
await eventually(async () => assert.equal(await name.evaluate((el) => el === document.activeElement), true, 'with focus on its name'));

step('Move out puts what Actions holds just after the card, in one Undo');
await selectCard();
const filled = await home();
let at = (await snapshot()).revision;
await inspector.getByRole('button', { name: 'Move Actions content out', exact: true }).click();
await eventually(async () => assert.deepEqual((await slotsOf(section)).content, [card, button, words, plain]));
assert.deepEqual(await held('actions'), []);
assert.equal((await snapshot()).revision, at + 1, 'one change');
assert.equal(await name.innerText(), 'Offer card', 'the card stays selected');
await eventually(async () => assert.equal(await row('actions').locator('[data-slot-count]').innerText(), 'Empty'));
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes, filled.nodes, 'one Undo puts it all back'));

step('Clear deletes what Actions holds, in one Undo');
await selectCard();
at = (await snapshot()).revision;
await inspector.getByRole('button', { name: 'Clear Actions', exact: true }).click();
await eventually(async () => assert.deepEqual(await held('actions'), []));
assert.equal((await snapshot()).revision, at + 1, 'one change');
assert.equal(button in (await home()).nodes || words in (await home()).nodes, false, 'both are gone');
assert.deepEqual((await slotsOf(section)).content, [card, plain]);
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
