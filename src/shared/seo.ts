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

/** Which of the website's outputs include a document. */
export interface SeoVisibility {
  /** The website has a page for it: not a draft, and its address is its own. */
  website: boolean;
  /** Search engines may list it: on the website and not `noindex`. */
  indexable: boolean;
  /** The sitemap lists it: indexable, with a public URL to list it at, and that address is its canonical one. */
  sitemap: boolean;
  /** The site's own search may find it: on the website and not hidden from site search. */
  siteSearch: boolean;
  /** It carries structured data (a JSON-LD graph): the same conditions as the sitemap. */
  jsonLd: boolean;
  /** News lists show it: a published page that is a dated article not hidden from them. Entries have feeds of their own. */
  news: boolean;
}

/** Where a document's sharing image comes from: its own choice, its featured image, the site's, or nowhere. */
export type SeoImageSource = 'own' | 'featured' | 'site' | 'none';

/** What one document says about itself, with every fallback applied, and where it is published. */
export interface EffectiveSeo {
  subject: SeoSubject;
  /** Its address within the site ("/about/"). */
  route: string;
  /** The public URL it is reached at (the site's public URL and its route), when the site has one. */
  url: string | null;
  /** The address search engines are told is its own: a usable override, else `url`. */
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

/**
 * A canonical address an author gave, when it can be used: an absolute http(s) address with a host, no user name or
 * password, and no fragment. The address is returned as browsers write it; anything else is null.
 */
export function canonicalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\s\\]/.test(text) || text.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return null;
  return url.href;
}
