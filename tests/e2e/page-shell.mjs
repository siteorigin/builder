// Each page shows the shared header and the shared footer on its own (#219): a focused landing page keeps the
// footer's contact details without the site's menu. The page inspector's two switches go through all four
// combinations in the canvas, the pages around it keep both, an edit to the shared footer reaches the landing page,
// and the static export renders each page's own choice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('page-shell');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'harbour-lane-studio');

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const pageFile = (id) => JSON.parse(readFileSync(join(dir, 'siteorigin/pages', `${id}.json`), 'utf8'));

/** What the canvas shows around the page: the shared header (with its menu) and the shared footer. */
const shown = async () => ({ header: await frame.locator('header.so-header').count(), footer: await frame.locator('footer:not(main footer)').count() });
const expectShown = (want, what) => eventually(async () => assert.deepEqual(await shown(), want, what), 30000);

const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const openPage = async (title, route) => {
  await openRail('Pages');
  await win.locator('.pages-list [role="option"]', { hasText: title }).first().click();
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), new RegExp(title), `${title} is open`));
  // The canvas has moved to the page, not only the toolbar and inspector.
  await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), route, `the canvas shows ${route}`), 30000);
  // With nothing selected, the inspector shows the page's own settings.
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
  await win.locator('#dock-panel-inspect .section', { hasText: 'Shared header and footer' }).waitFor();
};
const headerSwitch = () => win.getByRole('switch', { name: 'Show shared header', exact: true });
const footerSwitch = () => win.getByRole('switch', { name: 'Show shared footer', exact: true });
const checked = async (sw) => (await sw.getAttribute('aria-checked')) === 'true';

step('a kitchen landing page, next to pages that keep both');
const add = await apply([{ type: 'page.create', title: 'Kitchen', route: '/kitchen/', starter: 'intro' }], 'Add page');
assert.ok(add.ok, JSON.stringify(add));
const s0 = await snapshot();
const [home, about, contact] = s0.state.site.pageOrder;
const kitchen = s0.state.site.pageOrder.find((id) => s0.state.pages[id].title === 'Kitchen');
await openPage('Kitchen', '/kitchen/');
// The new page itself, with the heading its introduction gives it, and not a "not found" page before its route exists.
const kitchenHeading = 'Kitchen';
await eventually(async () => assert.equal(await frame.locator('main h1', { hasText: kitchenHeading }).count(), 1, 'the landing page is rendered'), 60000);
await expectShown({ header: 1, footer: 1 }, 'a new page shows both');
const section = win.locator('#dock-panel-inspect .section', { hasText: 'Shared header and footer' });
assert.match(await section.locator('.scope').innerText(), /This page only/, 'the settings say they apply to this page only');
assert.equal(await checked(headerSwitch()), true);
assert.equal(await checked(footerSwitch()), true);

step('header off, footer on: the landing page');
await headerSwitch().click();
await expectShown({ header: 0, footer: 1 }, 'the menu is gone and the footer stays');
await eventually(() => assert.deepEqual([pageFile(kitchen).showHeader, pageFile(kitchen).showFooter], [false, true], 'the page stores its two choices'));
assert.equal(await checked(footerSwitch()), true, 'the footer switch is unchanged');
await section.scrollIntoViewIfNeeded();
await win.screenshot({ path: join(SHOTS, 'page-shell-landing.png') });
await eventually(async () => assert.equal(await frame.locator('main h1', { hasText: kitchenHeading }).count(), 1, `the page content stays: ${kitchenHeading}`), 30000);
// Layers lists only the shared part the page shows.
await openRail('Layers');
await eventually(async () => assert.deepEqual([await win.locator('#layers-sec-header').count(), await win.locator('#layers-sec-footer').count()], [0, 1], 'Layers shows the footer and not the header'));

step('neither');
await footerSwitch().click();
await expectShown({ header: 0, footer: 0 }, 'neither part shows');

