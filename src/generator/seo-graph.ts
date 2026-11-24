/**
 * A document's structured data as one connected Schema.org graph: the organization that publishes the site, the
 * website, the page itself and its breadcrumb trail, each with a stable `@id` the others refer to, so search engines
 * and AI answer engines read one set of linked entities rather than separate claims.
 *
 * IDs follow one convention. The site's own entities hang off its public URL (`https://example.com/#organization`,
 * `#website`); a document's hang off its own address (`https://example.com/about/#webpage`, `#breadcrumb`). Features
 * add entities through contributors: a contributor gets those IDs and returns nodes of its own (a BlogPosting whose
 * publisher is `ids.organization`, say) and extensions of nodes already there (a SearchAction on the website). A
 * contribution that would make the graph say two things (an ID used twice, a property set to two values, a reference
 * to a node no one added) is refused with an error, so features cannot collide quietly.
 *
 * The graph is plain JSON with a fixed order: the same project always gives the same bytes.
 */
import type { ProjectState } from '@shared/types';
import type { EffectiveSeo, SeoSubject } from '@shared/seo';
import { seoText } from '@shared/seo';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { isLanguageCode, siteLanguage } from '@shared/languages';
import { siteArchives } from './archive';
import type { SeoResolver } from './seo-metadata';

export const SCHEMA_CONTEXT = 'https://schema.org';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** One entity of the graph. */
export type GraphNode = JsonObject & { '@id': string; '@type': string | string[] };

/** The IDs of the graph's own entities, and the way to make more of them. */
export interface GraphIds {
  organization: string;
  website: string;
  webpage: string;
  breadcrumb: string;
  /** An ID for another entity of the whole site ("localbusiness" gives `https://example.com/#localbusiness`). */
  site(fragment: string): string;
  /** An ID for another entity of this document ("blogposting" gives `https://example.com/blog/hello/#blogposting`). */
  page(fragment: string): string;
}

/** What a contributor adds: entities of its own, and properties for entities already in the graph. */
export interface GraphContribution {
  nodes?: GraphNode[];
  /**
   * `set` gives a property a value: one the node has not got, or the value it already has. `add` puts values into a
   * property that holds several (a second `@type`, more `sameAs` addresses), keeping those already there.
   */
  extend?: Array<{ id: string; set?: JsonObject; add?: JsonObject }>;
}

export interface GraphContext {
  state: ProjectState;
  resolver: SeoResolver;
  /** The document the graph is for. */
  meta: EffectiveSeo;
  ids: GraphIds;
}

/** Adds to a document's graph; returns nothing when it has nothing to say about that document. */
export type GraphContributor = (context: GraphContext) => GraphContribution | null | undefined;

export interface SeoGraph {
  '@context': typeof SCHEMA_CONTEXT;
  '@graph': GraphNode[];
}

const FRAGMENT = /^[a-z][a-z0-9-]*$/;
const ref = (id: string) => ({ '@id': id });
const same = (a: JsonValue, b: JsonValue) => JSON.stringify(a) === JSON.stringify(b);

/** The IDs for a site whose public URL ends in `root` ("https://example.com/studio/") and a document at `url`. */
export function graphIds(root: string, url: string): GraphIds {
  const id = (at: string, fragment: string) => {
    if (!FRAGMENT.test(fragment)) throw new Error(`“${fragment}” is not a graph ID fragment: lowercase letters, digits and hyphens, starting with a letter.`);
    return `${at}#${fragment}`;
  };
  return {
    organization: id(root, 'organization'),
    website: id(root, 'website'),
    webpage: id(url, 'webpage'),
    breadcrumb: id(url, 'breadcrumb'),
    site: (fragment) => id(root, fragment),
    page: (fragment) => id(url, fragment)
  };
}

