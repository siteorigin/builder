/**
 * Markdown posts, as static site generators keep them: a file with optional frontmatter (YAML between `---` lines,
 * or TOML between `+++` lines) and a Markdown body. The body becomes HTML here and is read by the same HTML reader a
 * WordPress post is, so raw HTML inside Markdown is cleaned by the same rules.
 *
 * Only the common subset is read: headings, paragraphs, quotes, lists, code, tables, links, pictures, bold and italic,
 * and in frontmatter plain values, quoted text, true/false, dates and lists of words. Anything else in frontmatter
 * (nested settings, anchors) is passed over; a value the import needs that it cannot read is reported.
 */

/** A frontmatter value: text, true/false, or a list of words. */
export type FrontValue = string | boolean | string[];

export interface Frontmatter {
  data: Record<string, FrontValue>;
  /** Keys whose value could not be read, with why. */
  problems: string[];
  body: string;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function unquoteDouble(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
    if (e[0] === 'u' || (e[0] === 'x' && e.length > 1)) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '', '0': '', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[e] ?? e;
  });
}

/** One scalar as written after `key:` or `key =`: quoted text, or plain text with any trailing comment removed. */
function scalar(raw: string): string | boolean | null {
  const v = raw.trim();
  if (!v) return '';
  if (v[0] === '"') {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(v);
    return m ? unquoteDouble(m[1]) : null;
  }
  if (v[0] === "'") {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(v);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  // Anchors, aliases, tags and nested values are not read.
  if (/^[&*!{|>]/.test(v)) return null;
  const plain = v.replace(/\s+#.*$/, '').trim();
  if (/^(true|yes|on)$/i.test(plain)) return true;
  if (/^(false|no|off)$/i.test(plain)) return false;
  return plain;
}

/** A list written on one line: `[a, "b c", 'd']`. */
function flowList(raw: string): string[] | null {
  const v = raw.trim().replace(/\s+#[^\]]*$/, '');
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]*)\s*(,|$)/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < inner.length && (m = re.exec(inner))) {
    const item = scalar(m[1]);
    if (item === null || typeof item === 'boolean') return null;
    if (item) out.push(item);
    if (!m[2]) break;
  }
  return out;
}

function readYaml(lines: string[], first: number): { data: Record<string, FrontValue>; problems: string[] } {
  const data: Record<string, FrontValue> = {};
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;
    const m = /^([A-Za-z_][\w-]*|"[^"]+"|'[^']+')\s*:(?:\s+(.*))?$/.exec(line.replace(/\s+$/, ''));
    if (!m) {
      problems.push(`line ${first + i}: “${line.slice(0, 40)}” is not a setting`);
      continue;
    }
    const key = m[1].replace(/^["']|["']$/g, '').toLowerCase();
    if (Object.hasOwn(data, key)) {
      problems.push(`line ${first + i}: ${key} is given twice`);
      continue;
    }
    const raw = m[2] ?? '';
    // An indented block after an empty value: a list of items, a block of text, or nested settings (not read).
    const block: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim() || /^- /.test(lines[i + 1]))) block.push(lines[++i]);
    while (block.length && !block[block.length - 1].trim()) block.pop();
    if (!raw.trim() && block.length) {
      if (block.every((l) => !l.trim() || /^\s*- /.test(l) || /^\s*-$/.test(l))) {
        const items = block.filter((l) => l.trim()).map((l) => scalar(l.replace(/^\s*-\s?/, '')));
        if (items.every((x) => typeof x === 'string')) data[key] = (items as string[]).filter(Boolean);
        else problems.push(`line ${first + i}: ${key} holds a list that could not be read`);
      }
      // Nested settings: passed over.
      continue;
    }
    if (/^[|>][+-]?$/.test(raw.trim())) {
      // A block of text: its lines, folded (>) or kept (|).
      const text = block.map((l) => l.trim());
      data[key] = raw.trim()[0] === '>' ? text.join(' ').trim() : text.join('\n').trim();
      continue;
    }
    const list = raw.trim().startsWith('[') ? flowList(raw) : undefined;
    if (list !== undefined) {
      if (list) data[key] = list;
      else problems.push(`line ${first + i}: ${key} holds a list that could not be read`);
      continue;
    }
    const v = scalar(raw);
    if (v === null) problems.push(`line ${first + i}: ${key} holds a value that could not be read`);
    else data[key] = v;
  }
  return { data, problems };
}

