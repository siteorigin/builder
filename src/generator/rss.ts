/**
 * The website's RSS 2.0 feed (`/rss.xml`): every published entry of the collections in it, newest first, each with its title, its
 * address, when it was published, who wrote it and its summary (see ./entry-summary). Feed readers need full addresses, so the site has a
 * feed only once it has a public URL; without one the export says the feed was left out. Every page of the website
 * names the feed in its `<head>` (the shared layout), so a reader finds it from any address on the site.
 *
 * Which collections it lists is each collection's own choice, by default its kind's: a blog's posts are in it, and a
 * structured collection's records (staff bios, listings) are not. Which entries it lists follows the website, not
 * search: drafts and entries without a page of their own are left out, while an entry hidden from search engines or
 * from the site's own search is still a published post its
 * subscribers read. An item's link is the entry's own address on this site, and its ID names the project and the
 * entry, so renaming a post, moving the site to another domain or reordering the feed never delivers it twice.
 *
 * The feed is plain XML with a fixed order, and its build date is its posts' newest day rather than the clock's: the
 * same project always gives the same bytes.
 */
import type { ProjectState } from '@shared/types';
import { isArticleDate } from '@shared/articles';
import { inSiteFeed, siteEntries } from '@shared/collections';
import { isLanguageCode, siteLanguage } from '@shared/languages';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { derived } from './cache';
import { entrySummary } from './entry-summary';
import { publishedState } from './index';

/** The feed's file name, at the root of the website. */
export const RSS_FILE = 'rss.xml';
/** Where the generator writes it in the project. */
export const RSS_PATH = `static/${RSS_FILE}`;

/** One post as the feed lists it. */
export interface FeedItem {
  title: string;
  /** Its full address on the website. */
  link: string;
  /** Its ID, which never changes while the entry exists. */
  guid: string;
  /** Its publication day (YYYY-MM-DD), when that is a valid one. */
  published?: string;
  author?: string;
  description?: string;
}

/** The feed as a whole: its channel's details and its items, newest first. */
export interface Feed {
  /** The feed's own address. */
  url: string;
  title: string;
  /** The website's home address. */
  link: string;
  description: string;
  language?: string;
  /** The newest day (YYYY-MM-DD) a listed post was published or updated; absent when none has a valid one. */
  built?: string;
  items: FeedItem[];
}

/** Text on one line, or nothing for a value that is not text (a hand-edited document). */
const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Text as an XML 1.0 document may hold it: each character XML forbids (control characters other than tab and line
 * breaks, a lone half of a surrogate pair, U+FFFE and U+FFFF) becomes U+FFFD, and the five characters with a meaning
 * in XML are written as references, so text never closes or opens anything ("]]>" included).
 */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Text as HTML shows it as written: readers show an item's description as HTML, so a "<" in a summary is a "<". */
const htmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A publication day as RSS dates are written (RFC 822): midnight UTC that day. */
export function rssDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toUTCString();
}

/**
 * The feed the website has, or null without a public URL or without a published entry. In a cached run it is worked
 * out once per state, so a file that reads it depends only on what the feed says.
 */
export function siteFeed(state: ProjectState): Feed | null {
  return derived(state, 'rss-feed', buildFeed);
}

const feedTitle = (state: ProjectState, base: string) => oneLine(state.site.name) || new URL(base).host;

function buildFeed(state: ProjectState): Feed | null {
  const base = publicUrl(state.site);
  if (!base) return null;
  const project = oneLine(state.manifest?.projectId);
  // Drafts leave before addresses are shared out, so a post whose address a draft held first is the one listed.
  const live = publishedState(state);
  const days: string[] = [];
  const items = feedEntries(live).map(({ collection, entry, route }) => {
    const item: FeedItem = { title: oneLine(entry.title) || entry.slug, link: base + routeUrl(route), guid: project ? `${project}:${entry.id}` : entry.id };
    if (isArticleDate(entry.publishedAt)) item.published = entry.publishedAt;
    for (const day of [entry.publishedAt, entry.updatedAt]) if (isArticleDate(day)) days.push(day);
    const author = oneLine(entry.author);
    if (author) item.author = author;
    const description = entrySummary(live, collection, entry);
    if (description) item.description = description;
    return item;
  });
  if (!items.length) return null;
  // Newest first across every collection; posts of the same day by ID, and any without a valid day last.
  items.sort((a, b) => {
    if (a.published !== b.published) return !a.published ? 1 : !b.published ? -1 : a.published < b.published ? 1 : -1;
    return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
  });
  const title = feedTitle(state, base);
  const language = siteLanguage(state.site);
  const built = days.sort().at(-1);
  return {
    url: `${base}/${RSS_FILE}`,
    title,
    link: `${base}/`,
    description: oneLine(state.site.description) || title,
    ...(isLanguageCode(language) ? { language } : {}),
    ...(built ? { built } : {}),
    items
  };
}

/**
 * What every page's link to the feed says (its address and title), or null when the website has no feed. In a cached
 * run the layout depends on this alone, so a post's new summary makes the feed again but not the layout.
 */
export function feedLink(state: ProjectState): { url: string; title: string } | null {
  return derived(state, 'rss-link', (s) => {
    const base = publicUrl(s.site);
    // Without building the feed: no post's summary is worked out for its address and title.
    return base && hasFeedEntries(s) ? { url: `${base}/${RSS_FILE}`, title: feedTitle(s, base) } : null;
  });
}

/** The feed's file, or null when the website has no feed. */
export function generateRssFeed(state: ProjectState): string | null {
  const feed = siteFeed(state);
  if (!feed) return null;
  const el = (name: string, value: string, indent = '\t\t') => `${indent}<${name}>${xmlText(value)}</${name}>`;
  const channel = [
    el('title', feed.title),
    el('link', feed.link),
    el('description', feed.description),
    ...(feed.language ? [el('language', feed.language)] : []),
    ...(feed.built ? [el('lastBuildDate', rssDate(feed.built))] : []),
    `\t\t<atom:link href="${xmlText(feed.url)}" rel="self" type="application/rss+xml"/>`
  ];
  const items = feed.items.map((item) => {
    const lines = [
      el('title', item.title, '\t\t\t'),
      el('link', item.link, '\t\t\t'),
      `\t\t\t<guid isPermaLink="false">${xmlText(item.guid)}</guid>`,
      ...(item.published ? [el('pubDate', rssDate(item.published), '\t\t\t')] : []),
      // RSS's own author element must be an email address; a byline is written as Dublin Core's creator.
      ...(item.author ? [el('dc:creator', item.author, '\t\t\t')] : []),
      ...(item.description ? [el('description', htmlText(item.description), '\t\t\t')] : [])
    ];
    return `\t\t<item>\n${lines.join('\n')}\n\t\t</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n\t<channel>\n${[...channel, ...items].join('\n')}\n\t</channel>\n</rss>\n`;
}

/**
 * The entries the feed lists, of a state without drafts: each published entry with a page of its own whose collection
 * is in the feed (a blog by default, records only when their collection says so). Addresses are shared out across every
 * collection first, so an entry left out of the feed still keeps the address it holds from one listed.
 */
function feedEntries(live: ProjectState) {
  return siteEntries(live).filter(({ collection }) => inSiteFeed(collection.settings));
}

/** Whether the website would have a feed once it has a public URL: it has a published entry the feed lists. */
export function hasFeedEntries(state: ProjectState): boolean {
  return feedEntries(publishedState(state)).length > 0;
}
