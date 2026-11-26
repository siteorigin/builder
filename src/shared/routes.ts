/** Static route rules for pages. Routes always start and end with "/". */
import { SITE_ICON_FILES } from './site-icons';

/**
 * First parts of an address the website keeps for files of its own. Names with a dot are refused before they are looked
 * for here (see validateSegment), so those are kept for completeness, as are the RSS feed and the agentic discovery
 * files (shared/llms.ts), whose Markdown copies (`index.html.md`) no part of an address can hold either, and the
 * generated favicon, web app manifest and home-screen icons (shared/site-icons.ts), and the hosts' redirect rules
 * (generator/host-redirects.ts).
 */
const RESERVED = new Set(['_app', 'assets', 'api', '__data.json', 'sitemap.xml', 'robots.txt', 'favicon.ico', 'favicon.svg', '_siteorigin', 'llms.txt', 'llms-full.txt', 'rss.xml', '_redirects', 'vercel.json', ...SITE_ICON_FILES]);

/** Combining marks NFKD splits off accented letters ("é" is "e" and an accent). */
const ACCENTS = /[\u0300-\u036f]/g;

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(ACCENTS, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 60)
      // Trimmed after the cut, which may land on the hyphen between two words.
      .replace(/-+$/, '')
  );
}

/** Letters of the Latin script, which an address only ever spells as plain a–z. */
const LATIN = /\p{Script=Latin}/u;
/** Letters, combining marks and decimal digits, of any script. */
const WORD = /[\p{L}\p{M}\p{Nd}]/u;
/** Characters of no script in particular, which are punctuation in an address. */
const NO_SCRIPT = /\p{scx=Common}/u;
/** Characters shared between scripts... */
const SHARED = /\p{Script=Common}/u;
/** ...that Latin text uses too, such as the modifier apostrophe of "OʼNeil" and of Ukrainian "обʼєкт". */
const USED_BY_LATIN = /\p{scx=Latin}/u;
const sharedWithLatin = (ch: string) => SHARED.test(ch) && USED_BY_LATIN.test(ch);

/** The most a segment holds: 60 characters, and 120 bytes once written as a folder name (UTF-8). */
const SEGMENT_CHARS = 60;
const SEGMENT_BYTES = 120;

/**
 * Whether a character may stand in an address after `prev` (the character before it, "" at the start): a–z, 0–9 and
 * the hyphen, or a letter, mark or digit of a script other than Latin, so a page titled "お問い合わせ" or "Контакты"
 * can have its natural address while Latin titles keep the plain ASCII addresses they always had. A character Latin
 * text shares ("ʼ") is part of a word in another script ("обʼєкт"), and punctuation after Latin ("OʼNeil").
 */
function addressChar(ch: string, prev: string): boolean {
  if (/^[a-z0-9-]$/.test(ch)) return true;
  if (!WORD.test(ch) || LATIN.test(ch) || NO_SCRIPT.test(ch)) return false;
  return !sharedWithLatin(ch) || (/[\p{L}\p{M}]/u.test(prev) && !LATIN.test(prev) && !sharedWithLatin(prev));
}

/** Whether every character of `text` may stand in an address where it is (see addressChar). */
const addressChars = (text: string) => Array.from(text).map((ch, i, all) => addressChar(ch, all[i - 1] ?? ''));

/** Bytes a code point takes in UTF-8, as file systems count a name's length. */
const utf8Length = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** Bytes `text` takes in UTF-8. */
function utf8Bytes(text: string): number {
  let n = 0;
  for (const ch of text) n += utf8Length(ch.codePointAt(0)!);
  return n;
}

/**
 * Decomposed text without the marks on its Latin letters ("é" is "e") or on nothing at all (a stray accent), as
 * addresses have always been; other scripts keep theirs, since "й", "ά" and "ガ" are letters of their own.
 */
function dropLatinAccents(text: string): string {
  return text.replace(/(\p{L})?(\p{M}+)/gu, (_, base: string | undefined, marks: string) => (base && !LATIN.test(base) ? base + marks : (base ?? '')));
}

/** A Greek sigma ending a word, as Unicode's lowercasing finds one (its Final_Sigma condition). */
const FINAL_SIGMA = /(?<=\p{Cased}\p{Case_Ignorable}*)σ(?!\p{Case_Ignorable}*\p{Cased})/gu;

/**
 * Greek sigma spelled by its place in `text` as it now stands: "ς" ending a word, "σ" anywhere else. Spelled afresh,
 * since turning punctuation into hyphens or cutting a word short moves where words end.
 */
const spellSigma = (text: string) => text.replace(/ς/g, 'σ').replace(FINAL_SIGMA, 'ς');

