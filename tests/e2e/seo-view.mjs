// The SEO view (#700): a rail entry opens a workspace in the canvas's place, listing every page in the site's page order
// and every post by collection, drafts included. Choosing one shows it as the view's document. The canvas stays loaded
// underneath, out of reach: no key acts on what is selected there, the toolbar and the Inspector name the view, and
// leaving it (the rail entry again, another panel, the sidebar shortcut) brings the canvas back as it was. The chosen
// document survives switching away and back, falls back cleanly when it is deleted, and no window is ever shown.
// With nothing chosen the view shows the overview (#707): every page and post with where it stands in search results,
// the ones with something to fix first, kept up to date as the site changes, filtered to problems, each row opening
// its document. A page's or post's previews follow what is typed in its fields before it is saved (#597), and the
// Inspector's Search & sharing section, which has no previews of its own, opens its page here with what is being typed
// saved first, or carried over when it can't be (#708).
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

step('a result without a title, a description or a public URL says so (#704)');
const before = (await snapshot()).state;
const noteShown = view.locator('.serp-note');
await apply(
  [
    { type: 'site.update', description: '' },
    { type: 'page.update', pageId: about.id, seoTitle: '   ', description: '' }
  ],
  'No search text'
);
await panel.locator('.seo-open', { hasText: 'About' }).first().click();
const bare = view.locator('.serp');
await eventually(async () => assert.equal(await bare.locator('.serp-title').innerText(), 'No title: results show the address instead.'));
assert.equal(await bare.locator('.serp-desc').innerText(), 'No description: search engines pick words from the page.');
assert.equal(await bare.locator('.serp-url').innerText(), ['No public URL', ...about.route.split('/').filter(Boolean)].join(' › '));
assert.match(await noteShown.innerText(), /no public URL yet/);
assert.equal(await noteShown.getByRole('button', { name: 'Open Site details' }).count(), 1);
assert.equal(await bare.locator('.serp-icon svg').count(), 1, 'a site without a favicon shows a globe');
await apply([{ type: 'site.update', description: before.site.description ?? '' }], 'The site’s description back');

step('the chosen document’s previews at the view’s width: each surface for a page and a post, from the surface selector (#701)');
await apply(
  [
    { type: 'site.update', baseUrl: 'https://riverside.example' },
    { type: 'page.update', pageId: about.id, seoTitle: 'About the studio · Riverside', description: 'A pottery studio by the river, with wheel and hand-building classes for every level.' },
    { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: 'Spring open studio at Riverside', description: 'Throw, glaze and fire with us at the spring open studio, with free taster sessions all weekend.' }
  ],
  'Search settings'
);
const iconPath = join(WORK, 'siteicon.png');
writeFileSync(
  iconPath,
  Buffer.from(
    await win.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#b4532a';
      g.fillRect(0, 0, 64, 64);
      return c.toDataURL('image/png').split(',')[1];
    }),
    'base64'
  )
);
const icon = await win.evaluate((p) => window.builder.project.importAssets([p]), iconPath);
assert.equal(icon.ok, true, `the icon imports: ${icon.message}`);
await apply([{ type: 'site.update', favicon: icon.assetIds[0] }], 'A favicon');
const surface = (name) => view.getByRole('tab', { name, exact: true });
const surfaceShown = async (name) => (await surface(name).getAttribute('aria-selected')) === 'true';
const result = (device) => view.locator(`.serp-${device}`);
// About has a tall picture of its own; the post has none, and falls back to the site's wide one.
const tall = await win.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 1200;
  const g = c.getContext('2d');
  g.fillStyle = '#8f5a2f';
  g.fillRect(0, 0, 900, 1200);
  return c.toDataURL('image/png').split(',')[1];
});
const ownPath = join(WORK, 'about-portrait.png');
writeFileSync(ownPath, Buffer.from(tall, 'base64'));
const ownImport = await win.evaluate((p) => window.builder.project.importAssets([p]), ownPath);
assert.equal(ownImport.ok, true, `the picture imports: ${ownImport.message}`);
await apply([{ type: 'page.update', pageId: about.id, socialImage: ownImport.assetIds[0] }], 'About’s own sharing image');
const assets = (await snapshot()).state.assets.assets;
const siteImage = (await snapshot()).state.site.socialImage;
assert.equal(siteImage, imported.assetIds[0], 'the site still has its sharing image');
const sample = (platform) => view.getByRole('group', { name: `${platform} link preview`, exact: true });
/** What one platform's card draws: its width, its picture's box and shape, and how its text is clamped. */
const cardDrawn = (platform) =>
  sample(platform).evaluate((el) => {
    const q = (s) => el.querySelector(s);
    const picture = q('.share-card-image');
    const img = q('.share-card-image img');
    const line = (n) => (n ? { height: n.getBoundingClientRect().height, line: parseFloat(getComputedStyle(n).lineHeight), cut: n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1 } : null);
    const box = picture?.getBoundingClientRect();
    return {
      card: q('.share-card').getBoundingClientRect().width,
      room: q('.share-card-fit').getBoundingClientRect().width,
      natural: Number(q('.share-card').style.getPropertyValue('--w')),
      ratio: box ? box.width / box.height : null,
      width: box?.width ?? null,
      fit: img ? getComputedStyle(img).objectFit : null,
      loaded: !!img && img.complete && img.naturalWidth > 0,
      src: img?.getAttribute('src') ?? '',
      // Where the card's parts sit, and whether the picture fills its slot.
      places: Object.fromEntries(Object.entries({ picture, img, title: q('.share-card-title'), desc: q('.share-card-desc'), host: q('.share-card-host') }).map(([k, n]) => [k, n?.getBoundingClientRect().toJSON() ?? null])),
      position: img ? getComputedStyle(img).objectPosition : null,
      colours: [q('.share-card-frame'), q('.share-card-title'), q('.share-card-host')].map((n) => `${getComputedStyle(n).color} on ${getComputedStyle(n).backgroundColor}`),
      title: line(q('.share-card-title')),
      desc: line(q('.share-card-desc'))
    };
  });
