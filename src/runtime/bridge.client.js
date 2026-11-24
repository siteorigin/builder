// SiteOrigin Builder preview bridge.
// Injected only into the editor's in-memory development session; never written to project source.
// It reports selection, geometry and diagnostics and accepts a fixed set of editor commands.
const PROTOCOL = 1;
const sessionId = window.name || '';
const parentWin = window.parent;
let mode = 'edit';
let revision = 0;
let selected = null; // descriptor
let hovered = null;
/** The innermost element under the pointer, as last reported to the editor. */
let pointerAt = null;
/** The element `pointerAt` describes. */
let pointerEl = null;
let editing = null; // { el, desc, editId, original, rich }
let linkEditor = null; // { host, input, range }
/** Larger commits than this would be dropped by the editor's message size check, or refused by the editor. */
const MAX_COMMIT_CHARS = 150000;
const MAX_TEXT_CHARS = 20000;
/** On macOS a Control-click opens the context menu, as a right-click does. */
const IS_MAC = /Mac/.test(navigator.platform);
const errors = [];

function send(type, payload = {}) {
  if (!sessionId || parentWin === window) return;
  parentWin.postMessage({ protocolVersion: PROTOCOL, sessionId, navigationId: location.pathname, revision, type, payload }, '*');
}

function descOf(el) {
  return { ctx: el.getAttribute('data-so-ctx') || '', node: el.getAttribute('data-so-node') || '', items: el.getAttribute('data-so-items') || '' };
}
function sameDesc(a, b) {
  return a === b || (!!a && !!b && a.ctx === b.ctx && a.node === b.node && a.items === b.items);
}
/** The innermost of the editor's elements at `target` (itself or the nearest one around it), or null. */
function innermost(target) {
  let el = target instanceof Element ? target : target?.parentElement;
  while (el && el !== document.documentElement) {
    if (el.hasAttribute('data-so-node')) return el;
    el = el.parentElement;
  }
  return null;
}
/**
 * The editor's elements at `target`, innermost first. Only attributes and tag names are read: anything that makes
 * the browser lay the page out (an element's text, its box) would do so on every move of the pointer.
 */
function chainFrom(target) {
  const chain = [];
  for (let el = innermost(target); el && el !== document.documentElement; el = el.parentElement) {
    if (el.hasAttribute('data-so-node')) chain.push({ ...descOf(el), tag: el.tagName.toLowerCase(), code: el.hasAttribute('data-so-code') });
  }
  return chain;
}
function textPreview(el) {
  const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
function findAll(desc) {
  if (!desc) return [];
  const sel = `[data-so-ctx="${cssEscape(desc.ctx)}"][data-so-node="${cssEscape(desc.node)}"]`;
  return [...document.querySelectorAll(sel)].filter((el) => !desc.items || (el.getAttribute('data-so-items') || '') === desc.items);
}
function rectOf(el) {
  let r = el.getBoundingClientRect();
  if (getComputedStyle(el).display === 'contents') {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const c of el.children) {
      const cr = c.getBoundingClientRect();
      if (!cr.width && !cr.height) continue;
      x1 = Math.min(x1, cr.left); y1 = Math.min(y1, cr.top); x2 = Math.max(x2, cr.right); y2 = Math.max(y2, cr.bottom);
    }
    if (x1 === Infinity) return null;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  if (!r.width && !r.height) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

let raf = 0;
function scheduleRects() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (revealDirty) reconcileReveal();
    keepInView();
    sendRects();
    // Checked again every frame while a change of width settles, whatever moves the page meanwhile.
    if (keepHold) scheduleRects();
  });
}
function sendRects() {
  const selEls = selected ? findAll(selected) : [];
  const selBoxes = selEls.map(rectOf);
  sampleSelection(selEls, selBoxes);
  const sel = selBoxes.filter(Boolean);
  const hov = hovered && mode === 'edit' ? findAll(hovered).slice(0, 1).map(rectOf).filter(Boolean) : [];
  // A divider between items is not part of the item it follows.
  const rev = revealRoots().filter((el) => el.tagName !== 'HR').map(rectOf).filter(Boolean);
  send('rects', { selected: sel, hovered: hov, hoveredDesc: hovered, revealed: rev, viewport: { width: innerWidth, height: innerHeight, scrollY } });
}

// ---------------------------------------------------------------------------
// The selection kept in view when the page changes width
// ---------------------------------------------------------------------------

/**
 * Where the selection showed at the last measurement: which of its elements (`el`, and its item ids and place among the
 * elements with those ids, to find it again once the page renders it afresh), the point of it to keep (its top, or for
 * one whose top is scrolled away, the middle of what showed of it, through the editor's element there when there is
 * one) and how far down the frame that point was, as a share of its height. Null when none of it showed.
 */
let keepSample = null;
/** After a change of width: the point to put back, until `until` (performance.now()). */
let keepHold = null;
/** How long after the last change of width the page may still move it (a re-render, an image) and have it put back. */
const KEEP_MS = 250;
/** The width the page was last told about by a resize event. */
let lastWidth = innerWidth;

const itemsOf = (el) => el.getAttribute('data-so-items') || '';
function sampleSelection(els, boxes) {
  // Laid out at a new width the resize event has not announced yet: what showed at the old width is still the one to keep.
  if (innerWidth !== lastWidth) return;
  keepSample = null;
  if (!selected || mode !== 'edit') return;
  const w = innerWidth;
  const h = innerHeight;
  const index = boxes.findIndex((b) => b && b.y < h && b.y + b.height > 0 && b.x < w && b.x + b.width > 0);
  if (index < 0) return;
  const el = els[index];
  const b = boxes[index];
  const items = itemsOf(el);
  const nth = els.slice(0, index).filter((e) => itemsOf(e) === items).length;
  const base = { desc: selected, width: w, el, items, nth };
  if (b.y >= 0) {
    keepSample = { ...base, at: b.y / h, depth: 0, landmark: null };
    return;
  }
  const y = (Math.max(0, b.y) + Math.min(h, b.y + b.height)) / 2;
  const x = (Math.max(0, b.x) + Math.min(w, b.x + b.width)) / 2;
  const hit = innermost(document.elementFromPoint(x, y));
  const hb = hit && hit !== el && el.contains(hit) ? rectOf(hit) : null;
  const landmark = hb && hb.height > 0 && hb.y <= y && y <= hb.y + hb.height ? { el: hit, desc: descOf(hit), depth: (y - hb.y) / hb.height } : null;
  keepSample = { ...base, at: y / h, depth: (y - b.y) / b.height, landmark };
}
/** The page changed width (`widthChanged`, from `before`) or only height: hold the point the selection showed at the last width. */
function holdSelection(widthChanged, before) {
  if (!widthChanged) {
    keepHold = null;
    return;
  }
  const now = performance.now();
  // Still settling from the last width (a drag through many): the same point is kept. What the browser does to the
  // scroll position for the new width is not the author scrolling.
  if (keepHold && now <= keepHold.until) Object.assign(keepHold, { until: now + KEEP_MS, scrollY: null });
  else if (keepSample && keepSample.width === before && sameDesc(keepSample.desc, selected)) keepHold = { ...keepSample, until: now + KEEP_MS, scrollY: null };
  else keepHold = null;
}
/** The selection's element the hold is about: the same one while it is on the page, else the one rendered in its place. */
function heldElement(k) {
  if (k.el.isConnected && findAll(selected).includes(k.el)) return k.el;
  return findAll(selected).filter((e) => itemsOf(e) === k.items)[k.nth] || null;
}
/** Where the held point is in the frame now, or null when it cannot be found. */
function heldPoint(k, el) {
  if (k.landmark) {
    const l = k.landmark;
    const mark = l.el.isConnected && el.contains(l.el) ? l.el : findAll(l.desc).find((m) => el.contains(m));
    const mb = mark && rectOf(mark);
    if (mb) return mb.y + l.depth * mb.height;
  }
  const b = rectOf(el);
  return b ? b.y + k.depth * b.height : null;
}
/** Puts the held point back where it showed, before the outlines are measured. */
function keepInView() {
  const k = keepHold;
  if (!k) return;
  // The list item open in the inspector is brought into view by its own reveal. Anything else that scrolled the page
  // since the last correction (a scrollbar dragged, the site's own code) has the last word.
  if (performance.now() > k.until || mode !== 'edit' || editing || reveal || !sameDesc(k.desc, selected) || (k.scrollY !== null && Math.abs(scrollY - k.scrollY) > 1)) {
    keepHold = null;
    return;
  }
  const el = heldElement(k);
  const y = el && heldPoint(k, el);
  if (y === null || y === undefined) return;
  const delta = y - k.at * innerHeight;
  if (Math.abs(delta) > 1) {
    // 'instant', not 'auto': a site's own smooth scrolling would otherwise animate it.
    window.scrollBy({ top: delta, behavior: 'instant' });
    const after = heldPoint(k, el);
    // A point that does not move with the page (something sticky or fixed) cannot be put back: it is left alone.
    if (after === null || Math.abs(after - (y - delta)) > Math.abs(delta) / 2) {
      keepHold = null;
      return;
    }
  }
  k.scrollY = scrollY;
}
/** Another page or a scroll the editor asked for: what showed before is no longer there to keep. */
function stopKeeping() {
  keepHold = null;
  keepSample = null;
}
// The author's own scrolling (or a click, a key) just after a change of width is never undone. What shows is measured
// again as the page scrolls.
for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, () => (keepHold = null), { capture: true, passive: true });

