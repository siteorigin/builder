// Opening an editable project ZIP (#263): a Business project with its sample images is exported as a ZIP file, and a
// recipient opens that ZIP file from Welcome's Open project. They choose where the working copy goes, trust it, and
// edit it with its pages and media intact. Opening the same ZIP file again makes a second copy beside the first
// without touching it; cancelling while it unpacks leaves nothing behind; a website ZIP is explained instead. The
// app's chooser fixtures answer its native choosers, so nothing appears on screen.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { answerChoosers, chooseMenu, choosersShown, createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('open-zip');
const { app, win, errors } = await launch(WORK);
const name = 'Harbour Lane Studio';
const exportsDir = join(WORK, 'exports');
const recipient = join(WORK, 'recipient');
mkdirSync(exportsDir, { recursive: true });
mkdirSync(recipient, { recursive: true });
const zip = join(exportsDir, 'harbour-lane-studio-source.zip');

/** The next native pickers answer with these paths, in order: the ZIP file, then where its copy goes. A picker nobody
 *  answered is closed and recorded, which the end of the script checks for. */
const answerPickers = (paths) => answerChoosers(app, paths.map((p) => ({ dialog: 'open', paths: [p] })));
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
/** Every library file of a project, with its hash. */
const library = (dir, snap) => Object.fromEntries(Object.values(snap.state.assets.assets).map((a) => [a.file, sha(join(dir, a.file))]));
/** Choose File > Open Project… in the native menu, through its own handler, as the menu bar or its shortcut does. */
const openProjectCommand = () => chooseMenu(app, ['File', 'Open Project…']);

step('the sender exports the editable project as a ZIP file');
await createProject(win, { name, parentDir: join(WORK, 'sender'), starter: 'business', sampleImages: true });
const sent = await snapshot();
const sentPages = sent.state.site.pageOrder.map((id) => sent.state.pages[id].route);
const sentLibrary = library(sent.dir, sent);
assert.ok(Object.keys(sentLibrary).length >= 3, `the Business starter brings its sample images (${Object.keys(sentLibrary).length})`);
await answerChoosers(app, [{ dialog: 'save', path: zip }]);
const exported = await withTimeout(win.evaluate(() => window.builder.project.exportSource('zip')), 120000, 'Source ZIP export');
assert.equal(exported.ok, true, `source ZIP export succeeds: ${exported.message}`);
const zipHash = sha(zip);
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

step('the recipient opens the ZIP file from Welcome, chooses where it goes, and trusts it');
await answerPickers([zip, recipient]);
await win.getByRole('button', { name: /Open project/ }).first().click();
const trust = win.getByRole('dialog', { name: 'Trust this project?' });
await trust.waitFor({ timeout: 30000 });
assert.match(await trust.innerText(), new RegExp(name), 'the trust prompt names the project');
const first = join(realpathSync(recipient), 'harbour-lane-studio');
assert.ok(existsSync(join(first, 'siteorigin.project.json')), 'the working copy is a project folder of its own, not nested');
await trust.getByRole('button', { name: 'Trust and open' }).click();
await win.waitForSelector('.editor', { timeout: 90000 });
await eventually(async () => assert.equal((await snapshot())?.dir, first, 'the working copy is the project open now'), 30000);
const opened = await snapshot();
assert.deepEqual(
  opened.state.site.pageOrder.map((id) => opened.state.pages[id].route),
  sentPages,
  'every page arrived'
);
assert.deepEqual(library(first, opened), sentLibrary, 'every image arrived, byte for byte');
assert.equal(sha(zip), zipHash, 'the ZIP file is not changed');
// The working copy's own website tools run: its preview shows the home page.
await win.frameLocator('.frame-box iframe').locator('h1').first().waitFor({ timeout: 120000 });

step('the working copy can be edited');
const homeId = opened.state.site.homePageId;
const renamed = await win.evaluate(
  ({ pageId, rev }) => window.builder.project.apply({ operations: [{ type: 'page.update', pageId, description: 'Edited by the recipient' }], expectedRevision: rev }, { label: 'Describe home' }),
  { pageId: homeId, rev: opened.revision }
);
assert.equal(renamed.ok, true, `the edit applies: ${JSON.stringify(renamed)}`);
const homeFile = join(first, 'siteorigin', 'pages', `${homeId}.json`);
await eventually(() => assert.match(readFileSync(homeFile, 'utf8'), /Edited by the recipient/, 'the edit is saved in the working copy'));
const firstHome = readFileSync(homeFile, 'utf8');

