/**
 * Reads a post's HTML (a WordPress post, or the HTML a Markdown file holds or becomes) into the element tree the
 * editor's rich text reader takes (see shared/richtext-tree.ts), keeping only prose: paragraphs, headings, quotes,
 * lists, links, bold and italic, and pictures. Formatting it has no form for becomes ordinary text, and is counted:
 * code and preformatted text keep their lines, superscripts and subscripts are written with characters of their own
 * so their digits never join the text before them (m², 10⁶, CO₂, or 10^-1.5), and struck-through text keeps its
 * words. Anything active is never carried: scripts, styles, frames, objects,
 * forms and every attribute but a link's address and a picture's source and description. What was left out is
 * counted in a report the author reads before importing.
 *
 * The reader never fails on bad markup (it closes what is left open, as a browser does), and every scan moves
 * forward, so a damaged post is read in one pass. Its size is capped by the file it came from.
 */
import type { LinkValue, RichText } from '@shared/types';
import { richTextToPlain } from '@shared/richtext';
import { blocksFromDom, type RichDomNode } from '@shared/richtext-tree';
import { relsFromAttribute } from '@shared/link-rel';

/** What reading a post's HTML left out or changed, for the import's report. */
export interface HtmlReport {
  /** Scripts and event handlers removed. */
  scripts: number;
  /** Frames, objects and media players removed: the address each showed, when it had one. */
  embeds: string[];
  /** Embedded videos and posts kept as a link to their address. */
  embedLinks: number;
  forms: number;
  /** Tables kept as plain paragraphs, one per row. */
  tables: number;
  /** WordPress shortcodes removed, by name. */
  shortcodes: string[];
  /** Links whose address could not be kept (a script, or an address on the old site that is not a post): their words stay. */
  droppedLinks: number;
  /** Blocks of code or preformatted text kept as ordinary text, line by line. */
  code: number;
  /** Superscripts and subscripts written on the line (see raised). */
  raised: number;
  /** Struck-through passages kept as ordinary text. */
  struck: number;
}

export const emptyReport = (): HtmlReport => ({ scripts: 0, embeds: [], embedLinks: 0, forms: 0, tables: 0, shortcodes: [], droppedLinks: 0, code: 0, raised: 0, struck: 0 });

/** A picture the HTML shows, as written. */
export interface HtmlImage {
  src: string;
  alt: string;
}

export interface ReadHtmlOptions {
  /** The key a picture is known by in the import, or null to leave it out (the caller says why). */
  image: (img: HtmlImage) => string | null;
  /** Where a link goes, or null when its address cannot be kept. */
  link: (href: string, newTab: boolean, rel: string[]) => LinkValue | null;
  /** WordPress's classic editor: blank lines separate paragraphs and a single line break is a break. */
  autop?: boolean;
  /** WordPress shortcodes: [caption] becomes a captioned picture, [embed] a link, and the rest are removed. */
  shortcodes?: boolean;
}

/** The most elements and runs of text one post may hold. */
const MAX_NODES = 200_000;
const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** HTML's names for U+00A0 to U+00FF, in order. */
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const NAMED: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39,
  ...Object.fromEntries(LATIN1.map((n, i) => [n, 0xa0 + i])),
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201,
  zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
  bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250,
  euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, minus: 8722, infin: 8734, ne: 8800, le: 8804, ge: 8805, hearts: 9829
};

/**
 * Text with its character references read; a name HTML does not have stays as written. `strict` reads a name only
 * with its semicolon, as an address needs (`?a=1&copy=2` keeps its `&copy`).
 */
export function decodeEntities(s: string, strict = false): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, ref: string) => {
    if (strict && !whole.endsWith(';')) return whole;
    if (ref[0] === '#') {
      const n = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }
    // A name only counts with its semicolon, except the oldest few that browsers read without one.
    if (!whole.endsWith(';') && (strict || !['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'].includes(ref))) return whole;
    return Object.hasOwn(NAMED, ref) ? String.fromCodePoint(NAMED[ref]) : whole;
  });
}

