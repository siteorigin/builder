// Site details checks Public URL and Language as they are typed (#32): text the project can't take stays in the
// field as an unsaved draft, with the reason and the value still saved beside it, until it is corrected (Add
// https:// for a host name typed on its own), saved or discarded with Escape. Nothing invalid reaches the project,
// a closed section keeps the draft, and leaving the project with one asks first and Keep editing returns to it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('site-details');
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
const details = () => win.locator('#dock-panel-styles .section').filter({ has: head() });
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

step('a host name typed without https:// stays in the field, unsaved, with the reason and a fix beside it');
await input('Public URL').fill('kloof.example');
await input('Public URL').press('Tab');
await afterRevert();
assert.equal(await input('Public URL').inputValue(), 'kloof.example', 'what was typed is still in the field');
assert.equal(await input('Public URL').getAttribute('aria-invalid'), 'true', 'the field is marked invalid');
assert.match(await error('Public URL').innerText(), /Start the public URL with https:\/\/, as in https:\/\/kloof\.example\./);
assert.match(await error('Public URL').innerText(), /Not saved\. Nothing is saved here yet\./, 'the field says nothing is saved yet');
const describedBy = await input('Public URL').getAttribute('aria-describedby');
assert.equal(await error('Public URL').getAttribute('id'), describedBy, 'the reason describes the field');
assert.equal(await status().innerText(), 'Unsaved change', 'the toolbar does not claim the change is saved');
assert.equal(site().baseUrl, undefined, 'nothing invalid was saved');

step('Add https:// saves the address it offers and clears the reason');
await field('Public URL').getByRole('button', { name: 'Add https://' }).click();
await eventually(() => assert.equal(site().baseUrl, 'https://kloof.example', 'the corrected address is on disk'));
await eventually(async () => assert.equal(await error('Public URL').count(), 0, 'the reason has gone'));
assert.equal(await input('Public URL').inputValue(), 'https://kloof.example');
assert.equal(await focused('Public URL'), true, 'focus stays with the field');
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

step('a closed Site details section keeps the draft and its reason');
await head().click();
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

step('leaving the project with a refused draft asks first, and Keep editing opens the section and returns to it');
await input('Language').fill('English');
await input('Language').press('Tab');
await afterRevert();
await head().click();
assert.equal(await head().getAttribute('aria-expanded'), 'false', 'the section is closed');
await menu('Close Project');
const dialog = win.getByRole('dialog', { name: 'Leave without your last change?' });
await dialog.waitFor();
assert.match(await dialog.innerText(), /Language/, 'the question names the field');
await win.waitForTimeout(400);
await dialog.getByRole('button', { name: 'Keep editing' }).click();
await eventually(async () => assert.equal(await focused('Language'), true, 'focus is back in the Language field'));
assert.equal(await head().getAttribute('aria-expanded'), 'true', 'the section opened to show it');
assert.equal(await input('Language').inputValue(), 'English', 'what was typed is still there');
assert.match(await error('Language').innerText(), /Language must be a code/);
assert.equal(await win.locator('.editor').count(), 1, 'the project stayed open');

step('Leave without it closes the project with the saved settings untouched');
await menu('Close Project');
await dialog.waitFor();
await dialog.getByRole('button', { name: /Leave without/ }).click();
await win.waitForSelector('.welcome');
assert.equal(site().language, language);
assert.equal(site().baseUrl, 'https://studio.example/studio');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nsite-details: all checks passed');
