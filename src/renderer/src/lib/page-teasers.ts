// What the inspector says about a page list's card fields: where an empty field's text comes from, and how to go
// back to it. Plain functions, so the wording is tested without a renderer.
import type { ListProp, ProjectState } from '@shared/types';
import { followsPage, pageValue, teaserFields, teaserPage } from '@shared/page-teasers';

export interface TeaserFieldNote {
  /** What an empty text field shows: the page's own text. */
  placeholder?: string;
  hint: string;
}

const NOUN = { title: 'title', description: 'description', image: 'sharing image' } as const;

const clip = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** The note for one field of a page list's card, or undefined for a field (or list) that does not follow a page. */
export function teaserFieldNote(state: ProjectState, schema: ListProp | undefined, item: Record<string, unknown> | undefined, field: string): TeaserFieldNote | undefined {
  const teaser = schema?.pageTeaser;
  if (!teaser || !item) return undefined;
  if (field === teaser.link) return { hint: 'The card follows this page when it is renamed or moved, and leaves the list if the page is deleted.' };
  const what = teaserFields(teaser).find(([f]) => f === field)?.[1];
  if (!what) return undefined;
  const page = teaserPage(state, teaser, item);
  const noun = NOUN[what];
  if (!page) return { hint: `Only a page of this site gives the card its ${noun}; anything else shows what is entered here.` };
  const value = pageValue(state, page, what);
  const own = !followsPage(item[field]);
  if (what === 'image') {
    const name = value && typeof value === 'object' && value.assetId ? state.assets.assets[value.assetId]?.name : undefined;
    if (own) return { hint: name ? `Chosen for this card. Remove it to show ${page.title}’s sharing image (${name}).` : `Chosen for this card. ${page.title} has no sharing image.` };
    return { hint: name ? `Shows ${page.title}’s sharing image (${name}). Choose an image to show a different one on this card.` : `${page.title} has no sharing image. Set one in its page settings, or choose an image for this card.` };
  }
  const text = typeof value === 'string' ? value : '';
  if (own) return { hint: text ? `Typed for this card. Clear it to show the page’s ${noun}, “${clip(text)}”.` : `Typed for this card. ${page.title} has no ${noun}.` };
  return text ? { placeholder: text, hint: `From ${page.title}, and follows it. Type to show different text on this card.` } : { hint: `${page.title} has no ${noun}. Add one in its page settings, or type one for this card.` };
}

/** The pages a page list can still add, in the site's page order: every page not already listed, except `exceptPageId` (the page the list is on). */
export function pagesToAdd(state: ProjectState, schema: ListProp | undefined, items: ReadonlyArray<Record<string, unknown>>, exceptPageId?: string | null): string[] {
  const teaser = schema?.pageTeaser;
  if (!teaser) return [];
  const listed = new Set(items.map((it) => teaserPage(state, teaser, it)?.id).filter(Boolean));
  return state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id) && id !== exceptPageId && !listed.has(id));
}
