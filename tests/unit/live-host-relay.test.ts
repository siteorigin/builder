import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LiveHostState, LiveJoinRequest, LiveRun } from '../../src/shared/api';
import { parseInviteLink, resolveRelayUrl } from '../../src/shared/live/relay-url';
import { LiveHostManager, type LiveHostTimings } from '../../src/main/live/host';
import { joinGuest, previewOrigin, randomAddress, redeemTicket, startRelay, wait, type Relay } from './relay-harness';

/**
 * The host's live session manager against the relay in Cloudflare's local simulator: the manager connects for real,
 * as the app does, and guests are played over the simulator's own sockets. A loopback server stands in for the
 * project's Vite preview.
 */

const BINARY = new Uint8Array(1024 * 1024 + 4321).map((_, i) => (i * 31 + 7) % 256);
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
let vite: Server;
let vitePort: number;
let relay: Relay;
let relayOrigin: string;

beforeAll(async () => {
  vite = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    switch (req.url) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'vite=1' });
        return res.end('<!doctype html><title>Live home</title><script type="module" src="/app.js"></script>');
      case '/app.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        return res.end('main { display: grid }');
      case '/app.js':
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end('console.log("live")');
      case '/photo.bin':
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BINARY.length) });
        return res.end(Buffer.from(BINARY));
      case '/contact/':
        res.writeHead(303, { location: 'thanks' });
        return res.end();
      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('echo');
    }
  });
  await new Promise<void>((resolve) => vite.listen(0, '127.0.0.1', resolve));
  vitePort = (vite.address() as AddressInfo).port;
  relay = await startRelay();
  relayOrigin = await relay.origin();
}, 60_000);
afterAll(async () => {
  await relay?.dispose();
  await new Promise<void>((resolve) => vite.close(() => resolve()));
});

const managers: LiveHostManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.end();
  seen.length = 0;
});

/** A host manager for an open project, with what it tells the editor collected and its sockets kept. */
function host(opts: { relayUrl?: string; timings?: Partial<LiveHostTimings>; onSocket?: (socket: WebSocket) => void } = {}) {
  const env = { opening: { workspaceKey: '/sites/acme#1', projectName: 'Acme Bakery' } as { workspaceKey: string; projectName: string } | null, preview: { port: vitePort } as { port: number } | null };
  const states: LiveHostState[] = [];
  const requests: LiveJoinRequest[] = [];
  const sockets: Array<{ url: string; socket: WebSocket }> = [];
  const address = randomAddress();
  const manager = new LiveHostManager(
    {
      opening: () => env.opening,
      preview: () => env.preview,
      relay: async () => resolveRelayUrl({ env: opts.relayUrl ?? relayOrigin }),
      emit: (channel, payload) => (channel === 'live:state' ? states.push(payload as LiveHostState) : requests.push(payload as LiveJoinRequest))
    },
    {
      // Each manager comes from its own address, so the relay's limit on new rooms per address never bites here.
      createSocket: (url) => {
        const socket = new WebSocket(url, { headers: { 'cf-connecting-ip': address } } as never);
        sockets.push({ url, socket });
        opts.onSocket?.(socket);
        return socket;
      },
      timings: { backoffBaseMs: 50, backoffMaxMs: 200, ...opts.timings }
    }
  );
  managers.push(manager);
  return { manager, env, states, requests, sockets };
}

async function until<T>(check: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(10);
  }
}

type Active = Extract<LiveHostState, { phase: 'active' | 'reconnecting' }>;
const active = (manager: LiveHostManager) => (manager.state.phase === 'active' ? (manager.state as Active) : null);

async function started(h: ReturnType<typeof host>, duration: '30m' | '2h' | 'project' = '2h') {
  const result = await h.manager.start({ opening: '/sites/acme#1', duration });
  if (!result.ok) throw new Error(result.message);
  const state = active(h.manager)!;
  const run: LiveRun = { workspaceKey: state.workspaceKey, runId: state.runId };
  return { result, state, run };
}

/** A guest the host has let in, holding a working preview cookie. */
async function admitted(h: ReturnType<typeof host>, run: LiveRun, roomId: string, name = 'Ann', role: 'viewer' | 'collaborator' = 'viewer') {
  const joined = await joinGuest(relay, roomId, name);
  await until(() => h.requests.find((r) => r.guestId === joined.guestId), `${name}'s join request`);
  expect(h.manager.admit(run, joined.guestId, role)).toEqual({ ok: true });
  const status = await joined.guest.next('guest:status');
  if (status.status !== 'admitted') throw new Error(`Expected ${name} to be admitted, got ${status.status}`);
  const redeemed = await redeemTicket(relay, roomId, status.previewTicket);
  expect(redeemed.status).toBe(204);
  return { ...joined, status, cookie: redeemed.cookie! };
}

