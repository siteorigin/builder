/**
 * Changing a placed component to another design in place (`instance.swapComponent`, #374): what of the placement's
 * content the new design has a place for, and what it would lose. The engine applies the plan; the Inspector shows
 * the same plan before the author confirms, so what it previews is what the change does.
 */
import type { BindingRef, ComponentDefinition, InstanceNode, ItemStyles, ListItem, ListProp, NodeTree, OwnerRef, ProjectState, PropSchema, ResponsiveStyles, ScalarPropSchema } from '@shared/types';
import { isBinding, isBindingRef } from '@shared/types';
import { toRichText, type RichText } from '@shared/richtext';
import { repeatedPartList } from '@shared/item-styles';
import { newId } from '@shared/ids';
import { catalogueComponent } from '@catalogue/index';
import { EngineError, anchorCapable, findParent } from './tree';
import { clone, placedDefaultItems } from './install';
import { normalizeProp, normalizeScalar } from './values';
import { restrictsKinds, slotAccepts, slotDecl, slotDeclProblem, slotFill } from './slots';

/** A property (or list field) whose content carries over, by its label in the old design and in the new. */
export interface SwapCarry {
  from: string;
  to: string;
  /** For a list: how many items carry over. */
  items?: number;
}

/** Content the new design has no place for, by its label in the old design, and why when a place exists but refuses it. */
export interface SwapLoss {
  label: string;
  reason?: string;
}

export interface SwapPlan {
  target: ComponentDefinition;
  /** The placement's properties in the new design: carried values, and the new design's defaults for the rest. */
  props: Record<string, unknown>;
  variants?: Record<string, string | BindingRef>;
  overrides?: Record<string, ResponsiveStyles>;
  itemOverrides?: Record<string, ItemStyles>;
  slots?: Record<string, string[]>;
  /** Whether the placement's own entrance stays (only a design built in the editor shows one). */
  keepAppear: boolean;
  /** Content that carries over. */
  kept: SwapCarry[];
  /** Content that would be lost. The change is refused unless it is allowed to drop it. */
  dropped: SwapLoss[];
  /** Style choices and styles the new design has no place for. They go without a refusal: the content stays. */
  restyled: string[];
  /** Why the change cannot be made at all. */
  problems: string[];
}

/**
 * Names that mean the same thing in different designs: a hero's heading is a card's title, its lead a section's
 * body, a grid's items a pricing table's plans. A property matches its own name first, then one of its group.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['heading', 'title', 'name', 'question', 'headline'],
  ['lead', 'subheading', 'subtitle', 'description', 'body', 'text', 'summary', 'answer', 'bio', 'quote', 'excerpt'],
  ['eyebrow', 'kicker', 'overline'],
  ['primaryLabel', 'actionLabel', 'ctaLabel', 'buttonLabel', 'linkLabel'],
  ['primaryLink', 'actionLink', 'ctaLink', 'buttonLink', 'link'],
  ['image', 'portrait', 'photo', 'picture', 'logo', 'media'],
  ['items', 'cards', 'plans', 'people', 'members', 'slides', 'images', 'logos', 'features', 'services', 'steps', 'entries']
];
const GROUP_OF = new Map(ALIAS_GROUPS.flatMap((g, i) => g.map((name) => [name.toLowerCase(), i] as const)));
const groupOf = (name: string) => GROUP_OF.get(name.toLowerCase());

/** Kinds that hold what a visitor reads or follows. Yes/no, number, choice and token settings are design choices, not content. */
const CONTENT_TYPES: ReadonlySet<string> = new Set(['string', 'richtext', 'link', 'image', 'icon', 'choices', 'table', 'list', 'object']);

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** Whether a value holds something a visitor would miss if it went. */
export function hasContent(schema: PropSchema, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (isBinding(v)) return true;
  switch (schema.type) {
    case 'string':
    case 'icon':
      return typeof v === 'string' ? v.trim() !== '' : typeof v === 'number';
    case 'richtext':
      return toRichText(v).some((b) => b.type === 'image' || ('spans' in b ? b.spans : b.items.flat()).some((s) => s.text.trim() !== ''));
    case 'link': {
      const l = v as { type?: unknown; target?: unknown };
      return typeof l === 'object' && l.type !== 'none' && typeof l.target === 'string' && l.target.trim() !== '';
    }
    case 'image':
      return typeof v === 'object' && typeof (v as { assetId?: unknown }).assetId === 'string' && (v as { assetId: string }).assetId !== '';
    case 'choices':
      return Array.isArray(v) && v.length > 0;
    case 'table': {
      const rows = (v as { rows?: unknown }).rows;
      return Array.isArray(rows) && rows.length > 0;
    }
    case 'list':
      return !schema.feed && Array.isArray(v) && v.length > 0;
    case 'object':
      return typeof v === 'object' && Object.entries(schema.fields).some(([k, f]) => hasContent(f, own(v as Record<string, unknown>, k)));
    default:
      return false;
  }
}

