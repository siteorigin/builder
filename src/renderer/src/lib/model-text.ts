/**
 * Model text as the reader expects it: paragraphs where it left a blank line, and its Markdown as what it stands for.
 * Models are asked for plain sentences, but answers often come back with lists, code, tables and emphasis, which should
 * read as written rather than as raw syntax. A heading, which the prompts ask models not to write, becomes a bold lead
 * line. This is the small part of Markdown that models use, not all of it, and none of it is ever read as HTML.
 * Text is read while it streams in, so an unfinished fence is code already.
 */
import { externalLink } from '@shared/links';

export type ListItem = { lines: string[]; blocks: TextBlock[] };
export type TextBlock =
  | { kind: 'p' | 'lead' | 'code'; lines: string[] }
  | { kind: 'ul'; items: ListItem[] }
  | { kind: 'ol'; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: TextBlock[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'hr' };

export type TextSpan = string | { kind: 'code'; text: string } | { kind: 'strong' | 'em' | 'del'; spans: TextSpan[] } | { kind: 'link'; href: string; spans: TextSpan[] };

/** A line of a bulleted or numbered list, as models write them: "- ", "* ", "• ", "1. " or "1) ". */
const LIST_ITEM = /^([ \t]*)([-*+•]|\d{1,2}[.)])\s+(?=\S)/;
const HEADING = /^\s*#{1,6}\s+/;
/** Three or more backticks or tildes, then a language tag, which is never shown. */
const FENCE = /^([ \t]*)(`{3,}(?=[^`]*$)|~{3,})/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
/** The bound on how deeply quotes, lists and emphasis nest, so no reply can nest without end. */
const MAX_DEPTH = 8;

/** How far in a stretch of leading space reaches, a tab counting as four. */
const widthOf = (space: string) => space.replace(/\t/g, '    ').length;
const leading = (line: string) => line.slice(0, line.length - line.trimStart().length);
const indentOf = (line: string) => widthOf(leading(line));

/** The line with up to `by` of its indent taken off. What is left is as it was typed, tabs and all. */
function dedent(line: string, by: number): string {
  let at = 0;
  let width = 0;
  for (; width < by && (line[at] === ' ' || line[at] === '\t'); at++) width += widthOf(line[at]);
  return ' '.repeat(Math.max(0, width - by)) + line.slice(at);
}

/** The indent to take off the lines under a list item: its marker's width, or less where a line has less. */
const bodyIndent = (lines: string[], marker: number) => lines.reduce((least, line) => (line.trim() ? Math.min(least, indentOf(line)) : least), marker);

type Fence = { mark: string; indent: number };

/** The fence a line opens, also one on the same line as the list marker it sits under. */
function fenceAt(line: string): Fence | null {
  const rest = line.slice(LIST_ITEM.exec(line)?.[0].length ?? 0);
  const mark = FENCE.exec(rest)?.[2];
  return mark ? { mark, indent: widthOf(line.slice(0, line.length - rest.trimStart().length)) } : null;
}

/** Whether this line closes the fence. One indented well past its opening is part of the code. */
const closesFence = (line: string, fence: Fence) => {
  const mark = line.trim();
  return mark.startsWith(fence.mark) && mark === fence.mark[0].repeat(mark.length) && indentOf(line) <= fence.indent + 3;
};

