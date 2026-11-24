// Local model settings in the real app (issue #122): Local is chosen in Settings, a server preset is picked, the
// server's models are discovered and one is chosen, the connection is tested, and a chat edit runs through that
// model and lands in the project. The server is an OpenAI-compatible mock in this process, listening on the
// preset's own port, so nothing is sent to a real model.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';
import { LOCAL_PRESETS } from '../../src/shared/local.ts';

/** The first preset whose port is free, with the mock server listening on it. */
async function serveOnPreset() {
  const taken = [];
  for (const preset of LOCAL_PRESETS) {
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

const { preset, server } = await serveOnPreset();
const { WORK, cleanup } = scratch('local');
// The second model is the one chosen, so a model picker that silently keeps the server's first model fails.
server.models = { object: 'list', data: [{ id: 'first-model', object: 'model' }, { id: 'second-model', object: 'model' }] };
const gets = () => server.requests.filter((r) => r.method === 'GET' && r.url === '/v1/models');
const posts = () => server.requests.filter((r) => r.method === 'POST');
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
  await dialog.getByRole('button', { name: 'Local model' }).click();
  await eventually(async () => assert.equal((await settings()).ai.provider, 'local'));

  step(`the ${preset.label} preset`);
  const presetButton = dialog.getByRole('group', { name: 'Server presets' }).getByRole('button', { name: preset.label, exact: true });
  assert.equal(await presetButton.getAttribute('aria-pressed'), 'false', 'the preset is not chosen yet');
  await presetButton.click();
  await eventually(async () => assert.equal(await presetButton.getAttribute('aria-pressed'), 'true'));
  assert.equal(await dialog.locator('#settings-local-url').inputValue(), preset.baseURL);
  await eventually(async () => assert.equal((await settings()).ai.local.baseURL, preset.baseURL));

  step('the server models are discovered and the second is chosen');
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  const modelSelect = dialog.locator('#settings-local-model');
  await eventually(async () => assert.deepEqual(await modelSelect.locator('option').allInnerTexts(), ["Use the server's model", 'first-model', 'second-model']));
  await modelSelect.selectOption('second-model');
  await eventually(async () => assert.equal((await settings()).ai.models.local, 'second-model'));

  step('the connection is tested against the chosen model');
  await eventually(async () => assert.equal(await dialog.getByRole('button', { name: 'Refresh' }).isEnabled(), true));
  const asked = gets().length;
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await win.locator('.toast', { hasText: 'Connected. second-model is available.' }).waitFor({ timeout: 15000 });
  assert.ok(gets().length > asked, 'the test asked the server for its models');
  assert.equal(posts().length, 0, 'nothing is generated before a chat');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });

  step('a chat edit through the local model');
  server.script(envelopeReply('update_site_brand', { siteName: 'Harbor Coffee' }, 'Renaming the site'), envelopeReply('finish', { message: 'Renamed the site to Harbor Coffee.' }));
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  const cards = await win.locator('.result-card').count();
  const message = win.getByRole('textbox', { name: 'Message' });
  await message.fill('Rename the site to Harbor Coffee');
  await message.press('Enter');
  await eventually(async () => assert.ok((await win.locator('.result-card').count()) > cards, 'the run ends with a result card'), 60000, 200);
  const card = win.locator('.result-card').last();
  assert.match((await card.getAttribute('class')) ?? '', /\bcompleted\b/);
  await win.locator('.msg-ai').last().getByText('Renamed the site to Harbor Coffee.').waitFor();
  assert.equal(await siteName(), 'Harbor Coffee', 'the edit landed in the project');
  assert.equal(posts().length, 2);
  for (const p of posts()) {
    assert.equal(p.url, '/v1/chat/completions');
    assert.equal(p.body.model, 'second-model');
  }
  assert.match(JSON.stringify(posts()[1].body.messages), /Result of update_site_brand/, 'the tool result went back to the model');
  assert.deepEqual(errors, []);
  passed = true;
  console.log('\nlocal: all checks passed');
} finally {
  await app?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  if (passed) cleanup();
}
