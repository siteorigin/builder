// The SEO view (#700): a rail entry opens a workspace in the canvas's place, listing every page in the site's page order
// and every post by collection, drafts included. Choosing one shows it as the view's document. The canvas stays loaded
// underneath, out of reach: no key acts on what is selected there, the toolbar and the Inspector name the view, and
// leaving it (the rail entry again, another panel, the sidebar shortcut) brings the canvas back as it was. The chosen
// document survives switching away and back, falls back cleanly when it is deleted, and no window is ever shown.
// With nothing chosen the view shows the overview (#707): every page and post with where it stands in search results,
// the ones with something to fix first, kept up to date as the site changes, filtered to problems, each row opening
// its document.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('seo-view');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Riverside Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });

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
const overview = view.locator('.seo-ov');
await eventually(async () => assert.equal(await overview.isVisible(), true, 'nothing is chosen yet: the view shows the overview'));
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

step('the overview: a row per page and post, drafts marked, the ones with something to fix first');
const ovRow = (key) => overview.locator(`[data-seo-row="${key}"]`);
const ovRows = () => overview.locator('tbody .seo-ov-row').evaluateAll((els) => els.map((r) => ({ key: r.dataset.seoRow, level: r.dataset.level, draft: !!r.querySelector('th .badge') })));
const pageKeys = s0.site.pageOrder.map((id) => `page:${id}`);
const postKeys = ['entry:posts:en_spring', 'entry:posts:en_winter'];
let rows = await ovRows();
assert.deepEqual(rows.map((r) => r.key).sort(), [...pageKeys, ...postKeys].sort(), 'every page and post has a row');
assert.deepEqual(
  rows.filter((r) => r.draft).map((r) => r.key),
  ['entry:posts:en_winter'],
  'the draft is marked as one'
);
const RANK = { warning: 0, note: 1, ok: 2 };
const sortedByLevel = (rs) => rs.every((r, i) => i === 0 || RANK[rs[i - 1].level] <= RANK[r.level]);
assert.ok(sortedByLevel(rows), `the rows with something to fix come first: ${JSON.stringify(rows)}`);
assert.match(await ovRow(`page:${about.id}`).innerText(), /About · Riverside Studio/, 'a row shows its search title, fallbacks included');

step('the overview follows an edit while it shows: About given a sharing image for the site and a description of its own');
const png = await win.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 630;
  const g = c.getContext('2d');
  g.fillStyle = '#2f6f8f';
  g.fillRect(0, 0, 1200, 630);
  return c.toDataURL('image/png').split(',')[1];
});
const sharePath = join(WORK, 'share.png');
writeFileSync(sharePath, Buffer.from(png, 'base64'));
const imported = await win.evaluate((p) => window.builder.project.importAssets([p]), sharePath);
assert.equal(imported.ok, true, `the picture imports: ${imported.message}`);
assert.notEqual(await ovRow(`page:${about.id}`).getAttribute('data-level'), 'ok', 'About has something to fix to begin with');
await apply(
  [
    { type: 'site.update', socialImage: imported.assetIds[0] },
    { type: 'page.update', pageId: about.id, description: 'Meet the designers behind Riverside Studio, and how a calm, practical room comes together.' }
  ],
  'Share and describe About'
);
await eventually(async () => assert.equal(await ovRow(`page:${about.id}`).getAttribute('data-level'), 'ok', 'About has nothing left to fix, without reopening the view'));
const aboutText = await ovRow(`page:${about.id}`).innerText();
for (const shown of ['Meet the designers behind Riverside Studio', '90 characters', 'The site’s', 'Can be listed']) assert.ok(aboutText.includes(shown), `About’s row shows “${shown}”: ${aboutText}`);
assert.match(await ovRow('entry:posts:en_winter').innerText(), /Draft: not on the website/, 'the draft says it is not on the website');
rows = await ovRows();
assert.ok(sortedByLevel(rows), 'and the order follows');
const toFix = rows.filter((r) => r.level !== 'ok').map((r) => r.key);
assert.ok(toFix.length > 0 && toFix.length < rows.length, `some rows still have something to fix: ${JSON.stringify(rows)}`);

