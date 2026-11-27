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
// The empty slots of the selected placement the editor draws Add buttons in (#657): measured with each outline.
let trackedSlots = [];
/** The innermost element under the pointer, as last reported to the editor. */
let pointerAt = null;
/** The element `pointerAt` describes. */
let pointerEl = null;
let editing = null; // { el, desc, editId, original, rich }
let linkEditor = null; // { host, input, error, range, check }
let toolbar = null; // { host, root, buttons, range, backward }
/** The editor's own controls on the page (the link field, the formatting toolbar): presses there are for them. */
const ownUi = (t) => !!t && ((linkEditor && t === linkEditor.host) || (toolbar && t === toolbar.host));
/** Counts the link field's checks, so only the answer to the latest one is acted on. */
let linkChecks = 0;
/** The id of the editor's page request on its way, if any (see the navigate message). */
let navRequest = null;
/** Larger commits than this would be dropped by the editor's message size check, or refused by the editor. */
const MAX_COMMIT_CHARS = 150000;
const MAX_TEXT_CHARS = 20000;
const errors = [];

/**
 * The page's path as the project spells its routes ("/お問い合わせ/"), where the browser keeps it escaped
 * ("/%E3%81%8A…/"). Escapes of a slash, "?" or "#" stay escaped, as decodeURI leaves them, so the path never
 * names another place; a path that is not valid UTF-8 is reported as it is, and matches no page.
 */
function readablePath(pathname) {
  try {
    return decodeURI(pathname);
  } catch {
    return pathname;
  }
}

/** The path of the page the frame shows, as readablePath spells it. */
const shownPath = () => readablePath(location.pathname);

/**
 * This document's own name, so a later load of the same page is never taken for it, and how many times it has moved
 * to another page in place: together they name the navigation each message comes from (§17.4). The editor drops what
 * a navigation it has moved past reports about the page.
 */
const documentId = 'd' + Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('');
let navigationSeq = 0;
let navigationId = `${documentId}.0`;
/** The address (path and query) the current navigation arrived at. */
let navigatedTo = location.pathname + location.search;
/**
 * A page arrived in place: what is sent from here on is about it. A jump within the page (a #section, Back to one)
 * or a request for the page already shown is no new page, and keeps the navigation, so what the editor asked of
 * the page meanwhile is still answered. Shown on the page for the test driver.
 */
function nextNavigation() {
  const at = location.pathname + location.search;
  if (at === navigatedTo) return;
  navigatedTo = at;
  navigationId = `${documentId}.${++navigationSeq}`;
  document.documentElement.setAttribute('data-so-navigation', navigationId);
}
document.documentElement.setAttribute('data-so-navigation', navigationId);
/** A command the editor stamped with a navigation this frame has since moved on from. */
const leftBehind = (m) => !!m.navigationId && m.navigationId !== navigationId;

/**
 * A page the editor asks for may be one just added: its file is on disk, but the preview server takes a moment to
 * pick up a new route, and a full load that arrives first is answered Not Found (on a slower machine, Windows, often).
 * The address asked for is kept for the load it may lead to, and that load, answered 404, loads the page again a few
 * times before it is shown as missing. Only an address the editor asked for: a visitor's broken link stays missing.
 */
const ASKED_KEY = 'siteorigin:asked';
const MISSING_RELOADS = 6;
function askedFor(path) {
  try {
    sessionStorage.setItem(ASKED_KEY, JSON.stringify({ path: new URL(path, location.href).pathname, tries: 0 }));
  } catch {
    // Without storage, a page not there yet stays missing until the editor asks again.
  }
}
/** Load the page again when it is one the editor asked for and the server did not have yet; true when it will. */
function reloadMissingPage() {
  let asked = null;
  try {
    asked = JSON.parse(sessionStorage.getItem(ASKED_KEY) || 'null');
    sessionStorage.removeItem(ASKED_KEY);
  } catch {
    return false;
  }
  const status = performance.getEntriesByType('navigation')[0]?.responseStatus;
  if (!asked || asked.path !== location.pathname || status !== 404 || !(asked.tries < MISSING_RELOADS)) return false;
  try {
    sessionStorage.setItem(ASKED_KEY, JSON.stringify({ path: asked.path, tries: asked.tries + 1 }));
  } catch {
    return false;
  }
  setTimeout(() => location.reload(), 250 * (asked.tries + 1));
  return true;
}

function send(type, payload = {}) {
  if (!sessionId || parentWin === window) return;
  parentWin.postMessage({ protocolVersion: PROTOCOL, sessionId, navigationId, revision, type, payload }, '*');
}

function descOf(el) {
  return { ctx: el.getAttribute('data-so-ctx') || '', node: el.getAttribute('data-so-node') || '', items: el.getAttribute('data-so-items') || '' };
}
function sameDesc(a, b) {
  return a === b || (!!a && !!b && a.ctx === b.ctx && a.node === b.node && a.items === b.items && (a.part || '') === (b.part || '') && a.slot === b.slot);
}
/**
 * The slot an empty slot's placeholder stands for, as the editor names it: its placement's descriptor and the slot's
 * name. Null for anything else, and for a placeholder that names no placement (one in a component's design).
 */
function slotDescOf(el) {
  if (!el.hasAttribute('data-so-slot-empty') || !el.hasAttribute('data-so-slot-node')) return null;
  return { ctx: el.getAttribute('data-so-slot-ctx') || '', node: el.getAttribute('data-so-slot-node') || '', items: el.getAttribute('data-so-slot-items') || '', slot: el.getAttribute('data-so-slot-empty') || '' };
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
 * The code placement a marked part belongs to: the nearest of the editor's elements around it, when that is a code
 * component's. A mark inside content placed in a slot (an element of the page's own), or in no placement at all,
 * names no part.
 */
function partOwner(el) {
  const at = innermost(el.parentElement);
  return at && at.hasAttribute('data-so-code') ? at : null;
}
/** The class the editor gives a code placement's declared part through the hook its styles take (see the generator). */
const PART_CLASS = 'so-part--';
/**
 * The part a code component's element is: the one its author marked with `data-so-part`, or the one whose class the
 * placement gave it (`so-part--total`). Only attributes are read.
 */
function partIdOf(el) {
  if (el.hasAttribute('data-so-part')) return el.getAttribute('data-so-part') || '';
  // The placement's class comes after any the code writes itself, so the last one is the part's.
  let part = '';
  for (const c of el.classList || []) if (c.startsWith(PART_CLASS) && c.length > PART_CLASS.length) part = c.slice(PART_CLASS.length);
  return part;
}
/** A marked part of a code placement: its placement's descriptor and the part's ID, or null for anything else. */
function partDesc(el) {
  if (el.hasAttribute('data-so-node')) return null;
  const part = partIdOf(el);
  const owner = part ? partOwner(el) : null;
  return owner ? { ...descOf(owner), part } : null;
}
/**
 * What the pointer is on, as the editor names it: the innermost marked part of a code placement or editor element
 * at `target`, with its descriptor; null when there is none.
 */
function pointedAt(target) {
  for (let el = target instanceof Element ? target : target?.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    if (el.hasAttribute('data-so-node')) return { el, desc: descOf(el) };
    const slot = slotDescOf(el);
    if (slot) return { el, desc: slot };
    const desc = partDesc(el);
    if (desc) return { el, desc };
  }
  return null;
}
/**
 * The editor's elements at `target`, innermost first. Only attributes and tag names are read: anything that makes
 * the browser lay the page out (an element's text, its box) would do so on every move of the pointer. With `parts`,
 * the parts a code component's author marked are named too, each just inside the placement it belongs to.
 */
function chainFrom(target, parts = false) {
  const chain = [];
  for (let el = parts ? target instanceof Element ? target : target?.parentElement : innermost(target); el && el !== document.documentElement; el = el.parentElement) {
    if (el.hasAttribute('data-so-node')) chain.push({ ...descOf(el), tag: el.tagName.toLowerCase(), code: el.hasAttribute('data-so-code') });
    else if (parts) {
      // An empty slot's placeholder names that slot of its placement, innermost.
      const desc = slotDescOf(el) || partDesc(el);
      if (desc) chain.push({ ...desc, tag: el.tagName.toLowerCase() });
    }
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
  // A placement's empty slot: its placeholder, wherever the placement's component shows the slot.
  if (typeof desc.slot === 'string') {
    const sel = `[data-so-slot-empty="${cssEscape(desc.slot)}"][data-so-slot-ctx="${cssEscape(desc.ctx)}"][data-so-slot-node="${cssEscape(desc.node)}"]`;
    return [...document.querySelectorAll(sel)].filter((el) => !desc.items || (el.getAttribute('data-so-slot-items') || '') === desc.items);
  }
  const sel = `[data-so-ctx="${cssEscape(desc.ctx)}"][data-so-node="${cssEscape(desc.node)}"]`;
  const els = [...document.querySelectorAll(sel)].filter((el) => !desc.items || (el.getAttribute('data-so-items') || '') === desc.items);
  if (typeof desc.part !== 'string' || !desc.part) return els;
  // A marked part of a code placement: every element of that placement's own markup carrying the marker (the
  // author's code can show one more than once), never one in another placement or in content placed in a slot.
  const marked = `[data-so-part="${cssEscape(desc.part)}"], .${cssEscape(PART_CLASS + desc.part)}`;
  return els.filter((el) => el.hasAttribute('data-so-code')).flatMap((el) => [...el.querySelectorAll(marked)].filter((p) => !p.hasAttribute('data-so-node') && partIdOf(p) === desc.part && partOwner(p) === el));
}
/** The box an element is laid out as (with display: contents, its first child that shows), and whether its container
 *  lays its items out by CSS order: only a flex or grid container does. */
function layoutItem(el) {
  const shows = (c) => {
    const position = getComputedStyle(c).position;
    if (position === 'absolute' || position === 'fixed') return false;
    const r = c.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  // The first child that lays out, through children that lay out no box either (an image's <picture>).
  const laid = (box) => {
    // Through the prototype: a form's control named "children" would hide the form's own.
    for (const c of Object.getOwnPropertyDescriptor(Element.prototype, 'children').get.call(box)) {
      if (getComputedStyle(c).display !== 'contents') {
        if (shows(c)) return c;
      } else {
        const inner = laid(c);
        if (inner) return inner;
      }
    }
    return null;
  };
  const item = getComputedStyle(el).display === 'contents' ? laid(el) || el : el;
  let parent = item.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  return { item, ordered: !!parent && /(^|-)(flex|grid)$/.test(getComputedStyle(parent).display) };
}
/** The CSS order a layout item's own styles give it, whether or not its container lays items out by it: a flex or
 *  grid container it is moved into would. */
function ownOrder(item) {
  const order = Number.parseInt(getComputedStyle(item).order, 10);
  return Number.isSafeInteger(order) ? order : 0;
}
function rectOf(el) {
  // Through the prototype: a form's control named "getBoundingClientRect" would hide the form's own.
  let r = Element.prototype.getBoundingClientRect.call(el);
  if (getComputedStyle(el).display === 'contents') {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    // A child that lays out no box either (an image's <picture>) is measured by what is inside it.
    for (const c of Object.getOwnPropertyDescriptor(Element.prototype, 'children').get.call(el)) {
      const cr = rectOf(c);
      if (!cr) continue;
      x1 = Math.min(x1, cr.x); y1 = Math.min(y1, cr.y); x2 = Math.max(x2, cr.x + cr.width); y2 = Math.max(y2, cr.y + cr.height);
    }
    if (x1 === Infinity) return null;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  if (!r.width && !r.height) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** A page with no sections, as the editor draws its first step on it: { key, header, height }, or null. `height` is
 *  the room that step needs in the empty <main>, so it sits between the shared header and footer, where the page's
 *  sections will go. Held in a stylesheet of the bridge's own that applies only while editing and only while <main>
 *  holds no element: Preview, and a page with content, are left as visitors get them. */
let emptySpace = null;
let emptySpaceSheet = null;
function setEmptySpace(next) {
  const height = next && Number.isFinite(next.height) ? Math.min(4000, Math.max(0, Math.ceil(next.height))) : 0;
  emptySpace = next && typeof next.key === 'string' ? { key: next.key, path: shownPath(), header: Array.isArray(next.header) ? next.header.slice(0, 50) : [] } : null;
  if (!emptySpaceSheet) {
    emptySpaceSheet = document.createElement('style');
    document.head.appendChild(emptySpaceSheet);
  }
  const css = emptySpace ? `html[data-so-editing] main#main:not(:has(> *)) { min-height: ${height}px; }` : '';
  if (emptySpaceSheet.textContent !== css) emptySpaceSheet.textContent = css;
}
/** Where that room is now, in the frame: the <main>'s top and height, and how far down the shared header reaches
 *  (a header that stays at the top while the page scrolls covers the start of it). */
function emptyArea() {
  if (!emptySpace || mode !== 'edit') return null;
  const main = document.getElementById('main');
  // The first section is on the page before the editor hears that it shows.
  if (!main || main.querySelector(':scope > *')) return null;
  const r = Element.prototype.getBoundingClientRect.call(main);
  const headers = emptySpace.header.flatMap((desc) => findAll(desc).map(rectOf).filter(Boolean).slice(0, 1));
  return { key: emptySpace.key, top: r.top, height: r.height, headerBottom: Math.max(0, ...headers.map((h) => h.y + h.height)) };
}

let raf = 0;
function scheduleRects() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (revealDirty) reconcileReveal();
    else if (revealPlace) placeReveal();
    retryScroll();
    settleShown();
    keepInView();
    sendRects();
    // Checked again every frame while a change of width settles, or a scroll the editor asked for settles, whatever
    // moves the page meanwhile.
    if (keepHold || shownHold) scheduleRects();
  });
}
/** A divider the page renders: a plain rule, or one of the decorative bands drawn in its place. */
/**
 * The last report posted, with the page and revision it was measured on. One the same again is not posted: the editor
 * already draws it. A request from the editor (`track`) clears it, so what the editor asks for is always answered.
 */
let rectsPosted = '';
function isSeparator(el) {
  return el.tagName === 'HR' || el.classList.contains('so-band') || el.classList.contains('so-band-icon');
}
function sendRects() {
  const selEls = selected ? findAll(selected) : [];
  const selBoxes = selEls.map(rectOf);
  sampleSelection(selEls, selBoxes);
  const sel = selBoxes.filter(Boolean);
  // A slot's placeholder is outlined where it first shows: a copy hidden at this width (a layout's mobile copy on
  // desktop) has no box to outline.
  const hovEls = hovered && mode === 'edit' ? findAll(hovered) : [];
  const hov = (typeof hovered?.slot === 'string' ? hovEls : hovEls.slice(0, 1)).map(rectOf).filter(Boolean).slice(0, 1);
  // A divider between items is not part of the item it follows.
  const rev = revealRoots().filter((el) => !isSeparator(el)).map(rectOf).filter(Boolean);
  // The padding, border and margin of the first selected box the editor outlines, for its spacing handles, with
  // what it measured so a report from before a new selection is never taken for it.
  const first = selBoxes.findIndex(Boolean);
  // A code component's marked part has no spacing handles: its author's code lays it out. Nor has a placement's empty
  // slot: its placeholder is the editor's own.
  const box = mode === 'edit' && first >= 0 && !selected.part && selected.slot === undefined ? spacingOf(selEls[first]) : null;
  // Read in the same pass, after the boxes above have brought the page's layout up to date: no further reflow.
  const spacing = box && { ...box, layout: layoutReport(selEls[first]), ctx: selected.ctx, node: selected.node, items: selected.items || '' };
  // Each tracked slot's placeholder where it first shows, with what it was measured for.
  const slots = mode === 'edit' ? trackedSlots.flatMap((desc) => { const box = findAll(desc).map(rectOf).find(Boolean); return box ? [{ desc, box }] : []; }) : [];
  const report = { selected: sel, selectedDesc: selected, hovered: hov, hoveredDesc: hovered, revealed: rev, spacing, slots, empty: emptyArea(), viewport: { width: innerWidth, height: innerHeight, scrollY } };
  const seen = JSON.stringify([navigationId, revision, report]);
  if (seen === rectsPosted) return;
  rectsPosted = seen;
  send('rects', report);
}

// ---------------------------------------------------------------------------
// Spacing dragged on the canvas
// ---------------------------------------------------------------------------

/** Whether a transform scales, rotates or skews: one that only moves a box keeps its padding where it is drawn. */
function distorts(s) {
  if (s.scale && s.scale !== 'none' && s.scale.split(/\s+/).some((v) => Math.abs(Number.parseFloat(v) - 1) > 1e-3)) return true;
  if (s.rotate && s.rotate !== 'none' && Number.parseFloat(s.rotate.trim().split(/\s+/).pop()) !== 0) return true;
  if (!s.transform || s.transform === 'none') return false;
  const m = /^matrix\(([^)]+)\)$/.exec(s.transform);
  if (!m) return true;
  const [a, b, c, d] = m[1].split(',').map(Number);
  return Math.abs(a - 1) > 1e-3 || Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || Math.abs(d - 1) > 1e-3;
}

/**
 * An element's padding, border widths and margin in CSS pixels, by physical side. Null for a box with no padding
 * of its own to drag (laid out as its children, or an inline run of text), and for one whose sides are not where
 * the editor would draw them: set in vertical writing, or scaled, rotated or skewed by itself or what holds it.
 */
function spacingOf(el) {
  const s = getComputedStyle(el);
  if (s.display === 'contents' || s.display === 'inline' || s.display === 'none' || s.writingMode !== 'horizontal-tb') return null;
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (distorts(e === el ? s : getComputedStyle(e))) return null;
  const n = (v) => {
    const x = Number.parseFloat(v);
    return Number.isFinite(x) ? x : 0;
  };
  const sides = (k, suffix = '') => ({ top: n(s[`${k}Top${suffix}`]), right: n(s[`${k}Right${suffix}`]), bottom: n(s[`${k}Bottom${suffix}`]), left: n(s[`${k}Left${suffix}`]) });
  return { padding: sides('padding'), border: sides('border', 'Width'), margin: sides('margin'), rtl: s.direction === 'rtl' };
}

const LAYOUT_ITEMS = 50;
const pxOf = (v) => {
  const x = Number.parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};
const PX = /^\d+(\.\d+)?px$/;
const PCT = /^(\d+(\.\d+)?)%$/;
const isGrid = (display) => /(^|\s|-)grid$/.test(display);
/** The element that lays a box out, past any laid out as its children. */
function layoutParent(el) {
  let p = el.parentElement;
  while (p && getComputedStyle(p).display === 'contents') p = p.parentElement;
  return p;
}
/** A box's content width and height: inside its padding, border and scrollbar. */
const contentWidth = (el, s = getComputedStyle(el)) => Math.max(0, el.clientWidth - pxOf(s.paddingLeft) - pxOf(s.paddingRight));
const contentHeight = (el, s = getComputedStyle(el)) => Math.max(0, el.clientHeight - pxOf(s.paddingTop) - pxOf(s.paddingBottom));
/**
 * A computed gap in pixels: `normal` is none, a percentage is of the content box along it where that is set (a box as
 * tall as its content takes a percentage row gap as nothing while it works out its height); null for anything else.
 */
function usedGap(v, along) {
  if (v === 'normal') return 0;
  if (PX.test(v)) return pxOf(v);
  const m = PCT.exec(v);
  return m && along !== null ? (Number.parseFloat(m[1]) / 100) * along : null;
}
/**
 * Whether a box's height is set to a length rather than taken from its content, as a percentage row gap needs. A
 * percentage height counts as unset: it is one only where its container's height is set, which is not checked here.
 */
function setHeight(el) {
  try {
    const v = el.computedStyleMap && el.computedStyleMap().get('height');
    return !!v && PX.test(String(v));
  } catch {
    return false;
  }
}
/**
 * A grid's resolved track sizes, in order, without the empty tracks as many as fit leaves at the end (they and their
 * gaps take no room); null for anything but a plain list of pixel sizes (line names left out), one too long to read,
 * or one with an empty track between others, whose gaps may or may not have collapsed with it.
 */
function trackSizes(text, max) {
  const t = String(text);
  if (t.length > 4000) return null;
  const out = [];
  for (const part of t.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/)) {
    if (!part) continue;
    if (!PX.test(part)) return null;
    out.push(Number.parseFloat(part));
    if (out.length > max * 2) return null;
  }
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out.length <= max && !out.includes(0) ? out : null;
}
/**
 * A box's children as it lays them out, in the page's order, past any laid out as their own children, leaving out
 * those taken out of the flow (which take no gap): at most `max`, looking at no more than four times that many
 * elements. Null for a box that holds more.
 */
function flowChildren(el, max) {
  const out = [];
  let looked = 0;
  const walk = (p) => {
    for (const c of childrenOf(p)) {
      if (++looked > max * 4) return false;
      const cs = getComputedStyle(c);
      if (cs.display === 'contents') {
        if (!walk(c)) return false;
      } else if (cs.display !== 'none' && !/^(absolute|fixed)$/.test(cs.position)) {
        out.push(c);
        if (out.length > max) return false;
      }
    }
    return true;
  };
  return walk(el) ? out : null;
}
/** Whether a computed margin is `auto`, as authored, rather than the length the page worked out for it. */
function autoMargin(el, prop) {
  try {
    const v = el.computedStyleMap && el.computedStyleMap().get(prop);
    return !!v && String(v) === 'auto';
  } catch {
    return false;
  }
}

/**
 * What the gap, max width and column handles need of the selected box, in CSS pixels: how it lays out what it holds
 * (a stack's items, a grid's tracks, its gaps) and how wide it may be in its container. Only the selected box and a
 * bounded number of its own children are read, in the pass that has just measured it. Nothing inside a box whose
 * contents the page skips (content-visibility: hidden) is read, since reading it would lay it out.
 */
function layoutReport(el) {
  const s = getComputedStyle(el);
  const box = rectOf(el);
  if (!box) return null;
  const flex = /(^|\s|-)flex$/.test(s.display);
  const grid = isGrid(s.display);
  // The content box: inside the border (and a scrollbar on either side), and the padding.
  const inner = { x: box.x + el.clientLeft + pxOf(s.paddingLeft), y: box.y + el.clientTop + pxOf(s.paddingTop), width: contentWidth(el, s), height: contentHeight(el, s) };
  const out = { box, inner, kind: flex ? 'flex' : grid ? 'grid' : 'block', rowGap: usedGap(s.rowGap, setHeight(el) ? inner.height : null), columnGap: usedGap(s.columnGap, inner.width) };
  const open = s.contentVisibility !== 'hidden';
  if (flex) {
    out.column = s.flexDirection.startsWith('column');
    out.wrap = s.flexWrap !== 'nowrap';
    out.spread = /^space-/.test(s.justifyContent);
    const kids = open ? flowChildren(el, LAYOUT_ITEMS) : null;
    out.items = kids ? kids.map(rectOf).filter(Boolean) : [];
  } else if (grid) {
    out.cols = (open && trackSizes(s.gridTemplateColumns, 12)) || [];
    out.rows = (open && trackSizes(s.gridTemplateRows, LAYOUT_ITEMS)) || [];
    const packed = (v) => /^((un)?safe )?(normal|stretch|start|flex-start)$/.test(v) || (v === 'left' && s.direction !== 'rtl') || (v === 'right' && s.direction === 'rtl');
    out.packedCols = packed(s.justifyContent);
    out.packedRows = packed(s.alignContent);
  }
  const parent = layoutParent(el);
  const ps = parent && getComputedStyle(parent);
  // A grid item's container is its grid area, whose width the page does not report: no width for it.
  if (parent && !isGrid(ps.display)) {
    const basis = contentWidth(parent, ps);
    const pct = PCT.exec(s.maxWidth);
    const max = PX.test(s.maxWidth) ? pxOf(s.maxWidth) : pct ? (Number.parseFloat(pct[1]) / 100) * basis : null;
    out.width = { centered: autoMargin(el, 'margin-left') && autoMargin(el, 'margin-right'), max, content: s.boxSizing === 'content-box', basis };
  }
  return out;
}

/**
 * Each site style's size as padding on the dragged box, in CSS pixels, or null where it has none. Measured on a probe
 * outside the page's body (so its layout and observers never see it), in the box's font, so lengths in em, ch or lh
 * come out as they would on the box. A percentage is taken of the page's width; or, with `basis` 'box' or 'boxHeight'
 * (a gap), of the box's own content width or height, or with 'parent' (a max width), of the width its container
 * gives it. A box as tall as its content takes a percentage row gap as nothing, so that is what one measures there.
 * Probe and host are elements of the bridge's own, sized inline, so the page's rules for divs leave them be.
 */
function measureSpace(vars, desc, basis) {
  // The box the editor outlines: the first copy that shows, as the spacing report takes it.
  const el = desc && typeof desc.ctx === 'string' && typeof desc.node === 'string' ? findAll(desc).find((e) => rectOf(e)) : null;
  const fixed = 'display:block;margin:0;border:0;box-sizing:content-box;min-width:0;max-width:none;min-height:0;max-height:none;visibility:hidden;pointer-events:none;';
  const probe = document.createElement('so-measure');
  probe.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;${fixed}`;
  let host = probe;
  if (el) {
    const s = getComputedStyle(el);
    probe.style.font = s.font;
    probe.style.lineHeight = s.lineHeight;
    const parent = basis === 'parent' ? layoutParent(el) : null;
    const width = basis === 'box' ? contentWidth(el, s) : basis === 'boxHeight' ? (setHeight(el) ? contentHeight(el, s) : 0) : parent ? contentWidth(parent) : null;
    if (width !== null) {
      // A box as wide as the one a percentage is taken of, holding the probe.
      host = document.createElement('so-measure');
      host.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:0;padding:0;${fixed}`;
      probe.style.position = 'static';
      host.appendChild(probe);
    }
  }
  document.documentElement.appendChild(host);
  try {
    return vars.map((v) => {
      if (typeof v !== 'string' || !/^--so-[a-zA-Z0-9-]+$/.test(v)) return null;
      probe.style.paddingTop = `var(${v})`;
      const px = Number.parseFloat(getComputedStyle(probe).paddingTop);
      return Number.isFinite(px) ? px : null;
    });
  } finally {
    host.remove();
  }
}

/**
 * The drags being shown, by drag: each one rule giving the dragged element(s) the dragged value until the page's
 * own stylesheet shows the saved change. { el (a <style>), desc, props, text, still, until, deadline, raf }
 */
const spacingShown = new Map();
/** What a drag can show, by property: margins may pull in (below zero), padding, gaps and widths may not, and
 *  column sizes are only the fr shares a column drag writes, as the stylesheet writes them. */