async function preview(roomId: string, cookie: string, path: string, headers: Record<string, string> = {}) {
  const response = await relay.fetch(`${await previewOrigin(roomId)}${path}`, { headers: { cookie, ...headers } });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}

describe('starting a live session', () => {
  it('opens a room on the configured relay and returns its invite link', async () => {
    const h = host();
    const { result, state } = await started(h, '30m');
    if (!result.ok) throw new Error('not started');
    expect(parseInviteLink(result.inviteUrl)).toEqual({ relayUrl: relayOrigin, roomId: state.roomId });
    expect(state).toMatchObject({ phase: 'active', inviteUrl: result.inviteUrl, projectName: 'Acme Bakery', duration: '30m', locked: false, participants: [], previewReady: true });
    expect(state.expiresAt - state.startedAt).toBe(30 * 60_000);
    // The room was made on the relay's host socket, and the editor heard it start.
    expect(h.sockets.map((s) => new URL(s.url).pathname)).toEqual(['/ws/host']);
    expect(h.states.map((s) => s.phase)).toEqual(['starting', 'active']);
  });

  it('refuses a relay address that is set but not usable, and a project opening that is not open', async () => {
    const bad = host({ relayUrl: 'ftp://relay.example' });
    const refused = await bad.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('SITEORIGIN_LIVE_RELAY_URL') });
    expect(bad.manager.state).toEqual({ phase: 'idle', lastError: expect.stringContaining('http://') });
    expect(bad.sockets).toEqual([]);
    const h = host();
    expect(await h.manager.start({ opening: '/sites/other#4', duration: '2h' })).toEqual({ ok: false, message: 'That project is no longer open.' });
    h.env.opening = null;
    expect(await h.manager.start({ opening: '/sites/acme#1', duration: '2h' })).toEqual({ ok: false, message: 'That project is no longer open.' });
    h.env.opening = { workspaceKey: '/sites/acme#1', projectName: 'Acme Bakery' };
    expect(await h.manager.start({ opening: '/sites/acme#1', duration: '3 weeks' })).toMatchObject({ ok: false });
    expect(h.sockets).toEqual([]);
  });
});

