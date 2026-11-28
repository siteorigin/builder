// Search & AI readiness (#592): Project health lists the SEO and agentic audit's findings by pillar, counted on their
// own, filtered by pillar and severity, and each finding one place fixes leads there: a Site details field, a page's
// Search & sharing field, a post's picture or excerpt, or an element on the page. A row fixed while the dialog is open
// leaves focus on the section, never on another finding's action. The export dialog names the findings worth fixing
// before the website goes out, with the way to each and to all of them, and a real website export still runs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const pageShown = () => win.locator('.toolbar .project-title').innerText();
const openPage = async (title) => {
  await openRail('Pages');
  await win.locator('.pages-list [role="option"]', { hasText: title }).first().click();
  await eventually(async () => assert.match(await pageShown(), new RegExp(title), `${title} is open`));
};
/** Which of the open post's pictures the writer shows (flashes) from now on, by their place in the post. */
const watchPictures = () =>
  win.evaluate(() => {
    window.__shownPictures = [];
    window.__pictureWatch?.disconnect();
    window.__pictureWatch = new MutationObserver((changes) => {
      for (const c of changes)
        if (c.target.matches?.('figure.post-figure') && c.target.classList.contains('flash')) window.__shownPictures.push([...document.querySelectorAll('.post-writer-holder:not([hidden]) figure.post-figure')].indexOf(c.target) + 1);
    });
    window.__pictureWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
const picturesShown = () => win.evaluate(() => window.__shownPictures);

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
    // Who publishes the site is said (#586), so the Entity pillar has nothing to report here.
    { type: 'site.update', baseUrl: '', description: '', identity: { kind: 'Organization', sameAs: ['https://www.wikidata.org/wiki/Q123456'] } },
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
    // The posts are linked from the header, so their index is reached from the rest of the site (#1635).
    { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', value: [...s0.site.shell.header.nodes[header].props.links, { id: 'i_journal', label: 'Journal', link: { type: 'collection', target: 'posts' } }] },
    { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'links', itemId: aboutItem, field: 'label', value: 'Click here!' }
  ],
  'Set up the site'
);

step('Project health counts Search & AI readiness on its own, by area: what needs fixing first, the notes folded below it');
let health = await openHealth();
const seo = health.getByTestId('health-seo');
const seoHeading = seo.getByRole('heading', { level: 3 });
const rows = seo.locator('.health-row');
const row = (text) => seo.locator('.health-row', { hasText: text });
const seoCount = async () => Number((await seo.locator('h3 .health-count').innerText()).trim());
// Each area's rows, as their tone and the finding's words (after what screen readers hear of its severity): the list of
// what needs fixing, and the optional notes folded below it.
const pillarRows = (places) =>
  places.evaluateAll((els) =>
    els.map((el) => ({
      pillar: el.dataset.pillar,
      name: el.querySelector('h4').textContent.trim(),
      rows: [...el.querySelectorAll('.health-row')].map((r) => {
        const said = [...r.querySelector('.health-text').childNodes].filter((n) => !n.classList?.contains('sr-only') && !n.classList?.contains('health-hint'));
        return `${r.classList.contains('warn') ? 'warning' : 'note'}: ${said.map((n) => n.textContent).join('').trim()}`;
      })
    }))
  );
// The section counts what needs fixing (the seven warnings); all eleven findings are listed.
await eventually(async () => assert.equal(await seoCount(), 7, 'the site’s seven warnings are counted'));
const total = 11;
assert.match(await seoHeading.innerText(), /^Search & AI readiness\s+7$/);
assert.equal(await rows.count(), total, 'every finding has its row');
const expected = {
  technical: [/^warning: No public site URL is set\.$/, /^warning: The Home page asks search engines not to list it\.$/],
  agentic: [/^warning: Posts: “Spring pottery classes”: picture 2 in its text has no description\.$/],
  content: [/^warning: “Kiln hire” has no description\.$/, /^warning: “Spring pottery classes” \(Posts\) has no description\.$/, /^warning: No link on the rest of the site leads to “Kiln hire”\.$/],
  social: [/^warning: The site has no sharing image\.$/]
};
const expectedNotes = {
  content: [/^note: “About” has a description of \d+ characters/, /^note: “Contact” has a description of \d+ characters/, /^note: A link says only “Click here!” in the shared header\.$/],
  social: [/^note: The site has no icon of its own/]
};
for (const [places, want, what] of [
  [seo.locator(':scope > .health-list > .health-place'), expected, 'what needs fixing'],
  [seo.locator('.seo-notes .health-place'), expectedNotes, 'the notes']
]) {
  const found = await pillarRows(places);
  assert.deepEqual(found.map((p) => p.pillar), Object.keys(want), `${what}: the areas with findings, in order`);
  for (const p of found) {
    assert.equal(p.rows.length, want[p.pillar].length, `${p.name}: ${p.rows.join(' | ')}`);
    p.rows.forEach((text, i) => assert.match(text, want[p.pillar][i], `${p.name} row ${i + 1}`));
  }
}
const notesFold = seo.locator('.seo-notes');
assert.match(await notesFold.locator('> summary').innerText(), /^4 notes, optional$/, 'the notes wait, folded, below the warnings');
assert.equal(await notesFold.getAttribute('open'), null, 'folded until asked for');
assert.equal(await seo.locator('.seo-readiness-summary').innerText(), '7 warnings and 4 notes. 4 of 5 areas need attention.');
assert.equal(await row('No public site URL is set.').getByRole('button', { name: 'Go to Public URL' }).count(), 1);
assert.equal(await row('The Home page asks search engines not to list it.').getByRole('button', { name: 'Go to Search & sharing' }).count(), 1);
assert.equal(await row('“Kiln hire” has no description.').getByRole('button', { name: 'Go to Search & sharing' }).count(), 1);
assert.equal(await row('“Spring pottery classes” (Posts) has no description.').getByRole('button', { name: 'Open post' }).count(), 1);
assert.equal(await row('picture 2 in its text has no description').getByRole('button', { name: 'Go to picture' }).count(), 1);
// A note's way to its fix is there once the notes are opened.
await notesFold.locator('> summary').click();
assert.equal(await row('A link says only “Click here!” in the shared header.').getByRole('button', { name: 'Show on page' }).count(), 1);
assert.equal(await row('The site has no sharing image.').getByRole('button', { name: 'Go to sharing image' }).count(), 1);
// Fixed by a link from elsewhere, not on the page itself: said, with no button that would mislead.
const unlinked = row('No link on the rest of the site leads to “Kiln hire”.');
assert.equal(await unlinked.getByRole('button').count(), 0, 'an unlinked page has no single place to fix it');
assert.match(await unlinked.innerText(), /Link to it from a menu or a related page\./, 'the row says why it matters and what to do');
// The status bar's count stays the project's own: the readiness findings are not in it.
const ownWarnings = (await snapshot()).diagnostics.filter((d) => d.severity === 'warning').length;
assert.equal(Number(await health.locator('[data-group="warnings"] h3 .health-count').innerText()), ownWarnings, 'Warnings counts the project’s own warnings, and no readiness finding');
// The entry's picture is also one of the project's own warnings, and leads to the same place there.
const generalAlt = health.locator('[data-group="warnings"] .health-row', { hasText: 'picture 2 in its text has no description' });
assert.equal(await generalAlt.getByRole('button', { name: 'Go to picture' }).count(), 1, 'the project’s own warning leads to the picture too');
await health.screenshot({ path: join(SHOTS, 'seo-health.png') });
await health.locator('.health-jumps').getByRole('button', { name: /Search & AI/ }).click();
await eventually(async () => assert.equal(await isFocused(seoHeading), true, 'the summary’s jump goes to the section'));

step('the filters show one area, one severity, or both; every count is what the choice lists');
const pillarSelect = seo.getByLabel('Area', { exact: true });
const severitySelect = seo.getByLabel('Severity', { exact: true });
const options = (select) => select.locator('option').allInnerTexts();
assert.deepEqual(await options(pillarSelect), ['All areas (11)', 'Technical (2)', 'Entity & structured data (0)', 'Agentic readiness (1)', 'Content & links (6)', 'Social & performance (2)']);
assert.deepEqual(await options(severitySelect), ['All (11)', 'Warnings (7)', 'Notes (4)']);
await pillarSelect.selectOption('content');
// The area's warnings, then its notes, folded below them.
await eventually(async () => assert.deepEqual(await seo.locator('.health-place').evaluateAll((els) => els.map((el) => el.dataset.pillar)), ['content', 'content']));
assert.equal(await rows.count(), 6, 'Content & links lists what its option counted');
assert.equal(await seo.locator('.seo-showing').innerText(), `6 of ${total} match, including 3 optional notes`);
// The severities, counted in Content & links.
assert.deepEqual(await options(severitySelect), ['All (6)', 'Warnings (3)', 'Notes (3)']);
await severitySelect.selectOption('info');
await eventually(async () => assert.equal(await rows.count(), 3));
assert.equal(await seo.locator('.health-row.warn').count(), 0, 'no warning is shown');
assert.equal(await row('A link says only “Click here!”').count(), 1, 'the link’s note is shown');
// The pillars, counted among the notes.
assert.deepEqual(await options(pillarSelect), ['All areas (4)', 'Technical (0)', 'Entity & structured data (0)', 'Agentic readiness (0)', 'Content & links (3)', 'Social & performance (1)']);
await pillarSelect.selectOption('social');
await eventually(async () => assert.equal(await rows.count(), 1));
assert.match(await rows.first().innerText(), /The site has no icon of its own/, 'Social & performance’s one note is the site icon');
await pillarSelect.selectOption('entity');
await eventually(async () => assert.equal(await rows.count(), 0));
assert.match(await seo.locator('.seo-empty').innerText(), /No notes in Entity & structured data\./);
await seo.getByRole('button', { name: 'Clear filters' }).click();
await eventually(async () => assert.equal(await rows.count(), total, 'clearing the filters shows every finding again'));
assert.equal(await isFocused(pillarSelect), true, 'focus moves to the pillar filter');

step('a finding fixed while the dialog is open takes its row with it; focus elsewhere stays where it is');
const footerClose = health.locator('.modal-foot').getByRole('button', { name: 'Close', exact: true });
await footerClose.focus();
await apply([{ type: 'page.update', pageId: Object.values(s0.pages).find((p) => p.title === 'Contact').id, description: 'Call in, write or visit the studio by the river: we answer every message within a day.' }], 'Describe Contact');
await eventually(async () => assert.equal(await rows.count(), total - 1, 'the fixed note is gone'));
assert.equal(await seoCount(), 7, 'the warnings are still counted');
assert.equal(await isFocused(footerClose), true, 'focus outside the section is left alone');
const kilnAction = row('“Kiln hire” has no description.').getByRole('button', { name: 'Go to Search & sharing' });
await kilnAction.focus();
// A description too short replaces the missing one with a note about its length: as many findings as before.
await apply([{ type: 'page.update', pageId: 'pg_kilns', description: 'Hire our kiln' }], 'Describe Kiln hire');
await eventually(async () => assert.equal(await row('“Kiln hire” has no description.').count(), 0, 'the fixed finding is gone'));
assert.equal(await row('“Kiln hire” has a description of 13 characters').count(), 1, 'its note took its place');
assert.equal(await rows.count(), total - 1, 'as many findings as before');
assert.equal(await seoCount(), 6, 'one warning fewer to fix');
await eventually(async () => assert.equal(await isFocused(seoHeading), true, 'focus is on the section’s heading, not another finding’s action'));

step('site: Go to Public URL opens Site details at the field');
await row('No public site URL is set.').getByRole('button', { name: 'Go to Public URL' }).click();
await modal.waitFor({ state: 'detached' });
const urlField = win.locator('#dock-panel-styles').getByRole('textbox', { name: 'Public URL', exact: true });
await eventually(async () => assert.equal(await isFocused(urlField), true, 'the Public URL field has focus'));

step('page: from About, Go to Search & sharing opens Home with its search setting focused');
const homeTitle = s0.pages[homeId].title;
await openPage('About');
health = await openHealth();
await row('The Home page asks search engines not to list it.').getByRole('button', { name: 'Go to Search & sharing' }).click();
await modal.waitFor({ state: 'detached' });
await eventually(async () => assert.match(await pageShown(), new RegExp(homeTitle), 'Home is open'));
await eventually(async () => assert.equal(await isFocused(win.locator('#page-seo-noindex')), true, 'the Home page’s search setting has focus'));

step('entry: from a page, Open post opens the post with its excerpt focused');
const writer = win.locator('.post-writer-holder:not([hidden])');
assert.equal(await writer.count(), 0, 'no post is open');
health = await openHealth();
await row('“Spring pottery classes” (Posts) has no description.').getByRole('button', { name: 'Open post' }).click();
await modal.waitFor({ state: 'detached' });
await writer.waitFor();
assert.equal(await writer.locator('.post-title-input').inputValue(), 'Spring pottery classes');
await eventually(async () => assert.equal(await isFocused(writer.locator('[data-entry-field="excerpt"] textarea')), true, 'the excerpt has focus'));

step('entry: Go to picture, from a page, opens the post at its second picture; the project’s own warning does too');
// A page chosen puts the writer away: the jump has to open the post itself.
await openPage('About');
await eventually(async () => assert.equal(await writer.count(), 0, 'no post is open'));
for (const where of ['seo', 'warnings']) {
  health = await openHealth();
  await watchPictures();
  const list = where === 'warnings' ? health.locator('[data-group="warnings"]') : health.getByTestId('health-seo');
  await list.locator('.health-row', { hasText: 'picture 2 in its text has no description' }).getByRole('button', { name: 'Go to picture' }).click();
  await modal.waitFor({ state: 'detached' });
  await writer.waitFor();
  assert.equal(await writer.locator('.post-title-input').inputValue(), 'Spring pottery classes', `${where}: the post is open`);
  await eventually(async () => assert.deepEqual(await picturesShown(), [2], `${where}: the second picture is shown`));
}

step('element: from the post, Show on page selects the link’s menu in the shared header');
health = await openHealth();
// A note: it waits in the folded notes, below what needs fixing.
await seo.locator('.seo-notes > summary').click();
await row('A link says only “Click here!” in the shared header.').getByRole('button', { name: 'Show on page' }).click();
await modal.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await writer.count(), 0, 'the post writer gives way to the page'));
// Opening Layers shows the selection; it never makes one.
await openRail('Layers');
await eventually(async () => assert.equal(await win.locator(`[role="treeitem"][data-owner="shell:header"][data-node="${header}"]`).getAttribute('aria-selected'), 'true', 'the header’s menu is selected'));

