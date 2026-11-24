import type { LinkValue } from './types';

/**
 * Structured rich text: the canonical stored form of every rich text value.
 *
 * Inline links hold a LinkValue, so a link to a page stores the page's ID and is counted, rewritten and validated
 * like any other link. Plain strings are only an input form (from the AI tools, the inspector and older documents).
 */

export interface RichSpan {
  text: string;
  strong?: boolean;
  em?: boolean;
  link?: LinkValue;
}
/** `h2` is kept only in collection entries' text, an article's own sections under its title (see normalizeRichText). */
export type RichTextBlockType = 'p' | 'h2' | 'h3' | 'h4' | 'blockquote';
export type RichListType = 'ul' | 'ol' | 'check';
export interface RichTextBlock {
  type: RichTextBlockType;
  spans: RichSpan[];
}
export interface RichListBlock {
  type: RichListType;
  items: RichSpan[][];
}
/**
 * A library picture between the paragraphs of an article, with its own description and an optional caption shown
 * under it. Kept only in collection entries' text. `alt` is kept while `decorative` is on, so turning it off again
 * brings the description back; a decorative picture is described as nothing on the page.
 */
export interface RichImageBlock {
  type: 'image';
  assetId: string;
  alt: string;
  caption?: string;
  decorative?: true;
}
export type RichBlock = RichTextBlock | RichListBlock | RichImageBlock;
export type RichText = RichBlock[];

const TEXT_BLOCKS: readonly string[] = ['p', 'h2', 'h3', 'h4', 'blockquote'];
const LIST_BLOCKS: readonly string[] = ['ul', 'ol', 'check'];

export const isListBlock = (b: RichBlock): b is RichListBlock => LIST_BLOCKS.includes(b.type);
export const isImageBlock = (b: RichBlock): b is RichImageBlock => b.type === 'image';

/** The runs of text a block holds: one per list item, the block's own, or none for a picture. */
export const spanRuns = (b: RichBlock): RichSpan[][] => (isListBlock(b) ? b.items : isImageBlock(b) ? [] : [b.spans]);

export function isRichBlock(v: unknown): v is RichBlock {
  if (!v || typeof v !== 'object') return false;
  const b = v as { type?: unknown; spans?: unknown; items?: unknown; assetId?: unknown; alt?: unknown; caption?: unknown; decorative?: unknown };
  if (typeof b.type !== 'string') return false;
  // A picture's fields are each what they claim to be: text damaged by a hand edit is no picture, and is reported.
  if (b.type === 'image') return typeof b.assetId === 'string' && (b.alt === undefined || typeof b.alt === 'string') && (b.caption === undefined || typeof b.caption === 'string') && (b.decorative === undefined || typeof b.decorative === 'boolean');
  return TEXT_BLOCKS.includes(b.type) ? Array.isArray(b.spans) : LIST_BLOCKS.includes(b.type) && Array.isArray(b.items);
}

/** Text of a picture's description or caption as a page shows it: one line, spaces collapsed. */
const oneLine = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Canonical spans
// ---------------------------------------------------------------------------

const sameMarks = (a: RichSpan, b: RichSpan) => !!a.strong === !!b.strong && !!a.em === !!b.em && JSON.stringify(a.link ?? null) === JSON.stringify(b.link ?? null);

function span(text: string, from: Partial<RichSpan> = {}): RichSpan {
  const out: RichSpan = { text };
  if (from.strong) out.strong = true;
  if (from.em) out.em = true;
  if (from.link) out.link = from.link;
  return out;
}

/**
 * One canonical run of spans: whitespace collapsed the way a page shows it, spaces and line breaks moved outside
 * marks and links, neighbours with the same marks merged, and nothing empty. Equal content always has equal spans.
 *
 * A line feed is a line break inside the block (Shift+Enter; `<br>` on the page). Breaks are kept where they are,
 * at the start and end of a block too, so the page shows exactly the lines the writer typed; spaces next to one are
 * dropped, as a page drops them. A run with no words, only spaces and breaks, is empty.
 */
