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
    if (mode !== 'edit' || (linkEditor && e.target === linkEditor.host)) return;
    // A right-click in the text being edited is for that text: the app's writing menu (spelling, cut, copy,
    // paste) opens for the word under the pointer, and the selection stays where it is.
    if (editing && editing.el.contains(e.target)) return;
    e.preventDefault();
    send('contextmenu', { chain: chainFrom(e.target), x: e.clientX, y: e.clientY });
  },
  true
);
document.addEventListener('submit', (e) => mode === 'edit' && e.preventDefault(), true);
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
  const rich = el.classList.contains('so-rich');
  // selectedAll: the whole text is still selected as the edit began (until a key or a press inside it).
  editing = { el, desc, editId, original: el.innerHTML, rich, selectedAll: true };
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
function commitEdit() {
  if (!editing) return;
  const { el, desc, editId, rich, original } = editing;
  // Nothing changed: end the edit without a commit, so no history entry or rebuild follows.
  if (el.innerHTML === original) {
    endEdit();
    return send('textCancel', { desc, editId });
  }
  // Rich text goes back as a small copy of its structure (blocks, lists, breaks, marks, links) for the editor
  // to turn into its stored form; plain text as its words.
  const payload = rich ? { desc, editId, rich: richCopy(el) } : { desc, editId, text: el.innerText.replace(/\s+/g, ' ').trim() };
  // Too much to send or to keep: put the text back and say why, rather than lose the edit on the way.
  if ((rich && !payload.rich) || (!rich && payload.text.length > MAX_TEXT_CHARS) || JSON.stringify(payload).length > MAX_COMMIT_CHARS) {
    el.innerHTML = original;
    endEdit();
    return send('textCancel', { desc, editId, reason: 'too-large' });
  }
  endEdit();
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
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1) issues.push({ kind: 'heading-structure', message: `The page has ${h1} h1 headings (expected 1).` });
  for (const a of document.querySelectorAll('a')) if (!a.textContent.trim() && !a.getAttribute('aria-label')) issues.push({ kind: 'empty-link', message: 'A link has no accessible name.' });
  // Which top-level page sections rendered ("page:<id>|<node>"), so the editor can tell a stale page load.
  const sections = new Set();
  for (const el of document.querySelectorAll('[data-so-ctx^="page:"][data-so-node]')) {
    const ctx = el.getAttribute('data-so-ctx');
    sections.add(ctx.includes('|') ? ctx.split('|').slice(0, 2).join('|') : `${ctx}|${el.getAttribute('data-so-node')}`);
  }
  return { path: location.pathname, sections: [...sections].slice(0, 500), viewportWidth: vw, documentWidth: docWidth, documentHeight: document.documentElement.scrollHeight, images: images.summary, issues: issues.slice(0, 40), runtimeErrors: errors.slice(-10) };
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
    // The editor is saving, or leaving the project: hand back the text being edited, as leaving it would. A
    // link still being typed is left out, as moving focus away does (a link already there keeps its address),
    // and the editor is told so it can say.
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
// A button with no destination is left out of the site: Edit shows it flagged so it can be fixed, Preview leaves it
// out as visitors will see the page.
style.textContent =
  'html[data-so-editing] a, html[data-so-editing] summary, html[data-so-editing] button { cursor: default; } html[data-so-editing] [contenteditable] { cursor: text; }' +
  ' html:not([data-so-editing]) [data-so-unlinked] { display: none !important; }' +
  ' html[data-so-editing] [data-so-unlinked] { cursor: default; box-shadow: none; opacity: 0.6; outline: 2px dashed #d97706; outline-offset: 2px; }';
document.head.appendChild(style);
document.documentElement.toggleAttribute('data-so-editing', true);
send('ready', { path: location.pathname, title: document.title });
reportTextFocus();