step('Problems only leaves out the rows with nothing to fix; a row opens its document, and Back returns to the list as it was');
const filter = overview.getByRole('checkbox', { name: 'Problems only' });
await filter.check();
await eventually(async () => assert.deepEqual((await ovRows()).map((r) => r.key), toFix, 'only the rows with something to fix'));
assert.equal(await ovRow(`page:${about.id}`).count(), 0, 'About is left out');
const opening = toFix[0];
await ovRow(opening).locator('.seo-ov-open').focus();
await win.keyboard.press('Enter');
const back = view.getByRole('button', { name: 'Back to overview' });
await eventually(async () => assert.equal(await back.isVisible(), true, 'the row opens its document'));
assert.equal(await view.locator('[data-seo-doc]').getAttribute('data-seo-doc'), opening);
assert.equal(await panel.locator(`.seo-open[data-seo="${opening}"]`).getAttribute('aria-current'), 'true', 'the list marks it chosen');
await eventually(async () => assert.equal(await back.evaluate((el) => el === document.activeElement), true, 'focus moves to Back'));
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await overview.isVisible(), true, 'Back returns to the overview'));
assert.equal(await filter.isChecked(), true, 'still filtered');
await eventually(async () => assert.equal(await ovRow(opening).locator('.seo-ov-open').evaluate((el) => el === document.activeElement), true, 'with focus on the row it opened'));
await win.screenshot({ path: join(SHOTS, 'seo-overview.png') });
await filter.uncheck();
await eventually(async () => assert.equal((await ovRows()).length, rows.length));

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
const screen = (name) => view.getByRole('radio', { name, exact: true });
const darkResults = view.getByRole('switch', { name: 'Dark results' });
const resultsPage = view.locator('.serp-page');
/** The results page as drawn: its colours, its real and shown widths, and how its title and description are set. */
const drawn = () =>
  view.evaluate((el) => {
    const page = el.querySelector('.serp-page');
    const result = page.querySelector('.serp');
    const fit = el.querySelector('.serp-fit').getBoundingClientRect();
    const slot = el.querySelector('.serp-slot').getBoundingClientRect();
    const box = el.querySelector('.serp-scaled').getBoundingClientRect();
    return {
      theme: page.dataset.serpTheme,
      background: getComputedStyle(page).backgroundColor,
      width: page.offsetWidth,
      column: result.offsetWidth,
      scale: Number(el.querySelector('.serp-scaled').dataset.scale),
      fits: box.left >= fit.left - 0.5 && box.right <= fit.right + 0.5,
      /* The room the page takes is the room it is drawn in: nothing under it is covered or left far below. */
      slotHolds: Math.abs(slot.height - box.height) <= 1 && Math.abs(slot.width - box.width) <= 1,
      titleSize: getComputedStyle(result.querySelector('.serp-title')).fontSize,
      descSize: getComputedStyle(result.querySelector('.serp-desc')).fontSize,
      lines: [...result.querySelectorAll('.serp-title-line')].map((l) => ({ text: l.textContent, height: l.offsetHeight, fits: l.querySelector('.serp-title-text').getBoundingClientRect().right <= l.getBoundingClientRect().right + 0.5 })),
      order: [...page.querySelectorAll('.serp-result')].map((r) => (r.classList.contains('serp-filler') ? 'filler' : 'document')),
      fillers: [...page.querySelectorAll('.serp-filler .serp-url')].map((u) => u.textContent),
      hiddenExtras: [...page.querySelectorAll('.serp-filler, .serp-search')].every((n) => n.getAttribute('aria-hidden') === 'true')
    };
  });
