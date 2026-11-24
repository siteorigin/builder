// Settings › Appearance styles the editor and never the website it previews (#202): the preview keeps this
// computer's color scheme, as a visitor's browser here would, whichever Appearance the editor is drawn in.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('appearance');
let { app, win, errors } = await launch(WORK);
// No emulated color scheme: what each page sees must be what Electron itself gives it.
await win.emulateMedia({ colorScheme: null });
await createProject(win, { name: 'Harbour Lights', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const BG = { light: '#f2f4f7', dark: '#11151c' };
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
}

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nappearance: passed');
