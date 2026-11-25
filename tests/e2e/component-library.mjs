// The component library in Insert > Your components, against the real app (#56): Make unique asks for a name and
// never stacks "(unique)", each tile says how often it is used, and its menu renames it, lists and shows where it
// is placed, and deletes it once unused, with Undo bringing it back (one still in use opens a review of where, #663).
// A component is also shown on its own, in an isolated preview, whether or not any page places it (#347), and that
// preview never reaches the site's files.
// Each component's tile shows a thumbnail photographed from that preview, drawn again when the component's style or
// the site's brand changes and kept in the editor's cache, never in an export (#370).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('component-library');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Expo Hall', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
/** Project components by name, each with how many times it is placed. */
const library = async () => {
  const st = await snapshot();
  const uses = {};
  const trees = [st.site.shell.header, st.site.shell.footer, ...Object.values(st.pages), ...Object.values(st.components).map((d) => d.tree).filter(Boolean)];
  for (const t of trees) for (const n of Object.values(t.nodes)) if (n.kind === 'instance') uses[n.definitionId] = (uses[n.definitionId] ?? 0) + 1;
  return Object.fromEntries(Object.values(st.components).filter((d) => d.owner === 'project').map((d) => [d.name, uses[d.id] ?? 0]));
};
const panel = win.locator('.side-panel-view:not([hidden])');
const tile = (name) => panel.locator('.insert-tile.project', { has: win.locator('strong', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) });
const manage = (name) => panel.getByRole('button', { name: `Manage ${name}`, exact: true });
const menu = win.getByRole('menu');
const dialog = win.getByRole('dialog');
const openInsert = async () => {
  const group = panel.locator('.insert-group[data-kind="component"]');
  // The rail button toggles the panel, so it is pressed only while Insert is closed.
  if (!(await group.isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await group.waitFor();
};
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const componentSection = async () => {
  const head = win.locator('#dock-panel-inspect .section-head', { hasText: 'Component' });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
};

const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };

step('Create component starts a blank one without Developer mode, opens its design, and one Undo takes it back (#172)');
assert.equal((await win.evaluate(() => window.builder.app.getSettings())).developerMode, false, 'Developer mode is off');
const homeBefore172 = (await snapshot()).pages[pageId];
await openInsert();
await panel.locator('.insert-tile.new[data-key="new-component"]', { hasText: 'Create component' }).click();
await dialog.getByLabel('Component name').fill('Price tag');
await dialog.getByLabel('Description').fill('One plan and its price.');
await dialog.getByRole('button', { name: 'Start blank' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.deepEqual(await library(), { 'Price tag': 1 }, 'the component is made and placed once'));
const priceTag = Object.values((await snapshot()).components).find((d) => d.name === 'Price tag');
assert.equal(priceTag.kind, 'managed', 'a managed design');
assert.equal(priceTag.description, 'One plan and its price.');
// Its design is open for editing, with its root selected in Layers, ready for elements.
await win.locator('.mode-band', { hasText: 'Editing Price tag everywhere' }).waitFor();
await openRail('Layers');
await eventually(async () => assert.equal(await win.locator(`[role="treeitem"][data-owner="component:${priceTag.id}"][data-node="${priceTag.tree.rootIds[0]}"]`).getAttribute('aria-selected'), 'true', 'Layers selects the new design’s root'));
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });
await win.evaluate(() => window.builder.project.undo());
await eventually(async () => assert.deepEqual(await library(), {}, 'one Undo removes the component'));
assert.deepEqual((await snapshot()).pages[pageId], homeBefore172, 'and its placement');
// The command menu offers the same dialog.
await win.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+K`);
await win.locator('.cmdk').waitFor();
await win.keyboard.type('create component');
await win.locator('.cmdk [role="option"]', { hasText: 'Create component…' }).first().click();
await dialog.getByLabel('Component name').waitFor();
await dialog.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'detached' });
assert.deepEqual(await library(), {}, 'Cancel makes nothing');
// Build with AI with no AI provider set up: the request waits in the chat to be sent or discarded, never lost, and never
// sent anywhere (this check stops before the click if a provider were set up).
const ai = await win.evaluate(async () => ({ settings: await window.builder.app.getSettings(), providers: await window.builder.ai.providers() }));
assert.equal(ai.providers.find((p) => p.id === ai.settings.ai.provider)?.configured ?? false, false, 'no AI provider is set up');
await openInsert();
await panel.locator('.insert-tile.new[data-key="new-component"]').click();
await dialog.getByLabel('Component name').fill('Quote card');
await dialog.getByRole('button', { name: 'Build with AI' }).click();
await dialog.waitFor({ state: 'detached' });
const held = win.locator('.held-request', { hasText: 'Create a component called "Quote card".' });
await held.waitFor();
await held.getByRole('button', { name: 'Discard' }).click();
await held.waitFor({ state: 'detached' });
assert.deepEqual(await library(), {}, 'nothing is made');

step('an Exhibitor card made from a group, and a second copy from Insert');
// Blank's Home starts empty: a section to build in first.
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, componentId: 'layout.section' }], 'Insert section');
const [{ nodeId: stack }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }], 'Insert stack');
await apply([{ type: 'node.insert', owner, parentId: stack, primitive: 'heading', text: 'Exhibitor' }], 'Insert heading');
const [{ nodeId: first }] = await apply([{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Exhibitor card' }], 'Create component');
await openInsert();
await eventually(async () => assert.match(await tile('Exhibitor card').innerText(), /Used once/, 'the tile says how often the card is used'));
await tile('Exhibitor card').click();
await eventually(async () => assert.deepEqual(await library(), { 'Exhibitor card': 2 }, 'clicking the tile still inserts a copy'));
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Exhibitor card' }).waitFor();

step('Make unique asks for a name: Cancel changes nothing, a chosen name is kept');
await componentSection();
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Make unique…' }).click();
const nameField = dialog.getByLabel('Name for the copy');
assert.equal(await nameField.inputValue(), 'Exhibitor card (unique)', 'the dialog suggests a name');
assert.equal(await nameField.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), 'Exhibitor card (unique)', 'the suggestion is selected, so typing replaces it');
await dialog.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'detached' });
assert.deepEqual(await library(), { 'Exhibitor card': 2 }, 'Cancel makes no copy');
await win.getByRole('button', { name: 'More actions for Exhibitor card' }).click();
await menu.getByRole('menuitem', { name: /Make unique…/ }).click();
await nameField.fill('Exhibitor card blue');
await nameField.press('Enter');
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.deepEqual(await library(), { 'Exhibitor card': 1, 'Exhibitor card blue': 1 }, 'the copy takes the chosen name'));

step('accepting suggestions twice never stacks "(unique)"');
for (const expected of ['Exhibitor card blue (unique)', 'Exhibitor card blue (unique 2)']) {
  await componentSection();
  await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Make unique…' }).click();
  assert.equal(await nameField.inputValue(), expected, 'the suggestion is numbered rather than stacked');
  await dialog.getByRole('button', { name: 'Make unique' }).click();
  await dialog.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal((await library())[expected], 1, `${expected} is made`));
}
assert.deepEqual(await library(), { 'Exhibitor card': 1, 'Exhibitor card blue': 0, 'Exhibitor card blue (unique)': 0, 'Exhibitor card blue (unique 2)': 1 });

step('each tile says how often it is used, and its menu is one arrow key away');
await openInsert();
await eventually(async () => assert.match(await tile('Exhibitor card blue').innerText(), /Not used/, 'an unused variant says so'));
assert.match(await tile('Exhibitor card blue (unique 2)').innerText(), /Used once/);
await tile('Exhibitor card blue').focus();
await win.keyboard.press('ArrowRight');
await eventually(async () => assert.equal(await manage('Exhibitor card blue').evaluate((el) => el === document.activeElement), true, 'ArrowRight moves from the tile to its menu button'));
await win.keyboard.press('Enter');
await menu.waitFor();
assert.ok(await menu.getByText('Not used anywhere').isVisible(), 'the menu says the variant is not used');
assert.equal(await menu.getByRole('menuitem', { name: /Delete component/ }).getAttribute('aria-disabled'), null, 'an unused variant can be deleted');
await win.keyboard.press('Escape');
await menu.waitFor({ state: 'detached' });

step('usage locations show where a component is placed, and deleting a used one reviews where instead');
// A second page with its own card below the fold, so choosing a location has to switch pages and scroll there.
const [{ pageId: floor }] = await apply([{ type: 'page.create', title: 'Floor plan', starter: 'intro' }], 'Add page');
const card = Object.values((await snapshot()).components).find((d) => d.name === 'Exhibitor card').id;
await apply([...Array(4)].map(() => ({ type: 'node.insert', owner: { kind: 'page', id: floor }, componentId: 'content.text' })), 'Insert text sections');
const [{ nodeId: onFloor }] = await apply([{ type: 'node.insert', owner: { kind: 'page', id: floor }, definitionId: card }], 'Insert Exhibitor card');
await manage('Exhibitor card').click();
await menu.waitFor();
assert.ok(await menu.getByText('Used 2 times').isVisible(), 'the menu counts the placements');
await win.waitForTimeout(300);
await win.screenshot({ path: join(SHOTS, 'component-library-menu.png'), clip: { x: 0, y: 180, width: 420, height: 300 } });
// A used component is not deleted: Delete component reviews where it is used, with a way to each placement (#663).
await menu.getByRole('menuitem', { name: /Delete component/ }).click();
const removal = win.locator('.modal[role="dialog"]', { hasText: 'Delete Exhibitor card?' });
await removal.waitFor();
assert.match(await removal.innerText(), /It is still in use\./, 'the review says why it stays');
assert.equal(await removal.getByRole('button', { name: /^Go to placement/ }).count(), 2, 'it lists both placements');
assert.equal(await removal.getByRole('button', { name: 'Delete component' }).count(), 0, 'and offers no deletion while they stay');
await removal.getByRole('button', { name: 'Go to placement: Floor plan' }).click();
await removal.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${onFloor}"]`).getAttribute('aria-selected'), 'true', 'going to a placement on another page opens it and selects the placement there'));
assert.ok((await snapshot()).components[card], 'the component stays');
await eventually(async () => {
  const box = await frame.locator(`[data-so-ctx$="|${onFloor}"]`).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: innerHeight };
  });
  assert.ok(box.top > 0 && box.top < box.height, `the preview scrolls to the placement on the new page (${JSON.stringify(box)})`);
});
await manage('Exhibitor card').click();
await menu.getByRole('menuitem', { name: (await snapshot()).pages[pageId].title }).click();
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${first}"]`).getAttribute('aria-selected'), 'true', 'and back to the first page'));

