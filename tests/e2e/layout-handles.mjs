// Gap, max width and column handles on the canvas (#385): the Split hero's Actions gap dragged on the page snaps to a
// spacing style as it moves and is saved as one edit on release, taken back by one Undo; its Container's max width,
// dragged by one edge, moves both edges and snaps to Reading width, and Escape mid-drag puts it back; and a two-column
// layout's divider resizes its columns to 1fr 2fr for All sizes, which phones leave alone.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('layout-handles');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Layout Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
// The shipped hero is code; its marked parts have no canvas handles. Use a managed placement for handle editing.
await win.evaluate(async () => {
  const home = (await window.builder.project.snapshot()).state.site.homePageId;
  const link = { type: 'page', target: home };
  const made = await window.builder.project.apply({ operations: [{ type: 'component.upsert', name: 'Editable layout hero', properties: {},
    parts: { root: { nodeId: 'root', label: 'Section' }, container: { nodeId: 'container', label: 'Container', styleControls: ['maxWidth', 'gap'] },
      actions: { nodeId: 'actions', label: 'Actions', styleControls: ['gap'] } },
    nodes: [{ kind: 'element', id: 'root', tag: 'section', styles: { base: { paddingBlock: '96px' } }, children: ['container'] },
      { kind: 'element', id: 'container', tag: 'div', styles: { base: { marginInline: 'auto', layout: 'stack', gap: '24px' } }, children: ['heading', 'actions'] },
      { kind: 'text', id: 'heading', tag: 'h1', text: 'Editable layout hero' },
      { kind: 'element', id: 'actions', tag: 'div', styles: { base: { layout: 'row' } }, children: ['primary', 'secondary'] },
      { kind: 'link', id: 'primary', label: 'Start a project', link, appearance: 'primary' },
      { kind: 'link', id: 'secondary', label: 'See our work', link, appearance: 'secondary' }] }] }, { label: 'Make layout hero' });
  if (!made.ok) throw new Error(made.error?.message);
  const placed = await window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, definitionId: made.results[0].definitionId }] }, { label: 'Place layout hero' });
  if (!placed.ok) throw new Error(placed.error?.message);
  const base = await window.builder.project.apply({ operations: [
    { type: 'node.setStyle', owner: { kind: 'page', id: home }, nodeId: placed.results[0].nodeId, partId: 'actions', scope: 'base', property: 'gap', value: '12px' },
    { type: 'node.setStyle', owner: { kind: 'page', id: home }, nodeId: placed.results[0].nodeId, partId: 'container', scope: 'base', property: 'maxWidth', value: '960px' }
  ] }, { label: 'Start layout sizes' });
  if (!base.ok) throw new Error(base.error?.message);
});

const snap = () => win.evaluate(() => window.builder.project.snapshot());
const homeNodes = (s) => s.state.pages[s.state.site.homePageId].nodes;
const heroNode = (s) => {
  const page = s.state.pages[s.state.site.homePageId];
  return page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.name === 'Editable layout hero');
};
const applied = (s) => s.history.entries.filter((e) => e.applied).map((e) => e.id);
/** The snapshot once a save has landed: the project's state shows a change a moment before its history does. */
const landed = (after, check) =>
  eventually(async () => {
    const s = await snap();
    assert.ok(s.revision > after.revision, 'the save has landed');
    check(s);
    return s;
  }, 15000);
const previews = () => frame.locator('style[data-so-spacing]').count();
const hud = win.getByTestId('spacing-hud');
/** Screen pixels per page pixel: the frame is drawn scaled to fit the canvas. */
const zoom = async () => {
  const box = await win.locator('.frame-box iframe').boundingBox();
  const inner = await frame.locator('html').evaluate(() => innerWidth);
  return box.width / inner;
};
/** Press a handle and move it `by` page pixels across, in a few steps; the mouse stays down. */
async function dragBy(testId, by, steps = 6) {
  const b = await win.getByTestId(testId).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const to = x + by * (await zoom());
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move((x + to) / 2, y, { steps });
  await win.mouse.move(to, y, { steps });
}
const selectPart = async (section, part) => {
  const row = win.locator('.list-item', { hasText: section }).first();
  await row.click();
  const partRow = win.locator('[role="tree"] .list-item.layer-part', { hasText: part }).first();
  if (!(await partRow.isVisible())) await row.locator('.tree-toggle').click();
  await partRow.click();
  await eventually(async () => assert.match(await win.locator('.ov-chip').first().innerText(), new RegExp(part)));
};

const hero = frame.locator('section', { has: frame.locator('h1', { hasText: 'Editable layout hero' }) }).first();
const actions = hero.locator('a', { hasText: 'Start a project' }).locator('xpath=..');
const container = hero.locator(':scope > div').first();
const gapOf = (loc) => loc.evaluate((el) => Number.parseFloat(getComputedStyle(el).columnGap));
const rowGapOf = (loc) => loc.evaluate((el) => Number.parseFloat(getComputedStyle(el).rowGap));
/** Where a page box is on screen, in the window: the frame is drawn scaled to fit the canvas. */
const onScreen = async (loc) => {
  const r = await loc.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  });
  const f = await win.locator('.frame-box iframe').boundingBox();
  const z = await zoom();
  return { left: f.x + r.left * z, right: f.x + r.right * z, top: f.y + r.top * z, bottom: f.y + r.bottom * z };
};
const centre = async (testId) => {
  const b = await win.getByTestId(testId).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const edges = (loc) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  });

