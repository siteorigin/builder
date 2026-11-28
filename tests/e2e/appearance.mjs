// Settings › Appearance styles the editor and never the website it previews (#202): the preview keeps this
// computer's color scheme, as a visitor's browser here would, whichever Appearance the editor is drawn in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('appearance');
let { app, win, errors } = await launch(WORK);
// No emulated color scheme: what each page sees must be what Electron itself gives it.
await win.emulateMedia({ colorScheme: null });
await createProject(win, { name: 'Harbour Lights', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const BG = { light: '#ebeff4', dark: '#11151c' };
/** This computer's setting, as the editor's own page sees it with Electron following it. */
const systemDark = await win.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
const system = systemDark ? 'dark' : 'light';
const other = systemDark ? 'light' : 'dark';
const site = () => win.frameLocator('.frame-box iframe');
const preview = () => site().locator('body').evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
const editor = () =>
  win.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return { scheme: document.documentElement.dataset.appearance, bg: root.getPropertyValue('--bg').trim(), colorScheme: root.colorScheme };
  });
const native = () =>
  app.evaluate(({ BrowserWindow, nativeTheme }) => ({ themeSource: nativeTheme.themeSource, background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase() }));
const drawnIn = async (scheme, what, { previewed = true } = {}) => {
  await eventually(async () => assert.deepEqual(await editor(), { scheme, bg: BG[scheme], colorScheme: scheme }, `${what}: the editor is drawn ${scheme}`));
  await eventually(async () => assert.equal((await native()).background, BG[scheme], `${what}: the window backs it in the same color`));
  assert.equal((await native()).themeSource, 'system', `${what}: Electron keeps following this computer`);
  if (previewed) assert.equal(await preview(), system, `${what}: the preview keeps this computer’s ${system} scheme`);
};

step(`on System the editor and the preview both follow this computer (${system})`);
await drawnIn(system, 'System');

step('Light and Dark change the editor only');
await win.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
const dialog = win.getByRole('dialog');
const choose = async (label) => {
  await dialog.getByRole('radio', { name: label }).click();
  await eventually(async () => assert.equal(await dialog.getByRole('radio', { name: label }).getAttribute('aria-checked'), 'true', `${label} is chosen`));
};
const label = (s) => (s === 'dark' ? 'Dark' : 'Light');
const toggle = () => win.locator('.welcome-main').getByRole('switch', { name: 'Dark appearance' });
// One of the editor's own dark rules, beyond its colors: the Developer mode switch's thumb.
const THUMB = { light: 'rgb(255, 255, 255)', dark: 'rgb(244, 247, 251)' };
const thumbIn = (scheme) =>
  eventually(async () => assert.equal(await dialog.getByRole('switch').first().evaluate((el) => getComputedStyle(el, '::after').backgroundColor), THUMB[scheme], `the switch is drawn ${scheme}`));
await choose(label(other));
await drawnIn(other, label(other));
await thumbIn(other);
await choose(label(system));
await drawnIn(system, label(system));
await thumbIn(system);
await choose('System');
await drawnIn(system, 'System again');

step('a page loaded in the preview afterwards still sees this computer’s scheme');
await choose(label(other));
await drawnIn(other, label(other));
await site().locator('body').evaluate(() => location.reload());
await site().locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
assert.equal(await preview(), system, 'the reloaded preview keeps this computer’s scheme');
await win.keyboard.press('Escape');
await dialog.waitFor({ state: 'detached' });

step('the app opens again in the saved Appearance');
assert.deepEqual(errors, [], 'no page errors');
await app.close();
({ app, win, errors } = await launch(WORK));
await win.emulateMedia({ colorScheme: null });
await drawnIn(other, 'reopened', { previewed: false });
const dir = (await win.evaluate(() => window.builder.projects.recents())).find((r) => r.name === 'Harbour Lights').dir;
assert.ok((await win.evaluate((d) => window.builder.projects.open(d), dir)).ok, 'the project opens again');
await site().locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 90000 });
await drawnIn(other, 'the project reopened');

