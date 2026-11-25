// End-to-end smoke test: drives the real Electron app through key storage, project creation and selection.
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('smoke');
const { app, win, errors } = await launch(WORK);
await win.screenshot({ path: join(OUT, '01-welcome.png') });

step('API keys are stored in a user-only local file, never the OS keychain');
const saved = await win.evaluate(async () => (await window.builder.ai.setKey('anthropic', 'sk-ant-test')).find((p) => p.id === 'anthropic'));
assert.equal(saved.configured, true, 'the saved key is reported as configured');
const keyFile = join(WORK, 'userdata', 'api-keys.json');
assert.equal(JSON.parse(readFileSync(keyFile, 'utf8')).anthropic, 'sk-ant-test', 'the key is stored in api-keys.json');
if (process.platform !== 'win32') assert.equal((statSync(keyFile).mode & 0o777).toString(8), '600', 'api-keys.json is readable only by the user');
const cleared = await win.evaluate(async () => (await window.builder.ai.setKey('anthropic', null)).find((p) => p.id === 'anthropic'));
assert.equal(cleared.configured, false, 'the key is reported as removed');
assert.equal(JSON.parse(readFileSync(keyFile, 'utf8')).anthropic, undefined, 'the key is removed from api-keys.json');

step('create a project');
await win.getByRole('button', { name: /New project/ }).first().click();
await win.waitForSelector('.modal');
await win.fill('input[placeholder^="For example"]', 'Harbour Lane Studio');
await win.screenshot({ path: join(OUT, '02-new-project.png') });
// The folder picker is a native dialog; create through the same IPC call the dialog uses.
const t0 = Date.now();
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
console.log('created and previewed in', Date.now() - t0, 'ms');
await win.screenshot({ path: join(OUT, '03-editor.png') });
const samples = Object.values((await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets);
assert.ok(samples.length, 'the sample images are in the library');
assert.deepEqual(samples.filter((a) => a.originalName).map((a) => a.id), [], 'a bundled sample is no file of the author’s, so none has an original name');

step('the right panel opens on the AI, the first of its views, at its setup with no provider connected (#696)');
const dockTabs = win.locator('#editor-dock > .dock-tabs > [role="tab"]');
assert.deepEqual(await dockTabs.evaluateAll((tabs) => tabs.map((t) => t.id)), ['dock-tab-chat', 'dock-tab-inspect', 'dock-tab-styles', 'dock-tab-project']);
assert.deepEqual((await dockTabs.allInnerTexts()).map((t) => t.trim()), ['AI', 'Inspector', 'Site styles', 'Project']);
const selectedTab = () => win.locator('#editor-dock > .dock-tabs > [role="tab"][aria-selected="true"]').getAttribute('id');
assert.equal(await selectedTab(), 'dock-tab-chat', 'a new window opens on the AI');
await win.locator('#dock-panel-chat').getByText('Connect an AI provider').first().waitFor();

step('the AI tab’s icon keeps the accent colour while another view is open, in light and dark, and shows in the default dock');
await win.locator('#dock-tab-inspect').click();
const icons = () =>
  win.evaluate(() => {
    const accent = document.createElement('span');
    accent.style.color = 'var(--accent-text)';
    document.body.append(accent);
    const want = getComputedStyle(accent).color;
    accent.remove();
    const icon = (view) => {
      const style = getComputedStyle(document.querySelector(`#dock-tab-${view} svg`));
      return { colour: style.color, shown: style.display !== 'none' };
    };
    return { want, chat: icon('chat'), styles: icon('styles'), project: icon('project'), inspect: icon('inspect') };
  });
const appearance = await win.evaluate(() => document.documentElement.dataset.appearance ?? null);
for (const theme of ['light', 'dark']) {
  await win.evaluate((t) => (document.documentElement.dataset.appearance = t), theme);
  const c = await icons();
  assert.equal(c.chat.colour, c.want, `the AI icon is in the accent colour with the Inspector open (${theme})`);
  assert.equal(c.chat.shown, true, `the AI icon shows in the default-width dock (${theme})`);
  for (const view of ['styles', 'project']) assert.notEqual(c[view].colour, c.want, `the ${view} icon stays plain (${theme})`);
  // The dock's default width drops the other views' icons, never the AI's.
  for (const view of ['inspect', 'styles', 'project']) assert.equal(c[view].shown, false, `the ${view} icon gives way in the default-width dock (${theme})`);
}
await win.evaluate((a) => (a === null ? delete document.documentElement.dataset.appearance : (document.documentElement.dataset.appearance = a)), appearance);
await win.locator('#dock-tab-chat').click();
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-chat'));

step('the arrow keys move through the views in that order');
await win.locator('#dock-tab-chat').focus();
const focusedTab = () => win.evaluate(() => document.activeElement?.id);
/** The key selects the view and moves the focus to its tab. */
async function key(name, tab, message) {
  await win.keyboard.press(name);
  await eventually(async () => {
    assert.equal(await selectedTab(), tab, message);
    assert.equal(await focusedTab(), tab, `${message ?? tab}: the focus follows`);
  });
}
await key('ArrowRight', 'dock-tab-inspect');
await key('ArrowRight', 'dock-tab-styles');
await key('End', 'dock-tab-project');
await key('ArrowRight', 'dock-tab-chat', 'Right from the last view wraps to the AI');
await key('ArrowLeft', 'dock-tab-project', 'Left from the AI wraps to the last view');
await key('Home', 'dock-tab-chat');

step('select the hero, then its heading');
const h1 = frame.locator('h1').first();
const chipLabel = () => win.locator('.ov-chip .label').first().innerText();
await h1.click();
await eventually(async () => assert.equal(await chipLabel(), 'Split hero', 'the first click selects the hero section'));
assert.equal(await selectedTab(), 'dock-tab-chat', 'selecting on the canvas keeps the AI open');
await win.waitForTimeout(400);
await h1.click();
await eventually(async () => assert.match(await chipLabel(), /heading/i, 'the second click selects its heading'));
await win.screenshot({ path: join(OUT, '04-selected-heading.png') });
assert.equal(await selectedTab(), 'dock-tab-chat', 'and so does selecting inside the selection');

step('a view chosen in the project is the one it reopens on');
const projectDir = (await win.evaluate(() => window.builder.project.snapshot())).dir;
await win.locator('#dock-tab-inspect').click();
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-inspect'));
await eventually(() => assert.equal(JSON.parse(readFileSync(join(projectDir, '.siteorigin', 'workspace.json'), 'utf8')).rightTab, 'inspect', 'the view is saved with the project'));
assert.ok((await win.evaluate(() => window.builder.projects.close())).ok, 'the project closes');
await win.waitForSelector('.welcome');
assert.ok((await win.evaluate((d) => window.builder.projects.open(d), projectDir)).ok, 'the project reopens');
await win.waitForSelector('.editor');
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-inspect', 'the saved view is kept'));

step('the view is read from the project on opening: a saved view is kept, an unknown one opens the AI');
const workspaceFile = join(projectDir, '.siteorigin', 'workspace.json');
for (const [saved, opens] of [['project', 'dock-tab-project'], ['outline', 'dock-tab-chat']]) {
  assert.ok((await win.evaluate(() => window.builder.projects.close())).ok, 'the project closes');
  await win.waitForSelector('.welcome');
  writeFileSync(workspaceFile, JSON.stringify({ ...JSON.parse(readFileSync(workspaceFile, 'utf8')), rightTab: saved }));
  assert.ok((await win.evaluate((d) => window.builder.projects.open(d), projectDir)).ok, 'the project reopens');
  await win.waitForSelector('.editor');
  await eventually(async () => assert.equal(await selectedTab(), opens, `a saved "${saved}" opens ${opens}`));
}
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nsmoke: passed');
