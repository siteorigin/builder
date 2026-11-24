/**
 * Ordered, pure migrations of the canonical project documents.
 *
 * To change the document format, APPEND one entry to `MIGRATIONS`. Its position decides its version (entry 0
 * upgrades format 1 to 2, entry 1 upgrades 2 to 3, ...), and `SCHEMA_VERSION` follows from the length, so a new
 * entry is the whole version bump. Once released an entry is never edited, reordered or removed.
 *
 * Each migration:
 * - only rearranges the documents it is given: no clock, randomness, I/O, or imports of the catalogue, generator
 *   or engine, whose current behaviour would silently change what an old migration does;
 * - changes only documents `due` says are at its source version. A project can hold documents of different
 *   versions (one file restored from backup): each document then passes through exactly the steps it has not had,
 *   while the documents around it, which a step may read, can already be newer.
 *
 * The pipeline advances each document's `schemaVersion` after every step and keeps the theme lock truthful, so a
 * migration deals with neither.
 */
import type { ComponentDefinition, GraphNode, NodeTree, PageDoc, ProjectState, VariantAxis, VariantDef } from './types';
import { stableHash } from './ids';
import { sha256Hex } from './sha256';

export interface Migration {
  /** Stable name, recorded in test expectations and notes. */
  id: string;
  description: string;
  /** Update the draft in place, changing only the documents that are `due`. */
  migrate(project: ProjectState, due: (doc: { schemaVersion: number }) => boolean): void;
}

// ---------------------------------------------------------------------------
// structured-rich-text. Self-contained on purpose: it reads the old format as the old renderer did, whatever the
// current rich text code later becomes.
// ---------------------------------------------------------------------------

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface V3Span {
  text: string;
  strong?: boolean;
  em?: boolean;
}
const V2_LIST: Record<string, string> = { check: 'check', bullet: 'ul' };

/** One old paragraph's marks, by the old renderer's own pattern, with spaces moved outside them. */
function v3Spans(paragraph: string): V3Span[] {
  const raw: V3Span[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  for (let m = re.exec(paragraph); m; m = re.exec(paragraph)) {
    if (m.index > last) raw.push({ text: paragraph.slice(last, m.index) });
    raw.push(m[0].startsWith('**') ? { text: m[0].slice(2, -2), strong: true } : { text: m[0].slice(1, -1), em: true });
    last = m.index + m[0].length;
  }
  if (last < paragraph.length) raw.push({ text: paragraph.slice(last) });
  const parts: V3Span[] = [];
  for (const r of raw) {
    const text = r.text.replace(/[\s\u00a0]+/g, ' ');
    const core = text.trim();
    if (!r.strong && !r.em) parts.push({ text });
    else if (!core) parts.push({ text: ' ' });
    else {
      if (text.startsWith(' ')) parts.push({ text: ' ' });
      parts.push({ ...r, text: core });
      if (text.endsWith(' ')) parts.push({ text: ' ' });
    }
  }
  const out: V3Span[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev && !!prev.strong === !!part.strong && !!prev.em === !!part.em) prev.text += part.text;
    else out.push({ ...part });
  }
  out.forEach((x, i) => {
    x.text = x.text.replace(/ {2,}/g, ' ');
    if (i > 0 && out[i - 1].text.endsWith(' ')) x.text = x.text.replace(/^ /, '');
  });
  if (out.length) out[0].text = out[0].text.replace(/^ /, '');
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/ $/, '');
  return out.filter((x) => x.text);
}

/** An old rich text value as blocks. A value already in blocks (a document restored at a newer version) stays. */
function v3Blocks(value: unknown, list?: string): unknown {
  if (Array.isArray(value) && value.length && value.every((b) => b && typeof b === 'object' && typeof b.type === 'string')) return value;
  const paragraphs = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/\n{2,}/) : [];
  const lines = paragraphs.map(v3Spans).filter((spans) => spans.length);
  if (list) return lines.length ? [{ type: list, items: lines }] : [];
  return lines.map((spans) => ({ type: 'p', spans }));
}

