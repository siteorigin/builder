// A browser viewer joining a live session end to end (#1283), against the relay in Cloudflare's local simulator. The
// headless app hosts a session on `relay.localhost`, as local development points it, and a plain headless Chromium
// opens the invite link: the room's preview origin turns it away until it is let in, it asks to join under a name, the
// host admits it as a Viewer from the editor, and the live site loads in the viewer's frame through the room's own
// origin. A heading the host edits reaches the frame without the viewer reloading; a spotlight the viewer points
// shows on the host's canvas, and a note the viewer pins shows in the host's notes. The same browser profile, let in
// to a second room, cannot read either room's preview from the other's origin, nor open one with the other's cookie.
//
// Nothing here needs Cloudflare credentials, a deployed domain or an AI provider, and nothing shows a window.
// Run with the repository's TypeScript loader, which the relay harness needs: node --import tsx tests/e2e/live-viewer.mjs
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';
import { answerPreview, openRoom, startRelay, wait } from '../unit/relay-harness.ts';
import { parseInviteLink, roomPreviewOrigin } from '../../src/shared/live/relay-url.ts';

const { WORK, SHOTS, cleanup } = scratch('live-viewer');
const enc = (text) => new TextEncoder().encode(text);
let relay = null;
let app = null;
let win = null;
let browser = null;
let second = null;
let serving = true;

const share = () => win.locator('.toolbar .share-btn');
const popover = () => win.locator('.share-popover');
const hostState = () => win.evaluate(() => window.builder.live.state());
const roster = async () => (await hostState()).participants ?? [];
const refused = (status) => status === 401 || status === 403;

/** The viewer's preview frame on `previewOrigin`, once it shows a page with a heading. */
async function previewFrame(tab, previewOrigin) {
  for (let i = 0; i < 400; i++) {
    const frame = tab.frames().find((f) => f.url().startsWith(previewOrigin));
    if (frame) {
      const ready = await frame.waitForSelector('h1', { timeout: 2000 }).then(
        () => true,
        () => false
      );
      if (ready) return frame;
    }
    await wait(25);
  }
  throw new Error(`No preview frame on ${previewOrigin}`);
}

/** The first heading the viewer's frame shows, or null while the frame is between pages. */
const frameHeading = async (tab, previewOrigin) => {
  const frame = tab.frames().find((f) => f.url().startsWith(previewOrigin));
  return frame ? frame.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? null).catch(() => null) : null;
};

/** Wait for `check`, asked from here: the viewer's own policy refuses the eval a page-side wait needs. */
async function poll(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(50);
  }
}

/** Ask to join from the viewer's waiting room under `name`. */
async function askToJoin(tab, name) {
  await tab.waitForSelector('#name');
  await tab.fill('#name', name);
  await tab.click('#join-button');
  await tab.waitForSelector('[data-phase="pending"]');
}

/** What a script on `fromOrigin`'s page gets when it asks for `url` with the browser's cookies. */
const readAcross = (frame, url) =>
  frame.evaluate(async (target) => {
    try {
      const response = await fetch(target, { credentials: 'include' });
      return { status: response.status, body: await response.text() };
    } catch (e) {
      return { error: String(e) };
    }
  }, url);