/** Plain text and rich text stand in for each other; anything else only for its own kind (a token for its own group). */
function scalarFits(from: ScalarPropSchema | PropSchema, to: ScalarPropSchema | PropSchema): boolean {
  if (from.type === to.type) return from.type !== 'token' || (to.type === 'token' && from.tokenGroup === to.tokenGroup);
  return (from.type === 'string' && to.type === 'richtext') || (from.type === 'richtext' && to.type === 'string');
}

/**
 * Which field of `from` each field of `to` takes its value from: the same name first, then a name of the same alias
 * group, each used once.
 */
function matchNames<S extends PropSchema>(from: Record<string, S>, to: Record<string, S>, fits: (a: S, b: S) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const k of Object.keys(to)) {
    const f = own(from, k);
    if (f && fits(f, to[k])) {
      out.set(k, k);
      used.add(k);
    }
  }
  for (const k of Object.keys(to)) {
    const g = groupOf(k);
    if (out.has(k) || g === undefined) continue;
    const src = Object.keys(from).find((f) => !used.has(f) && !own(to, f) && groupOf(f) === g && fits(from[f], to[k]));
    if (src === undefined) continue;
    out.set(k, src);
    used.add(src);
  }
  return out;
}

/** Item fields of one list matched with another's: at least one field that holds content must match. */
function listFields(from: ListProp, to: ListProp): Map<string, string> | null {
  if (from.feed || to.feed || !!from.pageTeaser !== !!to.pageTeaser) return null;
  const map = matchNames<ScalarPropSchema>(from.fields, to.fields, scalarFits);
  return [...map.keys()].some((k) => CONTENT_TYPES.has(to.fields[k].type)) ? map : null;
}

function propFits(from: PropSchema, to: PropSchema): boolean {
  if (from.type === 'list' || to.type === 'list') return from.type === 'list' && to.type === 'list' && listFields(from, to) !== null;
  if (from.type === 'object' || to.type === 'object') return from.type === 'object' && to.type === 'object' && JSON.stringify(Object.keys(from.fields).sort()) === JSON.stringify(Object.keys(to.fields).sort());
  return scalarFits(from, to);
}

/**
 * A value connected to the enclosing design (`{ $prop }`, `{ $item }`, `{ $entry }`) stays connected only where the new
 * property is of exactly the same kind, items and all, so it reads what it read before.
 */
function sameShape(from: PropSchema, to: PropSchema): boolean {
  if (from.type !== to.type) return false;
  if (from.type === 'list' && to.type === 'list') return JSON.stringify(Object.entries(from.fields).map(([k, f]) => [k, f.type]).sort()) === JSON.stringify(Object.entries(to.fields).map(([k, f]) => [k, f.type]).sort());
  if (from.type === 'token' && to.type === 'token') return from.tokenGroup === to.tokenGroup;
  if (from.type === 'object' && to.type === 'object') return JSON.stringify(Object.keys(from.fields).sort()) === JSON.stringify(Object.keys(to.fields).sort());
  return true;
}

const reasonOf = (e: unknown) => (e instanceof EngineError || e instanceof Error ? e.message : String(e));

/** Rich text as plain text, when nothing but the words is in it (and only one paragraph, unless the text takes several). */
function plainFromRich(v: unknown, multiline: boolean): string | null {
  const blocks: RichText = toRichText(v);
  if (!blocks.every((b) => b.type === 'p' && b.spans.every((s) => !s.strong && !s.em && !s.link))) return null;
  if (blocks.length > 1 && !multiline) return null;
  return blocks.map((b) => ('spans' in b ? b.spans.map((s) => s.text).join('') : '')).join('\n\n');
}