const v3IsBinding = (v: unknown) => !!v && typeof v === 'object' && ('$prop' in v || '$item' in v);
/** The kinds of list rich text can be; anything else in a hand-edited document is no list. */
const V3_KINDS: readonly unknown[] = ['ul', 'ol', 'check'];

/** Each node's parent: through its children, and through the content placed in an instance's slots. */
function v3Parents(nodes: Record<string, Loose>): Map<string, string> {
  const parents = new Map<string, string>();
  for (const n of Object.values(nodes)) {
    if (!n || typeof n !== 'object') continue;
    const slotted = n.slots && typeof n.slots === 'object' ? Object.values<unknown>(n.slots).flatMap((ids) => (Array.isArray(ids) ? ids : [])) : [];
    for (const c of [...(Array.isArray(n.children) ? n.children : []), ...slotted]) if (typeof c === 'string') parents.set(c, n.id);
  }
  return parents;
}

/**
 * The value a binding in a definition's tree reads, as `definition \0 property` or `definition \0 list.field`. A
 * list item field is found through the nearest repeat above the node; a hand-edited cycle ends the search.
 */
function v3Key(defId: string, nodes: Record<string, Loose>, parents: Map<string, string>, nodeId: string, b: Loose): string | undefined {
  if (typeof b.$prop === 'string') return `${defId}\u0000${b.$prop}`;
  if (typeof b.$item !== 'string') return undefined;
  const seen = new Set<string>();
  let at = parents.get(nodeId);
  while (at && !seen.has(at) && nodes[at]?.kind !== 'repeat') {
    seen.add(at);
    at = parents.get(at);
  }
  const list = at ? nodes[at]?.list?.$prop : undefined;
  return typeof list === 'string' ? `${defId}\u0000${list}.${b.$item}` : undefined;
}

interface V3Lists {
  /** The kind of list a rich value is stored as; undefined for paragraphs. */
  kind(defId: string, name: string): string | undefined;
  /** Whether a value shown as a list in this definition can hold paragraphs, which that site then lists itself. */
  hinted(defId: string, name: string): boolean;
}

/**
 * How each rich property and rich list field was shown. The old renderer listed a value wherever a node marked as a
 * list showed it, so every place a value reaches counts: the definition's own nodes, a nested component it is
 * passed to (directly, as a whole list, or as a list item field), and content in an instance's slots. A value
 * shown one way only is stored in that form. One shown both as a list and as paragraphs, or as two kinds of list,
 * is stored as paragraphs, and each place that listed it keeps doing so with a `paragraphList` hint, as does every
 * place such a value is passed on to.
 */
