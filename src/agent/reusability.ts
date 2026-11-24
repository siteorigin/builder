import type { ProjectState } from '@shared/types';
import { introducedDiagnostics, type Diagnostic } from '@engine/validate';
import { isReusabilityWarning } from '@engine/reusability';

/** How many reusability findings one tool result or nudge lists; the rest are counted. */
export const REUSABILITY_FEEDBACK_LIMIT = 8;

export interface ComponentWarning {
  code: string;
  definitionId: string;
  nodeId?: string;
  message: string;
}

/** Reusability warnings as a model can act on them: which component, which node, what to do. */
export function componentWarnings(diags: readonly Diagnostic[], limit = REUSABILITY_FEEDBACK_LIMIT): { componentWarnings?: ComponentWarning[]; omittedComponentWarnings?: number } {
  const found = diags.filter((d) => isReusabilityWarning(d) && d.owner?.kind === 'component');
  if (!found.length) return {};
  return {
    componentWarnings: found.slice(0, limit).map((d) => ({ code: d.code, definitionId: d.owner!.id, ...(d.nodeId ? { nodeId: d.nodeId } : {}), message: d.message })),
    ...(found.length > limit ? { omittedComponentWarnings: found.length - limit } : {})
  };
}

/** JSON with object keys in order, so two values that differ only in key order compare equal. */
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** The project components whose definition differs between two states, including ones added since the first. */
export function changedComponents(before: ProjectState, after: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const [id, def] of Object.entries(after.components)) {
    if (def.owner !== 'project' || def.kind !== 'managed') continue;
    const was = Object.hasOwn(before.components, id) ? before.components[id] : undefined;
    if (was !== def && sortedJson(was) !== sortedJson(def)) out.add(id);
  }
  return out;
}

/**
 * The reusability warnings `after` brings in on the components it changed: a change to one component, or to the site
 * styles, never reports another component the run left alone. `changed` may be given lazily.
 */
export function introducedReusability(before: readonly Diagnostic[], after: readonly Diagnostic[], changed: ReadonlySet<string> | (() => ReadonlySet<string>)): Diagnostic[] {
  const found = after.filter(isReusabilityWarning);
  // Most projects have none: nothing to compare, and no definitions to read.
  if (!found.length) return [];
  const fresh = introducedDiagnostics(before.filter(isReusabilityWarning), found);
  if (!fresh.length) return [];
  // Worked out only now, since it reads every project component.
  const ids = typeof changed === 'function' ? changed() : changed;
  return fresh.filter((d) => d.owner?.kind === 'component' && ids.has(d.owner.id));
}

/**
 * Sent once when a run finishes with components that every placement would show the same way. `definitionTools`: the run
 * edits a design with its definition tools (a small model), so the fixes are named as those tools make them.
 */
export function reusabilityNudge(warnings: readonly Diagnostic[], definitionTools = false): string {
  const { componentWarnings: listed = [], omittedComponentWarnings } = componentWarnings(warnings);
  const lines = listed.map((w) => `- ${w.message} (component ${w.definitionId}${w.nodeId ? `, node ${w.nodeId}` : ''})`);
  if (omittedComponentWarnings) lines.push(`- …and ${omittedComponentWarnings} more like these.`);
  return [
    'The components this request made or changed are not reusable yet: every placement of them would show the same fixed content or ignore Site styles.',
    ...lines,
    definitionTools
      ? 'Fix these before finishing. Give fixed words, pictures and links a property with manage_component_prop, with the current value as its default, and bind the node to it with bind_definition_field ({"$prop": name}, or {"$item": field} inside a list). Link colors and spacing to site styles with style_definition_element and {"token": id}. Expose repeated cards and pictures as parts with edit_definition_node and exposeAsPart. Leave something fixed only if every placement should show it. Then finish.'
      : 'Fix these before finishing. Give fixed words, pictures and links a property (component.setPropSchema, or a field of the list inside a list) with the current value as its default, and bind the node to it with node.setBinding ({"$prop": name}, or {"$item": field} inside a list). Link colors and spacing to site styles with node.setStyle and {"token": id}. Add repeated cards and pictures to the parts with component.setPart. Leave something fixed only if every placement should show it, and then rename its layer "Shared …" with node.rename. Then finish.'
  ].join('\n');
}