/**
 * One value moved from a field of the old design to a field of the new: the same kind as it was, plain text as
 * literal paragraphs (nothing in it read as formatting), rich text as plain text when it has no formatting to lose.
 * Checked against the new field's rules; the error says why it does not fit.
 */
function carryScalar(state: ProjectState, from: ScalarPropSchema, to: ScalarPropSchema, v: unknown, label: string): { value: unknown } | { reason: string } {
  if (isBinding(v)) return sameShape(from, to) ? { value: clone(v) } : { reason: 'it is connected to a property of a different kind' };
  let value: unknown = clone(v);
  if (from.type === 'string' && to.type === 'richtext') {
    const text = typeof v === 'string' ? v : String(v ?? '');
    value = text
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => ({ type: 'p', spans: [{ text: p }] }));
  } else if (from.type === 'richtext' && to.type === 'string') {
    const plain = plainFromRich(v, !!to.multiline);
    if (plain === null) return { reason: 'its formatting, links or paragraphs would be lost in plain text' };
    value = plain;
  }
  try {
    return { value: normalizeScalar(to, value, state, label, from.type === to.type ? v : undefined) };
  } catch (e) {
    return { reason: reasonOf(e) };
  }
}

/** The new design's starting value for a property no content went to. */
function freshDefault(schema: PropSchema): unknown {
  const v = clone(schema.default);
  return schema.type === 'list' && Array.isArray(v) ? (v as ListItem[]).map((it) => ({ ...it, id: newId('i') })) : v;
}

/** What the placement holds for a property: its own value, or its design's default (list items under its own IDs). */
function effectiveValue(owner: OwnerRef, node: InstanceNode, key: string, schema: PropSchema): unknown {
  if (Object.hasOwn(node.props, key)) return node.props[key];
  if (schema.type === 'list') return schema.feed ? [] : placedDefaultItems(owner, node, schema.default);
  return clone(schema.default);
}

/**
 * The definition a swap to `target` would show: a project definition by its ID, or the active theme's catalogue
 * component, as installed or as it would be installed. Undefined when there is no such component.
 */
export function swapTarget(state: ProjectState, target: { componentId?: string; definitionId?: string }): ComponentDefinition | undefined {
  if (target.definitionId !== undefined) return own(state.components, target.definitionId);
  if (target.componentId === undefined) return undefined;
  const src = catalogueComponent(state.site.themeId, target.componentId);
  return src ? (own(state.components, src.id) ?? src) : undefined;
}

/**
 * The plan for showing `node` (a placement in `tree`, owned by `owner`) as `target` instead. Reads the project and
 * changes nothing.
 */
