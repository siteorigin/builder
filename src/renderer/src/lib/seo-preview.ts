/**
 * What a page's or a post's Search & sharing previews show (#597): the result a search engine lists, the card a shared
 * link makes, the structured data its page carries and where it is published, and how its title and description
 * measure up. Everything is read from the generator's own answers (`pageMetadata`, `entryMetadata`, the SEO resolver
 * and `documentGraph`), so a preview can't show what the exported site doesn't carry, and text still being typed is
 * laid over the project as it would be saved, so the previews follow the fields before anything is saved.
 *
 * The search result, the card and the meters read one document, so they follow every keystroke. Where the document
 * is published and its structured data read the whole website, so the editor works them out only while they show.
 */
import type { AssetRecord, Collection, EntrySeo, PageSeo, ProjectState } from '@shared/types';
import { seoLength, seoText, type SeoSubject } from '@shared/seo';
import { serpAddress, serpSnippet, type SerpAddress, type SerpDevice, type SerpResult } from '@shared/serp';
import { publicUrl } from '@shared/public-url';
import { agentDiscovery, LLMS_TXT_FILE } from '@shared/llms';
import { isArticleDate } from '@shared/articles';
import { SEO_DESCRIPTION_RANGE, SEO_TITLE_RANGE } from '@engine/seo-rules';
import { createSeoResolver, entryMetadata, pageMetadata, sameAddress, type SeoMetadata } from '@generator/seo-metadata';
import { documentGraph } from '@generator/structured-data';
import { publishedState } from '@generator/index';
import { nameOf } from './sharing';

/**
 * Text typed into a document's Search & sharing fields and not saved yet. Each one there stands for the saved value
 * as it would be saved: an empty one clears it, so the fallback shows. `canonical` is the address as it is stored
 * (checked and written as browsers write it).
 */
export interface TypedSeo {
  title?: string;
  description?: string;
  canonical?: string;
}

const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => (record && typeof record === 'object' && Object.hasOwn(record, key) ? record[key] : undefined);

/** Sets or clears one of a document's search settings, as saving it would. */
function put<T extends PageSeo | EntrySeo>(seo: T, key: 'title' | 'description' | 'canonical', value: string | undefined): void {
  if (value === undefined) return;
  if (value) (seo as Record<string, unknown>)[key] = value;
  else delete (seo as Record<string, unknown>)[key];
}

/**
 * The project with `typed` laid over one document's saved settings, as saving them would leave it: a page keeps its
 * text as typed (only an empty one is cleared), a post's is trimmed first, as its fields save it. The project itself
 * is never changed; a document it does not have is not made up.
 */
export function withTypedSeo(state: ProjectState, subject: SeoSubject, typed: TypedSeo): ProjectState {
  if (typed.title === undefined && typed.description === undefined && typed.canonical === undefined) return state;
  if (subject.kind === 'page') {
    const page = own(state.pages, subject.pageId);
    if (!page || typeof page !== 'object') return state;
    const seo: PageSeo = { ...(page.seo && typeof page.seo === 'object' ? page.seo : {}) };
    put(seo, 'title', typed.title);
    put(seo, 'description', typed.description);
    put(seo, 'canonical', typed.canonical);
    return { ...state, pages: { ...state.pages, [page.id]: { ...page, seo } } };
  }
  const collection: Collection | undefined = own(state.collections, subject.collectionId);
  const entry = own(collection?.entries, subject.entryId);
  if (!collection || !entry || typeof entry !== 'object') return state;
  const seo: EntrySeo = { ...(entry.seo && typeof entry.seo === 'object' ? entry.seo : {}) };
  put(seo, 'title', typed.title?.trim());
  put(seo, 'description', typed.description?.trim());
  put(seo, 'canonical', typed.canonical);
  const entries = { ...collection.entries, [entry.id]: { ...entry, seo } };
  return { ...state, collections: { ...state.collections, [subject.collectionId]: { ...collection, entries } } };
}

/** Which of a document's search settings are its own rather than the fallbacks, as saved. */
function ownSettings(state: ProjectState, subject: SeoSubject): { title: boolean; description: boolean } {
  const seo = subject.kind === 'page' ? own(state.pages, subject.pageId)?.seo : own(own(state.collections, subject.collectionId)?.entries, subject.entryId)?.seo;
  const s: PageSeo | EntrySeo = seo && typeof seo === 'object' ? seo : {};
  // A page's title of spaces is its own (it is saved and written as it is); a post's is trimmed away when saved.
  const has = (v: unknown) => typeof v === 'string' && (subject.kind === 'page' ? v !== '' : v.trim() !== '');
  return { title: has(s.title), description: has(s.description) };
}

/** A publication date as a dated search result opens its description with ("2 Mar 2027 — "). */
export function resultDate(date: string | null, language: string): string | null {
  if (!date || !isArticleDate(date)) return null;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat([language || 'en', 'en'], opts);
  } catch {
    f = new Intl.DateTimeFormat('en', opts);
  }
  return `${f.format(new Date(`${date}T00:00:00Z`))} — `;
}

