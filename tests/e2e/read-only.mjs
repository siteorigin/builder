// Read-only opens in the built app (spec 16.6, 18.1) leave the whole project folder byte-identical, node_modules
// included: a project another app is editing previews from a private copy, a project from a newer version shows no
// preview at all, and Unlock is the only path that changes the folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('read-only');
const staging = join(WORK, 'userdata', 'preview-staging');
const stages = () => (existsSync(staging) ? readdirSync(staging) : []);

/** Everything in the folder: paths, kinds, sizes, modification times, content hashes and link targets. */
function snapshotTree(root) {
  const out = { '.': { kind: 'dir', mtimeMs: lstatSync(root).mtimeMs } };
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) out[rel] = { kind: 'link', mtimeMs: st.mtimeMs, link: readlinkSync(p) };
      else if (st.isDirectory()) {
        out[rel] = { kind: 'dir', mtimeMs: st.mtimeMs };
        walk(p);
      } else out[rel] = { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash: createHash('sha256').update(readFileSync(p)).digest('hex') };
    }
  };
  walk(root);
  return out;
}

/** Name the first few differences, so a failure says what was written. */
function assertSameTree(after, before, what) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const diff = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  assert.deepEqual(diff.slice(0, 10), [], `${what}: the project folder is unchanged`);
}

/** Another SiteOrigin Builder holds the project: a fresh lock from a live process on this computer. */
const lockByAnother = (dir) =>
  writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));

const { app, win, errors } = await launch(WORK);

step('create a project and run its preview once, so its website tools are in place');
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = (await win.evaluate(() => window.builder.project.snapshot())).dir;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
assert.ok(existsSync(join(dir, 'node_modules')), 'the project has its website tools');

async function openReadOnly(canUnlock) {
  const r = await win.evaluate((d) => window.builder.projects.open(d), dir);
  assert.equal(r.ok, true, `the project opens (${r.message ?? ''})`);
  await win.waitForSelector('.editor');
  const snap = await win.evaluate(() => window.builder.project.snapshot());
  assert.equal(snap.readOnly?.canUnlock, canUnlock, 'the project is open read-only for the expected reason');
}

async function closeProject() {
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
}

async function waitForPreview() {
  const frame = win.frameLocator('.frame-box iframe');
  await frame.locator('h1').first().waitFor({ timeout: 120000 });
  // The editor's own instrumentation reached the copy: selection works on the read-only page.
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  await frame.locator('[data-so-node]').first().waitFor({ state: 'attached', timeout: 30000 });
  return frame;
}

step('a project another app is editing renders from a private copy');
lockByAnother(dir);
let before = snapshotTree(dir);
let t0 = Date.now();
await openReadOnly(true);
const frame = await waitForPreview();
console.log('read-only preview ready in', Date.now() - t0, 'ms');
assert.match(await frame.locator('h1').first().innerText(), /\S/, 'the page has its heading');
assert.equal(stages().length, 1, 'the preview runs from one private copy');

step('exports and Duplicate are refused');
for (const [what, call, dest] of [
  ['static export', (d) => window.builderTest.exportStatic(d), join(WORK, 'export-site')],
  ['source export', (d) => window.builderTest.exportSource(d), join(WORK, 'export-source')]
]) {
  const r = await withTimeout(win.evaluate(call, dest), 60000, what);
  assert.equal(r.ok, false, `${what} is refused`);
  assert.equal(existsSync(dest), false, `${what} writes nothing`);
}
await app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
}, join(dir, 'copy'));
const dup = await win.evaluate(() => window.builder.projects.duplicate());
assert.equal(dup.ok, false, 'Duplicate into the project is refused');

step('closing removes the copy and leaves the folder byte-identical');
await closeProject();
await eventually(() => assert.deepEqual(stages(), [], 'the private copy is removed'));
assertSameTree(snapshotTree(dir), before, 'after a locked preview');

