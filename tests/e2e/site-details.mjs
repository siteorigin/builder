// Site details checks Public URL and Language as they are typed (#32): text the project can't take stays in the
// field as an unsaved draft, with the reason and the value still saved beside it, until it is corrected (Add
// https:// for a host name typed on its own), saved or discarded with Escape. Nothing invalid reaches the project,
// a closed section keeps the draft, and leaving the project with one asks first and Keep editing returns to it.
// The favicon and the social sharing image use the library's visual picker: thumbnails, search, import and None (#34).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { answerChoosers, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('site-details');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Kloof Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'kloof-studio');
const site = () => JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));

/** Click a native menu item by its label, as choosing it in the menu bar (or its shortcut) does. */
const menu = (label) =>
  app.evaluate(({ Menu }, l) => {
    const find = (items) => {
      for (const i of items) {
        if (i.label === l) return i;
        const f = i.submenu && find(i.submenu.items);
        if (f) return f;
      }
    };
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error(`No menu item ${l}`);
    item.click();
  }, label);

const status = () => win.locator('.toolbar .save-state');
const head = () => win.locator('#dock-panel-styles button.section-head', { hasText: 'Site details' });
const details = () => win.locator('#dock-panel-styles .section').filter({ has: win.locator('button.section-head', { hasText: 'Site details' }) });
const field = (name) => details().locator('.field').filter({ has: win.locator('label', { hasText: name }) });
const input = (name) => field(name).getByRole('textbox', { name, exact: true });
const error = (name) => field(name).locator('.field-error');
const focused = (name) => input(name).evaluate((el) => el === document.activeElement);
const expand = async () => {
  if ((await head().getAttribute('aria-expanded')) !== 'true') await head().click();
};
/** Past the moment a refused field used to put its saved value back. */
const afterRevert = () => win.waitForTimeout(800);

await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await expand();
const language = site().language;
assert.equal(site().baseUrl, undefined, 'a new site has no public URL');