describe('the waiting room and guests', () => {
  it('admits, changes and removes guests, and locks and extends the room, through the relay', async () => {
    const h = host();
    const { state, run } = await started(h);
    const ann = await admitted(h, run, state.roomId, 'Ann');
    expect(ann.status).toMatchObject({ role: 'viewer', guestExpiresAt: null, projectName: 'Acme Bakery' });
    await until(() => active(h.manager)?.participants.find((p) => p.guestId === ann.guestId && p.status === 'admitted'), 'Ann admitted in the roster');

    // Promoted, then given an end of access of her own.
    expect(h.manager.setRole(run, ann.guestId, 'collaborator')).toEqual({ ok: true });
    expect(await ann.guest.next('guest:status')).toMatchObject({ status: 'admitted', role: 'collaborator' });
    const now = Date.now() + state.relayClockOffsetMs;
    expect(h.manager.setGuestExpiry(run, ann.guestId, now + 60 * 60_000)).toEqual({ ok: true });
    expect(await ann.guest.next('guest:status')).toMatchObject({ status: 'admitted', guestExpiresAt: now + 60 * 60_000 });
    // Not past the session's end, checked before anything is sent.
    expect(h.manager.setGuestExpiry(run, ann.guestId, state.expiresAt + 1)).toMatchObject({ ok: false });

    // With no editor to answer from, a guest's call is still answered, and nothing runs.
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'q1', method: 'project.snapshot', args: [] });
    expect(await ann.guest.next('rpc:response')).toMatchObject({ requestId: 'q1', ok: false, error: { code: 'UNAVAILABLE' } });

    // A second guest is turned away, and a third is kept out by the lock.
    const bob = await joinGuest(relay, state.roomId, 'Bob');
    await until(() => h.requests.find((r) => r.guestId === bob.guestId), "Bob's join request");
    expect(h.manager.decline(run, bob.guestId)).toEqual({ ok: true });
    expect(await bob.guest.next('guest:status')).toEqual({ type: 'guest:status', status: 'declined' });
    expect(h.manager.setLocked(run, true)).toEqual({ ok: true });
    await until(() => active(h.manager)?.locked, 'the room locked');
    const carol = await relay.socket<'relay-to-guest', 'guest-to-relay'>(`/s/${state.roomId}/ws`);
    carol.send('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Carol' });
    expect(await carol.next('guest:status')).toEqual({ type: 'guest:status', status: 'locked' });
    // Unlocked again, the next guest waits as usual.
    expect(h.manager.setLocked(run, false)).toEqual({ ok: true });
    await until(() => active(h.manager)?.locked === false, 'the room unlocked');
    const dan = await joinGuest(relay, state.roomId, 'Dan');
    await until(() => h.requests.find((r) => r.guestId === dan.guestId), "Dan's join request");
    expect(h.manager.decline(run, dan.guestId)).toEqual({ ok: true });

    // Extended: later, and never past 24 hours from the start.
    expect(h.manager.extend(run, state.expiresAt + 60_000)).toEqual({ ok: true });
    await until(() => active(h.manager)?.expiresAt === state.expiresAt + 60_000, 'the later end');
    expect(h.manager.extend(run, state.startedAt + 25 * 60 * 60_000)).toMatchObject({ ok: false });
    expect(h.manager.extend(run, state.expiresAt)).toMatchObject({ ok: false });

    // Removed.
    expect(h.manager.kick(run, ann.guestId)).toEqual({ ok: true });
    expect(await ann.guest.next('guest:status')).toEqual({ type: 'guest:status', status: 'kicked' });
    await until(() => active(h.manager)?.participants.length === 0, 'an empty roster');
    // Each waiting guest was announced once.
    expect(h.requests.map((r) => r.displayName)).toEqual(['Ann', 'Bob', 'Dan']);
  }, 20_000);

  it('lets a guest’s own access run out', async () => {
    const h = host();
    const { state, run } = await started(h);
    const joined = await joinGuest(relay, state.roomId, 'Dee');
    await until(() => h.requests.find((r) => r.guestId === joined.guestId), "Dee's join request");
    const until3s = Date.now() + state.relayClockOffsetMs + 3000;
    expect(h.manager.admit(run, joined.guestId, 'viewer', until3s)).toEqual({ ok: true });
    expect(await joined.guest.next('guest:status')).toMatchObject({ status: 'admitted', guestExpiresAt: until3s });
    expect(await joined.guest.next('guest:status', 15_000)).toEqual({ type: 'guest:status', status: 'expired', scope: 'guest' });
    await until(() => active(h.manager)?.participants.length === 0, 'Dee gone from the roster', 10_000);
  }, 30_000);

  it('refuses commands for a session that has ended, or another opening’s', async () => {
    const h = host();
    const { state, run } = await started(h);
    const joined = await joinGuest(relay, state.roomId, 'Eve');
    await until(() => h.requests.find((r) => r.guestId === joined.guestId), "Eve's join request");
    expect(h.manager.admit({ ...run, runId: 'another' }, joined.guestId, 'viewer')).toMatchObject({ ok: false });
    expect(h.manager.admit({ ...run, workspaceKey: '/sites/acme#2' }, joined.guestId, 'viewer')).toMatchObject({ ok: false });
    expect(h.manager.admit(run, 'nobody', 'viewer')).toMatchObject({ ok: false });
    expect(h.manager.admit(run, joined.guestId, 'owner')).toMatchObject({ ok: false });
    expect(await h.manager.stop(run)).toEqual({ ok: true });
    expect(h.manager.admit(run, joined.guestId, 'viewer')).toMatchObject({ ok: false, message: 'That live session has ended.' });
    expect(await h.manager.stop(run)).toMatchObject({ ok: false });
  });
});

describe('the host’s presence', () => {
  it('reaches a guest let in later, and every admitted guest as the host moves', async () => {
    const h = host();
    const { state, run } = await started(h);
    expect(h.manager.setPresence(run, { pageId: 'about', viewportWidth: 834, selection: null, previewPath: '/about/' })).toEqual({ ok: true });
    // Ann joins after the host has settled on a page: she is shown it as she is let in.
    const ann = await admitted(h, run, state.roomId);
    expect(await ann.guest.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'host' }, presence: { pageId: 'about', viewportWidth: 834, selection: null, previewPath: '/about/' } });
    expect(h.manager.setPresence(run, { pageId: 'home', viewportWidth: 390, selection: null, previewPath: '/' })).toEqual({ ok: true });
    expect(await ann.guest.next('presence:changed')).toMatchObject({ participant: { kind: 'host' }, presence: { pageId: 'home', viewportWidth: 390, previewPath: '/' } });
  });
});

