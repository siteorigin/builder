import { describe, expect, it } from 'vitest';
import { holdUntil, nextDeadline, restoreRoom, writeAttachment, type GuestRecord, type RoomSnapshot } from '../../relay/src/room-state';

/** The relay's room bookkeeping on its own: what is due when, how long a socketless room is held, and what survives a wake-up. */

const T = 1_000_000;

function room(patch: Partial<RoomSnapshot> = {}, guests: GuestRecord[] = []): RoomSnapshot {
  return { revision: 1, roomId: 'abcdefghijkmnpqrstuvwxyz', publicKey: 'k', projectName: 'Site', startedAt: T, expiresAt: T + 60_000, locked: false, hostConnectionId: 'host', hostGraceUntil: null, hostPage: null, guests, ...patch };
}
const away = { hostConnectionId: null, hostGraceUntil: T + 30_000 };
const droppedGuest: GuestRecord = { guestId: 'g1', displayName: 'Ann', status: 'pending', connectionId: null, reconnectUntil: T + 5_000, resumeToken: 'r'.repeat(43) };

describe('holding a socketless room', () => {
  it('holds a room whose host is away and that has no live socket until the host’s grace ends, however soon anything else is due', () => {
    expect(holdUntil(room(away, [droppedGuest]), false)).toBe(T + 30_000);
    // The earlier guest deadline is what the alarm is set for, not what the hold lasts to.
    expect(nextDeadline(room(away, [droppedGuest]), [T + 1_000])).toBe(T + 1_000);
  });

  it('holds no longer than the session lasts', () => {
    expect(holdUntil(room({ ...away, expiresAt: T + 10_000 }), false)).toBe(T + 10_000);
  });

  it('holds nothing while a socket keeps the room, the host is present, or the room is gone', () => {
    expect(holdUntil(room(away), true)).toBeNull();
    expect(holdUntil(room(), false)).toBeNull();
    expect(holdUntil(null, false)).toBeNull();
  });
});

describe('deadlines', () => {
  it('takes the earliest of the session’s end, the host’s grace, guests’ access and kept places, and handshakes', () => {
    const admitted: GuestRecord = { guestId: 'g2', displayName: 'Bea', status: 'admitted', role: 'viewer', guestExpiresAt: T + 20_000, grantVersion: 1, ticket: null, ticketUntil: null, connectionId: 'c', reconnectUntil: null, resumeToken: 's'.repeat(43) };
    expect(nextDeadline(room(), [])).toBe(T + 60_000);
    expect(nextDeadline(room({}, [admitted]), [])).toBe(T + 20_000);
    expect(nextDeadline(room(away, [admitted]), [])).toBe(T + 20_000);
    expect(nextDeadline(room({ ...away, hostGraceUntil: T + 15_000 }, [admitted]), [])).toBe(T + 15_000);
    expect(nextDeadline(room({}, [admitted, droppedGuest]), [])).toBe(T + 5_000);
    expect(nextDeadline(room(), [T + 2_000])).toBe(T + 2_000);
    // A present host's old grace is not a deadline.
    expect(nextDeadline(room({ hostGraceUntil: T + 1 }), [])).toBe(T + 60_000);
    expect(nextDeadline(null, [])).toBeNull();
  });
});

describe('waking up', () => {
  function socket() {
    let value: unknown = null;
    return { serializeAttachment: (v: unknown) => void (value = structuredClone(v)), deserializeAttachment: () => value };
  }

  it('takes the newest copy any live socket holds, and never a retired socket’s', () => {
    const [a, b, c] = [socket(), socket(), socket()];
    writeAttachment(a, { connectionId: 'a', phase: 'host', roomId: 'r', deadline: null }, room({ revision: 3 }));
    writeAttachment(b, { connectionId: 'b', phase: 'guest', roomId: 'r', deadline: null, guestId: 'g' }, room({ revision: 5, locked: true }));
    writeAttachment(c, { connectionId: 'c', phase: 'retired', roomId: 'r', deadline: null }, room({ revision: 9 }));
    expect(c.deserializeAttachment()).toMatchObject({ room: null });
    expect(restoreRoom([a, b, c])).toMatchObject({ revision: 5, locked: true });
    expect(restoreRoom([c])).toBeNull();
  });
});
