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
import { findParent, getTree } from '@engine/tree';

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

/** The component named by exactly one of a definition ID, a theme component ID, or a placement (owner and nodeId). */
export function resolveInspectTarget(state: ProjectState, a: InspectArgs): InspectTarget | { error: string } {
  const named = [a.definitionId !== undefined, a.componentId !== undefined, a.owner !== undefined || a.nodeId !== undefined].filter(Boolean).length;
  if (named !== 1) return { error: 'Name one component: definitionId, componentId, or a placement (owner and nodeId).' };
  if (a.definitionId !== undefined) {
    const def = own(state.components, a.definitionId);
    if (!def) return { error: `The project has no component "${a.definitionId}". read_project with sections ["components"] lists them.` };
    return { def, select: { definitionId: def.id }, values: defaultProps(def), variants: {}, notes: [] };
  }
  if (a.componentId !== undefined) {
    const source = catalogueComponent(state.site.themeId, a.componentId);
    if (!source) return { error: `The theme has no component "${a.componentId}". search_components finds them.` };
    // The project's copy, with any changes made to it, when it has one.
    const installed = own(state.components, source.id);
    const def = installed ?? source;
    return { def, select: installed ? { definitionId: installed.id } : { componentId: a.componentId }, values: defaultProps(def), variants: {}, notes: [] };
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
  return { def, select: { definitionId: def.id }, placement: { owner: a.owner, nodeId: a.nodeId }, values, variants, notes };
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

/**
 * The content a design shows only when it is there (a `when` or `unless` testing that a value is present): property
 * names, object fields ("name.field") and list item fields ("[]field").
 */
function optionalContent(def: ComponentDefinition): Set<string> {
  const out = new Set<string>();
  const add = (c: Condition | undefined) => {
    if (!c || isComparison(c)) return;
    const ref = conditionRef(c);
    if (!ref || !isBinding(ref)) return;
    if ('$item' in ref) out.add(`[]${ref.$item}`);
    else out.add(ref.field ? `${ref.$prop}.${ref.field}` : ref.$prop);
  };
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    add(n.when);
    add(n.unless);
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

/** `text` cut to a field's length limit. */
const longFor = (schema: ScalarPropSchema) => (schema.type === 'string' && schema.maxLength !== undefined ? LONG_TEXT.slice(0, Math.max(1, schema.maxLength)) : LONG_TEXT);

/**
 * Every case to measure, in the order they are measured: the starting point, the stress cases (links shown and
 * then left empty with the optional text, long text, one and five list items), and each other option of every
 * variant axis on its own. Cases that would show the same thing are measured once, under both names.
 */
export function planComponentInspection(target: InspectTarget): InspectCase[] {
  const { def } = target;
  const base = target.values;
  const cases: Array<InspectCase & { controlOf?: InspectCase }> = [];
  /** The case kept: `c`, or the one already planned that shows the same thing, now also named for `c`. */
  const add = (c: InspectCase & { controlOf?: InspectCase }) => {
    const key = JSON.stringify([c.variants, c.props]);
    const same = cases.find((x) => JSON.stringify([x.variants, x.props]) === key);
    if (!same) {
      cases.push(c);
      return c;
    }
    same.label = `${same.label} + ${c.label}`;
    if (c.controlOf && c.controlOf !== same) same.controlOf ??= c.controlOf;
    return same;
  };
  const start = add({ label: target.placement ? 'as placed' : 'defaults', variants: { ...target.variants }, props: clone(base) });

  // Links shown, then links and optional text left empty: what disappears must not take the spacing with it.
  const optional = optionalContent(def);
  let links = 0;
  let empties = 0;
  const shown = clone(base);
  eachScalar(def, shown, (s, v, set) => {
    if (s.type !== 'link') return;
    links++;
    if (isEmptyLink(v)) set({ ...SAMPLE_LINK });
  });
  const empty = clone(shown);
  eachScalar(def, empty, (s, v, set, w) => {
    const key = w.list ? `[]${w.field}` : w.field ? `${w.prop}.${w.field}` : w.prop;
    if (s.type !== 'link' && !optional.has(key)) return;
    const e = emptied(s);
    if (e === undefined || JSON.stringify(e) === JSON.stringify(v)) return;
    set(e);
    empties++;
  });
  if (empties) {
    const control = links ? add({ label: 'links set', variants: { ...target.variants }, props: shown }) : start;
    add({ label: 'empty', variants: { ...target.variants }, props: empty, controlOf: control });
  }

  // Long text everywhere text goes.
  const long = clone(base);
  let texts = 0;
  eachScalar(def, long, (s, _v, set) => {
    if (s.type === 'string') set(longFor(s));
    else if (s.type === 'richtext') set([{ type: 'p', spans: [{ text: LONG_TEXT }] }]);
    else return;
    texts++;
  });
  if (texts) add({ label: 'long text', variants: { ...target.variants }, props: long });

  // One and five items in every list an author fills, within its limits.
  for (const count of ITEM_COUNTS) {
    const props = clone(base);
    let changed = false;
    for (const [name, schema] of Object.entries(def.properties)) {
      if (schema.type !== 'list' || schema.feed) continue;
      const items = Array.isArray(props[name]) ? (props[name] as ListItem[]) : [];
      const n = Math.min(schema.max ?? Infinity, Math.max(schema.min ?? 0, count));
      if (n === items.length) continue;
      // Copies of the items there are, or items of default values when there are none; given IDs of their own.
      props[name] = Array.from({ length: n }, (_, i) => ({ ...(items.length ? clone(items[i % items.length]) : {}), id: `sweep${i + 1}` }));
      changed = true;
    }
    if (changed) add({ label: count === 1 ? '1 item' : `${count} items`, variants: { ...target.variants }, props });
  }

  // Each other option of each axis, the rest as they start.
  for (const [axis, a] of axesOf(def)) {
    const current = target.variants[axis] ?? a.default;
    for (const option of Object.keys(a.options)) if (option !== current) add({ label: `${axis}=${option}`, variants: { ...target.variants, [axis]: option }, props: clone(base) });
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
 * named by where it rendered and which of the elements rendered there it is (`n` of `of`, in document order), since
 * list items take new IDs in every preview.
 */
interface GapEnd {
  ctx: string;
  node: string;
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

const cut = (s: unknown) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};
const locKey = (l: ComponentLocation | undefined) => (l ? `${l.nodeId}/${l.partId ?? ''}` : '');

const endKey = (e: GapEnd) => `${e.ctx}\u0000${e.node}\u0000${e.n}`;
const baseKey = (e: GapEnd) => `${e.ctx}\u0000${e.node}`;

const gapsOf = (r: ComponentPreviewResult | undefined): Gap[] | null => {
  const g = (r?.report as { gaps?: unknown } | undefined)?.gaps;
  const end = (e: unknown): e is GapEnd => isRecord(e) && typeof e.ctx === 'string' && typeof e.node === 'string' && Number.isInteger(e.n) && Number.isInteger(e.of);
  return Array.isArray(g) ? (g as Gap[]).filter((x) => isRecord(x) && end(x.a) && end(x.b) && Number.isFinite(x.gap)) : null;
};

/**
 * Elements that touch in `empty` but had space between them in `control`, where whatever stood between them has gone:
 * spacing carried by the content that was left empty. An element rendered a different number of times in the two
 * (a repeated row, one of them gone) is skipped, since its position no longer says which one it is.
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

/**
 * What the measurements of `cases` found: each defect once, with the cases and widths it showed in, the
 * measurements that failed, and what is left to measure. A component with nothing found gets a one-line summary.
 * `results` answer the steps of inspectionSteps in order; a short list means the rest ran out of time.
 */
export function digestComponentInspection(target: InspectTarget, cases: InspectCase[], results: ComponentPreviewResult[], window: { offset: number; total: number }): ComponentDigest {
  const { def } = target;
  const groups = new Map<string, ComponentFinding & { seen: Map<string, Set<Viewport>> }>();
  const failures = new Map<string, Map<string, Set<Viewport>>>();
  const runtime = new Map<string, Map<string, Set<Viewport>>>();
  const note = (into: Map<string, Set<Viewport>>, label: string, v: Viewport) => {
    if (!into.has(label)) into.set(label, new Set());
    into.get(label)!.add(v);
  };
  const where = (seen: Map<string, Set<Viewport>>) => [...seen].map(([label, vs]) => `${label}: ${VIEWPORTS.filter((v) => vs.has(v)).join(', ')}`);
  const totals = { checked: 0, failed: 0, unverified: 0, incomplete: false };
  let measured = 0;
  let reached = 0;
  const steps = cases.length * VIEWPORTS.length;
  const gaps = new Map<string, Gap[] | null>();

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
    if (r.state !== 'ready' || !report || typeof report !== 'object' || report.error || !Array.isArray(report.issues)) {
      const why = cut(r.error ?? report?.error ?? 'The component could not be measured.');
      if (!failures.has(why)) failures.set(why, new Map());
      note(failures.get(why)!, c.label, v);
      continue;
    }
    measured++;
    gaps.set(`${c.label}\u0000${v}`, gapsOf(r));
    for (const check of Object.values(report.checks ?? {})) {
      totals.checked += Number(check?.checked) || 0;
      totals.failed += Number(check?.failed) || 0;
      totals.unverified += Number(check?.unverified) || 0;
      if (check?.incomplete) totals.incomplete = true;
    }
    for (const issue of report.issues as Array<{ kind?: unknown; message?: unknown; text?: unknown; desc?: Desc; with?: { desc?: Desc; text?: unknown } }>) {
      if (!issue || !KINDS.has(String(issue.kind))) continue;
      const kind = String(issue.kind);
      const at = componentLocation(def, issue.desc);
      const other = issue.with && typeof issue.with === 'object' ? { at: componentLocation(def, issue.with.desc), text: issue.with.text } : undefined;
      // Unaddressed markup is told apart by what it says; the design's own elements by where they are.
      const key = [kind, locKey(at), at || !issue.desc ? '' : cut(issue.text).slice(0, 30), other ? locKey(other.at) : ''].join('\u0000');
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
    for (const err of Array.isArray(report.runtimeErrors) ? report.runtimeErrors : []) {
      const msg = cut(err);
      if (!runtime.has(msg)) runtime.set(msg, new Map());
      note(runtime.get(msg)!, c.label, v);
    }
  }

  // Spacing that went with content left empty, against the same case with the content shown.
  for (const c of cases) {
    if (!c.control) continue;
    for (const v of VIEWPORTS) {
      const control = gaps.get(`${c.control}\u0000${v}`);
      const empty = gaps.get(`${c.label}\u0000${v}`);
      if (!control || !empty) continue;
      for (const hit of collapsedGaps(control, empty)) {
        const at = componentLocation(def, hit.a);
        const other = componentLocation(def, hit.b);
        record(
          {
            kind: 'spacing-collapse',
            message: `With the links and optional text empty, these two touch (${hit.after}px apart); with them shown there was at least ${hit.before}px of space between. Space them with the gap of their container, not with the content that can be empty.`,
            ...(at ? { at } : {}),
            with: other ? { at: other } : {}
          },
          c.label,
          v,
          ['spacing-collapse', locKey(at), locKey(other), at ? '' : `${hit.a.node}`].join('\u0000')
        );
      }
    }
  }

  const all = [...groups.values()].map(({ seen, ...f }) => ({ ...f, in: where(seen) }));
  const findings = all.slice(0, MAX_FINDINGS);
  const failed = [...failures].map(([error, seen]) => ({ error, in: where(seen) }));
  const errors = [...runtime].map(([error, seen]) => ({ error, in: where(seen) }));
  // The cases not reached in time are measured next, from the first of them.
  const done = Math.floor(reached / VIEWPORTS.length);
  const nextOffset = window.offset + (reached < steps ? done : cases.length);
  const remaining = window.total - nextOffset;
  const measuredCases = cases.slice(0, Math.ceil(reached / VIEWPORTS.length)).map((c) => c.label);

  const parts: string[] = [];
  const widths = `phone (${INSPECT_WIDTHS.phone}px) and desktop (${INSPECT_WIDTHS.desktop}px) width`;
  const problems = all.length + errors.length;
  if (!problems && !failed.length) parts.push(`${def.name}: no problems found in ${measuredCases.length} case${measuredCases.length === 1 ? '' : 's'} at ${widths}.`);
  else parts.push(`${def.name}: ${problems} problem${problems === 1 ? '' : 's'} found in ${measuredCases.length} case${measuredCases.length === 1 ? '' : 's'} at ${widths}.`);
  if (failed.length) parts.push(`${reached - measured} measurement${reached - measured === 1 ? '' : 's'} failed and ${reached - measured === 1 ? 'was' : 'were'} not checked.`);
  if (totals.unverified) parts.push(`${totals.unverified} text contrast check${totals.unverified === 1 ? '' : 's'} over pictures could not be measured.`);
  if (totals.incomplete) parts.push('Some checks ran out of time, so they are incomplete.');
  if (remaining > 0) parts.push(`${remaining} more case${remaining === 1 ? '' : 's'} to measure: call again with offset ${nextOffset}.`);

  const content: Record<string, unknown> = {
    definitionId: def.id,
    ...(target.placement ? { placement: target.placement } : {}),
    ...(window.offset ? { offset: window.offset } : {}),
    cases: measuredCases,
    summary: parts.join(' '),
    ...(findings.length ? { findings } : {}),
    ...(all.length > findings.length ? { omittedFindings: all.length - findings.length } : {}),
    ...(errors.length ? { runtimeErrors: errors.slice(0, 5) } : {}),
    ...(failed.length ? { failed: failed.slice(0, 5) } : {}),
    ...(target.notes.length ? { notes: target.notes } : {}),
    ...(remaining > 0 ? { next: { offset: nextOffset, remaining } } : {})
  };
  return { measured, content };
}

