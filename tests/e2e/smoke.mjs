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

step('select the hero, then its heading');
const h1 = frame.locator('h1').first();
const chipLabel = () => win.locator('.ov-chip .label').first().innerText();
await h1.click();
await eventually(async () => assert.equal(await chipLabel(), 'Split hero', 'the first click selects the hero section'));
await win.waitForTimeout(400);
await h1.click();
await eventually(async () => assert.match(await chipLabel(), /heading/i, 'the second click selects its heading'));
await win.screenshot({ path: join(OUT, '04-selected-heading.png') });
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nsmoke: passed');
