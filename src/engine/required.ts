/**
 * Required properties across a whole project (see shared/required.ts): every definition's defaults, every placement's
 * own values and every binding into a placed component. The value normalizers refuse an edit that empties a required
 * value as it is made; this reads what is already stored, for load validation and for the edits that carry values
 * over without normalizing each one (a swap, a theme change, a package import).
 */
import type { ComponentDefinition, GraphNode, OwnerRef, ProjectState, PropSchema } from '@shared/types';
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

/** Where a value of `schema` is empty though required: the message, with `label` as its path; null when it is not. */
export function requiredValueProblem(schema: PropSchema, v: unknown, label: string): string | null {
  // A computed list's items are the site's pages, whatever is stored.
  if (schema.type === 'list' && schema.feed) return null;
  if (schema.required && isEmptyPropValue(schema, v)) return requiredMessage(schema, label);
  if (schema.type === 'list' && Array.isArray(v)) {
    for (const [i, item] of v.entries()) {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      for (const [k, f] of fieldsOf(schema)) {
        // A field an item leaves out shows the field's default.
        if (f.required && isEmptyPropValue(f, Object.hasOwn(row, k) ? row[k] : f.default)) return requiredMessage(f, `${label} → ${schema.itemLabel} ${i + 1} → ${f.label}`);
      }
    }
  }
  if (schema.type === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const defaults = schema.default && typeof schema.default === 'object' ? schema.default : {};
    for (const [k, f] of fieldsOf(schema)) {
      const fallback = Object.hasOwn(defaults, k) ? defaults[k] : f.default;
      if (f.required && isEmptyPropValue(f, Object.hasOwn(o, k) ? o[k] : fallback)) return requiredMessage(f, `${label} → ${f.label}`);
    }
  }
  return null;
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

/** Every required value the project leaves empty, or could leave empty through a binding. */
export function requiredProblems(state: ProjectState): RequiredProblem[] {
  const out: RequiredProblem[] = [];
  const defs = Object.values(state.components).filter((d): d is ComponentDefinition => !!d && typeof d === 'object' && !!d.properties && typeof d.properties === 'object' && Object.values(d.properties).some((s) => !!s && typeof s === 'object' && hasRequired(s)));
  for (const def of defs) {
    for (const [k, s] of Object.entries(def.properties)) {
      if (!s || typeof s !== 'object' || !hasRequired(s)) continue;
      const problem = requiredValueProblem(s, s.default, `${def.name} → ${s.label} (default)`);
      if (problem) out.push({ key: `default|${def.id}|${k}`, message: problem, owner: { kind: 'component', id: def.id } });
    }
  }
  if (!defs.length) return out;
  const required = new Set(defs.map((d) => d.id));
  for (const { owner, tree, label } of allTrees(state)) {
    for (const n of Object.values(tree.nodes ?? {})) {
      if (n?.kind !== 'instance' || !required.has(n.definitionId) || !n.props || typeof n.props !== 'object') continue;
      const def = state.components[n.definitionId];
      for (const [k, s] of Object.entries(def.properties)) {
        if (!s || typeof s !== 'object' || !hasRequired(s) || !Object.hasOwn(n.props, k)) continue;
        const v = n.props[k];
        const key = `${owner.kind}|${owner.id}|${n.id}|${k}`;
        if (isBinding(v)) {
          const from = bindingSource(state, owner, n, v);
          const gap = from ? requiredGap(from, s) : null;
          if (gap) out.push({ key, message: `${label}: ${def.name} → ${s.label} takes “${from!.label}”: ${gap}.`, owner, nodeId: n.id, bound: true });
          continue;
        }
        const problem = requiredValueProblem(s, v, `${label}: ${def.name} → ${s.label}`);
        if (problem) out.push({ key, message: problem, owner, nodeId: n.id });
      }
    }
  }
  return out;
}