/** Every platform's card carries the document's host, title and description, and its picture, cropped or whole. */
const checkCards = async (d) => {
  const asset = assets[d.image];
  const shape = asset.width / asset.height;
  assert.equal(await view.locator('.share-card').count(), 4, 'a card for each platform');
  assert.match(await view.locator('.share-preview-image').innerText(), d.whose, `${d.title}: whose picture it is`);
  for (const platform of ['Facebook', 'X', 'WhatsApp', 'Slack']) {
    const where = `${d.title} on ${platform}`;
    assert.equal(await sample(platform).locator('.share-card-host').innerText(), 'riverside.example', `${where}: host`);
    assert.equal(await sample(platform).locator('.share-card-title').innerText(), d.seoTitle, `${where}: title`);
    if (platform === 'X') assert.equal(await sample(platform).locator('.share-card-desc').count(), 0, `${where}: no description beside a large picture`);
    else assert.ok((await sample(platform).locator('.share-card-desc').innerText()).includes(d.description), `${where}: description`);
    await eventually(async () => assert.ok((await cardDrawn(platform)).loaded, `${where}: its picture loads`));
    const v = await cardDrawn(platform);
    assert.ok(v.src.includes(asset.file.split('/').pop().replace(/\.[^.]+$/, '')), `${where}: the effective picture (${v.src})`);
    const expected = { Facebook: 1.91, X: 2, WhatsApp: 1.91, Slack: shape }[platform];
    assert.ok(Math.abs(v.ratio - expected) < 0.03, `${where}: the picture’s box is ${expected}:1 (${v.ratio})`);
    assert.equal(v.fit, platform === 'Slack' ? 'contain' : 'cover', `${where}: cropped or whole`);
    assert.equal(v.position, '50% 50%', `${where}: cropped about its centre`);
    const at = v.places;
    assert.ok(Math.abs(at.img.width - at.picture.width) < 1 && Math.abs(at.img.height - at.picture.height) < 1, `${where}: the picture fills its slot`);
    if (platform === 'Slack') assert.ok(at.picture.top >= at.desc.bottom, `${where}: the picture is under the text`);
    else if (platform === 'X') assert.ok(at.title.top > at.picture.top && at.title.bottom < at.picture.bottom, `${where}: the title is over the picture`);
    else assert.ok(at.title.top >= at.picture.bottom, `${where}: the text is under the picture`);
    if (platform === 'WhatsApp') assert.ok(at.host.top >= at.desc.bottom, `${where}: the host is under the description`);
    if (platform === 'Facebook') assert.ok(at.host.bottom <= at.title.top + 1, `${where}: the host is over the title`);
    assert.ok(Math.abs(v.card - Math.min(v.natural, v.room)) < 1, `${where}: the card is drawn at its width, or the room there is (${v.card} of ${v.natural} in ${v.room})`);
    if (platform === 'Slack') assert.ok(Math.abs(v.width / v.card - Math.min(360, 500 * shape, asset.width) / v.natural) < 0.01, `${where}: shrunk within its bounds`);
  }
};
const card = (platform) => sample(platform);
const graphShown = view.getByTestId('seo-graph');
const screen = (name) => view.getByRole('radio', { name, exact: true });
const darkResults = view.getByRole('switch', { name: 'Dark results' });
/** Shows one screen's results without taking focus from a field being typed in, which would save it. */
const peekScreen = (name) => screen(name).dispatchEvent('click');
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
      /* The scale the room there is now asks for. */
      roomScale: Math.min(1, fit.width / page.offsetWidth),
      fits: box.left >= fit.left - 0.5 && box.right <= fit.right + 0.5 && box.top >= fit.top - 0.5 && box.bottom <= fit.bottom + 0.5,
      bezel: getComputedStyle(page).borderTopWidth,
      search: page.querySelector('.serp-search')?.innerText.trim(),
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
  assert.ok(Math.abs(d.scale - d.roomScale) < 0.002, `${where}: scaled by what the room asks for (${JSON.stringify(d)})`);
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
      assert.equal(shown.bezel, device === 'mobile' ? '8px' : '0px', `${where}: a phone’s results sit in a phone’s frame`);
      assert.equal(shown.search, 'sample search', `${where}: under a sample search`);
      assert.equal(await result(device).locator('.serp-title').innerText(), d.seoTitle, `${where}: the title`);
      assert.equal(shown.fillers.length, 3, where);
      assert.deepEqual([shown.titleSize, shown.descSize], ['20px', '14px'], where);
      assert.deepEqual(shown.order, ['filler', 'document', 'filler', 'filler'], `${where}: the result sits among others`);
      assert.ok(shown.fillers.every((u) => /^example\.(com|org|net)( › |$)/.test(u)) && shown.hiddenExtras, `${where}: placeholders only (${shown.fillers})`);
      assert.ok((await result(device).locator('.serp-desc').innerText()).includes(d.description), `${where}: the description`);
      assert.equal(await result(device).locator('.serp-url').innerText(), d.trail, `${where}: the address`);
      assert.equal(await result(device).locator('.serp-site-name').innerText(), 'Riverside Studio', `${where}: the site’s name`);
      await eventually(async () => assert.match((await result(device).locator('.serp-icon img').getAttribute('src')) ?? '', /siteicon/, `${where}: the site’s favicon`));
      assert.equal(await result(device).locator('.serp-date').count(), d.dated ? 1 : 0, `${where}: the date`);
      if (d.dated) assert.match(await result(device).locator('.serp-desc').innerText(), /^Mar 2, 2027 — Throw, /, `${where}: the post’s date`);
      await win.screenshot({ path: join(SHOTS, `seo-view-${d.dated ? 'post' : 'page'}-${device}-${dark ? 'dark' : 'light'}.png`) });
    }
  }
  await darkResults.click();
  await screen('Computer').click();
};
const documents = [
  { image: ownImport.assetIds[0], whose: /this page’s own\./, title: 'About', seoTitle: 'About the studio · Riverside', description: 'A pottery studio by the river', url: `https://riverside.example${about.route}`, trail: `riverside.example › ${about.route.split('/').filter(Boolean).join(' › ')}` },
  { image: siteImage, whose: /the site’s\./, title: 'Spring open studio', dated: true, seoTitle: 'Spring open studio at Riverside', description: 'Throw, glaze and fire with us', url: 'https://riverside.example/blog/spring-open-studio/', trail: 'riverside.example › blog › spring-open-studio' }
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
  await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-host').innerText(), 'riverside.example', `${d.title}’s link preview`));
  await checkCards(d);
  await win.screenshot({ path: join(SHOTS, `seo-view-cards-${d.title.split(' ')[0].toLowerCase()}.png`) });
  await view.locator('.seo-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await win.screenshot({ path: join(SHOTS, `seo-view-cards-${d.title.split(' ')[0].toLowerCase()}-end.png`) });
  await surface('Structured data').click();
  await eventually(async () => {
    const node = JSON.parse(await graphShown.textContent())['@graph'].find((n) => n['@type'] === 'WebPage' || n['@type'] === 'AboutPage');
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
// An overlong title and description are cut after each platform's own number of lines, in Chinese and in a word too
// long for a line too.
await row('About').click();
await eventually(async () => assert.equal(await surfaceShown('Search result'), true));
for (const long of ['WHEEL THROWING, HAND BUILDING AND GLAZING CLASSES FOR EVERY LEVEL, ALL YEAR ROUND. '.repeat(4), '河畔陶艺工作室全年开设拉坯与手工成型课程'.repeat(15), 'MWPottery'.repeat(35)]) {
  // A search title has a shorter limit than a description.
  const seoTitle = long.slice(0, 120).trim();
  await apply([{ type: 'page.update', pageId: about.id, seoTitle, description: long.slice(0, 300).trim() }], 'Long text');
  await surface('Link preview').click();
  await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-title').textContent(), seoTitle));
  for (const [platform, titleLines, descLines] of [['Facebook', 2, 1], ['X', 1, 0], ['WhatsApp', 2, 2], ['Slack', 2, 3]]) {
    const v = await cardDrawn(platform);
    const lines = (t) => Math.round(t.height / t.line);
    assert.equal(lines(v.title), titleLines, `${platform}: the title keeps ${titleLines} (${JSON.stringify(v.title)})`);
    assert.ok(v.title.cut, `${platform}: and is cut`);
    if (descLines) {
      assert.equal(lines(v.desc), descLines, `${platform}: the description keeps ${descLines} (${JSON.stringify(v.desc)})`);
      assert.ok(v.desc.cut, `${platform}: and the description is cut`);
    }
  }
  const across = await view.locator('.seo-scroll').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  assert.ok(across.scroll <= across.client, `long text in the link preview: nothing scrolls sideways (${JSON.stringify(across)})`);
}
await win.screenshot({ path: join(SHOTS, 'seo-view-cards-long.png') });
// The cards are samples of other apps: the editor's appearance doesn't colour them.
const grounds = () => Promise.all(['Facebook', 'X', 'WhatsApp', 'Slack'].map(async (p) => (await cardDrawn(p)).colours));
const editorGround = () => win.evaluate(() => getComputedStyle(document.body).backgroundColor);
const editorBefore = await editorGround();
const groundsBefore = await grounds();
const appearance = await win.evaluate(() => document.documentElement.getAttribute('data-appearance'));
await win.evaluate((t) => document.documentElement.setAttribute('data-appearance', t === 'dark' ? 'light' : 'dark'), appearance);
await win.screenshot({ path: join(SHOTS, 'seo-view-cards-other-appearance.png') });
await eventually(async () => assert.notEqual(await editorGround(), editorBefore, 'the editor’s own colours change'));
assert.deepEqual(await grounds(), groundsBefore, 'the cards keep their own colours');
await win.evaluate((t) => (t === null ? document.documentElement.removeAttribute('data-appearance') : document.documentElement.setAttribute('data-appearance', t)), appearance);
// The Inspector shows one platform at a time, shrunk as one piece to the room it has.
await apply([{ type: 'page.update', pageId: about.id, seoTitle: documents[0].seoTitle, description: 'A pottery studio by the river, with wheel and hand-building classes for every level.' }], 'Short text again');
await surface('Search result').click();
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
// A line the browser sets wider than it was measured (here, letters pushed apart) is narrowed to its column: still one
// line each, and let go again once it fits. (Pressing the dark toggle draws the page again.)
const squeezed = () => view.locator('.serp .serp-title-text').evaluateAll((els) => els.map((el) => ({ over: el.offsetWidth > el.parentElement.clientWidth, squeeze: el.style.transform })));
const spread = await win.addStyleTag({ content: '.serp .serp-title-text { letter-spacing: 3px; }' });
await darkResults.click();
await eventually(async () => {
  const lines = await squeezed();
  assert.ok(lines.some((l) => l.over) && lines.every((l) => !l.over || /^scaleX\(0\./.test(l.squeeze)), `the wide line is narrowed: ${JSON.stringify(lines)}`);
  assert.ok((await drawn()).lines.every((l) => l.height === 26 && l.fits), 'inside the column, on its own line');
});
await spread.evaluate((el) => el.remove());
await darkResults.click();
await eventually(async () => assert.ok((await squeezed()).every((l) => !l.over && !l.squeeze), 'a line that fits is left as set'));
// A right-to-left title reads right to left, so its "…" falls at its end; the page around it does not turn.
await apply([{ type: 'page.update', pageId: about.id, seoTitle: 'קורסי קדרות ליד הנהר: סדנאות סוף שבוע, השכרת תנור ושיעורים למתחילים ולוותיקים כאחד לאורך כל השנה' }], 'A Hebrew title');
const directions = () => view.locator('.serp').evaluate((el) => [el, el.querySelector('.serp-title'), el.querySelector('.serp-url')].map((n) => getComputedStyle(n).direction));
await eventually(async () => assert.deepEqual(await directions(), ['ltr', 'rtl', 'ltr']));
await apply([{ type: 'page.update', pageId: about.id, seoTitle: documents[0].seoTitle }], 'The title back');
// A dated post's title and description are cut exactly where the shared measurements cut them, on each screen.
const longDescription = 'Throw, glaze and fire with us at the spring open studio, with free taster sessions all weekend, a kiln tour, family clay tables, and tea on the riverside deck.';
await apply([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: longTitle, description: longDescription }], 'Long post text');
await row('Spring open studio').click();
for (const [name, lines, description] of [
  ['Computer', ['Hand-thrown pottery classes, kiln hire and open studio weekends…'], 'Throw, glaze and fire with us at the spring open studio, with free taster sessions all weekend, a kiln tour, family clay tables, and tea…'],
  ['Phone', ['Hand-thrown pottery classes, kiln', 'hire and open studio weekends…'], 'Throw, glaze and fire with us at the spring open studio, with free taster sessions all…']
]) {
  await screen(name).click();
  await eventually(async () => assert.deepEqual((await drawn()).lines.map((l) => l.text), lines, `${name}: the title’s lines`));
  assert.equal(await view.locator('.serp .serp-desc').innerText(), `Mar 2, 2027 — ${description}`, `${name}: the description`);
}
await screen('Computer').click();
await apply([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: documents[1].seoTitle, description: 'Throw, glaze and fire with us at the spring open studio, with free taster sessions all weekend.' }], 'The post’s text back');
await row('About').click();
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
await peekScreen('Phone');
await eventually(async () => assert.equal(await result('mobile').locator('.serp-title').innerText(), 'Glaze weekend'));
await peekScreen('Computer');
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
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-host').innerText(), 'journal.example', 'the card follows the canonical URL as it is typed'));
assert.equal((await entryNow('en_spring')).seo.canonical, undefined, 'nothing is saved while it is typed');
await canonicalBox.press('Escape');
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-host').innerText(), 'riverside.example', 'Escape puts the post’s own address back'));
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

step('a page’s Search & sharing settings sit beside its previews in the view, and typing shows in them before it is saved (#702)');
// About is the page under the view, with nothing selected on it: the Inspector shows its settings once the view goes.
const latest = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).at(-1)?.label ?? null);
const aboutPage = async () => (await snapshot()).state.pages[about.id];
const allSaved = () => eventually(async () => assert.equal(await win.locator('.toolbar .save-state').innerText(), 'Saved'));
const inspField = (id) => inspector.locator(`#page-seo-${id}`);
const pageField = (id) => view.locator(`#seo-view-${id}`);
const fieldAlert = (box) => box.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " field ")][1]').locator('[role="alert"]');
const meter = (kind) => view.locator(`.seo-meter[data-meter="${kind}"]`);
const countOf = (box) => box.locator('xpath=following-sibling::div[contains(@class, "field-count")][1]');
await eventually(async () => assert.equal(await inspected.innerText(), 'About', 'the Inspector shows About, the page on the canvas'));
assert.equal(await inspField('title').inputValue(), documents[0].seoTitle);
await rail('seo').click();
await row('About').click();
await eventually(async () => assert.equal(await pageField('title').inputValue(), documents[0].seoTitle, 'the view’s browser title holds the saved one'));
assert.equal(await inspector.locator('#page-seo-title').count(), 0, 'the page’s fields are in one place at a time: the Inspector names the view');
for (const id of ['description', 'noindex', 'canonical', 'updated']) assert.equal(await pageField(id).count(), 1, `the view has the page’s ${id} setting`);
assert.equal(await view.getByRole('switch', { name: 'Hide from site search' }).count(), 1, 'and whether the site’s own search lists it');
assert.equal(await view.locator('[data-seo-field="socialImage"]').count(), 1, 'and its sharing image');
assert.equal(await view.locator('#page-structured-type').count(), 1, 'and what it is for search engines');
// The surface is chosen before typing, so leaving the field for it can’t save what is being typed.
await surface('Search result').click();
const title = pageField('title');
await title.fill('');
await title.pressSequentially('Pot');
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Pot', 'the result follows each keystroke'));
assert.match(await meter('title').innerText(), /^3 characters/, 'and so does the title’s meter');
await title.pressSequentially('tery classes by the river');
await peekScreen('Phone');
await eventually(async () => assert.equal(await result('mobile').locator('.serp-title').innerText(), 'Pottery classes by the river'));
await peekScreen('Computer');
assert.match(await meter('title').innerText(), /^28 characters/);
assert.equal((await aboutPage()).seo.title, documents[0].seoTitle, 'nothing is saved while it is typed');
await title.press('Escape');
await eventually(async () => assert.equal(await title.inputValue(), documents[0].seoTitle, 'Escape puts the saved title back in the field'));
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), documents[0].seoTitle, 'and in the result'));
const description = pageField('description');
await description.fill('Wheel and hand-building classes by the river.');
await eventually(async () => assert.equal(await result('desktop').locator('.serp-desc').innerText(), 'Wheel and hand-building classes by the river.', 'the description being typed shows in the result'));
assert.match(await meter('description').innerText(), /^45 characters/);
await description.press('Escape');
await eventually(async () => assert.ok((await result('desktop').locator('.serp-desc').innerText()).includes(documents[0].description), 'Escape puts the saved description back'));
await surface('Link preview').click();
await title.fill('Wheel classes');
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-title').innerText(), 'Wheel classes', 'the link preview follows the title being typed'));
await title.press('Escape');
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-title').innerText(), documents[0].seoTitle));
const canonical = pageField('canonical');
await canonical.fill('https://journal.example/about/');
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-host').innerText(), 'journal.example', 'the link preview follows the canonical URL being typed'));
assert.equal((await aboutPage()).seo.canonical, undefined, 'nothing is saved while it is typed');
await canonical.press('Escape');
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-host').innerText(), 'riverside.example', 'Escape puts the page’s own address back'));
assert.equal(await canonical.inputValue(), '');
await surface('Search result').click();
await win.screenshot({ path: join(SHOTS, 'seo-view-settings.png') });