const LENGTH_VALUE = /^(var\(--so-[a-zA-Z0-9-]+\)|\d+(\.\d+)?px|0)$/;
const SIGNED_VALUE = /^(var\(--so-[a-zA-Z0-9-]+\)|-?\d+(\.\d+)?px|0)$/;
const TRACKS_VALUE = /^minmax\(0, \d+(\.\d+)?fr\)( minmax\(0, \d+(\.\d+)?fr\)){1,11}$/;
const SPACING_PROPS = new Map([
  ...['padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end', 'row-gap', 'column-gap', 'max-width'].map((p) => [p, LENGTH_VALUE]),
  ['margin-block-start', SIGNED_VALUE],
  ['margin-block-end', SIGNED_VALUE],
  ['grid-template-columns', TRACKS_VALUE]
]);
const SPACING_MEDIA = /^\((min|max)-width: \d+(\.\d+)?px\)( and \((min|max)-width: \d+(\.\d+)?px\))?$/;
/**
 * Whether two computed values show the same: the same words and units, each pixel length within half a pixel and every
 * other number exactly. Every number counts, so a column list whose first column matches but whose second does not
 * differs, `none` never matches a length, and 5% is not 5.4%.
 */
function sameShown(a, b) {
  const NUM = /(-?\d*\.?\d+(?:e[+-]?\d+)?)(px)?/gi;
  const parts = (v) => [...v.matchAll(NUM)].map((m) => ({ n: Number(m[1]), px: !!m[2] }));
  const words = (v) => v.replace(NUM, (_, n, px) => (px ? '#px' : '#')).replace(/\s+/g, ' ').trim();
  const x = parts(a);
  const y = parts(b);
  return words(a) === words(b) && x.length === y.length && x.every((p, i) => Math.abs(p.n - y[i].n) < (p.px ? 0.5 : 1e-6));
}

function selectorOf(desc) {
  const items = desc.items ? `[data-so-items="${cssEscape(desc.items)}"]` : '';
  return `[data-so-ctx="${cssEscape(desc.ctx)}"][data-so-node="${cssEscape(desc.node)}"]${items}`;
}

/** Put the page back for one drag, or for every drag. */
function clearSpacing(drag) {
  for (const [id, p] of spacingShown) {
    if (drag !== undefined && id !== drag) continue;
    if (p.raf) cancelAnimationFrame(p.raf);
    p.el.remove();
    spacingShown.delete(id);
  }
  scheduleRects();
}

function showSpacing(drag, desc, decls, media) {
  const list = Array.isArray(decls) ? decls.filter((d) => Array.isArray(d) && SPACING_PROPS.has(d[0]) && typeof d[1] === 'string' && SPACING_PROPS.get(d[0]).test(d[1])) : [];
  if (!desc || typeof desc.ctx !== 'string' || typeof desc.node !== 'string' || !list.length || (media !== null && media !== undefined && !(typeof media === 'string' && SPACING_MEDIA.test(media)))) return clearSpacing(drag);
  let p = spacingShown.get(drag);
  if (p?.raf) cancelAnimationFrame(p.raf);
  if (!p) {
    const el = document.createElement('style');
    el.setAttribute('data-so-spacing', '');
    document.head.appendChild(el);
    p = { el };
    spacingShown.set(drag, p);
  }
  const target = { ctx: desc.ctx, node: desc.node, items: typeof desc.items === 'string' ? desc.items : '' };
  const wrap = (rule) => (media ? `@media ${media}{${rule}}` : rule);
  const sel = selectorOf(target);
  // Transitions stay off while it shows, so the page's own value can be read the moment the rule steps aside.
  Object.assign(p, {
    desc: target,
    props: list.map((d) => d[0]),
    text: wrap(`${sel}{${list.map(([k, v]) => `${k}:${v} !important`).join(';')};transition:none !important}`),
    still: wrap(`${sel}{transition:none !important}`),
    until: null,
    deadline: 0,
    raf: 0
  });
  p.el.textContent = p.text;
  scheduleRects();
}

/**
 * Hand a drag over to the saved change: once the page has the revision the save made, the rule is taken away
 * whenever the page shows the same spacing without it. Checked within one task, so a page still waiting for its
 * new stylesheet never paints without the rule. A later revision (an Undo, another edit) or a page that never
 * matches ends it, showing the page as it is.
 */
function settleSpacing(drag) {
  const p = spacingShown.get(drag);
  if (!p || p.until === null) return;
  p.raf = 0;
  if (revision > p.until || Date.now() > p.deadline) return clearSpacing(drag);
  if (revision === p.until) {
    const els = findAll(p.desc);
    const read = () => els.flatMap((el) => {
      const s = getComputedStyle(el);
      return p.props.map((k) => s.getPropertyValue(k));
    });
    const shown = read();
    p.el.textContent = p.still;
    const own = read();
    if (own.every((v, i) => sameShown(v, shown[i]))) return clearSpacing(drag);
    p.el.textContent = p.text;
  }
  p.raf = requestAnimationFrame(() => settleSpacing(drag));
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
  const landmark = hb && hb.height > 0 && hb.y <= y && y <= hb.y + hb.height && hb.x <= x && x <= hb.x + hb.width ? { el: hit, desc: descOf(hit), depth: (y - hb.y) / hb.height } : null;
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
  // scroll position for the new width (keeping its own place) is not the author scrolling.
  if (keepHold && now <= keepHold.until) Object.assign(keepHold, { until: now + KEEP_MS, last: null });
  else if (keepSample && keepSample.width === before && sameDesc(keepSample.desc, selected)) keepHold = { ...keepSample, until: now + KEEP_MS, last: null };
  else keepHold = null;
}
/** The selection's element the hold is about: the same one while it is on the page, else the one rendered in its place. */
function heldElement(k) {
  if (k.el.isConnected && findAll(selected).includes(k.el)) return k.el;
  return findAll(selected).filter((e) => itemsOf(e) === k.items)[k.nth] || null;
}
/** Where the held point is in the frame now (`y`) and through what (`via`: its landmark or the element), or null. */
function heldPoint(k, el) {
  if (k.landmark) {
    const l = k.landmark;
    const mark = l.el.isConnected && el.contains(l.el) ? l.el : findAll(l.desc).find((m) => el.contains(m));
    const mb = mark && rectOf(mark);
    if (mb) return { y: mb.y + l.depth * mb.height, via: 'landmark' };
  }
  const b = rectOf(el);
  return b ? { y: b.y + k.depth * b.height, via: 'element' } : null;
}
/** Puts the held point back where it showed, before the outlines are measured. */
function keepInView() {
  const k = keepHold;
  if (!k) return;
  // The list item open in the inspector is brought into view by its own reveal, and an element the editor just asked
  // to show by that scroll's own hold (what showed before it was asked for is not the point to keep).
  if (performance.now() > k.until || mode !== 'edit' || editing || reveal || shownHold || !sameDesc(k.desc, selected)) {
    keepHold = null;
    return;
  }
  const el = heldElement(k);
  const p = el && heldPoint(k, el);
  if (!p) return;
  const y = p.y;
  // Since the last pass the page was scrolled and nothing else moved (a scrollbar dragged, the site's own code): that
  // has the last word. A scroll that came with a change of layout (the browser keeping its place), or that only took
  // the page back up to its new end (content below it gone for a moment), is corrected.
  const scrolled = k.last && k.last.via === p.via ? scrollY - k.last.scrollY : 0;
  const root = document.scrollingElement || document.documentElement;
  const end = root.scrollHeight - root.clientHeight;
  if (Math.abs(scrolled) > 1 && Math.abs(y - (k.last.y - scrolled)) <= 1 && !(scrolled < 0 && scrollY >= end - 1)) {
    keepHold = null;
    return;
  }
  const delta = y - k.at * innerHeight;
  let now = p;
  if (Math.abs(delta) > 1) {
    const from = scrollY;
    // 'instant', not 'auto': a site's own smooth scrolling would otherwise animate it.
    window.scrollBy({ top: delta, behavior: 'instant' });
    const moved = scrollY - from;
    const after = heldPoint(k, el);
    // A point that does not move with the page (something sticky or fixed) cannot be put back: it is left alone. One
    // the page could not scroll far enough for (its end) is tried again as the page settles.
    if (!after || (Math.abs(moved) > 1 && Math.abs(after.y - (y - moved)) > Math.abs(moved) / 2)) {
      keepHold = null;
      return;
    }
    now = after;
  }
  k.last = { scrollY, y: now.y, via: now.via };
}
/** Another page or a scroll the editor asked for: what showed before is no longer there to keep. */
function stopKeeping() {
  keepHold = null;
  keepSample = null;
}
// The author's own scrolling (or a click, a key) just after a change of width is never undone. A wheel or a touch also
// means what showed before may be gone by the next change of width: it is measured afresh. A click or a key alone (a
// shortcut to the command menu, then a width from it) leaves what shows as it is.
for (const type of ['wheel', 'touchstart']) {
  window.addEventListener(type, () => {
    stopKeeping();
    // A reveal still waiting for its item to show (its list hidden) no longer scrolls the page to it: the author has
    // gone elsewhere. The item is still brought into its sideways list once that shows.
    if (revealScroll) revealScroll = false;
    if (selected) scheduleRects();
  }, { capture: true, passive: true });
}
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => (keepHold = null), { capture: true, passive: true });

// ---------------------------------------------------------------------------
// A scroll the editor asked for, to an element the page shows a moment later
// ---------------------------------------------------------------------------

/**
 * A scroll the editor asked for (`scrollTo`) to an element the page does not show yet: one just inserted, which the
 * site's hot update mounts a moment after the editor has selected it (issue #509), or one just moved, whose new place
 * shows once the page has the change's revision (`after`, issue #902). { desc, show, until, after } until it shows,
 * `until` (performance.now()) passes, or the author, a newer request, another page or Preview takes over.
 */
let pendingScroll = null;
/** How long a scroll waits for its element: long enough for the site to build and mount a new section. */
const SCROLL_WAIT_MS = 3000;
/** How long a scroll waits for the revision it is about, before it gives up. */
const REVISION_WAIT_MS = 10000;
/**
 * An element the editor asked to show, kept in view while the page settles (issue #902): { desc, show, until, still,
 * lastY, at: where on the page it last showed, or null }. A page that has just opened is still laying out (an image, a font, the site's own code moving the page), and
 * a smooth scroll aimed at where the element was can end with only a sliver of it in view, or be cut short. Until
 * `until`, once the page has stopped scrolling (`still` frames without a move), an element that is not in view is put
 * there. The author scrolling, clicking or typing, a newer request, another selection, another page, Preview or an edit
 * in the page ends it.
 */
let shownHold = null;
/** How long a shown element is kept in view while the page settles. */
const SHOWN_SETTLE_MS = 2500;
/** Frames the page must go without scrolling before the element is put back: a smooth scroll moves it every frame. */
const STILL_FRAMES = 6;
/** Whether a box shows comfortably in the frame, clear of its edges. */
function comfortable(r) {
  return r.top >= 60 && r.bottom <= innerHeight - 20;
}
/** The element `desc` names that shows on the page, through any wrapper laid out as its content, or null. */
function shownTarget(desc) {
  let target = findAll(desc).find((e) => rectOf(e));
  if (!target) return null;
  while (getComputedStyle(target).display === 'contents') {
    const next = [...target.children].find((c) => rectOf(c));
    if (!next) break;
    target = next;
  }
  return target;
}
/** The scroll position that shows box `r` as scrollToDesc does (its middle, or the top of a tall one shown from Layers), as far as the page can scroll. */
function shownTop(r, show) {
  const root = document.scrollingElement || document.documentElement;
  const end = Math.max(0, root.scrollHeight - root.clientHeight);
  const top = show && r.height > innerHeight - 80 ? scrollY + r.top : scrollY + r.top + r.height / 2 - innerHeight / 2;
  return Math.max(0, Math.min(end, Math.round(top)));
}
/** Keeps the shown element in view while the page settles: run with each measurement, every frame while it holds. */
function settleShown() {
  const h = shownHold;
  if (!h) return;
  if (performance.now() > h.until || mode !== 'edit' || editing || reveal || pendingScroll) {
    shownHold = null;
    return;
  }
  const moved = Math.abs(scrollY - h.lastY) > 0.5;
  h.lastY = scrollY;
  h.still = moved ? 0 : h.still + 1;
  const target = shownTarget(h.desc);
  const r = target && target.getBoundingClientRect();
  // Once it showed, the page scrolled with nothing on it moving (a scrollbar dragged, a search in the page, the site's
  // own code): that has the last word. A change of layout that moves it away is put right.
  if (moved && r && h.at !== null && Math.abs(r.top + scrollY - h.at) <= 1) {
    shownHold = null;
    return;
  }
  if (h.still < STILL_FRAMES || !r) return;
  const top = shownTop(r, h.show);
  // In view, or already where the page can show it best (the end of the page, or one taller than the frame).
  if (comfortable(r) || Math.abs(top - scrollY) <= 2) {
    h.at = r.top + scrollY;
    return;
  }
  h.at = null;
  const from = scrollY;
  // 'instant', not 'auto': a site's own smooth scrolling would otherwise animate it.
  window.scrollTo({ top, behavior: 'instant' });
  const by = scrollY - from;
  const after = target.getBoundingClientRect();
  // One that does not move with the page (something fixed or sticky) cannot be brought into view by scrolling it.
  if (Math.abs(by) > 1 && Math.abs(after.top - (r.top - by)) > Math.abs(by) / 2) {
    shownHold = null;
    return;
  }
  h.lastY = scrollY;
  h.still = 0;
}
/** The author or the editor has taken over the page: nothing scrolls it back to an element asked for earlier. */
function stopShowing() {
  pendingScroll = null;
  shownHold = null;
}
/**
 * Scrolls the element `desc` names into view, unless it already shows comfortably. False while there is nothing to
 * scroll to yet: it is not on the page, or it is a component's wrapper whose content has not arrived. One already on
 * the page when asked, without a box of its own (hidden at this width, in a closed disclosure, an empty anchor), is
 * asked to scroll as it is, and never waited for: the page is not moved to it later, when something else shows it.
 * Once `waiting` for one that was not there, a hidden copy mounting first (one a component shows at another width)
 * is not it: the wait goes on for one that shows.
 */
function scrollToDesc(desc, show, waiting = false, moved = false) {
  const all = findAll(desc);
  let el = all.find((e) => rectOf(e));
  // Kept in view while the page settles only when it shows now and is scrolled to here: one hidden when asked is not
  // moved to later, and one already in view (a pick on the page) leaves the page to the author.
  const shows = !!el;
  if (!el) {
    if (waiting || !all.length || all.some((e) => getComputedStyle(e).display === 'contents')) return false;
    el = all[0];
  }
  stopKeeping();
  // A wrapper is laid out as its content: the first of its children that shows, through any wrapper inside it.
  let target = el;
  while (getComputedStyle(target).display === 'contents') {
    const next = [...target.children].find((c) => rectOf(c));
    if (!next) break;
    target = next;
  }
  const r = target.getBoundingClientRect();
  // Shown from Layers (`show`), one taller than the frame shows from its top. A pick on the page itself keeps its
  // place on the page.
  const block = show && r.height > innerHeight - 80 ? 'start' : 'center';
  const fits = comfortable(r);
  // Asked for in so many words (`show`: the command menu, Layers) or just moved, one in view already is still kept
  // there while the page settles: from where it shows now, so the author's own scrolling ends that at once.
  if (shows && (!fits || show || moved)) {
    shownHold = { desc, show, until: performance.now() + SHOWN_SETTLE_MS, still: 0, lastY: scrollY, at: fits ? r.top + scrollY : null };
    scheduleRects();
  }
  if (fits) return true;
  target.scrollIntoView({ block, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  return true;
}
/** Tried again each time the page changes or is measured, until the element shows or the wait is over. */
function retryScroll() {
  const p = pendingScroll;
  if (!p) return;
  if (performance.now() > p.until || mode !== 'edit') pendingScroll = null;
  else if (p.after > revision) return;
  // An item opened in the inspector, or text being edited, meanwhile: the page shows that instead.
  else if (p.after && (reveal || editing)) pendingScroll = null;
  else if (p.after) {
    // The page has the change: its element is where the change put it (already on the page, for a move).
    pendingScroll = null;
    if (!scrollToDesc(p.desc, p.show, false, true)) pendingScroll = { desc: p.desc, show: p.show, until: performance.now() + SCROLL_WAIT_MS, after: 0 };
  } else if (scrollToDesc(p.desc, p.show, true)) pendingScroll = null;
}
/**
 * The keys that scroll the page, or move focus to what the page then scrolls to (Tab). A modifier alone (Shift as a
 * shortcut begins) moves nothing, and with Ctrl, Alt or Command held they are the editor's shortcuts.
 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab']);
// The author's own scrolling, or a click in the page: the page stays where the author has it.
for (const type of ['wheel', 'touchstart', 'pointerdown']) window.addEventListener(type, stopShowing, { capture: true, passive: true });
window.addEventListener('keydown', (e) => {
  if (SCROLL_KEYS.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) stopShowing();
}, { capture: true, passive: true });

// ---------------------------------------------------------------------------
// Dialogs and drawers shown in place while editing (#378)
// ---------------------------------------------------------------------------
// In Edit a component's dialog or drawer renders in its place, hidden, beside a button of the editor's own
// ([data-so-overlay-peek]) that shows it so what is inside can be selected and edited. Which ones are shown is kept
// here, by where they are on the page (see overlayKey), so a hot update that renders one afresh keeps it shown, and
// every other placement of the same design stays as it is. In Component Studio's preview, one whose UI state the
// studio previews open is marked [data-so-overlay-open] by the component itself and shows without that button.

/** Dialogs and drawers the author shows in place, by overlayKey. */
const overlaysShown = new Set();
/**
 * Where a dialog or drawer is on the page: its occurrence, and the items its placement, and each placement around it,
 * is rendered for. Copies of one placement in each row of a list share the occurrence of every element below their
 * root, which alone carries the item; copies inside copies share the inner item too.
 */
function overlayKey(host) {
  const items = [];
  for (let at = host.parentElement && host.parentElement.closest('[data-so-items]'); at; at = at.parentElement && at.parentElement.closest('[data-so-items]')) items.push(at.getAttribute('data-so-items'));
  return occurrence(host) + '\n' + items.join('\n');
}
/** Brings each dialog or drawer, and its button, in line with what the author chose. Safe to repeat. */
function applyOverlaysShown() {
  for (const button of document.querySelectorAll('[data-so-overlay-peek]')) {
    const host = document.getElementById(button.getAttribute('aria-controls') || '');
    if (!host || !host.hasAttribute('data-so-overlay')) continue;
    const on = mode === 'edit' && overlaysShown.has(overlayKey(host));
    if (host.hasAttribute('data-so-peek') !== on) host.toggleAttribute('data-so-peek', on);
    if (button.getAttribute('aria-expanded') !== String(on)) button.setAttribute('aria-expanded', String(on));
  }
}
/** The author's press on a dialog's button: shows it in place, or hides it again. */
function toggleOverlayShown(button) {
  const host = document.getElementById(button.getAttribute('aria-controls') || '');
  if (!host || !host.hasAttribute('data-so-overlay')) return;
  const key = overlayKey(host);
  if (overlaysShown.has(key)) overlaysShown.delete(key);
  else overlaysShown.add(key);
  applyOverlaysShown();
  scheduleRects();
}

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
/**
 * The list that scrolls sideways (a carousel's) the item was last brought into, and where the item sits in it: { list,
 * at }. A list rendered afresh (an update arrived) starts at its beginning again, and an item moved inside it
 * (reordered) is somewhere else, so either way the item is brought in again; the author scrolling the same list
 * changes neither, so where they put it stays.
 */
let revealSide = null;
/** The page changed size: where the item is is checked again before the next frame is drawn (see placeReveal). */
let revealPlace = false;
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
/**
 * Category filters asked to show every item again for the item revealed, since it was found hidden by one: counted, so
 * a filter that keeps hiding it (nothing in the page takes the request) is asked a few times, not every frame.
 */
let revealUnfiltered = 0;
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
    revealSide = null;
    revealDeclined = new Set();
    revealUnfiltered = 0;
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
  unfilter(roots);
  placeReveal(roots);
}
/**
 * An item a list's category filter hides (a visitor's choice made in Preview) is shown again: the filter of its own
 * list, the row of pills just above the element holding the item, is asked to show every item, as its All button
 * would. The page re-renders after this, so the item is looked for again before the next frame is drawn.
 */
function unfilter(roots) {
  const bars = new Set();
  for (const el of roots) {
    if (!el.classList.contains('so-filter-off')) continue;
    const bar = el.parentElement && el.parentElement.previousElementSibling;
    if (bar && bar.hasAttribute('data-so-filter')) bars.add(bar);
  }
  // Nothing hidden: the next time a filter hides the item it is asked afresh.
  if (!bars.size) {
    revealUnfiltered = 0;
    return;
  }
  if (revealUnfiltered >= 3) return;
  revealUnfiltered++;
  for (const bar of bars) bar.dispatchEvent(new CustomEvent('sofilterreset'));
  revealDirty = true;
  scheduleRects();
}
/**
 * Where the item is: scrolled to while that is still to be done, and brought back into its sideways list when that
 * list was rendered afresh, the item moved inside it, or the list only now scrolls (shown at last). Only geometry,
 * so it can run whenever the page changes size without touching its disclosures or typed text.
 */
function placeReveal(roots = revealRoots()) {
  revealPlace = false;
  if (revealScroll) {
    const el = roots.find((r) => !isSeparator(r) && rectOf(r));
    if (el) {
      // Scrolling never moves focus: the author keeps typing in the inspector.
      // 'instant', not 'auto': a site's own smooth scrolling would otherwise animate it.
      const instant = revealScroll === 'resize' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      revealScroll = false;
      // An item in a list that scrolls sideways (a carousel's slide) is brought in there, at once, so another item
      // opened next is measured where it really is; the page then scrolls to the list, which leaves the list as it is.
      const side = sideScroller(el);
      if (side) bringInside(side, el);
      revealSide = side ? { list: side, at: offsetAlong(side, el) } : null;
      const target = side || el;
      const r = target.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 20) target.scrollIntoView({ block: r.height > innerHeight - 80 ? 'start' : 'center', behavior: instant ? 'instant' : 'smooth' });
    }
  } else if (reveal) {
    const el = roots.find((r) => !isSeparator(r) && rectOf(r));
    const side = el ? sideScroller(el) : null;
    if (side) {
      const at = offsetAlong(side, el);
      if (!revealSide || revealSide.list !== side || Math.abs(revealSide.at - at) > 1) {
        bringInside(side, el);
        revealSide = { list: side, at: offsetAlong(side, el) };
      }
    }
  }
}
/**
 * The nearest box around an element that scrolls sideways only, such as a carousel's list, or null. A box that also
 * scrolls up and down is left to the item's own reveal, which scrolls it both ways.
 */
function sideScroller(el) {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if ((s.overflowX !== 'auto' && s.overflowX !== 'scroll') || p.scrollWidth <= p.clientWidth + 1) continue;
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1 ? null : p;
  }
  return null;
}
/**
 * How much larger a box is drawn than it is laid out (a scale on it or around it), as scrolling measures it. Within
 * a percent of 1 it is 1: a laid-out width is rounded to a whole pixel, which is not a scale.
 */
function drawnScale(box) {
  const k = box.offsetWidth ? box.getBoundingClientRect().width / box.offsetWidth : 1;
  return k > 0 && Math.abs(k - 1) >= 0.01 ? k : 1;
}
/** Where `el` sits along `list`, however far the list is scrolled, in the list's own units. */
function offsetAlong(list, el) {
  return (el.getBoundingClientRect().left - list.getBoundingClientRect().left) / drawnScale(list) + list.scrollLeft;
}
/**
 * Scrolls `list` sideways, at once and nothing else, by as little as shows all of `el`: its nearer edge to the
 * list's edge, which in a carousel is where it stops. One wider than the list shows from its start.
 */
function bringInside(list, el) {
  const dx = clipped(list, el, false);
  if (!dx) return;
  list.scrollBy({ left: dx, behavior: 'instant' });
  // A list that stops at each item can stop short of that edge, leaving part of it out: then its start, a stop.
  const again = clipped(list, el, true);
  if (again) list.scrollBy({ left: again, behavior: 'instant' });
}
/**
 * How far `list` must scroll, in its own units, to show all of `el`: to its nearer edge, or its start when `toStart`
 * (or when it is wider than the list). 0 when all of it shows.
 */
