// The native File menu works from Welcome, from a project and, on macOS, from the running app with no window
// left: New Project and Open Project bring a window back and do what was asked once it is ready, and Export
// and Close Project are offered only while a project is open (#255). Needs no preview.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('menu');
const dirA = join(WORK, 'sites', 'harbour-bakery');

let { app, win, errors } = await launch(WORK);
const watch = (page) => page.on('pageerror', (e) => errors.push(String(e)));

/** The File menu's items by label: whether each is enabled, and its shortcut. */
const fileMenu = () =>
  app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    return Object.fromEntries(file.submenu.items.filter((i) => i.label).map((i) => [i.label, { enabled: i.enabled, accelerator: i.accelerator ?? null }]));
  });

/** Choose a File menu item, as clicking it in the menu bar or pressing its shortcut does. */
const choose = (label) =>
  app.evaluate(({ Menu }, l) => {
    const item = Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items.find((i) => i.label === l);
    if (!item) throw new Error(`No menu item ${l}`);
    if (!item.enabled) throw new Error(`${l} is disabled`);
    item.click();
  }, label);

/** Answer native folder pickers with `dir` (or cancel them), so no dialog appears during the test. Each picker
 *  records the id of the window it was shown over. */
const answerPicker = (dir) =>
  app.evaluate(({ dialog }, d) => {
    globalThis.pickerParents = [];
    dialog.showOpenDialog = async (w) => {
      globalThis.pickerParents.push(w?.id ?? null);
      return d ? { canceled: false, filePaths: [d] } : { canceled: true, filePaths: [] };
    };
  }, dir);
const pickerParents = () => app.evaluate(() => globalThis.pickerParents);

const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const windowId = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null);
const openProjectNow = () => win.evaluate(() => window.builder.project.snapshot()).then((snap) => snap?.dir ?? null);

/** Close the only window, as File > Close Window does. */
async function closeWindow() {
  const closed = win.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  assert.equal(await windowCount(), 0, 'no window is left');
}

/** Choose a menu item with no window open: a new window comes up for it. */
async function chooseWithNoWindow(label) {
  const opened = app.waitForEvent('window', { timeout: 30000 });
  await choose(label);
  win = await opened;
  watch(win);
  await win.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await windowCount(), 1, 'exactly one window comes up');
}

const expectProjectItems = async (enabled, where) => {
  await eventually(async () => {
    const items = await fileMenu();
    assert.equal(items['Export…'].enabled, enabled, `Export is ${enabled ? 'enabled' : 'disabled'} ${where}`);
    assert.equal(items['Close Project'].enabled, enabled, `Close Project is ${enabled ? 'enabled' : 'disabled'} ${where}`);
    assert.equal(items['New Project…'].enabled, true, `New Project is enabled ${where}`);
    assert.equal(items['Open Project…'].enabled, true, `Open Project is enabled ${where}`);
  });
};
const newProjectDialog = () => win.getByRole('dialog', { name: 'New project' });
const exportDialog = () => win.getByRole('dialog', { name: 'Export your website' });

step('the File menu keeps its shortcuts');
const items = await fileMenu();
assert.equal(items['New Project…'].accelerator, 'CmdOrCtrl+Shift+N');
assert.equal(items['Open Project…'].accelerator, 'CmdOrCtrl+O');
assert.equal(items['Export…'].accelerator, 'CmdOrCtrl+E');
assert.equal(items['Close Project'].accelerator, 'CmdOrCtrl+Shift+W');

step('Welcome: Export and Close Project are unavailable, New Project opens its dialog');
await expectProjectItems(false, 'on Welcome');
await choose('New Project…');
await newProjectDialog().waitFor();
await win.keyboard.press('Escape');
await newProjectDialog().waitFor({ state: 'detached' });

step('a project: Export and Close Project become available and act');
const created = await win.evaluate((o) => window.builder.projects.create(o), { name: 'Harbour Bakery', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
assert.ok(created.ok, `project created: ${created.message ?? ''}`);
await win.waitForSelector('.editor');
await expectProjectItems(true, 'with a project open');
await choose('Export…');
await exportDialog().waitFor();
await win.keyboard.press('Escape');
await exportDialog().waitFor({ state: 'detached' });
await choose('Close Project');
await win.waitForSelector('.welcome');
await expectProjectItems(false, 'after Close Project');

step('Welcome: Open Project shows the folder picker and opens the chosen project');
await answerPicker(dirA);
await choose('Open Project…');
await win.waitForSelector('.editor');
await expectProjectItems(true, 'after Open Project');

step('a project: Open Project switches to the chosen project, New Project leaves for Welcome and its dialog');
const opening = () => win.evaluate(() => window.builder.project.snapshot()).then((snap) => snap?.workspaceKey ?? null);
const before = await opening();
await answerPicker(dirA);
await choose('Open Project…');
await eventually(async () => {
  const now = await opening();
  assert.ok(now && now !== before, 'the project was opened again');
});
await win.waitForSelector('.editor');
assert.deepEqual(await pickerParents(), [await windowId()], 'one folder picker, shown over the window');
await choose('New Project…');
await win.waitForSelector('.welcome');
await newProjectDialog().waitFor();
await win.keyboard.press('Escape');
await expectProjectItems(false, 'after leaving for a new project');

if (process.platform === 'darwin') {
  step('no window (macOS): New Project brings up a window with its dialog');
  await closeWindow();
  await expectProjectItems(false, 'with no window and no project');
  await chooseWithNoWindow('New Project…');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await newProjectDialog().waitFor();
  await win.keyboard.press('Escape');

  step('no window (macOS): Open Project brings up a window, then the folder picker over it, and opens the project');
  await closeWindow();
  await answerPicker(dirA);
  await chooseWithNoWindow('Open Project…');
  await win.waitForSelector('.editor', { timeout: 60000 });
  assert.deepEqual(await pickerParents(), [await windowId()], 'one folder picker, shown over the new window');
  await expectProjectItems(true, 'after opening a project with no window');

  step('no window with a project open (macOS): Export brings the editor back with its dialog');
  await closeWindow();
  await expectProjectItems(true, 'with no window and the project still open');
  await chooseWithNoWindow('Export…');
  await win.waitForSelector('.editor', { timeout: 60000 });
  await exportDialog().waitFor();
  await win.keyboard.press('Escape');
  await exportDialog().waitFor({ state: 'detached' });

  step('no window with a project open (macOS): New Project closes the project, then shows its dialog');
  await closeWindow();
  await chooseWithNoWindow('New Project…');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await newProjectDialog().waitFor();
  assert.equal(await openProjectNow(), null, 'the project was closed');
  await expectProjectItems(false, 'after leaving the project for a new one');
  await win.keyboard.press('Escape');

  step('no window with a project open (macOS): Close Project brings up the window and closes the project');
  const reopened = await win.evaluate((d) => window.builder.projects.open(d), dirA);
  assert.ok(reopened.ok, `the project opens again: ${JSON.stringify(reopened)}`);
  await win.waitForSelector('.editor');
  await closeWindow();
  await chooseWithNoWindow('Close Project');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  assert.equal(await openProjectNow(), null, 'the project was closed');
  await expectProjectItems(false, 'after closing the project with no window');

  step('no window (macOS): a cancelled folder picker leaves Welcome as it was');
  await closeWindow();
  await answerPicker(null);
  await chooseWithNoWindow('Open Project…');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await eventually(async () => assert.deepEqual(await pickerParents(), [await windowId()], 'the picker was shown over the new window'));
  await expectProjectItems(false, 'after a cancelled Open Project');
}

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nmenu: all checks passed');