step('a reloaded editor is drawn in the Appearance saved since its window opened, from its first paint');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await drawnIn(system, 'System, set through the API', { previewed: false });
// Recorded as the page's body is parsed, before the editor's own script runs.
await win.addInitScript(() => {
  new MutationObserver((_, watch) => {
    if (!document.body) return;
    window.appearanceAtFirstPaint = document.documentElement.dataset.appearance ?? 'unset';
    watch.disconnect();
  }).observe(document, { childList: true, subtree: true });
});
const reloadsIn = async (scheme, what) => {
  await win.reload();
  await win.waitForSelector('.welcome');
  assert.equal(await win.evaluate(() => window.appearanceAtFirstPaint), scheme, `${what}: the reloaded page starts drawn ${scheme}`);
  await drawnIn(scheme, what, { previewed: false });
};
// The window opened in the other scheme; System has been saved since.
await reloadsIn(system, 'reloaded on System');
await win.evaluate((a) => window.builder.app.setSettings({ appearance: a }), other);
await reloadsIn(other, `reloaded on ${label(other)}`);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await drawnIn(system, 'System again', { previewed: false });

step('on System the editor and its window follow this computer’s setting as it changes');
// Electron's own theme stands in for this computer's setting changing.
for (const [themeSource, scheme] of [[other, other], ['system', system]]) {
  await app.evaluate(({ nativeTheme }, t) => (nativeTheme.themeSource = t), themeSource);
  await eventually(async () => assert.equal((await editor()).scheme, scheme, `the editor follows a change to ${scheme}`));
  await eventually(async () => assert.equal((await native()).background, BG[scheme], `the window follows a change to ${scheme}`));
  await eventually(async () => assert.equal(await toggle().getAttribute('aria-checked'), String(scheme === 'dark'), `Welcome's toggle shows the change to ${scheme}`));
}

step('Welcome’s toggle switches the editor between light and dark in one click, saved as the Appearance (#554)');
const saved = () => win.evaluate(() => window.builder.app.getSettings().then((s) => s.appearance));
/** The toggle shows the scheme the editor is drawn in, and the Appearance saved is that scheme, never System. */
const toggledTo = async (scheme, what) => {
  await drawnIn(scheme, what, { previewed: false });
  await eventually(async () => assert.equal(await toggle().getAttribute('aria-checked'), String(scheme === 'dark'), `${what}: the toggle shows ${scheme}`));
  assert.equal(await toggle().getAttribute('title'), `Switch to ${scheme === 'dark' ? 'light' : 'dark'} appearance`, `${what}: the toggle says what a click does`);
  assert.equal(await saved(), scheme, `${what}: ${label(scheme)} is the saved Appearance`);
};
/** Inside the main pane's window drag strip, top right, and a control there: a press reaches it rather than moving the window. */
const inTopRight = async (what) => {
  const box = await toggle().boundingBox();
  const { width } = win.viewportSize();
  assert.ok(box.y >= 0 && box.y + box.height <= 44 && box.x + box.width <= width && box.x + box.width > width - 40, `${what}: the toggle sits in the top right strip (${JSON.stringify(box)})`);
  assert.equal(await toggle().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag', `${what}: the toggle is out of the drag region`);
};
const openSettings = async () => {
  await win.locator('.welcome-foot').getByRole('button', { name: 'Settings' }).click();
  return win.getByRole('dialog');
};
const closeSettings = async (settings) => {
  await win.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
};
await win.locator('.recent-grid').waitFor();
// Settings says System first, so what it shows afterwards can only have come from the toggle.
let settings = await openSettings();
await settings.getByRole('radio', { name: 'System' }).click();
await eventually(async () => assert.equal(await settings.getByRole('radio', { name: 'System' }).getAttribute('aria-checked'), 'true', 'Settings starts on System'));
await closeSettings(settings);
assert.equal(await saved(), 'system', 'System is saved');
await eventually(async () => assert.equal(await toggle().getAttribute('aria-checked'), String(system === 'dark'), `on System the toggle shows this computer’s ${system}`));
await inTopRight('with recent projects');
// The page's recent project comes before the appearance switch in keyboard order.
await win.locator('.welcome-foot').getByRole('button', { name: 'Settings' }).focus();
await win.keyboard.press('Tab');
assert.ok(await win.locator('.recent-card').first().evaluate((el) => el === document.activeElement), 'Tab moves from the rail into the page');
let reachedToggle = false;
for (let i = 0; i < 16; i++) {
  if (await toggle().evaluate((el) => el === document.activeElement)) {
    reachedToggle = true;
    break;
  }
  await win.keyboard.press('Tab');
}
assert.ok(reachedToggle, 'Tab reaches the appearance switch after the page');
await win.keyboard.press('Space');
await toggledTo(other, 'Space');
await win.keyboard.press('Enter');
await toggledTo(system, 'Enter');
assert.ok(await toggle().evaluate((el) => el === document.activeElement), 'focus stays on the toggle');
await toggle().click();
await toggledTo(other, 'click');
const userData = await app.evaluate(({ app }) => app.getPath('userData'));
assert.equal(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).settings.appearance, other, 'the toggle’s choice is on disk at once');

