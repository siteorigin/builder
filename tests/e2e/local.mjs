// Local model settings in the real app (issue #122): Local is chosen in Settings, a server preset is picked, the
// server's models are discovered and one is chosen, the connection is tested with a short chat request, and a chat
// edit runs through that model and lands in the project. Each turn names the model it went to (issue #86): switching
// models while a reply is held leaves that turn's model alone, the composer says what history the next model gets,
// Start fresh leaves it behind, and a message goes only to the model the composer named. Then (issue #83) a second
// server: switching to it moves both the model menu and the requests' `model` to its own model, and switching back
// restores the first server's choice.
// With that server stopped, Chat says so instead of offering starters, and a request fails saying nothing changed,
// with AI settings and Try again on its card. Restarted with a model it lists but cannot chat with, Test connection
// fails it; once the model answers, Try again sends the same request and it lands. The servers are OpenAI-compatible
// mocks in this process, the first on the preset's own port, so nothing is sent to a real model.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply, textReply } from '../unit/mock-openai-server.ts';
import { LOCAL_PRESETS } from '../../src/shared/local.ts';

/**
 * The last preset whose port is free, with the mock server listening on it. Last first, so the preset that is
 * chosen is not the default address a broken preset button would leave in place.
 */
async function serveOnPreset() {
  const taken = [];
  for (const preset of [...LOCAL_PRESETS].reverse()) {
    const server = new MockOpenAIServer();
    try {
      return { preset, server: await server.start(Number(new URL(preset.baseURL).port)) };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      taken.push(preset.baseURL);
    }
  }
  throw new Error(`Every local preset port is in use (${taken.join(', ')}), so none can be served for this test.`);
}

const { WORK, cleanup } = scratch('local');
const { preset, server } = await serveOnPreset();
console.log(`local: serving ${preset.label} at ${server.baseURL}`);
assert.equal(server.baseURL, preset.baseURL);
// The second model is the one chosen, so a model picker that silently keeps the server's first model fails.
server.models = { object: 'list', data: [{ id: 'first-model', object: 'model' }, { id: 'second-model', object: 'model' }] };
const gets = () => server.requests.filter((r) => r.method === 'GET' && r.url === '/v1/models');
const posts = () => server.requests.filter((r) => r.method === 'POST');
// The second server, on a port of its own, listing only its own model.
let second = await new MockOpenAIServer().start();
const secondPort = Number(new URL(second.baseURL).port);
const secondURL = second.baseURL;
const secondModels = { object: 'list', data: [{ id: 'studio-b', object: 'model' }] };
second.models = secondModels;
let app;
let passed = false;