// ---------------------------------------------------------------------------
// The list item open in the editor's inspector, revealed while it is edited
// ---------------------------------------------------------------------------

/** { ctx, list, items, nodes, within, text?, restore } from the editor (see lib/reveal.ts), or null. */
let reveal = null;
let revealKey = '';
/**
 * Scroll to the item once it is found, once per item and again after the page changes width ('resize': at once, not
 * smoothly): an update or typed text never scrolls back to it.
 */
let revealScroll = false;
/** Disclosures opened for the item. Only these are closed again; one the page or the author opened stays open. */
const revealOpened = new Set();
/**
 * Disclosures the author closed on the page while their item was revealed, by where they are on the page (so one an
 * update renders afresh stays closed too). They stay closed for that item until its text is typed again.
 */
let revealDeclined = new Set();
/** Typed text arrived: a disclosure the author closed over it opens again, so what is typed can be seen. */
let revealTyped = false;
/** The page changed: the item is brought up to date once, before the next frame is drawn. */
let revealDirty = false;
/** Elements showing typed text in place of their own text node: el -> { ours, theirs, released } */
const drafts = new Map();
/** Typed text no longer wanted goes once the page shows the saved text, or after this long at most (a refused save). */
const DRAFT_SETTLE_MS = 4000;
let draftTimer = 0;

function validReveal(t) {
  const str = (v) => typeof v === 'string' && v.length <= 2000;
  const strs = (v, max = 50) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(str);
  const depths = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = new Map(Object.entries(v));
    return out.size > 0 && out.size <= 2000 && [...out.values()].every((n) => Number.isInteger(n) && n >= 0 && n <= 50) ? out : null;
  };
  const within = t && typeof t === 'object' ? depths(t.within) : null;
  if (!within || !str(t.ctx) || !str(t.list) || !t.items || !str(t.items) || !strs(t.nodes)) return null;
  const text = t.text && strs(t.text.nodes) && typeof t.text.value === 'string' && t.text.value.length <= MAX_TEXT_CHARS ? { nodes: t.text.nodes, value: t.text.value } : null;
  return { ctx: t.ctx, list: t.list, items: t.items, nodes: t.nodes, within, text, restore: strs(t.restore) ? t.restore : [] };
}
function setReveal(target) {
  const before = reveal;
  reveal = validReveal(target);
  // The same item while its placement, list and id are: a change to the design only changes how it is found.
  const key = reveal ? JSON.stringify([reveal.ctx, reveal.list, reveal.items]) : '';
  if (key !== revealKey) {
    revealKey = key;
    revealScroll = !!reveal;
    revealDeclined = new Set();
  } else if (reveal && reveal.text && !(before && before.text && before.text.value === reveal.text.value)) revealTyped = true;
  reconcileReveal();
  scheduleRects();
}
/** Where a disclosure is on the page: its placement, node and item, or the element itself when it has none. */
function occurrence(d) {
  return d.hasAttribute('data-so-node') ? [d.getAttribute('data-so-ctx'), d.getAttribute('data-so-node'), d.getAttribute('data-so-items') || ''].join('\n') : d;
}
/** Every disclosure an element sits in, its own included. */
function disclosuresOf(el) {
  const out = [];
  for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) out.push(d);
  return out;
}
/**
 * The item's elements in the placement asked for: those of the list's own nodes whose item ids put the item's id at
 * the depth of that node's repeat. At the top of the design an element's item ids are the item's id exactly; in a list
 * repeated inside another list's rows they are the outer rows' ids, then the item's, and the item shows in each row.
 */
function itemElements() {
  if (!reveal || mode !== 'edit') return [];
  const { items, within } = reveal;
  return [...document.querySelectorAll(`[data-so-ctx="${cssEscape(reveal.ctx)}"][data-so-items]`)].filter((el) => {
    const depth = within.get(el.getAttribute('data-so-node'));
    if (depth === undefined) return false;
    const path = el.getAttribute('data-so-items') || '';
    if (depth === 0) return path === items;
    const parts = path.split(',');
    return parts.length === depth + 1 && parts[depth] === items;
  });
}
const ofNodes = (els, nodes) => els.filter((el) => nodes.includes(el.getAttribute('data-so-node')));
/** The item's outermost elements: what its repeat renders for it. */
function revealRoots() {
  return reveal ? ofNodes(itemElements(), reveal.nodes) : [];
}
/** Brings the page in line with the item asked for. Safe to repeat: it runs again after every re-render. */
function reconcileReveal() {
  revealDirty = false;
  const els = itemElements();
  const roots = reveal ? ofNodes(els, reveal.nodes) : [];
  const textEls = reveal && reveal.text ? ofNodes(els, reveal.text.nodes) : [];
  if (revealTyped) {
    revealTyped = false;
    for (const el of textEls) for (const d of disclosuresOf(el)) revealDeclined.delete(occurrence(d));
  }
  // Every disclosure the item's content sits in, whatever the design wraps it in.
  const need = new Set();
  for (const el of els) for (const d of disclosuresOf(el)) if (!revealDeclined.has(occurrence(d))) need.add(d);
  for (const d of revealOpened) {
    if (need.has(d)) continue;
    revealOpened.delete(d);
    // A detached one too: it may be put back.
    d.open = false;
  }
  for (const d of need) {
    if (d.open) continue;
    d.open = true;
    revealOpened.add(d);
  }
  showDrafts(textEls, reveal && reveal.text ? reveal.text.value : null, reveal ? ofNodes(els, reveal.restore) : []);
  if (revealScroll) {
    const el = roots.find((r) => r.tagName !== 'HR' && rectOf(r));
    if (el) {
      const r = el.getBoundingClientRect();
      // Scrolling never moves focus: the author keeps typing in the inspector.
      // 'instant', not 'auto': a site's own smooth scrolling would otherwise animate it.
      const instant = revealScroll === 'resize' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      revealScroll = false;
      if (r.top < 60 || r.bottom > innerHeight - 20) el.scrollIntoView({ block: r.height > innerHeight - 80 ? 'start' : 'center', behavior: instant ? 'instant' : 'smooth' });
    }
  }
}
/**
 * Typed text (`value`, or null for none), shown in the given plain text elements in a text node of the bridge's own.
 * The page's node is kept aside, not changed, so an update the page makes to it meanwhile is what shows once the
 * typed text goes: at once in the `restoreNow` elements (typing there was cancelled) and in Preview, otherwise once
 * the save has arrived.
 */
