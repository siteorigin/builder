/**
 * The guest's viewer for a live session: the page behind an invite link. A guest gives a name, waits in the room until
 * the host lets them in, then watches the host's site live in a frame on the room's own preview origin.
 *
 * The relay's guest socket (`/s/<roomId>/ws`) carries everything: the guest's place and status, the host's presence
 * and reloads. Once admitted, the guest's preview ticket is redeemed on the preview origin for its cookie, and only
 * then is the frame made. The page keeps no cookies of its own; its place in the room (the name and the resume token
 * the relay gave it) lives in this tab's sessionStorage, so a reload or a dropped connection takes the same place
 * back. When the guest's access ends for any reason, the frame is removed at once.
 *
 * Notes (#770): the host's pinned notes are listed in the Notes panel, and a guest leaves one on the page its frame
 * shows, through the relay as a call to the host (`notes.list`, `notes.add`). The host checks and keeps them; this page
 * keeps nothing of them once the guest's access ends.
 */
import { BRIDGE_MESSAGES, CLOSE_CODES, isFramePath, isSpotlightPath, MAX_ID_LENGTH, MAX_SELECTION_DEPTH, normalizeDisplayName, PREVIEW_ADMISSION_PATH, VIEWPORTS } from './shared.js';

const root = /** @type {HTMLElement} */ (document.getElementById('live-session'));
const config = {
  roomId: root.dataset.roomId ?? '',
  socketUrl: root.dataset.socketUrl ?? '',
  previewOrigin: root.dataset.previewOrigin ?? '',
  inviteLink: root.dataset.inviteLink ?? '',
  version: Number(root.dataset.protocolVersion),
  nameMax: Number(root.dataset.nameMax),
  noteMax: Number(root.dataset.noteMax)
};
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const ui = {
  bar: $('bar'),
  barMeta: /** @type {HTMLElement} */ (root.querySelector('.bar-meta')),
  barControls: $('bar-controls'),
  barMore: $('bar-more'),
  panelRole: $('panel-role'),
  title: $('site-title'),
  siteRole: $('site-role'),
  connection: $('connection'),
  role: $('role'),
  time: $('time'),
  follow: /** @type {HTMLInputElement} */ ($('follow')),
  point: /** @type {HTMLButtonElement} */ ($('point')),
  pointHint: $('point-hint'),
  viewports: /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[data-viewport]')]),
  openInBuilder: $('copy-invite'),
  handoff: $('handoff'),
  handoffText: $('handoff-text'),
  handoffLink: /** @type {HTMLInputElement} */ ($('handoff-link')),
  handoffCopy: $('handoff-copy'),
  handoffClose: $('handoff-close'),
  hostNote: $('host-note'),
  stage: $('stage'),
  frame: $('frame'),
  veil: $('veil'),
  veilGlyph: $('veil-glyph'),
  veilTitle: $('veil-title'),
  veilText: $('veil-text'),
  veilTime: $('veil-time'),
  handoffTitle: $('handoff-title'),
  veilAction: /** @type {HTMLButtonElement} */ ($('veil-action')),
  screen: $('screen'),
  screenGlyph: $('screen-glyph'),
  screenTitle: $('screen-title'),
  screenText: $('screen-text'),
  form: /** @type {HTMLFormElement} */ ($('join')),
  name: /** @type {HTMLInputElement} */ ($('name')),
  nameError: $('name-error'),
  joinButton: /** @type {HTMLButtonElement} */ ($('join-button')),
  next: $('screen-next'),
  actions: $('screen-actions'),
  action: /** @type {HTMLButtonElement} */ ($('screen-action')),
  cancel: /** @type {HTMLButtonElement} */ ($('screen-cancel')),
  announcer: $('announce'),
  notesButton: $('notes-button'),
  notesCount: $('notes-count'),
  notes: $('notes'),
  notesTitle: $('notes-title'),
  notesClose: $('notes-close'),
  noteForm: /** @type {HTMLFormElement} */ ($('note-form')),
  noteWhere: $('note-where'),
  noteText: /** @type {HTMLTextAreaElement} */ ($('note-text')),
  noteLength: $('note-length'),
  noteSend: /** @type {HTMLButtonElement} */ ($('note-send')),
  noteError: $('note-error'),
  notesOff: $('notes-off'),
  noteList: $('note-list')
};

/** How long the viewer keeps trying to take its place back after its socket drops: a little past the relay's grace. */
const RECONNECT_FOR_MS = 150_000;
/** How long a reload waits for the bridge to answer before the frame is pointed at its page again instead. */
const RELOAD_FALLBACK_MS = 1500;
/** How long a ticket's redemption may take before it is given up; a ticket is good for a minute. */
const REDEEM_TIMEOUT_MS = 15_000;
/**
 * The least time between two spotlights this page sends (#768): a click at a time, never a stream. The relay drops
 * any that come faster still.
 */
const POINT_GAP_MS = 500;
/** What the preview frame may do: run the site as its own origin, but never navigate the viewer away. */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

// ---------------------------------------------------------------------------
// State

/**
 * Where the guest is. `name` asks for a name; `connecting`, `pending` and `admitted` are on the way in or in; every
 * other phase is a screen the guest stays on until they act: the room turned them away, they left it, or it ended.
 * @typedef {'name' | 'connecting' | 'pending' | 'admitted' | 'unavailable' | 'lost' | 'replaced' | 'full' | 'locked' | 'declined' | 'kicked' | 'expired-guest' | 'expired-session' | 'ended' | 'host-gone' | 'error'} Phase
 */
/** @type {Phase} */
let phase = 'name';
/** The guest's place in the room: its name, and once the relay has given one, the token that takes the place back. */
/** @type {{ displayName: string; resumeToken?: string } | null} */
let place = loadPlace();
/** @type {WebSocket | null} */
let socket = null;
/** Bumped for every new socket, so frames and closes from an old one are ignored. */
let socketId = 0;
/** Bumped whenever the guest's access may have changed under it (a dropped socket, an ending), so late work stops. */
let grant = 0;
/** @type {{ role: 'viewer' | 'collaborator'; projectName: string; guestExpiresAt: number | null } | null} */
let guest = null;
let sessionExpiresAt = 0;
/** The relay's clock at a moment of ours, so deadlines count down without trusting this device's clock. */
let clock = { relayNow: 0, at: 0 };
let hostConnected = true;
/** Whether this socket dropped and the viewer is taking its place back. */
let reconnecting = false;
let lostSince = 0;
let retries = 0;
/** What the last join on the current socket ran into, for the close that follows. */
let refusal = /** @type {'resume' | 'full' | null} */ (null);

/** @type {HTMLIFrameElement | null} */
let iframe = null;
/** Whether the preview cookie for the current grant is in place, so the frame may show the site. */
let previewReady = false;
let previewFailed = false;
/** Whether the frame has shown its first page since it was made: until then the guest is told it is opening. */
let frameShown = false;
/** Whether that first page is taking longer than it should: the guest is told so, and may try again. */
let frameSlow = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let frameShownFallback;
/** The page the frame is on, as its bridge last said or as the viewer last pointed it. */
let framePath = '/';
/** Whether the guest's next click on the site points at what it lands on, for the host (#768). */
let pointing = false;
/** Whether the page in the frame has said its bridge is there, so pointing can work on it: a page without one cannot point. */
let bridgeReady = false;
/** When this page last sent a spotlight (performance.now()), so the next waits POINT_GAP_MS. */
let pointedAt = -Infinity;
/** @type {string | null} */
let queuedTicket = null;
let redeeming = false;
/** @type {AbortController | null} */
let redemption = null;
/** The last ticket taken up: the relay sends an unused ticket again with any grant update, and each is good once. */
/** @type {string | null} */
let lastTicket = null;
/** Whether the guest's access ran out on the relay's clock and the relay has not yet said otherwise. */
let pastDeadline = false;
/** Whether the frame may be behind the host: it was kept while the socket was down, when reloads could be missed. */
let stale = false;
/** Whether the guest was let in on this page, and the site's name then, so a final screen keeps the bar saying Ended. */
let wasAdmitted = false;
let siteTitle = '';

/** @type {{ previewPath: string | null; viewportWidth: number } | null} */
let hostPage = null;
/** Whether the frame goes where the host goes. Independent of its width: a phone can follow at its own width. */
let follow = true;
/**
 * The frame's width: the host's own (`host`), or a preset. A phone starts at the Mobile preset, where the host's
 * site is readable, rather than at the host's desktop width scaled down to a third of it.
 * @type {'host' | keyof typeof VIEWPORTS}
 */
