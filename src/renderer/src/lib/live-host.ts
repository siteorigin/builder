import type { LiveCommandResult, LiveHostState, LiveJoinRequest, LiveRun } from '@shared/api';
import type { SessionDuration } from '@shared/live/expiry';
import { api, getState, setState, toast, useStore, type State } from '../store';
import { hasRoom, hostPresence, joinNotice, liveFor, liveRun, presenceKey, readRelayClock, sameRun, waitingGuests } from './live-session';
import { shownView } from './template-view';
import { postAt, postShown, postWorkspace } from './posts';
import { entryRoute } from '@shared/collections';

/**
 * The editor's side of hosting a live session: it follows the session the main process runs (src/main/live/host.ts),
 * starts one and copies its invite link, sends the host's commands for the session they were shown for, tells screen
 * readers who is waiting, and keeps guests following the host told where it is. The room as the relay last confirmed it
 * is the only roster: nothing here guesses at what a command will do.
 */

/** The session the editor shows: the main process's, while it is this opening's. */
export const shownLive = (s: Pick<State, 'live' | 'snapshot'>): LiveHostState => liveFor(s.live, s.snapshot?.workspaceKey);

/**
 * Take a state the main process sent. A running session's end that the host did not ask for is said once, in the
 * opening it belonged to; one that never started is said by its start (startLive).
 */
export function applyLiveState(next: LiveHostState): void {
  const s = getState();
  const prev = s.live;
  setState({ live: next, liveClock: hasRoom(next) ? readRelayClock(next) : null });
  if (next.phase === 'idle' && next.lastError && hasRoom(prev) && prev.workspaceKey === s.snapshot?.workspaceKey) toast(next.lastError, 'info');
}

let noticeId = 0;
let waiting: LiveJoinRequest[] = [];
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A guest started waiting. Screen readers hear its name, once; guests asking at the same moment are named together,
 * so no one's request is lost to the next. What is shown comes from the roster, never from this.
 */
export function applyLiveRequest(request: LiveJoinRequest): void {
  const s = getState();
  if (!sameRun(liveRun(s.live), request) || request.workspaceKey !== s.snapshot?.workspaceKey) return;
  waiting.push(request);
  if (noticeTimer) return;
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    const asked = waiting;
    waiting = [];
    // Only those still waiting by now, in the session they asked to join: one let in or gone meanwhile is not news.
    const now = shownLive(getState());
    const still = new Set(waitingGuests(now).map((g) => g.guestId));
    const text = joinNotice(asked.filter((r) => sameRun(liveRun(now), r) && still.has(r.guestId)).map((r) => r.displayName));
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
    waiting = [];
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

/**
 * Copy the invite link. Success shows at the Copy button itself (SharePopover), so only a failure is said here, with
 * what to do instead.
 */
export async function copyInvite(inviteUrl: string): Promise<boolean> {
  if (await copyText(inviteUrl)) return true;
  toast('The invite link could not be copied. Select it in Share and copy it from there.', 'error');
  return false;
}

/**
 * Start a live session of the open project, and copy its invite link once it has started. A start answered after the
 * project has closed or switched copies nothing: that link is for a session that has already ended.
 */
export async function startLive(duration: SessionDuration): Promise<boolean> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening) return false;
  const attempt = ++starts;
  let result;
  try {
    result = await api.live.start({ opening, duration });
  } catch (e) {
    if (getState().snapshot?.workspaceKey === opening) toast(`The live session could not start: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
  if (!result.ok) {
    // A start the host called off (Cancel), or one its project closed under, is not a failure to report.
    if (cancelled !== attempt && getState().snapshot?.workspaceKey === opening) toast(result.message, 'error');
    return false;
  }
  const started = liveRun(result.state);
  const now = getState();
  if (now.snapshot?.workspaceKey !== opening || (now.live.phase !== 'idle' && !sameRun(liveRun(now.live), started))) return false;
  if (await copyText(result.inviteUrl)) {
    lastCopied = { inviteUrl: result.inviteUrl, at: Date.now() };
    for (const fn of startCopied) fn(lastCopied.inviteUrl, lastCopied.at);
    toast('Live session started. Invite link copied.', 'success');
  }
  else toast('Live session started. The invite link could not be copied: copy it from Share.', 'info');
  return true;
}

let starts = 0;
let cancelled = 0;

/** The link a start copied, and when: the room it opens on shows that proof at its Copy button too. */
let lastCopied: { inviteUrl: string; at: number } | null = null;
const startCopied = new Set<(inviteUrl: string, at: number) => void>();
/** Hear of each link a start copies, as it is copied. Returns the unsubscriber. */
export function onStartCopied(fn: (inviteUrl: string, at: number) => void): () => void {
  startCopied.add(fn);
  return () => void startCopied.delete(fn);
}
/** When the start copied this link, if it was within `ms`. */
export const copiedAtStart = (inviteUrl: string, ms: number): number => (lastCopied?.inviteUrl === inviteUrl && Date.now() - lastCopied.at < ms ? lastCopied.at : 0);

/** Call off a session still starting: its start then ends quietly. */
export function cancelStart(run: LiveRun): Promise<boolean> {
  cancelled = starts;
  return liveCommand(run, (r) => api.live.stop(r));
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

/**
 * Where the host is, from the editor's state: what the canvas shows, at its width. A post previewed is its address (or
 * wherever its visitor went on to); under the post writer, or with a component edited everywhere, the canvas shows no
 * place of the site, so none is sent.
 */
export function presenceOf(s: Pick<State, 'snapshot' | 'pageId' | 'templateMode' | 'definitionMode' | 'viewport' | 'leftTab' | 'postView' | 'mode' | 'post' | 'postPreviewAt'>) {
  const state = s.snapshot?.state;
  const none = hostPresence({ pageId: null, route: null }, s.viewport);
  if (!state || s.definitionMode) return none;
  const posts = postWorkspace(s);
  if (posts === 'write') return none;
  if (posts === 'preview') {
    if (s.postPreviewAt !== null) {
      const shown = postShown(state, 'preview', s.post, s.postPreviewAt);
      if (shown.kind === 'page') return hostPresence({ pageId: shown.pageId, route: state.pages[shown.pageId].route }, s.viewport);
      return hostPresence({ pageId: null, route: s.postPreviewAt }, s.viewport);
    }
    const entry = postAt(state, s.post);
    const collection = s.post && Object.hasOwn(state.collections ?? {}, s.post.collectionId) ? state.collections[s.post.collectionId] : undefined;
    return hostPresence({ pageId: null, route: entry && collection ? (entryRoute(collection, entry) ?? null) : null }, s.viewport);
  }
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
    const changed =
      !sameRun(liveRun(was), liveRun(live)) ||
      s.snapshot?.state !== prev.snapshot?.state ||
      s.pageId !== prev.pageId ||
      s.templateMode !== prev.templateMode ||
      s.definitionMode !== prev.definitionMode ||
      s.viewport !== prev.viewport ||
      s.leftTab !== prev.leftTab ||
      s.postView !== prev.postView ||
      s.mode !== prev.mode ||
      s.post !== prev.post ||
      s.postPreviewAt !== prev.postPreviewAt;
    if (!changed || timer) return;
    timer = setTimeout(flush, PRESENCE_DELAY_MS);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
