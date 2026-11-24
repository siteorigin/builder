// Code components: create in the editor, see compiler diagnostics, save, render, undo.
// LIVE_FIX=1 keeps the syntax error and OPENAI_API_KEY, so the code-fixing agent repairs it (costs money).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, assertTabsResolve, createProject, eventually, launch, scratch, step } from './harness.mjs';

const LIVE_FIX = !!process.env.LIVE_FIX;
const { WORK, SHOTS: OUT, cleanup } = scratch('code');
const { app, win, errors } = await launch(WORK, LIVE_FIX ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' } : {});
const frame = await createProject(win, { name: 'Code Test', parentDir: join(WORK, 's'), starter: 'blank', sampleImages: false });

step('turn on Developer mode');
await win.locator('[aria-label="Settings"]').click();
await assertTabsResolve(win, 'settings, as opened');
await win.locator('.modal [role="tab"][aria-selected="true"]').press('End');
await win.getByRole('tab', { name: 'AI assistant', selected: true }).waitFor();
await assertTabsResolve(win, 'settings, AI assistant');
await win.getByRole('tab', { name: 'AI assistant' }).press('Home');
await win.getByRole('tab', { name: 'General', selected: true }).waitFor();
await assertTabsResolve(win, 'settings, general');
await win.getByRole('switch', { name: 'Developer mode' }).click();
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

step('a syntax error shows a diagnostic');
await win.locator('.rail [aria-label="Insert"]').click();
await win.getByRole('button', { name: 'New code component' }).click();
await win.fill('input[placeholder="Booking widget"]', 'Counter');
await win.locator('.cm-content').click();
await win.keyboard.press(`${MOD}+End`);
await win.keyboard.type('\n<p>{oops</p>');
await win.waitForSelector('.cm-lint-marker-error', { timeout: 10000 });
await win.screenshot({ path: join(OUT, '40-code-error.png') });
if (!LIVE_FIX) {
  await win.keyboard.press(`${MOD}+End`);
  await win.keyboard.press('Shift+Home');
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await eventually(async () => assert.equal(await win.locator('.cm-lint-marker-error').count(), 0, 'the diagnostic clears once the error is removed'));
}

step('the properties tab edits the schema before creating');
await assertTabsResolve(win, 'new component, source');
await win.getByRole('tab', { name: /^Properties/ }).click();
await assertTabsResolve(win, 'new component, properties');
await win.getByRole('button', { name: 'Add property' }).click();
await win.locator('.schema-row').last().getByLabel('Type').selectOption('enum');
// A list's item fields are edited with controls, not JSON.
await win.getByRole('button', { name: 'Add property' }).click();
await win.getByLabel('prop2 type').selectOption('list');
await win.getByRole('button', { name: 'Add a field to prop2' }).click();
await win.getByLabel('prop2 field2 type').selectOption('number');
await win.screenshot({ path: join(OUT, '40b-code-properties.png') });
await win.getByRole('tab', { name: 'Svelte source' }).click();

step('a keyboard author leaves the source, visits Properties and keeps its undo history');
// Tabs move focus in an animation frame, so where focus lands is polled, never read once.
const focused = () =>
  win.evaluate(() => {
    const a = document.activeElement;
    return { id: a?.id ?? '', text: a?.textContent?.trim() ?? '', editor: !!a?.closest('.modal .cm-content'), properties: !!a?.closest('#new-code-panel-manifest') };
  });
const focusIs = (what, check) => eventually(async () => assert.ok(check(await focused()), `focus is on ${what}: ${JSON.stringify(await focused())}`), 3000);
const secondLine = () => win.locator('.modal .cm-line').nth(1).textContent();
const caret = () => win.locator('.modal .code-status-pos').textContent();
const REDO = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';
const MARK = '// kb-213';
// The starter indents with tabs and the editor with spaces, so indenting is measured by length, not matched.
const indentRoundTrip = async (when) => {
  const before = await secondLine();
  await win.keyboard.press('Tab');
  await eventually(async () => assert.ok((await secondLine()).length > before.length, `Tab indents ${when}`), 3000);
  await focusIs(`the editor after Tab ${when}`, (f) => f.editor);
  const after = await secondLine();
  await win.keyboard.press('Shift+Tab');
  await eventually(async () => assert.ok((await secondLine()).length < after.length, `Shift+Tab outdents ${when}`), 3000);
  await focusIs(`the editor after Shift+Tab ${when}`, (f) => f.editor);
};
await win.getByRole('tab', { name: 'Svelte source' }).press('Tab');
await focusIs('the editor, from its tab', (f) => f.editor);
assert.match(await win.locator('.modal .code-status-hint').textContent(), /Esc then Tab leaves the editor/, 'the way out is shown while the editor has focus');
await win.keyboard.press(`${MOD}+Home`);
await win.keyboard.press('ArrowDown');
await indentRoundTrip('in the starter');
// Past the history's grouping delay, so the marker is an undo step of its own.
await win.waitForTimeout(600);
await win.keyboard.press(`${MOD}+Home`);
await win.keyboard.press('End');
await win.keyboard.press('Enter');
await win.keyboard.type(MARK);
await eventually(async () => assert.match(await secondLine(), /kb-213/, 'the marker is typed on line 2'));
const caretAt = await caret();
await win.keyboard.press('Escape');
await win.locator('.modal .code-status-hint', { hasText: 'Press Tab' }).waitFor({ timeout: 5000 });
await win.keyboard.press('Shift+Tab');
await focusIs('the Svelte source tab', (f) => f.id === 'new-code-tab-source');
await win.keyboard.press('ArrowRight');
await win.getByRole('tab', { name: /^Properties/, selected: true }).waitFor();
await focusIs('the Properties tab', (f) => f.id === 'new-code-tab-manifest');
await win.keyboard.press('Tab');
await focusIs('a Properties field', (f) => f.properties);
await win.keyboard.press('Shift+Tab');
await focusIs('the Properties tab again', (f) => f.id === 'new-code-tab-manifest');
await win.keyboard.press('ArrowLeft');
await win.getByRole('tab', { name: 'Svelte source', selected: true }).waitFor();
await focusIs('the Svelte source tab again', (f) => f.id === 'new-code-tab-source');
await win.keyboard.press('Tab');
await focusIs('the editor, re-entered', (f) => f.editor);
assert.equal(await caret(), caretAt, 'the cursor is where it was left');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.doesNotMatch(await secondLine(), /kb-213/, 'undo reaches the change made before Properties was visited'));
await win.keyboard.press(REDO);
await eventually(async () => assert.match(await secondLine(), /kb-213/, 'redo puts it back'));
await indentRoundTrip('after coming back');
// The second Escape asks about the draft; Keep editing comes straight back to the editor, where Tab indents at once.
await win.keyboard.press('Escape');
await win.locator('.modal .code-status-hint', { hasText: 'Press Tab' }).waitFor({ timeout: 5000 });
await win.keyboard.press('Escape');
const keep = win.getByRole('button', { name: 'Keep editing' });
await eventually(async () => assert.equal(await keep.evaluate((b) => b === document.activeElement), true, 'Keep editing has focus'), 3000);
await win.keyboard.press('Enter');
await keep.waitFor({ state: 'detached' });
await focusIs('the editor, after Keep editing', (f) => f.editor);
await indentRoundTrip('straight after Keep editing');
// Focus that leaves and comes straight back, quicker than the editor hears of it, puts the way out away too.
await win.keyboard.press('Escape');
await win.locator('.modal .code-status-hint', { hasText: 'Press Tab' }).waitFor({ timeout: 5000 });
await win.evaluate(() => {
  document.getElementById('new-code-tab-source').focus();
  document.querySelector('.modal .cm-content').focus();
});
await indentRoundTrip('when focus comes straight back');
// Out of the editor to Create, past whatever lies between, and never through the discard prompt.
await win.keyboard.press('Escape');
await win.locator('.modal .code-status-hint', { hasText: 'Press Tab' }).waitFor({ timeout: 5000 });
let create = false;
for (let i = 0; i < 6 && !create; i++) {
  await win.keyboard.press('Tab');
  create = await eventually(async () => {
    const f = await focused();
    assert.ok(!f.editor, 'Tab leaves the editor');
    return f.text === 'Create and insert';
  }, 3000);
}
assert.ok(create, 'Create and insert is reached with Tab');
assert.equal(await win.getByText('Discard this new component?').count(), 0, 'leaving the editor never offers to discard the draft');

