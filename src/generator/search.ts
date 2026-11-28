/**
 * Site search: visitors of the exported website search the titles and content of its pages and go to the one they
 * want. The generator writes two plain files into the site's runtime folder while a component of the site uses
 * them: the code that searches (`site-search.js`) and the index of the pages it searches (`search-index.js`). The
 * index loads as a script of its own the first time a visitor searches, so a page that never searches never loads
 * it, and the static build names it after its content, so no browser keeps reading an old copy after a new export.
 *
 * The index lists the site's pages in page order, then its published collection entries (blog posts and the like), less
 * drafts and those the author hides from site search, each with its current address, its title, the browser title the
 * author gave it, its description, and the words it shows: the content the page itself renders (never the shared
 * header and footer, which every page has), or an entry's excerpt and text. Old addresses kept for renamed pages and
 * posts only send visitors on, so they are never results; a page found always links to where it is now.
 */
import type { Collection, ComponentDefinition, EntryDoc, InstanceNode, LinkValue, NodeTree, PageDoc, ProjectState, ResponsiveStyles, TableValue } from '@shared/types';
import { isBinding, isEntryBinding, slotChildren } from '@shared/types';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { codePartsHidden, entryArticle, evaluate, hiddenInDesignEverywhere, renderedContent, shippedCode, walkRendered, type RenderedContent } from './checks';
import { showsBody } from './entry-template';
import { collectionKind, siteEntries } from '@shared/collections';
import { isDraftPage, publishedState, resolveLink } from './index';
import { shippedOutline } from './shipped-outlines';
import { rendersAsShipped } from '@engine/shipped-copy';
import { siteMount } from '@shared/crawler-policy';
import { publicUrl } from '@shared/public-url';
import { searchService } from '@shared/site-search';

/** The search code, imported by the Site search component from the runtime folder. */
export const SEARCH_HELPER_FILE = 'site-search.js';
/** The index of the pages, loaded by the search code when a visitor first searches. */
export const SEARCH_INDEX_FILE = 'search-index.js';

/** One page as search knows it. */
export interface SearchEntry {
  route: string;
  title: string;
  /** The browser title the author gave the page, when it says something other than its title. */
  alias?: string;
  description?: string;
  /** The words the page shows, one line per field. */
  text: string;
}

/** Text on one line. A value that is not text (a hand-edited document) is no text. */
const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Whether a page is left out of the site's own search. Read as the Inspector's switch reads it, so a hand-edited
 * value the switch shows as on hides the page too.
 */
export function searchHidden(page: PageDoc): boolean {
  return !!page.seo?.searchHidden;
}

const SIZES = ['phone', 'tablet', 'desktop'] as const;

/** Whether a size's own rule says anything about how the layer displays: a hide or show, an arrangement, or custom CSS. */
const touchesDisplay = (props: ResponsiveStyles['base']) => !!props && (props.hidden !== undefined || props.layout !== undefined || props.customCss !== undefined);

/**
 * Whether a layer's own styles certainly hide it at every size, in the two ways the generated CSS leaves no doubt:
 * each size hides it in its own rule (the size rules come last, and the hide is each rule's last word), or the
 * every-size rule hides it ("Hide at every size") and nothing after that rule says anything about its display. Any
 * other mix is read as shown, so its text stays searchable rather than visible text going missing.
 */
export function hiddenEverywhere(styles: ResponsiveStyles | undefined): boolean {
  if (!styles) return false;
  if (SIZES.every((size) => styles[size]?.hidden === true)) return true;
  const baseCss = styles.base?.customCss;
  return styles.base?.hidden === true && !(typeof baseCss === 'string' && /display/i.test(baseCss)) && SIZES.every((size) => !touchesDisplay(styles[size]));
}

/**
 * The page's layers that hide themselves at every size, with everything inside them: nothing there is shown to
 * visitors, so nothing there is found. A placement hides by its own root override, which nothing else shows again.
 */
export function hiddenLayers(tree: NodeTree): Set<string> {
  const out = new Set<string>();
  const hide = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    const n = tree.nodes[id];
    const inside = n?.kind === 'element' ? n.children : n?.kind === 'instance' ? Object.keys(n.slots ?? {}).flatMap((k) => slotChildren(n, k)) : [];
    for (const c of inside) hide(c);
  };
  for (const n of Object.values(tree.nodes)) if (n && typeof n === 'object' && hiddenEverywhere(n.kind === 'instance' ? n.overrides?.root : n.styles)) hide(n.id);
  return out;
}

