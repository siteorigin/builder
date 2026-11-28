import type { PageDoc, ProjectState, SiteDoc } from './types';

/** A language code of the shape a page or site accepts: "en", "fr", "en-AU", "zh-Hant-TW". */
export const LANGUAGE_CODE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

export const LANGUAGE_CODE_ERROR = 'Language must be a code such as "en" or "en-AU".';

export function isLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE_CODE.test(value);
}

/** The site's language as documents declare it; a missing or malformed one reads as English. */
export function siteLanguage(site: Pick<SiteDoc, 'language'>): string {
  return isLanguageCode(site.language) ? site.language : 'en';
}

/** The language a page is written in: its own when it names a valid one, otherwise the site's. */
export function pageLanguage(site: Pick<SiteDoc, 'language'>, page: Pick<PageDoc, 'language'>): string {
  return isLanguageCode(page.language) ? page.language : siteLanguage(site);
}

/** Which way text runs: left to right, or right to left. */
export type TextDirection = 'ltr' | 'rtl';

/** Languages written right to left in their usual script, Arabic's regional varieties under their own codes ("arz", "ary") included (Hebrew and Yiddish also under their old codes). */
const RTL_LANGUAGES = new Set(['ar', 'aao', 'abh', 'abv', 'acm', 'acq', 'acw', 'acx', 'adf', 'aeb', 'aec', 'afb', 'ajp', 'apc', 'apd', 'arb', 'arq', 'ars', 'ary', 'arz', 'auz', 'avl', 'ayh', 'ayl', 'ayn', 'ayp', 'shu', 'ssh', 'bgn', 'haz', 'hnd', 'lki', 'mey', 'jrb', 'aju', 'jye', 'yhd', 'yud', 'arc', 'azb', 'bal', 'bqi', 'ckb', 'dv', 'fa', 'glk', 'he', 'iw', 'ji', 'khw', 'ks', 'lrc', 'mzn', 'nqo', 'pnb', 'prs', 'ps', 'sd', 'sdh', 'skr', 'syr', 'ug', 'ur', 'yi']);
/** Scripts written right to left. A code that names its script ("az-Arab", "ku-Latn") goes the script's way. */
const RTL_SCRIPTS = new Set(['adlm', 'arab', 'aran', 'hebr', 'mand', 'mend', 'nkoo', 'rohg', 'samr', 'syrc', 'thaa', 'yezi']);

/**
 * Languages whose usual script in a region differs from the one it has elsewhere (Unicode's likely subtags):
 * Punjabi in Pakistan is written in Arabic script, Sindhi in India in Devanagari.
 */
const REGION_DIRECTIONS: Record<string, TextDirection> = { 'pa-pk': 'rtl', 'az-ir': 'rtl', 'ku-iq': 'rtl', 'ku-ir': 'rtl', 'uz-af': 'rtl', 'tg-pk': 'rtl', 'kk-cn': 'rtl', 'ky-cn': 'rtl', 'sd-in': 'ltr', 'mey-sn': 'ltr' };

/** The way a language is written: right to left for Arabic, Hebrew and the like, left to right otherwise. */
export function languageDirection(code: string): TextDirection {
  const [primary = '', ...rest] = code.toLowerCase().split('-');
  const script = rest.find((s) => /^[a-z]{4}$/.test(s));
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  const region = rest.find((s) => /^([a-z]{2}|\d{3})$/.test(s));
  const regional = region ? REGION_DIRECTIONS[`${primary}-${region}`] : undefined;
  return regional ?? (RTL_LANGUAGES.has(primary) ? 'rtl' : 'ltr');
}

/** The way the site's language runs: the site's own choice when it makes one, otherwise its language's way. */
export function siteDirection(site: Pick<SiteDoc, 'language' | 'direction'>): TextDirection {
  return site.direction === 'ltr' || site.direction === 'rtl' ? site.direction : languageDirection(siteLanguage(site));
}

/**
 * The way a page's text runs. A page in the site's language follows the site, its choice included; a page in
 * another language runs the way that language is written.
 */
