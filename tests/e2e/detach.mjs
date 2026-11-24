// Detaching a component placement into its own elements, against the real app (#373): Detach component is offered
// in the Inspector, Canvas and Layers menus for a component placed on a page, and the elements that replace it look
// the same at phone, tablet and desktop widths: its chosen tone, its repeated plan cards with their badge and their
// own styles, a dark call to action's button colours, and a section's slot content. The component library gains
// nothing, and one Undo brings the placement back as it was.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('detach');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Detach Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const menu = win.getByRole('menu');
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const width = async (name, px) => {
  await win.locator('.toolbar').getByRole('button', { name, exact: true }).click();
  await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => window.innerWidth), px, `the preview is ${px}px wide`));
};

/**
 * Everything a visitor sees of one region, element by element in document order: its tag, its own words, where it
 * links, its box, and the computed styles a detached copy has to keep, the theme's surface colours included.
 */
const probe = (anchor) =>
  frame.locator(`#${anchor}`).evaluate((root) => {
    const PROPS = ['display', 'color', 'background-color', 'background-image', 'grid-template-columns', 'flex-direction', 'gap', 'padding-top', 'padding-left', 'margin-top', 'font-size', 'font-weight', 'line-height', 'text-align', 'border-top-width', 'border-top-color', 'border-top-left-radius', 'opacity', 'outline-color', '--so-surface-ink', '--so-btn-bg', '--so-btn-fg'];
    return [root, ...root.querySelectorAll('*')].map((el) => {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const words = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' ');
      return [el.tagName, words, el.getAttribute('href') ?? '', Math.round(box.width), Math.round(box.height), ...PROPS.map((p) => cs.getPropertyValue(p).trim())].join(' | ');
    });
  });
const SIZES = [
  ['Phone', 390],
  ['Tablet', 834],
  ['Desktop', 1280]
];
const probeAll = async (anchors) => {
  const out = {};
  for (const [name, px] of SIZES) {
    await width(name, px);
    for (const a of anchors) out[`${a}@${name}`] = await probe(a);
  }
  return out;
};