function showDrafts(els, value, restoreNow) {
  const want = new Set(value === null ? [] : els);
  const now = new Set(restoreNow);
  for (const [el, d] of drafts) {
    // The page replaced the text itself: nothing of the bridge's is left there.
    if (d.ours.parentNode !== el) drafts.delete(el);
    else if (!el.isConnected || mode !== 'edit' || (now.has(el) && !want.has(el))) restoreDraft(el);
    else if (!want.has(el) && !d.released) {
      d.released = Date.now();
      scheduleSettle();
    }
  }
  if (value === null) return;
  for (const el of want) {
    // The text being edited on the page itself is the inline edit's.
    if (editing && editing.el === el) continue;
    let d = drafts.get(el);
    if (!d) {
      const kids = [...el.childNodes];
      if (kids.length > 1 || (kids[0] && kids[0].nodeType !== Node.TEXT_NODE)) continue;
      d = { ours: document.createTextNode(value), theirs: kids[0] || null, released: 0 };
      drafts.set(el, d);
      if (d.theirs) el.replaceChild(d.ours, d.theirs);
      else el.appendChild(d.ours);
    }
    d.released = 0;
    if (d.ours.nodeValue !== value) d.ours.nodeValue = value;
  }
}
/** Puts the page's own text node back. */
function restoreDraft(el) {
  const d = drafts.get(el);
  if (!d) return;
  drafts.delete(el);
  if (d.ours.parentNode !== el) return;
  if (d.theirs) el.replaceChild(d.theirs, d.ours);
  else el.removeChild(d.ours);
}
/** The page's own text for an element showing typed text. */
function pageText(el, d) {
  return d.theirs ? d.theirs.nodeValue : [...el.childNodes].filter((n) => n !== d.ours).map((n) => n.textContent).join('');
}
/**
 * Typed text no longer wanted goes once the page's own text says the same (the save arrived), so the old text never
 * flashes back in between; or after DRAFT_SETTLE_MS when it never does.
 */
function settleDrafts() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  let waiting = false;
  for (const [el, d] of drafts) {
    if (!d.released) continue;
    if (pageText(el, d) === d.ours.nodeValue || Date.now() - d.released >= DRAFT_SETTLE_MS) restoreDraft(el);
    else waiting = true;
  }
  if (waiting) scheduleSettle();
}
function scheduleSettle() {
  if (!draftTimer) draftTimer = setTimeout(settleDrafts, 150);
}

// ---------------------------------------------------------------------------
// Edit-mode interaction
// ---------------------------------------------------------------------------

document.addEventListener(
  'mousemove',
  (e) => {
    if (mode !== 'edit' || editing) return;
    // Report what is under the pointer; the editor decides what that hover means (what a click would
    // select) and sends it back with `track`, which is what gets outlined. While the pointer stays on the
    // same element nothing is reported, so the elements around it are only looked at once it reaches another.
    const el = innermost(e.target);
    const next = el ? descOf(el) : null;
    // Another element with the same descriptor is news too: the same part of a component placed in another list item
    // differs only further out, in the items its placement carries.
    if (el === pointerEl && sameDesc(next, pointerAt)) return;
    pointerAt = next;
    pointerEl = el;
    send('hover', { chain: chainFrom(el) });
  },
  true
);
document.documentElement.addEventListener('mouseleave', () => {
  pointerAt = null;
  pointerEl = null;
  hovered = null;
  send('hover', { chain: [] });
  scheduleRects();
});

document.addEventListener(
  'click',
  (e) => {
    if (linkEditor && e.target === linkEditor.host) return;
    if (editing && editing.el.contains(e.target)) {
      // Clicks place the caret in the text being edited; they never follow a link or toggle a disclosure.
      if (e.target.closest && e.target.closest('a[href], summary')) e.preventDefault();
      return;
    }
    if (mode !== 'edit') {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && a.origin !== location.origin) {
        e.preventDefault();
        send('externalLink', { href: a.href });
      } else if (a && a.hasAttribute('download')) {
        // The preview downloads nothing; the editor says what visitors get instead.
        e.preventDefault();
        send('download', { name: String(a.getAttribute('download') || '').slice(0, 300) });
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (editing) commitEdit();
    // A disclosure (an FAQ question) still opens and closes while editing, so what is inside can be reached.
    const summary = e.target.closest && e.target.closest('summary');
    const details = summary && summary.parentElement;
    if (details && details.tagName === 'DETAILS') {
      details.open = !details.open;
      // Closed by the author while the inspector reveals its item: it stays closed, and is no longer the bridge's.
      if (details.open) revealDeclined.delete(occurrence(details));
      else {
        revealDeclined.add(occurrence(details));
        revealOpened.delete(details);
      }
      scheduleRects();
    }
    send('select', { chain: chainFrom(e.target), alt: e.altKey, meta: e.metaKey || e.ctrlKey });
  },
  true
);
document.addEventListener(
  'dblclick',
  (e) => {
    if (mode !== 'edit' || editing) return;
    e.preventDefault();
    e.stopPropagation();
    send('dblclick', { chain: chainFrom(e.target) });
  },
  true
);
document.addEventListener(
  'contextmenu',
  (e) => {
    if (mode !== 'edit' || (linkEditor && e.target === linkEditor.host)) return;
    // A right-click in the text being edited is for that text: the app's writing menu (spelling, cut, copy,
    // paste) opens for the word under the pointer, and the selection stays where it is.
    if (editing && editing.el.contains(e.target)) return;
    e.preventDefault();
    send('contextmenu', { chain: chainFrom(e.target), x: e.clientX, y: e.clientY });
  },
  true
);
// Edit stops every form submission before the site's own code sees it, so nothing is sent however the form is
// submitted (Enter, a click, or a script calling requestSubmit). Preview lets a form run its own checks and states,
// and answers what it sends (see Forms below).
document.addEventListener(
  'submit',
  (e) => {
    if (mode === 'edit') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!(e.target instanceof HTMLFormElement)) return;
    // Any form: one without method="post" can still send its answers from its own code.
    lastSubmit = { form: e.target, at: Date.now(), answers: answersOf(e.target) };
    if (!liveTest) return;
    if (liveTest.form === e.target && !liveTest.submitted) liveTest.submitted = true;
    // Another submission while the confirmed one is dispatched (the form's code submitting a second form): the
    // confirmation was for one submission only.
    else liveTest.void = true;
  },
  true
);
// The layout held every submission until this bridge was running; from here the listener above decides.
window.__siteoriginBridge = true;
if (typeof window.__siteoriginHold === 'function') {
  document.removeEventListener('submit', window.__siteoriginHold, true);
  window.__siteoriginHold = undefined;
}
for (const t of ['pointerdown', 'mousedown', 'touchstart']) {
  document.addEventListener(t, (e) => {
    if (linkEditor && e.target === linkEditor.host) return;
    if (mode === 'edit' && !(editing && editing.el.contains(e.target))) e.preventDefault();
  }, { capture: true, passive: false });
}
document.addEventListener('keydown', (e) => {
  if (editing) return;
  if (mode !== 'edit') return;
  // Forward editor shortcuts so they work while the preview has focus.
  if (e.metaKey || e.ctrlKey || e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
    if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable))) {
      e.preventDefault();
      send('key', { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    }
  }
}, true);

// ---------------------------------------------------------------------------
// Forms (issue #193)
// ---------------------------------------------------------------------------
// The editor never sends a message from the site on the author's behalf. In Preview a form that posts runs its own
// checks and shows its own sending, sent and error states, but what it sends (with fetch or XMLHttpRequest) is
// answered here, after a pause, with the reply the author chose to practise. Only a live test the author confirmed
// in the editor lets one message through, from that form, to the address they were shown.

/** How long a practice send waits for its reply, so the form's sending state can be seen. */
const PRACTICE_DELAY = 800;
/** A send this soon after a form was submitted is that form's, even when the form's code waited before sending. */
const SUBMIT_WINDOW = 10000;
/** The reply practice sends get: 'success' or 'error'. */
let practiceResult = 'success';
/** The form last submitted in Preview, when, and the answers the visitor typed into it. */
let lastSubmit = null;
/**
 * A confirmed live test, only while the one submission it starts is being dispatched: { form, id, target, requestId,
 * submitted, sent, void }. A send the form's code makes later (after waiting for something) is a practice like any other,
 * so no other attempt, earlier or later, can ever use the author's confirmation.
 */
let liveTest = null;
/** Bumped when the mode or the page changes: a practice reply from before no longer describes what is shown. */
let formEpoch = 0;
/** Form ids from an earlier page load never match a form of this one. */
const loadId = Math.random().toString(36).slice(2, 8);
const formNumbers = new WeakMap();
let formCount = 0;

// A form's fields are also its properties (a field named "action" or "closest" hides the form's own), so the form's
// attributes and methods are reached through the prototypes.
const formAttr = (form, name) => Element.prototype.getAttribute.call(form, name);
const postsForm = (form) => form instanceof HTMLFormElement && (formAttr(form, 'method') || '').toLowerCase() === 'post';
const isNetlify = (form) => formAttr(form, 'data-netlify') === 'true';
const formsOnPage = () => [...document.querySelectorAll('form')].filter(postsForm);

