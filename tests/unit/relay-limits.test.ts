import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { GUEST_FRAME_HEADROOM_BYTES, MAX_FRAME_BYTES, MAX_GUESTS } from '../../src/shared/live/limits';
import { frameLimit } from '../../src/shared/live/messages';
import { admitGuest, admittedGuest, joinGuest, openRoom, reconnectHost, startRelay, wait, type Relay } from './relay-harness';

/** The relay's guardrails: the guest cap, frame sizes, room creation per address, and the signing secret. */

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay();
}, 60_000);
afterAll(() => relay?.dispose());

/** A guest call whose JSON text is exactly `bytes` long. */
function callOfSize(bytes: number, filler = 'x'): string {
  const empty = JSON.stringify({ type: 'rpc:request', requestId: 'big', method: 'project.snapshot', args: [''] });
  return JSON.stringify({ type: 'rpc:request', requestId: 'big', method: 'project.snapshot', args: [filler.repeat((bytes - empty.length) / new TextEncoder().encode(filler).length)] });
}

describe('the guest cap', () => {
  it('holds eight guests, waiting or admitted, and turns the ninth away until a place frees up', async () => {
    const room = await openRoom(relay);
    const guests = [];
    for (let i = 0; i < MAX_GUESTS; i++) guests.push(await joinGuest(relay, room.roomId, `Guest ${i + 1}`));
    await admitGuest(room.host, guests[0]);
    // A guest whose socket dropped keeps its place.
    guests[1].guest.close();
    await wait(200);

    const ninth = await relay.socket(`/s/${room.roomId}/ws`);
    ninth.send('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Ninth' });
    expect((await ninth.next('protocol:error')).code).toBe('ROOM_FULL');
    expect((await ninth.closed()).code).toBe(LIVE_CLOSE_CODES.REFUSED);

    // The guest that dropped can still take its place back in a full room.
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Guest 2', resumeToken: guests[1].resumeToken });
    expect(await back.next('guest:status')).toMatchObject({ status: 'pending', guestId: guests[1].guestId });

    room.host.send('host-to-relay', { type: 'guest:kick', guestId: guests[7].guestId });
    await guests[7].guest.closed();
    await joinGuest(relay, room.roomId, 'Ninth');
    room.host.close();
  });
});

describe('frame sizes', () => {
  it('leaves a guest room for the ID the relay adds, and closes a guest that sends more', async () => {
    expect(frameLimit('guest-to-relay')).toBe(MAX_FRAME_BYTES - GUEST_FRAME_HEADROOM_BYTES);
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    // Exactly at the limit, the call reaches the host whole, with the guest's ID added, still within the host's limit.
    const atLimit = callOfSize(frameLimit('guest-to-relay'));
    ann.guest.sendRaw(atLimit);
    const forwarded = await room.host.next('rpc:request');
    expect(forwarded).toEqual({ ...JSON.parse(atLimit), guestId: ann.guestId });
    expect(new TextEncoder().encode(JSON.stringify(forwarded)).byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    ann.guest.sendRaw(callOfSize(frameLimit('guest-to-relay') + 1));
    expect((await ann.guest.next('protocol:error')).code).toBe('TOO_LARGE');
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.TOO_LARGE);
    room.host.close();
  });

  it('counts bytes, not characters', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    // Fewer characters than the limit, but three bytes each.
    const text = callOfSize(frameLimit('guest-to-relay') + 10, '€');
    expect(text.length).toBeLessThan(frameLimit('guest-to-relay'));
    ann.guest.sendRaw(text);
    expect((await ann.guest.next('protocol:error')).code).toBe('TOO_LARGE');
    await ann.guest.closed();
    room.host.close();
  });

  it('takes a host frame at the limit and closes a host that sends one byte more', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const event = (bytes: number) => {
      const empty = JSON.stringify({ type: 'rpc:event', event: 'project:changed', payload: '' });
      return JSON.stringify({ type: 'rpc:event', event: 'project:changed', payload: 'x'.repeat(bytes - empty.length) });
    };
    room.host.sendRaw(event(MAX_FRAME_BYTES));
    expect(((await ann.guest.next('rpc:event')).payload as string).length).toBeGreaterThan(MAX_FRAME_BYTES - 100);
    room.host.sendRaw(event(MAX_FRAME_BYTES + 1));
    expect((await room.host.next('protocol:error')).code).toBe('TOO_LARGE');
    expect((await room.host.closed()).code).toBe(LIVE_CLOSE_CODES.TOO_LARGE);
  });

  it('closes a socket whose binary frame, or first frame, is over the limit', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    ann.guest.sendRaw(new Uint8Array(frameLimit('guest-to-relay') + 1));
    expect((await ann.guest.next('protocol:error')).code).toBe('TOO_LARGE');
    expect((await ann.guest.closed()).code).toBe(LIVE_CLOSE_CODES.TOO_LARGE);

    // A join request padded past the limit is refused before it is read.
    const padded = await relay.socket(`/s/${room.roomId}/ws`);
    padded.sendRaw(`${JSON.stringify({ type: 'guest:join', version: 1, displayName: 'Pad' })}${' '.repeat(frameLimit('guest-to-relay'))}`);
    expect((await padded.next('protocol:error')).code).toBe('TOO_LARGE');
    expect((await padded.closed()).code).toBe(LIVE_CLOSE_CODES.TOO_LARGE);
    room.host.close();
  });

  it('refuses binary and malformed frames without closing an established socket', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    ann.guest.sendRaw(new Uint8Array([1, 2, 3]));
    expect((await ann.guest.next('protocol:error')).code).toBe('INVALID_FRAME');
    ann.guest.sendRaw('{"type":"rpc:request"');
    expect((await ann.guest.next('protocol:error')).code).toBe('INVALID_FRAME');
    ann.guest.sendRaw(JSON.stringify({ type: 'guest:admit', guestId: ann.guestId, role: 'collaborator', guestExpiresAt: null }));
    expect((await ann.guest.next('protocol:error')).code).toBe('INVALID_FRAME');
    // Still a working connection.
    ann.guest.send('guest-to-relay', { type: 'rpc:request', requestId: 'still-here', method: 'project.snapshot', args: [] });
    expect(await room.host.next('rpc:request')).toMatchObject({ requestId: 'still-here', guestId: ann.guestId });
    expect(ann.guest.closeEvent).toBeNull();
    room.host.close();
  });
});

