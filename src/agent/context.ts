import { axesOf, selectedVariants } from '@shared/variants';
import { agentDiscovery, oneLine } from '@shared/llms';
import { toolOverrides, webMcpOn } from '@shared/webmcp';
import { hasCode } from '@shared/site-code';
import { fathomSiteId } from '@shared/integrations';
import { crawlerRules, storedCrawlerPolicy } from '@shared/crawler-policy';
import type { CollectionFieldSchema, ComponentDefinition, ElementRef, GraphNode, InstanceNode, NodeTree, OwnerRef, PageDoc, ProjectState, PropSchema, SlotDef } from '@shared/types';
import { isBinding, slotChildren } from '@shared/types';
import { partStyleControls } from '@shared/styles';
import { isRichBlock, richTextToMarkdown, type RichPages } from '@shared/richtext';
import { childLists, displayName, enclosingRepeatProp, getTree, subtreeIds } from '@engine/tree';
import { slotDecl } from '@engine/slots';
import { shownSlots } from '@engine/theme-updates';
import { TABLE_LIMITS } from '@engine/table';
import { effectiveTokens, isDraftPage } from '@generator/index';
import { hasDarkPalette } from '@shared/color-scheme';
import { catalogueEntries, getTheme } from '@catalogue/index';
import { hasCollections } from '@shared/entry-feed';
import { collectionHasBody, collectionKind, hasArchivePages, hasDetailPages, inSiteFeed, isSyncedCollection, keptPublishedAddresses, pagesPrefix } from '@shared/collections';
import { teaserFields } from '@shared/page-teasers';
import { pageParents } from '@shared/page-tree';
import { notFoundCopy } from '@shared/not-found';
import { itemStylesOf, liveItemStyles, placementItems, repeatedPartList } from '@shared/item-styles';
import { isLanguageCode, pageLanguage, siteDirection, translationPeers } from '@shared/languages';
import { ownVisitorTextFor } from '@shared/visitor-text';
import { normalizeRoute } from '@shared/routes';
import { seoText } from '@shared/seo';
import { themeUpdateNote, themeUpdatesSummary } from './theme-update';
import { codePartReach, type CodePartTexts } from './scope';
import type { Diagnostic } from '@engine/validate';
import { directDependencies } from '@engine/definitions';
import { showsPart, SHELL_PARTS } from '@shared/page-shell';
import { requiredHint } from '@shared/required';

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const isEntry = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Characters of cell text a table summary shows in all; each cell is cut to its share (4 to 220). */
const TABLE_TEXT_BUDGET = 9000;
/** A table at most this long (as JSON) is shown whole, IDs and all, wherever full props are shown: within a tool result. */
const TABLE_FULL_CHARS = 18000;

/**
 * A table as its column IDs and names, then every row's ID and texts in column order, so any row or column can be
 * addressed by ID. Long cells are cut to fit; a summary that cuts anything says so, and the engine refuses it if
 * it is written back as the whole table.
 */
export function summarizeTable(t: unknown, budget = TABLE_TEXT_BUDGET) {
  if (!isEntry(t)) return t;
  const plain = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const columns = (Array.isArray(t.columns) ? t.columns : []).filter(isEntry).map((c) => ({ id: c.id, label: plain(c.label) }));
  const rowsIn = (Array.isArray(t.rows) ? t.rows : []).filter(isEntry);
  const share = Math.max(4, Math.min(220, Math.floor(budget / Math.max(1, rowsIn.length * columns.length))));
  let clipped = false;
  // Cut by the length the text has in the tool result (quotes and backslashes are escaped there).
  const sized = (s: string) => JSON.stringify(s).length - 2;
  const text = (v: unknown) => {
    let s = plain(v);
    if (sized(s) <= share) return s;
    clipped = true;
    s = clip(s, share);
    while (s.length > 1 && sized(s) > share) s = clip(s, s.length - 1);
    return s;
  };
  const rows = rowsIn.map((r) => ({ id: r.id, cells: columns.map((c) => text(isEntry(r.cells) ? r.cells[String(c.id)] : '')) }));
  if (!clipped) return { columns, rows };
  return {
    columns,
    rows,
    cellsClipped: true,
    note: 'Long cells are shortened here. Change cells, rows or columns by ID with instance.editTable; writing this back as the whole table is refused.'
  };
}

/**
 * A placement's props as the AI reads them. Every table it shows is included, its definition's own when the
 * placement has none, so its rows can be addressed by ID. `full` keeps other values whole and a table whole
 * unless it is very large; otherwise values are summarized.
 */
export function agentProps(def: ComponentDefinition | undefined, props: Record<string, unknown>, pages: RichPages, full = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const schemas = def?.properties ?? {};
  // Every table the placement shows shares one allowance, so together they fit in a tool result.
  const tables = Object.values(schemas).filter((s) => s.type === 'table').length;
  let room = TABLE_FULL_CHARS;
  const table = (v: unknown) => {
    const size = JSON.stringify(v ?? null).length;
    if (full && size <= room) return (room -= size), v;
    return summarizeTable(v, TABLE_TEXT_BUDGET / Math.max(1, tables));
  };
  for (const [k, v] of Object.entries(props)) out[k] = Object.hasOwn(schemas, k) && schemas[k].type === 'table' && !isBinding(v) ? table(v) : full ? v : summarizeValue(v, pages, 1);
  for (const [k, schema] of Object.entries(schemas)) if (schema.type === 'table' && !Object.hasOwn(props, k)) out[k] = table(schema.default);
  return out;
}

/** Rich text longer than this is summarized as a preview; inspect_element with a prop reads it whole. */
const RICH_SUMMARY_CHARS = 1200;

function summarizeValue(v: unknown, pages: RichPages, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, 220);
  if (Array.isArray(v)) {
    // Rich text reads as the same short text form the tools accept.
    if (v.length && v.every(isRichBlock)) {
      const text = richTextToMarkdown(v, pages);
      // Never a shortened string that could be written back as the whole value.
      return text.length <= RICH_SUMMARY_CHARS
        ? text
        : { truncated: true, chars: text.length, preview: clip(text, 400), note: 'Shortened here. Read it whole with inspect_element, naming its prop (with itemId and field for a list item), before changing it; never write the preview back.' };
    }
    // A form field's choices are read whole, ids and all: a shortened set written back would drop the rest.
    const choices = v.every((x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.label === 'string' && typeof x.value === 'string');
    if (choices) return v.map((x) => summarizeValue(x, pages, depth + 1));
    if (depth > 2) return `[${v.length} items]`;
    return v.slice(0, 12).map((x) => summarizeValue(x, pages, depth + 1));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = summarizeValue(x, pages, depth + 1);
    return out;
  }
  return v;
}

/** A page's own language and the IDs of its translations, when it has them: pages without use the site language. */
function pageLanguageSummary(state: ProjectState, p: PageDoc): { language?: string; translations?: string[] } {
  const peers = translationPeers(state, p);
  return { ...(isLanguageCode(p.language) ? { language: p.language } : {}), ...(peers.length ? { translations: peers.map((t) => t.id) } : {}) };
}

/** The pieces of visitor text with the author's own wording, by language, or nothing when there are none. */
function visitorTextSummary(state: ProjectState): { visitorTextSet?: Record<string, string[]> } {
  const all = state.site.visitorText;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return {};
  const set = Object.fromEntries(
    Object.keys(all)
      .filter(isLanguageCode)
      .map((code) => [code.toLowerCase(), Object.keys(ownVisitorTextFor(state.site, code))] as const)
      .filter(([, keys]) => keys.length)
  );
  return Object.keys(set).length ? { visitorTextSet: set } : {};
}

/** Whether a site setting names an image the library has, as the website's icon and sharing image must. */
const libraryHasImage = (state: ProjectState, id: unknown) => typeof id === 'string' && Object.hasOwn(state.assets.assets, id) && state.assets.assets[id]?.kind === 'image';

/**
 * The site's own sharing image and icon (whether it has them) and how many old addresses it keeps. What the audit
 * makes of them, and of everything else, is audit_seo's to say.
 */
function siteSeoSummary(state: ProjectState) {
  const redirects = (Array.isArray(state.site.redirects) ? state.site.redirects.length : 0) + keptPublishedAddresses(state).length;
  return { socialImageSet: libraryHasImage(state, state.site.socialImage), faviconSet: libraryHasImage(state, state.site.favicon), ...(redirects ? { redirectCount: redirects } : {}) };
}

/**
 * A page's own search settings, only those it has: a browser title or description of its own (else the defaults are
 * used), and whether it is kept from search engines or from the site's own search. Nothing when it has none, so a
 * site with many pages stays small; read_page shows the words.
 */
function pageSeoSummary(p: PageDoc): { seo?: Record<string, true> } {
  const seo = p.seo && typeof p.seo === 'object' ? p.seo : {};
  // Read as the website reads them (generator/seo-metadata.ts): any value that is set keeps the page out.
  const flags = { titleSet: !!seoText(seo.title), descriptionSet: !!seoText(seo.description), noindex: !!seo.noindex, searchHidden: !!seo.searchHidden };
  const set = Object.fromEntries(Object.entries(flags).filter(([, on]) => on)) as Record<string, true>;
  return Object.keys(set).length ? { seo: set } : {};
}

