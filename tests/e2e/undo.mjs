// Undo and Redo go to the surface that has focus. A visitor's field in Preview, a form field on the canvas,
// inline site copy, an inspector field and a dialog's text field keep their own text history and never move the
// project; Layers and the canvas in Edit mode undo the project, from the keyboard and from Edit → Undo alike,
// one step at a time.
//
// Text fields receive chords through their focused page. Editor shortcuts are injected at the main process to
// exercise before-input-event forwarding from a hidden window; the test invokes macOS menu copies explicitly.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const mac = process.platform === 'darwin';
const { WORK, cleanup } = scratch('undo');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Undo Routing', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
await win.evaluate(() => {
  window.__shownRevisions = [];
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'revisionApplied' && Number.isSafeInteger(e.data.payload?.revision)) window.__shownRevisions.push(e.data.payload.revision);
  });
});

const revision = () => win.evaluate(async () => (await window.builder.project.snapshot()).revision);
const pages = () => win.evaluate(async () => JSON.stringify((await window.builder.project.snapshot()).state.pages));
const settle = () => win.waitForTimeout(500);
/** A field's value, failing fast (inside eventually) when the field is gone. */
const value = (field) => field.inputValue({ timeout: 1000 });
const focusedTag = () => win.evaluate(() => document.activeElement?.tagName);

/** Press a chord at the main process, as the editor shortcut forwarder receives it. */
const chord = (key, shift = false) =>
  app.evaluate(
    ({ BrowserWindow }, { key, shift, mac }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const modifiers = [mac ? 'meta' : 'control', ...(shift ? ['shift'] : [])];
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    },
    { key, shift, mac }
  );
const undoKey = () => chord('z');
const redoKey = () => (process.platform === 'win32' ? chord('y') : chord('z', true));
const textUndoKey = () => win.keyboard.press(`${MOD}+z`);
const textRedoKey = () => win.keyboard.press(process.platform === 'win32' ? `${MOD}+y` : `${MOD}+Shift+z`);

/**
 * Choose Edit → Undo or Edit → Redo, as a click on the menu item does (no window has focus while headless).
 * `viaKey`: as the item's key does when the page leaves the key alone, with the accelerator's modifier held. A
 * real key press reaches the menu that way after the main process has forwarded it, which injected input never
 * does on macOS, so the tests send that copy themselves.
 */
const menu = (id, viaKey = false) =>
  app.evaluate(
    ({ Menu }, { id, viaKey, mac }) => {
      const item = Menu.getApplicationMenu()
        .items.find((i) => i.label === 'Edit')
        ?.submenu?.items.find((i) => i.id === id);
      if (!item) throw new Error(`No ${id} item in the Edit menu`);
      item.click({ triggeredByAccelerator: viaKey, metaKey: viaKey && mac, ctrlKey: viaKey && !mac }, undefined, undefined);
    },
    { id, viaKey, mac }
  );
/** A key press that the page leaves alone: forwarded by the main process, then also reaching the Edit menu. */
const undoPress = async () => (await undoKey(), await menu('edit-undo', true));
const redoPress = async () => (await redoKey(), await menu('edit-redo', true));

/**
 * Undo then Redo in a field that keeps its own history, by key press and from the Edit menu; the project never
 * moves. (On Windows and Linux the injected key may undo the field by itself; a second Undo of a one-step history
 * changes nothing.)
 */
async function textHistory(what, field, read, typed, original) {
  const rev = await revision();
  const unchanged = async (when) => {
    await settle();
    assert.equal(await revision(), rev, `${what}: ${when} leaves the project unchanged`);
  };
  for (const [how, undo, redo] of [
    ['the Undo and Redo keys', textUndoKey, textRedoKey],
    ['the Edit menu’s key equivalents', () => menu('edit-undo', true), () => menu('edit-redo', true)],
    ['Edit → Undo and Redo', () => menu('edit-undo'), () => menu('edit-redo')]
  ]) {
    await field.focus();
    await eventually(async () => assert.equal(await field.evaluate((el) => document.activeElement === el), true, `${what}: the field owns Undo`));
    await undo();
    await eventually(async () => assert.equal(await read(), original, `${what}: ${how} undo the typing`));
    await unchanged(how);
    await field.focus();
    await eventually(async () => assert.equal(await field.evaluate((el) => document.activeElement === el), true, `${what}: the field owns Redo`));
    await redo();
    await eventually(async () => assert.equal(await read(), typed, `${what}: ${how} bring the typing back`));
    await unchanged(how);
  }
}

