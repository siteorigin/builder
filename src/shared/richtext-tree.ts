/**
 * Rich text read from a tree of elements: the small, plain copy of an editable element the canvas and the Posts
 * writer send (see RichDomNode), or the tree an imported post's HTML is read into. No DOM is needed, so the editor's
 * main process reads imports with the same rules the editor applies to what is typed.
 */
import type { LinkValue, RichBlock, RichListBlock, RichSpan, RichText, RichTextBlock } from './types';
import { cleanBlocks, linkFromTarget, mergeLists, type RichIndexes, type RichPages } from './richtext';

/** A text node, or an element by tag name with its children. `b` and `i` carry an inline style's bold or
 *  italic (true) or its explicit removal (false), as the browser's own commands can leave them. `check` marks a
 *  check list, `href`, `newTab` and `rel` (its authored relationships, see LINK_RELS) a link. */
export type RichDomNode = string | { tag: string; b?: boolean; i?: boolean; check?: boolean; href?: string; newTab?: boolean; rel?: string[]; image?: RichDomImage; children: RichDomNode[] };
/** A picture placed in an article's text (the Posts writer's figures): read only in article mode. */
export interface RichDomImage {
  assetId: string;
  alt: string;
  caption?: string;
  decorative?: boolean;
}

/** How the Posts writer reads its text: section headings (h2) and pictures are an article's, and links can go to entries. */
export interface ArticleRead {
  link: (href: string, newTab: boolean, rel: string[]) => LinkValue | null;
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer']);
const TEXT_BLOCKS_ON_PAGE: Record<string, RichTextBlock['type']> = { h1: 'h3', h2: 'h3', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4', blockquote: 'blockquote' };
/** In an article, a section heading stays one: the title above it is the page's h1. */
const ARTICLE_BLOCK: Record<string, RichTextBlock['type']> = { ...TEXT_BLOCKS_ON_PAGE, h1: 'h2', h2: 'h2' };

/**
 * The blocks the edited element now holds. `droppedLinks` counts links whose destination cannot be stored; their
 * words stay as plain text.
 */
export function blocksFromDom(nodes: RichDomNode[], pages: RichPages, article?: ArticleRead, indexes?: RichIndexes): { blocks: RichText; droppedLinks: number } {
  const TEXT_BLOCK = article ? ARTICLE_BLOCK : TEXT_BLOCKS_ON_PAGE;
  const blocks: RichBlock[] = [];
  let run: RichSpan[] = [];
  let list: RichListBlock | null = null;
  let type: RichTextBlock['type'] = 'p';
  let droppedLinks = 0;
  /** The breaks read from <br>: the last one in a block shows no line (see flush). */
  const brs = new WeakSet<RichSpan>();
  /** Runs of text that show something: words, or a non-breaking space (which a page never collapses). */
  const shown = new WeakSet<RichSpan>();
  const flush = () => {
    // A <br> that ends a block shows nothing: it is the browser's own, holding the caret on the empty line after a
    // Shift+Enter, or the one the page adds after a block that ends with a break (RichText.svelte). Only the
    // breaks before it are the writer's.
    let last = run.length - 1;
    while (last >= 0 && !brs.has(run[last]) && !shown.has(run[last])) last--;
    if (last >= 0 && brs.has(run[last])) run.splice(last, 1);
    if (run.some((s) => s.text.trim())) {
      if (list) list.items.push(run);
      else blocks.push({ type, spans: run });
    }
    run = [];
  };
  const walk = (n: RichDomNode, marks: Omit<RichSpan, 'text'>) => {
    if (typeof n === 'string') {
      // Whitespace in the text itself (a line feed in pasted or source markup) collapses, as the page shows it: only
      // a <br> is a line break. Browsers type non-breaking spaces into editable text wherever a plain space would
      // collapse.
      const text = { text: n.replace(/[ \t\r\n\f]+/g, ' ').replace(/\u00a0/g, ' '), ...marks };
      if (/[^ \t\r\n\f]/.test(n)) shown.add(text);
      run.push(text);
      return;
    }
    const tag = n.tag.toLowerCase();
    // A line break inside the block (Shift+Enter), not a new paragraph.
    if (tag === 'br') {
      const br = { text: '\n', ...marks };
      brs.add(br);
      run.push(br);
      return;
    }
    const inner = { ...marks };
    const strong = tag === 'strong' || tag === 'b' ? true : (n.b ?? marks.strong);
    const em = tag === 'em' || tag === 'i' ? true : (n.i ?? marks.em);
    if (strong) inner.strong = true;
    else delete inner.strong;
    if (em) inner.em = true;
    else delete inner.em;
    // A picture between paragraphs, in an article: it ends the block before it, and its caption is its own.
    if (article && tag === 'figure') {
      flush();
      const img = n.image;
      if (img && typeof img.assetId === 'string' && img.assetId) blocks.push({ type: 'image', assetId: img.assetId, alt: img.alt ?? '', ...(img.caption ? { caption: img.caption } : {}), ...(img.decorative ? { decorative: true } : {}) });
      return;
    }
    if (tag === 'a' && n.href !== undefined) {
      const rel = Array.isArray(n.rel) ? n.rel : [];
      const link = article ? article.link(n.href, !!n.newTab, rel) : linkFromTarget(n.href, pages, !!n.newTab, rel, indexes);
      if (link) inner.link = link;
      else droppedLinks++;
    }
    const children = () => n.children.forEach((c) => walk(c, inner));
    if (tag === 'ul' || tag === 'ol') {
      flush();
      // A list inside a list has no stored form: its items join the outer one.
      if (list) return children(), flush();
      list = { type: tag === 'ol' ? 'ol' : n.check ? 'check' : 'ul', items: [] };
      blocks.push(list);
      children();
      flush();
      list = null;
    } else if (Object.hasOwn(TEXT_BLOCK, tag) && !list) {
      flush();
      const outer = type;
      type = TEXT_BLOCK[tag];
      children();
      flush();
      type = outer;
    } else if (tag === 'li' || BLOCK.has(tag) || Object.hasOwn(TEXT_BLOCK, tag)) {
      flush();
      children();
      flush();
    } else children();
  };
  for (const n of nodes) walk(n, {});
  flush();
  return { blocks: mergeLists(cleanBlocks(blocks)), droppedLinks };
}
