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
import { answerChoosers, choosersShown, createProject, desktopCursor, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('pinned-projects');
const clients = join(WORK, 'clients');
const settingsFile = join(WORK, 'userdata', 'settings.json');

let { app, win, errors } = await launch(WORK);
const allErrors = [];
const pinnedCards = () => win.getByRole('list', { name: 'Pinned projects' }).locator('.recent-card');
const recentCards = () => win.getByRole('list', { name: 'Recent projects' }).locator('.recent-card');
/** The newest project's card, which leads the list on its own, pinned or not. */
const latestCard = () => win.getByRole('list', { name: 'Last opened project' }).locator('.recent-card');
/** The folders of a group's cards, in the order shown. */
const folders = async (cards) => (await cards.evaluateAll((els) => els.map((e) => e.title))).map((t) => t.split('\n')[1]);
const filterInput = () => win.locator('.recent-filter input');
const filterStatus = () => win.locator('.welcome-main p.sr-only[role="status"]');

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
await eventually(async () => assert.equal(await pin.getAttribute('aria-pressed'), 'true'));
// The newest project leads the list on its own, pinned or not, so it is not repeated under Pinned.
assert.deepEqual(await folders(latestCard()), [longstanding]);
assert.equal(await pinnedCards().count(), 0);
await eventually(async () =>
  assert.deepEqual(
    await win.evaluate(() => [document.activeElement?.getAttribute('aria-label'), document.activeElement?.closest('ul')?.getAttribute('aria-label')]),
    ['Pin Longstanding client', 'Last opened project']
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
const seeded = newer.map(([folder, name], i) => ({ dir: site(folder), name, openedAt: new Date(Date.now() - i * 100).toISOString(), projectId: folder }));
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
assert.deepEqual(await folders(pinnedCards()), [longstanding, gone], 'both pinned projects are listed');
assert.deepEqual(await folders(latestCard()), [seeded[0].dir], 'the newest leads');
assert.deepEqual(await folders(recentCards()), seeded.slice(1).map((r) => r.dir), 'the rest of the twenty newer ones follow, newest first');
assert.deepEqual(await folders(win.locator('.recent-card')), [seeded[0].dir, longstanding, gone, ...seeded.slice(1).map((r) => r.dir)], 'then the pinned ones, then the rest');
const brochure = win.getByRole('list', { name: 'Pinned projects' }).locator('.recent-item', { hasText: 'Old brochure site' });
assert.match(await brochure.innerText(), /Folder not found/);
assert.match(await brochure.innerText(), /Find folder…/);
assert.equal(await brochure.getByRole('button', { name: 'Pin Old brochure site' }).getAttribute('aria-pressed'), 'true');
// Its card still finds the folder (#217): the folder picker named for it opens, and cancelling keeps the card pinned.
const findSince = await desktopCursor(app);
const [findAnswer] = await answerChoosers(app, [{ dialog: 'open', title: 'Find Old brochure site', selection: 'folder', cancel: true }]);
await brochure.locator('.recent-card').click();
await eventually(async () =>
  assert.deepEqual(
    (await choosersShown(app, findSince)).map((p) => [p.answer, p.outcome]),
    [[findAnswer, 'cancelled']]
  )
);
await eventually(async () => assert.equal(await brochure.locator('.recent-card').isEnabled(), true));
assert.deepEqual(await folders(pinnedCards()), [longstanding, gone]);

step('the two Mill Roads are told apart by their own folders');
/** What a listed project's card shows of its folder, and what its Pin button is called. */
const cardFacts = (dir) =>
  win.evaluate((dir) => {
    const item = [...document.querySelectorAll('.recent-item')].find((li) => li.querySelector('.recent-card')?.title.endsWith(`\n${dir}`));
    return { shown: item?.querySelector('.where bdi')?.textContent, pin: item?.querySelector('.pin')?.getAttribute('aria-label') };
  }, dir);
const [harbourCard, deliveredCard] = [await cardFacts(millHarbour), await cardFacts(millDelivered)];
assert.match(harbourCard.shown, /harbour/, 'the Harbour card shows its own folder');
assert.doesNotMatch(harbourCard.shown, /delivered/);
assert.match(deliveredCard.shown, /delivered/, 'the delivered card shows its own folder');
assert.doesNotMatch(deliveredCard.shown, /harbour/);
assert.equal(harbourCard.pin, `Pin Mill Road (${millHarbour})`, 'each Mill Road’s Pin names its own folder');
assert.equal(deliveredCard.pin, `Pin Mill Road (${millDelivered})`);

step('one more client is created: the oldest unpinned project rotates off, the pinned ones stay');
const beforeRotation = await folders(recentCards());
await createProject(win, { name: 'Client 21', parentDir: clients, starter: 'blank', sampleImages: false });
await closeProject();
const client21 = realpathSync(join(clients, 'client-21'));
await eventually(async () => assert.deepEqual(await folders(latestCard()), [client21]));
assert.deepEqual(await folders(recentCards()), [seeded[0].dir, ...beforeRotation.slice(0, 18)], 'the oldest unpinned one rotated off');
assert.deepEqual(await folders(pinnedCards()), [longstanding, gone]);
assert.equal(await win.locator('.recent-card').count(), 22, 'twenty-two projects are listed: two pinned and twenty more');

step('Longstanding client is reopened through Open project…: it takes no other client’s place');
const beforeReopen = [...(await folders(latestCard())), ...(await folders(recentCards()))];
const since = await desktopCursor(app);
const [answer] = await answerChoosers(app, [{ dialog: 'open', paths: [process.platform === 'darwin' ? longstanding : join(longstanding, 'siteorigin.project.json')] }]);
await win.locator('.welcome-action', { hasText: 'Open project…' }).click();
await win.waitForSelector('.editor');
const pickers = await choosersShown(app, since);
assert.deepEqual(
  pickers.map((p) => [p.answer, p.outcome]),
  [[answer, 'chosen']],
  'the native picker chose it'
);
assert.equal(await win.evaluate(() => window.builder.project.snapshot().then((s) => s?.dir ?? null)), longstanding);
await closeProject();
await eventually(async () => assert.deepEqual(await folders(latestCard()), [longstanding]));
assert.deepEqual(await folders(pinnedCards()), [gone], 'the other pinned project keeps its place');
assert.deepEqual(await folders(recentCards()), beforeReopen, 'every other client is still listed, in the same order');
assert.equal(await win.locator('.recent-item.latest .recent-card').getAttribute('title'), `Longstanding client\n${longstanding}`, 'it is the project to come back to');

step('the filter finds projects by name or folder in both groups');
await filterInput().fill('longstanding');
await eventually(async () => assert.deepEqual(await folders(win.locator('.recent-card')), [longstanding]));
await eventually(async () => assert.equal(await filterStatus().innerText(), '1 project matches. Enter opens Longstanding client.'));
await filterInput().fill('mill road');
await eventually(async () => assert.deepEqual((await folders(win.locator('.recent-card'))).sort(), [millDelivered, millHarbour].sort()));
await filterInput().fill('harbour');
await eventually(async () => assert.deepEqual(await folders(win.locator('.recent-card')), [millHarbour]));
await filterInput().fill('archive');
await eventually(async () => assert.deepEqual(await folders(pinnedCards()), [gone]));
assert.equal(await win.getByRole('list', { name: 'Recent projects' }).count(), 0, 'no unpinned project matches');
await filterInput().fill('client');
await eventually(async () => assert.ok((await folders(pinnedCards())).includes(longstanding), 'a pinned client matches'));
assert.ok((await folders(recentCards())).includes(client21), 'and so do the other clients');
await filterInput().press('Escape');
await eventually(async () => assert.equal(await win.locator('.recent-card').count(), 22));
await eventually(async () => assert.equal(await filterStatus().innerText(), 'Showing all 22 projects'));

step('unpinned, Longstanding client goes back among the rest, newest first');
await win.getByRole('button', { name: 'Pin Longstanding client' }).click();
await eventually(async () => assert.equal(await win.getByRole('button', { name: 'Pin Longstanding client' }).getAttribute('aria-pressed'), 'false'));
assert.deepEqual(await folders(latestCard()), [longstanding], 'unpinned, it still leads as the newest');
assert.deepEqual(await folders(pinnedCards()), [gone]);
assert.deepEqual(await folders(recentCards()), beforeReopen);
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

step('with the last pin gone, the other cards stay where they are, and so does focus');
const kept = await recentCards().first().elementHandle();
await win.getByRole('button', { name: 'Pin Old brochure site' }).click();
await eventually(async () => assert.equal(await win.getByRole('list', { name: 'Pinned projects' }).count(), 0));
assert.equal(await kept.evaluate((e) => e.isConnected), true, 'the other cards are not drawn anew');
assert.equal(await win.locator('.recent-group-title').count(), 0, 'one list needs no titles');
assert.equal(await win.locator('.recent-card').count(), 22);
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Pin Old brochure site'));

allErrors.push(...errors);
await app.close();
assert.deepEqual(allErrors, [], 'no page errors');
cleanup();
console.log('\npinned-projects: OK');
