/**
 * The structured data a generated page or collection entry carries: one connected Schema.org graph (seo-graph.ts)
 * with what the website itself says about the document. The Home page is about the site's publisher; an entry's page
 * says when it was last revised, and is about a blog posting with its headline, dates, author, description and image;
 * a page's FAQ makes it an FAQ page with its questions in order, and each contact section it shows is a part of the
 * page with the contact details it gives (who they belong to is not said, since a page can show a venue's box office
 * as well as the publisher's own); and the website says where it can be searched, once a page shows a search that
 * reads the words it is sent in its address.
 *
 * Only what visitors are shown or the author set for the public is written: nothing from the project's private brief
 * or notes.
 */
import type { NodeTree, ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { isArticleDate } from '@shared/articles';
import { partsShown } from '@shared/page-shell';
import { translationGroup } from '@shared/languages';
import { seoText } from '@shared/seo';
import { buildSeoGraph, graphScriptText, type GraphContribution, type GraphContributor, type JsonValue, type SeoGraph } from './seo-graph';
import { derived } from './cache';
import { createSeoResolver, type SeoResolver } from './seo-metadata';
import { structuredContent } from './checks';
import { searchesFromAddress } from './search';

/** One value, or several. */
const oneOrMany = (list: string[]): JsonValue | undefined => (list.length === 1 ? list[0] : list.length ? list : undefined);
/** A property only when it has a value. */
/** Whether a page is the Home page, or the Home page in another language. */
function isHome(state: ProjectState, pageId: string): boolean {
  if (pageId === state.site.homePageId) return true;
  const home = Object.hasOwn(state.pages, state.site.homePageId) ? state.pages[state.site.homePageId] : undefined;
  const group = home && translationGroup(home);
  return !!group && Object.hasOwn(state.pages, pageId) && translationGroup(state.pages[pageId]) === group;
}

/** The Home page, in every language it is written in, is about whoever publishes the site. Other pages have subjects of their own. */
const homeAbout: GraphContributor = ({ state, meta, ids }) => (meta.subject.kind === 'page' && isHome(state, meta.subject.pageId) ? { extend: [{ id: ids.webpage, set: { about: { '@id': ids.publisher } } }] } : null);

/** An entry says when it was last revised, when its author says so. A publication date is not a revision. */
const revised: GraphContributor = ({ state, meta, ids }) => {
  if (meta.subject.kind !== 'entry') return null;
  const { collectionId, entryId } = meta.subject;
  const updatedAt = state.collections[collectionId]?.entries[entryId]?.updatedAt;
  return isArticleDate(updatedAt) ? { extend: [{ id: ids.webpage, set: { dateModified: updatedAt } }] } : null;
};

/**
 * An entry's page is about the post it shows: a BlogPosting of its own, the main thing on that page, published by the
 * site's publisher. Its headline is the entry's own title (a browser title may carry the site's name); it was last
 * modified when its author says it was revised, else the day it was published; its image is the one it is shared with.
 * Each property is left out when the entry has nothing to say for it.
 */
const blogPosting: GraphContributor = ({ state, meta, ids }) => {
  if (meta.subject.kind !== 'entry') return null;
  const entry = state.collections[meta.subject.collectionId]?.entries[meta.subject.entryId];
  if (!entry) return null;
  const modified = meta.modified ?? meta.published;
  return {
    nodes: [
      {
        '@type': 'BlogPosting',
        '@id': ids.page('blogposting'),
        mainEntityOfPage: { '@id': ids.webpage },
        ...opt('headline', seoText(entry.title) || seoText(meta.socialTitle) || undefined),
        ...opt('description', seoText(meta.description) || undefined),
        ...opt('datePublished', meta.published ?? undefined),
        ...opt('dateModified', modified ?? undefined),
        ...opt('author', meta.author ? { '@type': 'Person', name: meta.author } : undefined),
        ...opt('image', meta.imageUrl ? { '@type': 'ImageObject', url: meta.imageUrl } : undefined),
        publisher: { '@id': ids.publisher }
      }
    ]
  };
};

/**
 * A page's FAQ and contact sections, as the page shows them (`structuredContent`). Its questions make the page an FAQ
 * page too, with each question and its answer in the order shown. Each contact section is a part of the page
 * (`#contact`, `#contact-2`, …) about the contact point and places it shows.
 */
const pageContent: GraphContributor = ({ state, meta, ids }) => {
  if (meta.subject.kind !== 'page') return null;
  const page = state.pages[meta.subject.pageId];
  const found = structuredContent(state, page);
  const extend: NonNullable<GraphContribution['extend']> = [];
  if (found.faq.length)
    extend.push({
      id: ids.webpage,
      add: { '@type': 'FAQPage' },
      set: { mainEntity: found.faq.map((e) => ({ '@type': 'Question', name: e.question, acceptedAnswer: { '@type': 'Answer', text: e.answer } })) }
    });
  const nodes = found.businesses
    .filter((b) => b.email.length || b.telephone.length || b.address.length)
    .map((b, i) => {
      const point = b.email.length || b.telephone.length ? [{ '@type': 'ContactPoint', ...opt('email', oneOrMany(b.email)), ...opt('telephone', oneOrMany(b.telephone)) }] : [];
      const places = b.address.map((address) => ({ '@type': 'Place', address }));
      const about = [...point, ...places];
      return { '@type': 'WebPageElement', '@id': ids.page(i ? `contact-${i + 1}` : 'contact'), isPartOf: { '@id': ids.webpage }, about: about.length === 1 ? about[0] : about };
    });
  return { nodes, extend };
};

const opt = (key: string, value: JsonValue | undefined) => (value === undefined ? {} : { [key]: value });

/** Whether a tree shows a component that searches from its page's address, in its own content or a design inside it. */
function treeSearches(state: ProjectState, tree: NodeTree | undefined, seen = new Set<string>()): boolean {
  for (const n of Object.values(tree?.nodes ?? {})) {
    if (n?.kind !== 'instance' || typeof n.definitionId !== 'string' || seen.has(n.definitionId)) continue;
    seen.add(n.definitionId);
    const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
    if (searchesFromAddress(def) || (def?.tree && treeSearches(state, def.tree, seen))) return true;
  }
  return false;
}

/**
 * The page the website's search runs on when it is sent words in the address (`…/search/?q=pots`): the first page in
 * site order that shows a search reading them, in its content or the shared header or footer it shows, preferring one
 * search engines may list. None when no page on the website shows one.
 */
export function searchPageUrl(state: ProjectState, resolver: SeoResolver): string | null {
  let fallback: string | null = null;
  for (const doc of resolver.published()) {
    if (doc.subject.kind !== 'page' || !doc.url) continue;
    const page = state.pages[doc.subject.pageId];
    if (!treeSearches(state, page) && !partsShown(page).some((part) => treeSearches(state, state.site.shell[part]))) continue;
    if (doc.visibility.indexable) return doc.url;
    fallback ??= doc.url;
  }
  return fallback;
}

/** The search page each resolver's project has, worked out once for all the documents it resolves. */
const searchPages = new WeakMap<SeoResolver, string | null>();

/** The website says how to search it, on the page that runs the search. */
const siteSearch: GraphContributor = ({ state, resolver, ids }) => {
  if (!searchPages.has(resolver)) searchPages.set(resolver, searchPageUrl(state, resolver));
  const at = searchPages.get(resolver)!;
  if (!at) return null;
  return {
    extend: [
      {
        id: ids.website,
        set: { potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${at}?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } }
      }
    ]
  };
};

