import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { generateHostKeyPair } from '../../src/shared/live/crypto';
import { MAX_FRAME_BYTES, MAX_GUESTS } from '../../src/shared/live/limits';
import { admittedGuest, joinGuest, openRoom, previewStatus, reconnectHost, startRelay, wait, type Relay } from './relay-harness';

/**
 * Time on the relay: the Durable Object alarm ends sessions, guests' access and kept places, and rooms whose host
 * stays away, with no traffic needed to notice. Deadlines here are a second or two of real time, set through the
 * host's own commands and short grace periods, and the room is left quiet while they pass.
 */

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ HOST_RECONNECT_GRACE_MS: '1000', GUEST_RECONNECT_GRACE_MS: '1000', HANDSHAKE_TIMEOUT_MS: '1000' });
}, 60_000);
afterAll(() => relay?.dispose());

describe('a guest’s own access', () => {
  it('ends when its time is up, not before: the guest is told and disconnected, and the others stay', async () => {
    const room = await openRoom(relay);
    const deadline = Date.now() + 1500;
    const ann = await admittedGuest(relay, room, 'Ann', 'viewer', deadline);
    expect(ann.status.guestExpiresAt).toBe(deadline);
    const bea = await admittedGuest(relay, room, 'Bea');
    room.host.discard('room:roster');
    expect(await ann.guest.next('guest:status', 5000)).toEqual({ type: 'guest:status', status: 'expired', scope: 'guest' });
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.REMOVED);
    expect((await room.host.next('room:roster')).participants.map((p) => p.guestId)).toEqual([bea.guestId]);
    expect(await previewStatus(relay, room, ann.cookie)).toBe(401);
    expect(bea.guest.closeEvent).toBeNull();
    room.host.close();
  }, 15_000);

  it('lasts past its first deadline when the host extends it', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann', 'viewer', Date.now() + 1500);
    const later = Date.now() + 60_000;
    room.host.send('host-to-relay', { type: 'guest:set-expiry', guestId: ann.guestId, guestExpiresAt: later });
    expect(await ann.guest.next('guest:status')).toMatchObject({ status: 'admitted', guestExpiresAt: later });
    await wait(2000);
    expect(ann.guest.closeEvent).toBeNull();
    expect(ann.guest.has('guest:status')).toBe(false);
    room.host.close();
  }, 15_000);
});