export function pageDirection(site: Pick<SiteDoc, 'language' | 'direction'>, page: Pick<PageDoc, 'language'>): TextDirection {
  const language = pageLanguage(site, page);
  return sameLanguage(language, siteLanguage(site)) ? siteDirection(site) : languageDirection(language);
}

/** Language codes are case-insensitive: "en-AU" and "en-au" name the same language. */
export function sameLanguage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Registered whole tags the platform does not replace itself, with the code the IANA registry prefers. */
const LEGACY_TAGS: Record<string, string> = { 'no-bok': 'nb', 'no-nyn': 'nn', 'zh-hakka': 'hak', 'zh-min-nan': 'nan', 'zh-xiang': 'hsn' };
/** An extended language written after its macrolanguage ("zh-yue"), which the registry prefers alone ("yue"); "zh-min" is no such pair. */
const EXTLANG_PREFIX = /^(?:ar|kok|lv|ms|sgn|sw|uz|zh)-(?=(?!min\b)[a-z]{3}(?:-|$))/;

/**
 * What the versions in a translation set are told apart by: the canonical code in lower case, so a deprecated code
 * ("iw", "in") is the language that replaced it ("he", "id"). A code the platform cannot canonicalize is compared
 * as written. Only translation sets compare this way: the website keeps each code, and the wording filed under it,
 * as the author wrote it (sameLanguage).
 */
export function languageKey(code: string): string {
  const lower = code.toLowerCase();
  const current = (LEGACY_TAGS[lower] ?? lower).replace(EXTLANG_PREFIX, '');
  try {
    return Intl.getCanonicalLocales(current)[0].toLowerCase();
  } catch {
    return current;
  }
}

/** The translation group a page belongs to, if any. Only a string names one. */
export function translationGroup(page: Pick<PageDoc, 'translationGroup'>): string | undefined {
  return typeof page.translationGroup === 'string' && page.translationGroup ? page.translationGroup : undefined;
}

/** Every page in a translation group, in page order (pages missing from the order last). */
export function translationMembers(state: Pick<ProjectState, 'site' | 'pages'>, group: string): PageDoc[] {
  const ordered = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id));
  const rest = Object.keys(state.pages).filter((id) => !ordered.includes(id));
  return [...ordered, ...rest].map((id) => state.pages[id]).filter((p) => p && translationGroup(p) === group);
}

/** The other versions of a page in other languages, in page order. */
export function translationPeers(state: Pick<ProjectState, 'site' | 'pages'>, page: PageDoc): PageDoc[] {
  const group = translationGroup(page);
  return group ? translationMembers(state, group).filter((p) => p.id !== page.id) : [];
}

/** The set a page is in: its group key when another page shares it, so a key left on one page alone counts as none. */
export function linkedGroup(state: Pick<ProjectState, 'site' | 'pages'>, page: PageDoc): string | undefined {
  return translationPeers(state, page).length ? translationGroup(page) : undefined;
}

