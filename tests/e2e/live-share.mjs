// Hosting a live session from the toolbar (#764), against the relay in Cloudflare's local simulator: Share starts a
// session and copies its invite link, the waiting room admits and declines guests, and the roster changes roles,
// sets a guest's own end of access, removes guests, locks and extends the room and ends it. Guests are played over
// the relay's own sockets, as browsers would join, and each change is checked on their side as well as the host's.
// Closing the project ends the session for everyone and leaves Share as it was.
//
// Run with the repository's TypeScript loader, which the relay harness needs: node --import tsx tests/e2e/live-share.mjs
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';
import { joinGuest, redeemTicket, startRelay } from '../unit/relay-harness.ts';
import { parseInviteLink } from '../../src/shared/live/relay-url.ts';

const { WORK, SHOTS, cleanup } = scratch('live-share');
const guests = [];
let relay = null;
let app = null;
let win = null;

const share = () => win.locator('.toolbar .share-btn');
const popover = () => win.locator('.share-popover');
const openShare = async () => {
  if ((await share().getAttribute('aria-expanded')) !== 'true') await share().click();
  await popover().waitFor();
  return popover();
};
const closeShare = async () => {
  if ((await share().getAttribute('aria-expanded')) !== 'true') return;
  await win.keyboard.press('Escape');
  await popover().waitFor({ state: 'detached' });
};
const hostState = () => win.evaluate(() => window.builder.live.state());
const roster = async () => (await hostState()).participants ?? [];
/** The next guest:status of `status` a guest hears, past any other status it was sent meanwhile (a room change resends admitted). */
const statusOf = async (guest, status, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const frame = await guest.next('guest:status', Math.max(1, end - Date.now()));
    if (frame.status === status) return frame;
  }
};
/** A guest asks to join and waits; the host's editor hears of it. */
const asks = async (roomId, name) => {
  const joined = await joinGuest(relay, roomId, name);
  guests.push(joined.guest);
  await eventually(async () => assert.ok((await roster()).some((p) => p.guestId === joined.guestId && p.status === 'pending'), `${name} is waiting`));
  return joined;
};