/** Where an address goes, without its query or fragment: how a send is matched to the form that posts there. */
function destinationOf(url) {
  try {
    const u = new URL(url, document.baseURI);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin + u.pathname : '';
  } catch {
    return '';
  }
}
/** The whole address a send goes to, query included (a service can choose its inbox there), without the fragment. */
function targetOf(url) {
  try {
    const u = new URL(url, document.baseURI);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin + u.pathname + u.search : '';
  } catch {
    return '';
  }
}
/** Where a form posts: its action, or the page itself when it has none (as Netlify Forms do). */
const postsTo = (form) => destinationOf(formAttr(form, 'action') || location.href);
/** Where a form would send a live test: an address of its own on another site. Netlify only receives on the deployed site. */
function liveTarget(form) {
  const to = formAttr(form, 'action') && !isNetlify(form) ? targetOf(formAttr(form, 'action')) : '';
  return to && new URL(to).origin !== location.origin ? to : '';
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/**
 * A form's id for the editor. It changes with the form's settings (where it posts and its hidden fields, a service's
 * key among them), so a live test the author confirmed for the old settings no longer matches the form.
 */
function formIdOf(form) {
  let n = formNumbers.get(form);
  if (!n) formNumbers.set(form, (n = ++formCount));
  const hidden = [...Element.prototype.querySelectorAll.call(form, 'input[type="hidden"]')].map((i) => `${i.name}=${i.value}`).join('&');
  // The address as it resolves now: a relative action means something else once the page's base changes.
  return `${loadId}-${n}-${hash(`${targetOf(formAttr(form, 'action') || location.href)}|${isNetlify(form)}|${hidden}`)}`;
}

/** The forms on the page that post, as the editor shows them. */
function pageForms() {
  return formsOnPage()
    .slice(0, 20)
    .map((form) => {
      const by = formAttr(form, 'aria-labelledby');
      const heading = by ? document.getElementById(by.split(/\s+/)[0]) : null;
      const label = (heading?.textContent || formAttr(form, 'aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const shell = Element.prototype.closest.call(form, '[data-so-ctx^="shell:"]')?.getAttribute('data-so-ctx').slice(6).split('|')[0];
      const action = formAttr(form, 'action');
      return {
        id: formIdOf(form),
        label,
        place: shell === 'header' || shell === 'footer' ? shell : 'page',
        service: isNetlify(form) ? 'netlify' : action ? 'endpoint' : 'none',
        destination: isNetlify(form) || !action ? '' : targetOf(action),
        live: !!liveTarget(form)
      };
    });
}
let formsReported = null;
let formsTimer = 0;
function reportForms() {
  formsTimer = 0;
  const forms = pageForms();
  const key = JSON.stringify(forms);
  if (key === formsReported) return;
  formsReported = key;
  send('forms', { forms });
}
const scheduleForms = () => (formsTimer ||= setTimeout(reportForms, 100));
// The whole document: a <base href> in the head changes where a relative action goes.
new MutationObserver(scheduleForms).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['action', 'method', 'data-netlify', 'value', 'aria-labelledby', 'aria-label', 'href']
});

/** What the visitor typed into a form: its text answers, long enough to recognise in a request. */
function answersOf(form) {
  const answers = [];
  for (const el of Element.prototype.querySelectorAll.call(form, 'input, textarea, select')) {
    if (el instanceof HTMLInputElement && !['text', 'email', 'tel', 'url', 'search', 'number'].includes(el.type)) continue;
    const value = String(el.value ?? '').trim();
    if (value.length >= 3) answers.push(value);
  }
  return answers.slice(0, 50);
}

/** A body the page cannot read back without waiting (a Blob, a stream, a request's own body). */
const UNREADABLE = Symbol('unreadable');
/** Whether a request carries any of a submission's answers, in its query or its body. */
function carriesAnswers(submit, url, body) {
  if (body === UNREADABLE || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof ReadableStream) return true;
  const decode = (text) => {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '));
    } catch {
      return text;
    }
  };
  let text = '';
  try {
    const query = new URL(url, document.baseURI).searchParams;
    // A value in the query counts only whole (an answer of "json" is not ?format=json).
    if ([...query.values()].some((v) => submit.answers.includes(v.trim()))) return true;
  } catch {
    // Not an address: nothing in it.
  }
  if (typeof body === 'string') text += '\n' + body + '\n' + decode(body);
  else if (body instanceof URLSearchParams || body instanceof FormData) for (const v of body.values()) if (typeof v === 'string') text += '\n' + v;
  return submit.answers.some((a) => text.includes(a));
}

/**
 * The form a send belongs to, or null when it is not a form's. A write to where a form posts is that form's (the form
 * just submitted first, as two forms can share a service's address). Any other request soon after a submission is
 * that form's only when it carries the visitor's answers: a GET to another site with them in its query counts, while
 * the site's own pages and data, and requests that carry nothing the visitor typed, go out as usual.
 */
function sendingForm(url, method, body) {
  const write = method !== 'GET' && method !== 'HEAD';
  const to = destinationOf(url);
  // Still counted once the form has left the page or the visitor has moved on: its code may be sending yet.
  const recent = lastSubmit && Date.now() - lastSubmit.at < SUBMIT_WINDOW ? lastSubmit : null;
  if (write) {
    if (recent && postsForm(recent.form) && postsTo(recent.form) === to) return recent.form;
    const posting = to && formsOnPage().find((f) => postsTo(f) === to);
    if (posting) return posting;
  } else if (!to || new URL(to).origin === location.origin) return null;
  return recent && carriesAnswers(recent, url, body) ? recent.form : null;
}

/** The confirmed live test this send is, or null: the form and the whole address must be the ones confirmed. */
function liveFor(form, url) {
  const test = liveTest;
  return mode === 'preview' && test && test.form === form && test.submitted && !test.void && !test.sent && targetOf(url) === test.target ? test : null;
}
/** Reports on a live test, with where it went and, when the service passed it on, where it ended up. */
function liveReply(test) {
  test.sent = true;
  return (result, status, redirected) =>
    send('formResult', { id: test.id, requestId: test.requestId, kind: 'live', result, destination: test.target, ...(status ? { status } : {}), ...(redirected ? { redirected } : {}) });
}

/** A practice send's reports, while they still describe the page shown. */
function practiceReports(form) {
  const id = formIdOf(form);
  const epoch = formEpoch;
  return (result) => epoch === formEpoch && form.isConnected && send('formResult', { id, kind: 'practice', result });
}

