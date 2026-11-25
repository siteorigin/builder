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
await createProject(win, { name: 'Riverside Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

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

step('a section of Home selected, with the preview’s frame marked so a new one would show');
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
// The frame element itself, not its page: the preview's own server may reload the page (new routes for the blog),
// but a canvas taken down and put back would be a new frame.
const frameEl = win.locator('.canvas-holder .frame-box iframe');
await frameEl.evaluate((el) => (el.dataset.seoViewMark = 'kept'));
const frameKept = async () => (await frameEl.count()) === 1 && (await frameEl.evaluate((el) => el.dataset.seoViewMark === 'kept'));

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

step('the command menu offers nothing that acts on the covered canvas, and still goes to the page under the view');
await win.keyboard.press(`${MOD}+K`);
const cmdk = win.locator('.cmdk');
await cmdk.waitFor();
await win.keyboard.type('phone width');
const phoneRow = cmdk.getByRole('option', { name: /^Preview at phone width/ });
await eventually(async () => assert.equal(await phoneRow.getAttribute('aria-disabled'), 'true', 'a width waits while the view covers the canvas'));
assert.match(await phoneRow.innerText(), /Not in the SEO view/);
await cmdk.getByRole('combobox').fill('');
await eventually(async () => assert.equal(await cmdk.getByRole('option', { name: new RegExp(`^Go to ${home.title}`) }).count(), 1, 'Home, under the view, is offered to go to'));
await win.keyboard.press('Escape');
await cmdk.waitFor({ state: 'detached' });

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
assert.equal(await row('Winter hours').getAttribute('aria-current'), 'true');
await eventually(async () => assert.equal(await inspected.innerText(), 'Winter hours', 'the Inspector names the chosen post'));
// The list is one Tab stop, on the chosen row; the arrow keys move between rows across the groups, and Enter chooses.
assert.deepEqual(await panel.locator('.seo-open[tabindex="0"]').allInnerTexts().then((t) => t.map((x) => x.split('\n')[0])), ['Winter hours'], 'the chosen row is the list’s Tab stop');
await row('Winter hours').focus();
await win.keyboard.press('ArrowUp');
await eventually(async () => assert.equal(await row('Spring open studio').evaluate((el) => el === document.activeElement), true, 'Up goes to the row above'));
await win.keyboard.press('Home');
await eventually(async () => assert.equal(await panel.locator('.seo-open').first().evaluate((el) => el === document.activeElement), true, 'Home goes to the first page'));
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), s0.pages[s0.site.pageOrder[0]].title, 'Enter chooses it'));
await row('Winter hours').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await win.screenshot({ path: join(SHOTS, 'seo-view.png') });

step('the chosen document’s previews at the view’s width: each surface for a page and a post, from the surface selector (#701)');
await apply(
  [
    { type: 'site.update', baseUrl: 'https://riverside.example' },
    { type: 'page.update', pageId: about.id, seoTitle: 'About the studio · Riverside', description: 'A pottery studio by the river, with wheel and hand-building classes for every level.' },
    { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: 'Spring open studio at Riverside', description: 'Throw, glaze and fire with us at the spring open studio, with free taster sessions all weekend.' }
  ],
  'Search settings'
);
const surface = (name) => view.getByRole('tab', { name, exact: true });
const surfaceShown = async (name) => (await surface(name).getAttribute('aria-selected')) === 'true';
const result = (device) => view.locator(`.serp-${device}`);
const card = view.locator('.share-card');
const graphShown = view.getByTestId('seo-graph');
/** Nothing in the view scrolls sideways: not the view, not the computer's result. */
const noSidewaysScroll = async (where) => {
  const widths = await view.evaluate((el) => [el.querySelector('.seo-scroll'), el.querySelector('.serp-frame-desktop')].map((n) => (n ? { scroll: n.scrollWidth, client: n.clientWidth } : null)));
  for (const w of widths) assert.ok(w && w.scroll <= w.client, `${where}: nothing scrolls sideways (${JSON.stringify(widths)})`);
};
const documents = [
  { title: 'About', seoTitle: 'About the studio · Riverside', description: 'A pottery studio by the river', url: `https://riverside.example${about.route}`, trail: `riverside.example › ${about.route.split('/').filter(Boolean).join(' › ')}` },
  { title: 'Spring open studio', seoTitle: 'Spring open studio at Riverside', description: 'Throw, glaze and fire with us', url: 'https://riverside.example/blog/spring-open-studio/', trail: 'riverside.example › blog › spring-open-studio' }
];
for (const d of documents) {
  await row(d.title).click();
  await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), d.title));
  // Each document opens on its search result, whatever surface the one before was left on.
  await eventually(async () => assert.equal(await surfaceShown('Search result'), true, `${d.title} opens on its search result`));
  assert.equal(await graphShown.count(), 0, 'the structured data is not worked out while another surface shows');
  await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), d.seoTitle, `${d.title}’s result on a computer`));
  assert.equal(await result('mobile').locator('.serp-title').innerText(), d.seoTitle, `${d.title}’s result on a phone`);
  assert.ok((await result('desktop').locator('.serp-desc').innerText()).includes(d.description), `${d.title}’s description`);
  assert.equal(await result('desktop').locator('.serp-url').innerText(), d.trail, `${d.title}’s address`);
  await noSidewaysScroll(`${d.title}’s search result`);
  await surface('Link preview').click();
  await eventually(async () => assert.equal(await card.locator('.share-card-host').innerText(), 'riverside.example', `${d.title}’s link preview`));
  assert.ok((await card.locator('.share-card-desc').innerText()).includes(d.description), `${d.title}’s card carries its description`);
  assert.ok((await card.locator('.share-card-title').innerText()).trim(), `${d.title}’s card has a title`);
  await surface('Structured data').click();
  await eventually(async () => {
    const node = JSON.parse(await graphShown.innerText())['@graph'].find((n) => n['@type'] === 'WebPage' || n['@type'] === 'AboutPage');
    assert.equal(node?.url, d.url, `${d.title}’s structured data names its address`);
  }, 20000);
}
await win.screenshot({ path: join(SHOTS, 'seo-view-structured-data.png') });
// Back to the page: its search result, never the post's preview or surface.
await row('About').click();
await eventually(async () => assert.equal(await surfaceShown('Search result'), true, 'About opens on its search result again'));
assert.equal(await result('desktop').locator('.serp-title').innerText(), documents[0].seoTitle);
assert.equal(await graphShown.count(), 0);
// A draft is left out of the website: its structured data says so.
await row('Winter hours').click();
await eventually(async () => assert.match(await view.innerText(), /draft is left out of the website/i));
await surface('Structured data').click();
await eventually(async () => assert.ok((await view.locator('.seo-graph-none').innerText()).trim(), 'the draft’s structured data says why it has none'));
// Optimize with AI is in the view, on the chosen document.
assert.equal(await view.getByRole('button', { name: 'Optimize with AI' }).count(), 1, 'Optimize with AI is in the view');
// In the smallest window, with both side panels open, the computer's result still doesn't scroll sideways.
await row('About').click();
await eventually(async () => assert.equal(await surfaceShown('Search result'), true));
await win.setViewportSize({ width: 1100, height: 700 });
await eventually(async () => assert.equal(await win.evaluate(() => window.innerWidth), 1100));
await eventually(async () => assert.ok((await view.locator('.seo-scroll').evaluate((el) => el.clientWidth)) < 506, 'the view is narrower than a computer’s result'));
await eventually(() => noSidewaysScroll('the smallest window'));
await win.screenshot({ path: join(SHOTS, 'seo-view-narrow.png') });
await win.setViewportSize({ width: 1440, height: 900 });
await row('Winter hours').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));