step('saved from the view with the Inspector’s operations and labels, and shown in the Inspector (#702)');
await title.fill('Pottery classes by the river');
await title.press('Enter');
await eventually(async () => assert.equal((await aboutPage()).seo.title, 'Pottery classes by the river', 'Enter saves the title'));
assert.equal(await latest(), 'Change browser title (About)', 'under the Inspector’s label');
await view.getByRole('switch', { name: 'Hide from search engines' }).click();
await eventually(async () => assert.equal((await aboutPage()).seo.noindex, true, 'the search engines switch saves'));
assert.equal(await latest(), 'Update page settings (About)');
await view.getByRole('switch', { name: 'Hide from site search' }).click();
await eventually(async () => assert.equal((await aboutPage()).seo.searchHidden, true, 'the site search switch saves'));
assert.equal(await latest(), 'Update page settings (About)');
await pageField('updated').fill('2026-11-20');
await pageField('updated').press('Enter');
await eventually(async () => assert.equal((await aboutPage()).updatedAt, '2026-11-20', 'the revision date saves'));
assert.equal(await latest(), 'Change revision date (About)');
await view.getByRole('button', { name: 'Clear last revised' }).click();
await eventually(async () => assert.equal((await aboutPage()).updatedAt, undefined, 'and clears'));
assert.equal(await latest(), 'Clear revision date (About)');
await view.locator('#page-structured-type').selectOption('Product');
await eventually(async () => assert.equal((await aboutPage()).seo.structuredData?.type, 'Product', 'the page type saves'));
await view.locator('#page-structured-price').fill('129');
await view.locator('#page-structured-price').press('Tab');
await eventually(async () => assert.equal((await aboutPage()).seo.structuredData?.price, '129', 'a structured fact saves'));
assert.equal(await latest(), 'Change price (About)');
// A focused description left by the sidebar’s shortcut is saved once, as a click away would save it.
await description.fill('Wheel and hand-building classes by the river.');
await win.keyboard.press(`${MOD}+\\`);
await eventually(async () => assert.equal(await holder.isVisible(), false, 'the shortcut leaves the view'));
await eventually(async () => assert.equal((await aboutPage()).seo.description, 'Wheel and hand-building classes by the river.', 'what was typed is saved'));
assert.equal(await latest(), 'Change page description (About)');
await allSaved();
await eventually(async () => assert.equal(await inspected.innerText(), 'About'));
assert.equal(await inspField('title').inputValue(), 'Pottery classes by the river', 'the Inspector shows what the view saved');
assert.equal(await inspField('description').inputValue(), 'Wheel and hand-building classes by the river.');
assert.equal(await inspector.getByRole('switch', { name: 'Hide from search engines' }).isChecked(), true);
assert.equal(await inspector.locator('#page-structured-price').inputValue(), '129');

