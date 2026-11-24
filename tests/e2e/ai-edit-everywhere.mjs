// Asking the AI to change a component while it is edited everywhere (issue #191), with Developer mode off: the
// composer names the component instead of the page behind it, the request is limited to the component's design, the
// model is offered the component's contract operations, and adding an editable tagline changes the design and
// nothing on the page. The model is a local OpenAI-compatible server in this process, scripted reply by reply, so
// nothing is sent to a real provider.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';

const { WORK, SHOTS, cleanup } = scratch('ai-edit-everywhere');
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
  assert.equal((await win.evaluate(() => window.builder.app.getSettings())).developerMode, false, 'Developer mode is off');

  const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
  const chips = () => win.locator('.composer .chips');
  const log = () => win.locator('.chat-log');
  const message = () => win.getByRole('textbox', { name: 'Message' });
  const posts = () => server.requests.filter((r) => r.method === 'POST');

  step('a project; the hero is edited everywhere, at its overview');
  const frame = await createProject(win, { name: 'Kloof Light Studio', parentDir: WORK, starter: 'business', sampleImages: false });
  if (!(await win.locator('[role="tree"]').first().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
  await win.locator('[role="tree"] .list-item', { hasText: 'Split hero' }).first().click();
  const compSection = win.locator('.section-head', { hasText: 'Component' });
  if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
  await win.getByRole('button', { name: 'Edit everywhere…' }).click();
  await win.getByRole('button', { name: /Make a copy and edit/ }).click();
  await win.locator('.mode-band').waitFor();
  // Entering selects the whole design; Escape steps back to its overview, with nothing selected.
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await win.locator('.ov-selected').count(), 0, 'the overview has nothing selected'));
  await win.locator('.mode-band').waitFor();

  const before = await snapshot();
  const def = Object.values(before.state.components).find((d) => d.owner === 'project' && d.name === 'Split hero');
  assert.ok(def, 'Edit everywhere made a project copy of the hero');
  const owner = { kind: 'component', id: def.id };
  const homeBefore = JSON.stringify(before.state.pages[before.state.site.homePageId]);

  step('the composer is about the component, not the page behind it');
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await message().waitFor();
  await eventually(async () => assert.equal(await chips().locator('.chip.def').innerText(), 'Split hero'));
  assert.doesNotMatch(await chips().innerText(), /Home|Whole site/, 'no page chip and no whole-site choice');
  assert.equal(await win.locator('.chat .suggestions').count(), 0, 'no page starters while a component is edited');
  await chips().screenshot({ path: join(SHOTS, 'ai-edit-everywhere-chips.png') });

  step('asking for an editable tagline adds a property and binds a new element to it');
  let first;
  server.script(
    (req) => {
      first = req;
      return envelopeReply('apply_operations', {
        expectedRevision: before.revision,
        operations: [
          { type: 'component.setPropSchema', definitionId: def.id, prop: 'tagline', schema: { type: 'string', label: 'Tagline', default: 'Made by hand' } },
          { type: 'node.insert', owner, parentId: 'content', primitive: 'paragraph', text: 'Made by hand' }
        ]
      });
    },
    (req) => {
      // The new element's ID comes back in the result of the insert, the latest tool result.
      const said = JSON.stringify(req.body.messages.at(-1));
      const nodeId = [...said.matchAll(/nodeId\\*"\s*:\s*\\*"(n_[a-z0-9]{4,32})/g)].at(-1)?.[1];
      assert.ok(nodeId, `the insert returned the new element's ID: ${said.slice(0, 400)}`);
      return envelopeReply('apply_operations', { expectedRevision: before.revision + 1, operations: [{ type: 'node.setBinding', owner, nodeId, field: 'text', binding: { $prop: 'tagline' } }] });
    },
    envelopeReply('finish', { message: 'Added an editable tagline under the heading.' })
  );
  await message().fill('Add an editable tagline under the heading');
  await message().press('Enter');
  await log().getByText('Added an editable tagline under the heading.').waitFor({ timeout: 30000 });
  assert.match(await log().locator('.msg-user .ctx').last().innerText(), /Split hero everywhere/, 'the message names the component it was about');

  const sent = JSON.stringify(first.body.messages);
  assert.match(sent, /editingComponent/, 'the model is told which component is edited everywhere');
  assert.match(sent, /only the Split hero component's own design/, 'and that the request is limited to it');
  const grammar = JSON.stringify(first.body.response_format ?? first.body.tools ?? {});
  for (const op of ['component.setPropSchema', 'node.setBinding', 'component.setPart']) assert.ok(grammar.includes(op), `${op} is offered without Developer mode`);
  assert.ok(!grammar.includes('component.createCode'), 'code stays behind Developer mode');

  const after = await snapshot();
  const design = after.state.components[def.id];
  assert.equal(design.properties.tagline?.label, 'Tagline', 'the component has a Tagline property');
  assert.ok(
    Object.values(design.tree.nodes).some((n) => JSON.stringify(n.text) === JSON.stringify({ $prop: 'tagline' })),
    'a new element in the design shows the tagline'
  );
  assert.equal(JSON.stringify(after.state.pages[after.state.site.homePageId]), homeBefore, 'the page behind the component did not change');

  step('an element of the design narrows the next message to it, or the whole component');
  // A click in the page picks the design's own node under the pointer.
  const heroId = after.state.pages[after.state.site.homePageId].rootIds[0];
  await frame.locator(`[data-so-ctx$="|${heroId}"] h1`).first().click();
  await eventually(async () => assert.equal(await win.locator('[role="tree"] [data-node="heading"]').getAttribute('aria-selected'), 'true', 'the heading of the design is selected'));
  await eventually(async () => assert.match(await chips().innerText(), /Heading[\s\S]*Whole component/));
  assert.doesNotMatch(await chips().innerText(), /Whole site/);

  step('finishing goes back to the page, and the composer with it');
  await win.locator('.mode-band-done').click();
  await win.locator('.mode-band').waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await chips().locator('.chip.def').count(), 0));
  await eventually(async () => assert.match(await chips().innerText(), /Home/));

  assert.deepEqual(errors, [], 'no page errors');
  passed = true;
  console.log('\nai-edit-everywhere: all checks passed');
} finally {
  // A failed run still closes the app and the model server, so the script ends instead of hanging; it keeps
  // its scratch folder for inspection.
  await app?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  if (passed) cleanup();
}
