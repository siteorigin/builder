/**
 * The structured data a generated page or collection entry carries: one connected Schema.org graph (seo-graph.ts)
 * with what the website itself says about the document. The Home page is about the site's publisher; an entry says
 * when it was last revised; a page's FAQ makes it an FAQ page with its questions in order, and each contact section
 * it shows is a part of the page with the contact details it gives (who they belong to is not said, since a page can
 * show a venue's box office as well as the publisher's own); and the website says where it can be searched, once a
 * page shows a search that reads the words it is sent in its address.
 *
 * Only what visitors are shown or the author set for the public is written: nothing from the project's private brief
 * or notes.
 */
import type { NodeTree, ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { isArticleDate } from '@shared/articles';
import { partsShown } from '@shared/page-shell';
import { buildSeoGraph, graphScriptText, type GraphContribution, type GraphContributor, type JsonValue, type SeoGraph } from './seo-graph';
import { derived } from './cache';
import { createSeoResolver, type SeoResolver } from './seo-metadata';
import { structuredContent } from './checks';
import { searchesFromAddress } from './search';

/** One value, or several. */
const oneOrMany = (list: string[]): JsonValue | undefined => (list.length === 1 ? list[0] : list.length ? list : undefined);
/** A property only when it has a value. */
/** The Home page is about whoever publishes the site. */
const homeAbout: GraphContributor = ({ state, meta, ids }) => (meta.subject.kind === 'page' && meta.subject.pageId === state.site.homePageId ? { extend: [{ id: ids.webpage, set: { about: { '@id': ids.publisher } } }] } : null);

/** An entry says when it was last revised, when its author says so. A publication date is not a revision. */
const revised: GraphContributor = ({ state, meta, ids }) => {
  if (meta.subject.kind !== 'entry') return null;
  const { collectionId, entryId } = meta.subject;
  const updatedAt = state.collections[collectionId]?.entries[entryId]?.updatedAt;
  return isArticleDate(updatedAt) ? { extend: [{ id: ids.webpage, set: { dateModified: updatedAt } }] } : null;
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

/** The website says how to search it, on the page that runs the search. */
const siteSearch: GraphContributor = ({ state, resolver, ids }) => {
  const at = searchPageUrl(state, resolver);
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
export const SITE_CONTRIBUTORS: readonly GraphContributor[] = [homeAbout, revised, pageContent, siteSearch];

/** The connected graph a generated page or entry carries, or null when it carries none (seo-graph.ts says when). */
export function documentGraph(state: ProjectState, subject: SeoSubject): SeoGraph | null {
  return buildSeoGraph(state, createSeoResolver(state), subject, SITE_CONTRIBUTORS);
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