function readToml(lines: string[], first: number): { data: Record<string, FrontValue>; problems: string[] } {
  const data: Record<string, FrontValue> = {};
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    // A table: everything after it belongs to it, not to the post's own settings.
    if (line.startsWith('[')) break;
    const m = /^([A-Za-z_][\w-]*|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!m) {
      problems.push(`line ${first + i}: “${line.slice(0, 40)}” is not a setting`);
      continue;
    }
    const key = m[1].replace(/^"|"$/g, '').toLowerCase();
    if (Object.hasOwn(data, key)) {
      problems.push(`line ${first + i}: ${key} is given twice`);
      continue;
    }
    const raw = m[2];
    if (raw.trim().startsWith('[')) {
      const list = flowList(raw);
      if (list) data[key] = list;
      else problems.push(`line ${first + i}: ${key} holds a list that could not be read`);
      continue;
    }
    const v = /^(true|false)\b/.test(raw.trim()) ? raw.trim().startsWith('true') : scalar(raw);
    if (v === null) problems.push(`line ${first + i}: ${key} holds a value that could not be read`);
    else data[key] = v;
  }
  return { data, problems };
}

/** A Markdown file's frontmatter, read, and its body. A file without frontmatter is all body. */
export function readFrontmatter(text: string): Frontmatter {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const fence = /^(---|\+\+\+)[ \t]*\n/.exec(src);
  if (!fence) return { data: {}, problems: [], body: src };
  const mark = fence[1];
  const lines = src.slice(fence[0].length).split('\n');
  const end = lines.findIndex((l) => l.trim() === mark || (mark === '---' && l.trim() === '...'));
  if (end < 0) return { data: {}, problems: ['its frontmatter is never closed'], body: src };
  const read = mark === '---' ? readYaml : readToml;
  const { data, problems } = read(lines.slice(0, end), 2);
  return { data, problems, body: lines.slice(end + 1).join('\n') };
}

// ---------------------------------------------------------------------------
// Markdown body
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/&(?!#?[A-Za-z0-9]{1,32};)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Where `[label][ref]` and `[ref]` links go, by lowercased reference. */
type Refs = Map<string, string>;

/** The most text one paragraph's emphasis is looked for in: past this, its marks stay as written. */
const MAX_EMPHASIS_TEXT = 10_000;
const BLOCK_TAGS = /^<\/?(?:address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|main|nav|ol|p|pre|script|section|style|table|ul|video|audio|object|embed|center|noscript)(?:[\s/>]|$)/i;

/** One run of inline Markdown as HTML. Raw HTML in it is passed on for the HTML reader to clean. */
export function inlineHtml(input: string, refs: Refs, depth = 0): string {
  // The characters that mark kept runs below are never the post's own.
  const text = input.replace(/[\u0001\u0002]/g, '');
  const kept: string[] = [];
  const keep = (html: string) => `\u0001${kept.push(html) - 1}\u0002`;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[i + 1])) {
      out += keep(escapeHtml(text[i + 1]));
      i += 2;
      continue;
    }
    if (c === '\\' && text[i + 1] === '\n') {
      out += keep('<br>');
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        out += keep(`<code>${escapeHtml(text.slice(i + run.length, end).trim())}</code>`);
        i = end + run.length;
        continue;
      }
      out += run;
      i += run.length;
      continue;
    }
    if (c === '<') {
      const auto = /^<((?:https?|mailto):[^\s<>]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/i.exec(text.slice(i, i + 2100));
      if (auto) {
        const href = /^(https?|mailto):/i.test(auto[1]) ? auto[1] : `mailto:${auto[1]}`;
        out += keep(`<a href="${escapeAttr(href)}">${escapeHtml(auto[1])}</a>`);
        i += auto[0].length;
        continue;
      }
      const tag = /^(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<!--[\s\S]*?-->)/.exec(text.slice(i, i + 4096));
      if (tag) {
        out += keep(tag[0]);
        i += tag[0].length;
        continue;
      }
    }
    if ((c === '!' && text[i + 1] === '[') || c === '[') {
      const link = readLink(text, c === '!' ? i + 1 : i, refs);
      if (link) {
        if (c === '!') out += keep(`<img src="${escapeAttr(link.href)}" alt="${escapeAttr(link.label.replace(/[*_`]/g, ''))}">`);
        else out += keep(`<a href="${escapeAttr(link.href)}">${depth < 4 ? inlineHtml(link.label, refs, depth + 1) : escapeHtml(link.label)}</a>`);
        i = link.end;
        continue;
      }
    }
    if (c === '\n') {
      // Two spaces at a line's end is a break; otherwise lines of a paragraph run on.
      out = out.replace(/ {2,}$/, () => keep('<br>'));
      out += '\n';
      i++;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  if (out.length <= MAX_EMPHASIS_TEXT) out = emphasis(out);
  return out.replace(/\u0001(\d+)\u0002/g, (_m, k: string) => kept[Number(k)]);
}