const LIGHT = 'rgb(255, 255, 255)';
const DARK = 'rgb(30, 31, 34)';
/** Nothing in the view scrolls sideways, and the results page shows whole. */
const noSidewaysScroll = async (where) => {
  const w = await view.evaluate((el) => ({ scroll: el.querySelector('.seo-scroll').scrollWidth, client: el.querySelector('.seo-scroll').clientWidth }));
  assert.ok(w.scroll <= w.client, `${where}: nothing scrolls sideways (${JSON.stringify(w)})`);
  const d = await drawn();
  assert.ok(d.fits && d.slotHolds, `${where}: the results page shows whole, in room of its own size (${JSON.stringify(d)})`);
};
/** Both screens in both of the results page's themes, in the dark editor. */
const bothScreensBothThemes = async (d) => {
  for (const [name, device, width, column] of [
    ['Computer', 'desktop', 640, 600],
    ['Phone', 'mobile', 376, 320]
  ]) {
    await screen(name).click();
    await eventually(async () => assert.equal(await result(device).locator('.serp-title').innerText(), d.seoTitle, `${d.title}’s result on ${name}`));
    assert.equal(await view.locator('.serp').count(), 1, 'only the chosen screen’s results show');
    for (const dark of [false, true]) {
      if ((await darkResults.getAttribute('aria-checked')) !== String(dark)) await darkResults.click();
      const where = `${d.title} on ${name}, ${dark ? 'dark' : 'light'}`;
      await eventually(async () => assert.equal(await resultsPage.getAttribute('data-serp-theme'), dark ? 'dark' : 'light', where));
      assert.equal(await win.evaluate(() => document.documentElement.dataset.appearance), 'dark', `${where}: the editor stays dark`);
      await eventually(() => noSidewaysScroll(where));
      const shown = await drawn();
      assert.equal(shown.background, dark ? DARK : LIGHT, `${where}: the results page has its own colours`);
      assert.deepEqual({ width: shown.width, column: shown.column, scale: shown.scale }, { width, column, scale: 1 }, `${where}: at its real size`);
      assert.deepEqual([shown.titleSize, shown.descSize], ['20px', '14px'], where);
      assert.deepEqual(shown.order, ['filler', 'document', 'filler', 'filler'], `${where}: the result sits among others`);
      assert.ok(shown.fillers.every((u) => /^example\.(com|org|net)\b/.test(u)) && shown.hiddenExtras, `${where}: placeholders only (${shown.fillers})`);
      assert.ok((await result(device).locator('.serp-desc').innerText()).includes(d.description), `${where}: the description`);
      assert.equal(await result(device).locator('.serp-url').innerText(), d.trail, `${where}: the address`);
      assert.equal(await result(device).locator('.serp-site-name').innerText(), 'Riverside Studio', `${where}: the site’s name`);
      assert.equal(await result(device).locator('.serp-icon').count(), 1, `${where}: the site’s icon`);
      assert.equal(await result(device).locator('.serp-date').count(), d.dated ? 1 : 0, `${where}: the date`);
      if (d.dated) assert.match(await result(device).locator('.serp-date').innerText(), /2027 — $/, `${where}: the post’s date`);
      await win.screenshot({ path: join(SHOTS, `seo-view-${d.dated ? 'post' : 'page'}-${device}-${dark ? 'dark' : 'light'}.png`) });
    }
  }
  await darkResults.click();
  await screen('Computer').click();
};
const documents = [
  { title: 'About', seoTitle: 'About the studio · Riverside', description: 'A pottery studio by the river', url: `https://riverside.example${about.route}`, trail: `riverside.example › ${about.route.split('/').filter(Boolean).join(' › ')}` },
  { title: 'Spring open studio', dated: true, seoTitle: 'Spring open studio at Riverside', description: 'Throw, glaze and fire with us', url: 'https://riverside.example/blog/spring-open-studio/', trail: 'riverside.example › blog › spring-open-studio' }
];
// The editor is dark from here on; the results page stays light until its own dark toggle is used.
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'dark' }));
await eventually(async () => assert.equal(await win.evaluate(() => document.documentElement.dataset.appearance), 'dark'));
for (const d of documents) {
  await row(d.title).click();
  await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), d.title));
  // Each document opens on its search result, whatever surface the one before was left on.
  await eventually(async () => assert.equal(await surfaceShown('Search result'), true, `${d.title} opens on its search result`));
  assert.equal(await graphShown.count(), 0, 'the structured data is not worked out while another surface shows');
  await eventually(async () => assert.equal(await screen('Computer').getAttribute('aria-checked'), 'true', 'a computer’s results until a phone’s are chosen'));
  assert.equal(await darkResults.getAttribute('aria-checked'), 'false', 'light in the dark editor until the toggle is used');
  assert.equal((await drawn()).background, LIGHT);
  await bothScreensBothThemes(d);
  await surface('Link preview').click();
  await eventually(async () => assert.equal(await card.locator('.share-card-host').innerText(), 'riverside.example', `${d.title}’s link preview`));
  assert.ok((await card.locator('.share-card-desc').innerText()).includes(d.description), `${d.title}’s card carries its description`);
  assert.equal(await card.locator('.share-card-title').innerText(), d.seoTitle, `${d.title}’s card carries its title`);
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
// A surface chosen for one document is that document's alone: the next opens on its search result, and coming back
// opens on it again.
await surface('Link preview').click();
await eventually(async () => assert.equal(await surfaceShown('Link preview'), true));
await row('Spring open studio').click();
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), documents[1].seoTitle, 'the post’s result, not the page’s card'));
assert.equal(await surfaceShown('Search result'), true);
await row('About').click();
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), documents[0].seoTitle));
assert.equal(await surfaceShown('Search result'), true, 'About opens on its search result, not the surface it was left on');
// A draft is left out of the website: its structured data says so.
await row('Winter hours').click();
await eventually(async () => assert.match(await view.innerText(), /draft is left out of the website/i));
await surface('Structured data').click();
await eventually(async () => assert.ok((await view.locator('.seo-graph-none').innerText()).trim(), 'the draft’s structured data says why it has none'));
// Optimize with AI is in the view, on the chosen document.
assert.equal(await view.getByRole('button', { name: 'Optimize with AI' }).count(), 1, 'Optimize with AI is in the view');
// In a 1280px window, with both side panels open, the computer's result still fits whole, laid out at the width it is
// measured against.
await row('About').click();
await eventually(async () => assert.equal(await surfaceShown('Search result'), true));
await win.setViewportSize({ width: 1280, height: 800 });
await eventually(async () => assert.equal(await win.evaluate(() => window.innerWidth), 1280));
assert.equal(await win.locator('#editor-dock').isVisible(), true, 'the right panel is open');
await eventually(() => noSidewaysScroll('a 1280px window'));
await win.screenshot({ path: join(SHOTS, 'seo-view-1280.png') });
// A title too long for either screen is cut where it was measured: one line on a computer, two on a phone, each ending
// where the browser can set it, with the "…" and no wrapping of its own.
const longTitle = 'Hand-thrown pottery classes, kiln hire and open studio weekends beside the river for beginners and regulars alike';
await apply([{ type: 'page.update', pageId: about.id, seoTitle: longTitle }], 'A long title');
for (const [name, count, column] of [
  ['Computer', 1, 600],
  ['Phone', 2, 320]
]) {
  await screen(name).click();
  await eventually(async () => {
    const shown = await drawn();
    assert.equal(shown.column, column);
    assert.equal(shown.lines.length, count, `${name}: ${JSON.stringify(shown.lines)}`);
    assert.match(shown.lines.at(-1).text, /…$/, `${name}: cut with an ellipsis`);
    assert.ok(shown.lines.every((l) => l.height === 26 && l.fits), `${name}: each line is one line, inside the column (${JSON.stringify(shown.lines)})`);
  });
}
await screen('Computer').click();
// A window too narrow for a computer's results at their real size scales them down rather than scrolling them.
await win.setViewportSize({ width: 1060, height: 800 });
await eventually(async () => {
  assert.ok((await drawn()).scale < 1, 'the page is scaled down');
  assert.equal((await drawn()).width, 640, 'and still laid out at its real width');
  await noSidewaysScroll('a narrow window');
});
await win.screenshot({ path: join(SHOTS, 'seo-view-narrow.png') });
await apply([{ type: 'page.update', pageId: about.id, seoTitle: documents[0].seoTitle }], 'The title back');
await win.setViewportSize({ width: 1440, height: 900 });

