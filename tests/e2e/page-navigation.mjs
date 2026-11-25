// Page titles, the labels visitors read, and the menu's order (#28). A page added as Lookbook with "Add to header menu"
// and renamed Portfolio from Pages offers its heading and header link, which still say Lookbook, and updates both in
// one undo step while the address stays /lookbook/. A rename from the inspector offers the same, and a label the
// author changed is left out. Moving a page in Pages leaves the header menu's order alone and says so, with a way to
// match it that keeps an external link in its place and adds no page that is not in the menu.
// The footer's links take the header menu's top-level links in one step from the inspector, and Undo gives them back.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('page-navigation');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const pageRow = (title) => win.locator('.side-panel-view:not([hidden]) .pages-list [data-page]', { hasText: title }).first();
/** The header menu as visitors read it, in the canvas. */
const menu = async () => (await frame.locator('#so-site-nav ul a').allInnerTexts()).map((t) => t.trim());
const heading = async () => (await frame.locator('main h1').first().innerText()).trim();
const offer = win.locator('.toast.rename-offer');
const pageMenu = async (title, item) => {
  await pageRow(title).click({ button: 'right' });
  await win.locator('[role="menu"]').waitFor();
  await win.getByRole('menuitem', { name: item }).click();
};
const pageByTitle = async (title) => Object.values((await snapshot()).state.pages).find((p) => p.title === title);

step('add Lookbook from Pages with Add to header menu checked');
await win.locator('.pages-head-add').click();
await win.locator('#pages-add-form input[aria-label="New page title"]').fill('Lookbook');
assert.equal(await win.getByRole('checkbox', { name: 'Add to header menu' }).isChecked(), true, 'Add to header menu starts checked');
await win.locator('#pages-add-form').getByRole('button', { name: 'Add page' }).click();
await pageRow('Lookbook').waitFor();
await eventually(async () => assert.equal(await heading(), 'Lookbook', 'the new page is open with its heading'), 60000);
await eventually(async () => assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Lookbook']), 30000);

step('rename it Portfolio from Pages: the heading and header link are offered');
await pageMenu('Lookbook', 'Rename');
await win.locator('input.pages-rename').fill('Portfolio');
await win.locator('input.pages-rename').press('Enter');
await offer.waitFor();
assert.match(await offer.innerText(), /Renamed to “Portfolio”/);
assert.match(await offer.innerText(), /These still say “Lookbook”/);
assert.match(await offer.innerText(), /The address stays \/lookbook\//);
const heading1 = offer.getByRole('checkbox', { name: 'Page introduction heading' });
const headerLink = offer.getByRole('checkbox', { name: 'Header menu link' });
assert.equal(await heading1.isChecked(), true);
assert.equal(await headerLink.isChecked(), true);
assert.equal(await offer.getByRole('checkbox').count(), 2, 'only the labels that still say Lookbook are offered');
// Nothing changes until the author answers.
assert.equal(await heading(), 'Lookbook');
assert.equal((await menu())[3], 'Lookbook');
assert.equal(await win.evaluate(() => document.activeElement?.closest('.toast') ?? null), null, 'the offer takes no focus');

step('update both: the heading and header link follow, the address stays');
await offer.getByRole('button', { name: 'Update 2 labels' }).click();
await offer.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await heading(), 'Portfolio'), 30000);
await eventually(async () => assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Portfolio']), 30000);
const portfolio = await pageByTitle('Portfolio');
assert.equal(portfolio.route, '/lookbook/', 'the address is unchanged');

step('undo takes the labels back first, then the rename');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Lookbook']), 30000);
await eventually(async () => assert.equal(await heading(), 'Lookbook'), 30000);
assert.equal((await snapshot()).state.pages[portfolio.id].title, 'Portfolio', 'the first undo leaves the new title');
// The labels say Lookbook again under the title Portfolio, but the author has answered: the offer does not come back.
assert.equal(await offer.count(), 0, 'an answered offer does not come back');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal((await snapshot()).state.pages[portfolio.id].title, 'Lookbook', 'the second undo takes the rename back'));

step('rename from the inspector, choosing only the heading');
await pageRow('Lookbook').click();
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
const titleField = win.locator('#dock-panel-inspect').getByRole('textbox', { name: 'Title', exact: true });
await titleField.fill('Gallery');
// Leaving the field for the next one commits the rename, and focus stays where the author put it.
await titleField.press('Tab');
await offer.waitFor();
assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Page address', 'focus moved on to the address');
await offer.getByRole('checkbox', { name: 'Header menu link' }).uncheck();
await offer.getByRole('button', { name: 'Update label' }).click();
await offer.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await heading(), 'Gallery'), 30000);
assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Lookbook'], 'the header link the author left out keeps its label');

step('a label the author changed is not offered, and Keep leaves the rest');
await pageRow('Gallery').click();
await pageRow('Gallery').press('F2');
await win.locator('input.pages-rename').fill('Works');
await win.locator('input.pages-rename').press('Enter');
await offer.waitFor();
// The header still says Lookbook, which is no longer the page's generated name: it is the author's.
assert.equal(await offer.getByRole('checkbox').count(), 1);
assert.equal(await offer.getByRole('checkbox', { name: 'Page introduction heading' }).count(), 1);
await offer.getByRole('button', { name: 'Keep as they are' }).click();
await offer.waitFor({ state: 'detached' });
assert.equal(await heading(), 'Gallery');