function clipped(list, el, toStart) {
  const k = drawnScale(list);
  const l = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const left = l.left + list.clientLeft * k;
  const right = left + list.clientWidth * k;
  if (r.left >= left - 1 && r.right <= right + 1) return 0;
  const start = getComputedStyle(list).direction === 'rtl' ? r.right - right : r.left - left;
  if (toStart || r.width > right - left + 1) return start / k;
  return (r.left < left - 1 ? r.left - left : r.right - right) / k;
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
    // A part a code component's author marked counts as an element of its own, so moving between two parts is news.
    const at = pointedAt(e.target);
    const el = at ? at.el : null;
    const next = at ? at.desc : null;
    // Another element with the same descriptor is news too: the same part of a component placed in another list item
    // differs only further out, in the items its placement carries.
    if (el === pointerEl && sameDesc(next, pointerAt)) return;
    pointerAt = next;
    pointerEl = el;
    // `at`: when the pointer moved, on the clock the editor's timing marks use, so the time to its outline can be told.
    send('hover', { chain: chainFrom(el, true), at: performance.timeOrigin + e.timeStamp });
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
    if (ownUi(e.target)) return;
    if (editing && editing.el.contains(e.target)) {
      // Clicks place the caret in the text being edited; they never follow a link, toggle a disclosure or reach the
      // site's own click handlers (a button that changes what its component shows).
      if (e.target.closest && e.target.closest('a[href], summary')) e.preventDefault();
      e.stopPropagation();
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
    // A dialog or drawer's button of the editor's own shows it in place, or hides it, and selects nothing.
    const overlayButton = e.target.closest && e.target.closest('[data-so-overlay-peek]');
    if (overlayButton) {
      toggleOverlayShown(overlayButton);
      return;
    }
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
    send('select', { chain: chainFrom(e.target, true), alt: e.altKey, meta: e.metaKey || e.ctrlKey });
  },
  true
);
document.addEventListener(
  'dblclick',
  (e) => {
    if (mode !== 'edit' || editing) return;
    e.preventDefault();
    e.stopPropagation();
    pendingHit = { id: String(++hitCount), target: new WeakRef(e.target), at: textAt(e.clientX, e.clientY) };
    send('dblclick', { chain: chainFrom(e.target, true), hit: pendingHit.id });
  },
  true
);
document.addEventListener(
  'contextmenu',
  (e) => {
    if (mode !== 'edit' || ownUi(e.target)) return;
    // A right-click in the text being edited is for that text: the app's writing menu (spelling, cut, copy,
    // paste) opens for the word under the pointer, and the selection stays where it is.
    if (editing && editing.el.contains(e.target)) return;
    e.preventDefault();
    send('contextmenu', { chain: chainFrom(e.target, true), x: e.clientX, y: e.clientY });
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
// The site's Light/Dark switch asks the canvas to preview the other palette (generator/color-scheme.ts), so the
// canvas's own Light and Dark and the switch never disagree.
window.addEventListener('siteorigin:color-scheme', (e) => {
  if (e.detail === 'light' || e.detail === 'dark') send('colorScheme', { scheme: e.detail });
});
// The layout held every submission until this bridge was running; from here the listener above decides.
window.__siteoriginBridge = true;
if (typeof window.__siteoriginHold === 'function') {
  document.removeEventListener('submit', window.__siteoriginHold, true);
  window.__siteoriginHold = undefined;
}
for (const t of ['pointerdown', 'mousedown', 'touchstart']) {
  document.addEventListener(t, (e) => {
    // The link field takes focus from a press. A press on the toolbar keeps it in the text, where its command acts.
    if (linkEditor && e.target === linkEditor.host) return;
    if (mode === 'edit' && !(editing && editing.el.contains(e.target))) e.preventDefault();
  }, { capture: true, passive: false });
}
document.addEventListener('keydown', (e) => {
  if (editing) return;
  if (mode !== 'edit') return;
  // A component's tabs choose their panel from the keyboard in Preview only. In Edit a click on one selects it, and the
  // arrows, Home and End would otherwise change what the canvas shows behind the author's back.
  const plain = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
  if (plain && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && e.target instanceof Element && e.target.closest('[role="tab"]')) {
    e.stopPropagation();
    return;
  }
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

/**
 * The last double-click, until the editor answers it with an edit (or not): which one it was, the element under the
 * pointer, and the text position there. The edit it starts begins where the author clicked.
 */
let pendingHit = null;
let hitCount = 0;

/**
 * The text under a point: the text node, the caret position nearest the point, and the character the pointer is on
 * (the caret can fall on either side of it). Null off text.
 */
function textAt(x, y) {
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const node = r.startContainer;
  const box = (i) => {
    if (i < 0 || i >= node.length) return null;
    const c = document.createRange();
    c.setStart(node, i);
    c.setEnd(node, i + 1);
    return c.getBoundingClientRect();
  };
  const holds = (b) => !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  // Off the characters (blank space beside a line): the nearest caret, and no word.
  const char = holds(box(r.startOffset)) ? r.startOffset : holds(box(r.startOffset - 1)) ? r.startOffset - 1 : -1;
  return { node: new WeakRef(node), text: node.nodeValue, caret: r.startOffset, char };
}

const isInline = (el) => getComputedStyle(el).display.startsWith('inline');

/**
 * The word at a text position inside `el`, as a double-click selects it: the word may run across marks
 * (`co<strong>oper</strong>ate`), but not across a line break or another block. A caret where the position is not
 * on a word (a space, punctuation).
 */
function wordRange(el, node, at) {
  const range = document.createRange();
  range.setStart(node, Math.min(at.caret, node.length));
  let block = node.parentElement;
  while (block && block !== el && isInline(block)) block = block.parentElement;
  if (!block || typeof Intl.Segmenter !== 'function') return range;
  // The text nodes of the line the position is on, in order.
  let line = [];
  let found = false;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      line.push(n);
      if (n === node) found = true;
    } else if (n.tagName === 'BR' || !isInline(n)) {
      if (found) break;
      line = [];
    }
  }
  const starts = [];
  let text = '';
  let pos = -1;
  for (const t of line) {
    if (t === node && at.char >= 0 && at.char < node.length) pos = text.length + at.char;
    starts.push(text.length);
    text += t.nodeValue;
  }
  if (pos < 0) return range;
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text).containing(pos);
  if (!seg || !seg.isWordLike) return range;
  // Where a position falls on the edge between two text nodes, the word starts in the later one and ends in the
  // earlier one.
  const point = (p, end) => {
    for (let i = 0; i < line.length; i++) {
      const a = starts[i];
      const b = a + line[i].nodeValue.length;
      if (end ? p > a && p <= b : p < b) return [line[i], p - a];
    }
    return null;
  };
  const from = point(seg.index, false);
  const to = point(seg.index + seg.segment.length, true);
  if (!from || !to) return range;
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  return range;
}

/**
 * Begins editing the text of the element `desc` names, after the editor checked it can be edited there. `hitId` is
 * the double-click that asked for it: the edit is of the copy the author clicked, and starts with the word clicked
 * selected (or a caret, off a word), as a double-click does in any text. Whole text is for Select All. An answer to
 * an earlier double-click than the last one starts nothing: the author has double-clicked something else since.
 */
function beginTextEdit(desc, editId, hitId) {
  // An answer to an older double-click leaves the newer one waiting for its own answer.
  const hit = hitId && pendingHit && pendingHit.id === hitId ? pendingHit : null;
  if (hit) pendingHit = null;
  if (mode !== 'edit' || (hitId && !hit)) return send('textCancel', { desc, editId });
  let clicked = null;
  if (hit) {
    const target = hit.target.deref();
    clicked = target && target.isConnected ? (target instanceof Element ? target : target.parentElement) : null;
    while (clicked && !(clicked.hasAttribute('data-so-node') && sameDesc(descOf(clicked), desc))) clicked = clicked.parentElement;
    // The text double-clicked has been replaced since (the page updated): what the author meant to edit is gone.
    if (!clicked) return send('textCancel', { desc, editId });
  }
  const el = clicked || findAll(desc)[0];
  // The editor is waiting for this edit to end: tell it there is nothing to edit.
  if (!el) return send('textCancel', { desc, editId });
  if (editing) commitEdit();
  // Typed text shown there from the inspector gives way to the page's own text, which the edit then works on.
  restoreDraft(el);
  // The page's own text can have replaced typed text shown there: the word is found again in the same words, and
  // otherwise the edit starts with a caret at the end.
  let node = hit && hit.at && hit.at.node.deref();
  // The words under the pointer changed before the editor answered: the word clicked is no longer there.
  if (node && el.contains(node) && node.nodeValue !== hit.at.text) return send('textCancel', { desc, editId });
  if (node && !el.contains(node)) node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue === hit.at.text);
  const rich = el.classList.contains('so-rich');
  // before: the plain text shown as the edit began, so the editor can tell what the author typed over.
  editing = { el, desc, editId, original: el.innerHTML, rich, before: rich ? null : el.innerText.replace(/\s+/g, ' ').trim() };
  // Rich text keeps its bold, italic (⌘B, ⌘I) and links (⌘K); everything else is plain text.
  el.setAttribute('contenteditable', rich ? 'true' : 'plaintext-only');
  el.setAttribute('spellcheck', 'true');
  el.style.outline = 'none';
  el.style.cursor = 'text';
  el.focus();
  let range;
  if (node && el.contains(node)) range = wordRange(el, node, hit.at);
  else {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
  el.addEventListener('keydown', onEditKey);
  el.addEventListener('blur', onEditBlur);
  el.addEventListener('input', scheduleRects);
  el.addEventListener('paste', onEditPaste);
  el.addEventListener('drop', onEditDrop);
  if (rich) openToolbar();
  send('textEditStarted', { desc });
}
function onEditKey(e) {
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
  // The formatting toolbar is the next stop after the text; Tab from there leaves the edit.
  if (e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey && toolbar) {
    e.preventDefault();
    focusToolbar();
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
function onEditBlur(e) {
  // Moving into the link editor or the toolbar is still the same edit.
  if (editing && !linkEditor && !(toolbar && e.relatedTarget === toolbar.host)) commitEdit();
}

const LINK_EDITOR_CSS = `
  form { display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: #1b1d21; box-shadow: 0 6px 24px rgb(0 0 0 / 0.32); font: 13px/1.2 system-ui, sans-serif; }
  input { width: 220px; height: 28px; box-sizing: border-box; padding: 0 8px; border: 1px solid #4a4e57; border-radius: 5px; background: #111316; color: #f4f5f7; font: inherit; outline: none; }
  input:focus { border-color: #7aa7ff; }
  input[aria-invalid='true'] { border-color: #ff7a7a; }
  button { height: 28px; padding: 0 9px; border: 0; border-radius: 5px; background: #2d3037; color: #f4f5f7; font: inherit; cursor: pointer; }
  button:hover, button:focus-visible { background: #40444d; outline: none; }
  .error { box-sizing: border-box; max-width: 340px; margin: 4px 0 0; padding: 6px 8px; border-radius: 6px; background: #1b1d21; color: #ffb4b4; box-shadow: 0 6px 24px rgb(0 0 0 / 0.32); font: 12px/1.35 system-ui, sans-serif; }
  .error[hidden] { display: none; }
`;

/**
 * The anchors that make up one link: words with different marks are saved as one link each, shown as neighbouring
 * anchors to the same place with only spaces between them. Changing or removing the link takes all of them.
 */
function linkRun(anchor) {
  // Which marks an anchor's words carry: one link over words with the same marks is a single anchor, so two
  // neighbouring anchors with the same marks are two links.
  const marks = (a) => {
    const kinds = new Set();
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.nodeValue.trim()) continue;
      const inside = (sel) => {
        const m = t.parentElement.closest(sel);
        return !!m && a.contains(m);
      };
      kinds.add(`${inside('strong, b') ? 'S' : ''}${inside('em, i') ? 'E' : ''}`);
    }
    return [...kinds].sort().join();
  };
  const same = (n, beside) => n && n.nodeType === 1 && n.tagName === 'A' && n.getAttribute('href') === anchor.getAttribute('href') && n.getAttribute('target') === anchor.getAttribute('target') && authoredRels(n).join() === authoredRels(anchor).join() && marks(n) !== marks(beside);
  const next = (n, dir) => {
    let m = dir < 0 ? n.previousSibling : n.nextSibling;
    // The page's own markers (comments) and spaces sit between the parts of one link.
    while (m && (m.nodeType === 8 || (m.nodeType === 3 && !m.nodeValue.trim()))) m = dir < 0 ? m.previousSibling : m.nextSibling;
    return same(m, n) ? m : null;
  };
  let first = anchor;
  let last = anchor;
  for (let m = next(first, -1); m; m = next(first, -1)) first = m;
  for (let m = next(last, 1); m; m = next(last, 1)) last = m;
  return [first, last];
}
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
  if (anchor) {
    const [first, last] = linkRun(anchor);
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
  } else if (range.collapsed) return;
  const box = range.getBoundingClientRect();
  const host = document.createElement('div');
  const top = box.bottom + 50 > innerHeight ? Math.max(8, box.top - 44) : box.bottom + 6;
  host.style.cssText = `position: fixed; z-index: 2147483647; left: ${Math.max(8, Math.min(box.left, innerWidth - 340))}px; top: ${top}px;`;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${LINK_EDITOR_CSS}</style><form><input aria-label="Link destination" aria-describedby="so-link-error" placeholder="/about/, https://…, email or phone" spellcheck="false"><button type="submit">Apply</button>${anchor ? '<button type="button">Remove</button>' : ''}</form><p class="error" id="so-link-error" role="alert" hidden></p>`;
  const input = root.querySelector('input');
  const error = root.querySelector('.error');
  input.value = anchor ? anchor.getAttribute('href') || '' : '';
  // Pressing a button keeps focus in the field, so the edit does not end on the way to the click.
  root.addEventListener('mousedown', (e) => e.target !== input && e.preventDefault());
  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    applyLink(input.value);
  });
  const remove = root.querySelector('button[type="button"]');
  if (remove) remove.addEventListener('click', () => applyLink(''));
  // Typing again clears what was said about the last destination, and any answer still on its way about it.
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    error.textContent = '';
    if (linkEditor && linkEditor.input === input) linkEditor.check = null;
  });
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
    // Back to the text or on to the toolbar: the edit goes on without the link still being typed.
    if (editing && (e.relatedTarget === editing.el || (toolbar && e.relatedTarget === toolbar.host))) {
      closeLinkEditor(false);
      return updateToolbar();
    }
    // Leaving the field ends the edit (a destination still being checked is left out, and the editor told).
    commitEdit();
  });
  linkEditor = { host, input, error, range, check: null };
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
  updateToolbar();
}
/**
 * Only destinations the editor can store are written. The editor knows the site's pages, so it checks each one
 * (and again when the edit is committed); the field stays open, with what was typed and the link the words had,
 * until it says the destination is good, or says what is wrong with it.
 */
function applyLink(raw) {
  const text = raw.trim();
  if (!text) {
    closeLinkEditor(true);
    document.execCommand('unlink');
    return;
  }
  const href = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(text) ? `mailto:${text}` : /^\+?\(?\d[\d ().-]{5,}$/.test(text) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? `tel:${text}` : /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(text) ? `https://${text}` : text;
  if (href.length > 2000 || !/^(https?:\/\/\S|mailto:\S|tel:\S|#\S|\/)/i.test(href)) return linkProblem('Use a page address such as /about/, a web address, an email address or a phone number.');
  if (!linkRangeLive()) return linkProblem('The words to link have changed. Close this and select them again.');
  linkEditor.check = { id: ++linkChecks, href };
  send('checkLink', { editId: editing.editId, check: linkEditor.check.id, href });
}
/** The editor's answer about the destination last submitted: link the words, or say what is wrong. */
function linkChecked(payload) {
  const ed = linkEditor;
  if (!ed || !editing || !ed.check || ed.check.id !== payload.check) return;
  const { href } = ed.check;
  ed.check = null;
  if (typeof payload.problem === 'string') return linkProblem(payload.problem.slice(0, 300));
  if (!linkRangeLive()) return linkProblem('The words to link have changed. Close this and select them again.');
  // The browser replaces the link it re-points, attributes and all. When the words were one link (every link they
  // touch goes to the same place and says the same), the new one still opens a new tab if that one did, to a page
  // or a web address, and keeps what the author said about a web address while it still goes to one.
  const { links, plain } = rangeLinks(ed.range);
  const was = links[0];
  const one = !!was && !plain && links.every((a) => a.getAttribute('href') === was.getAttribute('href') && a.getAttribute('target') === was.getAttribute('target') && authoredRels(a).join() === authoredRels(was).join());
  const newTab = one && was.getAttribute('target') === '_blank' && /^(https?:|\/)/i.test(href);
  const rels = one && /^https?:/i.test(href) && /^https?:/i.test(was.getAttribute('href')) ? authoredRels(was) : [];
  closeLinkEditor(true);
  document.execCommand('createLink', false, href);
  const sel = getSelection();
  const now = (newTab || rels.length) && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (now)
    for (const a of editing.el.querySelectorAll('a[href]')) {
      // A new link the browser joined to a neighbour going to the same place holds that neighbour's words too: it is
      // left as it is rather than changing them.
      if (a.getAttribute('href') !== href || !now.intersectsNode(a) || !coversAll(now, a)) continue;
      if (newTab) a.setAttribute('target', '_blank');
      if (rels.length) a.setAttribute('rel', rels.join(' '));
    }
}
/** The part of a text node's words a range covers: a range that only reaches an element's edge covers none of it. */
function coveredText(range, t) {
  if (!range.intersectsNode(t)) return '';
  return t.nodeValue.slice(t === range.startContainer ? range.startOffset : 0, t === range.endContainer ? range.endOffset : t.nodeValue.length);
}
/** The links whose words a range covers, and whether it covers words outside any link (which join no link's options). */
function rangeLinks(range) {
  const links = [];
  let plain = false;
  const walker = document.createTreeWalker(editing.el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!coveredText(range, t).trim()) continue;
    const a = t.parentElement.closest('a[href]');
    if (!a || !editing.el.contains(a)) plain = true;
    else if (!links.includes(a)) links.push(a);
  }
  return { links, plain };
}
/** Whether a range covers every word inside an element (spacing at a word's ends, which a page may collapse, aside). */
function coversAll(range, el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.nodeValue.trim() && coveredText(range, t).trim() !== t.nodeValue.trim()) return false;
  return true;
}
/** Whether the words the field links are still there to link (the text can change underneath the field). */
function linkRangeLive() {
  const { range } = linkEditor;
  return !range.collapsed && editing.el.contains(range.commonAncestorContainer);
}
function linkProblem(message) {
  if (!linkEditor) return;
  linkEditor.input.setAttribute('aria-invalid', 'true');
  linkEditor.error.textContent = message;
  linkEditor.error.hidden = false;
}
// ---------------------------------------------------------------------------
// Formatting toolbar: visible link and list controls while rich text is edited
// ---------------------------------------------------------------------------

