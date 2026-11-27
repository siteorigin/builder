/**
 * The live session's reload bridge. The relay adds this script to each page of the host's preview that loads in a
 * guest's viewer frame (relay/src/index.ts, withReloadBridge), because the viewer, on another origin, can neither read
 * where its frame is nor reload it in place. The bridge tells the viewer which page is showing, and when the viewer
 * asks, reloads that page and puts its scroll position back, or takes the guest's next click as pointing at what it
 * lands on for the host (#768). It listens to nothing but the viewer that framed it, and neither sends nor keeps
 * anything else: the page's site code is the host's own.
 */
(() => {
  if (window.parent === window) return;
  // On the relay's own refusal page (relay/src/index.ts, refusedInFrame) the bridge says only that, and nothing else.
  const refused = document.currentScript?.hasAttribute('data-refused') ?? false;
  // The viewer is the preview origin less its first label: `p-<label>.<relay host>` is framed by `<relay host>`.
  const host = location.host;
  const viewer = `${location.protocol}//${host.slice(host.indexOf('.') + 1)}`;
  const KEY = 'siteorigin-live:scroll';
  const path = () => `${location.pathname}${location.search}`;
  if (refused) {
    window.parent.postMessage({ type: 'siteorigin-live:refused' }, viewer);
    return;
  }

  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    sessionStorage.removeItem(KEY);
  } catch {
    saved = null;
  }
  if (saved && saved.href === location.href && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const restore = () => window.scrollTo(saved.x, saved.y);
    if (document.readyState === 'complete') restore();
    else window.addEventListener('load', restore, { once: true });
  }

  // Pointing (#768): while the viewer asks, the guest's next click on the page points at what it landed on, for the
  // host, instead of doing what it would. The page reports the element the editor's preview marks there (its
  // data-so-* attributes, when the page has them) and the point as shares of the page's whole width and height.
  let pointing = false;
  const MAX_ID = 128;
  const MAX_DEPTH = 16;
  const OWNER = /^(page|shell|component|template|archive):(.+)$/;
  /** The element the editor's preview marks around `el`, as the editor names it, or null. */
  const targetOf = (el) => {
    const marked = el instanceof Element ? el.closest('[data-so-ctx][data-so-node]') : null;
    if (!marked) return null;
    const ctx = marked.getAttribute('data-so-ctx') || '';
    const nodeId = marked.getAttribute('data-so-node') || '';
    const items = marked.getAttribute('data-so-items') || '';
    if (ctx.length > 4096 || items.length > 4096) return null;
    const [head, ...instancePath] = ctx.split('|');
    const owner = OWNER.exec(head);
    const itemPath = items ? items.split(',').map((id) => id.replace(/%(25|2C)/g, (_, c) => (c === '25' ? '%' : ','))) : [];
    const ids = [owner?.[2] ?? '', nodeId, ...instancePath, ...itemPath];
    if (!owner || ids.some((id) => !id || id.length > MAX_ID) || instancePath.length > MAX_DEPTH || itemPath.length > MAX_DEPTH) return null;
    return { owner: { kind: owner[1], id: owner[2] }, instancePath, nodeId, ...(itemPath.length ? { itemPath } : {}) };
  };
  const share = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  const stopPointing = () => {
    pointing = false;
    document.documentElement.removeAttribute('data-siteorigin-pointing');
  };
  /** While pointing, the page shows a crosshair everywhere, its links and buttons too. */
  let cursor = null;
  const startPointing = () => {
    pointing = true;
    if (!cursor) {
      cursor = document.createElement('style');
      // An embed (a video player, a map) would take the click itself, out of the bridge's reach: it points at its box instead.
      cursor.textContent = 'html[data-siteorigin-pointing], html[data-siteorigin-pointing] * { cursor: crosshair !important; } html[data-siteorigin-pointing] :is(iframe, embed, object) { pointer-events: none !important; }';
      (document.head || document.documentElement).append(cursor);
    }
    document.documentElement.setAttribute('data-siteorigin-pointing', '');
  };
  // Captured before the page's own handlers, so the click points and does nothing else: no link followed, no button
  // pressed, no form sent, whether by mouse, touch or a key.
  const swallow = (event) => {
    if (!pointing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'dblclick', 'touchstart', 'submit']) window.addEventListener(type, swallow, { capture: true, passive: false });
  /** Point at what is at (x, y) in the page's window, for the host, and stop pointing. */
  const pointAt = (target, x, y) => {
    stopPointing();
    const root = document.documentElement;
    const width = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0, 1);
    const height = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0, 1);
    window.parent.postMessage({ type: 'siteorigin-live:pointed', path: path(), target: targetOf(target), x: share((x + window.scrollX) / width), y: share((y + window.scrollY) / height) }, viewer);
  };
  window.addEventListener(
    'click',
    (event) => {
      if (!pointing) return;
      swallow(event);
      const [first] = event.composedPath();
      pointAt(first ?? event.target, event.clientX, event.clientY);
    },
    true
  );
  // A tap points where it lands, before the page's own touch handlers, and no click follows it.
  window.addEventListener(
    'touchend',
    (event) => {
      if (!pointing) return;
      swallow(event);
      const touch = event.changedTouches[0];
      if (touch) pointAt(document.elementFromPoint(touch.clientX, touch.clientY) ?? event.target, touch.clientX, touch.clientY);
    },
    { capture: true, passive: false }
  );
  window.addEventListener(
    'keydown',
    (event) => {
      if (!pointing) return;
      // While pointing, the page takes no keys either: Escape stops pointing, and nothing else reaches the site.
      swallow(event);
      if (event.key !== 'Escape') return;
      stopPointing();
      window.parent.postMessage({ type: 'siteorigin-live:point-cancelled' }, viewer);
    },
    true
  );
  window.addEventListener('pagehide', stopPointing);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== viewer || !event.data) return;
    if (event.data.type === 'siteorigin-live:point') {
      if (event.data.on === true) startPointing();
      else stopPointing();
      return;
    }
    if (event.data.type !== 'siteorigin-live:reload') return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ href: location.href, x: window.scrollX, y: window.scrollY }));
    } catch {
      // Without storage the page still reloads; the browser's own scroll restoration may still put it back.
    }
    window.parent.postMessage({ type: 'siteorigin-live:reloading' }, viewer);
    location.reload();
  });

  // The site's own router moves with history.pushState, which raises no event; a cheap look each half second catches it
  // without touching the site's code.
  let last = path();
  const ready = () => {
    last = path();
    window.parent.postMessage({ type: 'siteorigin-live:ready', path: last }, viewer);
  };
  ready();
  window.addEventListener('popstate', ready);
  setInterval(() => {
    if (path() !== last) ready();
  }, 500);
})();
