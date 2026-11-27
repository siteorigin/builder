// Pasted text over a field's limit is kept whole and refused beside the field, never cut short or put back (#226).
// The page description and the hero's image description count against their limits before anything is typed;
// a 342-character description and a 328-character image description pasted in stay whole, marked "Not saved", the
// toolbar says so, and nothing reaches the project. Opening another page or selection and coming back finds the
// text again. Shortened, it saves, and the canvas renders it as the page's metadata and the image's alt. Escape puts
// the saved text back; leaving with refused text asks, names the field, and reopening shows the saved text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('text-limits');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Linen Row Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'linen-row-studio');

const readJson = (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const pageDoc = (id) => readJson(`siteorigin/pages/${id}.json`);
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const inspector = () => win.locator('#dock-panel-inspect');
const status = () => win.locator('.toolbar .save-state');
/** The count a limited field shows inside itself, or the refusal under it. */
const countOf = (field) => field.locator('xpath=ancestor::span[contains(concat(" ", normalize-space(@class), " "), " field-counted ")][1]').locator('.field-count');
/** Text of exactly `n` characters, ending a sentence, like copy pasted from elsewhere. */
const sentence = (n) => 'Calm, practical rooms with oak, linen and clay, planned around how you live. '.repeat(10).slice(0, n - 1) + '.';
/** Replace a field's text the way a paste does: one insertion, whatever its length. */
const paste = async (field, text) => {
  await field.click();
  await field.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await win.keyboard.insertText(text);
};
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const openPage = async (title, route) => {
  await openRail('Pages');
  await win.locator('.pages-list [role="option"]', { hasText: title }).first().click();
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), new RegExp(title), `${title} is open`));
  await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), route, `the canvas shows ${route}`), 30000);
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
};
const description = () => inspector().getByRole('textbox', { name: 'Description', exact: true });
const imageDescription = () => inspector().getByRole('textbox', { name: 'Image description', exact: true });
const selectHero = async () => {
  await openRail('Layers');
  await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
  await imageDescription().waitFor();
};
const heroAlt = (pageId) => {
  const page = pageDoc(pageId);
  return page.rootIds.map((id) => page.nodes[id]).find((n) => n.kind === 'instance' && n.props && 'image' in n.props && 'heading' in n.props).props.image.alt;
};

const s0 = await snapshot();
const [homeId, aboutId] = s0.state.site.pageOrder;
const savedAbout = pageDoc(aboutId).seo?.description ?? '';
const savedAlt = heroAlt(homeId);
const long = sentence(342);
const longAlt = sentence(328);

step('the page description shows its limit before anything is typed');
await openPage('About', '/about/');
await description().waitFor();
assert.equal(await countOf(description()).innerText(), `${savedAbout.length} / 320`, 'the count is there before typing');

step('a pasted 342-character description stays whole, refused beside the field, and nothing is saved');
await paste(description(), long);
assert.match(await countOf(description()).innerText(), /^342 \/ 320\. Shorten it by 22 characters to save it\.$/, 'the count turns into what to do while typing');
await win.keyboard.press('Tab');
await eventually(async () => assert.equal(await countOf(description()).innerText(), 'Not saved: 342 / 320 characters. Shorten it by 22 characters to save it.'));
// Long after the saved text would have been put back, the pasted text is still there, whole.
await win.waitForTimeout(1200);
assert.equal(await description().inputValue(), long, 'the field keeps all 342 characters');
assert.equal(await description().getAttribute('aria-invalid'), 'true');
assert.equal(await status().innerText(), 'Not saved', 'the toolbar never says saved over refused text');
assert.equal(pageDoc(aboutId).seo?.description ?? '', savedAbout, 'the project keeps the saved description');
await win.screenshot({ path: join(SHOTS, 'text-limits-description.png') });