/**
 * The words a page shows, one line per field that shows any, in the order the page shows them: its text, rich text,
 * button labels and list items, with the words of Foundation's sections that only the designs standing for their
 * markup know of (shownWords), a section's before its layer's other words and its table's or comparison's after them.
 * A line shown twice is listed once.
 */
export function pageText(state: ProjectState, page: PageDoc): string {
  const hidden = hiddenLayers(page);
  const shown = shownWords(state, page, hidden);
  const content: Array<{ layer: string; line: string }> = [];
  for (const c of renderedContent(state, page)) {
    // Where a link goes is not something the visitor reads, and what custom code shows of a setting is unknown.
    if (c.kind !== 'text' || c.custom || hidden.has(c.nodeId)) continue;
    const line = oneLine(textOf(c.value, c.rich));
    if (line) content.push({ layer: c.nodeId, line });
  }
  const last = new Map(content.map((c, i) => [c.layer, i]));
  const at = new Map(shown.order.map((l, i) => [l, i]));
  const out = new Set<string>();
  const put = (lines: readonly string[]) => {
    for (const line of lines) out.add(line);
  };
  const done = new Set<string>();
  // A layer whose words only the second walk finds goes where that walk met it, after the layers before it.
  let next = 0;
  const through = (layer: string | undefined) => {
    const stop = layer === undefined ? shown.order.length : (at.get(layer) ?? -1);
    for (; next < stop; next++) {
      const l = shown.order[next];
      if (done.has(l) || last.has(l)) continue;
      done.add(l);
      put(shown.outline(l));
      put(shown.extra(l));
    }
    if (next === stop) next++;
  };
  content.forEach((c, i) => {
    if (!done.has(c.layer)) {
      through(c.layer);
      done.add(c.layer);
      put(shown.outline(c.layer));
    }
    out.add(c.line);
    if (last.get(c.layer) === i) put(shown.extra(c.layer));
  });
  through(undefined);
  return [...out].join('\n');
}

/** A field's words as plain text: rich text as its words, a number as written. */
function textOf(value: unknown, rich: boolean | undefined): string {
  if (typeof value === 'string' || typeof value === 'number') return rich && typeof value === 'string' ? plain(value) : String(value);
  return rich && Array.isArray(value) ? plain(value) : '';
}

