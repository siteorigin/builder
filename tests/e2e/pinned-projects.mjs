// Recurring client projects kept on Welcome (#259). Longstanding client is created, closed and pinned from its card.
// Twenty newer client sites are listed while the app is closed (two of them called Mill Road, in different folders,
// and a pinned older project whose folder has gone), and one more is created: the twenty newest unpinned projects
// rotate as before, while both pinned projects stay above them, the missing one still saying so. Reopening the pinned
// client through Open project… (the native picker, answered by the app's chooser fixtures) brings it to the top
// without taking any other client off the list. The filter finds projects by name or folder across both groups, and
// tells the two Mill Roads apart by their own folders. Unpinned, the client goes back among the rest.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('pinned-projects');
const clients = join(WORK, 'clients');
const settingsFile = join(WORK, 'userdata', 'settings.json');

let { app, win, errors } = await launch(WORK);
const allErrors = [];
const pinnedCards = () => win.getByRole('list', { name: 'Pinned projects' }).locator('.recent-card');
const recentCards = () => win.getByRole('list', { name: 'Recent projects' }).locator('.recent-card');
/** The folders of a group's cards, in the order shown. */
const folders = async (cards) => (await cards.evaluateAll((els) => els.map((e) => e.title))).map((t) => t.split('\n')[1]);
const filterInput = () => win.locator('.recent-filter input');

async function closeProject() {
  const closed = await win.evaluate(() => window.builder.projects.close());
  assert.equal(closed.ok, true, 'the project closes');
  await win.waitForSelector('.welcome');
  await win.locator('.recent-card').first().waitFor();
}

async function launchAgain() {
  ({ app, win, errors } = await launch(WORK));
  await win.waitForSelector('.welcome');
  await win.locator('.recent-card').first().waitFor();
}

step('Longstanding client is created, closed, and pinned from its card; focus follows its Pin button');
await createProject(win, { name: 'Longstanding client', parentDir: clients, starter: 'blank', sampleImages: false });
await closeProject();
const longstanding = realpathSync(join(clients, 'longstanding-client'));
assert.equal(await pinnedCards().count(), 0, 'nothing is pinned yet');
const pin = win.getByRole('button', { name: 'Pin Longstanding client' });
assert.equal(await pin.getAttribute('aria-pressed'), 'false');
await pin.click();
await eventually(async () => assert.deepEqual(await folders(pinnedCards()), [longstanding]));
await eventually(async () => assert.equal(await pin.getAttribute('aria-pressed'), 'true'));
await eventually(async () =>
  assert.deepEqual(
    await win.evaluate(() => [document.activeElement?.getAttribute('aria-label'), document.activeElement?.closest('ul')?.getAttribute('aria-label')]),
    ['Pin Longstanding client', 'Pinned projects']
  )
);
allErrors.push(...errors);
await app.close();

