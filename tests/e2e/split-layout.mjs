// Foundation's Split layout (#669), against the real app: inserted from Insert, it shows an empty drop target for
// Primary and for Secondary on the canvas and lists both in Layers. A Paragraph dragged onto Secondary goes there,
// and with Primary picked in Layers, Insert puts a Statistics section and a Heading in it. The Inspector's
// Proportions choice resizes the columns on desktop and tablet, a phone stacks them with Primary first, a pinned
// Secondary stays in view while a taller Primary scrolls past, and the exported source is plain Svelte and CSS with
// both columns' content and nothing of the editor's.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, openInspector, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('split-layout');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Split Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };
const home = async () => (await snapshot()).pages[pageId];
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const panel = win.locator('.side-panel-view:not([hidden])');
const tree = win.locator('.layers-tree');
const marker = (slot) => frame.locator(`[data-so-slot-empty="${slot}"]`);
const column = (which) => frame.locator(`.split__${which}`);
const viewport = (name) => win.locator('.toolbar').getByRole('radio', { name, exact: true }).click();
const showPanel = async (name) => {
  const rail = win.locator(`.rail [aria-label="${name}"]`);
  if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
};
/** An element's box in the page's own pixels. */
const box = (locator) =>
  locator.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom };
  });

step('Split layout, found in Insert, goes onto the page');
await viewport('Desktop');
await showPanel('Insert');
await panel.getByLabel('Search items to add').fill('split layout');
await panel.getByRole('option').filter({ hasText: 'Split layout' }).first().click();
let split;
await eventually(async () => {
  const page = await home();
  split = Object.values(page.nodes).find((n) => n.kind === 'instance' && n.definitionId === 'foundation.layout.split')?.id;
  assert.ok(split, 'a Split layout is on the page');
}, 20000);
await panel.getByLabel('Search items to add').fill('');
const slots = async () => (await home()).nodes[split].slots ?? {};
const kinds = async (slot) => {
  const page = await home();
  return ((await slots())[slot] ?? []).map((id) => page.nodes[id].definitionId ?? page.nodes[id].tag);
};

step('both slots show an empty drop target on the canvas, side by side');
await marker('primary').waitFor({ timeout: 30000 });
await marker('secondary').waitFor();
{
  const [a, b] = [await box(marker('primary')), await box(marker('secondary'))];
  assert.ok(a.height >= 72 && b.height >= 72, `each is tall enough to drop on: ${a.height}, ${b.height}`);
  assert.ok(b.x > a.x + a.width, 'Secondary is to the right of Primary');
}
await win.screenshot({ path: join(SHOTS, 'split-empty.png') });

step('on the Dark tone the empty targets keep a light ground and dark lettering of their own');
await apply([{ type: 'instance.setVariant', owner, nodeId: split, axis: 'tone', variant: 'inverse' }], 'Dark');
await eventually(async () => {
  assert.equal(await marker('primary').evaluate((el) => getComputedStyle(el.closest('section')).backgroundColor !== 'rgb(248, 250, 252)'), true);
  for (const slot of ['primary', 'secondary'])
    assert.deepEqual(await marker(slot).evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]), ['rgb(248, 250, 252)', 'rgb(71, 85, 105)']);
});
await win.screenshot({ path: join(SHOTS, 'split-empty-dark.png') });
await apply([{ type: 'instance.setVariant', owner, nodeId: split, axis: 'tone', variant: 'default' }], 'Default tone');

step('Layers lists Primary then Secondary, both empty');
await showPanel('Layers');
await tree.waitFor();
const row = tree.locator(`[data-node="${split}"]`);
await row.waitFor();
if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('.tree-toggle').click();
const slotRow = (slot) => tree.locator(`[data-placement="${split}"][data-slot="${slot}"]`);
await eventually(async () =>
  assert.deepEqual(
    await tree.locator(`[data-placement="${split}"][data-slot]`).evaluateAll((rows) => rows.map((r) => [r.dataset.slot, r.getAttribute('aria-label')])),
    [
      ['primary', 'Primary, slot of Split layout, empty'],
      ['secondary', 'Secondary, slot of Split layout, empty']
    ]
  )
);

