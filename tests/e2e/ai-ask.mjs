// Read-only questions in the real app (issue #203): a question about the Contact page is answered while the
// author keeps editing, the editor says the AI is reading rather than editing, the answer names the Inspector's
// own path to the studio hours, and "Open in inspector" opens Contact, selects Contact details, expands Hours and
// focuses Value without changing the site or its history. Once the row is gone, the same button says so and
// nothing moves. The model is a local OpenAI-compatible server in this process, scripted reply by reply.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';

const { WORK, SHOTS, cleanup } = scratch('ai-ask');
const server = await new MockOpenAIServer().start();
let app;
let passed = false;

try {
  const launched = await launch(WORK);
  app = launched.app;
  const { win, errors } = launched;
  await win.evaluate((baseURL) => window.builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL, allowRemote: false, toolMode: 'constrained-json' } } }), server.baseURL);
  await win.reload();
  await win.waitForSelector('.welcome');

  const message = () => win.getByRole('textbox', { name: 'Message' });
  const log = () => win.locator('.chat-log');
  const posts = () => server.requests.filter((r) => r.method === 'POST');
  const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
  const apply = (operations) => win.evaluate((ops) => window.builder.project.apply({ operations: ops }, { label: 'Author edit' }), operations);
  const HOURS = 'Tuesday to Saturday, 10am – 4pm';
  const PATH = 'Contact → Contact details → Content → Contact methods → Hours → Value';

  step('a business site with its own studio hours, viewed on Home');
  await createProject(win, { name: 'Kloof Light Studio', parentDir: WORK, starter: 'business', sampleImages: false });
  let snap = await snapshot();
  const contact = Object.values(snap.state.pages).find((p) => p.title === 'Contact');
  const nodeId = contact.rootIds.find((id) => snap.state.components[contact.nodes[id].definitionId]?.componentId === 'contact.details');
  const hours = contact.nodes[nodeId].props.items.find((i) => i.label === 'Hours');
  const owner = { kind: 'page', id: contact.id };
  assert.equal((await apply([{ type: 'instance.setProp', owner, nodeId, prop: 'items', itemId: hours.id, value: { value: HOURS } }])).ok, true);
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), /Home/));

  step('the composer asks a read-only question');
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await message().waitFor();
  assert.equal(await message().getAttribute('placeholder'), 'Describe a change…', 'a new message is an edit unless the author chooses Ask');
  await win.getByRole('button', { name: /^Ask: a read-only question/ }).click();
  assert.equal(await message().getAttribute('placeholder'), 'Ask how this site works…');
  assert.match(await log().innerText(), /Ask how your site works/);

  step('while the AI reads, the editor says so and the author keeps editing');
  // The first reply takes a moment, as a real model would, so the question is still running.
  server.script(
    { ...envelopeReply('read_page', { pageId: contact.id }, 'Reading the Contact page'), delayMs: 3000 },
    envelopeReply('locate_field', { owner, nodeId, prop: 'items', itemId: hours.id, field: 'value' }, 'Finding the field'),
    envelopeReply('finish', { message: `The hours read “${HOURS}”. Change them at ${PATH}.` })
  );
  await message().fill('Read the actual Contact page and tell me the current studio hours exactly as written. Tell me where in the editor I can change those hours myself. Please leave the site unchanged.');
  await message().press('Enter');
  await win.locator('.ai-veil', { hasText: 'reading the site' }).waitFor({ timeout: 15000 });
  assert.doesNotMatch(await win.locator('.ai-veil').innerText(), /editing this site/);
  assert.equal(await win.locator('.dock-tab .live').getAttribute('aria-label'), 'Reading the site');
  assert.match(await win.locator('.run-strip .run-phase').innerText(), /Reading the site/);
  const edit = await apply([{ type: 'instance.setProp', owner, nodeId, prop: 'heading', value: 'Visit the studio' }]);
  assert.equal(edit.ok, true, `an edit during a question is saved, not refused (${edit.error?.message ?? ''})`);
  assert.doesNotMatch(await win.locator('.toolbar .save-state').innerText(), /AI is/);
  await win.locator('.chat').screenshot({ path: join(SHOTS, 'ai-ask-reading.png') });

  step('the answer quotes the hours and names the Inspector path, with nothing changed');
  await log().getByText('Answered · site unchanged').waitFor({ timeout: 30000 });
  assert.match(await log().innerText(), new RegExp(HOURS));
  assert.match(await log().locator('.msg-user').last().innerText(), /Question · read only/);
  assert.equal(await log().locator('.locations .location-path').innerText(), PATH);
  // The model heard the exact path and value from the app, and was never offered a way to change the site.
  assert.ok(JSON.stringify(posts()[2].body.messages).includes(PATH.replaceAll('→', '\\u2192')) || JSON.stringify(posts()[2].body.messages).includes(PATH), 'locate_field gave the model the path');
  for (const p of posts()) assert.doesNotMatch(JSON.stringify(p.body), /apply_operations|apply_source_patch|upsert_page_with_sections|update_site_brand|update_selected_props|edit_selected_list|style_selected_element|request_wider_scope|inspect_layout|validate_project/);
  snap = await snapshot();
  assert.equal(snap.state.pages[contact.id].nodes[nodeId].props.heading, 'Visit the studio', 'the author’s edit made during the question is kept');
  await win.locator('.chat').screenshot({ path: join(SHOTS, 'ai-ask-answer.png') });

  step('Open in inspector opens Contact, selects Contact details, opens Content and Hours, and focuses Value');
  // Content starts collapsed, as the author may have left it, so opening it is part of what is checked.
  await win.evaluate(() => localStorage.setItem('section:content', '0'));
  const before = await snapshot();
  await log().getByRole('button', { name: 'Open in inspector' }).click();
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), /Contact/));
  await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Contact details' }).waitFor();
  assert.equal(await win.locator(`#list-head-${hours.id}`).getAttribute('aria-expanded'), 'true');
  await eventually(async () => {
    const focused = await win.evaluate(() => {
      const el = document.activeElement;
      return { field: el?.closest('[data-field]')?.getAttribute('data-field'), item: el?.closest('.list-editor-body')?.id, value: el?.value };
    });
    assert.deepEqual(focused, { field: 'value', item: `list-item-${hours.id}`, value: HOURS });
  });
  const after = await snapshot();
  assert.equal(after.revision, before.revision, 'opening a field changes nothing');
  assert.deepEqual(after.history, before.history, 'and adds no undo step');
  await win.locator('#dock-panel-inspect').screenshot({ path: join(SHOTS, 'ai-ask-opened.png') });

  step('once the row is gone, the same button says so and nothing moves');
  assert.equal((await apply([{ type: 'instance.listRemove', owner, nodeId, prop: 'items', itemId: hours.id }])).ok, true);
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await log().getByRole('button', { name: 'Open in inspector' }).click();
  await win.locator('.toast', { hasText: 'Value can no longer be opened' }).waitFor();
  assert.match(await win.locator('.toolbar .project-title').innerText(), /Contact/);
  assert.equal(await win.locator('.dock-tab', { hasText: 'AI' }).getAttribute('aria-selected'), 'true', 'the AI panel stays open; nothing moves');

  assert.deepEqual(errors, [], 'no page errors');
  passed = true;
  console.log('\nai-ask: all checks passed');
} finally {
  await app?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  if (passed) cleanup();
}