step('Rename gives a variant a descriptive name and a description');
await openInsert();
await manage('Exhibitor card blue (unique 2)').click();
await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
const renameField = dialog.getByLabel('Component name');
assert.equal(await renameField.inputValue(), 'Exhibitor card blue (unique 2)');
await renameField.fill('Exhibitor card gold sponsor');
await dialog.getByLabel('Description').fill('For gold sponsors on the floor plan');
await dialog.getByRole('button', { name: 'Rename' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await library())['Exhibitor card gold sponsor'], 1, 'the placement keeps the renamed component'));
const gold = Object.values((await snapshot()).components).find((d) => d.name === 'Exhibitor card gold sponsor');
assert.equal(gold.description, 'For gold sponsors on the floor plan');
await tile('Exhibitor card gold sponsor').waitFor();

step('deleting an unused variant keeps the others, and Undo brings it back');
const before = await snapshot();
const blue = Object.values(before.components).find((d) => d.name === 'Exhibitor card blue');
await manage('Exhibitor card blue').click();
await menu.getByRole('menuitem', { name: /Delete component/ }).click();
const undo = win.locator('.toast', { hasText: 'Deleted Exhibitor card blue' }).getByRole('button', { name: 'Undo' });
await undo.waitFor();
const after = await snapshot();
assert.equal(after.components[blue.id], undefined, 'the variant is deleted');
assert.deepEqual(Object.keys(after.components).sort(), Object.keys(before.components).filter((id) => id !== blue.id).sort(), 'only the deleted variant goes');
assert.deepEqual(after.pages, before.pages, 'the pages and their placements are untouched');
await tile('Exhibitor card blue').waitFor({ state: 'detached' });
await eventually(async () => assert.ok(await win.evaluate(() => !!document.activeElement?.closest('.insert-panel')), 'focus stays in the Insert panel once the row has gone'));
await undo.click();
await eventually(async () => assert.deepEqual((await snapshot()).components[blue.id], blue, 'Undo restores the same variant'));
await tile('Exhibitor card blue').waitFor();

