// End-to-end smoke test: drives the real Electron app through key storage, project creation and selection.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
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

step('the right panel opens on the AI, the first of its views, at its setup with no provider connected (#696)');
const dockTabs = win.locator('#editor-dock > .dock-tabs > [role="tab"]');
assert.deepEqual(await dockTabs.evaluateAll((tabs) => tabs.map((t) => t.id)), ['dock-tab-chat', 'dock-tab-inspect', 'dock-tab-styles', 'dock-tab-project']);
assert.deepEqual((await dockTabs.allInnerTexts()).map((t) => t.trim()), ['AI', 'Inspector', 'Site styles', 'Project']);
const selectedTab = () => win.locator('#editor-dock > .dock-tabs > [role="tab"][aria-selected="true"]').getAttribute('id');
assert.equal(await selectedTab(), 'dock-tab-chat', 'a new window opens on the AI');
await win.locator('#dock-panel-chat').getByText('Connect an AI provider').first().waitFor();

step('the AI tab’s icon alone keeps the accent colour, in light and dark');
const iconColours = () =>
  win.evaluate(() => {
    const accent = document.createElement('span');
    accent.style.color = 'var(--accent-text)';
    document.body.append(accent);
    const want = getComputedStyle(accent).color;
    accent.remove();
    const colour = (id) => {
      const svg = document.querySelector(`#${id} svg`);
      return svg && getComputedStyle(svg).display !== 'none' ? getComputedStyle(svg).color : null;
    };
    return { want, chat: colour('dock-tab-chat'), inspect: getComputedStyle(document.querySelector('#dock-tab-inspect')).color };
  });
const appearance = await win.evaluate(() => document.documentElement.dataset.appearance ?? null);
for (const theme of ['light', 'dark']) {
  await win.evaluate((t) => (document.documentElement.dataset.appearance = t), theme);
  const c = await iconColours();
  assert.equal(c.chat, c.want, `the AI icon shows in the accent colour (${theme})`);
  assert.notEqual(c.inspect, c.want, `the other tabs stay plain (${theme})`);
}
await win.evaluate((a) => (a === null ? delete document.documentElement.dataset.appearance : (document.documentElement.dataset.appearance = a)), appearance);

step('the arrow keys move through the views in that order');
await win.locator('#dock-tab-chat').focus();
await win.keyboard.press('ArrowRight');
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-inspect'));
await win.keyboard.press('End');
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-project'));
await win.keyboard.press('ArrowRight');
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-chat', 'Right from the last view wraps to the AI'));
await win.keyboard.press('ArrowLeft');
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-project'));
await win.keyboard.press('Home');
await eventually(async () => assert.equal(await selectedTab(), 'dock-tab-chat'));

step('select the hero, then its heading');
const h1 = frame.locator('h1').first();
const chipLabel = () => win.locator('.ov-chip .label').first().innerText();
await h1.click();
await eventually(async () => assert.equal(await chipLabel(), 'Split hero', 'the first click selects the hero section'));
await win.waitForTimeout(400);
await h1.click();
await eventually(async () => assert.match(await chipLabel(), /heading/i, 'the second click selects its heading'));
await win.screenshot({ path: join(OUT, '04-selected-heading.png') });
assert.equal(await selectedTab(), 'dock-tab-chat', 'selecting on the canvas keeps the AI open');

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
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nsmoke: passed');
