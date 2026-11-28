/**
 * How a page or post reads as a search result: its title and description cut to the width a results page gives
 * them, on a computer and on a phone, and the address line above them. Search engines cut by width, not by
 * characters ("WWW" takes more room than "iii"), so text is measured with Arial's letter widths, as snippet
 * simulators do. Google publishes no limits: these are the widths simulators and studies agree on, close enough to
 * say "this will likely be cut" without promising where.
 *
 * Plain data and arithmetic, so the editor's preview, its length meters and the AI tools measure text the same way.
 */
import { seoText } from './seo';

/** The type sizes and widths of a results page, in CSS pixels. */
export const SERP_LAYOUT = {
  titleFont: 20,
  descriptionFont: 14,
  /** One line of title; two lines of description. */
  desktop: { titleLine: 600, titleLines: 1, description: 920 },
  /**
   * A phone wraps the title over two narrow lines, a word at a time, so a long word that doesn't fit at the end of the
   * first line wastes what is left of it; the description gets a little under three of its lines.
   */
  mobile: { titleLine: 320, titleLines: 2, description: 680 }
} as const;

export type SerpDevice = 'desktop' | 'mobile';

/**
 * Arial's advance widths for printable ASCII (space to "~"), in thousandths of the type size: the metrics Arial
 * shares with Helvetica.
 */
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

/** Punctuation and symbols titles often carry, beyond ASCII. */
const SYMBOLS: Record<string, number> = {
  ' ': 278,
  '‘': 222,
  '’': 222,
  '“': 333,
  '”': 333,
  '–': 556,
  '—': 1000,
  '…': 1000,
  '•': 350,
  '·': 278,
  '‹': 333,
  '›': 333,
  '«': 556,
  '»': 556,
  '€': 556,
  '£': 556,
  '¥': 556,
  '©': 737,
  '®': 737,
  '™': 1000,
  '°': 400,
  '×': 584,
  '÷': 584
};

/** Marks set on the letter before them (accents, Hebrew points, Arabic vowels), and joiners: no room of their own. */
const ZERO = /[\p{Mn}\p{Me}​-‍⁠]/u;
/** Letters set a full square wide: Chinese, Japanese and Korean, and full-width forms. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;
/** An emoji or a flag: one picture a full square wide, however many code points (a family, a skin tone) make it. */
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** What a letter Arial is not measured for here takes: about its average lowercase letter. */
const OTHER = 556;

/** The width of one code point, in thousandths of the type size. */
function advance(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code >= 32 && code <= 126) return ASCII[code - 32];
  if (Object.hasOwn(SYMBOLS, ch)) return SYMBOLS[ch];
  if (ZERO.test(ch)) return 0;
  if (WIDE.test(ch)) return 1000;
  // An accented Latin letter is as wide as the letter under its accent ("é" as "e").
  const base = ch.normalize('NFD').codePointAt(0)!;
  if (base >= 32 && base <= 126) return ASCII[base - 32];
  return OTHER;
}

let segmenter: Intl.Segmenter | undefined;

/** Text as a reader sees its characters: a letter with its accents, or a joined emoji, is one. */
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** The width of one character as a reader sees it, in thousandths of the type size. */
function graphemeAdvance(g: string): number {
  if (PICTURE.test(g)) return 1000;
  let units = 0;
  for (const ch of g) units += advance(ch);
  return units;
}

/** How wide text is set in Arial at `fontPx`, in CSS pixels. */
export function textWidth(text: string, fontPx: number): number {
  let units = 0;
  for (const g of graphemes(text)) units += graphemeAdvance(g);
  return (units * fontPx) / 1000;
}

/** Text as a results page shows it: whole, or cut short with "…". */
export interface SerpText {
  /** What shows: the text, or as much of it as fits followed by "…". Empty when there is no text. */
  text: string;
  /** The same, line by line where it is wrapped over lines of its own (a phone's title); one line otherwise. */
  lines: string[];
  /** Whether it was cut short. */
  cut: boolean;
  /** How wide the whole text is, in CSS pixels. */
  width: number;
  /** The width it has to fit in. */
  max: number;
}

const ELLIPSIS = '…';

/** A letter that opens a line of its own kind and so is never left at the end of a line: "(", "「", "【". */
const OPENING = /[(\[{‘“‹«（［｛〈《「『【〔〖〘〚｟]/u;
/** A mark that never starts a line: closing brackets, stops, the long-vowel mark and small kana. */
const CLOSING = /[)\]}.,;:!?%’”›»、。，．：；！？）］｝〉》」』】〕〗〙〛｠゠ー々〻ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ～…‥・]/u;

/** Whether a letter is one Chinese, Japanese or Korean text is broken after at will, with no space between words. */
function ideographic(g: string): boolean {
  const ch = g.codePointAt(0)!;
  return ch > 0x2e7f && WIDE.test(String.fromCodePoint(ch)) && !/\p{Script=Hangul}/u.test(g);
}

/**
 * Whether a line may break between two neighbouring characters with no space between them. Chinese and Japanese
 * break between any two letters (and at the edge of a Latin word or number next to them), except a mark that
 * must not start a line, or one that must not end it, as the Unicode line breaking rules have it.
 */
function breaksBetween(before: string, after: string): boolean {
  if (/\s/.test(before) || /\s/.test(after)) return false;
  if (!ideographic(before) && !ideographic(after)) return false;
  return !CLOSING.test(after) && !OPENING.test(before);
}