/** Models often pass a route ("/about/") where a page ID is expected; both find the page. */
export function pageIdFor(state: ProjectState, ref: string): string | null {
  if (Object.hasOwn(state.pages, ref)) return ref;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // "/about", "about/" or an address in another script as a browser shows it, spelled as routes are stored.
  const route = normalizeRoute(trimmed);
  return Object.values(state.pages).find((p) => p?.route === route)?.id ?? null;
}

/**
 * The site's agentic discovery settings, only while they differ from the defaults (llms.txt on, the full text and
 * Markdown copies off, the summary taken from the description), so a site that left them alone stays small.
 */
function agentDiscoverySummary(site: ProjectState['site']): { agentDiscovery?: Record<string, unknown> } {
  const { llmsTxt, llmsFull, markdownMirrors } = agentDiscovery(site);
  const summary = oneLine(site.llmsSummary);
  const webmcp = webMcpOn(site);
  if (llmsTxt && !llmsFull && !markdownMirrors && !summary && !webmcp) return {};
  return { agentDiscovery: { llmsTxt, llmsFull, markdownMirrors, ...(summary ? { summary } : {}), ...(webmcp ? { webmcp } : {}) } };
}

/**
 * The site's own code and integrations, only while it has some: how long each piece of code is (read_project with the
 * siteCode section gives it in full) and each integration's settings.
 */
function siteCodeSummary(site: ProjectState['site']): { siteCode?: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  if (hasCode(site.headCode)) out.headCode = { characters: site.headCode.length };
  if (hasCode(site.globalCss)) out.globalCss = { characters: site.globalCss.length };
  const fathom = fathomSiteId(site);
  if (fathom) out.integrations = { fathom: { siteId: fathom } };
  return Object.keys(out).length ? { siteCode: out } : {};
}

/** The site's crawler policy as the website follows it, only while it differs from the default (every crawler let in). */
function crawlerPolicySummary(site: ProjectState['site']): { crawlerPolicy?: ReturnType<typeof storedCrawlerPolicy> } {
  const policy = storedCrawlerPolicy(crawlerRules(site));
  return policy ? { crawlerPolicy: policy } : {};
}

export function projectSummary(state: ProjectState, revision: number) {
  const theme = getTheme(state.site.themeId);
  // The page each page is inside, by route (see shared/page-tree.ts).
  const parents = pageParents(Object.values(state.pages));
  return {
    revision,
    site: {
      name: state.site.name,
      description: state.site.description,
      language: state.site.language,
      // Which way its text runs, and whether that is the author's choice or follows the language.
      direction: { runs: siteDirection(state.site), automatic: state.site.direction !== 'ltr' && state.site.direction !== 'rtl' },
      baseUrl: state.site.baseUrl ?? null,
      seo: siteSeoSummary(state),
      // Who publishes the site, as its pages tell search engines (site.update identity changes it).
      ...(state.site.identity ? { identity: state.site.identity } : {}),
      notFoundPage: notFoundCopy(state.site),
      // What the website offers AI agents beside its pages (site.update llmsTxt, llmsFull, markdownMirrors, llmsSummary, webmcp).
      ...agentDiscoverySummary(state.site),
      // Which crawlers robots.txt keeps out, as the website reads the policy, once it differs from the default (site.update crawlerPolicy).
      ...crawlerPolicySummary(state.site),
      // Which pieces of visitor text have the author's own wording, by language; their words are not repeated here.
      ...visitorTextSummary(state),
      // The site's own head code and CSS, and its integrations (site.update headCode, globalCss, integrations).
      ...siteCodeSummary(state.site)
    },
    theme: { id: theme.id, name: theme.name },
    homePageId: state.site.homePageId,
    pages: state.site.pageOrder.map((id) => {
      const p = state.pages[id];
      const parent = parents.get(id);
      return { id, title: p.title, route: p.route, ...(parent ? { parentPageId: parent } : {}), sections: p.rootIds.length, showHeader: p.showHeader, showFooter: p.showFooter, ...(isDraftPage(state, p) ? { draft: true } : {}), ...pageLanguageSummary(state, p), ...pageSeoSummary(p), ...(p.article ? { article: p.article } : {}) };
    }),
    shell: {
      header: state.site.shell.header.rootIds.map((id) => compactNode(state, state.site.shell.header, id)),
      footer: state.site.shell.footer.rootIds.map((id) => compactNode(state, state.site.shell.footer, id))
    },
    projectComponents: Object.values(state.components)
      .filter((d) => d.owner === 'project')
      .map((d) => ({ definitionId: d.id, name: d.name, kind: d.kind, description: d.description })),
    // Installed theme components the theme has a newer version of: what each adds, and whether this project can take it.
    ...withThemeUpdates(state),
    // What each collection holds and how it is shaped: what a post section, a connected list or a loop can name.
    ...(hasCollections(state) ? { collections: collectionsSummary(state) } : {}),
    // The external sources the author connected, by ID: what the source tools read and write (#680).
    ...(Object.keys(state.sources ?? {}).length ? { sources: sourcesSummary(state) } : {}),
    assets: Object.keys(state.assets.assets).length
  };
}

/**
 * The theme updates of the components placed inside a selected node, other than its own (which it is told about apart),
 * under themeUpdatesInside: a selected wrapper's update note says nothing of the section it holds.
 */
function updatesInside(state: ProjectState, tree: NodeTree, nodeId: string, own: string | undefined): { themeUpdatesInside?: Record<string, unknown> } {
  if (!Object.hasOwn(tree.nodes, nodeId)) return {};
  const placed = new Set(subtreeIds(tree, nodeId).flatMap((id) => (tree.nodes[id]?.kind === 'instance' ? [(tree.nodes[id] as { definitionId: string }).definitionId] : [])));
  placed.delete(own ?? '');
  if (!placed.size) return {};
  const u = themeUpdatesSummary(state, (id) => placed.has(id));
  return u ? { themeUpdatesInside: u } : {};
}

/** The project's theme updates, under themeUpdates, while it has any; `only` narrows them to some definitions. */
export function withThemeUpdates(state: ProjectState, only?: (definitionId: string) => boolean): { themeUpdates?: Record<string, unknown> } {
  const u = themeUpdatesSummary(state, only);
  return u ? { themeUpdates: u } : {};
}

/** A collection's custom field as the assistant reads it: its type, label, and what it takes (options, the collection it names). */
function collectionFieldSummary(name: string, f: CollectionFieldSchema) {
  // A document edited by hand can hold anything: what cannot be read is left out, never read as a field.
  if (!f || typeof f !== 'object') return null;
  return {
    name,
    type: f.type,
    label: f.label,
    ...(f.required ? { required: true } : {}),
    ...(f.type === 'enum' ? { options: (Array.isArray(f.options) ? f.options : []).flatMap((o) => (o && typeof o === 'object' && typeof o.value === 'string' ? [o.value] : [])) } : {}),
    ...(f.type === 'reference' ? { collection: f.collection, ...(f.multiple ? { multiple: true } : {}) } : {})
  };
}

/**
 * Each collection by ID: what it holds (kind, what one entry is called), the pages the site has for it and its address,
 * how many entries it has and publishes, its custom fields, and every grouping with its terms' IDs and names. One synced
 * from an external source says so: its entries are read-only until it is detached in the editor.
 */
export function collectionsSummary(state: ProjectState) {
  return Object.keys(state.collections)
    .sort()
    .map((id) => {
      const c = state.collections[id];
      const s = c.settings;
      const entries = Object.values(c.entries ?? {});
      const taxonomies = Object.fromEntries(Object.entries(s?.taxonomies && typeof s.taxonomies === 'object' ? s.taxonomies : {}).map(([t, tax]) => [t, { label: tax?.label, terms: Object.fromEntries(Object.entries(tax?.terms && typeof tax.terms === 'object' ? tax.terms : {}).map(([k, v]) => [k, v?.label])) }]));
      const fields = Object.entries(s?.fields && typeof s.fields === 'object' ? s.fields : {}).flatMap(([name, f]) => collectionFieldSummary(name, f) ?? []);
      return {
        id,
        name: s?.name,
        kind: collectionKind(s),
        ...(s?.singularName ? { singularName: s.singularName } : {}),
        pages: { detail: hasDetailPages(s), archive: hasArchivePages(s) },
        // Its index has a layout of its own (read_layout reads it), in place of the ready-made cards.
        ...(hasArchivePages(s) && s?.archiveTemplate && typeof s.archiveTemplate === 'object' ? { indexLayout: 'custom' } : {}),
        ...(pagesPrefix(c) !== undefined ? { route: pagesPrefix(c) } : {}),
        ...(!collectionHasBody(s) ? { hasBody: false } : {}),
        // Its entries are in the site's RSS feed: they have pages, and it says so or its kind does.
        inRss: hasDetailPages(s) && inSiteFeed(s),
        // Its entries come from an external source: they are read-only until the author detaches it in the editor.
        ...(isSyncedCollection(s) ? { sourceId: s.sourceId, readOnly: true } : {}),
        entries: entries.length,
        published: entries.filter((e) => e?.draft === false).length,
        ...(fields.length ? { fields } : {}),
        taxonomies
      };
    });
}

