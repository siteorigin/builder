// Export readiness (#17): a contact form visitors cannot send, and a site with no public URL. Project health's form
// warning goes to the form (its page opened, the form selected, Content open, the setting it needs focused); the
// export dialog names the form before the export without stopping it; a real website folder export says both in its
// notes, each leading to where it is fixed; and once the public URL is saved, the export's note and the field itself
// say the website needs exporting again.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('export-readiness');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Lookbook Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'lookbook-studio');
const site = () => JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);

const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const openPage = async (title, route) => {
  await openRail('Pages');
  await win.locator('.pages-list [role="option"]', { hasText: title }).first().click();
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), new RegExp(title), `${title} is open`));
  await eventually(async () => assert.equal(await frame.locator('body').evaluate(() => location.pathname), route, `the canvas shows ${route}`), 30000);
};
const inspector = win.locator('#dock-panel-inspect');
const contentHead = () => inspector.locator('button.section-head', { hasText: /^Content/ }).first();
const endpoint = () => inspector.getByLabel('Form endpoint URL', { exact: true });
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement);
const modal = win.locator('.modal');
const closeDialog = async () => {
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await modal.waitFor({ state: 'detached' });
};
/** The form selected on Lookbook, with Content open and the endpoint field focused. */
const expectAtForm = async (how) => {
  await modal.waitFor({ state: 'detached' });
  await eventually(async () => assert.match(await win.locator('.toolbar .project-title').innerText(), /Lookbook/, `${how}: Lookbook is open`));
  await eventually(async () => assert.equal(await inspector.locator('.insp-name h3', { hasText: 'Contact form' }).count(), 1, `${how}: the form is selected`));
  await eventually(async () => assert.equal(await contentHead().getAttribute('aria-expanded'), 'true', `${how}: its Content is open`));
  await eventually(async () => assert.equal(await isFocused(endpoint()), true, `${how}: the endpoint field has focus`));
};

assert.equal(site().baseUrl, undefined, 'a new site has no public URL');
const home = (await snapshot()).state;
const homeTitle = home.pages[home.site.homePageId].title;

step('a Lookbook page with a contact form left unconnected');
assert.ok((await apply([{ type: 'page.create', title: 'Lookbook', route: '/lookbook/', starter: 'intro' }], 'Add page')).ok);
await openPage('Lookbook', '/lookbook/');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Contact form' }).click();
await inspector.locator('.insp-name h3', { hasText: 'Contact form' }).waitFor();
const lookbookId = (await snapshot()).state.site.pageOrder.find((id) => home.pages[id] === undefined);
const formId = await eventually(async () => {
  const d = (await snapshot()).diagnostics.find((x) => x.code === 'FORM_UNCONNECTED' && x.owner?.id === lookbookId);
  assert.ok(d, 'Project health finds the form cannot send');
  return d.nodeId;
});
// Content closed, on another page: the action has to open both.
if ((await contentHead().getAttribute('aria-expanded')) === 'true') await contentHead().click();
await openPage(homeTitle, '/');

step('Project health: Go to form opens the form where it is, with its setting focused');
await win.getByTitle('Project health: check this project for problems').click();
const health = win.getByRole('dialog', { name: 'Project health' });
await health.waitFor();
const row = health.locator('li', { hasText: 'the contact form is not connected to a form service' }).last();
await row.getByRole('button', { name: 'Go to form' }).waitFor();
await health.screenshot({ path: join(SHOTS, 'export-readiness-health.png') });
await row.getByRole('button', { name: 'Go to form' }).click();
await expectAtForm('from Project health');

step('the export dialog names the form before the export, without stopping it');
await openPage(homeTitle, '/');
await win.getByRole('button', { name: 'Export', exact: true }).click();
// One line in the dialog's "Visitors can’t reach you yet" box (#1288), with its one action.
const box = modal.getByTestId('export-visitor-review');
const review = box.getByTestId('export-form-note').filter({ hasText: 'Lookbook: the contact form is not connected' });
await review.waitFor();
assert.match(await box.innerText(), /^Visitors can’t reach you yet/);
assert.doesNotMatch(await box.innerText(), /won’t stop the export|You can still export/);
assert.match(await review.innerText(), /Lookbook: the contact form is not connected to a form service, so visitors cannot send it\./);
assert.equal(await review.getByRole('button').count(), 1, 'one action for the form');
const siteCard = modal.getByRole('button', { name: /Website files, ready to upload/ });
assert.equal(await siteCard.getAttribute('aria-disabled'), null, 'the website export is still available');
await modal.screenshot({ path: join(SHOTS, 'export-readiness-review.png') });
await review.getByRole('button', { name: 'Go to form' }).click();
await expectAtForm('from the export review');

