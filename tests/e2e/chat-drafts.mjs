// Unsent AI messages stay with the conversation and the project they were written in (issue #11): a new
// conversation starts with an empty composer and its starters, returning to a thread restores its draft, and
// creating, opening or closing to another project never carries one client's text into another's chat.
// Conversations are seeded through the project's own chat storage; the API key is a placeholder that is never
// sent anywhere, because no message is ever sent.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('chat-drafts');
const sites = join(WORK, 'sites');
let { app, win, errors } = await launch(WORK);
const allErrors = [];

await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-e2e-placeholder-never-sent'));
await win.reload();
await win.waitForSelector('.welcome');

const message = () => win.getByRole('textbox', { name: 'Message' });
const suggestions = () => win.getByRole('group', { name: 'Suggestions' });
const sendButton = () => win.locator('.send-btn');
const chatTitle = () => win.locator('.chat-title');
const openAiTab = async () => {
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await message().waitFor();
};
const composerIs = (text) => eventually(async () => assert.equal(await message().inputValue(), text));
const type = async (text) => {
  await message().click();
  await message().fill(text);
  await composerIs(text);
};
/** Pick an entry in the Earlier conversations menu. */
const pick = async (name) => {
  await win.getByRole('button', { name: 'Earlier conversations' }).click();
  await win.locator('.menu [role^="menuitem"]', { hasText: name }).click();
};
const workspace = (dir) => {
  const f = join(dir, '.siteorigin', 'workspace.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};
const openProject = async (dir) => {
  const r = await win.evaluate((d) => window.builder.projects.open(d), dir);
  assert.equal(r.ok, true, `the project opens: ${r.message ?? ''}`);
  await win.waitForSelector('.editor');
  // Let the preview finish loading, so switching away does not cut a page load short.
  await win.frameLocator('.frame-box iframe').locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 90000 });
  await openAiTab();
};

step('a project with two earlier conversations');
await createProject(win, { name: 'Kloof Light Studio', parentDir: sites, starter: 'blank', sampleImages: false });
const kloof = (await win.evaluate(() => window.builder.project.snapshot())).dir;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const t = (min) => new Date(Date.UTC(2026, 10, 20, 9, min)).toISOString();
const conversation = (id, title, min) => ({
  id,
  title,
  createdAt: t(min),
  messages: [
    { id: `m_u${min}`, role: 'user', text: title, time: t(min), runId: `r_${min}` },
    { id: `m_a${min}`, role: 'assistant', text: 'Done.', time: t(min + 1), runId: `r_${min}`, result: { status: 'completed', summary: 'Done.', changes: [], validation: [], canUndo: false } }
  ]
});
const chatDir = join(kloof, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
writeFileSync(join(chatDir, 'c_home.json'), JSON.stringify(conversation('c_home', 'Add a photo to the home page', 30)));
writeFileSync(join(chatDir, 'c_older.json'), JSON.stringify(conversation('c_older', 'Make the brand colour navy', 10)));
await openProject(kloof);
await eventually(async () => assert.equal(await chatTitle().textContent(), 'Add a photo to the home page'));

step('a new conversation starts empty, with its starters');
await type('Add another photo here');
await win.getByRole('button', { name: 'New conversation', exact: true }).click();
await eventually(async () => assert.equal(await chatTitle().textContent(), 'New conversation'));
await composerIs('');
await suggestions().waitFor();
assert.equal(await sendButton().isDisabled(), true, 'nothing to send in the new conversation');
// A starter fills this conversation's composer, and steps aside once there is text.
const starter = (await suggestions().locator('.suggestion').first().textContent()).trim();
await suggestions().locator('.suggestion').first().click();
await composerIs(starter);
assert.equal(await sendButton().isDisabled(), false, 'the starter can be sent');
assert.equal(await suggestions().count(), 0, 'starters step aside once the composer has text');
await message().fill('');
await suggestions().waitFor();

step('returning to a thread restores its own draft, across earlier threads');
await pick('Add a photo to the home page');
await composerIs('Add another photo here');
await pick('Make the brand colour navy');
await composerIs('');
await type('Use navy for the buttons too');
await pick('Add a photo to the home page');
await composerIs('Add another photo here');
await pick('Make the brand colour navy');
await composerIs('Use navy for the buttons too');

step('a draft left in a new conversation can be picked up again');
await win.getByRole('button', { name: 'New conversation', exact: true }).click();
await composerIs('');
await type('Write a calmer About page');
await pick('Add a photo to the home page');
await composerIs('Add another photo here');
await pick('Write a calmer About page');
await eventually(async () => assert.equal(await chatTitle().textContent(), 'New conversation'));
await composerIs('Write a calmer About page');
// Picked up, it is the open conversation's draft, no longer one waiting in the list.
await win.getByRole('button', { name: 'Earlier conversations' }).click();
await win.locator('.menu [role^="menuitem"]', { hasText: 'Add a photo to the home page' }).waitFor();
assert.equal(await win.locator('.menu [role^="menuitem"]', { hasText: 'Write a calmer About page' }).count(), 0);
await win.keyboard.press('Escape');
await pick('Make the brand colour navy');
await composerIs('Use navy for the buttons too');

step('creating another site starts its chat empty');
await createProject(win, { name: '灯台', parentDir: sites, starter: 'blank', sampleImages: false });
const lighthouse = (await win.evaluate(() => window.builder.project.snapshot())).dir;
assert.notEqual(lighthouse, kloof);
await openAiTab();
await eventually(async () => assert.equal(await chatTitle().textContent(), 'New conversation'));
await composerIs('');
await suggestions().waitFor();
assert.equal(await sendButton().isDisabled(), true, 'Send is not enabled with the other client’s text');
await type('Lantern light');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
assert.doesNotMatch(workspace(lighthouse), /Add another photo|calmer About|navy/, 'no Kloof text in 灯台’s workspace');
assert.match(workspace(lighthouse), /Lantern light/, '灯台 keeps its own draft');

step('opening the original project restores its thread and draft');
await openProject(kloof);
// The older thread that was open comes back, not just the newest one.
await eventually(async () => assert.equal(await chatTitle().textContent(), 'Make the brand colour navy'));
await composerIs('Use navy for the buttons too');
assert.doesNotMatch(workspace(kloof), /Lantern light/, 'no 灯台 text in Kloof’s workspace');

step('Open project straight from another project, and back');
await openProject(lighthouse);
await composerIs('Lantern light');
await openProject(kloof);
await composerIs('Use navy for the buttons too');

step('a draft in a new conversation survives a restart');
await win.getByRole('button', { name: 'New conversation', exact: true }).click();
await composerIs('');
await type('Rewrite the hero after the restart');
await app.close();
allErrors.push(...errors);
({ app, win, errors } = await launch(WORK));
await openProject(kloof);
await eventually(async () => assert.equal(await chatTitle().textContent(), 'New conversation'));
await composerIs('Rewrite the hero after the restart');
// The earlier threads keep theirs.
await pick('Make the brand colour navy');
await composerIs('Use navy for the buttons too');
await pick('Add a photo to the home page');
await composerIs('Add another photo here');

await app.close();
allErrors.push(...errors);
assert.deepEqual(allErrors, [], 'no uncaught errors in the editor');
cleanup();
console.log('\nchat-drafts: passed');
