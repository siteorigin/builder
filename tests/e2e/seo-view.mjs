// The SEO view (#700): a rail entry opens a workspace in the canvas's place, listing every page in the site's page order
// and every post by collection, drafts included. Choosing one shows it as the view's document. The canvas stays loaded
// underneath, out of reach: no key acts on what is selected there, the toolbar and the Inspector name the view, and
// leaving it (the rail entry again, another panel, the sidebar shortcut) brings the canvas back as it was. The chosen
// document survives switching away and back, falls back cleanly when it is deleted, and no window is ever shown.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('seo-view');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Riverside Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  assert.ok(r.ok, `${label}: ${JSON.stringify(r.error ?? r)}`);
};
const rail = (id) => win.locator(`.rail [data-rail="${id}"]`);
const holder = win.locator('.seo-view-holder');
const view = win.getByRole('region', { name: 'SEO view' });
const panel = win.locator('.seo-panel');
const inspector = win.locator('#dock-panel-inspect');
const inspected = inspector.locator('.insp-name h3');
const placeShown = win.locator('.toolbar .project-title .page');
const canvasInert = () => win.locator('.canvas-holder').evaluate((el) => el.hasAttribute('inert'));
/** No window of the app is shown or focused: the run is headless throughout. */
const noWindowShown = async (where) => {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length > 0 && windows.every((w) => !w.visible), `${where}: no window is shown (${JSON.stringify(windows)})`);
};

step('a blog with a published post and a draft');
await apply(
  [
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' }
  ],
  'Add posts'
);
const s0 = (await snapshot()).state;
const home = s0.pages[s0.site.homePageId];
const about = Object.values(s0.pages).find((p) => p.title === 'About');
assert.ok(about, 'the starter has an About page');

step('a section of Home selected, with the preview marked so a reload would show');
await rail('layers').click();
await win.locator(`[role="tree"] [role="treeitem"][data-owner="page:${home.id}"]`).first().click();
await openInspector(win);
const sectionName = await eventually(async () => {
  const t = await inspected.innerText();
  assert.ok(t && t !== home.title, `the Inspector shows the section: ${t}`);
  return t;
});
assert.equal(await placeShown.innerText(), home.title, 'the toolbar names Home');
const crumbs = win.locator('nav.crumbs');
assert.equal(await crumbs.count(), 1, 'the status bar leads to the section');
await frame.locator('html').evaluate(() => (window.__seoViewMark = 'kept'));
const frameKept = () => frame.locator('html').evaluate(() => window.__seoViewMark === 'kept');

step('the rail entry opens the SEO view over the canvas, which stays loaded out of reach');
assert.equal(await rail('seo').getAttribute('aria-label'), 'SEO');
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true, 'the view has the canvas’s place'));
assert.equal(await rail('seo').getAttribute('aria-pressed'), 'true');
assert.equal(await canvasInert(), true, 'the canvas under it takes no input');
assert.equal(await view.locator('.seo-title').innerText(), 'SEO');
assert.match(await view.innerText(), /Choose a page or post/, 'nothing is chosen yet');
await eventually(async () => assert.equal(await placeShown.innerText(), 'SEO', 'the toolbar names the view'));
await eventually(async () => assert.equal(await inspected.innerText(), 'SEO', 'and so does the Inspector'));
assert.equal(await inspector.locator('input, textarea, select, [contenteditable="true"]').count(), 0, 'nothing in the Inspector changes the page under the view');
assert.ok(!(await inspector.innerText()).includes(sectionName), 'Home’s section is out of the Inspector');
for (const name of ['Desktop', 'Tablet', 'Phone', 'Edit', 'Preview']) assert.equal(await win.getByRole('button', { name, exact: true }).isDisabled(), true, `${name} waits while the view covers the canvas`);
assert.equal(await crumbs.count(), 0, 'no path in the status bar leads to the section under the view');
await noWindowShown('opening the view');

step('the list: pages in the site’s page order, then posts by collection, drafts included');
const groups = await panel.locator('.seo-group').evaluateAll((els) =>
  els.map((g) => ({ head: g.querySelector('.seo-group-head')?.textContent, rows: [...g.querySelectorAll('.seo-open')].map((b) => ({ title: b.querySelector('.seo-row-title')?.textContent, address: b.querySelector('.seo-row-address')?.textContent, draft: !!b.querySelector('.badge') })) }))
);
assert.deepEqual(
  groups.map((g) => g.head),
  ['Pages', 'Posts']
);
assert.deepEqual(
  groups[0].rows.map((r) => r.title),
  s0.site.pageOrder.map((id) => s0.pages[id].title),
  'the pages follow the site’s page order'
);
assert.equal(groups[0].rows[s0.site.pageOrder.indexOf(home.id)].address, '/', 'Home is at /');
assert.deepEqual(groups[1].rows, [
  { title: 'Spring open studio', address: '/blog/spring-open-studio/', draft: false },
  { title: 'Winter hours', address: '/blog/winter-hours/', draft: true }
]);