/** A value from a document, as it reads in a message: hand-written JSON may hold anything. */
export function shownValue(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/** Two pages of one translation group in the same language. */
export interface TranslationClash {
  group: string;
  a: PageDoc;
  b: PageDoc;
  language: string;
}

/** The first two pages of a set of pages that are in the same language, if any. */
function firstClash(site: Pick<SiteDoc, 'language'>, pages: PageDoc[], group: string): TranslationClash | null {
  const seen = new Map<string, PageDoc>();
  for (const p of pages) {
    const language = pageLanguage(site, p);
    const key = languageKey(language);
    const first = seen.get(key);
    if (first) return { group, a: first, b: p, language };
    seen.set(key, p);
  }
  return null;
}

/** Every translation group with two pages in the same language: its first such pair. */
export function translationClashes(state: Pick<ProjectState, 'site' | 'pages'>): TranslationClash[] {
  const groups = [...new Set(Object.values(state.pages).map((p) => p && translationGroup(p)).filter((g): g is string => !!g))];
  return groups.flatMap((g) => firstClash(state.site, translationMembers(state, g), g) ?? []);
}

/** Two pages of one translation group (or of any group) that are in the same language, the first such pair found. */
export function translationClash(state: Pick<ProjectState, 'site' | 'pages'>, group?: string): TranslationClash | null {
  return group ? firstClash(state.site, translationMembers(state, group), group) : (translationClashes(state)[0] ?? null);
}

/**
 * Whether linking two pages would put two versions in the same language: the pages of both sets, together. A
 * group key no other page shares is no set at all.
 */
export function linkClash(state: Pick<ProjectState, 'site' | 'pages'>, page: PageDoc, other: PageDoc): TranslationClash | null {
  const pages = [page, ...translationPeers(state, page), other, ...translationPeers(state, other)].filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
  return firstClash(state.site, pages, translationGroup(page) ?? translationGroup(other) ?? '');
}

/** How a clash reads to the author. */
export function translationClashMessage(clash: Pick<TranslationClash, 'a' | 'b' | 'language'>): string {
  return `“${clash.a.title}” and “${clash.b.title}” are translations of each other and would both be in “${clash.language}”. Give one of them its own language, or unlink them.`;
}

/**
 * A document's opening <html> tag, after any doctype, comments and white space before it: what comes before, the tag
 * name as written, its attributes, and the end of the tag. Quoted attribute values may hold anything, ">" included.
 * Each comment ends at its first "-->", so a document without the tag is turned down in one pass.
 */
export const HTML_START = /^((?:\s|<!--(?:(?!-->)[\s\S])*-->|<!doctype[^>]*>)*)<(html)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)(\s*\/?>)/i;

/** One attribute of a tag: the white space before it, its name, and its value as written (with any quotes). */
export const HTML_ATTR = /(\s+)([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** An attribute an HTML document's opening <html> tag declares, or null when it declares none. */
function rootAttribute(html: string, attribute: string): string | null {
  // The opening tag is near the start; a page's whole body is never searched.
  const attrs = html.slice(0, 65536).match(HTML_START)?.[3] ?? '';
  for (const [, , name, value] of attrs.matchAll(HTML_ATTR)) if (name.toLowerCase() === attribute) return value === undefined ? '' : value.replace(/^["']|["']$/g, '');
  return null;
}

/** The lang an HTML document's opening <html> tag declares, or null when it declares none. */
export const declaredLanguage = (html: string): string | null => rootAttribute(html, 'lang');

/** The dir an HTML document's opening <html> tag declares, or null when it declares none. */
export const declaredDirection = (html: string): string | null => rootAttribute(html, 'dir');

/**
 * The first page a change of the site's language would put in the language of one of its translations: a page that
 * uses the site language, and another version that names the new language as its own. Sets that already had two
 * versions in one language before are not this change's doing.
 */
export function siteLanguageClash(state: Pick<ProjectState, 'site' | 'pages'>, language: string): TranslationClash | null {
  const key = languageKey(language);
  if (languageKey(siteLanguage(state.site)) === key) return null;
  const groups = [...new Set(Object.values(state.pages).map((p) => p && translationGroup(p)).filter((g): g is string => !!g))];
  for (const group of groups) {
    const members = translationMembers(state, group);
    const named = members.find((p) => isLanguageCode(p.language) && languageKey(p.language) === key);
    const follows = members.find((p) => !isLanguageCode(p.language));
    if (named && follows) return { group, a: named, b: follows, language };
  }
  return null;
}

/** Why the site can't take this language, or null when it can: the engine refuses it, and Site details says so
 *  beside the field before anything is sent. */
export function siteLanguageProblem(state: Pick<ProjectState, 'site' | 'pages'>, language: string): string | null {
  if (!isLanguageCode(language)) return LANGUAGE_CODE_ERROR;
  // Pages that use the site language follow it: none may end up in the language of one of its translations. A set
  // that already had two versions in one language (written by hand) is reported elsewhere and does not stop this.
  const clash = siteLanguageClash(state, language);
  return clash ? `${translationClashMessage(clash)} Pages without a language of their own use the site language.` : null;
}
