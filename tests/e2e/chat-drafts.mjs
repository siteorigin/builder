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
const suggestions = () => win.getByRole('group', { name: 'Each fills the box below, ready to edit.' });
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

step('starters name the pages this site has, whatever they are called (#54)');
const starterTexts = async () => (await suggestions().locator('.suggestion').allTextContents()).map((x) => x.trim());
const create = (page, about) => `Create a new ${page} page with ${about}, and link it from the header menu`;
const contactAbout = 'a short note, how to get in touch and a simple way to send a message';
// A one-page site: its own page (Blank's Home starts with nothing on it), the page it is missing, and one thing that needs no page.
assert.deepEqual(await starterTexts(), ['Start the “Home” page: add an introduction and the sections it needs', create('Contact', contactAbout), 'Make the brand color a deep navy blue across the whole site']);
await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'page.create', title: 'お問い合わせ', starter: 'intro', addToNavigation: true }] }, { label: 'Add page' }));
await win.locator('.project-title').click();
await win.getByRole('menuitemradio', { name: /^お問い合わせ/ }).click();
await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), /お問い合わせ/, 'the second page is open'));
// The open page comes first, Home is labelled as another page, and お問い合わせ is the contact page, so About is the page offered.
const forSecond = [
  'Build out the “お問い合わせ” page: it is mostly empty, so add the sections and content it needs',
  'On another page, “Home”: add an introduction and the sections it needs',
  create('About', 'who is behind the site, what it stands for and a call to action')
];
await eventually(async () => assert.deepEqual(await starterTexts(), forSecond));
// Renaming the open page renames its starters.
await win.evaluate((id) => window.builder.project.apply({ operations: [{ type: 'page.update', pageId: id, title: 'Say hello' }] }, { label: 'Rename page' }), (await win.evaluate(() => window.builder.project.snapshot())).state.site.pageOrder[1]);
await eventually(async () => assert.deepEqual(await starterTexts(), [forSecond[0].replace('お問い合わせ', 'Say hello'), ...forSecond.slice(1)]));
await suggestions().locator('.suggestion', { hasText: 'On another page' }).click();
await composerIs(forSecond[1]);
await message().fill('');
await suggestions().waitFor();
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

step('an unfinished request offers Continue, sent with its own context and leaving the draft alone (#88)');
// Sends are captured in the main process, so nothing reaches a provider.
await app.evaluate(({ ipcMain }) => {
  globalThis.__sent = [];
  ipcMain.removeHandler('ai:send');
  ipcMain.handle('ai:send', (_e, text, ctx, conversationId) => {
    globalThis.__sent.push({ text, ctx, conversationId });
    return { ok: true, runId: 'run_captured' };
  });
});
const homeId = (await win.evaluate(() => window.builder.project.snapshot())).state.site.homePageId;
const missing = 'The page Reader requests (/reader-requests/) was not created.';
const ask = 'Add Staff picks and Reader requests pages';
const originalCtx = { pageId: homeId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 390 };
const unfinished = (id, title, min, context, status = 'completed') => ({
  id,
  title,
  createdAt: t(min),
  messages: [
    { id: `m_u${min}`, role: 'user', text: title, time: t(min), runId: `r_${min}`, context },
    {
      id: `m_a${min}`,
      role: 'assistant',
      text: '',
      time: t(min + 1),
      runId: `r_${min}`,
      result: { status, summary: `This request is not finished yet. ${missing}`, changes: [], validation: [missing], checks: [{ status: 'issue', text: missing }], canUndo: false, incomplete: true, unfinished: [{ title: 'Reader requests', route: '/reader-requests/' }] }
    }
  ]
});
writeFileSync(join(chatDir, 'c_unfinished.json'), JSON.stringify(unfinished('c_unfinished', ask, 40, originalCtx)));
// A request about a page that has since been deleted.
const gone = 'Finish the testimonials on the Events page';
writeFileSync(join(chatDir, 'c_gone.json'), JSON.stringify(unfinished('c_gone', gone, 50, { ...originalCtx, pageId: 'pg_deleted0', pageTitle: 'Events' }, 'no-changes')));
const continueButton = () => win.locator('.result-card').getByRole('button', { name: 'Continue' });
assert.equal(await continueButton().count(), 0, 'a finished request offers no Continue');
await pick(ask);
await eventually(async () => assert.equal(await chatTitle().textContent(), ask));
await win.locator('.result-card .result-title', { hasText: 'Partly done' }).waitFor();
// A draft that happens to read "Continue" is still the user's own: the button never clears it.
await type('Continue');
await continueButton().click();
const sent = await eventually(async () => {
  const s = await app.evaluate(() => globalThis.__sent);
  assert.equal(s.length, 1, 'one continuation is sent');
  return s;
});
assert.deepEqual(sent[0], { text: 'Continue', ctx: originalCtx, conversationId: 'c_unfinished' }, 'sent with the original request’s page and width, to its own conversation');
await composerIs('Continue');
await message().fill('');

step('Continue never guesses a page that has gone: the user picks where to carry on');
await pick(gone);
await win.locator('.result-card .result-title', { hasText: 'Not finished' }).waitFor();
await continueButton().click();
await composerIs('Continue');
await win.locator('.toast', { hasText: 'Events is no longer in the site' }).waitFor();
assert.equal((await app.evaluate(() => globalThis.__sent)).length, 1, 'nothing is sent for a page that has gone');
await message().fill('');

await app.close();
allErrors.push(...errors);
assert.deepEqual(allErrors, [], 'no uncaught errors in the editor');
cleanup();
console.log('\nchat-drafts: passed');
