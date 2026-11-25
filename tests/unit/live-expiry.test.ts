import { describe, expect, it } from 'vitest';
import {
  checkGuestExpiry,
  checkSessionExpiry,
  guestAccessEndsAt,
  isExpired,
  isGuestExpired,
  isSessionDuration,
  MAX_SESSION_MS,
  SESSION_DURATION_IDS,
  sessionDeadline,
  sessionExpiresAt
} from '@shared/live/expiry';

const MIN = 60_000;
const HOUR = 60 * MIN;
const start = Date.UTC(2026, 10, 25, 9, 0, 0);

describe('session durations', () => {
  it('offers the four presets, none past 24 hours', () => {
    expect(SESSION_DURATION_IDS).toEqual(['30m', '2h', '8h', 'project']);
    expect(sessionExpiresAt('30m', start)).toBe(start + 30 * MIN);
    expect(sessionExpiresAt('2h', start)).toBe(start + 2 * HOUR);
    expect(sessionExpiresAt('8h', start)).toBe(start + 8 * HOUR);
    // Until the project closes, but never past the hard cap.
    expect(sessionExpiresAt('project', start)).toBe(start + 24 * HOUR);
    for (const id of SESSION_DURATION_IDS) expect(sessionExpiresAt(id, start) - start).toBeLessThanOrEqual(MAX_SESSION_MS);
  });

  it('knows its own presets only', () => {
    expect(isSessionDuration('2h')).toBe(true);
    expect(isSessionDuration('24h')).toBe(false);
    expect(isSessionDuration('hasOwnProperty')).toBe(false);
    expect(isSessionDuration(2)).toBe(false);
  });
});

describe('session expiry', () => {
  it('allows any end up to 24 hours from the start, including after extending', () => {
    expect(checkSessionExpiry(start + 2 * HOUR, { startedAt: start }, start)).toEqual({ ok: true, expiresAt: start + 2 * HOUR });
    expect(checkSessionExpiry(sessionDeadline(start), { startedAt: start, currentExpiresAt: start + 21 * HOUR }, start + 20 * HOUR)).toEqual({ ok: true, expiresAt: start + 24 * HOUR });
    // Shortening a running session is allowed too.
    expect(checkSessionExpiry(start + HOUR, { startedAt: start, currentExpiresAt: start + 8 * HOUR }, start + 30 * MIN)).toEqual({ ok: true, expiresAt: start + HOUR });
  });

  it('enforces the 24-hour cap from the start, not from now', () => {
    expect(checkSessionExpiry(start + 24 * HOUR + 1, { startedAt: start }, start)).toMatchObject({ ok: false, code: 'TOO_LONG' });
    // At hour 23, another 8 hours would make a 31-hour session.
    expect(checkSessionExpiry(start + 31 * HOUR, { startedAt: start, currentExpiresAt: start + 24 * HOUR }, start + 23 * HOUR)).toMatchObject({ ok: false, code: 'TOO_LONG' });
  });

  it('never renews a session that has already ended', () => {
    expect(checkSessionExpiry(start + 3 * HOUR, { startedAt: start, currentExpiresAt: start + 2 * HOUR }, start + 2 * HOUR)).toMatchObject({ ok: false, code: 'ENDED' });
  });

  it('refuses an end already passed and anything that is not a time', () => {
    expect(checkSessionExpiry(start, { startedAt: start }, start)).toMatchObject({ ok: false, code: 'PAST' });
    expect(checkSessionExpiry(start + HOUR, { startedAt: start, currentExpiresAt: start + 8 * HOUR }, start + 2 * HOUR)).toMatchObject({ ok: false, code: 'PAST' });
    for (const bad of [NaN, Infinity, 1.5 + start, 2 ** 60, '1', null, undefined]) expect(checkSessionExpiry(bad, { startedAt: start }, start)).toMatchObject({ ok: false, code: 'INVALID' });
    // Nor from session times that are not times: the cap is never skipped.
    expect(checkSessionExpiry(start + 30 * HOUR, { startedAt: NaN }, start)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkSessionExpiry(start + HOUR, { startedAt: start, currentExpiresAt: NaN }, start)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkSessionExpiry(start + HOUR, { startedAt: start }, NaN)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkSessionExpiry(start + HOUR, { startedAt: start }, start + 0.5)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkGuestExpiry(null, start + HOUR, start + 0.5)).toMatchObject({ ok: false, code: 'INVALID' });
  });
});