step('a Paragraph dragged from Insert drops into Secondary, which stays on the right while Primary is empty');
await showPanel('Insert');
{
  const tile = panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: /^Paragraph$/ }) });
  await tile.scrollIntoViewIfNeeded();
  const t = await tile.boundingBox();
  await win.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await win.mouse.down();
  await win.mouse.move(t.x + t.width / 2 + 12, t.y + t.height / 2 + 4, { steps: 3 });
  const f = await win.locator('.frame-box iframe').boundingBox();
  const k = f.width / (await frame.locator('html').evaluate(() => window.innerWidth));
  const m = await box(marker('secondary'));
  await win.mouse.move(f.x + (m.x + m.width / 2) * k, f.y + (m.y + 30) * k, { steps: 12 });
  await eventually(async () => assert.match(await win.locator('[data-testid="insert-drop-label"]').innerText(), /Paragraph inside Secondary in Split layout/));
  await win.mouse.up();
}
await eventually(async () => assert.deepEqual(await kinds('secondary'), ['p']));
assert.deepEqual(await kinds('primary'), []);
await eventually(async () => assert.equal(await marker('secondary').count(), 0));
{
  const [a, b] = [await box(column('primary')), await box(column('secondary'))];
  assert.ok(b.x > a.x + a.width - 1, 'Secondary keeps the right-hand column');
}

step('with Primary picked in Layers, Insert puts a Statistics section and then a Heading in it');
for (const [name, search] of [
  ['Statistics', 'statistics'],
  ['Heading', null]
]) {
  await showPanel('Layers');
  await slotRow('primary').click();
  await eventually(async () => assert.equal(await slotRow('primary').getAttribute('aria-selected'), 'true'));
  await showPanel('Insert');
  await eventually(async () => assert.match(await panel.locator('.insert-where').innerText(), /inside Primary in Split layout/));
  const before = (await kinds('primary')).length;
  if (search) {
    await panel.getByLabel('Search items to add').fill(search);
    await panel.getByRole('option').filter({ hasText: name }).first().click();
    await panel.getByLabel('Search items to add').fill('');
  } else await panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
  await eventually(async () => assert.equal((await kinds('primary')).length, before + 1, `${name} is in Primary`), 20000);
}
assert.deepEqual(await kinds('primary'), ['foundation.stats.row', 'h2'], 'the Statistics section, then the Heading');
assert.deepEqual(await kinds('secondary'), ['p'], 'Secondary is untouched');

step('the Inspector’s Proportions choice resizes the columns on desktop and tablet');
await showPanel('Layers');
await tree.locator(`[data-node="${split}"]`).click();
await openInspector(win);
const proportions = win.locator('#dock-panel-inspect').getByLabel('Proportions', { exact: true });
const widths = async () => {
  const [a, b] = [await box(column('primary').first()), await box(column('secondary').first())];
  return { a, b, ratio: a.width / b.width };
};
for (const [value, label, expected] of [
  ['wide-left', 'Wide left (2:1)', 2],
  ['wide-right', 'Wide right (1:2)', 0.5],
  ['equal', 'Equal (1:1)', 1]
]) {
  await proportions.selectOption({ label });
  await eventually(async () => assert.equal((await home()).nodes[split].variants?.ratio ?? 'equal', value));
  for (const size of ['Desktop', 'Tablet']) {
    await viewport(size);
    await eventually(async () => {
      const w = await widths();
      assert.ok(Math.abs(w.ratio - expected) < 0.08, `${label} on ${size}: ${w.a.width} to ${w.b.width}`);
      assert.ok(w.b.x > w.a.x, 'side by side');
    }, 20000);
  }
}
await viewport('Desktop');
await proportions.selectOption({ label: 'Wide left (2:1)' });
await eventually(async () => assert.ok(Math.abs((await widths()).ratio - 2) < 0.08));
await win.screenshot({ path: join(SHOTS, 'split-filled-desktop.png') });