function v3ListPlan(components: Record<string, Loose>, due: (doc: { schemaVersion: number }) => boolean): V3Lists {
  const demands = new Map<string, Set<string>>();
  const demand = (key: string, kind: string) => {
    if (!demands.has(key)) demands.set(key, new Set());
    demands.get(key)!.add(kind);
  };
  /** [receiving key, forwarding key]: whatever the receiver shows, the forwarded value is shown as. */
  const edges: Array<[string, string]> = [];
  for (const def of Object.values(components)) {
    if (!def || typeof def !== 'object' || typeof def.id !== 'string') continue;
    const current = !due(def as ComponentDefinition);
    /** The kind of list a definition's schema stores a value as; undefined for paragraphs. */
    const listedAs = (name: string): string | undefined => {
      const [prop, field] = name.split('.');
      const schema = def.properties && Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
      const rich = field === undefined ? schema : schema?.type === 'list' && schema.fields && Object.hasOwn(schema.fields, field) ? schema.fields[field] : undefined;
      return rich?.type === 'richtext' && V3_KINDS.includes(rich.plainAs) ? rich.plainAs : undefined;
    };
    // A current definition says how its values are listed in its schema; its nodes no longer do.
    for (const [name, schema] of Object.entries<Loose>(def.properties ?? {})) {
      const names = [name, ...(schema?.type === 'list' ? Object.keys(schema.fields ?? {}).map((f) => `${name}.${f}`) : [])];
      for (const k of names) if (listedAs(k)) demand(`${def.id}\u0000${k}`, listedAs(k)!);
    }
    const nodes: Record<string, Loose> = def.tree?.nodes && typeof def.tree.nodes === 'object' ? def.tree.nodes : {};
    const parents = v3Parents(nodes);
    for (const n of Object.values(nodes)) {
      if (!n || typeof n !== 'object') continue;
      if (n.kind === 'text' && n.rich && v3IsBinding(n.text)) {
        const key = v3Key(def.id, nodes, parents, n.id, n.text);
        if (!key) continue;
        // A format 2 node lists a value if it says so. A current one shows it as stored, or as its hint lists it.
        if (!current) demand(key, typeof n.list === 'string' && Object.hasOwn(V2_LIST, n.list) ? V2_LIST[n.list] : 'p');
        else demand(key, V3_KINDS.includes(n.paragraphList) ? n.paragraphList : (listedAs(key.slice(def.id.length + 1)) ?? 'p'));
      } else if (n.kind === 'instance' && n.props && typeof n.props === 'object') {
        const nested = typeof n.definitionId === 'string' && Object.hasOwn(components, n.definitionId) ? components[n.definitionId] : undefined;
        for (const [name, v] of Object.entries<Loose>(n.props)) {
          const schema = nested?.properties && Object.hasOwn(nested.properties, name) ? nested.properties[name] : undefined;
          const from = v3IsBinding(v) && schema ? v3Key(def.id, nodes, parents, n.id, v) : undefined;
          if (!from) continue;
          if (schema.type === 'richtext') edges.push([`${n.definitionId}\u0000${name}`, from]);
          else if (schema.type === 'list' && typeof v.$prop === 'string')
            for (const [f, field] of Object.entries<Loose>(schema.fields ?? {})) if (field?.type === 'richtext') edges.push([`${n.definitionId}\u0000${name}.${f}`, `${from}.${f}`]);
        }
      }
    }
  }
  // Sets only grow and each holds at most four kinds, so this ends, cycles included.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [to, from] of edges) {
      for (const kind of demands.get(to) ?? []) {
        if (demands.get(from)?.has(kind)) continue;
        demand(from, kind);
        grew = true;
      }
    }
  }
  const stored = (key: string) => {
    const set = demands.get(key);
    const [only] = set ?? [];
    return set?.size === 1 && only !== 'p' ? only : undefined;
  };
  const hinted = new Set<string>();
  const pending = [...new Set([...demands.keys(), ...edges.flat()])].filter((k) => !stored(k));
  while (pending.length) {
    const key = pending.pop()!;
    if (hinted.has(key)) continue;
    hinted.add(key);
    for (const [to, from] of edges) if (from === key && !hinted.has(to)) pending.push(to);
  }
  return { kind: (defId, name) => stored(`${defId}\u0000${name}`), hinted: (defId, name) => hinted.has(`${defId}\u0000${name}`) };
}