step('save, insert and render');
const t0 = Date.now();
await win.keyboard.press('Enter');
await win.waitForSelector('.modal', { state: 'detached', timeout: LIVE_FIX ? 120000 : 30000 });
console.log('save took', Date.now() - t0, 'ms');
await eventually(async () => assert.equal(await frame.locator('text=Clicked 0 times').count(), 1, 'the new component renders in the preview'), 30000);
const dir = join(WORK, 's', 'code-test');
const snap = await win.evaluate(() => window.builder.project.snapshot());
const def = Object.values(snap.state.components).find((d) => d.name === 'Counter');
assert.ok(def, 'the Counter definition exists');
assert.equal(def.kind, 'code');
assert.deepEqual(Object.keys(def.properties), ['heading', 'text', 'prop1', 'prop2'], 'the edited schema is saved with the component');
assert.equal(def.properties.prop1.type, 'enum');
assert.equal(def.properties.prop1.default, 'one', 'a choice defaults to its first option');
assert.deepEqual(Object.fromEntries(Object.entries(def.properties.prop2.fields).map(([k, f]) => [k, f.type])), { title: 'string', field2: 'number' }, 'the list keeps the item fields added with controls');
assert.ok(existsSync(join(dir, def.sourcePath)), `the component source is written to ${def.sourcePath}`);
if (!LIVE_FIX) assert.ok(readFileSync(join(dir, def.sourcePath), 'utf8').includes(MARK), 'the redone source change is what was created');