/** A shared link's card, as the exported page's sharing tags make it. */
export interface LinkCard {
  /** The host of the address the card links to (its canonical URL), when it has one. */
  host: string | undefined;
  title: string;
  description: string;
  /** The picture, when the library has it as one. */
  image: AssetRecord | undefined;
  /** For screen readers: which picture it is and whose choice it is. */
  imageSaid: string;
  /** Said under the card while the site has no public URL, so the page's tags carry no image address. */
  addressNote: string | null;
}

/** What one document's search result, link card and meters show. */
export interface DocumentPreview {
  meta: SeoMetadata;
  serp: Record<SerpDevice, SerpResult>;
  /** The address line over the result: where the website publishes it. */
  address: SerpAddress;
  /** The site's name, which a result shows over its address. */
  siteName: string;
  /** The date a dated result opens its description with. */
  date: string | null;
  card: LinkCard;
  /** Whether its title and description are its own, or what it falls back to without them. */
  own: { title: boolean; description: boolean };
}

/**
 * One document's previews, from its own settings and the site's alone (cheap enough for every keystroke). `route` is
 * where the website publishes it, as the resolver says (an entry's own address unless another holds it). Null for a
 * document the project does not have.
 */
export function previewDocument(state: ProjectState, subject: SeoSubject, route?: string): DocumentPreview | null {
  const meta = subject.kind === 'page' ? pageMetadata(state, subject.pageId) : entryMetadata(state, subject.collectionId, subject.entryId, route);
  if (!meta) return null;
  const date = resultDate(meta.published, meta.language);
  const what = subject.kind === 'page' ? 'page' : 'post';
  const picture = meta.image?.kind === 'image' ? meta.image : undefined;
  const whose = meta.imageSource === 'own' ? `this ${what}’s own` : meta.imageSource === 'featured' ? 'its featured image' : 'the site’s';
  let host: string | undefined;
  try {
    host = meta.canonical ? new URL(meta.canonical).host : undefined;
  } catch {
    host = undefined;
  }
  const base = publicUrl(state.site);
  return {
    meta,
    serp: serpSnippet({ title: meta.title, description: meta.description, datePrefix: date ?? undefined }),
    address: serpAddress(meta.url, meta.route),
    siteName: seoText(state.site.name),
    date,
    card: {
      host,
      title: seoText(meta.socialTitle),
      description: seoText(meta.description),
      image: picture,
      imageSaid: picture ? `Image: ${nameOf(state, meta.imageId) ?? picture.name}, ${whose}.` : 'No sharing image.',
      addressNote: base
        ? null
        : meta.canonical
          ? `The site has no usable public URL yet, so the exported ${what} writes no image address into its sharing tags. Set the Public URL in Site details.`
          : 'The site has no usable public URL yet, so the exported site writes no page or image addresses into its sharing tags. Set the Public URL in Site details.'
    },
    own: ownSettings(state, subject)
  };
}

/** How a title or description measures up against a results page. */
export type MeterTone = 'good' | 'short' | 'cut' | 'none';

export interface LengthMeter {
  /** Characters, as a reader counts them. */
  chars: number;
  /** How much of a computer's results line (or lines) it fills, from 0 to 1. */
  fill: number;
  tone: MeterTone;
  /** What the meter says, in words. */
  label: string;
  /** Where a results page likely cuts it short. */
  cutOn: SerpDevice[];
}

/**
 * How a document's title or description, as it shows (its own, or the fallback while it has none), measures up:
 * whether a computer's or a phone's results will likely cut it short, and whether it is shorter than reads well. It
 * never refuses anything: the field's own limit does that.
 */
export function lengthMeter(kind: 'title' | 'description', preview: DocumentPreview): LengthMeter {
  const text = seoText(kind === 'title' ? preview.meta.title : preview.meta.description);
  const chars = seoLength(text);
  const range = kind === 'title' ? SEO_TITLE_RANGE : SEO_DESCRIPTION_RANGE;
  const own = preview.own[kind];
  const from = own ? '' : kind === 'title' ? 'Default title: ' : 'From the fallback: ';
  const desktop = preview.serp.desktop[kind];
  const fill = desktop.max > 0 ? Math.min(1, desktop.width / desktop.max) : 1;
  if (!chars) return { chars, fill: 0, tone: 'none', label: kind === 'title' ? 'No title: results show the address instead.' : 'No description: search engines pick words from the page.', cutOn: [] };
  const cutOn = (['desktop', 'mobile'] as const).filter((d) => preview.serp[d][kind].cut);
  const count = `${chars} character${chars === 1 ? '' : 's'}`;
  if (cutOn.length) {
    const where = cutOn.length === 2 ? 'on computers and phones' : cutOn[0] === 'desktop' ? 'on computers' : 'on phones';
    const fits = cutOn.length === 1 ? `, fits ${cutOn[0] === 'desktop' ? 'on phones' : 'on computers'}` : '';
    return { chars, fill, tone: 'cut', label: `${from}${count} · likely cut short ${where}${fits}`, cutOn };
  }
  if (chars < range.min) return { chars, fill, tone: 'short', label: `${from}${count} · short: ${range.min} to ${range.max} reads best`, cutOn };
  return { chars, fill, tone: 'good', label: `${from}${count} · fits on computers and phones`, cutOn };
}