/**
 * Each letter of a script other than Latin in the one lowercase form a case-insensitive file system also reads as it
 * ("ς" and "σ" are one letter to macOS, and so are a subscript iota and "ι"), with sigma then spelled by its place.
 * So two addresses whose folders would land in the same folder on disk are spelled the same.
 */
function foldCase(text: string): string {
  return spellSigma(text.replace(/\u0345/g, 'ι').replace(/\p{L}/gu, (ch) => (LATIN.test(ch) ? ch : ch.toUpperCase().toLowerCase())));
}

/**
 * Text as an address spells it: compatibility forms folded ("ｶﾌｪ" is "カフェ", "Ｆ" is "f"), lowercase (see
 * foldCase), accents off Latin letters, and composed (NFC). Two spellings of the same words fold to the same address,
 * so comparing addresses as strings finds every collision.
 */
function foldAddress(text: string): string {
  return foldCase(dropLatinAccents(text.normalize('NFKD').toLowerCase())).normalize('NFC');
}

/**
 * A segment cut to at most `chars` code points and `bytes` UTF-8 bytes (never splitting a character outside the Basic
 * Multilingual Plane), without the hyphen the cut may leave at its end, and with a sigma that now ends the word
 * spelled so. With `wholeWords`, a cut that would land inside a word ends at the hyphen before it instead, unless the
 * first word alone is too long.
 */
function cutSegment(text: string, chars: number, bytes: number, wholeWords = false): string {
  let kept = 0;
  let size = 0;
  let end = 0;
  for (const ch of text) {
    size += utf8Length(ch.codePointAt(0)!);
    if (++kept > chars || size > bytes) break;
    end += ch.length;
  }
  if (wholeWords && end < text.length && text[end] !== '-') {
    const lastBreak = text.lastIndexOf('-', end - 1);
    if (lastBreak > 0) end = lastBreak;
  }
  const cut = end < text.length ? text.slice(0, end).normalize('NFC') : text;
  return spellSigma(cut.replace(/-+$/, ''));
}

/** Code points in a segment: the 60-character limit counts characters, not UTF-16 units. */
const pointCount = (text: string) => Array.from(text).length;

/**
 * The address segment for a page titled `text`: Latin titles as `slugify` makes them ("Café & Bar!" is
 * "cafe-and-bar"), and words in other scripts as written ("お問い合わせ", "привет-мир"), with everything else
 * between words a single hyphen, cut to fit a segment (60 characters, 40 in Japanese). "" when nothing in the title
 * can be kept.
 */
export function addressSlug(text: string, opts: { wholeWords?: boolean } = {}): string {
  // What is kept depends on what is kept before it ("ʼ" stays only after a letter that stays), so the text is
  // filtered until nothing more changes; each pass can only turn characters into hyphens.
  let kept = keepAddressChars(foldAddress(text).replace(/&/g, ' and '));
  for (let next = keepAddressChars(kept); next !== kept; next = keepAddressChars(kept)) kept = next;
  // Trimmed after the cut, which may land on the hyphen between two words.
  return cutSegment(kept, SEGMENT_CHARS, SEGMENT_BYTES, opts.wholeWords);
}

/** `text` with each character an address cannot hold where it stands as a hyphen, and no hyphen leading or doubled. */
function keepAddressChars(text: string): string {
  const fits = addressChars(text);
  return Array.from(text, (ch, i) => (ch !== '-' && fits[i] ? ch : '-'))
    .join('')
    // A mark whose letter was not kept cannot start a word.
    .replace(/(^|-)\p{M}+/gu, '$1')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
}

/** A segment as pasted from a browser's address bar ("%E3%81%8A..."), decoded; anything else stays as typed. */
function decodeSegment(segment: string): string {
  if (!/%[0-9a-f]{2}/i.test(segment)) return segment;
  try {
    const decoded = decodeURIComponent(segment);
    // An escaped slash is not a folder: left encoded, validation refuses it.
    return /[/\\]/.test(decoded) ? segment : decoded;
  } catch {
    return segment;
  }
}

/**
 * A route as someone may type it ("About Us", "/Café Menu", "/お問い合わせ/", or an address copied from a browser
 * with its escapes): each segment decoded, folded as addresses spell it (see foldAddress), and with its spaces as
 * hyphens. Anything else a segment cannot hold is left for validateRoute to refuse, so a reserved or hidden name
 * ("_app") is never quietly turned into an ordinary one, a full-width slash never becomes a folder, and a segment of
 * accents alone stays one.
 */
export function normalizeRoute(input: string): string {
  const parts = input
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const folded = foldAddress(decodeSegment(p)).trim().replace(/\s+/g, '-');
      return folded && !/[/\\]/.test(folded) ? folded : p.toLowerCase();
    });
  return parts.length ? `/${parts.join('/')}/` : '/';
}

