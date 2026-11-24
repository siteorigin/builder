// A moved project found from its missing Recent projects card (#217). Mill Road is closed, its folder moved to
// delivered work, and the app started again: its card says the folder is not found, shows the old path, and offers
// Find folder… beside its own Remove. Cancelling the picker, choosing another project called Mill Road in a folder of
// the same name, or cancelling the trust prompt keeps the card. Opened through Open project, the moved folder is
// listed beside the missing card (the report); Find folder… on that card, choosing it, leaves Mill Road listed once.
// Moved again, it is found through the trust prompt. Each time the list is the same after a restart, and Remove still
// takes a missing card off on its own. The app's chooser fixtures answer the pickers, so nothing appears on screen.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, choosersShown, createProject, desktopCursor, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('find-moved-project');
const clients = join(WORK, 'clients');
const another = join(WORK, 'another-client');
const delivered = join(WORK, 'delivered');

let { app, win, errors } = await launch(WORK);
const allErrors = [];
const recents = () => win.evaluate(() => window.builder.projects.recents());
const openDir = () => win.evaluate(() => window.builder.project.snapshot().then((s) => s?.dir ?? null));
/** Recent projects under this run's folder, as [folder, missing], newest first. */
const listed = async () => (await recents()).filter((r) => r.dir.startsWith(realpathSync(WORK))).map((r) => [r.dir, !!r.missing]);
const missingCard = () => win.locator('.recent-item.missing');
const trustPrompt = () => win.getByRole('dialog', { name: 'Trust this project?' });

async function closeProject() {
  const closed = await win.evaluate(() => window.builder.projects.close());
  assert.equal(closed.ok, true, 'the project closes');
  await win.waitForSelector('.welcome');
  await win.locator('.recent-card').first().waitFor();
}

async function restart() {
  allErrors.push(...errors);
  await app.close();
  ({ app, win, errors } = await launch(WORK));
  await win.waitForSelector('.welcome');
  await win.locator('.recent-card').first().waitFor();
}

/** Open project…, the picker choosing the project in `dir` (macOS's picker takes the folder, the others its manifest). */
async function openProjectButton(dir) {
  await answerChoosers(app, [{ dialog: 'open', paths: [process.platform === 'darwin' ? dir : join(dir, 'siteorigin.project.json')] }]);
  await win.locator('.welcome-action', { hasText: 'Open project…' }).click();
}

/**
 * Find folder… on the missing card, the picker answering with `answer` ({ paths } or { cancel: true }). The answer is
 * only taken by a folder picker that names the project, so a picker of any other kind is refused and fails the step.
 */
async function findFolder(answer) {
  const since = await desktopCursor(app);
  const [id] = await answerChoosers(app, [{ dialog: 'open', title: 'Find Mill Road', selection: 'folder', ...answer }]);
  await missingCard().locator('.recent-card').click();
  await eventually(async () => {
    const shown = await choosersShown(app, since);
    assert.equal(shown.length, 1, 'one picker is shown');
    assert.equal(shown[0].answer, id, 'it took the answer meant for it');
    assert.equal(shown[0].outcome, answer.cancel ? 'cancelled' : 'chosen');
  });
}

step('Mill Road, and another site called Mill Road for another client, which is then taken off the list');
await createProject(win, { name: 'Mill Road', parentDir: clients, starter: 'blank', sampleImages: false });
await closeProject();
await createProject(win, { name: 'Mill Road', parentDir: another, starter: 'blank', sampleImages: false });
await closeProject();
const old = realpathSync(join(clients, 'mill-road'));
const other = realpathSync(join(another, 'mill-road'));
await win.locator('.recent-card').first().waitFor();
assert.equal(await win.locator('.recent-card').first().getAttribute('title'), `Mill Road\n${other}`);
await win.locator('.recent-item').first().locator('.icon-btn.remove').click();
await eventually(async () => assert.deepEqual(await listed(), [[old, false]]));

