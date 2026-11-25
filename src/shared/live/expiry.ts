/**
 * When a live session and each guest's access end. Times are milliseconds since the epoch, as `Date.now()` gives
 * them, and every helper takes `now` so the host, the relay and tests all decide alike.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** No session lasts longer than this from when it started, however it is extended. */
export const MAX_SESSION_MS = 24 * HOUR;

/**
 * The durations a host chooses from. `project` lasts until the host closes the project, which the host ends itself;
 * the relay still ends it at the 24-hour cap.
 */
export const SESSION_DURATION_IDS = ['30m', '2h', '8h', 'project'] as const;
export type SessionDuration = (typeof SESSION_DURATION_IDS)[number];
export const SESSION_DURATIONS: Readonly<Record<SessionDuration, number>> = { '30m': 30 * MINUTE, '2h': 2 * HOUR, '8h': 8 * HOUR, project: MAX_SESSION_MS };

export function isSessionDuration(value: unknown): value is SessionDuration {
  return typeof value === 'string' && Object.hasOwn(SESSION_DURATIONS, value);
}

/** The latest a session started at `startedAt` may end. */
export function sessionDeadline(startedAt: number): number {
  return startedAt + MAX_SESSION_MS;
}

/** When a session started at `startedAt` with the chosen duration ends. */
export function sessionExpiresAt(duration: SessionDuration, startedAt: number): number {
  return startedAt + SESSION_DURATIONS[duration];
}

export type ExpiryProblem = { ok: false; code: 'INVALID' | 'PAST' | 'TOO_LONG' | 'ENDED'; message: string };
export type ExpiryCheck = { ok: true; expiresAt: number } | ExpiryProblem;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Whether a session may be set to end at `expiresAt`, on creation or when the host extends or shortens it: a whole
 * number of milliseconds, still ahead at `now`, and within 24 hours of when the session started (never of now, so
 * extending late in a session cannot stretch it). `currentExpiresAt` is the session's end before this change: a session
 * that has already ended is never renewed. Never moved to fit: a host asking for more than the cap is told so.
 */
export function checkSessionExpiry(expiresAt: unknown, session: { startedAt: number; currentExpiresAt?: number }, now: number): ExpiryCheck {
  if (!isTime(expiresAt)) return { ok: false, code: 'INVALID', message: 'The end of the session is not a time.' };
  if (session.currentExpiresAt !== undefined && isExpired(session.currentExpiresAt, now)) return { ok: false, code: 'ENDED', message: 'The session has already ended.' };
  if (expiresAt <= now) return { ok: false, code: 'PAST', message: 'The session cannot end in the past.' };
  if (expiresAt > sessionDeadline(session.startedAt)) return { ok: false, code: 'TOO_LONG', message: 'A live session can last at most 24 hours.' };
  return { ok: true, expiresAt };
}

/**
 * Whether a guest's own access may end at `expiresAt` in a session ending at `sessionExpiresAt`, when the host admits
 * the guest or changes its grant. `null` is no grant of its own: the guest stays until the session ends. A grant never
 * outlasts its session: one asked for past the session's end is refused, never quietly shortened. Nothing is granted
 * once the session has ended, nor, given `currentExpiresAt` (the guest's grant before this change), to a guest whose
 * access has already ended.
 */
export function checkGuestExpiry(expiresAt: unknown, sessionExpiresAt: number, now: number, currentExpiresAt?: number | null): { ok: true; expiresAt: number | null } | ExpiryProblem {
  if (expiresAt !== null && !isTime(expiresAt)) return { ok: false, code: 'INVALID', message: 'The end of the guest’s access is not a time.' };
  if (isExpired(sessionExpiresAt, now)) return { ok: false, code: 'ENDED', message: 'The session has already ended.' };
  if (currentExpiresAt !== undefined && isGuestExpired(currentExpiresAt, sessionExpiresAt, now)) return { ok: false, code: 'ENDED', message: 'The guest’s access has already ended.' };
  if (expiresAt === null) return { ok: true, expiresAt: null };
  if (expiresAt <= now) return { ok: false, code: 'PAST', message: 'A guest’s access cannot end in the past.' };
  if (expiresAt > sessionExpiresAt) return { ok: false, code: 'TOO_LONG', message: 'A guest’s access cannot outlast the session.' };
  return { ok: true, expiresAt };
}

/** When a guest's access really ends: its own grant or the session's end, whichever is sooner. */
export function guestAccessEndsAt(guestExpiresAt: number | null | undefined, sessionExpiresAt: number): number {
  return typeof guestExpiresAt === 'number' ? Math.min(guestExpiresAt, sessionExpiresAt) : sessionExpiresAt;
}

/** Whether something that ends at `expiresAt` has ended at `now`. It ends at that very moment. */
export function isExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

/** Whether a guest's access has ended at `now`, by its own grant or by its session's end. */
export function isGuestExpired(guestExpiresAt: number | null | undefined, sessionExpiresAt: number, now: number): boolean {
  return isExpired(guestAccessEndsAt(guestExpiresAt, sessionExpiresAt), now);
}
