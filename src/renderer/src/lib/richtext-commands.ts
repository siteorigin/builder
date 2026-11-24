/**
 * The Inspector's formatting commands for a rich text field, as changes to its text form (see shared/richtext.ts):
 * links on selected words, bulleted and numbered lists, and adding, removing and moving list items. Each command
 * is one replacement of part of the text, so the field can apply it as one step its own Undo can take back.
 */
import type { LinkValue } from '@shared/types';
import { cleanBlocks, endsWithBreak, escapeLineStart, isListBlock, linkFromTarget, linkTokens, linkToTarget, parseRichText, sameRichText, targetToMarkdown, type LinkToken, type RichBlock, type RichListType, type RichPages, type RichSpan } from '@shared/richtext';

/** One replacement of `text.slice(from, to)` by `insert`, and the selection to show after it. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  /** The selection after the edit, in the new text. */
  start: number;
  end: number;
}

/** Where the selection is: the text, its selected range, and how the field reads plain lines. */
export interface TextAt {
  text: string;
  start: number;
  end: number;
  plainAs?: RichListType;
}

type ListKind = 'ul' | 'ol' | 'check';
interface Line {
  index: number;
  from: number;
  to: number;
  text: string;
  /** The block marker the line starts with ("- ", "1. ", "### "), or "" for none. */
  marker: string;
  /** The kind of list item the line is, if any. */
  kind: ListKind | null;
}

