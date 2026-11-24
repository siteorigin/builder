/**
 * Checks on what a page will actually show, evaluated with the same rules the generated components use.
 */
import type { Binding, Collection, ComponentDefinition, EntryDoc, GraphNode, ImageValue, InstanceNode, LinkValue, NodeTree, OwnerRef, PageDoc, ProjectState, PropSchema, ResponsiveStyles } from '@shared/types';
import { propBindingSchema, propBindingValue } from '@shared/bindings';
import { TEXT_TAGS, conditionHolds, conditionRef, isBinding, isComparison, isStateRef, slotChildren, stateInitial, type Condition } from '@shared/types';
import { isImageBlock, isListBlock, isRichBlock, richTextToPlain, spanRuns, toRichText, type RichSpan } from '@shared/richtext';
import type { EditOperation } from '@shared/ops';
import { slugify } from '@shared/routes';
import { publicUrl } from '@shared/public-url';
import { entryRoute, findEntry, type SiteEntry } from '@shared/collections';
import { archivePages } from '@shared/archives';
import { entryQuery, feedRows } from '@shared/entry-feed';
import { anchorCapable, anchorsInUse, displayName, findParent, shownUnder } from '@engine/tree';
import { declaredState } from '@engine/schema';
import { formFieldSettingsHidden, namesFormFields, netlifyFormName, offersFormChoices } from '@catalogue/foundation/form';
import { codeTakesBlocks, defFile, isDraftEntry, isDraftPage, keptPanels, liveRedirects, optionalTabGates, publishedState, resolveLink, siteEntries, stateActionWorks } from './index';
import { effectiveItem, teaserFields } from '@shared/page-teasers';
import { pagesShowing, partsShown, SHELL_PARTS, showsPart, type ShellPart } from '@shared/page-shell';
import { actionWraps } from './card-links';
import { parseVideoUrl } from '@shared/video';
import { derived } from './cache';
import { entryNeighbours, materializeTemplate, showsBody } from './entry-template';
import { selectedVariantStyles, startingVariants } from '@shared/variants';
import { itemStylesOf } from '@shared/item-styles';

const BUTTONS = new Set(['primary', 'secondary', 'text', 'light']);

export interface Scope {
  props: Record<string, unknown>;
  /** The UI state of the definition being walked, at the values every placement starts with. */
  ui?: Record<string, unknown>;
  /** Every value the UI state can take, not only the one it starts at: a condition on it lets content render. */
  everyState?: boolean;
  /**
   * With `everyState`, the options of the definition's choices that only an optional tab sets, with the condition the
   * tab shows on: a placement without the tab can never reach the option (see optionalTabGates).
   */
  gates?: ReadonlyMap<string, ReadonlyArray<{ value: string; gate: Condition }>>;
  /** Inside a panel kept in the page while its component's state hides it (a `kept` walk): in the HTML, not on screen. */
  keptHidden?: boolean;
  /** The placement's variant choices, with axes bound to the enclosing design's UI state at the option it starts at. */
  chosen?: InstanceNode['variants'];
  /** The placements this scope sits in, from the page down, to tell their links apart. */
  trail?: string;
  item?: Record<string, unknown>;
  /** Fields of the list the current item comes from, for their defaults. */
  fields?: Record<string, PropSchema>;
  /** The property holding that list, when the definition's own property is the list. */
  list?: string;
  /** The placement in the page or shell tree, while walking the definition it places directly. */
  placement?: string;
  /** Inside a component placed in another's design: which of its properties the placement's own fields fill. */
  forwarded?: Record<string, PlacementField>;
  /** How many lists were entered since the placement, and the item of the first, which this rendering is part of. */
  repeats?: number;
  occurrence?: string;
  /** The items of the lists entered in this definition, outermost first (what the editor's selection names). */
  path?: string[];
  /** Walked once but rendered more than once: slot content the receiving component places inside a list. */
  multiple?: boolean;
  /** The slots this content is shown through, outermost first, each named by the frame supplying it and the slot. */
  slots?: string[];
  /** Shown through a code component's slot: counted as shown more than once, though its markup may show it once. */
  codeSlot?: boolean;
  /** Inside a computed list's item (a News card, an article header): words that come from a page's settings. */
  computed?: boolean;
  /** The definition's computed lists, by property: a binding to one is never a field of the placement. */
  feedProps?: Set<string>;
  /** The definition's own lists the design around it fills from one of its computed lists. */
  fedLists?: Set<string>;
  /** The instance node rendering the definition walked, wherever it is placed (the page, the shell or a design). */
  instance?: GraphNode & { kind: 'instance' };
  /** The placements entered from the page or shell tree down to the definition walked (an ElementRef's instancePath). */
  instances?: string[];
  /**
   * For slot content: the design that shows it, where the slot is (its placements from the tree, the lists around the
   * slot in that design and their items). The content belongs to the frame that supplied it; this is where it shows.
   */
  shownIn?: { instances: string[]; repeats: string[]; path: string[] };
}

export function evaluate(v: unknown, scope: Scope): unknown {
  if (isStateRef(v)) {
    const at = scope.ui && Object.hasOwn(scope.ui, v.$state) ? scope.ui[v.$state] : undefined;
    // An item state reads as whether the item walked is the active one.
    return at instanceof ActiveItem ? at.id !== null && scope.item?.id === at.id : at;
  }
  if (!isBinding(v)) return v;
  const b = v as Binding;
  if ('$prop' in b) return propBindingValue(scope.props[b.$prop], b);
  if (!('$item' in b)) return undefined;
  const item = scope.item ?? {};
  return Object.hasOwn(item, b.$item) ? item[b.$item] : (scope.fields?.[b.$item] as { default?: unknown } | undefined)?.default;
}

/** The item an item state starts at in one placement, by ID (null for an empty list), as the scope's `ui` holds it. */
class ActiveItem {
  constructor(readonly id: unknown) {}
}

/**
 * Where a placement's UI state starts: its declared starting value, or for an item state the item at its starting
 * position in the placement's list (the last when the list is shorter), as the generated site's activeItem works it out.
 */
function startingState(def: ComponentDefinition, name: string, props: Record<string, unknown>): unknown {
  const declared = declaredState(def, name);
  if (declared?.type !== 'item') return stateInitial(def, name);
  const rows = Array.isArray(props[declared.list]) ? (props[declared.list] as unknown[]) : [];
  const row = rows.length ? rows[Math.min(declared.initial, rows.length - 1)] : undefined;
  return new ActiveItem(row && typeof row === 'object' ? ((row as { id?: unknown }).id ?? null) : null);
}

/** Mirrors the generated `has()` helper, on unresolved values. */
export function shown(v: unknown, state: ProjectState): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('type' in o && 'target' in o) return !!resolveLink(o as unknown as LinkValue, { state });
    if ('assetId' in o) return !!o.assetId && !!state.assets.assets[String(o.assetId)];
    return true;
  }
  return !!v;
}

export interface Visit {
  /**
   * Walk what a visitor can reach by changing a component's UI state too (a tab not chosen at first, a closed
   * disclosure), not only what shows at first.
   */
  everyState?: boolean;
  /**
   * Walk the markup a page ships: what shows at first, and the panels a component keeps in the page while its state
   * hides them (see keptPanels). For checks of the HTML itself (its IDs, its forms, the links the build follows);
   * what visitors see at first is walked without it.
   */
  kept?: boolean;
  /** Every node about to render, before its kind's own callback; `def` is the definition it belongs to, for a component's node. */
  node?: (n: GraphNode, scope: Scope, reportId: string, inDef: boolean, def?: ComponentDefinition) => void;
  /**
   * A link node about to render; `inDef` when it is a component definition's node rather than the tree's own, and
   * `ownId` the id its markup carries.
   */
  link?: (n: GraphNode & { kind: 'link' }, scope: Scope, reportId: string, inDef: boolean, ownId: string | undefined, def: ComponentDefinition | undefined) => void;
  /** Content of the slot named (as in `Scope.slots`) is shown again, by another slot of the same name. */
  again?: (slot: string) => void;
  /** An image node about to render. */
  image?: (n: GraphNode & { kind: 'image' }, scope: Scope, reportId: string) => void;
  /**
   * A design's image node left out of the page only because it has no image yet: its sole condition is its own image
   * (`when` reads the value the image shows, with no `unless`). Everything around it renders.
   */
  hiddenImage?: (n: GraphNode & { kind: 'image' }, scope: Scope, reportId: string) => void;
  /** A text node about to render; `def` is the definition it belongs to, for a component's node. */
  text?: (n: GraphNode & { kind: 'text' }, scope: Scope, reportId: string, inDef: boolean, def?: ComponentDefinition) => void;
  /** An `id` attribute the generated markup will carry. */
  id?: (id: string, reportId: string) => void;
  /**
   * A code component placement about to render, with its effective property values; `n` is its instance node,
   * `scope` where it is placed, and `inDef` when that is inside another component's design.
   */
  code?: (def: ComponentDefinition, props: Record<string, unknown>, reportId: string, placement: string, n: GraphNode & { kind: 'instance' }, scope: Scope, inDef: boolean) => void;
  /** A page-level node (page or shell tree) about to render, before anything inside it. */
  enter?: (n: GraphNode) => void;
  /** After everything inside a page-level node has been visited. */
  leave?: (n: GraphNode) => void;
  /** After everything inside any node `node` was called for has been visited: page and component nodes alike, in pairs. */
  done?: (n: GraphNode, scope: Scope, reportId: string) => void;
  /**
   * A node to leave out with everything inside it, decided before it is visited (`node` is not called for it), so
   * nothing in it counts as shown: a slot it holds is still walked where it is shown next.
   */
  prune?: (n: GraphNode, scope: Scope, reportId: string, def: ComponentDefinition | undefined) => boolean;
  /**
   * Which documents the walk may show of others: the rows of a computed list (news, posts) and the cards of a page
   * list whose link fails it are left out where the list is filled, before any design hands the list on.
   */
  listed?: (link: unknown) => boolean;
}

/** Where the walk is: the tree being read and, inside a component, the placement that put it there. */
interface Frame {
  tree: NodeTree;
  /** The definition being walked; none for a page or shell tree. */
  def?: ComponentDefinition;
  /**
   * Its nodes kept in the page while its UI state hides them (a tab not chosen, a closed disclosure): they are in the
   * markup the page ships, so they count as rendered (see keptPanels).
   */
  kept?: ReadonlySet<string>;
  scope: Scope;
  /** The id the placement gives the definition's root (`so_id`). */
  soId?: string;
  /** The placement's slot content, rendered where the definition places each slot, in the placement's frame. */
  slots?: { content: Record<string, string[]>; frame: Frame; owner: string };
  /** The page or shell node findings report against. */
  reportId?: string;
  /** Tells frames apart, so the same definition can render inside itself through slot content. */
  n: number;
  /** Definitions being expanded through definition trees on the way here: one that places itself stops. */
  defs: Set<string>;
  /** The frame this one is a copy of (with a scope marking how its slot content is shown): one frame for dedupe. */
  origin?: Frame;
}

/** Each property's effective value for a placement: its own (evaluated where it is placed) or the default. */
export function effectiveProps(
  state: ProjectState,
  def: ComponentDefinition,
  n: GraphNode & { kind: 'instance' },
  scope: Scope,
  pageId?: string,
  entry?: { collectionId: string; entryId: string },
  listed?: (link: unknown) => boolean
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(def.properties)) {
    const own = Object.hasOwn(n.props, name);
    // A computed list holds what the site's pages (or a collection's entries) give it where it is placed, as the
    // generator writes it: it is never bound or stored. An entry feed shows what the placement's own values chose.
    if (schema.type === 'list' && schema.feed) {
      // Shaped as the list's own items, as the generator writes them: its ID and declared fields only.
      const rows = feedRows(state, schema, { pageId, entry, query: entryQuery(def.properties, n.props) });
      props[name] = (listed ? rows.filter((row) => listed(row.pageLink)) : rows).map((row) => ({
        ...Object.fromEntries(Object.entries(schema.fields).map(([k, f]) => [k, Object.hasOwn(row, k) ? row[k] : f.default])),
        id: row.id
      }));
      continue;
    }
    const value = own ? evaluate(n.props[name], scope) : schema.default;
    // A page list's own (or default) items show the linked pages' values, which the generator fills in where the list
    // is placed. A list bound from the design around this one arrives as that design was given it.
    const teaser = schema.type === 'list' && Array.isArray(value) ? schema.pageTeaser : undefined;
    const filled = !!teaser && !(own && isBinding(n.props[name]));
    // A card whose page the walk may not show is left out, before its fields are filled from that page, whether the
    // list is the placement's own or handed in by the design around it.
    const items = teaser && listed ? (value as unknown[]).filter((it) => !it || typeof it !== 'object' || listed((it as Record<string, unknown>)[teaser.link])) : value;
    props[name] = filled ? (items as unknown[]).map((it) => (it && typeof it === 'object' ? effectiveItem(state, schema as Extract<PropSchema, { type: 'list' }>, it as Record<string, unknown>) : it)) : items;
    // An object's field it has no value for shows the property's own default for it (or the field's), as the
    // generator fills it in.
    if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      const d = (schema.default ?? {}) as Record<string, unknown>;
      props[name] = { ...v, ...Object.fromEntries(Object.entries(schema.fields).filter(([k]) => !Object.hasOwn(v, k)).map(([k, f]) => [k, Object.hasOwn(d, k) ? d[k] : f.default])) };
    }
  }
  return props;
}

/**
 * Walk what a page or shell tree renders, the way the generated components render it: page nodes, and inside
 * each managed component the nodes whose conditions hold (once per list item), its nested components with their
 * evaluated properties, and the placement's slot content where the definition places that slot. Callbacks
 * report against the page node (the outermost instance for anything inside a component).
 */
