// Image focus (#166): choose what stays in view when a cropped image changes shape, by dragging on the picture
// or typing, at one screen size and on one placement; check the canvas, the stylesheet, the export and Undo.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('focus');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Focus Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'focus-studio');
const siteCss = () => readFileSync(join(dir, 'src/lib/siteorigin/styles/site.css'), 'utf8');
const block = (css, media) => (media ? (css.split(`@media ${media}`)[1] ?? '').split('@media')[0] : css.split('@media')[0]);
const PHONE = '(max-width: 767.98px)';
const positions = (css) => [...css.matchAll(/object-position: ([\d.]+)% ([\d.]+)%/g)].map((m) => [Number(m[1]), Number(m[2])]);
const near = (actual, expected, what, slack = 1.5) => assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${actual} is not within ${slack} of ${expected}`);

const undo = () => win.locator('[aria-label^="Undo"]').first().click();
const styleRow = (name) => win.locator('.style-row', { hasText: name }).first();
const pad = win.locator('.focus-pad');
const down = win.getByRole('textbox', { name: 'Image focus down, percent from the top' });
const across = win.getByRole('textbox', { name: 'Image focus across, percent from the left' });

/** Select an Image part straight from the canvas: Alt-click picks the element itself, not its section. */
async function selectPart(img, section) {
  await openInspector(win);
  await img.scrollIntoViewIfNeeded();
  await img.click({ modifiers: ['Alt'] });
  await eventually(async () => assert.match(await win.locator('.insp-head').first().innerText(), new RegExp(`Image[\\s\\S]*Part of ${section}`), `the ${section} image is selected`), 15000);
  await styleRow('Aspect ratio').waitFor({ timeout: 15000 });
}

/** Press on the picture at one point (fractions of it) and release at another, as a drag. */
async function drag(from, to) {
  const b = await pad.boundingBox();
  await win.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 6 });
  await win.mouse.up();
}

step('a landscape photo cropped square for every size');
// The phone preview is shown at full scale, so a click lands where Playwright aims it.
await win.getByRole('radio', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
const studio = frame.locator('img[src*="studio"]').first();
await selectPart(studio, 'Content with image');
await win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: 'All sizes', exact: true }).click();
await styleRow('Aspect ratio').locator('select').selectOption('1/1');
await eventually(async () => assert.match(await win.locator('.focus-caption').innerText(), /67% of the picture’s width shows/, 'a 3:2 photo in a square loses a third of its width'));
await across.click();
await across.fill('20');
await across.press('Enter');
await eventually(() => assert.deepEqual(positions(block(siteCss(), null)), [[20, 50]], 'the all-sizes focus is generated'));
await eventually(async () => assert.equal(await studio.evaluate((el) => getComputedStyle(el).objectPosition), '20% 50%', 'the canvas shows it'));
await win.screenshot({ path: join(OUT, 'focus-01-square.png') });

step('Portrait 1 in the Home hero, cropped to 16:9 on phones');
await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const hero = page.nodes[page.rootIds[0]];
  const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: hero.id, prop: 'image', value: { assetId: 'a_person1', alt: 'Portrait of Hannah Wells' } }] }, { label: 'Change image' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
});
const heroImg = frame.locator('img[src*="person-1"]').first();
await heroImg.waitFor({ timeout: 30000 });
await selectPart(heroImg, 'Split hero');
await win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: 'Phone', exact: true }).click();
await styleRow('Aspect ratio').locator('select').selectOption('16/9');
await eventually(() => assert.match(block(siteCss(), PHONE), /aspect-ratio: 16\/9/, 'the phone-only ratio is generated'));

step('the inspector shows the crop the phone gets');
await pad.and(win.locator('.is-cropped')).waitFor({ timeout: 15000 });
await eventually(async () => assert.match(await win.locator('.focus-caption').innerText(), /45% of the picture’s height shows/, 'the caption names the crop'));
// The window drawn on the picture is the part of it the canvas shows: compare with the rendered image.
const measure = () => heroImg.evaluate((el) => ({ natural: el.naturalWidth / el.naturalHeight, box: el.clientWidth / el.clientHeight, fit: getComputedStyle(el).objectFit }));
// The canvas picks up the new stylesheet a moment after it is written.
const shown = await eventually(async () => {
  const m = await measure();
  near(m.box, 16 / 9, 'the canvas box is 16:9', 0.03);
  return m;
}, 20000);
assert.equal(shown.fit, 'cover', 'the canvas crops the image');
const padBox = await pad.boundingBox();
const windowBox = await win.locator('.focus-window').boundingBox();
near(windowBox.height / padBox.height, shown.natural / shown.box, 'the drawn crop matches the canvas', 0.02);
near(windowBox.width / padBox.width, 1, 'a portrait in a landscape box keeps its full width', 0.02);
await win.screenshot({ path: join(OUT, 'focus-02-crop.png') });

step('drag the focal point up toward her face');
await drag([0.5, 0.5], [0.5, 0.22]);
await eventually(() => {
  const at = positions(block(siteCss(), PHONE));
  assert.equal(at.length, 1, 'one phone focal point is generated');
  near(at[0][0], 50, 'across stays at the middle');
  near(at[0][1], 22, 'down follows the drag');
});
const dragged = positions(block(siteCss(), PHONE))[0];
// The window moved with the focus: the hidden height is split dragged% above it and the rest below.
await eventually(async () => {
  const p = await pad.boundingBox();
  const w = await win.locator('.focus-window').boundingBox();
  near((w.y - p.y) / p.height, (1 - shown.natural / shown.box) * (dragged[1] / 100), 'the drawn crop moved with the focus', 0.02);
});
assert.deepEqual(positions(block(siteCss(), null)), [[20, 50]], 'other sizes keep their focus: only the square photo has one');
await eventually(async () => assert.equal(await heroImg.evaluate((el) => getComputedStyle(el).objectPosition), `${dragged[0]}% ${dragged[1]}%`, 'the canvas shows the new focus'));
await win.screenshot({ path: join(OUT, 'focus-03-dragged.png') });

step('a drag released outside the picture stops at its edge');
await drag([0.5, 0.5], [0.5, 1.4]);
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [[50, 100]], 'the focus stops at the bottom edge'));

step('Escape cancels a drag');
{
  const b = await pad.boundingBox();
  await win.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.1, { steps: 4 });
  await win.keyboard.press('Escape');
  await win.mouse.up();
  await win.waitForTimeout(600);
  assert.deepEqual(positions(block(siteCss(), PHONE)), [[50, 100]], 'the cancelled drag wrote nothing');
  await styleRow('Aspect ratio').waitFor({ timeout: 2000 });
}

step('type the focus with the keyboard');
// Across, then Tab straight on to Down: the second value builds on the first even before it has landed.
await across.click();
await across.fill('20');
await across.press('Tab');
await down.fill('75');
await down.press('Enter');
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [[20, 75]], 'both typed values are generated'));
await across.click();
await across.fill('140');
await across.press('Enter');
await win.waitForTimeout(500);
assert.deepEqual(positions(block(siteCss(), PHONE)), [[20, 75]], 'a value outside the picture is refused');
await across.press('Escape');

// The export restarts the preview, so nothing after it clicks in the canvas.
step('export');
const exportDir = join(WORK, 'export-site');
const er = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir), 300000, 'Static export');
assert.ok(er.ok, `export succeeded: ${er.message}`);
const exportedCss = readdirSync(exportDir, { recursive: true })
  .filter((f) => String(f).endsWith('.css'))
  .map((f) => readFileSync(join(exportDir, String(f)), 'utf8'))
  .join('\n');
const ids = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const of = (componentId) => page.rootIds.find((id) => s.state.components[page.nodes[id].definitionId]?.componentId === componentId);
  return { hero: of('hero.split'), media: of('content.media') };
});
const rule = (id) => `\\.so-o-${id}-media\\.so-o-${id}-media\\{[^}]*`;
// The minified query reads "(width<=767.98px)" or "(max-width:767.98px)", depending on the CSS minifier.
assert.match(exportedCss, new RegExp(`@media \\((?:width\\s*<=\\s*|max-width:\\s*)767\\.98px\\)\\{[^@]*${rule(ids.hero)}object-position:\\s*20% 75%`), 'the exported hero carries its phone focal point');
assert.match(exportedCss, new RegExp(`(?:^|\\})${rule(ids.media)}object-position:\\s*20% 50%`), 'and the square photo its all-sizes one');

step('Center');
await win.getByRole('button', { name: 'Center', exact: true }).click();
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [[50, 50]], 'Center writes the middle'));
// The Team portraits on About are other placements: none of them moved.
assert.equal(positions(siteCss()).length, 2, 'only the hero and the square photo have focal points');

step('Undo takes back one change at a time');
await undo();
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [[20, 75]], 'Undo restores the typed values'));
await undo();
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [[20, 100]], 'Undo takes back Down alone, leaving Across on the last drag'));
await undo();
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [[50, 100]], 'Undo restores the second drag'));
await undo();
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [dragged], 'Undo restores the first drag'));
await undo();
await eventually(() => assert.deepEqual(positions(block(siteCss(), PHONE)), [], 'Undo removes the focal point'));
assert.deepEqual(positions(siteCss()), [[20, 50]], 'the square photo keeps its own');
assert.match(block(siteCss(), PHONE), /aspect-ratio: 16\/9/, 'the crop itself stays');
await eventually(async () => assert.equal(await across.inputValue(), '', 'the inspector shows the value as it is again'));
await eventually(async () => assert.equal(await heroImg.evaluate((el) => getComputedStyle(el).objectPosition), '50% 50%', 'the canvas is back at the center'));
// Then the hero's ratio and picture, and the square photo's focus, its crop staying.
await undo();
await eventually(() => assert.doesNotMatch(block(siteCss(), PHONE), /aspect-ratio: 16\/9/, 'Undo takes back the phone crop'));
await undo();
await eventually(async () => {
  const assetId = await win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    return page.nodes[page.rootIds[0]].props.image?.assetId;
  });
  assert.notEqual(assetId, 'a_person1', 'Undo puts the hero’s own picture back');
});
await undo();
await eventually(() => assert.deepEqual(positions(siteCss()), [], 'Undo removes the square photo’s focus'));
assert.match(siteCss(), /aspect-ratio: 1\/1/, 'the square crop stays');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nfocus: all checks passed');
