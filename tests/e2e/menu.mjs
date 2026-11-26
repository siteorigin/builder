// The native File menu works from Welcome, from a project and, on macOS, from the running app with no window
// left: New Project and Open Project bring a window back and do what was asked once it is ready, and Export
// and Close Project are offered only while a project is open (#255). Settings… opens Settings from Welcome and the
// editor, Help links to the website, and Reload and the developer tools are offered only in Developer mode, since an
// automated run gets the menu a packaged build has (#810). Needs no preview.
//
// Menu items are chosen through their own click handlers (harness chooseMenu), as the menu bar and the item's shortcut
// do. Headless runs cannot press native key equivalents, so the shortcuts are checked as the accelerators the items
// carry. The folder picker is answered by the app's chooser fixtures, which record the window it was shown over.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { answerChoosers, chooseMenu, choosersShown, desktopCursor, desktopEvents, desktopIntents, eventually, launch, menuItem, scratch, step, withTimeout } from './harness.mjs';

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
const fileMenu = async () => Object.fromEntries((await menuItem(app, 'File')).items.map((i) => [i.label, { enabled: i.enabled, accelerator: i.accelerator }]));

/** Choose File menu items, one after the other in the same turn of the main process. */
const choose = (...labels) => chooseMenu(app, ...labels.map((l) => ['File', l]));

/** The next Open Project picker answers with the project in `dir` (or is cancelled): macOS's picker takes the folder,
 *  the others its manifest. Pickers shown from here on are what expectOnePicker checks. */
let pickerMark = 0;
let pickerOutcome = null;
async function answerPicker(dir) {
  pickerMark = await desktopCursor(app);
  pickerOutcome = dir ? 'chosen' : 'cancelled';
  const pick = process.platform === 'darwin' ? dir : join(dir ?? '', 'siteorigin.project.json');
  await answerChoosers(app, [dir ? { dialog: 'open', title: 'Open a SiteOrigin Builder project', paths: [pick] } : { dialog: 'open', cancel: true }]);
}
/** Exactly one picker was shown since it was answered, over the current window, and it took the answer. */
const expectOnePicker = (where) =>
  eventually(async () => assert.deepEqual((await choosersShown(app, pickerMark)).map((c) => [c.window, c.outcome]), [[await windowId(), pickerOutcome]], `one picker, shown over the window ${where}`));

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

/** Settings… is in the app menu on macOS and in the File menu elsewhere. */
const SETTINGS = process.platform === 'darwin' ? ['SiteOrigin Builder', 'Settings…'] : ['File', 'Settings…'];
const settingsDialog = () => win.getByRole('dialog', { name: 'Settings' });
/** The View menu's items that only developers get, by role. */
const DEVELOPER_ROLES = ['reload', 'forcereload', 'toggledevtools'];
const developerItems = async () => (await menuItem(app, 'View')).items.map((i) => String(i.role ?? '').toLowerCase()).filter((r) => DEVELOPER_ROLES.includes(r));

step('Settings… and Help are offered, and Reload and the developer tools only in Developer mode');
assert.equal((await menuItem(app, ...SETTINGS))?.accelerator, 'CmdOrCtrl+,', 'Settings… has the platform’s shortcut');
const help = (await menuItem(app, 'Help')).items.map((i) => i.label);
assert.ok(help.includes('SiteOrigin Website'), `Help links to the website: ${help.join(', ')}`);
// macOS shows the version in the app menu's About panel; elsewhere Help has an About item.
if (process.platform === 'darwin') assert.ok((await menuItem(app, 'SiteOrigin Builder')).items.some((i) => String(i.role).toLowerCase() === 'about'), 'the app menu has About');
else assert.ok(help.includes('About SiteOrigin Builder'), 'Help has About');
assert.deepEqual(await developerItems(), [], 'an author is not offered Reload or the developer tools');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
await eventually(async () => assert.deepEqual(await developerItems(), DEVELOPER_ROLES, 'Developer mode offers Reload and the developer tools'));
assert.equal((await menuItem(app, 'File', 'Export…')).enabled, false, 'rebuilding the menu keeps Export unavailable on Welcome');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: false }));
await eventually(async () => assert.deepEqual(await developerItems(), [], 'turning Developer mode off takes them away again'));

