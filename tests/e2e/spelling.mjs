// Spelling corrections from a right-click: in an inspector field and in site copy being edited on the canvas.
//
// The writing menu is native, so a headless run never shows it: the main process hands each menu it builds to
// the test ('test:writing-menu'), which reads it and chooses an item the way a click does. The right-clicks
// themselves are real mouse input, so the misspelled word, its suggestions and the frame they came from are
// what Chromium reports. A hidden window spell-checks only what is typed into it, so each misspelling is typed
// word by word before it is right-clicked.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('spelling');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Spelling', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const revision = () => win.evaluate(async () => (await window.builder.project.snapshot()).revision);
const pages = () => win.evaluate(async () => JSON.stringify((await window.builder.project.snapshot()).state.pages));
const settle = () => win.waitForTimeout(500);
const openMenus = () => win.locator('[role="menu"]').count();

await app.evaluate(({ app }) => {
  globalThis.writingMenus = [];
  app.on('test:writing-menu', (menu, params) => globalThis.writingMenus.push({ menu, params }));
});
const menuCount = () => app.evaluate(() => globalThis.writingMenus.length);
/** The writing menu the next right-click builds: its items, and what Chromium reported about the click. */
async function nextWritingMenu(rightClick) {
  const before = await menuCount();
  await rightClick();
  await eventually(async () => assert.ok((await menuCount()) > before, 'the right-click builds a writing menu'));
  return app.evaluate(() => {
    const { menu, params } = globalThis.writingMenus.at(-1);
    return {
      labels: menu.items.map((i) => (i.type === 'separator' ? '—' : i.label)),
      word: params.misspelledWord,
      suggestions: params.dictionarySuggestions,
      editable: params.isEditable,
      inPreview: !!params.frame && params.frame.parent !== null
    };
  });
}
/** Choose an item of the last writing menu, as a click on it does. */
const choose = (label) =>
  app.evaluate((_electron, label) => {
    const item = globalThis.writingMenus.at(-1).menu.items.find((i) => i.label === label);
    if (!item) throw new Error(`No ${label} in the writing menu`);
    item.click();
  }, label);
/** Edit → Undo or Redo, as a click on the menu item does (no window has focus while headless). */
const editMenu = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()
      .items.find((i) => i.label === 'Edit')
      ?.submenu?.items.find((i) => i.id === id);
    if (!item) throw new Error(`No ${id} item in the Edit menu`);
    item.click({ triggeredByAccelerator: false }, undefined, undefined);
  }, id);

/** The suggestions offered for "recieve", then the ordinary editing actions. */
function assertWritingMenu(m, where) {
  assert.equal(m.editable, true, `${where}: the right-click is in text that takes typing`);
  assert.equal(m.word, 'recieve', `${where}: the misspelled word under the pointer is reported`);
  assert.ok(m.suggestions.includes('receive'), `${where}: the spellchecker suggests "receive" (got ${JSON.stringify(m.suggestions)})`);
  assert.deepEqual(m.labels, [...m.suggestions, '—', 'Cut', 'Copy', 'Paste', '—', 'Select All'], `${where}: the suggestions come first, then the editing actions`);
}

/**
 * Where the middle of `el` (or of `word` inside it) is in the window. The canvas is scaled to fit beside the
 * panels, which Playwright's own clicks inside the preview do not allow for.
 */
async function canvasPoint(el, word) {
  const at = await el.evaluate((node, word) => {
    let b = node.getBoundingClientRect();
    if (word) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let found = false;
      for (let n = walker.nextNode(); n && !found; n = walker.nextNode()) {
        const i = n.nodeValue.indexOf(word);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i + 2);
        r.setEnd(n, i + 3);
        b = r.getBoundingClientRect();
        found = true;
      }
      if (!found) throw new Error(`"${word}" is not in the element`);
    }
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, width: innerWidth };
  }, word);
  const box = await win.locator('.frame-box iframe').boundingBox();
  const scale = box.width / at.width;
  return { x: box.x + at.x * scale, y: box.y + at.y * scale };
}
const clickCanvas = async (el, opts = {}) => {
  const p = await canvasPoint(el, opts.word);
  await win.mouse.click(p.x, p.y, { button: opts.button ?? 'left' });
};
const dblclickCanvas = async (el) => {
  const p = await canvasPoint(el);
  await win.mouse.dblclick(p.x, p.y);
};
const rightClickWord = (el, word) => clickCanvas(el, { word, button: 'right' });

