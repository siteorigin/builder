// Child pages (#169): Lookbook is added from the Pages panel and Kitchens is added inside it from Lookbook's
// options, previewed at /lookbook/kitchens/. Pages lists Kitchens under Lookbook, and its header link lands under
// Lookbook's, which Edit menu shows and can undo and redo without touching the page. Kitchens then moves into Work
// from its page settings: Pages follows, the menu does not. The static export, served under /studio/, loads the
// nested address directly, sends the old address on to the new one, and its submenu works by keyboard (Enter,
// Space, Tab, Escape), by pointer and by touch at phone width.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { chromium } from 'playwright';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('child-pages');
const { app, win, errors } = await launch(WORK);

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
const outline = () => pagesPanel().locator('[data-page]').evaluateAll((rows) => rows.map((r) => `${'  '.repeat(Number(r.style.getPropertyValue('--page-depth') || 0))}${r.querySelector('.page-title').textContent}`));
const inspector = () => win.locator('#dock-panel-inspect');

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
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
  await win.getByRole('menuitem', { name: 'Add page inside…' }).click();
  const lookbook = await pageBy('Lookbook');
  assert.equal(await win.locator('.pages-add-inside select').inputValue(), lookbook.id, 'the form starts inside Lookbook');
  await win.getByLabel('New page title').fill('Kitchens');
  assert.equal(await win.locator('#pages-add-route .value').innerText(), '/lookbook/kitchens/', 'the address previews inside Lookbook');
  assert.match(await win.locator('.pages-add-form').innerText(), /Add to header menu, under Lookbook/, 'the form says where the menu link goes');
  await win.locator('.pages-add-actions .btn-primary').click();
  await eventually(async () => assert.equal((await pageBy('Kitchens'))?.route, '/lookbook/kitchens/', 'Kitchens gets the previewed address'));
  const kitchens = await pageBy('Kitchens');

  step('Pages shows Kitchens inside Lookbook, and the header menu groups its link under Lookbook’s');
  await eventually(async () => assert.deepEqual(await outline(), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']));
  assert.equal(await pageRow('Kitchens').getAttribute('aria-description'), 'Inside Lookbook. /lookbook/kitchens/');
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
  assert.equal(await nested.locator('.sr-only').first().textContent(), ', under Lookbook');
  await nested.locator('.title').click();
  const sub = nested.getByRole('switch', { name: 'Show under the link above' });
  assert.equal(await sub.getAttribute('aria-checked'), 'true');
  await sub.click();
  await eventually(async () => assert.deepEqual((await menuRows()).map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', 'Kitchens']));
  assert.equal(await list.locator('.list-editor-item.nested').count(), 0, 'the row is no longer shown under Lookbook');
  assert.equal((await pageBy('Kitchens')).route, '/lookbook/kitchens/', 'the page stays inside Lookbook');
  await list.locator('.list-editor-item', { hasText: 'Kitchens' }).getByRole('switch', { name: 'Show under the link above' }).click();
  await eventually(async () => assert.deepEqual((await menuRows()).map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens']));

  step('move Kitchens into Work from its page settings: Pages follows, the menu does not');
  const work = await apply([{ type: 'page.create', title: 'Work', route: '/work/', starter: 'intro' }], 'Add page Work');
  assert.equal(work.ok, true);
  const workId = work.results[0].pageId;
  await pageRow('Kitchens').hover();
  await pageRow('Kitchens').getByRole('button', { name: 'Kitchens options' }).click();
  await win.getByRole('menuitem', { name: 'Page settings' }).click();
  const inside = inspector().getByLabel('Inside page');
  await eventually(async () => assert.equal(await inside.inputValue(), lookbook.id, 'page settings say Kitchens is inside Lookbook'));
  await inside.selectOption(workId);
  await eventually(async () => assert.equal((await pageBy('Kitchens')).route, '/work/kitchens/', 'Kitchens moves into Work'));
  await eventually(async () => assert.deepEqual(await outline(), ['Home', 'About', 'Contact', 'Lookbook', 'Work', '  Kitchens']));
  assert.equal(await pageRow('Kitchens').getAttribute('aria-description'), 'Inside Work. /work/kitchens/');
  const after = await menuRows();
  assert.deepEqual(after.map((r) => r.row), ['Home', 'About', 'Contact', 'Lookbook', '  Kitchens'], 'the menu link stays under Lookbook');
  assert.equal(after.find((r) => r.target === kitchens.id)?.id, kitchensItem.id, 'it is the same link, still leading to Kitchens');
  assert.deepEqual((await snapshot()).state.site.redirects, [{ from: '/lookbook/kitchens/', pageId: kitchens.id }], 'the old address keeps leading to Kitchens');

  step('static export, served under /studio/');
  root = join(WORK, 'export');
  const r = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), root), 300000, 'Static export');
  assert.equal(r.ok, true, `static export succeeds: ${r.message} ${r.warnings?.join(' ') ?? ''}`);
  const served = await (await fetch(`${ORIGIN}/studio/work/kitchens/`)).text();
  assert.match(served, /<h1[^>]*>\s*Kitchens\s*</, 'the nested address loads directly, with its content in the first HTML');
  assert.match(served, /<ul id="so-sub-[^"]+" class="so-header__sub[^"]*"[^>]*hidden/, 'the submenu is in the HTML, hidden until opened');
  assert.doesNotMatch(served, /data-so-|siteorigin-bridge/, 'no editor instrumentation');

  browser = await chromium.launch();
  /** Wait until the header has hydrated: once mounted, it publishes its height on the page root. */
  const hydrated = (page) => page.waitForFunction(() => document.documentElement.style.getPropertyValue('--so-header-offset') !== '', null, { timeout: 30000 });
  const expanded = (toggle) => toggle.getAttribute('aria-expanded');
  const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  const hasFocus = (locator) => locator.evaluate((el) => el === document.activeElement);

  step('the old address sends visitors on to the new one');
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await desktop.newPage();
  await page.goto(`${ORIGIN}/studio/lookbook/kitchens/`);
  await page.waitForURL(`${ORIGIN}/studio/work/kitchens/`, { timeout: 20000 });
  assert.equal((await page.locator('main h1').first().innerText()).trim(), 'Kitchens');

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
  assert.equal(await kitchensLink.isVisible(), false);
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
  await eventually(async () => assert.equal(await expanded(menuButton), 'true', 'the menu opens'));
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
  assert.equal(await expanded(menuButton), 'true', 'the menu stays open');
  assert.equal(await hasFocus(mToggle), true, 'focus is on the submenu button');
  await mobile.keyboard.press('Escape');
  await eventually(async () => assert.equal(await expanded(menuButton), 'false', 'a second Escape closes the menu'));
  assert.equal(await hasFocus(menuButton), true, 'focus is on the menu button');
  await menuButton.tap();
  await eventually(async () => assert.equal(await expanded(menuButton), 'true'));
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'true'));
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'false', 'a second tap closes it'));
  assert.equal(await mKitchens.isVisible(), false);
  await mToggle.tap();
  await eventually(async () => assert.equal(await expanded(mToggle), 'true'));
  await mKitchens.tap();
  await mobile.waitForURL(`${ORIGIN}/studio/work/kitchens/`);
  assert.equal(await expanded(menuButton), 'false', 'the menu closes on arrival');
  assert.equal((await mobile.locator('main h1').first().innerText()).trim(), 'Kitchens');

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
  console.log('\nchild-pages: passed');
} finally {
  await browser?.close().catch(() => undefined);
  server.close();
  await app.close().catch(() => undefined);
}
cleanup();