const TOOLBAR_CSS = `
  [role='toolbar'] { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 8px; background: #1b1d21; box-shadow: 0 6px 24px rgb(0 0 0 / 0.32); }
  button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #f4f5f7; cursor: pointer; }
  button:hover:not([aria-disabled='true']), button:focus-visible { background: #40444d; outline: none; }
  button:focus-visible { box-shadow: 0 0 0 2px #7aa7ff; }
  button[aria-pressed='true'] { background: #2f4a7a; }
  button[aria-disabled='true'] { opacity: 0.4; cursor: default; }
  svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  i { width: 1px; height: 18px; margin: 0 3px; background: #4a4e57; }
`;
const TOOLBAR_BUTTONS = [
  { cmd: 'link', label: 'Link', icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' },
  { cmd: 'ul', label: 'Bulleted list', icon: '<path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13"/>', gap: true },
  { cmd: 'ol', label: 'Numbered list', icon: '<path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>' },
  { cmd: 'add', label: 'Add item', icon: '<path d="M5 12h14M12 5v14"/>', gap: true },
  { cmd: 'remove', label: 'Remove item', icon: '<path d="M5 12h14"/>' },
  { cmd: 'up', label: 'Move item up', icon: '<path d="m5 12 7-7 7 7M12 19V5"/>' },
  { cmd: 'down', label: 'Move item down', icon: '<path d="M12 5v14m7-7-7 7-7-7"/>' }
];
const NEW_ITEM = 'New item';

/** Shown while rich text is edited: link and list commands, reached with a press or with Tab from the text. */
function openToolbar() {
  closeToolbar();
  const host = document.createElement('div');
  host.style.cssText = 'position: fixed; z-index: 2147483646; left: 0; top: 0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${TOOLBAR_CSS}</style><div role="toolbar" aria-label="Text formatting">${TOOLBAR_BUTTONS.map(
    (b, i) => `${b.gap ? '<i aria-hidden="true"></i>' : ''}<button type="button" data-cmd="${b.cmd}" aria-label="${b.label}" title="${b.label}" tabindex="${i ? -1 : 0}"><svg viewBox="0 0 24 24" aria-hidden="true">${b.icon}</svg></button>`
  ).join('')}</div>`;
  const buttons = [...root.querySelectorAll('button')];
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b && toolbar && toolbar.root === root) runToolbarCommand(b.dataset.cmd);
  });
  root.addEventListener('keydown', onToolbarKey);
  root.addEventListener('focusout', (e) => {
    if (!editing || !toolbar || toolbar.root !== root) return;
    const to = e.relatedTarget;
    // Within the toolbar, back to the text, or into the link field: still the same edit.
    if (to && (root.contains(to) || to === editing.el || (linkEditor && to === linkEditor.host))) return;
    commitEdit();
  });
  toolbar = { host, root, buttons, range: null, backward: false };
  document.documentElement.appendChild(host);
  addEventListener('scroll', placeToolbar, { capture: true, passive: true });
  addEventListener('resize', placeToolbar);
  editing.el.addEventListener('input', onToolbarInput);
  rememberRange();
  updateToolbar();
}
function closeToolbar() {
  if (!toolbar) return;
  const { host } = toolbar;
  toolbar = null;
  removeEventListener('scroll', placeToolbar, { capture: true });
  removeEventListener('resize', placeToolbar);
  if (editing) editing.el.removeEventListener('input', onToolbarInput);
  host.remove();
}
function onToolbarInput() {
  rememberRange();
  updateToolbar();
}
/**
 * Below the text, or at the foot of the window when that is off screen; always inside it. Never above the text:
 * the editor's selection chip sits there (or inside its top edge), over the page, where it would take the presses.
 */
function placeToolbar() {
  if (!toolbar || !editing) return;
  const r = editing.el.getBoundingClientRect();
  const bar = toolbar.host.getBoundingClientRect();
  const h = bar.height || 34;
  // No room below: the end of the window away from the text's top, where the chip is.
  const top = r.bottom + 6 + h <= innerHeight - 4 ? Math.max(4, r.bottom + 6) : r.top > innerHeight / 2 ? 4 : Math.max(4, innerHeight - h - 4);
  const left = Math.max(4, Math.min(r.left, innerWidth - (bar.width || 260) - 4));
  toolbar.host.style.top = `${Math.round(top)}px`;
  toolbar.host.style.left = `${Math.round(left)}px`;
}
/** The author's selection in the text, kept while the toolbar or the link field has focus. */
function rememberRange() {
  if (!toolbar || !editing) return;
  const s = getSelection();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  if (!editing.el.contains(r.startContainer) || !editing.el.contains(r.endContainer)) return;
  toolbar.range = r.cloneRange();
  toolbar.backward = !r.collapsed && s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset;
}
document.addEventListener('selectionchange', () => {
  if (!toolbar || !editing || linkEditor) return;
  rememberRange();
  updateToolbar();
});
const elementOf = (n) => (n && n.nodeType === 1 ? n : n ? n.parentElement : null);
/** The list item the selection starts in, inside the text being edited. */
function currentItem() {
  const r = toolbar && toolbar.range;
  const at = r && elementOf(r.startContainer);
  const li = at && at.closest('li');
  return li && editing && editing.el.contains(li) ? li : null;
}
const siblingItem = (li, dir) => {
  const n = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
  return n && n.tagName === 'LI' ? n : null;
};
function toolbarState() {
  const r = toolbar.range;
  const at = r && elementOf(r.commonAncestorContainer);
  const a = at && at.closest('a');
  const inLink = !!a && editing.el.contains(a);
  const li = currentItem();
  const list = li && li.parentElement;
  // Text whose own element is the list (an older code component's) is always that list.
  const rootList = editing.el.tagName === 'UL' || editing.el.tagName === 'OL';
  return {
    link: { disabled: !inLink && (!r || r.collapsed), label: inLink ? 'Edit link' : 'Link' },
    // A check list shows check marks, not bullets: Bulleted list turns it into one.
    ul: { disabled: rootList, pressed: !!list && list.tagName === 'UL' && !list.classList.contains('so-rich--check') },
    ol: { disabled: rootList, pressed: !!list && list.tagName === 'OL' },
    add: { disabled: !li },
    remove: { disabled: !li },
    up: { disabled: !li || !siblingItem(li, -1) },
    down: { disabled: !li || !siblingItem(li, 1) }
  };
}
function updateToolbar() {
  if (!toolbar || !editing) return;
  const state = toolbarState();
  for (const b of toolbar.buttons) {
    const st = state[b.dataset.cmd];
    if (st.label) {
      b.setAttribute('aria-label', st.label);
      b.title = st.label;
    }
    if (st.pressed !== undefined) b.setAttribute('aria-pressed', String(st.pressed));
    if (st.disabled) b.setAttribute('aria-disabled', 'true');
    else b.removeAttribute('aria-disabled');
  }
  placeToolbar();
}
function focusToolbar() {
  if (!toolbar) return;
  rememberRange();
  updateToolbar();
  const b = toolbar.buttons.find((x) => x.tabIndex === 0) || toolbar.buttons[0];
  b.focus();
}
/** Focus back in the text, with the selection it had. */
function restoreText() {
  if (!editing) return;
  const range = toolbar && toolbar.range;
  if (editing.el !== document.activeElement) editing.el.focus();
  if (!range || !editing.el.contains(range.startContainer)) return;
  const s = getSelection();
  if (toolbar.backward) s.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
  else {
    s.removeAllRanges();
    s.addRange(range);
  }
}
/** One Tab stop: the arrow keys, Home and End move between buttons; Escape and Shift+Tab go back to the text. */
function onToolbarKey(e) {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229 || !toolbar) return;
  const list = toolbar.buttons;
  const from = list.indexOf(toolbar.root.activeElement);
  const to = e.key === 'ArrowRight' ? from + 1 : e.key === 'ArrowLeft' ? from - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
  if (to !== null) {
    e.preventDefault();
    const next = list[(to + list.length) % list.length];
    for (const b of list) b.tabIndex = b === next ? 0 : -1;
    next.focus();
  } else if (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault();
    restoreText();
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    commitEdit();
  }
}
/** Each command is one step of the text's own Undo while editing; the whole edit is one step once it is done. */
function runToolbarCommand(cmd) {
  if (!editing || !toolbar) return;
  const b = toolbar.buttons.find((x) => x.dataset.cmd === cmd);
  if (!b || b.getAttribute('aria-disabled') === 'true') return;
  for (const x of toolbar.buttons) x.tabIndex = x === b ? 0 : -1;
  if (linkEditor) {
    const open = cmd === 'link';
    closeLinkEditor(true);
    if (open) return;
  }
  restoreText();
  if (cmd === 'link') return openLinkEditor();
  if (cmd === 'ul' || cmd === 'ol') toggleList(cmd);
  else {
    const li = currentItem();
    if (!li) return;
    if (cmd === 'add') addItem(li);
    else if (cmd === 'remove') removeItem(li);
    else moveItem(li, cmd === 'up' ? -1 : 1);
  }
  markLists();
  rememberRange();
  updateToolbar();
  scheduleRects();
}
/**
 * Lists the browser's commands make have no class, and the site draws list markers from the class (its reset
 * takes the browser's own away): give each the class its kind has, so it shows as a list while it is edited.
 */
function markLists() {
  if (!editing) return;
  for (const list of editing.el.querySelectorAll('ul, ol')) {
    if (/\bso-rich--/.test(list.className)) continue;
    list.classList.add(list.tagName === 'OL' ? 'so-rich--number' : 'so-rich--bullet');
  }
}
/**
 * The browser's own list commands, which are one Undo step each. With the selection inside one list of the other
 * kind, the whole list changes kind, as in a word processor, and the selection stays on the same words. A check
 * list becomes a bulleted one the same way.
 */
function toggleList(cmd) {
  const tag = cmd === 'ol' ? 'OL' : 'UL';
  const command = cmd === 'ol' ? 'insertOrderedList' : 'insertUnorderedList';
  const r = toolbar.range;
  const li = currentItem();
  const list = li && li.parentElement;
  const endLi = r && elementOf(r.endContainer) && elementOf(r.endContainer).closest('li');
  const check = !!list && list.tagName === 'UL' && list.classList.contains('so-rich--check');
  if (!li || (list.tagName === tag && !(check && cmd === 'ul')) || !endLi || endLi.parentElement !== list) return document.execCommand(command);
  const items = [...list.children].filter((c) => c.tagName === 'LI');
  const point = (node, offset) => {
    const at = elementOf(node).closest('li');
    return { i: items.indexOf(at), n: offsetIn(at, node, offset) };
  };
  const from = point(r.startContainer, r.startOffset);
  const to = point(r.endContainer, r.endOffset);
  const backward = toolbar.backward;
  const s = getSelection();
  let first;
  if (check && cmd === 'ul') {
    // No command turns a check list into a bulleted one, and replacing only the list joins it to the block after
    // it: the whole text is put back with that one list changed, still one Undo step.
    const at = [...editing.el.querySelectorAll('ul, ol')].indexOf(list);
    const copy = editing.el.cloneNode(true);
    const twin = copy.querySelectorAll('ul, ol')[at];
    twin.classList.remove('so-rich--check');
    twin.classList.add('so-rich--bullet');
    const all = document.createRange();
    all.selectNodeContents(editing.el);
    s.removeAllRanges();
    s.addRange(all);
    document.execCommand('insertHTML', false, copy.innerHTML);
    const now = editing.el.querySelectorAll('ul, ol')[at];
    first = now && [...now.children].find((c) => c.tagName === 'LI');
  } else {
    const whole = document.createRange();
    whole.setStart(items[0], 0);
    whole.setEnd(items[items.length - 1], items[items.length - 1].childNodes.length);
    s.removeAllRanges();
    s.addRange(whole);
    document.execCommand(command);
    // The changed items are selected; a list of the new kind next to them may have joined them, so they are
    // found from where the selection starts, not from the start of their list.
    first = s.rangeCount ? elementOf(s.getRangeAt(0).startContainer).closest('li') : null;
  }
  if (!first || !editing.el.contains(first)) return;
  const next = [...first.parentElement.children].filter((c) => c.tagName === 'LI');
  const base = next.indexOf(first);
  const a = next[base + from.i];
  const b = next[base + to.i];
  if (!a || !b) return;
  caretAt(a, from.n);
  const start = s.getRangeAt(0);
  caretAt(b, to.n);
  const end = s.getRangeAt(0);
  // The selection keeps its direction, so Shift and an arrow key go on moving the same end.
  if (backward) s.setBaseAndExtent(end.startContainer, end.startOffset, start.startContainer, start.startOffset);
  else s.setBaseAndExtent(start.startContainer, start.startOffset, end.startContainer, end.startOffset);
}
/** Characters from the start of `el` to a point inside it. */
function offsetIn(el, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  // A line break counts as a character, so a caret just after one is told from a caret just before it.
  const part = r.cloneContents();
  return part.textContent.length + part.querySelectorAll('br').length;
}
/** A caret `n` characters into `el` (a line break counting as one, as offsetIn counts them), or at its end. */
function caretAt(el, n) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (x) => (x.nodeType === 3 || x.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t.nodeType === 1) {
      if (n === 0) {
        r.setStartBefore(t);
        r.collapse(true);
        break;
      }
      n--;
      continue;
    }
    if (n <= t.nodeValue.length) {
      r.setStart(t, n);
      r.collapse(true);
      break;
    }
    n -= t.nodeValue.length;
  }
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
function selectRange(start, end) {
  const r = document.createRange();
  r.setStartBefore(start);
  r.setEndAfter(end);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
const itemIndex = (li) => [...li.parentElement.children].indexOf(li);
/** Items are replaced as items, inside their list, so the list itself (and its kind) stays as it is. */
function replaceItems(first, last, html) {
  selectRange(first, last);
  document.execCommand('insertHTML', false, html);
}
function addItem(li) {
  const list = li.parentElement;
  const at = itemIndex(li) + 1;
  replaceItems(li, li, `${li.outerHTML}<li>${NEW_ITEM}</li>`);
  const added = list.children[at];
  if (!added) return;
  // The new item's words are selected, so typing replaces them.
  const r = document.createRange();
  r.selectNodeContents(added);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
function removeItem(li) {
  const list = li.parentElement;
  const prev = siblingItem(li, -1);
  const next = siblingItem(li, 1);
  if (!prev && !next) {
    // The only item: its words go and the caret stays in it, ready for new ones. An item left empty is dropped
    // when the edit is saved.
    const r = document.createRange();
    r.selectNodeContents(li);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    if (!r.collapsed) document.execCommand('delete');
    // A selection set again closes the browser's typing step, so typing after this is an Undo step of its own.
    const caret = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
    if (caret) {
      s.removeAllRanges();
      s.addRange(caret);
    }
    return;
  }
  const keep = prev ? itemIndex(prev) : itemIndex(li);
  selectRange(li, li);
  document.execCommand('delete');
  const target = list.children[keep];
  if (target) caretAt(target, prev ? Infinity : 0);
}
function moveItem(li, dir) {
  const other = siblingItem(li, dir);
  if (!other) return;
  const list = li.parentElement;
  const r = toolbar.range;
  const caret = r && li.contains(r.startContainer) ? offsetIn(li, r.startContainer, r.startOffset) : 0;
  const to = itemIndex(other);
  if (dir < 0) replaceItems(other, li, li.outerHTML + other.outerHTML);
  else replaceItems(li, other, other.outerHTML + li.outerHTML);
  const moved = list.children[to];
  if (moved) caretAt(moved, caret);
}

/**
 * Paste. Into rich text, formatting copied from elsewhere comes in as far as the text can hold it: paragraphs,
 * headings, quotes, lists, bold, italic, links and line breaks, rebuilt from scratch so nothing else gets in
 * (styles, classes, images, scripts). Paste and Match Style hands the page the plain text alone, and pastes plain
 * words. Plain text takes the words alone, on one line. Either way it is one step of the text's own undo.
 */
function onEditPaste(e) {
  e.preventDefault();
  if (!editing) return;
  const data = e.clipboardData;
  const html = editing.rich && data ? pastedRich(data.getData('text/html')) : '';
  if (html) {
    document.execCommand('insertHTML', false, html);
    return;
  }
  const text = (data && data.getData('text/plain')) || '';
  // Nothing to paste (an image alone): the selection stays as it is.
  if (!text) return;
  document.execCommand('insertText', false, editing.rich ? text : text.replace(/\s+/g, ' '));
}

/** Pasted elements dropped with everything inside them. */
const PASTE_DROP = new Set(['HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'APPLET', 'SVG', 'MATH', 'CANVAS', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'MAP', 'AREA', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OPTION', 'DIALOG']);
/** Pasted blocks, as the rich text holds them. Anything else is read for its text, marks and links. */
const PASTE_BLOCKS = { P: 'p', DIV: 'p', SECTION: 'p', ARTICLE: 'p', HEADER: 'p', FOOTER: 'p', MAIN: 'p', ASIDE: 'p', NAV: 'p', ADDRESS: 'p', PRE: 'p', FIGURE: 'p', FIGCAPTION: 'p', DL: 'p', DT: 'p', DD: 'p', TR: 'p', CAPTION: 'p', H1: 'h3', H2: 'h3', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', BLOCKQUOTE: 'blockquote', UL: 'ul', OL: 'ol', LI: 'li' };
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * A copied link's address as the rich text can store it, or '' when it cannot: its words are then pasted unlinked.
 * A link to one of this site's pages copied from the preview is a link to that page. The editor checks the address
 * again, and finds the page for a route, when the edit is committed.
 */
function pastedHref(raw) {
  let href = raw.trim();
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.origin === location.origin) href = url.pathname + url.hash;
    } catch {
      return '';
    }
  }
  const storable =
    /^https?:\/\/[^\s<>"]+$/i.test(href) ||
    /^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/i.test(href) ||
    /^tel:[+0-9 ().-]{3,30}$/i.test(href) ||
    /^#[A-Za-z][\w-]*$/.test(href) ||
    /^\/(?!\/)[^\s<>"]*$/.test(href);
  return storable && href.length <= 2000 ? href : '';
}

/** The relationships an author can declare on a link (LINK_RELS in the editor), in their order. */
const LINK_RELS = ['nofollow', 'sponsored', 'ugc'];
/** The authored relationships an anchor's rel holds: the security tokens a new tab adds are the site's, not the author's. */
function authoredRels(a) {
  const has = new Set(String(a.getAttribute('rel') || '').toLowerCase().split(/[ \t\n\f\r]+/));
  return LINK_RELS.filter((t) => has.has(t));
}

/**
 * Copied HTML as markup the rich text can hold, or '' when it holds no words. It is read in one pass, in reading
 * order, as lines: each block (a paragraph, heading, quote or list item) is a line of its own, a block inside a list item, quote or heading is another line of that kind, and the items
 * of a list inside a list join the outer one, as the rich text holds them. Every element written is a new one:
 * only these blocks, bold, italic, line breaks, and a link's address, new tab and relationships.
 */
function pastedRich(html) {
  if (!html || html.length > 2000000) return '';
  // Parsed inert (nothing runs or loads), from inside a body: what comes before the copy's own body (comments, Word's
  // conditional blocks) lands there too, never in the document itself, which Chromium is slow to add many nodes to.
  const src = new DOMParser().parseFromString(`<body>${html}`, 'text/html').body;
  /** { kind: '' (words outside any block) | 'p' | 'h3' | 'h4' | 'blockquote' | 'li', list, runs: [{ text } | { br }] with marks } */
  const lines = [];
  let line = null;
  const add = (ctx, run) => {
    if (!line) {
      line = { kind: ctx.kind, list: ctx.list, runs: [] };
      lines.push(line);
    }
    line.runs.push(run);
  };
  const walk = (n, ctx, m) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const parts = m.pre ? n.nodeValue.split(/\r?\n/) : [n.nodeValue.replace(/[ \t\r\n\f]+/g, ' ')];
      parts.forEach((text, i) => {
        if (i) add(ctx, { br: true, m });
        if (text) add(ctx, { text, m });
      });
      return;
    }
    // SVG and MathML (their titles and labels included) are not text.
    if (n.nodeType !== Node.ELEMENT_NODE || n.namespaceURI !== HTML_NS || PASTE_DROP.has(n.tagName)) return;
    if (n.tagName === 'BR') return add(ctx, { br: true, m });
    const inner = { ...m };
    const style = n.style || {};
    const weight = style.fontWeight;
    if (n.tagName === 'B' || n.tagName === 'STRONG' || n.tagName === 'TH') inner.strong = true;
    // Google Docs wraps a whole copy in <b style="font-weight:normal">, and marks bold words with a style instead.
    if (weight) inner.strong = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
    if (n.tagName === 'I' || n.tagName === 'EM') inner.em = true;
    if (style.fontStyle) inner.em = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
    if (n.tagName === 'A') {
      const href = pastedHref(n.getAttribute('href') || '');
      if (href) {
        inner.href = href;
        inner.newTab = n.getAttribute('target') === '_blank';
        inner.rel = authoredRels(n).join(' ');
      } else {
        delete inner.href;
        delete inner.rel;
      }
    }
    if (n.tagName === 'PRE') inner.pre = true;
    const kind = PASTE_BLOCKS[n.tagName];
    // A table cell's words stay apart from the next cell's.
    if ((n.tagName === 'TD' || n.tagName === 'TH') && line && line.runs.length) add(ctx, { text: ' ', m });
    let within = ctx;
    if (kind === 'ul' || kind === 'ol') within = { kind: 'li', list: ctx.list || kind };
    // A list item copied without its list is a paragraph.
    else if (kind === 'li') within = ctx.list ? { kind: 'li', list: ctx.list } : { kind: 'p', list: '' };
    else if (kind) within = ctx.kind === 'li' || ctx.kind === 'blockquote' || ctx.kind === 'h3' || ctx.kind === 'h4' ? ctx : { kind, list: '' };
    // A block starts a line of its own, and what follows it starts another.
    if (kind) line = null;
    for (const c of n.childNodes) walk(c, within, inner);
    if (kind) line = null;
  };
  for (const c of src.childNodes) walk(c, { kind: '', list: '' }, {});

  /** A line without the spacing a page collapses at its ends (a non-breaking space stays); null when it holds no words. */
  const trimmed = (l) => {
    const spacing = (r) => r.text !== undefined && !/[^ \t\r\n\f]/.test(r.text);
    let a = 0;
    let b = l.runs.length;
    while (a < b && spacing(l.runs[a])) a++;
    while (b > a && spacing(l.runs[b - 1])) b--;
    const runs = l.runs.slice(a, b);
    return runs.some((r) => r.text !== undefined && /\S/.test(r.text)) ? { ...l, runs } : null;
  };
  const kept = lines.map(trimmed).filter(Boolean);
  if (!kept.length) return '';
  /** Text or a break inside its marks and link, joining the run before it where that has the same ones. */
  const put = (parent, node, m) => {
    let host = parent;
    const wraps = [m.href !== undefined && 'A', m.strong && 'STRONG', m.em && 'EM'].filter(Boolean);
    for (const tag of wraps) {
      const last = host.lastChild;
      const same = last && last.nodeType === Node.ELEMENT_NODE && last.tagName === tag && (tag !== 'A' || (last.getAttribute('href') === m.href && last.hasAttribute('target') === !!m.newTab && (last.getAttribute('rel') || '') === (m.rel || '')));
      if (same) host = last;
      else {
        const w = document.createElement(tag);
        if (tag === 'A') {
          w.setAttribute('href', m.href);
          if (m.newTab) w.setAttribute('target', '_blank');
          if (m.rel) w.setAttribute('rel', m.rel);
        }
        host.appendChild(w);
        host = w;
      }
    }
    host.appendChild(node);
  };
  const fill = (el, runs) => {
    for (const r of runs) put(el, r.br ? document.createElement('br') : document.createTextNode(r.text), r.m);
  };
  const out = document.createElement('div');
  // Words alone, outside any block, go into the paragraph at the caret; a <br> that ended them showed nothing.
  if (kept.length === 1 && !kept[0].kind) {
    const runs = kept[0].runs;
    fill(out, runs[runs.length - 1].br ? runs.slice(0, -1) : runs);
    return out.innerHTML;
  }
  let list = null;
  for (const l of kept) {
    if (l.kind === 'li') {
      if (!list || list.tagName.toLowerCase() !== l.list) {
        list = document.createElement(l.list);
        out.appendChild(list);
      }
      const item = document.createElement('li');
      list.appendChild(item);
      fill(item, l.runs);
    } else {
      list = null;
      const block = document.createElement(l.kind || 'p');
      out.appendChild(block);
      fill(block, l.runs);
    }
  }
  return out.innerHTML;
}
function onEditDrop(e) {
  e.preventDefault();
}
function endEdit() {
  closeLinkEditor(false);
  closeToolbar();
  const { el } = editing;
  // Listeners go first: the element stops taking typing below, which blurs it, and that blur must not commit the
  // edit a second time.
  el.removeEventListener('keydown', onEditKey);
  el.removeEventListener('blur', onEditBlur);
  el.removeEventListener('input', scheduleRects);
  el.removeEventListener('paste', onEditPaste);
  el.removeEventListener('drop', onEditDrop);
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  el.style.outline = '';
  el.style.cursor = '';
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
  // A destination still being checked in the link field is not applied: the editor is told, as saving does.
  if (linkEditor && linkEditor.check) send('linkDropped', { desc, editId });
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
    // Only what goes in the copy counts: a page has a comment for every piece of text Svelte renders.
    if (n.nodeType !== 1 && n.nodeType !== 3) return null;
    if (budget-- <= 0 || depth > 16) throw new Error('too large');
    if (n.nodeType === 3) return n.nodeValue;
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
      const rel = authoredRels(n);
      if (rel.length) out.rel = rel;
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
/**
 * Resolves once the page is as wide as the editor made its frame, `width` CSS pixels, or at `deadline`. The frame's new
 * width reaches the page a moment after it is set (half a second on a busy Windows machine): measured before then, the
 * page would be measured at the width it had. The frame is drawn in whole device pixels, so at a fractional scale
 * (125%: 437 CSS pixels are 546.25) the page is the width either side of the one asked for.
 */
function atWidth(width, deadline) {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return Promise.resolve();
  const scale = window.devicePixelRatio || 1;
  const near = new Set([Math.floor(width * scale), Math.ceil(width * scale)].map((d) => Math.round(d / scale)));
  return new Promise((resolve) => {
    const check = () => {
      if (!near.has(window.innerWidth) && Date.now() < deadline) return;
      clearInterval(timer);
      window.removeEventListener('resize', check);
      resolve();
    };
    const timer = setInterval(check, 50);
    window.addEventListener('resize', check);
    check();
  });
}

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
async function imageReport(deadline, within = null) {
  // sources: the address each image was given (not the variant chosen), so the editor can tell a load that
  // shows an image the page no longer has. They cover the whole page even when only some elements are measured
  // (`within`), whose images alone are counted and checked.
  const summary = { total: 0, loaded: 0, failed: 0, unverified: 0, failedFiles: [], sources: [] };
  const issues = [];
  const checks = [];
  for (const img of document.querySelectorAll('img')) {
    const url = img.currentSrc || img.getAttribute('src') || '';
    if (!url) continue;
    if (summary.sources.length < 200) summary.sources.push(imagePath(img.getAttribute('src') || url));
    if (within && !within(img)) continue;
    summary.total++;
    if (img.complete && img.naturalWidth > 0) {
      summary.loaded++;
      continue;
    }
    // Which elements asked for it is in, as the page was when it was asked for.
    const tag = scopeTag(img, within);
    checks.push(
      probe(url, deadline).then((ok) => {
        const path = imagePath(url);
        if (ok === true) summary.loaded++;
        else if (ok === false) {
          summary.failed++;
          if (summary.failedFiles.length < 10) summary.failedFiles.push(path.slice(path.lastIndexOf('/') + 1) || path);
          const d = findingDesc(img);
          issues.push({ kind: 'broken-image', ...(d ? { desc: d } : {}), ...tag, message: `Image ${path} failed to load.` });
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
    for (const child of Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get.call(node)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        add(range.getBoundingClientRect());
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (getComputedStyle(child).display === 'contents') visit(child);
        else add(Element.prototype.getBoundingClientRect.call(child));
      }
    }
  };
  const main = document.getElementById('main');
  // Markup whose own properties are hidden (a form's named controls) leaves the bounds or text unknown, never the
  // preview unreported.
  try {
    if (main) visit(main);
  } catch {
    bounds = null;
  }
  out.bounds = bounds;
  // What it says, as a reader would read it: evidence of the sample values without a picture of them.
  let text = '';
  try {
    text = main ? String(main.innerText || '').trim().replace(/\s+/g, ' ') : '';
  } catch {
    text = '';
  }
  out.text = text.length > 1000 ? text.slice(0, 999) + '…' : text;
  return out;
}

// ---------------------------------------------------------------------------
// Readability checks: contrast, overlapping boxes, clipped text and tap targets. Computed styles and geometry
// only: nothing here reads a pixel, so a colour only a picture decides (text over a photo) is reported as unverified.
// ---------------------------------------------------------------------------

/** Text this size or larger (CSS px), or this size and bold, needs only the lower ratio (WCAG 2.2 AA, 1.4.3). */
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;
/** Below this width a measurement is a phone's (as the editor's phone styles are, see @shared/styles scopeForWidth). */
const PHONE_MAX_WIDTH = 768;
/** The smallest comfortable touch target in CSS px (WCAG 2.5.5, enhanced). */
const TAP_TARGET_PX = 44;
/** How much of the page one inspection measures: text elements, sibling pairs and text nodes inside one box. */
const MAX_TEXT_ELEMENTS = 3000;
const MAX_PAIRS = 5000;
const MAX_SIBLINGS = 60;
const MAX_CLIP_TEXT_NODES = 400;
/** Gradient colour combinations one text element is measured against. */
const MAX_COMBINATIONS = 400;
/** The findings a report lists; each kind present keeps at least one, and the counts in `checks` are never capped. */
const MAX_ISSUES = 40;

const RGB = /^rgba?\(\s*([-+\d.e]+)[\s,]+([-+\d.e]+)[\s,]+([-+\d.e]+)(?:\s*[,/]\s*([-+\d.e]+%?))?\s*\)$/i;
const SRGB = /^color\(srgb ([-+\d.e]+) ([-+\d.e]+) ([-+\d.e]+)(?: \/ ([-+\d.e]+%?))?\)$/i;
const alphaOf = (s) => (s === undefined ? 1 : s.endsWith('%') ? parseFloat(s) / 100 : Number(s));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Reads a computed colour as sRGB (channels 0-255, alpha 0-1), or null when the browser cannot say. Computed colours
 * keep the space they were written in (oklch, lab, color()), so those go through relative colour syntax, which hands
 * back sRGB channels (as the editor's colour reader does). One reader per inspection: `dispose` removes its probe.
 */
function colorReader() {
  const cache = new Map();
  let probe = null;
  const channels = (m, scale) => ({ r: +m[1] * scale, g: +m[2] * scale, b: +m[3] * scale, a: alphaOf(m[4]) });
  const read = (css) => {
    css = String(css || '').trim();
    if (!css) return null;
    if (cache.has(css)) return cache.get(css);
    let out = null;
    let m = RGB.exec(css);
    if (m) out = channels(m, 1);
    else if (/^transparent$/i.test(css)) out = { r: 0, g: 0, b: 0, a: 0 };
    else if (!/currentcolor|var\(/i.test(css)) {
      // An element no stylesheet names, with an important inline colour, so the page's own rules cannot change it.
      if (!probe) {
        probe = document.createElement('so-color-probe');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.setProperty('display', 'none', 'important');
        document.documentElement.appendChild(probe);
      }
      probe.style.removeProperty('color');
      probe.style.setProperty('color', `color(from ${css} srgb r g b / alpha)`, 'important');
      const got = probe.style.getPropertyValue('color') ? getComputedStyle(probe).color : '';
      if ((m = SRGB.exec(got))) out = channels(m, 255);
      else if ((m = RGB.exec(got))) out = channels(m, 1);
    }
    if (out && ![out.r, out.g, out.b, out.a].every(Number.isFinite)) out = null;
    if (out) out = { r: clamp(out.r, 0, 255), g: clamp(out.g, 0, 255), b: clamp(out.b, 0, 255), a: clamp(out.a, 0, 1) };
    cache.set(css, out);
    return out;
  };
  read.dispose = () => probe?.remove();
  return read;
}

// WCAG relative luminance and contrast, as @shared/contrast computes them.
const lin = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const contrastOf = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** A ratio as shown: cut, never rounded, so a failing one never reads as the minimum (see @shared/contrast). */
const ratioText = (r) => (Math.floor(r * 100 + 1e-11) / 100).toFixed(2);
const hexOf = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Premultiplied colour arithmetic (channels 0-1): `top` over `under`, and a group faded to `alpha`.
const NONE = { r: 0, g: 0, b: 0, a: 0 };
const pm = (c) => ({ r: (c.r / 255) * c.a, g: (c.g / 255) * c.a, b: (c.b / 255) * c.a, a: c.a });
const over = (top, under) => ({ r: top.r + under.r * (1 - top.a), g: top.g + under.g * (1 - top.a), b: top.b + under.b * (1 - top.a), a: top.a + under.a * (1 - top.a) });
const fade = (c, alpha) => ({ r: c.r * alpha, g: c.g * alpha, b: c.b * alpha, a: c.a * alpha });
/** A premultiplied colour shown on the canvas, which is white where nothing is painted, as opaque sRGB. */
const onCanvas = (p) => {
  const c = over(p, { r: 1, g: 1, b: 1, a: 1 });
  return { r: c.r * 255, g: c.g * 255, b: c.b * 255, a: 1 };
};

/** Splits a list at its top-level commas: a colour function's own commas stay inside it. */
function topLevel(list) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** Straight colour `t` of the way from `a` to `b`, mixed premultiplied as the browser mixes gradient stops. */
function mix(a, b, t) {
  const alpha = a.a * (1 - t) + b.a * t;
  if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (k) => (a[k] * a.a * (1 - t) + b[k] * b.a * t) / alpha;
  return { r: ch('r'), g: ch('g'), b: ch('b'), a: alpha };
}

/** A gradient's colours: each stop, and points between neighbouring stops (a mix can be darker than either end). */
const GRADIENT_SAMPLES = [1, 2, 3, 4, 5, 6, 7].map((n) => n / 8);
const MAX_STOPS = 12;

/** Whether one background layer is a picture: something only its pixels could tell. */
const isPictureLayer = (layer) => /url\(|image-set\(|element\(|cross-fade\(|paint\(/i.test(layer);

/**
 * Whether the top background layer is laid over the whole box as the builder writes a scrim: stretched over it
 * (100% 100%, or a gradient's own auto size), blended normally, so its colours are what the picture is seen through.
 */
function scrimCovers(s) {
  if (!s) return false;
  const first = (v, d) => topLevel(v || d)[0] || d;
  // Stretched over the box, so a position in percentages moves it nowhere; one in lengths could move it off the text.
  const size = first(s.backgroundSize, 'auto');
  const at = first(s.backgroundPosition, '0% 0%');
  const clip = first(s.backgroundClip, 'border-box');
  // Sized to the padding box or the border box: one sized to the content box leaves the padding uncovered.
  const origin = first(s.backgroundOrigin, 'padding-box');
  return /^(100% 100%|auto|auto auto)$/.test(size) && /^-?[\d.]+% -?[\d.]+%$/.test(at) && /^(border-box|padding-box)$/.test(clip) && /^(border-box|padding-box)$/.test(origin) && first(s.backgroundBlendMode, 'normal') === 'normal';
}

/**
 * What a computed background-image paints: 'none'; the colours one gradient passes through; 'scrim' for a colour or
 * gradient laid over one picture (a background image with a scrim: its colours over whatever the picture has);
 * 'picture' when an image decides it (url(), image-set()); 'layers' for several images over each other; 'unknown' for
 * a colour that cannot be read. All but 'none', 'gradient' and 'scrim' only pixels could tell.
 */
function backgroundOf(image, read, s) {
  if (!image || image === 'none') return { kind: 'none' };
  const layers = topLevel(image);
  // A gradient blended in a colour space of its own (`in hsl longer hue`) passes through colours its stops do not show.
  if (layers.length === 2 && isPictureLayer(layers[1]) && !isPictureLayer(layers[0]) && !/\bin\s+[a-z]/i.test(layers[0]) && scrimCovers(s)) {
    const top = gradientOf(layers[0], read);
    // Sized to, or cut at, the padding box: the border around it is not under the scrim.
    const first = (v, d) => topLevel(v || d)[0] || d;
    const inner = first(s.backgroundOrigin, 'padding-box') === 'padding-box' || first(s.backgroundClip, 'border-box') === 'padding-box';
    return top.kind === 'gradient' ? { kind: 'scrim', stops: top.stops, inner } : { kind: 'picture' };
  }
  if (isPictureLayer(image)) return { kind: 'picture' };
  if (layers.length > 1) return { kind: 'layers' };
  return gradientOf(layers[0], read);
}

/** The colours one gradient layer passes through, or what else it is ('picture', 'layers', 'unknown'). */
function gradientOf(layer, read) {
  const m = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/is.exec(layer || '');
  if (!m) return { kind: 'picture' };
  // Each stop's colour and where it starts and ends, fixed up as the browser does (a stop placed before the one
  // ahead of it moves up to it), so a hard edge is told from a blend. Positions in other units are not compared.
  const length = (v) => {
    const m2 = /^(-?[\d.]+)(%|px|deg|turn|rad|grad)$/.exec(v || '');
    return m2 ? { n: Number(m2[1]), unit: m2[2] } : null;
  };
  const stops = [];
  let hint = null;
  let last = null;
  for (const part of topLevel(m[1])) {
    const color = /^((?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|transparent|[a-z]+(?=\s|$)|#[0-9a-f]{3,8})/i.exec(part);
    if (!color || /^(to|at|from|in|circle|ellipse|closest|farthest)$/i.test(color[1])) {
      // A colour hint: a lone position between two stops, where the blend between them reaches half way.
      if (stops.length && length(part.trim())) hint = length(part.trim());
      continue;
    }
    const c = read(color[1]);
    if (!c) return { kind: 'unknown' };
    const at = part.slice(color[1].length).trim().split(/\s+/).filter(Boolean);
    let from = length(at[0]);
    let to = length(at[1] || at[0]);
    if (from && last && from.unit === last.unit && from.n < last.n) from = { ...last };
    if (to && from && to.unit === from.unit && to.n < from.n) to = { ...from };
    const prev = stops[stops.length - 1];
    const meets = (a, b) => !!a && !!b && a.unit === b.unit && b.n <= a.n;
    // Meeting at one place, or with the half-way point of their blend placed on either of them: a hard edge.
    const edge = !!prev && (meets(prev.to, from) || meets(prev.to, hint) || (!!hint && !!from && hint.unit === from.unit && hint.n >= from.n));
    stops.push({ c, to, edge });
    if (to) last = to;
    hint = null;
  }
  if (!stops.length || stops.length > MAX_STOPS) return { kind: stops.length ? 'layers' : 'picture' };
  const colors = [stops[0].c];
  for (let i = 1; i < stops.length; i++) {
    // Nothing is painted between two stops meeting at a hard edge.
    if (!stops[i].edge) colors.push(...GRADIENT_SAMPLES.map((t) => mix(stops[i - 1].c, stops[i].c, t)));
    colors.push(stops[i].c);
  }
  return { kind: 'gradient', stops: colors };
}

/** The nearest element (itself or around it) that makes a box: a wrapper with display: contents makes none. */
function boxed(el) {
  let e = el;
  while (e && parentOf(e) && getComputedStyle(e).display === 'contents') e = parentOf(e);
  return e;
}

/** Whether `el` is drawn: laid out, not hidden or inside a closed disclosure, and not faded out. */
function drawn(el) {
  if (!el.isConnected) return false;
  // Text directly in a wrapper that makes no box is drawn where the box around it is.
  if (getComputedStyle(el).display === 'contents') {
    const host = boxed(el);
    return host !== el && getComputedStyle(el).visibility === 'visible' && drawn(host);
  }
  // Through the prototype: a form's control named like either method would hide the form's own.
  if (!Element.prototype.getClientRects.call(el).length) return false;
  if (Element.prototype.checkVisibility) return Element.prototype.checkVisibility.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  for (let e = el; e && e.nodeType === 1; e = parentOf(e)) {
    const s = getComputedStyle(e);
    if (s.display === 'none' || Number(s.opacity) === 0) return false;
  }
  return getComputedStyle(el).visibility === 'visible';
}

/** Hidden on purpose but read out (the "screen readers only" pattern): a box of a pixel or less, or clipped away. */
function visuallyHidden(el, s = getComputedStyle(el)) {
  const r = boxRect(el);
  if (r.width <= 1 || r.height <= 1) return true;
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip)) return true;
  return /inset\(\s*50%/.test(s.clipPath);
}

/**
 * Whether `el` shows only through an ancestor that clips to a pixel or less, as the visually hidden pattern does (a
 * form's spam trap, a screen-reader-only label): whatever its own size, nothing of it is there to see or tap.
 */
function clippedAway(el) {
  // Which ancestors clip the box being walked up from: all of them while it is in flow; for an absolute box, its
  // containing block (positioned, transformed, filtered or contained) and what is above it; for a fixed one, only a
  // transformed, filtered or contained containing block and what is above that, or none (the viewport holds it).
  let placed = getComputedStyle(el).position === 'fixed' ? 'fixed' : getComputedStyle(el).position === 'absolute' ? 'absolute' : 'flow';
  for (let e = parentOf(el); e && e.nodeType === 1 && e !== document.body; e = parentOf(e)) {
    const s = getComputedStyle(e);
    // A box that makes no box of its own (display: contents) neither clips nor holds anything.
    if (s.display === 'contents') continue;
    const holdsFixed = s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain || '');
    const holds = placed === 'flow' || (placed === 'absolute' ? s.position !== 'static' || holdsFixed : holdsFixed);
    if (holds && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
      // Only an axis that clips can hide what it holds.
      const r = boxRect(e);
      if ((s.overflowX !== 'visible' && r.width <= 1) || (s.overflowY !== 'visible' && r.height <= 1)) return true;
    }
    if (s.position === 'fixed' || s.position === 'absolute') placed = s.position;
    else if (holds) placed = 'flow';
  }
  return false;
}

const boxOf = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
/** How far two boxes cross on each axis (negative when they do not). */
const crossing = (a, b) => ({ w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) });

// A form's controls are also its properties by name (an input named "children" hides form.children): read through
// the prototypes.
const CHILDREN = Object.getOwnPropertyDescriptor(Element.prototype, 'children').get;
const CHILD_NODES = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get;
const PARENT = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement').get;
const HAS_ATTRIBUTE = Element.prototype.hasAttribute;
const childrenOf = (el) => CHILDREN.call(el);
const boxRect = (el) => Element.prototype.getBoundingClientRect.call(el);
/** The element around a node; a form's control named "parentElement" would otherwise lead back into the form. */
const parentOf = (node) => PARENT.call(node);

/** The rectangles the text nodes directly inside `el` cover. */
function textRects(el) {
  const out = [];
  for (const child of CHILD_NODES.call(el)) {
    if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(child);
    for (const r of range.getClientRects()) if (r.width && r.height) out.push(boxOf(r));
  }
  return out;
}

/** The nearest element (itself or around it) the editor knows, which a finding about `el` is reported on. */
function editorElement(el) {
  for (let e = el; e && e !== document.documentElement; e = parentOf(e)) if (HAS_ATTRIBUTE.call(e, 'data-so-node')) return e;
  return null;
}

/** The editor's address for a finding about `el`, saying when it is about something inside the element it names. */
function findingDesc(el) {
  try {
    const at = editorElement(el);
    if (!at) return null;
    const d = descOf(at);
    // About something inside the element named (a link in rich text, a code component's markup), which the editor
    // does not address on its own.
    if (at !== el) d.inside = true;
    return d;
  } catch {
    // Markup whose own properties are hidden (a form's named controls) is reported without an address.
    return null;
  }
}

/**
 * The findings of one kind, one per editor element: the same element repeated in list items is one finding that
 * counts them, and the worst measurement among them is the one shown.
 */
function findingList(kind, worse, within = null) {
  const byKey = new Map();
  return {
    kind,
    /** `about`: the element the finding is about when that is not `el` (text a box around it cuts off), or both boxes of an overlap. */
    add(el, measured, message, extra, about = el) {
      const desc = findingDesc(el);
      // Narrowed, the elements asked for that it is inside are part of what it is: one per element asked for.
      const targets = Array.isArray(about) ? scopeTag(about[0], within, about[1]) : scopeTag(about, within);
      const key = desc ? `${desc.ctx}\u0000${desc.node}\u0000${desc.inside ? 1 : 0}\u0000${targets.targets || ''}` : `?${byKey.size}`;
      const found = byKey.get(key);
      if (found) {
        found.count++;
        if (worse && worse(measured, found.measured)) Object.assign(found, { desc, measured, message, extra, text: textPreview(el) });
        return;
      }
      byKey.set(key, { desc, count: 1, measured, message, extra, text: textPreview(el), targets });
    },
    list() {
      return [...byKey.values()].map((f) => ({
        kind,
        ...(f.desc ? { desc: f.desc } : {}),
        ...f.targets,
        ...(f.text ? { text: f.text } : {}),
        ...(f.count > 1 ? { count: f.count } : {}),
        ...f.measured,
        ...(f.extra || {}),
        message: f.message
      }));
    }
  };
}

/**
 * Each element's part in what is painted behind text: its background colour and image, its opacity, and the boxes
 * of the layers its ::before and ::after paint out of the flow (a tint over a hero photo), which can lie under text
 * or over it. Cached for one inspection.
 */
function layerCache(read) {
  const cache = new Map();
  const px = (v) => (/px$/.test(v) ? parseFloat(v) : NaN);
  return (el) => {
    let layer = cache.get(el);
    if (layer) return layer;
    const s = getComputedStyle(el);
    if (s.display === 'contents') layer = { bg: NONE, image: { kind: 'none' }, opacity: 1, overlays: [] };
    else {
      layer = { bg: read(s.backgroundColor) || NONE, image: backgroundOf(s.backgroundImage, read, s), opacity: clamp(Number(s.opacity), 0, 1), overlays: [] };
      // A background painted only inside the content box (or only on the glyphs) does not cover what is under the box.
      // A picture under a scrim stands for any colour at all (see textContrast), so nothing under it matters either.
      // The colour is painted with the last layer's clip; a scrim (checked by scrimCovers) with the first's.
      const clips = topLevel(s.backgroundClip || 'border-box');
      layer.covers = (layer.bg.a >= 1 && /^(border-box|padding-box)$/.test(clips[clips.length - 1] || 'border-box')) || layer.image.kind === 'scrim';
      const r = boxRect(el);
      for (const which of ['::before', '::after']) {
        const p = getComputedStyle(el, which);
        if (p.content === 'none' || p.display === 'none' || Number(p.opacity) === 0) continue;
        if ((read(p.backgroundColor)?.a ?? 0) === 0 && (!p.backgroundImage || p.backgroundImage === 'none')) continue;
        // A layer in the flow takes a place of its own; one taken out of it can lie anywhere over the box.
        if (p.position !== 'absolute' && p.position !== 'fixed') continue;
        const w = parseFloat(p.width);
        const h = parseFloat(p.height);
        // Placed against this box only when the box is positioned; otherwise it is somewhere further out.
        if (!(w > 0 && h > 0) || p.position === 'fixed' || s.position === 'static') {
          layer.overlays.push(boxOf(r));
          continue;
        }
        let x = px(p.left);
        if (Number.isNaN(x)) x = el.clientWidth - px(p.right) - w;
        let y = px(p.top);
        if (Number.isNaN(y)) y = el.clientHeight - px(p.bottom) - h;
        // With neither side set it sits where it would have been in the flow, which computed styles do not give.
        if (Number.isNaN(x) || Number.isNaN(y)) layer.overlays.push(boxOf(r));
        else layer.overlays.push({ x: r.left + el.clientLeft + x + (px(p.marginLeft) || 0) - el.scrollLeft, y: r.top + el.clientTop + y + (px(p.marginTop) || 0) - el.scrollTop, width: w, height: h });
      }
    }
    cache.set(el, layer);
    return layer;
  };
}

/**
 * The contrast of the text directly inside `el` against everything painted under it: every background from the
 * canvas up to the text (colours composited with their alpha, gradients at each stop) and every fade on the way, as
 * the browser composites them. Returns the ratio (the worst a gradient gives), or why it cannot be known without
 * pixels: { unknown: 'image' | 'overlay' | 'gradient' | 'fill' | 'color' }.
 */
function textContrast(el, read, layerOf, pictures) {
  const s = getComputedStyle(el);
  const fill = read(s.webkitTextFillColor || s.color);
  if (!fill) return { unknown: 'color' };
  // Text filled with its own background (gradient text) or with nothing: a picture's colours.
  if (fill.a === 0) return { unknown: 'fill' };
  const rects = textRects(el);
  if (!rects.length) return null;
  const meets = (box) => rects.some((r) => {
    const c = crossing(r, box);
    return c.w > 1 && c.h > 1;
  });
  const chain = [];
  for (let e = el; e && e.nodeType === 1; e = parentOf(e)) chain.unshift(e);
  const layers = chain.map(layerOf);
  // The innermost opaque surface hides everything painted under it, unless it, or a box around it, is faded: then
  // what is under the faded box shows through.
  let cover = -1;
  for (let i = layers.length - 1; i >= 0 && cover < 0; i--) if (layers[i].covers) cover = i;
  // A box faded at or around the cover lets what is under that box show through, down to the next opaque surface
  // beneath it (which a fade further out can open in turn); what is inside the faded box under the cover stays hidden.
  const visible = new Set();
  for (let start = Math.max(cover, 0); start > 0; ) {
    let fadedAt = -1;
    for (let j = start; j >= 0 && fadedAt < 0; j--) if (layers[j].opacity < 1) fadedAt = j;
    if (fadedAt <= 0) break;
    let below = fadedAt - 1;
    while (below > 0 && !layers[below].covers) below--;
    for (let i = below; i < fadedAt; i++) visible.add(i);
    start = below;
  }
  const shows = (i) => i >= cover || visible.has(i);
  for (let i = 0; i < layers.length; i++) {
    if (!shows(i)) continue;
    const kind = layers[i].image.kind;
    if (kind === 'picture') return { unknown: 'image' };
    if (kind === 'layers') return { unknown: 'layers' };
    if (kind === 'unknown') return { unknown: 'color' };
    if (layers[i].overlays.some(meets)) return { unknown: 'overlay' };
  }
  // A picture under the text (a hero photo, a video, an image placed behind a link's words), unless an opaque
  // surface in the text's own branch, below where the picture sits and not faded, hides it.
  for (const p of pictures) {
    if (!meets(p.rect) || p.el.contains(el)) continue;
    const shared = chain.findLastIndex((e) => e.contains(p.el));
    let hidden = false;
    for (let i = shared + 1; i < layers.length && !hidden; i++) {
      if (layers[i].opacity < 1) break;
      hidden = !!layers[i].covers;
    }
    if (!hidden) return { unknown: 'image' };
  }
  // Every combination of gradient colours: each layer's colour, its gradient's colour over it, then what is inside it.
  // A scrim's own colours (one colour, or its gradient's) lie over its picture.
  const distinct = (stops) => [...new Map(stops.map((c) => [`${c.r},${c.g},${c.b},${c.a}`, c])).values()];
  const options = layers.map((l, i) => (!shows(i) ? [NONE] : l.image.kind === 'gradient' ? l.image.stops : l.image.kind === 'scrim' ? distinct(l.image.stops) : [NONE]));
  // More combinations than are worth working through: a definite answer could miss the one that fails.
  if (options.reduce((n, o) => n * o.length, 1) > MAX_COMBINATIONS) return { unknown: 'gradient' };
  const results = [];
  const picks = [];
  // A picture under a scrim could be any colour: each colour channel of what is painted grows with the picture's, and
  // luminance with each channel, so the darkest and lightest the background can be are the picture taken as black and
  // as white. See-through text over one is colours of the picture too.
  const scrimmed = layers.some((l, i) => shows(i) && l.image.kind === 'scrim');
  if (scrimmed && fill.a < 1) return { unknown: 'image' };
  // A scrim covers its own box: text moved or overflowing out of it sits on whatever is there instead.
  for (let i = 0; i < layers.length; i++) {
    if (!shows(i) || layers[i].image.kind !== 'scrim') continue;
    const box = boxOf(boxRect(chain[i]));
    const e = chain[i];
    const b = layers[i].image.inner ? { x: box.x + e.clientLeft, y: box.y + e.clientTop, width: e.clientWidth, height: e.clientHeight } : box;
    if (rects.some((r) => r.x < b.x - 0.5 || r.y < b.y - 0.5 || r.x + r.width > b.x + b.width + 0.5 || r.y + r.height > b.y + b.height + 0.5)) return { unknown: 'image' };
  }
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  const WHITE = { r: 1, g: 1, b: 1, a: 1 };
  const paint = (withText, picture = BLACK) => {
    let p = withText ? pm(fill) : NONE;
    for (let i = layers.length - 1; i >= 0; i--) {
      p = over(p, over(pm(picks[i]), layers[i].image.kind === 'scrim' && shows(i) ? picture : pm(layers[i].bg)));
      if (layers[i].opacity < 1) p = fade(p, layers[i].opacity);
    }
    return onCanvas(p);
  };
  const walk = (i) => {
    if (i === layers.length) {
      const fg = paint(true);
      if (!scrimmed) {
        const bg = paint(false);
        results.push({ ratio: contrastOf(fg, bg), fg, bg });
        return;
      }
      // Text in a faded box over the picture shows the picture through it: its colour is the picture's too.
      const fgLight = paint(true, WHITE);
      if (Math.abs(luminance(fgLight) - luminance(fg)) > 1e-9) {
        results.push({ ratio: 1, fg, bg: fg, unknown: true });
        return;
      }
      const dark = paint(false, BLACK);
      const light = paint(false, WHITE);
      const l = luminance(fg);
      // A scrim that hides the picture paints one colour, whatever the picture has.
      if (luminance(dark) === luminance(light)) results.push({ ratio: contrastOf(fg, dark), fg, bg: dark });
      // Text as light as some colour the background can take could sit on exactly that colour.
      else if (l >= luminance(dark) && l <= luminance(light)) results.push({ ratio: 1, fg, bg: l - luminance(dark) < luminance(light) - l ? dark : light, open: true });
      else {
        const bg = l > luminance(light) ? light : dark;
        results.push({ ratio: contrastOf(fg, bg), fg, bg, open: true });
      }
      return;
    }
    for (const stop of options[i]) {
      picks[i] = stop;
      walk(i + 1);
    }
  };
  walk(0);
  const size = parseFloat(s.fontSize) || 16;
  const required = size >= LARGE_TEXT_PX || (size >= LARGE_BOLD_TEXT_PX && (parseInt(s.fontWeight, 10) || 400) >= 700) ? 3 : 4.5;
  const worst = results.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  // Over a picture, readable however dark or light it is: the scrim keeps it readable. Short of that, only a scrim
  // opaque enough to hide the picture says the text fails; anything less, only the picture's pixels could tell.
  if (results.some((r) => r.unknown)) return { unknown: 'image' };
  if (scrimmed && worst.ratio >= required) return { ratio: worst.ratio, required, fg: hexOf(worst.fg), bg: hexOf(worst.bg), gradient: results.length > 1 };
  if (scrimmed && results.some((r) => r.open)) return { unknown: 'scrim' };
  if (results.length > 1) {
    const failing = results.filter((r) => r.ratio < required).length;
    // A gradient that is readable at some of its colours and not at others may or may not fail under the text: only
    // its pixels could say.
    if (failing && failing < results.length) return { unknown: 'gradient' };
  }
  return { ratio: worst.ratio, required, fg: hexOf(worst.fg), bg: hexOf(worst.bg), gradient: results.length > 1 };
}

const UNKNOWN_CONTRAST = {
  image: 'it is shown over an image, whose colors only pixels could tell',
  scrim: 'it is shown over a background image whose scrim is too light to keep it readable over every color the image could have. A stronger scrim fixes it',
  overlay: 'a decorative layer (a ::before or ::after) lies over its background',
  gradient: 'its gradient background is readable at some points and not at others',
  layers: 'its background is several images or gradients over each other',
  fill: 'its text is painted with a background or an image',
  color: 'its color could not be read'
};

/** Elements that take a press or a tap. */
const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"]';

/**
 * Whether a link is in a sentence, and so can be as small as its text (WCAG 2.5.8's inline exception): an inline
 * link in a block that has words of its own outside its links and controls (a separator such as "|" is not one).
 * Each block is read once per inspection.
 */
function sentences() {
  const prose = new Map();
  return (el, s) => {
    if (el.tagName !== 'A' || s.display !== 'inline') return false;
    let block = parentOf(el);
    while (block && getComputedStyle(block).display === 'inline') block = parentOf(block);
    if (!block) return false;
    if (!prose.has(block)) {
      let words = false;
      const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(), n = 0; t && !words && n < 2000; t = tw.nextNode(), n++) {
        if (!/[\p{L}\p{N}]/u.test(t.textContent)) continue;
        const control = parentOf(t)?.closest(INTERACTIVE);
        words = !(control && block.contains(control));
      }
      prose.set(block, words);
    }
    return prose.get(block);
  };
}

/**
 * Whether two boxes may overlap on purpose: positioned, moved, floated or layered boxes do, as do grid items placed
 * on a line of their own choosing and boxes pulled over a neighbour with a negative margin.
 */
function layered(s) {
  if (s.position !== 'static' && s.position !== 'relative') return true;
  if (s.position === 'relative' && ['top', 'right', 'bottom', 'left'].some((k) => s[k] !== 'auto' && parseFloat(s[k]) !== 0)) return true;
  if (s.transform !== 'none' || s.translate !== 'none' || s.float !== 'none' || s.zIndex !== 'auto') return true;
  if (['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].some((k) => parseFloat(s[k]) < 0)) return true;
  return s.gridRowStart !== 'auto' || s.gridColumnStart !== 'auto' || s.gridRowEnd !== 'auto' || s.gridColumnEnd !== 'auto';
}

/** The children of `el` that make boxes, looking through wrappers that make none (display: contents). */
function boxChildren(el, out = []) {
  for (const c of childrenOf(el)) {
    if (getComputedStyle(c).display === 'contents') boxChildren(c, out);
    else out.push(c);
  }
  return out;
}

/**
 * The readability checks: text contrast against its painted background, sibling boxes that overlap, text a box cuts
 * off, and (at phone width) controls too small to tap. Returns the totals and the findings, worst first. Each
 * candidate is measured on its own: one that cannot be (odd markup) or that the time left does not reach marks its
 * check incomplete instead of losing the report.
 */
function readability(vw, deadline, within = null) {
  // `within`: only elements inside the ones asked for are checked; what is around them still counts as what they sit on.
  const read = colorReader();
  const count = () => ({ checked: 0, failed: 0, unverified: 0 });
  const checks = { contrast: count(), overlaps: count(), clippedText: count(), tapTargets: count() };
  if (vw >= PHONE_MAX_WIDTH) checks.tapTargets.skipped = `Tap targets are checked below ${PHONE_MAX_WIDTH}px (phone widths).`;
  const lowContrast = findingList('low-contrast', (a, b) => a.ratio < b.ratio, within);
  const unknownContrast = findingList('contrast-unverified', null, within);
  const clipped = findingList('clipped-text', null, within);
  const overlaps = findingList('overlap', (a, b) => a.overlap.width * a.overlap.height > b.overlap.width * b.overlap.height, within);
  const small = findingList('small-tap-target', (a, b) => a.size.width * a.size.height < b.size.width * b.size.height, within);
  /** Runs one candidate of `check`; false once time is up (the check is then incomplete). */
  const each = (check, fn) => {
    if (Date.now() > deadline) {
      check.incomplete = true;
      return false;
    }
    try {
      fn();
    } catch {
      check.incomplete = true;
    }
    return true;
  };
  try {
    const layerOf = layerCache(read);
    const pictures = [];
    for (const p of document.querySelectorAll('img, video, canvas, iframe, object, embed, svg image')) {
      const going = each(checks.contrast, () => {
        const r = boxRect(p);
        if (r.width > 1 && r.height > 1 && drawn(p)) pictures.push({ el: p, rect: boxOf(r) });
      });
      if (!going) break;
    }
    // Contrast: every element with text of its own.
    const seen = new Set();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = parentOf(t);
      if (!el || seen.has(el) || !t.textContent.trim() || (within && !within(el))) continue;
      if (seen.size >= MAX_TEXT_ELEMENTS) {
        checks.contrast.incomplete = true;
        break;
      }
      seen.add(el);
      const going = each(checks.contrast, () => {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION|OPTGROUP|SELECT|TITLE|TEMPLATE)$/.test(el.tagName) || el.closest('svg, .so-link-editor')) return;
        const host = boxed(el);
        if (!drawn(el) || visuallyHidden(host) || el.closest(':disabled, [aria-disabled="true"]')) return;
        const result = textContrast(el, read, layerOf, pictures);
        if (!result) return;
        checks.contrast.checked++;
        if (result.unknown) {
          checks.contrast.unverified++;
          unknownContrast.add(el, { reason: result.unknown }, `Contrast could not be measured: ${UNKNOWN_CONTRAST[result.unknown]}. Make sure the text stays readable on it.`);
        } else if (result.ratio < result.required) {
          checks.contrast.failed++;
          const shown = ratioText(result.ratio);
          lowContrast.add(el, { ratio: Number(shown), required: result.required, foreground: result.fg, background: result.bg }, `Text contrast is ${shown}:1 (${result.fg} on ${result.bg}${result.gradient ? ' at every point of its gradient' : ''}); text this size needs at least ${result.required}:1.`);
        }
      });
      if (!going) break;
    }
    // Clipped text: a box that hides what does not fit (overflow hidden or clip) with text cut off at its edge: lines
    // hidden below or above it, or a line running out of its side. Text wholly to one side is off-screen on purpose
    // (the next slide of a carousel); text shortened on purpose (an ellipsis, a line clamp) and the visually hidden
    // pattern are left alone.
    // Narrowed, a box around an element asked for can cut its text off too: only the text inside the elements counts there.
    const around = within ? (el) => within.ancestors.has(el) : null;
    for (const el of document.querySelectorAll('body *')) {
      const inside = !within || within(el);
      if (!inside && !around(el)) continue;
      const going = each(checks.clippedText, () => {
        if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) return;
        const s = getComputedStyle(el);
        const hidesX = (s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 2;
        const hidesY = (s.overflowY === 'hidden' || s.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 2;
        if ((!hidesX && !hidesY) || !el.textContent.trim() || !drawn(el) || visuallyHidden(el, s)) return;
        checks.clippedText.checked++;
        const box = boxRect(el);
        const clip = { left: box.left + el.clientLeft, top: box.top + el.clientTop, right: box.left + el.clientLeft + el.clientWidth, bottom: box.top + el.clientTop + el.clientHeight };
        const clamped = (st) => st.webkitLineClamp && st.webkitLineClamp !== 'none';
        let cut = null;
        let n = 0;
        // Around the elements asked for, only the text inside them is read: the rest is never walked.
        // Only the outermost of them, so text inside two nested ones is read once.
        const under = inside ? [] : within.roots.filter((r) => Node.prototype.contains.call(el, r));
        const sources = inside ? [el] : under.filter((r) => !under.some((o) => o !== r && Node.prototype.contains.call(o, r)));
        for (const t of textsUnder(sources)) {
          if (cut) break;
          const holder = parentOf(t);
          if (++n > MAX_CLIP_TEXT_NODES) {
            checks.clippedText.incomplete = true;
            break;
          }
          if (!t.textContent.trim() || !holder || !drawn(holder)) continue;
          const hs = holder === el ? s : getComputedStyle(holder);
          // An ellipsis shortens a line on purpose; a line clamp, the lines after it.
          const ellipsis = hs.textOverflow === 'ellipsis' || s.textOverflow === 'ellipsis';
          const clamp = clamped(hs) || clamped(s);
          const range = document.createRange();
          range.selectNodeContents(t);
          // Text wholly to one side is lost from a line the box cuts, unless the block holding it lies wholly outside
          // too (the next slide of a carousel, waiting off screen).
          let block = holder;
          while (block !== el && parentOf(block) && /^(inline|contents)$/.test(getComputedStyle(block).display)) block = parentOf(block);
          const br = boxRect(block);
          const offScreen = block !== el && (br.left >= clip.right - 1 || br.right <= clip.left + 1);
          for (const r of range.getClientRects()) {
            if (!r.width || !r.height) continue;
            // More than a quarter of a line outside the box: tight line heights let glyphs reach a little past it.
            const outY = hidesY && !clamp ? Math.max(0, r.bottom - clip.bottom) + Math.max(0, clip.top - r.top) : 0;
            const outX = hidesX && !ellipsis && !offScreen ? Math.max(0, r.right - clip.right) + Math.max(0, clip.left - r.left) : 0;
            if (outY > Math.max(2, r.height / 4)) cut = { holder, axis: 'vertical' };
            else if (outX > Math.max(2, r.height / 2)) cut = { holder, axis: 'horizontal' };
            if (cut) break;
          }
        }
        if (!cut) return;
        checks.clippedText.failed++;
        const vertical = cut.axis === 'vertical';
        clipped.add(
          el,
          { axis: cut.axis, box: { width: el.clientWidth, height: el.clientHeight }, content: { width: el.scrollWidth, height: el.scrollHeight } },
          vertical ? `Text is cut off: the box is ${el.clientHeight}px tall, hides what does not fit, and its content needs ${el.scrollHeight}px.` : `Text is cut off: the box is ${el.clientWidth}px wide, hides what does not fit, and its content needs ${el.scrollWidth}px.`,
          { cutText: textPreview(cut.holder) },
          cut.holder
        );
      });
      if (!going) break;
    }
    // Overlapping boxes: block-level siblings in the normal flow whose boxes cross by more than rounding. (Inline
    // siblings flow as text: their outer rectangles cross without their lines doing so.)
    const parents = new Set();
    // Narrowed, the elements asked for are seeded too: a code component's marked part carries no editor address of its own.
    for (const el of within ? [...within.roots, ...document.querySelectorAll('[data-so-node]')] : document.querySelectorAll('[data-so-node]')) {
      if (within && !within(el)) continue;
      const going = each(checks.overlaps, () => {
        let p = parentOf(el);
        while (p && p !== document.documentElement && getComputedStyle(p).display === 'contents') p = parentOf(p);
        if (p) parents.add(p);
      });
      if (!going) break;
    }
    let pairs = 0;
    overlap: for (const p of parents) {
      let boxes = [];
      const going = each(checks.overlaps, () => {
        let kids = boxChildren(p).filter((c) => {
          const cs = getComputedStyle(c);
          return cs.display !== 'inline' && editorElement(c) && drawn(c) && !layered(cs);
        });
        if (kids.length > MAX_SIBLINGS) {
          kids = kids.slice(0, MAX_SIBLINGS);
          checks.overlaps.incomplete = true;
        }
        boxes = kids.map((c) => ({ el: c, rect: boxOf(boxRect(c)) })).filter((k) => k.rect.width > 2 && k.rect.height > 2);
      });
      if (!going) break;
      // Every pair is checked: sweeping down the page, a box only meets those that start above its bottom, and the
      // rest are apart. A sweep cut short counts only the pairs it compared.
      let compared = 0;
      // Narrowed, only pairs with a box inside the elements asked for count: each two of those, and each with one outside.
      const inside = within ? boxes.filter((b) => within(b.el)).length : boxes.length;
      const all = (inside * (inside - 1)) / 2 + inside * (boxes.length - inside);
      boxes.sort((a, b) => a.rect.y - b.rect.y);
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        for (let j = i + 1; j < boxes.length && boxes[j].rect.y < a.rect.y + a.rect.height; j++) {
          if (within && !within(a.el) && !within(boxes[j].el)) continue;
          if (++pairs > MAX_PAIRS) {
            checks.overlaps.incomplete = true;
            checks.overlaps.checked += compared;
            break overlap;
          }
          compared++;
          // The box inside the elements asked for is the one the finding is about.
          const [one, b] = within && !within(a.el) ? [boxes[j], a] : [a, boxes[j]];
          const c = crossing(one.rect, b.rect);
          if (c.w <= 2 || c.h <= 2) continue;
          const going = each(checks.overlaps, () => {
            const other = findingDesc(b.el);
            overlaps.add(one.el, { overlap: { width: Math.round(c.w), height: Math.round(c.h) } }, `Overlaps a neighboring box by ${Math.round(c.w)}×${Math.round(c.h)}px.`, { with: { ...(other ? { desc: other } : {}), text: textPreview(b.el) } }, [one.el, b.el]);
            checks.overlaps.failed++;
          });
          if (!going) {
            checks.overlaps.checked += compared;
            break overlap;
          }
        }
      }
      checks.overlaps.checked += all;
    }
    // Tap targets, at phone width: every control smaller than a fingertip, measured on its own box (a checkbox or
    // radio button also counts the label around it that labels it), except a link inside a sentence.
    if (vw < PHONE_MAX_WIDTH) {
      const inSentence = sentences();
      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (within && !within(el)) continue;
        const going = each(checks.tapTargets, () => {
          if (!drawn(el) || el.closest(':disabled, [aria-disabled="true"]')) return;
          const s = getComputedStyle(el);
          if (visuallyHidden(el, s) || clippedAway(el) || inSentence(el, s)) return;
          let r = rectOf(el);
          if (!r) return;
          if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
            const label = el.closest('label');
            const lr = label && label.control === el ? boxRect(label) : null;
            if (lr && lr.width && lr.height) {
              const x1 = Math.min(r.x, lr.left);
              const y1 = Math.min(r.y, lr.top);
              r = { x: x1, y: y1, width: Math.max(r.x + r.width, lr.right) - x1, height: Math.max(r.y + r.height, lr.bottom) - y1 };
            }
          }
          checks.tapTargets.checked++;
          // Measured sizes can fall a fraction short of a whole pixel.
          if (r.width >= TAP_TARGET_PX - 0.5 && r.height >= TAP_TARGET_PX - 0.5) return;
          checks.tapTargets.failed++;
          const size = { width: Math.round(r.width), height: Math.round(r.height) };
          const what = el.tagName === 'A' || el.getAttribute('role') === 'link' ? 'link' : 'control';
          small.add(el, { size, minimum: TAP_TARGET_PX }, `This ${what} is ${size.width}×${size.height}px; at phone width a tap target should be at least ${TAP_TARGET_PX}×${TAP_TARGET_PX}px.`);
        });
        if (!going) break;
      }
    }
  } finally {
    read.dispose();
  }
  return { checks, findings: [lowContrast, clipped, overlaps, small, unknownContrast].map((f) => f.list()) };
}

/**
 * The findings a report lists, at most `max`, from lists of one kind each: every kind present keeps one, and the
 * rest is shared out a finding of each kind at a time, so a long list never hides a kind after it.
 */
function pickIssues(lists, max) {
  const taken = lists.map((l) => (l.length ? 1 : 0));
  let left = max - taken.reduce((a, b) => a + b, 0);
  for (let more = true; left > 0 && more; ) {
    more = false;
    for (let i = 0; i < lists.length && left > 0; i++) {
      if (taken[i] >= lists[i].length) continue;
      taken[i]++;
      left--;
      more = true;
    }
  }
  return lists.flatMap((l, i) => l.slice(0, taken[i]));
}

/** Stacked pairs one inspection reports at most. */
const MAX_GAPS = 400;

/**
 * For the AI's component inspection: each two elements of the editor's markup that follow one another stacked in
 * their container, and the space between them, so a preview with content left empty can be compared with the same
 * preview with it shown. Each is named by where it rendered, the list items it is in, and which of the elements
 * rendered there it is (`n` of `of`, in document order). Only the containers of the editor's elements are looked
 * at, and only until `deadline`: `incomplete` then says the list stops short.
 */
function stackGaps(deadline) {
  const gaps = [];
  let incomplete = false;
  const main = document.getElementById('main');
  if (!main) return { gaps, incomplete };
  const children = Object.getOwnPropertyDescriptor(Element.prototype, 'children').get;
  const ends = new Map();
  const totals = new Map();
  const parents = new Set();
  try {
    for (const el of main.querySelectorAll('[data-so-node]')) {
      if (Date.now() > deadline) return { gaps, incomplete: true };
      const d = descOf(el);
      const base = `${d.ctx}\u0000${d.node}\u0000${d.items}`;
      const n = totals.get(base) || 0;
      totals.set(base, n + 1);
      ends.set(el, { ctx: d.ctx, node: d.node, items: d.items, n, base });
      // The container that lays it out, looking through wrappers that take no box.
      let p = el.parentElement;
      while (p && p !== main && getComputedStyle(p).display === 'contents') p = p.parentElement;
      if (p && (p === main || main.contains(p))) parents.add(p);
    }
    const end = (e) => ({ ctx: e.ctx, node: e.node, items: e.items, n: e.n, of: totals.get(e.base) });
    /** The boxes a container lays out in the flow, in order; `edge` when one can be measured from (shown, a box of its own, in place). */
    const laidOut = (parent) => {
      const out = [];
      for (const c of children.call(parent)) {
        const s = getComputedStyle(c);
        if (s.display === 'none') continue;
        if (s.display === 'contents') {
          out.push(...laidOut(c));
          continue;
        }
        if (s.position === 'absolute' || s.position === 'fixed') continue;
        const r = Element.prototype.getBoundingClientRect.call(c);
        // Inline text runs line up by chance; an inline block is a box like any other.
        if (r.width || r.height) out.push({ el: c, r, edge: s.visibility === 'visible' && s.display !== 'inline' && s.position !== 'sticky' });
      }
      return out;
    };
    for (const parent of parents) {
      if (gaps.length >= MAX_GAPS || Date.now() > deadline) {
        incomplete = true;
        break;
      }
      const boxes = laidOut(parent);
      for (let i = 1; i < boxes.length; i++) {
        // A list cut short says so: a pair left out could be the one that collapsed.
        if (gaps.length >= MAX_GAPS || Date.now() > deadline) {
          incomplete = true;
          break;
        }
        const a = boxes[i - 1];
        const b = boxes[i];
        const ea = ends.get(a.el);
        const eb = ends.get(b.el);
        // Stacked: the second below the first, sharing some of its width (not the next card of a row).
        if (!ea || !eb || !a.edge || !b.edge || b.r.top < a.r.bottom - 1 || b.r.left >= a.r.right || b.r.right <= a.r.left) continue;
        gaps.push({ a: end(ea), b: end(eb), gap: Math.round((b.r.top - a.r.bottom) * 2) / 2 });
      }
    }
  } catch {
    // Markup whose own properties are hidden (a form's named controls) ends the list early rather than the report.
    incomplete = true;
  }
  return { gaps, incomplete };
}

// ---------------------------------------------------------------------------
// Page rhythm: how the page's sections follow one another, from their rendered geometry, painted backgrounds,
// heading sizes and filled buttons. Advice on composition only, never a defect: three sections in a row with one
// layout on one background, an inner heading as large as the page's h1, filled buttons in section after section.
// ---------------------------------------------------------------------------

/** How many sections in a row make a run worth a note. */
const RHYTHM_RUN = 3;
/** How deep the walk into a section looks for the layout that sets its columns. */
const MAX_LAYOUT_DEPTH = 12;
/** How much of the page one rhythm measurement looks at: sections, controls and headings. */
const MAX_RHYTHM_SECTIONS = 200;
const MAX_RHYTHM_CONTROLS = 400;
const MAX_RHYTHM_HEADINGS = 300;
/** Two surfaces this close in luminance (0-1) are the same tone. */
const SAME_LUMINANCE = 0.001;
/** A filled button: at most this tall, with a fill this opaque and this far from what is around it. */
const BUTTON_MAX_HEIGHT = 96;
const BUTTON_MIN_ALPHA = 0.8;
const BUTTON_MIN_CONTRAST = 1.5;
/** Pictures in a peer or a section covering this share of it make it a picture rather than a text box. */
const MEDIA_SHARE = 0.4;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const countWord = (n) => NUMBER_WORDS[n] || String(n);
const PICTURES = 'img, video, canvas, iframe, object, embed, svg image, picture, .so-img';
const TEXT_BLOCKS = 'h1, h2, h3, h4, h5, h6, p';
const HEADINGS = 'h1, h2, h3';
const CONTROLS = 'a[href], button, input[type="submit"], input[type="button"], [role="button"]';
/** A level with more boxes than this is a list, not a layout of columns; the walk visits at most this many levels. */
const MAX_LEVEL_BOXES = 60;
const MAX_LAYOUT_VISITS = 40;
/** offsetWidth, offsetHeight, clientLeft, clientTop, clientWidth and clientHeight, read as the element's own. */
const METRICS = ['offsetWidth', 'offsetHeight', 'clientLeft', 'clientTop', 'clientWidth', 'clientHeight'].map((k) => Object.getOwnPropertyDescriptor(k.startsWith('offset') ? HTMLElement.prototype : Element.prototype, k).get);
/** The longest report that keeps its rhythm notes, well inside the longest message the editor accepts (200,000). */
const MAX_REPORT_CHARS = 190_000;

/**
 * The page's top-level sections in the order the page lists them: the outermost elements rendered for each of
 * `rootIds`, as the generator marks a page's own nodes (`page:<id>`) and what a placement on it renders
 * (`page:<id>|<placement>|…`). Each keeps the boxes it lays out (looking through wrappers that make none) and the
 * address of its placement; a section that rendered nothing has no boxes. `others`: the page's own markup outside
 * every section listed (one the editor removed, on a load from before then), which still shows between them.
 */
function pageSections(pageId, rootIds, deadline) {
  const own = `page:${pageId}`;
  const wanted = new Map(rootIds.map((id, i) => [id, i]));
  const found = rootIds.map(() => []);
  const strays = [];
  // Each element counts once, under the outermost element of its section: document order puts that one first.
  const outer = new Map();
  const within = (el, key) => {
    for (let e = parentOf(el); e; e = parentOf(e)) if (outer.get(e) === key) return true;
    return false;
  };
  for (const [i, el] of [...document.querySelectorAll('[data-so-ctx^="page:"]')].entries()) {
    if (i % 200 === 0 && Date.now() > deadline) return null;
    const ctx = el.getAttribute('data-so-ctx');
    const key = ctx === own ? el.getAttribute('data-so-node') : ctx.startsWith(own + '|') ? ctx.slice(own.length + 1).split('|')[0] : null;
    if (!key) continue;
    if (!wanted.has(key)) {
      strays.push(el);
      continue;
    }
    if (within(el, key)) continue;
    outer.set(el, key);
    found[wanted.get(key)].push(el);
  }
  // At most one box more than a layout of columns has: a section of more (a long list a code component renders
  // directly) is not measured, and the first boxes still place it on the page.
  const boxesOf = (els) => {
    const boxes = [];
    let seen = 0;
    let late = false;
    const visit = (el) => {
      if (late || boxes.length > MAX_LEVEL_BOXES || (++seen % 200 === 0 && (late = Date.now() > deadline))) return;
      if (getComputedStyle(el).display !== 'contents') {
        if (drawn(el) && boxRect(el).height >= 1) boxes.push(el);
        return;
      }
      for (const c of childrenOf(el)) visit(c);
    };
    els.forEach(visit);
    return boxes;
  };
  const areaOf = (boxes) => {
    let a = null;
    for (const b of boxes) {
      const r = boxRect(b);
      a = a ? { left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return a && { ...a, width: a.right - a.left, height: a.bottom - a.top };
  };
  const sections = rootIds.map((id, i) => {
    const boxes = boxesOf(found[i]);
    return { id, n: i + 1, boxes, desc: { ctx: own, node: id, items: '' }, area: areaOf(boxes) };
  });
  // Content placed inside a section (a slot's) is that section's; markup inside other markup counts once.
  const held = new Set(found.flat());
  const others = [];
  for (const [i, el] of strays.entries()) {
    if (i % 200 === 0 && Date.now() > deadline) return null;
    let inside = false;
    for (let e = parentOf(el); e && !inside; e = parentOf(e)) inside = held.has(e);
    held.add(el);
    if (inside) continue;
    const boxes = boxesOf([el]);
    if (!boxes.length) continue;
    // More than the page lists: not a page whose order can be told.
    if (others.length >= MAX_RHYTHM_SECTIONS) return null;
    others.push({ el, boxes, area: areaOf(boxes) });
  }
  return { sections, others };
}

/**
 * The colour painted behind everything inside `el`: every background from the canvas up to it, composited with their
 * alpha. Null when only pixels could say: an image or gradient shows, something on the way is faded, or a layer of
 * its own (a ::before tint) lies over it.
 */
function surfaceOf(el, layerOf) {
  const chain = [];
  for (let e = el; e && e.nodeType === 1; e = parentOf(e)) chain.unshift(e);
  const layers = chain.map(layerOf);
  let cover = -1;
  for (let i = layers.length - 1; i >= 0 && cover < 0; i--) if (layers[i].covers) cover = i;
  if (layers.some((l) => l.opacity < 1) || layers[layers.length - 1].overlays.length) return null;
  let p = NONE;
  for (let i = Math.max(cover, 0); i < layers.length; i++) {
    if (layers[i].image.kind !== 'none') return null;
    p = over(pm(layers[i].bg), p);
  }
  return onCanvas(p);
}

/** The share of `box` the pictures inside `el` cover, the largest one counted (a photo behind a hero, say). */
function pictureShare(el, box) {
  const area = box.width * box.height;
  if (!area) return 0;
  let most = 0;
  for (const p of [el, ...el.querySelectorAll(PICTURES)]) {
    if (p === el && !el.matches(PICTURES)) continue;
    if (!drawn(p)) continue;
    const c = crossing(boxOf(boxRect(p)), box);
    if (c.w > 0 && c.h > 0) most = Math.max(most, (c.w * c.h) / area);
  }
  return most;
}

/**
 * The boxes `el` lays out in the flow, side by side or stacked: shown, of a size, and not out of the flow or inline.
 * Null when it has more than a layout of columns has (a long list), which is not measured.
 */
function flowBoxes(el) {
  if (childrenOf(el).length > MAX_LEVEL_BOXES) return null;
  const kids = boxChildren(el);
  if (kids.length > MAX_LEVEL_BOXES) return null;
  const out = [];
  for (const c of kids) {
    const s = getComputedStyle(c);
    if (s.display === 'none' || s.display === 'inline' || s.position === 'absolute' || s.position === 'fixed') continue;
    if (!drawn(c) || visuallyHidden(c, s)) continue;
    const r = boxRect(c);
    if (r.width > 1 && r.height > 1) out.push({ el: c, r: boxOf(r) });
  }
  return out;
}

/** Whether `el` shows text a reader sees (text for screen readers only does not count), from its first text nodes. */
function showsText(el) {
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = tw.nextNode(), n = 0; t && n < 100; t = tw.nextNode(), n++) if (t.textContent.trim() && parentOf(t) && drawn(parentOf(t)) && !visuallyHidden(boxed(parentOf(t)))) return true;
  return false;
}

/** Whether text sits directly in `el` (a paragraph, a heading): the walk into a section stops there. */
function holdsText(el) {
  for (const c of CHILD_NODES.call(el)) if (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) return true;
  return false;
}

/**
 * Boxes of one level that sit side by side across the section, grouped into columns: null when they are stacked, or
 * when the boxes beside each other span less than half the section (a row of buttons, a pair of badges);
 * `{ unknown: true }` when rows of them do not line up (two cards over three), which no one column count describes.
 */
function columnsOf(level, width) {
  const rows = [];
  for (const b of [...level].sort((a, c) => a.r.y - c.r.y)) {
    const row = rows.find((r) => {
      const c = crossing(r[0].r, b.r);
      return c.h >= Math.min(r[0].r.height, b.r.height) / 2;
    });
    if (row) row.push(b);
    else rows.push([b]);
  }
  const multi = rows.filter((r) => r.length > 1);
  const beside = multi.flat();
  if (!beside.length) return null;
  const left = Math.min(...beside.map((b) => b.r.x));
  const span = Math.max(...beside.map((b) => b.r.x + b.r.width)) - left;
  if (span < width / 2) return null;
  // Columns by where the fullest row's boxes start, allowing for rounding; a short last row still lines up with them.
  const fullest = multi.reduce((a, r) => (r.length > a.length ? r : a));
  const lanes = [...fullest].sort((a, c) => a.r.x - c.r.x).map((b) => ({ x: b.r.x, boxes: [] }));
  for (const b of beside) {
    const lane = lanes.find((l) => Math.abs(l.x - b.r.x) <= 2);
    if (!lane) return { unknown: true };
    lane.boxes.push(b);
  }
  return { lanes, span, peers: beside };
}

/** Whether boxes are the same kind of thing repeated (cards of a grid), by their tag and classes. */
const alike = (boxes) => boxes.every((b) => b.el.tagName === boxes[0].el.tagName && b.el.className === boxes[0].el.className);

/**
 * The layout that sets a section's columns: walking in from its box through the biggest box of each stacked level,
 * the first level whose boxes sit side by side across the section. A split (two different regions, the side its
 * picture is on, and their proportions), a grid of repeated peers (cards, pictures or a strip of small items), or one
 * column (centred or not). A box nearly as big as the biggest (a second grid under the first) is walked too, and
 * columns it finds that differ make the layout unknown (null), as do rows that do not line up, a level with more
 * boxes than columns have, and running out of time. On the way, each box of the walk that paints its own surface
 * over much of the section is one of its panels, outermost first.
 */
function layoutOf(section, layerOf, deadline) {
  const { area } = section;
  const sectionArea = area.width * area.height;
  const UNKNOWN = {};
  if (section.boxes.length > MAX_LEVEL_BOXES) return null;
  const panels = [];
  let visits = 0;
  // Columns found ({ key, words }), null for none (a column of text), or UNKNOWN.
  const walk = (level, depth, main) => {
    if (depth >= MAX_LAYOUT_DEPTH || ++visits > MAX_LAYOUT_VISITS || Date.now() > deadline) return UNKNOWN;
    const cols = level.length > 1 ? columnsOf(level, area.width) : null;
    if (cols) return cols.unknown ? UNKNOWN : describeColumns(cols);
    const byArea = [...level].sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const big = byArea[0].r.width * byArea[0].r.height;
    let found = null;
    for (const [i, box] of byArea.slice(0, 3).entries()) {
      if (i > 0 && box.r.width * box.r.height < big / 2) break;
      // A panel inside the band (a Call to action's brand box) is part of the section's look.
      if (main && i === 0 && depth > 0 && layerOf(box.el).covers && big >= sectionArea * 0.4) panels.push(surfaceOf(box.el, layerOf));
      const kids = holdsText(box.el) ? [] : flowBoxes(box.el);
      if (kids === null) return UNKNOWN;
      if (!kids.length) continue;
      const got = walk(kids, depth + 1, main && i === 0);
      if (got === UNKNOWN || (got && found && got.key !== found.key)) return UNKNOWN;
      found = found || got;
    }
    return found;
  };
  const got = walk(section.boxes.map((el) => ({ el, r: boxOf(boxRect(el)) })), 0, true);
  if (got === UNKNOWN) return null;
  if (got) return { ...got, panels };
  const heading = section.boxes.map((b) => (b.matches(TEXT_BLOCKS) ? b : b.querySelector(TEXT_BLOCKS))).find(Boolean);
  const centered = !!heading && getComputedStyle(heading).textAlign === 'center';
  return { key: `column:${centered ? 'center' : 'start'}`, words: centered ? 'one centered column' : 'one column', panels };
}

/** What a level of boxes side by side is: its key (equal keys are the same layout) and the words for it. */
function describeColumns({ lanes, span, peers }) {
  const n = lanes.length;
  const shares = lanes.map((l) => Math.round((Math.max(...l.boxes.map((b) => b.r.width)) / span) * 20) * 5);
  const media = (b) => pictureShare(b.el, b.r) >= MEDIA_SHARE;
  // Two columns, one of them a picture: a split, and which side its picture is on. Where the two are wrapped alike, the
  // picture's column holds no text at all (two cards, one with a photo, are still two cards).
  const alikePeers = alike(peers);
  const picture = (b) => media(b) && (!alikePeers || !showsText(b.el));
  const side = n === 2 ? lanes.findIndex((l) => l.boxes.every(picture)) : -1;
  const pictured = side >= 0 && !lanes[1 - side].boxes.every(media);
  if (n === 2 && (pictured || !alikePeers)) {
    const where = pictured ? ` with the picture on the ${side === 0 ? 'left' : 'right'}` : '';
    return { key: `split:${pictured ? (side === 0 ? 'start' : 'end') : 'none'}:${shares.join('/')}`, words: `two columns${where}` };
  }
  const kind = peers.every(media) ? 'pictures' : peers.every((b) => b.r.height < 100 && !b.el.querySelector('p, h1, h2, h3, h4, h5, h6')) ? 'items' : 'cards';
  const even = Math.max(...shares) - Math.min(...shares) <= 5;
  const words = kind === 'items' ? `a row of ${countWord(n)} small items` : `${countWord(n)} ${kind === 'pictures' ? 'picture' : 'card'} columns`;
  return { key: `grid:${kind}:${n}:${even ? 'even' : shares.join('/')}`, words };
}

/**
 * Whether a box can be seen where it is laid out: in the viewport's width, and not scrolled or clipped out of a box
 * around it (on each axis the box clips, inside its padding edge).
 */
function inView(el, r, vw, stop) {
  if (r.right <= 0 || r.left >= vw) return false;
  for (let e = parentOf(el); e && e !== parentOf(stop); e = parentOf(e)) {
    const s = getComputedStyle(e);
    const clipsX = s.overflowX !== 'visible';
    const clipsY = s.overflowY !== 'visible';
    if (!clipsX && !clipsY) continue;
    // Its padding box where it is drawn: a scaled box draws its own sizes scaled.
    // Read through the prototypes: a form's control named "offsetWidth" would hide the form's own.
    const b = boxRect(e);
    const [ow, oh, cl, ct, cw, ch] = METRICS.map((get) => Number(get.call(e)));
    const sx = ow > 0 ? b.width / ow : 1;
    const sy = oh > 0 ? b.height / oh : 1;
    const pad = { x: b.left + cl * sx, y: b.top + ct * sy, width: cw * sx, height: ch * sy };
    const c = crossing(boxOf(r), pad);
    if ((clipsX && c.w <= 1) || (clipsY && c.h <= 1)) return false;
  }
  return true;
}

/**
 * The filled buttons in a section: controls with a name, padded like a button, filled with an opaque colour that
 * stands out from the surface around them, and in view (not on a slide waiting off screen). Links to nowhere, linked
 * cards and pictures, tabs, toggles and menus are left out, as are outlined and text-style buttons.
 */
function filledButtons(section, layerOf, read, budget, vw) {
  let n = 0;
  for (const b of section.boxes) {
    for (const el of [b, ...b.querySelectorAll(CONTROLS)]) {
      if (!el.matches(CONTROLS)) continue;
      if (budget.controls-- <= 0) return n;
      if (el.closest('nav, summary, [role="tablist"], [role="menu"], [role="menubar"], :disabled, [aria-disabled="true"]')) continue;
      // A button that opens a dialog (a booking form) is an action; one that opens a menu or a list is not.
      if (el.matches('[aria-expanded], [aria-haspopup]:not([aria-haspopup="dialog"]), [aria-controls], [aria-pressed], [role="tab"]')) continue;
      if (el.tagName === 'A' && /^#?$/.test((el.getAttribute('href') || '').trim())) continue;
      if (el.querySelector(`${PICTURES}, p, li, h1, h2, h3, h4, h5, h6, figure`)) continue;
      const name = ((el.tagName === 'INPUT' ? el.value : el.textContent) || el.getAttribute('aria-label') || '').trim();
      if (!name || name.length > 60 || !drawn(el)) continue;
      const s = getComputedStyle(el);
      const r = boxRect(el);
      if (visuallyHidden(el, s) || s.display === 'inline' || r.height > BUTTON_MAX_HEIGHT || !inView(el, r, vw, b)) continue;
      if ((parseFloat(s.paddingTop) + parseFloat(s.paddingBottom)) / 2 < 4 || (parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)) / 2 < 8) continue;
      const fill = read(s.backgroundColor);
      const image = backgroundOf(s.backgroundImage, read);
      const around = surfaceOf(parentOf(el), layerOf);
      if (!around) continue;
      // Filled all over (a gradient at every one of its colours) and standing out from the surface around it.
      const stands = (c) => c.a >= BUTTON_MIN_ALPHA && contrastOf(onCanvas(over(pm(c), pm(around))), around) >= BUTTON_MIN_CONTRAST;
      if (image.kind === 'gradient' ? image.stops.every(stands) : image.kind === 'none' && !!fill && stands(fill)) n++;
    }
  }
  return n;
}

/**
 * Notes on the page's rhythm (see the section above), for a page of two or more sections; null when the page cannot
 * be measured in time. At phone width, where sections stack into one column by design, only sections that still set
 * columns side by side compare layouts. Runs are of sections the page lists one after another that also show one
 * after another. Each rule gives at most one note: its longest run, or its largest heading.
 */
function rhythm(vw, page, deadline) {
  const read = colorReader();
  try {
    const found = pageSections(page.pageId, page.rootIds.slice(0, MAX_RHYTHM_SECTIONS), deadline);
    if (!found) return null;
    const { sections, others } = found;
    if (sections.filter((s) => s.boxes.length).length < 2) return null;
    const layerOf = layerCache(read);
    const tone = (a, b) => !!a && !!b && Math.abs(luminance(a) - luminance(b)) <= SAME_LUMINANCE;
    const budget = { controls: MAX_RHYTHM_CONTROLS };
    for (const s of sections) {
      if (Date.now() > deadline) return null;
      if (!s.boxes.length) continue;
      // The surface behind the section: one band, or boxes that all sit on the same one.
      const surfaces = s.boxes.length > MAX_LEVEL_BOXES ? [null] : s.boxes.map((b) => (pictureShare(b, boxOf(boxRect(b))) < 0.5 ? surfaceOf(b, layerOf) : null));
      s.surface = surfaces.every((c) => tone(c, surfaces[0])) ? surfaces[0] : null;
      // At phone width most sections stack into one column by design: only columns still side by side compare.
      s.layout = layoutOf(s, layerOf, deadline);
      if (s.layout && vw < PHONE_MAX_WIDTH && s.layout.key.startsWith('column:')) s.layout = null;
      s.buttons = s.boxes.length > MAX_LEVEL_BOXES ? 0 : filledButtons(s, layerOf, read, budget, vw);
    }
    if (Date.now() > deadline) return null;
    const notes = [];
    // Where each section shows down the page (a page's styles can show them in another order than it lists them),
    // among the page's own markup that is in no section listed.
    [...sections.filter((s) => s.boxes.length), ...others]
      .sort((a, b) => a.area.top - b.area.top || (a.n ?? Infinity) - (b.n ?? Infinity))
      .forEach((s, i) => (s.shown = i));
    // Runs of sections in a row: shown one after another and below each other (not side by side in one band), and
    // unbroken by one that rendered nothing (a page the preview has not caught up with). Below means starting past
    // the middle of the one before: a section pulled up over its neighbour still follows it.
    const next = (prev, s) => !!prev.boxes.length && !!s.boxes.length && s.shown === prev.shown + 1 && s.area.top > prev.area.top + prev.area.height / 2;
    const longest = (same) => {
      let best = null;
      let start = 0;
      for (let i = 1; i <= sections.length; i++) {
        if (i < sections.length && next(sections[i - 1], sections[i]) && same(sections[start], sections[i])) continue;
        if (sections[start].boxes.length && i - start >= RHYTHM_RUN && (!best || i - start > best.length)) best = sections.slice(start, i);
        start = i;
      }
      return best;
    };
    const samePanels = (a, b) => a.length === b.length && a.every((c, i) => tone(c, b[i]));
    const sameLook = (first, s) => !!first.layout && !!s.layout && first.layout.key === s.layout.key && tone(first.surface, s.surface) && samePanels(first.layout.panels, s.layout.panels);
    const repeated = longest((first, s) => sameLook(first, s));
    const ends = (run) => ({ sections: { first: run[0].n, last: run[run.length - 1].n }, desc: run[0].desc, with: { desc: run[run.length - 1].desc } });
    if (repeated) {
      const bg = hexOf(repeated[0].surface);
      notes.push({
        kind: 'repeated-layout',
        ...ends(repeated),
        layout: repeated[0].layout.words,
        background: bg,
        message: `Sections ${repeated[0].n}–${repeated[repeated.length - 1].n} use the same layout (${repeated[0].layout.words}) on the same background (${bg}), ${countWord(repeated.length)} in a row. Change the layout or the background tone of one of them so the page has a rhythm.`
      });
    }
    const crowded = longest((first, s) => first.buttons > 0 && s.buttons > 0);
    if (crowded) {
      const total = crowded.reduce((n, s) => n + s.buttons, 0);
      notes.push({
        kind: 'crowded-actions',
        ...ends(crowded),
        buttons: total,
        message: `Sections ${crowded[0].n}–${crowded[crowded.length - 1].n} each have a filled button (${total} in all), ${countWord(crowded.length)} sections in a row. Keep filled buttons for the page's main actions and give the others a secondary or text style.`
      });
    }
    // Headings: inner headings as large as the page's one h1, which must be in a section it lists (any other h1 shown
    // anywhere makes two). A page with more headings than one inspection measures is left alone.
    if (Date.now() > deadline) return null;
    const seen = (h) => h.textContent.trim() && drawn(h) && !visuallyHidden(h);
    const allH1 = [...document.querySelectorAll('h1')];
    const heads = [];
    for (const s of sections) for (const b of s.boxes) for (const h of [b, ...b.querySelectorAll(HEADINGS)]) if (h.matches(HEADINGS) && heads.length <= MAX_RHYTHM_HEADINGS) heads.push(h);
    const listed = heads.length <= MAX_RHYTHM_HEADINGS && allH1.length <= MAX_RHYTHM_HEADINGS;
    const shown = listed ? heads.filter(seen) : [];
    const h1s = listed && allH1.filter(seen).length === 1 ? shown.filter((h) => h.tagName === 'H1') : [];
    if (h1s.length === 1) {
      const top = parseFloat(getComputedStyle(h1s[0]).fontSize);
      const big = shown.filter((h) => h.tagName !== 'H1').map((h) => ({ h, size: parseFloat(getComputedStyle(h).fontSize) })).filter((x) => x.size >= top - 0.01);
      if (big.length) {
        const worst = big.reduce((a, b) => (b.size > a.size ? b : a));
        const level = worst.h.tagName.toLowerCase();
        const px = (v) => `${Math.round(v * 10) / 10}px`;
        const others = big.length - 1;
        const desc = findingDesc(worst.h);
        const h1Desc = findingDesc(h1s[0]);
        notes.push({
          kind: 'heading-scale',
          ...(desc ? { desc } : {}),
          text: textPreview(worst.h),
          heading: level,
          size: Math.round(worst.size * 10) / 10,
          h1Size: Math.round(top * 10) / 10,
          ...(others ? { others } : {}),
          with: { ...(h1Desc ? { desc: h1Desc } : {}), text: textPreview(h1s[0]) },
          message: `This ${level} is ${px(worst.size)}, ${worst.size > top ? 'larger than' : 'as large as'} the page's h1 (${px(top)})${others ? `, as ${others === 1 ? 'is one other inner heading' : `are ${others} other inner headings`}` : ''}. Make inner headings smaller than the h1 so the page has one clear top level.`
        });
      }
    }
    return notes;
  } catch {
    // Markup the measurement cannot read leaves the rhythm out, never the report.
    return null;
  } finally {
    try {
      read.dispose();
    } catch {
      // A page's own element of the probe's name: the probe is left, never the report.
    }
  }
}

