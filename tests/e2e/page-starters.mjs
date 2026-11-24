// Page starters (#512): Add page starts a page Blank, with its introduction (the default), as a Services, About,
// Contact, Pricing or FAQ page built from the theme's sections, or as a dated article. A multi-section starter is one
// undo step, header link and all. An empty page, and a page that has only its title, offer Write with AI: the AI panel
// opens about that page with the message box focused, ready for pasted copy, before a provider is connected too.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('page-starters');
let { app, win, errors } = await launch(WORK);
const allErrors = [];
try {
  let frame = await createProject(win, { name: 'Tidewater Bakery', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

  const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
  const form = win.locator('#pages-add-form');
  const startsWith = form.getByRole('combobox', { name: 'Starts with' });
  const navBox = form.getByRole('checkbox', { name: /Add to header menu/ });
  const pageRow = (title) => win.locator('.side-panel-view:not([hidden]) .pages-list [data-page]', { hasText: title }).first();
  const pageByTitle = async (title) => Object.values((await snapshot()).state.pages).find((p) => p.title === title);
  /** The page's sections, as the components they place. */
  const sectionsOf = async (title) => {
    const { state } = await snapshot();
    const page = Object.values(state.pages).find((p) => p.title === title);
    return page.rootIds.map((id) => state.components[page.nodes[id].definitionId].componentId);
  };
  const headerLinks = async () => {
    const { state } = await snapshot();
    const header = state.site.shell.header;
    return header.nodes[header.rootIds[0]].props.links.map((l) => l.label);
  };
  const addPage = async (title, starter) => {
    await win.locator('.pages-head-add').click();
    await form.getByRole('textbox', { name: /^New (page|article) title$/ }).fill(title);
    await startsWith.selectOption(starter);
    await form.getByRole('button', { name: /^Add (page|article)$/ }).click();
    await pageRow(title).waitFor();
    await form.waitFor({ state: 'detached' });
  };
  const composer = () => win.locator('.composer textarea');
  // Focused, and writable once the project's conversation has loaded.
  const composerFocused = () =>
    eventually(async () => assert.deepEqual(await win.evaluate(() => [document.activeElement === document.querySelector('.composer textarea'), document.querySelector('.composer textarea')?.readOnly]), [true, false], 'the message box has focus'));
  const chatOpen = () => eventually(async () => assert.equal(await win.locator('#dock-panel-chat').isVisible(), true, 'the AI panel is open'));
  const scopeIs = (title) => eventually(async () => assert.equal(await win.locator('.composer .scope-chip').getAttribute('aria-label'), `What the AI may change: ${title}`));
  /** Leave the AI panel for the Inspector, so the next Write with AI has to open it. */
  const leaveChat = async () => {
    if (await win.locator('#dock-tab-inspect').isVisible()) await win.locator('#dock-tab-inspect').click();
    await eventually(async () => assert.equal(await win.locator('#dock-panel-chat').isVisible(), false));
  };

  step('Add page offers every starter, with the page introduction first chosen');
  await win.locator('.pages-head-add').click();
  assert.deepEqual(await startsWith.locator('option').allInnerTexts(), ['Blank', 'Page introduction', 'Services', 'About', 'Contact', 'Pricing', 'FAQ', 'Dated article']);
  assert.equal(await startsWith.inputValue(), 'intro');
  assert.match(await form.locator('#pages-add-starter-note').innerText(), /^Page introduction$/);
  await startsWith.selectOption('services');
  assert.equal(await form.locator('#pages-add-starter-note').innerText(), 'Page introduction, Services grid, Text section', 'the note names the theme’s sections');
  assert.equal(await navBox.isChecked(), true, 'a top-level page joins the header menu');
  await startsWith.selectOption('article');
  await form.getByLabel('Publication date').waitFor();
  assert.equal(await navBox.isChecked(), false, 'an article stays out of the menu');
  assert.equal(await form.getByRole('button', { name: 'Add article' }).count(), 1);
  await startsWith.selectOption('empty');
  assert.equal(await form.getByLabel('Publication date').count(), 0);
  assert.equal(await navBox.isChecked(), true, 'a blank page joins the menu again');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await form.waitFor({ state: 'detached' });

  step('Blank makes a page with no sections, and the canvas offers Write with AI');
  await addPage('Wholesale', 'empty');
  assert.deepEqual(await sectionsOf('Wholesale'), []);
  assert.deepEqual(await headerLinks(), ['Home', 'Wholesale']);
  const card = win.getByTestId('canvas-empty-page');
  await card.waitFor({ timeout: 30000 });
  assert.deepEqual(await card.getByRole('button').allInnerTexts(), ['Add a section', 'Write with AI']);

  step('with no AI provider, Write with AI still opens a message box for the page’s copy');
  await card.getByRole('button', { name: 'Write with AI' }).click();
  await chatOpen();
  await composerFocused();
  await scopeIs('Wholesale');
  await win.keyboard.type('Cafés and restaurants can order daily.');
  assert.equal(await composer().inputValue(), 'Cafés and restaurants can order daily.', 'the copy goes straight into the box');
  await win.getByRole('button', { name: 'Connect an AI provider' }).waitFor();
  await composer().fill('');

  step('with a provider connected, Write with AI focuses the message box about the empty page');
  // A placeholder key, never sent: no message is sent in this script.
  await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-e2e-placeholder-never-sent'));
  await win.reload();
  await win.waitForSelector('.editor');
  frame = win.frameLocator('.frame-box iframe');
  await leaveChat();
  await card.waitFor({ timeout: 30000 });
  await card.getByRole('button', { name: 'Write with AI' }).click();
  await chatOpen();
  await composerFocused();
  await scopeIs('Wholesale');
  await win.keyboard.type('Order by 4pm');
  assert.equal(await composer().inputValue(), 'Order by 4pm');
  assert.equal(await win.getByRole('button', { name: 'Connect an AI provider' }).count(), 0, 'the provider is connected now');
  await composer().fill('');

  step('a page with only its introduction offers Write with AI in the strip');
  await leaveChat();
  await addPage('Our ovens', 'intro');
  assert.deepEqual(await sectionsOf('Our ovens'), ['intro.page']);
  await eventually(async () => assert.equal((await frame.locator('main h1').first().innerText()).trim(), 'Our ovens'), 30000);
  const strip = win.getByTestId('canvas-start-strip');
  await strip.waitFor({ timeout: 30000 });
  assert.match(await strip.innerText(), /Start this page/);
  await strip.getByRole('button', { name: 'Write with AI' }).click();
  await chatOpen();
  await composerFocused();
  await scopeIs('Our ovens');

  for (const [title, starter, sections] of [
    ['What we bake', 'services', ['intro.page', 'features.grid', 'content.text']],
    ['Find us', 'contact', ['intro.page', 'contact.details', 'contact.form']]
  ]) {
    step(`${starter}: the page and its sections come in one step, and one Undo takes them all away`);
    await leaveChat();
    const before = (await snapshot()).state;
    await addPage(title, starter);
    assert.deepEqual(await sectionsOf(title), sections);
    assert.equal((await headerLinks()).at(-1), title, 'the page joined the header menu');
    await eventually(async () => assert.equal((await frame.locator('main h1').first().innerText()).trim(), title), 30000);
    assert.equal(await win.getByTestId('canvas-start-strip').count(), 0, 'a built page offers no first steps');
    await win.getByRole('button', { name: `Undo Add page ${title}` }).click();
    await eventually(async () => assert.equal(await pageByTitle(title), undefined, 'the page is gone'));
    const after = (await snapshot()).state;
    assert.deepEqual(after.pages, before.pages, 'every page is as it was');
    assert.deepEqual(after.site, before.site, 'the page order and header menu are as they were');
    assert.deepEqual(Object.keys(after.components).sort(), Object.keys(before.components).sort(), 'no section stays installed');
  }

  allErrors.push(...errors);
  assert.deepEqual(allErrors, [], 'no uncaught errors in the editor');
} finally {
  await app.close();
  cleanup();
}
console.log('\npage-starters: passed');
