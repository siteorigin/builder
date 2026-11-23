// The Site styles color controls against the real app: every saved CSS color shows on its swatch, starts
// the picker from itself (never from black), keeps its opacity through an adjustment, and undoes cleanly.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('colors');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Colors', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'harbour-colors');

await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();

// Brand is the first row of Basics, and shows again under Colors; every check here reads the Basics one.
const section = (name) => win.locator('#dock-panel-styles .section').filter({ has: win.locator('button.section-head', { hasText: name }) });
const row = () => section('Basics').locator('[data-ss-row]').first();
const text = () => row().locator('input.ss-hex');
const picker = () => row().locator('input[type="color"]');
const fill = () => row().locator('.color-pick-fill');
const saved = () => win.evaluate(async () => (await window.builder.project.snapshot()).state.tokens.overrides['color.brand']);
const revision = () => win.evaluate(async () => (await window.builder.project.snapshot()).revision);
/** The revision once it has stopped moving: a snapshot taken mid-apply shows the new state with the old revision. */
const settled = async () => {
  let last = await revision();
  for (;;) {
    await win.waitForTimeout(250);
    const now = await revision();
    if (now === last) return now;
    last = now;
  }
};
const swatch = () => fill().evaluate((el) => getComputedStyle(el).backgroundColor);
const cta = () => frame.locator('.so-btn--primary').first().evaluate((el) => getComputedStyle(el).backgroundColor);
const undo = () => win.evaluate(() => window.builder.project.undo());
const paste = async (value) => {
  await text().fill(value);
  await text().press('Enter');
  await eventually(async () => assert.equal(await saved(), value, `${value} is saved as typed`));
};
/** Choose a color in the native picker: the same input and change events the real dialog sends. */
const pick = async (hex) => {
  await picker().fill(hex);
};

