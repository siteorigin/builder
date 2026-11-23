// Editing flows against the real app: inline text, insert, responsive override, undo, reorder, export.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('flows');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'harbour-lane-studio');
const read = (rel) => readFileSync(join(dir, rel), 'utf8');
await win.waitForTimeout(1500);
await win.screenshot({ path: join(OUT, '10-images.png') });

step('inline text edit');
const h1 = frame.locator('h1').first();
await h1.click();
await win.waitForTimeout(300);
await h1.dblclick();
await win.waitForTimeout(300);
await win.keyboard.type('Rooms that work beautifully');
await win.keyboard.press('Enter');
await eventually(() => assert.ok(read('src/routes/+page.svelte').includes('Rooms that work beautifully'), 'the new heading is written to the page source'));
assert.ok(!read('src/routes/+page.svelte').includes('data-so-'), 'no editor instrumentation in the page source');
await eventually(async () => assert.equal(await h1.innerText(), 'Rooms that work beautifully', 'the preview shows the new heading'));

step('insert pricing via Insert panel');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Pricing' }).click();
await eventually(async () => assert.equal(await frame.locator('text=Clear packages, no surprises').count(), 1, 'one pricing section is inserted'));
await win.screenshot({ path: join(OUT, '11-inserted.png') });

step('phone-only padding override on selected section');
const phoneRule = /@media \(max-width: 767\.98px\)[\s\S]*padding-block: var\(--so-space-lg\)/;
const siteCss = () => read('src/lib/siteorigin/styles/site.css');
assert.doesNotMatch(siteCss(), phoneRule, 'no phone padding rule before the edit');
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
await win.getByRole('button', { name: 'Style', exact: true }).last().click();
await win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: 'Phone', exact: true }).click();
await win.locator('.style-row', { hasText: 'Vertical padding' }).first().locator('select').selectOption('token:space.lg');
await eventually(() => assert.match(siteCss(), phoneRule, 'the phone-only padding rule is generated'));
await win.screenshot({ path: join(OUT, '12-phone.png') });

step('undo / redo');
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(() => assert.doesNotMatch(siteCss(), /padding-block: var\(--so-space-lg\)/, 'undo removes the padding rule'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(() => assert.match(siteCss(), phoneRule, 'redo restores the padding rule'));

step('drag to reorder: canvas grip and layers');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await win.waitForTimeout(800);
const order = async () =>
  (
    await win.evaluate(async () => {
      const s = await window.builder.project.snapshot();
      const p = s.state.pages[s.state.site.homePageId];
      return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name);
    })
  ).slice(0, 3);
assert.deepEqual(await order(), ['Split hero', 'Logo strip', 'Services grid']);
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).click();
await win.waitForTimeout(800);
const gb = await win.locator('.ov-chip [aria-label="Drag to move"]').boundingBox();
assert.ok(gb, 'the selection chip shows a drag grip');
const wrap = await win.locator('.frame-wrap').boundingBox();
await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await win.mouse.down();
await win.mouse.move(wrap.x + wrap.width / 2, wrap.y + 620, { steps: 8 });
await win.waitForTimeout(200);
await win.screenshot({ path: join(OUT, '16-drag.png') });
await win.mouse.up();
await eventually(async () => assert.deepEqual(await order(), ['Logo strip', 'Split hero', 'Services grid'], 'the canvas drag moves the hero below the logo strip'));
await win.locator('.list-item', { hasText: 'Split hero' }).dragTo(win.locator('.list-item', { hasText: 'Logo strip' }), { targetPosition: { x: 40, y: 4 } });
await eventually(async () => assert.deepEqual(await order(), ['Split hero', 'Logo strip', 'Services grid'], 'the Layers drag moves the hero back to the top'));

step('site styles and chat panels');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await win.screenshot({ path: join(OUT, '13-styles.png') });
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await win.locator('.chat-empty').waitFor(); // No provider is connected in this run.
await win.screenshot({ path: join(OUT, '14-chat.png') });
await win.locator('.rail [aria-label="Layers"]').click();
await win.waitForTimeout(300);
await win.screenshot({ path: join(OUT, '15-layers.png') });

step('export static');
const t0 = Date.now();
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
console.log('export:', er.message, Date.now() - t0, 'ms');
assert.equal(er.ok, true, `static export succeeds: ${er.message} ${er.warnings?.join(' ')}`);
const about = readFileSync(join(exportDir, 'about/index.html'), 'utf8');
assert.ok(about.includes('A small studio with a long view'), 'the About page is prerendered with its content');
assert.doesNotMatch(about, /data-so-|siteorigin-bridge/, 'no editor markup in the export');
assert.ok(readFileSync(join(exportDir, 'index.html'), 'utf8').includes('Rooms that work beautifully'), 'the exported home page has the edited heading');
assert.ok(!readdirSync(exportDir).includes('.siteorigin'), 'no editor state in the export');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nflows: passed');
