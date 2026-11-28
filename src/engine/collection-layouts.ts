/**
 * The layout a collection's entries start with (#1319): a blog's articles take the theme's article layout as it is,
 * with its date, author and reading time; a collection of records takes the same page without that byline, with the
 * collection's own fields in it. A layout nobody has edited is the collection's default, and keeps up with its fields,
 * its text and its kind as they change; once edited it is the author's.
 */
import type { CollectionDoc, CollectionFieldSchema, GraphNode, NodeTree, ProjectState, ResponsiveStyles } from '@shared/types';
import { conditionRef, isEntryBinding } from '@shared/types';
import { collectionHasBody, collectionKind } from '@shared/collections';
import { newId } from '@shared/ids';
import { articleTemplateFor } from '@catalogue/index';
import { declaredTokens } from './tokens';
import { bindingSlots } from './schema';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
const EMPTY: NodeTree = { rootIds: [], nodes: {} };
/** The hairline the theme's Key facts rule pairs with: the text's own colour, faint, so it shows on any band. */
const HAIRLINE = '1px solid color-mix(in srgb, currentColor 14%, transparent)';

/**
 * The layout a new collection's entries start with: a copy of the theme's, every node with a new ID (so two
 * collections' layouts never share a style rule), keeping only the site styles the site has.
 */
export function themeArticleTemplate(state: ProjectState): NodeTree {
  const source = articleTemplateFor(state.site.themeId);
  if (!source) return { rootIds: [], nodes: {} };
  const tokens = new Set(declaredTokens(state).map((t) => t.id));
  const ids = new Map(Object.keys(source.nodes).map((id) => [id, newId('n')]));
  const remap = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && ids.has(id)).map((id) => ids.get(id)!) : []);
  const nodes: Record<string, GraphNode> = {};
  for (const [id, n] of Object.entries(source.nodes)) {
    const copy = structuredClone(n) as GraphNode & { children?: string[] };
    copy.id = ids.get(id)!;
    if ('children' in copy) copy.children = remap(copy.children);
    if (copy.styles) copy.styles = keptStyles(copy.styles, tokens);
    nodes[copy.id] = copy;
  }
  return { rootIds: remap(source.rootIds), nodes };
}

