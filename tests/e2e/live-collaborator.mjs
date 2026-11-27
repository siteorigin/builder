// A second SiteOrigin Builder joining a live session as a Collaborator (#1284), end to end: two real apps against the
// relay in Cloudflare's local simulator. The host starts a session from Share; the second app, at its Welcome screen,
// joins through the invite link the host shows and becomes a remote shell over the host's project once the host lets
// it in and makes it a Collaborator. Its selection shows as an outline on the host's canvas; a visual edit it makes in
// its Inspector is written to the host's project on disk, shows in the host's History as the collaborator's, and
// reaches a viewer in the same room (played over the relay's own socket, as a browser would join); it resolves a note
// that viewer pinned; a code edit it sends is refused by the host, and its remote shell refuses an export, which never
// reaches the host; and once the host makes it a Viewer, its next edit is refused at once.
//
// Both apps run headless (no window shown, no focus taken) with no AI provider keys, so no paid AI call can be made.
//
// Run with the repository's TypeScript loader, which the relay harness needs: node --import tsx tests/e2e/live-collaborator.mjs
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step, withTimeout } from './harness.mjs';
import { joinGuest, startRelay } from '../unit/relay-harness.ts';
import { parseInviteLink } from '../../src/shared/live/relay-url.ts';

const { WORK, SHOTS, cleanup } = scratch('live-collaborator');
const HOST_WORK = join(WORK, 'host');
const GUEST_WORK = join(WORK, 'guest');
mkdirSync(HOST_WORK, { recursive: true });
mkdirSync(GUEST_WORK, { recursive: true });
// Headless whatever the caller's shell says: a person debugging another script may have SITEORIGIN_HEADED set.
const HEADLESS = { SITEORIGIN_HEADLESS: '1', SITEORIGIN_HEADED: '' };

let relay = null;
let host = null;
let guest = null;
let viewer = null;

/** Every native window of an app: none may be shown or take focus. */
const windows = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() })));
const assertHeadless = async (app, who) => {
  const all = await windows(app);
  assert.ok(all.length > 0, `${who} has its window`);
  assert.deepEqual(
    all.filter((w) => w.visible || w.focused),
    [],
    `${who}'s windows are neither shown nor focused`
  );
};