const h1 = frame.locator('h1').first();

step('an inspector field offers the suggestions for a misspelled word');
// The canvas is scaled to fit beside the panels, so select the heading with a click on the element itself.
await h1.dispatchEvent('click');
const original = await h1.innerText();
const headingField = await eventually(async () => {
  for (const f of await win.locator('#dock-panel-inspect').getByRole('textbox').all()) if ((await f.inputValue()) === original) return f;
  throw new Error('the inspector shows the heading in a text field');
});
await headingField.focus();
await headingField.press(`${MOD}+a`);
await headingField.pressSequentially('recieve confirmation', { delay: 20 });
// Saved as its own step: the correction below is then one step of its own (field commits within 4s merge).
await headingField.press('Enter');
await eventually(async () => assert.match(await pages(), /"recieve confirmation"/, 'the misspelled heading is saved'));
await win.waitForTimeout(4500);
await headingField.focus();
await headingField.press(`${MOD}+a`);
await headingField.pressSequentially('recieve confirmation', { delay: 20 });
await headingField.press('Home');
await settle();
const fieldBox = await headingField.boundingBox();
const fieldMenu = await nextWritingMenu(async () => {
  // Inside the first word: the field's padding is narrower than this, and the word is wider.
  await win.mouse.click(fieldBox.x + 24, fieldBox.y + fieldBox.height / 2, { button: 'right' });
});
assertWritingMenu(fieldMenu, 'inspector field');
assert.equal(fieldMenu.inPreview, false, 'the right-click came from the editor, not the preview');
assert.equal(await openMenus(), 0, 'the editor opens no menu of its own');

step('choosing a suggestion corrects the field, and Edit → Undo and Redo move it like typing');
const rev = await revision();
await choose('receive');
await eventually(async () => assert.equal(await headingField.inputValue(), 'receive confirmation', 'the suggestion replaces the misspelled word'));
assert.equal(await win.evaluate(() => document.activeElement?.tagName), 'INPUT', 'the field keeps focus');
await editMenu('edit-undo');
await eventually(async () => assert.equal(await headingField.inputValue(), 'recieve confirmation', 'Undo puts the misspelling back'));
await editMenu('edit-redo');
await eventually(async () => assert.equal(await headingField.inputValue(), 'receive confirmation', 'Redo corrects it again'));
await settle();
assert.equal(await revision(), rev, 'the field’s own history leaves the project alone');

step('the correction saves, and undoing the project takes it back');
await headingField.press('Enter');
await eventually(async () => assert.match(await pages(), /"receive confirmation"/, 'the corrected heading is saved'));
await eventually(async () => assert.equal(await h1.innerText(), 'receive confirmation', 'the preview shows the correction'));
await win.locator('.rail [aria-label="Layers"]').click();
const row = win.locator('[role="tree"] [role="treeitem"]').first();
await row.click();
await row.focus();
await editMenu('edit-undo');
await eventually(async () => assert.match(await pages(), /"recieve confirmation"/, 'Undo restores the heading as it was saved before the correction'));
assert.doesNotMatch(await pages(), /"receive confirmation"/, 'the correction is undone');
await eventually(async () => assert.equal(await h1.innerText(), 'recieve confirmation', 'the preview shows it'));
// Layers scales the canvas down beside it: close it again, so clicks on the page land where they aim.
await win.locator('.rail [aria-label="Layers"]').click();
await eventually(async () => assert.equal(await win.locator('.rail [aria-label="Layers"]').getAttribute('aria-pressed'), 'false', 'Layers is closed'));
await settle();