/**
 * Measure the page. Images get until `deadline` to be requested again; the readability checks stop at
 * `readableBy`, so the report always reaches the editor before it stops waiting. `opts.readability` measures a
 * component shown on its own as a page is measured; `opts.gaps` adds the space between stacked elements.
 * `opts.page` ({ pageId, rootIds }) names the page's sections, for the notes on its rhythm. `opts.focus` (element IDs)
 * keeps only the findings on those elements, before the list is capped, so a finding asked about is never cut.
 */
async function inspect(deadline, readableBy = deadline + 1500, opts = {}) {
  // Narrowed to elements the editor names (`opts.targets`, descriptors in the order asked): every element each one
  // finds on the page, and only findings inside those. What belongs to the page as a whole (its width, its h1s, its
  // runtime errors) is still reported.
  let found = Array.isArray(opts.targets) ? opts.targets.map((d) => (d && typeof d === 'object' ? safeFindAll(d) : [])) : null;
  // Images first: one that arrives while they are requested again can still change the layout measured below.
  const images = await imageReport(deadline, found ? scopeOf(found) : null);
  // The elements are found again, and what is inside them worked out again: the page could change (a component
  // re-rendering one of them) while its images loaded.
  if (found) found = opts.targets.map((d) => (d && typeof d === 'object' ? safeFindAll(d) : []));
  const within = found ? scopeOf(found) : null;
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const docWidth = document.documentElement.scrollWidth;
  if (docWidth > vw + 1) issues.push({ kind: 'horizontal-overflow', message: `The page is ${docWidth}px wide in a ${vw}px viewport.` });
  for (const el of document.querySelectorAll('[data-so-node]')) {
    if (within && !within(el)) continue;
    // An element whose own properties are hidden (a form's named controls) is left out rather than losing the report.
    try {
      const r = rectOf(el);
      if (!r) continue;
      if (r.x + r.width > vw + 2 || r.x < -2) {
        const d = descOf(el);
        // Narrowed, once for each element asked for (two items of one list asked for are two findings).
        const tag = scopeTag(el, within);
        if (!issues.some((i) => i.desc && i.desc.ctx === d.ctx && i.desc.node === d.node && String(i.targets) === String(tag.targets)))
          issues.push({ kind: 'element-overflow', desc: d, ...tag, text: textPreview(el), message: `Extends beyond the viewport (${Math.round(r.x)}–${Math.round(r.x + r.width)}px of ${vw}px).` });
      }
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0 && el.children.length === 0)
        issues.push({ kind: 'text-overflow', desc: descOf(el), ...scopeTag(el, within), text: textPreview(el), message: 'Text is wider than its box.' });
    } catch {
      continue;
    }
  }
  const at = (el) => {
    const d = findingDesc(el);
    return { ...(d ? { desc: d } : {}), ...scopeTag(el, within) };
  };
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt') && (!within || within(img))) issues.push({ kind: 'missing-alt', ...at(img), message: `Image ${imagePath(img.getAttribute('src') || '')} has no alt attribute.` });
  // After the layout findings; the image counts in `images` are never capped.
  issues.push(...images.issues);
  const placeholders = [...document.querySelectorAll('.so-img--placeholder')].filter((el) => !within || within(el)).length;
  if (placeholders) issues.push({ kind: 'image-placeholder', message: `${placeholders} image placeholder(s) have no image chosen.` });
  const preview = previewState();
  // A page has one h1; a component shown on its own is not a page.
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1 && !preview) issues.push({ kind: 'heading-structure', message: `The page has ${h1} h1 headings (expected 1).` });
  // An <a> without href is a placeholder (a menu link with nowhere to go yet), not a link to name.
  for (const a of document.querySelectorAll('a[href]')) if ((!within || within(a)) && !a.textContent.trim() && !a.getAttribute('aria-label')) issues.push({ kind: 'empty-link', ...at(a), message: 'A link has no accessible name.' });
  // The readability checks measure pages of the site: a component shown on its own has sample content in a
  // made-up page, with nothing there an edit could address, unless the AI asks for it to check the design itself.
  const readable = preview && !opts.readability ? null : readability(vw, readableBy, within);
  // One list per kind, in the order found, so the cap keeps a finding of every kind.
  const byKind = new Map();
  for (const i of issues) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind).push(i);
  }
  const focus = Array.isArray(opts.focus) ? new Set(opts.focus) : null;
  // An element is on a focused one when it is that element, or inside a focused placement, which its context names.
  const focused = (d) => !!d && (focus.has(d.node) || String(d.ctx || '').split('|').some((id) => focus.has(id)));
  const onFocus = (i) => !!focus && (focused(i?.desc) || focused(i?.with?.desc));
  const lists = [...byKind.values(), ...(readable ? readable.findings : [])].map((l) => (focus ? l.filter(onFocus) : l)).filter((l) => l.length);
  const listed = pickIssues(lists, MAX_ISSUES);
  // Advice on how the sections follow one another, for a page of the site with more than one; a component shown on
  // its own has no page around it.
  // Advice about the whole page, so never for chosen elements.
  const notes = !preview && opts.page && !found ? rhythm(vw, opts.page, readableBy + 500) : null;
  // Which top-level page sections rendered ("page:<id>|<node>"), so the editor can tell a stale page load.
  const sections = new Set();
  for (const el of document.querySelectorAll('[data-so-ctx^="page:"][data-so-node]')) {
    const ctx = el.getAttribute('data-so-ctx');
    sections.add(ctx.includes('|') ? ctx.split('|').slice(0, 2).join('|') : `${ctx}|${el.getAttribute('data-so-node')}`);
  }
  const report = {
    path: shownPath(),
    sections: [...sections].slice(0, 500),
    viewportWidth: vw,
    documentWidth: docWidth,
    documentHeight: document.documentElement.scrollHeight,
    images: images.summary,
    ...(readable ? { checks: readable.checks } : {}),
    issues: listed,
    // How many findings there were in all, listed or not, so a reader knows what the cap left out.
    issueCount: lists.reduce((n, l) => n + l.length, 0),
    ...(notes ? { rhythm: notes } : {}),
    runtimeErrors: errors.slice(-10),
    runtimeErrorCount: errors.length,
    ...(found ? { targets: found.map(targetReport) } : {}),
    ...(preview ? { preview } : {}),
    ...(opts.gaps ? stackReport(readableBy + 500) : {})
  };
  // Advice never costs the report: the editor drops a message longer than it accepts (see the editor's bridge).
  // A page's own scripts can change how objects become text (a throwing toJSON): its length unknown, the notes go.
  try {
    if (report.rhythm && JSON.stringify(report).length > MAX_REPORT_CHARS) delete report.rhythm;
  } catch {
    delete report.rhythm;
  }
  return report;
}