step('the export dialog counts what to fix before the website goes out, without stopping it, and leads to Project health (#1288)');
await win.getByRole('button', { name: 'Export', exact: true }).click();
const preflight = modal.getByTestId('export-health-summary');
await eventually(async () => assert.match(await preflight.innerText(), /^6 search and sharing suggestions( and \d+ more notes?)?\./));
assert.doesNotMatch(await modal.innerText(), /won’t stop the export/);
// The findings themselves, and their ways to the fix, are in Project health.
assert.equal(await modal.getByText('No public site URL is set.').count(), 0, 'no finding is listed in the dialog');
assert.equal(await modal.getByRole('button', { name: 'Go to Public URL' }).count(), 0, 'no finding leads anywhere from the dialog');
const siteCard = modal.getByRole('button', { name: /Website files, ready to upload/ });
assert.equal(await siteCard.getAttribute('aria-disabled'), null, 'the website export is still available');
await modal.screenshot({ path: join(SHOTS, 'seo-preflight.png') });
await preflight.getByRole('button', { name: 'Review in Project health' }).click();
health = win.getByRole('dialog', { name: 'Project health' });
await health.waitFor();
await eventually(async () => assert.equal(await isFocused(health.getByTestId('health-seo').getByRole('heading', { level: 3 })), true, 'Project health opens at Search & AI readiness'));
await closeDialog();

