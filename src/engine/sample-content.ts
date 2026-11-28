/**
 * Sample content the published site still shows (#1640), for Project health to name: a placed component's defaults its
 * design marks as sample content (shared/sample-defaults.ts), a basic element's words as it was inserted
 * (shared/element-stubs.ts), and the Business starter's own copy and photos. Each finding leads to the field or element
 * that holds it, and the author can keep one as it is: that value at that place stops being named, and nothing else
 * does (withoutKeptSamples). Only what the published site shows counts: drafts, values a list's collection or the
 * site's pages fill in, words the site leaves out (a button with nowhere to go, text a section shows only in another
 * state), and fields only code reads, whose markup decides, are left out. The sample contact details and images not
 * chosen yet are reviewed elsewhere, so none of these names them.
 */
import type { ComponentDefinition, NodeTree, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { hiddenInTree, renderedContentKnown, renderedTables, treeParents, type RenderedContent } from '@generator/checks';
import { teaserFields } from '@shared/page-teasers';
import { resolveLink } from '@generator/index';
import { STARTER_ASSETS, businessStarterCopy, type StarterAsset } from '@catalogue/starters';
import { ELEMENT_STUBS } from '@shared/element-stubs';
import { holdsSampleContact } from '@shared/sample-contact';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { stableHash } from '@shared/ids';
import { allTrees } from './tree';
import { isBackgroundPath } from './image-uses';
import type { Diagnostic } from './validate';
import type { CheckedTree, Keeper } from './validation-cache';

/** The codes of these findings: a design's sample default, an element's first words, the Business starter's copy and photos. */
export const SAMPLE_CODES: ReadonlySet<string> = new Set(['SAMPLE_DEFAULT', 'SAMPLE_ELEMENT_STUB', 'SAMPLE_STARTER_COPY', 'SAMPLE_STARTER_PHOTO']);

export const isSampleFinding = (d: Pick<Diagnostic, 'code'>) => SAMPLE_CODES.has(d.code);

/** Where a finding is fixed: a placement's field (a list item's, or an object's), an element, or a site or page setting. */
export type SamplePlace =
  | { kind: 'prop'; nodeId: string; prop: string; itemId?: string; field?: string }
  | { kind: 'element'; nodeId: string }
  | { kind: 'site'; field: 'description' | 'socialImage' }
  | { kind: 'pageSeo'; pageId: string; field: 'description' | 'socialImage' };

/** JSON with object keys in order, so two values that differ only in key order are written the same. */
const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x)) ?? 'null';

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/**
 * A finding's `site`: where it is, and the value found there. Keeping a finding keeps that value at that place: another
 * sample there, or the same words somewhere else, is named again.
 */
const siteOf = (at: SamplePlace, value: unknown) => JSON.stringify({ ...at, value: stableHash(stableJson(value)) });

/** Where a finding of these is fixed, read back from its `site`; null for any other finding. */
export function samplePlace(d: Pick<Diagnostic, 'code' | 'site'>): SamplePlace | null {
  if (!isSampleFinding(d) || !d.site) return null;
  try {
    const { value: _value, ...at } = JSON.parse(d.site) as SamplePlace & { value?: string };
    void _value;
    return typeof at?.kind === 'string' ? at : null;
  } catch {
    return null;
  }
}

/** What keeping a finding remembers (LocalWorkspaceState.keptSampleContent): its code, owner, and place with its value. */
export const keptSampleKey = (d: Pick<Diagnostic, 'code' | 'owner' | 'site'>) => `${d.code}|${d.owner?.kind ?? ''}:${d.owner?.id ?? ''}|@${d.site ?? ''}`;

/** A node of one document, as the Component showcase's placements are remembered (LocalWorkspaceState.sampleFixtures). */
const fixtureKey = (owner: { kind: string; id: string }, nodeId: string) => `${owner.kind}:${owner.id}:${nodeId}`;

/**
 * Every node the project has now, as the Component showcase remembers what it placed on purpose: its sections show
 * their designs' defaults and the starter photos so they can be tried out, so none of them is named. A section added
 * to it later, or a page duplicated from it, is the author's own, and is checked.
 */
export function sampleFixtures(state: ProjectState): string[] {
  return allTrees(state).flatMap((t) => Object.keys(t.tree.nodes).map((id) => fixtureKey(t.owner, id)));
}

