import { afterEach, describe, expect, it } from 'vitest';
import type { LiveHostState, LiveRun } from '../../src/shared/api';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { newNonce, newRoomId, verifyHostChallenge } from '../../src/shared/live/crypto';
import type { FrameOf } from '../../src/shared/live/messages';
import { resolveRelayUrl } from '../../src/shared/live/relay-url';
import { LiveHostManager, type LiveHostTimings } from '../../src/main/live/host';

/**
 * The host's live session manager against sockets the test drives frame by frame, for the orderings a real relay
 * cannot be made to produce on cue: answers that never come, challenges for the wrong room, frames from a connection
 * that has already dropped, and stopping while the room is being taken back.
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
}

const RELAY = 'http://relay.localhost:8787';
const managers: LiveHostManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.end();
});

function host(timings: Partial<LiveHostTimings> = {}) {
  const sockets: FakeSocket[] = [];
  const states: LiveHostState[] = [];
  const manager = new LiveHostManager(
    {
      opening: () => ({ workspaceKey: '/sites/acme#1', projectName: 'Acme' }),
      preview: () => null,
      relay: async () => resolveRelayUrl({ env: RELAY }),
      emit: (channel, payload) => void (channel === 'live:state' && states.push(payload as LiveHostState))
    },
    {
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      timings: { handshakeMs: 200, backoffBaseMs: 10, backoffMaxMs: 20, stopMs: 300, ...timings }
    }
  );
  managers.push(manager);
  return { manager, sockets, states };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(check: () => T | undefined | null | false, what: string, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(2);
  }
}

const sentOf = <T extends FrameOf<'host-to-relay'>['type']>(socket: FakeSocket, type: T) => socket.sent.find((f) => f.type === type) as Extract<FrameOf<'host-to-relay'>, { type: T }> | undefined;

/** Answer the room:create the manager sends on its first socket, as the relay would. */
async function opened(h: ReturnType<typeof host>) {
  const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
  const socket = await until(() => h.sockets[0], 'the host socket');
  socket.open();
  const create = sentOf(socket, 'room:create')!;
  const roomId = newRoomId();
  const now = Date.now();
  socket.receive({ type: 'room:ready', version: 1, roomId, startedAt: now, expiresAt: now + 2 * 3600_000, locked: false, now });
  socket.receive({ type: 'room:roster', participants: [{ guestId: 'g1', displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null }] });
  const result = await starting;
  if (!result.ok) throw new Error(result.message);
  const state = h.manager.state as Extract<LiveHostState, { phase: 'active' }>;
  const run: LiveRun = { workspaceKey: state.workspaceKey, runId: state.runId };
  return { socket, roomId, publicKey: create.publicKey, run, now };
}

/** Prove the host on a reconnect socket, as the relay would, checking its signature against the room's key. */
async function reclaimed(socket: FakeSocket, roomId: string, publicKey: string, now = Date.now()) {
  socket.open();
  expect(sentOf(socket, 'host:reconnect')).toEqual({ type: 'host:reconnect', version: 1, roomId });
  const nonce = newNonce();
  socket.receive({ type: 'host:challenge', roomId, nonce });
  const proof = await until(() => sentOf(socket, 'host:proof'), 'the proof');
  expect(await verifyHostChallenge(publicKey, { roomId, nonce }, proof.signature)).toBe(true);
  socket.receive({ type: 'room:ready', version: 1, roomId, startedAt: now, expiresAt: now + 2 * 3600_000, locked: false, now: Date.now() });
  socket.receive({ type: 'room:roster', participants: [{ guestId: 'g1', displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null }] });
}

describe('starting', () => {
  it('runs one session at a time', async () => {
    const h = host();
    await opened(h);
    expect(await h.manager.start({ opening: '/sites/acme#1', duration: '2h' })).toEqual({ ok: false, message: 'A live session is already running.' });
    expect(h.sockets.length).toBe(1);
  });

  it('fails a start the relay never answers, and tries no other room', async () => {
    const h = host({ handshakeMs: 30 });
    const result = await h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(RELAY) });
    expect(h.manager.state).toMatchObject({ phase: 'idle' });
    await wait(60);
    expect(h.sockets.length).toBe(1);
  });

  it('fails a start the relay refuses, with the relay’s reason', async () => {
    const h = host();
    const starting = h.manager.start({ opening: '/sites/acme#1', duration: '2h' });
    const socket = await until(() => h.sockets[0], 'the host socket');
    socket.open();
    socket.receive({ type: 'protocol:error', code: 'UNSUPPORTED_VERSION', message: 'This relay speaks another version.' });
    socket.drop(LIVE_CLOSE_CODES.POLICY);
    expect(await starting).toEqual({ ok: false, message: 'This relay speaks another version.' });
  });
});

