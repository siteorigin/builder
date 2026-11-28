/**
 * The Posts writer's editable text, to and from a post's stored text. The writer shows an article as the site will:
 * paragraphs, section headings (h2 to h4), quotes, lists and pictures with their captions, with links kept as their
 * destinations (a page by its address, a post as `entry:` and its ID). Pictures are single blocks the text flows
 * around: they are chosen and described in a dialog, never typed into.
 */
import type { LinkValue, ProjectState, RichBlock, RichImageBlock, RichListBlock, RichSpan, RichText, RichTextBlock } from '@shared/types';
import { isImageBlock, isListBlock, isRichBlock, linkToTarget } from '@shared/richtext';
import { linkRels, relsFromAttribute } from '@shared/link-rel';
import { blocksFromDom, type ArticleRead, type RichDomNode } from './richtext';
import { collectionIndexRoutes } from '@shared/archives';
import { entryRoute } from '@shared/collections';
import { MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS } from '@engine/values';
import { articleLinks, KEPT_LINK } from './article-links';
import { assetUrl } from './model';

/** The class a check list carries, as the site's own lists do. */
const CHECK_CLASS = 'so-rich--check';

/** Where a link the writer shows goes, as its href. */
export const linkHref = (link: LinkValue, state: ProjectState) => linkToTarget(link, state.pages);

function appendText(parent: Node, text: string) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i) parent.appendChild(document.createElement('br'));
    if (line) parent.appendChild(document.createTextNode(line));
  });
}

function keepLink(a: HTMLElement, link: LinkValue, href: string) {
  a.dataset.link = JSON.stringify(link);
  a.dataset.href = href;
}

function appendSpans(parent: HTMLElement, spans: RichSpan[], state: ProjectState) {
  for (const s of spans) {
    let host: HTMLElement = parent;
    if (s.link) {
      const a = document.createElement('a');
      const href = linkHref(s.link, state);
      a.setAttribute('href', href);
      keepLink(a, s.link, href);
      if (s.link.newTab) a.setAttribute('target', '_blank');
      const rels = linkRels(s.link);
      if (rels.length) a.setAttribute('rel', rels.join(' '));
      host.appendChild(a);
      host = a;
    }
    if (s.strong) host = host.appendChild(document.createElement('strong'));
    if (s.em) host = host.appendChild(document.createElement('em'));
    appendText(host, s.text);
  }
  // A block that ends with a line break needs one more to show the empty line after it, as the site's text does.
  if (spans.at(-1)?.text.endsWith('\n')) parent.appendChild(document.createElement('br'));
  // An empty block still holds a line to type in.
  if (!parent.childNodes.length) parent.appendChild(document.createElement('br'));
}

/** A picture as the writer shows it: one block that cannot be typed into, with its caption under it. */
export function figureElement(b: RichImageBlock, state: ProjectState, devUrl: string | null): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 'post-figure';
  fig.contentEditable = 'false';
  fig.dataset.assetId = b.assetId;
  fig.dataset.alt = typeof b.alt === 'string' ? b.alt : '';
  if (typeof b.caption === 'string' && b.caption) fig.dataset.caption = b.caption;
  if (b.decorative) fig.dataset.decorative = 'true';
  fillFigure(fig, state, devUrl);
  return fig;
}

/** Draw a figure from its data: the picture (or what is wrong with it), and its caption. */
export function fillFigure(fig: HTMLElement, state: ProjectState, devUrl: string | null): void {
  fig.replaceChildren();
  const id = fig.dataset.assetId ?? '';
  const asset = Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id] : undefined;
  const src = asset?.kind === 'image' ? assetUrl(devUrl, asset.file) : null;
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = fig.dataset.decorative ? '' : (fig.dataset.alt ?? '');
    img.draggable = false;
    fig.appendChild(img);
  } else {
    const missing = document.createElement('div');
    missing.className = 'post-figure-missing';
    missing.textContent = !asset ? 'This picture is no longer in the library.' : asset.kind !== 'image' ? `“${asset.name}” is not a picture.` : `${asset.name} (shown once the preview has started)`;
    fig.appendChild(missing);
  }
  const caption = fig.dataset.caption;
  if (caption) {
    const fc = document.createElement('figcaption');
    fc.textContent = caption;
    fig.appendChild(fc);
  }
  fig.title = 'Click to change this picture, its description or its caption';
}

