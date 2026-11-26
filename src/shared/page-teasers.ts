/**
 * Page lists: list items that stand for pages of the site (a portfolio index, a service directory). Each item links
 * to a page by its ID, and a field the list maps to the page (`ListProp.pageTeaser`) shows that page's own title,
 * description or sharing image while the item leaves it empty. A value the author types is a deliberate override
 * and stays, whatever the page later becomes. Everything that reads such an item as it will show (the generator,
 * the checks on what a page renders, the inspector, the canvas) goes through `effectiveItem`, so they agree.
 */
import type { ImageValue, LinkValue, ListProp, PageDoc, PageTeaser, ProjectState, ScalarPropSchema } from './types';
import { libraryAlt } from './asset-alt';

export type PageTeaserValue = 'title' | 'description' | 'image';
export const PAGE_TEASER_VALUES: readonly PageTeaserValue[] = ['title', 'description', 'image'];

/** The field types each page value can fill. */
export const PAGE_TEASER_TYPES: Record<PageTeaserValue, ScalarPropSchema['type']> = { title: 'string', description: 'string', image: 'image' };

/** The page an item links to, while that link is a page link to a page the site still has. */
export function teaserPage(state: ProjectState, teaser: PageTeaser | undefined, item: Record<string, unknown> | null | undefined): PageDoc | undefined {
  if (!teaser || !item || typeof item !== 'object') return undefined;
  const link = item[teaser.link] as LinkValue | undefined;
  if (!link || typeof link !== 'object' || link.type !== 'page' || typeof link.target !== 'string') return undefined;
  return Object.hasOwn(state.pages, link.target) ? state.pages[link.target] : undefined;
}

/** Whether an item's own value leaves the field to the page: blank text, or no image chosen. */
export function followsPage(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return !value.trim();
  if (typeof value === 'object' && 'assetId' in value) return !(value as ImageValue).assetId;
  return false;
}

/** What a page gives a field mapped to `what`, or undefined when the page has nothing for it. */
export function pageValue(state: ProjectState, page: PageDoc, what: PageTeaserValue): string | ImageValue | undefined {
  if (what === 'title') return page.title;
  if (what === 'description') return page.seo?.description?.trim() ? page.seo.description : undefined;
  const id = page.seo?.socialImage;
  const asset = id && Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id] : undefined;
  if (!asset || asset.kind !== 'image') return undefined;
  // The card's linked title already names the page, so an image with no suggested alt text adds nothing to read.
  return { assetId: asset.id, alt: libraryAlt(asset) };
}

/** The item field mapped to each page value, for a list that has a mapping. */
export function teaserFields(teaser: PageTeaser): Array<[field: string, what: PageTeaserValue]> {
  const out: Array<[string, PageTeaserValue]> = [];
  for (const what of PAGE_TEASER_VALUES) {
    const field = teaser[what];
    if (typeof field === 'string' && field) out.push([field, what]);
  }
  return out;
}

/** The page value a field shows while it is empty, or undefined when the field does not follow a page (or the page gives nothing). */
export function inheritedValue(state: ProjectState, schema: ListProp | undefined, item: Record<string, unknown> | null | undefined, field: string): string | ImageValue | undefined {
  const teaser = schema?.pageTeaser;
  const page = teaserPage(state, teaser, item);
  if (!teaser || !page) return undefined;
  const what = teaserFields(teaser).find(([f]) => f === field)?.[1];
  return what ? pageValue(state, page, what) : undefined;
}

/**
 * An item as it shows: each mapped field the item leaves empty takes the linked page's value, in the stored form
 * (text, or an image by asset ID). Any other item, or a list without a mapping, comes back as it is.
 */
export function effectiveItem<T extends Record<string, unknown>>(state: ProjectState, schema: ListProp | undefined, item: T): T {
  const teaser = schema?.pageTeaser;
  const page = teaserPage(state, teaser, item);
  if (!teaser || !page) return item;
  let out: T | undefined;
  for (const [field, what] of teaserFields(teaser)) {
    const own = Object.hasOwn(item, field) ? item[field] : (schema!.fields[field] as { default?: unknown } | undefined)?.default;
    if (!followsPage(own)) continue;
    const v = pageValue(state, page, what);
    if (v === undefined) continue;
    out ??= { ...item };
    (out as Record<string, unknown>)[field] = v;
  }
  return out ?? item;
}