export function planSwap(state: ProjectState, owner: OwnerRef, tree: NodeTree, node: InstanceNode, target: ComponentDefinition): SwapPlan {
  const source = own(state.components, node.definitionId);
  const problems: string[] = [];
  const kept: SwapCarry[] = [];
  const dropped: SwapLoss[] = [];
  const restyled: string[] = [];
  const props: Record<string, unknown> = {};
  const plan: SwapPlan = { target, props, keepAppear: false, kept, dropped, restyled, problems };
  if (!source) {
    problems.push(`Its component "${node.definitionId}" is missing.`);
    return plan;
  }
  if (owner.kind === 'shell' || source.category === 'shell' || target.category === 'shell') problems.push('The shared header and footer keep their own design. Change sections on pages instead.');
  if (target.id === source.id) problems.push(`It already shows “${source.name}”.`);

  // Properties: each of the new design's takes the content of the old one it matches, or starts at its default.
  const sourceProps = Object.fromEntries(Object.entries(source.properties).filter(([, s]) => !(s.type === 'list' && s.feed)));
  const targetProps = Object.fromEntries(Object.entries(target.properties).filter(([, s]) => !(s.type === 'list' && s.feed)));
  const map = matchNames<PropSchema>(sourceProps, targetProps, (a, b) => propFits(a, b));
  const carried = new Set<string>();
  /** Which list of the new design each list of the old one went to, for the styles of single items. */
  const listTo = new Map<string, string>();
  for (const [key, schema] of Object.entries(target.properties)) {
    if (schema.type === 'list' && schema.feed) continue;
    const from = map.get(key);
    const fromSchema = from === undefined ? undefined : source.properties[from];
    if (from === undefined || !fromSchema) {
      props[key] = freshDefault(schema);
      continue;
    }
    const v = effectiveValue(owner, node, from, fromSchema);
    const label = `${target.name} → ${schema.label}`;
    const content = hasContent(fromSchema, v);
    if (isBinding(v)) {
      if (sameShape(fromSchema, schema)) {
        props[key] = clone(v);
        carried.add(from);
        kept.push({ from: fromSchema.label, to: schema.label });
      } else props[key] = freshDefault(schema);
      continue;
    }
    if (fromSchema.type === 'list' && schema.type === 'list') {
      const fields = listFields(fromSchema, schema)!;
      const r = carryList(state, fromSchema, schema, fields, Array.isArray(v) ? (v as ListItem[]) : [], label);
      props[key] = r.items;
      carried.add(from);
      listTo.set(from, key);
      if (r.carried) kept.push({ from: fromSchema.label, to: schema.label, items: r.carried });
      dropped.push(...r.dropped.map((d) => ({ ...d, label: `${fromSchema.label}${d.label ? ` → ${d.label}` : ''}` })));
      continue;
    }
    if (fromSchema.type === 'list' || schema.type === 'list') continue;
    let r: { value: unknown } | { reason: string };
    if (fromSchema.type === 'table' || fromSchema.type === 'object') {
      try {
        r = { value: normalizeProp(schema, clone(v), state, label, v) };
      } catch (e) {
        r = { reason: reasonOf(e) };
      }
    } else r = carryScalar(state, fromSchema, schema as ScalarPropSchema, v, label);
    carried.add(from);
    if ('value' in r) {
      props[key] = r.value;
      if (content) kept.push({ from: fromSchema.label, to: schema.label });
    } else {
      props[key] = freshDefault(schema);
      if (content) dropped.push({ label: fromSchema.label, reason: r.reason });
    }
  }
  for (const [key, schema] of Object.entries(source.properties)) {
    if (carried.has(key) || !CONTENT_TYPES.has(schema.type)) continue;
    const v = effectiveValue(owner, node, key, schema);
    if (hasContent(schema, v)) dropped.push({ label: schema.label });
  }

  // Style choices the new design also offers stay chosen (a tone it has by the same name); the rest go.
  const variants: Record<string, string | BindingRef> = {};
  for (const [axis, v] of Object.entries(node.variants ?? {})) {
    const from = own(source.variantAxes, axis);
    const to = own(target.variantAxes, axis);
    const fits = typeof v === 'string' ? !!to && !!own(to.options, v) : isBindingRef(v) && !!to && !!from && Object.keys(from.options).every((o) => !!own(to.options, o));
    if (fits) variants[axis] = clone(v);
    else if (typeof v !== 'string' || v !== from?.default) restyled.push(`${from?.label ?? axis}: ${typeof v === 'string' ? (own(from?.options, v)?.label ?? v) : 'connected'}`);
  }
  if (Object.keys(variants).length) plan.variants = variants;

  // Styles set on the whole section stay; styles on a part stay where the new design has a part of that name.
  const partLabel = (p: string) => own(source.parts, p)?.label ?? p;
  for (const [part, styles] of Object.entries(node.overrides ?? {})) {
    if (part === 'root' || own(target.parts, part)) (plan.overrides ??= {})[part] = clone(styles);
    else restyled.push(`Styles of ${partLabel(part)}`);
  }
  for (const [part, entry] of Object.entries(node.itemOverrides ?? {})) {
    const list = entry && typeof entry === 'object' && typeof entry.list === 'string' ? listTo.get(entry.list) : undefined;
    if (list && own(target.parts, part) && repeatedPartList(target, part) === list) (plan.itemOverrides ??= {})[part] = { list, items: clone(entry.items) };
    else restyled.push(`Styles of single ${partLabel(part)} items`);
  }

  // Content placed in its slots moves to the new design's slot of the same name, which must take all of it.
  const design = owner.kind === 'component' ? own(state.components, owner.id) : undefined;
  for (const [slot, ids] of Object.entries(node.slots ?? {})) {
    if (!Array.isArray(ids) || !ids.length) continue;
    const was = own(source.slots, slot)?.label ?? slot;
    const decl = own(target.slots, slot);
    if (!decl || slotDeclProblem(decl)) {
      problems.push(`“${target.name}” has no “${was}” slot for the ${ids.length === 1 ? 'element' : `${ids.length} elements`} in it. Move ${ids.length === 1 ? 'it' : 'them'} out first.`);
      continue;
    }
    const fill = slotFill(state, tree, ids, decl, design);
    if (fill.refused) problems.push(`The “${decl.label}” slot of “${target.name}” takes ${slotAccepts(decl)}, not ${fill.refused.what}.`);
    else if (decl.max !== undefined && fill.count > decl.max) problems.push(`The “${decl.label}” slot of “${target.name}” holds at most ${decl.max === 1 ? 'one item' : `${decl.max} items`}.`);
    (plan.slots ??= {})[slot] = [...ids];
  }
  // The slot it sits in must take the new design too.
  const at = findParent(tree, node.id);
  const parent = at?.parentId ? own(tree.nodes, at.parentId) : undefined;
  if (parent?.kind === 'instance' && at?.slot) {
    const decl = slotDecl(state, parent, at.slot);
    if (decl && restrictsKinds(decl) && !(decl.categories ?? []).includes(target.category))
      problems.push(`The “${decl.label}” slot of “${own(state.components, parent.definitionId)?.name ?? 'its component'}” takes ${slotAccepts(decl)}, not “${target.name}” (a ${target.category} component).`);
  }

  // In-page links reach the section by its anchor, which only a design built in the editor renders.
  const anchors = anchorCapable(state, target);
  if (node.anchor && !anchors) problems.push(`“${target.name}” can’t take the anchor #${node.anchor} that in-page links use. Clear the anchor first, or pick another design.`);
  plan.keepAppear = anchors;
  return plan;
}