/** Undo then Redo of the project, exactly one step each, through each of `ways`. */
async function projectHistory(what, ways, undone, done) {
  let rev = await revision();
  const once = async (when) => {
    await settle();
    assert.equal(await revision(), ++rev, `${what}: ${when} takes exactly one step`);
    // A second Redo at the end of the history changes nothing but says so.
    assert.equal(await win.locator('.toast.error').count(), 0, `${what}: ${when} reports no error`);
  };
  for (const [how, undo, redo] of ways) {
    await undo();
    await eventually(async () => assert.ok(await undone(), `${what}: Undo from ${how} reverts the last edit`));
    await once(`Undo from ${how}`);
    await redo();
    await eventually(async () => assert.ok(await done(), `${what}: Redo from ${how} applies it again`));
    await once(`Redo from ${how}`);
  }
}
const keyboard = ['the keyboard', undoKey, redoKey];
const keyPress = ['a key press that also reaches the Edit menu', undoPress, redoPress];
const editMenu = ['the Edit menu', () => menu('edit-undo'), () => menu('edit-redo')];

step('the Edit menu keeps Undo and Redo with the standard keys');
assert.deepEqual(
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((i) => i.label === 'Edit')
      ?.submenu?.items.slice(0, 2)
      .map((i) => [i.id, i.label, i.accelerator, i.enabled && i.visible])
  ),
  [
    ['edit-undo', 'Undo', 'CommandOrControl+Z', true],
    ['edit-redo', 'Redo', process.platform === 'win32' ? 'Control+Y' : 'Shift+CommandOrControl+Z', true]
  ]
);

step('add a Contact form');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Contact form' }).click();
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Contact form' }).waitFor();
const form = frame.locator('form').filter({ has: frame.locator('input[name="name"]') });
await eventually(async () => assert.equal(await form.count(), 1, 'the preview shows the Contact form'));
await eventually(async () => assert.ok(await win.evaluate((r) => window.__shownRevisions.includes(r), await revision()), 'the preview has applied the form insert'), 30000);
const nameField = form.locator('input[name="name"]');
const formName = async () => {
  assert.equal(await form.count(), 1, 'the Contact form is still on the page');
  return value(nameField);
};

step('a visitor’s typing in Preview keeps its own history');
await win.locator('button[title^="Preview:"]').click();
await eventually(async () => assert.equal(await win.locator('button[title^="Preview:"]').getAttribute('aria-checked'), 'true', 'Preview is on'));
// The preview is scaled to fit, so focus the field directly rather than aiming a click at it.
await nameField.focus();
await eventually(async () => assert.equal(await focusedTag(), 'IFRAME', 'the preview frame has focus'));
await win.waitForTimeout(250);
await nameField.pressSequentially('Demo');
await textHistory('visitor’s Name field', nameField, formName, 'Demo', '');

step('Undo in Preview never reaches the project, whatever on the page has focus');
await nameField.blur();
await frame.locator('body').evaluate(() => window.focus());
await eventually(async () => assert.equal(await focusedTag(), 'IFRAME', 'the preview frame has focus'));
const previewing = await revision();
for (const [how, act] of [
  ['the Undo key', undoKey],
  ['an Undo key press that reaches the Edit menu', undoPress],
  ['Edit → Undo', () => menu('edit-undo')]
]) {
  await act();
  await settle();
  assert.equal(await revision(), previewing, `${how} in Preview leaves the project unchanged`);
  assert.equal(await form.count(), 1, `${how} in Preview leaves the Contact form on the page`);
}
await nameField.fill('');
await win.locator('button[title^="Edit:"]').click();

step('a form field reached in Edit mode keeps its own history');
await nameField.focus();
await eventually(async () => assert.equal(await focusedTag(), 'IFRAME', 'the canvas has focus'));
await win.waitForTimeout(250);
await nameField.pressSequentially('Typed');
await textHistory('Name field on the canvas', nameField, formName, 'Typed', '');
await nameField.fill('');
await nameField.blur();