/** Bold and italic: `**` and `__` around words are bold, `*` and `_` italic. An underscore inside a word stays one. */
function emphasis(s: string): string {
  return s
    .replace(/\*\*\*(?=\S)([^*]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)((?:[^*]|\*(?!\*))*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w])__(?=\S)([^_]*?\S)__(?![\w])/g, '<strong>$1</strong>')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/\*(?=[^\s*])([^\s*])\*/g, '<em>$1</em>')
    .replace(/(?<![\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '<em>$1</em>');
}

/** `[label](href "title")`, `[label][ref]`, `[label][]` or `[ref]` at `at` (its "["), with where it ends. */
function readLink(text: string, at: number, refs: Refs): { label: string; href: string; end: number } | null {
  // The label: brackets balance inside it, up to a limit.
  let depth = 0;
  let j = at;
  for (; j < text.length && j - at < 2000; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '[') depth++;
    else if (text[j] === ']' && --depth === 0) break;
  }
  if (text[j] !== ']') return null;
  const label = text.slice(at + 1, j);
  const after = text.slice(j + 1, j + 1 + 2100);
  const inline = /^\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(after);
  if (inline) return { label, href: inline[1].replace(/^<|>$/g, ''), end: j + 1 + inline[0].length };
  const ref = /^\[([^\]]*)\]/.exec(after);
  const name = (ref && ref[1] ? ref[1] : label).trim().toLowerCase().replace(/\s+/g, ' ');
  const href = refs.get(name);
  if (href === undefined) return null;
  return { label, href, end: j + 1 + (ref ? ref[0].length : 0) };
}

interface ListItem {
  ordered: boolean;
  lines: string[];
}

/** A Markdown body as HTML. `depth` limits quotes and lists inside each other. */
export function markdownToHtml(md: string, depth = 0, refs: Refs = new Map()): string {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  // Link reference definitions are read first, wherever they are, and leave no text.
  for (let k = 0; k < lines.length; k++) {
    const def = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.exec(lines[k]);
    if (def) {
      const name = def[1].trim().toLowerCase().replace(/\s+/g, ' ');
      if (!refs.has(name)) refs.set(name, def[2]);
      lines[k] = '';
    }
  }
  const out: string[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) out.push(`<p>${inlineHtml(para.join('\n'), refs)}</p>`);
    para = [];
  };
  const listItem = (line: string) => /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/.exec(line);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      endPara();
      i++;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      endPara();
      out.push(`<h${heading[1].length}>${inlineHtml(heading[2] ?? '', refs)}</h${heading[1].length}>`);
      i++;
      continue;
    }
    // A line of = or - under a paragraph makes it a heading.
    if (para.length && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const level = line.trim()[0] === '=' ? 1 : 2;
      out.push(`<h${level}>${inlineHtml(para.join('\n'), refs)}</h${level}>`);
      para = [];
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])( *\1){2,}\s*$/.test(line)) {
      endPara();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      endPara();
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || quoted.length)) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push(`<blockquote>${depth < 8 ? markdownToHtml(quoted.join('\n'), depth + 1, refs) : escapeHtml(quoted.join(' '))}</blockquote>`);
      continue;
    }
    if (BLOCK_TAGS.test(line.trim()) && !para.length) {
      // Raw HTML: passed on as it is, up to a blank line.
      const html: string[] = [];
      while (i < lines.length && lines[i].trim()) html.push(lines[i++]);
      out.push(html.join('\n'));
      continue;
    }
    const first = listItem(line);
    if (first && (!para.length || first[4].trim())) {
      endPara();
      const ordered = /\d/.test(first[2]);
      const indent = first[1].length;
      const items: ListItem[] = [];
      let blank = false;
      while (i < lines.length) {
        const l = lines[i];
        const sibling = listItem(l);
        // A marker indented past this list's is an item of a list inside the item before it.
        const item = sibling && sibling[1].length <= indent ? sibling : null;
        if (item && /\d/.test(item[2]) === ordered) {
          items.push({ ordered, lines: [item[4]] });
          blank = false;
        } else if (!l.trim()) {
          blank = true;
          items[items.length - 1].lines.push('');
        } else if (/^ {2,}/.test(l)) {
          items[items.length - 1].lines.push(l.replace(/^ {2,4}/, ''));
          blank = false;
        } else if (!blank && !item) {
          // A lazy line: the item's paragraph goes on.
          items[items.length - 1].lines.push(l);
        } else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      const li = (it: ListItem) => {
        const inner = it.lines.join('\n').replace(/\n+$/, '');
        // An item of one paragraph holds its words; one with more holds blocks.
        if (depth >= 8) return escapeHtml(inner);
        // The item's first paragraph is its own words, as a tight list shows them.
        return markdownToHtml(inner, depth + 1, refs).replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, '$1');
      };
      out.push(`<${tag}>${items.map((it) => `<li>${li(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    // A table: a row of cells, then a line of dashes.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      endPara();
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => `<td>${inlineHtml(c.trim(), refs)}</td>`).join('');
      out.push(`<table>${rows.map((r) => `<tr>${cells(r)}</tr>`).join('')}</table>`);
      continue;
    }
    para.push(line.replace(/^ {1,3}/, ''));
    i++;
  }
  endPara();
  return out.join('\n');
}