export function cleanSpans(spans: RichSpan[]): RichSpan[] {
  const mergeInto = (out: RichSpan[], p: RichSpan) => {
    const last = out[out.length - 1];
    if (last && sameMarks(last, p)) last.text += p.text;
    else out.push(span(p.text, p));
  };
  // Neighbours with the same marks first, so a break typed inside bold words (`<strong>a<br>b</strong>`) stays in them.
  const runs: RichSpan[] = [];
  for (const s of spans) {
    if (!s || typeof s !== 'object') continue;
    // Only what HTML itself collapses: a non-breaking space ("10 kg") is deliberate.
    const text = String(s.text ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t\r\f]+/g, ' ');
    if (text) mergeInto(runs, { ...s, text });
  }
  const merged: RichSpan[] = [];
  for (const r of runs) {
    if (!r.strong && !r.em && !r.link) {
      mergeInto(merged, r);
      continue;
    }
    // The spaces and breaks at either end, found with one scan from each end (a run of breaks stays linear).
    const t = r.text;
    let a = 0;
    let b = t.length;
    while (a < b && (t[a] === ' ' || t[a] === '\n')) a++;
    while (b > a && (t[b - 1] === ' ' || t[b - 1] === '\n')) b--;
    if (a) mergeInto(merged, { text: t.slice(0, a) });
    if (b > a) mergeInto(merged, span(t.slice(a, b), r));
    if (b < t.length) mergeInto(merged, { text: t.slice(b) });
  }
  if (!merged.some((s) => /[^ \n]/.test(s.text))) return [];
  // A space is never doubled across a mark boundary or kept beside a break, and a run neither starts nor ends with one.
  for (let i = 0; i < merged.length; i++) {
    merged[i].text = merged[i].text.replace(/ {2,}/g, ' ').replace(/ ?\n ?/g, '\n');
    if (i === 0) continue;
    if (/[ \n]$/.test(merged[i - 1].text)) merged[i].text = merged[i].text.replace(/^ /, '');
    if (merged[i].text.startsWith('\n')) merged[i - 1].text = merged[i - 1].text.replace(/ $/, '');
  }
  if (merged.length) merged[0].text = merged[0].text.replace(/^ /, '');
  if (merged.length) merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/ $/, '');
  return merged.filter((s) => s.text);
}

/** Canonical blocks: empty blocks and list items are gone. */
export function cleanBlocks(blocks: RichBlock[]): RichText {
  const out: RichText = [];
  for (const b of blocks) {
    if (isImageBlock(b)) {
      if (typeof b.assetId !== 'string' || !b.assetId) continue;
      const img: RichImageBlock = { type: 'image', assetId: b.assetId, alt: oneLine(b.alt) };
      const caption = oneLine(b.caption);
      if (caption) img.caption = caption;
      if (b.decorative) img.decorative = true;
      out.push(img);
    } else if (isListBlock(b)) {
      const items = b.items.map((it) => (Array.isArray(it) ? cleanSpans(it) : [])).filter((it) => it.length);
      if (items.length) out.push({ type: b.type, items });
    } else {
      const spans = cleanSpans(b.spans);
      if (spans.length) out.push({ type: b.type, spans });
    }
  }
  return out;
}

export const sameRichText = (a: RichText, b: RichText) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Links as text
// ---------------------------------------------------------------------------

export type RichPages = Record<string, { id: string; route: string }>;

const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const TEL_RE = /^[+0-9 ().-]{3,30}$/;
const ANCHOR_RE = /^[A-Za-z][\w-]*$/;

/** A telephone number as a tel: link takes it: digits and the usual separators, with at least three digits to dial. */
export const isTelephone = (t: string): boolean => TEL_RE.test(t) && (t.match(/\d/g)?.length ?? 0) >= 3;

/**
 * A link written as text or read from an href: a full http(s) URL, mailto:, tel:, #anchor, a page route (with an
 * optional #anchor) or a page ID. Null for anything else, javascript: and other schemes included.
 */