function structureRichText(project: ProjectState, due: (doc: { schemaVersion: number }) => boolean) {
  const components = project.components as Record<string, Loose>;
  // Read from every definition first: a document that is not due can still describe the values of one that is.
  const lists = v3ListPlan(components, due);
  const items = (list: unknown, schema: Loose, name: string, defId: string) => {
    if (!Array.isArray(list)) return list;
    return list.map((it: Loose) => {
      if (!it || typeof it !== 'object') return it;
      const out = { ...it };
      for (const [f, field] of Object.entries<Loose>(schema.fields ?? {})) {
        if (field?.type === 'richtext' && Object.hasOwn(out, f) && !v3IsBinding(out[f])) out[f] = v3Blocks(out[f], lists.kind(defId, `${name}.${f}`));
      }
      return out;
    });
  };
  const convertTree = (tree: Loose | undefined, owner?: Loose) => {
    const nodes: Record<string, Loose> = tree?.nodes ?? {};
    const parents = owner ? v3Parents(nodes) : undefined;
    for (const n of Object.values<Loose>(nodes)) {
      if (!n || typeof n !== 'object') continue;
      if (n.kind === 'text' && n.rich) {
        if (!v3IsBinding(n.text)) n.text = v3Blocks(n.text, typeof n.list === 'string' && Object.hasOwn(V2_LIST, n.list) ? V2_LIST[n.list] : undefined);
        else if (owner && typeof n.list === 'string' && Object.hasOwn(V2_LIST, n.list)) {
          const key = v3Key(owner.id, nodes, parents!, n.id, n.text);
          const name = key?.slice(owner.id.length + 1);
          if (name !== undefined && lists.hinted(owner.id, name)) n.paragraphList = V2_LIST[n.list];
        }
        delete n.list;
      } else if (n.kind === 'instance' && n.props && typeof n.props === 'object' && !Array.isArray(n.props)) {
        const def = typeof n.definitionId === 'string' && Object.hasOwn(components, n.definitionId) ? components[n.definitionId] : undefined;
        for (const [name, schema] of Object.entries<Loose>(def?.properties ?? {})) {
          if (!Object.hasOwn(n.props, name) || v3IsBinding(n.props[name])) continue;
          if (schema?.type === 'richtext') n.props[name] = v3Blocks(n.props[name], lists.kind(n.definitionId, name));
          else if (schema?.type === 'list') n.props[name] = items(n.props[name], schema, name, n.definitionId);
        }
      }
    }
  };
  for (const def of Object.values(components)) {
    if (!due(def as ComponentDefinition)) continue;
    // Code written before rich text was structured reads paragraph strings, which it keeps being given.
    const code = def.kind === 'code';
    for (const [name, schema] of Object.entries<Loose>(def.properties ?? {})) {
      if (code && schema?.type === 'richtext') schema.codeForm ??= 'paragraphs';
      if (code && schema?.type === 'list') for (const field of Object.values<Loose>(schema.fields ?? {})) if (field?.type === 'richtext') field.codeForm ??= 'paragraphs';
      if (schema?.type === 'richtext') {
        const kind = lists.kind(def.id, name);
        schema.default = v3Blocks(schema.default, kind);
        if (kind) schema.plainAs = kind;
      } else if (schema?.type === 'list') {
        for (const [f, field] of Object.entries<Loose>(schema.fields ?? {})) {
          if (field?.type !== 'richtext') continue;
          const kind = lists.kind(def.id, `${name}.${f}`);
          field.default = v3Blocks(field.default, kind);
          if (kind) field.plainAs = kind;
        }
        schema.default = items(schema.default, schema, name, def.id);
      }
    }
    convertTree(def.tree, def);
  }
  for (const page of Object.values(project.pages)) if (due(page)) convertTree(page);
  if (due(project.site)) {
    convertTree(project.site.shell?.header);
    convertTree(project.site.shell?.footer);
  }
}