try {
  // Started here, so the relay and the apps are let go whatever fails, even while they start.
  const starting = startRelay();
  relay = await withTimeout(starting, 120000, 'The relay simulator').catch(async (e) => {
    const late = await withTimeout(starting, 30000, 'The late relay simulator').catch(() => null);
    await late?.dispose().catch(() => undefined);
    throw e;
  });
  // A room's preview has its own origin under the relay's host name (p-<label>.relay.localhost), which an IP address
  // cannot give: the host is pointed at the relay by name, so the invite link it shows works for the second app.
  const origin = await relay.browserOrigin();

  host = await launch(HOST_WORK, { ...HEADLESS, SITEORIGIN_LIVE_RELAY_URL: origin });
  const hw = host.win;
  await createProject(hw, { name: 'Harbour Lane Studio', parentDir: join(HOST_WORK, 'sites'), starter: 'business', sampleImages: false });
  guest = await launch(GUEST_WORK, { ...HEADLESS, SITEORIGIN_LIVE_RELAY_URL: origin });
  const gw = guest.win;
  await gw.locator('.welcome').waitFor();

  const hostPid = await host.app.evaluate(() => process.pid);
  const guestPid = await guest.app.evaluate(() => process.pid);
  assert.notEqual(hostPid, guestPid, 'two app processes');
  const profiles = await Promise.all([host.app, guest.app].map((a) => a.evaluate(({ app }) => app.getPath('userData'))));
  assert.deepEqual(profiles, [join(HOST_WORK, 'userdata'), join(GUEST_WORK, 'userdata')], 'each app has its own profile');

  const hostSnap = () => hw.evaluate(() => window.builder.project.snapshot());
  const first = await hostSnap();
  const dir = first.dir;
  const workspaceKey = first.workspaceKey;
  const homeId = first.state.site.homePageId;
  const homePage = first.state.pages[homeId];
  const heroId = homePage.rootIds.find((id) => homePage.nodes[id].kind === 'instance' && first.state.components[homePage.nodes[id].definitionId]?.name === 'Split hero');
  assert.ok(heroId, 'the Business Home page has a Split hero');
  const savedHeading = () => JSON.parse(readFileSync(join(dir, 'siteorigin', 'pages', `${homeId}.json`), 'utf8')).nodes[heroId].props.heading;
  const hostState = () => hw.evaluate(() => window.builder.live.state());
  const roster = async () => (await hostState()).participants ?? [];
  const remoteState = () => gw.evaluate(() => window.builder.remote.state());

  const share = () => hw.locator('.toolbar .share-btn');
  const popover = () => hw.locator('.share-popover');
  const openShare = async () => {
    if ((await share().getAttribute('aria-expanded')) !== 'true') await share().click();
    await popover().waitFor();
    return popover();
  };
  const closeShare = async () => {
    if ((await share().getAttribute('aria-expanded')) !== 'true') return;
    await hw.keyboard.press('Escape');
    await popover().waitFor({ state: 'detached' });
  };

  step('the host starts a live session from Share');
  let dialog = await openShare();
  await dialog.getByRole('button', { name: 'Start live session' }).click();
  await eventually(async () => assert.match(await share().innerText(), /Live/));
  const invite = await dialog.getByLabel('Invite link').inputValue();
  const room = parseInviteLink(invite);
  assert.ok(room, `the invite link is a room link: ${invite}`);
  assert.equal(room.relayUrl, origin, 'the invite link points at the relay');
  await closeShare();

  step('the second app joins through the invite link and waits for the host');
  await gw.locator('.welcome .join-live-action').click();
  const join_ = gw.getByRole('dialog', { name: 'Join live session' });
  await join_.waitFor();
  await join_.getByLabel('Invite link').fill(invite);
  await join_.getByLabel('Your name').fill('Ann');
  await join_.getByRole('button', { name: 'Ask to join' }).click();
  await eventually(async () => assert.equal((await remoteState()).phase, 'waiting', 'the second app waits in the room'), 30000);
  const notice = hw.getByRole('region', { name: 'Join requests' });
  await notice.getByText('Ann wants to join').waitFor();

  step('the host admits it and makes it a Collaborator');
  await notice.getByRole('group', { name: 'Answer Ann' }).getByRole('button', { name: 'Admit as viewer' }).click();
  await eventually(async () => assert.equal((await remoteState()).phase, 'admitted'), 15000);
  const ann = (await roster()).find((p) => p.displayName === 'Ann');
  assert.ok(ann, 'Ann is in the host’s roster');
  dialog = await openShare();
  await dialog.getByLabel('Role for Ann').selectOption('collaborator');
  await eventually(async () => assert.equal((await roster()).find((p) => p.guestId === ann.guestId)?.role, 'collaborator', 'the host’s roster has Ann as a collaborator'));
  await eventually(async () => {
    const s = await remoteState();
    assert.equal(s.phase, 'admitted');
    assert.equal(s.roomId, room.roomId);
    assert.equal(s.guestId, ann.guestId, 'the second app is the guest the host admitted');
    assert.equal(s.role, 'collaborator', 'the second app hears it is a collaborator');
  }, 15000);
  const joinId = (await remoteState()).joinId;

  // The remote shell shows the host's project, its preview served from the host through the relay.
  await gw.locator('.toolbar .remote-pill').waitFor();
  const guestFrame = gw.frameLocator('.frame-box iframe');
  await guestFrame.locator('h1').first().waitFor({ timeout: 60000 });
  await guestFrame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  assert.equal((await gw.evaluate(() => window.builder.project.snapshot())) ?? null, null, 'the second app opened no project of its own');

  step('a viewer in the same room is admitted');
  const robin = await joinGuest(relay, room.roomId, 'Robin');
  viewer = robin.guest;
  await eventually(async () => assert.ok((await roster()).some((p) => p.guestId === robin.guestId && p.status === 'pending'), 'Robin is waiting'));
  await dialog.getByRole('group', { name: 'Answer Robin' }).getByRole('button', { name: 'Admit as viewer' }).click();
  const robinIn = await viewer.next('guest:status', 10000);
  assert.equal(robinIn.status, 'admitted');
  assert.equal(robinIn.role, 'viewer');
  await closeShare();

  step('the collaborator’s selection shows as an outline on the host’s canvas');
  await gw.locator('.rail [aria-label="Layers"]').click();
  await gw.locator('.list-item', { hasText: 'Split hero' }).first().click();
  await eventually(async () => {
    const ref = JSON.parse((await gw.locator('.canvas').getAttribute('data-selected-ref')) ?? 'null');
    assert.equal(ref?.instancePath[0] ?? ref?.nodeId, heroId, 'the collaborator selected the Split hero');
  });
  const outline = hw.locator(`.ov-peer.selection[data-peer="${ann.guestId}"]`);
  await outline.waitFor({ state: 'attached', timeout: 15000 });
  await hw.locator('.ov-peer-tag', { hasText: /^Ann$/ }).waitFor({ state: 'attached' });
  const box = await outline.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'the outline has a size on the host’s canvas');
  await hw.screenshot({ path: join(SHOTS, 'live-collaborator-outline.png') });

  step('the collaborator’s visual edit is written to the host’s disk, shows in its History and reaches the viewer');
  const before = await hostSnap();
  const beforeIds = new Set(before.history.entries.map((e) => e.id));
  const marker = `Rooms planned with Ann ${Date.now().toString(36)}`;
  viewer.discard('rpc:event');
  await openInspector(gw);
  const heading = gw.locator('#dock-panel-inspect').getByRole('textbox', { name: 'Heading', exact: true });
  await heading.waitFor();
  await heading.fill(marker);
  await heading.press('Tab');
  await eventually(async () => assert.equal(savedHeading(), marker, 'the host’s page file has the collaborator’s heading'), 15000);
  const made = await eventually(async () => {
    const s = await hostSnap();
    const added = s.history.entries.filter((e) => !beforeIds.has(e.id));
    assert.equal(added.length, 1, `one History step for the edit: ${added.map((e) => e.label).join(' | ')}`);
    return { entry: added[0], revision: s.revision };
  });
  assert.equal(made.entry.guestName, 'Ann', 'the History step is the collaborator’s');
  assert.equal(made.entry.source, 'user');
  assert.equal(made.entry.applied, true);
  assert.match(made.entry.label, /\(Ann\)$/, `the step's label names the collaborator: ${made.entry.label}`);
  // The viewer hears of the project with the edit in it.
  await eventually(
    () =>
      assert.ok(
        viewer.take('rpc:event', (f) => f.event === 'project:changed' && f.payload?.kind === 'snapshot' && f.payload.snapshot.revision >= made.entry.revision && f.payload.snapshot.state.pages[homeId]?.nodes[heroId]?.props?.heading === marker),
        'the viewer receives the project with the collaborator’s heading'
      ),
    15000
  );
  // And the host's History shows whose it is.
  await hw.locator('.project-title').click();
  await hw.locator('[role="menu"] [role^="menuitem"]', { hasText: 'History…' }).click();
  const history = hw.getByRole('dialog', { name: 'History' });
  await history.waitFor();
  const row = history.locator('.history-step', { has: hw.locator('.grow', { hasText: made.entry.label }) });
  await eventually(async () => assert.match(await row.locator('.history-step-meta').innerText(), /Ann \(guest\)/, 'the History row says the collaborator made it'));
  assert.match(await row.locator('.sr-only').innerText(), /^By Ann, a guest/);
  await hw.screenshot({ path: join(SHOTS, 'live-collaborator-history.png') });
  await hw.keyboard.press('Escape');
  await history.waitFor({ state: 'detached' });

  step('the collaborator resolves a note pinned in the room');
  const noteText = `Can the hero say more? ${Date.now().toString(36)}`;
  viewer.discard('rpc:response');
  viewer.send('guest-to-relay', { type: 'rpc:request', requestId: 'robin-note', method: 'notes.add', args: [{ text: noteText, previewPath: '/' }] });
  const kept = await viewer.next('rpc:response', 10000);
  assert.equal(kept.requestId, 'robin-note');
  assert.equal(kept.ok, true, `the viewer's note is kept: ${JSON.stringify(kept.error ?? null)}`);
  const pinned = await eventually(async () => {
    const note = (await hw.evaluate((key) => window.builder.notes.list(key), workspaceKey))?.notes.find((n) => n.text === noteText);
    assert.ok(note, 'the host has the viewer’s note');
    return note;
  });
  assert.equal(pinned.authorName, 'Robin');
  assert.equal(pinned.resolved, false);
  await gw.locator('.toolbar .notes-btn').click();
  const open = gw.getByRole('list', { name: 'Open notes' });
  const noteRow = open.locator('.notes-row', { hasText: noteText });
  await noteRow.waitFor({ timeout: 10000 });
  await noteRow.getByRole('checkbox', { name: 'Resolve' }).check();
  await eventually(async () => {
    const note = (await hw.evaluate((key) => window.builder.notes.list(key), workspaceKey))?.notes.find((n) => n.id === pinned.id);
    assert.equal(note?.resolved, true, 'the host’s note is resolved');
  });
  await gw.locator('.notes-done > summary').click();
  await gw.getByRole('list', { name: 'Resolved notes' }).locator('.notes-row', { hasText: noteText }).waitFor();
  await gw.keyboard.press('Escape');
  await eventually(async () => assert.equal(await gw.locator('.toolbar .notes-btn').getAttribute('aria-expanded'), 'false'));

  step('the host refuses the collaborator’s code edit, and an export never reaches it');
  const untouched = await hostSnap();
  const code = await gw.evaluate(
    (id) => window.builder.remote.apply(id, { operations: [{ type: 'component.createCode', name: 'Guest widget', source: '<p>guest</p>' }] }),
    joinId
  );
  assert.equal(code.ok, false, 'the code edit is refused');
  assert.equal(code.error.code, 'PERMISSION_DENIED');
  assert.equal(code.error.recoverable, false);
  assert.equal(code.error.operationIndex, 0, 'the host names the operation it refused');
  assert.match(code.error.message, /component\.createCode/);
  // The remote shell never offers Export over the host's project: the command says to leave the session first.
  await gw.evaluate(() => window.dispatchEvent(new CustomEvent('builder-command', { detail: 'export' })));
  await gw.locator('.toast', { hasText: 'Leave the live session first' }).waitFor();
  assert.equal(await gw.getByRole('dialog', { name: /Export/ }).count(), 0, 'no export dialog opens over the host’s project');
  const after = await hostSnap();
  assert.equal(after.revision, untouched.revision, 'nothing changed in the host’s project');
  assert.deepEqual(
    after.history.entries.map((e) => e.id),
    untouched.history.entries.map((e) => e.id)
  );
  assert.deepEqual(Object.keys(after.state.components).sort(), Object.keys(untouched.state.components).sort(), 'no component was made');
  assert.deepEqual(after.recentExports ?? null, untouched.recentExports ?? null, 'the host exported nothing');

  step('made a Viewer, the collaborator’s next edit is refused at once');
  dialog = await openShare();
  await dialog.getByLabel('Role for Ann').selectOption('viewer');
  // Sent as soon as the host has decided, whether or not the second app has heard yet: either it or the host refuses.
  const demoted = await gw.evaluate(
    ({ id, heroId, homeId }) =>
      window.builder.remote.apply(id, { operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId: heroId, prop: 'heading', value: 'Not allowed any more' }] }),
    { id: joinId, heroId, homeId }
  );
  assert.equal(demoted.ok, false, 'the edit after demotion is refused');
  assert.equal(demoted.error.code, 'PERMISSION_DENIED', demoted.error.message);
  assert.equal(demoted.error.recoverable, false);
  await eventually(async () => assert.equal((await remoteState()).role, 'viewer', 'the second app hears it is a viewer'), 15000);
  const again = await gw.evaluate(
    ({ id, heroId, homeId }) =>
      window.builder.remote.apply(id, { operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId: heroId, prop: 'heading', value: 'Not allowed any more' }] }),
    { id: joinId, heroId, homeId }
  );
  assert.deepEqual(again, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'The host has made you a viewer: you can watch, but not edit.', recoverable: false } });
  assert.equal(savedHeading(), marker, 'the host’s page file keeps the collaborator’s heading');
  const last = await hostSnap();
  assert.equal(last.revision, after.revision, 'no edit landed after the demotion');
  await closeShare();

  step('both apps stayed headless, with no uncaught errors');
  await assertHeadless(host.app, 'the host');
  await assertHeadless(guest.app, 'the second app');
  assert.deepEqual(host.errors, [], 'no uncaught errors in the host’s editor');
  assert.deepEqual(guest.errors, [], 'no uncaught errors in the second app’s editor');
} finally {
  viewer?.close();
  await guest?.app.close().catch(() => undefined);
  await host?.app.close().catch(() => undefined);
  await relay?.dispose().catch(() => undefined);
}
// Once the apps have let go of their files.
cleanup();
console.log('\nlive-collaborator: all checks passed');
