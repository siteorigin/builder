/**
 * The live session's reload bridge. The relay adds this script to each page of the host's preview that loads in a
 * guest's viewer frame (relay/src/index.ts, withReloadBridge), because the viewer, on another origin, can neither read
 * where its frame is nor reload it in place. The bridge tells the viewer which page is showing, and when the viewer
 * asks, reloads that page and puts its scroll position back. It listens to nothing but the viewer that framed it, and
 * neither sends nor keeps anything else: the page's site code is the host's own.
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

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== viewer || !event.data || event.data.type !== 'siteorigin-live:reload') return;
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
