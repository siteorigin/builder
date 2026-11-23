// Leaving a project never drops what is still being typed: native Close Project, switching projects, New
// Project, closing the window and quitting all save a focused Inspector field first; a value that cannot be
// saved asks to keep editing or leave without it (#79). Needs no preview: edits go through the Inspector.
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('lifecycle');
const dirA = join(WORK, 'sites', 'quayside-studio');
const dirB = join(WORK, 'sites', 'quayside-studio-b');

let { app, win, errors } = await launch(WORK);

/** Click a native menu item by its label, as choosing it in the menu bar (or its shortcut) does. */
const menu = (label) =>
  app.evaluate(({ Menu }, l) => {
    const find = (items) => {
      for (const i of items) {
        if (i.label === l) return i;
        const f = i.submenu && find(i.submenu.items);
        if (f) return f;
      }
    };
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error(`No menu item ${l}`);
    item.click();
  }, label);

const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const homeId = (dir) => readJson(dir, 'siteorigin/site.json').homePageId;
const homeDoc = (dir) => readJson(dir, `siteorigin/pages/${homeId(dir)}.json`);
/** The split hero's saved heading, read from disk. */
const savedHeading = (dir) => {
  const page = homeDoc(dir);
  const hero = page.rootIds.map((id) => page.nodes[id]).find((n) => n.kind === 'instance' && n.props && 'heading' in n.props);
  return hero.props.heading;
};
const inspector = () => win.locator('#dock-panel-inspect');
const status = () => win.locator('.toolbar .save-state');
const announced = () => win.locator('.toolbar .sr-only[role="status"]');

async function openProject(dir) {
  const r = await win.evaluate((d) => window.builder.projects.open(d), dir);
  assert.ok(r.ok, `the project opens: ${JSON.stringify(r)}`);
  await win.waitForSelector('.editor');
}

/** Select Home > Split hero from Layers and return its Heading field. */
async function heroHeading() {
  const row = win.locator('.list-item', { hasText: 'Split hero' }).first();
  if (!(await row.isVisible().catch(() => false))) await win.locator('.rail [aria-label="Layers"]').click();
  await row.click();
  const field = inspector().getByRole('textbox', { name: 'Heading', exact: true });
  await field.waitFor();
  return field;
}

/** Type into a field and leave it focused: the change is only a draft. */
async function typeDraft(field, text) {
  await field.fill(text);
  await eventually(async () => assert.equal(await status().innerText(), 'Unsaved change', 'the toolbar shows the unsaved draft'));
  assert.equal(await field.evaluate((el) => el === document.activeElement), true, 'the field still has focus');
}