step('no key acts on the section selected under the view');
const homeNodes = async () => {
  const pg = (await snapshot()).state.pages[home.id];
  return JSON.stringify({ rootIds: pg.rootIds, nodes: pg.nodes });
};
const homeBefore = await homeNodes();
await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
await win.keyboard.press('Backspace');
await win.keyboard.press(`${MOD}+d`);
await win.keyboard.press(`${MOD}+Shift+ArrowDown`);
await win.keyboard.press('Escape');
await win.waitForTimeout(800);
assert.equal(await homeNodes(), homeBefore, 'Home keeps its sections, in their order');
assert.equal(await holder.isVisible(), true, 'and Escape leaves the view open');

step('choosing a page, then a draft post, shows each as the view’s document');
const row = (title) => panel.locator('.seo-open', { hasText: title }).first();
await row('About').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'About'));
assert.equal(await view.locator('.seo-address').innerText(), about.route);
assert.equal(await row('About').getAttribute('aria-current'), 'true');
await eventually(async () => assert.equal(await inspected.innerText(), 'About', 'the Inspector names the chosen page'));
assert.equal(await placeShown.innerText(), 'SEO', 'the toolbar still names the view, never the page under it');
await row('Winter hours').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
assert.equal(await view.locator('.seo-address').innerText(), '/blog/winter-hours/');
assert.match(await view.innerText(), /draft is left out of the website/i);
assert.equal(await row('About').getAttribute('aria-current'), null, 'one document is chosen at a time');
await win.screenshot({ path: join(SHOTS, 'seo-view.png') });

step('the rail entry again leaves the view: the canvas is back as it was, the same preview and the same selection');
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), false, 'the view goes'));
assert.equal(await canvasInert(), false, 'the canvas takes input again');
assert.equal(await frameKept(), true, 'the preview was never reloaded');
await eventually(async () => assert.equal(await inspected.innerText(), sectionName, 'Home’s section is still selected'));
assert.equal(await placeShown.innerText(), home.title, 'and the toolbar names Home');
assert.equal(await win.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), false, 'the mode can change again');
assert.equal(await crumbs.count(), 1, 'and the status bar leads to the section again');

step('the chosen document survives switching away and back, and another panel leaves the view too');
await rail('seo').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours', 'the view opens on the post it had chosen'));
await rail('layers').click();
await eventually(async () => assert.equal(await holder.isVisible(), false, 'Layers takes the sidebar and the canvas shows'));
assert.equal(await canvasInert(), false);
await eventually(async () => assert.equal(await inspected.innerText(), sectionName));
await rail('seo').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
await win.keyboard.press(`${MOD}+\\`);
await eventually(async () => assert.equal(await holder.isVisible(), false, 'the sidebar shortcut leaves the view with the sidebar'));
assert.equal(await frameKept(), true, 'the preview is still the one it was');

step('a page chosen in the toolbar puts the view away and opens that page');
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true));
await win.locator('.toolbar .project-title').click();
const menu = win.getByRole('menu');
await menu.waitFor();
assert.equal(await menu.getByRole('menuitemradio', { checked: true }).count(), 0, 'no page is checked while the view is open');
await menu.getByRole('menuitemradio').filter({ hasText: 'About' }).first().click();
await eventually(async () => assert.equal(await holder.isVisible(), false, 'the view goes'));
await eventually(async () => assert.equal(await placeShown.innerText(), 'About', 'About is open'));
assert.equal(await rail('pages').getAttribute('aria-pressed'), 'true', 'with the Pages list beside it');

step('the chosen post deleted while the view is open: the view falls back to nothing chosen');
await rail('seo').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await apply([{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' }], 'Delete post');
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'SEO', 'the view has nothing chosen'));
assert.match(await view.innerText(), /Choose a page or post/);
assert.equal(await panel.locator('.seo-open', { hasText: 'Winter hours' }).count(), 0, 'the list no longer has it');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await panel.locator('.seo-open', { hasText: 'Winter hours' }).count(), 1, 'Undo brings the post back to the list'));
assert.equal(await view.locator('.seo-title').innerText(), 'SEO', 'without choosing it again on its own');
await noWindowShown('the end of the run');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nseo-view: passed');
