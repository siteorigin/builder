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
const lost = () => win.locator('.toast', { hasText: 'was not saved' });

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
const typed = 'Rooms planned around how you live';
await heading().click();
await heading().press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
await win.keyboard.insertText(typed);
assert.equal(await heading().evaluate((el) => el === document.activeElement), true, 'the Heading field still has focus');
assert.notEqual(props(home.hero).heading, typed, 'nothing is saved while typing');

step('click another section on the canvas: the hero keeps what was typed, the section clicked keeps its own');
await frame.locator(`[data-so-ctx="page:${home.pageId}|${home.other}"]`).first().getByRole('heading', { name: savedOther, exact: true }).click();
await eventually(async () => assert.notEqual(await heading().inputValue().catch(() => null), typed, 'the Inspector shows the section clicked'));
await eventually(() => assert.equal(props(home.hero).heading, typed, 'the hero’s heading is saved'));
assert.equal(props(home.other).heading, savedOther, 'the section clicked keeps its heading');
assert.equal(await lost().count(), 0, 'no notice says the text was lost');
await win.screenshot({ path: join(SHOTS, 'inspector-canvas-pick.png') });

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ninspector-canvas-pick: passed');