/**
 * The external sources the project has, by ID: which collection each is synced into and how it reads its records now.
 * Never where a source is read or which secrets it signs in with, nor its name (settings edited outside the app can
 * hold anything there): inspect_source_sample gives that once its settings are checked.
 */
export function sourcesSummary(state: ProjectState) {
  return Object.keys(state.sources ?? {})
    .sort()
    .map((id) => {
      const s = state.sources![id];
      return { sourceId: id, kind: s.adapter, collectionId: s.collectionId, readsWith: s.converter ? 'converter' : s.mapping ? 'mapping' : 'its kind of source’s own reading' };
    });
}

/** For a selection edit: what the run needs to know about the site, without the header and footer trees. */
export function compactProjectSummary(state: ProjectState, revision: number) {
  return {
    revision,
    site: { name: state.site.name },
    pages: state.site.pageOrder.map((id) => ({ id, title: state.pages[id].title, route: state.pages[id].route, ...(isDraftPage(state, state.pages[id]) ? { draft: true } : {}) }))
  };
}

/** One slot of a placement as the AI reads it, under the name to send as `slot`. */
interface SlotInfo {
  label: string;
  description?: string;
  /** How many children the placement put there; a design's fallback may show while there are none. */
  count: number;
  childIds?: string[];
  /** Only for a restricted slot: it takes any of its categories, componentIds or primitives, at most `max`. */
  contract?: Pick<SlotDef, 'categories' | 'componentIds' | 'primitives' | 'max'> & { moreComponentIds?: number };
}

/** Most component IDs a contract lists here: a slot may name 50, and `moreComponentIds` counts the rest. */
const SLOT_COMPONENT_IDS_SHOWN = 8;

function slotContract({ categories, componentIds, primitives, max }: SlotDef): SlotInfo['contract'] {
  const more = (componentIds?.length ?? 0) - SLOT_COMPONENT_IDS_SHOWN;
  // An empty list is a restriction too (with the others empty, the slot takes nothing).
  const set = Object.entries({
    categories,
    componentIds: componentIds?.slice(0, SLOT_COMPONENT_IDS_SHOWN),
    moreComponentIds: more > 0 ? more : undefined,
    primitives,
    max
  }).filter(([, v]) => v !== undefined);
  return set.length ? Object.fromEntries(set) : undefined;
}

/**
 * Every declared slot a placement shows, empty ones included, which the placement itself stores nothing for. A design
 * shows the slots it places (see shownSlots); code renders its own, so all it declares. A declaration damaged by hand
 * is left out, as everywhere else: validation reports it.
 */
function placementSlots(state: ProjectState, tree: NodeTree, n: InstanceNode): Array<[string, SlotInfo & { childIds: string[] }]> {
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  const names = Object.keys(def?.slots ?? {});
  if (!def || !names.length) return [];
  const shown = def.kind === 'code' ? null : def.tree ? shownSlots(def, n, tree) : new Set<string>();
  return names.flatMap((name): Array<[string, SlotInfo & { childIds: string[] }]> => {
    const decl = !shown || shown.has(name) ? slotDecl(state, n, name) : undefined;
    if (!decl) return [];
    const childIds = slotChildren(n, name);
    const description = decl.description?.trim();
    const contract = slotContract(decl);
    return [[name, { label: decl.label, ...(description ? { description: clip(description) } : {}), count: childIds.length, childIds, ...(contract ? { contract } : {}) }]];
  });
}

/** The `slotInfo` objects compactNode has made, told apart from anything an author named that. */
const slotSummaries = new WeakSet<object>();

/** A JSON.stringify replacer that leaves those out, and nothing else. */
export const withoutSlotInfo = (_key: string, value: unknown) => (value && typeof value === 'object' && slotSummaries.has(value) ? undefined : value);

export function compactNode(state: ProjectState, tree: NodeTree, id: string, depth = 0): Record<string, unknown> {
  const n = tree.nodes[id];
  if (!n) return { id, missing: true };
  const base: Record<string, unknown> = { id: n.id, name: displayName(state, n) };
  switch (n.kind) {
    case 'instance': {
      const def = state.components[n.definitionId];
      base.kind = 'instance';
      base.component = def?.name;
      base.componentId = def?.componentId;
      base.definitionId = n.definitionId;
      if (def?.owner === 'project') base.projectOwned = true;
      if (def?.variantAxes) base.variants = selectedVariants(def, n.variants);
      base.props = agentProps(def, n.props, state.pages);
      if (n.overrides) base.styleOverrides = n.overrides;
      if (n.itemOverrides) base.itemStyleOverrides = n.itemOverrides;
      if (n.appear) base.appear = n.appear;
      // A contact form's own WebMCP tool name and description (node.setContent webmcpToolName / webmcpToolDescription).
      const tool = toolOverrides(n);
      if (tool.toolName || tool.toolDescription) base.webmcp = Object.fromEntries(Object.entries(tool).filter(([, v]) => v));
      const nested = depth < 4;
      const info = placementSlots(state, tree, n);
      // Where the children follow in `slots` they name themselves; past that depth their IDs are listed here.
      if (info.length) {
        const summary = Object.fromEntries(info.map(([name, { childIds, ...slot }]) => [name, nested ? slot : { ...slot, childIds }]));
        slotSummaries.add(summary);
        base.slotInfo = summary;
      }
      if (n.slots && nested) base.slots = Object.fromEntries(Object.keys(n.slots).map((k) => [k, slotChildren(n, k).map((c) => compactNode(state, tree, c, depth + 1))]));
      break;
    }
    case 'element':
      base.kind = 'element';
      base.tag = n.tag;
      if (n.carousel) base.carousel = true;
      if (n.interactionGroup) base.interactionGroup = true;
      if (n.overlay) base.overlay = n.overlay;
      if (n.styles) base.styles = n.styles;
      if (n.appear) base.appear = n.appear;
      if (depth < 5) base.children = n.children.map((c) => compactNode(state, tree, c, depth + 1));
      break;
    case 'text':
      base.kind = 'text';
      base.tag = n.tag;
      base.text = isBinding(n.text) ? n.text : summarizeValue(n.text, state.pages);
      if (n.styles) base.styles = n.styles;
      break;
    case 'image':
      base.kind = 'image';
      base.image = n.image;
      if (n.styles) base.styles = n.styles;
      break;
    case 'link':
      base.kind = 'button';
      base.label = n.label;
      base.link = n.link;
      base.appearance = n.appearance;
      // A button that changes the component's UI state works without a destination.
      if (n.stateAction) base.stateAction = n.stateAction;
      break;
    default:
      base.kind = n.kind;
  }
  return base;
}

export function pageDetail(state: ProjectState, pageId: string) {
  const p = state.pages[pageId];
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    route: p.route,
    seo: p.seo,
    ...(p.updatedAt !== undefined ? { updatedAt: p.updatedAt } : {}),
    showHeader: p.showHeader,
    showFooter: p.showFooter,
    ...(isDraftPage(state, p) ? { draft: true } : {}),
    language: pageLanguage(state.site, p),
    ...(translationPeers(state, p).length ? { translations: translationPeers(state, p).map((t) => ({ id: t.id, title: t.title, route: t.route, language: pageLanguage(state.site, t) })) } : {}),
    // A dated article: News lists show it by this date, with its byline and excerpt.
    ...(p.article ? { article: p.article } : {}),
    owner: { kind: 'page', id: p.id },
    sections: p.rootIds.map((id) => compactNode(state, p, id))
  };
}

/** A document's words, when they are words: a hand-edited file can hold anything. */
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A collection's layout as a run reads it: its entry pages' layout (template) or its index layout (archive). */
export function layoutTree(state: ProjectState, owner: { kind: 'template' | 'archive'; id: string }): NodeTree | null {
  const c = Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id] : undefined;
  const tree = owner.kind === 'archive' ? c?.settings.archiveTemplate : c?.settings.template;
  return tree && Array.isArray(tree.rootIds) && tree.nodes ? tree : null;
}

/**
 * A collection's layout as read_layout and a layout run's context show it: its owner, what it is for, and its sections
 * as read_page shows a page's (with `nodeId`, that node's subtree alone). Null when the layout or node is gone.
 */
export function layoutDetail(state: ProjectState, owner: { kind: 'template' | 'archive'; id: string }, nodeId?: string): Record<string, unknown> | null {
  const tree = layoutTree(state, owner);
  if (!tree) return null;
  if (nodeId !== undefined) return Object.hasOwn(tree.nodes, nodeId) ? { owner, node: compactNode(state, tree, nodeId) } : null;
  const c = state.collections[owner.id];
  return {
    owner,
    collectionId: owner.id,
    // The entry layout shows one entry, which its elements read with { $entry: field }; the index lists entries.
    layout: owner.kind === 'archive' ? `the index of ${text(c.settings.name) || owner.id}: a collection loop over { "$archive": true } repeats once for each entry the page lists` : `every ${text(c.settings.singularName) || text(c.settings.name) || owner.id} entry's page`,
    sections: tree.rootIds.map((id) => compactNode(state, tree, id))
  };
}

