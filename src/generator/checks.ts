/**
 * Checks on what a page will actually show, evaluated with the same rules the generated components use.
 */
import type { Binding, ComponentDefinition, GraphNode, ImageValue, LinkValue, NodeTree, OwnerRef, PageDoc, ProjectState, PropSchema, ResponsiveStyles } from '@shared/types';
import { TEXT_TAGS, conditionHolds, conditionRef, isBinding, type Condition } from '@shared/types';
import { isListBlock, richTextToPlain, toRichText, type RichSpan } from '@shared/richtext';
import type { EditOperation } from '@shared/ops';
import { slugify } from '@shared/routes';
import { anchorCapable, anchorsInUse, displayName } from '@engine/tree';
import { formFieldSettingsHidden, namesFormFields, offersFormChoices } from '@catalogue/foundation/form';
import { isDraftPage, liveRedirects, resolveLink, takesParagraphs } from './index';
import { effectiveItem, teaserFields } from '@shared/page-teasers';
import { pagesShowing, partsShown, SHELL_PARTS, showsPart, type ShellPart } from '@shared/page-shell';
import { actionWraps } from './card-links';

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
  /** Shown through a code component's slot: counted as shown more than once, though its markup may show it once. */
  codeSlot?: boolean;
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
          const carried = { multiple: frame.scope.multiple, slots: frame.scope.slots, codeSlot: frame.scope.codeSlot };
          const where = frame.def ? { forwarded, repeats: frame.scope.repeats, occurrence: frame.scope.occurrence, ...carried } : { placement: n.id, ...carried };
          const child: Frame = { tree: def.tree, def, scope: { props, trail, ...where }, soId: ownId, slots: { content: n.slots ?? {}, frame, owner: n.id }, reportId, n: ++frames, defs: new Set(frame.defs).add(def.id) };
          for (const r of def.tree.rootIds) walk(child, r, inner);
        } else {
          visit.code?.(def, props, reportId, `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`, n, frame.scope, !!frame.def);
          // Code that places `so_id` as an id (a converted section does, on its root) carries the placement's id.
          if (ownId && SO_ID_ATTR.test(def.source ?? '')) visit.id?.(ownId, reportId);
          // Code places its slot content where its own markup says; count all of it as rendered, as often as it likes.
          const placed = frame.scope.multiple ? frame : { ...frame, origin: frame.origin ?? frame, scope: { ...frame.scope, multiple: true, codeSlot: true } };
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
  if (def.owner === 'theme')
    return def.componentId === 'shell.header' || def.componentId === 'data.table' || (def.componentId === 'contact.form' && namesFormFields(def)) ? def.componentId : undefined;
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

/** The trees a page renders, in order: the shared header when it shows it, its own content, the shared footer when it shows it. */
const renderedTrees = (state: ProjectState, page: PageDoc): NodeTree[] => [...(showsPart(page, 'header') ? [state.site.shell.header] : []), page, ...(showsPart(page, 'footer') ? [state.site.shell.footer] : [])];

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
export function pageIds(state: ProjectState, pageId: string, shell?: ShellIds): Set<string> {
  const out = new Set(LAYOUT_IDS);
  const page = state.pages[pageId];
  if (!page) return out;
  for (const part of partsShown(page)) for (const id of shell?.[part] ?? partIds(state, part)) out.add(id);
  return treeIds(state, [page], out);
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
  if (!pages.length) return new Set(LAYOUT_IDS);
  const shell = shellIds(state);
  const sets = pages.map((p) => pageIds(state, p.id, shell));
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
 * link paired with a label property is taken to show only when the label does, as the shipped header does. The
 * shipped header (`which`) shows its notice's link only beside the notice's words, which a label alone does not show.
 */
function codeLinks(def: ComponentDefinition, props: Record<string, unknown>, reportId: string, placement: string, out: RenderedLink[], which?: string) {
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
    if (which === 'shell.header' && key === 'noticeLink' && !headerNoticeLinkNamed(props)) continue;
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
    // A card links the whole container. One with an action follows its destination only while that action is `link`.
    node: (n, scope, reportId) => {
      if (n.kind !== 'element' || n.link === undefined) return;
      if (n.action !== undefined && n.action !== null && (!actionWraps(n) || evaluate(n.action, scope) !== 'link')) return;
      const link = evaluate(n.link, scope);
      if (isLinkValue(link)) out.push({ link, label: n.name ?? '', reportId, key: at(n, scope), inText: false });
    },
    code: (def, props, reportId, placement) => codeLinks(def, props, reportId, placement, out, shippedCode(state, def))
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
  const shell = shellIds(state);
  const ids = new Map<string, Set<string>>();
  const idsOf = (pageId: string) => {
    if (!ids.has(pageId)) ids.set(pageId, pageIds(state, pageId, shell));
    return ids.get(pageId)!;
  };
  // The header and footer are checked on the pages that show each: they can differ.
  const sources: Array<{ owner: SectionLinkIssue['owner']; tree: NodeTree; on: PageDoc[] }> = [
    ...SHELL_PARTS.map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: state.site.shell[part], on: pagesShowing(state, part) })).filter((src) => src.on.length > 0),
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

/** A link visitors would see on the published site that goes to a draft page. */
export interface DraftLink {
  /** Where the link is: a published page, or the shared header or footer shown on one. */
  owner: { kind: 'page' | 'shell'; id: string };
  /** The page or shell node that holds it (the instance, for links inside a component). */
  nodeId: string;
  /** The link's text, when it has one. */
  label: string;
  /** A link inside rich text. */
  inText: boolean;
  /** The draft page it goes to. */
  pageId: string;
  anchor?: string;
}

/** What the next website export publishes: the pages, in site order, the drafts it leaves out, and links to them. */
export interface PublicationPlan {
  published: PageDoc[];
  drafts: PageDoc[];
  draftLinks: DraftLink[];
}

/**
 * The draft a typed web address opens, when it is on the site's own public URL and names a draft's address or an
 * old address that leads to a draft. `withheld` maps those addresses, lowercased, to the draft.
 */
function draftAtAddress(state: ProjectState, target: string, withheld: Map<string, string>): { pageId: string; anchor?: string } | null {
  if (!state.site.baseUrl || !withheld.size) return null;
  let site: URL;
  let url: URL;
  try {
    site = new URL(state.site.baseUrl);
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
  const pageId = withheld.get((path.endsWith('/') ? path : path + '/').toLowerCase());
  if (!pageId) return null;
  const anchor = url.hash.replace(/^#/, '');
  return anchor ? { pageId, anchor } : { pageId };
}

/**
 * Which pages the website export publishes and which drafts it leaves out, with every link the published pages
 * show (the shared header or footer included, when a published page shows it) that goes to a draft: a link to
 * the page, or a typed address on the site's own public URL that opens it. Those links would lead visitors to a
 * page the website does not have, so the website export stops until they change. Links on a draft are not checked:
 * the draft is not published.
 */
export function publicationPlan(state: ProjectState): PublicationPlan {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  const published = pages.filter((p) => !isDraftPage(state, p));
  const drafts = pages.filter((p) => isDraftPage(state, p));
  const draftLinks: DraftLink[] = [];
  if (!drafts.length) return { published, drafts, draftLinks };
  const draftIds = new Set(drafts.map((p) => p.id));
  // The addresses visitors would find nothing at: each draft's own, and the old addresses that lead to one.
  const withheld = new Map<string, string>([
    ...drafts.map((p) => [p.route.toLowerCase(), p.id] as [string, string]),
    ...liveRedirects(state)
      .filter((r) => draftIds.has(r.page.id))
      .map((r) => [r.from.toLowerCase(), r.page.id] as [string, string])
  ]);
  const sources: Array<{ owner: DraftLink['owner']; tree: NodeTree }> = [
    ...published.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p as NodeTree })),
    // Each shared part, when a published page shows it: the header and footer can be on different pages.
    ...SHELL_PARTS.filter((part) => published.some((p) => showsPart(p, part))).map((part) => ({ owner: { kind: 'shell' as const, id: part }, tree: state.site.shell[part] }))
  ];
  const seen = new Set<string>();
  for (const src of sources)
    for (const { link, label, reportId, key, inText } of renderedLinks(state, src.tree)) {
      const to =
        link.type === 'page' && draftIds.has(link.target)
          ? { pageId: link.target, ...(link.anchor ? { anchor: link.anchor } : {}) }
          : link.type === 'url'
            ? draftAtAddress(state, link.target, withheld)
            : null;
      if (!to) continue;
      // A link the walk reaches twice (a repeated slot, say) is reported once.
      const id = JSON.stringify([src.owner, reportId, key]);
      if (seen.has(id)) continue;
      seen.add(id);
      draftLinks.push({ owner: src.owner, nodeId: reportId, label, inText, ...to });
    }
  return { published, drafts, draftLinks };
}