/**
 * Whether a node is one of the elements found or inside one, answered once per node: a page's every element is asked
 * several times, and walking up from it stops at the first node already answered. `roots`: every element found.
 */
const PARENT_NODE = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get;
function scopeOf(found) {
  const roots = found.flat();
  const set = new Set(roots);
  const memo = new Map();
  const within = (el) => {
    const path = [];
    let inside = false;
    // Through the prototype: a form's control named "parentNode" would lead back into the form, round and round.
    for (let e = el; e; e = PARENT_NODE.call(e)) {
      if (memo.has(e)) {
        inside = memo.get(e);
        break;
      }
      path.push(e);
      if (set.has(e)) {
        inside = true;
        break;
      }
    }
    for (const p of path) memo.set(p, inside);
    return inside;
  };
  within.roots = roots;
  within.found = found;
  // The elements around those found (not themselves found), whose boxes can cut off what is inside them.
  within.ancestors = new Set();
  for (const r of roots) for (let e = PARENT_NODE.call(r); e && e.nodeType === 1 && !within.ancestors.has(e); e = PARENT_NODE.call(e)) within.ancestors.add(e);
  return within;
}

/**
 * Narrowed (`within`, see scopeOf), which of the elements asked for (by their place in the request) `el` is in:
 * `{ targets: [i, …] }`, or nothing.
 */