const SO_ID_ATTR = /\bid=\{\s*so_id\b/;

/** Whether a property is a computed list (a News list, an article header). */
const isFeed = (schema: PropSchema | undefined) => schema?.type === 'list' && !!schema.feed;

/** Whether a `when` or `unless` condition holds in a scope, as the generated `{#if}` decides it. */
function holds(c: Condition, scope: Scope, state: ProjectState): boolean {
  return conditionHolds(c, evaluate(conditionRef(c), scope), (v) => shown(v, state));
}

/**
 * Whether a node's `when` (or, `negate`d, its `unless`) lets it render; on UI state, with `everyState`, it may, unless
 * it asks for an option only an optional tab sets and the placement leaves that tab out.
 */
function lets(c: Condition, negate: boolean, scope: Scope, state: ProjectState): boolean {
  const ref = conditionRef(c);
  if (scope.everyState && isStateRef(ref)) {
    const gate = !negate && isComparison(c) && 'eq' in c ? scope.gates?.get(ref.$state)?.find((g) => g.value === c.eq)?.gate : undefined;
    return !gate || holds(gate, scope, state);
  }
  return holds(c, scope, state) !== negate;
}

/** Mirrors the generator's render conditions inside a definition: a node's own conditions, a repeat's list, a collapsing element's children. */
function nodeRenders(state: ProjectState, frame: Frame, n: GraphNode, seen: Set<string>): boolean {
  const kept = !!frame.kept?.has(n.id);
  if (n.when && !kept && !lets(n.when, false, frame.scope, state)) return false;
  if (n.unless && !kept && !lets(n.unless, true, frame.scope, state)) return false;
  if (n.kind === 'repeat') return shown(evaluate(n.list, frame.scope), state);
  return n.kind !== 'element' || !n.collapseEmpty || childRenders(state, frame, n, seen);
}

/** Whether a node of a definition's tree renders in a scope: its conditions, a repeat's list, a collapsing element's children. */
export function rendersIn(state: ProjectState, tree: NodeTree, scope: Scope, n: GraphNode): boolean {
  return nodeRenders(state, { tree, scope, n: 0, defs: new Set() }, n, new Set());
}

/**
 * Whether a list's category filter (RepeatNode.filter) shows its pills in one placement (`scope`, its values as
 * effectiveProps gives them), as the generated component decides: its switch on, or none, the list rendering, and the
 * items that render naming two categories or more, told apart as the site's filterKey tells them (a choice by its exact
 * value, text by its trimmed, lower-case words).
 */
export function filterShowsAt(state: ProjectState, def: ComponentDefinition, repeat: GraphNode, scope: Scope): boolean {
  const tree = def.tree;
  const f: unknown = repeat.kind === 'repeat' ? repeat.filter : undefined;
  if (!tree || repeat.kind !== 'repeat' || !f || typeof f !== 'object' || typeof (f as { field?: unknown }).field !== 'string') return false;
  const { field, when } = f as { field: string; when?: unknown };
  if (when !== undefined) {
    // As the site reads a yes/no property: a value that is not true or false shows its default.
    const on = evaluate(when, scope);
    const prop = isBinding(when) && '$prop' in when && Object.hasOwn(def.properties, when.$prop) ? def.properties[when.$prop] : undefined;
    if ((typeof on === 'boolean' ? on : prop?.type === 'boolean' ? prop.default : on) !== true) return false;
  }
  if (!rendersIn(state, tree, scope, repeat)) return false;
  const list = repeat.list && typeof repeat.list === 'object' && Object.hasOwn(def.properties, repeat.list.$prop) ? def.properties[repeat.list.$prop] : undefined;
  if (list?.type !== 'list') return false;
  const schema = Object.hasOwn(list.fields, field) ? list.fields[field] : undefined;
  const options = schema?.type === 'enum' && Array.isArray(schema.options) ? schema.options.map((o) => o?.value) : undefined;
  const rows = evaluate(repeat.list, scope);
  const keys = new Set<string>();
  for (const item of Array.isArray(rows) ? rows : []) {
    if (!item || typeof item !== 'object') continue;
    const inner: Scope = { ...scope, item: item as Record<string, unknown>, fields: list.fields };
    if (!repeat.children.some((c) => Object.hasOwn(tree.nodes, c) && rendersIn(state, tree, inner, tree.nodes[c]))) continue;
    const v = (item as Record<string, unknown>)[field];
    const key = typeof v !== 'string' ? '' : options ? (options.includes(v) ? v : '') : v.trim().toLowerCase();
    if (key) keys.add(key);
  }
  return keys.size > 1;
}

/** A collapsing element renders while any child does; with no children it stays. */
function childRenders(state: ProjectState, frame: Frame, n: GraphNode & { kind: 'element' }, seen: Set<string>): boolean {
  if (seen.has(n.id)) return true;
  seen.add(n.id);
  const kids = n.children.map((id) => frame.tree.nodes[id]).filter((k): k is GraphNode => !!k);
  return !kids.length || kids.some((k) => nodeRenders(state, frame, k, seen));
}

export function walkRendered(state: ProjectState, tree: NodeTree, visit: Visit) {
  let frames = 0;
  // A page's placements, and the designs inside them, work computed lists out for that page; the shared header and
  // footer for none.
  const treeId = (tree as Partial<PageDoc>).id;
  const pageId = typeof treeId === 'string' && 'route' in tree && Object.hasOwn(state.pages, treeId) ? treeId : undefined;
  // An entry's page: its feeds default to its collection and leave it out, as the generator writes them.
  const entry = entryTrees.get(tree);
  // A slot a definition renders once per list item shows the same content, in the same frame, each time: it is
  // walked once per frame, which keeps nested placements of such a component from multiplying the walk.
  const slotsWalked = new WeakMap<Frame, Set<string>>();
  // Worked out once per definition per walk, sharing the site's card analysis between definitions.
  const keptIn = new Map<string, ReadonlySet<string>>();
  const keptMemo = {};
  const keptOf = (def: ComponentDefinition) => keptIn.get(def.id) ?? keptIn.set(def.id, keptPanels(state, def, keptMemo)).get(def.id)!;
  const gatesIn = new Map<string, ReturnType<typeof optionalTabGates>>();
  const gatesOf = (def: ComponentDefinition) => gatesIn.get(def.id) ?? gatesIn.set(def.id, optionalTabGates(state, def, keptMemo)).get(def.id)!;
  const walk = (frame: Frame, id: string, path: Set<string>) => {
    const n = frame.tree.nodes[id];
    const key = `${frame.n}:${id}`;
    if (!n || path.has(key)) return;
    const kept = !!frame.kept?.has(id);
    const shows = !frame.def || ((!n.when || lets(n.when, false, frame.scope, state)) && (!n.unless || lets(n.unless, true, frame.scope, state)));
    if (!shows && !kept) {
      // An image its own condition leaves out while no image is chosen (a team member with no portrait yet).
      if (visit.hiddenImage && n.kind === 'image' && hidesWhileEmpty(n)) visit.hiddenImage(n, frame.scope, frame.reportId ?? n.id);
      return;
    }
    // A kept panel its state hides is walked as hidden content, and so is everything inside it.
    if (!shows && !frame.scope.keptHidden) frame = { ...frame, scope: { ...frame.scope, keptHidden: true } };
    if (frame.def && n.kind === 'element' && n.collapseEmpty && !childRenders(state, frame, n, new Set())) return;
    if (visit.prune?.(n, frame.scope, frame.reportId ?? n.id, frame.def)) return;
    const inner = new Set(path).add(key);
    const reportId = frame.reportId ?? n.id;
    const page = !frame.def;
    if (page) visit.enter?.(n);
    // A definition's root takes the id its placement gives it first (`so_id ?? anchor`).
    const ownId = frame.def && frame.def.tree?.rootIds[0] === id ? (frame.soId ?? n.anchor) : n.anchor;
    visit.node?.(n, frame.scope, reportId, !!frame.def, frame.def);
    switch (n.kind) {
      case 'link':
        visit.link?.(n, frame.scope, reportId, !!frame.def, ownId, frame.def);
        break;
      case 'image':
        visit.image?.(n, frame.scope, reportId);
        break;
      case 'text':
        visit.text?.(n, frame.scope, reportId, !!frame.def, frame.def);
        break;
      case 'element':
        for (const c of n.children) walk(frame, c, inner);
        break;
      case 'repeat': {
        if (!frame.def) break;
        const items = evaluate(n.list, frame.scope);
        const schema = isBinding(n.list) && '$prop' in n.list ? frame.def.properties[n.list.$prop] : undefined;
        const fields = schema?.type === 'list' ? schema.fields : undefined;
        // A computed list's items are pages, not stored items: nothing shown from them is a field to edit here.
        const list = schema?.type === 'list' && !schema.feed && isBinding(n.list) && '$prop' in n.list ? n.list.$prop : undefined;
        const repeats = (frame.scope.repeats ?? 0) + 1;
        for (const item of Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []) {
          const occurrence = repeats === 1 && typeof item?.id === 'string' ? item.id : frame.scope.occurrence;
          const path = [...(frame.scope.path ?? []), String(item?.id ?? '')];
          // Each list decides for its own items: a computed one (or one a design fills from one) holds pages' rows,
          // an ordinary list inside such a row holds the placement's own items.
          const listName = isBinding(n.list) && '$prop' in n.list ? n.list.$prop : undefined;
          const computed = (schema?.type === 'list' && !!schema.feed) || (!!listName && !!frame.scope.fedLists?.has(listName)) || undefined;
          for (const c of n.children) walk({ ...frame, scope: { ...frame.scope, item, fields, list, repeats, occurrence, path, computed } }, c, inner);
        }
        break;
      }
      case 'slot': {
        const from = frame.slots;
        if (!from) break;
        const k = `${from.owner}:${n.slot}`;
        const supplier = from.frame.origin ?? from.frame;
        const walked = slotsWalked.get(supplier) ?? new Set<string>();
        // Named by the supplying frame and the item it renders for: rows of one list copy one frame, each its own slot.
        const slot = JSON.stringify([from.frame.n, from.owner, n.slot, from.frame.scope.path ?? []]);
        if (walked.has(k)) {
          visit.again?.(slot);
          break;
        }
        slotsWalked.set(supplier, walked.add(k));
        // Content a slot inside a list shows once per item, though it is walked once, in the frame that supplied it.
        const multiple = from.frame.scope.multiple || frame.scope.multiple || (frame.scope.repeats ?? 0) > (from.frame.scope.repeats ?? 0);
        // Shown through this slot and every slot the receiving frame is itself shown through (a slot handed on into
        // another design's slot shows again wherever that one does).
        const slots = [...new Set([...(from.frame.scope.slots ?? []), ...(frame.scope.slots ?? []), slot])];
        // A slot handed on into another design's slot shows its content in that other design (the innermost one).
        const shownIn = frame.scope.shownIn ?? (frame.def?.tree ? { instances: frame.scope.instances ?? [], repeats: repeatsAbove(frame.def.tree, n.id), path: frame.scope.path ?? [] } : undefined);
        // Shown where the slot is: inside a panel or dialog its state keeps hidden, the content is hidden with it.
        const keptHidden = from.frame.scope.keptHidden || frame.scope.keptHidden;
        const target = { ...from.frame, origin: supplier, scope: { ...from.frame.scope, multiple, slots, ...(shownIn ? { shownIn } : {}), ...(keptHidden ? { keptHidden } : {}) } };
        for (const c of slotChildren({ slots: from.content }, n.slot)) walk(target, c, inner);
        break;
      }
      case 'instance': {
        const def = state.components[n.definitionId];
        if (!def || frame.defs.has(def.id)) break;
        // Designs placed from a page get that page's rows handed down (`so_pages`), as the generator writes them.
        const props = effectiveProps(state, def, n, frame.scope, pageId, entry, visit.listed);
        if (def.kind === 'managed' && def.tree) {
          const trail = `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`;
          // A component inside a design reads the placement's own fields only through the bindings it is given.
          const forwarded: Record<string, PlacementField> = {};
          const fedLists = new Set<string>();
          if (frame.def) for (const [k, v] of Object.entries(n.props)) {
            // A computed list handed on is still the pages' rows: nothing in it is a field of the placement.
            if (isBinding(v) && '$prop' in v && isFeed(frame.def.properties[v.$prop])) {
              fedLists.add(k);
              continue;
            }
            const f = placementField(v, frame.scope);
            if (f) forwarded[k] = f;
          }
          const feedProps = new Set(Object.entries(def.properties).filter(([, p]) => isFeed(p)).map(([k]) => k));
          const carried = { multiple: frame.scope.multiple, slots: frame.scope.slots, codeSlot: frame.scope.codeSlot, ...(frame.scope.keptHidden ? { keptHidden: true } : {}) };
          const where = frame.def ? { forwarded, repeats: frame.scope.repeats, occurrence: frame.scope.occurrence, ...carried } : { placement: n.id, ...carried };
          const ui = def.state ? Object.fromEntries(Object.keys(def.state).map((k) => [k, startingState(def, k, props)])) : undefined;
          const chosen = startingVariants(n.variants, frame.def);
          const child: Frame = { tree: def.tree, def, ...(visit.kept ? { kept: keptOf(def) } : {}), scope: { props, trail, instance: n, instances: [...(frame.scope.instances ?? []), n.id], ...(ui ? { ui } : {}), ...(visit.everyState ? { everyState: true, ...(gatesOf(def).size ? { gates: gatesOf(def) } : {}) } : {}), ...(chosen !== n.variants ? { chosen } : {}), ...where, ...(feedProps.size ? { feedProps } : {}), ...(fedLists.size ? { fedLists } : {}) }, soId: ownId, slots: { content: n.slots ?? {}, frame, owner: n.id }, reportId, n: ++frames, defs: new Set(frame.defs).add(def.id) };
          for (const r of def.tree.rootIds) walk(child, r, inner);
        } else {
          visit.code?.(def, props, reportId, `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`, n, frame.scope, !!frame.def);
          // Code that places `so_id` as an id (a converted section does, on its root) carries the placement's id.
          if (ownId && SO_ID_ATTR.test(def.source ?? '')) visit.id?.(ownId, reportId);
          // Code places its slot content where its own markup says; count all of it as rendered, as often as it likes.
          const placed = frame.scope.multiple ? frame : { ...frame, origin: frame.origin ?? frame, scope: { ...frame.scope, multiple: true, codeSlot: true } };
          for (const slot of Object.keys(n.slots ?? {})) for (const c of slotChildren(n, slot)) walk(placed, c, inner);
        }
        break;
      }
    }
    // An instance hands its id to the definition's root, which reports it there.
    if (ownId && n.kind !== 'instance' && n.kind !== 'repeat' && n.kind !== 'slot') visit.id?.(ownId, reportId);
    visit.done?.(n, frame.scope, reportId);
    if (page) visit.leave?.(n);
  };
  const top: Frame = { tree, scope: { props: {} }, n: 0, defs: new Set() };
  for (const r of tree.rootIds) walk(top, r, new Set());
}

/** A question and its answer, as an FAQ on a page shows them. */
export interface FaqEntry {
  question: string;
  answer: string;
}

/** The contact facts one contact section shows, as the page writes them. */
export interface BusinessFacts {
  email: string[];
  telephone: string[];
  address: string[];
}

/** Icons a contact method shows beside an address. */
const ADDRESS_ICONS = new Set(['map-pin', 'map-pinned', 'map', 'building', 'building-2', 'house', 'store', 'navigation']);

/** Whether a definition is a catalogue component, or a project copy made from one. */
const isComponent = (def: ComponentDefinition | undefined, componentId: string) => !!def && (def.componentId === componentId || def.provenance?.componentId === componentId);

/** Text as a visitor reads it: rich text (a rich node's string included) as its plain words, any run of whitespace as one space. */
const plainText = (v: unknown, rich = false) => (typeof v === 'string' && !rich ? v : typeof v === 'string' || Array.isArray(v) ? richTextToPlain(toRichText(v)) : '').replace(/\s+/g, ' ').trim();

/** A label that is itself a telephone number, as opposed to words such as "Call reception". */
const phoneLike = (s: string) => /^[+(\d][\d\s().\-/+]*$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 6;

type Size = (typeof SIZES)[number];

/**
 * The sizes at which layers of styles, weaker first, hide an element, as the stylesheet decides: within a layer a
 * size's own value beats its all-sizes value, and a stronger layer's all-sizes value (a hide, or a layout or display
 * that shows it) beats a weaker layer's values at every size.
 */
function hiddenSizes(layers: Array<ResponsiveStyles | undefined>): Set<Size> {
  const hidden = new Map<Size, boolean>(SIZES.map((z) => [z, false]));
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const base = l.base && typeof l.base === 'object' ? (l.base as Record<string, unknown>) : undefined;
    if (base?.hidden === true) for (const z of SIZES) hidden.set(z, true);
    else if (showsAt(base)) for (const z of SIZES) hidden.set(z, false);
    for (const z of SIZES) {
      const at = l[z] as Record<string, unknown> | undefined;
      if (at && typeof at === 'object' && at.hidden === true) hidden.set(z, true);
      else if (showsAt(at)) hidden.set(z, false);
    }
  }
  return new Set(SIZES.filter((z) => hidden.get(z)));
}

/** Whether what sits inside every one of these is hidden at every size: each size hidden by one of them at least. */
const hiddenEverySize = (sets: Array<Set<Size>>) => SIZES.every((z) => sets.some((s) => s.has(z)));

/**
 * The sizes at which a design's node is hidden, by itself or one of its ancestors in the design: by the design, the
 * options its placement chose, the placement's styles for that part, or the current item's own. A placement made in
 * the page or inside another design is read the same way; whether that design hides the placement itself is not
 * known here.
 */
function hiddenInDesign(def: ComponentDefinition, nodeId: string, scope: Scope, variants = true): Array<Set<Size>> {
  if (!def.tree) return [];
  const inst = scope.instance;
  const itemId = typeof scope.item?.id === 'string' ? scope.item.id : undefined;
  const out: Array<Set<Size>> = [];
  const seen = new Set<string>();
  for (let id: string | null | undefined = nodeId; id && !seen.has(id); id = findParent(def.tree, id)?.parentId) {
    seen.add(id);
    const part = Object.entries(def.parts).find(([, p]) => p.nodeId === id)?.[0];
    const own = part && inst ? [inst.overrides?.[part], itemId ? itemStylesOf(def, inst, part, itemId) : undefined] : [];
    out.push(hiddenSizes([def.tree.nodes[id]?.styles, ...(variants ? selectedVariantStyles(def, scope.chosen ?? inst?.variants, id) : []), ...own]));
  }
  return out;
}

/**
 * Whether a design's node is surely hidden at every size, by itself or one of its ancestors in the design: hidden
 * both as its own styles and its placement's say and with its variant options read too. Where variants decide it
 * either way (their rules and bound choices are read only roughly here), the part is kept, in doubt, rather than
 * visible words lost.
 */
export function hiddenInDesignEverywhere(def: ComponentDefinition, nodeId: string, scope: Scope): boolean {
  return hiddenEverySize(hiddenInDesign(def, nodeId, scope, false)) && hiddenEverySize(hiddenInDesign(def, nodeId, scope));
}

/**
 * What a page shows that search engines read as structured data: each question and answer of its FAQ sections, in
 * order, and the email addresses, telephone numbers and addresses of each contact section, in its own content and in
 * the shared header and footer it shows. Read as the page renders them (conditions, list items, slot content and the
 * placement's values), from the theme's FAQ and Contact details and project copies of them whose design still has
 * those nodes; what is hidden at every size is left out, as visitors never see it.
 */
export function structuredContent(state: ProjectState, page: PageDoc): StructuredContent {
  // The shared header and footer are read once per run, and a page depends on what they show, not on every edit to them.
  const shell = (part: ShellPart): StructuredContent => (showsPart(page, part) ? derived(state, `structured:${part}`, (s) => structuredIn(s, [s.site.shell[part]])) : { faq: [], businesses: [] });
  const parts = [shell('header'), structuredIn(state, [page]), shell('footer')];
  return { faq: parts.flatMap((p) => p.faq), businesses: parts.flatMap((p) => p.businesses) };
}

/** What `structuredContent` reads from page or shell trees, in their order. */
interface StructuredContent {
  faq: FaqEntry[];
  businesses: BusinessFacts[];
}

function structuredIn(state: ProjectState, trees: NodeTree[]): StructuredContent {
  const faq: Array<Partial<FaqEntry>> = [];
  const businesses: BusinessFacts[] = [];
  // Each rendering of a placement evaluates its values afresh: that object tells two renderings apart, even where
  // lists inside lists give them the same trail.
  const faqIn = new Map<object, Map<string, Partial<FaqEntry>>>();
  const factsIn = new Map<object, BusinessFacts>();
  for (const tree of trees) {
    // The sizes each page node around what renders hides it at, from the outermost one in.
    const hiding: Array<Set<Size>> = [];
    const shown = (def: ComponentDefinition, nodeId: string, scope: Scope) => !hiddenEverySize([...hiding, ...hiddenInDesign(def, nodeId, scope)]);
    walkRendered(state, tree, {
      enter: (n) => {
        hiding.push(hiddenSizes([n.styles, n.kind === 'instance' ? n.overrides?.root : undefined]));
      },
      leave: () => {
        hiding.pop();
      },
      text: (n, scope, _reportId, inDef, def) => {
        if (!inDef || !def || !isComponent(def, 'faq.list') || (n.id !== 'question' && n.id !== 'answer') || !shown(def, n.id, scope)) return;
        // One entry per item of each rendering: its question and answer render together.
        const byItem = faqIn.get(scope.props) ?? new Map<string, Partial<FaqEntry>>();
        faqIn.set(scope.props, byItem);
        const key = JSON.stringify(scope.path ?? []);
        let entry = byItem.get(key);
        if (!entry) {
          entry = {};
          byItem.set(key, entry);
          faq.push(entry);
        }
        entry[n.id] = plainText(evaluate(n.text, scope), !!n.rich);
      },
      node: (n, scope, _reportId, inDef, def) => {
        if (!inDef || !def || n.kind !== 'link' || n.id !== 'method-value' || !isComponent(def, 'contact.details') || !shown(def, n.id, scope)) return;
        let facts = factsIn.get(scope.props);
        if (!facts) {
          facts = { email: [], telephone: [], address: [] };
          factsIn.set(scope.props, facts);
          businesses.push(facts);
        }
        const link = evaluate(n.link, scope) as LinkValue | undefined;
        const label = plainText(evaluate(n.label, scope));
        const target = typeof link?.target === 'string' ? link.target.trim() : '';
        const add = (list: string[], v: string) => v && !list.includes(v) && list.push(v);
        if (link?.type === 'email') add(facts.email, target.split('?')[0]);
        // The number as shown, unless the label is words: then the number it dials.
        else if (link?.type === 'tel') add(facts.telephone, phoneLike(label) ? label : target);
        // An address shown beside an address icon, not words such as "Get directions".
        else if (ADDRESS_ICONS.has(String(scope.item?.icon ?? '')) && /\d|,/.test(label)) add(facts.address, label);
      }
    });
  }
  return {
    faq: faq.filter((e): e is FaqEntry => !!e.question && !!e.answer),
    businesses: businesses.filter((b) => b.email.length || b.telephone.length || b.address.length)
  };
}

/** Contact forms that submit to Netlify under one form name, each where the site shows it. */
export interface FormNameClash {
  name: string;
  forms: Array<{ owner: OwnerRef; nodeId: string }>;
}

/**
 * Contact forms the site shows that send to Netlify Forms under the same form name. Netlify files a site's messages
 * by form name, so theirs would be mixed together in one list. Each published page, and the shared header and footer
 * where a published page shows them, is walked once as it renders: a form repeated in a list counts once per item.
 */
export function netlifyFormClashes(state: ProjectState): FormNameClash[] {
  const pages = state.site.pageOrder.flatMap((id) => (Object.hasOwn(state.pages, id) && !isDraftPage(state, state.pages[id]) ? [state.pages[id]] : []));
  const trees: Array<{ owner: OwnerRef; tree: NodeTree }> = [
    ...pages.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p })),
    ...SHELL_PARTS.filter((part) => pages.some((p) => showsPart(p, part))).map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: state.site.shell[part] }))
  ];
  const byName = new Map<string, FormNameClash['forms']>();
  const add = (name: string, form: FormNameClash['forms'][number]) => byName.set(name, [...(byName.get(name) ?? []), form]);
  for (const { owner, tree } of trees) {
    // Content shown through a slot the receiving design renders more than once (inside its list) is walked once;
    // each further rendering shows its forms again.
    const bySlot = new Map<string, Array<[string, FormNameClash['forms'][number]]>>();
    // Forms in a panel a component keeps in the page are in its HTML, where Netlify finds them.
    walkRendered(state, tree, {
      kept: true,
      code: (def, props, reportId, _placement, _n, scope) => {
        const name = netlifyFormName(def, props);
        if (!name) return;
        const form = { owner, nodeId: reportId };
        add(name, form);
        for (const slot of scope.slots ?? []) bySlot.set(slot, [...(bySlot.get(slot) ?? []), [name, form]]);
      },
      again: (slot) => {
        for (const [name, form] of bySlot.get(slot) ?? []) add(name, form);
      }
    });
  }
  return [...byName].filter(([, forms]) => forms.length > 1).map(([name, forms]) => ({ name, forms }));
}

