/** Static route rules for pages. Routes always start and end with "/". */

const RESERVED = new Set(['_app', 'assets', 'api', '__data.json', 'sitemap.xml', 'robots.txt', 'favicon.ico', '_siteorigin']);

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
/** Characters of no script in particular, such as the modifier apostrophe "ʼ", which are punctuation in an address. */
const NO_SCRIPT = /\p{scx=Common}/u;

/**
 * Whether a character may stand in an address: a–z, 0–9 and the hyphen, or a letter, mark or digit of a script other
 * than Latin, so a page titled "お問い合わせ" or "Контакты" can have its natural address while Latin titles keep the
 * plain ASCII addresses they always had.
 */
function addressChar(ch: string): boolean {
  return /^[a-z0-9-]$/.test(ch) || (WORD.test(ch) && !LATIN.test(ch) && !NO_SCRIPT.test(ch));
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

/** Greek sigma spelled by its place: "ς" ending a word, "σ" anywhere else. */
const spellSigma = (text: string) => text.replace(FINAL_SIGMA, 'ς');

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
 * A segment cut to at most `max` code points (never splitting a character outside the Basic Multilingual Plane),
 * without the hyphen the cut may leave at its end, and with a sigma that now ends the word spelled so.
 */
function cutSegment(text: string, max: number): string {
  const points = Array.from(text);
  const cut = points.length > max ? points.slice(0, max).join('').normalize('NFC') : text;
  return spellSigma(cut.replace(/-+$/, ''));
}

/** Code points in a segment: the 60-character limit counts characters, not UTF-16 units. */
const pointCount = (text: string) => Array.from(text).length;

/**
 * The address segment for a page titled `text`: Latin titles as `slugify` makes them ("Café & Bar!" is
 * "cafe-and-bar"), and words in other scripts as written ("お問い合わせ", "привет-мир"), with everything else
 * between words a single hyphen, cut to 60 characters. "" when nothing in the title can be kept.
 */
export function addressSlug(text: string): string {
  const kept = Array.from(foldAddress(text).replace(/&/g, ' and '), (ch) => (ch !== '-' && addressChar(ch) ? ch : '-'))
    .join('')
    // A mark whose letter was not kept cannot start a word.
    .replace(/(^|-)\p{M}+/gu, '$1')
    .replace(/-+/g, '-')
    .replace(/^-+/, '');
  // Trimmed after the cut, which may land on the hyphen between two words.
  return cutSegment(kept, 60);
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
 * starting with a letter or number, at most 60 characters.
 */
export function validateSegment(seg: string): string | null {
  if (!seg) return 'Routes cannot contain empty segments.';
  if (seg === '.' || seg === '..') return 'Routes cannot contain "." or "..".';
  // Plain ASCII addresses, which every Latin title gets, need nothing more.
  if (/^[a-z0-9][a-z0-9-]*$/.test(seg)) return seg.length > 60 ? 'Route segments must be 60 characters or fewer.' : null;
  if (!/^[\p{L}\p{Nd}]/u.test(seg) || !Array.from(seg).every(addressChar)) return `"${seg}" may only contain lowercase letters, numbers and hyphens.`;
  if (pointCount(seg) > 60) return 'Route segments must be 60 characters or fewer.';
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
  if (reserved) slug = `${cutSegment(slug, 55)}-page`;
  const base = `${folder}${slug}/`;
  let route = base;
  for (let i = 2; taken(route); i++) route = `${folder}${numberedSlug(slug, i)}/`;
  return reserved ? { route, base, reserved } : { route, base };
}

/** `slug` numbered `n` ("cafe-2", "カフェ-2"), cut so the whole stays within the 60-character segment limit. */
export function numberedSlug(slug: string, n: number): string {
  return `${cutSegment(slug, 60 - `-${n}`.length)}-${n}`;
}
