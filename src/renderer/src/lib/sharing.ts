/**
 * What a page's Search & sharing settings say about how a shared link to it looks: the preview's values, whose
 * sharing image it is, and the words that go with each case. All of it comes from `pageSharing`, which the
 * generator also writes the page's `<head>` from, so the preview can't show what the exported site doesn't carry.
 */
import type { PageDoc, ProjectState } from '@shared/types';
import { publicUrl } from '@shared/public-url';
import { assetLabels } from '@shared/asset-order';
import { pageSharing, type SharingImageSource } from '@shared/sharing';

/**
 * What a picture-only image picker needs to stand for another image while its field has none of its own: `inherited`
 * is the library image it falls back to (null when there is none), `from` says whose it is, `none` is said when there
 * is no image at all, and `back` names the button that returns to the fallback in place of Remove.
 */
export interface PictureStandIn {
  inherited: string | null;
  from: string;
  none: string;
  back: string;
}

export interface SharingView {
  title: string;
  description: string;
  imageSource: SharingImageSource;
  /** The image's name in the library, as the pickers label it, when it shows. */
  imageName: string | undefined;
  /** The host of the site's public URL, for the line a link preview carries. */
  host: string | undefined;
  picker: PictureStandIn;
  /** What the sharing image's field says about whose image it is and where else it shows. */
  imageNote: string;
  /** Said under the preview while the site has no public URL (an exported site writes no image address without one). */
  addressNote: string | null;
}

/** The name of a library image as the pickers show it. */
function nameOf(state: ProjectState, id: string | null | undefined): string | undefined {
  if (!id || !Object.hasOwn(state.assets.assets, id)) return undefined;
  const images = Object.values(state.assets.assets).filter((a) => a.kind === 'image');
  return assetLabels(images).get(id)?.label ?? state.assets.assets[id].name;
}

/** The page as a shared link shows it, with the words for it. */
export function sharingView(state: ProjectState, page: PageDoc): SharingView {
  const shared = pageSharing(state, page);
  const siteId = state.site.socialImage || null;
  const siteName = nameOf(state, siteId);
  const siteHas = !!siteName && state.assets.assets[siteId!].kind === 'image';
  const base = publicUrl(state.site);
  const own = shared.source === 'page';
  // A saved ID can name a file that is not a picture, which is not the same as one that has gone.
  const notPicture = (id: string | null) => !!id && Object.hasOwn(state.assets.assets, id) && state.assets.assets[id].kind !== 'image';
  const imageName = shared.image?.kind === 'image' ? nameOf(state, shared.imageId) : undefined;
  let imageNote: string;
  if (own) {
    imageNote = shared.image
      ? `This page’s own choice. ${siteHas ? `Pages without their own image show the site’s sharing image, ${siteName}.` : 'Pages without their own image are shared without one.'} Page lists that follow this page show it on this page’s card.`
      : `${notPicture(shared.imageId) ? 'The file chosen for this page is not an image' : 'The image chosen for this page is no longer in Assets'}, so a shared link to it shows no picture. Choose another image, or ${siteHas ? 'return to the site’s image' : 'remove it'}.`;
  } else if (shared.source === 'site') {
    imageNote = shared.image
      ? 'This page has no image of its own, so a shared link shows the site’s sharing image. Choose one to use a different image for this page.'
      : `${notPicture(shared.imageId) ? 'The site’s sharing image is not an image' : 'The site’s sharing image is no longer in Assets'}, so a shared link to this page shows no picture. Choose one for this page, or another one in Site details.`;
  } else {
    imageNote = 'Neither this page nor the site has a sharing image, so a shared link to this page shows no picture.';
  }
  return {
    title: shared.title,
    description: shared.description,
    imageSource: shared.source,
    imageName,
    host: base ? new URL(base).host : undefined,
    picker: {
      inherited: siteHas ? siteId : null,
      from: 'The site’s sharing image.',
      none: 'No sharing image',
      back: siteHas ? 'Use the site’s image' : 'Remove image'
    },
    imageNote,
    addressNote: base ? null : 'The site has no usable public URL yet, so the exported site writes no page or image addresses into its sharing tags. Set the Public URL in Site details.'
  };
}

/** What a page's Search & sharing heading says while it is closed: its own sharing image, and where it is kept out of search. */
export function searchSummary(page: PageDoc): string | undefined {
  const noindex = !!page.seo.noindex;
  const siteSearch = !!page.seo.searchHidden;
  const hidden = noindex && siteSearch ? 'Hidden from all search' : noindex ? 'Not in search engines' : siteSearch ? 'Not in site search' : undefined;
  const parts = [page.seo.socialImage ? 'Own sharing image' : undefined, hidden].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
