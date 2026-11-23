/**
 * Checks on what a page will actually show, evaluated with the same rules the generated components use.
 */
import type { Binding, ComponentDefinition, GraphNode, ImageValue, LinkValue, NodeTree, PageDoc, ProjectState, PropSchema } from '@shared/types';
import { conditionHolds, conditionRef, isBinding, type Condition } from '@shared/types';
import { isListBlock, richTextToPlain, toRichText, type RichSpan } from '@shared/richtext';
import type { EditOperation } from '@shared/ops';
import { slugify } from '@shared/routes';
import { anchorCapable, anchorsInUse } from '@engine/tree';
import { namesFormFields } from '@catalogue/foundation/form';
import { resolveLink, takesParagraphs } from './index';
import { effectiveItem, teaserFields } from '@shared/page-teasers';

const BUTTONS = new Set(['primary', 'secondary', 'text', 'light']);

interface Scope {
  props: Record<string, unknown>;
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
}

function evaluate(v: unknown, scope: Scope): unknown {
  if (!isBinding(v)) return v;
  const b = v as Binding;
  if ('$prop' in b) return scope.props[b.$prop];
  const item = scope.item ?? {};
  return Object.hasOwn(item, b.$item) ? item[b.$item] : (scope.fields?.[b.$item] as { default?: unknown } | undefined)?.default;
}

