/**
 * The shared SEO contract: what a page or collection entry tells search engines and link previews, which of the
 * website's outputs include it, and the findings an SEO audit reports. The generator resolves documents
 * (generator/seo-metadata.ts) and builds their linked structured data (generator/seo-graph.ts); the engine audits a
 * project (engine/seo-audit.ts). Everything here is plain data, so the editor, the export and the AI tools read the
 * same answer.
 */
import type { AssetRecord } from './types';
import type { Diagnostic, EditorDestination } from './api';

/** A document of the website that has metadata of its own: a page, or a collection entry. */
export type SeoSubject = { kind: 'page'; pageId: string } | { kind: 'entry'; collectionId: string; entryId: string };

/**
 * Which of the website's outputs a document belongs in: the rule each output follows, so features that add to an
 * output read one answer. Two outputs carry less than this says until the features that fill them land: site search
 * lists pages alone until it indexes entries (#398), and the connected graph is written into pages from #586.
 */
export interface SeoVisibility {
  /** The website has a page for it: not a draft, and its address is its own. */
  website: boolean;
  /** Search engines may list it: on the website and not `noindex`. */
  indexable: boolean;
  /** The sitemap lists it: indexable, with a public URL to list it at. */
  sitemap: boolean;
  /** The site's own search may find it: on the website and not hidden from site search. */
  siteSearch: boolean;
  /** It may carry the connected structured data graph: the same conditions as the sitemap. */
  jsonLd: boolean;
  /** News lists show it: a published page that is a dated article not hidden from them. Entries have feeds of their own. */
  news: boolean;
}

/** Where a document's sharing image comes from: a page's own choice, an entry's featured image, the site's, or nowhere. */
export type SeoImageSource = 'own' | 'featured' | 'site' | 'none';

/** What one document says about itself, with every fallback applied, and where it is published. */
export interface EffectiveSeo {
  subject: SeoSubject;
  /** Its address within the site ("/about/"). */
  route: string;
  /** The public URL it is reached at (the site's public URL and its route), when the site has one. */
  url: string | null;
  /**
   * The address search engines are told is its own, which its page's canonical link and og:url name: the author's
   * canonical override when it is a valid one, else its public URL.
   */
  canonical: string | null;
  /** The browser title. */
  title: string;
  /** The title a link preview shows (an entry's own title, unbranded, when it has no SEO title). */
  socialTitle: string;
  /** Its own description, else the one it falls back to; empty when there is none. */
  description: string;
  /** The language it is written in, as a code. */
  language: string;
  /** The sharing image chosen for it, whether or not the library still has it. */
  imageId: string | null;
  /** That image, when the library has it as a picture. */
  image: AssetRecord | undefined;
  imageSource: SeoImageSource;
  /** The public URL of that image, when the site has a public URL and the image is in the library. */
  imageUrl: string | null;
  /** What that image shows, for people who cannot see it: the library's suggested description, else its own. */
  imageAlt: string;
  /** The publication date (YYYY-MM-DD) of an entry or a dated article; null for anything else. */
  published: string | null;
  /** When it was last revised (YYYY-MM-DD), as the author states it; null when no valid date is given. */
  modified: string | null;
  /** Who wrote it, as written: an entry's author or a dated article's byline. Empty when nobody is named. */
  author: string;
  /** The label of an entry's first category: the section of the site it belongs to. Empty for pages. */
  section: string;
  /** The labels of an entry's tags, in the order they were assigned. None for pages. */
  tags: string[];
  draft: boolean;
  noindex: boolean;
  searchHidden: boolean;
  visibility: SeoVisibility;
}

/** The groups SEO findings are told apart by, in the order they are shown. */
export const SEO_PILLARS = ['technical', 'entity', 'agentic', 'content', 'social'] as const;
export type SeoPillar = (typeof SEO_PILLARS)[number];

/**
 * One thing an SEO audit found. It is a Diagnostic, so it is told apart from others (and from the same finding on a
 * later run) as diagnostics are, and it says where it is fixed as export notes do.
 */
export interface SeoFinding extends Diagnostic {
  pillar: SeoPillar;
  /** Why it matters, in a sentence or two the author (or the AI) can act on. `message` names the problem itself. */
  explanation: string;
  /** Whether the AI has an edit that can fix it from what the project holds. It grants nothing on its own. */
  aiFixable: boolean;
  /** Where the author fixes it, when one place does. */
  destination?: EditorDestination;
}

/** Text as search engines measure and compare it: whitespace collapsed and trimmed, composed. Anything else is no text. */
export function seoText(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/** How many characters text is, as a reader counts them (an emoji or an accented letter is one). */
export function seoLength(value: string): number {
  return [...value].length;
}

/** The most characters a canonical URL keeps. */
export const CANONICAL_URL_MAX = 2000;

/** A canonical URL as checked: the address to store ("" when none is set), or why it can't be used. */
export type CanonicalUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/**
 * Check an address typed as a page's or an entry's canonical URL: an absolute http(s) URL with a host, which may be
 * on another site, with no user name, password or "#" part. Gives back the address as browsers write it
 * ("HTTPS://Example.com/a" -> "https://example.com/a").
 */
export function checkCanonicalUrl(input: string): CanonicalUrlCheck {
  const refuse = (message: string): CanonicalUrlCheck => ({ ok: false, message });
  const text = input.trim();
  if (!text) return { ok: true, url: '' };
  if (text.length > CANONICAL_URL_MAX) return refuse(`The canonical URL can be at most ${CANONICAL_URL_MAX} characters.`);
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return refuse('The canonical URL can’t contain spaces or control characters.');
  if (text.includes('\\')) return refuse('Use “/” rather than “\\” in the canonical URL.');
  if (!/^https?:\/\//i.test(text)) return refuse('The canonical URL must be a full address starting with https:// (or http://).');
  if (text.includes('#')) return refuse('Leave the “#” part out of the canonical URL.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse(`“${text.slice(0, 80)}” is not an address browsers can open.`);
  }
  if (!url.hostname) return refuse('The canonical URL needs a host name after https://, such as https://example.com/.');
  if (url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(text)) return refuse('Leave the user name and password out of the canonical URL.');
  return { ok: true, url: url.href };
}

/** A stored canonical URL when it is a valid one, as it is written; null for anything else (a hand-edited value). */
export function storedCanonical(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const check = checkCanonicalUrl(value);
  return check.ok && check.url ? check.url : null;
}

/**
 * A language code as Open Graph writes a locale, language and territory ("en-AU" -> "en_AU"). A code that names no
 * territory takes its most likely one ("fr" -> "fr_FR", "zh-Hant" -> "zh_TW"); null when none can be told.
 */
export function ogLocale(code: string): string | null {
  try {
    const given = new Intl.Locale(code);
    // A region that is no country ("es-419", Latin America) is no territory Open Graph names: the language's own is.
    const region = given.region && /^[A-Z]{2}$/.test(given.region) ? given.region : new Intl.Locale(given.script ? `${given.language}-${given.script}` : given.language).maximize().region;
    return given.language && region && /^[A-Z]{2}$/.test(region) ? `${given.language.toLowerCase()}_${region}` : null;
  } catch {
    return null;
  }
}

/** The site's X (Twitter) account as `twitter:site` names it ("@studio"), when it is one; null for anything else. */
export function twitterHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^@?([A-Za-z0-9_]{1,15})$/.exec(value.trim());
  return m ? `@${m[1]}` : null;
}
