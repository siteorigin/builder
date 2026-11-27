// What a live session promises past its roster (#1285), end to end: a host app and a second Builder app joined as its
// Collaborator, against the relay in Cloudflare's local simulator, with a viewer played over the relay's own socket.
// With Allow AI editing on, the collaborator's request runs on the host's assistant, with a scripted model, and its
// change lands on the host's disk as the collaborator's own History step; turning it off stops a request the host is
// running and the host refuses the next one. The host's connection to the relay drops, and the host takes its room
// back with its signed session key, every admitted guest still in it. A removed guest's socket closes and its preview
// cookie is refused at once. And once the session has ended, an export of the project holds nothing of it: no live
// code, spotlight, notes or Builder runtime.
//
// Both apps run headless (no window shown, no focus taken) with no AI provider keys: the host's model is a local
// OpenAI-compatible server in this process, so no paid AI call can be made.
//
// Run with the repository's TypeScript loader, which the relay harness needs: node --import tsx tests/e2e/live-recovery.mjs
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';
import { MockOpenAIServer, envelopeReply } from '../unit/mock-openai-server.ts';
import { joinGuest, previewOrigin, redeemTicket, startRelay } from '../unit/relay-harness.ts';
import { parseInviteLink } from '../../src/shared/live/relay-url.ts';
import { verifyHostChallenge } from '../../src/shared/live/crypto.ts';
import { encodeFrame } from '../../src/shared/live/messages.ts';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes.ts';

const { WORK, SHOTS, cleanup } = scratch('live-recovery');
const HOST_WORK = join(WORK, 'host');
const GUEST_WORK = join(WORK, 'guest');
mkdirSync(HOST_WORK, { recursive: true });
mkdirSync(GUEST_WORK, { recursive: true });
// Headless whatever the caller's shell says: a person debugging another script may have SITEORIGIN_HEADED set.
const HEADLESS = { SITEORIGIN_HEADLESS: '1', SITEORIGIN_HEADED: '' };

let server = null;
let relay = null;
let host = null;
let guest = null;
let viewer = null;
/** Lets the model's held answer go: at the end, or once the request it answers has been given up. */
let release = () => undefined;

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

/** Record each time one of an app's native windows is shown or takes focus, from launch on: none may, even for a moment. */
const watchWindows = (app) =>
  app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const seen = (globalThis.__e2eWindowEvents = []);
    const hook = (w) => {
      for (const event of ['show', 'focus']) w.on(event, () => seen.push(`${event} ${w.id}`));
    };
    BrowserWindow.getAllWindows().forEach(hook);
    electronApp.on('browser-window-created', (_e, w) => hook(w));
  });

/**
 * Watch every WebSocket an app's main process opens, from here on: the app's own sockets, each a real one, with the
 * protocol frames it sends and receives kept (preview traffic and project snapshots left out) and how it closed. The
 * live session's managers make theirs with the platform's `new WebSocket(url)` at the moment they connect.
 */
const watchSockets = (app) =>
  app.evaluate(() => {
    if (globalThis.__e2eSockets) return;
    const Native = globalThis.WebSocket;
    const sockets = [];
    globalThis.__e2eSockets = sockets;
    const KEPT = new Set(['room:create', 'room:ready', 'room:roster', 'host:reconnect', 'host:challenge', 'host:proof', 'host:availability', 'guest:join', 'guest:status', 'rpc:request', 'rpc:response']);
    const keep = (entry, dir, data) => {
      if (typeof data !== 'string') return;
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (!frame || !KEPT.has(frame.type)) return;
      // A call's arguments and results can be a whole project: what a test reads of them is who asked what.
      if (frame.type === 'rpc:request' || frame.type === 'rpc:response') frame = { type: frame.type, guestId: frame.guestId, requestId: frame.requestId, method: frame.method, ok: frame.ok, error: frame.error };
      entry.frames.push({ dir, frame });
    };
    globalThis.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        const entry = { url: String(args[0]), frames: [], closed: null };
        sockets.push({ entry, socket: this });
        const send = this.send.bind(this);
        this.send = (data) => {
          send(data);
          keep(entry, 'out', data);
        };
        this.addEventListener('message', (e) => keep(entry, 'in', e.data));
        this.addEventListener('close', (e) => (entry.closed = { code: e.code }));
      }
    };
  });