step('opening the same ZIP file again makes a second copy and leaves the first as it is');
await answerPickers([zip, recipient]);
await openProjectCommand();
await trust.waitFor({ timeout: 30000 });
const second = join(realpathSync(recipient), 'harbour-lane-studio-2');
assert.ok(existsSync(join(second, 'siteorigin.project.json')), 'the second copy is beside the first');
await trust.getByRole('button', { name: 'Cancel' }).click();
await trust.waitFor({ state: 'detached' });
assert.equal((await snapshot()).dir, first, 'the first copy is still the project open');
assert.equal(readFileSync(homeFile, 'utf8'), firstHome, 'the first copy keeps its edit');
assert.doesNotMatch(readFileSync(join(second, 'siteorigin', 'pages', `${homeId}.json`), 'utf8'), /Edited by the recipient/, 'the second copy is the project as sent');
assert.deepEqual(Object.fromEntries(Object.keys(sentLibrary).map((f) => [f, sha(join(second, f))])), sentLibrary, 'the second copy has every image too');
assert.deepEqual(library(first, opened), sentLibrary, 'the first copy keeps its images');

step('cancelling while it unpacks leaves nothing behind');
// Unpacking waits at its first folder until Cancel has been pressed, so the dialog is there to press.
await app.evaluate(() => {
  const fsp = process.getBuiltinModule('node:fs').promises;
  const mkdir = fsp.mkdir;
  let release;
  const gate = new Promise((r) => (release = r));
  globalThis.__unpackGate = { release, restore: () => (fsp.mkdir = mkdir) };
  fsp.mkdir = async function (p, o) {
    if (String(p).includes('.siteorigin-open-')) await gate;
    return mkdir.call(this, p, o);
  };
});
await answerPickers([zip, recipient]);
await openProjectCommand();
const unpacking = win.getByRole('dialog', { name: `Unpacking ${name}` });
await unpacking.waitFor({ timeout: 30000 });
await unpacking.getByRole('button', { name: 'Cancel' }).click();
// Calls from the window reach the main process in order: once this one is answered, Cancel has arrived too.
await win.evaluate(() => window.builder.projects.recents());
await app.evaluate(() => globalThis.__unpackGate.release());
await unpacking.waitFor({ state: 'detached', timeout: 30000 });
await app.evaluate(() => globalThis.__unpackGate.restore());
await eventually(() => assert.deepEqual(readdirSync(recipient).sort(), ['harbour-lane-studio', 'harbour-lane-studio-2'], 'no third copy and no partial files'));
assert.equal(await win.locator('.toast.error').count(), 0, 'a cancelled unpacking is no error');
assert.equal(await trust.count(), 0, 'nothing is offered to trust');
assert.equal((await snapshot()).dir, first, 'the first copy is still the project open');

step('a website ZIP is explained, with how to ask for the editable version');
const zipTool = spawnSync('zip', ['-v'], { encoding: 'utf8' });
if (zipTool.status === 0) {
  const site = join(WORK, 'site');
  mkdirSync(join(site, '_app'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<h1>Harbour Lane Studio</h1>');
  writeFileSync(join(site, '_app', 'start.js'), '');
  const siteZip = join(exportsDir, 'harbour-lane-studio-site.zip');
  assert.equal(spawnSync('zip', ['-rq', siteZip, '.'], { cwd: site }).status, 0, 'the website ZIP is made');
  await answerPickers([siteZip]);
  await openProjectCommand();
  // It says to ask for the editable version, the way the sender's Export dialog names it.
  await win.locator('.toast.error', { hasText: 'Editable project, saved as a ZIP file' }).waitFor({ timeout: 30000 });
  assert.deepEqual(readdirSync(recipient).sort(), ['harbour-lane-studio', 'harbour-lane-studio-2'], 'nothing is unpacked');
} else console.log('(no zip command here: skipping the website ZIP)');

assert.deepEqual(
  (await choosersShown(app)).filter((c) => c.outcome !== 'chosen').map((c) => `${c.title}: ${c.outcome}`),
  [],
  'every picker shown was one the script answered'
);
assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nopen-zip: all checks passed');
