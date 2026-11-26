/**
 * The guest's viewer for a live session: the page behind an invite link. A guest gives a name, waits in the room until
 * the host lets them in, then watches the host's site live in a frame on the room's own preview origin.
 *
 * The relay's guest socket (`/s/<roomId>/ws`) carries everything: the guest's place and status, the host's presence
 * and reloads. Once admitted, the guest's preview ticket is redeemed on the preview origin for its cookie, and only
 * then is the frame made. The page keeps no cookies of its own; its place in the room (the name and the resume token
 * the relay gave it) lives in this tab's sessionStorage, so a reload or a dropped connection takes the same place
 * back. When the guest's access ends for any reason, the frame is removed at once.
 */
import { BRIDGE_MESSAGES, CLOSE_CODES, isFramePath, normalizeDisplayName, PREVIEW_ADMISSION_PATH, VIEWPORTS } from './shared.js';

const root = /** @type {HTMLElement} */ (document.getElementById('live-session'));
const config = {
  roomId: root.dataset.roomId ?? '',
  socketUrl: root.dataset.socketUrl ?? '',
  previewOrigin: root.dataset.previewOrigin ?? '',
  inviteLink: root.dataset.inviteLink ?? '',
  version: Number(root.dataset.protocolVersion),
  nameMax: Number(root.dataset.nameMax)
};
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const ui = {
  bar: $('bar'),
  barMeta: /** @type {HTMLElement} */ (root.querySelector('.bar-meta')),
  barControls: /** @type {HTMLElement} */ (root.querySelector('.bar-controls')),
  title: $('site-title'),
  connection: $('connection'),
  role: $('role'),
  time: $('time'),
  follow: /** @type {HTMLInputElement} */ ($('follow')),
  viewports: /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[data-viewport]')]),
  openInBuilder: $('copy-invite'),
  handoff: $('handoff'),
  handoffText: $('handoff-text'),
  handoffLink: /** @type {HTMLInputElement} */ ($('handoff-link')),
  handoffCopy: $('handoff-copy'),
  handoffClose: $('handoff-close'),
  stage: $('stage'),
  frame: $('frame'),
  veil: $('veil'),
  veilText: $('veil-text'),
  screen: $('screen'),
  screenTitle: $('screen-title'),
  screenText: $('screen-text'),
  form: /** @type {HTMLFormElement} */ ($('join')),
  name: /** @type {HTMLInputElement} */ ($('name')),
  nameError: $('name-error'),
  waiting: $('waiting'),
  action: /** @type {HTMLButtonElement} */ ($('screen-action'))
};

/** How long the viewer keeps trying to take its place back after its socket drops: a little past the relay's grace. */
const RECONNECT_FOR_MS = 150_000;
/** How long a reload waits for the bridge to answer before the frame is pointed at its page again instead. */
const RELOAD_FALLBACK_MS = 1500;
/** How long a ticket's redemption may take before it is given up; a ticket is good for a minute. */
const REDEEM_TIMEOUT_MS = 15_000;
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
/** The page the frame is on, as its bridge last said or as the viewer last pointed it. */
let framePath = '/';
/** @type {string | null} */
let queuedTicket = null;
let redeeming = false;
/** @type {AbortController | null} */
let redemption = null;
/** Whether the frame may be behind the host: it was kept while the socket was down, when reloads could be missed. */
let stale = false;
/** Whether the guest was let in on this page, and the site's name then, so a final screen keeps the bar saying Ended. */
let wasAdmitted = false;
let siteTitle = '';

/** @type {{ previewPath: string | null; viewportWidth: number } | null} */
let hostPage = null;
let follow = true;
/** @type {keyof typeof VIEWPORTS} */
let viewport = 'desktop';

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
      settle();
      const before = guest?.role;
      guest = { role: frame.role === 'collaborator' ? 'collaborator' : 'viewer', projectName: String(frame.projectName ?? ''), guestExpiresAt: typeof frame.guestExpiresAt === 'number' ? frame.guestExpiresAt : null };
      sessionExpiresAt = Number(frame.sessionExpiresAt) || 0;
      anchorClock(frame.now);
      wasAdmitted = true;
      siteTitle = guest.projectName;
      if (typeof frame.previewTicket === 'string') redeem(frame.previewTicket);
      setPhase('admitted');
      // A guest who becomes a collaborator is told how to edit; an open handoff always says what the role is now.
      if (guest.role === 'collaborator' && before !== 'collaborator') showHandoff();
      else if (!ui.handoff.hidden) showHandoff();
      return;
    }
    case 'declined':
      return finish('declined');
    case 'kicked':
      return finish('kicked');
    case 'locked':
      return finish('locked');
    case 'ended':
      return finish('ended');
    case 'expired':
      return finish(frame.scope === 'guest' ? 'expired-guest' : 'expired-session');
  }
}