step('on a phone the columns stack, Primary first, each the full width');
await viewport('Phone');
await eventually(async () => {
  const w = await widths();
  assert.ok(w.b.y >= w.a.bottom - 1, `Secondary is below Primary: ${w.a.bottom}, ${w.b.y}`);
  assert.ok(Math.abs(w.ratio - 1) < 0.01, 'the same width');
}, 20000);
await win.screenshot({ path: join(SHOTS, 'split-filled-phone.png') });

step('a pinned Secondary stays in view while a taller Primary scrolls past');
await viewport('Desktop');
await apply(
  Array.from({ length: 30 }, (_, i) => ({ type: 'node.insert', owner, parentId: split, slot: 'primary', primitive: 'paragraph', text: `Entry ${i + 1}. A longer note about the season in the garden.` })),
  'Fill Primary'
);
await openInspector(win);
await showPanel('Layers');
await tree.locator(`[data-node="${split}"]`).click();
await win.locator('#dock-panel-inspect').getByLabel('Secondary column', { exact: true }).selectOption({ label: 'Stays in view (sticky)' });
await eventually(async () => assert.equal(await column('secondary').first().evaluate((el) => getComputedStyle(el).position), 'sticky'), 20000);
await eventually(async () => {
  const pinned = await column('secondary')
    .first()
    .evaluate(async (el) => {
      // Measured from the columns' own box, which never moves as Secondary does: the same place on every retry.
      const start = el.parentElement.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: start + 300, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { top: el.getBoundingClientRect().top, offset: parseFloat(getComputedStyle(el).top), columns: el.parentElement.getBoundingClientRect().top };
    });
  assert.ok(pinned.columns < 0, `the page scrolled past the columns’ top: ${pinned.columns}`);
  assert.ok(Math.abs(pinned.top - pinned.offset) < 2, `held at ${pinned.offset}px, not scrolled away: ${pinned.top}`);
}, 20000);

step('the exported source is plain Svelte and CSS, with both columns’ content and nothing of the editor’s');
const exportsDir = join(WORK, 'exports');
mkdirSync(exportsDir, { recursive: true });
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
const exported = await withTimeout(win.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
assert.equal(exported.ok, true, `source export succeeds: ${exported.message}`);
const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
const sources = files(join(exported.path, 'src')).filter((f) => /\.(svelte|js|ts|css|html)$/.test(f));
for (const f of sources) assert.doesNotMatch(readFileSync(f, 'utf8'), /data-so-(slot|editor|node|ctx)|so-slot-empty|bridge\.client|\.siteorigin\/|so_editing/, f);
const component = readFileSync(sources.find((f) => f.endsWith('-layout-split.svelte')), 'utf8');
assert.match(component, /<section[\s\S]*split__primary[\s\S]*slot_primary\?\.\(\)[\s\S]*split__secondary[\s\S]*slot_secondary\?\.\(\)/);
const route = readFileSync(join(exported.path, 'src', 'routes', '+page.svelte'), 'utf8');
const snippet = (slot) => route.match(new RegExp(`\\{#snippet slot_${slot}\\(\\)\\}([\\s\\S]*?)\\{/snippet\\}`))?.[1] ?? '';
assert.match(snippet('secondary'), /Write something here\./, 'Secondary’s Paragraph is exported in Secondary');
assert.doesNotMatch(snippet('secondary'), /Entry 30\./);
assert.match(route, /variant_ratio="wide-left"/);
assert.match(route, /variant_sticky="pin-secondary"/);
assert.match(route, /Entry 30\./);
assert.match(component, /grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/, 'the code component exports its responsive columns');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nsplit-layout: all checks passed');
