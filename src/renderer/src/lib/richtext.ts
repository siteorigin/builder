/**
 * Rich text edited on the canvas, back to the document's form.
 *
 * The preview renders structured rich text as paragraphs, headings, quotes and lists holding <strong>, <em> and
 * <a>. When an inline edit ends, the bridge sends a small copy of what the editable element now holds (see
 * RichDomNode), and this module turns it back into blocks. Marks are independent, so text can be bold and italic
 * at once, and an asterisk is just a character. Links are read back by destination, so a page link keeps its ID.
 */
import type { GraphNode, RichBlock, RichListBlock, RichSpan, RichText, RichTextBlock } from '@shared/types';
import { asParagraphList, cleanBlocks, isListBlock, linkFromTarget, mergeLists, sameRichText, toRichText, type RichPages } from '@shared/richtext';

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

/**
 * For each edited item, the unchanged item it is (the longest run of items kept in order), or -1 for one that changed
 * or is new. An edit is at most a few hundred items, so the table stays small.
 */
function alignItems(before: string[], after: string[]): number[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = new Array<number>(m).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (before[i] === after[j]) out[j++] = i++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * What an inline edit of rich text stores. A node that lists paragraphs it shares with places showing them as
 * paragraphs (`paragraphList`) is edited as that list; when the text held paragraphs, each item goes back to what it
 * was (a paragraph, or an item of its list), so neither those places nor an edit that changes nothing see a
 * different kind of block. Unchanged items are found by their words, in order; a changed one takes the kind of the
 * item in its place while the edit keeps the number of items, and is a paragraph otherwise.
 */
export function storedEdit(node: GraphNode | undefined, current: unknown, next: string | RichText): string | RichText {
  const kind = node?.kind === 'text' && node.rich ? node.paragraphList : undefined;
  if (!kind || !Array.isArray(next)) return next;
  const shown = toRichText(current);
  // Shown as written: what was edited is what is stored.
  if (sameRichText(asParagraphList(shown, kind), shown)) return next;
  if (!next.length || !next.every((b) => b.type === kind && isListBlock(b))) return next;
  const items = next.flatMap((b) => (b as RichListBlock).items);
  const before = shown.flatMap((b) => (isListBlock(b) ? b.items.map((spans) => ({ spans, item: true })) : [{ spans: b.spans, item: false }]));
  const keys = before.map((b) => JSON.stringify(b.spans));
  const itemKeys = items.map((spans) => JSON.stringify(spans));
  const matched = alignItems(keys, itemKeys);
  // An item moved past others (Move item up or down) is still the item it was: what the run in order left
  // unmatched is matched by its words before anything falls back to the kind of the item in its place.
  const used = new Set(matched.filter((m) => m >= 0));
  matched.forEach((m, j) => {
    if (m >= 0) return;
    const k = keys.findIndex((key, i) => !used.has(i) && key === itemKeys[j]);
    if (k < 0) return;
    matched[j] = k;
    used.add(k);
  });
  // While the edit keeps the number of items, a changed one is the item it replaced: the items still unmatched on
  // each side are paired in order (one moved and then changed is still the item that moved).
  const spare = before.flatMap((b, i) => (used.has(i) ? [] : [b.item]));
  let nextSpare = 0;
  const out: RichBlock[] = [];
  items.forEach((spans, i) => {
    const found = matched[i];
    const item = found >= 0 ? before[found].item : before.length === items.length && !!spare[nextSpare++];
    const last = out[out.length - 1];
    if (!item) out.push({ type: 'p', spans });
    else if (last && last.type === kind && isListBlock(last)) last.items.push(spans);
    else out.push({ type: kind, items: [spans] });
  });
  return out;
}