/** The socket is back in the room: any reconnecting is over. */
function settle() {
  reconnecting = false;
  lostSince = 0;
  retries = 0;
}

/** @param {number} code */
function onClose(code) {
  if (isFinal(phase)) {
    // The status came first; the close only says more about why the session ended.
    if (phase === 'ended' && code === CLOSE_CODES.HOST_GONE) setPhase('host-gone');
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
  // This tab may now miss a revocation, so nothing is loaded into the frame until the relay has let it back in.
  grant++;
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
  redemption?.abort();
  stale = false;
  previewReady = false;
  previewFailed = false;
  reconnecting = false;
  guest = null;
  hostPage = null;
  clearTimeout(reconnectTimer);
  clearTimeout(reloadFallback);
  clearInterval(ticker);
  ticker = undefined;
  ui.handoff.hidden = true;
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
      else if (stale) refreshFrame();
      else applyFollow();
      stale = false;
    } else {
      previewFailed = true;
    }
    render();
  }
  redeeming = false;
}

function mountFrame() {
  if (iframe) return layout();
  const start = follow && hostPage?.previewPath ? hostPage.previewPath : '/';
  iframe = document.createElement('iframe');
  iframe.id = 'preview';
  iframe.title = guest?.projectName ? `Live preview of ${guest.projectName}` : 'Live preview';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', FRAME_SANDBOX);
  framePath = start;
  iframe.src = `${config.previewOrigin}${start}`;
  ui.frame.replaceChildren(iframe);
  layout();
}

function unmountFrame() {
  if (!iframe) return;
  iframe.remove();
  iframe = null;
  ui.frame.replaceChildren();
}

/** @param {string} path */
function navigate(path) {
  if (!iframe || !isFramePath(path)) return;
  framePath = path;
  iframe.src = `${config.previewOrigin}${path}`;
}

/** Load the frame's page again, or the host's when following it: after anything that may have left it behind. */
function refreshFrame() {
  if (!iframe || !previewReady) return;
  layout();
  navigate(follow && hostPage?.previewPath ? hostPage.previewPath : framePath);
}

/** Show the host's latest work: the bridge reloads the page the guest is on, where it is scrolled to. */
function reloadPreview() {
  if (!iframe?.contentWindow || !previewReady || reconnecting) return;
  clearTimeout(reloadFallback);
  // A page the bridge could not run on (its own policy refused the script) is pointed at its page again instead.
  reloadFallback = setTimeout(() => navigate(framePath), RELOAD_FALLBACK_MS);
  iframe.contentWindow.postMessage({ type: BRIDGE_MESSAGES.reload }, config.previewOrigin);
}

window.addEventListener('message', (event) => {
  if (!iframe || event.source !== iframe.contentWindow || event.origin !== config.previewOrigin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === BRIDGE_MESSAGES.reloading) clearTimeout(reloadFallback);
  else if (data.type === BRIDGE_MESSAGES.ready && isFramePath(data.path)) framePath = data.path;
});

/** Following the host: show the host's page at the host's width. */
function applyFollow() {
  if (!follow || !hostPage) return;
  layout();
  if (iframe && previewReady && hostConnected && hostPage.previewPath && hostPage.previewPath !== framePath) navigate(hostPage.previewPath);
}

function frameWidth() {
  return follow && hostPage ? hostPage.viewportWidth : VIEWPORTS[viewport];
}