/**
 * Whether the website shows a code component `test` picks: on a published page, in the shared header or footer where
 * the website shows it (a published page that does, or any page of a collection: its entries and archives always do),
 * at any depth (inside designs, content areas and kept panels), or in the layout of a collection with a published
 * entry. A component only installed, or placed only on drafts, is not shown. With
 * `throughCode`, code that places the component itself (a design converted to code) shows it too.
 */
export function siteShowsCode(state: ProjectState, test: (def: ComponentDefinition) => boolean, opts: { throughCode?: boolean } = {}): boolean {
  const reached = new Map<string, boolean>();
  const picks = (def: ComponentDefinition) => test(def) || (!!opts.throughCode && def.kind === 'code' && codeReaches(state, def, test, reached));
  // Nothing installed is one, or leads to one: nothing to look for.
  if (!Object.values(state.components).some((d) => !!d && picks(d))) return false;
  const pages = state.site.pageOrder.flatMap((id) => (Object.hasOwn(state.pages, id) && !isDraftPage(state, state.pages[id]) ? [state.pages[id]] : []));
  // Entries as the website has them: drafts left out before addresses are shared out.
  const live = publishedState(state);
  const entries = siteEntries(live);
  const collectionPages = entries.length > 0 || archivePages(state).length > 0;
  const shell = SHELL_PARTS.filter((part) => collectionPages || pages.some((p) => showsPart(p, part))).map((part) => state.site.shell[part]);
  const shows = (s: ProjectState, tree: NodeTree) => {
    let found = false;
    walkRendered(s, tree, {
      kept: true,
      prune: () => found,
      code: (def) => {
        if (!found && picks(def)) found = true;
      }
    });
    return found;
  };
  if ([...pages, ...shell].some((tree) => shows(state, tree))) return true;
  // A collection's layout counts once an entry is published and the layout places such a component anywhere, whatever
  // its conditions say of each entry: reading every entry's page would cost each one its feeds again, and the tools
  // this decides are offered for the site as a whole (site search reads the index, whichever page shows its box).
  return [...new Set(entries.map((e) => e.collection.settings.id))].some((id) => treePlaces(live, live.collections[id]?.settings?.template, picks));
}

/** Whether a tree places, anywhere and whatever its conditions, a component `picks` says yes to, or a design that does. */
function treePlaces(state: ProjectState, tree: NodeTree | undefined, picks: (def: ComponentDefinition) => boolean): boolean {
  const seen = new Set<string>();
  const inside = (nodes: unknown): boolean =>
    !!nodes &&
    typeof nodes === 'object' &&
    Object.values(nodes as Record<string, GraphNode>).some((n) => {
      if (n?.kind !== 'instance' || typeof n.definitionId !== 'string') return false;
      const d = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
      if (!d || seen.has(d.id)) return false;
      seen.add(d.id);
      return picks(d) || (d.kind === 'managed' && inside(d.tree?.nodes));
    });
  return inside(tree?.nodes);
}

/**
 * Whether code places, through the files it imports (other code, or designs, as a design converted to code does), a
 * component `test` picks. Each definition is judged once (`memo`), and a definition that leads back to itself leads
 * nowhere new.
 */
function codeReaches(state: ProjectState, def: ComponentDefinition, test: (def: ComponentDefinition) => boolean, memo: Map<string, boolean>): boolean {
  const known = memo.get(def.id);
  if (known !== undefined) return known;
  memo.set(def.id, false);
  const seen = new Set<string>([def.id]);
  const inside = (d: ComponentDefinition | undefined): boolean => {
    if (!d || seen.has(d.id)) return false;
    seen.add(d.id);
    if (test(d)) return true;
    if (d.kind === 'code') return codeReaches(state, d, test, memo);
    return Object.values(d.tree?.nodes ?? {}).some((n) => n?.kind === 'instance' && inside(Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined));
  };
  const source = typeof def.source === 'string' ? def.source : '';
  const found = Object.values(state.components).some((d) => !!d && d.id !== def.id && source.includes(`/${defFile(d).split('/').pop()}`) && inside(d));
  memo.set(def.id, found);
  return found;
}

/** A content field of a placement: one of its properties, or one field of one item in a list property. */
export interface PlacementField {
  prop: string;
  itemId?: string;
  field?: string;
}

export interface UnlinkedButton {
  /** Node in the page or shell tree (the instance, for buttons inside a component). */
  nodeId: string;
  label: string;
  /** The button's own node in the component definition, for a button inside a component. */
  defNodeId?: string;
  /** For a button inside lists of the placed component's own design: their items, outermost first. */
  itemPath?: string[];
  /** Where the placement's content sets the button's destination. */
  link?: PlacementField;
  /** The label field that decides whether this one button shows at all: clearing it hides only this button. */
  hide?: PlacementField;
}

/**
 * The placement's own field a definition binding reads: directly, for the definition the placement places, or
 * through the bindings that hand it to a component inside that design.
 */
function placementField(b: unknown, scope: Scope): PlacementField | undefined {
  if (!isBinding(b)) return undefined;
  // A computed list is the pages' rows, whatever it is handed to.
  if ('$prop' in b && scope.feedProps?.has(b.$prop)) return undefined;
  if ('$prop' in b) {
    // One field of an object property is that field of the placement's object.
    const whole = scope.placement ? { prop: b.$prop } : scope.forwarded?.[b.$prop];
    if (b.field === undefined || !whole) return whole;
    return whole.itemId === undefined && whole.field === undefined ? { prop: whole.prop, field: b.field } : undefined;
  }
  const id = scope.item?.id;
  if (!('$item' in b) || !scope.list || typeof id !== 'string' || !id) return undefined;
  const list = scope.placement ? { prop: scope.list } : scope.forwarded?.[scope.list];
  return list && !list.itemId ? { prop: list.prop, itemId: id, field: b.$item } : undefined;
}

/** The schema of a placement's field: a property of the placed component, or a field of its list's items. */
function fieldSchema(state: ProjectState, tree: NodeTree, placementId: string, f: PlacementField): PropSchema | undefined {
  const inst = tree.nodes[placementId];
  const schema = inst?.kind === 'instance' ? state.components[inst.definitionId]?.properties[f.prop] : undefined;
  if (!f.itemId) return f.field !== undefined && schema ? propBindingSchema({ [f.prop]: schema }, { $prop: f.prop, field: f.field }) : schema;
  return schema?.type === 'list' && f.field ? schema.fields[f.field] : undefined;
}

/** Whether a placement's list field is one a page list fills from the linked page while it is empty. */
function followsPageField(state: ProjectState, tree: NodeTree, placementId: string, f: PlacementField): boolean {
  if (!f.itemId || !f.field) return false;
  const list = fieldSchema(state, tree, placementId, { prop: f.prop });
  return list?.type === 'list' && !!list.pageTeaser && teaserFields(list.pageTeaser).some(([field]) => field === f.field);
}

const sameBinding = (a: unknown, b: unknown) =>
  isBinding(a) && isBinding(b) && ('$prop' in a ? '$prop' in b && a.$prop === b.$prop && a.field === b.field : '$item' in a ? '$item' in b && a.$item === b.$item : '$entry' in b && a.$entry === b.$entry);

/** Whether an image node's only condition is its own image: it shows once it has one, and nothing else hides it. */
const hidesWhileEmpty = (n: GraphNode & { kind: 'image' }) => !!n.when && !n.unless && !isComparison(n.when) && sameBinding(n.when, n.image);

/**
 * Buttons that will render with a label but no destination. The site leaves them out, which is easy to miss in
 * the editor, so they are reported as diagnostics, flagged in the Inspector and listed when the site is exported.
 */
export function unlinkedButtons(state: ProjectState, tree: NodeTree): UnlinkedButton[] {
  const out: UnlinkedButton[] = [];
  // How often each placement field is read by what renders: as a condition (of the button, or of anything around
  // it), as text, as a button label, or by code. Clearing a label something else also reads would change that too.
  const key = (f: PlacementField, placement: string) => JSON.stringify([placement, f.prop, f.itemId ?? null, f.field ?? null]);
  const uses = new Map<string, number>();
  // Slots shown more than once, and the slots each finding is shown through.
  const shownAgain = new Set<string>();
  const through = new Map<UnlinkedButton, string[]>();
  walkRendered(state, tree, {
    again: (slot) => void shownAgain.add(slot),
    node: (n, scope, reportId, inDef) => {
      if (!inDef) return;
      const reads: unknown[] = [conditionRef(n.when), conditionRef(n.unless)];
      // An accessible name read from the same field would be cleared with it.
      if (n.kind === 'element' || n.kind === 'icon' || n.kind === 'link') reads.push(n.ariaLabel);
      if (n.kind === 'text') reads.push(n.text);
      if (n.kind === 'link') reads.push(n.label);
      if (n.kind === 'instance' && state.components[n.definitionId]?.kind !== 'managed') reads.push(...Object.values(n.props));
      const read = reads.map((b) => placementField(b, scope)).filter((f): f is PlacementField => !!f);
      // A whole object handed on (to code, say) reads every one of its fields.
      const whole = read.flatMap((f) => {
        const schema = !f.itemId && f.field === undefined ? fieldSchema(state, tree, reportId, f) : undefined;
        return schema?.type === 'object' ? Object.keys(schema.fields).map((field) => ({ prop: f.prop, field })) : [];
      });
      const fields = new Set([...read, ...whole].map((f) => key(f, reportId)));
      for (const f of fields) uses.set(f, (uses.get(f) ?? 0) + (scope.multiple ? 2 : 1));
    },
    link: (n, scope, reportId, inDef, ownId, def) => {
      const appearance = String(evaluate(n.appearance, scope) ?? '');
      const label = String(evaluate(n.label, scope) ?? '').trim();
      const link = evaluate(n.link, scope) as LinkValue | undefined;
      // A button that changes its component's state is a real button with nowhere to go.
      if (!BUTTONS.has(appearance) || !label || resolveLink(link, { state }) || stateActionWorks(def, n.stateAction, n.id)) return;
      if (!inDef) return void out.push({ nodeId: reportId, label });
      const found: UnlinkedButton = { nodeId: reportId, label, defNodeId: n.id };
      if (scope.placement && scope.path?.length) found.itemPath = scope.path;
      const to = placementField(n.link, scope);
      if (to && fieldSchema(state, tree, reportId, to)?.type === 'link') found.link = to;
      // Clearing the label hides the button only when the label is also its condition, is text that may be
      // empty, and belongs to this one rendering (not a label every list item shares).
      const hide = sameBinding(n.when, n.label) ? placementField(n.label, scope) : undefined;
      const repeats = scope.repeats ?? 0;
      // A button carrying an id may be what another link goes to: hiding it would take that target away.
      const own = hide && !scope.multiple && !ownId && (hide.itemId ? repeats === 1 && hide.itemId === scope.occurrence : repeats === 0);
      // A page list's field left empty shows its page's value again, so clearing it hides nothing.
      if (hide && own && fieldSchema(state, tree, reportId, hide)?.type === 'string' && !followsPageField(state, tree, reportId, hide)) found.hide = hide;
      if (scope.slots?.length) through.set(found, scope.slots);
      out.push(found);
    }
  });
  // ...and only when no other rendered button reads that label.
  for (const b of out) if (b.hide && ((uses.get(key(b.hide, b.nodeId)) ?? 0) > 1 || through.get(b)?.some((x) => shownAgain.has(x)))) delete b.hide;
  return out;
}

/** The unlinked buttons one node of a page or shell tree renders: the node itself, or those inside a placement. */
export function unlinkedButtonsAt(state: ProjectState, tree: NodeTree, nodeId: string): UnlinkedButton[] {
  return tree.nodes[nodeId] ? unlinkedButtons(state, { ...tree, rootIds: [nodeId] }) : [];
}

/** A link in a header's menu with words and nowhere to go. */
export interface UnlinkedMenuLink {
  /** The header's node in the page or shell tree (the outermost placement, for a header inside a component). */
  nodeId: string;
  /** The menu item, in the header's `links`. */
  itemId: string;
  label: string;
}

