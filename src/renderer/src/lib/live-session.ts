import type { LiveHostState, LiveRun } from '@shared/api';
import { sessionDeadline, type SessionDuration } from '@shared/live/expiry';
import { MAX_ID_LENGTH, MAX_VIEWPORT_WIDTH, MIN_VIEWPORT_WIDTH, type GuestRole } from '@shared/live/limits';
import type { Participant, Presence } from '@shared/live/messages';
import { isPreviewTarget } from '@shared/live/preview';

/**
 * What the toolbar's Share control shows of the host's live session (src/main/live/host.ts runs it): the pill, the
 * time left, the choices for extending the session and a guest's access, and where the host is for guests following
 * it. Times are on the relay's clock: `at` is the relay's time now (see RelayClock), never this computer's.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A session that has a room: running, or taking its room back after the relay connection dropped. */
export type LiveRoomState = Extract<LiveHostState, { phase: 'active' | 'reconnecting' }>;
export type WaitingGuest = Extract<Participant, { status: 'pending' }>;
export type AdmittedGuest = Extract<Participant, { status: 'admitted' }>;

export const IDLE_LIVE: LiveHostState = { phase: 'idle', lastError: null };

export const hasRoom = (state: LiveHostState): state is LiveRoomState => state.phase === 'active' || state.phase === 'reconnecting';

/** The session a command names, or null while there is none. */
export const liveRun = (state: LiveHostState): LiveRun | null => (state.phase === 'idle' ? null : { workspaceKey: state.workspaceKey, runId: state.runId });

/** Whether two states are the same session (a command for one never reaches the other). */
export const sameRun = (a: LiveRun | null, b: LiveRun | null) => !!a && !!b && a.workspaceKey === b.workspaceKey && a.runId === b.runId;

/**
 * Whether `state` is for the project opening the editor shows. A state for an opening that has gone (a late event
 * from the session that closed with it) shows as no session at all.
 */
export const liveFor = (state: LiveHostState, workspaceKey: string | null | undefined): LiveHostState => (state.phase === 'idle' || state.workspaceKey === workspaceKey ? state : IDLE_LIVE);

export const DURATION_CHOICES: ReadonlyArray<{ id: SessionDuration; label: string }> = [
  { id: '30m', label: '30 minutes' },
  { id: '2h', label: '2 hours' },
  { id: '8h', label: '8 hours' },
  { id: 'project', label: 'Until project closes' }
];

export const ROLE_LABELS: Readonly<Record<GuestRole, string>> = { viewer: 'Viewer', collaborator: 'Collaborator' };

/**
 * The relay's clock, read when a state arrived and carried forward on this computer's monotonic clock, so a change to
 * this computer's clock between states moves no countdown and no grant.
 */
export interface RelayClock {
  relayAt: number;
  monoAt: number;
}
export const readRelayClock = (state: LiveRoomState, now = Date.now(), mono = performance.now()): RelayClock => ({ relayAt: now + state.relayClockOffsetMs, monoAt: mono });
/** The relay's time now, from its clock as last read. */
export const relayNow = (clock: RelayClock, mono = performance.now()) => Math.round(clock.relayAt + (mono - clock.monoAt));

/** How long is left of the session, never below zero. */
export const remainingMs = (state: LiveRoomState, at: number) => Math.max(0, state.expiresAt - at);

