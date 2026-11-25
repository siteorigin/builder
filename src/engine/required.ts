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
 * Every required value the project leaves empty, or could leave empty through a binding. `bindings: false` leaves
 * bindings out, for a caller that checks them with the other binding problems (`bindingProblem`).
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

/** What one placement of a component with required properties leaves empty, in its own values or (with `bindings`) through a binding. */
function placementProblems(state: ProjectState, owner: OwnerRef, n: InstanceNode, label: string, bindings: boolean): RequiredProblem[] {
  const out: RequiredProblem[] = [];
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  if (!def || !n.props || typeof n.props !== 'object') return out;
  for (const [k, s] of Object.entries(def.properties ?? {})) {
    if (!s || typeof s !== 'object' || !hasRequired(s) || !Object.hasOwn(n.props, k)) continue;
    const v = n.props[k];
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