/**
 * Links in a header menu (the theme's header, or a copy of it) that have words but nowhere to go: the site shows the
 * words, which lead nowhere. A top-level link with others shown under it is left out: its submenu still opens from
 * the button beside it, so it can be a heading of its own.
 */
export function unlinkedMenuLinks(state: ProjectState, tree: NodeTree): UnlinkedMenuLink[] {
  const out: UnlinkedMenuLink[] = [];
  const seen = new Set<string>();
  // A header a visitor reaches by opening a disclosure or choosing a tab shows its menu all the same.
  walkRendered(state, tree, {
    everyState: true,
    code: (def, props, reportId) => {
      if (shippedCode(state, def) !== 'shell.header' || !Array.isArray(props.links)) return;
      const schema = def.properties.links;
      const fields = schema?.type === 'list' ? schema.fields : {};
      // Each item's fields as the site gets them: what it holds, else the field's default.
      const field = (item: unknown, k: string) => (item && typeof item === 'object' && Object.hasOwn(item, k) ? (item as Record<string, unknown>)[k] : fields[k]?.default);
      const items: unknown[] = props.links;
      const under = shownUnder(items);
      items.forEach((item, i) => {
        const label = String(field(item, 'label') ?? '').trim();
        if (!label || resolveLink(field(item, 'link') as LinkValue | undefined, { state })) return;
        if (!under[i] && under[i + 1]) return;
        const itemId = String((item as { id?: unknown } | null)?.id ?? i);
        // A header repeated for each item of a list shows the same menu link each time: one change fixes them all.
        const key = JSON.stringify([reportId, itemId]);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ nodeId: reportId, itemId, label });
      });
    }
  });
  return out;
}

/** Where a piece of shown content is stored: a field of the page or shell node itself, or a field of its placement. */
export type ContentSource = { kind: 'node'; field: 'text' | 'label' | 'link' } | ({ kind: 'prop' } & PlacementField);

/** Visible words or a link destination a page or shell tree renders, and the field that holds it. */
export interface RenderedContent {
  /** The page or shell node: the content's own node, or the outermost placement it is shown through. */
  nodeId: string;
  /** Words a visitor reads (text, a button's label, a field's text), or where a link goes. */
  kind: 'text' | 'link';
  /** The value as stored: text, rich text or a link. */
  value: unknown;
  /** Where to change it. Absent for content fixed in a component's design, which no placement can change. */
  source?: ContentSource;
  /** For content without a source: where it renders, which tells two such pieces apart. */
  at?: string;
  /** A custom code component's property: what its code shows is unknown, so it is listed but not changed from here. */
  custom?: boolean;
  /** For content inside a component: the definition node showing it. */
  defNodeId?: string;
  /** Set when the placement places that definition directly, so its parts can be selected: the items, outermost first. */
  itemPath?: string[];
  /** Shown by a component placed directly at `nodeId` (not one inside its design or a code component). */
  direct?: boolean;
  /** Stored as rich text (blocks of spans), and whether the links inside it render as links. */
  rich?: boolean;
  richLinks?: boolean;
  /** Words a computed list shows (a News card, an article header): changed in the page settings they come from. */
  computed?: boolean;
}

/**
 * The shipped code component a definition is, or a header copied from it (Make unique keeps its code and
 * properties). A copied contact form is not: the project keeps its answers' submission keys only for the theme's own
 * form (`namesFormFields`), so a copy's fields are left to the inspector.
 */
export function shippedCode(state: ProjectState, def: ComponentDefinition): string | undefined {
  if (def.owner === 'theme')
    return def.componentId === 'shell.header' || def.componentId === 'data.table' || def.componentId === 'media.video' || (def.componentId === 'contact.form' && namesFormFields(def)) ? def.componentId : undefined;
  // Back through every copy (a copy of a copy) to where it started.
  let from = def.provenance?.forkedFrom;
  for (let guard = 0; from && guard < 20; guard++) {
    const prev = state.components[from];
    if (!prev) return from.replace(/^[^.]+\./, '') === 'shell.header' ? 'shell.header' : undefined;
    if (prev.owner === 'theme') return prev.componentId === 'shell.header' ? 'shell.header' : undefined;
    from = prev.provenance?.forkedFrom;
  }
  return undefined;
}

const words = (v: unknown) => typeof v === 'string' && !!v.trim();
/** Whether the shipped header shows its notice: its words, more than spaces. Clearing them removes it, link and all. */
const headerNoticeShown = (props: Record<string, unknown>) => words(props.notice);
/** Whether the header's notice link has words to show, beside the notice's own (its destination aside). */
const headerNoticeLinkNamed = (props: Record<string, unknown>) => headerNoticeShown(props) && words(props.noticeLabel);

/**
 * What a shipped code component shows visitors, as property names (and `list.field` for list items), read from its
 * markup: the header's name only while it shows (not beside a logo set to show alone) and its action only with both
 * a label and somewhere to go; the form's words, never its service settings or the names answers are sent under.
 */
function shippedCodeShows(state: ProjectState, which: string, props: Record<string, unknown>): Set<string> {
  if (which === 'contact.form') return new Set(['eyebrow', 'heading', 'lead', 'fields.label', 'fields.placeholder', 'submitLabel', 'successMessage', 'errorMessage']);
  // The table's words around it. Its cells are a table value, edited in the inspector's table editor.
  if (which === 'data.table') return new Set(['eyebrow', 'heading', 'lead', 'caption']);
  // The video's words around it, and its title on the Play button, which shows only for a video it can play. The
  // address is a setting: visitors never read it.
  if (which === 'media.video') return new Set(['eyebrow', 'heading', 'lead', ...(parseVideoUrl(props.url) ? ['title'] : [])]);
  // As the header's markup reads them: `!!name && (showSiteName || !logo?.src)`, `ctaLabel && ctaLink?.href`, the
  // notice's words once they are more than spaces, and its link beside them with a label and somewhere to go.
  const out = new Set(['links.label', 'links.link']);
  if (props.siteName && (props.showSiteName !== false || !shown(props.logo, state))) out.add('siteName');
  if (props.ctaLabel && resolveLink(props.ctaLink as LinkValue | undefined, { state })) (out.add('ctaLabel'), out.add('ctaLink'));
  if (headerNoticeShown(props)) out.add('notice');
  if (headerNoticeLinkNamed(props) && resolveLink(props.noticeLink as LinkValue | undefined, { state })) (out.add('noticeLabel'), out.add('noticeLink'));
  return out;
}

/**
 * Every piece of visible content a page or shell tree renders, once per field that holds it: text and rich text,
 * button labels and destinations, and the content fields of the components placed there (a list item's fields
 * included, with the item's own value or its field's default). Content a component's design fixes is listed
 * without a source. Buttons the site leaves out (a styled button with no destination) are not listed, and a link
 * that goes nowhere lists only its words.
 */
export function renderedContent(state: ProjectState, tree: NodeTree): RenderedContent[] {
  const out: RenderedContent[] = [];
  const guarded = new Set<string>();
  const keyOf = (c: RenderedContent) =>
    JSON.stringify([c.kind, c.nodeId, c.source ? [c.source.kind, 'field' in c.source ? c.source.field : null, 'prop' in c.source ? c.source.prop : null, 'itemId' in c.source ? (c.source.itemId ?? null) : null] : [c.at ?? null]]);
  const seen = new Map<string, RenderedContent>();
  const push = (c: RenderedContent) => {
    const k = keyOf(c);
    const had = seen.get(k);
    // One entry per field. A field that a custom code component also reads may be its setting: it stays custom.
    if (had) return void (c.custom && (had.custom = true));
    seen.set(k, c);
    out.push(c);
  };
  /** Where content a definition node reads is stored, and how to select it. */
  const from = (b: unknown, field: 'text' | 'label' | 'link', scope: Scope, defNodeId: string, inDef: boolean): Pick<RenderedContent, 'source' | 'at' | 'defNodeId' | 'itemPath' | 'direct'> => {
    if (!inDef) return { source: { kind: 'node', field } };
    const f = placementField(b, scope);
    const direct = !!scope.placement;
    const at = `${scope.trail ?? ''}|${defNodeId}|${(scope.path ?? []).join(',')}|${field}`;
    return { ...(f ? { source: { kind: 'prop' as const, ...f } } : { at }), defNodeId, direct, ...(direct && scope.path?.length ? { itemPath: scope.path } : {}) };
  };
  /** A value read from a computed list's row: an item field inside a News card or article header. */
  const fromRow = (b: unknown, scope: Scope) => !!scope.computed && isBinding(b) && '$item' in b;
  walkRendered(state, tree, {
    text: (n, scope, reportId, inDef) => {
      const value = evaluate(n.text, scope);
      push({ nodeId: reportId, kind: 'text', value, ...from(n.text, 'text', scope, n.id, inDef), ...(n.rich ? { rich: true, richLinks: true } : {}), ...(fromRow(n.text, scope) ? { computed: true } : {}) });
    },
    link: (n, scope, reportId, inDef, _ownId, def) => {
      const link = evaluate(n.link, scope) as LinkValue | undefined;
      const label = evaluate(n.label, scope);
      const goes = !!resolveLink(link, { state });
      // A styled button with nowhere to go is left out of the site, unless it changes its component's state; a plain
      // link still shows its words.
      if (!goes && BUTTONS.has(String(evaluate(n.appearance, scope) ?? '')) && !stateActionWorks(def, n.stateAction, n.id)) return;
      push({ nodeId: reportId, kind: 'text', value: label, ...from(n.label, 'label', scope, n.id, inDef), ...(fromRow(n.label, scope) ? { computed: true } : {}) });
      if (goes && isLinkValue(link)) push({ nodeId: reportId, kind: 'link', value: link, ...from(n.link, 'link', scope, n.id, inDef), ...(fromRow(n.link, scope) ? { computed: true } : {}) });
    },
    code: (def, props, reportId, placement, n, scope, inDef) => {
      const which = shippedCode(state, def);
      const shows = which ? shippedCodeShows(state, which, props) : undefined;
      // The placement's own field each property is: directly, or through the binding a design hands it.
      const fieldOf = (key: string): PlacementField | undefined => (inDef ? placementField(n.props[key], scope) : { prop: key });
      // A form's fields handed in by a design are edited on that design's list, where their submission keys are not kept.
      const keyless = (key: string) => which === 'contact.form' && inDef && key === 'fields';
      /** A field this code may read as a setting (or in ways its markup alone decides): never changed from here. */
      const guard = (f: PlacementField | undefined) => {
        if (!f) return;
        guarded.add(JSON.stringify([reportId, f.prop, f.itemId ?? null, f.field ?? null]));
        // A whole object the code reads is each of its fields too.
        const schema = !f.itemId && f.field === undefined ? fieldSchema(state, tree, reportId, f) : undefined;
        if (schema?.type === 'object') for (const k of Object.keys(schema.fields)) guarded.add(JSON.stringify([reportId, f.prop, null, k]));
      };
      const add = (kind: 'text' | 'link', value: unknown, source: PlacementField | undefined, schema: PropSchema, at: string, custom: boolean) =>
        push({
          nodeId: reportId,
          kind,
          value,
          ...(source ? { source: { kind: 'prop', ...source } } : { at }),
          ...(custom ? { custom: true } : {}),
          ...(inDef ? { direct: false } : {}),
          ...(schema.type === 'richtext' ? { rich: true, richLinks: codeTakesBlocks(schema) } : {})
        });
      const take = (schemas: Record<string, PropSchema>, values: Record<string, unknown>, key: string, source: PlacementField | undefined, at: string, custom: boolean) => {
        const schema = schemas[key];
        const v = Object.hasOwn(values, key) ? values[key] : (schema as { default?: unknown }).default;
        if (custom) guard(source);
        if (schema.type === 'string' || schema.type === 'richtext') add('text', v, source, schema, at, custom);
        if (schema.type !== 'link' || !isLinkValue(v) || !resolveLink(v, { state })) return;
        // A shipped component's own markup decides (above). Other code: a link named by a label property shows only
        // while that label has words, as the shipped header does.
        const labelKey = labelKeyFor(key);
        const named = Object.hasOwn(values, labelKey) ? values[labelKey] : (schemas[labelKey] as { default?: unknown } | undefined)?.default;
        if (!shows && schemas[labelKey]?.type === 'string' && !String(named ?? '').trim()) return;
        add('link', v, source, schema, at, custom);
      };
      for (const [key, schema] of Object.entries(def.properties)) {
        const field = fieldOf(key);
        if (schema.type !== 'list') {
          // A shipped component's setting is not listed, and whatever else shows its field may not change it.
          if (shows && !shows.has(key)) guard(field);
          else take(def.properties, props, key, field, `${placement}|${key}`, !shows);
          continue;
        }
        for (const item of Array.isArray(props[key]) ? (props[key] as Array<Record<string, unknown>>) : []) {
          if (!item || typeof item !== 'object') continue;
          // A computed list's rows are pages, not items of the placement: their words are not its fields.
          const itemId = typeof item.id === 'string' && item.id && !schema.feed ? item.id : undefined;
          // A form field's setting its type never shows (a checkbox's placeholder) is not on the page.
          const unused = which === 'contact.form' && key === 'fields' && offersFormChoices(def) ? formFieldSettingsHidden(item) : [];
          for (const f of Object.keys(schema.fields)) {
            const source = field && !field.itemId && itemId ? { prop: field.prop, itemId, field: f } : undefined;
            if ((shows && !shows.has(`${key}.${f}`)) || unused.includes(f)) guard(source);
            else take(schema.fields, item, f, source, `${placement}|${key}|${String(item.id ?? '')}|${f}`, !shows || keyless(key));
          }
          // A whole list handed in from a design is that design's field too.
          if (!shows || keyless(key)) guard(field);
        }
      }
    }
  });
  // A field any custom code or setting reads stays out of reach, however else it is shown.
  for (const c of out) if (c.source?.kind === 'prop' && guarded.has(JSON.stringify([c.nodeId, c.source.prop, c.source.itemId ?? null, c.source.field ?? null]))) c.custom = true;
  return out;
}

/** How many images on the site's pages and shell render as placeholders because no image is chosen yet. */
export function placeholderImageCount(state: ProjectState): number {
  let count = 0;
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  // The header and footer each render only when at least one page shows it.
  const shell = SHELL_PARTS.filter((part) => pages.some((p) => showsPart(p, part))).map((part) => state.site.shell[part]);
  const trees = [...shell, ...pages];
  for (const tree of trees)
    walkRendered(state, tree, {
      image: (n, scope) => {
        const img = evaluate(n.image, scope) as ImageValue | undefined;
        if (!img?.assetId || !state.assets.assets[img.assetId]) count++;
      }
    });
  return count;
}

/** Where one use of an image is stored, as an edit names it: the tree's own image node, or a field of a placement in it. */
export type ImageField = { nodeId: string } & Partial<PlacementField>;

/** One image a page or shell tree shows, or would show once it has one (see renderedImages). */
export interface RenderedImage {
  /** Its node: the tree's own, a design's, or a code placement that draws its one image itself. */
  nodeId: string;
  /** The placements entered from the tree down to the design the node belongs to (an ElementRef's instancePath). */
  instancePath: string[];
  /** The items of that design's lists it is shown for, outermost first (an ElementRef's itemPath). */
  itemPath: string[];
  /** Those lists' repeats in the design, outermost first, beside `itemPath`. */
  repeats: string[];
  /**
   * The field a new image for this use alone is written to; null when no field of the tree holds it: an image fixed in
   * a design, an entry's or a computed row's picture, or an item whose ID its list does not give it alone.
   */
  field: ImageField | null;
  /** No image is chosen, or the one chosen is no longer in Assets. */
  unfilled: boolean;
  /** Left out of the page until it has an image (see Visit.hiddenImage): its parent element in the design shows it. */
  box?: string;
  /**
   * A code placement's one image property: `drawn` when its markup shows exactly that property with its one SoImage
   * (see showsWithSoImage), and the files its picture can show now (the original and its smaller copies; none with no
   * image chosen).
   */
  code?: { drawn: boolean; files: string[] };
  /** For content placed in a design's slot (an Image in a Section): the design it shows in, as `instancePath`,
   *  `itemPath` and `repeats` name an image's own. */
  shownIn?: { instancePath: string[]; itemPath: string[]; repeats: string[] };
  /** The field it shows, whether or not one use of it can be written (see `field`): uses of one field are counted. */
  reads: ImageField | null;
  /** Shown more than once from one walk (slot content a design repeats in each item, or code places as it likes). */
  multiple?: true;
  /** Its layer name, and the title of the item it is shown for. */
  name: string;
  item?: string;
}

/** Whether an image value shows a picture from the library. */
const imageChosen = (state: ProjectState, v: unknown): boolean => {
  const id = (v as ImageValue | undefined)?.assetId;
  return typeof id === 'string' && !!id && Object.hasOwn(state.assets.assets, id);
};

