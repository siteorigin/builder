// Making another page Home (#37): a Business site published under a sub-path is exported, About is made Home
// through the Pages menu and its confirmation, and the site is exported again. An old bookmark to /about/ from the
// first export is then visited in a browser, with and without JavaScript, and must still reach About. The
// confirmation must name both address changes and the header and footer links to review, and custom menu labels
// and unrelated links must survive.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const HOME_HEADING = 'Calm, considered spaces for everyday life';
const ABOUT_HEADING = 'A small studio with a long view';

const { WORK, cleanup } = scratch('home-address');
const { app, win, errors } = await launch(WORK);

/**
 * A static host with a fixed address for both exports, as a real site keeps its address between deploys: the
 * app's own preview server picks a new port for every export, so a bookmark to it would point at nothing.
 */
let root = null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.xml': 'application/xml', '.txt': 'text/plain' };
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

/**
 * Open `url` in a hidden browser window with its own empty session (no cache, no history) and wait for it to
 * settle wherever it ends up. With JavaScript, also read the page's main heading and its header and footer links.
 */
async function visit(url, { javascript = true } = {}) {
  return withTimeout(
    app.evaluate(
      async ({ BrowserWindow }, { url, javascript }) => {
        const w = new BrowserWindow({ show: false, webPreferences: { javascript, partition: `visitor-${Date.now()}-${Math.random()}` } });
        try {
          let loads = 0;
          w.webContents.on('did-finish-load', () => loads++);
          // A redirect page navigates on before its own load finishes, which aborts this load.
          await w.loadURL(url).catch(() => {});
          // Settled: a finished load and the same address for a full second.
          let last = '';
          let since = Date.now();
          for (const end = Date.now() + 20000; Date.now() < end; ) {
            await new Promise((r) => setTimeout(r, 100));
            const now = w.webContents.getURL();
            if (now !== last) (last = now), (since = Date.now());
            else if (loads && !w.webContents.isLoading() && Date.now() - since > 1000) break;
          }
          const finalUrl = w.webContents.getURL();
          const page = javascript
            ? await w.webContents.executeJavaScript(
                `({ heading: document.querySelector('main h1')?.textContent.trim() ?? null, header: [...document.querySelectorAll('header a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]), footer: [...document.querySelectorAll('footer a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]) })`
              )
            : null;
          return { finalUrl, ...page };
        } finally {
          w.destroy();
        }
      },
      { url, javascript }
    ),
    40000,
    `Visiting ${url}`
  );
}

