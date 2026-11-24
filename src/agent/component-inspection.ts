/**
 * inspect_component: one component shown on its own in the isolated preview (see @shared/component-preview) at phone
 * and desktop widths, in every variant option and with stress content (long text with a long unbroken word, links
 * and optional text left empty, one and five list items), and what those measurements found, deduplicated across
 * the cases. Planning and digesting are pure, so they are tested without a preview; the project is never changed.
 */
import type { ComponentPreviewResult, ComponentPreviewSpec, ComponentPreviewStep } from '@shared/component-preview';
import type { ComponentDefinition, Condition, GraphNode, ListItem, OwnerRef, ProjectState, ScalarPropSchema } from '@shared/types';
import { conditionRef, isBinding, isBindingRef, isComparison } from '@shared/types';
import { axesOf } from '@shared/variants';
import { catalogueComponent } from '@catalogue/index';
import { defaultProps } from '@engine/install';
import { enclosingRepeatProp, findParent, getTree } from '@engine/tree';

/** The widths a component is measured at, as inspect_layout names them. */
export const INSPECT_WIDTHS = { phone: 390, desktop: 1280 } as const;
type Viewport = keyof typeof INSPECT_WIDTHS;
const VIEWPORTS = Object.keys(INSPECT_WIDTHS) as Viewport[];
/** Cases measured in one call (each at both widths); the rest are measured by calling again from `next`. */
export const MAX_CASES = 8;
/** How long one call's measurements may take before the cases not yet started are left for the next call. */
export const INSPECT_COMPONENT_BUDGET_MS = 90_000;

/** A word no line can break, then ordinary words, so a short length limit still leaves the word. */
const LONG_WORD = 'PneumonoultramicroscopicsilicovolcanoconiosisSupercalifragilistic';
const LONG_TEXT = `${LONG_WORD} and a much longer line of text than this component was designed for, written to see how it copes when an author has a great deal more to say than the sample did`;
/** Where a link left empty in the sample goes while the links are shown. */
const SAMPLE_LINK = { type: 'url', target: 'https://example.com/' } as const;
const NO_LINK = { type: 'none', target: '' } as const;
/** List lengths tried. */
const ITEM_COUNTS = [1, 5];

/** A gap between two stacked elements at least this wide that falls to `COLLAPSED_PX` or less counts as collapsed. */
const SPACED_PX = 8;
const COLLAPSED_PX = 1;
/** How many elements may have gone from between two that now touch. */
const MAX_REMOVED = 4;
/** Findings listed in one result; the rest are counted. */
const MAX_FINDINGS = 30;
const MAX_TEXT = 80;

/** What measurements report about a component: layout and readability defects. Image loading is a page matter. */
const KINDS = new Set(['horizontal-overflow', 'element-overflow', 'text-overflow', 'low-contrast', 'overlap', 'clipped-text', 'small-tap-target']);

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const clone = <T>(v: T): T => structuredClone(v);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface InspectArgs {
  definitionId?: string;
  componentId?: string;
  owner?: OwnerRef;
  nodeId?: string;
}

/** The component to measure, how the preview is asked for it, and the content every case starts from. */
export interface InspectTarget {
  def: ComponentDefinition;
  /** A project definition, or a theme component the project does not have yet (shown as adding it would make it). */
  select: { definitionId: string } | { componentId: string };
  /** The placement whose own content and variant choices are the starting point, when one was named. */
  placement?: { owner: OwnerRef; nodeId: string };
  /** Starting values: the placement's own (bindings left out), over the definition's defaults. */
  values: Record<string, unknown>;
  /** The placement's own variant choices (bound ones left out). */
  variants: Record<string, string>;
  /** What the sample leaves out, for the result. */
  notes: string[];
}

/** A code component's markup says nothing the sweep can read about which text is optional. */
const codeNote = (def: ComponentDefinition) => (def.kind === 'code' ? ['A code component does not say which of its text is optional, so only its links (if it has any) were left empty.'] : []);

