/**
 * Collections shown in lists (#677): placed sections whose list property is connected to a collection
 * (`InstanceNode.listSources`), collection loops (repeats over `{ $query }` or `{ $archive }`), and what the elements
 * inside a loop read of each entry (`{ $item: field }`). What can be wrong with each, said the same way by validation,
 * by the edits that make them, and by the check that refuses any batch leaving one of them broken (a collection
 * removed, a field retyped, a list property renamed), whichever operation did it.
 */
import type { Collection, ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import { conditionRef, isBinding, isBindingRef, isCollectionLoop, isComparison } from '@shared/types';
import { CURRENT_COLLECTION, ENTRY_ORDER_FIELD, normalizeCollectionQuery, type CollectionQuery } from '@shared/collection-query';
import { fieldFitProblem, normalizeConnection, rowFieldSchema } from '@shared/collection-rows';
import { ENTRY_CONTENT_FIELDS, entryChoiceProblem, entryComparisonProblem, isEntryDateField } from '@shared/entry-fields';
import { acceptedTypes, bindingProblem, bindingSlots } from './schema';
import { allTrees, childLists, displayName, fail, getNode } from './tree';
import { newId } from '@shared/ids';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** One problem: where it is, a key that names it across states, and what to say (it follows the node's name). */
export interface SourceProblem {
  owner: OwnerRef;
  /** The tree's name ("Home", "Team layout"). */
  label: string;
  node: GraphNode;
  nodeId: string;
  key: string;
  message: string;
}

/** The fields a query filters and sorts by that are not a row's or an entry's (see shared/collection-query.ts). */
const QUERY_ONLY = new Set(['id', 'slug']);

/** Which collection a query reads where it is placed: the one it names, or for `$current` the one whose layout it is in. */
function queryCollectionOf(state: ProjectState, owner: OwnerRef, query: Pick<CollectionQuery, 'collectionId'>): Collection | undefined {
  const id = query.collectionId === CURRENT_COLLECTION ? (owner.kind === 'template' || owner.kind === 'archive' ? owner.id : undefined) : query.collectionId;
  return id !== undefined ? own(state.collections, id) : undefined;
}

/** What is wrong with a query placed in `owner`'s tree, or null. */
export function queryProblem(state: ProjectState, owner: OwnerRef, raw: unknown): string | null {
  const query = normalizeCollectionQuery(raw);
  if (!query) return 'reads a collection by a query that cannot be read: name its collection, and give each filter a field, an operator and a value.';
  if (query.collectionId === CURRENT_COLLECTION && owner.kind !== 'template' && owner.kind !== 'archive')
    return owner.kind === 'component'
      ? "reads the collection of the page it is on, which a component's design, shown on every page that places it, cannot: name the collection."
      : "reads the collection of the page it is on, which only a collection's layout or archive layout has: name the collection.";
  if (query.excludeCurrent && owner.kind !== 'template') return "leaves out the entry whose page it is on, which only a collection's layout has.";
  const collection = queryCollectionOf(state, owner, query);
  if (!collection) return `reads the collection “${query.collectionId}”, which the project does not have.`;
  const name = collection.settings.name;
  for (const c of query.where ?? []) if (!QUERY_ONLY.has(c.field) && !rowFieldSchema(collection, c.field)) return `filters by "${c.field.slice(0, 60)}", which entries of ${name} do not have.`;
  for (const s of query.sort ?? []) if (s.field !== ENTRY_ORDER_FIELD && !QUERY_ONLY.has(s.field) && !rowFieldSchema(collection, s.field)) return `sorts by "${s.field.slice(0, 60)}", which entries of ${name} do not have.`;
  return null;
}

/** What is wrong with one list property's connection to a collection, or null. */
export function connectionProblem(state: ProjectState, owner: OwnerRef, node: InstanceNode, prop: string, raw: unknown): string | null {
  const def = own(state.components, node.definitionId);
  if (!def) return null;
  const schema = own(def.properties, prop);
  if (schema?.type !== 'list') return `connects "${prop.slice(0, 60)}" to a collection, but ${def.name} has no list of that name.`;
  if (schema.feed) return `connects “${schema.label}” to a collection, but it fills itself from the site's ${schema.feed === 'entries' ? 'posts' : 'pages'}.`;
  if (isBinding(own(node.props, prop))) return `connects “${schema.label}” to a collection while it is passed down from the design around it. Unbind it first.`;
  const connection = normalizeConnection(raw);
  if (!connection) return `connects “${schema.label}” to a collection in a form that cannot be read: a query, and which entry field fills each item field.`;
  const query = queryProblem(state, owner, connection.query);
  if (query) return `connects “${schema.label}”, but ${query.replace(/^reads a collection/, 'reads its collection')}`;
  const collection = queryCollectionOf(state, owner, connection.query)!;
  for (const [field, source] of Object.entries(connection.fields)) {
    const target = own(schema.fields, field);
    if (!target) return `fills "${field.slice(0, 60)}" of “${schema.label}”, which its items do not have.`;
    const from = rowFieldSchema(collection, source);
    if (!from) return `fills “${target.label}” of “${schema.label}” from "${source.slice(0, 60)}", which entries of ${collection.settings.name} do not have.`;
    const fit = fieldFitProblem(from, target);
    if (fit) return `fills “${target.label}” of “${schema.label}”, but ${fit}`;
  }
  // Every item shows an entry: one an item must have is filled from it, never left at its sample value.
  const unfilled = Object.entries(schema.fields).find(([field, f]) => f.required && !Object.hasOwn(connection.fields, field));
  if (unfilled) return `leaves “${unfilled[1].label}” of “${schema.label}” unfilled, which every item needs: choose the entry field that fills it.`;
  return null;
}

/** The collection loop a node is repeated by in its tree, or undefined; and whether a repeat stands between them. */
function enclosingLoops(tree: NodeTree): Map<string, RepeatNode> {
  const out = new Map<string, RepeatNode>();
  const visit = (id: string, loop: RepeatNode | undefined, depth: number) => {
    const n = own(tree.nodes, id);
    if (!n || depth > 200) return;
    if (loop) out.set(id, loop);
    const inner = n.kind === 'repeat' ? (isCollectionLoop(n) ? n : undefined) : loop;
    for (const cl of childLists(n)) for (const c of cl.ids) visit(c, inner, depth + 1);
  };
  for (const id of Array.isArray(tree.rootIds) ? tree.rootIds : []) visit(id, undefined, 0);
  return out;
}

/** The collection a loop shows, where it is placed. */
export function loopCollection(state: ProjectState, owner: OwnerRef, loop: Pick<RepeatNode, 'list'>): Collection | undefined {
  const list = loop.list as Record<string, unknown>;
  if (Object.hasOwn(list, '$archive')) return owner.kind === 'archive' ? own(state.collections, owner.id) : undefined;
  const q = normalizeCollectionQuery(list.$query);
  return q ? queryCollectionOf(state, owner, q) : undefined;
}

/** What is wrong with a collection loop placed in `owner`'s tree, or null. */
export function loopProblem(state: ProjectState, owner: OwnerRef, tree: NodeTree, node: RepeatNode): string | null {
  const list = node.list as Record<string, unknown>;
  if (Object.hasOwn(list, '$archive')) {
    if (owner.kind !== 'archive' || list.$archive !== true || Object.keys(list).length !== 1) return "repeats the entries of the archive page it is on, which only a collection's archive layout has.";
  } else if (Object.keys(list).length !== 1) return 'repeats a collection by a query together with something else; repeat one of them.';
  else {
    const problem = queryProblem(state, owner, list.$query);
    if (problem) return problem;
  }
  // One list at a time: each row's elements read its entry, never a row of another list around or inside it.
  const parents = new Map<string, GraphNode>();
  for (const p of Object.values(tree.nodes)) for (const cl of childLists(p)) for (const c of cl.ids) parents.set(c, p);
  for (let at = parents.get(node.id), hops = 0; at && hops < 200; at = parents.get(at.id), hops++) if (at.kind === 'repeat') return 'is inside another list. Show a collection in a list of its own.';
  const inside = new Set<string>();
  const visit = (id: string) => {
    const n = own(tree.nodes, id);
    if (!n || inside.has(id)) return;
    inside.add(id);
    for (const cl of childLists(n)) cl.ids.forEach(visit);
  };
  node.children.forEach(visit);
  if ([...inside].some((id) => tree.nodes[id]?.kind === 'repeat')) return 'holds another list inside it. Show one list at a time: each item reads its own entry.';
  return null;
}

/** What is wrong with what one element inside a loop reads of its entries: each a message that follows its name. */
export function loopBindingProblems(state: ProjectState, collection: Collection, n: GraphNode): string[] {
  const out: string[] = [];
  for (const slot of bindingSlots(n)) {
    const condition = slot.field === 'when' || slot.field === 'unless';
    const b = condition ? conditionRef(slot.value) : isBindingRef(slot.value) ? slot.value : undefined;
    if (!b || !isBinding(b) || !('$item' in b)) continue;
    const field = b.$item;
    const schema = typeof field === 'string' ? rowFieldSchema(collection, field) : undefined;
    if (!schema) {
      out.push(`shows "${String(field).slice(0, 60)}", which entries of ${collection.settings.name} do not have.`);
      continue;
    }
    if (schema.type === 'enum' && !Array.isArray((schema as { options?: unknown }).options)) continue;
    if (!ENTRY_CONTENT_FIELDS.has(slot.field)) {
      out.push(`takes its ${slot.field} from “${schema.label}”; that is the list's own, the same for every entry. Only content can show an entry's field.`);
      continue;
    }
    if (slot.field === 'datetime' && !isEntryDateField(collection, field)) {
      out.push(`states “${schema.label}” as its date, which is not a date.`);
      continue;
    }
    const nested = slot.field === 'prop' && n.kind === 'instance' ? state.components[n.definitionId]?.properties : undefined;
    if (slot.field === 'prop' && !(nested && slot.prop !== undefined && Object.hasOwn(nested, slot.prop))) {
      out.push(`shows “${schema.label}” in "${slot.prop}", which the placed component does not have.`);
      continue;
    }
    const ok = acceptedTypes(n, slot.field, nested?.[slot.prop!]);
    if (ok && !ok.includes(schema.type)) {
      out.push(`shows “${schema.label}” (${schema.type === 'string' ? 'text' : schema.type}) as its ${slot.field === 'prop' ? `"${slot.prop}"` : slot.field}, which needs ${ok.map((t) => (t === 'string' ? 'text' : t)).join(' or ')}.`);
      continue;
    }
    const choice = slot.field === 'prop' ? entryChoiceProblem(schema, nested?.[slot.prop!]) : null;
    if (choice) {
      out.push(`shows “${schema.label}” in "${slot.prop}", but it ${choice}`);
      continue;
    }
    const comparison = condition && isComparison(slot.value) ? slot.value : undefined;
    const compared = comparison ? entryComparisonProblem(collection, field) : null;
    if (compared) {
      out.push(`compares ${compared}`);
      continue;
    }
    const problem = bindingProblem(state, { node: n, field: slot.field, prop: slot.prop, comparison }, schema);
    if (problem) out.push(problem);
  }
  return out;
}

/** Whether a node reads an item field (`{ $item }`) in any of its binding places. */
export const readsItem = (n: GraphNode): boolean => bindingSlots(n).some((sl) => {
  const b = sl.field === 'when' || sl.field === 'unless' ? conditionRef(sl.value) : sl.value;
  return isBinding(b) && '$item' in b;
});

/** The nodes of a tree a collection loop repeats, each with its loop. */
export function loopMembers(tree: NodeTree): ReadonlyMap<string, RepeatNode> {
  return enclosingLoops(tree);
}

/**
 * Every problem with the project's connected lists, collection loops and what their elements read, in every tree but
 * a theme's designs (fixed theme data, checked when the theme is built).
 */
export function collectionSourceProblems(state: ProjectState): SourceProblem[] {
  const out: SourceProblem[] = [];
  for (const { owner, tree, label } of allTrees(state)) {
    const def: ComponentDefinition | undefined = owner.kind === 'component' ? state.components[owner.id] : undefined;
    if (def?.owner === 'theme' || !tree?.nodes || typeof tree.nodes !== 'object') continue;
    const loops = enclosingLoops(tree);
    for (const n of Object.values(tree.nodes)) {
      if (!n || typeof n !== 'object') continue;
      if (n.kind === 'instance' && n.listSources && typeof n.listSources === 'object')
        for (const [prop, raw] of Object.entries(n.listSources)) {
          const problem = connectionProblem(state, owner, n, prop, raw);
          if (problem) out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:list:${prop}`, message: problem });
        }
      if (isCollectionLoop(n) && n.kind === 'repeat') {
        const problem = loopProblem(state, owner, tree, n);
        if (problem) out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:loop`, message: problem });
      }
      const loop = loops.get(n.id);
      const collection = loop ? loopCollection(state, owner, loop) : undefined;
      if (collection) for (const problem of loopBindingProblems(state, collection, n)) out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:item:${problem}`, message: problem });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** instance.setListSource: connect a placed section's list property to a collection, or disconnect it (`null`). */
export function instanceSetListSource(state: ProjectState, tree: NodeTree, op: { owner: OwnerRef; nodeId: string; prop: string; source: { query: Record<string, unknown>; fields: Record<string, string> } | null }): Record<string, never> {
  const node = getNode(tree, op.nodeId);
  if (node.kind !== 'instance') fail(`${displayName(state, node)} is not a placed section, so it has no list to connect.`);
  if (op.source === null) {
    // Its own items, kept all along, show again.
    if (node.listSources && Object.hasOwn(node.listSources, op.prop)) delete node.listSources[op.prop];
    if (node.listSources && !Object.keys(node.listSources).length) delete node.listSources;
    return {};
  }
  const connection = normalizeConnection(op.source);
  const problem = connectionProblem(state, op.owner, node, op.prop, connection ?? op.source);
  if (problem) fail(`${displayName(state, node)} ${problem}`);
  node.listSources = { ...(node.listSources ?? {}), [op.prop]: connection! };
  return {};
}

/** A new collection loop, for node.insert: a repeat over a query's entries or (`archive`) the archive page's. */
export function loopNode(state: ProjectState, owner: OwnerRef, source: { query?: Record<string, unknown>; archive?: true }): RepeatNode {
  if (source.query !== undefined && source.archive) fail('A collection loop repeats a query\'s entries or the archive page\'s, not both.');
  const list = source.archive ? ({ $archive: true } as const) : { $query: normalizeCollectionQuery(source.query) ?? fail('That query cannot be read: name its collection, and give each filter a field, an operator and a value.') };
  const node: RepeatNode = { id: newId('n'), kind: 'repeat', list, children: [], styles: { base: { layout: 'stack', gap: { token: 'space.md' } } } };
  const problem = loopProblem(state, owner, { rootIds: [node.id], nodes: { [node.id]: node } }, node);
  if (problem) fail(`A collection loop here ${problem}`);
  return node;
}

/** node.setRepeatSource: which entries a collection loop repeats. Its rows' elements keep what they show. */
export function nodeSetRepeatSource(state: ProjectState, tree: NodeTree, op: { owner: OwnerRef; nodeId: string; source: { $query: Record<string, unknown> } | { $archive: true } }): Record<string, never> {
  const node = getNode(tree, op.nodeId);
  if (node.kind !== 'repeat' || !isCollectionLoop(node)) fail(`${displayName(state, node)} is not a collection loop. A component's list repeats one of its properties.`);
  const list = '$archive' in op.source ? ({ $archive: true } as const) : { $query: normalizeCollectionQuery(op.source.$query) ?? fail('That query cannot be read: name its collection, and give each filter a field, an operator and a value.') };
  const was = node.list;
  node.list = list;
  const problem = loopProblem(state, op.owner, tree, node);
  if (problem) {
    node.list = was;
    fail(`${displayName(state, node)} ${problem}`);
  }
  return {};
}

/**
 * A collection's first archive layout: a section whose collection loop shows each entry the page lists as a linked
 * title, its date and its excerpt (the ones a collection has), which the author designs from there.
 */
export function starterArchiveLayout(collection: Collection): NodeTree {
  const id = () => newId('n');
  const [section, loop, card, title, date, excerpt] = [id(), id(), id(), id(), id(), id()];
  const has = (f: string) => !!rowFieldSchema(collection, f);
  const nodes: Record<string, GraphNode> = {
    [section]: { id: section, kind: 'element', tag: 'section', name: 'Entries', children: [loop], styles: { base: { layout: 'stack', paddingBlock: { token: 'space.2xl' }, paddingInline: { token: 'space.lg' } } } },
    [loop]: { id: loop, kind: 'repeat', name: `${collection.settings.name} on this page`, list: { $archive: true }, children: [card], styles: { base: { layout: 'stack', gap: { token: 'space.xl' } } } },
    [card]: { id: card, kind: 'element', tag: 'article', name: 'Entry', children: [title, ...(has('publishedAt') ? [date] : []), ...(has('excerpt') ? [excerpt] : [])], styles: { base: { layout: 'stack', gap: { token: 'space.xs' } } } },
    [title]: { id: title, kind: 'link', name: 'Title', link: { $item: 'entryLink' }, label: { $item: 'title' }, appearance: 'link' } as unknown as GraphNode
  };
  if (has('publishedAt')) nodes[date] = { id: date, kind: 'text', tag: 'p', name: 'Date', text: { $item: 'publishedAt' }, datetime: { $item: 'publishedAt' }, when: { $item: 'publishedAt' }, styles: { base: { color: { token: 'color.muted' } } } } as unknown as GraphNode;
  if (has('excerpt')) nodes[excerpt] = { id: excerpt, kind: 'text', tag: 'p', name: 'Excerpt', text: { $item: 'excerpt' }, when: { $item: 'excerpt' } } as unknown as GraphNode;
  return { rootIds: [section], nodes };
}