export const MIGRATIONS: Migration[] = [
  {
    id: 'document-baseline',
    description: 'Give every document the containers later versions rely on.',
    migrate(project, due) {
      if (due(project.tokens)) {
        project.tokens.overrides ??= {};
        project.tokens.custom ??= [];
      }
      if (due(project.assets)) project.assets.assets ??= {};
      if (due(project.themeLock)) project.themeLock.components ??= {};
      for (const page of Object.values(project.pages)) {
        if (!due(page)) continue;
        page.seo ??= {};
        (page as LegacyPage).shell ??= 'default';
      }
    }
  },
  {
    id: 'structured-rich-text',
    description: 'Store rich text as blocks of spans instead of strings with ** and * marks.',
    migrate: structureRichText
  },
  {
    id: 'variant-axes',
    description: 'Replace the single variant of a component with named axes, so tone and layout can combine.',
    migrate(project, due) {
      for (const def of Object.values(project.components) as LegacyDefinition[]) {
        if (!due(def)) continue;
        const axes = legacyAxes(def);
        // The axes take the old field's place in the document, so an unchanged theme definition still matches
        // the theme's own copy byte for byte.
        const entries = Object.entries(def).flatMap(([k, v]): Array<[string, unknown]> => (k === 'variants' ? (axes ? [['variantAxes', axes]] : []) : k === 'defaultVariant' ? [] : [[k, v]]));
        for (const k of Object.keys(def)) delete (def as unknown as Record<string, unknown>)[k];
        Object.assign(def, Object.fromEntries(entries));
      }
      const convert = (tree: NodeTree) => {
        for (const node of Object.values(tree.nodes) as Array<GraphNode & { variant?: unknown }>) {
          if (node.kind !== 'instance' || !('variant' in node)) continue;
          const value = node.variant;
          delete node.variant;
          const def = project.components[node.definitionId];
          const axes = def?.variantAxes;
          const selection = axes && typeof value === 'string' ? legacySelection(axes, value, def.name) : undefined;
          if (selection) node.variants = selection;
          // Code was given no `variant` at all for a value naming none of its variants, so its own fallback showed.
          // The value stays as the placement's choice, which still passes nothing, instead of becoming the default.
          else if (def?.kind === 'code' && axes && typeof value === 'string') node.variants = { [Object.keys(axes)[0]]: value };
        }
      };
      if (due(project.site)) {
        convert(project.site.shell.header);
        convert(project.site.shell.footer);
      }
      for (const page of Object.values(project.pages)) if (due(page)) convert(page);
      for (const def of Object.values(project.components)) if (due(def) && def.tree) convert(def.tree);
    }
  },
  {
    id: 'independent-header-footer',
    description: 'Let each page show the shared header and the shared footer independently, instead of both or neither.',
    migrate(project, due) {
      for (const page of Object.values(project.pages) as LegacyPage[]) {
        if (!due(page)) continue;
        // A page already in this format (put back from a newer copy and stamped older) keeps its own choices.
        if (typeof page.showHeader === 'boolean' && typeof page.showFooter === 'boolean') {
          delete page.shell;
          continue;
        }
        const shows = page.shell !== 'none';
        const flags: Array<[string, unknown]> = [
          ['showHeader', typeof page.showHeader === 'boolean' ? page.showHeader : shows],
          ['showFooter', typeof page.showFooter === 'boolean' ? page.showFooter : shows]
        ];
        // The two settings take the old one's place in the document, so a page file still reads in the same order.
        const rest = Object.entries(page).filter(([k]) => k !== 'showHeader' && k !== 'showFooter');
        const at = rest.findIndex(([k]) => k === 'shell');
        const entries = at < 0 ? [...rest, ...flags] : [...rest.slice(0, at), ...flags, ...rest.slice(at + 1)];
        for (const k of Object.keys(page)) delete (page as unknown as Record<string, unknown>)[k];
        Object.assign(page, Object.fromEntries(entries));
      }
    }
  },
  {
    id: 'item-styles',
    description:
      'Placements can style single list items (itemOverrides). Nothing in the documents changes; the new version only keeps an older editor, which would drop those styles from the site and from copies, from opening the project for editing.',
    migrate() {}
  },
  {
    id: 'rich-text-code-form',
    description: 'Declare how each code component takes rich text, as its source decided until each property declared it.',
    migrate(project, due) {
      for (const def of Object.values(project.components) as Loose[]) {
        if (!due(def as ComponentDefinition) || def.kind !== 'code') continue;
        const rich = Object.values<Loose>(def.properties ?? {}).flatMap((schema) => [schema, ...(schema?.type === 'list' ? Object.values<Loose>(schema.fields ?? {}) : [])]).filter((s) => s?.type === 'richtext');
        // A component that already declares a form for any of them was written property by property.
        if (rich.some((s) => s.codeForm !== undefined)) continue;
        // Frozen: the test of the source that decided this before. A component that renders through the RichText
        // helper, or was converted from a design, took blocks; any other took paragraph strings, which need no word.
        if (!/RichText\.svelte|^<!-- Code component converted from/.test(typeof def.source === 'string' ? def.source : '')) continue;
        for (const s of rich) s.codeForm = 'blocks';
      }
    }
  },
  {
    id: 'collections',
    description:
      'Projects can hold collections of entries under siteorigin/collections/. Nothing in the documents changes; the new version only keeps an older editor, which would neither read nor guard them, from opening the project for editing.',
    migrate() {}
  },
  {
    id: 'ui-state',
    description:
      'Managed components can declare UI state (state), read it in conditions and variants ($state) and change it from buttons (stateAction). Nothing in the documents changes; the new version only keeps an older editor, which would show every state-dependent element at once and drop what buttons do, from opening the project for editing.',
    migrate() {}
  },
  {
    id: 'style-states',
    description:
      'Style rules can apply on hover, keyboard focus or while pressed ("base:hover", "phone:focus" beside each size). Nothing in the documents changes; the new version only keeps an older editor, which would drop those rules from the site, from copies and from detached sections, from opening the project for editing.',
    migrate() {}
  },
  {
    id: 'entry-addresses',
    description:
      'Collection entries are pages of the website, and an old address kept working can send visitors to an entry ({ from, entryId } in site.redirects) as well as to a page. Nothing in the documents changes; the new version only keeps an older editor, which would take such an address for a damaged one and neither publish entries nor keep their addresses, from opening the project for editing.',
    migrate() {}
  },
  {
    id: 'collection-templates',
    description:
      'Each collection has a layout template (template in collection.json) that every entry\'s page is shown with, whose elements read the entry through { $entry: field }. A collection stored before gets the layout its entries had: the title, the date and author, the featured image and the text in one reading column.',
    migrate(project, due) {
      for (const c of Object.values(project.collections ?? {}) as Loose[]) {
        const settings = c?.settings;
        if (!settings || typeof settings !== 'object' || !due(settings) || settings.template !== undefined) continue;
        settings.template = v12ArticleTemplate(typeof settings.id === 'string' ? settings.id : '');
      }
    }
  }
];

