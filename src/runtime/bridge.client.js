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
let editing = null; // { el, desc, editId, original, rich }
/** Larger commits than this would be dropped by the editor's message size check. */
const MAX_COMMIT_CHARS = 150000;
const errors = [];

function send(type, payload = {}) {
  if (!sessionId || parentWin === window) return;
  parentWin.postMessage({ protocolVersion: PROTOCOL, sessionId, navigationId: location.pathname, revision, type, payload }, '*');
}

function descOf(el) {
  return { ctx: el.getAttribute('data-so-ctx') || '', node: el.getAttribute('data-so-node') || '', items: el.getAttribute('data-so-items') || '' };
}
function chainFrom(target) {
  const chain = [];
  let el = target instanceof Element ? target : target?.parentElement;
  while (el && el !== document.documentElement) {
    if (el.hasAttribute('data-so-node')) chain.push({ ...descOf(el), tag: el.tagName.toLowerCase(), text: textPreview(el), code: el.hasAttribute('data-so-code') });
    el = el.parentElement;
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
    sendRects();
  });
}
function sendRects() {
  const sel = selected ? findAll(selected).map(rectOf).filter(Boolean) : [];
  const hov = hovered && mode === 'edit' ? findAll(hovered).slice(0, 1).map(rectOf).filter(Boolean) : [];
  send('rects', { selected: sel, hovered: hov, hoveredDesc: hovered, viewport: { width: innerWidth, height: innerHeight, scrollY } });
}

// ---------------------------------------------------------------------------
// Edit-mode interaction
// ---------------------------------------------------------------------------

document.addEventListener(
  'mousemove',
  (e) => {
    if (mode !== 'edit' || editing) return;
    const chain = chainFrom(e.target);
    const next = chain[0] ? { ctx: chain[0].ctx, node: chain[0].node, items: chain[0].items } : null;
    // Report what is under the pointer; the editor decides what that hover means (what a click would
    // select) and sends it back with `track`, which is what gets outlined.
    if (JSON.stringify(next) !== JSON.stringify(pointerAt)) {
      pointerAt = next;
      send('hover', { chain });
    }
  },
  true
);
document.documentElement.addEventListener('mouseleave', () => {
  pointerAt = null;
  hovered = null;
  send('hover', { chain: [] });
  scheduleRects();
});

document.addEventListener(
  'click',
  (e) => {
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
    if (mode !== 'edit') return;
    e.preventDefault();
    send('contextmenu', { chain: chainFrom(e.target), x: e.clientX, y: e.clientY });
  },
  true
);
document.addEventListener('submit', (e) => mode === 'edit' && e.preventDefault(), true);
for (const t of ['pointerdown', 'mousedown', 'touchstart']) {
  document.addEventListener(t, (e) => {
    if (mode === 'edit' && !(editing && editing.el.contains(e.target))) e.preventDefault();
  }, { capture: true, passive: false });
}
document.addEventListener('keydown', (e) => {
  if (editing) return;
  if (mode !== 'edit') return;
  // Forward editor shortcuts so they work while the preview has focus.
  if (e.metaKey || e.ctrlKey || e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
    if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      send('key', { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    }
  }
}, true);

// ---------------------------------------------------------------------------
// Inline text editing
// ---------------------------------------------------------------------------

function beginTextEdit(desc, editId) {
  const el = findAll(desc)[0];
  // The editor is waiting for this edit to end: tell it there is nothing to edit.
  if (!el) return send('textCancel', { desc, editId });
  if (editing) commitEdit();
  const rich = el.classList.contains('so-rich');
  editing = { el, desc, editId, original: el.innerHTML, rich };
  // Rich text keeps its bold and italic (⌘B, ⌘I); everything else is plain text.
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
  if (editing) commitEdit();
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
  editing = null;
  getSelection()?.removeAllRanges();
}
function commitEdit() {
  if (!editing) return;
  const { el, desc, editId, rich, original } = editing;
  // Nothing changed: end the edit without a commit, so no history entry or rebuild follows.
  if (el.innerHTML === original) {
    endEdit();
    return send('textCancel', { desc, editId });
  }
  // Rich text goes back as a small copy of its structure (blocks, breaks, bold, italic) for the editor to
  // turn into paragraphs; plain text as its words.
  const payload = rich ? { desc, editId, rich: richCopy(el) } : { desc, editId, text: el.innerText.replace(/\s+/g, ' ').trim() };
  // Too much to send: put the text back and say why, rather than lose the message (and the edit) on the way.
  if (JSON.stringify(payload).length > MAX_COMMIT_CHARS) {
    el.innerHTML = original;
    endEdit();
    return send('textCancel', { desc, editId, reason: 'too-large' });
  }
  endEdit();
  send('textCommit', payload);
}
/** Text, element names and inline bold/italic of what an edit left, as plain data; null when too large. */
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
  el.innerHTML = original;
  endEdit();
  send('textCancel', { desc, editId });
}

