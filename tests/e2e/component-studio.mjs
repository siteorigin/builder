// Component Studio (#367), against the real app: a project component that no page places opens from Insert > Your
// components in the canvas, shown on its own by the editor's isolated preview. Its variant options, sample content
// and width change what the preview shows without changing the project; a click picks the design's own part, whose
// style is edited there (with Undo and Redo); Done goes back to the page; and the Command menu opens it again.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, MOD, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('component-studio');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Studio Hall', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => window.builder.project.snapshot());
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const panel = win.locator('.side-panel-view:not([hidden])');
const band = win.locator('.mode-band');
const iframe = win.locator('.frame-box iframe');
const framePath = async () => new URL((await iframe.getAttribute('src')) ?? 'about:blank').pathname;
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
/**
 * Click an element of the preview where it is on screen. The canvas scales the frame to fit, which Playwright's own
 * coordinates inside a frame do not follow: the point is worked out from the frame's box and the element's own.
 */
const clickInFrame = async (el) => {
  const outer = await iframe.boundingBox();
  const inner = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, vw: node.ownerDocument.defaultView.innerWidth };
  });
  const z = outer.width / inner.vw;
  await win.mouse.click(outer.x + (inner.x + Math.min(20, inner.width / 2)) * z, outer.y + (inner.y + inner.height / 2) * z);
};
const defKey = (id) => id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

step('a project component that no page places');
const pageId = (await snapshot()).state.site.homePageId;
const owner = { kind: 'page', id: pageId };
await apply([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'features.grid' }], 'Insert a grid');
const placed = (await snapshot()).state.pages[pageId].rootIds[0];
const themeDef = (await snapshot()).state.pages[pageId].nodes[placed].definitionId;
const [fork] = await apply([{ type: 'component.fork', definitionId: themeDef }], 'Make a project copy');
const defId = fork.definitionId;
await apply([{ type: 'node.remove', owner, nodeId: placed }], 'Remove its placement');
const baseline = await snapshot();
const def = baseline.state.components[defId];
assert.equal(def.owner, 'project', 'the copy is the project’s own');
const placements = Object.values(baseline.state.pages).flatMap((p) => Object.values(p.nodes)).filter((n) => n.kind === 'instance' && n.definitionId === defId);
assert.equal(placements.length, 0, 'no page places it');
const root = def.tree.rootIds[0];
const headingNode = def.parts.heading.nodeId;
const [axis, axisDef] = Object.entries(def.variantAxes).find(([id]) => id === 'layout') ?? Object.entries(def.variantAxes)[0];
const option = Object.keys(axisDef.options).find((o) => o !== axisDef.default);
assert.ok(option, 'the component has a second option to try');
const inStudio = (sel) => frame.locator(`[data-so-ctx="preview:${defId}|preview"]${sel}`);

step('it opens in Component Studio from Insert → Your components');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await panel.locator('.insert-group[data-kind="component"]').waitFor();
await panel.getByRole('button', { name: `Manage ${def.name}`, exact: true }).click();
await win.getByRole('menu').getByRole('menuitem', { name: /Open in Component Studio/ }).click();
await band.filter({ hasText: `${def.name} in Component Studio` }).waitFor();
await inStudio(`[data-so-node="${root}"]`).first().waitFor({ timeout: 60000 });
assert.match(await framePath(), /^\/__siteorigin\/component\/[a-z0-9]+\/$/, 'the canvas shows the isolated preview');
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
const startingText = await frame.locator('body').innerText();

step('variant options and sample content change only the preview');
await band.locator(`[data-studio-axis="${axis}"]`).selectOption(option);
await frame.locator(`.so-${defKey(defId)}--${axis}-${option}`).first().waitFor({ timeout: 30000 });
const sample = band.locator('[data-studio-sample]');
await sample.selectOption('long');
await eventually(async () => assert.match(await frame.locator('body').innerText(), /longer sample line/, 'long copy shows'), 30000);
await sample.selectOption('empty');
await eventually(async () => {
  const text = await frame.locator('body').innerText();
  assert.doesNotMatch(text, /longer sample line/, 'long copy is gone');
  assert.equal(await inStudio(`[data-so-node="${root}"]`).count(), 1, 'the component is still shown');
}, 30000);
await sample.selectOption('defaults');
await eventually(async () => assert.equal(await frame.locator('body').innerText(), startingText, 'the starting content is back'), 30000);
const untouched = await snapshot();
assert.equal(untouched.revision, baseline.revision, 'trying looks and content saves nothing');
assert.deepEqual(untouched.state.components[defId], def, 'the design and its starting content are unchanged');
assert.deepEqual(untouched.state.pages, baseline.state.pages, 'no page changes');