/**
 * A layout run's first look at its layout (#679): the layout whole, with the collection whose entries it shows, while it
 * fits `maxChars`; else each section by its ID, kind and name, and the collection's groupings by ID, which read_layout
 * (with a nodeId) and read_project read whole.
 */
export function layoutGlance(state: ProjectState, owner: { kind: 'template' | 'archive'; id: string }, label: string, maxChars: number, indent?: number): Record<string, unknown> {
  const collection = collectionsSummary(state).find((c) => c.id === owner.id) ?? null;
  const whole = { ...layoutDetail(state, owner), label, collection };
  if (JSON.stringify(whole, null, indent).length <= maxChars) return whole;
  const tree = layoutTree(state, owner);
  const sections = (tree?.rootIds ?? []).map((id) => {
    const n = tree!.nodes[id];
    if (!n) return { id, missing: true };
    return { id, kind: n.kind, name: displayName(state, n), ...(n.kind === 'instance' ? { componentId: state.components[n.definitionId]?.componentId } : {}) };
  });
  const shortened = 'Too long to show whole here: read_layout with a section\'s nodeId reads it whole, and read_project its collection.';
  const brief = collection ? { id: collection.id, name: collection.name, kind: collection.kind, fields: (collection.fields ?? []).map((f) => `${f.name}:${f.type}`), taxonomies: Object.keys(collection.taxonomies) } : null;
  // Still too long: as many sections as fit, the rest counted, so the request always fits beside its tools.
  const glance = (shown: number) => ({ owner, collectionId: owner.id, label, ...(brief ? { collection: brief } : {}), sections: sections.slice(0, shown), ...(sections.length > shown ? { omittedSections: sections.length - shown } : {}), shortened });
  let shown = sections.length;
  while (shown > 0 && JSON.stringify(glance(shown), null, indent).length > maxChars) shown = Math.floor(shown / 2);
  const fitted = glance(shown);
  // A collection with too many fields for even that: the owner alone, and how many sections there are.
  if (JSON.stringify(fitted, null, indent).length <= maxChars) return fitted;
  return { owner, collectionId: owner.id, label, sectionCount: sections.length, shortened };
}

/** Most sections a request's first look at its page lists; the rest are counted. */
const GLANCE_SECTIONS = 12;
/** Characters of the text a section's glance shows. */
const GLANCE_TEXT_CHARS = 64;
/** Props read first for a section's text: the words that name it. */
const GLANCE_TEXT_FIRST = ['heading', 'title', 'headline', 'eyebrow', 'lead', 'subheading', 'text', 'body'];

/** Characters of `<editor_context>` a page's sections may take for a model with this window: an eighth of it, at most 4096. */
export const pageGlanceChars = (contextWindowTokens: number) => Math.max(0, Math.min(4096, Math.floor(contextWindowTokens / 8)));

/** A placement as a glance names it, as the page tool does: a theme component by its catalogue ID, a project's own by its definition. */
function glanceInstance(state: ProjectState, id: string, n: InstanceNode): { id: string; componentId: string; name?: string } {
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  return def && def.owner !== 'project' && def.componentId ? { id, componentId: def.componentId } : { id, componentId: n.definitionId, ...(def ? { name: def.name } : {}) };
}

/** One root of a page, briefly: what it is, the words that name it and how many items its lists hold. */
function sectionGlance(state: ProjectState, tree: NodeTree, id: string, texts: boolean): Record<string, unknown> {
  const n = tree.nodes[id];
  if (!n) return { id, missing: true };
  if (n.kind !== 'instance') {
    const text = texts && n.kind === 'text' && typeof n.text === 'string' && n.text.trim() ? { text: clip(n.text.trim().replace(/\s+/g, ' '), GLANCE_TEXT_CHARS) } : {};
    return { id, kind: n.kind, name: displayName(state, n), ...text };
  }
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  const out: Record<string, unknown> = glanceInstance(state, id, n);
  if (!texts || !def) return out;
  const value = (prop: string) => (Object.hasOwn(n.props, prop) ? n.props[prop] : def.properties[prop]?.default);
  const props = Object.keys(def.properties);
  const ordered = [...GLANCE_TEXT_FIRST.filter((p) => props.includes(p)), ...props.filter((p) => !GLANCE_TEXT_FIRST.includes(p))];
  const words = ordered
    .filter((p) => def.properties[p].type === 'string')
    .map((p) => value(p))
    .find((v): v is string => typeof v === 'string' && !!v.trim());
  // A computed list (a News feed, say) fills itself from the site: what it stores says nothing of what it shows.
  const lists = props
    .filter((p) => { const schema = def.properties[p]; return schema.type === 'list' && !schema.feed && Array.isArray(value(p)); })
    .slice(0, 2)
    .map((p) => ({ prop: p, items: (value(p) as unknown[]).length }));
  return { ...out, ...(words ? { text: clip(words.trim().replace(/\s+/g, ' '), GLANCE_TEXT_CHARS) } : {}), ...(lists.length ? { lists } : {}) };
}

/** A placement with slots among a page's shown sections: a section itself, or one anywhere inside it. */
interface SlottedPlacement {
  section: number;
  /** 0 for the section itself. */
  depth: number;
  /** What a nested one's row says: which placement it is, and what holds it. */
  row: Record<string, unknown>;
  slots: ReturnType<typeof placementSlots>;
}

/** The placements with slots in a page's first `shown` sections, in document order. */
function slottedPlacements(state: ProjectState, tree: NodeTree, rootIds: readonly string[]): SlottedPlacement[] {
  const out: SlottedPlacement[] = [];
  const seen = new Set<string>();
  const walk = (id: string, section: number, depth: number, holder: Record<string, unknown>) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'instance') {
      const slots = placementSlots(state, tree, n);
      if (slots.length) out.push({ section, depth, row: { ...glanceInstance(state, id, n), ...holder }, slots });
    }
    for (const list of childLists(n)) list.ids.forEach((c) => walk(c, section, depth + 1, { parentId: id, ...(list.slot !== undefined ? { slot: list.slot } : {}) }));
  };
  rootIds.forEach((id, section) => walk(id, section, 0, {}));
  return out;
}

/** How much a glance says of each slot, most first. */
const SLOT_DETAIL = ['all', 'noDescriptions', 'noIds'] as const;

function glanceSlots(slots: SlottedPlacement['slots'], detail: (typeof SLOT_DETAIL)[number]): Record<string, unknown> {
  return Object.fromEntries(
    slots.map(([name, { description, childIds, ...slot }]) => [name, { ...slot, ...(detail === 'all' && description ? { description } : {}), ...(detail !== 'noIds' ? { childIds } : {}) }])
  );
}

/** `sections` with the slots of `placements`: a section's own on it, those inside it in its `instances`. */
function sectionsWithSlots(sections: Array<Record<string, unknown>>, placements: SlottedPlacement[], detail: (typeof SLOT_DETAIL)[number]): Array<Record<string, unknown>> {
  const out = sections.map((s) => ({ ...s }));
  const nested = out.map((): unknown[] => []);
  for (const p of placements) {
    const slotInfo = glanceSlots(p.slots, detail);
    if (!p.depth) out[p.section].slotInfo = slotInfo;
    else nested[p.section].push({ ...p.row, slotInfo });
  }
  nested.forEach((rows, i) => {
    if (rows.length) out[i].instances = rows;
  });
  return out;
}

/** Placements tried one by one when not all fit: far more than the largest glance can hold. */
const SLOT_PLACEMENTS_TRIED = 100;

/**
 * The page a request starts on, as a short list of its sections in order: enough to tell an empty page, a starter
 * banner and a built page apart, and to name a section by ID, without reading the page first. It fits in `maxChars`
 * of JSON (as `indent` writes it): each section's text and list sizes go first, then sections from the end, which
 * `omittedSections` counts. read_page shows any of it whole.
 *
 * With `withSlots`, each placement in those sections also reports the slots it shows, empty ones too, in whatever
 * room there is: never at the cost of a section listed without them. To fit, the texts go first, then the slots'
 * descriptions, then their child IDs (the counts stay), then whole placements, the deepest first; anything left out
 * of the slots is flagged by `slotDetailsOmitted`.
 */