/**
 * Returns an error message for one segment of an address (a page's last part, or an entry's slug), or null when it is
 * valid: a–z, 0–9 and hyphens, or letters, marks and digits of other scripts, spelled as foldAddress spells them,
 * starting with a letter or number, at most 60 characters and 120 bytes (UTF-8). The bytes keep an address four
 * levels deep in another script well within the longest path a file system takes; ASCII never reaches them.
 */
export function validateSegment(seg: string): string | null {
  if (!seg) return 'Routes cannot contain empty segments.';
  if (seg === '.' || seg === '..') return 'Routes cannot contain "." or "..".';
  // Plain ASCII addresses, which every Latin title gets, need nothing more.
  if (/^[a-z0-9][a-z0-9-]*$/.test(seg)) return seg.length > 60 ? 'Route segments must be 60 characters or fewer.' : null;
  if (!/^[\p{L}\p{Nd}]/u.test(seg) || !addressChars(seg).every(Boolean)) return `"${seg}" may only contain lowercase letters, numbers and hyphens.`;
  if (pointCount(seg) > SEGMENT_CHARS) return 'Route segments must be 60 characters or fewer.';
  if (utf8Bytes(seg) > SEGMENT_BYTES) return 'Route segments must be 60 characters or fewer, and fewer in scripts whose letters take more room (about 40 in Japanese, Chinese or Korean).';
  // One spelling per address, so two that look the same, or share a folder on disk, are the same route.
  const folded = foldAddress(seg);
  return folded === seg ? null : `"${seg}" must be written "${folded}".`;
}

/** Returns an error message, or null when the route is valid. */
export function validateRoute(route: string): string | null {
  if (route === '/') return null;
  if (!route.startsWith('/') || !route.endsWith('/')) return 'Routes must start and end with "/".';
  const segments = route.slice(1, -1).split('/');
  if (segments.length > 4) return 'Routes can be at most four levels deep.';
  for (const seg of segments) {
    const err = validateSegment(seg);
    if (err) return err;
  }
  if (RESERVED.has(segments[0]) || segments[0].startsWith('_')) return `"/${segments[0]}/" is reserved.`;
  return null;
}

/**
 * A route as an absolute URL carries it, after the site's public address: "/お問い合わせ/" escaped as
 * "/%E3%81%8A…/" (sitemaps require it, and crawlers and social sites read it reliably), ASCII routes as they are.
 * Page links inside the site keep the route as written; browsers escape those themselves.
 */
export function routeUrl(route: string): string {
  return encodeURI(route);
}

/**
 * A path as routes spell it: escapes a browser or a copied address added decoded ("/%E3%81%8A…/" is "/お…/"),
 * except those of a slash, "?" or "#", so it never names another place. A path that is not valid UTF-8 stays as
 * it is, and matches no route.
 */
export function readablePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Directory under src/routes for a route ("" for home). */
export function routeDir(route: string): string {
  return route.replace(/^\/+|\/+$/g, '');
}

/**
 * The address a page titled `title` gets in `folder` ("/" for the top level, or a page's address for a page inside
 * it): its addressSlug, made valid when it is a reserved name, with a numbered suffix while `taken` says the address is
 * in use, kept within the 60-character segment limit. `base` is the address before any suffix and `reserved` the
 * reserved address it avoided. The Pages panel previews new addresses with it, so the preview is what the page gets.
 */
export function suggestRoute(title: string, taken: (route: string) => boolean, fallback = 'page', folder = '/'): { route: string; base: string; reserved?: string } {
  let slug = addressSlug(title) || fallback;
  const first = `${folder}${slug}/`;
  // Only a top-level name can be reserved; deeper, a slug is always a valid segment.
  const reserved = folder === '/' && validateRoute(first) ? first : undefined;
  if (reserved) slug = `${cutSegment(slug, SEGMENT_CHARS - 5, SEGMENT_BYTES - 5)}-page`;
  const base = `${folder}${slug}/`;
  let route = base;
  // Bounded, so a folder where every address is kept (a collection's archive pages) can never hang the caller.
  for (let i = 2; taken(route) && i < 10000; i++) route = `${folder}${numberedSlug(slug, i)}/`;
  return reserved ? { route, base, reserved } : { route, base };
}

/** `slug` numbered `n` ("cafe-2", "カフェ-2"), cut so the whole stays within a segment's limits. */
export function numberedSlug(slug: string, n: number): string {
  const suffix = `-${n}`;
  return `${cutSegment(slug, SEGMENT_CHARS - suffix.length, SEGMENT_BYTES - suffix.length)}${suffix}`;
}
