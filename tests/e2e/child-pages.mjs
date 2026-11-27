// Child pages (#169): Lookbook is added from the Pages panel and Kitchens is added inside it from Lookbook's
// options, previewed at /lookbook/kitchens/. Pages lists Kitchens under Lookbook, and its header link lands under
// Lookbook's, which Edit menu shows and can undo and redo without touching the page. Kitchens then moves into Work
// from its page settings: Pages lists it apart from Work until Move under puts it there, and the menu stays as it
// was. The static export, served under /studio/, loads the nested address directly, sends the old address on to the
// new one, and its submenu works by keyboard (Enter, Space, Tab, Escape), by pointer and by touch at phone width.
// A page titled お問い合わせ (#36) previews and gets that address, takes another typed in Japanese in Page address,
// and the editor follows a visitor's link to it in Preview; the export has it at /studio/お問い合わせ/, escaped in
// the sitemap, and its old address sends visitors on. An address is kept working only once an export published it
// (#890), so the site is exported before each move whose old address is followed, and an address that can't be one
// is refused beside the field.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { chromium } from 'playwright';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('child-pages');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => {
  window.__appliedRevisions = [];
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'revisionApplied' && Number.isSafeInteger(event.data.payload?.revision)) window.__appliedRevisions.push(event.data.payload.revision);
  });
});

let root = null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.xml': 'application/xml', '.txt': 'text/plain' };
// A static host serving the export under /studio/, as a site published below its domain's root.
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const send = (status, body, type = 'text/plain') => (res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }), res.end(body));
  if (!root || !path.startsWith('/studio/')) return send(404, 'Not found');
  let file = normalize(join(root, path.slice('/studio/'.length)));
  const rel = relative(root, file);
  if (rel.startsWith('..') || isAbsolute(rel)) return send(404, 'Not found');
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!path.endsWith('/')) return (res.writeHead(301, { location: `${path}/` }), res.end());
    file = join(file, 'index.html');
  }
  if (!existsSync(file)) return send(404, 'Not found');
  send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
let browser = null;

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const pageBy = async (title) => Object.values((await snapshot()).state.pages).find((p) => p.title === title);
const menuRows = async () => {
  const s = (await snapshot()).state;
  const header = s.site.shell.header;
  return header.nodes[header.rootIds[0]].props.links.map((i) => ({ id: i.id, row: `${i.sub ? '  ' : ''}${i.label}`, target: i.link?.target }));
};
const pagesPanel = () => win.locator('.side-panel-view:not([hidden]) .pages-list');
const pageRow = (title) => pagesPanel().locator('[data-page]', { hasText: title }).first();
const outline = () => pagesPanel().locator('[data-page]').evaluateAll((rows) => rows.map((r) => `${'  '.repeat(Number(r.style.getPropertyValue('--depth') || 0))}${r.querySelector('.page-title').textContent}`));
const inspector = () => win.locator('#dock-panel-inspect');