step('site copy being edited offers the suggestions for the word under the pointer');
await clickCanvas(h1);
await settle();
await dblclickCanvas(h1);
await eventually(async () => assert.ok(await h1.getAttribute('contenteditable'), 'the heading is being edited'));
await win.keyboard.type('Gret recieve confirmation', { delay: 20 });
await settle();
const chip = async () => win.locator('.ov-chip').first().innerText();
const chipBefore = await chip();
const inlineMenu = await nextWritingMenu(() => rightClickWord(h1, 'recieve'));
assertWritingMenu(inlineMenu, 'inline heading');
assert.equal(inlineMenu.inPreview, true, 'the right-click came from the preview');
await settle();
assert.equal(await openMenus(), 0, 'the element actions stay closed');
assert.equal(await chip(), chipBefore, 'the selection stays on the heading');
assert.ok(await h1.getAttribute('contenteditable'), 'the heading is still being edited');

step('choosing a suggestion corrects the word being edited, and Edit → Undo and Redo move it like typing');
const inlineRev = await revision();
await choose('receive');
await eventually(async () => assert.equal(await h1.innerText(), 'Gret receive confirmation', 'the suggestion replaces the word'));
assert.ok(await h1.getAttribute('contenteditable'), 'the heading is still being edited');
await editMenu('edit-undo');
await eventually(async () => assert.equal(await h1.innerText(), 'Gret recieve confirmation', 'Undo puts the misspelling back'));
await editMenu('edit-redo');
await eventually(async () => assert.equal(await h1.innerText(), 'Gret receive confirmation', 'Redo corrects it again'));
await settle();
assert.equal(await revision(), inlineRev, 'the edit’s own history leaves the project alone');
await win.keyboard.press('Enter');
await eventually(async () => assert.match(await pages(), /"Gret receive confirmation"/, 'the corrected heading is saved'));

step('a correction inside bold rich text keeps its formatting');
const found = frame.locator('.so-rich', { hasText: 'That conversation shapes' }).first();
// Found by its words, then held by its place on the page: the words are about to change.
const rich = frame.locator(`.so-rich[data-so-node="${await found.getAttribute('data-so-node')}"][data-so-ctx="${await found.getAttribute('data-so-ctx')}"]`);
await rich.scrollIntoViewIfNeeded();
await settle();
await clickCanvas(rich);
await settle();
await dblclickCanvas(rich);
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited'));
await win.keyboard.type('We ', { delay: 20 });
await win.keyboard.press(`${MOD}+b`);
await win.keyboard.type('recieve', { delay: 20 });
await win.keyboard.press(`${MOD}+b`);
await win.keyboard.type(' every enquiry', { delay: 20 });
await settle();
const richMenu = await nextWritingMenu(() => rightClickWord(rich, 'recieve'));
assertWritingMenu(richMenu, 'rich text');
await choose('receive');
// Typing a space next to a bold toggle can leave a non-breaking space: compare the words.
const words = (t) => t.replace(/\s+/g, ' ');
await eventually(async () => assert.equal(words(await rich.innerText()), 'We receive every enquiry', 'the suggestion replaces the word'));
assert.equal(await rich.locator('b, strong').innerText(), 'receive', 'the corrected word is still bold, and only it');
await win.keyboard.press(`${MOD}+Enter`);
const stored = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    for (const n of Object.values(s.state.pages[s.state.site.homePageId].nodes)) {
      for (const b of Array.isArray(n.props?.body) ? n.props.body : []) if (b.spans?.some((x) => x.text === 'receive')) return b.spans.map((x) => ({ ...x, text: x.text.replace(/\s+/g, ' ') }));
    }
    return null;
  });
await eventually(async () => assert.deepEqual(await stored(), [{ text: 'We ' }, { text: 'receive', strong: true }, { text: ' every enquiry' }], 'the bold correction is saved as written'));

step('a right-click on a section still opens its element actions');
await h1.scrollIntoViewIfNeeded();
await settle();
await clickCanvas(h1);
await settle();
await clickCanvas(h1, { button: 'right' });
await eventually(async () => assert.equal(await openMenus(), 1, 'the element actions open'));
assert.equal(await win.locator('[role="menu"]').getByRole('menuitem', { name: /Ask AI about this/ }).count(), 1, 'with the element’s actions');
await win.keyboard.press('Escape');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nspelling: passed');
