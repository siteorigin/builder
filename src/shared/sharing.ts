/**
 * How a page looks when its link is shared: the title, description and image a link preview shows. The generator
 * writes these into the page's `<head>` and the Inspector's Search & sharing preview shows them, both through
 * `pageSharing`, so what the author reviews is what the exported site carries.
 */
import type { AssetRecord, PageDoc, ProjectState } from './types';

/** Whose choice a page's sharing image is: its own, the site's, or nobody's yet. */
export type SharingImageSource = 'page' | 'site' | 'none';

export interface PageSharing {
  /** The browser title, and the title of a link preview. */
  title: string;
  /** The page's description, else the site's; empty when neither has one. */
  description: string;
  /** The ID the page is shared with: its own when it has one, else the site's. */
  imageId: string | null;
  /** That image, when the library still has it as a picture (a font or a document is no image to share). */
  image: AssetRecord | undefined;
  /** Where `imageId` comes from. A page's own choice stands even if the library has since lost that image. */
  source: SharingImageSource;
}

/** The title a page gets when it has none of its own for the browser tab: the home page is the site's name. */
export function defaultPageTitle(state: ProjectState, page: Pick<PageDoc, 'id' | 'title'>): string {
  const site = state.site;
  return page.id === site.homePageId ? site.name : `${page.title} · ${site.name}`;
}

/** The title, description and sharing image a page is published with. */
export function pageSharing(state: ProjectState, page: PageDoc): PageSharing {
  const site = state.site;
  // An empty ID is no choice: the engine clears a page's image by deleting it, and a hand-edited "" does the same.
  const own = page.seo.socialImage || undefined;
  const imageId = own ?? (site.socialImage || null);
  const found = imageId && Object.hasOwn(state.assets.assets, imageId) ? state.assets.assets[imageId] : undefined;
  return {
    title: page.seo.title || defaultPageTitle(state, page),
    description: page.seo.description || site.description,
    imageId,
    image: found?.kind === 'image' ? found : undefined,
    // A page's own choice stands even when its image has gone from the library: the page is not quietly given the site's.
    source: own ? 'page' : imageId ? 'site' : 'none'
  };
}