function scopeTag(el, within, also = null) {
  if (!within || !el) return {};
  const targets = [];
  const of = also ? [el, also] : [el];
  within.found.forEach((els, i) => {
    if (els.some((r) => of.some((e) => r === e || Node.prototype.contains.call(r, e)))) targets.push(i);
  });
  return targets.length ? { targets } : {};
}

/** Every text node under each of `sources`, in order. */
function* textsUnder(sources) {
  for (const src of sources) {
    const tw = document.createTreeWalker(src, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) yield t;
  }
}

/** The elements a descriptor finds, or none when it cannot be looked up (a malformed part or slot name). */
function safeFindAll(desc) {
  try {
    return findAll(desc);
  } catch {
    return [];
  }
}

/** How many of one element's occurrences (repeated items, a part shown twice) a narrowed report measures. */
const MAX_TARGET_ELEMENTS = 10;

/**
 * What a narrowed inspection says about one element asked for: each place it rendered, with the box it fills (in
 * CSS pixels from the top left of the page, null when it lays out no box), the size of its content (scrollWidth and
 * scrollHeight) and whether it shows at this width. One that rendered nowhere has no elements and does not show.
 */
const SCROLL_WIDTH = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth').get;
const SCROLL_HEIGHT = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight').get;
function targetReport(els) {
  // Whether it shows: a box with area, drawn (a wrapper that makes no box of its own, a code component's, through what it holds).
  const shows = (el, r) => !!r && r.width > 0 && r.height > 0 && (getComputedStyle(el).display === 'contents' ? [...childrenOf(el)].some((c) => drawn(c)) : drawn(el));
  const elements = els.slice(0, MAX_TARGET_ELEMENTS).map((el) => {
    try {
      const r = rectOf(el);
      const box = r ? { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) } : null;
      const contents = getComputedStyle(el).display === 'contents';
      const visible = shows(el, r);
      // Through the prototype: a form's control named "scrollWidth" would hide the form's own.
      return { box, scrollWidth: contents ? (box ? box.width : 0) : SCROLL_WIDTH.call(el), scrollHeight: contents ? (box ? box.height : 0) : SCROLL_HEIGHT.call(el), visible };
    } catch {
      // Not measured: never read as an element that does not show (the editor fails the check).
      return { box: null, scrollWidth: 0, scrollHeight: 0, visible: false, measured: false };
    }
  });
  // Whether it shows anywhere, the occurrences not listed included.
  const showsAt = (el) => {
    try {
      return shows(el, rectOf(el));
    } catch {
      return false;
    }
  };
  const visible = elements.some((e) => e.visible) || els.slice(MAX_TARGET_ELEMENTS).some(showsAt);
  return { visible, elements, ...(els.length > MAX_TARGET_ELEMENTS ? { omittedElements: els.length - MAX_TARGET_ELEMENTS } : {}) };
}

/** The stacked gaps for a report, and whether they stop short. */
function stackReport(deadline) {
  const { gaps, incomplete } = stackGaps(deadline);
  return { gaps, ...(incomplete ? { gapsIncomplete: true } : {}) };
}

// ---------------------------------------------------------------------------
// A hover, focus or pressed state shown on the selected element
// ---------------------------------------------------------------------------

/**
 * The state the Inspector is editing, shown on the selected element (`{ state, desc, part }`), or null. The page's own
 * stylesheets are rewritten in place so that an element marked with FORCE_ATTR matches `:hover`, `:focus`,
 * `:focus-visible` or `:active` rules as if it were in that state, keeping each rule's order, layer and media query.
 * Nothing of this reaches the exported site: the bridge and its marks live only in the editor's preview.
 */
let forced = null;
/** The elements marked now. */
const forcedEls = new Set();
const FORCE_ATTR = 'data-so-force-state';
const FORCE_STATES = ['hover', 'focus', 'active', 'groupHover', 'groupFocus'];
/**
 * The pseudo-classes a mark stands in for. `:focus-within` stands for an interaction group with focus inside it (its
 * own mark, `within`), so showing an element focused never shows the groups around it as holding focus.
 */
const FORCE_PSEUDO = /(?<!\\):(hover|focus-visible|focus-within|focus|active)(?![\w-])/g;
const FORCE_OF = { hover: 'hover', 'focus-visible': 'focus', 'focus-within': 'within', focus: 'focus', active: 'active' };
/**
 * A group state is shown on the interaction groups around the selected element (`.so-group`), not on it: each is
 * marked hovered, or as holding focus, as a real pointer or focus inside the nearest one would make it and every
 * group around that one, up to a modal dialog, over the page, beyond which nothing counts as hovered.
 */
const GROUP_MARK = { groupHover: 'hover', groupFocus: 'within' };

/**
 * A selector whose interactive pseudo-classes an element marked as in that state also matches, or null when it has
 * none, or is already rewritten. `:is()` takes the weight of its heaviest argument, so the rule keeps its weight.
 */
function forcedSelector(sel) {
  if (!sel || sel.includes(FORCE_ATTR)) return null;
  let found = false;
  // Quoted attribute values (`[title=":hover"]`) are text, never a state, and stay as they are.
  const out = sel
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(FORCE_PSEUDO, (m, p) => {
            found = true;
            return `:is(${m}, [${FORCE_ATTR}="${FORCE_OF[p]}"])`;
          })
    )
    .join('');
  return found ? out : null;
}
function forceRules(rules) {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      const next = forcedSelector(rule.selectorText);
      // A selector the browser cannot take (a state after a pseudo-element) is ignored, leaving the rule as it was.
      if (next) rule.selectorText = next;
    }
    // Rules inside @media, @supports, @layer, or nested in a rule.
    if (rule.cssRules) forceRules(rule.cssRules);
  }
}
/** One stylesheet rewritten for forced states. One from another origin (a web font's), or still loading, is not readable. */
function forceSheet(sheet) {
  let rules;
  try {
    rules = sheet && sheet.cssRules;
  } catch {
    return;
  }
  if (rules) forceRules(rules);
}
/** Every stylesheet of the page, those a script adopted included, rewritten for forced states. */
function forceSheets() {
  for (const sheet of document.styleSheets) forceSheet(sheet);
  for (const sheet of document.adoptedStyleSheets || []) forceSheet(sheet);
}
/**
 * The elements to show in the state: the selection's own, or the part of it being styled. A code component's part is
 * found as a picked one is, by its author's marker or the class the editor's preview gives it (`so-part--title`),
 * from the start, so it shows in a state before it has any change of its own. A code component's wrapper lays
 * nothing out, so its own root stands in for it. A card wrapped in an action's link shows focus and pressing through
 * the link, so the link is marked too.
 */
