/**
 * What a History step changed, in the editor's words, for reviewing an earlier AI turn (issue 164): each document the
 * step wrote is named by what it holds (a page by its title, the site settings, the header), and each property that
 * changed there by the name the Inspector gives it, with the value it had and the value it was given.
 */
import type { StepChange } from '@shared/api';
import type { GraphNode, NodeTree, ProjectState, SiteDoc } from '@shared/types';
import { displayName } from '@engine/tree';
import { codeImports } from '@engine/definitions';
import { publicUrl } from '@shared/public-url';
import { CUSTOM_SOURCE_RE, DOC_DIR, MANIFEST_FILE, collectionDocPath, collectionPathOf, componentDocPath, entryDocPath } from './documents';

/** A document's two versions: absent (null) when the step added or deleted it. Each is the parsed document. */
export interface DocVersions {
  path: string;
  before: unknown;
  after: unknown;
}

/** Changes listed for one document before the rest are summed up in one line. */
const MAX_PER_DOC = 12;

export const PAGE_DOC = new RegExp(`^${DOC_DIR}/pages/([^/]+)\\.json$`);
export const COMPONENT_DOC = new RegExp(`^${DOC_DIR}/components/([^/]+)/component\\.json$`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);
const words = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? clip(v.replace(/\s+/g, ' ').trim()) : undefined);