/**
 * A draft link in words an author can find it by: where it is (the page or Header/Footer, and the component holding
 * it), the words on it, and the draft it goes to. "Home · Feature cards: “See the winter stock” goes to Winter stock
 * preview (/winter-stock-preview/)".
 */
export function describeDraftLink(state: ProjectState, l: DraftLink): string {
  const tree = l.owner.kind === 'shell' ? state.site.shell[l.owner.id as 'header' | 'footer'] : state.pages[l.owner.id];
  const place = l.owner.kind === 'shell' ? (l.owner.id === 'header' ? 'Header' : 'Footer') : (state.pages[l.owner.id]?.title ?? 'A page');
  const node = tree?.nodes[l.nodeId];
  const where = node && node.kind === 'instance' ? `${place} · ${displayName(state, node)}` : place;
  const draft = state.pages[l.pageId];
  const to = draft ? `${draft.title} (${draft.route}${l.anchor ? `#${l.anchor}` : ''})` : 'a draft page';
  return `${where}: ${l.label ? `“${l.label}”` : l.inText ? 'a link in the text' : 'a link'} goes to ${to}`;
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
  const anchor = sectionAnchorFor(section.label, new Set([...anchorsInUse(state, owner), ...pageIds(state, pageId), ...reserved]));
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
  const schema = '$prop' in b ? (def && Object.hasOwn(def.properties, b.$prop) ? def.properties[b.$prop] : undefined) : scope.fields?.[b.$item];
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
            if (level && !isListBlock(block)) add({ level, text: block.spans.map((s) => s.text).join('').replace(/\s+/g, ' ').trim(), ...where, rich: true }, scope);
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
        // The shipped contact form and data table show their heading as an `<h2>`.
        if ((which !== 'contact.form' && which !== 'data.table') || typeof props.heading !== 'string' || !props.heading.trim()) return;
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
    return !!ref && (f.itemId ? '$item' in ref && ref.$item === f.field : '$prop' in ref && ref.$prop === f.prop);
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