/** `diagnostics` without the sample findings the author kept as they are, nor those about the showcase's own placements. */
export function withoutKeptSamples(diagnostics: Diagnostic[], kept: ReadonlySet<string>, fixtures: ReadonlySet<string>): Diagnostic[] {
  if (!kept.size && !fixtures.size) return diagnostics;
  const left = diagnostics.filter((d) => !isSampleFinding(d) || !(kept.has(keptSampleKey(d)) || (d.owner && d.nodeId && fixtures.has(fixtureKey(d.owner, d.nodeId)))));
  return left.length === diagnostics.length ? diagnostics : left;
}

/** The words a value shows: its text, or a rich text's. */
function wordsOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  try {
    return richTextToPlain(toRichText(v));
  } catch {
    return '';
  }
}

/** Words quoted for a message, cut short. */
function quoted(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return `“${line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line}”`;
}

/** "Hero’s", "Contact details’". */
const whose = (name: string) => (/s$/i.test(name.trim()) ? `${name}’` : `${name}’s`);

const own = <T>(map: Record<string, T> | undefined, k: string | undefined): T | undefined => (map && k !== undefined && Object.hasOwn(map, k) ? map[k] : undefined);

// ---------------------------------------------------------------------------
// The Business starter's copy
// ---------------------------------------------------------------------------
// The same words reach a page in other ways too: a page starter fills in some of them, and some are a section's own
// defaults the starter gives again (the team, a hero's eyebrow). Wherever they came from they are sample text, which is
// what a finding calls them.

/** The site's name in the starter's copy as it is read: replaced by the names the site may have had. */
const NAME = 'Starter-Site-Name-9d41';

/** The starter's copy, by where it is written (`component|property|field`), each value as stableJson writes it. */
interface CopyLookup {
  fields: Map<string, string[]>;
  descriptions: string[];
}

/** Values of the shared header and footer that are the site's own (its name, its menus, the copyright line), not sample copy. */
const OWN_VALUES: Record<string, readonly string[]> = { 'shell.header': ['siteName', 'links'], 'shell.footer': ['siteName', 'links', 'copyright'] };

let lookup: CopyLookup | undefined;

/** The Business starter's copy, read once (null while this build's default theme cannot make the starter). */
function starterCopy(): CopyLookup | null {
  if (lookup) return lookup;
  try {
    const made = businessStarterCopy(NAME);
    const fields = new Map<string, string[]>();
    const add = (key: string, v: unknown) => {
      if (!wordsOf(v).trim() || wordsOf(v).trim() === NAME) return;
      const list = fields.get(key) ?? [];
      list.push(stableJson(v));
      fields.set(key, list);
    };
    for (const { componentId, props } of made.placed)
      for (const [prop, v] of Object.entries(props)) {
        if (OWN_VALUES[componentId]?.includes(prop)) continue;
        // A list's items, field by field, and a value's own words.
        if (Array.isArray(v) && v.every((it) => it && typeof it === 'object' && typeof (it as { id?: unknown }).id === 'string'))
          for (const it of v as Array<Record<string, unknown>>) for (const [field, x] of Object.entries(it)) field !== 'id' && add(`${componentId}|${prop}|${field}`, x);
        else add(`${componentId}|${prop}|`, v);
      }
    lookup = { fields, descriptions: made.descriptions.map(stableJson) };
  } catch {
    // Its theme not loaded yet, say: read again next time.
    return null;
  }
  return lookup;
}