/** One value as it is shown: text as written, a yes or no, a number. Undefined for none, or one with no single value. */
function shown(v: unknown): string | undefined {
  if (typeof v === 'string') return v === '' ? undefined : clip(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** A property's change from `a` to `b`, with its values when each is one; null when it did not change. */
function valueChange(owner: string, property: string, a: unknown, b: unknown): StepChange | null {
  const none = (v: unknown) => v === undefined || v === null || v === '';
  if (same(a, b) || (none(a) && none(b))) return null;
  const [before, after] = [shown(a), shown(b)];
  // A value with no single form (a list, an image) is said to have changed, never shown as a different one.
  // So is one whose two values only differ past what is shown of them.
  if ((!none(a) && before === undefined) || (!none(b) && after === undefined) || before === after) return { owner, property, change: 'changed' };
  return { owner, property, change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the text or label an element shows says, when it is plain text. */
function nodeText(n: GraphNode): unknown {
  if (n.kind === 'text') return n.rich ? undefined : n.text;
  if (n.kind === 'link') return n.label;
  return undefined;
}

/** A list item's name: its label or title, the way the Inspector's list rows name it. */
const itemName = (item: unknown) => (isObj(item) ? (words(item.label) ?? words(item.title) ?? words(item.text) ?? words(item.name)) : undefined);

/**
 * What changed in a tree of elements (a page's content, the header or footer): an element's text with its two
 * values, a list item added or removed by its name (a menu link), a property's value, and how many elements were
 * added, removed or otherwise changed. `state` names components and their properties.
 */
function treeChanges(owner: string, a: NodeTree | undefined, b: NodeTree | undefined, state: ProjectState): StepChange[] {
  const before = isObj(a?.nodes) ? (a.nodes as Record<string, GraphNode>) : {};
  const after = isObj(b?.nodes) ? (b.nodes as Record<string, GraphNode>) : {};
  const out: StepChange[] = [];
  let added = 0;
  let removed = 0;
  let other = 0;
  for (const id of Object.keys(after)) if (!Object.hasOwn(before, id)) added++;
  for (const id of Object.keys(before)) if (!Object.hasOwn(after, id)) removed++;
  for (const id of Object.keys(after)) {
    const [x, y] = [before[id], after[id]];
    if (!x || !isObj(y) || same(x, y)) continue;
    const name = displayName(state, y as GraphNode);
    let said = false;
    const text = valueChange(owner, name, nodeText(x), nodeText(y));
    if (text) {
      out.push(text);
      said = true;
    }
    if (x.kind === 'instance' && y.kind === 'instance' && isObj(x.props) && isObj(y.props)) {
      const schemas = state.components[y.definitionId]?.properties ?? {};
      for (const key of new Set([...Object.keys(x.props), ...Object.keys(y.props)])) {
        const [p, q] = [x.props[key], y.props[key]];
        if (same(p, q)) continue;
        const schema = Object.hasOwn(schemas, key) ? schemas[key] : undefined;
        const label = schema?.label || key;
        said = true;
        if (Array.isArray(p) || Array.isArray(q)) {
          const [ps, qs] = [Array.isArray(p) ? p : [], Array.isArray(q) ? q : []];
          const keys = (list: unknown[]) => new Set(list.map((i) => JSON.stringify(i)));
          const [pk, qk] = [keys(ps), keys(qs)];
          const item = (schema?.type === 'list' && schema.itemLabel) || label;
          const goneNames = ps.filter((i) => !qk.has(JSON.stringify(i))).map(itemName);
          const comeNames = qs.filter((i) => !pk.has(JSON.stringify(i))).map(itemName);
          const [gone, come] = [new Set(goneNames), new Set(comeNames)];
          // An item edited in place keeps its name: it is one item changed, not one removed and one added.
          const added = comeNames.filter((n): n is string => !!n && !gone.has(n));
          const dropped = goneNames.filter((n): n is string => !!n && !come.has(n));
          for (const n of added) out.push({ owner, property: item, change: 'added', after: n });
          for (const n of dropped) out.push({ owner, property: item, change: 'removed', before: n });
          const edited = Math.max(comeNames.length - added.length, goneNames.length - dropped.length);
          if (edited) out.push({ owner, property: label, change: 'changed', detail: `${plural(edited, 'item')} changed` });
          // The same items in another order.
          else if (!added.length && !dropped.length) out.push({ owner, property: label, change: 'changed', detail: 'Order changed' });
          continue;
        }
        out.push(valueChange(owner, label, p, q) ?? { owner, property: label, change: 'changed' });
      }
    }
    if (!said) other++;
  }
  // Sections moved on the page, the same ones still there.
  if (!added && !removed && !same(a?.rootIds, b?.rootIds)) out.push({ owner, property: 'Sections', change: 'changed', detail: 'Order changed' });
  const counts = [added && `${plural(added, 'element')} added`, removed && `${plural(removed, 'element')} removed`, other && `${plural(other, 'element')} changed`].filter(Boolean);
  if (counts.length) out.push({ owner, property: 'Content', change: 'changed', detail: counts.join(', ') });
  return out;
}

const PAGE_FIELDS: Array<[string, (p: Obj) => unknown]> = [
  ['Title', (p) => p.title],
  ['Address', (p) => p.route],
  ['Menu label', (p) => p.navLabel],
  ['Browser title', (p) => (isObj(p.seo) ? p.seo.title : undefined)],
  ['Description', (p) => (isObj(p.seo) ? p.seo.description : undefined)],
  ['Shows the header', (p) => p.showHeader],
  ['Shows the footer', (p) => p.showFooter],
  // Unset is published.
  ['Draft', (p) => p.draft === true],
  ['Language', (p) => p.language]
];

function pageChanges(a: Obj | null, b: Obj | null, state: ProjectState): StepChange[] {
  const owner = words((b ?? a)?.title) ?? 'A page';
  if (!a) return [{ owner, property: 'Page', change: 'added', ...(typeof b?.route === 'string' ? { after: b.route } : {}) }];
  if (!b) return [{ owner, property: 'Page', change: 'removed', ...(typeof a.route === 'string' ? { before: a.route } : {}) }];
  const out = PAGE_FIELDS.map(([name, read]) => valueChange(owner, name, read(a), read(b))).filter((c): c is StepChange => !!c);
  const seo = (p: Obj) => (isObj(p.seo) ? { ...p.seo, title: undefined, description: undefined } : p.seo);
  if (!same(seo(a), seo(b))) out.push({ owner, property: 'Sharing and search', change: 'changed' });
  if (!same(a.article, b.article)) out.push({ owner, property: 'Article details', change: 'changed' });
  if (!same(a.rootIds, b.rootIds) || !same(a.nodes, b.nodes)) out.push(...treeChanges(owner, a as unknown as NodeTree, b as unknown as NodeTree, state));
  return out;
}

const SITE_FIELDS: Array<[string, string]> = [
  ['name', 'Site name'],
  ['description', 'Description'],
  ['language', 'Language'],
  ['direction', 'Text direction'],
  ['baseUrl', 'Website address'],
  ['notFoundHeading', 'Not-found heading'],
  ['notFoundMessage', 'Not-found message'],
  ['notFoundLinkLabel', 'Not-found link label']
];

function siteChanges(a: Obj, b: Obj, state: ProjectState): StepChange[] {
  const owner = 'Site settings';
  const out = SITE_FIELDS.map(([key, name]) => valueChange(owner, name, a[key], b[key])).filter((c): c is StepChange => !!c);
  if (!same(a.favicon, b.favicon)) out.push({ owner, property: 'Site icon', change: 'changed' });
  if (!same(a.socialImage, b.socialImage)) out.push({ owner, property: 'Sharing image', change: 'changed' });
  if (a.homePageId !== b.homePageId) out.push({ owner, property: 'Home page', change: 'changed' });
  if (!same(a.pageOrder, b.pageOrder)) {
    const [p, q] = [Array.isArray(a.pageOrder) ? a.pageOrder : [], Array.isArray(b.pageOrder) ? b.pageOrder : []];
    // A page added or removed is said by its own document; only a new order is news here.
    const kept = (x: unknown[], y: unknown[]) => x.filter((id) => y.includes(id));
    if (!same(kept(p, q), kept(q, p))) out.push({ owner, property: 'Page order', change: 'changed' });
  }
  if (!same(a.redirects, b.redirects)) out.push({ owner, property: 'Old addresses', change: 'changed' });
  if (!same(a.visitorText, b.visitorText)) out.push({ owner, property: 'Site wording', change: 'changed' });
  const shell = (s: Obj, part: 'header' | 'footer') => (isObj(s.shell) && isObj(s.shell[part]) ? (s.shell[part] as unknown as NodeTree) : undefined);
  for (const [part, name] of [
    ['header', 'Header'],
    ['footer', 'Footer']
  ] as const)
    if (!same(shell(a, part), shell(b, part))) out.push(...treeChanges(name, shell(a, part), shell(b, part), state));
  return out;
}

/** What one document's change was, in the editor's words. */
export function docChanges({ path, before, after }: DocVersions, state: ProjectState): StepChange[] {
  const a = isObj(before) ? before : null;
  const b = isObj(after) ? after : null;
  if (PAGE_DOC.test(path)) return pageChanges(a, b, state);
  if (path === `${DOC_DIR}/site.json` && a && b) return siteChanges(a, b, state);
  const existence = (owner: string, property: string): StepChange[] => [{ owner, property, change: !a && before === null ? 'added' : !b && after === null ? 'removed' : 'changed' }];
  if (path === `${DOC_DIR}/tokens.json`) return existence('Site styles', 'Colors, fonts and spacing');
  if (path === `${DOC_DIR}/theme-lock.json`) return existence('Site styles', 'Theme');
  if (path === MANIFEST_FILE) return existence('Project', 'Project details');
  if (path === `${DOC_DIR}/assets.json`) {
    const names = (d: Obj | null) => new Map(Object.values(isObj(d?.assets) ? d.assets : {}).flatMap((x) => (isObj(x) && typeof x.id === 'string' ? [[x.id, words(x.name) ?? x.id] as const] : [])));
    const [p, q] = [names(a), names(b)];
    const out: StepChange[] = [];
    for (const [id, name] of q) if (!p.has(id)) out.push({ owner: 'Library', property: 'File', change: 'added', after: name });
    for (const [id, name] of p) if (!q.has(id)) out.push({ owner: 'Library', property: 'File', change: 'removed', before: name });
    return out.length ? out : existence('Library', 'Image and file details');
  }
  const component = path.match(COMPONENT_DOC);
  if (component) return existence(words((b ?? a)?.name) ?? component[1], 'Component');
  if (CUSTOM_SOURCE_RE.test(path)) return existence(Object.values(state.components).find((d) => d.sourcePath === path)?.name ?? path.split('/').at(-1)!.replace(/\.svelte$/, ''), 'Component code');
  const collection = collectionPathOf(path);
  if (collection) return existence(words((b ?? a)?.title) ?? words((b ?? a)?.name) ?? collection.entryId ?? collection.collectionId, collection.entryId ? 'Entry' : 'Collection');
  return existence(path, 'File');
}

/** What a document holds, by name, when nothing more can be said of how it changed. */
function docOwner({ path, before, after }: DocVersions): string {
  const doc = isObj(after) ? after : isObj(before) ? before : null;
  if (PAGE_DOC.test(path)) return words(doc?.title) ?? 'A page';
  if (path === `${DOC_DIR}/site.json`) return 'Site settings';
  return words(doc?.name) ?? words(doc?.title) ?? path;
}

/**
 * What a History step changed across its documents, each document's list capped and the rest summed up. A document
 * whose change has no words here (its versions are not in the form the editor writes, or differ only in ways no row
 * names) is still listed, as changed.
 */
export function stepChanges(docs: DocVersions[], state: ProjectState): StepChange[] {
  const out: StepChange[] = [];
  for (const d of docs) {
    let list: StepChange[];
    try {
      list = docChanges(d, state);
    } catch {
      list = [];
    }
    if (!list.length) list = [{ owner: docOwner(d), property: 'Details', change: d.before === null ? 'added' : d.after === null ? 'removed' : 'changed' }];
    out.push(...list.slice(0, MAX_PER_DOC));
    if (list.length > MAX_PER_DOC) out.push({ owner: list[0].owner, property: 'Other changes', change: 'changed', detail: `${list.length - MAX_PER_DOC} more` });
  }
  return out;
}

/** An address the site answers, written the one way routes are: with a slash at each end. */
export const asRoute = (path: string) => `/${path.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');

/** Every address the site answers: its pages' routes and the old addresses kept for them. */
export function siteAddresses(state: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(state.pages)) if (typeof p.route === 'string') out.add(asRoute(p.route));
  for (const r of Array.isArray(state.site.redirects) ? state.site.redirects : []) if (typeof r?.from === 'string') out.add(asRoute(r.from));
  return out;
}

/** The site's public URLs that a typed link can name one of its own addresses by: each site settings' given. */
export function siteBases(...sites: Array<Pick<SiteDoc, 'baseUrl'> | null | undefined>): URL[] {
  const out = new Map<string, URL>();
  for (const site of sites) {
    const base = site ? publicUrl(site) : undefined;
    if (!base) continue;
    try {
      const u = new URL(base);
      out.set(u.href, u);
    } catch {
      // Not a URL: it names no address.
    }
  }
  return [...out.values()];
}

/**
 * The site addresses a typed web address opens, on each of the site's own public URLs `bases` it is on: as routes,
 * lowercased, the way a static host serves them ("/winter/index.html" is "/winter/"). Empty for any other address.
 */
export function ownAddresses(target: string, bases: readonly URL[]): string[] {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const base of bases) {
    if (url.origin !== base.origin) continue;
    const prefix = base.pathname.replace(/\/+$/, '');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue;
    let path = url.pathname.slice(prefix.length) || '/';
    try {
      path = decodeURI(path);
    } catch {
      // Kept as typed: a malformed escape names no page.
    }
    out.push(asRoute(path.replace(/\/index\.html$/i, '/')).toLowerCase());
  }
  return out;
}

/** The first site address a typed web address opens (see ownAddresses), or null. */
export const ownAddress = (target: string, bases: readonly URL[]): string | null => ownAddresses(target, bases)[0] ?? null;

/**
 * The links a document holds into what a turn made, counted by where they go: links to one of the pages `pageIds`,
 * and links typed as the site's own web address of one of `addresses` (lowercased routes). Counted per version, so a
 * change that adds one is told from one that only kept it.
 */
export function linksInto(doc: unknown, pageIds: ReadonlySet<string>, addresses: ReadonlySet<string>, bases: readonly URL[]): Map<string, number> {
  const out = new Map<string, number>();
  const count = (to: string) => out.set(to, (out.get(to) ?? 0) + 1);
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isObj(x)) return;
    if (x.type === 'page' && typeof x.target === 'string' && pageIds.has(x.target)) count(`page:${x.target}`);
    else if (x.type === 'url' && typeof x.target === 'string' && addresses.size) {
      const to = ownAddresses(x.target, bases).find((a) => addresses.has(a));
      if (to) count(`url:${to}`);
    }
    for (const y of Object.values(x)) walk(y);
  };
  walk(doc);
  return out;
}

/**
 * Every placement of one of the components `defIds` in a document, by node ID, as text to compare versions by: the
 * placement with everything inside it (its slots' content too), which is what the component's design shows.
 */
export function placementsOf(doc: unknown, defIds: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!defIds.size) return out;
  const trees: Array<Record<string, unknown>> = [];
  const find = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(find);
    if (!isObj(x)) return;
    if (isObj(x.nodes)) trees.push(x.nodes);
    for (const y of Object.values(x)) find(y);
  };
  find(doc);
  for (const nodes of trees)
    for (const [id, n] of Object.entries(nodes)) {
      if (!isObj(n) || n.kind !== 'instance' || typeof n.definitionId !== 'string' || !defIds.has(n.definitionId)) continue;
      const inside: unknown[] = [];
      const seen = new Set<string>([id]);
      const queue = [n];
      while (queue.length) {
        const x = queue.shift()!;
        const kids = [...(Array.isArray(x.children) ? x.children : []), ...Object.values(isObj(x.slots) ? x.slots : {}).flatMap((v) => (Array.isArray(v) ? v : []))];
        for (const k of kids) {
          if (typeof k !== 'string' || seen.has(k) || !isObj(nodes[k])) continue;
          seen.add(k);
          inside.push(nodes[k]);
          queue.push(nodes[k] as Obj);
        }
      }
      out.set(id, JSON.stringify([n, ...inside]));
    }
  return out;
}

/**
 * Links typed as the site's own web address (https://books.example/staff-picks/) to one of `addresses` (lowercased
 * routes), wherever the site holds them: by where they are, and the document that holds them. Such a link names no
 * page, so nothing else notices when its page goes.
 */
export function ownUrlLinks(state: ProjectState, addresses: ReadonlySet<string>, bases: readonly URL[]): Array<{ where: string; path: string; url: string }> {
  if (!addresses.size || !bases.length) return [];
  const out: Array<{ where: string; path: string; url: string }> = [];
  const walk = (x: unknown, where: string, path: string) => {
    if (Array.isArray(x)) return x.forEach((y) => walk(y, where, path));
    if (!isObj(x)) return;
    if (x.type === 'url' && typeof x.target === 'string' && ownAddresses(x.target, bases).some((a) => addresses.has(a))) out.push({ where, path, url: x.target });
    for (const y of Object.values(x)) walk(y, where, path);
  };
  const site = `${DOC_DIR}/site.json`;
  walk(state.site.shell.header, 'Header', site);
  walk(state.site.shell.footer, 'Footer', site);
  for (const p of Object.values(state.pages)) walk(p, p.title, `${DOC_DIR}/pages/${p.id}.json`);
  for (const def of Object.values(state.components)) walk(def, def.name, componentDocPath(def.id));
  for (const [id, c] of Object.entries(state.collections ?? {})) {
    walk(c.settings, c.settings.name, collectionDocPath(id));
    for (const [eid, e] of Object.entries(c.entries)) walk(e, words((e as unknown as Obj).title) ?? c.settings.name, entryDocPath(id, eid));
  }
  return out;
}

/**
 * Components that render one another in a loop, as the IDs along it (the first repeated at the end), or null. A design
 * renders what it places, and code what it imports, read from its source as well as what it declares: the check the
 * project itself makes reads only the declarations, which code written by hand does not always make.
 */
export function componentCycle(state: ProjectState): string[] | null {
  const defs = Object.values(state.components);
  const deps = (id: string): string[] => {
    const d = state.components[id];
    if (!d) return [];
    if (d.kind === 'code') return defs.filter((t) => codeImports(state, d, t.id)).map((t) => t.id);
    return Object.values(d.tree?.nodes ?? {}).flatMap((n) => (n.kind === 'instance' ? [n.definitionId] : []));
  };
  const seen = new Map<string, 'open' | 'done'>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (seen.get(id) === 'done') return null;
    if (seen.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    seen.set(id, 'open');
    for (const dep of deps(id)) {
      const c = visit(dep, [...path, id]);
      if (c) return c;
    }
    seen.set(id, 'done');
    return null;
  };
  for (const id of Object.keys(state.components).sort()) {
    const c = visit(id, []);
    if (c) return c;
  }
  return null;
}
