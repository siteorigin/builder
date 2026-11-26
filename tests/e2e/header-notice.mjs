// A temporary notice published once from the shared header (#269): the author selects the header in Layers, the
// Inspector names the pages that inherit it, the notice is written, linked and reworded there, a phone-width
// preview keeps the menu button and the menu reachable under it, and the static export shows it on Home and on a
// direct visit to Contact. Clearing its words removes it from both on the next export, and the site name, the
// header's action and the pages' own content stay as they were throughout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('header-notice');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'harbour-lane-studio');

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const inspector = () => win.locator('#dock-panel-inspect');
const siteFile = () => readFileSync(join(dir, 'siteorigin/site.json'), 'utf8');
const headerProps = async () => {
  const s = (await snapshot()).state;
  return s.site.shell.header.nodes[s.site.shell.header.rootIds[0]].props;
};
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};

const NOTICE = 'Studio closed on Friday for repairs';
const REWORDED = 'Studio closed this Friday for repairs. Back on Saturday.';

const s0 = (await snapshot()).state;
const contact = s0.site.pageOrder[2];
assert.deepEqual(s0.site.pageOrder.map((id) => s0.pages[id].title), ['Home', 'About', 'Contact'], 'a three-page business site');
const siteName = (await headerProps()).siteName;
const action = (await headerProps()).ctaLabel;
assert.ok(siteName && action, 'the header has a site name and an action to keep');

/** Select the shared header in Layers, the way an author reaches it, and show its settings. */
const selectHeader = async () => {
  await openRail('Layers');
  await win.getByRole('group', { name: 'Shared header', exact: true }).getByRole('treeitem').first().click();
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
};

step('select the shared header in Layers: the Inspector names the three pages that inherit it');
await selectHeader();
const scope = inspector().locator('.insp-scope.shared');
await eventually(async () => assert.match(await scope.innerText(), /Changes show on all 3 pages that use it: Home, About and Contact\./, 'the scope line names every page'));
const notice = inspector().getByRole('group', { name: 'Notice', exact: true });
const text = notice.getByRole('textbox', { name: 'Text', exact: true });
const label = notice.getByRole('textbox', { name: 'Link label', exact: true });
await text.waitFor();
// The notice has its own fields: the site name and the action are still where they were.
assert.equal(await inspector().getByRole('textbox', { name: 'Site name', exact: true }).inputValue(), siteName);

step('publish the notice once, with a link to Contact');
await text.fill(NOTICE);
await text.press('Enter');
await eventually(async () => assert.equal((await headerProps()).notice, NOTICE, 'the header stores the notice'));
await eventually(() => assert.equal(siteFile().includes(NOTICE), true, 'the notice is saved with the shared header'), 15000);
await label.fill('Get directions');
await label.press('Enter');
// The destination is chosen in the Inspector's own link picker.
await notice.getByRole('combobox', { name: 'Notice link type', exact: true }).selectOption('page');
await notice.getByRole('combobox', { name: 'Notice page', exact: true }).selectOption(contact);
await eventually(async () => assert.deepEqual((await headerProps()).noticeLink, { type: 'page', target: contact }, 'the notice links to Contact'));
// The project has the link before the editor hears of it: the Inspector shows it once it has, and a link type chosen
// before then would be put back by the news of this one.
await eventually(async () => assert.equal(await notice.getByRole('combobox', { name: 'Notice page', exact: true }).inputValue(), contact, 'the Inspector shows the link to Contact'));

