// Empty containers on the canvas (#511): a Grid inserted from the Insert panel has nothing in it, yet shows a framed
// box naming it with its three columns while editing. Let go and clicked once in its middle column, it is selected
// (not the Section around it), and a Paragraph inserted then lands inside it. Preview shows it as visitors get it:
// no height, no frame, and the empty Section's placeholder gone from the page. Nothing of either reaches the
// project's own files or a source export.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('empty-layout');
const { app, win, errors } = await launch(WORK);
const name = 'Empty Frames Studio';
const frame = await createProject(win, { name, parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
const projectDir = (await win.evaluate(() => window.builder.projects.recents())).find((r) => r.name === name).dir;

const home = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    return { page, components: Object.fromEntries(Object.entries(s.state.components).map(([id, d]) => [id, d.componentId])) };
  });
/** The chip on the canvas names what is selected ("Grid actions"); none shows with nothing selected. */
const chip = () => win.locator('.ov-chip:not(.editing)');
const selected = async () => ((await chip().count()) ? await chip().first().getAttribute('aria-label') : null);
const panel = win.locator('.side-panel-view:not([hidden])');
const insertBasic = async (label) => {
  if ((await panel.locator('.insert-tile.basic').count()) === 0) await win.locator('.rail [aria-label="Insert"]').click();
  await panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${label}$`) }) }).click();
};
const at = (id) => frame.locator(`[data-so-node="${id}"]`).first();
/** How the canvas lays out and frames the element with `id`. */
const boxOf = (id) =>
  at(id).evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    label: getComputedStyle(el, '::before').content,
    outline: getComputedStyle(el).outlineStyle,
    rule: getComputedStyle(el).columnRuleStyle,
    tracks: getComputedStyle(el).gridTemplateColumns.split(' ').length,
    framed: el.getAttribute('data-so-empty-layout')
  }));
/**
 * A plain click on the middle of the element with `id`, through the page's own pointer as the author clicks: the
 * canvas is zoomed out, so the point inside the frame is scaled to the window.
 */
const clickMiddle = async (id) => {
  const at2 = await at(id).evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: innerWidth };
  });
  const box = await win.locator('.frame-box iframe').boundingBox();
  const scale = box.width / at2.width;
  await win.mouse.click(box.x + at2.x * scale, box.y + at2.y * scale);
};
const slotPlaceholders = () => frame.locator('[data-so-slot-empty], [data-so-editor-only]').count();
const EDITOR_ONLY = /data-so-empty-layout|so_editing|so-slot-empty|data-so-editor-only/;

try {
  step('insert a Grid from the Insert panel: it goes into a new Section and shows as a framed, three-column box');
  await insertBasic('Grid');
  const { gridId, sectionId } = await eventually(async () => {
    const { page } = await home();
    const grid = Object.values(page.nodes).find((n) => n.kind === 'element' && n.styles?.base?.layout === 'grid');
    assert.ok(grid, 'the Grid is on the page');
    const section = Object.values(page.nodes).find((n) => n.kind === 'instance' && n.slots?.content?.includes(grid.id));
    assert.ok(section, 'it is in a Section');
    return { gridId: grid.id, sectionId: section.id };
  }, 30000);
  await eventually(async () => assert.match((await selected()) ?? '', /^Grid actions$/, 'the new Grid is selected'), 15000);
  await eventually(async () => {
    const b = await boxOf(gridId);
    assert.equal(b.framed, 'Grid');
    assert.ok(b.height >= 72, `the empty Grid is tall enough to see and pick: ${JSON.stringify(b)}`);
    assert.deepEqual([b.label, b.outline, b.rule, b.tracks], ['"Grid" / ""', 'dashed', 'dashed', 3], JSON.stringify(b));
  }, 30000);
  await win.screenshot({ path: join(OUT, 'empty-grid.png') });

  step('let go, then one plain click in its middle column selects the Grid, not the Section around it');
  await win.locator('.canvas').hover({ position: { x: 4, y: 4 } }).catch(() => undefined);
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await selected(), null, 'nothing is selected'));
  await clickMiddle(gridId);
  await eventually(async () => assert.equal(await selected(), 'Grid actions', 'the click selects the Grid'), 10000);
  assert.equal(await win.locator('.ov-selected').count() >= 1, true, 'the Grid is outlined');

  step('Preview shows the Grid as visitors get it: no height, no frame, and no placeholder anywhere');
  await win.locator('.toolbar').getByRole('button', { name: 'Preview', exact: true }).click();
  await frame.locator('html:not([data-so-editing])').waitFor({ state: 'attached' });
  await eventually(async () => {
    const b = await boxOf(gridId);
    assert.deepEqual([b.height, b.label, b.outline, b.rule], [0, 'none', 'none', 'none'], JSON.stringify(b));
    assert.equal(await at(gridId).evaluate((el) => el.matches(':empty')), true, 'the Grid holds nothing');
  });
  await win.locator('.toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached' });
  await eventually(async () => assert.ok((await boxOf(gridId)).height >= 72, 'back in Edit the frame shows again'));

  step('an empty Section shows its placeholder only while editing');
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await selected(), null));
  // With nothing selected, a section goes at the end of the page.
  await win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    await window.builder.project.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: s.state.site.homePageId }, parentId: null, componentId: 'layout.section' }] }, { label: 'Add an empty section' });
  });
  await eventually(async () => assert.equal(await slotPlaceholders(), 1, 'the empty Section shows where its content goes'), 30000);
  await win.locator('.toolbar').getByRole('button', { name: 'Preview', exact: true }).click();
  await eventually(async () => assert.equal(await slotPlaceholders(), 0, 'Preview has no placeholder in the page at all'));
  await win.locator('.toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
  await eventually(async () => assert.equal(await slotPlaceholders(), 1, 'Edit shows it again'));

  step('the project’s own files and a source export hold none of it');
  /** Every file under `root`, by its path from there, leaving out the folders a site keeps its tools and editor data in. */
  const files = (root, rel = '') =>
    readdirSync(join(root, rel)).flatMap((n) => {
      const r = rel ? `${rel}/${n}` : n;
      if (!rel && ['node_modules', '.siteorigin', '.svelte-kit', '.git', 'static'].includes(n)) return [];
      return statSync(join(root, r)).isDirectory() ? files(root, r) : [r];
    });
  const sourceOut = join(WORK, 'export-source');
  const src = await withTimeout(win.evaluate((dest) => window.builderTest.exportSource(dest), sourceOut), 120000, 'Source export');
  assert.equal(src.ok, true, `source export succeeds: ${src.message}`);
  for (const [root, what] of [[projectDir, 'the project folder'], [sourceOut, 'the source export']]) {
    const all = files(root).filter((f) => f.startsWith('src/'));
    assert.ok(all.some((f) => f.endsWith('+page.svelte')), `${what} has the page`);
    for (const f of all) assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), EDITOR_ONLY, `${what}: ${f}`);
  }

  step('with the Grid clicked, a Paragraph inserted from the panel lands inside it, and the frame gives way to it');
  await clickMiddle(gridId);
  await eventually(async () => assert.equal(await selected(), 'Grid actions'), 10000);
  await insertBasic('Paragraph');
  const paraId = await eventually(async () => {
    const { page } = await home();
    assert.equal(page.nodes[gridId].children.length, 1, 'the Grid holds the Paragraph');
    const child = page.nodes[page.nodes[gridId].children[0]];
    assert.equal(child.kind, 'text');
    assert.deepEqual(page.nodes[sectionId].slots.content, [gridId], 'the Section still holds only the Grid');
    return child.id;
  }, 30000);
  await eventually(async () => {
    assert.equal(await at(paraId).count(), 1, 'the Paragraph shows inside the Grid');
    assert.equal(await at(gridId).evaluate((el, id) => !!el.querySelector(`[data-so-node="${id}"]`), paraId), true);
    const b = await boxOf(gridId);
    assert.deepEqual([b.framed, b.label, b.outline], [null, 'none', 'none'], JSON.stringify(b));
  }, 30000);

  step('undone, the Grid is empty and framed again');
  await win.locator('.canvas').hover({ position: { x: 4, y: 4 } }).catch(() => undefined);
  await win.keyboard.press(`${MOD}+z`);
  await eventually(async () => assert.equal((await home()).page.nodes[gridId].children.length, 0, 'the Paragraph is gone'), 15000);
  await eventually(async () => {
    const b = await boxOf(gridId);
    assert.equal(b.framed, 'Grid');
    assert.ok(b.height >= 72, JSON.stringify(b));
  }, 30000);

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await app.close();
}
// Only once the app has closed: it writes to its folder until then. A failed run keeps it for inspection.
cleanup();
console.log('\nempty-layout: all checks passed');