step('a real website folder export with no public URL says both, each with its way to the fix');
// The folder chooser is answered with a folder that is there; the export makes its own new folder inside it.
const exportsDir = join(WORK, 'exports');
mkdirSync(exportsDir, { recursive: true });
// From another page, so the result's own Go to form has somewhere to go.
await openPage(homeTitle, '/');
await win.getByRole('button', { name: 'Export', exact: true }).click();
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
await modal.getByRole('button', { name: /Website files, ready to upload/ }).click();
const result = modal.locator('.export-result');
await result.waitFor({ timeout: 300000 });
assert.match(await result.innerText(), /^Exported \d+ pages/, `the website export succeeds: ${await modal.innerText()}`);
const out = join(exportsDir, 'lookbook-studio-site');
assert.match(readFileSync(join(out, 'lookbook', 'index.html'), 'utf8'), /<form[\s>]/, 'the Lookbook page was exported with its form');
assert.equal(existsSync(join(out, 'sitemap.xml')), false, 'no sitemap without a public URL');
const latest = modal.getByRole('region', { name: 'Recent exports' }).getByRole('listitem').first();
const toggle = latest.getByRole('button', { name: /Review \d+ export notes/ });
if (await toggle.count()) await toggle.click();
const formNote = latest.locator('.export-note-line', { hasText: 'Lookbook: the contact form is not connected' });
const urlNote = latest.locator('.export-note-line', { hasText: 'No public site URL is set' });
assert.equal(await formNote.count(), 1, 'the export names the form visitors cannot send');
assert.equal(await urlNote.count(), 1, 'the export says it has no public URL');
assert.match(await urlNote.innerText(), /add it as the Public URL in Site styles › Site details/, 'the note names where the field is');
assert.equal(await formNote.getByRole('button', { name: 'Go to form' }).count(), 1);
assert.equal(await urlNote.getByRole('button', { name: 'Go to Public URL' }).count(), 1);
// The form's note leads the notes: failed enquiries matter most.
assert.match(await latest.locator('.export-note-line').first().innerText(), /contact form/);
await modal.screenshot({ path: join(SHOTS, 'export-readiness-result.png') });
await formNote.getByRole('button', { name: 'Go to form' }).click();
await expectAtForm('from the export result');

step('reopened, the export keeps the notes that lead somewhere; Go to Public URL opens Site details on the field, focused');
await win.getByRole('button', { name: 'Export', exact: true }).click();
const kept = modal.getByRole('region', { name: 'Recent exports' }).getByRole('listitem').first();
await kept.locator('.export-note-line', { hasText: 'No public site URL is set' }).waitFor();
assert.equal(await kept.locator('.export-note-line').count(), 2, 'the form and the public URL, and not the notes with nothing to fix');
await kept.locator('.export-note-line', { hasText: 'No public site URL is set' }).getByRole('button', { name: 'Go to Public URL' }).click();
await modal.waitFor({ state: 'detached' });
const detailsHead = win.locator('#dock-panel-styles button.section-head', { hasText: 'Site details' });
await eventually(async () => assert.equal(await detailsHead.getAttribute('aria-expanded'), 'true', 'Site details is open'));
const urlField = win.locator('#dock-panel-styles').getByRole('textbox', { name: 'Public URL', exact: true });
await eventually(async () => assert.equal(await isFocused(urlField), true, 'the Public URL field has focus'));
assert.equal(await urlField.isVisible(), true, 'Site styles is shown');

step('a public URL saved since says the website needs exporting again');
await urlField.fill('https://lookbook.example');
await urlField.press('Tab');
await eventually(() => assert.equal(site().baseUrl, 'https://lookbook.example'));
const urlHint = win.locator('#dock-panel-styles .field').filter({ has: win.locator('label', { hasText: 'Public URL' }) }).locator('.field-hint');
await eventually(async () => assert.match(await urlHint.innerText(), /The website you last exported was built without it: export it again/));
await win.getByRole('button', { name: 'Export', exact: true }).click();
const reopened = modal.getByRole('region', { name: 'Recent exports' }).getByRole('listitem').first();
await eventually(async () => assert.match(await reopened.innerText(), /Public URL set since this export\. Export again to include canonical links and the sitemap\./));
// The form still cannot send: its note still leads to it.
assert.equal(await reopened.locator('.export-note-line', { hasText: 'contact form' }).getByRole('button', { name: 'Go to form' }).count(), 1);
const connected = await apply([{ type: 'instance.setProp', owner: { kind: 'page', id: lookbookId }, nodeId: formId, prop: 'endpoint', value: 'https://formspree.io/f/abcd1234' }], 'Connect the form');
assert.ok(connected.ok, JSON.stringify(connected));
await eventually(async () => assert.match(await reopened.innerText(), /Connected since this export\. Export again so visitors can send it\./));
await eventually(async () => assert.equal(await modal.getByTestId('export-form-note').count(), 0, 'nothing left to review before the next export'));
await modal.screenshot({ path: join(SHOTS, 'export-readiness-since.png') });
await closeDialog();

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nexport-readiness: all checks passed');
