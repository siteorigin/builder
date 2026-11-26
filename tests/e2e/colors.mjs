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
/**
 * The revision once every save has landed and it has stopped moving. A snapshot taken mid-apply shows the new state
 * with the old revision, and on a slow disk (Windows) that can last longer than any pause: the toolbar says Saved only
 * once the save has come back.
 */
const settled = async () => {
  await eventually(async () => assert.equal(await win.locator('.toolbar .save-state').innerText(), 'Saved', 'every save has landed'));
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
  { label: 'hsl()', value: 'hsl(5 63% 51%)', start: '#d14033', adjusted: '#c0392b' },
  { label: 'zero opacity', value: '#d1413100', start: '#d14131', fill: 'rgba(209, 65, 49, 0)', adjusted: '#c0392b00' }
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
  await eventually(async () => assert.equal(await text().inputValue(), c.adjusted, `${c.label}: the text field follows the picker`));
  await undo();
  await eventually(async () => assert.equal(await saved(), c.value, `${c.label}: undo returns the typed text`));
  await eventually(async () => assert.equal(await picker().inputValue(), c.start, `${c.label}: the picker follows the undo`));
  await eventually(async () => assert.equal(await text().inputValue(), c.value, `${c.label}: the text field follows the undo`));
}

step('a fast drag that goes out and comes back ends where it was left, as one undo step');
await paste('rgb(209, 65, 49)');
await eventually(async () => assert.equal(await swatch(), 'rgb(209, 65, 49)', 'the editor shows the pasted color before the drag starts'));
await picker().evaluate((el) => {
  // Three steps of one drag in a single task, before any save can come back: out, further out, home again.
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const hex of ['#0000ff', '#336699', '#d14131']) {
    set.call(el, hex);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await eventually(async () => assert.equal(await saved(), '#d14131', 'the last place the drag reached is what is saved'));
await eventually(async () => assert.equal(await picker().inputValue(), '#d14131', 'and what the picker shows'));
await undo();
await eventually(async () => assert.equal(await saved(), 'rgb(209, 65, 49)', 'the whole drag is one undo step'));

step('each format survives closing and reopening the project');
const named = (name) => ({
  text: section('Colors').locator(`input.ss-hex[aria-label="${name} color value"]`),
  picker: section('Colors').locator(`input[type="color"][aria-label="${name} color"]`),
  fill: section('Colors').locator('.color-pick').filter({ has: win.locator(`input[aria-label="${name} color"]`) }).locator('.color-pick-fill')
});
/** A row in Colors by its own name: a note on another row can mention a color by name, so matching text would pick that row too. */
const colorRow = (name) => section('Colors').locator('[data-ss-row]').filter({ has: win.locator('.ss-name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}\\s*$`) }) });
const reopenCases = [
  { name: 'Accent', value: '#d43', start: '#dd4433', fill: 'rgb(221, 68, 51)' },
  { name: 'Cards and panels', value: '#d14131', start: '#d14131', fill: 'rgb(209, 65, 49)' },
  { name: 'Primary text', value: 'rgba(209, 65, 49, 0.5)', start: '#d14131', fill: 'rgba(209, 65, 49, 0.5)' }
];
for (const c of reopenCases) {
  await named(c.name).text.fill(c.value);
  await named(c.name).text.press('Enter');
  await eventually(async () => assert.equal(await win.evaluate(async (id) => (await window.builder.project.snapshot()).state.tokens.overrides[id], { Accent: 'color.accent', 'Cards and panels': 'color.surface', 'Primary text': 'color.text' }[c.name]), c.value, `${c.name} is saved as typed`));
}
await eventually(async () => assert.equal(await cta(), 'rgb(209, 65, 49)', 'the preview button has exactly the pasted color'), 20000);
await settled();
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(reopened.ok, `the project reopens: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await eventually(async () => assert.equal(await text().inputValue(), 'rgb(209, 65, 49)', 'the saved RGB text is still there'));
assert.equal(await picker().inputValue(), '#d14131', 'the reopened picker starts from the saved red, not black');
assert.equal(await swatch(), 'rgb(209, 65, 49)', 'the reopened swatch shows the saved red');
for (const c of reopenCases) {
  const row = named(c.name);
  await eventually(async () => assert.equal(await row.text.inputValue(), c.value, `${c.name}: the saved text is still there`));
  assert.equal(await row.picker.inputValue(), c.start, `${c.name}: the reopened picker starts from the saved color, not black`);
  assert.equal(await row.fill.evaluate((el) => getComputedStyle(el).backgroundColor), c.fill, `${c.name}: the reopened swatch shows the saved color`);
}
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
await eventually(async () => assert.equal(await text().inputValue(), '#336699', 'the editor shows that pick before the next draft'));

step('a color the picker cannot read keeps its text, paints nothing, and a pick replaces it');
await paste('currentcolor');
await eventually(async () => assert.equal(await row().locator('.color-pick').getAttribute('class'), 'color-pick unpainted', 'the swatch shows it has nothing to paint'));
assert.equal(await swatch(), 'rgba(0, 0, 0, 0)', 'nothing is painted for it');
assert.equal(await picker().isDisabled(), false, 'the picker still opens, so the color can be replaced');
assert.equal(await text().inputValue(), 'currentcolor', 'the text value is still editable');
await pick('#336699');
await eventually(async () => assert.equal(await saved(), '#336699', 'a pick replaces it with a plain color'));
await eventually(async () => assert.equal(await text().inputValue(), '#336699', 'the editor shows the replacement before the next draft'));
await paste('rgb(255, 0 0)');
await eventually(async () => assert.equal(await swatch(), 'rgba(0, 0, 0, 0)', 'text that is not a color leaves nothing painted, not the color before it'));

step('a white brand color is flagged where it is set, with a readable text color on offer');
const overrideOf = (id) => win.evaluate(async (t) => (await window.builder.project.snapshot()).state.tokens.overrides[t], id);
const overridesNow = () => win.evaluate(async () => (await window.builder.project.snapshot()).state.tokens.overrides);
const basics = () => section('Basics').locator('.ss-contrast');
const pairRow = (use) => basics().locator('.ss-pair').filter({ has: win.locator('.ss-pair-use', { hasText: new RegExp(`^${use}$`) }) });
const headerCta = frame.locator('.so-header__cta').first();
const colorsOf = (loc) => loc.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
await paste('#ffffff');
await eventually(async () => assert.match(await pairRow('Button text').innerText(), /1\.00:1\s+Low contrast/, 'the button at rest reads as unreadable beside the color that was just set'));
assert.match(await pairRow('Button text on hover').innerText(), /10\.92:1\s+Readable/, 'the hover state is shown separately, and readable');
assert.match(await pairRow('Brand-colored links on the page').innerText(), /Low contrast/, 'brand-colored text on the page is flagged too');
const contrastAnnouncement = win.locator('#dock-panel-styles').getByRole('status').filter({ hasText: /^Low contrast:/ });
await eventually(async () => assert.match(await contrastAnnouncement.innerText(), /Low contrast: .*Button text/, 'the unreadable pair is announced'));
await eventually(async () => assert.deepEqual(await colorsOf(headerCta), { color: 'rgb(255, 255, 255)', background: 'rgb(255, 255, 255)' }, 'the header button in the preview really is white on white'), 20000);
const onBrandRow = colorRow('Text on brand color');
assert.equal(await onBrandRow.locator('.ss-flag').count(), 1, 'the Text on brand color row carries the flag too');
await colorRow('Border').waitFor();
assert.equal(await colorRow('Border').locator('.ss-flag').count(), 0, 'a color in no pair carries no flag');
assert.match(await basics().innerText(), /Choosing it leaves .*hard to read\. Change Brand \(strong\)/, 'the offer says what it would leave hard to read, before it is taken');
const rest = await settled();
const before = await overridesNow();
await basics().getByRole('button', { name: /Use dark ink for Text on brand color/ }).click();
await eventually(async () => assert.equal(await overrideOf('color.on-brand'), '#14181a', 'the offer sets the foreground token'));
assert.deepEqual(await overridesNow(), { ...before, 'color.on-brand': '#14181a' }, 'and changes nothing else');
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Brand color value', 'focus lands on the Brand value, not on the page, when the offer goes'));
await eventually(async () => assert.match(await pairRow('Button text').innerText(), /17\.86:1\s+Readable/, 'the button is readable at rest'));
assert.match(await pairRow('Button text on hover').innerText(), /1\.63:1\s+Low contrast/, 'and the cost to the hover state is shown, not hidden');
assert.match(await basics().innerText(), /Brand \(strong\)/, 'with the other color to change for it named');
await eventually(async () => assert.match(await colorRow('Brand (strong)').innerText(), /Button text on hover is hard to read/, 'the hover color\'s own row carries the hover flag'));
await eventually(async () => assert.deepEqual(await colorsOf(headerCta), { color: 'rgb(20, 24, 26)', background: 'rgb(255, 255, 255)' }, 'the header button in the preview now reads'), 20000);
// The editor's overlay catches the pointer, so a real hover is out of reach; the :hover rule paints --so-btn-bg-hover, which is the color the hover ratio is measured on.
await eventually(async () => assert.equal(await headerCta.evaluate((el) => getComputedStyle(el).getPropertyValue('--so-btn-bg-hover').trim()), '#16443a', 'the preview button hovers to the color the hover ratio is measured on'), 20000);
await undo();
await eventually(async () => assert.equal(await overrideOf('color.on-brand'), undefined, 'one undo takes back the offer'));
assert.deepEqual(await overridesNow(), before, 'and only the offer');
await eventually(async () => assert.match(await pairRow('Button text').innerText(), /1\.00:1\s+Low contrast/, 'the flag returns with it'));
assert.ok((await settled()) > rest, 'the offer was a change of its own');
await paste('rgba(209, 65, 49, 0.5)');

step('a color that follows another stays linked');
await paste('rgba(209, 65, 49, 0.5)');
await colorRow('Brand (strong)').locator('.ss-disclose').click();
await colorRow('Brand (strong)').getByRole('combobox').selectOption('color.brand');
const linked = colorRow('Brand (strong)');
await eventually(async () => assert.equal(await linked.locator('input[type="color"]').isDisabled(), true, 'a linked color has no picker of its own'));
await eventually(async () => assert.equal(await linked.locator('.color-pick-fill').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(209, 65, 49, 0.5)', 'it shows the color it follows, opacity included'));
await eventually(async () => assert.equal(await linked.locator('input[type="color"]').inputValue(), '#d14131', 'and the picker value is the one it follows'));
await eventually(async () => {
  const link = await win.evaluate(async () => (await window.builder.project.snapshot()).state.tokens.overrides['color.brand-strong']);
  assert.deepEqual(link, { token: 'color.brand' }, 'the link is saved as a link');
});

step('a color of your own keeps its picker, and follows another color until it is given its own again');
const customs = () => win.evaluate(async () => (await window.builder.project.snapshot()).state.tokens.custom);
const customValue = async (id) => (await customs()).find((t) => t.id === id)?.value;
await win.locator('#dock-panel-styles .insp-jump button', { hasText: 'Yours' }).click();
const yours = section('Your styles');
const form = yours.locator('.ss-new-style');
await form.getByLabel('Name').fill('Sea');
await form.getByLabel('Value').fill('#2e8b57');
await form.getByRole('button', { name: 'Add style' }).click();
await eventually(async () => assert.equal(await customValue('color.custom-sea'), '#2e8b57', 'the new color is saved'));
const sea = yours.locator('[data-token-id="color.custom-sea"]');
await sea.locator('input[type="color"]').fill('#225544');
await eventually(async () => assert.equal(await customValue('color.custom-sea'), '#225544', 'its picker saves a color of its own'));
await sea.getByLabel('Same as').selectOption('color.brand');
await eventually(async () => assert.deepEqual(await customValue('color.custom-sea'), { token: 'color.brand' }, 'it follows Brand as a link'));
await eventually(async () => assert.equal(await sea.locator('input[type="color"]').isDisabled(), true, 'a linked color has no picker of its own'));
const seaSwatch = () => sea.locator('.color-pick-fill').evaluate((el) => getComputedStyle(el).backgroundColor);
await eventually(async () => assert.equal(await seaSwatch(), 'rgba(209, 65, 49, 0.5)', 'the linked swatch paints the color it follows'));
await paste('#336699');
await eventually(async () => assert.equal(await seaSwatch(), 'rgb(51, 102, 153)', 'and follows it when Brand changes'));
const brandNow = await saved();
await sea.getByLabel('Same as').selectOption('');
await eventually(async () => assert.equal(await customValue('color.custom-sea'), brandNow, 'unlinking keeps the color it showed'));
await undo();
await eventually(async () => assert.deepEqual(await customValue('color.custom-sea'), { token: 'color.brand' }, 'one undo returns to the link'));
await sea.getByLabel('Same as').selectOption('');
await eventually(async () => assert.equal(await customValue('color.custom-sea'), brandNow, 'and it can be unlinked again'));
await eventually(async () => assert.equal(await sea.locator('input[type="color"]').isDisabled(), false, 'and its picker is back'));

step('a text style of your own opens in the Text styles list');
await form.getByLabel('Kind').selectOption('text');
await form.getByLabel('Name').fill('Callout');
await form.getByRole('button', { name: 'Add style' }).click();
await eventually(async () => assert.ok(await customValue('text.custom-callout'), 'the text style is saved'));
const textHead = section('Text styles').locator('button.section-head');
if ((await textHead.getAttribute('aria-expanded')) === 'true') await textHead.click();
await yours.locator('[data-token-id="text.custom-callout"]').getByRole('button', { name: /Edit text style/ }).click();
const callout = section('Text styles').locator('[data-token-id="text.custom-callout"] .ss-text-toggle');
await eventually(async () => assert.equal(await callout.getAttribute('aria-expanded'), 'true', 'the jump opens the collapsed list at that style'));
await eventually(async () => assert.equal(await callout.evaluate((el) => el === document.activeElement), true, 'and lands on it'));
await eventually(async () => {
  const inView = await callout.evaluate((el) => {
    const scroller = el.closest('.panel-body');
    const top = scroller.querySelector('.insp-head')?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top;
    const r = el.getBoundingClientRect();
    return r.top >= top - 1 && r.bottom <= scroller.getBoundingClientRect().bottom + 1;
  });
  assert.equal(inView, true, 'scrolled into view below the panel header');
});
await section('Text styles').locator('[data-token-id="text.custom-callout"]').getByLabel('Weight of Callout').selectOption('700');
await eventually(async () => assert.equal((await customValue('text.custom-callout'))?.weight, 700, 'its editor changes the custom text style'));

step('a palette made from the brand previews without saving, applies in one step, and one undo puts every color back');
const colorsHead = section('Colors').locator('button.section-head');
if ((await colorsHead.getAttribute('aria-expanded')) !== 'true') await colorsHead.click();
const harmony = section('Colors').locator('.ss-harmony');
await harmony.waitFor();
const overrides = () => win.evaluate(async () => (await window.builder.project.snapshot()).state.tokens.overrides);
const pageBackground = () => frame.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const beforePalette = await overrides();
const beforeBackground = await pageBackground();
const atRest = await settled();
const chips = async () => Object.fromEntries(await harmony.locator('.ss-harmony-chips li').evaluateAll((els) => els.map((el) => [el.dataset.role, el.dataset.value])));
const drawnPage = () => harmony.locator('.ss-harmony-preview').evaluate((el) => getComputedStyle(el).backgroundColor);
assert.equal(await harmony.getByRole('radio', { name: 'Neutral', exact: true }).getAttribute('aria-checked'), 'true', 'Neutral is offered first');
const neutral = await chips();
const neutralPage = await drawnPage();
const tinted = harmony.getByRole('radio', { name: 'Tinted', exact: true });
await tinted.click();
await eventually(async () => assert.equal(await tinted.getAttribute('aria-checked'), 'true', 'the mood is chosen'));
const proposed = await chips();
assert.notEqual(proposed['color.background'], neutral['color.background'], 'each mood proposes its own colors');
assert.notEqual(await drawnPage(), neutralPage, 'and the preview is drawn in them');
assert.equal(await drawnPage(), rgbOf(proposed['color.background']), 'its page in the proposed background');
for (const id of ['color.background', 'color.surface', 'color.surface-alt', 'color.border', 'color.muted', 'color.brand-strong', 'color.inverse', 'color.accent']) assert.match(proposed[id] ?? '', /^#[0-9a-f]{6}$/, `the preview names ${id}`);
assert.match(await harmony.locator('.ss-harmony-facts').textContent(), /Every color pair in this preview is readable/, 'and says the proposal is readable');
assert.equal(await settled(), atRest, 'choosing a mood only previews it');
assert.deepEqual(await overrides(), beforePalette, 'and saves nothing');
assert.equal(await pageBackground(), beforeBackground, 'nor changes the page');
const useTinted = harmony.getByRole('button', { name: 'Use the tinted palette' });
await useTinted.click();
// What the site shows: a color the palette shares with the theme needs no saved value of its own.
const siteColor = (id) => frame.locator('html').evaluate((el, name) => getComputedStyle(el).getPropertyValue(name).trim().toLowerCase(), `--so-${id.replace(/[^a-zA-Z0-9]+/g, '-')}`);
await eventually(async () => {
  for (const [id, value] of Object.entries(proposed)) assert.equal(await siteColor(id), value, `${id} is the previewed color`);
});
assert.equal((await overrides())['color.background'], proposed['color.background'], 'saved as the site background');
assert.equal(await settled(), atRest + 1, 'in one step');
await eventually(async () => assert.equal(await pageBackground(), rgbOf(proposed['color.background']), 'the page shows the new background'));
await eventually(async () => assert.equal(await win.locator('.toast', { hasText: 'Your site now uses the tinted palette.' }).getByRole('button', { name: 'Undo' }).count(), 1, 'and says so, with an Undo'));
await eventually(async () => assert.equal(await useTinted.getAttribute('aria-disabled'), 'true', 'the palette in use is not offered again'));
await undo();
await eventually(async () => assert.deepEqual(await overrides(), beforePalette, 'one undo puts every color back, links included'));
await eventually(async () => assert.equal(await pageBackground(), beforeBackground, 'and the page with them'));
await eventually(async () => assert.equal(await useTinted.getAttribute('aria-disabled'), null, 'and offers the palette again'));

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\ncolors: passed');