export function linkFromTarget(raw: string, pages: RichPages, newTab = false): LinkValue | null {
  const t = raw.trim();
  const tab = newTab ? { newTab: true } : {};
  if (/^https?:/i.test(t)) return URL_RE.test(t) ? { type: 'url', target: t, ...tab } : null;
  if (/^mailto:/i.test(t)) return EMAIL_RE.test(t.slice(7)) ? { type: 'email', target: t.slice(7), ...tab } : null;
  if (/^tel:/i.test(t)) return isTelephone(t.slice(4)) ? { type: 'tel', target: t.slice(4), ...tab } : null;
  if (t.startsWith('#')) return ANCHOR_RE.test(t.slice(1)) ? { type: 'anchor', target: t.slice(1), ...tab } : null;
  const hash = t.indexOf('#');
  const path = hash < 0 ? t : t.slice(0, hash);
  const anchor = hash < 0 ? '' : t.slice(hash + 1);
  if (hash >= 0 && !ANCHOR_RE.test(anchor)) return null;
  const anchored = anchor ? { anchor } : {};
  if (Object.hasOwn(pages, path)) return { type: 'page', target: path, ...anchored, ...tab };
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const wanted = path === '/' ? '/' : `/${path.replace(/^\/+|\/+$/g, '')}/`;
  const page = Object.values(pages).find((p) => p.route === wanted);
  return page ? { type: 'page', target: page.id, ...anchored, ...tab } : null;
}

/** How a link reads as text: pages by their route, which stays readable and maps back to the same page ID. */
export function linkToTarget(link: LinkValue, pages: RichPages): string {
  switch (link.type) {
    case 'page':
      return (Object.hasOwn(pages, link.target) ? pages[link.target].route : link.target) + (link.anchor ? `#${link.anchor}` : '');
    case 'email':
      return `mailto:${link.target}`;
    case 'tel':
      return `tel:${link.target}`;
    case 'anchor':
      return `#${link.target}`;
    case 'entry':
      return `${ENTRY_LINK_PREFIX}${link.target}`;
    default:
      return link.target;
  }
}

/** How a link to a collection entry is written as text: `entry:` and the entry's ID, which never changes. */
export const ENTRY_LINK_PREFIX = 'entry:';

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Read list, heading and quote markers, links and backslash escapes. Without it only ** and * are read. */
  markdown?: boolean;
  /** Resolves a [label](target); null leaves the text as written. */
  link?: (target: string, newTab: boolean) => LinkValue | null;
  /** Lines without a block marker become items of this kind of list. */
  plainAs?: RichListType;
  /** Read "## " as a section heading (h2), as a collection entry's text has them. */
  articles?: boolean;
}

const ESCAPABLE = '\\*[]#>+-.)';
/** `\|` reads as nothing: it separates two marked runs that touch, and at a line's start means "a plain paragraph". */
const SEPARATOR = '\\|';
const MAX_MARK_DEPTH = 4;
// An address in <…> may hold spaces (a phone number written with them) or brackets.
const LINK_RE = /\[((?:\\.|[^[\]\\])+)\]\(\s*(?:<([^<>\n]+)>|((?:[^\s()]|\([^\s()]*\))+))(\s+"new tab")?\s*\)/y;

/** Where the closing run for an opening run of `n` asterisks starts, or -1. */
function findClose(text: string, from: number, n: number, escapes: boolean): number {
  let stars = 0;
  for (let i = from; i < text.length; ) {
    if (escapes && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] !== '*') {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === '*') end++;
    const run = end - i;
    if (i > from && !/\s/.test(text[i - 1])) {
      if (run === n) return i;
      if (run === 3 && n < 3) {
        // "**a *b***" also closes an inner mark, so this mark takes the end of the run. With nothing open
        // inside ("**a***b*"), it takes the start and the rest opens the next mark.
        const inner = 3 - n;
        return stars % (2 * inner) === inner ? end - n : i;
      }
    }
    stars += run;
    i = end;
  }
  return -1;
}