const narrow = matchMedia('(max-width: 640px)');
const midsize = matchMedia('(max-width: 960px)');
/** The width a guest who has not chosen one gets: their phone's, a tablet's, or the host's on a wide screen. */
const defaultWidth = () => (narrow.matches ? 'mobile' : midsize.matches ? 'tablet' : 'host');
let width = defaultWidth();
/** Whether the guest picked a width themselves: until they do, the default follows the window (a phone turned). */
let widthChosen = false;
/** Whether the view has been drawn once: focus moves only on later changes, never when the page first opens. */
let started = false;
/** What the veil last said, so focus and announcements follow only a change. */
let veilShown = '';
/** The deadline warnings already given (minutes left), so each is announced once, and the deadline they were for. */
let warned = new Set();
let warnedFor = 0;

/** The page the frame shows, as its bridge last said (never where it was only pointed); null until it says. */
/** @type {string | null} */
let shownPath = null;

/**
 * The host's notes as last read, while the guest is in the room (null before they are read, and once it leaves), and
 * whether the host lets guests leave notes now. A note being written is pinned to the page shown when writing began.
 * @type {Array<{ id: string; text: string; authorName: string; createdAt: number; resolved: boolean }> | null}
 */
let notesList = null;
let guestNotes = true;
/** The notes are kept read while the guest is in: set on coming in, so a change told of during the first read counts. */
let notesWanted = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let notesRetry;
/**
 * How long a read of the notes the host refused (busy, or the relay's backlog) waits before it is asked again, doubling
 * each time, and how many times it is: a host that keeps refusing is asked no more until the next change it tells of.
 */
const NOTES_RETRY_MS = 1500;
const NOTES_RETRIES = 5;
let notesRetries = 0;
/** @type {Promise<void> | null} */
let notesLoading = null;
let notesAgain = false;
/** @type {string | null} */
let notePath = null;
let noteSending = false;
/**
 * A new note's page is confirmed when Notes opens (#1497): the frame's bridge is asked where it is, since the page the
 * guest sees may be newer than its last word, and until it answers the note has no page and cannot be begun (a word
 * typed meanwhile would be pinned to whatever page the answer names, even one shown only after it). The ask is
 * numbered, so an older word still on its way is never taken for the answer; a page whose bridge says nothing is
 * taken as last said.
 * @type {{ id: number; timer: ReturnType<typeof setTimeout> } | null}
 */
let pageAsk = null;
let pageAskSeq = 0;
const PAGE_ASK_MS = 1000;
/**
 * Calls to the host waiting for their answer, by request ID. IDs are never reused, so an answer to a call made on an
 * earlier socket can never be taken for one made since.
 * @type {Map<string, { method: string; resolve: (answer: any) => void; timer: ReturnType<typeof setTimeout> }>}
 */
const calls = new Map();
let callSeq = 0;
/** How long a call to the host may take before it is given up. */
const CALL_TIMEOUT_MS = 20_000;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reloadFallback;
/** @type {ReturnType<typeof setInterval> | undefined} */
let ticker;

// ---------------------------------------------------------------------------
// The guest's place, kept for this tab only

function storageKey() {
  return `siteorigin-live:${config.roomId}`;
}

/** @returns {{ displayName: string; resumeToken?: string } | null} */
function loadPlace() {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey()) || 'null');
    if (value && typeof value.displayName === 'string') return { displayName: value.displayName, ...(typeof value.resumeToken === 'string' ? { resumeToken: value.resumeToken } : {}) };
  } catch {
    // Storage may be unavailable (a private window, a blocked site); the place is then kept in memory only.
  }
  return null;
}

function savePlace() {
  try {
    if (place) sessionStorage.setItem(storageKey(), JSON.stringify(place));
    else sessionStorage.removeItem(storageKey());
  } catch {
    // As above: memory only.
  }
}

/** Give up the place for good: the next join is a new request, under the same name. */
function forgetPlace() {
  if (place) place = { displayName: place.displayName };
  savePlace();
}

// ---------------------------------------------------------------------------
// The socket

function connect() {
  if (!place) return setPhase('name');
  closeSocket();
  clearTimeout(reconnectTimer);
  const id = ++socketId;
  refusal = null;
  let ws;
  try {
    ws = new WebSocket(config.socketUrl);
  } catch {
    return setPhase('unavailable');
  }
  socket = ws;
  if (phase !== 'pending' && phase !== 'admitted') setPhase('connecting');
  ws.addEventListener('open', () => {
    if (id !== socketId || !place) return;
    send({ type: 'guest:join', version: config.version, displayName: place.displayName, ...(place.resumeToken ? { resumeToken: place.resumeToken } : {}) });
  });
  ws.addEventListener('message', (event) => {
    if (id !== socketId || typeof event.data !== 'string') return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame && typeof frame === 'object') onFrame(frame);
  });
  ws.addEventListener('close', (event) => {
    if (id !== socketId) return;
    socket = null;
    onClose(event.code);
  });
}

/** Close the current socket, if any, without treating it as a drop. */
function closeSocket() {
  const ws = socket;
  socket = null;
  socketId++;
  if (ws && ws.readyState <= WebSocket.OPEN) {
    try {
      ws.close(1000);
    } catch {
      // Already closing.
    }
  }
}

/** @param {object} frame */
function send(frame) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

/** @param {any} frame */
function onFrame(frame) {
  switch (frame.type) {
    case 'guest:status':
      return onStatus(frame);
    case 'host:availability': {
      const back = !hostConnected && frame.connected === true;
      hostConnected = frame.connected === true;
      // Whatever the frame loaded while the host was away failed; show the host's work again now it is back.
      if (back) refreshFrame();
      // The host answers nothing asked of the connection it lost: a note on its way may or may not have been kept.
      if (!hostConnected) failCalls('The host’s connection dropped.', true);
      if (back && notesWanted) void loadNotes();
      return render();
    }
    case 'room:state':
      if (typeof frame.expiresAt === 'number') sessionExpiresAt = frame.expiresAt;
      anchorClock(frame.now);
      return render();
    case 'preview:reload':
      return reloadPreview();
    case 'presence:changed':
      if (frame.participant?.kind !== 'host' || !frame.presence) return;
      hostPage = { previewPath: isFramePath(frame.presence.previewPath) ? frame.presence.previewPath : null, viewportWidth: Number(frame.presence.viewportWidth) || VIEWPORTS.desktop };
      applyFollow();
      return render();
    case 'protocol:error':
      if (frame.code === 'AUTH_FAILED' && place?.resumeToken) refusal = 'resume';
      else if (frame.code === 'ROOM_FULL') refusal = 'full';
      return;
    case 'rpc:response': {
      const call = calls.get(frame.requestId);
      if (!call || call.method !== frame.method) return;
      calls.delete(frame.requestId);
      clearTimeout(call.timer);
      // The host's own UNAVAILABLE may come after the change was saved (the disk failed as it finished): it counts as an
      // answer lost, so the guest looks before sending again.
      return call.resolve(frame.ok === true ? { ok: true, result: frame.result } : { ok: false, message: String(frame.error?.message ?? 'The host could not do that.'), lost: frame.error?.code === 'UNAVAILABLE' });
    }
    case 'rpc:event':
      // The notes changed, or whether guests may leave them: read again, once they have been read at all.
      if (frame.event === 'notes:changed' && phase === 'admitted' && notesWanted) {
        notesRetries = 0;
        void loadNotes();
      }
      return;
  }
}