const original = await saved();
assert.equal(original, undefined, 'the theme brand color is not overridden yet');
const themeBrand = await picker().inputValue();
assert.match(themeBrand, /^#[0-9a-f]{6}$/, 'the picker starts from the theme color');
assert.notEqual(themeBrand, '#000000', 'the theme color is not black');

const cases = [
  { label: 'rgb()', value: 'rgb(209, 65, 49)', start: '#d14131', fill: 'rgb(209, 65, 49)', adjusted: '#c0392b' },
  { label: 'short hex', value: '#d43', start: '#dd4433', fill: 'rgb(221, 68, 51)', adjusted: '#c0392b' },
  { label: 'six-digit hex', value: '#d14131', start: '#d14131', fill: 'rgb(209, 65, 49)', adjusted: '#c0392b' },
  { label: 'translucent rgba()', value: 'rgba(209, 65, 49, 0.5)', start: '#d14131', fill: 'rgba(209, 65, 49, 0.5)', adjusted: 'rgba(192, 57, 43, 0.5)' },
  { label: 'translucent hex', value: '#d1413180', start: '#d14131', fill: 'rgba(209, 65, 49, 0.5)', adjusted: '#c0392b80' },
  { label: 'modern rgb()', value: 'rgb(209 65 49 / 40%)', start: '#d14131', fill: 'rgba(209, 65, 49, 0.4)', adjusted: 'rgb(192 57 43 / 0.4)' },
  { label: 'hsl()', value: 'hsl(5 63% 51%)', start: '#d14033', adjusted: '#c0392b' }
];

for (const c of cases) {
  step(`${c.label}: save, adjust, undo`);
  await paste(c.value);
  await eventually(async () => assert.equal(await picker().inputValue(), c.start, `${c.label}: the picker starts from the saved color, not black`));
  assert.equal(await text().inputValue(), c.value, `${c.label}: the text field keeps what was typed`);
  if (c.fill) await eventually(async () => assert.equal(await swatch(), c.fill, `${c.label}: the swatch shows the color as it renders`));

  // Choosing the color the picker already shows rewrites nothing.
  const rev = await settled();
  await pick(c.start);
  assert.equal(await settled(), rev, `${c.label}: an unchanged pick does not touch the project`);
  assert.equal(await saved(), c.value, `${c.label}: an unchanged pick leaves the saved text alone`);

  // Adjusting straight after the paste is its own undo step, so undo comes back to the pasted text.
  await pick('#c0392b');
  await eventually(async () => assert.equal(await saved(), c.adjusted, `${c.label}: the adjusted color keeps its opacity`));
  await eventually(async () => assert.equal(await picker().inputValue(), '#c0392b', `${c.label}: the picker shows the adjusted color`));
  assert.equal(await text().inputValue(), c.adjusted, `${c.label}: the text field follows the picker`);
  await undo();
  await eventually(async () => assert.equal(await saved(), c.value, `${c.label}: undo returns the typed text`));
  await eventually(async () => assert.equal(await picker().inputValue(), c.start, `${c.label}: the picker follows the undo`));
  assert.equal(await text().inputValue(), c.value, `${c.label}: the text field follows the undo`);
}

step('the RGB color survives closing and reopening the project');
await paste('rgb(209, 65, 49)');
await eventually(async () => assert.equal(await cta(), 'rgb(209, 65, 49)', 'the preview button has exactly the pasted color'), 20000);
await win.evaluate(() => window.builder.project.flush?.());
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(reopened.ok, `the project reopens: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await eventually(async () => assert.equal(await text().inputValue(), 'rgb(209, 65, 49)', 'the saved text is still there'));
assert.equal(await picker().inputValue(), '#d14131', 'the reopened picker starts from the saved red, not black');
assert.equal(await swatch(), 'rgb(209, 65, 49)', 'the reopened swatch shows the saved red');
await pick('#b03a2e');
await eventually(async () => assert.equal(await saved(), '#b03a2e', 'an adjustment on a reopened project saves'));
await undo();
await eventually(async () => assert.equal(await saved(), 'rgb(209, 65, 49)', 'undo returns the typed text'));

step('a color only the browser can resolve still starts the picker from itself');
await paste('color-mix(in srgb, #ff0000 50%, #0000ff)');
await eventually(async () => assert.equal(await picker().inputValue(), '#800080', 'the mixed color starts the picker'));
await eventually(async () => assert.equal(await picker().isDisabled(), false, 'the picker is open for it'));
await pick('#336699');
await eventually(async () => assert.equal(await saved(), '#336699', 'a pick replaces the mix with a plain color'));

step('a color the picker cannot read keeps its text and shuts the picker');
await paste('currentcolor');
await eventually(async () => assert.equal(await picker().isDisabled(), true, 'the picker is shut rather than starting from black'));
assert.equal(await text().inputValue(), 'currentcolor', 'the text value is still editable');

step('a color that follows another stays linked');
await paste('rgba(209, 65, 49, 0.5)');
await section('Colors').locator('[data-ss-row]', { hasText: 'Brand (strong)' }).locator('.ss-disclose').click();
await section('Colors').locator('[data-ss-row]', { hasText: 'Brand (strong)' }).getByRole('combobox').selectOption('color.brand');
const linked = section('Colors').locator('[data-ss-row]', { hasText: 'Brand (strong)' });
await eventually(async () => assert.equal(await linked.locator('input[type="color"]').isDisabled(), true, 'a linked color has no picker of its own'));
await eventually(async () => assert.equal(await linked.locator('.color-pick-fill').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(209, 65, 49, 0.5)', 'it shows the color it follows, opacity included'));
await eventually(async () => assert.equal(await linked.locator('input[type="color"]').inputValue(), '#d14131', 'and the picker value is the one it follows'));
await eventually(async () => {
  const link = await win.evaluate(async () => (await window.builder.project.snapshot()).state.tokens.overrides['color.brand-strong']);
  assert.deepEqual(link, { token: 'color.brand' }, 'the link is saved as a link');
});

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncolors: passed');