function parseInline(text: string, marks: Partial<RichSpan>, opts: ParseOptions, depth = 0): RichSpan[] {
  const escapes = !!opts.markdown;
  const out: RichSpan[] = [];
  // A run with no closer from here has none from anywhere later, so hostile input stays linear.
  const unclosed = new Set<number>();
  let buf = '';
  const flush = () => {
    if (buf) out.push(span(buf, marks));
    buf = '';
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (escapes && c === '\\' && text[i + 1] === '|') {
      i += 2;
      continue;
    }
    if (escapes && c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '*') {
      let end = i;
      while (text[end] === '*') end++;
      const run = end - i;
      const canOpen = depth < MAX_MARK_DEPTH && run <= 3 && end < text.length && !/\s/.test(text[end]) && !unclosed.has(run);
      const close = canOpen ? findClose(text, end, run, escapes) : -1;
      if (close < 0) {
        if (canOpen) unclosed.add(run);
        buf += text.slice(i, end);
        i = end;
        continue;
      }
      flush();
      const inner = { ...marks, ...(run >= 2 ? { strong: true } : {}), ...(run !== 2 ? { em: true } : {}) };
      out.push(...parseInline(text.slice(end, close), inner, opts, depth + 1));
      i = close + run;
      continue;
    }
    if (c === '[' && opts.markdown && opts.link && depth < MAX_MARK_DEPTH) {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(text);
      const link = m ? opts.link(m[2] ?? m[3], !!m[4]) : null;
      if (m && link) {
        flush();
        const end = i + m[0].length;
        out.push(...parseInline(m[1], { ...marks, link }, opts, depth + 1));
        i = end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// A marker is followed by spaces, never by a line break: a block that starts with a break keeps it.
const LINE_MARKERS: Array<{ re: RegExp; type: RichTextBlockType | RichListType }> = [
  { re: /^####[^\S\n]+/, type: 'h4' },
  { re: /^###[^\S\n]+/, type: 'h3' },
  { re: /^>[^\S\n]?/, type: 'blockquote' },
  { re: /^[-*+][^\S\n]+\[[ xX]\][^\S\n]+/, type: 'check' },
  { re: /^[-*+][^\S\n]+/, type: 'ul' },
  { re: /^\d+[.)][^\S\n]+/, type: 'ol' }
];
/** An article's own section heading, read only where `articles` is set (see ParseOptions). */
const H2_MARKER = { re: /^##[^\S\n]+/, type: 'h2' as const };

/** A line ending in an odd run of backslashes (the last one not escaped) goes on in the next, after a line break. */
const BREAK_AT_END = /(?:^|[^\\])(?:\\\\)*\\$/;
/** Whether a line of the text form goes on in the next one, after a line break (it ends in an unescaped backslash). */
export const endsWithBreak = (line: string) => BREAK_AT_END.test(line.trimEnd());

/**
 * The lines of one string. With `markdown`, a line ending in a backslash goes on in the next line of the same
 * string, after a line break, as a Markdown hard break does; one block can hold several lines (an address).
 */
function textLines(input: string, markdown: boolean): string[] {
  const out: string[] = [];
  /** The lines of the block being read, each without its closing backslash; null between blocks. */
  let open: string[] | null = null;
  for (const raw of input.split(/\r?\n/)) {
    // A line that goes on from a break keeps a deliberate space at its start (a non-breaking one).
    const line: string = open === null ? raw.trim() : raw.replace(/^[ \t]+/, '').trimEnd();
    const goesOn: boolean = markdown && BREAK_AT_END.test(line);
    const piece: string = goesOn ? line.slice(0, -1) : line;
    if (open === null) open = [piece];
    else open.push(piece);
    if (!goesOn) {
      out.push(open.join('\n'));
      open = null;
    }
  }
  // A break at the very end: the line it starts is empty.
  if (open !== null) out.push(`${open.join('\n')}\n`);
  return out;
}

/** A link written in a line of the text form: `[label](target)`, with where its parts start and end. */
export interface LinkToken {
  start: number;
  end: number;
  labelStart: number;
  labelEnd: number;
  /** The destination as written, without angle brackets. */
  target: string;
  newTab: boolean;
}

/**
 * The links in one line of the text form, read as parseRichText reads them: escaped characters are skipped, and
 * `[label](target)` is a link only when `resolve` accepts its target (anything else stays text as written).
 */
export function linkTokens(line: string, resolve: (target: string, newTab: boolean) => LinkValue | null): LinkToken[] {
  const out: LinkToken[] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] === '\\' && i + 1 < line.length && (ESCAPABLE.includes(line[i + 1]) || line[i + 1] === '|')) {
      i += 2;
      continue;
    }
    if (line[i] === '[') {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(line);
      const target = m ? (m[2] ?? m[3]) : '';
      if (m && resolve(target, !!m[4])) {
        out.push({ start: i, end: i + m[0].length, labelStart: i + 1, labelEnd: i + 1 + m[1].length, target, newTab: !!m[4] });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Text as blocks. One line is one block; neighbouring items of the same kind of list join one list. */
export function parseRichText(input: string | string[], opts: ParseOptions = {}): RichText {
  const lines = (Array.isArray(input) ? input : [input]).flatMap((s) => textLines(String(s), !!opts.markdown)).filter(Boolean);
  const blocks: RichBlock[] = [];
  const addItem = (type: RichListType, spans: RichSpan[]) => {
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) (last as RichListBlock).items.push(spans);
    else blocks.push({ type, items: [spans] });
  };
  for (const line of lines) {
    const plain = !!opts.markdown && line.startsWith(SEPARATOR);
    const marker = opts.markdown && !plain ? (opts.articles && H2_MARKER.re.test(line) ? H2_MARKER : LINE_MARKERS.find((m) => m.re.test(line))) : undefined;
    const body = plain ? line.slice(SEPARATOR.length) : marker ? line.replace(marker.re, '') : line;
    const spans = parseInline(body, {}, opts);
    const type = marker?.type ?? (plain ? 'p' : (opts.plainAs ?? 'p'));
    if (LIST_BLOCKS.includes(type)) addItem(type as RichListType, spans);
    else blocks.push({ type: type as RichTextBlockType, spans });
  }
  return cleanBlocks(blocks);
}

/**
 * Any stored value as blocks, without failing: canonical blocks stay as they are, and strings from a document
 * written before structured rich text are read for their ** and * marks only.
 */
export function toRichText(v: unknown, plainAs?: RichListType): RichText {
  if (typeof v === 'string') return parseRichText(v.split(/\n{2,}/), { plainAs });
  if (!Array.isArray(v)) return [];
  const blocks: RichBlock[] = [];
  for (const x of v) {
    if (isRichBlock(x)) blocks.push(x);
    else if (typeof x === 'string') blocks.push(...parseRichText(x, { plainAs }));
  }
  return mergeLists(cleanBlocks(blocks));
}

/**
 * Rich text as a node with `paragraphList` shows it: one list of `kind`, whose items are the paragraphs and the
 * items of lists of that kind. Text holding anything else (a heading, a quote, another kind of list) is unchanged.
 */
export function asParagraphList(blocks: RichText, kind: RichListType): RichText {
  const items: RichSpan[][] = [];
  for (const b of blocks) {
    if (b.type === 'p') items.push(b.spans);
    else if (b.type === kind && isListBlock(b)) items.push(...b.items);
    else return blocks;
  }
  return items.length ? [{ type: kind, items }] : blocks;
}

/** Neighbouring lists of the same kind are one list. */
export function mergeLists(blocks: RichText): RichText {
  const out: RichText = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && isListBlock(b) && last.type === b.type) (last as RichListBlock).items.push(...b.items);
    else out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

const spansText = (spans: RichSpan[]) => spans.map((s) => s.text).join('');

/** What a picture says in words: its caption, or else its description (none when it is decorative). */
const imageWords = (b: RichImageBlock) => b.caption || (b.decorative ? '' : b.alt);

/** The words alone, for places that only hold plain text. */
export function richTextToPlain(blocks: RichText): string {
  return blocks
    .map((b) => (isListBlock(b) ? b.items.map(spansText).join('\n') : isImageBlock(b) ? imageWords(b) : spansText(b.spans)))
    .filter(Boolean)
    .join('\n\n');
}

/** A line break inside a block ends its line with a backslash, and the block goes on in the next line. */
function escapeInline(text: string): string {
  return text.replace(/[\\*[\]]/g, '\\$&').replace(/\n/g, '\\\n');
}

/** A line that would read as a block marker keeps its first character literal. */
export function escapeLineStart(line: string): string {
  return line.replace(/^(#{2,4}\s|>|[-+]\s)/, '\\$1').replace(/^(\d+)([.)]\s)/, '$1\\$2');
}

/** A link's destination as the text form writes it: in angle brackets when it holds a bracket or a space. */
export const targetToMarkdown = (target: string) => (/[()\s]/.test(target) ? `<${target}>` : target);

function spansToMarkdown(spans: RichSpan[], pages: RichPages): string {
  const marked = (s: RichSpan | undefined) => !!s && !s.link && !!(s.strong || s.em);
  return spans
    .map((s, i) => {
      const mark = s.strong && s.em ? '***' : s.strong ? '**' : s.em ? '*' : '';
      const body = `${mark}${escapeInline(s.text)}${mark}`;
      const gap = marked(s) && marked(spans[i - 1]) ? SEPARATOR : '';
      if (!s.link) return gap + body;
      const target = linkToTarget(s.link, pages);
      return `[${body}](${targetToMarkdown(target)}${s.link.newTab ? ' "new tab"' : ''})`;
    })
    .join('');
}

/** One string per paragraph or list item with ** and * marks: the form older code components were written for. */
export function richTextToParagraphs(blocks: RichText): string[] {
  const line = (spans: RichSpan[]) => spans.map((s) => (s.strong ? `**${s.text}**` : s.em ? `*${s.text}*` : s.text)).join('');
  return blocks.flatMap((b) => (isListBlock(b) ? b.items.map(line) : isImageBlock(b) ? [] : [line(b.spans)]));
}

/** The small text form the inspector edits and the AI reads; parseRichText with `markdown` reads it back. */
export function richTextToMarkdown(blocks: RichText, pages: RichPages, plainAs?: RichListType): string {
  const line = (spans: RichSpan[]) => escapeLineStart(spansToMarkdown(spans, pages));
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'ul':
          return b.items.map((it) => `- ${spansToMarkdown(it, pages)}`).join('\n');
        case 'check':
          return b.items.map((it) => `- [x] ${spansToMarkdown(it, pages)}`).join('\n');
        case 'ol':
          return b.items.map((it, i) => `${i + 1}. ${spansToMarkdown(it, pages)}`).join('\n');
        case 'h2':
          return `## ${spansToMarkdown(b.spans, pages)}`;
        case 'h3':
          return `### ${spansToMarkdown(b.spans, pages)}`;
        case 'h4':
          return `#### ${spansToMarkdown(b.spans, pages)}`;
        case 'blockquote':
          return `> ${spansToMarkdown(b.spans, pages)}`;
        case 'image':
          // For reading only: a picture is placed with the library picker, never typed.
          return `![${escapeInline(b.decorative ? '' : b.alt)}](asset:${b.assetId}${b.caption ? ` "${b.caption.replace(/"/g, "'")}"` : ''})`;
        default:
          // Where a plain line would become a list item, a paragraph says that it is one.
          return (plainAs ? SEPARATOR : '') + line(b.spans);
      }
    })
    .join('\n\n');
}