try {
  // Started here, so the relay and the app are let go whatever fails, even while they start.
  const starting = startRelay();
  relay = await withTimeout(starting, 120000, 'The relay simulator').catch(async (e) => {
    // One that comes up late is let go before the script ends, never left running.
    const late = await withTimeout(starting, 30000, 'The late relay simulator').catch(() => null);
    await late?.dispose().catch(() => undefined);
    throw e;
  });
  const origin = await relay.origin();
  const launched = await launch(WORK, { SITEORIGIN_LIVE_RELAY_URL: origin });
  ({ app, win } = launched);
  const { errors } = launched;
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  // The headless window is not focused, so the page's clipboard would refuse; record what is copied instead.
  await win.evaluate(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => void window.__copied.push(t) } });
  });

  step('Share starts a live session and copies its invite link');
  assert.equal(await share().getAttribute('aria-label'), 'Share: start a live session');
  assert.equal(await share().getAttribute('aria-haspopup'), 'dialog');
  let dialog = await openShare();
  assert.equal(await dialog.getAttribute('role'), 'dialog');
  assert.equal(await win.getByRole('dialog', { name: 'Share a live session' }).count(), 1, 'the popover is named');
  assert.equal(await share().getAttribute('aria-controls'), await dialog.getAttribute('id'));
  // Focus starts in the popover, which is not modal: the toolbar stays reachable.
  assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)), 'focus moves into the popover');
  const lengths = dialog.getByRole('radiogroup', { name: 'Session length' });
  assert.deepEqual(await lengths.getByRole('radio').allInnerTexts(), ['30 minutes', '2 hours', '8 hours', 'Until project closes']);
  await lengths.getByRole('radio', { name: '30 minutes' }).click();
  await dialog.getByRole('button', { name: 'Start live session' }).click();
  await eventually(async () => assert.match(await share().innerText(), /Live · 30m/));
  const invite = await dialog.getByLabel('Invite link').inputValue();
  const parsed = parseInviteLink(invite);
  assert.ok(parsed, `the invite link is a room link: ${invite}`);
  assert.equal(parsed.relayUrl, origin, 'the invite link points at the configured relay');
  // The link is copied once the start has answered, which may be a moment after the pill shows the session.
  await eventually(async () => assert.deepEqual(await win.evaluate(() => window.__copied), [invite], 'starting copied the invite link'), 3000);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await eventually(async () => assert.deepEqual(await win.evaluate(() => window.__copied), [invite, invite]), 3000);
  await win.getByText('Invite link copied', { exact: true }).waitFor();
  const roomId = parsed.roomId;
  assert.match(await share().getAttribute('aria-label'), /^Share: live session, 0 guests, 30 minutes left$/);

  step('a guest waiting is announced, and admitted from the notice');
  await closeShare();
  await eventually(async () => assert.ok(await share().evaluate((el) => el === document.activeElement), 'Escape hands focus back to Share'), 3000);
  const ann = await asks(roomId, 'Ann');
  const notice = win.getByRole('region', { name: 'Join requests' });
  await notice.getByText('Ann wants to join').waitFor();
  await eventually(async () => assert.equal(await win.locator('.toolbar [role="status"][aria-live="polite"]').last().innerText(), 'Ann wants to join the live session'));
  assert.equal(await share().locator('.share-badge').innerText(), '1');
  assert.match(await share().getAttribute('aria-label'), /^Share: live session, 0 guests, 1 waiting to join, \d+ minutes left$/);
  await win.screenshot({ path: join(SHOTS, 'live-share-waiting.png') });
  await notice.getByRole('group', { name: 'Answer Ann' }).getByRole('button', { name: 'Admit as Collaborator' }).click();
  const annIn = await ann.guest.next('guest:status');
  assert.equal(annIn.status, 'admitted');
  assert.equal(annIn.role, 'collaborator');
  assert.equal((await redeemTicket(relay, roomId, annIn.previewTicket)).status, 204, 'the admitted guest can open the preview');
  await notice.waitFor({ state: 'detached' });
  await eventually(async () => assert.match(await share().getAttribute('aria-label'), /^Share: live session, 1 guest, \d+ minutes left$/));

  step('guests follow the host’s page and width');
  const follows = await ann.guest.next('presence:changed');
  assert.deepEqual(follows.participant, { kind: 'host' });
  assert.equal(follows.presence.previewPath, '/');
  assert.equal(follows.presence.viewportWidth, 1280);
  ann.guest.discard('presence:changed');
  await win.getByRole('button', { name: 'Phone' }).click();
  await eventually(async () => assert.ok(ann.guest.take('presence:changed', (f) => f.participant.kind === 'host' && f.presence.viewportWidth === 390 && f.presence.previewPath === '/'), 'the new width reaches the guest'));
  const about = Object.values((await win.evaluate(() => window.builder.project.snapshot())).state.pages).find((p) => p.route === '/about/');
  await win.locator('.pages-panel').getByText('About', { exact: true }).first().click();
  await eventually(async () => assert.ok(ann.guest.take('presence:changed', (f) => f.participant.kind === 'host' && f.presence.pageId === about.id && f.presence.previewPath === '/about/' && f.presence.viewportWidth === 390), 'the new page reaches the guest'));

  step('the popover admits and declines, and manages the roster');
  const bo = await asks(roomId, 'Bo');
  const cy = await asks(roomId, 'Cy');
  dialog = await openShare();
  assert.equal(await win.getByRole('dialog', { name: 'Live session' }).count(), 1);
  assert.equal(await notice.count(), 0, 'while Share is open it lists the waiting itself');
  const waiting = dialog.getByRole('region', { name: 'Waiting to join (2)' });
  await waiting.getByRole('group', { name: 'Answer Bo' }).getByRole('button', { name: 'Admit as Viewer' }).click();
  const boIn = await bo.guest.next('guest:status');
  assert.equal(boIn.status, 'admitted');
  assert.equal(boIn.role, 'viewer');
  await dialog.getByRole('group', { name: 'Answer Cy' }).getByRole('button', { name: 'Decline' }).click();
  assert.equal((await cy.guest.next('guest:status')).status, 'declined');
  await dialog.getByRole('region', { name: 'In the session (2)' }).waitFor();
  assert.equal(await dialog.getByRole('region', { name: /Waiting to join/ }).count(), 0);

  await dialog.getByLabel('Role for Ann').selectOption('viewer');
  assert.equal((await ann.guest.next('guest:status')).role, 'viewer', 'the guest hears its new role');
  await eventually(async () => assert.equal((await roster()).find((p) => p.displayName === 'Ann').role, 'viewer'));

  await dialog.getByLabel('Access for Bo').selectOption({ label: 'For 15 minutes' });
  const boLimited = await bo.guest.next('guest:status');
  assert.ok(boLimited.guestExpiresAt > boLimited.now && boLimited.guestExpiresAt <= boLimited.now + 15 * 60_000 + 5000, 'the guest’s own access ends in 15 minutes');
  await dialog.getByText(/Bo.*· 1[45]m left/).waitFor();
  await win.screenshot({ path: join(SHOTS, 'live-share-roster.png') });

  step('locking turns new guests away and keeps those in');
  await dialog.getByRole('switch', { name: 'Lock room' }).click();
  assert.equal((await ann.guest.next('room:state')).locked, true);
  await eventually(async () => assert.equal(await dialog.getByRole('switch', { name: 'Lock room' }).getAttribute('aria-checked'), 'true'));
  const late = await relay.socket(`/s/${roomId}/ws`);
  guests.push(late);
  late.send('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Dee' });
  assert.equal((await late.next('guest:status')).status, 'locked', 'a locked room turns a new guest away');
  await dialog.getByRole('switch', { name: 'Lock room' }).click();
  assert.equal((await ann.guest.next('room:state')).locked, false);

  step('extending moves the end later');
  const before = (await hostState()).expiresAt;
  await dialog.getByRole('button', { name: 'Extend' }).click();
  await win.getByRole('menuitem', { name: /30 minutes more/ }).click();
  const extended = await ann.guest.next('room:state');
  assert.equal(extended.expiresAt, before + 30 * 60_000);
  await eventually(async () => assert.match(await share().innerText(), /Live · (59m|1h 00m)/));

  step('removing a guest');
  await dialog.getByRole('button', { name: 'Remove Bo' }).click();
  await statusOf(bo.guest, 'kicked');
  await bo.guest.closed();
  await dialog.getByRole('region', { name: 'In the session (1)' }).waitFor();

  step('ending the session');
  await dialog.getByRole('button', { name: 'End session' }).click();
  await statusOf(ann.guest, 'ended');
  await ann.guest.closed();
  await eventually(async () => assert.equal((await hostState()).phase, 'idle'));
  await win.getByRole('dialog', { name: 'Share a live session' }).waitFor();
  assert.equal(await share().getAttribute('aria-label'), 'Share: start a live session');
  await closeShare();

  step('closing the project ends a running session for everyone');
  dialog = await openShare();
  await dialog.getByRole('button', { name: 'Start live session' }).click();
  await eventually(async () => assert.match(await share().innerText(), /Live/));
  const room2 = parseInviteLink(await dialog.getByLabel('Invite link').inputValue()).roomId;
  const eve = await asks(room2, 'Eve');
  await dialog.getByRole('group', { name: 'Answer Eve' }).getByRole('button', { name: 'Admit as Viewer' }).click();
  assert.equal((await eve.guest.next('guest:status')).status, 'admitted');
  const closed = await win.evaluate(() => window.builder.projects.close());
  assert.equal(closed.ok, true);
  await statusOf(eve.guest, 'ended');
  await eve.guest.closed();
  await eventually(async () => assert.equal((await hostState()).phase, 'idle'));
  await win.locator('.share-popover').waitFor({ state: 'detached' });

  step('the reopened project starts with no session');
  await createProject(win, { name: 'Second Site', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
  assert.equal(await share().getAttribute('aria-label'), 'Share: start a live session');
  assert.equal(await share().locator('.share-badge').count(), 0);
  assert.equal(await win.locator('.share-popover').count(), 0);

  assert.deepEqual(errors, [], 'no uncaught errors in the editor');
} finally {
  for (const g of guests) g.close();
  await app?.close().catch(() => undefined);
  await relay?.dispose().catch(() => undefined);
}
// Once the app has let go of its files.
cleanup();
console.log('\nlive-share: all checks passed');
