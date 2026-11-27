import type { SiteDoc } from '@shared/types';
import { checkPublicUrl } from '@shared/public-url';
import { isLanguageCode, siteLanguage } from '@shared/languages';
import { showsNothing } from '@shared/not-found';
import { ENTITY_KIND_LABELS, isEntityKind } from '@shared/site-identity';
import { languageName } from './VisitorText';

/**
 * Site details' closed heading: where the site lives (its public address's host, without "www."), else who publishes
 * it when the owner has said, else the pictures chosen for it, else its language when that is not the starters' English,
 * else nothing: a new site's starter name and description are not settings of its own.
 */
export function siteDetailsScope(site: Pick<SiteDoc, 'baseUrl' | 'identity' | 'favicon' | 'socialImage' | 'language'>): string | undefined {
  const c = typeof site.baseUrl === 'string' ? checkPublicUrl(site.baseUrl) : null;
  if (c?.ok && c.url) {
    try {
      return new URL(c.url).host.replace(/^www\./i, '');
    } catch {
      // Checked already; an address URL can't parse says nothing.
    }
  }
  const kind = site.identity && typeof site.identity === 'object' ? (site.identity as { kind?: unknown }).kind : undefined;
  if (isEntityKind(kind)) return ENTITY_KIND_LABELS[kind];
  const favicon = typeof site.favicon === 'string' && site.favicon !== '';
  const social = typeof site.socialImage === 'string' && site.socialImage !== '';
  if (favicon || social) return favicon && social ? '2 images' : favicon ? 'Favicon' : 'Sharing image';
  const language = siteLanguage(site);
  return language.toLowerCase() === 'en' ? undefined : (namedLanguage(language) ?? language);
}

/** The not-found page's wordings, in page order. */
export const NOT_FOUND_KEYS = ['notFoundHeading', 'notFoundMessage', 'notFoundLinkLabel'] as const;

/** Wording of the author's own: text the page shows (not only spaces or invisible characters, which it replaces). */
export const ownWording = (v: unknown): string => (typeof v === 'string' && !showsNothing(v) ? v : '');

/** The not-found page's closed heading: how many of its wordings are the author's own, or nothing while none is. */
export function notFoundScope(site: Pick<SiteDoc, (typeof NOT_FOUND_KEYS)[number]>): string | undefined {
  const n = NOT_FOUND_KEYS.filter((k) => ownWording(site[k])).length;
  return n ? `${n} changed` : undefined;
}

/**
 * Languages an owner is likely to type by name, checked in this order: a name matches the first whose English name it
 * is, so "French" is fr and "French (Canada)" is fr-CA. Codes outside the list are still typed as codes.
 */
const NAMED_LANGUAGES = [
  'en', 'en-GB', 'en-US', 'en-AU', 'en-CA', 'en-NZ', 'en-IE', 'en-ZA', 'en-IN', 'fr', 'fr-CA', 'fr-BE', 'fr-CH', 'de', 'de-AT', 'de-CH', 'es', 'es-MX', 'es-419', 'it', 'pt', 'pt-BR', 'pt-PT',
  'nl', 'nl-BE', 'sv', 'da', 'nb', 'nn', 'no', 'fi', 'is', 'pl', 'cs', 'sk', 'sl', 'hr', 'sr', 'bs', 'hu', 'ro', 'bg', 'el', 'ru', 'uk', 'be', 'lt', 'lv', 'et', 'ga', 'cy', 'mt', 'sq', 'mk',
  'tr', 'ka', 'hy', 'az', 'kk', 'he', 'ar', 'fa', 'ur', 'ps', 'ku', 'hi', 'bn', 'pa', 'gu', 'mr', 'ta', 'te', 'kn', 'ml', 'si', 'ne', 'ja', 'ko', 'zh', 'zh-Hans', 'zh-Hant', 'th', 'vi', 'id',
  'ms', 'tl', 'fil', 'km', 'lo', 'my', 'mn', 'af', 'zu', 'xh', 'st', 'tn', 'sw', 'am', 'yo', 'ig', 'ha', 'so', 'mi', 'sm', 'to', 'haw', 'eu', 'ca', 'gl', 'eo', 'la'
];
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The code for a language typed by its name ("French" → "fr", "french (canada)" → "fr-CA"), or null when the text is a
 * code already or names no language on the list.
 */
export function languageCodeFor(text: string): string | null {
  const typed = fold(text);
  if (!typed || isLanguageCode(text.trim())) return null;
  return NAMED_LANGUAGES.find((code) => fold(languageName(code)) === typed) ?? null;
}

/** A language code with its name, as the site's language is shown: "French (Canada)", or null for a code with no name. */
export function namedLanguage(code: string): string | null {
  if (!isLanguageCode(code)) return null;
  const name = languageName(code);
  return name !== code ? name : null;
}