/**
 * Text cut to fit `maxWidth` at `fontPx`, as a results page cuts it: at the last place a line may break that fits
 * (a space, or between Chinese or Japanese letters), with "…" after it, and mid-word only when not even the first
 * word fits. It is never cut inside a character (an accent or a joined emoji stays whole). Whitespace is collapsed
 * first, as a page's `<head>` reads.
 */
export function fitToWidth(value: string, fontPx: number, maxWidth: number): SerpText {
  const text = seoText(value);
  const width = textWidth(text, fontPx);
  if (width <= maxWidth) return { text, lines: text ? [text] : [], cut: false, width, max: maxWidth };
  const room = maxWidth - textWidth(ELLIPSIS, fontPx);
  const chars = graphemes(text);
  let used = 0;
  let end = 0;
  while (end < chars.length) {
    const next = used + (graphemeAdvance(chars[end]) * fontPx) / 1000;
    if (next > room) break;
    used = next;
    end++;
  }
  // Back to the last place a line may break, unless the cut already falls on one.
  if (end < chars.length && !/\s/.test(chars[end]) && !(end > 0 && breaksBetween(chars[end - 1], chars[end]))) {
    let back = end - 1;
    while (back > 0 && !/\s/.test(chars[back]) && !breaksBetween(chars[back - 1], chars[back])) back--;
    if (back > 0) end = back;
  }
  const kept = chars.slice(0, end).join('').replace(/[\s,;:–—-]+$/u, '');
  const shown = kept ? kept + ELLIPSIS : ELLIPSIS;
  return { text: shown, lines: [shown], cut: true, width, max: maxWidth };
}

/**
 * Text wrapped over `lines` lines of `lineWidth`, as a browser wraps it: at a space or between Chinese or Japanese
 * letters, with the last line cut to fit as `fitToWidth` cuts. A word wider than a whole line is broken where the
 * line ends.
 */
export function fitLines(value: string, fontPx: number, lineWidth: number, lines: number): SerpText {
  const text = seoText(value);
  const width = textWidth(text, fontPx);
  const max = lineWidth * lines;
  const chars = graphemes(text);
  const wide = chars.map((g) => (graphemeAdvance(g) * fontPx) / 1000);
  const shown: string[] = [];
  let at = 0;
  while (at < chars.length && shown.length < lines - 1) {
    // The furthest place this line may end: the last break that fits, or where the line runs out.
    let used = 0;
    let fit = at;
    let best = -1;
    while (fit < chars.length && used + wide[fit] <= lineWidth) {
      used += wide[fit];
      fit++;
      if (fit === chars.length || /\s/.test(chars[fit]) || breaksBetween(chars[fit - 1], chars[fit])) best = fit;
    }
    const stop = fit === chars.length ? fit : best > at ? best : Math.max(fit, at + 1);
    shown.push(chars.slice(at, stop).join('').trimEnd());
    at = stop;
    while (at < chars.length && /\s/.test(chars[at])) at++;
  }
  if (at < chars.length) {
    const last = fitToWidth(chars.slice(at).join(''), fontPx, lineWidth);
    shown.push(last.text);
    return { text: joinLines(shown, text), lines: shown, cut: last.cut, width, max };
  }
  return { text: joinLines(shown, text), lines: shown, cut: false, width, max };
}

/** Wrapped lines as one text again: a space where the text had one between them, none inside a broken word. */
function joinLines(lines: string[], text: string): string {
  let out = '';
  let at = 0;
  // Every line but the last (which may end in "…") is the text from where the line before it ended.
  for (const line of lines) {
    if (out && text[at] === ' ') {
      out += ' ';
      at++;
    }
    out += line;
    at += line.length;
  }
  return out;
}

/** One result as a results page lays it out on one kind of screen. */
export interface SerpResult {
  title: SerpText;
  description: SerpText;
}

/**
 * A title and description as a computer's and a phone's results show them. `datePrefix` is the date a dated result
 * opens its description with ("2 March 2027 — "), which takes room from the description.
 */
export function serpSnippet({ title, description, datePrefix }: { title: string; description: string; datePrefix?: string }): Record<SerpDevice, SerpResult> {
  const prefix = datePrefix ? textWidth(datePrefix, SERP_LAYOUT.descriptionFont) : 0;
  const lay = (device: SerpDevice): SerpResult => ({
    title: fitLines(title, SERP_LAYOUT.titleFont, SERP_LAYOUT[device].titleLine, SERP_LAYOUT[device].titleLines),
    description: fitToWidth(description, SERP_LAYOUT.descriptionFont, Math.max(0, SERP_LAYOUT[device].description - prefix))
  });
  return { desktop: lay('desktop'), mobile: lay('mobile') };
}

/** The address line over a result: the host, then each folder of the path ("example.com › blog › spring-classes"). */
export interface SerpAddress {
  /** The host, when the document has a public URL to show. */
  host: string | null;
  /** The path's folders, decoded, in order. */
  trail: string[];
}

/** The address line for a document at `url` (its public URL), or at `route` within the site while it has none. */
export function serpAddress(url: string | null, route: string): SerpAddress {
  let host: string | null = null;
  let path = route;
  if (url) {
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {
      // Not an address: the route stands for it.
    }
  }
  const trail = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { host, trail };
}