step('the favicon and social image are chosen from the visual picker, with a thumbnail at their own shape');
const picker = (name) => details().locator('.insp-image').filter({ has: win.locator('.insp-group-title', { hasText: new RegExp(`^${name}$`) }) });
assert.equal(await details().locator('select.select').count(), 1, 'the only select left in Site details is the text direction');
/** A small solid-colour PNG, so each import is a different picture. */
const makePng = (file, [r, g, b], w = 8, h = 8) => {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]));
  return file;
};
const imports = [makePng(join(WORK, 'sunrise.png'), [250, 160, 60]), makePng(join(WORK, 'harbour.png'), [40, 110, 200]), makePng(join(WORK, 'meadow.png'), [60, 170, 90])];
{
  // An empty library says so and offers the import, without leaving Site details.
  const box = picker('Favicon');
  await box.getByRole('button', { name: 'Choose image…' }).click();
  assert.match(await box.locator('.insp-pick').innerText(), /No images yet/, 'an empty library says so');
  for (const [n, f] of imports.entries()) {
    if (n) await box.getByRole('button', { name: 'Change…' }).click();
    await answerChoosers(app, [{ dialog: 'open', paths: [f] }]);
    const before = site().favicon;
    await box.getByRole('button', { name: 'Import…' }).click();
    await eventually(() => assert.ok(site().favicon && site().favicon !== before, 'the imported image is chosen'));
    await eventually(async () => assert.equal(await box.locator('.insp-pick').count(), 0, 'the picker closed after the import'));
  }
  await box.getByRole('button', { name: 'Remove favicon' }).click();
  await eventually(() => assert.equal(site().favicon ?? null, null, 'None again'));
}
for (const [name, key] of [['Favicon', 'favicon'], ['Social sharing image', 'socialImage']]) {
  const box = picker(name);
  assert.equal(await box.locator('.insp-image-name').innerText(), 'None', `${name} starts as None`);
  await box.getByRole('button', { name: 'Choose image…' }).click();
  const tiles = box.locator('.insp-pick-tile');
  await tiles.first().waitFor();
  assert.ok((await tiles.count()) >= 3, `the picker lists the library as tiles (${await tiles.count()})`);
  assert.ok((await tiles.first().locator('img').count()) === 1, 'each tile shows its picture');
  await box.getByRole('listbox', { name: 'Your images' }).locator('[tabindex="0"]').focus();
  await win.keyboard.press('ArrowRight');
  assert.equal(await box.locator('.insp-pick-tile').evaluateAll((els) => els.indexOf(document.activeElement)), 1, 'the arrow key moved to the second tile');
  await win.keyboard.press('Enter');
  await eventually(() => assert.ok(site()[key], `${name} saved`));
  assert.equal(await box.locator('.insp-pick').count(), 0, 'the picker closed after choosing');
  await eventually(async () => assert.equal(await box.locator('.insp-image-thumb img').evaluate((el) => el.complete && el.naturalWidth > 0), true, `${name} shows the chosen image, loaded`));
  assert.equal(await box.locator('.insp-alt, input[type="checkbox"], [role="switch"]').count(), 0, 'no description or decorative controls');
  const shape = await box.locator('.insp-image-thumb').evaluate((el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height);
  if (key === 'favicon') assert.ok(Math.abs(shape - 1) < 0.02, `the favicon preview is square (${shape})`);
  else assert.ok(Math.abs(shape - 1200 / 630) < 0.05, `the social preview is 1.91:1 (${shape})`);
  await box.getByRole('button', { name: `Remove ${name.toLowerCase()}` }).click();
  await eventually(() => assert.equal(site()[key] ?? null, null, `${name} removed (None)`));
  assert.equal(await box.locator('.insp-image-name').innerText(), 'None');
}
{
  const social = picker('Social sharing image');
  await answerChoosers(app, [{ dialog: 'open', paths: [makePng(join(WORK, 'share.png'), [200, 60, 120], 16, 8)] }]);
  await social.getByRole('button', { name: 'Choose image…' }).click();
  await social.getByRole('button', { name: 'Import…' }).click();
  await eventually(() => assert.ok(site().socialImage, 'an image imported from the picker is chosen'));
  await eventually(async () => assert.equal(await social.locator('.insp-image-thumb img').count(), 1, 'the imported image is shown'));
  await social.getByRole('button', { name: 'Remove social sharing image' }).click();
  await eventually(() => assert.equal(site().socialImage ?? null, null));
}

step('a wide logo is shown whole in the single-image picker and its preview, while a photo still fills its tile (#558)');
{
  const wordmark = join(WORK, 'wordmark.svg');
  writeFileSync(wordmark, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60" viewBox="0 0 400 60"><rect width="400" height="60" fill="none"/><text x="4" y="44" font-size="40" fill="#5d2b8a">Kloof Studio</text></svg>\n');
  const social = picker('Social sharing image');
  await answerChoosers(app, [{ dialog: 'open', paths: [wordmark] }]);
  await social.getByRole('button', { name: 'Choose image…' }).click();
  await social.getByRole('button', { name: 'Import…' }).click();
  await eventually(() => assert.ok(site().socialImage, 'the logo is chosen'));
  const fit = (loc) => loc.evaluate((el) => getComputedStyle(el).objectFit);
  await eventually(async () => assert.equal(await fit(social.locator('.insp-image-thumb img')), 'contain', 'the chosen logo preview is shown whole'));
  await social.getByRole('button', { name: 'Change…' }).click();
  const tiles = social.locator('.insp-pick-tile');
  await tiles.first().waitFor();
  const logoTile = tiles.filter({ hasText: /wordmark/i }).locator('img');
  const photoTile = tiles.filter({ hasText: /sunrise/i }).locator('img');
  assert.equal(await fit(logoTile), 'contain', 'the logo tile is shown whole');
  assert.equal(await logoTile.evaluate((el) => getComputedStyle(el).backgroundImage !== 'none'), true, 'the logo tile sits on the transparency checker');
  assert.equal(await fit(photoTile), 'cover', 'an ordinary photo still fills its tile');
  assert.equal(await photoTile.evaluate((el) => getComputedStyle(el).backgroundImage), 'none', 'an opaque photo has no checker');
  await win.keyboard.press('Escape');
  await social.getByRole('button', { name: 'Remove social sharing image' }).click();
  await eventually(() => assert.equal(site().socialImage ?? null, null));
}

step('a host name typed without https:// stays in the field, unsaved, with the reason and a fix beside it');
await input('Public URL').fill('kloof.example');
await input('Public URL').press('Tab');
await afterRevert();
assert.equal(await input('Public URL').inputValue(), 'kloof.example', 'what was typed is still in the field');
assert.equal(await input('Public URL').getAttribute('aria-invalid'), 'true', 'the field is marked invalid');
assert.match(await error('Public URL').innerText(), /Start the public URL with https:\/\/, as in https:\/\/kloof\.example\./);
assert.match(await error('Public URL').innerText(), /Not saved\. Nothing is saved here yet\./, 'the field says nothing is saved yet');
const describedBy = await input('Public URL').getAttribute('aria-describedby');
assert.ok(describedBy, 'the field is described');
assert.equal(await error('Public URL').getAttribute('id'), describedBy, 'the reason describes the field');
assert.equal(await field('Public URL').locator('[role="alert"]').count(), 1, 'the refusal is announced');
assert.equal(await status().innerText(), 'Unsaved change', 'the toolbar does not claim the change is saved');
assert.equal(site().baseUrl, undefined, 'nothing invalid was saved');
await field('Public URL').screenshot({ path: join(SHOTS, 'site-details-url-refused.png') });

step('Add https:// saves the address it offers and clears the reason');
await field('Public URL').getByRole('button', { name: 'Add https://' }).click();
await eventually(() => assert.equal(site().baseUrl, 'https://kloof.example', 'the corrected address is on disk'));
await eventually(async () => assert.equal(await error('Public URL').count(), 0, 'the reason has gone'));
assert.equal(await input('Public URL').inputValue(), 'https://kloof.example');
assert.equal(await input('Public URL').getAttribute('aria-invalid'), null, 'the field is no longer marked invalid');
assert.equal(await focused('Public URL'), true, 'focus stays with the field');
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));