/** The component named by exactly one of a definition ID, a theme component ID, or a placement (owner and nodeId). */
export function resolveInspectTarget(state: ProjectState, a: InspectArgs): InspectTarget | { error: string } {
  const named = [a.definitionId !== undefined, a.componentId !== undefined, a.owner !== undefined || a.nodeId !== undefined].filter(Boolean).length;
  if (named !== 1) return { error: 'Name one component: definitionId, componentId, or a placement (owner and nodeId).' };
  if (a.definitionId !== undefined) {
    const def = own(state.components, a.definitionId);
    if (!def) return { error: `The project has no component "${a.definitionId}". read_project with sections ["components"] lists them.` };
    return { def, select: { definitionId: def.id }, values: defaultProps(def), variants: {}, notes: codeNote(def) };
  }
  if (a.componentId !== undefined) {
    const source = catalogueComponent(state.site.themeId, a.componentId);
    if (!source) return { error: `The theme has no component "${a.componentId}". search_components finds them.` };
    // The project's copy, with any changes made to it, when it has one.
    const installed = own(state.components, source.id);
    const def = installed ?? source;
    return { def, select: installed ? { definitionId: installed.id } : { componentId: a.componentId }, values: defaultProps(def), variants: {}, notes: codeNote(def) };
  }
  if (!a.owner || !a.nodeId) return { error: 'A placement needs both owner and nodeId.' };
  let node: GraphNode | undefined;
  try {
    node = own(getTree(state, a.owner).nodes, a.nodeId);
  } catch {
    return { error: `There is no ${a.owner.kind} "${a.owner.id}".` };
  }
  if (!node) return { error: `There is no node "${a.nodeId}" on ${a.owner.kind} "${a.owner.id}".` };
  if (node.kind !== 'instance') return { error: `Node "${a.nodeId}" is not a placed component. Name a component placement.` };
  const def = own(state.components, node.definitionId);
  if (!def) return { error: `The component placed at "${a.nodeId}" is missing from the project.` };
  const values = defaultProps(def);
  const bound: string[] = [];
  for (const [name, v] of Object.entries(node.props ?? {})) {
    const schema = own(def.properties, name);
    if (!schema || (schema.type === 'list' && schema.feed)) continue;
    if (isBinding(v)) bound.push(schema.label || name);
    else values[name] = clone(v);
  }
  const variants: Record<string, string> = {};
  const axes = new Map(axesOf(def));
  for (const [axis, v] of Object.entries(node.variants ?? {})) {
    const a = axes.get(axis);
    if (a && typeof v === 'string' && Object.hasOwn(a.options, v)) variants[axis] = v;
    else if (a && isBindingRef(v)) bound.push(`the ${a.label} variant`);
  }
  const notes = bound.length ? [`Bound to its surroundings, so shown with the default: ${bound.join(', ')}.`] : [];
  // The preview shows a component's own content and variants; what a placement adds around them is not in it.
  const slotted = Object.values(node.slots ?? {}).some((ids) => Array.isArray(ids) && ids.length);
  const styled = Object.keys(node.overrides ?? {}).length || Object.keys(node.itemOverrides ?? {}).length || Object.keys(node.styles ?? {}).length;
  if (slotted || styled) notes.push(`Shown without ${[slotted ? 'what is placed in its slots' : '', styled ? 'its own style changes' : ''].filter(Boolean).join(' or ')}; inspect_layout measures it on its page.`);
  return { def, select: { definitionId: def.id }, placement: { owner: a.owner, nodeId: a.nodeId }, values, variants, notes: [...notes, ...codeNote(def)] };
}

/** One combination of variant options and content measured at every width. */
export interface InspectCase {
  /** Short and unique, as results name it: "defaults", "tone=inverse", "long text". */
  label: string;
  variants: Record<string, string>;
  /** Every property value the preview is given (the starting values, changed as the case says). */
  props: Record<string, unknown>;
  /** For a case with content left empty: the case with it shown that its spacing is compared with. */
  control?: string;
}

