import { afterEach, describe, expect, it } from 'vitest';
import type { LiveHostState, LiveJoinRequest, LivePresence, LiveRun } from '../../src/shared/api';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { newNonce, newRoomId, verifyHostChallenge } from '../../src/shared/live/crypto';
import type { GuestRole } from '../../src/shared/live/limits';
import type { FrameOf, Participant, Presence } from '../../src/shared/live/messages';
import type { LiveApplyResult, LiveProjectSnapshot } from '../../src/shared/live/snapshot';
import { resolveRelayUrl, type ResolvedRelayUrl } from '../../src/shared/live/relay-url';
import { editTarget, GRANT_CLOCK_MARGIN_MS, GUEST_SNAPSHOT_BURST, LiveHostManager, MAX_GUEST_EDITS_IN_FLIGHT, MAX_SOCKET_BACKLOG_BYTES, type LiveGuestEdit, type LiveHostContext, type LiveHostTimings } from '../../src/main/live/host';

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
const ANN: Participant = { guestId: 'g1', displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true };
const managers: LiveHostManager[] = [];
afterEach(async () => {
  // No relay answers a test's last room:end: each is let go at a short deadline.
  for (const m of managers.splice(0)) {
    (m as unknown as { timings: LiveHostTimings }).timings.stopMs = 20;
    await m.end();
  }
});