try {
  const launched = await launch(WORK);
  app = launched.app;
  const { win, errors } = launched;
  // The saved address starts on this server, written another way, so Settings never asks anything else for its
  // models (a real llama.cpp on the default port, say) and the preset still has to be picked to match.
  await win.evaluate((baseURL) => window.builder.app.setSettings({ ai: { local: { baseURL } } }), `${preset.baseURL}/`);
  await win.reload();
  await win.waitForSelector('.welcome');
  const settings = () => win.evaluate(() => window.builder.app.getSettings());
  const siteName = async () => {
    const { state } = await win.evaluate(() => window.builder.project.snapshot());
    return state.site.shell.header.nodes[state.site.shell.header.rootIds[0]].props.siteName;
  };

  step('a project to edit');
  await createProject(win, { name: 'Kloof Light Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  const before = await siteName();
  assert.notEqual(before, 'Harbor Coffee');

  step('Settings: the Local model provider');
  await win.locator('[aria-label="Settings"]').click();
  const dialog = win.locator('.modal');
  await dialog.getByRole('tab', { name: 'AI assistant' }).click();
  await dialog.getByRole('radio', { name: 'Local model' }).click();
  await eventually(async () => assert.equal((await settings()).ai.provider, 'local'));

  step(`the ${preset.label} preset`);
  const presetButton = dialog.getByRole('group', { name: 'Common server apps' }).getByRole('button', { name: preset.label, exact: true });
  assert.equal(await presetButton.getAttribute('aria-current'), null, 'the preset is not chosen yet');
  await presetButton.click();
  await eventually(async () => assert.equal(await presetButton.getAttribute('aria-current'), 'true'));
  assert.equal(await dialog.locator('#settings-local-url').inputValue(), preset.baseURL);
  await eventually(async () => assert.equal((await settings()).ai.local.baseURL, preset.baseURL));

  step('the server models are discovered and the second is chosen');
  const modelSelect = dialog.locator('#settings-local-model');
  // Named Refresh only once a check has settled; it reads Checking… while one runs.
  const refreshButton = dialog.getByRole('button', { name: 'Refresh', exact: true });
  await eventually(async () => assert.equal(await refreshButton.isEnabled(), true));
  const beforeRefresh = gets().length;
  await refreshButton.click();
  await eventually(async () => assert.ok(gets().length > beforeRefresh, 'Refresh asks the server for its models'));
  await eventually(async () => assert.deepEqual(await modelSelect.locator('option').allInnerTexts(), ["Use the server's model", 'first-model', 'second-model']));
  await modelSelect.selectOption('second-model');
  await eventually(async () => assert.equal((await settings()).ai.models.local, 'second-model'));

  step('the connection is tested with a short chat request to the chosen model');
  await eventually(async () => assert.equal(await refreshButton.isEnabled(), true));
  const asked = gets().length;
  const connection = dialog.locator('#settings-connection');
  // Being listed is not enough: the test only passes once the model answers a chat request.
  await connection.filter({ hasText: 'A listed model may still fail to chat' }).waitFor();
  server.script(textReply('OK'));
  await dialog.locator('.settings-status').getByRole('button', { name: 'Test connection' }).click();
  await connection.filter({ hasText: 'Connection test passed' }).filter({ hasText: 'second-model answered a test chat request.' }).waitFor({ timeout: 15000 });
  assert.ok(gets().length > asked, 'the test asked the server for its models');
  assert.equal(posts().length, 1, 'the test sent one chat request');
  assert.equal(posts()[0].url, '/v1/chat/completions');
  assert.equal(posts()[0].body.model, 'second-model');

  step('a cloud key pasted into the Local key field is refused, and never sent');
  await dialog.locator('.settings-advanced summary').click();
  const keyField = dialog.locator('#settings-api-key');
  const cloudKey = `sk-ant-api03-${'NotARealKey_0123456789-'.repeat(4)}`;
  const beforeKey = server.requests.length;
  await keyField.fill(cloudKey);
  await dialog.locator('.field-error', { hasText: 'This looks like an Anthropic API key' }).waitFor();
  assert.equal(await keyField.getAttribute('aria-invalid'), 'true');
  assert.equal(await dialog.getByRole('button', { name: 'Save key', exact: true }).isEnabled(), false, 'the key cannot be saved');
  await dialog.locator('.settings-status').getByRole('button', { name: 'Test this key' }).click();
  await connection.filter({ hasText: 'This looks like an Anthropic API key' }).waitFor({ timeout: 15000 });
  await keyField.press('Enter');
  assert.equal(server.requests.length, beforeKey, 'nothing was sent to the server, with or without the key');
  assert.equal((await win.evaluate(() => window.builder.ai.providers())).find((p) => p.id === 'local').source, null, 'no key was saved');
  await keyField.fill('');
  await dialog.locator('button.btn', { hasText: /^Close$/ }).click();
  await dialog.waitFor({ state: 'detached' });

  step('a chat edit through the local model');
  server.script(envelopeReply('update_site_brand', { siteName: 'Harbor Coffee' }, 'Renaming the site'), envelopeReply('finish', { message: 'Renamed the site to Harbor Coffee.' }));
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  const message = win.getByRole('textbox', { name: 'Message' });
  /** Send a request and wait for its result card. */
  const sendRequest = async (text) => {
    const cards = await win.locator('.result-card').count();
    await message.fill(text);
    await message.press('Enter');
    await eventually(async () => assert.ok((await win.locator('.result-card').count()) > cards, 'the run ends with a result card'), 60000, 200);
    return win.locator('.result-card').last();
  };
  // With nothing selected, an edit keeps to the open page until the whole site is chosen (#513).
  // What the edit may change is one chip under the message; its menu holds the choices.
  const scopeChip = win.locator('.composer .scope-chip');
  const chooseScope = async (name) => {
    await scopeChip.click();
    await win.getByRole('menuitemradio', { name }).click();
  };
  assert.doesNotMatch(await scopeChip.getAttribute('aria-label'), /Whole site/, 'an edit starts on the open page');
  await chooseScope(/^Whole site/);
  await eventually(async () => assert.match(await scopeChip.getAttribute('aria-label'), /Whole site/));
  /** What a request told the model about where it was sent from. */
  const sentContext = (body) => JSON.parse(/<editor_context>\n([\s\S]*)\n<\/editor_context>/.exec(body.messages.at(-1).content)[1]);
  const tested = posts().length;
  assert.equal(tested, 1, 'only the connection test has asked for a reply so far');
  const card = await sendRequest('Rename the site to Harbor Coffee');
  assert.match((await card.getAttribute('class')) ?? '', /\bcompleted\b/);
  await win.locator('.msg-ai').last().getByText('Renamed the site to Harbor Coffee.').waitFor();
  assert.equal(await siteName(), 'Harbor Coffee', 'the edit landed in the project');
  const edits = posts().slice(tested);
  assert.equal(edits.length, 2);
  for (const p of edits) {
    assert.equal(p.url, '/v1/chat/completions');
    assert.equal(p.body.model, 'second-model');
  }
  assert.match(JSON.stringify(edits[1].body.messages), /Result of update_site_brand/, 'the tool result went back to the model');
  // The whole site, starting from the open page's sections, so nothing had to be read first.
  assert.equal(sentContext(edits[0].body).allowedScope, 'whole site');
  assert.ok(sentContext(edits[0].body).currentPage.sections.length > 0, "the open page's sections went with the request");
  // Each turn names its model, as a screen reader reads it too.
  const said = (texts) => texts.map((t) => t.replace(/\s+/g, ' ').trim());
  const turnModels = async () => {
    const texts = [];
    for (const turn of await win.locator('.msg-ai').all()) {
      const model = turn.locator('.turn-model, .turn-handled');
      const details = turn.locator('.steps-toggle, .reply-toggle');
      const openDetails = !(await model.count()) && (await details.count()) === 1 && (await details.getAttribute('aria-expanded')) === 'false';
      if (openDetails) await details.click();
      try {
        texts.push(await model.textContent({ timeout: 5000 }));
      } finally {
        if (openDetails) await details.click();
      }
    }
    return said(texts);
  };
  await eventually(async () => assert.deepEqual(await turnModels(), ['Handled by Local model · second-model']));

  const openAi = async () => {
    await win.locator('[aria-label="Settings"]').click();
    await dialog.getByRole('tab', { name: 'AI assistant' }).click();
  };
  const closeSettings = async () => {
    await dialog.locator('button.btn', { hasText: /^Close$/ }).click();
    await dialog.waitFor({ state: 'detached' });
  };
  const useAddress = async (url) => {
    const field = dialog.locator('#settings-local-url');
    await field.fill(url);
    await field.press('Enter');
    await eventually(async () => assert.equal((await settings()).ai.local.baseURL, url));
  };
  const modelOptions = () => modelSelect.locator('option').allInnerTexts();

  // Issue #86: the model a turn went to is fixed on that turn, apart from the one Settings choose for the next message.
  step('the model is switched in Settings while a reply is held');
  const chooseLocalModel = async (id) => {
    await win.locator('[aria-label="Settings"]').click();
    await dialog.getByRole('tab', { name: 'AI assistant' }).click();
    await modelSelect.selectOption(id);
    await eventually(async () => assert.equal((await settings()).ai.models.local, id));
    await dialog.locator('button.btn', { hasText: /^Close$/ }).click();
    await dialog.waitFor({ state: 'detached' });
  };
  let release;
  server.script({ ...envelopeReply('finish', { message: 'Noted cobalt.' }), hold: new Promise((resolve) => (release = resolve)) });
  const sentBefore = posts().length;
  await message.fill('Remember cobalt as the accent colour');
  await message.press('Enter');
  const strip = win.locator('.run-strip');
  await eventually(async () => assert.ok(posts().length > sentBefore, 'the held request reached the server'));
  const runModel = async () => said([(await strip.locator('.run-model').textContent()) ?? ''])[0];
  await eventually(async () => assert.equal(await runModel(), 'Sent to Local model · second-model'));
  await chooseLocalModel('first-model');
  const composerModel = win.locator('.composer-model');
  await win.getByRole('button', { name: 'Next: first-model, Local model. Change AI provider or model', exact: true }).waitFor();
  assert.equal((await composerModel.innerText()).trim(), 'Next: first-model');
  assert.equal(await runModel(), 'Sent to Local model · second-model', 'the running turn still names the model it went to');
  assert.match(await strip.locator('.run-phase').innerText(), /Working/);
  const notice = win.locator('.switch-note');
  assert.equal(await notice.count(), 0, 'a running turn with an empty composer has no switch notice');
  await message.fill('A fresh question for first-model');
  await eventually(async () => assert.equal(await notice.innerText(), 'Your next message goes to Local model · first-model with recent messages from your conversation with Local model · second-model. Start fresh'));
  assert.equal(await notice.getByRole('button', { name: 'Start fresh' }).isDisabled(), true, 'a new conversation waits for the running request');
  release();
  await win.locator('.msg-ai').last().getByText('Noted cobalt.').waitFor({ timeout: 60000 });
  assert.equal(posts().at(-1).body.model, 'second-model', 'the held request was sent to the model chosen when it started');
  assert.deepEqual(await turnModels(), ['Handled by Local model · second-model', 'Handled by Local model · second-model']);
  // Once nothing runs, the selector shows the model, and says out loud that it is for the next message.
  await win.getByRole('button', { name: 'Next message: first-model, Local model. Change AI provider or model', exact: true }).waitFor();
  assert.equal((await composerModel.innerText()).trim(), 'first-model');

  step('Start fresh takes the unsent message to a new conversation without the earlier ones');
  await notice.waitFor();
  await notice.getByRole('button', { name: 'Start fresh' }).click();
  await eventually(async () => assert.equal(await win.locator('.chat-title').innerText(), 'New conversation'));
  assert.equal(await message.inputValue(), 'A fresh question for first-model', 'the unsent message came along');
  assert.equal(await win.locator('.msg-ai').count(), 0);
  assert.equal(await notice.count(), 0, 'a new conversation carries nothing to warn about');
  server.script(envelopeReply('finish', { message: 'Fresh answer.' }));
  const freshSent = posts().length;
  await message.press('Enter');
  await win.locator('.msg-ai').last().getByText('Fresh answer.').waitFor({ timeout: 60000 });
  assert.equal(posts().length, freshSent + 1);
  assert.equal(posts().at(-1).body.model, 'first-model');
  const freshBody = JSON.stringify(posts().at(-1).body.messages);
  assert.match(freshBody, /A fresh question for first-model/);
  // The site is now called Harbor Coffee, which every request's project summary says; the conversation's own words are not sent.
  assert.doesNotMatch(freshBody, /Remember cobalt|Noted cobalt|Rename the site/, 'nothing from the earlier conversation went with it');
  assert.deepEqual(await turnModels(), ['Handled by Local model · first-model']);

  step('the earlier conversation, reopened, still names the model of each turn');
  await win.getByRole('button', { name: 'Earlier conversations' }).click();
  await win.locator('.menu [role^="menuitem"]', { hasText: 'Rename the site to Harbor Coffee' }).click();
  await eventually(async () => assert.equal(await win.locator('.chat-title').innerText(), 'Rename the site to Harbor Coffee'));
  assert.deepEqual(await turnModels(), ['Handled by Local model · second-model', 'Handled by Local model · second-model']);
  await notice.filter({ hasText: 'from your conversation with Local model · second-model.' }).waitFor();

  step('a message sent anyway goes to the new model with the recent messages, as the notice said');
  server.script(envelopeReply('finish', { message: 'Got it from first-model.' }));
  const followSent = posts().length;
  await message.fill('A follow-up for first-model');
  await message.press('Enter');
  await win.locator('.msg-ai').last().getByText('Got it from first-model.').waitFor({ timeout: 60000 });
  assert.equal(posts().length, followSent + 1);
  assert.equal(posts().at(-1).body.model, 'first-model');
  assert.match(JSON.stringify(posts().at(-1).body.messages), /Remember cobalt/, 'the earlier note went with it');
  assert.deepEqual(await turnModels(), ['Handled by Local model · second-model', 'Handled by Local model · second-model', 'Handled by Local model · first-model']);
  await eventually(async () => assert.equal(await notice.count(), 0, 'first-model has now seen the conversation'));

  step('switching this conversation to a hosted provider warns that its messages leave this computer');
  await win.evaluate(() => window.builder.ai.setKey('openai', `sk-proj-${'e2eNotARealKey0123456789'.repeat(2)}`));
  await win.locator('[aria-label="Settings"]').click();
  await dialog.getByRole('tab', { name: 'AI assistant' }).click();
  await dialog.getByRole('radio', { name: 'OpenAI' }).click();
  await eventually(async () => assert.equal((await settings()).ai.provider, 'openai'));
  await dialog.locator('button.btn', { hasText: /^Close$/ }).click();
  await dialog.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await notice.innerText(), 'Your next message goes to OpenAI · GPT-6.2 Sol with recent messages from your conversation with Local model · first-model and Local model · second-model. Those messages leave this computer. Start fresh'));
  assert.match((await notice.getAttribute('class')) ?? '', /\bdanger\b/);

  step('a message goes only to the model the composer named, even if Settings changed underneath');
  // Settings now name the local server in the main process, while the composer still says OpenAI.
  await win.evaluate(() => window.builder.app.setSettings({ ai: { provider: 'local' } }));
  const quietCards = await win.locator('.result-card').count();
  const quietSent = posts().length;
  await message.fill('Meant for OpenAI only');
  await message.press('Enter');
  await eventually(async () => assert.ok((await win.locator('.result-card').count()) > quietCards, 'the turn ends'), 60000, 200);
  await win.locator('.result-card').last().getByText('Nothing was sent. This message was for OpenAI · GPT-6.2 Sol, but it would now go to Local model · first-model.', { exact: false }).waitFor();
  assert.match((await win.locator('.result-card').last().getAttribute('class')) ?? '', /\bfailed\b/);
  assert.equal(posts().length, quietSent, 'nothing reached the local server');

  step("back on Local, with the first server's model chosen again, for the servers that follow");
  // The composer still names OpenAI (Settings changed underneath it), so Local is chosen where the author would.
  await openAi();
  await dialog.getByRole('radio', { name: 'Local model' }).click();
  await eventually(async () => assert.equal((await settings()).ai.provider, 'local'));
  await eventually(async () => assert.deepEqual(await modelOptions(), ["Use the server's model", 'first-model', 'second-model']), 15000);
  await modelSelect.selectOption('second-model');
  await eventually(async () => assert.equal((await settings()).ai.models.local, 'second-model'));
  await closeSettings();

  step('a second server: the model menu and the requests follow it');
  await openAi();
  await useAddress(secondURL);
  await eventually(async () => assert.deepEqual(await modelOptions(), ["Use the server's model", 'studio-b']), 15000);
  assert.equal(await modelSelect.inputValue(), '', "the first server's model is not carried over");
  assert.equal((await settings()).ai.models.local, '');
  await modelSelect.selectOption('studio-b');
  await eventually(async () => assert.equal((await settings()).ai.models.local, 'studio-b'));
  assert.deepEqual((await settings()).ai.local.modelsByServer, { [preset.baseURL]: 'second-model', [secondURL]: 'studio-b' });
  second.script(textReply('OK'));
  await dialog.locator('.settings-status').getByRole('button', { name: 'Test connection' }).click();
  await connection.filter({ hasText: 'studio-b answered a test chat request.' }).waitFor({ timeout: 15000 });
  await closeSettings();
  const firstPosts = posts().length;
  second.script(envelopeReply('update_site_brand', { siteName: 'Studio B Coffee' }, 'Renaming the site'), envelopeReply('finish', { message: 'Renamed the site to Studio B Coffee.' }));
  assert.match((await (await sendRequest('Rename the site to Studio B Coffee')).getAttribute('class')) ?? '', /\bcompleted\b/);
  assert.equal(await siteName(), 'Studio B Coffee');
  const secondPosts = second.requests.filter((r) => r.method === 'POST');
  assert.deepEqual(
    secondPosts.map((p) => p.body.model),
    ['studio-b', 'studio-b', 'studio-b'],
    'the test and both turns of the edit asked for the second server\'s model'
  );
  assert.equal(posts().length, firstPosts, 'nothing more went to the first server');

  step("back on the first server, its own choice is restored");
  await openAi();
  await presetButton.click();
  await eventually(async () => assert.equal(await modelSelect.inputValue(), 'second-model'), 15000);
  assert.equal((await settings()).ai.models.local, 'second-model');
  await useAddress(secondURL);
  await eventually(async () => assert.deepEqual(await modelOptions(), ["Use the server's model", 'studio-b']), 15000);
  assert.equal(await modelSelect.inputValue(), 'studio-b', "the second server's own choice is restored too");
  // Back to the server's own model, so the next request has to ask the server what it has.
  await modelSelect.selectOption('');
  await eventually(async () => assert.equal((await settings()).ai.models.local, ''));

  step('no server: Chat says so instead of offering starters, and a request fails saying nothing changed');
  await second.stop();
  await dialog.locator('.settings-status').getByRole('button', { name: 'Test connection' }).click();
  await connection.filter({ hasText: 'Connection failed' }).filter({ hasText: 'Is your local server running?' }).waitFor({ timeout: 15000 });
  await closeSettings();
  await win.getByRole('button', { name: 'New conversation' }).click();
  const notReady = win.locator('.chat-not-ready');
  await notReady.filter({ hasText: "Can't use your local model server." }).filter({ hasText: 'Is your local server running?' }).waitFor({ timeout: 15000 });
  assert.equal(await win.locator('.suggestions').count(), 0, 'no starters are offered');
  // Everything the toolbar's live region says from here on: the same words twice in a row read the same.
  const listen = () =>
    win.evaluate(() => {
      window.__listening?.disconnect();
      const region = document.querySelector('.toolbar .sr-only[role="status"]');
      const heard = (window.__heard = []);
      window.__listening = new MutationObserver(() => heard.push(region.textContent.trim()));
      window.__listening.observe(region, { childList: true, characterData: true, subtree: true });
    });
  const heard = () => win.evaluate(() => window.__heard);
  await listen();
  const request = 'Rename the site to Harbor Tea';
  const down = await sendRequest(request);
  // The request as shown, with the page it was about.
  const shownRequest = () => win.locator('.msg-user').last().evaluate((el) => ({
    text: [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim(),
    context: el.lastElementChild?.textContent?.trim().replace(/^\((.*)\)$/, '$1')
  }));
  const sent = await shownRequest();
  assert.equal(sent.text, request);
  assert.match((await down.getAttribute('class')) ?? '', /\bfailed\b/);
  await down.getByText('Nothing in the site was changed.', { exact: false }).waitFor();
  await down.getByText('Is your local server running?', { exact: false }).waitFor();
  // It failed before it started working, and the toolbar says so rather than how the request before it ended.
  await eventually(async () => assert.deepEqual(await heard(), ['AI request failed']));
  assert.equal(await siteName(), 'Studio B Coffee', 'the site is unchanged');
  await down.getByRole('button', { name: 'Open AI settings' }).waitFor();
  await down.getByRole('button', { name: 'Try again', exact: true }).waitFor();

  step('a model the server lists but that cannot chat: Test connection says so, and Try again sends the same request');
  second = await new MockOpenAIServer().start(secondPort);
  second.models = secondModels;
  const rejection = () => ({ status: 400, body: JSON.stringify({ error: { message: 'studio-b cannot generate chat completions' } }) });
  // Refused with the compact schema, then with the same schema written out in full.
  second.script(rejection(), rejection());
  await listen();
  await down.getByRole('button', { name: 'Try again', exact: true }).click();
  await eventually(async () => assert.equal(second.requests.filter((r) => r.method === 'POST').length, 2), 30000, 200);
  assert.match(JSON.stringify(second.requests.find((r) => r.method === 'POST').body.messages), /Rename the site to Harbor Tea/, 'the same request was sent again');
  const rejected = win.locator('.result-card').last();
  await rejected.getByText('studio-b cannot generate chat completions', { exact: false }).waitFor({ timeout: 30000 });
  assert.match((await rejected.getAttribute('class')) ?? '', /\bfailed\b/);
  await rejected.getByText('Nothing in the site was changed.', { exact: false }).waitFor();
  await eventually(async () => assert.deepEqual(await heard(), ['AI is working', 'AI request failed']));
  await rejected.getByRole('button', { name: 'Open AI settings' }).click();
  await dialog.waitFor();
  second.script(rejection());
  await dialog.locator('.settings-status').getByRole('button', { name: /Test connection|Try again/ }).click();
  await connection.filter({ hasText: 'The model did not answer' }).filter({ hasText: 'The server lists studio-b, but a test chat request failed' }).waitFor({ timeout: 15000 });
  await closeSettings();

  step('once the model answers, Try again lands the same request');
  second.script(envelopeReply('update_site_brand', { siteName: 'Harbor Tea' }, 'Renaming the site'), envelopeReply('finish', { message: 'Renamed the site to Harbor Tea.' }));
  const userMessages = await win.locator('.msg-user').count();
  const beforeRetry = second.requests.filter((r) => r.method === 'POST').length;
  // Something the author is writing meanwhile stays where it is.
  await message.fill('A note for later');
  await rejected.getByRole('button', { name: 'Try again', exact: true }).click();
  await eventually(async () => assert.match((await win.locator('.result-card').last().getAttribute('class')) ?? '', /\bcompleted\b/), 60000, 200);
  assert.equal(await siteName(), 'Harbor Tea', 'the retried request landed');
  // With no model chosen on this server, each request asked for the one it lists.
  assert.deepEqual(new Set(second.requests.filter((r) => r.method === 'POST').map((p) => p.body.model)), new Set(['studio-b']));
  assert.equal(await win.locator('.msg-user').count(), userMessages + 1);
  assert.deepEqual(await shownRequest(), sent, 'it was the original request, about the same page');
  assert.equal(sentContext(second.requests.filter((r) => r.method === 'POST')[beforeRetry].body).allowedScope, 'whole site', 'and as far as it reached');
  assert.equal(await message.inputValue(), 'A note for later', 'the draft was kept');

  step('with This page chosen, an edit keeps to the open page and starts from its sections');
  await chooseScope(/^This page/);
  await eventually(async () => assert.doesNotMatch(await scopeChip.getAttribute('aria-label'), /Whole site/));
  second.script(envelopeReply('finish', { message: 'It reads well.' }));
  const pagePosts = second.requests.filter((r) => r.method === 'POST').length;
  await message.fill('What would you change on this page?');
  await message.press('Enter');
  const reply = win.locator('.msg-ai').last().locator('.reply[data-status="no-changes"]');
  await reply.getByText('It reads well.').waitFor({ timeout: 60000 });
  const pageRun = second.requests.filter((r) => r.method === 'POST')[pagePosts].body;
  assert.match(sentContext(pageRun).allowedScope, /^only the Home page \(page pg_\w+\)/);
  assert.ok(sentContext(pageRun).currentPage.sections.length > 0);
  assert.doesNotMatch(JSON.stringify(pageRun.response_format), /update_site_brand/, 'the site-wide brand tool is not offered');
  assert.match(await win.locator('.msg-user').last().innerText(), /This page · Home/);
  assert.deepEqual(errors, []);
  passed = true;
  console.log('\nlocal: all checks passed');
} finally {
  await app?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  await second.stop().catch(() => undefined);
  if (passed) cleanup();
}
