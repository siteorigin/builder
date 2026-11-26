// The canvas's own Add buttons (#387), against the real app. The + below Home's first section, reached by the pointer
// from the section itself, adds a Gallery between Home's first two sections; the + inside a selected Row, opened and
// searched from the keyboard, adds a Button inside that Row. Each is one change that one Undo takes away. Escape puts
// the list away and hands focus back to its button, Backspace in its search changes nothing on the page, Tab and
// Shift+Tab put it away and move on from its button, a search with no match offers Clear search and Insert (which
// opens on the same search), a press outside only puts it away, and Preview shows no Add buttons at all.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('canvas-insert');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Gallery opening', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const undo = () => win.evaluate(() => window.builder.project.undo());
/** The changes History holds that are applied, newest last. */
const applied = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).map((e) => ({ id: e.id, label: e.label })));
const addButton = (side, nodeId) => win.locator(`[data-testid="canvas-add"][data-side="${side}"][data-node="${nodeId}"]`);
const allAdds = win.locator('[data-testid="canvas-add"]');
const list = win.locator('[data-testid="quick-insert"]');
const search = list.getByRole('combobox');
const chip = async () => (await win.locator('.ov-chip .label').allInnerTexts()).join(' ');

/**
 * A point of an element in the page, in the window, brought into the canvas's view first. The preview is scaled to
 * fit, which Playwright's own boxes for elements in the frame leave out, so the point is the frame's box on screen
 * plus the element's place in the page, scaled.
 */
const pointIn = async (locator, fx, fy) => {
  const view = await win.locator('.canvas-scroll').boundingBox();
  const place = async () => {
    const f = await win.locator('.frame-box iframe').boundingBox();
    const r = await locator.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, vw: window.innerWidth };
    });
    const k = f.width / r.vw;
    return { x: f.x + (r.x + r.width * fx) * k, y: f.y + (r.y + r.height * fy) * k };
  };
  let at = await place();
  if (at.y < view.y + 20 || at.y > view.y + view.height - 20) {
    await win.locator('.canvas-scroll').evaluate((el, dy) => el.scrollBy(0, dy), at.y - (view.y + view.height / 2));
    await win.waitForTimeout(150);
    at = await place();
  }
  return at;
};
/** Select what the chip calls `name` by clicking an element in the page: each click steps one level in. */
const selectIn = async (locator, name) => {
  for (let i = 0; i < 5; i++) {
    const at = await pointIn(locator, 0.5, 0.5);
    await win.mouse.click(at.x, at.y);
    try {
      return await eventually(async () => assert.match(await chip(), name), 1500);
    } catch {
      await win.waitForTimeout(400);
    }
  }
  assert.fail(`${name} is selected; the chip says ${await chip()}`);
};

step('Home: two sections, the first holding a Row with a Paragraph');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).pages[pageId];
const [{ nodeId: first }, { nodeId: second }] = await apply(
  [
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ],
  'Insert sections'
);
const [{ nodeId: row }] = await apply([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'row' }], 'Insert row');
await apply(
  [
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Doors open at seven' },
    { type: 'node.insert', owner, parentId: second, slot: 'content', primitive: 'heading', text: 'See you there' },
    { type: 'node.setContent', owner, nodeId: first, field: 'anchor', value: 'first' }
  ],
  'Fill sections'
);
await frame.locator('p', { hasText: 'Doors open at seven' }).first().waitFor();
await frame.locator('#first').waitFor();

step('the pointer on the first section shows a + on its bottom edge, which stays as the pointer moves onto it');
await win.keyboard.press('Escape');
const over = await pointIn(frame.locator('#first'), 0.85, 0.75);
await win.mouse.move(over.x, over.y);
const below = addButton('after', first);
await below.waitFor({ timeout: 10000 });
assert.equal(await below.getAttribute('aria-label'), 'Add a section below Section');
await below.hover();
await win.waitForTimeout(300);
assert.equal(await below.isVisible(), true, 'the hovered section keeps its + while the pointer rests on it');
await win.screenshot({ path: join(SHOTS, 'canvas-insert-edge.png') });