step('the rail entry again leaves the view: the canvas is back as it was, the same preview and the same selection');
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), false, 'the view goes'));
assert.equal(await canvasInert(), false, 'the canvas takes input again');
assert.equal(await frameKept(), true, 'the preview’s frame stayed loaded under the view');
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

step('Preview chosen while a post is written, then the SEO view opened before it saves: the mode goes back to Edit');
await rail('posts').click();
await win.locator('.post-row .post-open', { hasText: 'Spring open studio' }).click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'the writer shows the post'));
const modeButton = (name) => win.locator('.toolbar [aria-label="Mode"]').getByRole('button', { name, exact: true });
// Left alone, Preview from the toolbar previews the post once the writer has saved it.
await modeButton('Preview').click();
await eventually(async () => assert.equal(await win.locator('.posts-previewing').isVisible(), true, 'the post is previewed'));
await win.locator('.posts-previewing').getByRole('button', { name: 'Back to writing' }).click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'back in the writer'));
await eventually(async () => assert.equal(await modeButton('Edit').getAttribute('aria-pressed'), 'true'));
// Now both in one task, so the view opens while the writer's save for the preview is still on its way.
const writingAtClick = await win.evaluate(() => {
  document.querySelector('.toolbar [aria-label="Mode"] [aria-label="Preview"]').click();
  const writing = !document.querySelector('.post-writer-holder').hidden;
  document.querySelector('.rail [data-rail="seo"]').click();
  return writing;
});
assert.equal(writingAtClick, true, 'Preview was chosen from the writer');
await eventually(async () => assert.equal(await holder.isVisible(), true, 'the view is open'));
await eventually(async () => assert.equal(await modeButton('Edit').getAttribute('aria-pressed'), 'true', 'the post’s preview never began, so Edit is the mode again'));
await rail('posts').click();
await eventually(async () => assert.equal(await win.locator('.post-writer-holder').isVisible(), true, 'the writer is back'));
assert.equal(await modeButton('Preview').getAttribute('aria-pressed'), 'false', 'with Preview ready to choose again');
assert.equal(await modeButton('Preview').isDisabled(), false);

step('opened from Preview, the view covers the canvas’s own controls, and leaving it returns to the same Preview');
await rail('pages').click();
await modeButton('Preview').click();
await eventually(async () => assert.equal(await win.locator('.preview-pill').isVisible(), true, 'the page is previewed'));
await win.keyboard.press(`${MOD}+K`);
await cmdk.waitFor();
await win.keyboard.type('SEO panel');
await eventually(async () => assert.equal(await cmdk.getByRole('option', { name: /^Show the SEO panel/ }).getAttribute('aria-selected'), 'true'));
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await holder.isVisible(), true, 'the command menu opens the view'));
// The pill sits where the view is drawn: what is painted there is the view, never the pill (the canvas is inert, so
// it is told apart by its own paint, not by hit-testing).
const pillBox = await win.locator('.preview-pill').boundingBox();
await win.locator('.seo-view-holder').evaluate((el) => (el.style.background = 'rgb(1, 2, 3)'));
const shot = await win.screenshot({ clip: { x: pillBox.x + pillBox.width / 2 - 1, y: pillBox.y + pillBox.height / 2 - 1, width: 2, height: 2 } });
await win.locator('.seo-view-holder').evaluate((el) => (el.style.background = ''));
const painted = await win.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}, shot.toString('base64'));
assert.deepEqual(painted, [1, 2, 3], 'the view paints over the Preview pill');
await win.screenshot({ path: join(SHOTS, 'seo-view-over-preview.png') });
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), false));
assert.equal(await modeButton('Preview').getAttribute('aria-pressed'), 'true', 'the canvas is still in Preview');
await modeButton('Edit').click();

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
