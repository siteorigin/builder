import { afterEach, describe, expect, it } from 'vitest';
import type { LiveHostState, LiveJoinRequest, LiveRun } from '../../src/shared/api';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { newNonce, newRoomId, verifyHostChallenge } from '../../src/shared/live/crypto';
import type { FrameOf, Participant } from '../../src/shared/live/messages';
import { resolveRelayUrl, type ResolvedRelayUrl } from '../../src/shared/live/relay-url';
import { LiveHostManager, MAX_SOCKET_BACKLOG_BYTES, type LiveHostTimings } from '../../src/main/live/host';

/**
 * The host's live session manager against sockets the test drives frame by frame, for the orderings a real relay
 * cannot be made to produce on cue: answers that never come, challenges for the wrong room, frames from a connection
 * that has already dropped, and stopping while the room is being taken back. Deadlines are generous unless a test is
 * about one, so a slow machine never trips them.
 */

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<FrameOf<'host-to-relay'>> = [];
  closedWith: number | null = null;
  constructor(readonly url: string) {
    super();
  }
  send(text: string) {
    if (this.readyState !== 1) throw new Error('Not open');
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.closedWith = code;
    this.readyState = 2;
    queueMicrotask(() => this.drop(code));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(frame: FrameOf<'relay-to-host'>) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  }
  /** The connection ends from the relay's side (or the network's), with this code. */
  drop(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }
  types() {
    return this.sent.map((f) => f.type);
  }
}

const RELAY = 'http://relay.localhost:8787';
const ANN: Participant = { guestId: 'g1', displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null };
const managers: LiveHostManager[] = [];
afterEach(async () => {
  // No relay answers a test's last room:end: each is let go at a short deadline.
  for (const m of managers.splice(0)) {
    (m as unknown as { timings: LiveHostTimings }).timings.stopMs = 20;
    await m.end();
  }
});