step('a post’s search settings edited in the view, with no post open in the writer (#703)');
const settings = view.locator('.seo-settings');
const viewField = (name) => settings.getByLabel(name, { exact: true });
const viewMeter = (kind) => settings.locator(`.seo-meter[data-meter="${kind}"]`);
const viewSwitch = (name) => settings.getByRole('switch', { name });
const entryNow = async (id) => (await snapshot()).state.collections.posts.entries[id];
/**
 * The newest step is `label`, as History keeps it (once it has recorded it, which can be just after the change itself),
 * and the editor has heard of it too: its Undo button names it.
 */
const lastStep = (label) =>
  eventually(async () => {
    assert.equal((await snapshot()).history.undoLabel, label);
    assert.equal(await win.locator('.toolbar').getByRole('button', { name: `Undo ${label}`, exact: true }).count(), 1, `the editor has heard of “${label}”`);
  });
const toasts = async () => (await win.locator('.toast').allInnerTexts()).join('\n');
assert.equal(await win.locator('.post-writer-holder .post-page').count(), 0, 'no post is open in the writer');
await row('Spring open studio').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Spring open studio'));
await eventually(async () => assert.equal(await surfaceShown('Search result'), true));
assert.equal(await settings.getByRole('heading').innerText(), 'Search & sharing', 'the post’s settings are under its previews');
const titleBox = viewField('Browser title');
assert.equal(await titleBox.inputValue(), 'Spring open studio at Riverside', 'the title field shows the saved title');
// Each keystroke reaches the result and the meter; nothing is saved while it is typed.
await titleBox.fill('');
await titleBox.pressSequentially('Glaze');
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Glaze', 'the result follows the title as it is typed'));
assert.equal(await viewMeter('title').innerText(), '5 characters · short: 15 to 60 reads best', 'and so does the meter');
await titleBox.pressSequentially(' weekend');
await eventually(async () => assert.equal(await result('mobile').locator('.serp-title').innerText(), 'Glaze weekend'));
assert.equal(await viewMeter('title').innerText(), '13 characters · short: 15 to 60 reads best');
assert.equal((await entryNow('en_spring')).seo.title, 'Spring open studio at Riverside', 'nothing is saved while it is typed');
await titleBox.press('Escape');
await eventually(async () => assert.equal(await titleBox.inputValue(), 'Spring open studio at Riverside', 'Escape puts the saved title back'));
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Spring open studio at Riverside', 'in the result too'));
assert.match(await viewMeter('title').innerText(), /^31 characters/);
// Saved as the writer saves it: trimmed, as a step named as the writer names it.
await titleBox.fill('  Glaze weekend at Riverside  ');
await titleBox.press('Enter');
await eventually(async () => assert.equal((await entryNow('en_spring')).seo.title, 'Glaze weekend at Riverside', 'Enter saves the title, trimmed'));
await lastStep('Change post browser title');
await eventually(async () => assert.equal(await titleBox.inputValue(), 'Glaze weekend at Riverside'));
const descriptionBox = viewField('Description');
await descriptionBox.fill('Throw, glaze and fire with us this spring.');
await eventually(async () => assert.ok((await result('desktop').locator('.serp-desc').innerText()).includes('Throw, glaze and fire with us this spring.'), 'the result follows the description as it is typed'));
assert.match(await viewMeter('description').innerText(), /^42 characters · short/);
assert.match((await entryNow('en_spring')).seo.description, /^Throw, glaze and fire with us at the spring open studio/, 'nothing is saved while it is typed');
await descriptionBox.press('Tab');
await eventually(async () => assert.equal((await entryNow('en_spring')).seo.description, 'Throw, glaze and fire with us this spring.', 'leaving the field saves it'));
await lastStep('Change post description');
// The canonical URL, followed by the link preview as it is typed.
await surface('Link preview').click();
const canonicalBox = viewField('Canonical URL');
await canonicalBox.fill('https://journal.example/spring/');
await eventually(async () => assert.equal(await card.locator('.share-card-host').innerText(), 'journal.example', 'the card follows the canonical URL as it is typed'));
assert.equal((await entryNow('en_spring')).seo.canonical, undefined, 'nothing is saved while it is typed');
await canonicalBox.press('Escape');
await eventually(async () => assert.equal(await card.locator('.share-card-host').innerText(), 'riverside.example', 'Escape puts the post’s own address back'));
assert.equal(await canonicalBox.inputValue(), '');
await canonicalBox.fill('https://journal.example/spring/');
await canonicalBox.press('Enter');
await eventually(async () => assert.equal((await entryNow('en_spring')).seo.canonical, 'https://journal.example/spring/'));
await lastStep('Change post canonical URL');
await canonicalBox.fill('');
await canonicalBox.press('Enter');
await eventually(async () => assert.equal((await entryNow('en_spring')).seo.canonical, undefined));
await lastStep('Clear post canonical URL');
// The sharing image, chosen and put back to the default.
const sharing = viewField('Sharing image');
const picture = await sharing.locator('option').nth(1).getAttribute('value');
assert.ok(picture, 'the library has a picture to choose');
await sharing.selectOption(picture);
await eventually(async () => assert.equal((await entryNow('en_spring')).seo.socialImage, picture));
await lastStep('Change post sharing image');
await sharing.selectOption('');
await eventually(async () => assert.equal((await entryNow('en_spring')).seo.socialImage, undefined));
await lastStep('Use the default sharing image');
// Both visibility switches, which the structured data's status follows.
await surface('Structured data').click();
await eventually(async () => assert.equal(await view.locator('[data-status="search"] dd').innerText(), 'May list it'));
for (const [name, field, status, on, label] of [
  ['Hide from search engines', 'noindex', 'search', 'Asked not to list it', ['Hide post from search engines', 'Show post to search engines']],
  ['Hide from site search', 'searchHidden', 'siteSearch', 'Hidden from site search', ['Hide post from site search', 'Show post in site search']]
]) {
  await viewSwitch(name).click();
  await eventually(async () => assert.equal((await entryNow('en_spring')).seo[field], true, `${name} is saved`));
  await lastStep(label[0]);
  await eventually(async () => assert.equal(await view.locator(`[data-status="${status}"] dd`).innerText(), on, `the status follows ${name}`));
  await viewSwitch(name).click();
  await eventually(async () => assert.equal((await entryNow('en_spring')).seo[field] ?? false, false, `${name} is turned off again`));
  await lastStep(label[1]);
}
// Another post never shows the text typed for this one, even text kept for being too long to save.
await surface('Search result').click();
await titleBox.fill('A'.repeat(130));
await titleBox.press('Tab');
await eventually(async () => assert.equal(await titleBox.getAttribute('aria-invalid'), 'true', 'text too long to save stays, marked'));
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText().then((t) => t.startsWith('AAAA')), true, 'and the result shows it'));
await row('Winter hours').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await eventually(async () => assert.equal(await titleBox.inputValue(), '', 'Winter’s title field shows its own title, none'));
assert.equal(await titleBox.getAttribute('aria-invalid'), null);
assert.match(await result('desktop').locator('.serp-title').innerText(), /^Winter hours/, 'its result shows its own default title');
assert.match(await viewMeter('title').innerText(), /^Default title:/);
assert.equal(await descriptionBox.inputValue(), '', 'and its own description, none');
assert.equal((await entryNow('en_spring')).seo.title, 'Glaze weekend at Riverside', 'the text too long to save was never saved');
await row('Spring open studio').click();
await eventually(async () => assert.equal(await titleBox.inputValue(), 'Glaze weekend at Riverside', 'back on the post, its saved title shows'));
assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Glaze weekend at Riverside');
await win.screenshot({ path: join(SHOTS, 'seo-view-post-settings.png') });
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

