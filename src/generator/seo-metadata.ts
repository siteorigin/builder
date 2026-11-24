/**
 * What each page and collection entry says to search engines and link previews, with every fallback applied, and
 * which of the website's outputs it belongs in (see shared/seo.ts). One answer for the generator, the editor's
 * previews, the SEO audit and the AI tools, so none of them works out drafts, noindex or a missing public URL on its own.
 *
 * A page reads its title, description and sharing image through `pageSharing`, as the Inspector's Search & sharing
 * preview does; an entry reads its own search settings, then its title, excerpt and featured image. Each generated
 * page writes its `<head>` from `pageMetadata` or `entryMetadata`, which read only that document and the site's
 * settings. Whether a document is on the website is judged on the website as it is exported (`publishedState`), so a
 * draft that holds an address never hides the published entry that gets it.
 */
import type { AssetRecord, Collection, EntryDoc, EntrySeo, PageDoc, PageSeo, ProjectState } from '@shared/types';
import { storedCanonical, type EffectiveSeo, type SeoImageSource, type SeoSubject, type SeoVisibility } from '@shared/seo';
import { pageSharing } from '@shared/sharing';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { pageLanguage, siteLanguage } from '@shared/languages';
import { isArticleDate, pageArticle } from '@shared/articles';
import { entryRoute, isDraftEntry, siteEntries } from '@shared/collections';
import { entryTermLabels } from '@shared/entry-fields';
import { isDraftPage, publishedState } from './index';

/** One document's metadata, without where it is published: what its own page's `<head>` says. */
export type SeoMetadata = Omit<EffectiveSeo, 'visibility'>;

/** Resolves the documents of one project as it is; build another for a changed project. */
export interface SeoResolver {
  /** One document's metadata, drafts included (an editor previews them). Null for one the project does not have. */
  resolve(subject: SeoSubject): EffectiveSeo | null;
  /** Every document the website has a page for: the pages in site order, then the collection entries in site order. */
  published(): readonly EffectiveSeo[];
}

const own = <T>(record: Record<string, T> | undefined, key: unknown): T | undefined => (record && typeof record === 'object' && typeof key === 'string' && Object.hasOwn(record, key) ? record[key] : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
/** Text the author set, when there is any beyond spaces; else nothing, so the fallback is used. */
const set = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '');
const day = (v: unknown) => (isArticleDate(v) ? (v as string) : null);

/** The public URL of a library file, as the generated pages write it; none for a record without a file (hand-edited). */
const fileUrl = (base: string, asset: AssetRecord) => (typeof asset.file === 'string' && asset.file ? `${base}/${asset.file.replace(/^static\//, '')}` : null);

/** What an image shows, as its sharing tags describe it: the library's suggested description, else its own. */
const imageAlt = (image: AssetRecord | undefined) => (image ? text(image.altSuggestion) || text(image.description) : '');

/** A document's public URL, written as its generated page writes it (its canonical link and og:url). */
const urlOf = (base: string | null, route: string) => (base ? base + routeUrl(route) : null);

/** The taxonomy an entry's section is read from, and the one its tags are. */
const SECTION_TAXONOMY = 'categories';
const TAG_TAXONOMY = 'tags';

/** A page's metadata, drafts included. Null for a page the project does not have (or one damaged by hand). */
export function pageMetadata(state: ProjectState, pageOrId: PageDoc | string): SeoMetadata | null {
  const site = state.site;
  const page: PageDoc | undefined = typeof pageOrId === 'string' ? own(state.pages, pageOrId) : pageOrId;
  if (!page || typeof page !== 'object' || typeof page.route !== 'string') return null;
  const pageId = page.id;
  const seo: PageSeo = page.seo && typeof page.seo === 'object' ? page.seo : {};
  const base = publicUrl(site) ?? null;
  const sharing = pageSharing(state, page);
  const url = urlOf(base, page.route);
  const article = pageArticle(page);
  return {
    subject: { kind: 'page', pageId },
    route: page.route,
    url,
    canonical: storedCanonical(seo.canonical) ?? url,
    title: text(sharing.title),
    socialTitle: text(sharing.title),
    description: text(sharing.description),
    language: pageLanguage(site, page),
    imageId: sharing.imageId,
    image: sharing.image,
    imageSource: sharing.source === 'page' ? 'own' : sharing.source,
    imageUrl: base && sharing.image ? fileUrl(base, sharing.image) : null,
    imageAlt: imageAlt(sharing.image),
    published: article ? article.date : null,
    modified: day(page.updatedAt),
    author: article ? text(article.byline).trim() : '',
    section: '',
    tags: [],
    draft: isDraftPage(state, page),
    noindex: !!seo.noindex,
    searchHidden: !!seo.searchHidden
  };
}

/**
 * An entry's metadata, drafts included, at `route` (its own address unless given another, as the website has it).
 * Null for an entry the project does not have, or one whose address cannot be told.
 */
