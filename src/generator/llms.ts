/**
 * The agentic discovery files (see shared/llms.ts): `llms.txt`, the index of the pages and collection entries agents
 * are told of; `llms-full.txt`, all of them as Markdown in one file; and each one's Markdown copy beside its page.
 *
 * They list exactly the documents whose visibility says `llms` (generator/seo-metadata.ts): on the published website
 * and not hidden from search engines. Drafts and `noindex` pages never appear, nor anything of them in the Markdown of
 * another (generator/markdown.ts). Only the documents' public fields are read (titles, descriptions, excerpts, dates,
 * what their pages show); nothing private to the project is. The index describes an entry as the RSS feed does
 * (./entry-summary).
 *
 * Links are the site's public URLs once it has one. Without one they are written relative to the file holding them,
 * as the site's own pages resolve theirs, so the files still lead to each other wherever the website is put (in a
 * folder of a host, or opened from disk).
 */
import type { EffectiveSeo, SeoSubject } from '@shared/seo';
import type { ProjectState } from '@shared/types';
import { agentDiscovery, LLMS_FULL_FILE, markdownMirrorRoute, oneLine } from '@shared/llms';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { isArticleDate } from '@shared/articles';
import { isDraftEntry } from '@shared/collections';
import { derived } from './cache';
import { createSeoResolver } from './seo-metadata';
import { entryMarkdown, escapeLineStart, inlineMarkdown, pageMarkdown, type MarkdownContext } from './markdown';
import { showsEntryText } from './checks';
import { entrySummary } from './entry-summary';
import { publishedState } from './index';

/** A document as the listing names it: "page\n{id}" or "entry\n{collection}\n{entry}". */
export const subjectKey = (s: SeoSubject) => (s.kind === 'page' ? `page\n${s.pageId}` : `entry\n${s.collectionId}\n${s.entryId}`);

/** The documents agents are told of, and the address of each, worked out once per state. */
interface Listing {
  documents: readonly EffectiveSeo[];
  routes: Map<string, string>;
  /** The same routes by key, made when first asked for. */
  byKey?: Record<string, string>;
}
const listings = new WeakMap<ProjectState, Listing>();

/** The documents agents are told of: the listed pages in site order, then the listed entries in site order. */
export function listedDocuments(state: ProjectState): readonly EffectiveSeo[] {
  return listingOf(state).documents;
}

function listingOf(state: ProjectState): Listing {
  let found = listings.get(state);
  if (!found) {
    const documents = createSeoResolver(state)
      .published()
      .filter((d) => d.visibility.llms);
    found = { documents, routes: new Map(documents.map((d) => [subjectKey(d.subject), d.route])) };
    listings.set(state, found);
  }
  return found;
}

/**
 * The address of a document agents are told of, null for any other. In a cached run each document's answer is worked
 * out once per state, so a file depends on the documents it names and not on every one of the project.
 */
export function listedRoute(state: ProjectState, subject: SeoSubject): string | null {
  const key = subjectKey(subject);
  // The listing's addresses are one value of their own, read by each document's.
  return derived(state, `llms:${key}`, (s) => {
    const routes = derived(s, 'llms:routes', (t) => {
      const listing = listingOf(t);
      return (listing.byKey ??= Object.fromEntries(listing.routes));
    });
    return Object.hasOwn(routes, key) ? routes[key] : null;
  });
}

/**
 * The documents agents are told of, each with its address, in listing order. In a cached run they are worked out once
 * per state, so the index is made again only when they, or the titles and descriptions it reads, change.
 */
function listedRoutes(state: ProjectState): Array<{ subject: SeoSubject; route: string }> {
  return derived(state, 'llms:listed', (s) => listingOf(s).documents.map((d) => ({ subject: d.subject, route: d.route })));
}

/** Whether a document has a Markdown copy beside its page: the site writes them, and agents are told of it. */
export function hasMarkdownMirror(state: ProjectState, subject: SeoSubject): boolean {
  return state.site.markdownMirrors === true && listedRoute(state, subject) !== null;
}

/**
 * A path of the site ("/about/", "/guide.pdf") as a file at `from` links to it: its public URL when the site has one,
 * else a path relative to the folder `from` is in ("../about/" from "/blog/").
 */