describe('guest expiry', () => {
  const sessionEnds = start + 2 * HOUR;

  it('allows no grant of its own, or one ending within the session', () => {
    expect(checkGuestExpiry(null, sessionEnds, start)).toEqual({ ok: true, expiresAt: null });
    expect(checkGuestExpiry(start + 30 * MIN, sessionEnds, start)).toEqual({ ok: true, expiresAt: start + 30 * MIN });
    expect(checkGuestExpiry(sessionEnds, sessionEnds, start)).toEqual({ ok: true, expiresAt: sessionEnds });
  });

  it('grants nothing once the session or the guest’s own access has ended', () => {
    // Not even clearing a deadline, at the moment the session ends, whatever the guest's own grant.
    expect(checkGuestExpiry(null, sessionEnds, sessionEnds)).toMatchObject({ ok: false, code: 'ENDED' });
    expect(checkGuestExpiry(null, sessionEnds, sessionEnds, sessionEnds + HOUR)).toMatchObject({ ok: false, code: 'ENDED' });
    expect(checkGuestExpiry(start + HOUR, sessionEnds, start + 30 * MIN, start + 30 * MIN)).toMatchObject({ ok: false, code: 'ENDED' });
    expect(checkGuestExpiry(null, sessionEnds, start + 30 * MIN, start + 30 * MIN)).toMatchObject({ ok: false, code: 'ENDED' });
    // A grant still running may be extended or cleared.
    expect(checkGuestExpiry(start + HOUR, sessionEnds, start + 10 * MIN, start + 30 * MIN)).toEqual({ ok: true, expiresAt: start + HOUR });
    expect(checkGuestExpiry(null, sessionEnds, start + 10 * MIN, start + 30 * MIN)).toEqual({ ok: true, expiresAt: null });
  });

  it('refuses a grant past the session, already passed, or not a time', () => {
    expect(checkGuestExpiry(sessionEnds + 1, sessionEnds, start)).toMatchObject({ ok: false, code: 'TOO_LONG' });
    expect(checkGuestExpiry(start, sessionEnds, start)).toMatchObject({ ok: false, code: 'PAST' });
    expect(checkGuestExpiry('soon', sessionEnds, start)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkGuestExpiry(undefined, sessionEnds, start)).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('ends a guest at its own grant or the session’s end, whichever is sooner', () => {
    expect(guestAccessEndsAt(null, sessionEnds)).toBe(sessionEnds);
    expect(guestAccessEndsAt(undefined, sessionEnds)).toBe(sessionEnds);
    expect(guestAccessEndsAt(start + MIN, sessionEnds)).toBe(start + MIN);
    // A session shortened after the grant ends the guest with it.
    expect(guestAccessEndsAt(sessionEnds, start + HOUR)).toBe(start + HOUR);
  });

  it('detects expired grants at the very moment they end', () => {
    expect(isExpired(start + MIN, start + MIN - 1)).toBe(false);
    expect(isExpired(start + MIN, start + MIN)).toBe(true);
    expect(isGuestExpired(start + MIN, sessionEnds, start + MIN)).toBe(true);
    expect(isGuestExpired(start + MIN, sessionEnds, start)).toBe(false);
    expect(isGuestExpired(null, sessionEnds, sessionEnds - 1)).toBe(false);
    expect(isGuestExpired(null, sessionEnds, sessionEnds)).toBe(true);
    // A session shortened below a guest's own deadline ends the guest with it.
    expect(isGuestExpired(sessionEnds + HOUR, sessionEnds, sessionEnds)).toBe(true);
    expect(isGuestExpired(sessionEnds + HOUR, sessionEnds, sessionEnds - 1)).toBe(false);
  });

  it('decides nothing from times that are not times', () => {
    expect(checkGuestExpiry(null, NaN, start)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkGuestExpiry(start + MIN, sessionEnds, NaN)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(checkGuestExpiry(start + MIN, sessionEnds, start, 1.5)).toMatchObject({ ok: false, code: 'INVALID' });
  });
});
