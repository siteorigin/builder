/**
 * Collections shown in lists (#677): placed sections whose list property is connected to a collection
 * (`InstanceNode.listSources`), collection loops (repeats over `{ $query }` or `{ $archive }`), and what the elements
 * inside a loop read of each entry (`{ $item: field }`). What can be wrong with each, said the same way by validation,
 * by the edits that make them, and by the check that refuses any batch leaving one of them broken (a collection
 * removed, a field retyped, a list property renamed), whichever operation did it.
 */
import type { Collection, ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import { conditionRef, isBinding, isBindingRef, isCollectionLoop, isComparison, isEntryBinding } from '@shared/types';
import { CURRENT_COLLECTION, ENTRY_ORDER_FIELD, normalizeCollectionQuery, type CollectionQuery } from '@shared/collection-query';
import { fieldFitProblem, normalizeConnection, rowFieldSchema } from '@shared/collection-rows';
import { ENTRY_CONTENT_FIELDS, entryChoiceProblem, entryComparisonProblem, entryFieldLabel, isEntryDateField } from '@shared/entry-fields';
import { acceptedTypes, bindingProblem, bindingSlots } from './schema';
import { requiredGap } from '@shared/required';
import { formDestinationLookup, type FormDestinationLookup } from './form-destinations';
import { termNamed } from '@shared/entry-feed';
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
  /** It lets an entry's text decide where a contact form sends what visitors write (formDestinationProblems). */
  destination?: true;
}

/** What follows a problem's own words when an entry would decide where a form sends: why it cannot. */
const NEVER_FROM_ENTRY = "a form's destination is set on the form, never read from an entry.";

/** A placed component's property by its label, quoted, for a message. */
const propLabel = (state: ProjectState, n: InstanceNode, prop: string) => `“${own(own(state.components, n.definitionId)?.properties, prop)?.label ?? prop}”`;

/** The fields a query filters and sorts by that are not an entry's (see shared/collection-query.ts). */
const QUERY_ONLY = new Set(['id', 'slug']);
/** A row's fields no query reads: a link to the entry's page is the row's, not a value to filter or sort by. */
const UNQUERIED = new Set(['entryLink']);
/** Whether a query can read `field` of `collection`'s entries. */
const queryable = (collection: Collection, field: string) => QUERY_ONLY.has(field) || (!UNQUERIED.has(field) && !!rowFieldSchema(collection, field));

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
  for (const c of query.where ?? []) {
    if (!queryable(collection, c.field)) return `filters by "${c.field.slice(0, 60)}", which entries of ${name} do not have.`;
    // A grouping's terms are named by ID or label: one it no longer has would leave the list empty.
    const taxonomy = filterTaxonomy(c.field);
    if (taxonomy === undefined || c.op === 'exists') continue;
    const values = Array.isArray(c.value) ? c.value : [c.value];
    const named = values.filter((v) => typeof v === 'string' && termNamed(collection, taxonomy, v.trim()) !== undefined);
    if (c.op === 'in' ? !named.length : named.length !== values.length) return `filters by a term of “${rowFieldSchema(collection, c.field)?.label ?? taxonomy}” that it does not have (${values.map((v) => JSON.stringify(v)).join(', ').slice(0, 80)}).`;
  }
  for (const s of query.sort ?? []) if (s.field !== ENTRY_ORDER_FIELD && !queryable(collection, s.field)) return `sorts by "${s.field.slice(0, 60)}", which entries of ${name} do not have.`;
  return null;
}

/** The grouping a query's filter field reads terms of ("categories", "terms.tags"), or undefined. */
const filterTaxonomy = (field: string) => (field === 'categories' ? 'categories' : field.startsWith('terms.') ? field.slice(6) : undefined);

/** One term named in a query's filter: its words, where the list is, which query, and how to write other words. */
export interface QueryTermSlot {
  value: string;
  /** Where the list is, for a refusal (read only then: a node elsewhere that cannot be named never blocks a change). */
  where: () => string;
  query: object;
  /** The filter it is in: an `in` filter's other terms list the same entries whatever this one names of theirs. */
  clause: object;
  store: (value: string) => void;
}