export function pageGlance(state: ProjectState, pageId: string, maxChars: number, indent?: number, withSlots = true): Record<string, unknown> | null {
  const p = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : null;
  if (!p) return null;
  const head = { id: p.id, title: p.title, route: p.route };
  const build = (shown: number, texts: boolean) => ({
    ...head,
    sections: p.rootIds.slice(0, shown).map((id) => sectionGlance(state, p, id, texts)),
    ...(p.rootIds.length > shown ? { omittedSections: p.rootIds.length - shown } : {})
  });
  const fits = (v: unknown) => JSON.stringify(v, null, indent).length <= maxChars;
  let shown = Math.min(GLANCE_SECTIONS, p.rootIds.length);
  let plain = build(shown, true);
  let bare = plain;
  if (!fits(plain)) {
    plain = bare = build(shown, false);
    while (!fits(plain) && shown > 0) plain = bare = build(--shown, false);
    if (!fits(plain)) return null;
  } else bare = build(shown, false);
  const placements = withSlots ? slottedPlacements(state, p, p.rootIds.slice(0, shown)) : [];
  if (!placements.length) return plain;
  const enriched = (base: ReturnType<typeof build>, some: SlottedPlacement[], detail: (typeof SLOT_DETAIL)[number], omitted: boolean) => ({
    ...base,
    sections: sectionsWithSlots(base.sections, some, detail),
    ...(omitted ? { slotDetailsOmitted: true } : {})
  });
  /** The fullest way these placements fit, or null: the words and everything, then less. */
  const fullest = (some: SlottedPlacement[], partial: boolean) => {
    for (const [base, detail] of [[plain, 'all'], ...SLOT_DETAIL.map((d) => [bare, d] as const)] as const) {
      const out = enriched(base, some, detail, partial || detail !== 'all');
      if (fits(out)) return out;
    }
    return null;
  };
  const whole = fullest(placements, false);
  if (whole) return whole;
  // A placement lists all its slots or none, so a list never passes for complete when it is not.
  const kept = new Set<SlottedPlacement>();
  for (const next of [...placements].sort((a, b) => a.depth - b.depth).slice(0, SLOT_PLACEMENTS_TRIED)) {
    if (fits(enriched(bare, placements.filter((x) => x === next || kept.has(x)), 'noIds', true))) kept.add(next);
  }
  if (kept.size) return fullest(placements.filter((x) => kept.has(x)), true);
  return [plain, bare].map((base) => ({ ...base, slotDetailsOmitted: true })).find(fits) ?? plain;
}

export function propSchemaSummary(schema: Record<string, PropSchema>) {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(schema)) {
    if (s.type === 'list' && s.feed)
      out[k] = {
        type: 'list',
        label: s.label,
        computed:
          s.feed === 'articles'
            ? "Filled automatically from the site's published dated articles, newest first. Never send it: make or change articles with page.create/page.update (articleDate, byline, excerpt, newsHidden)."
            : s.feed === 'entries'
              ? "Filled automatically from a collection's published entries (blog posts), newest first by publication date; drafts never show, and on an entry's own page that entry is left out. Never send it: choose what shows with the placement's collection (collection ID, empty for the blog), category and tag (term ID or name, empty for all) and count properties."
              : "Filled automatically from the page it is on: its title, and its articleDate, byline and excerpt. Never send it: change them with page.update."
      };
    else if (s.type === 'list')
      out[k] = {
        type: 'list',
        label: s.label,
        itemFields: Object.fromEntries(
          Object.entries(s.fields).map(([f, fs]) => {
            const shape = fs.type === 'enum' ? { type: 'enum', options: fs.options.map((o) => o.value) } : fs.type === 'richtext' && fs.codeForm ? { type: 'richtext', codeForm: fs.codeForm } : fs.type;
            // A field every item must fill: its type alone would read as optional.
            return [f, fs.required ? { ...(typeof shape === 'string' ? { type: shape } : shape), required: true } : shape];
          })
        ),
        max: s.max,
        // A page list: these fields, left empty, show the linked page's own values and follow its later edits.
        ...(s.pageTeaser ? { fromLinkedPage: { link: s.pageTeaser.link, ...Object.fromEntries(teaserFields(s.pageTeaser).map(([f, what]) => [f, `page ${what} when empty`])) } } : {})
      };
    else if (s.type === 'enum') out[k] = { type: 'enum', label: s.label, options: s.options.map((o) => o.value) };
    else if (s.type === 'table') out[k] = { type: 'table', label: s.label, shape: TABLE_SIGNATURE };
    // How code receives rich text: what its source must be written for.
    else if (s.type === 'richtext' && s.codeForm) out[k] = { type: 'richtext', label: s.label, codeForm: s.codeForm };
    else if (s.type === 'object')
      out[k] = { type: 'object', label: s.label, fields: Object.fromEntries(Object.entries(s.fields).map(([f, fs]) => [f, propSignature(fs)])), note: 'Send only the fields to change; the others keep their values.' };
    else if (s.type === 'token') out[k] = { type: 'token', label: s.label, tokenGroup: s.tokenGroup, note: `The ID of a ${s.tokenGroup} token (read_project with sections ["tokens"] lists them).` };
    else out[k] = { type: s.type, label: s.label };
    // A value the component cannot render without: never sent empty (see shared/required.ts).
    if (s.required) out[k] = { ...(out[k] as object), required: true, requires: requiredHint(s) };
  }
  return out;
}

export function componentDetail(def: ComponentDefinition) {
  return {
    definitionId: def.id,
    componentId: def.componentId,
    name: def.name,
    description: def.description,
    kind: def.kind,
    owner: def.owner,
    properties: propSchemaSummary(def.properties),
    parts: Object.fromEntries(
      Object.entries(def.parts).map(([k, p]) => {
        const list = repeatedPartList(def, k);
        // A part shown once per list item can be styled for one item alone (node.setStyle with itemId).
        return [k, { label: p.label, styleControls: partStyleControls(def, k) ?? [], ...(list ? { repeatsPerItemOf: list } : {}) }];
      })
    ),
    // Code takes each axis through the property its manifest names, which its source must take from $props().
    variantAxes: Object.fromEntries(axesOf(def).map(([axis, a]) => [axis, { label: a.label, ...(def.kind === 'code' && a.prop ? { prop: a.prop } : {}), default: a.default, options: Object.fromEntries(Object.entries(a.options).map(([k, v]) => [k, v.label])) }])),
    slots: def.slots ?? {},
    ...(def.owner === 'theme' && def.insertAs === 'element' ? { block: true } : {}),
    // UI state the design reads in conditions and variants and its buttons change; placements never set it.
    ...(def.state && Object.keys(def.state).length ? { state: def.state } : {}),
    examples: def.examples ?? []
  };
}

/** Characters of node records one structural read of a component returns; the rest follows from `next`. */
export const STRUCTURE_CHARS = 12000;

/** A tree's node IDs in document order: each node, then what it holds (children, repeated content, slot content). */
function documentOrder(tree: NodeTree): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    const n = tree.nodes[id];
    if (n) for (const l of childLists(n)) l.ids.forEach(walk);
  };
  tree.rootIds.forEach(walk);
  return out;
}

/** Every `{ token }` reference in style rules (one scope, a responsive set, or rules by part and item), at any depth. */
function collectTokens(v: unknown, out: Set<string>) {
  if (Array.isArray(v)) return v.forEach((x) => collectTokens(x, out));
  if (!v || typeof v !== 'object') return;
  const rec = v as Record<string, unknown>;
  if (typeof rec.token === 'string') out.add(rec.token);
  for (const x of Object.values(rec)) collectTokens(x, out);
}

/** Child IDs a node record lists; the rest follow it in the read's document order. */
const CHILD_IDS_SHOWN = 100;
const clipIds = (ids: unknown) => (Array.isArray(ids) && ids.length > CHILD_IDS_SHOWN ? [...ids.slice(0, CHILD_IDS_SHOWN), `…and ${ids.length - CHILD_IDS_SHOWN} more`] : ids);

/** A design's node as stored (its child lists are IDs), with long literal content shortened and the parts it names. */
function structureNode(state: ProjectState, n: GraphNode, parts: string[] | undefined, nested: (id: string) => ComponentDefinition | undefined): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...n };
  // A container of thousands of elements would fill a read on its own: its first IDs say how it is built.
  if ('children' in n) rec.children = clipIds(n.children);
  if (n.kind === 'instance' && n.slots) rec.slots = Object.fromEntries(Object.entries(n.slots).map(([k, ids]) => [k, clipIds(ids)]));
  if (n.kind === 'text' && !isBinding(n.text)) rec.text = summarizeValue(n.text, state.pages);
  if (n.kind === 'instance') {
    const def = nested(n.definitionId);
    rec.component = def?.name;
    rec.componentId = def?.componentId;
    rec.props = agentProps(def, n.props, state.pages);
  }
  if (parts?.length) rec.parts = parts;
  return rec;
}

/**
 * How a managed component's design is built, for a model making one like it: its nodes in document order as stored
 * (kind, tag, name, child IDs, styles with their token references and phone/tablet/desktop rules, bindings to its
 * properties ($prop) and list items ($item), conditions, repeats, slots and the components placed in it), the parts
 * each node is styled through, and, on the first read, its property defaults, the style rules of each variant option
 * by node, and every token it uses. A long design comes a part at a time: read again from `next` until it is null.
 */
