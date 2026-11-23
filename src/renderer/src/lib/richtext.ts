/**
 * Rich text edited on the canvas, back to the document's form.
 *
 * The preview renders a rich text value (an array of paragraphs with inline **strong** and *emphasis*) as
 * <p> or <li> elements holding <strong> and <em>. When an inline edit ends, the bridge sends a small copy of
 * what the editable element now holds (text, line breaks, blocks and bold/italic marks; see RichDomNode), and
 * this module turns it back into paragraphs. It is the only place that knows the paragraph format, so a later
 * structured rich text format only needs a new serializer here.
 */

/** A text node, or an element by tag name with its children. `b` and `i` carry an inline style's bold or
 *  italic (true) or its explicit removal (false), as the browser's own bold/italic commands can leave them. */
export type RichDomNode = string | { tag: string; b?: boolean; i?: boolean; children: RichDomNode[] };

const MAX_NODES = 5000;
const MAX_DEPTH = 16;
const MAX_TEXT = 20000;

/** Validate an untrusted copy from the preview; null when it is malformed or too large. */
export function richDom(v: unknown): RichDomNode[] | null {
  let budget = MAX_NODES;
  const ok = (n: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > MAX_DEPTH) return false;
    if (typeof n === 'string') return n.length <= MAX_TEXT;
    if (!n || typeof n !== 'object') return false;
    const e = n as Record<string, unknown>;
    return typeof e.tag === 'string' && e.tag.length <= 20 && (e.b === undefined || typeof e.b === 'boolean') && (e.i === undefined || typeof e.i === 'boolean') && list(e.children, depth + 1);
  };
  // Every index, holes included (every() would skip a hole and leave it to throw later).
  const list = (a: unknown, depth: number) => Array.isArray(a) && a.length <= MAX_NODES && Array.from(a).every((n) => ok(n, depth));
  return list(v, 0) ? (v as RichDomNode[]) : null;
}

const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'header', 'footer']);

interface Run {
  text: string;
  strong: boolean;
  em: boolean;
}

/** The paragraphs the edited element now holds, each in the inline **strong** / *emphasis* form. */
export function paragraphsFromDom(nodes: RichDomNode[]): string[] {
  const paras: Run[][] = [[]];
  const breakParagraph = () => {
    if (paras[paras.length - 1].length) paras.push([]);
  };
  const walk = (n: RichDomNode, strong: boolean, em: boolean) => {
    if (typeof n === 'string') {
      paras[paras.length - 1].push({ text: n, strong, em });
      return;
    }
    const tag = n.tag.toLowerCase();
    if (tag === 'br') return breakParagraph();
    const s = tag === 'strong' || tag === 'b' ? true : (n.b ?? strong);
    const e = tag === 'em' || tag === 'i' ? true : (n.i ?? em);
    const block = BLOCK.has(tag);
    if (block) breakParagraph();
    for (const c of n.children) walk(c, s, e);
    if (block) breakParagraph();
  };
  for (const n of nodes) walk(n, false, false);
  return paras.map(markdownOf).filter(Boolean);
}

/** One paragraph's runs as text with ** and * marks; whitespace collapsed the way the page shows it. */
function markdownOf(runs: Run[]): string {
  // Merge neighbours with the same marks, so "<b>a</b><b>b</b>" is one **ab**.
  const merged: Run[] = [];
  for (const r of runs) {
    const text = r.text.replace(/[\s ]+/g, ' ');
    const last = merged[merged.length - 1];
    if (last && last.strong === r.strong && last.em === r.em) last.text += text;
    else merged.push({ ...r, text });
  }
  // The format has no escape for an asterisk: with a literal one in the paragraph, a mark next to it could
  // pair with it and render as something else, so such a paragraph keeps its words and drops its marks.
  const literal = merged.some((r) => r.text.includes('*'));
  let out = '';
  for (const r of merged) {
    // Marks hug their words: spaces at a mark's edges move outside it.
    const lead = r.text.match(/^ */)![0];
    const core = r.text.trim();
    const trail = core ? r.text.match(/ *$/)![0] : '';
    // The format cannot nest marks: text that is both keeps the stronger one.
    const mark = !core || literal ? '' : r.strong ? '**' : r.em ? '*' : '';
    out += lead + mark + core + mark + trail;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** Two rich text values hold the same paragraphs. */
export function sameParagraphs(a: unknown, b: string[]): boolean {
  const list = Array.isArray(a) ? a.map(String) : typeof a === 'string' ? [a] : [];
  return list.length === b.length && list.every((p, i) => p === b[i]);
}
