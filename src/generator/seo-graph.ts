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
const ref = (id: string): JsonObject => ({ '@id': id });
/** JSON with object keys in order, so values that differ only in key order are the same value, written the same way. */
const canonical = (v: JsonValue): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: JsonValue, b: JsonValue) => canonical(a) === canonical(b);
const byJson = (a: JsonValue, b: JsonValue) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
const copyOf = <T extends JsonValue>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** A property only when it has a value. */
const opt = (key: string, value: JsonValue | undefined): JsonObject => (value === undefined || value === '' ? {} : { [key]: value });

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
  const language = siteLanguage(site);
  const organization: GraphNode = { '@type': 'Organization', '@id': ids.organization, ...opt('name', name), url: root };
  const website: GraphNode = {
    '@type': 'WebSite',
    '@id': ids.website,
    url: root,
    ...opt('name', name),
    ...opt('description', seoText(site.description)),
    ...opt('inLanguage', isLanguageCode(language) ? language : undefined),
    publisher: ref(ids.organization)
  };
  const webpage: GraphNode = {
    '@type': 'WebPage',
    '@id': ids.webpage,
    url: meta.url!,
    ...opt('name', seoText(meta.title)),
    ...opt('description', seoText(meta.description)),
    ...opt('inLanguage', isLanguageCode(meta.language) ? meta.language : undefined),
    isPartOf: ref(ids.website),
    breadcrumb: ref(ids.breadcrumb),
    ...opt('primaryImageOfPage', meta.imageUrl ? { '@type': 'ImageObject', url: meta.imageUrl } : undefined)
  };
  const breadcrumb: GraphNode = {
    '@type': 'BreadcrumbList',
    '@id': ids.breadcrumb,
    itemListElement: trail(state, resolver, meta, root).map((step, i) => ({ '@type': 'ListItem', position: i + 1, name: step.name, item: step.url }))
  };
  return [organization, website, webpage, breadcrumb];
}

/**
 * What a value says of other entities, at any depth: the ones it refers to (an object with an `@id` and nothing else)
 * and the ones it describes in place (an `@id` with properties of its own).
 */
function mentions(value: JsonValue, out: { refs: string[]; inline: string[] } = { refs: [], inline: [] }) {
  if (Array.isArray(value)) for (const v of value) mentions(v, out);
  else if (value && typeof value === 'object') {
    const id = value['@id'];
    if (typeof id === 'string') (Object.keys(value).length === 1 ? out.refs : out.inline).push(id);
    for (const [k, v] of Object.entries(value)) if (k !== '@id') mentions(v, out);
  }
  return out;
}

