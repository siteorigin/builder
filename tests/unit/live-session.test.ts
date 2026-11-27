import { describe, expect, it } from 'vitest';
import type { LiveHostState } from '../../src/shared/api';
import { encodeFrame } from '../../src/shared/live/messages';
import {
  extendChoices,
  formatSpan,
  guestExpiryChoices,
  guestTimeLeft,
  hostPresence,
  joinNotice,
  liveFor,
  livePill,
  previewPathOf,
  readRelayClock,
  relayNow,
  remainingMs,
  spanWords,
  tickMs,
  waitingGuests,
  type LiveRoomState
} from '../../src/renderer/src/lib/live-session';

/** What the toolbar's Share control shows of a live session (#764): the pill, the time left, and the choices it offers. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;

function room(extra: Partial<LiveRoomState> = {}): LiveRoomState {
  return {
    phase: 'active',
    workspaceKey: '/sites/acme#1',
    runId: 'run-1',
    roomId: 'abcdefghijkmnpqrstuvwxyz',
    inviteUrl: 'http://relay.localhost:8787/s/abcdefghijkmnpqrstuvwxyz',
    projectName: 'Acme',
    duration: '2h',
    startedAt: T0,
    expiresAt: T0 + 2 * HOUR,
    relayClockOffsetMs: 0,
    locked: false,
    participants: [
      { guestId: 'g1', displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true },
      { guestId: 'g2', displayName: 'Bo', status: 'pending' }
    ],
    previewReady: true,
    lastError: null,
    ...extra
  } as LiveRoomState;
}

describe('the time left', () => {
  it('rounds up, so a session never reads as over before it is', () => {
    expect(formatSpan(0)).toBe('0s');
    expect(formatSpan(1)).toBe('1s');
    expect(formatSpan(59_001)).toBe('60s');
    expect(formatSpan(MIN)).toBe('1m');
    expect(formatSpan(MIN + 1)).toBe('2m');
    expect(formatSpan(HOUR + 5 * MIN)).toBe('1h 05m');
    expect(formatSpan(24 * HOUR)).toBe('24h 00m');
    expect(spanWords(HOUR + MIN)).toBe('1 hour 1 minute');
    expect(spanWords(2 * HOUR)).toBe('2 hours');
    expect(spanWords(30_000)).toBe('30 seconds');
    expect(spanWords(1000)).toBe('1 second');
  });

  it('reads the relay’s clock, carried forward on the monotonic clock rather than this computer’s', () => {
    const state = room({ relayClockOffsetMs: 90_000 });
    const clock = readRelayClock(state, T0, 1000);
    expect(relayNow(clock, 1000)).toBe(T0 + 90_000);
    // This computer's clock jumping between states changes nothing: only the time elapsed counts.
    expect(relayNow(clock, 1000 + 30 * MIN)).toBe(T0 + 90_000 + 30 * MIN);
    expect(remainingMs(state, relayNow(clock, 1000))).toBe(2 * HOUR - 90_000);
    expect(remainingMs(state, T0 + 3 * HOUR)).toBe(0);
  });

  it('redraws each minute, and each second in the last one', () => {
    const state = room();
    expect(tickMs(state, state.expiresAt - 30_000)).toBe(1000);
    expect(tickMs(state, state.expiresAt - 10 * MIN - 20_000)).toBe(20_050);
    expect(tickMs(state, state.expiresAt - 10 * MIN)).toBeLessThanOrEqual(MIN);
  });
});

describe('the pill', () => {
  it('names the session in words, with its guests, who is waiting, and the time left', () => {
    const state = room();
    expect(livePill(state, T0 + HOUR)).toEqual({ kind: 'live', text: 'Live · 1h 00m left', label: 'Share: live session, 1 guest, 1 waiting to join, 1 hour left' });
    expect(livePill(room({ duration: 'project', expiresAt: T0 + 24 * HOUR }), T0)).toMatchObject({ text: 'Live', label: 'Share: live session, 1 guest, 1 waiting to join' });
    expect(livePill(room({ phase: 'reconnecting' } as Partial<LiveRoomState>), T0)).toMatchObject({ kind: 'reconnecting', text: 'Reconnecting…' });
    expect(livePill({ phase: 'idle', lastError: null }, T0)).toMatchObject({ kind: 'idle', text: 'Share' });
    expect(livePill({ phase: 'starting', workspaceKey: 'k', runId: 'r' }, T0)).toMatchObject({ kind: 'busy', text: 'Starting…' });
    expect(livePill({ phase: 'stopping', workspaceKey: 'k', runId: 'r' }, T0)).toEqual({ kind: 'busy', text: 'Ending…', label: 'Share: the live session is ending' });
  });

  it('shows a session of another project opening as none', () => {
    const state = room();
    expect(liveFor(state, '/sites/acme#1')).toBe(state);
    expect(liveFor(state, '/sites/acme#2')).toEqual({ phase: 'idle', lastError: null });
    const idle: LiveHostState = { phase: 'idle', lastError: 'The live session reached its end.' };
    expect(liveFor(idle, '/sites/acme#2')).toBe(idle);
    expect(waitingGuests(state).map((g) => g.displayName)).toEqual(['Bo']);
  });

  it('names guests asking at once together', () => {
    expect(joinNotice([])).toBe('');
    expect(joinNotice(['Ann'])).toBe('Ann wants to join the live session');
    expect(joinNotice(['Ann', 'Bo', 'Cy'])).toBe('Ann, Bo and Cy want to join the live session');
    expect(joinNotice(['Ann', 'Bo', 'Cy', 'Di'])).toBe('Ann, Bo, Cy and Di want to join the live session');
  });
});

describe('extending', () => {
  it('offers only what stays within 24 hours of the start, and the cap itself', () => {
    expect(extendChoices(room()).map((c) => [c.label, c.expiresAt! - T0])).toEqual([
      ['30 minutes more', 2.5 * HOUR],
      ['1 hour more', 3 * HOUR],
      ['2 hours more', 4 * HOUR],
      ['8 hours more', 10 * HOUR],
      ['To the 24-hour limit', 24 * HOUR]
    ]);
    // Close to the cap, the steps that would pass it go; the cap stays once, never twice.
    expect(extendChoices(room({ expiresAt: T0 + 23 * HOUR })).map((c) => [c.label, c.expiresAt! - T0])).toEqual([
      ['30 minutes more', 23.5 * HOUR],
      ['1 hour more', 24 * HOUR]
    ]);
    expect(extendChoices(room({ duration: 'project', expiresAt: T0 + 24 * HOUR }))).toEqual([]);
  });

  it('gives a guest an end of its own only before the session’s', () => {
    const state = room({ expiresAt: T0 + 40 * MIN });
    expect(guestExpiryChoices(state, T0).map((c) => [c.id, c.expiresAt === null ? null : c.expiresAt - T0])).toEqual([
      ['session', null],
      ['15m', 15 * MIN],
      ['30m', 30 * MIN]
    ]);
    const ann = { guestId: 'g1', displayName: 'Ann', status: 'admitted', role: 'viewer', guestExpiresAt: T0 + 15 * MIN, colorSlot: 0, connected: true } as const;
    expect(guestTimeLeft(state, ann, T0 + 5 * MIN)).toBe('10m left');
    expect(guestTimeLeft(state, { ...ann, guestExpiresAt: null }, T0)).toBeNull();
  });
});

describe('the host’s presence', () => {
  const valid = (presence: ReturnType<typeof hostPresence>) => encodeFrame('host-to-relay', { type: 'presence:update', presence }).ok;

  it('is the page the canvas shows, at its width, in a form the relay reads', () => {
    const p = hostPresence({ pageId: 'about', route: '/about/' }, 834);
    expect(p).toEqual({ pageId: 'about', viewportWidth: 834, selection: null, previewPath: '/about/' });
    expect(valid(p)).toBe(true);
  });

  it('percent-encodes an address as a browser would, and sends none for one guests cannot follow', () => {
    expect(previewPathOf('/café/')).toBe('/caf%C3%A9/');
    expect(previewPathOf('/a b/')).toBe('/a%20b/');
    expect(previewPathOf('//evil.example/')).toBeNull();
    expect(previewPathOf('about')).toBeNull();
    expect(previewPathOf('/__dev-only/')).toBeNull();
    const studio = hostPresence({ pageId: null, route: null }, 1280);
    expect(studio).toEqual({ pageId: null, viewportWidth: 1280, selection: null, previewPath: null });
    expect(valid(studio)).toBe(true);
    // Any width the editor allows is one the relay reads.
    expect(valid(hostPresence({ pageId: 'home', route: '/' }, 240))).toBe(true);
    expect(valid(hostPresence({ pageId: 'home', route: '/' }, Number.NaN))).toBe(true);
    expect(hostPresence({ pageId: 'home', route: '/café/' }, 833.6)).toMatchObject({ viewportWidth: 834, previewPath: '/caf%C3%A9/' });
    expect(hostPresence({ pageId: 'home', route: '//evil.example/' }, 834).previewPath).toBeNull();
    expect(valid(hostPresence({ pageId: 'x'.repeat(200), route: '/' }, 1280))).toBe(true);
  });
});
