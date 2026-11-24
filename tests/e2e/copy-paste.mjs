// Copy and Paste in the menus, and Paste right after switching pages (#200): Gallery is copied from Home with the
// pointer alone and pasted onto Contact; ⌘V works the instant the toolbar's page switcher or the command menu has
// picked the page (focus is left on the switcher, outside every control the shortcut used to listen to); the same
// items are in the chip's More actions, the Layers menu, the Inspector's actions and the command menu, Paste unavailable
// until something is copied; and a section can be pasted inside a component edited everywhere.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('copy-paste');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Copy Paste Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

/** The names of a page's sections, top to bottom. */
const sectionsOn = (title) =>
  win.evaluate(async (t) => {
    const s = await window.builder.project.snapshot();
    const p = Object.values(s.state.pages).find((x) => x.title === t);
    return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name ?? p.nodes[id].kind);
  }, title);
const count = async (title, name) => (await sectionsOn(title)).filter((n) => n === name).length;
const row = (name) => win.locator('[role="tree"] .list-item', { hasText: name }).first();
const pageRow = (title) => win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first();
const menuItems = async () => (await win.locator('[role="menu"] [role^="menuitem"]').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const closeMenu = async () => {
  await win.keyboard.press('Escape');
  await win.locator('[role="menu"]').waitFor({ state: 'detached' });
};
/** The item of the open menu with this name: its state, and the item itself. */
/** The menu entries for Copy and Paste themselves, not Copy style and Paste style. */
const COPY = /^Copy(?! style)/;
const PASTE = /^Paste(?! style)/;
const item = (name) => win.locator('[role="menu"]').getByRole('menuitem', { name: new RegExp(`^${name}(?! style)`) });
const editorFocus = () => win.evaluate(() => document.activeElement?.closest('.toolbar') !== null && document.activeElement?.closest('.toolbar') !== undefined);
const openCmdk = async (q) => {
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  if (q) await win.keyboard.type(q);
};

assert.equal(await count('Home', 'Gallery'), 1, 'Home starts with one Gallery');
assert.equal(await count('Contact', 'Gallery'), 0, 'Contact starts without one');
await win.locator('.rail [aria-label="Layers"]').click();

step('Copy and Paste are in the Layers menu, and Paste is unavailable until something is copied');
await row('Gallery').click({ button: 'right' });
await win.locator('[role="menu"]').waitFor();
let names = await menuItems();
assert.ok(names.some((n) => COPY.test(n)), `Copy is listed: ${names.join(' | ')}`);
assert.ok(names.some((n) => PASTE.test(n)), `Paste is listed: ${names.join(' | ')}`);
assert.equal(await item('Paste').getAttribute('aria-disabled'), 'true', 'Paste is unavailable with nothing copied');
assert.match(await item('Copy').innerText(), /(⌘|Ctrl\+)C/, 'Copy shows its shortcut');
await item('Copy').click();
await win.locator('.toast', { hasText: 'Copied Gallery' }).waitFor();

step('⌘V pastes the moment the toolbar’s page switcher has picked Contact, with focus still on the switcher');
await win.locator('.project-title').click();
await win.locator('[role="menu"]').waitFor();
await win.locator('[role="menu"] [role^="menuitem"]', { hasText: /^Contact/ }).click();
await win.locator('[role="menu"]').waitFor({ state: 'detached' });
await eventually(async () => assert.match(await win.locator('.project-title').innerText(), /Contact/, 'Contact is open'));
await eventually(async () => assert.equal(await editorFocus(), true, 'focus is left on the toolbar, outside the controls ⌘V used to listen to'));
await win.keyboard.press(`${MOD}+v`);
await eventually(async () => assert.equal(await count('Contact', 'Gallery'), 1, 'Gallery is pasted onto Contact'));
await win.waitForTimeout(300);
assert.equal(await count('Contact', 'Gallery'), 1, 'and only once');
assert.equal(await count('Home', 'Gallery'), 1, 'Home still has its own');
assert.equal(await win.locator('.toast.error').count(), 0, 'no error is shown');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await count('Contact', 'Gallery'), 0, 'one Undo takes the paste back'));

step('⌘V pastes the moment the command menu has picked About, with focus back on the switcher');
await win.locator('.project-title').focus();
await openCmdk('go to about');
await win.keyboard.press('Enter');
await win.locator('.cmdk').waitFor({ state: 'detached' });
await eventually(async () => assert.match(await win.locator('.project-title').innerText(), /About/, 'About is open'));
await eventually(async () => assert.equal(await editorFocus(), true, 'focus is back on the switcher'));
await win.keyboard.press(`${MOD}+v`);
await eventually(async () => assert.equal(await count('About', 'Gallery'), 1, 'Gallery is pasted onto About'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await count('About', 'Gallery'), 0));

step('⌘V stays out of a text field: the toolbar’s width field keeps its own paste');
await win.getByLabel('Preview width in pixels').focus();
const aboutJson = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    return JSON.stringify(Object.values(s.state.pages).find((x) => x.title === 'About'));
  });
await win.waitForTimeout(500);
const before = await aboutJson();
await win.keyboard.press(`${MOD}+v`);
await win.waitForTimeout(400);
assert.equal(await count('About', 'Gallery'), 0, 'nothing is pasted from a text field');
assert.equal(await aboutJson(), before, 'and the page is unchanged');
await win.locator('.project-title').focus();

