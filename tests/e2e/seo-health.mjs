// Search & AI readiness (#592): Project health lists the SEO and agentic audit's findings by pillar, counted on their
// own, filtered by pillar and severity, and each finding one place fixes leads there: a Site details field, a page's
// Search & sharing field, a post's picture or excerpt, or an element on the page. A row fixed while the dialog is open
// leaves focus on the section, never on another finding's action. The export dialog names the findings worth fixing
// before the website goes out, with the way to each and to all of them, and a real website export still runs.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('seo-health');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Riverside Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  assert.ok(r.ok, `${label}: ${JSON.stringify(r.error ?? r)}`);
  return r;
};
const modal = win.locator('.modal');
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement);
const openHealth = async () => {
  await win.getByTitle('Project health: check this project for problems').click();
  const health = win.getByRole('dialog', { name: 'Project health' });
  await health.waitFor();
  return health;
};
const closeDialog = async () => {
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await modal.waitFor({ state: 'detached' });
};
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};

step('a site with things left undone: no public URL, Home hidden from search, an unlinked page without a description, a post with an undescribed picture, a “Click here!” link');
const png = await win.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#2f6f8f';
  g.fillRect(0, 0, 900, 600);
  return c.toDataURL('image/png').split(',')[1];
});
const photoPath = join(WORK, 'river.png');
writeFileSync(photoPath, Buffer.from(png, 'base64'));
const imported = await win.evaluate((p) => window.builder.project.importAssets([p]), photoPath);
assert.equal(imported.ok, true, `the photo imports: ${imported.message}`);
const photoId = imported.assetIds[0];
const s0 = (await snapshot()).state;
const homeId = s0.site.homePageId;
const header = s0.site.shell.header.rootIds[0];
const aboutItem = s0.site.shell.header.nodes[header].props.links.find((l) => l.label === 'About').id;
await apply(
  [
    { type: 'site.update', description: '' },
    { type: 'page.update', pageId: homeId, noindex: true },
    { type: 'page.create', pageId: 'pg_kilns', title: 'Kiln hire', route: '/kiln-hire/', addToNavigation: false },
    { type: 'page.update', pageId: 'pg_kilns', seoTitle: 'Kiln hire by the hour · Riverside Studio', description: '' },
    { type: 'collection.create', collectionId: 'posts' },
    {
      type: 'entry.create',
      collectionId: 'posts',
      entryId: 'en_spring',
      title: 'Spring pottery classes',
      publishedAt: '2027-03-02',
      draft: false,
      excerpt: '',
      body: [
        { type: 'p', spans: [{ text: 'Our spring classes open for bookings this week.' }] },
        { type: 'image', assetId: photoId, alt: 'The river beside the studio', caption: '' },
        { type: 'p', spans: [{ text: 'Every student leaves with a set of bowls.' }] },
        { type: 'image', assetId: photoId, alt: '', caption: '' }
      ]
    },
    { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', itemId: aboutItem, field: 'label', value: 'Click here!' }
  ],
  'Set up the site'
);

step('Project health counts Search & AI readiness on its own, by pillar, every count matching its rows');
let health = await openHealth();
const seo = health.getByTestId('health-seo');
await seo.waitFor();
const seoHeading = seo.getByRole('heading', { level: 3 });
assert.match(await seoHeading.innerText(), /^Search & AI readiness\s+\d+$/);
const total = Number((await seo.locator('h3 .health-count').innerText()).trim());
const rows = seo.locator('.health-row');
assert.equal(await rows.count(), total, 'the section’s count is its rows');
const pillars = await seo.locator('.health-place').evaluateAll((els) => els.map((el) => ({ pillar: el.dataset.pillar, name: el.querySelector('h4').innerText.replace(/\s*\d+$/, '').trim(), count: Number(el.querySelector('.seo-pillar-count').textContent), rows: el.querySelectorAll('.health-row').length })));
assert.deepEqual(
  pillars.map((p) => [p.pillar, p.name]),
  [
    ['technical', 'Technical'],
    ['agentic', 'Agentic readiness'],
    ['content', 'Content & links'],
    ['social', 'Social & performance']
  ],
  'the pillars with findings, in order'
);
for (const p of pillars) assert.equal(p.count, p.rows, `${p.name} counts its rows`);
assert.equal(
  pillars.reduce((n, p) => n + p.rows, 0),
  total
);
const row = (text) => seo.locator('.health-row', { hasText: text });
const technical = seo.locator('[data-pillar="technical"] .health-row');
assert.equal(await technical.count(), 2);
assert.equal(await row('No public site URL is set.').getByRole('button', { name: 'Go to Public URL' }).count(), 1);
assert.equal(await row('The Home page asks search engines not to list it.').getByRole('button', { name: 'Go to Search & sharing' }).count(), 1);
assert.equal(await row('“Kiln hire” has no description.').getByRole('button', { name: 'Go to Search & sharing' }).count(), 1);
assert.equal(await row('“Spring pottery classes” (Posts) has no description.').getByRole('button', { name: 'Open post' }).count(), 1);
assert.equal(await row('picture 2 in its text has no description').getByRole('button', { name: 'Go to picture' }).count(), 1);
assert.equal(await row('A link says only “Click here!” in the shared header.').getByRole('button', { name: 'Show on page' }).count(), 1);
// Fixed by a link from elsewhere, not on the page itself: said, with no button that would mislead.
const unlinked = row('No link on the rest of the site leads to “Kiln hire”.');
assert.equal(await unlinked.count(), 1);
assert.equal(await unlinked.getByRole('button').count(), 0, 'an unlinked page has no single place to fix it');
assert.match(await unlinked.innerText(), /Link to it from a menu or a related page\./, 'the row says why it matters and what to do');
// The status bar's count stays the project's own: the readiness findings are not in it.
const ownWarnings = (await snapshot()).diagnostics.filter((d) => d.severity === 'warning').length;
assert.equal(Number(await health.locator('[data-group="warnings"] h3 .health-count').innerText()), ownWarnings, 'Warnings counts the project’s own warnings, and no readiness finding');
// The entry's picture is also one of the project's own warnings, and leads to the same place there.
const generalAlt = health.locator('[data-group="warnings"] .health-row', { hasText: 'picture 2 in its text has no description' });
assert.equal(await generalAlt.getByRole('button', { name: 'Go to picture' }).count(), 1, 'the project’s own warning leads to the picture too');
assert.equal(await health.locator('.health-jumps').getByRole('button', { name: /Search & AI/ }).count(), 1, 'the summary leads to the section');
await health.screenshot({ path: join(SHOTS, 'seo-health.png') });

step('the filters show one pillar, one severity, or both; every count is what the choice lists');
const pillarSelect = seo.getByLabel('Pillar', { exact: true });
const severitySelect = seo.getByLabel('Severity', { exact: true });
const content = Number((await pillarSelect.locator('option[value="content"]').innerText()).match(/\((\d+)\)/)[1]);
await pillarSelect.selectOption('content');
await eventually(async () => assert.deepEqual(await seo.locator('.health-place').evaluateAll((els) => els.map((el) => el.dataset.pillar)), ['content']));
assert.equal(await rows.count(), content, 'Content & links lists what its option counted');
assert.equal(await seo.locator('.seo-showing').innerText(), `Showing ${content} of ${total}`);
assert.equal(await technical.count(), 0, 'no technical finding is shown');
const notes = Number((await severitySelect.locator('option[value="info"]').innerText()).match(/\((\d+)\)/)[1]);
await severitySelect.selectOption('info');
await eventually(async () => assert.equal(await rows.count(), notes));
assert.equal(await row('A link says only “Click here!”').count(), 1, 'the link’s note is shown');
assert.equal(await row('“Kiln hire” has no description.').count(), 0, 'warnings are not');
assert.equal(await seo.locator('.health-row.warn').count(), 0);
await pillarSelect.selectOption('entity');
await eventually(async () => assert.equal(await rows.count(), 0));
assert.match(await seo.locator('.seo-empty').innerText(), /No notes in Entity & structured data\./);
await seo.getByRole('button', { name: 'Clear filters' }).click();
await eventually(async () => assert.equal(await rows.count(), total, 'clearing the filters shows every finding again'));
assert.equal(await isFocused(pillarSelect), true, 'focus moves to the pillar filter');

step('a finding fixed while the dialog is open takes its row with it, and focus stays in the section');
const kilnAction = row('“Kiln hire” has no description.').getByRole('button', { name: 'Go to Search & sharing' });
await kilnAction.focus();
// A description too short replaces the missing one with a note about its length: as many findings as before.
await apply([{ type: 'page.update', pageId: 'pg_kilns', description: 'Hire our kiln' }], 'Describe Kiln hire');
await eventually(async () => assert.equal(await row('“Kiln hire” has no description.').count(), 0, 'the fixed finding is gone'));
assert.equal(await row('“Kiln hire” has a description of 13 characters').count(), 1, 'its note took its place');
assert.equal(Number((await seo.locator('h3 .health-count').innerText()).trim()), total, 'the count is the same');
await eventually(async () => assert.equal(await isFocused(seoHeading), true, 'focus is on the section’s heading, not another finding’s action'));

step('site: Go to Public URL opens Site details at the field');
await row('No public site URL is set.').getByRole('button', { name: 'Go to Public URL' }).click();
await modal.waitFor({ state: 'detached' });
const urlField = win.locator('#dock-panel-styles').getByRole('textbox', { name: 'Public URL', exact: true });
await eventually(async () => assert.equal(await isFocused(urlField), true, 'the Public URL field has focus'));

step('page: Go to Search & sharing selects Home with its search setting focused');
health = await openHealth();
await row('The Home page asks search engines not to list it.').getByRole('button', { name: 'Go to Search & sharing' }).click();
await modal.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await isFocused(win.locator('#page-seo-noindex')), true, 'the Home page’s search setting has focus'));