describe('taking the room back', () => {
  it('reconnects on the room’s socket, proves itself with the session key, and carries on', async () => {
    const h = host();
    const { socket, roomId, publicKey } = await opened(h);
    socket.drop(1006);
    expect(h.manager.state.phase).toBe('reconnecting');
    const again = await until(() => h.sockets[1], 'a reconnect');
    expect(new URL(again.url).pathname).toBe(`/s/${roomId}/ws`);
    await reclaimed(again, roomId, publicKey);
    expect(h.manager.state).toMatchObject({ phase: 'active', roomId, participants: [{ guestId: 'g1', status: 'admitted' }] });
  });

  it('gives up on a reconnect that is never answered and tries again', async () => {
    const h = host({ handshakeMs: 30 });
    const { socket, roomId, publicKey } = await opened(h);
    socket.drop(1006);
    const silent = await until(() => h.sockets[1], 'the first reconnect');
    silent.open();
    // No challenge comes: the attempt is abandoned and another made.
    const next = await until(() => h.sockets[2], 'the second reconnect', 1000);
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
    await until(() => again.closedWith !== null, 'the connection given up');
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

  it('ends the session when the relay will not have this key back', async () => {
    const h = host();
    const { socket, roomId } = await opened(h);
    socket.drop(1006);
    const again = await until(() => h.sockets[1], 'a reconnect');
    again.open();
    again.receive({ type: 'protocol:error', code: 'AUTH_FAILED', message: 'The signature does not match this room’s host key.' });
    await until(() => h.manager.state.phase === 'idle', 'the session ended');
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: expect.stringContaining('did not accept') });
    await wait(40);
    expect(h.sockets.length).toBe(2);
    void roomId;
  });

  for (const [name, code] of Object.entries({ ENDED: LIVE_CLOSE_CODES.ENDED, SESSION_EXPIRED: LIVE_CLOSE_CODES.SESSION_EXPIRED, HOST_GONE: LIVE_CLOSE_CODES.HOST_GONE, REPLACED: LIVE_CLOSE_CODES.REPLACED, POLICY: LIVE_CLOSE_CODES.POLICY }))
    it(`ends the session without reconnecting when the relay closes with ${name}`, async () => {
      const h = host();
      const { socket } = await opened(h);
      socket.drop(code);
      expect(h.manager.state).toMatchObject({ phase: 'idle', lastError: expect.any(String) });
      await wait(40);
      expect(h.sockets.length).toBe(1);
    });
});

describe('ending', () => {
  it('asks the relay to end the room and waits for it to close the connection', async () => {
    const h = host();
    const { socket, run } = await opened(h);
    const stopping = h.manager.stop(run);
    expect(h.manager.state.phase).toBe('stopping');
    expect(socket.sent.at(-1)).toEqual({ type: 'room:end' });
    socket.drop(LIVE_CLOSE_CODES.ENDED);
    expect(await stopping).toEqual({ ok: true });
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
  });

  it('lets go after a moment when the relay does not confirm the end', async () => {
    const h = host({ stopMs: 30 });
    const { socket, run } = await opened(h);
    const at = Date.now();
    expect(await h.manager.stop(run)).toEqual({ ok: true });
    expect(Date.now() - at).toBeGreaterThanOrEqual(25);
    expect(socket.closedWith).toBe(1000);
    expect(h.manager.state.phase).toBe('idle');
  });

  it('takes a dropped room back only to end it, when stopped while reconnecting', async () => {
    // Backoff long enough that the stop comes first.
    const h = host({ backoffBaseMs: 10_000, backoffMaxMs: 10_000 });
    const { socket, roomId, publicKey, run } = await opened(h);
    socket.drop(1006);
    const stopping = h.manager.stop(run);
    const again = await until(() => h.sockets[1], 'the reconnect made to end the room');
    again.open();
    const nonce = newNonce();
    again.receive({ type: 'host:challenge', roomId, nonce });
    const proof = await until(() => sentOf(again, 'host:proof'), 'the proof');
    expect(await verifyHostChallenge(publicKey, { roomId, nonce }, proof.signature)).toBe(true);
    again.receive({ type: 'room:ready', version: 1, roomId, startedAt: 0, expiresAt: Date.now() + 3600_000, locked: false, now: Date.now() });
    expect(again.sent.at(-1)).toEqual({ type: 'room:end' });
    // Never shown as running again on the way out.
    again.receive({ type: 'room:roster', participants: [] });
    expect(h.manager.state.phase).toBe('stopping');
    again.drop(LIVE_CLOSE_CODES.ENDED);
    expect(await stopping).toEqual({ ok: true });
    expect(h.manager.state).toEqual({ phase: 'idle', lastError: null });
    expect(h.sockets.length).toBe(2);
  });
});