step('create a Business site');
const created = await win.evaluate((o) => window.builder.projects.create(o), { name: 'Quayside Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
assert.ok(created.ok, `project created: ${created.message ?? ''}`);
await win.waitForSelector('.editor');

step('Cmd+S in a focused Browser title saves it (the explicit save the lifecycle actions now share)');
const browserTitle = inspector().getByRole('textbox', { name: 'Browser title', exact: true });
await browserTitle.fill('Quayside Studio | Home');
await win.keyboard.press(`${MOD}+s`);
await eventually(() => assert.equal(homeDoc(dirA).seo.title, 'Quayside Studio | Home', 'the browser title is on disk'));
await win.getByText('All changes are saved on this computer.').waitFor();

step('the saved status is not announced over an unsaved change');
let heading = await heroHeading();
await heading.fill('Committed before the draft');
await heading.evaluate((el) => el.blur());
await eventually(async () => assert.equal((await announced().innerText()).trim(), 'All changes saved', 'a completed save is announced'));
await typeDraft(heading, 'Kept through Close Project');
await eventually(async () => assert.ok(!(await announced().innerText()).includes('All changes saved'), 'the status region stops claiming everything is saved'));

step('File > Close Project saves the focused Inspector field');
await menu('Close Project');
await win.waitForSelector('.welcome');
assert.equal(savedHeading(dirA), 'Kept through Close Project', 'the typed heading is on disk');

step('switching to another project saves the focused field first');
cpSync(dirA, dirB, { recursive: true, filter: (src) => !/[/\\](node_modules|\.siteorigin)$/.test(src) });
const trusted = await win.evaluate((d) => window.builder.projects.trustAndOpen(d), dirB);
assert.ok(trusted.ok, 'the copy opens');
await win.waitForSelector('.editor');
await openProject(dirA);
heading = await heroHeading();
await typeDraft(heading, 'Kept through switching projects');
await openProject(dirB);
assert.equal(savedHeading(dirA), 'Kept through switching projects', 'the heading typed in the first project is on its disk');
assert.equal(savedHeading(dirB), 'Kept through Close Project', 'the other project is untouched');

step('an invalid draft asks before leaving, and Keep editing returns to it');
const titleField = () => inspector().getByRole('textbox', { name: 'Title', exact: true });
// With nothing selected the Inspector shows the page's settings.
await win.keyboard.press('Escape');
await titleField().waitFor();
const homeTitle = homeDoc(dirB).title;
await titleField().fill('');
await menu('Close Project');
const dialog = win.getByRole('dialog', { name: 'Leave without your last change?' });
await dialog.waitFor();
assert.match(await dialog.innerText(), /Title/, 'the question names the field');
await win.waitForTimeout(800);
await dialog.getByRole('button', { name: 'Keep editing' }).click();
await eventually(async () => assert.equal(await titleField().evaluate((el) => el === document.activeElement), true, 'focus is back in the title field'));
assert.equal(await titleField().inputValue(), '', 'what was typed is still there');
assert.equal(await status().innerText(), 'Unsaved change', 'the toolbar says the returned text is not saved');
assert.equal(await win.locator('.editor').count(), 1, 'the project stayed open');
assert.equal(homeDoc(dirB).title, homeTitle, 'nothing invalid was saved');

step('closing the window or quitting with an invalid draft asks too, and Keep editing keeps the app open');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await dialog.waitFor();
await dialog.getByRole('button', { name: 'Keep editing' }).click();
await eventually(async () => assert.equal(await titleField().evaluate((el) => el === document.activeElement), true, 'back in the title field'));
assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'the window stayed open');
await app.evaluate(({ app: a }) => a.quit());
await dialog.waitFor();
await dialog.getByRole('button', { name: 'Keep editing' }).click();
await eventually(async () => assert.equal(await titleField().evaluate((el) => el === document.activeElement), true, 'back in the title field again'));
assert.equal(await titleField().inputValue(), '', 'the typed text survived both questions');
assert.equal(await win.locator('.editor').count(), 1, 'the app is still running with the project open');

step('Leave without it discards the invalid draft');
await menu('Close Project');
await dialog.waitFor();
await dialog.getByRole('button', { name: 'Leave without it' }).click();
await win.waitForSelector('.welcome');
assert.equal(homeDoc(dirB).title, homeTitle, 'the saved title is unchanged');

step('File > New Project saves the focused field before Welcome');
await openProject(dirA);
heading = await heroHeading();
await typeDraft(heading, 'Kept through New Project');
await menu('New Project…');
await win.waitForSelector('.welcome');
await win.getByRole('dialog', { name: 'New project' }).waitFor();
assert.equal(savedHeading(dirA), 'Kept through New Project');
await win.keyboard.press('Escape');

step('closing the window saves the focused field');
await openProject(dirA);
heading = await heroHeading();
await typeDraft(heading, 'Kept through closing the window');
const closed = win.waitForEvent('close');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
await closed;
await eventually(() => assert.equal(savedHeading(dirA), 'Kept through closing the window'));
assert.deepEqual(errors, [], 'no page errors');
await app.close();

step('quitting saves the focused field');
({ app, win, errors } = await launch(WORK));
await openProject(dirA);
heading = await heroHeading();
await typeDraft(heading, 'Kept through quitting');
const exited = app.waitForEvent('close');
await app.evaluate(({ app: a }) => a.quit());
await exited;
assert.equal(savedHeading(dirA), 'Kept through quitting', 'the typed heading is on disk after quitting');
assert.deepEqual(errors, [], 'no page errors');

cleanup();
console.log('\nlifecycle: all checks passed');