const isAbsolute = (id: string) => {
  try {
    const url = new URL(id);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * The connected graph for one document, with what each contributor adds. Null when the document carries no
 * structured data: it is not on the website, search engines are asked not to list it, or the site has no public URL
 * to give its entities addresses; contributors are not asked then.
 *
 * A contribution is refused, with an error naming the contributor, when it would make the graph say two things or
 * say something about nothing: a node without an `@id` and an `@type`, or whose `@id` is not one `ids` makes; an ID
 * the graph or another contributor already has; an extension of a node the graph does not have, of its `@id`, or
 * setting a property to a second value; a reference that is not an absolute address, or to one of the graph's own IDs
 * that no node has; and a node linked to nothing else in the graph.
 */
export function buildSeoGraph(state: ProjectState, resolver: SeoResolver, subject: SeoSubject, contributors: readonly GraphContributor[] = []): SeoGraph | null {
  const meta = resolver.resolve(subject);
  const base = publicUrl(state.site);
  if (!meta?.visibility.jsonLd || !meta.url || !base) return null;
  const root = `${base}/`;
  const ids = graphIds(root, meta.url);
  // One of the IDs `ids` makes: the site's own, or this document's.
  const own = (id: string) => {
    const at = id.lastIndexOf('#');
    return at > 0 && (id.slice(0, at) === root || id.slice(0, at) === meta.url) && FRAGMENT.test(id.slice(at + 1));
  };
  const core = coreNodes(state, resolver, meta, root, ids);
  const nodes = new Map<string, GraphNode>(core.map((n) => [n['@id'], n]));
  const added: GraphNode[] = [];
  const extensions: Array<{ id: string; set?: JsonObject; add?: JsonObject; from: number }> = [];
  contributors.forEach((contribute, from) => {
    const who = `Graph contributor ${from + 1}`;
    const c = contribute({ state, resolver, meta, ids });
    for (const node of c?.nodes ?? []) {
      const id = node?.['@id'];
      if (typeof id !== 'string' || !id || node['@type'] === undefined) throw new Error(`${who} added a node without an @id and an @type.`);
      if (!own(id)) throw new Error(`${who} added ${id}, which is not an ID of this site or document: make it with ids.site or ids.page.`);
      if (core.some((n) => n['@id'] === id)) throw new Error(`${who} added ${id}, which the graph already has: extend it instead.`);
      if (nodes.has(id)) throw new Error(`${who} added ${id}, which another contributor added too.`);
      // A copy, so nothing a contributor keeps can change the graph after it is built.
      const copy = copyOf(node);
      nodes.set(id, copy);
      added.push(copy);
    }
    for (const e of c?.extend ?? []) extensions.push({ ...e, from });
  });
  // Extensions apply once every node is in, so a contributor may extend what another one added. Each property is
  // gathered from every contributor and then written in name order, so the graph is the same whoever came first:
  // every `set`, then every `add`, whose values follow those the node already has, in an order of their own.
  const sets = new Map<JsonObject, Map<string, JsonValue>>();
  const adds = new Map<JsonObject, Map<string, JsonValue[]>>();
  for (const { id, set, add, from } of extensions) {
    const node = nodes.get(id) as JsonObject | undefined;
    if (!node) throw new Error(`Graph contributor ${from + 1} extends ${id}, which the graph does not have.`);
    for (const k of [...Object.keys(set ?? {}), ...Object.keys(add ?? {})]) if (k === '@id' || k === '@context') throw new Error(`Graph contributor ${from + 1} tried to change ${k} of ${id}.`);
    for (const [k, v] of Object.entries(set ?? {})) {
      const pending = sets.get(node) ?? new Map<string, JsonValue>();
      sets.set(node, pending);
      const had = pending.has(k) ? pending.get(k)! : node[k];
      if (had !== undefined && !same(had, v)) throw new Error(`Graph contributor ${from + 1} sets ${k} of ${id}, which already has another value.`);
      pending.set(k, v);
    }
    for (const [k, v] of Object.entries(add ?? {})) {
      const pending = adds.get(node) ?? new Map<string, JsonValue[]>();
      adds.set(node, pending);
      pending.set(k, [...(pending.get(k) ?? []), ...(Array.isArray(v) ? v : [v])]);
    }
  }
  const inOrder = <V>(m: Map<string, V>) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [node, pending] of sets) for (const [k, v] of inOrder(pending)) if (node[k] === undefined) node[k] = copyOf(v);
  for (const [node, pending] of adds)
    for (const [k, values] of inOrder(pending)) {
      const had = node[k] === undefined ? [] : Array.isArray(node[k]) ? (node[k] as JsonValue[]) : [node[k]];
      const more: JsonValue[] = [];
      for (const x of values) if (![...had, ...more].some((y) => same(x, y))) more.push(copyOf(x));
      const next = [...had, ...more.sort(byJson)];
      node[k] = next.length === 1 ? next[0] : next;
    }
  const graph = [...core, ...added.sort((a, b) => (a['@id'] < b['@id'] ? -1 : a['@id'] > b['@id'] ? 1 : 0))];
  // References are absolute addresses, and one to an ID of this graph names a node it has (or one described in place).
  const said = graph.map((node) => ({ id: node['@id'], ...mentions(Object.fromEntries(Object.entries(node).filter(([k]) => k !== '@id'))) }));
  const described = new Set([...nodes.keys(), ...said.flatMap((m) => m.inline)]);
  for (const { id, refs } of said)
    for (const r of refs) {
      if (!isAbsolute(r)) throw new Error(`${id} refers to ${r}, which is not an absolute address.`);
      if (own(r) && !described.has(r)) throw new Error(`${id} refers to ${r}, which the graph does not have.`);
    }
  // Every node is linked, one way or the other, to the graph's own entities.
  const links = new Map<string, Set<string>>([...nodes.keys()].map((id) => [id, new Set<string>()]));
  for (const { id, refs } of said)
    for (const r of refs)
      if (links.has(r)) {
        links.get(id)!.add(r);
        links.get(r)!.add(id);
      }
  const reached = new Set(core.map((n) => n['@id']));
  for (const queue = [...reached]; queue.length; ) for (const next of links.get(queue.pop()!)!) if (!reached.has(next) && reached.add(next)) queue.push(next);
  for (const node of added) if (!reached.has(node['@id'])) throw new Error(`${node['@id']} is linked to nothing else in the graph: refer to it, or have it refer to one of the graph's entities.`);
  return { '@context': SCHEMA_CONTEXT, '@graph': graph };
}

/** The graph as the text of a `<script type="application/ld+json">`: `<` escaped, so no text can end the script. */
export function graphScriptText(graph: SeoGraph): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}
