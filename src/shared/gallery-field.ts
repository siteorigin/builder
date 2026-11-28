/**
 * A collection's gallery field (#1320): an ordered list of library pictures, each entry its own, each photo with its
 * own description and caption. Stored as `GalleryItem`s; a layout reads the field as a list of photos with an `image`
 * and a `caption`, which is what a Gallery's images and a Carousel's slides hold, so binding one to the field shows
 * the entry's photos with nothing in between.
 */
import type { GalleryFieldSchema, GalleryItem, ImageValue, ListProp, PropSchema } from './types';
import { MAX_GALLERY_PHOTOS } from './types';

/** What a photo's ID may be: the IDs list items are given (`i_k3j9x2ab`), or any short word of that alphabet. */
export const GALLERY_ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The list of photos a layout reads a gallery field as: each one's picture (always there) and its caption. */
export function galleryListProp(f: Pick<GalleryFieldSchema, 'label' | 'description'>): ListProp {
  return {
    type: 'list',
    label: typeof f.label === 'string' ? f.label : '',
    ...(f.description ? { description: f.description } : {}),
    itemLabel: 'Photo',
    titleField: 'caption',
    fields: {
      // Every photo of a gallery has its picture: one whose picture the library no longer has is left out.
      image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' }, required: true },
      caption: { type: 'string', label: 'Caption', default: '' }
    },
    default: [],
    max: MAX_GALLERY_PHOTOS
  };
}

/**
 * The photos of a gallery value that are photos: an object with a text ID and a picture naming a library asset by ID,
 * in their order. Whether the library still has that asset is the reader's to judge.
 */
export function galleryRows(value: unknown): GalleryItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: GalleryItem[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { id, image, caption } = row as Partial<GalleryItem>;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (!image || typeof image !== 'object' || typeof image.assetId !== 'string' || !image.assetId) continue;
    seen.add(id);
    const picture: ImageValue = { assetId: image.assetId, alt: typeof image.alt === 'string' ? image.alt : '', ...(image.decorative === true ? { decorative: true } : {}) };
    out.push({ id, image: picture, caption: typeof caption === 'string' ? caption : '' });
  }
  return out;
}

/** The library assets a gallery value shows, once for each photo showing one, in its order. */
export function galleryAssetIds(value: unknown): string[] {
  return galleryRows(value).map((r) => r.image.assetId as string);
}

/**
 * Why a gallery field's photos cannot fill a list property `to` (a placed Gallery's images, a Carousel's slides): a list
 * whose items are not worked out from what it holds, one with no picture field `image` for each photo's picture, or one
 * with a field `image` or `caption` of another kind, which would show the photo's words or picture as nothing. Its
 * other fields take their defaults on every photo (a Gallery's photos open full size, as its new ones do). Null when
 * it fits; required fields are judged with every other binding's (see shared/required.ts).
 */
export function galleryFitProblem(from: Pick<ListProp, 'label' | 'fields'>, to: PropSchema | undefined): string | null {
  if (!to || to.type !== 'list') return `“${from.label}” is a list of photos, which only a list of pictures takes.`;
  if (to.feed || to.pageTeaser) return `“${to.label}” fills itself from the site's pages, so it takes no photos.`;
  const fields = to.fields && typeof to.fields === 'object' ? to.fields : {};
  const image = Object.hasOwn(fields, 'image') ? fields.image : undefined;
  if (image?.type !== 'image') return `“${to.label}” has no picture (“image”) for each photo, so it cannot show “${from.label}”.`;
  for (const [k, f] of Object.entries(from.fields)) {
    const into = Object.hasOwn(fields, k) ? fields[k] : undefined;
    if (into && into.type !== f.type) return `“${to.label}” has a “${k}” that is a ${into.type}, not the ${f.type} each photo of “${from.label}” has.`;
  }
  return null;
}