step('a real website export runs with every warning still there, the missing public URL among them');
const exportsDir = join(WORK, 'exports');
mkdirSync(exportsDir, { recursive: true });
await win.getByRole('button', { name: 'Export', exact: true }).click();
await preflight.filter({ hasText: /^6 search and sharing suggestions/ }).waitFor();
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
await siteCard.click();
const result = modal.locator('.export-result');
await result.waitFor({ timeout: 300000 });
assert.match(await result.innerText(), /^Exported \d+ pages/, `the website export succeeds: ${await modal.innerText()}`);
assert.ok(existsSync(join(exportsDir, 'riverside-studio-site', 'kiln-hire', 'index.html')), 'the website was written, Kiln hire with it');
await closeDialog();

step('the count leads to the public URL through Project health; once it is saved, the export counts one fewer');
await win.getByRole('button', { name: 'Export', exact: true }).click();
await preflight.getByRole('button', { name: 'Review in Project health' }).click();
await row('No public site URL is set.').getByRole('button', { name: 'Go to Public URL' }).click();
await modal.waitFor({ state: 'detached' });
await eventually(async () => assert.equal(await isFocused(urlField), true, 'the Public URL field has focus'));
// A host of its own: a reserved example one is itself a warning (#1635).
await urlField.fill('https://riverside-pottery.co.za');
await urlField.press('Tab');
await eventually(async () => assert.equal((await snapshot()).state.site.baseUrl, 'https://riverside-pottery.co.za'));
await win.getByRole('button', { name: 'Export', exact: true }).click();
await eventually(async () => assert.match(await preflight.innerText(), /^5 search and sharing suggestions( and \d+ more notes?)?\./));
await closeDialog();

assert.deepEqual(errors, [], `no page errors: ${errors.join('\n')}`);
await app.close();
cleanup();
console.log('\nseo-health: ok');
