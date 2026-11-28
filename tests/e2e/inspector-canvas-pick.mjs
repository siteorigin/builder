// Text typed in the Inspector is saved when the next click selects another section on the canvas (#896). A click on
// the page takes no focus, so the field is still focused as the selection changes: its text is saved for the Split
// hero it was typed for, the section clicked keeps its own, and no notice says the text was lost.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('inspector-canvas-pick');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Copper Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const dir = join(WORK, 'sites', 'copper-lane-studio');

const pageDoc = (id) => JSON.parse(readFileSync(join(dir, `siteorigin/pages/${id}.json`), 'utf8'));
const inspector = () => win.locator('#dock-panel-inspect');
const heading = () => inspector().getByRole('textbox', { name: 'Heading', exact: true });
const lost = () => win.locator('.toast', { hasText: 'not saved' });
/** The element the editor has selected, as the canvas says it. */
const selected = async () => JSON.parse((await win.locator('.canvas').getAttribute('data-selected-ref')) ?? 'null');
/** The section a selection is in: the placement itself, or the placement it is part of. */
const sectionOf = (ref) => (ref ? (ref.instancePath[0] ?? ref.nodeId) : null);

const home = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const named = (name) => page.rootIds.find((id) => page.nodes[id].kind === 'instance' && s.state.components[page.nodes[id].definitionId]?.name === name);
  const hero = named('Split hero');
  return { pageId: page.id, hero, other: named('Services grid') };
});
assert.ok(home.hero && home.other, 'Business Home has a Split hero and a Services grid');
const props = (id) => pageDoc(home.pageId).nodes[id].props;
const savedOther = props(home.other).heading;

step('select the Split hero and type in its Heading without pressing Enter');
await openInspector(win);
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await heading().waitFor();
assert.equal(sectionOf(await selected()), home.hero, 'the Split hero is selected');
const typed = 'Rooms planned around how you live';
await heading().click();
await heading().press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
await win.keyboard.insertText(typed);
assert.equal(await heading().evaluate((el) => el === document.activeElement), true, 'the Heading field still has focus');
assert.equal(await heading().inputValue(), typed);
assert.notEqual(props(home.hero).heading, typed, 'nothing is saved while typing');

step('click another section on the canvas: the hero keeps what was typed, the section clicked keeps its own');
await frame.locator(`[data-so-ctx="page:${home.pageId}"][data-so-node="${home.other}"]`).first().getByRole('heading', { name: savedOther, exact: true }).click();
await eventually(async () => assert.equal(sectionOf(await selected()), home.other, 'the click selects in the Services grid'));
await eventually(() => assert.equal(props(home.hero).heading, typed, 'the hero’s heading is saved'));
await eventually(async () => assert.equal(await win.locator('.toolbar .save-state').innerText(), 'Saved'));
const after = pageDoc(home.pageId).nodes;
assert.equal(after[home.hero].props.heading, typed, 'the hero keeps what was typed');
assert.equal(after[home.other].props.heading, savedOther, 'the section clicked keeps its heading');
assert.equal(await lost().count(), 0, 'no notice says the text was lost');
await win.screenshot({ path: join(SHOTS, 'inspector-canvas-pick.png') });

/** Where focus rests once the Inspector has drawn the selection, and whether anything there shows a focus ring. */
const focusAfterPick = async () => {
  await new Promise((r) => setTimeout(r, 400));
  return win.evaluate(() => ({ body: document.activeElement === document.body, ring: !!document.querySelector('#dock-panel-inspect :focus-visible') }));
};
step('a click on the page with an Inspector field focused leaves no focus ring in the Inspector (#1476)');
assert.deepEqual(await focusAfterPick(), { body: true, ring: false }, 'focus rests on the body, so the name of the selection is not ringed');

step('nor does one made after a click on the status bar took focus away from an Inspector field (#1476)');
await heading().focus();
await heading().press('End');
await win.locator('.status-bar').click({ position: { x: 4, y: 4 } });
await frame.locator(`[data-so-ctx="page:${home.pageId}"][data-so-node="${home.hero}"]`).first().getByRole('heading', { name: typed, exact: true }).click();
await eventually(async () => assert.equal(sectionOf(await selected()), home.hero, 'the click selects in the Split hero'));
assert.deepEqual(await focusAfterPick(), { body: true, ring: false }, 'focus rests on the body after the second pick too');

step('selecting the hero and its heading with the Inspector open leaves the editor in its window (#897)');
await openInspector(win);
/** The editor document's own scroll position, and how far it reaches past the window. */
const docScroll = () => win.evaluate(() => ({ x: scrollX, y: scrollY, top: document.scrollingElement.scrollTop, over: document.documentElement.scrollHeight - innerHeight }));
const still = { x: 0, y: 0, top: 0, over: 0 };
const pageHeading = frame.locator('h1').first();
const chips = win.locator('.ov-chip .label');
const chip = async () => ((await chips.count()) ? chips.first().innerText() : null);
/** Once the selection is what `expected` says, and the page has settled, the editor has not moved. */
const settled = async (what, expected) => {
  await eventually(async () => expected(await chip()), 10000);
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(await docScroll(), still, `the editor stays put after ${what}`);
};
await win.keyboard.press('Escape');
await settled('Escape to nothing', (c) => assert.equal(c, null));
await pageHeading.click();
let hero;
await settled('picking the hero', (c) => assert.ok((hero = c), 'the hero is selected'));
for (let i = 0; i < 3 && !/heading/i.test((await chip()) ?? ''); i++) await pageHeading.click();
await settled('picking its heading', (c) => assert.ok(c && c !== hero && /heading/i.test(c), `its heading is selected, not ${c}`));
await win.keyboard.press('Escape');
await settled('Escape to the hero', (c) => assert.equal(c, hero));
await win.keyboard.press('Escape');
await settled('Escape to nothing', (c) => assert.equal(c, null));
// A layer far down the page, picked in Layers: the preview scrolls to it, and the editor around it does not.
const layers = win.locator('[role="tree"] [role="treeitem"]');
if (!(await layers.last().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
await layers.last().click();
await eventually(async () => assert.ok((await frame.locator('html').evaluate(() => scrollY)) > 0, 'the preview scrolled to the layer'), 10000);
await settled('picking a layer far down the page', (c) => assert.ok(c, 'the layer is selected'));
await win.keyboard.press('Escape');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ninspector-canvas-pick: passed');