/** Whether a value is one the starter wrote, with the site's name as one of `names`. */
function isStarterCopy(written: string[] | undefined, v: unknown, names: readonly string[]): boolean {
  if (!written?.length) return false;
  const json = stableJson(v);
  return written.some((t) => (t.includes(NAME) ? names.some((n) => t.split(NAME).join(JSON.stringify(n).slice(1, -1)) === json) : t === json));
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

/** The bundled starter photos still in the library, by ID: a file the author picked to replace one (a relink) has its name. */
function starterPhotos(state: ProjectState): Map<string, StarterAsset> {
  return new Map(STARTER_ASSETS.flatMap((a) => (Object.hasOwn(state.assets.assets, a.id) && state.assets.assets[a.id]?.kind === 'image' && !state.assets.assets[a.id].originalName ? [[a.id, a] as const] : [])));
}

/** A table cell's or column's words, as the table shows them: text or a number, anything else nothing. */
const cellText = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The rows and columns a table shows, in order, and the words in it. */
function tableShown(v: unknown): { shape: unknown; words: string[] } | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as { columns?: unknown; rows?: unknown };
  const columns = (Array.isArray(t.columns) ? t.columns : []).filter((c): c is { id: string; label?: unknown } => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string');
  const rows = (Array.isArray(t.rows) ? t.rows : []).filter((r): r is { cells: Record<string, unknown> } => !!r && typeof r === 'object' && !!(r as { cells?: unknown }).cells && typeof (r as { cells: unknown }).cells === 'object');
  const head = columns.map((c) => cellText(c.label));
  const cells = rows.map((r) => columns.map((c) => cellText(own(r.cells, c.id))));
  return { shape: { head, cells }, words: [...head, ...cells.flat()] };
}

/**
 * The component contract a definition places, through every copy of it (Make unique keeps a theme section's
 * properties under a project ID of its own): what the starter's copy is looked up by.
 */
function contractOf(state: ProjectState, def: ComponentDefinition): string {
  let d: ComponentDefinition | undefined = def;
  for (let guard = 0; d && d.owner !== 'theme' && d.provenance?.forkedFrom && guard < 20; guard++) d = own(state.components, d.provenance.forkedFrom);
  return d?.owner === 'theme' ? d.componentId : (def.provenance?.componentId ?? def.componentId);
}

/** One list item a placement shows, with the fields of it the page shows. */
interface ShownRow {
  nodeId: string;
  prop: string;
  itemId: string;
  fields: Array<{ field: string; value: unknown; words: string }>;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * The sample findings of one tree the website shows (websiteTrees), in `live`, the published state: its placements'
 * sample defaults, the Business starter's copy and photos in it, and its basic elements' first words.
 */
function treeFindings(live: ProjectState, t: CheckedTree, copy: CopyLookup | null, names: readonly string[], photos: Map<string, StarterAsset>): Diagnostic[] {
  const { owner, tree, label } = t;
  const out: Diagnostic[] = [];
  const parents = treeParents(tree);
  const found = (code: string, message: string, nodeId: string, at: SamplePlace, value: unknown) => {
    // What the site hides at every size, its own styles or a container's around it, shows nothing to replace.
    if (!hiddenInTree(tree, nodeId, parents)) out.push({ severity: 'warning', code, message: `${label}: ${message}`, owner, nodeId, site: siteOf(at, value) });
  };
  const placed = (nodeId: string) => {
    const n = own(tree.nodes, nodeId);
    const def = n?.kind === 'instance' ? own(live.components, n.definitionId) : undefined;
    return n?.kind === 'instance' && def && n.props && typeof n.props === 'object' ? { n, def, contract: contractOf(live, def) } : null;
  };
  const stored = (n: { props: Record<string, unknown> }, schema: PropSchema, prop: string): unknown => (Object.hasOwn(n.props, prop) ? n.props[prop] : (schema as { default?: unknown }).default);
  const { content, known } = renderedContentKnown(live, tree);
  const rows = new Map<string, ShownRow>();

  for (const c of content) {
    if (c.kind !== 'text' || c.computed) continue;
    if (c.source?.kind === 'node') {
      stub(c);
      continue;
    }
    if (c.source?.kind !== 'prop' || !known.has(c)) continue;
    const { prop, itemId, field } = c.source;
    const p = placed(c.nodeId);
    const schema = own(p?.def.properties, prop);
    if (!p || !schema || isBinding(stored(p.n, schema, prop))) continue;
    const words = wordsOf(c.value);
    if (!words.trim() || holdsSampleContact(words)) continue;
    const where = `${whose(p.def.name)} ${schema.label}`;
    if (itemId !== undefined) {
      if (schema.type !== 'list' || schema.feed || !field || Object.hasOwn(p.n.listSources ?? {}, prop)) continue;
      // A page list's field left empty shows its page's value, which is the page's, not the item's.
      const list = stored(p.n, schema, prop);
      const it = Array.isArray(list) ? list.find((x) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === itemId) : undefined;
      if (schema.pageTeaser && teaserFields(schema.pageTeaser).some(([f]) => f === field) && !wordsOf(own(it as Record<string, unknown> | undefined, field)).trim()) continue;
      const key = JSON.stringify([c.nodeId, prop, itemId]);
      const row = rows.get(key) ?? { nodeId: c.nodeId, prop, itemId, fields: [] };
      row.fields.push({ field, value: c.value, words });
      rows.set(key, row);
      continue;
    }
    // A property's own value, or one field of an object.
    const f = field === undefined ? schema : schema.type === 'object' ? own(schema.fields, field) : undefined;
    if (!f || (f.type !== 'string' && f.type !== 'richtext')) continue;
    const at: SamplePlace = { kind: 'prop', nodeId: c.nodeId, prop, ...(field !== undefined ? { field } : {}) };
    const name = field === undefined ? where : `${where} → ${f.label}`;
    if (isStarterCopy(copy?.fields.get(`${p.contract}|${prop}|${field ?? ''}`), c.value, names)) {
      found('SAMPLE_STARTER_COPY', `${name} still shows sample text, ${quoted(words)}. Write your own, or keep it as it is.`, c.nodeId, at, c.value);
      continue;
    }
    // An object's field starts as the object's own default gives it, or else as the field's.
    const expected = field === undefined ? f.default : schema.type === 'object' && Object.hasOwn(schema.default ?? {}, field) ? schema.default[field] : f.default;
    if (f.sampleDefault && same(c.value, expected)) found('SAMPLE_DEFAULT', `${name} still shows the sample text its design starts with, ${quoted(words)}. Write your own, or keep it as it is.`, c.nodeId, at, c.value);
  }

  // Each list item shown: one of the items a sample list starts with (one finding for the item), or else each field
  // of it that is the starter's copy, or a new item's sample text.
  const seeded = new Map<string, Set<string>>();
  const seededRows = (nodeId: string, prop: string, schema: Extract<PropSchema, { type: 'list' }>, list: unknown[]): Set<string> => {
    const key = JSON.stringify([nodeId, prop]);
    const had = seeded.get(key);
    if (had) return had;
    // The items a placement's copy starts with get IDs of their own, so an item is one of them by what it holds. Each
    // default item is taken by one item alone, the same one however the list is ordered: two copies of it, where it
    // starts with one, are one sample and one copy.
    const shape = (it: unknown) => (it && typeof it === 'object' ? stableJson(Object.fromEntries(Object.entries(schema.fields).map(([k, f]) => [k, Object.hasOwn(it, k) ? (it as Record<string, unknown>)[k] : f.default]))) : '');
    const left = new Map<string, number>();
    for (const it of Array.isArray(schema.default) ? schema.default : []) left.set(shape(it), (left.get(shape(it)) ?? 0) + 1);
    const ids = new Set<string>();
    const idOf = (it: unknown) => String((it as { id?: unknown } | null)?.id ?? '');
    for (const it of [...list].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0))) {
      const s = shape(it);
      const n = left.get(s) ?? 0;
      if (!n) continue;
      left.set(s, n - 1);
      ids.add(idOf(it));
    }
    seeded.set(key, ids);
    return ids;
  };
  for (const row of rows.values()) {
    const p = placed(row.nodeId)!;
    const schema = p.def.properties[row.prop] as Extract<PropSchema, { type: 'list' }>;
    const list = stored(p.n, schema, row.prop);
    if (!Array.isArray(list)) continue;
    const index = list.findIndex((it) => !!it && typeof it === 'object' && (it as { id?: unknown }).id === row.itemId);
    if (index < 0) continue;
    const item = `${schema.itemLabel?.trim() || 'Item'} ${index + 1} of ${whose(p.def.name)} ${schema.label}`;
    // The item's name (its title field), or else its first words, leads.
    const lead = row.fields.find((f) => f.field === schema.titleField) ?? row.fields[0];
    const at = (field: string): SamplePlace => ({ kind: 'prop', nodeId: row.nodeId, prop: row.prop, itemId: row.itemId, field });
    const starter = new Set(row.fields.filter((f) => isStarterCopy(copy?.fields.get(`${p.contract}|${row.prop}|${f.field}`), f.value, names)));
    if (!starter.size && schema.sampleDefault && seededRows(row.nodeId, row.prop, schema, list).has(row.itemId)) {
      found('SAMPLE_DEFAULT', `${item} is still one of the sample items its design starts with, ${quoted(lead.words)}. Write your own, remove it, or keep it as it is.`, row.nodeId, at(lead.field), list[index]);
      continue;
    }
    for (const f of row.fields) {
      const fs = own(schema.fields, f.field);
      const name = `${item} → ${fs?.label ?? f.field}`;
      if (starter.has(f)) found('SAMPLE_STARTER_COPY', `${name} still shows sample text, ${quoted(f.words)}. Write your own, or keep it as it is.`, row.nodeId, at(f.field), f.value);
      else if (fs?.sampleDefault && same(f.value, fs.default)) found('SAMPLE_DEFAULT', `${name} still shows the sample text a new item starts with, ${quoted(f.words)}. Write your own, or keep it as it is.`, row.nodeId, at(f.field), f.value);
    }
  }

  // A table its design starts with, every cell and column as it was.
  for (const { nodeId, prop } of renderedTables(live, tree)) {
    const p = placed(nodeId);
    const schema = own(p?.def.properties, prop);
    if (!p || schema?.type !== 'table' || !schema.sampleDefault) continue;
    const now = tableShown(stored(p.n, schema, prop));
    const start = tableShown(schema.default);
    if (!now || !start || !now.words.some((w) => w.trim()) || !same(now.shape, start.shape)) continue;
    found('SAMPLE_DEFAULT', `${whose(p.def.name)} ${schema.label} still holds the sample rows and columns its design starts with. Write your own, or keep it as it is.`, nodeId, { kind: 'prop', nodeId, prop }, now.shape);
  }

  // The starter's photos, wherever the tree holds one: a placement's picture (one of its list items', or an object's),
  // a basic image, or a background.
  if (photos.size)
    for (const [nodeId, n] of Object.entries(tree.nodes)) {
      if (!n || typeof n !== 'object') continue;
      const walk = (v: unknown, path: Array<string | number>) => {
        if (Array.isArray(v)) {
          const ids = v.map((x) => (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? (x as { id: string }).id : undefined));
          return v.forEach((x, i) => walk(x, [...path, ids[i] && ids.filter((id) => id === ids[i]).length === 1 ? ids[i]! : i]));
        }
        if (!v || typeof v !== 'object') return;
        const asset = photos.get(String((v as { assetId?: unknown }).assetId));
        if (asset) photo(nodeId, n, path, asset);
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      };
      walk(n, []);
    }
  return out;

  function photo(nodeId: string, n: (typeof tree.nodes)[string], path: Array<string | number>, asset: StarterAsset) {
    const p = n.kind === 'instance' && path[0] === 'props' ? placed(nodeId) : null;
    const prop = p ? String(path[1]) : undefined;
    const schema = own(p?.def.properties, prop);
    // A list its collection fills, or the site's pages, shows their pictures, not the ones it keeps.
    if (p && prop && (Object.hasOwn(p.n.listSources ?? {}, prop) || (schema?.type === 'list' && schema.feed))) return;
    let at: SamplePlace = { kind: 'element', nodeId };
    let where = isBackgroundPath(path) ? 'a background' : n.kind === 'image' ? 'an image' : `${typeof n.name === 'string' && n.name.trim() ? n.name.trim() : 'an element'}`;
    if (p && prop && schema) {
      if (path.length === 2) (at = { kind: 'prop', nodeId, prop }), (where = `${whose(p.def.name)} ${schema.label}`);
      else if (schema.type === 'object' && path.length === 3) (at = { kind: 'prop', nodeId, prop, field: String(path[2]) }), (where = `${whose(p.def.name)} ${schema.label}`);
      else if (schema.type === 'list' && path.length === 4 && typeof path[2] === 'string') {
        const list = stored(p.n, schema, prop);
        const index = Array.isArray(list) ? list.findIndex((it) => (it as { id?: unknown } | null)?.id === path[2]) : -1;
        at = { kind: 'prop', nodeId, prop, itemId: path[2], field: String(path[3]) };
        where = `${schema.itemLabel?.trim() || 'Item'} ${index + 1} of ${whose(p.def.name)} ${schema.label}`;
      }
    }
    found('SAMPLE_STARTER_PHOTO', `${where} still shows the sample photo “${asset.name}”. Replace it with a picture of your own, or keep it as it is.`, nodeId, at, [asset.id, path]);
  }

  /** A basic element still showing the words it was inserted with, in the shape it was inserted as. */
  function stub(c: RenderedContent) {
    const n = own(tree.nodes, c.nodeId);
    if (!n || c.source?.kind !== 'node') return;
    let what: string | undefined;
    let words = '';
    if (n.kind === 'text' && c.source.field === 'text' && !isBinding(n.text) && !isBinding(n.tag)) {
      words = n.rich ? wordsOf(n.text) : typeof n.text === 'string' ? n.text : '';
      const parent = own(tree.nodes, parents.get(n.id));
      if (words === ELEMENT_STUBS.heading && !n.rich && HEADING_TAGS.has(n.tag)) what = 'a heading';
      else if (words === ELEMENT_STUBS.paragraph && (n.rich || n.tag === 'p')) what = n.rich ? 'a text block' : 'a paragraph';
      else if (words === ELEMENT_STUBS.caption && n.tag === 'figcaption') what = 'a caption';
      // A badge's label: a span inside the badge's own span.
      else if (words === ELEMENT_STUBS.badge && n.tag === 'span' && parent?.kind === 'element' && parent.tag === 'span') what = 'a badge';
    } else if (n.kind === 'link' && c.source.field === 'label' && n.label === ELEMENT_STUBS.button && resolveLink(isBinding(n.link) ? undefined : n.link, { state: live })) {
      what = 'a button';
      words = n.label;
    }
    if (what) found('SAMPLE_ELEMENT_STUB', `${what} still says “${words}”, the words it was added with. Write your own, or keep it as it is.`, n.id, { kind: 'element', nodeId: n.id }, words);
  }
}

