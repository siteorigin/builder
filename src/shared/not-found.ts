import type { SiteDoc } from './types';
import { siteLanguage } from './languages';

/**
 * The page visitors see at an address the site does not have. It is built as `404.html` at the root of the
 * website, the file static hosts serve for a missing address, and is never a page of its own in the page list.
 */

/** Its SvelteKit route: page routes cannot contain a dot, so no page or old address can take it. */
export const NOT_FOUND_ROUTE = '/404.html';
/** The file the build writes it to, relative to the website folder. */
export const NOT_FOUND_FILE = '404.html';

export const NOT_FOUND_DEFAULTS = {
  heading: 'Page not found',
  message: 'Sorry, there is no page at this address. It may have moved, or the address may be mistyped.',
  linkLabel: 'Go to the home page'
};

/** The built-in wording in other languages, by primary language subtag. */
const NOT_FOUND_TRANSLATIONS: Record<string, typeof NOT_FOUND_DEFAULTS> = {
  ar: {
    heading: 'الصفحة غير موجودة',
    message: 'عذرًا، لا توجد صفحة على هذا العنوان. ربما نُقلت، أو ربما كُتب العنوان بشكل خاطئ.',
    linkLabel: 'الانتقال إلى الصفحة الرئيسية'
  },
  he: {
    heading: 'הדף לא נמצא',
    message: 'מצטערים, אין דף בכתובת הזו. ייתכן שהוא הועבר, או שהכתובת הוקלדה בטעות.',
    linkLabel: 'מעבר לדף הבית'
  }
};
NOT_FOUND_TRANSLATIONS.iw = NOT_FOUND_TRANSLATIONS.he;

/** The page's built-in wording in a language: its own when there is some, English otherwise. */
export function notFoundDefaults(language: string): typeof NOT_FOUND_DEFAULTS {
  const primary = language.toLowerCase().split('-')[0];
  return Object.hasOwn(NOT_FOUND_TRANSLATIONS, primary) ? NOT_FOUND_TRANSLATIONS[primary] : NOT_FOUND_DEFAULTS;
}

/** The longest wording an author can set for each. */
export const NOT_FOUND_LIMITS = { heading: 120, message: 400, linkLabel: 60 };

/** `text` cut to at most `limit` UTF-16 units (what the operation's schema counts) without splitting a character. */
export function clipText(text: string, limit: number): string {
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > limit) break;
    out += ch;
  }
  return out;
}

/** Characters that show nothing: spaces, and the zero-width and other invisible formatting characters. */
const INVISIBLE = /^[\s\p{Cf}\u115F\u1160\u2800\u3164\uFFA0]*$/u;

/**
 * What the page says: the author's own wording, or the default for anything left empty or showing nothing. Read
 * defensively, since site.json may have been edited by hand: the link home always has a name visitors can read.
 */
export function notFoundCopy(site: Pick<SiteDoc, 'language' | 'notFoundHeading' | 'notFoundMessage' | 'notFoundLinkLabel'>): typeof NOT_FOUND_DEFAULTS {
  const own = (v: unknown, limit: number) => {
    const text = typeof v === 'string' ? clipText(v.trim(), limit).trim() : '';
    return INVISIBLE.test(text) ? '' : text;
  };
  // The page is in the site's language.
  const defaults = notFoundDefaults(siteLanguage(site));
  return {
    heading: own(site.notFoundHeading, NOT_FOUND_LIMITS.heading) || defaults.heading,
    message: own(site.notFoundMessage, NOT_FOUND_LIMITS.message) || defaults.message,
    linkLabel: own(site.notFoundLinkLabel, NOT_FOUND_LIMITS.linkLabel) || defaults.linkLabel
  };
}

/** Where a host's error-document setting must point for a site published under `base` ("" or "/my-site"). */
export const notFoundPath = (base: string) => `${base}/${NOT_FOUND_FILE}`;