function host(opts: { timings?: Partial<LiveHostTimings>; relay?: () => Promise<ResolvedRelayUrl>; preview?: { port: number } | null; publishing?: () => boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const states: LiveHostState[] = [];
  const requests: LiveJoinRequest[] = [];
  const manager = new LiveHostManager(
    {
      opening: () => ({ workspaceKey: '/sites/acme#1', projectName: 'Acme' }),
      preview: () => opts.preview ?? null,
      relay: opts.relay ?? (async () => resolveRelayUrl({ env: RELAY })),
      publishing: opts.publishing,
      emit: (channel, payload) => void (channel === 'live:state' ? states.push(payload as LiveHostState) : requests.push(payload as LiveJoinRequest))
    },
    {
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      timings: { handshakeMs: 10_000, backoffBaseMs: 10, backoffMaxMs: 20, stopMs: 10_000, reloadMs: 5, ...opts.timings }
    }
  );
  managers.push(manager);
  /** The manager's own deadlines, to change between connections. */
  const timings = (manager as unknown as { timings: LiveHostTimings }).timings;
  return { manager, sockets, states, requests, timings };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(check: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(2);
  }
}
/** Whether a promise has settled, without waiting for it. */
function tracked<T>(promise: Promise<T>) {
  const t = { settled: false, value: undefined as T | undefined };
  void promise.then((value) => Object.assign(t, { settled: true, value }));
  return t;
}

const sentOf = <T extends FrameOf<'host-to-relay'>['type']>(socket: FakeSocket, type: T) => socket.sent.find((f) => f.type === type) as Extract<FrameOf<'host-to-relay'>, { type: T }> | undefined;
const ready = (roomId: string, now = Date.now(), extra: Partial<{ expiresAt: number; locked: boolean }> = {}): FrameOf<'relay-to-host'> => ({ type: 'room:ready', version: 1, roomId, startedAt: now, expiresAt: extra.expiresAt ?? now + 2 * 3600_000, locked: extra.locked ?? false, now });

/** Answer the room:create the manager sends on its first socket, as the relay would. */
async function opened(h: ReturnType<typeof host>, participants: Participant[] = [ANN]) {
  const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
  const socket = await until(() => h.sockets[0], 'the host socket');
  socket.open();
  const create = sentOf(socket, 'room:create')!;
  const roomId = newRoomId();
  const now = Date.now();
  socket.receive(ready(roomId, now));
  socket.receive({ type: 'room:roster', participants });
  const result = await starting;
  if (!result.ok) throw new Error(result.message);
  const state = h.manager.state;
  if (state.phase !== 'active') throw new Error(`Expected an active session, got ${state.phase}`);
  const run: LiveRun = { workspaceKey: state.workspaceKey, runId: state.runId };
  return { socket, roomId, publicKey: create.publicKey, run, now, state };
}

/** Prove the host on a reconnect socket, as the relay would, checking its signature against the room's key. */
async function reclaimed(socket: FakeSocket, roomId: string, publicKey: string, extra: Partial<{ expiresAt: number; locked: boolean }> = {}) {
  socket.open();
  expect(sentOf(socket, 'host:reconnect')).toEqual({ type: 'host:reconnect', version: 1, roomId });
  const nonce = newNonce();
  socket.receive({ type: 'host:challenge', roomId, nonce });
  const proof = await until(() => sentOf(socket, 'host:proof'), 'the proof');
  socket.receive(ready(roomId, Date.now(), extra));
  socket.receive({ type: 'room:roster', participants: [ANN] });
  expect(await verifyHostChallenge(publicKey, { roomId, nonce }, proof.signature)).toBe(true);
}

describe('starting', () => {
  it('runs one session at a time, even while the first is still finding its relay', async () => {
    let release!: (relay: ResolvedRelayUrl) => void;
    const h = host({ relay: () => new Promise((resolve) => (release = resolve)) });
    const first = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    expect(await h.manager.start({ opening: '/sites/acme#1', duration: '2h' })).toEqual({ ok: false, message: 'A live session is already running.' });
    release(resolveRelayUrl({ env: RELAY }));
    const socket = await until(() => h.sockets[0], 'the host socket');
    socket.open();
    socket.receive(ready(newRoomId()));
    socket.receive({ type: 'room:roster', participants: [] });
    expect((await first).ok).toBe(true);
    expect(h.sockets.length).toBe(1);
    expect(socket.types()).toEqual(['room:create']);
  });

  it('asks for nothing when stopped while finding its relay', async () => {
    let release!: (relay: ResolvedRelayUrl) => void;
    const h = host({ relay: () => new Promise((resolve) => (release = resolve)) });
    const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    await h.manager.end();
    release(resolveRelayUrl({ env: RELAY }));
    expect(await starting).toMatchObject({ ok: false });
    await wait(20);
    expect(h.sockets).toEqual([]);
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
  });

  it('fails a start the relay never answers, whether or not the connection opens, and tries no other room', async () => {
    for (const opens of [false, true]) {
      const h = host({ timings: { handshakeMs: 40 } });
      const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
      if (opens) (await until(() => h.sockets[0], 'the host socket')).open();
      expect(await starting).toMatchObject({ ok: false, message: expect.stringContaining(RELAY) });
      expect(h.manager.state).toMatchObject({ phase: 'idle' });
      await wait(60);
      expect(h.sockets.length).toBe(1);
    }
  });

  it('fails a start the relay refuses, with the relay’s reason', async () => {
    const h = host();
    const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    const socket = await until(() => h.sockets[0], 'the host socket');
    socket.open();
    socket.receive({ type: 'protocol:error', code: 'WRONG_STATE', message: 'The connection was not set up in time.' });
    socket.drop(LIVE_CLOSE_CODES.HANDSHAKE_TIMEOUT);
    expect(await starting).toEqual({ ok: false, message: 'The connection was not set up in time.' });
  });
});

describe('running the room', () => {
  it('shows what the relay refuses without changing the room', async () => {
    const h = host();
    const { socket, run, state } = await opened(h);
    expect(h.manager.setLocked(run, true)).toEqual({ ok: true });
    socket.receive({ type: 'protocol:error', code: 'WRONG_STATE', message: 'No guest with that ID is in the room.' });
    expect(h.manager.state).toMatchObject({ phase: 'active', locked: false, lastError: 'No guest with that ID is in the room.', expiresAt: state.expiresAt });
    expect(h.states.at(-1)).toMatchObject({ lastError: 'No guest with that ID is in the room.' });
  });

  it('never lets a second extension end the session sooner than the first asked for', async () => {
    const h = host();
    const { socket, run, state } = await opened(h);
    expect(h.manager.extend(run, state.expiresAt + 2 * 3600_000)).toEqual({ ok: true });
    expect(h.manager.extend(run, state.expiresAt + 3600_000)).toMatchObject({ ok: false });
    // Once the relay confirms, the room's own end is what counts.
    socket.receive({ type: 'room:state', startedAt: state.startedAt, expiresAt: state.expiresAt + 2 * 3600_000, locked: false, now: Date.now() });
    expect(h.manager.extend(run, state.expiresAt + 3 * 3600_000)).toEqual({ ok: true });
    expect(socket.sent.filter((f) => f.type === 'room:set-expiry').map((f) => (f as { expiresAt: number }).expiresAt)).toEqual([state.expiresAt + 2 * 3600_000, state.expiresAt + 3 * 3600_000]);
  });

  it('still counts an extension that is unconfirmed when another change to the room is confirmed', async () => {
    const h = host();
    const { socket, run, state } = await opened(h);
    expect(h.manager.setLocked(run, true)).toEqual({ ok: true });
    expect(h.manager.extend(run, state.expiresAt + 2 * 3600_000)).toEqual({ ok: true });
    // The lock's confirmation arrives first, with the old end.
    socket.receive({ type: 'room:state', startedAt: state.startedAt, expiresAt: state.expiresAt, locked: true, now: Date.now() });
    expect(h.manager.extend(run, state.expiresAt + 3600_000)).toMatchObject({ ok: false });
  });

  it('holds a guest reload while a save is landing, and sends it once it has', async () => {
    let landing = true;
    const h = host({ preview: { port: 5173 }, publishing: () => landing });
    const { socket } = await opened(h);
    h.manager.projectChanged();
    await wait(40);
    expect(sentOf(socket, 'preview:reload')).toBeUndefined();
    landing = false;
    await until(() => sentOf(socket, 'preview:reload'), 'the reload');
    expect(socket.sent.filter((f) => f.type === 'preview:reload').length).toBe(1);
  });

  it('gives up a connection whose outgoing backlog has stopped moving, and takes the room back on another', async () => {
    const h = host();
    const { socket, run, roomId, publicKey } = await opened(h);
    socket.bufferedAmount = MAX_SOCKET_BACKLOG_BYTES + 1;
    expect(h.manager.setLocked(run, true)).toMatchObject({ ok: false });
    expect(socket.closedWith).toBe(4000);
    expect(h.manager.state.phase).toBe('reconnecting');
    await reclaimed(await until(() => h.sockets[1], 'a reconnect'), roomId, publicKey);
    expect(h.manager.state.phase).toBe('active');
  });
});

describe('the host’s presence', () => {
  const at = (pageId: string | null, viewportWidth = 1280, previewPath: string | null = '/') => ({ pageId, viewportWidth, selection: null, previewPath });
  const presences = (socket: FakeSocket) => socket.sent.filter((f) => f.type === 'presence:update').map((f) => (f as { presence: unknown }).presence);

  it('sends where the host is while the room is held, and only when it changes', async () => {
    const h = host();
    const { socket, run } = await opened(h);
    expect(h.manager.setPresence(run, at('home'))).toEqual({ ok: true });
    expect(h.manager.setPresence(run, at('home'))).toEqual({ ok: true });
    expect(h.manager.setPresence(run, at('about', 390, '/about/'))).toEqual({ ok: true });
    // The width alone, or the address alone, is a change too.
    expect(h.manager.setPresence(run, at('about', 834, '/about/'))).toEqual({ ok: true });
    expect(h.manager.setPresence(run, at('about', 834, '/about/?tab=2'))).toEqual({ ok: true });
    expect(presences(socket)).toEqual([at('home'), at('about', 390, '/about/'), at('about', 834, '/about/'), at('about', 834, '/about/?tab=2')]);
  });

  it('sends a presence given before the room was open once it is, and again on the room taken back', async () => {
    const h = host();
    const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    const socket = await until(() => h.sockets[0], 'the host socket');
    const run = { workspaceKey: '/sites/acme#1', runId: (h.manager.state as LiveRun).runId };
    expect(h.manager.setPresence(run, at('home'))).toEqual({ ok: true });
    socket.open();
    const create = sentOf(socket, 'room:create')!;
    const roomId = newRoomId();
    socket.receive(ready(roomId));
    expect(presences(socket)).toEqual([]);
    socket.receive({ type: 'room:roster', participants: [ANN] });
    await starting;
    expect(presences(socket)).toEqual([at('home')]);
    socket.drop(1006);
    // Kept while the room is being taken back, and sent once it has been: the latest only.
    expect(h.manager.setPresence(run, at('about', 834, '/about/'))).toEqual({ ok: true });
    const again = await until(() => h.sockets[1], 'a reconnect');
    await reclaimed(again, roomId, create.publicKey);
    expect(presences(again)).toEqual([at('about', 834, '/about/')]);
  });

  it('refuses a presence the relay would not read, and one for a session that has ended', async () => {
    const h = host();
    const { socket, run } = await opened(h);
    expect(h.manager.setPresence(run, at('home', 10))).toMatchObject({ ok: false });
    expect(h.manager.setPresence(run, at('home', 1280, '../etc'))).toMatchObject({ ok: false });
    expect(h.manager.setPresence(run, { ...at('home'), extra: true })).toMatchObject({ ok: false });
    expect(h.manager.setPresence({ ...run, runId: 'other' }, at('home'))).toMatchObject({ ok: false });
    // Ending, and ended: nothing more goes out.
    const stopping = h.manager.stop(run);
    expect(h.manager.setPresence(run, at('home'))).toMatchObject({ ok: false });
    socket.drop(LIVE_CLOSE_CODES.ENDED);
    await stopping;
    expect(h.manager.setPresence(run, at('home'))).toMatchObject({ ok: false });
    expect(presences(socket)).toEqual([]);
  });
});

describe('taking the room back', () => {
  it('reconnects on the room’s socket, proves itself with the session key, and takes the room as the relay has it', async () => {
    const h = host({ preview: { port: 5173 } });
    const { socket, roomId, publicKey, state } = await opened(h);
    socket.drop(1006);
    expect(h.manager.state.phase).toBe('reconnecting');
    const again = await until(() => h.sockets[1], 'a reconnect');
    expect(new URL(again.url).pathname).toBe(`/s/${roomId}/ws`);
    await reclaimed(again, roomId, publicKey, { locked: true, expiresAt: state.expiresAt + 60_000 });
    expect(h.manager.state).toMatchObject({ phase: 'active', roomId, locked: true, expiresAt: state.expiresAt + 60_000, participants: [{ guestId: 'g1', status: 'admitted' }] });
    expect(Math.abs((h.manager.state as { relayClockOffsetMs: number }).relayClockOffsetMs)).toBeLessThan(1000);
    // Whatever was on its way to guests when the connection dropped may never have arrived: they reload once.
    await until(() => sentOf(again, 'preview:reload'), 'a reload after the reconnect');
  });

  it('gives up on a reconnect that is never answered and tries again', async () => {
    const h = host({ timings: { handshakeMs: 40 } });
    const { socket, roomId, publicKey } = await opened(h);
    socket.drop(1006);
    const silent = await until(() => h.sockets[1], 'the first reconnect');
    // Only this attempt is short of time: the next has all it needs.
    h.timings.handshakeMs = 10_000;
    silent.open();
    const next = await until(() => h.sockets[2], 'the second reconnect');
    expect(silent.closedWith).toBe(4000);
    await reclaimed(next, roomId, publicKey);
    expect(h.manager.state.phase).toBe('active');
  });

  it('never signs a challenge for another room', async () => {
    const h = host();
    const { socket, roomId } = await opened(h);
    socket.drop(1006);
    const again = await until(() => h.sockets[1], 'a reconnect');
    again.open();
    again.receive({ type: 'host:challenge', roomId: newRoomId(), nonce: newNonce() });
    // Given up at once, not at the handshake deadline.
    expect(again.closedWith).toBe(4000);
    await wait(20);
    expect(sentOf(again, 'host:proof')).toBeUndefined();
    expect(new URL((await until(() => h.sockets[2], 'another reconnect')).url).pathname).toBe(`/s/${roomId}/ws`);
  });

  it('ignores what a connection that has dropped still delivers', async () => {
    const h = host();
    const { socket } = await opened(h);
    socket.drop(1006);
    socket.receive({ type: 'room:roster', participants: [] });
    socket.receive({ type: 'room:state', startedAt: 1, expiresAt: 2, locked: true, now: 1 });
    expect(h.manager.state).toMatchObject({ phase: 'reconnecting', locked: false, participants: [{ guestId: 'g1' }] });
  });

  it('announces a waiting guest once, however many times the roster is sent again', async () => {
    const h = host();
    const ben: Participant = { guestId: 'g2', displayName: 'Ben', status: 'pending' };
    const { socket, roomId, publicKey } = await opened(h, [ANN, ben]);
    socket.receive({ type: 'room:roster', participants: [ANN, ben] });
    socket.drop(1006);
    const again = await until(() => h.sockets[1], 'a reconnect');
    again.open();
    const nonce = newNonce();
    again.receive({ type: 'host:challenge', roomId, nonce });
    await until(() => sentOf(again, 'host:proof'), 'the proof');
    again.receive(ready(roomId));
    again.receive({ type: 'room:roster', participants: [ANN, ben] });
    expect(h.requests.map((r) => r.guestId)).toEqual(['g2']);
    void publicKey;
  });

  it('ends the session when the relay will not have this key back', async () => {
    const h = host();
    const { socket, roomId } = await opened(h);
    socket.drop(1006);
    const again = await until(() => h.sockets[1], 'a reconnect');
    again.open();
    again.receive({ type: 'host:challenge', roomId, nonce: newNonce() });
    await until(() => sentOf(again, 'host:proof'), 'the proof');
    // The relay checks the signature and refuses it.
    again.receive({ type: 'protocol:error', code: 'AUTH_FAILED', message: 'The signature does not match this room’s host key.' });
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: 'The relay did not accept this computer as the live session’s host.' });
    await wait(40);
    expect(h.sockets.length).toBe(2);
  });

  it('stops trying once the outage outlasts its budget, even part way through a reconnect', async () => {
    const h = host({ timings: { outageMs: 150 } });
    const { socket } = await opened(h);
    socket.drop(1006);
    // The reconnect opens but is never answered; the budget, not the 10 s handshake deadline, ends it.
    (await until(() => h.sockets[1], 'a reconnect')).open();
    await until(() => h.manager.state.phase === 'idle', 'giving up', 2000);
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: expect.stringContaining('could not get it back') });
  });

  const ENDINGS = { ENDED: 'has ended', SESSION_EXPIRED: 'reached its end', HOST_GONE: 'away for too long', REPLACED: 'took over', POLICY: 'refused this computer', TOO_LARGE: 'too large' } as const;
  for (const [name, reason] of Object.entries(ENDINGS))
    it(`ends the session without reconnecting when the relay closes with ${name}`, async () => {
      const h = host();
      const { socket } = await opened(h);
      socket.drop(LIVE_CLOSE_CODES[name as keyof typeof ENDINGS]);
      expect(h.manager.state).toEqual({ phase: 'idle', lastError: expect.stringContaining(reason) });
      await wait(40);
      expect(h.sockets.length).toBe(1);
    });
});