step('entry: Go to picture opens the post at its second picture; Open post focuses its excerpt');
health = await openHealth();
await row('picture 2 in its text has no description').getByRole('button', { name: 'Go to picture' }).click();
await modal.waitFor({ state: 'detached' });
const writer = win.locator('.post-writer-holder:not([hidden])');
await writer.waitFor();
assert.equal(await writer.locator('.post-title-input').inputValue(), 'Spring pottery classes');
await eventually(async () => assert.equal(await writer.locator('figure.post-figure').nth(1).evaluate((el) => el.classList.contains('flash')), true, 'the second picture is shown'), 1500, 50);
health = await openHealth();
await row('“Spring pottery classes” (Posts) has no description.').getByRole('button', { name: 'Open post' }).click();
await modal.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await isFocused(win.locator('.post-writer-holder:not([hidden]) [data-entry-field="excerpt"] textarea')), true, 'the excerpt has focus'));

step('element: Show on page selects the link’s menu in the shared header');
health = await openHealth();
await row('A link says only “Click here!”').getByRole('button', { name: 'Show on page' }).click();
await modal.waitFor({ state: 'detached' });
await openRail('Layers');
await eventually(async () => assert.equal(await win.locator(`[role="treeitem"][data-owner="shell:header"][data-node="${header}"]`).getAttribute('aria-selected'), 'true', 'the header’s menu is selected'));

