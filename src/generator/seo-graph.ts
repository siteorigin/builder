/**
 * A document's structured data as one connected Schema.org graph: the organization, local business or person that
 * publishes the site (its identity, shared/site-identity.ts), the website, the page itself and its breadcrumb trail,
 * each with a stable `@id` the others refer to, so search engines and AI answer engines read one set of linked entities
 * rather than separate claims.
 *
 * IDs follow one convention. The site's own entities hang off its public URL (`https://example.com/#organization`, or
 * `#localbusiness` or `#person` for those publishers, and `#website`); a document's hang off its own address (`https://example.com/about/#webpage`, `#breadcrumb`). Features
 * add entities through contributors: a contributor gets those IDs and returns nodes of its own (a BlogPosting whose
 * publisher is `ids.organization`, say) and extensions of nodes already there (a SearchAction on the website). A
 * contribution that would make the graph say two things (an ID used twice, a property set to two values, a reference
 * to a node no one added) is refused with an error, so features cannot collide quietly.
 *
 * The graph is plain JSON with a fixed order: the same project always gives the same bytes.
 */
import type { EntityKind, ProjectState } from '@shared/types';
import type { ArchiveSeo, EffectiveSeo, SeoSubject } from '@shared/seo';
import { seoText } from '@shared/seo';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { isLanguageCode, sameLanguage, siteLanguage } from '@shared/languages';
import { sitePublisher } from '@shared/site-identity';
import { archiveWords } from '@shared/archives';
import { siteArchives } from './archive';
import type { SeoResolver } from './seo-metadata';

export const SCHEMA_CONTEXT = 'https://schema.org';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** One entity of the graph. */
export type GraphNode = JsonObject & { '@id': string; '@type': string | string[] };

