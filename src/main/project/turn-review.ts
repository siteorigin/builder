/**
 * What a History step changed, in the editor's words, for reviewing an earlier AI turn (issue 164): each document the
 * step wrote is named by what it holds (a page by its title, the site settings, the header), and each property that
 * changed there by the name the Inspector gives it, with the value it had and the value it was given.
 */
import type { StepChange } from '@shared/api';
import type { GraphNode, NodeTree, ProjectState } from '@shared/types';
import { displayName } from '@engine/tree';
import { CUSTOM_SOURCE_RE, DOC_DIR, MANIFEST_FILE, collectionDocPath, collectionPathOf, componentDocPath, entryDocPath } from './documents';

/** A document's two versions: absent (null) when the step added or deleted it. Each is the parsed document. */
export interface DocVersions {
  path: string;
  before: unknown;
  after: unknown;
}

/** Changes listed for one document before the rest are summed up in one line. */
const MAX_PER_DOC = 12;

const PAGE_DOC = new RegExp(`^${DOC_DIR}/pages/([^/]+)\\.json$`);
const COMPONENT_DOC = new RegExp(`^${DOC_DIR}/components/([^/]+)/component\\.json$`);

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
  if (same(a, b)) return null;
  const [before, after] = [shown(a), shown(b)];
  const none = (v: unknown) => v === undefined || v === null || v === '';
  // A value with no single form (a list, an image) is said to have changed, never shown as a different one.
  if ((!none(a) && before === undefined) || (!none(b) && after === undefined)) return { owner, property, change: 'changed' };
  if (before === after) return null;
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
          // An item edited in place keeps its name: it is one item changed, not one removed and one added.
          const added = comeNames.filter((n): n is string => !!n && !goneNames.includes(n));
          const dropped = goneNames.filter((n): n is string => !!n && !comeNames.includes(n));
          for (const n of added) out.push({ owner, property: item, change: 'added', after: n });
          for (const n of dropped) out.push({ owner, property: item, change: 'removed', before: n });
          const edited = Math.max(comeNames.length - added.length, goneNames.length - dropped.length);
          if (edited) out.push({ owner, property: label, change: 'changed', detail: `${plural(edited, 'item')} changed` });
          continue;
        }
        out.push(valueChange(owner, label, p, q) ?? { owner, property: label, change: 'changed' });
      }
    }
    if (!said) other++;
  }
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
  ['Draft', (p) => p.draft],
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
  if (CUSTOM_SOURCE_RE.test(path)) return existence(path.split('/').at(-1)!.replace(/\.svelte$/, ''), 'Component code');
  const collection = collectionPathOf(path);
  if (collection) return existence(words((b ?? a)?.title) ?? words((b ?? a)?.name) ?? collection.entryId ?? collection.collectionId, collection.entryId ? 'Entry' : 'Collection');
  return existence(path, 'File');
}

/** What a History step changed across its documents, each document's list capped and the rest summed up. */
export function stepChanges(docs: DocVersions[], state: ProjectState): StepChange[] {
  const out: StepChange[] = [];
  for (const d of docs) {
    const list = docChanges(d, state);
    out.push(...list.slice(0, MAX_PER_DOC));
    if (list.length > MAX_PER_DOC) out.push({ owner: list[0].owner, property: 'Other changes', change: 'changed', detail: `${list.length - MAX_PER_DOC} more` });
  }
  return out;
}

/** An address the site answers, written the one way routes are: with a slash at each end. */
const asRoute = (path: string) => `/${path.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');

/** Every address the site answers: its pages' routes and the old addresses kept for them. */
export function siteAddresses(state: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(state.pages)) if (typeof p.route === 'string') out.add(asRoute(p.route));
  for (const r of Array.isArray(state.site.redirects) ? state.site.redirects : []) if (typeof r?.from === 'string') out.add(asRoute(r.from));
  return out;
}

/**
 * Links written as a full web address of this site's own (https://books.example/staff-picks/) to one of `addresses`,
 * wherever the site holds them: by where they are, and the document that holds them. Such a link names no page, so
 * nothing else notices when its page goes. None without a website address to tell this site's links apart.
 */
export function ownUrlLinks(state: ProjectState, addresses: ReadonlySet<string>): Array<{ where: string; path: string; url: string }> {
  if (!addresses.size || typeof state.site.baseUrl !== 'string') return [];
  let base: URL;
  try {
    base = new URL(state.site.baseUrl);
  } catch {
    return [];
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  const points = (target: string) => {
    try {
      const u = new URL(target);
      if (u.host.toLowerCase() !== base.host.toLowerCase() || !(u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))) return false;
      return addresses.has(asRoute(u.pathname.slice(prefix.length)));
    } catch {
      return false;
    }
  };
  const out: Array<{ where: string; path: string; url: string }> = [];
  const walk = (x: unknown, where: string, path: string) => {
    if (Array.isArray(x)) return x.forEach((y) => walk(y, where, path));
    if (!isObj(x)) return;
    if (x.type === 'url' && typeof x.target === 'string' && points(x.target)) out.push({ where, path, url: x.target });
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