step('opening Contact and coming back finds the refused description again');
await openPage('Contact', '/contact/');
await description().waitFor();
const contactId = s0.state.site.pageOrder.find((id) => s0.state.pages[id].title === 'Contact');
assert.equal(await description().inputValue(), pageDoc(contactId).seo?.description ?? '', 'Contact shows its own saved description');
assert.equal(await status().innerText(), 'Not saved', 'still not saved while another page is open');
await openPage('About', '/about/');
await eventually(async () => assert.equal(await description().inputValue(), long, 'the draft came back whole'));
assert.match(await countOf(description()).innerText(), /^Not saved: 342 \/ 320/);

step('shortened, it saves, and the page renders it as its description');
const short = long.slice(0, 319) + '.';
await paste(description(), short);
await win.keyboard.press('Tab');
await eventually(() => assert.equal(pageDoc(aboutId).seo.description, short, 'the shortened description is on disk'));
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));
assert.equal(await countOf(description()).innerText(), '320 / 320');
await eventually(async () => assert.equal(await frame.locator('head meta[name="description"]').getAttribute('content'), short, 'the canvas renders the saved description'), 30000);
assert.equal(await frame.locator('head meta[property="og:description"]').getAttribute('content'), short);

step('a pasted 328-character image description in the Home hero stays whole and refused');
await openPage('Home', '/');
await selectHero();
assert.equal(await countOf(imageDescription()).innerText(), `${savedAlt.length} / 300`, 'the image description shows its limit');
await paste(imageDescription(), longAlt);
await win.keyboard.press('Tab');
await eventually(async () => assert.equal(await countOf(imageDescription()).innerText(), 'Not saved: 328 / 300 characters. Shorten it by 28 characters to save it.'));
await win.waitForTimeout(1200);
assert.equal(await imageDescription().inputValue(), longAlt, 'no sentence is lost');
assert.equal(heroAlt(homeId), savedAlt, 'the saved image description is unchanged, not its first 300 characters');
assert.equal(await status().innerText(), 'Not saved');

step('selecting something else and coming back finds it again');
await openRail('Layers');
await win.locator('.list-item', { hasText: 'Logo strip' }).first().click();
await eventually(async () => assert.equal(await imageDescription().count(), 0, 'another section is shown'));
await selectHero();
await eventually(async () => assert.equal(await imageDescription().inputValue(), longAlt));

step('shortened, the image description saves and the canvas renders it as the alt');
const shortAlt = longAlt.slice(0, 299) + '.';
await paste(imageDescription(), shortAlt);
await win.keyboard.press('Tab');
await eventually(() => assert.equal(heroAlt(homeId), shortAlt, 'the shortened image description is on disk'));
await eventually(async () => assert.equal(await frame.locator('main img').first().getAttribute('alt'), shortAlt, 'the canvas image has the whole alt'), 30000);
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));

step('Escape puts the saved text back');
await paste(imageDescription(), sentence(330));
await win.keyboard.press('Tab');
await eventually(async () => assert.match(await countOf(imageDescription()).innerText(), /^Not saved/));
await imageDescription().click();
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await imageDescription().inputValue(), shortAlt, 'the saved text is back'));
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));
assert.equal(heroAlt(homeId), shortAlt);