step('a Section holding content becomes a component from its Layers row, and a copy shows that content (#173)');
const [{ nodeId: band }] = await apply([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }], 'Insert section');
const filled = await apply(
  [
    { type: 'node.insert', owner, parentId: band, slot: 'content', primitive: 'heading', text: 'Visit the hall' },
    { type: 'node.insert', owner, parentId: band, slot: 'content', primitive: 'paragraph', text: 'Open daily from nine.' }
  ],
  'Fill section'
);
const homeBefore = (await snapshot()).pages[pageId];
await openRail('Layers');
await win.locator(`[role="tree"] [data-node="${band}"]`).click({ button: 'right' });
await menu.getByRole('menuitem', { name: /^Create component/ }).click();
await dialog.getByLabel('Component name').fill('Hall hours band');
await dialog.getByLabel('Component name').press('Enter');
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await library())['Hall hours band'], 1, 'the section is now a placement of the new component'));
// The canvas finds the placement by the section it renders, so the new selection keeps its outline and chip.
await eventually(async () => assert.match(await win.locator('.ov-chip .label').first().innerText(), /Hall hours band/, 'the canvas chip names the new placement'), 30000);
const hall = Object.values((await snapshot()).components).find((d) => d.name === 'Hall hours band');
const homeNodes = (await snapshot()).pages[pageId].nodes;
for (const id of [band, ...filled.map((r) => r.nodeId)]) assert.equal(homeNodes[id], undefined, 'the section and its content moved into the component');
assert.equal(hall.tree.nodes[hall.tree.rootIds[0]].slots.content.length, 2, 'the component holds the section’s content');
await openInsert();
// The library lists four components until it is asked for the rest; this is the fifth.
const showAll = panel.getByRole('button', { name: /^Show all \d+ components\b/ });
if (await showAll.count()) await showAll.click();
await tile('Hall hours band').click();
await eventually(async () => assert.equal((await library())['Hall hours band'], 2, 'a second copy is placed from Insert'));
await eventually(async () => assert.equal(await frame.locator('h2', { hasText: 'Visit the hall' }).count(), 2, 'both copies show the heading'), 30000);
assert.equal(await frame.locator('p', { hasText: 'Open daily from nine.' }).count(), 2, 'and the paragraph');
await win.evaluate(() => window.builder.project.undo());
await win.evaluate(() => window.builder.project.undo());
await eventually(async () => assert.deepEqual((await snapshot()).pages[pageId], homeBefore, 'one Undo after the copy puts the section and its content back'));
assert.equal((await snapshot()).components[hall.id], undefined, 'and removes the component');