step('a site with an external link and a page outside the menu');
const s1 = await snapshot();
const header = s1.state.site.shell.header.rootIds[0];
assert.ok((await apply([{ type: 'instance.listInsert', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', index: 3, item: { label: 'Shop', link: { type: 'url', target: 'https://shop.example.com' } } }], 'Add shop link')).ok);
assert.ok((await apply([{ type: 'page.create', title: 'Notes', starter: 'intro' }], 'Add page Notes')).ok);
await pageRow('Notes').waitFor();
await eventually(async () => assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Shop', 'Lookbook']), 30000);

step('moving a page in the menu says the menu kept its order');
await pageMenu('Works', 'Move up');
const note = win.locator('.pages-order-note');
await note.waitFor();
const pagesOrder = async () => (await snapshot()).state.site.pageOrder.map((id) => s1.state.pages[id]?.title ?? 'Notes');
assert.deepEqual(await pagesOrder(), ['Home', 'About', 'Works', 'Contact', 'Notes']);
assert.match(await note.innerText(), /Moved in Pages only/);
assert.match(await note.innerText(), /Home · About · Contact · Shop · Lookbook/);
assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Shop', 'Lookbook'], 'the menu is unchanged by the move');

step('match the header menu: page links follow Pages, the external link stays, Notes stays out');
await note.getByRole('button', { name: 'Match header menu' }).click();
await note.waitFor({ state: 'detached' });
await eventually(async () => assert.deepEqual(await menu(), ['Home', 'About', 'Lookbook', 'Shop', 'Contact']), 30000);
assert.deepEqual(await pagesOrder(), ['Home', 'About', 'Works', 'Contact', 'Notes'], 'Pages is unchanged');

step('the Undo beside it takes the menu back, leaving Pages as moved');
await win.locator('.toast', { hasText: 'The header menu now lists' }).getByRole('button', { name: 'Undo' }).click();
await eventually(async () => assert.deepEqual(await menu(), ['Home', 'About', 'Contact', 'Shop', 'Lookbook']), 30000);
assert.deepEqual(await pagesOrder(), ['Home', 'About', 'Works', 'Contact', 'Notes']);

step('moving a menu page back into the menu’s order says the menu already agrees');
await pageMenu('Works', 'Move down');
await win.locator('.toast', { hasText: 'already lists these pages this way' }).waitFor();
assert.deepEqual(await pagesOrder(), ['Home', 'About', 'Contact', 'Works', 'Notes']);
assert.equal(await note.count(), 0, 'nothing to match');

step('moving a page outside the menu says the menu is unchanged');
await pageMenu('Notes', 'Move up');
await win.locator('.toast', { hasText: 'isn’t in the header menu' }).waitFor();
assert.equal(await note.count(), 0, 'no menu order to offer for a page outside the menu');

step('Copy from header menu fills the footer’s links with the header’s top-level links, and Undo brings its own back (#575)');
/** The footer's Explore links as visitors read them, in the canvas. */
const footerLinks = async () => (await frame.locator('footer:not(main footer) nav').first().locator('a').allInnerTexts()).map((t) => t.trim());
/** The shared header's and footer's stored links: label and destination of each top-level one, and every row's ID. */
const stored = async () => {
  const st = (await snapshot()).state;
  const rows = (part) => st.site.shell[part].nodes[st.site.shell[part].rootIds[0]].props.links;
  const shown = (part) => rows(part).filter((l, i) => !(i > 0 && l.sub)).map((l) => [l.label, JSON.stringify(l.link)]);
  return { header: shown('header'), footer: shown('footer'), footerIds: rows('footer').map((l) => l.id) };
};
const footerOwn = await footerLinks();
const headerNow = await menu();
const before = await stored();
assert.notDeepEqual(before.footer, before.header, 'the footer starts with links of its own');
// The canvas is scaled to fit beside the panels, so the footer is selected with a click on its site name.
await frame.locator('footer:not(main footer) p').first().dispatchEvent('click');
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
const footerList = win.locator('#dock-panel-inspect [data-list="links"]');
const copy = footerList.getByRole('button', { name: 'Copy from header menu' });
await copy.waitFor({ timeout: 10000 });
// Offered for the footer's links only, not for its contact links.
assert.equal(await win.locator('#dock-panel-inspect [data-list="contact"]').getByRole('button', { name: 'Copy from header menu' }).count(), 0);
assert.match(await footerList.locator('.insp-note', { hasText: 'Replaces' }).innerText(), new RegExp(`Replaces the ${footerOwn.length} links here`));
await copy.click();
await eventually(async () => {
  const now = await stored();
  assert.deepEqual(now.footer, now.header, 'each footer link has its header link’s label and destination');
});
await win.locator('.toast', { hasText: 'The footer now lists' }).getByRole('button', { name: 'Undo' }).waitFor();
await eventually(async () => {
  assert.equal(await copy.getAttribute('aria-disabled'), 'true', 'nothing more to copy');
  assert.equal(await footerList.locator('.insp-note', { hasText: 'already match the header menu' }).count(), 1);
});
await eventually(async () => assert.deepEqual(await footerLinks(), headerNow), 30000);
// Undo from the keyboard: the focus is on the button, not in a field.
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual(await stored(), before, 'Undo brings back the footer’s own rows, destinations and IDs'));
await eventually(async () => assert.deepEqual(await footerLinks(), footerOwn), 30000);
assert.deepEqual(await menu(), headerNow, 'the header menu is unchanged');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npage-navigation: passed');