/** @param {any} frame */
function onStatus(frame) {
  switch (frame.status) {
    case 'pending':
      place = { displayName: place?.displayName ?? '', resumeToken: frame.resumeToken };
      savePlace();
      settle();
      guest = null;
      return setPhase('pending');
    case 'admitted': {
      const back = reconnecting;
      settle();
      pastDeadline = false;
      const before = guest?.role;
      guest = { role: frame.role === 'collaborator' ? 'collaborator' : 'viewer', projectName: String(frame.projectName ?? ''), guestExpiresAt: typeof frame.guestExpiresAt === 'number' ? frame.guestExpiresAt : null };
      sessionExpiresAt = Number(frame.sessionExpiresAt) || 0;
      anchorClock(frame.now);
      wasAdmitted = true;
      siteTitle = guest.projectName;
      if (typeof frame.previewTicket === 'string') redeem(frame.previewTicket);
      setPhase('admitted');
      // The host's notes are read on coming in, and again on coming back: changes may have been missed meanwhile.
      if (!notesList || back) void loadNotes();
      // A guest who becomes a collaborator is told they can edit; the bar's "How to edit" says how.
      if (guest.role === 'collaborator' && before !== 'collaborator') {
        if (before) announce('You can now edit this site with the host. How to edit says how.');
        // On a phone the way to edit is in the view options: their button carries a dot until it is opened.
        ui.barMore.dataset.attention = 'true';
      }
      return;
    }
    case 'declined':
      return finish('declined');
    case 'kicked':
      return finish('kicked');
    case 'locked':
      return finish('locked');
    case 'ended':
      // The close that follows says why (the host ended it, or never came back). Until it does, the ending is shown at
      // once in words true of both, and the reason fills in on the same screen.
      endingReason = false;
      return finish('ended');
    case 'expired':
      return finish(frame.scope === 'guest' ? 'expired-guest' : 'expired-session');
  }
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let lostDeadline;

/** The socket is back in the room: any reconnecting is over. */
function settle() {
  clearTimeout(lostDeadline);
  reconnecting = false;
  lostSince = 0;
  retries = 0;
}

/** Whether the ended screen knows why the session ended (the close after the status says). */
let endingReason = true;

/** @param {number} code */
function onClose(code) {
  if (isFinal(phase)) {
    // The status came first; the close only says more about why the session ended.
    if (phase === 'ended' && !endingReason) {
      endingReason = true;
      if (code === CLOSE_CODES.HOST_GONE) return setPhase('host-gone');
      render();
    }
    return;
  }
  if (refusal === 'resume') {
    // The relay no longer holds this place (it was given up while away): start again from the name.
    forgetPlace();
    endAccess();
    ui.nameError.textContent = 'Your place in the session was not kept. Ask to join again.';
    ui.nameError.hidden = false;
    return setPhase('name');
  }
  switch (code) {
    case CLOSE_CODES.REPLACED:
      return finish('replaced', true);
    case CLOSE_CODES.SESSION_EXPIRED:
      return finish('expired-session');
    case CLOSE_CODES.HOST_GONE:
      return finish('host-gone');
    case CLOSE_CODES.REMOVED:
      return finish('kicked');
    case CLOSE_CODES.REFUSED:
      return finish(refusal === 'full' ? 'full' : 'locked', true);
    case CLOSE_CODES.POLICY:
      return finish('error', true);
  }
  // A relay that answered with no room at all (or a network that dropped us before we were given a place): the
  // guest can try again, but is never put back in line twice without saying so.
  if (!place?.resumeToken) return finish('unavailable', true);
  // The relay closes with ENDED only when the room it held this place in is gone, status or not.
  if (code === CLOSE_CODES.ENDED) return finish('ended');
  scheduleReconnect();
}

/** The socket is gone while the guest holds a place: until the relay lets it back in, the frame shows nothing new. */
function markLost() {
  if (reconnecting) return;
  reconnecting = true;
  lostSince = performance.now();
  // The time to take the place back runs whether or not an attempt ever answers: one that hangs still ends it.
  clearTimeout(lostDeadline);
  lostDeadline = setTimeout(() => {
    if (!reconnecting) return;
    closeSocket();
    finish('lost', true);
  }, RECONNECT_FOR_MS);
  // This tab may now miss a revocation, so nothing is loaded into the frame until the relay has let it back in.
  grant++;
  failCalls('The connection to the live session dropped.', true);
  clearTimeout(notesRetry);
  previewReady = false;
  queuedTicket = null;
  redemption?.abort();
  stale = true;
  clearTimeout(reloadFallback);
}

function scheduleReconnect() {
  markLost();
  if (performance.now() - lostSince > RECONNECT_FOR_MS) return finish('lost', true);
  const delay = Math.min(10_000, 1000 * 2 ** retries) * (0.75 + Math.random() * 0.5);
  retries++;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
  render();
}

/**
 * Leave the room's live state: the frame goes at once, anything still on its way (a ticket, a reload, a retry) is
 * dropped, and no timer is left running. Safe to call more than once.
 */
function endAccess() {
  grant++;
  queuedTicket = null;
  pastDeadline = false;
  framePath = '/';
  redemption?.abort();
  stale = false;
  previewReady = false;
  previewFailed = false;
  reconnecting = false;
  clearTimeout(lostDeadline);
  guest = null;
  hostPage = null;
  clearTimeout(reconnectTimer);
  clearTimeout(reloadFallback);
  clearInterval(ticker);
  ticker = undefined;
  ui.handoff.hidden = true;
  ui.openInBuilder.setAttribute('aria-expanded', 'false');
  failCalls('You are no longer in the live session.');
  clearTimeout(notesRetry);
  notesWanted = false;
  notesRetries = 0;
  notesList = null;
  notesAgain = false;
  guestNotes = true;
  notePath = null;
  ui.noteText.value = '';
  ui.noteList.replaceChildren();
  ui.notes.hidden = true;
  ui.notesButton.setAttribute('aria-expanded', 'false');
  unmountFrame();
}

/**
 * Show a final screen. The place is given up unless the guest may still take it back from here (`keep`): another
 * tab took it, the connection was lost, or the room could not be reached.
 * @param {Phase} next
 * @param {boolean} [keep]
 */
function finish(next, keep = false) {
  endAccess();
  if (!keep) forgetPlace();
  setPhase(next);
}

/** @param {Phase} p */
function isFinal(p) {
  return !['name', 'connecting', 'pending', 'admitted'].includes(p);
}

// ---------------------------------------------------------------------------
// The preview

/** Redeem tickets one at a time, newest last, so the cookie the browser keeps is always the newest grant's. */
function redeem(/** @type {string} */ ticket) {
  if (ticket === lastTicket) return;
  lastTicket = ticket;
  queuedTicket = ticket;
  if (!redeeming) void drainTickets();
}

async function drainTickets() {
  redeeming = true;
  while (queuedTicket) {
    const ticket = queuedTicket;
    queuedTicket = null;
    const at = grant;
    const controller = new AbortController();
    redemption = controller;
    const timeout = setTimeout(() => controller.abort(), REDEEM_TIMEOUT_MS);
    let ok = false;
    try {
      const response = await fetch(`${config.previewOrigin}${PREVIEW_ADMISSION_PATH}`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
        signal: controller.signal
      });
      ok = response.status === 204;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timeout);
      if (redemption === controller) redemption = null;
    }
    // The guest may have been removed, or its socket dropped, while the cookie was on its way: then it shows nothing.
    if (at !== grant || phase !== 'admitted') continue;
    // A newer grant is on its way, and this cookie is already out of date: only the newest one opens the frame.
    if (queuedTicket) continue;
    if (ok) {
      previewReady = true;
      previewFailed = false;
      if (!iframe) mountFrame();
      else if (stale && hostConnected) catchUp();
      else applyFollow();
    } else {
      // The ticket is spent or lost either way, and any cookie before it is out of date; the guest can take the place
      // back for a fresh one (Try again).
      previewFailed = true;
      previewReady = false;
    }
    render();
  }
  redeeming = false;
}

function mountFrame() {
  if (iframe) return layout();
  const start = follow && hostPage?.previewPath ? hostPage.previewPath : framePath;
  iframe = document.createElement('iframe');
  iframe.id = 'preview';
  iframe.title = guest?.projectName ? `Live preview of ${guest.projectName}` : 'Live preview';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', FRAME_SANDBOX);
  framePath = start;
  bridgeReady = false;
  frameShown = false;
  frameSlow = false;
  // The site counts as on screen once its first page has loaded, or once the page's bridge says it is ready (a page
  // still fetching slow images is ready to look at). One that does neither in time is said to be slow, and still
  // shows by itself the moment it does.
  iframe.addEventListener('load', frameReady, { once: true });
  clearTimeout(frameShownFallback);
  frameShownFallback = setTimeout(() => {
    if (frameShown || !iframe) return;
    frameSlow = true;
    render();
  }, 6000);
  iframe.src = `${config.previewOrigin}${start}`;
  ui.frame.replaceChildren(iframe);
  layout();
}

/** The frame's first page is on screen. */
function frameReady() {
  if (frameShown || !iframe) return;
  frameShown = true;
  frameSlow = false;
  clearTimeout(frameShownFallback);
  render();
}

function unmountFrame() {
  if (!iframe) return;
  setPointing(false);
  bridgeReady = false;
  iframe.remove();
  iframe = null;
  shownPath = null;
  endPageAsk();
  clearTimeout(reloadFallback);
  frameShown = false;
  frameSlow = false;
  clearTimeout(frameShownFallback);
  ui.frame.replaceChildren();
}

