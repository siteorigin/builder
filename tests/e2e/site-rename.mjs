// A renamed site carries its new name everywhere the starter put the old one (#31): the shared header's brand, the
// footer's brand and its copyright line, in the live website and in the exported one. A footer name the author wrote
// is kept and said so, beside the site's name and beside the footer's own field, which can go back to following it.
// Recent projects lists the project under its new name, after switching straight into another project and after
// closing back to Welcome, and each card names the project's own folder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('site-rename');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Morning Press', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const dir = join(WORK, 'sites', 'morning-press');
const year = new Date().getFullYear();
const site = () => JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));
const shellProps = (part) => site().shell[part].nodes[site().shell[part].rootIds[0]].props;
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);

/** Click a native menu item by its label, as choosing it in the menu bar (or its shortcut) does. */
const menu = (label) =>
  app.evaluate(({ Menu }, l) => {
    const find = (items) => {
      for (const i of items) {
        if (i.label === l) return i;
        const f = i.submenu && find(i.submenu.items);
        if (f) return f;
      }
    };
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error(`No menu item ${l}`);
    item.click();
  }, label);

const head = () => win.locator('#dock-panel-styles button.section-head', { hasText: 'Site details' });
const details = () => win.locator('#dock-panel-styles .section').filter({ has: win.locator('button.section-head', { hasText: 'Site details' }) });
const nameField = () => details().locator('.field').filter({ has: win.locator('label', { hasText: 'Site name' }) });
const openDetails = async () => {
  await win.locator('.dock-tab', { hasText: 'Styles' }).click();
  await win.locator('#dock-panel-styles').waitFor();
  if ((await head().getAttribute('aria-expanded')) !== 'true') await head().click();
};
const rename = async (name) => {
  await openDetails();
  const input = nameField().getByRole('textbox', { name: 'Site name', exact: true });
  await input.fill(name);
  await input.press('Tab');
  await eventually(() => assert.equal(site().name, name, `the site is called ${name} on disk`));
};

/** What the visitor sees: the header's brand, the footer's brand and the footer's copyright line. */
const live = async () => ({
  header: (await frame.locator('header.so-header .so-header__brand').innerText()).trim(),
  footer: (await frame.locator('footer:not(main footer) p').first().innerText()).trim(),
  copyright: (await frame.locator('footer:not(main footer) p').last().innerText()).trim()
});
const liveIs = (want, what) => eventually(async () => assert.deepEqual(await live(), want, what), 30000);

step('renaming the site in Site details renames the header, the footer and its copyright line');
await openDetails();
assert.match(await nameField().innerText(), /The header and footer show it too\./, 'the field says where else the name shows');
await rename('Morning Paper');
await eventually(() => assert.deepEqual([shellProps('header').siteName, shellProps('footer').siteName, shellProps('footer').copyright], ['Morning Paper', 'Morning Paper', `© ${year} Morning Paper. All rights reserved.`]));
await liveIs({ header: 'Morning Paper', footer: 'Morning Paper', copyright: `© ${year} Morning Paper. All rights reserved.` }, 'the live website shows the new name');
await eventually(async () => assert.match(await win.locator('.toolbar').innerText(), /Morning Paper/, 'the toolbar shows it too'));

step('a footer name of the author’s own stays through the next rename, and the site’s name field says so');
const footerId = site().shell.footer.rootIds[0];
assert.ok((await apply([{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: footerId, prop: 'siteName', value: 'Morning Paper Co.' }], 'Edit footer')).ok);
await eventually(async () => assert.match(await nameField().innerText(), /The header shows it too\. The footer keeps its own name: “Morning Paper Co\.”/));
await rename('Morning Courier');
await liveIs({ header: 'Morning Courier', footer: 'Morning Paper Co.', copyright: `© ${year} Morning Courier. All rights reserved.` }, 'the header and copyright follow, the footer keeps its name');
await nameField().screenshot({ path: join(SHOTS, 'site-rename-details.png') });

step('the exported website shows the same');
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
assert.equal(er.ok, true, `static export succeeds: ${er.message} ${er.warnings?.join(' ')}`);
const html = readFileSync(join(exportDir, 'index.html'), 'utf8');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const header = html.slice(html.indexOf('<header class="so-header'), html.indexOf('</header>'));
const footer = html.slice(html.lastIndexOf('<footer'), html.lastIndexOf('</footer>'));
assert.match(text(header.slice(header.indexOf('so-header__brand'))), /^[^<]*?Morning Courier/, 'the exported header names the site');
assert.doesNotMatch(text(header), /Morning (Press|Paper)/, 'the exported header shows no old name');
assert.match(text(footer), /Morning Paper Co\./, 'the exported footer keeps its own name');
assert.match(text(footer), new RegExp(`© ${year} Morning Courier\\. All rights reserved\\.`), 'the exported copyright line names the site');
assert.doesNotMatch(text(footer), /Morning Press/, 'the exported footer shows no old name');

step('the footer’s own field says it keeps its name, and Use the site name makes it follow again');
// The canvas is scaled to fit beside the panels, so the footer's name is selected with a click on the element itself.
await frame.locator('footer:not(main footer) p').first().dispatchEvent('click');
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
const inspector = win.locator('#dock-panel-inspect');
const own = inspector.locator('.field-hint', { hasText: 'Its own name' });
await own.waitFor({ timeout: 10000 });
await own.getByRole('button', { name: 'Use the site name' }).click();
await eventually(() => assert.equal(shellProps('footer').siteName, 'Morning Courier', 'the footer follows the site name again'));
await eventually(async () => assert.equal(await inspector.locator('.field-hint', { hasText: 'Follows the site name' }).count() > 0, true, 'the field says it follows'));
await liveIs({ header: 'Morning Courier', footer: 'Morning Courier', copyright: `© ${year} Morning Courier. All rights reserved.` }, 'the footer shows the site name again');

step('Recent projects lists the new name after switching straight into another project, and after closing to Welcome');
await rename('New Morning Courier');
await win.evaluate((o) => window.builder.projects.create(o), { name: 'Orchid Garden', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });
await eventually(async () => assert.match(await win.locator('.toolbar').innerText(), /Orchid Garden/, 'the new project is open'), 90000);
const recents = () => win.evaluate(() => window.builder.projects.recents());
await eventually(async () => assert.equal((await recents()).find((r) => r.dir === dir)?.name, 'New Morning Courier', 'the list has the name it was left with'));
await menu('Close Project');
await win.waitForSelector('.welcome');
const card = (name) => win.locator('.recent-card', { hasText: name });
await card('New Morning Courier').waitFor();
assert.equal(await win.locator('.recent-card', { hasText: 'Morning Press' }).count(), 0, 'no card has an old name');
assert.match(await card('New Morning Courier').locator('.where').innerText(), /morning-press/, 'the card names the project’s own folder');
assert.match(await card('Orchid Garden').locator('.where').innerText(), /orchid-garden/, 'so does the one beside it');
await win.locator('.recent-grid').screenshot({ path: join(SHOTS, 'site-rename-recents.png') });

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nsite-rename: all checks passed');