try {
  await win.locator('.rail [aria-label="Layers"]').click();

  step('select the editable hero’s Actions: a gap handle sits between its two buttons');
  await selectPart('Editable layout hero', 'Actions');
  const gapHandle = win.getByTestId('layout-gap-x-0');
  await gapHandle.waitFor();
  const before = await snap();
  const originalOverrides = heroNode(before).overrides ?? {};
  await eventually(async () => assert.equal(await gapOf(actions), 12, 'the buttons start a Small gap apart'), 30000);
  const startGap = await gapOf(actions);
  // The handle sits in the gap between the two buttons, level with them.
  const [first, second] = [await onScreen(actions.locator('a').first()), await onScreen(actions.locator('a').nth(1))];
  const g = await centre('layout-gap-x-0');
  assert.ok(g.x >= first.right - 1 && g.x <= second.left + 1 && g.y > first.top && g.y < first.bottom, `the gap handle is between the buttons: ${JSON.stringify([first, second, g])}`);

  step('drag the gap toward 25px: it snaps to Large (24px) as it moves, and nothing is saved yet');
  await dragBy('layout-gap-x-0', 25 - startGap);
  await eventually(async () => assert.match(await hud.innerText(), /Gap\s*Large · 24px/));
  await eventually(async () => assert.equal(await gapOf(actions), 24, 'the page shows the snapped gap while dragging'));
  // Gap sets both gaps: the space between wrapped lines of buttons shows the change too.
  assert.equal(await rowGapOf(actions), 24, 'and the row gap with it');
  const held = await snap();
  assert.equal(held.revision, before.revision, 'nothing is saved mid-drag');
  await win.screenshot({ path: join(OUT, 'gap-drag.png') });

  step('release: one edit saves the gap for all sizes, and one Undo takes it back');
  await win.mouse.up();
  const gapSaved = await landed(before, (s) => assert.deepEqual(heroNode(s).overrides?.actions?.base?.gap, { token: 'space.lg' }));
  assert.equal(applied(gapSaved).length, applied(before).length + 1, 'one history entry');
  assert.equal(gapSaved.history.undoLabel, 'Set gap for Actions in Editable layout hero on Home');
  await eventually(async () => assert.equal(await previews(), 0, 'the preview is handed over to the saved style'), 15000);
  assert.equal(await gapOf(actions), 24, 'the saved style shows on its own');
  await win.locator('[aria-label^="Undo"]').first().click();
  const gapUndone = await landed(gapSaved, (s) => assert.deepEqual(heroNode(s).overrides ?? {}, originalOverrides));
  await eventually(async () => assert.equal(await gapOf(actions), startGap), 15000);

  step('select the editable hero’s Container: max width handles on both its edges');
  await selectPart('Editable layout hero', 'Container');
  await win.getByTestId('layout-width-right').waitFor();
  assert.equal(await win.getByTestId('layout-width-left').count(), 1);
  const startBox = await edges(container);
  assert.ok(startBox.width > 800, `the container starts wide: ${JSON.stringify(startBox)}`);

  // Each handle sits on its edge of the box.
  const contBox = await onScreen(container);
  assert.ok(Math.abs((await centre('layout-width-left')).x - contBox.left) < 2 && Math.abs((await centre('layout-width-right')).x - contBox.right) < 2, 'the handles sit on the box\u2019s edges');

  step('Escape mid-drag puts the width back and saves nothing');
  // The left edge, dragged inward (to the right), narrows the box from both sides.
  await dragBy('layout-width-left', 100);
  await eventually(async () => assert.ok((await edges(container)).width < startBox.width - 150, 'the page shows the narrower box while dragging'));
  await win.keyboard.press('Escape');
  await eventually(async () => assert.deepEqual(await edges(container), startBox, 'the width is back where it was'));
  assert.equal(await previews(), 0, 'no preview is left on the page');
  await win.mouse.up();
  await win.waitForTimeout(500);
  assert.equal((await snap()).revision, gapUndone.revision, 'nothing is saved');

  step('drag the right edge in toward 720px: both edges move, and it snaps to Reading width');
  await dragBy('layout-width-right', -(startBox.width - 726) / 2);
  await eventually(async () => assert.match(await hud.innerText(), /Max width\s*Reading width · 720px/));
  await eventually(async () => {
    const b = await edges(container);
    assert.equal(b.width, 720, 'the page shows the snapped width');
    // Centred: each edge came in by half of what the box lost.
    assert.ok(Math.abs(b.left - startBox.left - (startBox.width - 720) / 2) <= 1, `both edges moved: ${JSON.stringify([startBox, b])}`);
  });
  await win.mouse.up();
  const widthSaved = await landed(gapUndone, (s) => assert.deepEqual(heroNode(s).overrides?.container?.base?.maxWidth, { token: 'container.reading' }));
  assert.equal(applied(widthSaved).length, applied(gapUndone).length + 1, 'one history entry');
  await eventually(async () => assert.equal(await previews(), 0), 15000);
  assert.equal((await edges(container)).width, 720);
  await win.screenshot({ path: join(OUT, 'width-drag.png') });

  step('a two-column layout: a divider handle between its columns');
  await win.locator('.rail [aria-label="Insert"]').click();
  const panel = win.locator('.side-panel-view:not([hidden])');
  await panel.locator('.insert-group[data-group="columns"]').waitFor();
  await panel.locator('.insert-group[data-group="columns"] .insert-tile', { has: win.locator('strong', { hasText: /^2 columns$/ }) }).click();
  const gridId = await eventually(async () => {
    const grid = Object.values(homeNodes(await snap())).find((n) => n.kind === 'element' && n.name === 'Columns');
    assert.ok(grid, 'the columns are on the page');
    return grid.id;
  }, 30000);
  const grid = frame.locator(`[data-so-node="${gridId}"]`).first();
  await win.locator('.rail [aria-label="Layers"]').click();
  await win.locator('[role="tree"] .list-item', { hasText: 'Columns' }).first().click();
  await eventually(async () => assert.match(await win.locator('.ov-chip').first().innerText(), /Columns/));
  const divider = win.getByTestId('layout-split-0');
  await divider.waitFor();
  const tracks = () => grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').map((v) => Number.parseFloat(v)));
  const [a, b] = await tracks();
  assert.ok(Math.abs(a - b) < 1, `the columns start equal: ${[a, b]}`);
  // On the gutter between the columns, near the grid's top.
  const [c1, c2] = [await onScreen(frame.locator(`[data-so-node="${gridId}"] > *`).first()), await onScreen(frame.locator(`[data-so-node="${gridId}"] > *`).nth(1))];
  const d0 = await centre('layout-split-0');
  assert.ok(d0.x > c1.right - 1 && d0.x < c2.left + 1 && d0.y >= c1.top && d0.y < (c1.top + c1.bottom) / 2, `the divider sits on the gutter: ${JSON.stringify([c1, c2, d0])}`);
  const beforeSplit = await snap();

  step('drag the divider a third of the way across: the columns preview at 1:2, and release saves 1fr 2fr');
  await dragBy('layout-split-0', -(a + b) / 6);
  await eventually(async () => assert.match(await hud.innerText(), /Column sizes\s*33% · 67%/));
  await eventually(async () => {
    const [l, r] = await tracks();
    assert.ok(Math.abs(r / l - 2) < 0.02, `the page shows 1:2 while dragging: ${[l, r]}`);
  });
  // The divider follows its gutter as the columns move, staying under the pointer.
  await eventually(async () => {
    const d = await divider.boundingBox();
    const g = await grid.evaluate((el) => {
      const s = getComputedStyle(el);
      return { left: el.getBoundingClientRect().left, first: Number.parseFloat(s.gridTemplateColumns), gap: Number.parseFloat(s.columnGap) };
    });
    const f = await win.locator('.frame-box iframe').boundingBox();
    const at = f.x + (g.left + g.first + g.gap / 2) * (await zoom());
    assert.ok(Math.abs(d.x + d.width / 2 - at) < 3, `the divider sits on the moved gutter: ${d.x + d.width / 2} vs ${at}`);
    assert.ok(Math.abs(d.y + d.height / 2 - d0.y) < 1, `and stays at the height it was pressed at: ${d.y + d.height / 2} vs ${d0.y}`);
  });
  assert.equal((await snap()).revision, beforeSplit.revision, 'nothing is saved mid-drag');
  await win.screenshot({ path: join(OUT, 'split-drag.png') });
  await win.mouse.up();
  const splitSaved = await landed(beforeSplit, (s) => assert.equal(homeNodes(s)[gridId].styles?.base?.gridTemplate, '1fr 2fr'));
  assert.equal(applied(splitSaved).length, applied(beforeSplit).length + 1, 'one history entry');
  assert.equal(splitSaved.history.undoLabel, 'Set column sizes for Columns on Home');
  await eventually(async () => assert.equal(await previews(), 0), 15000);
  const [l, r] = await tracks();
  assert.ok(Math.abs(r / l - 2) < 0.02, `the saved sizes show on their own: ${[l, r]}`);

  step('on a phone the columns stack as before, with no divider to drag');
  await win.getByRole('radio', { name: 'Phone', exact: true }).first().click();
  await eventually(async () => assert.equal((await tracks()).length, 1, 'one column on a phone'), 15000);
  assert.equal(await divider.count(), 0, 'no divider on a phone');

  step('one Undo takes the column sizes back');
  await win.locator('[aria-label^="Undo"]').first().click();
  await landed(splitSaved, (s) => assert.equal(homeNodes(s)[gridId].styles?.base?.gridTemplate, undefined));

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nlayout-handles: ok');
} finally {
  await app.close().catch(() => undefined);
  cleanup();
}
