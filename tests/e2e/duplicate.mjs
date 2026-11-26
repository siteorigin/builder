// Duplicate project (#176): the copy is given its own name in a dialog that explains a folder it cannot use beside the
// folder, the original stays open until Open copy, and the toolbar and Recent projects show the copy by its own name
// after it is opened, its site renamed and closed, while the site's visitor-facing name is copied as it is. Nothing
// made in the copy reaches the original.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, chooseMenu, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('duplicate');
const { app, win, errors } = await launch(WORK);
const sites = join(WORK, 'sites');
await createProject(win, { name: 'Storefront', parentDir: sites, starter: 'blank', sampleImages: false });
const original = join(sites, 'storefront');
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const originalSite = read(original, 'siteorigin/site.json');
const originalManifest = read(original, 'siteorigin.project.json');
const toolbarName = async () => (await win.locator('.toolbar .project-title .site').innerText()).trim();
const dialog = () => win.getByRole('dialog');
const duplicateButton = () => dialog().getByRole('button', { name: 'Duplicate', exact: true });
const pathShown = async () => (await dialog().locator('#duplicate-path').innerText()).replace(/\s+/g, '');

step('a folder by the copy’s name that holds files is explained beside the folder, and nothing is written');
const taken = join(sites, 'fall-campaign');
mkdirSync(taken);
writeFileSync(join(taken, 'notes.txt'), 'mine');
await win.locator('.toolbar .project-title').click();
await win.getByRole('menuitem', { name: 'Duplicate project…' }).click();
await dialog().getByRole('heading', { name: 'Duplicate project' }).waitFor();
const name = dialog().getByRole('textbox', { name: 'Copy name' });
assert.equal(await name.inputValue(), 'Storefront copy', 'the copy is first named after the project');
await name.fill('Fall Campaign');
assert.match(await pathShown(), /\/sites\/fall-campaign$/, 'the folder shown is named after the copy, beside the original');
await duplicateButton().click();
const alert = dialog().getByRole('alert');
await alert.waitFor();
assert.match(await alert.innerText(), /“fall-campaign” is already there/, 'the dialog says why');
assert.equal(await duplicateButton().isDisabled(), true, 'the same folder is not offered again');
assert.deepEqual(readdirSync(taken), ['notes.txt'], 'the folder is left as it was');
assert.equal(await toolbarName(), 'Storefront', 'the original is still open');
await dialog().screenshot({ path: join(SHOTS, 'duplicate-taken.png') });

step('another folder takes the copy, and the original stays open until Open copy');
const campaigns = join(WORK, 'campaigns');
mkdirSync(campaigns);
await answerChoosers(app, [{ dialog: 'open', title: 'Choose where to put the copy', selection: 'folder', paths: [campaigns] }]);
await dialog().getByRole('button', { name: 'Choose…' }).click();
await eventually(async () => assert.match(await pathShown(), /\/campaigns\/fall-campaign$/));
assert.equal(await dialog().getByRole('alert').count(), 0, 'the problem went with the folder');
await duplicateButton().click();
await dialog().getByRole('heading', { name: 'Copy created' }).waitFor({ timeout: 30000 });
const copy = join(campaigns, 'fall-campaign');
const manifest = JSON.parse(read(copy, 'siteorigin.project.json'));
assert.equal(manifest.workingCopyName, 'Fall Campaign', 'the copy keeps its own name');
assert.notEqual(manifest.projectId, JSON.parse(originalManifest).projectId, 'the copy is a project of its own');
assert.equal(JSON.parse(read(copy, 'siteorigin/site.json')).name, 'Storefront', 'visitors still see the site’s name');
assert.match(await dialog().innerText(), /still editing Storefront/, 'the dialog says which project is open');
assert.equal(await toolbarName(), 'Storefront', 'the original is still open');
await dialog().screenshot({ path: join(SHOTS, 'duplicate-done.png') });
await dialog().getByRole('button', { name: 'Open copy' }).click();
await eventually(async () => assert.equal(await toolbarName(), 'Fall Campaign', 'the toolbar shows the copy by its name'), 60000);
assert.equal(await dialog().count(), 0, 'no trust prompt: the copy was trusted when it was made');

step('a change made in the copy lands in the copy, and its name stays through a rename of the site');
const r = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'site.update', name: 'Fall Storefront' }] }, { label: 'Rename site' }));
assert.equal(r.ok, true, 'the rename is made');
await eventually(() => assert.equal(JSON.parse(read(copy, 'siteorigin/site.json')).name, 'Fall Storefront', 'in the copy’s folder'));
assert.equal(await toolbarName(), 'Fall Campaign', 'the toolbar keeps the copy’s own name');
assert.match(await win.locator('.toolbar .project-title .brand').innerText(), /Fall Storefront/, 'beside its site’s name');
const recents = () => win.evaluate(() => window.builder.projects.recents());
assert.equal((await recents()).find((x) => x.dir === copy)?.name, 'Fall Campaign', 'Recent projects keeps it while the copy is open');
assert.equal(read(original, 'siteorigin/site.json'), originalSite, 'the original’s site is untouched');
assert.equal(read(original, 'siteorigin.project.json'), originalManifest, 'and so is its manifest');

step('Recent projects tells the two apart, after closing and after opening the copy again');
await chooseMenu(app, ['File', 'Close Project']);
await win.waitForSelector('.welcome');
const card = (n) => win.locator('.recent-card').filter({ has: win.locator('strong', { hasText: new RegExp(`^${n}$`) }) });
await card('Fall Campaign').waitFor();
await card('Storefront').waitFor();
assert.match(await card('Fall Campaign').locator('.where bdi').innerText(), /\/fall-campaign$/, 'the copy’s card shows its own folder');
assert.match(await card('Storefront').locator('.where bdi').innerText(), /\/storefront$/, 'and the original’s its own');
await win.getByRole('region', { name: 'Recent projects', exact: true }).screenshot({ path: join(SHOTS, 'duplicate-recents.png') });
await card('Fall Campaign').click();
await win.waitForSelector('.editor');
await eventually(async () => assert.equal(await toolbarName(), 'Fall Campaign', 'opened again, it is still the copy'), 60000);

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nduplicate: all checks passed');
