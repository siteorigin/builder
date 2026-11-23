// A website export whose production build fails (#69): the dialog must say what went wrong and where, offer the
// technical details to read and copy, and a retry after the fix must succeed. A code component that throws only
// while the site is being built keeps the editor's preview working, as it did for the author who reported this, so
// the failure is the generic prerender one and not a validation the editor would have caught.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('export-failure');
const { app, win, errors } = await launch(WORK);

const CAUSE = 'The opening hours widget could not read its hours';
const BROKEN = `<script>\n  import { building } from '$app/environment';\n  if (building) throw new Error('${CAUSE}');\n</script>\n<section class="hours"><p>Open every day</p></section>\n`;
const FIXED = `<section class="hours"><p>Open every day</p></section>\n`;

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
  return r;
};

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  const exportsDir = join(WORK, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  await app.evaluate(({ dialog }, parent) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, exportsDir);

  step('a Contact page with a component that fails while the site is built');
  await win.evaluate(() => window.builder.app.setSettings({ developerMode: true }));
  await apply([{ type: 'component.createCode', name: 'Opening hours', description: 'Shows when the studio is open.', source: BROKEN }], 'Create the component');
  const state = (await snapshot()).state;
  const definitionId = Object.entries(state.components).find(([, c]) => c.name === 'Opening hours')?.[0];
  assert.ok(definitionId, 'the component exists');
  const contactId = Object.values(state.pages).find((p) => p.route === '/contact/')?.id;
  assert.ok(contactId, 'the starter has a Contact page');
  await apply([{ type: 'node.insert', owner: { kind: 'page', id: contactId }, definitionId }], 'Add it to Contact');

  step('the export fails, and says why');
  await win.locator('.export-btn').click();
  const dialog = win.getByRole('dialog', { name: 'Export your website' });
  await dialog.waitFor();
  // The headless window is not focused, so the page's clipboard would refuse; record what the dialog copies instead.
  await win.evaluate(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => void window.__copied.push(t) } });
  });
  const website = dialog.getByRole('button', { name: /Website files, ready to upload/ });
  await website.click();
  const failure = dialog.getByRole('alert');
  await withTimeout(failure.waitFor({ timeout: 300000 }), 310000, 'The failed export');
  const shown = await failure.innerText();
  console.log(`\n--- what the dialog shows ---\n${shown}\n---`);
  assert.match(shown, /The production build failed/, 'the dialog says the build failed');
  assert.ok(shown.includes(CAUSE), `the dialog shows the underlying error, not only "Prerendering failed": ${shown}`);
  assert.match(shown, /\/contact\//, 'the dialog names the page the build was working on');
  assert.match(shown, /“Opening hours” component/, 'the dialog names the component that failed, as the author knows it');
  assert.ok(!/handleHttpError|prerender_http_error/.test(shown), 'the framework\'s pointer to its own configuration and its error code are left to the details');
  assert.equal((shown.match(/•/g) ?? []).length, 2, `the dialog lists the cause and where the build was working, and nothing else: ${shown}`);
  assert.ok(!shown.includes(WORK) && !shown.includes(homedir()), 'the dialog shows no absolute path from this machine');

  step('the technical details can be read and copied');
  const details = dialog.getByTestId('export-build-details');
  assert.equal(await details.evaluate((el) => !!el.closest('[role="alert"]')), false, 'the details sit outside the alert, so opening or copying them does not make it announce itself again');
  const text = details.getByTestId('export-build-details-text');
  assert.equal(await text.isVisible(), false, 'the details start closed');
  await details.getByRole('button', { name: 'Technical details' }).click();
  await text.waitFor();
  const report = await text.innerText();
  console.log(`\n--- the technical details ---\n${report}\n---`);
  assert.ok(report.includes(CAUSE), 'the report holds the underlying error');
  assert.match(report, /SiteOrigin Builder .* on /, 'the report says which app and system it came from');
  assert.match(report, /Build output/, 'the report holds what the build printed');
  assert.ok(!report.includes(WORK) && !report.includes(homedir()), `the report shows no absolute path from this machine:\n${report}`);
  await details.getByRole('button', { name: 'Copy details' }).click();
  await dialog.getByText(/^Copied/).waitFor();
  const copied = await win.evaluate(() => window.__copied);
  assert.equal(copied.length, 1, 'Copy details copied once');
  assert.equal(copied[0].trim(), report.trim(), 'Copy details copies exactly the report that is shown');

  step('a failed export publishes nothing');
  assert.deepEqual(readdirSync(exportsDir), [], 'no folder was written');
  assert.deepEqual((await snapshot()).recentExports, [], 'the failure is not listed as an export');

  step('fixing the component and exporting again succeeds');
  await apply([{ type: 'component.updateSource', definitionId, source: FIXED }], 'Fix the component');
  await website.click();
  await dialog.getByRole('status').filter({ hasText: /^Exported \d+ pages/ }).waitFor({ timeout: 300000 });
  assert.equal(await dialog.getByRole('alert').count(), 0, 'the earlier failure is gone from the dialog');
  const [folder] = readdirSync(exportsDir);
  assert.ok(folder, 'the retry wrote the website');
  const contact = readFileSync(join(exportsDir, folder, 'contact', 'index.html'), 'utf8');
  assert.ok(contact.includes('Open every day'), 'the fixed component is on the exported Contact page');
  assert.ok(existsSync(join(exportsDir, folder, 'index.html')), 'the home page was exported');

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  await app.close();
}

cleanup();
console.log('\nexport-failure: passed');