// ---------------------------------------------------------------------------
// WordPress's own text formats
// ---------------------------------------------------------------------------

const ALL_BLOCKS =
  '(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)';
const OPEN_BLOCK = new RegExp(`(<${ALL_BLOCKS}[\\s/>])`, 'gi');
const CLOSE_BLOCK = new RegExp(`(</${ALL_BLOCKS}>)`, 'gi');
// A tag's attributes never run past the next "<", so markup with unfinished tags is read in one pass.
const P_AROUND_BLOCK = new RegExp(`<p>\\s*(</?${ALL_BLOCKS}[^<>]*>)\\s*</p>`, 'gi');
const P_BEFORE_BLOCK = new RegExp(`<p>\\s*(</?${ALL_BLOCKS}[^<>]*>)`, 'gi');
const P_AFTER_BLOCK = new RegExp(`(</?${ALL_BLOCKS}[^<>]*>)\\s*</p>`, 'gi');
const BR_AFTER_BLOCK = new RegExp(`(</?${ALL_BLOCKS}[^<>]*>)\\s*<br />`, 'gi');

/**
 * WordPress's automatic paragraphs (wpautop), as the classic editor stores posts: text separated by a blank line is a
 * paragraph of its own and a single line break inside one is a break. Markup already in blocks stays as it is.
 */
export function autop(html: string): string {
  if (!html.trim()) return '';
  // Preformatted text keeps its own lines.
  const kept: string[] = [];
  let text = eachPair(html, /<pre[\s>]/, /<\/pre>/, (m) => `<pre data-kept="${kept.push(m) - 1}"></pre>`);
  // A line break inside a tag is a space.
  text = text.replace(/<[^<>]*>/g, (m) => m.replace(/\n/g, ' '));
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
  text = text.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n');
  text = text.replace(OPEN_BLOCK, '\n\n$1').replace(CLOSE_BLOCK, '$1\n\n');
  text = text.replace(/\n\s*\n(\s*\n)*/g, '\n\n');
  text = text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => `<p>${p.trim()}</p>\n`)
    .join('');
  text = text.replace(/<p>\s*<\/p>/g, '');
  text = text.replace(P_AROUND_BLOCK, '$1').replace(P_BEFORE_BLOCK, '$1').replace(P_AFTER_BLOCK, '$1');
  text = text.replace(/ ?\n/g, '<br />\n');
  text = text.replace(BR_AFTER_BLOCK, '$1').replace(/<br \/>(\s*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^<>]*>)/gi, '$1');
  return text.replace(/<pre data-kept="(\d+)"><\/pre>/g, (_m, i: string) => kept[Number(i)]);
}

/**
 * Each `open … close` pair in `text` (ignoring case) replaced by `fn` of the whole pair, in one forward scan: an
 * `open` with no `close` after it ends the scan, since none after it can have one either.
 */
function eachPair(text: string, open: RegExp, close: RegExp, fn: (whole: string) => string): string {
  // Found in the text itself, ignoring case: never in a lowercased copy, whose lengths can differ ("İ").
  const o = new RegExp(open.source, 'gi');
  const c = new RegExp(close.source, 'gi');
  let out = '';
  let i = 0;
  for (;;) {
    o.lastIndex = i;
    const a = o.exec(text);
    if (!a) break;
    c.lastIndex = a.index + a[0].length;
    const b = c.exec(text);
    if (!b) break;
    const end = b.index + b[0].length;
    out += text.slice(i, a.index) + fn(text.slice(a.index, end));
    i = end;
  }
  return out + text.slice(i);
}

/** Shortcodes WordPress and its common plugins write without a closing tag. */
const LONE_SHORTCODES = new Set(['gallery', 'video', 'audio', 'playlist', 'embed', 'contact-form', 'contact-form-7', 'gravityform', 'wpforms', 'ninja_form', 'instagram-feed', 'mc4wp_form']);

/**
 * WordPress shortcodes: [caption] around a picture becomes a figure with its caption, [embed] becomes its address, and
 * every other shortcode is removed (the text it wraps stays) and named in the report. A word in square brackets that
 * is no shortcode ("[sic]") stays as written.
 */