/** A span as the toolbar says it: `1h 05m`, `12m`, `45s`. Rounded up, so a session never reads as over before it is. */
export function formatSpan(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < MINUTE) return `${Math.ceil(ms / 1000)}s`;
  const minutes = Math.ceil(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** A span in words, for screen readers and titles: `1 hour 5 minutes`, `12 minutes`, `45 seconds`. */
export function spanWords(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms < MINUTE) return plural(Math.max(0, Math.ceil(ms / 1000)), 'second');
  const minutes = Math.ceil(ms / MINUTE);
  if (minutes < 60) return plural(minutes, 'minute');
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

/** How often the time left should be redrawn: every second in its last minute, otherwise as each minute turns. */
export function tickMs(state: LiveRoomState, at: number): number {
  const left = remainingMs(state, at);
  if (left <= MINUTE) return 1000;
  // Wake as the rounded-up minute changes, and never wait long.
  return Math.min(MINUTE, (left % MINUTE || MINUTE) + 50);
}

export const waitingGuests = (state: LiveHostState): WaitingGuest[] => (hasRoom(state) ? state.participants.filter((p): p is WaitingGuest => p.status === 'pending') : []);
export const admittedGuests = (state: LiveHostState): AdmittedGuest[] => (hasRoom(state) ? state.participants.filter((p): p is AdmittedGuest => p.status === 'admitted') : []);

/** What the Share button says: its text, the fuller words for its name, and its weight. */
export interface LivePill {
  kind: 'idle' | 'busy' | 'live' | 'reconnecting';
  text: string;
  label: string;
}

export function livePill(state: LiveHostState, at: number): LivePill {
  switch (state.phase) {
    case 'idle':
      return { kind: 'idle', text: 'Share', label: 'Share: start a live session' };
    case 'starting':
      return { kind: 'busy', text: 'Starting…', label: 'Share: the live session is starting' };
    case 'stopping':
      return { kind: 'busy', text: 'Ending…', label: 'Share: the live session is ending' };
    case 'reconnecting':
      return { kind: 'reconnecting', text: 'Reconnecting', label: 'Share: the live session is reconnecting to the relay' };
    case 'active': {
      const people = admittedGuests(state).length;
      const waiting = waitingGuests(state).length;
      const left = remainingMs(state, at);
      const timed = state.duration !== 'project';
      const words = [`${people} ${people === 1 ? 'guest' : 'guests'}`, ...(waiting ? [`${waiting} waiting to join`] : []), ...(timed ? [`${spanWords(left)} left`] : [])];
      return { kind: 'live', text: timed ? `Live · ${formatSpan(left)}` : 'Live', label: `Share: live session, ${words.join(', ')}` };
    }
  }
}

export interface TimeChoice {
  label: string;
  /** On the relay's clock; null for no end of its own. */
  expiresAt: number | null;
}

/**
 * How far the session can be extended: by 30 minutes, 1, 2 or 8 hours, or to the 24-hour cap, each only while it
 * stays within the cap (a session is never quietly cut short to fit). Nothing for a session that already lasts as
 * long as it can.
 */
export function extendChoices(state: LiveRoomState): TimeChoice[] {
  const cap = sessionDeadline(state.startedAt);
  const steps: Array<[number, string]> = [
    [30 * MINUTE, '30 minutes more'],
    [HOUR, '1 hour more'],
    [2 * HOUR, '2 hours more'],
    [8 * HOUR, '8 hours more']
  ];
  const choices: TimeChoice[] = steps.filter(([ms]) => state.expiresAt + ms <= cap).map(([ms, label]) => ({ label, expiresAt: state.expiresAt + ms }));
  if (cap > state.expiresAt && !choices.some((c) => c.expiresAt === cap)) choices.push({ label: 'To the 24-hour limit', expiresAt: cap });
  return choices;
}

/** A time of day on the relay's clock, as this computer shows it. */
export const clockTime = (state: LiveRoomState, at: number) => new Date(at - state.relayClockOffsetMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The ends a guest's own access can be given: until the session ends, or for 15 or 30 minutes, 1 or 2 hours from now,
 * each only while it ends before the session does. Read at the moment one is picked, so "for 15 minutes" means from then.
 */
export function guestExpiryChoices(state: LiveRoomState, at: number): Array<TimeChoice & { id: string }> {
  const steps: Array<[string, number, string]> = [
    ['15m', 15 * MINUTE, 'For 15 minutes'],
    ['30m', 30 * MINUTE, 'For 30 minutes'],
    ['1h', HOUR, 'For 1 hour'],
    ['2h', 2 * HOUR, 'For 2 hours']
  ];
  return [{ id: 'session', label: 'Whole session', expiresAt: null }, ...steps.filter(([, ms]) => at + ms < state.expiresAt).map(([id, ms, label]) => ({ id, label, expiresAt: at + ms }))];
}

/** How long a guest has left, in words, or null when its access lasts as long as the session. */
export function guestTimeLeft(state: LiveRoomState, guest: AdmittedGuest, at: number): string | null {
  if (guest.guestExpiresAt === null || guest.guestExpiresAt >= state.expiresAt) return null;
  return `${formatSpan(Math.max(0, guest.guestExpiresAt - at))} left`;
}

/** What a screen reader hears when guests start waiting: their names, together when they asked at once. */
export function joinNotice(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} wants to join the live session`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} want to join the live session`;
}

/**
 * Where the host is in the editor, for guests following it: the page the canvas shows (`pageId`, null for a view that
 * is not one page, such as a collection's layout) and its address in the preview (`route`, null when the canvas shows
 * nothing the preview serves, such as a component edited everywhere), at the canvas's width. An ID or address guests
 * could not follow is sent as none.
 */
export function hostPresence(view: { pageId: string | null; route: string | null }, viewport: number): Presence {
  const width = Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.round(Number.isFinite(viewport) ? viewport : MIN_VIEWPORT_WIDTH)));
  const pageId = view.pageId && view.pageId.length <= MAX_ID_LENGTH ? view.pageId : null;
  return { pageId, viewportWidth: width, selection: null, previewPath: view.route === null ? null : previewPathOf(view.route) };
}

/** An address as a URL serializes its path and query (so it compares equal to what a guest's browser reports), or null. */
export function previewPathOf(route: string): string | null {
  const base = 'http://preview.invalid';
  try {
    const url = new URL(route, base);
    const path = `${url.pathname}${url.search}`;
    return url.origin === base && route.startsWith('/') && isPreviewTarget(path) && /^[\x21-\x7e]+$/.test(path) && !/["<>`{}]/.test(path) ? path : null;
  } catch {
    return null;
  }
}

/** Whether to send a presence: only a change from what was last sent, for the same session. */
export const presenceKey = (run: LiveRun, presence: Presence) => `${run.workspaceKey}\n${run.runId}\n${JSON.stringify(presence)}`;