/** The trail from the Home page to a document: Home, the published pages its address is inside, its collection's index. */
function trail(state: ProjectState, resolver: SeoResolver, meta: EffectiveSeo, root: string): Array<{ name: string; url: string }> {
  const site = state.site;
  const pageName = (id: string) => {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    return seoText(page?.title) || seoText(page?.navLabel) || page?.route || '';
  };
  const home = Object.hasOwn(state.pages, site.homePageId) ? state.pages[site.homePageId] : undefined;
  const out = [{ name: (home && pageName(home.id)) || seoText(site.name) || root, url: root }];
  const here = meta.subject.kind === 'page' ? meta.subject.pageId : null;
  if (here === site.homePageId) return out;
  const route = meta.route.toLowerCase();
  const steps: Array<{ route: string; name: string }> = [];
  for (const doc of resolver.published()) {
    if (doc.subject.kind !== 'page' || doc.subject.pageId === here || doc.subject.pageId === site.homePageId) continue;
    const r = doc.route.toLowerCase();
    if (route.startsWith(r) && r !== route) steps.push({ route: doc.route, name: pageName(doc.subject.pageId) });
  }
  if (meta.subject.kind === 'entry') {
    const { collectionId } = meta.subject;
    const index = siteArchives(state).find((a) => a.collectionId === collectionId && a.category === undefined && a.page === 1);
    const name = seoText(state.collections[collectionId]?.settings?.name);
    if (index && name) steps.push({ route: index.route, name });
  }
  steps.sort((a, b) => a.route.length - b.route.length);
  const base = root.replace(/\/$/, '');
  for (const s of steps) out.push({ name: s.name, url: base + routeUrl(s.route) });
  const name = meta.subject.kind === 'page' ? pageName(meta.subject.pageId) : seoText(state.collections[meta.subject.collectionId]?.entries[meta.subject.entryId]?.title);
  out.push({ name: name || meta.title, url: meta.url! });
  return out;
}

/** The graph's own four entities, in their fixed order. */
function coreNodes(state: ProjectState, resolver: SeoResolver, meta: EffectiveSeo, root: string, ids: GraphIds): GraphNode[] {
  const site = state.site;
  const name = seoText(site.name);
  const named = (n: string) => (n ? { name: n } : {});
  const language = siteLanguage(site);
  const organization: GraphNode = { '@type': 'Organization', '@id': ids.organization, ...named(name), url: root };
  const website: GraphNode = {
    '@type': 'WebSite',
    '@id': ids.website,
    url: root,
    ...named(name),
    ...(seoText(site.description) ? { description: seoText(site.description) } : {}),
    ...(isLanguageCode(language) ? { inLanguage: language } : {}),
    publisher: ref(ids.organization)
  };
  const webpage: GraphNode = {
    '@type': 'WebPage',
    '@id': ids.webpage,
    url: meta.url!,
    ...named(seoText(meta.title)),
    ...(seoText(meta.description) ? { description: seoText(meta.description) } : {}),
    ...(isLanguageCode(meta.language) ? { inLanguage: meta.language } : {}),
    isPartOf: ref(ids.website),
    breadcrumb: ref(ids.breadcrumb),
    ...(meta.imageUrl ? { primaryImageOfPage: { '@type': 'ImageObject', url: meta.imageUrl } } : {})
  };
  const breadcrumb: GraphNode = {
    '@type': 'BreadcrumbList',
    '@id': ids.breadcrumb,
    itemListElement: trail(state, resolver, meta, root).map((step, i) => ({ '@type': 'ListItem', position: i + 1, name: step.name, item: step.url }))
  };
  return [organization, website, webpage, breadcrumb];
}

/** Every `@id` a value refers to, at any depth. */
function references(value: JsonValue, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) references(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '@id' && typeof v === 'string') out.push(v);
      else references(v, out);
    }
  }
  return out;
}

/**
 * The connected graph for one document, with what each contributor adds. Null when the document carries no
 * structured data: it is not on the website, search engines are asked not to list it, it names another address as its
 * own, or the site has no public URL to give its entities addresses.
 */