step('a project from a newer version shows no preview and nothing to retry');
rmSync(join(dir, '.siteorigin/lock.json'));
const manifestPath = join(dir, 'siteorigin.project.json');
const manifestText = readFileSync(manifestPath, 'utf8');
writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifestText), schemaVersion: JSON.parse(manifestText).schemaVersion + 1 }, null, 2));
before = snapshotTree(dir);
await openReadOnly(false);
await win.getByRole('heading', { name: 'Preview unavailable' }).waitFor({ timeout: 30000 });
await win.waitForTimeout(3000);
assert.equal(await win.getByRole('button', { name: /Try again|Start preview/ }).count(), 0, 'there is nothing to retry');
assert.equal(await win.locator('.frame-box iframe').count(), 0, 'no preview frame');
assert.equal((await win.evaluate(() => window.builder.project.snapshot())).runtime.state, 'unavailable');
assert.deepEqual(stages(), [], 'no copy is made');
await win.evaluate(() => window.builder.project.retryPreview());
assert.equal((await win.evaluate(() => window.builder.project.snapshot())).runtime.state, 'unavailable', 'retrying changes nothing');
await closeProject();
assertSameTree(snapshotTree(dir), before, 'after a newer-format open');
writeFileSync(manifestPath, manifestText);

step('Unlock is the one path that changes the folder');
lockByAnother(dir);
before = snapshotTree(dir);
await openReadOnly(true);
const lockedFrame = await waitForPreview();
assertSameTree(snapshotTree(dir), before, 'while open read-only');

step('the copy follows what the other app writes');
const pagePath = join(dir, 'src/routes/+page.svelte');
const pageText = readFileSync(pagePath, 'utf8');
writeFileSync(pagePath, `${pageText}\n<p id="other-app-edit">Written by the other app</p>\n`);
await lockedFrame.locator('#other-app-edit').waitFor({ timeout: 30000 });
writeFileSync(pagePath, pageText);
await lockedFrame.locator('#other-app-edit').waitFor({ state: 'detached', timeout: 30000 });
assert.equal(stages().length, 1, 'still one private copy');

const unlocked = await win.evaluate(() => window.builder.project.unlock());
assert.equal(unlocked.ok, true, 'Unlock reopens the project for editing');
await win.waitForSelector('.editor');
await eventually(async () => assert.equal((await win.evaluate(() => window.builder.project.snapshot()))?.readOnly ?? null, null, 'the project is editable'));
assert.notEqual(JSON.parse(readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8')).instance, 'another-window', 'this app holds the lock now');
await eventually(() => assert.deepEqual(stages(), [], 'the private copy is removed once the project is editable'));
await waitForPreview();
const renamed = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'site.update', name: 'Harbour Lane Studio (unlocked)' }] }, { label: 'Rename' }));
assert.equal(renamed.ok, true, 'an edit is saved');
assert.match(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'), /unlocked/, 'the edit is written to the project');

step('a static export builds with its own copy of the website tools');
const nodeModules = snapshotTree(join(dir, 'node_modules'));
const exported = await withTimeout(win.evaluate((d) => window.builderTest.exportStatic(d), join(WORK, 'export-site')), 300000, 'Static export');
assert.equal(exported.ok, true, `the static export succeeds (${exported.message})`);
assert.ok(existsSync(join(WORK, 'export-site', 'index.html')), 'the export has its home page');
assertSameTree(snapshotTree(join(dir, 'node_modules')), nodeModules, 'node_modules after a static export');
await closeProject();

step('quitting during a read-only preview removes the copy');
lockByAnother(dir);
before = snapshotTree(dir);
await openReadOnly(true);
await waitForPreview();
assert.equal(stages().length, 1);
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
const closed = app.waitForEvent('close');
await app.evaluate(({ app }) => app.quit());
await withTimeout(closed, 30000, 'Quitting');
assert.deepEqual(stages(), [], 'the private copy is removed on quit');
assertSameTree(snapshotTree(dir), before, 'after quitting');

cleanup();
console.log('\nread-only: passed');