// ---------------------------------------------------------------------------
// Layout inspection (no screenshots; structural and geometric evidence only)
// ---------------------------------------------------------------------------

/** Resolves when fonts are ready and images have loaded (or failed), or after `ms` at the latest. */
function settled(ms) {
  // The inspection frame is never scrolled, so lazy images would otherwise never start loading.
  for (const img of document.images) if (img.loading === 'lazy') img.loading = 'eager';
  const fonts = document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve();
  const images = Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })));
  const frames = new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return Promise.race([Promise.all([fonts, images]).then(() => frames), new Promise((r) => setTimeout(r, ms))]);
}

function inspect() {
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
  for (const img of document.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) issues.push({ kind: 'missing-alt', message: `Image ${img.getAttribute('src')} has no alt attribute.` });
    if (img.complete && img.naturalWidth === 0) issues.push({ kind: 'broken-image', message: `Image ${img.getAttribute('src')} failed to load.` });
  }
  const placeholders = document.querySelectorAll('.so-img--placeholder').length;
  if (placeholders) issues.push({ kind: 'image-placeholder', message: `${placeholders} image placeholder(s) have no image chosen.` });
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1) issues.push({ kind: 'heading-structure', message: `The page has ${h1} h1 headings (expected 1).` });
  for (const a of document.querySelectorAll('a')) if (!a.textContent.trim() && !a.getAttribute('aria-label')) issues.push({ kind: 'empty-link', message: 'A link has no accessible name.' });
  // Which top-level page sections rendered ("page:<id>|<node>"), so the editor can tell a stale page load.
  const sections = new Set();
  for (const el of document.querySelectorAll('[data-so-ctx^="page:"][data-so-node]')) {
    const ctx = el.getAttribute('data-so-ctx');
    sections.add(ctx.includes('|') ? ctx.split('|').slice(0, 2).join('|') : `${ctx}|${el.getAttribute('data-so-node')}`);
  }
  return { path: location.pathname, sections: [...sections].slice(0, 500), viewportWidth: vw, documentWidth: docWidth, documentHeight: document.documentElement.scrollHeight, issues: issues.slice(0, 40), runtimeErrors: errors.slice(-10) };
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
      if (editing) commitEdit();
      document.documentElement.toggleAttribute('data-so-editing', mode === 'edit');
      hovered = null;
      pointerAt = null;
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
        const target = getComputedStyle(el).display === 'contents' ? el.firstElementChild || el : el;
        const r = target.getBoundingClientRect();
        if (r.top < 60 || r.bottom > innerHeight - 20) target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
    case 'beginTextEdit':
      beginTextEdit(m.payload.desc, m.payload.editId);
      break;
    case 'measure': {
      const descs = Array.isArray(m.payload.descs) ? m.payload.descs.slice(0, 200) : [];
      send('measured', { requestId: m.payload.requestId, rects: descs.map((d) => { const el = findAll(d)[0]; return el ? rectOf(el) : null; }) });
      break;
    }
    case 'inspect':
      // Measure only once web fonts and images have settled: both change line wrapping and widths.
      await settled(4000);
      send('inspectResult', { requestId: m.payload.requestId, report: inspect() });
      break;
    case 'revision':
      revision = m.payload.revision;
      break;
  }
});

window.addEventListener('scroll', scheduleRects, { passive: true });
window.addEventListener('resize', scheduleRects);
new ResizeObserver(scheduleRects).observe(document.documentElement);
new MutationObserver(() => {
  // The page re-rendered the element being edited away (an update arrived): the edit is over.
  if (editing && !editing.el.isConnected) {
    const { desc, editId } = editing;
    endEdit();
    send('textCancel', { desc, editId });
  }
  scheduleRects();
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
  send('navigated', { path: location.pathname });
  scheduleRects();
}
window.addEventListener('siteorigin:navigated', reportNav);
window.addEventListener('popstate', reportNav);

if (import.meta.hot) {
  import.meta.hot.on('siteorigin:revision', (data) => {
    revision = data.revision;
    requestAnimationFrame(() => requestAnimationFrame(() => send('revisionApplied', { revision })));
  });
  import.meta.hot.on('vite:error', (data) => send('runtimeError', { message: data?.err?.message || 'Build error' }));
}

const style = document.createElement('style');
style.textContent = 'html[data-so-editing] a, html[data-so-editing] summary, html[data-so-editing] button { cursor: default; } html[data-so-editing] [contenteditable] { cursor: text; }';
document.head.appendChild(style);
document.documentElement.toggleAttribute('data-so-editing', true);
send('ready', { path: location.pathname, title: document.title });