step('saved from the Inspector, shown in the view; text refused in one place is kept, never dropped, by the other (#702)');
await inspField('title').fill('Pottery at Riverside');
await inspField('title').press('Enter');
await eventually(async () => assert.equal((await aboutPage()).seo.title, 'Pottery at Riverside'));
// A title too long to save, refused in the Inspector, is the view’s to shorten.
const tooLong = `${'Pottery classes '.repeat(8)}`.slice(0, 121);
await inspField('title').fill(tooLong);
await inspField('title').press('Enter');
await eventually(async () => assert.match(await countOf(inspField('title')).innerText(), /^Not saved/, 'the Inspector refuses it'));
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), true));
await eventually(async () => assert.equal(await title.inputValue(), tooLong, 'the view shows the refused title'));
assert.match(await countOf(title).innerText(), /^Not saved: 121 \/ 120/, 'still refused');
assert.equal((await aboutPage()).seo.title, 'Pottery at Riverside', 'and nothing of it is saved');
await title.press('Escape');
await eventually(async () => assert.equal(await title.inputValue(), 'Pottery at Riverside', 'Escape puts the Inspector’s saved title back in the view'));
// An address that can’t be a canonical URL, refused in the view while the caret is still in it, goes to the Inspector.
const original = 'https://journal.example/about/';
await canonical.fill(original);
await canonical.press('Enter');
await eventually(async () => assert.equal((await aboutPage()).seo.canonical, original, 'the canonical URL saves'));
assert.equal(await latest(), 'Change canonical URL (About)');
await canonical.fill('journal.example/about');
await win.keyboard.press(`${MOD}+\\`);
await eventually(async () => assert.equal(await holder.isVisible(), false));
await eventually(async () => assert.equal(await inspField('canonical').inputValue(), 'journal.example/about', 'the Inspector shows the refused address'));
assert.match(await fieldAlert(inspField('canonical')).innerText(), /Not saved/, 'with why it is not saved');
assert.equal((await aboutPage()).seo.canonical, original, 'nothing of it is saved');
// An undo of the saved address leaves the refused one where it is, and says what is saved now.
assert.ok((await win.evaluate(() => window.builder.project.undo())).ok);
await eventually(async () => assert.equal((await aboutPage()).seo.canonical, undefined, 'the saved address is undone'));
await eventually(async () => assert.match(await fieldAlert(inspField('canonical')).innerText(), /Nothing is saved here yet/));
assert.equal(await inspField('canonical').inputValue(), 'journal.example/about', 'the refused address stays through an undo');
// Back in the view, and on to another page: the refused address is About’s alone.
await rail('seo').click();
await eventually(async () => assert.equal(await canonical.inputValue(), 'journal.example/about', 'the view shows it again'));
assert.match(await fieldAlert(canonical).innerText(), /Not saved/);
await row(home.title).click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), home.title));
assert.equal(await canonical.inputValue(), '', 'Home’s canonical URL is its own');
assert.equal(await fieldAlert(canonical).count(), 0, 'with nothing refused');
await row('About').click();
await eventually(async () => assert.equal(await canonical.inputValue(), 'journal.example/about', 'About keeps its refused address'));
// Corrected to the address the undo took away, it is saved: the edit starts from what is saved now.
await canonical.fill(original);
await canonical.press('Enter');
await eventually(async () => assert.equal((await aboutPage()).seo.canonical, original, 'the corrected address is saved'));
assert.equal(await latest(), 'Change canonical URL (About)');
await eventually(async () => assert.equal(await fieldAlert(canonical).count(), 0, 'with nothing refused'));
await canonical.fill('journal.example/about');
await canonical.press('Enter');
await eventually(async () => assert.match(await fieldAlert(canonical).innerText(), /Not saved/));
await canonical.press('Escape');
await eventually(async () => assert.equal(await canonical.inputValue(), original, 'Escape puts the saved address back'));
assert.equal(await fieldAlert(canonical).count(), 0);
// The view is left on the post it had chosen before, as the steps after expect.
await row('Winter hours').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Winter hours'));
await rail('seo').click();
await eventually(async () => assert.equal(await holder.isVisible(), false));
await eventually(async () => assert.equal(await inspField('canonical').inputValue(), original, 'and the Inspector has nothing refused either'));
assert.equal(await fieldAlert(inspField('canonical')).count(), 0);
await allSaved();

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