step('header on, footer off');
await headerSwitch().click();
await expectShown({ header: 1, footer: 0 }, 'only the header shows');
await openRail('Layers');
await eventually(async () => assert.deepEqual([await win.locator('#layers-sec-header').count(), await win.locator('#layers-sec-footer').count()], [1, 0], 'Layers shows the header and not the footer'));

step('back to the landing page: footer only');
await headerSwitch().click();
await footerSwitch().click();
await expectShown({ header: 0, footer: 1 }, 'only the footer shows');

step('neighbouring pages keep both');
for (const [title, route] of [['Home', '/'], ['About', '/about/']]) {
  await openPage(title, route);
  await expectShown({ header: 1, footer: 1 }, `${title} still shows both`);
  assert.equal(await checked(headerSwitch()), true, `${title}'s header switch is its own`);
  assert.equal(await checked(footerSwitch()), true, `${title}'s footer switch is its own`);
}
for (const id of [home, about, contact]) assert.deepEqual([pageFile(id).showHeader, pageFile(id).showFooter], [true, true], 'other page files are unchanged');

step('an edit to the shared footer reaches the landing page');
const tagline = 'Open Tuesday to Saturday, by appointment.';
const footerId = s0.state.site.shell.footer.rootIds[0];
assert.ok((await apply([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: footerId, prop: 'tagline', value: tagline }], 'Edit footer')).ok);
await eventually(async () => assert.equal(await frame.locator('footer', { hasText: tagline }).count(), 1, 'About shows the new tagline'), 30000);
await openPage('Kitchen', '/kitchen/');
await expectShown({ header: 0, footer: 1 }, 'the landing page still shows only the footer');
await eventually(async () => assert.equal(await frame.locator('footer', { hasText: tagline }).count(), 1, 'the landing page shows the new tagline'), 30000);

step('static export: each page renders its own choice');
// About keeps only the header and Contact shows neither, so the export holds all four combinations.
assert.ok((await apply([{ type: 'page.update', pageId: about, showFooter: false }, { type: 'page.update', pageId: contact, showHeader: false, showFooter: false }], 'Page settings')).ok);
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
assert.equal(er.ok, true, `static export succeeds: ${er.message} ${er.warnings?.join(' ')}`);
const html = (rel) => readFileSync(join(exportDir, rel), 'utf8');
const parts = (rel) => {
  const h = html(rel);
  // The page's own content renders whatever it shows around it: its heading is inside <main>.
  const main = h.slice(h.indexOf('<main id="main"'), h.indexOf('</main>'));
  return { header: /<header class="so-header/.test(h), footer: /<footer[\s>]/.test(h.slice(h.indexOf('</main>'))), main: /<h1[\s>]/.test(main), tagline: h.includes(tagline) };
};
assert.deepEqual(parts('index.html'), { header: true, footer: true, main: true, tagline: true }, 'Home shows both');
assert.deepEqual(parts('about/index.html'), { header: true, footer: false, main: true, tagline: false }, 'About shows only the header');
assert.deepEqual(parts('kitchen/index.html'), { header: false, footer: true, main: true, tagline: true }, 'Kitchen shows only the footer, with the edited tagline');
const kitchenMain = html('kitchen/index.html').split('<main id="main"')[1]?.split('</main>')[0] ?? '';
const kitchenH1 = (kitchenMain.match(/<h1[\s>][\s\S]*?<\/h1>/)?.[0] ?? '').replace(/<[^>]+>/g, '').trim();
assert.equal(kitchenH1, kitchenHeading, 'Kitchen keeps its own heading in <main>');
assert.deepEqual(parts('contact/index.html'), { header: false, footer: false, main: true, tagline: false }, 'Contact shows neither');
for (const rel of ['index.html', 'about/index.html', 'kitchen/index.html', 'contact/index.html']) assert.doesNotMatch(html(rel), /data-so-|siteorigin-bridge/, `no editor markup in ${rel}`);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npage-shell: passed');