/**
 * Run a rate-limit check inside one of the simulator's limiter windows, which reset on wall-clock minute boundaries:
 * when a run straddles one, it is repeated once from a fresh address, so the count it checks is never split.
 */
async function withinOneWindow(check: (address: string) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const minute = Math.floor(Date.now() / 60_000);
    const address = `203.0.${attempt}.${10 + Math.floor(Math.random() * 200)}`;
    try {
      await check(address);
      return;
    } catch (error) {
      if (attempt === 1 || Math.floor(Date.now() / 60_000) === minute) throw error;
    }
  }
}

describe('connections to a room', () => {
  it('limits connections to one room per address', async () => {
    const room = await openRoom(relay);
    const upgrade = (ip: string) => relay.fetch(`/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket', 'cf-connecting-ip': ip } });
    await withinOneWindow(async (address) => {
      for (let i = 0; i < 30; i++) {
        const response = await upgrade(address);
        expect(response.status).toBe(101);
        response.webSocket!.accept();
        response.webSocket!.close();
      }
      expect((await upgrade(address)).status).toBe(429);
    });
    const other = await upgrade('198.51.100.20');
    expect(other.status).toBe(101);
    other.webSocket!.accept();
    other.webSocket!.close();
    room.host.close();
  });
});

describe('room creation', () => {
  it('limits new rooms per address, and never limits a host taking its room back', async () => {
    const rooms: Awaited<ReturnType<typeof openRoom>>[] = [];
    await withinOneWindow(async (address) => {
      for (const room of rooms.splice(0)) room.host.close();
      for (let i = 0; i < 6; i++) rooms.push(await openRoom(relay, { ip: address }));
      const refused = await relay.fetch('/ws/host', { headers: { upgrade: 'websocket', 'cf-connecting-ip': address } });
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('60');
      (await openRoom(relay, { ip: '192.0.2.8' })).host.close();

      // Taking a room back, from the very address that is out of new rooms, is never limited, and spends nothing.
      rooms[0].host.close();
      const { host } = await reconnectHost(relay, rooms[0].roomId, rooms[0].keys, { 'cf-connecting-ip': address });
      host.close();
      expect((await relay.fetch('/ws/host', { headers: { upgrade: 'websocket', 'cf-connecting-ip': address } })).status).toBe(429);
    });
    for (const room of rooms.slice(1)) room.host.close();
  });

  it('opens no rooms without a signing key of at least 32 characters', async () => {
    for (const [key, status] of [['too-short', 503], ['k'.repeat(31), 503], [` ${'k'.repeat(31)} `, 503], ['k'.repeat(32), 101]] as const) {
      const configured = await startRelay({ SESSION_SIGNING_KEY: key });
      try {
        const response = await configured.fetch('/ws/host', { headers: { upgrade: 'websocket', 'cf-connecting-ip': '198.51.100.1' } });
        expect(response.status).toBe(status);
        response.webSocket?.accept();
        response.webSocket?.close();
      } finally {
        await configured.dispose();
      }
    }
  }, 60_000);
});
