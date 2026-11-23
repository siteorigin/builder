/**
 * Rich text edited on the canvas, back to the document's form.
 *
 * The preview renders structured rich text as paragraphs, headings, quotes and lists holding <strong>, <em> and
 * <a>. When an inline edit ends, the bridge sends a small copy of what the editable element now holds (see
 * RichDomNode), and this module turns it back into blocks. Marks are independent, so text can be bold and italic
 * at once, and an asterisk is just a character. Links are read back by destination, so a page link keeps its ID.
 */
import type { RichBlock, RichListBlock, RichSpan, RichText, RichTextBlock } from '@shared/types';
import { cleanBlocks, linkFromTarget, mergeLists, type RichPages } from '@shared/richtext';

/** A text node, or an element by tag name with its children. `b` and `i` carry an inline style's bold or
 *  italic (true) or its explicit removal (false), as the browser's own commands can leave them. `check` marks a
 *  check list, `href` and `newTab` a link. */
export type RichDomNode = string | { tag: string; b?: boolean; i?: boolean; check?: boolean; href?: string; newTab?: boolean; children: RichDomNode[] };

const MAX_NODES = 5000;
const MAX_DEPTH = 16;
const MAX_TEXT = 20000;
const MAX_HREF = 2100;

/** Validate an untrusted copy from the preview; null when it is malformed or too large. */
export function richDom(v: unknown): RichDomNode[] | null {
  let budget = MAX_NODES;
  const ok = (n: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > MAX_DEPTH) return false;
    if (typeof n === 'string') return n.length <= MAX_TEXT;
    if (!n || typeof n !== 'object') return false;
    const e = n as Record<string, unknown>;
    return typeof e.tag === 'string' && e.tag.length <= 20 && (e.b === undefined || typeof e.b === 'boolean') && (e.i === undefined || typeof e.i === 'boolean') && (e.check === undefined || typeof e.check === 'boolean') && (e.newTab === undefined || typeof e.newTab === 'boolean') && (e.href === undefined || (typeof e.href === 'string' && e.href.length <= MAX_HREF)) && list(e.children, depth + 1);
  };
  // Every index, holes included (every() would skip a hole and leave it to throw later).
  const list = (a: unknown, depth: number) => Array.isArray(a) && a.length <= MAX_NODES && Array.from(a).every((n) => ok(n, depth));
  return list(v, 0) ? (v as RichDomNode[]) : null;
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer']);
const TEXT_BLOCK: Record<string, RichTextBlock['type']> = { h1: 'h3', h2: 'h3', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4', blockquote: 'blockquote' };

/**
 * The blocks the edited element now holds. `droppedLinks` counts links whose destination cannot be stored; their
 * words stay as plain text.
 */
export function blocksFromDom(nodes: RichDomNode[], pages: RichPages): { blocks: RichText; droppedLinks: number } {
  const blocks: RichBlock[] = [];
  let run: RichSpan[] = [];
  let list: RichListBlock | null = null;
  let type: RichTextBlock['type'] = 'p';
  let droppedLinks = 0;
  const flush = () => {
    if (run.some((s) => s.text.trim())) {
      if (list) list.items.push(run);
      else blocks.push({ type, spans: run });
    }
    run = [];
  };
  const walk = (n: RichDomNode, marks: Omit<RichSpan, 'text'>) => {
    if (typeof n === 'string') {
      // Browsers type non-breaking spaces into editable text wherever a plain space would collapse.
      run.push({ text: n.replace(/\u00a0/g, ' '), ...marks });
      return;
    }
    const tag = n.tag.toLowerCase();
    if (tag === 'br') return flush();
    const inner = { ...marks };
    const strong = tag === 'strong' || tag === 'b' ? true : (n.b ?? marks.strong);
    const em = tag === 'em' || tag === 'i' ? true : (n.i ?? marks.em);
    if (strong) inner.strong = true;
    else delete inner.strong;
    if (em) inner.em = true;
    else delete inner.em;
    if (tag === 'a' && n.href !== undefined) {
      const link = linkFromTarget(n.href, pages, !!n.newTab);
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