/** The repeats above a node in a design, outermost first. */
export function repeatsAbove(tree: NodeTree, nodeId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p = findParent(tree, nodeId); p?.parentId && !seen.has(p.parentId); p = findParent(tree, p.parentId)) {
    seen.add(p.parentId);
    if (tree.nodes[p.parentId]?.kind === 'repeat') out.unshift(p.parentId);
  }
  return out;
}

/** A code component's one image property, when it has exactly one and no list or group holds an image field. */
export function codeImageProp(def: ComponentDefinition): string | null {
  const props = Object.entries(def.properties ?? {});
  const images = props.filter(([, s]) => s?.type === 'image');
  const nested = props.some(([, s]) => (s?.type === 'list' || s?.type === 'object') && Object.values(s.fields ?? {}).some((f) => f?.type === 'image'));
  return images.length === 1 && !nested ? images[0][0] : null;
}

/** The value branches of an expression: each outcome of a `cond ? a : b` (nested too), or the expression itself. */
function outcomes(whole: string): string[] {
  const expr = bare(whole);
  const top = (from: number, to: number, at: (i: number, c: string) => boolean | void) => {
    let depth = 0;
    for (let i = from; i < to; i++) {
      const c = expr[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (depth === 0 && at(i, c)) return i;
    }
    return -1;
  };
  // A `?` that asks, not one of `?.` or `??`.
  const asks = (i: number, c: string) => c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?' && expr[i - 1] !== '?';
  const q = top(0, expr.length, asks);
  if (q < 0) return [expr];
  let nested = 0;
  const colon = top(q + 1, expr.length, (i, c) => {
    if (asks(i, c)) nested++;
    else if (c === ':') return nested-- === 0;
  });
  return colon < 0 ? [expr] : [...outcomes(expr.slice(q + 1, colon)), ...outcomes(expr.slice(colon + 1))];
}

/**
 * Whether code markup shows `prop` with its one SoImage, and nothing else with it: exactly one `<SoImage>`, whose
 * `image={...}` gives, whichever way it goes, the property itself, a copy with settings added
 * (`{ ...logo, decorative: true }`) or its thumbnail. Only then is the one SoImage picture on the page the property's.
 */
export function showsWithSoImage(source: string, prop: string): boolean {
  const tags = [...source.matchAll(/<SoImage\b/g)];
  if (tags.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(prop)) return false;
  const at = source.indexOf('image={', tags[0].index);
  if (at < 0 || source.slice(tags[0].index, at).includes('/>')) return false;
  let depth = 0;
  let i = at + 'image='.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  if (i >= source.length) return false;
  const p = prop.replace(/\$/g, '\\$');
  const thumb = new RegExp(`^thumbnail\\(\\s*${p}\\s*\\)$`);
  const copy = new RegExp(`^\\{\\s*\\.\\.\\.${p}\\s*(?:,([^{}]*))?\\}$`);
  const shows = (o: string) => {
    const e = bare(o);
    if (e === prop || thumb.test(e)) return true;
    // Settings added to a copy of it, never its picture: no other source, and nothing spread in that could be one.
    const m = e.match(copy);
    const keys = (m?.[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    return !!m && keys.every((part) => !part.startsWith('...') && !/^['"]?(?:src|srcset)['"]?\s*(?::|$)/.test(part));
  };
  return outcomes(source.slice(at + 'image={'.length, i)).every(shows);
}

/** An expression without the parentheses around the whole of it (`(photo)` is `photo`). */
function bare(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0;
    let whole = true;
    for (let i = 0; i < e.length - 1; i++) {
      if (e[i] === '(') depth++;
      else if (e[i] === ')' && --depth === 0) {
        whole = false;
        break;
      }
    }
    if (!whole) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/**
 * Every image a page or shell tree shows, the way the generated pages show them, with the field one use of it is stored
 * in: a page's own image, a placement's image property or the image field of one of its list items (also through a
 * component placed in its design), or a code placement's one image property. Images a design leaves out until they have
 * one are listed too, shown by their parent element, and so are those in a panel the design's UI state can show (a tab
 * not chosen at first), which the page may show now. Code placed inside a design is not.
 */
export function renderedImages(state: ProjectState, tree: NodeTree): RenderedImage[] {
  const out: RenderedImage[] = [];
  /** Whether exactly one item of a placement's list has the ID: an edit names the item by it. */
  const unique = (placementId: string, prop: string, itemId: string) => {
    const inst = tree.nodes[placementId];
    if (inst?.kind !== 'instance') return false;
    const schema = state.components[inst.definitionId]?.properties[prop];
    const list = Object.hasOwn(inst.props, prop) ? inst.props[prop] : schema?.default;
    return Array.isArray(list) && list.filter((x) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === itemId).length === 1;
  };
  const push = (n: GraphNode & { kind: 'image' }, scope: Scope, reportId: string, hidden: boolean) => {
    const def = scope.instance && Object.hasOwn(state.components, scope.instance.definitionId) ? state.components[scope.instance.definitionId] : undefined;
    // An object's field it has no value for shows the property's own default for it, as the page does: an image its
    // condition seemed to leave out is then shown.
    let value = evaluate(n.image, scope);
    const b = n.image;
    if (value === undefined && def && isBinding(b) && '$prop' in b && b.field !== undefined) {
      const schema = def.properties[b.$prop];
      if (schema?.type === 'object') value = Object.hasOwn(schema.default ?? {}, b.field) ? schema.default[b.field] : schema.fields[b.field]?.default;
    }
    if (hidden && imageChosen(state, value)) hidden = false;
    let box: string | undefined;
    if (hidden) {
      const p = def?.tree ? findParent(def.tree, n.id) : null;
      const parent = p?.parentId ? def?.tree?.nodes[p.parentId] : undefined;
      if (parent?.kind !== 'element') return;
      box = parent.id;
    }
    let field: ImageField | null = null;
    let reads: ImageField | null = null;
    // A page's (or the shell's) own image is its node's; an entry's picture in a collection layout is not one.
    if (!scope.instance) field = reads = isBinding(n.image) ? null : { nodeId: n.id };
    else {
      const f = placementField(n.image, scope);
      reads = f && fieldSchema(state, tree, reportId, f)?.type === 'image' ? { nodeId: reportId, ...f } : null;
      // A computed row's picture is a page's; and inside a list of a design around this one (a card placed in each
      // item), the page tells the items' copies of the image apart by nothing of its own.
      const apart = !(scope.computed && isBinding(n.image) && '$item' in n.image) && (scope.repeats ?? 0) <= (scope.path?.length ?? 0);
      if (reads && apart && (!f!.itemId || unique(reportId, f!.prop, f!.itemId))) field = reads;
    }
    const list = scope.list && def ? def.properties[scope.list] : undefined;
    const titleField = list?.type === 'list' ? list.titleField : undefined;
    const title = titleField ? scope.item?.[titleField] : undefined;
    shownThrough.set(out.length, scope);
    out.push({
      nodeId: n.id,
      instancePath: scope.instances ?? [],
      itemPath: scope.path ?? [],
      repeats: def?.tree ? repeatsAbove(def.tree, n.id) : [],
      field,
      reads,
      unfilled: hidden || !imageChosen(state, value),
      ...(box ? { box } : {}),
      ...(scope.shownIn ? { shownIn: { instancePath: scope.shownIn.instances, itemPath: scope.shownIn.path, repeats: scope.shownIn.repeats } } : {}),
      name: n.name?.trim() || 'Image',
      ...(typeof title === 'string' && title.trim() ? { item: title.trim() } : {})
    });
  };
  // Slot content shown again (by a design that shows its slot once per list item): each image's slots, by its place in
  // `out`, are checked once the walk has found every slot shown more than once.
  const again = new Set<string>();
  const shownThrough = new Map<number, Scope>();
  walkRendered(state, tree, {
    everyState: true,
    again: (slot) => again.add(slot),
    image: (n, scope, reportId) => push(n, scope, reportId, false),
    hiddenImage: (n, scope, reportId) => push(n, scope, reportId, true),
    code: (def, props, _reportId, _placement, n, scope, inDef) => {
      const prop = inDef ? null : codeImageProp(def);
      if (!prop) return;
      const value = props[prop] as ImageValue | undefined;
      const chosen = imageChosen(state, value);
      const asset = chosen ? state.assets.assets[value!.assetId!] : undefined;
      const file = (f: string) => f.replace(/^static\//, '');
      shownThrough.set(out.length, scope);
      out.push({
        nodeId: n.id,
        instancePath: scope.instances ?? [],
        itemPath: [],
        repeats: [],
        field: { nodeId: n.id, prop },
        reads: { nodeId: n.id, prop },
        unfilled: !chosen,
        // The page names a picture by its file (see resolveImage): the picture under the pointer is this one only if
        // it shows one of this image's files.
        code: { drawn: showsWithSoImage(def.source ?? '', prop), files: asset ? [file(asset.file), ...(asset.variants ?? []).map((v) => file(v.file))] : [] },
        name: def.properties[prop].label?.trim() || 'Image'
      });
    }
  });
  for (const [i, scope] of shownThrough) if (scope.codeSlot || (scope.slots ?? []).some((k) => again.has(k))) out[i].multiple = true;
  return out;
}

// ---------------------------------------------------------------------------
// Section links
// ---------------------------------------------------------------------------

/**
 * IDs every page has: the main landmark its layout renders (`<main id="main">`), and `top`, which browsers and the
 * static build both treat as the top of the page.
 */
const LAYOUT_IDS = ['main', 'top'];
const LITERAL_ID = /\sid\s*=\s*(?:"([^"{}\s]+)"|'([^'{}\s]+)')/g;
/** Kept with the source they were read from: an edit can change a definition's source in place. */
const codeIdCache = new WeakMap<ComponentDefinition, { source: string; ids: string[] }>();

/** IDs a code component's markup writes out literally (`id="so-site-nav"`). IDs it computes cannot be known here. */
function literalIds(def: ComponentDefinition): string[] {
  const source = def.source ?? '';
  const known = codeIdCache.get(def);
  if (known?.source === source) return known.ids;
  const ids = [...source.matchAll(LITERAL_ID)].map((m) => m[1] ?? m[2]);
  codeIdCache.set(def, { source, ids });
  return ids;
}

/** The trees a page renders, in order: the shared header when it shows it, its own content, the shared footer when it shows it. */
const renderedTrees = (state: ProjectState, page: PageDoc): NodeTree[] => [...(showsPart(page, 'header') ? [state.site.shell.header] : []), page, ...(showsPart(page, 'footer') ? [state.site.shell.footer] : [])];

/**
 * The element IDs a tree renders. Code components add the IDs their markup writes out literally. With \`kept\`, the IDs
 * of panels a component keeps in the page hidden too: IDs taken, though not sections a visitor can see.
 */
function treeIds(state: ProjectState, trees: NodeTree[], out = new Set<string>(), kept = false): Set<string> {
  const visit: Visit = { kept, id: (id) => out.add(id), code: (def) => literalIds(def).forEach((id) => out.add(id)) };
  for (const tree of trees) walkRendered(state, tree, visit);
  return out;
}

/** How many elements render each ID on a page: an ID rendered twice cannot tell its sections apart. */
function idCounts(state: ProjectState, pageId: string): Map<string, number> {
  const out = new Map<string, number>();
  const page = state.pages[pageId];
  // An ID in a panel kept in the page hidden is in its HTML all the same.
  const visit: Visit = { kept: true, id: (id) => out.set(id, (out.get(id) ?? 0) + 1) };
  if (page) for (const tree of renderedTrees(state, page)) walkRendered(state, tree, visit);
  return out;
}

/** The IDs the shared header and the shared footer render, each on every page that shows it. */
export type ShellIds = Record<ShellPart, Set<string>>;

/** No IDs from the shared header or footer: for a page's own IDs alone. */
export const NO_SHELL_IDS: ShellIds = { header: new Set(), footer: new Set() };

/** The IDs the shared header or the shared footer renders. */
const partIds = (state: ProjectState, part: ShellPart) => treeIds(state, [state.site.shell[part]]);

/** The IDs both shared parts render, worked out once for a check over many pages. */
const shellIds = (state: ProjectState): ShellIds => ({ header: partIds(state, 'header'), footer: partIds(state, 'footer') });

/**
 * The element IDs a page's generated HTML will hold: its layout's, its own sections' and elements', and those of the
 * shared header and footer it shows. `shell` passes the header and footer's IDs when already known.
 */
export function pageIds(state: ProjectState, pageId: string, shell?: ShellIds, kept = false): Set<string> {
  const out = new Set(LAYOUT_IDS);
  const page = state.pages[pageId];
  if (!page) return out;
  for (const part of partsShown(page)) for (const id of shell?.[part] ?? treeIds(state, [state.site.shell[part]], new Set(), kept)) out.add(id);
  return treeIds(state, [page], out, kept);
}

/** The IDs a page's elements render, those of the shared header and footer it shows included: not the layout's. */
export function elementIds(state: ProjectState, pageId: string): Set<string> {
  const page = state.pages[pageId];
  if (!page) return new Set();
  return treeIds(state, renderedTrees(state, page));
}

/**
 * The IDs every page that shows a shared part has: where that part's "on this page" links can go. The header and
 * footer can show on different pages, so each has its own.
 */
export function sharedPageIds(state: ProjectState, part: ShellPart): Set<string> {
  const pages = pagesShowing(state, part);
  // A collection's index and archive pages show the header and footer around a list of posts, and no page's sections.
  const archived = archivePages(state).length > 0;
  if (!pages.length && !archived) return new Set(LAYOUT_IDS);
  const shell = shellIds(state);
  const sets = pages.map((p) => pageIds(state, p.id, shell));
  if (archived) sets.push(new Set([...LAYOUT_IDS, ...shell.header, ...shell.footer]));
  return new Set([...sets[0]].filter((id) => sets.every((x) => x.has(id))));
}

/** A link that renders, with what a person would call it. */
interface RenderedLink {
  link: LinkValue;
  label: string;
  reportId: string;
  /** Tells apart links of the same placement: its list item and field, or its position in rich text. */
  key: string;
  /** Inside rich text, where it is changed in the text itself rather than in a link field. */
  inText: boolean;
  /** In a panel kept in the page hidden (a \`kept\` walk): seen only once the panel shows. */
  hidden?: boolean;
  /** The label is not the words visitors see on the link: an element's name, or a field's name, stands in for them. */
  unnamed?: boolean;
}

const isLinkValue = (v: unknown): v is LinkValue => !!v && typeof v === 'object' && typeof (v as LinkValue).type === 'string' && 'target' in (v as object);

/** The links in a rich text value, in order. */
function richLinks(value: unknown): RichSpan[] {
  const out: RichSpan[] = [];
  for (const b of toRichText(value)) for (const list of spanRuns(b)) for (const sp of list) if (sp.link) out.push(sp);
  return out;
}

/**
 * The property that names a link and decides whether it shows: `ctaLabel` for `ctaLink`, `linkLabel` for `link`.
 * Code reads it the way the generated components do, so a link whose label is empty does not render.
 */
export const labelKeyFor = (key: string) => (key.endsWith('Link') ? `${key.slice(0, -4)}Label` : `${key}Label`);

/**
 * Links a code component receives: its link properties, the link fields of its lists, and the links in its rich
 * text it takes as blocks (see `codeForm`). Whether its markup shows each one is up to its code; a
 * link paired with a label property is taken to show only when the label does, as the shipped header does. The
 * shipped header (`which`) shows its notice's link only beside the notice's words, which a label alone does not show.
 */
function codeLinks(def: ComponentDefinition, props: Record<string, unknown>, reportId: string, placement: string, out: RenderedLink[], which?: string) {
  const take = (schemas: Record<string, PropSchema>, values: Record<string, unknown>, key: string, fallback: { text: string; shown: boolean }, at: string) => {
    const schema = schemas[key];
    // A list item without the field shows the field's default, as the site does.
    const v = Object.hasOwn(values, key) ? values[key] : (schema as { default?: unknown } | undefined)?.default;
    if (codeTakesBlocks(schema)) richLinks(v).forEach((sp, i) => out.push({ link: sp.link!, label: sp.text.trim(), reportId, key: `${at}:${i}`, inText: true }));
    if (schema?.type !== 'link' || !isLinkValue(v)) return;
    const labelKey = labelKeyFor(key);
    const paired = schemas[labelKey]?.type === 'string';
    if (paired && !values[labelKey]) return;
    const label = String((paired ? values[labelKey] : undefined) ?? fallback.text).trim();
    out.push({ link: v, label, reportId, key: at, inText: false, ...(paired || fallback.shown ? {} : { unnamed: true }) });
  };
  for (const [key, schema] of Object.entries(def.properties)) {
    if (which === 'shell.header' && key === 'noticeLink' && !headerNoticeLinkNamed(props)) continue;
    take(def.properties, props, key, { text: schema.label, shown: false }, `${placement}:${key}`);
    if (schema.type !== 'list' || !Array.isArray(props[key])) continue;
    (props[key] as Array<Record<string, unknown>>).forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const title = item[schema.titleField ?? 'label'];
      // A list item's link is named by the item's title (a menu item's words), else by the field's name.
      const named = typeof title === 'string' && !!title.trim();
      for (const [f, fs] of Object.entries(schema.fields)) take(schema.fields, item, f, { text: named ? title : fs.label, shown: named }, `${placement}:${key}:${String(item.id ?? i)}:${f}`);
    });
  }
}

/** Every link a page or shell tree renders: buttons, links inside rich text, and the links code components receive. */
function renderedLinks(state: ProjectState, tree: NodeTree, everyState = false, kept = false): RenderedLink[] {
  const out: RenderedLink[] = [];
  const hidden = (scope: Scope) => (scope.keptHidden ? { hidden: true } : {});
  const at = (n: GraphNode, scope: Scope) => `${scope.trail ?? ''}:${n.id}:${String(scope.item?.id ?? '')}`;
  walkRendered(state, tree, {
    everyState,
    kept,
    link: (n, scope, reportId) => {
      const link = evaluate(n.link, scope);
      if (isLinkValue(link)) out.push({ link, label: String(evaluate(n.label, scope) ?? '').trim(), reportId, key: at(n, scope), inText: false, ...hidden(scope) });
    },
    text: (n, scope, reportId) => {
      if (n.rich) richLinks(evaluate(n.text, scope)).forEach((sp, i) => out.push({ link: sp.link!, label: sp.text.trim(), reportId, key: `${at(n, scope)}:${i}`, inText: true, ...hidden(scope) }));
    },
    // A card links the whole container. One with an action follows its destination only while that action is `link`.
    node: (n, scope, reportId) => {
      if (n.kind !== 'element' || n.link === undefined) return;
      if (n.action !== undefined && n.action !== null && (!actionWraps(n) || evaluate(n.action, scope) !== 'link')) return;
      const link = evaluate(n.link, scope);
      if (isLinkValue(link)) out.push({ link, label: n.name ?? '', reportId, key: at(n, scope), inText: false, unnamed: true, ...hidden(scope) });
    },
    code: (def, props, reportId, placement, _n, scope) => {
      const from = out.length;
      codeLinks(def, props, reportId, placement, out, shippedCode(state, def));
      if (scope.keptHidden) for (const l of out.slice(from)) l.hidden = true;
      // What the project's own code shows on a link is up to its markup: its settings are no proof of the words.
      if (def.owner !== 'theme') for (const l of out.slice(from)) l.unnamed = true;
    }
  });
  return out;
}

/** A link the shared header or footer shows that goes to a page, with the words visitors see on it. */
export type ShellPageLink = { part: ShellPart; nodeId: string; label: string; pageId: string; anchor?: string };

/**
 * The header and footer links visitors see that go to any of `pageIds`, in order: menu items, buttons, links in
 * text and the links components inside them render. `nodeId` is the header or footer element that holds each one.
 */
export function shellPageLinks(state: ProjectState, pageIds: string[]): ShellPageLink[] {
  const out: ShellPageLink[] = [];
  for (const part of SHELL_PARTS) {
    // A header or footer no page shows has no links visitors see.
    if (!pagesShowing(state, part).length) continue;
    for (const r of renderedLinks(state, state.site.shell[part])) {
      if (r.link.type !== 'page' || !pageIds.includes(r.link.target)) continue;
      out.push({ part, nodeId: r.reportId, label: r.label, pageId: r.link.target, ...(r.link.anchor ? { anchor: r.link.anchor } : {}) });
    }
  }
  return out;
}


export interface SectionLinkIssue {
  /** Where the link is: a page, the shared header or footer, a collection's layout, or a collection entry's text. */
  owner: { kind: 'page' | 'shell' | 'entry' | 'template'; id: string };
  /** The page or shell node that holds it (the instance, for links inside a component). */
  nodeId: string;
  /** The link's text, when it has one. */
  label: string;
  /** A link inside rich text, changed in the text rather than in a link field. */
  inText: boolean;
  /** The section ID it jumps to. */
  fragment: string;
  /** The page it goes to, for a link to a section of another page. */
  pageId?: string;
  /** Which rendered link it is: stable while the link stays in the same node and item. */
  key: string;
  /** The pages it shows on that lack the section, for a link to a section of the page it is on. */
  pages?: string[];
  /**
   * The collection entries it shows on, for a link in the shared header or footer to a section of the page it is on:
   * an entry's page has none of a page's sections, only the layout's and the header and footer's.
   */
  entries?: string[];
  /**
   * The archive pages it shows on (see shared/archives.ts), by address, for a link in the shared header or footer to
   * a section of the page it is on: they have none of a page's sections either.
   */
  archives?: string[];
}

/**
 * Where the not-found page sends the shared header and footer's "on this page" links. It shows the header and
 * footer but none of a page's sections, and a static build refuses a link to a section its page does not have, so a
 * link to a section it lacks goes to that section on the first published page that has it (usually Home). A section
 * no page has stays as it is: every page's build refuses it already.
 */
export function notFoundSectionRoutes(state: ProjectState): Record<string, string> {
  const shell = shellIds(state);
  const pages = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id)).map((id) => state.pages[id]);
  // The not-found page shows each shared part a page shows (see generateLayout), and the IDs those parts render.
  const parts = SHELL_PARTS.filter((part) => pages.some((p) => showsPart(p, part)));
  const here = new Set([...LAYOUT_IDS, ...parts.flatMap((part) => [...shell[part]])]);
  const published = pages.filter((p) => !isDraftPage(state, p));
  const ids = new Map<string, Set<string>>();
  const idsOf = (pageId: string) => {
    if (!ids.has(pageId)) ids.set(pageId, pageIds(state, pageId, shell));
    return ids.get(pageId)!;
  };
  const out: Record<string, string> = {};
  // A jump in a panel the header or footer keeps in the page hidden is in the not-found page's HTML too.
  for (const part of parts)
    for (const { link } of renderedLinks(state, state.site.shell[part], false, true)) {
      const fragment = link.type === 'anchor' ? link.target.replace(/^#/, '') : '';
      if (!fragment || here.has(fragment) || Object.hasOwn(out, fragment)) continue;
      // Where the link works: a page that shows its part and has the section, else any page that has it.
      const page = published.find((p) => showsPart(p, part) && idsOf(p.id).has(fragment)) ?? published.find((p) => idsOf(p.id).has(fragment));
      if (page) out[fragment] = page.route;
    }
  return out;
}

/**
 * Links that jump to a section the destination page will not have: a page link's section, checked on that page,
 * and an "on this page" link, checked on every page that shows it, collection entries' pages included for the shared
 * header and footer, which every entry shows. A static build refuses these links, and a visitor who follows one lands
 * at the top of the page instead of the section.
 */
export function missingSectionLinks(state: ProjectState): SectionLinkIssue[] {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  const shell = shellIds(state);
  // Only published entries are pages of the website a build has to follow links on.
  const published = siteEntries(state).filter((e) => !isDraftEntry(e.entry));
  const entries = published.map((e) => e.entry.id);
  // Collections' index and archive pages show the header and footer around a list of entries, with no sections.
  const archives = archivePages(state).map((p) => p.route);
  const entryIds = new Set([...LAYOUT_IDS, ...shell.header, ...shell.footer]);
  const ids = new Map<string, Set<string>>();
  // A link visitors see at first must find its section on screen. One in a panel kept in the page hidden shows with
  // that panel, so a section in a hidden panel (its own, say) will do: the build finds it in the HTML.
  const idsOf = (pageId: string, hidden?: boolean) => {
    const key = `${hidden ? 'kept' : 'shown'}:${pageId}`;
    if (!ids.has(key)) ids.set(key, pageIds(state, pageId, hidden ? undefined : shell, !!hidden));
    return ids.get(key)!;
  };
  // An entry's page shows the site's layout, header and footer, and its collection's layout, around its own text.
  let keptEntryIds: Set<string> | undefined;
  const entryIdsOf = (hidden?: boolean) => (hidden ? (keptEntryIds ??= treeIds(state, [state.site.shell.header, state.site.shell.footer], new Set(LAYOUT_IDS), true)) : entryIds);
  // Each published entry's page as the website has it: its collection's layout read for it (what the entry lacks left
  // out), so a section is counted only on the entries that show it. Read only where it can matter: a section ID the
  // stored layout has nowhere is on no entry's page, whatever the entry.
  const articles = published.map((e) => {
    let tree: NodeTree | undefined;
    return { ...e, article: () => (tree ??= entryArticle(state, e.collection, e.entry)) };
  });
  const layoutIds = new Map<string, Set<string>>();
  const storedIdsOf = (collectionId: string, hidden?: boolean) => {
    const key = `${hidden ? 'kept' : 'shown'}:${collectionId}`;
    const template = storedLayout(state, collectionId);
    if (!layoutIds.has(key)) layoutIds.set(key, template?.nodes ? treeIds(state, [template], new Set(entryIdsOf(hidden)), !!hidden) : entryIdsOf(hidden));
    return layoutIds.get(key)!;
  };
  const articleIds = new Map<string, Set<string>>();
  const idsOnEntry = (a: (typeof articles)[number], hidden?: boolean) => {
    const key = `${hidden ? 'kept' : 'shown'}:${a.entry.id}`;
    if (!articleIds.has(key)) articleIds.set(key, treeIds(state, [a.article()], new Set(entryIdsOf(hidden)), !!hidden));
    return articleIds.get(key)!;
  };
  // The site's own sections and the header's and footer's are on every entry's page; one only the layout has is on
  // the pages of the entries that show it.
  const lacks = (a: (typeof articles)[number], fragment: string, hidden?: boolean) =>
    !storedIdsOf(a.collection.settings.id, hidden).has(fragment) || (!entryIdsOf(hidden).has(fragment) && !idsOnEntry(a, hidden).has(fragment));
  /** The published entries whose page lacks a section with this ID. */
  const lackingIn = (fragment: string, hidden: boolean | undefined) => articles.filter((a) => lacks(a, fragment, hidden)).map((a) => a.entry.id);
  /** Whether a collection's stored layout has a link these checks follow; its entries' pages are read only then. */
  const layoutLinks = new Map<string, boolean>();
  const hasSectionLinks = (collectionId: string) => {
    if (!layoutLinks.has(collectionId)) {
      const template = storedLayout(state, collectionId);
      // A placed section's links can depend on the words each entry gives it: a layout with one is always read.
      const placed = !!template?.nodes && Object.values(template.nodes).some((n) => n?.kind === 'instance');
      layoutLinks.set(collectionId, placed || (!!template?.nodes && renderedLinks(state, template, false, true).some(({ link }) => (link.type === 'page' && !!link.anchor) || link.type === 'anchor')));
    }
    return layoutLinks.get(collectionId)!;
  };
  // The header and footer are checked on the pages that show each: they can differ.
  const sources: Array<{ owner: SectionLinkIssue['owner']; tree: NodeTree; on: PageDoc[]; entry?: (typeof articles)[number] }> = [
    ...SHELL_PARTS.map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: state.site.shell[part], on: pagesShowing(state, part) })).filter((src) => src.on.length > 0 || entries.length > 0 || archives.length > 0),
    ...pages.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p as NodeTree, on: [p] })),
    // A collection's layout, as each of its published entries shows it.
    ...articles.filter((a) => hasSectionLinks(a.collection.settings.id)).map((a) => ({ owner: { kind: 'template' as const, id: a.collection.settings.id }, tree: a.article(), on: [] as PageDoc[], entry: a }))
  ];
  const out: SectionLinkIssue[] = [];
  const seen = new Map<string, SectionLinkIssue>();
  // A layout link's entries lacking its section, gathered across the entries' pages before they are written once.
  const lackingOf = new Map<SectionLinkIssue, Set<string>>();
  // Links in a panel kept in the page hidden are in its HTML, where the build follows them; the sections they go to
  // count only where a visitor can see them.
  for (const src of sources)
    for (const { link, label, reportId, key, inText, hidden } of renderedLinks(state, src.tree, false, true)) {
      let issue: SectionLinkIssue | null = null;
      if (link.type === 'page' && link.anchor && Object.hasOwn(state.pages, link.target)) {
        if (!idsOf(link.target, hidden).has(link.anchor)) issue = { owner: src.owner, nodeId: reportId, key, label, inText, fragment: link.anchor, pageId: link.target };
      } else if (link.type === 'anchor' && link.target) {
        const fragment = link.target.replace(/^#/, '');
        const missing = src.on.filter((p) => !idsOf(p.id, hidden).has(fragment)).map((p) => p.id);
        const lacking = src.owner.kind === 'shell' ? lackingIn(fragment, hidden) : src.entry && lacks(src.entry, fragment, hidden) ? [src.entry.entry.id] : [];
        const listing = src.owner.kind === 'shell' && !entryIdsOf(hidden).has(fragment) ? archives : [];
        if (missing.length || lacking.length || listing.length)
          issue = { owner: src.owner, nodeId: reportId, key, label, inText, fragment, pages: missing, ...(lacking.length ? { entries: lacking } : {}), ...(listing.length ? { archives: listing } : {}) };
      }
      // A link the walk reaches twice (a repeated slot, say) is reported once; one in a layout, once for all the
      // entries that lack its section.
      const id = JSON.stringify([src.owner, reportId, key]);
      if (!issue) continue;
      const had = seen.get(id);
      if (had) {
        if (src.entry && issue.entries?.length) issue.entries.forEach((e) => lackingOf.get(had)?.add(e));
        continue;
      }
      seen.set(id, issue);
      if (src.entry && issue.entries) lackingOf.set(issue, new Set(issue.entries));
      out.push(issue);
    }
  for (const [issue, ids] of lackingOf) issue.entries = [...ids];
  // An entry's text: its page has the layout's and the header and footer's sections, and none of a page's.
  for (const a of articles) {
    const { entry } = a;
    const owner = { kind: 'entry' as const, id: entry.id };
    const links = entryTextLinks(entry.body);
    // Text the entry's layout does not show has no links a visitor or the build could follow.
    if (!links.length || !showsBody(a.collection, a.article())) continue;
    links.forEach(({ link, label }, i) => {
      const key = `body:${i}`;
      if (link.type === 'page' && link.anchor && Object.hasOwn(state.pages, link.target)) {
        if (!idsOf(link.target).has(link.anchor)) out.push({ owner, nodeId: '', key, label, inText: true, fragment: link.anchor, pageId: link.target });
      } else if (link.type === 'anchor' && link.target) {
        const fragment = link.target.replace(/^#/, '');
        if (lacks(a, fragment)) out.push({ owner, nodeId: '', key, label, inText: true, fragment, entries: [entry.id] });
      }
    });
  }
  return out;
}

/**
 * The links in an entry's text that visitors see, in order, each with its words. Text damaged by a hand edit (a block
 * that is not one, which Project health reports) holds none, and a link with no words shows nothing to follow.
 */
function entryTextLinks(body: unknown): Array<{ link: LinkValue; label: string }> {
  const out: Array<{ link: LinkValue; label: string }> = [];
  const spans = (list: unknown) => {
    for (const s of Array.isArray(list) ? (list as RichSpan[]) : []) {
      const label = typeof s?.text === 'string' ? s.text.trim() : '';
      if (label && s.link && typeof s.link.type === 'string' && typeof s.link.target === 'string') out.push({ link: s.link, label });
    }
  };
  for (const b of Array.isArray(body) ? body : []) {
    if (!isRichBlock(b)) continue;
    spanRuns(b).forEach(spans);
  }
  return out;
}

/** A link visitors would see on the published site that goes to a draft page. */
export interface DraftLink {
  /**
   * Where the link is: a published page, the shared header or footer shown on one, the layout of a collection with a
   * published entry, or a published entry's text.
   */
  owner: { kind: 'page' | 'shell' | 'entry' | 'template'; id: string };
  /** The page or shell node that holds it (the instance, for links inside a component). */
  nodeId: string;
  /** The link's text, when it has one. */
  label: string;
  /** A link inside rich text. */
  inText: boolean;
  /** The draft page it goes to, or else the draft collection entry (a typed address of the entry's). */
  pageId?: string;
  entryId?: string;
  anchor?: string;
}

/** A draft a link can lead to: a page, or a collection entry. */
type DraftTarget = { pageId: string; entryId?: undefined } | { entryId: string; pageId?: undefined };

/**
 * What the next website export publishes: the pages, in site order, the collection entries it has a page for, the
 * drafts (pages and entries) it leaves out, and links to them.
 */
export interface PublicationPlan {
  published: PageDoc[];
  drafts: PageDoc[];
  /** The collection entries the website gets a page for, each with its collection and address. */
  publishedEntries: SiteEntry[];
  /** The collection entries the website leaves out: they stay in the editable project. */
  draftEntries: SiteEntry[];
  draftLinks: DraftLink[];
}

/** What a website export publishes, by ID: its pages, and its collection entries as `entry:ID`, so no entry shares an ID with a page. */
export function publicationIds(plan: Pick<PublicationPlan, 'published' | 'publishedEntries'>): string[] {
  return [...plan.published.map((p) => p.id), ...plan.publishedEntries.map((e) => `entry:${e.entry.id}`)];
}

/**
 * What a typed web address opens, when it is on the site's own public URL and names one of the addresses `withheld`
 * maps (lowercased) to what is there: a draft's address or an old address that leads to a draft, say.
 */
function targetAtAddress<T extends object>(state: ProjectState, target: string, withheld: Map<string, T>): (T & { anchor?: string }) | null {
  // Only a public URL the site is built from makes an address the site's own.
  const base = publicUrl(state.site);
  if (!base || !withheld.size) return null;
  const site = new URL(base);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.origin !== site.origin) return null;
  const prefix = site.pathname.replace(/\/+$/, '');
  if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return null;
  let path = url.pathname.slice(prefix.length) || '/';
  try {
    path = decodeURI(path);
  } catch {
    // Kept as typed: a malformed escape names no page.
  }
  // "/winter/index.html" is the file a static host serves at "/winter/".
  path = path.replace(/\/index\.html$/i, '/');
  const draft = withheld.get((path.endsWith('/') ? path : path + '/').toLowerCase());
  if (!draft) return null;
  const anchor = url.hash.replace(/^#/, '');
  return anchor ? { ...draft, anchor } : draft;
}

/**
 * Which pages the website export publishes and which drafts it leaves out, with every link the published pages
 * show (the shared header or footer included, when a published page or entry shows it) that goes to a draft: a link
 * to the page, or a typed address on the site's own public URL that opens a draft page or a draft collection entry.
 * Those links would lead visitors to a page the website does not have, so the website export stops until they
 * change. Links on a draft are not checked: the draft is not published.
 */
export function publicationPlan(state: ProjectState): PublicationPlan {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  const published = pages.filter((p) => !isDraftPage(state, p));
  const drafts = pages.filter((p) => isDraftPage(state, p));
  const draftLinks: DraftLink[] = [];
  const entries = siteEntries(state);
  const draftEntries = entries.filter((e) => isDraftEntry(e.entry));
  // The entries that get a page are the website's, judged as its export judges them: with the drafts already left out,
  // so a draft that holds an address (a hand-edited clash) never hides the published entry that gets it.
  const live = publishedState(state);
  const publishedEntries = live === state ? entries : siteEntries(live);
  if (!drafts.length && !draftEntries.length) return { published, drafts, publishedEntries, draftEntries, draftLinks };
  const draftIds = new Set(drafts.map((p) => p.id));
  // The addresses visitors would find nothing at: each draft's own, and the old addresses that lead to one.
  const withheld = new Map<string, DraftTarget>([
    ...drafts.map((p): [string, DraftTarget] => [p.route.toLowerCase(), { pageId: p.id }]),
    ...draftEntries.map((e): [string, DraftTarget] => [e.route.toLowerCase(), { entryId: e.entry.id }]),
    ...liveRedirects(state).flatMap((r): Array<[string, DraftTarget]> =>
      r.page ? (draftIds.has(r.page.id) ? [[r.from.toLowerCase(), { pageId: r.page.id }]] : []) : isDraftEntry(r.entry.entry) ? [[r.from.toLowerCase(), { entryId: r.entry.entry.id }]] : []
    )
  ]);
  // A typed address an archive page answers at (a draft's, made before archive pages) leads to the archive.
  for (const p of archivePages(state)) withheld.delete(p.route.toLowerCase());
  // An entry shows both shared parts, and its collection's layout; so does a collection's index (an archive page).
  const entryShown = entries.length > draftEntries.length || archivePages(state).length > 0;
  const draftEntryIds = new Set(draftEntries.map((e) => e.entry.id));
  // A layout's links go where the layout says, whatever the entry, apart from Previous and Next, which never lead to a
  // draft: one with no link to a page, an entry or an address has none to a draft on any entry's page.
  const mayLink = new Map<string, boolean>();
  const layoutMayLinkToDraft = (collectionId: string) => {
    if (!mayLink.has(collectionId)) {
      const t = state.collections[collectionId]?.settings?.template;
      const placed = !!t?.nodes && Object.values(t.nodes).some((n) => n?.kind === 'instance');
      mayLink.set(collectionId, !!t?.nodes && (draftIds.size > 0 || draftEntryIds.size > 0 || withheld.size > 0) && (placed || /"type":"(page|entry|url)"/.test(JSON.stringify(t.nodes))));
    }
    return mayLink.get(collectionId)!;
  };
  const sources: Array<{ owner: DraftLink['owner']; tree: NodeTree }> = [
    ...published.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p as NodeTree })),
    // Each shared part, when a published page shows it: the header and footer can be on different pages.
    ...SHELL_PARTS.filter((part) => entryShown || published.some((p) => showsPart(p, part))).map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: state.site.shell[part] })),
    // Each collection's layout, as each published entry shows it: its own words on the layout's buttons, and only the
    // elements that entry shows. Read only for a layout that links where a draft could be at all.
    ...entries
      .filter((e) => !draftEntryIds.has(e.entry.id) && layoutMayLinkToDraft(e.collection.settings.id))
      .map((e) => ({ owner: { kind: 'template' as const, id: e.collection.settings.id }, tree: entryArticle(state, e.collection, e.entry) }))
  ];
  const seen = new Set<string>();
  // A link a visitor reaches by choosing a tab or opening a disclosure goes to the draft as surely as one shown at first.
  for (const src of sources)
    for (const { link, label, reportId, key, inText } of renderedLinks(state, src.tree, true)) {
      const to =
        link.type === 'page' && draftIds.has(link.target)
          ? { pageId: link.target, ...(link.anchor ? { anchor: link.anchor } : {}) }
          : link.type === 'entry' && draftEntryIds.has(link.target)
            ? { entryId: link.target }
            : link.type === 'url'
              ? targetAtAddress(state, link.target, withheld)
              : null;
      if (!to) continue;
      // A link the walk reaches twice (a repeated slot, say) is reported once.
      const id = JSON.stringify([src.owner, reportId, key]);
      if (seen.has(id)) continue;
      seen.add(id);
      draftLinks.push({ owner: src.owner, nodeId: reportId, label, inText, ...to });
    }
  // A published entry's text: a link to a draft entry, a page link to a draft page, or a typed address of one.
  for (const { entry, collection } of entries) {
    if (draftEntryIds.has(entry.id)) continue;
    const found: DraftLink[] = [];
    for (const { link, label } of entryTextLinks(entry.body)) {
      const to: (DraftTarget & { anchor?: string }) | null =
        link.type === 'entry' && draftEntryIds.has(link.target)
          ? { entryId: link.target }
          : link.type === 'page' && draftIds.has(link.target)
            ? { pageId: link.target, ...(link.anchor ? { anchor: link.anchor } : {}) }
            : link.type === 'url'
              ? targetAtAddress(state, link.target, withheld)
              : null;
      if (to) found.push({ owner: { kind: 'entry', id: entry.id }, nodeId: '', label, inText: true, ...to });
    }
    // Text the entry's layout does not show links nowhere on the website.
    if (found.length && showsBody(collection, entryArticle(state, collection, entry))) draftLinks.push(...found);
  }
  return { published, drafts, publishedEntries, draftEntries, draftLinks };
}