step('a single heading becomes a component from its Layers row, with one part, and a second goes beside it (#185)');
// A second Section after it, so a copy that ignored the selection would land there instead.
const [{ nodeId: notice }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ],
  'Insert sections'
);
const [{ nodeId: floorHeading }] = await apply([{ type: 'node.insert', owner, parentId: notice, slot: 'content', primitive: 'heading', text: 'Floor plan' }], 'Add heading');
const pageBefore185 = (await snapshot()).pages[pageId];
await openRail('Layers');
await win.locator(`[role="tree"] [data-node="${notice}"] .tree-toggle`).click();
await win.locator(`[role="tree"] [data-node="${floorHeading}"]`).click({ button: 'right' });
await menu.getByRole('menuitem', { name: /^Create component/ }).click();
await dialog.getByLabel('Component name').fill('Floor plan title');
await dialog.getByLabel('Component name').press('Enter');
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await library())['Floor plan title'], 1, 'the heading is now a placement of the new component'));
const titleDef = Object.values((await snapshot()).components).find((d) => d.name === 'Floor plan title');
assert.deepEqual(Object.keys(titleDef.parts), ['root'], 'the heading is the component itself: one part, not a second on the same element');
assert.equal(titleDef.insertAs, 'element', 'made inside a section, it inserts as an element');
const inNotice = async () => (await snapshot()).pages[pageId].nodes[notice].slots.content;
assert.equal((await snapshot()).pages[pageId].nodes[(await inNotice())[0]].definitionId, titleDef.id, 'the placement takes the heading’s place in its section');
await eventually(async () => assert.equal(await frame.locator('h2', { hasText: 'Floor plan' }).count(), 1, 'and shows the heading'), 30000);
await openInsert();
if (await showAll.count()) await showAll.click();
await tile('Floor plan title').click();
await eventually(async () => {
  const content = await inNotice();
  assert.equal(content.length, 2, 'a second copy goes into the same section');
  assert.equal((await snapshot()).pages[pageId].nodes[content[1]].definitionId, titleDef.id);
  assert.deepEqual((await snapshot()).pages[pageId].rootIds, pageBefore185.rootIds, 'nothing new at the top of the page');
});
await win.evaluate(() => window.builder.project.undo());
await win.evaluate(() => window.builder.project.undo());
await eventually(async () => assert.deepEqual((await snapshot()).pages[pageId], pageBefore185, 'two Undos put the heading back'));