/** Finds the run of as many backticks that closes one. Ask in the order of the text: it never looks back. */
function tickCloser(text: string) {
  // Where each length of run starts, so an unpartnered run is not searched for again and again.
  const ticks = new Map<number, number[]>();
  for (const run of text.matchAll(/`+/g)) {
    const starts = ticks.get(run[0].length);
    if (starts) starts.push(run.index);
    else ticks.set(run[0].length, [run.index]);
  }
  const used = new Map<number, number>();
  return (length: number, after: number): number | undefined => {
    const starts = ticks.get(length) ?? [];
    let next = used.get(length) ?? 0;
    while (next < starts.length && starts[next] < after) next++;
    used.set(length, next);
    return starts[next];
  };
}

/** A line cut at the pipes that divide it. A pipe written as \| or inside code divides nothing. */
function divided(line: string): string[] {
  const row = line.trim();
  const closer = tickCloser(row);
  const parts: string[] = [];
  let from = 0;
  const marks = /`+|\\[\s\S]|\|/g;
  for (let match = marks.exec(row); match; match = marks.exec(row)) {
    const [mark] = match;
    if (mark === '|') {
      parts.push(row.slice(from, match.index));
      from = marks.lastIndex;
    } else if (mark[0] === '`') {
      const end = closer(mark.length, marks.lastIndex);
      if (end !== undefined) marks.lastIndex = end + mark.length;
    }
  }
  parts.push(row.slice(from));
  return parts;
}

const isRow = (line: string) => divided(line).length > 1;

/** The cells of a table row. */
function cells(line: string): string[] {
  const row = divided(line);
  if (row.length > 1 && !row[0].trim()) row.shift();
  if (row.length > 1 && !row[row.length - 1].trim()) row.pop();
  return row.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** A table starts at a row of cells followed by a line of dashes with as many columns. */
function startsTable(line: string, next: string | undefined): boolean {
  if (!next || !isRow(line) || !isRow(next)) return false;
  const rule = cells(next);
  return rule.every((cell) => /^:?-+:?$/.test(cell)) && rule.length === cells(line).length;
}

/**
 * The lines under a list item: those indented past its marker, and the blank lines among them. A fence opened there, or
 * on the marker's own line (`fence`), is kept whole, however its code is indented.
 */
function itemBody(lines: string[], from: number, indent: number, fence: Fence | null): string[] {
  const body: string[] = [];
  let blanks = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (!fence) {
      if (!line.trim()) {
        blanks++;
        continue;
      }
      if (indentOf(line) < indent + 2) break;
    }
    for (; blanks; blanks--) body.push('');
    body.push(line);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else fence = fenceAt(line);
  }
  return body;
}

function parse(lines: string[], depth: number): TextBlock[] {
  const blocks: TextBlock[] = [];
  // Whether the next line of text may join the paragraph before it.
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = blocks.at(-1);
    if (!line.trim()) {
      // A blank line ends a paragraph; a list stays one list across the blank lines some models leave between items.
      open = false;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      const opened = { mark: fence[2], indent: widthOf(fence[1]) };
      for (i++; i < lines.length && !closesFence(lines[i], opened); i++) code.push(dedent(lines[i], opened.indent));
      blocks.push({ kind: 'code', lines: code });
      open = false;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'hr' });
      open = false;
      continue;
    }
    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const quoted = [line.replace(QUOTE, '')];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) quoted.push(lines[++i].replace(QUOTE, ''));
      const inner = parse(quoted, depth + 1);
      if (inner.length) blocks.push({ kind: 'quote', blocks: inner });
      open = false;
      continue;
    }
    if (startsTable(line, lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]) && ![FENCE, LIST_ITEM, QUOTE, HEADING].some((other) => other.test(lines[i])); i++) rows.push(cells(lines[i]));
      i--;
      // Rows keep the cells they have: none loses words, and one long row costs only itself.
      blocks.push({ kind: 'table', head, rows });
      open = false;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const [marker, spaces, bullet] = item;
      const kind = /\d/.test(bullet) ? 'ol' : 'ul';
      const first = line.slice(marker.length);
      const nests = depth < MAX_DEPTH;
      // A fence opened on the marker's own line is held from there.
      const fenced = nests ? FENCE.exec(first)?.[2] : undefined;
      const under = nests ? itemBody(lines, i + 1, widthOf(spaces), fenced ? { mark: fenced, indent: widthOf(marker) } : null) : [];
      const by = bodyIndent(under, marker.length);
      const body = under.map((l) => dedent(l, by));
      // So is a block that starts there. Only a spaced ">" before words is a quote: ">= 100" and "> 100" are amounts.
      const blocky = !!fenced || (nests && (/^> +(?![\d=\s])/.test(first) || startsTable(first, body[0])));
      // A fence there keeps its place past the lines under it, so it closes at the same line here as above.
      const head = fenced ? ' '.repeat(Math.max(0, widthOf(marker) - by)) + first : first;
      const inner = parse(blocky ? [head, ...body] : body, depth + 1);
      // Lines that carry straight on from the marker's own line are still the item's text.
      const carried = !blocky && under[0]?.trim() && inner[0]?.kind === 'p' ? (inner.shift() as { lines: string[] }).lines : [];
      const entry: ListItem = { lines: blocky ? [] : [first, ...carried], blocks: inner };
      i += under.length;
      if (last?.kind === kind) last.items.push(entry);
      // A numbered list that code or a paragraph interrupted carries on from its own number.
      else blocks.push(kind === 'ol' ? { kind, start: parseInt(bullet, 10), items: [entry] } : { kind, items: [entry] });
      open = false;
      continue;
    }
    if (HEADING.test(line)) {
      const words = line.replace(HEADING, '').trim();
      if (words) blocks.push({ kind: 'lead', lines: [words] });
      open = false;
    } else if (open && last?.kind === 'p') last.lines.push(line.trimEnd());
    else {
      blocks.push({ kind: 'p', lines: [line.trim()] });
      open = true;
    }
  }
  return blocks;
}