describe('ending', () => {
  it('asks the relay to end the room and waits for the relay to close the connection', async () => {
    const h = host();
    const { socket, run } = await opened(h);
    const stopping = tracked(h.manager.stop(run));
    expect(h.manager.state.phase).toBe('stopping');
    expect(socket.sent.at(-1)).toEqual({ type: 'room:end' });
    await wait(30);
    expect(stopping.settled).toBe(false);
    socket.drop(LIVE_CLOSE_CODES.ENDED);
    await until(() => stopping.settled, 'the stop');
    expect(stopping.value).toEqual({ ok: true });
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
  });

  it('lets go at the deadline when the relay does not confirm the end', async () => {
    const h = host({ timings: { stopMs: 150 } });
    const { socket, run } = await opened(h);
    const stopping = tracked(h.manager.stop(run));
    await wait(50);
    expect(stopping.settled).toBe(false);
    await until(() => stopping.settled, 'the stop', 2000);
    expect(socket.closedWith).toBe(1000);
    expect(h.manager.state.phase).toBe('idle');
  });

  it('sends room:end straight after room:create when stopped before the relay answers', async () => {
    const h = host();
    const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    const socket = await until(() => h.sockets[0], 'the host socket');
    socket.open();
    const stopping = h.manager.end();
    expect(socket.types()).toEqual(['room:create', 'room:end']);
    expect(await starting).toMatchObject({ ok: false });
    // The relay's answers to the create still arrive; nothing more is sent for them.
    socket.receive(ready(newRoomId()));
    socket.receive({ type: 'room:roster', participants: [] });
    expect(socket.types()).toEqual(['room:create', 'room:end']);
    socket.drop(LIVE_CLOSE_CODES.ENDED);
    await stopping;
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
  });

  it('takes a dropped room back only to end it, when stopped while reconnecting', async () => {
    // Backoff long enough that the stop comes first.
    const h = host({ timings: { backoffBaseMs: 10_000, backoffMaxMs: 10_000 } });
    const { socket, roomId, publicKey, run } = await opened(h);
    socket.drop(1006);
    const stopping = h.manager.stop(run);
    const again = await until(() => h.sockets[1], 'the reconnect made to end the room');
    again.open();
    const nonce = newNonce();
    again.receive({ type: 'host:challenge', roomId, nonce });
    const proof = await until(() => sentOf(again, 'host:proof'), 'the proof');
    expect(await verifyHostChallenge(publicKey, { roomId, nonce }, proof.signature)).toBe(true);
    again.receive(ready(roomId));
    expect(again.sent.at(-1)).toEqual({ type: 'room:end' });
    // Never shown as running again on the way out, and nobody waiting is announced.
    again.receive({ type: 'room:roster', participants: [{ guestId: 'g9', displayName: 'Zed', status: 'pending' }] });
    expect(h.manager.state.phase).toBe('stopping');
    expect(h.requests).toEqual([]);
    again.drop(LIVE_CLOSE_CODES.ENDED);
    expect(await stopping).toEqual({ ok: true });
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
    expect(h.sockets.length).toBe(2);
  });

  it('takes the room back again to end it when the connection drops before the relay confirms', async () => {
    const h = host();
    const { socket, roomId, publicKey, run } = await opened(h);
    const stopping = tracked(h.manager.stop(run));
    expect(socket.sent.at(-1)).toEqual({ type: 'room:end' });
    // Dropped by the network, not closed by the relay ending the room: the end may never have arrived.
    socket.drop(1006);
    const again = await until(() => h.sockets[1], 'a reconnect to end the room');
    again.open();
    const nonce = newNonce();
    again.receive({ type: 'host:challenge', roomId, nonce });
    const proof = await until(() => sentOf(again, 'host:proof'), 'the proof');
    expect(await verifyHostChallenge(publicKey, { roomId, nonce }, proof.signature)).toBe(true);
    again.receive(ready(roomId));
    expect(again.sent.at(-1)).toEqual({ type: 'room:end' });
    expect(stopping.settled).toBe(false);
    again.drop(LIVE_CLOSE_CODES.ENDED);
    await until(() => stopping.settled, 'the stop');
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
  });

  it('waits for a connection that is already closing to say how, and ends the room on another only if it must', async () => {
    for (const [code, reclaims] of [[1006, true], [LIVE_CLOSE_CODES.ENDED, false]] as const) {
      const h = host();
      const { socket, roomId, run } = await opened(h);
      // Closing, its close event not yet delivered.
      socket.readyState = 2;
      h.timings.stopMs = 300;
      const stopping = h.manager.stop(run);
      expect(sentOf(socket, 'room:end')).toBeUndefined();
      await wait(30);
      expect(h.sockets.length).toBe(1);
      socket.drop(code);
      if (reclaims) expect(new URL((await until(() => h.sockets[1], 'a reconnect to end the room')).url).pathname).toBe(`/s/${roomId}/ws`);
      expect(await stopping).toEqual({ ok: true });
      expect(h.sockets.length).toBe(reclaims ? 2 : 1);
    }
  });

  it('keeps trying to take the room back to end it when a connection cannot even be made, until the deadline', async () => {
    const h = host();
    const { socket, run } = await opened(h);
    socket.drop(1006);
    let tries = 0;
    h.manager.createSocket = () => {
      tries++;
      throw new Error('offline');
    };
    h.timings.stopMs = 200;
    const at = Date.now();
    expect(await h.manager.stop(run)).toEqual({ ok: true });
    expect(tries).toBeGreaterThan(1);
    expect(Date.now() - at).toBeLessThan(1000);
  });
});