step('a post’s search settings edited in the view with the writer open on it (#703)');
const writerHolder = win.locator('.post-writer-holder');
// With the writer holding another post, a title saved in the view is the view's post's alone.
assert.equal(await writerHolder.locator('.post-title-input').inputValue(), 'Spring open studio', 'the writer holds Spring');
await rail('seo').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await viewField('Browser title').fill('Winter hours by the river');
await viewField('Browser title').press('Enter');
await eventually(async () => assert.equal((await entryNow('en_winter')).seo?.title, 'Winter hours by the river', 'saved to the post chosen in the view'));
assert.equal((await entryNow('en_spring')).seo.title, 'Glaze weekend at Riverside', 'never to the post the writer holds');
await lastStep('Change post browser title');
await rail('posts').click();
await win.locator('.post-row .post-open', { hasText: 'Winter hours' }).click();
await eventually(async () => assert.equal(await writerHolder.locator('.post-title-input').inputValue(), 'Winter hours', 'the writer holds Winter'));
const writerSeo = writerHolder.locator('.post-seo');
await writerSeo.locator('summary').first().click();
const writerField = (name) => writerSeo.getByLabel(name, { exact: true });
assert.equal(await writerField('Browser title').inputValue(), 'Winter hours by the river', 'the writer shows the title saved in the view');
// Saved in the writer, it shows in the view.
await writerField('Browser title').fill('Winter hours at the studio');
await writerField('Browser title').press('Enter');
await eventually(async () => assert.equal((await entryNow('en_winter')).seo?.title, 'Winter hours at the studio'));
await rail('seo').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await eventually(async () => assert.equal(await viewField('Browser title').inputValue(), 'Winter hours at the studio', 'a title saved in the writer shows in the view'));
assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Winter hours at the studio');
// Saved in the view, it shows in the writer.
await viewField('Browser title').fill('Short winter days');
await viewField('Browser title').press('Enter');
await eventually(async () => assert.equal((await entryNow('en_winter')).seo?.title, 'Short winter days'));
await lastStep('Change post browser title');
await eventually(async () => assert.equal(await writerField('Browser title').inputValue(), 'Short winter days', 'a title saved in the view shows in the writer'));
/** Show the writer and press one of its buttons in one go, while a field of the view still has the text typed in it. */
const pressInWriterWhileTyping = (button) =>
  win.evaluate((name) => {
    const typing = !!document.activeElement?.closest('.seo-view .seo-settings');
    document.querySelector('.rail [data-rail="posts"]').click();
    [...document.querySelectorAll('.post-writer-holder .post-bar button')].find((b) => b.textContent.trim() === name).click();
    return typing;
  }, button);
