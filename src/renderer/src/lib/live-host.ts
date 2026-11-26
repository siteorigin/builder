import type { LiveCommandResult, LiveHostState, LiveJoinRequest, LiveRun } from '@shared/api';
import type { SessionDuration } from '@shared/live/expiry';
import { api, getState, setState, toast, useStore, type State } from '../store';
import { hasRoom, hostPresence, joinNotice, liveFor, liveRun, presenceKey, readRelayClock, sameRun, waitingGuests } from './live-session';
import { shownView } from './template-view';

/**
 * The editor's side of hosting a live session: it follows the session the main process runs (src/main/live/host.ts),
 * starts one and copies its invite link, sends the host's commands for the session they were shown for, tells screen
 * readers who is waiting, and keeps guests following the host told where it is. The room as the relay last confirmed it
 * is the only roster: nothing here guesses at what a command will do.
 */

/** The session the editor shows: the main process's, while it is this opening's. */
export const shownLive = (s: Pick<State, 'live' | 'snapshot'>): LiveHostState => liveFor(s.live, s.snapshot?.workspaceKey);

/** Take a state the main process sent. A room's end that the host did not ask for is said once. */
export function applyLiveState(next: LiveHostState): void {
  const prev = getState().live;
  setState({ live: next, liveClock: hasRoom(next) ? readRelayClock(next) : null });
  if (next.phase === 'idle' && prev.phase !== 'idle' && next.lastError) toast(next.lastError, 'info');
}

let noticeId = 0;
let waitingNames: string[] = [];
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A guest started waiting. Screen readers hear its name, once; guests asking at the same moment are named together,
 * so no one's request is lost to the next. What is shown comes from the roster, never from this.
 */
export function applyLiveRequest(request: LiveJoinRequest): void {
  const s = getState();
  if (!sameRun(liveRun(s.live), request) || request.workspaceKey !== s.snapshot?.workspaceKey) return;
  waitingNames.push(request.displayName);
  if (noticeTimer) return;
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    const names = waitingNames;
    waitingNames = [];
    // Only those still waiting by now: one let in or gone meanwhile is not news.
    const still = new Set(waitingGuests(getState().live).map((g) => g.displayName));
    const text = joinNotice(names.filter((n) => still.has(n)));
    if (text) setState({ liveNotice: { id: ++noticeId, text } });
  }, 150);
}

/**
 * Follow the session from the main process: its events, and what it is doing now for an editor opened while one runs.
 * The answer to that question is dropped if an event has arrived since, as the event is newer. Returns the unsubscribers.
 */
export function followLive(): Array<() => void> {
  let events = 0;
  const offs = [
    api.on('live:state', (state) => {
      events++;
      applyLiveState(state);
    }),
    api.on('live:request', applyLiveRequest)
  ];
  let gone = false;
  void api.live
    .state()
    .then((state) => !gone && events === 0 && setState({ live: state, liveClock: hasRoom(state) ? readRelayClock(state) : null }))
    .catch(() => undefined);
  offs.push(() => {
    gone = true;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    waitingNames = [];
  });
  return offs;
}

/** Copy text to the clipboard; false when the clipboard would not take it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy the invite link, and say what happened. */
export async function copyInvite(inviteUrl: string): Promise<void> {
  if (await copyText(inviteUrl)) toast('Invite link copied', 'success');
  else toast('The invite link could not be copied. Select it in Share and copy it from there.', 'error');
}

/**
 * Start a live session of the open project, and copy its invite link once it has started. A start answered after the
 * project has closed or switched copies nothing: that link is for a session that has already ended.
 */
export async function startLive(duration: SessionDuration): Promise<boolean> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening) return false;
  let result;
  try {
    result = await api.live.start({ opening, duration });
  } catch (e) {
    toast(`The live session could not start: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
  if (!result.ok) {
    toast(result.message, 'error');
    return false;
  }
  const started = liveRun(result.state);
  const now = getState();
  if (now.snapshot?.workspaceKey !== opening || (now.live.phase !== 'idle' && !sameRun(liveRun(now.live), started))) return false;
  if (await copyText(result.inviteUrl)) toast('Live session started. Invite link copied.', 'success');
  else toast('Live session started. The invite link could not be copied: copy it from Share.', 'info');
  return true;
}

/**
 * Send a host command for the session it was shown for. Sent means on its way: the relay's next roster or room state
 * shows it taking effect, and what the relay refuses comes back as the session's last error. A command the main
 * process refused is said at once.
 */
export async function liveCommand(run: LiveRun, send: (run: LiveRun) => Promise<LiveCommandResult>): Promise<boolean> {
  let result: LiveCommandResult;
  try {
    result = await send(run);
  } catch (e) {
    result = { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!result.ok && sameRun(liveRun(getState().live), run)) toast(result.message, 'error');
  return result.ok;
}

/** How long a burst of changes (a width being dragged) waits before guests are told where the host ended up. */
export const PRESENCE_DELAY_MS = 150;

/** Where the host is, from the editor's state: the view the canvas shows, at its width. */
export function presenceOf(s: Pick<State, 'snapshot' | 'pageId' | 'templateMode' | 'definitionMode' | 'viewport'>) {
  const state = s.snapshot?.state;
  if (!state || s.definitionMode) return hostPresence({ pageId: null, route: null }, s.viewport);
  const view = shownView(state, s.pageId, s.templateMode);
  return hostPresence({ pageId: view && !view.template ? view.key : null, route: view?.route ?? null }, s.viewport);
}

/**
 * Keep guests following the host told where it is, while this opening hosts a session: once when it starts, and after
 * every change of page, address or width, a moment after the changes stop. The main process keeps the latest and sends
 * it again whenever the room is taken back. Returns the unsubscriber.
 */
export function syncPresence(): () => void {
  let sent: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const s = getState();
    const live = shownLive(s);
    const run = liveRun(live);
    if (!run || live.phase === 'stopping') return;
    const presence = presenceOf(s);
    const key = presenceKey(run, presence);
    if (key === sent) return;
    sent = key;
    void api.live.presence(run, presence).catch(() => undefined);
  };
  const off = useStore.subscribe((s, prev) => {
    const live = shownLive(s);
    if (live.phase === 'idle') {
      sent = null;
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    const was = shownLive(prev);
    const changed = !sameRun(liveRun(was), liveRun(live)) || s.snapshot?.state !== prev.snapshot?.state || s.pageId !== prev.pageId || s.templateMode !== prev.templateMode || s.definitionMode !== prev.definitionMode || s.viewport !== prev.viewport;
    if (!changed || timer) return;
    timer = setTimeout(flush, PRESENCE_DELAY_MS);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