step('phone and desktop widths, with the same preview');
await frame.locator(`.so-${defKey(defId)}--${axis}-${option}`).first().waitFor({ timeout: 30000 });
const shownAt = await framePath();
const innerWidth = () => frame.locator('html').evaluate((el) => el.ownerDocument.defaultView.innerWidth);
await win.getByRole('button', { name: 'Phone', exact: true }).click();
await eventually(async () => assert.equal(await innerWidth(), 390, 'phone width'));
await win.getByRole('button', { name: 'Desktop', exact: true }).click();
await eventually(async () => assert.equal(await innerWidth(), 1280, 'desktop width'));
assert.equal(await framePath(), shownAt, 'a width is not a new preview');

await win.screenshot({ path: join(SHOTS, 'component-studio-desktop.png') });

step('a click picks the design’s own part, and its style is edited there');
await openRail('Layers');
const headingRow = win.locator(`[role="treeitem"][data-owner="component:${defId}"][data-node="${headingNode}"]`);
const heading = inStudio(`[data-so-node="${headingNode}"]`).first();
const selectedHeading = headingRow.and(win.locator('[aria-selected="true"]'));
// The preview can still be settling: a click the canvas missed is clicked again.
await eventually(async () => {
  if ((await selectedHeading.count()) !== 1) await clickInFrame(heading);
  await eventually(async () => assert.equal(await selectedHeading.count(), 1, 'Layers selects the picked part'), 3000);
}, 30000);
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'the part is outlined in the preview'));
await win.locator('#dock-panel-inspect .insp-scope.definition').first().waitFor();
const alignOf = () => inStudio(`[data-so-node="${headingNode}"]`).first().evaluate((el) => getComputedStyle(el).textAlign);
const before = await alignOf();
assert.notEqual(before, 'center', 'the heading starts uncentred');
const styleHead = win.locator('#dock-panel-inspect .section-head', { hasText: /^Style/ }).first();
if ((await styleHead.getAttribute('aria-expanded')) === 'false') await styleHead.click();
await win.locator('#dock-panel-inspect .style-row[data-prop="textAlign"]').first().locator('select').selectOption('center');
const headingStyles = async () => JSON.stringify((await snapshot()).state.components[defId].tree.nodes[headingNode].styles ?? {});
await eventually(async () => assert.match(await headingStyles(), /"textAlign":"center"/, 'the style is the design’s own'), 15000);
await eventually(async () => assert.notEqual(await alignOf(), before, 'the preview shows the new style'), 30000);
// The part stays selected in the new preview, and nothing but the design changed.
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'the part is still outlined'), 15000);
assert.equal(await selectedHeading.count(), 1, 'and still selected');
assert.deepEqual((await snapshot()).state.pages, baseline.state.pages, 'no page changes');

step('Undo and Redo the style from the editor');
await win.locator('.canvas').focus();
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.doesNotMatch(await headingStyles(), /"textAlign":"center"/, 'Undo takes the style back'), 15000);
await eventually(async () => assert.equal(await alignOf(), before, 'and the preview follows'), 30000);
await win.locator('.canvas').focus();
await win.keyboard.press(`${MOD}+Shift+z`);
await eventually(async () => assert.match(await headingStyles(), /"textAlign":"center"/, 'Redo brings it back'), 15000);
await eventually(async () => assert.notEqual(await alignOf(), before, 'and the preview follows'), 30000);

step('Done editing goes back to the page');
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await framePath(), '/', 'the canvas shows the home page again'), 30000);
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
assert.equal(await frame.locator(`[data-so-ctx^="preview:"]`).count(), 0, 'no preview is left on the page');

step('the Command menu opens it again');
await win.locator('.canvas').focus();
await win.keyboard.press(`${MOD}+K`);
await win.locator('.cmdk').waitFor();
await win.keyboard.type(`${def.name} studio`);
await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
await band.filter({ hasText: `${def.name} in Component Studio` }).waitFor();
await inStudio(`[data-so-node="${root}"]`).first().waitFor({ timeout: 60000 });
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncomponent-studio: passed');
