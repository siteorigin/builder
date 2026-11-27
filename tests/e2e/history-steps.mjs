// Stepping to any change in History (#199). Edits made with the editor's own controls (text typed on the canvas, and
// Duplicate, Move down and Delete on a Layers row) are listed by what they did, to which element, on which page. From
// History the author steps several changes back, from the keyboard, and several forward, with a click, each in one
// change, the result said in the dialog; what was undone can be redone until a new change is made.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('history-steps');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'History Steps', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const labels = async () => (await snapshot()).history.entries.map((e) => [e.label, e.applied]);
const galleries = async () => {
  const s = await snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  return page.rootIds.filter((id) => s.state.components[page.nodes[id].definitionId]?.name === 'Gallery').length;
};
const pageText = async () => JSON.stringify((await snapshot()).state.pages);
const roots = async () => {
  const s = await snapshot();
  return s.state.pages[s.state.site.homePageId].rootIds;
};
const settle = () => win.waitForTimeout(400);
const history = win.getByRole('dialog', { name: 'History' });
const rowFor = (label) => history.locator('.history-step', { has: win.locator('.grow', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const focusedLabel = () => win.evaluate(() => document.activeElement?.closest('.history-step')?.querySelector('.grow')?.textContent ?? null);

step('edits made with the editor’s own controls');
const start = (await snapshot()).history.entries.length;
const h1 = frame.locator('h1').first();
await h1.click();
await settle();
await h1.dblclick();
await eventually(async () => assert.ok(await h1.getAttribute('contenteditable'), 'the heading is being edited'));
await win.keyboard.press(`${MOD}+a`);
await win.keyboard.type('Stepped heading');
await win.keyboard.press('Enter');
await eventually(async () => assert.match(await pageText(), /Stepped heading/, 'the heading edit is saved'));
await win.locator('.rail [aria-label="Layers"]').click();
const gallery = win.locator('[role="tree"] [role="treeitem"][data-name="Gallery"]').first();
await gallery.click();
await gallery.focus();
const rootsAtStart = await roots();
await win.keyboard.press(`${MOD}+d`);
await eventually(async () => assert.equal(await galleries(), 2, 'Gallery is duplicated'));
const rootsDuplicated = await roots();
await win.keyboard.press(`${MOD}+Shift+ArrowDown`);
await eventually(async () => assert.equal((await snapshot()).history.entries.length, start + 3, 'the copy moves down'));
await win.keyboard.press('Delete');
await eventually(async () => assert.equal(await galleries(), 1, 'the copy is deleted'));
assert.deepEqual(await roots(), rootsAtStart, 'the copy went, the sections are as they were');

const made = (await labels()).slice(start).map(([l]) => l);
assert.equal(made.length, 4, `four changes: ${made.join(' | ')}`);
assert.match(made[0], /^Edit .+ on Home$/, 'the text edit names the element and the page');
assert.deepEqual(made.slice(1), ['Duplicate Gallery on Home', 'Move Gallery down on Home', 'Delete Gallery on Home']);

step('History opens from the keyboard where History stands now, and a held Enter steps nothing');
await win.locator('.project-title').click();
await win.locator('[role="menu"]').waitFor();
await win.locator('[role="menu"] [role^="menuitem"]', { hasText: 'History…' }).focus();
const opened = (await snapshot()).revision;
// Enter chooses the menu item and is held down: its repeats reach the row focus starts on.
await win.keyboard.down('Enter');
await history.waitFor();
await eventually(async () => assert.equal(await focusedLabel(), 'Delete Gallery on Home', 'focus starts on the current change'));
await win.keyboard.down('Enter');
await win.keyboard.down('Enter');
await win.keyboard.up('Enter');
await settle();
assert.equal((await snapshot()).revision, opened, 'the held key undoes nothing');
assert.deepEqual((await snapshot()).history.entries.slice(start).map((e) => e.applied), [true, true, true, true]);
const shown = await history.locator('.history-step .grow').allInnerTexts();
assert.deepEqual(shown.slice(0, 4), [...made].reverse(), 'the newest change comes first');
const newest = rowFor('Delete Gallery on Home');
assert.equal(await newest.getAttribute('aria-current'), 'step', 'the newest change is where History stands');
assert.equal(await newest.getAttribute('tabindex'), '0', 'and it is the list’s one Tab stop');
assert.equal(await history.locator('.history-step[tabindex="0"]').count(), 1);
assert.equal(await rowFor('Duplicate Gallery on Home').getAttribute('aria-label'), 'Undo “Duplicate Gallery on Home” and 2 changes after it');

step('the keyboard moves between changes without changing anything, and Enter steps back several');
const before = (await snapshot()).revision;
await win.keyboard.press('End');
assert.equal(await focusedLabel(), (await snapshot()).history.entries[0].label, 'End goes to the oldest change');
await win.keyboard.press('Home');
assert.equal(await focusedLabel(), 'Delete Gallery on Home', 'Home goes back to the newest');
await win.keyboard.press('ArrowDown');
assert.equal(await focusedLabel(), 'Move Gallery down on Home', 'Down moves one change older');
await win.keyboard.press('ArrowDown');
assert.equal(await focusedLabel(), 'Duplicate Gallery on Home', 'and another');
await win.keyboard.press('ArrowUp');
assert.equal(await focusedLabel(), 'Move Gallery down on Home', 'Up moves one change newer');
await settle();
assert.equal((await snapshot()).revision, before, 'moving through the list changes nothing');
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await history.getByRole('status').filter({ hasText: 'Undid 2 changes' }).innerText(), 'Undid 2 changes, back to before “Move Gallery down on Home”.'));
const back = await snapshot();
assert.equal(back.revision, before + 1, 'two changes undone in one step');
assert.deepEqual(back.history.entries.slice(start).map((e) => e.applied), [true, true, false, false]);
assert.deepEqual(await roots(), rootsDuplicated, 'the copy is back where it was made, before it moved');
assert.match(await pageText(), /Stepped heading/, 'the older text edit stays');
assert.equal(await focusedLabel(), 'Move Gallery down on Home', 'focus stays on the change chosen');
await eventually(async () => assert.equal(await history.locator('.history-step[aria-current="step"] .grow').innerText(), 'Duplicate Gallery on Home', 'History now stands at the duplicate'));
assert.equal(await rowFor('Move Gallery down on Home').getAttribute('aria-label'), 'Redo “Move Gallery down on Home”', 'the same row now offers to redo it');
assert.equal(await history.getByRole('button', { name: 'Redo', exact: true }).isEnabled(), true, 'the footer’s Redo is there too');

step('a click redoes several forward in one step');
await rowFor('Delete Gallery on Home').click();
await eventually(async () => assert.equal(await history.getByRole('status').filter({ hasText: 'Redid 2 changes' }).innerText(), 'Redid 2 changes, up to “Delete Gallery on Home”.'));
const forward = await snapshot();
assert.equal(forward.revision, before + 2, 'two changes redone in one step');
assert.deepEqual(forward.history.entries.slice(start).map((e) => e.applied), [true, true, true, true]);
assert.deepEqual(await roots(), rootsAtStart, 'the copy is deleted again');
assert.equal(forward.history.entries.at(-2).label, 'Move Gallery down on Home', 'the entries between keep their labels');

step('a click steps further back, and what is undone can be redone until a new change is made');
await rowFor('Duplicate Gallery on Home').click();
await eventually(async () => assert.equal(await history.getByRole('status').filter({ hasText: 'Undid 3 changes' }).innerText(), 'Undid 3 changes, back to before “Duplicate Gallery on Home”.'));
assert.equal((await snapshot()).revision, before + 3, 'three changes undone in one step');
assert.deepEqual((await snapshot()).history.entries.slice(start).map((e) => e.applied), [true, false, false, false]);
assert.equal(await focusedLabel(), 'Duplicate Gallery on Home');
const renamed = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'site.update', name: 'History Steps Studio' }] }, { label: 'Rename site' }));
assert.ok(renamed.ok, 'a new change is made');
await eventually(async () => assert.deepEqual((await labels()).slice(start).map(([l]) => l), [made[0], 'Rename site']));
await eventually(async () => assert.equal(await history.locator('.history-step', { hasText: 'Gallery on Home' }).count(), 0, 'the undone changes leave the list'));
assert.equal(await history.getByRole('button', { name: 'Redo', exact: true }).isEnabled(), false, 'nothing is left to redo');
// The row that had focus went with its change: focus goes on to the list, where the keys still work.
await eventually(async () => assert.equal(await focusedLabel(), 'Rename site', 'focus moves to where History stands'));
await win.keyboard.press('ArrowDown');
assert.equal(await focusedLabel(), made[0], 'and Down still moves through the list');

await win.keyboard.press('Escape');
await history.waitFor({ state: 'detached' });
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nhistory-steps: passed');
