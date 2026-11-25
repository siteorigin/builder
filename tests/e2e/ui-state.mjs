// Component UI state (#377), against the real app. An author builds two tabs on a project component in Component
// Studio from the Inspector alone: a Billing choice, a button for each option, and a panel shown for each. The
// studio's toolbar previews Annual, so the hidden panel is on the canvas to pick and style, without saving anything;
// then every change is undone. Then a local model (Developer mode off, a constrained-JSON server in this process,
// scripted reply by reply, so nothing reaches a real provider) builds working tabs in one upsert_managed_component
// call, which work in the visitor preview and are undone in one step.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, MOD, scratch, step } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';

const { WORK, SHOTS, cleanup } = scratch('ui-state');
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
  const frame = await createProject(win, { name: 'Tab House', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

  const snapshot = () => win.evaluate(async () => window.builder.project.snapshot());
  const apply = (operations, label) =>
    win.evaluate(async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    }, [operations, label]);
  const inspector = win.locator('#dock-panel-inspect');
  const band = win.locator('.mode-band');
  const openRail = async (name) => {
    if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
  };
  const expand = async (title) => {
    const head = inspector.locator('.section-head', { hasText: title }).first();
    await head.waitFor();
    if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  };

  step('a project component with two buttons and two panels, and no UI state yet');
  const none = { type: 'none', target: '' };
  const [made] = await apply(
    [
      {
        type: 'component.upsert',
        name: 'Billing tabs',
        properties: {},
        nodes: [
          { kind: 'element', id: 'root', tag: 'section', children: ['tabs', 'monthly', 'annual'] },
          { kind: 'element', id: 'tabs', name: 'Tabs', children: ['monthlyTab', 'annualTab'] },
          { kind: 'link', id: 'monthlyTab', name: 'Monthly button', link: none, label: 'Monthly', appearance: 'secondary' },
          { kind: 'link', id: 'annualTab', name: 'Annual button', link: none, label: 'Annual', appearance: 'secondary' },
          { kind: 'element', id: 'monthly', name: 'Monthly panel', children: ['monthlyText'] },
          { kind: 'text', id: 'monthlyText', name: 'Monthly price', text: '$12 a month' },
          { kind: 'element', id: 'annual', name: 'Annual panel', children: ['annualText'] },
          { kind: 'text', id: 'annualText', name: 'Annual price', text: '$120 a year' }
        ]
      }
    ],
    'Make Billing tabs'
  );
  const defId = made.definitionId;
  const baseline = await snapshot();
  const design = async () => (await snapshot()).state.components[defId];
  const inStudio = (sel) => frame.locator(`[data-so-ctx="preview:${defId}|preview"]${sel}`);

  step('it opens in Component Studio');
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type('Billing tabs studio');
  await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
  await band.filter({ hasText: 'Billing tabs in Component Studio' }).waitFor();
  await inStudio('[data-so-node="root"]').first().waitFor({ timeout: 60000 });
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  assert.equal(await band.locator('[data-studio-state]').count(), 0, 'no UI state to preview yet');
  await openRail('Layers');
  const row = (nodeId) => win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="${nodeId}"]`);
  /** Select a node of the design: by its Layers row when the tree shows it, else by a click on it in the preview, which reveals its row. */
  const selectRow = async (nodeId) => {
    if (await row(nodeId).isVisible()) await row(nodeId).click();
    else await inStudio(` [data-so-node="${nodeId}"]`).first().dispatchEvent('click');
    await eventually(async () => assert.equal(await row(nodeId).getAttribute('aria-selected'), 'true', `the ${nodeId} row is selected`), 15000);
  };

  step('the Inspector declares a Billing choice on the whole component');
  await selectRow('root');
  await expand('UI state');
  await inspector.getByLabel('Name of the state').fill('Billing');
  assert.equal(await inspector.getByLabel('Kind of state').inputValue(), 'enum', 'a choice is the first kind offered');
  await inspector.getByLabel('Its options, separated by commas').fill('Monthly, Annual');
  await inspector.getByRole('button', { name: 'Add state' }).click();
  await eventually(async () =>
    assert.deepEqual((await design()).state, { billing: { type: 'enum', label: 'Billing', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }], initial: 'monthly' } })
  );
  await band.locator('[data-studio-state="billing"]').waitFor();

  step('each button switches Billing to its option');
  for (const [nodeId, label, value] of [
    ['monthlyTab', 'Switch Billing to Monthly', 'monthly'],
    ['annualTab', 'Switch Billing to Annual', 'annual']
  ]) {
    await selectRow(nodeId);
    await expand('When clicked');
    await inspector.getByLabel('Also changes').selectOption({ label });
    await eventually(async () => assert.deepEqual((await design()).tree.nodes[nodeId].stateAction, { state: 'billing', op: 'set', value }, `${nodeId} sets billing`));
  }

  step('each panel shows only for its option');
  for (const [nodeId, value] of [
    ['monthly', 'monthly'],
    ['annual', 'annual']
  ]) {
    await selectRow(nodeId);
    await expand('Conditions');
    await inspector.getByLabel('Show when…', { exact: true }).selectOption('state:billing');
    await inspector.getByLabel('Show when test').selectOption('eq');
    // Comparing starts from where the state starts: Monthly.
    await eventually(async () => assert.equal((await design()).tree.nodes[nodeId].when?.eq, 'monthly'));
    if (value !== 'monthly') await inspector.getByLabel('Show when value').selectOption(value);
    await eventually(async () => assert.deepEqual((await design()).tree.nodes[nodeId].when, { ref: { $state: 'billing' }, eq: value }, `${nodeId} shows for ${value}`));
  }
  const shown = (nodeId) => inStudio(` [data-so-node="${nodeId}"]`).first().isVisible();
  await eventually(async () => {
    assert.equal(await shown('monthly'), true, 'Monthly shows, as visitors first see it');
    assert.equal(await shown('annual'), false, 'Annual is hidden');
  }, 30000);
  // The buttons and panels make an accessible tab list in the generated component.
  await eventually(async () => assert.equal(await inStudio(' [role="tablist"]').count(), 1, 'the buttons are a tab list'), 30000);

  step('the toolbar previews Annual, so its hidden panel can be picked and styled');
  const authored = await snapshot();
  await band.locator('[data-studio-state="billing"]').selectOption('annual');
  await eventually(async () => {
    assert.equal(await shown('annual'), true, 'Annual shows');
    assert.equal(await shown('monthly'), false, 'Monthly is hidden');
  }, 30000);
  assert.equal((await snapshot()).revision, authored.revision, 'previewing a value saves nothing');
  assert.equal((await design()).state.billing.initial, 'monthly', 'visitors still start on Monthly');
  await win.screenshot({ path: join(SHOTS, 'ui-state-studio-annual.png') });
  const annualText = inStudio(' [data-so-node="annualText"]').first();
  // Picked on the canvas, where it shows now.
  await annualText.dispatchEvent('click');
  await eventually(async () => assert.equal(await row('annualText').getAttribute('aria-selected'), 'true', 'a click in the preview picks the hidden panel’s text'), 15000);
  await expand('Style');
  await inspector.locator('.style-row[data-prop="textAlign"]').first().locator('select').selectOption('center');
  await eventually(async () => assert.equal((await design()).tree.nodes.annualText.styles?.base?.textAlign, 'center', 'the style is the design’s own'), 15000);
  await eventually(async () => assert.equal(await annualText.evaluate((el) => getComputedStyle(el).textAlign), 'center', 'the preview shows it'), 30000);
  assert.deepEqual((await snapshot()).state.pages, baseline.state.pages, 'no page changes');

  step('every change undoes cleanly, back to the component as it was');
  for (let i = 0; i < 20 && JSON.stringify(await design()) !== JSON.stringify(baseline.state.components[defId]); i++) {
    const at = (await snapshot()).revision;
    await win.locator('.canvas').focus();
    await win.keyboard.press(`${MOD}+z`);
    await eventually(async () => assert.notEqual((await snapshot()).revision, at, 'Undo takes a step back'), 15000);
  }
  assert.deepEqual(await design(), baseline.state.components[defId], 'the component is as it was before any of it');
  // The toolbar lets go of a state the design no longer has.
  await eventually(async () => assert.equal(await band.locator('[data-studio-state]').count(), 0, 'nothing left to preview'));
  await eventually(async () => assert.equal(await shown('annual'), true, 'with no condition, both panels show'), 30000);
  await win.locator('.mode-band-done').click();
  await band.waitFor({ state: 'detached' });

  step('a local model builds working tabs in one upsert_managed_component call, without Developer mode');
  const home = (await snapshot()).state.site.homePageId;
  const seen = [];
  const tabs = {
    name: 'Plan tabs',
    state: [{ type: 'enum', name: 'plan', label: 'Plan', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }] }],
    nodes: [
      { kind: 'element', id: 'root', tag: 'section', children: ['tabs', 'monthly', 'annual'] },
      { kind: 'element', id: 'tabs', children: ['monthlyTab', 'annualTab'] },
      { kind: 'link', id: 'monthlyTab', link: '', label: 'Monthly', appearance: 'secondary', stateAction: { op: 'set', state: 'plan', value: 'monthly' } },
      { kind: 'link', id: 'annualTab', link: '', label: 'Annual', appearance: 'secondary', stateAction: { op: 'set', state: 'plan', value: 'annual' } },
      { kind: 'element', id: 'monthly', children: ['monthlyText'], when: { ref: { $state: 'plan' }, eq: 'monthly' } },
      { kind: 'text', id: 'monthlyText', text: 'Billed every month' },
      { kind: 'element', id: 'annual', children: ['annualText'], when: { ref: { $state: 'plan' }, eq: 'annual' } },
      { kind: 'text', id: 'annualText', text: 'Billed once a year' }
    ],
    placeOnPage: { pageId: '/' }
  };
  server.script(
    (req) => {
      seen.push(req);
      return envelopeReply('upsert_managed_component', tabs);
    },
    (req) => {
      seen.push(req);
      return envelopeReply('finish', { message: 'Made Plan tabs and put it on the home page.' });
    }
  );
  const before = await snapshot();
  // Create component → Build with AI: a request about the whole site, marked as a new component.
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type('Create component');
  await win.locator('.cmdk [role="option"]', { hasText: 'Create component…' }).first().click();
  const dialog = win.getByRole('dialog');
  await dialog.getByLabel('Component name').fill('Plan tabs');
  await dialog.getByLabel('Description').fill('Monthly and Annual tabs, each showing its price.');
  await dialog.getByRole('button', { name: 'Build with AI' }).click();
  await dialog.waitFor({ state: 'detached' });
  await win.locator('.chat-log').getByText('Made Plan tabs and put it on the home page.').waitFor({ timeout: 30000 });
  assert.equal(seen.length, 2, 'one call built it, then the run finished');
  const grammar = JSON.stringify(seen[0].body.response_format ?? seen[0].body.tools ?? {});
  assert.ok(grammar.includes('upsert_managed_component'), 'the component tool is offered');
  assert.ok(grammar.includes('stateAction') && grammar.includes('$state'), 'with its UI state fields in the grammar');
  assert.ok(!grammar.includes('component.createCode'), 'code stays behind Developer mode');
  assert.match(JSON.stringify(seen[1].body.messages.at(-1)), /\\"ok\\":true/, 'the one call applied');
  const after = await snapshot();
  const built = Object.values(after.state.components).find((d) => d.owner === 'project' && d.name === 'Plan tabs');
  assert.ok(built, 'the component was made');
  assert.equal(built.state.plan.initial, 'monthly');
  const placement = after.state.pages[home].rootIds.map((id) => after.state.pages[home].nodes[id]).find((n) => n.kind === 'instance' && n.definitionId === built.id);
  assert.ok(placement, 'and placed on the home page');

  step('the tabs work in the visitor preview');
  await win.locator('.toolbar').getByRole('button', { name: 'Preview', exact: true }).click();
  const placed = (sel) => frame.locator(`[data-so-ctx$="|${placement.id}"] ${sel}`).first();
  await eventually(async () => assert.equal(await frame.locator('html').getAttribute('data-so-bridge'), 'preview', 'the page is previewed as visitors see it'), 30000);
  const annualTab = frame.getByRole('tab', { name: 'Annual' });
  await annualTab.waitFor({ timeout: 30000 });
  assert.equal(await annualTab.getAttribute('aria-selected'), 'false');
  assert.equal(await placed('[data-so-node="annual"]').isVisible(), false, 'Annual starts hidden');
  await annualTab.dispatchEvent('click');
  await eventually(async () => {
    assert.equal(await annualTab.getAttribute('aria-selected'), 'true', 'the Annual tab is chosen');
    assert.equal(await placed('[data-so-node="annual"]').isVisible(), true, 'its panel shows');
    assert.equal(await placed('[data-so-node="monthly"]').isVisible(), false, 'and the other is hidden');
  });
  await win.screenshot({ path: join(SHOTS, 'ui-state-ai-preview.png') });
  await win.locator('.toolbar').getByRole('button', { name: 'Edit', exact: true }).click();

  step('one Undo takes back the component and its placement');
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+z`);
  await eventually(async () => {
    const back = await snapshot();
    assert.equal(back.state.components[built.id], undefined, 'the component is gone');
    assert.deepEqual(back.state.pages[home].rootIds, before.state.pages[home].rootIds, 'and so is its placement');
  }, 15000);

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
  passed = true;
} finally {
  await app?.close().catch(() => {});
  await server.stop();
  if (passed) cleanup();
}
console.log('\nui-state: passed');