/** The main heading of a page as first served, before any script runs. */
async function servedHeading(url) {
  const html = await (await fetch(url)).text();
  return html.match(/<h1[^>]*>([^<]*)</)?.[1].trim() ?? null;
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  const exportsDir = join(WORK, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  await app.evaluate(({ dialog }, parent) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, exportsDir);

  step('a site published under /studio/, with a custom menu label');
  const site = await apply([{ type: 'site.update', baseUrl: 'https://example.test/studio/' }], 'Set the public address');
  assert.equal(site.ok, true, `the public address is saved: ${site.error?.message}`);
  let state = (await snapshot()).state;
  const pageBy = (s, title) => Object.values(s.pages).find((p) => p.title === title);
  const about = pageBy(state, 'About').id;
  const formerHome = state.site.homePageId;
  const header = state.site.shell.header.rootIds[0];
  const aboutItem = state.site.shell.header.nodes[header].props.links.find((l) => l.label === 'About').id;
  const label = await apply([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', itemId: aboutItem, field: 'label', value: 'Our practice' }], 'Rename menu item');
  assert.equal(label.ok, true, `the menu label changes: ${label.error?.message}`);

  step('first export: About is at /studio/about/');
  const first = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'First export');
  assert.equal(first.ok, true, `the first export succeeds: ${first.message} ${first.warnings?.join(' ')}`);
  root = first.path;
  const bookmark = `${ORIGIN}/studio/about/`;
  const before = await visit(bookmark);
  assert.equal(new URL(before.finalUrl).pathname, '/studio/about/', 'the bookmark opens About where it is');
  assert.equal(before.heading, ABOUT_HEADING);
  assert.equal(existsSync(join(first.path, 'home')), false, 'there is no /home/ yet');

  step('Make home page… explains both moves and the links to review before changing anything');
  await win.locator('.side-panel .list-item', { hasText: 'About' }).hover();
  await win.locator('[aria-label="About options"]').click();
  await win.getByRole('menuitem', { name: 'Make home page…' }).click();
  const modal = win.locator('.modal');
  await modal.waitFor();
  const moves = (await modal.getByRole('list', { name: 'Address changes' }).locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(moves, ['About /about/ → moves to /', 'Home / → moves to /home/'], 'both address changes are shown');
  const keep = modal.getByRole('checkbox', { name: 'Keep /about/ working' });
  assert.equal(await keep.isChecked(), true, 'keeping the old address is the default');
  const review = (await modal.getByRole('list', { name: 'Header and footer links to review' }).locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(review, ['Header “Home” → will go to /home/', 'Header “Our practice” → will go to /', 'Footer “Home” → will go to /home/', 'Footer “About” → will go to /'], 'the header and footer links that change destination are listed with their own words');
  assert.equal((await snapshot()).state.site.homePageId, formerHome, 'nothing changes until the choice is confirmed');
  await modal.getByRole('button', { name: 'Make home page' }).click();
  await modal.waitFor({ state: 'detached' });
  state = await eventually(async () => {
    const s = (await snapshot()).state;
    assert.equal(s.site.homePageId, about);
    return s;
  });
  assert.equal(state.pages[about].route, '/');
  assert.equal(state.pages[formerHome].route, '/home/');
  assert.deepEqual(state.site.redirects, [{ from: '/about/', pageId: about }]);

  step('second export: the old bookmark still reaches About, with and without JavaScript');
  const second = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Second export');
  assert.equal(second.ok, true, `the second export succeeds: ${second.message} ${second.warnings?.join(' ')}`);
  assert.notEqual(second.path, first.path, 'the second export is a new folder');
  assert.ok(existsSync(join(second.path, 'about', 'index.html')), 'the old address is in the export');
  assert.match(second.message, /Exported 3 pages/, 'the kept address is not counted as a page');
  root = second.path;
  const after = await visit(bookmark);
  assert.equal(new URL(after.finalUrl).pathname, '/studio/', `the bookmark is sent to About's new address (ended at ${after.finalUrl})`);
  assert.equal(after.heading, ABOUT_HEADING, 'and shows About');
  // A shared link with a query and a section keeps both on the way.
  const tagged = await visit(`${bookmark}?ref=partner#team`);
  const taggedUrl = new URL(tagged.finalUrl);
  assert.equal(`${taggedUrl.pathname}${taggedUrl.search}${taggedUrl.hash}`, '/studio/?ref=partner#team', `the query and section come along (ended at ${tagged.finalUrl})`);
  assert.equal(tagged.heading, ABOUT_HEADING);
  assert.deepEqual(after.header.concat(after.footer).filter(([, href]) => href === '/studio/about/'), [], 'nothing on the site links to the old address');
  const noScript = await visit(bookmark, { javascript: false });
  assert.equal(new URL(noScript.finalUrl).pathname, '/studio/', `without JavaScript too (ended at ${noScript.finalUrl})`);
  assert.equal(await servedHeading(noScript.finalUrl), ABOUT_HEADING);
  const moved = await visit(`${ORIGIN}/studio/home/`);
  assert.equal(new URL(moved.finalUrl).pathname, '/studio/home/');
  assert.equal(moved.heading, HOME_HEADING, 'the previous home page is at /studio/home/');

  step('menu labels and unrelated links survive');
  const links = Object.fromEntries(after.header);
  assert.equal(links['Our practice'], '/studio/', 'the custom label stays, and goes to About at its new address');
  assert.equal(links.Home, '/studio/home/', 'the Home item keeps its words and follows the previous home page');
  assert.equal(links.Contact, '/studio/contact/', 'an unrelated page link is unchanged');
  const footer = Object.fromEntries(after.footer);
  assert.equal(footer.About, '/studio/');
  assert.equal(footer['hello@example.com'], 'mailto:hello@example.com', 'an unrelated email link is unchanged');
  const contact = await visit(`${ORIGIN}/studio/contact/`);
  assert.equal(new URL(contact.finalUrl).pathname, '/studio/contact/');

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  server.close();
  await app.close();
}

cleanup();
console.log('\nhome-address: passed');
