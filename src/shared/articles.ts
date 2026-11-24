/**
 * Dated articles: pages that carry a publication date (and optionally a byline and an excerpt), such as studio news
 * or announcements. The date lives on the page, so every place that shows it (the article's own header, the news
 * lists on other pages) reads the same value, and a news list orders and fills itself from the site's articles
 * whenever the site is generated. Nothing here runs in the exported site: the generator writes the results out.
 */
import type { LinkValue, ListFeed, PageArticle, PageDoc, ProjectState } from './types';

/** Whether `s` is a real calendar date written as YYYY-MM-DD. */
export function isArticleDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  // Set field by field: Date.UTC would read years below 100 as 1900 + year.
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return y > 0 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Today's date on this computer, as YYYY-MM-DD: what a new article is dated unless another date is given. */
export function todayArticleDate(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A page's article details, while it is an article with a valid date. */
export function pageArticle(page: PageDoc | undefined): PageArticle | undefined {
  const a = page?.article;
  return a && typeof a === 'object' && isArticleDate(a.date) ? a : undefined;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A publication date as readers of the site's language write it ("14 November 2026", "November 14, 2026"). The date
 * is a calendar day, not an instant, so it is formatted in UTC and never moves a day with the computer's time zone.
 * A language tag the platform does not know falls back to English.
 */
export function formatArticleDate(date: string, language: string | undefined): string {
  if (!isArticleDate(date)) return date;
  const tag = language?.trim() || 'en';
  let f = formatters.get(tag);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
    try {
      // A well-formed tag the platform has no data for falls back to English rather than to this computer's locale.
      f = new Intl.DateTimeFormat([tag, 'en'], opts);
    } catch {
      f = new Intl.DateTimeFormat('en', opts);
    }
    formatters.set(tag, f);
  }
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return f.format(t);
}

/**
 * The articles a news list shows, newest first: every article the website publishes (not a draft) that is not
 * hidden from news lists, except `exceptPageId` (the page the list is on). Articles of the same day are ordered by
 * page ID, which no rename, move or reordering of the pages changes, so they never trade places on their own.
 */
export function listedArticles(state: ProjectState, exceptPageId?: string): PageDoc[] {
  const out: PageDoc[] = [];
  for (const id of Object.keys(state.pages)) {
    const page = state.pages[id];
    const a = pageArticle(page);
    if (!a || a.hidden === true || id === exceptPageId) continue;
    // A draft is not part of the website (the generator's isDraftPage): the Home page never is one.
    if (page.draft === true && id !== state.site.homePageId) continue;
    out.push(page);
  }
  return out.sort((a, b) => {
    const da = a.article!.date;
    const db = b.article!.date;
    if (da !== db) return da < db ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** A computed list's own limit: a whole number of rows, or none (Infinity) for anything else a document holds. */
export function feedLimit(schema: { max?: unknown }): number {
  return typeof schema.max === 'number' && Number.isInteger(schema.max) && schema.max >= 0 ? schema.max : Infinity;
}

/** One row of a computed list: an article (or, for `currentPage`, the page itself) as list item fields. */
export interface ArticleRow {
  /** The page's ID, so a row keeps its identity (and the editor's selection) when the order changes. */
  id: string;
  pageLink: LinkValue;
  title: string;
  /** YYYY-MM-DD, for the `datetime` of a time element; empty on a page that is not an article. */
  date: string;
  /** The date as readers of the site's language write it. */
  dateLabel: string;
  byline: string;
  excerpt: string;
}

/** The field names a computed list's rows fill, and the property type each needs. */
export const ARTICLE_ROW_FIELDS = { pageLink: 'link', title: 'string', date: 'string', dateLabel: 'string', byline: 'string', excerpt: 'string' } as const;

export function articleRow(state: ProjectState, page: PageDoc): ArticleRow {
  const a = pageArticle(page);
  return {
    id: page.id,
    pageLink: { type: 'page', target: page.id },
    title: page.title,
    date: a?.date ?? '',
    dateLabel: a ? formatArticleDate(a.date, state.site.language) : '',
    // A hand-edited document may hold anything here: only text is shown.
    byline: typeof a?.byline === 'string' ? a.byline.trim() : '',
    excerpt: typeof a?.excerpt === 'string' ? a.excerpt.trim() : ''
  };
}

/**
 * The rows a computed list holds where it is placed. `articles`: the site's listed articles, newest first, leaving
 * out the page the list is on. `currentPage`: that page itself (its title, and its date, byline and excerpt while it
 * is an article). `pageId` is the page the list renders on, through any designs in between; without one (a list in
 * the shared header or footer, written once for every page) `articles` lists every article and `currentPage` is
 * empty. `max` keeps the newest that many.
 */
export function articleRows(state: ProjectState, feed: ListFeed, pageId: string | undefined, max?: number): ArticleRow[] {
  // A list that shows no rows reads no pages.
  if (max === 0) return [];
  const page = pageId !== undefined && Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  // A feed this version does not know (a hand-edited document) holds nothing, wherever it is placed.
  const rows = feed === 'currentPage' ? (page ? [articleRow(state, page)] : []) : feed === 'articles' ? listedArticles(state, pageId).map((p) => articleRow(state, p)) : [];
  return max !== undefined && max >= 0 ? rows.slice(0, max) : rows;
}