/** Mirrors the generated `has()` helper, on unresolved values. */
function shown(v: unknown, state: ProjectState): boolean {
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

interface Visit {
  /** Every node about to render, before its kind's own callback. */
  node?: (n: GraphNode, scope: Scope, reportId: string, inDef: boolean) => void;
  /**
   * A link node about to render; `inDef` when it is a component definition's node rather than the tree's own, and
   * `ownId` the id its markup carries.
   */
  link?: (n: GraphNode & { kind: 'link' }, scope: Scope, reportId: string, inDef: boolean, ownId: string | undefined) => void;
  /** Content of the slot named (as in `Scope.slots`) is shown again, by another slot of the same name. */
  again?: (slot: string) => void;
  /** An image node about to render. */
  image?: (n: GraphNode & { kind: 'image' }, scope: Scope, reportId: string) => void;
  /** A text node about to render. */
  text?: (n: GraphNode & { kind: 'text' }, scope: Scope, reportId: string, inDef: boolean) => void;
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
}

/** Where the walk is: the tree being read and, inside a component, the placement that put it there. */
interface Frame {
  tree: NodeTree;
  /** The definition being walked; none for a page or shell tree. */
  def?: ComponentDefinition;
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
function effectiveProps(state: ProjectState, def: ComponentDefinition, n: GraphNode & { kind: 'instance' }, scope: Scope): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(def.properties)) {
    const own = Object.hasOwn(n.props, name);
    const value = own ? evaluate(n.props[name], scope) : schema.default;
    // A page list's own (or default) items show the linked pages' values, which the generator fills in where the list
    // is placed. A list bound from the design around this one arrives as that design was given it.
    const filled = schema.type === 'list' && schema.pageTeaser && !(own && isBinding(n.props[name])) && Array.isArray(value);
    props[name] = filled ? (value as unknown[]).map((it) => (it && typeof it === 'object' ? effectiveItem(state, schema, it as Record<string, unknown>) : it)) : value;
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

/** Whether a `when` or `unless` condition holds in a scope, as the generated `{#if}` decides it. */
function holds(c: Condition, scope: Scope, state: ProjectState): boolean {
  return conditionHolds(c, evaluate(conditionRef(c), scope), (v) => shown(v, state));
}

/** Mirrors the generator's render conditions inside a definition: a node's own conditions, a repeat's list, a collapsing element's children. */
function nodeRenders(state: ProjectState, frame: Frame, n: GraphNode, seen: Set<string>): boolean {
  if (n.when && !holds(n.when, frame.scope, state)) return false;
  if (n.unless && holds(n.unless, frame.scope, state)) return false;
  if (n.kind === 'repeat') return shown(evaluate(n.list, frame.scope), state);
  return n.kind !== 'element' || !n.collapseEmpty || childRenders(state, frame, n, seen);
}

/** A collapsing element renders while any child does; with no children it stays. */
function childRenders(state: ProjectState, frame: Frame, n: GraphNode & { kind: 'element' }, seen: Set<string>): boolean {
  if (seen.has(n.id)) return true;
  seen.add(n.id);
  const kids = n.children.map((id) => frame.tree.nodes[id]).filter((k): k is GraphNode => !!k);
  return !kids.length || kids.some((k) => nodeRenders(state, frame, k, seen));
}

function walkRendered(state: ProjectState, tree: NodeTree, visit: Visit) {
  let frames = 0;
  // A slot a definition renders once per list item shows the same content, in the same frame, each time: it is
  // walked once per frame, which keeps nested placements of such a component from multiplying the walk.
  const slotsWalked = new WeakMap<Frame, Set<string>>();
  const walk = (frame: Frame, id: string, path: Set<string>) => {
    const n = frame.tree.nodes[id];
    const key = `${frame.n}:${id}`;
    if (!n || path.has(key)) return;
    if (frame.def && n.when && !holds(n.when, frame.scope, state)) return;
    if (frame.def && n.unless && holds(n.unless, frame.scope, state)) return;
    if (frame.def && n.kind === 'element' && n.collapseEmpty && !childRenders(state, frame, n, new Set())) return;
    const inner = new Set(path).add(key);
    const reportId = frame.reportId ?? n.id;
    const page = !frame.def;
    if (page) visit.enter?.(n);
    // A definition's root takes the id its placement gives it first (`so_id ?? anchor`).
    const ownId = frame.def && frame.def.tree?.rootIds[0] === id ? (frame.soId ?? n.anchor) : n.anchor;
    visit.node?.(n, frame.scope, reportId, !!frame.def);
    switch (n.kind) {
      case 'link':
        visit.link?.(n, frame.scope, reportId, !!frame.def, ownId);
        break;
      case 'image':
        visit.image?.(n, frame.scope, reportId);
        break;
      case 'text':
        visit.text?.(n, frame.scope, reportId, !!frame.def);
        break;
      case 'element':
        for (const c of n.children) walk(frame, c, inner);
        break;
      case 'repeat': {
        if (!frame.def) break;
        const items = evaluate(n.list, frame.scope);
        const schema = isBinding(n.list) && '$prop' in n.list ? frame.def.properties[n.list.$prop] : undefined;
        const fields = schema?.type === 'list' ? schema.fields : undefined;
        const list = schema?.type === 'list' && isBinding(n.list) && '$prop' in n.list ? n.list.$prop : undefined;
        const repeats = (frame.scope.repeats ?? 0) + 1;
        for (const item of Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []) {
          const occurrence = repeats === 1 && typeof item?.id === 'string' ? item.id : frame.scope.occurrence;
          const path = [...(frame.scope.path ?? []), String(item?.id ?? '')];
          for (const c of n.children) walk({ ...frame, scope: { ...frame.scope, item, fields, list, repeats, occurrence, path } }, c, inner);
        }
        break;
      }
      case 'slot': {
        const from = frame.slots;
        if (!from) break;
        const k = `${from.owner}:${n.slot}`;
        const supplier = from.frame.origin ?? from.frame;
        const walked = slotsWalked.get(supplier) ?? new Set<string>();
        const slot = JSON.stringify([from.frame.n, from.owner, n.slot]);
        if (walked.has(k)) {
          visit.again?.(slot);
          break;
        }
        slotsWalked.set(supplier, walked.add(k));
        // Content a slot inside a list shows once per item, though it is walked once, in the frame that supplied it.
        const multiple = from.frame.scope.multiple || frame.scope.multiple || (frame.scope.repeats ?? 0) > (from.frame.scope.repeats ?? 0);
        const target = { ...from.frame, origin: supplier, scope: { ...from.frame.scope, multiple, slots: [...(from.frame.scope.slots ?? []), slot] } };
        for (const c of from.content[n.slot] ?? []) walk(target, c, inner);
        break;
      }
      case 'instance': {
        const def = state.components[n.definitionId];
        if (!def || frame.defs.has(def.id)) break;
        const props = effectiveProps(state, def, n, frame.scope);
        if (def.kind === 'managed' && def.tree) {
          const trail = `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`;
          // A component inside a design reads the placement's own fields only through the bindings it is given.
          const forwarded: Record<string, PlacementField> = {};
          if (frame.def) for (const [k, v] of Object.entries(n.props)) {
            const f = placementField(v, frame.scope);
            if (f) forwarded[k] = f;
          }
          const carried = { multiple: frame.scope.multiple, slots: frame.scope.slots };
          const where = frame.def ? { forwarded, repeats: frame.scope.repeats, occurrence: frame.scope.occurrence, ...carried } : { placement: n.id, ...carried };
          const child: Frame = { tree: def.tree, def, scope: { props, trail, ...where }, soId: ownId, slots: { content: n.slots ?? {}, frame, owner: n.id }, reportId, n: ++frames, defs: new Set(frame.defs).add(def.id) };
          for (const r of def.tree.rootIds) walk(child, r, inner);
        } else {
          visit.code?.(def, props, reportId, `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`, n, frame.scope, !!frame.def);
          // Code that places `so_id` as an id (a converted section does, on its root) carries the placement's id.
          if (ownId && SO_ID_ATTR.test(def.source ?? '')) visit.id?.(ownId, reportId);
          // Code places its slot content where its own markup says; count all of it as rendered, as often as it likes.
          const placed = frame.scope.multiple ? frame : { ...frame, origin: frame.origin ?? frame, scope: { ...frame.scope, multiple: true } };
          for (const ids of Object.values(n.slots ?? {})) for (const c of ids) walk(placed, c, inner);
        }
        break;
      }
    }
    // An instance hands its id to the definition's root, which reports it there.
    if (ownId && n.kind !== 'instance' && n.kind !== 'repeat' && n.kind !== 'slot') visit.id?.(ownId, reportId);
    if (page) visit.leave?.(n);
  };
  const top: Frame = { tree, scope: { props: {} }, n: 0, defs: new Set() };
  for (const r of tree.rootIds) walk(top, r, new Set());
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
  if ('$prop' in b) return scope.placement ? { prop: b.$prop } : scope.forwarded?.[b.$prop];
  const id = scope.item?.id;
  if (!scope.list || typeof id !== 'string' || !id) return undefined;
  const list = scope.placement ? { prop: scope.list } : scope.forwarded?.[scope.list];
  return list && !list.itemId ? { prop: list.prop, itemId: id, field: b.$item } : undefined;
}

/** The schema of a placement's field: a property of the placed component, or a field of its list's items. */
function fieldSchema(state: ProjectState, tree: NodeTree, placementId: string, f: PlacementField): PropSchema | undefined {
  const inst = tree.nodes[placementId];
  const schema = inst?.kind === 'instance' ? state.components[inst.definitionId]?.properties[f.prop] : undefined;
  if (!f.itemId) return schema;
  return schema?.type === 'list' && f.field ? schema.fields[f.field] : undefined;
}

/** Whether a placement's list field is one a page list fills from the linked page while it is empty. */
function followsPageField(state: ProjectState, tree: NodeTree, placementId: string, f: PlacementField): boolean {
  if (!f.itemId || !f.field) return false;
  const list = fieldSchema(state, tree, placementId, { prop: f.prop });
  return list?.type === 'list' && !!list.pageTeaser && teaserFields(list.pageTeaser).some(([field]) => field === f.field);
}

const sameBinding = (a: unknown, b: unknown) => isBinding(a) && isBinding(b) && ('$prop' in a ? '$prop' in b && a.$prop === b.$prop : '$item' in b && a.$item === b.$item);

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
      const fields = new Set(reads.map((b) => placementField(b, scope)).filter((f): f is PlacementField => !!f).map((f) => key(f, reportId)));
      for (const f of fields) uses.set(f, (uses.get(f) ?? 0) + (scope.multiple ? 2 : 1));
    },
    link: (n, scope, reportId, inDef, ownId) => {
      const appearance = String(evaluate(n.appearance, scope) ?? '');
      const label = String(evaluate(n.label, scope) ?? '').trim();
      const link = evaluate(n.link, scope) as LinkValue | undefined;
      if (!BUTTONS.has(appearance) || !label || resolveLink(link, { state })) return;
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
}

/**
 * The shipped code component a definition is, or a header copied from it (Make unique keeps its code and
 * properties). A copied contact form is not: the project keeps its answers' submission keys only for the theme's own
 * form (`namesFormFields`), so a copy's fields are left to the inspector.
 */
function shippedCode(state: ProjectState, def: ComponentDefinition): string | undefined {
  if (def.owner === 'theme') return def.componentId === 'shell.header' || (def.componentId === 'contact.form' && namesFormFields(def)) ? def.componentId : undefined;
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

/**
 * What a shipped code component shows visitors, as property names (and `list.field` for list items), read from its
 * markup: the header's name only while it shows (not beside a logo set to show alone) and its action only with both
 * a label and somewhere to go; the form's words, never its service settings or the names answers are sent under.
 */
function shippedCodeShows(state: ProjectState, which: string, props: Record<string, unknown>): Set<string> {
  if (which === 'contact.form') return new Set(['eyebrow', 'heading', 'lead', 'fields.label', 'fields.placeholder', 'submitLabel', 'successMessage', 'errorMessage']);
  // As the header's markup reads them: `!!name && (showSiteName || !logo?.src)`, and `ctaLabel && ctaLink?.href`.
  const out = new Set(['links.label', 'links.link']);
  if (props.siteName && (props.showSiteName !== false || !shown(props.logo, state))) out.add('siteName');
  if (props.ctaLabel && resolveLink(props.ctaLink as LinkValue | undefined, { state })) (out.add('ctaLabel'), out.add('ctaLink'));
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
  walkRendered(state, tree, {
    text: (n, scope, reportId, inDef) => {
      const value = evaluate(n.text, scope);
      push({ nodeId: reportId, kind: 'text', value, ...from(n.text, 'text', scope, n.id, inDef), ...(n.rich ? { rich: true, richLinks: true } : {}) });
    },
    link: (n, scope, reportId, inDef) => {
      const link = evaluate(n.link, scope) as LinkValue | undefined;
      const label = evaluate(n.label, scope);
      const goes = !!resolveLink(link, { state });
      // A styled button with nowhere to go is left out of the site; a plain link still shows its words.
      if (!goes && BUTTONS.has(String(evaluate(n.appearance, scope) ?? ''))) return;
      push({ nodeId: reportId, kind: 'text', value: label, ...from(n.label, 'label', scope, n.id, inDef) });
      if (goes && isLinkValue(link)) push({ nodeId: reportId, kind: 'link', value: link, ...from(n.link, 'link', scope, n.id, inDef) });
    },
    code: (def, props, reportId, placement, n, scope, inDef) => {
      const which = shippedCode(state, def);
      const shows = which ? shippedCodeShows(state, which, props) : undefined;
      const rich = !takesParagraphs(def);
      // The placement's own field each property is: directly, or through the binding a design hands it.
      const fieldOf = (key: string): PlacementField | undefined => (inDef ? placementField(n.props[key], scope) : { prop: key });
      // A form's fields handed in by a design are edited on that design's list, where their submission keys are not kept.
      const keyless = (key: string) => which === 'contact.form' && inDef && key === 'fields';
      /** A field this code may read as a setting (or in ways its markup alone decides): never changed from here. */
      const guard = (f: PlacementField | undefined) => f && guarded.add(JSON.stringify([reportId, f.prop, f.itemId ?? null, f.field ?? null]));
      const add = (kind: 'text' | 'link', value: unknown, source: PlacementField | undefined, schema: PropSchema, at: string, custom: boolean) =>
        push({
          nodeId: reportId,
          kind,
          value,
          ...(source ? { source: { kind: 'prop', ...source } } : { at }),
          ...(custom ? { custom: true } : {}),
          ...(inDef ? { direct: false } : {}),
          ...(schema.type === 'richtext' ? { rich: true, richLinks: rich } : {})
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
          const itemId = typeof item.id === 'string' && item.id ? item.id : undefined;
          for (const f of Object.keys(schema.fields)) {
            const source = field && !field.itemId && itemId ? { prop: field.prop, itemId, field: f } : undefined;
            if (shows && !shows.has(`${key}.${f}`)) guard(source);
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
  // The header and footer only render when at least one page uses them.
  const shell = pages.some((p) => p.shell !== 'none') ? [state.site.shell.header, state.site.shell.footer] : [];
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

// ---------------------------------------------------------------------------
// Section links
// ---------------------------------------------------------------------------

/**
 * IDs every page has: the main landmark its layout renders (`<main id="main">`), and `top`, which browsers and the
 * static build both treat as the top of the page.
 */
const LAYOUT_IDS = ['main', 'top'];
const LITERAL_ID = /\sid\s*=\s*(?:"([^"{}\s]+)"|'([^'{}\s]+)')/g;
const codeIdCache = new WeakMap<ComponentDefinition, string[]>();

/** IDs a code component's markup writes out literally (`id="so-site-nav"`). IDs it computes cannot be known here. */
function literalIds(def: ComponentDefinition): string[] {
  let ids = codeIdCache.get(def);
  if (!ids) {
    ids = [...(def.source ?? '').matchAll(LITERAL_ID)].map((m) => m[1] ?? m[2]);
    codeIdCache.set(def, ids);
  }
  return ids;
}

/** Whether a page renders the shared header and footer. */
const hasShell = (page: PageDoc) => page.shell !== 'none';

/** The element IDs a tree renders. Code components add the IDs their markup writes out literally. */
function treeIds(state: ProjectState, trees: NodeTree[], out = new Set<string>()): Set<string> {
  const visit: Visit = { id: (id) => out.add(id), code: (def) => literalIds(def).forEach((id) => out.add(id)) };
  for (const tree of trees) walkRendered(state, tree, visit);
  return out;
}

/** How many elements render each ID on a page: an ID rendered twice cannot tell its sections apart. */
function idCounts(state: ProjectState, pageId: string): Map<string, number> {
  const out = new Map<string, number>();
  const page = state.pages[pageId];
  const visit: Visit = { id: (id) => out.set(id, (out.get(id) ?? 0) + 1) };
  if (page) for (const tree of hasShell(page) ? [state.site.shell.header, page, state.site.shell.footer] : [page]) walkRendered(state, tree, visit);
  return out;
}

/** The IDs the shared header and footer render, on every page that shows them. */
const shellIds = (state: ProjectState) => treeIds(state, [state.site.shell.header, state.site.shell.footer]);

/**
 * The element IDs a page's generated HTML will hold: its layout's, its own sections' and elements', and the shared
 * header and footer's when the page shows them. `shell` passes the header and footer's IDs when already known.
 */
export function pageIds(state: ProjectState, pageId: string, shell?: Set<string>): Set<string> {
  const out = new Set(LAYOUT_IDS);
  const page = state.pages[pageId];
  if (!page) return out;
  if (hasShell(page)) for (const id of shell ?? shellIds(state)) out.add(id);
  return treeIds(state, [page], out);
}

/** The IDs a page's elements render, the shared header and footer's included when it shows them: not the layout's. */
export function elementIds(state: ProjectState, pageId: string): Set<string> {
  const page = state.pages[pageId];
  if (!page) return new Set();
  return treeIds(state, hasShell(page) ? [state.site.shell.header, page, state.site.shell.footer] : [page]);
}

/** The IDs every page that shows the shared header and footer has: where their "on this page" links can go. */
export function sharedPageIds(state: ProjectState): Set<string> {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter((p) => p && hasShell(p));
  const shell = shellIds(state);
  const sets = pages.map((p) => pageIds(state, p.id, shell));
  if (!sets.length) return new Set(LAYOUT_IDS);
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
}

const isLinkValue = (v: unknown): v is LinkValue => !!v && typeof v === 'object' && typeof (v as LinkValue).type === 'string' && 'target' in (v as object);

/** The links in a rich text value, in order. */
function richLinks(value: unknown): RichSpan[] {
  const out: RichSpan[] = [];
  for (const b of toRichText(value)) for (const list of isListBlock(b) ? b.items : [b.spans]) for (const sp of list) if (sp.link) out.push(sp);
  return out;
}

/**
 * The property that names a link and decides whether it shows: `ctaLabel` for `ctaLink`, `linkLabel` for `link`.
 * Code reads it the way the generated components do, so a link whose label is empty does not render.
 */
export const labelKeyFor = (key: string) => (key.endsWith('Link') ? `${key.slice(0, -4)}Label` : `${key}Label`);

/**
 * Links a code component receives: its link properties, the link fields of its lists, and the links in its rich
 * text (unless it reads rich text as plain paragraphs). Whether its markup shows each one is up to its code; a
 * link paired with a label property is taken to show only when the label does, as the shipped header does.
 */
function codeLinks(def: ComponentDefinition, props: Record<string, unknown>, reportId: string, placement: string, out: RenderedLink[]) {
  const rich = !takesParagraphs(def);
  const take = (schemas: Record<string, PropSchema>, values: Record<string, unknown>, key: string, fallback: string, at: string) => {
    const v = values[key];
    const schema = schemas[key];
    if (schema?.type === 'richtext' && rich) richLinks(v).forEach((sp, i) => out.push({ link: sp.link!, label: sp.text.trim(), reportId, key: `${at}:${i}`, inText: true }));
    if (schema?.type !== 'link' || !isLinkValue(v)) return;
    const labelKey = labelKeyFor(key);
    const paired = schemas[labelKey]?.type === 'string';
    if (paired && !values[labelKey]) return;
    const label = String((paired ? values[labelKey] : undefined) ?? fallback).trim();
    out.push({ link: v, label, reportId, key: at, inText: false });
  };
  for (const [key, schema] of Object.entries(def.properties)) {
    take(def.properties, props, key, schema.label, `${placement}:${key}`);
    if (schema.type !== 'list' || !Array.isArray(props[key])) continue;
    (props[key] as Array<Record<string, unknown>>).forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const title = item[schema.titleField ?? 'label'];
      for (const [f, fs] of Object.entries(schema.fields)) take(schema.fields, item, f, typeof title === 'string' && title.trim() ? title : fs.label, `${placement}:${key}:${String(item.id ?? i)}:${f}`);
    });
  }
}

/** Every link a page or shell tree renders: buttons, links inside rich text, and the links code components receive. */
function renderedLinks(state: ProjectState, tree: NodeTree): RenderedLink[] {
  const out: RenderedLink[] = [];
  const at = (n: GraphNode, scope: Scope) => `${scope.trail ?? ''}:${n.id}:${String(scope.item?.id ?? '')}`;
  walkRendered(state, tree, {
    link: (n, scope, reportId) => {
      const link = evaluate(n.link, scope);
      if (isLinkValue(link)) out.push({ link, label: String(evaluate(n.label, scope) ?? '').trim(), reportId, key: at(n, scope), inText: false });
    },
    text: (n, scope, reportId) => {
      if (n.rich) richLinks(evaluate(n.text, scope)).forEach((sp, i) => out.push({ link: sp.link!, label: sp.text.trim(), reportId, key: `${at(n, scope)}:${i}`, inText: true }));
    },
    // A card links the whole container.
    node: (n, scope, reportId) => {
      if (n.kind !== 'element' || n.link === undefined) return;
      const link = evaluate(n.link, scope);
      if (isLinkValue(link)) out.push({ link, label: n.name ?? '', reportId, key: at(n, scope), inText: false });
    },
    code: (def, props, reportId, placement) => codeLinks(def, props, reportId, placement, out)
  });
  return out;
}

/** A link the shared header or footer shows that goes to a page, with the words visitors see on it. */
export type ShellPageLink = { part: 'header' | 'footer'; nodeId: string; label: string; pageId: string; anchor?: string };

/**
 * The header and footer links visitors see that go to any of `pageIds`, in order: menu items, buttons, links in
 * text and the links components inside them render. `nodeId` is the header or footer element that holds each one.
 */
export function shellPageLinks(state: ProjectState, pageIds: string[]): ShellPageLink[] {
  const out: ShellPageLink[] = [];
  for (const part of ['header', 'footer'] as const) {
    for (const r of renderedLinks(state, state.site.shell[part])) {
      if (r.link.type !== 'page' || !pageIds.includes(r.link.target)) continue;
      out.push({ part, nodeId: r.reportId, label: r.label, pageId: r.link.target, ...(r.link.anchor ? { anchor: r.link.anchor } : {}) });
    }
  }
  return out;
}


export interface SectionLinkIssue {
  /** Where the link is: a page or the shared header or footer. */
  owner: { kind: 'page' | 'shell'; id: string };
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
  /** The pages it shows on that lack the section, for a link to a section of the page it is on. */
  pages?: string[];
}

/**
 * Links that jump to a section the destination page will not have: a page link's section, checked on that page,
 * and an "on this page" link, checked on every page that shows it. A static build refuses these links, and a
 * visitor who follows one lands at the top of the page instead of the section.
 */
export function missingSectionLinks(state: ProjectState): SectionLinkIssue[] {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  const shellPages = pages.filter(hasShell);
  const shell = shellPages.length ? shellIds(state) : new Set<string>();
  const ids = new Map<string, Set<string>>();
  const idsOf = (pageId: string) => {
    if (!ids.has(pageId)) ids.set(pageId, pageIds(state, pageId, shell));
    return ids.get(pageId)!;
  };
  const sources: Array<{ owner: SectionLinkIssue['owner']; tree: NodeTree; on: PageDoc[] }> = [
    ...(shellPages.length
      ? [
          { owner: { kind: 'shell' as const, id: 'header' }, tree: state.site.shell.header, on: shellPages },
          { owner: { kind: 'shell' as const, id: 'footer' }, tree: state.site.shell.footer, on: shellPages }
        ]
      : []),
    ...pages.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p as NodeTree, on: [p] }))
  ];
  const out: SectionLinkIssue[] = [];
  const seen = new Set<string>();
  for (const src of sources)
    for (const { link, label, reportId, key, inText } of renderedLinks(state, src.tree)) {
      let issue: SectionLinkIssue | null = null;
      if (link.type === 'page' && link.anchor && Object.hasOwn(state.pages, link.target)) {
        if (!idsOf(link.target).has(link.anchor)) issue = { owner: src.owner, nodeId: reportId, label, inText, fragment: link.anchor, pageId: link.target };
      } else if (link.type === 'anchor' && link.target) {
        const fragment = link.target.replace(/^#/, '');
        const missing = src.on.filter((p) => !idsOf(p.id).has(fragment)).map((p) => p.id);
        if (missing.length) issue = { owner: src.owner, nodeId: reportId, label, inText, fragment, pages: missing };
      }
      // A link the walk reaches twice (a repeated slot, say) is reported once.
      const id = JSON.stringify([src.owner, reportId, key]);
      if (!issue || seen.has(id)) continue;
      seen.add(id);
      out.push(issue);
    }
  return out;
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
  const text = typeof v === 'string' ? v : Array.isArray(v) ? richTextToPlain(toRichText(v)) : '';
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
  const anchor = sectionAnchorFor(section.label, new Set([...anchorsInUse(state, owner), ...pageIds(state, pageId), ...reserved]));
  return { anchor, operations: [{ type: 'node.setContent', owner, nodeId, field: 'anchor', value: anchor }] };
}