/**
 * Every term a filter names (by ID or label) of one grouping, in every query reading its collection: collection loops
 * and connected lists, in every tree but a theme's designs (fixed theme data). Read before a term changes, each slot's
 * `store` can then name by ID what it named before, so the list keeps listing what it did.
 */
export function queryTermSlots(state: ProjectState, collectionId: string, taxonomyId: string): QueryTermSlot[] {
  const out: QueryTermSlot[] = [];
  const visit = (owner: OwnerRef, where: () => string, query: unknown) => {
    if (!query || typeof query !== 'object' || queryCollectionOf(state, owner, query as CollectionQuery)?.settings.id !== collectionId) return;
    const clauses = (query as CollectionQuery).where;
    if (!Array.isArray(clauses)) return;
    for (const c of clauses) {
      if (!c || typeof c.field !== 'string' || filterTaxonomy(c.field) !== taxonomyId || c.op === 'exists') continue;
      if (Array.isArray(c.value)) {
        const values = c.value;
        values.forEach((v, i) => typeof v === 'string' && out.push({ value: v, where, query, clause: c, store: (w) => (values[i] = w) }));
      } else if (typeof c.value === 'string') out.push({ value: c.value, where, query, clause: c, store: (w) => (c.value = w) });
    }
  };
  for (const { owner, tree, label } of allTrees(state)) {
    if (owner.kind === 'component' && own(state.components, owner.id)?.owner === 'theme') continue;
    for (const n of Object.values(tree?.nodes ?? {})) {
      if (!n || typeof n !== 'object') continue;
      const where = () => `“${displayName(state, n)}” in ${label}`;
      if (n.kind === 'instance' && n.listSources && typeof n.listSources === 'object') for (const raw of Object.values(n.listSources)) visit(owner, where, (raw as { query?: unknown } | undefined)?.query);
      if (n.kind === 'repeat' && isCollectionLoop(n)) visit(owner, where, (n.list as { $query?: unknown }).$query);
    }
  }
  return out;
}