/** A link visitors see on the published website, with where it is, the words on it, and the page it leads to. */
export interface SiteLink {
  /**
   * Where it is: a published page, the shared header or footer (when anything published shows it), a collection's
   * layout as a published entry's page shows it, or a published entry's text.
   */
  owner: { kind: 'page' | 'shell' | 'template' | 'entry'; id: string };
  /** The node that holds it (the instance, for a link inside a component); empty in an entry's text. */
  nodeId: string;
  /** Tells apart the links one node holds. */
  key: string;
  /** For a layout's link, the first published entry whose page shows it; for an entry's text, that entry. */
  entryId?: string;
  link: LinkValue;
  /** The words on it, or what stands in for them when `unnamed`. */
  label: string;
  /** Visitors do not see `label` on the link: an element's or a field's name stands in for words it may not have. */
  unnamed?: boolean;
  /** Inside rich text. */
  inText: boolean;
  /** The page it leads to: by a link to the page, or by a typed address of the page (or an old one of it) on the public URL. */
  pageId?: string;
}

/**
 * Every link the published website shows, as `publicationPlan` reads them: the published pages, the shared header
 * and footer while a published page (or entry, or collection index) shows them, each collection's layout as each
 * published entry's page shows it, and published entries' text where their layout shows it. A link reached by
 * choosing a tab or opening a disclosure counts as one shown at first. A link the walk reaches twice is listed once.
 */