step('an unplaced component is shown on its own, at any width (#347)');
/** Show components in isolated preview frames in the editor, step by step, and give back what each reported. */
const preview = (steps) => withTimeout(win.evaluate((s) => window.builderTest.previewComponent(s), steps), 180000, 'Component preview');
const ready = (r, what) => {
  assert.equal(r.state, 'ready', `${what}: ${r.error}`);
  assert.deepEqual(r.report.runtimeErrors, [], `${what}: no errors in the preview`);
  assert.ok(r.bounds && r.bounds.width > 0 && r.bounds.height > 0, `${what}: the component takes up room (${JSON.stringify(r.bounds)})`);
  return r;
};
const blueDef = Object.values((await snapshot()).components).find((d) => d.name === 'Exhibitor card blue');
assert.equal((await library())['Exhibitor card blue'], 0, 'the card is placed nowhere');
const [alone] = await preview([{ spec: { definitionId: blueDef.id }, width: 437 }]);
ready(alone, 'an unplaced project component');
assert.equal(alone.definitionId, blueDef.id);
assert.equal(alone.report.viewportWidth, 437, 'it is shown at exactly the width asked for');
assert.ok(alone.bounds.width <= 437, 'and fits it');
assert.equal(alone.text, 'Exhibitor', 'it shows the component alone: no header, footer or page around it');

step('sample values and each variant of a catalogue component, in two frames at once');
const componentsBefore = Object.keys((await snapshot()).components).sort();
const grid = (frame, layout, heading, width = 1280) => ({ frame, width, spec: { componentId: 'features.grid', variants: { layout }, props: { heading } } });
const [two, four, other, twoAgain, narrow] = await preview([
  grid(0, 'two-columns', 'Two up'),
  grid(0, 'four-columns', 'Four up'),
  grid(1, 'two-columns', 'Other frame'),
  grid(0, 'two-columns', 'Two up'),
  grid(0, 'four-columns', 'Four up', 437)
]);
for (const [r, what] of [[two, 'two columns'], [four, 'four columns'], [other, 'a second frame'], [twoAgain, 'the first frame again'], [narrow, 'a narrow width']]) ready(r, what);
assert.match(two.text, /Two up/, 'the sample heading is shown');
assert.match(four.text, /Four up/);
assert.match(other.text, /Other frame/);
assert.doesNotMatch(other.text, /Two up|Four up/, 'each frame shows its own preview');
assert.match(twoAgain.text, /Two up/);
assert.ok(two.bounds.height > four.bounds.height + 40, `two columns put the three cards on two rows, four on one (${two.bounds.height} vs ${four.bounds.height})`);
assert.equal(twoAgain.bounds.height, two.bounds.height, 'the same choices show the same layout');
assert.equal(narrow.report.viewportWidth, 437);
assert.ok(narrow.bounds.width <= 437 && narrow.bounds.height > four.bounds.height, 'at a phone width the cards stack, whatever the layout chosen');
assert.deepEqual(Object.keys((await snapshot()).components).sort(), componentsBefore, 'previewing a catalogue component never adds it to the project');