step('Settings shows the toggle’s choice, and System is still there to go back to');
settings = await openSettings();
await eventually(async () => assert.equal(await settings.getByRole('radio', { name: label(other) }).getAttribute('aria-checked'), 'true', 'Settings shows the toggled Appearance'));
assert.equal(await settings.getByRole('radio', { name: 'System' }).getAttribute('aria-checked'), 'false', 'System is no longer chosen');
assert.ok(await settings.getByRole('radio', { name: 'System' }).isEnabled(), 'System can still be chosen');
await closeSettings(settings);

step('a switch draws the editor in what its save answered, one press at a time, whether or not main says so');
// Main's answer is held, and it never sends the appearance event unless the test does: the toggle must not save
// twice, wait for an event, or let an answer overrule an event that came after it was asked.
const before = await win.evaluate(() => window.builder.app.getSettings());
await app.evaluate(({ BrowserWindow }, base) => {
  globalThis.heldSaves = [];
  BrowserWindow.getAllWindows()[0].webContents.ipc.handle('app:setSettings', (_e, patch) => new Promise((resolve) => globalThis.heldSaves.push({ patch, answer: (appearance) => resolve({ ...base, ...patch, ...(appearance ? { appearance } : {}) }) })));
}, before);
try {
  const held = () => app.evaluate(() => globalThis.heldSaves.map((s) => s.patch));
  /** Answers the newest held save: with what it asked for, or with another Appearance saved meanwhile. */
  const answer = (appearance) => app.evaluate((_, a) => globalThis.heldSaves.at(-1).answer(a), appearance);
  const event = (appearance) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('appearance', a), appearance);
  const drawn = (scheme, what) => eventually(async () => assert.equal((await editor()).scheme, scheme, what));
  await toggle().click();
  await toggle().click();
  await win.keyboard.press('Enter');
  await eventually(async () => assert.deepEqual(await held(), [{ appearance: system }], 'one save, for the other scheme'));
  assert.equal((await editor()).scheme, other, 'the editor stays drawn as it is until the save answers');
  await answer();
  await drawn(system, 'with no event, the editor is drawn in what the save answered');
  await eventually(async () => assert.equal(await toggle().getAttribute('aria-checked'), String(system === 'dark'), 'the toggle shows it'));
  await toggle().click();
  await eventually(async () => assert.deepEqual(await held(), [{ appearance: system }, { appearance: other }], 'the next press saves the scheme back'));
  // Another save got there first and put back what was drawn: the answer says so, and the editor stays.
  await answer(system);
  await drawn(system, 'the editor is drawn in what was saved, not what was asked');
  await toggle().click();
  await eventually(async () => assert.equal((await held()).length, 3, 'a third save'));
  // Settings saves the drawn scheme while the toggle's save is on its way, and its event comes before the toggle's answer.
  await event(system);
  await answer();
  await win.waitForTimeout(300);
  await drawn(system, 'an answer never overrules an event that came after it was asked');
  await event(other);
  await drawn(other, 'the next event is drawn as always');
} finally {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.ipc.removeHandler('app:setSettings'));
}
assert.equal(await saved(), other, `${label(other)} is still the saved Appearance`);

step('the toggle’s choice survives a restart, and the first-run screen has the toggle too');
assert.deepEqual(errors, [], 'no page errors');
await app.close();
({ app, win, errors } = await launch(WORK));
await win.emulateMedia({ colorScheme: null });
await toggledTo(other, 'reopened after the toggle');
for (const r of await win.evaluate(() => window.builder.projects.recents())) await win.evaluate((d) => window.builder.projects.removeRecent(d), r.dir);
await win.reload();
await win.locator('.welcome-hero').waitFor();
await inTopRight('on the first-run screen');
await toggle().click();
await toggledTo(system, 'first-run screen');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await drawnIn(system, 'System again', { previewed: false });
assert.equal(await saved(), 'system', 'System is saved again');
assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nappearance: passed');
