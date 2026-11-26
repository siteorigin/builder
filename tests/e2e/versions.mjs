// Saved versions (#260): an author saves a named version from the project menu, changes the site, reviews what
// restoring the version would change, and restores it. The work it replaced is kept as a version of its own, and the
// notification's Undo takes the restore back in one step. The list survives closing and reopening the project, and
// a version is deleted only after the author confirms.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('versions');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Version Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
const versionNames = async () => (await snapshot()).versions.list.map((v) => [v.name, v.auto]);
const history = win.getByRole('dialog', { name: 'History' });
const projectMenu = async (item) => {
  await win.locator('.project-title').click();
  await win.locator('[role="menu"]').waitFor();
  await win.locator('[role="menu"] [role^="menuitem"]', { hasText: item }).click();
};

step('save a version from the project menu');
const started = Date.now();
await projectMenu('Save version…');
const name = history.getByRole('textbox', { name: 'Version name' });
await name.waitFor();
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Version name', 'the name field has focus'));
await win.keyboard.type('Approved by client');
await win.keyboard.press('Enter');
await eventually(async () => assert.deepEqual(await versionNames(), [['Approved by client', false]]));
const savedAt = Date.parse((await snapshot()).versions.list[0].time);
assert.ok(savedAt >= started - 1000 && savedAt <= Date.now(), 'it records when it was saved');
const row = history.locator('.versions-list li', { hasText: 'Approved by client' });
await row.waitFor();
assert.match(await row.innerText(), /Today, \d{1,2}:\d{2}/, 'the row says when it was saved, the day included');
assert.equal(await name.inputValue(), '', 'the name field is cleared for the next version');

step('change the site, then review what restoring the version changes');
const approved = (await snapshot()).state.site.name;
assert.ok((await apply([{ type: 'site.update', name: 'Redesign' }], 'Rename site')).ok);
assert.ok((await apply([{ type: 'page.create', title: 'Experiments' }], 'Add page')).ok);
await row.getByRole('button', { name: 'Restore “Approved by client”…' }).click();
const review = history.getByTestId('version-review');
await eventually(async () => {
  const text = await review.innerText();
  assert.match(text, /Removes 1 page it doesn’t have: “Experiments”/);
  assert.match(text, /Changes site settings/);
});
assert.equal((await snapshot()).state.site.name, 'Redesign', 'reviewing changes nothing');

step('restore it: the replaced work is kept, and Undo takes the restore back');
await history.getByTestId('restore-version').click();
await history.waitFor({ state: 'detached' });
await eventually(async () => {
  const s = await snapshot();
  assert.equal(s.state.site.name, approved);
  assert.ok(!Object.values(s.state.pages).some((p) => p.title === 'Experiments'), 'the page added since is gone');
});
assert.deepEqual(await versionNames(), [
  ['Before restoring “Approved by client”', true],
  ['Approved by client', false]
]);
const notice = win.locator('.toast', { hasText: 'Restored “Approved by client”' });
await notice.waitFor();
assert.match(await notice.innerText(), /kept in Saved versions/);
await notice.getByRole('button', { name: 'Undo' }).click();
await eventually(async () => {
  const s = await snapshot();
  assert.equal(s.state.site.name, 'Redesign');
  assert.ok(Object.values(s.state.pages).some((p) => p.title === 'Experiments'), 'the page is back');
});

step('the versions are still there after closing and reopening the project');
const { dir, versions: before } = await snapshot();
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.equal(reopened.ok, true, `the project opens: ${reopened.message ?? ''}`);
await win.waitForSelector('.editor');
await eventually(async () => assert.deepEqual((await snapshot()).versions, before, 'the same versions, saved at the same times, holding as much'));

step('delete a version once the author confirms');
await projectMenu('History…');
await history.getByRole('tab', { name: 'Saved versions' }).click();
await history.getByRole('button', { name: 'Delete “Approved by client”' }).click();
const confirm = win.getByRole('dialog', { name: 'Delete saved version?' });
await confirm.getByRole('button', { name: 'Cancel' }).click();
await confirm.waitFor({ state: 'detached' });
assert.equal((await versionNames()).length, 2, 'cancelling keeps it');
await history.getByRole('button', { name: 'Delete “Approved by client”' }).click();
await confirm.getByRole('button', { name: 'Delete version' }).click();
await eventually(async () => assert.deepEqual(await versionNames(), [['Before restoring “Approved by client”', true]]));
await history.locator('.versions-list li', { hasText: 'Approved by client' }).filter({ hasNotText: 'Before restoring' }).waitFor({ state: 'detached' });
assert.ok(await history.isVisible(), 'History stays open after deleting');
assert.match(await win.locator('.toast', { hasText: 'Deleted “Approved by client”' }).innerText(), /Deleted/);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nversions: passed');