step('an undo under a refused draft updates the saved value beside it, and the fix still saves');
await input('Public URL').fill('kloof.example');
await input('Public URL').press('Tab');
await afterRevert();
assert.match(await error('Public URL').innerText(), /The saved value is still https:\/\/kloof\.example\./);
await win.evaluate(() => document.activeElement?.blur());
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true, 'the project undoes the saved address');
await eventually(() => assert.equal(site().baseUrl, undefined, 'the address is undone on disk'));
await eventually(async () => assert.match(await error('Public URL').innerText(), /Nothing is saved here yet\./, 'the field says what is saved now'));
assert.equal(await input('Public URL').inputValue(), 'kloof.example', 'the refused text survived the undo');
await field('Public URL').getByRole('button', { name: 'Add https://' }).click();
await eventually(() => assert.equal(site().baseUrl, 'https://kloof.example', 'the fix is saved over the undone value'));
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));

step('a port browsers reject is named, and the saved address is kept and shown');
await input('Public URL').fill('https://example.com:65536');
await input('Public URL').press('Enter');
await afterRevert();
assert.equal(await input('Public URL').inputValue(), 'https://example.com:65536');
assert.match(await error('Public URL').innerText(), /The port 65536 is not valid\. Use a port from 1 to 65535\./);
assert.match(await error('Public URL').innerText(), /The saved value is still https:\/\/kloof\.example\./);
assert.equal(await field('Public URL').getByRole('button').count(), 0, 'no fix is offered for a wrong port');
assert.equal(site().baseUrl, 'https://kloof.example', 'the last valid address is kept');
assert.equal(await status().innerText(), 'Unsaved change');

step('a closed Site details section hides the draft and keeps it with its reason');
await head().click();
assert.equal(await input('Public URL').isVisible(), false, 'the closed section shows nothing');
await expand();
assert.equal(await input('Public URL').inputValue(), 'https://example.com:65536', 'the draft survived closing the section');
assert.match(await error('Public URL').innerText(), /port 65536/);

step('correcting the text clears the reason as it is typed, and leaving saves the address as browsers write it');
await input('Public URL').fill('https://Studio.Example/studio/');
await eventually(async () => assert.equal(await error('Public URL').count(), 0, 'the reason goes once the text can be saved'));
await input('Public URL').press('Tab');
await eventually(() => assert.equal(site().baseUrl, 'https://studio.example/studio'));
await eventually(async () => assert.equal(await input('Public URL').inputValue(), 'https://studio.example/studio', 'the field shows what was saved'));
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));

step('a language name stays as typed with the reason, and Escape discards it for the saved code');
await input('Language').fill('English');
await input('Language').press('Tab');
await afterRevert();
assert.equal(await input('Language').inputValue(), 'English');
assert.match(await error('Language').innerText(), /Language must be a code such as "en" or "en-AU"\./);
assert.match(await error('Language').innerText(), new RegExp(`The saved value is still ${language}\\.`));
assert.equal(site().language, language);
await input('Language').focus();
assert.equal(await status().innerText(), 'Unsaved change', 'returning to the field keeps it unsaved');
await input('Language').press('Escape');
await eventually(async () => assert.equal(await input('Language').inputValue(), language, 'Escape puts the saved code back'));
assert.equal(await error('Language').count(), 0);
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));

step('a language code saves');
await input('Language').fill('en-AU');
await input('Language').press('Tab');
await eventually(() => assert.equal(site().language, 'en-AU'));
assert.equal(await error('Language').count(), 0);

step('leaving the project with a refused draft asks first, and Keep editing shows Site details and returns to it');
await input('Language').fill('English');
await input('Language').press('Tab');
await afterRevert();
assert.match(await error('Language').innerText(), /The saved value is still en-AU\./);
await head().click();
assert.equal(await head().getAttribute('aria-expanded'), 'false', 'the section is closed');
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.locator('#dock-panel-inspect').waitFor();
assert.equal(await win.locator('#dock-panel-styles').isVisible(), false, 'Site styles is out of sight');
await menu('Close Project');
const dialog = win.getByRole('dialog', { name: 'Leave without your last change?' });
await dialog.waitFor();
assert.match(await dialog.innerText(), /Language/, 'the question names the field');
await win.waitForTimeout(400);
await dialog.getByRole('button', { name: 'Keep editing' }).click();
await eventually(async () => assert.equal(await focused('Language'), true, 'focus is back in the Language field'));
assert.equal(await head().getAttribute('aria-expanded'), 'true', 'the section opened to show it');
assert.equal(await input('Language').isVisible(), true, 'Site styles is shown again');
assert.equal(await input('Language').inputValue(), 'English', 'what was typed is still there');
assert.match(await error('Language').innerText(), /Language must be a code/);
assert.equal(await win.locator('.editor').count(), 1, 'the project stayed open');

step('Leave without it closes the project with the saved settings untouched');
await menu('Close Project');
await dialog.waitFor();
await dialog.getByRole('button', { name: /Leave without/ }).click();
await win.waitForSelector('.welcome');
assert.equal(site().language, 'en-AU');
assert.equal(site().baseUrl, 'https://studio.example/studio');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nsite-details: all checks passed');