try {
  const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  const site = await apply([{ type: 'site.update', baseUrl: 'https://example.test/studio/' }], 'Set the public address');
  assert.equal(site.ok, true, 'the site is published under /studio/');
  if ((await win.locator('.rail [aria-label="Pages"]').getAttribute('aria-pressed')) !== 'true') await win.locator('.rail [aria-label="Pages"]').click();

  step('add Lookbook, then Kitchens inside it from Lookbook’s options');
  await win.locator('.pages-head-add').click();
  await win.getByLabel('New page title').fill('Lookbook');
  assert.equal(await win.locator('#pages-add-route .value').innerText(), '/lookbook/', 'a page added from the header is at the top level');
  await win.locator('.pages-add-actions .btn-primary').click();
  await eventually(async () => assert.ok(await pageBy('Lookbook'), 'Lookbook exists'));
  await pageRow('Lookbook').hover();
  await pageRow('Lookbook').getByRole('button', { name: 'Lookbook options' }).click();
  await win.getByRole('menuitem', { name: 'Add page inside' }).click();
  const lookbook = await pageBy('Lookbook');
  assert.equal(await win.locator('#pages-add-inside').inputValue(), lookbook.id, 'the form starts inside Lookbook');
  await win.getByLabel('New page title').fill('Kitchens');
  assert.equal(await win.locator('#pages-add-route .value').innerText(), '/lookbook/kitchens/', 'the address previews inside Lookbook');
  assert.match(await win.locator('.pages-add-form').innerText(), /Add to header menu, under Lookbook/, 'the form says where the menu link goes');
  // A page inside another starts out of the menu; asked for, its link goes under its parent's.
  const navBox = win.locator('.pages-add-form').getByRole('checkbox', { name: /Add to header menu/ });
  assert.equal(await navBox.isChecked(), false, 'a page inside another is left out of the menu unless asked');
  await navBox.check();
  await win.locator('.pages-add-actions .btn-primary').click();
  await eventually(async () => assert.equal((await pageBy('Kitchens'))?.route, '/lookbook/kitchens/', 'Kitchens gets the previewed address'));
  const kitchens = await pageBy('Kitchens');

  step('Pages shows Kitchens inside Lookbook, and the header menu groups its link under Lookbook’s');
  await eventually(async () => assert.deepEqual(await outline(), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']));
  assert.equal(await pageRow('Kitchens').getAttribute('aria-description'), '/lookbook/kitchens/, in Lookbook');
  const titleX = async (title) => (await pageRow(title).locator('.page-title').boundingBox()).x;
  assert.ok((await titleX('Kitchens')) >= (await titleX('Lookbook')) + 12, 'Kitchens is shown indented under Lookbook');
  const rows = await menuRows();
  assert.deepEqual(rows.map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']);
  const kitchensItem = rows.find((r) => r.target === kitchens.id);

  step('Edit menu shows the grouping, and ungrouping the link leaves the page where it is');
  await win.locator('.pages-head-menu').click();
  const list = inspector().locator('[data-list="links"]');
  const nested = list.locator('.list-editor-item.nested');
  await eventually(async () => assert.equal(await nested.count(), 1, 'one link is under another'));
  assert.match(await nested.locator('.title').innerText(), /Kitchens/);
  assert.match(await nested.locator('.list-editor-meta').first().innerText(), /Under Lookbook/);
  await nested.locator('.title').click();
  const sub = nested.getByRole('switch', { name: 'Show under the link above' });
  assert.equal(await sub.getAttribute('aria-checked'), 'true');
  await sub.click();
  await eventually(async () => assert.deepEqual((await menuRows()).map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', 'Kitchens']));
  // The project holds the change before this window hears of it: the list follows once it does.
  await eventually(async () => assert.equal(await list.locator('.list-editor-item.nested').count(), 0, 'the row is no longer shown under Lookbook'));
  assert.equal((await pageBy('Kitchens')).route, '/lookbook/kitchens/', 'the page stays inside Lookbook');
  await list.locator('.list-editor-item', { hasText: 'Kitchens' }).getByRole('switch', { name: 'Show under the link above' }).click();
  await eventually(async () => assert.deepEqual((await menuRows()).map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']));

  step('a first export publishes Kitchens at /lookbook/kitchens/, so the address is kept working when it moves');
  const firstExport = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), join(WORK, 'export-first')), 300000, 'First export');
  assert.equal(firstExport.ok, true, `the first export succeeds: ${firstExport.message}`);

  step('move Kitchens into Work from its page settings: Move under lists it in Work, the menu stays as it was');
  const work = await apply([{ type: 'page.create', title: 'Work', route: '/work/', starter: 'intro' }], 'Add page Work');
  assert.equal(work.ok, true);
  const workId = work.results[0].pageId;
  await pageRow('Kitchens').hover();
  await pageRow('Kitchens').getByRole('button', { name: 'Kitchens options' }).click();
  await win.getByRole('menuitem', { name: 'Page settings' }).click();
  const inside = inspector().getByRole('button', { name: /^Inside page:/ });
  await eventually(async () => assert.equal(await inside.innerText(), 'Lookbook', 'page settings say Kitchens is inside Lookbook'));
  await inside.click();
  // Each place says the address the page would take there.
  const workChoice = win.getByRole('menuitemradio', { name: /^Work/ });
  assert.match(await workChoice.innerText(), /\/work\/kitchens\//);
  await workChoice.click();
  await eventually(async () => assert.equal((await pageBy('Kitchens')).route, '/work/kitchens/', 'Kitchens moves into Work'));
  // Its place in the page order is unchanged, before Work: Pages says so and offers to list it under Work.
  await eventually(async () => assert.deepEqual(await outline(), ['Home', 'About', 'Contact', 'Lookbook', 'Kitchens', 'Work']));
  assert.match(await pageRow('Kitchens').innerText(), /Listed apart from Work/);
  await pageRow('Kitchens').hover();
  await pageRow('Kitchens').getByRole('button', { name: 'Kitchens options' }).click();
  await win.getByRole('menuitem', { name: 'Move under Work' }).click();
  await eventually(async () => assert.deepEqual(await outline(), ['Home', 'About', 'Contact', 'Lookbook', 'Work', '  Kitchens']));
  assert.equal(await pageRow('Kitchens').getAttribute('aria-description'), '/work/kitchens/, in Work');
  const after = await menuRows();
  assert.deepEqual(after.map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens'], 'the menu link stays under Lookbook');
  assert.equal(after.find((r) => r.target === kitchens.id)?.id, kitchensItem.id, 'it is the same link, still leading to Kitchens');
  assert.deepEqual((await snapshot()).state.site.redirects, [{ from: '/lookbook/kitchens/', pageId: kitchens.id }], 'the old address keeps leading to Kitchens');

  step('a page titled in Japanese gets its natural address, and another one typed in Page address');
  const menuBefore = (await menuRows()).map((r) => r.row);
  await win.locator('.pages-head-add').click();
  await win.getByLabel('New page title').fill('お問い合わせ');
  assert.equal(await win.locator('#pages-add-route .value').innerText(), '/お問い合わせ/', 'the address previews as the title reads');
  // Left out of the menu, so the menu the keyboard steps below walk through stays as it is.
  await win.locator('.pages-add-form').getByRole('checkbox', { name: /Add to header menu/ }).uncheck();
  await win.locator('.pages-add-actions .btn-primary').click();
  await eventually(async () => assert.equal((await pageBy('お問い合わせ'))?.route, '/お問い合わせ/', 'the page gets the previewed address'));
  const contactJa = await pageBy('お問い合わせ');
  assert.deepEqual((await menuRows()).map((r) => r.row), menuBefore);
  await pageRow('お問い合わせ').hover();
  await pageRow('お問い合わせ').getByRole('button', { name: 'お問い合わせ options' }).click();
  await win.getByRole('menuitem', { name: 'Page settings' }).click();
  const addressField = inspector().getByLabel('Page address');
  await eventually(async () => assert.equal(await addressField.inputValue(), '/お問い合わせ/'));
  // An address that can't be one is refused beside the field, in the field's own words, and what was typed stays.
  await addressField.fill('/bad!/');
  await addressField.press('Enter');
  await eventually(async () => assert.match(await inspector().locator('.field-error').innerText(), /"bad!" can’t be part of an address/, 'the reason is given beside the field'));
  assert.equal(await addressField.inputValue(), '/bad!/', 'the typed address stays in the field');
  assert.equal((await pageBy('お問い合わせ')).route, '/お問い合わせ/', 'nothing is saved');
  await addressField.press('Escape');
  await eventually(async () => assert.equal(await addressField.inputValue(), '/お問い合わせ/', 'Escape puts the saved address back'));
  // One typed, one copied from a browser's address bar with its escapes.
  for (const [typed, route] of [['/連絡先/', '/連絡先/'], [encodeURI('/お問い合わせ/'), '/お問い合わせ/']]) {
    await addressField.fill(typed);
    await addressField.press('Enter');
    await eventually(async () => assert.equal((await pageBy('お問い合わせ')).route, route, `the address ${typed} is kept as ${route}`));
    await eventually(async () => assert.equal(await addressField.inputValue(), route, 'the field shows the address the page has'));
    if (route !== '/連絡先/') continue;
    // Published at /連絡先/ before it moves back, so that address is kept working.
    const published = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), join(WORK, 'export-second')), 300000, 'Second export');
    assert.equal(published.ok, true, `the second export succeeds: ${published.message}`);
  }
  assert.deepEqual((await snapshot()).state.site.redirects.find((r) => r.pageId === contactJa.id), { from: '/連絡先/', pageId: contactJa.id }, 'the address it left keeps leading to it');

  step('in Preview, the editor follows a visitor to the page, and back');
  await pageRow('Home').click();
  const frameAt = () => frame.locator('html').evaluate(() => decodeURI(location.pathname));
  await eventually(async () => assert.equal(await frameAt(), '/'), 30000);
  await win.locator('button[title^="Preview:"]').click();
  const pill = win.getByRole('group', { name: 'Preview', exact: true });
  const pageShown = win.locator('.project-title .page');
  await eventually(async () => assert.ok(await win.evaluate((revision) => window.__appliedRevisions.includes(revision), (await win.evaluate(() => window.builder.project.snapshot())).revision), 'the preview has applied the Japanese page'), 30000);
  await eventually(async () => assert.equal(await frame.locator('html').evaluate((html) => document.readyState === 'complete' && !html.hasAttribute('data-so-editing')), true, 'the page is ready for a visitor'), 30000);
  // A link the site's own router follows, as a visitor's click on a link to the page would be.
  await frame.locator('body').evaluate((body) => {
    const a = document.createElement('a');
    a.id = 'to-contact-ja';
    a.href = '/お問い合わせ/';
    a.textContent = 'お問い合わせ';
    a.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9999';
    (body.querySelector('main') ?? body).append(a);
  });
  await frame.locator('#to-contact-ja').evaluate((a) => a.click());
  await eventually(async () => {
    assert.equal(await frameAt(), '/お問い合わせ/', 'the frame is there');
    assert.equal(await pill.locator('output').innerText(), '/お問い合わせ/', 'the pill shows the address as written');
    assert.match(await pageShown.innerText(), /お問い合わせ/, 'the toolbar follows the page');
  }, 15000);
  await pill.getByRole('button', { name: 'Back', exact: true }).click();
  await eventually(async () => {
    assert.equal(await frameAt(), '/');
    assert.match(await pageShown.innerText(), /Home/, 'Back brings the editor home with the visitor');
  }, 15000);
  await win.locator('button[title^="Preview:"]').click();

  step('static export, served under /studio/');
  root = join(WORK, 'export');
  const r = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), root), 300000, 'Static export');
  assert.equal(r.ok, true, `static export succeeds: ${r.message} ${r.warnings?.join(' ') ?? ''}`);
  const served = await (await fetch(`${ORIGIN}/studio/work/kitchens/`)).text();
  assert.match(served, /<h1[^>]*>\s*Kitchens\s*</, 'the nested address loads directly, with its content in the first HTML');
  assert.match(served, /<ul id="so-sub:[^"]+" class="so-header__sub[^"]*"[^>]*hidden/, 'the submenu is in the HTML, hidden until opened');
  assert.doesNotMatch(served, /data-so-|siteorigin-bridge/, 'no editor instrumentation');
  assert.ok(existsSync(join(root, 'お問い合わせ', 'index.html')), 'the page in Japanese is written at its address as written');
  const servedJa = await fetch(`${ORIGIN}/studio/${encodeURI('お問い合わせ')}/`);
  assert.equal(servedJa.status, 200);
  assert.match(await servedJa.text(), /<h1[^>]*>\s*お問い合わせ\s*</, 'its address loads directly');
  const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes(`<loc>https://example.test/studio${encodeURI('/お問い合わせ/')}</loc>`), 'the sitemap lists it escaped');

  browser = await chromium.launch();
  /** Wait until the header has hydrated: once mounted, it publishes its height on the page root. */
  const hydrated = (page) => page.waitForFunction(() => document.documentElement.style.getPropertyValue('--so-header-offset') !== '', null, { timeout: 30000 });
  const expanded = (toggle) => toggle.getAttribute('aria-expanded');
  // The phone menu is a native disclosure: its open attribute is its state.
  const menuOpen = (p) => p.evaluate(() => document.querySelector('.so-header__menu').open);
  const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  const hasFocus = (locator) => locator.evaluate((el) => el === document.activeElement);

  step('the old address sends visitors on to the new one');
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await desktop.newPage();
  await page.goto(`${ORIGIN}/studio/lookbook/kitchens/`);
  await page.waitForURL(`${ORIGIN}/studio/work/kitchens/`, { timeout: 20000 });
  assert.equal((await page.locator('main h1').first().innerText()).trim(), 'Kitchens');
  await page.goto(`${ORIGIN}/studio/${encodeURI('連絡先')}/`);
  await page.waitForURL(`${ORIGIN}/studio/${encodeURI('お問い合わせ')}/`, { timeout: 20000 });
  assert.equal((await page.locator('main h1').first().innerText()).trim(), 'お問い合わせ');

  step('desktop: Enter, Tab and Escape; Space; focus and pointer leaving close it');
  await page.goto(`${ORIGIN}/studio/`, { waitUntil: 'networkidle' });
  await hydrated(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const toggle = nav.getByRole('button', { name: 'Lookbook submenu' });
  const kitchensLink = nav.getByRole('link', { name: 'Kitchens', exact: true });
  assert.equal(await kitchensLink.isVisible(), false, 'the submenu starts closed');
  // From the Lookbook link, Tab reaches its button next, and the closed submenu's links are skipped after it.
  await nav.getByRole('link', { name: 'Lookbook', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await hasFocus(toggle), true, 'Tab moves from the link to its submenu button');
  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Book a call', 'the closed submenu is skipped');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await eventually(async () => assert.equal(await expanded(toggle), 'true', 'Enter opens it'));
  assert.equal(await kitchensLink.isVisible(), true);
  await page.keyboard.press('Tab');
  assert.equal(await focusedText(page), 'Kitchens', 'Tab moves into the submenu');
  await page.keyboard.press('Escape');
  await eventually(async () => assert.equal(await expanded(toggle), 'false', 'Escape closes it'));
  await eventually(async () => assert.equal(await kitchensLink.isVisible(), false, 'the closed submenu is hidden'));
  assert.equal(await hasFocus(toggle), true, 'focus is back on its button');
  await page.keyboard.press('Space');
  await eventually(async () => assert.equal(await expanded(toggle), 'true', 'Space opens it'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await eventually(async () => assert.equal(await expanded(toggle), 'false', 'tabbing out of it closes it'));
  await toggle.click();
  await eventually(async () => assert.equal(await expanded(toggle), 'true'));
  await page.mouse.click(640, 600);
  await eventually(async () => assert.equal(await expanded(toggle), 'false', 'a click elsewhere closes it'));
  await nav.getByRole('link', { name: 'Lookbook', exact: true }).click();
  await page.waitForURL(`${ORIGIN}/studio/lookbook/`);
  await hydrated(page);
  await toggle.click();
  await kitchensLink.click();
  await page.waitForURL(`${ORIGIN}/studio/work/kitchens/`);
  assert.equal(await expanded(toggle), 'false', 'choosing a link closes the submenu');
  assert.deepEqual(await nav.locator('[aria-current="page"]').allInnerTexts(), ['Kitchens'], 'only the open page is marked current');
  assert.equal(await nav.locator('li.so-header__group--current').count(), 1, 'its parent link is marked as the section');
  const color = (l) => l.evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(await color(nav.getByRole('link', { name: 'Lookbook', exact: true })), await color(nav.getByRole('link', { name: 'About', exact: true })), 'the section link stands out from the others');
  // Choosing the page already open changes no address, and still closes the submenu.
  await toggle.click();
  await eventually(async () => assert.equal(await expanded(toggle), 'true'));
  await kitchensLink.click();
  await eventually(async () => assert.equal(await expanded(toggle), 'false', 'choosing the open page closes the submenu'));
  assert.equal(page.url(), `${ORIGIN}/studio/work/kitchens/`);

  step('phone: taps open and close the menu and its submenu');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mobile = await phone.newPage();
  await mobile.goto(`${ORIGIN}/studio/`, { waitUntil: 'networkidle' });
  await hydrated(mobile);
  const menuButton = mobile.locator('.so-header__toggle');
  const mNav = mobile.getByRole('navigation', { name: 'Main' });
  const mToggle = mNav.getByRole('button', { name: 'Lookbook submenu' });
  const mKitchens = mNav.getByRole('link', { name: 'Kitchens', exact: true });
  await menuButton.tap();
  await eventually(async () => assert.equal(await menuOpen(mobile), true, 'the menu opens'));
  const cta = mNav.getByRole('link', { name: 'Book a call' });
  const ctaBefore = (await cta.boundingBox()).y;
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'true', 'a tap opens the submenu'));
  assert.equal(await mKitchens.isVisible(), true);
  const box = await mKitchens.boundingBox();
  const toggleBox = await mToggle.boundingBox();
  assert.ok(box.y >= toggleBox.y + toggleBox.height - 1, 'the submenu opens in place, below its link');
  assert.ok((await cta.boundingBox()).y >= ctaBefore + box.height, 'what follows in the menu moves down to make room');
  // Escape closes the submenu first, back to its button, then the menu, back to the menu button.
  await mobile.keyboard.press('Escape');
  await eventually(async () => assert.equal(await expanded(mToggle), 'false', 'Escape closes the submenu'));
  assert.equal(await menuOpen(mobile), true, 'the menu stays open');
  assert.equal(await hasFocus(mToggle), true, 'focus is on the submenu button');
  await mobile.keyboard.press('Escape');
  await eventually(async () => assert.equal(await menuOpen(mobile), false, 'a second Escape closes the menu'));
  assert.equal(await hasFocus(menuButton), true, 'focus is on the menu button');
  await menuButton.tap();
  await eventually(async () => assert.equal(await menuOpen(mobile), true));
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'true'));
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'false', 'a second tap closes it'));
  assert.equal(await mKitchens.isVisible(), false);
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'true'));
  await mKitchens.tap();
  await mobile.waitForURL(`${ORIGIN}/studio/work/kitchens/`);
  assert.equal(await menuOpen(mobile), false, 'the menu closes on arrival');
  assert.equal((await mobile.locator('main h1').first().innerText()).trim(), 'Kitchens');

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
  console.log('\nchild-pages: passed');
} finally {
  await browser?.close().catch(() => undefined);
  server.close();
  await app.close().catch(() => undefined);
}
cleanup();
