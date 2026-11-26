// Required properties (#748), against the real app. In Edit everywhere a "Pricing switch" component's Monthly label is
// made required with its switch, which says how many placements are missing it now and never blocks. On a placement
// that has a label, clearing it is refused at the field with the engine's message, the field keeps the label and no
// error toast appears. Project health lists the placement still missing it and goes straight to its field, and one
// Undo takes the rule (and the finding) away again.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('required-properties');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Required Hall', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
const inspector = win.locator('#dock-panel-inspect');

const snapshot = () => win.evaluate(async () => window.builder.project.snapshot());
const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    },
    [operations, label]
  );
/** Choose Edit → Undo, as a click on the menu item does (no window has focus while headless). */
const undo = () =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      .items.find((i) => i.label === 'Edit')
      ?.submenu?.items.find((i) => i.id === 'edit-undo');
    if (!item) throw new Error('No Undo item in the Edit menu');
    item.click({ triggeredByAccelerator: false, metaKey: false, ctrlKey: false }, undefined, undefined);
  });
const errorToasts = () => win.locator('.toast.error').allInnerTexts();

step('a component placed twice, one placement with its label already cleared');
const pageId = (await snapshot()).state.site.homePageId;
const owner = { kind: 'page', id: pageId };
const [made] = await apply([{ type: 'component.create', name: 'Pricing switch' }], 'Make a component');
const defId = made.definitionId;
await apply([{ type: 'component.setPropSchema', definitionId: defId, prop: 'monthly', schema: { type: 'string', label: 'Monthly label', default: 'Monthly' } }], 'Add Monthly label');
const [first] = await apply([{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId }], 'Place it');
const [second] = await apply([{ type: 'node.insert', owner, parentId: null, index: 1, definitionId: defId }], 'Place it again');
await apply([{ type: 'instance.setProp', owner, nodeId: second.nodeId, prop: 'monthly', value: '' }], 'Clear the second label');
const placementRow = (nodeId) => win.locator(`[role="tree"] [data-node="${nodeId}"]`).first();

step('Edit everywhere: turn Required on for Monthly label');
await win.locator('.rail [aria-label="Layers"]').click();
await placementRow(first.nodeId).click();
await openInspector(win);
const compSection = inspector.getByRole('button', { name: /^Component\b/ });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.locator('.modal').getByRole('button', { name: /^(Edit everywhere|Edit design)$/ }).click();
await win.locator('.mode-band').waitFor();
const properties = inspector.locator('.section', { has: win.getByRole('button', { name: /^Properties\b/ }) });
await properties.waitFor();
const requiredSwitch = properties.getByRole('switch', { name: 'Monthly label required' });
assert.equal(await requiredSwitch.getAttribute('aria-checked'), 'false', 'Monthly label starts optional');
const revisionBefore = (await snapshot()).revision;
await requiredSwitch.click();
await eventually(async () => assert.equal((await snapshot()).state.components[defId].properties.monthly.required, true, 'the schema now requires it'));
await eventually(async () => assert.equal(await requiredSwitch.getAttribute('aria-checked'), 'true'));
await eventually(async () => assert.match(await properties.getByRole('status').innerText(), /One placement is missing Monthly label now/, 'the switch says how many placements are missing it'));
assert.equal((await snapshot()).revision, revisionBefore + 1, 'one change');
assert.equal((await snapshot()).state.pages[pageId].nodes[second.nodeId].props.monthly, '', 'the empty label stays');
assert.deepEqual(await errorToasts(), [], 'turning it on is not refused');
await win.screenshot({ path: join(SHOTS, 'required-1-switch.png') });
await inspector.getByRole('button', { name: 'Done editing' }).first().click();
await win.locator('.mode-band').waitFor({ state: 'detached' });

step('clearing a filled label is refused at the field, which keeps it');
await placementRow(first.nodeId).click();
await openInspector(win);
const label = inspector.getByLabel('Monthly label, required', { exact: true });
await label.waitFor();
assert.equal(await label.inputValue(), 'Monthly');
const revisionFilled = (await snapshot()).revision;
await label.fill('');
await label.press('Enter');
const message = 'Pricing switch → Monthly label is required: it needs some text.';
const fieldNote = inspector.locator('[data-field="monthly"] .field-error');
await eventually(async () => assert.equal(await fieldNote.innerText(), message, 'the field says why, in the engine’s words'));
await eventually(async () => assert.equal(await label.inputValue(), 'Monthly', 'the field shows the label it kept'));
assert.equal(await label.getAttribute('aria-invalid'), 'true');
assert.equal((await snapshot()).state.pages[pageId].nodes[first.nodeId].props.monthly, 'Monthly', 'the project keeps the label');
assert.equal((await snapshot()).revision, revisionFilled, 'and has no new history entry');
assert.deepEqual(await errorToasts(), [], 'no error toast');
await win.screenshot({ path: join(SHOTS, 'required-2-refused.png') });

step('Project health lists the placement missing it and goes to its field');
await win.locator('.status-bar button.problems').click();
const finding = win.locator('.health-row', { hasText: 'Pricing switch → Monthly label is required' });
await finding.waitFor();
assert.equal(await finding.count(), 1, 'only the placement still missing it');
await finding.getByRole('button', { name: 'Go to field' }).click();
await win.locator('.modal').waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await placementRow(second.nodeId).getAttribute('aria-selected'), 'true', 'the placement missing it is selected'));
const missingLabel = inspector.getByLabel('Monthly label, required', { exact: true });
await eventually(async () => assert.equal(await missingLabel.evaluate((el) => el === document.activeElement), true, 'its field has focus'));
assert.equal(await missingLabel.inputValue(), '');
assert.match(await inspector.locator('[data-field="monthly"] .field-error').innerText(), /Required, but empty: it needs some text\./, 'the field says it needs a value');
await win.screenshot({ path: join(SHOTS, 'required-3-health.png') });

step('one Undo takes the rule and the finding away');
// Undo in a text field undoes its typing: the project's Undo is asked for with the field left.
await missingLabel.evaluate((el) => el.blur());
await undo();
await eventually(async () => assert.equal((await snapshot()).state.components[defId].properties.monthly.required, undefined, 'the schema no longer requires it'));
await eventually(async () => assert.deepEqual((await snapshot()).diagnostics.filter((d) => d.code === 'PROP_REQUIRED_EMPTY'), [], 'nothing is reported'));
await eventually(async () => assert.equal(await inspector.getByLabel('Monthly label', { exact: true }).count(), 1, 'the field is no longer marked required'));
assert.equal((await snapshot()).state.pages[pageId].nodes[first.nodeId].props.monthly, 'Monthly');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nrequired-properties: ok');