step('a page opened in the view from its Inspector section, which keeps its fields and meters but no previews (#708)');
await apply([{ type: 'page.create', title: 'Kitchens', route: '/kitchens/', starter: 'intro' }], 'Add page');
const kitchensId = Object.values((await snapshot()).state.pages).find((p) => p.title === 'Kitchens').id;
const kitchensSeo = async () => (await snapshot()).state.pages[kitchensId].seo;
const inspSearch = inspector.locator('.section', { has: win.locator('button.section-head', { hasText: 'Search & sharing' }) });
const inspMeter = (kind) => inspSearch.locator(`.seo-meter[data-meter="${kind}"]`);
const openInView = inspSearch.getByRole('button', { name: 'Open in SEO view' });
/** Kitchens on the canvas, its settings in the Inspector, the view put away. */
const inspectKitchens = async () => {
  if ((await rail('pages').getAttribute('aria-pressed')) !== 'true') await rail('pages').click();
  await eventually(async () => assert.equal(await holder.isVisible(), false, 'the view is put away'));
  // Enter opens the page at once: a click waits to see whether it is a double click, and could open it after the view.
  await win.locator('.pages-list [role="option"]', { hasText: 'Kitchens' }).first().focus();
  await win.keyboard.press('Enter');
  await openInspector(win);
  await eventually(async () => assert.equal(await inspected.innerText(), 'Kitchens', 'the Inspector shows Kitchens'));
};
await inspectKitchens();
assert.equal(await inspSearch.getByRole('tab').count(), 0, 'the Inspector shows no previews of its own');
assert.equal(await inspSearch.locator('.serp, .share-card, [data-testid="seo-graph"]').count(), 0);
assert.equal(await inspSearch.getByRole('button', { name: 'Optimize with AI' }).count(), 1, 'Optimize with AI is still beside the settings');
assert.equal(await inspSearch.getByRole('button', { name: 'Optimize with AI' }).isEnabled(), true);
assert.equal(await inspMeter('title').innerText(), 'Default title: 27 characters · fits on computers and phones', 'the Inspector keeps the title meter');
assert.match(await inspMeter('description').innerText(), /^From the fallback: \d+ characters/, 'and the description meter');
await inspField('title').fill('Kitchens in oak');
await eventually(async () => assert.equal(await inspMeter('title').innerText(), '15 characters · fits on computers and phones', 'the meter follows the title as it is typed'));
await inspField('title').press('Escape');
await eventually(async () => assert.match(await inspMeter('title').innerText(), /^Default title:/));
await openInView.click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Kitchens', 'Open in SEO view opens the view on the page'));
assert.equal(await holder.isVisible(), true);
await eventually(async () => assert.equal(await back.evaluate((el) => el === document.activeElement), true, 'focus moves into the view'));

