/**
 * Model text as the reader expects it: paragraphs where it left a blank line, and its Markdown as what it stands for.
 * Models are asked for plain sentences, but answers often come back with lists, code, tables and emphasis, which should
 * read as written rather than as raw syntax. A heading, which the prompts ask models not to write, becomes a bold lead
 * line. This is the small part of Markdown that models use, not all of it, and none of it is ever read as HTML.
 * Text is read while it streams in, so an unfinished fence is code already.
 */
export type ListItem = { lines: string[]; blocks: TextBlock[] };
export type TextBlock =
  | { kind: 'p' | 'lead' | 'code'; lines: string[] }
  | { kind: 'ul'; items: ListItem[] }
  | { kind: 'ol'; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: TextBlock[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'hr' };

export type TextSpan = string | { kind: 'code'; text: string } | { kind: 'strong' | 'em' | 'del'; spans: TextSpan[] };

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
  for (let width = 0; width < by && (line[at] === ' ' || line[at] === '\t'); at++) width += widthOf(line[at]);
  return line.slice(at);
}

/** Whether this line closes the fence that `open` matched. */
const closesFence = (line: string, open: string) => {
  const mark = line.trim();
  return mark.startsWith(open) && mark === open[0].repeat(mark.length);
};

/** The cells of a table row. A pipe written as \| is part of its cell. */
function cells(line: string): string[] {
  const row = [''];
  // A pipe inside code is part of the code.
  for (const [part] of line.trim().matchAll(/`[^`]*`|\\[\s\S]|[^`|\\]+|[\s\S]/g)) {
    if (part === '|') row.push('');
    else row[row.length - 1] += part;
  }
  if (row.length > 1 && !row[0].trim()) row.shift();
  if (row.length > 1 && !row[row.length - 1].trim()) row.pop();
  return row.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** A table starts at a row of cells followed by a line of dashes with as many columns. */
function startsTable(line: string, next: string | undefined): boolean {
  if (!next || !line.includes('|') || !next.includes('|')) return false;
  const rule = cells(next);
  return rule.every((cell) => /^:?-+:?$/.test(cell)) && rule.length === cells(line).length;
}

/**
 * The lines under a list item: those indented past its marker, and the blank lines among them. A fence opened there, or
 * on the marker's own line (`fence`), is kept whole, however its code is indented.
 */