/** Each item of the old list as an item of the new: its ID kept, matched fields carried, the rest at their defaults. */
function carryList(state: ProjectState, from: ListProp, to: ListProp, fields: Map<string, string>, items: ListItem[], label: string): { items: ListItem[]; carried: number; dropped: SwapLoss[] } {
  const dropped = new Map<string, SwapLoss>();
  const lose = (key: string, reason?: string) => {
    if (!dropped.has(key)) dropped.set(key, { label: key === '' ? '' : (from.fields[key]?.label ?? key), ...(reason ? { reason } : {}) });
  };
  const limit = to.max ?? Infinity;
  const kept = items.slice(0, limit);
  if (items.length > kept.length) {
    const over = items.length - kept.length;
    lose('', `${over === 1 ? 'one item' : `${over} items`} past the new limit of ${to.max}`);
  }
  const usedFrom = new Set(fields.values());
  const out: ListItem[] = kept.map((it) => {
    const item: ListItem = { id: typeof it?.id === 'string' && it.id ? it.id : newId('i') };
    for (const [k, f] of Object.entries(to.fields)) {
      const src = fields.get(k);
      const fromField = src === undefined ? undefined : from.fields[src];
      const raw = src !== undefined && it && Object.hasOwn(it, src) ? it[src] : undefined;
      if (src === undefined || !fromField || raw === undefined) {
        item[k] = clone(f.default);
        continue;
      }
      const r = carryScalar(state, fromField, f, raw, `${label} → ${f.label}`);
      if ('value' in r) item[k] = r.value;
      else {
        item[k] = clone(f.default);
        if (hasContent(fromField, raw)) lose(src, r.reason);
      }
    }
    for (const [k, f] of Object.entries(from.fields)) if (!usedFrom.has(k) && CONTENT_TYPES.has(f.type) && it && hasContent(f, it[k])) lose(k);
    return item;
  });
  // A list that needs more items than it was given starts the rest from its own defaults.
  const defaults = Array.isArray(to.default) ? to.default : [];
  while (to.min !== undefined && out.length < to.min) {
    const d = defaults[out.length % Math.max(defaults.length, 1)];
    out.push({ ...(d ? clone(d) : Object.fromEntries(Object.entries(to.fields).map(([k, f]) => [k, clone(f.default)]))), id: newId('i') } as ListItem);
  }
  return { items: out, carried: kept.length, dropped: [...dropped.values()] };
}