/** Styles without the values that name a site style the site lacks (a theme pack's template written for others). */
function keptStyles(styles: ResponsiveStyles, tokens: ReadonlySet<string>): ResponsiveStyles {
  const out: ResponsiveStyles = {};
  for (const [scope, props] of Object.entries(styles) as Array<[keyof ResponsiveStyles, Record<string, unknown>]>) {
    const kept = Object.fromEntries(Object.entries(props ?? {}).filter(([, v]) => !(v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' && !tokens.has((v as { token: string }).token))));
    if (Object.keys(kept).length) out[scope] = kept as ResponsiveStyles[keyof ResponsiveStyles];
  }
  return out;
}

/** What an article says of itself and a record has no use for: when it was published or revised, who wrote it, how long it takes to read. */
const BYLINE: ReadonlySet<string> = new Set(['publishedAt', 'updatedAt', 'author', 'readingTime']);

/**
 * How a record's page shows one field: a fact in its list of details (text, a number, a choice, a date, entries it
 * names), a feature shown by its name when it holds (yes/no), a link to follow, a passage of its own under its name
 * (rich or multi-line text), or a picture.
 */
type FieldBlock = 'fact' | 'feature' | 'link' | 'passage' | 'picture';
function blockOf(f: CollectionFieldSchema): FieldBlock {
  switch (f.type) {
    case 'boolean':
      return 'feature';
    case 'link':
      return 'link';
    case 'image':
      return 'picture';
    case 'richtext':
      return 'passage';
    case 'string':
      return f.multiline ? 'passage' : 'fact';
    default:
      return 'fact';
  }
}

/** Whether a node shows or tests one of `fields` of the entry. */
function reads(n: GraphNode, fields: ReadonlySet<string>): boolean {
  return bindingSlots(n).some((slot) => {
    const b = conditionRef(slot.value) ?? slot.value;
    return isEntryBinding(b) && fields.has(b.$entry);
  });
}

const childrenOf = (n: GraphNode | undefined): string[] | undefined => {
  const c = (n as { children?: unknown } | undefined)?.children;
  return Array.isArray(c) ? (c as string[]) : undefined;
};

/** Removes `doomed` and everything inside them, then every container they leave with nothing in it. */
function removeNodes(tree: NodeTree, doomed: ReadonlySet<string>) {
  const gone = new Set<string>();
  const drop = (id: string) => {
    if (gone.has(id) || !own(tree.nodes, id)) return;
    gone.add(id);
    for (const c of childrenOf(tree.nodes[id]) ?? []) drop(c);
  };
  doomed.forEach(drop);
  for (let emptied = true; emptied; ) {
    emptied = false;
    for (const [id, n] of Object.entries(tree.nodes)) {
      const children = childrenOf(n);
      if (gone.has(id) || !children?.length || children.some((c) => !gone.has(c))) continue;
      gone.add(id);
      emptied = true;
    }
  }
  for (const id of gone) delete tree.nodes[id];
  for (const n of Object.values(tree.nodes)) {
    const children = childrenOf(n);
    if (children) (n as { children: string[] }).children = children.filter((c) => !gone.has(c));
  }
  tree.rootIds = tree.rootIds.filter((id) => !gone.has(id));
}

/** The node holding `id` in its children, if any. */
function parentOf(tree: NodeTree, id: string): GraphNode | undefined {
  return Object.values(tree.nodes).find((n) => childrenOf(n)?.includes(id));
}

/**
 * The nodes that show a record's fields, by where they go: `lead` under its name and summary (the facts that say what
 * it is, its features and its links), `pictures` with its featured picture, `passages` after its text. Every block
 * shows only while its field holds something, and is named after the field, so an author finds, moves or removes it by
 * name.
 */
function fieldBlocks(fields: Record<string, CollectionFieldSchema>, styles: (s: ResponsiveStyles) => ResponsiveStyles) {
  const nodes: Record<string, GraphNode> = {};
  const add = (n: Record<string, unknown>) => {
    const id = newId('n');
    nodes[id] = { ...n, id, ...(n.styles ? { styles: styles(n.styles as ResponsiveStyles) } : {}) } as unknown as GraphNode;
    return id;
  };
  const entries = Object.entries(fields).filter(([, f]) => f && typeof f === 'object');
  const of = (block: FieldBlock) => entries.filter(([, f]) => blockOf(f) === block);
  const label = (f: CollectionFieldSchema) => (typeof f.label === 'string' && f.label.trim() ? f.label.trim() : 'Field');
  const lead: string[] = [];
  const pictures: string[] = [];
  const passages: string[] = [];

  // The facts: a description list as the theme's Key facts lays one out, each fact its label over its value under a
  // hairline, as many to a row as fit the column.
  const facts = of('fact').map(([name, f]) => {
    const bound = { $entry: `field.${name}` };
    const term = add({ kind: 'text', tag: 'dt', name: 'Label', text: label(f), styles: { base: { textStyle: { token: 'text.body' }, color: { token: 'color.muted' } } } });
    const value = add({ kind: 'text', tag: 'dd', name: 'Value', text: bound, ...(f.type === 'date' ? { datetime: bound } : {}), styles: { base: { textStyle: { token: 'text.body' } } } });
    return add({ kind: 'element', tag: 'div', name: label(f), children: [term, value], when: bound, styles: { base: { layout: 'stack', gap: { token: 'space.2xs' }, paddingBlock: { token: 'space.sm' }, borderBlockStart: HAIRLINE } } });
  });
  if (facts.length)
    lead.push(
      add({
        kind: 'element',
        tag: 'dl',
        name: 'Details',
        children: facts,
        collapseEmpty: true,
        styles: {
          // Columns of one width on every record, however many facts it has (auto-fill keeps the empty ones).
          base: { layout: 'grid', gridTemplate: 'repeat(auto-fill, minmax(10rem, 1fr))', columnGap: { token: 'space.xl' }, marginBlockStart: { token: 'space.sm' } },
          // Two to a row on a phone, so a long list of facts does not push the picture down a whole screen; one on the
          // narrowest.
          phone: { gridTemplate: 'repeat(auto-fill, minmax(8.5rem, 1fr))', columnGap: { token: 'space.lg' } }
        }
      })
    );

  // Features: the name of each yes/no field that holds, side by side.
  const features = of('feature').map(([name, f]) => {
    const text = add({ kind: 'text', tag: 'span', name: 'Label', text: label(f) });
    return add({ kind: 'element', tag: 'li', name: label(f), children: [text], when: { $entry: `field.${name}` }, styles: { base: { paddingBlock: { token: 'space.2xs' }, paddingInline: { token: 'space.sm' }, background: { token: 'color.surface' }, border: HAIRLINE, radius: { token: 'radius.pill' }, textStyle: { token: 'text.small' } } } });
  });
  if (features.length) lead.push(add({ kind: 'element', tag: 'ul', name: 'Features', children: features, collapseEmpty: true, styles: { base: { layout: 'row', wrap: true, gap: { token: 'space.xs' } } } }));

  // Links: one button for each, named as the field is.
  const links = of('link').map(([name, f]) => add({ kind: 'link', name: label(f), link: { $entry: `field.${name}` }, label: label(f), appearance: 'secondary', when: { $entry: `field.${name}` } }));
  if (links.length) lead.push(add({ kind: 'element', tag: 'div', name: 'Links', children: links, collapseEmpty: true, styles: { base: { layout: 'row', wrap: true, gap: { token: 'space.sm' } } } }));

  // Pictures of its own, with its picture, the field's name standing for any that has no description.
  for (const [name, f] of of('picture'))
    pictures.push(add({ kind: 'image', name: label(f), image: { $entry: `field.${name}` }, fallbackAlt: label(f), when: { $entry: `field.${name}` }, styles: { base: { width: 'fill', radius: { token: 'radius.md' } } } }));
  // Passages: each under its own heading, after the text; a multi-line text keeps its line breaks.
  for (const [name, f] of of('passage')) {
    const bound = { $entry: `field.${name}` };
    const heading = add({ kind: 'text', tag: 'h2', name: 'Heading', text: label(f), styles: { base: { textStyle: { token: 'text.h3' } } } });
    const body = add(f.type === 'richtext' ? { kind: 'text', tag: 'div', name: 'Text', text: bound, rich: true } : { kind: 'text', tag: 'p', name: 'Text', text: bound, styles: { base: { customCss: 'white-space: pre-line' } } });
    passages.push(add({ kind: 'element', tag: 'div', name: label(f), children: [heading, body], when: bound, styles: { base: { layout: 'stack', gap: { token: 'space.sm' } } } }));
  }
  return { nodes, lead, pictures, passages };
}

/**
 * A record's layout: the theme's article page without its byline (and without the text, for records that have none),
 * with the collection's facts in the byline's place, its pictures with the featured one, and passages after its text.
 */
export function recordTemplate(state: ProjectState, settings: Pick<CollectionDoc, 'fields' | 'hasBody'>): NodeTree {
  const tree = themeArticleTemplate(state);
  const hasBody = collectionHasBody(settings);
  const unwanted = new Set([...BYLINE, ...(hasBody ? [] : ['body'])]);
  removeNodes(tree, new Set(Object.values(tree.nodes).filter((n) => reads(n, unwanted)).map((n) => n.id)));
  const tokens = new Set(declaredTokens(state).map((t) => t.id));
  const blocks = fieldBlocks(settings.fields ?? {}, (s) => keptStyles(s, tokens));
  Object.assign(tree.nodes, blocks.nodes);
  const find = (field: string) => Object.values(tree.nodes).find((n) => reads(n, new Set([field])) && !Object.hasOwn(blocks.nodes, n.id));
  const insert = (ids: string[], at: { after: GraphNode }) => {
    const parent = parentOf(tree, at.after.id);
    const list = parent ? childrenOf(parent)! : tree.rootIds;
    list.splice(list.indexOf(at.after.id) + 1, 0, ...ids);
  };
  const picture = find('featuredImage');
  const text = find('body');
  const summary = find('excerpt') ?? find('title');
  // The facts take the byline's place, under the name and summary, so they are read before the picture and the text.
  if (!summary) {
    // A theme without an article layout: the name, then the fields, one after another.
    const [root, title] = [newId('n'), newId('n')];
    tree.nodes[title] = { id: title, kind: 'text', tag: 'h1', name: 'Title', text: { $entry: 'title' } } as GraphNode;
    tree.nodes[root] = { id: root, kind: 'element', tag: 'article', name: 'Article', children: [title, ...blocks.lead, ...blocks.pictures, ...blocks.passages], styles: keptStyles({ base: { layout: 'stack', gap: { token: 'space.xl' } } }, tokens) } as GraphNode;
    tree.rootIds = [root];
    return tree;
  }
  insert(blocks.lead, { after: summary });
  tightenOnPhones(tree, summary);
  // Its pictures go together, after the featured one; passages follow the text, or the pictures without one.
  const last = (ids: string[], fallback: GraphNode) => (ids.length ? tree.nodes[ids.at(-1)!] : fallback);
  const lastLead = last(blocks.lead, summary);
  insert(blocks.pictures, { after: picture ?? lastLead });
  insert(blocks.passages, { after: text ?? last(blocks.pictures, picture ?? lastLead) });
  collapseWhenEmpty(tree);
  return tree;
}

/**
 * The band the name and facts sit in, with the theme's padding a step smaller on a phone, where the facts already
 * take room before the picture.
 */
function tightenOnPhones(tree: NodeTree, summary: GraphNode) {
  // The outermost container holding the summary under the layout's root (the theme's header band).
  let band = summary;
  for (let up = parentOf(tree, band.id); up && !tree.rootIds.includes(up.id); up = parentOf(tree, up.id)) band = up;
  if (band.id === summary.id || !band.styles?.base?.paddingBlock) return;
  band.styles = { ...band.styles, phone: { ...band.styles.phone, paddingBlock: { token: 'space.2xl' } } };
}

/** Every container of a record's layout shows only while something in it does, so a sparse record leaves no blank band. */
function collapseWhenEmpty(tree: NodeTree) {
  for (const n of Object.values(tree.nodes)) if (n.kind === 'element' && n.children.length) n.collapseEmpty = true;
}

/** The layout a collection of these settings starts with: a record's for records, the theme's article for articles with text. */
export function defaultLayout(state: ProjectState, settings: Pick<CollectionDoc, 'kind' | 'fields' | 'hasBody'>): NodeTree {
  if (collectionKind(settings) === 'structured') return recordTemplate(state, settings);
  return collectionHasBody(settings) ? themeArticleTemplate(state) : structuredClone(EMPTY);
}

/**
 * A layout as a value that says nothing of its node IDs: each node in reading order, its children by their place in
 * that order. Null for one with a node nothing shows.
 */
function shape(tree: NodeTree | undefined): string | null {
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.rootIds) || !tree.nodes || typeof tree.nodes !== 'object') return null;
  const order = new Map<string, number>();
  const visit = (id: unknown) => {
    if (typeof id !== 'string' || order.has(id) || !own(tree.nodes, id)) return;
    order.set(id, order.size);
    (childrenOf(tree.nodes[id]) ?? []).forEach(visit);
  };
  tree.rootIds.forEach(visit);
  if (order.size !== Object.keys(tree.nodes).length) return null;
  const place = (id: string) => order.get(id) ?? -1;
  const nodes = [...order.keys()].map((id) => {
    const { id: _id, ...rest } = tree.nodes[id] as GraphNode & { children?: string[] };
    return Array.isArray(rest.children) ? { ...rest, children: rest.children.map(place) } : rest;
  });
  return stable([tree.rootIds.map((id) => place(id)), nodes]);
}

/** JSON with every object's keys in order, so two values that say the same are written the same. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** Whether a collection's layout is still the one it would start with as it is now: nobody has edited it. */
export function isDefaultLayout(state: ProjectState, settings: CollectionDoc): boolean {
  const current = shape(settings.template);
  return current !== null && current === shape(defaultLayout(state, settings));
}