/** The practice reply to a fetch: the form's own code reads it as the service's answer. */
function practise(form, signal) {
  const report = practiceReports(form);
  const result = practiceResult;
  const aborted = () => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  if (signal?.aborted) return Promise.reject(aborted());
  report('sending');
  return new Promise((resolve, reject) => {
    const onAbort = () => (clearTimeout(timer), reject(aborted()));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      report(result);
      resolve(new Response(JSON.stringify({ ok: result === 'success' }), { status: result === 'success' ? 200 : 503, headers: { 'Content-Type': 'application/json' } }));
    }, PRACTICE_DELAY);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Loaded after the site's own scripts, so every send the page makes comes through here.
const nativeFetch = window.fetch;
window.fetch = function fetch(input, init) {
  const request = input instanceof Request ? input : null;
  const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
  const url = request ? request.url : String(input);
  // A body of null or undefined is none given: the request's own is sent.
  const body = init?.body != null ? init.body : request?.body ? UNREADABLE : undefined;
  const form = sendingForm(url, method, body);
  if (!form) return nativeFetch.call(window, input, init);
  const test = liveFor(form, url);
  // A signal given as undefined is no signal given: the request's own still counts.
  if (!test) return practise(form, init?.signal !== undefined ? init.signal : request?.signal);
  const reply = liveReply(test);
  reply('sending');
  return nativeFetch.call(window, input, init).then(
    // A reply the page may not read (an opaque one) says nothing about whether the message arrived.
    (response) => (reply(!response.status ? 'unreadable' : response.ok ? 'sent' : 'refused', response.status, response.redirected ? targetOf(response.url) : ''), response),
    (error) => {
      reply('unreadable');
      throw error;
    }
  );
};

// The same for XMLHttpRequest. A practice success is answered with a small JSON reply, a practice error with a failed
// request (a data: address with no data), neither of which leaves the page.
const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSend = XMLHttpRequest.prototype.send;
const xhrAbort = XMLHttpRequest.prototype.abort;
const DATA_OK = 'data:application/json,%7B%22ok%22%3Atrue%7D';
/** Each request's method and address as the browser opened it, and its outcome once it has one. */
const xhrTargets = new WeakMap();
const xhrWatched = new WeakSet();
XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
  // Recorded before the browser opens it (its readystatechange handlers can send at once), and put back if the open
  // throws, which leaves the earlier one in place.
  const before = xhrTargets.get(this);
  xhrTargets.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), document.baseURI).href });
  let opened;
  try {
    opened = xhrOpen.call(this, method, url, ...rest);
  } catch (error) {
    if (before) xhrTargets.set(this, before);
    else xhrTargets.delete(this);
    throw error;
  }
  if (!xhrWatched.has(this)) {
    xhrWatched.add(this);
    // Added when the request is first opened, ahead of handlers that could open it again before loadend.
    this.addEventListener('readystatechange', () => {
      const target = this.readyState === 4 ? xhrTargets.get(this) : null;
      if (target) Object.assign(target, { status: this.status, responseURL: this.responseURL });
    });
  }
  return opened;
};
XMLHttpRequest.prototype.abort = function abort() {
  const target = xhrTargets.get(this);
  if (target?.practising) {
    // A practice send the page gives up before its reply: the page hears the abort as it would from the network.
    clearTimeout(target.practising);
    target.practising = 0;
    xhrOpen.call(this, 'GET', DATA_OK);
    xhrSend.call(this);
  }
  return xhrAbort.call(this);
};
XMLHttpRequest.prototype.send = function send(body) {
  const target = xhrTargets.get(this);
  const form = target ? sendingForm(target.url, target.method, body) : null;
  if (!form) return xhrSend.call(this, body);
  const test = liveFor(form, target.url);
  if (test) {
    const reply = liveReply(test);
    reply('sending');
    this.addEventListener(
      'loadend',
      () => reply(!target.status ? 'unreadable' : target.status < 400 ? 'sent' : 'refused', target.status, target.responseURL && targetOf(target.responseURL) !== test.target ? targetOf(target.responseURL) : ''),
      { once: true }
    );
    return xhrSend.call(this, body);
  }
  const report = practiceReports(form);
  const result = practiceResult;
  report('sending');
  target.practising = setTimeout(() => {
    target.practising = 0;
    // The page opened the request again for something else while it waited.
    if (xhrTargets.get(this) !== target) return;
    this.addEventListener('loadend', () => report(target.status === 200 ? 'success' : 'error'), { once: true });
    xhrOpen.call(this, 'GET', result === 'success' ? DATA_OK : 'data:');
    xhrSend.call(this);
  }, PRACTICE_DELAY);
};
// A beacon has no reply to practise with: one from a form is dropped, and reports itself queued.
if (navigator.sendBeacon) {
  const beacon = navigator.sendBeacon;
  navigator.sendBeacon = function sendBeacon(url, data) {
    return sendingForm(String(url), 'POST', data) ? true : beacon.call(navigator, url, data);
  };
}

/**
 * Send one real message from a form the author confirmed, with the answers in it now, to the address they were shown.
 * Only a send the form makes while this submission is dispatched can use the confirmation.
 */
function liveTestForm(id, target, requestId) {
  const reply = (result) => send('formResult', { id, requestId, kind: 'live', result });
  const form = mode === 'preview' ? formsOnPage().find((f) => formIdOf(f) === id) : null;
  // The form must still be there with the settings the author confirmed (its id changes with them), sending where
  // the author was told it would.
  if (!form || !target || liveTarget(form) !== target) return reply('unavailable');
  const test = { form, id, target, requestId, submitted: false, sent: false };
  liveTest = test;
  try {
    // The browser checks the answers first; a form that is not valid is never submitted.
    HTMLFormElement.prototype.requestSubmit.call(form);
  } finally {
    liveTest = null;
  }
  if (!test.submitted) reply('invalid');
  else if (!test.sent) reply('not-sent');
}

// Whether something on the page that takes typing has focus: a visitor's form field in Preview, or a field or
// editable region reached with Tab while editing. The editor uses this only to leave Undo, Delete and paste to
// it; it never runs a command because of it. Sent once the bridge is ready (a field can have focus already),
// then on every change.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
const takesTyping = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);
let textFocused = null;
function reportTextFocus() {
  const on = takesTyping(document.activeElement);
  if (on === textFocused) return;
  textFocused = on;
  send('textFocus', { on });
}
document.addEventListener('focusin', reportTextFocus, true);
// Focus has not moved on yet while focusout runs. A field removed while focused may not report leaving, so a
// press anywhere checks again.
for (const t of ['focusout', 'pointerdown']) document.addEventListener(t, () => setTimeout(reportTextFocus), true);

// ---------------------------------------------------------------------------
// Inline text editing
// ---------------------------------------------------------------------------

function beginTextEdit(desc, editId) {
  const el = findAll(desc)[0];
  // The editor is waiting for this edit to end: tell it there is nothing to edit.
  if (!el) return send('textCancel', { desc, editId });
  if (editing) commitEdit();
  // Typed text shown there from the inspector gives way to the page's own text, which the edit then works on.
  restoreDraft(el);
  const rich = el.classList.contains('so-rich');
  // selectedAll: the whole text is still selected as the edit began (until a key or a press inside it).
  // before: the plain text shown as the edit began, so the editor can tell what the author typed over.
  editing = { el, desc, editId, original: el.innerHTML, rich, selectedAll: true, before: rich ? null : el.innerText.replace(/\s+/g, ' ').trim() };
  // Rich text keeps its bold, italic (⌘B, ⌘I) and links (⌘K); everything else is plain text.
  el.setAttribute('contenteditable', rich ? 'true' : 'plaintext-only');
  el.setAttribute('spellcheck', 'true');
  el.style.outline = 'none';
  el.style.cursor = 'text';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
  el.addEventListener('keydown', onEditKey);
  el.addEventListener('blur', onEditBlur);
  el.addEventListener('input', scheduleRects);
  el.addEventListener('paste', onEditPaste);
  el.addEventListener('drop', onEditDrop);
  el.addEventListener('pointerdown', onEditPress);
  // Edit → Select All, which reaches the text with no key or press: the selection is now the author's.
  el.addEventListener('selectstart', onEditSelectStart);
  send('textEditStarted', { desc });
}
/**
 * A right-click (or Control-click) on text the edit selected when it began goes to the word under the pointer,
 * as it does anywhere else in the text: kept inside the whole selection, it would get no spelling suggestions.
 * A selection the author made is left for Cut and Copy.
 */
function onEditPress(e) {
  if (!editing) return;
  const fresh = editing.selectedAll;
  editing.selectedAll = false;
  if (!fresh || !(e.button === 2 || (IS_MAC && e.button === 0 && e.ctrlKey))) return;
  const at = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (!at || !editing.el.contains(at.startContainer)) return;
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(at);
}
function onEditSelectStart() {
  if (editing) editing.selectedAll = false;
}
/** Keys that only hold a modifier (Control before a Control-click) leave the selection as it is. */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Fn']);
function onEditKey(e) {
  if (editing && !MODIFIER_KEYS.has(e.key)) editing.selectedAll = false;
  e.stopPropagation();
  // Keys that compose a character (an IME, a dead key for an accent) belong to the composition.
  if (e.isComposing || e.keyCode === 229) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) {
    e.preventDefault();
    if (editing.rich && k !== 'u') document.execCommand(k === 'b' ? 'bold' : 'italic');
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && k === 'k') {
    e.preventDefault();
    openLinkEditor();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  } else if (e.key === 'Enter' && !e.shiftKey && !editing.rich) {
    e.preventDefault();
    commitEdit();
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    commitEdit();
  }
}
function onEditBlur() {
  // Moving into the link editor is still the same edit.
  if (editing && !linkEditor) commitEdit();
}

const LINK_EDITOR_CSS = `
  form { display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: #1b1d21; box-shadow: 0 6px 24px rgb(0 0 0 / 0.32); font: 13px/1.2 system-ui, sans-serif; }
  input { width: 220px; height: 28px; box-sizing: border-box; padding: 0 8px; border: 1px solid #4a4e57; border-radius: 5px; background: #111316; color: #f4f5f7; font: inherit; outline: none; }
  input:focus { border-color: #7aa7ff; }
  input[aria-invalid='true'] { border-color: #ff7a7a; }
  button { height: 28px; padding: 0 9px; border: 0; border-radius: 5px; background: #2d3037; color: #f4f5f7; font: inherit; cursor: pointer; }
  button:hover, button:focus-visible { background: #40444d; outline: none; }
`;

