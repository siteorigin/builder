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
let editing = null; // { el, desc, original }
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
    if (JSON.stringify(next) !== JSON.stringify(hovered)) {
      hovered = next;
      send('hover', { chain });
      scheduleRects();
    }
  },
  true
);
document.addEventListener('mouseleave', () => {
  hovered = null;
  scheduleRects();
});

document.addEventListener(
  'click',
  (e) => {
    if (editing && editing.el.contains(e.target)) return;
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

function beginTextEdit(desc) {
  const el = findAll(desc)[0];
  if (!el) return;
  const rich = el.classList.contains('so-rich');
  editing = { el, desc, original: el.innerHTML, rich };
  el.setAttribute('contenteditable', 'plaintext-only');
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
  send('textEditStarted', { desc });
}
function onEditKey(e) {
  e.stopPropagation();
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
function endEdit() {
  const { el } = editing;
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  el.style.outline = '';
  el.style.cursor = '';
  el.removeEventListener('keydown', onEditKey);
  el.removeEventListener('blur', onEditBlur);
  el.removeEventListener('input', scheduleRects);
  editing = null;
  getSelection()?.removeAllRanges();
}
function commitEdit() {
  if (!editing) return;
  const { el, desc, rich } = editing;
  const text = rich ? el.innerText.replace(/\r/g, '').split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean) : el.innerText.replace(/\s+/g, ' ').trim();
  endEdit();
  send('textCommit', { desc, text });
}
function cancelEdit() {
  if (!editing) return;
  const { el, original, desc } = editing;
  el.innerHTML = original;
  endEdit();
  send('textCancel', { desc });
}

// ---------------------------------------------------------------------------
// Layout inspection (no screenshots; structural and geometric evidence only)
// ---------------------------------------------------------------------------

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
  return { viewportWidth: vw, documentWidth: docWidth, documentHeight: document.documentElement.scrollHeight, issues: issues.slice(0, 40), runtimeErrors: errors.slice(-10) };
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
      beginTextEdit(m.payload.desc);
      break;
    case 'measure': {
      const descs = Array.isArray(m.payload.descs) ? m.payload.descs.slice(0, 200) : [];
      send('measured', { requestId: m.payload.requestId, rects: descs.map((d) => { const el = findAll(d)[0]; return el ? rectOf(el) : null; }) });
      break;
    }
    case 'inspect':
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
new MutationObserver(scheduleRects).observe(document.body, { childList: true, subtree: true, characterData: true });
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
