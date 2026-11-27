// Starter content (#15): a new site publishes nothing its author did not write. The Business starter's sample contact
// details are reviewed in the Export dialog before the website goes out (opened where they are, replaced everywhere
// at once, or kept on purpose) without ever stopping the export. The Blank starter's Home starts empty: the canvas
// says how to begin, in the editor only, and neither the live preview nor the exported website shows any of it. The
// Component showcase (#1020), made through the New project dialog with the sample photos, places every component the
// theme ships and exports whole.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('starter-content');
const { app, win, errors } = await launch(WORK);
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const exportDialog = win.getByRole('dialog', { name: 'Export your website' });
const find = win.getByRole('dialog', { name: 'Find and replace' });
const websiteButton = exportDialog.getByRole('button', { name: /Website files, ready to upload/ });
const openExport = async () => {
  await win.locator('.export-btn').click();
  await exportDialog.waitFor();
};
const closeDialog = async (dialog) => {
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await dialog.waitFor({ state: 'detached' });
};
/** Export the website into a new folder of its own, and return that folder. */
const exportWebsite = async (name) => {
  const into = join(WORK, 'exports', name);
  mkdirSync(into, { recursive: true });
  await app.evaluate(({ dialog }, parent) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, into);
  await websiteButton.click();
  await withTimeout(exportDialog.getByRole('status').filter({ hasText: /^Exported \d+ page/ }).waitFor({ timeout: 300000 }), 310000, `the ${name} export`);
  const [folder] = readdirSync(into);
  assert.ok(folder, `the ${name} export wrote the website`);
  return join(into, folder);
};
/** Replace the sample a Find dialog opened for, in every place it lists. */
const replaceAll = async (replacement, count) => {
  await find.getByTestId('find-sample-note').waitFor();
  await find.locator('.modal-foot .btn-primary').click();
  await find.getByLabel('Replace with').fill(replacement);
  await find.getByRole('button', { name: `Replace ${count} matches` }).click();
  await find.getByRole('status').filter({ hasText: `Replaced ${count} matches` }).waitFor({ timeout: 10000 });
  await closeDialog(find);
};