/** ⌘K while editing rich text: a small field for the selected words' link, or the link under the caret. */
function openLinkEditor() {
  if (!editing || !editing.rich || linkEditor) return;
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0).cloneRange();
  if (!editing.el.contains(range.commonAncestorContainer)) return;
  const at = range.commonAncestorContainer;
  const found = (at.nodeType === 1 ? at : at.parentElement).closest('a');
  const anchor = found && editing.el.contains(found) ? found : null;
  if (anchor) range.selectNodeContents(anchor);
  else if (range.collapsed) return;
  const box = range.getBoundingClientRect();
  const host = document.createElement('div');
  const top = box.bottom + 50 > innerHeight ? Math.max(8, box.top - 44) : box.bottom + 6;
  host.style.cssText = `position: fixed; z-index: 2147483647; left: ${Math.max(8, Math.min(box.left, innerWidth - 340))}px; top: ${top}px;`;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${LINK_EDITOR_CSS}</style><form><input aria-label="Link destination" placeholder="/about/, https://…, email or phone" spellcheck="false"><button type="submit">Apply</button>${anchor ? '<button type="button">Remove</button>' : ''}</form>`;
  const input = root.querySelector('input');
  input.value = anchor ? anchor.getAttribute('href') || '' : '';
  // Pressing a button keeps focus in the field, so the edit does not end on the way to the click.
  root.addEventListener('mousedown', (e) => e.target !== input && e.preventDefault());
  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    applyLink(input.value);
  });
  const remove = root.querySelector('button[type="button"]');
  if (remove) remove.addEventListener('click', () => applyLink(''));
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLinkEditor(true);
    }
  });
  root.addEventListener('focusout', (e) => {
    if (!linkEditor || linkEditor.input !== input || root.contains(e.relatedTarget)) return;
    closeLinkEditor(false);
    commitEdit();
  });
  linkEditor = { host, input, range };
  document.documentElement.appendChild(host);
  input.focus();
  input.select();
}
function closeLinkEditor(restore) {
  if (!linkEditor) return;
  const { host, range } = linkEditor;
  linkEditor = null;
  host.remove();
  if (restore && editing) {
    editing.el.focus();
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }
}
/** Only destinations the editor can store are written; it checks them again when the edit is committed. */
function applyLink(raw) {
  const text = raw.trim();
  if (!text) {
    closeLinkEditor(true);
    document.execCommand('unlink');
    return;
  }
  const href = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(text) ? `mailto:${text}` : /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(text) ? `https://${text}` : text;
  if (!/^(https?:\/\/\S|mailto:\S|tel:\S|#\S|\/)/i.test(href)) {
    linkEditor.input.setAttribute('aria-invalid', 'true');
    return;
  }
  const { range } = linkEditor;
  // The text changed underneath the field: there is no longer a selection to link.
  if (range.collapsed || !editing.el.contains(range.commonAncestorContainer)) {
    linkEditor.input.setAttribute('aria-invalid', 'true');
    return;
  }
  closeLinkEditor(true);
  document.execCommand('createLink', false, href);
}
/** Pasted content arrives as plain text: formatting, images and markup from elsewhere never get in. */
function onEditPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  document.execCommand('insertText', false, editing && !editing.rich ? text.replace(/\s+/g, ' ') : text);
}
function onEditDrop(e) {
  e.preventDefault();
}
function endEdit() {
  closeLinkEditor(false);
  const { el } = editing;
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  el.style.outline = '';
  el.style.cursor = '';
  el.removeEventListener('keydown', onEditKey);
  el.removeEventListener('blur', onEditBlur);
  el.removeEventListener('input', scheduleRects);
  el.removeEventListener('paste', onEditPaste);
  el.removeEventListener('drop', onEditDrop);
  el.removeEventListener('pointerdown', onEditPress);
  el.removeEventListener('selectstart', onEditSelectStart);
  editing = null;
  getSelection()?.removeAllRanges();
  // The edited element no longer takes typing, but keeps focus without a focus event.
  reportTextFocus();
}
/** The last edit handed to the editor, so text the editor did not keep can be put back. */
const committed = new Map();
/** `detached`: an update re-rendered the element away while it was edited, so the page may now show other text. */
function commitEdit(detached = false) {
  if (!editing) return;
  const { el, desc, editId, rich, original, before } = editing;
  // Nothing changed: end the edit without a commit, so no history entry or rebuild follows.
  if (el.innerHTML === original) {
    endEdit();
    return send('textCancel', { desc, editId });
  }
  // Rich text goes back as a small copy of its structure (blocks, lists, breaks, marks, links) for the editor
  // to turn into its stored form; plain text as its words.
  const payload = rich ? { desc, editId, rich: richCopy(el) } : { desc, editId, text: el.innerText.replace(/\s+/g, ' ').trim() };
  if (detached) Object.assign(payload, { detached: true }, typeof before === 'string' ? { before } : {});
  // Too much to send or to keep: put the text back and say why, rather than lose the edit on the way.
  if ((rich && !payload.rich) || (!rich && payload.text.length > MAX_TEXT_CHARS) || JSON.stringify(payload).length > MAX_COMMIT_CHARS) {
    el.innerHTML = original;
    endEdit();
    return send('textCancel', { desc, editId, reason: 'too-large' });
  }
  endEdit();
  committed.set(editId, { el, original, left: el.innerHTML });
  // Only the last few can still be answered: older ones are let go.
  while (committed.size > 8) committed.delete(committed.keys().next().value);
  send('textCommit', payload);
}
/** Text, element names, inline marks, list kinds and links of what an edit left, as plain data; null when too large. */
function richCopy(root) {
  let budget = 4000;
  const copy = (n, depth) => {
    if (budget-- <= 0 || depth > 16) throw new Error('too large');
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return null;
    const out = { tag: n.tagName.toLowerCase(), children: [] };
    const w = n.style && n.style.fontWeight;
    if (w) out.b = w === 'bold' || w === 'bolder' || Number(w) >= 600;
    const st = n.style && n.style.fontStyle;
    if (st) out.i = st === 'italic' || st === 'oblique';
    if (out.tag === 'ul' && n.classList.contains('so-rich--check')) out.check = true;
    if (out.tag === 'a' && n.hasAttribute('href')) {
      out.href = n.getAttribute('href');
      if (out.href.length > 2100) throw new Error('too large');
      if (n.getAttribute('target') === '_blank') out.newTab = true;
    }
    for (const c of n.childNodes) {
      const v = copy(c, depth + 1);
      if (v !== null) out.children.push(v);
    }
    return out;
  };
  try {
    return [...root.childNodes].map((c) => copy(c, 0)).filter((v) => v !== null);
  } catch {
    return null;
  }
}
function cancelEdit() {
  if (!editing) return;
  const { el, original, desc, editId } = editing;
  // Untouched text keeps its live nodes, which Svelte still owns.
  if (el.innerHTML !== original) el.innerHTML = original;
  endEdit();
  send('textCancel', { desc, editId });
}

// ---------------------------------------------------------------------------
// Layout inspection (no screenshots; structural and geometric evidence only)
// ---------------------------------------------------------------------------

/** Waits for `promise`, or until `deadline` (a Date.now() time), whichever comes first. */
function until(deadline, promise) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** Resolves when the image has loaded or failed, removing both of its listeners. */
function imageDone(img) {
  return new Promise((resolve) => {
    const end = () => {
      img.removeEventListener('load', end);
      img.removeEventListener('error', end);
      resolve();
    };
    img.addEventListener('load', end);
    img.addEventListener('error', end);
    if (img.complete) end();
  });
}