// As the parser reads them: a marker is followed by spaces, never by a line break.
const ITEM_MARKERS: Array<{ re: RegExp; kind: ListKind }> = [
  { re: /^[-*+][^\S\n]+\[[ xX]\][^\S\n]+/, kind: 'check' },
  { re: /^[-*+][^\S\n]+/, kind: 'ul' },
  { re: /^\d+[.)][^\S\n]+/, kind: 'ol' }
];
const BLOCK_MARKER = /^(####[^\S\n]+|###[^\S\n]+|>[^\S\n]?|\\\|)/;

/**
 * The text's blocks, one per line: a line ending in a backslash goes on in the next, after a line break, so one
 * block (an address, say) can span several lines of the text.
 */
function lines(text: string, plainAs?: RichListType): Line[] {
  const out: Line[] = [];
  let from = 0;
  let open: Line | null = null;
  for (const raw of text.split('\n')) {
    if (open) {
      open.text += `\n${raw}`;
      open.to = from + raw.length;
    } else {
      const lead = raw.length - raw.trimStart().length;
      const body = raw.slice(lead);
      const item = ITEM_MARKERS.find((m) => m.re.test(body));
      const block = item ? null : BLOCK_MARKER.exec(body);
      const marker = raw.slice(0, lead) + (item ? body.match(item.re)![0] : block ? block[0] : '');
      // In a field that shows plain lines as a list, a line with no marker is one of its items.
      const kind = item ? item.kind : !block && body.trim() && plainAs ? plainAs : null;
      open = { index: out.length, from, to: from + raw.length, text: raw, marker, kind };
      out.push(open);
    }
    if (!endsWithBreak(raw)) open = null;
    from += raw.length + 1;
  }
  return out;
}

const lineAt = (ls: Line[], offset: number) => ls.find((l) => offset <= l.to) ?? ls[ls.length - 1];

/** The lines a selection covers; one that ends at the very start of a line leaves that line out. */
function selectedLines(ls: Line[], start: number, end: number): Line[] {
  const first = lineAt(ls, start);
  let last = lineAt(ls, end);
  if (end > start && last.index > first.index && end === last.from) last = ls[last.index - 1];
  return ls.slice(first.index, last.index + 1);
}

/** The text after a line's marker: what stays when it changes kind. */
const content = (l: Line) => l.text.slice(l.marker.length);

/** One edit that replaces whole lines `first..last` with `next`. */
function replaceLines(text: string, ls: Line[], first: number, last: number, next: string[], select: [number, number]): TextEdit {
  const from = ls[first].from;
  const to = ls[last].to;
  const insert = next.join('\n');
  const startOf = (i: number) => from + next.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const [a, b] = select;
  return { from, to, insert, start: startOf(a), end: startOf(b) + next[b].length };
}

/**
 * The items of the list `l` is in: the neighbouring lines of the same kind, across blank lines, which the text form
 * reads as nothing (two items with a blank line between them are one list once saved).
 */
function listAround(ls: Line[], l: Line): Line[] {
  if (!l.kind) return [];
  const out = [l];
  const joins = (x: Line) => x.kind === l.kind || !x.text.trim();
  for (let i = l.index - 1; i >= 0 && joins(ls[i]); i--) if (ls[i].text.trim()) out.unshift(ls[i]);
  for (let i = l.index + 1; i < ls.length && joins(ls[i]); i++) if (ls[i].text.trim()) out.push(ls[i]);
  return out;
}

const markerFor = (kind: ListKind, n: number) => (kind === 'ol' ? `${n}. ` : kind === 'check' ? '- [x] ' : '- ');

/** A numbered list's items numbered in order again, after one was added, removed or moved. */
function renumber(items: string[], kind: ListKind): string[] {
  if (kind !== 'ol') return items;
  return items.map((t, i) => t.replace(/^(\s*)\d+([.)])/, `$1${i + 1}$2`));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** What the list commands can do where the selection is. */
export interface ListState {
  /** Every selected line is an item of this kind of list. */
  kind: ListKind | null;
  /** The selection starts in a list item. */
  item: boolean;
  up: boolean;
  down: boolean;
}

export function listState({ text, start, end, plainAs }: TextAt): ListState {
  const ls = lines(text, plainAs);
  const sel = selectedLines(ls, start, end).filter((l) => l.text.trim());
  const kinds = new Set(sel.map((l) => l.kind));
  const at = lineAt(ls, start);
  const list = listAround(ls, at);
  const i = list.indexOf(at);
  return { kind: sel.length && kinds.size === 1 ? (sel[0].kind ?? null) : null, item: !!at.kind, up: i > 0, down: i >= 0 && i < list.length - 1 };
}

/**
 * The selected lines as a list of `kind`, or, when they already are one, as paragraphs again. A line keeps its
 * words, marks and links; only its marker changes. A selection inside one list of the other kind switches the
 * whole list, as a word processor does. The selection stays on the same words.
 */
export function toggleList(at: TextAt, kind: 'ul' | 'ol'): TextEdit | null {
  return numbered(at.text, toggleListLines(at, kind), at.plainAs);
}
function toggleListLines(at: TextAt, kind: 'ul' | 'ol'): TextEdit | null {
  const ls = lines(at.text, at.plainAs);
  const sel = selectedLines(ls, at.start, at.end);
  const filled = sel.filter((l) => l.text.trim());
  // A line apart from its neighbours (a paragraph, or a list next to other blocks) has a blank line between them,
  // as the field saves it, so the text does not change under the caret once it is saved.
  const apart = (x: Line | undefined) => !!x && !!x.text.trim() && x.kind !== kind;
  if (!filled.length) {
    // An empty line starts the list with one item, its words selected to type over: a marker alone would be saved
    // as a paragraph of its own.
    const l = sel[0];
    const before = apart(ls[l.index - 1]) ? '\n' : '';
    const words = 'New item';
    const insert = before + markerFor(kind, 1) + words + (apart(ls[l.index + 1]) ? '\n' : '');
    const start = l.from + before.length + markerFor(kind, 1).length;
    return { from: l.from, to: l.to, insert, start, end: start + words.length };
  }
  const off = filled.every((l) => l.kind === kind);
  const run = off ? [] : listAround(ls, filled[0]);
  // The lines that change, in order. Items of a new list are one line each, so blank lines between them go.
  let src = run.length && filled.every((l) => run.includes(l)) ? run : off ? sel : filled;
  while (!src[0].text.trim()) src = src.slice(1);
  while (!src[src.length - 1].text.trim()) src = src.slice(0, -1);
  const first = src[0];
  const last = src[src.length - 1];
  let n = 0;
  const next = src.map((l, k) => {
    if (!l.text.trim()) return l.text;
    const words = content(l);
    const prev = k > 0 ? src[k - 1] : ls[l.index - 1];
    if (!off) return (k === 0 && apart(prev) ? '\n' : '') + markerFor(kind, ++n) + words;
    // A paragraph in a field that shows plain lines as a list says it is one.
    const para = at.plainAs ? `\\|${words}` : escapeLineStart(words);
    return (prev && prev.text.trim() ? '\n' : '') + para;
  });
  const e = replaceLines(at.text, ls, first.index, last.index, next, [0, next.length - 1]);
  const after = ls[last.index + 1];
  if (after && after.text.trim() && (off || after.kind !== kind)) e.insert += '\n';
  // Where an offset in the old text is now: the same place in the line's words, after its new marker.
  const starts = next.map((_, k) => e.from + next.slice(0, k).reduce((sum, t) => sum + t.length + 1, 0));
  const place = (x: number) => {
    if (x < first.from) return x;
    const k = src.findIndex((l) => x <= l.to);
    if (k < 0) return x - e.to + e.from + e.insert.length;
    const l = src[k];
    const marker = next[k].length - content(l).length;
    return Math.min(starts[k] + next[k].length, starts[k] + marker + Math.max(0, x - l.from - l.marker.length));
  };
  return { ...e, start: place(at.start), end: place(at.end) };
}

/**
 * A list command's edit with every numbered list numbered in order, as the field saves it (a numbered list split
 * in two starts again at 1; two that now touch are one), so the text does not change under the caret once saved.
 * The selection keeps its place in the words.
 */
function numbered(text: string, e: TextEdit | null, plainAs?: RichListType): TextEdit | null {
  if (!e) return null;
  const mid = applyTextEdit(text, e);
  const ls = lines(mid, plainAs);
  let n = 0;
  let inList = false;
  const out = ls.map((l) => {
    if (!l.text.trim()) return { l, text: l.text, marker: l.marker.length, now: l.marker.length };
    if (l.kind !== 'ol') {
      inList = false;
      return { l, text: l.text, marker: l.marker.length, now: l.marker.length };
    }
    n = inList ? n + 1 : 1;
    inList = true;
    const marker = l.marker.replace(/\d+/, String(n));
    return { l, text: marker + content(l), marker: l.marker.length, now: marker.length };
  });
  const final = out.map((o) => o.text).join('\n');
  if (final === mid) return e;
  const place = (x: number) => {
    let start = 0;
    for (const o of out) {
      if (x <= o.l.to) {
        const at = x - o.l.from;
        return start + (at <= o.marker ? Math.min(at, o.now) : at - o.marker + o.now);
      }
      start += o.text.length + 1;
    }
    return final.length;
  };
  let a = 0;
  while (a < text.length && a < final.length && text[a] === final[a]) a++;
  let b = 0;
  while (b < text.length - a && b < final.length - a && text[text.length - 1 - b] === final[final.length - 1 - b]) b++;
  return { from: a, to: text.length - b, insert: final.slice(a, final.length - b), start: place(e.start), end: place(e.end) };
}

/** A new item after the one the selection is in, with its words selected so typing replaces them. */
export function addItem(at: TextAt, words = 'New item'): TextEdit | null {
  return numbered(at.text, addItemLines(at, words), at.plainAs);
}
function addItemLines(at: TextAt, words: string): TextEdit | null {
  const ls = lines(at.text, at.plainAs);
  const l = lineAt(ls, at.start);
  if (!l.kind) return null;
  const list = listAround(ls, l);
  const i = list.indexOf(l);
  const marker = l.kind === 'ol' ? markerFor('ol', i + 2) : l.marker || (at.plainAs ? '' : markerFor(l.kind, 0));
  const items = list.map((x) => x.text);
  items.splice(i + 1, 0, marker + words);
  const next = renumber(items, l.kind);
  const e = replaceLines(at.text, ls, list[0].index, list[list.length - 1].index, next, [i + 1, i + 1]);
  return { ...e, start: e.end - words.length };
}

/** The item the selection is in, gone; the caret goes to the end of the item before it, or the start of the next. */
export function removeItem(at: TextAt): TextEdit | null {
  return numbered(at.text, removeItemLines(at), at.plainAs);
}
function removeItemLines(at: TextAt): TextEdit | null {
  const ls = lines(at.text, at.plainAs);
  const l = lineAt(ls, at.start);
  if (!l.kind) return null;
  const list = listAround(ls, l);
  const i = list.indexOf(l);
  const items = list.map((x) => x.text);
  items.splice(i, 1);
  const next = renumber(items, l.kind);
  const first = list[0].index;
  const last = list[list.length - 1].index;
  if (!next.length) {
    // The list's only item: the line goes, and so does the line break that kept it apart.
    const from = l.index > 0 ? ls[l.index - 1].to : l.from;
    const to = l.index > 0 ? l.to : Math.min(at.text.length, l.to + 1);
    return { from, to, insert: '', start: from, end: from };
  }
  const e = replaceLines(at.text, ls, first, last, next, [Math.max(0, i - 1), Math.max(0, i - 1)]);
  const caret = i > 0 ? e.end : e.start + (next[0].match(/^\s*(\d+[.)]\s+|[-*+]\s+(\[[ xX]\]\s+)?)/)?.[0].length ?? 0);
  return { ...e, start: caret, end: caret };
}