step('twenty newer client sites are listed while the app is closed, with a pinned older one whose folder has gone');
const site = (folder) => {
  const dir = join(realpathSync(WORK), 'sites', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
  return dir;
};
// Newest first, as the list keeps them: Client 18 down to Client 1, with the two Mill Roads among them.
const newer = Array.from({ length: 18 }, (_, i) => [`client-${18 - i}`, `Client ${18 - i}`]);
newer.splice(4, 0, ['harbour/mill-road', 'Mill Road']);
newer.splice(9, 0, ['delivered/mill-road', 'Mill Road']);
const seeded = newer.map(([folder, name], i) => ({ dir: site(folder), name, openedAt: new Date(Date.now() - i * 1000).toISOString(), projectId: folder }));
const [millHarbour, millDelivered] = [seeded[4].dir, seeded[9].dir];
const gone = join(realpathSync(WORK), 'archive', 'old-brochure-site');
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const file = JSON.parse(readFileSync(settingsFile, 'utf8'));
assert.deepEqual(
  file.recents.map((r) => [r.dir, r.pinned]),
  [[longstanding, true]],
  'the pin is saved'
);
file.recents = [...seeded, ...file.recents, { dir: gone, name: 'Old brochure site', openedAt: minutesAgo(60 * 24 * 90), projectId: 'brochure', pinned: true }];
writeFileSync(settingsFile, JSON.stringify(file, null, 2));
await launchAgain();
assert.deepEqual(await folders(pinnedCards()), [longstanding, gone], 'both pinned projects are listed above the rest');
assert.equal(await recentCards().count(), 20);
const brochure = win.getByRole('list', { name: 'Pinned projects' }).locator('.recent-item', { hasText: 'Old brochure site' });
assert.match(await brochure.innerText(), /Folder not found/);
assert.match(await brochure.innerText(), /Find folder…/);
assert.equal(await brochure.getByRole('button', { name: 'Pin Old brochure site' }).getAttribute('aria-pressed'), 'true');

step('the two Mill Roads are told apart by their own folders');
const mills = recentCards().filter({ hasText: 'Mill Road' });
assert.deepEqual((await folders(mills)).sort(), [millDelivered, millHarbour].sort());
const shownPaths = await win.getByRole('list', { name: 'Recent projects' }).locator('.recent-item', { hasText: 'Mill Road' }).locator('.where bdi').allInnerTexts();
assert.equal(shownPaths.length, 2);
assert.notEqual(shownPaths[0], shownPaths[1], 'each card shows a different folder');
assert.match(shownPaths.join('\n'), /harbour/);
assert.match(shownPaths.join('\n'), /delivered/);
assert.equal(await win.getByRole('button', { name: /^Pin Mill Road \(.+\)$/ }).count(), 2, 'each Mill Road’s Pin names its folder');

step('one more client is created: the oldest unpinned project rotates off, the pinned ones stay');
const beforeRotation = await folders(recentCards());
await createProject(win, { name: 'Client 21', parentDir: clients, starter: 'blank', sampleImages: false });
await closeProject();
const client21 = realpathSync(join(clients, 'client-21'));
await eventually(async () => assert.deepEqual(await folders(recentCards()), [client21, ...beforeRotation.slice(0, 19)]));
assert.deepEqual(await folders(pinnedCards()), [longstanding, gone]);
assert.equal(await win.locator('.recent-card').count(), 22, 'twenty-two projects are listed: two pinned and twenty more');

step('Longstanding client is reopened through Open project…: it takes no other client’s place');
const beforeReopen = await folders(recentCards());
await answerChoosers(app, [{ dialog: 'open', paths: [process.platform === 'darwin' ? longstanding : join(longstanding, 'siteorigin.project.json')] }]);
await win.locator('.welcome-action', { hasText: 'Open project…' }).click();
await win.waitForSelector('.editor');
assert.equal(await win.evaluate(() => window.builder.project.snapshot().then((s) => s?.dir ?? null)), longstanding);
await closeProject();
await eventually(async () => assert.deepEqual(await folders(pinnedCards()), [longstanding, gone]));
assert.deepEqual(await folders(recentCards()), beforeReopen, 'every other client is still listed, in the same order');
assert.equal(await win.locator('.recent-item.latest .recent-card').getAttribute('title'), `Longstanding client\n${longstanding}`, 'it is the project to come back to');

step('the filter finds projects by name or folder in both groups');
await filterInput().fill('longstanding');
await eventually(async () => assert.deepEqual(await folders(win.locator('.recent-card')), [longstanding]));
await filterInput().fill('mill road');
await eventually(async () => assert.deepEqual((await folders(win.locator('.recent-card'))).sort(), [millDelivered, millHarbour].sort()));
await filterInput().fill('harbour');
await eventually(async () => assert.deepEqual(await folders(win.locator('.recent-card')), [millHarbour]));
await filterInput().fill('archive');
await eventually(async () => assert.deepEqual(await folders(pinnedCards()), [gone]));
assert.equal(await win.getByRole('list', { name: 'Recent projects' }).count(), 0, 'no unpinned project matches');
await filterInput().press('Escape');
await eventually(async () => assert.equal(await win.locator('.recent-card').count(), 22));

step('unpinned, Longstanding client goes back among the rest, newest first');
await win.getByRole('button', { name: 'Pin Longstanding client' }).click();
await eventually(async () => assert.deepEqual(await folders(pinnedCards()), [gone]));
assert.deepEqual(await folders(recentCards()), [longstanding, ...beforeReopen]);
await eventually(async () =>
  assert.deepEqual(
    await win.evaluate(() => [document.activeElement?.getAttribute('aria-label'), document.activeElement?.getAttribute('aria-pressed')]),
    ['Pin Longstanding client', 'false']
  )
);
const saved = JSON.parse(readFileSync(settingsFile, 'utf8')).recents;
assert.deepEqual(
  saved.filter((r) => r.pinned).map((r) => r.dir),
  [gone]
);

allErrors.push(...errors);
await app.close();
assert.deepEqual(allErrors, [], 'no page errors');
cleanup();
console.log('\npinned-projects: OK');