export function siteLinks(state: ProjectState): SiteLink[] {
  // Read as the website has it: conditions on a draft, and links to one, are judged as the export judges them.
  const live = publishedState(state);
  const published = live.site.pageOrder.filter((id) => Object.hasOwn(live.pages, id) && typeof live.pages[id]?.route === 'string').map((id) => live.pages[id]);
  const entries = siteEntries(live);
  const archived = archivePages(live).length > 0;
  // Addresses the website answers at with a page: each page's own, and the old addresses kept for it.
  const addresses = new Map<string, { pageId: string }>(published.map((p) => [p.route.toLowerCase(), { pageId: p.id }]));
  for (const r of liveRedirects(live)) if (r.page) addresses.set(r.from.toLowerCase(), { pageId: r.page.id });
  const pageOf = (link: LinkValue): string | undefined => {
    // A link to a draft leads to no page of the website.
    if (link.type === 'page') return published.some((p) => p.id === link.target) ? link.target : undefined;
    return link.type === 'url' ? targetAtAddress(live, link.target, addresses)?.pageId : undefined;
  };
  // A link that goes nowhere renders as no link at all.
  const leads = (link: LinkValue) => link.type !== 'none' && typeof link.target === 'string' && !!link.target.trim();
  const sources: Array<{ owner: SiteLink['owner']; tree: NodeTree; entryId?: string }> = [
    ...published.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p as NodeTree })),
    ...SHELL_PARTS.filter((part) => entries.length > 0 || archived || published.some((p) => showsPart(p, part))).map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: live.site.shell[part] })),
    ...entries.map((e) => ({ owner: { kind: 'template' as const, id: e.collection.settings.id }, tree: entryArticle(live, e.collection, e.entry), entryId: e.entry.id }))
  ];
  const out: SiteLink[] = [];
  const seen = new Set<string>();
  for (const src of sources)
    for (const { link, label, reportId, key, inText, unnamed } of renderedLinks(live, src.tree, true)) {
      if (!leads(link)) continue;
      // A layout's link is listed once, unless another entry's page shows it with other words or another destination.
      const id = JSON.stringify([src.owner, reportId, key, link, label, !!unnamed]);
      if (seen.has(id)) continue;
      seen.add(id);
      const pageId = pageOf(link);
      out.push({ owner: src.owner, nodeId: reportId, key, ...(src.entryId ? { entryId: src.entryId } : {}), link, label, ...(unnamed ? { unnamed } : {}), inText, ...(pageId ? { pageId } : {}) });
    }
  for (const { entry, collection } of entries) {
    // Numbered among all the text's links, so a link's key stays when one before it is changed to go nowhere.
    const links = entryTextLinks(entry.body)
      .map((l, i) => ({ ...l, key: `body:${i}` }))
      .filter(({ link }) => leads(link));
    // Text the entry's layout does not show links nowhere on the website.
    if (!links.length || !showsEntryText(live, collection, entry)) continue;
    for (const { link, label, key } of links) {
      const pageId = pageOf(link);
      out.push({ owner: { kind: 'entry', id: entry.id }, nodeId: '', key, entryId: entry.id, link, label, inText: true, ...(pageId ? { pageId } : {}) });
    }
  }
  return out;
}

/**
 * A draft link in words an author can find it by: where it is (the page or Header/Footer, and the component holding
 * it), the words on it, and the draft it goes to. "Home · Feature cards: “See the winter stock” goes to Winter stock
 * preview (/winter-stock-preview/)".
 */
export function describeDraftLink(state: ProjectState, l: DraftLink): string {
  const layout = l.owner.kind === 'template' ? state.collections[l.owner.id] : undefined;
  const tree = l.owner.kind === 'shell' ? state.site.shell[l.owner.id as 'header' | 'footer'] : l.owner.kind === 'page' ? state.pages[l.owner.id] : layout?.settings.template;
  const entry = l.owner.kind === 'entry' ? findEntry(state, l.owner.id) : undefined;
  const place =
    l.owner.kind === 'shell' ? (l.owner.id === 'header' ? 'Header' : 'Footer') : layout ? `${layout.settings.name} layout` : entry ? `${entry.entry.title} (${entry.collection.settings.name})` : (state.pages[l.owner.id]?.title ?? 'A page');
  const node = tree?.nodes[l.nodeId];
  const where = node && node.kind === 'instance' ? `${place} · ${displayName(state, node)}` : place;
  const draft = draftTarget(state, l);
  const to = draft ? `${draft.title} (${draft.route}${l.anchor ? `#${l.anchor}` : ''})` : 'a draft page';
  return `${where}: ${l.label ? `“${l.label}”` : l.inText ? 'a link in the text' : 'a link'} goes to ${to}`;
}

/** The draft page or collection entry a draft link goes to, by its title and address, while it is there. */
export function draftTarget(state: ProjectState, l: Pick<DraftLink, 'pageId' | 'entryId'>): { title: string; route: string } | undefined {
  if (l.pageId !== undefined) return Object.hasOwn(state.pages, l.pageId) ? state.pages[l.pageId] : undefined;
  const found = l.entryId !== undefined ? findEntry(state, l.entryId) : undefined;
  return found ? { title: found.entry.title, route: entryRoute(found.collection, found.entry) } : undefined;
}

export interface PageSection {
  /** The page node that is the section (a placed section, a section element or a heading). */
  nodeId: string;
  /** Its visible heading, or a name for it when it has none. */
  label: string;
  /** The ID it already has. Sections without one get one when a link first chooses them. */
  anchor?: string;
  /** Inside another listed section. */
  nested: boolean;
}

const HEADING = /^h[1-6]$/;

/**
 * The ID a page node renders with: its own anchor, or for a placed section without one, the anchor its component's
 * root carries (`so_id ?? anchor`, through components whose root is another component).
 */
function renderedAnchor(state: ProjectState, n: GraphNode, depth = 0): string | undefined {
  if (n.anchor) return n.anchor;
  if (n.kind !== 'instance' || depth > 10) return undefined;
  const def = state.components[n.definitionId];
  const root = def?.kind === 'managed' ? def.tree?.nodes[def.tree.rootIds[0]] : undefined;
  return root ? renderedAnchor(state, root, depth + 1) : undefined;
}

/** A name for a section without a visible heading: its `heading` property, its layer name or its component's. */
function sectionName(state: ProjectState, n: GraphNode): string {
  const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
  const heading = def && n.kind === 'instance' ? effectiveProps(state, def, n, { props: {} }).heading : undefined;
  if (typeof heading === 'string' && heading.trim()) return heading.replace(/\s+/g, ' ').trim();
  return n.name ?? def?.name ?? 'Section';
}

function headingText(n: GraphNode & { kind: 'text' }, scope: Scope): string {
  const v = evaluate(n.text, scope);
  const text = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) ? richTextToPlain(toRichText(v)) : '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The sections a link can jump to on a page, in page order, each named by the first heading it shows: placed
 * sections (nested ones too), section elements, headings that stand on their own, and anything with an ID.
 * A wrapper whose only heading belongs to a section inside it is left out; the inner section stands for it.
 */
export function pageSections(state: ProjectState, pageId: string): PageSection[] {
  const page = state.pages[pageId];
  if (!page) return [];
  const isSection = (n: GraphNode) =>
    !!renderedAnchor(state, n) || (n.kind === 'instance' && anchorCapable(state, state.components[n.definitionId])) || (n.kind === 'element' && n.tag === 'section');
  interface Open {
    node: GraphNode;
    label: string;
    children: number;
    index: number;
  }
  const list: Array<PageSection & { keep: boolean; parent?: number }> = [];
  const open: Open[] = [];
  const used = new Set<string>();
  const counts = idCounts(state, pageId);
  /**
   * A section's ID. One it only inherits from its component is not its own when other elements render it too: a
   * link to it would go to whichever comes first, and moving the sections would change which one that is.
   */
  const idOf = (n: GraphNode) => {
    const id = renderedAnchor(state, n);
    if (!id || (!n.anchor && (used.has(id) || (counts.get(id) ?? 0) > 1))) return undefined;
    used.add(id);
    return id;
  };
  walkRendered(state, page, {
    enter: (n) => {
      if (isSection(n)) {
        const parent = open[open.length - 1];
        if (parent) parent.children++;
        open.push({ node: n, label: '', children: 0, index: list.length });
        list.push({ nodeId: n.id, label: '', anchor: idOf(n), nested: false, keep: true, parent: parent?.index });
      } else if (n.kind === 'text' && typeof n.tag === 'string' && HEADING.test(n.tag) && !open.length) {
        const label = headingText(n, { props: {} });
        if (label) list.push({ nodeId: n.id, label, anchor: idOf(n), nested: false, keep: true });
      }
    },
    text: (n, scope) => {
      const top = open[open.length - 1];
      if (!top || top.label || !HEADING.test(String(evaluate(n.tag, scope) ?? ''))) return;
      // A heading inside a nested section names that section, not the one around it.
      if (top.children) return;
      top.label = headingText(n, scope);
    },
    leave: (n) => {
      const top = open[open.length - 1];
      if (top?.node !== n) return;
      open.pop();
      const entry = list[top.index];
      entry.label = top.label;
      if (!top.label) {
        if (top.children && !entry.anchor) entry.keep = false;
        else entry.label = sectionName(state, n);
      }
    }
  });
  // Nested means inside a section that is still listed.
  const listedAbove = (e: (typeof list)[number]): boolean => e.parent !== undefined && (list[e.parent].keep || listedAbove(list[e.parent]));
  return list.filter((e) => e.keep).map((e) => ({ nodeId: e.nodeId, label: e.label, anchor: e.anchor, nested: listedAbove(e) }));
}