step('Mill Road is moved to delivered work while the app is closed');
allErrors.push(...errors);
await app.close();
mkdirSync(delivered);
const moved = join(realpathSync(delivered), 'mill-road');
renameSync(old, moved);
({ app, win, errors } = await launch(WORK));
await win.waitForSelector('.welcome');
await missingCard().waitFor();
assert.deepEqual(await listed(), [[old, true]]);
const card = missingCard();
assert.match(await card.innerText(), /Folder not found/);
assert.match(await card.innerText(), /Find folder…/);
assert.equal(await card.locator('.recent-card').getAttribute('title'), `Mill Road\n${old}`, 'the card names its old folder');
assert.match(await card.locator('.where .sr-only').innerText(), /clients/, 'the old place is said, so two Mill Roads can be told apart');
const remove = card.getByRole('button', { name: /^Remove Mill Road.* from recent projects$/ });
assert.equal(await remove.isEnabled(), true, 'Remove stays available beside Find folder…');

step('cancelling the picker keeps the card');
await findFolder({ cancel: true });
await eventually(async () => assert.equal(await card.locator('.recent-card').isEnabled(), true));
assert.deepEqual(await listed(), [[old, true]]);

step('the other Mill Road, in a folder of the same name, opens but does not replace the card');
await findFolder({ paths: [other] });
await win.waitForSelector('.editor');
assert.equal(await openDir(), other);
await closeProject();
assert.deepEqual(await listed(), [
  [other, false],
  [old, true]
]);

step('the moved folder asks for trust; Cancel keeps the card');
await findFolder({ paths: [moved] });
await trustPrompt().waitFor();
assert.match(await trustPrompt().innerText(), /Mill Road/);
await trustPrompt().getByRole('button', { name: 'Cancel' }).click();
await trustPrompt().waitFor({ state: 'detached' });
assert.equal(await win.locator('.welcome').count(), 1, 'Welcome is still shown');
assert.deepEqual(await listed(), [
  [other, false],
  [old, true]
]);

step('the report: Open project on the moved folder lists it beside the missing card');
await openProjectButton(moved);
await trustPrompt().getByRole('button', { name: 'Trust and open' }).click();
await win.waitForSelector('.editor');
assert.equal(await openDir(), moved);
await closeProject();
assert.deepEqual(await listed(), [
  [moved, false],
  [other, false],
  [old, true]
]);

step('Find folder… on the missing card, choosing the moved folder, leaves Mill Road listed once');
await findFolder({ paths: [moved] });
await win.waitForSelector('.editor');
assert.equal(await openDir(), moved);
await closeProject();
await eventually(async () =>
  assert.deepEqual(await listed(), [
    [moved, false],
    [other, false]
  ])
);
assert.equal(await missingCard().count(), 0, 'no card says its folder is not found');
await restart();
assert.deepEqual(await listed(), [
  [moved, false],
  [other, false]
]);

step('moved again, Mill Road is found through the trust prompt');
allErrors.push(...errors);
await app.close();
const archive = join(WORK, 'archive');
mkdirSync(archive);
const archived = join(realpathSync(archive), 'mill-road');
renameSync(moved, archived);
({ app, win, errors } = await launch(WORK));
await win.waitForSelector('.welcome');
await missingCard().waitFor();
assert.deepEqual(await listed(), [
  [moved, true],
  [other, false]
]);
await findFolder({ paths: [archived] });
await trustPrompt().getByRole('button', { name: 'Trust and open' }).click();
await win.waitForSelector('.editor');
assert.equal(await openDir(), archived);
await closeProject();
await eventually(async () =>
  assert.deepEqual(await listed(), [
    [archived, false],
    [other, false]
  ])
);

step('after a restart the list is the same; the other Mill Road, gone meanwhile, is taken off it with Remove');
rmSync(other, { recursive: true });
await restart();
assert.deepEqual(await listed(), [
  [archived, false],
  [other, true]
]);
assert.equal(await win.locator('.recent-card').first().getAttribute('title'), `Mill Road\n${archived}`);
assert.equal(await missingCard().locator('.recent-card').getAttribute('title'), `Mill Road\n${other}`);
await missingCard().getByRole('button', { name: /^Remove Mill Road.* from recent projects$/ }).click();
await eventually(async () => assert.deepEqual(await listed(), [[archived, false]]));
assert.equal(await missingCard().count(), 0, 'no card says its folder is not found');

allErrors.push(...errors);
await app.close();
assert.deepEqual(allErrors, [], 'no page errors');
cleanup();
console.log('\nfind-moved-project: OK');