step('its list offers sections; Gallery chosen from search lands between Home’s first two sections, in one change');
const rootsBefore = (await home()).rootIds;
assert.deepEqual(rootsBefore, [first, second]);
const historyBefore = await applied();
await below.click();
await list.waitFor();
await eventually(async () => assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'the cursor is in search'));
assert.equal(await list.getByRole('option', { name: /^Gallery/ }).count() >= 1, true, 'Gallery is offered');
assert.equal(await list.getByRole('option', { name: /^Paragraph/ }).count(), 0, 'basic elements are not offered between sections');
await search.fill('gallery');
await eventually(async () => assert.match(await list.getByRole('option').first().innerText(), /^Gallery/));
await win.screenshot({ path: join(SHOTS, 'canvas-insert-sections.png') });
await search.press('Enter');
await list.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await home()).rootIds.length, 3, 'a section is added'));
const roots = (await home()).rootIds;
assert.deepEqual([roots[0], roots[2]], [first, second], 'between the first two sections');
const gallery = (await home()).nodes[roots[1]];
assert.equal(gallery.kind, 'instance', 'the new section is a placed section');
const historyAfter = await applied();
assert.equal(historyAfter.length, historyBefore.length + 1, 'one change');
assert.equal(historyAfter.at(-1).label, 'Insert Gallery on Home');
await eventually(async () => assert.equal(JSON.parse((await win.locator('.canvas').getAttribute('data-selected-ref')) ?? 'null')?.nodeId, roots[1], 'the new section is selected'));
await undo();
await eventually(async () => assert.deepEqual((await home()).rootIds, rootsBefore, 'one Undo takes it away'));
assert.deepEqual((await applied()).at(-1), historyBefore.at(-1), 'and History is as it was');

step('a selected Row shows a + inside it; from the keyboard its list finds Button, which lands in the Row');
await selectIn(frame.locator('p', { hasText: 'Doors open at seven' }).first(), /^Row/);
const inside = addButton('inside', row);
await inside.waitFor({ timeout: 10000 });
assert.equal(await inside.getAttribute('aria-label'), 'Add inside Row');
const rowBefore = (await home()).nodes[row].children;
const before2 = await applied();
await inside.focus();
await win.keyboard.press('Enter');
await list.waitFor();
await eventually(async () => assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'the cursor is in search'));
assert.equal(await list.getByRole('option', { name: /^Gallery/ }).count(), 0, 'sections are not offered inside a Row');
await win.keyboard.type('butt');
await eventually(async () => assert.match(await list.getByRole('option').first().innerText(), /^Button/));
assert.equal(await list.getByRole('option').first().getAttribute('aria-selected'), 'true', 'the first result is highlighted');
await win.screenshot({ path: join(SHOTS, 'canvas-insert-elements.png') });
await win.keyboard.press('Enter');
await list.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await home()).nodes[row].children.length, rowBefore.length + 1, 'an element is added to the Row'));
const rowAfter = (await home()).nodes[row].children;
assert.deepEqual(rowAfter.slice(0, -1), rowBefore, 'at the end of the Row');
const button = (await home()).nodes[rowAfter.at(-1)];
assert.equal(button.kind, 'link', 'a Button');
assert.deepEqual((await home()).rootIds, rootsBefore, 'the page’s sections are as they were');
assert.equal((await applied()).length, before2.length + 1, 'one change');
assert.equal((await applied()).at(-1).label, 'Insert Button on Home');
await undo();
await eventually(async () => assert.deepEqual((await home()).nodes[row].children, rowBefore, 'one Undo takes it away'));