/** Each scalar value in `values` (top-level, object fields, list item fields), with its schema, to read or replace. */
function eachScalar(def: ComponentDefinition, values: Record<string, unknown>, fn: (schema: ScalarPropSchema, value: unknown, set: (v: unknown) => void, where: { prop: string; field?: string; list?: boolean }) => void) {
  for (const [name, schema] of Object.entries(def.properties)) {
    if (!Object.hasOwn(values, name)) continue;
    const v = values[name];
    if (schema.type === 'object') {
      if (!isRecord(v)) continue;
      for (const [field, f] of Object.entries(schema.fields)) if (Object.hasOwn(v, field)) fn(f, v[field], (x) => (v[field] = x), { prop: name, field });
    } else if (schema.type === 'list') {
      if (schema.feed || !Array.isArray(v)) continue;
      for (const item of v) if (isRecord(item)) for (const [field, f] of Object.entries(schema.fields)) if (Object.hasOwn(item, field)) fn(f, item[field], (x) => (item[field] = x), { prop: name, field, list: true });
    } else if (schema.type !== 'table') fn(schema, v, (x) => (values[name] = x), { prop: name });
  }
}

const isEmptyLink = (v: unknown) => !isRecord(v) || v.type === 'none' || v.type === undefined || !String(v.target ?? '').trim();
const isEmptyText = (v: unknown) => (typeof v === 'string' ? !v.trim() : Array.isArray(v) ? !v.length : v === undefined || v === null);

/** Text a visitor never reads: an address, a key or a name forms send answers under. Long text there breaks the component instead of testing it. */
const MACHINE_LABEL = /\b(url|web address|video address|endpoint|access key|api key|id|slug|anchor|embed|field name|form name)\b/i;
const MACHINE_VALUE = /^((https?:\/\/|mailto:|tel:)\S+|\/\S*|#[\w-]+)$/i;
const isMachineText = (schema: ScalarPropSchema, value: unknown) => MACHINE_LABEL.test(schema.label ?? '') || (typeof value === 'string' && MACHINE_VALUE.test(value.trim()));

/** Where a field is, as optionalContent names it: "name", "name.field", or "list[]field" for a list item's field. */
const fieldKey = (w: { prop: string; field?: string; list?: boolean }) => (w.list ? `${w.prop}[]${w.field}` : w.field ? `${w.prop}.${w.field}` : w.prop);

/**
 * The content a design shows only when it is there (a `when` or `unless` testing that a value is present, or that it
 * is not the empty string), keyed as fieldKey names it. A list item's field is named with the list that repeats it.
 */
function optionalContent(def: ComponentDefinition): Set<string> {
  const out = new Set<string>();
  const add = (nodeId: string, c: Condition | undefined, test: 'when' | 'unless') => {
    if (!c) return;
    // A comparison with the empty string tests presence too: `when` it is not empty, `unless` it is.
    if (isComparison(c) && !(test === 'when' ? 'ne' in c && c.ne === '' : 'eq' in c && c.eq === '')) return;
    const ref = conditionRef(c);
    if (!ref || !isBinding(ref)) return;
    if ('$item' in ref) {
      const list = enclosingRepeatProp(def, nodeId);
      if (list) out.add(`${list}[]${ref.$item}`);
    } else out.add(ref.field ? `${ref.$prop}.${ref.field}` : ref.$prop);
  };
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    add(n.id, n.when, 'when');
    add(n.id, n.unless, 'unless');
  }
  return out;
}

/** An empty value of a text or link field, or undefined for a field that is never left empty here. */
function emptied(schema: ScalarPropSchema): unknown {
  if (schema.type === 'string') return '';
  if (schema.type === 'richtext') return [];
  if (schema.type === 'link') return { ...NO_LINK };
  return undefined;
}

const cutTo = (schema: ScalarPropSchema, text: string) => (schema.type === 'string' && schema.maxLength !== undefined ? text.slice(0, schema.maxLength) : text);
const SAMPLE_TEXT = 'Sample text';

/**
 * Every empty link given somewhere to go and every empty piece of text a short sample, so that what a design shows
 * only with content (a button needs a label and a destination) is shown.
 */
function fill(def: ComponentDefinition, values: Record<string, unknown>): void {
  eachScalar(def, values, (s, v, set) => {
    if (s.type === 'link') {
      if (isEmptyLink(v)) set({ ...SAMPLE_LINK });
    } else if ((s.type === 'string' || s.type === 'richtext') && isEmptyText(v) && !isMachineText(s, v)) set(s.type === 'string' ? cutTo(s, SAMPLE_TEXT) : [{ type: 'p', spans: [{ text: `${SAMPLE_TEXT}.` }] }]);
  });
}