// Save draft, pressed before anything saved the description typed in the view, keeps it.
await viewField('Description').fill('Long nights at the wheel.');
assert.equal(await pressInWriterWhileTyping('Save draft'), true, 'the description was still being typed in the view');
await eventually(async () => assert.equal((await entryNow('en_winter')).seo?.description, 'Long nights at the wheel.', 'Save draft keeps what was typed in the view'));
await eventually(async () => assert.match(await toasts(), /Saved as a draft\./, 'and says it saved'));
assert.notEqual((await entryNow('en_winter')).draft, false, 'the post is still a draft');
await eventually(async () => assert.equal(await writerField('Description').inputValue(), 'Long nights at the wheel.', 'the writer shows the description'));
// Publish, pressed the same way, publishes the post with the title typed in the view.
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true));
await viewField('Browser title').fill('Winter hours, shorter days');
assert.equal(await pressInWriterWhileTyping('Publish'), true, 'the title was still being typed in the view');
await eventually(async () => assert.equal((await entryNow('en_winter')).draft, false, 'Publish publishes the post'));
assert.equal((await entryNow('en_winter')).seo.title, 'Winter hours, shorter days', 'with the title typed in the view');
// History names the step once it has recorded it, which can be just after the post itself changed.
await eventually(async () => {
  const lastSteps = (await snapshot()).history.entries.filter((e) => e.applied).map((e) => e.label).slice(-2);
  assert.deepEqual(lastSteps, ['Change post browser title', 'Publish post'], 'the view’s change is saved before the post is published');
});
await eventually(async () => assert.equal(await writerField('Browser title').inputValue(), 'Winter hours, shorter days'));
// An address the view refused is still the post’s: Move to drafts waits, and says where to look.
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true));
const viewCanonical = viewField('Canonical URL');
await viewCanonical.fill('journal.example/winter');
await viewCanonical.press('Tab');
await eventually(async () => assert.equal(await viewCanonical.getAttribute('aria-invalid'), 'true', 'the view keeps the address it refused'));
await rail('posts').click();
await eventually(async () => assert.equal(await writerHolder.isVisible(), true));
await writerHolder.getByRole('button', { name: 'Move to drafts' }).click();
await eventually(async () => assert.match(await toasts(), /Part of the post is not saved yet, so it stays as it is\. See its search settings in the SEO view\./, 'Move to drafts says where the unsaved text is'));
assert.equal((await entryNow('en_winter')).draft, false, 'the post stays published');
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true));
await viewCanonical.click();
await viewCanonical.press('Escape');
await eventually(async () => assert.equal(await viewCanonical.getAttribute('aria-invalid'), null, 'Escape lets the refused address go'));
assert.equal(await viewCanonical.inputValue(), '');
await rail('posts').click();
await eventually(async () => assert.equal(await writerHolder.isVisible(), true));
await writerHolder.getByRole('button', { name: 'Move to drafts' }).click();
await eventually(async () => assert.notEqual((await entryNow('en_winter')).draft, false, 'then it moves to drafts'));
assert.equal((await entryNow('en_winter')).seo.canonical, undefined, 'and no address was saved');
// Its notices go before the next step looks at what is painted where the Preview pill sits, which is where they show.
await eventually(async () => assert.equal(await win.locator('.toast').count(), 0, 'the notices have gone'), 15000);

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
// What the view holds (a results page, white in its own colours) is hidden for the look, so its own paint shows.
await win.locator('.seo-view-holder').evaluate((el) => {
  el.style.background = 'rgb(1, 2, 3)';
  el.firstElementChild.style.visibility = 'hidden';
});
const shot = await win.screenshot({ clip: { x: pillBox.x + pillBox.width / 2 - 1, y: pillBox.y + pillBox.height / 2 - 1, width: 2, height: 2 } });
await win.locator('.seo-view-holder').evaluate((el) => {
  el.style.background = '';
  el.firstElementChild.style.visibility = '';
});
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
await eventually(async () => assert.equal(await overview.isVisible(), true, 'it shows the overview'));
assert.equal(await ovRow('entry:posts:en_winter').count(), 0, 'without the deleted post');
assert.equal(await panel.locator('.seo-open', { hasText: 'Winter hours' }).count(), 0, 'the list no longer has it');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.equal(await panel.locator('.seo-open', { hasText: 'Winter hours' }).count(), 1, 'Undo brings the post back to the list'));
assert.equal(await view.locator('.seo-title').innerText(), 'SEO', 'without choosing it again on its own');
await eventually(async () => assert.equal(await ovRow('entry:posts:en_winter').count(), 1, 'and the overview lists it again'));

step('the screen and the dark toggle are remembered across a reload (#704)');
await panel.locator('.seo-open', { hasText: 'About' }).first().click();
await screen('Phone').click();
await darkResults.click();
await eventually(async () => assert.equal(await resultsPage.getAttribute('data-serp-theme'), 'dark'));
await win.reload();
await win.waitForSelector('.editor');
// The view may come back with the editor: pressing its rail entry then would put it away.
if ((await rail('seo').getAttribute('aria-pressed')) !== 'true') await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true));
await panel.locator('.seo-open', { hasText: 'About' }).first().click();
await eventually(async () => assert.equal(await screen('Phone').getAttribute('aria-checked'), 'true', 'the phone is still chosen'));
assert.equal(await darkResults.getAttribute('aria-checked'), 'true', 'and the dark results');
assert.equal((await drawn()).background, DARK);
await noWindowShown('the end of the run');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nseo-view: passed');