step('a section holding Pricing, and a dark call to action, styled per placement');
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, componentId: 'layout.section' }], 'Insert section');
const [{ nodeId: pricing }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', componentId: 'pricing.plans', variants: { tone: 'inverse' } }], 'Insert pricing');
const [{ nodeId: cta }] = await apply([{ type: 'node.insert', owner, componentId: 'cta.banner', variants: { tone: 'inverse' } }], 'Insert call to action');
// A new placement's items get IDs of their own.
const plans = (await snapshot()).pages[pageId].nodes[pricing].props.plans;
await apply(
  [
    { type: 'node.setContent', owner, nodeId: section, field: 'anchor', value: 'area' },
    { type: 'node.setContent', owner, nodeId: pricing, field: 'anchor', value: 'plans' },
    { type: 'node.setContent', owner, nodeId: cta, field: 'anchor', value: 'cta' },
    { type: 'instance.setProp', owner, nodeId: cta, prop: 'secondaryLabel', value: 'Our process' },
    { type: 'node.setStyle', owner, nodeId: pricing, partId: 'heading', scope: 'base', property: 'color', value: '#ffcc00' },
    { type: 'node.setStyle', owner, nodeId: pricing, partId: 'grid', scope: 'tablet', property: 'columns', value: 2 },
    { type: 'node.setStyle', owner, nodeId: pricing, partId: 'plan', itemId: plans[1].id, scope: 'base', property: 'background', value: '#e8f0ff' },
    { type: 'node.setStyle', owner, nodeId: pricing, partId: 'plan', itemId: plans[2].id, scope: 'phone', property: 'hidden', value: true }
  ],
  'Style the placements'
);
/** The colour the theme gives buttons drawn on the dark call to action's panel, through its class hooks. */
const panelInk = () => frame.locator('#cta [class*="cta-banner__panel"]').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--so-surface-ink').trim());
const before = await probeAll(['area', 'plans', 'cta']);
const inkBefore = await panelInk();
assert.notEqual(inkBefore, '', 'the dark panel sets the colour drawn on it');
assert.ok(before['plans@Phone'].length > 20, 'the probe reads the whole pricing section');
const libraryBefore = Object.keys((await snapshot()).components).sort();

step('Detach component is offered in the Inspector, Canvas and Layers menus for the placement');
await openRail('Layers');
const row = (name) => win.locator('.list-item', { hasText: name }).first();
// Pricing sits in the section's slot: its row shows once the section's branch is open.
const expand = async (name) => {
  if ((await row(name).getAttribute('aria-expanded')) === 'false') await row(name).locator('.tree-toggle').click();
};
await expand('Section');
await row('Pricing').click();
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Pricing' }).waitFor();
await win.locator('#dock-panel-inspect').getByRole('button', { name: /^More actions for / }).click();
await menu.getByRole('menuitem', { name: /Detach component/ }).waitFor();
await win.keyboard.press('Escape');
await win.locator('.ov-chip').getByRole('button', { name: 'More actions' }).click();
await menu.getByRole('menuitem', { name: /Detach component/ }).waitFor();
await win.keyboard.press('Escape');
await row('Pricing').click({ button: 'right' });
await menu.getByRole('menuitem', { name: /Detach component/ }).waitFor();
await win.keyboard.press('Escape');

step('detaching Pricing from Layers puts its elements in the section’s slot and selects them');
await row('Pricing').click({ button: 'right' });
await menu.getByRole('menuitem', { name: /Detach component/ }).click();
await eventually(async () => {
  const st = await snapshot();
  assert.equal(st.pages[pageId].nodes[pricing], undefined, 'the placement is gone');
  const slotted = st.pages[pageId].nodes[section].slots.content;
  assert.equal(slotted.length, 1, 'one element in the slot, where the placement was');
  assert.equal(st.pages[pageId].nodes[slotted[0]].kind, 'element');
});
const detachedRoot = (await snapshot()).pages[pageId].nodes[section].slots.content[0];
await eventually(async () => assert.equal(await win.evaluate(() => document.querySelector('#dock-panel-inspect .insp-name h3')?.textContent), 'Pricing', 'what replaced it is selected'));
assert.deepEqual(Object.keys((await snapshot()).components).sort(), libraryBefore, 'no component was added or removed');

step('the Canvas menu detaches the call to action, and the section (with its slot content) from the Inspector');
await row('Call to action').click();
await win.locator('.ov-chip').getByRole('button', { name: 'More actions' }).click();
await menu.getByRole('menuitem', { name: /Detach component/ }).click();
await eventually(async () => assert.equal((await snapshot()).pages[pageId].nodes[cta], undefined, 'the call to action is detached'));
await row('Section').click();
await win.locator('#dock-panel-inspect').getByRole('button', { name: /^More actions for / }).click();
await menu.getByRole('menuitem', { name: /Detach component/ }).click();
await eventually(async () => {
  const st = await snapshot();
  assert.equal(st.pages[pageId].nodes[section], undefined, 'the section is detached');
  assert.ok(Object.values(st.pages[pageId].nodes).every((n) => n.kind !== 'instance'), 'the page holds no placements now');
  assert.ok(st.pages[pageId].nodes[detachedRoot], 'the detached pricing moved with the slot, under its own ID');
});
await win.screenshot({ path: join(SHOTS, 'detach-after.png') });

step('the detached elements look the same at every width');
const after = await probeAll(['area', 'plans', 'cta']);
for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], `${key} renders as it did`);
assert.equal(await panelInk(), inkBefore, 'the detached panel still takes the theme’s colours for a dark ground');
assert.deepEqual(Object.keys((await snapshot()).components).sort(), libraryBefore, 'the library is unchanged');

step('Undo brings back each placement as it was');
const pageBefore = async () => (await snapshot()).pages[pageId];
for (let i = 0; i < 3; i++) await win.evaluate(() => window.builder.project.undo());
await eventually(async () => {
  const page = await pageBefore();
  assert.equal(page.nodes[section]?.kind, 'instance', 'the section is a placement again');
  assert.equal(page.nodes[pricing]?.kind, 'instance', 'Pricing is a placement again');
  assert.equal(page.nodes[cta]?.kind, 'instance', 'the call to action is a placement again');
  assert.deepEqual(page.nodes[section].slots.content, [pricing], 'Pricing is back in the section’s slot');
  assert.equal(page.nodes[pricing].itemOverrides.plan.items[plans[1].id].base.background, '#e8f0ff', 'with its own card styles');
});
const undone = await probeAll(['area', 'plans', 'cta']);
for (const key of Object.keys(before)) assert.deepEqual(undone[key], before[key], `${key} renders as it did before detaching`);

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ndetach: all checks passed');