export function siteHref(state: ProjectState, from: string, path: string): string {
  const base = publicUrl(state.site);
  if (base) return base + routeUrl(path);
  const up = from.split('/').filter(Boolean).length;
  return routeUrl((up ? '../'.repeat(up) : './') + path.replace(/^\/+/, ''));
}

/** A document's own words about itself: a page's description, an entry's excerpt. None when it has none of its own. */
function ownDescription(state: ProjectState, subject: SeoSubject): string {
  if (subject.kind === 'page') return oneLine(state.pages[subject.pageId]?.seo?.description);
  return oneLine(state.collections[subject.collectionId]?.entries[subject.entryId]?.excerpt);
}

/** Each state's published projection, so describing every entry works it out (and each entry's neighbours) once. */
const published = new WeakMap<ProjectState, ProjectState>();

function publishedOnce(state: ProjectState): ProjectState {
  let found = published.get(state);
  if (!found) published.set(state, (found = publishedState(state)));
  return found;
}

/**
 * What the index says of a document: a page's own description, an entry's summary. In a cached run the index depends
 * on what an entry's summary says, not on all of the text it may be taken from.
 */
function listedDescription(state: ProjectState, subject: SeoSubject): string {
  if (subject.kind === 'page') return ownDescription(state, subject);
  const { collectionId, entryId } = subject;
  const key = subjectKey(subject);
  // An entry's own words read only the entry: its text, quoted as its page shows it, is worked out from the published
  // projection of the whole project, for every state.
  const quoted = (s: ProjectState) =>
    derived(
      s,
      `llms:summaryText:${key}`,
      (t) => {
        const live = publishedOnce(t);
        const collection = live.collections[collectionId];
        const entry = collection?.entries[entryId];
        return entry ? entrySummary(live, collection, entry) : '';
      },
      { opaque: true }
    );
  return derived(state, `llms:summary:${key}`, (s) => {
    const entries = s.collections[collectionId]?.entries;
    if (!entries || typeof entries !== 'object') return quoted(s);
    // Only an entry the website publishes has one: publishedState leaves the rest out, and the published ones as they are.
    const entry = entries[entryId];
    if (!entry || typeof entry !== 'object' || isDraftEntry(entry)) return '';
    return oneLine(entry.excerpt) || oneLine(entry.seo?.description) || quoted(s);
  });
}

/** The name a document is listed by: a page's title, an entry's own title; its address when it has none. */
function titleOf(state: ProjectState, subject: SeoSubject, route: string): string {
  const title = subject.kind === 'page' ? state.pages[subject.pageId]?.title : state.collections[subject.collectionId]?.entries[subject.entryId]?.title;
  return oneLine(title) || route;
}

/** Text on one line after a quote's marker, written literally: nothing it starts with makes it a heading or a list. */
const quotedLine = (text: string) => escapeLineStart(inlineMarkdown(text));

/** The index and the full text open the same way: the site's name, and its summary when there is one. */
function heading(state: ProjectState, typed?: string): string[] {
  const summary = typed === undefined ? agentDiscovery(state.site).summary : agentDiscovery({ ...state.site, llmsSummary: typed }).summary;
  const lines = [`# ${inlineMarkdown(oneLine(state.site.name) || 'Website')}`];
  if (summary) lines.push('', `> ${quotedLine(summary)}`);
  return lines;
}

/**
 * The llms.txt index: the site's name and summary, then its pages and each collection's entries, each a link (to its
 * Markdown copy when the site writes them, else its page) with its description (an entry's summary). `summary` is the summary as the
 * author is typing it, for the editor's preview.
 */
export function generateLlmsTxt(state: ProjectState, opts: { summary?: string } = {}): string {
  const { llmsFull, markdownMirrors } = agentDiscovery(state.site);
  const lines = heading(state, opts.summary);
  if (llmsFull) lines.push('', `The full text of every page and post listed here is in [${LLMS_FULL_FILE}](${siteHref(state, '/', `/${LLMS_FULL_FILE}`)}).`);
  // Pages, then each collection's entries: told apart by what they are, whatever a collection is called.
  const groups = new Map<string, { name: string; items: string[] }>();
  for (const d of listedRoutes(state)) {
    const key = d.subject.kind === 'page' ? 'page' : `entry\n${d.subject.collectionId}`;
    let group = groups.get(key);
    if (!group) {
      const name = d.subject.kind === 'page' ? 'Pages' : oneLine(state.collections[d.subject.collectionId]?.settings.name) || d.subject.collectionId;
      group = { name, items: [] };
      groups.set(key, group);
    }
    const href = siteHref(state, '/', markdownMirrors ? markdownMirrorRoute(d.route) : d.route);
    const description = listedDescription(state, d.subject);
    group.items.push(`- [${inlineMarkdown(titleOf(state, d.subject, d.route))}](${href})${description ? `: ${inlineMarkdown(description)}` : ''}`);
  }
  for (const { name, items } of groups.values()) lines.push('', `## ${inlineMarkdown(name)}`, '', ...items);
  return lines.join('\n') + '\n';
}