/** What the watch has seen of each socket an app opened, oldest first. */
const socketsOf = (app) => app.evaluate(() => globalThis.__e2eSockets.map(({ entry }) => entry));
/** The one socket an app has open now. */
const openSocket = async (app, who) => {
  const open = (await socketsOf(app)).filter((s) => !s.closed);
  assert.equal(open.length, 1, `${who} has one socket to the relay open`);
  return open[0];
};

try {
  server = await new MockOpenAIServer().start();
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
  await watchWindows(host.app);
  const hw = host.win;
  // The host's AI is the scripted local model; the second app has no AI settings of its own.
  await hw.evaluate((baseURL) => window.builder.app.setSettings({ ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL, allowRemote: false, toolMode: 'constrained-json' } } }), server.baseURL);
  await hw.reload();
  await hw.waitForSelector('.welcome');
  await createProject(hw, { name: 'Harbour Lane Studio', parentDir: join(HOST_WORK, 'sites'), starter: 'business', sampleImages: false });
  guest = await launch(GUEST_WORK, { ...HEADLESS, SITEORIGIN_LIVE_RELAY_URL: origin });
  await watchWindows(guest.app);
  const gw = guest.win;
  await gw.locator('.welcome').waitFor();
  await watchSockets(host.app);
  await watchSockets(guest.app);

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
  const remoteAi = (joinId) => gw.evaluate((id) => window.builder.remote.ai(id), joinId);
  /** The model requests the host made: each a chat completion, never one from the second app. */
  const posts = () => server.requests.filter((r) => r.method === 'POST');
  // What passes too quickly for a poll to see is recorded as it happens: the host's session states and AI events,
  // and the second app's session states.
  await hw.evaluate(() => {
    window.__liveStates = [];
    window.__aiEvents = [];
    window.builder.on('live:state', (s) => window.__liveStates.push({ phase: s.phase, roomId: s.roomId ?? null, runId: s.runId ?? null }));
    window.builder.on('ai:event', (e) => window.__aiEvents.push({ runId: e.runId ?? null, kind: e.kind, status: e.status ?? null, role: e.message?.role ?? null, result: e.message?.result?.status ?? null }));
  });
  await gw.evaluate(() => {
    window.__remoteStates = [];
    window.builder.on('remote:state', (s) => window.__remoteStates.push({ phase: s.phase, hostConnected: s.hostConnected ?? null, role: s.role ?? null }));
  });
  const aiEvents = (runId) => hw.evaluate((id) => window.__aiEvents.filter((e) => e.runId === id), runId);

  const share = () => hw.locator('.toolbar .share-btn');
  const popover = () => hw.locator('.share-popover');
  const openShare = async () => {
    if ((await share().getAttribute('aria-expanded')) !== 'true') await share().click();
    await popover().waitFor();
    return popover();
  };
  // Put away with its own Close button: Escape closes it only while focus is in it, which a confirmation it asked
  // (Remove, End session) may not hand back.
  const closeShare = async () => {
    if ((await share().getAttribute('aria-expanded')) !== 'true') return;
    await popover().locator('.share-head').getByRole('button', { name: 'Close' }).click();
    await popover().waitFor({ state: 'detached' });
  };
  /** The next guest:status of `status` a guest hears, past any other status it was sent meanwhile. */
  const statusOf = async (peer, status, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const frame = await peer.next('guest:status', Math.max(1, end - Date.now()));
      if (frame.status === status) return frame;
    }
  };

  step('the host starts a live session, and the second app joins as a Collaborator');
  let dialog = await openShare();
  await dialog.getByRole('button', { name: 'Start live session' }).click();
  await eventually(async () => assert.match(await share().innerText(), /Live/));
  const invite = await dialog.getByLabel('Invite link').inputValue();
  const room = parseInviteLink(invite);
  assert.ok(room, `the invite link is a room link: ${invite}`);
  const { runId: sessionRun } = await hostState();
  await closeShare();
  // The host opened the room on one socket, with the public half of the session's key.
  const opened = await openSocket(host.app, 'the host');
  assert.equal(new URL(opened.url).pathname, '/ws/host');
  const create = opened.frames.find((f) => f.dir === 'out' && f.frame.type === 'room:create')?.frame;
  assert.ok(create?.publicKey, 'the host created the room with its session key');

  await gw.locator('.welcome .join-live-action').click();
  const joinDialog = gw.getByRole('dialog', { name: 'Join live session' });
  await joinDialog.waitFor();
  await joinDialog.getByLabel('Invite link').fill(invite);
  await joinDialog.getByLabel('Your name').fill('Ann');
  await joinDialog.getByRole('button', { name: 'Ask to join' }).click();
  await eventually(async () => assert.equal((await remoteState()).phase, 'waiting', 'the second app waits in the room'), 30000);
  const notice = hw.getByRole('region', { name: 'Join requests' });
  await notice.getByText('Ann wants to join').waitFor();
  await notice.getByRole('group', { name: 'Answer Ann' }).getByRole('button', { name: 'Admit as viewer' }).click();
  await eventually(async () => assert.equal((await remoteState()).phase, 'admitted'), 15000);
  const ann = (await roster()).find((p) => p.displayName === 'Ann');
  assert.ok(ann, 'Ann is in the host’s roster');
  dialog = await openShare();
  await dialog.getByLabel('Role for Ann').selectOption('collaborator');
  await eventually(async () => {
    const s = await remoteState();
    assert.equal(s.guestId, ann.guestId, 'the second app is the guest the host admitted');
    assert.equal(s.role, 'collaborator', 'the second app hears it is a collaborator');
  }, 15000);
  const joinId = (await remoteState()).joinId;
  await gw.locator('.toolbar .remote-pill').waitFor();
  const guestFrame = gw.frameLocator('.frame-box iframe');
  await guestFrame.locator('h1', { hasText: homePage.nodes[heroId].props.heading }).first().waitFor({ timeout: 60000 });
  await guestFrame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  // The second app's one socket is its place in the room.
  assert.equal(new URL((await openSocket(guest.app, 'the second app')).url).pathname, `/s/${room.roomId}/ws`);

  step('a viewer is admitted, opens the preview, pins a note and points at the page');
  const robin = await joinGuest(relay, room.roomId, 'Robin');
  viewer = robin.guest;
  await eventually(async () => assert.ok((await roster()).some((p) => p.guestId === robin.guestId && p.status === 'pending'), 'Robin is waiting'));
  await dialog.getByRole('group', { name: 'Answer Robin' }).getByRole('button', { name: 'Admit as viewer' }).click();
  const robinIn = await statusOf(viewer, 'admitted');
  assert.equal(robinIn.role, 'viewer');
  await closeShare();
  const redeemed = await redeemTicket(relay, room.roomId, robinIn.previewTicket);
  assert.equal(redeemed.status, 204, 'the viewer redeems its preview ticket');
  assert.ok(redeemed.cookie, 'and holds its preview cookie');
  // Each request for the preview is made with that cookie, on the preview origin the ticket was redeemed at.
  const robinPreview = await previewOrigin(room.roomId);
  const robinPage = async () => {
    const res = await relay.fetch(`${robinPreview}/`, { headers: { cookie: redeemed.cookie }, signal: AbortSignal.timeout(60000) });
    return { status: res.status, body: await res.text() };
  };
  const firstPage = await robinPage();
  assert.equal(firstPage.status, 200, 'the viewer’s cookie opens the host’s preview');
  // A note and a spotlight: what of the session the project could keep, and the canvas show.
  const noteText = `Is the hero bright enough ${Date.now().toString(36)}`;
  viewer.discard('rpc:response');
  viewer.send('guest-to-relay', { type: 'rpc:request', requestId: 'robin-note', method: 'notes.add', args: [{ text: noteText, previewPath: '/' }] });
  const kept = await viewer.next('rpc:response', 10000);
  assert.equal(kept.ok, true, `the viewer's note is kept: ${JSON.stringify(kept.error ?? null)}`);
  await eventually(async () => assert.equal((await hw.evaluate((key) => window.builder.notes.list(key), workspaceKey))?.notes.find((n) => n.text === noteText)?.authorName, 'Robin', 'the host has the viewer’s note'));
  assert.ok(readFileSync(join(dir, '.siteorigin', 'notes.json'), 'utf8').includes(noteText), 'the note is kept in the host project’s own state');
  viewer.send('guest-to-relay', { type: 'spotlight:point', spotlight: { previewPath: '/', target: null, x: 0.5, y: 0.2 } });
  await hw.locator(`.ov-spot-dot[data-peer="${robin.guestId}"]`).waitFor({ state: 'attached', timeout: 10000 });

  step('with Allow AI editing on, the collaborator’s request runs on the host’s AI and lands as hers');
  await gw.locator('.rail [aria-label="Layers"]').click();
  await gw.locator('.list-item', { hasText: 'Split hero' }).first().click();
  await eventually(async () => {
    const ref = JSON.parse((await gw.locator('.canvas').getAttribute('data-selected-ref')) ?? 'null');
    assert.equal(ref?.instancePath[0] ?? ref?.nodeId, heroId, 'the collaborator selected the Split hero');
  });
  await gw.locator('.dock-tab', { hasText: 'AI' }).click();
  await gw.locator('.remote-chat-off', { hasText: 'AI editing is off' }).waitFor();
  dialog = await openShare();
  const aiSwitch = () => popover().locator('.live-row', { has: hw.getByLabel('Role for Ann') }).getByRole('switch', { name: 'Allow AI editing' });
  await aiSwitch().click();
  await eventually(async () => assert.equal((await hostState()).ai?.[ann.guestId]?.allowed, true, 'the host lets Ann use its AI'));
  await closeShare();
  const ask = gw.getByRole('textbox', { name: 'Ask the host’s AI' });
  await ask.waitFor({ timeout: 15000 });
  await gw.getByText('Running on the host’s AI.').waitFor();
  assert.equal(await gw.getByRole('radio', { name: /^Selection · / }).isChecked(), true, 'the request is about the selected hero');
  const log = gw.getByRole('list', { name: 'Your AI requests' });
  const turn = (text) => log.locator('.remote-chat-turn', { hasText: text });
  const before = await hostSnap();
  const beforeIds = new Set(before.history.entries.map((e) => e.id));
  const aiMark = `Rooms the AI planned for Ann ${Date.now().toString(36)}`;
  const firstAsk = `Make the hero heading say ${aiMark}`;
  const postsBefore = posts().length;
  server.script(envelopeReply('update_selected_props', { props: { heading: aiMark } }, 'Changing the heading'), envelopeReply('finish', { message: 'Changed the heading.' }));
  await ask.fill(firstAsk);
  await gw.getByRole('button', { name: 'Send' }).click();
  await eventually(async () => assert.equal(await turn(firstAsk).locator('.remote-chat-status').innerText(), 'Done'), 60000);
  const asked = posts().slice(postsBefore);
  assert.ok(asked.length >= 2, `the host asked its model (${asked.length} requests)`);
  assert.ok(JSON.stringify(asked[0].body).includes(firstAsk), 'the model was given the collaborator’s request');
  assert.equal(asked[0].body.model, 'test-model', 'on the host’s own model');
  const done = (await remoteAi(joinId)).turns.find((t) => t.request === firstAsk);
  assert.equal(done?.result?.status, 'completed', 'the collaborator hears the request is done');
  assert.ok((await aiEvents(done.runId)).some((e) => e.role === 'assistant' && e.result === 'completed'), 'the request ran in the host’s assistant');
  assert.equal(savedHeading(), aiMark, 'the host’s page file has the AI’s heading');
  const madeByAi = await eventually(async () => {
    const added = (await hostSnap()).history.entries.filter((e) => !beforeIds.has(e.id));
    assert.equal(added.length, 1, `one History step for the request: ${added.map((e) => e.label).join(' | ')}`);
    return added[0];
  });
  assert.equal(madeByAi.source, 'ai');
  assert.equal(madeByAi.guestName, 'Ann', 'the AI’s step is the collaborator’s');
  assert.equal(madeByAi.runId, done.runId);
  assert.equal(madeByAi.applied, true);
  assert.match(madeByAi.label, /^AI for Ann: /, `the step's label names the collaborator: ${madeByAi.label}`);
  await guestFrame.locator('h1', { hasText: aiMark }).first().waitFor({ timeout: 30000 });
  await gw.screenshot({ path: join(SHOTS, 'live-recovery-ai.png') });

  step('turning AI editing off stops the request the host is running, and the host refuses the next');
  const held = await hostSnap();
  const heldIds = held.history.entries.map((e) => e.id);
  const postsHeld = posts().length;
  const disconnects = server.disconnects;
  // The model's answer waits until it is let go: the request is running on the host, and nothing has changed yet.
  const gate = new Promise((resolve) => (release = resolve));
  server.script({ ...envelopeReply('update_selected_props', { props: { heading: 'Never landed' } }, 'Changing the heading'), hold: gate });
  const secondAsk = `Make the hero heading louder ${Date.now().toString(36)}`;
  await ask.fill(secondAsk);
  await gw.getByRole('button', { name: 'Send' }).click();
  await eventually(() => assert.equal(posts().length, postsHeld + 1, 'the host has asked its model'), 30000);
  assert.ok(JSON.stringify(posts().at(-1).body).includes(secondAsk));
  const running = await eventually(async () => {
    const ai = await remoteAi(joinId);
    assert.ok(ai.activeRunId && ai.activeRunId !== done.runId, 'the collaborator has its second request running');
    return ai.activeRunId;
  });
  await gw.locator('.remote-chat-actions').getByRole('button', { name: 'Stop' }).waitFor();
  assert.ok((await aiEvents(running)).length > 0, 'the host’s assistant is running it');
  dialog = await openShare();
  await aiSwitch().click();
  await eventually(async () => assert.equal((await hostState()).ai?.[ann.guestId]?.allowed, false, 'the host no longer lets Ann use its AI'));
  await closeShare();
  // The host stops its own run, and lets go of the model request it was waiting on, before the answer comes.
  await eventually(async () => assert.ok((await aiEvents(running)).some((e) => e.role === 'assistant' && e.result === 'cancelled'), 'the host’s run ended, stopped'), 15000);
  await eventually(() => assert.equal(server.disconnects, disconnects + 1, 'the host gave up the model request it was waiting on'), 15000);
  release();
  await eventually(async () => assert.equal(await turn(secondAsk).locator('.remote-chat-status').innerText(), 'Stopped'), 15000);
  await turn(secondAsk).getByText('The host turned off AI editing for you, so this request was stopped.').waitFor();
  await gw.locator('.remote-chat-off', { hasText: 'AI editing is off' }).waitFor();
  assert.equal((await remoteAi(joinId)).activeRunId, null, 'nothing is running for the collaborator');
  const afterStop = await hostSnap();
  assert.equal(afterStop.revision, held.revision, 'the stopped request changed nothing');
  assert.deepEqual(
    afterStop.history.entries.map((e) => e.id),
    heldIds,
    'and added no History step'
  );
  assert.equal(savedHeading(), aiMark, 'the host’s page file keeps the first request’s heading');
  // The next request, sent over the second app's own place in the room past its editor (which would not send it now),
  // reaches the host as Ann's, and the host refuses it.
  const probe = `e2e-ai-${Date.now().toString(36)}`;
  const thirdAsk = `Make the hero heading quieter ${Date.now().toString(36)}`;
  const encoded = encodeFrame('guest-to-relay', { type: 'rpc:request', requestId: probe, method: 'ai.send', args: [thirdAsk, { scope: 'page', pageId: homeId, selection: null, viewport: 1280 }] });
  assert.ok(encoded.ok, encoded.error?.message);
  await guest.app.evaluate((_electron, text) => globalThis.__e2eSockets.filter(({ entry }) => !entry.closed).at(-1).socket.send(text), encoded.frame);
  const refusal = await eventually(async () => {
    const frames = (await openSocket(guest.app, 'the second app')).frames;
    const answer = frames.find((f) => f.dir === 'in' && f.frame.type === 'rpc:response' && f.frame.requestId === probe);
    const sent = (await socketsOf(host.app)).flatMap((s) => s.frames).filter((f) => f.frame.requestId === probe);
    assert.ok(answer, `the second app hears the answer: ${JSON.stringify({ guest: frames.slice(-6), host: sent })}`);
    return answer.frame;
  }, 10000);
  assert.deepEqual({ ok: refusal.ok, error: refusal.error }, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'The host has not allowed you to use its AI.', recoverable: false } });
  const hostSaw = (await openSocket(host.app, 'the host')).frames.filter((f) => f.frame.requestId === probe);
  assert.deepEqual(
    hostSaw.map((f) => [f.dir, f.frame.type, f.frame.method, f.frame.guestId]),
    [
      ['in', 'rpc:request', 'ai.send', ann.guestId],
      ['out', 'rpc:response', 'ai.send', ann.guestId]
    ],
    'the host was asked, as Ann, and answered'
  );
  assert.equal(posts().length, postsHeld + 1, 'the refused request never reached the model');
  assert.equal((await hostSnap()).revision, held.revision);
  assert.equal((await remoteState()).phase, 'admitted', 'the collaborator is still in the room');

  step('the host’s connection drops, and it takes the room back with its signed key, every guest still in it');
  const inRoom = (participants) =>
    participants
      .filter((p) => p.status === 'admitted')
      .map((p) => [p.displayName, p.guestId, p.role])
      .sort();
  const everyone = [
    ['Ann', ann.guestId, 'collaborator'],
    ['Robin', robin.guestId, 'viewer']
  ];
  assert.deepEqual(inRoom(await roster()), everyone);
  viewer.discard('host:availability');
  await hw.evaluate(() => (window.__liveStates.length = 0));
  await gw.evaluate(() => (window.__remoteStates.length = 0));
  // Closed from the host's end with a code that means nothing to the relay, as the network giving way does: nothing is
  // ended, and the host reconnects.
  await host.app.evaluate(() => {
    const open = globalThis.__e2eSockets.filter(({ entry }) => !entry.closed);
    if (open.length !== 1) throw new Error(`expected one host socket open, found ${open.length}`);
    open[0].socket.close(3999);
  });
  assert.equal((await viewer.next('host:availability', 10000)).connected, false, 'the relay tells the guests the host has gone');
  assert.equal((await viewer.next('host:availability', 30000)).connected, true, 'and that it is back');
  await eventually(async () => {
    const s = await hostState();
    assert.equal(s.phase, 'active');
    assert.equal(s.roomId, room.roomId, 'the same room');
    assert.equal(s.runId, sessionRun, 'the same session');
    assert.equal(s.inviteUrl, invite, 'the same invite link');
  }, 30000);
  const phases = await hw.evaluate(() => window.__liveStates.map((s) => s.phase));
  assert.ok(phases.indexOf('reconnecting') >= 0 && phases.lastIndexOf('active') > phases.indexOf('reconnecting'), `the host went from reconnecting back to live: ${phases.join(' → ')}`);
  const hostSockets = await socketsOf(host.app);
  assert.equal(hostSockets[0].closed?.code, 3999);
  assert.deepEqual(
    hostSockets.slice(1).map((s) => new URL(s.url).pathname),
    hostSockets.slice(1).map(() => `/s/${room.roomId}/ws`),
    'every new socket went to its room, none to make a new one'
  );
  const back = hostSockets.at(-1);
  assert.ok(hostSockets.length >= 2 && !back.closed, 'the host holds its room on a new socket');
  const exchange = back.frames.filter((f) => ['host:reconnect', 'host:challenge', 'host:proof', 'room:ready'].includes(f.frame.type));
  assert.deepEqual(
    exchange.map((f) => `${f.dir} ${f.frame.type}`),
    ['out host:reconnect', 'in host:challenge', 'out host:proof', 'in room:ready'],
    'the host took the room back by answering the relay’s challenge'
  );
  const [, challenge, proof, ready] = exchange.map((f) => f.frame);
  assert.equal(challenge.roomId, room.roomId);
  assert.equal(proof.nonce, challenge.nonce);
  assert.equal(await verifyHostChallenge(create.publicKey, challenge, proof.signature), true, 'signed with the session key the room was made with');
  assert.equal(ready.roomId, room.roomId);
  assert.equal(hostSockets.flatMap((s) => s.frames).filter((f) => f.frame.type === 'room:create').length, 1, 'no new room was made');
  // Every admitted guest is still in the room, as the host and the guests see it.
  assert.deepEqual(inRoom(await roster()), everyone, 'the host’s roster has both guests in their roles');
  await eventually(async () => {
    const s = await remoteState();
    assert.equal(s.phase, 'admitted');
    assert.equal(s.joinId, joinId);
    assert.equal(s.guestId, ann.guestId);
    assert.equal(s.role, 'collaborator');
    assert.equal(s.hostConnected, true);
  }, 15000);
  const seen = await gw.evaluate(() => window.__remoteStates.map((s) => s.hostConnected));
  assert.ok(seen.indexOf(false) >= 0 && seen.lastIndexOf(true) > seen.indexOf(false), `the second app heard the host go and come back: ${seen.join(' → ')}`);
  assert.equal((await socketsOf(guest.app)).length, 1, 'the second app kept its own socket');
  assert.equal(viewer.closeEvent, null, 'the viewer’s socket stayed open');
  assert.equal(
    viewer.take('guest:status', (f) => f.status !== 'admitted'),
    undefined,
    'and the viewer was never sent away'
  );
  const servedAgain = await robinPage();
  assert.equal(servedAgain.status, 200, 'the viewer’s cookie still opens the preview, through the new connection');
  assert.ok(servedAgain.body.includes(aiMark), 'the page as the host has it');
  // The collaborator's edits reach the host again.
  const recovered = `Rooms planned after the drop ${Date.now().toString(36)}`;
  const edited = await gw.evaluate(
    ({ id, heroId, homeId, value }) => window.builder.remote.apply(id, { operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId: heroId, prop: 'heading', value }] }),
    { id: joinId, heroId, homeId, value: recovered }
  );
  assert.equal(edited.ok, true, `the collaborator’s edit lands: ${edited.error?.message ?? ''}`);
  await eventually(async () => assert.equal(savedHeading(), recovered, 'on the host’s disk'), 15000);

  step('a removed guest’s socket closes and its preview origin refuses it straight away');
  dialog = await openShare();
  await dialog.getByRole('button', { name: 'Remove Robin' }).click();
  await hw.getByRole('dialog', { name: 'Remove Robin?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await statusOf(viewer, 'kicked');
  // Asked the moment the guest hears it is removed: its cookie is already refused.
  const refused = await robinPage();
  assert.equal(refused.status, 403, 'the removed guest’s preview cookie is refused');
  assert.match(refused.body, /You no longer have access to this preview/);
  assert.equal((await viewer.closed()).code, LIVE_CLOSE_CODES.REMOVED, 'and its socket is closed');
  await eventually(async () => assert.deepEqual(inRoom(await roster()), [everyone[0]], 'the host’s roster has only Ann'));
  await eventually(async () => assert.equal(await hw.locator(`[data-peer="${robin.guestId}"]`).count(), 0, 'nothing of the removed guest’s shows on the canvas'), 2000);

  step('ending the session sends the second app back to Welcome, saying why');
  await dialog.getByRole('button', { name: 'End session' }).click();
  await hw.getByRole('dialog', { name: 'End the live session?' }).getByRole('button', { name: 'End session' }).click();
  await eventually(async () => assert.equal((await hostState()).phase, 'idle'));
  await gw.locator('.welcome').waitFor({ timeout: 15000 });
  assert.deepEqual(await remoteState(), { phase: 'idle', ended: { reason: 'ended', message: 'The host ended the live session.' } });
  await gw.getByText('The host ended the live session.').waitFor();
  await hw.getByRole('dialog', { name: 'Share a live session' }).waitFor();
  await closeShare();
  assert.equal(await hw.locator('.ov-peers [data-peer]').count(), 0, 'nothing of anyone’s shows on the host’s canvas');

  step('an export made after the session holds nothing of it');
  const exportsDir = join(HOST_WORK, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  await answerChoosers(host.app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
  const source = await withTimeout(hw.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
  assert.equal(source.ok, true, `the source export succeeds: ${source.message ?? ''}`);
  await answerChoosers(host.app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
  const site = await withTimeout(hw.evaluate(() => window.builder.project.exportStatic()), 300000, 'Website export');
  assert.equal(site.ok, true, `the website export succeeds: ${site.message ?? ''} ${site.warnings?.join(' ') ?? ''}`);
  /** Every file under `root`, relative, with `/` separators. */
  const files = (root, rel = '') =>
    readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? [`${r}/`, ...files(root, r)] : [r];
    });
  // The session's own words, addresses and guests, in any file.
  const SESSION = [noteText, room.roomId, invite, ann.guestId, robin.guestId];
  // The editor's instrumentation, the relay's preview bridge and guest marker, the live protocol's presence, spotlight
  // and note events, and the canvas's marks: names precise enough that a site's own words never match them.
  const LIVE_CODE =
    /data-so-(ctx|node|editing|unlinked|editor-only|filter|bridge)|siteorigin-bridge|__siteoriginBridge|__siteoriginHold|siteorigin-editor-instrumentation|siteorigin-frame-policy|\/__siteorigin\/|\/_viewer\/|siteorigin-live|x-siteorigin-live-guest|presence:(update|changed)|spotlight:point|data-siteorigin-pointing|ov-spot-dot|ov-peer|notes:changed/;
  /** A file's bytes as text the markers (all ASCII) can be found in, whatever kind of file it is. */
  const text = (path) => readFileSync(path).toString('latin1');
  const scan = (root, label) => {
    const all = files(root);
    assert.ok(all.some((f) => f.endsWith('index.html') || f.endsWith('.svelte')), `the ${label} export has the site in it`);
    assert.deepEqual(
      all.filter((f) => f.toLowerCase().split('/').includes('.siteorigin')),
      [],
      `the ${label} export has no .siteorigin state (notes, history, caches)`
    );
    const kept = all.filter((f) => !f.endsWith('/'));
    for (const words of SESSION)
      assert.deepEqual(
        kept.filter((f) => readFileSync(join(root, f)).includes(words)),
        [],
        `no file of the ${label} export holds the session’s ${words === noteText ? 'note' : words === invite ? 'invite link' : words === room.roomId ? 'room' : 'guests'}`
      );
    assert.deepEqual(
      kept.filter((f) => LIVE_CODE.test(text(join(root, f)))),
      [],
      `the ${label} export has no live-session, spotlight, note or editor code`
    );
    return kept;
  };
  // The scan finds what it looks for: the working project's own preview, which the editor instruments, has it.
  const devCache = join(dir, '.siteorigin', 'cache', 'dev');
  assert.ok(
    files(devCache).some((f) => !f.endsWith('/') && LIVE_CODE.test(text(join(devCache, f)))),
    'the working project’s editor preview has the code the scan looks for'
  );
  const sourceFiles = scan(source.path, 'source');
  assert.ok(sourceFiles.includes(`siteorigin/pages/${homeId}.json`), 'the source export keeps the documents');
  assert.equal(JSON.parse(readFileSync(join(source.path, 'siteorigin', 'pages', `${homeId}.json`), 'utf8')).nodes[heroId].props.heading, recovered, 'with the edits made during the session');
  const siteFiles = scan(site.path, 'website');
  assert.ok(siteFiles.includes('index.html'), 'the website has its home page');
  assert.ok(readFileSync(join(site.path, 'index.html'), 'utf8').includes(recovered), 'with the edits made during the session');

  step('both apps stayed headless, with no uncaught errors');
  await assertHeadless(host.app, 'the host');
  await assertHeadless(guest.app, 'the second app');
  assert.deepEqual(await host.app.evaluate(() => globalThis.__e2eWindowEvents), [], 'no window of the host’s was shown or focused at any point');
  assert.deepEqual(await guest.app.evaluate(() => globalThis.__e2eWindowEvents), [], 'no window of the second app’s was shown or focused at any point');
  assert.deepEqual(host.errors, [], 'no uncaught errors in the host’s editor');
  assert.deepEqual(guest.errors, [], 'no uncaught errors in the second app’s editor');
} finally {
  viewer?.close();
  // Each is let go in turn, and one that hangs does not keep the others running.
  await withTimeout(guest?.app.close() ?? Promise.resolve(), 30000, 'Closing the second app').catch(() => guest?.app.process().kill('SIGKILL'));
  await withTimeout(host?.app.close() ?? Promise.resolve(), 30000, 'Closing the host').catch(() => host?.app.process().kill('SIGKILL'));
  // The held answer goes only once its app is gone, so it can never land.
  release();
  await server?.stop().catch(() => undefined);
  await relay?.dispose().catch(() => undefined);
}
// Once the apps have let go of their files.
cleanup();
console.log('\nlive-recovery: all checks passed');