/** Resolves when fonts are ready and images have loaded (or failed), or at `deadline` at the latest. */
async function settled(deadline) {
  // Asked for first: the browser can hold this until the page has loaded, which waits for its images.
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  // Hydration or an update can replace images while earlier ones load, so look again until none is pending.
  for (let round = 0; round < 3 && Date.now() < deadline; round++) {
    // The inspection frame is never scrolled, so lazy images would otherwise never start loading.
    for (const img of document.images) if (img.loading === 'lazy') img.loading = 'eager';
    // The switch starts each request on a later task; until then a deferred image can look finished.
    await new Promise((r) => setTimeout(r, 0));
    const pending = [...document.images].filter((i) => !i.complete);
    if (!pending.length) break;
    await until(deadline, Promise.all(pending.map(imageDone)));
  }
  await until(deadline, fonts);
  // The final layout, once what changes it has arrived.
  await until(deadline, new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * The image's address as an author would recognise it: the path on this site, or the address elsewhere. An
 * inline image's address is its whole content, so it is named, never sent (it could exceed a message's size).
 */
function imagePath(url) {
  if (/^(data|blob):/i.test(url)) return 'an inline image';
  try {
    const u = new URL(url, location.href);
    return (u.origin === location.origin ? decodeURI(u.pathname) : u.href).slice(0, 300);
  } catch {
    return String(url).slice(0, 300);
  }
}

/**
 * Requests the image again in a fresh element: true when it loads, false when the request fails or the file is
 * not an image, null when it is still loading at `deadline`. (Load events, not decode(): a hidden measuring frame
 * does not render, so decode() may never settle there.)
 */
function probe(url, deadline) {
  return new Promise((resolve) => {
    const img = new Image();
    const finish = (v) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      if (v === null) img.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/**
 * Every image on the page, each with an outcome: loaded; failed (its file could not be loaded, confirmed by
 * requesting it again); or unverified (still loading when the check ran out of time, which says nothing about
 * the site). An image whose element shows nothing but whose file loads when requested again counts as loaded:
 * the measuring frame missed it, not the site.
 */
async function imageReport(deadline) {
  // sources: the address each image was given (not the variant chosen), so the editor can tell a load that
  // shows an image the page no longer has.
  const summary = { total: 0, loaded: 0, failed: 0, unverified: 0, failedFiles: [], sources: [] };
  const issues = [];
  const checks = [];
  for (const img of document.querySelectorAll('img')) {
    const url = img.currentSrc || img.getAttribute('src') || '';
    if (!url) continue;
    summary.total++;
    if (summary.sources.length < 200) summary.sources.push(imagePath(img.getAttribute('src') || url));
    if (img.complete && img.naturalWidth > 0) {
      summary.loaded++;
      continue;
    }
    checks.push(
      probe(url, deadline).then((ok) => {
        const path = imagePath(url);
        if (ok === true) summary.loaded++;
        else if (ok === false) {
          summary.failed++;
          if (summary.failedFiles.length < 10) summary.failedFiles.push(path.slice(path.lastIndexOf('/') + 1) || path);
          issues.push({ kind: 'broken-image', message: `Image ${path} failed to load.` });
        } else {
          summary.unverified++;
          issues.push({ kind: 'image-unverified', message: `Image ${path} was still loading when the check ran out of time, so it could not be checked. This is not a problem with the site.` });
        }
      })
    );
  }
  await Promise.all(checks);
  return { summary, issues };
}

/**
 * In an isolated component preview (one component on a page of its own, see @shared/component-preview): whether it
 * rendered, why not, the box it fills and the text it shows; undefined on a page of the site.
 */
function previewState() {
  const p = window.__siteoriginPreview;
  if (!p || typeof p !== 'object') return undefined;
  const out = { key: String(p.key || ''), mounted: p.mounted === true };
  if (p.error) out.error = String(p.error).slice(0, 2000);
  // Everything the component puts on the page: its boxes, and text with no box of its own, looking through wrappers
  // that take no box (a code component's, and any it has inside).
  let bounds = null;
  const add = (r) => {
    if (!r || (!r.width && !r.height)) return;
    if (!bounds) bounds = { x: r.x, y: r.y, width: r.width, height: r.height };
    else {
      const x2 = Math.max(bounds.x + bounds.width, r.x + r.width);
      const y2 = Math.max(bounds.y + bounds.height, r.y + r.height);
      bounds.x = Math.min(bounds.x, r.x);
      bounds.y = Math.min(bounds.y, r.y);
      bounds.width = x2 - bounds.x;
      bounds.height = y2 - bounds.y;
    }
  };
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        add(range.getBoundingClientRect());
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (getComputedStyle(child).display === 'contents') visit(child);
        else add(child.getBoundingClientRect());
      }
    }
  };
  const main = document.getElementById('main');
  if (main) visit(main);
  out.bounds = bounds;
  // What it says, as a reader would read it: evidence of the sample values without a picture of them.
  const text = main ? (main.innerText || '').trim().replace(/\s+/g, ' ') : '';
  out.text = text.length > 1000 ? text.slice(0, 999) + '…' : text;
  return out;
}

async function inspect(deadline) {
  // Images first: one that arrives while they are requested again can still change the layout measured below.
  const images = await imageReport(deadline);
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const docWidth = document.documentElement.scrollWidth;
  if (docWidth > vw + 1) issues.push({ kind: 'horizontal-overflow', message: `The page is ${docWidth}px wide in a ${vw}px viewport.` });
  for (const el of document.querySelectorAll('[data-so-node]')) {
    const r = rectOf(el);
    if (!r) continue;
    if (r.x + r.width > vw + 2 || r.x < -2) {
      const d = descOf(el);
      if (!issues.some((i) => i.desc && i.desc.ctx === d.ctx && i.desc.node === d.node))
        issues.push({ kind: 'element-overflow', desc: d, text: textPreview(el), message: `Extends beyond the viewport (${Math.round(r.x)}–${Math.round(r.x + r.width)}px of ${vw}px).` });
    }
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0 && el.children.length === 0)
      issues.push({ kind: 'text-overflow', desc: descOf(el), text: textPreview(el), message: 'Text is wider than its box.' });
  }
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) issues.push({ kind: 'missing-alt', message: `Image ${imagePath(img.getAttribute('src') || '')} has no alt attribute.` });
  // After the layout findings, which the cap must not hide; the image counts in `images` are never capped.
  issues.push(...images.issues);
  const placeholders = document.querySelectorAll('.so-img--placeholder').length;
  if (placeholders) issues.push({ kind: 'image-placeholder', message: `${placeholders} image placeholder(s) have no image chosen.` });
  const preview = previewState();
  // A page has one h1; a component shown on its own is not a page.
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1 && !preview) issues.push({ kind: 'heading-structure', message: `The page has ${h1} h1 headings (expected 1).` });
  for (const a of document.querySelectorAll('a')) if (!a.textContent.trim() && !a.getAttribute('aria-label')) issues.push({ kind: 'empty-link', message: 'A link has no accessible name.' });
  // Which top-level page sections rendered ("page:<id>|<node>"), so the editor can tell a stale page load.
  const sections = new Set();
  for (const el of document.querySelectorAll('[data-so-ctx^="page:"][data-so-node]')) {
    const ctx = el.getAttribute('data-so-ctx');
    sections.add(ctx.includes('|') ? ctx.split('|').slice(0, 2).join('|') : `${ctx}|${el.getAttribute('data-so-node')}`);
  }
  return { path: location.pathname, sections: [...sections].slice(0, 500), viewportWidth: vw, documentWidth: docWidth, documentHeight: document.documentElement.scrollHeight, images: images.summary, issues: issues.slice(0, 40), runtimeErrors: errors.slice(-10), ...(preview ? { preview } : {}) };
}

// ---------------------------------------------------------------------------
// Commands from the editor
// ---------------------------------------------------------------------------