try {
  // Started here, so the relay and the app are let go whatever fails, even while they start.
  const starting = startRelay();
  relay = await withTimeout(starting, 120000, 'The relay simulator').catch(async (e) => {
    const late = await withTimeout(starting, 30000, 'The late relay simulator').catch(() => null);
    await late?.dispose().catch(() => undefined);
    throw e;
  });
  // The viewer's origin and each room's preview origin are the same site only under a host name, never an address.
  const origin = await relay.browserOrigin();
  const launched = await launch(WORK, { SITEORIGIN_LIVE_RELAY_URL: origin });
  ({ app, win } = launched);
  const { errors } = launched;
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  // The headless window is not focused, so the page's clipboard would refuse the copy that starting makes.
  await win.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
  });
  const home = await win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    return { pageId: page.id, heroId: page.rootIds[0] };
  });

  step('the host starts a session on relay.localhost');
  await share().click();
  await popover().waitFor();
  await popover().getByRole('button', { name: 'Start live session' }).click();
  await eventually(async () => assert.match(await share().innerText(), /Live/));
  const invite = await popover().getByLabel('Invite link').inputValue();
  const parsed = parseInviteLink(invite);
  assert.ok(parsed, `the invite link is a room link: ${invite}`);
  assert.equal(parsed.relayUrl, origin, 'the invite link points at the relay under its host name');
  const roomId = parsed.roomId;
  const previewA = await roomPreviewOrigin(origin, roomId);
  await win.keyboard.press('Escape');
  await popover().waitFor({ state: 'detached' });

  step('before admission, the room’s preview origin refuses the browser');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const tab = await context.newPage();
  const pageErrors = [];
  tab.on('pageerror', (e) => pageErrors.push(String(e)));
  await tab.goto(invite);
  assert.equal(await tab.textContent('h1'), 'Join the live session');
  const early = await context.request.get(`${previewA}/`, { failOnStatusCode: false });
  assert.ok(refused(early.status()), `the preview turns away a browser not let in, got ${early.status()}`);
  assert.doesNotMatch(await early.text(), /Harbour Lane/, 'and shows nothing of the site');
  const opened = await (await context.newPage()).goto(`${previewA}/`);
  assert.ok(refused(opened.status()), `opening the preview as a page is turned away too, got ${opened.status()}`);

  step('the browser asks to join under a name, and the host admits it as a viewer');
  await askToJoin(tab, 'Ann Lee');
  assert.equal(await tab.textContent('#screen-title'), 'Waiting for the host');
  await eventually(async () => assert.ok((await roster()).some((p) => p.displayName === 'Ann Lee' && p.status === 'pending'), 'the host hears Ann is waiting'));
  const notice = win.getByRole('region', { name: 'Join requests' });
  await notice.getByText('Ann Lee wants to join').waitFor();
  assert.equal(await tab.locator('iframe').count(), 0, 'nothing of the site shows while waiting');
  await notice.getByRole('group', { name: 'Answer Ann Lee' }).getByRole('button', { name: 'Admit as viewer' }).click();
  await tab.waitForSelector('#connection[data-state="live"]');
  let frame = await previewFrame(tab, previewA);
  assert.equal(await tab.textContent('#role'), 'Viewer');
  assert.equal(await tab.textContent('#site-title'), 'Harbour Lane Studio');
  const ann = (await roster()).find((p) => p.displayName === 'Ann Lee');
  assert.equal(ann?.status, 'admitted');
  assert.equal(ann.role, 'viewer');
  const shownHeading = await frame.textContent('h1');
  assert.ok(shownHeading?.trim(), 'the live site loads with its heading');
  // The preview's cookie is the preview origin's alone.
  const cookiesA = await context.cookies(previewA);
  assert.equal(cookiesA.length, 1);
  assert.equal(cookiesA[0].name, 'so_preview');
  assert.equal(cookiesA[0].domain, new URL(previewA).hostname, 'the cookie is held by the room’s preview host alone');
  assert.deepEqual(await context.cookies(origin), [], 'the viewer’s own origin holds nothing');
  await tab.screenshot({ path: join(SHOTS, 'live-viewer-admitted.png') });

  step('a heading the host edits updates in the browser without a reload');
  let viewerLoads = 0;
  tab.on('framenavigated', (f) => {
    if (f === tab.mainFrame()) viewerLoads++;
  });
  await tab.evaluate(() => (window.__sameViewer = true));
  const heading = 'Rooms that welcome you in';
  const edited = await win.evaluate(([owner, nodeId, value]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner, nodeId, prop: 'heading', value }] }, { label: 'Hero heading' }), [{ kind: 'page', id: home.pageId }, home.heroId, heading]);
  assert.equal(edited.ok, true, edited.error?.message);
  await poll(async () => (await frameHeading(tab, previewA)) === heading, 'the edited heading in the viewer’s frame', 30000);
  assert.equal(viewerLoads, 0, 'the viewer itself was not reloaded');
  assert.equal(await tab.evaluate(() => window.__sameViewer), true, 'the same viewer page is still showing');
  assert.equal(await tab.locator('#connection').getAttribute('data-state'), 'live');
  frame = await previewFrame(tab, previewA);

  step('a spotlight the viewer points shows on the host’s canvas');
  await tab.waitForSelector('#point:not([disabled])');
  await tab.click('#point');
  await frame.waitForSelector('html[data-siteorigin-pointing]', { state: 'attached' });
  await frame.click('h1');
  await win.locator(`.ov-peer.spotlight[data-peer="${ann.guestId}"]`).waitFor({ state: 'attached' });
  await win.locator('.ov-peer-tag.spotlight', { hasText: /^Ann Lee$/ }).waitFor({ state: 'attached' });
  await win.screenshot({ path: join(SHOTS, 'live-viewer-spotlight.png') });

  step('a note the viewer pins shows to the host');
  await tab.click('#notes-button');
  await tab.waitForSelector('#notes:not([hidden])');
  await poll(async () => !!(await tab.textContent('#note-where'))?.trim(), 'the page the note is pinned to');
  const noteText = 'Could the hero photo be brighter?';
  await tab.fill('#note-text', noteText);
  await tab.click('#note-send');
  await poll(async () => (await tab.inputValue('#note-text')) === '', 'the note sent');
  await poll(async () => (await tab.locator('#note-list .note-text', { hasText: noteText }).count()) === 1, 'the note listed in the viewer');
  const notesButton = win.locator('.toolbar .notes-btn');
  await eventually(async () => assert.equal(await notesButton.getAttribute('aria-label'), 'Notes: 1 open', 'the host’s toolbar counts the guest’s note'), 10000);
  await notesButton.click();
  const hostNote = win.locator('.notes-popover .notes-list .notes-row', { hasText: noteText });
  await hostNote.waitFor();
  assert.match(await hostNote.innerText(), /Ann Lee/, 'the host sees who left it');
  await win.screenshot({ path: join(SHOTS, 'live-viewer-note.png') });
  await win.keyboard.press('Escape');

  step('one browser profile let in to two rooms cannot read either room’s preview from the other’s origin');
  // A second room, its host played over the relay's own socket, serving a site of its own.
  second = await openRoom(relay, { projectName: 'Second Room' });
  const previewB = await roomPreviewOrigin(origin, second.roomId);
  const secondSite = '<!doctype html><html><head><title>Second room</title></head><body><h1>Second room only</h1></body></html>';
  void (async () => {
    while (serving) {
      const request = second.host.take('preview:request', () => true);
      if (request) answerPreview(second.host, request.requestId, { body: enc(secondSite) });
      await wait(10);
    }
  })();
  const tabB = await context.newPage();
  await tabB.goto(`${origin}/s/${second.roomId}`);
  await askToJoin(tabB, 'Ann Lee');
  const asked = await second.host.next('room:roster');
  const bGuest = asked.participants.find((p) => p.status === 'pending' && p.displayName === 'Ann Lee');
  assert.ok(bGuest, 'the second room’s host hears of the request');
  second.host.send('host-to-relay', { type: 'guest:admit', guestId: bGuest.guestId, role: 'viewer', guestExpiresAt: null });
  await tabB.waitForSelector('#connection[data-state="live"]');
  const frameB = await previewFrame(tabB, previewB);
  assert.equal(await frameB.textContent('h1'), 'Second room only');
  frame = await previewFrame(tab, previewA);

  // Each room's cookie is its own preview host's, and the two are different.
  const [cookieA] = await context.cookies(previewA);
  const [cookieB] = await context.cookies(previewB);
  assert.ok(cookieA && cookieB, 'the profile holds a preview cookie for each room');
  assert.notEqual(cookieA.domain, cookieB.domain);
  assert.notEqual(cookieA.value, cookieB.value);

  // A script on one room's preview cannot read the other's, either way round.
  const aReadsB = await readAcross(frame, `${previewB}/`);
  assert.ok(aReadsB.error || refused(aReadsB.status), `room A's page cannot read room B's preview: ${JSON.stringify(aReadsB).slice(0, 200)}`);
  assert.doesNotMatch(aReadsB.body ?? '', /Second room only/);
  const bReadsA = await readAcross(frameB, `${previewA}/`);
  assert.ok(bReadsA.error || refused(bReadsA.status), `room B's page cannot read room A's preview: ${JSON.stringify(bReadsA).slice(0, 200)}`);
  assert.doesNotMatch(bReadsA.body ?? '', new RegExp(heading));
  // Nor does either room's cookie open the other's preview, sent there by hand.
  const swappedA = await relay.http(`${previewA}/`, { headers: { cookie: `${cookieB.name}=${cookieB.value}` } });
  assert.ok(refused(swappedA.status), `room B's cookie does not open room A's preview, got ${swappedA.status}`);
  assert.doesNotMatch(await swappedA.text(), new RegExp(heading));
  const swappedB = await relay.http(`${previewB}/`, { headers: { cookie: `${cookieA.name}=${cookieA.value}` } });
  assert.ok(refused(swappedB.status), `room A's cookie does not open room B's preview, got ${swappedB.status}`);
  assert.doesNotMatch(await swappedB.text(), /Second room only/);
  // Each room still shows its own site to its own tab.
  assert.equal(await frameHeading(tab, previewA), heading);
  assert.equal(await frameHeading(tabB, previewB), 'Second room only');

  assert.deepEqual(pageErrors, [], 'no uncaught errors in the viewer');
  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  serving = false;
  second?.host.close();
  await browser?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  await relay?.dispose().catch(() => undefined);
}
// Once the app has let go of its files.
cleanup();
console.log('\nlive-viewer: all checks passed');