/** The opening of llms-full.txt, before the documents. */
export function llmsFullHeading(state: ProjectState): string {
  return heading(state).join('\n') + '\n';
}

/** llms-full.txt: its opening, then each document's Markdown (as `documentMarkdown` writes it for the root), in listing order. */
export function joinLlmsFull(head: string, documents: readonly string[]): string {
  return [head.trimEnd(), ...documents.map((d) => d.trimEnd())].join('\n\n---\n\n') + '\n';
}

/**
 * One document as Markdown, for a file at `from` (its Markdown copy, at its own address, or llms-full.txt at the
 * root): its title, its address, its own description, a post's date, then what it says. Empty for a document agents
 * are not told of.
 */
export function documentMarkdown(state: ProjectState, subject: SeoSubject, from: string): string {
  const route = listedRoute(state, subject);
  if (route === null) return '';
  const ctx: MarkdownContext = {
    state,
    route,
    listedPage: (pageId) => listedRoute(state, { kind: 'page', pageId }) !== null,
    listedEntry: (collectionId, entryId) => listedRoute(state, { kind: 'entry', collectionId, entryId }) !== null,
    href: (path) => siteHref(state, from, path)
  };
  const lines = [`# ${inlineMarkdown(titleOf(state, subject, route))}`, '', `URL: ${siteHref(state, from, route)}`];
  const description = ownDescription(state, subject);
  if (description) lines.push('', `> ${quotedLine(description)}`);
  let body = '';
  if (subject.kind === 'page') body = pageMarkdown(ctx, state.pages[subject.pageId]);
  else {
    const collection = state.collections[subject.collectionId];
    const entry = collection.entries[subject.entryId];
    if (isArticleDate(entry.publishedAt)) lines.push('', `Published: ${entry.publishedAt}${isArticleDate(entry.updatedAt) && entry.updatedAt !== entry.publishedAt ? ` · Updated: ${entry.updatedAt}` : ''}`);
    // Its text only where its page shows it: a layout without the entry's text leaves it off the website.
    if (showsEntryText(state, collection, entry)) body = entryMarkdown(ctx, entry);
  }
  if (body) lines.push('', body);
  return lines.join('\n') + '\n';
}

/**
 * Every discovery file the site's settings ask for, by project path, made through `file` (generateProject's, which
 * reuses a file whose inputs are unchanged). `state` is the plain state of the run.
 */
export function addDiscoveryFiles(state: ProjectState, files: Map<string, string>, file: (key: string, make: (state: ProjectState) => string) => string): void {
  const settings = agentDiscovery(state.site);
  // The index reads which documents are listed (worked out once per state) and their titles and descriptions alone.
  if (settings.llmsTxt) files.set('static/llms.txt', file('llms.txt', (s) => generateLlmsTxt(s)));
  if (!settings.markdownMirrors && !settings.llmsFull) return;
  // With a public URL every file writes the same links, so a document's copy and its part of the full text are one.
  const shared = !!publicUrl(state.site);
  const parts: string[] = [];
  for (const d of listedDocuments(state)) {
    const key = subjectKey(d.subject);
    const subject = d.subject;
    const made = (from: string) => file(`md:${key}\n${shared ? '' : from}`, (s) => documentMarkdown(s, subject, from));
    if (settings.markdownMirrors) files.set(`static${markdownMirrorRoute(d.route)}`, made(d.route));
    if (settings.llmsFull) parts.push(made('/'));
  }
  if (settings.llmsFull) files.set(`static/${LLMS_FULL_FILE}`, joinLlmsFull(file('llms-full.txt', llmsFullHeading), parts));
}
