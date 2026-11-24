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
/** The CSS order the page lays an element out by among its siblings: only a flex or grid container orders its
 *  items. An element with display: contents is laid out as its first child that shows. */
function layoutOrder(el) {
  const shows = (c) => {
    const position = getComputedStyle(c).position;
    if (position === 'absolute' || position === 'fixed') return false;
    const r = c.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const item = getComputedStyle(el).display === 'contents' ? [...el.children].find(shows) || el : el;
  let parent = item.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  if (!parent || !/(^|-)(flex|grid)$/.test(getComputedStyle(parent).display)) return 0;
  const order = Number.parseInt(getComputedStyle(item).order, 10);
  return Number.isSafeInteger(order) ? order : 0;
}
function rectOf(el) {
  // Through the prototype: a form's control named "getBoundingClientRect" would hide the form's own.
  let r = Element.prototype.getBoundingClientRect.call(el);
  if (getComputedStyle(el).display === 'contents') {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const c of Object.getOwnPropertyDescriptor(Element.prototype, 'children').get.call(el)) {
      const cr = Element.prototype.getBoundingClientRect.call(c);
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
    else if (revealPlace) placeReveal();
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
  // The padding, border and margin of the first selected box the editor outlines, for its spacing handles, with
  // what it measured so a report from before a new selection is never taken for it.
  const first = selBoxes.findIndex(Boolean);
  const box = mode === 'edit' && first >= 0 ? spacingOf(selEls[first]) : null;
  const spacing = box && { ...box, ctx: selected.ctx, node: selected.node, items: selected.items || '' };
  send('rects', { selected: sel, hovered: hov, hoveredDesc: hovered, revealed: rev, spacing, viewport: { width: innerWidth, height: innerHeight, scrollY } });
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

/**
 * Each spacing site style's size as padding on the dragged box, in CSS pixels, or null where it has none. Measured
 * on a probe outside the page's body (so its layout and observers never see it), in the box's font, so lengths in
 * em, ch or lh come out as they would on the box. A percentage is taken of the page's width.
 */
function measureSpace(vars, desc) {
  const el = desc && typeof desc.ctx === 'string' && typeof desc.node === 'string' ? findAll(desc)[0] : null;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;margin:0;border:0;visibility:hidden;pointer-events:none;';
  if (el) {
    const s = getComputedStyle(el);
    probe.style.font = s.font;
    probe.style.lineHeight = s.lineHeight;
  }
  document.documentElement.appendChild(probe);
  try {
    return vars.map((v) => {
      if (typeof v !== 'string' || !/^--so-[a-zA-Z0-9-]+$/.test(v)) return null;
      probe.style.paddingTop = `var(${v})`;
      const px = Number.parseFloat(getComputedStyle(probe).paddingTop);
      return Number.isFinite(px) ? px : null;
    });
  } finally {
    probe.remove();
  }
}

/**
 * The drags being shown, by drag: each one rule giving the dragged element(s) the dragged value until the page's
 * own stylesheet shows the saved change. { el (a <style>), desc, props, text, still, until, deadline, raf }
 */
const spacingShown = new Map();
const SPACING_PROPS = new Set(['padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end', 'margin-block-start', 'margin-block-end']);
const SPACING_VALUE = /^(var\(--so-[a-zA-Z0-9-]+\)|-?\d+(\.\d+)?px|0)$/;
const SPACING_MEDIA = /^\((min|max)-width: \d+(\.\d+)?px\)( and \((min|max)-width: \d+(\.\d+)?px\))?$/;

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
  const list = Array.isArray(decls) ? decls.filter((d) => Array.isArray(d) && SPACING_PROPS.has(d[0]) && typeof d[1] === 'string' && SPACING_VALUE.test(d[1])) : [];
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
      return p.props.map((k) => Number.parseFloat(s.getPropertyValue(k)) || 0);
    });
    const shown = read();
    p.el.textContent = p.still;
    const own = read();
    if (own.every((v, i) => Math.abs(v - shown[i]) < 0.5)) return clearSpacing(drag);
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
  // The list item open in the inspector is brought into view by its own reveal.
  if (performance.now() > k.until || mode !== 'edit' || editing || reveal || !sameDesc(k.desc, selected)) {
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
  placeReveal(roots);
}
/**
 * Where the item is: scrolled to while that is still to be done, and brought back into its sideways list when that
 * list was rendered afresh, the item moved inside it, or the list only now scrolls (shown at last). Only geometry,
 * so it can run whenever the page changes size without touching its disclosures or typed text.
 */
function placeReveal(roots = revealRoots()) {
  revealPlace = false;
  if (revealScroll) {
    const el = roots.find((r) => r.tagName !== 'HR' && rectOf(r));
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
    const el = roots.find((r) => r.tagName !== 'HR' && rectOf(r));
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
    if (ownUi(e.target)) return;
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
    pendingHit = { id: String(++hitCount), target: new WeakRef(e.target), at: textAt(e.clientX, e.clientY) };
    send('dblclick', { chain: chainFrom(e.target), hit: pendingHit.id });
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
    // The link field takes focus from a press. A press on the toolbar keeps it in the text, where its command acts.
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
  const same = (n, beside) => n && n.nodeType === 1 && n.tagName === 'A' && n.getAttribute('href') === anchor.getAttribute('href') && n.getAttribute('target') === anchor.getAttribute('target') && marks(n) !== marks(beside);
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
  closeLinkEditor(true);
  document.execCommand('createLink', false, href);
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

/**
 * Copied HTML as markup the rich text can hold, or '' when it holds no words. It is read in one pass, in reading
 * order, as lines: each block (a paragraph, heading, quote or list item) is a line of its own, a block inside a list item, quote or heading is another line of that kind, and the items
 * of a list inside a list join the outer one, as the rich text holds them. Every element written is a new one:
 * only these blocks, bold, italic, line breaks, and a link's address and new tab.
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
      } else delete inner.href;
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
      const same = last && last.nodeType === Node.ELEMENT_NODE && last.tagName === tag && (tag !== 'A' || (last.getAttribute('href') === m.href && last.hasAttribute('target') === !!m.newTab));
      if (same) host = last;
      else {
        const w = document.createElement(tag);
        if (tag === 'A') {
          w.setAttribute('href', m.href);
          if (m.newTab) w.setAttribute('target', '_blank');
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
          const d = findingDesc(img);
          issues.push({ kind: 'broken-image', ...(d ? { desc: d } : {}), message: `Image ${path} failed to load.` });
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

/**
 * What a computed background-image paints: 'none'; the colours one gradient passes through; 'picture' when an image
 * decides it (url(), image-set()); 'layers' for several images over each other; 'unknown' for a colour that cannot
 * be read. All but 'none' and 'gradient' only pixels could tell.
 */
function backgroundOf(image, read) {
  if (!image || image === 'none') return { kind: 'none' };
  if (/url\(|image-set\(|element\(|cross-fade\(|paint\(/i.test(image)) return { kind: 'picture' };
  const layers = topLevel(image);
  if (layers.length > 1) return { kind: 'layers' };
  const m = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/is.exec(layers[0] || '');
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
  if (!el.getClientRects().length) return false;
  if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
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
function findingList(kind, worse) {
  const byKey = new Map();
  return {
    kind,
    add(el, measured, message, extra) {
      const desc = findingDesc(el);
      const key = desc ? `${desc.ctx}\u0000${desc.node}\u0000${desc.inside ? 1 : 0}` : `?${byKey.size}`;
      const found = byKey.get(key);
      if (found) {
        found.count++;
        if (worse && worse(measured, found.measured)) Object.assign(found, { desc, measured, message, extra, text: textPreview(el) });
        return;
      }
      byKey.set(key, { desc, count: 1, measured, message, extra, text: textPreview(el) });
    },
    list() {
      return [...byKey.values()].map((f) => ({
        kind,
        ...(f.desc ? { desc: f.desc } : {}),
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
      layer = { bg: read(s.backgroundColor) || NONE, image: backgroundOf(s.backgroundImage, read), opacity: clamp(Number(s.opacity), 0, 1), overlays: [] };
      // A background painted only inside the content box (or only on the glyphs) does not cover what is under the box.
      layer.covers = layer.bg.a >= 1 && /^(border-box|padding-box)$/.test(s.backgroundClip || 'border-box');
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
  const options = layers.map((l, i) => (l.image.kind === 'gradient' && shows(i) ? l.image.stops : [NONE]));
  // More combinations than are worth working through: a definite answer could miss the one that fails.
  if (options.reduce((n, o) => n * o.length, 1) > MAX_COMBINATIONS) return { unknown: 'gradient' };
  const results = [];
  const picks = [];
  const paint = (withText) => {
    let p = withText ? pm(fill) : NONE;
    for (let i = layers.length - 1; i >= 0; i--) {
      p = over(p, over(pm(picks[i]), pm(layers[i].bg)));
      if (layers[i].opacity < 1) p = fade(p, layers[i].opacity);
    }
    return onCanvas(p);
  };
  const walk = (i) => {
    if (i === layers.length) {
      const bg = paint(false);
      const fg = paint(true);
      results.push({ ratio: contrastOf(fg, bg), fg, bg });
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
  if (results.length > 1) {
    const failing = results.filter((r) => r.ratio < required).length;
    // A gradient that is readable at some of its colours and not at others may or may not fail under the text: only
    // its pixels could say.
    if (failing && failing < results.length) return { unknown: 'gradient' };
  }
  return { ratio: worst.ratio, required, fg: hexOf(worst.fg), bg: hexOf(worst.bg), gradient: results.length > 1 };
}

const UNKNOWN_CONTRAST = {
  image: 'it is shown over an image, whose colours only pixels could tell',
  overlay: 'a decorative layer (a ::before or ::after) lies over its background',
  gradient: 'its gradient background is readable at some points and not at others',
  layers: 'its background is several images or gradients over each other',
  fill: 'its text is painted with a background or an image',
  color: 'its colour could not be read'
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
function readability(vw, deadline) {
  const read = colorReader();
  const count = () => ({ checked: 0, failed: 0, unverified: 0 });
  const checks = { contrast: count(), overlaps: count(), clippedText: count(), tapTargets: count() };
  if (vw >= PHONE_MAX_WIDTH) checks.tapTargets.skipped = `Tap targets are checked below ${PHONE_MAX_WIDTH}px (phone widths).`;
  const lowContrast = findingList('low-contrast', (a, b) => a.ratio < b.ratio);
  const unknownContrast = findingList('contrast-unverified');
  const clipped = findingList('clipped-text');
  const overlaps = findingList('overlap', (a, b) => a.overlap.width * a.overlap.height > b.overlap.width * b.overlap.height);
  const small = findingList('small-tap-target', (a, b) => a.size.width * a.size.height < b.size.width * b.size.height);
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
      if (!el || seen.has(el) || !t.textContent.trim()) continue;
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
    for (const el of document.querySelectorAll('body *')) {
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
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = tw.nextNode(); t && !cut; t = tw.nextNode()) {
          if (++n > MAX_CLIP_TEXT_NODES) {
            checks.clippedText.incomplete = true;
            break;
          }
          const holder = parentOf(t);
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
          { cutText: textPreview(cut.holder) }
        );
      });
      if (!going) break;
    }
    // Overlapping boxes: block-level siblings in the normal flow whose boxes cross by more than rounding. (Inline
    // siblings flow as text: their outer rectangles cross without their lines doing so.)
    const parents = new Set();
    for (const el of document.querySelectorAll('[data-so-node]')) {
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
      const all = (boxes.length * (boxes.length - 1)) / 2;
      boxes.sort((a, b) => a.rect.y - b.rect.y);
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        for (let j = i + 1; j < boxes.length && boxes[j].rect.y < a.rect.y + a.rect.height; j++) {
          if (++pairs > MAX_PAIRS) {
            checks.overlaps.incomplete = true;
            checks.overlaps.checked += compared;
            break overlap;
          }
          compared++;
          const b = boxes[j];
          const c = crossing(a.rect, b.rect);
          if (c.w <= 2 || c.h <= 2) continue;
          const going = each(checks.overlaps, () => {
            const other = findingDesc(b.el);
            overlaps.add(a.el, { overlap: { width: Math.round(c.w), height: Math.round(c.h) } }, `Overlaps a neighbouring box by ${Math.round(c.w)}×${Math.round(c.h)}px.`, { with: { ...(other ? { desc: other } : {}), text: textPreview(b.el) } });
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
        const going = each(checks.tapTargets, () => {
          if (!drawn(el) || el.closest(':disabled, [aria-disabled="true"]')) return;
          const s = getComputedStyle(el);
          if (visuallyHidden(el, s) || inSentence(el, s)) return;
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

/**
 * Measure the page. Images get until `deadline` to be requested again; the readability checks stop at
 * `readableBy`, so the report always reaches the editor before it stops waiting.
 */
async function inspect(deadline, readableBy = deadline + 1500) {
  // Images first: one that arrives while they are requested again can still change the layout measured below.
  const images = await imageReport(deadline);
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const docWidth = document.documentElement.scrollWidth;
  if (docWidth > vw + 1) issues.push({ kind: 'horizontal-overflow', message: `The page is ${docWidth}px wide in a ${vw}px viewport.` });
  for (const el of document.querySelectorAll('[data-so-node]')) {
    // An element whose own properties are hidden (a form's named controls) is left out rather than losing the report.
    try {
      const r = rectOf(el);
      if (!r) continue;
      if (r.x + r.width > vw + 2 || r.x < -2) {
        const d = descOf(el);
        if (!issues.some((i) => i.desc && i.desc.ctx === d.ctx && i.desc.node === d.node))
          issues.push({ kind: 'element-overflow', desc: d, text: textPreview(el), message: `Extends beyond the viewport (${Math.round(r.x)}–${Math.round(r.x + r.width)}px of ${vw}px).` });
      }
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0 && el.children.length === 0)
        issues.push({ kind: 'text-overflow', desc: descOf(el), text: textPreview(el), message: 'Text is wider than its box.' });
    } catch {
      continue;
    }
  }
  const at = (el) => {
    const d = findingDesc(el);
    return d ? { desc: d } : {};
  };
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) issues.push({ kind: 'missing-alt', ...at(img), message: `Image ${imagePath(img.getAttribute('src') || '')} has no alt attribute.` });
  // After the layout findings; the image counts in `images` are never capped.
  issues.push(...images.issues);
  const placeholders = document.querySelectorAll('.so-img--placeholder').length;
  if (placeholders) issues.push({ kind: 'image-placeholder', message: `${placeholders} image placeholder(s) have no image chosen.` });
  const preview = previewState();
  // A page has one h1; a component shown on its own is not a page.
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1 && !preview) issues.push({ kind: 'heading-structure', message: `The page has ${h1} h1 headings (expected 1).` });
  for (const a of document.querySelectorAll('a')) if (!a.textContent.trim() && !a.getAttribute('aria-label')) issues.push({ kind: 'empty-link', ...at(a), message: 'A link has no accessible name.' });
  // The readability checks measure pages of the site: a component shown on its own has sample content in a
  // made-up page, with nothing there an edit could address.
  const readable = preview ? null : readability(vw, readableBy);
  // One list per kind, in the order found, so the cap keeps a finding of every kind.
  const byKind = new Map();
  for (const i of issues) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind).push(i);
  }
  const listed = pickIssues([...byKind.values(), ...(readable ? readable.findings : [])], MAX_ISSUES);
  // Which top-level page sections rendered ("page:<id>|<node>"), so the editor can tell a stale page load.
  const sections = new Set();
  for (const el of document.querySelectorAll('[data-so-ctx^="page:"][data-so-node]')) {
    const ctx = el.getAttribute('data-so-ctx');
    sections.add(ctx.includes('|') ? ctx.split('|').slice(0, 2).join('|') : `${ctx}|${el.getAttribute('data-so-node')}`);
  }
  return {
    path: location.pathname,
    sections: [...sections].slice(0, 500),
    viewportWidth: vw,
    documentWidth: docWidth,
    documentHeight: document.documentElement.scrollHeight,
    images: images.summary,
    ...(readable ? { checks: readable.checks } : {}),
    issues: listed,
    runtimeErrors: errors.slice(-10),
    ...(preview ? { preview } : {})
  };
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
      // Preview shows the page as it is saved.
      if (mode === 'preview') clearSpacing();
      // A double-click from before the change starts nothing after it.
      pendingHit = null;
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
      // The editor's request, answered once the page is there: only its latest request's answer counts there, so
      // a page reported on the way (or a visitor's link the request overtook) never switches it back.
      const id = Number.isSafeInteger(m.payload.navId) ? m.payload.navId : null;
      navRequest = id;
      try {
        const nav = await import('$app/navigation');
        await nav.goto(path);
      } catch {
        // A request the editor has since replaced loads no page of its own.
        if (navRequest === id) location.assign(path);
        break;
      }
      if (navRequest !== id) break;
      navRequest = null;
      if (id !== null) send('navigated', { path: location.pathname, navId: id });
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
    case 'measure': {
      const descs = Array.isArray(m.payload.descs) ? m.payload.descs.slice(0, 200) : [];
      // Each box with its CSS order, which can lay siblings out in another order than the document's.
      send('measured', { requestId: m.payload.requestId, rects: descs.map((d) => { const el = findAll(d)[0]; const r = el && rectOf(el); return r ? { ...r, order: layoutOrder(el) } : null; }) });
      break;
    }
    case 'measureSpace': {
      const vars = Array.isArray(m.payload.vars) ? m.payload.vars.slice(0, 500) : [];
      send('spaceMeasured', { requestId: m.payload.requestId, px: measureSpace(vars, m.payload.desc) });
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
        await settled(started + 4000);
        report = await inspect(Math.min(Date.now() + 2500, started + 6000), started + 7000);
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
  ' html[data-so-editing] [data-so-unlinked] { cursor: default; box-shadow: none; opacity: 0.6; outline: 2px dashed #d97706; outline-offset: 2px; }' +
  // An empty slot, where the author can put content: a labelled drop area, never part of the site.
  ' html[data-so-editing] [data-so-slot-empty] { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; box-sizing: border-box; min-height: 72px; padding: 12px 16px; border: 2px dashed rgba(100, 116, 139, 0.55); border-radius: 8px; background: rgba(148, 163, 184, 0.08); color: #475569; font: 13px/1.35 system-ui, -apple-system, sans-serif; text-align: center; }' +
  ' html[data-so-editing] [data-so-slot-empty] strong { font-weight: 600; } html[data-so-editing] [data-so-slot-empty] span { opacity: 0.8; }' +
  // Edit shows every section as designed: an entrance the site's observer armed (it arms nothing in Edit) never hides one.
  ' html[data-so-editing] [data-appear-state]:not(#so-editor) { animation: none !important; }';
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
send('ready', { path: location.pathname, title: document.title, ...(previewAtStart ? { preview: previewAtStart } : {}) });
reportHistory();
reportTextFocus();
reportForms();
