/**
 * Required properties across a whole project (see shared/required.ts): every definition's defaults, every placement's
 * own values and every binding into a placed component. The value normalizers refuse an edit that empties a required
 * value as it is made; this reads what is already stored, for load validation and for the edits that carry values
 * over without normalizing each one (a swap, a theme change, a package import).
 */
import type { ComponentDefinition, GraphNode, InstanceNode, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { isBinding, isBindingRef, isEntryBinding } from '@shared/types';
import { entryFieldSchema } from '@shared/entry-fields';
import { fieldsOf, hasRequired, isEmptyPropValue, requiredGap, requiredMessage } from '@shared/required';
import { allTrees } from './tree';
import { boundSchema } from './schema';

export interface RequiredProblem {
  /** Stable across two reads of the same project, so a batch can tell a problem it made from one that was there. */
  key: string;
  message: string;
  owner: OwnerRef;
  nodeId?: string;
  /** A binding that could pass an empty value, which binding validation (`bindingProblem`) reports too. */
  bound?: true;
}

/** Each place a value of `schema` is empty though required: a message with `label` as its path, and a key telling it apart within the value. */
export function requiredValueProblems(schema: PropSchema, v: unknown, label: string): Array<{ key: string; message: string }> {
  // A computed list's items are the site's pages, whatever is stored.
  if (schema.type === 'list' && schema.feed) return [];
  const out: Array<{ key: string; message: string }> = [];
  if (schema.type === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    // A field the object leaves out shows the object's default, or the field's own.
    const defaults = schema.default && typeof schema.default === 'object' ? (schema.default as Record<string, unknown>) : {};
    const o = v as Record<string, unknown>;
    const shown = Object.fromEntries(fieldsOf(schema).map(([k, f]) => [k, Object.hasOwn(o, k) ? o[k] : Object.hasOwn(defaults, k) ? defaults[k] : f.default]));
    if (schema.required && isEmptyPropValue(schema, shown)) out.push({ key: '', message: requiredMessage(schema, label) });
    for (const [k, f] of fieldsOf(schema)) if (f.required && isEmptyPropValue(f, shown[k])) out.push({ key: k, message: requiredMessage(f, `${label} → ${f.label}`) });
    return out;
  }
  if (schema.required && isEmptyPropValue(schema, v)) out.push({ key: '', message: requiredMessage(schema, label) });
  if (schema.type === 'list' && Array.isArray(v)) {
    const required = fieldsOf(schema).filter(([, f]) => f.required);
    if (!required.length) return out;
    for (const [i, item] of v.entries()) {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const id = typeof row.id === 'string' ? row.id : String(i);
      // A field an item leaves out shows the field's default.
      for (const [k, f] of required) if (isEmptyPropValue(f, Object.hasOwn(row, k) ? row[k] : f.default)) out.push({ key: `${id}|${k}`, message: requiredMessage(f, `${label} → ${schema.itemLabel} ${i + 1} → ${f.label}`) });
    }
  }
  return out;
}

/** The schema of what a binding in a placement's property reads: an enclosing component's property or item field, or an entry's field. */
export function bindingSource(state: ProjectState, owner: OwnerRef, node: GraphNode, v: unknown): PropSchema | undefined {
  if (!isBindingRef(v)) return undefined;
  if (isEntryBinding(v)) {
    const collection = owner.kind === 'template' && Object.hasOwn(state.collections ?? {}, owner.id) ? state.collections[owner.id] : undefined;
    return collection ? entryFieldSchema(collection, v.$entry) : undefined;
  }
  const parent = owner.kind === 'component' && Object.hasOwn(state.components, owner.id) ? state.components[owner.id] : undefined;
  return parent ? boundSchema(parent, node.id, v) : undefined;
}

/**
 * Every required value the project leaves empty, or could leave empty through a binding: a definition's default, and
 * each placement's own value or the default it shows without one. `bindings: false` leaves bindings out, for a caller
 * that checks them with the other binding problems (`bindingProblem`).
 */
export function requiredProblems(state: ProjectState, { bindings = true } = {}): RequiredProblem[] {
  const out: RequiredProblem[] = [];
  const defs = Object.values(state.components).filter((d): d is ComponentDefinition => !!d && typeof d === 'object' && hasRequiredProps(d));
  for (const def of defs) out.push(...defaultProblems(def));
  if (!defs.length) return out;
  const required = new Set(defs.map((d) => d.id));
  for (const { owner, tree, label } of allTrees(state))
    for (const n of Object.values(tree.nodes ?? {})) if (n?.kind === 'instance' && required.has(n.definitionId)) out.push(...placementProblems(state, owner, n, label, bindings));
  return out;
}

const hasRequiredProps = (def: ComponentDefinition) => !!def.properties && typeof def.properties === 'object' && Object.values(def.properties).some((s) => !!s && typeof s === 'object' && hasRequired(s));

/** A definition's defaults that leave a required value empty: each property's, and each required field's own. */
function defaultProblems(def: ComponentDefinition): RequiredProblem[] {
  const out: RequiredProblem[] = [];
  const owner: OwnerRef = { kind: 'component', id: def.id };
  for (const [k, s] of Object.entries(def.properties ?? {})) {
    if (!s || typeof s !== 'object' || !hasRequired(s)) continue;
    for (const p of requiredValueProblems(s, s.default, `${def.name} → ${s.label} (default)`)) out.push({ key: `default|${def.id}|${k}|${p.key}`, message: p.message, owner });
    // Each field's own default starts every new item, whatever the property's default holds (an import can empty one).
    if (!(s.type === 'list' && s.feed))
      for (const [f, fs] of fieldsOf(s))
        if (fs.required && isEmptyPropValue(fs, fs.default)) out.push({ key: `default|${def.id}|${k}|field|${f}`, message: requiredMessage(fs, `${def.name} → ${s.label} → ${fs.label} (default)`), owner });
  }
  return out;
}

/**
 * Where in a placement a required problem is, read back from its key (`site`): the property, and one field of an
 * object or of a list item. Null for a key that is not a placement's value (a default, or a binding).
 */
export function requiredSite(key: string, owner: OwnerRef, nodeId: string): { prop: string; itemId?: string; field?: string } | null {
  const head = `${owner.kind}|${owner.id}|${nodeId}|`;
  if (!key.startsWith(head)) return null;
  const parts = key.slice(head.length).split('|');
  // A binding's problem names only the property; a value's names the place within it after it, empty for the whole.
  if (parts.length < 2 || !parts[0]) return null;
  const [prop, ...rest] = parts;
  if (rest.length === 1) return rest[0] ? { prop, field: rest[0] } : { prop };
  // A field's name has no "|"; an item's ID, sent whole by hand or the AI, might.
  const field = rest[rest.length - 1];
  const itemId = rest.slice(0, -1).join('|');
  return itemId && field ? { prop, itemId, field } : null;
}

/**
 * Whether a problem a change (`operations`, from `before` to `after`) brings in is a value that was already empty, so it
 * is reported rather than a reason to refuse the change: a placement the change made a property or field required on
 * (its component's schema changed, the value's type did not, and it held the value empty before), or a placement the
 * change made, which can only hold an empty required value as a copy of one (a section moved or duplicated: new
 * content is checked as it is written). Any change that empties a required value, in the same batch or not, is refused.
 */
export function madeRequiredBy(before: ProjectState, after: ProjectState, operations: ReadonlyArray<{ type: string; definitionId?: unknown }>, d: { code: string; owner?: { kind: string; id: string }; nodeId?: string; site?: string }): boolean {
  if (d.code !== 'PROP_REQUIRED_EMPTY' || !d.owner || !d.nodeId || !d.site) return false;
  const changed = new Set(operations.flatMap((o) => ((o.type === 'component.setPropSchema' || o.type === 'component.upsert') && typeof o.definitionId === 'string' ? [o.definitionId] : [])));
  const at = requiredSite(d.site, d.owner as OwnerRef, d.nodeId);
  if (!at) return false;
  const placement = (state: ProjectState) => {
    const found = allTrees(state).find((t) => t.owner.kind === d.owner!.kind && t.owner.id === d.owner!.id);
    const n = found?.tree.nodes && Object.hasOwn(found.tree.nodes, d.nodeId!) ? found.tree.nodes[d.nodeId!] : undefined;
    return n?.kind === 'instance' ? n : undefined;
  };
  const now = placement(after);
  const was = placement(before);
  if (!now) return false;
  if (!was) return true;
  if (was.definitionId !== now.definitionId || !changed.has(now.definitionId)) return false;
  const schema = Object.hasOwn(after.components, now.definitionId) ? after.components[now.definitionId].properties[at.prop] : undefined;
  const prevDef = Object.hasOwn(before.components, was.definitionId) ? before.components[was.definitionId] : undefined;
  const prev = prevDef?.properties[at.prop];
  // A value of another type before is not one that was empty under this rule (a picture is no text).
  const typeAt = (s: PropSchema | undefined) => (at.field === undefined ? s?.type : s && (s.type === 'list' || s.type === 'object') && Object.hasOwn(s.fields, at.field) ? s.fields[at.field].type : undefined);
  if (!schema || !prev || typeAt(prev) !== typeAt(schema)) return false;
  const v = was.props && Object.hasOwn(was.props, at.prop) ? was.props[at.prop] : prev.default;
  if (isBinding(v)) return false;
  // Empty already before the change, judged by the rule it now has.
  const head = `${d.owner.kind}|${d.owner.id}|${d.nodeId}|${at.prop}|`;
  return requiredValueProblems(schema, v, '').some((p) => head + p.key === d.site);
}

/** What one placement of a component with required properties leaves empty, in its own values or (with `bindings`) through a binding. */
function placementProblems(state: ProjectState, owner: OwnerRef, n: InstanceNode, label: string, bindings: boolean): RequiredProblem[] {
  const out: RequiredProblem[] = [];
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  if (!def || !n.props || typeof n.props !== 'object') return out;
  for (const [k, s] of Object.entries(def.properties ?? {})) {
    if (!s || typeof s !== 'object' || !hasRequired(s)) continue;
    // Without a value of its own, a placement shows the default.
    const v = Object.hasOwn(n.props, k) ? n.props[k] : s.default;
    const key = `${owner.kind}|${owner.id}|${n.id}|${k}`;
    if (isBinding(v)) {
      if (!bindings) continue;
      const from = bindingSource(state, owner, n, v);
      const gap = from ? requiredGap(from, s) : null;
      if (gap) out.push({ key, message: `${label}: ${def.name} → ${s.label} takes “${from!.label}”: ${gap}.`, owner, nodeId: n.id, bound: true });
      continue;
    }
    for (const p of requiredValueProblems(s, v, `${label}: ${def.name} → ${s.label}`)) out.push({ key: `${key}|${p.key}`, message: p.message, owner, nodeId: n.id });
  }
  return out;
}

/**
 * What a set of definitions leaves empty though required, as they are (a package's copies, say): their defaults, and
 * the values of the components their designs place. `state` holds the definitions those placements are of.
 */
export function definitionRequiredProblems(state: ProjectState, defs: ComponentDefinition[]): RequiredProblem[] {
  const out: RequiredProblem[] = [];
  // A placement shows its component as the set has it (a package's copy), else as the project does.
  state = { ...state, components: { ...state.components, ...Object.fromEntries(defs.map((d) => [d.id, d])) } };
  for (const def of defs) {
    if (hasRequiredProps(def)) out.push(...defaultProblems(def));
    for (const n of Object.values(def.tree?.nodes ?? {})) if (n?.kind === 'instance') out.push(...placementProblems(state, { kind: 'component', id: def.id }, n, def.name, false));
  }
  return out;
}