export function entryMetadata(state: ProjectState, collectionId: string, entryId: string, route?: string): SeoMetadata | null {
  const site = state.site;
  const collection: Collection | undefined = own(state.collections, collectionId);
  const entry: EntryDoc | undefined = own(collection?.entries, entryId);
  if (!collection?.settings || !entry || typeof entry !== 'object' || entry.id !== entryId) return null;
  const at = route ?? (typeof collection.settings.route === 'string' && typeof entry.slug === 'string' ? entryRoute(collection, entry) : null);
  if (at === null) return null;
  const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
  const base = publicUrl(site) ?? null;
  const picture = (id: unknown) => {
    const a = own(state.assets?.assets, id);
    return a?.kind === 'image' ? a : undefined;
  };
  // The entry's own sharing image stands even when the library has since lost it, as a page's does: it is not quietly
  // given another. A featured image that is no picture leaves the choice to the site's, as the generated page does.
  const chosen = set(seo.socialImage) || null;
  const featured = picture(entry.featuredImage);
  const siteImage = text(site.socialImage) || null;
  const [imageId, image, imageSource]: [string | null, AssetRecord | undefined, SeoImageSource] = chosen
    ? [chosen, picture(chosen), 'own']
    : featured
      ? [featured.id, featured, 'featured']
      : siteImage
        ? [siteImage, picture(siteImage), 'site']
        : [null, undefined, 'none'];
  const url = urlOf(base, at);
  const title = text(entry.title);
  const ownTitle = set(seo.title);
  const tags = [...new Set(entryTermLabels(collection, entry, TAG_TAXONOMY))];
  return {
    subject: { kind: 'entry', collectionId, entryId },
    route: at,
    url,
    canonical: storedCanonical(seo.canonical) ?? url,
    // The author's SEO title is the whole title, as a page's is: no site name is added to it.
    title: ownTitle || `${title} · ${text(site.name)}`,
    socialTitle: ownTitle || title,
    description: set(seo.description) || text(entry.excerpt) || text(site.description),
    language: siteLanguage(site),
    imageId,
    image,
    imageSource,
    imageUrl: base && image ? fileUrl(base, image) : null,
    imageAlt: imageAlt(image),
    published: day(entry.publishedAt),
    modified: day(entry.updatedAt),
    author: text(entry.author).trim(),
    section: entryTermLabels(collection, entry, SECTION_TAXONOMY)[0] ?? '',
    tags,
    draft: isDraftEntry(entry),
    noindex: !!seo.noindex,
    searchHidden: !!seo.searchHidden
  };
}

/** The pages and entries on the website, and their addresses there. */
function website(state: ProjectState) {
  const live = publishedState(state);
  const pages = new Set<string>();
  for (const id of live.site.pageOrder) {
    const page = own(state.pages, id);
    if (page && typeof page === 'object' && typeof page.route === 'string') pages.add(id);
  }
  const entries = new Map<string, string>();
  for (const e of siteEntries(live)) entries.set(`${e.collection.settings.id}\n${e.entry.id}`, e.route);
  return { pages, entries };
}

export function createSeoResolver(state: ProjectState): SeoResolver {
  const base = publicUrl(state.site) ?? null;
  let live: ReturnType<typeof website> | undefined;
  const onSite = () => (live ??= website(state));
  const cache = new Map<string, EffectiveSeo | null>();

  /** Where a document is published, and what that means for each output. */
  const visibility = (on: boolean, flags: { noindex: boolean; searchHidden: boolean; news: boolean }): SeoVisibility => {
    const indexable = on && !flags.noindex;
    // Listed at its public URL, so only once the site has one.
    const listed = indexable && !!base;
    return { website: on, indexable, sitemap: listed, siteSearch: on && !flags.searchHidden, jsonLd: listed, news: on && flags.news };
  };

  const resolvePage = (pageId: string): EffectiveSeo | null => {
    const meta = pageMetadata(state, pageId);
    if (!meta) return null;
    const article = pageArticle(state.pages[pageId]);
    return { ...meta, visibility: visibility(onSite().pages.has(pageId), { noindex: meta.noindex, searchHidden: meta.searchHidden, news: !!article && article.hidden !== true }) };
  };

  const resolveEntry = (collectionId: string, entryId: string): EffectiveSeo | null => {
    const key = `${collectionId}\n${entryId}`;
    const meta = entryMetadata(state, collectionId, entryId, onSite().entries.get(key));
    if (!meta) return null;
    return { ...meta, visibility: visibility(onSite().entries.has(key), { noindex: meta.noindex, searchHidden: meta.searchHidden, news: false }) };
  };

  const resolve = (subject: SeoSubject): EffectiveSeo | null => {
    const key = subject.kind === 'page' ? `page\n${subject.pageId}` : `entry\n${subject.collectionId}\n${subject.entryId}`;
    if (!cache.has(key)) cache.set(key, subject.kind === 'page' ? resolvePage(subject.pageId) : resolveEntry(subject.collectionId, subject.entryId));
    return cache.get(key)!;
  };

  let published: EffectiveSeo[] | undefined;
  return {
    resolve,
    published() {
      if (published) return published;
      const { pages, entries } = onSite();
      published = [];
      for (const pageId of pages) {
        const meta = resolve({ kind: 'page', pageId });
        if (meta?.visibility.website) published.push(meta);
      }
      for (const key of entries.keys()) {
        const [collectionId, entryId] = key.split('\n');
        const meta = resolve({ kind: 'entry', collectionId, entryId });
        if (meta?.visibility.website) published.push(meta);
      }
      return published;
    }
  };
}