describe('the session’s end', () => {
  it('tears the room down when it passes, even while every socket hibernates', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const deadline = Date.now() + 1500;
    room.host.send('host-to-relay', { type: 'room:set-expiry', expiresAt: deadline });
    expect((await room.host.next('room:state')).expiresAt).toBe(deadline);
    expect((await ann.guest.next('room:state')).expiresAt).toBe(deadline);
    // Ann's access now ends sooner, so she has a new grant.
    expect((await ann.guest.next('guest:status')).status).toBe('admitted');
    await relay.hibernate(room.roomId);

    expect(await ann.guest.next('guest:status', 5000)).toEqual({ type: 'guest:status', status: 'expired', scope: 'session' });
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.SESSION_EXPIRED);
    expect((await room.host.closed()).code).toBe(LIVE_CLOSE_CODES.SESSION_EXPIRED);
    expect((await relay.fetch(`/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  }, 15_000);
});

describe('a host that drops', () => {
  it('loses the room when it stays away past the grace, and every guest is let go', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const waiting = await joinGuest(relay, room.roomId, 'Bea');
    const leftAt = Date.now();
    room.host.close();
    for (const guest of [ann.guest, waiting.guest]) {
      expect((await guest.next('guest:status', 5000)).status).toBe('ended');
      expect((await guest.closed()).code).toBe(LIVE_CLOSE_CODES.HOST_GONE);
    }
    expect(Date.now() - leftAt).toBeGreaterThanOrEqual(1000);
    expect((await relay.fetch(`/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  }, 15_000);

  it('loses the room when the relay closes it for an oversized frame and it stays away', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    room.host.sendRaw(JSON.stringify({ type: 'rpc:event', event: 'project:changed', payload: 'x'.repeat(MAX_FRAME_BYTES) }));
    expect((await room.host.closed()).code).toBe(LIVE_CLOSE_CODES.TOO_LARGE);
    expect((await ann.guest.next('guest:status', 5000)).status).toBe('ended');
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.HOST_GONE);
  }, 15_000);

  it('takes its room back within the grace when it was the room’s only socket', async () => {
    const room = await openRoom(relay);
    room.host.close();
    await wait(300);
    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    await wait(1200);
    host.send('host-to-relay', { type: 'room:set-locked', locked: true });
    expect((await host.next('room:state')).locked).toBe(true);
    host.close();
  }, 15_000);

  it('keeps a socketless room in memory through the grace, past the point the runtime evicts idle objects', async () => {
    // The simulator evicts an idle object within about 25 seconds; the room holds itself for the host's grace.
    const patient = await startRelay({ HOST_RECONNECT_GRACE_MS: '60000' });
    try {
      const room = await openRoom(patient);
      room.host.close();
      await wait(30_000);
      const { ready } = await reconnectHost(patient, room.roomId, room.keys);
      expect(ready.roomId).toBe(room.roomId);
    } finally {
      await patient.dispose();
    }
  }, 90_000);

  it('loses the room even when it was the room’s only socket', async () => {
    const room = await openRoom(relay);
    room.host.close();
    await wait(1800);
    expect((await relay.fetch(`/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  }, 15_000);

  it('keeps the room when it proves itself again within the grace', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    room.host.close();
    await wait(200);
    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    await wait(1500);
    host.send('host-to-relay', { type: 'room:set-locked', locked: true });
    expect((await host.next('room:state')).locked).toBe(true);
    expect(ann.guest.closeEvent).toBeNull();
    host.close();
  }, 15_000);
});

describe('a guest that drops', () => {
  it('loses its place after the grace when the relay closed it for an oversized frame', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    room.host.discard('room:roster');
    ann.guest.sendRaw(JSON.stringify({ type: 'rpc:request', requestId: 'big', method: 'project.snapshot', args: ['x'.repeat(MAX_FRAME_BYTES)] }));
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.TOO_LARGE);
    // The host hears at once that she is away (#768), then that her place is given up.
    expect((await room.host.next('room:roster', 5000)).participants).toEqual([expect.objectContaining({ guestId: ann.guestId, connected: false })]);
    expect((await room.host.next('room:roster', 5000)).participants).toEqual([]);
    room.host.close();
  }, 15_000);

  it('loses its kept place after the grace', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    room.host.discard('room:roster');
    ann.guest.close();
    expect((await room.host.next('room:roster', 5000)).participants).toEqual([expect.objectContaining({ guestId: ann.guestId, connected: false })]);
    expect((await room.host.next('room:roster', 5000)).participants).toEqual([]);
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect((await back.next('protocol:error')).code).toBe('AUTH_FAILED');
    room.host.close();
  }, 15_000);
});

describe('handshakes', () => {
  // workerd drops a closed socket from the room at once, but never delivers the close to a client that has not sent a
  // frame, so what is checked here is the relay's side: a socket past its deadline is told, retired, and nothing it
  // sends afterwards is read.
  it('retires sockets that never say what they are', async () => {
    const room = await openRoom(relay);
    room.host.discard('room:roster');
    const silentGuest = await relay.socket(`/s/${room.roomId}/ws`);
    const silentHost = await relay.socket<'relay-to-host', 'host-to-relay'>('/ws/host', { 'cf-connecting-ip': '10.9.9.9' });
    expect((await silentGuest.next('protocol:error', 5000)).code).toBe('WRONG_STATE');
    expect((await silentHost.next('protocol:error', 5000)).code).toBe('WRONG_STATE');

    silentGuest.send('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Late' });
    const keys = await generateHostKeyPair();
    silentHost.send('host-to-relay', { type: 'room:create', version: 1, publicKey: keys.publicKey, duration: '2h', projectName: 'Late' });
    await wait(300);
    expect(silentGuest.has('guest:status')).toBe(false);
    expect(silentHost.has('room:ready')).toBe(false);
    expect(room.host.has('room:roster')).toBe(false);
    expect(room.host.closeEvent).toBeNull();
    room.host.close();
  }, 15_000);

  it('never lets sockets that sit in their handshake keep a returning host out', async () => {
    const room = await openRoom(relay);
    room.host.close();
    // relay/src/session-room.ts MAX_HANDSHAKING_SOCKETS: twice the guest places, all taken by sockets that say nothing.
    const silent = [];
    for (let i = 0; i < 2 * MAX_GUESTS; i++) silent.push(await relay.socket(`/s/${room.roomId}/ws`));
    // The host gets in at once; the socket that waited longest gives way.
    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    expect((await silent[0].next('protocol:error')).code).toBe('WRONG_STATE');
    expect(silent.slice(1).some((peer) => peer.has('protocol:error'))).toBe(false);
    host.close();
  }, 15_000);
});