function itemBody(lines: string[], from: number, indent: number, fence: string): string[] {
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
      if (closesFence(line, fence)) fence = '';
    } else fence = FENCE.exec(line)?.[2] ?? '';
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
      for (i++; i < lines.length && !closesFence(lines[i], fence[2]); i++) code.push(dedent(lines[i], widthOf(fence[1])));
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
      for (i += 2; i < lines.length && lines[i].includes('|') && ![FENCE, LIST_ITEM, QUOTE, HEADING].some((other) => other.test(lines[i])); i++) rows.push(cells(lines[i]));
      i--;
      // A row with more cells than the heading widens the table rather than losing its words.
      const width = rows.reduce((most, row) => Math.max(most, row.length), head.length);
      const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')];
      blocks.push({ kind: 'table', head: pad(head), rows: rows.map(pad) });
      open = false;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const [marker, spaces, bullet] = item;
      const kind = /\d/.test(bullet) ? 'ol' : 'ul';
      const first = line.slice(marker.length);
      // An item whose marker's line opens a fence holds that fence from there.
      const opening = depth < MAX_DEPTH ? FENCE.exec(first)?.[2] : undefined;
      const under = depth < MAX_DEPTH ? itemBody(lines, i + 1, widthOf(spaces), opening ?? '') : [];
      const by = Math.min(marker.length, ...under.filter((l) => l.trim()).map(indentOf));
      const inner = parse([...(opening ? [first] : []), ...under.map((l) => dedent(l, by))], depth + 1);
      // Lines that carry straight on from the marker's own line are still the item's text.
      const carried = !opening && under[0]?.trim() && inner[0]?.kind === 'p' ? (inner.shift() as { lines: string[] }).lines : [];
      const entry: ListItem = { lines: opening ? [] : [first, ...carried], blocks: inner };
      i += under.length;
      if (last?.kind === kind) last.items.push(entry);
      // A numbered list that code or a paragraph interrupted carries on from its own number.
      else blocks.push(kind === 'ol' ? { kind, start: parseInt(bullet, 10), items: [entry] } : { kind, items: [entry] });
      open = false;
      continue;
    }
    if (HEADING.test(line)) {
      blocks.push({ kind: 'lead', lines: [line.replace(HEADING, '')] });
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

/** A link or image, read as its words. Its address may hold one level of parentheses. */
const LINK = /!?\[((?:[^[\]\n]|\[[^[\]\n]{0,200}\]){0,500})\]\((?:[^()\n]|\([^()\n]{0,500}\)){0,2000}\)/y;
const ESCAPABLE = /[\\`*_~[\](){}#+\-.!|>]/;
const SPACE = /^\s?$/;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;

type Opener = { at: number; length: number };

/** Whether a run of `*`, `_` or `~` can open or close emphasis, going by what is on each side of it. */
function flanks(mark: string, length: number, before: string, after: string): { opens: boolean; closes: boolean } {
  const none = { opens: false, closes: false };
  if (mark === '~' ? length !== 2 : length > 3) return none;
  // A path pattern such as src/**/*.ts, and a sum such as 1200*800, are not emphasis.
  if (mark === '*' && ((before === '/' && !SPACE.test(after)) || (after === '/' && !SPACE.test(before)))) return none;
  if (mark === '*' && length === 1 && /\d/.test(before) && /\d/.test(after)) return none;
  const left = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before));
  const right = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after));
  // An underscore inside a word is part of the word, as in snake_case.
  if (mark === '_') return { opens: left && (!right || PUNCTUATION.test(before)), closes: right && (!left || PUNCTUATION.test(after)) };
  return { opens: left, closes: right };
}

/**
 * One line or paragraph of model text as spans: bold, italic, struck through and code, with links as their words.
 * A mark with no partner stays as typed.
 */
export function textSpans(text: string): TextSpan[] {
  const out: TextSpan[] = [];
  // The marks still waiting for a partner, by character: where each sits in `out`.
  const openers: Record<string, Opener[]> = { '*': [], _: [], '~': [] };
  let plain = '';
  const flush = () => {
    if (plain) out.push(plain);
    plain = '';
  };
  // Where each length of backtick run starts, so an unpartnered run is not searched for again and again.
  const ticks = new Map<number, number[]>();
  for (const run of text.matchAll(/`+/g)) {
    const starts = ticks.get(run[0].length);
    if (starts) starts.push(run.index);
    else ticks.set(run[0].length, [run.index]);
  }
  const used = new Map<number, number>();
  const closingTicks = (length: number, after: number) => {
    const starts = ticks.get(length) ?? [];
    let next = used.get(length) ?? 0;
    while (next < starts.length && starts[next] < after) next++;
    used.set(length, next);
    return starts[next];
  };

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
        out.push({ kind: 'code', text: /^ .*[^ ].* $/s.test(code) ? code.slice(1, -1) : code });
      }
      i = end === undefined ? i + length : end + length;
      continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      LINK.lastIndex = i;
      const link = LINK.exec(text);
      if (link) {
        flush();
        out.push(...textSpans(link[1]));
        i += link[0].length;
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
    // A whole name between double underscores, such as __init__, is a name.
    const name = c === '_' && length === 2 ? /__[A-Za-z0-9_]+?__(?![A-Za-z0-9_])/y : null;
    if (name) name.lastIndex = i;
    if (name?.test(text) && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
      plain += text.slice(i, name.lastIndex);
      i = name.lastIndex;
      continue;
    }
    const { opens, closes } = flanks(c, length, text[i - 1] ?? '', text[i + length] ?? '');
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