/** The words a tree shows, one line per field that shows any, less the content `skip` says is found otherwise. */
function treeText(state: ProjectState, tree: NodeTree, skip?: (c: RenderedContent) => boolean): string {
  const lines: string[] = [];
  const hidden = hiddenLayers(tree);
  for (const c of renderedContent(state, tree)) {
    // Where a link goes is not something the visitor reads, and what custom code shows of a setting is unknown.
    if (c.kind !== 'text' || c.custom || hidden.has(c.nodeId) || skip?.(c)) continue;
    const line = oneLine(textOf(c.value, c.rich));
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * The words of Foundation's sections as the Markdown copies read them (generator/markdown.ts): through the designs
 * that stand for their markup (shipped-outlines.ts), which know the words the canvas cannot type over (a featured
 * card, both prices of a billing switch, a tab's name), and the cells of the theme's table and plan comparison. Like
 * the Markdown, it reads the panels a page ships while its state hides them (a tab not chosen yet), which visitors
 * reach, and leaves out what is hidden at every size: the page's own layers (`hidden`), and a section's parts its
 * placement hides.
 */
function shownWords(state: ProjectState, page: PageDoc, hidden: Set<string>): { order: string[]; outline: (layer: string) => string[]; extra: (layer: string) => string[] } {
  const order: string[] = [];
  const outlined = new Map<string, string[]>();
  const extras = new Map<string, string[]>();
  const add = (to: Map<string, string[]>, layer: string, values: readonly unknown[]) => {
    for (const v of values) {
      const text = oneLine(typeof v === 'number' ? String(v) : v);
      if (!text) continue;
      const lines = to.get(layer);
      if (lines) lines.push(text);
      else to.set(layer, [text]);
    }
  };
  const outlines = new WeakSet<ComponentDefinition>();
  walkRendered(state, page, {
    kept: true,
    // Every layer of the page in its order, for the words of one that shows nothing else.
    enter: (n) => void order.push(n.id),
    outline: (def) => {
      const o = shippedOutline(state, def);
      if (o) outlines.add(o);
      return o;
    },
    prune: (n, scope, reportId, def) => hidden.has(reportId) || (!!def?.tree && def.tree.nodes[n.id] === n && hiddenInDesignEverywhere(def, n.id, scope)),
    text: (n, scope, reportId, _inDef, def) => {
      if (def && outlines.has(def)) add(outlined, reportId, [textOf(evaluate(n.text, scope), n.rich)]);
    },
    link: (n, scope, reportId, _inDef, _ownId, def) => {
      if (!def || !outlines.has(def)) return;
      // A button with nowhere to go is left out of the site; a plain link still shows its words.
      const appearance = String(evaluate(n.appearance, scope) ?? '');
      if (appearance === 'plain' || appearance === 'link' || resolveLink(evaluate(n.link, scope) as LinkValue | undefined, { state })) add(outlined, reportId, [evaluate(n.label, scope)]);
    },
    code: (def, props, reportId, _placement, n) => {
      if (codePartsHidden(def, n, ['root'])) return;
      // The theme's own table and comparison, as the app ships them: any other code's markup decides what it shows.
      if (!rendersAsShipped(def)) return;
      if (def.componentId === 'pricing.compare') add(extras, reportId, comparisonWords(state, def, props, n));
      else if (shippedCode(state, def) === 'data.table') add(extras, reportId, tableWords(props.table));
    }
  });
  return { order, outline: (layer) => outlined.get(layer) ?? [], extra: (layer) => extras.get(layer) ?? [] };
}

/** A table's words: its column names, then each row's cells in the columns' order. */
function tableWords(value: unknown): unknown[] {
  const table = value as Partial<TableValue> | null;
  const columns = Array.isArray(table?.columns) ? table.columns.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : [];
  const rows = (Array.isArray(table?.rows) ? table.rows : []).filter((r) => r && typeof r === 'object' && r.cells && typeof r.cells === 'object');
  const out: unknown[] = columns.map((c) => c.label);
  for (const r of rows) for (const c of columns) out.push(Object.hasOwn(r.cells, c.id) ? r.cells[c.id] : '');
  return out;
}

/**
 * Foundation's comparison of plans, as the release shows it (and its Markdown writes it): each plan (the third only
 * while it is named) with its price and period, each feature with its detail and each plan's value and note (the
 * included and excluded labels where a plan uses them), and the plans' buttons that go somewhere. A part its
 * placement hides at every size is left out.
 */
function comparisonWords(state: ProjectState, def: ComponentDefinition, props: Record<string, unknown>, n: InstanceNode): unknown[] {
  const hiddenPart = (part: string, itemId?: string) => codePartsHidden(def, n, [part], itemId);
  type Plan = { key: 'one' | 'two' | 'three'; name?: unknown; price?: unknown; period?: unknown; actionLabel?: unknown; actionLink?: unknown };
  const plans: Plan[] = (['one', 'two', 'three'] as const)
    .map((key) => {
      const v = props[`plan${key[0].toUpperCase()}${key.slice(1)}`];
      return { ...(v && typeof v === 'object' ? (v as Omit<Plan, 'key'>) : {}), key };
    })
    .filter((p) => p.key !== 'three' || oneLine(p.name));
  const schema = def.properties.features;
  const fields = schema?.type === 'list' ? schema.fields : {};
  // A row's value the placement never set is its field's default, as the site fills it in; a list handed in by the
  // design around it arrives as that design gives it.
  const filled = !isBinding(n.props.features);
  const field = (r: Record<string, unknown>, k: string) => (Object.hasOwn(r, k) || !filled ? r[k] : Object.hasOwn(fields, k) ? (fields[k] as { default?: unknown }).default : undefined);
  const features = Array.isArray(props.features) ? (props.features as Array<Record<string, unknown>>).filter((r) => r && typeof r === 'object') : [];
  const shown = !hiddenPart('plans');
  const out: unknown[] = plans.flatMap((p) => [p.name, ...(shown ? [hiddenPart('price') ? '' : p.price, p.period] : [])]);
  for (const r of features) {
    const id = typeof r.id === 'string' ? r.id : undefined;
    out.push(hiddenPart('feature', id) ? '' : field(r, 'feature'), field(r, 'detail'));
    for (const p of plans) {
      const v = field(r, p.key);
      out.push(v === 'included' ? props.includedLabel : v === 'excluded' ? props.excludedLabel : '', field(r, `${p.key}Note`));
    }
  }
  for (const p of plans) if (resolveLink(p.actionLink as LinkValue | undefined, { state })) out.push(p.actionLabel);
  return out;
}

function plain(value: unknown): string {
  try {
    return richTextToPlain(toRichText(value));
  } catch {
    return '';
  }
}

/**
 * Whether an entry is left out of the site's own search. Read as the post writer's switch reads it, as a page's is.
 */
export function entrySearchHidden(entry: EntryDoc): boolean {
  return !!entry.seo?.searchHidden;
}

/**
 * The entry fields a record's layout shows that search does not read from its page: the title, excerpt and text, found
 * as the entry's own, and the links to the entries before and after it, which name other records.
 */
const FOUND_OTHERWISE: ReadonlySet<string> = new Set(['title', 'excerpt', 'body', 'prevEntry', 'prevEntry.title', 'prevEntry.label', 'nextEntry', 'nextEntry.title', 'nextEntry.label', 'entryNavLabel']);

/** The entry field a piece of an entry's page reads, by the layout's own binding at the node that shows it. */
function readsEntry(template: NodeTree | undefined, c: RenderedContent): string | undefined {
  const node = template?.nodes && Object.hasOwn(template.nodes, c.nodeId) ? (template.nodes[c.nodeId] as unknown as Record<string, unknown>) : undefined;
  if (!node || !c.source) return undefined;
  const props = node.props as Record<string, unknown> | undefined;
  const binding = c.source.kind === 'node' ? node[c.source.field] : !c.source.itemId && props && Object.hasOwn(props, c.source.prop) ? props[c.source.prop] : undefined;
  return isEntryBinding(binding) ? binding.$entry : undefined;
}

/**
 * The words of an entry search finds: its excerpt, and its text where its page shows it (a collection layout without
 * the entry's text leaves it off the website, as the Markdown copies do), one line per field that has any. A record
 * (an entry of a structured collection) is also found by everything else its page shows: its custom fields and
 * groupings as its layout places them (a price as the site writes it, a choice by its label, its categories' names),
 * and the layout's own words, less what a condition or a hide leaves off its page.
 */
export function entryText(state: ProjectState, collection: Collection, entry: EntryDoc): string {
  // The page in full, its text included, so a section that shows something only beside the text shows it here too;
  // the text itself is read once, from the entry.
  const article = entryArticle(state, collection, entry, { body: true });
  const lines = [oneLine(entry.excerpt), showsBody(collection, article) ? oneLine(plain(entry.body)) : ''];
  if (collectionKind(collection.settings) === 'structured') {
    const template = collection.settings.template;
    lines.push(treeText(state, article, (c) => FOUND_OTHERWISE.has(readsEntry(template, c) ?? '')));
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Every page visitors can find, in page order, then every published entry: the collections by ID, each one's entries
 * in its own order. A search that matches a page and a post equally lists the page first.
 */
export function buildSearchIndex(state: ProjectState): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const id of state.site.pageOrder) {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    // A draft is not a page of the website: like the sitemap, the index never lists one.
    if (!page || searchHidden(page) || isDraftPage(state, page)) continue;
    const alias = oneLine(page.seo?.title);
    // A result is a link named by its title: a page with none is named by its browser title, else its address.
    const title = oneLine(page.title) || alias || page.route;
    const entry: SearchEntry = { route: page.route, title, text: pageText(state, page) };
    if (alias && alias !== title) entry.alias = alias;
    const description = oneLine(page.seo?.description);
    if (description) entry.description = description;
    out.push(entry);
  }
  // Drafts leave before addresses are shared out, so a post whose address a draft held first is found where it is.
  const live = publishedState(state);
  for (const { collection, entry, route } of siteEntries(live)) {
    if (entrySearchHidden(entry)) continue;
    const alias = oneLine(entry.seo?.title);
    const title = oneLine(entry.title) || alias || route;
    const found: SearchEntry = { route, title, text: entryText(live, collection, entry) };
    if (alias && alias !== title) found.alias = alias;
    const description = oneLine(entry.seo?.description) || oneLine(entry.excerpt);
    if (description) found.description = description;
    out.push(found);
  }
  return out;
}

/** A module path that names the search code, with or without its extension, however the path leads to it. */
const NAMES_HELPER = /['"`][^'"`\n]*site-search(?:\.js)?['"`]/;

/**
 * Whether a component of the site searches it: its code names the search code (however it spells the path there).
 * Naming it without importing it only writes two files the build leaves alone.
 */
export function usesSiteSearch(state: ProjectState): boolean {
  return Object.values(state.components).some((def) => def.kind === 'code' && typeof def.source === 'string' && NAMES_HELPER.test(def.source));
}

/** Whether a code component searches the site: its code names the search code, as usesSiteSearch reads it. */
export function searchesSite(def: ComponentDefinition): boolean {
  return def.kind === 'code' && typeof def.source === 'string' && NAMES_HELPER.test(def.source);
}

/**
 * Code that reads its page's address, not only a form it submits: `location.search`, `new URL(location.href)` or
 * SvelteKit's `page.url.searchParams`, with a `q` parameter read from it (directly, or through a variable).
 */
const READS_ADDRESS = /\blocation\.search\b|new\s+URL\(\s*(?:window\.|document\.)?location(?:\.href)?\s*\)|\bpage\.url\.searchParams\b/;
const READS_Q = /\.get\(\s*['"`]q['"`]\s*\)/;

/**
 * Whether a component runs a search of the site from its page's address (`?q=` in the URL), as the theme's Site search
 * does for a link to a search: its code names the search code and reads the `q` parameter of its page's address.
 */
export function searchesFromAddress(def: ComponentDefinition | undefined): boolean {
  return !!def && def.kind === 'code' && typeof def.source === 'string' && NAMES_HELPER.test(def.source) && READS_ADDRESS.test(def.source) && READS_Q.test(def.source);
}

/** The index as a module: the same pages always give the same bytes. */
export function generateSearchIndex(state: ProjectState): string {
  const data = JSON.stringify(buildSearchIndex(state)).replace(/</g, '\\u003c');
  return `// Generated by SiteOrigin Builder from the pages in siteorigin/pages/ and the posts in siteorigin/collections/. Do not edit: changes are overwritten.\n// The pages Site search finds, in page order, then the posts.\nexport default ${data};\n`;
}

/** The search code's line naming the SearchSocket service it asks: none, for the site's own index. */
const SERVICE_LINE = `/**
 * The SearchSocket service this website asks (src/shared/site-search.ts in SiteOrigin Builder), with the address the
 * website is published at; null while it searches its own index.
 */
const SERVICE = null;`;

/**
 * How site search and collection browsing compare text, as source for the code they ship: lower case, without accents,
 * a Japanese voicing mark joined to its kana. `fold(text)` is the text as compared.
 */
export const FOLD_JS = `const ASCII = /^[\\x00-\\x7f]*$/;
/** What belongs to the character before it: an accent or other mark, or an emoji's skin tone. */
const JOINS = /^[\\p{M}\\p{Emoji_Modifier}\\uff9e\\uff9f]/u;

/** One character as search compares it: lower case, without accents, and a final sigma like any other. */
function foldChar(c) {
	if (c.charCodeAt(0) < 0x80) return c.toLowerCase();
	const d = c.normalize('NFKD');
	return (d.includes('\\u3099') || d.includes('\\u309a') ? d.normalize('NFC') : d).replace(/(?![\\u3099\\u309a])\\p{M}/gu, '').toLowerCase().replace(/\\u03c2/g, '\\u03c3');
}

/**
 * Adds the next folded character to the folded characters so far, and returns how many it added. A Japanese voicing
 * mark is part of its kana ("か" and "が" are different letters), so it joins the kana before it, however the text
 * spells it, precomposed or not: that adds none.
 */
function join(parts, f) {
	if (!f) return 0;
	if (parts.length && (f === '\\u3099' || f === '\\u309a')) {
		const last = parts[parts.length - 1];
		const c = (last.slice(-1) + f).normalize('NFC');
		if (c.length === 1) {
			parts[parts.length - 1] = last.slice(0, -1) + c;
			return 0;
		}
	}
	parts.push(f);
	return f.length;
}

/** Text as search compares it. */
function fold(text) {
	if (ASCII.test(text)) return text.toLowerCase();
	const parts = [];
	for (const c of text) join(parts, foldChar(c));
	return parts.join('');
}
`;

/**
 * The search code as the website runs it. Plain JavaScript with no dependencies, so the site needs nothing else to
 * search. Matching ignores case and accents ("cafe" finds "Café") but not Japanese voicing marks ("かぎ" is not "かき"), and a page matches when every word searched for
 * is in its title, browser title, description or content. A page named exactly by the search comes first, then pages
 * whose title has the words as a phrase, then pages that have the phrase anywhere, then the rest, each group in page
 * order. Highlights and passages are cut where they never split a character from its accents.
 */
export const SEARCH_JS = `// Generated by SiteOrigin Builder. Site search for this website: finds the pages that have every word searched for.

/** The pages that can be found, from the index generated with the site. Loaded the first time a visitor searches. */
export function loadPages() {
	return import('./${SEARCH_INDEX_FILE}').then((m) => m.default);
}

${SERVICE_LINE}

/** How many results show at once. */
export const SHOWN = 20;
/** About how many characters of a page's text show under its title, and how many of them come before the match. */
const EXCERPT = 180;
const LEAD = 60;

${FOLD_JS}
/**
 * Text as search compares it, with where each folded character's character starts and ends in the text, so a match
 * maps back to what the visitor sees (\`from\` and \`to\` are absent when they are the same).
 */
function foldMap(text) {
	if (ASCII.test(text)) return { text: text.toLowerCase() };
	const parts = [];
	const from = [];
	const to = [];
	let i = 0;
	for (const c of text) {
		const f = foldChar(c);
		const added = join(parts, f);
		if (!added && f) to[to.length - 1] = i + c.length;
		for (let k = 0; k < added; k++) {
			from.push(i);
			to.push(i + c.length);
		}
		i += c.length;
	}
	return { text: parts.join(''), from, to };
}

const startOf = (f, at) => (f.from ? f.from[at] : at);
const endOf = (f, end) => (f.to ? f.to[end - 1] : end);

/**
 * The nearest place at or after \`i\` that splits no character: not inside a surrogate pair, not before the accents
 * of the character before it, not inside a sequence joined by a zero-width joiner.
 */
function settle(text, i) {
	while (i > 0 && i < text.length) {
		const code = text.charCodeAt(i);
		const before = text.charCodeAt(i - 1);
		if (code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff) i++;
		else if (code === 0x200d || before === 0x200d || JOINS.test(text.slice(i, i + 2))) i += text.codePointAt(i) > 0xffff ? 2 : 1;
		else break;
	}
	return i;
}

/** The words searched for, folded. */
export function searchWords(query) {
	return fold(String(query ?? '')).split(/\\s+/).filter(Boolean);
}

// Each page is folded once, the first time it is searched.
const prepared = new WeakMap();
function prepare(page) {
	let p = prepared.get(page);
	if (!p) {
		const f = (s) => (typeof s === 'string' && s ? fold(s) : '');
		p = { title: f(page.title), alias: f(page.alias), description: f(page.description), text: f(page.text) };
		prepared.set(page, p);
	}
	return p;
}

/**
 * Short text as parts to show, every place a word searched for is in it marked: overlapping places are one mark,
 * and so are places only spaces part, so a phrase found reads as one.
 */
function highlight(text, words) {
	const f = foldMap(text);
	const ranges = [];
	for (const w of words) {
		for (let at = f.text.indexOf(w); at >= 0; at = f.text.indexOf(w, at + 1)) ranges.push([startOf(f, at), settle(text, endOf(f, at + w.length))]);
	}
	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const out = [];
	let at = 0;
	let open = null;
	const close = () => {
		if (open[0] > at) out.push({ text: text.slice(at, open[0]), mark: false });
		out.push({ text: text.slice(open[0], open[1]), mark: true });
		at = open[1];
	};
	for (const r of ranges) {
		if (open && (r[0] <= open[1] || !text.slice(open[1], r[0]).trim())) open[1] = Math.max(open[1], r[1]);
		else {
			if (open) close();
			open = [r[0], r[1]];
		}
	}
	if (open) close();
	if (text.length > at) out.push({ text: text.slice(at), mark: false });
	return out;
}

/** Where the character a place in the folded text came from starts in the text. Reads no further than that place. */
function originalAt(text, at) {
	if (ASCII.test(text)) return at;
	const parts = [];
	let folded = 0;
	let i = 0;
	for (const c of text) {
		folded += join(parts, foldChar(c));
		if (folded > at) return i;
		i += c.length;
	}
	return i;
}

/** A passage of the text around a place in its folded form (its start, without one), cut at spaces where it can. */
function passage(text, words, at) {
	const center = at >= 0 ? originalAt(text, at) : 0;
	let start = Math.max(0, center - LEAD);
	if (start > 0) {
		// From the first space before the match; in writing without spaces, from where the passage would start.
		const space = text.slice(start, center).search(/\\s/);
		start = settle(text, space >= 0 ? start + space + 1 : start);
	}
	let end = Math.min(text.length, start + EXCERPT);
	if (end < text.length) {
		const space = Math.max(text.lastIndexOf(' ', end), text.lastIndexOf('\\n', end));
		end = space > center ? space : settle(text, end);
	}
	const out = highlight(text.slice(start, end).replace(/\\n/g, ' '), words);
	if (start > 0) out.unshift({ text: '…', mark: false });
	if (end < text.length) out.push({ text: '…', mark: false });
	return out;
}

/** Where in folded text a search matched: the whole phrase, else the earliest word. -1 when nothing did. */
function firstMatch(text, words, phrase) {
	const at = text.indexOf(phrase);
	if (at >= 0) return at;
	let first = -1;
	for (const w of words) {
		const i = text.indexOf(w);
		if (i >= 0 && (first < 0 || i < first)) first = i;
	}
	return first;
}

/** The passage that shows why a page matched: from its content, else its description, else how either starts. */
function excerpt(page, p, words, phrase) {
	for (const key of ['text', 'description']) {
		if (!p[key]) continue;
		const at = firstMatch(p[key], words, phrase);
		if (at >= 0) return passage(page[key], words, at);
	}
	const key = p.description ? 'description' : p.text ? 'text' : null;
	return key ? passage(page[key], words, -1) : [];
}

/**
 * Search the pages. Returns how many pages matched and the first \`limit\` of them, best first, each with its
 * address, its title and a passage of its text, as parts to show with the words searched for marked.
 */
export function searchPages(pages, query, limit = SHOWN) {
	const words = searchWords(query);
	if (!words.length || !Array.isArray(pages)) return { total: 0, results: [] };
	const phrase = words.join(' ');
	const unique = [...new Set(words)];
	const found = [];
	pages.forEach((page, order) => {
		if (!page || typeof page.route !== 'string') return;
		const p = prepare(page);
		const fields = [p.title, p.alias, p.description, p.text].filter(Boolean);
		if (!unique.every((w) => fields.some((t) => t.includes(w)))) return;
		let score = 0;
		if (p.title === phrase) score += 1000;
		else if (p.alias === phrase) score += 500;
		if (p.title.includes(phrase)) score += 300;
		else if (p.alias.includes(phrase)) score += 200;
		else if (fields.some((t) => t.includes(phrase))) score += 100;
		for (const w of unique) if (p.title.includes(w) || p.alias.includes(w)) score += 10;
		found.push({ page, p, score, order });
	});
	found.sort((a, b) => b.score - a.score || a.order - b.order);
	return {
		total: found.length,
		results: found.slice(0, Math.max(0, limit)).map(({ page, p }) => ({
			route: page.route,
			title: typeof page.title === 'string' ? highlight(page.title, unique) : [],
			excerpt: excerpt(page, p, unique, phrase)
		}))
	};
}

/** Text on one line, or nothing for anything that is not text. */
const line = (value) => (typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '');

/** Words for a text directive (\`#:~:text=\`), encoded so none of them reads as its syntax: a dash, comma or ampersand. */
const directive = (text) => encodeURIComponent(text).replace(/-/g, '%2D');

/** The address a root-relative result is read against. A result that names this host still reads as from the root. */
const ROOT = 'https://site.invalid';

/**
 * Where a result of the search service leads on this website: its page's address from the site's root, and the part
 * of the page after it (\`#…\`). The service names a page from the built site's root ("/about/"), or by its full
 * published address on this website. Null for anything else: another website, or an address no link should follow.
 */
function siteAddress(value) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text || /[\\u0000-\\u001f\\u007f\\\\]/.test(text)) return null;
	const rooted = text.startsWith('/') && !text.startsWith('//');
	if (!rooted && !/^https?:\\/\\//i.test(text)) return null;
	let url;
	try {
		url = new URL(text, ROOT + '/');
	} catch {
		return null;
	}
	if (url.username || url.password) return null;
	let route = url.pathname;
	if (!rooted) {
		const here = typeof location !== 'undefined' ? location.origin : null;
		if (url.origin !== here && url.origin !== SERVICE.origin) return null;
		// A full address is where the website is published: under its sub-path, which the link puts back.
		const base = SERVICE.base;
		if (base) {
			if (route !== base && !route.startsWith(base + '/')) return null;
			route = route.slice(base.length) || '/';
		}
	}
	// The address as a link to the site's page takes it (SvelteKit's resolve reads brackets and parentheses as a route's
	// parameters and groups, and refuses "//"), its page's address as the site writes it: with its closing slash.
	if (!/^(?:\\/[^/[\\]()]+)*\\/?$/.test(route) || /%(?![0-9a-f]{2})|%2f|%5c/i.test(route)) return null;
	try {
		// Escapes that spell no text (invalid UTF-8) are refused by the router as the visitor follows the link.
		decodeURIComponent(route);
	} catch {
		return null;
	}
	if (!route.endsWith('/') && !/\\.[a-z0-9]+$/i.test(route.slice(route.lastIndexOf('/')))) route += '/';
	return { route, hash: url.hash.replace(/:~:.*$/, '').replace(/^#$/, '') };
}

/**
 * The words a result's page is opened at: the heading of the part that matched, else the start of the passage found,
 * when it reads as the page shows it (no Markdown marks). Nothing when neither will do.
 */
function textTarget(row) {
	const chunk = Array.isArray(row.chunks) && row.chunks[0] && typeof row.chunks[0] === 'object' ? row.chunks[0] : {};
	// A heading as the page shows it; one the service shortened says less than the page does.
	const heading = [row.sectionTitle, chunk.sectionTitle].map(line).find((h) => h && !/\\u2026|\\.{3}/.test(h));
	if (heading) return heading;
	// Else the longest run of the passage between the service's ellipses, from its first word.
	const passage = line(typeof chunk.snippet === 'string' ? chunk.snippet : row.snippet)
		.split(/\\s*(?:\\u2026|\\.{3,})\\s*/)
		.reduce((a, b) => (b.length > a.length ? b : a), '');
	if (!passage || /[*_\`[\\]<>#|]/.test(passage)) return '';
	return passage.split(' ').slice(0, 12).join(' ');
}

/** A passage the service gave, cut to about the length of the site's own, at a space where it can be. */
function clip(text) {
	if (text.length <= EXCERPT) return text;
	const space = text.lastIndexOf(' ', EXCERPT);
	return text.slice(0, space > LEAD ? space : settle(text, EXCERPT)) + '…';
}

/**
 * Ask the SearchSocket service. Its pages come in its own order, best first, each once, without those that lead off
 * this website. A search the service cannot answer (it is unreachable, refuses the website, or answers with
 * something that is not a search) fails, as a search of the site's own index that cannot load does.
 */
async function askService(query, signal, limit) {
	const words = searchWords(query);
	if (!words.length) return { total: 0, results: [] };
	if (!SERVICE.endpoint) throw new Error('Site search has no SearchSocket address to ask.');
	const request = { q: String(query).trim(), topK: Math.min(100, Math.max(1, limit)), groupBy: 'page' };
	if (SERVICE.pathPrefix) request.pathPrefix = SERVICE.pathPrefix;
	const response = await fetch(SERVICE.endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(request),
		credentials: 'omit',
		signal
	});
	if (!response.ok) throw new Error('The search service answered ' + response.status + '.');
	const answer = await response.json();
	if (!answer || typeof answer !== 'object' || !Array.isArray(answer.results)) throw new Error('The search service did not answer with results.');
	const unique = [...new Set(words)];
	const seen = new Set();
	const results = [];
	for (const row of answer.results) {
		if (results.length >= limit) break;
		if (!row || typeof row !== 'object') continue;
		const at = siteAddress(row.url);
		if (!at || seen.has(at.route)) continue;
		seen.add(at.route);
		let fragment = '';
		// Text a link can't carry (a lone surrogate) opens the page where its address leads, losing no other result.
		try {
			const target = SERVICE.scrollToText ? textTarget(row) : '';
			if (target) fragment = (at.hash || '#') + ':~:text=' + directive(target);
		} catch {
			fragment = '';
		}
		const passage = line(Array.isArray(row.chunks) && row.chunks[0] && typeof row.chunks[0].snippet === 'string' ? row.chunks[0].snippet : row.snippet);
		results.push({
			route: at.route,
			hash: fragment || at.hash,
			reload: !!fragment,
			title: highlight(line(row.title) || at.route, unique),
			excerpt: passage ? highlight(clip(passage), unique) : []
		});
	}
	return { total: results.length, results };
}

/**
 * Search the site the way its settings say: in the index written with it, or by asking its SearchSocket service.
 * Returns how many pages matched and the first \`limit\` of them, best first, each with its address on the site
 * (\`route\`), what follows that address in its link (\`hash\`, none for the site's own index), whether the link loads
 * its page afresh (\`reload\`: the browser then scrolls to the words in \`hash\`), and its title and a passage as parts
 * to show. \`signal\` stops a request to the service no longer wanted.
 */
export async function searchSite(query, { signal, limit = SHOWN } = {}) {
	const most = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : SHOWN;
	if (SERVICE) return askService(query, signal, most);
	const pages = await loadPages();
	return searchPages(pages, query, most);
}
`;

/**
 * The search code of a site: SEARCH_JS, bound to the SearchSocket service while the site's settings choose one. The
 * address the service is asked at and the part of the site it searches are the settings', never the caller's, so code
 * that imports the search code cannot point it anywhere else.
 */
export function searchJs(state: ProjectState): string {
  const service = searchService(state.site);
  if (!service) return SEARCH_JS;
  const url = publicUrl(state.site);
  const value = { endpoint: service.endpoint ?? '', pathPrefix: service.pathPrefix, scrollToText: service.scrollToText, base: siteMount(state.site), origin: url ? new URL(url).origin : null };
  const bound = SERVICE_LINE.replace('const SERVICE = null;', () => `const SERVICE = ${JSON.stringify(value).replace(/</g, '\\u003c')};`);
  return SEARCH_JS.replace(SERVICE_LINE, () => bound);
}