export function componentStructure(state: ProjectState, def: ComponentDefinition, offset = 0, room = STRUCTURE_CHARS) {
  if (def.kind !== 'managed' || !def.tree)
    return { definitionId: def.id, kind: def.kind, note: def.kind === 'code' ? 'A code component: its design is Svelte source, not a node tree. Its contract above is what placements use.' : 'This component has no design tree.' };
  const tree = def.tree;
  const order = documentOrder(tree);
  const partsOf = new Map<string, string[]>();
  for (const [pid, p] of Object.entries(def.parts)) partsOf.set(p.nodeId, [...(partsOf.get(p.nodeId) ?? []), pid]);
  const theme = getTheme(state.site.themeId).components;
  // A design read from the catalogue places other theme components the project may not have installed yet.
  const nested = (id: string) => (Object.hasOwn(state.components, id) ? state.components[id] : theme.find((c) => c.id === id));
  // The first read also says what holds for the whole design, and its nodes share what room that leaves.
  const whole = offset > 0 ? null : designSummary(state, def, nested);
  const budget = Math.min(STRUCTURE_CHARS, room - (whole ? JSON.stringify(whole).length : 0));
  const nodes: Record<string, unknown>[] = [];
  let used = 0;
  let i = Math.min(offset, order.length);
  for (; i < order.length; i++) {
    const n = tree.nodes[order[i]];
    const rec = n ? structureNode(state, n, partsOf.get(n.id), nested) : { id: order[i], missing: true };
    const size = JSON.stringify(rec).length;
    // At least one node per read, so a read always moves on.
    if (nodes.length && used + size > budget) break;
    nodes.push(rec);
    used += size;
  }
  const page = { totalNodes: order.length, offset, next: i < order.length ? i : null };
  if (!whole) return { definitionId: def.id, nodes, ...page };
  return { definitionId: def.id, rootIds: tree.rootIds, nodes, ...page, ...whole };
}

/**
 * What holds for a whole design: its property defaults, the style rules of each variant option by node, and every
 * token it uses: in its styles, its variant rules, the styles and token properties of the components placed in it,
 * and its own token properties' defaults (a list's or object's token fields included).
 */
function designSummary(state: ProjectState, def: ComponentDefinition, nested: (id: string) => ComponentDefinition | undefined) {
  const tokens = new Set<string>();
  const tokenValue = (v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { token?: unknown }).token === 'string') tokens.add((v as { token: string }).token);
  };
  /** The tokens a property holds, by its schema: a token, or the token fields of an object or of each list item. */
  const propTokens = (sch: PropSchema, v: unknown) => {
    if (sch.type === 'token') return tokenValue(v);
    if (sch.type !== 'object' && sch.type !== 'list') return;
    const records = sch.type === 'object' ? [v] : Array.isArray(v) ? v : [];
    for (const r of records) if (isEntry(r)) for (const [f, fs] of Object.entries(sch.fields)) if (fs.type === 'token') tokenValue(r[f]);
  };
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    collectTokens(n.styles, tokens);
    if (n.kind !== 'instance') continue;
    collectTokens(n.overrides, tokens);
    collectTokens(n.itemOverrides, tokens);
    for (const [k, sch] of Object.entries(nested(n.definitionId)?.properties ?? {})) if (Object.hasOwn(n.props, k) && !isBinding(n.props[k])) propTokens(sch, n.props[k]);
  }
  for (const sch of Object.values(def.properties)) {
    propTokens(sch, sch.default);
    // A list's or object's token field has a default of its own, which new items start with.
    if (sch.type === 'list' || sch.type === 'object') for (const f of Object.values(sch.fields)) if (f.type === 'token') tokenValue(f.default);
  }
  const variantStyles = Object.fromEntries(
    axesOf(def)
      .map(([axis, a]) => [axis, Object.fromEntries(Object.entries(a.options).flatMap(([o, v]) => (v.styles && Object.keys(v.styles).length ? [[o, v.styles]] : [])))] as const)
      .filter(([, opts]) => Object.keys(opts).length)
  );
  for (const opts of Object.values(variantStyles)) collectTokens(opts, tokens);
  const defaults = Object.fromEntries(Object.entries(def.properties).flatMap(([k, sch]) => ('default' in sch && sch.default !== undefined ? [[k, summarizeValue(sch.default, state.pages)]] : [])));
  return {
    ...(Object.keys(defaults).length ? { propertyDefaults: defaults } : {}),
    ...(Object.keys(variantStyles).length ? { variantStyles } : {}),
    tokensUsed: [...tokens].sort()
  };
}

/** How a table is written whole, and its limits. */
const TABLE_SIGNATURE = `table{columns:string[], rows:string[][]} max ${TABLE_LIMITS.columns} columns, ${TABLE_LIMITS.rows} rows`;

/** One property as a short type signature: "string", "link", "enum(a|b)", "list<title:required string, icon:icon>". */
function propSignature(s: PropSchema): string {
  return s.required ? `required ${propType(s)}` : propType(s);
}

function propType(s: PropSchema): string {
  if (s.type === 'enum') return `enum(${s.options.map((o) => o.value).join('|')})`;
  if (s.type === 'table') return TABLE_SIGNATURE;
  if (s.type === 'list' && s.feed) return `computed from ${s.feed === 'articles' ? "the site's dated articles" : s.feed === 'entries' ? "a collection's published entries, chosen by collection, category, tag and count" : "the site's page"}: never send`;
  if (s.type === 'list') return `list<${Object.entries(s.fields).map(([f, fs]) => `${f}:${propSignature(fs)}`).join(', ')}>${s.max ? ` max ${s.max}` : ''}`;
  if (s.type === 'object') return `object{${Object.entries(s.fields).map(([f, fs]) => `${f}:${propSignature(fs)}`).join(', ')}}`;
  if (s.type === 'token') return `token(${s.tokenGroup})`;
  return s.type;
}

/**
 * The theme catalogue with compact property signatures, style parts and variants, so the model can plan a
 * whole page from one read instead of calling read_component for every component.
 */
export function catalogueIndex(themeId: string) {
  const defs = new Map(getTheme(themeId).components.map((c) => [c.componentId, c]));
  return catalogueEntries(themeId).map((e) => {
    const def = defs.get(e.componentId);
    return {
      componentId: e.componentId,
      name: e.name,
      category: e.category,
      variants: e.axes,
      props: def ? Object.fromEntries(Object.entries(def.properties).map(([k, s]) => [k, propSignature(s)])) : {},
      parts: def ? Object.keys(def.parts) : [],
      ...(def?.slots && Object.keys(def.slots).length ? { slots: Object.keys(def.slots) } : {}),
      // A block goes inside a section, a column or a slot with node.insert, never among a page's sections.
      ...(e.block ? { block: true } : {})
    };
  });
}

/**
 * The site's tokens as the assistant reads them. On a site with a dark palette, each colour also says its value
 * there (`darkValue`) and whether that is its own (`darkOverridden`) or its light value shown again.
 */
export function tokensSummary(state: ProjectState) {
  const dual = hasDarkPalette(state.tokens);
  const dark = dual ? new Map(effectiveTokens(state, 'dark').map((t) => [t.id, t.value])) : null;
  const own = state.tokens.darkOverrides ?? {};
  return effectiveTokens(state).map((t) => ({
    id: t.id,
    label: t.label,
    value: t.value,
    overridden: t.id in state.tokens.overrides,
    ...(dark && t.group === 'color' ? { darkValue: dark.get(t.id), darkOverridden: Object.hasOwn(own, t.id) } : {})
  }));
}

/** The selected element's own content is shown whole up to this size (as JSON), and summarized beyond it. */
const SELECTED_FULL_CHARS = 6000;

/** The selected element's own content, in full unless it is very large: this is what the edit works from. */
function selectedProps(def: ComponentDefinition | undefined, props: Record<string, unknown>, pages: RichPages): unknown {
  const shown = agentProps(def, props, pages, true);
  return JSON.stringify(shown).length <= SELECTED_FULL_CHARS ? shown : agentProps(def, props, pages);
}

/**
 * Whether what a run is told about the selected element shortens its content, so the run needs a way to read a
 * field whole (inspect_element with a prop) before it changes it.
 */
export function selectionAbridged(state: ProjectState, target: { owner: OwnerRef; nodeId: string }): boolean {
  let tree: NodeTree;
  try {
    tree = getTree(state, target.owner);
  } catch {
    return false;
  }
  const n = Object.hasOwn(tree.nodes, target.nodeId) ? tree.nodes[target.nodeId] : undefined;
  if (n?.kind === 'instance') {
    const def = state.components[n.definitionId];
    // Text the placement inherits from its definition's default is not shown at all, and may be long too.
    const long = (s: PropSchema) =>
      (s.type === 'richtext' && Array.isArray(s.default) && richTextToMarkdown(s.default as never, state.pages).length > RICH_SUMMARY_CHARS) || (s.type === 'string' && typeof s.default === 'string' && s.default.length > 220);
    if (Object.entries(def?.properties ?? {}).some(([k, s]) => !Object.hasOwn(n.props, k) && long(s))) return true;
    return JSON.stringify(agentProps(def, n.props, state.pages, true)).length > SELECTED_FULL_CHARS;
  }
  if (n?.kind === 'text' && !isBinding(n.text)) return JSON.stringify(summarizeValue(n.text, state.pages)) !== JSON.stringify(n.text);
  return false;
}

/** A field read whole, a part at a time: the most characters (as they are escaped in a tool result) in one part. */
const FIELD_PART_CHARS = 8000;

export interface FieldRef {
  owner: OwnerRef;
  nodeId: string;
  /** A property of a placed component, or "text" for a text element. */
  prop: string;
  itemId?: string;
  field?: string;
  offset?: number;
}

/**
 * One content field as text, whole or a part at a time from `offset`: rich text as the same Markdown the tools accept,
 * plain text as it is, anything else as JSON. A placement without a value of its own shows its definition's default,
 * so that is what is read. Read every part (until `next` is null) before writing the field back whole.
 */