step('inline site copy keeps its own history while it is being edited');
const h1 = frame.locator('h1').first();
const original = await h1.innerText();
await h1.click();
await settle();
await h1.dblclick();
await eventually(async () => assert.ok(await h1.getAttribute('contenteditable'), 'the heading is being edited'));
// A double-click starts at the word clicked; Select All takes the whole heading.
await win.keyboard.press(`${MOD}+a`);
await win.keyboard.type('Fresh copy');
await textHistory('inline heading', h1, () => h1.innerText(), 'Fresh copy', original);
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await h1.innerText(), original, 'Escape cancels the inline edit'));

step('Layers undoes the project from the keyboard and the Edit menu');
await h1.click();
await settle();
await h1.dblclick();
await eventually(async () => assert.ok(await h1.getAttribute('contenteditable'), 'the heading is being edited'));
await win.keyboard.press(`${MOD}+a`);
await win.keyboard.type('Committed heading');
await win.keyboard.press('Enter');
await eventually(async () => assert.match(await pages(), /Committed heading/, 'the heading edit is committed'));
await eventually(async () => assert.ok(await win.evaluate((r) => window.__shownRevisions.includes(r), await revision()), 'the preview has applied the heading edit'), 30000);
await win.locator('.rail [aria-label="Layers"]').click();
const row = win.locator('[role="tree"] [role="treeitem"]').first();
await row.click();
await row.focus();
// Exactly one step: the Contact form added before the heading stays.
const headingUndone = async () => !(await pages()).includes('Committed heading') && (await h1.innerText()) === original && (await form.count()) === 1;
const headingDone = async () => (await pages()).includes('Committed heading') && (await h1.innerText()) === 'Committed heading';
await projectHistory('Layers row', [keyboard, keyPress, editMenu], headingUndone, headingDone);

step('the canvas in Edit mode undoes the project from the keyboard and the Edit menu');
await frame.locator('body').evaluate(() => window.focus());
await eventually(async () => assert.equal(await focusedTag(), 'IFRAME', 'the canvas has focus'));
await projectHistory('canvas', [keyboard, keyPress, editMenu], headingUndone, headingDone);

step('an inspector select, which has no text history, undoes the project');
await win.locator('[role="tree"] .list-item', { hasText: 'Contact form' }).first().click();
const tone = win.locator('#dock-panel-inspect .field', { hasText: /^Tone/ }).locator('select').first();
await tone.focus();
await eventually(async () => assert.equal(await focusedTag(), 'SELECT', 'the select has focus'));
await projectHistory('inspector select', [keyboard, keyPress, editMenu], headingUndone, headingDone);

step('an inspector field keeps its own history');
// The canvas is scaled to fit beside Layers, so select the heading with a click on the element itself.
await h1.dispatchEvent('click');
const headingField = await eventually(async () => {
  for (const f of await win.locator('#dock-panel-inspect').getByRole('textbox').all()) if ((await f.inputValue()) === 'Committed heading') return f;
  throw new Error('the inspector shows the heading in a text field');
});
await headingField.focus();
await headingField.press('End');
// One character: the field re-renders as it changes, which can split typing into several steps of its history.
await headingField.pressSequentially('!');
await textHistory('inspector field', headingField, () => value(headingField), 'Committed heading!', 'Committed heading');
await headingField.press('Escape');

step('Undo from the empty Layers panel undoes the project');
const sections = () => win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  return s.state.pages[s.state.site.homePageId].rootIds.length;
});
const before = await sections();
const cleared = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const owner = { kind: 'page', id: s.state.site.homePageId };
  return window.builder.project.apply({ operations: s.state.pages[owner.id].rootIds.map((nodeId) => ({ type: 'node.remove', owner, nodeId })) }, { label: 'Clear the page' });
});
assert.ok(cleared.ok, 'the page is cleared');
const addSections = win.locator('.layers-empty button');
await addSections.waitFor();
await addSections.focus();
let emptyRev = await revision();
await undoKey();
await eventually(async () => assert.equal(await sections(), before, 'Undo from the empty Layers panel brings the sections back'));
await settle();
assert.equal(await revision(), ++emptyRev, 'Undo from the empty Layers panel takes exactly one step');
assert.equal(await win.locator('.toast.error').count(), 0, 'Undo from the empty Layers panel reports no error');

step('a dialog’s text field keeps its own history');
await row.focus();
await chord('k');
const search = win.locator('[role="dialog"] input').first();
await search.waitFor();
// One character, as in the inspector.
await search.pressSequentially('p');
await textHistory('command menu search', search, () => value(search), 'p', '');
await search.press('Escape');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nundo: passed');