export function readShortcodes(html: string, report: HtmlReport): string {
  if (!html.includes('[')) return html;
  // Names that close somewhere are shortcodes, as are the usual lone ones and plugin names (with _ or -).
  const closing = new Set([...html.matchAll(/\[\/([a-z][a-z0-9_-]{0,40})\]/gi)].map((m) => m[1].toLowerCase()));
  const isShortcode = (n: string) => closing.has(n) || LONE_SHORTCODES.has(n) || /[_-]/.test(n);
  const note = (n: string) => {
    if (!report.shortcodes.includes(n) && report.shortcodes.length < 20) report.shortcodes.push(n);
  };
  let text = eachPair(html, /\[caption\b/, /\[\/caption\]/, (whole) => {
    const parts = /^\[caption\b([^\]]*)\]([\s\S]*)\[\/caption\]$/i.exec(whole);
    if (!parts) return whole;
    const [, attrs, inner] = parts;
    const pic = /^\s*((?:<a\b[^>]*>\s*)?<img\b[^>]*>(?:\s*<\/a>)?)([\s\S]*)$/i.exec(inner);
    if (!pic) return inner;
    const caption = pic[2].trim() || (/\bcaption=("|')([\s\S]*?)\1/i.exec(attrs)?.[2] ?? '');
    return `<figure>${pic[1]}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
  });
  text = text.replace(/\[embed\b[^\][]{0,2000}\]\s*(https?:\/\/[^\s[\]<>"]+)\s*\[\/embed\]/gi, (_m, url: string) => {
    report.embedLinks++;
    return `<p><a href="${url}">${url}</a></p>`;
  });
  // Attributes never hold a bracket, and each part is either quoted or not, so a shortcode left open is given up on at
  // the next bracket: one pass, whatever the post holds.
  return text.replace(/\[(\/?)([a-z][a-z0-9_-]{0,40})\b((?:[^\]["']|"[^"\][]{0,500}"|'[^'\][]{0,500}'){0,2000})\]/gi, (whole, _slash: string, name: string) => {
    const n = name.toLowerCase();
    if (!isShortcode(n)) return whole;
    note(n);
    return '';
  });
}

// ---------------------------------------------------------------------------
// Markup into a tree
// ---------------------------------------------------------------------------

interface HElement {
  tag: string;
  attrs: Record<string, string>;
  children: HNode[];
}
type HNode = HElement | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
/** Elements whose content is text up to their own end tag, never markup. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
/** Elements dropped with everything inside them. */
const DROP = new Set(['head', 'template', 'svg', 'math', 'object', 'video', 'audio', 'canvas', 'form', 'select', 'button', 'input', 'embed', 'map', 'applet', 'frameset', 'frame', 'dialog', 'picture-source', 'link', 'meta', 'base']);
/** Starting one of these ends an open paragraph, as it does in a browser. */
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'dd', 'dt']);
/** An element that ends the one before it at the same level, within its container. */
const SIBLING_ENDS: Record<string, { ends: string[]; within: string[] }> = {
  li: { ends: ['li'], within: ['ul', 'ol'] },
  dt: { ends: ['dt', 'dd'], within: ['dl'] },
  dd: { ends: ['dt', 'dd'], within: ['dl'] },
  tr: { ends: ['tr', 'td', 'th'], within: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { ends: ['td', 'th'], within: ['tr', 'table'] },
  th: { ends: ['td', 'th'], within: ['tr', 'table'] }
};

/** Read markup into a tree, closing what is left open. Counts what is dropped on the way. */
function parseHtml(html: string, report: HtmlReport): HNode[] {
  const root: HElement = { tag: '#root', attrs: {}, children: [] };
  const stack: HElement[] = [root];
  let nodes = 0;
  /** Inside a dropped element: its name and how deeply the same name is nested in it. */
  let dropping: { tag: string; depth: number } | null = null;
  const top = () => stack[stack.length - 1];
  const add = (n: HNode) => {
    const kids = top().children;
    // Text beside text is one run: only a node added counts.
    if (typeof n === 'string' && typeof kids[kids.length - 1] === 'string') return void (kids[kids.length - 1] += n);
    if (++nodes > MAX_NODES) throw new Error('it is too long to read.');
    kids.push(n);
  };
  const popTo = (i: number) => {
    stack.length = i;
  };
  const indexOfOpen = (tags: string[], within: string[] = []) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (tags.includes(stack[i].tag)) return i;
      if (within.includes(stack[i].tag)) return -1;
    }
    return -1;
  };
  const dropCount = (tag: string, attrs: Record<string, string>) => {
    if (tag === 'form' || tag === 'button' || tag === 'input' || tag === 'select') report.forms++;
    else if (['object', 'video', 'audio', 'embed', 'applet', 'frameset', 'frame'].includes(tag)) noteEmbed(report, attrs.src ?? attrs.data ?? '');
  };

  let i = 0;
  const n = html.length;
  let lower: string | null = null;
  while (i < n) {
    const lt = html.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i && !dropping) add(decodeEntities(html.slice(i, textEnd)));
    if (lt < 0) break;
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = html[i + 1] === '/';
    const nameAt = closing ? i + 2 : i + 1;
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(nameAt, nameAt + 64));
    if (!nameMatch) {
      // A "<" that starts no tag is text.
      if (!dropping) add('<');
      i++;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    // The attributes, up to the ">" outside quotes.
    let j = nameAt + nameMatch[0].length;
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    while (j < n && html[j] !== '>') {
      const c = html[j];
      if (/\s/.test(c)) {
        j++;
        continue;
      }
      if (c === '/') {
        selfClosing = html[j + 1] === '>';
        j++;
        continue;
      }
      const an = /^[^\s/>=]+/.exec(html.slice(j, j + 256));
      if (!an) {
        j++;
        continue;
      }
      const name = an[0].toLowerCase();
      j += an[0].length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          const v = /^[^\s>]*/.exec(html.slice(j, j + 4096))![0];
          value = v;
          j += v.length;
        }
      }
      if (!closing && !Object.hasOwn(attrs, name) && Object.keys(attrs).length < 64) attrs[name] = decodeEntities(value);
    }
    i = j < n ? j + 1 : n;

    if (closing) {
      if (dropping) {
        if (tag === dropping.tag && --dropping.depth === 0) dropping = null;
        continue;
      }
      if (tag === 'br') add({ tag: 'br', attrs: {}, children: [] });
      else if (tag === 'p' && indexOfOpen(['p']) < 0) continue;
      else {
        const at = indexOfOpen([tag]);
        if (at > 0) popTo(at);
      }
      continue;
    }
    if (dropping) {
      if (tag === dropping.tag && !VOID.has(tag) && !selfClosing) dropping.depth++;
      continue;
    }
    if (!closing && !dropping && !RAW.has(tag) && Object.keys(attrs).some((a) => a.startsWith('on'))) report.scripts++;
    if (RAW.has(tag)) {
      // Its content is never markup: skip to its end tag.
      lower ??= html.toLowerCase();
      const end = lower.indexOf(`</${tag}`, i);
      const close = end < 0 ? n : html.indexOf('>', end);
      i = close < 0 ? n : close + 1;
      if (tag === 'script') report.scripts++;
      else if (tag === 'iframe') add({ tag: 'iframe', attrs: { src: attrs.src ?? '' }, children: [] });
      else if (tag === 'noscript' || tag === 'noembed' || tag === 'noframes') {
        // What a page shows without scripts or frames: not the post's own words.
      }
      continue;
    }
    if (DROP.has(tag)) {
      dropCount(tag, attrs);
      if (!VOID.has(tag) && !selfClosing) dropping = { tag, depth: 1 };
      continue;
    }
    if (CLOSES_P.has(tag)) {
      const p = indexOfOpen(['p'], ['li', 'td', 'th', 'blockquote', 'div', 'figure']);
      if (p > 0) popTo(p);
    }
    const sib = SIBLING_ENDS[tag];
    if (sib) {
      const at = indexOfOpen(sib.ends, sib.within);
      if (at > 0) popTo(at);
    }
    const el: HElement = { tag, attrs, children: [] };
    add(el);
    if (!VOID.has(tag) && !selfClosing && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root.children;
}

function noteEmbed(report: HtmlReport, src: string) {
  if (report.embeds.length < 20) report.embeds.push(/^https?:\/\//i.test(src) ? src.slice(0, 300) : '');
}

// ---------------------------------------------------------------------------
// The tree the rich text reader takes
// ---------------------------------------------------------------------------

/** Kept as they are: the reader knows them. */
const KEEP = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'section', 'article', 'header', 'footer']);
/** Blocks the reader has no kind of its own for: their words stay, as paragraphs. */
const AS_BLOCK = new Set(['main', 'aside', 'nav', 'address', 'details', 'summary', 'dl', 'dt', 'dd', 'figcaption', 'fieldset', 'legend', 'center', 'hgroup', 'caption', 'menu']);

const textOf = (n: HNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function descendants(el: HElement, tag: string, out: HElement[] = []): HElement[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.tag === tag) out.push(c);
    descendants(c, tag, out);
  }
  return out;
}

/** The address an embedded post or video shows: a WordPress embed block's own, or its frame's. */
function embedAddress(el: HElement): string | null {
  const cls = el.attrs.class ?? '';
  const frame = descendants(el, 'iframe')[0];
  const url = /\bwp-block-embed\b/.test(cls) ? oneLine(textOf(el)) : (frame?.attrs.src ?? '');
  return /^https?:\/\/[^\s<>"]+$/i.test(url) ? url : null;
}

/** The characters of their own that superscripts and subscripts have, for what they commonly hold. */
const SUP: Record<string, string> = { ...digits('⁰¹²³⁴⁵⁶⁷⁸⁹'), '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB: Record<string, string> = { ...digits('₀₁₂₃₄₅₆₇₈₉'), '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎' };
function digits(forms: string): Record<string, string> {
  return Object.fromEntries([...forms].map((c, d) => [String(d), c]));
}

function mapText(nodes: HNode[], map: Record<string, string>): HNode[] {
  return nodes.map((n) => (typeof n === 'string' ? [...n].map((c) => map[c] ?? c).join('') : { ...n, children: mapText(n.children, map) }));
}

/**
 * A superscript or subscript on the line, which post text has no form for. Written with characters of their own when
 * it has them (m², CO₂, October¹), so its digits never join the number or word before it; otherwise a superscript
 * holding a digit is marked with "^" and a subscript with "_" (10^-1.5). Letters alone, an ordinal's (19th), read as
 * they are. What it holds (a footnote marker's link) is kept.
 */
function raised(node: HElement, convertKids: (nodes: HNode[]) => RichDomNode[], report: HtmlReport): RichDomNode[] {
  const text = textOf(node);
  if (!text.trim()) return [{ tag: 'span', children: convertKids(node.children) }];
  report.raised++;
  const map = node.tag === 'sup' ? SUP : SUB;
  if ([...text].every((c) => /\s/.test(c) || Object.hasOwn(map, c))) return [{ tag: 'span', children: convertKids(mapText(node.children, map)) }];
  const kids: RichDomNode[] = [{ tag: 'span', children: convertKids(node.children) }];
  return /\d/.test(text) ? [node.tag === 'sup' ? '^' : '_', ...kids] : kids;
}

function convert(nodes: HNode[], opts: ReadHtmlOptions, report: HtmlReport, pre = false): RichDomNode[] {
  const out: RichDomNode[] = [];
  let cells = 0;
  for (const node of nodes) {
    if (typeof node === 'string') {
      if (!pre) out.push(node);
      else node.split('\n').forEach((line, k) => (k && out.push({ tag: 'br', children: [] }), line && out.push(line)));
      continue;
    }
    const convertKids = (children: HNode[]) => convert(children, opts, report, pre || node.tag === 'pre');
    const kids = () => convertKids(node.children);
    const tag = node.tag;
    if (tag === 'img') {
      const key = opts.image({ src: node.attrs.src ?? '', alt: oneLine(node.attrs.alt ?? '') });
      if (key) out.push({ tag: 'figure', image: { assetId: key, alt: oneLine(node.attrs.alt ?? '') }, children: [] });
    } else if (tag === 'figure') {
      const imgs = descendants(node, 'img');
      if (imgs.length) {
        const caption = oneLine(descendants(node, 'figcaption').map(textOf).join(' '));
        for (const img of imgs) {
          const key = opts.image({ src: img.attrs.src ?? '', alt: oneLine(img.attrs.alt ?? '') });
          if (key) out.push({ tag: 'figure', image: { assetId: key, alt: oneLine(img.attrs.alt ?? ''), ...(caption && imgs.length === 1 ? { caption } : {}) }, children: [] });
        }
      } else {
        const url = embedAddress(node);
        if (url) {
          report.embedLinks++;
          out.push({ tag: 'p', children: [{ tag: 'a', href: url, children: [url] }] });
        } else if (descendants(node, 'iframe').length) for (const f of descendants(node, 'iframe')) noteEmbed(report, f.attrs.src ?? '');
        else out.push({ tag: 'div', children: kids() });
      }
    } else if (tag === 'iframe') noteEmbed(report, node.attrs.src ?? '');
    else if (tag === 'a') {
      const href = node.attrs.href;
      const rel = relsFromAttribute(node.attrs.rel);
      out.push({ tag: 'a', ...(href !== undefined ? { href } : {}), ...(node.attrs.target === '_blank' ? { newTab: true } : {}), ...(rel.length ? { rel } : {}), children: kids() });
    } else if (tag === 'table') {
      report.tables++;
      out.push({ tag: 'div', children: kids() });
    } else if (tag === 'tr') out.push({ tag: 'p', children: kids() });
    else if (tag === 'td' || tag === 'th') {
      // Cells of a row, one after another on its line.
      if (cells++) out.push(' · ');
      out.push({ tag: 'span', children: kids() });
    } else if (tag === 'pre') {
      if (textOf(node).trim()) report.code++;
      out.push({ tag: 'div', children: kids() });
    } else if (tag === 'sup' || tag === 'sub') out.push(...raised(node, convertKids, report));
    else if (tag === 's' || tag === 'strike' || tag === 'del') {
      if (textOf(node).trim()) report.struck++;
      out.push({ tag: 'span', children: kids() });
    } else if (tag === 'ul' && /(?:^|\s)contains-task-list(?:\s|$)/.test(node.attrs.class ?? '')) out.push({ tag, check: true, children: kids() });
    else if (tag === 'hr') out.push({ tag: 'div', children: [] });
    else if (KEEP.has(tag)) out.push({ tag, children: kids() });
    else if (AS_BLOCK.has(tag) || tag === 'thead' || tag === 'tbody' || tag === 'tfoot') out.push({ tag: 'div', children: kids() });
    else out.push({ tag: 'span', children: kids() });
  }
  return out;
}

/**
 * A post's HTML as the blocks of an entry's text. Pictures carry the key `opts.image` gave them in place of an asset
 * ID, and links what `opts.link` made of them.
 */
export function htmlToRichText(html: string, opts: ReadHtmlOptions, report: HtmlReport = emptyReport()): RichText {
  let text = html;
  if (opts.shortcodes) text = readShortcodes(text, report);
  if (opts.autop) text = autop(text);
  const tree = convert(parseHtml(text, report), opts, report);
  const { blocks, droppedLinks } = blocksFromDom(tree, {}, { link: opts.link });
  report.droppedLinks += droppedLinks;
  return blocks;
}

/** HTML as one line of plain text (a title, an excerpt): tags gone, references read, spaces collapsed. */
export function htmlToPlain(html: string): string {
  return oneLine(richTextToPlain(htmlToRichText(html, { image: () => null, link: () => null, autop: true })));
}