step('Escape puts the list away and hands focus back to its +; Backspace in search changes nothing on the page');
await selectIn(frame.locator('p', { hasText: 'Doors open at seven' }).first(), /^Row/);
await inside.waitFor();
const selectedBefore = await win.locator('.canvas').getAttribute('data-selected-ref');
await inside.focus();
await win.keyboard.press('Enter');
await list.waitFor();
// A press on the list's own heading leaves the cursor in search, so its keys still work.
await list.locator('.qi-title').click();
assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'the cursor stays in search');
await win.keyboard.type('x');
await win.keyboard.press('Backspace');
await win.keyboard.press('Backspace');
assert.equal(await search.inputValue(), '');
await win.keyboard.press('Escape');
await list.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await inside.evaluate((el) => el === document.activeElement), true, 'focus is back on the +'));
assert.equal(await win.locator('.canvas').getAttribute('data-selected-ref'), selectedBefore, 'the Row is still selected');
assert.deepEqual((await home()).nodes[row].children, rowBefore, 'nothing was removed or added');

step('Tab puts the list away and moves on from its +, as from any other control; Shift+Tab moves back from it');
/** What the + hands focus to on `key` with no list open: where the same key should land from an open list. */
const focusedHtml = () => win.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? null);
for (const key of ['Tab', 'Shift+Tab']) {
  await inside.focus();
  await win.keyboard.press(key);
  const expected = await focusedHtml();
  await inside.focus();
  await win.keyboard.press('Enter');
  await list.waitFor();
  await win.keyboard.press(key);
  await list.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await focusedHtml(), expected, `${key} lands where it would from the +`));
}
assert.deepEqual((await home()).nodes[row].children, rowBefore, 'and adds nothing');

step('a search that matches nothing says so, and Open Insert takes the search with it');
await inside.click();
await list.waitFor();
await search.fill('zzqx');
await list.locator('.qi-empty strong', { hasText: 'No matches for “zzqx”' }).waitFor();
await eventually(async () => assert.equal(await list.getByRole('status').innerText(), 'No matches for “zzqx”', 'and the status region says so'));
assert.equal(await list.getByRole('option').count(), 0, 'no options');
assert.equal(await search.getAttribute('aria-expanded'), 'false', 'and the search says its list is closed');
await list.locator('.qi-empty').getByRole('button', { name: 'Clear search' }).click();
assert.equal(await search.inputValue(), '', 'Clear search empties it');
assert.ok((await list.getByRole('option').count()) > 0, 'and everything is listed again');
await search.fill('zzqx');
await list.locator('.qi-empty').getByRole('button', { name: 'Open Insert' }).click();
await list.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await win.locator('.side-panel-view:not([hidden]) .insert-search input').inputValue(), 'zzqx', 'Insert opens searching for it'));
await win.locator('.side-panel-view:not([hidden]) .insert-search input').fill('');
assert.match(await chip(), /^Row/, 'the Row is still selected');
await inside.waitFor();

step('a press outside only puts the list away');
await inside.click();
await list.waitFor();
const veilAt = await win.locator('.canvas-scroll').boundingBox();
await win.mouse.click(veilAt.x + 8, veilAt.y + veilAt.height - 8);
await list.waitFor({ state: 'detached' });
assert.equal(await win.locator('.canvas').getAttribute('data-selected-ref'), selectedBefore, 'the press selected nothing else');
assert.deepEqual((await home()).nodes[row].children, rowBefore, 'and added nothing');

step('Preview shows no Add buttons');
await inside.waitFor();
await win.locator('.toolbar').getByRole('button', { name: 'Preview', exact: true }).click();
await frame.locator('html:not([data-so-editing])').waitFor({ state: 'attached' });
const hoverAt = await pointIn(frame.locator('#first'), 0.85, 0.75);
await win.mouse.move(hoverAt.x, hoverAt.y);
await win.waitForTimeout(400);
assert.equal(await allAdds.count(), 0, 'no + in Preview');
assert.equal(await list.count(), 0, 'and no list');
await win.locator('.toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached' });

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ncanvas-insert: all checks passed');
