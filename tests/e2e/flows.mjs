// Editing flows against the real app: inline text, insert, responsive override, undo, reorder, export.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

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

step('inline rich text: bold, italic and a page link');
const rich = frame.locator('.so-rich', { hasText: 'That conversation shapes' }).first();
await rich.scrollIntoViewIfNeeded();
await rich.click();
await win.waitForTimeout(300);
await rich.dblclick();
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited'));
await rich.evaluate((el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.nodeValue.indexOf('conversation');
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + 'conversation'.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
});
await win.keyboard.press(`${MOD}+b`);
await win.keyboard.press(`${MOD}+i`);
await win.keyboard.press(`${MOD}+k`);
await eventually(async () => assert.equal(await win.locator('[role="dialog"]').count(), 0, 'the command menu stays closed while editing text'));
await win.keyboard.type('/about/');
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await rich.locator('a[href="/about/"]').count(), 1, 'the words are linked'));
await win.keyboard.press(`${MOD}+Enter`);
const richSpan = async () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const about = Object.values(s.state.pages).find((x) => x.title === 'About');
    for (const n of Object.values(page.nodes)) {
      for (const b of Array.isArray(n.props?.body) ? n.props.body : []) {
        const span = b.spans?.find((x) => x.text === 'conversation');
        if (span) return { span, about: about.id };
      }
    }
    return null;
  });
await eventually(async () => {
  const found = await richSpan();
  assert.ok(found, 'the edited words are stored as their own span');
  assert.deepEqual(found.span, { text: 'conversation', strong: true, em: true, link: { type: 'page', target: found.about } }, 'bold, italic and the page ID are stored together');
});
await eventually(async () => assert.equal(await rich.locator('a[href="/about/"] strong em').count(), 1, 'the preview shows the linked bold italic words'));
assert.ok(!read('src/lib/siteorigin/runtime/RichText.svelte').includes('data-so-'), 'no editor instrumentation in the rich text helper');

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

step('edit a component everywhere: canvas, layers and inspector agree');
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.mode-band').waitFor();
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'entering outlines the design on the canvas'));
// A click in the page picks the design's own node under the pointer: Layers and the inspector follow it.
const gridId = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  return s.state.pages[s.state.site.homePageId].rootIds[2];
});
const gridHeading = frame.locator(`[data-so-ctx$="|${gridId}"] h2`).first();
const headingNode = await gridHeading.getAttribute('data-so-node');
await gridHeading.click();
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${headingNode}"]`).getAttribute('aria-selected'), 'true', 'Layers selects the picked node of the design'));
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'the picked node is outlined'));
await win.locator('.insp-scope.definition').first().waitFor();
// And back: Escape shows the overview, then the Layers row outlines that node on the canvas again.
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await win.locator('.ov-selected').count(), 0, 'Escape clears the selection'));
await win.locator(`[role="tree"] [data-node="${headingNode}"]`).click();
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'a Layers pick in the design is outlined on the canvas'));
await win.locator('.insp-scope.definition').first().waitFor();
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });

step('tone and layout combine, and a code component offers its tone');
const axis = (label) => win.locator('#dock-panel-inspect .field', { hasText: new RegExp(`^${label}`) }).locator('select').first();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
await axis('Tone').selectOption('inverse');
await axis('Layout').selectOption('four-columns');
await eventually(() => {
  const page = read('src/routes/+page.svelte');
  assert.match(page, /variant_tone="inverse"/, 'the section keeps its dark tone');
  assert.match(page, /variant_layout="four-columns"/, 'alongside its four-column layout');
});
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Contact form' }).click();
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Contact form' }).waitFor();
await axis('Tone').selectOption('muted');
await eventually(() => assert.match(read('src/routes/+page.svelte'), /variant="muted"/, 'the form takes the tone chosen in the Inspector'));
await eventually(async () => assert.equal(await frame.locator('section.so-form--muted').count(), 1, 'the preview shows the form in that tone'));

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