step('a web address the project cannot store is explained beside the field, which keeps it');
const linkType = notice.getByRole('combobox', { name: 'Notice link type', exact: true });
await linkType.selectOption('url');
const address = notice.getByRole('textbox', { name: 'Notice web address', exact: true });
// A saved web address first, then one typed over it that the project cannot store.
await address.fill('https://example.com/visit');
await address.press('Enter');
await eventually(async () => assert.deepEqual((await headerProps()).noticeLink, { type: 'url', target: 'https://example.com/visit' }, 'the web address is stored'));
await address.fill('example.com');
await address.press('Enter');
const problem = notice.locator('.field-error[role="alert"]');
await eventually(async () => assert.equal(await problem.innerText(), 'A web address starts with https://, such as https://example.com.', 'the field says what is wrong'));
// Past the moment a refused field would put the saved value back: the typed text stays, marked invalid.
await win.waitForTimeout(1000);
assert.equal(await address.inputValue(), 'example.com', 'the field keeps what was typed');
assert.equal(await address.getAttribute('aria-invalid'), 'true', 'the field is marked invalid');
assert.ok((await address.getAttribute('aria-describedby')).split(' ').includes(await problem.getAttribute('id')), 'the message describes the field');
assert.deepEqual((await headerProps()).noticeLink, { type: 'url', target: 'https://example.com/visit' }, 'nothing is stored');
await address.fill('https://example.com');
await address.press('Enter');
await eventually(async () => assert.deepEqual((await headerProps()).noticeLink, { type: 'url', target: 'https://example.com' }, 'the corrected address is stored'));
assert.equal(await problem.count(), 0, 'the message goes once the address is good');
await linkType.selectOption('page');
await notice.getByRole('combobox', { name: 'Notice page', exact: true }).selectOption(contact);
await eventually(async () => assert.deepEqual((await headerProps()).noticeLink, { type: 'page', target: contact }, 'the notice links to Contact again'));
const headerId = s0.site.shell.header.rootIds[0];
const bar = frame.locator('header.so-header .so-header__notice');
await eventually(async () => assert.equal((await bar.innerText()).replace(/\s+/g, ' ').trim(), `${NOTICE} Get directions`, 'the canvas shows the notice and its link'), 30000);
await notice.scrollIntoViewIfNeeded();
await win.screenshot({ path: join(SHOTS, 'header-notice-inspector.png') });

step('update the wording in the same place');
await text.fill(REWORDED);
await text.press('Enter');
await eventually(async () => assert.match(await bar.innerText(), /Back on Saturday\./, 'the canvas shows the new wording'), 30000);

step('at phone width the notice wraps above the menu button, and the open menu sits below both');
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.locator('button[title^="Preview:"]').click();
const phone = async () =>
  frame.locator('html').evaluate(() => {
    const box = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } : null;
    };
    const visible = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return getComputedStyle(el).display !== 'none' && r.height > 0 && (hit === el || el.contains(hit));
    };
    const words = document.querySelector('.so-header__notice span');
    const range = document.createRange();
    if (words) range.selectNodeContents(words);
    return {
      // Rendered lines of the notice's words, counted by their distinct tops.
      lines: words ? new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size : 0,
      viewHeight: window.innerHeight,
      view: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      notice: box('.so-header__notice'),
      toggle: box('.so-header__toggle'),
      toggleVisible: visible('.so-header__toggle'),
      nav: box('.so-header__nav'),
      contactVisible: visible('.so-header__nav a[href$="/contact/"]'),
      ctaVisible: visible('.so-header__cta'),
      offset: parseFloat(document.documentElement.style.getPropertyValue('--so-header-offset')),
      header: box('header.so-header')
    };
  });
await eventually(async () => {
  const p = await phone();
  assert.ok(p.view < 768, `the preview is phone width (${p.view})`);
  assert.ok(p.page <= p.view, `the page does not scroll sideways (${p.page} > ${p.view})`);
  assert.ok(p.lines >= 2, `the notice wraps onto more than one line (${p.lines})`);
  assert.ok(p.toggle.top >= p.notice.bottom - 0.5, 'the menu button sits below the notice');
  assert.equal(p.toggleVisible, true, 'nothing covers the menu button');
  // The notice scrolls away with the page, so jump links clear the brand row that stays.
  assert.ok(Math.abs(p.offset - (p.header.height - p.notice.height)) <= 1, `jump links clear the brand row (${p.offset} vs ${p.header.height} - ${p.notice.height})`);
}, 30000);
await frame.locator('.so-header__toggle').click();
await eventually(async () => {
  const p = await phone();
  // It hangs from the header's bottom edge (inside the header's 1px border, as it always has).
  assert.ok(p.nav.top >= p.toggle.bottom && p.nav.top >= p.notice.bottom && p.nav.top >= p.header.bottom - 1.5, `the open menu hangs below the notice and the brand row: ${JSON.stringify(p)}`);
  assert.equal(p.contactVisible, true, 'the Contact link is reachable in the open menu');
  assert.equal(p.ctaVisible, true, 'the header action is reachable in the open menu');
}, 15000);
await win.screenshot({ path: join(SHOTS, 'header-notice-phone.png') });
await frame.locator('.so-header__toggle').click();