/** Size the frame to its width, scaled down to fit the stage when the stage is narrower, so its layout is the real one. */
function layout() {
  const width = frameWidth();
  const room = ui.stage.clientWidth;
  const height = ui.stage.clientHeight;
  const scale = room > 0 && width > room ? room / width : 1;
  ui.frame.style.width = `${Math.round(width * scale)}px`;
  if (iframe) {
    iframe.style.width = `${width}px`;
    iframe.style.height = `${Math.max(0, Math.round(height / scale))}px`;
    iframe.style.transform = scale === 1 ? '' : `scale(${scale})`;
  }
  root.dataset.frameWidth = String(width);
  for (const button of ui.viewports) button.setAttribute('aria-pressed', String(!follow && button.dataset.viewport === viewport));
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
  if (seconds < 60) return `${seconds}s`;
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
  if (end && clock.at > 0 && relayNow() >= end.at) return finish(end.own ? 'expired-guest' : 'expired-session');
  renderTime();
}

function renderTime() {
  const end = accessEnd();
  ui.time.hidden = !end;
  if (end) ui.time.textContent = `${end.own ? 'Your access ends in' : 'Ends in'} ${formatLeft(end.at - relayNow())}`;
}

// ---------------------------------------------------------------------------
// Screens

/** @type {Record<Phase, { title: string; text: string; action?: { label: string; run: () => void } } | null>} */
const SCREENS = {
  name: { title: 'Join the live session', text: 'You have been invited to watch a website being designed, live. Enter your name so the host knows who is asking.' },
  connecting: { title: 'Joining…', text: 'Connecting to the live session.' },
  pending: { title: 'Waiting for the host', text: '' },
  admitted: null,
  unavailable: { title: 'This session isn’t available', text: 'It may have ended, or the link may be wrong. Check the invite link with the host.', action: { label: 'Try again', run: connect } },
  lost: { title: 'Connection lost', text: 'This page could not reach the live session for a while.', action: { label: 'Reconnect', run: connect } },
  replaced: { title: 'Open in another tab', text: 'You joined this session from another tab or window, so this one has stopped.', action: { label: 'Use this tab instead', run: connect } },
  full: { title: 'This session is full', text: 'It already has as many guests as it can hold. Try again in a little while.', action: { label: 'Try again', run: connect } },
  locked: { title: 'This session is locked', text: 'The host isn’t letting anyone new in right now. Ask them to unlock it, then try again.', action: { label: 'Try again', run: connect } },
  declined: { title: 'The host declined your request', text: 'You can ask again if you think that was a mistake.', action: { label: 'Ask again', run: () => setPhase('name') } },
  kicked: { title: 'You were removed', text: 'The host removed you from the live session.' },
  'expired-guest': { title: 'Your access has ended', text: 'The time the host gave you in this session is up.' },
  'expired-session': { title: 'This session has ended', text: 'It reached the end of its time. Thanks for joining.' },
  ended: { title: 'The host ended the session', text: 'Thanks for joining.' },
  'host-gone': { title: 'This session has ended', text: 'The host’s connection dropped and they didn’t come back in time.' },
  error: { title: 'Something went wrong', text: 'The live session could not be joined from this page.', action: { label: 'Try again', run: connect } }
};

/** @param {Phase} next */
function setPhase(next) {
  phase = next;
  root.dataset.phase = next;
  if (next === 'admitted' && !ticker) ticker = setInterval(tick, 1000);
  render();
}

function render() {
  const inRoom = phase === 'admitted';
  // A guest who was watching keeps the bar, saying the session is over, above the screen that says why.
  const over = !inRoom && wasAdmitted && isFinal(phase);
  ui.bar.hidden = !inRoom && !over;
  ui.barMeta.hidden = over;
  ui.barControls.hidden = over;
  ui.stage.hidden = !inRoom;
  ui.screen.hidden = inRoom;
  if (inRoom) renderRoom();
  else renderScreen();
  if (over) {
    ui.title.textContent = siteTitle;
    ui.connection.dataset.state = 'ended';
    ui.connection.textContent = 'Ended';
  }
}