/** The item the selection is in, swapped with the one before (-1) or after (1) it in the same list. */
export function moveItem(at: TextAt, dir: -1 | 1): TextEdit | null {
  return numbered(at.text, moveItemLines(at, dir), at.plainAs);
}
function moveItemLines(at: TextAt, dir: -1 | 1): TextEdit | null {
  const ls = lines(at.text, at.plainAs);
  const l = lineAt(ls, at.start);
  const list = listAround(ls, l);
  const i = list.indexOf(l);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  const items = list.map((x) => x.text);
  [items[i], items[j]] = [items[j], items[i]];
  const next = renumber(items, l.kind!);
  const e = replaceLines(at.text, ls, list[0].index, list[list.length - 1].index, next, [j, j]);
  // The caret stays at the same place in the item's words.
  const lineStart = e.start;
  const shift = next[j].length - l.text.length;
  const keep = (x: number) => Math.min(lineStart + next[j].length, Math.max(lineStart, lineStart + (x - l.from) + shift));
  return { ...e, start: keep(at.start), end: keep(Math.min(at.end, l.to)) };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * A link the selection is in or covers, or the words a new link would hold. A link over words with different marks
 * is written as one link each, side by side with only spaces between them: `tokens` holds all of them.
 */
export type LinkAt = { kind: 'link'; tokens: LinkToken[]; line: number } | { kind: 'words'; from: number; to: number } | null;

/**
 * Typed destinations as the canvas link field reads them: an email address gets mailto:, a phone number tel: (an
 * address of four dotted numbers stays a web address), and a bare domain https://. Null when it is nothing a link
 * can go to.
 */
export function typedLink(raw: string, pages: RichPages, newTab = false): LinkValue | null {
  const text = raw.trim();
  if (!text) return null;
  const href = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(text) ? `mailto:${text}` : /^\+?\(?\d[\d ().-]{5,}$/.test(text) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? `tel:${text}` : /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(text) ? `https://${text}` : text;
  return linkFromTarget(href, pages, newTab);
}

export function linkAt({ text, start, end, plainAs }: TextAt, pages: RichPages): LinkAt {
  const ls = lines(text, plainAs);
  const l = lineAt(ls, start);
  const tokens = linkTokens(l.text, (t, n) => linkFromTarget(t, pages, n));
  const i = tokens.findIndex((t) => start - l.from < t.end && end - l.from > t.start && (start === end ? start - l.from > t.start : true));
  if (i >= 0) {
    // Which marks a link's words carry: one link over words with the same marks is a single token, so neighbouring
    // tokens with the same marks are two links.
    const marks = (t: LinkToken) => l.text.slice(t.labelStart, t.labelEnd).replace(/\\./g, '').replace(/[^*]/g, '');
    const same = (a: LinkToken, b: LinkToken, gap: string) => a.target === b.target && a.newTab === b.newTab && !gap.trim() && marks(a) !== marks(b);
    let a = i;
    let b = i;
    while (a > 0 && same(tokens[a - 1], tokens[a], l.text.slice(tokens[a - 1].end, tokens[a].start))) a--;
    while (b < tokens.length - 1 && same(tokens[b + 1], tokens[b], l.text.slice(tokens[b].end, tokens[b + 1].start))) b++;
    return { kind: 'link', tokens: tokens.slice(a, b + 1), line: l.index };
  }
  if (start === end || end > l.to) return null;
  // Words only: never the line's marker, and never the spaces around them.
  let from = Math.max(start, l.from + l.marker.length);
  let to = end;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return to > from ? { kind: 'words', from, to } : null;
}

/** A line's blocks with their words and marks, links left out: what a link command must never change. */
function words(line: string, pages: RichPages, plainAs?: RichListType) {
  const strip = (spans: RichSpan[]) => spans.map(({ link: _link, ...rest }) => rest);
  const blocks = parseRichText(line, { markdown: true, link: (t, n) => linkFromTarget(t, pages, n), plainAs });
  return cleanBlocks(blocks.map((b): RichBlock => (isListBlock(b) ? { type: b.type, items: b.items.map(strip) } : { type: b.type, spans: strip(b.spans) })));
}

/** One edit that replaces part of a line, if it leaves the line's words, marks and blocks as they were. */
function lineEdit(l: Line, from: number, to: number, insert: string, pages: RichPages, plainAs?: RichListType): TextEdit | null {
  const line = l.text.slice(0, from) + insert + l.text.slice(to);
  if (!sameRichText(words(line, pages, plainAs), words(l.text, pages, plainAs))) return null;
  return { from: l.from + from, to: l.from + to, insert, start: l.from + from, end: l.from + from + insert.length };
}

/**
 * The selected words linked to `link`, or the link the selection is in pointed at `link` instead (its words and
 * "new tab" kept). A string says why it can't be done.
 */
export function setLink(at: TextAt, pages: RichPages, link: LinkValue): TextEdit | string {
  const found = linkAt(at, pages);
  if (!found) return 'Select the words to link first.';
  const target = targetToMarkdown(linkToTarget(link, pages));
  const ls = lines(at.text, at.plainAs);
  if (found.kind === 'link') {
    const l = ls[found.line];
    const run = found.tokens;
    const insert = run.map((t, k) => `${k ? l.text.slice(run[k - 1].end, t.start) : ''}${l.text.slice(t.start, t.labelEnd)}](${target}${t.newTab ? ' "new tab"' : ''})`).join('');
    return lineEdit(l, run[0].start, run[run.length - 1].end, insert, pages, at.plainAs) ?? 'That link can’t be changed here. Edit its text instead.';
  }
  const l = lineAt(ls, found.from);
  const insert = `[${at.text.slice(found.from, found.to)}](${target})`;
  const edit = lineEdit(l, found.from - l.from, found.to - l.from, insert, pages, at.plainAs);
  // The words must be linked and read the same: a selection that cuts through bold or italic would not.
  const linked = edit && linkTokens(applyTextEdit(l.text, { ...edit, from: edit.from - l.from, to: edit.to - l.from }), (t, n) => linkFromTarget(t, pages, n)).some((t) => t.start === found.from - l.from && t.end === found.from - l.from + insert.length);
  return edit && linked ? edit : 'Select words inside one line, without cutting through bold or italic.';
}

/** The link the selection is in, gone: its words stay, with their bold and italic, and so does how the line reads. */
export function removeLink(at: TextAt, pages: RichPages): TextEdit | null {
  const found = linkAt(at, pages);
  if (!found || found.kind !== 'link') return null;
  const l = lines(at.text, at.plainAs)[found.line];
  const run = found.tokens;
  const from = run[0].start;
  const to = run[run.length - 1].end;
  const label = (t: LinkToken) => l.text.slice(t.labelStart, t.labelEnd);
  let insert = run
    .map((t, k) => {
      if (!k) return label(t);
      const gap = l.text.slice(run[k - 1].end, t.start);
      // Marked words that now touch are kept apart, as the field writes them.
      return (!gap && label(run[k - 1]).endsWith('*') && label(t).startsWith('*') ? '\\|' : gap) + label(t);
    })
    .join('');
  // Marked words that now touch marked words beside them are kept apart, as the field writes them.
  if (/\*$/.test(l.text.slice(0, from)) && insert.startsWith('*')) insert = `\\|${insert}`;
  if (insert.endsWith('*') && l.text.slice(to).startsWith('*')) insert = `${insert}\\|`;
  // Words at the start of a paragraph that read as a marker ("### News") stay words.
  if (from === l.marker.length && !l.kind) insert = escapeLineStart(insert);
  return lineEdit(l, from, to, insert, pages, at.plainAs);
}

/** The text with an edit applied. */
export const applyTextEdit = (text: string, e: TextEdit) => text.slice(0, e.from) + e.insert + text.slice(e.to);
