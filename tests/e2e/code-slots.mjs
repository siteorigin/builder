// Code components with slots and marked parts (#379): content inserted into a code component's slot on the canvas,
// a part its code marks with data-so-part picked on the canvas and styled in the Inspector, content in the slot still
// picked on its own, and exports (the website and the source alike) that carry no marker while the editable project
// keeps them.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('code-slots');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Code Slots', parentDir: join(WORK, 's'), starter: 'blank', sampleImages: false });
const projectDir = join(WORK, 's', 'code-slots');

const SOURCE = `<script>
\tlet { title = 'Total', class: className = '', so_o = undefined, slot_content = undefined } = $props();
\tlet qty = $state(1);
</script>

<section class={['calc', className]}>
\t<output class={['amount', so_o?.total]} data-so-part="total">{title}: {qty * 10}</output>
\t<button type="button" class="more" onclick={() => qty++}>More</button>
\t<div class="extras">
\t\t{#if slot_content}{@render slot_content()}{:else}<p class="fallback">Nothing extra yet</p>{/if}
\t</div>
</section>

<style>
\t.calc { padding: 32px; }
\t.amount { display: block; font-size: 24px; padding: 8px; }
</style>
`;

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const chip = () => win.locator('.ov-chip:not(.editing)');
const selected = async () => ((await chip().count()) ? await chip().first().getAttribute('aria-label') : null);
const panel = win.locator('.side-panel-view:not([hidden])');
const insertBasic = async (label) => {
  if ((await panel.locator('.insert-tile.basic').count()) === 0) await win.locator('.rail [aria-label="Insert"]').click();
  await panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${label}$`) }) }).click();
};
const inspector = win.locator('#dock-panel-inspect');
/**
 * A plain click near the start of an element in the frame, through the page's own pointer as the author clicks: the
 * canvas is zoomed out, so the point inside the frame is scaled to the window.
 */
const clickOn = async (locator) => {
  const at = await locator.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2, width: innerWidth };
  });
  const box = await win.locator('.frame-box iframe').boundingBox();
  const scale = box.width / at.width;
  await win.mouse.click(box.x + at.x * scale, box.y + at.y * scale);
};
const total = frame.locator('[data-so-part="total"]');
/** Every file under `root`, by its path from there. */
const files = (root, rel = '') =>
  readdirSync(join(root, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(root, r)).isDirectory() ? files(root, r) : [r];
  });

try {
  step('a code component that marks a part and shows a slot declares both when it is created');
  await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
  const [{ definitionId: defId }] = await apply([{ type: 'component.createCode', name: 'Price calculator', source: SOURCE, properties: { title: { type: 'string', label: 'Title', default: 'Total' } } }], 'Create code component');
  const homeId = (await snapshot()).site.homePageId;
  const owner = { kind: 'page', id: homeId };
  const [{ nodeId: calc }] = await apply([{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId }], 'Insert Price calculator');
  const def = (await snapshot()).components[defId];
  assert.deepEqual(def.parts.total, { nodeId: 'total', label: 'Total' }, 'the marked part is declared');
  assert.deepEqual(def.slots, { content: { label: 'Content' } }, 'the slot it shows is declared');
  await eventually(async () => assert.equal(await total.count(), 1, 'the component renders'), 30000);

  step('its empty slot shows the editor’s placeholder while editing, and its own fallback in Preview');
  const placeholder = frame.locator('.extras [data-so-slot-empty="content"]');
  await eventually(async () => assert.equal(await placeholder.count(), 1, 'Edit marks where the slot’s content goes'), 30000);
  assert.equal(await frame.locator('.extras .fallback').count(), 0, 'the fallback gives way to the placeholder while editing');
  await win.locator('.toolbar').getByRole('radio', { name: 'Preview', exact: true }).click();
  await frame.locator('html:not([data-so-editing])').waitFor({ state: 'attached' });
  await eventually(async () => {
    assert.equal(await placeholder.count(), 0, 'Preview has no placeholder');
    assert.equal(await frame.locator('.extras .fallback').count(), 1, 'Preview shows what visitors see: the code’s own fallback');
  });
  await win.locator('.toolbar').getByRole('radio', { name: 'Edit', exact: true }).click();
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached' });

  step('a Stack and a Button inserted on the canvas go into the code component’s slot');
  await win.keyboard.press('Escape');
  await eventually(async () => {
    await clickOn(frame.locator('section.calc'));
    assert.match((await selected()) ?? '', /Price calculator/, 'the placement is selected');
  }, 15000);
  await insertBasic('Stack');
  const stack = await eventually(async () => {
    const node = (await snapshot()).pages[homeId].nodes[calc];
    assert.equal(node.slots?.content?.length, 1, 'the Stack is in the slot');
    return node.slots.content[0];
  }, 30000);
  await eventually(async () => assert.match((await selected()) ?? '', /Stack/, 'the new Stack is selected'), 15000);
  await insertBasic('Button');
  const button = await eventually(async () => {
    const s = await snapshot();
    const inner = s.pages[homeId].nodes[stack].children;
    assert.equal(inner.length, 1, 'the Button is in the Stack');
    assert.equal(s.pages[homeId].nodes[inner[0]].kind, 'link');
    return inner[0];
  }, 30000);
  const slotted = frame.locator(`.extras [data-so-node="${button}"]`);
  await eventually(async () => assert.equal(await slotted.count(), 1, 'the Button shows inside the code component, where its code renders the slot'), 30000);
  assert.equal(await placeholder.count(), 0, 'the placeholder goes once the slot has content');
  await win.screenshot({ path: join(OUT, 'code-slot-filled.png') });

  step('a click on the marked element selects the placement, the next one its part');
  await win.keyboard.press('Escape');
  await eventually(async () => assert.equal(await selected(), null, 'nothing is selected'));
  // One click at a time: each click steps in from what the last one selected.
  await clickOn(total);
  await eventually(async () => assert.match((await selected()) ?? '', /Price calculator/, 'the first click selects the placement'), 15000);
  await clickOn(total);
  await eventually(async () => assert.match((await selected()) ?? '', /^Total/, 'the next click selects the marked part'), 15000);
  await inspector.getByText('Part of', { exact: false }).first().waitFor({ timeout: 15000 });
  assert.equal(await inspector.locator('.insp-name h3').first().textContent(), 'Total', 'the Inspector shows the part');

  step('a background set in the Inspector reaches the marked element, through the class its code places');
  const fill = () => total.evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await fill();
  await inspector.locator('.style-row', { hasText: 'Background' }).first().locator('select').selectOption('token:color.brand');
  await eventually(async () => assert.equal((await snapshot()).pages[homeId].nodes[calc].overrides?.total?.base?.background?.token, 'color.brand', 'the placement holds the part’s style'), 15000);
  await eventually(async () => assert.notEqual(await fill(), before, 'the part shows its new background'), 30000);
  // A hover style, as the assistant and pasted styles set it, is written for the same class.
  await apply([{ type: 'node.setStyle', owner, nodeId: calc, partId: 'total', scope: 'base', state: 'hover', property: 'opacity', value: 0.5 }], 'Hover style');
  const siteCss = () => readFileSync(join(projectDir, 'src/lib/siteorigin/styles/site.css'), 'utf8');
  await eventually(() => assert.match(siteCss(), /@media \(hover: hover\)[\s\S]*-total[^{]*:where\(:hover\)[^{]*\{[^}]*opacity: 0\.5/, 'the hover rule is generated for the part'));
  await win.screenshot({ path: join(OUT, 'code-part-styled.png') });

  step('content placed in the slot is still picked on its own');
  // From the part, a click steps into what the slot holds (the Stack), never to the part again, then to the Button.
  await clickOn(slotted);
  await eventually(async () => assert.match((await selected()) ?? '', /^Stack/, 'the click selects the Stack placed in the slot'), 15000);
  await clickOn(slotted);
  await eventually(async () => assert.match((await selected()) ?? '', /^Button/, 'the next click selects the Button in it'), 15000);

  step('neither export carries a marker; the editable project keeps them');
  const out = join(WORK, 'export-static');
  const built = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), out), 300000, 'Static export');
  assert.equal(built.ok, true, `static export succeeds: ${built.message}`);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(html, /class="[^"]*amount/, 'the code component is in the website');
  assert.match(html, /Total: 10/, 'it renders its own content');
  assert.doesNotMatch(html, /data-so-/, 'the website’s page carries no editor attribute');
  for (const f of files(out).filter((p) => /\.(js|html)$/.test(p))) assert.doesNotMatch(readFileSync(join(out, f), 'utf8'), /data-so-part/, `${f} carries no part marker`);
  const sourcePath = (await snapshot()).components[defId].sourcePath;
  assert.match(readFileSync(join(projectDir, sourcePath), 'utf8'), /data-so-part="total"/, 'the project’s own code keeps its marker');
  const sourceOut = join(WORK, 'export-source');
  const src = await withTimeout(win.evaluate((dest) => window.builderTest.exportSource(dest), sourceOut), 120000, 'Source export');
  assert.equal(src.ok, true, `source export succeeds: ${src.message}`);
  const exported = readFileSync(join(sourceOut, sourcePath), 'utf8');
  assert.ok(exported.includes("<output class={['amount', so_o?.total]}>"), 'the source export keeps the code itself');
  assert.doesNotMatch(exported, /data-so-part/, 'the source export, a published site too, carries no marker (#1076)');
  assert.match(readFileSync(join(projectDir, sourcePath), 'utf8'), /data-so-part="total"/, 'the project’s own code still keeps its marker');

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  await app.close();
}
cleanup();
console.log('\ncode-slots: passed');