describe('the preview tunnel', () => {
  it('serves admitted guests the project’s preview byte for byte: HTML, CSS, JS and a binary larger than a chunk', async () => {
    const h = host();
    const { state, run } = await started(h);
    const ann = await admitted(h, run, state.roomId);
    const html = await preview(state.roomId, ann.cookie, '/');
    expect(html.status).toBe(200);
    expect(html.body.toString()).toContain('<title>Live home</title>');
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('set-cookie')).toBeNull();
    expect((await preview(state.roomId, ann.cookie, '/app.css')).body.toString()).toBe('main { display: grid }');
    expect((await preview(state.roomId, ann.cookie, '/app.js')).body.toString()).toBe('console.log("live")');
    const photo = await preview(state.roomId, ann.cookie, '/photo.bin');
    expect(photo.status).toBe(200);
    expect(Buffer.compare(photo.body, Buffer.from(BINARY))).toBe(0);
  });

  it('never passes a guest’s cookies or credentials to the preview server, and resolves a relative redirect', async () => {
    const h = host();
    const { state, run } = await started(h);
    const ann = await admitted(h, run, state.roomId);
    expect((await preview(state.roomId, ann.cookie, '/echo?x=1', { authorization: 'Bearer secret', 'accept-language': 'fr' })).status).toBe(200);
    const asked = seen.find((s) => s.url === '/echo?x=1')!;
    expect(asked.headers.cookie).toBeUndefined();
    expect(asked.headers.authorization).toBeUndefined();
    expect(asked.headers.host).toBe(`127.0.0.1:${vitePort}`);
    expect(asked.headers['accept-language']).toBe('fr');
    // A path that leaves the preview, or names one of the development server's own routes, never reaches it. (A
    // dot segment never gets this far: the guest's URL parser resolves it first. The host's own check of the raw
    // target is in live-preview-proxy.test.ts.)
    seen.length = 0;
    for (const path of ['/a/%2F/b', '/__open-in-editor?file=/etc/passwd', '/x/__inspect/']) expect((await preview(state.roomId, ann.cookie, path)).status).toBeGreaterThanOrEqual(400);
    expect(seen).toEqual([]);
    const redirect = await relay.http(`${await previewOrigin(state.roomId)}/contact/`, { headers: { cookie: ann.cookie } });
    await redirect.arrayBuffer();
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe('/contact/thanks');
  });

  it('says the preview is unavailable while no preview server is ready, and has guests reload once it is and on every change', async () => {
    const h = host({ timings: { reloadMs: 20 } });
    h.env.preview = null;
    const { state, run } = await started(h);
    expect(state.previewReady).toBe(false);
    const ann = await admitted(h, run, state.roomId);
    expect((await preview(state.roomId, ann.cookie, '/')).status).toBe(503);
    h.env.preview = { port: vitePort };
    h.manager.previewChanged();
    await ann.guest.next('preview:reload');
    expect(active(h.manager)?.previewReady).toBe(true);
    expect((await preview(state.roomId, ann.cookie, '/')).status).toBe(200);
    // Changes close together reach guests as one reload.
    h.manager.projectChanged();
    h.manager.projectChanged();
    await ann.guest.next('preview:reload');
    await wait(100);
    expect(ann.guest.has('preview:reload')).toBe(false);
  });
});