/** @param {string} path */
function navigate(path) {
  if (!iframe || !isFramePath(path)) return;
  framePath = path;
  // The next page's bridge says when it is there; until then nothing can point at it.
  bridgeReady = false;
  setPointing(false);
  render();
  iframe.src = `${config.previewOrigin}${path}`;
}

/**
 * The frame may be behind (the host was away, the socket was down): catch it up now if it can load anything, or as
 * soon as it can. It can while its cookie is the newest grant's, the host is there and the socket is in the room;
 * until then it is only marked, and the redemption that completes the grant, or the host's return, catches it up.
 */
function refreshFrame() {
  if (!iframe) return;
  stale = true;
  if (previewReady && !redeeming && hostConnected && !reconnecting) catchUp();
}

/** To the host's page when following a host that is elsewhere, otherwise the guest's own page, reloaded where it is scrolled to. */
function catchUp() {
  stale = false;
  layout();
  if (follow && hostPage?.previewPath && hostPage.previewPath !== framePath) navigate(hostPage.previewPath);
  else reloadPreview();
}

/** Show the host's latest work: the bridge reloads the page the guest is on, where it is scrolled to. */
function reloadPreview() {
  if (!iframe?.contentWindow || !previewReady || reconnecting) return;
  clearTimeout(reloadFallback);
  if (!bridgeReady) {
    // A change can arrive while the frame is still loading. A reload message sent then is lost, and its fallback
    // can later pull a visitor back to the old route. Wait for the bridge, with the same bounded fallback.
    stale = true;
    reloadFallback = setTimeout(() => {
      if (stale) {
        stale = false;
        navigate(framePath);
      }
    }, RELOAD_FALLBACK_MS);
    return;
  }
  // A page the bridge could not run on (its own policy refused the script) is pointed at its page again instead.
  reloadFallback = setTimeout(() => navigate(framePath), RELOAD_FALLBACK_MS);
  iframe.contentWindow.postMessage({ type: BRIDGE_MESSAGES.reload }, config.previewOrigin);
}

window.addEventListener('message', (event) => {
  if (!iframe || event.origin !== config.previewOrigin || !event.data || typeof event.data !== 'object') return;
  // A page saying it is going posts as it unloads, when its window is no longer the frame's: it is taken from the
  // preview's origin alone, since all it can do is stop pointing until the next page's bridge is there.
  if (event.data.type === BRIDGE_MESSAGES.leaving) {
    bridgeReady = false;
    setPointing(false);
    render();
    return;
  }
  if (event.source !== iframe.contentWindow) return;
  const data = event.data;
  if (data.type === BRIDGE_MESSAGES.reloading) {
    clearTimeout(reloadFallback);
    // The page is going: pointing stops with it, and waits for the bridge of the page that replaces it.
    bridgeReady = false;
    setPointing(false);
    render();
  }
  else if (data.type === BRIDGE_MESSAGES.refused) {
    // The relay turned the frame's page away: the preview is not open, whatever the frame loaded. Try again takes the
    // guest's place back for a fresh ticket. A refusal of a page asked for under an older grant, while a newer one is
    // on its way, says nothing about the newer one: the frame is caught up once it lands.
    if (redeeming || queuedTicket) {
      stale = true;
      return;
    }
    previewFailed = true;
    previewReady = false;
    unmountFrame();
    render();
  }
  else if (data.type === BRIDGE_MESSAGES.ready && isFramePath(data.path)) {
    framePath = data.path;
    shownPath = data.path;
    const first = !bridgeReady;
    bridgeReady = true;
    if (pageAsk) {
      if (data.id === pageAsk.id) settlePage();
      // A new page replaced the one asked, which can no longer answer: this one is asked instead.
      else if (first) postPageAsk();
    }
    // A note begun before any page was confirmed is for the first page the frame says it shows, wherever it goes next.
    else if (!notePath && ui.noteText.value.trim()) notePath = data.path;
    frameReady();
    if (stale && previewReady && hostConnected && !reconnecting) catchUp();
    if (!ui.notes.hidden) renderNotes();
    // A page the site's own router moved to keeps its bridge: still pointing, it is told so again.
    if (pointing) iframe.contentWindow?.postMessage({ type: BRIDGE_MESSAGES.point, on: true }, config.previewOrigin);
    else if (first) render();
  }
  else if (data.type === BRIDGE_MESSAGES.pointed && pointing) {
    setPointing(false);
    const spotlight = spotlightOf(data);
    if (!spotlight) return announce('That spot couldn’t be pointed out. Try somewhere else on the page.');
    const now = performance.now();
    if (now - pointedAt < POINT_GAP_MS) return announce('Wait a moment before pointing again.');
    pointedAt = now;
    send({ type: 'spotlight:point', spotlight });
    flashPointed();
  }
  else if (data.type === BRIDGE_MESSAGES.pointCancelled && pointing) {
    setPointing(false);
    ui.point.focus({ preventScroll: true });
  }
});

/**
 * A spotlight as the relay reads it, from what the bridge reported: the page's address, the element when the page
 * named one within the contract's bounds (null otherwise), and the point. Null when the address cannot be sent.
 * @param {any} data
 */
function spotlightOf(data) {
  if (!isSpotlightPath(data.path)) return null;
  const share = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);
  const x = share(data.x);
  const y = share(data.y);
  if (x === null || y === null) return null;
  return { previewPath: data.path, target: targetOf(data.target), x, y };
}

/** @param {any} t */
function targetOf(t) {
  const id = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
  const ids = (/** @type {unknown} */ v) => Array.isArray(v) && v.length <= MAX_SELECTION_DEPTH && v.every(id);
  if (!t || typeof t !== 'object' || !t.owner || !['page', 'shell', 'component', 'template', 'archive'].includes(t.owner.kind) || !id(t.owner.id) || !ids(t.instancePath) || !id(t.nodeId)) return null;
  if (t.itemPath !== undefined && !ids(t.itemPath)) return null;
  return { owner: { kind: t.owner.kind, id: t.owner.id }, instancePath: [...t.instancePath], nodeId: t.nodeId, ...(t.itemPath?.length ? { itemPath: [...t.itemPath] } : {}) };
}

/** Whether the guest can point now: let in, the site on screen, and the host there to see it. */
function canPoint() {
  return phase === 'admitted' && !!iframe && bridgeReady && roomState() === 'live';
}

/** Start or stop pointing, and tell the frame's bridge. Only pointing the guest can do now is started. */
function setPointing(/** @type {boolean} */ on) {
  const next = on && canPoint();
  if (next === pointing) return;
  pointing = next;
  ui.point.setAttribute('aria-pressed', String(pointing));
  ui.stage.dataset.pointing = String(pointing);
  ui.pointHint.hidden = !pointing;
  iframe?.contentWindow?.postMessage({ type: BRIDGE_MESSAGES.point, on: pointing }, config.previewOrigin);
  if (pointing) {
    announce('Click anything on the site to point it out to the host. Press Escape to cancel.');
    // The click is the site's to take: focus goes to the frame, so Escape reaches its bridge as well.
    iframe?.focus({ preventScroll: true });
  }
}

let pointedTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
/** Say a spotlight went: on the button for a moment, and to a screen reader. */
function flashPointed() {
  announce('Pointed out to the host.');
  ui.point.dataset.sent = 'true';
  clearTimeout(pointedTimer);
  pointedTimer = setTimeout(() => delete ui.point.dataset.sent, 1500);
}

/** Following the host: show the host's page (at the host's width too, when that is the width chosen). */
function applyFollow() {
  layout();
  if (!follow || !hostPage) return;
  if (iframe && previewReady && hostConnected && hostPage.previewPath && hostPage.previewPath !== framePath) navigate(hostPage.previewPath);
}

function frameWidth() {
  if (width === 'host') return hostPage?.viewportWidth ?? VIEWPORTS.desktop;
  return VIEWPORTS[width];
}

/** Size the frame to its width, scaled down to fit the stage when the stage is narrower, so its layout is the real one. */
function layout() {
  const px = frameWidth();
  const room = ui.stage.clientWidth;
  const height = ui.stage.clientHeight;
  const scale = room > 0 && px > room ? room / px : 1;
  ui.frame.style.width = `${Math.round(px * scale)}px`;
  if (iframe) {
    iframe.style.width = `${px}px`;
    iframe.style.height = `${Math.max(0, Math.round(height / scale))}px`;
    iframe.style.transform = scale === 1 ? '' : `scale(${scale})`;
  }
  root.dataset.frameWidth = String(px);
  for (const button of ui.viewports) button.setAttribute('aria-pressed', String(button.dataset.viewport === width));
}

// ---------------------------------------------------------------------------
// Time