export function buildSeoGraph(state: ProjectState, resolver: SeoResolver, subject: SeoSubject, contributors: readonly GraphContributor[] = []): SeoGraph | null {
  const meta = resolver.resolve(subject);
  const base = publicUrl(state.site);
  if (!meta?.visibility.jsonLd || !meta.url || !base) return null;
  const root = `${base}/`;
  const ids = graphIds(root, meta.url);
  const core = coreNodes(state, resolver, meta, root, ids);
  const nodes = new Map<string, GraphNode>(core.map((n) => [n['@id'], n]));
  const reserved = new Set(nodes.keys());
  const added: GraphNode[] = [];
  const extensions: Array<{ id: string; set?: JsonObject; add?: JsonObject; from: number }> = [];
  contributors.forEach((contribute, from) => {
    const c = contribute({ state, resolver, meta, ids });
    for (const node of c?.nodes ?? []) {
      const id = node?.['@id'];
      if (typeof id !== 'string' || !id || node['@type'] === undefined) throw new Error(`Graph contributor ${from + 1} added a node without an @id and an @type.`);
      if (reserved.has(id)) throw new Error(`Graph contributor ${from + 1} added ${id}, which the graph already has: extend it instead.`);
      if (nodes.has(id)) throw new Error(`Graph contributor ${from + 1} added ${id}, which another contributor added too.`);
      // A copy, so nothing a contributor keeps can change the graph after it is built.
      const copy = JSON.parse(JSON.stringify(node)) as GraphNode;
      nodes.set(id, copy);
      added.push(copy);
    }
    for (const e of c?.extend ?? []) extensions.push({ ...e, from });
  });
  // Extensions apply once every node is in, so a contributor may extend what another one added: every `set` first,
  // then every `add`, whose values follow those already there in an order of their own, whoever added them.
  const target = (id: string, from: number) => {
    const node = nodes.get(id) as JsonObject | undefined;
    if (!node) throw new Error(`Graph contributor ${from + 1} extends ${id}, which the graph does not have.`);
    return node;
  };
  for (const { id, set, add, from } of extensions)
    for (const k of [...Object.keys(set ?? {}), ...Object.keys(add ?? {})]) if (k === '@id' || k === '@context') throw new Error(`Graph contributor ${from + 1} tried to change ${k} of ${id}.`);
  for (const { id, set, from } of extensions) {
    const node = target(id, from);
    for (const [k, v] of Object.entries(set ?? {})) {
      if (node[k] !== undefined && !same(node[k], v)) throw new Error(`Graph contributor ${from + 1} sets ${k} of ${id}, which already has another value.`);
      node[k] = JSON.parse(JSON.stringify(v)) as JsonValue;
    }
  }
  const additions = new Map<JsonObject, Map<string, JsonValue[]>>();
  for (const { id, add, from } of extensions) {
    const node = target(id, from);
    for (const [k, v] of Object.entries(add ?? {})) {
      const byKey = additions.get(node) ?? new Map<string, JsonValue[]>();
      additions.set(node, byKey);
      byKey.set(k, [...(byKey.get(k) ?? []), ...(Array.isArray(v) ? v : [v])]);
    }
  }
  for (const [node, byKey] of additions)
    for (const [k, values] of byKey) {
      const had = node[k] === undefined ? [] : Array.isArray(node[k]) ? (node[k] as JsonValue[]) : [node[k]];
      const more: JsonValue[] = [];
      for (const x of values) if (![...had, ...more].some((y) => same(x, y))) more.push(JSON.parse(JSON.stringify(x)) as JsonValue);
      const next = [...had, ...more.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))];
      node[k] = next.length === 1 ? next[0] : next;
    }
  const graph = [...core, ...added.sort((a, b) => (a['@id'] < b['@id'] ? -1 : a['@id'] > b['@id'] ? 1 : 0))];
  // A reference to one of the site's own entities must name one the graph has.
  for (const node of graph)
    for (const id of references(Object.fromEntries(Object.entries(node).filter(([k]) => k !== '@id'))))
      if (id.startsWith(root) && id.includes('#') && !nodes.has(id)) throw new Error(`${node['@id']} refers to ${id}, which the graph does not have.`);
  return { '@context': SCHEMA_CONTEXT, '@graph': graph };
}

/** The graph as the text of a `<script type="application/ld+json">`: `<` escaped, so no text can end the script. */
export function graphScriptText(graph: SeoGraph): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}