step('leaving with a refused description asks, names it, and reopening shows what was saved');
await openPage('About', '/about/');
await paste(description(), long);
await win.keyboard.press('Tab');
await eventually(async () => assert.equal(await status().innerText(), 'Not saved'));
// Another page is open when the project closes: the refused text is still reported.
await openPage('Contact', '/contact/');
const dialog = win.getByRole('dialog', { name: 'Leave without your last change?' });
const closing = win.evaluate(() => window.builder.projects.close());
await dialog.waitFor();
assert.match(await dialog.innerText(), /What you typed in Description is 342 characters, longer than the 320 allowed, so it has not been saved\./);
await dialog.getByRole('button', { name: 'Leave without it' }).click();
await closing;
await win.waitForSelector('.welcome');
assert.equal(pageDoc(aboutId).seo.description, short, 'the saved description is on disk');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(reopened.ok, `the project reopens: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
await openPage('About', '/about/');
await eventually(async () => assert.equal(await description().inputValue(), short, 'the saved description is shown'));
assert.equal(await countOf(description()).innerText(), '320 / 320');
assert.equal(await status().innerText(), 'Saved');
const reopenedFrame = win.frameLocator('.frame-box iframe');
await eventually(async () => assert.equal(await reopenedFrame.locator('head meta[name="description"]').getAttribute('content'), short, 'the reopened canvas renders the saved description'), 60000);
await openPage('Home', '/');
await selectHero();
assert.equal(await imageDescription().inputValue(), shortAlt);

step('refused text for a page that is then removed goes, offered to copy');
const added = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'page.create', title: 'Studio notes', route: '/studio-notes/', starter: 'intro' }] }, { label: 'Add page' }));
assert.ok(added.ok, JSON.stringify(added));
const notesId = added.results[0].pageId;
await openPage('Studio notes', '/studio-notes/');
await paste(description(), long);
await win.keyboard.press('Tab');
await eventually(async () => assert.equal(await status().innerText(), 'Not saved'));
await openPage('Home', '/');
const removed = await win.evaluate((id) => window.builder.project.apply({ operations: [{ type: 'page.remove', pageId: id }] }, { label: 'Remove page' }), notesId);
assert.ok(removed.ok, JSON.stringify(removed));
const goneToast = win.locator('.toast', { hasText: 'What you typed in Description was not saved, and what it belonged to has been removed.' });
await goneToast.waitFor();
assert.equal(await goneToast.getByRole('button', { name: 'Copy text' }).count(), 1, 'the text is offered to copy');
await eventually(async () => assert.equal(await status().innerText(), 'Saved', 'nothing is left open for a page that has gone'));

step('a new page title over the limit is kept whole in the Add page form, with the reason');
await openRail('Pages');
await win.getByRole('button', { name: 'Add page' }).first().click();
const newTitle = win.getByRole('textbox', { name: 'New page title' });
await newTitle.waitFor();
await newTitle.click();
await win.keyboard.insertText(sentence(92));
assert.equal(await newTitle.inputValue(), sentence(92), 'the pasted title is whole');
assert.equal(await win.locator('#pages-add-title-note').innerText(), '92 / 80. Shorten it by 12 characters to save it.');
assert.equal(await win.locator('.pages-add-actions .btn-primary').isDisabled(), true, 'Add page waits for a title that fits');
const pagesBefore = (await snapshot()).state.site.pageOrder.length;
await win.keyboard.press('Enter');
await win.waitForTimeout(600);
assert.equal((await snapshot()).state.site.pageOrder.length, pagesBefore, 'Enter adds nothing either');
await win.locator('.pages-add-actions .btn-ghost').click();

step('an inline rename over the limit keeps the old title and hands the whole text to the page’s Title field');
const aboutTitle = pageDoc(aboutId).title;
const longTitle = sentence(92);
await win.locator('.pages-list [role="option"]', { hasText: 'About' }).first().click();
await win.keyboard.press('F2');
const rename = win.locator('.pages-rename');
await rename.waitFor();
await win.keyboard.insertText(longTitle);
assert.equal(await rename.inputValue(), longTitle, 'the rename takes the whole pasted title');
await win.keyboard.press('Enter');
await win.locator('.toast', { hasText: 'A page title can be up to 80 characters, and this one is 92' }).waitFor();
const titleField = inspector().getByRole('textbox', { name: 'Title', exact: true });
await eventually(async () => assert.equal(await titleField.inputValue(), longTitle, 'the Title field shows the whole text'));
assert.equal(await countOf(titleField).innerText(), 'Not saved: 92 / 80 characters. Shorten it by 12 characters to save it.');
assert.equal(await status().innerText(), 'Not saved');
assert.equal(pageDoc(aboutId).title, aboutTitle, 'the old title is kept');
await paste(titleField, longTitle.slice(0, 79) + '.');
await win.keyboard.press('Tab');
await eventually(() => assert.equal(pageDoc(aboutId).title, longTitle.slice(0, 79) + '.', 'shortened, the title saves'));
await eventually(async () => assert.equal(await status().innerText(), 'Saved'));

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\ntext-limits: passed');