/**
 * Every case to measure, in the order they are measured: the starting point; the stress cases, all from the
 * starting content with every link set and empty text filled (so what shows only with content is measured too):
 * that filled content, then links and optional text left empty, long text, one and five list items; and each other
 * option of every variant axis on its own. Cases that would show the same thing are measured once, under both names.
 */
export function planComponentInspection(target: InspectTarget): InspectCase[] {
  const { def } = target;
  const cases: Array<InspectCase & { controlOf?: InspectCase }> = [];
  const byKey = new Map<string, InspectCase & { controlOf?: InspectCase }>();
  /** The case kept: `c`, or the one already planned that shows the same thing, now also named for `c`. */
  const add = (c: InspectCase & { controlOf?: InspectCase }) => {
    const key = JSON.stringify([c.variants, c.props]);
    const same = byKey.get(key);
    if (!same) {
      cases.push(c);
      byKey.set(key, c);
      return c;
    }
    if (!same.label.split(' + ').includes(c.label)) same.label = `${same.label} + ${c.label}`;
    if (c.controlOf && c.controlOf !== same) same.controlOf ??= c.controlOf;
    return same;
  };
  add({ label: target.placement ? 'as placed' : 'defaults', variants: { ...target.variants }, props: clone(target.values) });

  // Every link set and empty text filled, then links and optional text left empty: what disappears must not take
  // the spacing with it.
  const shown = clone(target.values);
  fill(def, shown);
  const filled = add({ label: 'filled', variants: { ...target.variants }, props: shown });
  const optional = optionalContent(def);
  const empty = clone(shown);
  let empties = 0;
  eachScalar(def, empty, (s, v, set, w) => {
    if (s.type !== 'link' && !optional.has(fieldKey(w))) return;
    const e = emptied(s);
    if (e === undefined || JSON.stringify(e) === JSON.stringify(v)) return;
    set(e);
    empties++;
  });
  if (empties) add({ label: 'empty', variants: { ...target.variants }, props: empty, controlOf: filled });

  // Long text everywhere a visitor reads text.
  const long = clone(shown);
  let texts = 0;
  eachScalar(def, long, (s, v, set) => {
    if ((s.type !== 'string' && s.type !== 'richtext') || isMachineText(s, v)) return;
    set(s.type === 'string' ? cutTo(s, LONG_TEXT) : [{ type: 'p', spans: [{ text: LONG_TEXT }] }]);
    texts++;
  });
  if (texts) add({ label: 'long text', variants: { ...target.variants }, props: long });

  // One and five items in every list an author fills, within its limits, each with content enough to show.
  for (const count of ITEM_COUNTS) {
    const props = clone(shown);
    const counts = new Set<number>();
    let limited = false;
    for (const [name, schema] of Object.entries(def.properties)) {
      if (schema.type !== 'list' || schema.feed) continue;
      const items = Array.isArray(props[name]) ? (props[name] as ListItem[]) : [];
      const n = Math.min(schema.max ?? Infinity, Math.max(schema.min ?? 0, count));
      if (n !== count) limited = true;
      if (n === items.length) continue;
      // Copies of the items there are, or items of default values when there are none; given IDs of their own.
      const blank = Object.fromEntries(Object.entries(schema.fields).map(([k, f]) => [k, clone(f.default)]));
      props[name] = Array.from({ length: n }, (_, i) => ({ ...(items.length ? clone(items[i % items.length]) : clone(blank)), id: `sweep${i + 1}` }));
      counts.add(n);
    }
    if (!counts.size) continue;
    fill(def, props);
    // Named by the count asked for, and so told apart from the other count's case, whatever a list's limits made of it.
    add({ label: `${count} item${count === 1 ? '' : 's'}${limited ? ' (within limits)' : ''}`, variants: { ...target.variants }, props });
  }

  // Each other option of each axis, the rest as they start, with the content filled.
  for (const [axis, a] of axesOf(def)) {
    const current = target.variants[axis] ?? a.default;
    for (const option of Object.keys(a.options)) if (option !== current) add({ label: `${axis}=${option}`, variants: { ...target.variants, [axis]: option }, props: shown });
  }
  // Named once every merge is done.
  return cases.map(({ controlOf, ...c }) => (controlOf ? { ...c, control: controlOf.label } : c));
}