step('the source editor saves an edited schema');
// The placement holds content of its own, so keeping it is told apart from falling back to the default.
const placed = (s) => {
  for (const [pageId, p] of Object.entries(s.state.pages)) {
    const node = Object.values(p.nodes).find((n) => n.kind === 'instance' && n.definitionId === def.id);
    if (node) return { pageId, node };
  }
};
const at = placed(snap);
await win.evaluate(([pageId, nodeId]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'heading', value: 'Authored' }] }, { label: 'Author edit' }), [at.pageId, at.node.id]);
await eventually(async () => assert.equal(placed(await win.evaluate(() => window.builder.project.snapshot())).node.props.heading, 'Authored', 'the placement holds its own heading'));
await win.locator('.rail [aria-label="Layers"]').click();
await win.getByRole('treeitem', { name: /Counter/ }).first().click();
await win.evaluate(() => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: 'component' })));
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Edit code' }).first().click();
await win.getByRole('tab', { name: 'Svelte source', selected: true }).waitFor();
await assertTabsResolve(win, 'component source, as opened');
await win.getByRole('tab', { name: 'Properties' }).click();
await assertTabsResolve(win, 'component source, properties');
const saveButton = win.getByRole('button', { name: 'Save' });
const counter = async () => {
  const s = await win.evaluate(() => window.builder.project.snapshot());
  return { s, saved: Object.values(s.state.components).find((d) => d.name === 'Counter') };
};
// Renaming a property keeps what placements hold for it. Save is ready while the name still has focus, and
// clicking it commits the name being typed.
await win.getByLabel('heading name').fill('title');
assert.equal(await saveButton.isDisabled(), false, 'typing a name enables Save before the field is left');
await saveButton.click();
await eventually(async () => {
  const { s, saved } = await counter();
  assert.deepEqual(Object.keys(saved.properties), ['title', 'text', 'prop1', 'prop2'], 'the property is saved under its new name');
  assert.equal(placed(s).node.props.title, 'Authored', 'the placement keeps its content under the new name');
  assert.equal(placed(s).node.props.heading, undefined, 'nothing is left under the old name');
}, 15000);
await eventually(async () => assert.equal(await saveButton.isDisabled(), true, 'nothing is left unsaved after the rename'));
const label = win.getByLabel('prop1 label');
const savedLabel = await label.inputValue();
await label.fill('Abandoned');
// Escape reverts and leaves the field, and only that: the dialog stays open, with nothing lost. The field
// itself spends the key (the dialog's own check reads it), whatever wraps it, so this records the event.
await win.evaluate(() => {
  window.__escapes = [];
  window.addEventListener('keydown', (e) => e.key === 'Escape' && window.__escapes.push(e), true);
});
await label.press('Escape');
assert.equal(await win.evaluate(() => window.__escapes.at(-1)?.defaultPrevented), true, 'the field handled the Escape, so nothing else acts on it');
await eventually(async () => assert.equal(await label.inputValue(), savedLabel, 'Escape puts the field back'));
assert.equal(await win.locator('.modal').count(), 1, 'Escape inside a field does not close the dialog');
assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), null, 'the field has let go of focus');
await label.fill('Tone');
assert.equal(await saveButton.isDisabled(), false, 'typing a label enables Save before the field is left');
await saveButton.click();
await eventually(async () => assert.equal((await counter()).saved.properties.prop1.label, 'Tone', 'the saved schema has the new label'), 15000);
await eventually(async () => assert.equal(await saveButton.isDisabled(), true, 'nothing is left unsaved after saving'));