window.addEventListener('message', async (e) => {
  if (e.source !== parentWin) return;
  const m = e.data;
  if (!m || m.sessionId !== sessionId || m.protocolVersion !== PROTOCOL) return;
  switch (m.type) {
    case 'mode':
      mode = m.payload.mode === 'preview' ? 'preview' : 'edit';
      formEpoch++;
      if (editing) commitEdit();
      document.documentElement.toggleAttribute('data-so-editing', mode === 'edit');
      // A full-size image a visitor opened in Preview is a modal: it would cover the page being edited.
      if (mode === 'edit') for (const viewer of document.querySelectorAll('dialog.so-viewer[open]')) viewer.close();
      hovered = null;
      pointerAt = null;
      pointerEl = null;
      // Preview shows the disclosures as visitors find them; editing reveals the item again.
      reconcileReveal();
      scheduleRects();
      break;
    case 'track':
      selected = m.payload.selected || null;
      if (m.payload.hovered !== undefined) hovered = m.payload.hovered;
      scheduleRects();
      break;
    case 'scrollTo': {
      const el = findAll(m.payload.desc)[0];
      if (el) {
        stopKeeping();
        const target = getComputedStyle(el).display === 'contents' ? el.firstElementChild || el : el;
        const r = target.getBoundingClientRect();
        // Shown from Layers (`show`), one taller than the frame shows from its top. A pick on the page itself keeps its
        // place on the page.
        const block = m.payload.show && r.height > innerHeight - 80 ? 'start' : 'center';
        if (r.top < 60 || r.bottom > innerHeight - 20) target.scrollIntoView({ block, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      break;
    }
    case 'navigate': {
      const path = String(m.payload.path || '/');
      if (!path.startsWith('/') || path.startsWith('//')) return;
      try {
        const nav = await import('$app/navigation');
        await nav.goto(path);
      } catch {
        location.assign(path);
      }
      break;
    }
    // Back or Forward in a visitor's journey: a step to a neighbouring entry of this frame's own history, which
    // the site restores (its page and scroll position) as the browser's Back does. Only while previewing, and only
    // to an entry that is still there; a step that does not happen reports where the page still is.
    case 'traverse': {
      const nav = window.navigation;
      const key = String(m.payload.key || '');
      const current = nav && nav.currentEntry;
      const list = current ? nav.entries() : [];
      const i = current ? current.index : -1;
      const near = i >= 0 && ((list[i - 1] && list[i - 1].key === key) || (list[i + 1] && list[i + 1].key === key));
      if (mode !== 'preview' || !near) {
        reportHistory();
        break;
      }
      const step = nav.traverseTo(key);
      // Both promises reject when the step is cancelled or superseded: never an error of the page's.
      step.committed.catch(() => undefined);
      step.finished.catch(() => reportHistory());
      break;
    }
    case 'reveal':
      setReveal(m.payload.target);
      break;
    case 'beginTextEdit':
      beginTextEdit(m.payload.desc, m.payload.editId);
      break;
    // The editor is saving, or leaving the project: hand back the text being edited, as leaving it would. A
    // link still being typed is left out, as moving focus away does (a link already there keeps its address),
    // and the editor is told so it can say.
    // The editor kept nothing from that edit and nothing will rebuild: show the element as it was.
    case 'restoreText':
      // Only over the text the author left: anything newer (a rebuild, another edit) stays.
      {
        // Each edit's own record, so a reply for one never answers (or forgets) another.
        const c = committed.get(m.payload.editId);
        if (c && c.el.isConnected && editing?.el !== c.el && c.el.innerHTML === c.left) c.el.innerHTML = c.original;
        committed.delete(m.payload.editId);
      }
      break;
    case 'commitTextEdit':
      if (!editing) break;
      if (linkEditor) {
        closeLinkEditor(false);
        send('linkDropped', { desc: editing.desc, editId: editing.editId });
      }
      commitEdit();
      break;
    case 'measure': {
      const descs = Array.isArray(m.payload.descs) ? m.payload.descs.slice(0, 200) : [];
      send('measured', { requestId: m.payload.requestId, rects: descs.map((d) => { const el = findAll(d)[0]; return el ? rectOf(el) : null; }) });
      break;
    }
    case 'inspect':
      // This frame is measured and never scrolled: a classic scrollbar would take its width from the viewport.
      document.documentElement.style.scrollbarWidth = 'none';
      // Measure only once web fonts and images have settled: both change line wrapping and widths. Images that
      // still show nothing then get their own, shorter, deadline to be requested again.
      await settled(Date.now() + 4000);
      send('inspectResult', { requestId: m.payload.requestId, report: await inspect(Date.now() + 2500) });
      break;
    case 'revision':
      revision = m.payload.revision;
      break;
    // The reply practice sends get from now on.
    case 'formPractice':
      practiceResult = m.payload.result === 'error' ? 'error' : 'success';
      break;
    case 'formLiveTest':
      liveTestForm(String(m.payload.id || ''), String(m.payload.target || ''), String(m.payload.requestId || ''));
      break;
  }
});

window.addEventListener('scroll', scheduleRects, { passive: true });
window.addEventListener('resize', () => {
  // The item is checked at another width: brought back into view if the new layout moved it out. A change of
  // height alone (the editor window resized) leaves the page where the author put it.
  const widthChanged = innerWidth !== lastWidth;
  if (reveal && widthChanged) {
    revealScroll = 'resize';
    revealDirty = true;
  }
  // The selection keeps showing what it showed at the last width, at the same place in the frame (issue #168).
  holdSelection(widthChanged, lastWidth);
  lastWidth = innerWidth;
  scheduleRects();
});
new ResizeObserver(scheduleRects).observe(document.documentElement);
new MutationObserver(() => {
  // The page re-rendered the element being edited away (an update arrived): the edit is over. Text typed into it
  // is handed to the editor as it would be on leaving it, never dropped: the editor checks it against what the
  // update changed before it is saved, and keeps it for the author when it cannot be.
  if (editing && !editing.el.isConnected) {
    // A link still being typed has nowhere to go: say so, as saving does.
    if (linkEditor) {
      closeLinkEditor(false);
      send('linkDropped', { desc: editing.desc, editId: editing.editId });
    }
    commitEdit(true);
  }
  // An update re-rendered the page: a revealed item comes back closed, and without the text being typed. Brought up
  // to date once per frame, however many changes arrive.
  if (reveal || revealOpened.size || drafts.size) revealDirty = true;
  // Outlines are measured again only while there is one to keep in place. With nothing selected, hovered while
  // editing or revealed, the editor already has none, so a change to the page is neither measured nor reported.
  if (revealDirty || selected || (hovered && mode === 'edit')) scheduleRects();
}).observe(document.body, { childList: true, subtree: true, characterData: true });
window.addEventListener('error', (e) => {
  errors.push(String(e.message));
  send('runtimeError', { message: String(e.message) });
});
window.addEventListener('unhandledrejection', (e) => {
  errors.push(String(e.reason));
  send('runtimeError', { message: String(e.reason) });
});

function reportNav() {
  stopKeeping();
  send('navigated', { path: location.pathname });
  scheduleRects();
  // What a practice send says belongs to the page it started on.
  formEpoch++;
  scheduleForms();
}
window.addEventListener('siteorigin:navigated', reportNav);
window.addEventListener('popstate', reportNav);

/**
 * Where this frame is in its own history: the address with its #fragment, and the keys of the entries either side,
 * so the editor can offer Back and Forward through a visitor's journey. Every link, section jump, Back and Forward
 * changes the current entry. Without the Navigation API only the address is known.
 */
function reportHistory() {
  const nav = window.navigation;
  const current = nav && nav.currentEntry;
  const list = current ? nav.entries() : [];
  const i = current ? current.index : -1;
  // Exactly as the page has it (site addresses are plain letters, numbers and hyphens). A very long query gives way
  // before the #fragment does.
  const hash = location.hash.slice(0, 300);
  let address = location.pathname + location.search;
  if (address.length + hash.length > 2000) address = address.slice(0, 1999 - hash.length) + '…';
  send('history', {
    address: address + hash,
    key: (current && current.key) || null,
    back: (i > 0 && list[i - 1] && list[i - 1].key) || null,
    forward: (i >= 0 && list[i + 1] && list[i + 1].key) || null
  });
}
if (window.navigation) window.navigation.addEventListener('currententrychange', reportHistory);

if (import.meta.hot) {
  import.meta.hot.on('siteorigin:revision', (data) => {
    revision = data.revision;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        settleDrafts();
        send('revisionApplied', { revision });
      })
    );
  });
  import.meta.hot.on('vite:error', (data) => send('runtimeError', { message: data?.err?.message || 'Build error' }));
}

const style = document.createElement('style');
// A button with no destination is left out of the site: Edit shows it flagged so it can be fixed, Preview leaves it
// out as visitors will see the page. A note only for the author (a video section with no video yet) is the same.
// A placement's styles for a code component are important, so hiding takes the weight of an id no element has.
style.textContent =
  'html[data-so-editing] a, html[data-so-editing] summary, html[data-so-editing] button { cursor: default; } html[data-so-editing] [contenteditable] { cursor: text; }' +
  ' html:not([data-so-editing]) :is([data-so-unlinked], [data-so-editor-only]):not(#so-editor) { display: none !important; }' +
  ' html[data-so-editing] [data-so-unlinked] { cursor: default; box-shadow: none; opacity: 0.6; outline: 2px dashed #d97706; outline-offset: 2px; }';
document.head.appendChild(style);
document.documentElement.toggleAttribute('data-so-editing', true);
const previewAtStart = previewState();
send('ready', { path: location.pathname, title: document.title, ...(previewAtStart ? { preview: previewAtStart } : {}) });
reportHistory();
reportTextFocus();
reportForms();