/** The IDs of the graph's own entities, and the way to make more of them. */
export interface GraphIds {
  /**
   * Who publishes the site: `#organization`, `#localbusiness` or `#person`, as the site's identity says it is. A
   * feature names the publisher (a BlogPosting's, say) by this ID or `organization`, which is the same one.
   */
  publisher: string;
  /**
   * The publisher's ID, whatever kind it is: the same as `publisher`. Its fragments (`organization`, `localbusiness`,
   * `person`) are the publisher's own: an author or other person a feature adds takes an ID of its own
   * (`ids.site('author-ana')`), and the publisher's logo is the site identity's to set.
   */
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

/** What a graph is built for: a page or an entry the resolver knows, or an archive page the generator writes. */
export type GraphDocument = EffectiveSeo | ArchiveSeo;

export interface GraphContext {
  state: ProjectState;
  resolver: SeoResolver;
  /** The document the graph is for: a page, an entry, or a page of a collection's index or category archive. */
  meta: GraphDocument;
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
/** A copy with object keys in order, so the same value from any contributor is written the same way. */
const ordered = <T extends JsonValue>(v: T): T => JSON.parse(canonical(v)) as T;
/** A property only when it has a value. */
const opt = (key: string, value: JsonValue | undefined): JsonObject => (value === undefined || value === '' ? {} : { [key]: value });

/** The fragment of the publisher's ID for each kind of publisher. */
const PUBLISHER_FRAGMENT: Record<EntityKind, string> = { Organization: 'organization', LocalBusiness: 'localbusiness', Person: 'person' };

/**
 * The IDs for a site whose public URL ends in `root` ("https://example.com/studio/") and a document at `url`, published
 * by a `kind` of entity (an organization when not said).
 */
export function graphIds(root: string, url: string, kind: EntityKind = 'Organization'): GraphIds {
  const id = (at: string, fragment: string) => {
    if (!FRAGMENT.test(fragment)) throw new Error(`“${fragment}” is not a graph ID fragment: lowercase letters, digits and hyphens, starting with a letter.`);
    return `${at}#${fragment}`;
  };
  const publisher = id(root, PUBLISHER_FRAGMENT[kind] ?? 'organization');
  return {
    publisher,
    organization: publisher,
    website: id(root, 'website'),
    webpage: id(url, 'webpage'),
    breadcrumb: id(url, 'breadcrumb'),
    site: (fragment) => id(root, fragment),
    page: (fragment) => id(url, fragment)
  };
}

/** The collection indexes of each resolver's project, worked out once for every entry's trail it resolves. */
const archivesOf = new WeakMap<SeoResolver, ReturnType<typeof siteArchives>>();

/** The trail from the Home page to a document: Home, the published pages its address is inside, its collection's index. */
function trail(state: ProjectState, resolver: SeoResolver, meta: GraphDocument, root: string): Array<{ name: string; url: string }> {
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
  const archives = () => {
    if (!archivesOf.has(resolver)) archivesOf.set(resolver, siteArchives(state));
    return archivesOf.get(resolver)!;
  };
  if (meta.subject.kind === 'entry') {
    const { collectionId } = meta.subject;
    const index = archives().find((a) => a.collectionId === collectionId && a.category === undefined && a.page === 1);
    const name = seoText(state.collections[collectionId]?.settings?.name);
    if (index && name) steps.push({ route: index.route, name });
  }
  // An archive page is inside its collection's index, and a later page of a category's archive inside its first page.
  if (meta.subject.kind === 'archive') {
    const { collectionId, category, page } = meta.subject;
    const above = archives().filter((a) => a.collectionId === collectionId && a.page === 1 && (a.category === undefined || (a.category === category && page > 1)));
    for (const a of above) if (a.route !== meta.route) steps.push({ route: a.route, name: archiveWords(state, a).name });
  }
  steps.sort((a, b) => a.route.length - b.route.length);
  const base = root.replace(/\/$/, '');
  for (const s of steps) out.push({ name: s.name, url: base + routeUrl(s.route) });
  const name =
    meta.subject.kind === 'page'
      ? pageName(meta.subject.pageId)
      : meta.subject.kind === 'archive'
        ? archiveWords(state, meta.subject).name
        : seoText(state.collections[meta.subject.collectionId]?.entries[meta.subject.entryId]?.title);
  out.push({ name: name || meta.title, url: meta.url! });
  return out;
}

/**
 * A library file the website serves: one under static/ and nowhere above it, its name plain enough to be its own
 * address (no escapes, query or fragment). What a damaged record names otherwise is not.
 */
const servedFile = (file: string) => {
  const parts = file.split('/');
  return parts[0] === 'static' && parts.length > 1 && parts.slice(1).every((p) => p && p !== '.' && p !== '..' && !/[\\\0%?#\s]/.test(p));
};

/** Whether an asset ID names a picture in the library, with a file the website serves to link to. */
export const isLibraryImage = (state: ProjectState) => (id: string) => {
  const a = Object.hasOwn(state.assets?.assets ?? {}, id) ? state.assets.assets[id] : undefined;
  return a?.kind === 'image' && typeof a.file === 'string' && servedFile(a.file);
};

/**
 * The publisher, as the site's identity describes it: its kind, its name (the site's, unless it has its own), its home
 * page (this site's, unless it has its own), its logo or photo, its profiles elsewhere and its contact details, and for
 * a local business its hours, prices and place on the map.
 */
function publisherNode(state: ProjectState, root: string, ids: GraphIds): GraphNode {
  const who = sitePublisher(state.site, isLibraryImage(state));
  const logo = who.logo ? `${root}${state.assets.assets[who.logo].file.replace(/^static\//, '')}` : undefined;
  const one = (list: string[]) => (list.length === 1 ? list[0] : list.length ? list : undefined);
  return {
    '@type': who.kind,
    '@id': ids.publisher,
    ...opt('name', seoText(who.name)),
    url: who.url ?? root,
    ...opt(who.kind === 'Person' ? 'image' : 'logo', logo ? { '@type': 'ImageObject', url: logo } : undefined),
    ...opt('sameAs', one(who.sameAs)),
    ...opt('address', who.address),
    ...opt('telephone', who.telephone),
    ...opt('email', who.email),
    ...opt('openingHours', one(who.openingHours)),
    ...opt('priceRange', who.priceRange),
    ...opt('geo', who.geo ? { '@type': 'GeoCoordinates', latitude: who.geo.latitude, longitude: who.geo.longitude } : undefined)
  };
}

/** The graph's own four entities, in their fixed order. */
function coreNodes(state: ProjectState, resolver: SeoResolver, meta: GraphDocument, root: string, ids: GraphIds): GraphNode[] {
  const site = state.site;
  const name = seoText(site.name);
  const language = siteLanguage(site);
  const organization = publisherNode(state, root, ids);
  const website: GraphNode = {
    '@type': 'WebSite',
    '@id': ids.website,
    url: root,
    ...opt('name', name),
    ...opt('description', seoText(site.description)),
    ...opt('inLanguage', isLanguageCode(language) ? language : undefined),
    publisher: ref(ids.publisher)
  };
  const webpage: GraphNode = {
    '@type': 'WebPage',
    '@id': ids.webpage,
    url: meta.url!,
    ...opt('name', seoText(meta.title)),
    ...opt('description', seoText(meta.description)),
    // A page in the site's language says it as the site does, however the page spells it ("EN" on an "en" site).
    ...opt('inLanguage', isLanguageCode(meta.language) ? (sameLanguage(meta.language, language) ? language : meta.language) : undefined),
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
 * What a value says of other entities, at any depth: the ones it refers to (an `@id` with nothing beside it but an
 * `@index`) and the ones it describes in place (an `@id` with anything else: an `@type`, properties, `@nest`, `@reverse`).
 */
function mentions(value: JsonValue, out: { refs: string[]; inline: string[] } = { refs: [], inline: [] }) {
  if (Array.isArray(value)) for (const v of value) mentions(v, out);
  else if (value && typeof value === 'object') {
    const id = value['@id'];
    if (typeof id === 'string' && '@value' in value) throw new Error(`${id} is given a @value: an entity has properties, not a value.`);
    const describes = Object.keys(value).some((k) => k !== '@id' && k !== '@index');
    if (typeof id === 'string') (describes ? out.inline : out.refs).push(id);
    for (const [k, v] of Object.entries(value)) if (k !== '@id') mentions(v, out);
  }
  return out;
}

/**
 * An absolute IRI, written without spaces, backslashes or broken %-escapes: a web address with its host (`https://example.com/#org`), or another scheme
 * (`urn:isbn:…`). A web address the URL parser would have to repair (`https:example.com`) is not one.
 */
const isAbsolute = (id: string) => {
  if (/[\s\\]/.test(id) || /%(?![0-9a-f]{2})/i.test(id) || !/^[a-z][a-z0-9+.-]*:./i.test(id)) return false;
  if (!/^https?:/i.test(id)) return true;
  if (!/^https?:\/\/[^/?#]/i.test(id)) return false;
  try {
    return !!new URL(id).host;
  } catch {
    return false;
  }
};

/** Whether a value holds `@included` anywhere: a contributor adds those entities as nodes of its own instead. */
const includes = (value: JsonValue): boolean =>
  Array.isArray(value) ? value.some(includes) : !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => k === '@included' || includes(v));

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
  return graphOf(state, resolver, resolver.resolve(subject), contributors);
}

/** The connected graph of one page of a collection's index or category archive, as buildSeoGraph builds a page's. */
export function buildArchiveGraph(state: ProjectState, resolver: SeoResolver, meta: ArchiveSeo, contributors: readonly GraphContributor[] = []): SeoGraph | null {
  return graphOf(state, resolver, meta, contributors);
}

function graphOf(state: ProjectState, resolver: SeoResolver, meta: GraphDocument | null, contributors: readonly GraphContributor[]): SeoGraph | null {
  const base = publicUrl(state.site);
  if (!meta?.visibility.jsonLd || !meta.url || !base) return null;
  const root = `${base}/`;
  const ids = graphIds(root, meta.url, sitePublisher(state.site, isLibraryImage(state)).kind);
  // An ID at the site's address or this document's, with a fragment: one of the graph's own, written well or not.
  const local = (id: string) => {
    const at = id.indexOf('#');
    return at > 0 && (id.slice(0, at) === root || id.slice(0, at) === meta.url);
  };
  // One of the IDs `ids` makes.
  const own = (id: string) => local(id) && FRAGMENT.test(id.slice(id.indexOf('#') + 1));
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
      if (includes(node)) throw new Error(`${who} added ${id} with @included entities: add them as nodes of their own.`);
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
    if (includes(set ?? {}) || includes(add ?? {})) throw new Error(`Graph contributor ${from + 1} extends ${id} with @included entities: add them as nodes of their own.`);
    for (const [k, v] of Object.entries(set ?? {})) {
      const pending = sets.get(node) ?? new Map<string, JsonValue>();
      sets.set(node, pending);
      const had = pending.has(k) ? pending.get(k)! : node[k];
      if (had !== undefined && !same(had, v)) throw new Error(`Graph contributor ${from + 1} sets ${k} of ${id}, which already has another value.`);
      pending.set(k, ordered(v));
    }
    for (const [k, v] of Object.entries(add ?? {})) {
      const pending = adds.get(node) ?? new Map<string, JsonValue[]>();
      adds.set(node, pending);
      pending.set(k, [...(pending.get(k) ?? []), ...(Array.isArray(v) ? v : [v]).map(ordered)]);
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
  // An entity is described once: in place in one spot, or as a node of the graph that others refer to.
  const said = graph.map((node) => ({ id: node['@id'], ...mentions(Object.fromEntries(Object.entries(node).filter(([k]) => k !== '@id'))) }));
  const inline = new Map<string, string>();
  for (const { id, inline: described } of said)
    for (const x of described) {
      if (!isAbsolute(x)) throw new Error(`${id} describes ${x}, which is not an absolute address.`);
      if (local(x) && !own(x)) throw new Error(`${id} describes ${x}, which is not an ID of this site or document: make it with ids.site or ids.page.`);
      if (nodes.has(x)) throw new Error(`${id} describes ${x} in place, which the graph already has: refer to it instead.`);
      if (inline.has(x)) throw new Error(`${id} describes ${x}, which ${inline.get(x)} describes too: describe it once and refer to it.`);
      inline.set(x, id);
    }
  for (const { id, refs } of said)
    for (const r of refs) {
      if (!isAbsolute(r)) throw new Error(`${id} refers to ${r}, which is not an absolute address.`);
      if (local(r) && !nodes.has(r) && !inline.has(r)) throw new Error(`${id} refers to ${r}, which the graph does not have.`);
    }
  // Every node is linked, one way or the other, to the graph's own entities: through references, and through the
  // entities nodes describe in place, which are linked to the node that holds them.
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]]) (links.get(x) ?? links.set(x, new Set()).get(x)!).add(y);
  };
  // Only the graph's own entities link nodes: two nodes naming the same address elsewhere are not linked by it.
  for (const { id, refs, inline: described } of said) for (const x of [...refs, ...described]) if (nodes.has(x) || inline.has(x)) link(id, x);
  const reached = new Set(core.map((n) => n['@id']));
  for (const queue = [...reached]; queue.length; ) for (const next of links.get(queue.pop()!) ?? []) if (!reached.has(next) && reached.add(next)) queue.push(next);
  for (const node of added) if (!reached.has(node['@id'])) throw new Error(`${node['@id']} is linked to nothing else in the graph: refer to it, or have it refer to one of the graph's entities.`);
  return { '@context': SCHEMA_CONTEXT, '@graph': graph };
}

/** The graph as the text of a `<script type="application/ld+json">`: `<` escaped, so no text can end the script. */
export function graphScriptText(graph: SeoGraph): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}