/** The preview requests for `cases`: each case at phone width and then desktop, in one frame, so it is prepared once. */
export function inspectionSteps(target: InspectTarget, cases: InspectCase[]): ComponentPreviewStep[] {
  return cases.flatMap((c) => {
    const spec: ComponentPreviewSpec = { ...target.select, ...(Object.keys(c.variants).length ? { variants: c.variants } : {}), props: c.props };
    return VIEWPORTS.map((v) => ({ spec, width: INSPECT_WIDTHS[v], frame: 0 }));
  });
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** Where in the component's design a finding is: a node of its design and the part it belongs to. */
export interface ComponentLocation {
  nodeId: string;
  partId?: string;
  /** The part around the element measured, or the component placed in the design that holds it. */
  match?: 'nearest-part';
}

interface Desc {
  ctx?: unknown;
  node?: unknown;
  inside?: unknown;
}

const partIdFor = (def: ComponentDefinition, nodeId: string) => Object.entries(def.parts ?? {}).find(([, p]) => p.nodeId === nodeId)?.[0];

function nearestPart(def: ComponentDefinition, nodeId: string): string | undefined {
  let partId = partIdFor(def, nodeId);
  const seen = new Set<string>();
  for (let at = def.tree && findParent(def.tree, nodeId); !partId && at?.parentId && !seen.has(at.parentId); at = findParent(def.tree!, at.parentId)) {
    seen.add(at.parentId);
    partId = partIdFor(def, at.parentId);
  }
  return partId;
}

/**
 * The node of the design an element measured in the preview belongs to (see previewCtx in the generator): one of the
 * design's own, or inside a component placed in it. Undefined for markup the design does not address (a code
 * component's own), which is the component as a whole.
 */
export function componentLocation(def: ComponentDefinition, desc: Desc | undefined): ComponentLocation | undefined {
  if (!desc || typeof desc.ctx !== 'string' || typeof desc.node !== 'string' || !def.tree) return undefined;
  const [head, ...path] = desc.ctx.split('|');
  if (!head.startsWith('preview:') || path[0] !== 'preview') return undefined;
  const nodeId = path.length > 1 ? path[1] : desc.node;
  if (!Object.hasOwn(def.tree.nodes, nodeId)) return undefined;
  const partId = nearestPart(def, nodeId);
  const exact = path.length === 1 && !desc.inside && partId !== undefined && partId === partIdFor(def, nodeId);
  return { nodeId, ...(partId ? { partId } : {}), ...(exact || !partId ? {} : { match: 'nearest-part' as const }) };
}

/**
 * Two stacked elements one after the other and the space between them, as the bridge reports them (`gaps`). Each is
 * named by where it rendered, the list items it is in (the same in two cases planned from the same content), and
 * which of the elements rendered there it is (`n` of `of`, in document order).
 */
interface GapEnd {
  ctx: string;
  node: string;
  items: string;
  n: number;
  of: number;
}
interface Gap {
  a: GapEnd;
  b: GapEnd;
  gap: number;
}

export interface ComponentFinding {
  kind: string;
  message: string;
  text?: string;
  at?: ComponentLocation;
  with?: { at?: ComponentLocation; text?: string };
  /** The cases and widths it was found in: "long text: phone, desktop". */
  in: string[];
}

export interface ComponentDigest {
  /** Measurements that came back (a case at one width). */
  measured: number;
  content: Record<string, unknown>;
}

const cut = (s: unknown, max = MAX_TEXT) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** An element measured, as the same element in every case: where it rendered, not which list item it showed. */
const descKey = (d: Desc | undefined) => (d && typeof d.ctx === 'string' && typeof d.node === 'string' ? `${d.ctx}|${d.node}${d.inside ? '|inside' : ''}` : '');

const endKey = (e: GapEnd) => `${e.ctx}\u0000${e.node}\u0000${e.items}\u0000${e.n}`;
const baseKey = (e: GapEnd) => `${e.ctx}\u0000${e.node}\u0000${e.items}`;

/**
 * The stacked gaps a measurement reported (null when it has none: not asked for), and whether the list stops short.
 * A short list still compares truly as far as it goes: two elements touching are next to each other in it.
 */
const gapsOf = (r: ComponentPreviewResult | undefined): { gaps: Gap[]; incomplete: boolean } | null => {
  const report = r?.report as { gaps?: unknown; gapsIncomplete?: unknown } | undefined;
  const g = report?.gaps;
  const end = (e: unknown): e is GapEnd => isRecord(e) && typeof e.ctx === 'string' && typeof e.node === 'string' && typeof e.items === 'string' && Number.isInteger(e.n) && Number.isInteger(e.of);
  return Array.isArray(g) ? { gaps: (g as Gap[]).filter((x) => isRecord(x) && end(x.a) && end(x.b) && Number.isFinite(x.gap)), incomplete: report?.gapsIncomplete === true } : null;
};

/**
 * Elements that touch in `empty` but had space between them in `control`, where whatever stood between them has gone:
 * spacing carried by the content that was left empty. An element rendered a different number of times in the two
 * (a repeated row outside a list, one of them gone) is skipped, since its position no longer says which one it is.
 */
function collapsedGaps(control: Gap[], empty: Gap[]): Array<{ a: GapEnd; b: GapEnd; before: number; after: number }> {
  const next = new Map(control.map((g) => [endKey(g.a), g]));
  const totals = new Map<string, number>();
  for (const g of control) for (const e of [g.a, g.b]) totals.set(baseKey(e), e.of);
  const still = new Set(empty.flatMap((g) => [endKey(g.a), endKey(g.b)]));
  const out: Array<{ a: GapEnd; b: GapEnd; before: number; after: number }> = [];
  for (const g of empty) {
    if (g.gap > COLLAPSED_PX || totals.get(baseKey(g.a)) !== g.a.of || totals.get(baseKey(g.b)) !== g.b.of) continue;
    // Follow the control from a to b, through what stood between them and is gone now.
    let at = endKey(g.a);
    let smallest = Infinity;
    for (let hop = 0; hop <= MAX_REMOVED; hop++) {
      const step = next.get(at);
      if (!step) break;
      smallest = Math.min(smallest, step.gap);
      if (endKey(step.b) === endKey(g.b)) {
        if (smallest >= SPACED_PX) out.push({ a: g.a, b: g.b, before: Math.round(smallest), after: Math.round(g.gap) });
        break;
      }
      // Something still laid out in the empty case stood between them: they were not neighbours with it gone.
      if (still.has(endKey(step.b))) break;
      at = endKey(step.b);
    }
  }
  return out;
}

/** Where a sweep cut short goes on from: never between an empty case and the case it is compared with. */
export function resumeAt(cases: InspectCase[], index: number): number {
  let i = index;
  while (i > 0 && i < cases.length && (cases[i].control === cases[i - 1].label || cases[i - 1].control === cases[i].label)) i--;
  return i;
}

/**
 * What the measurements of `cases` found: each defect once, with the cases and widths it showed in, the
 * measurements that failed, and what is left to measure. A component with nothing found gets a one-line summary.
 * `results` answer the steps of inspectionSteps in order; a short list means the rest ran out of time. `all` is the
 * whole plan the cases are a window of, from `window.offset`.
 */
export function digestComponentInspection(target: InspectTarget, cases: InspectCase[], results: ComponentPreviewResult[], window: { offset: number; total: number; all?: InspectCase[] }): ComponentDigest {
  const { def } = target;
  const groups = new Map<string, ComponentFinding & { seen: Map<string, Set<Viewport>> }>();
  const failures = new Map<string, { error: string; seen: Map<string, Set<Viewport>> }>();
  const runtime = new Map<string, { error: string; seen: Map<string, Set<Viewport>> }>();
  const note = (into: Map<string, Set<Viewport>>, label: string, v: Viewport) => {
    if (!into.has(label)) into.set(label, new Set());
    into.get(label)!.add(v);
  };
  const noteIn = (into: Map<string, { error: string; seen: Map<string, Set<Viewport>> }>, error: string, label: string, v: Viewport) => {
    if (!into.has(error)) into.set(error, { error: cut(error, 300), seen: new Map() });
    note(into.get(error)!.seen, label, v);
  };
  const where = (seen: Map<string, Set<Viewport>>) => [...seen].map(([label, vs]) => `${label}: ${VIEWPORTS.filter((v) => vs.has(v)).join(', ')}`);
  const totals = { unverified: 0, incomplete: false };
  let measured = 0;
  let reached = 0;
  const steps = cases.length * VIEWPORTS.length;
  const gaps = new Map<string, { gaps: Gap[]; incomplete: boolean } | null>();
  /** The widths each case was measured at without failing. */
  const widthsMeasured = new Map<string, Set<Viewport>>();

  const record = (f: Omit<ComponentFinding, 'in'>, label: string, v: Viewport, key: string) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...f, in: [], seen: new Map() }));
    note(g.seen, label, v);
  };

  for (let i = 0; i < steps; i++) {
    const c = cases[Math.floor(i / VIEWPORTS.length)];
    const v = VIEWPORTS[i % VIEWPORTS.length];
    const r = results[i];
    if (!r) continue;
    reached++;
    const report = r.report as { issues?: unknown; checks?: Record<string, { checked?: number; failed?: number; unverified?: number; incomplete?: boolean }>; runtimeErrors?: unknown; error?: unknown } | undefined;
    // Without its readability counts a measurement did not run every check: it is never read as a clean one.
    const why = r.state !== 'ready' ? (r.error ?? 'The component could not be measured.') : !report || typeof report !== 'object' ? 'The component could not be measured.' : report.error ? report.error : !Array.isArray(report.issues) || !isRecord(report.checks) ? 'The measurement did not run every check.' : null;
    if (why) {
      noteIn(failures, String(why), c.label, v);
      continue;
    }
    measured++;
    note(widthsMeasured, c.label, v);
    gaps.set(`${c.label}\u0000${v}`, gapsOf(r));
    for (const check of Object.values(report!.checks ?? {})) {
      totals.unverified += Number(check?.unverified) || 0;
      if (check?.incomplete) totals.incomplete = true;
    }
    for (const issue of report!.issues as Array<{ kind?: unknown; message?: unknown; text?: unknown; desc?: Desc; with?: { desc?: Desc; text?: unknown } }>) {
      if (!issue || !KINDS.has(String(issue.kind))) continue;
      const kind = String(issue.kind);
      const at = componentLocation(def, issue.desc);
      const other = issue.with && typeof issue.with === 'object' ? { at: componentLocation(def, issue.with.desc), text: issue.with.text } : undefined;
      // The same element in every case, by where it rendered (or what it says, for markup with no address); an
      // overlap is one finding whichever of its two boxes the bridge named first.
      // Markup inside a code component shares its wrapper's address: what it says tells its elements apart.
      const key1 = (d: Desc | undefined, text: unknown, located: boolean) => (located && !d?.inside ? descKey(d) : `${descKey(d)}|text:${cut(text, 30)}`);
      const self = key1(issue.desc, issue.text, !!at);
      const partner = other ? key1(issue.with!.desc, other.text, !!other.at) : '';
      const key = [kind, ...(kind === 'overlap' ? [self, partner].sort() : [self, partner])].join('\u0000');
      record(
        {
          kind,
          message: String(issue.message ?? kind),
          ...(issue.text ? { text: cut(issue.text) } : {}),
          ...(at ? { at } : {}),
          ...(other ? { with: { ...(other.at ? { at: other.at } : {}), ...(other.text ? { text: cut(other.text) } : {}) } } : {})
        },
        c.label,
        v,
        key
      );
    }
    for (const err of Array.isArray(report!.runtimeErrors) ? report!.runtimeErrors : []) noteIn(runtime, String(err), c.label, v);
  }

  // Spacing that went with content left empty, against the same case with the content shown.
  const unchecked: string[] = [];
  for (const c of cases) {
    if (!c.control) continue;
    for (const v of VIEWPORTS) {
      const empty = gaps.get(`${c.label}\u0000${v}`);
      if (empty === undefined) continue;
      const control = gaps.get(`${c.control}\u0000${v}`);
      if (!control || !empty) {
        unchecked.push(v);
        continue;
      }
      if (control.incomplete || empty.incomplete) unchecked.push(v);
      for (const hit of collapsedGaps(control.gaps, empty.gaps)) {
        const at = componentLocation(def, hit.a);
        const other = componentLocation(def, hit.b);
        record(
          {
            kind: 'spacing-collapse',
            message: `With the links and optional text empty, these two touch (${hit.after}px apart); with them shown there was at least ${hit.before}px between them. If they should not touch, space them with their container's gap rather than with the content that can be empty.`,
            ...(at ? { at } : {}),
            with: other ? { at: other } : {}
          },
          c.label,
          v,
          ['spacing-collapse', `${hit.a.ctx}|${hit.a.node}`, `${hit.b.ctx}|${hit.b.node}`].join('\u0000')
        );
      }
    }
  }

  const all = [...groups.values()].map(({ seen, ...f }) => ({ ...f, in: where(seen) }));
  // At most MAX_FINDINGS, keeping the first of every kind found, in the order found.
  const keep = new Set<ComponentFinding>();
  const kinds = new Set<string>();
  for (const f of all) if (!kinds.has(f.kind)) kinds.add(f.kind), keep.add(f);
  for (const f of all) if (keep.size < MAX_FINDINGS) keep.add(f);
  const findings = all.filter((f) => keep.has(f));
  const failed = [...failures.values()].map(({ error, seen }) => ({ error, in: where(seen) }));
  const errors = [...runtime.values()].map(({ error, seen }) => ({ error, in: where(seen) }));
  // The cases not reached in time are measured next, from the first of them (with the case it is compared with).
  const complete = Math.floor(reached / VIEWPORTS.length);
  const list = window.all ?? cases;
  const first = window.all ? 0 : window.offset;
  const resumed = resumeAt(list, window.offset + complete - first) + first;
  // Measured again with the case it is compared with, unless that would start this same window over: then on, so
  // a sweep always gets further (its spacing then goes unchecked).
  const nextOffset = reached >= steps ? window.offset + cases.length : resumed > window.offset || !complete ? Math.max(window.offset, resumed) : window.offset + complete;
  const remaining = window.total - nextOffset;
  const done = cases.filter((c) => widthsMeasured.get(c.label)?.size === VIEWPORTS.length).map((c) => c.label);
  const halves = cases.flatMap((c) => {
    const w = widthsMeasured.get(c.label);
    return w && w.size < VIEWPORTS.length ? [`"${c.label}" was measured at ${[...w].join(' and ')} width only.`] : [];
  });

  const parts: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const widths = `phone (${INSPECT_WIDTHS.phone}px) and desktop (${INSPECT_WIDTHS.desktop}px) width`;
  const problems = all.length + errors.length;
  const clean = !problems && !failed.length && !unchecked.length && !totals.incomplete;
  parts.push(`${def.name}: ${clean ? 'no problems found' : `${plural(problems, 'problem')} found`} in ${plural(done.length, 'case')} at ${widths}.`);
  parts.push(...halves);
  if (failed.length) parts.push(`${plural(reached - measured, 'measurement')} failed and ${reached - measured === 1 ? 'was' : 'were'} not checked.`);
  if (unchecked.length) parts.push(`The spacing with content left empty could not be fully compared at ${[...new Set(unchecked)].join(' and ')} width.`);
  if (totals.unverified) parts.push(`${plural(totals.unverified, 'text contrast check')} could not be measured without pixels.`);
  if (totals.incomplete) parts.push('Some checks ran out of time, so they are incomplete.');
  if (remaining > 0) parts.push(`${plural(remaining, 'more case')} to measure: call again with offset ${nextOffset}.`);

  const content: Record<string, unknown> = {
    definitionId: def.id,
    name: def.name,
    ...(target.placement ? { placement: target.placement } : {}),
    ...(window.offset ? { offset: window.offset } : {}),
    cases: done,
    summary: parts.join(' '),
    ...(findings.length ? { findings } : {}),
    ...(all.length > findings.length ? { omittedFindings: all.length - findings.length } : {}),
    ...(errors.length ? { runtimeErrors: errors.slice(0, 5) } : {}),
    ...(errors.length > 5 ? { omittedRuntimeErrors: errors.length - 5 } : {}),
    ...(failed.length ? { failed: failed.slice(0, 5) } : {}),
    ...(totals.unverified ? { unverifiedContrast: totals.unverified } : {}),
    ...(target.notes.length ? { notes: target.notes } : {}),
    ...(remaining > 0 ? { next: { offset: nextOffset, remaining } } : {}),
    // Something in this window was not checked: a later check of fewer cases never stands in for this one.
    ...(failed.length || unchecked.length || halves.length || totals.incomplete || reached < steps ? { incomplete: true } : {})
  };
  return { measured, content };
}