/**
 * The sample content the website shows (see the top of this file), in the order of `trees` (websiteTrees of `live`,
 * the published state of `state`), then the site's and its pages' descriptions and sharing images. Each tree's findings
 * are kept by `keep` while the tree and what it reads are the same. A tree damaged by hand into a shape the checks
 * cannot read is skipped: this is advice, and never a reason Project health cannot open.
 */
export function sampleContentDiagnostics(state: ProjectState, live: ProjectState, trees: ReadonlyArray<{ owner: OwnerRef; tree: NodeTree; label: string }>, keep: Keeper): Diagnostic[] {
  const copy = starterCopy();
  // The name the Business starter wrote its copy with: a sentence naming the site any other way is the author's.
  const names = typeof state.manifest.starterSiteName === 'string' && state.manifest.starterSiteName.trim() ? [state.manifest.starterSiteName] : [];
  const photos = starterPhotos(live);
  const out: Diagnostic[] = [];
  for (const t of trees) {
    let found: Diagnostic[] = [];
    try {
      found = keep.tree(t, 'sample-content', () => treeFindings(live, t, copy, names, photos));
    } catch {
      /* the structural checks say what is wrong with it */
    }
    for (const d of found) out.push(d);
  }
  const description = live.site.description;
  if (copy && isStarterCopy(copy.descriptions, description, names))
    out.push({ severity: 'warning', code: 'SAMPLE_STARTER_COPY', message: 'The site description is still sample text. Write your own in Site details, or keep it as it is.', site: siteOf({ kind: 'site', field: 'description' }, description) });
  const social = typeof live.site.socialImage === 'string' ? photos.get(live.site.socialImage) : undefined;
  if (social) out.push({ severity: 'warning', code: 'SAMPLE_STARTER_PHOTO', message: `The site’s sharing image is still the sample photo “${social.name}”. Choose a picture of your own in Site details, or keep it as it is.`, site: siteOf({ kind: 'site', field: 'socialImage' }, social.id) });
  for (const id of live.site.pageOrder) {
    const page = own(live.pages, id);
    if (!page?.seo || typeof page.seo !== 'object') continue;
    const owner = { kind: 'page', id };
    const text = page.seo.description;
    if (copy && typeof text === 'string' && isStarterCopy(copy.descriptions, text, names))
      out.push({ severity: 'warning', code: 'SAMPLE_STARTER_COPY', message: `${page.title}: its search description is still sample text. Write your own in its Search & sharing settings, or keep it as it is.`, owner, site: siteOf({ kind: 'pageSeo', pageId: id, field: 'description' }, text) });
    const shared = typeof page.seo.socialImage === 'string' ? photos.get(page.seo.socialImage) : undefined;
    if (shared) out.push({ severity: 'warning', code: 'SAMPLE_STARTER_PHOTO', message: `${page.title}: its sharing image is still the sample photo “${shared.name}”. Choose a picture of your own in its Search & sharing settings, or keep it as it is.`, owner, site: siteOf({ kind: 'pageSeo', pageId: id, field: 'socialImage' }, shared.id) });
  }
  return out;
}