/** What is wrong with one list property's connection to a collection, or null. */
export function connectionProblem(state: ProjectState, owner: OwnerRef, node: InstanceNode, prop: string, raw: unknown): string | null {
  const def = own(state.components, node.definitionId);
  if (!def) return null;
  const schema = own(def.properties, prop);
  // A list that fills itself (posts, pages) shows the collection instead while connected.
  if (schema?.type !== 'list') return `connects "${prop.slice(0, 60)}" to a collection, but ${def.name} has no list of that name.`;
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
  // Every item shows an entry: one an item must have is filled from it, never left at its sample value, and from a
  // field every entry has (an entry's title), never one that can be empty.
  const unfilled = Object.entries(schema.fields).find(([field, f]) => f.required && !Object.hasOwn(connection.fields, field));
  if (unfilled) return `leaves “${unfilled[1].label}” of “${schema.label}” unfilled, which every item needs: choose the entry field that fills it.`;
  for (const [field, source] of Object.entries(connection.fields)) {
    const target = schema.fields[field];
    const from = rowFieldSchema(collection, source)!;
    // Of its own kind too: a number shown as text (a reading time of none) can be blank.
    const gap = target.required ? (from.type !== target.type ? `“${target.label}” is required, but “${from.label}” is a ${from.type}, which can show as nothing` : requiredGap(from, target)) : null;
    if (gap) return `fills “${target.label}” of “${schema.label}”, but ${gap}: fill it from a field every entry has, such as the title.`;
  }
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
export function loopProblem(state: ProjectState, owner: OwnerRef, tree: NodeTree, node: RepeatNode, parentsOf?: Map<string, GraphNode>): string | null {
  const list = node.list as Record<string, unknown>;
  if (Object.hasOwn(list, '$archive')) {
    if (owner.kind !== 'archive' || list.$archive !== true || Object.keys(list).length !== 1) return "repeats the entries of the archive page it is on, which only a collection's archive layout has.";
  } else if (Object.keys(list).length !== 1) return 'repeats a collection by a query together with something else; repeat one of them.';
  else {
    const problem = queryProblem(state, owner, list.$query);
    if (problem) return problem;
  }
  // One list at a time: each row's elements read its entry, never a row of another list around or inside it.
  const parents = parentsOf ?? parentNodes(tree);
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

/** Each node's parent in a tree. */
function parentNodes(tree: NodeTree): Map<string, GraphNode> {
  const parents = new Map<string, GraphNode>();
  for (const p of Object.values(tree.nodes)) if (p && typeof p === 'object') for (const cl of childLists(p)) for (const c of cl.ids) parents.set(c, p);
  return parents;
}

/**
 * What is wrong with what one element inside a loop reads of its entries: each a message that follows its name, with
 * the place it is about (a field, or a section's property), which names it apart from its wording.
 */
export function loopBindingProblems(state: ProjectState, collection: Collection, n: GraphNode, destination: FormDestinationLookup = formDestinationLookup(state), routesOnly = false): Array<{ place: string; message: string; destination?: true }> {
  const found: Array<{ place: string; message: string; destination?: true }> = [];
  for (const slot of bindingSlots(n)) {
    const out = { push: (message: string, routes?: true) => found.push({ place: `${slot.field}:${slot.prop ?? ''}`, message, ...(routes ? { destination: routes } : {}) }) };
    const condition = slot.field === 'when' || slot.field === 'unless';
    const b = condition ? conditionRef(slot.value) : isBindingRef(slot.value) ? slot.value : undefined;
    if (!b || !isBinding(b) || !('$item' in b)) continue;
    const field = b.$item;
    const schema = typeof field === 'string' ? rowFieldSchema(collection, field) : undefined;
    if (!schema) {
      if (!routesOnly) out.push(`shows "${String(field).slice(0, 60)}", which entries of ${collection.settings.name} do not have.`);
      continue;
    }
    // Where a form sends what visitors write is the site's own, never an entry's: its service, its setting, or a
    // design's property that passes one of them on. Said before anything else about the field (a choice field damaged
    // by hand still hands the entry's value on), so the export always sees it.
    if (slot.field === 'prop' && n.kind === 'instance' && slot.prop !== undefined && destination(n.definitionId, slot.prop)) {
      out.push(`takes where it sends what visitors write (${propLabel(state, n, slot.prop)}) from “${schema.label}”; ${NEVER_FROM_ENTRY}`, true);
      continue;
    }
    // A theme's design is checked for nothing else (collectionSourceProblems).
    if (routesOnly) continue;
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
  return found;
}

/**
 * Why a list of a placement would fill where a contact form sends what visitors write from entries or pages, or null:
 * connected to a collection, a list that fills itself (a feed), or a page list whose items take what they leave empty
 * from the pages they link to, when its items pass a field on to a form's service or setting.
 */
export function listDestinationProblem(state: ProjectState, node: InstanceNode, prop: string, destination: FormDestinationLookup): string | null {
  const def = own(state.components, node.definitionId);
  const schema = def ? own(def.properties, prop) : undefined;
  if (!def || schema?.type !== 'list') return null;
  const connected = !!node.listSources && Object.hasOwn(node.listSources, prop);
  // Asked last: a list filled by hand never needs the walk over the project's designs.
  if ((!connected && !schema.feed && !schema.pageTeaser) || !destination(def.id, prop)) return null;
  const pages = !connected && schema.feed !== 'entries';
  // A page list's items take what they leave empty from the pages they link to (shared/page-teasers.ts).
  const from = connected ? "a collection's entries" : schema.feed ? `the site's ${pages ? 'pages' : 'entries'}` : 'the pages its items link to';
  return `fills where it sends what visitors write (“${schema.label}”) from ${from}; ${pages ? "a form's destination is set on the form, never read from a page." : NEVER_FROM_ENTRY}`;
}

/**
 * What lets an entry decide where a placement's contact form sends what visitors write, outside a collection loop
 * (loopBindingProblems says it there): in a collection's layout, a form's service or setting (or a design's property
 * that passes one on) read from the entry; and anywhere, a list that passes its items on to them filled from a
 * collection or a feed. Each with the place it is about.
 */
function destinationProblems(state: ProjectState, owner: OwnerRef, n: GraphNode, destination: FormDestinationLookup): Array<{ place: string; message: string }> {
  if (n.kind !== 'instance') return [];
  const out: Array<{ place: string; message: string }> = [];
  const collection = owner.kind === 'template' ? own(state.collections, owner.id) : undefined;
  if (collection && n.props && typeof n.props === 'object')
    for (const [prop, v] of Object.entries(n.props))
      if (isEntryBinding(v) && destination(n.definitionId, prop)) out.push({ place: `entry:${prop}`, message: `takes where it sends what visitors write (${propLabel(state, n, prop)}) from the entry's “${entryFieldLabel(collection, String(v.$entry))}”; ${NEVER_FROM_ENTRY}` });
  const def = own(state.components, n.definitionId);
  for (const prop of Object.keys(def?.properties ?? {})) {
    const problem = listDestinationProblem(state, n, prop, destination);
    if (problem) out.push({ place: `list:${prop}`, message: problem });
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
 * Every problem with the project's connected lists, collection loops and what their elements read, and every place an
 * entry would decide where a contact form sends (destinationProblems), in every tree but a theme's designs (fixed
 * theme data, checked when the theme is built).
 */
export function collectionSourceProblems(state: ProjectState, trees: Array<{ owner: OwnerRef; tree: NodeTree; label: string }> = allTrees(state), destination: FormDestinationLookup = formDestinationLookup(state)): SourceProblem[] {
  const out: SourceProblem[] = [];
  for (const { owner, tree, label } of trees) {
    const def: ComponentDefinition | undefined = owner.kind === 'component' ? state.components[owner.id] : undefined;
    if (!tree?.nodes || typeof tree.nodes !== 'object') continue;
    // A theme's design is fixed theme data, checked when the theme is built, but read from the project's files like any
    // other: whether an entry decides where its form sends is still checked, since the website shows what it says.
    const themed = def?.owner === 'theme';
    const loops = enclosingLoops(tree);
    let parents: Map<string, GraphNode> | undefined;
    for (const n of Object.values(tree.nodes)) {
      if (!n || typeof n !== 'object') continue;
      if (!themed && n.kind === 'instance' && n.listSources && typeof n.listSources === 'object')
        for (const [prop, raw] of Object.entries(n.listSources)) {
          const problem = connectionProblem(state, owner, n, prop, raw);
          if (problem) out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:list:${prop}`, message: problem });
        }
      if (!themed && isCollectionLoop(n) && n.kind === 'repeat') {
        const problem = loopProblem(state, owner, tree, n, (parents ??= parentNodes(tree)));
        if (problem) out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:loop`, message: problem });
      }
      const loop = loops.get(n.id);
      const collection = loop ? loopCollection(state, owner, loop) : undefined;
      if (collection)
        for (const problem of loopBindingProblems(state, collection, n, destination, themed))
          out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:item:${problem.place}${problem.destination ? ':destination' : ''}`, message: problem.message, ...(problem.destination ? { destination: true as const } : {}) });
      for (const problem of destinationProblems(state, owner, n, destination)) out.push({ owner, label, node: n, nodeId: n.id, key: `${owner.kind}:${owner.id}:${n.id}:destination:${problem.place}`, message: problem.message, destination: true });
    }
  }
  return out;
}

/**
 * The places an entry's text (or a page's) would decide where a contact form sends what visitors write: a layout's
 * form reading its service or setting from the entry, a loop's from each row, or a list filled from entries or pages
 * that passes them on. Export refuses a project that has one, as edits refuse making one.
 */
export function formDestinationProblems(state: ProjectState): SourceProblem[] {
  return collectionSourceProblems(state).filter((p) => p.destination);
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
  const routes = listDestinationProblem(state, node, op.prop, formDestinationLookup(state));
  if (routes) {
    delete node.listSources[op.prop];
    if (!Object.keys(node.listSources).length) delete node.listSources;
    fail(`${displayName(state, node)} ${routes}`);
  }
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

/**
 * Whether a placement shows a collection's entries anywhere it renders: a list connected to one, or a collection loop
 * in its design or in the designs placed inside it.
 */
export function showsCollection(state: ProjectState, def: ComponentDefinition, node?: InstanceNode, seen = new Set<string>()): boolean {
  if (node?.listSources && Object.keys(node.listSources).length) return true;
  if (seen.has(def.id) || !def.tree) return false;
  seen.add(def.id);
  return Object.values(def.tree.nodes).some((n) => isCollectionLoop(n) || (n.kind === 'instance' && (!!(n.listSources && Object.keys(n.listSources).length) || (!!own(state.components, n.definitionId) && showsCollection(state, state.components[n.definitionId], undefined, seen)))));
}
