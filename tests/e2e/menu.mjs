// The native File menu works from Welcome, from a project and, on macOS, from the running app with no window
// left: New Project and Open Project bring a window back and do what was asked once it is ready, and Export
// and Close Project are offered only while a project is open (#255). Needs no preview.
//
// Menu items are chosen through Menu.getApplicationMenu(), which runs the same click handler as the menu bar and
// the item's shortcut. Headless runs cannot press native key equivalents, so the shortcuts are checked as the
// accelerators the items carry.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('menu');
const dirA = join(WORK, 'sites', 'harbour-bakery');
const dirB = join(WORK, 'sites', 'quay-books');

let { app, win, errors } = await launch(WORK);
// Every later window reports its page errors from its first moment.
app.on('window', (page) => page.on('pageerror', (e) => errors.push(String(e))));
// Count the windows the app creates, to tell one window from two that came up for the same request.
await app.evaluate(({ app: a }) => {
  globalThis.windowsCreated = 0;
  a.on('browser-window-created', () => globalThis.windowsCreated++);
});
const windowsCreated = () => app.evaluate(() => globalThis.windowsCreated);

/** The File menu's items by label: whether each is enabled, and its shortcut. */
const fileMenu = () =>
  app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File');
    return Object.fromEntries(file.submenu.items.filter((i) => i.label).map((i) => [i.label, { enabled: i.enabled, accelerator: i.accelerator ?? null }]));
  });

/** Choose File menu items, one after the other in the same turn of the main process. */
const choose = (...labels) =>
  app.evaluate(({ Menu }, ls) => {
    const items = Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items;
    for (const l of ls) {
      const item = items.find((i) => i.label === l);
      if (!item) throw new Error(`No menu item ${l}`);
      if (!item.enabled) throw new Error(`${l} is disabled`);
      item.click();
    }
  }, labels);

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
/** Exactly one folder picker was shown, over the current window. */
const expectOnePicker = (where) =>
  eventually(async () => assert.deepEqual(await pickerParents(), [await windowId()], `one folder picker, shown over the window ${where}`));

const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const windowId = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null);
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const openDir = () => snapshot().then((snap) => snap?.dir ?? null);
const opening = () => snapshot().then((snap) => snap?.workspaceKey ?? null);
/** The editor shows the project named `name`, and the app has it open from `dir`. */
async function expectEditorFor(name, dir) {
  await win.locator('.toolbar .site', { hasText: name }).waitFor({ timeout: 60000 });
  assert.equal(await openDir(), dir, `${name} is the open project`);
}

/** Close the only window, as File > Close Window does. */
async function closeWindow() {
  const closed = win.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await eventually(async () => assert.equal(await windowCount(), 0, 'no window is left'));
}

/** Choose menu items with no window open: one new window comes up for them. */
async function chooseWithNoWindow(...labels) {
  const before = await windowsCreated();
  const opened = app.waitForEvent('window', { timeout: 30000 });
  await choose(...labels);
  win = await opened;
  await win.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await windowsCreated(), before + 1, 'exactly one window was created');
  assert.equal(await windowCount(), 1, 'exactly one window is open');
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
async function dismiss(dialog) {
  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
}

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
await dismiss(newProjectDialog());