function forcedTargets() {
  if (!forced) return [];
  const out = [];
  const group = Object.hasOwn(GROUP_MARK, forced.state);
  for (const el of findAll(forced.part ? { ...forced.desc, part: forced.part } : forced.desc)) {
    const own = !forced.part && el.hasAttribute('data-so-code') ? [...el.children].filter((c) => c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT') : [el];
    for (const t of own) {
      if (group) {
        // A dialog over the page is the top of what can be hovered: nothing around it is.
        if (isModal(t)) continue;
        for (let a = t.parentElement; a; a = a.parentElement) {
          if (a.classList.contains('so-group')) out.push(a);
          if (isModal(a)) break;
        }
        continue;
      }
      out.push(t);
      if (t.parentElement && t.parentElement.classList.contains('so-action')) out.push(t.parentElement);
    }
  }
  return out;
}
/** Whether an element is a modal dialog shown over the page (an engine without `:modal` has none). */
function isModal(el) {
  try {
    return el.matches(':modal');
  } catch {
    return false;
  }
}
/** Marks the elements to show in the state, and unmarks any that no longer are (re-rendered, or another selection). */
function markForced() {
  const want = new Set(forcedTargets());
  for (const el of forcedEls) if (!want.has(el)) el.removeAttribute(FORCE_ATTR);
  // A copy of a marked element the page made (re-rendering it, say) is no longer what is shown in the state.
  for (const el of document.querySelectorAll(`[${FORCE_ATTR}]`)) if (!want.has(el)) el.removeAttribute(FORCE_ATTR);
  forcedEls.clear();
  if (!forced) return;
  const mark = Object.hasOwn(GROUP_MARK, forced.state) ? GROUP_MARK[forced.state] : forced.state;
  for (const el of want) {
    if (el.getAttribute(FORCE_ATTR) !== mark) el.setAttribute(FORCE_ATTR, mark);
    forcedEls.add(el);
  }
}
/**
 * A stylesheet arriving or changing (Vite replaces a <style>'s text, or adds one) is rewritten before it is painted:
 * that one alone, so a style the page keeps changing (a drag's preview) costs one sheet each time.
 */
const sheetWatch = new MutationObserver((records) => {
  if (!forced) return;
  const isSheet = (n) => !!n && (n.nodeName === 'STYLE' || (n.nodeName === 'LINK' && /\bstylesheet\b/i.test(n.rel || '')));
  const owners = new Set();
  for (const r of records) {
    const at = r.target.nodeType === 1 ? r.target : r.target.parentNode;
    if (isSheet(at)) owners.add(at);
    for (const n of r.addedNodes) {
      if (isSheet(n)) owners.add(n);
      else if (n.nodeType === 1) for (const inner of n.querySelectorAll('style, link')) if (isSheet(inner)) owners.add(inner);
    }
  }
  for (const n of owners) forceSheet(n.sheet);
  // A sheet a script adopts is not in the document: checked again with any change (each one is rewritten once).
  if (owners.size && document.adoptedStyleSheets && document.adoptedStyleSheets.length) for (const sheet of document.adoptedStyleSheets) forceSheet(sheet);
});
// A linked stylesheet is readable once it has loaded.
document.addEventListener(
  'load',
  (e) => {
    if (forced && e.target instanceof HTMLLinkElement) forceSheet(e.target.sheet);
  },
  true
);
function setForced(next) {
  forced = next;
  if (forced) {
    forceSheets();
    sheetWatch.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } else sheetWatch.disconnect();
  markForced();
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
      // Preview shows the page as it is saved, where the visitor scrolls it.
      if (mode === 'preview') {
        clearSpacing();
        stopShowing();
      }
      // A double-click from before the change starts nothing after it.
      pendingHit = null;
      if (editing) commitEdit();
      document.documentElement.toggleAttribute('data-so-editing', mode === 'edit');
      // The mode this document took from the editor: its page is hydrated, the bridge is listening and it shows what
      // the editor asked for, in Edit and Preview alike (data-so-editing alone cannot tell a page previewed as visitors
      // see it from one still loading). The editor sends it to every page that reports ready. The test driver reads it.
      document.documentElement.setAttribute('data-so-bridge', mode);
      // A full-size image a visitor opened in Preview is a modal: it would cover the page being edited.
      if (mode === 'edit') for (const viewer of document.querySelectorAll('dialog.so-viewer[open]')) viewer.close();
      // Preview shows the page as visitors find it: nothing held in a state.
      if (mode === 'preview' && forced) setForced(null);
      hovered = null;
      pointerAt = null;
      pointerEl = null;
      // Preview shows the disclosures as visitors find them; editing reveals the item again.
      reconcileReveal();
      applyOverlaysShown();
      scheduleRects();
      break;
    case 'track': {
      const was = { selected, hovered, slots: trackedSlots };
      selected = m.payload.selected || null;
      // The author selected something else meanwhile: the element asked for is no longer the one to show.
      if (pendingScroll && !sameDesc(pendingScroll.desc, selected)) pendingScroll = null;
      if (shownHold && !sameDesc(shownHold.desc, selected)) shownHold = null;
      if (m.payload.hovered !== undefined) hovered = m.payload.hovered;
      trackedSlots = Array.isArray(m.payload.slots) ? m.payload.slots.filter((d) => d && typeof d.slot === 'string').slice(0, 50) : [];
      rectsPosted = '';
      // Only what is hovered changed, and the next frame has nothing to do before it measures (a reveal to put in place, a
      // scroll the editor asked for, the selection held in view): measured at once too, so the editor draws the hover's
      // outline in its next frame, not the one after, and it keeps up with the pointer. The next frame measures again
      // either way, after what the page itself does in it (a component moving what the pointer reached), and reports
      // only what that changed.
      const hoverOnly = !sameDesc(was.hovered, hovered) && sameDesc(was.selected, selected) && was.slots.length === trackedSlots.length && was.slots.every((d, i) => sameDesc(d, trackedSlots[i]));
      if (hoverOnly && !revealDirty && !revealPlace && !pendingScroll && !shownHold && !keepHold) sendRects();
      scheduleRects();
      break;
    }
    case 'emptySpace':
      // Said of a page this frame has since left: the editor says it again for the page shown.
      if (leftBehind(m)) break;
      setEmptySpace(m.payload.space);
      scheduleRects();
      break;
    case 'scrollTo': {
      // Asked about a page this frame has since left: the editor asks again once it knows the page that is here.
      if (leftBehind(m)) break;
      // A newer request replaces one still waiting. One for an element the page does not show yet (just inserted, its
      // hot update still on the way) waits for it while editing, and one about a change the page does not have yet (a
      // section moved, still in its old place here) waits for that change's revision.
      const desc = m.payload.desc;
      const show = !!m.payload.show;
      const after = Number.isSafeInteger(m.payload.revision) ? m.payload.revision : 0;
      stopShowing();
      const wanted = mode === 'edit' && desc && typeof desc.ctx === 'string' && typeof desc.node === 'string';
      if (wanted && after > revision) pendingScroll = { desc, show, until: performance.now() + REVISION_WAIT_MS, after };
      else if (!scrollToDesc(desc, show) && wanted) pendingScroll = { desc, show, until: performance.now() + SCROLL_WAIT_MS, after: 0 };
      break;
    }
    case 'navigate': {
      const path = String(m.payload.path || '/');
      if (!path.startsWith('/') || path.startsWith('//')) return;
      // The editor's request, answered once the page is there: only its latest request's answer counts there, so
      // a page reported on the way (or a visitor's link the request overtook) never switches it back.
      const id = Number.isSafeInteger(m.payload.navId) ? m.payload.navId : null;
      navRequest = id;
      stopShowing();
      askedFor(path);
      try {
        const nav = await import('$app/navigation');
        await nav.goto(path);
      } catch {
        // A request the editor has since replaced loads no page of its own.
        if (navRequest === id) location.assign(path);
        break;
      }
      // Shown in place: no load of it is on its way.
      try {
        sessionStorage.removeItem(ASKED_KEY);
      } catch {
        // Nothing was kept.
      }
      if (navRequest !== id) break;
      navRequest = null;
      if (id !== null) send('navigated', { path: shownPath(), navId: id });
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
      beginTextEdit(m.payload.desc, m.payload.editId, m.payload.hit);
      break;
    case 'linkChecked':
      linkChecked(m.payload);
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
        else if (c && editing?.el === c.el && editing.original === c.left) {
          // Edited again before the answer came, from the text that was not kept: with nothing typed yet the saved
          // text comes back, to edit from; anything typed since is the new edit's, and Escape goes back to the saved text.
          editing.original = c.original;
          if (c.el.innerHTML === c.left) {
            c.el.innerHTML = c.original;
            if (!editing.rich) editing.before = c.el.innerText.replace(/\s+/g, ' ').trim();
            const range = document.createRange();
            range.selectNodeContents(c.el);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          }
        } else if (c) {
          // A later edit of the element began from this text: what that one puts back is what was saved before.
          for (const later of committed.values()) if (later !== c && later.el === c.el && later.original === c.left) later.original = c.original;
        }
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
    case 'scrollBy': {
      // A drag from the editor's Insert panel turns the wheel over the page into a scroll of the page, which counts as
      // the author's own scrolling (see the wheel listener): nothing waiting scrolls the page back afterwards.
      const y = Number(m.payload.y);
      // A wheel turned over a page this frame has since left scrolls nothing here.
      if (!Number.isFinite(y) || !y || leftBehind(m)) break;
      stopKeeping();
      stopShowing();
      if (revealScroll) revealScroll = false;
      window.scrollBy({ top: Math.max(-4000, Math.min(4000, y)), behavior: 'instant' });
      if (selected) scheduleRects();
      break;
    }
    case 'measure': {
      // Asked of a page this frame has since left: answered as unmeasured, so the editor never takes this page's
      // boxes for that one's, and nothing waits on an answer.
      if (leftBehind(m)) {
        send('measured', { requestId: m.payload.requestId, unmeasured: true });
        break;
      }
      const descs = Array.isArray(m.payload.descs) ? m.payload.descs.slice(0, 200) : [];
      // Each box with its CSS order, which can lay siblings out in another order than the document's (and whether its
      // container orders its items at all), and whether more than one copy of it shows (content a component repeats):
      // the box is only the first copy's.
      send('measured', { requestId: m.payload.requestId, rects: descs.map((d) => {
        const all = findAll(d);
        // Measured where it first shows: a copy hidden at this width (one a component shows only on phones) is
        // skipped, so content a component shows in one place at a time is found where it is.
        const boxes = all.map(rectOf);
        const first = boxes.findIndex(Boolean);
        if (first < 0) return null;
        const el = all[first];
        const r = boxes[first];
        const shown = boxes.filter(Boolean).length;
        const laid = layoutItem(el);
        const own = ownOrder(laid.item);
        const out = { ...r, order: laid.ordered ? own : 0 };
        if (laid.ordered) out.ordered = true;
        if (own !== out.order) out.cssOrder = own;
        if (shown > 1) out.many = true;
        return out;
      }) });
      break;
    }
    // What is at a point of the page while the editor drags something over it (the frame takes no pointer then): the
    // editor's elements there, innermost first, and the innermost one's box; and when the point is on a picture, its
    // box, the file it shows, and whether it is the only picture (SoImage's) the code component around it draws
    // itself. The page's scroll says whether boxes measured earlier still hold.
    case 'pointAt': {
      if (leftBehind(m)) {
        send('pointed', { requestId: m.payload.requestId, unmeasured: true });
        break;
      }
      const x = Number(m.payload.x);
      const y = Number(m.payload.y);
      const hit = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
      const el = hit ? innermost(hit) : null;
      const pic = hit && hit.closest('.so-img, img, picture');
      let picture = null;
      if (pic) {
        const img = pic.tagName === 'IMG' ? pic : pic.querySelector('img');
        const own = el && el.hasAttribute('data-so-code') ? [...el.querySelectorAll('.so-img')].filter((p) => innermost(p) === el) : [];
        // An address longer than any library file's (an inline picture) is cut short: it names no file either way.
        picture = { rect: rectOf(pic), src: ((img && img.getAttribute('src')) || '').slice(0, 1000), own: own.length === 1 && own[0] === pic };
      }
      send('pointed', { requestId: m.payload.requestId, chain: hit ? chainFrom(hit) : [], rect: el ? rectOf(el) : null, picture, scroll: [window.scrollX, window.scrollY] });
      break;
    }
    case 'measureSpace': {
      if (leftBehind(m)) {
        send('spaceMeasured', { requestId: m.payload.requestId, unmeasured: true });
        break;
      }
      const vars = Array.isArray(m.payload.vars) ? m.payload.vars.slice(0, 500) : [];
      send('spaceMeasured', { requestId: m.payload.requestId, px: measureSpace(vars, m.payload.desc, m.payload.basis) });
      break;
    }
    // A spacing drag: shown while it moves, handed to the saved change after it, or put back.
    case 'spacingPreview': {
      const drag = String(m.payload.drag || '');
      const p = spacingShown.get(drag);
      if (m.payload.clear) clearSpacing(drag);
      else if (Number.isSafeInteger(m.payload.handoff)) {
        if (p) {
          p.until = m.payload.handoff;
          p.deadline = Date.now() + 8000;
          settleSpacing(drag);
        }
      } else showSpacing(drag, m.payload.desc, m.payload.decls, m.payload.media);
      break;
    }
    case 'inspect': {
      // This frame is measured and never scrolled: a classic scrollbar would take its width from the viewport.
      document.documentElement.style.scrollbarWidth = 'none';
      // Measure only once web fonts and images have settled: both change line wrapping and widths. Images that
      // still show nothing then get their own, shorter, deadline to be requested again. The editor waits 8s for
      // the answer from its first message: what settling and images leave of 7s goes to the readability checks.
      const started = Date.now();
      let report;
      try {
        // A frame the editor sized for this measurement (a component shown on its own) is measured at that width.
        await atWidth(m.payload.width, started + 2500);
        await settled(started + 4000);
        // The page's sections, as the editor lists them, when it asks for the notes on their rhythm.
        const ids = Array.isArray(m.payload.rootIds) ? m.payload.rootIds.filter((id) => typeof id === 'string') : null;
        const page = typeof m.payload.pageId === 'string' && ids ? { pageId: m.payload.pageId, rootIds: ids } : null;
        // Elements asked for by the editor (inspect_layout with refs), as descriptors in the order asked.
        const targets = Array.isArray(m.payload.targets) ? m.payload.targets.slice(0, 20) : undefined;
        // Element IDs whose findings alone are listed (validate_project narrowed to them).
        const focus = Array.isArray(m.payload.focus) ? m.payload.focus.filter((id) => typeof id === 'string') : undefined;
        report = await inspect(Math.min(Date.now() + 2500, started + 6000), started + 7000, { readability: m.payload.readability === true, gaps: m.payload.gaps === true, page, ...(targets ? { targets } : {}), ...(focus ? { focus } : {}) });
      } catch (err) {
        // A failed measurement is answered as one, never left for the editor to time out on.
        report = { error: `The page could not be measured: ${String((err && err.message) || err).slice(0, 200)}` };
      }
      send('inspectResult', { requestId: m.payload.requestId, report });
      break;
    }
    case 'revision':
      revision = m.payload.revision;
      break;
    // The state the Inspector edits, shown on the selected element; a state of null clears it.
    case 'forceState': {
      const p = m.payload || {};
      const next = mode === 'edit' && FORCE_STATES.includes(p.state) && p.desc ? { state: p.state, desc: p.desc, part: typeof p.part === 'string' && p.part ? p.part : null } : null;
      setForced(next);
      break;
    }
    // The reply practice sends get from now on.
    case 'formPractice':
      practiceResult = m.payload.result === 'error' ? 'error' : 'success';
      break;
    case 'formLiveTest':
      liveTestForm(String(m.payload.id || ''), String(m.payload.target || ''), String(m.payload.requestId || ''));
      break;
  }
});

// Captured, so a box scrolling inside the page (a carousel's list) moves the outlines of what is in it too, while
// there are any to move.
window.addEventListener(
  'scroll',
  (e) => {
    if (e.target === document || selected || reveal || (hovered && mode === 'edit')) scheduleRects();
  },
  { passive: true, capture: true }
);
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
// The page changing size can show the item being revealed at last (its section no longer hidden): where it is is
// checked again, and nothing else, so a disclosure the page closed meanwhile stays closed.
new ResizeObserver(() => {
  if (reveal) revealPlace = true;
  scheduleRects();
}).observe(document.documentElement);
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
  // A dialog the author shows in place, rendered afresh, shows again before the frame is drawn.
  if (overlaysShown.size) applyOverlaysShown();
  // Outlines are measured again only while there is one to keep in place, or an element a scroll waits for. With
  // nothing selected, hovered while editing or revealed, the editor already has none, so a change to the page is
  // neither measured nor reported.
  if (revealDirty || selected || pendingScroll || emptySpace || (hovered && mode === 'edit')) scheduleRects();
  // The element held in a state was re-rendered (an update arrived): the new one is marked before it is painted.
  if (forced) markForced();
}).observe(document.body, { childList: true, subtree: true, characterData: true });
/**
 * A page error, with where it came from so the editor can name the component that threw (#738): the stack, the
 * file it was thrown in, and the change the page had been told of when it happened.
 */
function reportError(message, stack, file, build = false) {
  send('runtimeError', {
    message,
    ...(typeof stack === 'string' && stack ? { stack: stack.slice(0, 4000) } : {}),
    ...(typeof file === 'string' && file ? { file: file.slice(0, 500) } : {}),
    ...(build ? { build: true } : {}),
    revision
  });
}
window.addEventListener('error', (e) => {
  errors.push(String(e.message));
  reportError(String(e.message), e.error && e.error.stack, e.filename);
});
window.addEventListener('unhandledrejection', (e) => {
  errors.push(String(e.reason));
  reportError(String(e.reason), e.reason && e.reason.stack);
});

function reportNav() {
  nextNavigation();
  // Another page's room is not this one's: the editor asks again for the page it shows. A jump within the page keeps it.
  if (emptySpace && emptySpace.path !== shownPath()) setEmptySpace(null);
  stopKeeping();
  stopShowing();
  send('navigated', { path: shownPath() });
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
  // As the page has it, its path spelled as the project's routes are (an address in another script reads as written,
  // and is shorter than escaped). A very long query gives way before the #fragment does.
  const hash = location.hash.slice(0, 300);
  let address = shownPath() + location.search;
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
  // Sent once the batch's own update has been applied (src/runtime/publication-gate.ts), and acknowledged as this
  // revision even when a later one arrives before the page has painted it.
  import.meta.hot.on('siteorigin:revision', (data) => {
    const applied = data.revision;
    const batch = data.batch;
    revision = applied;
    // The selection's boxes and spacing are reported again before the revision is acknowledged: an update of styles
    // alone changes no element the page watches, and the editor's handles go on what was reported last.
    scheduleRects();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        settleDrafts();
        send('revisionApplied', { revision: applied });
        // The preview server waits for this before the editor replaces the files of the next save.
        import.meta.hot.send('siteorigin:applied', { revision: applied, batch });
      })
    );
  });
  // A build error: an update the editor waits on is not coming (the editor's picks stop waiting for it).
  import.meta.hot.on('vite:error', (data) => {
    const err = data?.err;
    reportError(err?.message || 'Build error', err?.stack, err?.loc?.file || err?.id, true);
  });
}

const style = document.createElement('style');
// A button with no destination is left out of the site: Edit shows it flagged so it can be fixed, Preview leaves it
// out as visitors will see the page. A note only for the author (a video section with no video yet) is the same.
// A placement's styles for a code component are important, so hiding takes the weight of an id no element has.
style.textContent =
  'html[data-so-editing] a, html[data-so-editing] summary, html[data-so-editing] button { cursor: default; } html[data-so-editing] [contenteditable] { cursor: text; }' +
  ' html:not([data-so-editing]) :is([data-so-unlinked], [data-so-editor-only]):not(#so-editor) { display: none !important; }' +
  // A blog feed that lists nothing is left off the website (the theme's base styles); Edit shows it, to be changed.
  " html[data-so-editing] :is([class$='-blog-grid__root'], [class*='-blog-grid__root '], [class$='-blog-list__root'], [class*='-blog-list__root ']):not(:has(li)):not(#so-editor)," +
  " html[data-so-editing] :is([class$='-blog-featured__root'], [class*='-blog-featured__root ']):not(:has([class$='__card'], [class*='__card '])):not(#so-editor) { display: block; }" +
  ' html[data-so-editing] [data-so-unlinked] { cursor: default; box-shadow: none; opacity: 0.6; outline: 2px dashed #d97706; outline-offset: 2px; }' +
  // An empty slot, where the author can put content: a labelled drop area, never part of the site, on a light
  // ground of its own so its words read on a dark section too.
  ' html[data-so-editing] [data-so-slot-empty] { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; box-sizing: border-box; min-height: 72px; padding: 12px 16px; border: 2px dashed rgba(100, 116, 139, 0.55); border-radius: 8px; background: #f8fafc; color: #475569; font: 13px/1.35 system-ui, -apple-system, sans-serif; text-align: center; }' +
  ' html[data-so-editing] [data-so-slot-empty] strong { font-weight: 600; } html[data-so-editing] [data-so-slot-empty] span { opacity: 0.8; }' +
  // An empty list of images (a Gallery or Carousel with none chosen yet): the same box, where the images will go, on a
  // light ground of its own so its words read on a dark section too.
  ' html[data-so-editing] [data-so-list-empty] { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; box-sizing: border-box; min-height: 160px; padding: 16px; border: 2px dashed rgba(100, 116, 139, 0.55); border-radius: 8px; background: #f8fafc; color: #475569; font: 14px/1.4 system-ui, -apple-system, sans-serif; text-align: center; }' +
  ' html[data-so-editing] [data-so-list-empty] strong { font-weight: 600; } html[data-so-editing] [data-so-list-empty] span { max-width: 46ch; opacity: 0.8; }' +
  // An empty container (a Grid, Row or Stack with nothing in it yet): a dashed frame naming its kind, tall enough to
  // see and pick, with a grid's columns ruled in its gaps where its items will go. The label spans every column, so
  // even columns that fit as many as they can are all there. In the container's own colours, so it shows on a dark
  // section too. Preview leaves the container as visitors get it: with nothing in it, often no height at all.
  ' html[data-so-editing] [data-so-empty-layout] { outline: 1px dashed color-mix(in srgb, currentColor 55%, transparent); outline-offset: -1px; column-rule: 1px dashed color-mix(in srgb, currentColor 50%, transparent); column-rule-break: none; }' +
  ' html[data-so-editing] [data-so-empty-layout]::before { content: attr(data-so-empty-layout) / ""; display: block; grid-column: 1 / -1; flex: 1 1 auto; align-self: stretch; box-sizing: border-box; min-block-size: 72px; min-inline-size: 0; padding: 6px 10px; color: color-mix(in srgb, currentColor 80%, transparent); font: 600 12px/1.35 system-ui, -apple-system, sans-serif; letter-spacing: normal; text-align: start; text-transform: none; }' +
  // Edit shows every section as designed: an entrance the site's observer armed (it arms nothing in Edit) never hides one.
  ' html[data-so-editing] [data-appear-state]:not(#so-editor) { animation: none !important; }' +
  // A component's dialog or drawer in Edit: hidden in its place until the author shows it with the button beside it,
  // then framed, so it reads as content visitors see over the page.
  ' html[data-so-editing] [data-so-overlay]:not([data-so-peek]):not([data-so-overlay-open]):not(#so-editor) { display: none !important; }' +
  ' html[data-so-editing] [data-so-overlay]:is([data-so-peek], [data-so-overlay-open]) { outline: 2px dashed rgba(100, 116, 139, 0.6); outline-offset: 3px; }' +
  ' html[data-so-editing] .so-overlay-peek { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; margin: 4px 0; padding: 6px 10px; border: 1px dashed rgba(100, 116, 139, 0.7); border-radius: 6px; background: #f8fafc; color: #334155; font: 600 12px/1.35 system-ui, -apple-system, sans-serif; letter-spacing: normal; text-align: start; text-transform: none; cursor: pointer; }' +
  ' html[data-so-editing] .so-overlay-peek::after { content: "Show to edit"; margin-inline-start: auto; font-weight: 500; opacity: 0.75; }' +
  ' html[data-so-editing] .so-overlay-peek[aria-expanded="true"]::after { content: "Hide"; }';
document.head.appendChild(style);
document.documentElement.toggleAttribute('data-so-editing', true);
const previewAtStart = previewState();
// An isolated component preview opened on its own, with no editor frame around it: the editor photographs it for
// the thumbnails in Insert (src/main/thumb-capture.ts). It shows as visitors see it, and offers one call that waits
// for its fonts and images, then measures it.
if (parentWin === window && previewAtStart) {
  mode = 'preview';
  document.documentElement.toggleAttribute('data-so-editing', false);
  window.__siteoriginThumb = async () => {
    await settled(Date.now() + 4000);
    // Whether everything in view had arrived: a picture taken with a font or image still on its way is not kept.
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    const loaded = [...document.images].every((i) => i.complete || !inView(i)) && (!document.fonts || document.fonts.status === 'loaded');
    return { ...previewState(), ink: inkBounds(), loaded };
  };
}

/**
 * Where the component paints something to see, so its thumbnail frames that rather than the empty width of a block:
 * its text, its media and controls, and every box with a background, a border or a shadow (or a generated ::before or
 * ::after that paints, counted as its element's box), each cut to what the boxes around it let show. Null when it
 * paints nothing, or when it is too large to look through (the thumbnail then frames its whole box).
 */
function inkBounds() {
  const main = document.getElementById('main');
  if (!main) return null;
  const MEDIA = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'picture', 'object', 'embed', 'input', 'select', 'textarea', 'button']);
  const clear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
  const painted = (cs) =>
    !clear(cs.backgroundColor) ||
    cs.backgroundImage !== 'none' ||
    cs.boxShadow !== 'none' ||
    ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && !clear(cs[`border${s}Color`]));
  const generated = (el, which) => {
    const ps = getComputedStyle(el, which);
    const content = ps.content;
    // Text it adds (not "", a clearfix's), an image, or a box it paints.
    return !!content && content !== 'none' && content !== 'normal' && ps.display !== 'none' && (painted(ps) || /^(["'])(?!\1$)/.test(content) || /url\(/.test(content));
  };
  /** `r` cut to `clip` (null: nothing cuts it), as { x, y, right, bottom }, or null when nothing of it is left. */
  const cut = (r, clip) => {
    const out = { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
    if (clip) Object.assign(out, { x: Math.max(out.x, clip.x), y: Math.max(out.y, clip.y), right: Math.min(out.right, clip.right), bottom: Math.min(out.bottom, clip.bottom) });
    return out.right - out.x >= 1 && out.bottom - out.y >= 1 ? out : null;
  };
  let box = null;
  let left = 5000;
  const add = (r, clip) => {
    const c = r && cut(r, clip);
    if (!c) return;
    if (!box) box = c;
    else Object.assign(box, { x: Math.min(box.x, c.x), y: Math.min(box.y, c.y), right: Math.max(box.right, c.right), bottom: Math.max(box.bottom, c.bottom) });
  };
  const visit = (el, shown, clip) => {
    for (const child of el.childNodes) {
      if (--left < 0) return;
      if (child.nodeType === Node.TEXT_NODE) {
        if (!shown || !child.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        add(range.getBoundingClientRect(), clip);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const cs = getComputedStyle(child);
        if (cs.display === 'none' || cs.opacity === '0') continue;
        const visible = cs.visibility !== 'hidden';
        const r = child.getBoundingClientRect();
        // A fixed box is cut only by the viewport, whatever holds it.
        const own = cs.position === 'fixed' ? null : clip;
        if (visible && (MEDIA.has(child.localName) || painted(cs) || generated(child, '::before') || generated(child, '::after'))) add(r, own);
        if (MEDIA.has(child.localName)) continue;
        // What overflows a box that clips is not seen.
        const clips = (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') && r.width + r.height > 0;
        visit(child, visible, clips ? cut(r, own) ?? { x: 0, y: 0, right: 0, bottom: 0 } : own);
      }
    }
  };
  visit(main, true, null);
  if (left < 0) return null;
  return box && { x: box.x, y: box.y, width: box.right - box.x, height: box.bottom - box.y };
}
if (!reloadMissingPage()) send('ready', { path: shownPath(), title: document.title, ...(previewAtStart ? { preview: previewAtStart } : {}) });
reportHistory();
reportTextFocus();
reportForms();