/** What the generated website says about its documents, beyond the graph's own entities. */
export const SITE_CONTRIBUTORS: readonly GraphContributor[] = [homeAbout, revised, blogPosting, pageContent, siteSearch];

/**
 * The resolver of each project state a generator run is working from, while one is (`inGenerationRun`): every page's
 * graph reads the same documents (its breadcrumb trail, the search page), so they are resolved once per run, not once
 * per page. A state never changes while it is generated from; between runs it may (edited in place), so nothing is
 * kept once the run ends.
 */
let runResolvers: WeakMap<ProjectState, SeoResolver> | null = null;

/** Runs `generate` as one generator run, sharing what every document's structured data reads. */
export function inGenerationRun<T>(generate: () => T): T {
  if (runResolvers) return generate();
  runResolvers = new WeakMap();
  try {
    return generate();
  } finally {
    runResolvers = null;
  }
}

function resolverFor(state: ProjectState): SeoResolver {
  if (!runResolvers) return createSeoResolver(state);
  let resolver = runResolvers.get(state);
  if (!resolver) runResolvers.set(state, (resolver = createSeoResolver(state)));
  return resolver;
}

/** The connected graph a generated page or entry carries, or null when it carries none (seo-graph.ts says when). */
export function documentGraph(state: ProjectState, subject: SeoSubject): SeoGraph | null {
  return buildSeoGraph(state, resolverFor(state), subject, SITE_CONTRIBUTORS);
}

/**
 * The graph's script for a generated page or entry, or null when it carries none. In a cached run of the generator
 * it is worked out once per project state, and a page's file depends on this text alone, not on everything the graph
 * read (every page's title and address, for breadcrumbs and the search page), so an edit elsewhere rewrites only the
 * pages whose graph it changes.
 */
export function graphScript(state: ProjectState, subject: SeoSubject): string | null {
  const key = subject.kind === 'page' ? `seo-graph:page:${subject.pageId}` : `seo-graph:entry:${subject.collectionId}:${subject.entryId}`;
  return derived(state, key, (s) => {
    const graph = documentGraph(s, subject);
    return graph ? `<script type="application/ld+json">${graphScriptText(graph)}</script>` : null;
  });
}