step('the search result and the title meter follow the browser title as it is typed, before it is saved (#597)');
await eventually(async () => assert.equal(await surfaceShown('Search result'), true));
await screen('Computer').click();
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Kitchens · Riverside Studio', 'a page without a title of its own is listed by its default'));
assert.equal(await result('desktop').locator('.serp-url').innerText(), 'riverside.example › kitchens', 'under its public address');
assert.equal(await meter('title').innerText(), 'Default title: 27 characters · fits on computers and phones', 'the meter measures the default title');
assert.match(await meter('description').innerText(), /^From the fallback: \d+ characters/, 'and the site’s description, which the page falls back to');
const kitchensTitle = 'Kitchens in oak, steel and stone, designed and built by hand in our Riverside workshop';
await title.fill(kitchensTitle);
await eventually(async () => assert.match(await result('desktop').locator('.serp-title').innerText(), /^Kitchens in oak, .*…$/, 'the title being typed is cut short with an ellipsis'));
assert.equal(await meter('title').innerText(), `${kitchensTitle.length} characters · likely cut short on computers and phones`);
assert.equal(await meter('title').getAttribute('data-tone'), 'cut');
assert.equal((await kitchensSeo()).title, undefined, 'nothing is saved while it is typed');
await title.press('Escape');
await eventually(async () => assert.match(await meter('title').innerText(), /^Default title:/, 'Escape puts the default back'));
await screen('Phone').click();
const phoneTitle = () => result('mobile').locator('.serp-title').innerText();
await eventually(async () => assert.equal(await phoneTitle(), 'Kitchens · Riverside Studio'));
await title.fill(kitchensTitle);
await eventually(async () => assert.match(await phoneTitle(), /^Kitchens in oak, [\s\S]*…$/, 'cut short on a phone too'));
await title.press('Escape');
await eventually(async () => assert.equal(await phoneTitle(), 'Kitchens · Riverside Studio', 'Escape puts the default back on a phone too'));
await allSaved();
assert.equal((await kitchensSeo()).title, undefined, 'nothing was saved while it was typed');
await screen('Computer').click();
// The results page holds its room when it comes back from another surface.
await surface('Link preview').click();
await surface('Search result').click();
await eventually(() => noSidewaysScroll('the search result shown again'));
assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Kitchens · Riverside Studio');
await description.fill('Oak, steel and stone kitchens, drawn and built by hand.');
await eventually(async () => assert.equal(await result('desktop').locator('.serp-desc').innerText(), 'Oak, steel and stone kitchens, drawn and built by hand.', 'the description being typed shows in the result'));
assert.equal(await meter('description').innerText(), '55 characters · fits on computers and phones', 'and is what the meter measures');
assert.equal((await kitchensSeo()).description, undefined, 'nothing is saved while it is typed');
await description.press('Escape');
await eventually(async () => assert.match(await meter('description').innerText(), /^From the fallback:/, 'Escape puts the fallback back'));
await win.screenshot({ path: join(SHOTS, 'seo-view-kitchens-search-result.png') });

step('the structured data follows the title and canonical URL as they are typed (#597)');
await surface('Structured data').click();
const graphOf = async () => JSON.parse(await graphShown.textContent());
const webPage = async () => (await graphOf())['@graph'].find((n) => n['@type'] === 'WebPage');
await eventually(async () => assert.deepEqual(await webPage().then((n) => ({ url: n.url, name: n.name })), { url: 'https://riverside.example/kitchens/', name: 'Kitchens · Riverside Studio' }), 20000);
assert.equal(await view.getByRole('region', { name: 'This page', exact: true }).isVisible(), true, 'the view says it in words');
const status = (id) => view.locator(`[data-status="${id}"] dd`);
assert.equal(await status('canonical').innerText(), 'https://riverside.example/kitchens/');
assert.equal(await status('search').innerText(), 'May list it');
assert.equal(await status('sitemap').innerText(), 'Listed');
await title.fill('Oak and steel kitchens · Riverside');
await eventually(async () => assert.equal((await webPage()).name, 'Oak and steel kitchens · Riverside', 'the graph names the page by the title being typed'));
assert.equal((await kitchensSeo()).title, undefined, 'still unsaved');
await title.press('Enter');
await eventually(async () => assert.equal((await kitchensSeo()).title, 'Oak and steel kitchens · Riverside', 'Enter saves it'));
await allSaved();
await canonical.fill('https://journal.example/kitchens/');
await eventually(async () => assert.equal(await status('canonical').innerText(), 'https://journal.example/kitchens/ (another address)', 'the canonical URL being typed shows in the status'));
assert.match(await status('sitemap').innerText(), /canonical URL names another address/, 'a copy leaves the sitemap to the original');
assert.equal(await status('structured').innerText(), 'Written into its page', 'and still carries its structured data');
assert.equal((await webPage()).url, 'https://riverside.example/kitchens/', 'its graph names the page by its own address');
assert.equal((await kitchensSeo()).canonical, undefined, 'nothing is saved while it is typed');
await canonical.press('Escape');
await eventually(async () => assert.equal(await status('canonical').innerText(), 'https://riverside.example/kitchens/', 'Escape puts the page’s own address back'));
// Text that is no address is never previewed as one: the status keeps the saved address.
await canonical.fill('journal.example/kitchens');
await win.waitForTimeout(500);
assert.equal(await status('canonical').innerText(), 'https://riverside.example/kitchens/', 'an unusable address leaves the status as saved');
await canonical.press('Escape');
await win.screenshot({ path: join(SHOTS, 'seo-view-kitchens-structured-data.png') });

step('a title refused for being too long is measured when the page is opened again, until Escape puts the saved one back (#597)');
const refusedTitle = `${'Oak kitchens '.repeat(10)}x`.slice(0, 121);
assert.equal(refusedTitle.length, 121);
await allSaved();
await surface('Search result').click();
await title.fill(refusedTitle);
await title.press('Tab');
await eventually(async () => assert.equal(await title.getAttribute('aria-invalid'), 'true', 'the title over the limit is refused and kept'));
await row('About').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'About'));
await row('Kitchens').click();
await eventually(async () => assert.equal(await title.inputValue(), refusedTitle, 'the refused title is shown again'));
await eventually(async () => assert.equal(await meter('title').innerText(), `${refusedTitle.trim().length} characters · likely cut short on computers and phones`, 'and the meter measures what the field shows'));
await title.click();
await title.press('Escape');
await eventually(async () => assert.match(await meter('title').innerText(), /^\d+ characters · fits on computers and phones$/, 'Escape puts the saved title back in the meter'));
assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Oak and steel kitchens · Riverside');