step('a code component with its variant and sample values, and a component that does not exist');
const NOTE = `<script>\n\tlet { title = 'Hello', variant = 'plain', class: className = '' } = $props();\n</script>\n\n<p class="sample sample--{variant} {className}">{title}</p>\n\n<style>\n\t.sample { margin: 0; font-size: 16px; line-height: 1.25; }\n\t.sample--loud { font-size: 48px; }\n</style>\n`;
await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
const [{ definitionId: note }] = await apply([{ type: 'component.createCode', name: 'Sample note', source: NOTE, properties: { title: { type: 'string', label: 'Title', default: 'Hello' } } }], 'Create code component');
await apply(
  [
    { type: 'component.setVariant', definitionId: note, axis: 'tone', axisLabel: 'Tone', variant: 'plain', label: 'Plain', makeDefault: true },
    { type: 'component.setVariant', definitionId: note, axis: 'tone', variant: 'loud', label: 'Loud' }
  ],
  'Add tones'
);
const [plain, loud, missing] = await preview([
  { spec: { definitionId: note, props: { title: 'Quiet words' } }, width: 437 },
  { spec: { definitionId: note, variants: { tone: 'loud' }, props: { title: 'Loud words' } }, width: 437 },
  { spec: { definitionId: 'no-such-component' }, width: 437 }
]);
ready(plain, 'a code component');
ready(loud, 'its loud variant');
assert.equal(plain.text, 'Quiet words');
assert.equal(loud.text, 'Loud words');
assert.ok(loud.bounds.height > plain.bounds.height * 2, `the loud variant is styled as loud (${loud.bounds.height} vs ${plain.bounds.height})`);
assert.equal(missing.state, 'error');
assert.match(missing.error, /no component "no-such-component"/);
const BROKEN = `<script>\n\tlet { class: className = '' } = $props();\n\tthrow new Error('Boom while mounting');\n</script>\n\n<p class={className}>Never shown</p>\n`;
const [{ definitionId: broken }] = await apply([{ type: 'component.createCode', name: 'Broken note', source: BROKEN }], 'Create a broken component');
const [failed] = await preview([{ spec: { definitionId: broken }, width: 437 }]);
assert.equal(failed.state, 'error', 'a component that throws while mounting is reported, not shown');
assert.match(failed.error, /Boom while mounting/, 'with the reason it gave');
await apply([{ type: 'component.remove', definitionId: broken }], 'Remove the broken component');

step('each component in Your components shows a thumbnail, drawn again when its style changes (#370)');
const projectDir = await win.evaluate(async () => (await window.builder.project.snapshot()).dir);
const thumbsDir = join(projectDir, '.siteorigin/cache/thumbs');
const captures = () => win.evaluate(() => window.builderTest.thumbCaptures());
const thumb = (name) => tile(name).locator('.component-thumb');
/** The picture a tile shows (a data URL), once it shows one. */
const picture = async (name) => {
  const img = thumb(name).locator('img.insert-shot');
  await img.waitFor({ timeout: 90000 });
  return img.getAttribute('src');
};
/** The colour at a point of a picture, as [r, g, b], decoded by the editor's own page. */
const pixel = (src, x, y) =>
  win.evaluate(
    async ([src, x, y]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return { size: [img.naturalWidth, img.naturalHeight], rgb: [...g.getImageData(x, y, 1, 1).data.slice(0, 3)] };
    },
    [src, x, y]
  );
