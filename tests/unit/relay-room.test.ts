import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { generateHostKeyPair, signHostChallenge } from '../../src/shared/live/crypto';
import { SESSION_DURATIONS } from '../../src/shared/live/expiry';
import { ROOM_ID_RE } from '../../src/shared/live/limits';
import { admittedGuest, joinGuest, openRoom, reconnectHost, startRelay, wait, type HostPeer, type Relay } from './relay-harness';

/** Room lifecycle on the relay: opening a room, the host proving itself again, being replaced, and ending it. */

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ HOST_RECONNECT_GRACE_MS: '1500' });
}, 60_000);
afterAll(() => relay?.dispose());

describe('opening a room', () => {
  it('allocates an unguessable room ID and starts the session on the relay clock', async () => {
    const before = Date.now();
    const { ready, host } = await openRoom(relay, { duration: '30m' });
    expect(ready.roomId).toMatch(ROOM_ID_RE);
    expect(ready.version).toBe(1);
    expect(ready.locked).toBe(false);
    expect(ready.expiresAt - ready.startedAt).toBe(SESSION_DURATIONS['30m']);
    expect(ready.startedAt).toBeGreaterThanOrEqual(before - 1000);
    const second = await openRoom(relay);
    expect(second.roomId).not.toBe(ready.roomId);
    expect(second.ready.expiresAt - second.ready.startedAt).toBe(SESSION_DURATIONS['2h']);
    expect(second.ready.startedAt).toBeLessThanOrEqual(Date.now() + 1000);
    host.close();
    second.host.close();
  });

  it('requires room:create as the host socket’s first frame', async () => {
    const host = await relay.socket<'relay-to-host', 'host-to-relay'>('/ws/host');
    host.send('host-to-relay', { type: 'room:set-locked', locked: true });
    expect((await host.next('protocol:error')).code).toBe('WRONG_STATE');
    expect((await host.closed()).code).toBe(LIVE_CLOSE_CODES.POLICY);
  });

  it('closes a host whose first frame is unreadable, however its type is spelled', async () => {
    const host = await relay.socket<'relay-to-host', 'host-to-relay'>('/ws/host');
    // A type the relay quotes back in its error: the close itself must still go through.
    host.sendRaw(JSON.stringify({ type: 'é'.repeat(60) }));
    expect((await host.next('protocol:error')).code).toBe('INVALID_FRAME');
    expect((await host.closed()).code).toBe(LIVE_CLOSE_CODES.POLICY);
  });

  it('refuses another protocol version', async () => {
    const keys = await generateHostKeyPair();
    const host = await relay.socket<'relay-to-host', 'host-to-relay'>('/ws/host');
    host.sendRaw(JSON.stringify({ type: 'room:create', version: 2, publicKey: keys.publicKey, duration: '2h', projectName: 'Site' }));
    expect((await host.next('protocol:error')).code).toBe('UNSUPPORTED_VERSION');
    await host.closed();
  });

  it('turns away malformed requests before any room is touched', async () => {
    const { roomId, host } = await openRoom(relay);
    expect((await relay.fetch('/ws/host')).status).toBe(426);
    expect((await relay.fetch('/ws/host', { method: 'POST' })).status).toBe(405);
    expect((await relay.fetch('/s/not-a-room/ws', { headers: { upgrade: 'websocket' } })).status).toBe(404);
    expect((await relay.fetch(`/s/${roomId}/ws`)).status).toBe(426);
    expect((await relay.fetch(`/s/${roomId}/elsewhere`)).status).toBe(404);
    // A well-formed room ID that names no open room has nothing to join.
    expect((await relay.fetch(`/s/${'a'.repeat(24)}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
    host.close();
  });

  it('serves the invite link’s page without revealing whether the room exists', async () => {
    const page = await relay.fetch(`/s/${'b'.repeat(24)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain(`data-room-id="${'b'.repeat(24)}"`);
  });
});

describe('the host proving itself again', () => {
  it('takes the room back after its socket drops by signing a fresh challenge, and no other key can', async () => {
    const room = await openRoom(relay);
    const guest = await joinGuest(relay, room.roomId);
    room.host.close();
    await wait(50);

    // While the room has no host, a wrong key and a tampered signature are still refused.
    const stranger = await generateHostKeyPair();
    for (const forge of ['wrong key', 'tampered'] as const) {
      const claimant = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${room.roomId}/ws`);
      claimant.send('host-to-relay', { type: 'host:reconnect', version: 1, roomId: room.roomId });
      const challenge = await claimant.next('host:challenge');
      const signature = await signHostChallenge(forge === 'wrong key' ? stranger.privateKey : room.keys.privateKey, challenge);
      claimant.send('host-to-relay', { type: 'host:proof', roomId: room.roomId, nonce: challenge.nonce, signature: forge === 'tampered' ? `${signature[0] === 'A' ? 'Q' : 'A'}${signature.slice(1)}` : signature });
      expect((await claimant.next('protocol:error')).code).toBe('AUTH_FAILED');
      expect((await claimant.closed()).code).toBe(LIVE_CLOSE_CODES.POLICY);
    }

    const { host, ready } = await reconnectHost(relay, room.roomId, room.keys);
    expect(ready.roomId).toBe(room.roomId);
    expect(ready.startedAt).toBe(room.ready.startedAt);
    expect(ready.expiresAt).toBe(room.ready.expiresAt);
    // The new host socket is in charge: it sees the waiting guest and can admit it.
    expect((await host.next('room:roster')).participants).toEqual([{ guestId: guest.guestId, displayName: 'Ann', status: 'pending' }]);
    host.send('host-to-relay', { type: 'guest:admit', guestId: guest.guestId, role: 'viewer', guestExpiresAt: null });
    expect((await guest.guest.next('guest:status')).status).toBe('admitted');
    host.close();
  });

  it('refuses a wrong key, a tampered signature and a nonce sent to another socket, leaving the host in charge', async () => {
    const room = await openRoom(relay);
    const stranger = await generateHostKeyPair();

    const wrongKey = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${room.roomId}/ws`);
    wrongKey.send('host-to-relay', { type: 'host:reconnect', version: 1, roomId: room.roomId });
    const challenge = await wrongKey.next('host:challenge');
    wrongKey.send('host-to-relay', { type: 'host:proof', roomId: room.roomId, nonce: challenge.nonce, signature: await signHostChallenge(stranger.privateKey, challenge) });
    expect((await wrongKey.next('protocol:error')).code).toBe('AUTH_FAILED');
    expect((await wrongKey.closed()).code).toBe(LIVE_CLOSE_CODES.POLICY);

    const tampered = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${room.roomId}/ws`);
    tampered.send('host-to-relay', { type: 'host:reconnect', version: 1, roomId: room.roomId });
    const second = await tampered.next('host:challenge');
    const signature = await signHostChallenge(room.keys.privateKey, second);
    // The first character carries six whole bits of the signature, so changing it always changes a byte.
    const flipped = `${signature[0] === 'A' ? 'Q' : 'A'}${signature.slice(1)}`;
    tampered.send('host-to-relay', { type: 'host:proof', roomId: room.roomId, nonce: second.nonce, signature: flipped });
    expect((await tampered.next('protocol:error')).code).toBe('AUTH_FAILED');
    await tampered.closed();

    // A nonce is good only on the socket it was sent to.
    const asker = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${room.roomId}/ws`);
    asker.send('host-to-relay', { type: 'host:reconnect', version: 1, roomId: room.roomId });
    const third = await asker.next('host:challenge');
    const thief = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${room.roomId}/ws`);
    thief.send('host-to-relay', { type: 'host:reconnect', version: 1, roomId: room.roomId });
    await thief.next('host:challenge');
    thief.send('host-to-relay', { type: 'host:proof', roomId: room.roomId, nonce: third.nonce, signature: await signHostChallenge(room.keys.privateKey, third) });
    expect((await thief.next('protocol:error')).code).toBe('AUTH_FAILED');
    asker.close();

    // None of it touched the real host.
    room.host.send('host-to-relay', { type: 'room:set-locked', locked: true });
    expect((await room.host.next('room:state')).locked).toBe(true);
    expect(room.host.closeEvent).toBeNull();
    room.host.close();
  });

  it('keeps the room when the object hibernates between the challenge and the proof', async () => {
    const room = await openRoom(relay);
    const guest = await joinGuest(relay, room.roomId);
    room.host.close();
    await wait(50);
    const host = await relay.socket<'relay-to-host', 'host-to-relay'>(`/s/${room.roomId}/ws`);
    host.send('host-to-relay', { type: 'host:reconnect', version: 1, roomId: room.roomId });
    const challenge = await host.next('host:challenge');
    await relay.hibernate(room.roomId);
    host.send('host-to-relay', { type: 'host:proof', roomId: room.roomId, nonce: challenge.nonce, signature: await signHostChallenge(room.keys.privateKey, challenge) });
    expect((await host.next('room:ready')).expiresAt).toBe(room.ready.expiresAt);
    expect((await host.next('room:roster')).participants.map((p) => p.guestId)).toEqual([guest.guestId]);
    host.close();
  });

  it('replaces a live host connection with a newly proven one, and the old connection’s close starts no grace', async () => {
    const room = await openRoom(relay);
    const guest = await admittedGuest(relay, room);
    // A preview the old connection was answering fails at once, not at its timeout.
    const answering = relay.fetch(`/s/${room.roomId}/preview/slow`, { headers: { cookie: guest.cookie } });
    await room.host.next('preview:request');
    const { host: replacement } = await reconnectHost(relay, room.roomId, room.keys);
    expect((await room.host.closed()).code).toBe(LIVE_CLOSE_CODES.REPLACED);
    expect((await answering).status).toBe(503);
    // Past the old connection's grace (1.5 s here), the room is still open and the new host still runs it.
    await wait(2000);
    replacement.send('host-to-relay', { type: 'room:set-locked', locked: true });
    expect((await replacement.next('room:state')).locked).toBe(true);
    expect((await guest.guest.next('room:state')).locked).toBe(true);
    expect(guest.guest.closeEvent).toBeNull();
    replacement.close();
  }, 15_000);
});

describe('ending a session', () => {
  it('disconnects every guest and forgets the room', async () => {
    const room = await openRoom(relay);
    const admitted = await admittedGuest(relay, room);
    const waiting = await joinGuest(relay, room.roomId, 'Bea');
    const answering = relay.fetch(`/s/${room.roomId}/preview/`, { headers: { cookie: admitted.cookie } });
    await room.host.next('preview:request');
    room.host.send('host-to-relay', { type: 'room:end' });
    expect((await answering).status).toBe(404);
    for (const guest of [admitted.guest, waiting.guest]) {
      expect((await guest.next('guest:status')).status).toBe('ended');
      expect((await guest.closed()).code).toBe(LIVE_CLOSE_CODES.ENDED);
    }
    expect((await (room.host as HostPeer).closed()).code).toBe(LIVE_CLOSE_CODES.ENDED);
    expect((await relay.fetch(`/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
    expect((await relay.fetch(`/s/${room.roomId}/preview/`, { headers: { cookie: admitted.cookie } })).status).toBe(404);
  });
});

describe('hibernation', () => {
  // The other side of keeping the room only in memory and in its sockets: evicting the object while no socket holds a
  // copy loses the room. It is also what shows the harness really evicts.
  it('loses a room whose sockets are all gone when its object is evicted', async () => {
    const room = await openRoom(relay);
    room.host.close();
    await wait(100);
    await relay.hibernate(room.roomId);
    expect((await relay.fetch(`/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
  });
});