// The longest notice the header takes wraps over several lines; scrolled down the page, it has gone and the brand
// row, the menu button and the open menu stay on screen.
const setNotice = (value) => apply([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerId, prop: 'notice', value }], 'Notice');
const longest = 'We are closed for essential repairs until the end of the month. Bookings continue by phone and email, and site visits resume once the workshop reopens. Thanks.';
assert.equal(longest.length, 159);
assert.equal((await setNotice(`${longest}!!`)).ok, false, 'a notice longer than 160 characters is refused');
assert.ok((await setNotice(longest)).ok);
await eventually(async () => {
  const p = await phone();
  assert.ok(p.lines >= 3, `the longest notice wraps (${p.lines} lines)`);
  assert.equal(p.toggleVisible, true, 'nothing covers the menu button');
}, 30000);
await frame.locator('html').evaluate(() => window.scrollTo(0, 600));
await eventually(async () => {
  const p = await phone();
  assert.ok(Math.abs(p.header.top + p.notice.height) <= 1, `the header is pinned by its brand row, the notice above the window (${p.header.top} vs ${p.notice.height})`);
  assert.ok(p.toggle.top >= 0 && p.toggle.bottom <= p.viewHeight, `the menu button is on screen (${p.toggle.top}–${p.toggle.bottom})`);
  assert.equal(p.toggleVisible, true, 'nothing covers the menu button');
}, 15000);
await frame.locator('.so-header__toggle').click();
await eventually(async () => {
  const p = await phone();
  assert.ok(p.nav.top >= p.toggle.bottom && p.nav.bottom <= p.viewHeight + 1, `the open menu hangs below the brand row, on screen (${p.nav.top}–${p.nav.bottom} of ${p.viewHeight})`);
  assert.equal(p.contactVisible, true, 'the Contact link is reachable under a long notice');
}, 15000);
await frame.locator('.so-header__toggle').click();
await frame.locator('html').evaluate(() => window.scrollTo(0, 0));
assert.ok((await setNotice(REWORDED)).ok);
await eventually(async () => assert.match(await bar.innerText(), /Back on Saturday\./, 'the notice is back to its wording'), 30000);
await win.locator('button[title^="Edit:"]').click();
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();

const exportStatic = async (name) => {
  const out = join(WORK, name);
  const r = await win.evaluate((dest) => window.builderTest.exportStatic(dest), out);
  assert.equal(r.ok, true, `static export succeeds: ${r.message} ${r.warnings?.join(' ')}`);
  const html = (rel) => readFileSync(join(out, rel), 'utf8');
  /** What one prerendered page shows: what a visitor opening that address directly receives. */
  return (rel) => {
    const h = html(rel);
    const head = h.slice(h.indexOf('<header class="so-header'), h.indexOf('</header>'));
    const main = h.slice(h.indexOf('<main id="main"'), h.indexOf('</main>'));
    const bar = head.match(/<div class="so-header__notice[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? null;
    return {
      notice: bar && bar.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      link: bar && (bar.match(/<a href="([^"]*)"/)?.[1] ?? null),
      name: head.includes(`<span>${siteName}</span>`),
      action: new RegExp(`so-header__cta[^>]*>${action}</a>`).test(head),
      heading: /<h1[\s>]/.test(main),
      inMain: main.includes('Back on Saturday'),
      editor: /data-so-|siteorigin-bridge/.test(h)
    };
  };
};

step('static export: Home and a direct visit to Contact both show the notice');
const published = await exportStatic('export-published');
for (const rel of ['index.html', 'contact/index.html']) {
  const p = published(rel);
  assert.equal(p.notice, `${REWORDED} Get directions`, `${rel} shows the notice and its link`);
  assert.match(p.link ?? '', /(^|\/)contact\/$/, `${rel} links the notice to Contact`);
  assert.deepEqual({ name: p.name, action: p.action, heading: p.heading, inMain: p.inMain, editor: p.editor }, { name: true, action: true, heading: true, inMain: false, editor: false }, `${rel} keeps its name, action and own content`);
}
assert.equal(published('about/index.html').notice, `${REWORDED} Get directions`, 'About inherits it too');

step('remove the notice once: both pages update');
await selectHeader();
await text.fill('');
await text.press('Enter');
await eventually(async () => assert.equal((await headerProps()).notice, '', 'the header stores no notice'));
await eventually(async () => assert.equal(await bar.count(), 0, 'the canvas shows no notice'), 30000);
const removed = await exportStatic('export-removed');
for (const rel of ['index.html', 'contact/index.html', 'about/index.html']) {
  const p = removed(rel);
  assert.equal(p.notice, null, `${rel} no longer shows the notice or its link`);
  assert.deepEqual({ name: p.name, action: p.action, heading: p.heading, editor: p.editor }, { name: true, action: true, heading: true, editor: false }, `${rel} keeps its name, action and own content`);
}

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nheader-notice: passed');