function blockElement(b: RichBlock, state: ProjectState, devUrl: string | null): HTMLElement {
  if (isImageBlock(b)) return figureElement(b, state, devUrl);
  if (isListBlock(b)) {
    const list = document.createElement(b.type === 'ol' ? 'ol' : 'ul');
    if (b.type === 'check') list.className = CHECK_CLASS;
    for (const item of b.items) {
      const li = document.createElement('li');
      appendSpans(li, item, state);
      list.appendChild(li);
    }
    return list;
  }
  const el = document.createElement(b.type);
  appendSpans(el, b.spans, state);
  return el;
}

/** Show `body` in the writer's editable root, in place of whatever it held. An empty post starts with one paragraph. */
export function renderArticle(root: HTMLElement, body: RichText, state: ProjectState, devUrl: string | null): void {
  const els = body.map((b) => blockElement(b, state, devUrl));
  if (!els.length || isImageBlock(body[body.length - 1])) {
    // Room to type after the last picture, and in an empty post.
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    els.push(p);
  }
  root.replaceChildren(...els);
}

/** The writer's DOM as the small copy blocksFromDom reads. */
export function articleDom(root: Node): RichDomNode[] {
  const out: RichDomNode[] = [];
  root.childNodes.forEach((n) => {
    const r = toDom(n);
    if (r !== null) out.push(r);
  });
  return out;
}

function toDom(n: Node): RichDomNode | null {
  if (n.nodeType === Node.TEXT_NODE) return (n as Text).data;
  if (n.nodeType !== Node.ELEMENT_NODE) return null;
  const el = n as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'figure') {
    const d = el.dataset;
    return { tag, children: [], image: { assetId: d.assetId ?? '', alt: d.alt ?? '', ...(d.caption ? { caption: d.caption } : {}), ...(d.decorative ? { decorative: true } : {}) } };
  }
  // Nothing the writer draws for itself is text (a picture's own controls).
  if (el.dataset.postChrome !== undefined) return null;
  const out: Exclude<RichDomNode, string> = { tag, children: articleDom(el) };
  // What the browser's own bold and italic commands can leave as styles.
  const weight = el.style?.fontWeight;
  if (weight) out.b = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  const style = el.style?.fontStyle;
  if (style) out.i = style === 'italic' || style === 'oblique';
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    // The stored destination while the address shown is still the one it was shown with; a new address typed over it
    // is read as typed.
    out.href = el.dataset.link && el.dataset.href === href ? KEPT_LINK + el.dataset.link : href;
    if (el.getAttribute('target') === '_blank') out.newTab = true;
    const rel = relsFromAttribute(el.getAttribute('rel'));
    if (rel.length) out.rel = rel;
  }
  if (tag === 'ul' && el.classList.contains(CHECK_CLASS)) out.check = true;
  return out;
}

/**
 * The text the writer shows, as the post stores it. Links that cannot be stored keep their words. A link made in the
 * writer since it was last read takes its destination now, so it keeps it however addresses change later.
 */
export function readArticle(root: HTMLElement, state: ProjectState): RichText {
  return readText(root, () => articleDom(root), state);
}

/** One block of the writer's root (see readArticle), as the blocks the text stores for it. */
function readArticleNodes(block: Node, state: ProjectState): RichText {
  return readText(block, () => {
    const dom = toDom(block);
    return dom === null ? [] : [dom];
  }, state);
}

/** The text `dom` reads from `within`, once each link made in the writer since it was last read keeps its destination. */
function readText(within: Node, dom: () => RichDomNode[], state: ProjectState): RichText {
  const links = articleLinks(state);
  const anchors = within instanceof Element ? [...(within.matches('a[href]') ? [within] : []), ...within.querySelectorAll('a[href]')] : [];
  for (const a of anchors as HTMLElement[]) {
    const href = a.getAttribute('href') ?? '';
    if (a.dataset.link && a.dataset.href === href) continue;
    const link = links.link(href, a.getAttribute('target') === '_blank', relsFromAttribute(a.getAttribute('rel')));
    if (link) keepLink(a, link, href);
  }
  return blocksFromDom(dom(), state.pages, links).blocks;
}

/**
 * Why the writer cannot edit a post's stored text in place, or null when it can: text damaged by a hand edit, or
 * written by a newer version, which writing it back would lose.
 */