step('Help: the website link is handed to the desktop');
const linkMark = await desktopCursor(app);
await chooseMenu(app, ['Help', 'SiteOrigin Website']);
await eventually(async () => assert.deepEqual((await desktopIntents(app, linkMark)).filter((x) => x.kind === 'open-external').map((x) => x.target), ['https://siteorigin.com/'], 'the website opens in the browser'));

if (process.platform !== 'darwin') {
  step('Help: About shows the version (Windows and Linux)');
  const aboutMark = await desktopCursor(app);
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  await answerChoosers(app, [{ dialog: 'message', button: 'OK' }]);
  await chooseMenu(app, ['Help', 'About SiteOrigin Builder']);
  await eventually(async () =>
    assert.deepEqual(
      (await choosersShown(app, aboutMark)).map((c) => [c.dialog, c.message, c.detail, c.window, c.outcome]),
      [['message', 'SiteOrigin Builder', `Version ${version}`, await windowId(), 'chosen']],
      'About names the app and its version, over the editor window'
    )
  );
}

step('Welcome: Settings… opens the Settings dialog');
await chooseMenu(app, SETTINGS);
await settingsDialog().waitFor();
await dismiss(settingsDialog());

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
step('a project: Settings… opens the Settings dialog over the editor, and the menu still offers Export');
await chooseMenu(app, SETTINGS);
await settingsDialog().waitFor();
await dismiss(settingsDialog());
await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
await eventually(async () => assert.deepEqual(await developerItems(), DEVELOPER_ROLES, 'Developer mode offers Reload and the developer tools'));
await expectProjectItems(true, 'after the menu was rebuilt with a project open');
await win.evaluate(() => window.builder.app.setSettings({ developerMode: false }));
await eventually(async () => assert.deepEqual(await developerItems(), [], 'turning Developer mode off takes them away again'));
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

step('a project: Open Project switches to the chosen project, New Project asks over it and keeps it open (#80)');
await answerPicker(dirB);
await choose('Open Project…');
await expectEditorFor('Quay Books', dirB);
await expectOnePicker('from the editor');
const beforeNew = await opening();
await choose('New Project…');
await newProjectDialog().waitFor();
assert.equal(await win.locator('.welcome').count(), 0, 'Welcome never appeared');
assert.equal(await opening(), beforeNew, 'the same opening of the project is still open');
await dismiss(newProjectDialog());
await expectEditorFor('Quay Books', dirB);
await expectProjectItems(true, 'after cancelling a new project');
await choose('Close Project');
await win.waitForSelector('.welcome');
await expectProjectItems(false, 'after closing the project');

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
  const chosen = (await desktopEvents(app, pickerMark)).entries.filter((e) => e.type === 'menu').map((e) => [e.path.join(' > '), e.window]);
  assert.deepEqual(chosen, [['File > New Project…', null], ['File > Open Project…', null]], 'both were chosen, in order, with no window open');
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

  step('no window with a project open (macOS): New Project brings the editor back with its dialog over the project');
  const keptForNew = await opening();
  await closeWindow();
  await chooseWithNoWindow('New Project…');
  await expectEditorFor('Quay Books', dirB);
  await newProjectDialog().waitFor();
  assert.equal(await opening(), keptForNew, 'the project stayed open');
  await expectProjectItems(true, 'with the New project dialog over the project');
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
// The crash itself asks to load the editor again (#886), and an unanswered question does: the crash is awaited, not
// polled for, since the editor may be back before a poll would see it crashed.
const crashed = await app.evaluate(({ BrowserWindow }) => {
  const contents = BrowserWindow.getAllWindows()[0].webContents;
  const gone = new Promise((resolve) => contents.once('render-process-gone', (_e, details) => resolve(details.reason)));
  contents.forcefullyCrashRenderer();
  return gone;
});
assert.notEqual(crashed, 'clean-exit', 'the renderer crashed');
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
