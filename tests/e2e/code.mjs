// Code components: create in the editor, see compiler diagnostics, save, render, undo.
// LIVE_FIX=1 keeps the syntax error and OPENAI_API_KEY, so the code-fixing agent repairs it (costs money).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const LIVE_FIX = !!process.env.LIVE_FIX;
const { WORK, SHOTS: OUT, cleanup } = scratch('code');
const { app, win, errors } = await launch(WORK, LIVE_FIX ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' } : {});
const frame = await createProject(win, { name: 'Code Test', parentDir: join(WORK, 's'), starter: 'blank', sampleImages: false });

step('turn on Developer mode');
await win.locator('[aria-label="Settings"]').click();
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
await win.getByRole('tab', { name: /^Properties/ }).click();
await win.getByRole('button', { name: 'Add property' }).click();
await win.locator('.schema-row').last().getByLabel('Type').selectOption('enum');
await win.screenshot({ path: join(OUT, '40b-code-properties.png') });
await win.getByRole('tab', { name: 'Svelte source' }).click();

step('save, insert and render');
const t0 = Date.now();
await win.getByRole('button', { name: 'Create and insert' }).click();
await win.waitForSelector('.modal', { state: 'detached', timeout: LIVE_FIX ? 120000 : 30000 });
console.log('save took', Date.now() - t0, 'ms');
await eventually(async () => assert.equal(await frame.locator('text=Clicked 0 times').count(), 1, 'the new component renders in the preview'), 30000);
const dir = join(WORK, 's', 'code-test');
const snap = await win.evaluate(() => window.builder.project.snapshot());
const def = Object.values(snap.state.components).find((d) => d.name === 'Counter');
assert.ok(def, 'the Counter definition exists');
assert.equal(def.kind, 'code');
assert.deepEqual(Object.keys(def.properties), ['heading', 'text', 'prop1'], 'the edited schema is saved with the component');
assert.equal(def.properties.prop1.type, 'enum');
assert.equal(def.properties.prop1.default, 'one', 'a choice defaults to its first option');
assert.ok(existsSync(join(dir, def.sourcePath)), `the component source is written to ${def.sourcePath}`);

step('the source editor saves an edited schema');
await win.locator('.rail [aria-label="Layers"]').click();
await win.getByRole('treeitem', { name: /Counter/ }).first().click();
await win.evaluate(() => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: 'component' })));
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Edit code' }).first().click();
await win.getByRole('tab', { name: 'Properties' }).click();
const label = win.getByLabel('prop1 label');
await label.fill('Tone');
await label.press('Enter');
await win.getByRole('button', { name: 'Save' }).click();
await eventually(async () => {
  const s = await win.evaluate(() => window.builder.project.snapshot());
  assert.equal(Object.values(s.state.components).find((d) => d.name === 'Counter').properties.prop1.label, 'Tone', 'the saved schema has the new label');
}, 15000);
await eventually(async () => assert.equal(await win.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing is left unsaved after saving'));
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
// Undo the schema edit too, so the steps below unwind creation as before.
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);

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
