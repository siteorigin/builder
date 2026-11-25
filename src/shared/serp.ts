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
  desktop: { title: 600, description: 920 },
  /** A phone wraps the title over two lines and gives the description a little under three of its narrower lines. */
  mobile: { title: 660, description: 680 }
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

/** Marks that join or vary the letter before them and take no room of their own. */
const ZERO = /[̀-ͯ​-‍⁠︀-️]/u;
/** Letters set a full square wide: Chinese, Japanese and Korean, full-width forms, and emoji. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u;
/** What a letter Arial is not measured for here takes: about its average lowercase letter. */
const OTHER = 556;

/** The width of one character (one code point), in thousandths of the type size. */
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

/** How wide text is set in Arial at `fontPx`, in CSS pixels. */
export function textWidth(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of text) units += advance(ch);
  return (units * fontPx) / 1000;
}

/** Text as a results page shows it: whole, or cut short with "…". */
export interface SerpText {
  /** What shows: the text, or as much of it as fits followed by "…". Empty when there is no text. */
  text: string;
  /** Whether it was cut short. */
  cut: boolean;
  /** How wide the whole text is, in CSS pixels. */
  width: number;
  /** The width it has to fit in. */
  max: number;
}

const ELLIPSIS = '…';

/**
 * Text cut to fit `maxWidth` at `fontPx`, as a results page cuts it: at the last word that fits whole, with "…"
 * after it, and mid-word only when not even the first word fits. Whitespace is collapsed first, as a page's `<head>`
 * reads.
 */
export function fitToWidth(value: string, fontPx: number, maxWidth: number): SerpText {
  const text = seoText(value);
  const width = textWidth(text, fontPx);
  if (width <= maxWidth) return { text, cut: false, width, max: maxWidth };
  const room = maxWidth - textWidth(ELLIPSIS, fontPx);
  const chars = [...text];
  let used = 0;
  let end = 0;
  while (end < chars.length) {
    const next = used + (advance(chars[end]) * fontPx) / 1000;
    if (next > room) break;
    used = next;
    end++;
  }
  let kept = chars.slice(0, end).join('');
  // Back to the end of the last whole word, unless the cut already falls between words.
  if (end < chars.length && !/\s/.test(chars[end])) {
    const space = kept.lastIndexOf(' ');
    if (space > 0) kept = kept.slice(0, space);
  }
  kept = kept.replace(/[\s,;:–—-]+$/u, '');
  return { text: kept ? kept + ELLIPSIS : ELLIPSIS, cut: true, width, max: maxWidth };
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
    title: fitToWidth(title, SERP_LAYOUT.titleFont, SERP_LAYOUT[device].title),
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