step('Open in SEO view from the Inspector saves what is being typed first, and carries text it could not save to the view (#708)');
await inspectKitchens();
await inspField('title').fill('Kitchens by the river');
await openInView.click();
await eventually(async () => assert.equal((await kitchensSeo()).title, 'Kitchens by the river', 'what was typed is saved'));
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Kitchens'));
await eventually(async () => assert.equal(await title.inputValue(), 'Kitchens by the river', 'the view’s field shows it'));
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Kitchens by the river', 'and so does its result'));
await allSaved();
await inspectKitchens();
await inspField('title').fill(refusedTitle);
// Pressed without taking focus from the field (as a click that takes none would): the button leaves it itself.
await openInView.dispatchEvent('click');
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Kitchens'));
await eventually(async () => assert.equal(await title.inputValue(), refusedTitle, 'text too long to save goes with the field to the view'));
assert.match(await countOf(title).innerText(), /^Not saved: 121 \/ 120/, 'still refused');
assert.equal((await kitchensSeo()).title, 'Kitchens by the river', 'and nothing of it is saved');
await title.click();
await title.press('Escape');
await eventually(async () => assert.equal(await title.inputValue(), 'Kitchens by the river', 'Escape puts the saved title back'));

step('a post’s search result, link preview and structured data follow what is typed before it is saved (#597)');
const left = 'Winter light on the water '.repeat(4).trim();
const right = 'Winter light on the water '.repeat(4).trim().slice(0, 96);
const fullTitle = `${left} ${right}`;
await apply(
  [
    { type: 'site.update', baseUrl: '' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_raku', title: fullTitle, slug: 'raku', publishedAt: '2025-06-01', draft: false }
  ],
  'A long post, no public URL'
);
const rakuSeo = async () => (await entryNow('en_raku')).seo ?? {};
await row(left).click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), fullTitle));
const postTitle = viewField('Browser title');
const postDescription = viewField('Description');
const postCanonical = viewField('Canonical URL');
await eventually(async () => assert.equal(await surfaceShown('Search result'), true, 'the previews open on the search result'));
await screen('Computer').click();
await eventually(async () => assert.match(await result('desktop').locator('.serp-title').innerText(), /^Winter light on the water .*…$/, 'the long default title is cut short with an ellipsis'));
assert.match(await viewMeter('title').innerText(), /^Default title: \d+ characters · likely cut short on computers and phones$/, 'the meter measures the default title');
assert.match(await result('desktop').locator('.serp-date').innerText(), /2025 — $/, 'a dated post opens its description with its date');
await postTitle.fill('Raku notes');
await eventually(async () => assert.equal(await result('desktop').locator('.serp-title').innerText(), 'Raku notes', 'the result follows the title as it is typed'));
assert.equal(await viewMeter('title').innerText(), '10 characters · short: 15 to 60 reads best');
assert.equal((await rakuSeo()).title, undefined, 'nothing is saved while it is typed');
await postTitle.press('Escape');
await eventually(async () => assert.match(await viewMeter('title').innerText(), /^Default title:/, 'Escape puts the default back'));
await screen('Phone').click();
await eventually(async () => assert.match(await phoneTitle(), /^Winter light on the water [\s\S]*…$/));
await postTitle.fill('Glaze diary');
await eventually(async () => assert.equal(await phoneTitle(), 'Glaze diary', 'and on a phone'));
await postTitle.press('Escape');
await eventually(async () => assert.match(await phoneTitle(), /^Winter light on the water [\s\S]*…$/, 'Escape puts the default back on a phone too'));
assert.equal((await rakuSeo()).title, undefined, 'nothing was saved while it was typed');
await screen('Computer').click();
await postDescription.fill('Notes from a weekend of raku firing.');
await eventually(async () => assert.match(await result('desktop').locator('.serp-desc').innerText(), /— Notes from a weekend of raku firing\.$/, 'the description being typed follows the date in the result'));
assert.equal(await viewMeter('description').innerText(), '36 characters · short: 50 to 160 reads best');
assert.equal((await rakuSeo()).description, undefined, 'nothing is saved while it is typed');
await postDescription.press('Escape');
await eventually(async () => assert.match(await viewMeter('description').innerText(), /^From the fallback:/, 'Escape puts the fallback back'));
await surface('Link preview').click();
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-title').textContent(), fullTitle, 'a shared link shows the post’s own title, without the site’s name'));
assert.equal(await card('Facebook').locator('.share-card-host').textContent(), 'No usable public URL');
await postTitle.fill('Raku firing notes from the weekend');
await eventually(async () => assert.equal(await card('Facebook').locator('.share-card-title').textContent(), 'Raku firing notes from the weekend', 'the card follows the title as it is typed'));
await postTitle.press('Enter');
await eventually(async () => assert.equal((await rakuSeo()).title, 'Raku firing notes from the weekend', 'Enter saves it'), 20000);
await surface('Structured data').click();
await eventually(async () => assert.match(await view.locator('.seo-graph-none').innerText(), /Public URL/, 'without a public URL the post carries no structured data, and says why'));
assert.equal(await status('search').innerText(), 'May list it');
assert.equal(await status('siteSearch').innerText(), 'May find it', 'Site search finds a published post');
await apply([{ type: 'site.update', baseUrl: 'https://riverside.example' }], 'Set public URL');
await eventually(async () => {
  const node = (await webPage()) ?? {};
  assert.deepEqual({ url: node.url, name: node.name }, { url: 'https://riverside.example/blog/raku/', name: 'Raku firing notes from the weekend' }, 'the post’s structured data names it by its address and its title');
}, 20000);
assert.equal(await view.getByRole('region', { name: 'Blog post', exact: true }).isVisible(), true, 'the view says it in words');
await postTitle.fill('Raku notes from the kiln');
await eventually(async () => assert.equal((await webPage()).name, 'Raku notes from the kiln', 'the graph follows the title as it is typed'));
assert.equal((await rakuSeo()).title, 'Raku firing notes from the weekend', 'nothing new is saved while it is typed');
await postTitle.press('Escape');
await eventually(async () => assert.equal((await webPage()).name, 'Raku firing notes from the weekend', 'Escape puts the saved title back in the graph'));
await postCanonical.fill('https://journal.example/raku/');
await eventually(async () => assert.equal(await status('canonical').innerText(), 'https://journal.example/raku/ (another address)', 'the canonical URL being typed shows in the status'));
assert.match(await status('sitemap').innerText(), /another address/);
assert.equal((await rakuSeo()).canonical, undefined, 'nothing is saved while it is typed');
await postCanonical.press('Escape');
await eventually(async () => assert.equal(await status('canonical').innerText(), 'https://riverside.example/blog/raku/', 'Escape puts the post’s own address back'));
await win.screenshot({ path: join(SHOTS, 'seo-view-post-typing.png') });
await surface('Search result').click();
await allSaved();

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
// The other way about, so neither choice is one the editor always comes back with; and in a light editor the dark
// results page leaves the editor light.
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'light' }));
await eventually(async () => assert.equal(await win.evaluate(() => document.documentElement.dataset.appearance), 'light'));
const chrome = () => view.evaluate((el) => getComputedStyle(el.closest('.seo-view-holder')).backgroundColor);
const lightChrome = await chrome();
await darkResults.click();
await eventually(async () => assert.equal((await drawn()).background, LIGHT));
await darkResults.click();
await eventually(async () => assert.equal((await drawn()).background, DARK));
assert.equal(await chrome(), lightChrome, 'the toggle switches the preview alone');
assert.equal(await win.evaluate(() => document.documentElement.dataset.appearance), 'light');
await darkResults.click();
await screen('Computer').click();
await win.reload();
await win.waitForSelector('.editor');
if ((await rail('seo').getAttribute('aria-pressed')) !== 'true') await rail('seo').click();
await panel.locator('.seo-open', { hasText: 'About' }).first().click();
await eventually(async () => assert.equal(await screen('Computer').getAttribute('aria-checked'), 'true', 'the computer is chosen again'));
assert.equal(await darkResults.getAttribute('aria-checked'), 'false', 'and the light results');
assert.equal((await drawn()).background, LIGHT);