export function readField(state: ProjectState, ref: FieldRef): { ok: true; content: Record<string, unknown> } | { ok: false; message: string } {
  let tree: NodeTree;
  try {
    tree = getTree(state, ref.owner);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const node = Object.hasOwn(tree.nodes, ref.nodeId) ? tree.nodes[ref.nodeId] : undefined;
  if (!node) return { ok: false, message: `No node "${ref.nodeId}".` };
  let value: unknown;
  let schema: PropSchema | undefined;
  if (node.kind === 'instance') {
    const def = state.components[node.definitionId];
    const props = def?.properties ?? {};
    const top = Object.hasOwn(props, ref.prop) ? props[ref.prop] : undefined;
    if (!top) return { ok: false, message: `"${def?.name ?? 'This component'}" has no property "${ref.prop}". Properties: ${Object.keys(props).join(', ')}` };
    value = Object.hasOwn(node.props, ref.prop) ? node.props[ref.prop] : (top as { default?: unknown }).default;
    schema = top;
    if (ref.itemId !== undefined || ref.field !== undefined) {
      if (top.type !== 'list') return { ok: false, message: `"${ref.prop}" is not a list, so it has no items.` };
      if (ref.itemId === undefined || ref.field === undefined) return { ok: false, message: 'Name both itemId and field to read one field of a list item.' };
      const items = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>;
      const item = items.find((i) => i?.id === ref.itemId);
      if (!item) return { ok: false, message: `No item "${ref.itemId}" in ${top.label}. Items: ${items.map((i) => i?.id).join(', ')}` };
      if (!Object.hasOwn(top.fields, ref.field)) return { ok: false, message: `${top.itemLabel} has no field "${ref.field}". Fields: ${Object.keys(top.fields).join(', ')}` };
      schema = top.fields[ref.field];
      value = item[ref.field];
    }
  } else {
    const fields: Record<string, unknown> = node.kind === 'text' ? { text: node.text } : node.kind === 'link' ? { label: node.label } : {};
    if (!Object.hasOwn(fields, ref.prop)) return { ok: false, message: `This ${node.kind} element has no text field "${ref.prop}".${Object.keys(fields).length ? ` Fields: ${Object.keys(fields).join(', ')}` : ''}` };
    value = fields[ref.prop];
  }
  if (isBinding(value)) return { ok: false, message: 'This field shows a property of the component it is inside; read that component instead.' };
  // Rich text, empty included, reads as Markdown: an empty value written back stays empty.
  const rich = Array.isArray(value) && ((schema?.type === 'richtext' || (node.kind === 'text' && node.rich)) || (value.length > 0 && value.every(isRichBlock)));
  const format = rich ? 'markdown' : typeof value === 'string' ? 'text' : 'json';
  const text = rich ? richTextToMarkdown(value as never, state.pages, schema?.type === 'richtext' ? schema.plainAs : undefined) : typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let start = Math.min(Math.max(0, ref.offset ?? 0), text.length);
  // Never between the two halves of one character, at either end of a part.
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(start)) && /[\uD800-\uDBFF]/.test(text.charAt(start - 1))) start--;
  let end = Math.min(text.length, start + FIELD_PART_CHARS);
  // Measured as the tool result carries it, where quotes, backslashes and line breaks are escaped.
  while (end > start + 1 && JSON.stringify(text.slice(start, end)).length - 2 > FIELD_PART_CHARS) end = start + Math.floor((end - start) * 0.9);
  if (end < text.length && end > start + 1 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  const next = end < text.length ? end : null;
  return {
    ok: true,
    content: {
      owner: ref.owner,
      nodeId: ref.nodeId,
      prop: ref.prop,
      ...(ref.itemId !== undefined ? { itemId: ref.itemId, field: ref.field } : {}),
      format,
      total: text.length,
      start,
      end,
      next,
      text: text.slice(start, end),
      note:
        next !== null
          ? `Part of the value. Call inspect_element again with offset ${next} for the rest, and join the parts in order before writing the field back whole.`
          : start > 0
            ? 'The last part of the value.'
            : 'The whole value.'
    }
  };
}

/**
 * `operations: false`: the run edits through the selection's own tools, so the note names only those. `texts`: for a
 * part of a code component, the text its code shows there, as the run's authority read it (scope.ts codePartReach).
 */
export function describeSelection(state: ProjectState, ref: ElementRef | null, opts: { operations?: boolean; texts?: CodePartTexts } = {}): Record<string, unknown> | null {
  if (!ref) return null;
  const tree: NodeTree | undefined =
    ref.owner.kind === 'page' ? state.pages[ref.owner.id] : ref.owner.kind === 'shell' ? state.site.shell[ref.owner.id as 'header' | 'footer'] : state.components[ref.owner.id]?.tree;
  if (!tree) return null;
  if (!ref.instancePath.length) {
    const node = compactNode(state, tree, ref.nodeId);
    const selected = tree.nodes[ref.nodeId];
    if (selected?.kind === 'instance') node.props = selectedProps(state.components[selected.definitionId], selected.props, state.pages);
    const update = selected?.kind === 'instance' ? themeUpdateNote(state, state.components[selected.definitionId]) : undefined;
    return { owner: ref.owner, nodeId: ref.nodeId, node, ...(update ? { themeUpdate: update } : {}), ...updatesInside(state, tree, ref.nodeId, selected?.kind === 'instance' ? selected.definitionId : undefined) };
  }
  const instId = ref.instancePath[0];
  const inst = tree.nodes[instId];
  const def = inst?.kind === 'instance' ? state.components[inst.definitionId] : undefined;
  const selectedItem = ref.itemPath?.[ref.itemPath.length - 1];
  // When this part can be styled per item: the style every item shares, the items with styles of their own, and the
  // selected item's own styles while it is still in the list.
  const repeatList = inst?.kind === 'instance' && def && ref.partId && ref.instancePath.length === 1 && ref.owner.kind !== 'component' ? repeatedPartList(def, ref.partId) : undefined;
  let itemReach: Record<string, unknown> | undefined;
  if (repeatList && inst?.kind === 'instance' && def && ref.partId) {
    const present = selectedItem !== undefined && placementItems(def, inst, repeatList).some((i) => i.id === selectedItem);
    itemReach = {
      list: repeatList,
      sharedStyles: inst.overrides?.[ref.partId] ?? null,
      itemStyles: liveItemStyles(def, inst, ref.partId)?.items ?? {},
      ...(present ? { itemId: selectedItem, itemOwnStyles: itemStylesOf(def, inst, ref.partId, selectedItem!) ?? null } : {})
    };
  }
  const defNode: GraphNode | undefined = def?.tree?.nodes[ref.nodeId];
  let binding: unknown = null;
  if (defNode) {
    if (defNode.kind === 'text') binding = defNode.text;
    else if (defNode.kind === 'image') binding = defNode.image;
    else if (defNode.kind === 'link') binding = { link: defNode.link, label: defNode.label };
  }
  // A News card or article header shows a page's article details, which change on that page, never here.
  const repeated = def ? enclosingRepeatProp(def, ref.nodeId) : undefined;
  const fromRow = (b: unknown) => isBinding(b) && '$item' in b;
  const shown = defNode?.kind === 'text' ? defNode.text : defNode?.kind === 'link' ? defNode.label : defNode?.kind === 'image' ? defNode.image : undefined;
  const feed = repeated && fromRow(shown) && def?.properties[repeated]?.type === 'list' ? (def.properties[repeated] as { feed?: string }).feed : undefined;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  // What a newer theme version of the selected component adds, and whether this project can take it.
  const update = themeUpdateNote(state, def);
  // The text a code component's part shows, which is all of the placement's content it may change.
  const codeReach = def && !def.tree && ref.instancePath.length === 1 ? codePartReach(def, { partId: ref.partId, itemId: selectedItem }, opts.texts, inst) : null;
  // A property shown in a part repeated per item shows in every item: not the selected item's to change.
  const codeTexts = codeReach ? [...(selectedItem !== undefined && codeReach.repeated ? [] : codeReach.props), ...[...codeReach.itemFields].flatMap(([list, fields]) => [...fields].map((f) => `${list}.${f}`))] : [];
  return {
    owner: ref.owner,
    instanceNodeId: instId,
    component: def?.name,
    definitionId: def?.id,
    ...(update ? { themeUpdate: update } : {}),
    ...updatesInside(state, tree, instId, def?.id),
    partId: ref.partId ?? null,
    innerNodeId: ref.nodeId,
    itemId: ref.itemPath?.[ref.itemPath.length - 1] ?? null,
    boundTo: binding,
    ...(inst?.kind === 'instance' ? { currentProps: selectedProps(def, inst.props, state.pages) } : {}),
    ...(itemReach ? { styleReach: itemReach } : {}),
    ...(feed === 'entries'
      ? {
          note: `This shows a collection entry's details (a blog post's title, date, author, excerpt, picture or categories), filled in from entry ${itemId ?? '(the post)'}: they change in that entry, not here. Which entries show is chosen by the placement's collection, category, tag and count properties.${opts.operations === false ? ' Style the part with style_selected_element.' : ' Style the part with node.setStyle using partId.'}`
        }
      : feed
      ? {
          note:
            opts.operations === false
              ? `This shows a page's article details, filled in from that page: they change on page ${itemId ?? '(the article)'}, not here. Style the part with style_selected_element.`
              : `This shows a page's article details, filled in from that page: change its title, articleDate, byline or excerpt with page.update on pageId ${itemId ?? '(the article)'}, never instance.setProp. Style the part with node.setStyle using partId.`
        }
      : opts.operations === false
        ? itemReach
          ? { note: 'Add itemId to style one item only: the others keep the shared style. To return an item to the shared style, use style_selected_element with itemId and resetItem.' }
          : {}
        : {
            note: `Edit bound content with instance.setProp on the instance (use itemId and field for repeated items). Style the part with node.setStyle using partId; it changes every item.${itemReach ? ' Add itemId to style one item only: the others keep the shared style. To return an item to the shared style, use style_selected_element with itemId and resetItem, or node.resetStyles with partId and itemId.' : ''}`
          }),
    // What the run may change: the app refuses anything else until the user approves a wider change. The definition's
    // root is the whole placement.
    ...(def && !(def.tree ? def.tree.rootIds[0] === (ref.instancePath[1] ?? ref.nodeId) : ref.instancePath.length === 1 && ref.partId === 'root')
      ? {
          scope:
            ref.instancePath.length > 1
              ? 'Nothing on its own: this part is inside another component placed here. Any change needs the user to approve a wider change first.'
              : !def.tree
                ? codeTexts.length
                  ? `Only this part: the text it shows (${codeTexts.join(', ')}${selectedItem !== undefined && codeReach!.itemFields.size ? `, for the selected item "${selectedItem}"` : ''}) and its own styles. Anything else in the component (other parts, its variants${selectedItem !== undefined ? ', other items' : ''}) needs the user to approve a wider change first.`
                  : 'Only this part\'s own styles: its code marks no text inside it that only it shows. Anything else needs the user to approve a wider change first.'
                : `Only this part: the content it shows${selectedItem !== undefined ? ` for the selected item "${selectedItem}"` : ''} and its own styles. Anything else in the component (other parts, its variants${selectedItem !== undefined ? ', other items' : ''}) needs the user to approve a wider change first.`
        }
      : {})
  };
}