/** The file in the editor's thumbnail cache whose bytes are the picture `src` shows. */
const cachedAs = (src) => {
  const bytes = Buffer.from(src.split(',')[1], 'base64');
  const names = existsSync(thumbsDir) ? readdirSync(thumbsDir) : [];
  return names.find((n) => /^[0-9a-f]{64}\.png$/.test(n) && readFileSync(join(thumbsDir, n)).equals(bytes)) ?? null;
};
const near = ([r, g, b], [er, eg, eb]) => Math.abs(r - er) + Math.abs(g - eg) + Math.abs(b - eb) < 60;
const cardRoot = (await snapshot()).components[blueDef.id].tree.rootIds[0];
const styleCard = (property, value, label) => apply([{ type: 'node.setStyle', owner: { kind: 'component', id: blueDef.id }, nodeId: cardRoot, scope: 'base', property, value }], label);
// A tall red card, so the middle of its picture is the card itself.
await apply(
  [
    { type: 'node.setStyle', owner: { kind: 'component', id: blueDef.id }, nodeId: cardRoot, scope: 'base', property: 'minHeight', value: '900px' },
    { type: 'node.setStyle', owner: { kind: 'component', id: blueDef.id }, nodeId: cardRoot, scope: 'base', property: 'background', value: '#ff0000' }
  ],
  'Make the card red'
);
await openInsert();
if (await showAll.isVisible()) await showAll.click();
// Insert may have shown the card before it was red: its picture is drawn again.
let redPic;
let redShot;
await eventually(async () => {
  redPic = await picture('Exhibitor card blue');
  redShot = await pixel(redPic, 160, 100);
  writeFileSync(join(SHOTS, 'component-library-thumb.png'), Buffer.from(redPic.split(',')[1], 'base64'));
  assert.ok(near(redShot.rgb, [255, 0, 0]), `the card is pictured red (${redShot.rgb})`);
}, 90000);
assert.deepEqual(redShot.size, [320, 200], 'a thumbnail is 320 × 200');
const redFile = cachedAs(redPic);
assert.ok(redFile, 'the thumbnail is kept in the editor’s cache, under .siteorigin/cache/thumbs');
// Nothing of the thumbnails' window is ever shown or focused.
const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ editor: w.webContents.getURL().startsWith('app://'), visible: w.isVisible(), focused: w.isFocused() })));
assert.ok(windows.length === 2, `the thumbnails have a window of their own (${JSON.stringify(windows)})`);
assert.ok(windows.every((w) => !w.visible && (w.editor || !w.focused)), `no window is shown, and the thumbnails' never takes focus (${JSON.stringify(windows)})`);
await styleCard('background', '#0000ff', 'Make the card blue');
await eventually(async () => assert.notEqual(await picture('Exhibitor card blue'), redPic, 'the thumbnail is drawn again after a style change'), 90000);
const bluePic = await picture('Exhibitor card blue');
assert.ok(near((await pixel(bluePic, 160, 100)).rgb, [0, 0, 255]), 'and shows the new style');
const blueFile = cachedAs(bluePic);
assert.ok(blueFile && blueFile !== redFile, 'under a key of its own');
assert.ok(existsSync(join(thumbsDir, redFile)), 'the earlier one stays cached, for an Undo');

step('a brand colour change redraws thumbnails lazily, and an unchanged component is never drawn again');
await win.screenshot({ path: join(SHOTS, 'component-library-thumbs.png'), clip: { x: 0, y: 0, width: 420, height: 900 } });
await styleCard('background', { token: 'color.brand' }, 'Card on the brand colour');
await eventually(async () => assert.notEqual(await picture('Exhibitor card blue'), bluePic, 'the card follows the brand colour'), 90000);
// Insert closed: a brand change draws nothing until the tiles are shown again.
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await panel.locator('.insert-group[data-kind="component"]').waitFor({ state: 'hidden' });
// Photographs asked for before it closed may still finish: counted once they have.
let closedAt = await captures();
for (let settledFor = 0; settledFor < 3; ) {
  await win.waitForTimeout(700);
  const n = await captures();
  settledFor = n === closedAt ? settledFor + 1 : 0;
  closedAt = n;
}
await apply([{ type: 'token.set', tokenId: 'color.brand', value: '#00aa00' }], 'Green brand');
await win.waitForTimeout(2000);
assert.equal(await captures(), closedAt, 'nothing is drawn while Insert is closed');
await openInsert();
await eventually(async () => assert.ok(near((await pixel(await picture('Exhibitor card blue'), 160, 100)).rgb, [0, 170, 0]), 'reopened, the card shows the new brand colour'), 90000);
assert.ok((await captures()) > closedAt, 'and is drawn once Insert is open');
// Back to the blue card on the theme's own brand colour: that version was pictured already.
await apply([{ type: 'token.set', tokenId: 'color.brand', value: null }], 'Theme brand');
await styleCard('background', '#0000ff', 'Make the card blue again');
const before370 = await captures();
await eventually(async () => assert.equal(await picture('Exhibitor card blue'), bluePic, 'the earlier thumbnail is shown again'), 30000);
await win.waitForTimeout(1000);
assert.equal(await captures(), before370, 'without drawing it again');