step('the structured data in words: a typed page and a post, what is missing with its fix, and the exact JSON-LD a click away (#706)');
await apply([{ type: 'page.update', pageId: about.id, structuredData: { type: 'Product', price: '12' } }], 'Type the page');
const entity = (name) => view.getByRole('region', { name, exact: true });
const problem = view.locator('.seo-data-problem');
const jsonBlock = view.locator('details.seo-json');
const jsonOpen = () => jsonBlock.evaluate((el) => el.open);
await row('About').click();
await surface('Structured data').click();
await eventually(async () => assert.equal(await problem.getAttribute('data-code'), 'SEO_PAGE_STRUCTURED_DATA_INCOMPLETE'), 20000);
assert.match(await problem.innerText(), /marked as a Product.*Add the currency\./s, 'it says what the product still needs');
assert.match(await problem.innerText(), /compare services, products, events and guides/, 'and why it matters');
assert.equal(await entity('Product').count(), 0, 'and the product is not described until then');
assert.match(await entity('This page').innerText(), /This is a web page\./);
assert.match(await entity('Publisher').innerText(), /Riverside Studio, an organization, publishes the site\./);
assert.match(await entity('Breadcrumb trail').innerText(), /About/);
assert.equal(await jsonOpen(), false, 'the JSON-LD starts closed');
assert.equal(await graphShown.isVisible(), false);
// Where the page is published stays at the top, above what is missing and what the data says.
const topOf = async (locator) => (await locator.boundingBox()).y;
assert.ok((await topOf(view.locator('.seo-status'))) < (await topOf(problem)), 'the publishing status is first');
assert.ok((await topOf(problem)) < (await topOf(entity('This page'))), 'then what is missing');
await problem.getByRole('button', { name: 'Go to Structured data' }).click();
await eventually(async () => assert.equal(await holder.isVisible(), false, 'the link leaves the view'));
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.id), 'page-structured-type', 'for the page’s Structured data setting'), 20000);
assert.equal(await inspected.innerText(), 'About', 'of the page the view was on');
assert.equal(await win.locator('#page-structured-type').inputValue(), 'Product');
await rail('seo').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'About'));
await apply([{ type: 'page.update', pageId: about.id, structuredData: { currency: 'ZAR' } }], 'Complete the facts');
await surface('Structured data').click();
await eventually(async () => assert.match(await entity('Product').innerText(), /The page is about the product “About”\..*12 ZAR/s), 20000);
assert.equal(await problem.count(), 0, 'nothing is missing');
await jsonBlock.locator('summary').click();
assert.equal(await graphShown.isVisible(), true, 'the JSON-LD is one click away');
const shownJson = await graphShown.textContent();
assert.equal(shownJson, JSON.stringify(JSON.parse(shownJson)).replace(/</g, '\\u003c'), 'as the text of the exported page’s script');
assert.ok(await graphShown.evaluate((el) => el.scrollWidth <= el.clientWidth), 'wrapped, so it never scrolls sideways');
assert.deepEqual(await entity('Breadcrumb trail').getByRole('listitem').allInnerTexts().then((all) => all.map((t) => t.split('\n')[0])), ['Home', 'About'], 'the trail in order');
await apply([{ type: 'page.update', pageId: about.id, structuredData: { price: '14' } }], 'Change the price');
await eventually(async () => assert.match(await entity('Product').innerText(), /14 ZAR/), 20000);
assert.equal(await jsonOpen(), true, 'an edit leaves the open JSON-LD open');
assert.equal(JSON.parse(await graphShown.textContent())['@graph'].find((n) => n['@type'] === 'Product')?.offers.price, '14');
const wide = await view.evaluate((el) => [el.querySelector('.seo-scroll')].map((n) => ({ scroll: n.scrollWidth, client: n.clientWidth }))[0]);
assert.ok(wide.scroll <= wide.client, `the structured data: nothing scrolls sideways (${JSON.stringify(wide)})`);
await win.screenshot({ path: join(SHOTS, 'seo-view-structured-data-words.png') });
// A page title left blank (only an edit made outside its field can) names no product, and the link goes to the title.
await apply([{ type: 'page.update', pageId: about.id, title: '   ' }], 'Blank the title');
await eventually(async () => assert.match(await problem.innerText(), /until the page has a title/), 20000);
assert.equal(await entity('Product').count(), 0);
await problem.getByRole('button', { name: 'Go to page title' }).click();
await eventually(async () => assert.equal(await win.evaluate(() => !!document.activeElement?.closest('[data-seo-field="pageTitle"]') && document.activeElement.tagName), 'INPUT', 'the page’s Title has the cursor'), 20000);
await apply([{ type: 'page.update', pageId: about.id, title: 'About' }], 'Name the page again');
await rail('seo').click();
await row('Spring open studio').click();
await eventually(async () => assert.equal(await view.locator('.seo-title').innerText(), 'Spring open studio'));
await surface('Structured data').click();
await eventually(async () => assert.match(await entity('Blog post').innerText(), /“Spring open studio”.*Published\s+2 March 2027/s), 20000);
assert.match(await entity('Blog post').innerText(), /Publisher\s+Riverside Studio/);
assert.match(await entity('Breadcrumb trail').innerText(), /Spring open studio/);
assert.equal(await jsonOpen(), false, 'another document’s JSON-LD starts closed');
await apply([{ type: 'page.update', pageId: about.id, structuredData: { type: 'WebPage' } }], 'A web page again');
await noWindowShown('the end of the run');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nseo-view: passed');