function host(opts: { timings?: Partial<LiveHostTimings>; relay?: () => Promise<ResolvedRelayUrl>; preview?: { port: number } | null; publishing?: () => boolean } & Pick<LiveHostContext, 'guestSnapshot' | 'applyGuest'> = {}) {
  const sockets: FakeSocket[] = [];
  const states: LiveHostState[] = [];
  const requests: LiveJoinRequest[] = [];
  const presence: LivePresence[] = [];
  const manager = new LiveHostManager(
    {
      opening: () => ({ workspaceKey: '/sites/acme#1', projectName: 'Acme' }),
      preview: () => opts.preview ?? null,
      relay: opts.relay ?? (async () => resolveRelayUrl({ env: RELAY })),
      publishing: opts.publishing,
      guestSnapshot: opts.guestSnapshot,
      applyGuest: opts.applyGuest,
      emit: (channel, payload) =>
        void (channel === 'live:state' ? states.push(payload as LiveHostState) : channel === 'live:presence' ? presence.push(payload as LivePresence) : requests.push(payload as LiveJoinRequest))
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
  return { manager, sockets, states, requests, presence, timings };
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
const ready = (roomId: string, now = Date.now(), extra: Partial<{ expiresAt: number; locked: boolean }> = {}): FrameOf<'relay-to-host'> => ({ type: 'room:ready', version: 2, roomId, startedAt: now, expiresAt: extra.expiresAt ?? now + 2 * 3600_000, locked: extra.locked ?? false, now });

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
  expect(sentOf(socket, 'host:reconnect')).toEqual({ type: 'host:reconnect', version: 2, roomId });
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

// ---------------------------------------------------------------------------
// Guests' editor calls (#765)

const SNAPSHOT: LiveProjectSnapshot = { revision: 3, state: {} as LiveProjectSnapshot['state'], readOnly: false, aiBusy: false, runtime: { state: 'ready' } };
const EDIT = { operations: [{ type: 'node.setContent', owner: { kind: 'page', id: 'pg_home' }, nodeId: 'n_title', field: 'text', value: 'Hello' }] };
/** A layout edit: one a collaborator may make, and a copy editor may not. */
const LAYOUT = { operations: [{ type: 'node.remove', owner: { kind: 'page', id: 'pg_home' }, nodeId: 'n_title' }] };
const HERE: Presence = { pageId: 'pg_home', viewportWidth: 1280, selection: null, previewPath: '/' };

/**
 * A host whose editor answers guests: a snapshot (the same object until `env.snapshot` is replaced), and edits that
 * are held until the test lets each one go, as a busy write queue would hold them, then checked as the editor checks.
 */
function editor(opts: { timings?: Partial<LiveHostTimings> } = {}) {
  const env = { snapshot: SNAPSHOT as LiveProjectSnapshot | null };
  const edits: Array<{ guest: LiveGuestEdit; batch: unknown; release: () => void; result: Promise<LiveApplyResult> }> = [];
  const h = host({
    ...opts,
    guestSnapshot: () => env.snapshot,
    applyGuest: (_opening, guest, batch) => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const result = held.then((): LiveApplyResult => {
        const refused = guest.check();
        return refused ? { ok: false, error: refused } : { ok: true, revision: 4, results: [{ nodeId: 'n_new' }] };
      });
      edits.push({ guest, batch, release, result });
      return result;
    }
  });
  return { ...h, env, edits };
}

/** Open a room with Ann waiting, and let her in as the host does, with the relay confirming it. */
async function letIn(h: ReturnType<typeof editor>, role: GuestRole = 'collaborator', guestExpiresAt: number | null = null) {
  const o = await opened(h, [{ guestId: 'g1', displayName: 'Ann', status: 'pending' }]);
  expect(h.manager.admit(o.run, 'g1', role, guestExpiresAt)).toEqual({ ok: true });
  o.socket.receive(roster(role, guestExpiresAt));
  return o;
}

const admittedAs = (guestId: string, displayName: string, role: GuestRole, guestExpiresAt: number | null = null, connected = true): Participant => ({ guestId, displayName, status: 'admitted', role, guestExpiresAt, colorSlot: 0, connected });
const roster = (role: GuestRole, guestExpiresAt: number | null = null): FrameOf<'relay-to-host'> => ({ type: 'room:roster', participants: [admittedAs('g1', 'Ann', role, guestExpiresAt)] });
const call = (socket: FakeSocket, requestId: string, method: 'project.snapshot' | 'project.apply', args: unknown[] = []) => socket.receive({ type: 'rpc:request', guestId: 'g1', requestId, method, args });
const answerTo = (socket: FakeSocket, requestId: string) => until(() => socket.sent.find((f) => f.type === 'rpc:response' && f.requestId === requestId) as Extract<FrameOf<'host-to-relay'>, { type: 'rpc:response' }> | undefined, `the answer to ${requestId}`);

describe('guests’ editor calls', () => {
  it('gives a viewer the project, and refuses its edits before the editor sees them', async () => {
    const h = editor();
    const { socket } = await letIn(h, 'viewer');
    call(socket, 'q1', 'project.snapshot');
    expect(await answerTo(socket, 'q1')).toEqual({ type: 'rpc:response', guestId: 'g1', requestId: 'q1', method: 'project.snapshot', ok: true, result: SNAPSHOT });
    call(socket, 'q2', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.edits).toEqual([]);
  });

  it('makes a collaborator’s edit with exactly the batch that was checked, naming the guest', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    call(socket, 'q1', 'project.apply', [{ ...EDIT, expectedRevision: 3, label: 'Edit text' }]);
    const edit = await until(() => h.edits[0], 'the edit');
    expect(edit.guest).toMatchObject({ guestId: 'g1', displayName: 'Ann' });
    expect(edit.batch).toEqual({ operations: EDIT.operations, expectedRevision: 3, label: 'Edit text' });
    edit.release();
    expect(await answerTo(socket, 'q1')).toEqual({ type: 'rpc:response', guestId: 'g1', requestId: 'q1', method: 'project.apply', ok: true, result: { revision: 4, results: [{ nodeId: 'n_new' }] } });
  });

  it('refuses code, host-only settings and anything extra a guest adds, before the editor sees them', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    const refusals: Array<[string, unknown[]]> = [
      ['q1', [{ operations: [{ type: 'component.updateSource', definitionId: 'cmp_hero', source: '<script>alert(1)</script>' }] }]],
      ['q2', [{ operations: [{ type: 'component.createCode', name: 'X', source: '<p>x</p>' }] }]],
      ['q3', [{ operations: [{ type: 'site.update', baseUrl: 'https://evil.example' }] }]],
      ['q4', [EDIT, { opening: '/sites/other#2' }]],
      ['q5', [{ ...EDIT, opening: '/sites/other#2' }]],
      ['q6', [{ ...EDIT, coalesceKey: 'k' }]]
    ];
    for (const [id, args] of refusals) call(socket, id, 'project.apply', args);
    for (const [id] of refusals) expect((await answerTo(socket, id)).ok, id).toBe(false);
    call(socket, 'q7', 'project.snapshot', [{ include: 'dir' }]);
    expect(await answerTo(socket, 'q7')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    // A method no guest may call never parses as a forwarded call: dropped, with nothing run.
    socket.receive({ type: 'rpc:request', guestId: 'g1', requestId: 'q8', method: 'ai.chat', args: [] } as never);
    await wait(10);
    expect(socket.sent.some((f) => f.type === 'rpc:response' && f.requestId === 'q8')).toBe(false);
    expect(h.edits).toEqual([]);
  });

  it('answers nobody it has not let in, and nobody it removed, whatever the relay’s roster still says', async () => {
    // Listed as admitted, but never let in by this host.
    const stranger = editor();
    const { socket } = await opened(stranger, [ANN]);
    call(socket, 'q1', 'project.snapshot');
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    // Removed, and the relay has not said so yet.
    const h = editor();
    const o = await letIn(h);
    expect(h.manager.kick(o.run, 'g1')).toEqual({ ok: true });
    call(o.socket, 'q2', 'project.snapshot');
    expect(await answerTo(o.socket, 'q2')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    call(o.socket, 'q3', 'project.apply', [EDIT]);
    expect(await answerTo(o.socket, 'q3')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.edits).toEqual([]);
  });

  it('takes a role away at once, before the relay confirms it, and gives one back only once it has', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    expect(h.manager.setRole(run, 'g1', 'viewer')).toEqual({ ok: true });
    call(socket, 'q1', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    // A roster the relay sent before it had the change still shows a collaborator: still refused.
    socket.receive(roster('collaborator'));
    call(socket, 'q2', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    socket.receive(roster('viewer'));
    expect(h.manager.setRole(run, 'g1', 'collaborator')).toEqual({ ok: true });
    call(socket, 'q3', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q3')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    socket.receive(roster('collaborator'));
    call(socket, 'q4', 'project.apply', [EDIT]);
    (await until(() => h.edits[0], 'the edit')).release();
    expect(await answerTo(socket, 'q4')).toMatchObject({ ok: true });
  });

  it('refuses an edit sent before a demotion the host has since undone', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    // Ann's edit is on its way when the host makes her a viewer and then a collaborator again: it arrives before the
    // relay confirms either, so it may have been forwarded before the first.
    expect(h.manager.setRole(run, 'g1', 'viewer')).toEqual({ ok: true });
    expect(h.manager.setRole(run, 'g1', 'collaborator')).toEqual({ ok: true });
    call(socket, 'q1', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    socket.receive(roster('viewer'));
    socket.receive(roster('collaborator'));
    call(socket, 'q2', 'project.apply', [EDIT]);
    (await until(() => h.edits[0], 'the edit')).release();
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: true });
  });

  it('refuses an edit still waiting its turn when the guest is made a viewer, removed or runs out of time', async () => {
    for (const change of ['demote', 'demote and restore', 'kick', 'expire'] as const) {
      const h = editor();
      const now = Date.now();
      const { socket, run } = await letIn(h, 'collaborator', change === 'expire' ? now + GRANT_CLOCK_MARGIN_MS + 150 : null);
      call(socket, 'q1', 'project.apply', [EDIT]);
      const edit = await until(() => h.edits[0], 'the edit');
      expect(edit.guest.check()).toBeNull();
      if (change === 'kick') h.manager.kick(run, 'g1');
      else if (change === 'expire') await wait(200);
      else {
        h.manager.setRole(run, 'g1', 'viewer');
        socket.receive(roster('viewer'));
        if (change === 'demote and restore') {
          h.manager.setRole(run, 'g1', 'collaborator');
          socket.receive(roster('collaborator'));
        }
      }
      edit.release();
      expect(await answerTo(socket, 'q1'), change).toMatchObject({ ok: false, error: { code: change === 'expire' ? 'EXPIRED' : 'PERMISSION_DENIED' } });
    }
  });

  it('refuses an edit whose connection dropped while it waited', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    call(socket, 'q1', 'project.apply', [EDIT]);
    const edit = await until(() => h.edits[0], 'the edit');
    socket.drop(1006);
    edit.release();
    expect(await edit.result).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });

  it('holds a guest to a few edits at once and a few snapshots in a burst', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    for (let i = 0; i < MAX_GUEST_EDITS_IN_FLIGHT; i++) call(socket, `e${i}`, 'project.apply', [EDIT]);
    call(socket, 'over', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'over')).toMatchObject({ ok: false, error: { code: 'BUSY', recoverable: true } });
    expect(h.edits.length).toBe(MAX_GUEST_EDITS_IN_FLIGHT);
    for (const e of h.edits) e.release();
    await answerTo(socket, `e${MAX_GUEST_EDITS_IN_FLIGHT - 1}`);
    call(socket, 'again', 'project.apply', [EDIT]);
    (await until(() => h.edits[MAX_GUEST_EDITS_IN_FLIGHT], 'the next edit')).release();
    expect(await answerTo(socket, 'again')).toMatchObject({ ok: true });
    for (let i = 0; i < GUEST_SNAPSHOT_BURST; i++) call(socket, `s${i}`, 'project.snapshot');
    call(socket, 'more', 'project.snapshot');
    for (let i = 0; i < GUEST_SNAPSHOT_BURST; i++) expect((await answerTo(socket, `s${i}`)).ok).toBe(true);
    expect(await answerTo(socket, 'more')).toMatchObject({ ok: false, error: { code: 'BUSY', recoverable: true } });
  });

  it('refuses a snapshot too large for one frame, and announces such a change by its revision', async () => {
    const h = editor({ timings: { eventsMs: 5 } });
    const { socket } = await letIn(h);
    h.env.snapshot = { ...SNAPSHOT, revision: 9, state: { pad: 'x'.repeat(800 * 1024) } as never };
    call(socket, 'q1', 'project.snapshot');
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    h.manager.editorChanged();
    const event = await until(() => socket.sent.find((f) => f.type === 'rpc:event' && f.event === 'project:changed'), 'the event');
    expect(event).toEqual({ type: 'rpc:event', event: 'project:changed', payload: { kind: 'too-large', revision: 9 } });
  });

  it('sends guests each change once, however many come together, and the preview’s state when it changes', async () => {
    const h = editor({ timings: { eventsMs: 20 } });
    const { socket } = await letIn(h, 'viewer');
    const events = () => socket.sent.filter((f) => f.type === 'rpc:event');
    for (let i = 0; i < 5; i++) h.manager.editorChanged();
    await until(() => events().length === 2, 'the first events');
    expect(events()).toEqual([
      { type: 'rpc:event', event: 'runtime:status', payload: { state: 'ready' } },
      { type: 'rpc:event', event: 'project:changed', payload: { kind: 'snapshot', snapshot: SNAPSHOT } }
    ]);
    // Nothing a guest sees changed: nothing is sent.
    h.manager.editorChanged();
    await wait(60);
    expect(events().length).toBe(2);
    h.env.snapshot = { ...SNAPSHOT, revision: 4 };
    h.manager.editorChanged();
    await until(() => events().length === 3, 'the next change');
    expect(events()[2]).toMatchObject({ event: 'project:changed', payload: { kind: 'snapshot', snapshot: { revision: 4 } } });
  });

  it('sends again what it decided about a guest when the commands may have been lost with the connection', async () => {
    const h = editor();
    const { socket, roomId, publicKey, run } = await letIn(h);
    expect(h.manager.kick(run, 'g1')).toEqual({ ok: true });
    socket.drop(1006);
    const next = await until(() => h.sockets[1], 'the reconnect');
    // The relay never had the kick: its roster still lists her.
    await reclaimed(next, roomId, publicKey);
    expect(next.sent.filter((f) => f.type === 'guest:kick')).toEqual([{ type: 'guest:kick', guestId: 'g1' }]);
  });

  it('shows the editor where collaborators are, and nobody else', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    expect(h.presence.at(-1)).toEqual({ workspaceKey: run.workspaceKey, runId: run.runId, guests: { g1: HERE }, spotlights: {}, activity: {} });
    // Made a viewer: gone from the editor at once, and what a viewer sends is not shown.
    h.manager.setRole(run, 'g1', 'viewer');
    expect(h.presence.at(-1)).toEqual({ workspaceKey: run.workspaceKey, runId: run.runId, guests: {}, spotlights: {}, activity: {} });
    const shown = h.presence.length;
    socket.receive(roster('viewer'));
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    // Nor the presence of someone who was never let in.
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g9' }, presence: HERE });
    expect(h.presence.length).toBe(shown);
  });

  it('answers nothing for a guest let in before the relay has confirmed it', async () => {
    const h = editor();
    const { socket, run } = await opened(h, [{ guestId: 'g1', displayName: 'Ann', status: 'pending' }]);
    expect(h.manager.admit(run, 'g1', 'collaborator')).toEqual({ ok: true });
    call(socket, 'q1', 'project.snapshot');
    call(socket, 'q2', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(h.edits).toEqual([]);
  });

  it('ends a guest’s access as the host shortened it, before the relay confirms, a little before the relay would', async () => {
    const h = editor();
    const { socket, run, state } = await letIn(h);
    call(socket, 'q1', 'project.apply', [EDIT]);
    const edit = await until(() => h.edits[0], 'the edit');
    expect(h.manager.setGuestExpiry(run, 'g1', Date.now() + state.relayClockOffsetMs + GRANT_CLOCK_MARGIN_MS + 150)).toEqual({ ok: true });
    expect(edit.guest.check()).toBeNull();
    await wait(250);
    edit.release();
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'EXPIRED' } });
  });

  it('holds a guest to every demotion still unconfirmed, however many changes follow', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    for (const role of ['viewer', 'collaborator', 'viewer', 'collaborator'] as const) h.manager.setRole(run, 'g1', role);
    // The relay confirms the first pair only.
    socket.receive(roster('viewer'));
    socket.receive(roster('collaborator'));
    call(socket, 'q1', 'project.apply', [EDIT]);
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    socket.receive(roster('viewer'));
    socket.receive(roster('collaborator'));
    call(socket, 'q2', 'project.apply', [EDIT]);
    (await until(() => h.edits[0], 'the edit')).release();
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: true });
  });

  it('holds a copy editor to its own edits, and hands the editor each with the role it was checked as', async () => {
    const h = editor();
    const { socket } = await letIn(h, 'copy-editor');
    call(socket, 'q1', 'project.apply', [LAYOUT]);
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    expect(h.edits).toEqual([]);
    call(socket, 'q2', 'project.apply', [EDIT]);
    const edit = await until(() => h.edits[0], 'the edit');
    expect(edit.guest).toMatchObject({ guestId: 'g1', displayName: 'Ann', role: 'copy-editor' });
    edit.release();
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: true });
  });

  it('never lands a layout edit asked for before a collaborator was made a copy editor, though made a collaborator again', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    // Ann's layout edit is waiting its turn when the host makes her a copy editor, then a collaborator again.
    call(socket, 'q1', 'project.apply', [LAYOUT]);
    const queued = await until(() => h.edits[0], 'the queued edit');
    expect(queued.guest.role).toBe('collaborator');
    expect(h.manager.setRole(run, 'g1', 'copy-editor')).toEqual({ ok: true });
    expect(h.manager.setRole(run, 'g1', 'collaborator')).toEqual({ ok: true });
    // One arriving before the relay confirms either may have been forwarded before the first: a copy editor's.
    call(socket, 'q2', 'project.apply', [LAYOUT]);
    expect(await answerTo(socket, 'q2')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    // A roster the relay sent before it had either still shows a collaborator: still a copy editor's.
    socket.receive(roster('collaborator'));
    call(socket, 'q3', 'project.apply', [LAYOUT]);
    expect(await answerTo(socket, 'q3')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    // Meanwhile her copy edits are made, as a copy editor's.
    call(socket, 'q4', 'project.apply', [EDIT]);
    const copy = await until(() => h.edits[1], 'the copy edit');
    expect(copy.guest.role).toBe('copy-editor');
    socket.receive(roster('copy-editor'));
    socket.receive(roster('collaborator'));
    // Both confirmed, and Ann a collaborator again: the edit asked for before the demotion still lands nothing.
    queued.release();
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    copy.release();
    expect(await answerTo(socket, 'q4')).toMatchObject({ ok: true });
    // Her layout edits from now on are a collaborator's.
    call(socket, 'q5', 'project.apply', [LAYOUT]);
    const later = await until(() => h.edits[2], 'the later edit');
    expect(later.guest.role).toBe('collaborator');
    later.release();
    expect(await answerTo(socket, 'q5')).toMatchObject({ ok: true });
  });

  it('keeps a copy editor’s waiting edit to its grant when made a collaborator, and refuses it when made a viewer', async () => {
    for (const role of ['collaborator', 'viewer'] as const) {
      const h = editor();
      const { socket, run } = await letIn(h, 'copy-editor');
      call(socket, 'q1', 'project.apply', [EDIT]);
      const edit = await until(() => h.edits[0], 'the edit');
      h.manager.setRole(run, 'g1', role);
      socket.receive(roster(role));
      // The editor still holds it to what a copy editor may change.
      expect(edit.guest.role).toBe('copy-editor');
      edit.release();
      expect(await answerTo(socket, 'q1'), role).toMatchObject(role === 'collaborator' ? { ok: true } : { ok: false, error: { code: 'PERMISSION_DENIED' } });
    }
  });

  it('refuses a waiting edit when the relay says the guest holds less than it was asked as, whatever the host decided', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    call(socket, 'q1', 'project.apply', [LAYOUT]);
    const edit = await until(() => h.edits[0], 'the edit');
    // A roster that lists Ann as a copy editor, which the host never asked for.
    socket.receive(roster('copy-editor'));
    edit.release();
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('stops showing where a collaborator is once made a copy editor', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    expect(h.presence.at(-1)).toEqual({ workspaceKey: run.workspaceKey, runId: run.runId, guests: { g1: HERE } });
    h.manager.setRole(run, 'g1', 'copy-editor');
    expect(h.presence.at(-1)).toEqual({ workspaceKey: run.workspaceKey, runId: run.runId, guests: {} });
    const shown = h.presence.length;
    socket.receive(roster('copy-editor'));
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    expect(h.presence.length).toBe(shown);
  });

  it('sends the project only to guests it still lets in, when the relay lists one it has removed', async () => {
    const h = editor({ timings: { eventsMs: 5 } });
    const { socket, run } = await opened(h, [
      { guestId: 'g1', displayName: 'Ann', status: 'pending' },
      { guestId: 'g2', displayName: 'Bea', status: 'pending' }
    ]);
    h.manager.admit(run, 'g1', 'viewer');
    h.manager.admit(run, 'g2', 'viewer');
    socket.receive({ type: 'room:roster', participants: [admittedAs('g1', 'Ann', 'viewer'), admittedAs('g2', 'Bea', 'viewer')] });
    expect(h.manager.kick(run, 'g2')).toEqual({ ok: true });
    h.manager.editorChanged();
    await until(() => socket.sent.some((f) => f.type === 'rpc:event' && f.event === 'project:changed'), 'the event');
    const events = socket.sent.filter((f) => f.type === 'rpc:event');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e).toMatchObject({ guestId: 'g1' });
  });

  it('tells guests each time the preview’s state changes', async () => {
    const h = editor({ timings: { eventsMs: 5 } });
    const { socket } = await letIn(h, 'viewer');
    const runtime = () => socket.sent.filter((f) => f.type === 'rpc:event' && f.event === 'runtime:status');
    h.manager.editorChanged();
    await until(() => runtime().length === 1, 'the first status');
    h.env.snapshot = { ...SNAPSHOT, runtime: { state: 'starting' } };
    h.manager.editorChanged();
    await until(() => runtime().length === 2, 'the next status');
    expect(runtime()[1]).toEqual({ type: 'rpc:event', event: 'runtime:status', payload: { state: 'starting' } });
  });

  it('sends again a role and an end of access the relay may never have had', async () => {
    const h = editor();
    const { socket, roomId, publicKey, run, now } = await letIn(h);
    const until2 = now + 60 * 60_000;
    h.manager.setRole(run, 'g1', 'viewer');
    h.manager.setGuestExpiry(run, 'g1', until2);
    socket.drop(1006);
    const next = await until(() => h.sockets[1], 'the reconnect');
    // The relay still has Ann as a collaborator with no end of her own.
    next.open();
    const nonce = newNonce();
    next.receive({ type: 'host:challenge', roomId, nonce });
    await until(() => sentOf(next, 'host:proof'), 'the proof');
    next.receive(ready(roomId));
    next.receive(roster('collaborator'));
    expect(next.sent.filter((f) => f.type === 'guest:set-role' || f.type === 'guest:set-expiry')).toEqual([
      { type: 'guest:set-role', guestId: 'g1', role: 'viewer' },
      { type: 'guest:set-expiry', guestId: 'g1', guestExpiresAt: until2 }
    ]);
    void publicKey;
    // Until it confirms, she is a viewer.
    call(next, 'q1', 'project.apply', [EDIT]);
    expect(await answerTo(next, 'q1')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('never lets in again a guest it removed, waiting or not', async () => {
    const h = editor();
    const { socket, roomId, publicKey, run } = await opened(h, [{ guestId: 'g1', displayName: 'Ann', status: 'pending' }]);
    expect(h.manager.kick(run, 'g1')).toEqual({ ok: true });
    expect(h.manager.admit(run, 'g1', 'viewer')).toMatchObject({ ok: false });
    socket.drop(1006);
    const next = await until(() => h.sockets[1], 'the reconnect');
    next.open();
    const nonce = newNonce();
    next.receive({ type: 'host:challenge', roomId, nonce });
    await until(() => sentOf(next, 'host:proof'), 'the proof');
    next.receive(ready(roomId));
    next.receive({ type: 'room:roster', participants: [{ guestId: 'g1', displayName: 'Ann', status: 'pending' }] });
    expect(next.sent.filter((f) => f.type === 'guest:kick')).toEqual([{ type: 'guest:kick', guestId: 'g1' }]);
    void publicKey;
  });
});

describe('spotlights, edits and connections in the editor (#768)', () => {
  const spotlight = { previewPath: '/about/', target: { owner: { kind: 'page' as const, id: 'pg_home' }, instancePath: [], nodeId: 'n_title' }, x: 0.5, y: 0.25 };
  const pointed = (guestId = 'g1'): FrameOf<'relay-to-host'> => ({ type: 'spotlight:pointed', guestId, spotlight });
  const last = (h: { presence: LivePresence[] }) => h.presence.at(-1)!;

  it('shows a spotlight from a guest let in, a viewer too, for a while, then takes it off', async () => {
    const h = editor({ timings: { spotlightMs: 60 } });
    const { socket, run } = await letIn(h, 'viewer');
    socket.receive(pointed());
    expect(last(h)).toMatchObject({ workspaceKey: run.workspaceKey, runId: run.runId, guests: {}, spotlights: { g1: { seq: expect.any(Number), spotlight } }, activity: {} });
    // A newer one replaces it, under a new number, so the editor draws it from its start.
    const first = last(h).spotlights.g1.seq;
    socket.receive(pointed());
    expect(last(h).spotlights.g1.seq).toBeGreaterThan(first);
    await until(() => Object.keys(last(h).spotlights).length === 0, 'the spotlight to go');
    // Nobody the relay does not list as let in is shown.
    const shown = h.presence.length;
    socket.receive(pointed('g9'));
    expect(h.presence.length).toBe(shown);
  });

  it('takes a guest’s spotlight and presence off at once when it is removed', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    socket.receive(pointed());
    expect(Object.keys(last(h).spotlights)).toEqual(['g1']);
    h.manager.kick(run, 'g1');
    expect(last(h)).toEqual({ workspaceKey: run.workspaceKey, runId: run.runId, guests: {}, spotlights: {}, activity: {} });
    // What arrives from it before the relay has removed it is not shown.
    const shown = h.presence.length;
    socket.receive(pointed());
    expect(h.presence.length).toBe(shown);
  });

  it('keeps a demoted guest’s spotlight but not where it was, nor its edit', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    call(socket, 'q1', 'project.apply', [EDIT]);
    (await until(() => h.edits[0], 'the edit')).release();
    await answerTo(socket, 'q1');
    socket.receive(pointed());
    expect(Object.keys(last(h).activity)).toEqual(['g1']);
    h.manager.setRole(run, 'g1', 'viewer');
    expect(last(h).guests).toEqual({});
    expect(last(h).activity).toEqual({});
    expect(Object.keys(last(h).spotlights)).toEqual(['g1']);
  });

  it('takes each spotlight and edit off at its own time, one after another', async () => {
    const h = editor({ timings: { spotlightMs: 400, activityMs: 40 } });
    const { socket } = await letIn(h);
    socket.receive(pointed());
    call(socket, 'q1', 'project.apply', [EDIT]);
    (await until(() => h.edits[0], 'the edit')).release();
    await answerTo(socket, 'q1');
    expect(Object.keys(last(h).activity)).toEqual(['g1']);
    await until(() => Object.keys(last(h).activity).length === 0, 'the edit’s cue to go');
    // The spotlight, due later, is still shown, and goes at its own time.
    expect(Object.keys(last(h).spotlights)).toEqual(['g1']);
    await until(() => Object.keys(last(h).spotlights).length === 0, 'the spotlight to go');
  });

  it('tells an editor that starts following the session, a reloaded one too, where everyone is', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    h.manager.setPresence(run, HERE);
    const shown = h.presence.length;
    // The same place again, as a reloaded editor says it.
    expect(h.manager.setPresence(run, HERE)).toEqual({ ok: true });
    expect(h.presence.length).toBe(shown + 1);
    expect(last(h).guests).toEqual({ g1: HERE });
  });

  it('stops showing a guest whose connection dropped, until it is back and says where it is again', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    socket.receive(pointed());
    socket.receive({ type: 'room:roster', participants: [admittedAs('g1', 'Ann', 'collaborator', null, false)] });
    expect(last(h)).toEqual(expect.objectContaining({ guests: {}, spotlights: {}, activity: {} }));
    const shown = h.presence.length;
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    socket.receive(pointed());
    expect(h.presence.length).toBe(shown);
    socket.receive({ type: 'room:roster', participants: [admittedAs('g1', 'Ann', 'collaborator', null, true)] });
    socket.receive({ type: 'presence:changed', participant: { kind: 'guest', guestId: 'g1' }, presence: HERE });
    expect(last(h).guests).toEqual({ g1: HERE });
  });

  it('shows a collaborator editing what its edit changed once the edit is made, and tells the other collaborators', async () => {
    const h = editor({ timings: { activityMs: 60 } });
    const { socket } = await letIn(h);
    call(socket, 'q1', 'project.apply', [EDIT]);
    const edit = await until(() => h.edits[0], 'the edit');
    // Nothing is shown while the edit waits its turn.
    expect(h.presence.some((p) => Object.keys(p.activity).length)).toBe(false);
    edit.release();
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: true });
    const target = { owner: { kind: 'page', id: 'pg_home' }, instancePath: [], nodeId: 'n_title' };
    expect(last(h).activity).toEqual({ g1: { seq: expect.any(Number), target } });
    expect(socket.sent.filter((f) => f.type === 'activity:edit')).toEqual([{ type: 'activity:edit', guestId: 'g1', target }]);
    await until(() => Object.keys(last(h).activity).length === 0, 'the edit’s cue to go');
  });

  it('shows no edit for a copy, whose operations name what it was copied from', async () => {
    const h = editor();
    const { socket } = await letIn(h);
    call(socket, 'q1', 'project.apply', [{ operations: [{ type: 'node.duplicate', owner: { kind: 'page', id: 'pg_home' }, nodeId: 'n_title' }] }]);
    (await until(() => h.edits[0], 'the edit')).release();
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: true });
    expect(h.presence.some((p) => Object.keys(p.activity).length)).toBe(false);
    expect(socket.sent.some((f) => f.type === 'activity:edit')).toBe(false);
  });

  it('shows nothing for an edit that was not made', async () => {
    const h = editor();
    const { socket, run } = await letIn(h);
    call(socket, 'q1', 'project.apply', [EDIT]);
    const edit = await until(() => h.edits[0], 'the edit');
    h.manager.setRole(run, 'g1', 'viewer');
    edit.release();
    expect(await answerTo(socket, 'q1')).toMatchObject({ ok: false });
    expect(h.presence.some((p) => Object.keys(p.activity).length)).toBe(false);
    expect(socket.sent.some((f) => f.type === 'activity:edit')).toBe(false);
  });

  it('names the one element a batch changed, and nothing for any other batch', () => {
    const op = (owner: { kind: string; id: string }, nodeId: string) => ({ type: 'node.setContent', owner, nodeId, field: 'text', value: 'x' });
    const home = { kind: 'page', id: 'pg_home' };
    expect(editTarget({ operations: [op(home, 'n1'), op(home, 'n1')] })).toEqual({ owner: home, instancePath: [], nodeId: 'n1' });
    expect(editTarget({ operations: [op({ kind: 'shell', id: 'header' }, 'n_logo')] })).toEqual({ owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: 'n_logo' });
    expect(editTarget({ operations: [op(home, 'n1'), op(home, 'n2')] })).toBeNull();
    expect(editTarget({ operations: [op(home, 'n1'), op({ kind: 'page', id: 'pg_about' }, 'n1')] })).toBeNull();
    expect(editTarget({ operations: [op({ kind: 'component', id: 'c_card' }, 'n1')] })).toBeNull();
    expect(editTarget({ operations: [{ type: 'site.setName', name: 'Acme' }] })).toBeNull();
    // A copy or a duplicate leaves the element it names as it was: no edit is shown for it at all.
    expect(editTarget({ operations: [{ ...op(home, 'n1'), type: 'node.copy', toOwner: { kind: 'page', id: 'pg_about' } }] })).toBeUndefined();
    expect(editTarget({ operations: [{ ...op(home, 'n1'), type: 'node.duplicate' }] })).toBeUndefined();
    expect(editTarget({ operations: [op(home, 'n1'), { ...op(home, 'n1'), type: 'node.duplicate' }] })).toBeUndefined();
    expect(editTarget({ operations: [{ type: 'page.update', pageId: 'pg_home', title: 'Home' }, { ...op(home, 'n1'), type: 'node.duplicate' }] })).toBeUndefined();
    expect(editTarget({ operations: [op({ kind: 'page', id: 'p'.repeat(129) }, 'n1')] })).toBeNull();
    expect(editTarget({ operations: [op(home, 'n'.repeat(129))] })).toBeNull();
    expect(editTarget({ operations: [] })).toBeNull();
    expect(editTarget(null)).toBeNull();
  });
});
