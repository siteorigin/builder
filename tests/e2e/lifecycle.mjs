// Leaving a project never drops what is still being typed: native Close Project, switching projects, New
// Project, closing the window and quitting all save a focused Inspector field first; a value that cannot be
// saved asks to keep editing or leave without it (#79). The open project stays open, with its page and
// selection, until the project replacing it has opened: New project and a project to trust are asked over it,
// and cancelling them or a damaged project leaves it as it was (#80). Needs no preview: edits go through the
// Inspector.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, answerChoosers, chooseMenu, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('lifecycle');
const dirA = join(WORK, 'sites', 'quayside-studio');
const dirB = join(WORK, 'sites', 'quayside-studio-b');

let { app, win, errors } = await launch(WORK);

/** Choose a File menu item by its label through its own handler, as the menu bar (or its shortcut) does. */
const menu = (label) => chooseMenu(app, ['File', label]);

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

step('the toolbar mark (All projects) leaves by the same route: it asks, and Keep editing keeps the editor (#517)');
const mark = win.locator('.toolbar').getByRole('button', { name: 'All projects', exact: true });
assert.equal(await mark.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag', 'the mark is a click target inside the drag region');
await mark.click();
await dialog.waitFor();
await dialog.getByRole('button', { name: 'Keep editing' }).click();
await eventually(async () => assert.equal(await titleField().evaluate((el) => el === document.activeElement), true, 'focus is back in the title field'));
assert.equal(await titleField().inputValue(), '', 'what was typed is still there');
assert.equal(await win.locator('.editor').count(), 1, 'the project stayed open');
assert.equal(await win.locator('.welcome').count(), 0, 'Welcome never appeared');

step('Leave without it discards the invalid draft');
await menu('Close Project');
await dialog.waitFor();
await dialog.getByRole('button', { name: 'Leave without it' }).click();
await win.waitForSelector('.welcome');
assert.equal(homeDoc(dirB).title, homeTitle, 'the saved title is unchanged');

/** The folder of the project open now, as the app names it. */
const openDir = () => win.evaluate(() => window.builder.project.snapshot().then((s) => s?.dir ?? null));
/** The next Open Project picker answers with the project in `dir`: macOS's picker takes the folder, the others its
 *  manifest. One picker each: every open that shows one answers it again. */
const pickFolder = (dir) => answerChoosers(app, [{ dialog: 'open', title: 'Open a SiteOrigin Builder project', paths: [process.platform === 'darwin' ? dir : join(dir, 'siteorigin.project.json')] }]);
/** The open project is still the one being edited: no Welcome, the same project, the hero still selected. */
async function stillEditing(dir, text, what) {
  assert.equal(await win.locator('.welcome').count(), 0, `${what}: Welcome never appeared`);
  assert.equal(await win.locator('.editor').count(), 1, `${what}: the editor is still open`);
  assert.equal(await openDir(), realpathSync(dir), `${what}: the same project is open`);
  assert.equal(await heading.inputValue(), text, `${what}: the hero is still selected, its heading shown`);
}

step('File > New Project opens over the project, saving the focused field, and Escape leaves the project as it was');
await openProject(dirA);
heading = await heroHeading();
await typeDraft(heading, 'Kept through New Project');
await menu('New Project…');
const newProject = win.getByRole('dialog', { name: 'New project' });
await newProject.waitFor();
await eventually(() => assert.equal(savedHeading(dirA), 'Kept through New Project'));
await win.keyboard.press('Escape');
await newProject.waitFor({ state: 'detached' });
await stillEditing(dirA, 'Kept through New Project', 'after cancelling New project');

step('a project that needs trust is asked about over the open project, and Cancel leaves it as it was');
const dirC = join(WORK, 'sites', 'quayside-studio-c');
cpSync(dirA, dirC, { recursive: true, filter: (src) => !/[/\\](node_modules|\.siteorigin)$/.test(src) });
await pickFolder(dirC);
await menu('Open Project…');
const trustPrompt = win.getByRole('dialog', { name: 'Trust this project?' });
await trustPrompt.waitFor();
assert.match(await trustPrompt.innerText(), /quayside-studio-c/, 'the prompt names the project that was picked');
await trustPrompt.getByRole('button', { name: 'Cancel' }).click();
await trustPrompt.waitFor({ state: 'detached' });
await stillEditing(dirA, 'Kept through New Project', 'after cancelling the trust prompt');

step('a damaged project names its file and leaves the open project as it was; repaired, it opens');
const manifestB = join(dirB, 'siteorigin.project.json');
const goodManifest = readFileSync(manifestB, 'utf8');
writeFileSync(manifestB, goodManifest.slice(0, 40));
await pickFolder(dirB);
await menu('Open Project…');
// Each error names its own folder in full, in quotes (one project's folder name starts with the other's).
const damaged = (dir) => win.locator('.toast.error', { hasText: `"${realpathSync(dir)}"` }).filter({ hasText: 'siteorigin.project.json' });
await damaged(dirB).waitFor();
await stillEditing(dirA, 'Kept through New Project', 'after a damaged project failed to open');
writeFileSync(manifestB, goodManifest);
await pickFolder(dirB);
await menu('Open Project…');
await eventually(async () => assert.equal(await openDir(), realpathSync(dirB), 'the repaired project opens'));
await win.waitForSelector('.editor');

step('from Welcome too: a damaged project names its file, and opens once repaired');
await menu('Close Project');
await win.waitForSelector('.welcome');
// Not trusted yet: the check before the trust prompt explains it, and once repaired the prompt opens it.
const manifestC = join(dirC, 'siteorigin.project.json');
const goodC = readFileSync(manifestC, 'utf8');
writeFileSync(manifestC, goodC.slice(0, 40));
const openButton = win.locator('.welcome-action:not([disabled])', { hasText: 'Open project…' });
await pickFolder(dirC);
await openButton.click();
await damaged(dirC).waitFor();
assert.equal(await win.locator('.welcome').count(), 1, 'Welcome is still shown');
writeFileSync(manifestC, goodC);
await pickFolder(dirC);
await openButton.click();
await trustPrompt.waitFor();
await trustPrompt.getByRole('button', { name: 'Trust and open' }).click();
await eventually(async () => assert.equal(await openDir(), realpathSync(dirC), 'the repaired project opens from Welcome'));
await menu('Close Project');
await win.waitForSelector('.welcome');
// Already trusted (a recent project): the damage is explained the same way, and the card opens it once repaired.
const manifestA = join(dirA, 'siteorigin.project.json');
const goodA = readFileSync(manifestA, 'utf8');
writeFileSync(manifestA, goodA.slice(0, 40));
const openRecent = (dir) =>
  eventually(async () => {
    const clicked = await win.evaluate((d) => {
      const card = [...document.querySelectorAll('.recent-card')].find((b) => b.title.endsWith(`\n${d}`) && !b.disabled);
      card?.click();
      return !!card;
    }, realpathSync(dir));
    assert.equal(clicked, true, 'the recent project can be chosen');
  });
await openRecent(dirA);
await damaged(dirA).waitFor();
assert.equal(await win.locator('.welcome').count(), 1, 'Welcome is still shown');
writeFileSync(manifestA, goodA);
await openRecent(dirA);
await win.waitForSelector('.editor');
assert.equal(await openDir(), realpathSync(dirA), 'the repaired project opens from Welcome');

step('the toolbar mark, pressed from the keyboard or clicked, saves the focused field and lands on Welcome (#517)');
heading = await heroHeading();
await typeDraft(heading, 'Kept through All projects');
await mark.focus();
await win.keyboard.press('Enter');
await win.waitForSelector('.welcome');
assert.equal(savedHeading(dirA), 'Kept through All projects', 'the typed heading is on disk');
await openProject(dirA);
heading = await heroHeading();
await typeDraft(heading, 'Kept through clicking All projects');
await mark.click();
await win.waitForSelector('.welcome');
assert.equal(savedHeading(dirA), 'Kept through clicking All projects', 'a click saves the focused field too');

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