step('a code component is pictured too, and one that throws shows its sketch');
// Code components are listed in Developer mode, which the editor learns of from its own Settings.
await win.locator('[aria-label="Settings"]').click();
const devSwitch = win.getByRole('switch', { name: 'Developer mode' });
if ((await devSwitch.getAttribute('aria-checked')) !== 'true') await devSwitch.click();
await eventually(async () => assert.equal(await devSwitch.getAttribute('aria-checked'), 'true'));
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await openInsert();
if (await showAll.isVisible()) await showAll.click();
const noteId = Object.values((await snapshot()).components).find((d) => d.name === 'Sample note').id;
const opening = await win.evaluate(async () => (await window.builder.project.snapshot()).workspaceKey);
await eventually(async () => {
  const r = await win.evaluate(([id, o]) => window.builder.project.componentThumb(id, o), [noteId, opening]);
  assert.equal(r.state, 'ready', `a code component is pictured (${JSON.stringify(r).slice(0, 300)})`);
}, 90000);
assert.match(await picture('Sample note'), /^data:image\/png;base64,/, 'and its tile shows it');
const [{ definitionId: throwing }] = await apply([{ type: 'component.createCode', name: 'Throwing note', source: BROKEN }], 'Create a throwing component');
await eventually(async () => assert.equal(await thumb('Throwing note').getAttribute('data-thumb'), 'failed', 'a component that throws keeps its sketch'), 90000);
assert.equal(await thumb('Throwing note').locator('img').count(), 0);
await apply([{ type: 'component.remove', definitionId: throwing }], 'Remove the throwing component');
const thumbFiles = readdirSync(thumbsDir);

step('a prepared preview never reaches the project source or its exports');
const MARK = 'Isolated preview words 347';
const prepared = await win.evaluate((heading) => window.builder.project.prepareComponentPreview({ componentId: 'features.grid', props: { heading } }), MARK);
assert.equal(prepared.ok, true, prepared.message);
const isolated = join(projectDir, '.siteorigin/cache/dev/isolated', prepared.key);
assert.ok(existsSync(join(isolated, 'src/lib/siteorigin/preview/Preview.svelte')), 'the preview is written to the editor’s dev cache');
const sourceOut = join(WORK, 'export-source');
const staticOut = join(WORK, 'export-static');
const src = await withTimeout(win.evaluate((dest) => window.builderTest.exportSource(dest), sourceOut), 120000, 'Source export');
assert.equal(src.ok, true, `source export succeeds: ${src.message}`);
const stat = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), staticOut), 300000, 'Static export');
assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
/** Every file under `root`, by its path from there, leaving out the folders a site keeps its tools and editor data in. */
const files = (root, rel = '') =>
  readdirSync(join(root, rel)).flatMap((name) => {
    const r = rel ? `${rel}/${name}` : name;
    if (!rel && ['node_modules', '.siteorigin', '.svelte-kit', '.git'].includes(name)) return [];
    return statSync(join(root, r)).isDirectory() ? files(root, r) : [r];
  });
for (const [root, what] of [[sourceOut, 'the source export'], [staticOut, 'the static export'], [projectDir, 'the project folder']]) {
  const all = files(root);
  assert.ok(all.length > 5, `${what} has files`);
  for (const f of all) {
    assert.doesNotMatch(f, /__siteorigin|isolated|preview\/Preview\.svelte/, `${what} has no preview file (${f})`);
    if (/\.(svelte|js|json|html|css|txt|xml|md)$/.test(f)) {
      const text = readFileSync(join(root, f), 'utf8');
      assert.ok(!text.includes(MARK) && !text.includes('__siteorigin/component') && !text.includes('siteorigin-component-preview'), `${what}: ${f} carries nothing of the preview`);
    }
  }
}
for (const out of [sourceOut, staticOut]) {
  assert.equal(existsSync(join(out, '.siteorigin', 'cache', 'dev', 'isolated')), false, `no preview cache in ${out}`);
  assert.equal(existsSync(join(out, '.siteorigin', 'cache', 'thumbs')), false, `no thumbnail cache in ${out}`);
  const names = new Set(files(out).map((f) => f.split('/').pop()));
  for (const f of thumbFiles) assert.ok(!names.has(f), `no thumbnail (${f}) in ${out}`);
}
await win.evaluate((key) => window.builder.project.releaseComponentPreview(key), prepared.key);
assert.equal(existsSync(isolated), false, 'a released preview’s files are removed');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncomponent-library: passed');