/** One line of where a document is published, and what is said of it. */
export interface StatusLine {
  id: 'canonical' | 'search' | 'sitemap' | 'structured' | 'llms' | 'siteSearch';
  label: string;
  value: string;
  /** Whether it is in that output (or, for the canonical URL, whether it is its own address). */
  on: boolean;
}

/** The structured data a document's page carries, or why it carries none. */
export type GraphView = { kind: 'graph'; json: string; types: string[] } | { kind: 'none'; reason: string } | { kind: 'error'; message: string };

export interface StructuredPreview {
  status: StatusLine[];
  graph: GraphView;
}

/**
 * Where a document is published, and the structured data its exported page carries, worked out on the website as it
 * is exported (drafts left out), as the export does. Reads every document of the website: work it out while it shows.
 */
export function structuredPreview(state: ProjectState, subject: SeoSubject): StructuredPreview | null {
  const meta = createSeoResolver(state).resolve(subject);
  if (!meta) return null;
  const v = meta.visibility;
  const what = subject.kind === 'page' ? 'page' : 'post';
  // An override names another address even while the site has no public URL of its own to compare it with.
  const elsewhere = !!meta.canonical && !sameAddress(meta.canonical, meta.url);
  const copy = 'No: its canonical URL names another address, so this copy is left out';
  const llms = agentDiscovery(state.site).llmsTxt;
  const offSite = meta.draft ? 'Not while it is a draft' : 'Not on the website';
  /** Why it is not in an output that lists what search engines may list; `last` when nothing else stands in the way. */
  const why = (last: string) => (!v.website ? offSite : meta.noindex ? 'No: it is hidden from search engines' : !meta.url ? 'No: the site has no public URL' : last);
  const status: StatusLine[] = [
    {
      id: 'canonical',
      label: 'Canonical URL',
      value: meta.canonical ? (elsewhere ? `${meta.canonical} (another address)` : meta.canonical) : 'None: the site has no public URL',
      on: !!meta.canonical && !elsewhere
    },
    { id: 'search', label: 'Search engines', value: !v.website ? (meta.draft ? 'Not while it is a draft: the export leaves drafts out' : offSite) : meta.noindex ? 'Asked not to list it' : 'May list it', on: v.indexable },
    { id: 'sitemap', label: 'Sitemap', value: v.sitemap ? 'Listed' : why(copy), on: v.sitemap },
    { id: 'structured', label: 'Structured data', value: v.jsonLd ? 'Written into its page' : why('No'), on: v.jsonLd },
    {
      id: 'llms',
      label: `AI agents (${LLMS_TXT_FILE})`,
      value: !llms ? `The site writes no ${LLMS_TXT_FILE}` : v.llms ? 'Listed' : !v.website ? offSite : meta.noindex ? 'No: it is hidden from search engines' : copy,
      on: llms && v.llms
    },
    {
      id: 'siteSearch',
      label: 'Site search',
      value: subject.kind === 'entry' ? 'Posts aren’t in site search yet' : !v.website ? offSite : v.siteSearch ? 'May find it' : 'Hidden from site search',
      on: subject.kind === 'page' && v.siteSearch
    }
  ];
  let graph: GraphView;
  if (!v.jsonLd) {
    graph = {
      kind: 'none',
      reason: !v.website
        ? meta.draft
          ? `Drafts carry no structured data. ${meta.noindex ? `Once published, the ${what} is still hidden from search engines, so it carries none then either.` : !publicUrl(state.site) ? `Once the ${what} is published and the site has a public URL, its page carries the site’s connected graph.` : `Once the ${what} is published, its page carries the site’s connected graph.`}`
          : `This ${what} is not on the website, so it carries no structured data.`
        : meta.noindex
          ? `This ${what} is hidden from search engines, so its page carries no structured data.`
          : 'Structured data names everything by its public URL, so pages carry none until the site has one. Set the Public URL in Site details.'
    };
  } else {
    try {
      const g = documentGraph(publishedState(state), subject);
      graph = g
        ? { kind: 'graph', json: JSON.stringify(g, null, 2), types: g['@graph'].flatMap((n) => (Array.isArray(n['@type']) ? n['@type'] : [n['@type']])) }
        : { kind: 'none', reason: `This ${what}’s page carries no structured data.` };
    } catch (e) {
      graph = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { status, graph };
}