export function articleProblem(body: unknown): string | null {
  // Not a download: post text cannot keep one yet, so the writer could not write it back.
  const LINKS = ['page', 'entry', 'collection', 'url', 'email', 'tel', 'anchor'];
  // A link the writer can show: one of the kinds it knows, with an address that is text.
  const link = (l: unknown) => l === undefined || (!!l && typeof l === 'object' && LINKS.includes((l as LinkValue).type) && typeof (l as LinkValue).target === 'string' && ((l as LinkValue).anchor === undefined || typeof (l as LinkValue).anchor === 'string') && ((l as LinkValue).query === undefined || typeof (l as LinkValue).query === 'string'));
  const spans = (v: unknown) => Array.isArray(v) && v.every((s) => !!s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string' && link((s as { link?: unknown }).link));
  const ok =
    Array.isArray(body) &&
    body.every((b) => {
      if (!isRichBlock(b)) return false;
      if (isImageBlock(b)) return true;
      return isListBlock(b) ? b.items.every(spans) : spans(b.spans);
    });
  return ok ? null : 'This post’s text holds something the writer cannot show (a hand edit, or a newer version of SiteOrigin Builder), so it is not edited here. Project health says what.';
}

/** Pasted elements dropped with everything inside them: nothing active, and no pictures (they come from the library). */
const PASTE_DROP = new Set(['head', 'title', 'meta', 'link', 'base', 'style', 'script', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'canvas', 'img', 'picture', 'video', 'audio', 'map', 'area', 'form', 'input', 'select', 'textarea', 'button', 'option', 'dialog']);
/** Pasted elements the writer has a block of its own for, by the name it reads them with. */
const PASTE_KEEP = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'br']);
/** Pasted blocks the writer has no kind of its own for: their words stay, as paragraphs. */
const PASTE_AS_BLOCK = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address', 'pre', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'table', 'tr', 'caption', 'details', 'summary', 'hr', 'center', 'hgroup', 'fieldset', 'legend']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** A pasted node as the small copy blocksFromDom reads: only what the writer can hold, every element a new one. */
function pastedNodes(n: Node, pre: boolean, preview: string | null): RichDomNode[] {
  if (n.nodeType === Node.TEXT_NODE) {
    const text = (n as Text).data;
    if (!pre) return [text];
    // Preformatted text keeps its lines, as breaks.
    const out: RichDomNode[] = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (i) out.push({ tag: 'br', children: [] });
      if (line) out.push(line);
    });
    return out;
  }
  const el = n as Element;
  if (n.nodeType !== Node.ELEMENT_NODE || el.namespaceURI !== HTML_NS) return [];
  const tag = el.localName;
  if (PASTE_DROP.has(tag)) return [];
  const inPre = pre || tag === 'pre';
  const children = [...el.childNodes].flatMap((c) => pastedNodes(c, inPre, preview));
  const out: Exclude<RichDomNode, string> = { tag: PASTE_KEEP.has(tag) ? tag : PASTE_AS_BLOCK.has(tag) ? 'div' : tag === 'a' ? 'a' : 'span', children };
  // A table cell's words stay apart from the next cell's.
  if (tag === 'td' || tag === 'th') children.unshift(' ');
  // Bold and italic as marks the element's own style can take back: Google Docs wraps a whole copy in
  // <b style="font-weight:normal"> and marks its bold words with a style instead.
  const style = (el as HTMLElement).style;
  const weight = style?.fontWeight;
  if (weight) out.b = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  else if (tag === 'b' || tag === 'strong') out.b = true;
  const slant = style?.fontStyle;
  if (slant) out.i = slant === 'italic' || slant === 'oblique';
  else if (tag === 'i' || tag === 'em') out.i = true;
  if (tag === 'a') {
    const href = el.getAttribute('href');
    // Only an address: the writer's own stored destinations are never taken from a copy.
    if (href !== null && !href.trim().startsWith(KEPT_LINK)) out.href = previewPath(href, preview);
    if (el.getAttribute('target') === '_blank') out.newTab = true;
    const rel = relsFromAttribute(el.getAttribute('rel'));
    if (rel.length) out.rel = rel;
  }
  if (tag === 'ul' && el.classList.contains(CHECK_CLASS)) out.check = true;
  return [out];
}