/** @param {unknown} now */
function anchorClock(now) {
  if (typeof now === 'number') clock = { relayNow: now, at: performance.now() };
}

function relayNow() {
  return clock.relayNow + (performance.now() - clock.at);
}

/** @param {number} ms */
function formatLeft(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  // The last ten minutes count in minutes and seconds, so a short limit never reads as more time than it is.
  if (seconds < 600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** When the guest's access ends, and whether by its own grant: the sooner of its own deadline and the session's. */
function accessEnd() {
  if (!guest || !sessionExpiresAt) return null;
  const own = guest.guestExpiresAt !== null && guest.guestExpiresAt < sessionExpiresAt;
  return { own, at: own ? /** @type {number} */ (guest.guestExpiresAt) : sessionExpiresAt };
}

/**
 * Each second while admitted: the countdown, and the end itself. The relay says when access ends, but a guest whose
 * socket is down cannot hear it, so the frame goes at the deadline on the relay's clock whether or not it is told.
 */
function tick() {
  const end = accessEnd();
  if (end && clock.at > 0 && relayNow() >= end.at && !pastDeadline) {
    // The relay has the last word (the host may have extended the guest's access while this socket was down), so the
    // place is kept; only the site goes, until the relay lets the guest in again or says why not.
    pastDeadline = true;
    grant++;
    previewReady = false;
    queuedTicket = null;
    redemption?.abort();
    unmountFrame();
    render();
  }
  renderTime();
}

/** Minutes before the end at which the guest is warned, once each, out loud and by the badge turning amber. */
const WARN_AT = [5, 1];

/** A time left, in words, for saying out loud: "4 minutes", "about a minute", "40 seconds". */
function spokenLeft(/** @type {number} */ ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'about a minute' : `${minutes} minutes`;
}

function renderTime() {
  const end = accessEnd();
  const state = roomState();
  ui.time.hidden = !end || state === 'time-up';
  ui.veilTime.hidden = true;
  if (!end || state === 'time-up') {
    renderRole('');
    return;
  }
  const left = end.at - relayNow();
  // With the preview unavailable the folded bar has no room for the clock, so the card carrying Try again says it.
  if (state === 'failed') {
    ui.veilTime.hidden = false;
    ui.veilTime.textContent = `${end.own ? 'Your access ends' : 'The session ends'} in ${formatLeft(left)}.`;
  }
  const label = document.createElement('span');
  label.className = 'time-label';
  label.textContent = end.own ? 'Your access ends in' : 'Ends in';
  const text = document.createElement('span');
  text.append(label, ` ${formatLeft(left)}`);
  // Folded, the badge keeps only its digits; a limit of the guest's own still says whose time it is.
  const short = document.createElement('span');
  short.className = 'time-short';
  short.setAttribute('aria-hidden', 'true');
  short.textContent = end.own ? 'Your time' : '';
  ui.time.replaceChildren(short, text);
  ui.time.dataset.own = String(end.own);
  ui.time.dataset.warn = String(left <= WARN_AT[0] * 60_000);
  renderRole(`${end.own ? 'Your access ends' : 'The session ends'} in\u00a0${formatLeft(left).replace(' ', '\u00a0')}.`);
  // A deadline the host moved earns its warnings again.
  if (end.at !== warnedFor) {
    warned = new Set();
    warnedFor = end.at;
  }
  // The ticking badge is never itself announced. Coming within a warning says the real time left, once; each later
  // warning is said once as it is crossed.
  const due = WARN_AT.filter((m) => left <= m * 60_000 && !warned.has(m));
  if (due.length) {
    for (const m of due) warned.add(m);
    announce(`${end.own ? 'Your access ends' : 'The session ends'} in ${spokenLeft(left)}.`);
  }
}

/** The phone panel's line about the guest's role, and the time they have. */
function renderRole(/** @type {string} */ time) {
  if (!guest) return;
  const role = guest.role === 'collaborator' ? 'You’re a collaborator: you can edit this site with the host in SiteOrigin Builder.' : 'You’re watching as a viewer.';
  ui.panelRole.textContent = time ? `${role} ${time}` : role;
}

// ---------------------------------------------------------------------------
// Screens

/**
 * What each screen says. `icon` and `tone` draw its status glyph (viewer.css); `next` is what the guest can do from
 * here when there is no button for it; `action` is the one thing the page can do for them.
 * @type {Record<Phase, { title: string; text: string; icon?: string; tone?: 'accent' | 'amber' | 'red' | 'green'; next?: string; action?: { label: string; run: () => void } } | null>}
 */
const SCREENS = {
  name: { title: 'Join the live session', text: 'You’ve been invited to watch a website being designed, live. The host sees your name and decides whether to let you in; you’ll see which site once you’re in.' },
  connecting: { title: 'Joining…', text: 'Connecting to the live session.', icon: 'spinner' },
  pending: { title: 'Waiting for the host', text: '', icon: 'spinner' },
  admitted: null,
  unavailable: { title: 'This session isn’t available', text: 'It may have ended, or the link may be wrong. Check the invite link with the host.', icon: 'unlink', tone: 'amber', action: { label: 'Try again', run: connect } },
  lost: { title: 'Connection lost', text: 'This page could not reach the live session for a while. Your place may still be kept.', icon: 'offline', tone: 'amber', action: { label: 'Reconnect', run: connect } },
  replaced: { title: 'Opened in another tab', text: 'You joined this session from another tab or window, so this one has stopped.', icon: 'tab', action: { label: 'Use this tab instead', run: connect } },
  full: { title: 'This session is full', text: 'It already has as many guests as it can hold. Try again in a little while.', icon: 'full', tone: 'amber', action: { label: 'Try again', run: connect } },
  locked: { title: 'This session is locked', text: 'The host isn’t letting anyone new in right now. Ask them to unlock it, then try again.', icon: 'lock', tone: 'amber', action: { label: 'Try again', run: connect } },
  declined: { title: 'The host declined your request', text: 'You can ask again if you think that was a mistake.', icon: 'declined', action: { label: 'Ask again', run: () => setPhase('name') } },
  kicked: { title: 'You were removed', text: 'The host removed you from the live session.', icon: 'removed', next: 'Contact the host if you expected to stay. You can close this tab.' },
  'expired-guest': { title: 'Your access has ended', text: 'The time the host gave you in this session is up. If they give you more, you can ask to join again.', icon: 'clock', action: { label: 'Ask to join again', run: () => setPhase('name') } },
  'expired-session': { title: 'This session has ended', text: 'It reached the end of its time. Thanks for joining.', icon: 'done', next: 'You can close this tab. Ask the host for a new invite link to meet again.' },
  ended: { title: 'The host ended the session', text: 'Thanks for joining.', icon: 'done', next: 'You can close this tab. Ask the host for a new invite link to meet again.' },
  'host-gone': { title: 'The host left the session', text: 'The host’s connection dropped and they didn’t come back in time, so the session has ended.', icon: 'host', next: 'You can close this tab. Ask the host for a new invite link to meet again.' },
  error: { title: 'Something went wrong', text: 'The live session could not be joined from this page.', icon: 'alert', tone: 'red', action: { label: 'Try again', run: connect } }
};

/** What the bar says above a screen the guest reached after watching. */
const OVER = /** @type {Partial<Record<Phase, [string, string]>>} */ ({
  replaced: ['disconnected', 'In another tab'],
  full: ['disconnected', 'Disconnected'],
  locked: ['disconnected', 'Disconnected'],
  lost: ['disconnected', 'Disconnected'],
  unavailable: ['disconnected', 'Disconnected'],
  error: ['disconnected', 'Disconnected'],
  kicked: ['removed', 'Removed'],
  'expired-guest': ['time-up', 'Time’s up']
});

/** @param {Phase} next */
function setPhase(next) {
  const previous = phase;
  const changed = next !== phase;
  phase = next;
  root.dataset.phase = next;
  if (next === 'admitted' && !ticker) ticker = setInterval(tick, 1000);
  if (next !== 'admitted') {
    warned = new Set();
    veilShown = '';
  }
  if (changed) stateSaid = '';
  render();
  // One ending replacing another (its reason arriving) keeps focus where it is, on the screen's heading.
  if (changed && started && !(isFinal(previous) && isFinal(next))) focusView();
}

/** The tab's title says where the guest is, so a guest who switched tabs while waiting sees when they are let in. */
function renderTitle() {
  const word =
    phase === 'admitted' ? `${guest?.projectName || 'Live session'} · ${ROOM[roomState()].word}` : phase === 'name' || phase === 'connecting' ? 'Live session' : ui.screenTitle.textContent || 'Live session';
  document.title = `${word} · SiteOrigin Builder`;
}

/**
 * Take focus to the top of the view that just replaced the last one, so a keyboard or screen reader user is never
 * left on a control that is gone: the name field, the screen's heading, or in the room the site's name (or the
 * veil's heading while the site is covered).
 */
function focusView() {
  if (phase === 'name') {
    ui.name.focus();
    ui.name.select();
  } else if (phase === 'admitted') (ui.veil.hidden ? ui.title : ui.veilTitle).focus({ preventScroll: true });
  else ui.screenTitle.focus({ preventScroll: true });
}

/** Say a change through the page's one status region, which is always in the page, so it is heard. */
/** @type {string[]} */
let toSay = [];
function announce(/** @type {string} */ text) {
  if (!text) return;
  // Everything said in one turn of the page is said together, so a warning and a change of state never overwrite
  // each other; the region is cleared first, so the same words said twice (a second copy) are heard twice.
  if (!toSay.length)
    queueMicrotask(() => {
      ui.announcer.textContent = '';
      ui.announcer.textContent = toSay.join(' ');
      toSay = [];
    });
  if (!toSay.includes(text)) toSay.push(text);
}

/** What the room or the waiting screen last said of itself, so each change of state is said once, and only once. */
let stateSaid = '';
function announceState(/** @type {string} */ text) {
  if (!text || text === stateSaid) return;
  stateSaid = text;
  announce(text);
}

function render() {
  const inRoom = phase === 'admitted';
  // A guest who was watching keeps the bar, saying the session is over, above the screen that says why.
  const over = !inRoom && wasAdmitted && isFinal(phase);
  root.dataset.over = String(over);
  ui.bar.hidden = !inRoom && !over;
  ui.barMeta.hidden = over || (inRoom && pastDeadline);
  ui.barControls.hidden = over || (inRoom && pastDeadline);
  ui.barMore.hidden = over || (inRoom && pastDeadline);
  if (ui.barMore.hidden) closeOptions();
  ui.stage.hidden = !inRoom;
  ui.screen.hidden = inRoom;
  if (!inRoom) ui.hostNote.hidden = true;
  if (inRoom) renderRoom();
  else renderScreen();
  renderTitle();
  if (over) {
    const [state, word] = OVER[phase] ?? ['ended', 'Ended'];
    ui.title.textContent = siteTitle;
    ui.connection.dataset.state = state;
    ui.connection.textContent = word;
  }
}

/** @param {HTMLElement} glyph @param {string | undefined} icon @param {string | undefined} tone */
function drawGlyph(glyph, icon, tone) {
  glyph.hidden = !icon;
  if (icon) glyph.dataset.icon = icon;
  if (tone) glyph.dataset.tone = tone;
  else delete glyph.dataset.tone;
}

function renderScreen() {
  const screen = SCREENS[phase] ?? SCREENS.error;
  if (!screen) return;
  let title = screen.title;
  let text = screen.text;
  const waiting = phase === 'pending' || phase === 'connecting';
  const who = place?.displayName ?? 'a guest';
  if (phase === 'pending') {
    // This page's own connection comes first: while it is down, nothing it says about the host is current.
    if (reconnecting) {
      title = 'Reconnecting';
      text = `Your connection dropped. Your request to join as ${who} is kept while this page reconnects.`;
    } else if (!hostConnected) {
      title = 'The host is reconnecting';
      text = `You asked to join as ${who}. The host’s connection dropped; your request is kept, and this page will update when they’re back.`;
    } else {
      title = 'Waiting for the host';
      text = `You asked to join as ${who}. This page opens the site as soon as the host lets you in.`;
    }
    announceState(`${title}. ${text}`);
  }
  if (phase === 'connecting' && reconnecting) text = 'Reconnecting to the live session.';
  if (phase === 'ended' && !endingReason) {
    title = 'This session has ended';
    text = 'Thanks for joining.';
  }
  ui.screenTitle.textContent = title;
  ui.screenText.textContent = text;
  drawGlyph(ui.screenGlyph, screen.icon, phase === 'pending' && (!hostConnected || reconnecting) ? 'amber' : screen.tone);
  const asking = phase === 'name';
  ui.form.hidden = !asking;
  if (asking) {
    if (!ui.name.value && place) ui.name.value = place.displayName;
    ui.joinButton.disabled = false;
    ui.joinButton.textContent = 'Ask to join';
  } else {
    ui.nameError.hidden = true;
    ui.name.removeAttribute('aria-invalid');
  }
  ui.next.hidden = !screen.next;
  ui.next.textContent = screen.next ?? '';
  ui.action.hidden = !screen.action;
  ui.action.disabled = false;
  if (screen.action) ui.action.textContent = screen.action.label;
  ui.cancel.hidden = !waiting;
  // While the page is reconnecting it cannot tell the relay, so the request cannot be withdrawn until it is back.
  ui.cancel.disabled = waiting && reconnecting;
  ui.actions.hidden = ui.action.hidden && ui.cancel.hidden;
}

/**
 * The room, from one reading of where the guest stands, so the pill, the countdown, the veil and the controls can
 * never disagree: the time is up, this page is reconnecting, the preview failed or is opening, the host is away, or
 * the site is live.
 */
function roomState() {
  if (pastDeadline) return 'time-up';
  if (reconnecting) return 'reconnecting';
  if (previewFailed) return 'failed';
  if (previewReady && frameSlow && !frameShown) return 'slow';
  if (!previewReady || !frameShown) return 'connecting';
  if (!hostConnected) return 'host-away';
  return 'live';
}

const ROOM = {
  'time-up': { word: 'Time’s up', veil: { icon: 'clock', title: 'Your time is up', text: 'The time the host gave you in this session has run out. If they give you more, the site comes back here.' } },
  reconnecting: { word: 'Reconnecting', veil: { icon: 'spinner', tone: 'amber', title: 'Reconnecting', text: 'Your connection dropped. Your place is kept while this page reconnects.' } },
  failed: { word: 'Preview unavailable', veil: { icon: 'alert', tone: 'red', title: 'The preview didn’t open', text: 'You’re still in the session. Try again to open the host’s site.' } },
  connecting: { word: 'Opening', veil: { icon: 'spinner', title: 'Opening the preview', text: 'The host’s site will appear here in a moment.' } },
  slow: { word: 'Opening', veil: { icon: 'spinner', tone: 'amber', title: 'The preview is taking a while', text: 'It appears here as soon as the host’s site loads. If it doesn’t, try again.' } },
  'host-away': { word: 'Host away', veil: null },
  live: { word: 'Live', veil: null }
};

function renderRoom() {
  if (!guest) return;
  const collaborator = guest.role === 'collaborator';
  ui.title.textContent = guest.projectName;
  ui.role.textContent = collaborator ? 'Collaborator' : 'Viewer';
  ui.role.dataset.role = guest.role;
  ui.openInBuilder.hidden = !collaborator;
  const state = roomState();
  // Instructions for editing have no place over an ending or for a guest who can no longer edit. Focus that was in
  // them, or on their button, goes to the nearest thing still there.
  const held = ui.handoff.contains(document.activeElement) || document.activeElement === ui.openInBuilder;
  if (!collaborator) delete ui.barMore.dataset.attention;
  if ((!collaborator || state === 'time-up') && (!ui.handoff.hidden || (held && ui.openInBuilder.hidden))) {
    closeHandoff(false);
    if (held && started) (ui.barMore.offsetParent ? ui.barMore : ui.title).focus({ preventScroll: true });
  }
  // Nor do notes, once the guest's time is up.
  if (state === 'time-up' && !ui.notes.hidden) closeNotes(false);
  const { word } = ROOM[state];
  let veil = ROOM[state].veil;
  // At the session's own deadline, the whole session is over, not only this guest's time.
  if (state === 'time-up' && !accessEnd()?.own) veil = { icon: 'clock', title: 'The session’s time is up', text: 'The live session reached the end of its time. If the host extends it, the site comes back here.' };
  ui.connection.dataset.state = state;
  ui.connection.textContent = word;
  ui.bar.dataset.state = state;
  ui.follow.checked = follow;
  // Pointing waits for the site to be on screen with the host there; anything else stops it.
  ui.point.disabled = !canPoint();
  if (pointing && !canPoint()) setPointing(false);
  renderTime();
  ui.hostNote.hidden = state !== 'host-away';
  ui.hostNote.textContent = 'The host’s connection dropped. The site will update when they’re back.';
  // Focus inside a notice that is going away goes to the site's name, so it is never left on nothing.
  const focusWasInVeil = !ui.veil.hidden && ui.veil.contains(document.activeElement);
  ui.veil.hidden = !veil;
  // A covered frame cannot be reached by keyboard or assistive technology either.
  if (iframe) iframe.inert = Boolean(veil);
  if (veil) {
    drawGlyph(ui.veilGlyph, veil.icon, veil.tone);
    ui.veilTitle.textContent = veil.title;
    ui.veilText.textContent = veil.text;
  }
  ui.veilAction.hidden = state !== 'failed' && state !== 'slow';
  ui.veilAction.disabled = false;
  const shown = veil ? veil.title : '';
  if (shown !== veilShown) {
    // Focus left inside a frame that is now covered, or on nothing, goes to the notice that covers it.
    const lost = !document.activeElement || document.activeElement === document.body || document.activeElement === iframe;
    if (veil && started && lost) ui.veilTitle.focus({ preventScroll: true });
    else if (!veil && focusWasInVeil) ui.title.focus({ preventScroll: true });
    veilShown = shown;
  }
  ui.siteRole.hidden = !collaborator;
  announceState(state === 'live' ? `Live: you’re watching ${guest.projectName}${collaborator ? ' as a collaborator, and can edit it with the host' : ''}.` : state === 'host-away' ? ui.hostNote.textContent : `${veil?.title}. ${veil?.text}`);
  layout();
}

// ---------------------------------------------------------------------------
// The handoff to the desktop app, for collaborators

/** @type {ReturnType<typeof setTimeout> | undefined} */
let copiedTimer;

/** @param {boolean} [moveFocus] */
function showHandoff(moveFocus = false) {
  ui.handoffText.textContent = 'Open this invite link in SiteOrigin Builder on your computer to edit the site with the host. This page only shows the preview.';
  ui.handoffLink.value = config.inviteLink;
  ui.handoffCopy.textContent = 'Copy link';
  clearTimeout(copiedTimer);
  ui.handoff.hidden = false;
  ui.openInBuilder.setAttribute('aria-expanded', 'true');
  // One panel over the site at a time.
  if (!ui.notes.hidden) closeNotes(false);
  closeOptions();
  if (moveFocus) ui.handoffTitle.focus();
}

/** @param {boolean} [returnFocus] */
function closeHandoff(returnFocus = true) {
  ui.handoff.hidden = true;
  ui.openInBuilder.setAttribute('aria-expanded', 'false');
  if (!returnFocus) return;
  // On a phone the button that opened it is folded away in the view options; their button takes focus instead.
  if (ui.openInBuilder.offsetParent) ui.openInBuilder.focus();
  else if (ui.barMore.offsetParent) ui.barMore.focus();
}

/** The phone's view options, dropped down from the bar. */
function closeOptions() {
  ui.bar.dataset.open = 'false';
  ui.barMore.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// Notes (#770)

/**
 * Call the host's editor through the relay; resolves with its answer, or with why there is none (the connection
 * dropped, the guest left, or the host took too long). Never rejects.
 * @param {string} method @param {unknown[]} args
 * `lost`: the call went out, and its answer never came: what it asked for may have been done.
 * @returns {Promise<{ ok: true; result: any } | { ok: false; message: string; lost?: boolean }>}
 */
function callHost(method, args) {
  if (phase !== 'admitted' || reconnecting || socket?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, message: 'The connection to the live session is down. Try again once it is back.' });
  // Nothing is sent while the host is away: the relay would only refuse it, and nobody need wonder whether it landed.
  if (!hostConnected) return Promise.resolve({ ok: false, message: 'The host is reconnecting. Try again in a moment.' });
  const requestId = `v${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${++callSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (calls.delete(requestId)) resolve({ ok: false, message: 'The host did not answer in time.', lost: true });
    }, CALL_TIMEOUT_MS);
    calls.set(requestId, { method, resolve, timer });
    send({ type: 'rpc:request', requestId, method, args });
  });
}

/** Every call still waiting is answered with `message`: the relay answers nothing for a socket it let go. */
function failCalls(/** @type {string} */ message, lost = false) {
  const waiting = [...calls.values()];
  calls.clear();
  for (const call of waiting) {
    clearTimeout(call.timer);
    call.resolve({ ok: false, message, lost });
  }
}

/** @param {any} note */
function isNote(note) {
  return !!note && typeof note.id === 'string' && typeof note.text === 'string' && typeof note.authorName === 'string' && typeof note.createdAt === 'number' && typeof note.resolved === 'boolean';
}

/** Read the host's notes: one request at a time, and once more after it when they changed again meanwhile. */
function loadNotes() {
  if (notesLoading) {
    notesAgain = true;
    return notesLoading;
  }
  const at = grant;
  notesWanted = true;
  clearTimeout(notesRetry);
  notesLoading = (async () => {
    do {
      notesAgain = false;
      const answer = await callHost('notes.list', []);
      if (at !== grant || phase !== 'admitted') return;
      if (answer.ok && Array.isArray(answer.result?.notes)) {
        notesList = answer.result.notes.filter(isNote);
        guestNotes = answer.result.guestNotes !== false;
        notesRetries = 0;
        renderNotes();
      } else if (!notesAgain && hostConnected && !reconnecting && notesRetries < NOTES_RETRIES) {
        // Not read (the host was busy, or the relay held it back): asked again shortly, so a change is never missed for
        // good. While the host or this connection is away, its return asks instead.
        notesRetry = setTimeout(() => {
          if (at === grant && phase === 'admitted') void loadNotes();
        }, NOTES_RETRY_MS * 2 ** notesRetries++);
      }
    } while (notesAgain);
  })().finally(() => {
    notesLoading = null;
  });
  return notesLoading;
}

/** A note's length as the host counts it: characters once spaces are run together and the ends trimmed. */
function noteLength(/** @type {string} */ text) {
  return [...text.normalize('NFC').replace(/\s+/gu, ' ').trim()].length;
}

/** How long ago a note was left, on this device's clock (the host's stamp is only shown, never trusted for access). */
function noteAge(/** @type {number} */ at) {
  const mins = Math.floor(Math.max(0, Date.now() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** The page a note will be left on: where writing began, else the page shown now, once the frame has confirmed it. */
function notePage() {
  return notePath ?? (pageAsk ? null : shownPath);
}

/** Ask the frame's bridge which page it shows, for a note not yet pinned to one. */
function askPage() {
  endPageAsk();
  if (notePath || !iframe) return;
  pageAsk = { id: ++pageAskSeq, timer: setTimeout(settlePage, PAGE_ASK_MS) };
  postPageAsk();
}

function postPageAsk() {
  if (pageAsk && bridgeReady) iframe?.contentWindow?.postMessage({ type: BRIDGE_MESSAGES.where, id: pageAsk.id }, config.previewOrigin);
}

function endPageAsk() {
  if (!pageAsk) return;
  clearTimeout(pageAsk.timer);
  pageAsk = null;
}

/** The bridge answered, or never will: a note already begun is for the page the frame last said it shows. */
function settlePage() {
  endPageAsk();
  if (!notePath && ui.noteText.value.trim()) notePath = shownPath;
  renderNotes();
}

function renderNotes() {
  const open = (notesList ?? []).filter((n) => !n.resolved);
  ui.notesCount.hidden = open.length === 0;
  ui.notesCount.textContent = String(open.length);
  ui.notesButton.setAttribute('aria-label', open.length ? `Notes, ${open.length} open` : 'Notes');
  if (ui.notes.hidden) return;
  ui.noteForm.hidden = !guestNotes;
  ui.notesOff.hidden = guestNotes;
  const page = notePage();
  ui.noteWhere.textContent = page ? `Leave a note on this page (${page})` : 'Leave a note on this page';
  const length = noteLength(ui.noteText.value);
  ui.noteLength.textContent = `${length}/${config.noteMax}`;
  ui.noteLength.dataset.over = String(length > config.noteMax);
  ui.noteSend.disabled = noteSending || !page || length === 0 || length > config.noteMax;
  // What is typed while a note is being sent would be lost when the field empties for it, and a note begun before the
  // frame confirms its page could be pinned to one the guest had not yet seen.
  ui.noteText.readOnly = noteSending || !!pageAsk;
  ui.noteSend.textContent = noteSending ? 'Sending…' : 'Send note';
  const items = open.map((note) => {
    const li = document.createElement('li');
    const text = document.createElement('p');
    text.className = 'note-text';
    // Notes are other people's words: always text, never markup.
    text.textContent = note.text;
    const meta = document.createElement('p');
    meta.className = 'note-meta';
    meta.textContent = `${note.authorName} · ${noteAge(note.createdAt)}`;
    li.append(text, meta);
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'note-empty';
    li.textContent = notesList ? 'No open notes yet.' : 'Reading the notes…';
    items.push(li);
  }
  ui.noteList.replaceChildren(...items);
}

function showNotes() {
  ui.notes.hidden = false;
  ui.notesButton.setAttribute('aria-expanded', 'true');
  closeOptions();
  if (!ui.handoff.hidden) closeHandoff(false);
  // Read again on opening: whatever the last read missed is shown now.
  notesRetries = 0;
  void loadNotes();
  askPage();
  renderNotes();
  ui.notesTitle.focus();
}

/** @param {boolean} [returnFocus] */
function closeNotes(returnFocus = true) {
  ui.notes.hidden = true;
  endPageAsk();
  ui.notesButton.setAttribute('aria-expanded', 'false');
  if (!returnFocus) return;
  if (ui.notesButton.offsetParent) ui.notesButton.focus();
  else if (ui.barMore.offsetParent) ui.barMore.focus();
}

async function sendNote() {
  const text = normalizeDisplayName(ui.noteText.value, config.noteMax);
  const page = notePage();
  if (noteSending || !page) return;
  if (!text) {
    const typed = ui.noteText.value.trim();
    ui.noteError.textContent = !typed ? 'Write something in the note first.' : noteLength(typed) > config.noteMax ? `Keep a note to ${config.noteMax} characters.` : 'Type the note again without hidden or special characters.';
    ui.noteError.hidden = false;
    ui.noteText.focus();
    return;
  }
  ui.noteError.hidden = true;
  noteSending = true;
  renderNotes();
  const answer = await callHost('notes.add', [{ text, previewPath: page }]);
  noteSending = false;
  if (answer.ok) {
    ui.noteText.value = '';
    notePath = null;
    announce('Note sent to the host.');
    void loadNotes();
  } else {
    // An answer that never came may still have been a note kept: the guest looks before sending it again.
    ui.noteError.textContent = answer.lost ? `${answer.message} Your note may have been sent: look at the notes before sending it again.` : answer.message;
    ui.noteError.hidden = false;
    if (answer.lost) void loadNotes();
  }
  renderNotes();
}

// ---------------------------------------------------------------------------
// The guest's own controls

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  // One request per visit to the name screen.
  if (phase !== 'name' || ui.joinButton.disabled) return;
  const name = normalizeDisplayName(ui.name.value, config.nameMax);
  if (!name) {
    const typed = ui.name.value.trim();
    // Say what is actually wrong: nothing typed, too long, or a character (often invisible, from a paste) a name can't hold.
    ui.nameError.textContent = !typed ? 'Enter your name.' : [...typed].length > config.nameMax ? `Use a name of ${config.nameMax} characters or fewer.` : 'Type your name again without hidden or special characters.';
    ui.nameError.hidden = false;
    ui.name.setAttribute('aria-invalid', 'true');
    ui.name.focus();
    return;
  }
  ui.nameError.hidden = true;
  ui.name.removeAttribute('aria-invalid');
  ui.joinButton.disabled = true;
  ui.joinButton.textContent = 'Asking…';
  wasAdmitted = false;
  endingReason = true;
  place = { displayName: name };
  savePlace();
  connect();
});

ui.name.addEventListener('input', () => {
  if (ui.nameError.hidden) return;
  ui.nameError.hidden = true;
  ui.name.removeAttribute('aria-invalid');
});

// Taking the place back on a new socket brings a fresh ticket.
ui.veilAction.addEventListener('click', () => {
  if (ui.veilAction.disabled) return;
  ui.veilAction.disabled = true;
  // A first page that never arrived is not waited for again: the fresh ticket opens a fresh frame, on the same page.
  if (!frameShown) unmountFrame();
  previewFailed = false;
  closeSocket();
  markLost();
  connect();
  // The guest sees the retry start at once: the veil says it is reconnecting until the relay answers.
  render();
});

ui.action.addEventListener('click', () => {
  if (ui.action.disabled) return;
  ui.action.disabled = true;
  SCREENS[phase]?.action?.run();
  // A run that leaves the guest on this screen (nothing could be done) gives the button back.
  ui.action.disabled = false;
});

// Withdraw the request: the relay takes the guest off the host's list at once, and the name can be changed.
ui.cancel.addEventListener('click', () => {
  send({ type: 'guest:leave' });
  closeSocket();
  settle();
  endAccess();
  forgetPlace();
  setPhase('name');
});

ui.point.addEventListener('click', () => setPointing(!pointing));

ui.follow.addEventListener('change', () => {
  follow = ui.follow.checked;
  if (follow) applyFollow();
  render();
});

for (const button of ui.viewports) {
  button.addEventListener('click', () => {
    const chosen = button.dataset.viewport;
    if (chosen !== 'host' && !Object.hasOwn(VIEWPORTS, /** @type {string} */ (chosen))) return;
    width = /** @type {typeof width} */ (chosen);
    widthChosen = true;
    render();
  });
}

for (const query of [narrow, midsize])
  query.addEventListener('change', () => {
    if (widthChosen) return;
    width = defaultWidth();
    if (phase === 'admitted') render();
  });

ui.barMore.addEventListener('click', () => {
  const open = ui.bar.dataset.open !== 'true';
  ui.bar.dataset.open = String(open);
  if (open && !ui.notes.hidden) closeNotes(false);
  delete ui.barMore.dataset.attention;
  ui.barMore.setAttribute('aria-expanded', String(open));
});

ui.openInBuilder.addEventListener('click', () => (ui.handoff.hidden ? showHandoff(true) : closeHandoff()));
ui.handoffClose.addEventListener('click', () => closeHandoff());
ui.notesButton.addEventListener('click', () => (ui.notes.hidden ? showNotes() : closeNotes()));
ui.notesClose.addEventListener('click', () => closeNotes());
ui.noteText.addEventListener('input', () => {
  // The note is pinned to the page shown when writing began, even if the frame follows the host elsewhere meanwhile;
  // begun before the frame confirmed its page, it is pinned when it does.
  notePath = ui.noteText.value.trim() ? notePage() : null;
  if (!ui.noteError.hidden) ui.noteError.hidden = true;
  renderNotes();
});
ui.noteText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendNote();
  }
});
ui.noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendNote();
});
ui.handoffCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(config.inviteLink);
    ui.handoffCopy.textContent = 'Copied';
    announce('Invite link copied.');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      ui.handoffCopy.textContent = 'Copy link';
    }, 2000);
  } catch {
    // No clipboard here: select the link so the guest can copy it themselves.
    ui.handoffLink.focus();
    ui.handoffLink.select();
  }
});

// A tap or click anywhere else closes the phone's view options and the handoff. Taps on the site go to its frame, not
// this page, so the page losing focus to the frame counts as one too.
document.addEventListener('pointerdown', (event) => {
  const target = /** @type {Node} */ (event.target);
  if (ui.bar.dataset.open === 'true' && !ui.barControls.contains(target) && !ui.barMore.contains(target)) closeOptions();
  if (!ui.handoff.hidden && !ui.handoff.contains(target) && !ui.openInBuilder.contains(target)) closeHandoff(false);
  if (!ui.notes.hidden && !ui.notes.contains(target) && !ui.notesButton.contains(target)) closeNotes(false);
});
window.addEventListener('blur', () => {
  if (!iframe || document.activeElement !== iframe) return;
  closeOptions();
  if (!ui.handoff.hidden) closeHandoff(false);
  if (!ui.notes.hidden) closeNotes(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (pointing) {
    setPointing(false);
    ui.point.focus({ preventScroll: true });
  } else if (!ui.handoff.hidden) closeHandoff();
  else if (!ui.notes.hidden) closeNotes();
  else if (ui.bar.dataset.open === 'true') {
    closeOptions();
    ui.barMore.focus();
  }
});

new ResizeObserver(() => layout()).observe(ui.stage);

window.addEventListener('online', () => {
  if (reconnecting) connect();
});

// A page put away in the back/forward cache lets its socket go (its place is kept for the relay's grace) and takes
// it back when it is shown again.
window.addEventListener('pagehide', (event) => {
  if (!event.persisted || isFinal(phase) || !place?.resumeToken) return;
  closeSocket();
  clearTimeout(reconnectTimer);
  // A page brought back from the cache keeps its frame, where the guest was, but covered until the relay lets the
  // guest back in; a guest who is no longer let in never sees it again.
  markLost();
  render();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !isFinal(phase) && place?.resumeToken) connect();
});

// ---------------------------------------------------------------------------
// Start

if (place?.resumeToken) connect();
else setPhase('name');
started = true;