/** A new section ID made from a heading ("Get in touch" → "get-in-touch"), numbered when the page already has it. */
export function sectionAnchorFor(label: string, taken: Set<string>): string {
  const base = slugify(label).replace(/^[^a-z]+/, '').slice(0, 54).replace(/-+$/, '') || 'section';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * What choosing a section in a link picker does: reuse the ID the section already has, or give it one made from
 * its heading. The edit that gives it one goes in the same batch as the link change, so they save and undo together.
 * `reserved` holds IDs a new one must not take: ones other edits in that batch give out or still mean something else.
 */
export function planSectionPick(state: ProjectState, pageId: string, nodeId: string, reserved: Iterable<string> = []): { anchor: string; operations: EditOperation[] } | null {
  const node = state.pages[pageId]?.nodes[nodeId];
  if (!node) return null;
  const section = pageSections(state, pageId).find((x) => x.nodeId === nodeId);
  if (!section) return node.anchor ? { anchor: node.anchor, operations: [] } : null;
  // An ID the section already renders with is reused, never replaced: other links may jump to it.
  if (section.anchor) return { anchor: section.anchor, operations: [] };
  const owner = { kind: 'page' as const, id: pageId };
  // Not one a panel kept in the page hidden already has: the page's HTML would hold it twice.
  const anchor = sectionAnchorFor(section.label, new Set([...anchorsInUse(state, owner), ...pageIds(state, pageId, undefined, true), ...reserved]));
  return { anchor, operations: [{ type: 'node.setContent', owner, nodeId, field: 'anchor', value: anchor }] };
}


// ---------------------------------------------------------------------------
// Heading outline
// ---------------------------------------------------------------------------

/** Where a heading's level is chosen: its own tag, or a property of the placement that shows it. */
export type HeadingLevelSource = { kind: 'node' } | ({ kind: 'prop' } & PlacementField);

/** One heading a page renders, in the order a screen reader's heading list reads them. */
export interface OutlineHeading {
  /** 1 for `<h1>` (the page's title) through 6. */
  level: number;
  /** Its words, as visitors read them. Empty for a heading with no words. */
  text: string;
  /** The page, or the shared header or footer, whose tree shows it. */
  owner: OwnerRef;
  /** The node in that tree: the heading's own node, or the outermost placement it is shown through. */
  nodeId: string;
  /** For a heading inside a component: the definition node showing it. */
  defNodeId?: string;
  /** Set when the placement places that definition directly: the list items it is shown for, outermost first. */
  itemPath?: string[];
  /** Shown by a component placed directly at `nodeId` (not one inside its design or a code component). */
  direct?: boolean;
  /** For a heading in a component inside the placed one: the placements from `nodeId` in, when they can be named. */
  instancePath?: string[];
  /** The declared part of its definition the heading is, if any. */
  partId?: string;
  /** A subheading written inside rich text: its level is part of the text. */
  rich?: boolean;
  /** Rendered more than once from this one place (slot content a component shows for each item, say). */
  repeated?: boolean;
  /** Where its level can be changed, and the levels offered there. Absent when a component's design fixes it. */
  levelSource?: HeadingLevelSource;
  levels?: number[];
  /** The field choosing its level also decides whether something on the page shows: changing it may change more. */
  levelConditions?: boolean;
}

const levelOf = (tag: unknown) => (typeof tag === 'string' && HEADING.test(tag) ? Number(tag[1]) : 0);
const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);
const SIZES = ['phone', 'tablet', 'desktop'] as const;

/** Whether one size's styles show an element the base hides: unhidden, or given a display by a layout or custom CSS. */
function showsAt(at: unknown): boolean {
  // A hand-edited document may hold anything here; only an object of styles applies.
  if (!at || typeof at !== 'object' || Array.isArray(at)) return false;
  const st = at as Record<string, unknown>;
  if (st.hidden === false) return true;
  if (st.hidden === true) return false;
  return st.layout !== undefined || (typeof st.customCss === 'string' && /(^|[;{\s])display\s*:/i.test(st.customCss));
}

/** Whether styles hide an element at every size: hidden at the base size, and shown again at none. */
const hiddenEverywhere = (...layers: Array<ResponsiveStyles | undefined>) => {
  const valid = layers.filter((l): l is ResponsiveStyles => !!l && typeof l === 'object');
  const base = (l: ResponsiveStyles) => (l.base && typeof l.base === 'object' ? l.base.hidden : undefined);
  return valid.some((l) => base(l) === true) && !valid.some((l) => SIZES.some((z) => showsAt(l[z])));
};

/** The tag a text node renders, as the generator decides it: a bound tag's value when it is one of its choice's text tags, else the choice's default. */
function renderedTag(n: GraphNode & { kind: 'text' }, scope: Scope, def: ComponentDefinition | undefined): { tag: string; levels?: number[] } {
  if (!isBinding(n.tag)) return { tag: TEXT_TAG_SET.has(n.tag) ? n.tag : 'p' };
  const b = n.tag;
  const schema = '$prop' in b ? (def ? propBindingSchema(def.properties, b) : undefined) : '$item' in b ? scope.fields?.[b.$item] : undefined;
  const options = schema?.type === 'enum' ? schema.options.map((o) => o.value).filter((o) => TEXT_TAG_SET.has(o)) : [];
  const fallback = schema?.type === 'enum' && options.includes(schema.default) ? schema.default : (options[0] ?? 'p');
  const v = evaluate(b, scope);
  return { tag: typeof v === 'string' && options.includes(v) ? v : fallback, levels: options.map(levelOf).filter(Boolean) };
}

/**
 * The headings a page renders, in order, and whether it places code whose headings cannot be read here. Headings
 * hidden at every size are left out, as screen readers never reach them.
 */
function collectHeadings(state: ProjectState, pageId: string, shell: boolean): { outline: OutlineHeading[]; uninspected: boolean } {
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page) return { outline: [], uninspected: false };
  const trees: Array<[OwnerRef, NodeTree]> = [[{ kind: 'page', id: page.id }, page]];
  // The shared header and footer the page shows, each in its place around the page's own content.
  if (shell && showsPart(page, 'header')) trees.unshift([{ kind: 'shell', id: 'header' }, state.site.shell.header]);
  if (shell && showsPart(page, 'footer')) trees.push([{ kind: 'shell', id: 'footer' }, state.site.shell.footer]);
  const out: OutlineHeading[] = [];
  let uninspected = false;
  // The headings shown through each slot: a slot shown again (by a second slot of that name) repeats them.
  const bySlot = new Map<string, OutlineHeading[]>();
  const add = (h: OutlineHeading, scope: Scope) => {
    // Slot content a design shows inside a list renders once per item; a code component's is taken as shown once.
    if (scope.multiple && !scope.codeSlot) h.repeated = true;
    for (const slot of scope.slots ?? []) {
      const list = bySlot.get(slot);
      if (list) list.push(h);
      else bySlot.set(slot, [h]);
    }
    out.push(h);
  };
  // Placement fields a design's conditions read: a heading level chosen by one of them decides more than the level.
  const fieldKey = (owner: OwnerRef, nodeId: string, f: PlacementField) => JSON.stringify([owner.kind, owner.id, nodeId, f.prop, f.itemId ?? null, f.field ?? null]);
  const conditions = new Set<string>();
  for (const [owner, tree] of trees) {
    // Page nodes hidden at every size, from the outermost one in: nothing inside them renders for anyone.
    const hiding: boolean[] = [];
    let hidden = 0;
    walkRendered(state, tree, {
      enter: (n) => {
        const hides = hiddenEverywhere(n.styles, n.kind === 'instance' ? n.overrides?.root : undefined);
        hiding.push(hides);
        if (hides) hidden++;
      },
      leave: () => {
        if (hiding.pop()) hidden--;
      },
      again: (slot) => {
        for (const h of bySlot.get(slot) ?? []) h.repeated = true;
      },
      node: (n, scope, reportId, inDef) => {
        if (!inDef) return;
        for (const ref of [conditionRef(n.when), conditionRef(n.unless)]) {
          const f = placementField(ref, scope);
          if (f) conditions.add(fieldKey(owner, reportId, f));
        }
      },
      text: (n, scope, reportId, inDef, def) => {
        if (hidden) return;
        const where: Pick<OutlineHeading, 'owner' | 'nodeId' | 'defNodeId' | 'itemPath' | 'direct' | 'instancePath' | 'partId'> = { owner, nodeId: reportId };
        if (inDef) {
          where.defNodeId = n.id;
          where.direct = !!scope.placement;
          if (scope.placement && scope.path?.length) where.itemPath = scope.path;
          // A heading in a component inside the placed one is selected through the placements between, when no list
          // item is on the way (those are named by the item, not by the path).
          const trail = (scope.trail ?? '').split('/').filter(Boolean);
          if (!scope.placement && trail.length > 1 && !trail.some((t) => t.includes('[')) && !scope.path?.length) where.instancePath = trail;
          const partId = def && Object.entries(def.parts).find(([, part]) => part.nodeId === n.id)?.[0];
          if (partId) where.partId = partId;
        }
        if (n.rich) {
          const v = evaluate(n.text, scope);
          for (const block of Array.isArray(v) || typeof v === 'string' ? toRichText(v) : []) {
            const level = levelOf(block.type);
            if (level && !isListBlock(block) && !isImageBlock(block)) add({ level, text: block.spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim(), ...where, rich: true }, scope);
          }
          return;
        }
        const shown = renderedTag(n, scope, def);
        const level = levelOf(shown.tag);
        if (!level) return;
        const heading: OutlineHeading = { level, text: headingText(n, scope), ...where };
        if (!inDef) {
          if (!isBinding(n.tag)) Object.assign(heading, { levelSource: { kind: 'node' }, levels: [1, 2, 3, 4, 5, 6] });
        } else {
          // A design's heading takes its level from a choice its placement makes, read through any designs between:
          // the levels offered are the placement's options that this heading can render.
          const f = placementField(n.tag, scope);
          const schema = f && fieldSchema(state, tree, reportId, f);
          const levels = schema?.type === 'enum' ? schema.options.map((o) => levelOf(o.value)).filter((l) => l && shown.levels?.includes(l)) : [];
          if (f && levels.length) Object.assign(heading, { levelSource: { kind: 'prop', ...f }, levels });
        }
        add(heading, scope);
      },
      code: (def, props, reportId, _placement, _n, scope, inDef) => {
        if (hidden) return;
        const which = shippedCode(state, def);
        // Other code's headings are not known here: the page's review cannot say it has no title.
        if (!which) uninspected ||= owner.kind === 'page';
        // The shipped contact form, data table and video show their heading as an `<h2>`.
        if ((which !== 'contact.form' && which !== 'data.table' && which !== 'media.video') || typeof props.heading !== 'string' || !props.heading.trim()) return;
        add({ level: 2, text: props.heading.replace(/\s+/g, ' ').trim(), owner, nodeId: reportId, ...(inDef ? { direct: false } : {}) }, scope);
      }
    });
  }
  for (const h of out) if (h.levelSource?.kind === 'prop' && (conditions.has(fieldKey(h.owner, h.nodeId, h.levelSource)) || readByDesign(state, h.owner, h.nodeId, h.levelSource))) h.levelConditions = true;
  return { outline: out, uninspected };
}

/**
 * Whether the design a placement places reads one of its fields in a condition, whether that node shows now or not:
 * the walk only sees the conditions of what renders, and changing the field could reveal what does not.
 */
function readByDesign(state: ProjectState, owner: OwnerRef, nodeId: string, f: PlacementField): boolean {
  const tree = owner.kind === 'page' ? state.pages[owner.id] : owner.kind === 'shell' ? state.site.shell[owner.id as 'header' | 'footer'] : undefined;
  const inst = tree && Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
  const def = inst?.kind === 'instance' && Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  const reads = (c: unknown) => {
    const ref = conditionRef(c);
    return !!ref && (f.itemId ? '$item' in ref && ref.$item === f.field : '$prop' in ref && ref.$prop === f.prop && (f.field === undefined || ref.field === undefined || ref.field === f.field));
  };
  return Object.values(def?.tree?.nodes ?? {}).some((n) => reads(n.when) || reads(n.unless));
}

/**
 * The headings a page renders, shared header and footer included when it shows them, read the way the generated
 * markup renders them: a heading whose condition fails, or that is hidden at every size, is left out, and one inside
 * a list is listed once per item. Each says where its level is chosen when an author can change it.
 */
export function headingOutline(state: ProjectState, pageId: string): OutlineHeading[] {
  return collectHeadings(state, pageId, true).outline;
}

/** What a page's headings ask its author to review. Indexes are positions in the outline. */
export interface HeadingReview {
  /** The page's own Heading 1s: its title, or more than one where only one is meant. */
  titles: number[];
  /** More Heading 1s than one: a heading rendered more than once counts each time. */
  extraTitles: boolean;
  /** The page has content but none of its headings is a Heading 1. */
  missingTitle: boolean;
  /** Headings more than one level below the heading before them, and the level that would follow on from it. */
  skips: Array<{ index: number; after: number; suggest: number }>;
}

/**
 * Review a page's outline the way a screen reader's heading list presents it: one Heading 1 as the page's title,
 * and each heading at most one level below the one before it. Only the page's own headings count: the shared header
 * and footer are the same on every page, so they neither give a page its title nor leave a gap in its outline.
 */
export function reviewHeadings(outline: OutlineHeading[], hasContent: boolean, uninspected = false): HeadingReview {
  const own = outline.map((h, index) => ({ h, index })).filter(({ h }) => h.owner.kind === 'page');
  const titles = own.filter(({ h }) => h.level === 1).map(({ index }) => index);
  const shown = titles.reduce((n, i) => n + (outline[i].repeated ? 2 : 1), 0);
  const skips: HeadingReview['skips'] = [];
  for (let k = 1; k < own.length; k++) {
    const after = own[k - 1].h.level;
    if (own[k].h.level > after + 1) skips.push({ index: own[k].index, after, suggest: after + 1 });
  }
  // Code whose headings cannot be read may hold the title.
  return { titles, extraTitles: shown > 1, missingTitle: hasContent && !titles.length && !uninspected, skips };
}

/**
 * The review of one page's headings, with the outline it was made from and whether code on the page shows headings
 * that cannot be read. `shell: false` leaves out the shared header and footer, which the review never counts.
 */
export function pageHeadings(state: ProjectState, pageId: string, opts: { shell?: boolean } = {}): { outline: OutlineHeading[]; review: HeadingReview; uninspected: boolean } {
  const { outline, uninspected } = collectHeadings(state, pageId, opts.shell !== false);
  const hasContent = Object.hasOwn(state.pages, pageId) && !!state.pages[pageId].rootIds.length;
  return { outline, review: reviewHeadings(outline, hasContent, uninspected), uninspected };
}

/**
 * An entry's page as the website has it, around its own text: its collection's layout read for the entry. The text
 * itself is left out, since its links are checked as the entry's own.
 */
function entryArticle(state: ProjectState, collection: Collection, entry: EntryDoc): NodeTree {
  const tree = materializeTemplate(state, collection, entry, entryNeighbours(state, collection.settings.id, entry.id), { body: false });
  entryTrees.set(tree, { collectionId: collection.settings.id, entryId: entry.id });
  return tree;
}

/** Whether an entry's page shows its text: its collection's layout places the entry's text. */
export function showsEntryText(state: ProjectState, collection: Collection, entry: EntryDoc): boolean {
  return showsBody(collection, entryArticle(state, collection, entry));
}

/** The entry each entry's page read by these checks is for, so its feeds are worked out as that page has them. */
const entryTrees = new WeakMap<NodeTree, { collectionId: string; entryId: string }>();

/** A collection's layout as stored, when it is a tree at all (a damaged one is reported with its settings). */
function storedLayout(state: ProjectState, collectionId: string): NodeTree | undefined {
  const t = state.collections[collectionId]?.settings?.template;
  if (!(t && typeof t === 'object' && Array.isArray(t.rootIds) && t.nodes && typeof t.nodes === 'object')) return undefined;
  // Read for no entry in particular: its feeds list its own collection's entries, leaving none out.
  if (!entryTrees.has(t)) entryTrees.set(t, { collectionId, entryId: '' });
  return t;
}

