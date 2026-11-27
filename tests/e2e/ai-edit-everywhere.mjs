// Asking the AI to change a component while it is edited everywhere (issue #191), with Developer mode off: the
// composer names the component instead of the page behind it, the request is limited to the component's design, the
// small model is offered the design's own tools (#360) instead of the general operations, and adding an editable
// tagline changes the design and nothing on the page. The model is a local OpenAI-compatible server in this process, scripted reply by reply, so
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
  const chips = () => win.locator('.composer .composer-context');
  const log = () => win.locator('.chat-log');
  const message = () => win.getByRole('textbox', { name: 'Message' });
  /** The editor context a request was sent with, read from the user's message the way the model reads it. */
  const editorContext = (req) => {
    const text = JSON.stringify(req.body.messages.filter((m) => m.role === 'user'));
    const all = [...text.matchAll(/<editor_context>\\n([\s\S]*?)\\n<\/editor_context>/g)];
    assert.ok(all.length, 'the request carries an editor context');
    return JSON.parse(JSON.parse(`"${all.at(-1)[1]}"`));
  };
  /** The latest tool result a request carries, as text. */
  const lastResult = (req) => JSON.stringify(req.body.messages.at(-1));

  step('a project, with page starters in the AI tab');
  const frame = await createProject(win, { name: 'Kloof Light Studio', parentDir: WORK, starter: 'business', sampleImages: false });
  const initial = await snapshot();
  const made = await win.evaluate(async (home) => {
    const definition = await window.builder.project.apply({ operations: [{ type: 'component.upsert', name: 'Split hero', properties: {},
      parts: { heading: { nodeId: 'heading', label: 'Heading' } },
      nodes: [{ kind: 'element', id: 'root', tag: 'section', children: ['content'] },
        { kind: 'element', id: 'content', tag: 'div', children: ['heading', 'lead'] },
        { kind: 'text', id: 'heading', tag: 'h1', text: 'Light for every room' },
        { kind: 'text', id: 'lead', tag: 'p', text: 'A small studio with a clear point of view.' }] }] }, { label: 'Make editable hero' });
    if (!definition.ok) throw new Error(definition.error?.message);
    const placement = await window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, definitionId: definition.results[0].definitionId }] }, { label: 'Place editable hero' });
    if (!placement.ok) throw new Error(placement.error?.message);
    const spacing = await window.builder.project.apply({ operations: [{ type: 'node.setStyle', owner: { kind: 'component', id: definition.results[0].definitionId }, nodeId: 'root', scope: 'base', property: 'paddingBlock', value: '160px' }] }, { label: 'Space editable hero' });
    if (!spacing.ok) throw new Error(spacing.error?.message);
    return definition.results[0].definitionId;
  }, initial.state.site.homePageId);
  assert.ok(made, 'the project has a managed component for design editing');
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await message().waitFor();
  await eventually(async () => assert.ok((await win.locator('.chat .suggestions').count()) > 0, 'a page offers starters'));

  step('the hero is edited everywhere, at its overview');
  if (!(await win.locator('[role="tree"]').first().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
  await win.locator('[role="tree"] .list-item', { hasText: 'Split hero' }).first().click();
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
  const compSection = win.locator('.section-head', { hasText: 'Component' });
  if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
  await win.getByRole('button', { name: 'Edit everywhere…' }).click();
  await win.getByRole('dialog').getByRole('button', { name: /Edit (everywhere|design)/ }).click();
  await win.locator('.mode-band').waitFor();
  // Entering selects the whole design; Escape steps back to its overview, with nothing selected.
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await win.locator('.ov-selected').count(), 0, 'the overview has nothing selected'));
  await win.locator('.mode-band').waitFor();

  const before = await snapshot();
  const def = Object.values(before.state.components).find((d) => d.owner === 'project' && d.name === 'Split hero');
  assert.ok(def, 'the managed hero is editable everywhere');
  const owner = { kind: 'component', id: def.id };
  const home = before.state.pages[before.state.site.homePageId];
  const homeBefore = JSON.stringify(home);

  step('the composer is about the component, not the page behind it');
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await message().waitFor();
  await eventually(async () => assert.match(await chips().locator('.chip.def').innerText(), /\bSplit hero\b/));
  assert.doesNotMatch(await chips().innerText(), /Home|Whole site/, 'no page chip and no whole-site choice');
  assert.equal(await win.locator('.chat .suggestions').count(), 0, 'no page starters while a component is edited');
  const [chipColor, plum] = await chips()
    .locator('.chip.def')
    .evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--plum)';
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).color, want];
    });
  assert.equal(chipColor, plum, 'the component chip is plum, as the editing band is');
  await chips().screenshot({ path: join(SHOTS, 'ai-edit-everywhere-chips.png') });

  step('asking for an editable tagline adds a property and binds a new element to it, and nothing else');
  const seen = [];
  let insertedId;
  server.script(
    (req) => {
      seen.push(req);
      // Something outside the component first: the logo strip on the page behind it, through a tool it is not offered.
      return envelopeReply('apply_operations', { expectedRevision: before.revision, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: home.id }, nodeId: home.rootIds[1], prop: 'heading', value: 'Changed' }] });
    },
    (req) => {
      seen.push(req);
      return envelopeReply('manage_component_prop', { change: { action: 'add', prop: 'tagline', label: 'Tagline', type: 'string', default: 'Made by hand' } });
    },
    (req) => {
      seen.push(req);
      return envelopeReply('insert_definition_node', { parentId: 'content', primitive: 'paragraph', text: 'Made by hand', index: 2 });
    },
    (req) => {
      seen.push(req);
      // The new element's ID comes back in the result of the insert, the latest tool result.
      insertedId = [...lastResult(req).matchAll(/nodeId\\*"\s*:\s*\\*"(n_[a-z0-9]{4,32})/g)].at(-1)?.[1];
      assert.ok(insertedId, `the insert returned the new element's ID: ${lastResult(req).slice(0, 400)}`);
      return envelopeReply('bind_definition_field', { nodeId: insertedId, field: 'text', binding: { $prop: 'tagline' } });
    },
    envelopeReply('finish', { message: 'Added an editable tagline under the heading.' })
  );
  await message().fill('Add an editable tagline under the heading');
  await message().press('Enter');
  await log().getByText('Added an editable tagline under the heading.').waitFor({ timeout: 30000 });
  assert.match(await log().locator('.msg-user .ctx').last().innerText(), /Split hero everywhere/, 'the message names the component it was about');

  const ctx = editorContext(seen[0]);
  assert.equal(ctx.editingComponent?.id, def.id, 'the model is told which component is edited everywhere');
  assert.deepEqual(ctx.editingComponent.rootIds, def.tree.rootIds);
  assert.equal(ctx.selection, null);
  assert.match(ctx.allowedScope, /^only the Split hero component's own design/, 'and that the request is limited to it');
  assert.match(lastResult(seen[1]), /Unknown tool[^a-z]*apply_operations/, 'the write to the page behind it was refused');
  const grammar = JSON.stringify(seen[0].body.response_format ?? seen[0].body.tools ?? {});
  for (const tool of ['manage_component_prop', 'bind_definition_field', 'insert_definition_node', 'exposeAsPart', 'style_definition_element']) assert.ok(grammar.includes(tool), `${tool} is offered without Developer mode`);
  assert.ok(!grammar.includes('apply_operations'), 'the small model is not offered the general operations');
  assert.ok(!grammar.includes('component.createCode'), 'code stays behind Developer mode');
  // The binding is offered the property the request added, and the element it inserted.
  assert.ok(JSON.stringify(seen[3].body.response_format).includes(`"${insertedId}"`), 'the next step can name the new element');

  const after = await snapshot();
  const design = after.state.components[def.id];
  assert.equal(design.properties.tagline?.label, 'Tagline', 'the component has a Tagline property');
  assert.deepEqual(design.tree.nodes[insertedId]?.text, { $prop: 'tagline' }, 'the new element shows the tagline');
  assert.equal(JSON.stringify(after.state.pages[after.state.site.homePageId]), homeBefore, 'the page behind the component did not change');

  step('an element of the design narrows the next message to it, or the whole component');
  // A click in the page picks the design's own node under the pointer.
  // The scaled frame can place Playwright's physical click over the sticky header; dispatch at the visible heading.
  await frame.locator(`[data-so-ctx$="|${home.rootIds[0]}"] h1`).first().dispatchEvent('click');
  await eventually(async () => assert.equal(await win.locator('[role="tree"] [data-node="heading"]').getAttribute('aria-selected'), 'true', 'the heading of the design is selected'));
  await eventually(async () => assert.match(await chips().innerText(), /^Heading\b/));
  // Its menu offers the element or the whole component, and never the whole site.
  await chips().locator('.scope-chip').click();
  assert.deepEqual(await win.getByRole('menuitemradio').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Only Heading 1, in Split hero everywhere it is used', 'All of Split hero, everywhere it is used']);
  await win.keyboard.press('Escape');
  const ask = async (text) => {
    let req;
    server.script(
      (r) => {
        req = r;
        return envelopeReply('finish', { message: `Noted: ${text}` });
      }
    );
    await message().fill(text);
    await message().press('Enter');
    await log().getByText(`Noted: ${text}`).waitFor({ timeout: 30000 });
    return editorContext(req);
  };
  const narrowed = await ask('Make the heading shorter');
  assert.deepEqual(narrowed.selection && { owner: narrowed.selection.owner, nodeId: narrowed.selection.nodeId, label: narrowed.selection.label }, { owner, nodeId: 'heading', label: 'Heading 1' });
  assert.match(narrowed.allowedScope, /^only Heading/);
  assert.match(await log().locator('.msg-user .ctx').last().innerText(), /Split hero everywhere → Heading/);
  await chips().locator('.scope-chip').click();
  await win.getByRole('menuitemradio', { name: 'All of Split hero, everywhere it is used' }).click();
  await eventually(async () => assert.match(await chips().locator('.scope-chip').getAttribute('aria-label'), /: Split hero · everywhere$/));
  const whole = await ask('Tighten the spacing');
  assert.equal(whole.selection, null);
  assert.equal(whole.editingComponent?.id, def.id);
  assert.match(whole.allowedScope, /^only the Split hero component's own design/);

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