/** A link copied from the site's preview, as the address of its page on the site; any other address as it is. */
function previewPath(href: string, preview: string | null): string {
  if (!preview || !/^https?:\/\//i.test(href.trim())) return href;
  try {
    const url = new URL(href.trim());
    return url.origin === new URL(preview).origin ? url.pathname + url.search + url.hash : href;
  } catch {
    return href;
  }
}

/**
 * How a pasted link is read: as the writer reads its own (a page by its address, a web address), and an address of
 * one of this site's posts or a collection's index as that post or index, as a copy from the preview holds them.
 */
function pastedLinks(state: ProjectState): ArticleRead {
  const links = articleLinks(state);
  let routes: Map<string, LinkValue> | null = null;
  const siteRoutes = () => {
    if (routes) return routes;
    routes = new Map();
    for (const c of Object.values(state.collections ?? {})) {
      for (const e of Object.values(c.entries)) {
        const route = entryRoute(c, e);
        if (route && !routes.has(route)) routes.set(route, { type: 'entry', target: e.id });
      }
    }
    for (const [id, route] of Object.entries(collectionIndexRoutes(state))) if (!routes.has(route)) routes.set(route, { type: 'collection', target: id });
    return routes;
  };
  return {
    link: (href, newTab, rel) => {
      const kept = links.link(href, newTab, rel);
      if (kept) return kept;
      const t = href.trim();
      if (!t.startsWith('/') || t.startsWith('//') || /[?#]/.test(t)) return null;
      let path = t;
      try {
        path = decodeURI(t);
      } catch {
        // Kept as written.
      }
      const found = siteRoutes().get(path.endsWith('/') ? path : `${path}/`);
      return found ? { ...found, ...(newTab ? { newTab: true } : {}) } : null;
    }
  };
}

/** The most elements a copy may hold to be pasted as blocks: plenty for a post's most blocks with their marks. */
const MAX_PASTED_ELEMENTS = 60_000;

/**
 * Copied HTML as the blocks of an article's text: paragraphs, section headings (h2 to h4), quotes, lists, bold, italic,
 * line breaks and links to anywhere the writer can link to, read with the rules the writer reads its own text with.
 * Everything else keeps only its words: styles, classes, pictures, tables and the like. A link copied from the site's
 * preview (at `preview`) goes to its page or post. Empty when it holds no words, and when it is more than a post can
 * hold (its words are then pasted as plain text, as before).
 */
export function pastedArticle(html: string, state: ProjectState, preview: string | null = null): RichText {
  if (!html || html.length > 2_000_000) return [];
  // Parsed inert (nothing runs or loads), from inside a body: what comes before the copy's own body (comments, Word's
  // conditional blocks) lands there too.
  const body = new DOMParser().parseFromString(`<body>${html}`, 'text/html').body;
  // Far more elements than a post's blocks need is more than it can hold, and too many to read in one go.
  if (body.getElementsByTagName('*').length > MAX_PASTED_ELEMENTS) return [];
  const nodes = [...body.childNodes].flatMap((c) => pastedNodes(c, false, preview));
  const blocks = blocksFromDom(nodes, state.pages, pastedLinks(state)).blocks.filter((b) => !isImageBlock(b));
  const chars = blocks.reduce((n, b) => n + (isListBlock(b) ? b.items.flat() : (b as RichTextBlock).spans).reduce((m, sp) => m + sp.text.length, 0), 0);
  return blocks.length > MAX_ENTRY_BLOCKS || chars > MAX_ENTRY_CHARS ? [] : blocks;
}

/** A block of text, or one item of a list, as a paste splits and joins them; a picture is carried as it is. */
type PasteLine = { kind: RichTextBlock['type'] | 'li'; list?: RichListBlock['type']; spans: RichSpan[] } | { kind: 'image'; block: RichImageBlock };

const linesOf = (blocks: RichText): PasteLine[] =>
  blocks.flatMap((b): PasteLine[] => (isImageBlock(b) ? [{ kind: 'image', block: b }] : isListBlock(b) ? b.items.map((spans) => ({ kind: 'li', list: b.type, spans })) : [{ kind: b.type, spans: b.spans }]));
const spansWords = (spans: RichSpan[]) => /\S/.test(spans.map((s) => s.text).join(''));
/** Characters, a line break counting as one, as caretAtChar counts them in the drawn block. */
const spansLength = (spans: RichSpan[]) => spans.reduce((n, s) => n + s.text.length, 0);

/** `spans` split at `mark`, without it; null when it is not in them. */
function splitAt(spans: RichSpan[], mark: string): [RichSpan[], RichSpan[]] | null {
  for (let i = 0; i < spans.length; i++) {
    const at = spans[i].text.indexOf(mark);
    if (at < 0) continue;
    const s = spans[i];
    const before = { ...s, text: s.text.slice(0, at) };
    const after = { ...s, text: s.text.slice(at + 1) };
    return [[...spans.slice(0, i), ...(before.text ? [before] : [])], [...(after.text ? [after] : []), ...spans.slice(i + 1)]];
  }
  return null;
}

/** The blocks of the writer's root a paste can split: a picture never, and words outside any block are left to the browser. */
const SPLITS = new Set(['P', 'DIV', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL']);

/** A caret `n` characters into `el`, a line break counting as one: just after a break it is on the line after it. */
function caretAtChar(el: HTMLElement, n: number): void {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (x) => (x.nodeType === Node.TEXT_NODE || x.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  let placed = false;
  for (let t = walker.nextNode(); t && !placed; t = walker.nextNode()) {
    if (t.nodeName === 'BR') {
      if (n === 0) (range.setStartBefore(t), (placed = true));
      else n--;
    } else if (n <= (t as Text).length) (range.setStart(t, n), (placed = true));
    else n -= (t as Text).length;
  }
  if (!placed) {
    // The end of the block, before the break that only holds its last line open.
    if (el.lastChild?.nodeName === 'BR') range.setStartBefore(el.lastChild);
    else range.setStart(el, el.childNodes.length);
  }
  range.collapse(true);
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Put pasted blocks (see pastedArticle) in the writer's text at the selection, in place of what is selected, as one
 * formatting command (PostWriter runs it as one undo step). One paragraph pasted is only its words, put among the words
 * at the caret. Otherwise the block the caret is in splits around the paste and keeps its kind: a paragraph's words that
 * start the paste join the words before the caret, and a paragraph's words that end it join the words after the caret.
 * Every other block pasted keeps its own kind, a list included, and ends the caret's block or list item there; that
 * block alone is drawn again, and the caret ends after the pasted words. False, with nothing changed, when the paste
 * cannot go where the caret is (it is not in the text, or in words outside any block). `plain` is the copy's plain
 * text, which says whether words pasted alone start or end with a space.
 */
export function pasteArticle(root: HTMLElement, pasted: RichText, state: ProjectState, devUrl: string | null, plain = ''): boolean {
  const doc = root.ownerDocument;
  const sel = doc.getSelection();
  if (!pasted.length || !sel?.rangeCount || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) return false;
  const only = pasted.length === 1 ? pasted[0] : null;
  if (only && !isImageBlock(only) && !isListBlock(only) && only.type === 'p') {
    // Words alone: the browser puts them in place of the selection, and nothing else in the text is drawn again.
    const words = doc.createElement('div');
    // A space the copy starts or ends with stays, as the plain text of it shows: it parts the words from those at the caret.
    const spans = only.spans.map((sp) => ({ ...sp }));
    // Non-breaking, so the browser keeps one at the end of a block too (the text reads it back as a space).
    if (/^[ \t]/.test(plain) && !spans[0].text.startsWith(' ')) spans.unshift({ text: '\u00a0' });
    if (/[ \t]$/.test(plain) && !spans[spans.length - 1].text.endsWith(' ')) spans.push({ text: '\u00a0' });
    appendSpans(words, spans, state);
    // The break that holds a block's last line open is the block's, not the words'.
    if (spans.at(-1)?.text.endsWith('\n')) words.lastChild?.remove();
    // What is selected goes first, so the blocks or list items it ran across join, as typing over it joins them.
    if (!sel.isCollapsed) doc.execCommand('delete');
    return doc.execCommand('insertHTML', false, words.innerHTML);
  }
  // Nothing is deleted for a paste that cannot go there: both ends of the selection are in blocks it can split (or pictures).
  const r = sel.getRangeAt(0);
  const topOf = (n: Node) => {
    while (n.parentNode && n.parentNode !== root) n = n.parentNode;
    return n;
  };
  const splits = (n: Node) => n === root || (n instanceof HTMLElement && (SPLITS.has(n.tagName) || n.tagName === 'FIGURE'));
  if (!splits(topOf(r.startContainer)) || !splits(topOf(r.endContainer))) return false;
  // What is selected goes first, as typing over it would take it: the blocks it ran across join, as the browser joins them.
  if (!sel.isCollapsed) doc.execCommand('delete');
  if (!sel.rangeCount || !root.contains(sel.anchorNode)) return false;
  // Where the paste goes, marked with a character the text does not hold, so it is found again once the block is read.
  const words = root.textContent ?? '';
  let code = 0xe000;
  while (code < 0xf8ff && words.includes(String.fromCharCode(code))) code++;
  const markText = String.fromCharCode(code);
  const mark = doc.createTextNode(markText);
  sel.getRangeAt(0).insertNode(mark);
  let host: Node = mark;
  while (host.parentNode && host.parentNode !== root) host = host.parentNode;
  const lines = host instanceof HTMLElement && host.parentNode === root && SPLITS.has(host.tagName) ? linesOf(readArticleNodes(host, state)) : [];
  const at = lines.findIndex((l) => l.kind !== 'image' && splitAt(l.spans, markText));
  if (at < 0) {
    const parent = mark.parentNode;
    mark.remove();
    parent?.normalize();
    return false;
  }
  const line = lines[at] as Exclude<PasteLine, { kind: 'image' }>;
  const [before, after] = splitAt(line.spans, markText)!;
  const head = { ...line, spans: before };
  const tail = { ...line, spans: after };
  const middle = linesOf(pasted);
  let caret: { line: PasteLine; offset: number };
  if (middle[0].kind === 'p' && spansWords(before)) head.spans = [...head.spans, ...(middle.shift() as { spans: RichSpan[] }).spans];
  const last = middle[middle.length - 1];
  if (last.kind === 'p' && spansWords(after)) {
    middle.pop();
    tail.spans = [...last.spans, ...tail.spans];
    caret = { line: tail, offset: spansLength(last.spans) };
  } else caret = { line: last, offset: last.kind === 'image' ? 0 : spansLength(last.spans) };
  const out: PasteLine[] = [...lines.slice(0, at), ...(spansWords(head.spans) ? [head] : []), ...middle, ...(spansWords(tail.spans) ? [tail] : []), ...lines.slice(at + 1)];

  // Drawn as the writer draws its text, items of the same kind side by side in one list.
  const drawn = doc.createDocumentFragment();
  let list: HTMLElement | null = null;
  let caretEl: HTMLElement | null = null;
  for (const l of out) {
    let el: HTMLElement;
    if (l.kind === 'image') {
      list = null;
      el = drawn.appendChild(figureElement(l.block, state, devUrl));
    } else if (l.kind === 'li') {
      if (!list || listKind(list) !== l.list) list = drawn.appendChild(newList(doc, l.list!));
      el = list.appendChild(doc.createElement('li'));
      appendSpans(el, l.spans, state);
    } else {
      list = null;
      el = drawn.appendChild(doc.createElement(l.kind));
      appendSpans(el, l.spans, state);
    }
    if (l === caret.line) caretEl = el;
  }
  const firstEl = drawn.firstChild;
  const lastEl = drawn.lastChild;
  host.parentNode!.replaceChild(drawn, host);
  // A list drawn right beside a list of the same kind is one list with it, as the text stores them.
  const join = (a: Node | null | undefined, b: Node | null | undefined) => {
    if (!(a instanceof Element) || !(b instanceof Element) || !listKind(a) || listKind(a) !== listKind(b)) return;
    a.append(...b.childNodes);
    b.remove();
  };
  join(lastEl, lastEl?.nextSibling);
  join(firstEl?.previousSibling, firstEl);
  if (caretEl?.isConnected) caretAtChar(caretEl, caret.offset);
  return true;
}

/** Where the caret is, as the number of the block it is in and how far into that block's text: kept across a redraw. */
export interface ArticleCaret {
  block: number;
  offset: number;
}

/** The writer's caret, if it is inside `root`. */
export function caretIn(root: HTMLElement): ArticleCaret | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!node || !root.contains(node)) return null;
  let top: Node = node;
  while (top.parentNode && top.parentNode !== root) top = top.parentNode;
  const block = Array.prototype.indexOf.call(root.childNodes, top) as number;
  if (block < 0) return null;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(top);
  range.setEnd(node, sel.anchorOffset);
  return { block, offset: range.toString().length };
}

/** How far into `el`'s text the caret is, or null when it is not inside `el`. */
export function caretOffset(el: Node): number | null {
  const sel = el.ownerDocument?.getSelection();
  const node = sel?.rangeCount ? sel.anchorNode : null;
  if (!sel || !node || !el.contains(node)) return null;
  const range = el.ownerDocument!.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, sel.anchorOffset);
  return range.toString().length;
}

/** Put the caret `offset` characters into `el`'s text, or at its end when it has fewer. */
export function caretTo(el: Node, offset: number): void {
  const doc = el.ownerDocument;
  const sel = doc?.getSelection();
  if (!doc || !sel) return;
  const range = doc.createRange();
  let left = offset;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    last = t;
    if (left <= t.data.length) {
      range.setStart(t, left);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    left -= t.data.length;
  }
  if (last) range.setStart(last, last.data.length);
  // An empty block holds only the <br> that gives it a line: the caret goes before it.
  else range.setStart(el, el.nodeName === 'FIGURE' ? 0 : el.lastChild?.nodeName === 'BR' ? el.childNodes.length - 1 : el.childNodes.length);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Put the caret back where `at` says, as near as the text now allows. */
export function placeCaret(root: HTMLElement, at: ArticleCaret | null): void {
  const blocks = root.childNodes;
  if (!blocks.length) return;
  const top = blocks[Math.min(Math.max(at?.block ?? blocks.length - 1, 0), blocks.length - 1)];
  caretTo(top, at ? at.offset : Infinity);
}

/** The block of the writer's root the caret is in (a direct child of `root`), or null. */
export function blockAtCaret(root: HTMLElement): HTMLElement | null {
  const sel = root.ownerDocument.getSelection();
  const node = sel?.rangeCount ? sel.anchorNode : null;
  if (!node || !root.contains(node) || node === root) return null;
  let top: Node = node;
  while (top.parentNode && top.parentNode !== root) top = top.parentNode;
  return top instanceof HTMLElement ? top : null;
}

/**
 * The block of the writer's root a drop at height `y` on screen lands in (a direct child of `root`), without moving
 * the caret: the one beside the point, or in a gap or the margin below, the one above it. Null above the first block,
 * or in empty text.
 */
export function blockAtPoint(root: HTMLElement, y: number): HTMLElement | null {
  let at: HTMLElement | null = null;
  for (const b of root.children) {
    if (!(b instanceof HTMLElement)) continue;
    if (b.getBoundingClientRect().top > y) break;
    at = b;
  }
  return at;
}

/**
 * Put a picture in the text where the caret is: after the block it is in (`before` it, for a picture dropped above the
 * first), or in place of an empty paragraph, with a paragraph after it to go on typing in when it ends the text.
 * Returns the figure.
 */
export function insertFigure(root: HTMLElement, at: HTMLElement | null, fig: HTMLElement, before = false): HTMLElement {
  const empty = at && at.tagName === 'P' && !at.textContent?.trim() && !at.querySelector('img');
  if (at && empty) at.replaceWith(fig);
  else if (at && before) at.before(fig);
  else if (at) at.after(fig);
  else root.appendChild(fig);
  if (!fig.nextSibling) {
    const p = root.ownerDocument.createElement('p');
    p.appendChild(root.ownerDocument.createElement('br'));
    fig.after(p);
  }
  return fig;
}

export type ArticleBlockTag = 'p' | 'h2' | 'h3' | 'h4' | 'blockquote';
export type ArticleListKind = 'ul' | 'ol' | 'check';

const listKind = (el: Element): ArticleListKind | null => (el.tagName === 'OL' ? 'ol' : el.tagName === 'UL' ? (el.classList.contains(CHECK_CLASS) ? 'check' : 'ul') : null);

function newList(doc: Document, kind: ArticleListKind): HTMLElement {
  const list = doc.createElement(kind === 'ol' ? 'ol' : 'ul');
  if (kind === 'check') list.className = CHECK_CLASS;
  return list;
}

/** The list item the caret is in, in a list that is a block of `root`. */
function caretItem(root: HTMLElement): { list: HTMLElement; li: HTMLElement } | null {
  const block = blockAtCaret(root);
  if (!block || !listKind(block)) return null;
  const node = root.ownerDocument.getSelection()?.anchorNode;
  const li = (node instanceof Element ? node : node?.parentElement)?.closest('li');
  return li && block.contains(li) ? { list: block, li } : null;
}

/**
 * Run `move`, which moves the caret's block content into another element, and put the caret back on the same text node
 * and offset, which moving keeps (a caret beside a line break stays on its side of it). When the caret was on the moved
 * element itself, it goes `offset` characters into `to`.
 */
function keepingCaret(from: Element, move: () => HTMLElement): HTMLElement {
  const sel = from.ownerDocument.getSelection();
  const node = sel?.rangeCount ? sel.anchorNode : null;
  const at = sel?.anchorOffset ?? 0;
  const offset = caretOffset(from) ?? 0;
  const to = move();
  if (sel && node && node !== from && node.isConnected && to.contains(node)) sel.collapse(node, Math.min(at, node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length));
  else caretTo(to, offset);
  return to;
}

/** Give a block's content to a new element, keeping a line to type in when it is empty. */
function moveInto(from: Element, to: HTMLElement): HTMLElement {
  to.append(...from.childNodes);
  if (!to.childNodes.length) to.appendChild(to.ownerDocument.createElement('br'));
  return to;
}

/** Take one item out of its list as `el`, in its place: the items after it go on in a list of their own. */
function liftItem(list: HTMLElement, li: HTMLElement, el: HTMLElement): void {
  const after = [...list.children].slice([...list.children].indexOf(li) + 1);
  if (after.length) {
    const rest = list.cloneNode(false) as HTMLElement;
    rest.append(...after);
    list.after(rest);
  }
  list.after(el);
  li.remove();
  if (!list.children.length) list.remove();
}

/**
 * Make the block the caret is in a paragraph, heading or quote (a list item leaves its list), keeping the caret where it
 * was in the text. The browser's own command can leave a list inside a paragraph, which no page shows. False when the
 * caret is in no block that can change (a picture).
 */
export function setBlock(root: HTMLElement, tag: ArticleBlockTag): boolean {
  const doc = root.ownerDocument;
  const item = caretItem(root);
  if (item) {
    keepingCaret(item.li, () => {
      const el = moveInto(item.li, doc.createElement(tag));
      liftItem(item.list, item.li, el);
      return el;
    });
    return true;
  }
  const block = blockAtCaret(root);
  if (!block || block.tagName === 'FIGURE' || listKind(block)) return false;
  if (block.tagName.toLowerCase() === tag) return true;
  keepingCaret(block, () => {
    const el = moveInto(block, doc.createElement(tag));
    block.replaceWith(el);
    return el;
  });
  return true;
}

/**
 * Put the block the caret is in into a list of `kind` (joining a list of that kind just before it), take its item out of
 * that kind of list again, or change the kind of the list it is in.
 */
export function toggleList(root: HTMLElement, kind: ArticleListKind): boolean {
  const doc = root.ownerDocument;
  const item = caretItem(root);
  if (item) {
    if (listKind(item.list) === kind) return setBlock(root, 'p');
    keepingCaret(item.list, () => {
      const list = newList(doc, kind);
      list.append(...item.list.childNodes);
      item.list.replaceWith(list);
      return list;
    });
    return true;
  }
  const block = blockAtCaret(root);
  if (!block || block.tagName === 'FIGURE' || listKind(block)) return false;
  keepingCaret(block, () => {
    const li = moveInto(block, doc.createElement('li'));
    const prev = block.previousElementSibling;
    if (prev && listKind(prev) === kind) {
      prev.appendChild(li);
      block.remove();
    } else {
      const list = newList(doc, kind);
      list.appendChild(li);
      block.replaceWith(list);
    }
    return li;
  });
  return true;
}

/** What a Markdown marker typed at the start of a paragraph, then a space, makes of it. `#` is not one: the title is the post's only first-level heading. */
const SHORTCUTS: Record<string, { block: ArticleBlockTag } | { list: ArticleListKind }> = {
  '##': { block: 'h2' },
  '###': { block: 'h3' },
  '####': { block: 'h4' },
  '>': { block: 'blockquote' },
  '-': { list: 'ul' },
  '*': { list: 'ul' },
  '+': { list: 'ul' },
  '1.': { list: 'ol' },
  '[ ]': { list: 'check' }
};

/**
 * The change a space typed now makes when it ends a Markdown marker that starts a paragraph (`## ` a heading, `- ` a
 * list), as a function that removes the marker and changes the block; null when the space is only a space. Only a
 * paragraph of the text's own, with the caret collapsed just after the marker on its first line, changes: a heading, a
 * list item, a quote, or a marker after other words stays as typed.
 */
export function markdownShortcut(root: HTMLElement): (() => boolean) | null {
  const doc = root.ownerDocument;
  const sel = doc.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return null;
  const block = blockAtCaret(root);
  if (!block || block.tagName !== 'P') return null;
  const before = doc.createRange();
  before.selectNodeContents(block);
  before.setEnd(sel.anchorNode!, sel.anchorOffset);
  const marker = before.toString();
  const to = Object.hasOwn(SHORTCUTS, marker) ? SHORTCUTS[marker] : null;
  if (!to || before.cloneContents().querySelector('br, img')) return null;
  return () => {
    before.deleteContents();
    // A block left with no words keeps a line to type on.
    if (!block.textContent && !block.querySelector('br, img')) block.replaceChildren(doc.createElement('br'));
    sel.collapse(block, 0);
    return 'block' in to ? setBlock(root, to.block) : toggleList(root, to.list);
  };
}

/**
 * The shortcut a `beforeinput` event runs: a space typed (never composed) where `markdownShortcut` finds a marker. The
 * writer cancels the event and runs it as a formatting command; null for any other input.
 */
export function spaceShortcut(root: HTMLElement, e: Pick<InputEvent, 'inputType' | 'data' | 'isComposing'>): (() => boolean) | null {
  return e.inputType === 'insertText' && e.data === ' ' && !e.isComposing ? markdownShortcut(root) : null;
}