function renderScreen() {
  const screen = SCREENS[phase] ?? SCREENS.error;
  if (!screen) return;
  let title = screen.title;
  let text = screen.text;
  if (phase === 'pending') {
    title = hostConnected ? 'Waiting for the host' : 'The host is reconnecting';
    text = hostConnected
      ? `You asked to join as ${place?.displayName ?? 'a guest'}. This page will update as soon as the host lets you in.`
      : 'The host’s connection dropped. Your request is kept, and this page will update when they’re back.';
    if (reconnecting) text = 'Reconnecting to the live session. Your request is kept.';
  }
  if (phase === 'connecting' && reconnecting) text = 'Reconnecting to the live session.';
  ui.screenTitle.textContent = title;
  ui.screenText.textContent = text;
  const asking = phase === 'name';
  ui.form.hidden = !asking;
  if (asking && !ui.name.value && place) ui.name.value = place.displayName;
  if (!asking) ui.nameError.hidden = true;
  ui.waiting.hidden = phase !== 'pending' && phase !== 'connecting';
  ui.action.hidden = !screen.action;
  if (screen.action) ui.action.textContent = screen.action.label;
}

function renderRoom() {
  if (!guest) return;
  ui.title.textContent = guest.projectName;
  ui.role.textContent = guest.role === 'collaborator' ? 'Collaborator' : 'Viewer';
  ui.role.dataset.role = guest.role;
  const state = reconnecting || !hostConnected ? 'reconnecting' : previewReady ? 'live' : 'connecting';
  ui.connection.dataset.state = state;
  ui.connection.textContent = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : 'Connecting';
  ui.follow.checked = follow;
  renderTime();
  let veil = '';
  if (reconnecting) veil = 'Reconnecting to the live session…';
  else if (previewFailed) veil = 'The preview could not be opened. Reload this page to try again.';
  else if (!previewReady) veil = 'Opening the preview…';
  else if (!hostConnected) veil = 'The host’s connection dropped. The page will update when they’re back.';
  ui.veil.hidden = !veil;
  ui.veil.dataset.soft = String(previewReady && !reconnecting);
  ui.veilText.textContent = veil;
  layout();
}

function showHandoff() {
  const collaborator = guest?.role === 'collaborator';
  ui.handoffText.textContent = collaborator
    ? 'You can edit this site with the host. Open this invite link in SiteOrigin Builder to start editing; this page only shows the preview.'
    : 'To edit with the host, ask them to make you a collaborator, then open this invite link in SiteOrigin Builder.';
  ui.handoffLink.value = config.inviteLink;
  ui.handoffCopy.textContent = 'Copy link';
  ui.handoff.hidden = false;
}

// ---------------------------------------------------------------------------
// The guest's own controls

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = normalizeDisplayName(ui.name.value, config.nameMax);
  if (!name) {
    ui.nameError.textContent = `Enter a name of 1 to ${config.nameMax} characters.`;
    ui.nameError.hidden = false;
    ui.name.focus();
    return;
  }
  ui.nameError.hidden = true;
  wasAdmitted = false;
  place = { displayName: name };
  savePlace();
  connect();
});

ui.action.addEventListener('click', () => {
  const screen = SCREENS[phase];
  screen?.action?.run();
});

ui.follow.addEventListener('change', () => {
  follow = ui.follow.checked;
  if (follow) applyFollow();
  render();
});

for (const button of ui.viewports) {
  button.addEventListener('click', () => {
    const chosen = /** @type {keyof typeof VIEWPORTS} */ (button.dataset.viewport);
    if (!Object.hasOwn(VIEWPORTS, chosen)) return;
    // Choosing a width is browsing on one's own: the host's width no longer applies.
    viewport = chosen;
    follow = false;
    render();
  });
}

ui.openInBuilder.addEventListener('click', showHandoff);
ui.handoffClose.addEventListener('click', () => {
  ui.handoff.hidden = true;
});
ui.handoffCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(config.inviteLink);
    ui.handoffCopy.textContent = 'Copied';
  } catch {
    // No clipboard here: select the link so the guest can copy it themselves.
    ui.handoffLink.focus();
    ui.handoffLink.select();
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
  markLost();
  // A page brought back from the cache shows nothing of the site until the relay has let the guest back in.
  unmountFrame();
  render();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !isFinal(phase) && place?.resumeToken) connect();
});

// ---------------------------------------------------------------------------
// Start

if (place?.resumeToken) connect();
else setPhase('name');