export function textBlocks(text: string): TextBlock[] {
  return parse(text.replace(/\r\n?/g, '\n').split('\n'), 0);
}

/** A link or image, read as its words, or its address when it has none. The address may hold one level of parentheses. */
const LINK = /!?\[((?:[^[\]\n]|\[[^[\]\n]{0,200}\]){0,500})\]\(((?:[^()\n]|\([^()\n]{0,500}\)){0,2000})\)/y;
/** An address written out in the text, up to the first space, quote or escape. What it ends with is checked (urlAt). */
const BARE_URL = /https?:\/\/[^\s<>`"'“”‘’\\]{1,2100}/iy;
/** Marks that end a sentence, which an address written at the end of one leaves to the prose. */
const URL_TAIL = /[.,:;!?]/;
/** What an address can't follow: a letter or number, or a character that makes it part of a longer name or address. */
const URL_AFTER = /[\p{L}\p{N}\p{M}/@.+-]/u;
const ESCAPABLE = /[\\`*_~[\](){}#+\-.!|>]/;
const SPACE = /^\s?$/;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;
const WORD = /^[\p{L}\p{N}]$/u;
/** A file pattern's star, as in *.png. */
const EXTENSION = /^\.[A-Za-z0-9]/;
/** The names code writes between double underscores. Any other word between them is bold. */
const DUNDER = /__(?:init|main|name|file|dirname|filename|proto|all|doc|dict|str|repr|call|len|iter|next|enter|exit|new|eq|hash|getitem|setitem|getattr|setattr|post_init|slots|class|module|version)__(?![A-Za-z0-9_])/y;

type Opener = { at: number; length: number };

/** Whether a run of `*`, `_` or `~` can open or close emphasis, going by what is on each side of it. */
function flanks(mark: string, length: number, before: string, after: string): { opens: boolean; closes: boolean } {
  const none = { opens: false, closes: false };
  if (mark === '~' ? length !== 2 : length > 3) return none;
  // A path pattern such as src/**/*.ts, and a product such as 1200*800 or width*height, are not emphasis.
  if (mark === '*' && ((before === '/' && !SPACE.test(after)) || (after === '/' && !SPACE.test(before)))) return none;
  if (mark === '*' && length === 1 && WORD.test(before) && WORD.test(after)) return none;
  // So is a quoted star, '*'.
  if (mark === '*' && /["'’”“‘]/.test(before) && /["'’”“‘]/.test(after)) return none;
  const left = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before));
  const right = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after));
  // An underscore inside a word is part of the word, as in snake_case.
  if (mark === '_') return { opens: left && (!right || PUNCTUATION.test(before)), closes: right && (!left || PUNCTUATION.test(after)) };
  return { opens: left, closes: right };
}

/** A web page's address that may become a link: http(s), with no credentials in it (externalLink). */
function webHref(address: string): string | null {
  // A title after the address, as in [docs](https://example.com "Docs"), is not part of it.
  const link = externalLink(address.trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, ''));
  // Checked again as it will be opened, since the browser's form of an address can be longer than its typed one.
  return link?.kind === 'web' && externalLink(link.href) ? link.href : null;
}

/**
 * The address written out at `at`, as typed, without what follows it in the sentence: a full stop, a mark that closes
 * emphasis still open (`closes`), or a bracket it didn't open. Brackets it opens and closes are part of it, as in a
 * wiki page's address, and so is an underscore or star with nothing open to close.
 */
function urlAt(text: string, at: number, closes: (mark: string) => boolean): string | null {
  BARE_URL.lastIndex = at;
  const url = BARE_URL.exec(text)?.[0];
  if (!url) return null;
  // How many of each bracket the address holds, counted once and kept as its end is taken off.
  const count: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 };
  for (const ch of url) if (ch in count) count[ch]++;
  let end = url.length;
  for (; end; end--) {
    const last = url[end - 1];
    const pair = last === ')' ? '(' : last === ']' ? '[' : null;
    if (pair ? count[pair] < count[last] : URL_TAIL.test(last) || ('*_~'.includes(last) && closes(last))) {
      if (pair) count[last]--;
    } else break;
  }
  const kept = url.slice(0, end);
  return /^https?:\/\/[^/?#]/i.test(kept) ? kept : null;
}