describe('losing the relay connection', () => {
  it('takes the room back with the session key, and admitted guests keep their places and their access', async () => {
    // Reconnects wait long enough that the change below is made while the host is away.
    const h = host({ timings: { reloadMs: 20, backoffBaseMs: 400, backoffMaxMs: 400 } });
    const { state, run } = await started(h);
    const ann = await admitted(h, run, state.roomId);
    // The connection drops (closed from this end with a code that means nothing to the relay, so nothing is ended).
    h.sockets[0].socket.close(3999);
    await until(() => h.manager.state.phase === 'reconnecting', 'reconnecting');
    // A change made while it is away reaches guests once it is back, as one reload.
    h.manager.projectChanged();
    await wait(60);
    expect(ann.guest.has('preview:reload')).toBe(false);
    await until(() => h.manager.state.phase === 'active' && h.sockets.length === 2, 'the room taken back');
    expect(new URL(h.sockets[1].url).pathname).toBe(`/s/${state.roomId}/ws`);
    const back = active(h.manager)!;
    expect(back).toMatchObject({ roomId: state.roomId, inviteUrl: state.inviteUrl, runId: state.runId });
    expect(back.participants).toEqual([expect.objectContaining({ guestId: ann.guestId, status: 'admitted', role: 'viewer' })]);
    await ann.guest.next('preview:reload');
    await wait(150);
    expect(ann.guest.has('preview:reload')).toBe(false);
    // The guest's cookie still works, through the new connection, and the host still runs the room.
    expect(Buffer.compare((await preview(state.roomId, ann.cookie, '/photo.bin')).body, Buffer.from(BINARY))).toBe(0);
    expect(h.manager.setRole(run, ann.guestId, 'collaborator')).toEqual({ ok: true });
    expect(await ann.guest.next('guest:status')).toMatchObject({ status: 'admitted', role: 'collaborator' });
    // Nobody waiting was announced twice.
    expect(h.requests.length).toBe(1);
  });

  it('refuses commands while reconnecting, and gives up once the outage outlasts its budget', async () => {
    const h = host({ relayUrl: undefined, timings: { outageMs: 300, backoffBaseMs: 1000, backoffMaxMs: 1000 } });
    const { run } = await started(h);
    // From here the relay cannot be reached: the only retry, at the budget's end, fails, and the session ends.
    h.manager.createSocket = () => {
      throw new Error('offline');
    };
    h.sockets[0].socket.close(3999);
    await until(() => h.manager.state.phase === 'reconnecting', 'reconnecting');
    expect(h.manager.setLocked(run, true)).toMatchObject({ ok: false, message: expect.stringContaining('reconnecting') });
    await until(() => h.manager.state.phase === 'idle', 'giving up', 5000);
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: expect.stringContaining('could not get it back') });
  });
});

describe('ending a live session', () => {
  it('ends the room for everyone and closes the connection when stopped', async () => {
    const h = host();
    const { state, run } = await started(h);
    const ann = await admitted(h, run, state.roomId);
    expect(await h.manager.stop(run)).toEqual({ ok: true });
    expect(await ann.guest.next('guest:status')).toEqual({ type: 'guest:status', status: 'ended' });
    expect(h.sockets[0].socket.readyState).toBe(WebSocket.CLOSED);
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
    // The room is gone from the relay: nobody can join or reconnect to it.
    expect((await relay.fetch(`/s/${state.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  });

  it('ends the room when the project goes without saying so', async () => {
    const h = host();
    const { state, run } = await started(h);
    const ann = await admitted(h, run, state.roomId);
    h.env.opening = null;
    // The next request finds the project gone: it is not served, and the session ends.
    expect((await preview(state.roomId, ann.cookie, '/')).status).toBeGreaterThanOrEqual(400);
    expect(seen).toEqual([]);
    expect(await ann.guest.next('guest:status')).toEqual({ type: 'guest:status', status: 'ended' });
    await until(() => h.manager.state.phase === 'idle', 'the session ended');
  });

  it('ends a room asked for while it is still being opened', async () => {
    // Stopped just after room:create went out, before the relay could answer: room:end follows it on the same
    // connection, so the room the relay opens is ended at once.
    let ended: Promise<void> | null = null;
    let roomId: string | null = null;
    const h = host({
      onSocket: (socket) => {
        socket.addEventListener('open', () => queueMicrotask(() => (ended = h.manager.end())));
        socket.addEventListener('message', (event) => {
          const frame = JSON.parse(String(event.data)) as { type: string; roomId?: string };
          if (frame.type === 'room:ready') roomId = frame.roomId!;
        });
      }
    });
    const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    expect(await starting).toEqual({ ok: false, message: 'The live session was stopped before it started.' });
    await ended;
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
    // The editor was never shown a room, and the one the relay opened is gone again.
    expect(h.states.some((state) => 'roomId' in state)).toBe(false);
    await until(() => h.sockets[0].socket.readyState === WebSocket.CLOSED, 'the connection closed');
    expect(roomId).not.toBeNull();
    expect((await relay.fetch(`/s/${roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  });

  it('asks for no room when stopped before the connection opens', async () => {
    let ended: Promise<void> | null = null;
    const h = host({ onSocket: () => queueMicrotask(() => (ended = h.manager.end())) });
    expect(await h.manager.start({ opening: '/sites/acme#1', duration: '2h' })).toMatchObject({ ok: false });
    await ended;
    expect(h.manager.state.phase).toBe('idle');
  });
});