step('a project: Export and Close Project become available and act');
for (const [name, dir] of [
  ['Quay Books', dirB],
  ['Harbour Bakery', dirA]
]) {
  const created = await win.evaluate((o) => window.builder.projects.create(o), { name, parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  assert.ok(created.ok, `${name} created: ${created.message ?? ''}`);
  await expectEditorFor(name, dir);
}
await expectProjectItems(true, 'with a project open');
await choose('Export…');
await exportDialog().waitFor();
await dismiss(exportDialog());
await choose('Close Project');
await win.waitForSelector('.welcome');
await expectProjectItems(false, 'after Close Project');

step('Welcome: Open Project shows the folder picker over the window and opens the chosen project');
await answerPicker(dirA);
await choose('Open Project…');
await expectEditorFor('Harbour Bakery', dirA);
await expectOnePicker('from Welcome');
await expectProjectItems(true, 'after Open Project');

step('a project: Open Project switches to the chosen project, New Project leaves for Welcome and its dialog');
await answerPicker(dirB);
await choose('Open Project…');
await expectEditorFor('Quay Books', dirB);
await expectOnePicker('from the editor');
await choose('New Project…');
await win.waitForSelector('.welcome');
await newProjectDialog().waitFor();
assert.equal(await openDir(), null, 'the project was closed');
await dismiss(newProjectDialog());
await expectProjectItems(false, 'after leaving for a new project');

if (process.platform === 'darwin') {
  step('no window (macOS): New Project brings up a window with its dialog');
  await closeWindow();
  await expectProjectItems(false, 'with no window and no project');
  await chooseWithNoWindow('New Project…');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await newProjectDialog().waitFor();
  await dismiss(newProjectDialog());

  step('no window (macOS): New then Open in one go bring up one window, which does the last of them');
  await closeWindow();
  await answerPicker(dirA);
  await chooseWithNoWindow('New Project…', 'Open Project…');
  await expectEditorFor('Harbour Bakery', dirA);
  await expectOnePicker('that came up for it');
  assert.equal(await newProjectDialog().count(), 0, 'New Project was replaced by Open Project');
  await expectProjectItems(true, 'after opening a project with no window');

  step('no window with a project open (macOS): Export brings the editor back with its dialog');
  await closeWindow();
  await expectProjectItems(true, 'with no window and the project still open');
  await chooseWithNoWindow('Export…');
  await expectEditorFor('Harbour Bakery', dirA);
  await exportDialog().waitFor();
  await dismiss(exportDialog());

  step('no window with a project open (macOS): Open Project brings the editor back and switches projects');
  await closeWindow();
  await answerPicker(dirB);
  await chooseWithNoWindow('Open Project…');
  await expectEditorFor('Quay Books', dirB);
  await expectOnePicker('that came up for it');

  step('no window with a project open (macOS): a cancelled folder picker keeps the project open');
  const kept = await opening();
  await closeWindow();
  await answerPicker(null);
  await chooseWithNoWindow('Open Project…');
  await expectEditorFor('Quay Books', dirB);
  await expectOnePicker('that came up for it');
  assert.equal(await opening(), kept, 'the same opening of the project is still open');

  step('no window with a project open (macOS): New Project closes the project, then shows its dialog');
  await closeWindow();
  await chooseWithNoWindow('New Project…');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await newProjectDialog().waitFor();
  assert.equal(await openDir(), null, 'the project was closed');
  await expectProjectItems(false, 'after leaving the project for a new one');
  await dismiss(newProjectDialog());

  step('no window with a project open (macOS): Close Project brings up the window and closes the project');
  const reopened = await win.evaluate((d) => window.builder.projects.open(d), dirA);
  assert.ok(reopened.ok, `the project opens again: ${JSON.stringify(reopened)}`);
  await expectEditorFor('Harbour Bakery', dirA);
  await closeWindow();
  await chooseWithNoWindow('Close Project');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await eventually(async () => assert.equal(await openDir(), null, 'the project was closed'));
  await expectProjectItems(false, 'after closing the project with no window');

  step('no window (macOS): a cancelled folder picker leaves Welcome as it was');
  await closeWindow();
  await answerPicker(null);
  await chooseWithNoWindow('Open Project…');
  await win.waitForSelector('.welcome', { timeout: 60000 });
  await expectOnePicker('that came up for it');
  await expectProjectItems(false, 'after a cancelled Open Project');
}

step('Welcome: a navigation the editor refuses leaves the File menu working');
// Electron reports the navigation starting before will-navigate refuses it, and nothing commits. Playwright never
// sees that navigation end, so this comes last and polls instead of waiting on locators.
await win.evaluate(() => {
  location.href = 'https://example.com/';
});
await choose('New Project…');
await eventually(async () => assert.equal(await newProjectDialog().count(), 1, 'the New project dialog opened'));

step('a crashed editor is loaded again for a File command, which it then carries out');
// Playwright treats a crashed page as finished even once it reloads, so the page is read through the main process.
const inPage = (code) =>
  withTimeout(
    app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(c), code),
    5000,
    'Reading the page'
  );
await inPage('window.beforeCrash = true');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
await eventually(async () => assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()), 'the renderer crashed'));
await choose('New Project…');
await eventually(
  async () =>
    assert.equal(
      await inPage(`!window.beforeCrash && !!document.querySelector('.welcome') && [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('New project'))`),
      true,
      'a reloaded Welcome shows the New project dialog'
    ),
  60000
);

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nmenu: all checks passed');
