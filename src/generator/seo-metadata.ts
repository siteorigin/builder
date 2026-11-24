/**
 * What each page and collection entry says to search engines and link previews, with every fallback applied, and
 * which of the website's outputs include it (see shared/seo.ts). One answer for the generator, the editor's previews,
 * the SEO audit and the AI tools, so none of them works out drafts, noindex or a missing public URL on its own.
 *
 * A page reads its title, description and sharing image through `pageSharing`, as its `<head>` and the Inspector's
 * Search & sharing preview do; an entry reads them the way its generated page does. Whether a document is on the
 * website is judged on the website as it is exported (`publishedState`), so a draft that holds an address never hides
 * the published entry that gets it.
 */
import type { AssetRecord, Collection, EntryDoc, EntrySeo, PageDoc, PageSeo, ProjectState } from '@shared/types';
import type { EffectiveSeo, SeoImageSource, SeoSubject, SeoVisibility } from '@shared/seo';
import { canonicalUrl } from '@shared/seo';
import { pageSharing } from '@shared/sharing';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { pageLanguage, siteLanguage } from '@shared/languages';
import { pageArticle } from '@shared/articles';
import { entryRoute, isDraftEntry, siteEntries } from '@shared/collections';
import { isDraftPage, publishedState } from './index';

/** Resolves the documents of one project as it is; build another for a changed project. */
export interface SeoResolver {
  /** One document's metadata, drafts included (an editor previews them). Null for one the project does not have. */
  resolve(subject: SeoSubject): EffectiveSeo | null;
  /** Every document the website has a page for: the pages in site order, then the collection entries in site order. */
  published(): readonly EffectiveSeo[];
}

const own = <T>(record: Record<string, T> | undefined, key: unknown): T | undefined => (record && typeof record === 'object' && typeof key === 'string' && Object.hasOwn(record, key) ? record[key] : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** The public URL of a library file, as the generated pages write it. */
const fileUrl = (base: string, asset: AssetRecord) => `${base}/${asset.file.replace(/^static\//, '')}`;

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
  const site = state.site;
  const base = publicUrl(site) ?? null;
  let live: ReturnType<typeof website> | undefined;
  const onSite = () => (live ??= website(state));
  const cache = new Map<string, EffectiveSeo | null>();

  /** Where a document is published, and what that means for each output. */
  const visibility = (on: boolean, flags: { noindex: boolean; searchHidden: boolean; listed: boolean; news: boolean }): SeoVisibility => {
    const indexable = on && !flags.noindex;
    const listed = indexable && flags.listed;
    return { website: on, indexable, sitemap: listed, siteSearch: on && !flags.searchHidden, jsonLd: listed, news: on && flags.news };
  };

  /**
   * A document's public URL, written as its generated page writes it, and its canonical address. It is listed (in the
   * sitemap, with structured data) only at its own address: one that names another address leaves that to the other.
   */
  const addresses = (route: string, override: unknown) => {
    const url = base ? base + routeUrl(route) : null;
    const chosen = canonicalUrl(override);
    return { url, canonical: chosen ?? url, listed: !!url && (!chosen || chosen === canonicalUrl(url)) };
  };

  const resolvePage = (pageId: string): EffectiveSeo | null => {
    const page: PageDoc | undefined = own(state.pages, pageId);
    if (!page || typeof page !== 'object' || typeof page.route !== 'string') return null;
    const seo: PageSeo = page.seo && typeof page.seo === 'object' ? page.seo : {};
    const sharing = pageSharing(state, page);
    const { url, canonical, listed } = addresses(page.route, seo.canonical);
    const noindex = !!seo.noindex;
    const searchHidden = !!seo.searchHidden;
    const article = pageArticle(page);
    return {
      subject: { kind: 'page', pageId },
      route: page.route,
      url,
      canonical,
      title: text(sharing.title),
      socialTitle: text(sharing.title),
      description: text(sharing.description),
      language: pageLanguage(site, page),
      imageId: sharing.imageId,
      image: sharing.image,
      imageSource: sharing.source === 'page' ? 'own' : sharing.source,
      imageUrl: base && sharing.image ? fileUrl(base, sharing.image) : null,
      draft: isDraftPage(state, page),
      noindex,
      searchHidden,
      visibility: visibility(onSite().pages.has(pageId), { noindex, searchHidden, listed, news: !!article && article.hidden !== true })
    };
  };

  const resolveEntry = (collectionId: string, entryId: string): EffectiveSeo | null => {
    const collection: Collection | undefined = own(state.collections, collectionId);
    const entry: EntryDoc | undefined = own(collection?.entries, entryId);
    if (!collection?.settings || !entry || typeof entry !== 'object' || entry.id !== entryId) return null;
    const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
    const route = onSite().entries.get(`${collectionId}\n${entryId}`) ?? (typeof collection.settings.route === 'string' && typeof entry.slug === 'string' ? entryRoute(collection, entry) : null);
    if (route === null) return null;
    const picture = (id: unknown) => {
      const a = own(state.assets?.assets, id);
      return a?.kind === 'image' ? a : undefined;
    };
    // An entry's own sharing image stands even when it has gone from the library, as a page's does; a featured image
    // that is no picture leaves the choice to the site's, as the generated page does.
    const chosen = text(seo.socialImage) || undefined;
    const featured = picture(entry.featuredImage);
    const siteImage = text(site.socialImage) || null;
    const [imageId, image, imageSource]: [string | null, AssetRecord | undefined, SeoImageSource] = chosen
      ? [chosen, picture(chosen), 'own']
      : featured
        ? [featured.id, featured, 'featured']
        : siteImage
          ? [siteImage, picture(siteImage), 'site']
          : [null, undefined, 'none'];
    const { url, canonical, listed } = addresses(route, seo.canonical);
    const noindex = !!seo.noindex;
    const searchHidden = !!seo.searchHidden;
    const title = text(entry.title);
    return {
      subject: { kind: 'entry', collectionId, entryId },
      route,
      url,
      canonical,
      title: text(seo.title) || `${title} · ${text(site.name)}`,
      socialTitle: text(seo.title) || title,
      description: text(seo.description) || text(entry.excerpt) || text(site.description),
      language: siteLanguage(site),
      imageId,
      image,
      imageSource,
      imageUrl: base && image ? fileUrl(base, image) : null,
      draft: isDraftEntry(entry),
      noindex,
      searchHidden,
      visibility: visibility(onSite().entries.has(`${collectionId}\n${entryId}`), { noindex, searchHidden, listed, news: false })
    };
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