step('a schema that changes under unsaved rows is not overwritten by them (#103)');
const storedLabel = async () => Object.values((await win.evaluate(() => window.builder.project.snapshot())).state.components).find((d) => d.name === 'Counter').properties.prop1.label;
await label.fill('Mood');
await label.press('Enter');
// The saved schema edit is undone while the rows hold unsaved edits made from it.
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);
await eventually(async () => assert.notEqual(await storedLabel(), 'Tone', 'the schema edit is undone'));
const stale = win.getByRole('alert').filter({ hasText: 'These properties changed since you started editing them.' });
await stale.waitFor();
await win.screenshot({ path: join(OUT, '40c-code-properties-stale.png') });
await win.getByRole('button', { name: 'Save' }).click();
await win.waitForTimeout(500);
assert.ok(await stale.isVisible(), 'saving is refused, with the notice still showing');
assert.notEqual(await storedLabel(), 'Mood', 'the newer schema is kept');
await win.getByRole('button', { name: 'Reload properties' }).click();
await stale.waitFor({ state: 'detached' });
assert.equal(await label.inputValue(), await storedLabel(), 'the rows show the stored schema again');
await eventually(async () => assert.equal(await win.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing is left unsaved after reloading'));
// A label still being typed in (its field keeps focus, nothing committed yet) when the schema changes is kept and
// flagged, never dropped or saved over the newer schema.
await label.fill('Mood again');
assert.equal((await win.evaluate(() => window.builder.project.redo())).ok, true);
await stale.waitFor();
assert.equal(await label.inputValue(), 'Mood again', 'the label being typed is kept');
assert.equal(await storedLabel(), 'Tone', 'the redone schema is stored');
await win.getByRole('button', { name: 'Reload properties' }).click();
await stale.waitFor({ state: 'detached' });
assert.equal(await label.inputValue(), 'Tone', 'reloading shows the stored label');
// Undo the redone schema edit again: clean rows follow it.
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);
await eventually(async () => assert.equal(await label.inputValue(), await storedLabel(), 'clean rows follow the undo'));
await eventually(async () => assert.equal(await win.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing is left unsaved after the undo'));
// Redo it again, so the steps below start from the saved label as before; clean rows follow the redo too.
assert.equal((await win.evaluate(() => window.builder.project.redo())).ok, true);
await eventually(async () => assert.equal(await label.inputValue(), 'Tone', 'clean rows follow the redo'));

step('a rename is saved only onto the project it was made against');
// One changed meanwhile refuses it, and nothing moves.
await win.getByLabel('text name').fill('body');
await win.getByLabel('text name').press('Enter');
await win.evaluate(([pageId, nodeId]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop: 'text', value: 'Changed meanwhile' }] }, { label: 'Other edit' }), [at.pageId, at.node.id]);
await eventually(async () => assert.equal(placed((await counter()).s).node.props.text, 'Changed meanwhile', 'the other edit lands'));
await saveButton.click();
await win.getByText(/The project changed while you were editing these properties/).waitFor();
assert.deepEqual(Object.keys((await counter()).saved.properties), ['title', 'text', 'prop1', 'prop2'], 'the refused rename changes nothing');
await win.getByRole('button', { name: 'Revert' }).click();
await win.getByRole('button', { name: 'Revert changes' }).click();
await eventually(async () => assert.equal(await saveButton.isDisabled(), true, 'Revert starts again from the saved properties'));
// One Escape ends the edit in a field and keeps the dialog; the next, with no field being edited, closes it.
await label.fill('Abandoned again');
await label.press('Escape');
assert.equal(await win.locator('.modal').count(), 1, 'the first Escape leaves the dialog open');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
// Undo the two schema saves and the two content edits too, so the steps below unwind creation as before.
for (let i = 0; i < 4; i++) assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);

step('undo removes the placement, then the component and its file');
const undo = async () => assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true, 'undo succeeds');
await undo();
await eventually(async () => assert.equal(await frame.locator('text=Clicked 0 times').count(), 0, 'the first undo removes the placement from the preview'), 30000);
const mid = await win.evaluate(() => window.builder.project.snapshot());
assert.ok(mid.state.components[def.id], 'the definition remains after the first undo');
assert.ok(existsSync(join(dir, def.sourcePath)), 'the source file remains after the first undo');
await undo();
await eventually(() => assert.equal(existsSync(join(dir, def.sourcePath)), false, 'the second undo removes the source file'));
assert.equal((await win.evaluate(() => window.builder.project.snapshot())).state.components[def.id], undefined, 'the second undo removes the definition');
await win.screenshot({ path: join(OUT, '41-after-undo.png') });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncode: passed');