step('Paste from the Layers menu goes after the section it names, and the same items are in the other menus');
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('Contact').click();
await win.locator('.rail [aria-label="Layers"]').click();
const contactFirst = (await sectionsOn('Contact'))[0];
await row(contactFirst).click({ button: 'right' });
await win.locator('[role="menu"]').waitFor();
assert.notEqual(await item('Paste').getAttribute('aria-disabled'), 'true', 'Paste is available now');
await item('Paste').click();
await eventually(async () => assert.deepEqual((await sectionsOn('Contact')).slice(0, 2), [contactFirst, 'Gallery'], 'Gallery lands right after the section the menu named'));
// The pasted section is selected: its chip's More actions, and the Inspector's, list both.
await win.locator('.ov-chip [aria-label="More actions"]').click();
await win.locator('[role="menu"]').waitFor();
names = await menuItems();
assert.ok(names.some((n) => COPY.test(n)) && names.some((n) => PASTE.test(n)), `the chip’s More actions lists Copy and Paste: ${names.join(' | ')}`);
await closeMenu();
await win.getByRole('button', { name: /^More actions for / }).click();
await win.locator('[role="menu"]').waitFor();
names = await menuItems();
assert.ok(names.some((n) => COPY.test(n)) && names.some((n) => PASTE.test(n)), `the Inspector’s More actions lists Copy and Paste: ${names.join(' | ')}`);
await closeMenu();
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await count('Contact', 'Gallery'), 0));

step('the command menu copies and pastes too');
await row(contactFirst).click();
await openCmdk('copy the selected');
await win.locator('.cmdk [role="option"]', { hasText: 'Copy the selected section or element' }).click();
await win.locator('.cmdk').waitFor({ state: 'detached' });
await win.locator('.toast', { hasText: `Copied ${contactFirst}` }).waitFor();
await openCmdk('paste the copied');
await win.locator('.cmdk [role="option"]', { hasText: 'Paste the copied section or element' }).click();
await win.locator('.cmdk').waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await count('Contact', contactFirst), 2, 'the copied section is pasted after the selection'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await count('Contact', contactFirst), 1));

step('an empty page offers Paste where its first section would go, and ⌘V works from its buttons');
assert.ok((await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'page.create', title: 'Blank' }] }, { label: 'Add page' }))).ok);
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('Blank').click();
await eventually(async () => assert.deepEqual(await sectionsOn('Blank'), [], 'the new page has no sections'));
// Pointer only: the empty page's card in the editor.
await win.getByTestId('canvas-empty-page').getByRole('button', { name: /^Paste / }).click();
await eventually(async () => assert.equal(await count('Blank', contactFirst), 1, 'the copied section is the page’s first'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual(await sectionsOn('Blank'), []));
// And the same in Layers, where ⌘V also gets through from the Add sections button it stops other keys at.
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.layers-empty').getByRole('button', { name: /^Paste / }).click();
await eventually(async () => assert.equal(await count('Blank', contactFirst), 1, 'Layers’ own button pastes it too'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual(await sectionsOn('Blank'), []));
await win.locator('.layers-empty').getByRole('button', { name: /Add sections/ }).focus();
await win.keyboard.press(`${MOD}+v`);
await eventually(async () => assert.equal(await count('Blank', contactFirst), 1, '⌘V from the Add sections button pastes it'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual(await sectionsOn('Blank'), []));

step('Paste is offered inside a component edited everywhere, and the copy lands inside it');
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('Home').click();
await win.locator('.rail [aria-label="Layers"]').click();
await row('Gallery').click();
await win.keyboard.press(`${MOD}+c`);
await win.locator('.toast', { hasText: 'Copied Gallery' }).last().waitFor();
await row('Services grid').click();
const componentSection = win.locator('.section-head', { hasText: 'Component' });
if ((await componentSection.getAttribute('aria-expanded')) === 'false') await componentSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.mode-band').waitFor();
const design = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const def = Object.values(s.state.components).find((d) => d.owner === 'project' && d.name === 'Services grid');
    const nodes = Object.values(def.tree.nodes);
    const gallery = nodes.find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.name === 'Gallery');
    const parent = gallery && nodes.find((n) => n.kind === 'element' && n.children.includes(gallery.id));
    return { id: def.id, size: nodes.length, root: def.tree.rootIds[0], parent: parent?.id, galleries: nodes.filter((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.name === 'Gallery').length };
  });
const designBefore = await design();
assert.equal(designBefore.galleries, 0, 'the component starts without a Gallery');
// ⌘V from the page, with the component's root selected, pastes inside it.
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'the component’s design is outlined'));
await win.keyboard.press(`${MOD}+v`);
await eventually(async () => assert.equal((await design()).galleries, 1, 'a Gallery is pasted inside the component'));
assert.ok((await design()).size > designBefore.size, 'its parts are in the component’s design');
assert.equal((await design()).parent, designBefore.root, 'with nothing picked inside it, it goes in the component’s root');
assert.equal(await count('Home', 'Gallery'), 1, 'the page it was copied from is unchanged');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal((await design()).galleries, 0, 'one Undo takes it out of the component again'));
// The Layers menu of the component's own root offers Paste, and the paste lands inside the component too.
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click({ button: 'right' });
await win.locator('[role="menu"]').waitFor();
assert.notEqual(await item('Paste').getAttribute('aria-disabled'), 'true', 'Paste is available on the component’s root');
assert.equal(await win.locator('[role="menu"]').getByRole('menuitem', { name: COPY }).count(), 0, 'Copy is not offered inside a component');
await item('Paste').click();
await eventually(async () => assert.equal((await design()).galleries, 1, 'the menu’s Paste lands inside the component'));
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncopy-paste: passed');