/**
 * Frozen: the layout entries had before collections had templates, as a template. Its node IDs are the collection's
 * ID and the element's role, so two collections' layouts never share one (collection IDs are unique) and the same
 * project always migrates the same way.
 */
function v12ArticleTemplate(collectionId: string): NodeTree {
  const id = (name: string) => `n_${collectionId}_${name}`;
  const tok = (token: string) => ({ token });
  const ids = { article: id('article'), column: id('column'), header: id('header'), title: id('title'), meta: id('meta'), date: id('date'), author: id('author'), image: id('image'), body: id('body') };
  const nodes: Record<string, GraphNode> = {
    [ids.article]: { id: ids.article, kind: 'element', tag: 'article', name: 'Article', styles: { base: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter') } }, children: [ids.column] },
    [ids.column]: {
      id: ids.column,
      kind: 'element',
      tag: 'div',
      name: 'Reading column',
      styles: { base: { layout: 'stack', gap: tok('space.lg'), width: 'fill', maxWidth: tok('container.reading'), marginInline: 'auto' } },
      children: [ids.header, ids.image, ids.body]
    },
    [ids.header]: { id: ids.header, kind: 'element', tag: 'header', name: 'Header', styles: { base: { layout: 'stack', gap: tok('space.sm') } }, children: [ids.title, ids.meta] },
    [ids.title]: { id: ids.title, kind: 'text', tag: 'h1', name: 'Title', text: { $entry: 'title' }, styles: { base: { textStyle: tok('text.h1') } } },
    [ids.meta]: {
      id: ids.meta,
      kind: 'element',
      tag: 'p',
      name: 'Date and author',
      collapseEmpty: true,
      styles: { base: { layout: 'row', wrap: true, columnGap: '1em', color: tok('color.muted') } },
      children: [ids.date, ids.author]
    },
    [ids.date]: { id: ids.date, kind: 'text', tag: 'span', name: 'Date', text: { $entry: 'publishedAt' }, datetime: { $entry: 'publishedAt' }, when: { $entry: 'publishedAt' } },
    [ids.author]: { id: ids.author, kind: 'text', tag: 'span', name: 'Author', text: { $entry: 'author' }, when: { $entry: 'author' } },
    [ids.image]: { id: ids.image, kind: 'image', name: 'Featured image', image: { $entry: 'featuredImage' }, when: { $entry: 'featuredImage' }, styles: { base: { width: 'fill', radius: tok('radius.md') } } },
    [ids.body]: { id: ids.body, kind: 'text', tag: 'div', name: 'Text', rich: true, text: { $entry: 'body' }, when: { $entry: 'body' } }
  };
  return { rootIds: [ids.article], nodes };
}

/** A page as formats before independent header and footer settings stored it: one setting for both. */
type LegacyPage = Omit<PageDoc, 'showHeader' | 'showFooter'> & { shell?: 'default' | 'none'; showHeader?: unknown; showFooter?: unknown };

type LegacyDefinition = ComponentDefinition & { variants?: Record<string, VariantDef>; defaultVariant?: string };

/** Variant IDs that only ever changed a section's colours in the first format. */
const LEGACY_TONES = new Set(['default', 'muted', 'inverse', 'brand', 'light']);

const hasStyles = (v: VariantDef | undefined) => Object.values(v?.styles ?? {}).some((rules) => Object.values(rules ?? {}).some((scope) => Object.keys(scope ?? {}).length > 0));

/**
 * The axes for a first-format variant list. Tones and layouts are separated only where that cannot change how an
 * existing placement renders: a managed design whose "default" tone adds no styles of its own, which a placement
 * on a layout variant can therefore combine with. Everything else stays one axis of mutually exclusive options.
 * Code reads one `variant` value, so it always stays on one axis.
 */
function legacyAxes(def: LegacyDefinition): Record<string, VariantAxis> | undefined {
  const variants = def.variants;
  const ids = Object.keys(variants ?? {});
  if (!variants || !ids.length) return undefined;
  const fallback = def.defaultVariant && Object.hasOwn(variants, def.defaultVariant) ? def.defaultVariant : ids[0];
  const tones = ids.filter((id) => LEGACY_TONES.has(id));
  const layouts = ids.filter((id) => !LEGACY_TONES.has(id));
  if (!layouts.length) return { tone: { label: 'Tone', default: fallback, options: variants } };
  if (def.kind !== 'managed' || !Object.hasOwn(variants, 'default') || hasStyles(variants.default)) return { style: { label: 'Style', default: fallback, options: variants } };
  const pick = (list: string[]) => Object.fromEntries(list.map((id) => [id, variants[id]]));
  return {
    tone: { label: 'Tone', default: tones.includes(fallback) ? fallback : 'default', options: pick(tones) },
    layout: { label: 'Layout', default: layouts.includes(fallback) ? fallback : 'default', options: { default: { label: 'Standard' }, ...pick(layouts) } }
  };
}

/**
 * What a first-format variant value selects: the option, plus the plain option on any axis it was exclusive of. A
 * placement restored from an older copy beside a definition already on axes can name an option that has since been
 * added to another axis too; guessing could pick the wrong one, so the update stops and says why.
 */
function legacySelection(axes: Record<string, VariantAxis>, value: string, name: string): Record<string, string> | undefined {
  const holding = Object.keys(axes).filter((a) => Object.hasOwn(axes[a].options, value));
  // "default" is the plain option on every axis it is on, which is what the first format's default meant.
  if (holding.length > 1 && value !== 'default')
    throw new Error(`a placement from an older copy chooses "${value}" for "${name}", which is now an option on several of its axes (${holding.join(', ')}). Restore "${name}" from the same copy, or choose the option in the current file.`);
  const axis = holding[0];
  if (!axis) return undefined;
  const out: Record<string, string> = { [axis]: value };
  for (const [other, a] of Object.entries(axes)) if (other !== axis && a.default !== 'default' && Object.hasOwn(a.options, 'default')) out[other] = 'default';
  return out;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length + 1;

/** The identity of a definition's content, as recorded in the theme lock. */
export function definitionHash(def: ComponentDefinition): string {
  return `sha256:${sha256Hex(JSON.stringify(def))}`;
}

/**
 * Does a theme lock entry say this definition is unmodified theme data? Locks written before SHA-256 hold a 32-bit
 * FNV-1a hash, which a hand edit can collide with; such an entry is read with that hash, the only evidence there is,
 * and is replaced by a SHA-256 one when the entry is next written from the theme itself (an install or a refresh).
 */
export function matchesLock(hash: string | undefined, def: ComponentDefinition): boolean {
  if (typeof hash !== 'string' || !hash) return false;
  return hash.startsWith('sha256:') ? hash === definitionHash(def) : hash === stableHash(JSON.stringify(def));
}

/** Every document of a project, which each carry their own `schemaVersion`. */
function documents(project: ProjectState): Array<{ schemaVersion: number }> {
  const collections = Object.values(project.collections ?? {}).flatMap((c) => [c.settings, ...Object.values(c.entries)]);
  return [project.manifest, project.site, project.tokens, project.assets, project.themeLock, ...Object.values(project.pages), ...Object.values(project.components), ...collections];
}

/** A missing or malformed version counts as the first format: migrations leave current documents unchanged. */
const versionOf = (doc: { schemaVersion?: unknown } | null): number => (Number.isInteger(doc?.schemaVersion) && (doc!.schemaVersion as number) > 0 ? (doc!.schemaVersion as number) : 1);
export const formatOf = versionOf;

/** The first format with variant axes: a document stored before it has its first-format choices converted. */
export const AXES_FORMAT = MIGRATIONS.findIndex((m) => m.id === 'variant-axes') + 2;

/** The newest format any document was written in. Above LATEST_SCHEMA_VERSION, this app cannot edit the project. */
export function newestDocumentVersion(project: ProjectState): number {
  return Math.max(...documents(project).map(versionOf));
}

export interface MigrationResult {
  /** The project in the current format. The input is not modified. */
  state: ProjectState;
  from: number;
  to: number;
  /** IDs of the migrations that ran, in order. */
  applied: string[];
}

/** Bring a project to the current format. Returns null when it already is, or holds a newer document. */
export function migrateProject(project: ProjectState, migrations: Migration[] = MIGRATIONS): MigrationResult | null {
  const to = migrations.length + 1;
  const versions = documents(project).map(versionOf);
  const from = Math.min(...versions);
  if (Math.max(...versions) > to) return null;
  // Equal versions everywhere is the only "nothing to do": a document with no version still needs stamping.
  if (from === to && documents(project).every((d) => d.schemaVersion === to)) return null;
  const state = structuredClone(project);
  // A theme definition still matching its lock is unmodified theme data. Migrating it must not make it look edited.
  const pristine = Object.values(state.components)
    .filter((d) => d.owner === 'theme' && matchesLock(state.themeLock.components?.[d.id]?.hash, d))
    .map((d) => d.id);
  for (const doc of documents(state)) doc.schemaVersion = versionOf(doc);
  const pending = migrations.slice(from - 1);
  pending.forEach((m, i) => {
    const source = from + i;
    const due = new Set<unknown>(documents(state).filter((d) => d.schemaVersion === source));
    m.migrate(state, (doc) => due.has(doc));
    // Read back from the project: a step may have replaced a document object rather than changed it.
    for (const doc of documents(state)) if (doc.schemaVersion === source || !Number.isInteger(doc.schemaVersion)) doc.schemaVersion = source + 1;
  });
  // Re-stamped in the hash the entry already had: a 32-bit match is weak evidence, and is never turned into a
  // SHA-256 entry that would vouch for the definition more strongly than the original lock did.
  for (const id of pristine) {
    const entry = state.themeLock.components[id];
    if (state.components[id] && entry) entry.hash = entry.hash.startsWith('sha256:') ? definitionHash(state.components[id]) : stableHash(JSON.stringify(state.components[id]));
  }
  return { state, from, to, applied: pending.map((m) => m.id) };
}