try {
  step('Business: the Export dialog reviews the sample contact details, and the export stays available');
  await createProject(win, { name: 'Kloof Interiors', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  await openExport();
  const review = exportDialog.getByTestId('export-sample-contacts');
  await review.waitFor();
  const email = review.getByTestId('export-sample-email');
  const phone = review.getByTestId('export-sample-phone');
  const address = review.getByTestId('export-sample-address');
  assert.match(await email.innerText(), /hello@example\.com · 5 places on Contact and the shared footer/);
  assert.match(await phone.innerText(), /\+1 555 0134 · 4 places on Contact and the shared footer/);
  assert.match(await address.innerText(), /12 Harbor Lane, Millbrook · 1 place on Contact/);
  assert.equal(await review.evaluate((el) => !!el.closest('[role="alert"]')), false, 'a review, not an error');
  assert.equal(await websiteButton.getAttribute('aria-disabled'), null, 'the review never stops the website export');
  assert.equal(await websiteButton.isDisabled(), false, 'the website export can be started while details are under review');
  // Exported as it is, the Contact page sends enquiries to the sample address, as reported.
  const asStarted = await exportWebsite('business-as-started');
  assert.equal((readFileSync(join(asStarted, 'contact', 'index.html'), 'utf8').match(/mailto:hello@example\.com/g) ?? []).length, 3, 'the export went ahead with the details under review');
  await closeDialog(exportDialog);

  step('Keep it sets aside one detail, listed beside the ones still under review');
  await openExport();
  await address.getByRole('button', { name: 'Keep it' }).click();
  await address.waitFor({ state: 'detached' });
  const kept = exportDialog.getByTestId('export-samples-kept');
  assert.match(await kept.innerText(), /12 Harbor Lane, Millbrook is kept as you chose\./);
  assert.equal(await email.count() + (await phone.count()), 2, 'the email and number are still under review');

  step('Show where lists each place, and Open goes to that field in the inspector');
  await email.getByRole('button', { name: 'Show where' }).click();
  const places = email.locator('.export-samples-places li span');
  assert.deepEqual(await places.allInnerTexts(), [
    'Contact › Contact details › Action link',
    'Contact › Contact details › Contact methods › Email › Value',
    'Contact › Contact details › Contact methods › Email › Link',
    'Shared footer › Contact links › hello@example.com › Label',
    'Shared footer › Contact links › hello@example.com › Destination'
  ]);
  await email.getByRole('button', { name: 'Open Contact › Contact details › Action link in the inspector' }).click();
  await exportDialog.waitFor({ state: 'detached' });
  await eventually(async () => {
    const focused = await win.evaluate(() => {
      const el = document.activeElement;
      return el?.closest('#dock-panel-inspect') ? { value: el.value, field: el.closest('[data-field]')?.getAttribute('data-field') } : null;
    });
    assert.deepEqual(focused, { value: 'hello@example.com', field: 'actionLink' }, 'the action link’s address is focused in the inspector');
  });
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), /Contact/, 'the Contact page is open'));

  step('Replace everywhere changes the email in all five places, and the number as written and as dialled');
  await openExport();
  await email.getByRole('button', { name: 'Replace everywhere…' }).click();
  await replaceAll('studio@kloof.example', 5);
  await openExport();
  assert.equal(await email.count(), 0, 'the email is no longer reviewed');
  await phone.getByRole('button', { name: 'Replace everywhere…' }).click();
  await replaceAll('+27 21 555 0199', 4);

  step('a kept detail can be reviewed again, and kept again');
  await openExport();
  await kept.waitFor();
  assert.equal(await review.count(), 0, 'nothing else is under review');
  await kept.getByRole('button', { name: 'Review it again' }).click();
  await address.waitFor();
  await address.getByRole('button', { name: 'Keep it' }).click();
  await review.waitFor({ state: 'detached' });
  await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.textContent?.trim()), 'Review it again', 'focus moves to what took the kept detail’s place'));
  await closeDialog(exportDialog);
  await openExport();
  await kept.waitFor();
  assert.equal(await review.count(), 0, 'a kept detail stays kept when the dialog opens again');
  await closeDialog(exportDialog);
  // The project remembers it: closed and opened again, the detail is still kept.
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  const reopened = await win.evaluate((d) => window.builder.projects.open(d), join(WORK, 'sites', 'kloof-interiors'));
  assert.ok(reopened.ok, `the project reopens: ${JSON.stringify(reopened)}`);
  await win.waitForSelector('.editor');
  await openExport();
  await kept.waitFor();
  assert.equal(await review.count(), 0, 'a kept detail stays kept when the project opens again');

  step('the exported Contact page sends enquiries to the new details');
  const business = await exportWebsite('business');
  const contact = readFileSync(join(business, 'contact', 'index.html'), 'utf8');
  assert.ok(!contact.includes('hello@example.com') && !contact.includes('15550134') && !contact.includes('555 0134'), 'no sample email or number is left');
  assert.equal((contact.match(/mailto:studio@kloof\.example/g) ?? []).length, 3, 'the details, the action and the footer all send to the new address');
  assert.equal((contact.match(/tel:\+27215550199/g) ?? []).length, 2, 'the details and the footer dial the new number');
  await closeDialog(exportDialog);

  step('Blank: Home starts empty, and only the editor says how to begin');
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  const frame = await createProject(win, { name: 'Second Shelf', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
  const card = win.getByTestId('canvas-empty-page');
  await card.waitFor({ timeout: 30000 });
  assert.match(await card.innerText(), /This page has no sections yet/);
  // The card sits where the page's sections will go: under the shared header, and above the shared footer.
  await eventually(async () => {
    // Read inside the page, then placed through the zoomed frame: boundingBox() leaves the zoom out.
    const shown = await win.locator('iframe[title="Website preview"]').evaluate((el) => ({ y: el.getBoundingClientRect().y, zoom: el.getBoundingClientRect().width / el.offsetWidth }));
    const onScreen = (y) => shown.y + y * shown.zoom;
    const headerEnd = onScreen(await frame.locator('header').first().evaluate((el) => el.getBoundingClientRect().bottom));
    const footerStart = onScreen(await frame.locator('footer').last().evaluate((el) => el.getBoundingClientRect().top));
    const note = await card.boundingBox();
    assert.ok(headerEnd <= note.y && note.y + note.height <= footerStart, `the card is between the header and footer: ${JSON.stringify({ shown, headerEnd, note, footerStart })}`);
  });
  await win.screenshot({ path: join(SHOTS, 'blank-empty-page.png') });
  const leftovers = ['Select this text', 'Insert panel', 'A short sentence', 'example.com', '555 0134', '15550134', 'Harbor Lane', 'no sections yet', 'Visitors never see'];
  const live = await frame.locator('body').innerText();
  for (const t of leftovers) assert.ok(!live.includes(t), `the live preview does not show “${t}”: ${live}`);
  assert.match(live, /Second Shelf/, 'the header and footer show the site’s name');

  step('Preview shows the page as visitors get it, without the note');
  await win.getByRole('radio', { name: 'Preview', exact: true }).click();
  await win.getByRole('group', { name: 'Preview', exact: true }).waitFor();
  assert.equal(await card.count(), 0, 'the note is for editing only');
  await win.getByRole('group', { name: 'Preview', exact: true }).getByRole('button', { name: 'Back to editing' }).click();
  await card.waitFor();

  step('Add a section opens Insert, and the first section placed takes the note’s place');
  await card.getByRole('button', { name: 'Add a section' }).click();
  const search = win.locator('.side-panel-view:not([hidden])').getByRole('combobox', { name: 'Search items to add' });
  const searching = () => eventually(async () => assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'focus is in Insert’s search'));
  await searching();
  // With Insert already open, the card's button still returns to search.
  await card.getByRole('button', { name: 'Add a section' }).click();
  await searching();
  await win.locator('.side-panel-view:not([hidden]) .insert-tile.section').first().click();
  await card.waitFor({ state: 'detached' });
  const homeId = (await snapshot()).state.site.homePageId;
  assert.equal((await snapshot()).state.pages[homeId].rootIds.length, 1, 'the section is on Home');
  await win.evaluate(() => window.builder.project.undo());
  await card.waitFor();

  step('the exported Blank website has no editing directions or sample details');
  await openExport();
  assert.equal(await exportDialog.getByTestId('export-sample-contacts').count(), 0, 'Blank has no sample contact details to review');
  const blank = await exportWebsite('blank');
  const index = readFileSync(join(blank, 'index.html'), 'utf8');
  for (const t of leftovers) assert.ok(!index.includes(t), `the exported Home does not include “${t}”`);
  assert.ok(index.includes('Second Shelf'), 'the exported Home has the site’s header and footer');
  await closeDialog(exportDialog);

  step('Component showcase: New project makes a page for each kind of component, with the sample photos');
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  await answerChoosers(app, [{ dialog: 'open', title: 'Choose where to create the project', paths: [join(WORK, 'sites')] }]);
  await win.locator('.welcome-action', { hasText: 'New project' }).click();
  const form = win.getByRole('dialog', { name: 'New project' });
  await form.waitFor();
  await eventually(async () => assert.match((await form.locator('#new-project-path .path-text').textContent()) ?? '', /[/\\]/, 'the form shows its default folder'));
  await form.getByLabel('Project name').fill('Every Part');
  await form.getByRole('radio', { name: 'Component showcase' }).click();
  await form.getByRole('button', { name: 'Choose…' }).click();
  assert.equal(await form.getByRole('switch', { name: 'Include sample images' }).getAttribute('aria-checked'), 'true', 'the showcase takes the sample photos');
  await win.screenshot({ path: join(SHOTS, 'showcase-new-project.png') });
  await form.getByRole('button', { name: 'Create project' }).click();
  await win.waitForSelector('.editor', { timeout: 180000 });
  await win.frameLocator('.frame-box iframe').locator('h1').first().waitFor({ timeout: 90000 });
  const made = (await snapshot()).state;
  const titles = made.site.pageOrder.map((id) => made.pages[id].title);
  assert.deepEqual(titles.slice(0, 10), ['Home', 'Heroes', 'Features', 'Content', 'Media', 'Proof', 'Pricing', 'Contact', 'Blog', 'Blocks']);
  const placedIds = new Set(
    [...Object.values(made.pages), made.site.shell.header, made.site.shell.footer].flatMap((t) => Object.values(t.nodes)).filter((n) => n.kind === 'instance').map((n) => made.components[n.definitionId].componentId)
  );
  assert.ok(placedIds.size >= 39, `every component is placed: ${[...placedIds].join(', ')}`);
  assert.ok(Object.keys(made.assets.assets).length >= 9, 'the sample photos are in the library');
  await win.screenshot({ path: join(SHOTS, 'showcase-editor.png') });

  step('the exported showcase has every kind page, its posts and its photos');
  await openExport();
  const showcase = await exportWebsite('showcase');
  for (const route of ['heroes', 'features', 'content', 'media', 'proof', 'pricing', 'contact', 'blog', 'blocks'])
    assert.ok(existsSync(join(showcase, route, 'index.html')), `the export has /${route}/`);
  const blog = readFileSync(join(showcase, 'blog', 'index.html'), 'utf8');
  assert.match(blog, /Notes from the studio/, 'the Blog page lists the sample posts');
  const media = readFileSync(join(showcase, 'media', 'index.html'), 'utf8');
  const photo = media.match(/src="(?:\.\.\/)*(assets\/[^"?]+\.(?:jpg|webp|avif))"/)?.[1];
  assert.ok(photo && existsSync(join(showcase, photo)), `the Media page shows a sample photo the export holds: ${photo}`);
  await closeDialog(exportDialog);

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  await app.close();
}

cleanup();
console.log('\nstarter-content: passed');