export function ownerLabel(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'page') return state.pages[owner.id]?.title ?? 'Page';
  if (owner.kind === 'shell') return owner.id === 'header' ? 'Header' : 'Footer';
  return state.components[owner.id]?.name ?? 'Component';
}

/**
 * What a request is about, for putting the project's diagnostics in order: its target (a selected element, a component
 * edited everywhere or a post), and the page it was sent from.
 */
export interface DiagnosticFocus {
  pageId?: string;
  /** The selected element: its owner, the node, and the placements entered to reach it. */
  selection?: { owner: OwnerRef; nodeId: string; instancePath?: string[] } | null;
  definitionId?: string;
  post?: { collectionId: string; entryId: string } | null;
}

/**
 * How near a diagnostic sits to what the request is about: 0 on the selected element, 1 on the rest of its target (the
 * component edited everywhere, the post), 2 on the page it was sent from or what that page shows (its header and footer
 * while it shows them, and every component placed there, however deep), 3 anywhere else.
 */
export function diagnosticRank(state: ProjectState, focus: DiagnosticFocus): (d: Diagnostic) => 0 | 1 | 2 | 3 {
  const key = (o: { kind: string; id: string }) => `${o.kind}:${o.id}`;
  /** Owners the request is about as a whole. */
  const target = new Set<string>();
  /** The selected element, in each tree it is reached through: its placement in the owner, each component's own placement inside the next, and the element itself in the innermost. */
  const selected = new Map<string, string>();
  const near = new Set<string>();
  const trees: NodeTree[] = [];
  const page = focus.pageId && Object.hasOwn(state.pages, focus.pageId) ? state.pages[focus.pageId] : undefined;
  if (page) {
    near.add(key({ kind: 'page', id: page.id }));
    trees.push(page);
    for (const part of SHELL_PARTS)
      if (showsPart(page, part)) {
        near.add(key({ kind: 'shell', id: part }));
        trees.push(state.site.shell[part]);
      }
  }
  if (focus.selection) {
    const path = focus.selection.instancePath ?? [];
    let owner = key(focus.selection.owner);
    let tree: NodeTree | undefined;
    try {
      tree = getTree(state, focus.selection.owner);
    } catch {
      tree = undefined;
    }
    for (const id of path) {
      selected.set(`${owner}|${id}`, id);
      const n = tree?.nodes[id];
      const def = n?.kind === 'instance' && Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
      if (!def) break;
      owner = key({ kind: 'component', id: def.id });
      tree = def.tree;
    }
    selected.set(`${owner}|${focus.selection.nodeId}`, focus.selection.nodeId);
  }
  const defs: string[] = [];
  if (focus.definitionId) {
    target.add(key({ kind: 'component', id: focus.definitionId }));
    defs.push(focus.definitionId);
  }
  if (focus.post) {
    target.add(key({ kind: 'entry', id: focus.post.entryId }));
    near.add(key({ kind: 'template', id: focus.post.collectionId }));
    const c = Object.hasOwn(state.collections ?? {}, focus.post.collectionId) ? state.collections[focus.post.collectionId] : undefined;
    if (c?.settings.template && typeof c.settings.template === 'object') trees.push(c.settings.template);
  }
  for (const t of trees) for (const n of Object.values(t?.nodes ?? {})) if (n.kind === 'instance') defs.push(n.definitionId);
  // Every component shown there, through the components they place in turn (a cycle is walked once).
  const seen = new Set<string>();
  while (defs.length) {
    const id = defs.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    near.add(key({ kind: 'component', id }));
    const def = Object.hasOwn(state.components, id) ? state.components[id] : undefined;
    if (def) defs.push(...directDependencies(def));
  }
  return (d) => {
    const owner = d.owner ? key(d.owner) : '';
    if (d.nodeId !== undefined && selected.has(`${owner}|${d.nodeId}`)) return 0;
    if (target.has(owner)) return 1;
    return near.has(owner) ? 2 : 3;
  };
}

/** The room the project's diagnostics take in a request, in characters, from the model's window. */
export const diagnosticsChars = (contextWindowTokens: number) => Math.max(0, Math.min(2048, Math.floor(contextWindowTokens / 16)));

/** The longest message one listed diagnostic keeps, so a single long one cannot fill the list. */
const DIAGNOSTIC_MESSAGE_MAX = 280;

interface DiagnosticEntry {
  code: string;
  message: string;
  owner: string | null;
  nodeId?: string;
}

/**
 * The project's errors and warnings as a request starts, for <editor_context>: errors first, then warnings, those on
 * what the request is about (`rank`) before the rest, within `maxChars` as `indent` writes them. A cut list says how
 * many of each it leaves out and where they are all listed (`more`). A project with none has no section (undefined).
 */
export function diagnosticsContext(diags: readonly Diagnostic[], rank: (d: Diagnostic) => number, maxChars: number, more: string, indent?: number) {
  const severity = (d: Diagnostic) => (d.severity === 'error' ? 0 : 1);
  const listed = diags
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.severity === 'error' || d.severity === 'warning')
    .map((x) => ({ ...x, r: rank(x.d) }))
    .sort((a, b) => severity(a.d) - severity(b.d) || a.r - b.r || a.i - b.i)
    .map(({ d }) => d);
  if (!listed.length) return undefined;
  const totals = { errors: listed.filter((d) => d.severity === 'error').length, warnings: listed.filter((d) => d.severity === 'warning').length };
  const entry = (d: Diagnostic): DiagnosticEntry => ({
    code: d.code,
    message: d.message.length > DIAGNOSTIC_MESSAGE_MAX ? `${d.message.slice(0, DIAGNOSTIC_MESSAGE_MAX - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : d.message,
    owner: d.owner ? `${d.owner.kind}:${d.owner.id}` : null,
    ...(d.nodeId !== undefined ? { nodeId: d.nodeId } : {})
  });
  const section = (n: number) => {
    const shown = listed.slice(0, n);
    const errors = shown.filter((d) => d.severity === 'error').map(entry);
    const warnings = shown.filter((d) => d.severity === 'warning').map(entry);
    const left = { errors: totals.errors - errors.length, warnings: totals.warnings - warnings.length };
    return {
      note: 'Problems already in the project as this request started, not caused by it.',
      errors,
      warnings,
      ...(left.errors || left.warnings ? { notListed: { ...left, note: `${left.errors} error${left.errors === 1 ? '' : 's'} and ${left.warnings} warning${left.warnings === 1 ? '' : 's'} are not listed here: ${more}.` } } : {})
    };
  };
  // Measured as it sits in the context, one level in.
  const size = (n: number) => JSON.stringify({ diagnostics: section(n) }, null, indent).length - JSON.stringify({ diagnostics: null }, null, indent).length + 4;
  // The whole list, when it fits: it says nothing of what is left out, so it can be shorter than a cut one.
  if (size(listed.length) <= maxChars) return section(listed.length);
  // Otherwise the most that fit, by halving: a cut list only grows longer with each entry.
  let lo = 0;
  let hi = listed.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(mid) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  // Not even the counts fit: no section.
  if (lo === 0 && size(0) > maxChars) return undefined;
  return section(lo);
}