/**
 * One line or paragraph of model text as spans: bold, italic, struck through and code, and links to web pages, written
 * as Markdown or as a bare address. A link to anything else is shown as its words. A mark with no partner stays as
 * typed. `links` is off inside a link's own words, so a link never holds another.
 */
export function textSpans(text: string, links = true): TextSpan[] {
  const out: TextSpan[] = [];
  // The marks still waiting for a partner, by character: where each sits in `out`.
  const openers: Record<string, Opener[]> = { '*': [], _: [], '~': [] };
  let plain = '';
  const flush = () => {
    if (plain) out.push(plain);
    plain = '';
  };
  const closingTicks = tickCloser(text);

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let length = 1;
      while (text[i + length] === '`') length++;
      const end = closingTicks(length, i + length);
      if (end === undefined) plain += text.slice(i, i + length);
      else {
        flush();
        const code = text.slice(i + length, end);
        const padded = code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code);
        out.push({ kind: 'code', text: padded ? code.slice(1, -1) : code });
      }
      i = end === undefined ? i + length : end + length;
      continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      LINK.lastIndex = i;
      const link = LINK.exec(text);
      if (link) {
        flush();
        const words = link[1].trim() ? textSpans(link[1], false) : [link[2]];
        const href = links && c === '[' ? webHref(link[2]) : null;
        if (href) out.push({ kind: 'link', href, spans: words });
        else out.push(...words);
        i += link[0].length;
        continue;
      }
    }
    if (links && (c === 'h' || c === 'H') && !URL_AFTER.test(String.fromCodePoint(text.codePointAt(i - (/[\udc00-\udfff]/.test(text[i - 1] ?? '') ? 2 : 1)) ?? 32))) {
      const url = urlAt(text, i, (mark) => openers[mark].length > 0);
      const href = url && webHref(url);
      if (url && href) {
        flush();
        out.push({ kind: 'link', href, spans: [url] });
        i += url.length;
        continue;
      }
    }
    if (c !== '*' && c !== '_' && c !== '~') {
      plain += c;
      i++;
      continue;
    }
    let length = 1;
    while (text[i + length] === c) length++;
    // A name such as __init__ is a name.
    if (c === '_' && length === 2 && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
      DUNDER.lastIndex = i;
      if (DUNDER.test(text)) {
        plain += text.slice(i, DUNDER.lastIndex);
        i = DUNDER.lastIndex;
        continue;
      }
    }
    const flank = flanks(c, length, text[i - 1] ?? '', text[i + length] ?? '');
    const pattern = c === '*' && length === 1 && !WORD.test(text[i - 1] ?? '') && EXTENSION.test(text.slice(i + 1, i + 3));
    const opens = flank.opens && !pattern;
    const closes = flank.closes && !pattern;
    i += length;
    flush();
    let left = length;
    const waiting = openers[c];
    while (closes && left && waiting.length) {
      const opener = waiting[waiting.length - 1];
      const take = c === '~' ? 2 : left >= 2 && opener.length >= 2 ? 2 : 1;
      const spans = out.splice(opener.at + 1);
      // Marks left unpartnered inside the pair are now words.
      for (const others of Object.values(openers)) while (others.length && others[others.length - 1].at > opener.at) others.pop();
      opener.length -= take;
      left -= take;
      if (opener.length) out[opener.at] = c.repeat(opener.length);
      else {
        out.splice(opener.at, 1);
        waiting.pop();
      }
      out.push({ kind: c === '~' ? 'del' : take === 2 ? 'strong' : 'em', spans: joined(spans) });
    }
    if (left) {
      if (opens) waiting.push({ at: out.length, length: left });
      // Only the latest few can still be partnered, which bounds how deeply spans nest.
      if (waiting.length > MAX_DEPTH) waiting.shift();
      out.push(c.repeat(left));
    }
  }
  flush();
  return joined(out);
}

/** Neighbouring runs of plain text as one. */
function joined(spans: TextSpan[]): TextSpan[] {
  const out: TextSpan[] = [];
  for (const span of spans) {
    if (typeof span === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += span;
    else out.push(span);
  }
  return out;
}
