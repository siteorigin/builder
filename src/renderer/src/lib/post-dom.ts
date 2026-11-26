/**
 * The Posts writer's editable text, to and from a post's stored text. The writer shows an article as the site will:
 * paragraphs, section headings (h2 to h4), quotes, lists and pictures with their captions, with links kept as their
 * destinations (a page by its address, a post as `entry:` and its ID). Pictures are single blocks the text flows
 * around: they are chosen and described in a dialog, never typed into.
 */
import type { LinkValue, ProjectState, RichBlock, RichImageBlock, RichSpan, RichText } from '@shared/types';
import { isImageBlock, isListBlock, isRichBlock, linkToTarget } from '@shared/richtext';
import { linkRels, relsFromAttribute } from '@shared/link-rel';
import { blocksFromDom, type RichDomNode } from './richtext';
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
  const links = articleLinks(state);
  root.querySelectorAll<HTMLElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (a.dataset.link && a.dataset.href === href) return;
    const link = links.link(href, a.getAttribute('target') === '_blank', relsFromAttribute(a.getAttribute('rel')));
    if (link) keepLink(a, link, href);
  });
  return blocksFromDom(articleDom(root), state.pages, links).blocks;
}

/**
 * Why the writer cannot edit a post's stored text in place, or null when it can: text damaged by a hand edit, or
 * written by a newer version, which writing it back would lose.
 */
export function articleProblem(body: unknown): string | null {
  // Not a download: post text cannot keep one yet, so the writer could not write it back.
  const LINKS = ['page', 'entry', 'url', 'email', 'tel', 'anchor'];
  // A link the writer can show: one of the kinds it knows, with an address that is text.
  const link = (l: unknown) => l === undefined || (!!l && typeof l === 'object' && LINKS.includes((l as LinkValue).type) && typeof (l as LinkValue).target === 'string' && ((l as LinkValue).anchor === undefined || typeof (l as LinkValue).anchor === 'string'));
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
 * Put a picture in the text where the caret is: after the block it is in, or in place of an empty paragraph, with a
 * paragraph after it to go on typing in when it ends the text. Returns the figure.
 */
export function insertFigure(root: HTMLElement, at: HTMLElement | null, fig: HTMLElement): HTMLElement {
  const empty = at && at.tagName === 'P' && !at.textContent?.trim() && !at.querySelector('img');
  if (at && empty) at.replaceWith(fig);
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
  const to = SHORTCUTS[before.toString()];
  if (!to || before.cloneContents().querySelector('br, img')) return null;
  return () => {
    before.deleteContents();
    // A block left with no words keeps a line to type on.
    if (!block.textContent && !block.querySelector('br, img')) block.replaceChildren(doc.createElement('br'));
    sel.collapse(block, 0);
    return 'block' in to ? setBlock(root, to.block) : toggleList(root, to.list);
  };
}