step('the export dialog names what to fix before the website goes out, without stopping it');
await win.getByRole('button', { name: 'Export', exact: true }).click();
const preflight = modal.getByTestId('export-seo-preflight');
await preflight.waitFor();
assert.match(await preflight.innerText(), /\d+ things keep the website from being found or shared well\./);
assert.match(await preflight.innerText(), /This won’t stop the export\./);
const preRows = preflight.locator('.export-review-list > li');
assert.ok((await preRows.count()) <= 4, 'a few are shown');
assert.equal(await preRows.filter({ hasText: 'No public site URL is set.' }).count(), 1);
assert.equal(await preRows.filter({ hasText: 'The Home page asks search engines not to list it.' }).count(), 1);
assert.equal(await preRows.filter({ hasText: 'picture 2 in its text has no description' }).count(), 1, 'one of each kind before a second of any');
const siteCard = modal.getByRole('button', { name: /Website files, ready to upload/ });
assert.equal(await siteCard.getAttribute('aria-disabled'), null, 'the website export is still available');
await modal.screenshot({ path: join(SHOTS, 'seo-preflight.png') });
await preflight.getByRole('button', { name: 'View all in Project health' }).click();
health = win.getByRole('dialog', { name: 'Project health' });
await health.waitFor();
await eventually(async () => assert.equal(await isFocused(health.getByTestId('health-seo').getByRole('heading', { level: 3 })), true, 'Project health opens at Search & AI readiness'));
await closeDialog();

step('the preflight leads to the public URL; once it is saved, the export no longer names it');
await win.getByRole('button', { name: 'Export', exact: true }).click();
await preflight.locator('li', { hasText: 'No public site URL is set.' }).getByRole('button', { name: 'Go to Public URL' }).click();
await modal.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await isFocused(urlField), true, 'the Public URL field has focus'));
await urlField.fill('https://riverside.example');
await urlField.press('Tab');
await eventually(async () => assert.equal((await snapshot()).state.site.baseUrl, 'https://riverside.example'));
await win.getByRole('button', { name: 'Export', exact: true }).click();
await preflight.waitFor();
assert.equal(await preflight.locator('li', { hasText: 'No public site URL is set.' }).count(), 0, 'the public URL is no longer named');
assert.equal(await preflight.locator('li', { hasText: 'The Home page asks search engines not to list it.' }).count(), 1, 'Home is still hidden from search');

step('a real website export runs with the warnings still there');
const exportsDir = join(WORK, 'exports');
mkdirSync(exportsDir, { recursive: true });
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
await siteCard.click();
const result = modal.locator('.export-result');
await result.waitFor({ timeout: 300000 });
assert.match(await result.innerText(), /^Exported \d+ pages/, `the website export succeeds: ${await modal.innerText()}`);
await closeDialog();

assert.deepEqual(errors, [], `no page errors: ${errors.join('\n')}`);
await app.close();
cleanup();
console.log('\nseo-health: ok');
